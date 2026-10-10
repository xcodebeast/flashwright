//! Lazy frame paths share the caller's operation and retain no node between retries.

use super::*;
use crate::element_resolution::same_document;
use crate::handles::HandleAllocation;
use std::borrow::Cow;

pub(crate) struct FrameSelector<'request> {
    page_identifier: String,
    pub root_frame: String,
    pub request: Cow<'request, [u16]>,
    pub missing_request: Vec<u16>,
    pub missing_wait_satisfied: bool,
    frames: Vec<Vec<u16>>,
    strict: bool,
    inherit_strict: bool,
    structured_request: bool,
    needs_plan: bool,
}

impl<'request> FrameSelector<'request> {
    pub fn new(
        page_identifier: &str,
        frame: &str,
        request: &'request [u16],
        structured_request: bool,
        strict: Option<bool>,
    ) -> Self {
        // The literal engine name is necessary for an enter-frame token. False positives
        // inside quoted text still go through the full pinned parser, never a string split.
        let marker = b"internal:control";
        Self {
            page_identifier: page_identifier.into(),
            root_frame: frame.into(),
            request: Cow::Borrowed(request),
            missing_request: Vec::new(),
            missing_wait_satisfied: false,
            frames: Vec::new(),
            strict: strict.unwrap_or(true),
            inherit_strict: strict.is_none(),
            structured_request,
            needs_plan: request.windows(marker.len()).any(|units| {
                units
                    .iter()
                    .zip(marker)
                    .all(|(unit, byte)| *unit == u16::from(*byte))
            }),
        }
    }

    pub fn crosses_frames(&self) -> bool {
        !self.frames.is_empty()
    }
}

impl Engine {
    /// Resolve from the original root on every attempt, including still-live iframe replacement.
    pub(crate) async fn resolve_frame_selector(
        &self,
        page: &Page,
        browser: &Chromium,
        selector: &mut FrameSelector<'_>,
        operation: &Operation,
        method: &str,
    ) -> Result<Option<LocatorRealm>, ErrorRecord> {
        let mut realm = self
            .locator_realm(page, browser, &selector.root_frame, operation, method)
            .await?;
        if selector.needs_plan {
            let response = operation.wait(page.state.while_alive(method, browser.connection.call(
                "Runtime.callFunctionOn", json!({
                    "uniqueContextId": realm.context.unique_identifier,
                    "functionDeclaration": "function(request, structured) { return globalThis.__flashwrightLocatorRuntime.prepareFrameSelector(request, structured); }",
                    "arguments": [{"value":selector.request},{"value":selector.structured_request}],
                    "returnByValue": true, "awaitPromise": true,
                }), Some(&page.session_identifier),
            ))).await?;
            check_exception(&response, method)?;
            let result = &response["result"]["value"];
            if result["status"] == "error" {
                let units: Vec<u16> = parse(method, result["message"]["units"].clone())?;
                let mut error = ErrorRecord::new(
                    ErrorCode::Evaluation,
                    method,
                    String::from_utf16_lossy(&units),
                );
                error.message_utf16 = Some(units.into_boxed_slice());
                return Err(error);
            }
            if result["status"] != "success" {
                return Err(invalid(
                    method,
                    "frame selector planner omitted its outcome",
                ));
            }
            let plan = &result["plan"];
            selector.frames = parse(method, plan["frames"].clone())?;
            selector.request = Cow::Owned(parse(method, plan["request"].clone())?);
            selector.missing_request = parse(method, plan["missingRequest"].clone())?;
            selector.missing_wait_satisfied = parse(method, plan["missingWaitSatisfied"].clone())?;
            if selector.inherit_strict {
                selector.strict = parse(method, plan["strict"].clone())?;
            }
            selector.needs_plan = false;
        }
        for frame_selector in &selector.frames {
            let Some(child) = self
                .selector_content_frame(
                    &selector.page_identifier,
                    page,
                    browser,
                    &realm,
                    frame_selector,
                    selector.strict,
                    operation,
                    method,
                )
                .await?
            else {
                return Ok(None);
            };
            match self
                .locator_realm(page, browser, &child, operation, method)
                .await
            {
                Ok(child_realm) => realm = child_realm,
                Err(error) if context_was_destroyed(&error) => return Ok(None),
                Err(error) if matches!(error.code, ErrorCode::TargetClosed) => {
                    let state = page.state.state.lock().unwrap();
                    state.check(method)?;
                    if !state.frames.contains_key(&selector.root_frame) {
                        return Err(error);
                    }
                    if !state.frames.contains_key(&child) {
                        return Ok(None);
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(Some(realm))
    }

    #[allow(clippy::too_many_arguments)]
    async fn selector_content_frame(
        &self,
        page_identifier: &str,
        page: &Page,
        browser: &Chromium,
        realm: &LocatorRealm,
        selector: &[u16],
        strict: bool,
        operation: &Operation,
        method: &str,
    ) -> Result<Option<String>, ErrorRecord> {
        let _reservation = self.reserve_handle(page, method)?;
        let allocation = HandleAllocation {
            engine: self,
            page_identifier,
            page,
            browser,
            context: realm.context.clone(),
            operation,
            method,
            group: self.identifier("frame-selector"),
            uses_object_group: true,
        };
        let result = async {
            let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
                "uniqueContextId":realm.context.unique_identifier,
                "functionDeclaration":"function(selector, strict, deadline) { return globalThis.__flashwrightLocatorRuntime.resolveFrameElement(selector, strict, deadline); }",
                "arguments":[{"value":selector},{"value":strict},{"value":operation.renderer_deadline()}],
                "objectGroup":allocation.group,"returnByValue":false,
            }), Some(&page.session_identifier))?;
            let response = allocation.wait(&mut command, true).await?;
            let element = allocation.evaluation_value(&response).await?;
            if element.primitive(method)? == Some(json!({"kind":"null"})) { return Ok(None); }
            if element.subtype.as_deref() != Some("node") { return Err(invalid(method, "frame selector omitted its DOM node")); }
            let object = element.object_id.ok_or_else(|| invalid(method, "frame selector omitted its object identity"))?;
            let mut describe = browser.connection.start_command("DOM.describeNode", json!({"objectId":object}), Some(&page.session_identifier))?;
            let description = allocation.wait(&mut describe, false).await?;
            if !same_document(page, realm, &realm.context) { return Err(evaluation::context_destroyed()); }
            let Some(child) = description["node"]["frameId"].as_str() else { return Ok(None); };
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            Ok(state.frames.get(child).filter(|frame| frame.parent.as_deref() == Some(&realm.context.frame_identifier)).map(|_| child.to_owned()))
        }.await;
        match allocation.finish(result.map(|value| json!(value))).await {
            Ok(value) => {
                let cleanup = allocation.rollback().await;
                if !["handleGroupDisposed", "handleContextDestroyed"].contains(&cleanup) {
                    return Err(closed(method));
                }
                parse(method, value)
            }
            Err(error) => Err(error),
        }
    }
}
