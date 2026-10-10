use super::{complete_input_command, retain_pending_reply, settle_pending_reply};
use crate::page_state::PageState;
use crate::{Operation, Page};
use flashwright_browser::Connection;
use flashwright_browser::connection::Command;
use flashwright_protocol::{ErrorCode, ErrorRecord, InputDelivery, ordinary_operation_limit};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::time::{Duration, timeout};

struct Fixture {
    connection: Connection,
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl Fixture {
    fn new() -> Self {
        let (host, peer) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(host);
        let connection = Connection::new(reader, writer);
        let (reader, writer) = tokio::io::split(peer);
        Self {
            connection,
            reader: BufReader::new(reader),
            writer,
        }
    }

    fn input(&self) -> Command {
        self.connection
            .start_command(
                "Input.insertText",
                json!({ "text": "one complete payload" }),
                Some("original-session"),
            )
            .unwrap()
    }

    async fn next_command(&mut self) -> Value {
        let mut bytes = Vec::new();
        timeout(
            Duration::from_secs(2),
            self.reader.read_until(0, &mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap()
    }

    async fn reply(&mut self, sent: &Value) {
        self.writer
            .write_all(format!("{}\0", json!({ "id": sent["id"], "result": {} })).as_bytes())
            .await
            .unwrap();
    }
}

fn page() -> Page {
    Page {
        context_identifier: "context".into(),
        target_identifier: "target".into(),
        session_identifier: "original-session".into(),
        state: Arc::new(PageState::default()),
    }
}

#[tokio::test]
async fn queued_input_is_withdrawn_without_delivery() {
    let mut fixture = Fixture::new();
    retain_pending_reply(fixture.input());
    let _barrier = fixture
        .connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    assert_eq!(fixture.next_command().await["method"], "barrier");
}

#[tokio::test]
async fn cancelled_input_retains_admission_after_public_rejection_until_original_reply() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    let sent = fixture.next_command().await;
    let (_cancellation, receiver) = tokio::sync::watch::channel(true);
    let operation = Operation::new("keyboard.insertText".into(), None, receiver);
    let dispatch =
        complete_input_command(&page(), command, &operation, "keyboard.insertText", None).await;
    assert_eq!(dispatch.delivery, InputDelivery::Uncertain);
    assert_eq!(dispatch.result.unwrap_err().code, ErrorCode::Cancelled);
    let occupied = fixture
        .connection
        .start_commands(
            "occupied",
            vec![json!({}); ordinary_operation_limit(1024) - 1],
            None,
        )
        .unwrap();
    assert_eq!(
        fixture
            .connection
            .start_command("overflow", json!({}), None)
            .err()
            .unwrap()
            .code,
        ErrorCode::ResourceLimit
    );
    let mut events = fixture.connection.subscribe();
    fixture.reply(&sent).await;
    fixture
        .writer
        .write_all(b"{\"method\":\"test.originalReplyProcessed\",\"params\":{}}\0")
        .await
        .unwrap();
    let processed = timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(processed.method, "test.originalReplyProcessed");
    let _released = fixture
        .connection
        .start_command("released", json!({}), None)
        .unwrap();
    drop(occupied);
}

#[tokio::test]
async fn previous_sequence_failure_withdraws_unsent_tail_and_preserves_original_error() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    let (_cancellation, receiver) = tokio::sync::watch::channel(false);
    let operation = Operation::new("locator.click".into(), None, receiver);
    operation.record_input_delivery(InputDelivery::Uncertain);
    let mut original =
        ErrorRecord::new(ErrorCode::Timeout, "locator.click", "first command expired");
    original.cleanup = Some("originalCleanup".into());
    let dispatch = complete_input_command(
        &page(),
        command,
        &operation,
        "locator.click",
        Some(&original),
    )
    .await;
    assert_eq!(dispatch.delivery, InputDelivery::NotDispatched);
    let error = dispatch.result.unwrap_err();
    assert_eq!(error.code, original.code);
    assert_eq!(error.message, original.message);
    assert_eq!(error.cleanup, original.cleanup);
    assert_eq!(error.input_delivery, InputDelivery::Uncertain);
    let _barrier = fixture
        .connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    assert_eq!(fixture.next_command().await["method"], "barrier");
}

#[tokio::test]
async fn previous_sequence_failure_retains_a_dispatched_tail_reply() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    fixture.next_command().await;
    let (_cancellation, receiver) = tokio::sync::watch::channel(false);
    let operation = Operation::new("locator.click".into(), None, receiver);
    let original = ErrorRecord::new(ErrorCode::Timeout, "locator.click", "first command expired");
    let dispatch = complete_input_command(
        &page(),
        command,
        &operation,
        "locator.click",
        Some(&original),
    )
    .await;
    assert_eq!(dispatch.delivery, InputDelivery::Uncertain);
    let error = dispatch.result.unwrap_err();
    assert_eq!(error.code, original.code);
    assert_eq!(error.message, original.message);
    let _occupied = fixture
        .connection
        .start_commands(
            "occupied",
            vec![json!({}); ordinary_operation_limit(1024) - 1],
            None,
        )
        .unwrap();
    assert_eq!(
        fixture
            .connection
            .start_command("overflow", json!({}), None)
            .err()
            .unwrap()
            .code,
        ErrorCode::ResourceLimit
    );
    fixture.connection.close();
}

