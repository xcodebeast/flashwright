//! Navigation cursors are captured at command acceptance, before any later action can run.

use super::*;
use crate::navigation::load_state;
use crate::page_state::NavigationOutcome;

impl Engine {
    pub(super) fn capture_navigation(
        &self,
        parameters: &Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "page.navigation.capture";
        operation.check()?;
        validate_keys(method, parameters, &["page", "sequence"])?;
        let sequence = navigation_sequence(parameters, method)?;
        let page = self.page(identifier(parameters, "page", method)?, method)?;
        let state = page.state.state.lock().unwrap();
        state.check(method)?;
        let frame = state.main_frame.as_ref().ok_or_else(|| closed(method))?;
        if sequence > state.sequence {
            return Err(invalid(method, "navigation cursor is ahead of this page"));
        }
        if sequence < state.discarded_navigation_sequence {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "navigation events exceeded the bounded retained history",
            ));
        }
        Ok(json!({"frame":frame,"sequence":sequence}))
    }

    pub(super) async fn next_navigation(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "page.navigation.next";
        validate_keys(method, &parameters, &["page", "frame", "sequence"])?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let frame = identifier(&parameters, "frame", method)?;
        let sequence = navigation_sequence(&parameters, method)?;
        {
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            if state.main_frame.as_deref() != Some(frame) || sequence > state.sequence {
                return Err(invalid(
                    method,
                    "navigation cursor does not belong to this main frame",
                ));
            }
        }
        let event =
            Self::wait_for_history_navigation(&page, frame, sequence, false, operation, method)
                .await?;
        if let NavigationOutcome::Failed(error) = &event.outcome {
            return Err(ErrorRecord::new(ErrorCode::Navigation, method, error));
        }
        Ok(json!({"frame":event.frame_identifier,"sequence":event.sequence,"url":event.url}))
    }

    pub(super) async fn finish_navigation_wait(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "page.navigation.complete";
        validate_keys(
            method,
            &parameters,
            &["page", "frame", "sequence", "waitUntil"],
        )?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let frame = identifier(&parameters, "frame", method)?;
        let sequence = navigation_sequence(&parameters, method)?;
        let wait_until = load_state(&parameters, "waitUntil", true, method)?;
        let event = {
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            state
                .navigation_events
                .iter()
                .find(|event| event.sequence == sequence && event.frame_identifier == frame)
                .cloned()
                .ok_or_else(|| {
                    ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        method,
                        "selected navigation is outside the bounded retained history",
                    )
                })?
        };
        Self::complete_navigation(
            &page, frame, &event, sequence, wait_until, operation, method,
        )
        .await
    }
}

fn navigation_sequence(parameters: &Value, method: &str) -> Result<u64, ErrorRecord> {
    parameters["sequence"]
        .as_u64()
        .filter(|sequence| *sequence <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            invalid(
                method,
                "navigation sequence must be a nonnegative JavaScript-safe integer",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Engine, Arc<PageState>) {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Engine::new(None, outgoing, fatal, ResourceLimits::default());
        let state = Arc::new(PageState::default());
        state
            .state
            .lock()
            .unwrap()
            .initialize_main_frame("main", "");
        state.state.lock().unwrap().observe(
            "Page.frameNavigated",
            &json!({"frame":{"id":"main","url":"about:blank","loaderId":"initial"}}),
        );
        engine.registry.lock().unwrap().pages.insert(
            "page".into(),
            Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: state.clone(),
            },
        );
        (engine, state)
    }

    fn operation() -> Operation {
        let (_sender, receiver) = watch::channel(false);
        Operation::new("page.waitForNavigation".into(), None, receiver)
    }

    #[tokio::test]
    async fn capture_preserves_host_boundary_and_selected_event_url_after_later_navigation() {
        let (engine, state) = fixture();
        let sequence = state.state.lock().unwrap().sequence;
        state.state.lock().unwrap().observe(
            "Page.navigatedWithinDocument",
            &json!({"frameId":"main","url":"about:blank#first"}),
        );
        let cursor = engine
            .execute_control(
                "page.navigation.capture",
                &json!({"page":"page","sequence":sequence}),
                &operation(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(cursor["sequence"], sequence);
        state.state.lock().unwrap().observe(
            "Page.navigatedWithinDocument",
            &json!({"frameId":"main","url":"about:blank#second"}),
        );
        let event = engine
            .next_navigation(
                json!({"page":"page","frame":cursor["frame"],"sequence":cursor["sequence"]}),
                &operation(),
            )
            .await
            .unwrap();
        assert_eq!(event["url"], "about:blank#first");
        let result = engine.finish_navigation_wait(json!({"page":"page","frame":"main","sequence":event["sequence"],"waitUntil":"commit"}), &operation()).await.unwrap();
        assert_eq!(result["response"], Value::Null);
        assert_eq!(result["frames"][0]["url"], "about:blank#second");
    }

    #[test]
    fn private_navigation_delivery_precedes_public_navigation_and_failure_callbacks() {
        let (_, state) = fixture();
        let mut state = state.state.lock().unwrap();
        let events = state.observe(
            "Page.navigatedWithinDocument",
            &json!({"frameId":"main","url":"about:blank#next"}),
        );
        assert_eq!(events[0].0, "navigation");
        assert_eq!(events[0].1["sequence"], state.sequence);
        assert_eq!(events[1].0, "framenavigated");
        state.observe("Network.requestWillBeSent", &json!({"requestId":"failed","loaderId":"failed","frameId":"main","type":"Document","request":{"url":"http://fixture.invalid/failed","method":"GET"}}));
        let events = state.observe(
            "Network.loadingFailed",
            &json!({"requestId":"failed","errorText":"net::ERR_FAILED"}),
        );
        assert_eq!(events[0].0, "navigation");
        assert_eq!(events[0].1["kind"], "failed");
        assert_eq!(events[1].0, "requestfailed");
    }

    #[tokio::test]
    async fn evicted_cursor_and_selected_event_fail_instead_of_substituting_later_navigation() {
        let (engine, state) = fixture();
        let sequence = state.state.lock().unwrap().sequence;
        for _ in 0..1025 {
            state.state.lock().unwrap().observe(
                "Page.navigatedWithinDocument",
                &json!({"frameId":"main","url":"about:blank#later"}),
            );
        }
        let error = engine
            .capture_navigation(&json!({"page":"page","sequence":sequence}), &operation())
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        let error = engine
            .finish_navigation_wait(
                json!({"page":"page","frame":"main","sequence":sequence,"waitUntil":"commit"}),
                &operation(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
    }
}
