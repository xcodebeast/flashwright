//! Separate user execution failures from owned value-codec failures.

use super::*;

const EVALUATION_RUNTIME: &str = include_str!("../../../packages/resident-runtime/evaluation.cjs");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationFailure {
    code: ErrorCode,
    message_units: Vec<u16>,
    message_truncated: bool,
}

impl Engine {
    pub(super) async fn evaluate(&self, parameters: Value) -> Result<Value, ErrorRecord> {
        let method = "page.evaluate";
        validate_keys(
            method,
            &parameters,
            &["page", "source", "isFunction", "argument"],
        )?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        page.state.state.lock().unwrap().check(method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let units: Vec<u16> = parse(method, parameters["source"].clone())?;
        if units.len() > 100000 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "evaluation source exceeds 100000 UTF-16 units",
            ));
        }
        let is_function = parameters
            .get("isFunction")
            .and_then(Value::as_bool)
            .ok_or_else(|| invalid(method, "isFunction must be a boolean"))?;
        let source = units
            .iter()
            .map(|unit| format!("\\u{unit:04x}"))
            .collect::<String>();
        let argument = parameters
            .get("argument")
            .ok_or_else(|| invalid(method, "argument is required"))?;
        let expression = format!(
            "(() => {{ const exports = {{}}; {VALUE_CODEC}; {EVALUATION_RUNTIME}; return exports.runEvaluation(exports.createValueCodec(), '{source}', {is_function}, {argument}); }})()"
        );
        let result = page
            .state
            .while_alive(
                method,
                browser.connection.call(
                    "Runtime.evaluate",
                    json!({ "expression": expression, "awaitPromise": true, "returnByValue": true, "userGesture": true }),
                    Some(&page.session_identifier),
                ),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            let description = exception["exception"]["description"]
                .as_str()
                .or_else(|| exception["text"].as_str())
                .unwrap_or("JavaScript evaluation failed");
            return Err(ErrorRecord::new(ErrorCode::Evaluation, method, description));
        }
        let result = &result["result"]["value"];
        match result["outcome"].as_str() {
            Some("success") => result
                .get("value")
                .cloned()
                .ok_or_else(|| invalid(method, "Chromium omitted evaluation value")),
            Some("exception") => {
                let failure: EvaluationFailure = parse(method, result["error"].clone())?;
                if failure.message_units.len() > 8192 {
                    return Err(ErrorRecord::new(
                        ErrorCode::Protocol,
                        method,
                        "evaluation diagnostic exceeded the renderer error limit",
                    ));
                }
                let mut error = ErrorRecord::new(
                    failure.code,
                    method,
                    String::from_utf16_lossy(&failure.message_units),
                );
                error.message_utf16 = Some(failure.message_units.into_boxed_slice());
                error.diagnostics = Some(Box::new(json!({
                    "stage": result["stage"],
                    "messageTruncated": failure.message_truncated,
                })));
                Err(error)
            }
            _ => Err(ErrorRecord::new(
                ErrorCode::Protocol,
                method,
                "Chromium omitted a valid evaluation outcome",
            )),
        }
    }
}
