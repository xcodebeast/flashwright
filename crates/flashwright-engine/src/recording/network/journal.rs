//! Immutable network versions under the shared recording lock.
//! The owner supplies canonical observations, body scheduling, resources and browser-event cutoff.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum JournalError {
    ResourceLimit(&'static str),
    Protocol(&'static str),
}

/// Logical retained data and fixed owner overhead share credits, including sealed exports.
pub(super) struct JournalBudget {
    maximum: usize,
    retained: AtomicUsize,
    engine: Option<Arc<JournalBudget>>,
}

impl JournalBudget {
    pub(super) fn new(maximum: usize) -> Arc<Self> {
        Arc::new(Self {
            maximum,
            retained: AtomicUsize::new(0),
            engine: None,
        })
    }

    pub(super) fn recording(maximum: usize, engine: Arc<Self>) -> Arc<Self> {
        assert!(engine.engine.is_none(), "engine allowance must be the root");
        Arc::new(Self {
            maximum,
            retained: AtomicUsize::new(0),
            engine: Some(engine),
        })
    }

    #[cfg(test)]
    pub(super) fn retained(&self) -> usize {
        self.retained.load(Ordering::Acquire)
    }

    pub(super) fn reserve(self: &Arc<Self>, bytes: usize) -> Result<Reservation, JournalError> {
        self.admit(bytes)?;
        if let Some(engine) = &self.engine
            && let Err(error) = engine.admit(bytes)
        {
            self.retained.fetch_sub(bytes, Ordering::AcqRel);
            return Err(error);
        }
        Ok(Reservation {
            budget: self.clone(),
            bytes,
        })
    }

    fn admit(&self, bytes: usize) -> Result<(), JournalError> {
        self.retained
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |retained| {
                retained
                    .checked_add(bytes)
                    .filter(|total| *total <= self.maximum)
            })
            .map_err(|_| {
                JournalError::ResourceLimit("network journal retained allowance exhausted")
            })?;
        Ok(())
    }
}

