//! Captured-node actions share one deadline and privately own utility-world references.

use super::element_resolution::same_document;
use super::handle_values::{DescribedNode, ResolvedNode};
use super::handles::{Handle, HandleAllocation};
use super::locators::{LocatorRealm, check_exception, context_was_destroyed, retry_reason};
use super::*;
use flashwright_protocol::InputDelivery;
use tokio::time::sleep;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ElementOptions {
    #[serde(default)]
    force: bool,
}

struct ElementAction {
    method: String,
    action: &'static str,
    page_identifier: String,
    frame: String,
    force: bool,
    request: Option<Vec<u16>>,
    handle: Option<Handle>,
}

impl Engine {
    /// Resolve locators only until capture; a captured or borrowed node never rebinds to a replacement.
    pub(crate) async fn run_element_action(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let locator = method.starts_with("locator.");
        let action = if method.ends_with(".selectText") {
            "selectText"
        } else {
            "scrollIntoViewIfNeeded"
        };
        let force = if locator {
            if parameters.get("keyboard").is_some() || parameters.get("pointer").is_some() {
                return Err(invalid(
                    method,
                    "captured element actions do not accept keyboard or pointer settings",
                ));
            }
            if action == "scrollIntoViewIfNeeded" {
                validate_keys(method, &parameters["element"], &[])?;
            }
            parse::<ElementOptions>(method, parameters["element"].clone())?.force
        } else {
            validate_keys(
                method,
                &parameters,
                if action == "selectText" {
                    &["page", "handle", "force"]
                } else {
                    &["page", "handle"]
                },
            )?;
            parameters
                .get("force")
                .map(|value| parse::<bool>(method, value.clone()))
                .transpose()?
                .unwrap_or(false)
        };
        let request: Option<Vec<u16>> = if locator {
            Some(parse(method, parameters["request"].clone())?)
        } else {
            None
        };
        if request
            .as_ref()
            .is_some_and(|request| request.len() > 100000)
        {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "locator request exceeds 100000 UTF-16 units",
            ));
        }
        let page_identifier = identifier(&parameters, "page", method)?.to_owned();
        let page = self.page(&page_identifier, method)?;
        let handle = if locator {
            None
        } else {
            Some(self.owned_handle(&page, identifier(&parameters, "handle", method)?, method)?)
        };
        if handle.as_ref().is_some_and(|handle| !handle.element) {
            return Err(invalid(method, "expected an ElementHandle"));
        }
        let frame = match &handle {
            Some(handle) => handle.context.frame_identifier.clone(),
            None => identifier(&parameters, "frame", method)?.to_owned(),
        };
        let settings = ElementAction {
            method: method.into(),
            action,
            page_identifier,
            frame,
            force,
            request,
            handle,
        };
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let mut attempts = 0;
        loop {
            operation.check()?;
            let (captured, result) = self
                .element_action_attempt(&page, &browser, &settings, operation)
                .await;
            match result {
                Ok(Value::Bool(false)) => {}
                Ok(_) => {
                    return Ok(if locator {
                        json!({ "kind": "undefined" })
                    } else {
                        Value::Null
                    });
                }
                Err(error) if !captured && context_was_destroyed(&error) => {
                    page.state
                        .locator_realms
                        .lock()
                        .await
                        .remove(&settings.frame);
                }
                Err(mut error) => {
                    error.method = method.into();
                    error.input_delivery = error.input_delivery.max(operation.input_delivery());
                    return Err(error);
                }
            }
            wait_for_retry(&page, operation, method, attempts).await?;
            attempts += 1;
        }
    }

    /// Every allocating reply stays owned through cancellation, including aliases of borrowed handles.
    async fn element_action_attempt(
        &self,
        page: &Page,
        browser: &Chromium,
        settings: &ElementAction,
        operation: &Operation,
    ) -> (bool, Result<Value, ErrorRecord>) {
        let mut captured = settings.handle.is_some();
        let result = async {
            if settings.handle.is_none() {
                page.wait_for_input_navigation(0, operation, &settings.method).await?;
            }
            let realm = self.locator_realm(page, browser, &settings.frame, operation, &settings.method).await?;
            let context = match &settings.handle {
                Some(handle) => handle.context.clone(),
                None => self.evaluation_context(page, browser, Some(&settings.frame), operation).await?,
            };
            if !same_document(page, &realm, &context) {
                return if captured { Err(evaluation::context_destroyed()) } else { Ok(Value::Bool(false)) };
            }
            let allocation = HandleAllocation { engine: self, page_identifier: &settings.page_identifier, page, browser, context, operation,
                method: &settings.method, group: self.identifier("element-action-group"), uses_object_group: true };
            let result = async {
                let object_identifier = if let Some(handle) = &settings.handle {
                    let mut command = browser.connection.start_raw_command("DOM.describeNode", json!({ "objectId": handle.object_identifier }), Some(&page.session_identifier))?;
                    let response = allocation.wait(&mut command, false).await?;
                    let described: DescribedNode = serde_json::from_str(response.get()).map_err(|error| invalid(&settings.method, &error.to_string()))?;
                    let mut command = browser.connection.start_raw_command("DOM.resolveNode", json!({
                        "backendNodeId": described.node.backend_node_id, "executionContextId": realm.context.identifier, "objectGroup": allocation.group,
                    }), Some(&page.session_identifier))?;
                    let response = allocation.wait(&mut command, false).await?;
                    let resolved: ResolvedNode = serde_json::from_str(response.get()).map_err(|error| invalid(&settings.method, &error.to_string()))?;
                    if resolved.object.subtype.as_deref() != Some("node") { return Err(detached(&settings.method)); }
                    resolved.object.object_id.ok_or_else(|| invalid(&settings.method, "Chromium omitted the utility element identity"))?
                } else {
                    let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
                        "uniqueContextId": realm.context.unique_identifier,
                        "functionDeclaration": "function(request, deadline) { return globalThis.__flashwrightLocatorRuntime.resolveLocatorElement(request, deadline); }",
                        "arguments": [{ "value": settings.request }, { "value": operation.renderer_deadline() }],
                        "objectGroup": allocation.group, "returnByValue": false,
                    }), Some(&page.session_identifier))?;
                    let response = allocation.wait(&mut command, true).await?;
                    let value = allocation.evaluation_value(&response).await?;
                    if value.primitive(&settings.method)? == Some(json!({ "kind": "boolean", "value": false })) { return Ok(Value::Bool(false)); }
                    if value.subtype.as_deref() != Some("node") { return Err(invalid(&settings.method, "resident resolver did not return a DOM node")); }
                    value.object_id.ok_or_else(|| invalid(&settings.method, "resident resolver omitted the element identity"))?
                };
                captured = true;
                if !same_document(page, &realm, &allocation.context) { return Err(evaluation::context_destroyed()); }
                perform_action(&allocation, &realm, &object_identifier, settings).await?;
                Ok(Value::Null)
            }.await;
            match allocation.finish(result).await {
                Ok(value) => {
                    let cleanup = allocation.rollback().await;
                    if !["handleGroupDisposed", "handleContextDestroyed"].contains(&cleanup) { return Err(closed(&settings.method)); }
                    Ok(value)
                }
                Err(error) if !captured && !same_document(page, &realm, &allocation.context) && matches!(error.code, ErrorCode::Evaluation) => Ok(Value::Bool(false)),
                Err(error) => Err(error),
            }
        }.await;
        (captured, result)
    }
}

