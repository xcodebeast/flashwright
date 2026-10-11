//! Private interception control and exact-once settlement of callback-owned Fetch pauses.

use super::*;
use crate::routing_state::RoutingAction;
use flashwright_browser::connection::{
    Command,
    fetch_body::{ContinueRequest, FetchHeader, FulfillRequest},
};

impl Engine {
    pub(crate) async fn set_routing(
        self: &Arc<Self>,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let scope = if method.starts_with("context.") {
            "context"
        } else {
            "page"
        };
        validate_keys(method, &parameters, &[scope, "enabled"])?;
        let identifier = identifier(&parameters, scope, method)?;
        let enabled = parameters["enabled"]
            .as_bool()
            .ok_or_else(|| invalid(method, "enabled must be a boolean"))?;
        let selected_page = if scope == "page" {
            Some(self.page(identifier, method)?)
        } else {
            None
        };
        let context_identifier = selected_page
            .as_ref()
            .map_or(identifier, |page| &page.context_identifier);
        let context = self.context(context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let _configuration = operation
            .wait(context.state.while_alive(method, async {
                Ok(context.state.page_configuration.write().await)
            }))
            .await?;
        operation.check()?;
        let (pages, previous_registration) = {
            // Attachment uses the same registry boundary, so it either observes
            // this registration or precedes its remote-frame admission check.
            let registry = self.registry.lock().unwrap();
            let pages: Vec<_> = registry
                .pages
                .iter()
                .filter(|(page_identifier, page)| {
                    page.context_identifier == context_identifier
                        && page.state.purpose == PagePurpose::Public
                        && (scope == "context" || page_identifier.as_str() == identifier)
                })
                .map(|(identifier, page)| {
                    let interception_enabled =
                        page.state.state.lock().unwrap().interception.enabled;
                    (identifier.clone(), page.clone(), interception_enabled)
                })
                .collect();
            if enabled {
                for (_, page, _) in &pages {
                    check_routing_page(&page.state.state.lock().unwrap(), method)?;
                }
            }
            for (_, page, previous_interception) in &pages {
                let desired = if scope == "context" {
                    enabled || page.state.routing_registered.load(Ordering::Acquire)
                } else {
                    enabled || context.state.routing_registered.load(Ordering::Acquire)
                };
                page.state
                    .routing_transition
                    .store(desired != *previous_interception, Ordering::Release);
            }
            let previous_registration = if let Some(page) = &selected_page {
                page.state
                    .routing_registered
                    .swap(enabled, Ordering::AcqRel)
            } else {
                context
                    .state
                    .routing_registered
                    .swap(enabled, Ordering::AcqRel)
            };
            (pages, previous_registration)
        };
        let mut released_interception = false;
        let result = async {
            for (identifier, page, previous_interception) in &pages {
                let desired = context.state.routing_registered.load(Ordering::Acquire)
                    || page.state.routing_registered.load(Ordering::Acquire);
                released_interception |= *previous_interception && !desired;
                self.configure_page_routing(identifier, page, &browser, desired, operation)
                    .await?;
            }
            operation.check()
        }
        .await;
        if let Err(mut error) = result {
            // Keep attachment admission closed until every native restoration settles.
            // Disabling may already have published route settlement; it cannot be undone.
            let (_cleanup_cancellation_sender, cleanup_cancellation) = watch::channel(false);
            let cleanup = Operation::new("route.restore".into(), None, cleanup_cancellation);
            let mut missing_original_page = false;
            let restored = !released_interception
                && matches!(
                    timeout(Duration::from_secs(1), async {
                        for (identifier, page, previous_interception) in &pages {
                            let still_owned = self
                                .registry
                                .lock()
                                .unwrap()
                                .pages
                                .get(identifier)
                                .is_some_and(|current| Arc::ptr_eq(&current.state, &page.state));
                            if still_owned {
                                self.configure_page_routing(
                                    identifier,
                                    page,
                                    &browser,
                                    *previous_interception,
                                    &cleanup,
                                )
                                .await?;
                            } else {
                                missing_original_page = true;
                            }
                        }
                        Ok::<(), ErrorRecord>(())
                    })
                    .await,
                    Ok(Ok(()))
                );
            if restored {
                let _registry = self.registry.lock().unwrap();
                if let Some(page) = &selected_page {
                    page.state
                        .routing_registered
                        .store(previous_registration, Ordering::Release);
                } else {
                    context
                        .state
                        .routing_registered
                        .store(previous_registration, Ordering::Release);
                }
                for (_, page, _) in &pages {
                    page.state
                        .routing_transition
                        .store(false, Ordering::Release);
                }
            }
            error.cleanup = Some(
                if restored {
                    error
                        .cleanup
                        .as_deref()
                        .unwrap_or(if missing_original_page {
                            "routingRestoredForRemainingPages"
                        } else {
                            "routingRestored"
                        })
                        .to_owned()
                } else if let Some(page) = &selected_page {
                    self.retire_routing_page(identifier, page, &browser)
                        .await
                        .to_owned()
                } else if let Some(original) =
                    self.remove_context_if_owned(context_identifier, closed(method), Some(&context))
                {
                    dispose(
                        browser.as_ref(),
                        ResourceKind::Context,
                        &original.protocol_identifier,
                    )
                    .await
                    .to_owned()
                } else {
                    "ownerAlreadyClosing".to_owned()
                }
                .into(),
            );
            return Err(error);
        }
        {
            let _registry = self.registry.lock().unwrap();
            for (_, page, _) in &pages {
                page.state
                    .routing_transition
                    .store(false, Ordering::Release);
            }
        }
        Ok(Value::Null)
    }

    pub(crate) async fn configure_page_routing(
        &self,
        identifier: &str,
        page: &Page,
        browser: &Chromium,
        enabled: bool,
        operation: &Operation,
    ) -> Result<(), ErrorRecord> {
        let method = "route.configure";
        let context = self.context(&page.context_identifier, method)?;
        {
            let mut state = page.state.state.lock().unwrap();
            state.check(method)?;
            if enabled {
                check_routing_page(&state, method)?;
            }
            if state.interception.enabled == enabled {
                return Ok(());
            }
            state.interception.enabled = enabled;
            if !enabled {
                let events = if context.state.recording_enabled.load(Ordering::Acquire) {
                    let mut owner = context.state.recording.lock().unwrap();
                    if let Some(recording) = owner.active_mut() {
                        recording.release_network_interception(identifier, &mut state)
                    } else {
                        state.release_interception(None)
                    }
                } else {
                    state.release_interception(None)
                };
                if state.published {
                    for (event, parameters) in events {
                        self.emit(identifier, event, parameters);
                    }
                }
            }
        }
        for (method, parameters) in [
            ("Network.setCacheDisabled", json!({"cacheDisabled":enabled})),
            (
                if enabled {
                    "Fetch.enable"
                } else {
                    "Fetch.disable"
                },
                if enabled {
                    json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]})
                } else {
                    json!({})
                },
            ),
        ] {
            let result = operation
                .wait(
                    page.state.while_alive(
                        method,
                        browser
                            .connection
                            .call(method, parameters, Some(&page.session_identifier)),
                    ),
                )
                .await;
            if let Err(mut error) = result {
                error.cleanup = Some(
                    self.retire_routing_page(identifier, page, browser)
                        .await
                        .into(),
                );
                return Err(error);
            }
        }
        Ok(())
    }

    pub(crate) async fn handle_route(
        self: &Arc<Self>,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let permitted: &[&str] = match method {
            "route.continue" => &[
                "page",
                "identifier",
                "identity",
                "url",
                "method",
                "headers",
                "isFallback",
            ],
            "route.fulfill" => &[
                "page",
                "identifier",
                "identity",
                "status",
                "headers",
                "statusText",
            ],
            "route.abort" => &["page", "identifier", "identity", "reason"],
            _ => return Err(invalid(method, "unknown route operation")),
        };
        validate_keys(method, &parameters, permitted)?;
        let page_identifier = identifier(&parameters, "page", method)?;
        let request_identifier = identifier(&parameters, "identifier", method)?;
        let identity = identifier(&parameters, "identity", method)?;
        let page = self.page(page_identifier, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let headers = parse_headers(method, &parameters["headers"])?;
        let url = optional_text(method, &parameters, "url")?;
        let request_method = optional_text(method, &parameters, "method")?;
        let response_phrase = optional_text(method, &parameters, "statusText")?;
        let status = parameters["status"].as_u64().unwrap_or(200);
        if method == "route.fulfill"
            && (!(100..=599).contains(&status)
                || parameters
                    .get("status")
                    .is_some_and(|value| !value.is_u64()))
        {
            return Err(invalid(
                method,
                "status must be an integer between 100 and 599",
            ));
        }
        let is_fallback = parameters
            .get("isFallback")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| invalid(method, "isFallback must be a boolean"))
            })
            .transpose()?
            .unwrap_or(false);
        let reason = if method == "route.abort" {
            abort_reason(parameters["reason"].as_str().unwrap_or("failed"))?
        } else {
            ""
        };
        operation.check()?;
        let action = {
            let mut state = page.state.state.lock().unwrap();
            state.request_for_occurrence(request_identifier, identity, method)?;
            let body = operation
                .shared_input_attachment()
                .map(|input| state.interception.body(&input))
                .transpose()?;
            let owner = state
                .interception
                .take_route(identity, request_identifier)?;
            let action = match method {
                "route.continue" => {
                    let parameters = ContinueRequest {
                        request_identifier: owner.fetch_identifier.clone(),
                        url,
                        method: request_method,
                        headers,
                    };
                    let page_state::DocumentState {
                        requests,
                        interception,
                        ..
                    } = &mut *state;
                    let original_headers = &requests
                        .get(request_identifier)
                        .expect("validated occurrence is retained")
                        .metadata()["headers"];
                    interception.continue_route(owner, parameters, body, original_headers)?
                }
                "route.fulfill" => {
                    let parameters = FulfillRequest {
                        request_identifier: owner.fetch_identifier.clone(),
                        response_code: status as u16,
                        response_headers: headers.unwrap_or_default(),
                        response_phrase,
                    };
                    state.interception.fulfill_route(owner, parameters, body)
                }
                _ => state.interception.abort_route(owner, reason.into()),
            };
            if context.state.recording_enabled.load(Ordering::Acquire)
                && let Some(recording) = context.state.recording.lock().unwrap().active_mut()
            {
                recording.network_route_decision(
                    page_identifier,
                    identity,
                    &action.command,
                    is_fallback,
                );
            }
            action
        };
        let mut command = match action.start(&browser.connection, &page.session_identifier) {
            Ok(command) => command,
            Err(mut error) => {
                error.cleanup = Some(
                    self.retire_routing_page(page_identifier, &page, &browser)
                        .await
                        .into(),
                );
                return Err(error);
            }
        };
        let mut consumed = false;
        let result = operation
            .wait(page.state.while_alive(method, async {
                let result = command.response().await;
                consumed = true;
                result
            }))
            .await;
        if let Err(mut error) = result {
            let completed = !consumed
                && !command.prevent_dispatch()
                && settled_successfully(&mut command).await;
            if !completed {
                error.cleanup = Some(
                    self.retire_routing_page(page_identifier, &page, &browser)
                        .await
                        .into(),
                );
            }
            return Err(error);
        }
        drop(action);
        Ok(Value::Null)
    }

    /// Start in incoming event order, then await without holding document or recording locks.
    pub(crate) fn dispatch_routing_actions(
        self: &Arc<Self>,
        identifier: &str,
        page: &Page,
        actions: Vec<RoutingAction>,
    ) -> Result<(), ErrorRecord> {
        if actions.is_empty() {
            return Ok(());
        }
        let context = self.context(&page.context_identifier, "route")?;
        let browser = self.browser(&context.browser_identifier, "route")?;
        for action in actions {
            let mut command = action.start(&browser.connection, &page.session_identifier)?;
            let engine = self.clone();
            let page = page.clone();
            let browser = browser.clone();
            let identifier = identifier.to_owned();
            tokio::spawn(async move {
                let result = timeout(
                    Duration::from_secs(5),
                    page.state.while_alive("route", command.response()),
                )
                .await;
                if !matches!(result, Ok(Ok(_)))
                    && page.state.state.lock().unwrap().failure.is_none()
                {
                    engine
                        .retire_routing_page(&identifier, &page, &browser)
                        .await;
                }
                drop(action);
            });
        }
        Ok(())
    }

    async fn retire_routing_page(
        &self,
        identifier: &str,
        page: &Page,
        browser: &Chromium,
    ) -> &'static str {
        let removed = {
            let mut registry = self.registry.lock().unwrap();
            let original = registry
                .pages
                .get(identifier)
                .is_some_and(|current| Arc::ptr_eq(&current.state, &page.state));
            if original {
                registry.pages.remove(identifier);
            }
            original
        };
        if removed {
            self.finish_page(identifier, page, closed("route"), "close");
        }
        page.state
            .disposal
            .dispose(browser, &page.target_identifier)
            .await
    }
}

