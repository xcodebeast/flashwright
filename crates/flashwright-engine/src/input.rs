//! Shared native input dispatch, page ownership and action/navigation completion.

use super::*;
use flashwright_browser::connection::Command;
use flashwright_protocol::InputDelivery;

#[cfg(test)]
mod tests;

/// Cancellation cannot release the native credit for input whose dispatch has started.
fn retain_pending_reply(mut command: Command) {
    if command.browser_reply_received()
        || command.prevent_dispatch()
        || command.try_response().is_some()
    {
        return;
    }
    tokio::spawn(settle_pending_reply(command));
}

async fn settle_pending_reply(mut command: Command) {
    // Logical page loss does not prove that its native input command has settled.
    let _ = command.response().await;
}

pub(crate) struct InputDispatch {
    pub result: Result<(), ErrorRecord>,
    pub delivery: InputDelivery,
}

pub(crate) struct InputSequenceDispatch {
    pub result: Result<(), ErrorRecord>,
    pub deliveries: Vec<InputDelivery>,
}

/// Both input paths classify cancellation and retain the original unsettled reply identically.
async fn complete_input_command(
    page: &Page,
    mut command: Command,
    operation: &Operation,
    public_method: &str,
    previous_failure: Option<&ErrorRecord>,
) -> InputDispatch {
    let result = match previous_failure {
        Some(error) => Err(error.clone()),
        None => {
            operation
                .wait(page.state.while_alive(public_method, command.response()))
                .await
        }
    };
    let delivery = if result.is_ok() {
        InputDelivery::Acknowledged
    } else if command.prevent_dispatch() {
        InputDelivery::NotDispatched
    } else if matches!(command.try_response(), Some(Ok(_))) {
        InputDelivery::Acknowledged
    } else {
        InputDelivery::Uncertain
    };
    operation.record_input_delivery(delivery);
    retain_pending_reply(command);
    InputDispatch {
        delivery,
        result: result.map(|_| ()).map_err(|mut error| {
            error.method = public_method.into();
            error.input_delivery = error.input_delivery.max(operation.input_delivery());
            error
        }),
    }
}

/// Queue ordered native input before awaiting acknowledgements. After an error,
/// withdraw every command that has not started and account for all remaining replies.
pub(crate) async fn dispatch_input_sequence(
    page: &Page,
    browser: &Chromium,
    method: &str,
    parameters: Vec<Value>,
    operation: &Operation,
    public_method: &str,
) -> InputSequenceDispatch {
    let mut deliveries = vec![InputDelivery::NotDispatched; parameters.len()];
    let commands = operation.check().and_then(|()| {
        page.trace_before_input(operation);
        browser
            .connection
            .start_commands(method, parameters, Some(&page.session_identifier))
    });
    let commands = match commands {
        Ok(commands) => commands,
        Err(mut error) => {
            error.method = public_method.into();
            error.input_delivery = error.input_delivery.max(operation.input_delivery());
            return InputSequenceDispatch {
                result: Err(error),
                deliveries,
            };
        }
    };
    let mut failure: Option<ErrorRecord> = None;
    for (command, delivery) in commands.into_iter().zip(&mut deliveries) {
        let dispatch =
            complete_input_command(page, command, operation, public_method, failure.as_ref()).await;
        *delivery = dispatch.delivery;
        if failure.is_none() {
            failure = dispatch.result.err();
        }
    }
    let result = match failure {
        None => Ok(()),
        Some(mut error) => {
            error.method = public_method.into();
            error.input_delivery = error.input_delivery.max(operation.input_delivery());
            Err(error)
        }
    };
    InputSequenceDispatch { result, deliveries }
}

/// Keep per-command dispatch certainty separate from cumulative operation progress.
pub(crate) async fn dispatch_input(
    page: &Page,
    browser: &Chromium,
    method: &str,
    parameters: Value,
    operation: &Operation,
    public_method: &str,
) -> InputDispatch {
    let command = operation.check().and_then(|()| {
        page.trace_before_input(operation);
        browser
            .connection
            .start_command(method, parameters, Some(&page.session_identifier))
    });
    let command = match command {
        Ok(command) => command,
        Err(mut error) => {
            error.method = public_method.into();
            error.input_delivery = error.input_delivery.max(operation.input_delivery());
            return InputDispatch {
                result: Err(error),
                delivery: InputDelivery::NotDispatched,
            };
        }
    };
    complete_input_command(page, command, operation, public_method, None).await
}

impl Page {
    pub(crate) async fn input_sequence_start(
        &self,
        browser: &Chromium,
        operation: &Operation,
        method: &str,
    ) -> Result<u64, ErrorRecord> {
        operation
            .wait(
                self.state
                    .while_alive(method, browser.connection.synchronize_events()),
            )
            .await?;
        Ok(self.state.state.lock().unwrap().sequence)
    }

    pub(crate) async fn complete_input(
        &self,
        browser: &Chromium,
        after: u64,
        operation: &Operation,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        operation
            .wait(
                self.state.while_alive(
                    method,
                    browser.connection.call(
                        "Page.enable",
                        json!({}),
                        Some(&self.session_identifier),
                    ),
                ),
            )
            .await?;
        self.input_sequence_start(browser, operation, method)
            .await?;
        self.wait_for_input_navigation(after, operation, method)
            .await
    }

    pub(crate) async fn wait_for_input_navigation(
        &self,
        after: u64,
        operation: &Operation,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        let mut changes = self.state.changed.subscribe();
        loop {
            let waiting = {
                let state = self.state.state.lock().unwrap();
                state.check(method)?;
                state
                    .main_frame
                    .as_ref()
                    .and_then(|identifier| state.frames.get(identifier))
                    .and_then(|frame| frame.pending_navigation.as_ref())
                    .is_some_and(|navigation| navigation.sequence > after)
            };
            if !waiting {
                return Ok(());
            }
            operation
                .wait(async { changes.changed().await.map_err(|_| closed(method)) })
                .await?;
        }
    }
}
