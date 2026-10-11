//! Separate user execution failures from owned value-codec failures.

use super::page_state::ExecutionContext;
use super::*;
use crate::locators::check_exception;
use handles::{Handle, HandleArguments, HandleReference};

const EVALUATION_RUNTIME: &str = include_str!("../../../packages/resident-runtime/evaluation.cjs");
const FUNCTION_WAIT_RUNTIME: &str =
    include_str!("../../../packages/resident-runtime/function-wait.cjs");
const METHOD: &str = "page.evaluate";

pub(crate) struct EvaluationRuntime {
    pub(crate) context: ExecutionContext,
    pub(crate) outcome: watch::Receiver<Option<Result<String, ErrorRecord>>>,
}

pub(crate) struct PreparedEvaluation {
    pub page_identifier: String,
    pub page: Page,
    pub browser: Arc<Chromium>,
    pub runtime: Arc<EvaluationRuntime>,
    runtime_object: String,
    source: Vec<u16>,
    is_function: bool,
    argument: Value,
    handles: HandleArguments,
    receiver_index: Option<usize>,
}

impl PreparedEvaluation {
    /// The controller allocation does not execute the predicate; its separate start reply owns that work.
    pub(crate) fn waiter_parameters(&self, group: &str, polling: Value) -> Value {
        let mut parameters = self.command_parameters(Some(group));
        let arguments = parameters["arguments"].as_array_mut().unwrap();
        arguments.insert(6, json!({ "value": polling }));
        parameters["functionDeclaration"] = json!(
            "function(runtime, sourceUnits, isFunction, argument, primitiveHandles, receiverIndex, polling, ...handles) { return runtime.waiter(sourceUnits, isFunction, argument, handles, primitiveHandles, polling); }"
        );
        parameters["awaitPromise"] = json!(false);
        parameters
    }

    pub(crate) fn retained_arguments(&self) -> Vec<Handle> {
        self.handles.retained.clone()
    }

