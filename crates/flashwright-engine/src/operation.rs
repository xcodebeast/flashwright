//! Cooperative cancellation keeps allocation replies alive until ownership is resolved.

use std::future::Future;
use std::sync::atomic::{AtomicU8, Ordering};

use flashwright_browser::{Chromium, Connection};
use flashwright_protocol::{ErrorCode, ErrorRecord, InputDelivery};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::{Duration, Instant, sleep_until, timeout};

const CLEANUP_STEP_BUDGET: Duration = Duration::from_millis(500);

pub struct Operation {
    method: String,
    deadline: Option<Instant>,
    cancellation: watch::Receiver<bool>,
    input_delivery: AtomicU8,
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
        }
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

    /// A cancelled allocation still consumes its reply so the new resource can be disposed.
    /// If ownership cannot be recovered in bounded time, terminate this owned browser.
    pub(crate) async fn allocate(
        &self,
        owner: &impl ResourceOwner,
        method: &str,
        parameters: Value,
        kind: ResourceKind,
    ) -> Result<String, ErrorRecord> {
        self.check()?;
        let mut request = owner.connection().start_command(method, parameters, None)?;
        let result = tokio::select! {
            biased;
            mut error = self.cancelled() => {
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
        _ => {
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
    }
}

/// An ordinary close waits for Chromium's acknowledgement without an implicit
/// cancellation budget. Only protocol failure enters bounded ownership recovery.
pub(crate) async fn close_resource(
    owner: &impl ResourceOwner,
    kind: ResourceKind,
    identifier: &str,
) {
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
        dispose(owner, kind, identifier).await;
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
