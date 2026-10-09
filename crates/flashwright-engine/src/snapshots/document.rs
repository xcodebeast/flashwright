use std::sync::{Arc, Mutex};

use flashwright_browser::Connection;
use flashwright_browser::connection::Command;
use flashwright_browser::snapshot_reply::{
    CapturedSnapshot, MAXIMUM_DATA_BYTES, MAXIMUM_WRAPPER_BYTES, SnapshotCache, SnapshotReply,
    SnapshotReplyAdmission,
};
use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Duration, Instant, sleep_until};

use crate::Page;
use crate::locators::{LOCATOR_WORLD_NAME, LocatorRealm};
use crate::page_state::{ExecutionContext, PagePurpose};

use super::budget::{
    AdmissionError, CacheGrant, CaptureReservation, DocumentReservation, PayloadReservation,
    SnapshotBudget,
};
use super::outcome::{SnapshotFailure, SnapshotUnavailable};
use crate::diagnostic_sessions::SessionLifetime;

const METHOD: &str = "tracing.snapshot";
const CAPTURE_BUDGET: Duration = Duration::from_secs(2);
const SOURCE: &str = include_str!("../../../../packages/resident-runtime/snapshot-runtime.js");

#[cfg(test)]
mod tests;

/// The main document is fixed before admission; the utility world may be selected lazily.
#[derive(Clone)]
pub(crate) struct SnapshotRealm {
    pub main_context: ExecutionContext,
    pub loader: String,
    context: Option<ExecutionContext>,
}

impl SnapshotRealm {
    pub(crate) fn original(main_context: ExecutionContext, loader: String) -> Self {
        Self {
            main_context,
            loader,
            context: None,
        }
    }
}

impl From<LocatorRealm> for SnapshotRealm {
    fn from(realm: LocatorRealm) -> Self {
        Self {
            main_context: realm.main_context,
            loader: realm.loader,
            context: Some(realm.context),
        }
    }
}

/// A node already retained by the operation; the worker never resolves its selector again.
#[derive(Clone)]
pub(crate) struct SnapshotNode {
    pub object_identifier: String,
    pub context: ExecutionContext,
}

pub(crate) struct SnapshotFrame {
    pub identifier: String,
    pub loader: String,
    pub main_context: ExecutionContext,
}

pub(crate) struct CaptureOptions {
    pub token: String,
    pub call_identifier: String,
    pub target: Option<SnapshotNode>,
    pub frames: Vec<SnapshotFrame>,
}

pub(crate) struct PreparedSnapshot {
    pub captured: Box<CapturedSnapshot>,
    pub captured_at: std::time::Instant,
    pub reservation: PayloadReservation,
    pub decision: SnapshotDecision,
}

/// Publication decides once. Dropping this handle requests discard without dropping the worker.
pub(crate) struct SnapshotDecision {
    sender: Option<oneshot::Sender<Decision>>,
}

struct Decision {
    commit: bool,
    response: oneshot::Sender<Result<(), SnapshotFailure>>,
}

struct CaptureRequest {
    options: CaptureOptions,
    deadline: Instant,
    cancellation: watch::Receiver<bool>,
    reservation: CaptureReservation,
    result: Option<oneshot::Sender<Result<PreparedSnapshot, SnapshotFailure>>>,
}

struct Shared {
    reservation: Mutex<Option<DocumentReservation>>,
    stopping: watch::Sender<bool>,
    finished: watch::Sender<bool>,
    failure: Mutex<Option<SnapshotFailure>>,
    session_lifetime: SessionLifetime,
}

pub(crate) struct SnapshotDocument {
    requests: mpsc::Sender<CaptureRequest>,
    shared: Arc<Shared>,
}

struct DocumentWorker {
    page: Page,
    realm: SnapshotRealm,
    connection: Connection,
    shared: Arc<Shared>,
    owner_group: String,
    attempt_group: Option<String>,
    factory: Option<String>,
    pending: Option<PendingCommand>,
    generation_grant: CacheGrant,
    committed: CacheGrant,
    tentative: Option<CacheGrant>,
    snapshot_number: u64,
    attempt_number: u64,
    session_destroyed: watch::Receiver<bool>,
}

enum PendingCommand {
    Value(Command),
    Snapshot(Command<SnapshotReply>),
}

fn failure(code: ErrorCode, message: &str) -> SnapshotFailure {
    SnapshotFailure::Failed(ErrorRecord::new(code, METHOD, message))
}

