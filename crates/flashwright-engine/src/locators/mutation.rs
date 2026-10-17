//! By-value mutations never adopt objects into a successor world or replay uncertain effects.

use super::*;
use crate::page_state::ExecutionContext;
use crate::renderer_sessions::RendererSession;
use flashwright_browser::connection::Command;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[cfg(test)]
mod tests;

pub(super) struct Failure {
    pub error: ErrorRecord,
    pub pending: Option<PendingMutation>,
}

pub(super) struct PendingMutation {
    command: Command,
    owner: Option<Arc<RendererSession>>,
    cleanup_deadline: tokio::time::Instant,
    _admission: OwnedSemaphorePermit,
    settled: bool,
}

impl PendingMutation {
    pub(super) async fn requires_disposal(&mut self) -> bool {
        if tokio::time::timeout_at(self.cleanup_deadline, self.command.response())
            .await
            .is_ok()
        {
            self.settled = true;
            return false;
        }
        // Logical retirement is not proof that the original mutation has stopped.
        !self
            .owner
            .as_ref()
            .is_some_and(|owner| owner.is_destroyed())
    }

    pub(super) async fn finish(mut self) {
        if !self.settled {
            let _ = self.command.response().await;
        }
        // Keep admission and the original renderer through disposal and reply settlement.
        drop(self);
    }
}

pub(super) async fn admit(
    slots: &Arc<Semaphore>,
    page: &Page,
    context: &ExecutionContext,
    operation: &Operation,
) -> Result<OwnedSemaphorePermit, ErrorRecord> {
    operation
        .wait(page.state.while_execution_context(context, async {
            slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| invalid("locator.run", "mutation cleanup admission has closed"))
        }))
        .await
}

pub(super) async fn wait(
    page: &Page,
    context: &ExecutionContext,
    operation: &Operation,
    mut command: Command,
    admission: OwnedSemaphorePermit,
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
    let pending = if !consumed && !prevented && command.try_response().is_none() {
        // This command may be queued behind another evaluation. A renderer-wide
        // interrupt cannot identify whose JavaScript it would terminate. Report the
        // original error promptly while bounded cleanup retains native custody.
        error.cleanup = Some("pendingOriginalMutationReply".into());
        Some(PendingMutation {
            command,
            owner,
            _admission: admission,
            settled: false,
            cleanup_deadline: tokio::time::Instant::now()
                + crate::handle_allocation::CLEANUP_BUDGET,
        })
    } else {
        None
    };
    Err(Failure { error, pending })
}
