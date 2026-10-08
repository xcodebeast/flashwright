//! Resource publication follows successful reply validation and encoding.

use super::*;

impl Engine {
    /// Capture current initial page state and publish only if preparing its reply succeeds.
    /// Holding the state lock closes the gap between the initial snapshot and live events.
    pub fn prepare_publication<Prepared>(
        &self,
        method: &str,
        result: &mut Value,
        prepare: impl FnOnce(&Value) -> Result<Prepared, ErrorRecord>,
    ) -> Result<Prepared, ErrorRecord> {
        if matches!(
            method,
            "page.evaluateHandle"
                | "frame.evaluateHandle"
                | "handle.evaluateHandle"
                | "handle.getProperty"
                | "handle.getProperties"
        ) {
            return self.prepare_handle_publication(result, prepare);
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
                let prepared = prepare(result)?;
                context.published = true;
                Ok(prepared)
            }
            "context.newPage" => {
                let page = registry
                    .pages
                    .get(&identifier)
                    .ok_or_else(|| closed(method))?;
                let mut state = page.state.state.lock().unwrap();
                if let Some(error) = &state.failure {
                    return Err(error.clone());
                }
                *result = json!({ "identifier": identifier, "frames": state.frame_snapshot(), "mainFrame": state.main_frame });
                let prepared = prepare(result)?;
                state.published = true;
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
        if matches!(
            method,
            "page.evaluateHandle"
                | "frame.evaluateHandle"
                | "handle.evaluateHandle"
                | "handle.getProperty"
                | "handle.getProperties"
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
                        dispose(
                            browser.as_ref(),
                            ResourceKind::Context,
                            &context.protocol_identifier,
                        )
                        .await
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
                        dispose(
                            browser.as_ref(),
                            ResourceKind::Page,
                            &page.target_identifier,
                        )
                        .await
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

    fn insert_page(engine: &Engine) -> Arc<PageState> {
        let state = Arc::new(PageState::default());
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
        state.state.lock().unwrap().observe(
            "Page.frameNavigated",
            &json!({ "frame": { "id": "current", "url": "about:blank", "loaderId": "loader" } }),
        );
        let mut result = json!({ "identifier": "page", "mainFrame": "stale", "frames": [] });
        let rejected = engine.prepare_publication("context.newPage", &mut result, |value| {
            assert_eq!(value["mainFrame"], "current");
            assert_eq!(value["frames"].as_array().unwrap().len(), 1);
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
        let mut result = json!({ "identifier": "page" });
        engine
            .prepare_publication("context.newPage", &mut result, |_| Ok(()))
            .unwrap();
        assert!(state.state.lock().unwrap().published);
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
}