/// Release input ownership between read-only retries so another action can reveal the captured node.
async fn perform_action(
    allocation: &HandleAllocation<'_>,
    realm: &LocatorRealm,
    object_identifier: &str,
    settings: &ElementAction,
) -> Result<(), ErrorRecord> {
    let mut attempts = 0;
    loop {
        if !settings.force {
            allocation
                .page
                .wait_for_input_navigation(0, allocation.operation, &settings.method)
                .await?;
        }
        let input_lock = allocation
            .operation
            .wait(
                allocation
                    .page
                    .state
                    .while_execution_context(&allocation.context, async {
                        Ok(allocation.page.state.native_input.lock().await)
                    }),
            )
            .await?;
        let outcome = prepare_action(allocation, realm, object_identifier, settings).await?;
        let reason = match outcome["status"].as_str() {
            Some("success") => {
                allocation
                    .operation
                    .record_input_delivery(InputDelivery::Acknowledged);
                return Ok(());
            }
            Some("ready") => {
                if scroll_element(allocation, object_identifier).await? {
                    return Ok(());
                }
                "element has no layout object".to_owned()
            }
            Some("retry") => retry_reason(&outcome, &settings.method)?,
            Some("detached") => return Err(detached(&settings.method)),
            Some("expired") => {
                return Err(ErrorRecord::new(
                    ErrorCode::Timeout,
                    &settings.method,
                    "operation deadline exceeded before renderer dispatch",
                ));
            }
            Some("resourceLimit") => {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    &settings.method,
                    "too many retained element action attempts",
                ));
            }
            Some("error") => {
                let units: Vec<u16> = parse(&settings.method, outcome["message"]["units"].clone())?;
                let mut error = ErrorRecord::new(
                    ErrorCode::Evaluation,
                    &settings.method,
                    String::from_utf16_lossy(&units),
                );
                error.message_utf16 = Some(units.into_boxed_slice());
                return Err(error);
            }
            _ => {
                return Err(ErrorRecord::new(
                    ErrorCode::Protocol,
                    &settings.method,
                    "invalid captured element outcome",
                ));
            }
        };
        drop(input_lock);
        wait_for_retry(
            allocation.page,
            allocation.operation,
            &settings.method,
            attempts,
        )
        .await
        .map_err(|mut error| {
            error.message = format!("{}; last observation: {reason}", error.message).into();
            error
        })?;
        attempts += 1;
    }
}