pub(super) struct Reservation {
    budget: Arc<JournalBudget>,
    bytes: usize,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.retained.fetch_sub(self.bytes, Ordering::AcqRel);
        if let Some(engine) = &self.budget.engine {
            engine.retained.fetch_sub(self.bytes, Ordering::AcqRel);
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct JournalLimits {
    pub(super) occurrences: usize,
    pub(super) pending: usize,
    pub(super) versions: usize,
    pub(super) event_bytes: usize,
}

impl Default for JournalLimits {
    fn default() -> Self {
        Self {
            occurrences: 16_384,
            pending: 1024,
            versions: 65_536,
            event_bytes: 256 * 1024,
        }
    }
}

/// Public page identities are already unique within the context; CDP request identifiers are not.
#[derive(Clone, Hash, PartialEq, Eq)]
pub(super) struct Occurrence {
    pub(super) page: String,
    pub(super) identity: String,
}

struct Metadata {
    encoded: Vec<u8>,
    _reservation: Reservation,
}

/// The resource store owns actual bytes. A completed original body can publish exactly one token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum BodyOutcome {
    Resource { token: String, byte_length: usize },
    Unavailable { reason: BodyUnavailable },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BodyUnavailable {
    Redirect,
    RecordingStopped,
    RequestFailed,
    OriginalRequestReplaced,
    OriginalPageClosed,
    BrowserResourceMissing,
}

pub(super) struct BodyCapture {
    result: OnceLock<Result<BodyOutcome, JournalError>>,
    _reservation: Reservation,
}

impl BodyCapture {
    pub(super) fn result(&self) -> Option<&Result<BodyOutcome, JournalError>> {
        self.result.get()
    }
}

/// The queued or running worker retains this owner until its original browser work settles.
pub(super) struct BodyWork {
    capture: Arc<BodyCapture>,
    _pending_reservation: Reservation,
    pending_work: Arc<AtomicUsize>,
}

impl BodyWork {
    #[cfg(test)]
    pub(super) fn capture(&self) -> &Arc<BodyCapture> {
        &self.capture
    }
}

impl Drop for BodyWork {
    fn drop(&mut self) {
        let _ = self.capture.result.set(Err(JournalError::Protocol(
            "original body work ended without a settled outcome",
        )));
        self.pending_work.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) struct NetworkVersion {
    pub(super) occurrence: Occurrence,
    metadata: Arc<Metadata>,
    pub(super) body: Option<Arc<BodyCapture>>,
    _reservation: Reservation,
}

impl NetworkVersion {
    pub(super) fn metadata(&self) -> &[u8] {
        &self.metadata.encoded
    }
}

/// Body cells present at seal may settle; metadata and membership of this prefix never change.
pub(super) struct NetworkPrefix {
    pub(super) versions: Vec<Arc<NetworkVersion>>,
    _reservation: Reservation,
}

enum Completion {
    Pending,
    Body(Arc<BodyCapture>),
    Finished,
}

struct Entry {
    occurrence: Occurrence,
    metadata: Arc<Metadata>,
    completion: Completion,
    flushed: bool,
    pending_reservation: Option<Reservation>,
    _reservation: Reservation,
}

pub(super) struct NetworkJournal {
    limits: JournalLimits,
    budget: Arc<JournalBudget>,
    engine_pending: Arc<JournalBudget>,
    occurrences: HashMap<Occurrence, usize>,
    entries: Vec<Entry>,
    versions: Vec<Arc<NetworkVersion>>,
    pending: usize,
    failure: Option<JournalError>,
    pending_work: Arc<AtomicUsize>,
}

impl NetworkJournal {
    pub(super) fn new(
        limits: JournalLimits,
        budget: Arc<JournalBudget>,
        engine_pending: Arc<JournalBudget>,
    ) -> Self {
        Self {
            limits,
            budget,
            engine_pending,
            occurrences: HashMap::new(),
            entries: Vec::new(),
            versions: Vec::new(),
            pending: 0,
            failure: None,
            pending_work: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub(super) fn failure(&self) -> Option<&JournalError> {
        self.failure.as_ref()
    }

    pub(super) fn contains(&self, occurrence: &Occurrence) -> bool {
        self.occurrences.contains_key(occurrence)
    }

    /// Poisoned result cells do not prove that their original browser work settled.
    pub(super) fn body_work_pending(&self) -> bool {
        self.pending_work.load(Ordering::Acquire) != 0
    }

    /// Only one bounded current representation is materialized while changing metadata.
    pub(super) fn update(
        &mut self,
        occurrence: &Occurrence,
        change: impl FnOnce(&mut Value),
    ) -> Result<(), JournalError> {
        self.run(|journal| {
            let index = journal.index(occurrence)?;
            if matches!(journal.entries[index].completion, Completion::Finished) {
                return Ok(());
            }
            let mut metadata: Value =
                serde_json::from_slice(&journal.entries[index].metadata.encoded)
                    .map_err(|_| JournalError::Protocol("retained network metadata is invalid"))?;
            change(&mut metadata);
            journal.entries[index].metadata = journal.encode(&metadata)?;
            journal.finalize_if_ready(index)?;
            Ok(())
        })
    }

    fn check(&self) -> Result<(), JournalError> {
        self.failure.clone().map_or(Ok(()), Err)
    }

    /// Failure belongs to this recording. No error is returned into its public request or route.
    pub(super) fn fail(&mut self, error: JournalError) {
        self.failure.get_or_insert(error.clone());
        for entry in &self.entries {
            if let Completion::Body(body) = &entry.completion {
                let _ = body.result.set(Err(error.clone()));
            }
        }
    }

    fn run<T>(
        &mut self,
        work: impl FnOnce(&mut Self) -> Result<T, JournalError>,
    ) -> Result<T, JournalError> {
        self.check()?;
        let result = work(self);
        if let Err(error) = &result {
            self.fail(error.clone());
        }
        result
    }

    /// Admission counts before copying metadata or adding an occurrence to either index.
    pub(super) fn create(
        &mut self,
        occurrence: Occurrence,
        metadata: &Value,
    ) -> Result<(), JournalError> {
        self.run(|journal| {
            if occurrence.page.is_empty()
                || occurrence.page.len() > 64
                || occurrence.identity.is_empty()
                || occurrence.identity.len() > 512
            {
                return Err(JournalError::Protocol(
                    "invalid original network occurrence",
                ));
            }
            if journal.occurrences.contains_key(&occurrence) {
                return Err(JournalError::Protocol(
                    "network occurrence already recorded",
                ));
            }
            if journal.entries.len() == journal.limits.occurrences
                || journal.pending == journal.limits.pending
            {
                return Err(JournalError::ResourceLimit(
                    "network recording occurrence allowance exhausted",
                ));
            }
            let reservation = journal
                .budget
                .reserve(512 + 3 * (occurrence.page.len() + occurrence.identity.len()))?;
            let pending_reservation = journal.engine_pending.reserve(1)?;
            let metadata = journal.encode(metadata)?;
            journal
                .occurrences
                .insert(occurrence.clone(), journal.entries.len());
            journal.entries.push(Entry {
                occurrence,
                metadata,
                completion: Completion::Pending,
                flushed: false,
                pending_reservation: Some(pending_reservation),
                _reservation: reservation,
            });
            journal.pending += 1;
            Ok(())
        })
    }

    /// The adapter constructs accepted canonical metadata; sealed versions retain their prior value.
    #[cfg(test)]
    pub(super) fn replace_metadata(
        &mut self,
        occurrence: &Occurrence,
        metadata: &Value,
    ) -> Result<(), JournalError> {
        self.run(|journal| {
            let index = journal.index(occurrence)?;
            if matches!(journal.entries[index].completion, Completion::Finished) {
                return Ok(());
            }
            let metadata = journal.encode(metadata)?;
            journal.entries[index].metadata = metadata;
            Ok(())
        })
    }

    /// Only a terminal original request may schedule body work. An unfinished HTTP request never blocks a seal.
    pub(super) fn complete(
        &mut self,
        occurrence: &Occurrence,
        capture_body: bool,
    ) -> Result<Option<BodyWork>, JournalError> {
        self.run(|journal| {
            let index = journal.index(occurrence)?;
            if !matches!(journal.entries[index].completion, Completion::Pending) {
                return Err(JournalError::Protocol("network occurrence completed twice"));
            }
            if capture_body {
                let reservation = journal.budget.reserve(8192)?;
                let pending_reservation = journal.entries[index]
                    .pending_reservation
                    .take()
                    .expect("unfinished occurrence owns its pending credit");
                let body = Arc::new(BodyCapture {
                    result: OnceLock::new(),
                    _reservation: reservation,
                });
                journal.entries[index].completion = Completion::Body(body.clone());
                journal.pending_work.fetch_add(1, Ordering::AcqRel);
                Ok(Some(BodyWork {
                    capture: body,
                    _pending_reservation: pending_reservation,
                    pending_work: journal.pending_work.clone(),
                }))
            } else {
                journal.append(index, None)?;
                journal.entries[index].completion = Completion::Finished;
                journal.release_pending(index);
                Ok(None)
            }
        })
    }

    /// The supplied token must describe the already admitted original body; metadata is never reread from the page.
    pub(super) fn finish_body(
        &mut self,
        occurrence: &Occurrence,
        work: BodyWork,
        outcome: BodyOutcome,
    ) -> Result<(), JournalError> {
        self.run(|journal| {
            let capture = &work.capture;
            if let BodyOutcome::Resource { token, byte_length } = &outcome
                && (token.is_empty()
                    || token.len() > 256
                    || !token.is_ascii()
                    || *byte_length > 16 * 1024 * 1024)
            {
                return Err(JournalError::Protocol(
                    "invalid immutable body resource token",
                ));
            }
            let index = journal.index(occurrence)?;
            let Completion::Body(original) = &journal.entries[index].completion else {
                return Err(JournalError::Protocol(
                    "network occurrence has no pending original body",
                ));
            };
            if !Arc::ptr_eq(original, capture) || capture.result.get().is_some() {
                return Err(JournalError::Protocol(
                    "body completion does not own the original capture",
                ));
            }
            capture
                .result
                .set(Ok(outcome))
                .map_err(|_| JournalError::Protocol("body capture settled twice"))?;
            journal.finalize_if_ready(index)?;
            Ok(())
        })
    }

    fn finalize_if_ready(&mut self, index: usize) -> Result<(), JournalError> {
        let Completion::Body(body) = &self.entries[index].completion else {
            return Ok(());
        };
        if body.result.get().is_none() {
            return Ok(());
        }
        let metadata: Value = serde_json::from_slice(&self.entries[index].metadata.encoded)
            .map_err(|_| JournalError::Protocol("retained network metadata is invalid"))?;
        // Explicit false means Chromium still owes paired headers. Absent keys support non-HAR users.
        if metadata["requestHeadersReady"] == false || metadata["responseHeadersReady"] == false {
            return Ok(());
        }
        self.append(index, Some(body.clone()))?;
        self.entries[index].completion = Completion::Finished;
        self.release_pending(index);
        Ok(())
    }

    /// Append pending versions once, then retain the complete ordered history under the common seal lock.
    pub(super) fn seal(&mut self) -> Result<NetworkPrefix, JournalError> {
        self.run(|journal| {
            for index in 0..journal.entries.len() {
                if journal.entries[index].flushed {
                    continue;
                }
                let body = match &journal.entries[index].completion {
                    Completion::Finished => continue,
                    Completion::Pending => None,
                    Completion::Body(body) => Some(body.clone()),
                };
                journal.append(index, body)?;
                journal.entries[index].flushed = true;
            }
            let reservation = journal.budget.reserve(
                64 + journal.versions.len() * std::mem::size_of::<Arc<NetworkVersion>>(),
            )?;
            Ok(NetworkPrefix {
                versions: journal.versions.clone(),
                _reservation: reservation,
            })
        })
    }

    fn append(&mut self, index: usize, body: Option<Arc<BodyCapture>>) -> Result<(), JournalError> {
        if self.versions.len() == self.limits.versions {
            return Err(JournalError::ResourceLimit(
                "network journal version allowance exhausted",
            ));
        }
        let entry = &self.entries[index];
        let reservation = self
            .budget
            .reserve(128 + entry.occurrence.page.len() + entry.occurrence.identity.len())?;
        self.versions.push(Arc::new(NetworkVersion {
            occurrence: entry.occurrence.clone(),
            metadata: entry.metadata.clone(),
            body,
            _reservation: reservation,
        }));
        Ok(())
    }

    fn index(&self, occurrence: &Occurrence) -> Result<usize, JournalError> {
        self.occurrences
            .get(occurrence)
            .copied()
            .ok_or(JournalError::Protocol(
                "unknown original network occurrence",
            ))
    }

    fn release_pending(&mut self, index: usize) {
        self.entries[index].pending_reservation.take();
        self.pending -= 1;
    }

    fn encode(&self, value: &Value) -> Result<Arc<Metadata>, JournalError> {
        // Count with the same serializer before allocating the bounded owned encoding.
        let mut counter = ByteCounter {
            bytes: 0,
            maximum: self.limits.event_bytes,
        };
        serde_json::to_writer(&mut counter, value).map_err(|_| {
            JournalError::ResourceLimit("network metadata event exceeds its byte allowance")
        })?;
        let reservation = self.budget.reserve(counter.bytes + 64)?;
        let encoded = serde_json::to_vec(value)
            .map_err(|_| JournalError::Protocol("network metadata serialization failed"))?;
        Ok(Arc::new(Metadata {
            encoded,
            _reservation: reservation,
        }))
    }
}

struct ByteCounter {
    bytes: usize,
    maximum: usize,
}

impl Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .filter(|total| *total <= self.maximum)
            .ok_or_else(|| io::Error::other("network event limit"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recording_and_engine_admission_roll_back_independently() {
        let engine = JournalBudget::new(12);
        let first = JournalBudget::recording(10, engine.clone());
        let second = JournalBudget::recording(10, engine.clone());
        let original = first.reserve(8).unwrap();
        assert!(first.reserve(3).is_err());
        assert_eq!(first.retained(), 8);
        assert_eq!(engine.retained(), 8);
        assert!(second.reserve(5).is_err());
        assert_eq!(second.retained(), 0);
        assert_eq!(engine.retained(), 8);
        let successor = second.reserve(4).unwrap();
        drop(original);
        assert_eq!(first.retained(), 0);
        assert_eq!(second.retained(), 4);
        assert_eq!(engine.retained(), 4);
        drop(successor);
        assert_eq!(engine.retained(), 0);
    }

    #[test]
    fn sealed_versions_and_original_body_work_keep_the_engine_metadata_charge() {
        let engine = JournalBudget::new(64 * 1024);
        let budget = JournalBudget::recording(64 * 1024, engine.clone());
        let pending = JournalBudget::new(1);
        let mut journal =
            NetworkJournal::new(JournalLimits::default(), budget.clone(), pending.clone());
        let owner = occurrence("request:1");
        journal
            .create(owner.clone(), &json!({"original": true}))
            .unwrap();
        let work = journal.complete(&owner, true).unwrap().unwrap();
        let prefix = journal.seal().unwrap();
        drop(journal);
        assert!(budget.retained() > 8192);
        assert_eq!(budget.retained(), engine.retained());
        drop(prefix);
        assert_eq!(budget.retained(), 8192);
        assert_eq!(engine.retained(), 8192);
        assert_eq!(pending.retained(), 1);
        let successor = JournalBudget::recording(64 * 1024, engine.clone());
        assert!(successor.reserve(64 * 1024 - 8191).is_err());
        assert_eq!(successor.retained(), 0);
        drop(work);
        assert_eq!(engine.retained(), 0);
        assert_eq!(pending.retained(), 0);
        assert!(successor.reserve(64 * 1024).is_ok());
    }

    fn occurrence(identity: &str) -> Occurrence {
        Occurrence {
            page: "page".into(),
            identity: identity.into(),
        }
    }
    fn journal() -> NetworkJournal {
        NetworkJournal::new(
            JournalLimits::default(),
            JournalBudget::new(64 * 1024 * 1024),
            JournalBudget::new(4096),
        )
    }
    fn metadata(version: &NetworkVersion) -> Value {
        serde_json::from_slice(version.metadata()).unwrap()
    }

    #[test]
    fn unavailable_is_settled_and_distinct_from_an_empty_resource() {
        let mut journal = journal();
        let unavailable = occurrence("unavailable:1");
        let empty = occurrence("empty:1");
        journal.create(unavailable.clone(), &json!({})).unwrap();
        journal.create(empty.clone(), &json!({})).unwrap();
        let unavailable_work = journal.complete(&unavailable, true).unwrap().unwrap();
        let empty_work = journal.complete(&empty, true).unwrap().unwrap();
        let prefix = journal.seal().unwrap();
        assert!(journal.body_work_pending());
        journal
            .finish_body(
                &unavailable,
                unavailable_work,
                BodyOutcome::Unavailable {
                    reason: BodyUnavailable::BrowserResourceMissing,
                },
            )
            .unwrap();
        assert!(journal.body_work_pending());
        journal
            .finish_body(
                &empty,
                empty_work,
                BodyOutcome::Resource {
                    token: "empty-body".into(),
                    byte_length: 0,
                },
            )
            .unwrap();
        assert!(!journal.body_work_pending());
        assert_eq!(
            prefix.versions[0].body.as_ref().unwrap().result(),
            Some(&Ok(BodyOutcome::Unavailable {
                reason: BodyUnavailable::BrowserResourceMissing
            }))
        );
        assert_eq!(
            prefix.versions[1].body.as_ref().unwrap().result(),
            Some(&Ok(BodyOutcome::Resource {
                token: "empty-body".into(),
                byte_length: 0
            }))
        );
    }

    #[test]
    fn recording_failure_does_not_release_a_live_browser_work_ticket() {
        let mut journal = journal();
        let owner = occurrence("pending:1");
        journal
            .create(owner.clone(), &json!({"headers":{"initial":true}}))
            .unwrap();
        assert!(journal.contains(&owner));
        let original = journal.seal().unwrap();
        journal
            .update(&owner, |metadata| {
                metadata["headers"] = json!({"changed":true})
            })
            .unwrap();
        assert_eq!(
            metadata(&original.versions[0])["headers"],
            json!({"initial":true})
        );
        let work = journal.complete(&owner, true).unwrap().unwrap();
        journal.fail(JournalError::Protocol("failed recording"));
        assert!(journal.body_work_pending());
        drop(work);
        assert!(!journal.body_work_pending());
    }

    #[test]
    fn pending_export_stays_unchanged_when_original_body_completes_in_a_gap() {
        let mut journal = journal();
        let owner = occurrence("shared:1");
        journal
            .create(
                owner.clone(),
                &json!({"status":200,"headers":{"before":"seal"}}),
            )
            .unwrap();
        let first = journal.seal().unwrap();
        assert_eq!(first.versions.len(), 1);
        assert!(first.versions[0].body.is_none());
        let first_bytes = first.versions[0].metadata().to_vec();
        journal
            .replace_metadata(&owner, &json!({"status":200,"headers":{"after":"seal"}}))
            .unwrap();
        let capture = journal.complete(&owner, true).unwrap().unwrap();
        journal
            .finish_body(
                &owner,
                capture,
                BodyOutcome::Resource {
                    token: "original-body".into(),
                    byte_length: 3,
                },
            )
            .unwrap();
        let second = journal.seal().unwrap();
        assert_eq!(second.versions.len(), 2);
        assert_eq!(first.versions[0].metadata(), first_bytes);
        assert!(first.versions[0].body.is_none());
        assert_eq!(metadata(&second.versions[1])["headers"]["after"], "seal");
        assert_eq!(
            second.versions[1].body.as_ref().unwrap().result(),
            Some(&Ok(BodyOutcome::Resource {
                token: "original-body".into(),
                byte_length: 3
            }))
        );
        assert!(Arc::ptr_eq(&first.versions[0], &second.versions[0]));
    }

    #[test]
    fn admitted_body_cannot_pull_later_headers_into_a_sealed_version() {
        let mut journal = journal();
        let owner = occurrence("shared:1");
        journal
            .create(owner.clone(), &json!({"headers":{"at":"admission"}}))
            .unwrap();
        let capture = journal.complete(&owner, true).unwrap().unwrap();
        let first = journal.seal().unwrap();
        journal
            .replace_metadata(&owner, &json!({"headers":{"at":"later"}}))
            .unwrap();
        journal
            .finish_body(
                &owner,
                capture,
                BodyOutcome::Resource {
                    token: "original-body".into(),
                    byte_length: 3,
                },
            )
            .unwrap();
        assert_eq!(metadata(&first.versions[0])["headers"]["at"], "admission");
        assert_eq!(
            first.versions[0].body.as_ref().unwrap().result(),
            Some(&Ok(BodyOutcome::Resource {
                token: "original-body".into(),
                byte_length: 3
            }))
        );
        let second = journal.seal().unwrap();
        assert_eq!(metadata(&second.versions[1])["headers"]["at"], "later");
    }

    #[test]
    fn redirect_reuse_and_different_pages_cannot_share_body_ownership() {
        let mut journal = journal();
        let first = occurrence("shared:1");
        let second = occurrence("shared:2");
        let other_page = Occurrence {
            page: "other".into(),
            identity: first.identity.clone(),
        };
        for owner in [&first, &second, &other_page] {
            journal
                .create(owner.clone(), &json!({"url":owner.identity}))
                .unwrap();
        }
        journal.complete(&first, false).unwrap();
        let second_body = journal.complete(&second, true).unwrap().unwrap();
        let other_body = journal.complete(&other_page, true).unwrap().unwrap();
        assert_eq!(
            journal.finish_body(
                &second,
                other_body,
                BodyOutcome::Resource {
                    token: "wrong-body".into(),
                    byte_length: 3
                }
            ),
            Err(JournalError::Protocol(
                "body completion does not own the original capture"
            ))
        );
        assert!(matches!(
            second_body.capture().result(),
            Some(Err(JournalError::Protocol(_)))
        ));
        assert!(journal.seal().is_err());
    }

    #[test]
    fn sealed_exports_keep_their_metadata_charged_after_recording_drop() {
        let budget = JournalBudget::new(64 * 1024);
        let engine_pending = JournalBudget::new(4);
        let mut journal = NetworkJournal::new(
            JournalLimits::default(),
            budget.clone(),
            engine_pending.clone(),
        );
        journal
            .create(occurrence("request:1"), &json!({"body":"not inline"}))
            .unwrap();
        let prefix = journal.seal().unwrap();
        assert_eq!(engine_pending.retained(), 1);
        drop(journal);
        assert_eq!(engine_pending.retained(), 0);
        assert!(budget.retained() > 0);
        assert_eq!(metadata(&prefix.versions[0])["body"], "not inline");
        drop(prefix);
        assert_eq!(budget.retained(), 0);
    }

    #[test]
    fn in_flight_body_keeps_pending_credit_after_journal_teardown() {
        let pending = JournalBudget::new(1);
        let mut journal = NetworkJournal::new(
            JournalLimits::default(),
            JournalBudget::new(64 * 1024),
            pending.clone(),
        );
        let owner = occurrence("request:1");
        journal.create(owner.clone(), &json!({})).unwrap();
        let work = journal.complete(&owner, true).unwrap().unwrap();
        let prefix = journal.seal().unwrap();
        drop(journal);
        assert_eq!(pending.retained(), 1);
        assert!(prefix.versions[0].body.as_ref().unwrap().result().is_none());
        drop(work);
        assert_eq!(pending.retained(), 0);
        assert!(matches!(
            prefix.versions[0].body.as_ref().unwrap().result(),
            Some(Err(JournalError::Protocol(_)))
        ));
    }

    #[test]
    fn admission_failure_is_explicit_and_shared_pending_credits_are_not_overdrawn() {
        let budget = JournalBudget::new(64 * 1024);
        let pending = JournalBudget::new(1);
        let mut first =
            NetworkJournal::new(JournalLimits::default(), budget.clone(), pending.clone());
        let mut second =
            NetworkJournal::new(JournalLimits::default(), budget.clone(), pending.clone());
        first.create(occurrence("request:1"), &json!({})).unwrap();
        let retained = budget.retained();
        assert!(matches!(
            second.create(occurrence("request:2"), &json!({})),
            Err(JournalError::ResourceLimit(_))
        ));
        assert_eq!(pending.retained(), 1);
        assert_eq!(budget.retained(), retained);
        assert_eq!(second.entries.len(), 0);
        first.complete(&occurrence("request:1"), false).unwrap();
        assert_eq!(pending.retained(), 0);
    }

    #[test]
    fn event_admission_checks_actual_json_escaping_before_copying() {
        let budget = JournalBudget::new(64 * 1024);
        let mut journal = NetworkJournal::new(
            JournalLimits {
                event_bytes: 8,
                ..JournalLimits::default()
            },
            budget.clone(),
            JournalBudget::new(4),
        );
        // Six source bytes require a 14-byte JSON string after escaping and quotes.
        assert!(matches!(
            journal.create(occurrence("request:1"), &json!("\n\n\n\n\n\n")),
            Err(JournalError::ResourceLimit(_))
        ));
        assert!(journal.entries.is_empty());
        assert_eq!(budget.retained(), 0);
    }

    #[test]
    fn exact_event_and_version_bounds_preserve_prior_exports_on_overflow() {
        let mut journal = NetworkJournal::new(
            JournalLimits {
                event_bytes: 4,
                versions: 1,
                ..JournalLimits::default()
            },
            JournalBudget::new(64 * 1024),
            JournalBudget::new(4),
        );
        let owner = occurrence("request:1");
        journal.create(owner.clone(), &Value::Null).unwrap();
        let first = journal.seal().unwrap();
        assert_eq!(first.versions[0].metadata(), b"null");
        assert!(matches!(
            journal.complete(&owner, false),
            Err(JournalError::ResourceLimit(_))
        ));
        assert_eq!(first.versions[0].metadata(), b"null");
        assert!(journal.seal().is_err());

        let mut journal = NetworkJournal::new(
            JournalLimits {
                event_bytes: 4,
                ..JournalLimits::default()
            },
            JournalBudget::new(64 * 1024),
            JournalBudget::new(4),
        );
        assert!(matches!(
            journal.create(owner, &json!("abc")),
            Err(JournalError::ResourceLimit(_))
        ));
        assert!(journal.entries.is_empty());
    }

    #[test]
    fn command_side_flags_are_frozen_without_inventing_browser_event_sequences() {
        let mut journal = journal();
        let owner = occurrence("request:1");
        journal
            .create(
                owner.clone(),
                &json!({"request":{"url":"https://example.test/original"}}),
            )
            .unwrap();
        journal
            .replace_metadata(
                &owner,
                &json!({"request":{"url":"https://example.test/original"},"_wasContinued":true}),
            )
            .unwrap();
        let prefix = journal.seal().unwrap();
        assert_eq!(metadata(&prefix.versions[0])["_wasContinued"], true);
        assert_eq!(
            metadata(&prefix.versions[0])["request"]["url"],
            "https://example.test/original"
        );
        assert!(metadata(&prefix.versions[0]).get("eventSequence").is_none());
        assert_eq!(journal.seal().unwrap().versions.len(), 1);
    }
}
