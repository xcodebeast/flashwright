//! Diagnostic work owns its command independently of host waits and public request history.

use super::*;
use crate::diagnostic_sessions::{SessionFailure, SessionLifetime};
use crate::{Context, Engine, Page};
use flashwright_browser::Connection;
use flashwright_protocol::BinaryPayload;
use resources::{MAXIMUM_RESOURCE_BYTES, ResourceBudget, ResourceReservation};

pub(crate) struct BodyJob {
    pub(super) occurrence: Occurrence,
    pub(super) identifier: String,
    pub(super) work: BodyWork,
    pub(super) guard: BodyGuard,
}

struct OriginalBody {
    connection: Connection,
    session: String,
    lifetime: SessionLifetime,
    resources: ResourceBudget,
    engine: Arc<NetworkBudget>,
    closed: watch::Receiver<bool>,
}

pub(super) enum CapturedBody {
    Bytes(BinaryPayload, ResourceReservation),
    Unavailable(BodyUnavailable),
}

async fn closed(recording: &mut watch::Receiver<bool>) {
    loop {
        if *recording.borrow() {
            return;
        }
        if recording.changed().await.is_err() {
            return;
        }
    }
}

async fn destroyed(session: &mut watch::Receiver<bool>) {
    loop {
        if *session.borrow() {
            return;
        }
        if session.changed().await.is_err() {
            std::future::pending::<()>().await
        }
    }
}

async fn unavailable(guard: &mut watch::Receiver<Option<BodyUnavailable>>) -> BodyUnavailable {
    loop {
        if let Some(reason) = *guard.borrow() {
            return reason;
        }
        if guard.changed().await.is_err() {
            std::future::pending::<()>().await
        }
    }
}

impl OriginalBody {
    async fn capture(mut self, job: &BodyJob) -> Result<CapturedBody, JournalError> {
        let mut session = self.lifetime.destruction();
        let mut identity = job.guard.changes();
        let (mut reservation, _worker) = tokio::select! {
            biased;
            _ = closed(&mut self.closed) => return Ok(CapturedBody::Unavailable(BodyUnavailable::RecordingStopped)),
            reason = unavailable(&mut identity) => return Ok(CapturedBody::Unavailable(reason)),
            _ = destroyed(&mut session) => return Ok(CapturedBody::Unavailable(BodyUnavailable::OriginalPageClosed)),
            permits = async {
                let worker = self.engine.workers.clone().acquire_owned().await.map_err(|_| JournalError::Protocol("network worker allowance closed"))?;
                let reservation = self.resources.reserve_response().await?;
                Ok::<_,JournalError>((reservation,worker))
            } => permits?,
        };
        if let Some(reason) = job.guard.unavailable() {
            return Ok(CapturedBody::Unavailable(reason));
        }
        let mut command = self
            .connection
            .start_response_body(&job.identifier, &self.session, MAXIMUM_RESOURCE_BYTES)
            .map_err(|_| JournalError::Protocol("could not admit original body command"))?;
        let reply = tokio::select! {
            biased;
            _ = destroyed(&mut session) => return Ok(CapturedBody::Unavailable(BodyUnavailable::OriginalPageClosed)),
            _ = closed(&mut self.closed) => {
                if command.prevent_dispatch() { return Ok(CapturedBody::Unavailable(BodyUnavailable::RecordingStopped)) }
                tokio::select! {
                    biased;
                    _ = destroyed(&mut session) => return Ok(CapturedBody::Unavailable(BodyUnavailable::OriginalPageClosed)),
                    reply = command.response() => reply,
                }
            },
            reason = unavailable(&mut identity) => {
                if command.prevent_dispatch() { return Ok(CapturedBody::Unavailable(reason)) }
                tokio::select! {
                    biased;
                    _ = destroyed(&mut session) => return Ok(CapturedBody::Unavailable(BodyUnavailable::OriginalPageClosed)),
                    reply = command.response() => reply,
                }
            },
            reply = command.response() => reply,
        };
        if !command.browser_reply_received() {
            // A transport rejection is not a reply receipt, even when the command future completed.
            destroyed(&mut session).await;
            return Ok(CapturedBody::Unavailable(
                BodyUnavailable::OriginalPageClosed,
            ));
        }
        if let Some(reason) = job.guard.unavailable() {
            return Ok(CapturedBody::Unavailable(reason));
        }
        if *self.closed.borrow() {
            return Ok(CapturedBody::Unavailable(BodyUnavailable::RecordingStopped));
        }
        match reply {
            Ok(payload) => {
                reservation.shrink_to(payload.bytes.len());
                Ok(CapturedBody::Bytes(payload, reservation))
            }
            Err(error)
                if error.browser_error_code == Some(-32000)
                    && [
                        "No resource with given identifier found",
                        "No data found for resource with given identifier",
                        "Request content was evicted from inspector cache",
                    ]
                    .iter()
                    .any(|message| error.message.contains(message)) =>
            {
                Ok(CapturedBody::Unavailable(
                    BodyUnavailable::BrowserResourceMissing,
                ))
            }
            Err(error) if error.code == ErrorCode::ResourceLimit => Err(
                JournalError::ResourceLimit("original response body exceeds its admitted limit"),
            ),
            Err(_) => Err(JournalError::Protocol(
                "original response body command failed",
            )),
        }
    }
}

