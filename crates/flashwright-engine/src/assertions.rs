//! Full assertion predicates with host-owned deadlines and optional document residency.

use super::locators::{LocatorRealm, check_exception, context_was_destroyed};
use super::*;
use flashwright_browser::connection::Command;
use std::borrow::Cow;
use tokio::time::sleep;

const METHOD: &str = "assertion.run";
const DIAGNOSTIC_CLEANUP_BUDGET: Duration = Duration::from_millis(50);
const EXPRESSIONS: &[&str] = &[
    "to.have.text",
    "to.have.text.array",
    "to.contain.text.array",
    "to.have.count",
    "to.be.visible",
    "to.be.hidden",
    "to.be.enabled",
    "to.be.disabled",
    "to.be.checked",
    "to.be.attached",
    "to.be.detached",
    "to.be.editable",
    "to.be.readonly",
    "to.be.empty",
    "to.be.focused",
    "to.have.value",
    "to.have.url",
    "to.have.title",
    "to.have.attribute",
    "to.have.attribute.value",
    "to.have.class",
    "to.have.class.array",
    "to.contain.class",
    "to.contain.class.array",
    "to.have.css",
    "to.have.id",
    "to.have.values",
    "to.have.role",
    "to.have.accessible.name",
    "to.have.accessible.description",
    "to.have.accessible.error.message",
];

struct AssertionRequest<'request> {
    expression: &'request str,
    is_not: bool,
    units: Cow<'request, [u16]>,
}

impl Engine {
    pub(crate) async fn run_assertion(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        validate_keys(
            METHOD,
            &parameters,
            &["page", "frame", "expression", "isNot", "request"],
        )?;
        let expression = identifier(&parameters, "expression", METHOD)?;
        if !EXPRESSIONS.contains(&expression) {
            return Err(ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                METHOD,
                format!("assertion {expression} is not implemented"),
            ));
        }
        let request = AssertionRequest {
            expression,
            is_not: parse(METHOD, parameters["isNot"].clone())?,
            units: Cow::Owned(parse(METHOD, parameters["request"].clone())?),
        };
        if request.units.len() > 100000 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                METHOD,
                "assertion request exceeds 100000 UTF-16 units",
            ));
        }
        let page = self.page(identifier(&parameters, "page", METHOD)?, METHOD)?;
        let context = self.context(&page.context_identifier, METHOD)?;
        let browser = self.browser(&context.browser_identifier, METHOD)?;
        let frame = identifier(&parameters, "frame", METHOD)?;
        let mut selector = super::locators::FrameSelector::new(
            identifier(&parameters, "page", METHOD)?,
            frame,
            &request.units,
            true,
            Some(true),
        );
        let mut observation = None;
        let result = async {
            let mut attempts = 0;
            loop {
                operation.check()?;
                let result = async {
                    let resolved = self
                        .resolve_frame_selector(&page, &browser, &mut selector, operation, METHOD)
                        .await?;
                    let (realm, units) = match resolved {
                        Some(realm) => (realm, selector.request.as_ref()),
                        None => (
                            self.locator_realm(&page, &browser, frame, operation, METHOD)
                                .await?,
                            selector.missing_request.as_slice(),
                        ),
                    };
                    let current = AssertionRequest {
                        expression: request.expression,
                        is_not: request.is_not,
                        units: Cow::Borrowed(units),
                    };
                    self.assertion_attempt(
                        &page,
                        &browser,
                        &realm,
                        &current,
                        operation,
                        self.resident_assertions && !selector.crosses_frames(),
                    )
                    .await
                }
                .await;
                match result {
                    Ok(result) => match result["status"].as_str() {
                        Some("matched") | Some("observation") => {
                            let current = if result["status"] == "matched" {
                                result["observation"].clone()
                            } else {
                                result
                            };
                            let matches = current["matches"].as_bool().ok_or_else(|| {
                                invalid(METHOD, "assertion omitted boolean outcome")
                            })?;
                            observation = Some(current.clone());
                            if matches != request.is_not {
                                return Ok(current);
                            }
                        }
                        Some("expired") => {
                            if let Some(current) = terminal_observation(&result) {
                                observation = Some(current);
                            }
                            return Err(ErrorRecord::new(
                                ErrorCode::Timeout,
                                METHOD,
                                "assertion deadline exceeded",
                            ));
                        }
                        Some("cancelled") => {
                            // Pagehide retires a document subscription; the public assertion
                            // continues in the successor document under its original deadline.
                            observation = None;
                            page.state.locator_realms.lock().await.remove(frame);
                            operation
                                .wait(browser.connection.synchronize_events())
                                .await?;
                        }
                        Some("limit") => {
                            return Err(ErrorRecord::new(
                                ErrorCode::ResourceLimit,
                                METHOD,
                                "document condition limit exceeded",
                            ));
                        }
                        Some("error") => {
                            let units: Vec<u16> = if result["message"].is_string() {
                                result["message"].as_str().unwrap().encode_utf16().collect()
                            } else {
                                parse(METHOD, result["message"]["units"].clone())?
                            };
                            let mut error = ErrorRecord::new(
                                ErrorCode::Evaluation,
                                METHOD,
                                String::from_utf16_lossy(&units),
                            );
                            error.message_utf16 = Some(units.into_boxed_slice());
                            return Err(error);
                        }
                        _ => {
                            return Err(invalid(
                                METHOD,
                                "resident assertion returned an invalid outcome",
                            ));
                        }
                    },
                    Err(error) if context_was_destroyed(&error) => {
                        observation = None;
                        page.state.locator_realms.lock().await.remove(frame);
                    }
                    Err(error) => return Err(error),
                }
                if self.resident_assertions && !selector.crosses_frames() {
                    tokio::task::yield_now().await;
                } else {
                    let delay = [20, 50, 100][attempts.min(2)];
                    attempts += 1;
                    operation
                        .wait(page.state.while_alive(METHOD, async {
                            sleep(Duration::from_millis(delay)).await;
                            Ok(())
                        }))
                        .await?;
                }
            }
        }
        .await;
        result.map_err(|mut error| {
            if matches!(error.code, ErrorCode::Timeout | ErrorCode::Cancelled)
                && error.diagnostics.is_none()
            {
                error.diagnostics = observation.map(Box::new);
            }
            error
        })
    }

    async fn assertion_attempt(
        &self,
        page: &Page,
        browser: &Arc<Chromium>,
        realm: &LocatorRealm,
        request: &AssertionRequest<'_>,
        operation: &Operation,
        resident: bool,
    ) -> Result<Value, ErrorRecord> {
        let token = self.identifier("assertion");
        let function = if resident {
            "function(request, deadline, expression, isNot, token) { return globalThis.__flashwrightLocatorRuntime.waitForAssertion(request, deadline, expression, isNot, token); }"
        } else {
            "function(request, deadline, expression, isNot) { return globalThis.__flashwrightLocatorRuntime.assertion(request, deadline, expression, isNot); }"
        };
        let mut arguments = json!([
            { "value": request.units }, { "value": operation.renderer_deadline() },
            { "value": request.expression }, { "value": request.is_not },
        ]);
        if resident {
            arguments
                .as_array_mut()
                .unwrap()
                .push(json!({ "value": token }));
        }
        let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
            "uniqueContextId": realm.context.unique_identifier, "functionDeclaration": function, "arguments": arguments,
            "returnByValue": true, "awaitPromise": true,
        }), Some(&page.session_identifier))?;
        match operation
            .wait(page.state.while_alive(METHOD, command.response()))
            .await
        {
            Ok(result) => runtime_value(result),
            Err(mut error)
                if resident && matches!(error.code, ErrorCode::Timeout | ErrorCode::Cancelled) =>
            {
                if command.prevent_dispatch() {
                    error.cleanup = Some("notDispatched".into());
                    return Err(error);
                }
                if let Some(result) = command.try_response() {
                    if let Ok(result) = result.and_then(runtime_value) {
                        error.diagnostics = terminal_observation(&result).map(Box::new);
                    }
                    error.cleanup = Some("residentConditionFinished".into());
                    return Err(error);
                }
                let page = page.clone();
                let browser = browser.clone();
                let realm = realm.clone();
                let mut cleanup = tokio::spawn(async move {
                    cancel_resident_condition(&page, &browser, &realm, &token, command).await
                });
                match timeout(DIAGNOSTIC_CLEANUP_BUDGET, &mut cleanup).await {
                    Ok(Ok((observation, status))) => {
                        error.diagnostics = observation.map(Box::new);
                        error.cleanup = Some(status.into());
                    }
                    Ok(Err(_)) => {
                        error.cleanup = Some("residentCleanupTaskFailed".into());
                    }
                    Err(_) => {
                        error.cleanup = Some("residentCancellationPending".into());
                    }
                }
                Err(error)
            }
            Err(error) => Err(error),
        }
    }
}

