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
        if let Some(page) = &selected_page {
            page.state
                .routing_registered
                .store(enabled, Ordering::Release);
        } else {
            context
                .state
                .routing_registered
                .store(enabled, Ordering::Release);
        }
        let pages: Vec<_> = self
            .registry
            .lock()
            .unwrap()
            .pages
            .iter()
            .filter(|(page_identifier, page)| {
                page.context_identifier == context_identifier
                    && page.state.purpose == PagePurpose::Public
                    && (scope == "context" || page_identifier.as_str() == identifier)
            })
            .map(|(identifier, page)| (identifier.clone(), page.clone()))
            .collect();
        for (identifier, page) in pages {
            let desired = context.state.routing_registered.load(Ordering::Acquire)
                || page.state.routing_registered.load(Ordering::Acquire);
            self.configure_page_routing(&identifier, &page, &browser, desired, operation)
                .await?;
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
        {
            let mut state = page.state.state.lock().unwrap();
            state.check(method)?;
            if state.interception.enabled == enabled {
                return Ok(());
            }
            state.interception.enabled = enabled;
            if !enabled {
                let events = state.release_interception();
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
            "route.continue" => &["page", "identifier", "identity", "url", "method", "headers"],
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
            match method {
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
            }
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
        if self
            .registry
            .lock()
            .unwrap()
            .pages
            .remove(identifier)
            .is_some()
        {
            self.finish_page(identifier, page, closed("route"), "close");
        }
        dispose(browser, ResourceKind::Page, &page.target_identifier).await
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
