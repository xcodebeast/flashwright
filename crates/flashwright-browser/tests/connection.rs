use flashwright_browser::Connection;
use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex, split};
use tokio::time::{Duration, timeout};

#[tokio::test]
async fn raw_value_replies_preserve_surrogates_without_weakening_limits_or_identity() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut raw = connection
        .start_raw_command("Runtime.getProperties", json!({}), Some("session"))
        .unwrap();
    let command = read_command(&mut reader).await;
    assert_eq!(command["id"], 1);
    let result =
        r#"{"result":[{"name":"\ud800","value":{"type":"string","value":"\udfff\u0000"}}]}"#;
    writer
        .write_all(format!("{{\"id\":1,\"result\":{result}}}\0").as_bytes())
        .await
        .unwrap();
    assert_eq!(raw.response().await.unwrap().get(), result);
    let cancelled = connection
        .start_raw_command("cancelled", json!({}), None)
        .unwrap();
    assert_eq!(read_command(&mut reader).await["id"], 2);
    drop(cancelled);
    writer
        .write_all(b"{\"id\":2,\"result\":{\"stale\":\"\\ud800\"}}\0")
        .await
        .unwrap();
    let mut oversized = connection
        .start_raw_command("tooLarge", json!({}), None)
        .unwrap();
    assert_eq!(read_command(&mut reader).await["id"], 3);
    writer
        .write_all(
            format!(
                "{{\"id\":3,\"result\":{{\"description\":\"{}\"}}}}\0",
                "x".repeat(8 * 1024 * 1024)
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    assert_eq!(
        oversized.response().await.unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    let mut successor = connection.start_command("next", json!({}), None).unwrap();
    assert_eq!(read_command(&mut reader).await["id"], 4);
    writer
        .write_all(b"{\"id\":4,\"result\":{\"value\":42}}\0")
        .await
        .unwrap();
    assert_eq!(successor.response().await.unwrap()["value"], 42);
}

#[tokio::test]
async fn interleaved_events_and_out_of_order_replies_preserve_request_identity() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let mut events = connection.subscribe();
    let first_connection = connection.clone();
    let first = tokio::spawn(async move { first_connection.call("first", json!({}), None).await });
    let second_connection = connection.clone();
    let second = tokio::spawn(async move {
        second_connection
            .call("second", json!({}), Some("session"))
            .await
    });
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut commands = Vec::new();
    for _ in 0..2 {
        let mut bytes = Vec::new();
        reader.read_until(0, &mut bytes).await.unwrap();
        commands.push(serde_json::from_slice::<Value>(&bytes[..bytes.len() - 1]).unwrap());
    }
    writer
        .write_all(b"{\"method\":\"Runtime.consoleAPICalled\",\"params\":{\"text\":\"\\ud800\"}}\0")
        .await
        .unwrap();
    for command in commands.iter().rev() {
        let reply = json!({ "id": command["id"], "result": { "method": command["method"] } });
        let mut bytes = serde_json::to_vec(&reply).unwrap();
        bytes.push(0);
        writer.write_all(&bytes).await.unwrap();
    }
    assert_eq!(first.await.unwrap().unwrap()["method"], "first");
    assert_eq!(second.await.unwrap().unwrap()["method"], "second");
    let event = events.recv().await.unwrap();
    timeout(Duration::from_secs(1), connection.synchronize_events())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.method, "Runtime.consoleAPICalled");
    assert_eq!(event.parameters.unwrap().get(), r#"{"text":"\ud800"}"#);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_event_burst_is_lossless_and_applied_before_the_following_reply() {
    let (host, peer) = duplex(1024 * 1024);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let observed = Arc::new(AtomicU64::new(0));
    let applied = observed.clone();
    connection
        .observe_events(move |event| {
            if event.method == "Flashwright.disconnected" {
                return Ok(());
            }
            let expected = applied.load(Ordering::Acquire) + 1;
            assert_eq!(event.sequence, expected);
            let parameters: Value = serde_json::from_str(event.parameters.unwrap().get()).unwrap();
            assert_eq!(parameters["index"], expected);
            if expected.is_multiple_of(128) {
                std::thread::sleep(Duration::from_millis(1));
            }
            applied.store(expected, Ordering::Release);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        connection.observe_events(|_| Ok(())).unwrap_err().code,
        ErrorCode::Protocol
    );
    let mut command = connection
        .start_command("evaluate", json!({}), None)
        .unwrap();
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let identifier = read_command(&mut reader).await["id"].as_u64().unwrap();
    let mut burst = Vec::new();
    for index in 1..=2048 {
        burst.extend_from_slice(
            format!("{{\"method\":\"console\",\"params\":{{\"index\":{index}}}}}\0").as_bytes(),
        );
    }
    burst.extend_from_slice(
        format!("{{\"id\":{identifier},\"result\":{{\"value\":42}}}}\0").as_bytes(),
    );
    writer.write_all(&burst).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(5), command.response())
            .await
            .unwrap()
            .unwrap()["value"],
        42
    );
    assert_eq!(observed.load(Ordering::Acquire), 2048);
    connection.synchronize_events().await.unwrap();
}

