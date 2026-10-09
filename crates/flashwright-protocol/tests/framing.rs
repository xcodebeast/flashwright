use flashwright_protocol::{
    ClientMessage, DriverMessage, EncodedFrame, FrameError, FrameReader, FrameWriter, Handshake,
    InputDelivery, ResourceLimits,
};
use serde_json::{Value, json};
use tokio::io::{AsyncWriteExt, duplex};
use tokio::time::{Duration, timeout};

#[tokio::test]
async fn fragmented_and_concatenated_frames_preserve_unicode_and_nul() {
    let messages = [
        json!({ "text": "hello\0😃é", "number": 42 }),
        json!([false, null]),
    ];
    let (mut producer, consumer) = duplex(32);
    let expected = messages.clone();
    let producer_task = tokio::spawn(async move {
        for message in messages {
            let payload = serde_json::to_vec(&message).unwrap();
            let bytes = (payload.len() as u32)
                .to_le_bytes()
                .into_iter()
                .chain(payload);
            for byte in bytes {
                producer.write_all(&[byte]).await.unwrap();
            }
        }
    });
    let mut reader = FrameReader::new(consumer, 1024);
    for message in expected {
        assert_eq!(reader.read::<Value>().await.unwrap(), Some(message));
    }
    assert!(reader.read::<Value>().await.unwrap().is_none());
    producer_task.await.unwrap();
}

#[tokio::test]
async fn truncation_and_oversized_lengths_invalidate_without_allocating_the_payload() {
    for bytes in [vec![5, 0], vec![5, 0, 0, 0, b'{'], vec![255, 255, 255, 255]] {
        let mut reader = FrameReader::new(bytes.as_slice(), 1024);
        assert!(matches!(
            reader.read::<Value>().await,
            Err(FrameError::Truncated | FrameError::TooLarge { .. })
        ));
        assert!(matches!(
            reader.read::<Value>().await,
            Err(FrameError::Invalidated)
        ));
    }
}

#[tokio::test]
async fn malformed_json_cannot_be_followed_by_an_apparently_valid_frame() {
    let bytes = [1, 0, 0, 0, b'?', 4, 0, 0, 0, b'n', b'u', b'l', b'l'];
    let mut reader = FrameReader::new(bytes.as_slice(), 1024);
    assert!(matches!(
        reader.read::<Value>().await,
        Err(FrameError::Json(_))
    ));
    assert!(matches!(
        reader.read::<Value>().await,
        Err(FrameError::Invalidated)
    ));
}

#[tokio::test(start_paused = true)]
async fn cancellation_of_a_blocked_partial_write_invalidates_the_stream() {
    let (producer, _unread_consumer) = duplex(4);
    let mut writer = FrameWriter::new(producer, 1024);
    assert!(
        timeout(
            Duration::from_millis(10),
            writer.write(&json!({ "body": "blocked" }))
        )
        .await
        .is_err()
    );
    assert!(matches!(
        writer.write(&json!(null)).await,
        Err(FrameError::Invalidated)
    ));
}

#[tokio::test(start_paused = true)]
async fn cancellation_of_a_fragmented_read_invalidates_the_stream() {
    let (mut producer, consumer) = duplex(4);
    producer.write_all(&[9, 0]).await.unwrap();
    let mut reader = FrameReader::new(consumer, 1024);
    assert!(
        timeout(Duration::from_millis(10), reader.read::<Value>())
            .await
            .is_err()
    );
    assert!(matches!(
        reader.read::<Value>().await,
        Err(FrameError::Invalidated)
    ));
}

#[test]
fn handshake_rejects_incompatible_versions_and_invalid_limits() {
    let mut handshake = Handshake::default();
    handshake.protocol_version += 1;
    assert!(handshake.validate().is_err());
    let mut handshake = Handshake::default();
    handshake.limits.pending_operations = 0;
    assert!(handshake.validate().is_err());
    let mut handshake = Handshake::default();
    handshake.limits.control_frame_bytes = 4096;
    assert_eq!(handshake.validate().unwrap().control_frame_bytes, 4096);
}

