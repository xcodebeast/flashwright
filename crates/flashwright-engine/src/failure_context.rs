//! Optional runner diagnostics retain their original page and a finite capture allowance.

use super::*;
use crate::element_resolution::same_document;
use crate::locators::{check_exception, context_was_destroyed};
use tokio::time::sleep;

impl Engine {
    pub(crate) async fn capture_failure_context_snapshot(
        &self,
        parameters: Value,
        original_operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "diagnostics.pageSnapshot";
        validate_keys(method, &parameters, &["page", "frame"])?;
        let page_identifier = identifier(&parameters, "page", method)?;
        let frame = identifier(&parameters, "frame", method)?;
        let operation = original_operation.bounded_diagnostic(Duration::from_secs(5));
        let page = self.page(page_identifier, method)?;
        if page.state.state.lock().unwrap().main_frame.as_deref() != Some(frame) {
            return Err(invalid(
                method,
                "failure snapshot requires the original main frame",
            ));
        }
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let mut attempt = 0;
        loop {
            operation.check()?;
            let result = async {
                let realm = self.locator_realm(&page, &browser, frame, &operation, method).await?;
                if !same_document(&page, &realm, &realm.main_context) {
                    return Err(evaluation::context_destroyed());
                }
                let result = operation.wait(page.state.while_alive(method, browser.connection.call(
                    "Runtime.callFunctionOn", json!({
                        "uniqueContextId": realm.context.unique_identifier,
                        "functionDeclaration": "function(deadline) { return globalThis.__flashwrightLocatorRuntime.failureContextSnapshot(deadline); }",
                        "arguments": [{"value":operation.renderer_deadline()}],
                        "returnByValue":true, "awaitPromise":true,
                    }), Some(&realm.context.session_identifier),
                ))).await?;
                if !same_document(&page, &realm, &realm.main_context) {
                    return Err(evaluation::context_destroyed());
                }
                check_exception(&result, method)?;
                Ok(result["result"]["value"].clone())
            }.await;
            match result {
                Ok(result) => match result["status"].as_str() {
                    Some("success") => return Ok(result["value"].clone()),
                    Some("unsupportedFrames") => {
                        return Err(ErrorRecord::new(
                            ErrorCode::UnsupportedFeature,
                            method,
                            "failure page snapshot requires child-frame composition, which is not implemented",
                        ));
                    }
                    Some("expired") => {
                        return Err(ErrorRecord::new(
                            ErrorCode::Timeout,
                            method,
                            "failure page snapshot deadline exceeded",
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
                    _ => return Err(invalid(method, "invalid failure snapshot renderer outcome")),
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
