//! One public phase owns its whole frame batch, including cancellation and late worker cleanup.

use super::documents::{CaptureAllowance, CaptureOwner};
use super::*;
use crate::snapshots::{
    CaptureOptions, SnapshotFrame, SnapshotNode, SnapshotRealm, SnapshotUnavailable,
};

struct PhaseGuard<'owner> {
    owner: &'owner CaptureOwner,
    settled: bool,
}

impl PhaseGuard<'_> {
    fn finish(mut self, result: Result<(), SnapshotFailure>) {
        let error = match result {
            Ok(()) | Err(SnapshotFailure::Unavailable(_)) => None,
            Err(SnapshotFailure::Failed(error)) => Some(error),
        };
        self.settle(error);
    }

    fn settle(&mut self, error: Option<ErrorRecord>) {
        let mut state = self.owner.context.state.recording.lock().unwrap();
        if let Ok(recording) = state.get_mut(&self.owner.recording) {
            if let Some(error) = error {
                recording.fail(error);
            }
            if let Err(error) =
                recording.settle_phase(&self.owner.chunk, &self.owner.call, self.owner.phase)
            {
                recording.fail(error);
            }
        }
        self.settled = true;
    }
}

impl Drop for PhaseGuard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            self.settle(Some(ErrorRecord::new(
                ErrorCode::Cancelled,
                "tracing.snapshot",
                "original phase waiter was dropped",
            )));
        }
    }
}

struct FrameCapture {
    realm: SnapshotRealm,
    is_main_frame: bool,
    children: Vec<SnapshotFrame>,
}

/// Copy a bounded original frame tree before any browser work; no page lock crosses an await.
fn original_frames(page: &Page) -> Result<Vec<FrameCapture>, SnapshotFailure> {
    let state = page.state.state.lock().unwrap();
    if state.failure.is_some() {
        return Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::OriginalDocumentChanged,
        ));
    }
    if state.dialog_open {
        return Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::DialogOpen,
        ));
    }
    let main = state
        .main_frame
        .as_ref()
        .ok_or(SnapshotFailure::Unavailable(
            SnapshotUnavailable::NoExistingMainContext,
        ))?;
    if state.frames.len() > 128 {
        return Err(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            "tracing.snapshot",
            "snapshot page exceeds 128 frames",
        )
        .into());
    }
    let mut pending = std::collections::VecDeque::from([main.clone()]);
    let mut seen = HashSet::new();
    let mut captures = Vec::new();
    while let Some(identifier) = pending.pop_front() {
        if !seen.insert(identifier.clone()) {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                "tracing.snapshot",
                "snapshot frame tree contains a cycle",
            )
            .into());
        }
        let Some(frame) = state.frames.get(&identifier) else {
            continue;
        };
        if frame.remote {
            return Err(ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                "tracing.snapshot",
                "snapshot frame is out of process",
            )
            .into());
        }
        let Some(context) = state
            .main_worlds
            .get(&identifier)
            .filter(|context| state.context_is_alive(context))
        else {
            continue;
        };
        if frame.pending_navigation.is_some() {
            continue;
        }
        let mut children: Vec<_> = state
            .frames
            .values()
            .filter(|child| child.parent.as_deref() == Some(&identifier))
            .collect();
        children.sort_unstable_by(|left, right| left.identifier.cmp(&right.identifier));
        let mut mappings = Vec::new();
        for child in children {
            // Even an uninitialized remote child is outside the declared capture support.
            if child.remote {
                return Err(ErrorRecord::new(
                    ErrorCode::UnsupportedFeature,
                    "tracing.snapshot",
                    "snapshot frame is out of process",
                )
                .into());
            }
            let Some(context) = state
                .main_worlds
                .get(&child.identifier)
                .filter(|context| state.context_is_alive(context))
            else {
                continue;
            };
            if child.pending_navigation.is_some() {
                continue;
            }
            mappings.push(SnapshotFrame {
                identifier: child.identifier.clone(),
                loader: child.loader.clone(),
                main_context: context.clone(),
            });
            pending.push_back(child.identifier.clone());
        }
        captures.push(FrameCapture {
            realm: SnapshotRealm::original(context.clone(), frame.loader.clone()),
            is_main_frame: &identifier == main,
            children: mappings,
        });
    }
    Ok(captures)
}

