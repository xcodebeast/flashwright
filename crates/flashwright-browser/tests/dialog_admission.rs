//! Browser-free saturation exercises the actual pending registry and outgoing wire.

use flashwright_browser::Connection;
use flashwright_protocol::{ErrorCode, ordinary_operation_limit};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader, duplex, split};

#[tokio::test]
async fn ordinary_saturation_leaves_recovery_capacity_without_raising_the_total() {
    let (host, peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let ordinary_limit = ordinary_operation_limit(1024);
    let ordinary = connection
        .start_commands(
            "Runtime.evaluate",
            vec![json!({}); ordinary_limit],
            Some("original"),
        )
        .unwrap();
    assert!(
        matches!(connection.start_command("Runtime.evaluate", json!({}), None), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    assert!(
        matches!(connection.start_command("Page.handleJavaScriptDialog.extra", json!({}), None), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    let recovery = connection
        .start_commands(
            "Page.handleJavaScriptDialog",
            vec![json!({ "accept": false }); 1024 - ordinary_limit],
            Some("original"),
        )
        .unwrap();
    assert!(
        matches!(connection.start_command("Page.handleJavaScriptDialog", json!({ "accept": true }), Some("successor")), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    let mut reader = BufReader::new(peer);
    for index in 0..1024 {
        let mut bytes = Vec::new();
        reader.read_until(0, &mut bytes).await.unwrap();
        bytes.pop();
        let command: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(command["sessionId"], "original");
        assert_eq!(
            command["method"],
            if index < ordinary_limit {
                "Runtime.evaluate"
            } else {
                "Page.handleJavaScriptDialog"
            }
        );
    }
    drop(ordinary);
    drop(recovery);
    assert!(
        connection
            .start_command("Runtime.evaluate", json!({}), None)
            .is_ok()
    );
}

#[tokio::test]
async fn recovery_registered_first_also_counts_against_ordinary_admission() {
    let (host, _peer) = duplex(4096);
    let (reader, writer) = split(host);
    let connection = Connection::new(reader, writer);
    let recovery = connection
        .start_command(
            "Target.closeTarget",
            json!({ "targetId": "original" }),
            None,
        )
        .unwrap();
    let ordinary = connection
        .start_commands(
            "Runtime.evaluate",
            vec![json!({}); ordinary_operation_limit(1024) - 1],
            None,
        )
        .unwrap();
    assert!(
        matches!(connection.start_command("Runtime.evaluate", json!({}), None), Err(error) if error.code == ErrorCode::ResourceLimit)
    );
    drop(recovery);
    assert!(
        connection
            .start_command("Runtime.evaluate", json!({}), None)
            .is_ok()
    );
    drop(ordinary);
}
