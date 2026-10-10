//! Snapshot grants remain owned by the worker until browser completion is known.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

const MAXIMUM_DOCUMENTS: usize = 128;
const MAXIMUM_CONTEXT_DOCUMENTS: usize = 32;
const MAXIMUM_EVALUATIONS: usize = 2;
const MAXIMUM_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAXIMUM_CONTEXT_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAXIMUM_PAYLOADS: usize = 128;
const MAXIMUM_CONTEXT_PAYLOADS: usize = 64;
pub(super) const MAXIMUM_REPLY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct CacheGrant {
    pub bytes: usize,
    pub nodes: usize,
    pub attributes: usize,
    pub sheets: usize,
}

impl CacheGrant {
    const ENGINE: Self = Self {
        bytes: 32 * 1024 * 1024,
        nodes: 100000,
        attributes: 400000,
        sheets: 4096,
    };
    const GENERATION: Self = Self {
        bytes: 2 * 1024 * 1024,
        nodes: 12500,
        attributes: 50000,
        sheets: 512,
    };

    fn available_generation(used: Self) -> Self {
        Self {
            bytes: Self::GENERATION
                .bytes
                .min((Self::ENGINE.bytes - used.bytes) / 2),
            nodes: Self::GENERATION
                .nodes
                .min((Self::ENGINE.nodes - used.nodes) / 2),
            attributes: Self::GENERATION
                .attributes
                .min((Self::ENGINE.attributes - used.attributes) / 2),
            sheets: Self::GENERATION
                .sheets
                .min((Self::ENGINE.sheets - used.sheets) / 2),
        }
    }

    fn reserve_pair(&mut self, generation: Self) {
        self.bytes += 2 * generation.bytes;
        self.nodes += 2 * generation.nodes;
        self.attributes += 2 * generation.attributes;
        self.sheets += 2 * generation.sheets;
    }

    fn release_pair(&mut self, generation: Self) {
        self.bytes -= 2 * generation.bytes;
        self.nodes -= 2 * generation.nodes;
        self.attributes -= 2 * generation.attributes;
        self.sheets -= 2 * generation.sheets;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AdmissionError {
    DocumentLimit,
    DocumentBusy,
    EvaluationLimit,
    PayloadLimit,
    EvaluationPending,
    PayloadAlreadyTaken,
    PayloadExceedsReservation,
    InvalidContext,
    InvalidDocument,
    DocumentAlreadyOwned,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct DocumentIdentity {
    context: String,
    session: String,
    unique_context: String,
}

#[derive(Default)]
struct ContextUsage {
    documents: usize,
    payloads: usize,
    payload_bytes: usize,
}

#[derive(Default)]
struct Usage {
    documents: usize,
    evaluations: usize,
    payloads: usize,
    payload_bytes: usize,
    cache: CacheGrant,
    contexts: HashMap<String, ContextUsage>,
    owners: HashSet<DocumentIdentity>,
}

impl Usage {
    /// Retired documents can leave charged payloads behind until archive and transport release them.
    fn remove_empty_context(&mut self, context: &str) {
        let retained = &self.contexts[context];
        if retained.documents == 0 && retained.payloads == 0 {
            debug_assert_eq!(retained.payload_bytes, 0);
            self.contexts.remove(context);
        }
    }
}

pub(crate) struct SnapshotBudget {
    usage: Mutex<Usage>,
    available: watch::Sender<()>,
}

impl Default for SnapshotBudget {
    fn default() -> Self {
        Self {
            usage: Mutex::new(Usage::default()),
            available: watch::channel(()).0,
        }
    }
}

struct DocumentAccount {
    budget: Arc<SnapshotBudget>,
    context: String,
    identity: DocumentIdentity,
    generation: CacheGrant,
    busy: Mutex<bool>,
}

/// The worker retains this owner through factory release or original-realm destruction.
pub(super) struct DocumentReservation {
    account: Arc<DocumentAccount>,
}

/// Waiting callers do not own this guard: the independently running worker does.
pub(super) struct CaptureReservation {
    account: Arc<DocumentAccount>,
    evaluating: bool,
    evaluation_settled: bool,
    owns_document_capture: bool,
    payload: Option<PayloadReservation>,
}

/// A prepared payload can outlive the browser cache transaction and its caller.
pub(crate) struct PayloadReservation {
    budget: Arc<SnapshotBudget>,
    context: String,
    bytes: usize,
}

impl std::fmt::Debug for PayloadReservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PayloadReservation")
            .field("bytes", &self.bytes)
            .finish_non_exhaustive()
    }
}

impl SnapshotBudget {
    pub(crate) fn changes(&self) -> watch::Receiver<()> {
        self.available.subscribe()
    }

