//! Child renderer initialization never borrows a successor's session for completion or cleanup.

use super::*;
use crate::renderer_sessions::RendererSession;
use std::time::Instant;

const METHOD: &str = "frame.attach";
const INITIALIZATION_BUDGET: Duration = Duration::from_secs(10);
const CLEANUP_BUDGET: Duration = Duration::from_secs(1);

/// Only the protocol's exact missing-session response proves this addressed session is gone.
pub(super) fn session_is_gone(error: &ErrorRecord) -> bool {
    error.code == ErrorCode::Protocol
        && error.browser_error_code == Some(-32001)
        && serde_json::from_str::<Value>(&error.message).is_ok_and(|payload| {
            payload["code"] == -32001 && payload["message"] == "Session with given id not found."
        })
}

/// Classify only this command's native reply; a page failure may belong to another session.
async fn renderer_command(
    connection: &flashwright_browser::Connection,
    owner: &RendererSession,
    method: &str,
    parameters: Value,
) -> Result<Value, ErrorRecord> {
    let result = connection
        .call(method, parameters, Some(&owner.session_identifier))
        .await;
    if result.as_ref().is_err_and(session_is_gone) {
        owner.mark_destroyed();
    }
    result
}

pub(crate) fn auto_attach_parameters() -> Value {
    // Renderer child workers/worklets pause before filtering. Admit them for cleanup;
    // other related targets gate pausing on filter acceptance and may outlive this page.
    json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true,
        "filter":[{"type":"iframe"},{"type":"worker"},{"type":"worklet"},{"exclude":true}]})
}

impl Engine {
    /// Attachment publication is synchronous with event ingress; setup retains that exact owner.
    pub(crate) fn attach_renderer(
        self: &Arc<Self>,
        page_identifier: &str,
        page: &Page,
        parent_session: &str,
        parameters: &Value,
    ) -> Result<(), ErrorRecord> {
        let is_frame = parameters["targetInfo"]["type"] == "iframe";
        let target = string_field(&parameters["targetInfo"], "targetId")?;
        let session = string_field(parameters, "sessionId")?;
        // Removal and context closure transfer child cleanup to the original page/context
        // disposer. Keep registry ownership through enrollment so finish_page cannot miss it.
        let registry = self.registry.lock().unwrap();
        if !registry
            .pages
            .get(page_identifier)
            .is_some_and(|current| Arc::ptr_eq(&current.state, &page.state))
        {
            return Ok(());
        }
        let Some(context) = registry.contexts.get(&page.context_identifier).cloned() else {
            return Ok(());
        };
        if context.state.closed.borrow().is_some() {
            return Ok(());
        }
        let Some(browser) = registry
            .browsers
            .get(&context.browser_identifier)
            .map(|entry| entry.browser.clone())
        else {
            return Ok(());
        };
        let mut replaced = None;
        let (owner, accepted) = {
            let mut state = page.state.state.lock().unwrap();
            let mut sessions = page.state.renderer_sessions.lock().unwrap();
            let Some(parent) = sessions.original(parent_session) else {
                return Err(invalid(
                    METHOD,
                    "child attachment has no original parent owner",
                ));
            };
            if let Some(previous) = sessions.original(&session) {
                if previous.target_identifier == target
                    && previous.parent_session_identifier() == Some(parent_session)
                {
                    return Ok(());
                }
                return Err(invalid(
                    METHOD,
                    "child attachment cannot rebind an original session",
                ));
            }
            let (owner, events) = if !is_frame || parent.is_retired() || state.failure.is_some() {
                (
                    sessions.register_cleanup_child(&parent, &target, &session)?,
                    Vec::new(),
                )
            } else {
                if let Some(previous) = sessions.for_target(&target) {
                    if previous.parent_session_identifier().is_none() {
                        return Err(invalid(
                            METHOD,
                            "child attachment cannot replace the root renderer",
                        ));
                    }
                    sessions.retire(&previous);
                    replaced = Some(previous);
                }
                let owner = sessions.register_child(&parent, &target, &session)?;
                let events =
                    state.observe_in_session(parent_session, "Target.attachedToTarget", parameters);
                (owner, events)
            };
            if !owner.is_retired()
                && state
                    .frames
                    .get(&target)
                    .is_some_and(|frame| frame.session_identifier.as_ref() == session)
            {
                context.state.storage_failure.lock().unwrap().get_or_insert_with(|| {
                    ErrorRecord::new(
                        ErrorCode::UnsupportedFeature,
                        "context.storageState",
                        "storage collection from out-of-process child frames is not implemented",
                    )
                });
                if state.failure.is_none() {
                    let has_routes = state.interception.enabled
                        || page.state.routing_transition.load(Ordering::Acquire)
                        || page.state.routing_registered.load(Ordering::Acquire)
                        || context.state.routing_registered.load(Ordering::Acquire);
                    state.failure = unsupported_remote_configuration(has_routes);
                }
            }
            page.state
                .evaluation_runtimes
                .lock()
                .unwrap()
                .retain(|_, runtime| state.context_is_alive(&runtime.context));
            page.state.handles.lock().unwrap().retain(|_, handle| {
                handle.primitive.is_some() || state.context_is_alive(&handle.context)
            });
            let accepted = !owner.is_retired()
                && state.failure.is_none()
                && state
                    .frames
                    .get(&target)
                    .is_some_and(|frame| frame.session_identifier.as_ref() == session);
            if !accepted {
                sessions.retire(&owner);
            }
            if state.published {
                for (name, parameters) in events {
                    self.emit(page_identifier, name, parameters);
                }
            }
            page.state.changed.send_replace(state.sequence);
            (owner, accepted)
        };
        drop(registry);
        if let Some(previous) = replaced {
            self.retire_renderer(
                page_identifier,
                page,
                &previous.session_identifier,
                None,
                false,
            );
        }
        let engine = self.clone();
        let page = page.clone();
        let page_identifier = page_identifier.to_owned();
        tokio::spawn(async move {
            let mut retirement = owner.retirement();
            if accepted {
                let operation = Operation::new(
                    METHOD.into(),
                    Some(tokio::time::Instant::now() + INITIALIZATION_BUDGET),
                    retirement.clone(),
                );
                let outcome = engine
                    .initialize_renderer(
                        &page_identifier,
                        &page,
                        &context,
                        &browser,
                        &owner,
                        &operation,
                    )
                    .await;
                match outcome {
                    Ok(()) => {
                        let mut state = page.state.state.lock().unwrap();
                        state.sequence += 1;
                        page.state.changed.send_replace(state.sequence);
                    }
                    Err(_) if owner.is_destroyed() => {
                        engine.detach_renderer(
                            &page_identifier,
                            &page,
                            &owner.session_identifier,
                            None,
                        );
                    }
                    Err(error) if !owner.is_retired() => {
                        let mut state = page.state.state.lock().unwrap();
                        if state.failure.is_none() {
                            state.failure = Some(error);
                        }
                        page.state.renderer_sessions.lock().unwrap().retire(&owner);
                        state.sequence += 1;
                        page.state.changed.send_replace(state.sequence);
                    }
                    Err(_) => {}
                }
            }
            while !*retirement.borrow_and_update() {
                if retirement.changed().await.is_err() {
                    break;
                }
            }
            engine
                .cleanup_renderer(&page_identifier, &page, &browser, &owner)
                .await;
        });
        Ok(())
    }

