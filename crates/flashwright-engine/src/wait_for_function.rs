//! Retry requested predicates in their current main world while retaining exact allocation custody.

use super::handle_allocation::release_group;
use super::handles::{Handle, HandleAllocation};
use super::locators::{check_exception, context_was_destroyed};
use super::page_state::ExecutionContext;
use super::renderer_sessions::RendererSession;
use super::*;
use flashwright_browser::connection::Command;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::sleep;

const METHOD: &str = "frame.waitForFunction";
const FOREGROUND_CLEANUP: Duration = Duration::from_millis(50);

impl Engine {
    pub(crate) async fn wait_for_function(
        &self,
        mut parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        validate_keys(
            METHOD,
            &parameters,
            &[
                "page",
                "frame",
                "source",
                "isFunction",
                "argument",
                "handles",
                "polling",
            ],
        )?;
        let polling = parameters
            .get("polling")
            .cloned()
            .ok_or_else(|| invalid(METHOD, "polling is required"))?;
        if !polling.is_null()
            && !polling
                .as_f64()
                .is_some_and(|interval| interval.is_finite() && interval > 0.0)
        {
            return Err(invalid(
                METHOD,
                "polling must be null or a finite positive interval",
            ));
        }
        parameters.as_object_mut().unwrap().remove("polling");
        let page_identifier = identifier(&parameters, "page", METHOD)?.to_owned();
        let frame_identifier = identifier(&parameters, "frame", METHOD)?.to_owned();
        let page = self.page(&page_identifier, METHOD)?;
        loop {
            operation.check()?;
            check_wait_owner(&page, &frame_identifier)?;
            let reservation = self.reserve_handle(&page, METHOD)?;
            let result = self
                .function_wait_attempt(parameters.clone(), polling.clone(), reservation, operation)
                .await;
            match result {
                Err(error) if context_was_destroyed(&error) => {
                    let error = classify_context_loss(&page, &frame_identifier, operation, error);
                    if !context_was_destroyed(&error) {
                        return Err(error);
                    }
                    // Only this API requests repeated callback execution across document changes.
                    operation
                        .wait(wait_for_document_retry(&page, &frame_identifier))
                        .await?;
                }
                result => {
                    return result.map_err(|mut error| {
                        error.method = METHOD.into();
                        error
                    });
                }
            }
        }
    }

