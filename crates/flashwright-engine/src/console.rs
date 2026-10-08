//! Console events retain native arguments only for subscribed live owners.

use super::*;
use crate::handle_values::RemoteObject;
use crate::handles::{HandleOwner, release_object_references};
use std::collections::VecDeque;

#[derive(Default)]
pub(crate) struct ConsoleCleanup {
    pub identifiers: VecDeque<String>,
    pub pending: usize,
    pub running: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsoleApiEvent {
    execution_context_id: u64,
    args: Vec<RemoteObject>,
}

#[derive(Deserialize)]
struct LogEvent {
    entry: LogEntry,
}

#[derive(Deserialize)]
struct LogEntry {
    source: String,
    #[serde(default)]
    args: Vec<RemoteObject>,
}

impl Engine {
    /// Subscription state is applied in driver acceptance order before spawning later work.
    pub fn execute_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Option<Result<Value, ErrorRecord>> {
        if !matches!(
            method,
            "page.console.subscribe" | "context.console.subscribe"
        ) {
            return None;
        }
        Some((|| {
            operation.check()?;
            let owner = if method.starts_with("page.") {
                "page"
            } else {
                "context"
            };
            validate_keys(method, parameters, &[owner, "enabled"])?;
            let enabled = parameters["enabled"]
                .as_bool()
                .ok_or_else(|| invalid(method, "enabled must be a boolean"))?;
            let identifier = identifier(parameters, owner, method)?;
            if owner == "page" {
                let page = self.page(identifier, method)?;
                let mut state = page.state.state.lock().unwrap();
                state.check(method)?;
                state.console_enabled = enabled;
            } else {
                let context = self.context(identifier, method)?;
                context
                    .state
                    .console_enabled
                    .store(enabled, Ordering::Relaxed);
            }
            Ok(Value::Null)
        })())
    }

    pub(crate) fn console_event(
        self: &Arc<Self>,
        page_identifier: &str,
        page: &Page,
        method: &str,
        raw: &str,
    ) -> Result<(), ErrorRecord> {
        let Ok(context) = self.context(&page.context_identifier, "console") else {
            return Ok(());
        };
        let Ok(browser) = self.browser(&context.browser_identifier, "console") else {
            return Ok(());
        };
        if method == "Log.entryAdded" {
            let event: LogEvent = serde_json::from_str(raw).map_err(|error| {
                ErrorRecord::new(ErrorCode::Protocol, "console", error.to_string())
            })?;
            self.discard_console_objects(page, &browser, event.entry.args)?;
            let state = page.state.state.lock().unwrap();
            if event.entry.source != "worker"
                && state.published
                && state.failure.is_none()
                && (state.console_enabled || context.state.console_enabled.load(Ordering::Relaxed))
            {
                self.emit(
                    page_identifier,
                    "console",
                    json!({ "source": "log", "consoleJson": raw, "handles": [], "group": null }),
                );
            }
            return Ok(());
        }
        let event: ConsoleApiEvent = serde_json::from_str(raw)
            .map_err(|error| ErrorRecord::new(ErrorCode::Protocol, "console", error.to_string()))?;
        let execution_context = {
            let state = page.state.state.lock().unwrap();
            if state.published
                && state.failure.is_none()
                && (state.console_enabled || context.state.console_enabled.load(Ordering::Relaxed))
            {
                state
                    .main_worlds
                    .values()
                    .find(|context| context.identifier == event.execution_context_id)
                    .cloned()
            } else {
                None
            }
        };
        let Some(execution_context) = execution_context else {
            return self.discard_console_objects(page, &browser, event.args);
        };
        let group = self.identifier("console-group");
        let mut initializations = Vec::new();
        // An event that cannot be represented fails the stream; shutdown releases every
        // reference, including arguments not yet inserted in the public registry.
        for value in event.args {
            let reservation = self.reserve_handle(page, "console")?;
            initializations.push(self.retain_handle(
                page,
                HandleOwner {
                    context: &execution_context,
                    group: &group,
                    uses_object_group: false,
                    published: true,
                },
                value,
                reservation,
                "console",
            )?);
        }
        self.emit(page_identifier, "console", json!({ "source": "api", "consoleJson": raw, "handles": initializations, "group": group }));
        Ok(())
    }

    /// Unobserved events do not install evaluation helpers or retain public handles.
    fn discard_console_objects(
        self: &Arc<Self>,
        page: &Page,
        browser: &Arc<Chromium>,
        objects: Vec<RemoteObject>,
    ) -> Result<(), ErrorRecord> {
        let identifiers: Vec<_> = objects
            .into_iter()
            .filter_map(|object| object.object_id)
            .collect();
        self.release_console_objects(page, browser, identifiers)
    }

    /// Events already in transit can lose their last listener before Node receives them.
    pub(crate) fn discard_console_group(
        self: &Arc<Self>,
        parameters: &Value,
    ) -> Result<bool, ErrorRecord> {
        let page_identifier = identifier(parameters, "page", "handle.discard")?;
        let group = identifier(parameters, "group", "handle.discard")?;
        let Ok(page) = self.page(page_identifier, "handle.discard") else {
            return Ok(false);
        };
        let identifiers = {
            let mut handles = page.state.handles.lock().unwrap();
            if !handles
                .values()
                .any(|handle| handle.group == group && !handle.uses_object_group)
            {
                return Ok(false);
            }
            handles
                .extract_if(|_, handle| handle.group == group)
                .filter_map(|(_, handle)| handle.object_identifier)
                .collect()
        };
        if let Ok(context) = self.context(&page.context_identifier, "handle.discard")
            && let Ok(browser) = self.browser(&context.browser_identifier, "handle.discard")
        {
            self.release_console_objects(&page, &browser, identifiers)?;
        }
        Ok(true)
    }

    fn release_console_objects(
        self: &Arc<Self>,
        page: &Page,
        browser: &Arc<Chromium>,
        identifiers: Vec<String>,
    ) -> Result<(), ErrorRecord> {
        if identifiers.is_empty() {
            return Ok(());
        }
        {
            let mut cleanup = page.state.console_cleanup.lock().unwrap();
            if cleanup.pending + identifiers.len() > 4096 {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    "console.cleanup",
                    "page exceeds 4096 pending console object releases",
                ));
            }
            cleanup.pending += identifiers.len();
            cleanup.identifiers.extend(identifiers);
            if cleanup.running {
                return Ok(());
            }
            cleanup.running = true;
        }
        let engine = self.clone();
        let page = page.clone();
        let browser = browser.clone();
        tokio::spawn(async move {
            loop {
                let batch: Vec<_> = {
                    let mut cleanup = page.state.console_cleanup.lock().unwrap();
                    if cleanup.identifiers.is_empty() {
                        cleanup.running = false;
                        break;
                    }
                    let length = cleanup.identifiers.len().min(64);
                    cleanup.identifiers.drain(..length).collect()
                };
                // A long application task may delay release acknowledgements. Bound retained
                // IDs, without introducing an unrelated timeout for that application task.
                let result = page
                    .state
                    .while_alive(
                        "console.cleanup",
                        release_object_references(&browser, &page, &batch),
                    )
                    .await;
                page.state.console_cleanup.lock().unwrap().pending -= batch.len();
                if let Err(error) = result {
                    if page.state.state.lock().unwrap().failure.is_none() {
                        engine.event_failure(error);
                    }
                    let mut cleanup = page.state.console_cleanup.lock().unwrap();
                    cleanup.identifiers.clear();
                    cleanup.pending = 0;
                    cleanup.running = false;
                    break;
                }
            }
        });
        Ok(())
    }
}
