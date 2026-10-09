use flashwright_browser::Connection;
use flashwright_browser::snapshot_reply::{
    MAXIMUM_DATA_BYTES, MAXIMUM_WRAPPER_BYTES, SnapshotReply, SnapshotReplyAdmission,
};
use flashwright_protocol::ErrorCode;
use serde_json::{Value, json};
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, duplex, split,
};
use tokio::time::{Duration, timeout};

fn admission() -> SnapshotReplyAdmission {
    SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES, MAXIMUM_WRAPPER_BYTES).unwrap()
}

fn parameters() -> Value {
    json!({"objectId":"original-owner", "objectGroup":"attempt-owned-by-caller", "functionDeclaration":"function() { return this.capture(); }", "returnByValue":true})
}

fn captured(text: &str) -> String {
    let data = format!(
        r#"{{"html":["HTML",{{}},"{text}"],"url":"about:blank","doctype":"html","viewport":{{"width":1280,"height":720}},"wallTime":1,"collectionTime":0,"resourceOverrides":[]}}"#
    );
    let bytes = data.len();
    format!(
        r#"{{"result":{{"type":"object","value":{{"token":"original-capture","snapshotNumber":1,"data":{data},"counters":{{"bytes":{bytes},"overrideBytes":0,"cssReadBytes":0,"nodes":1,"depth":1,"cssDepth":0,"attributes":0,"sheets":0,"rules":0,"overrideCount":0}},"committedCache":{{"bytes":0,"nodes":0,"attributes":0,"sheets":0}},"tentativeCache":{{"bytes":0,"nodes":0,"attributes":0,"sheets":0}}}}}}}}"#
    )
}

async fn command<Reader: AsyncRead + Unpin>(reader: &mut BufReader<Reader>) -> Value {
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(2), reader.read_until(0, &mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bytes.pop(), Some(0));
    serde_json::from_slice(&bytes).unwrap()
}

