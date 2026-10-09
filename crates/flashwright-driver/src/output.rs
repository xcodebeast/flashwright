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
    async fn native_api_post_redirect_cookie_auth_and_binary_response_use_real_dispatch() {
        use flashwright_engine::Operation;
        use flashwright_protocol::InputAttachment;
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for turn in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(socket.read_u8().await.unwrap());
                    assert!(head.len() < 8192);
                }
                let head = String::from_utf8(head).unwrap();
                let normalized = head.to_ascii_lowercase();
                assert!(normalized.contains("x-shared: call\r\n"));
                assert!(normalized.contains("user-agent: explicit-agent\r\n"));
                match turn {
                    0 => {
                        assert!(head.starts_with("POST /redirect HTTP/1.1\r\n"));
                        assert!(normalized.contains("content-length: 4\r\n"));
                        let mut body = [0; 4];
                        socket.read_exact(&mut body).await.unwrap();
                        assert_eq!(&body, b"data");
                        socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: /auth\r\nSet-Cookie: session=redirect; Path=/; HttpOnly\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    }
                    1 => {
                        assert!(head.starts_with("GET /auth HTTP/1.1\r\n"));
                        assert!(normalized.contains("cookie: session=redirect\r\n"));
                        assert!(!normalized.contains("authorization:"));
                        assert!(!normalized.contains("content-type:"));
                        socket.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    }
                    _ => {
                        assert!(head.starts_with("GET /auth HTTP/1.1\r\n"));
                        assert!(head.contains("authorization: Basic dXNlcjpwYXNz\r\n"));
                        assert!(normalized.contains("cookie: session=redirect\r\n"));
                        socket.write_all(b"HTTP/1.1 200 Custom\r\nX-Mixed: first\r\nx-mIXED: second\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfinal\x00\xff").await.unwrap();
                    }
                }
            }
        });
        let (outgoing, _messages) = mpsc::channel(8);
        let (fatal, _failure) = watch::channel(false);
        let limits = ResourceLimits::default();
        let engine = Arc::new(Engine::new(None, outgoing, fatal, limits.clone()));
        let (_cancel, cancellation) = watch::channel(false);
        let operation = |method: &str| {
            Operation::new(
                method.into(),
                Some(tokio::time::Instant::now() + std::time::Duration::from_secs(5)),
                cancellation.clone(),
            )
        };
        let result = engine.execute("apiRequest.newContext", json!({"userAgent":"explicit-agent","extraHTTPHeaders":[{"name":"x-shared","value":"context"}],"httpCredentials":{"username":"user","password":"pass","origin":origin}}), &operation("apiRequest.newContext")).await.unwrap();
        let context = result.value().unwrap()["identifier"]
            .as_str()
            .unwrap()
            .to_owned();
        drop(
            prepare_operation_reply(
                &engine,
                1,
                "apiRequest.newContext",
                Ok(result),
                InputDelivery::Acknowledged,
                &limits,
            )
            .await
            .unwrap(),
        );
        let input_budget = Arc::new(tokio::sync::Semaphore::new(4));
        let fetch = operation("apiRequest.fetch");
        fetch
            .attach_input(InputAttachment {
                bytes: Arc::new(b"data".to_vec()),
                reservation: input_budget.clone().try_acquire_many_owned(4).unwrap(),
            })
            .unwrap();
        let result = engine.execute("apiRequest.fetch", json!({"context":context,"url":format!("{origin}/redirect"),"method":"POST","headers":[{"name":"x-shared","value":"call"},{"name":"content-type","value":"text/plain"}],"hasBody":true}), &fetch).await.unwrap();
        let metadata = result.value().unwrap().clone();
        assert_eq!(metadata["status"], 200);
        assert_eq!(metadata["statusText"], "Custom");
        assert_eq!(metadata["url"], format!("{origin}/auth"));
        assert_eq!(metadata["bodyLength"], 7);
        assert_eq!(
            metadata["headers"][0],
            json!({"name":"X-Mixed","value":"first"})
        );
        let response = metadata["identifier"].as_str().unwrap();
        drop(
            prepare_operation_reply(
                &engine,
                2,
                "apiRequest.fetch",
                Ok(result),
                InputDelivery::Acknowledged,
                &limits,
            )
            .await
            .unwrap(),
        );
        drop(fetch);
        assert_eq!(input_budget.available_permits(), 4);
        let body = engine
            .execute(
                "apiResponse.body",
                json!({"context":context,"response":response}),
                &operation("apiResponse.body"),
            )
            .await
            .unwrap();
        let OperationResult::Binary(body) = body else {
            panic!("body must use binary attachment")
        };
        assert_eq!(body.bytes.as_slice(), b"final\x00\xff");
        let original_bytes = Arc::downgrade(&body.bytes);
        let storage = engine
            .execute(
                "apiRequest.storageState",
                json!({"context":context}),
                &operation("apiRequest.storageState"),
            )
            .await
            .unwrap();
        assert_eq!(storage.value().unwrap()["cookies"][0]["value"], "redirect");
        drop(storage);
        engine
            .execute(
                "apiRequest.dispose",
                json!({"context":context}),
                &operation("apiRequest.dispose"),
            )
            .await
            .unwrap();
        assert!(original_bytes.upgrade().is_some());
        assert!(
            matches!(engine.execute("apiResponse.body", json!({"context":context,"response":response}), &operation("apiResponse.body")).await, Err(error) if error.code == ErrorCode::TargetClosed)
        );
        drop(body);
        assert!(original_bytes.upgrade().is_none());
        server.await.unwrap();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn api_snapshot_publication_uses_original_owner_and_retains_tree_through_frame_drop() {
        use flashwright_engine::Operation;
        use std::sync::Arc;
        let (outgoing, _messages) = mpsc::channel(8);
        let (fatal, _failure) = watch::channel(false);
        let limits = ResourceLimits::default();
        let engine = Arc::new(Engine::new(None, outgoing, fatal, limits.clone()));
        let (_cancel, cancellation) = watch::channel(false);
        let create = Operation::new("apiRequest.newContext".into(), None, cancellation.clone());
        let result = engine.execute("apiRequest.newContext", json!({
            "storageState": { "cookies": [], "origins": [{ "origin": "https://example.test", "localStorage": [{"name": [107], "value": [118]}] }] }
        }), &create).await.unwrap();
        let identifier = result.value().unwrap()["identifier"]
            .as_str()
            .unwrap()
            .to_owned();
        let snapshot_operation =
            Operation::new("apiRequest.storageState".into(), None, cancellation.clone());
        assert!(
            matches!(engine.execute("apiRequest.storageState", json!({"context":identifier}), &snapshot_operation).await,
            Err(error) if error.code == ErrorCode::TargetClosed)
        );
        drop(
            prepare_operation_reply(
                &engine,
                1,
                "apiRequest.newContext",
                Ok(result),
                InputDelivery::Acknowledged,
                &limits,
            )
            .await
            .unwrap(),
        );
        let snapshot = engine
            .execute(
                "apiRequest.storageState",
                json!({"context":identifier}),
                &snapshot_operation,
            )
            .await
            .unwrap();
        let OperationResult::RetainedValue(value) = &snapshot else {
            panic!("snapshot must carry original custody")
        };
        let original = Arc::downgrade(value);
        let frame = prepare_operation_reply(
            &engine,
            2,
            "apiRequest.storageState",
            Ok(snapshot),
            InputDelivery::Acknowledged,
            &limits,
        )
        .await
        .unwrap();
        let late = engine
            .execute(
                "apiRequest.storageState",
                json!({"context":identifier}),
                &snapshot_operation,
            )
            .await
            .unwrap();
        let dispose = Operation::new("apiRequest.dispose".into(), None, cancellation);
        engine
            .execute(
                "apiRequest.dispose",
                json!({"context":identifier}),
                &dispose,
            )
            .await
            .unwrap();
        let rejected = prepare_operation_reply(
            &engine,
            3,
            "apiRequest.storageState",
            Ok(late),
            InputDelivery::Acknowledged,
            &limits,
        )
        .await
        .unwrap();
        engine.shutdown().await;
        assert!(original.upgrade().is_some());
        let (producer, consumer) = duplex(16 * 1024);
        let mut writer = FrameWriter::new(producer, limits.control_frame_bytes);
        writer.write_frame(&frame).await.unwrap();
        writer.write_frame(&rejected).await.unwrap();
        drop(writer);
        let mut reader = FrameReader::new(consumer, limits.control_frame_bytes);
        let result = reader.read::<Value>().await.unwrap().unwrap();
        assert_eq!(
            result["value"]["origins"][0]["localStorage"][0]["value"],
            json!([118])
        );
        assert_eq!(
            reader.read::<Value>().await.unwrap().unwrap()["error"]["code"],
            "TargetClosedError"
        );
        assert!(original.upgrade().is_some());
        drop(frame);
        assert!(original.upgrade().is_none());
    }

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
