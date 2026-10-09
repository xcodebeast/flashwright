//! Bounded original bytes remain charged until immutable host ingestion acknowledges their token.

use super::journal::{JournalBudget, JournalError, Reservation};
use flashwright_protocol::attachment::{append_base64, base64_decoded_length};
use flashwright_protocol::{AttachmentEncoding, BinaryAttachment, BinaryPayload};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) const MAXIMUM_RESOURCE_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAXIMUM_ENCODED_BYTES: usize = MAXIMUM_RESOURCE_BYTES.div_ceil(3) * 4;
const CONTEXT_BYTES: usize = 64 * 1024 * 1024;
const ENGINE_BYTES: usize = 256 * 1024 * 1024;
const METHOD: &str = "tracing.network";

pub(crate) struct NetworkBudget {
    pub(super) pending: Arc<JournalBudget>,
    pub(super) workers: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
}

impl Default for NetworkBudget {
    fn default() -> Self {
        Self {
            pending: JournalBudget::new(4096),
            workers: Arc::new(Semaphore::new(2)),
            bytes: Arc::new(Semaphore::new(ENGINE_BYTES)),
        }
    }
}

#[derive(Clone)]
pub(super) struct ResourceBudget {
    context: Arc<Semaphore>,
    engine: Arc<Semaphore>,
}

pub(super) struct ResourceReservation {
    permits: Vec<Arc<OwnedSemaphorePermit>>,
    bytes: usize,
}

impl ResourceReservation {
    /// Only the native owner exists before transfer; excess worst-case reply capacity is reusable now.
    pub(super) fn shrink_to(&mut self, bytes: usize) {
        let retained = bytes.max(1);
        for permit in &mut self.permits {
            let permit = Arc::get_mut(permit).expect("unpublished resource has one byte owner");
            let excess = permit.num_permits() - retained;
            drop(permit.split(excess));
        }
        self.bytes = bytes;
    }
}

impl ResourceBudget {
    pub(super) fn new(engine: &NetworkBudget) -> Self {
        Self {
            context: Arc::new(Semaphore::new(CONTEXT_BYTES)),
            engine: engine.bytes.clone(),
        }
    }

    /// Reserve synchronous request bytes before decoding or copying any original entry.
    fn try_reserve(&self, bytes: usize) -> Result<ResourceReservation, JournalError> {
        let charged_bytes = bytes.max(1);
        let context = self
            .context
            .clone()
            .try_acquire_many_owned(charged_bytes as u32)
            .map_err(|_| {
                JournalError::ResourceLimit("network context resource byte allowance exhausted")
            })?;
        let engine = self
            .engine
            .clone()
            .try_acquire_many_owned(charged_bytes as u32)
            .map_err(|_| {
                JournalError::ResourceLimit("network engine resource byte allowance exhausted")
            })?;
        Ok(ResourceReservation {
            permits: vec![Arc::new(context), Arc::new(engine)],
            bytes,
        })
    }

