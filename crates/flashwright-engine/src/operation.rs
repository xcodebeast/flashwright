//! Cooperative cancellation keeps allocation replies alive until ownership is resolved.

use std::future::Future;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};

use flashwright_browser::{Chromium, Connection};
use flashwright_protocol::{ErrorCode, ErrorRecord, InputDelivery, TraceCall};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::{Duration, Instant, sleep_until, timeout};

const CLEANUP_STEP_BUDGET: Duration = Duration::from_millis(500);

pub struct Operation {
    method: String,
    deadline: Option<Instant>,
    cancellation: watch::Receiver<bool>,
    input_delivery: AtomicU8,
    input_attachment: OnceLock<Arc<flashwright_protocol::InputAttachment>>,
    trace_call: Option<TraceCall>,
}

pub(crate) trait ResourceOwner: Sync {
    fn connection(&self) -> &Connection;
    fn close(&self) -> impl Future<Output = Result<(), ErrorRecord>> + Send;
}

impl ResourceOwner for Chromium {
    fn connection(&self) -> &Connection {
        &self.connection
    }
    async fn close(&self) -> Result<(), ErrorRecord> {
        match timeout(Duration::from_millis(1200), Chromium::close(self)).await {
            Ok(result) => result,
            Err(_) => {
                let mut error = ErrorRecord::new(
                    ErrorCode::Timeout,
                    "browser.close",
                    "guardian continues cleanup after the operation cleanup budget",
                );
                error.cleanup = Some("guardianContinuingCleanup".into());
                Err(error)
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ResourceKind {
    Context,
    Page,
}

/// Cleanup callers and the detachment caused by their close share the original page's result.
pub(crate) struct PageDisposal {
    progress: tokio::sync::Mutex<PageDisposalProgress>,
    recovery_requested: watch::Sender<bool>,
}

#[derive(Default)]
enum PageDisposalProgress {
    #[default]
    Ready,
    Closing(flashwright_browser::connection::Command),
    Confirming,
    Complete(&'static str),
}

impl PageDisposalProgress {
    /// The command lives in page state, so dropping a caller cannot discard its pending reply.
    async fn acknowledge(&mut self, owner: &impl ResourceOwner, identifier: &str) -> bool {
        if matches!(self, Self::Ready) {
            *self = match owner.connection().start_command(
                "Target.closeTarget",
                json!({"targetId":identifier}),
                None,
            ) {
                Ok(command) => Self::Closing(command),
                Err(_) => Self::Confirming,
            };
        }
        let Self::Closing(command) = self else {
            return false;
        };
        let acknowledged = command.response().await.is_ok();
        *self = if acknowledged {
            Self::Complete("resourceDisposed")
        } else {
            Self::Confirming
        };
        acknowledged
    }
}

impl Default for PageDisposal {
    fn default() -> Self {
        Self {
            progress: tokio::sync::Mutex::new(PageDisposalProgress::Ready),
            recovery_requested: watch::channel(false).0,
        }
    }
}

impl PageDisposal {
    pub(crate) async fn dispose(
        &self,
        owner: &impl ResourceOwner,
        identifier: &str,
    ) -> &'static str {
        self.recovery_requested.send_replace(true);
        let mut progress = self.progress.lock().await;
        if let PageDisposalProgress::Complete(result) = *progress {
            return result;
        }
        let cleanup = if matches!(
            timeout(CLEANUP_STEP_BUDGET, progress.acknowledge(owner, identifier)).await,
            Ok(true)
        ) {
            "resourceDisposed"
        } else {
            confirm_disposal(owner, ResourceKind::Page, identifier).await
        };
        *progress = PageDisposalProgress::Complete(cleanup);
        cleanup
    }

    pub(crate) async fn close(&self, owner: &impl ResourceOwner, identifier: &str) {
        let mut progress = self.progress.lock().await;
        if matches!(*progress, PageDisposalProgress::Complete(_)) {
            return;
        }
        let mut recovery = self.recovery_requested.subscribe();
        if *recovery.borrow_and_update() {
            drop(progress);
            self.dispose(owner, identifier).await;
            return;
        }
        // Ordinary close remains unbounded. A concurrent failed operation can request bounded
        // recovery, retaining this same reply instead of dispatching another close command.
        let acknowledged = tokio::select! {
            acknowledged = progress.acknowledge(owner, identifier) => acknowledged,
            _ = recovery.changed() => {
                matches!(timeout(CLEANUP_STEP_BUDGET, progress.acknowledge(owner, identifier)).await, Ok(true))
            }
        };
        let cleanup = if acknowledged {
            "resourceDisposed"
        } else {
            confirm_disposal(owner, ResourceKind::Page, identifier).await
        };
        *progress = PageDisposalProgress::Complete(cleanup);
    }
}

impl ResourceKind {
    fn identifier_field(self) -> &'static str {
        match self {
            Self::Context => "browserContextId",
            Self::Page => "targetId",
        }
    }
    fn dispose_method(self) -> &'static str {
        match self {
            Self::Context => "Target.disposeBrowserContext",
            Self::Page => "Target.closeTarget",
        }
    }
}

impl Operation {
    pub fn new(
        method: String,
        deadline: Option<Instant>,
        cancellation: watch::Receiver<bool>,
    ) -> Self {
        Self {
            method,
            deadline,
            cancellation,
            input_delivery: AtomicU8::new(0),
            input_attachment: OnceLock::new(),
            trace_call: None,
        }
    }

    /// Completed request bytes remain owned through execution and terminal publication.
    pub fn attach_input(
        &self,
        attachment: flashwright_protocol::InputAttachment,
    ) -> Result<(), ErrorRecord> {
        self.input_attachment
            .set(Arc::new(attachment))
            .map_err(|_| {
                ErrorRecord::new(
                    ErrorCode::Protocol,
                    &self.method,
                    "binary input was supplied more than once",
                )
            })
    }

    pub fn input_attachment(&self) -> Option<&[u8]> {
        self.input_attachment
            .get()
            .map(|attachment| attachment.bytes.as_slice())
    }

    /// A browser writer keeps both bytes and admission credits until its complete frame is sent.
    pub fn shared_input_attachment(&self) -> Option<Arc<flashwright_protocol::InputAttachment>> {
        self.input_attachment.get().cloned()
    }

    /// Keep trace provenance fixed through delayed dispatch, retries and cleanup.
    pub fn with_trace_call(mut self, trace_call: Option<TraceCall>) -> Self {
        self.trace_call = trace_call;
        self
    }

    pub(crate) fn trace_call(&self) -> Option<&TraceCall> {
        self.trace_call.as_ref()
    }

    /// Optional diagnostics cannot inherit an unbounded caller or outlive its cancellation.
    pub(crate) fn bounded_diagnostic(&self, allowance: Duration) -> Self {
        let ceiling = Instant::now() + allowance;
        Self::new(
            self.method.clone(),
            Some(self.deadline.unwrap_or(ceiling).min(ceiling)),
            self.cancellation.clone(),
        )
    }

    /// Diagnostic work shares the original deadline and cancellation; it never extends the action.
    pub(crate) fn snapshot_allowance(&self) -> (Instant, watch::Receiver<bool>) {
        let ceiling = Instant::now() + Duration::from_secs(2);
        (
            self.deadline.unwrap_or(ceiling).min(ceiling),
            self.cancellation.clone(),
        )
    }

    /// Delivery progress survives successful completion and cannot erase an uncertain dispatch.
    pub fn input_delivery(&self) -> InputDelivery {
        match self.input_delivery.load(Ordering::Relaxed) {
            0 => InputDelivery::NotDispatched,
            1 => InputDelivery::Acknowledged,
            _ => InputDelivery::Uncertain,
        }
    }

    pub(crate) fn record_input_delivery(&self, delivery: InputDelivery) {
        let progress = match delivery {
            InputDelivery::NotDispatched => 0,
            InputDelivery::Acknowledged => 1,
            InputDelivery::Uncertain => 2,
        };
        self.input_delivery.fetch_max(progress, Ordering::Relaxed);
    }

    pub fn check(&self) -> Result<(), ErrorRecord> {
        if *self.cancellation.borrow() {
            Err(self.error(ErrorCode::Cancelled))
        } else if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Err(self.error(ErrorCode::Timeout))
        } else {
            Ok(())
        }
    }

    /// A renderer guard suppresses work queued behind a blocked event loop. The host's
    /// monotonic deadline remains authoritative; this wall-clock value only bounds late dispatch.
    pub(crate) fn renderer_deadline(&self) -> Option<u64> {
        self.deadline.map(|deadline| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            (now + deadline.saturating_duration_since(Instant::now()))
                .as_millis()
                .min(u64::MAX as u128) as u64
        })
    }