#[test]
fn protocol_rejects_unknown_fields_and_limits_nested_value_work() {
    let unknown = json!({ "kind": "cancel", "requestId": 1, "ignored": true });
    assert!(serde_json::from_value::<ClientMessage>(unknown).is_err());
    let limits = ResourceLimits {
        value_depth: 2,
        value_nodes: 4,
        ..ResourceLimits::default()
    };
    assert!(limits.validate_value(&json!([[0]])).is_err());
    assert!(limits.validate_value(&json!([0, 1, 2, 3])).is_err());
    assert!(limits.validate_value(&json!([0, 1, 2])).is_ok());
}

#[test]
fn handshake_envelopes_round_trip_and_reject_nested_unknown_options() {
    let message = ClientMessage::Handshake {
        handshake: Handshake::default(),
    };
    let serialized = serde_json::to_value(message).unwrap();
    assert!(serde_json::from_value::<ClientMessage>(serialized.clone()).is_ok());
    let mut invalid = serialized;
    invalid["handshake"]["ignored"] = json!(true);
    assert!(serde_json::from_value::<ClientMessage>(invalid).is_err());
    let message = DriverMessage::Handshake {
        handshake: Handshake::default(),
        resident_runtime_sha256: "test-runtime".to_owned(),
        capabilities: vec![],
        browser_identity: None,
        browser_encodings: vec!["json".to_owned()],
    };
    let serialized = serde_json::to_value(message).unwrap();
    assert!(serde_json::from_value::<DriverMessage>(serialized).is_ok());
}

#[tokio::test]
async fn oversized_outgoing_frame_does_not_write_or_poison_the_stream() {
    let (producer, consumer) = duplex(64);
    let mut writer = FrameWriter::new(producer, 16);
    assert!(matches!(
        writer.write(&"a".repeat(1000)).await,
        Err(FrameError::TooLarge { .. })
    ));
    writer.write(&json!(42)).await.unwrap();
    let mut reader = FrameReader::new(consumer, 16);
    assert_eq!(reader.read::<Value>().await.unwrap(), Some(json!(42)));
}

#[tokio::test]
async fn prepared_frames_still_obey_the_destination_limit_without_writing_a_prefix() {
    let (producer, consumer) = duplex(64);
    let mut writer = FrameWriter::new(producer, 16);
    let frame = EncodedFrame::encode(&"a".repeat(100), 1024).unwrap();
    assert!(matches!(
        writer.write_frame(&frame).await,
        Err(FrameError::TooLarge { .. })
    ));
    writer
        .write_frame(&EncodedFrame::encode(&42, 16).unwrap())
        .await
        .unwrap();
    let mut reader = FrameReader::new(consumer, 16);
    assert_eq!(reader.read::<Value>().await.unwrap(), Some(json!(42)));
}