fn admission(error: AdmissionError) -> SnapshotFailure {
    failure(
        ErrorCode::ResourceLimit,
        &format!("snapshot admission failed: {error:?}"),
    )
}

fn context_changed() -> SnapshotFailure {
    SnapshotFailure::Unavailable(SnapshotUnavailable::OriginalDocumentChanged)
}

fn check_document(page: &Page, realm: &SnapshotRealm) -> Result<(), SnapshotFailure> {
    if page
        .state
        .diagnostic_session_destroyed
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err(context_changed());
    }
    let state = page.state.state.lock().unwrap();
    if state.failure.is_some() {
        return Err(context_changed());
    }
    let Some(main) = state.main_worlds.get(&realm.main_context.frame_identifier) else {
        return Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::NoExistingMainContext,
        ));
    };
    if main != &realm.main_context
        || !state.context_is_alive(&realm.main_context)
        || realm.context.as_ref().is_some_and(|context| {
            context.frame_identifier != realm.main_context.frame_identifier
                || !state.context_is_alive(context)
        })
    {
        return Err(context_changed());
    }
    let frame = state
        .frames
        .get(&realm.main_context.frame_identifier)
        .ok_or_else(context_changed)?;
    if frame.loader != realm.loader {
        return Err(context_changed());
    }
    if frame.remote {
        return Err(failure(
            ErrorCode::UnsupportedFeature,
            "snapshot frame is out of process",
        ));
    }
    if state.dialog_open {
        return Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::DialogOpen,
        ));
    }
    if frame.pending_navigation.is_some() {
        return Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::PendingNavigation,
        ));
    }
    Ok(())
}

fn cache(counters: &SnapshotCache) -> CacheGrant {
    CacheGrant {
        bytes: counters.bytes,
        nodes: counters.nodes,
        attributes: counters.attributes,
        sheets: counters.sheets,
    }
}

fn within(actual: CacheGrant, grant: CacheGrant) -> bool {
    actual.bytes <= grant.bytes
        && actual.nodes <= grant.nodes
        && actual.attributes <= grant.attributes
        && actual.sheets <= grant.sheets
}

