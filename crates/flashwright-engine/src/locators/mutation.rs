//! By-value mutations never adopt objects into a successor world or replay uncertain effects.

use super::*;
use crate::handle_allocation::recover_failed_allocation;
use crate::page_state::ExecutionContext;
use flashwright_browser::{Connection, connection::Command};

#[cfg(test)]
mod tests;

pub(super) struct Failure {
    pub error: ErrorRecord,
    pub dispose_page: bool,
}

pub(super) async fn wait(
    connection: &Connection,
    page: &Page,
    context: &ExecutionContext,
    operation: &Operation,
    mut command: Command,
) -> Result<Value, Failure> {
    let owner = page
        .state
        .renderer_sessions
        .lock()
        .unwrap()
        .original(&context.session_identifier);
    let mut consumed = false;
    let result = operation
        .wait(page.state.while_execution_context(context, async {
            let reply = command.response().await;
            consumed = true;
            reply
        }))
        .await;
    let mut error = match result {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    let prevented = command.prevent_dispatch();
    if !prevented && !context_was_not_found(&error) {
        error.input_delivery = InputDelivery::Uncertain;
    }
    let mut dispose_page = false;
    if !consumed && !prevented {
        let failure =
            recover_failed_allocation(connection, page, context, &mut command, true, error).await;
        error = failure.error;
        if failure.reply_pending {
            // Logical retirement can precede physical destruction during a renderer swap.
            // Only confirmed original-session destruction avoids retiring the owned page.
            dispose_page = !owner.as_ref().is_some_and(|owner| owner.is_destroyed());
            error.cleanup = Some("pendingOriginalMutationReply".into());
            crate::input::retain_renderer_reply(command, owner);
        }
    }
    Err(Failure {
        error,
        dispose_page,
    })
}
