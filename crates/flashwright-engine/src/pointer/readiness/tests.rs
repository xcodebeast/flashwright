use super::cancel;
use flashwright_browser::{Connection, connection::Command};
use flashwright_protocol::{ErrorCode, ordinary_operation_limit};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::time::{Duration, timeout};

struct Fixture {
    connection: Connection,
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl Fixture {
    fn new() -> Self {
        let (host, peer) = tokio::io::duplex(1024 * 1024);
        let (reader, writer) = tokio::io::split(host);
        let connection = Connection::new(reader, writer);
        let (reader, writer) = tokio::io::split(peer);
        Self {
            connection,
            reader: BufReader::new(reader),
            writer,
        }
    }

    fn start(&self) -> Command {
        self.connection
            .start_command(
                "Runtime.callFunctionOn",
                json!({}),
                Some("original-session"),
            )
            .unwrap()
    }

    async fn next(&mut self) -> Value {
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

    async fn reply(&mut self, command: &Value, mut reply: Value) {
        reply["id"] = command["id"].clone();
        self.writer
            .write_all(format!("{reply}\0").as_bytes())
            .await
            .unwrap();
    }

    fn cleanup(&self, original: Command) -> tokio::task::JoinHandle<&'static str> {
        let connection = self.connection.clone();
        tokio::spawn(async move {
            cancel(
                &connection,
                "original-context",
                "original-session",
                "locator.click",
                "hint-token",
                original,
            )
            .await
        })
    }

    fn fill_pending(&self, existing: usize) -> Vec<Command> {
        self.connection
            .start_commands(
                "occupied",
                vec![json!({}); ordinary_operation_limit(1024) - existing],
                None,
            )
            .unwrap()
    }

    fn assert_full(&self) {
        match self.connection.start_command("probe", json!({}), None) {
            Err(error) => assert_eq!(error.code, ErrorCode::ResourceLimit),
            Ok(_) => panic!("a retained command released its credit before its reply"),
        }
    }
}

#[tokio::test]
async fn failed_cancellation_retains_original_and_keeps_connection_usable() {
    for reply in [
        json!({"error":{"code":-32000,"message":"injected rejection"}}),
        json!({"result":{"result":{"value":{"status":"unexpected"}}}}),
        json!({"result":{}}),
    ] {
        let mut fixture = Fixture::new();
        let original = fixture.start();
        let registration = fixture.next().await;
        let cleanup = fixture.cleanup(original);
        let cancellation = fixture.next().await;
        assert_eq!(cancellation["method"], "Runtime.callFunctionOn");
        assert_eq!(cancellation["sessionId"], "original-session");
        assert_eq!(
            cancellation["params"]["uniqueContextId"],
            "original-context"
        );
        assert_eq!(
            cancellation["params"]["arguments"][0]["value"],
            "hint-token"
        );
        fixture.reply(&cancellation, reply).await;
        // A round-trip barrier proves the rejection has been processed.
        let mut barrier = fixture.start();
        let sent = fixture.next().await;
        fixture.reply(&sent, json!({"result":{}})).await;
        barrier.response().await.unwrap();
        let occupied = fixture.fill_pending(1);
        fixture.assert_full();
        assert!(!cleanup.is_finished());
        fixture
            .reply(
                &registration,
                json!({"result":{"result":{"value":{"status":"expired"}}}}),
            )
            .await;
        assert_eq!(
            timeout(Duration::from_secs(2), cleanup)
                .await
                .unwrap()
                .unwrap(),
            "residentConditionFinished"
        );
        let _usable = fixture.start();
        drop(occupied);
        fixture.connection.close();
    }
}

#[tokio::test]
async fn cancellation_admission_failure_waits_for_original_without_closing_owner() {
    let mut fixture = Fixture::new();
    let original = fixture.start();
    let registration = fixture.next().await;
    let occupied = fixture.fill_pending(1);
    // Poll once deterministically while the ordinary admission pool is full.
    let mut cleanup = Box::pin(cancel(
        &fixture.connection,
        "original-context",
        "original-session",
        "locator.click",
        "hint-token",
        original,
    ));
    assert!(
        timeout(Duration::from_millis(10), &mut cleanup)
            .await
            .is_err()
    );
    fixture.assert_full();
    fixture
        .writer
        .write_all(
            format!(
                "{}\0",
                json!({"id":registration["id"],"result":{"result":{"value":{"status":"expired"}}}})
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), cleanup).await.unwrap(),
        "residentConditionFinished"
    );
    let _usable = fixture.start();
    drop(occupied);
    fixture.connection.close();
}

#[tokio::test]
async fn acknowledged_cancellation_still_retains_withheld_registration() {
    let mut fixture = Fixture::new();
    let original = fixture.start();
    let registration = fixture.next().await;
    let cleanup = fixture.cleanup(original);
    let cancellation = fixture.next().await;
    fixture
        .reply(&cancellation, json!({"result":{"result":{"value":null}}}))
        .await;
    let mut barrier = fixture.start();
    let sent = fixture.next().await;
    fixture.reply(&sent, json!({"result":{}})).await;
    barrier.response().await.unwrap();
    let occupied = fixture.fill_pending(1);
    fixture.assert_full();
    assert!(!cleanup.is_finished());
    fixture
        .reply(
            &registration,
            json!({"result":{"result":{"value":{"status":"cancelled"}}}}),
        )
        .await;
    assert_eq!(
        timeout(Duration::from_secs(2), cleanup)
            .await
            .unwrap()
            .unwrap(),
        "residentConditionReleased"
    );
    drop(occupied);
    fixture.connection.close();
}

#[tokio::test]
async fn finished_registration_still_retains_withheld_cancellation() {
    let mut fixture = Fixture::new();
    let original = fixture.start();
    let registration = fixture.next().await;
    let cleanup = fixture.cleanup(original);
    let cancellation = fixture.next().await;
    fixture
        .reply(
            &registration,
            json!({"result":{"result":{"value":{"status":"expired"}}}}),
        )
        .await;
    let mut barrier = fixture.start();
    let sent = fixture.next().await;
    fixture.reply(&sent, json!({"result":{}})).await;
    barrier.response().await.unwrap();
    let occupied = fixture.fill_pending(1);
    fixture.assert_full();
    assert!(!cleanup.is_finished());
    fixture
        .reply(
            &cancellation,
            json!({"result":{"result":{"value":{"status":"cancelled"}}}}),
        )
        .await;
    assert_eq!(
        timeout(Duration::from_secs(2), cleanup)
            .await
            .unwrap()
            .unwrap(),
        "residentConditionReleased"
    );
    drop(occupied);
    fixture.connection.close();
}

#[tokio::test]
async fn connection_loss_settles_both_withheld_replies() {
    let mut fixture = Fixture::new();
    let original = fixture.start();
    fixture.next().await;
    let cleanup = fixture.cleanup(original);
    fixture.next().await;
    let occupied = fixture.fill_pending(2);
    fixture.assert_full();
    fixture.connection.close();
    assert_eq!(
        timeout(Duration::from_secs(2), cleanup)
            .await
            .unwrap()
            .unwrap(),
        "residentReplyFailed"
    );
    drop(occupied);
}
