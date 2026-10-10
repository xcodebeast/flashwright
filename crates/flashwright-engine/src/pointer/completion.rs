//! Navigation may return before a by-value completion reply, but cannot abandon its owner.

use flashwright_browser::connection::Command;

/// Withdraw queued work synchronously; retain dispatched work under its original native credit.
pub(super) fn retain(mut command: Command) {
    if command.prevent_dispatch() || command.try_response().is_some() {
        return;
    }
    tokio::spawn(settle(command));
}

async fn settle(mut command: Command) {
    // Semantic failure and logical frame retirement do not prove physical destruction.
    // The native reply or connection loss releases this original pending-command credit.
    let _ = command.response().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Page;
    use crate::page_state::{ExecutionContext, PageState};
    use flashwright_browser::Connection;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
    use tokio::time::{Duration, timeout};

    struct Fixture {
        page: Page,
        context: ExecutionContext,
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
            let page = Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "root-session".into(),
                state: Arc::new(PageState::default()),
            };
            let context = ExecutionContext {
                session_identifier: "original-session".into(),
                identifier: 1,
                unique_identifier: "original-world".into(),
                frame_identifier: "frame".into(),
            };
            page.state
                .state
                .lock()
                .unwrap()
                .initialize_main_frame("frame", "original-session");
            let mut fixture = Self {
                page,
                context,
                connection,
                reader: BufReader::new(reader),
                writer,
            };
            fixture.replace_world("original-world");
            fixture
        }

        fn replace_world(&mut self, unique: &str) {
            let mut state = self.page.state.state.lock().unwrap();
            state.observe_in_session("original-session", "Runtime.executionContextCreated", &json!({
                "context": { "id": 1, "uniqueId": unique, "auxData": { "frameId": "frame", "isDefault": true } },
            }));
            self.page.state.changed.send_replace(state.sequence);
        }

        fn completion(&self) -> Command {
            self.connection
                .start_command(
                    "Runtime.callFunctionOn",
                    json!({
                        "uniqueContextId": self.context.unique_identifier, "returnByValue": true,
                    }),
                    Some(&self.context.session_identifier),
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

        async fn reply(&mut self, command: &Value) {
            self.writer.write_all(format!("{}\0", json!({ "id": command["id"], "result": { "result": { "value": { "status": "success" } } } })).as_bytes()).await.unwrap();
        }
    }

    #[tokio::test]
    async fn navigation_withdraws_a_completion_that_has_not_started() {
        let mut fixture = Fixture::new();
        retain(fixture.completion());
        let _barrier = fixture
            .connection
            .start_command("barrier", json!({}), None)
            .unwrap();
        assert_eq!(fixture.next_command().await["method"], "barrier");
    }

    #[tokio::test]
    async fn dispatched_completion_retains_original_command_until_its_reply_without_replay() {
        let mut fixture = Fixture::new();
        let command = fixture.completion();
        let sent = fixture.next_command().await;
        assert_eq!(sent["sessionId"], "original-session");
        assert_eq!(sent["params"]["uniqueContextId"], "original-world");
        let mut settling = tokio::spawn(settle(command));
        assert!(
            timeout(Duration::from_millis(10), &mut settling)
                .await
                .is_err()
        );
        fixture.reply(&sent).await;
        timeout(Duration::from_secs(2), settling)
            .await
            .unwrap()
            .unwrap();
        let _barrier = fixture
            .connection
            .start_command("barrier", json!({}), None)
            .unwrap();
        assert_eq!(fixture.next_command().await["method"], "barrier");
    }

    #[tokio::test]
    async fn reused_numeric_context_cannot_abandon_a_dispatched_completion() {
        let mut fixture = Fixture::new();
        let command = fixture.completion();
        let sent = fixture.next_command().await;
        let mut settling = tokio::spawn(settle(command));
        assert!(
            timeout(Duration::from_millis(10), &mut settling)
                .await
                .is_err()
        );
        fixture.replace_world("successor-world");
        assert!(
            timeout(Duration::from_millis(10), &mut settling)
                .await
                .is_err()
        );
        fixture.reply(&sent).await;
        timeout(Duration::from_secs(2), settling)
            .await
            .unwrap()
            .unwrap();
        let successor = fixture
            .connection
            .start_command("successor", json!({}), Some("original-session"))
            .unwrap();
        assert_eq!(fixture.next_command().await["method"], "successor");
        drop(successor);
    }

    #[tokio::test]
    async fn semantic_page_failure_cannot_abandon_a_dispatched_completion() {
        let mut fixture = Fixture::new();
        let command = fixture.completion();
        let sent = fixture.next_command().await;
        let mut settling = tokio::spawn(settle(command));
        assert!(
            timeout(Duration::from_millis(10), &mut settling)
                .await
                .is_err()
        );
        {
            let mut state = fixture.page.state.state.lock().unwrap();
            state.failure = Some(flashwright_protocol::ErrorRecord::new(
                flashwright_protocol::ErrorCode::ResourceLimit,
                "page.contexts",
                "context metadata full",
            ));
            state.sequence += 1;
            fixture.page.state.changed.send_replace(state.sequence);
        }
        assert!(
            timeout(Duration::from_millis(10), &mut settling)
                .await
                .is_err()
        );
        fixture.reply(&sent).await;
        timeout(Duration::from_secs(2), settling)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn connection_loss_releases_a_dispatched_completion_waiter() {
        let mut fixture = Fixture::new();
        let command = fixture.completion();
        fixture.next_command().await;
        let mut settling = tokio::spawn(settle(command));
        assert!(
            timeout(Duration::from_millis(10), &mut settling)
                .await
                .is_err()
        );
        fixture.writer.shutdown().await.unwrap();
        timeout(Duration::from_secs(2), settling)
            .await
            .unwrap()
            .unwrap();
    }
}