    /// Busy consumers apply backpressure; the worker has not admitted a browser command yet.
    pub(super) async fn reserve_response(&self) -> Result<ResourceReservation, JournalError> {
        let context = self
            .context
            .clone()
            .acquire_many_owned(MAXIMUM_ENCODED_BYTES as u32)
            .await
            .map_err(|_| JournalError::Protocol("network context resource budget closed"))?;
        let engine = self
            .engine
            .clone()
            .acquire_many_owned(MAXIMUM_ENCODED_BYTES as u32)
            .await
            .map_err(|_| JournalError::Protocol("network engine resource budget closed"))?;
        Ok(ResourceReservation {
            permits: vec![Arc::new(context), Arc::new(engine)],
            bytes: MAXIMUM_ENCODED_BYTES,
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResourceMetadata {
    pub(super) token: String,
    pub(super) byte_length: usize,
    pub(super) form_encoded: bool,
}

struct Resource {
    metadata: ResourceMetadata,
    payload: Option<BinaryPayload>,
    custody: Option<ResourceReservation>,
    announced: bool,
    _metadata_reservation: Reservation,
}

pub(super) struct NetworkResources {
    entries: BTreeMap<String, Resource>,
    next_sequence: u64,
    budget: ResourceBudget,
    metadata_budget: Arc<JournalBudget>,
}

impl NetworkResources {
    pub(super) fn new(engine: &NetworkBudget, metadata_budget: Arc<JournalBudget>) -> Self {
        Self {
            entries: BTreeMap::new(),
            next_sequence: 0,
            budget: ResourceBudget::new(engine),
            metadata_budget,
        }
    }

    pub(super) fn budget(&self) -> ResourceBudget {
        self.budget.clone()
    }

    pub(super) fn pending(&self) -> bool {
        self.budget.context.available_permits() != CONTEXT_BYTES
    }

    pub(super) fn clear(&mut self) {
        self.entries.clear();
    }

    /// Chromium supplies separate canonical base64 entries; their encoded strings cannot be concatenated.
    pub(super) fn request(
        &mut self,
        entries: &Value,
        form_encoded: bool,
    ) -> Result<Option<ResourceMetadata>, JournalError> {
        let Some(entries) = entries.as_array() else {
            return Ok(None);
        };
        if entries.is_empty() {
            return Ok(None);
        }
        let mut length = 0usize;
        for entry in entries {
            let encoded = entry.as_str().ok_or(JournalError::Protocol(
                "original request body entry is not a string",
            ))?;
            let decoded = base64_decoded_length(encoded.as_bytes()).ok_or(
                JournalError::Protocol("original request body entry is invalid base64"),
            )?;
            length = length
                .checked_add(decoded)
                .filter(|total| *total <= MAXIMUM_RESOURCE_BYTES)
                .ok_or(JournalError::ResourceLimit(
                    "original request body exceeds 16 MiB",
                ))?;
        }
        let reservation = self.budget.try_reserve(length)?;
        let mut bytes = Vec::with_capacity(length);
        for entry in entries {
            append_base64(
                entry.as_str().expect("validated string").as_bytes(),
                &mut bytes,
                length,
                METHOD,
            )
            .map_err(|_| JournalError::Protocol("validated original body could not be decoded"))?;
        }
        self.accept(
            BinaryPayload {
                bytes,
                encoding: AttachmentEncoding::Raw,
                decoded_length: length,
            },
            reservation,
            form_encoded,
        )
        .map(Some)
    }

    pub(super) fn accept(
        &mut self,
        payload: BinaryPayload,
        mut reservation: ResourceReservation,
        form_encoded: bool,
    ) -> Result<ResourceMetadata, JournalError> {
        if payload.decoded_length > MAXIMUM_RESOURCE_BYTES
            || payload.bytes.len() > reservation.bytes
        {
            return Err(JournalError::ResourceLimit(
                "network body exceeds its reserved bytes",
            ));
        }
        reservation.shrink_to(payload.bytes.len());
        if self.entries.len() == 32768 {
            return Err(JournalError::ResourceLimit(
                "network recording exceeds 32768 resources",
            ));
        }
        let metadata_reservation = self.metadata_budget.reserve(512)?;
        let sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(JournalError::Protocol(
                "network resource sequence exhausted",
            ))?;
        let metadata = ResourceMetadata {
            token: format!("network-resource-{sequence:016x}"),
            byte_length: payload.decoded_length,
            form_encoded,
        };
        self.entries.insert(
            metadata.token.clone(),
            Resource {
                metadata: metadata.clone(),
                payload: Some(payload),
                custody: Some(reservation),
                announced: false,
                _metadata_reservation: metadata_reservation,
            },
        );
        self.next_sequence = sequence;
        Ok(metadata)
    }

    /// Pull only a bounded announcement batch; tokens stay valid across all later chunk prefixes.
    pub(super) fn pull(&mut self) -> Vec<ResourceMetadata> {
        self.entries
            .values_mut()
            .filter(|entry| !entry.announced)
            .take(64)
            .map(|entry| {
                entry.announced = true;
                entry.metadata.clone()
            })
            .collect()
    }

    pub(super) fn validate_take(
        &self,
        token: &str,
        maximum_bytes: usize,
    ) -> Result<(), JournalError> {
        let entry = self
            .entries
            .get(token)
            .ok_or(JournalError::Protocol("unknown original network resource"))?;
        if !entry.announced {
            return Err(JournalError::Protocol("network resource was not announced"));
        }
        if entry.metadata.byte_length > maximum_bytes {
            return Err(JournalError::ResourceLimit(
                "network resource exceeds negotiated attachment limit",
            ));
        }
        if entry.payload.is_none() {
            return Err(JournalError::Protocol(
                "network resource was already transferred",
            ));
        }
        Ok(())
    }

    pub(super) fn take(
        &mut self,
        token: &str,
        transfer: OwnedSemaphorePermit,
        maximum_bytes: usize,
    ) -> Result<BinaryAttachment, JournalError> {
        self.validate_take(token, maximum_bytes)?;
        let entry = self
            .entries
            .get_mut(token)
            .expect("validated original network resource");
        let payload = entry.payload.take().ok_or(JournalError::Protocol(
            "network resource was already transferred",
        ))?;
        let mut attachment = BinaryAttachment::from_payload(payload, transfer);
        for permit in &entry
            .custody
            .as_ref()
            .expect("untransferred resource retains custody")
            .permits
        {
            attachment.retain_byte_reservation(permit.clone());
        }
        Ok(attachment)
    }

    pub(super) fn ingested(&mut self, token: &str) -> Result<(), JournalError> {
        let entry = self
            .entries
            .get_mut(token)
            .ok_or(JournalError::Protocol("unknown original network resource"))?;
        if entry.payload.is_some() || !entry.announced {
            return Err(JournalError::Protocol(
                "network ingestion precedes original transfer",
            ));
        }
        entry.custody.take().ok_or(JournalError::Protocol(
            "network resource ingestion acknowledged twice",
        ))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn original_entries_keep_padding_and_transfer_keeps_credits_through_failure() {
        let engine = NetworkBudget::default();
        let mut resources = NetworkResources::new(&engine, JournalBudget::new(1024 * 1024));
        let metadata = resources
            .request(&json!(["AA==", "/wA=", "gA=="]), false)
            .unwrap()
            .unwrap();
        assert_eq!(metadata.byte_length, 4);
        assert_eq!(engine.bytes.available_permits(), ENGINE_BYTES - 4);
        let slot = Arc::new(Semaphore::new(1));
        assert!(
            resources
                .take(
                    &metadata.token,
                    slot.clone().acquire_owned().await.unwrap(),
                    16
                )
                .is_err()
        );
        assert_eq!(resources.pull().len(), 1);
        let transfer = resources
            .take(&metadata.token, slot.acquire_owned().await.unwrap(), 16)
            .unwrap();
        assert_eq!(transfer.bytes, vec![0, 255, 0, 128]);
        resources.clear();
        assert_eq!(engine.bytes.available_permits(), ENGINE_BYTES - 4);
        drop(transfer);
        assert_eq!(engine.bytes.available_permits(), ENGINE_BYTES);
    }

    #[tokio::test]
    async fn ingestion_releases_native_bytes_once_and_preserves_recording_tokens() {
        let engine = NetworkBudget::default();
        let mut resources = NetworkResources::new(&engine, JournalBudget::new(1024 * 1024));
        let reservation = resources.budget().reserve_response().await.unwrap();
        let metadata = resources
            .accept(
                BinaryPayload {
                    bytes: vec![],
                    encoding: AttachmentEncoding::Raw,
                    decoded_length: 0,
                },
                reservation,
                false,
            )
            .unwrap();
        assert_eq!(engine.bytes.available_permits(), ENGINE_BYTES - 1);
        assert!(resources.ingested(&metadata.token).is_err());
        resources.pull();
        let transfer = resources
            .take(
                &metadata.token,
                Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap(),
                16,
            )
            .unwrap();
        assert!(resources.pending());
        drop(transfer);
        resources.ingested(&metadata.token).unwrap();
        assert!(!resources.pending());
        assert_eq!(engine.bytes.available_permits(), ENGINE_BYTES);
        assert!(resources.ingested(&metadata.token).is_err());
        assert!(resources.pull().is_empty());
        assert_eq!(resources.entries.len(), 1);
    }

    #[test]
    fn malformed_or_oversized_request_never_acquires_credits() {
        let engine = NetworkBudget::default();
        let mut resources = NetworkResources::new(&engine, JournalBudget::new(1024 * 1024));
        for entries in [json!(["Zg==", "AB=="]), json!([12])] {
            assert!(resources.request(&entries, false).is_err());
            assert_eq!(engine.bytes.available_permits(), ENGINE_BYTES);
            assert!(resources.entries.is_empty());
        }
    }
}