#[tokio::test]
async fn owned_event_failure_invalidates_pending_work_with_its_original_error() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let events = observed.clone();
    // Weak ownership avoids a callback/connection cycle while exercising failure
    // inspection and cleanup command registration from a terminal notification.
    let inspection = Arc::new(connection.clone());
    let weak = Arc::downgrade(&inspection);
    connection
        .observe_events(move |event| {
            events.lock().unwrap().push(event.method.clone());
            if event.method == "Flashwright.disconnected" {
                let connection = weak.upgrade().unwrap();
                assert_eq!(
                    connection.failure().unwrap().message.as_ref(),
                    "owned event exhausted its bound"
                );
                assert_eq!(
                    connection
                        .start_command("cleanup", json!({}), None)
                        .err()
                        .unwrap()
                        .code,
                    ErrorCode::ResourceLimit
                );
                connection.close();
                return Ok(());
            }
            Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "event.owner",
                "owned event exhausted its bound",
            ))
        })
        .unwrap();
    let mut pending = connection
        .start_command("evaluate", json!({}), None)
        .unwrap();
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    read_command(&mut reader).await;
    writer.write_all(b"{\"method\":\"overflow\",\"params\":{}}\0{\"id\":1,\"result\":{}}\0{\"method\":\"tooLate\"}\0").await.unwrap();
    let error = timeout(Duration::from_secs(1), pending.response())
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    assert_eq!(error.method.as_ref(), "event.owner");
    assert_eq!(
        connection.synchronize_events().await.unwrap_err().message,
        error.message
    );
    assert_eq!(
        *observed.lock().unwrap(),
        ["overflow", "Flashwright.disconnected"]
    );
}

#[tokio::test]
async fn eof_settles_all_pending_requests_and_future_calls() {
    let (host, peer) = duplex(1024);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    drop(peer);
    let error = timeout(
        Duration::from_secs(1),
        connection.call("blocked", json!({}), None),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(matches!(
        error.code,
        ErrorCode::Protocol | ErrorCode::BrowserDisconnected
    ));
    assert!(connection.call("afterEOF", json!({}), None).await.is_err());
}

#[tokio::test]
async fn late_reply_after_cancellation_cannot_settle_another_request() {
    let (host, peer) = duplex(1024);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let pending_connection = connection.clone();
    let pending =
        tokio::spawn(async move { pending_connection.call("cancelled", json!({}), None).await });
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    reader.read_until(0, &mut bytes).await.unwrap();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    writer
        .write_all(b"{\"id\":1,\"result\":{\"stale\":true}}\0")
        .await
        .unwrap();
    let next_connection = connection.clone();
    let next = tokio::spawn(async move { next_connection.call("next", json!({}), None).await });
    bytes.clear();
    reader.read_until(0, &mut bytes).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes[..bytes.len() - 1]).unwrap()["id"],
        2
    );
    writer
        .write_all(b"{\"id\":2,\"result\":{\"fresh\":true}}\0")
        .await
        .unwrap();
    assert_eq!(next.await.unwrap().unwrap(), json!({ "fresh": true }));
}

