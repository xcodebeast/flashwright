//! Stream prepared binary results without retaining unbounded queued chunks.

use flashwright_engine::Operation;
use flashwright_protocol::attachment::{ATTACHMENT_CHUNK_BYTES, ATTACHMENT_HEADER_BYTES};
use flashwright_protocol::{
    AttachmentFrame, AttachmentStream, BinaryAttachment, DriverOutput, EncodedFrame, ErrorCode,
    ErrorRecord, FrameError, ResourceLimits,
};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, timeout};

const STREAM_CLEANUP_BUDGET: Duration = Duration::from_millis(500);

fn unavailable() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Protocol,
        "protocol.output",
        "attachment writer closed",
    )
}

fn incomplete() -> FrameError {
    FrameError::Truncated
}

/// Keep the operation and payload reservation alive until terminal bytes reach the pipe.
pub async fn stream_attachment(
    request_id: u64,
    attachment: BinaryAttachment,
    operation: &Operation,
    outgoing: &mpsc::Sender<DriverOutput>,
    limits: &ResourceLimits,
) -> Result<Option<EncodedFrame>, FrameError> {
    let (sender, frames) = mpsc::channel(1);
    let registration = operation
        .wait(async { outgoing.reserve().await.map_err(|_| unavailable()) })
        .await;
    match registration {
        Ok(permit) => permit.send(DriverOutput::Attachment(AttachmentStream { frames })),
        Err(error) => return super::output::prepare_error(request_id, error, limits).map(Some),
    }
    let transmission = async {
        let start = EncodedFrame::encode(
            &json!({
                "kind": "binaryStart", "requestId": request_id,
                "encoding": attachment.encoding, "byteLength": attachment.decoded_length,
                "encodedLength": attachment.bytes.len(),
            }),
            limits.control_frame_bytes,
        )
        .map_err(|error| {
            ErrorRecord::new(ErrorCode::Protocol, "protocol.output", error.to_string())
        })?;
        operation
            .wait(async {
                sender
                    .send(AttachmentFrame::Data(start))
                    .await
                    .map_err(|_| unavailable())
            })
            .await?;
        // Complete base64 groups remain independently decodable; raw data uses the same bound.
        let chunk_bytes =
            ATTACHMENT_CHUNK_BYTES.min(limits.control_frame_bytes - ATTACHMENT_HEADER_BYTES) / 4
                * 4;
        for (index, chunk) in attachment.bytes.chunks(chunk_bytes).enumerate() {
            operation.check()?;
            let frame = EncodedFrame::attachment_chunk(
                request_id,
                (index * chunk_bytes) as u32,
                chunk,
                limits.control_frame_bytes,
            )
            .map_err(|error| {
                ErrorRecord::new(ErrorCode::Protocol, "protocol.output", error.to_string())
            })?;
            operation
                .wait(async {
                    sender
                        .send(AttachmentFrame::Data(frame))
                        .await
                        .map_err(|_| unavailable())
                })
                .await?;
        }
        operation.check()
    }
    .await;

    let mut rejection = transmission.err();
    let terminal_slot = if rejection.is_none() {
        match operation
            .wait(async { sender.reserve().await.map_err(|_| unavailable()) })
            .await
        {
            Ok(slot) => Some(slot),
            Err(error) => {
                rejection = Some(error);
                None
            }
        }
    } else {
        None
    };
    let slot = match terminal_slot {
        Some(slot) => slot,
        None => timeout(STREAM_CLEANUP_BUDGET, sender.reserve())
            .await
            .map_err(|_| incomplete())?
            .map_err(|_| incomplete())?,
    };
    let frame = match rejection {
        Some(error) => super::output::prepare_error(request_id, error, limits)?,
        None => EncodedFrame::encode(
            &json!({
                "kind": "binaryResult", "requestId": request_id,
                "byteLength": attachment.decoded_length, "inputDelivery": operation.input_delivery(),
            }),
            limits.control_frame_bytes,
        )?,
    };
    let (written, mut acknowledgement) = oneshot::channel();
    slot.send(AttachmentFrame::Terminal { frame, written });
    // Once queued, the terminal outcome is committed. A late deadline may only bound
    // completion or retire the stream; it must not publish a second terminal reply.
    if let Err(error) = operation
        .wait(async { (&mut acknowledgement).await.map_err(|_| unavailable()) })
        .await
    {
        if !matches!(error.code, ErrorCode::Timeout | ErrorCode::Cancelled) {
            return Err(incomplete());
        }
        timeout(STREAM_CLEANUP_BUDGET, acknowledgement)
            .await
            .map_err(|_| incomplete())?
            .map_err(|_| incomplete())?;
    }
    drop(attachment);
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flashwright_protocol::{AttachmentEncoding, DriverMessage, FrameWriter, InputDelivery};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, DuplexStream, duplex};
    use tokio::sync::{Semaphore, watch};

    async fn read_frame(reader: &mut DuplexStream) -> Vec<u8> {
        let length = reader.read_u32_le().await.unwrap();
        let mut bytes = vec![0; length as usize];
        reader.read_exact(&mut bytes).await.unwrap();
        bytes
    }

    #[tokio::test]
    async fn binary_frames_round_trip_and_hold_the_slot_through_terminal_delivery() {
        let limits = ResourceLimits {
            control_frame_bytes: 1024,
            ..ResourceLimits::default()
        };
        let slots = Arc::new(Semaphore::new(1));
        let expected: Vec<u8> = (0..5000).map(|index| (index % 256) as u8).collect();
        let attachment = BinaryAttachment::new(
            expected.clone(),
            AttachmentEncoding::Raw,
            5000,
            slots.clone().acquire_owned().await.unwrap(),
            "test",
        )
        .unwrap();
        let (_cancel, cancellation) = watch::channel(false);
        let operation = Operation::new("test".into(), None, cancellation);
        let (outgoing, messages) = mpsc::channel(8);
        let (producer, mut consumer) = duplex(64);
        let writer_limits = limits.clone();
        let writer = tokio::spawn(async move {
            super::super::output::run_writer(
                FrameWriter::new(producer, 1024),
                messages,
                &writer_limits,
            )
            .await
        });
        let transfer = tokio::spawn(async move {
            stream_attachment(7, attachment, &operation, &outgoing, &limits).await
        });
        let start: serde_json::Value =
            serde_json::from_slice(&read_frame(&mut consumer).await).unwrap();
        assert_eq!(start["kind"], "binaryStart");
        assert_eq!(slots.available_permits(), 0);
        let mut received = Vec::new();
        loop {
            let frame = read_frame(&mut consumer).await;
            if frame[0] != 0 {
                let terminal: serde_json::Value = serde_json::from_slice(&frame).unwrap();
                assert_eq!(terminal["kind"], "binaryResult");
                assert_eq!(terminal["requestId"], 7);
                break;
            }
            assert!(frame.len() <= 1024);
            assert_eq!(u64::from_le_bytes(frame[1..9].try_into().unwrap()), 7);
            assert_eq!(
                u32::from_le_bytes(frame[9..13].try_into().unwrap()) as usize,
                received.len()
            );
            received.extend_from_slice(&frame[13..]);
        }
        assert_eq!(received, expected);
        assert!(transfer.await.unwrap().unwrap().is_none());
        assert_eq!(slots.available_permits(), 1);
        assert_eq!(
            writer.await.unwrap().unwrap(),
            super::super::output::OutputDisposition::Continue
        );
    }

    #[tokio::test]
    async fn waiting_attachment_does_not_block_other_control_frames() {
        let limits = ResourceLimits::default();
        let (outgoing, messages) = mpsc::channel(8);
        let (sender, frames) = mpsc::channel(1);
        outgoing
            .send(DriverOutput::Attachment(AttachmentStream { frames }))
            .await
            .unwrap();
        let (producer, mut consumer) = duplex(4096);
        let writer = tokio::spawn(async move {
            super::super::output::run_writer(
                FrameWriter::new(producer, limits.control_frame_bytes),
                messages,
                &limits,
            )
            .await
        });
        outgoing
            .send(
                DriverMessage::Result {
                    request_id: 9,
                    value: json!(42),
                    input_delivery: InputDelivery::NotDispatched,
                }
                .into(),
            )
            .await
            .unwrap();
        let frame = timeout(Duration::from_secs(1), read_frame(&mut consumer))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&frame).unwrap()["value"],
            42
        );
        let (written, acknowledgement) = oneshot::channel();
        sender
            .send(AttachmentFrame::Terminal {
                frame: EncodedFrame::encode(&json!({ "kind": "error", "requestId": 8 }), 1024)
                    .unwrap(),
                written,
            })
            .await
            .unwrap();
        read_frame(&mut consumer).await;
        acknowledgement.await.unwrap();
        drop(outgoing);
        writer.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancellation_discards_remaining_chunks_and_preserves_the_stream() {
        let limits = ResourceLimits::default();
        let slots = Arc::new(Semaphore::new(1));
        let attachment = BinaryAttachment::new(
            vec![42; 1024 * 1024],
            AttachmentEncoding::Raw,
            1024 * 1024,
            slots.clone().acquire_owned().await.unwrap(),
            "test",
        )
        .unwrap();
        let (cancel, cancellation) = watch::channel(false);
        let operation = Operation::new("test".into(), None, cancellation);
        let (outgoing, messages) = mpsc::channel(8);
        let transfer_sender = outgoing.clone();
        let (producer, mut consumer) = duplex(64);
        let writer_limits = limits.clone();
        let writer = tokio::spawn(async move {
            super::super::output::run_writer(
                FrameWriter::new(producer, writer_limits.control_frame_bytes),
                messages,
                &writer_limits,
            )
            .await
        });
        let transfer = tokio::spawn(async move {
            stream_attachment(7, attachment, &operation, &transfer_sender, &limits).await
        });
        read_frame(&mut consumer).await;
        cancel.send(true).unwrap();
        let mut received_bytes = 0;
        loop {
            let frame = read_frame(&mut consumer).await;
            if frame[0] == 0 {
                received_bytes += frame.len() - 13;
                continue;
            }
            let terminal: serde_json::Value = serde_json::from_slice(&frame).unwrap();
            assert_eq!(terminal["kind"], "error");
            assert_eq!(terminal["error"]["code"], "CancelledError");
            break;
        }
        assert!(received_bytes < 1024 * 1024);
        transfer.await.unwrap().unwrap();
        assert_eq!(slots.available_permits(), 1);
        outgoing
            .send(
                DriverMessage::Result {
                    request_id: 8,
                    value: json!(42),
                    input_delivery: InputDelivery::NotDispatched,
                }
                .into(),
            )
            .await
            .unwrap();
        let successor: serde_json::Value =
            serde_json::from_slice(&read_frame(&mut consumer).await).unwrap();
        assert_eq!(successor["value"], 42);
        drop(outgoing);
        writer.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lost_producer_is_fatal_instead_of_silently_omitting_the_terminal_frame() {
        let limits = ResourceLimits::default();
        let (outgoing, messages) = mpsc::channel(8);
        let (sender, frames) = mpsc::channel(1);
        outgoing
            .send(DriverOutput::Attachment(AttachmentStream { frames }))
            .await
            .unwrap();
        drop(sender);
        let (producer, _consumer) = duplex(4096);
        let result = super::super::output::run_writer(
            FrameWriter::new(producer, limits.control_frame_bytes),
            messages,
            &limits,
        )
        .await;
        assert!(matches!(result, Err(FrameError::Truncated)));
    }
}
