use super::*;

use crate::page_state::{FrameState, PageState};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf, duplex, split,
};
use tokio::task::JoinHandle;
use tokio::time::{advance, timeout};

#[tokio::test(start_paused = true)]
async fn retained_payload_wait_preserves_original_document_unavailability() {
    let mut fixture = Fixture::new();
    let payloads = fixture.retained_payloads();
    let capture = fixture.capture(false);
    fixture.assert_no_command().await;
    assert!(!capture.is_finished());

    fixture.page.state.state.lock().unwrap().main_worlds.clear();
    fixture.page.state.changed.send_replace(1);
    let error = capture.await.unwrap().err().unwrap();
    assert!(
        matches!(
            &error,
            SnapshotFailure::Unavailable(SnapshotUnavailable::NoExistingMainContext)
        ),
        "retained-payload wait changed the original lifecycle reason: {error:?}"
    );
    drop(payloads);
    fixture.document.wait_finished().await;
    fixture.assert_no_command().await;
}

#[tokio::test]
async fn lifecycle_unavailability_preserves_reasons_without_browser_commands() {
    let mut fixture = Fixture::new();
    assert!(check_document(&fixture.page, &fixture.realm.clone().into()).is_ok());
    {
        let mut state = fixture.page.state.state.lock().unwrap();
        assert!(
            state
                .observe_in_session("session", "Page.javascriptDialogOpening", &json!({}))
                .is_empty()
        );
    }
    assert!(matches!(
        check_document(&fixture.page, &fixture.realm.clone().into()),
        Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::DialogOpen
        ))
    ));
    {
        let mut state = fixture.page.state.state.lock().unwrap();
        assert!(
            state
                .observe_in_session("session", "Page.javascriptDialogClosed", &json!({}))
                .is_empty()
        );
        state.observe_in_session(
            "session",
            "Page.frameRequestedNavigation",
            &json!({"frameId":"frame", "disposition":"currentTab"}),
        );
    }
    assert!(matches!(
        check_document(&fixture.page, &fixture.realm.clone().into()),
        Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::PendingNavigation
        ))
    ));
    fixture.page.state.state.lock().unwrap().main_worlds.clear();
    let error = fixture.capture(false).await.unwrap().err().unwrap();
    assert!(matches!(
        error,
        SnapshotFailure::Unavailable(SnapshotUnavailable::NoExistingMainContext)
    ));
    fixture.document.wait_finished().await;
    fixture.assert_no_command().await;
}

#[tokio::test]
async fn private_page_and_resource_failures_are_not_lifecycle_omissions() {
    let fixture = Fixture::new();
    let mut private = fixture.page.clone();
    private.state = Arc::new(PageState {
        purpose: PagePurpose::Storage,
        ..PageState::default()
    });
    let error = SnapshotDocument::start(
        "private",
        private,
        fixture.realm.clone(),
        fixture.connection.clone(),
        &fixture.budget,
        SessionLifetime::controlled("target", "session", fixture.destruction.clone()),
    )
    .err()
    .unwrap();
    assert!(matches!(
        error,
        SnapshotFailure::Failed(error) if error.code == ErrorCode::InvalidArgument
    ));
    let duplicate = SnapshotDocument::start(
        "duplicate",
        fixture.page.clone(),
        fixture.realm.clone(),
        fixture.connection.clone(),
        &fixture.budget,
        SessionLifetime::controlled("target", "session", fixture.destruction.clone()),
    )
    .err()
    .unwrap();
    assert!(matches!(
        duplicate,
        SnapshotFailure::Failed(error) if error.code == ErrorCode::ResourceLimit
    ));
    fixture.document.close();
    fixture.document.wait_finished().await;
}

#[tokio::test(start_paused = true)]
async fn closed_false_watch_channel_is_not_destruction_proof() {
    let (sender, mut receiver) = watch::channel(false);
    drop(sender);
    assert!(
        timeout(
            Duration::from_secs(1),
            confirmed_session_destruction(&mut receiver)
        )
        .await
        .is_err()
    );
}

struct Fixture {
    document: Arc<SnapshotDocument>,
    page: Page,
    realm: LocatorRealm,
    budget: Arc<SnapshotBudget>,
    connection: Connection,
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    cancellation: watch::Sender<bool>,
    destruction: watch::Sender<bool>,
}

impl Fixture {
    fn retained_payloads(&self) -> Vec<PayloadReservation> {
        let reservation = self.document.shared.reservation.lock().unwrap();
        let reservation = reservation.as_ref().unwrap();
        (0..64)
            .map(|_| {
                let mut capture = reservation.reserve_capture().unwrap();
                capture.begin_evaluation().unwrap();
                capture.evaluation_finished();
                let payload = capture.take_payload(1).unwrap();
                capture.transaction_finished().unwrap();
                payload
            })
            .collect()
    }

    fn new() -> Self {
        Self::with_budget(Arc::new(SnapshotBudget::default()), "context")
    }

    fn with_budget(budget: Arc<SnapshotBudget>, context: &str) -> Self {
        Self::with_capture_realm(budget, context, false)
    }

    fn with_capture_realm(budget: Arc<SnapshotBudget>, context: &str, lazy: bool) -> Self {
        Self::with_renderer(budget, context, lazy, false)
    }

    fn with_renderer(budget: Arc<SnapshotBudget>, context: &str, lazy: bool, remote: bool) -> Self {
        let (host, peer) = duplex(65536);
        let (reader, writer) = split(host);
        let connection = Connection::new(reader, writer);
        let (reader, writer) = split(peer);
        let main = ExecutionContext {
            session_identifier: "session".into(),
            identifier: 1,
            unique_identifier: "main-original".into(),
            frame_identifier: "frame".into(),
        };
        let isolated = ExecutionContext {
            session_identifier: "session".into(),
            identifier: 2,
            unique_identifier: "isolated-original".into(),
            frame_identifier: "frame".into(),
        };
        let page = Page {
            context_identifier: context.into(),
            target_identifier: if remote { "root-target" } else { "target" }.into(),
            session_identifier: if remote { "root-session" } else { "session" }.into(),
            state: Arc::new(PageState::default()),
        };
        {
            let mut sessions = page.state.renderer_sessions.lock().unwrap();
            let root = sessions
                .register_root(&page.target_identifier, &page.session_identifier)
                .unwrap();
            root.mark_ready();
            if remote {
                sessions
                    .register_child(&root, "target", "session")
                    .unwrap()
                    .mark_ready();
            }
        }
        {
            let mut state = page.state.state.lock().unwrap();
            state.main_frame = Some("frame".into());
            state.frames.insert(
                "frame".into(),
                FrameState {
                    session_identifier: "session".into(),
                    identifier: "frame".into(),
                    loader: "loader".into(),
                    remote,
                    ..Default::default()
                },
            );
            state.main_worlds.insert("frame".into(), main.clone());
            state.execution_contexts.insert(main.key(), main.clone());
            state
                .execution_contexts
                .insert(isolated.key(), isolated.clone());
        }
        let realm = LocatorRealm {
            loader: "loader".into(),
            context: isolated,
            main_context: main,
        };
        let destruction = watch::channel(false).0;
        let document = Arc::new(
            SnapshotDocument::start(
                "test-owner",
                page.clone(),
                if lazy {
                    SnapshotRealm::original(realm.main_context.clone(), realm.loader.clone())
                } else {
                    realm.clone().into()
                },
                connection.clone(),
                &budget,
                SessionLifetime::controlled("target", "session", destruction.clone()),
            )
            .unwrap(),
        );
        Self {
            document,
            page,
            realm,
            budget,
            connection,
            reader: BufReader::new(reader),
            writer,
            cancellation: watch::channel(false).0,
            destruction,
        }
    }

