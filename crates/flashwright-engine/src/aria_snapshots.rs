//! Public default snapshots retain the original frame and one operation deadline.

use super::*;
use crate::element_resolution::same_document;
use crate::locators::{FrameSelector, check_exception, context_was_destroyed};
use serde_json::value::RawValue;
use tokio::time::sleep;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotRequest {
    // Keep selector JSON opaque here: escaped lone surrogates belong to the JS parser.
    selector: Box<RawValue>,
    mode: String,
    depth: Option<f64>,
    boxes: Option<bool>,
}

fn validate_request(request: &[u16]) -> Result<bool, ErrorRecord> {
    let method = "aria.snapshot";
    if request.len() > 100000 {
        return Err(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            method,
            "snapshot request exceeds 100000 UTF-16 units",
        ));
    }
    let text = String::from_utf16(request).map_err(|_| invalid(method, "invalid JSON UTF-16"))?;
    let options: SnapshotRequest =
        serde_json::from_str(&text).map_err(|_| invalid(method, "invalid snapshot request"))?;
    if options.mode == "ai" {
        return Err(ErrorRecord::new(
            ErrorCode::UnsupportedFeature,
            method,
            "AI snapshots are not implemented",
        ));
    }
    if options.mode != "default"
        || options
            .depth
            .is_some_and(|depth| !depth.is_finite() || depth.fract() != 0.0)
        || !(options.selector.get() == "null" || options.selector.get().starts_with('"'))
    {
        return Err(invalid(method, "invalid snapshot options"));
    }
    let _ = options.boxes;
    Ok(options.selector.get() != "null")
}

impl Engine {
    pub(crate) async fn run_aria_snapshot(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "aria.snapshot";
        validate_keys(method, &parameters, &["page", "frame", "request"])?;
        let request: Vec<u16> = parse(method, parameters["request"].clone())?;
        let has_locator_target = validate_request(&request)?;
        let page_identifier = identifier(&parameters, "page", method)?;
        let frame = identifier(&parameters, "frame", method)?;
        let page = self.page(page_identifier, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let mut selector = FrameSelector::new(page_identifier, frame, &request, true, Some(true));
        let mut attempt = 0;
        loop {
            operation.check()?;
            if has_locator_target {
                page.wait_for_input_navigation(0, operation, method).await?;
            }
            let result = async {
                let root = self.locator_realm(&page, &browser, frame, operation, method).await?;
                let Some(realm) = self.resolve_frame_selector(&page, &browser, &mut selector, operation, method).await? else {
                    return Ok(json!({"status":"retry"}));
                };
                if !same_document(&page, &root, &root.main_context) || !same_document(&page, &realm, &realm.main_context) {
                    return Err(evaluation::context_destroyed());
                }
                let result = operation.wait(page.state.while_alive(method, browser.connection.call(
                    "Runtime.callFunctionOn", json!({
                        "uniqueContextId": realm.context.unique_identifier,
                        "functionDeclaration": "function(request, deadline) { return globalThis.__flashwrightLocatorRuntime.ariaSnapshot(request, deadline); }",
                        "arguments": [{"value":selector.request},{"value":operation.renderer_deadline()}],
                        "returnByValue":true, "awaitPromise":true,
                    }), Some(&realm.context.session_identifier),
                ))).await?;
                if !same_document(&page, &root, &root.main_context) || !same_document(&page, &realm, &realm.main_context) {
                    return Err(evaluation::context_destroyed());
                }
                check_exception(&result, method)?;
                Ok(result["result"]["value"].clone())
            }.await;
            match result {
                Ok(result) => match result["status"].as_str() {
                    Some("success") => return Ok(result["value"].clone()),
                    Some("resourceLimit") => {
                        return Err(ErrorRecord::new(
                            ErrorCode::ResourceLimit,
                            method,
                            "snapshot output exceeds 100000 UTF-16 units",
                        ));
                    }
                    Some("expired") => {
                        return Err(ErrorRecord::new(
                            ErrorCode::Timeout,
                            method,
                            "snapshot operation deadline exceeded",
                        ));
                    }
                    Some("error") => {
                        let units: Vec<u16> = parse(method, result["message"]["units"].clone())?;
                        let mut error = ErrorRecord::new(
                            ErrorCode::Evaluation,
                            method,
                            String::from_utf16_lossy(&units),
                        );
                        error.message_utf16 = Some(units.into_boxed_slice());
                        return Err(error);
                    }
                    Some("retry") => (),
                    _ => return Err(invalid(method, "invalid snapshot renderer outcome")),
                },
                Err(error) if context_was_destroyed(&error) => (),
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_before_browser_lookup_without_losing_selector_surrogates() {
        assert!(
            !validate_request(
                &r#"{"selector":null,"mode":"default"}"#.encode_utf16().collect::<Vec<_>>()
            )
            .unwrap()
        );
        assert!(
            validate_request(
                &r#"{"selector":"button","mode":"default"}"#
                    .encode_utf16()
                    .collect::<Vec<_>>()
            )
            .unwrap()
        );
        for request in [
            r#"{"selector":null,"mode":"default","depth":0}"#,
            r#"{"selector":"\ud800","mode":"default","depth":-1,"boxes":true}"#,
        ] {
            assert!(validate_request(&request.encode_utf16().collect::<Vec<_>>()).is_ok());
        }
        for request in [
            r#"{"selector":5,"mode":"default"}"#,
            r#"{"selector":null,"mode":"default","depth":0.5}"#,
            r#"{"selector":null,"mode":"default","boxes":"true"}"#,
            r#"{"selector":null,"mode":"ai"}"#,
        ] {
            assert!(validate_request(&request.encode_utf16().collect::<Vec<_>>()).is_err());
        }
    }
}
