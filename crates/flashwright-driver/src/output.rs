//! Prepare bounded terminal replies before publication; never replay completed operations.

use flashwright_engine::{Engine, OperationResult};
use flashwright_protocol::{AttachmentFrame, AttachmentStream};
use flashwright_protocol::{
    DriverMessage, DriverOutput, EncodedFrame, ErrorCode, ErrorRecord, FrameError, FrameWriter,
    InputDelivery, ResourceLimits,
};
#[cfg(test)]
use serde_json::Value;
use std::collections::VecDeque;
use tokio::io::AsyncWrite;
use tokio::sync::mpsc;

#[derive(Debug, PartialEq, Eq)]
pub enum OutputDisposition {
    Continue,
    CloseStream,
}

/// Round-robin attachment frames while continuing to deliver other replies and events.
pub async fn run_writer<Writer: AsyncWrite + Unpin>(
    mut writer: FrameWriter<Writer>,
    mut messages: mpsc::Receiver<DriverOutput>,
    limits: &ResourceLimits,
) -> Result<OutputDisposition, FrameError> {
    enum Next {
        Output(Option<DriverOutput>),
        Attachment(Option<AttachmentFrame>),
    }
    let mut streams: VecDeque<AttachmentStream> = VecDeque::new();
    let mut input_open = true;
    loop {
        let next = if let Some(stream) = streams.front_mut() {
            tokio::select! {
                message = messages.recv(), if input_open => Next::Output(message),
                frame = stream.frames.recv() => Next::Attachment(frame),
            }
        } else if input_open {
            Next::Output(messages.recv().await)
        } else {
            return Ok(OutputDisposition::Continue);
        };
        match next {
            Next::Output(None) => input_open = false,
            Next::Output(Some(DriverOutput::Attachment(stream))) => {
                if streams.len() >= limits.pending_attachments {
                    return Err(FrameError::InvalidAttachment);
                }
                streams.push_back(stream);
            }
            Next::Output(Some(output)) => {
                if write_output(&mut writer, output, limits).await?
                    == OutputDisposition::CloseStream
                {
                    return Ok(OutputDisposition::CloseStream);
                }
            }
            Next::Attachment(None) => return Err(FrameError::Truncated),
            Next::Attachment(Some(frame)) => {
                let stream = streams.pop_front().unwrap();
                match frame {
                    AttachmentFrame::Data(frame) => {
                        writer.write_frame(&frame).await?;
                        streams.push_back(stream);
                    }
                    AttachmentFrame::Terminal { frame, written } => {
                        writer.write_frame(&frame).await?;
                        let _ = written.send(());
                    }
                }
            }
        }
    }
}

fn resource_error(
    message: impl Into<String>,
    delivery: InputDelivery,
    cleanup: Option<Box<str>>,
) -> ErrorRecord {
    // The rejected method itself can fill the incoming frame. Keep replacement metadata bounded.
    let mut error = ErrorRecord::new(ErrorCode::ResourceLimit, "protocol.output", message);
    error.input_delivery = delivery;
    error.cleanup = cleanup;
    error
}