/// Cancel a pending frame callback before generic recovery, preserving a healthy renderer when possible.
async fn prepare_action(
    allocation: &HandleAllocation<'_>,
    realm: &LocatorRealm,
    object_identifier: &str,
    settings: &ElementAction,
) -> Result<Value, ErrorRecord> {
    allocation.operation.check()?;
    if settings.action == "selectText" {
        allocation.page.trace_before_input(allocation.operation);
    }
    let token = allocation.engine.identifier("element-action");
    let mut command = allocation.browser.connection.start_command("Runtime.callFunctionOn", json!({
        "objectId": object_identifier,
        "functionDeclaration": "function(action, force, deadline, token) { return globalThis.__flashwrightLocatorRuntime.prepareElementAction(this, action, force, deadline, token); }",
        "arguments": [{ "value": settings.action }, { "value": settings.force }, { "value": allocation.operation.renderer_deadline() }, { "value": token }],
        "objectGroup": allocation.group, "returnByValue": true, "awaitPromise": true, "userGesture": true,
    }), Some(&allocation.page.session_identifier))?;
    let result = allocation
        .operation
        .wait(
            allocation
                .page
                .state
                .while_execution_context(&allocation.context, command.response()),
        )
        .await;
    let response = match result {
        Ok(response) => response,
        Err(mut error) => {
            let dispatched = !command.prevent_dispatch();
            if dispatched && settings.action == "selectText" {
                allocation
                    .operation
                    .record_input_delivery(InputDelivery::Uncertain);
            }
            if dispatched && matches!(error.code, ErrorCode::Timeout | ErrorCode::Cancelled) {
                let cancelled = timeout(Duration::from_millis(250), allocation.browser.connection.call("Runtime.callFunctionOn", json!({
                    "uniqueContextId": realm.context.unique_identifier,
                    "functionDeclaration": "function(token) { return globalThis.__flashwrightLocatorRuntime.cancelElementAction(token); }",
                    "arguments": [{ "value": token }], "objectGroup": allocation.group, "returnByValue": true,
                }), Some(&allocation.page.session_identifier))).await;
                let cancellation_completed = matches!(cancelled, Ok(Ok(_)));
                if let Err(mut recovery) =
                    allocation.wait(&mut command, !cancellation_completed).await
                {
                    error.cleanup = recovery.cleanup.take();
                }
            }
            error.input_delivery = error
                .input_delivery
                .max(allocation.operation.input_delivery());
            return Err(error);
        }
    };
    check_exception(&response, &settings.method).inspect_err(|_| {
        if settings.action == "selectText" {
            allocation
                .operation
                .record_input_delivery(InputDelivery::Uncertain);
        }
    })?;
    if settings.action == "selectText" && response["result"]["value"]["status"] == "error" {
        allocation
            .operation
            .record_input_delivery(InputDelivery::Uncertain);
    }
    Ok(response["result"]["value"].clone())
}

/// Retry only a definitive no-layout rejection; a lost scroll reply is never replayed.
async fn scroll_element(
    allocation: &HandleAllocation<'_>,
    object_identifier: &str,
) -> Result<bool, ErrorRecord> {
    allocation.operation.check()?;
    allocation.page.trace_before_input(allocation.operation);
    let mut command = allocation.browser.connection.start_command(
        "DOM.scrollIntoViewIfNeeded",
        json!({ "objectId": object_identifier }),
        Some(&allocation.page.session_identifier),
    )?;
    match allocation.wait(&mut command, false).await {
        Ok(_) => {
            allocation
                .operation
                .record_input_delivery(InputDelivery::Acknowledged);
            Ok(true)
        }
        Err(error) if error.message.contains("Node does not have a layout object") => Ok(false),
        Err(error) if error.message.contains("Node is detached from document") => {
            Err(detached(allocation.method))
        }
        Err(mut error) => {
            if !command.prevent_dispatch() {
                allocation
                    .operation
                    .record_input_delivery(InputDelivery::Uncertain);
            }
            error.input_delivery = error
                .input_delivery
                .max(allocation.operation.input_delivery());
            Err(error)
        }
    }
}

fn detached(method: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Evaluation,
        method,
        "Element is not attached to the DOM",
    )
}

async fn wait_for_retry(
    page: &Page,
    operation: &Operation,
    method: &str,
    attempts: usize,
) -> Result<(), ErrorRecord> {
    operation
        .wait(page.state.while_alive(method, async {
            sleep(Duration::from_millis([20, 50, 100][attempts.min(2)])).await;
            Ok(())
        }))
        .await
}