    pub(crate) fn owns_document(&self, context: &str, session: &str, unique_context: &str) -> bool {
        self.usage.lock().unwrap().owners.iter().any(|owner| {
            owner.context == context
                && owner.session == session
                && owner.unique_context == unique_context
        })
    }

    /// Fixed two-generation grants bound capture growth without mutation-time accounting.
    /// Cache pressure may reduce any optional cache dimension all the way to zero.
    pub(super) fn reserve_document(
        self: &Arc<Self>,
        context: &str,
        session: &str,
        unique_context: &str,
    ) -> Result<DocumentReservation, AdmissionError> {
        if context.is_empty() || context.len() > 64 {
            return Err(AdmissionError::InvalidContext);
        }
        if session.is_empty()
            || session.len() > 256
            || unique_context.is_empty()
            || unique_context.len() > 256
        {
            return Err(AdmissionError::InvalidDocument);
        }
        let identity = DocumentIdentity {
            context: context.into(),
            session: session.into(),
            unique_context: unique_context.into(),
        };
        let mut usage = self.usage.lock().unwrap();
        if usage.owners.contains(&identity) {
            return Err(AdmissionError::DocumentAlreadyOwned);
        }
        if usage.documents == MAXIMUM_DOCUMENTS
            || usage
                .contexts
                .get(context)
                .is_some_and(|context| context.documents == MAXIMUM_CONTEXT_DOCUMENTS)
        {
            return Err(AdmissionError::DocumentLimit);
        }
        let generation = CacheGrant::available_generation(usage.cache);
        usage.cache.reserve_pair(generation);
        usage.documents += 1;
        usage.owners.insert(identity.clone());
        usage.contexts.entry(context.into()).or_default().documents += 1;
        Ok(DocumentReservation {
            account: Arc::new(DocumentAccount {
                budget: self.clone(),
                context: context.into(),
                identity,
                generation,
                busy: Mutex::new(false),
            }),
        })
    }
}

impl DocumentReservation {
    pub(super) fn admission_changes(&self) -> watch::Receiver<()> {
        self.account.budget.available.subscribe()
    }

    pub(super) fn generation_grant(&self) -> CacheGrant {
        self.account.generation
    }

    /// Bound queued intents before waiting; full reply bytes belong only to admitted evaluations.
    pub(super) fn reserve_capture(&self) -> Result<CaptureReservation, AdmissionError> {
        let mut usage = self.account.budget.usage.lock().unwrap();
        let context = &usage.contexts[&self.account.context];
        if usage.payloads == MAXIMUM_PAYLOADS || context.payloads == MAXIMUM_CONTEXT_PAYLOADS {
            return Err(AdmissionError::PayloadLimit);
        }
        usage.payloads += 1;
        let context = usage.contexts.get_mut(&self.account.context).unwrap();
        context.payloads += 1;
        Ok(CaptureReservation {
            account: self.account.clone(),
            evaluating: false,
            evaluation_settled: false,
            owns_document_capture: false,
            payload: Some(PayloadReservation {
                budget: self.account.budget.clone(),
                context: self.account.context.clone(),
                bytes: 0,
            }),
        })
    }
}

impl CaptureReservation {
    pub(super) fn admission_changes(&self) -> watch::Receiver<()> {
        self.account.budget.available.subscribe()
    }

