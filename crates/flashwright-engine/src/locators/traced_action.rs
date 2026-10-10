//! Traced actions retain one target across capture, then recheck it before mutation or keyboard focus.

use super::*;
use crate::element_resolution::same_document;
use crate::handles::HandleAllocation;
use crate::recording::SnapshotPhase;
use crate::snapshots::SnapshotNode;

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn traced_locator_action(
        &self,
        page_identifier: &str,
        page: &Page,
        browser: &Chromium,
        realm: &LocatorRealm,
        request: &[u16],
        operation: &Operation,
        method: &str,
    ) -> Result<Value, ErrorRecord> {
        let _reservation = self.reserve_handle(page, method)?;
        let allocation = HandleAllocation {
            engine: self,
            page_identifier,
            page,
            browser,
            context: realm.context.clone(),
            operation,
            method,
            group: self.identifier("locator-action"),
            uses_object_group: true,
        };
        let result = async {
            let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
                "uniqueContextId": realm.context.unique_identifier,
                "functionDeclaration": "function(request, deadline) { return globalThis.__flashwrightLocatorRuntime.resolveActionElement(request, deadline); }",
                "arguments": [{"value":request}, {"value":operation.renderer_deadline()}],
                "objectGroup": allocation.group, "returnByValue": false, "awaitPromise": true,
            }), Some(&realm.context.session_identifier))?;
            let response = allocation.wait(&mut command, true).await?;
            let element = allocation.evaluation_value(&response).await?;
            if element.primitive(method)? == Some(json!({"kind":"boolean","value":false})) {
                return Ok(json!({"status":"retry","reason":{"kind":"string","units":"element is not ready for action".encode_utf16().collect::<Vec<_>>()}}));
            }
            if element.subtype.as_deref() != Some("node") {
                return Err(invalid(method, "action resolver did not return a DOM node"));
            }
            let object_identifier = element.object_id.ok_or_else(|| invalid(method, "action resolver omitted its node identity"))?;
            if !same_document(page, realm, &realm.context) { return Err(evaluation::context_destroyed()); }
            self.capture_snapshot_phase(page_identifier, page, SnapshotPhase::Input, Some(SnapshotNode {
                object_identifier: object_identifier.clone(), context: realm.context.clone(),
            }), operation).await;
            operation.check()?;
            if !same_document(page, realm, &realm.context) { return Err(evaluation::context_destroyed()); }
            page.trace_before_input(operation);
            let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
                "uniqueContextId":realm.context.unique_identifier,
                "functionDeclaration":"function(element, request, deadline) { return globalThis.__flashwrightLocatorRuntime.runCapturedAction(element, request, deadline); }",
                "arguments":[{"objectId":object_identifier},{"value":request},{"value":operation.renderer_deadline()}],
                "objectGroup":allocation.group,"returnByValue":true,"awaitPromise":true,"userGesture":true,
            }), Some(&realm.context.session_identifier))?;
            let result = allocation.wait(&mut command, true).await.map_err(|mut error| {
                if !context_was_not_found(&error) && !command.prevent_dispatch() {
                    error.input_delivery = InputDelivery::Uncertain;
                }
                error
            })?;
            check_exception(&result, method)?;
            result["result"].get("value").cloned().ok_or_else(|| invalid(method, "Chromium omitted captured action result"))
        }.await;
        match allocation.finish(result).await {
            Ok(value) => {
                let cleanup = allocation.rollback().await;
                if cleanup != "handleGroupDisposed" {
                    return Err(closed(method));
                }
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }
}
