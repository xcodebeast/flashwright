//! Resource publication follows successful reply validation and encoding.

use super::*;

impl Engine {
    /// Serialize owner-backed values under their original publication lock and
    /// transfer that owner's allocation credit to the encoded terminal frame.
    pub fn prepare_operation_publication<Prepared>(
        &self,
        method: &str,
        result: &mut OperationResult,
        prepare: impl FnOnce(
            &Value,
            Option<Arc<dyn std::fmt::Debug + Send + Sync>>,
        ) -> Result<Prepared, ErrorRecord>,
    ) -> Result<Prepared, ErrorRecord> {
        match result {
            OperationResult::RetainedValue(value) => {
                value.prepare(|value, custody| prepare(value, Some(custody)))
            }
            OperationResult::RetainedDiagnostics(value) => {
                value.prepare(|value, custody| prepare(value, Some(custody)))
            }
            OperationResult::Value(value)
                if matches!(method, "apiRequest.newContext" | "apiRequest.fetch") =>
            {
                self.api_requests
                    .prepare_publication(method, value, |value, custody| {
                        prepare(value, Some(custody))
                    })
            }
            OperationResult::Value(value) => {
                self.prepare_publication(method, value, |value| prepare(value, None))
            }
            OperationResult::Binary(_) => Err(ErrorRecord::new(
                ErrorCode::Protocol,
                method,
                "binary output cannot be published as a JSON value",
            )),
        }
    }

    /// Capture current initial page state and publish only if preparing its reply succeeds.
    /// Holding the state lock closes the gap between the initial snapshot and live events.
    pub fn prepare_publication<Prepared>(
        &self,
        method: &str,
        result: &mut Value,
        prepare: impl FnOnce(&Value) -> Result<Prepared, ErrorRecord>,
    ) -> Result<Prepared, ErrorRecord> {
        if matches!(method, "page.addInitScript" | "context.addInitScript") {
            let registry = self.registry.lock().unwrap();
            if !result["identifier"]
                .as_str()
                .is_some_and(|identifier| registry.init_scripts.contains_key(identifier))
            {
                return Err(closed(method));
            }
            return prepare(result);
        }
        if matches!(
            method,
            "page.evaluateHandle"
                | "frame.evaluateHandle"
                | "handle.evaluateHandle"
                | "handle.getProperty"
                | "handle.getProperties"
                | "frame.waitForSelector"
                | "frame.waitForFunction"
        ) {
            return self.prepare_handle_publication(result, None, prepare);
        }
        if !matches!(
            method,
            "browser.launch" | "browser.newContext" | "context.newPage"
        ) {
            return prepare(result);
        }
        let identifier = result["identifier"]
            .as_str()
            .expect("successful allocations contain an owned identifier")
            .to_owned();
        let mut registry = self.registry.lock().unwrap();
        match method {
            "browser.launch" => {
                let browser = registry
                    .browsers
                    .get_mut(&identifier)
                    .ok_or_else(|| closed(method))?;
                let prepared = prepare(result)?;
                browser.published = true;
                Ok(prepared)
            }
            "browser.newContext" => {
                let context = registry
                    .contexts
                    .get_mut(&identifier)
                    .ok_or_else(|| closed(method))?;
                let lifetime = context.state.closed.borrow();
                if let Some(error) = lifetime.as_ref() {
                    return Err(error.clone());
                }
                let prepared = prepare(result)?;
                context.published = true;
                Ok(prepared)
            }
            "context.newPage" => {
                let page = registry
                    .pages
                    .get(&identifier)
                    .ok_or_else(|| closed(method))?;
                let context = registry
                    .contexts
                    .get(&page.context_identifier)
                    .ok_or_else(|| closed(method))?;
                let lifetime = context.state.closed.borrow();
                let mut state = page.state.state.lock().unwrap();
                if let Some(error) = &state.failure {
                    return Err(error.clone());
                }
                if let Some(error) = lifetime.as_ref() {
                    return Err(error.clone());
                }
                let sessions = page.state.renderer_sessions.lock().unwrap();
                let root = sessions
                    .get(&page.session_identifier)
                    .ok_or_else(|| closed(method))?;
                if !root.is_ready()
                    || root.is_destroyed()
                    || root.target_identifier != page.target_identifier
                    || root.parent_session_identifier().is_some()
                {
                    return Err(closed(method));
                }
                *result = json!({ "identifier": identifier, "frames": state.frame_snapshot(), "mainFrame": state.main_frame, "initialEvents": state.initial_events, "navigationSequence": state.sequence });
                let prepared = prepare(result)?;
                state.initial_events.clear();
                state.published = true;
                if let Some(context) = registry.contexts.get(&page.context_identifier) {
                    if let Some(capture) = context.state.filmstrip.lock().unwrap().as_ref() {
                        capture.publish(&identifier);
                    }
                    context
                        .state
                        .trace_diagnostics
                        .lock()
                        .unwrap()
                        .publish_page(&identifier);
                }
                Ok(prepared)
            }
            _ => unreachable!(),
        }
    }