    fn error(&self, code: ErrorCode) -> ErrorRecord {
        let message = if code == ErrorCode::Cancelled {
            "operation cancelled"
        } else {
            "operation deadline exceeded"
        };
        let mut error = ErrorRecord::new(code, &self.method, message);
        error.input_delivery = self.input_delivery();
        error
    }

    pub async fn cancelled(&self) -> ErrorRecord {
        if let Err(error) = self.check() {
            return error;
        }
        let mut cancellation = self.cancellation.clone();
        let deadline = async {
            match self.deadline {
                Some(deadline) => sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            _ = cancellation.wait_for(|cancelled| *cancelled) => self.error(ErrorCode::Cancelled),
            _ = deadline => self.error(ErrorCode::Timeout),
        }
    }

    pub async fn wait<T>(
        &self,
        work: impl Future<Output = Result<T, ErrorRecord>>,
    ) -> Result<T, ErrorRecord> {
        self.check()?;
        tokio::select! {
            biased;
            error = self.cancelled() => Err(error),
            result = work => result,
        }
    }

    /// Withdraw queued filesystem work on expiry or waiter loss; started work retains its owners.
    pub(crate) async fn wait_blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T, ErrorRecord> + Send + 'static,
    ) -> Result<T, ErrorRecord> {
        self.check()?;
        let dispatch = Self::new(
            self.method.clone(),
            self.deadline,
            self.cancellation.clone(),
        );
        let mut task = BlockingOperation(tokio::task::spawn_blocking(move || {
            dispatch.check()?;
            work()
        }));
        self.wait(async {
            (&mut task.0).await.map_err(|error| {
                ErrorRecord::new(ErrorCode::Protocol, &self.method, error.to_string())
            })?
        })
        .await
    }

