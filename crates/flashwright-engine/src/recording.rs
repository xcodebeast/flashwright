//! One context recording owns chunk fences, diagnostic phases and a shared native clock.

use super::*;
use crate::snapshots::{
    PreparedSnapshot, SnapshotArchive, SnapshotDecision, SnapshotFailure, SnapshotMetadata,
};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

mod documents;
pub(crate) mod network;
mod phases;
#[cfg(test)]
mod tests;

const MAXIMUM_CALLS: usize = 4096;

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SnapshotPhase {
    Before,
    Input,
    After,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PhaseState {
    Pending,
    Settled,
}

struct TraceChunk {
    identifier: String,
    accepting: bool,
    cutoff: Option<u64>,
    network: Option<network::SealedNetwork>,
    calls: HashMap<String, HashMap<SnapshotPhase, PhaseState>>,
    snapshots: SnapshotArchive,
    documents: HashMap<(String, String), Arc<snapshots::SnapshotDocument>>,
}

impl TraceChunk {
    fn pending(&self) -> bool {
        !self.snapshots.is_empty()
            || self.documents.values().any(|document| !document.finished())
            || self.pending_phases()
    }

    fn pending_phases(&self) -> bool {
        self.calls
            .values()
            .any(|phases| phases.values().any(|phase| *phase == PhaseState::Pending))
    }

    fn retire_idle_documents(&self) {
        if !self.accepting && !self.pending_phases() {
            for document in self.documents.values() {
                document.close();
            }
        }
    }
}

pub(crate) struct TraceRecording {
    identifier: String,
    epoch: Instant,
    last_event_sequence: u64,
    chunk: Option<TraceChunk>,
    used_chunks: HashSet<String>,
    failure: Option<ErrorRecord>,
    network: Option<network::NetworkRecording>,
}

#[derive(Default)]
pub(crate) struct RecordingState {
    closed: bool,
    used_recordings: HashSet<String>,
    recording: Option<TraceRecording>,
}

impl RecordingState {
    pub(crate) fn active_mut(&mut self) -> Option<&mut TraceRecording> {
        if self.closed {
            None
        } else {
            self.recording.as_mut()
        }
    }

    pub(crate) fn close(&mut self) {
        self.closed = true;
        if let Some(recording) = self.recording.as_mut() {
            recording.fail(closed("context.trace.recording"));
        }
    }

    fn start(&mut self, identifier: &str) -> Result<Value, ErrorRecord> {
        if self.closed {
            return Err(closed("context.trace.recording.start"));
        }
        if self.recording.is_some() {
            return Err(invalid(
                "context.trace.recording.start",
                "a recording is already active or retiring",
            ));
        }
        if self.used_recordings.contains(identifier) {
            return Err(invalid(
                "context.trace.recording.start",
                "recording identity cannot be reused",
            ));
        }
        if self.used_recordings.len() == 4096 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "context.trace.recording.start",
                "context exceeds 4096 recording identities",
            ));
        }
        self.used_recordings.insert(identifier.into());
        self.recording = Some(TraceRecording {
            identifier: identifier.into(),
            epoch: Instant::now(),
            last_event_sequence: 0,
            chunk: None,
            used_chunks: HashSet::new(),
            failure: None,
            network: None,
        });
        Ok(json!({"nativeTime":0.0}))
    }

    pub(crate) fn get_mut(&mut self, identifier: &str) -> Result<&mut TraceRecording, ErrorRecord> {
        self.recording
            .as_mut()
            .filter(|recording| recording.identifier == identifier)
            .ok_or_else(|| {
                invalid(
                    "context.trace.recording",
                    "original recording is not active",
                )
            })
    }

    fn stop(&mut self, identifier: &str) -> Result<Value, ErrorRecord> {
        let recording = self.get_mut(identifier)?;
        if recording
            .chunk
            .as_ref()
            .is_some_and(|chunk| chunk.accepting || chunk.pending())
        {
            return Err(invalid(
                "context.trace.recording.stop",
                "original chunk must seal and settle before recording stop",
            ));
        }
        if let Some(network) = recording.network.as_mut() {
            network.close();
            if network.pending() {
                return Err(invalid(
                    "context.trace.recording.stop",
                    "original network work must settle before recording stop",
                ));
            }
        }
        let failure = recording.failure.clone();
        self.recording = None;
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(Value::Null)
    }
}

impl TraceRecording {
    /// The event callback invokes this under the same lock as its entire canonical observation group.
    pub(crate) fn observed_group(&mut self, sequence: u64) {
        self.last_event_sequence = self.last_event_sequence.max(sequence);
    }

