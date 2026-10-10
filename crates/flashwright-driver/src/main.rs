use std::collections::HashMap;
use std::os::fd::AsFd;
use std::sync::Arc;

mod attachments;
mod input_attachments;
mod output;
mod pipe;

use flashwright_engine::{CAPABILITIES, Engine, Operation, OperationResult};
use flashwright_protocol::{
    ClientFrame, ClientMessage, DriverMessage, DriverOutput, EncodedFrame, ErrorCode, ErrorRecord,
    FrameError, FrameReader, FrameWriter, Handshake, ResourceLimits,
};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Duration, Instant};

fn main() {
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
    // The guardian is synchronous and must not allocate the driver's async worker pool.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed building the driver runtime")
        .block_on(async {
            if let Err(error) = run().await {
                eprintln!("flashwright-driver: {error}");
                std::process::exit(1);
            }
        });
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
    let (outgoing, messages) = mpsc::channel(limits.queued_messages);
    let (fatal_sender, mut fatal) = watch::channel(false);
    let engine = Arc::new(Engine::new(
        parent_liveness,
        outgoing.clone(),
        fatal_sender,
        limits.clone(),
    ));
    let writer_limits = limits.clone();
    let mut writer_task = tokio::spawn(async move {
        let writer = FrameWriter::new(output, writer_limits.control_frame_bytes);
        output::run_writer(writer, messages, &writer_limits).await
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
            let message = reader.read_client_frame().await;
            let terminal = !matches!(message, Ok(Some(_)));
            if incoming_sender.send(message).await.is_err() || terminal {
                break;
            }
        }
    });
    let mut operations = JoinSet::<(u64, Result<Option<EncodedFrame>, FrameError>)>::new();
    let mut cancellations: HashMap<u64, watch::Sender<bool>> = HashMap::new();
    let mut inputs = input_attachments::InputAttachments::new(&limits);
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
                        inputs.expire(identifier);
                        let frame = match result {
                            Ok(Some(frame)) => frame,
                            Ok(None) => continue,
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
                let message = match message {
                    ClientFrame::Message(message) => message,
                    ClientFrame::Attachment { request_id, offset, bytes } => {
                        if let Err(error) = inputs.receive(request_id, offset, &bytes) {
                            failure = Some(error.to_string()); break;
                        }
                        continue;
                    }
                };
                match message {
                    ClientMessage::Handshake { .. } => { failure = Some("duplicate handshake".to_owned()); break; }
                    ClientMessage::Cancel { request_id } => {
                        if let Some(sender) = cancellations.remove(&request_id) { let _ = sender.send(true); }
                        inputs.expire(request_id);
                    }
                    ClientMessage::ApiDateResult { context, lookup, milliseconds } => {
                        if let Err(error) = engine.resolve_api_dates(&context, &lookup, milliseconds) {
                            failure = Some(error.message.to_string()); break;
                        }
                    }
                    ClientMessage::InputEnd { request_id, aborted } => {
                        if let Err(error) = inputs.finish(request_id, aborted) {
                            failure = Some(error.to_string()); break;
                        }
                    }
                    ClientMessage::Command { request_id, method, parameters, timeout_milliseconds, input_byte_length, trace_call } => {
                        if request_id <= last_identifier || request_id > 9_007_199_254_740_991 {
                            failure = Some("request identifiers must be strictly increasing positive JavaScript-safe integers".to_owned()); break;
                        }
                        last_identifier = request_id;
                        let validation = if !flashwright_protocol::admits_operation(operations.len(), limits.pending_operations, &method) {
                            Err(ErrorRecord::new(ErrorCode::ResourceLimit, &method, "pending operation limit exceeded"))
                        } else { limits.validate_value(&parameters).and_then(|()| trace_call.as_ref().map_or(Ok(()), |trace_call| trace_call.validate(&method))) };
                        let prepared_input = if let Some(length) = input_byte_length {
                            match inputs.begin(request_id, length, &method, validation) {
                                Ok(result) => result.map(Some),
                                Err(error) => { failure = Some(error.to_string()); break; }
                            }
                        } else { validation.map(|()| None) };
                        let input = match prepared_input {
                            Ok(input) => input,
                            Err(error) => {
                            let frame = match output::prepare_error(request_id, error, &limits) {
                                Ok(frame) => frame,
                                Err(error) => { failure = Some(error.to_string()); break; }
                            };
                            if outgoing.try_send(DriverOutput::Frame(frame)).is_err() { failure = Some("bounded output queue exhausted".to_owned()); break; }
                            continue;
                            }
                        };
                        let deadline = match timeout_milliseconds {
                            Some(milliseconds) => match Instant::now().checked_add(Duration::from_millis(milliseconds)) {
                                Some(deadline) => Some(deadline),
                                None => { failure = Some("deadline is outside the monotonic clock range".to_owned()); break; }
                            },
                            None => None,
                        };
                        let (sender, receiver) = watch::channel(false);
                        cancellations.insert(request_id, sender);
                        let operation = Operation::new(method.clone(), deadline, receiver).with_trace_call(trace_call);
                        let control_result = if input.is_none() {
                            engine.execute_diagnostic_control(&method, &parameters, &operation)
                                .or_else(|| engine.execute_control(&method, &parameters, &operation).map(|result| result.map(OperationResult::Value)))
                        } else { None };
                        let dialog_handling = if input.is_none() { engine.prepare_dialog_handling(&method, &parameters, &operation) } else { None };
                        let download = if input.is_none() { engine.prepare_download_operation(&method, &parameters, &operation) } else { None };
                        let engine = engine.clone();
                        let limits = limits.clone();
                        let outgoing = outgoing.clone();
                        operations.spawn(async move {
                            let result = async {
                                if let Some(input) = input {
                                    let attachment = operation.wait(async {
                                        input.await.map_err(|_| ErrorRecord::new(ErrorCode::Cancelled, &method, "binary input transfer aborted"))
                                    }).await?;
                                    operation.attach_input(attachment)?;
                                }
                                if let Some(prepared) = dialog_handling {
                                    return prepared?.finish(&operation).await.map(OperationResult::Value);
                                }
                                if let Some(prepared) = download {
                                    return prepared?.finish(&operation).await.map(OperationResult::Value);
                                }
                                match control_result {
                                    Some(result) => result,
                                    None => engine.execute(&method, parameters, &operation).await,
                                }
                            }.await;
                            let result = match result {
                                Ok(OperationResult::Binary(attachment)) => {
                                    let reply = attachments::stream_attachment(request_id, attachment, &operation, &outgoing, &limits).await;
                                    return (request_id, reply);
                                }
                                result => result,
                            };
                            let reply = output::prepare_operation_reply(&engine, request_id, &method, result, operation.input_delivery(), &limits).await.map(Some);
                            (request_id, reply)
                        });
                    }
                }
            }
        }
    }
    reader_task.abort();
    drop(inputs);
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