    /// A cancelled allocation still consumes its reply so the new resource can be disposed.
    /// If ownership cannot be recovered in bounded time, terminate this owned browser.
    pub(crate) async fn allocate(
        &self,
        owner: &impl ResourceOwner,
        method: &str,
        parameters: Value,
        kind: ResourceKind,
    ) -> Result<String, ErrorRecord> {
        self.allocate_while_owner_alive(owner, method, parameters, kind, std::future::pending())
            .await
    }

    /// Original-owner closure keeps the same late-reply custody as cancellation.
    pub(crate) async fn allocate_while_owner_alive(
        &self,
        owner: &impl ResourceOwner,
        method: &str,
        parameters: Value,
        kind: ResourceKind,
        owner_closed: impl Future<Output = ErrorRecord>,
    ) -> Result<String, ErrorRecord> {
        self.check()?;
        let mut request = owner.connection().start_command(method, parameters, None)?;
        let interrupted = async {
            tokio::select! {
                biased;
                error = self.cancelled() => error,
                error = owner_closed => error,
            }
        };
        let result = tokio::select! {
            biased;
            mut error = interrupted => {
                if request.prevent_dispatch() {
                    error.cleanup = Some("notDispatched".into());
                    return Err(error);
                }
                let cleanup = match timeout(CLEANUP_STEP_BUDGET, request.response()).await {
                    Ok(Ok(result)) => match result.get(kind.identifier_field()).and_then(Value::as_str) {
                        Some(identifier) => dispose(owner, kind, identifier).await,
                        None => close_for_cleanup(owner, "browserClosedAfterUnknownAllocation").await,
                    },
                    Ok(Err(rejection)) if rejection.browser_error_code.is_some() => "allocationRejected",
                    // A lost/malformed reply does not prove that allocation had no effect.
                    _ => close_for_cleanup(owner, "browserClosedAfterUnknownAllocation").await,
                };
                error.cleanup = Some(cleanup.into());
                return Err(error);
            },
            result = request.response() => result,
        };
        let result = match result {
            Ok(result) => result,
            Err(error) if error.browser_error_code.is_some() => return Err(error),
            Err(mut error) => {
                error.cleanup = Some(
                    close_for_cleanup(owner, "browserClosedAfterUnknownAllocation")
                        .await
                        .into(),
                );
                return Err(error);
            }
        };
        match result.get(kind.identifier_field()).and_then(Value::as_str) {
            Some(identifier) => Ok(identifier.to_owned()),
            None => {
                let cleanup = close_for_cleanup(owner, "browserClosedAfterUnknownAllocation").await;
                let mut error = ErrorRecord::new(
                    ErrorCode::Protocol,
                    &self.method,
                    "Chromium omitted the allocated resource identity",
                );
                error.cleanup = Some(cleanup.into());
                Err(error)
            }
        }
    }
}

