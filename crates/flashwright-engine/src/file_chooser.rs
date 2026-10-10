//! Chooser interception and bounded serial adoption retain original utility-world nodes.

use super::element_resolution::same_document;
use super::handle_values::ResolvedNode;
use super::handles::HandleAllocation;
use super::locators::{check_exception, context_was_destroyed};
use super::page_state::ExecutionContext;
use super::*;
use std::collections::VecDeque;
use tokio::sync::OwnedSemaphorePermit;

pub(crate) const MAXIMUM_CHOOSERS: usize = 128;
const MAXIMUM_PAGE_CHOOSERS: usize = 16;
const METHOD: &str = "page.fileChooser";

pub(crate) struct FileChooserState {
    enabled: bool,
    generation: u64,
    cancellation: watch::Sender<bool>,
    queued: VecDeque<PendingChooser>,
    running: bool,
    active: bool,
}

impl Default for FileChooserState {
    fn default() -> Self {
        Self {
            enabled: false,
            generation: 0,
            cancellation: watch::channel(false).0,
            queued: VecDeque::new(),
            running: false,
            active: false,
        }
    }
}

impl FileChooserState {
    /// Replacing a listener generation cancels both active adoption and queued reservations.
    pub(crate) fn cancel(&mut self) {
        self.enabled = false;
        self.cancellation.send_replace(true);
        self.queued.clear();
    }

    fn change(&mut self, enabled: bool) {
        self.cancel();
        self.generation += 1;
        self.cancellation = watch::channel(false).0;
        self.enabled = enabled;
    }
}

struct PendingChooser {
    backend_node: u64,
    context: ExecutionContext,
    generation: u64,
    cancellation: watch::Receiver<bool>,
    handle_slot: OwnedSemaphorePermit,
    _event_slot: OwnedSemaphorePermit,
}