    /// Subscribe before checking so a completed transaction cannot lose its wakeup.
    pub(super) fn begin_evaluation(&mut self) -> Result<(), AdmissionError> {
        if self.evaluating || self.evaluation_settled || self.owns_document_capture {
            return Err(AdmissionError::DocumentBusy);
        }
        let mut busy = self.account.busy.lock().unwrap();
        if *busy {
            return Err(AdmissionError::DocumentBusy);
        }
        let mut usage = self.account.budget.usage.lock().unwrap();
        if usage.evaluations == MAXIMUM_EVALUATIONS {
            return Err(AdmissionError::EvaluationLimit);
        }
        let context = &usage.contexts[&self.account.context];
        if usage.payload_bytes + MAXIMUM_REPLY_BYTES > MAXIMUM_PAYLOAD_BYTES
            || context.payload_bytes + MAXIMUM_REPLY_BYTES > MAXIMUM_CONTEXT_PAYLOAD_BYTES
        {
            return Err(AdmissionError::PayloadLimit);
        }
        usage.payload_bytes += MAXIMUM_REPLY_BYTES;
        usage
            .contexts
            .get_mut(&self.account.context)
            .unwrap()
            .payload_bytes += MAXIMUM_REPLY_BYTES;
        self.payload.as_mut().unwrap().bytes = MAXIMUM_REPLY_BYTES;
        usage.evaluations += 1;
        *busy = true;
        self.evaluating = true;
        self.owns_document_capture = true;
        Ok(())
    }

    /// Release the document before acknowledging a settled decision to its caller.
    pub(super) fn transaction_finished(&mut self) -> Result<(), AdmissionError> {
        if self.evaluating {
            return Err(AdmissionError::EvaluationPending);
        }
        if self.owns_document_capture {
            *self.account.busy.lock().unwrap() = false;
            self.owns_document_capture = false;
            self.account.budget.available.send_replace(());
        }
        Ok(())
    }

    /// Only an original reply, prevented dispatch, or confirmed owner destruction permits this.
    /// A host timeout and object-group release while evaluation is pending do not.
    pub(super) fn evaluation_finished(&mut self) {
        if self.evaluating {
            self.account.budget.usage.lock().unwrap().evaluations -= 1;
            self.evaluating = false;
            self.evaluation_settled = true;
            self.account.budget.available.send_replace(());
        }
    }