impl Engine {
    /// Optional diagnostics can fail their recording, but cannot replace the public action outcome.
    pub(crate) async fn capture_snapshot_phase(
        &self,
        page_identifier: &str,
        page: &Page,
        phase: SnapshotPhase,
        target: Option<SnapshotNode>,
        operation: &Operation,
    ) {
        let Some(trace) = operation.trace_call() else {
            return;
        };
        let (Some(recording), Some(call)) = (&trace.recording, &trace.call) else {
            return;
        };
        if trace.context != page.context_identifier {
            return;
        }
        let Ok(context) = self.context(&trace.context, "tracing.snapshot") else {
            return;
        };
        if !context.state.recording_enabled.load(Ordering::Acquire) {
            return;
        }
        let owner = CaptureOwner {
            context,
            recording: recording.clone(),
            chunk: trace.generation.clone(),
            call: call.clone(),
            phase,
            page_identifier: page_identifier.into(),
            page: page.clone(),
        };
        {
            let mut state = owner.context.state.recording.lock().unwrap();
            let Ok(recording) = state.get_mut(&owner.recording) else {
                return;
            };
            match recording.admit_phase(&owner.chunk, &owner.call, phase) {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    recording.fail(error);
                    return;
                }
            }
        }
        let guard = PhaseGuard {
            owner: &owner,
            settled: false,
        };
        let (deadline, cancellation) = operation.snapshot_allowance();
        let allowance = CaptureAllowance {
            deadline,
            cancellation,
        };
        guard.finish(
            self.capture_snapshot_frames(&owner, target, &allowance)
                .await,
        );
    }

    async fn capture_snapshot_frames(
        &self,
        owner: &CaptureOwner,
        target: Option<SnapshotNode>,
        allowance: &CaptureAllowance,
    ) -> Result<(), SnapshotFailure> {
        for frame in original_frames(&owner.page)? {
            let result = self
                .capture_snapshot_frame(owner, frame, target.as_ref(), allowance)
                .await;
            match result {
                Ok(()) | Err(SnapshotFailure::Unavailable(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    async fn capture_snapshot_frame(
        &self,
        owner: &CaptureOwner,
        frame: FrameCapture,
        target: Option<&SnapshotNode>,
        allowance: &CaptureAllowance,
    ) -> Result<(), SnapshotFailure> {
        let frame_identifier = frame.realm.main_context.frame_identifier.clone();
        let document = self
            .snapshot_document(owner, frame.realm, allowance)
            .await?;
        let capture = self.identifier("capture");
        let prepared = document
            .capture(
                CaptureOptions {
                    token: capture.clone(),
                    call_identifier: owner.call.clone(),
                    target: target
                        .filter(|target| target.context.frame_identifier == frame_identifier)
                        .cloned(),
                    frames: frame.children,
                },
                allowance.deadline,
                allowance.cancellation.clone(),
            )
            .await?;
        let decision = {
            let mut state = owner.context.state.recording.lock().unwrap();
            state.get_mut(&owner.recording)?.accept_snapshot(
                &owner.chunk,
                SnapshotMetadata {
                    capture: capture.clone(),
                    call: owner.call.clone(),
                    phase: owner.phase,
                    page: owner.page_identifier.clone(),
                    frame: frame_identifier,
                    is_main_frame: frame.is_main_frame,
                    snapshot_number: prepared.captured.snapshot_number,
                    native_time: 0.0,
                    byte_length: prepared.captured.data.bytes.len(),
                },
                prepared,
            )?
        };
        let result = decision.commit().await;
        let mut state = owner.context.state.recording.lock().unwrap();
        state.get_mut(&owner.recording)?.snapshot_commit_finished(
            &owner.chunk,
            &capture,
            result,
        )?;
        Ok(())
    }
}

impl Engine {
    /// Listener/control admission stays synchronous; only page action work enters this boundary.
    pub(crate) async fn snapshot_before_operation(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) {
        if operation
            .trace_call()
            .and_then(|trace| trace.recording.as_ref())
            .is_none()
        {
            return;
        }
        if !matches!(
            method,
            "page.goto"
                | "page.reload"
                | "page.goBack"
                | "page.goForward"
                | "page.screenshot"
                | "locator.run"
                | "assertion.run"
                | "keyboard.press"
                | "keyboard.type"
                | "page.evaluate"
                | "frame.evaluate"
                | "handle.evaluate"
                | "page.evaluateHandle"
                | "frame.evaluateHandle"
                | "handle.evaluateHandle"
                | "frame.waitForSelector"
                | "frame.setInputFiles"
                | "elementHandle.setInputFiles"
                | "elementHandle.selectText"
                | "elementHandle.scrollIntoViewIfNeeded"
        ) {
            return;
        }
        let Some(identifier) = parameters["page"].as_str() else {
            return;
        };
        let Ok(page) = self.page(identifier, method) else {
            return;
        };
        self.capture_snapshot_phase(identifier, &page, SnapshotPhase::Before, None, operation)
            .await;
    }
}

impl Engine {
    pub(crate) async fn snapshot_after_operation(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "context.trace.snapshot.after";
        validate_keys(
            method,
            &parameters,
            &["context", "recording", "chunk", "call", "page"],
        )?;
        let context = identifier(&parameters, "context", method)?;
        let recording = identifier(&parameters, "recording", method)?;
        let chunk = identifier(&parameters, "chunk", method)?;
        let call = identifier(&parameters, "call", method)?;
        let page_identifier = identifier(&parameters, "page", method)?;
        for (value, name) in [
            (context, "context"),
            (recording, "recording"),
            (chunk, "chunk"),
            (call, "call"),
            (page_identifier, "page"),
        ] {
            bounded_identifier(value, name)?;
        }
        let Ok(page) = self.page(page_identifier, method) else {
            return Ok(Value::Null);
        };
        if page.context_identifier != context {
            return Err(invalid(
                method,
                "snapshot page belongs to a different context",
            ));
        }
        let (deadline, cancellation) = operation.snapshot_allowance();
        let diagnostic = Operation::new(method.into(), Some(deadline), cancellation)
            .with_trace_call(Some(flashwright_protocol::TraceCall {
                context: context.into(),
                generation: chunk.into(),
                recording: Some(recording.into()),
                call: Some(call.into()),
            }));
        self.capture_snapshot_phase(
            page_identifier,
            &page,
            SnapshotPhase::After,
            None,
            &diagnostic,
        )
        .await;
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page_state::{ExecutionContext, FrameState, PageState};

    fn owner() -> CaptureOwner {
        let context = Context {
            browser_identifier: "browser".into(),
            protocol_identifier: "native-context".into(),
            viewport: None,
            devices: devices::DeviceOptions::default(),
            settings: context_settings::ContextSettings::parse(&json!({})).unwrap(),
            state: Arc::new(context_state::ContextState::default()),
            published: true,
        };
        {
            let mut state = context.state.recording.lock().unwrap();
            state.start("recording").unwrap();
            let recording = state.get_mut("recording").unwrap();
            recording.start_chunk("chunk").unwrap();
            recording
                .admit_phase("chunk", "call", SnapshotPhase::Before)
                .unwrap();
        }
        CaptureOwner {
            context,
            recording: "recording".into(),
            chunk: "chunk".into(),
            call: "call".into(),
            phase: SnapshotPhase::Before,
            page_identifier: "page".into(),
            page: Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: Arc::new(PageState::default()),
            },
        }
    }

    #[test]
    fn cancelled_phase_settles_original_obligation_but_poisons_its_recording() {
        let owner = owner();
        let guard = PhaseGuard {
            owner: &owner,
            settled: false,
        };
        owner
            .context
            .state
            .recording
            .lock()
            .unwrap()
            .get_mut("recording")
            .unwrap()
            .seal_chunk("chunk")
            .unwrap();
        drop(guard);
        let mut state = owner.context.state.recording.lock().unwrap();
        let recording = state.get_mut("recording").unwrap();
        assert_eq!(
            recording.failure.as_ref().unwrap().code,
            ErrorCode::Cancelled
        );
        assert!(!recording.chunk.as_ref().unwrap().pending());
        assert!(recording.start_chunk("successor").is_err());
        assert_eq!(
            state.stop("recording").unwrap_err().code,
            ErrorCode::Cancelled
        );
        state.start("fresh-recording").unwrap();
    }

    #[test]
    fn unavailable_phase_settles_without_failing_or_retargeting_a_later_chunk() {
        let owner = owner();
        let guard = PhaseGuard {
            owner: &owner,
            settled: false,
        };
        owner
            .context
            .state
            .recording
            .lock()
            .unwrap()
            .get_mut("recording")
            .unwrap()
            .seal_chunk("chunk")
            .unwrap();
        guard.finish(Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::OriginalDocumentChanged,
        )));
        let mut state = owner.context.state.recording.lock().unwrap();
        let recording = state.get_mut("recording").unwrap();
        assert!(recording.failure.is_none());
        recording.start_chunk("successor").unwrap();
        assert!(
            !recording
                .admit_phase("chunk", "call", SnapshotPhase::After)
                .unwrap()
        );
        assert!(recording.chunk.as_ref().unwrap().calls.is_empty());
    }

    fn add_frame(page: &Page, identifier: &str, number: u64, parent: Option<&str>) {
        let mut state = page.state.state.lock().unwrap();
        let context = ExecutionContext {
            identifier: number,
            unique_identifier: format!("original-{identifier}"),
            frame_identifier: identifier.into(),
        };
        state.frames.insert(
            identifier.into(),
            FrameState {
                identifier: identifier.into(),
                parent: parent.map(str::to_owned),
                loader: format!("loader-{identifier}"),
                ..Default::default()
            },
        );
        state.main_worlds.insert(identifier.into(), context.clone());
        state.execution_contexts.insert(number, context);
        if parent.is_none() {
            state.main_frame = Some(identifier.into());
        }
    }

    #[test]
    fn frame_batch_retains_original_tree_and_omits_uninitialized_subtrees() {
        let owner = owner();
        add_frame(&owner.page, "main", 1, None);
        add_frame(&owner.page, "child", 2, Some("main"));
        add_frame(&owner.page, "grandchild", 3, Some("child"));
        let frames = original_frames(&owner.page).unwrap();
        assert_eq!(frames.len(), 3);
        assert!(frames[0].is_main_frame);
        assert_eq!(
            frames[0].children[0].main_context.unique_identifier,
            "original-child"
        );
        assert_eq!(frames[1].children[0].identifier, "grandchild");
        assert!(!frames[1].is_main_frame);
        owner
            .page
            .state
            .state
            .lock()
            .unwrap()
            .main_worlds
            .remove("child");
        let frames = original_frames(&owner.page).unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].children.is_empty());
    }

    #[test]
    fn remote_frames_fail_explicitly_even_without_a_main_world() {
        let owner = owner();
        add_frame(&owner.page, "main", 1, None);
        add_frame(&owner.page, "remote", 2, Some("main"));
        {
            let mut state = owner.page.state.state.lock().unwrap();
            state.frames.get_mut("remote").unwrap().remote = true;
            state.main_worlds.remove("remote");
        }
        assert!(
            matches!(original_frames(&owner.page), Err(SnapshotFailure::Failed(error)) if error.code == ErrorCode::UnsupportedFeature)
        );
    }
}
