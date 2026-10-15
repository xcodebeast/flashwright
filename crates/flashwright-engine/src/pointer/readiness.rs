//! Read-only retry hints never own native input or authorize a pointer dispatch.

use super::*;
use flashwright_browser::Connection;

#[cfg(test)]
mod tests;

pub(super) async fn wait(
    action: &PointerAction<'_>,
    realm: &LocatorRealm,
    request: &[u16],
    retry_count: usize,
) -> Result<bool, ErrorRecord> {
    let maximum_wait_milliseconds = [0, 20, 100, 100, 500][retry_count.min(4)];
    if maximum_wait_milliseconds == 0 {
        return Ok(false);
    }
    let wait_budget = Duration::from_millis(maximum_wait_milliseconds);
    let dispatch_deadline = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        + wait_budget)
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let renderer_deadline = action
        .operation
        .renderer_deadline()
        .map_or(dispatch_deadline, |deadline| {
            deadline.min(dispatch_deadline)
        });
    let token = action.engine.identifier("pointer-readiness");
    let mut command = action.browser.connection.start_command("Runtime.callFunctionOn", json!({
        "uniqueContextId": realm.context.unique_identifier,
        "functionDeclaration": "function(request, deadline, maximumWait, token, checked) { return globalThis.__flashwrightLocatorRuntime.waitForPointerReadiness(request, deadline, maximumWait, token, checked); }",
        "arguments": [{ "value": request }, { "value": renderer_deadline },
            { "value": maximum_wait_milliseconds }, { "value": token }, { "value": action.options.checked }],
        "returnByValue": true, "awaitPromise": true,
    }), Some(&realm.context.session_identifier))?;
    let result = timeout(
        wait_budget,
        action.operation.wait(
            action
                .page
                .state
                .while_execution_context(&realm.context, command.response()),
        ),
    )
    .await;
    let result = match result {
        Ok(result) => result,
        Err(_) => {
            if !command.prevent_dispatch() && command.try_response().is_none() {
                let connection = action.browser.connection.clone();
                let realm = realm.clone();
                let method = action.method.clone();
                tokio::spawn(async move {
                    cancel(
                        &connection,
                        &realm.context.unique_identifier,
                        &realm.context.session_identifier,
                        &method,
                        &token,
                        command,
                    )
                    .await
                });
            }
            // Hint expiry resumes ordinary checking; it is not a public timeout.
            action.operation.check()?;
            return Ok(true);
        }
    };
    match result {
        Ok(result) => {
            let result = runtime_value(result, &action.method)?;
            match result["status"].as_str() {
                Some("matched" | "expired" | "cancelled") => Ok(true),
                Some("limit") => Ok(false),
                Some("error") => outcome(result, &action.method).map(|_| true),
                _ => Err(invalid(&action.method, "invalid pointer readiness outcome")),
            }
        }
        Err(mut error) => {
            if command.prevent_dispatch() {
                error.cleanup = Some("notDispatched".into());
            } else if command.try_response().is_some() {
                error.cleanup = Some("residentConditionFinished".into());
            } else {
                let connection = action.browser.connection.clone();
                let realm = realm.clone();
                let method = action.method.clone();
                let mut cleanup = tokio::spawn(async move {
                    cancel(
                        &connection,
                        &realm.context.unique_identifier,
                        &realm.context.session_identifier,
                        &method,
                        &token,
                        command,
                    )
                    .await
                });
                error.cleanup = Some(
                    match timeout(Duration::from_millis(50), &mut cleanup).await {
                        Ok(Ok(status)) => status,
                        Ok(Err(_)) => "residentCleanupTaskFailed",
                        Err(_) => "residentCancellationPending",
                    }
                    .into(),
                );
            }
            if context_was_destroyed(&error) {
                action
                    .page
                    .state
                    .locator_realms
                    .lock()
                    .await
                    .remove(&action.frame);
                Ok(true)
            } else {
                Err(error)
            }
        }
    }
}

fn runtime_value(value: Value, method: &str) -> Result<Value, ErrorRecord> {
    check_exception(&value, method)?;
    value["result"]
        .get("value")
        .cloned()
        .ok_or_else(|| invalid(method, "Chromium omitted pointer readiness result"))
}

/// Read-only, finite hints do not justify closing their page when cancellation
/// fails. Keep both pending credits until their own replies or connection loss.
async fn cancel(
    connection: &Connection,
    context_identifier: &str,
    session_identifier: &str,
    method: &str,
    token: &str,
    mut original: Command,
) -> &'static str {
    let cancellation = connection.start_command("Runtime.callFunctionOn", json!({
        "uniqueContextId": context_identifier,
        "functionDeclaration": "function(token) { return globalThis.__flashwrightLocatorRuntime.cancelPointerReadiness(token); }",
        "arguments": [{ "value": token }], "returnByValue": true,
    }), Some(session_identifier));
    let settle_cancellation = async {
        match cancellation {
            Ok(mut cancellation) => cancellation
                .response()
                .await
                .and_then(|value| runtime_value(value, method)),
            Err(error) => Err(error),
        }
    };
    let (cancellation, _) = tokio::join!(settle_cancellation, original.response());
    match cancellation {
        Ok(value) if value.is_null() || value["status"] == "cancelled" => {
            "residentConditionReleased"
        }
        _ if original.browser_reply_received() => "residentConditionFinished",
        _ => "residentReplyFailed",
    }
}
