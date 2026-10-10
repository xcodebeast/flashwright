//! Document-scoped selector runtimes and host-owned locator deadlines.

use super::*;
use flashwright_protocol::InputDelivery;
use tokio::time::sleep;

mod frame_selector;
mod traced_action;
pub(crate) use frame_selector::FrameSelector;

pub(crate) const LOCATOR_WORLD_NAME: &str = "__flashwright_locator_world__";

const INJECTED_RUNTIME: &str =
    include_str!("../../../packages/resident-runtime/playwright-injected.js");
const ARIA_SNAPSHOT_RUNTIME: &str =
    include_str!("../../../packages/resident-runtime/aria-snapshot.js");
const LOCATOR_RUNTIME: &str = include_str!("../../../packages/resident-runtime/locator-runtime.js");
const FAILURE_CONTEXT_SNAPSHOT: &str =
    include_str!("../../../packages/resident-runtime/failure-context-snapshot.js");
const CONDITION_REGISTRY: &str =
    include_str!("../../../packages/resident-runtime/condition-registry.js");

#[derive(Clone)]
pub(crate) struct LocatorRealm {
    pub loader: String,
    pub context: page_state::ExecutionContext,
    pub main_context: page_state::ExecutionContext,
}

impl Engine {
    pub(crate) async fn run_locator(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        validate_keys(
            "locator.run",
            &parameters,
            &[
                "page", "frame", "action", "request", "pointer", "keyboard", "element",
            ],
        )?;
        let action = identifier(&parameters, "action", "locator.run")?;
        let method = format!("locator.{action}");
        if ["selectText", "scrollIntoViewIfNeeded"].contains(&action) {
            return self
                .run_element_action(&method, parameters, operation)
                .await;
        }
        if parameters.get("element").is_some() {
            return Err(invalid(
                &method,
                "element settings require a captured element operation",
            ));
        }
        if ["press", "pressSequentially"].contains(&action) {
            return self
                .run_locator_keyboard(parameters, operation)
                .await
                .map_err(|mut error| {
                    error.method = method.into();
                    error
                });
        }
        if parameters.get("keyboard").is_some() {
            return Err(invalid(
                &method,
                "keyboard settings require a keyboard operation",
            ));
        }
        if [
            "click",
            "dblclick",
            "hover",
            "check",
            "uncheck",
            "setChecked",
        ]
        .contains(&action)
        {
            return self.run_pointer(parameters, operation).await;
        }
        if parameters.get("pointer").is_some() {
            return Err(invalid(
                &method,
                "pointer settings require a pointer operation",
            ));
        }
        if ![
            "count",
            "allTextContents",
            "allInnerTexts",
            "textContent",
            "innerText",
            "innerHTML",
            "getAttribute",
            "inputValue",
            "isVisible",
            "isHidden",
            "isEnabled",
            "isDisabled",
            "isEditable",
            "isChecked",
            "waitFor",
            "fill",
            "selectOption",
            "focus",
            "blur",
        ]
        .contains(&action)
        {
            return Err(ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                method,
                "locator operation is not implemented",
            ));
        }
        let page = self.page(identifier(&parameters, "page", &method)?, &method)?;
        let context = self.context(&page.context_identifier, &method)?;
        let browser = self.browser(&context.browser_identifier, &method)?;
        let frame = identifier(&parameters, "frame", &method)?;
        let request: Vec<u16> = parse(&method, parameters["request"].clone())?;
        if request.len() > 100000 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "locator request exceeds 100000 UTF-16 units",
            ));
        }
        let list_read = ["count", "allTextContents", "allInnerTexts"].contains(&action);
        let mut selector = FrameSelector::new(
            identifier(&parameters, "page", &method)?,
            frame,
            &request,
            true,
            list_read.then_some(false),
        );
        let mut attempt = 0;
        loop {
            operation.check()?;
            let input_lock = if ["fill", "selectOption", "focus", "blur"].contains(&action) {
                Some(
                    operation
                        .wait(page.state.while_alive(&method, async {
                            Ok(page.state.native_input.lock().await)
                        }))
                        .await?,
                )
            } else {
                None
            };
            let realm = self
                .resolve_frame_selector(&page, &browser, &mut selector, operation, &method)
                .await;
            let result = match realm {
                Ok(Some(realm)) => {
                    if ["fill", "selectOption"].contains(&action)
                        && operation
                            .trace_call()
                            .is_some_and(|trace| trace.recording.is_some())
                    {
                        self.traced_locator_action(
                            identifier(&parameters, "page", &method)?,
                            &page,
                            &browser,
                            &realm,
                            &selector.request,
                            operation,
                            &method,
                        )
                        .await
                    } else {
                        self.locator_attempt(
                            &page,
                            &browser,
                            &realm,
                            &selector.request,
                            action,
                            operation,
                            &method,
                        )
                        .await
                    }
                }
                Ok(None) => match action {
                    "count" => return Ok(json!({"kind":"number","value":0})),
                    "isVisible" | "isHidden" => {
                        return Ok(json!({"kind":"boolean","value":action == "isHidden"}));
                    }
                    "waitFor" if selector.missing_wait_satisfied => {
                        return Ok(json!({"kind":"undefined"}));
                    }
                    "allTextContents" | "allInnerTexts" => {
                        return Err(ErrorRecord::new(
                            ErrorCode::Evaluation,
                            &method,
                            "Failed to find frame for selector",
                        ));
                    }
                    _ => Ok(
                        json!({"status":"retry","reason":{"kind":"string","units":"frame selector resolved to no frame".encode_utf16().collect::<Vec<_>>()}}),
                    ),
                },
                Err(error) => Err(error),
            };
            let reason = match result {
                Ok(result) => match result["status"].as_str() {
                    Some("success") => {
                        if ["fill", "selectOption", "focus", "blur"].contains(&action) {
                            operation.record_input_delivery(InputDelivery::Acknowledged);
                        }
                        return Ok(result["value"].clone());
                    }
                    Some("needsinput") => {
                        self.insert_locator_text(
                            &page,
                            &browser,
                            &result["textUnits"],
                            operation,
                            &method,
                        )
                        .await?;
                        return Ok(json!({ "kind": "undefined" }));
                    }
                    Some("error") => {
                        let units: Vec<u16> = parse(&method, result["message"]["units"].clone())?;
                        let mut error = ErrorRecord::new(
                            ErrorCode::Evaluation,
                            &method,
                            String::from_utf16_lossy(&units),
                        );
                        error.message_utf16 = Some(units.into_boxed_slice());
                        return Err(error);
                    }
                    Some("retry") => retry_reason(&result, &method)?,
                    Some("expired") => {
                        return Err(ErrorRecord::new(
                            ErrorCode::Timeout,
                            method,
                            "operation deadline exceeded before renderer dispatch",
                        ));
                    }
                    _ => {
                        return Err(ErrorRecord::new(
                            ErrorCode::Protocol,
                            &method,
                            "resident runtime returned an invalid outcome",
                        ));
                    }
                },
                Err(error)
                    if context_was_destroyed(&error)
                        && matches!(error.input_delivery, InputDelivery::NotDispatched) =>
                {
                    page.state.locator_realms.lock().await.remove(frame);
                    "document changed while resolving the locator".to_owned()
                }
                Err(error) => return Err(error),
            };
            drop(input_lock);
            let delay = [20, 50, 100][attempt.min(2)];
            attempt += 1;
            let result = operation
                .wait(page.state.while_alive(&method, async {
                    sleep(Duration::from_millis(delay)).await;
                    Ok(())
                }))
                .await;
            if let Err(mut error) = result {
                error.method = method.into();
                error.message = format!("{}; last observation: {reason}", error.message).into();
                return Err(error);
            }
        }
    }

    /// Initialize once per frame document; concurrent operations share this initialization only.
    pub(crate) async fn locator_realm(
        &self,
        page: &Page,
        browser: &Chromium,
        frame_identifier: &str,
        operation: &Operation,
        method: &str,
    ) -> Result<LocatorRealm, ErrorRecord> {
        let main_context = self
            .evaluation_context(page, browser, Some(frame_identifier), operation)
            .await?;
        let mut realms = operation
            .wait(async { Ok(page.state.locator_realms.lock().await) })
            .await?;
        let loader = {
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            realms.retain(|identifier, realm| {
                state
                    .frames
                    .get(identifier)
                    .is_some_and(|frame| frame.loader == realm.loader)
                    && state.main_worlds.get(identifier) == Some(&realm.main_context)
                    && state.context_is_alive(&realm.context)
            });
            if state.main_worlds.get(frame_identifier) != Some(&main_context) {
                return Err(evaluation::context_destroyed());
            }
            let frame = state
                .frames
                .get(frame_identifier)
                .ok_or_else(|| closed(method))?;
            if frame.remote {
                return Err(ErrorRecord::new(
                    ErrorCode::UnsupportedFeature,
                    method,
                    "out-of-process frame routing is not implemented",
                ));
            }
            frame.loader.clone()
        };
        if let Some(realm) = realms.get(frame_identifier) {
            return Ok(realm.clone());
        }
        let created = operation
            .wait(page.state.while_alive(
                method,
                browser.connection.call(
                    "Page.createIsolatedWorld",
                    json!({ "frameId": frame_identifier, "worldName": LOCATOR_WORLD_NAME }),
                    Some(&main_context.session_identifier),
                ),
            ))
            .await?;
        let context_identifier = created["executionContextId"]
            .as_u64()
            .ok_or_else(|| invalid(method, "Chromium omitted isolated context identity"))?;
        let context = page
            .state
            .state
            .lock()
            .unwrap()
            .execution_contexts
            .get(&(main_context.session_identifier.clone(), context_identifier))
            .filter(|context| context.frame_identifier == frame_identifier)
            .cloned()
            .ok_or_else(evaluation::context_destroyed)?;
        let realm = LocatorRealm {
            loader,
            context,
            main_context,
        };
        if !super::element_resolution::same_document(page, &realm, &realm.main_context) {
            return Err(evaluation::context_destroyed());
        }
        let expression = format!(
            "(() => {{ if (globalThis.__flashwrightLocatorRuntime) return true; const module = {{}}; {INJECTED_RUNTIME}; const exports = {{}}; {VALUE_CODEC}; {CONDITION_REGISTRY}; {FAILURE_CONTEXT_SNAPSHOT}; {ARIA_SNAPSHOT_RUNTIME}; {LOCATOR_RUNTIME}; const injected = new (module.exports.InjectedScript())(globalThis, {{isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:1,browserName:'chromium',shouldPrependErrorPrefix:false,isUtilityWorld:true,customEngines:[]}}); Object.defineProperty(globalThis, '__flashwrightLocatorRuntime', {{value:createLocatorRuntime(injected, exports.createValueCodec(), {{conditionInstrumentation:{}}})}}); return true; }})()",
            self.condition_instrumentation,
        );
        let initialized = operation.wait(page.state.while_alive(method, browser.connection.call(
            "Runtime.evaluate", json!({ "expression": expression, "uniqueContextId": realm.context.unique_identifier, "returnByValue": true }), Some(&realm.context.session_identifier),
        ))).await?;
        check_exception(&initialized, method)?;
        if !super::element_resolution::same_document(page, &realm, &realm.main_context) {
            return Err(evaluation::context_destroyed());
        }
        realms.insert(frame_identifier.to_owned(), realm.clone());
        Ok(realm)
    }

    #[allow(clippy::too_many_arguments)]
    async fn locator_attempt(
        &self,
        page: &Page,
        browser: &Chromium,
        realm: &LocatorRealm,
        request: &[u16],
        action: &str,
        operation: &Operation,
        method: &str,
    ) -> Result<Value, ErrorRecord> {
        if ["fill", "selectOption", "focus", "blur"].contains(&action) {
            page.trace_before_input(operation);
        }
        let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
            "uniqueContextId": realm.context.unique_identifier, "functionDeclaration": "function(request, deadline) { return globalThis.__flashwrightLocatorRuntime.run(request, deadline); }",
            "arguments": [{ "value": request }, { "value": operation.renderer_deadline() }], "returnByValue": true, "awaitPromise": true,
            "userGesture": true,
        }), Some(&realm.context.session_identifier))?;
        let result = operation
            .wait(page.state.while_alive(method, command.response()))
            .await;
        let result = result.map_err(|mut error| {
            if ["fill", "selectOption", "focus", "blur"].contains(&action)
                && !context_was_not_found(&error)
                && !command.prevent_dispatch()
            {
                error.input_delivery = InputDelivery::Uncertain;
            }
            error.method = method.into();
            error
        })?;
        check_exception(&result, method)?;
        result["result"]
            .get("value")
            .cloned()
            .ok_or_else(|| invalid(method, "Chromium omitted locator result"))
    }

    async fn insert_locator_text(
        &self,
        page: &Page,
        browser: &Chromium,
        text_units: &Value,
        operation: &Operation,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        let units: Vec<u16> = parse(method, text_units.clone())?;
        let text = String::from_utf16(&units).map_err(|_| {
            ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                method,
                "native text input containing unpaired UTF-16 surrogates is not implemented",
            )
        })?;
        if !text.is_empty() {
            return input_command(
                page,
                browser,
                "Input.insertText",
                json!({ "text": text }),
                operation,
                method,
            )
            .await;
        }
        let mut key_down_acknowledged = false;
        let result = async {
            input_command(page, browser, "Input.dispatchKeyEvent", json!({ "type": "rawKeyDown", "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46 }), operation, method).await?;
            key_down_acknowledged = true;
            input_command(page, browser, "Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46 }), operation, method).await
        }.await;
        if let Err(mut error) = result {
            if key_down_acknowledged && matches!(error.input_delivery, InputDelivery::NotDispatched)
            {
                error.input_delivery = InputDelivery::Acknowledged;
            }
            if !matches!(error.input_delivery, InputDelivery::NotDispatched) {
                let released = timeout(Duration::from_millis(500), browser.connection.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46 }), Some(&page.session_identifier))).await;
                error.cleanup = Some(if matches!(released, Ok(Ok(_))) {
                    "keyboardReleased".into()
                } else {
                    dispose(browser, ResourceKind::Page, &page.target_identifier)
                        .await
                        .into()
                });
            }
            return Err(error);
        }
        Ok(())
    }
}

