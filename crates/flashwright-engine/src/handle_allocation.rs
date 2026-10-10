//! Allocating replies must settle before private groups can be disposed safely.

use super::page_state::ExecutionContext;
use super::*;
use flashwright_browser::{Connection, connection::Command};

pub(crate) const CLEANUP_BUDGET: Duration = Duration::from_millis(500);

pub(crate) struct AllocationFailure {
    pub error: ErrorRecord,
    pub reply_pending: bool,
}

/// Realm destruction can invalidate the result without preventing a numeric-context adoption.
/// The caller must retire the page when the returned failure still owns an unsettled reply.
pub(crate) async fn wait_for_allocation<Output>(
    connection: &Connection,
    page: &Page,
    context: &ExecutionContext,
    operation: &Operation,
    command: &mut Command<Output>,
    executes_user_code: bool,
) -> Result<Output, AllocationFailure> {
    let mut reply_consumed = false;
    let result = operation
        .wait(page.state.while_execution_context(context, async {
            let response = command.response().await;
            reply_consumed = true;
            response
        }))
        .await;
    let error = match result {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    if reply_consumed || command.prevent_dispatch() || command.try_response().is_some() {
        return Err(AllocationFailure {
            error,
            reply_pending: false,
        });
    }
    let recover = async {
        let context_alive = {
            let state = page.state.state.lock().unwrap();
            state.failure.is_none() && state.context_is_alive(context)
        };
        if executes_user_code && context_alive {
            let _ = connection
                .call(
                    "Runtime.terminateExecution",
                    json!({}),
                    Some(&context.session_identifier),
                )
                .await;
        }
        command.response().await
    };
    let reply_pending = timeout(CLEANUP_BUDGET, recover).await.is_err();
    Err(AllocationFailure {
        error,
        reply_pending,
    })
}

/// A group can contain objects from several worlds, including a reused numeric context.
pub(crate) async fn release_group(
    connection: &Connection,
    session_identifier: &str,
    group: &str,
) -> Result<(), ErrorRecord> {
    connection
        .call(
            "Runtime.releaseObjectGroup",
            json!({"objectGroup": group}),
            Some(session_identifier),
        )
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

    struct Peer {
        reader: BufReader<ReadHalf<DuplexStream>>,
        writer: WriteHalf<DuplexStream>,
    }

    impl Peer {
        async fn command(&mut self) -> Value {
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

        async fn reply(&mut self, command: &Value, result: Value) {
            self.writer
                .write_all(
                    format!("{}\0", json!({"id": command["id"], "result": result})).as_bytes(),
                )
                .await
                .unwrap();
        }
    }

    struct Fixture {
        connection: Connection,
        page: Page,
        context: ExecutionContext,
        operation: Operation,
        cancellation: watch::Sender<bool>,
        peer: Peer,
    }

    impl Fixture {
        fn new() -> Self {
            let (host, peer) = tokio::io::duplex(4096);
            let (reader, writer) = tokio::io::split(host);
            let connection = Connection::new(reader, writer);
            let (reader, writer) = tokio::io::split(peer);
            let page = Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: Arc::new(PageState::default()),
            };
            let context = ExecutionContext {
                session_identifier: "original-renderer".into(),
                identifier: 1,
                unique_identifier: "original".into(),
                frame_identifier: "frame".into(),
            };
            page.state
                .state
                .lock()
                .unwrap()
                .initialize_main_frame("frame", "original-renderer");
            replace_context(&page, &context.unique_identifier);
            let (cancellation, receiver) = watch::channel(false);
            Self {
                connection,
                page,
                context,
                cancellation,
                operation: Operation::new("test.handle".into(), None, receiver),
                peer: Peer {
                    reader: BufReader::new(reader),
                    writer,
                },
            }
        }

        fn adopt(&self) -> Command {
            self.connection
                .start_command(
                    "DOM.resolveNode",
                    json!({
                        "backendNodeId": 42, "executionContextId": self.context.identifier,
                        "objectGroup": "attempt",
                    }),
                    Some(&self.context.session_identifier),
                )
                .unwrap()
        }
    }

    fn replace_context(page: &Page, unique: &str) {
        let mut state = page.state.state.lock().unwrap();
        state.observe_in_session(
            "original-renderer",
            "Runtime.executionContextCreated",
            &json!({"context": {
                "id": 1, "uniqueId": unique, "auxData": {"frameId": "frame", "isDefault": true},
            }}),
        );
        page.state.changed.send_replace(state.sequence);
    }

    #[tokio::test]
    async fn cancellation_terminates_only_the_original_renderer_session() {
        let mut fixture = Fixture::new();
        let mut command = fixture.adopt();
        let adoption = fixture.peer.command().await;
        assert_eq!(adoption["sessionId"], "original-renderer");
        fixture.cancellation.send_replace(true);
        let waiting = wait_for_allocation(
            &fixture.connection,
            &fixture.page,
            &fixture.context,
            &fixture.operation,
            &mut command,
            true,
        );
        let browser = async {
            let terminate = fixture.peer.command().await;
            assert_eq!(terminate["method"], "Runtime.terminateExecution");
            assert_eq!(terminate["sessionId"], "original-renderer");
            fixture.peer.reply(&terminate, json!({})).await;
            fixture
                .peer
                .reply(&adoption, json!({"object": {"objectId": "late-alias"}}))
                .await;
        };
        let (result, ()) = tokio::join!(waiting, browser);
        let failure = result.err().unwrap();
        assert_eq!(failure.error.code, ErrorCode::Cancelled);
        assert!(!failure.reply_pending);
    }

    #[tokio::test]
    async fn realm_loss_withdraws_queued_adoption_before_numeric_id_reuse() {
        let mut fixture = Fixture::new();
        let mut command = fixture.adopt();
        replace_context(&fixture.page, "successor");
        let failure = wait_for_allocation(
            &fixture.connection,
            &fixture.page,
            &fixture.context,
            &fixture.operation,
            &mut command,
            false,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(failure.error.code, ErrorCode::Evaluation);
        assert!(!failure.reply_pending);
        let _barrier = fixture
            .connection
            .start_command("barrier", json!({}), None)
            .unwrap();
        assert_eq!(fixture.peer.command().await["method"], "barrier");
    }

    #[tokio::test]
    async fn reused_numeric_context_keeps_late_alias_owned_until_group_release() {
        let mut fixture = Fixture::new();
        let mut command = fixture.adopt();
        let adoption = fixture.peer.command().await;
        replace_context(&fixture.page, "successor");
        let waiting = wait_for_allocation(
            &fixture.connection,
            &fixture.page,
            &fixture.context,
            &fixture.operation,
            &mut command,
            false,
        );
        tokio::pin!(waiting);
        assert!(
            timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        fixture.peer.reply(&adoption, json!({"object": {"type": "object", "subtype": "node", "objectId": "successor-alias"}})).await;
        let failure = waiting.await.err().unwrap();
        assert_eq!(failure.error.code, ErrorCode::Evaluation);
        assert!(!failure.reply_pending);
        let cleanup = release_group(
            &fixture.connection,
            &fixture.context.session_identifier,
            "attempt",
        );
        let browser = async {
            let release = fixture.peer.command().await;
            assert_eq!(release["method"], "Runtime.releaseObjectGroup");
            assert_eq!(release["sessionId"], "original-renderer");
            assert_eq!(release["params"]["objectGroup"], "attempt");
            fixture.peer.reply(&release, json!({})).await;
        };
        let (result, ()) = tokio::join!(cleanup, browser);
        result.unwrap();
    }

    #[tokio::test]
    async fn lost_realm_and_missing_reply_require_page_retirement() {
        let mut fixture = Fixture::new();
        let mut command = fixture.adopt();
        let _adoption = fixture.peer.command().await;
        replace_context(&fixture.page, "successor");
        let failure = wait_for_allocation(
            &fixture.connection,
            &fixture.page,
            &fixture.context,
            &fixture.operation,
            &mut command,
            false,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(failure.error.code, ErrorCode::Evaluation);
        assert!(failure.reply_pending);
        assert!(!command.prevent_dispatch());
        assert!(command.try_response().is_none());
    }

    #[tokio::test]
    async fn consumed_browser_failure_is_not_polled_again() {
        let mut fixture = Fixture::new();
        let mut command = fixture.adopt();
        let adoption = fixture.peer.command().await;
        fixture.peer.writer.write_all(format!("{}\0", json!({"id": adoption["id"], "error": {"code": -32000, "message": "No node with given id found"}})).as_bytes()).await.unwrap();
        let failure = wait_for_allocation(
            &fixture.connection,
            &fixture.page,
            &fixture.context,
            &fixture.operation,
            &mut command,
            false,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(failure.error.browser_error_code, Some(-32000));
        assert!(!failure.reply_pending);
    }

    #[tokio::test]
    async fn cancelled_command_recovers_an_already_delivered_reply() {
        let mut fixture = Fixture::new();
        let mut command = fixture.adopt();
        let adoption = fixture.peer.command().await;
        fixture
            .peer
            .reply(&adoption, json!({"object": {"objectId": "alias"}}))
            .await;
        let mut barrier = fixture
            .connection
            .start_command("barrier", json!({}), None)
            .unwrap();
        let marker = fixture.peer.command().await;
        fixture.peer.reply(&marker, json!({})).await;
        barrier.response().await.unwrap();
        fixture.cancellation.send_replace(true);
        let failure = wait_for_allocation(
            &fixture.connection,
            &fixture.page,
            &fixture.context,
            &fixture.operation,
            &mut command,
            true,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(failure.error.code, ErrorCode::Cancelled);
        assert!(!failure.reply_pending);
        let _next = fixture
            .connection
            .start_command("next", json!({}), None)
            .unwrap();
        assert_eq!(fixture.peer.command().await["method"], "next");
    }
}