    fn capture(&self, target: bool) -> JoinHandle<Result<PreparedSnapshot, SnapshotFailure>> {
        self.capture_with_budget(target, Duration::from_secs(10))
    }

    fn capture_with_budget(
        &self,
        target: bool,
        allowance: Duration,
    ) -> JoinHandle<Result<PreparedSnapshot, SnapshotFailure>> {
        let document = self.document.clone();
        let cancellation = self.cancellation.subscribe();
        let target = target.then(|| SnapshotNode {
            object_identifier: "original-target".into(),
            context: self.realm.main_context.clone(),
        });
        tokio::spawn(async move {
            document
                .capture(
                    CaptureOptions {
                        token: "capture-token".into(),
                        call_identifier: "public-call".into(),
                        target,
                        frames: Vec::new(),
                    },
                    Instant::now() + allowance,
                    cancellation,
                )
                .await
        })
    }

    async fn command(&mut self, method: &str) -> Value {
        let mut bytes = Vec::new();
        timeout(
            Duration::from_secs(1),
            self.reader.read_until(0, &mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(bytes.pop(), Some(0));
        let command: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(command["method"], method);
        assert_eq!(command["sessionId"], "session");
        command
    }

    async fn reply(&mut self, command: &Value, result: Value) {
        let reply = json!({"id":command["id"], "sessionId":"session", "result":result});
        self.writer
            .write_all(reply.to_string().as_bytes())
            .await
            .unwrap();
        self.writer.write_all(&[0]).await.unwrap();
    }

    async fn install(&mut self) {
        let command = self.command("Runtime.evaluate").await;
        assert_eq!(command["params"]["uniqueContextId"], "isolated-original");
        assert_eq!(
            command["params"]["objectGroup"],
            "__flashwright_snapshot_test-owner"
        );
        self.reply(
            &command,
            json!({"result":{"type":"object","objectId":"factory"}}),
        )
        .await;
    }

    async fn captured(&mut self, expected_number: u64) {
        let command = self.command("Runtime.callFunctionOn").await;
        let options = &command["params"]["arguments"][0]["value"];
        assert_eq!(options["snapshotNumber"], expected_number);
        assert_eq!(command["params"]["objectId"], "factory");
        let data = json!({
            "html":["HTML",{},"retained"], "url":"about:blank", "doctype":"html",
            "viewport":{"width":1280,"height":720}, "wallTime":1, "collectionTime":0,
            "resourceOverrides":[],
        });
        self.reply(&command, json!({"result":{"type":"object","value":{
            "token":options["token"], "snapshotNumber":options["snapshotNumber"],
            "counters":{"bytes":data.to_string().len(),"overrideBytes":0,"cssReadBytes":0,
                "nodes":1,"depth":1,"cssDepth":0,"attributes":0,"sheets":0,"rules":0,"overrideCount":0},
            "data":data,
            "committedCache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0},
            "tentativeCache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0},
        }}})).await;
        self.release("_attempt_").await;
    }

    async fn release(&mut self, expected_group_part: &str) {
        let command = self.command("Runtime.releaseObjectGroup").await;
        assert!(
            command["params"]["objectGroup"]
                .as_str()
                .unwrap()
                .contains(expected_group_part)
        );
        self.reply(&command, json!({})).await;
    }

    async fn retire_factory(&mut self) {
        let command = self.command("Runtime.callFunctionOn").await;
        assert_eq!(command["params"]["objectId"], "factory");
        assert_eq!(
            command["params"]["functionDeclaration"],
            "function() { return this.retire(); }"
        );
        self.reply(&command, json!({"result":{"type":"boolean","value":true}}))
            .await;
    }

    async fn finish(&mut self) {
        self.document.close();
        self.retire_factory().await;
        self.release("__flashwright_snapshot_test-owner").await;
        timeout(Duration::from_secs(1), self.document.wait_finished())
            .await
            .unwrap();
        assert!(self.page.state.state.lock().unwrap().failure.is_none());
        let mut ordinary = self
            .connection
            .start_command("ordinary-successor", json!({}), Some("session"))
            .unwrap();
        let command = self.command("ordinary-successor").await;
        self.reply(&command, json!({"healthy":true})).await;
        assert_eq!(ordinary.response().await.unwrap()["healthy"], true);
    }

    async fn assert_no_command(&mut self) {
        let mut bytes = Vec::new();
        assert!(
            timeout(
                Duration::from_millis(1),
                self.reader.read_until(0, &mut bytes)
            )
            .await
            .is_err()
        );
        assert!(bytes.is_empty());
    }
}

#[tokio::test(start_paused = true)]
async fn retained_payload_backpressure_waits_for_ingestion_before_dispatch() {
    let mut fixture = Fixture::new();
    let mut payloads = fixture.retained_payloads();
    let capture = fixture.capture(false);
    fixture.assert_no_command().await;
    assert!(
        !capture.is_finished(),
        "retained payloads must apply backpressure"
    );
    drop(payloads.pop());
    fixture.install().await;
    fixture.captured(1).await;
    let prepared = capture.await.unwrap().unwrap();
    let decision = tokio::spawn(prepared.decision.discard());
    let command = fixture.command("Runtime.callFunctionOn").await;
    fixture
        .reply(&command, json!({"result":{"type":"boolean","value":true}}))
        .await;
    fixture.release("_decision_").await;
    decision.await.unwrap().unwrap();
    drop(prepared.reservation);
    drop(payloads);
    fixture.finish().await;
}

#[tokio::test(start_paused = true)]
async fn remote_document_keeps_its_session_for_world_capture_decision_and_retirement() {
    let mut fixture =
        Fixture::with_renderer(Arc::new(SnapshotBudget::default()), "context", true, true);
    assert!(
        fixture
            .budget
            .owns_document("context", "session", "main-original")
    );
    assert!(
        !fixture
            .budget
            .owns_document("context", "root-session", "main-original")
    );
    let capture = fixture.capture(false);
    let world = fixture.command("Page.createIsolatedWorld").await;
    fixture.reply(&world, json!({"executionContextId":2})).await;
    fixture.install().await;
    fixture.captured(1).await;
    let prepared = capture.await.unwrap().unwrap();
    let commit = tokio::spawn(prepared.decision.commit());
    let command = fixture.command("Runtime.callFunctionOn").await;
    fixture
        .reply(
            &command,
            json!({"result":{"value":{"snapshotNumber":1,"cache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0}}}}),
        )
        .await;
    fixture.release("_decision_").await;
    commit.await.unwrap().unwrap();
    drop(prepared.reservation);
    fixture.finish().await;
}

#[tokio::test(start_paused = true)]
async fn remote_retirement_invalidates_capture_but_keeps_dispatched_command_custody() {
    let mut fixture =
        Fixture::with_renderer(Arc::new(SnapshotBudget::default()), "context", false, true);
    let capture = fixture.capture(false);
    let installation = fixture.command("Runtime.evaluate").await;
    {
        let mut sessions = fixture.page.state.renderer_sessions.lock().unwrap();
        let original = sessions.get("session").unwrap();
        sessions.retire(&original);
    }
    fixture.page.state.changed.send_replace(1);
    assert!(matches!(
        capture.await.unwrap(),
        Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::OriginalDocumentChanged
        ))
    ));
    fixture.assert_no_command().await;
    assert!(!fixture.document.finished());
    assert!(
        fixture
            .budget
            .owns_document("context", "session", "main-original")
    );
    assert!(!*fixture.destruction.borrow());
    fixture
        .reply(&installation, json!({"result":{"objectId":"late-factory"}}))
        .await;
    fixture.release("_attempt_").await;
    fixture.release("__flashwright_snapshot_test-owner").await;
    fixture.document.wait_finished().await;
    assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
    assert!(
        !fixture
            .budget
            .owns_document("context", "session", "main-original")
    );
}

#[tokio::test(start_paused = true)]
async fn remote_missing_session_reply_omits_capture_before_native_detachment() {
    for stage in ["world", "installation", "capture"] {
        let mut fixture = Fixture::with_renderer(
            Arc::new(SnapshotBudget::default()),
            "context",
            stage == "world",
            true,
        );
        let capture = fixture.capture(false);
        if stage == "capture" {
            fixture.install().await;
        }
        let method = match stage {
            "world" => "Page.createIsolatedWorld",
            "installation" => "Runtime.evaluate",
            _ => "Runtime.callFunctionOn",
        };
        let command = fixture.command(method).await;
        let response = json!({"id":command["id"],"sessionId":"session","error":{"code":-32001,"message":"Session with given id not found."}});
        fixture
            .writer
            .write_all(response.to_string().as_bytes())
            .await
            .unwrap();
        fixture.writer.write_all(&[0]).await.unwrap();
        assert!(matches!(
            capture.await.unwrap(),
            Err(SnapshotFailure::Unavailable(
                SnapshotUnavailable::OriginalDocumentChanged
            ))
        ));
        assert!(!*fixture.destruction.borrow());
        assert!(
            fixture
                .budget
                .owns_document("context", "session", "main-original")
        );
        fixture.destruction.send_replace(true);
        fixture.document.wait_finished().await;
        assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
    }
}

#[tokio::test(start_paused = true)]
async fn payload_waiters_keep_bounded_queue_slots_and_the_original_deadline() {
    let mut fixture = Fixture::new();
    let payloads = fixture.retained_payloads();
    let first = fixture.capture_with_budget(false, Duration::from_millis(20));
    let second = fixture.capture_with_budget(false, Duration::from_millis(20));
    fixture.assert_no_command().await;
    assert!(!first.is_finished() && !second.is_finished());
    let excess = fixture.capture(false).await.unwrap().err().unwrap();
    assert_eq!(excess.recording_error().code, ErrorCode::ResourceLimit);
    advance(Duration::from_millis(25)).await;
    for waiter in [first, second] {
        assert_eq!(
            waiter.await.unwrap().err().unwrap().recording_error().code,
            ErrorCode::Timeout
        );
    }
    drop(payloads);
    fixture.assert_no_command().await;
    drop(fixture.retained_payloads());
    let first_slot = fixture.document.requests.try_reserve().unwrap();
    let second_slot = fixture.document.requests.try_reserve().unwrap();
    drop((first_slot, second_slot));
    fixture.document.close();
    fixture.document.wait_finished().await;
}

#[tokio::test(start_paused = true)]
async fn payload_waiter_cancellation_and_owner_close_suppress_later_dispatch() {
    for close_owner in [false, true] {
        let mut fixture = Fixture::new();
        let payloads = fixture.retained_payloads();
        let capture = fixture.capture(false);
        fixture.assert_no_command().await;
        assert!(!capture.is_finished());
        if close_owner {
            fixture.document.close();
        } else {
            fixture.cancellation.send_replace(true);
        }
        let error = capture.await.unwrap().err().unwrap().recording_error();
        assert_eq!(
            error.code,
            if close_owner {
                ErrorCode::TargetClosed
            } else {
                ErrorCode::Cancelled
            }
        );
        drop(payloads);
        fixture.assert_no_command().await;
        if !close_owner {
            drop(fixture.retained_payloads());
        }
        fixture.document.close();
        fixture.document.wait_finished().await;
    }
}

#[tokio::test(start_paused = true)]
async fn global_payload_backpressure_releases_without_borrowing_another_contexts_credits() {
    let budget = Arc::new(SnapshotBudget::default());
    let first = Fixture::with_budget(budget.clone(), "first");
    let second = Fixture::with_budget(budget.clone(), "second");
    let mut waiting = Fixture::with_budget(budget, "third");
    let mut first_payloads = first.retained_payloads();
    let second_payloads = second.retained_payloads();
    let capture = waiting.capture(false);
    waiting.assert_no_command().await;
    assert!(!capture.is_finished());
    drop(first_payloads.pop());
    waiting.install().await;
    waiting.captured(1).await;
    let prepared = capture.await.unwrap().unwrap();
    let decision = tokio::spawn(prepared.decision.discard());
    let command = waiting.command("Runtime.callFunctionOn").await;
    waiting
        .reply(&command, json!({"result":{"type":"boolean","value":true}}))
        .await;
    waiting.release("_decision_").await;
    decision.await.unwrap().unwrap();
    drop(prepared.reservation);
    waiting.finish().await;
    drop(first_payloads);
    drop(second_payloads);
    for fixture in [first, second] {
        fixture.document.close();
        fixture.document.wait_finished().await;
    }
}

#[tokio::test(start_paused = true)]
async fn commit_acknowledgement_allows_immediate_successor_without_releasing_its_reservation() {
    let mut fixture = Fixture::new();
    let first = fixture.capture(false);
    fixture.install().await;
    fixture.captured(1).await;
    let first = first.await.unwrap().unwrap();
    assert_eq!(first.captured.snapshot_number, 1);
    let second = fixture.capture(false);
    fixture.assert_no_command().await;
    let committed = tokio::spawn(first.decision.commit());
    let command = fixture.command("Runtime.callFunctionOn").await;
    assert!(
        command["params"]["functionDeclaration"]
            .as_str()
            .unwrap()
            .contains("this.commit")
    );
    fixture
        .reply(
            &command,
            json!({"result":{"type":"object","value":{
                "snapshotNumber":1,"cache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0},
            }}}),
        )
        .await;
    fixture.release("_decision_").await;
    committed.await.unwrap().unwrap();
    fixture.captured(2).await;
    let second = second.await.unwrap().unwrap();
    drop(first.reservation);
    let discarded = tokio::spawn(second.decision.discard());
    let command = fixture.command("Runtime.callFunctionOn").await;
    assert!(
        command["params"]["functionDeclaration"]
            .as_str()
            .unwrap()
            .contains("this.discard")
    );
    fixture
        .reply(&command, json!({"result":{"type":"boolean","value":true}}))
        .await;
    fixture.release("_decision_").await;
    discarded.await.unwrap().unwrap();
    fixture.finish().await;
}

#[tokio::test(start_paused = true)]
async fn timed_out_installation_keeps_credits_until_late_reply_and_both_group_acknowledgements() {
    let mut fixture = Fixture::new();
    let captured = fixture.capture(false);
    let installation = fixture.command("Runtime.evaluate").await;
    advance(Duration::from_secs(3)).await;
    assert_eq!(
        captured
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Timeout
    );
    let destruction = std::mem::replace(&mut fixture.destruction, watch::channel(false).0);
    drop(destruction);
    fixture.assert_no_command().await;
    let extra_documents: Vec<_> = (0..31)
        .map(|index| {
            fixture
                .budget
                .reserve_document("context", "session", &format!("quota-world-{index}"))
                .unwrap()
        })
        .collect();
    assert!(
        fixture
            .budget
            .reserve_document("context", "session", "quota-successor")
            .is_err()
    );
    fixture
        .reply(
            &installation,
            json!({"result":{"type":"object","objectId":"late-factory"}}),
        )
        .await;
    fixture.release("_attempt_").await;
    let release = fixture.command("Runtime.releaseObjectGroup").await;
    assert!(
        fixture
            .budget
            .reserve_document("context", "session", "quota-successor")
            .is_err()
    );
    fixture.reply(&release, json!({})).await;
    timeout(Duration::from_secs(1), fixture.document.wait_finished())
        .await
        .unwrap();
    drop(
        fixture
            .budget
            .reserve_document("context", "session", "quota-successor")
            .unwrap(),
    );
    assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
    drop(extra_documents);
}

#[tokio::test(start_paused = true)]
async fn reused_numeric_adoption_context_does_not_release_unknown_alias_ownership() {
    let mut fixture = Fixture::new();
    let captured = fixture.capture(true);
    fixture.install().await;
    let described = fixture.command("DOM.describeNode").await;
    assert_eq!(described["params"]["objectId"], "original-target");
    fixture
        .reply(&described, json!({"node":{"backendNodeId":42}}))
        .await;
    let adoption = fixture.command("DOM.resolveNode").await;
    assert_eq!(adoption["params"]["executionContextId"], 2);
    assert_eq!(adoption["params"]["backendNodeId"], 42);
    {
        let mut state = fixture.page.state.state.lock().unwrap();
        state.execution_contexts.insert(
            fixture.realm.context.key(),
            ExecutionContext {
                unique_identifier: "isolated-successor".into(),
                ..fixture.realm.context.clone()
            },
        );
    }
    fixture.page.state.changed.send_replace(1);
    assert_eq!(
        captured
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Evaluation
    );
    fixture.assert_no_command().await;
    fixture
        .reply(
            &adoption,
            json!({"object":{"type":"object","subtype":"node","objectId":"successor-alias"}}),
        )
        .await;
    fixture.release("_attempt_").await;
    fixture.retire_factory().await;
    fixture.release("__flashwright_snapshot_test-owner").await;
    timeout(Duration::from_secs(1), fixture.document.wait_finished())
        .await
        .unwrap();
    assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
}

#[tokio::test(start_paused = true)]
async fn confirmed_session_destruction_settles_pending_work_without_browser_cleanup_commands() {
    let mut fixture = Fixture::new();
    let captured = fixture.capture(false);
    fixture.command("Runtime.evaluate").await;
    fixture.cancellation.send_replace(true);
    assert_eq!(
        captured
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Cancelled
    );
    fixture.assert_no_command().await;
    fixture.destruction.send_replace(true);
    timeout(Duration::from_secs(1), fixture.document.wait_finished())
        .await
        .unwrap();
    fixture.assert_no_command().await;
    assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
}

#[tokio::test(start_paused = true)]
async fn unknown_commit_cannot_release_factory_grants_or_change_the_public_page_outcome() {
    let mut fixture = Fixture::new();
    let captured = fixture.capture(false);
    fixture.install().await;
    fixture.captured(1).await;
    let captured = captured.await.unwrap().unwrap();
    let committed = tokio::spawn(captured.decision.commit());
    let command = fixture.command("Runtime.callFunctionOn").await;
    advance(Duration::from_secs(3)).await;
    assert_eq!(
        committed.await.unwrap().unwrap_err().recording_error().code,
        ErrorCode::Timeout
    );
    drop(captured.reservation);
    let documents: Vec<_> = (0..31)
        .map(|index| {
            fixture
                .budget
                .reserve_document("context", "session", &format!("quota-world-{index}"))
                .unwrap()
        })
        .collect();
    assert!(
        fixture
            .budget
            .reserve_document("context", "session", "quota-successor")
            .is_err()
    );
    fixture.assert_no_command().await;
    assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
    fixture
        .reply(
            &command,
            json!({"result":{"type":"object","value":{
                "snapshotNumber":1,"cache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0},
            }}}),
        )
        .await;
    fixture.release("_decision_").await;
    fixture.retire_factory().await;
    fixture.release("__flashwright_snapshot_test-owner").await;
    timeout(Duration::from_secs(1), fixture.document.wait_finished())
        .await
        .unwrap();
    assert_eq!(
        fixture.document.failure().unwrap().recording_error().code,
        ErrorCode::Timeout
    );
    drop(
        fixture
            .budget
            .reserve_document("context", "session", "quota-successor")
            .unwrap(),
    );
    drop(documents);
}

#[tokio::test(start_paused = true)]
async fn evaluation_admission_waits_for_a_slot_without_restarting_the_original_deadline() {
    let budget = Arc::new(SnapshotBudget::default());
    let mut first = Fixture::with_budget(budget.clone(), "first");
    let mut second = Fixture::with_budget(budget.clone(), "second");
    let mut third = Fixture::with_budget(budget, "third");
    let first_capture = first.capture(false);
    first.command("Runtime.evaluate").await;
    let second_capture = second.capture(false);
    second.command("Runtime.evaluate").await;
    let third_capture = third.capture_with_budget(false, Duration::from_millis(20));
    third.assert_no_command().await;
    advance(Duration::from_millis(25)).await;
    assert_eq!(
        third_capture
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Timeout
    );
    timeout(Duration::from_secs(1), third.document.wait_finished())
        .await
        .unwrap();
    third.assert_no_command().await;
    for fixture in [&mut first, &mut second] {
        fixture.cancellation.send_replace(true);
        fixture.destruction.send_replace(true);
        timeout(Duration::from_secs(1), fixture.document.wait_finished())
            .await
            .unwrap();
    }
    assert_eq!(
        first_capture
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        second_capture
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Cancelled
    );
}

#[tokio::test(start_paused = true)]
async fn releasing_an_evaluation_wakes_an_already_charged_capture_in_another_document() {
    let budget = Arc::new(SnapshotBudget::default());
    let mut first = Fixture::with_budget(budget.clone(), "first");
    let mut second = Fixture::with_budget(budget.clone(), "second");
    let mut third = Fixture::with_budget(budget, "third");
    let first_capture = first.capture(false);
    first.install().await;
    let second_capture = second.capture(false);
    second.command("Runtime.evaluate").await;
    let third_capture = third.capture(false);
    third.assert_no_command().await;
    first.captured(1).await;
    let first_snapshot = first_capture.await.unwrap().unwrap();
    third.command("Runtime.evaluate").await;
    let discarded = tokio::spawn(first_snapshot.decision.discard());
    let command = first.command("Runtime.callFunctionOn").await;
    first
        .reply(&command, json!({"result":{"type":"boolean","value":true}}))
        .await;
    first.release("_decision_").await;
    discarded.await.unwrap().unwrap();
    first.finish().await;
    for fixture in [&mut second, &mut third] {
        fixture.cancellation.send_replace(true);
        fixture.destruction.send_replace(true);
        timeout(Duration::from_secs(1), fixture.document.wait_finished())
            .await
            .unwrap();
    }
    assert_eq!(
        second_capture
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        third_capture
            .await
            .unwrap()
            .err()
            .unwrap()
            .recording_error()
            .code,
        ErrorCode::Cancelled
    );
}

#[tokio::test(start_paused = true)]
async fn payload_pressure_waits_for_release_but_preserves_cancellation_and_the_original_deadline() {
    for outcome in ["release", "cancel", "expire"] {
        let budget = Arc::new(SnapshotBudget::default());
        let documents: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|identity| {
                budget
                    .reserve_document("context", "other-session", identity)
                    .unwrap()
            })
            .collect();
        let mut reservations: Vec<_> = documents
            .iter()
            .map(|document| {
                let mut capture = document.reserve_capture().unwrap();
                capture.begin_evaluation().unwrap();
                capture.evaluation_finished();
                capture
            })
            .collect();
        let mut fixture = Fixture::with_budget(budget, "context");
        let capturing = fixture.capture_with_budget(false, Duration::from_millis(20));
        fixture.assert_no_command().await;
        let expected = if outcome == "expire" {
            advance(Duration::from_millis(25)).await;
            ErrorCode::Timeout
        } else {
            if outcome == "release" {
                reservations.pop();
                fixture.command("Runtime.evaluate").await;
                fixture.destruction.send_replace(true);
            }
            fixture.cancellation.send_replace(true);
            ErrorCode::Cancelled
        };
        assert_eq!(
            capturing
                .await
                .unwrap()
                .err()
                .unwrap()
                .recording_error()
                .code,
            expected
        );
        timeout(Duration::from_secs(1), fixture.document.wait_finished())
            .await
            .unwrap();
        drop(reservations);
        drop(documents);
        fixture.assert_no_command().await;
    }
}

#[tokio::test(start_paused = true)]
async fn close_during_discard_release_recovers_the_reply_before_releasing_the_factory() {
    let mut fixture = Fixture::new();
    let captured = fixture.capture(false);
    fixture.install().await;
    fixture.captured(1).await;
    drop(captured.await.unwrap().unwrap());
    let discarded = fixture.command("Runtime.callFunctionOn").await;
    assert!(
        discarded["params"]["functionDeclaration"]
            .as_str()
            .unwrap()
            .contains("this.discard")
    );
    fixture
        .reply(
            &discarded,
            json!({"result":{"type":"boolean","value":true}}),
        )
        .await;
    let first_release = fixture.command("Runtime.releaseObjectGroup").await;
    assert!(
        first_release["params"]["objectGroup"]
            .as_str()
            .unwrap()
            .contains("_decision_")
    );
    fixture.document.close();
    fixture.assert_no_command().await;
    fixture.reply(&first_release, json!({})).await;
    fixture.release("_decision_").await;
    fixture.retire_factory().await;
    fixture.release("__flashwright_snapshot_test-owner").await;
    timeout(Duration::from_secs(1), fixture.document.wait_finished())
        .await
        .unwrap();
    assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
}

#[tokio::test(start_paused = true)]
async fn accepted_snapshot_data_retains_native_credits_until_host_ingestion_acknowledgement() {
    use crate::recording::SnapshotPhase;
    use crate::snapshots::SnapshotMetadata;
    for fail_archive in [false, true] {
        let mut fixture = Fixture::new();
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = crate::Engine::new(
            None,
            outgoing,
            fatal,
            flashwright_protocol::ResourceLimits::default(),
        );
        let context = Arc::new(crate::context_state::ContextState::default());
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            crate::Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: crate::devices::DeviceOptions::default(),
                settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
                state: context.clone(),
                published: true,
            },
        );
        let operation = crate::Operation::new(
            "snapshot-probe".into(),
            None,
            fixture.cancellation.subscribe(),
        );
        let parameters = json!({"context":"context","recording":"recording","chunk":"chunk"});
        let control = |method: &str, parameters: &Value| {
            engine
                .execute_control(method, parameters, &operation)
                .unwrap()
        };
        control(
            "context.trace.recording.start",
            &json!({"context":"context","recording":"recording"}),
        )
        .unwrap();
        control("context.trace.chunk.start", &parameters).unwrap();
        assert!(
            context
                .recording
                .lock()
                .unwrap()
                .get_mut("recording")
                .unwrap()
                .admit_phase("chunk", "public-call", SnapshotPhase::Before)
                .unwrap()
        );
        let capture = fixture.capture(false);
        fixture.install().await;
        fixture.captured(1).await;
        let prepared = capture.await.unwrap().unwrap();
        assert!(prepared.captured_at <= std::time::Instant::now());
        let decision = context
            .recording
            .lock()
            .unwrap()
            .get_mut("recording")
            .unwrap()
            .accept_snapshot(
                "chunk",
                SnapshotMetadata {
                    capture: "capture-token".into(),
                    call: "public-call".into(),
                    phase: SnapshotPhase::Before,
                    page: "page".into(),
                    frame: "frame".into(),
                    is_main_frame: true,
                    snapshot_number: 0,
                    native_time: 0.0,
                    byte_length: 0,
                },
                prepared,
            )
            .unwrap();
        assert_eq!(
            control("context.trace.snapshot.pull", &parameters).unwrap()["snapshots"],
            json!([])
        );
        let mut identity = parameters.clone();
        identity["capture"] = json!("capture-token");
        assert!(
            engine
                .take_snapshot(identity.clone(), &operation)
                .await
                .is_err()
        );
        control("context.trace.chunk.seal", &parameters).unwrap();
        let committed = tokio::spawn(decision.commit());
        let command = fixture.command("Runtime.callFunctionOn").await;
        fixture
            .reply(
                &command,
                json!({"result":{"type":"object","value":{
                    "snapshotNumber":1,"cache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0},
                }}}),
            )
            .await;
        fixture.release("_decision_").await;
        let result = committed.await.unwrap();
        context
            .recording
            .lock()
            .unwrap()
            .get_mut("recording")
            .unwrap()
            .snapshot_commit_finished("chunk", "capture-token", result)
            .unwrap();
        context
            .recording
            .lock()
            .unwrap()
            .get_mut("recording")
            .unwrap()
            .settle_phase("chunk", "public-call", SnapshotPhase::Before)
            .unwrap();
        let metadata = control("context.trace.snapshot.pull", &parameters).unwrap();
        assert_eq!(metadata["snapshots"].as_array().unwrap().len(), 1);
        assert_eq!(metadata["snapshots"][0]["snapshotNumber"], 1);
        assert_eq!(
            control("context.trace.snapshot.pull", &parameters).unwrap()["snapshots"],
            json!([])
        );
        let mut acknowledgement = identity.clone();
        acknowledgement["success"] = json!(true);
        assert!(control("context.trace.snapshot.ingested", &acknowledgement).is_err());
        let held_transfers = engine
            .attachment_slots
            .clone()
            .try_acquire_many_owned(2)
            .unwrap();
        for _ in 0..3 {
            assert!(
                engine
                    .take_snapshot(identity.clone(), &operation)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let mut unknown = identity.clone();
        unknown["capture"] = json!("not-the-original-capture");
        assert!(engine.take_snapshot(unknown, &operation).await.is_err());
        assert!(control("context.trace.snapshot.ingested", &acknowledgement).is_err());
        drop(held_transfers);
        let payload = engine
            .take_snapshot(identity.clone(), &operation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            payload.decoded_length,
            metadata["snapshots"][0]["byteLength"].as_u64().unwrap() as usize
        );
        assert!(engine.take_snapshot(identity, &operation).await.is_err());
        fixture.finish().await;
        let successor = fixture
            .budget
            .reserve_document("context", "session", "main-original")
            .unwrap();
        let stop = json!({"context":"context","recording":"recording"});
        assert!(control("context.trace.recording.stop", &stop).is_err());
        let immutable_host_data: Value = serde_json::from_slice(&payload.bytes).unwrap();
        assert_eq!(immutable_host_data["html"][2], "retained");
        if fail_archive {
            control("context.trace.recording.fail", &json!({
                "context":"context", "recording":"recording", "message":"controlled archive failure"
            })).unwrap();
        } else {
            control("context.trace.snapshot.ingested", &acknowledgement).unwrap();
        }
        assert!(control("context.trace.snapshot.ingested", &acknowledgement).is_err());
        assert_eq!(
            control("context.trace.chunk.status", &parameters).unwrap()["snapshotPending"],
            true
        );
        assert!(control("context.trace.recording.stop", &stop).is_err());
        assert!(matches!(
            fixture
                .budget
                .reserve_document("context", "session", "main-original"),
            Err(AdmissionError::DocumentAlreadyOwned)
        ));
        drop(payload);
        assert!(
            fixture
                .budget
                .owns_document("context", "session", "main-original")
        );
        assert_eq!(
            control("context.trace.chunk.status", &parameters).unwrap()["snapshotPending"],
            false
        );
        let stopped = control("context.trace.recording.stop", &stop);
        if fail_archive {
            assert_eq!(stopped.unwrap_err().code, ErrorCode::Protocol);
        } else {
            stopped.unwrap();
        }
        drop(successor);
        assert!(
            !fixture
                .budget
                .owns_document("context", "session", "main-original")
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_dialog_retired_worker_releases_its_claim_before_payload_ingestion() {
    let mut fixture = Fixture::new();
    let capturing = fixture.capture(false);
    fixture.install().await;
    fixture.captured(1).await;
    let captured = capturing.await.unwrap().unwrap();
    let committed = tokio::spawn(captured.decision.commit());
    let command = fixture.command("Runtime.callFunctionOn").await;
    fixture
        .reply(
            &command,
            json!({"result":{"type":"object","value":{
                "snapshotNumber":1,"cache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0}
            }}}),
        )
        .await;
    fixture.release("_decision_").await;
    committed.await.unwrap().unwrap();
    fixture.page.state.state.lock().unwrap().observe_in_session(
        "session",
        "Page.javascriptDialogOpening",
        &json!({}),
    );
    fixture.page.state.changed.send_replace(1);
    fixture.retire_factory().await;
    let release = fixture.command("Runtime.releaseObjectGroup").await;
    assert!(
        fixture
            .budget
            .owns_document("context", "session", "main-original")
    );
    fixture.reply(&release, json!({})).await;
    timeout(Duration::from_secs(1), fixture.document.wait_finished())
        .await
        .unwrap();
    assert!(
        !fixture
            .budget
            .owns_document("context", "session", "main-original")
    );
    fixture.page.state.state.lock().unwrap().observe_in_session(
        "session",
        "Page.javascriptDialogClosed",
        &json!({}),
    );
    fixture.document = Arc::new(
        SnapshotDocument::start(
            "successor",
            fixture.page.clone(),
            fixture.realm.clone(),
            fixture.connection.clone(),
            &fixture.budget,
            SessionLifetime::controlled("target", "session", fixture.destruction.clone()),
        )
        .unwrap(),
    );
    drop(captured.reservation);
    assert!(
        fixture
            .budget
            .owns_document("context", "session", "main-original")
    );
    fixture.document.close();
    timeout(Duration::from_secs(1), fixture.document.wait_finished())
        .await
        .unwrap();
    assert!(
        !fixture
            .budget
            .owns_document("context", "session", "main-original")
    );
    fixture.assert_no_command().await;
}

#[tokio::test(start_paused = true)]
async fn lazy_world_selection_shares_the_fixed_utility_world_without_locator_runtime_installation()
{
    let mut fixture =
        Fixture::with_capture_realm(Arc::new(SnapshotBudget::default()), "context", true);
    let capture = fixture.capture(false);
    let created = fixture.command("Page.createIsolatedWorld").await;
    assert_eq!(
        created["params"],
        json!({"frameId":"frame","worldName":LOCATOR_WORLD_NAME})
    );
    fixture
        .reply(&created, json!({"executionContextId":2}))
        .await;
    fixture.install().await;
    fixture.captured(1).await;
    let prepared = capture.await.unwrap().unwrap();
    let discarded = tokio::spawn(prepared.decision.discard());
    let command = fixture.command("Runtime.callFunctionOn").await;
    fixture
        .reply(&command, json!({"result":{"type":"boolean","value":true}}))
        .await;
    fixture.release("_decision_").await;
    discarded.await.unwrap().unwrap();
    drop(prepared.reservation);
    fixture.finish().await;
}

#[tokio::test(start_paused = true)]
async fn timed_out_world_selection_retains_command_and_grants_until_late_settlement() {
    let mut fixture =
        Fixture::with_capture_realm(Arc::new(SnapshotBudget::default()), "context", true);
    let capture = fixture.capture_with_budget(false, Duration::from_millis(100));
    let created = fixture.command("Page.createIsolatedWorld").await;
    advance(Duration::from_millis(101)).await;
    assert_eq!(
        capture.await.unwrap().err().unwrap().recording_error().code,
        ErrorCode::Timeout
    );
    assert!(matches!(
        fixture
            .budget
            .reserve_document("context", "session", "main-original"),
        Err(AdmissionError::DocumentAlreadyOwned)
    ));
    fixture.assert_no_command().await;
    fixture
        .reply(&created, json!({"executionContextId":2}))
        .await;
    fixture.release("_attempt_").await;
    fixture.release("__flashwright_snapshot_test-owner").await;
    fixture.document.wait_finished().await;
    assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
    drop(
        fixture
            .budget
            .reserve_document("context", "session", "main-original")
            .unwrap(),
    );
    fixture.assert_no_command().await;
}

impl Fixture {
    fn capture_child_frame(&self) -> JoinHandle<Result<PreparedSnapshot, SnapshotFailure>> {
        self.capture_child_frame_with_renderer(false)
    }

    fn capture_child_frame_with_renderer(
        &self,
        remote: bool,
    ) -> JoinHandle<Result<PreparedSnapshot, SnapshotFailure>> {
        let session = if remote { "child-session" } else { "session" };
        if remote {
            let mut sessions = self.page.state.renderer_sessions.lock().unwrap();
            let parent = sessions.get("session").unwrap();
            sessions
                .register_child(&parent, "child-target", session)
                .unwrap()
                .mark_ready();
        }
        let child_context = ExecutionContext {
            session_identifier: session.into(),
            identifier: 3,
            unique_identifier: "child-original".into(),
            frame_identifier: "child".into(),
        };
        {
            let mut state = self.page.state.state.lock().unwrap();
            state.frames.insert(
                "child".into(),
                FrameState {
                    session_identifier: session.into(),
                    identifier: "child".into(),
                    parent: Some("frame".into()),
                    loader: "child-loader".into(),
                    remote,
                    ..Default::default()
                },
            );
            state
                .main_worlds
                .insert("child".into(), child_context.clone());
            state
                .execution_contexts
                .insert(child_context.key(), child_context.clone());
        }
        let document = self.document.clone();
        let cancellation = self.cancellation.subscribe();
        tokio::spawn(async move {
            document
                .capture(
                    CaptureOptions {
                        token: "capture-token".into(),
                        call_identifier: "public-call".into(),
                        target: None,
                        frames: vec![SnapshotFrame {
                            identifier: "child".into(),
                            loader: "child-loader".into(),
                            main_context: child_context,
                        }],
                    },
                    Instant::now() + Duration::from_secs(2),
                    cancellation,
                )
                .await
        })
    }
}

#[tokio::test(start_paused = true)]
async fn child_frame_owner_uses_exact_backend_identity_in_original_parent_world() {
    let mut fixture = Fixture::new();
    let capture = fixture.capture_child_frame();
    fixture.install().await;
    let owner = fixture.command("DOM.getFrameOwner").await;
    assert_eq!(owner["params"]["frameId"], "child");
    fixture.reply(&owner, json!({"backendNodeId": 42})).await;
    let resolve = fixture.command("DOM.resolveNode").await;
    assert_eq!(resolve["params"]["backendNodeId"], 42);
    assert_eq!(resolve["params"]["executionContextId"], 2);
    assert_eq!(
        resolve["params"]["objectGroup"],
        "__flashwright_snapshot_test-owner_attempt_1"
    );
    fixture
        .reply(
            &resolve,
            json!({"object":{"objectId":"original-frame-element"}}),
        )
        .await;
    let verify = fixture.command("DOM.describeNode").await;
    assert_eq!(verify["params"]["objectId"], "original-frame-element");
    fixture
        .reply(&verify, json!({"node":{"backendNodeId":42}}))
        .await;
    fixture.captured(1).await;
    let prepared = capture.await.unwrap().unwrap();
    let discard = tokio::spawn(prepared.decision.discard());
    let command = fixture.command("Runtime.callFunctionOn").await;
    fixture
        .reply(&command, json!({"result":{"value":true}}))
        .await;
    fixture.release("_decision_").await;
    discard.await.unwrap().unwrap();
    fixture.finish().await;
}

fn replace_captured_child(fixture: &Fixture) {
    let mut state = fixture.page.state.state.lock().unwrap();
    let replacement = ExecutionContext {
        session_identifier: "session".into(),
        identifier: 3,
        unique_identifier: "child-replacement".into(),
        frame_identifier: "child".into(),
    };
    state
        .main_worlds
        .insert("child".into(), replacement.clone());
    state
        .execution_contexts
        .insert(replacement.key(), replacement);
    state.sequence += 1;
    fixture.page.state.changed.send_replace(state.sequence);
}

#[tokio::test(start_paused = true)]
async fn captured_parent_commit_survives_child_replacement_after_serialization() {
    use crate::recording::SnapshotPhase;
    use crate::snapshots::{SnapshotArchive, SnapshotMetadata};

    for (remote, replacement_phase) in [false, true].into_iter().flat_map(|remote| {
        ["before decision", "during commit", "during cleanup"].map(|phase| (remote, phase))
    }) {
        let mut fixture = Fixture::new();
        let capture = fixture.capture_child_frame_with_renderer(remote);
        fixture.install().await;
        let owner = fixture.command("DOM.getFrameOwner").await;
        fixture.reply(&owner, json!({"backendNodeId": 42})).await;
        let resolve = fixture.command("DOM.resolveNode").await;
        fixture
            .reply(
                &resolve,
                json!({"object":{"objectId":"original-frame-element"}}),
            )
            .await;
        let verify = fixture.command("DOM.describeNode").await;
        fixture
            .reply(&verify, json!({"node":{"backendNodeId":42}}))
            .await;
        fixture.captured(1).await;
        let prepared = capture.await.unwrap().unwrap();
        let expected_data = prepared.captured.data.bytes.clone();
        let mut archive = SnapshotArchive::default();
        let decision = archive
            .accept(
                SnapshotMetadata {
                    capture: "capture-token".into(),
                    call: "public-call".into(),
                    phase: SnapshotPhase::Before,
                    page: "page".into(),
                    frame: "frame".into(),
                    is_main_frame: true,
                    snapshot_number: 0,
                    native_time: 0.0,
                    byte_length: 0,
                },
                prepared,
            )
            .unwrap();
        assert!(archive.pull().unwrap().is_empty());
        if replacement_phase == "before decision" {
            replace_captured_child(&fixture);
        }
        let committed = tokio::spawn(decision.commit());
        let command = fixture.command("Runtime.callFunctionOn").await;
        assert!(
            command["params"]["functionDeclaration"]
                .as_str()
                .unwrap()
                .contains("this.commit")
        );
        if replacement_phase == "during commit" {
            replace_captured_child(&fixture);
        }
        fixture
            .reply(
                &command,
                json!({"result":{"value":{
                    "snapshotNumber":1,"cache":{"bytes":0,"nodes":0,"attributes":0,"sheets":0}
                }}}),
            )
            .await;
        let release = fixture.command("Runtime.releaseObjectGroup").await;
        assert!(
            release["params"]["objectGroup"]
                .as_str()
                .unwrap()
                .contains("_decision_")
        );
        if replacement_phase == "during cleanup" {
            replace_captured_child(&fixture);
        }
        fixture.reply(&release, json!({})).await;
        archive
            .commit_finished("capture-token", committed.await.unwrap())
            .unwrap();
        let metadata = archive.pull().unwrap();
        assert_eq!(metadata.len(), 1, "{replacement_phase}");
        assert_eq!(metadata[0].snapshot_number, 1);
        let (data, reservation) = archive.take("capture-token").unwrap();
        assert_eq!(data.bytes, expected_data, "{replacement_phase}");
        archive.ingested("capture-token").unwrap();
        drop(reservation);
        fixture.finish().await;
    }
}

#[tokio::test(start_paused = true)]
async fn child_context_replacement_during_frame_owner_lookup_prevents_adoption() {
    let mut fixture = Fixture::new();
    let capture = fixture.capture_child_frame();
    fixture.install().await;
    let owner = fixture.command("DOM.getFrameOwner").await;
    {
        let mut state = fixture.page.state.state.lock().unwrap();
        let replacement = ExecutionContext {
            session_identifier: "session".into(),
            identifier: 3,
            unique_identifier: "child-replacement".into(),
            frame_identifier: "child".into(),
        };
        state
            .main_worlds
            .insert("child".into(), replacement.clone());
        state
            .execution_contexts
            .insert(replacement.key(), replacement);
    }
    fixture.reply(&owner, json!({"backendNodeId":42})).await;
    assert!(matches!(
        capture.await.unwrap(),
        Err(SnapshotFailure::Unavailable(
            SnapshotUnavailable::OriginalDocumentChanged
        ))
    ));
    fixture.release("_attempt_").await;
    fixture.retire_factory().await;
    fixture.release("__flashwright_snapshot_test-owner").await;
    fixture.document.wait_finished().await;
    fixture.assert_no_command().await;
}

#[tokio::test(start_paused = true)]
async fn changed_child_backend_is_rejected_before_capture_and_aliases_are_released() {
    let mut fixture = Fixture::new();
    let capture = fixture.capture_child_frame();
    fixture.install().await;
    let owner = fixture.command("DOM.getFrameOwner").await;
    fixture.reply(&owner, json!({"backendNodeId":42})).await;
    let resolve = fixture.command("DOM.resolveNode").await;
    fixture
        .reply(&resolve, json!({"object":{"objectId":"incorrect-element"}}))
        .await;
    let verify = fixture.command("DOM.describeNode").await;
    fixture
        .reply(&verify, json!({"node":{"backendNodeId":43}}))
        .await;
    assert!(
        matches!(capture.await.unwrap(), Err(SnapshotFailure::Failed(error)) if error.code == ErrorCode::Protocol)
    );
    fixture.release("_attempt_").await;
    fixture.retire_factory().await;
    fixture.release("__flashwright_snapshot_test-owner").await;
    fixture.document.wait_finished().await;
    fixture.assert_no_command().await;
}

#[tokio::test(start_paused = true)]
async fn observer_retirement_requires_acknowledgement_or_exact_native_destruction() {
    for response in [
        "held",
        "false",
        "exception",
        "object-error",
        "context-error",
    ] {
        let mut fixture = Fixture::new();
        let capture = fixture.capture(false);
        fixture.install().await;
        fixture.captured(1).await;
        let prepared = capture.await.unwrap().unwrap();
        let discard = tokio::spawn(prepared.decision.discard());
        let command = fixture.command("Runtime.callFunctionOn").await;
        fixture
            .reply(&command, json!({"result":{"value":true}}))
            .await;
        fixture.release("_decision_").await;
        discard.await.unwrap().unwrap();
        drop(prepared.reservation);
        fixture.document.close();
        let retirement = fixture.command("Runtime.callFunctionOn").await;
        assert_eq!(retirement["params"]["objectId"], "factory");
        assert!(
            retirement["params"]["functionDeclaration"]
                .as_str()
                .unwrap()
                .contains("this.retire()")
        );
        match response {
            "false" => {
                fixture
                    .reply(&retirement, json!({"result":{"value":false}}))
                    .await
            }
            "exception" => {
                fixture
                    .reply(
                        &retirement,
                        json!({"result":{"value":true},"exceptionDetails":{}}),
                    )
                    .await
            }
            "object-error" | "context-error" => {
                let message = if response == "object-error" {
                    "Could not find object with given id"
                } else {
                    "Cannot find context with specified id"
                };
                let reply = json!({"id":retirement["id"],"sessionId":"session","error":{"code":-32000,"message":message}});
                fixture
                    .writer
                    .write_all(reply.to_string().as_bytes())
                    .await
                    .unwrap();
                fixture.writer.write_all(&[0]).await.unwrap();
            }
            _ => {}
        }
        fixture.page.state.state.lock().unwrap().observe_in_session(
            "other-session",
            "Runtime.executionContextsCleared",
            &json!({}),
        );
        fixture.page.state.changed.send_replace(1);
        for (session, parameters) in [
            (
                "other-session",
                json!({"executionContextId":2,"executionContextUniqueId":"isolated-original"}),
            ),
            (
                "session",
                json!({"executionContextId":2,"executionContextUniqueId":"isolated-successor"}),
            ),
            ("session", json!({"executionContextId":2})),
        ] {
            fixture.page.state.state.lock().unwrap().observe_in_session(
                session,
                "Runtime.executionContextDestroyed",
                &parameters,
            );
        }
        fixture.assert_no_command().await;
        assert!(
            fixture
                .budget
                .owns_document("context", "session", "main-original")
        );
        fixture.page.state.state.lock().unwrap().observe_in_session(
            "session",
            "Runtime.executionContextDestroyed",
            &json!({"executionContextId":2,"executionContextUniqueId":"isolated-original"}),
        );
        fixture.release("__flashwright_snapshot_test-owner").await;
        timeout(Duration::from_secs(1), fixture.document.wait_finished())
            .await
            .unwrap();
        assert!(
            !fixture
                .budget
                .owns_document("context", "session", "main-original")
        );
        assert!(!*fixture.destruction.borrow());
        assert!(fixture.page.state.state.lock().unwrap().failure.is_none());
    }
}

#[tokio::test]
async fn owned_session_clear_retires_original_watches_without_destroyed_events() {
    let fixture = Fixture::new();
    {
        let mut state = fixture.page.state.state.lock().unwrap();
        let original = state
            .watch_context_destruction(&fixture.realm.context)
            .unwrap();
        state.observe_in_session(
            "other-session",
            "Runtime.executionContextsCleared",
            &json!({}),
        );
        assert!(!*original.destroyed.borrow());
        state.observe_in_session("session", "Runtime.executionContextsCleared", &json!({}));
        assert!(*original.destroyed.borrow());
        assert!(!state.context_is_alive(&fixture.realm.context));
        // A later context with a reused numeric identity does not inherit the signal.
        let successor = ExecutionContext {
            unique_identifier: "successor-world".into(),
            ..fixture.realm.context.clone()
        };
        state
            .execution_contexts
            .insert(successor.key(), successor.clone());
        let successor_watch = state.watch_context_destruction(&successor).unwrap();
        assert!(!*successor_watch.destroyed.borrow());
    }
    fixture.document.close();
    fixture.document.wait_finished().await;
}

#[tokio::test]
async fn original_context_watches_are_bounded_and_survive_registry_replacement() {
    let fixture = Fixture::new();
    {
        let mut state = fixture.page.state.state.lock().unwrap();
        let mut owners = Vec::new();
        for _ in 0..128 {
            owners.push(
                state
                    .watch_context_destruction(&fixture.realm.context)
                    .unwrap(),
            );
        }
        assert_eq!(
            state
                .watch_context_destruction(&fixture.realm.context)
                .err()
                .unwrap()
                .code,
            ErrorCode::ResourceLimit
        );
        owners.pop();
        owners.push(
            state
                .watch_context_destruction(&fixture.realm.context)
                .unwrap(),
        );
        state.execution_contexts.insert(
            fixture.realm.context.key(),
            ExecutionContext {
                unique_identifier: "new-world".into(),
                ..fixture.realm.context.clone()
            },
        );
        assert!(owners.iter().all(|owner| !*owner.destroyed.borrow()));
        state.observe_in_session(
            "session",
            "Runtime.executionContextDestroyed",
            &json!({"executionContextId":2,"executionContextUniqueId":"isolated-original"}),
        );
        assert!(owners.iter().all(|owner| *owner.destroyed.borrow()));
        assert_eq!(
            state.execution_contexts[&fixture.realm.context.key()].unique_identifier,
            "new-world"
        );
    }
    fixture.document.close();
    fixture.document.wait_finished().await;
}
