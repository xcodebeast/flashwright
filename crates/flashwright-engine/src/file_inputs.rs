//! File inputs retain original nodes and privately stage bounded payloads before one assignment.

use super::element_resolution::same_document;
use super::handle_values::{DescribedNode, ResolvedNode};
use super::handles::{Handle, HandleAllocation};
use super::locators::{LocatorRealm, check_exception, context_was_destroyed};
use super::recording::SnapshotPhase;
use super::snapshots::SnapshotNode;
use super::*;
use flashwright_protocol::InputDelivery;
use flashwright_protocol::attachment::{MAXIMUM_ATTACHMENT_BYTES, encode_base64};
use std::path::{Component, Path};
use tokio::time::sleep;

const MAXIMUM_METADATA_BYTES: usize = 1024 * 1024;
const RENDERER_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PayloadMetadata {
    name: Vec<u16>,
    mime_type: Vec<u16>,
    offset: usize,
    length: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Files {
    paths: Option<Vec<String>>,
    payloads: Option<Vec<PayloadMetadata>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInputRequest {
    page: String,
    frame: Option<String>,
    selector: Option<Vec<u16>>,
    handle: Option<String>,
    #[serde(default)]
    strict: bool,
    files: Files,
}

impl Files {
    /// Raw IPC clients receive the same bounds and cannot smuggle unmatched attachment bytes.
    fn validate(&self, operation: &Operation, method: &str) -> Result<(), ErrorRecord> {
        let mut metadata_bytes = 0usize;
        match (&self.paths, &self.payloads) {
            (Some(paths), None) => {
                if paths.is_empty() || operation.input_attachment().is_some() {
                    return Err(invalid(
                        method,
                        "local paths require a nonempty list and no binary input",
                    ));
                }
                if paths.len() > 4096 {
                    return Err(limit(method, "upload exceeds 4096 files"));
                }
                for path in paths {
                    let length = path.encode_utf16().count();
                    if length > 32768 {
                        return Err(limit(method, "path exceeds 32768 UTF-16 units"));
                    }
                    if path.contains('\0')
                        || !Path::new(path).is_absolute()
                        || Path::new(path).components().any(|component| {
                            matches!(component, Component::ParentDir | Component::CurDir)
                        })
                    {
                        return Err(invalid(
                            method,
                            "local paths must be absolute and fully resolved",
                        ));
                    }
                    metadata_bytes += length * 2;
                }
            }
            (None, Some(payloads)) => {
                if payloads.len() > 4096 {
                    return Err(limit(method, "upload exceeds 4096 files"));
                }
                let bytes = operation
                    .input_attachment()
                    .ok_or_else(|| invalid(method, "buffer uploads require binary input"))?;
                if bytes.len() > MAXIMUM_ATTACHMENT_BYTES {
                    return Err(limit(method, "in-memory upload exceeds 32 MiB"));
                }
                let mut offset = 0usize;
                for payload in payloads {
                    metadata_bytes = metadata_bytes.saturating_add(
                        payload
                            .name
                            .len()
                            .saturating_add(payload.mime_type.len())
                            .saturating_mul(2),
                    );
                    if payload.offset != offset
                        || payload.length > bytes.len().saturating_sub(offset)
                    {
                        return Err(invalid(
                            method,
                            "payload ranges must cover the input exactly in order",
                        ));
                    }
                    offset += payload.length;
                }
                if offset != bytes.len() {
                    return Err(invalid(method, "payload metadata omits input bytes"));
                }
            }
            _ => {
                return Err(invalid(
                    method,
                    "exactly one of paths and payloads is required",
                ));
            }
        }
        if metadata_bytes > MAXIMUM_METADATA_BYTES {
            return Err(limit(method, "upload metadata exceeds 1 MiB"));
        }
        Ok(())
    }

    fn count(&self) -> usize {
        self.paths
            .as_ref()
            .map_or_else(|| self.payloads.as_ref().map_or(0, Vec::len), Vec::len)
    }
}

impl Engine {
    /// Only pre-assignment locator work retries. Captured handles never adopt replacement nodes.
    pub(super) async fn set_input_files(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let captured = method == "elementHandle.setInputFiles";
        validate_keys(
            method,
            &parameters,
            if captured {
                &["page", "handle", "files"]
            } else {
                &["page", "frame", "selector", "strict", "files"]
            },
        )?;
        let request: FileInputRequest = parse(method, parameters)?;
        request.files.validate(operation, method)?;
        if !captured && (request.frame.is_none() || request.selector.is_none()) {
            return Err(invalid(method, "frame and selector are required"));
        }
        if request
            .selector
            .as_ref()
            .is_some_and(|selector| selector.len() > 100000)
        {
            return Err(limit(method, "selector exceeds 100000 UTF-16 units"));
        }
        let page = self.page(&request.page, method)?;
        let handle = if captured {
            let handle = self.owned_handle(
                &page,
                request
                    .handle
                    .as_deref()
                    .ok_or_else(|| invalid(method, "handle is required"))?,
                method,
            )?;
            if !handle.element {
                return Err(invalid(method, "expected an ElementHandle"));
            }
            Some(handle)
        } else {
            None
        };
        let frame = handle
            .as_ref()
            .map(|handle| handle.context.frame_identifier.as_str())
            .or(request.frame.as_deref())
            .unwrap();
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let mut selector = super::locators::FrameSelector::new(
            &request.page,
            frame,
            request.selector.as_deref().unwrap_or_default(),
            false,
            Some(request.strict),
        );
        let mut attempts = 0usize;
        loop {
            operation.check()?;
            if !captured {
                page.wait_for_input_navigation(0, operation, method).await?;
            }
            let result = self
                .file_input_attempt(
                    &page,
                    &browser,
                    &request,
                    handle.as_ref(),
                    frame,
                    &mut selector,
                    operation,
                    method,
                )
                .await;
            match result {
                Ok(Value::Bool(false)) if !captured => {}
                Ok(_) => return Ok(Value::Null),
                Err(error)
                    if !captured
                        && operation.input_delivery() == InputDelivery::NotDispatched
                        && context_was_destroyed(&error) =>
                {
                    page.state.locator_realms.lock().await.remove(frame);
                }
                Err(mut error) => {
                    error.method = method.into();
                    error.input_delivery = error.input_delivery.max(operation.input_delivery());
                    return Err(error);
                }
            }
            operation
                .wait(page.state.while_alive(method, async {
                    sleep(Duration::from_millis([20, 50, 100][attempts.min(2)])).await;
                    Ok(())
                }))
                .await?;
            attempts += 1;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn file_input_attempt(
        &self,
        page: &Page,
        browser: &Chromium,
        request: &FileInputRequest,
        handle: Option<&Handle>,
        frame: &str,
        selector: &mut super::locators::FrameSelector<'_>,
        operation: &Operation,
        method: &str,
    ) -> Result<Value, ErrorRecord> {
        let realm = if handle.is_some() {
            self.locator_realm(page, browser, frame, operation, method)
                .await?
        } else {
            let Some(realm) = self
                .resolve_frame_selector(page, browser, selector, operation, method)
                .await?
            else {
                return Ok(Value::Bool(false));
            };
            realm
        };
        if let Some(handle) = handle
            && !same_document(page, &realm, &handle.context)
        {
            return Err(evaluation::context_destroyed());
        }
        let allocation = HandleAllocation {
            engine: self,
            page_identifier: &request.page,
            page,
            browser,
            context: realm.context.clone(),
            operation,
            method,
            group: self.identifier("file-input-group"),
            uses_object_group: true,
        };
        let result = async {
            let element =
                resolve_input(&allocation, &realm, request, handle, &selector.request).await?;
            let Some(element) = element else {
                return Ok(Value::Bool(false));
            };
            let upload = stage_payloads(&allocation, &request.files).await?;
            if operation
                .trace_call()
                .is_some_and(|trace| trace.recording.is_some())
            {
                self.capture_snapshot_phase(
                    &request.page,
                    page,
                    SnapshotPhase::Input,
                    Some(SnapshotNode {
                        object_identifier: element.clone(),
                        context: realm.context.clone(),
                    }),
                    operation,
                )
                .await;
            }
            let _input_lock = operation
                .wait(
                    page.state
                        .while_execution_context(&allocation.context, async {
                            Ok(page.state.native_input.lock().await)
                        }),
                )
                .await?;
            if !same_document(page, &realm, &allocation.context) {
                return Err(evaluation::context_destroyed());
            }
            if let Some(handle) = handle
                && !same_document(page, &realm, &handle.context)
            {
                return Err(evaluation::context_destroyed());
            }
            assign_files(
                &allocation,
                &element,
                upload.as_deref(),
                &request.files,
                handle.is_none(),
            )
            .await
        }
        .await;
        match allocation.finish(result).await {
            Ok(value) => {
                let cleanup = allocation.rollback().await;
                if !["handleGroupDisposed", "handleContextDestroyed"].contains(&cleanup) {
                    return Err(closed(method));
                }
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }
}

/// Resolve once for each read-only attempt, then retarget labels in the utility world.
async fn resolve_input(
    allocation: &HandleAllocation<'_>,
    realm: &LocatorRealm,
    request: &FileInputRequest,
    handle: Option<&Handle>,
    selector: &[u16],
) -> Result<Option<String>, ErrorRecord> {
    let element = if let Some(handle) = handle {
        let mut command = allocation.browser.connection.start_raw_command(
            "DOM.describeNode",
            json!({"objectId": handle.object_identifier}),
            Some(&allocation.page.session_identifier),
        )?;
        let response = allocation.wait(&mut command, false).await?;
        let described: DescribedNode = serde_json::from_str(response.get())
            .map_err(|error| invalid(allocation.method, &error.to_string()))?;
        let mut command = allocation.browser.connection.start_raw_command("DOM.resolveNode", json!({"backendNodeId": described.node.backend_node_id, "executionContextId": realm.context.identifier, "objectGroup": allocation.group}), Some(&allocation.page.session_identifier))?;
        let response = allocation.wait(&mut command, false).await?;
        let resolved: ResolvedNode = serde_json::from_str(response.get())
            .map_err(|error| invalid(allocation.method, &error.to_string()))?;
        resolved
            .object
            .object_id
            .ok_or_else(evaluation::context_destroyed)?
    } else {
        let mut command = allocation.browser.connection.start_command("Runtime.callFunctionOn", json!({
            "uniqueContextId": realm.context.unique_identifier, "functionDeclaration": "function(selector, strict, deadline) { return globalThis.__flashwrightLocatorRuntime.resolveElement(selector, strict, 'attached', deadline); }",
            "arguments": [{"value": selector}, {"value": request.strict}, {"value": allocation.operation.renderer_deadline()}], "objectGroup": allocation.group, "returnByValue": false,
        }), Some(&allocation.page.session_identifier))?;
        let response = allocation.wait(&mut command, true).await?;
        let element = allocation.evaluation_value(&response).await?;
        let Some(identifier) = element.object_id else {
            return Ok(None);
        };
        identifier
    };
    allocation.operation.check()?;
    let mut command = allocation.browser.connection.start_command("Runtime.callFunctionOn", json!({
        "objectId": element, "functionDeclaration": "function(multiple, connected, deadline) { return globalThis.__flashwrightLocatorRuntime.resolveFileInput(this, multiple, connected, deadline); }",
        "arguments": [{"value": request.files.count() > 1}, {"value": handle.is_none()}, {"value": allocation.operation.renderer_deadline()}], "objectGroup": allocation.group, "returnByValue": false,
    }), Some(&allocation.page.session_identifier))?;
    let response = allocation.wait(&mut command, true).await?;
    let element = allocation.evaluation_value(&response).await?;
    if let Some(identifier) = element.object_id {
        return Ok(Some(identifier));
    }
    if let Some(value) = element.primitive(allocation.method)?
        && value["kind"] == "string"
    {
        let units: Vec<u16> = parse(allocation.method, value["units"].clone())?;
        check_status(&String::from_utf16_lossy(&units), allocation.method)?;
    }
    if handle.is_some() {
        return Err(ErrorRecord::new(
            ErrorCode::Evaluation,
            allocation.method,
            "Element is not attached to the DOM",
        ));
    }
    Ok(None)
}

/// Stage bounded CDP chunks without enlarging control frames or exposing mutable upload state.
async fn stage_payloads(
    allocation: &HandleAllocation<'_>,
    files: &Files,
) -> Result<Option<String>, ErrorRecord> {
    let Some(payloads) = &files.payloads else {
        return Ok(None);
    };
    let mut command = allocation.browser.connection.start_command("Runtime.callFunctionOn", json!({
        "uniqueContextId": allocation.context.unique_identifier, "functionDeclaration": "function() { return globalThis.__flashwrightLocatorRuntime.createFileUpload(); }", "objectGroup": allocation.group, "returnByValue": false,
    }), Some(&allocation.page.session_identifier))?;
    let response = allocation.wait(&mut command, false).await?;
    check_exception(&response, allocation.method)?;
    let upload = response["result"]["objectId"]
        .as_str()
        .ok_or_else(|| invalid(allocation.method, "Chromium omitted upload identity"))?
        .to_owned();
    let bytes = allocation.operation.input_attachment().unwrap();
    for payload in payloads {
        upload_call(allocation, &upload, "function(name, mimeType, length) { globalThis.__flashwrightLocatorRuntime.beginUploadFile(this, name, mimeType, length); }", json!([{"value": payload.name}, {"value": payload.mime_type}, {"value": payload.length}])).await?;
        for chunk in
            bytes[payload.offset..payload.offset + payload.length].chunks(RENDERER_CHUNK_BYTES)
        {
            allocation.operation.check()?;
            upload_call(allocation, &upload, "function(encoded) { globalThis.__flashwrightLocatorRuntime.appendUploadFile(this, encoded); }", json!([{"value": encode_base64(chunk)}])).await?;
        }
        upload_call(
            allocation,
            &upload,
            "function() { globalThis.__flashwrightLocatorRuntime.finishUploadFile(this); }",
            json!([]),
        )
        .await?;
    }
    Ok(Some(upload))
}

async fn upload_call(
    allocation: &HandleAllocation<'_>,
    object: &str,
    function: &str,
    arguments: Value,
) -> Result<(), ErrorRecord> {
    allocation.operation.check()?;
    let mut command = allocation.browser.connection.start_command("Runtime.callFunctionOn", json!({"objectId": object, "functionDeclaration": function, "arguments": arguments, "objectGroup": allocation.group, "returnByValue": true}), Some(&allocation.page.session_identifier))?;
    let response = allocation.wait(&mut command, false).await?;
    check_exception(&response, allocation.method)
}

/// After dispatch, a lost reply is never replayed, including when application event handlers block.
async fn assign_files(
    allocation: &HandleAllocation<'_>,
    element: &str,
    upload: Option<&str>,
    files: &Files,
    connected: bool,
) -> Result<Value, ErrorRecord> {
    let browser = allocation.browser;
    let page = allocation.page;
    let operation = allocation.operation;
    if files.paths.is_some() {
        let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
            "objectId": element, "functionDeclaration": "function(multiple, connected, deadline) { return globalThis.__flashwrightLocatorRuntime.validateFileInput(this, multiple, connected, deadline); }",
            "arguments": [{"value": files.count() > 1}, {"value": connected}, {"value": operation.renderer_deadline()}], "returnByValue": true,
        }), Some(&page.session_identifier))?;
        let response = allocation.wait(&mut command, false).await?;
        check_exception(&response, allocation.method)?;
        if !check_status(
            response["result"]["value"].as_str().unwrap_or("invalid"),
            allocation.method,
        )? {
            return Ok(Value::Bool(false));
        }
    }
    operation.check()?;
    page.trace_before_input(operation);
    let mut command = if let Some(paths) = &files.paths {
        browser.connection.start_command(
            "DOM.setFileInputFiles",
            json!({"objectId": element, "files": paths}),
            Some(&page.session_identifier),
        )?
    } else {
        browser.connection.start_command("Runtime.callFunctionOn", json!({
            "objectId": element, "functionDeclaration": "function(upload, connected, deadline) { return globalThis.__flashwrightLocatorRuntime.assignFileUpload(this, upload, connected, deadline); }",
            "arguments": [{"objectId": upload.unwrap()}, {"value": connected}, {"value": operation.renderer_deadline()}], "returnByValue": true, "userGesture": true,
        }), Some(&page.session_identifier))?
    };
    let response = match allocation.wait(&mut command, true).await {
        Ok(response) => response,
        Err(mut error) => {
            if !command.prevent_dispatch() {
                operation.record_input_delivery(InputDelivery::Uncertain);
            }
            error.input_delivery = error.input_delivery.max(operation.input_delivery());
            return Err(error);
        }
    };
    check_exception(&response, allocation.method).inspect_err(|_| {
        operation.record_input_delivery(InputDelivery::Uncertain);
    })?;
    if files.payloads.is_some()
        && !check_status(
            response["result"]["value"].as_str().unwrap_or("invalid"),
            allocation.method,
        )?
    {
        return Ok(Value::Bool(false));
    }
    operation.record_input_delivery(InputDelivery::Acknowledged);
    Ok(Value::Null)
}

fn check_status(status: &str, method: &str) -> Result<bool, ErrorRecord> {
    match status {
        "ready" | "success" => Ok(true),
        "detached" => Ok(false),
        "expired" => Err(ErrorRecord::new(
            ErrorCode::Timeout,
            method,
            "operation deadline exceeded before file assignment",
        )),
        "directory" => Err(ErrorRecord::new(
            ErrorCode::UnsupportedFeature,
            method,
            "directory file inputs are not implemented",
        )),
        _ => Err(ErrorRecord::new(
            ErrorCode::Protocol,
            method,
            "invalid file assignment status",
        )),
    }
}

fn limit(method: &str, message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, method, message)
}
