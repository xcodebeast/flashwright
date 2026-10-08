//! Browser events invalidate owned state even when no public operation is running.

use super::*;
use flashwright_browser::connection::Event;
use flashwright_protocol::DriverMessage;
use tokio::sync::broadcast;

impl Engine {
    pub(crate) fn emit(&self, target: &str, event: &str, parameters: Value) {
        if self
            .outgoing
            .try_send(
                DriverMessage::Event {
                    target: target.to_owned(),
                    event: event.to_owned(),
                    parameters,
                }
                .into(),
            )
            .is_err()
        {
            let _ = self.fatal.send(true);
        }
    }

    pub(crate) fn observe_browser(self: &Arc<Self>, identifier: String, browser: &Arc<Chromium>) {
        let mut events = browser.connection.subscribe();
        let connection = browser.connection.clone();
        let engine = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let event = events.recv().await;
                let Some(engine) = engine.upgrade() else {
                    break;
                };
                match event {
                    Ok(event) => {
                        let sequence = event.sequence;
                        if event.method == "Flashwright.disconnected" {
                            if let Some(browser) = engine.remove_browser(&identifier)
                                && let Err(error) = browser.close().await
                            {
                                eprintln!("flashwright cleanup: {}", error.message);
                            }
                            break;
                        }
                        if engine.handle_event(&identifier, event).is_err() {
                            let _ = engine.fatal.send(true);
                            break;
                        }
                        connection.acknowledge_event(sequence);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = engine.fatal.send(true);
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn handle_event(&self, browser_identifier: &str, event: Event) -> Result<(), ErrorRecord> {
        let relevant = matches!(
            event.method.as_str(),
            "Page.frameAttached"
                | "Runtime.executionContextCreated"
                | "Runtime.executionContextDestroyed"
                | "Runtime.executionContextsCleared"
                | "Page.frameNavigated"
                | "Page.frameDetached"
                | "Page.navigatedWithinDocument"
                | "Page.frameRequestedNavigation"
                | "Page.lifecycleEvent"
                | "Network.requestWillBeSent"
                | "Network.responseReceived"
                | "Network.loadingFinished"
                | "Network.loadingFailed"
                | "Target.targetDestroyed"
                | "Target.targetCrashed"
                | "Inspector.targetCrashed"
                | "Inspector.detached"
        );
        if !relevant {
            return Ok(());
        }
        let parameters: Value = match event.parameters {
            Some(parameters) => serde_json::from_str(parameters.get()).map_err(|error| {
                ErrorRecord::new(ErrorCode::Protocol, "event", error.to_string())
            })?,
            None => json!({}),
        };
        let pages: Vec<_> = {
            let registry = self.registry.lock().unwrap();
            registry
                .pages
                .iter()
                .filter(|(_, page)| {
                    registry
                        .contexts
                        .get(&page.context_identifier)
                        .is_some_and(|context| context.browser_identifier == browser_identifier)
                        && (event.session_identifier.as_deref() == Some(&page.session_identifier)
                            || parameters["targetId"].as_str() == Some(&page.target_identifier))
                })
                .map(|(identifier, page)| (identifier.clone(), page.clone()))
                .collect()
        };
        for (identifier, page) in pages {
            match event.method.as_str() {
                "Target.targetDestroyed" | "Inspector.detached" => {
                    self.registry.lock().unwrap().pages.remove(&identifier);
                    self.finish_page(&identifier, &page, closed("page"), "close");
                }
                "Target.targetCrashed" | "Inspector.targetCrashed" => {
                    self.finish_page(
                        &identifier,
                        &page,
                        ErrorRecord::new(ErrorCode::PageCrashed, "page", "page renderer crashed"),
                        "crash",
                    );
                }
                _ => {
                    let context = self
                        .context(&page.context_identifier, "context.storageState")
                        .ok();
                    let mut state = page.state.state.lock().unwrap();
                    let events = state.observe(&event.method, &parameters);
                    if state.published
                        && event.method == "Page.frameNavigated"
                        && let Some(origin) = parameters["frame"]["securityOrigin"].as_str()
                        && let Some(context) = &context
                        && let Err(error) = context.state.visit(origin)
                    {
                        state.failure = Some(error);
                    }
                    if state.published
                        && event.method == "Page.frameDetached"
                        && parameters["reason"] == "swap"
                        && let Some(context) = &context
                    {
                        *context.state.storage_failure.lock().unwrap() = Some(ErrorRecord::new(
                            ErrorCode::UnsupportedFeature,
                            "context.storageState",
                            "storage collection from out-of-process child frames is not implemented",
                        ));
                    }
                    if state.published {
                        for (name, parameters) in events {
                            self.emit(&identifier, name, parameters);
                        }
                    }
                    page.state.changed.send_replace(state.sequence);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn finish_page(
        &self,
        identifier: &str,
        page: &Page,
        error: ErrorRecord,
        event: &str,
    ) {
        let mut state = page.state.state.lock().unwrap();
        if event == "crash" && state.failure.is_some() {
            return;
        }
        state.failure = Some(error);
        state.sequence += 1;
        if state.published {
            self.emit(identifier, event, Value::Null);
        }
        page.state.changed.send_replace(state.sequence);
    }

    pub(crate) fn remove_context(&self, identifier: &str) -> Option<Context> {
        self.remove_context_with_error(identifier, closed("context"))
    }

    fn remove_context_with_error(&self, identifier: &str, error: ErrorRecord) -> Option<Context> {
        let (context, pages) = {
            let mut registry = self.registry.lock().unwrap();
            let identifiers: Vec<_> = registry
                .pages
                .iter()
                .filter(|(_, page)| page.context_identifier == identifier)
                .map(|(identifier, _)| identifier.clone())
                .collect();
            let pages: Vec<_> = identifiers
                .into_iter()
                .filter_map(|identifier| {
                    registry
                        .pages
                        .remove(&identifier)
                        .map(|page| (identifier, page))
                })
                .collect();
            (registry.contexts.remove(identifier), pages)
        };
        for (identifier, page) in pages {
            self.finish_page(&identifier, &page, error.clone(), "close");
        }
        if let Some(context) = &context {
            context.state.closed.send_replace(Some(error));
            if context.published {
                self.emit(identifier, "close", Value::Null);
            }
        }
        context
    }

    pub(crate) fn remove_browser(&self, identifier: &str) -> Option<Arc<Chromium>> {
        let (browser, contexts) = {
            let mut registry = self.registry.lock().unwrap();
            let browser = registry.browsers.remove(identifier)?;
            let contexts: Vec<_> = registry
                .contexts
                .iter()
                .filter(|(_, context)| context.browser_identifier == identifier)
                .map(|(identifier, _)| identifier.clone())
                .collect();
            (browser, contexts)
        };
        let error = browser
            .browser
            .connection
            .failure()
            .unwrap_or_else(|| closed("browser"));
        for context in contexts {
            self.remove_context_with_error(&context, error.clone());
        }
        if browser.published {
            self.emit(identifier, "disconnected", Value::Null);
        }
        Some(browser.browser)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn originating_failure_survives_context_and_page_removal() {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Engine::new(None, outgoing, fatal, ResourceLimits::default());
        let context = Arc::new(context_state::ContextState::default());
        let page = Arc::new(PageState::default());
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                state: context.clone(),
                published: false,
            },
        );
        engine.registry.lock().unwrap().pages.insert(
            "page".into(),
            Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: page.clone(),
            },
        );
        let page_operation = page.while_alive::<()>("response.body", std::future::pending());
        let context_operation =
            context.while_alive::<()>("context.cookies", std::future::pending());
        let close = async {
            tokio::task::yield_now().await;
            engine
                .remove_context_with_error(
                    "context",
                    ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        "chromium",
                        "CDP event exceeds control-message limit",
                    ),
                )
                .unwrap();
        };
        let (page_result, context_result, ()) =
            tokio::join!(page_operation, context_operation, close);
        for (result, method) in [
            (page_result, "response.body"),
            (context_result, "context.cookies"),
        ] {
            let error = result.unwrap_err();
            assert_eq!(error.code, ErrorCode::ResourceLimit);
            assert_eq!(&*error.method, method);
            assert_eq!(&*error.message, "CDP event exceeds control-message limit");
        }
        assert_eq!(
            context
                .while_alive("context.cookies", async { Ok(()) })
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert!(engine.registry.lock().unwrap().contexts.is_empty());
        assert!(engine.registry.lock().unwrap().pages.is_empty());
    }
}
