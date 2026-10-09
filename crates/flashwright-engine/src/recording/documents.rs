//! Chunk enrollment never holds the recording lock while inspecting a page or awaiting work.

use super::*;
use crate::snapshots::{SnapshotDocument, SnapshotRealm, SnapshotUnavailable};
use std::future::Future;
use tokio::time::sleep_until;

pub(super) struct CaptureOwner {
    pub context: Context,
    pub recording: String,
    pub chunk: String,
    pub call: String,
    pub phase: SnapshotPhase,
    pub page_identifier: String,
    pub page: Page,
}

pub(super) struct CaptureAllowance {
    pub deadline: tokio::time::Instant,
    pub cancellation: watch::Receiver<bool>,
}

impl CaptureAllowance {
    pub(super) async fn wait<Output>(
        &self,
        context: &context_state::ContextState,
        work: impl Future<Output = Result<Output, SnapshotFailure>>,
    ) -> Result<Output, SnapshotFailure> {
        let mut cancellation = self.cancellation.clone();
        let mut closed = context.closed.subscribe();
        tokio::select! {
            biased;
            _=closed.wait_for(|closed|closed.is_some())=>Err(SnapshotFailure::Unavailable(SnapshotUnavailable::OriginalDocumentChanged)),
            _=cancellation.wait_for(|cancelled|*cancelled)=>Err(ErrorRecord::new(ErrorCode::Cancelled,"tracing.snapshot","original call was cancelled").into()),
            _=sleep_until(self.deadline)=>Err(ErrorRecord::new(ErrorCode::Timeout,"tracing.snapshot","original snapshot allowance expired").into()),
            result=work=>result,
        }
    }
}

impl Engine {
    pub(super) async fn snapshot_document(
        &self,
        owner: &CaptureOwner,
        realm: SnapshotRealm,
        allowance: &CaptureAllowance,
    ) -> Result<Arc<SnapshotDocument>, SnapshotFailure> {
        let session = self.diagnostic_session(&owner.page_identifier, &owner.page)?;
        let document_identity = (
            owner.page_identifier.clone(),
            realm.main_context.unique_identifier.clone(),
        );
        let budget = self
            .snapshot_budget
            .get_or_init(|| Arc::new(snapshots::SnapshotBudget::default()));
        loop {
            let enrollment = allowance
                .wait(&owner.context.state, async {
                    Ok(owner.context.state.snapshot_enrollment.lock().await)
                })
                .await?;
            let mut changes = budget.changes();
            let existing = {
                let mut state = owner.context.state.recording.lock().unwrap();
                let recording = state.get_mut(&owner.recording)?;
                if let Some(error) = &recording.failure {
                    return Err(error.clone().into());
                }
                let chunk = recording.original_chunk(&owner.chunk)?;
                if chunk
                    .calls
                    .get(&owner.call)
                    .and_then(|phases| phases.get(&owner.phase))
                    != Some(&PhaseState::Pending)
                {
                    return Err(invalid(
                        "tracing.snapshot",
                        "document enrollment has no original pending phase",
                    )
                    .into());
                }
                chunk.documents.retain(|_, document| !document.finished());
                chunk.documents.get(&document_identity).cloned()
            };
            if let Some(document) = existing {
                if document.accepting() {
                    return Ok(document);
                }
                drop(enrollment);
                allowance
                    .wait(&owner.context.state, async {
                        document.wait_finished().await;
                        Ok(())
                    })
                    .await?;
                continue;
            }
            if budget.owns_document(
                &owner.page.context_identifier,
                &owner.page.session_identifier,
                &realm.main_context.unique_identifier,
            ) {
                drop(enrollment);
                allowance
                    .wait(&owner.context.state, async {
                        changes
                            .changed()
                            .await
                            .map_err(|_| SnapshotFailure::Failed(closed("tracing.snapshot")))
                    })
                    .await?;
                continue;
            }
            // Revalidate after every possible wait, then start without any recording/registry guard held.
            self.diagnostic_session(&owner.page_identifier, &owner.page)?;
            let browser = self.browser(&owner.context.browser_identifier, "tracing.snapshot")?;
            let document = Arc::new(SnapshotDocument::start(
                &self.identifier("snapshot"),
                owner.page.clone(),
                realm.clone(),
                browser.connection.clone(),
                budget,
                session.clone(),
            )?);
            let mut state = owner.context.state.recording.lock().unwrap();
            let recording = state.get_mut(&owner.recording)?;
            recording
                .original_chunk(&owner.chunk)?
                .documents
                .insert(document_identity.clone(), document.clone());
            if let Some(error) = &recording.failure {
                document.close();
                return Err(error.clone().into());
            }
            return Ok(document);
        }
    }
}