pub fn prepare_error(
    request_id: u64,
    error: ErrorRecord,
    limits: &ResourceLimits,
) -> Result<EncodedFrame, FrameError> {
    let error = match limits.validate_error(&error) {
        Ok(()) => error,
        Err(rejection) => resource_error(
            rejection.message.to_string(),
            error.input_delivery,
            error.cleanup.clone(),
        ),
    };
    let message = DriverMessage::Error {
        request_id: Some(request_id),
        error,
    };
    match EncodedFrame::encode(&message, limits.control_frame_bytes) {
        Ok(frame) => Ok(frame),
        Err(failure @ FrameError::TooLarge { .. }) => {
            let DriverMessage::Error { error, .. } = message else {
                unreachable!()
            };
            EncodedFrame::encode(
                &DriverMessage::Error {
                    request_id: Some(request_id),
                    error: resource_error(
                        failure.to_string(),
                        error.input_delivery,
                        error.cleanup.clone(),
                    ),
                },
                limits.control_frame_bytes,
            )
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
pub async fn prepare_reply(
    engine: &Engine,
    request_id: u64,
    method: &str,
    result: Result<Value, ErrorRecord>,
    delivery: InputDelivery,
    limits: &ResourceLimits,
) -> Result<EncodedFrame, FrameError> {
    prepare_operation_reply(
        engine,
        request_id,
        method,
        result.map(OperationResult::Value),
        delivery,
        limits,
    )
    .await
}

pub async fn prepare_operation_reply(
    engine: &Engine,
    request_id: u64,
    method: &str,
    result: Result<OperationResult, ErrorRecord>,
    delivery: InputDelivery,
    limits: &ResourceLimits,
) -> Result<EncodedFrame, FrameError> {
    let mut value = match result {
        Ok(value) => value,
        Err(mut error) => {
            error.input_delivery = error.input_delivery.max(delivery);
            return prepare_error(request_id, error, limits);
        }
    };
    let prepared = engine.prepare_operation_publication(method, &mut value, |value, custody| {
        limits.validate_value(value).map_err(|mut error| {
            error.method = "protocol.output".into();
            error
        })?;
        let mut frame =
            DriverMessage::encode_result(request_id, value, delivery, limits.control_frame_bytes)
                .map_err(|error| {
                let code = if matches!(error, FrameError::TooLarge { .. }) {
                    ErrorCode::ResourceLimit
                } else {
                    ErrorCode::Protocol
                };
                ErrorRecord::new(code, "protocol.output", error.to_string())
            })?;
        if let Some(custody) = custody {
            frame.retain_reservation(custody);
        }
        Ok(frame)
    });
    match prepared {
        Ok(frame) => Ok(frame),
        Err(mut error) => {
            error.input_delivery = error.input_delivery.max(delivery);
            if let Some(value) = value.value()
                && let Some(cleanup) = engine.discard_unreturned_allocation(method, value).await
            {
                error.cleanup = Some(cleanup.into());
            }
            prepare_error(request_id, error, limits)
        }
    }
}

/// An omitted event would desynchronize object state. Send a bounded global error and close.
pub async fn write_output<Writer: AsyncWrite + Unpin>(
    writer: &mut FrameWriter<Writer>,
    output: DriverOutput,
    limits: &ResourceLimits,
) -> Result<OutputDisposition, FrameError> {
    let message = match output {
        DriverOutput::Frame(frame) => {
            writer.write_frame(&frame).await?;
            return Ok(OutputDisposition::Continue);
        }
        DriverOutput::Message(message) => message,
        DriverOutput::Attachment(_) => return Err(FrameError::InvalidAttachment),
    };
    let rejection = match &message {
        DriverMessage::Event { parameters, .. } => limits
            .validate_value(parameters)
            .err()
            .map(|error| error.message.to_string()),
        DriverMessage::Error { error, .. } => limits
            .validate_error(error)
            .err()
            .map(|error| error.message.to_string()),
        _ => None,
    };
    let reason = match rejection {
        Some(reason) => reason,
        None => match EncodedFrame::encode(&message, limits.control_frame_bytes) {
            Ok(frame) => {
                writer.write_frame(&frame).await?;
                return Ok(
                    if matches!(
                        message,
                        DriverMessage::Error {
                            request_id: None,
                            ..
                        }
                    ) {
                        OutputDisposition::CloseStream
                    } else {
                        OutputDisposition::Continue
                    },
                );
            }
            Err(error @ FrameError::TooLarge { .. }) => error.to_string(),
            Err(error) => return Err(error),
        },
    };
    writer
        .write(&DriverMessage::Error {
            request_id: None,
            error: resource_error(reason, InputDelivery::Uncertain, None),
        })
        .await?;
    Ok(OutputDisposition::CloseStream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flashwright_protocol::{FrameReader, Handshake};
    use serde_json::json;
    use tokio::io::duplex;
    use tokio::sync::{mpsc, watch};

    #[tokio::test]
    async fn rejected_values_preserve_delivery_and_successor_frames() {
        let (outgoing, _messages) = mpsc::channel(8);
        let (fatal, _failure) = watch::channel(false);
        let engine = Engine::new(None, outgoing, fatal, ResourceLimits::default());
        let limits = ResourceLimits {
            control_frame_bytes: 1024,
            ..ResourceLimits::default()
        };
        let (producer, consumer) = duplex(4096);
        let mut writer = FrameWriter::new(producer, limits.control_frame_bytes);
        let rejected = prepare_reply(
            &engine,
            1,
            "page.evaluate",
            Ok(json!("x".repeat(4096))),
            InputDelivery::Acknowledged,
            &limits,
        )
        .await
        .unwrap();
        writer.write_frame(&rejected).await.unwrap();
        let successor = prepare_reply(
            &engine,
            2,
            "page.evaluate",
            Ok(json!(42)),
            InputDelivery::NotDispatched,
            &limits,
        )
        .await
        .unwrap();
        writer.write_frame(&successor).await.unwrap();
        drop(writer);
        let mut reader = FrameReader::new(consumer, limits.control_frame_bytes);
        let rejection = reader.read::<Value>().await.unwrap().unwrap();
        assert_eq!(rejection["requestId"], 1);
        assert_eq!(rejection["error"]["code"], "ResourceLimitError");
        assert_eq!(rejection["error"]["inputDelivery"], "acknowledged");
        assert_eq!(reader.read::<Value>().await.unwrap().unwrap()["value"], 42);
        assert!(reader.read::<Value>().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn oversized_error_preserves_cleanup_and_uncertainty() {
        let limits = ResourceLimits {
            control_frame_bytes: 1024,
            ..ResourceLimits::default()
        };
        let mut error = ErrorRecord::new(ErrorCode::Evaluation, "m".repeat(4096), "failure");
        error.message_utf16 = Some(vec![55296; 4096].into_boxed_slice());
        error.cleanup = Some("resourceDisposed".into());
        error.input_delivery = InputDelivery::Uncertain;
        let frame = prepare_error(9, error, &limits).unwrap();
        let (producer, consumer) = duplex(1024);
        FrameWriter::new(producer, 1024)
            .write_frame(&frame)
            .await
            .unwrap();
        let message = FrameReader::new(consumer, 1024)
            .read::<Value>()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(message["requestId"], 9);
        assert_eq!(message["error"]["code"], "ResourceLimitError");
        assert_eq!(message["error"]["method"], "protocol.output");
        assert_eq!(message["error"]["cleanup"], "resourceDisposed");
        assert_eq!(message["error"]["inputDelivery"], "uncertain");
    }

    #[tokio::test]
    async fn events_and_handshakes_that_cannot_fit_send_a_global_error_and_close() {
        let limits = ResourceLimits {
            control_frame_bytes: 1024,
            value_nodes: 4,
            ..ResourceLimits::default()
        };
        let messages = [
            DriverMessage::Event {
                target: "page".into(),
                event: "response".into(),
                parameters: json!("x".repeat(4096)),
            },
            DriverMessage::Event {
                target: "page".into(),
                event: "frames".into(),
                parameters: json!([1, 2, 3, 4]),
            },
            DriverMessage::Handshake {
                handshake: Handshake::default(),
                capabilities: vec!["x".repeat(4096)],
                resident_runtime_sha256: "digest".into(),
                browser_identity: None,
                browser_encodings: vec!["json".into()],
            },
        ];
        for message in messages {
            let (producer, consumer) = duplex(1024);
            let mut writer = FrameWriter::new(producer, 1024);
            assert_eq!(
                write_output(&mut writer, message.into(), &limits)
                    .await
                    .unwrap(),
                OutputDisposition::CloseStream
            );
            drop(writer);
            let mut reader = FrameReader::new(consumer, 1024);
            let error = reader.read::<Value>().await.unwrap().unwrap();
            assert_eq!(error["requestId"], Value::Null);
            assert_eq!(error["error"]["code"], "ResourceLimitError");
            assert!(reader.read::<Value>().await.unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn originating_global_error_is_written_before_closing_the_stream() {
        let limits = ResourceLimits::default();
        let (producer, consumer) = duplex(1024);
        let mut writer = FrameWriter::new(producer, limits.control_frame_bytes);
        let message = DriverMessage::Error {
            request_id: None,
            error: ErrorRecord::new(ErrorCode::ResourceLimit, "console", "handle limit exceeded"),
        };
        assert_eq!(
            write_output(&mut writer, message.into(), &limits)
                .await
                .unwrap(),
            OutputDisposition::CloseStream
        );
        drop(writer);
        let mut reader = FrameReader::new(consumer, limits.control_frame_bytes);
        let error = reader.read::<Value>().await.unwrap().unwrap();
        assert_eq!(error["error"]["code"], "ResourceLimitError");
        assert_eq!(error["error"]["method"], "console");
        assert_eq!(error["error"]["message"], "handle limit exceeded");
        assert!(reader.read::<Value>().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn actual_write_failures_propagate_and_poison_the_stream() {
        let (producer, consumer) = duplex(1024);
        drop(consumer);
        let limits = ResourceLimits::default();
        let mut writer = FrameWriter::new(producer, limits.control_frame_bytes);
        let frame = DriverMessage::encode_result(
            1,
            &json!(42),
            InputDelivery::Acknowledged,
            limits.control_frame_bytes,
        )
        .unwrap();
        assert!(matches!(
            write_output(&mut writer, DriverOutput::Frame(frame), &limits).await,
            Err(FrameError::Io(_))
        ));
        assert!(matches!(
            writer.write(&42).await,
            Err(FrameError::Invalidated)
        ));
    }

    #[tokio::test]
    async fn rejected_diagnostics_preserve_cleanup_within_the_fixed_error_envelope() {
        let limits = ResourceLimits {
            value_depth: 2,
            value_nodes: 8,
            ..ResourceLimits::default()
        };
        for diagnostics in [json!([[[1]]]), json!([1, 2, 3, 4, 5, 6, 7, 8])] {
            let mut error = ErrorRecord::new(ErrorCode::Timeout, "assertion.run", "failed");
            error.diagnostics = Some(Box::new(diagnostics));
            error.cleanup = Some("resourceDisposed".into());
            error.input_delivery = InputDelivery::Acknowledged;
            let frame = prepare_error(4, error, &limits).unwrap();
            let (producer, consumer) = duplex(1024);
            FrameWriter::new(producer, 1024)
                .write_frame(&frame)
                .await
                .unwrap();
            let reply = FrameReader::new(consumer, 1024)
                .read::<Value>()
                .await
                .unwrap()
                .unwrap();
            assert_eq!(reply["error"]["code"], "ResourceLimitError");
            assert_eq!(reply["error"]["cleanup"], "resourceDisposed");
            assert_eq!(reply["error"]["inputDelivery"], "acknowledged");
        }
    }
}