    async fn initialize_renderer(
        &self,
        page_identifier: &str,
        page: &Page,
        context: &Context,
        browser: &Chromium,
        owner: &RendererSession,
        operation: &Operation,
    ) -> Result<(), ErrorRecord> {
        let _configuration = operation
            .wait(context.state.while_alive(METHOD, async {
                Ok(context.state.page_configuration.read().await)
            }))
            .await?;
        let mut commands = vec![
            ("Page.enable", json!({})),
            ("Page.setLifecycleEventsEnabled", json!({"enabled":true})),
            ("Network.enable", json!({})),
            ("Runtime.enable", json!({})),
            ("Log.enable", json!({})),
            (
                "Emulation.setEmulatedMedia",
                context.settings.media_parameters(),
            ),
        ];
        if context.settings.ignore_https_errors {
            commands.push((
                "Security.setIgnoreCertificateErrors",
                json!({"ignore":true}),
            ));
        }
        if !context.settings.javascript_enabled {
            commands.push((
                "Emulation.setScriptExecutionDisabled",
                json!({"value":true}),
            ));
        }
        if context.devices.has_touch {
            commands.push((
                "Emulation.setTouchEmulationEnabled",
                json!({"enabled":true}),
            ));
        }
        if !context.devices.user_agent.is_empty() {
            commands.push((
                "Emulation.setUserAgentOverride",
                context.devices.user_agent_override(),
            ));
        }
        commands.push(("Target.setAutoAttach", auto_attach_parameters()));
        for (method, parameters) in commands {
            operation
                .wait(page.state.while_alive(
                    METHOD,
                    renderer_command(&browser.connection, owner, method, parameters),
                ))
                .await?;
        }
        self.initialize_renderer_scripts(page_identifier, page, browser, owner, operation)
            .await?;
        operation
            .wait(page.state.while_alive(
                METHOD,
                renderer_command(
                    &browser.connection,
                    owner,
                    "Runtime.runIfWaitingForDebugger",
                    json!({}),
                ),
            ))
            .await?;
        operation.check()?;
        // Registration's writer must see either a pending owner or this fully initialized owner.
        owner.mark_ready();
        Ok(())
    }