async fn settled_successfully(command: &mut Command) -> bool {
    if let Some(result) = command.try_response() {
        return result.is_ok();
    }
    matches!(
        timeout(Duration::from_millis(500), command.response()).await,
        Ok(Ok(_))
    )
}

fn optional_text(
    method: &str,
    parameters: &Value,
    name: &str,
) -> Result<Option<String>, ErrorRecord> {
    parameters
        .get(name)
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid(method, &format!("{name} must be a string")))
        })
        .transpose()
}

fn parse_headers(method: &str, headers: &Value) -> Result<Option<Vec<FetchHeader>>, ErrorRecord> {
    if headers.is_null() {
        return Ok(None);
    }
    let headers = headers
        .as_array()
        .ok_or_else(|| invalid(method, "headers must be an array"))?;
    if headers.len() > 4096 {
        return Err(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            method,
            "too many route headers",
        ));
    }
    headers
        .iter()
        .map(|header| {
            validate_keys(method, header, &["name", "value"])?;
            let name = identifier(header, "name", method)?.to_owned();
            let value = header["value"]
                .as_str()
                .ok_or_else(|| invalid(method, "header value must be a string"))?
                .to_owned();
            if name
                .bytes()
                .any(|byte| byte <= 32 || byte >= 127 || b"()<>@,;:\\\"/[]?={}".contains(&byte))
                || value.contains(['\r', '\n', '\0'])
            {
                return Err(invalid(method, "invalid HTTP header"));
            }
            Ok(FetchHeader { name, value })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// Enabling interception must cover every current renderer before any flag changes.
fn check_routing_page(state: &page_state::DocumentState, method: &str) -> Result<(), ErrorRecord> {
    state.check(method)?;
    if state.frames.values().any(|frame| frame.remote) {
        return Err(ErrorRecord::new(
            ErrorCode::UnsupportedFeature,
            method,
            "request routing in out-of-process child frames is not implemented",
        ));
    }
    Ok(())
}

fn abort_reason(reason: &str) -> Result<&'static str, ErrorRecord> {
    match reason {
        "aborted" => Ok("Aborted"),
        "accessdenied" => Ok("AccessDenied"),
        "addressunreachable" => Ok("AddressUnreachable"),
        "blockedbyclient" => Ok("BlockedByClient"),
        "blockedbyresponse" => Ok("BlockedByResponse"),
        "connectionaborted" => Ok("ConnectionAborted"),
        "connectionclosed" => Ok("ConnectionClosed"),
        "connectionfailed" => Ok("ConnectionFailed"),
        "connectionrefused" => Ok("ConnectionRefused"),
        "connectionreset" => Ok("ConnectionReset"),
        "internetdisconnected" => Ok("InternetDisconnected"),
        "namenotresolved" => Ok("NameNotResolved"),
        "timedout" => Ok("TimedOut"),
        "failed" => Ok("Failed"),
        _ => Err(invalid(
            "route.abort",
            &format!("Unknown error code: {reason}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_rejects_remote_and_pending_handoffs_without_mutating_interception() {
        for direct_attachment in [false, true] {
            let mut state = page_state::DocumentState::default();
            state.initialize_main_frame("root", "root-session");
            state.observe_in_session(
                "root-session",
                "Page.frameAttached",
                &json!({"frameId":"child", "parentFrameId":"root"}),
            );
            check_routing_page(&state, "page.route").unwrap();
            if direct_attachment {
                state.observe_in_session("root-session", "Target.attachedToTarget", &json!({"sessionId":"child-session", "targetInfo":{"type":"iframe", "targetId":"child"}}));
            } else {
                state.observe_in_session(
                    "root-session",
                    "Page.frameDetached",
                    &json!({"frameId":"child", "reason":"swap"}),
                );
            }
            let error = check_routing_page(&state, "page.route").unwrap_err();
            assert_eq!(error.code, ErrorCode::UnsupportedFeature);
            assert!(!state.interception.enabled);
            assert!(state.failure.is_none());
        }
    }
}