#[tokio::test]
async fn borrowed_result_encoding_matches_the_owned_wire_contract() {
    let value =
        json!({ "unicode": "\u{0}é😃", "units": [0, 55296, 65535], "nested": [null, true, 42] });
    let frame =
        DriverMessage::encode_result(41, &value, InputDelivery::Acknowledged, 1024).unwrap();
    let (producer, consumer) = duplex(1024);
    FrameWriter::new(producer, 1024)
        .write_frame(&frame)
        .await
        .unwrap();
    let actual = FrameReader::new(consumer, 1024)
        .read::<Value>()
        .await
        .unwrap()
        .unwrap();
    let expected = serde_json::to_value(DriverMessage::Result {
        request_id: 41,
        value,
        input_delivery: InputDelivery::Acknowledged,
    })
    .unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn utf16_diagnostics_and_structured_diagnostics_share_the_value_budget() {
    use flashwright_protocol::{ErrorCode, ErrorRecord};
    let limits = ResourceLimits {
        value_nodes: 8,
        value_depth: 2,
        ..ResourceLimits::default()
    };
    let mut error = ErrorRecord::new(ErrorCode::Evaluation, "page.evaluate", "failed");
    error.message_utf16 = Some(vec![55296; 5].into_boxed_slice());
    error.diagnostics = Some(Box::new(json!({"field": 1})));
    assert!(limits.validate_error(&error).is_ok());
    error.message_utf16 = Some(vec![55296; 6].into_boxed_slice());
    assert_eq!(
        limits.validate_error(&error).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    error.message_utf16 = None;
    error.diagnostics = Some(Box::new(json!([[1]])));
    assert_eq!(
        limits.validate_error(&error).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
}

#[tokio::test]
async fn raw_client_chunks_and_controls_share_fragmented_framing() {
    use flashwright_protocol::ClientFrame;
    let (producer, consumer) = duplex(7);
    let writer = tokio::spawn(async move {
        let mut writer = FrameWriter::new(producer, 1024);
        writer.write(&json!({"kind":"command","requestId":1,"method":"upload","parameters":{},"timeoutMilliseconds":null,"inputByteLength":4})).await.unwrap();
        writer
            .write_frame(&EncodedFrame::attachment_chunk(1, 0, &[0, 255, 128, 13], 1024).unwrap())
            .await
            .unwrap();
        writer
            .write(&json!({"kind":"cancel","requestId":1}))
            .await
            .unwrap();
        writer
            .write(&json!({"kind":"inputEnd","requestId":1,"aborted":true}))
            .await
            .unwrap();
    });
    let mut reader = FrameReader::new(consumer, 1024);
    assert!(matches!(
        reader.read_client_frame().await.unwrap(),
        Some(ClientFrame::Message(ClientMessage::Command {
            input_byte_length: Some(4),
            ..
        }))
    ));
    match reader.read_client_frame().await.unwrap().unwrap() {
        ClientFrame::Attachment {
            request_id,
            offset,
            bytes,
        } => {
            assert_eq!((request_id, offset), (1, 0));
            assert_eq!(bytes, [0, 255, 128, 13]);
        }
        other => panic!("unexpected frame: {other:?}"),
    }
    assert!(matches!(
        reader.read_client_frame().await.unwrap(),
        Some(ClientFrame::Message(ClientMessage::Cancel {
            request_id: 1
        }))
    ));
    assert!(matches!(
        reader.read_client_frame().await.unwrap(),
        Some(ClientFrame::Message(ClientMessage::InputEnd {
            request_id: 1,
            aborted: true
        }))
    ));
    assert!(reader.read_client_frame().await.unwrap().is_none());
    writer.await.unwrap();
}

#[tokio::test]
async fn invalid_client_chunk_identity_or_size_poison_the_stream() {
    for (identifier, payload_length) in [
        (0_u64, 1_usize),
        (9_007_199_254_740_992, 1),
        (1, 0),
        (1, 65537),
    ] {
        let mut body = vec![0; 13 + payload_length];
        body[1..9].copy_from_slice(&identifier.to_le_bytes());
        let mut framed = (body.len() as u32).to_le_bytes().to_vec();
        framed.extend(body);
        let mut reader = FrameReader::new(framed.as_slice(), 128 * 1024);
        assert!(matches!(
            reader.read_client_frame().await,
            Err(FrameError::InvalidAttachment)
        ));
        assert!(matches!(
            reader.read_client_frame().await,
            Err(FrameError::Invalidated)
        ));
    }
}

#[test]
fn original_trace_call_metadata_is_optional_bounded_and_strict() {
    let mut value = json!({"kind":"command","requestId":1,"method":"locator.run","parameters":{},"timeoutMilliseconds":1000});
    let command: ClientMessage = serde_json::from_value(value.clone()).unwrap();
    assert!(
        serde_json::to_value(command)
            .unwrap()
            .get("traceCall")
            .is_none()
    );
    value["traceCall"] = json!({"context":"context","generation":"original-chunk"});
    let command: ClientMessage = serde_json::from_value(value.clone()).unwrap();
    let ClientMessage::Command {
        trace_call: Some(trace_call),
        ..
    } = command
    else {
        panic!("missing original call metadata");
    };
    trace_call.validate("locator.run").unwrap();
    assert_eq!(trace_call.generation, "original-chunk");
    value["traceCall"]["inferred"] = json!(true);
    assert!(serde_json::from_value::<ClientMessage>(value).is_err());
    for context in [String::new(), "x".repeat(65), "é".repeat(33)] {
        assert!(
            flashwright_protocol::TraceCall {
                context,
                generation: "original".into()
            }
            .validate("locator.run")
            .is_err()
        );
    }
    assert!(
        flashwright_protocol::TraceCall {
            context: "context".into(),
            generation: String::new()
        }
        .validate("locator.run")
        .is_err()
    );
}
