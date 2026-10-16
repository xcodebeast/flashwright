//! Browser events invalidate owned state even when no public operation is running.

use super::*;
use flashwright_browser::connection::Event;
use flashwright_protocol::DriverMessage;

impl Engine {
    /// Publish startup diagnostics with their page, preserving order without exposing failed allocations.
    pub(crate) fn page_diagnostic(
        &self,
        identifier: &str,
        page: &Page,
        event: &str,
        parameters: Value,
    ) {
        let trace_context = if event == "pageerror" {
            self.context(&page.context_identifier, "context.trace").ok()
        } else {
            None
        };
        let mut state = page.state.state.lock().unwrap();
        if page.state.purpose != PagePurpose::Public || state.failure.is_some() {
            return;
        }
        if let Some(context) = trace_context
            && context.state.trace_enabled.load(Ordering::Relaxed)
            && let Some(raw) = parameters["exceptionJson"].as_str()
        {
            context.state.trace_diagnostics.lock().unwrap().capture(
                identifier,
                state.published,
                "pageerror",
                raw,
            );
        }
        if state.published {
            self.emit(identifier, event, parameters);
        } else if let Err(error) = state.buffer_initial_event(event, parameters) {
            state.failure = Some(error);
            state.sequence += 1;
            page.state.changed.send_replace(state.sequence);
        }
    }

    pub(crate) fn emit(&self, target: &str, event: &str, parameters: Value) {
        self.publish_event_output(DriverMessage::Event {
            target: target.to_owned(),
            event: event.to_owned(),
            parameters,
        });
    }

    /// The writer closes only after delivering the originating bounded event failure.
    pub(crate) fn event_failure(&self, mut error: ErrorRecord) {
        error.input_delivery = flashwright_protocol::InputDelivery::Uncertain;
        self.publish_event_output(DriverMessage::Error {
            request_id: None,
            error,
        });
    }

    fn publish_event_output(&self, message: DriverMessage) {
        // Registration and FIFO insertion stay inside the original state mutation.
        // Only the later reader completion awaits the writer, with all locks released.
        let mut delivery = self.event_delivery.lock().unwrap();
        let Ok(acknowledgement) = delivery.register() else {
            let _ = self.fatal.send(true);
            return;
        };
        if self
            .outgoing
            .try_send(DriverOutput::AcknowledgedMessage {
                message,
                acknowledgement,
            })
            .is_err()
        {
            let _ = self.fatal.send(true);
        }
    }