/// Tokio cannot stop a running blocking closure, but abort removes work that is still queued.
struct BlockingOperation<T>(tokio::task::JoinHandle<T>);

impl<T> Drop for BlockingOperation<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) async fn close_for_cleanup(
    owner: &impl ResourceOwner,
    success: &'static str,
) -> &'static str {
    match owner.close().await {
        Ok(()) => success,
        Err(error) if error.cleanup.as_deref() == Some("guardianContinuingCleanup") => {
            "guardianContinuingCleanup"
        }
        Err(error) => {
            eprintln!("flashwright cleanup: {}", error.message);
            "guardianCleanupFailed"
        }
    }
}

pub(crate) async fn dispose(
    owner: &impl ResourceOwner,
    kind: ResourceKind,
    identifier: &str,
) -> &'static str {
    let result = timeout(
        CLEANUP_STEP_BUDGET,
        owner.connection().call(
            kind.dispose_method(),
            json!({ kind.identifier_field(): identifier }),
            None,
        ),
    )
    .await;
    match result {
        Ok(Ok(_)) => "resourceDisposed",
        _ => confirm_disposal(owner, kind, identifier).await,
    }
}

/// A lost reply does not authorize replay; confirm absence or close the owned browser.
async fn confirm_disposal(
    owner: &impl ResourceOwner,
    kind: ResourceKind,
    identifier: &str,
) -> &'static str {
    let (method, collection) = match kind {
        ResourceKind::Context => ("Target.getBrowserContexts", "browserContextIds"),
        ResourceKind::Page => ("Target.getTargets", "targetInfos"),
    };
    let confirmation = timeout(
        CLEANUP_STEP_BUDGET,
        owner.connection().call(method, json!({}), None),
    )
    .await;
    if let Ok(Ok(confirmation)) = confirmation
        && let Some(resources) = confirmation[collection].as_array()
        && !resources.iter().any(|resource| match kind {
            ResourceKind::Context => resource.as_str() == Some(identifier),
            ResourceKind::Page => resource["targetId"].as_str() == Some(identifier),
        })
    {
        return "resourceAlreadyDisposed";
    }
    close_for_cleanup(owner, "browserClosedAfterDisposalFailure").await
}

