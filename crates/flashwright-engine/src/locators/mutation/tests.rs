use super::*;
use crate::renderer_sessions::RendererSession;
use flashwright_browser::Connection;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

struct Fixture {
    slots: Arc<Semaphore>,
    page: Page,
    context: ExecutionContext,
    connection: Connection,
    owner: Arc<RendererSession>,
    operation: Operation,
    cancellation: watch::Sender<bool>,
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
            target_identifier: "page".into(),
            session_identifier: "root".into(),
            state: Arc::new(PageState::default()),
        };
        let owner = page
            .state
            .renderer_sessions
            .lock()
            .unwrap()
            .register_root("child", "original-session")
            .unwrap();
        page.state
            .state
            .lock()
            .unwrap()
            .initialize_main_frame("child", "original-session");
        let context = ExecutionContext {
            session_identifier: "original-session".into(),
            identifier: 1,
            unique_identifier: "original-world".into(),
            frame_identifier: "child".into(),
        };
        let (cancellation, receiver) = watch::channel(false);
        let fixture = Self {
            slots: Arc::new(Semaphore::new(1)),
            page,
            context,
            connection,
            owner,
            operation: Operation::new("locator.fill".into(), None, receiver),
            cancellation,
            reader: BufReader::new(reader),
            writer,
        };
        fixture.replace_world("original-world");
        fixture
    }
    fn replace_world(&self, unique: &str) {
        let mut state = self.page.state.state.lock().unwrap();
        state.observe_in_session("original-session", "Runtime.executionContextCreated", &json!({"context":{"id":1,"uniqueId":unique,"auxData":{"frameId":"child","isDefault":true}}}));
        self.page.state.changed.send_replace(state.sequence);
    }
    fn command(&self) -> Command {
        self.connection
            .start_command(
                "Runtime.callFunctionOn",
                json!({"uniqueContextId":"original-world","returnByValue":true}),
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
    async fn reply(&mut self, sent: &Value) {
        self.writer
            .write_all(format!("{}\0", json!({"id":sent["id"],"result":{}})).as_bytes())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn queued_cancel_withdraws_without_uncertain_delivery() {
    let mut f = Fixture::new();
    let command = f.command();
    f.cancellation.send_replace(true);
    let failure = wait(
        &f.page,
        &f.context,
        &f.operation,
        command,
        f.slots.clone().try_acquire_owned().unwrap(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(failure.error.code, ErrorCode::Cancelled);
    assert_eq!(failure.error.input_delivery, InputDelivery::NotDispatched);
    assert!(failure.pending.is_none());
    let _barrier = f
        .connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    assert_eq!(f.next().await["method"], "barrier");
}

#[tokio::test]
async fn logical_world_retirement_still_requires_disposal_for_unsettled_mutation() {
    let mut f = Fixture::new();
    let command = f.command();
    let sent = f.next().await;
    f.replace_world("successor-world");
    let failure = wait(
        &f.page,
        &f.context,
        &f.operation,
        command,
        f.slots.clone().try_acquire_owned().unwrap(),
    )
    .await
    .err()
    .unwrap();
    let mut pending = failure.pending.unwrap();
    assert!(pending.requires_disposal().await);
    let completion = tokio::spawn(pending.finish());
    assert_eq!(failure.error.input_delivery, InputDelivery::Uncertain);
    assert_eq!(
        failure.error.cleanup.as_deref(),
        Some("pendingOriginalMutationReply")
    );
    f.reply(&sent).await;
    completion.await.unwrap();
}

#[tokio::test]
async fn physical_renderer_loss_preserves_parent_and_retains_original_credit_and_owner() {
    let mut f = Fixture::new();
    let command = f.command();
    let sent = f.next().await;
    let weak = Arc::downgrade(&f.owner);
    f.replace_world("successor-world");
    f.owner.mark_destroyed();
    f.page
        .state
        .renderer_sessions
        .lock()
        .unwrap()
        .retire(&f.owner);
    let failure = wait(
        &f.page,
        &f.context,
        &f.operation,
        command,
        f.slots.clone().try_acquire_owned().unwrap(),
    )
    .await
    .err()
    .unwrap();
    let mut pending = failure.pending.unwrap();
    assert!(!pending.requires_disposal().await);
    let completion = tokio::spawn(pending.finish());
    assert_eq!(failure.error.input_delivery, InputDelivery::Uncertain);
    let mut held = Vec::new();
    while let Ok(command) = f.connection.start_command("held", json!({}), None) {
        held.push(command);
        assert_eq!(f.next().await["method"], "held");
    }
    assert_eq!(
        held.len(),
        flashwright_protocol::ordinary_operation_limit(1024) - 1
    );
    drop(f.owner);
    assert!(
        weak.upgrade().is_some(),
        "pending original reply must retain renderer lease"
    );
    f.writer
        .write_all(format!("{}\0", json!({"id":sent["id"],"result":{}})).as_bytes())
        .await
        .unwrap();
    timeout(Duration::from_secs(2), async {
        while weak.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    completion.await.unwrap();
    assert_eq!(f.slots.available_permits(), 1);
    assert!(
        f.connection
            .start_command("available", json!({}), None)
            .is_ok()
    );
}

#[tokio::test]
async fn cancellation_returns_before_cleanup_without_interrupting_other_execution() {
    let mut f = Fixture::new();
    let command = f.command();
    let sent = f.next().await;
    f.cancellation.send_replace(true);
    let failure = timeout(
        Duration::from_millis(100),
        wait(
            &f.page,
            &f.context,
            &f.operation,
            command,
            f.slots.clone().try_acquire_owned().unwrap(),
        ),
    )
    .await
    .expect("public cancellation must not wait for the cleanup budget")
    .err()
    .unwrap();
    assert_eq!(failure.error.code, ErrorCode::Cancelled);
    assert_eq!(failure.error.input_delivery, InputDelivery::Uncertain);
    let mut pending = failure.pending.unwrap();
    let reader = &mut f.reader;
    let writer = &mut f.writer;
    let browser = async {
        let mut bytes = Vec::new();
        assert!(
            timeout(Duration::from_millis(25), reader.read_until(0, &mut bytes))
                .await
                .is_err(),
            "cleanup cannot interrupt another evaluation or dispatch replacement work"
        );
        writer
            .write_all(format!("{}\0", json!({"id":sent["id"],"result":{}})).as_bytes())
            .await
            .unwrap();
    };
    let (dispose, ()) = tokio::join!(pending.requires_disposal(), browser);
    assert!(!dispose);
    pending.finish().await;
}

#[tokio::test]
async fn settled_native_reply_cannot_release_cleanup_admission_before_disposal_finishes() {
    let mut f = Fixture::new();
    let admission = admit(&f.slots, &f.page, &f.context, &f.operation)
        .await
        .unwrap();
    let command = f.command();
    let sent = f.next().await;
    f.cancellation.send_replace(true);
    let failure = wait(&f.page, &f.context, &f.operation, command, admission)
        .await
        .err()
        .unwrap();
    let mut pending = failure.pending.unwrap();
    assert!(pending.requires_disposal().await);
    f.reply(&sent).await;
    tokio::task::yield_now().await;
    let (_cancel, receiver) = watch::channel(false);
    let operation = Operation::new(
        "locator.fill".into(),
        Some(tokio::time::Instant::now() + Duration::from_millis(20)),
        receiver,
    );
    let error = admit(&f.slots, &f.page, &f.context, &operation)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.input_delivery, InputDelivery::NotDispatched);
    assert_eq!(f.slots.available_permits(), 0);
    pending.finish().await;
    let operation = Operation::new("locator.fill".into(), None, f.cancellation.subscribe());
    f.cancellation.send_replace(false);
    let admitted = admit(&f.slots, &f.page, &f.context, &operation)
        .await
        .unwrap();
    drop(admitted);
    assert_eq!(f.slots.available_permits(), 1);
}
