//! Accepted DATA remains charged from browser commit through immutable host ingestion.

use super::budget::PayloadReservation;
use super::document::{PreparedSnapshot, SnapshotDecision};
use super::outcome::SnapshotFailure;
use crate::recording::SnapshotPhase;
use flashwright_protocol::{BinaryPayload, ErrorCode, ErrorRecord};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotMetadata {
    pub capture: String,
    pub call: String,
    pub phase: SnapshotPhase,
    pub page: String,
    pub frame: String,
    pub is_main_frame: bool,
    pub snapshot_number: u64,
    pub native_time: f64,
    pub byte_length: usize,
}

struct StoredSnapshot {
    metadata: SnapshotMetadata,
    payload: Option<BinaryPayload>,
    _payload_reservation: PayloadReservation,
    committed: bool,
    announced: bool,
}

#[derive(Default)]
pub(crate) struct SnapshotArchive {
    entries: BTreeMap<u64, StoredSnapshot>,
    next_sequence: u64,
    failure: Option<ErrorRecord>,
}

fn protocol(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, "tracing.snapshot", message)
}

impl SnapshotArchive {
    pub(crate) fn metadata(&self, capture: &str) -> Result<SnapshotMetadata, ErrorRecord> {
        self.check()?;
        self.entries
            .values()
            .find(|entry| entry.metadata.capture == capture)
            .map(|entry| entry.metadata.clone())
            .ok_or_else(|| protocol("snapshot has no original DATA owner"))
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn check(&self) -> Result<(), ErrorRecord> {
        if let Some(error) = &self.failure {
            Err(error.clone())
        } else {
            Ok(())
        }
    }

    pub(crate) fn fail(&mut self, error: ErrorRecord) {
        if self.failure.is_none() {
            self.failure = Some(error);
        }
        self.entries.clear();
    }

    /// Returning the decision transfers custody before the caller is allowed to commit browser references.
    pub(crate) fn accept(
        &mut self,
        mut metadata: SnapshotMetadata,
        prepared: PreparedSnapshot,
    ) -> Result<SnapshotDecision, ErrorRecord> {
        self.check()?;
        let bounded =
            |value: &str, maximum| !value.is_empty() && value.len() <= maximum && value.is_ascii();
        if !bounded(&metadata.capture, 128)
            || !bounded(&metadata.call, 64)
            || !bounded(&metadata.page, 64)
            || !bounded(&metadata.frame, 256)
            || !metadata.native_time.is_finite()
            || metadata.capture != prepared.captured.token
        {
            return Err(protocol(
                "snapshot archive metadata does not match its original capture",
            ));
        }
        if self
            .entries
            .values()
            .any(|entry| entry.metadata.capture == metadata.capture)
        {
            return Err(protocol("snapshot capture identity is already owned"));
        }
        if self.entries.len() == 64 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "tracing.snapshot",
                "snapshot archive exceeds 64 pending captures",
            ));
        }
        let sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| protocol("snapshot archive sequence exhausted"))?;
        metadata.byte_length = prepared.captured.data.decoded_length;
        metadata.snapshot_number = prepared.captured.snapshot_number;
        self.entries.insert(
            sequence,
            StoredSnapshot {
                metadata,
                payload: Some(prepared.captured.data),
                _payload_reservation: prepared.reservation,
                committed: false,
                announced: false,
            },
        );
        self.next_sequence = sequence;
        Ok(prepared.decision)
    }

    pub(crate) fn commit_finished(
        &mut self,
        capture: &str,
        result: Result<(), SnapshotFailure>,
    ) -> Result<(), ErrorRecord> {
        self.check()?;
        if let Err(error) = result {
            let error = error.recording_error();
            self.fail(error.clone());
            return Err(error);
        }
        let entry = self
            .entries
            .values_mut()
            .find(|entry| entry.metadata.capture == capture)
            .ok_or_else(|| protocol("committed snapshot has no original DATA owner"))?;
        if entry.committed {
            return Err(protocol("snapshot commit was acknowledged twice"));
        }
        entry.committed = true;
        Ok(())
    }

    /// Keep insertion order across commits: a successor may refer to an earlier still-pending predecessor.
    pub(crate) fn pull(&mut self) -> Result<Vec<SnapshotMetadata>, ErrorRecord> {
        self.check()?;
        let mut metadata = Vec::new();
        for entry in self.entries.values_mut() {
            if !entry.committed {
                break;
            }
            if !entry.announced {
                entry.announced = true;
                metadata.push(entry.metadata.clone());
            }
        }
        Ok(metadata)
    }

    pub(crate) fn take(&mut self, capture: &str) -> Result<BinaryPayload, ErrorRecord> {
        self.check()?;
        let entry = self
            .entries
            .values_mut()
            .next()
            .ok_or_else(|| protocol("snapshot DATA has no original owner"))?;
        if entry.metadata.capture != capture {
            return Err(protocol(
                "snapshot DATA must follow predecessor ingestion order",
            ));
        }
        if !entry.committed || !entry.announced {
            return Err(protocol("snapshot DATA was not announced after commit"));
        }
        entry
            .payload
            .take()
            .ok_or_else(|| protocol("snapshot DATA was already transferred"))
    }

    /// The native charge survives take; only immutable ingestion, failure or teardown ends custody.
    pub(crate) fn ingested(&mut self, capture: &str) -> Result<(), ErrorRecord> {
        self.check()?;
        let (sequence, entry) = self
            .entries
            .iter()
            .find(|(_, entry)| entry.metadata.capture == capture)
            .ok_or_else(|| protocol("snapshot ingestion has no original claim"))?;
        if entry.payload.is_some() {
            return Err(protocol("snapshot ingestion precedes DATA transfer"));
        }
        let sequence = *sequence;
        self.entries.remove(&sequence);
        Ok(())
    }
}