impl Engine {
    /// Host page gates serialize toggles before subsequent actions; acknowledgement owns readiness.
    pub(super) async fn set_file_chooser_subscription(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "page.fileChooser.subscribe";
        validate_keys(method, &parameters, &["page", "enabled"])?;
        let identifier = identifier(&parameters, "page", method)?;
        let enabled = parameters["enabled"]
            .as_bool()
            .ok_or_else(|| invalid(method, "enabled must be a boolean"))?;
        let page = self.page(identifier, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let _control = operation
            .wait(page.state.while_alive(method, async {
                Ok(page.state.file_chooser_control.lock().await)
            }))
            .await?;
        operation.check()?;
        {
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            if !state.published {
                return Err(closed(method));
            }
            let mut chooser = page.state.file_chooser.lock().unwrap();
            if chooser.enabled != enabled {
                chooser.change(enabled);
            }
        }
        let mut command = browser.connection.start_command(
            "Page.setInterceptFileChooserDialog",
            json!({"enabled": enabled}),
            Some(&page.session_identifier),
        )?;
        let result = operation
            .wait(page.state.while_alive(method, command.response()))
            .await;
        if let Err(mut error) = result {
            if !command.prevent_dispatch()
                && matches!(error.code, ErrorCode::Timeout | ErrorCode::Cancelled)
            {
                let recovered = timeout(Duration::from_millis(500), command.response()).await;
                if matches!(recovered, Ok(Ok(_))) {
                    return Err(error);
                }
            }
            if self
                .registry
                .lock()
                .unwrap()
                .pages
                .remove(identifier)
                .is_some()
            {
                self.finish_page(identifier, &page, closed(method), "close");
            }
            error.cleanup = Some(
                dispose(
                    browser.as_ref(),
                    ResourceKind::Page,
                    &page.target_identifier,
                )
                .await
                .into(),
            );
            return Err(error);
        }
        Ok(Value::Null)
    }

    /// Enrollment is synchronous in CDP event order; the event pump never awaits renderer adoption.
    pub(crate) fn file_chooser_event(
        self: &Arc<Self>,
        identifier: &str,
        page: &Page,
        parameters: &Value,
    ) -> Result<(), ErrorRecord> {
        let start_worker = {
            let state = page.state.state.lock().unwrap();
            if state.failure.is_some() || page.state.purpose != PagePurpose::Public {
                return Ok(());
            }
            let mut chooser = page.state.file_chooser.lock().unwrap();
            if !chooser.enabled {
                return Ok(());
            }
            let Some(frame) = parameters["frameId"].as_str() else {
                return Ok(());
            };
            let Some(backend_node) = parameters["backendNodeId"]
                .as_u64()
                .filter(|identifier| *identifier > 0)
            else {
                return Ok(());
            };
            if state.frames.get(frame).is_some_and(|frame| frame.remote) {
                return Err(ErrorRecord::new(
                    ErrorCode::UnsupportedFeature,
                    METHOD,
                    "out-of-process file choosers are not implemented",
                ));
            }
            let Some(context) = state.main_worlds.get(frame).cloned() else {
                return Ok(());
            };
            if chooser.queued.len() + usize::from(chooser.active) >= MAXIMUM_PAGE_CHOOSERS {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    METHOD,
                    "page exceeds 16 pending file choosers",
                ));
            }
            let event_slot = self
                .file_chooser_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| {
                    ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        METHOD,
                        "engine exceeds 128 pending file choosers",
                    )
                })?;
            let pending = PendingChooser {
                backend_node,
                context,
                generation: chooser.generation,
                cancellation: chooser.cancellation.subscribe(),
                handle_slot: self.reserve_handle(page, METHOD)?,
                _event_slot: event_slot,
            };
            chooser.queued.push_back(pending);
            let start = !chooser.running;
            chooser.running = true;
            start
        };
        if start_worker {
            let engine = self.clone();
            let page = page.clone();
            let identifier = identifier.to_owned();
            tokio::spawn(async move {
                engine.publish_file_choosers(&identifier, &page).await;
            });
        }
        Ok(())
    }

    async fn publish_file_choosers(&self, identifier: &str, page: &Page) {
        loop {
            let pending = {
                let mut chooser = page.state.file_chooser.lock().unwrap();
                match chooser.queued.pop_front() {
                    Some(pending) => {
                        chooser.active = true;
                        pending
                    }
                    None => {
                        chooser.running = false;
                        chooser.active = false;
                        return;
                    }
                }
            };
            let result = self.adopt_file_chooser(identifier, page, pending).await;
            if let Err(error) = result {
                let state = page.state.state.lock().unwrap();
                if state.failure.is_none()
                    && !matches!(
                        error.code,
                        ErrorCode::Cancelled | ErrorCode::TargetClosed | ErrorCode::Evaluation
                    )
                    && error.browser_error_code.is_none()
                    && !context_was_destroyed(&error)
                {
                    drop(state);
                    let mut chooser = page.state.file_chooser.lock().unwrap();
                    chooser.cancel();
                    chooser.running = false;
                    chooser.active = false;
                    drop(chooser);
                    self.event_failure(error);
                    return;
                }
            }
        }
    }

    /// The receipt's original main world must survive adoption and atomic handle publication.
    async fn adopt_file_chooser(
        &self,
        identifier: &str,
        page: &Page,
        pending: PendingChooser,
    ) -> Result<(), ErrorRecord> {
        let operation = Operation::new(METHOD.into(), None, pending.cancellation);
        operation.check()?;
        let context = self.context(&page.context_identifier, METHOD)?;
        let browser = self.browser(&context.browser_identifier, METHOD)?;
        let realm = self
            .locator_realm(
                page,
                &browser,
                &pending.context.frame_identifier,
                &operation,
                METHOD,
            )
            .await?;
        if !same_document(page, &realm, &pending.context) {
            return Ok(());
        }
        let allocation = HandleAllocation {
            engine: self,
            page_identifier: identifier,
            page,
            browser: &browser,
            context: realm.context.clone(),
            operation: &operation,
            method: METHOD,
            group: self.identifier("file-chooser-group"),
            uses_object_group: true,
        };
        let result = async {
            let mut command = browser.connection.start_raw_command("DOM.resolveNode", json!({"backendNodeId": pending.backend_node, "executionContextId": realm.context.identifier, "objectGroup": allocation.group}), Some(&page.session_identifier))?;
            let response = allocation.wait(&mut command, false).await?;
            let resolved: ResolvedNode = serde_json::from_str(response.get()).map_err(|error| invalid(METHOD, &error.to_string()))?;
            if resolved.object.subtype.as_deref() != Some("node") || resolved.object.object_id.is_none() { return Err(evaluation::context_destroyed()); }
            if !same_document(page, &realm, &pending.context) { return Err(evaluation::context_destroyed()); }
            let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({"objectId": resolved.object.object_id, "functionDeclaration": "function() { return !!this.multiple; }", "returnByValue": true}), Some(&page.session_identifier))?;
            let response = allocation.wait(&mut command, false).await?;
            check_exception(&response, METHOD)?;
            let multiple = response["result"]["value"].as_bool().ok_or_else(|| invalid(METHOD, "file input omitted its multiplicity"))?;
            let handle = allocation.retain_event(resolved.object, pending.handle_slot)?;
            Ok(json!({"page": identifier, "group": allocation.group, "handles": [handle], "multiple": multiple}))
        }.await;
        let result = allocation.finish(result).await?;
        let published = self.prepare_handle_publication(&result, Some(&pending.context), |value| {
            let chooser = page.state.file_chooser.lock().unwrap();
            if !chooser.enabled
                || chooser.generation != pending.generation
                || *chooser.cancellation.borrow()
            {
                return Err(ErrorRecord::new(
                    ErrorCode::Cancelled,
                    METHOD,
                    "file chooser listener generation was replaced",
                ));
            }
            operation.check()?;
            self.emit(identifier, "filechooser", value.clone());
            Ok(())
        });
        if published.is_err() {
            allocation.rollback().await;
        }
        published
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Semaphore;

    fn subscribed_page() -> Page {
        let page = Page {
            context_identifier: "absent-context".into(),
            target_identifier: "target".into(),
            session_identifier: "session".into(),
            state: Arc::new(PageState::default()),
        };
        page.state.state.lock().unwrap().main_worlds.insert(
            "frame".into(),
            ExecutionContext {
                session_identifier: "session".into(),
                identifier: 1,
                unique_identifier: "world".into(),
                frame_identifier: "frame".into(),
            },
        );
        page.state.file_chooser.lock().unwrap().change(true);
        page
    }

    #[tokio::test]
    async fn synchronous_enrollment_bounds_each_page_and_the_entire_engine() {
        let (outgoing, _messages) = mpsc::channel(128);
        let (fatal, _failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        let event = json!({"frameId":"frame", "backendNodeId":1});
        let pages: Vec<_> = (0..8).map(|_| subscribed_page()).collect();
        // No yield: event enrollment must apply bounds before its first asynchronous worker runs.
        for page in &pages {
            for _ in 0..16 {
                engine.file_chooser_event("page", page, &event).unwrap();
            }
            assert_eq!(
                engine
                    .file_chooser_event("page", page, &event)
                    .unwrap_err()
                    .code,
                ErrorCode::ResourceLimit
            );
            assert_eq!(page.state.handle_slots.available_permits(), 4096 - 16);
        }
        assert_eq!(engine.file_chooser_slots.available_permits(), 0);
        let extra = subscribed_page();
        assert_eq!(
            engine
                .file_chooser_event("page", &extra, &event)
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(extra.state.handle_slots.available_permits(), 4096);
        for page in &pages {
            page.state.file_chooser.lock().unwrap().cancel();
        }
        assert_eq!(engine.file_chooser_slots.available_permits(), 128);
        assert!(
            pages
                .iter()
                .all(|page| page.state.handle_slots.available_permits() == 4096)
        );
        tokio::task::yield_now().await;
        assert!(
            pages
                .iter()
                .all(|page| !page.state.file_chooser.lock().unwrap().running)
        );
    }

    #[test]
    fn generations_cancel_old_adoption_and_release_only_queued_reservations() {
        let mut chooser = FileChooserState::default();
        chooser.change(true);
        let event_slots = Arc::new(Semaphore::new(2));
        let handle_slots = Arc::new(Semaphore::new(2));
        for _ in 0..2 {
            chooser.queued.push_back(PendingChooser {
                backend_node: 1,
                context: ExecutionContext {
                    session_identifier: "session".into(),
                    identifier: 1,
                    unique_identifier: "original-world".into(),
                    frame_identifier: "frame".into(),
                },
                generation: chooser.generation,
                cancellation: chooser.cancellation.subscribe(),
                handle_slot: handle_slots.clone().try_acquire_owned().unwrap(),
                _event_slot: event_slots.clone().try_acquire_owned().unwrap(),
            });
        }
        let active = chooser.queued.pop_front().unwrap();
        chooser.change(true);
        assert!(*active.cancellation.borrow());
        assert!(!*chooser.cancellation.borrow());
        assert!(chooser.enabled);
        assert_ne!(active.generation, chooser.generation);
        assert_eq!(event_slots.available_permits(), 1);
        assert_eq!(handle_slots.available_permits(), 1);
        drop(active);
        assert_eq!(event_slots.available_permits(), 2);
        assert_eq!(handle_slots.available_permits(), 2);
        chooser.cancel();
        assert!(!chooser.enabled);
        assert!(*chooser.cancellation.borrow());
    }
}
