use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::AbortHandle;

const MAXIMUM_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAXIMUM_PENDING: usize = 1024;
type Reply = Result<Value, ErrorRecord>;

#[derive(Clone)]
pub struct Connection {
    inner: Arc<ConnectionState>,
}

struct ConnectionState {
    next_identifier: AtomicU64,
    pending: Mutex<PendingReplies>,
    outgoing: mpsc::Sender<Vec<OutgoingCommand>>,
    events: broadcast::Sender<Event>,
    received_event_sequence: AtomicU64,
    processed_event_sequence: watch::Sender<u64>,
    pumps: Mutex<Vec<AbortHandle>>,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub sequence: u64,
    pub method: String,
    pub session_identifier: Option<String>,
    pub parameters: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Envelope {
    id: Option<u64>,
    method: Option<String>,
    #[serde(rename = "sessionId")]
    session_identifier: Option<String>,
    params: Option<Box<RawValue>>,
    result: Option<Box<RawValue>>,
    error: Option<Box<RawValue>>,
}

#[derive(Default)]
struct PendingReplies {
    closed: Option<ErrorRecord>,
    replies: HashMap<u64, PendingReply>,
}

struct OutgoingCommand {
    identifier: u64,
    bytes: Vec<u8>,
}

struct PendingReply {
    sender: oneshot::Sender<Reply>,
    dispatch_started: bool,
}

pub struct Command {
    identifier: u64,
    state: Arc<ConnectionState>,
    receiver: oneshot::Receiver<Reply>,
}

impl Command {
    pub async fn response(&mut self) -> Reply {
        (&mut self.receiver).await.map_err(|_| disconnected())?
    }

    /// Recover a reply already received when cancellation won the caller's wait.
    pub fn try_response(&mut self) -> Option<Reply> {
        match self.receiver.try_recv() {
            Ok(reply) => Some(reply),
            Err(oneshot::error::TryRecvError::Empty) => None,
            Err(oneshot::error::TryRecvError::Closed) => Some(Err(disconnected())),
        }
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

impl Drop for Command {
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

    pub fn acknowledge_event(&self, sequence: u64) {
        self.inner
            .processed_event_sequence
            .send_modify(|processed| *processed = (*processed).max(sequence));
    }

    /// A reply can wake its caller before the event consumer has applied preceding events.
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

    /// Admit a bounded sequence atomically and write its commands in order, without
    /// waiting for replies between commands. Dropping each handle still withdraws it.
    pub fn start_commands(
        &self,
        method: &str,
        parameters: Vec<Value>,
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
            let mut command = json!({ "id": identifier, "method": method, "params": parameters });
            if let Some(session) = session {
                command["sessionId"] = json!(session);
            }
            let mut bytes =
                serde_json::to_vec(&command).map_err(|error| protocol_error(error.to_string()))?;
            bytes.push(0);
            total_bytes += bytes.len();
            if total_bytes > MAXIMUM_MESSAGE_BYTES {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "CDP command sequence exceeds control-message limit",
                ));
            }
            let (sender, receiver) = oneshot::channel();
            outgoing.push(OutgoingCommand { identifier, bytes });
            replies.push((
                identifier,
                PendingReply {
                    sender,
                    dispatch_started: false,
                },
            ));
            registrations.push(Command {
                identifier,
                state: self.inner.clone(),
                receiver,
            });
        }
        {
            let mut pending = self.inner.pending.lock().unwrap();
            if let Some(error) = &pending.closed {
                return Err(error.clone());
            }
            if pending.replies.len() + replies.len() > MAXIMUM_PENDING {
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
        Ok(registrations)
    }

    pub fn close(&self) {
        fail_connection(&self.inner, disconnected());
        for pump in self.inner.pumps.lock().unwrap().iter() {
            pump.abort();
        }
    }
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

fn fail_connection(state: &ConnectionState, error: ErrorRecord) {
    let mut pending = state.pending.lock().unwrap();
    if pending.closed.is_some() {
        return;
    }
    pending.closed = Some(error.clone());
    for (_, reply) in pending.replies.drain() {
        let _ = reply.sender.send(Err(error.clone()));
    }
    let _ = state.events.send(Event {
        sequence: state.received_event_sequence.fetch_add(1, Ordering::AcqRel) + 1,
        method: "Flashwright.disconnected".to_owned(),
        session_identifier: None,
        parameters: None,
    });
    state.processed_event_sequence.send_modify(|_| {});
}

async fn read_messages<Reader: AsyncRead + Unpin>(
    mut reader: Reader,
    state: Weak<ConnectionState>,
) {
    let mut chunk = [0_u8; 65536];
    let mut message = Vec::new();
    let failure = loop {
        let length = match reader.read(&mut chunk).await {
            Ok(0) => break disconnected(),
            Ok(length) => length,
            Err(error) => break protocol_error(error.to_string()),
        };
        let mut start = 0;
        for end in 0..length {
            if chunk[end] != 0 {
                continue;
            }
            if message.len() + end - start > MAXIMUM_MESSAGE_BYTES {
                if let Some(state) = state.upgrade() {
                    fail_connection(
                        &state,
                        protocol_error("CDP frame limit exceeded".to_owned()),
                    );
                }
                return;
            }
            message.extend_from_slice(&chunk[start..end]);
            let decoded: Envelope = match serde_json::from_slice(&message) {
                Ok(decoded) => decoded,
                Err(error) => {
                    if let Some(state) = state.upgrade() {
                        fail_connection(&state, protocol_error(error.to_string()));
                    }
                    return;
                }
            };
            let Some(state) = state.upgrade() else {
                return;
            };
            if let Some(identifier) = decoded.id {
                if let Some(reply) = state.pending.lock().unwrap().replies.remove(&identifier) {
                    let result = if let Some(error) = decoded.error {
                        let mut record = protocol_error(error.get().to_owned());
                        record.browser_error_code = serde_json::from_str::<Value>(error.get())
                            .ok()
                            .and_then(|value| value["code"].as_i64());
                        Err(record)
                    } else {
                        decoded
                            .result
                            .map(|result| {
                                serde_json::from_str(result.get())
                                    .map_err(|error| protocol_error(error.to_string()))
                            })
                            .unwrap_or(Ok(Value::Null))
                    };
                    let _ = reply.sender.send(result);
                }
            } else if let Some(method) = decoded.method {
                // Keep opaque event payloads lossless, including escaped lone UTF-16 surrogates.
                let _ = state.events.send(Event {
                    sequence: state.received_event_sequence.fetch_add(1, Ordering::AcqRel) + 1,
                    method,
                    session_identifier: decoded.session_identifier,
                    parameters: decoded.params,
                });
            } else {
                fail_connection(
                    &state,
                    protocol_error(
                        "CDP message has neither a reply identity nor an event method".to_owned(),
                    ),
                );
                return;
            }
            message.clear();
            start = end + 1;
        }
        if message.len() + length - start > MAXIMUM_MESSAGE_BYTES {
            break protocol_error("CDP frame limit exceeded".to_owned());
        }
        message.extend_from_slice(&chunk[start..length]);
    };
    if let Some(state) = state.upgrade() {
        fail_connection(&state, failure);
    }
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
            if let Err(error) = writer.write_all(&command.bytes).await {
                if let Some(state) = state.upgrade() {
                    fail_connection(&state, protocol_error(error.to_string()));
                }
                return;
            }
        }
    }
}