impl Engine {
    /// Register exact session custody after releasing page/recording locks, then spawn bounded admitted work.
    pub(crate) fn dispatch_recording_bodies(
        self: &Arc<Self>,
        context: &Context,
        page: &Page,
        jobs: Vec<BodyJob>,
    ) {
        for job in jobs {
            let prepared = self.prepare_original_body(context, page, &job.occurrence.page);
            let state = context.state.clone();
            let recording = {
                let owner = state.recording.lock().unwrap();
                owner
                    .recording
                    .as_ref()
                    .map(|recording| recording.identifier.clone())
            };
            let Some(recording) = recording else { continue };
            tokio::spawn(async move {
                let outcome = match prepared {
                    Ok(original) => original.capture(&job).await,
                    Err(SessionFailure::Unavailable) => Ok(CapturedBody::Unavailable(
                        BodyUnavailable::OriginalPageClosed,
                    )),
                    Err(SessionFailure::Failed(_)) => Err(JournalError::Protocol(
                        "could not retain original response session",
                    )),
                };
                let mut owner = state.recording.lock().unwrap();
                let Ok(recording) = owner.get_mut(&recording) else {
                    return;
                };
                let Some(network) = recording.network.as_mut() else {
                    return;
                };
                network.owners.settled(&job.identifier, &job.guard);
                if network.journal.failure().is_some() {
                    return;
                }
                let outcome = outcome
                    .and_then(|outcome| match outcome {
                        CapturedBody::Bytes(payload, reservation) => network
                            .resources
                            .accept(payload, reservation, false)
                            .map(|resource| BodyOutcome::Resource {
                                token: resource.token,
                                byte_length: resource.byte_length,
                            }),
                        CapturedBody::Unavailable(reason) => {
                            Ok(BodyOutcome::Unavailable { reason })
                        }
                    })
                    .and_then(|outcome| {
                        network
                            .journal
                            .finish_body(&job.occurrence, job.work, outcome)
                    });
                if let Err(error) = outcome {
                    recording.fail(recording_error(error));
                }
            });
        }
    }

