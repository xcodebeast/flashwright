use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use flashwright_protocol::{BinaryPayload, ErrorCode, ErrorRecord, InputAttachment};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::AbortHandle;

use crate::snapshot_reply::{SnapshotReply, SnapshotReplyAdmission};

pub mod fetch_body;
mod incoming;
use incoming::{BinaryReplyKind, ReplySender, read_messages};

const MAXIMUM_CONTROL_BYTES: usize = 8 * 1024 * 1024;
const MAXIMUM_PENDING: usize = 1024;
type Reply<Output = Value> = Result<Output, ErrorRecord>;
type EventHandler = Box<dyn Fn(Event) -> Result<(), ErrorRecord> + Send + Sync>;

#[derive(Clone)]
pub struct Connection {
    inner: Arc<ConnectionState>,
}

struct ConnectionState {
    next_identifier: AtomicU64,
    pending: Mutex<PendingReplies>,
    outgoing: mpsc::Sender<Vec<OutgoingCommand>>,
    events: broadcast::Sender<Event>,
    event_handler: Mutex<Option<EventHandler>>,
    received_event_sequence: AtomicU64,
    processed_event_sequence: watch::Sender<u64>,
    pumps: Mutex<Vec<AbortHandle>>,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub sequence: u64,
    pub received_at: std::time::Instant,
    pub method: String,
    pub session_identifier: Option<String>,
    pub parameters: Option<Box<RawValue>>,
}

#[derive(Default)]
struct PendingReplies {
    closed: Option<ErrorRecord>,
    replies: HashMap<u64, PendingReply>,
}

struct OutgoingCommand {
    identifier: u64,
    /// Complete control frame, or the JSON prefix of a typed input-body frame.
    bytes: Vec<u8>,
    input: Option<Arc<dyn fetch_body::FetchBodySource>>,
}

struct PendingReply {
    sender: ReplySender,
    dispatch_started: bool,
}

struct CommandReply<Output> {
    result: Reply<Output>,
    browser_reply_received: bool,
}

pub struct Command<Output = Value> {
    identifier: u64,
    state: Arc<ConnectionState>,
    receiver: oneshot::Receiver<CommandReply<Output>>,
    browser_reply_received: bool,
}

impl<Output> Command<Output> {
    pub async fn response(&mut self) -> Reply<Output> {
        let reply = (&mut self.receiver).await.map_err(|_| disconnected())?;
        self.browser_reply_received = reply.browser_reply_received;
        reply.result
    }

    /// Recover a reply already received when cancellation won the caller's wait.
    pub fn try_response(&mut self) -> Option<Reply<Output>> {
        match self.receiver.try_recv() {
            Ok(reply) => {
                self.browser_reply_received = reply.browser_reply_received;
                Some(reply.result)
            }
            Err(oneshot::error::TryRecvError::Empty) => None,
            Err(oneshot::error::TryRecvError::Closed) => Some(Err(disconnected())),
        }
    }

    /// A local transport failure ends the wait but does not prove browser completion.
    pub fn browser_reply_received(&self) -> bool {
        self.browser_reply_received
    }

    /// Atomically withdraw queued work before the writer starts any bytes.
    /// False means the caller must still consume the reply or close the owner.
    pub fn prevent_dispatch(&self) -> bool {
        let mut pending = self.state.pending.lock().unwrap();
        if pending
            .replies
            .get(&self.identifier)
            .is_some_and(|reply| !reply.dispatch_started)
        {
            pending.replies.remove(&self.identifier);
            true
        } else {
            false
        }
    }
}

impl<Output> Drop for Command<Output> {
    fn drop(&mut self) {
        self.state
            .pending
            .lock()
            .unwrap()
            .replies
            .remove(&self.identifier);
    }
}

impl Drop for ConnectionState {
    fn drop(&mut self) {
        for pump in self.pumps.get_mut().unwrap().drain(..) {
            pump.abort();
        }
    }
}

impl Connection {
    /// Reader and writer run independently, so a blocked renderer never blocks deadline processing.
    pub fn new<Reader, Writer>(reader: Reader, writer: Writer) -> Self
    where
        Reader: AsyncRead + Unpin + Send + 'static,
        Writer: AsyncWrite + Unpin + Send + 'static,
    {
        let (outgoing, receiver) = mpsc::channel(128);
        let (events, _) = broadcast::channel(512);
        let inner = Arc::new(ConnectionState {
            next_identifier: AtomicU64::new(1),
            pending: Mutex::new(PendingReplies::default()),
            outgoing,
            events,
            event_handler: Mutex::new(None),
            received_event_sequence: AtomicU64::new(0),
            processed_event_sequence: watch::channel(0).0,
            pumps: Mutex::new(Vec::new()),
        });
        let reader_task = tokio::spawn(read_messages(reader, Arc::downgrade(&inner)));
        let writer_task = tokio::spawn(write_messages(writer, receiver, Arc::downgrade(&inner)));
        inner
            .pumps
            .lock()
            .unwrap()
            .extend([reader_task.abort_handle(), writer_task.abort_handle()]);
        Self { inner }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }

    /// Owners retain the originating transport failure when invalidating their children.
    pub fn failure(&self) -> Option<ErrorRecord> {
        self.inner.pending.lock().unwrap().closed.clone()
    }

    /// Apply owned state in wire order, before replies can wake their callers. The
    /// handler must not block on protocol work or close the connection synchronously.
    pub fn observe_events(
        &self,
        handler: impl Fn(Event) -> Result<(), ErrorRecord> + Send + Sync + 'static,
    ) -> Result<(), ErrorRecord> {
        let mut observer = self.inner.event_handler.lock().unwrap();
        if let Some(error) = self.failure() {
            return Err(error);
        }
        if observer.is_some() {
            return Err(protocol_error(
                "browser event owner is already registered".into(),
            ));
        }
        *observer = Some(Box::new(handler));
        Ok(())
    }

    /// Wait for an event already being applied on another runtime worker. Event
    /// handlers run in the reader, so every event preceding a reply is already applied.
    pub async fn synchronize_events(&self) -> Result<(), ErrorRecord> {
        let sequence = self.inner.received_event_sequence.load(Ordering::Acquire);
        let mut processed = self.inner.processed_event_sequence.subscribe();
        loop {
            if let Some(error) = &self.inner.pending.lock().unwrap().closed {
                return Err(error.clone());
            }
            if *processed.borrow_and_update() >= sequence {
                return Ok(());
            }
            processed.changed().await.map_err(|_| disconnected())?;
        }
    }

    /// Dropping a call removes its pending reply and prevents queued, undispatched work from starting.
    pub async fn call(&self, method: &str, parameters: Value, session: Option<&str>) -> Reply {
        self.start_command(method, parameters, session)?
            .response()
            .await
    }

    /// Admit the response-body shape without allowing arbitrary large control values.
    pub async fn response_body(
        &self,
        request_identifier: &str,
        session: &str,
        maximum_decoded_bytes: usize,
    ) -> Reply<BinaryPayload> {
        self.start_response_body(request_identifier, session, maximum_decoded_bytes)?
            .response()
            .await
    }

    /// Diagnostic owners keep this command through caller cancellation until its original reply settles.
    pub fn start_response_body(
        &self,
        request_identifier: &str,
        session: &str,
        maximum_decoded_bytes: usize,
    ) -> Reply<Command<BinaryPayload>> {
        self.start_binary_reply(
            "Network.getResponseBody",
            json!({ "requestId": request_identifier }),
            session,
            BinaryReplyKind::ResponseBody,
            maximum_decoded_bytes,
        )
    }

    /// Capture data is admitted only as the fixed base64 screenshot result shape.
    pub async fn capture_screenshot(
        &self,
        parameters: Value,
        session: &str,
        maximum_decoded_bytes: usize,
    ) -> Reply<BinaryPayload> {
        self.start_binary_reply(
            "Page.captureScreenshot",
            parameters,
            session,
            BinaryReplyKind::Screenshot,
            maximum_decoded_bytes,
        )?
        .response()
        .await
    }