    /// Original ingress can precede recording start; signed offsets preserve that ordering.
    pub(crate) fn native_time(&self, instant: Instant) -> f64 {
        if instant >= self.epoch {
            instant.duration_since(self.epoch).as_secs_f64() * 1000.0
        } else {
            -self.epoch.duration_since(instant).as_secs_f64() * 1000.0
        }
    }

    pub(crate) fn fail(&mut self, error: ErrorRecord) {
        if self.failure.is_none() {
            self.failure = Some(error.clone());
        }
        if let Some(network) = self.network.as_mut() {
            network.recording_failed(&error);
        }
        if let Some(chunk) = self.chunk.as_mut() {
            chunk.accepting = false;
            chunk.snapshots.fail(error);
            for document in chunk.documents.values() {
                document.close();
            }
        }
    }

    fn start_chunk(&mut self, identifier: &str) -> Result<Value, ErrorRecord> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        if self
            .chunk
            .as_ref()
            .is_some_and(|chunk| chunk.accepting || chunk.pending())
        {
            return Err(invalid(
                "context.trace.chunk.start",
                "previous chunk is active or retiring",
            ));
        }
        if self.used_chunks.contains(identifier) {
            return Err(invalid(
                "context.trace.chunk.start",
                "chunk identity cannot be reused",
            ));
        }
        if self.used_chunks.len() == 4096 {
            let error = ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "context.trace.chunk.start",
                "recording exceeds 4096 chunk identities",
            );
            self.fail(error.clone());
            return Err(error);
        }
        self.used_chunks.insert(identifier.into());
        self.chunk = Some(TraceChunk {
            identifier: identifier.into(),
            accepting: true,
            cutoff: None,
            network: None,
            calls: HashMap::new(),
            snapshots: SnapshotArchive::default(),
            documents: HashMap::new(),
        });
        Ok(Value::Null)
    }

    fn seal_chunk(&mut self, identifier: &str) -> Result<Value, ErrorRecord> {
        let chunk = self
            .chunk
            .as_mut()
            .filter(|chunk| chunk.identifier == identifier)
            .ok_or_else(|| invalid("context.trace.chunk.seal", "original chunk is not active"))?;
        let needs_prefix = chunk.cutoff.is_none() && self.failure.is_none();
        chunk.accepting = false;
        let cutoff = *chunk.cutoff.get_or_insert(self.last_event_sequence);
        chunk.retire_idle_documents();
        // Sealing is a lifecycle fence even when archive construction has failed.
        // Preserve the original failure for export while keeping retirement status usable.
        if needs_prefix {
            match self
                .network
                .as_mut()
                .map(network::NetworkRecording::seal)
                .transpose()
            {
                Ok(prefix) => self.chunk.as_mut().unwrap().network = prefix,
                Err(error) => self.fail(error),
            }
        }
        Ok(json!({"lastEventSequence":cutoff}))
    }

    /// Deduplication belongs to the original public call, including its nested native helpers.
    pub(crate) fn admit_phase(
        &mut self,
        chunk: &str,
        call: &str,
        phase: SnapshotPhase,
    ) -> Result<bool, ErrorRecord> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let Some(chunk) = self
            .chunk
            .as_mut()
            .filter(|current| current.identifier == chunk && current.accepting)
        else {
            return Ok(false);
        };
        bounded_identifier(call, "public call")?;
        if !chunk.calls.contains_key(call) && chunk.calls.len() == MAXIMUM_CALLS {
            let error = ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "context.trace.recording",
                "chunk exceeds 4096 retained public call identities",
            );
            self.fail(error.clone());
            return Err(error);
        }
        let phases = chunk.calls.entry(call.into()).or_default();
        if phases.contains_key(&phase) {
            return Ok(false);
        }
        phases.insert(phase, PhaseState::Pending);
        Ok(true)
    }

    /// Sealing stops new admission but never removes a predecessor's existing settlement obligation.
    pub(crate) fn settle_phase(
        &mut self,
        chunk: &str,
        call: &str,
        phase: SnapshotPhase,
    ) -> Result<(), ErrorRecord> {
        let phase = self
            .chunk
            .as_mut()
            .filter(|current| current.identifier == chunk)
            .and_then(|chunk| chunk.calls.get_mut(call))
            .and_then(|phases| phases.get_mut(&phase))
            .filter(|state| **state == PhaseState::Pending)
            .ok_or_else(|| {
                invalid(
                    "context.trace.recording",
                    "snapshot phase has no original pending owner",
                )
            })?;
        *phase = PhaseState::Settled;
        self.chunk.as_ref().unwrap().retire_idle_documents();
        Ok(())
    }
}