    /// Acknowledged resume and detachment settle this session only. Uncertain cleanup disposes
    /// the owning page with the existing bounded browser-guardian fallback, never a child target id.
    async fn cleanup_renderer(
        &self,
        page_identifier: &str,
        page: &Page,
        browser: &Chromium,
        owner: &RendererSession,
    ) {
        if owner.is_destroyed() {
            return;
        }
        let resumed = timeout(
            CLEANUP_BUDGET,
            browser.connection.call(
                "Runtime.runIfWaitingForDebugger",
                json!({}),
                Some(&owner.session_identifier),
            ),
        )
        .await;
        if matches!(&resumed, Ok(Err(error)) if session_is_gone(error)) {
            owner.mark_destroyed();
            return;
        }
        let detached = timeout(
            CLEANUP_BUDGET,
            browser.connection.call(
                "Target.detachFromTarget",
                json!({"sessionId":owner.session_identifier}),
                owner.parent_session_identifier(),
            ),
        )
        .await;
        if owner.is_destroyed() || (matches!(resumed, Ok(Ok(_))) && matches!(detached, Ok(Ok(_)))) {
            return;
        }
        let mut error = page
            .state
            .state
            .lock()
            .unwrap()
            .failure
            .clone()
            .unwrap_or_else(|| closed(METHOD));
        error.cleanup = Some(
            page.state
                .disposal
                .dispose(browser, &page.target_identifier)
                .await
                .into(),
        );
        let still_owned = {
            let mut registry = self.registry.lock().unwrap();
            let current = registry
                .pages
                .get(page_identifier)
                .is_some_and(|current| Arc::ptr_eq(&current.state, &page.state));
            if current {
                registry.pages.remove(page_identifier);
            }
            current
        };
        if still_owned {
            self.finish_page(page_identifier, page, error, "close");
        }
    }

    /// Terminal session identity retires only its original renderer subtree.
    pub(crate) fn detach_renderer(
        &self,
        page_identifier: &str,
        page: &Page,
        session_identifier: &str,
        ingress: Option<crate::network_observer::NetworkIngress>,
    ) {
        self.retire_renderer(page_identifier, page, session_identifier, ingress, true);
    }

    /// Logical replacement cancels semantic work without claiming native destruction.
    pub(crate) fn retire_renderer(
        &self,
        page_identifier: &str,
        page: &Page,
        session_identifier: &str,
        ingress: Option<crate::network_observer::NetworkIngress>,
        destroyed: bool,
    ) {
        let context = self
            .registry
            .lock()
            .unwrap()
            .contexts
            .get(&page.context_identifier)
            .cloned();
        let mut state = page.state.state.lock().unwrap();
        let retired = {
            let mut sessions = page.state.renderer_sessions.lock().unwrap();
            let Some(owner) = sessions.original(session_identifier) else {
                return;
            };
            let originals = sessions.originals();
            if destroyed {
                owner.mark_destroyed();
            }
            sessions.retire(&owner);
            originals
                .into_iter()
                .filter(|owner| owner.is_retired())
                .collect::<Vec<_>>()
        };
        let mut recording_state = context
            .as_ref()
            .filter(|context| {
                page.state.purpose == PagePurpose::Public
                    && context.state.recording_enabled.load(Ordering::Acquire)
            })
            .map(|context| context.state.recording.lock().unwrap());
        for owner in retired {
            let session = &owner.session_identifier;
            if owner.is_destroyed() {
                state.observe_in_session(session, "Runtime.executionContextsCleared", &json!({}));
            } else {
                state
                    .main_worlds
                    .retain(|_, context| context.session_identifier.as_ref() != session);
                state
                    .execution_contexts
                    .retain(|_, context| context.session_identifier.as_ref() != session);
            }
            let event = crate::network_observer::NetworkEvent {
                session_identifier: session,
                method: "Flashwright.rendererDetached",
                parameters: &Value::Null,
                // Host-side setup failure has no native ingress or sequence to invent.
                ingress: ingress.unwrap_or(crate::network_observer::NetworkIngress {
                    sequence: 0,
                    received_at: Instant::now(),
                }),
            };
            let events = if let Some(recording) = recording_state
                .as_mut()
                .and_then(|state| state.active_mut())
            {
                let (events, jobs) =
                    recording.observe_page_event(page_identifier, &mut state, event);
                debug_assert!(
                    jobs.is_empty(),
                    "renderer retirement cannot start a body read"
                );
                events
            } else {
                state.observe_event(event, None)
            };
            for (name, parameters) in events {
                if state.published {
                    self.emit(page_identifier, name, parameters);
                } else if let Err(error) = state.buffer_initial_event(name, parameters) {
                    state.failure = Some(error);
                }
            }
        }
        page.state
            .evaluation_runtimes
            .lock()
            .unwrap()
            .retain(|_, runtime| state.context_is_alive(&runtime.context));
        page.state.handles.lock().unwrap().retain(|_, handle| {
            handle.primitive.is_some() || state.context_is_alive(&handle.context)
        });
        page.state.changed.send_replace(state.sequence);
    }
}

