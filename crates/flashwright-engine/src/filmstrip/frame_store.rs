//! Metadata claims keep image bytes owned until a bounded attachment transfer takes them.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use flashwright_protocol::{BinaryPayload, ErrorCode, ErrorRecord};
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::time::Instant;

pub(super) const MAXIMUM_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_CONTEXT_BYTES: usize = 16 * 1024 * 1024;
const MAXIMUM_ENGINE_BYTES: usize = 32 * 1024 * 1024;
const MAXIMUM_CONTEXT_FRAMES: usize = 128;
const MAXIMUM_CAPTURE_PAGES: usize = 128;

pub(crate) struct FrameBudget {
    bytes: AtomicUsize,
    pub(super) pages: Arc<Semaphore>,
    started: Instant,
}

impl Default for FrameBudget {
    fn default() -> Self {
        Self {
            bytes: AtomicUsize::new(0),
            pages: Arc::new(Semaphore::new(MAXIMUM_CAPTURE_PAGES)),
            started: Instant::now(),
        }
    }
}

impl FrameBudget {
    pub(super) fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    /// Reserve before copying a borrowed CDP payload into recording-owned memory.
    pub(super) fn reserve(self: &Arc<Self>, bytes: usize) -> Result<FrameReservation, ErrorRecord> {
        self.bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |retained| {
                retained
                    .checked_add(bytes)
                    .filter(|total| *total <= MAXIMUM_ENGINE_BYTES)
            })
            .map_err(|_| resource_limit("engine filmstrip queue exceeds 32 MiB"))?;
        Ok(FrameReservation {
            budget: self.clone(),
            bytes,
        })
    }
}

pub(super) struct FrameReservation {
    budget: Arc<FrameBudget>,
    bytes: usize,
}

impl Drop for FrameReservation {
    fn drop(&mut self) {
        self.budget.bytes.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FrameMetadata {
    pub token: u64,
    pub page: String,
    pub width: f64,
    pub height: f64,
    pub timestamp: f64,
    pub frame_swap_wall_time: f64,
    pub byte_length: usize,
}

struct StoredFrame {
    metadata: FrameMetadata,
    payload: BinaryPayload,
    published: bool,
    announced: bool,
    reservation: FrameReservation,
}

#[derive(Default)]
pub(super) struct FrameStore {
    frames: BTreeMap<u64, StoredFrame>,
    bytes: usize,
    next_token: u64,
    sealed: bool,
    failure: Option<ErrorRecord>,
}

impl FrameStore {
    pub(super) fn accepting(&self) -> bool {
        !self.sealed && self.failure.is_none()
    }

    pub(super) fn check_capacity(&self, bytes: usize) -> Result<(), ErrorRecord> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        if self.frames.len() >= MAXIMUM_CONTEXT_FRAMES || self.bytes + bytes > MAXIMUM_CONTEXT_BYTES
        {
            return Err(resource_limit(
                "context filmstrip queue exceeds 128 frames or 16 MiB",
            ));
        }
        Ok(())
    }

    /// Admission happens under the recording lock after all independent byte reservations.
    pub(super) fn insert(
        &mut self,
        mut metadata: FrameMetadata,
        payload: BinaryPayload,
        published: bool,
        reservation: FrameReservation,
    ) -> Result<(), ErrorRecord> {
        if !self.accepting() {
            return Ok(());
        }
        self.check_capacity(payload.bytes.len())?;
        self.next_token = self
            .next_token
            .checked_add(1)
            .filter(|token| *token <= 9_007_199_254_740_991)
            .ok_or_else(|| resource_limit("filmstrip token space exhausted"))?;
        metadata.token = self.next_token;
        self.bytes += payload.bytes.len();
        self.frames.insert(
            metadata.token,
            StoredFrame {
                metadata,
                payload,
                published,
                announced: false,
                reservation,
            },
        );
        Ok(())
    }

    pub(super) fn publish(&mut self, page: &str) {
        for frame in self.frames.values_mut() {
            if frame.metadata.page == page {
                frame.published = true;
            }
        }
    }

    pub(super) fn discard_unpublished(&mut self, page: &str) {
        let mut removed_bytes = 0;
        self.frames.retain(|_, frame| {
            let retain = frame.published || frame.metadata.page != page;
            if !retain {
                removed_bytes += frame.payload.bytes.len();
            }
            retain
        });
        self.bytes -= removed_bytes;
    }

    /// Claims expose only metadata; stalled collectors keep consuming the queue budget.
    pub(super) fn claim(&mut self, maximum: usize) -> Result<Vec<FrameMetadata>, ErrorRecord> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let mut result = Vec::new();
        for frame in self.frames.values_mut() {
            if result.len() == maximum {
                break;
            }
            if frame.published && !frame.announced {
                frame.announced = true;
                result.push(frame.metadata.clone());
            }
        }
        Ok(result)
    }