    fn start_binary_reply(
        &self,
        method: &str,
        parameters: Value,
        session: &str,
        kind: BinaryReplyKind,
        maximum_decoded_bytes: usize,
    ) -> Reply<Command<BinaryPayload>> {
        if maximum_decoded_bytes > flashwright_protocol::attachment::MAXIMUM_ATTACHMENT_BYTES {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "binary reply limit exceeds the supported attachment bound",
            ));
        }
        let identifier = self.inner.next_identifier.fetch_add(1, Ordering::Relaxed);
        let outgoing = encode_command(identifier, method, parameters, Some(session))?;
        let (sender, receiver) = oneshot::channel();
        let command = Command {
            identifier,
            state: self.inner.clone(),
            receiver,
            browser_reply_received: false,
        };
        self.register_commands(
            vec![outgoing],
            vec![(
                identifier,
                PendingReply {
                    sender: ReplySender::Binary {
                        sender,
                        kind,
                        maximum_decoded_bytes,
                    },
                    dispatch_started: false,
                },
            )],
            method,
        )?;
        Ok(command)
    }

    pub fn start_command(
        &self,
        method: &str,
        parameters: Value,
        session: Option<&str>,
    ) -> Result<Command, ErrorRecord> {
        Ok(self
            .start_commands(method, vec![parameters], session)?
            .remove(0))
    }

    /// Snapshot callers retain the command and their remote object group through uncertain completion.
    pub fn start_snapshot_capture(
        &self,
        parameters: Value,
        session: &str,
        admission: SnapshotReplyAdmission,
    ) -> Result<Command<SnapshotReply>, ErrorRecord> {
        let method = "Runtime.callFunctionOn";
        let identifier = self.inner.next_identifier.fetch_add(1, Ordering::Relaxed);
        let outgoing = encode_command(identifier, method, parameters, Some(session))?;
        let (sender, receiver) = oneshot::channel();
        let command = Command {
            identifier,
            state: self.inner.clone(),
            receiver,
            browser_reply_received: false,
        };
        self.register_commands(
            vec![outgoing],
            vec![(
                identifier,
                PendingReply {
                    sender: ReplySender::Snapshot { sender, admission },
                    dispatch_started: false,
                },
            )],
            method,
        )?;
        Ok(command)
    }

    /// Typed parameters can retain exact JSON string escapes without materializing a Unicode-scalar Value.
    pub fn start_typed_command<Parameters: Serialize>(
        &self,
        method: &str,
        parameters: Parameters,
        session: Option<&str>,
    ) -> Result<Command, ErrorRecord> {
        Ok(self
            .start_serializable_commands(method, vec![parameters], session)?
            .remove(0))
    }

    /// Keep browser value descriptions as JSON until their UTF-16 fields are decoded.
    /// These replies obey the same control-frame bound as ordinary structured replies.
    pub fn start_raw_command(
        &self,
        method: &str,
        parameters: Value,
        session: Option<&str>,
    ) -> Result<Command<Box<RawValue>>, ErrorRecord> {
        let identifier = self.inner.next_identifier.fetch_add(1, Ordering::Relaxed);
        let outgoing = encode_command(identifier, method, parameters, session)?;
        let (sender, receiver) = oneshot::channel();
        let command = Command {
            identifier,
            state: self.inner.clone(),
            receiver,
            browser_reply_received: false,
        };
        self.register_commands(
            vec![outgoing],
            vec![(
                identifier,
                PendingReply {
                    sender: ReplySender::Raw(sender),
                    dispatch_started: false,
                },
            )],
            method,
        )?;
        Ok(command)
    }

    /// Admit a bounded sequence atomically and write its commands in order, without
    /// waiting for replies between commands. Dropping each handle still withdraws it.
    pub fn start_commands(
        &self,
        method: &str,
        parameters: Vec<Value>,
        session: Option<&str>,
    ) -> Result<Vec<Command>, ErrorRecord> {
        self.start_serializable_commands(method, parameters, session)
    }

    fn start_serializable_commands<Parameters: Serialize>(
        &self,
        method: &str,
        parameters: Vec<Parameters>,
        session: Option<&str>,
    ) -> Result<Vec<Command>, ErrorRecord> {
        if parameters.len() > MAXIMUM_PENDING {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "too many pending CDP commands",
            ));
        }
        let mut outgoing = Vec::with_capacity(parameters.len());
        let mut registrations = Vec::with_capacity(parameters.len());
        let mut replies = Vec::with_capacity(parameters.len());
        let mut total_bytes = 0;
        for parameters in parameters {
            let identifier = self.inner.next_identifier.fetch_add(1, Ordering::Relaxed);
            let command = encode_command(identifier, method, parameters, session)?;
            total_bytes += command.bytes.len();
            if total_bytes > MAXIMUM_CONTROL_BYTES {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "CDP command sequence exceeds control-message limit",
                ));
            }
            let (sender, receiver) = oneshot::channel();
            outgoing.push(command);
            replies.push((
                identifier,
                PendingReply {
                    sender: ReplySender::Value(sender),
                    dispatch_started: false,
                },
            ));
            registrations.push(Command {
                identifier,
                state: self.inner.clone(),
                receiver,
                browser_reply_received: false,
            });
        }
        self.register_commands(outgoing, replies, method)?;
        Ok(registrations)
    }

    fn register_commands(
        &self,
        outgoing: Vec<OutgoingCommand>,
        replies: Vec<(u64, PendingReply)>,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        {
            let mut pending = self.inner.pending.lock().unwrap();
            if let Some(error) = &pending.closed {
                return Err(error.clone());
            }
            let maximum_pending = if matches!(
                method,
                "Page.handleJavaScriptDialog"
                    | "Browser.cancelDownload"
                    | "Target.closeTarget"
                    | "Target.disposeBrowserContext"
                    | "Browser.close"
                    | "Target.detachFromTarget"
                    | "Runtime.terminateExecution"
            ) {
                MAXIMUM_PENDING
            } else {
                flashwright_protocol::ordinary_operation_limit(MAXIMUM_PENDING)
            };
            if pending.replies.len() + replies.len() > maximum_pending {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "too many pending CDP commands",
                ));
            }
            pending.replies.extend(replies);
        }
        self.inner
            .outgoing
            .try_send(outgoing)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "CDP outgoing command queue is full",
                ),
                mpsc::error::TrySendError::Closed(_) => disconnected(),
            })?;
        Ok(())
    }

    pub fn close(&self) {
        fail_connection(&self.inner, disconnected());
        for pump in self.inner.pumps.lock().unwrap().iter() {
            pump.abort();
        }
    }
}

