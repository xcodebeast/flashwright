use std::collections::HashMap;
use std::os::fd::AsFd;
use std::sync::Arc;

mod output;
mod pipe;

use flashwright_engine::{CAPABILITIES, Engine, Operation};
use flashwright_protocol::{
    ClientMessage, DriverMessage, DriverOutput, EncodedFrame, ErrorCode, ErrorRecord, FrameError,
    FrameReader, FrameWriter, Handshake, ResourceLimits,
};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Duration, Instant};

#[tokio::main]
async fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--browser-guardian")
    {
        let result = flashwright_browser::supervision::run_guardian(&arguments[1..]);
        if let Err(error) = result {
            eprintln!("flashwright guardian: {error}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }
    if let Err(error) = run().await {
        eprintln!("flashwright-driver: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let parent_liveness = if std::env::var_os("FLASHWRIGHT_PARENT_LIVENESS_FD").is_some() {
        Some(flashwright_browser::supervision::take_inherited_descriptor(
            3,
        )?)
    } else {
        None
    };
    let mut reader = FrameReader::new(
        pipe::Pipe::new(std::io::stdin().as_fd().try_clone_to_owned()?)?,
        ResourceLimits::default().control_frame_bytes,
    );
    let output = pipe::Pipe::new(std::io::stdout().as_fd().try_clone_to_owned()?)?;
    let handshake = match reader.read::<ClientMessage>().await? {
        Some(ClientMessage::Handshake { handshake }) => handshake,
        _ => return Err("the first message must be a version handshake".into()),
    };
    let limits = match handshake.validate() {
        Ok(limits) => limits,
        Err(error) => {
            FrameWriter::new(output, ResourceLimits::default().control_frame_bytes)
                .write(&DriverMessage::Error {
                    request_id: None,
                    error,
                })
                .await?;
            return Err("incompatible handshake".into());
        }
    };
    reader.set_maximum_bytes(limits.control_frame_bytes);
    let (outgoing, mut messages) = mpsc::channel(limits.queued_messages);
    let (fatal_sender, mut fatal) = watch::channel(false);
    let engine = Arc::new(Engine::new(parent_liveness, outgoing.clone(), fatal_sender));
    let writer_limits = limits.clone();
    let mut writer_task = tokio::spawn(async move {
        let mut writer = FrameWriter::new(output, writer_limits.control_frame_bytes);
        while let Some(message) = messages.recv().await {
            if output::write_output(&mut writer, message, &writer_limits).await?
                == output::OutputDisposition::CloseStream
            {
                return Ok(output::OutputDisposition::CloseStream);
            }
        }
        Ok::<_, FrameError>(output::OutputDisposition::Continue)
    });
    outgoing
        .send(
            DriverMessage::Handshake {
                handshake: Handshake {
                    limits: limits.clone(),
                    ..Handshake::default()
                },
                resident_runtime_sha256: flashwright_engine::RESIDENT_RUNTIME_SHA256.to_owned(),
                capabilities: CAPABILITIES
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                browser_identity: None,
                browser_encodings: vec!["json".to_owned()],
            }
            .into(),
        )
        .await?;
    let (incoming_sender, mut incoming) = mpsc::channel(limits.queued_messages);
    // A dedicated reader is never cancelled halfway through a control frame by another event.
    let reader_task = tokio::spawn(async move {
        loop {
            let message = reader.read::<ClientMessage>().await;
            let terminal = !matches!(message, Ok(Some(_)));
            if incoming_sender.send(message).await.is_err() || terminal {
                break;
            }
        }
    });
    let mut operations = JoinSet::<(u64, Result<EncodedFrame, FrameError>)>::new();
    let mut cancellations: HashMap<u64, watch::Sender<bool>> = HashMap::new();
    let mut termination =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut last_identifier = 0_u64;
    let mut failure = None;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = termination.recv() => break,
            _ = fatal.changed() => { failure = Some("browser event stream lost synchronization or exceeded resource bounds".to_owned()); break; },
            result = &mut writer_task => {
                if !matches!(result, Ok(Ok(output::OutputDisposition::Continue))) { failure = Some("output transport failed".to_owned()); }
                break;
            }
            completed = operations.join_next(), if !operations.is_empty() => {
                match completed {
                    Some(Ok((identifier, result))) => {
                        cancellations.remove(&identifier);
                        let frame = match result {
                            Ok(frame) => frame,
                            Err(error) => { failure = Some(error.to_string()); break; }
                        };
                        if outgoing.try_send(DriverOutput::Frame(frame)).is_err() { failure = Some("bounded output queue exhausted".to_owned()); break; }
                    }
                    _ => { failure = Some("operation task panicked".to_owned()); break; }
                }
            }
            message = incoming.recv() => {
                let message = match message {
                    Some(Ok(Some(message))) => message,
                    Some(Err(error)) => { failure = Some(error.to_string()); break; }
                    _ => break,
                };
                match message {
                    ClientMessage::Handshake { .. } => { failure = Some("duplicate handshake".to_owned()); break; }
                    ClientMessage::Cancel { request_id } => {
                        if let Some(sender) = cancellations.remove(&request_id) { let _ = sender.send(true); }
                    }
                    ClientMessage::Command { request_id, method, parameters, timeout_milliseconds } => {
                        if request_id <= last_identifier || request_id > 9_007_199_254_740_991 {
                            failure = Some("request identifiers must be strictly increasing positive JavaScript-safe integers".to_owned()); break;
                        }
                        last_identifier = request_id;
                        let validation = if operations.len() >= limits.pending_operations {
                            Err(ErrorRecord::new(ErrorCode::ResourceLimit, &method, "pending operation limit exceeded"))
                        } else { limits.validate_value(&parameters) };
                        if let Err(error) = validation {
                            let frame = match output::prepare_error(request_id, error, &limits) {
                                Ok(frame) => frame,
                                Err(error) => { failure = Some(error.to_string()); break; }
                            };
                            if outgoing.try_send(DriverOutput::Frame(frame)).is_err() { failure = Some("bounded output queue exhausted".to_owned()); break; }
                            continue;
                        }
                        let deadline = match timeout_milliseconds {
                            Some(milliseconds) => match Instant::now().checked_add(Duration::from_millis(milliseconds)) {
                                Some(deadline) => Some(deadline),
                                None => { failure = Some("deadline is outside the monotonic clock range".to_owned()); break; }
                            },
                            None => None,
                        };
                        let (sender, receiver) = watch::channel(false);
                        cancellations.insert(request_id, sender);
                        let engine = engine.clone();
                        let limits = limits.clone();
                        operations.spawn(async move {
                            let operation = Operation::new(method.clone(), deadline, receiver);
                            let result = engine.execute(&method, parameters, &operation).await;
                            let reply = output::prepare_reply(&engine, request_id, &method, result, operation.input_delivery(), &limits).await;
                            (request_id, reply)
                        });
                    }
                }
            }
        }
    }
    reader_task.abort();
    for (_, sender) in cancellations.drain() {
        let _ = sender.send(true);
    }
    operations.abort_all();
    while operations.join_next().await.is_some() {}
    engine.shutdown().await;
    writer_task.abort();
    if let Some(failure) = failure {
        return Err(failure.into());
    }
    Ok(())
}