    /// The caller already owns an attachment slot, so bytes move between bounded stages.
    pub(super) fn take(&mut self, token: u64) -> Result<BinaryPayload, ErrorRecord> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        if !self
            .frames
            .get(&token)
            .is_some_and(|frame| frame.published && frame.announced)
        {
            return Err(ErrorRecord::new(
                ErrorCode::InvalidArgument,
                "context.trace.filmstrip.take",
                "frame token is unavailable or has already been consumed",
            ));
        }
        let frame = self.frames.remove(&token).unwrap();
        self.bytes -= frame.payload.bytes.len();
        drop(frame.reservation);
        Ok(frame.payload)
    }

    pub(super) fn seal(&mut self) {
        self.sealed = true;
    }

    pub(super) fn fail(&mut self, error: ErrorRecord) {
        if self.failure.is_none() {
            self.failure = Some(error);
        }
        self.discard();
    }

    pub(super) fn failure(&self) -> Option<ErrorRecord> {
        self.failure.clone()
    }

    pub(super) fn discard(&mut self) {
        self.sealed = true;
        self.frames.clear();
        self.bytes = 0;
    }
}

pub(super) fn resource_limit(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, "context.trace.filmstrip", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flashwright_protocol::AttachmentEncoding;

    fn insert(
        store: &mut FrameStore,
        budget: &Arc<FrameBudget>,
        page: &str,
        published: bool,
        bytes: usize,
    ) {
        let reservation = budget.reserve(bytes).unwrap();
        store
            .insert(
                FrameMetadata {
                    token: 0,
                    page: page.into(),
                    width: 800.0,
                    height: 600.0,
                    timestamp: 1.0,
                    frame_swap_wall_time: 2.0,
                    byte_length: bytes,
                },
                BinaryPayload {
                    bytes: vec![0; bytes],
                    encoding: AttachmentEncoding::Raw,
                    decoded_length: bytes,
                },
                published,
                reservation,
            )
            .unwrap();
    }

    #[test]
    fn publication_claim_and_transfer_have_distinct_ownership() {
        let budget = Arc::new(FrameBudget::default());
        let mut store = FrameStore::default();
        insert(&mut store, &budget, "page", false, 16);
        assert!(store.claim(128).unwrap().is_empty());
        store.publish("page");
        let token = store.claim(1).unwrap()[0].token;
        assert!(store.claim(128).unwrap().is_empty());
        assert_eq!(budget.bytes.load(Ordering::Relaxed), 16);
        store.seal();
        assert_eq!(store.take(token).unwrap().bytes.len(), 16);
        assert_eq!(budget.bytes.load(Ordering::Relaxed), 0);
        assert!(store.take(token).is_err());
    }

    #[test]
    fn failed_publication_and_capture_failure_release_claimed_and_unclaimed_bytes() {
        let budget = Arc::new(FrameBudget::default());
        let mut store = FrameStore::default();
        insert(&mut store, &budget, "failed", false, 16);
        insert(&mut store, &budget, "visible", true, 32);
        store.discard_unpublished("failed");
        assert_eq!(budget.bytes.load(Ordering::Relaxed), 32);
        let token = store.claim(1).unwrap()[0].token;
        store.fail(resource_limit("full"));
        assert_eq!(budget.bytes.load(Ordering::Relaxed), 0);
        assert!(store.take(token).is_err());
        assert!(store.claim(128).is_err());
    }

    #[test]
    fn admission_limits_count_claimed_frames_and_aggregate_reservations() {
        let budget = Arc::new(FrameBudget::default());
        let mut store = FrameStore::default();
        for _ in 0..MAXIMUM_CONTEXT_FRAMES {
            insert(&mut store, &budget, "page", true, 1);
        }
        assert_eq!(
            store.claim(MAXIMUM_CONTEXT_FRAMES).unwrap().len(),
            MAXIMUM_CONTEXT_FRAMES
        );
        assert!(store.check_capacity(1).is_err());
        store.discard();
        let first = budget.reserve(MAXIMUM_CONTEXT_BYTES).unwrap();
        let second = budget.reserve(MAXIMUM_CONTEXT_BYTES).unwrap();
        assert!(budget.reserve(1).is_err());
        drop(first);
        drop(second);
        assert_eq!(budget.bytes.load(Ordering::Relaxed), 0);
    }
}
