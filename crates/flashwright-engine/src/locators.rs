//! Document-scoped selector runtimes and host-owned locator deadlines.

use super::*;
use flashwright_protocol::InputDelivery;
use tokio::time::sleep;

const INJECTED_RUNTIME: &str =
    include_str!("../../../packages/resident-runtime/playwright-injected.js");
const LOCATOR_RUNTIME: &str = include_str!("../../../packages/resident-runtime/locator-runtime.js");
const CONDITION_REGISTRY: &str =
    include_str!("../../../packages/resident-runtime/condition-registry.js");

#[derive(Clone)]
pub(crate) struct LocatorRealm {
    loader: String,
    pub context: u64,
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
            &["page", "frame", "action", "request", "pointer", "keyboard"],
        )?;
        let action = identifier(&parameters, "action", "locator.run")?;
        let method = format!("locator.{action}");
        if action == "press" {
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
                .locator_realm(&page, &browser, frame, operation, &method)
                .await;
            let result = match realm {
                Ok(realm) => {
                    self.locator_attempt(
                        &page, &browser, &realm, &request, action, operation, &method,
                    )
                    .await
                }
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
            });
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
        let created = operation.wait(page.state.while_alive(method, browser.connection.call(
            "Page.createIsolatedWorld", json!({ "frameId": frame_identifier, "worldName": "__flashwright_locator_world__" }), Some(&page.session_identifier),
        ))).await?;
        let context = created["executionContextId"]
            .as_u64()
            .ok_or_else(|| invalid(method, "Chromium omitted isolated context identity"))?;
        let expression = format!(
            "(() => {{ if (globalThis.__flashwrightLocatorRuntime) return true; const module = {{}}; {INJECTED_RUNTIME}; const exports = {{}}; {VALUE_CODEC}; {CONDITION_REGISTRY}; {LOCATOR_RUNTIME}; const injected = new (module.exports.InjectedScript())(globalThis, {{isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:1,browserName:'chromium',shouldPrependErrorPrefix:false,isUtilityWorld:true,customEngines:[]}}); Object.defineProperty(globalThis, '__flashwrightLocatorRuntime', {{value:createLocatorRuntime(injected, exports.createValueCodec(), {{conditionInstrumentation:{}}})}}); return true; }})()",
            self.condition_instrumentation,
        );
        let initialized = operation.wait(page.state.while_alive(method, browser.connection.call(
            "Runtime.evaluate", json!({ "expression": expression, "contextId": context, "returnByValue": true }), Some(&page.session_identifier),
        ))).await?;
        check_exception(&initialized, method)?;
        let realm = LocatorRealm { loader, context };
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
        let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
            "executionContextId": realm.context, "functionDeclaration": "function(request, deadline) { return globalThis.__flashwrightLocatorRuntime.run(request, deadline); }",
            "arguments": [{ "value": request }, { "value": operation.renderer_deadline() }], "returnByValue": true, "awaitPromise": true,
            "userGesture": true,
        }), Some(&page.session_identifier))?;
        let result = operation
            .wait(page.state.while_alive(method, command.response()))
            .await;
        let result = result.map_err(|mut error| {
            if ["fill", "selectOption", "focus", "blur"].contains(&action)
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

pub(crate) fn context_was_destroyed(error: &ErrorRecord) -> bool {
    error.browser_error_code.is_some()
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