#[tokio::test]
async fn sequence_dispatches_all_commands_before_any_reply_and_matches_reversed_replies() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let mut commands = connection
        .start_commands(
            "input",
            (0..201).map(|index| json!({ "index": index })).collect(),
            Some("page"),
        )
        .unwrap();
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut received = Vec::new();
    for index in 0..201 {
        let command = read_command(&mut reader).await;
        assert_eq!(command["params"]["index"], index);
        assert_eq!(command["sessionId"], "page");
        received.push(command);
    }
    for command in received.into_iter().rev() {
        let mut bytes =
            serde_json::to_vec(&json!({ "id": command["id"], "result": command["params"] }))
                .unwrap();
        bytes.push(0);
        writer.write_all(&bytes).await.unwrap();
    }
    for (index, command) in commands.iter_mut().enumerate() {
        let result = timeout(Duration::from_secs(1), command.response())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["index"], index);
    }
}

#[tokio::test]
async fn cancellation_withdraws_unsent_suffix_after_partial_first_write() {
    let (host, peer) = duplex(1);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let commands = connection
        .start_commands("input", vec![json!(0), json!(1), json!(2)], None)
        .unwrap();
    // One byte fits, so the first command starts but cannot finish until the peer reads.
    tokio::task::yield_now().await;
    assert!(!commands[0].prevent_dispatch());
    assert!(commands[1].prevent_dispatch());
    assert!(commands[2].prevent_dispatch());
    drop(commands);
    let _following = connection
        .start_command("following", json!({}), None)
        .unwrap();
    let mut reader = BufReader::new(peer);
    assert_eq!(read_command(&mut reader).await["params"], 0);
    assert_eq!(read_command(&mut reader).await["method"], "following");
}

