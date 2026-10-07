//! Navigation waits observe loader identity and lifecycle transitions without serializing the page.

use super::*;
use tokio::time::{Instant, sleep_until};

impl Engine {
    pub(crate) async fn navigate(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "page.goto";
        validate_keys(
            method,
            &parameters,
            &["page", "url", "waitUntil", "referer"],
        )?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let url = parameters["url"]
            .as_str()
            .ok_or_else(|| invalid(method, "url must be a string"))?;
        let wait_until = load_state(&parameters, "waitUntil", true, method)?;
        let (frame_identifier, before) = {
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            (
                state.main_frame.clone().ok_or_else(|| closed(method))?,
                state.sequence,
            )
        };
        let mut command = json!({ "url": url, "frameId": frame_identifier });
        if let Some(referer) = parameters.get("referer") {
            if !referer.is_string() {
                return Err(invalid(method, "referer must be a string"));
            }
            command["referrer"] = referer.clone();
        }
        let navigation =
            operation
                .wait(page.state.while_alive(
                    method,
                    browser.connection.call(
                        "Page.navigate",
                        command,
                        Some(&page.session_identifier),
                    ),
                ))
                .await?;
        if let Some(error) = navigation["errorText"].as_str() {
            return Err(ErrorRecord::new(
                ErrorCode::Navigation,
                method,
                format!("{error} at {url}"),
            ));
        }
        if navigation["isDownload"] == true {
            return Err(ErrorRecord::new(
                ErrorCode::Navigation,
                method,
                "navigation started a download",
            ));
        }
        let loader = navigation["loaderId"].as_str();
        Self::wait_for_document(
            &page,
            &frame_identifier,
            loader,
            before,
            wait_until,
            operation,
            method,
        )
        .await?;
        let state = page.state.state.lock().unwrap();
        Ok(
            json!({ "response": loader.and_then(|loader| state.response_by_loader.get(loader)), "frames": state.frame_snapshot() }),
        )
    }

    pub(crate) async fn wait_for_load_state(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "page.waitForLoadState";
        validate_keys(method, &parameters, &["page", "state"])?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let wait_until = load_state(&parameters, "state", false, method)?;
        let frame = page
            .state
            .state
            .lock()
            .unwrap()
            .main_frame
            .clone()
            .ok_or_else(|| closed(method))?;
        // No specific loader: this wait follows the currently committed document.
        Self::wait_for_document(&page, &frame, None, 0, wait_until, operation, method).await?;
        Ok(Value::Null)
    }

    async fn wait_for_document(
        page: &Page,
        frame_identifier: &str,
        loader: Option<&str>,
        before: u64,
        wait_until: &str,
        operation: &Operation,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        let mut changes = page.state.changed.subscribe();
        loop {
            let idle_deadline = {
                let mut state = page.state.state.lock().unwrap();
                state.record_idle();
                state.check(method)?;
                let frame = state
                    .frames
                    .get(frame_identifier)
                    .ok_or_else(|| closed(method))?;
                let lifecycle = if wait_until == "domcontentloaded" {
                    "DOMContentLoaded"
                } else {
                    wait_until
                };
                if loader.is_some_and(|loader| {
                    state
                        .completed_lifecycle
                        .get(loader)
                        .is_some_and(|states| states.contains(lifecycle))
                }) {
                    return Ok(());
                }
                let committed = if let Some(loader) = loader {
                    let previously_committed = state
                        .completed_lifecycle
                        .get(loader)
                        .is_some_and(|states| states.contains("commit"));
                    if !previously_committed
                        && frame.loader != loader
                        && frame.navigation_sequence > before
                    {
                        return Err(ErrorRecord::new(
                            ErrorCode::Navigation,
                            method,
                            format!("navigation interrupted by {}", frame.url),
                        ));
                    }
                    previously_committed || frame.loader == loader
                } else {
                    before == 0 || frame.navigation_sequence > before
                };
                if committed {
                    if wait_until == "commit" {
                        return Ok(());
                    }
                    if state.frames.values().any(|frame| frame.remote) {
                        return Err(ErrorRecord::new(
                            ErrorCode::UnsupportedFeature,
                            method,
                            "cross-process child-frame lifecycle is not implemented yet",
                        ));
                    }
                    if wait_until == "networkidle" {
                        if frame.lifecycle.contains("networkidle") {
                            return Ok(());
                        }
                        if let Some(idle_since) = state.idle_since {
                            let deadline = idle_since + Duration::from_millis(500);
                            if Instant::now() >= deadline {
                                return Ok(());
                            }
                            Some(deadline)
                        } else {
                            None
                        }
                    } else {
                        let lifecycle = if wait_until == "domcontentloaded" {
                            "DOMContentLoaded"
                        } else {
                            "load"
                        };
                        if state
                            .frames
                            .values()
                            .all(|frame| frame.lifecycle.contains(lifecycle))
                        {
                            return Ok(());
                        }
                        None
                    }
                } else {
                    None
                }
            };
            operation
                .wait(async {
                    let idle = async {
                        match idle_deadline {
                            Some(deadline) => sleep_until(deadline).await,
                            None => std::future::pending().await,
                        }
                    };
                    tokio::select! {
                        _ = idle => Ok(()),
                        changed = changes.changed() => changed.map_err(|_| closed(method)),
                    }
                })
                .await?;
        }
    }

    pub(crate) async fn response_body(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "response.body";
        validate_keys(method, &parameters, &["page", "request"])?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let request_identifier = identifier(&parameters, "request", method)?;
        let mut changes = page.state.changed.subscribe();
        loop {
            {
                let state = page.state.state.lock().unwrap();
                state.check(method)?;
                let request = state.requests.get(request_identifier).ok_or_else(|| {
                    ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        method,
                        "response is outside the bounded retained request history",
                    )
                })?;
                if let Some(error) = &request.failure {
                    return Err(ErrorRecord::new(ErrorCode::Navigation, method, error));
                }
                if request.finished {
                    break;
                }
            }
            operation
                .wait(async { changes.changed().await.map_err(|_| closed(method)) })
                .await?;
        }
        operation
            .wait(browser.connection.call(
                "Network.getResponseBody",
                json!({ "requestId": request_identifier }),
                Some(&page.session_identifier),
            ))
            .await
    }
}

fn load_state<'value>(
    parameters: &'value Value,
    field: &str,
    allow_commit: bool,
    method: &str,
) -> Result<&'value str, ErrorRecord> {
    let state = match parameters.get(field) {
        None => "load",
        Some(Value::String(value)) => value.as_str(),
        _ => {
            return Err(invalid(
                method,
                "navigation lifecycle state must be a string",
            ));
        }
    };
    if ["load", "domcontentloaded", "networkidle"].contains(&state)
        || (allow_commit && state == "commit")
    {
        Ok(state)
    } else {
        Err(invalid(method, "invalid navigation lifecycle state"))
    }
}