async fn reply<Writer: AsyncWrite + Unpin>(writer: &mut Writer, identifier: &Value, result: &str) {
    writer
        .write_all(
            format!(r#"{{"id":{identifier},"sessionId":"page","result":{result}}}"#).as_bytes(),
        )
        .await
        .unwrap();
    writer.write_all(&[0]).await.unwrap();
}

#[tokio::test]
async fn snapshot_adapter_preserves_raw_data_and_counts_the_complete_wrapper() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    let observed = command(&mut reader).await;
    assert_eq!(observed["method"], "Runtime.callFunctionOn");
    assert_eq!(observed["sessionId"], "page");
    assert_eq!(observed["params"], parameters());
    reply(&mut writer, &observed["id"], &captured(r#"\ud800A\udfff"#)).await;
    let SnapshotReply::Captured(snapshot) = capture.response().await.unwrap() else {
        panic!("expected DATA")
    };
    assert!(
        std::str::from_utf8(&snapshot.data.bytes)
            .unwrap()
            .contains(r#"\ud800A\udfff"#)
    );

    let mut excessive_wrapper = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    let observed = command(&mut reader).await;
    let message = format!(
        r#"{{"id":{},"extraEnvelopeField":"{}","result":{}}}"#,
        observed["id"],
        "x".repeat(MAXIMUM_WRAPPER_BYTES),
        captured("small")
    );
    writer.write_all(message.as_bytes()).await.unwrap();
    writer.write_all(&[0]).await.unwrap();
    assert_eq!(
        excessive_wrapper.response().await.unwrap_err().code,
        ErrorCode::ResourceLimit
    );

    let mut successor = connection
        .start_command("ordinary-successor", json!({}), None)
        .unwrap();
    let observed = command(&mut reader).await;
    reply(&mut writer, &observed["id"], r#"{"healthy":true}"#).await;
    assert_eq!(successor.response().await.unwrap()["healthy"], true);
}

#[tokio::test]
async fn snapshot_errors_are_bounded_without_changing_ordinary_cdp_errors() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    let observed = command(&mut reader).await;
    reply(&mut writer, &observed["id"], r#"{"result":{"type":"object","subtype":"error","objectId":"remote-error"},"exceptionDetails":{"text":"Uncaught","exception":{"objectId":"remote-error","description":"SnapshotUnsupported: fixture"}}}"#).await;
    let SnapshotReply::Exception(details) = capture.response().await.unwrap() else {
        panic!("expected exception")
    };
    assert!(details.get().contains("remote-error"));

    let mut capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    let observed = command(&mut reader).await;
    let error = format!(
        r#"{{"code":-32000,"message":"{}"}}"#,
        "x".repeat(MAXIMUM_WRAPPER_BYTES)
    );
    writer
        .write_all(format!(r#"{{"id":{},"error":{error}}}"#, observed["id"]).as_bytes())
        .await
        .unwrap();
    writer.write_all(&[0]).await.unwrap();
    assert_eq!(
        capture.response().await.unwrap_err().code,
        ErrorCode::ResourceLimit
    );

    let mut ordinary = connection
        .start_command("ordinary-error", json!({}), None)
        .unwrap();
    let observed = command(&mut reader).await;
    writer
        .write_all(format!(r#"{{"id":{},"error":{error}}}"#, observed["id"]).as_bytes())
        .await
        .unwrap();
    writer.write_all(&[0]).await.unwrap();
    let error = ordinary.response().await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Protocol);
    assert_eq!(error.browser_error_code, Some(-32000));
}

#[tokio::test]
async fn malformed_and_oversized_snapshot_results_do_not_poison_successors() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    for (result, expected) in [
        (
            r#"{"result":{"type":"string","value":"wrong shape"}}"#.to_owned(),
            ErrorCode::Protocol,
        ),
        (
            captured(&"x".repeat(MAXIMUM_DATA_BYTES)),
            ErrorCode::ResourceLimit,
        ),
    ] {
        let mut capture = connection
            .start_snapshot_capture(parameters(), "page", admission())
            .unwrap();
        let observed = command(&mut reader).await;
        reply(&mut writer, &observed["id"], &result).await;
        assert_eq!(capture.response().await.unwrap_err().code, expected);
    }
    let mut capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    let observed = command(&mut reader).await;
    reply(&mut writer, &observed["id"], &captured("valid successor")).await;
    assert!(matches!(
        capture.response().await.unwrap(),
        SnapshotReply::Captured(_)
    ));
    for smaller in [
        SnapshotReplyAdmission::new(1, MAXIMUM_WRAPPER_BYTES).unwrap(),
        SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES, 1).unwrap(),
    ] {
        let mut capture = connection
            .start_snapshot_capture(parameters(), "page", smaller)
            .unwrap();
        let observed = command(&mut reader).await;
        reply(&mut writer, &observed["id"], &captured("lower grant")).await;
        assert_eq!(
            capture.response().await.unwrap_err().code,
            ErrorCode::ResourceLimit
        );
    }
}

#[tokio::test]
async fn queued_snapshot_withdrawal_has_no_browser_wire_effect() {
    let (host, peer) = duplex(1);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (mut reader, mut writer) = split(peer);
    let mut blocker = connection
        .start_command("blocked-write", json!({"padding":"x".repeat(256)}), None)
        .unwrap();
    let first_byte = reader.read_u8().await.unwrap();
    assert!(!blocker.prevent_dispatch());
    let mut capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    assert!(capture.prevent_dispatch());
    assert!(capture.response().await.is_err());
    let mut successor = connection
        .start_command("after-withdrawal", json!({}), None)
        .unwrap();
    let mut reader = BufReader::new(reader);
    let mut bytes = vec![first_byte];
    reader.read_until(0, &mut bytes).await.unwrap();
    bytes.pop();
    let observed: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(observed["method"], "blocked-write");
    reply(&mut writer, &observed["id"], "{}").await;
    blocker.response().await.unwrap();
    let observed = command(&mut reader).await;
    assert_eq!(observed["method"], "after-withdrawal");
    reply(&mut writer, &observed["id"], "{}").await;
    successor.response().await.unwrap();
}

#[tokio::test]
async fn timed_out_wait_keeps_dispatched_reply_recoverable_for_cleanup() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let mut capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    let observed = command(&mut reader).await;
    assert!(!capture.prevent_dispatch());
    assert!(
        timeout(Duration::from_millis(1), capture.response())
            .await
            .is_err()
    );
    assert!(capture.try_response().is_none());
    reply(&mut writer, &observed["id"], &captured("late owned reply")).await;
    let mut barrier = connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    let observed = command(&mut reader).await;
    reply(&mut writer, &observed["id"], "{}").await;
    barrier.response().await.unwrap();
    assert!(matches!(
        capture.try_response().unwrap().unwrap(),
        SnapshotReply::Captured(_)
    ));
}

#[tokio::test]
async fn dropped_dispatched_reply_finishes_framing_before_its_successor() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let (reader, mut writer) = split(peer);
    let mut reader = BufReader::new(reader);
    let capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    let observed = command(&mut reader).await;
    let message = format!(
        r#"{{"id":{},"result":{}}}"#,
        observed["id"],
        captured(&"x".repeat(512 * 1024))
    );
    writer.write_all(&message.as_bytes()[..100]).await.unwrap();
    drop(capture);
    writer.write_all(&message.as_bytes()[100..]).await.unwrap();
    writer.write_all(&[0]).await.unwrap();
    let mut successor = connection
        .start_command("after-late-frame", json!({}), None)
        .unwrap();
    let observed = command(&mut reader).await;
    reply(&mut writer, &observed["id"], r#"{"healthy":true}"#).await;
    assert_eq!(successor.response().await.unwrap()["healthy"], true);
}

#[tokio::test]
async fn disconnected_transport_settles_snapshot_waiters_and_rejects_new_commands() {
    let (host, peer) = duplex(65536);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let mut reader = BufReader::new(peer);
    let mut capture = connection
        .start_snapshot_capture(parameters(), "page", admission())
        .unwrap();
    command(&mut reader).await;
    drop(reader);
    assert!(
        timeout(Duration::from_secs(2), capture.response())
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        connection
            .start_snapshot_capture(parameters(), "page", admission())
            .is_err()
    );
}