    /// Withdraw a successful allocation whose reply cannot be published to the caller.
    /// Cleanup has its own bounded acknowledgement policy and must not replay the operation.
    pub async fn discard_unreturned_allocation(
        &self,
        method: &str,
        result: &Value,
    ) -> Option<&'static str> {
        if method == "apiRequest.newContext" {
            return result["identifier"].as_str().map(|identifier| {
                self.api_requests.dispose_context(identifier);
                "resourceDisposed"
            });
        }
        if method == "apiRequest.fetch" {
            return result["context"]
                .as_str()
                .zip(result["identifier"].as_str())
                .map(|(context, response)| {
                    self.api_requests.dispose_response(context, response);
                    "resourceDisposed"
                });
        }
        if matches!(method, "page.addInitScript" | "context.addInitScript") {
            return self.discard_init_script(result).await;
        }
        if matches!(
            method,
            "page.evaluateHandle"
                | "frame.evaluateHandle"
                | "handle.evaluateHandle"
                | "handle.getProperty"
                | "handle.getProperties"
                | "frame.waitForSelector"
                | "frame.waitForFunction"
        ) {
            return self.discard_handle_allocation(result).await;
        }
        if !matches!(
            method,
            "browser.launch" | "browser.newContext" | "context.newPage"
        ) {
            return None;
        }
        let identifier = result["identifier"]
            .as_str()
            .expect("successful allocations contain an owned identifier");
        let cleanup = match method {
            "browser.launch" => {
                if let Some(browser) = self.remove_browser(identifier) {
                    operation::close_for_cleanup(browser.as_ref(), "resourceDisposed").await
                } else {
                    "ownerAlreadyClosing"
                }
            }
            "browser.newContext" => {
                let browser = self
                    .context(identifier, method)
                    .ok()
                    .and_then(|context| self.browser(&context.browser_identifier, method).ok());
                match (self.remove_context(identifier), browser) {
                    (Some(context), Some(browser)) => {
                        let cleanup = dispose(
                            browser.as_ref(),
                            ResourceKind::Context,
                            &context.protocol_identifier,
                        )
                        .await;
                        if let Some(downloads) = context.state.downloads.get()
                            && downloads.remove_files().await.is_err()
                        {
                            return Some(
                                operation::close_for_cleanup(
                                    browser.as_ref(),
                                    "browserClosedAfterDownloadCleanupFailure",
                                )
                                .await,
                            );
                        }
                        cleanup
                    }
                    _ => "ownerAlreadyClosing",
                }
            }
            "context.newPage" => {
                let (page, browser) = {
                    let mut registry = self.registry.lock().unwrap();
                    let page = registry.pages.remove(identifier);
                    let browser = page
                        .as_ref()
                        .and_then(|page| registry.contexts.get(&page.context_identifier))
                        .and_then(|context| registry.browsers.get(&context.browser_identifier))
                        .map(|entry| entry.browser.clone());
                    (page, browser)
                };
                if let Some(page) = page {
                    page.state.state.lock().unwrap().published = false;
                    self.finish_page(identifier, &page, closed("page"), "close");
                    if let Some(browser) = browser {
                        let cleanup = dispose(
                            browser.as_ref(),
                            ResourceKind::Page,
                            &page.target_identifier,
                        )
                        .await;
                        if let Ok(context) = self.context(&page.context_identifier, method)
                            && let Some(downloads) = context.state.downloads.get()
                            && downloads
                                .discard_page(&browser, &context.protocol_identifier, identifier)
                                .await
                                .is_err()
                        {
                            return Some("browserContinuingUnpublishedDownloadCleanup");
                        }
                        cleanup
                    } else {
                        "ownerAlreadyClosing"
                    }
                } else {
                    "ownerAlreadyClosing"
                }
            }
            _ => unreachable!(),
        };
        Some(cleanup)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flashwright_protocol::DriverMessage;