    async fn function_wait_attempt(
        &self,
        parameters: Value,
        polling: Value,
        reservation: OwnedSemaphorePermit,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let prepared = self
            .prepare_evaluation(METHOD, parameters, operation)
            .await?;
        let allocation = HandleAllocation {
            engine: self,
            page_identifier: &prepared.page_identifier,
            page: &prepared.page,
            browser: &prepared.browser,
            context: prepared.runtime.context.clone(),
            operation,
            method: METHOD,
            group: self.identifier("function-wait-group"),
            uses_object_group: true,
        };
        let mut reservation = Some(reservation);
        operation.check()?;
        let mut creation = prepared.browser.connection.start_command(
            "Runtime.callFunctionOn",
            prepared.waiter_parameters(&allocation.group, polling),
            Some(&allocation.context.session_identifier),
        )?;
        let mut consumed = false;
        let controller = operation
            .wait(
                prepared
                    .page
                    .state
                    .while_execution_context(&allocation.context, async {
                        let response = creation.response().await;
                        consumed = true;
                        response
                    }),
            )
            .await;
        let controller = match controller {
            Ok(response) => {
                let result = check_exception(&response, METHOD).and_then(|()| {
                    response["result"]["objectId"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            invalid(METHOD, "Chromium omitted the predicate controller identity")
                        })
                });
                match result {
                    Ok(controller) => controller,
                    Err(error) => return allocation.finish(Err(error)).await,
                }
            }
            Err(error) => {
                let error = classify_context_loss(
                    &prepared.page,
                    &allocation.context.frame_identifier,
                    operation,
                    error,
                );
                return cancel_attempt(
                    &allocation,
                    prepared.browser.clone(),
                    error,
                    (!consumed).then_some(creation),
                    None,
                    reservation.take().unwrap(),
                    prepared.retained_arguments(),
                )
                .await;
            }
        };
        if let Err(error) = operation.check() {
            return allocation.finish(Err(error)).await;
        }
        let mut command = match prepared.browser.connection.start_command(
            "Runtime.callFunctionOn",
            json!({
                "objectId": controller,
                "functionDeclaration": "function() { this.start(); return this.result; }",
                "awaitPromise": true, "returnByValue": false, "objectGroup": allocation.group,
                "userGesture": true,
            }),
            Some(&allocation.context.session_identifier),
        ) {
            Ok(command) => command,
            Err(error) => return allocation.finish(Err(error)).await,
        };
        consumed = false;
        let response = operation
            .wait(
                prepared
                    .page
                    .state
                    .while_execution_context(&allocation.context, async {
                        let response = command.response().await;
                        consumed = true;
                        response
                    }),
            )
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                let error = classify_context_loss(
                    &prepared.page,
                    &allocation.context.frame_identifier,
                    operation,
                    error,
                );
                return cancel_attempt(
                    &allocation,
                    prepared.browser.clone(),
                    error,
                    (!consumed).then_some(command),
                    Some(controller),
                    reservation.take().unwrap(),
                    prepared.retained_arguments(),
                )
                .await;
            }
        };
        let result = async {
            if response["result"]["objectId"].as_str().is_none() {
                check_exception(&response, METHOD)?;
            }
            let value = allocation.evaluation_value(&response).await?;
            let mut release = prepared.browser.connection.start_command(
                "Runtime.releaseObject", json!({ "objectId": controller }),
                Some(&allocation.context.session_identifier),
            )?;
            allocation.wait(&mut release, false).await?;
            let handle = allocation.retain(value, reservation.take().unwrap())?;
            Ok(json!({ "page": prepared.page_identifier, "group": allocation.group, "handles": [handle] }))
        }.await;
        allocation.finish(result).await
    }
}

/// A logical frame's retirement is terminal even when its world disappeared first.
fn check_wait_owner(page: &Page, frame_identifier: &str) -> Result<(), ErrorRecord> {
    let state = page.state.state.lock().unwrap();
    state.check(METHOD)?;
    if !state.frames.contains_key(frame_identifier) {
        return Err(ErrorRecord::new(
            ErrorCode::TargetClosed,
            METHOD,
            "frame has been detached",
        ));
    }
    Ok(())
}

/// Classify retirement before cleanup's grace can consume the remaining call deadline.
fn classify_context_loss(
    page: &Page,
    frame_identifier: &str,
    operation: &Operation,
    error: ErrorRecord,
) -> ErrorRecord {
    if !context_was_destroyed(&error) {
        return error;
    }
    // Explicit cancellation already observed by the host takes precedence over later detachment.
    if let Err(cancellation) = operation.check()
        && cancellation.code == ErrorCode::Cancelled
    {
        return cancellation;
    }
    check_wait_owner(page, frame_identifier)
        .err()
        .unwrap_or(error)
}

/// Frame or parent retirement also interrupts the navigation backoff itself.
async fn wait_for_document_retry(page: &Page, frame_identifier: &str) -> Result<(), ErrorRecord> {
    let mut changes = page.state.changed.subscribe();
    let retirement = async {
        loop {
            check_wait_owner(page, frame_identifier)?;
            if changes.changed().await.is_err() {
                return Err(closed(METHOD));
            }
        }
    };
    tokio::select! {
        biased;
        result = retirement => result,
        _ = sleep(Duration::from_millis(100)) => Ok(()),
    }
}

/// The task owns its commands and reservation beyond the caller's short foreground grace.
async fn cancel_attempt(
    allocation: &HandleAllocation<'_>,
    browser: Arc<Chromium>,
    mut error: ErrorRecord,
    command: Option<Command>,
    controller: Option<String>,
    reservation: OwnedSemaphorePermit,
    retained_arguments: Vec<Handle>,
) -> Result<Value, ErrorRecord> {
    let cleanup = FunctionWaitCleanup {
        page: allocation.page.clone(),
        browser,
        context: allocation.context.clone(),
        group: allocation.group.clone(),
        command,
        controller,
        session: allocation
            .page
            .state
            .renderer_sessions
            .lock()
            .unwrap()
            .original(&allocation.context.session_identifier),
        reservation: Some(reservation),
        retained_arguments,
    };
    let mut task = tokio::spawn(cleanup.run());
    error.cleanup = Some(
        match timeout(FOREGROUND_CLEANUP, &mut task).await {
            Ok(Ok(status)) => status,
            Ok(Err(_)) => "functionWaitCleanupTaskFailed",
            Err(_) => "functionWaitCancellationPending",
        }
        .into(),
    );
    Err(error)
}

