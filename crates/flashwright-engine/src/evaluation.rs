//! Separate user execution failures from owned value-codec failures.

use super::page_state::ExecutionContext;
use super::*;
use crate::locators::check_exception;

const EVALUATION_RUNTIME: &str = include_str!("../../../packages/resident-runtime/evaluation.cjs");
const METHOD: &str = "page.evaluate";

pub(crate) struct EvaluationRuntime {
    context: ExecutionContext,
    outcome: watch::Receiver<Option<Result<String, ErrorRecord>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationFailure {
    code: ErrorCode,
    message_units: Vec<u16>,
    message_truncated: bool,
}

impl Engine {
    pub(super) async fn evaluate(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = METHOD;
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
        let argument = parameters
            .get("argument")
            .ok_or_else(|| invalid(method, "argument is required"))?;
        let runtime = self.evaluation_runtime(&page, &browser, operation).await?;
        let mut outcome = runtime.outcome.clone();
        let prepared = operation
            .wait(page.state.while_execution_context(&runtime.context, async {
                loop {
                    if let Some(result) = outcome.borrow_and_update().clone() {
                        return result;
                    }
                    outcome.changed().await.map_err(|_| closed(method))?;
                }
            }))
            .await;
        let object_identifier = match prepared {
            Ok(identifier) => identifier,
            Err(mut error) => {
                if runtime
                    .outcome
                    .borrow()
                    .as_ref()
                    .is_some_and(Result::is_err)
                {
                    let mut cached = page.state.evaluation_runtime.lock().unwrap();
                    if cached
                        .as_ref()
                        .is_some_and(|cached| Arc::ptr_eq(cached, &runtime))
                    {
                        *cached = None;
                    }
                }
                if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) {
                    error.cleanup = Some("evaluationNotDispatched".into());
                }
                return Err(error);
            }
        };
        operation.check()?;
        let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
            "uniqueContextId": runtime.context.unique_identifier,
            "functionDeclaration": "function(runtime, sourceUnits, isFunction, argument) { return runtime(sourceUnits, isFunction, argument); }",
            "arguments": [{ "objectId": object_identifier }, { "value": units }, { "value": is_function }, { "value": argument }],
            "awaitPromise": true, "returnByValue": true, "userGesture": true,
        }), Some(&page.session_identifier))?;
        let result = operation
            .wait(
                page.state
                    .while_execution_context(&runtime.context, command.response()),
            )
            .await;
        let result = match result {
            Err(mut error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                if command.prevent_dispatch() {
                    error.cleanup = Some("notDispatched".into());
                } else if page.state.state.lock().unwrap().main_execution_context()
                    == Some(&runtime.context)
                {
                    // Only an already dispatched user evaluation can request termination.
                    // Shared helper preparation never terminates application JavaScript.
                    let _ = timeout(
                        Duration::from_secs(1),
                        browser.connection.call(
                            "Runtime.terminateExecution",
                            json!({}),
                            Some(&page.session_identifier),
                        ),
                    )
                    .await;
                }
                return Err(error);
            }
            result => result?,
        };
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

    /// Preparation belongs to the document, not to its first caller. Its one pending
    /// reply stays owned through caller cancellation, and cannot dispatch user code.
    async fn evaluation_runtime(
        &self,
        page: &Page,
        browser: &Arc<Chromium>,
        operation: &Operation,
    ) -> Result<Arc<EvaluationRuntime>, ErrorRecord> {
        operation
            .wait(
                page.state
                    .while_alive(METHOD, browser.connection.synchronize_events()),
            )
            .await?;
        let mut changes = page.state.changed.subscribe();
        let context = operation
            .wait(async {
                loop {
                    {
                        let state = page.state.state.lock().unwrap();
                        state.check(METHOD)?;
                        if let Some(context) = state.main_execution_context() {
                            break Ok(context.clone());
                        }
                    }
                    changes.changed().await.map_err(|_| closed(METHOD))?;
                }
            })
            .await?;
        let mut cached = page.state.evaluation_runtime.lock().unwrap();
        if let Some(runtime) = cached.as_ref().filter(|runtime| runtime.context == context) {
            return Ok(runtime.clone());
        }
        let (sender, outcome) = watch::channel(None);
        let runtime = Arc::new(EvaluationRuntime {
            context: context.clone(),
            outcome,
        });
        *cached = Some(runtime.clone());
        let page = page.clone();
        let browser = browser.clone();
        tokio::spawn(async move {
            let result = initialize_runtime(&page, &browser, &context).await;
            sender.send_replace(Some(result));
        });
        Ok(runtime)
    }
}

pub(crate) fn context_destroyed() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Evaluation,
        METHOD,
        "Execution context was destroyed, most likely because of a navigation",
    )
}

async fn initialize_runtime(
    page: &Page,
    browser: &Chromium,
    context: &ExecutionContext,
) -> Result<String, ErrorRecord> {
    let expression = format!(
        "(() => {{ const exports = {{}}; {VALUE_CODEC}; {EVALUATION_RUNTIME}; return (sourceUnits, isFunction, argument) => {{ const codec = exports.createValueCodec(); return exports.runEvaluation(codec, codec.decode({{kind:'string',units:sourceUnits}}), isFunction, argument); }}; }})()"
    );
    let result = page
        .state
        .while_alive(
            METHOD,
            browser.connection.call(
                "Runtime.evaluate",
                json!({
                    "expression": expression, "uniqueContextId": context.unique_identifier,
                    "returnByValue": false, "objectGroup": "flashwright-evaluation-runtime",
                }),
                Some(&page.session_identifier),
            ),
        )
        .await?;
    check_exception(&result, METHOD)?;
    let Some(identifier) = result["result"]["objectId"].as_str() else {
        let mut error = invalid(METHOD, "Chromium omitted the evaluation helper identity");
        error.cleanup = Some(
            dispose(browser, ResourceKind::Page, &page.target_identifier)
                .await
                .into(),
        );
        return Err(error);
    };
    page.state
        .while_alive(METHOD, browser.connection.synchronize_events())
        .await?;
    let current = page.state.state.lock().unwrap().main_execution_context() == Some(context);
    if !current {
        // A late preparation reply still owns its object, even after the caller or
        // document has changed. Release that exact handle, never a successor helper.
        let _ = page
            .state
            .while_alive(
                METHOD,
                browser.connection.call(
                    "Runtime.releaseObject",
                    json!({
                        "objectId": identifier,
                    }),
                    Some(&page.session_identifier),
                ),
            )
            .await;
        return Err(context_destroyed());
    }
    Ok(identifier.to_owned())
}