async fn input_command(
    page: &Page,
    browser: &Chromium,
    command_method: &str,
    parameters: Value,
    operation: &Operation,
    method: &str,
) -> Result<(), ErrorRecord> {
    super::input::dispatch_input(page, browser, command_method, parameters, operation, method)
        .await
        .result
}

/// Recognize native retirement evidence without retrying an application-thrown lookalike.
pub(crate) fn context_was_destroyed(error: &ErrorRecord) -> bool {
    error.execution_context_destroyed
        || context_was_not_found(error)
        || error.browser_error_code.is_some()
            && [
                "Cannot find context",
                "Execution context was destroyed",
                "Cannot find object with given id",
                "Inspected target navigated or closed",
                "No frame for given id",
            ]
            .iter()
            .any(|message| error.message.contains(message))
}

/// A rejected context lookup proves that Chromium never entered the requested function.
fn context_was_not_found(error: &ErrorRecord) -> bool {
    (error.browser_error_code == Some(-32602)
        && error.message.contains("uniqueContextId not found"))
        || (error.browser_error_code == Some(-32000)
            && error
                .message
                .contains("Cannot find context with specified id"))
}

pub(crate) fn check_exception(result: &Value, method: &str) -> Result<(), ErrorRecord> {
    if let Some(exception) = result.get("exceptionDetails") {
        return Err(ErrorRecord::new(
            ErrorCode::Evaluation,
            method,
            exception["exception"]["description"]
                .as_str()
                .or_else(|| exception["text"].as_str())
                .unwrap_or("resident runtime failed"),
        ));
    }
    Ok(())
}