/// An ordinary close waits for Chromium's acknowledgement without an implicit
/// cancellation budget. Only protocol failure enters bounded ownership recovery.
pub(crate) async fn close_resource(
    owner: &impl ResourceOwner,
    kind: ResourceKind,
    identifier: &str,
) -> &'static str {
    if owner
        .connection()
        .call(
            kind.dispose_method(),
            json!({ kind.identifier_field(): identifier }),
            None,
        )
        .await
        .is_err()
    {
        dispose(owner, kind, identifier).await
    } else {
        "resourceDisposed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tokio::io::{
        AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf, duplex, split,
    };

    #[tokio::test]
    async fn diagnostic_allowance_caps_unbounded_work_and_preserves_cancellation() {
        let (sender, cancellation) = watch::channel(false);
        let original = Operation::new("diagnostics.pageSnapshot".into(), None, cancellation);
        let before = Instant::now();
        let bounded = original.bounded_diagnostic(Duration::from_secs(5));
        assert!(bounded.deadline.unwrap() >= before + Duration::from_secs(5));
        assert!(bounded.deadline.unwrap() <= Instant::now() + Duration::from_secs(5));
        sender.send_replace(true);
        assert!(bounded.check().is_err());

        let (_, cancellation) = watch::channel(false);
        let deadline = Instant::now() + Duration::from_millis(10);
        let original = Operation::new(
            "diagnostics.pageSnapshot".into(),
            Some(deadline),
            cancellation,
        );
        assert_eq!(
            original.bounded_diagnostic(Duration::from_secs(5)).deadline,
            Some(deadline)
        );
    }

    #[test]
    fn queued_blocking_work_withdraws_on_deadline_cancellation_and_waiter_loss() {
        for reason in ["deadline", "cancellation", "waiter-loss"] {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .max_blocking_threads(1)
                .build()
                .unwrap();
            runtime.block_on(async {
                let (release, blocked) = std::sync::mpsc::channel();
                let (started, ready) = tokio::sync::oneshot::channel();
                let blocker = tokio::task::spawn_blocking(move || {
                    started.send(()).unwrap();
                    let _ = blocked.recv();
                });
                ready.await.unwrap();
                let (cancellation, receiver) = watch::channel(false);
                let deadline =
                    (reason == "deadline").then(|| Instant::now() + Duration::from_millis(20));
                let operation = Operation::new("download.saveAs".into(), deadline, receiver);
                let ran = Arc::new(AtomicBool::new(false));
                let job_ran = ran.clone();
                let mut pending = Box::pin(operation.wait_blocking(move || {
                    job_ran.store(true, Ordering::SeqCst);
                    Ok(())
                }));
                std::future::poll_fn(|context| {
                    assert!(pending.as_mut().poll(context).is_pending());
                    std::task::Poll::Ready(())
                })
                .await;
                match reason {
                    "deadline" => assert_eq!(pending.await.unwrap_err().code, ErrorCode::Timeout),
                    "cancellation" => {
                        cancellation.send(true).unwrap();
                        assert_eq!(pending.await.unwrap_err().code, ErrorCode::Cancelled);
                    }
                    _ => drop(pending),
                }
                release.send(()).unwrap();
                blocker.await.unwrap();
                tokio::task::spawn_blocking(|| ()).await.unwrap();
                assert!(
                    !ran.load(Ordering::SeqCst),
                    "queued work ran after {reason}"
                );
            });
        }
    }

    struct Owner {
        connection: Connection,
        closed: AtomicBool,
    }
    impl ResourceOwner for Owner {
        fn connection(&self) -> &Connection {
            &self.connection
        }
        async fn close(&self) -> Result<(), ErrorRecord> {
            self.closed.store(true, Ordering::SeqCst);
            self.connection.close();
            Ok(())
        }
    }
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
            let mut bytes =
                serde_json::to_vec(&json!({ "id": command["id"], "result": result })).unwrap();
            bytes.push(0);
            self.writer.write_all(&bytes).await.unwrap();
        }
    }
    fn setup() -> (Arc<Owner>, Peer, watch::Sender<bool>, Operation) {
        let (host, peer) = duplex(4096);
        let (reader, writer) = split(host);
        let owner = Arc::new(Owner {
            connection: Connection::new(reader, writer),
            closed: AtomicBool::new(false),
        });
        let (reader, writer) = split(peer);
        let peer = Peer {
            reader: BufReader::new(reader),
            writer,
        };
        let (sender, receiver) = watch::channel(false);
        let operation = Operation::new("context.newPage".to_owned(), None, receiver);
        (owner, peer, sender, operation)
    }

    #[tokio::test]
    async fn page_detachment_cleanup_shares_pending_and_completed_close() {
        for ordinary_close in [false, true] {
            let (owner, mut peer, _cancellation, _operation) = setup();
            let disposal = Arc::new(PageDisposal::default());
            let original_owner = owner.clone();
            let original_disposal = disposal.clone();
            let original = tokio::spawn(async move {
                if ordinary_close {
                    original_disposal
                        .close(original_owner.as_ref(), "original-page")
                        .await;
                } else {
                    assert_eq!(
                        original_disposal
                            .dispose(original_owner.as_ref(), "original-page")
                            .await,
                        "resourceDisposed"
                    );
                }
            });
            let command = peer.command().await;
            assert_eq!(command["method"], "Target.closeTarget");
            assert_eq!(command["params"]["targetId"], "original-page");
            let detached_owner = owner.clone();
            let detached_disposal = disposal.clone();
            let detached = tokio::spawn(async move {
                detached_disposal
                    .dispose(detached_owner.as_ref(), "original-page")
                    .await
            });
            assert!(
                timeout(Duration::from_millis(25), peer.command())
                    .await
                    .is_err()
            );
            assert!(
                !detached.is_finished(),
                "detachment cleanup must await the original close"
            );
            peer.reply(&command, json!({ "success": true })).await;
            original.await.unwrap();
            assert_eq!(detached.await.unwrap(), "resourceDisposed");
            assert_eq!(
                disposal.dispose(owner.as_ref(), "original-page").await,
                "resourceDisposed"
            );
            disposal.close(owner.as_ref(), "original-page").await;
            assert!(
                timeout(Duration::from_millis(25), peer.command())
                    .await
                    .is_err()
            );
            assert!(!owner.closed.load(Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn cancelled_private_page_close_retains_original_reply_for_cleanup() {
        for acknowledge_late in [true, false] {
            let (owner, mut peer, cancellation, operation) = setup();
            let disposal = Arc::new(PageDisposal::default());
            let closing_owner = owner.clone();
            let closing_disposal = disposal.clone();
            let closing = tokio::spawn(async move {
                operation
                    .wait(async {
                        closing_disposal
                            .close(closing_owner.as_ref(), "storage-page")
                            .await;
                        Ok(())
                    })
                    .await
            });
            let command = peer.command().await;
            assert_eq!(command["method"], "Target.closeTarget");
            cancellation.send(true).unwrap();
            assert_eq!(
                closing.await.unwrap().unwrap_err().code,
                ErrorCode::Cancelled
            );
            let recovery_owner = owner.clone();
            let recovery_disposal = disposal.clone();
            let recovery = tokio::spawn(async move {
                recovery_disposal
                    .dispose(recovery_owner.as_ref(), "storage-page")
                    .await
            });
            if acknowledge_late {
                peer.reply(&command, json!({"success":true})).await;
            } else {
                let confirmation = peer.command().await;
                assert_eq!(
                    confirmation["method"], "Target.getTargets",
                    "cancelled close must not be replayed"
                );
                peer.reply(
                    &confirmation,
                    json!({"targetInfos":[{"targetId":"storage-page"}]}),
                )
                .await;
            }
            assert_eq!(
                timeout(Duration::from_secs(1), recovery)
                    .await
                    .unwrap()
                    .unwrap(),
                if acknowledge_late {
                    "resourceDisposed"
                } else {
                    "browserClosedAfterDisposalFailure"
                }
            );
            assert_eq!(owner.closed.load(Ordering::SeqCst), !acknowledge_late);
            if acknowledge_late {
                assert!(
                    timeout(Duration::from_millis(25), peer.command())
                        .await
                        .is_err()
                );
            }
        }
    }

    #[tokio::test]
    async fn recovery_bounds_a_stalled_ordinary_page_close_without_replaying_it() {
        let (owner, mut peer, _cancellation, _operation) = setup();
        let disposal = Arc::new(PageDisposal::default());
        let closing_owner = owner.clone();
        let closing_disposal = disposal.clone();
        let closing = tokio::spawn(async move {
            closing_disposal
                .close(closing_owner.as_ref(), "original-page")
                .await;
        });
        let command = peer.command().await;
        assert_eq!(command["method"], "Target.closeTarget");
        tokio::time::sleep(Duration::from_millis(750)).await;
        assert!(
            !closing.is_finished(),
            "ordinary close must retain its unbounded acknowledgement wait"
        );
        assert!(!owner.closed.load(Ordering::SeqCst));
        let recovery_owner = owner.clone();
        let recovery_disposal = disposal.clone();
        let recovery = tokio::spawn(async move {
            recovery_disposal
                .dispose(recovery_owner.as_ref(), "original-page")
                .await
        });
        let confirmation = peer.command().await;
        assert_eq!(
            confirmation["method"], "Target.getTargets",
            "recovery must not replay the pending close"
        );
        peer.reply(
            &confirmation,
            json!({"targetInfos":[{"targetId":"original-page"}]}),
        )
        .await;
        assert_eq!(
            timeout(Duration::from_secs(1), recovery)
                .await
                .unwrap()
                .unwrap(),
            "browserClosedAfterDisposalFailure"
        );
        timeout(Duration::from_secs(1), closing)
            .await
            .unwrap()
            .unwrap();
        assert!(owner.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn page_cleanup_preserves_disposal_failure_and_guardian_fallback_for_all_waiters() {
        let (owner, mut peer, _cancellation, _operation) = setup();
        let disposal = Arc::new(PageDisposal::default());
        let original_owner = owner.clone();
        let original_disposal = disposal.clone();
        let original = tokio::spawn(async move {
            original_disposal
                .dispose(original_owner.as_ref(), "original-page")
                .await
        });
        let command = peer.command().await;
        peer.writer
            .write_all(
                format!(
                    "{}\0",
                    json!({"id":command["id"],"error":{"code":-32000,"message":"close rejected"}})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let confirmation = peer.command().await;
        assert_eq!(confirmation["method"], "Target.getTargets");
        peer.reply(
            &confirmation,
            json!({"targetInfos":[{"targetId":"original-page"}]}),
        )
        .await;
        assert_eq!(original.await.unwrap(), "browserClosedAfterDisposalFailure");
        assert!(owner.closed.load(Ordering::SeqCst));
        assert_eq!(
            disposal.dispose(owner.as_ref(), "original-page").await,
            "browserClosedAfterDisposalFailure"
        );
    }

    #[tokio::test]
    async fn original_context_closure_preserves_late_allocation_custody() {
        for outcome in ["allocated", "rejected", "withheld"] {
            let (owner, mut peer, _cancellation, operation) = setup();
            let state = Arc::new(crate::context_state::ContextState::default());
            let original_state = state.clone();
            let original_owner = owner.clone();
            let allocation = tokio::spawn(async move {
                operation
                    .allocate_while_owner_alive(
                        original_owner.as_ref(),
                        "Target.createTarget",
                        json!({}),
                        ResourceKind::Page,
                        original_state.closure("context.newPage"),
                    )
                    .await
            });
            let creation = peer.command().await;
            state.closed.send_replace(Some(crate::closed("context")));
            assert!(!allocation.is_finished());
            match outcome {
                "allocated" => {
                    peer.reply(&creation, json!({"targetId":"late-original-page"}))
                        .await;
                    let disposal = peer.command().await;
                    assert_eq!(disposal["method"], "Target.closeTarget");
                    assert_eq!(disposal["params"]["targetId"], "late-original-page");
                    assert!(!allocation.is_finished());
                    peer.reply(&disposal, json!({"success":true})).await;
                }
                "rejected" => {
                    peer.writer.write_all(format!("{}\0", json!({"id":creation["id"],"error":{"code":-32602,"message":"browserContextId"}})).as_bytes()).await.unwrap();
                }
                _ => {}
            }
            let error = timeout(Duration::from_secs(2), allocation)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::TargetClosed);
            assert_eq!(error.method.as_ref(), "context.newPage");
            assert_eq!(
                error.cleanup.as_deref(),
                Some(match outcome {
                    "allocated" => "resourceDisposed",
                    "rejected" => "allocationRejected",
                    _ => "browserClosedAfterUnknownAllocation",
                })
            );
            assert_eq!(owner.closed.load(Ordering::SeqCst), outcome == "withheld");
        }
    }

    #[tokio::test]
    async fn cancellation_recovers_late_allocation_then_waits_for_disposal() {
        let (owner, mut peer, cancellation, operation) = setup();
        let task_owner = owner.clone();
        let allocation = tokio::spawn(async move {
            operation
                .allocate(
                    task_owner.as_ref(),
                    "Target.createTarget",
                    json!({}),
                    ResourceKind::Page,
                )
                .await
        });
        let creation = peer.command().await;
        cancellation.send(true).unwrap();
        assert!(!allocation.is_finished());
        peer.reply(&creation, json!({ "targetId": "new-page" }))
            .await;
        let disposal = peer.command().await;
        assert_eq!(disposal["method"], "Target.closeTarget");
        assert_eq!(disposal["params"]["targetId"], "new-page");
        assert!(
            !allocation.is_finished(),
            "cancellation must await cleanup acknowledgement"
        );
        peer.reply(&disposal, json!({ "success": true })).await;
        let error = allocation.await.unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.cleanup.as_deref(), Some("resourceDisposed"));
        assert!(!owner.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancellation_with_unknown_allocation_closes_only_its_owner() {
        let (owner, mut peer, cancellation, operation) = setup();
        let task_owner = owner.clone();
        let allocation = tokio::spawn(async move {
            operation
                .allocate(
                    task_owner.as_ref(),
                    "Target.createTarget",
                    json!({}),
                    ResourceKind::Page,
                )
                .await
        });
        let _creation = peer.command().await;
        cancellation.send(true).unwrap();
        let error = timeout(Duration::from_secs(2), allocation)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(
            error.cleanup.as_deref(),
            Some("browserClosedAfterUnknownAllocation")
        );
        assert!(owner.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn already_cancelled_creation_dispatches_nothing() {
        let (owner, mut peer, cancellation, operation) = setup();
        cancellation.send(true).unwrap();
        let error = operation
            .allocate(
                owner.as_ref(),
                "Target.createTarget",
                json!({}),
                ResourceKind::Page,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(
            timeout(Duration::from_millis(20), peer.command())
                .await
                .is_err()
        );
        assert!(!owner.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn queued_creation_is_withdrawn_without_waiting_for_a_reply() {
        let (owner, mut peer, cancellation, operation) = setup();
        // Fill the stream with an earlier command, leaving allocation queued behind it.
        let mut blocking = owner
            .connection
            .start_command("large", json!({ "data": "x".repeat(16000) }), None)
            .unwrap();
        tokio::task::yield_now().await;
        let task_owner = owner.clone();
        let allocation = tokio::spawn(async move {
            operation
                .allocate(
                    task_owner.as_ref(),
                    "Target.createTarget",
                    json!({}),
                    ResourceKind::Page,
                )
                .await
        });
        tokio::task::yield_now().await;
        cancellation.send(true).unwrap();
        let error = timeout(Duration::from_secs(1), allocation)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.cleanup.as_deref(), Some("notDispatched"));
        let earlier = peer.command().await;
        peer.reply(&earlier, json!({})).await;
        blocking.response().await.unwrap();
        assert!(
            timeout(Duration::from_millis(20), peer.command())
                .await
                .is_err()
        );
        assert!(!owner.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn ordinary_close_waits_for_acknowledgement_without_cleanup_deadline() {
        let (owner, mut peer, _cancellation, _operation) = setup();
        let task_owner = owner.clone();
        let closing = tokio::spawn(async move {
            close_resource(task_owner.as_ref(), ResourceKind::Context, "slow-context").await;
        });
        let command = peer.command().await;
        assert_eq!(command["method"], "Target.disposeBrowserContext");
        tokio::time::sleep(Duration::from_millis(750)).await;
        assert!(!closing.is_finished());
        assert!(!owner.closed.load(Ordering::SeqCst));
        assert!(
            timeout(Duration::from_millis(20), peer.command())
                .await
                .is_err(),
            "ordinary close must not start cancellation recovery merely because the acknowledgement is slow"
        );
        peer.reply(&command, json!({})).await;
        closing.await.unwrap();
        assert!(!owner.closed.load(Ordering::SeqCst));
    }
}
