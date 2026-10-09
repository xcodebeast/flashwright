use super::*;
use flashwright_protocol::{DriverMessage, EncodedFrame, InputDelivery};

fn engine_budget() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(ENGINE_BYTES))
}
fn start(queue: &mut TraceDiagnostics, generation: &str, engine: &Arc<Semaphore>) {
    queue
        .start(generation, 8 * 1024 * 1024, engine.clone())
        .unwrap();
}
fn encode(batch: &Arc<RetainedDiagnostics>) -> Result<EncodedFrame, ErrorRecord> {
    batch.prepare(|value, custody| {
        let mut frame =
            DriverMessage::encode_result(1, value, InputDelivery::NotDispatched, 8 * 1024 * 1024)
                .unwrap();
        frame.retain_reservation(custody);
        Ok(frame)
    })
}

#[test]
fn failed_publication_never_exposes_initial_diagnostics() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("unpublished", false, "console-api", "{}");
    queue.capture("existing", true, "console-api", "{}");
    let batch = queue.drain("first", false).unwrap();
    assert_eq!(batch.value()["events"].as_array().unwrap().len(), 1);
    assert_eq!(batch.value()["events"][0]["page"], "existing");
    queue.discard_unpublished_page("unpublished");
    assert_eq!(queue.recording.as_ref().unwrap().queued_bytes, 0);
    assert!(
        queue.drain("first", true).unwrap().value()["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    drop(batch);
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn publication_and_successor_recording_preserve_original_drains() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("page", false, "console-api", "{}");
    queue.publish_page("page");
    let first = queue.drain("first", true).unwrap();
    let retained = ENGINE_BYTES - engine.available_permits();
    start(&mut queue, "second", &engine);
    assert!(queue.drain("first", true).is_err());
    queue.capture("new-page", true, "console-api", "{}");
    assert_eq!(first.value()["generation"], "first");
    assert_eq!(first.value()["events"][0]["page"], "page");
    // A previously admitted drain remains valid after stop/start, without reading the successor.
    let frame = encode(&first).unwrap();
    drop(first);
    let second = queue.drain("second", true).unwrap();
    assert_eq!(second.value()["events"][0]["page"], "new-page");
    drop(second);
    assert!(ENGINE_BYTES - engine.available_permits() > retained);
    drop(frame);
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn overflow_is_sticky_until_stop_and_does_not_grow_the_queue() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    for _ in 0..=MAXIMUM_EVENTS {
        queue.capture("page", true, "console-api", "{}");
    }
    assert_eq!(
        queue.drain("first", false).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    queue.capture("page", true, "console-api", "{}");
    assert!(queue.recording.as_ref().unwrap().events.is_empty());
    assert_eq!(
        queue.drain("first", true).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
    queue.start("second", 1024, engine.clone()).unwrap();
    queue.capture("page", true, "console-api", &"x".repeat(512));
    assert_eq!(
        queue.drain("second", true).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn escaped_wire_size_is_checked_before_owned_event_admission() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    queue.start("first", 1024, engine.clone()).unwrap();
    let before = engine.available_permits();
    queue.capture("page", true, "console-api", &"\0".repeat(100));
    assert_eq!(engine.available_permits(), before);
    assert!(queue.recording.as_ref().unwrap().events.is_empty());
    assert_eq!(
        queue.drain("first", true).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn drain_moves_strings_and_keeps_original_credits_after_later_capture_failure() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("page", true, "console-api", "original");
    let pointer = queue.recording.as_ref().unwrap().events[0].value["raw"]
        .as_str()
        .unwrap()
        .as_ptr();
    let batch = queue.drain("first", false).unwrap();
    assert_eq!(
        batch.value()["events"][0]["raw"].as_str().unwrap().as_ptr(),
        pointer
    );
    queue.capture(
        "page",
        true,
        "console-api",
        &"x".repeat(MAXIMUM_DIAGNOSTIC_BYTES + 1),
    );
    assert_eq!(
        queue.drain("first", true).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(batch.value()["events"][0]["raw"], "original");
    assert!(engine.available_permits() < ENGINE_BYTES);
    drop(batch);
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn shared_engine_admission_rolls_back_and_leaves_other_context_healthy() {
    let engine = Arc::new(Semaphore::new(RECORDING_BYTES + 4096));
    let mut first = TraceDiagnostics::default();
    let mut second = TraceDiagnostics::default();
    start(&mut first, "first", &engine);
    assert_eq!(
        second
            .start("second", 8 * 1024 * 1024, engine.clone())
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(
        second
            .owner
            .as_ref()
            .unwrap()
            .budget
            .context
            .available_permits(),
        CONTEXT_BYTES
    );
    assert!(second.recording.is_none());
    first.capture("page", true, "console-api", "{}");
    let batch = first.drain("first", true).unwrap();
    assert_eq!(batch.value()["events"].as_array().unwrap().len(), 1);
    drop(batch);
    start(&mut second, "second", &engine);
    second.close();
    assert_eq!(engine.available_permits(), RECORDING_BYTES + 4096);
}

#[test]
fn capture_pressure_is_local_and_does_not_steal_a_sibling_reservation() {
    let engine = engine_budget();
    let mut first = TraceDiagnostics::default();
    let mut second = TraceDiagnostics::default();
    start(&mut first, "first", &engine);
    start(&mut second, "second", &engine);
    first.capture("first-page", true, "console-api", "preserved");
    second.capture("second-page", true, "console-api", "discarded");
    let held = engine
        .clone()
        .try_acquire_many_owned(engine.available_permits() as u32)
        .unwrap();
    second.capture("second-page", true, "console-api", "overflow");
    assert_eq!(
        second.drain("second", true).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    drop(held);
    let batch = first.drain("first", true).unwrap();
    assert_eq!(batch.value()["events"][0]["raw"], "preserved");
    drop(batch);
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn rejected_drain_releases_no_sibling_bytes_and_leaves_a_sticky_failure() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("page", true, "console-api", "{}");
    let held = engine
        .clone()
        .try_acquire_many_owned(engine.available_permits() as u32)
        .unwrap();
    assert_eq!(
        queue.drain("first", false).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert!(queue.recording.as_ref().unwrap().events.is_empty());
    drop(held);
    assert_eq!(
        queue.drain("first", true).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn stopped_generations_cannot_reset_the_context_retained_allowance() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    let owner = queue.owner.as_ref().unwrap().clone();
    queue.capture("page", true, "console-api", "original");
    let batch = queue.drain("first", true).unwrap();
    let available = owner.budget.context.available_permits();
    let held = owner
        .budget
        .context
        .clone()
        .try_acquire_many_owned((available - RECORDING_BYTES + 1) as u32)
        .unwrap();
    let before = engine.available_permits();
    assert_eq!(
        queue
            .start("second", 8 * 1024 * 1024, engine.clone())
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(engine.available_permits(), before);
    drop(batch);
    start(&mut queue, "second", &engine);
    queue.close();
    drop(held);
    assert_eq!(owner.budget.context.available_permits(), CONTEXT_BYTES);
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn each_encoded_copy_retains_its_own_frame_bytes_until_discard() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("page", true, "console-api", "\n\0é");
    let batch = queue.drain("first", true).unwrap();
    let weak = Arc::downgrade(&batch);
    let before = engine.available_permits();
    let first = encode(&batch).unwrap();
    let after_first = engine.available_permits();
    let second = encode(&batch).unwrap();
    assert_eq!(
        after_first - engine.available_permits(),
        before - after_first
    );
    drop(batch);
    queue.close();
    assert!(weak.upgrade().is_some());
    drop(first);
    assert_eq!(engine.available_permits(), after_first);
    drop(second);
    assert!(weak.upgrade().is_none());
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn rejection_before_encoding_releases_only_its_attempt_reservation() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("page", true, "console-api", "{}");
    let batch = queue.drain("first", true).unwrap();
    let before = engine.available_permits();
    let error = batch
        .prepare::<()>(|_, _| Err(invalid("test", "rejected")))
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgument);
    assert_eq!(engine.available_permits(), before);
    let held = engine
        .clone()
        .try_acquire_many_owned(engine.available_permits() as u32)
        .unwrap();
    assert_eq!(
        batch
            .prepare::<()>(|_, _| panic!("encoding must not start without admission"))
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    drop(held);
    drop(batch);
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn closing_original_context_rejects_unprepared_drains() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("page", true, "console-api", "{}");
    let batch = queue.drain("first", false).unwrap();
    queue.close();
    assert_eq!(
        batch
            .prepare::<()>(|_, _| panic!("closed owner cannot publish"))
            .unwrap_err()
            .code,
        ErrorCode::TargetClosed
    );
    assert_eq!(
        queue
            .start("second", 8 * 1024 * 1024, engine.clone())
            .unwrap_err()
            .code,
        ErrorCode::TargetClosed
    );
    assert!(engine.available_permits() < ENGINE_BYTES);
    drop(batch);
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[tokio::test]
async fn encoded_frame_survives_owner_close_and_keeps_exact_wire_bytes() {
    let engine = engine_budget();
    let mut queue = TraceDiagnostics::default();
    start(&mut queue, "first", &engine);
    queue.capture("page", true, "console-api", "original\n\0é");
    let batch = queue.drain("first", true).unwrap();
    let weak = Arc::downgrade(&batch);
    let frame = encode(&batch).unwrap();
    drop(batch);
    queue.close();
    let (producer, consumer) = tokio::io::duplex(16);
    let writer = tokio::spawn(async move {
        flashwright_protocol::FrameWriter::new(producer, 8 * 1024 * 1024)
            .write_frame(&frame)
            .await
            .unwrap();
    });
    assert!(weak.upgrade().is_some());
    let reply = flashwright_protocol::FrameReader::new(consumer, 8 * 1024 * 1024)
        .read::<Value>()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply["value"]["events"][0]["raw"], "original\n\0é");
    writer.await.unwrap();
    assert!(weak.upgrade().is_none());
    assert_eq!(engine.available_permits(), ENGINE_BYTES);
}

#[test]
fn engine_diagnostic_dispatch_and_publication_preserve_context_close_fence() {
    let (outgoing, _messages) = mpsc::channel(16);
    let (fatal, _failure) = watch::channel(false);
    let engine = Engine::new(None, outgoing, fatal, ResourceLimits::default());
    let state = Arc::new(context_state::ContextState::default());
    engine.registry.lock().unwrap().contexts.insert(
        "context".into(),
        Context {
            browser_identifier: "browser".into(),
            protocol_identifier: "native".into(),
            viewport: None,
            devices: devices::DeviceOptions::default(),
            settings: context_settings::ContextSettings::parse(&json!({})).unwrap(),
            state: state.clone(),
            published: true,
        },
    );
    let parameters = json!({ "context": "context", "generation": "first" });
    let operation = Operation::new("test".into(), None, watch::channel(false).1);
    assert!(
        engine
            .execute_diagnostic_control("other", &parameters, &operation)
            .is_none()
    );
    engine
        .execute_diagnostic_control("context.trace.start", &parameters, &operation)
        .unwrap()
        .unwrap();
    state
        .trace_diagnostics
        .lock()
        .unwrap()
        .capture("page", true, "console-api", "{}");
    let mut result = engine
        .execute_diagnostic_control("context.trace.stop", &parameters, &operation)
        .unwrap()
        .unwrap();
    assert!(matches!(result, OperationResult::RetainedDiagnostics(_)));
    assert!(!state.trace_enabled.load(Ordering::Relaxed));
    engine
        .prepare_operation_publication("context.trace.stop", &mut result, |value, custody| {
            assert_eq!(value["events"][0]["page"], "page");
            assert!(custody.is_some());
            Ok(())
        })
        .unwrap();
    state.close_trace();
    assert_eq!(
        engine
            .prepare_operation_publication::<()>("context.trace.stop", &mut result, |_, _| panic!(
                "closed"
            ))
            .unwrap_err()
            .code,
        ErrorCode::TargetClosed
    );
}