async fn confirmed_session_destruction(destroyed: &mut watch::Receiver<bool>) {
    loop {
        if *destroyed.borrow() {
            return;
        }
        if destroyed.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

impl SnapshotDocument {
    /// The caller supplies an engine-unique owner identity and an already selected isolated realm.
    pub(crate) fn start(
        owner_identifier: &str,
        page: Page,
        realm: impl Into<SnapshotRealm>,
        connection: Connection,
        budget: &Arc<SnapshotBudget>,
        session_lifetime: SessionLifetime,
    ) -> Result<Self, SnapshotFailure> {
        let realm = realm.into();
        if realm.context.as_ref().is_some_and(|context| {
            context.unique_identifier == realm.main_context.unique_identifier
        }) {
            return Err(failure(
                ErrorCode::Protocol,
                "snapshot capture requires an isolated execution context",
            ));
        }
        if page.state.purpose != PagePurpose::Public {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "private pages cannot own snapshot capture",
            ));
        }
        if !session_lifetime.belongs_to(&page.target_identifier, &page.session_identifier) {
            return Err(failure(
                ErrorCode::Protocol,
                "snapshot lifetime belongs to another session",
            ));
        }
        if *session_lifetime.destruction().borrow() {
            return Err(failure(
                ErrorCode::TargetClosed,
                "snapshot session is already destroyed",
            ));
        }
        if owner_identifier.is_empty()
            || owner_identifier.len() > 128
            || !owner_identifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "invalid snapshot owner identity",
            ));
        }
        check_document(&page, &realm)?;
        let reservation = budget
            .reserve_document(
                &page.context_identifier,
                &page.session_identifier,
                &realm.main_context.unique_identifier,
            )
            .map_err(admission)?;
        let generation_grant = reservation.generation_grant();
        let shared = Arc::new(Shared {
            reservation: Mutex::new(Some(reservation)),
            stopping: watch::channel(false).0,
            finished: watch::channel(false).0,
            failure: Mutex::new(None),
            session_lifetime,
        });
        let (sender, receiver) = mpsc::channel(2);
        let session_destroyed = shared.session_lifetime.destruction();
        let worker = DocumentWorker {
            page,
            realm,
            connection,
            shared: shared.clone(),
            owner_group: format!("__flashwright_snapshot_{owner_identifier}"),
            attempt_group: None,
            factory: None,
            pending: None,
            generation_grant,
            committed: CacheGrant::default(),
            tentative: None,
            snapshot_number: 0,
            attempt_number: 0,
            session_destroyed,
        };
        tokio::spawn(worker.run(receiver));
        Ok(Self {
            requests: sender,
            shared,
        })
    }

    /// Queueing and factory installation consume this same, capped original-call allowance.
    pub(crate) async fn capture(
        &self,
        options: CaptureOptions,
        operation_deadline: Instant,
        cancellation: watch::Receiver<bool>,
    ) -> Result<PreparedSnapshot, SnapshotFailure> {
        options.validate()?;
        if *self.shared.stopping.borrow() {
            return Err(self
                .shared
                .failure
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| {
                    failure(ErrorCode::TargetClosed, "snapshot owner is stopping")
                }));
        }
        let deadline = operation_deadline.min(Instant::now() + CAPTURE_BUDGET);
        if *cancellation.borrow() {
            return Err(failure(
                ErrorCode::Cancelled,
                "snapshot call was cancelled before admission",
            ));
        }
        if Instant::now() >= deadline {
            return Err(failure(
                ErrorCode::Timeout,
                "snapshot allowance expired before admission",
            ));
        }
        let reservation = self
            .shared
            .reservation
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| failure(ErrorCode::TargetClosed, "snapshot owner is closed"))?
            .reserve_capture()
            .map_err(admission)?;
        let (sender, receiver) = oneshot::channel();
        let mut waiting_cancellation = cancellation.clone();
        self.requests
            .try_send(CaptureRequest {
                options,
                deadline,
                cancellation,
                reservation,
                result: Some(sender),
            })
            .map_err(|_| failure(ErrorCode::ResourceLimit, "snapshot worker is unavailable"))?;
        tokio::select! {
            biased;
            _ = waiting_cancellation.wait_for(|cancelled| *cancelled) => {
                Err(failure(ErrorCode::Cancelled, "snapshot call was cancelled while queued"))
            },
            _ = sleep_until(deadline) => {
                Err(failure(ErrorCode::Timeout, "snapshot diagnostic allowance expired while queued"))
            },
            result = receiver => result.map_err(|_| failure(ErrorCode::TargetClosed, "snapshot worker is closed"))?,
        }
    }

    pub(crate) fn close(&self) {
        self.shared.stopping.send_replace(true);
    }

    #[cfg(test)]
    pub(crate) fn failure(&self) -> Option<SnapshotFailure> {
        self.shared.failure.lock().unwrap().clone()
    }

    pub(crate) fn finished(&self) -> bool {
        *self.shared.finished.borrow()
    }

    pub(crate) fn accepting(&self) -> bool {
        !*self.shared.stopping.borrow()
    }

    /// This may outlive a foreground export deadline while cleanup remains quarantined.
    pub(crate) async fn wait_finished(&self) {
        let mut finished = self.shared.finished.subscribe();
        let _ = finished.wait_for(|finished| *finished).await;
    }
}

impl Drop for SnapshotDocument {
    fn drop(&mut self) {
        self.close();
    }
}

impl CaptureOptions {
    fn validate(&self) -> Result<(), SnapshotFailure> {
        let bounded = |value: &str| !value.is_empty() && value.len() <= 128 && value.is_ascii();
        if !bounded(&self.token)
            || !bounded(&self.call_identifier)
            || self.frames.len() > 128
            || self
                .frames
                .iter()
                .any(|frame| !bounded(&frame.identifier) || frame.loader.len() > 128)
        {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "invalid snapshot call metadata",
            ));
        }
        if self
            .target
            .iter()
            .any(|node| node.object_identifier.is_empty() || node.object_identifier.len() > 1024)
        {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "invalid retained snapshot node",
            ));
        }
        let node_bytes = |node: &SnapshotNode| {
            node.object_identifier.len()
                + node.context.unique_identifier.len()
                + node.context.frame_identifier.len()
        };
        let metadata_bytes = std::mem::size_of::<Self>()
            + self.token.len()
            + self.call_identifier.len()
            + self.target.as_ref().map(node_bytes).unwrap_or(0)
            + self
                .frames
                .iter()
                .map(|frame| {
                    std::mem::size_of::<SnapshotFrame>()
                        + frame.identifier.len()
                        + frame.loader.len()
                        + frame.main_context.unique_identifier.len()
                        + frame.main_context.frame_identifier.len()
                })
                .sum::<usize>();
        if metadata_bytes > MAXIMUM_WRAPPER_BYTES {
            return Err(failure(
                ErrorCode::ResourceLimit,
                "snapshot capture metadata exceeds 64 KiB",
            ));
        }
        Ok(())
    }
}