fn encode_command<Parameters: Serialize>(
    identifier: u64,
    method: &str,
    parameters: Parameters,
    session: Option<&str>,
) -> Result<OutgoingCommand, ErrorRecord> {
    #[derive(Serialize)]
    struct Envelope<'text, Parameters: Serialize> {
        id: u64,
        method: &'text str,
        params: Parameters,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session: Option<&'text str>,
    }
    let command = Envelope {
        id: identifier,
        method,
        params: parameters,
        session,
    };
    let mut bytes =
        serde_json::to_vec(&command).map_err(|error| protocol_error(error.to_string()))?;
    bytes.push(0);
    if bytes.len() > MAXIMUM_CONTROL_BYTES {
        return Err(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            method,
            "CDP command exceeds control-message limit",
        ));
    }
    Ok(OutgoingCommand {
        identifier,
        bytes,
        input: None,
    })
}

fn disconnected() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::BrowserDisconnected,
        "chromium",
        "Chromium protocol connection closed",
    )
}

fn protocol_error(message: String) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, "chromium", message)
}

/// Serialize event application with terminal invalidation. The pending-command lock
/// is never held while invoking owners, which may inspect failure or queue cleanup.
fn dispatch_event(
    state: &ConnectionState,
    method: String,
    session_identifier: Option<String>,
    parameters: Option<Box<RawValue>>,
    received_at: std::time::Instant,
) -> Result<(), ErrorRecord> {
    let handler = state.event_handler.lock().unwrap();
    if method != "Flashwright.disconnected"
        && let Some(error) = &state.pending.lock().unwrap().closed
    {
        return Err(error.clone());
    }
    let sequence = state.received_event_sequence.fetch_add(1, Ordering::AcqRel) + 1;
    let event = Event {
        sequence,
        received_at,
        method,
        session_identifier,
        parameters,
    };
    // Secondary temporary waiters do not own engine state. Avoid copying opaque
    // parameters when no such waiter is active.
    // Bulk private filmstrip data must not consume unrelated storage-waiter slots
    // or acquire a second, unaccounted image owner in the broadcast buffer.
    let secondary = (state.events.receiver_count() != 0 && event.method != "Page.screencastFrame")
        .then(|| event.clone());
    if let Some(handler) = handler.as_ref() {
        handler(event)?;
    }
    if let Some(event) = secondary {
        let _ = state.events.send(event);
    }
    state.processed_event_sequence.send_replace(sequence);
    Ok(())
}

fn fail_connection(state: &ConnectionState, error: ErrorRecord) {
    let replies = {
        let mut pending = state.pending.lock().unwrap();
        if pending.closed.is_some() {
            return;
        }
        pending.closed = Some(error.clone());
        std::mem::take(&mut pending.replies)
    };
    let _ = dispatch_event(
        state,
        "Flashwright.disconnected".to_owned(),
        None,
        None,
        std::time::Instant::now(),
    );
    for (_, reply) in replies {
        reply.sender.fail(error.clone());
    }
    state.processed_event_sequence.send_modify(|_| {});
}

async fn write_messages<Writer: AsyncWrite + Unpin>(
    mut writer: Writer,
    mut receiver: mpsc::Receiver<Vec<OutgoingCommand>>,
    state: Weak<ConnectionState>,
) {
    while let Some(commands) = receiver.recv().await {
        for command in commands {
            let Some(live) = state.upgrade() else {
                return;
            };
            let should_dispatch = {
                let mut pending = live.pending.lock().unwrap();
                if pending.closed.is_some() {
                    false
                } else if let Some(reply) = pending.replies.get_mut(&command.identifier) {
                    reply.dispatch_started = true;
                    true
                } else {
                    false
                }
            };
            drop(live);
            if !should_dispatch {
                continue;
            }
            if let Err(error) = command.write_to(&mut writer).await {
                if let Some(state) = state.upgrade() {
                    fail_connection(&state, protocol_error(error.to_string()));
                }
                return;
            }
        }
    }
}
