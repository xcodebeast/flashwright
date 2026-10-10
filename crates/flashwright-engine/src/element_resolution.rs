//! Selector waits publish main-world nodes only after their original document survives adoption.

use super::handle_values::{DescribedNode, ResolvedNode};
use super::handles::HandleAllocation;
use super::locators::{LocatorRealm, context_was_destroyed};
use super::page_state::ExecutionContext;
use super::*;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::sleep;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ElementRequest {
    page: String,
    frame: String,
    selector: Vec<u16>,
    strict: bool,
    state: String,
}

impl Engine {
    /// Retry selector observation, never a caller's evaluation or an already published handle.
    pub(super) async fn wait_for_selector(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "frame.waitForSelector";
        let request: ElementRequest = parse(method, parameters)?;
        if !["attached", "detached", "visible", "hidden"].contains(&request.state.as_str()) {
            return Err(invalid(
                method,
                "state must be attached, detached, visible or hidden",
            ));
        }
        if request.selector.len() > 100000 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "selector exceeds 100000 UTF-16 units",
            ));
        }
        let page = self.page(&request.page, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let mut selector = super::locators::FrameSelector::new(
            &request.page,
            &request.frame,
            &request.selector,
            false,
            Some(request.strict),
        );
        let mut reservation = if ["attached", "visible"].contains(&request.state.as_str()) {
            Some(self.reserve_handle(&page, method)?)
        } else {
            None
        };
        let mut attempt = 0;
        loop {
            operation.check()?;
            page.wait_for_input_navigation(0, operation, method).await?;
            if reservation.is_none() && ["attached", "visible"].contains(&request.state.as_str()) {
                reservation = Some(self.reserve_handle(&page, method)?);
            }
            let realm = self
                .resolve_frame_selector(&page, &browser, &mut selector, operation, method)
                .await;
            let result = match realm {
                Ok(Some(realm)) => {
                    self.resolve_element_attempt(
                        &page,
                        &browser,
                        &realm,
                        &request,
                        &selector.request,
                        &mut reservation,
                        operation,
                    )
                    .await
                }
                Ok(None) if ["hidden", "detached"].contains(&request.state.as_str()) => {
                    return Ok(json!({"page":request.page,"handles":[]}));
                }
                Ok(None) => Ok(Value::Bool(false)),
                Err(error) => Err(error),
            };
            match result {
                Ok(value) if value != Value::Bool(false) => return Ok(value),
                Ok(_) => {}
                Err(error) if context_was_destroyed(&error) => {
                    page.state
                        .locator_realms
                        .lock()
                        .await
                        .remove(&request.frame);
                }
                Err(mut error) => {
                    error.method = method.into();
                    return Err(error);
                }
            }
            let delay = [20, 50, 100][attempt.min(2)];
            attempt += 1;
            operation
                .wait(page.state.while_alive(method, async {
                    sleep(Duration::from_millis(delay)).await;
                    Ok(())
                }))
                .await?;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn resolve_element_attempt(
        &self,
        page: &Page,
        browser: &Chromium,
        realm: &LocatorRealm,
        request: &ElementRequest,
        selector: &[u16],
        reservation: &mut Option<OwnedSemaphorePermit>,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "frame.waitForSelector";
        let context = realm.main_context.clone();
        if !same_document(page, realm, &context) {
            return Ok(Value::Bool(false));
        }
        let allocation = HandleAllocation {
            engine: self,
            page_identifier: &request.page,
            page,
            browser,
            context,
            operation,
            method,
            group: self.identifier("handle-group"),
            uses_object_group: true,
        };
        let result = async {
            operation.check()?;
            let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
                "uniqueContextId": realm.context.unique_identifier,
                "functionDeclaration": "function(selector, strict, state, deadline) { return globalThis.__flashwrightLocatorRuntime.resolveElement(selector, strict, state, deadline); }",
                "arguments": [{ "value": selector }, { "value": request.strict }, { "value": request.state }, { "value": operation.renderer_deadline() }],
                "objectGroup": allocation.group, "returnByValue": false,
            }), Some(&page.session_identifier))?;
            let response = allocation.wait(&mut command, true).await?;
            let element = allocation.evaluation_value(&response).await?;
            if element.object_id.is_none() {
                return match element.primitive(method)? {
                    Some(value) if value == json!({"kind":"boolean", "value":false}) => Ok(Value::Bool(false)),
                    Some(value) if value == json!({"kind":"null"}) => Ok(Value::Null),
                    _ => Err(invalid(method, "resident resolver returned an invalid outcome")),
                };
            }
            if element.subtype.as_deref() != Some("node") {
                return Err(invalid(method, "resident resolver did not return a DOM node"));
            }
            let isolated_identifier = element.object_id.as_ref().unwrap();
            let mut describe = browser.connection.start_raw_command("DOM.describeNode", json!({ "objectId": isolated_identifier }), Some(&page.session_identifier))?;
            let description = allocation.wait(&mut describe, false).await?;
            let description: DescribedNode = serde_json::from_str(description.get()).map_err(|error| invalid(method, &error.to_string()))?;
            if !same_document(page, realm, &allocation.context) { return Ok(Value::Bool(false)); }
            let mut adopt = browser.connection.start_raw_command("DOM.resolveNode", json!({
                "backendNodeId": description.node.backend_node_id,
                "executionContextId": allocation.context.identifier, "objectGroup": allocation.group,
            }), Some(&page.session_identifier))?;
            let adopted = allocation.wait(&mut adopt, false).await?;
            let adopted: ResolvedNode = serde_json::from_str(adopted.get()).map_err(|error| invalid(method, &error.to_string()))?;
            if adopted.object.subtype.as_deref() == Some("null") {
                return Ok(Value::Bool(false));
            }
            if adopted.object.subtype.as_deref() != Some("node") || adopted.object.object_id.is_none() {
                return Err(invalid(method, "Chromium omitted the adopted DOM node"));
            }
            let mut release = browser.connection.start_command("Runtime.releaseObject", json!({ "objectId": isolated_identifier }), Some(&page.session_identifier))?;
            allocation.wait(&mut release, false).await?;
            if !same_document(page, realm, &allocation.context) { return Ok(Value::Bool(false)); }
            let handle = allocation.retain(adopted.object, reservation.take().ok_or_else(|| invalid(method, "element resolution has no handle reservation"))?)?;
            Ok(json!({ "page": request.page, "group": allocation.group, "handles": [handle] }))
        }.await;
        let result = allocation.finish(result).await;
        let context_survived = same_document(page, realm, &allocation.context);
        match result {
            Ok(value) if value == Value::Bool(false) || value.is_null() => {
                let cleanup = allocation.rollback().await;
                if !["handleGroupDisposed", "handleContextDestroyed"].contains(&cleanup) {
                    return Err(closed(method));
                }
                Ok(if value.is_null() {
                    json!({ "page": request.page, "handles": [] })
                } else {
                    value
                })
            }
            Err(error) if !context_survived && matches!(error.code, ErrorCode::Evaluation) => {
                Ok(Value::Bool(false))
            }
            result => result,
        }
    }
}

/// Both worlds must still describe one document; a reused numeric context ID is insufficient.
pub(crate) fn same_document(page: &Page, realm: &LocatorRealm, context: &ExecutionContext) -> bool {
    let state = page.state.state.lock().unwrap();
    state.failure.is_none()
        && state.context_is_alive(context)
        && state.context_is_alive(&realm.context)
        && state.main_worlds.get(&context.frame_identifier) == Some(&realm.main_context)
        && (context == &realm.main_context || context == &realm.context)
        && state
            .frames
            .get(&context.frame_identifier)
            .is_some_and(|frame| frame.loader == realm.loader)
}
