use flashwright_browser::Connection;
use flashwright_protocol::{ErrorCode, attachment::MAXIMUM_ATTACHMENT_BYTES};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, duplex, split};
use tokio::time::{Duration, timeout};

async fn read_command<Reader: AsyncRead + Unpin>(reader: &mut BufReader<Reader>) -> Value {
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(2), reader.read_until(0, &mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bytes.pop(), Some(0));
    serde_json::from_slice(&bytes).unwrap()
}

async fn reply<Writer: AsyncWrite + Unpin>(writer: &mut Writer, identifier: &Value, result: Value) {
    let mut bytes = serde_json::to_vec(&json!({"id":identifier,"result":result})).unwrap();
    bytes.push(0);
    writer.write_all(&bytes).await.unwrap();
}

#[tokio::test]
async fn withdrawing_a_queued_body_suppresses_browser_dispatch() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let body = connection
        .start_response_body("original", "session", 1024)
        .unwrap();
    assert!(body.prevent_dispatch());
    let mut successor = connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    let command = read_command(&mut reader).await;
    assert_eq!(command["method"], "barrier");
    reply(&mut writer, &command["id"], json!({"healthy":true})).await;
    assert_eq!(successor.response().await.unwrap()["healthy"], true);
}

#[tokio::test]
async fn cancelled_wait_preserves_the_original_command_and_its_late_typed_reply() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut body = connection
        .start_response_body("original", "session", 1024)
        .unwrap();
    let original = read_command(&mut reader).await;
    assert_eq!(original["method"], "Network.getResponseBody");
    assert_eq!(original["params"], json!({"requestId":"original"}));
    assert_eq!(original["sessionId"], "session");
    assert!(
        timeout(Duration::from_millis(10), body.response())
            .await
            .is_err()
    );
    assert!(!body.prevent_dispatch());
    assert!(body.try_response().is_none());
    let mut successor = connection
        .start_response_body("successor", "session", 1024)
        .unwrap();
    let next = read_command(&mut reader).await;
    reply(
        &mut writer,
        &next["id"],
        json!({"body":"next","base64Encoded":false}),
    )
    .await;
    assert_eq!(successor.response().await.unwrap().bytes, b"next");
    reply(
        &mut writer,
        &original["id"],
        json!({"body":"AP+A","base64Encoded":true}),
    )
    .await;
    let payload = body.response().await.unwrap();
    assert_eq!(payload.bytes, b"AP+A");
    assert_eq!(payload.decoded_length, 3);
}

#[tokio::test]
async fn rejected_body_payloads_settle_only_their_command() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    for (payload, expected) in [
        (
            json!({"body":"AP+A","base64Encoded":true}),
            ErrorCode::ResourceLimit,
        ),
        (
            json!({"body":"invalid!","base64Encoded":true}),
            ErrorCode::Protocol,
        ),
        (
            json!({"unrelated":"missing typed body"}),
            ErrorCode::Protocol,
        ),
    ] {
        let mut body = connection
            .start_response_body("original", "session", 2)
            .unwrap();
        let original = read_command(&mut reader).await;
        reply(&mut writer, &original["id"], payload).await;
        assert_eq!(body.response().await.unwrap_err().code, expected);
    }
    let mut successor = connection
        .start_response_body("next", "session", 2)
        .unwrap();
    let next = read_command(&mut reader).await;
    reply(
        &mut writer,
        &next["id"],
        json!({"body":"AP8=","base64Encoded":true}),
    )
    .await;
    assert_eq!(successor.response().await.unwrap().decoded_length, 2);
}

#[tokio::test]
async fn impossible_body_limit_is_rejected_before_command_admission() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    assert!(
        matches!(connection.start_response_body("original", "session", MAXIMUM_ATTACHMENT_BYTES + 1), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    let mut successor = connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    let next = read_command(&mut reader).await;
    assert_eq!(next["method"], "barrier");
    reply(&mut writer, &next["id"], json!({})).await;
    successor.response().await.unwrap();
}

#[tokio::test]
async fn local_disconnect_does_not_claim_an_original_browser_reply() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut body = connection
        .start_response_body("original", "session", 16)
        .unwrap();
    let _ = read_command(&mut reader).await;
    assert!(!body.prevent_dispatch());
    drop(reader);
    drop(writer);
    assert!(body.response().await.is_err());
    assert!(!body.browser_reply_received());
}

#[tokio::test]
async fn browser_error_and_invalid_payload_are_received_replies() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut missing = connection
        .start_response_body("missing", "session", 16)
        .unwrap();
    let command = read_command(&mut reader).await;
    let mut error = serde_json::to_vec(&json!({"id":command["id"],"error":{"code":-32000,"message":"No resource with given identifier found"}})).unwrap();
    error.push(0);
    writer.write_all(&error).await.unwrap();
    assert_eq!(
        missing.response().await.unwrap_err().browser_error_code,
        Some(-32000)
    );
    assert!(missing.browser_reply_received());
    let mut malformed = connection
        .start_response_body("malformed", "session", 16)
        .unwrap();
    let command = read_command(&mut reader).await;
    reply(
        &mut writer,
        &command["id"],
        json!({"body":"AB==","base64Encoded":true}),
    )
    .await;
    assert_eq!(
        malformed.response().await.unwrap_err().code,
        ErrorCode::Protocol
    );
    assert!(malformed.browser_reply_received());
}
