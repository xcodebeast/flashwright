use flashwright_protocol::{
    ClientMessage, DriverMessage, FrameError, FrameReader, FrameWriter, Handshake, ResourceLimits,
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
