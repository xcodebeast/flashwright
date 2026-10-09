//! Request-owned input assembly keeps browser work and cancellation off the frame reader.

use std::collections::HashMap;
use std::sync::Arc;

use flashwright_protocol::{ErrorCode, ErrorRecord, FrameError, InputAttachment, ResourceLimits};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};

struct IncomingInput {
    declared_bytes: usize,
    received_bytes: usize,
    bytes: Option<Vec<u8>>,
    reservation: Option<OwnedSemaphorePermit>,
    receiver: Option<oneshot::Sender<InputAttachment>>,
}

pub struct InputAttachments {
    active: HashMap<u64, IncomingInput>,
    slots: Arc<Semaphore>,
    maximum_bytes: usize,
    maximum_streams: usize,
}

impl InputAttachments {
    pub fn new(limits: &ResourceLimits) -> Self {
        Self {
            active: HashMap::new(),
            slots: Arc::new(Semaphore::new(limits.pending_attachments)),
            maximum_bytes: limits.binary_attachment_bytes,
            maximum_streams: limits.pending_operations,
        }
    }

    /// Even a rejected header owns late queued chunks until the sender closes that stream.
    pub fn begin(
        &mut self,
        request_id: u64,
        declared_bytes: usize,
        method: &str,
        validation: Result<(), ErrorRecord>,
    ) -> Result<Result<oneshot::Receiver<InputAttachment>, ErrorRecord>, FrameError> {
        if self.active.len() >= self.maximum_streams || self.active.contains_key(&request_id) {
            return Err(FrameError::InvalidAttachment);
        }
        let input = self.active.entry(request_id).or_insert(IncomingInput {
            declared_bytes,
            received_bytes: 0,
            bytes: None,
            reservation: None,
            receiver: None,
        });
        let prepare = || {
            validation?;
            if declared_bytes > self.maximum_bytes {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "binary input exceeds negotiated byte limit",
                ));
            }
            let reservation = self.slots.clone().try_acquire_owned().map_err(|_| {
                ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "too many active binary inputs",
                )
            })?;
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(declared_bytes).map_err(|_| {
                ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "binary input allocation failed",
                )
            })?;
            let (sender, receiver) = oneshot::channel();
            input.bytes = Some(bytes);
            input.reservation = Some(reservation);
            input.receiver = Some(sender);
            Ok(receiver)
        };
        Ok(prepare())
    }

    /// Discarded streams still enforce exact offsets and lengths without retaining payloads.
    pub fn receive(
        &mut self,
        request_id: u64,
        offset: u32,
        bytes: &[u8],
    ) -> Result<(), FrameError> {
        let input = self
            .active
            .get_mut(&request_id)
            .ok_or(FrameError::InvalidAttachment)?;
        if bytes.is_empty()
            || bytes.len() > flashwright_protocol::attachment::ATTACHMENT_CHUNK_BYTES
            || offset as usize != input.received_bytes
            || bytes.len() > input.declared_bytes.saturating_sub(input.received_bytes)
        {
            return Err(FrameError::InvalidAttachment);
        }
        if let Some(buffer) = &mut input.bytes {
            buffer.extend_from_slice(bytes);
        }
        input.received_bytes += bytes.len();
        Ok(())
    }

    /// A complete body moves its reservation to the operation; aborts release it immediately.
    pub fn finish(&mut self, request_id: u64, aborted: bool) -> Result<(), FrameError> {
        let input = self
            .active
            .remove(&request_id)
            .ok_or(FrameError::InvalidAttachment)?;
        if !aborted && input.received_bytes != input.declared_bytes {
            return Err(FrameError::InvalidAttachment);
        }
        if !aborted
            && let (Some(bytes), Some(reservation), Some(receiver)) =
                (input.bytes, input.reservation, input.receiver)
        {
            let _ = receiver.send(InputAttachment {
                bytes: Arc::new(bytes),
                reservation,
            });
        }
        Ok(())
    }

    /// Retain only bounded framing metadata after an operation no longer wants its bytes.
    pub fn expire(&mut self, request_id: u64) {
        if let Some(input) = self.active.get_mut(&request_id) {
            input.bytes = None;
            input.reservation = None;
            input.receiver = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> InputAttachments {
        InputAttachments::new(&ResourceLimits {
            binary_attachment_bytes: 8,
            pending_attachments: 1,
            pending_operations: 4,
            ..ResourceLimits::default()
        })
    }

    #[tokio::test]
    async fn bytes_and_reservation_move_once_and_remain_owned_after_transfer() {
        let mut inputs = inputs();
        let receiver = inputs.begin(1, 4, "upload", Ok(())).unwrap().unwrap();
        inputs.receive(1, 0, &[0, 255]).unwrap();
        inputs.receive(1, 2, &[128, 13]).unwrap();
        inputs.finish(1, false).unwrap();
        let attachment = receiver.await.unwrap();
        assert_eq!(attachment.bytes.as_slice(), [0, 255, 128, 13]);
        assert_eq!(inputs.slots.available_permits(), 0);
        assert!(inputs.begin(2, 1, "upload", Ok(())).unwrap().is_err());
        inputs.receive(2, 0, &[42]).unwrap();
        inputs.finish(2, false).unwrap();
        drop(attachment);
        assert_eq!(inputs.slots.available_permits(), 1);
        assert!(inputs.finish(1, false).is_err());
    }

    #[tokio::test]
    async fn cancellation_releases_bytes_but_checks_late_chunks_without_blocking_a_successor() {
        let mut inputs = inputs();
        let cancelled = inputs.begin(1, 4, "upload", Ok(())).unwrap().unwrap();
        inputs.receive(1, 0, &[1, 2]).unwrap();
        inputs.expire(1);
        assert!(cancelled.await.is_err());
        assert!(inputs.active[&1].bytes.is_none());
        let successor = inputs.begin(2, 1, "upload", Ok(())).unwrap().unwrap();
        assert!(inputs.receive(1, 0, &[3]).is_err());
        inputs.receive(1, 2, &[3]).unwrap();
        inputs.finish(1, true).unwrap();
        inputs.receive(2, 0, &[9]).unwrap();
        inputs.finish(2, false).unwrap();
        assert_eq!(successor.await.unwrap().bytes.as_slice(), [9]);
    }

    #[tokio::test]
    async fn rejected_headers_own_late_input_and_empty_bodies_are_complete() {
        let mut inputs = inputs();
        assert!(inputs.begin(1, 9, "upload", Ok(())).unwrap().is_err());
        inputs.receive(1, 0, &[1, 2]).unwrap();
        inputs.finish(1, true).unwrap();
        assert!(
            inputs
                .begin(
                    2,
                    1,
                    "upload",
                    Err(ErrorRecord::new(
                        ErrorCode::InvalidArgument,
                        "upload",
                        "invalid metadata"
                    ))
                )
                .unwrap()
                .is_err()
        );
        inputs.receive(2, 0, &[7]).unwrap();
        inputs.finish(2, false).unwrap();
        let empty = inputs.begin(3, 0, "upload", Ok(())).unwrap().unwrap();
        inputs.finish(3, false).unwrap();
        assert!(empty.await.unwrap().bytes.is_empty());
    }

    #[test]
    fn incomplete_unknown_duplicate_overlength_and_unbounded_discard_streams_reject() {
        let mut inputs = inputs();
        assert!(inputs.receive(99, 0, &[1]).is_err());
        let _receiver = inputs.begin(1, 2, "upload", Ok(())).unwrap().unwrap();
        assert!(inputs.begin(1, 1, "upload", Ok(())).is_err());
        assert!(inputs.receive(1, 0, &[1, 2, 3]).is_err());
        assert!(inputs.finish(1, false).is_err());
        assert_eq!(inputs.slots.available_permits(), 1);
        for request in 2..6 {
            let _ = inputs.begin(request, 9, "upload", Ok(())).unwrap();
        }
        assert!(inputs.begin(6, 9, "upload", Ok(())).is_err());
    }
}