#[tokio::test]
async fn cancellation_preserves_public_error_when_native_reply_already_arrived() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    let sent = fixture.next_command().await;
    let mut events = fixture.connection.subscribe();
    fixture.reply(&sent).await;
    fixture
        .writer
        .write_all(b"{\"method\":\"test.originalReplyProcessed\",\"params\":{}}\0")
        .await
        .unwrap();
    timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    let (_cancellation, receiver) = tokio::sync::watch::channel(true);
    let operation = Operation::new("keyboard.insertText".into(), None, receiver);
    let dispatch =
        complete_input_command(&page(), command, &operation, "keyboard.insertText", None).await;
    assert_eq!(dispatch.delivery, InputDelivery::Acknowledged);
    assert_eq!(dispatch.result.unwrap_err().code, ErrorCode::Cancelled);
    let _available = fixture
        .connection
        .start_commands(
            "available",
            vec![json!({}); ordinary_operation_limit(1024)],
            None,
        )
        .unwrap();
}

#[tokio::test]
async fn native_rejection_keeps_browser_error_without_retaining_a_settled_reply() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    let sent = fixture.next_command().await;
    fixture.writer.write_all(format!("{}\0", json!({
        "id": sent["id"], "error": { "code": -32000, "message": "native input rejected" },
    })).as_bytes()).await.unwrap();
    let (_cancellation, receiver) = tokio::sync::watch::channel(false);
    let operation = Operation::new("keyboard.insertText".into(), None, receiver);
    let dispatch =
        complete_input_command(&page(), command, &operation, "keyboard.insertText", None).await;
    let error = dispatch.result.unwrap_err();
    assert_eq!(error.browser_error_code, Some(-32000));
    assert_eq!(error.method.as_ref(), "keyboard.insertText");
    let _available = fixture
        .connection
        .start_commands(
            "available",
            vec![json!({}); ordinary_operation_limit(1024)],
            None,
        )
        .unwrap();
}

#[tokio::test]
async fn local_disconnect_keeps_uncertain_delivery_and_transport_error() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    fixture.next_command().await;
    fixture.writer.shutdown().await.unwrap();
    let (_cancellation, receiver) = tokio::sync::watch::channel(false);
    let operation = Operation::new("keyboard.insertText".into(), None, receiver);
    let dispatch =
        complete_input_command(&page(), command, &operation, "keyboard.insertText", None).await;
    assert_eq!(dispatch.delivery, InputDelivery::Uncertain);
    let error = dispatch.result.unwrap_err();
    assert_eq!(error.code, ErrorCode::BrowserDisconnected);
    assert_eq!(error.browser_error_code, None);
    assert_eq!(error.method.as_ref(), "keyboard.insertText");
}

#[tokio::test]
async fn held_input_keeps_its_native_admission_credit_until_reply() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    let sent = fixture.next_command().await;
    assert_eq!(sent["sessionId"], "original-session");
    assert_eq!(sent["params"]["text"], "one complete payload");
    let settling = tokio::spawn(settle_pending_reply(command));
    let occupied = fixture
        .connection
        .start_commands(
            "occupied",
            vec![json!({}); ordinary_operation_limit(1024) - 1],
            None,
        )
        .unwrap();
    let error = fixture
        .connection
        .start_command("overflow", json!({}), None)
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    fixture.reply(&sent).await;
    timeout(Duration::from_secs(2), settling)
        .await
        .unwrap()
        .unwrap();
    let _released = fixture
        .connection
        .start_command("released", json!({}), None)
        .unwrap();
    drop(occupied);
}

#[tokio::test]
async fn dispatched_input_is_not_replayed_after_late_reply() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    let sent = fixture.next_command().await;
    retain_pending_reply(command);
    fixture.reply(&sent).await;
    let _barrier = fixture
        .connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    assert_eq!(fixture.next_command().await["method"], "barrier");
}

#[tokio::test]
async fn connection_loss_settles_held_input_ownership() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    fixture.next_command().await;
    let settling = tokio::spawn(settle_pending_reply(command));
    fixture.writer.shutdown().await.unwrap();
    timeout(Duration::from_secs(2), settling)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn session_detachment_cannot_release_a_held_input_reply_credit() {
    let mut fixture = Fixture::new();
    let command = fixture.input();
    fixture.next_command().await;
    retain_pending_reply(command);
    let mut events = fixture.connection.subscribe();
    fixture.writer.write_all(format!("{}\0", json!({
        "method": "Target.detachedFromTarget", "params": { "sessionId": "original-session" },
    })).as_bytes()).await.unwrap();
    let detached = timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detached.method, "Target.detachedFromTarget");
    // Admission counts the original command even if the owner's public metadata is gone.
    let occupied = fixture
        .connection
        .start_commands(
            "occupied",
            vec![json!({}); ordinary_operation_limit(1024) - 1],
            None,
        )
        .unwrap();
    let error = fixture
        .connection
        .start_command("overflow", json!({}), None)
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    fixture.connection.close();
    for mut command in occupied {
        assert!(
            timeout(Duration::from_secs(2), command.response())
                .await
                .unwrap()
                .is_err()
        );
    }
}