    fn engine() -> (Engine, mpsc::Receiver<DriverOutput>) {
        let (outgoing, messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        (
            Engine::new(None, outgoing, fatal, ResourceLimits::default()),
            messages,
        )
    }

    fn insert_context(engine: &Engine) -> Arc<context_state::ContextState> {
        let state = Arc::new(context_state::ContextState::default());
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: crate::devices::DeviceOptions::default(),
                settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
                state: state.clone(),
                published: false,
            },
        );
        state
    }

    fn insert_page(engine: &Engine) -> Arc<PageState> {
        insert_context(engine);
        let state = Arc::new(PageState::default());
        state
            .renderer_sessions
            .lock()
            .unwrap()
            .register_root("target", "session")
            .unwrap()
            .mark_ready();
        engine.registry.lock().unwrap().pages.insert(
            "page".into(),
            Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: state.clone(),
            },
        );
        state
    }

    #[test]
    fn preparation_refreshes_initial_page_state_and_does_not_publish_a_rejected_reply() {
        let (engine, mut messages) = engine();
        let state = insert_page(&engine);
        state
            .state
            .lock()
            .unwrap()
            .initialize_main_frame("current", "");
        state.state.lock().unwrap().observe(
            "Page.frameNavigated",
            &json!({ "frame": { "id": "current", "url": "about:blank", "loaderId": "loader" } }),
        );
        let page = engine.page("page", "test").unwrap();
        engine.page_diagnostic("page", &page, "pageerror", json!({ "message": "initial" }));
        let mut result = json!({ "identifier": "page", "mainFrame": "stale", "frames": [] });
        let rejected = engine.prepare_publication("context.newPage", &mut result, |value| {
            assert_eq!(value["mainFrame"], "current");
            assert_eq!(value["frames"].as_array().unwrap().len(), 1);
            assert_eq!(
                value["initialEvents"][0]["parameters"]["message"],
                "initial"
            );
            Err::<(), _>(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "protocol.output",
                "too large",
            ))
        });
        assert_eq!(rejected.unwrap_err().code, ErrorCode::ResourceLimit);
        assert!(!state.state.lock().unwrap().published);
        let page = engine.page("page", "test").unwrap();
        engine.finish_page("page", &page, closed("page"), "close");
        assert!(messages.try_recv().is_err());
    }

    #[test]
    fn successful_page_publication_enables_future_lifecycle_events() {
        let (engine, mut messages) = engine();
        let state = insert_page(&engine);
        let page = engine.page("page", "test").unwrap();
        engine.page_diagnostic("page", &page, "console", json!({ "sequence": 1 }));
        engine.page_diagnostic("page", &page, "pageerror", json!({ "sequence": 2 }));
        assert!(messages.try_recv().is_err());
        let mut result = json!({ "identifier": "page" });
        engine
            .prepare_publication("context.newPage", &mut result, |value| {
                assert_eq!(value["initialEvents"][0]["event"], "console");
                assert_eq!(value["initialEvents"][1]["event"], "pageerror");
                Ok(())
            })
            .unwrap();
        assert!(state.state.lock().unwrap().published);
        assert!(state.state.lock().unwrap().initial_events.is_empty());
        let page = engine.page("page", "test").unwrap();
        engine.finish_page("page", &page, closed("page"), "close");
        assert!(
            matches!(messages.try_recv().unwrap(), DriverOutput::Message(DriverMessage::Event { event, .. }) if event == "close")
        );
    }

    #[test]
    fn unpublished_contexts_close_privately_and_disappeared_allocations_cannot_publish() {
        let (engine, mut messages) = engine();
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: crate::devices::DeviceOptions::default(),
                settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
                state: Arc::new(context_state::ContextState::default()),
                published: false,
            },
        );
        engine.remove_context("context").unwrap();
        assert!(messages.try_recv().is_err());
        let mut result = json!({ "identifier": "context" });
        let error = engine
            .prepare_publication(
                "browser.newContext",
                &mut result,
                |_| -> Result<(), ErrorRecord> {
                    panic!("an already closed allocation must not be encoded as a success")
                },
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::TargetClosed);
    }

    #[test]
    fn retained_closing_context_cannot_publish_itself_or_a_page() {
        for method in ["browser.newContext", "context.newPage"] {
            let (engine, mut messages) = engine();
            let page_state = insert_page(&engine);
            let context = engine.context("context", "test").unwrap();
            context.state.closed.send_replace(Some(closed("context")));
            let mut result = json!({"identifier": if method == "browser.newContext" { "context" } else { "page" }});
            let error = engine
                .prepare_publication(method, &mut result, |_| -> Result<(), ErrorRecord> {
                    panic!("retained cleanup ownership cannot publish a successful allocation");
                })
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::TargetClosed);
            assert!(!engine.registry.lock().unwrap().contexts["context"].published);
            assert!(!page_state.state.lock().unwrap().published);
            assert!(messages.try_recv().is_err());
        }
    }

    #[test]
    fn root_detachment_between_creation_and_reply_prevents_page_publication() {
        let (engine, mut messages) = engine();
        let state = insert_page(&engine);
        let page = engine.page("page", "test").unwrap();
        engine.detach_renderer(&page, "session");
        assert!(state.state.lock().unwrap().failure.is_none());
        let mut result = json!({"identifier":"page"});
        let error = engine
            .prepare_publication(
                "context.newPage",
                &mut result,
                |_| -> Result<(), ErrorRecord> {
                    panic!("a detached original root cannot be published");
                },
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::TargetClosed);
        assert!(!state.state.lock().unwrap().published);
        assert!(messages.try_recv().is_err());
    }

    #[test]
    fn failed_page_publication_keeps_its_originating_error_after_root_or_context_retirement() {
        for context_closed in [false, true] {
            let (engine, _messages) = engine();
            let state = insert_page(&engine);
            state.state.lock().unwrap().failure = Some(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "original",
                "original failure",
            ));
            let page = engine.page("page", "test").unwrap();
            engine.detach_renderer(&page, "session");
            if context_closed {
                engine
                    .context("context", "test")
                    .unwrap()
                    .state
                    .closed
                    .send_replace(Some(closed("context")));
            }
            let mut result = json!({"identifier":"page"});
            let error = engine
                .prepare_publication(
                    "context.newPage",
                    &mut result,
                    |_| -> Result<(), ErrorRecord> {
                        panic!("failed page must not encode a success");
                    },
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::ResourceLimit);
            assert_eq!(error.message.as_ref(), "original failure");
        }
    }
}
