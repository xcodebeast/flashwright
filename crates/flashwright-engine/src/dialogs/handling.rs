//! A claimed modal keeps its original command and owner until acknowledgement or terminal cleanup.

use super::state::DialogOccurrence;
use crate::*;
use flashwright_browser::connection::Command;
use serde::Serialize;
use serde_json::value::RawValue;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HandlingParameters {
    accept: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_text: Option<Box<RawValue>>,
}

/// Driver acceptance prepares this object synchronously, before request tasks can reorder.
pub struct PreparedDialogHandling {
    engine: Arc<Engine>,
    page: Page,
    browser: Arc<Chromium>,
    occurrence: Arc<DialogOccurrence>,
    command: Result<Command, ErrorRecord>,
}

impl PreparedDialogHandling {
    pub(super) fn start(
        engine: &Arc<Engine>,
        page: Page,
        browser: Arc<Chromium>,
        occurrence: Arc<DialogOccurrence>,
        accept: bool,
        prompt_text: Option<Box<RawValue>>,
    ) -> Self {
        let command = browser.connection.start_typed_command(
            "Page.handleJavaScriptDialog",
            HandlingParameters {
                accept,
                prompt_text,
            },
            Some(&occurrence.session_identifier),
        );
        Self {
            engine: engine.clone(),
            page,
            browser,
            occurrence,
            command,
        }
    }

    /// Failure after a claim is terminal for this page; uncertain handling is never replayed.
    pub async fn finish(mut self, operation: &Operation) -> Result<Value, ErrorRecord> {
        let result = match &mut self.command {
            Ok(command) => operation.wait(command.response()).await,
            Err(error) => Err(error.clone()),
        };
        match result {
            Ok(_) => Ok(Value::Null),
            Err(mut error) => {
                if let Ok(command) = &self.command {
                    command.prevent_dispatch();
                }
                // Retire visibility first. The command and occurrence stay alive through disposal.
                let retired = self
                    .engine
                    .registry
                    .lock()
                    .unwrap()
                    .pages
                    .remove(&self.occurrence.page_identifier);
                if let Some(page) = retired {
                    self.engine.finish_page(
                        &self.occurrence.page_identifier,
                        &page,
                        error.clone(),
                        "close",
                    );
                }
                error.cleanup = Some(
                    dispose(
                        self.browser.as_ref(),
                        ResourceKind::Page,
                        &self.page.target_identifier,
                    )
                    .await
                    .into(),
                );
                Err(error)
            }
        }
    }
}

impl Engine {
    /// Validate and claim the original occurrence without acquiring evaluation or input locks.
    pub fn prepare_dialog_handling(
        self: &Arc<Self>,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Option<Result<PreparedDialogHandling, ErrorRecord>> {
        if !matches!(method, "dialog.accept" | "dialog.dismiss") {
            return None;
        }
        Some((|| {
            operation.check()?;
            validate_keys(
                method,
                parameters,
                if method == "dialog.accept" {
                    &["page", "dialog", "promptTextJson"]
                } else {
                    &["page", "dialog"]
                },
            )?;
            let prompt_text = parameters
                .get("promptTextJson")
                .map(|value| {
                    let raw = value
                        .as_str()
                        .ok_or_else(|| invalid(method, "promptTextJson must encode a string"))?;
                    let value: Box<RawValue> = serde_json::from_str(raw)
                        .map_err(|_| invalid(method, "promptTextJson must encode a string"))?;
                    if !value.get().starts_with('"') {
                        return Err(invalid(method, "promptTextJson must encode a string"));
                    }
                    Ok(value)
                })
                .transpose()?;
            let page = self.page(identifier(parameters, "page", method)?, method)?;
            let context = self.context(&page.context_identifier, method)?;
            let browser = self.browser(&context.browser_identifier, method)?;
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            let occurrence = page
                .state
                .dialogs
                .lock()
                .unwrap()
                .claim(identifier(parameters, "dialog", method)?, method)?;
            let prepared = PreparedDialogHandling::start(
                self,
                page.clone(),
                browser,
                occurrence,
                method == "dialog.accept",
                prompt_text,
            );
            drop(state);
            Ok(prepared)
        })())
    }
}