impl SnapshotDecision {
    pub(crate) async fn commit(mut self) -> Result<(), SnapshotFailure> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .take()
            .unwrap()
            .send(Decision {
                commit: true,
                response: sender,
            })
            .map_err(|_| failure(ErrorCode::TargetClosed, "snapshot transaction is closed"))?;
        receiver
            .await
            .map_err(|_| failure(ErrorCode::TargetClosed, "snapshot transaction is closed"))?
    }

    #[cfg(test)]
    pub(crate) async fn discard(mut self) -> Result<(), SnapshotFailure> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .take()
            .unwrap()
            .send(Decision {
                commit: false,
                response: sender,
            })
            .map_err(|_| failure(ErrorCode::TargetClosed, "snapshot transaction is closed"))?;
        receiver
            .await
            .map_err(|_| failure(ErrorCode::TargetClosed, "snapshot transaction is closed"))?
    }
}

impl DocumentWorker {
    fn stop_queued(&self, requests: &mut mpsc::Receiver<CaptureRequest>) {
        self.shared.stopping.send_replace(true);
        requests.close();
        while let Ok(mut queued) = requests.try_recv() {
            let error = self
                .shared
                .failure
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| failure(ErrorCode::TargetClosed, "snapshot owner is closed"));
            let _ = queued.result.take().unwrap().send(Err(error));
        }
    }

    async fn run(mut self, mut requests: mpsc::Receiver<CaptureRequest>) {
        let mut stopping = self.shared.stopping.subscribe();
        let mut changes = self.page.state.changed.subscribe();
        loop {
            if *stopping.borrow() {
                break;
            }
            if let Err(error) = self.check_document() {
                *self.shared.failure.lock().unwrap() = Some(error);
                break;
            }
            let mut request = tokio::select! {
                biased;
                _ = stopping.changed() => continue,
                _ = changes.changed() => continue,
                request = requests.recv() => match request {
                    Some(request) => request,
                    None => break,
                },
            };
            match self.prepare(&mut request).await {
                Ok((prepared, decision)) => {
                    let _ = request.result.take().unwrap().send(Ok(prepared));
                    if let Err(error) = self.decide(&mut request, decision).await {
                        *self.shared.failure.lock().unwrap() = Some(error);
                        self.stop_queued(&mut requests);
                        self.retire().await;
                        drop(request);
                        break;
                    }
                }
                Err(error) => {
                    *self.shared.failure.lock().unwrap() = Some(error.clone());
                    let _ = request.result.take().unwrap().send(Err(error));
                    self.stop_queued(&mut requests);
                    self.retire().await;
                    drop(request);
                    break;
                }
            }
        }
        self.stop_queued(&mut requests);
        self.retire().await;
        self.shared.reservation.lock().unwrap().take();
        self.shared.finished.send_replace(true);
    }

    fn check_frames(&self, options: &CaptureOptions) -> Result<(), SnapshotFailure> {
        let state = self.page.state.state.lock().unwrap();
        for mapping in &options.frames {
            let frame = state
                .frames
                .get(&mapping.identifier)
                .ok_or_else(context_changed)?;
            if frame.parent.as_deref() != Some(&self.realm.main_context.frame_identifier)
                || frame.loader != mapping.loader
                || mapping.main_context.frame_identifier != mapping.identifier
                || state.main_worlds.get(&mapping.identifier) != Some(&mapping.main_context)
                || !state.context_is_alive(&mapping.main_context)
            {
                return Err(context_changed());
            }
            if frame.pending_navigation.is_some() {
                return Err(SnapshotFailure::Unavailable(
                    SnapshotUnavailable::PendingNavigation,
                ));
            }
            if frame.remote {
                return Err(failure(
                    ErrorCode::UnsupportedFeature,
                    "snapshot frame is out of process",
                ));
            }
        }
        Ok(())
    }

    async fn prepare(
        &mut self,
        request: &mut CaptureRequest,
    ) -> Result<(PreparedSnapshot, oneshot::Receiver<Decision>), SnapshotFailure> {
        self.check_request(request)?;
        self.check_frames(&request.options)?;
        self.wait_for_evaluation(request).await?;
        self.attempt_number = self.attempt_number.checked_add(1).ok_or_else(|| {
            failure(
                ErrorCode::ResourceLimit,
                "snapshot attempt identity exhausted",
            )
        })?;
        self.attempt_group = Some(format!(
            "{}_attempt_{}",
            self.owner_group, self.attempt_number
        ));
        self.install(request).await?;
        let snapshot_number = self
            .snapshot_number
            .checked_add(1)
            .filter(|number| *number <= 9007199254740991)
            .ok_or_else(|| failure(ErrorCode::ResourceLimit, "snapshot sequence exhausted"))?;
        let mut arguments = vec![json!({"value": {
            "token": request.options.token,
            "snapshotNumber": snapshot_number,
            "callId": request.options.call_identifier,
            "frameIdentifiers": request.options.frames.iter().map(|frame| &frame.identifier).collect::<Vec<_>>(),
        }})];
        arguments.push(if let Some(target) = &request.options.target {
            json!({"objectId": self.adopt(request, target).await?})
        } else {
            json!({"value": null})
        });
        for frame in &request.options.frames {
            arguments.push(json!({"objectId": self.adopt_frame(request, frame).await?}));
        }
        self.check_frames(&request.options)?;
        let reply = self.snapshot_command(request, json!({
            "objectId": self.factory,
            "objectGroup": self.attempt_group,
            "returnByValue": true,
            "arguments": arguments,
            "functionDeclaration": "function(options, target, ...elements) { if (target && target.ownerDocument !== document) throw new Error('SnapshotTargetDocumentChanged'); const frames = []; for (let index = 0; index < elements.length; index++) { const element = elements[index]; if (element.ownerDocument !== document) throw new Error('SnapshotFrameDocumentChanged'); frames.push({element, frameId: options.frameIdentifiers[index]}); } return this.capture({token: options.token, snapshotNumber: options.snapshotNumber, callId: options.callId, target, frames}); }",
        })).await?;
        let captured_at = std::time::Instant::now();
        request.reservation.evaluation_finished();
        let captured = match reply {
            SnapshotReply::Captured(captured) => captured,
            SnapshotReply::Exception(exception) => {
                if exception.get().contains("SnapshotTargetDocumentChanged")
                    || exception.get().contains("SnapshotFrameDocumentChanged")
                {
                    return Err(context_changed());
                }
                let code = if exception.get().contains("SnapshotResourceLimit:") {
                    ErrorCode::ResourceLimit
                } else if exception.get().contains("SnapshotUnsupported:") {
                    ErrorCode::UnsupportedFeature
                } else {
                    ErrorCode::Evaluation
                };
                return Err(failure(code, "snapshot renderer rejected capture"));
            }
        };
        if captured.token != request.options.token
            || captured.snapshot_number != snapshot_number
            || cache(&captured.committed_cache) != self.committed
            || !within(cache(&captured.tentative_cache), self.generation_grant)
        {
            return Err(failure(
                ErrorCode::Protocol,
                "snapshot reply does not belong to its admitted transaction",
            ));
        }
        self.check_frames(&request.options)?;
        let group = self.attempt_group.clone().unwrap();
        self.value_command(
            request,
            "Runtime.releaseObjectGroup",
            json!({"objectGroup": group}),
        )
        .await?;
        self.attempt_group = None;
        let reservation = request
            .reservation
            .take_payload(captured.data.bytes.len() + MAXIMUM_WRAPPER_BYTES)
            .map_err(admission)?;
        self.tentative = Some(cache(&captured.tentative_cache));
        let (sender, receiver) = oneshot::channel();
        Ok((
            PreparedSnapshot {
                captured,
                captured_at,
                reservation,
                decision: SnapshotDecision {
                    sender: Some(sender),
                },
            },
            receiver,
        ))
    }

    async fn decide(
        &mut self,
        request: &mut CaptureRequest,
        decision: oneshot::Receiver<Decision>,
    ) -> Result<(), SnapshotFailure> {
        let decision = tokio::select! {
            biased;
            error = self.interrupted(request) => return Err(error),
            decision = decision => decision.ok(),
        };
        let commit = decision.as_ref().is_some_and(|decision| decision.commit);
        let snapshot_number = self.snapshot_number + 1;
        let declaration = if commit {
            "function(token, snapshotNumber) { return this.commit(token, snapshotNumber); }"
        } else {
            "function(token) { return this.discard(token); }"
        };
        self.attempt_group = Some(format!(
            "{}_decision_{}",
            self.owner_group, self.attempt_number
        ));
        let result = self
            .value_command(
                request,
                "Runtime.callFunctionOn",
                json!({
                    "objectId": self.factory,
                    "objectGroup": self.attempt_group,
                    "functionDeclaration": declaration,
                    "arguments": [{"value": request.options.token}, {"value": snapshot_number}],
                    "returnByValue": true,
                }),
            )
            .await;
        let result = match result {
            Ok(value) => {
                if commit {
                    match serde_json::from_value::<SnapshotCache>(
                        value["result"]["value"]["cache"].clone(),
                    ) {
                        Ok(stats)
                            if value["result"]["value"]["snapshotNumber"].as_u64()
                                == Some(snapshot_number)
                                && Some(cache(&stats)) == self.tentative =>
                        {
                            self.committed = cache(&stats);
                            self.snapshot_number = snapshot_number;
                            self.tentative = None;
                            Ok(())
                        }
                        _ => Err(failure(
                            ErrorCode::Protocol,
                            "snapshot commit acknowledgement is invalid",
                        )),
                    }
                } else if value["result"]["value"] == true {
                    self.tentative = None;
                    Ok(())
                } else {
                    Err(failure(
                        ErrorCode::Protocol,
                        "snapshot discard acknowledgement is invalid",
                    ))
                }
            }
            Err(error) => Err(error),
        };
        let result = match result {
            Ok(()) => {
                let group = self.attempt_group.clone().unwrap();
                let released = self
                    .value_command(
                        request,
                        "Runtime.releaseObjectGroup",
                        json!({"objectGroup": group}),
                    )
                    .await;
                if released.is_ok() {
                    self.attempt_group = None;
                }
                released.map(|_| ())
            }
            Err(error) => Err(error),
        };
        let result = result.and_then(|()| {
            request
                .reservation
                .transaction_finished()
                .map_err(admission)
        });
        if let Some(decision) = decision {
            let _ = decision.response.send(result.clone());
        }
        result
    }

    fn check_request(&self, request: &CaptureRequest) -> Result<(), SnapshotFailure> {
        if *self.shared.stopping.borrow() {
            return Err(failure(
                ErrorCode::TargetClosed,
                "snapshot owner is stopping",
            ));
        }
        if *request.cancellation.borrow() {
            return Err(failure(ErrorCode::Cancelled, "snapshot call was cancelled"));
        }
        if Instant::now() >= request.deadline {
            return Err(failure(
                ErrorCode::Timeout,
                "snapshot diagnostic allowance expired",
            ));
        }
        self.check_document()?;
        self.check_frames(&request.options)
    }

    async fn wait_for_evaluation(
        &self,
        request: &mut CaptureRequest,
    ) -> Result<(), SnapshotFailure> {
        let mut available = request.reservation.admission_changes();
        loop {
            self.check_request(request)?;
            match request.reservation.begin_evaluation() {
                Ok(()) => return Ok(()),
                Err(AdmissionError::DocumentBusy | AdmissionError::EvaluationLimit) => {}
                Err(error) => return Err(admission(error)),
            }
            tokio::select! {
                biased;
                error = self.interrupted(request) => return Err(error),
                result = available.changed() => {
                    if result.is_err() {
                        return Err(failure(ErrorCode::TargetClosed, "snapshot admission owner is closed"));
                    }
                },
            }
        }
    }

    fn check_document(&self) -> Result<(), SnapshotFailure> {
        check_document(&self.page, &self.realm)
    }

    async fn interrupted(&self, request: &CaptureRequest) -> SnapshotFailure {
        let mut changes = self.page.state.changed.subscribe();
        let mut stopping = self.shared.stopping.subscribe();
        let mut cancellation = request.cancellation.clone();
        loop {
            if *stopping.borrow() {
                return failure(ErrorCode::TargetClosed, "snapshot owner is stopping");
            }
            if *cancellation.borrow() {
                return failure(ErrorCode::Cancelled, "snapshot call was cancelled");
            }
            if let Err(error) = self.check_request(request) {
                return error;
            }
            if Instant::now() >= request.deadline {
                return failure(ErrorCode::Timeout, "snapshot diagnostic allowance expired");
            }
            tokio::select! {
                biased;
                _ = stopping.changed() => {},
                result = cancellation.changed() => {
                    if result.is_err() {
                        return failure(ErrorCode::Cancelled, "snapshot cancellation owner was dropped");
                    }
                },
                result = changes.changed() => {
                    if result.is_err() { return context_changed(); }
                },
                _ = sleep_until(request.deadline) => {},
            }
        }
    }

    async fn value_command(
        &mut self,
        request: &CaptureRequest,
        method: &str,
        parameters: Value,
    ) -> Result<Value, SnapshotFailure> {
        self.check_request(request)?;
        let mut command = self.connection.start_command(
            method,
            parameters,
            Some(&self.page.session_identifier),
        )?;
        let result = tokio::select! {
            biased;
            error = self.interrupted(request) => {
                if !command.prevent_dispatch() && command.try_response().is_none() {
                    self.pending = Some(PendingCommand::Value(command));
                }
                return Err(error);
            },
            result = command.response() => result,
        }?;
        self.check_request(request)?;
        if result.get("exceptionDetails").is_some() {
            return Err(failure(
                ErrorCode::Evaluation,
                "snapshot browser helper threw an exception",
            ));
        }
        Ok(result)
    }

    async fn snapshot_command(
        &mut self,
        request: &CaptureRequest,
        parameters: Value,
    ) -> Result<SnapshotReply, SnapshotFailure> {
        self.check_request(request)?;
        let mut command = self.connection.start_snapshot_capture(
            parameters,
            &self.page.session_identifier,
            SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES, MAXIMUM_WRAPPER_BYTES)?,
        )?;
        let result = tokio::select! {
            biased;
            error = self.interrupted(request) => {
                if !command.prevent_dispatch() && command.try_response().is_none() {
                    self.pending = Some(PendingCommand::Snapshot(command));
                }
                return Err(error);
            },
            result = command.response() => result,
        }?;
        self.check_request(request)?;
        Ok(result)
    }

    fn capture_context(&self) -> Result<&ExecutionContext, SnapshotFailure> {
        self.realm.context.as_ref().ok_or_else(|| {
            failure(
                ErrorCode::Protocol,
                "snapshot utility world is not selected",
            )
        })
    }

    fn node_context_is_alive(&self, context: &ExecutionContext) -> bool {
        context.frame_identifier == self.realm.main_context.frame_identifier
            && self
                .page
                .state
                .state
                .lock()
                .unwrap()
                .context_is_alive(context)
    }

    /// A fixed world name shares the locator realm without installing its resident runtime.
    async fn select_utility_world(
        &mut self,
        request: &CaptureRequest,
    ) -> Result<(), SnapshotFailure> {
        if self.realm.context.is_some() {
            return Ok(());
        }
        let result = self.value_command(request,"Page.createIsolatedWorld",json!({
                    "frameId":self.realm.main_context.frame_identifier,"worldName":LOCATOR_WORLD_NAME,
        })).await?;
        let identifier = result["executionContextId"].as_u64().ok_or_else(|| {
            failure(
                ErrorCode::Protocol,
                "snapshot utility world reply has no execution context",
            )
        })?;
        self.realm.context = Some(
            self.page
                .state
                .state
                .lock()
                .unwrap()
                .execution_contexts
                .get(&identifier)
                .filter(|context| {
                    context.frame_identifier == self.realm.main_context.frame_identifier
                        && context.unique_identifier != self.realm.main_context.unique_identifier
                })
                .cloned()
                .ok_or_else(context_changed)?,
        );
        self.check_document()
    }

    async fn install(&mut self, request: &CaptureRequest) -> Result<(), SnapshotFailure> {
        if self.factory.is_some() {
            return Ok(());
        }
        self.select_utility_world(request).await?;
        let grant = self.generation_grant;
        let configuration = json!({
            "maximumCacheBytes": grant.bytes,
            "maximumCacheNodes": grant.nodes,
            "maximumCacheAttributes": grant.attributes,
            "maximumCacheSheets": grant.sheets,
        });
        let expression =
            format!("(() => {{ {SOURCE}; return createSnapshotCapture({configuration}); }})()");
        let value = self
            .value_command(
                request,
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "uniqueContextId": self.capture_context()?.unique_identifier,
                    "objectGroup": self.owner_group,
                    "returnByValue": false,
                }),
            )
            .await?;
        self.factory = Some(
            value["result"]["objectId"]
                .as_str()
                .filter(|identifier| !identifier.is_empty() && identifier.len() <= 1024)
                .ok_or_else(|| {
                    failure(ErrorCode::Protocol, "snapshot factory identity is missing")
                })?
                .to_owned(),
        );
        Ok(())
    }

    async fn adopt(
        &mut self,
        request: &CaptureRequest,
        original: &SnapshotNode,
    ) -> Result<String, SnapshotFailure> {
        if !self.node_context_is_alive(&original.context) {
            return Err(context_changed());
        }
        let described = self
            .value_command(
                request,
                "DOM.describeNode",
                json!({
                    "objectId": original.object_identifier,
                }),
            )
            .await?;
        let backend = described["node"]["backendNodeId"].as_u64().ok_or_else(|| {
            failure(
                ErrorCode::Protocol,
                "retained snapshot node has no backend identity",
            )
        })?;
        if !self.node_context_is_alive(&original.context) {
            return Err(context_changed());
        }
        self.resolve_backend(request, backend, Some(&original.context))
            .await
    }

    /// Resolve the original child frame's owner, never a selector that might match a replacement.
    async fn adopt_frame(
        &mut self,
        request: &CaptureRequest,
        frame: &SnapshotFrame,
    ) -> Result<String, SnapshotFailure> {
        let owner = self
            .value_command(
                request,
                "DOM.getFrameOwner",
                json!({
                    "frameId": frame.identifier,
                }),
            )
            .await?;
        let backend = owner["backendNodeId"].as_u64().ok_or_else(|| {
            failure(
                ErrorCode::Protocol,
                "snapshot frame owner has no backend identity",
            )
        })?;
        self.resolve_backend(request, backend, None).await
    }

    async fn resolve_backend(
        &mut self,
        request: &CaptureRequest,
        backend: u64,
        source_context: Option<&ExecutionContext>,
    ) -> Result<String, SnapshotFailure> {
        let resolved = self
            .value_command(
                request,
                "DOM.resolveNode",
                json!({
                    "backendNodeId": backend,
                    "executionContextId": self.capture_context()?.identifier,
                    "objectGroup": self.attempt_group,
                }),
            )
            .await?;
        if source_context.is_some_and(|context| !self.node_context_is_alive(context)) {
            return Err(context_changed());
        }
        let identifier = resolved["object"]["objectId"]
            .as_str()
            .filter(|identifier| !identifier.is_empty() && identifier.len() <= 1024)
            .ok_or_else(|| {
                failure(
                    ErrorCode::Protocol,
                    "adopted snapshot node identity is missing",
                )
            })?
            .to_owned();
        let verified = self
            .value_command(
                request,
                "DOM.describeNode",
                json!({
                    "objectId": identifier,
                }),
            )
            .await?;
        if verified["node"]["backendNodeId"].as_u64() != Some(backend) {
            return Err(failure(
                ErrorCode::Protocol,
                "snapshot node changed during adoption",
            ));
        }
        if source_context.is_some_and(|context| !self.node_context_is_alive(context)) {
            return Err(context_changed());
        }
        Ok(identifier)
    }

    /// No cleanup helper may close a healthy page or browser to recover optional diagnostics.
    /// The destruction signal is supplied only by the session's actual native lifetime owner.
    async fn retire(&mut self) {
        if let Some(mut pending) = self.pending.take() {
            tokio::select! {
                biased;
                _ = confirmed_session_destruction(&mut self.session_destroyed) => {},
                _ = async {
                    match &mut pending {
                        PendingCommand::Value(command) => { let _ = command.response().await; },
                        PendingCommand::Snapshot(command) => { let _ = command.response().await; },
                    }
                } => {},
            }
        }
        if let Some(group) = self.attempt_group.take() {
            self.release_group_or_wait_for_session(&group).await;
        }
        if self.attempt_number != 0 {
            self.release_group_or_wait_for_session(&self.owner_group.clone())
                .await;
            self.attempt_number = 0;
        }
        self.factory = None;
    }

    async fn release_group_or_wait_for_session(&mut self, group: &str) {
        if *self.session_destroyed.borrow() {
            return;
        }
        if let Ok(mut command) = self.connection.start_command(
            "Runtime.releaseObjectGroup",
            json!({"objectGroup": group}),
            Some(&self.page.session_identifier),
        ) {
            tokio::select! {
                biased;
                _ = confirmed_session_destruction(&mut self.session_destroyed) => return,
                result = command.response() => if result.is_ok() { return; },
            }
        }
        confirmed_session_destruction(&mut self.session_destroyed).await;
    }
}