fn bounded_identifier(value: &str, field: &str) -> Result<(), ErrorRecord> {
    if value.is_empty() || value.len() > 64 || !value.is_ascii() {
        return Err(invalid(
            "context.trace.recording",
            &format!("{field} must contain 1 to 64 ASCII bytes"),
        ));
    }
    Ok(())
}

impl Engine {
    /// These controls run synchronously in driver acceptance order, without awaiting page/network work.
    pub(crate) fn recording_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        operation.check()?;
        let is_chunk = method.starts_with("context.trace.chunk.");
        validate_keys(
            method,
            parameters,
            if is_chunk {
                &["context", "recording", "chunk"]
            } else if method.ends_with(".start") {
                &["context", "recording", "network"]
            } else if method.ends_with(".fail") {
                &["context", "recording", "message"]
            } else {
                &["context", "recording"]
            },
        )?;
        let context = self.context(identifier(parameters, "context", method)?, method)?;
        if !context.published {
            return Err(invalid(method, "tracing requires a published context"));
        }
        let identifier = identifier(parameters, "recording", method)?;
        bounded_identifier(identifier, "recording")?;
        let mut state = context.state.recording.lock().unwrap();
        if state.closed {
            return Err(closed(method));
        }
        match method {
            "context.trace.recording.start" => {
                let network = parameters
                    .get("network")
                    .map(|value| {
                        value
                            .as_bool()
                            .ok_or_else(|| invalid(method, "network must be a boolean"))
                    })
                    .transpose()?
                    .unwrap_or(false);
                let result = state.start(identifier)?;
                if network {
                    let recording = state.get_mut(identifier)?;
                    recording.network = Some(network::NetworkRecording::new(
                        recording.epoch,
                        self.trace_network_budget
                            .get_or_init(|| Arc::new(network::NetworkBudget::default()))
                            .clone(),
                    ));
                }
                context
                    .state
                    .recording_enabled
                    .store(true, Ordering::Release);
                Ok(result)
            }
            "context.trace.recording.stop" => {
                let mut result = state.stop(identifier);
                if state.recording.is_none() {
                    if let Err(error) = &mut result {
                        error.cleanup = Some("traceRecordingStopped".into());
                    }
                    context
                        .state
                        .recording_enabled
                        .store(false, Ordering::Release);
                }
                result
            }
            "context.trace.recording.retire" | "context.trace.recording.status" => {
                let recording = state.get_mut(identifier)?;
                if method.ends_with(".retire")
                    && let Some(network) = recording.network.as_mut()
                {
                    network.retire();
                }
                Ok(
                    json!({"recording":identifier,"networkPending":recording.network.as_ref().is_some_and(network::NetworkRecording::pending)}),
                )
            }
            "context.trace.recording.clock" => {
                Ok(json!({"nativeTime":state.get_mut(identifier)?.native_time(Instant::now())}))
            }
            "context.trace.recording.fail" => {
                let message = parameters["message"]
                    .as_str()
                    .filter(|message| message.len() <= 1024)
                    .ok_or_else(|| {
                        invalid(
                            method,
                            "recording failure message must be at most 1024 bytes",
                        )
                    })?;
                state.get_mut(identifier)?.fail(ErrorRecord::new(
                    ErrorCode::Protocol,
                    method,
                    message,
                ));
                Ok(Value::Null)
            }
            "context.trace.chunk.start"
            | "context.trace.chunk.seal"
            | "context.trace.chunk.status" => {
                let chunk = super::identifier(parameters, "chunk", method)?;
                bounded_identifier(chunk, "chunk")?;
                let recording = state.get_mut(identifier)?;
                if method.ends_with(".start") {
                    recording.start_chunk(chunk)
                } else if method.ends_with(".seal") {
                    recording.seal_chunk(chunk)
                } else {
                    let original = recording.original_chunk(chunk)?;
                    Ok(
                        json!({"recording":identifier,"chunk":chunk,"accepting":original.accepting,"snapshotPending":original.pending(),"lastEventSequence":original.cutoff}),
                    )
                }
            }
            _ => unreachable!(),
        }
    }
}