/// A direct attachment has the same configuration limits as a renderer swap.
pub(crate) fn unsupported_remote_configuration(has_routes: bool) -> Option<ErrorRecord> {
    let (method, message) = if has_routes {
        (
            "route.configure",
            "request routing in out-of-process child frames is not implemented",
        )
    } else {
        return None;
    };
    Some(ErrorRecord::new(
        ErrorCode::UnsupportedFeature,
        method,
        message,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer_sessions::RendererSessions;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn logical_renderer_replacement_does_not_fabricate_context_destruction() {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Engine::new(None, outgoing, fatal, ResourceLimits::default());
        let page = Page {
            context_identifier: "context".into(),
            target_identifier: "root".into(),
            session_identifier: "root-session".into(),
            state: Arc::new(PageState::default()),
        };
        let child = {
            let mut sessions = page.state.renderer_sessions.lock().unwrap();
            let root = sessions.register_root("root", "root-session").unwrap();
            sessions
                .register_child(&root, "child", "child-session")
                .unwrap()
        };
        let context = crate::page_state::ExecutionContext {
            session_identifier: "child-session".into(),
            identifier: 7,
            unique_identifier: "original".into(),
            frame_identifier: "child".into(),
        };
        let destruction = {
            let mut state = page.state.state.lock().unwrap();
            state
                .execution_contexts
                .insert(context.key(), context.clone());
            state.main_worlds.insert("child".into(), context.clone());
            state.watch_context_destruction(&context).unwrap()
        };
        engine.retire_renderer("page", &page, "child-session", None, false);
        assert!(child.is_retired());
        assert!(!child.is_destroyed());
        assert!(!page.state.state.lock().unwrap().context_is_alive(&context));
        assert!(!*destruction.destroyed.borrow());
        engine.detach_renderer("page", &page, "child-session", None);
        assert!(*destruction.destroyed.borrow());
    }

    #[test]
    fn late_attachment_after_context_closure_is_owned_by_context_disposal() {
        let (outgoing, mut messages) = mpsc::channel(16);
        let (fatal, failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        let page = Page {
            context_identifier: "context".into(),
            target_identifier: "target".into(),
            session_identifier: "root-session".into(),
            state: Arc::new(PageState::default()),
        };
        let root = page
            .state
            .renderer_sessions
            .lock()
            .unwrap()
            .register_root("target", "root-session")
            .unwrap();
        let context = Context {
            browser_identifier: "browser".into(),
            protocol_identifier: "native-context".into(),
            viewport: None,
            devices: crate::devices::DeviceOptions::default(),
            settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
            state: Arc::new(context_state::ContextState::default()),
            published: false,
        };
        engine
            .registry
            .lock()
            .unwrap()
            .pages
            .insert("page".into(), page.clone());
        engine
            .registry
            .lock()
            .unwrap()
            .contexts
            .insert("context".into(), context.clone());
        let parameters =
            json!({"sessionId":"late-child", "targetInfo":{"type":"iframe", "targetId":"child"}});
        // close_context publishes closure before disposal and registry removal.
        context.state.closed.send_replace(Some(closed("context")));
        engine
            .attach_renderer("page", &page, "root-session", &parameters)
            .unwrap();
        assert!(!root.is_retired());
        assert!(
            page.state
                .renderer_sessions
                .lock()
                .unwrap()
                .get("late-child")
                .is_none()
        );
        assert!(page.state.state.lock().unwrap().failure.is_none());
        // The same already-selected event may arrive after disposal removed its owner.
        engine.remove_context("context");
        engine
            .attach_renderer("page", &page, "root-session", &parameters)
            .unwrap();
        assert!(root.is_retired());
        assert!(messages.try_recv().is_err());
        assert!(!*failure.borrow());
    }

    #[test]
    fn stale_page_attachment_cannot_enroll_against_a_replacement_page() {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        let original = Page {
            context_identifier: "context".into(),
            target_identifier: "target".into(),
            session_identifier: "root-session".into(),
            state: Arc::new(PageState::default()),
        };
        let mut replacement = original.clone();
        replacement.state = Arc::new(PageState::default());
        engine
            .registry
            .lock()
            .unwrap()
            .pages
            .insert("page".into(), replacement.clone());
        engine
            .attach_renderer(
                "page",
                &original,
                "root-session",
                &json!({
                    "sessionId":"late-child", "targetInfo":{"type":"iframe", "targetId":"child"}
                }),
            )
            .unwrap();
        assert!(
            replacement
                .state
                .renderer_sessions
                .lock()
                .unwrap()
                .get("late-child")
                .is_none()
        );
    }

    #[tokio::test]
    async fn missing_session_reply_retires_only_the_original_addressed_owner() {
        let mut sessions = RendererSessions::default();
        let root = sessions.register_root("page", "root-session").unwrap();
        let original = sessions
            .register_child(&root, "frame", "old-session")
            .unwrap();
        sessions.retire(&original);
        let replacement = sessions
            .register_child(&root, "frame", "new-session")
            .unwrap();
        let (host, peer) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(host);
        let connection = flashwright_browser::Connection::new(reader, writer);
        let (reader, mut writer) = tokio::io::split(peer);
        let mut reader = BufReader::new(reader);
        let (result, ()) = tokio::join!(
            renderer_command(
                &connection,
                &original,
                "Runtime.runIfWaitingForDebugger",
                json!({})
            ),
            async {
                let mut bytes = Vec::new();
                timeout(Duration::from_secs(1), reader.read_until(0, &mut bytes))
                    .await
                    .unwrap()
                    .unwrap();
                let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
                assert_eq!(command["sessionId"], "old-session");
                let mut reply = serde_json::to_vec(&json!({"id":command["id"],"error":{"code":-32001,"message":"Session with given id not found."}})).unwrap();
                reply.push(0);
                writer.write_all(&reply).await.unwrap();
            }
        );
        assert!(result.is_err());
        assert!(original.is_destroyed());
        assert!(!replacement.is_destroyed());
        assert!(!replacement.is_retired());
        assert!(!root.is_destroyed());
    }

    #[tokio::test]
    async fn page_failure_with_the_same_text_is_not_original_session_death_proof() {
        let mut sessions = RendererSessions::default();
        let root = sessions.register_root("page", "root-session").unwrap();
        let owner = sessions
            .register_child(&root, "frame", "child-session")
            .unwrap();
        let (host, peer) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(host);
        let connection = flashwright_browser::Connection::new(reader, writer);
        let state = PageState::default();
        let mut error = ErrorRecord::new(
            ErrorCode::Protocol,
            "chromium",
            r#"{"code":-32001,"message":"Session with given id not found."}"#,
        );
        error.browser_error_code = Some(-32001);
        state.state.lock().unwrap().failure = Some(error);
        let result = state
            .while_alive(
                METHOD,
                renderer_command(&connection, &owner, "Page.enable", json!({})),
            )
            .await;
        assert!(result.is_err());
        assert!(!owner.is_destroyed());
        let mut reader = BufReader::new(peer);
        let mut bytes = Vec::new();
        assert!(
            timeout(Duration::from_millis(20), reader.read_until(0, &mut bytes))
                .await
                .is_err()
        );
    }

    #[test]
    fn missing_session_reply_is_distinct_from_page_failure_or_arbitrary_error_text() {
        let mut error = ErrorRecord::new(
            ErrorCode::Protocol,
            "chromium",
            r#"{"code":-32001,"message":"Session with given id not found."}"#,
        );
        error.browser_error_code = Some(-32001);
        assert!(session_is_gone(&error));
        for message in [
            r#"{"code":-32001,"message":"Other protocol failure"}"#,
            r#"{"code":-32000,"message":"Session with given id not found."}"#,
            r#"{"code":-32001,"message":"Prefix Session with given id not found."}"#,
            "Session with given id not found.",
        ] {
            let mut unrelated = error.clone();
            unrelated.message = message.into();
            assert!(!session_is_gone(&unrelated));
        }
        error.browser_error_code = None;
        assert!(!session_is_gone(&error));
    }
}