    pub fn command_parameters(&self, group: Option<&str>) -> Value {
        let mut arguments = vec![
            json!({ "objectId": self.runtime_object }),
            json!({ "value": self.source }),
            json!({ "value": self.is_function }),
            json!({ "value": self.argument }),
        ];
        let function = if group.is_none() && self.handles.arguments.is_empty() {
            "function(runtime, sourceUnits, isFunction, argument) { return runtime(sourceUnits, isFunction, argument); }"
        } else {
            arguments.push(json!({ "value": self.handles.primitive }));
            arguments.push(json!({ "value": self.receiver_index }));
            arguments.extend(self.handles.arguments.iter().cloned());
            if group.is_some() {
                "function(runtime, sourceUnits, isFunction, argument, primitiveHandles, receiverIndex, ...handles) { return runtime.handle(sourceUnits, isFunction, argument, handles, primitiveHandles, receiverIndex); }"
            } else {
                "function(runtime, sourceUnits, isFunction, argument, primitiveHandles, receiverIndex, ...handles) { return runtime(sourceUnits, isFunction, argument, handles, primitiveHandles, receiverIndex); }"
            }
        };
        let mut parameters = json!({
            "uniqueContextId": self.runtime.context.unique_identifier,
            "functionDeclaration": function, "arguments": arguments,
            "awaitPromise": true, "returnByValue": group.is_none(), "userGesture": true,
        });
        if let Some(group) = group {
            parameters["objectGroup"] = json!(group);
        }
        parameters
    }
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
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let prepared = self
            .prepare_evaluation(method, parameters, operation)
            .await?;
        operation.check()?;
        let mut command = prepared.browser.connection.start_command(
            "Runtime.callFunctionOn",
            prepared.command_parameters(None),
            Some(&prepared.runtime.context.session_identifier),
        )?;
        let result = operation
            .wait(
                prepared
                    .page
                    .state
                    .while_execution_context(&prepared.runtime.context, command.response()),
            )
            .await;
        let result = match result {
            Err(mut error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                if command.prevent_dispatch() {
                    error.cleanup = Some("notDispatched".into());
                } else if prepared
                    .page
                    .state
                    .state
                    .lock()
                    .unwrap()
                    .context_is_alive(&prepared.runtime.context)
                {
                    // Shared helper preparation never terminates application JavaScript.
                    let _ = timeout(
                        Duration::from_secs(1),
                        prepared.browser.connection.call(
                            "Runtime.terminateExecution",
                            json!({}),
                            Some(&prepared.runtime.context.session_identifier),
                        ),
                    )
                    .await;
                }
                return Err(error);
            }
            result => result?,
        };
        // Chromium sends console events before this reply, but the separate event
        // consumer can still be applying them when the command waiter wakes.
        operation
            .wait(prepared.browser.connection.synchronize_events())
            .await?;
        evaluation_result(method, &result)
    }

    pub(crate) async fn prepare_evaluation(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<PreparedEvaluation, ErrorRecord> {
        let keys: &[&str] = if method.starts_with("handle.") {
            &[
                "page",
                "handle",
                "source",
                "isFunction",
                "argument",
                "handles",
            ]
        } else {
            &[
                "page",
                "frame",
                "source",
                "isFunction",
                "argument",
                "handles",
            ]
        };
        validate_keys(method, &parameters, keys)?;
        let page_identifier = identifier(&parameters, "page", method)?.to_owned();
        let page = self.page(&page_identifier, method)?;
        page.state.state.lock().unwrap().check(method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let source: Vec<u16> = parse(method, parameters["source"].clone())?;
        if source.len() > 100000 {
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
            .ok_or_else(|| invalid(method, "argument is required"))?
            .clone();
        let mut references: Vec<HandleReference> = parameters
            .get("handles")
            .map(|value| parse(method, value.clone()))
            .transpose()?
            .unwrap_or_default();
        let receiver: Option<Handle> = if method.starts_with("handle.") {
            let receiver = identifier(&parameters, "handle", method)?;
            let handle = self.owned_handle(&page, receiver, method)?;
            references.push(HandleReference {
                page: page_identifier.clone(),
                identifier: receiver.to_owned(),
            });
            Some(handle)
        } else {
            None
        };
        let frame = parameters
            .get("frame")
            .map(|_| identifier(&parameters, "frame", method))
            .transpose()?;
        let runtime = match &receiver {
            Some(receiver) => {
                self.context_evaluation_runtime(&page, &browser, &receiver.context)?
            }
            None => {
                self.evaluation_runtime(&page, &browser, frame, operation)
                    .await?
            }
        };
        let handles =
            self.handle_arguments(&page_identifier, &runtime.context, &references, method)?;
        let receiver_index = receiver.map(|_| handles.arguments.len() - 1);
        let runtime_object = ready_runtime(&page, &runtime, operation, method).await?;
        Ok(PreparedEvaluation {
            page_identifier,
            page,
            browser,
            runtime,
            runtime_object,
            source,
            is_function,
            argument,
            handles,
            receiver_index,
        })
    }
    /// Preparation belongs to the document, not to its first caller. Its one pending
    /// reply stays owned through caller cancellation, and cannot dispatch user code.
    pub(crate) async fn evaluation_runtime(
        &self,
        page: &Page,
        browser: &Arc<Chromium>,
        frame: Option<&str>,
        operation: &Operation,
    ) -> Result<Arc<EvaluationRuntime>, ErrorRecord> {
        let context = self
            .evaluation_context(page, browser, frame, operation, METHOD, true)
            .await?;
        self.context_evaluation_runtime(page, browser, &context)
    }

    /// Resolve original-context ownership without installing a main-world helper.
    pub(crate) async fn evaluation_context(
        &self,
        page: &Page,
        browser: &Chromium,
        frame: Option<&str>,
        operation: &Operation,
        method: &str,
        allow_remote_frame: bool,
    ) -> Result<ExecutionContext, ErrorRecord> {
        operation
            .wait(
                page.state
                    .while_alive(method, browser.connection.synchronize_events()),
            )
            .await?;
        let mut changes = page.state.changed.subscribe();
        operation
            .wait(async {
                loop {
                    {
                        let state = page.state.state.lock().unwrap();
                        state.check(method)?;
                        let selected = frame.or(state.main_frame.as_deref());
                        if let Some(selected) = selected
                            && let Some(context) = ready_frame_context(
                                &page.state,
                                &state,
                                selected,
                                method,
                                allow_remote_frame,
                            )?
                        {
                            break Ok(context);
                        }
                    }
                    changes.changed().await.map_err(|_| closed(method))?;
                }
            })
            .await
    }

    /// Retained handles install a shared helper lazily in their exact original world.
    pub(crate) fn context_evaluation_runtime(
        &self,
        page: &Page,
        browser: &Arc<Chromium>,
        context: &ExecutionContext,
    ) -> Result<Arc<EvaluationRuntime>, ErrorRecord> {
        let state = page.state.state.lock().unwrap();
        state.check(METHOD)?;
        if !state.context_is_alive(context) {
            return Err(context_destroyed());
        }
        let mut cached = page.state.evaluation_runtimes.lock().unwrap();
        if let Some(runtime) = cached
            .get(&context.unique_identifier)
            .filter(|runtime| runtime.context == *context)
        {
            return Ok(runtime.clone());
        }
        let (sender, outcome) = watch::channel(None);
        let runtime = Arc::new(EvaluationRuntime {
            context: context.clone(),
            outcome,
        });
        cached.insert(context.unique_identifier.clone(), runtime.clone());
        let page = page.clone();
        let browser = browser.clone();
        let context = context.clone();
        tokio::spawn(async move {
            let result = initialize_runtime(&page, &browser, &context).await;
            sender.send_replace(Some(result));
        });
        Ok(runtime)
    }
}

/// A world event can arrive before paused renderer setup finishes. Admit only that session's
/// current main world, and never use a predecessor's readiness across a frame handoff.
fn ready_frame_context(
    page: &PageState,
    state: &page_state::DocumentState,
    frame_identifier: &str,
    method: &str,
    allow_remote_frame: bool,
) -> Result<Option<ExecutionContext>, ErrorRecord> {
    let frame = state.frames.get(frame_identifier).ok_or_else(|| {
        ErrorRecord::new(ErrorCode::Evaluation, method, "frame has been detached")
    })?;
    if frame.remote && !allow_remote_frame {
        return Err(ErrorRecord::new(
            ErrorCode::UnsupportedFeature,
            method,
            "this locator operation in out-of-process frames is not implemented",
        ));
    }
    if frame.awaiting_renderer {
        return Ok(None);
    }
    if frame.remote
        && !page
            .renderer_sessions
            .lock()
            .unwrap()
            .get(&frame.session_identifier)
            .is_some_and(|owner| owner.is_ready())
    {
        return Ok(None);
    }
    let Some(context) = state.main_worlds.get(frame_identifier) else {
        return Ok(None);
    };
    Ok(
        (context.session_identifier == frame.session_identifier && state.context_is_alive(context))
            .then(|| context.clone()),
    )
}

pub(crate) async fn ready_runtime(
    page: &Page,
    runtime: &Arc<EvaluationRuntime>,
    operation: &Operation,
    method: &str,
) -> Result<String, ErrorRecord> {
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
    match prepared {
        Ok(identifier) => Ok(identifier),
        Err(mut error) => {
            if runtime
                .outcome
                .borrow()
                .as_ref()
                .is_some_and(Result::is_err)
            {
                let mut cached = page.state.evaluation_runtimes.lock().unwrap();
                if cached
                    .get(&runtime.context.unique_identifier)
                    .is_some_and(|cached| Arc::ptr_eq(cached, runtime))
                {
                    cached.remove(&runtime.context.unique_identifier);
                }
            }
            if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) {
                error.cleanup = Some("evaluationNotDispatched".into());
            }
            Err(error)
        }
    }
}

pub(crate) fn evaluation_result(method: &str, response: &Value) -> Result<Value, ErrorRecord> {
    if let Some(exception) = response.get("exceptionDetails") {
        let description = exception["exception"]["description"]
            .as_str()
            .or_else(|| exception["text"].as_str())
            .unwrap_or("JavaScript evaluation failed");
        return Err(ErrorRecord::new(ErrorCode::Evaluation, method, description));
    }
    let result = &response["result"]["value"];
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

pub(crate) fn context_destroyed() -> ErrorRecord {
    let mut error = ErrorRecord::new(
        ErrorCode::Evaluation,
        METHOD,
        "Execution context was destroyed, most likely because of a navigation",
    );
    error.execution_context_destroyed = true;
    error
}

async fn initialize_runtime(
    page: &Page,
    browser: &Chromium,
    context: &ExecutionContext,
) -> Result<String, ErrorRecord> {
    let expression = format!(
        r#"(() => {{
        const exports = {{}};
        {VALUE_CODEC}
        {EVALUATION_RUNTIME}
        {FUNCTION_WAIT_RUNTIME}
        const invoke = (asHandle, sourceUnits, isFunction, argument, handles = [], primitiveHandles = [], receiverIndex = null) => {{
            const codec = exports.createValueCodec();
            return exports[asHandle ? 'runHandleEvaluation' : 'runEvaluation'](
                codec, codec.decode({{ kind: 'string', units: sourceUnits }}), isFunction,
                argument, handles, primitiveHandles, receiverIndex
            );
        }};
        const runtime = (...arguments_) => invoke(false, ...arguments_);
        runtime.handle = (...arguments_) => invoke(true, ...arguments_);
        let createWaiter;
        runtime.waiter = (sourceUnits, isFunction, argument, handles, primitiveHandles, polling) => {{
            const codec = exports.createValueCodec();
            try {{
                createWaiter ??= exports.createFunctionWaitFactory();
                return createWaiter(codec, codec.decode({{ kind: 'string', units: sourceUnits }}),
                    isFunction, argument, handles, primitiveHandles, polling);
            }} catch (error) {{
                return exports.failedFunctionWaiter(codec, error);
            }}
        }};
        return runtime;
    }})()"#
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
                Some(&context.session_identifier),
            ),
        )
        .await?;
    check_exception(&result, METHOD)?;
    let Some(identifier) = result["result"]["objectId"].as_str() else {
        let mut error = invalid(METHOD, "Chromium omitted the evaluation helper identity");
        error.cleanup = Some(
            page.state
                .disposal
                .dispose(browser, &page.target_identifier)
                .await
                .into(),
        );
        return Err(error);
    };
    page.state
        .while_alive(METHOD, browser.connection.synchronize_events())
        .await?;
    let current = page.state.state.lock().unwrap().context_is_alive(context);
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
                    Some(&context.session_identifier),
                ),
            )
            .await;
        return Err(context_destroyed());
    }
    Ok(identifier.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_world_admission_waits_for_exact_ready_owner_and_surviving_document() {
        let page = PageState::default();
        let mut state = page.state.lock().unwrap();
        let mut sessions = page.renderer_sessions.lock().unwrap();
        let root = sessions.register_root("root", "root-session").unwrap();
        root.mark_ready();
        let original = sessions
            .register_child(&root, "child", "original-session")
            .unwrap();
        let original_context = ExecutionContext {
            session_identifier: "original-session".into(),
            identifier: 7,
            unique_identifier: "original-world".into(),
            frame_identifier: "child".into(),
        };
        state.frames.insert(
            "child".into(),
            page_state::FrameState {
                identifier: "child".into(),
                session_identifier: "original-session".into(),
                remote: true,
                ..Default::default()
            },
        );
        state
            .main_worlds
            .insert("child".into(), original_context.clone());
        state
            .execution_contexts
            .insert(original_context.key(), original_context.clone());
        drop(sessions);
        assert!(
            ready_frame_context(&page, &state, "child", METHOD, true)
                .unwrap()
                .is_none()
        );
        let unsupported =
            ready_frame_context(&page, &state, "child", "locator.fill", false).unwrap_err();
        assert_eq!(unsupported.code, ErrorCode::UnsupportedFeature);
        assert_eq!(unsupported.method.as_ref(), "locator.fill");
        original.mark_ready();
        assert_eq!(
            ready_frame_context(&page, &state, "child", METHOD, true).unwrap(),
            Some(original_context.clone())
        );
        state.frames.get_mut("child").unwrap().awaiting_renderer = true;
        assert!(
            ready_frame_context(&page, &state, "child", METHOD, true)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            ready_frame_context(&page, &state, "child", "locator.click", false)
                .unwrap_err()
                .code,
            ErrorCode::UnsupportedFeature
        );
        state.frames.get_mut("child").unwrap().awaiting_renderer = false;
        let replacement = {
            let mut sessions = page.renderer_sessions.lock().unwrap();
            sessions.retire(&original);
            sessions
                .register_child(&root, "child", "replacement-session")
                .unwrap()
        };
        original.mark_ready();
        assert!(
            ready_frame_context(&page, &state, "child", METHOD, true)
                .unwrap()
                .is_none()
        );
        state.frames.get_mut("child").unwrap().session_identifier = "replacement-session".into();
        replacement.mark_ready();
        assert!(
            ready_frame_context(&page, &state, "child", METHOD, true)
                .unwrap()
                .is_none()
        );
        let replacement_context = ExecutionContext {
            session_identifier: "replacement-session".into(),
            identifier: 7,
            unique_identifier: "replacement-world".into(),
            frame_identifier: "child".into(),
        };
        state
            .main_worlds
            .insert("child".into(), replacement_context.clone());
        state
            .execution_contexts
            .insert(replacement_context.key(), replacement_context.clone());
        assert_eq!(
            ready_frame_context(&page, &state, "child", METHOD, true).unwrap(),
            Some(replacement_context.clone())
        );
        state.execution_contexts.remove(&replacement_context.key());
        assert!(
            ready_frame_context(&page, &state, "child", METHOD, true)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn failed_helper_retires_only_its_original_cache_entry() {
        let page = Page {
            context_identifier: "context".into(),
            target_identifier: "target".into(),
            session_identifier: "root-session".into(),
            state: Arc::new(PageState::default()),
        };
        let context = ExecutionContext {
            session_identifier: "child-session".into(),
            identifier: 1,
            unique_identifier: "unique-world".into(),
            frame_identifier: "frame".into(),
        };
        page.state
            .state
            .lock()
            .unwrap()
            .execution_contexts
            .insert(context.key(), context.clone());
        let failure = invalid(METHOD, "helper preparation failed");
        let (_, outcome) = watch::channel(Some(Err(failure)));
        let failed = Arc::new(EvaluationRuntime {
            context: context.clone(),
            outcome,
        });
        let (_cancellation, receiver) = watch::channel(false);
        let operation = Operation::new(METHOD.into(), None, receiver);
        page.state
            .evaluation_runtimes
            .lock()
            .unwrap()
            .insert(context.unique_identifier.clone(), failed.clone());
        assert_eq!(
            ready_runtime(&page, &failed, &operation, METHOD)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert!(page.state.evaluation_runtimes.lock().unwrap().is_empty());

        let (_, outcome) = watch::channel(Some(Ok("replacement-helper".into())));
        let replacement = Arc::new(EvaluationRuntime {
            context: context.clone(),
            outcome,
        });
        page.state
            .evaluation_runtimes
            .lock()
            .unwrap()
            .insert(context.unique_identifier.clone(), replacement.clone());
        assert_eq!(
            ready_runtime(&page, &failed, &operation, METHOD)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert!(Arc::ptr_eq(
            &page.state.evaluation_runtimes.lock().unwrap()[&context.unique_identifier],
            &replacement
        ));
    }
}