impl TraceRecording {
    fn original_chunk(&mut self, identifier: &str) -> Result<&mut TraceChunk, ErrorRecord> {
        self.chunk
            .as_mut()
            .filter(|chunk| chunk.identifier == identifier)
            .ok_or_else(|| {
                invalid(
                    "context.trace.snapshot",
                    "original snapshot chunk is unavailable",
                )
            })
    }

    pub(crate) fn accept_snapshot(
        &mut self,
        chunk: &str,
        mut metadata: SnapshotMetadata,
        prepared: PreparedSnapshot,
    ) -> Result<SnapshotDecision, ErrorRecord> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        metadata.native_time = self.native_time(prepared.captured_at);
        let original = self.original_chunk(chunk)?;
        if original
            .calls
            .get(&metadata.call)
            .and_then(|phases| phases.get(&metadata.phase))
            != Some(&PhaseState::Pending)
        {
            return Err(invalid(
                "context.trace.snapshot",
                "capture has no original admitted call phase",
            ));
        }
        let result = original.snapshots.accept(metadata, prepared);
        if let Err(error) = &result {
            self.fail(error.clone());
        }
        result
    }

    pub(crate) fn snapshot_commit_finished(
        &mut self,
        chunk: &str,
        capture: &str,
        result: Result<(), SnapshotFailure>,
    ) -> Result<(), ErrorRecord> {
        let original = self.original_chunk(chunk)?;
        let result = original.snapshots.commit_finished(capture, result);
        if let Err(error) = &result {
            self.fail(error.clone());
        }
        result
    }
}

impl Engine {
    pub(crate) fn snapshot_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        operation.check()?;
        let ingestion = method.ends_with(".ingested");
        validate_keys(
            method,
            parameters,
            if ingestion {
                &[
                    "context",
                    "recording",
                    "chunk",
                    "capture",
                    "success",
                    "message",
                ]
            } else {
                &["context", "recording", "chunk"]
            },
        )?;
        let context = self.context(identifier(parameters, "context", method)?, method)?;
        let recording = identifier(parameters, "recording", method)?;
        let chunk = identifier(parameters, "chunk", method)?;
        let mut state = context.state.recording.lock().unwrap();
        let owner = state.get_mut(recording)?;
        if ingestion {
            let capture = identifier(parameters, "capture", method)?;
            let success = parameters["success"]
                .as_bool()
                .ok_or_else(|| invalid(method, "ingestion requires a success boolean"))?;
            let message = parameters
                .get("message")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| value.len() <= 1024)
                        .ok_or_else(|| {
                            invalid(method, "ingestion message must be at most 1024 bytes")
                        })
                })
                .transpose()?;
            owner.original_chunk(chunk)?.snapshots.metadata(capture)?;
            if !success {
                owner.fail(ErrorRecord::new(
                    ErrorCode::Protocol,
                    method,
                    message.unwrap_or("host rejected original snapshot ingestion"),
                ));
                return Ok(Value::Null);
            }
            owner.original_chunk(chunk)?.snapshots.ingested(capture)?;
            Ok(Value::Null)
        } else {
            let original = owner.original_chunk(chunk)?;
            let metadata = original.snapshots.pull()?;
            Ok(
                json!({"recording":recording,"chunk":chunk,"snapshots":metadata,"pending":original.pending()}),
            )
        }
    }

    pub(crate) async fn take_snapshot(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<BinaryAttachment, ErrorRecord> {
        let method = "context.trace.snapshot.take";
        validate_keys(
            method,
            &parameters,
            &["context", "recording", "chunk", "capture"],
        )?;
        let context = self.context(identifier(&parameters, "context", method)?, method)?;
        let recording = identifier(&parameters, "recording", method)?;
        let chunk = identifier(&parameters, "chunk", method)?;
        let capture = identifier(&parameters, "capture", method)?;
        let reservation = operation
            .wait(context.state.while_alive(method, async {
                self.attachment_slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| closed(method))
            }))
            .await?;
        operation.check()?;
        let mut state = context.state.recording.lock().unwrap();
        let owner = state.get_mut(recording)?;
        let original = owner.original_chunk(chunk)?;
        if original.snapshots.metadata(capture)?.byte_length > self.maximum_attachment_bytes {
            let error = ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "snapshot exceeds negotiated attachment bytes",
            );
            owner.fail(error.clone());
            return Err(error);
        }
        let (payload, bytes) = original.snapshots.take(capture)?;
        let mut attachment = BinaryAttachment::from_payload(payload, reservation);
        attachment.retain_byte_reservation(bytes);
        Ok(attachment)
    }
}