fn runtime_value(result: Value) -> Result<Value, ErrorRecord> {
    check_exception(&result, METHOD)?;
    result["result"]
        .get("value")
        .cloned()
        .ok_or_else(|| invalid(METHOD, "Chromium omitted assertion result"))
}

fn terminal_observation(result: &Value) -> Option<Value> {
    let observation = if result["status"] == "observation" {
        result
    } else {
        &result["observation"]
    };
    (observation["status"] == "observation" && observation["matches"].is_boolean())
        .then(|| observation.clone())
}

/// Keep the cancellation command alive after the caller's diagnostic budget. A blocked
/// renderer cannot retain work beyond acknowledgement or its owning page/connection.
async fn cancel_resident_condition(
    page: &Page,
    browser: &Chromium,
    realm: &LocatorRealm,
    token: &str,
    mut original: Command,
) -> (Option<Value>, &'static str) {
    let result = page.state.while_alive(METHOD, async {
        let cancellation = browser.connection.call("Runtime.callFunctionOn", json!({
            "uniqueContextId": realm.context.unique_identifier,
            "functionDeclaration": "function(token) { return globalThis.__flashwrightLocatorRuntime.cancelAssertion(token); }",
            "arguments": [{ "value": token }], "returnByValue": true,
        }), Some(&page.session_identifier)).await?;
        let cancellation = runtime_value(cancellation)?;
        if let Some(observation) = terminal_observation(&cancellation) { return Ok(Some(observation)); }
        // Null means the condition finished before cancellation. Its original terminal
        // reply carries the diagnostic and may still be arriving on the independent reader.
        let result = runtime_value(original.response().await?)?;
        Ok(terminal_observation(&result))
    }).await;
    match result {
        Ok(observation) => (observation, "residentConditionReleased"),
        Err(error)
            if context_was_destroyed(&error)
                || matches!(
                    error.code,
                    ErrorCode::TargetClosed
                        | ErrorCode::BrowserDisconnected
                        | ErrorCode::PageCrashed
                ) =>
        {
            (None, "residentOwnerClosed")
        }
        Err(_) => (
            None,
            dispose(browser, ResourceKind::Page, &page.target_identifier).await,
        ),
    }
}