struct FunctionWaitCleanup {
    page: Page,
    browser: Arc<Chromium>,
    context: ExecutionContext,
    group: String,
    command: Option<Command>,
    controller: Option<String>,
    session: Option<Arc<RendererSession>>,
    reservation: Option<OwnedSemaphorePermit>,
    retained_arguments: Vec<Handle>,
}

impl FunctionWaitCleanup {
    fn world_is_alive(&self) -> bool {
        self.browser.connection.failure().is_none()
            && self
                .page
                .state
                .state
                .lock()
                .unwrap()
                .context_is_alive(&self.context)
    }

    async fn run(mut self) -> &'static str {
        // These reservations retain admission even after the caller has returned a timeout.
        let reservation = self.reservation.take().unwrap();
        let retained_arguments = std::mem::take(&mut self.retained_arguments);
        if let Some(controller) = &self.controller {
            loop {
                if !self.world_is_alive() {
                    break;
                }
                let cancellation = self.browser.connection.start_command("Runtime.callFunctionOn", json!({
                    "objectId": controller, "functionDeclaration": "function() { this.abort(); }",
                    "returnByValue": true,
                }), Some(&self.context.session_identifier));
                match cancellation {
                    Err(error) if error.code == ErrorCode::ResourceLimit => {
                        // No dispatch occurred: retry only admission, retaining the original waiter.
                        sleep(Duration::from_millis(100)).await;
                    }
                    Ok(mut command) => {
                        let response = tokio::select! {
                            response = command.response() => response,
                            _ = self.wait_for_session_loss() => Err(closed(METHOD)),
                        };
                        if response
                            .and_then(|response| check_exception(&response, METHOD))
                            .is_err()
                        {
                            self.wait_for_world_loss().await;
                        }
                        break;
                    }
                    Err(_) => {
                        self.wait_for_world_loss().await;
                        break;
                    }
                }
            }
        }
        if let Some(mut command) = self.command.take()
            && !command.prevent_dispatch()
        {
            // Realm loss does not discard a still-pending allocating reply.
            tokio::select! {
                _ = command.response() => {},
                _ = self.wait_for_session_loss() => {},
            }
        }
        let status = if self.world_is_alive() {
            tokio::select! {
                result = release_group(
                    &self.browser.connection,
                    &self.context.session_identifier,
                    &self.group,
                ) => {
                    if result.is_err() {
                        self.wait_for_world_loss().await;
                        "functionWaitWorldDestroyed"
                    } else {
                        "functionWaitGroupDisposed"
                    }
                },
                _ = self.wait_for_world_loss() => "functionWaitWorldDestroyed",
            }
        } else {
            "functionWaitWorldDestroyed"
        };
        drop((reservation, retained_arguments));
        status
    }

    async fn wait_for_world_loss(&self) {
        let mut changes = self.page.state.changed.subscribe();
        let mut events = self.browser.connection.subscribe();
        while self.world_is_alive() {
            tokio::select! {
                _ = changes.changed() => {},
                _ = events.recv() => {},
            }
        }
    }

    /// Semantic page failure alone cannot discard a dispatched allocation in a live session.
    async fn wait_for_session_loss(&self) {
        let mut changes = self.page.state.changed.subscribe();
        let mut events = self.browser.connection.subscribe();
        while self.browser.connection.failure().is_none()
            && !self
                .session
                .as_ref()
                .is_some_and(|session| session.is_destroyed())
        {
            tokio::select! {
                _ = changes.changed() => {},
                _ = events.recv() => {},
            }
        }
    }
}