    pub(crate) fn observe_browser(
        self: &Arc<Self>,
        identifier: String,
        browser: &Arc<Chromium>,
    ) -> Result<(), ErrorRecord> {
        let engine = Arc::downgrade(self);
        let disconnected_engine = engine.clone();
        let disconnected_identifier = identifier.clone();
        browser.connection.observe_events_with_backpressure(
            move |event| {
                let Some(engine) = engine.upgrade() else {
                    return Ok(None);
                };
                if let Err(error) = engine.handle_event(&identifier, event) {
                    engine.event_failure(error.clone());
                    // Invalid state must close immediately, even if the host has
                    // stopped reading the already-enqueued global error.
                    return Err(error);
                }
                let pending = engine.event_delivery.lock().unwrap().pending();
                match pending {
                    Some(pending) => Ok(Some(Box::pin(pending.wait()))),
                    None => Ok(None),
                }
            },
            move |_| {
                if let Some(engine) = disconnected_engine.upgrade()
                    && let Some(browser) = engine.remove_browser(&disconnected_identifier)
                {
                    let cleanup =
                        engine.begin_browser_cleanup(disconnected_identifier.clone(), browser);
                    tokio::spawn(async move {
                        match cleanup.await {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                eprintln!("flashwright cleanup: {}", error.message)
                            }
                            Err(error) => eprintln!("flashwright cleanup task: {error}"),
                        }
                    });
                }
                Ok(())
            },
        )
    }

    fn handle_event(
        self: &Arc<Self>,
        browser_identifier: &str,
        event: Event,
    ) -> Result<(), ErrorRecord> {
        if matches!(
            event.method.as_str(),
            "Browser.downloadWillBegin" | "Browser.downloadProgress"
        ) {
            return self.download_event(browser_identifier, &event);
        }
        if event.method == "Page.screencastFrame" {
            self.receive_filmstrip_frame(browser_identifier, &event);
            return Ok(());
        }
        let relevant = matches!(
            event.method.as_str(),
            "Page.frameAttached"
                | "Page.javascriptDialogOpening"
                | "Page.javascriptDialogClosed"
                | "Page.fileChooserOpened"
                | "Runtime.executionContextCreated"
                | "Runtime.executionContextDestroyed"
                | "Runtime.executionContextsCleared"
                | "Runtime.exceptionThrown"
                | "Runtime.consoleAPICalled"
                | "Log.entryAdded"
                | "Page.frameNavigated"
                | "Page.frameDetached"
                | "Page.navigatedWithinDocument"
                | "Page.frameRequestedNavigation"
                | "Page.lifecycleEvent"
                | "Network.requestWillBeSent"
                | "Network.responseReceived"
                | "Network.requestWillBeSentExtraInfo"
                | "Network.responseReceivedExtraInfo"
                | "Network.requestServedFromCache"
                | "Fetch.requestPaused"
                | "Network.loadingFinished"
                | "Network.loadingFailed"
                | "Target.targetDestroyed"
                | "Target.attachedToTarget"
                | "Target.detachedFromTarget"
                | "Target.targetCrashed"
                | "Inspector.targetCrashed"
                | "Inspector.detached"
        );
        if !relevant {
            return Ok(());
        }
        // Exception descriptions can contain escaped lone UTF-16 surrogates. Preserve
        // their JSON through the bounded event transport for decoding by JavaScript.
        let parameters: Value = match event.parameters {
            Some(parameters)
                if matches!(
                    event.method.as_str(),
                    "Page.javascriptDialogOpening" | "Page.javascriptDialogClosed"
                ) =>
            {
                json!({ "dialogJson": parameters.get() })
            }
            Some(parameters) if event.method == "Runtime.exceptionThrown" => {
                json!({ "exceptionJson": parameters.get() })
            }
            Some(parameters)
                if matches!(
                    event.method.as_str(),
                    "Runtime.consoleAPICalled" | "Log.entryAdded"
                ) =>
            {
                json!({ "consoleJson": parameters.get() })
            }
            Some(parameters) => serde_json::from_str(parameters.get()).map_err(|error| {
                ErrorRecord::new(ErrorCode::Protocol, "event", error.to_string())
            })?,
            None => json!({}),
        };
        let pages: Vec<_> = {
            let registry = self.registry.lock().unwrap();
            self.diagnostic_sessions
                .observe(browser_identifier, &event.method, &parameters);
            registry
                .pages
                .iter()
                .filter(|(_, page)| {
                    registry
                        .contexts
                        .get(&page.context_identifier)
                        .is_some_and(|context| context.browser_identifier == browser_identifier)
                        && match event.method.as_str() {
                            "Target.targetDestroyed" | "Target.targetCrashed" => {
                                parameters["targetId"].as_str() == Some(&page.target_identifier)
                            }
                            "Target.detachedFromTarget" => {
                                parameters["sessionId"].as_str() == Some(&page.session_identifier)
                                    || parameters["sessionId"].as_str().is_some_and(|session| {
                                        page.state
                                            .renderer_sessions
                                            .lock()
                                            .unwrap()
                                            .original(session)
                                            .is_some()
                                    })
                            }
                            _ => {
                                event.session_identifier.as_deref()
                                    == Some(&page.session_identifier)
                                    || event.session_identifier.as_deref().is_some_and(|session| {
                                        let sessions = page.state.renderer_sessions.lock().unwrap();
                                        if event.method == "Target.attachedToTarget" {
                                            sessions.original(session).is_some()
                                        } else {
                                            sessions.get(session).is_some()
                                        }
                                    })
                                    || parameters["targetId"].as_str()
                                        == Some(&page.target_identifier)
                            }
                        }
                })
                .map(|(identifier, page)| {
                    if event.method == "Target.targetDestroyed"
                        || (event.method == "Target.detachedFromTarget"
                            && parameters["sessionId"].as_str() == Some(&page.session_identifier))
                    {
                        page.state
                            .diagnostic_session_destroyed
                            .store(true, Ordering::Release);
                    }
                    (identifier.clone(), page.clone())
                })
                .collect()
        };
        for (identifier, page) in pages {
            let source_session = event
                .session_identifier
                .as_deref()
                .unwrap_or(&page.session_identifier);
            if event.method == "Target.attachedToTarget" {
                self.attach_renderer(&identifier, &page, source_session, &parameters)?;
                continue;
            }
            if event.method == "Target.detachedFromTarget" {
                if let Some(session) = parameters["sessionId"].as_str() {
                    self.detach_renderer(&page, session);
                    if session == page.session_identifier {
                        self.finish_detached_root(&identifier, &page);
                    }
                }
                continue;
            }
            if event.method == "Inspector.detached" && source_session != page.session_identifier {
                self.detach_renderer(&page, source_session);
                continue;
            }
            match event.method.as_str() {
                "Page.javascriptDialogOpening" | "Page.javascriptDialogClosed" => {
                    self.dialog_event(
                        &identifier,
                        &page,
                        &event.method,
                        parameters["dialogJson"].as_str().ok_or_else(|| {
                            ErrorRecord::new(
                                ErrorCode::Protocol,
                                "page.dialog",
                                "Chromium omitted dialog event parameters",
                            )
                        })?,
                    )?;
                }
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
                "Runtime.consoleAPICalled" | "Log.entryAdded" => {
                    if event.method == "Runtime.consoleAPICalled"
                        && self.content_marker(
                            &page,
                            source_session,
                            parameters["consoleJson"].as_str().unwrap_or(""),
                        )
                    {
                        continue;
                    }
                    if let Err(error) = self.console_event(
                        &identifier,
                        &page,
                        source_session,
                        &event.method,
                        parameters["consoleJson"].as_str().ok_or_else(|| {
                            ErrorRecord::new(
                                ErrorCode::Protocol,
                                "console",
                                "Chromium omitted console event parameters",
                            )
                        })?,
                    ) && page.state.state.lock().unwrap().failure.is_none()
                    {
                        return Err(error);
                    }
                }
                "Page.fileChooserOpened" => {
                    self.file_chooser_event(&identifier, &page, &parameters)?
                }
                "Runtime.exceptionThrown" => {
                    self.page_diagnostic(&identifier, &page, "pageerror", parameters.clone());
                }
                _ => {
                    if event.method == "Fetch.requestPaused"
                        && page.state.purpose != PagePurpose::Public
                    {
                        continue;
                    }
                    let context = self
                        .context(&page.context_identifier, "context.storageState")
                        .ok();
                    let mut state = page.state.state.lock().unwrap();
                    let is_owned_renderer_swap = event.method == "Page.frameDetached"
                        && parameters["reason"] == "swap"
                        && parameters["frameId"]
                            .as_str()
                            .and_then(|identifier| state.frames.get(identifier))
                            .is_some_and(|frame| {
                                frame.session_identifier.as_ref() == source_session
                            });
                    let mut recording_state = context
                        .as_ref()
                        .filter(|context| {
                            page.state.purpose == PagePurpose::Public
                                && context.state.recording_enabled.load(Ordering::Acquire)
                        })
                        .map(|context| context.state.recording.lock().unwrap());
                    let network_event = crate::network_observer::NetworkEvent {
                        session_identifier: source_session,
                        method: &event.method,
                        parameters: &parameters,
                        ingress: crate::network_observer::NetworkIngress {
                            sequence: event.sequence,
                            received_at: event.received_at,
                        },
                    };
                    let (events, body_jobs) = if let Some(recording) = recording_state
                        .as_mut()
                        .and_then(|state| state.active_mut())
                    {
                        recording.observe_page_event(&identifier, &mut state, network_event)
                    } else {
                        (state.observe_event(network_event, None), Vec::new())
                    };
                    drop(recording_state);
                    if let Some(error) = state.failure.as_ref().filter(|error| {
                        matches!(error.method.as_ref(), "network.observe" | "route.observe")
                    }) {
                        return Err(error.clone());
                    }
                    if matches!(
                        event.method.as_str(),
                        "Runtime.executionContextCreated"
                            | "Runtime.executionContextDestroyed"
                            | "Runtime.executionContextsCleared"
                            | "Page.frameDetached"
                            | "Page.frameNavigated"
                    ) {
                        page.state
                            .evaluation_runtimes
                            .lock()
                            .unwrap()
                            .retain(|_, runtime| state.context_is_alive(&runtime.context));
                        page.state.handles.lock().unwrap().retain(|_, handle| {
                            handle.primitive.is_some() || state.context_is_alive(&handle.context)
                        });
                    }
                    if state.published
                        && event.method == "Page.frameNavigated"
                        && let Some(origin) = parameters["frame"]["securityOrigin"].as_str()
                        && let Some(context) = &context
                        && let Err(error) = context.state.visit(origin)
                    {
                        state.failure = Some(error);
                    }
                    if is_owned_renderer_swap && state.failure.is_none() {
                        state.failure = crate::renderer_setup::unsupported_remote_configuration(
                            !page.state.init_scripts.lock().unwrap().is_empty(),
                            state.interception.enabled
                                || page.state.routing_transition.load(Ordering::Acquire)
                                || page.state.routing_registered.load(Ordering::Acquire)
                                || context.as_ref().is_some_and(|context| {
                                    context.state.routing_registered.load(Ordering::Acquire)
                                }),
                        );
                    }
                    if is_owned_renderer_swap && let Some(context) = &context {
                        context.state.storage_failure.lock().unwrap().get_or_insert_with(|| ErrorRecord::new(
                            ErrorCode::UnsupportedFeature,
                            "context.storageState",
                            "storage collection from out-of-process child frames is not implemented",
                        ));
                    }
                    for (name, parameters) in events {
                        if state.published {
                            self.emit(&identifier, name, parameters);
                        } else if page.state.purpose == PagePurpose::Public
                            && matches!(
                                name,
                                "request"
                                    | "route"
                                    | "response"
                                    | "requestfinished"
                                    | "requestfailed"
                            )
                            && let Err(error) = state.buffer_initial_event(name, parameters)
                        {
                            state.failure = Some(error);
                        }
                    }
                    page.state.changed.send_replace(state.sequence);
                    let routing_actions = state.interception.take_actions();
                    drop(state);
                    if let Some(context) = &context {
                        self.dispatch_recording_bodies(context, &page, body_jobs);
                    }
                    self.dispatch_routing_actions(&identifier, &page, routing_actions)?;
                }
            }
        }
        Ok(())
    }

    /// Root detachment is terminal for this page, while child detach only retires its subtree.
    fn finish_detached_root(&self, identifier: &str, page: &Page) {
        let browser = {
            let mut registry = self.registry.lock().unwrap();
            if !registry
                .pages
                .get(identifier)
                .is_some_and(|current| Arc::ptr_eq(&current.state, &page.state))
            {
                return;
            }
            registry.pages.remove(identifier);
            registry
                .contexts
                .get(&page.context_identifier)
                .and_then(|context| registry.browsers.get(&context.browser_identifier))
                .map(|owner| owner.browser.clone())
        };
        let error = page
            .state
            .state
            .lock()
            .unwrap()
            .failure
            .clone()
            .unwrap_or_else(|| closed("page"));
        self.finish_page(identifier, page, error, "close");
        // A lost CDP session does not prove the target died. Retain its native identity
        // through bounded disposal; browser teardown owns it if the browser was withdrawn.
        if let Some(browser) = browser {
            let page = page.clone();
            tokio::spawn(async move {
                page.state
                    .disposal
                    .dispose(browser.as_ref(), &page.target_identifier)
                    .await;
            });
        }
    }

    pub(crate) fn finish_page(
        &self,
        identifier: &str,
        page: &Page,
        error: ErrorRecord,
        event: &str,
    ) {
        page.state.renderer_sessions.lock().unwrap().retire_all();
        self.registry
            .lock()
            .unwrap()
            .init_scripts
            .retain(|_, script| script.page_identifier.as_deref() != Some(identifier));
        page.state.init_scripts.lock().unwrap().clear();
        let trace_context = self.context(&page.context_identifier, "context.trace").ok();
        let mut state = page.state.state.lock().unwrap();
        if event == "crash" && state.failure.is_some() {
            return;
        }
        if !state.published
            && let Some(context) = &trace_context
        {
            if let Some(capture) = context.state.filmstrip.lock().unwrap().as_ref() {
                capture.discard_unpublished(identifier);
            }
            context
                .state
                .trace_diagnostics
                .lock()
                .unwrap()
                .discard_unpublished_page(identifier);
        }
        if let Some(context) = &trace_context
            && let Some(recording) = context.state.recording.lock().unwrap().active_mut()
        {
            recording.network_page_closed(identifier);
        }
        state.failure.get_or_insert(error);
        state.interception.clear();
        page.state.file_chooser.lock().unwrap().cancel();
        page.state.dialogs.lock().unwrap().retire();
        page.state.handles.lock().unwrap().clear();
        page.state.evaluation_runtimes.lock().unwrap().clear();
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
        self.remove_context_if_owned(identifier, error, None)
    }

    pub(crate) fn remove_context_if_owned(
        &self,
        identifier: &str,
        error: ErrorRecord,
        owner: Option<&Context>,
    ) -> Option<Context> {
        let (context, pages) = {
            let mut registry = self.registry.lock().unwrap();
            if owner.is_some_and(|owner| {
                !registry
                    .contexts
                    .get(identifier)
                    .is_some_and(|current| Arc::ptr_eq(&current.state, &owner.state))
            }) {
                return None;
            }
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
            registry
                .init_scripts
                .retain(|_, script| script.context_identifier != identifier);
            (registry.contexts.remove(identifier), pages)
        };
        for (identifier, page) in pages {
            self.finish_page(&identifier, &page, error.clone(), "close");
        }
        if let Some(context) = &context {
            context.state.close_trace();
            if let Some(downloads) = context.state.downloads.get() {
                downloads.retire(error.clone());
            }
            context.state.closed.send_replace(Some(error));
            if context.published {
                self.emit(identifier, "close", Value::Null);
            }
        }
        context
    }

    pub(crate) fn remove_browser(&self, identifier: &str) -> Option<Arc<Chromium>> {
        let (browser, contexts, error) = {
            let mut registry = self.registry.lock().unwrap();
            let browser = registry.browsers.remove(identifier)?;
            let error = browser
                .browser
                .connection
                .failure()
                .unwrap_or_else(|| closed("browser"));
            let contexts: Vec<_> = registry
                .contexts
                .iter()
                .filter(|(_, context)| context.browser_identifier == identifier)
                .map(|(identifier, context)| {
                    // Close publication admission atomically with withdrawal of the browser.
                    context.state.closed.send_replace(Some(error.clone()));
                    identifier.clone()
                })
                .collect();
            (browser, contexts, error)
        };
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

    #[test]
    fn remote_configuration_guard_ignores_a_swap_from_the_previous_renderer() {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        let page = Page {
            context_identifier: "context".into(),
            target_identifier: "root".into(),
            session_identifier: "root-session".into(),
            state: Arc::new(PageState::default()),
        };
        let context = Context {
            browser_identifier: "browser".into(),
            protocol_identifier: "native-context".into(),
            viewport: None,
            devices: crate::devices::DeviceOptions::default(),
            settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
            state: Arc::new(context_state::ContextState::default()),
            published: false,
        };
        page.state
            .renderer_sessions
            .lock()
            .unwrap()
            .register_root("root", "root-session")
            .unwrap();
        {
            let mut state = page.state.state.lock().unwrap();
            state.initialize_main_frame("root", "root-session");
            state.observe_in_session(
                "root-session",
                "Page.frameAttached",
                &json!({"frameId":"child", "parentFrameId":"root"}),
            );
            state.observe_in_session("root-session", "Target.attachedToTarget", &json!({"sessionId":"successor-session", "targetInfo":{"type":"iframe", "targetId":"child"}}));
        }
        page.state.routing_registered.store(true, Ordering::Release);
        engine
            .registry
            .lock()
            .unwrap()
            .contexts
            .insert("context".into(), context.clone());
        engine
            .registry
            .lock()
            .unwrap()
            .pages
            .insert("page".into(), page.clone());
        engine
            .handle_event(
                "browser",
                Event {
                    sequence: 1,
                    received_at: std::time::Instant::now(),
                    method: "Page.frameDetached".into(),
                    session_identifier: Some("root-session".into()),
                    parameters: Some(
                        serde_json::value::to_raw_value(
                            &json!({"frameId":"child", "reason":"swap"}),
                        )
                        .unwrap(),
                    ),
                },
            )
            .unwrap();
        assert!(page.state.state.lock().unwrap().failure.is_none());
        assert!(context.state.storage_failure.lock().unwrap().is_none());
        assert_eq!(
            page.state.state.lock().unwrap().frames["child"]
                .session_identifier
                .as_ref(),
            "successor-session"
        );
    }

    #[test]
    fn target_crashes_require_root_identity_but_owned_frame_inspector_crashes_fail_the_page() {
        for root_crash in [false, true] {
            let (outgoing, _messages) = mpsc::channel(16);
            let (fatal, _failure) = watch::channel(false);
            let engine = Arc::new(Engine::new(
                None,
                outgoing,
                fatal,
                ResourceLimits::default(),
            ));
            let page = Page {
                context_identifier: "context".into(),
                target_identifier: "page-target".into(),
                session_identifier: "root-session".into(),
                state: Arc::new(PageState::default()),
            };
            let (root, child) = {
                let mut sessions = page.state.renderer_sessions.lock().unwrap();
                let root = sessions
                    .register_root("page-target", "root-session")
                    .unwrap();
                let child = sessions
                    .register_child(&root, "child-target", "child-session")
                    .unwrap();
                (root, child)
            };
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
            engine
                .registry
                .lock()
                .unwrap()
                .pages
                .insert("page".into(), page.clone());
            for target in ["worker-target", "retired-target", "child-target"] {
                engine
                    .handle_event(
                        "browser",
                        Event {
                            sequence: 1,
                            received_at: std::time::Instant::now(),
                            method: "Target.targetCrashed".into(),
                            session_identifier: Some("root-session".into()),
                            parameters: Some(
                                serde_json::value::to_raw_value(
                                    &json!({"targetId":target,"status":"crashed","errorCode":1}),
                                )
                                .unwrap(),
                            ),
                        },
                    )
                    .unwrap();
                assert!(page.state.state.lock().unwrap().failure.is_none());
                assert!(!root.is_retired());
                assert!(!child.is_retired());
            }
            // Root crashes require target identity; an owned frame Inspector crash follows the reference.
            engine.handle_event("browser", Event {
            sequence: 2, received_at: std::time::Instant::now(),
            method: if root_crash { "Target.targetCrashed" } else { "Inspector.targetCrashed" }.into(),
            session_identifier: if root_crash { None } else { Some("child-session".into()) },
            parameters: if root_crash { Some(serde_json::value::to_raw_value(&json!({"targetId":"page-target","status":"crashed","errorCode":1})).unwrap()) } else { None },
        }).unwrap();
            assert_eq!(
                page.state
                    .state
                    .lock()
                    .unwrap()
                    .failure
                    .as_ref()
                    .unwrap()
                    .code,
                ErrorCode::PageCrashed
            );
            assert!(root.is_retired());
            assert!(child.is_retired());
        }
    }

    #[test]
    fn snapshot_terminal_session_events_survive_public_registry_removal() {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        for (method, parameters) in [
            ("Target.targetDestroyed", json!({"targetId":"target"})),
            ("Target.detachedFromTarget", json!({"sessionId":"session"})),
        ] {
            let session = engine
                .diagnostic_sessions
                .register("browser", "target", "session")
                .unwrap();
            assert!(engine.registry.lock().unwrap().pages.is_empty());
            let event = || Event {
                sequence: 1,
                received_at: std::time::Instant::now(),
                method: method.into(),
                session_identifier: Some("session".into()),
                parameters: Some(serde_json::value::to_raw_value(&parameters).unwrap()),
            };
            engine.handle_event("other-browser", event()).unwrap();
            assert!(!*session.destruction().borrow());
            engine.handle_event("browser", event()).unwrap();
            assert!(*session.destruction().borrow());
        }
    }

    #[test]
    fn terminal_event_before_or_after_enrollment_cannot_lose_session_proof() {
        for terminal_first in [true, false] {
            let (outgoing, _messages) = mpsc::channel(16);
            let (fatal, _failure) = watch::channel(false);
            let engine = Arc::new(Engine::new(
                None,
                outgoing,
                fatal,
                ResourceLimits::default(),
            ));
            let state = Arc::new(PageState::default());
            state.state.lock().unwrap().published = true;
            let page = Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state,
            };
            engine.registry.lock().unwrap().contexts.insert(
                "context".into(),
                Context {
                    browser_identifier: "browser".into(),
                    protocol_identifier: "native-context".into(),
                    viewport: None,
                    devices: crate::devices::DeviceOptions::default(),
                    settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
                    state: Arc::new(context_state::ContextState::default()),
                    published: true,
                },
            );
            engine
                .registry
                .lock()
                .unwrap()
                .pages
                .insert("page".into(), page.clone());
            page.state.state.lock().unwrap().published = false;
            assert!(matches!(
                engine.diagnostic_session("page", &page),
                Err(crate::diagnostic_sessions::SessionFailure::Unavailable)
            ));
            let initial_body = engine.network_diagnostic_session("page", &page).unwrap();
            assert!(initial_body.belongs_to("target", "session"));
            page.state.state.lock().unwrap().published = true;
            let terminal = || Event {
                sequence: 1,
                received_at: std::time::Instant::now(),
                method: "Target.detachedFromTarget".into(),
                session_identifier: None,
                parameters: Some(
                    serde_json::value::to_raw_value(
                        &json!({"sessionId":"session","targetId":"target"}),
                    )
                    .unwrap(),
                ),
            };
            let lease = if terminal_first {
                None
            } else {
                Some(engine.diagnostic_session("page", &page).unwrap())
            };
            engine.handle_event("browser", terminal()).unwrap();
            // Root detachment withdraws public ownership, while retained diagnostic
            // leases still observe their original session's destruction.
            assert!(!engine.registry.lock().unwrap().pages.contains_key("page"));
            assert_eq!(
                page.state
                    .state
                    .lock()
                    .unwrap()
                    .failure
                    .as_ref()
                    .unwrap()
                    .code,
                ErrorCode::TargetClosed
            );
            assert!(
                page.state
                    .diagnostic_session_destroyed
                    .load(Ordering::Acquire)
            );
            assert!(matches!(
                engine.diagnostic_session("page", &page),
                Err(crate::diagnostic_sessions::SessionFailure::Unavailable)
            ));
            assert!(*initial_body.destruction().borrow());
            if let Some(lease) = lease {
                assert!(*lease.destruction().borrow());
            }
        }
    }

    #[test]
    fn exceptions_preserve_utf16_and_follow_published_page_session_ownership() {
        let (outgoing, mut messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: crate::devices::DeviceOptions::default(),
                settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
                state: Arc::new(context_state::ContextState::default()),
                published: true,
            },
        );
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
        let exception = r#"{"exceptionDetails":{"text":"Uncaught","exception":{"description":"Error: \ud800\u0000\udfff"}}}"#;
        let event = |session: &str| Event {
            received_at: std::time::Instant::now(),
            sequence: 1,
            method: "Runtime.exceptionThrown".into(),
            session_identifier: Some(session.into()),
            parameters: Some(serde_json::from_str(exception).unwrap()),
        };
        engine.handle_event("browser", event("session")).unwrap();
        assert!(messages.try_recv().is_err());
        state.state.lock().unwrap().published = true;
        engine
            .handle_event("browser", event("other-session"))
            .unwrap();
        engine
            .handle_event("other-browser", event("session"))
            .unwrap();
        assert!(messages.try_recv().is_err());
        engine.handle_event("browser", event("session")).unwrap();
        let DriverOutput::AcknowledgedMessage {
            message:
                DriverMessage::Event {
                    target,
                    event,
                    parameters,
                },
            acknowledgement,
        } = messages.try_recv().unwrap()
        else {
            panic!("expected page exception event");
        };
        acknowledgement.complete();
        assert_eq!(target, "page");
        assert_eq!(event, "pageerror");
        assert_eq!(parameters["exceptionJson"], exception);
        state.state.lock().unwrap().failure = Some(closed("page"));
        engine
            .handle_event(
                "browser",
                Event {
                    received_at: std::time::Instant::now(),
                    sequence: 2,
                    method: "Runtime.exceptionThrown".into(),
                    session_identifier: Some("session".into()),
                    parameters: Some(serde_json::from_str(exception).unwrap()),
                },
            )
            .unwrap();
        assert!(messages.try_recv().is_err());
    }

    #[test]
    fn unpublished_public_pages_keep_joined_request_before_route_and_storage_stays_private() {
        for purpose in [PagePurpose::Public, PagePurpose::Storage] {
            let (outgoing, mut messages) = mpsc::channel(16);
            let (fatal, _failure) = watch::channel(false);
            let engine = Arc::new(Engine::new(
                None,
                outgoing,
                fatal,
                ResourceLimits::default(),
            ));
            engine.registry.lock().unwrap().contexts.insert(
                "context".into(),
                Context {
                    browser_identifier: "browser".into(),
                    protocol_identifier: "native".into(),
                    viewport: None,
                    devices: Default::default(),
                    settings: context_settings::ContextSettings::parse(&json!({})).unwrap(),
                    state: Arc::new(context_state::ContextState::default()),
                    published: true,
                },
            );
            let state = Arc::new(PageState {
                purpose,
                ..Default::default()
            });
            state.state.lock().unwrap().interception.enabled = purpose == PagePurpose::Public;
            engine.registry.lock().unwrap().pages.insert(
                "page".into(),
                Page {
                    context_identifier: "context".into(),
                    target_identifier: "target".into(),
                    session_identifier: "session".into(),
                    state: state.clone(),
                },
            );
            for (sequence, method, parameters) in [
                (
                    1,
                    "Network.requestWillBeSent",
                    json!({"requestId":"network","type":"Fetch","request":{"url":"https://example.test/early","method":"GET","headers":{}}}),
                ),
                (
                    2,
                    "Fetch.requestPaused",
                    json!({"requestId":"fetch","networkId":"network","request":{"url":"https://example.test/early","method":"GET","headers":{}}}),
                ),
            ] {
                engine
                    .handle_event(
                        "browser",
                        Event {
                            received_at: std::time::Instant::now(),
                            sequence,
                            method: method.into(),
                            session_identifier: Some("session".into()),
                            parameters: Some(serde_json::value::to_raw_value(&parameters).unwrap()),
                        },
                    )
                    .unwrap();
            }
            assert!(messages.try_recv().is_err());
            let state = state.state.lock().unwrap();
            let names: Vec<_> = state
                .initial_events
                .iter()
                .map(|event| event["event"].as_str().unwrap())
                .collect();
            if purpose == PagePurpose::Public {
                assert_eq!(names, ["request", "route"]);
            } else {
                assert!(names.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn originating_failure_survives_context_and_page_removal() {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        let context = Arc::new(context_state::ContextState::default());
        let page = Arc::new(PageState::default());
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: crate::devices::DeviceOptions::default(),
                settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
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

    #[tokio::test]
    async fn root_detach_wakes_unbounded_page_waiters_once_and_preserves_original_failure() {
        for existing_failure in [false, true] {
            let (outgoing, mut messages) = mpsc::channel(16);
            let (fatal, _failure) = watch::channel(false);
            let engine = Arc::new(Engine::new(
                None,
                outgoing,
                fatal,
                ResourceLimits::default(),
            ));
            let state = Arc::new(PageState::default());
            state
                .renderer_sessions
                .lock()
                .unwrap()
                .register_root("target", "session")
                .unwrap()
                .mark_ready();
            state.state.lock().unwrap().published = true;
            let page = Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: state.clone(),
            };
            engine
                .registry
                .lock()
                .unwrap()
                .pages
                .insert("page".into(), page.clone());
            engine.registry.lock().unwrap().contexts.insert(
                "context".into(),
                Context {
                    browser_identifier: "browser".into(),
                    protocol_identifier: "native".into(),
                    viewport: None,
                    devices: Default::default(),
                    settings: context_settings::ContextSettings::parse(&json!({})).unwrap(),
                    state: Arc::new(context_state::ContextState::default()),
                    published: true,
                },
            );
            if existing_failure {
                state.state.lock().unwrap().failure = Some(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    "original",
                    "original failure",
                ));
            }
            let waiter = state.while_alive::<()>("page.evaluate", std::future::pending());
            let detach = async {
                tokio::task::yield_now().await;
                for sequence in 0..2 {
                    engine
                        .handle_event(
                            "browser",
                            Event {
                                received_at: std::time::Instant::now(),
                                sequence,
                                method: "Target.detachedFromTarget".into(),
                                session_identifier: None,
                                parameters: Some(
                                    serde_json::value::to_raw_value(
                                        &json!({"sessionId":"session", "targetId":"target"}),
                                    )
                                    .unwrap(),
                                ),
                            },
                        )
                        .unwrap();
                }
            };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
                tokio::join!(waiter, detach)
            })
            .await
            .unwrap();
            let error = result.unwrap_err();
            assert_eq!(
                error.code,
                if existing_failure {
                    ErrorCode::ResourceLimit
                } else {
                    ErrorCode::TargetClosed
                }
            );
            if existing_failure {
                assert_eq!(error.message.as_ref(), "original failure");
            }
            assert!(engine.page("page", "test").is_err());
            assert!(engine.context("context", "test").is_ok());
            assert!(
                matches!(messages.try_recv().unwrap(), DriverOutput::AcknowledgedMessage { message: flashwright_protocol::DriverMessage::Event { event, .. }, .. } if event == "close")
            );
            assert!(messages.try_recv().is_err());
        }
    }
}