/// Browser diagnostic strings use the same UTF-16 boundary as selector and value strings.
pub(crate) fn retry_reason(result: &Value, method: &str) -> Result<String, ErrorRecord> {
    let units: Vec<u16> = parse(method, result["reason"]["units"].clone())?;
    Ok(char::decode_utf16(units)
        .map(|unit| match unit {
            Ok(character) => character.to_string(),
            Err(error) => format!("\\u{:04X}", error.unpaired_surrogate()),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_worlds_are_distinct_from_application_errors_and_other_protocol_failures() {
        let native = evaluation::context_destroyed();
        assert!(context_was_destroyed(&native));
        let application = ErrorRecord::new(
            ErrorCode::Evaluation,
            "page.evaluate",
            native.message.to_string(),
        );
        assert!(!context_was_destroyed(&application));
        let transmitted = serde_json::to_value(&native).unwrap();
        assert!(transmitted.get("executionContextDestroyed").is_none());
        assert!(!context_was_destroyed(
            &serde_json::from_value(transmitted).unwrap()
        ));

        let mut browser = ErrorRecord::new(
            ErrorCode::Protocol,
            "chromium",
            r#"{"code":-32602,"message":"uniqueContextId not found"}"#,
        );
        assert!(!context_was_destroyed(&browser));
        browser.browser_error_code = Some(-32602);
        assert!(context_was_destroyed(&browser));
        assert!(context_was_not_found(&browser));
        browser.message = "Invalid parameters for uniqueContextId".into();
        assert!(!context_was_destroyed(&browser));
        browser.browser_error_code = Some(-32000);
        browser.message = "Cannot find context with specified id".into();
        assert!(context_was_destroyed(&browser));
        assert!(context_was_not_found(&browser));
        browser.message = "Execution context was destroyed".into();
        assert!(context_was_destroyed(&browser));
        assert!(!context_was_not_found(&browser));
    }
}