    fn prepare_original_body(
        &self,
        context: &Context,
        page: &Page,
        identifier: &str,
    ) -> Result<OriginalBody, SessionFailure> {
        let lifetime = self.network_diagnostic_session(identifier, page)?;
        let connection = self
            .browser(&context.browser_identifier, "tracing.network")?
            .connection
            .clone();
        let mut owner = context.state.recording.lock().unwrap();
        let network = owner
            .active_mut()
            .and_then(|recording| recording.network.as_ref())
            .ok_or(SessionFailure::Unavailable)?;
        Ok(OriginalBody {
            connection,
            session: page.session_identifier.clone(),
            lifetime,
            resources: network.resources.budget(),
            engine: network.engine.clone(),
            closed: network.closed.subscribe(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{
        AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, duplex, split,
    };
    use tokio::time::{Duration, timeout};

    fn fixture() -> (
        NetworkRecording,
        OriginalBody,
        BodyJob,
        DuplexStream,
        watch::Sender<bool>,
    ) {
        let budget = Arc::new(NetworkBudget::default());
        let mut network = NetworkRecording::new(Instant::now(), budget.clone());
        let occurrence = Occurrence {
            page: "page".into(),
            identity: "original:1".into(),
        };
        network
            .journal
            .create(occurrence.clone(), &json!({}))
            .unwrap();
        let work = network
            .journal
            .complete(&occurrence, true)
            .unwrap()
            .unwrap();
        let guard = network.owners.admit(&occurrence, "original").unwrap();
        let (host, peer) = duplex(4096);
        let (reader, writer) = split(host);
        let destruction = watch::channel(false).0;
        let original = OriginalBody {
            connection: Connection::new(reader, writer),
            session: "session".into(),
            lifetime: SessionLifetime::controlled("target", "session", destruction.clone()),
            resources: network.resources.budget(),
            engine: budget,
            closed: network.closed.subscribe(),
        };
        let job = BodyJob {
            occurrence,
            identifier: "original".into(),
            work,
            guard,
        };
        (network, original, job, peer, destruction)
    }

    async fn command(reader: &mut BufReader<ReadHalf<DuplexStream>>) -> Value {
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(2), reader.read_until(0, &mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bytes.pop(), Some(0));
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn recording_failure_retains_dispatched_worker_and_bytes_until_its_reply() {
        let (mut network, original, job, peer, _destruction) = fixture();
        let (reader, mut writer) = split(peer);
        let mut reader = BufReader::new(reader);
        let mut task = tokio::spawn(async move { original.capture(&job).await });
        let request = command(&mut reader).await;
        assert_eq!(request["params"]["requestId"], "original");
        network.fail(JournalError::Protocol("controlled host cancellation"));
        assert!(network.pending());
        assert_eq!(network.engine.workers.available_permits(), 1);
        assert!(timeout(Duration::from_millis(10), &mut task).await.is_err());
        let mut bytes = serde_json::to_vec(
            &json!({"id":request["id"],"result":{"body":"original bytes","base64Encoded":false}}),
        )
        .unwrap();
        bytes.push(0);
        writer.write_all(&bytes).await.unwrap();
        assert!(matches!(
            task.await.unwrap().unwrap(),
            CapturedBody::Unavailable(BodyUnavailable::RecordingStopped)
        ));
        assert!(!network.pending());
        assert_eq!(network.engine.workers.available_permits(), 2);
    }

    #[tokio::test]
    async fn lost_connection_requires_exact_session_proof_before_releasing_custody() {
        let (network, original, job, peer, destruction) = fixture();
        let (reader, writer) = split(peer);
        let mut reader = BufReader::new(reader);
        let mut task = tokio::spawn(async move { original.capture(&job).await });
        command(&mut reader).await;
        drop(reader);
        drop(writer);
        assert!(timeout(Duration::from_millis(20), &mut task).await.is_err());
        assert!(network.pending());
        assert_eq!(network.engine.workers.available_permits(), 1);
        destruction.send_replace(true);
        assert!(matches!(
            task.await.unwrap().unwrap(),
            CapturedBody::Unavailable(BodyUnavailable::OriginalPageClosed)
        ));
        assert!(!network.pending());
        assert_eq!(network.engine.workers.available_permits(), 2);
    }

    #[tokio::test]
    async fn browser_identifier_reuse_suppresses_late_successor_bytes_without_canceling_original_work()
     {
        let (mut network, original, job, peer, _destruction) = fixture();
        let (reader, mut writer) = split(peer);
        let mut reader = BufReader::new(reader);
        let mut task = tokio::spawn(async move { original.capture(&job).await });
        let request = command(&mut reader).await;
        network.owners.request_started("page", "original");
        assert!(timeout(Duration::from_millis(10), &mut task).await.is_err());
        let mut bytes = serde_json::to_vec(&json!({"id":request["id"],"result":{"body":"successor must not be published","base64Encoded":false}})).unwrap();
        bytes.push(0);
        writer.write_all(&bytes).await.unwrap();
        assert!(matches!(
            task.await.unwrap().unwrap(),
            CapturedBody::Unavailable(BodyUnavailable::OriginalRequestReplaced)
        ));
        assert!(!network.pending());
        assert!(network.resources.pull().is_empty());
    }

    #[tokio::test]
    async fn busy_workers_queue_original_work_and_close_withdraws_it_before_dispatch() {
        let (mut network, original, job, peer, _destruction) = fixture();
        let slots = network
            .engine
            .workers
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        let (reader, _writer) = split(peer);
        let mut reader = BufReader::new(reader);
        let mut task = tokio::spawn(async move { original.capture(&job).await });
        assert!(timeout(Duration::from_millis(10), &mut task).await.is_err());
        network.close();
        assert!(matches!(
            task.await.unwrap().unwrap(),
            CapturedBody::Unavailable(BodyUnavailable::RecordingStopped)
        ));
        drop(slots);
        assert!(!network.pending());
        let mut bytes = Vec::new();
        assert_eq!(reader.read_until(0, &mut bytes).await.unwrap(), 0);
        assert!(bytes.is_empty());
    }
}