#[tokio::test]
async fn rejected_sequences_have_no_wire_effects_and_release_pending_capacity() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let occupied = connection
        .start_commands("occupied", vec![Value::Null; 1024], None)
        .unwrap();
    assert!(
        matches!(connection.start_commands("overCapacity", vec![Value::Null; 2], None), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    drop(occupied);
    let oversized = vec![json!("x".repeat(4 * 1024 * 1024)); 2];
    assert!(
        matches!(connection.start_commands("oversized", oversized, None), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    let _following = connection
        .start_command("following", Value::Null, None)
        .unwrap();
    let mut reader = BufReader::new(peer);
    assert_eq!(read_command(&mut reader).await["method"], "following");
}

#[tokio::test]
async fn full_queue_rejects_entire_sequence_and_rolls_back_registrations() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let occupied: Vec<_> = (0..128)
        .map(|_| {
            connection
                .start_command("occupied", Value::Null, None)
                .unwrap()
        })
        .collect();
    assert!(
        matches!(connection.start_commands("rejected", vec![Value::Null; 3], None), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    drop(occupied);
    tokio::task::yield_now().await;
    let _following = connection
        .start_commands("following", vec![Value::Null; 1024], None)
        .unwrap();
    let mut reader = BufReader::new(peer);
    assert_eq!(read_command(&mut reader).await["method"], "following");
}

#[tokio::test]
async fn eof_settles_entire_sequence_and_received_replies_can_be_recovered_without_waiting() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let mut commands = connection
        .start_commands("input", vec![Value::Null; 3], None)
        .unwrap();
    let mut peer = BufReader::new(peer);
    let first = read_command(&mut peer).await;
    let mut bytes =
        serde_json::to_vec(&json!({ "id": first["id"], "result": { "acknowledged": true } }))
            .unwrap();
    bytes.push(0);
    peer.get_mut().write_all(&bytes).await.unwrap();
    drop(peer);
    timeout(Duration::from_secs(1), async {
        loop {
            if let Some(reply) = commands[0].try_response() {
                assert_eq!(reply.unwrap()["acknowledged"], true);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!commands[0].prevent_dispatch());
    for command in &mut commands[1..] {
        assert!(
            timeout(Duration::from_secs(1), command.response())
                .await
                .unwrap()
                .is_err()
        );
    }
}

#[tokio::test]
async fn large_body_reply_is_admitted_while_ordinary_reply_rejects_without_disconnect() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let mut ordinary = connection
        .start_command("ordinary", json!({}), None)
        .unwrap();
    let binary_connection = connection.clone();
    let binary = tokio::spawn(async move {
        binary_connection
            .response_body("request", "page", 10 * 1024 * 1024)
            .await
    });
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let ordinary_command = read_command(&mut reader).await;
    let binary_command = read_command(&mut reader).await;
    assert_eq!(ordinary_command["method"], "ordinary");
    assert_eq!(binary_command["method"], "Network.getResponseBody");
    let body = "x".repeat(9 * 1024 * 1024);
    let ordinary_reply = format!(r#"{{"id":{},"result":"{body}"}}"#, ordinary_command["id"]);
    writer.write_all(ordinary_reply.as_bytes()).await.unwrap();
    writer.write_all(&[0]).await.unwrap();
    assert_eq!(
        ordinary.response().await.unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    // The identity can follow the large body; object member order is not a framing contract.
    let binary_reply = format!(
        r#"{{"result":{{"body":"{body}","base64Encoded":false}},"id":{}}}"#,
        binary_command["id"]
    );
    writer.write_all(binary_reply.as_bytes()).await.unwrap();
    writer.write_all(&[0]).await.unwrap();
    let result = binary.await.unwrap().unwrap();
    assert_eq!(result.decoded_length, body.len());
    assert_eq!(result.bytes, body.as_bytes());
}

#[tokio::test]
async fn cancelled_large_reply_finishes_framing_without_poisoning_its_successor() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let binary_connection = connection.clone();
    let binary = tokio::spawn(async move {
        binary_connection
            .response_body("request", "page", 1024)
            .await
    });
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let binary_command = read_command(&mut reader).await;
    writer
        .write_all(format!(r#"{{"id":{},"result":{{"body":""#, binary_command["id"]).as_bytes())
        .await
        .unwrap();
    writer.write_all(&vec![b'x'; 65536]).await.unwrap();
    binary.abort();
    assert!(binary.await.unwrap_err().is_cancelled());
    for _ in 0..144 {
        writer.write_all(&vec![b'x'; 65536]).await.unwrap();
    }
    writer
        .write_all(b"\",\"base64Encoded\":false}}\0")
        .await
        .unwrap();
    let mut successor = connection
        .start_command("successor", json!({}), None)
        .unwrap();
    let command = read_command(&mut reader).await;
    writer
        .write_all(format!("{{\"id\":{},\"result\":42}}\0", command["id"]).as_bytes())
        .await
        .unwrap();
    assert_eq!(successor.response().await.unwrap(), 42);
}

#[tokio::test]
async fn oversized_event_explicitly_invalidates_pending_and_future_calls() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let mut pending = connection
        .start_command("pending", json!({}), None)
        .unwrap();
    let mut peer = BufReader::new(peer);
    read_command(&mut peer).await;
    let event = format!(
        "{{\"method\":\"large\",\"params\":\"{}\"}}\0",
        "x".repeat(9 * 1024 * 1024)
    );
    peer.get_mut().write_all(event.as_bytes()).await.unwrap();
    let error = pending.response().await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    assert!(error.message.contains("event"));
    assert_eq!(
        connection
            .call("after", json!({}), None)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
}

async fn read_command<Reader: tokio::io::AsyncBufRead + Unpin>(reader: &mut Reader) -> Value {
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(1), reader.read_until(0, &mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bytes.last(), Some(&0));
    serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap()
}