    /// Account DATA plus its retained metadata allowance before handing it to publication.
    pub(super) fn take_payload(
        &mut self,
        retained_bytes: usize,
    ) -> Result<PayloadReservation, AdmissionError> {
        if !self.evaluation_settled {
            return Err(AdmissionError::EvaluationPending);
        }
        let payload = self
            .payload
            .as_mut()
            .ok_or(AdmissionError::PayloadAlreadyTaken)?;
        if retained_bytes > payload.bytes {
            return Err(AdmissionError::PayloadExceedsReservation);
        }
        let released = payload.bytes - retained_bytes;
        let mut usage = self.account.budget.usage.lock().unwrap();
        usage.payload_bytes -= released;
        usage
            .contexts
            .get_mut(&self.account.context)
            .unwrap()
            .payload_bytes -= released;
        payload.bytes = retained_bytes;
        drop(usage);
        self.account.budget.available.send_replace(());
        Ok(self.payload.take().unwrap())
    }
}

impl Drop for CaptureReservation {
    fn drop(&mut self) {
        self.evaluation_finished();
        self.transaction_finished()
            .expect("evaluation was marked finished");
    }
}

impl Drop for PayloadReservation {
    fn drop(&mut self) {
        let mut usage = self.budget.usage.lock().unwrap();
        usage.payloads -= 1;
        usage.payload_bytes -= self.bytes;
        let context = usage.contexts.get_mut(&self.context).unwrap();
        context.payloads -= 1;
        context.payload_bytes -= self.bytes;
        usage.remove_empty_context(&self.context);
        drop(usage);
        self.budget.available.send_replace(());
    }
}

impl Drop for DocumentAccount {
    fn drop(&mut self) {
        let mut usage = self.budget.usage.lock().unwrap();
        usage.documents -= 1;
        usage.owners.remove(&self.identity);
        usage.cache.release_pair(self.generation);
        let context = usage.contexts.get_mut(&self.context).unwrap();
        context.documents -= 1;
        usage.remove_empty_context(&self.context);
        drop(usage);
        self.budget.available.send_replace(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(
        budget: &Arc<SnapshotBudget>,
        context: &str,
    ) -> Result<DocumentReservation, AdmissionError> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT_DOCUMENT: AtomicUsize = AtomicUsize::new(1);
        budget.reserve_document(
            context,
            "session",
            &format!("document-{}", NEXT_DOCUMENT.fetch_add(1, Ordering::Relaxed)),
        )
    }

    fn started(document: &DocumentReservation) -> CaptureReservation {
        let mut capture = document.reserve_capture().unwrap();
        capture.begin_evaluation().unwrap();
        capture
    }

    fn empty(budget: &SnapshotBudget) {
        let usage = budget.usage.lock().unwrap();
        assert_eq!(usage.documents, 0);
        assert_eq!(usage.evaluations, 0);
        assert_eq!(usage.payloads, 0);
        assert_eq!(usage.payload_bytes, 0);
        assert_eq!(usage.cache, CacheGrant::default());
        assert!(usage.contexts.is_empty());
        assert!(usage.owners.is_empty());
    }

    #[test]
    fn cache_pressure_reduces_optional_grants_without_rejecting_documents() {
        let budget = Arc::new(SnapshotBudget::default());
        let documents: Vec<_> = (0..10)
            .map(|_| document(&budget, "context").unwrap())
            .collect();
        assert_eq!(documents[0].generation_grant(), CacheGrant::GENERATION);
        assert_eq!(documents[4].generation_grant().nodes, 0);
        assert_eq!(documents[4].generation_grant().sheets, 0);
        assert_eq!(documents[7].generation_grant().bytes, 2 * 1024 * 1024);
        assert_eq!(documents[8].generation_grant(), CacheGrant::default());
        let mut uncached = started(&documents[8]);
        uncached.evaluation_finished();
        drop(uncached);
        drop(documents);
        empty(&budget);
    }

    #[test]
    fn document_and_context_limits_rollback_without_unbounded_namespace_growth() {
        let budget = Arc::new(SnapshotBudget::default());
        let mut documents = Vec::new();
        for context in 0..4 {
            for _ in 0..MAXIMUM_CONTEXT_DOCUMENTS {
                documents.push(document(&budget, &context.to_string()).unwrap());
            }
            assert!(matches!(
                document(&budget, &context.to_string()),
                Err(AdmissionError::DocumentLimit)
            ));
        }
        assert!(matches!(
            document(&budget, "new-context"),
            Err(AdmissionError::DocumentLimit)
        ));
        assert_eq!(budget.usage.lock().unwrap().contexts.len(), 4);
        assert!(matches!(
            document(&budget, &"x".repeat(65)),
            Err(AdmissionError::InvalidContext)
        ));
        documents.clear();
        empty(&budget);
        drop(document(&budget, "replacement").unwrap());
        empty(&budget);
    }

    #[test]
    fn pending_evaluation_keeps_every_credit_after_its_document_handle_is_dropped() {
        let budget = Arc::new(SnapshotBudget::default());
        let first = document(&budget, "first").unwrap();
        let second = document(&budget, "second").unwrap();
        let third = document(&budget, "third").unwrap();
        let mut first_capture = started(&first);
        let second_capture = started(&second);
        let mut same_document = first.reserve_capture().unwrap();
        assert!(matches!(
            same_document.begin_evaluation(),
            Err(AdmissionError::DocumentBusy)
        ));
        drop(same_document);
        let mut third_capture = third.reserve_capture().unwrap();
        assert!(matches!(
            third_capture.begin_evaluation(),
            Err(AdmissionError::EvaluationLimit)
        ));
        assert!(matches!(
            first_capture.take_payload(1024),
            Err(AdmissionError::EvaluationPending)
        ));
        drop(first);
        drop(second);
        assert_eq!(budget.usage.lock().unwrap().evaluations, 2);
        assert_eq!(budget.usage.lock().unwrap().documents, 3);
        first_capture.evaluation_finished();
        third_capture.begin_evaluation().unwrap();
        drop(first_capture);
        drop(second_capture);
        drop(third_capture);
        drop(third);
        empty(&budget);
    }

    #[test]
    fn prepared_data_outlives_transaction_but_cannot_release_a_successor_charge() {
        let budget = Arc::new(SnapshotBudget::default());
        let document = document(&budget, "context").unwrap();
        let mut capture = started(&document);
        capture.evaluation_finished();
        assert!(matches!(
            capture.take_payload(MAXIMUM_REPLY_BYTES + 1),
            Err(AdmissionError::PayloadExceedsReservation)
        ));
        let payload = capture.take_payload(65536).unwrap();
        assert!(matches!(
            capture.take_payload(1),
            Err(AdmissionError::PayloadAlreadyTaken)
        ));
        let mut successor = document.reserve_capture().unwrap();
        assert!(matches!(
            successor.begin_evaluation(),
            Err(AdmissionError::DocumentBusy)
        ));
        capture.transaction_finished().unwrap();
        successor.begin_evaluation().unwrap();
        drop(capture);
        assert_eq!(
            budget.usage.lock().unwrap().payload_bytes,
            MAXIMUM_REPLY_BYTES + 65536
        );
        drop(payload);
        let mut blocked_successor = document.reserve_capture().unwrap();
        assert!(matches!(
            blocked_successor.begin_evaluation(),
            Err(AdmissionError::DocumentBusy)
        ));
        drop(blocked_successor);
        assert_eq!(
            budget.usage.lock().unwrap().payload_bytes,
            MAXIMUM_REPLY_BYTES
        );
        drop(document);
        assert_eq!(budget.usage.lock().unwrap().documents, 1);
        drop(successor);
        empty(&budget);
    }

    #[test]
    fn completed_evaluations_keep_pending_payload_bytes_charged_by_context_and_engine() {
        let budget = Arc::new(SnapshotBudget::default());
        let documents: Vec<_> = ["first", "first", "first", "second", "second", "third"]
            .iter()
            .map(|context| document(&budget, context).unwrap())
            .collect();
        let mut captures = Vec::new();
        for index in [0, 1, 3, 4] {
            let mut capture = started(&documents[index]);
            capture.evaluation_finished();
            captures.push(capture);
        }
        let mut waiting_context = documents[2].reserve_capture().unwrap();
        let mut waiting_engine = documents[5].reserve_capture().unwrap();
        assert_eq!(
            waiting_context.begin_evaluation(),
            Err(AdmissionError::PayloadLimit)
        );
        assert_eq!(
            waiting_engine.begin_evaluation(),
            Err(AdmissionError::PayloadLimit)
        );
        let changes = waiting_context.admission_changes();
        let reduced = captures[0].take_payload(0).unwrap();
        assert!(changes.has_changed().unwrap());
        waiting_context.begin_evaluation().unwrap();
        assert_eq!(
            budget.usage.lock().unwrap().payload_bytes,
            MAXIMUM_PAYLOAD_BYTES
        );
        drop(waiting_context);
        drop(waiting_engine);
        drop(reduced);
        drop(captures);
        drop(documents);
        empty(&budget);
    }

    #[test]
    fn bounded_queued_intents_do_not_reserve_reply_bytes_before_evaluation() {
        let budget = Arc::new(SnapshotBudget::default());
        let document = document(&budget, "context").unwrap();
        let mut queued: Vec<_> = (0..MAXIMUM_CONTEXT_PAYLOADS)
            .map(|_| document.reserve_capture().unwrap())
            .collect();
        assert!(matches!(
            document.reserve_capture(),
            Err(AdmissionError::PayloadLimit)
        ));
        assert_eq!(budget.usage.lock().unwrap().payload_bytes, 0);
        let mut retained = Vec::new();
        for capture in &mut queued {
            capture.begin_evaluation().unwrap();
            assert_eq!(
                budget.usage.lock().unwrap().payload_bytes,
                MAXIMUM_REPLY_BYTES + retained.len() * 512
            );
            capture.evaluation_finished();
            retained.push(capture.take_payload(512).unwrap());
            capture.transaction_finished().unwrap();
        }
        let changes = queued[0].admission_changes();
        retained.pop();
        assert!(
            changes.has_changed().unwrap(),
            "released ingestion bytes must wake waiting captures"
        );
        drop(queued);
        drop(retained);
        drop(document);
        empty(&budget);
    }

    #[test]
    fn retired_payload_cannot_hold_or_release_a_successor_document_claim() {
        let budget = Arc::new(SnapshotBudget::default());
        let original = budget
            .reserve_document("context", "session", "main-unique")
            .unwrap();
        let mut capture = started(&original);
        capture.evaluation_finished();
        let payload = capture.take_payload(65536).unwrap();
        drop(original);
        assert!(matches!(
            budget.reserve_document("context", "session", "main-unique"),
            Err(AdmissionError::DocumentAlreadyOwned)
        ));
        let changes = budget.changes();
        drop(capture);
        assert!(changes.has_changed().unwrap());
        assert!(!budget.owns_document("context", "session", "main-unique"));
        {
            let usage = budget.usage.lock().unwrap();
            assert_eq!(usage.documents, 0);
            assert_eq!(usage.cache, CacheGrant::default());
            assert_eq!(usage.payloads, 1);
            assert_eq!(usage.payload_bytes, 65536);
            assert_eq!(usage.contexts.len(), 1);
        }
        let successor = budget
            .reserve_document("context", "session", "main-unique")
            .unwrap();
        assert_eq!(successor.generation_grant(), CacheGrant::GENERATION);
        let mut successor_capture = started(&successor);
        let other_session = budget
            .reserve_document("context", "other-session", "main-unique")
            .unwrap();
        let other_document = budget
            .reserve_document("context", "session", "new-main-unique")
            .unwrap();
        drop(payload);
        assert!(budget.owns_document("context", "session", "main-unique"));
        assert_eq!(budget.usage.lock().unwrap().documents, 3);
        assert_eq!(
            budget.usage.lock().unwrap().payload_bytes,
            MAXIMUM_REPLY_BYTES
        );
        let mut blocked = successor.reserve_capture().unwrap();
        assert_eq!(
            blocked.begin_evaluation(),
            Err(AdmissionError::DocumentBusy)
        );
        drop(blocked);
        successor_capture.evaluation_finished();
        drop(successor_capture);
        drop(successor);
        drop(other_session);
        drop(other_document);
        empty(&budget);
    }

    #[test]
    fn retired_payloads_preserve_context_and_engine_byte_limits() {
        let budget = Arc::new(SnapshotBudget::default());
        let mut payloads = Vec::new();
        for context in ["first", "first", "second", "second"] {
            let owner = document(&budget, context).unwrap();
            let mut capture = started(&owner);
            capture.evaluation_finished();
            payloads.push(capture.take_payload(MAXIMUM_REPLY_BYTES).unwrap());
        }
        assert_eq!(budget.usage.lock().unwrap().documents, 0);
        assert_eq!(
            budget.usage.lock().unwrap().payload_bytes,
            MAXIMUM_PAYLOAD_BYTES
        );
        let first = document(&budget, "first").unwrap();
        let third = document(&budget, "third").unwrap();
        let mut context_blocked = first.reserve_capture().unwrap();
        let mut engine_blocked = third.reserve_capture().unwrap();
        assert_eq!(
            context_blocked.begin_evaluation(),
            Err(AdmissionError::PayloadLimit)
        );
        assert_eq!(
            engine_blocked.begin_evaluation(),
            Err(AdmissionError::PayloadLimit)
        );
        payloads.pop();
        engine_blocked.begin_evaluation().unwrap();
        drop(engine_blocked);
        assert_eq!(
            context_blocked.begin_evaluation(),
            Err(AdmissionError::PayloadLimit)
        );
        payloads.remove(0);
        context_blocked.begin_evaluation().unwrap();
        drop(context_blocked);
        drop(first);
        drop(third);
        drop(payloads);
        empty(&budget);
    }

    #[test]
    fn retired_payloads_preserve_context_and_engine_count_limits() {
        let budget = Arc::new(SnapshotBudget::default());
        let mut payloads = Vec::new();
        for context in ["first", "second"] {
            for _ in 0..MAXIMUM_CONTEXT_PAYLOADS {
                let owner = document(&budget, context).unwrap();
                let mut capture = started(&owner);
                capture.evaluation_finished();
                payloads.push(capture.take_payload(0).unwrap());
            }
        }
        let first = document(&budget, "first").unwrap();
        let third = document(&budget, "third").unwrap();
        assert!(matches!(
            first.reserve_capture(),
            Err(AdmissionError::PayloadLimit)
        ));
        assert!(matches!(
            third.reserve_capture(),
            Err(AdmissionError::PayloadLimit)
        ));
        payloads.pop();
        drop(third.reserve_capture().unwrap());
        assert!(matches!(
            first.reserve_capture(),
            Err(AdmissionError::PayloadLimit)
        ));
        payloads.remove(0);
        drop(first.reserve_capture().unwrap());
        drop(first);
        drop(third);
        drop(payloads);
        empty(&budget);
    }
}
