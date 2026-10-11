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
            json!({ "response": loader.and_then(|loader| state.response_for_loader(loader)), "frames": state.frame_snapshot() }),
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

    pub(super) async fn wait_for_document(
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
                        && frame.document_navigation_sequence > before
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
                    if wait_until == "networkidle"
                        && state.frames.values().any(|frame| frame.remote)
                    {
                        return Err(ErrorRecord::new(
                            ErrorCode::UnsupportedFeature,
                            method,
                            "cross-process child-frame network idle is not implemented yet",
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
}

pub(super) fn load_state<'value>(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn page_with_committed_document() -> Page {
        let state = Arc::new(PageState::default());
        {
            let mut document = state.state.lock().unwrap();
            document.initialize_main_frame("main", "session");
            document.observe_in_session(
                "session",
                "Page.frameNavigated",
                &json!({"frame": {
                    "id": "main", "loaderId": "original", "url": "http://fixture/signup"
                }}),
            );
        }
        Page {
            context_identifier: "context".into(),
            target_identifier: "main".into(),
            session_identifier: "session".into(),
            state,
        }
    }

    fn observe(page: &Page, method: &str, parameters: Value) {
        let mut document = page.state.state.lock().unwrap();
        document.observe_in_session("session", method, &parameters);
        page.state.changed.send_replace(document.sequence);
    }

    #[tokio::test(start_paused = true)]
    async fn same_document_event_does_not_interrupt_pending_document_navigation() {
        let page = page_with_committed_document();
        let before = page.state.state.lock().unwrap().sequence;
        let (_cancellation, receiver) = tokio::sync::watch::channel(false);
        let operation = Operation::new(
            "page.goto".into(),
            Some(Instant::now() + Duration::from_secs(1)),
            receiver,
        );
        observe(
            &page,
            "Page.navigatedWithinDocument",
            json!({"frameId": "main", "url": "http://fixture/login"}),
        );
        let pending = Engine::wait_for_document(
            &page,
            "main",
            Some("requested"),
            before,
            "load",
            &operation,
            "page.goto",
        );
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(Duration::from_millis(1), &mut pending)
                .await
                .is_err(),
            "An outgoing same-document change must leave the requested document wait pending"
        );
        observe(
            &page,
            "Page.frameNavigated",
            json!({"frame": {"id": "main", "loaderId": "requested", "url": "http://fixture/login"}}),
        );
        observe(
            &page,
            "Page.lifecycleEvent",
            json!({"frameId": "main", "loaderId": "requested", "name": "load"}),
        );
        pending.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn different_document_still_interrupts_pending_document_navigation() {
        let page = page_with_committed_document();
        let before = page.state.state.lock().unwrap().sequence;
        let (_cancellation, receiver) = tokio::sync::watch::channel(false);
        let operation = Operation::new(
            "page.goto".into(),
            Some(Instant::now() + Duration::from_secs(1)),
            receiver,
        );
        observe(
            &page,
            "Page.frameNavigated",
            json!({"frame": {"id": "main", "loaderId": "different", "url": "http://fixture/other"}}),
        );
        let error = Engine::wait_for_document(
            &page,
            "main",
            Some("requested"),
            before,
            "load",
            &operation,
            "page.goto",
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Navigation);
        assert!(
            error
                .message
                .contains("navigation interrupted by http://fixture/other")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn same_document_navigation_still_completes_without_new_loader() {
        let page = page_with_committed_document();
        let before = page.state.state.lock().unwrap().sequence;
        let (_cancellation, receiver) = tokio::sync::watch::channel(false);
        let operation = Operation::new(
            "page.goto".into(),
            Some(Instant::now() + Duration::from_secs(1)),
            receiver,
        );
        observe(
            &page,
            "Page.navigatedWithinDocument",
            json!({"frameId": "main", "url": "http://fixture/signup#section"}),
        );
        Engine::wait_for_document(
            &page,
            "main",
            None,
            before,
            "commit",
            &operation,
            "page.goto",
        )
        .await
        .unwrap();
    }
}
