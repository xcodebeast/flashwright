//! One bounded task owns a page's cast, delayed ACK and definitive stop outcome.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use flashwright_browser::Connection;
use flashwright_browser::connection::Command;
use flashwright_protocol::{AttachmentEncoding, BinaryPayload, ErrorCode, ErrorRecord};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{Notify, OwnedSemaphorePermit, watch};
use tokio::time::{Duration, Instant, sleep_until, timeout};

use super::{Filmstrip, FrameMetadata, MAXIMUM_FRAME_BYTES, resource_limit};
use crate::Page;

const THROTTLE: Duration = Duration::from_millis(200);
const ACTIVITY: Duration = Duration::from_millis(500);
const COMMAND_BUDGET: Duration = Duration::from_secs(2);
const MAXIMUM_PENDING_ACKS: usize = 32;

#[derive(Deserialize)]
struct Frame<'message> {
    #[serde(borrow)]
    data: Cow<'message, str>,
    #[serde(rename = "sessionId")]
    session: u64,
    metadata: Metadata,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    device_width: f64,
    device_height: f64,
    timestamp: Option<f64>,
}

struct CaptureState {
    accepting: bool,
    retired_cast: u64,
    current_cast: Option<u64>,
    unthrottled_until: Instant,
    delayed_ack: Option<(u64, Instant)>,
    immediate_acks: VecDeque<u64>,
}

impl CaptureState {
    fn acknowledge(&mut self, session: u64) -> Result<(), ErrorRecord> {
        if self.immediate_acks.len() >= MAXIMUM_PENDING_ACKS {
            return Err(resource_limit(
                "page filmstrip exceeds 32 pending acknowledgements",
            ));
        }
        self.immediate_acks.push_back(session);
        Ok(())
    }

    fn activity(&mut self) -> Result<(), ErrorRecord> {
        self.unthrottled_until = Instant::now() + ACTIVITY;
        if let Some((session, _)) = self.delayed_ack.take() {
            self.acknowledge(session)?;
        }
        Ok(())
    }
}

pub(crate) struct PageCapture {
    recording: Weak<Filmstrip>,
    identifier: String,
    page: Page,
    connection: Connection,
    state: Mutex<CaptureState>,
    changed: Notify,
    started: watch::Sender<Option<Result<(), ErrorRecord>>>,
    finished: watch::Sender<bool>,
    reservation: Mutex<Option<OwnedSemaphorePermit>>,
}

impl PageCapture {
    /// Queue the start before page publication; its reply and cleanup have an independent owner.
    pub(super) fn start(
        recording: &Arc<Filmstrip>,
        identifier: String,
        page: Page,
        connection: Connection,
        width: u32,
        height: u32,
    ) -> Result<Arc<Self>, ErrorRecord> {
        let reservation = recording
            .budget
            .pages
            .clone()
            .try_acquire_owned()
            .map_err(|_| resource_limit("engine filmstrip exceeds 128 page capture owners"))?;
        let capture = Arc::new(Self {
            recording: Arc::downgrade(recording),
            identifier: identifier.clone(),
            connection,
            state: Mutex::new(CaptureState {
                accepting: true,
                retired_cast: page.state.filmstrip_cast.load(Ordering::Relaxed),
                current_cast: None,
                unthrottled_until: Instant::now(),
                delayed_ack: None,
                immediate_acks: VecDeque::new(),
            }),
            page,
            changed: Notify::new(),
            started: watch::channel(None).0,
            finished: watch::channel(false).0,
            reservation: Mutex::new(Some(reservation)),
        });
        *capture.page.state.filmstrip_capture.lock().unwrap() = Arc::downgrade(&capture);
        recording
            .pages
            .lock()
            .unwrap()
            .insert(identifier, capture.clone());
        let command = capture.connection.start_command(
            "Page.startScreencast",
            json!({ "format": "jpeg", "quality": 90, "maxWidth": width, "maxHeight": height }),
            Some(&capture.page.session_identifier),
        );
        let owned = capture.clone();
        let recording = recording.clone();
        tokio::spawn(async move {
            owned.run(recording, command).await;
        });
        Ok(capture)
    }

    pub(super) fn finished(&self) -> bool {
        *self.finished.borrow()
    }

    fn page_closed(&self) -> bool {
        self.page.state.state.lock().unwrap().failure.is_some()
    }

    pub(super) async fn wait_started(&self) -> Result<(), ErrorRecord> {
        let mut started = self.started.subscribe();
        loop {
            if let Some(result) = started.borrow_and_update().clone() {
                return result;
            }
            started
                .changed()
                .await
                .map_err(|_| crate::closed("context.trace.filmstrip.start"))?;
        }
    }

    pub(super) async fn wait_finished(&self) {
        let mut finished = self.finished.subscribe();
        while !*finished.borrow_and_update() {
            if finished.changed().await.is_err() {
                break;
            }
        }
    }

    pub(crate) fn activity(&self, context: &str, generation: &str) {
        let Some(recording) = self.recording.upgrade() else {
            return;
        };
        if recording.context != context
            || recording.generation != generation
            || *recording.stopping.borrow()
        {
            return;
        }
        let result = {
            let mut state = self.state.lock().unwrap();
            if !state.accepting {
                return;
            }
            state.activity()
        };
        if let Err(error) = result {
            recording.fail(error);
        }
        self.changed.notify_one();
    }

    /// Parse borrowed image data; allocate a retained payload only after all queue reservations.
    pub(crate) fn receive(&self, raw: &str, published: bool) {
        let Some(recording) = self.recording.upgrade() else {
            return;
        };
        let timestamp = recording.budget.now();
        let result = (|| {
            let frame: Frame<'_> =
                serde_json::from_str(raw).map_err(|error| protocol_error(&error.to_string()))?;
            if frame.session == 0 || frame.session > 9_007_199_254_740_991 {
                return Err(protocol_error("invalid screencast generation"));
            }
            let mut state = self.state.lock().unwrap();
            if !state.accepting {
                return Ok(());
            }
            if frame.session <= state.retired_cast {
                state.acknowledge(frame.session)?;
                return Ok(());
            }
            if state
                .current_cast
                .is_some_and(|session| session != frame.session)
            {
                return Err(protocol_error(
                    "screencast generation changed without an owned restart",
                ));
            }
            state.current_cast = Some(frame.session);
            self.page
                .state
                .filmstrip_cast
                .fetch_max(frame.session, Ordering::Relaxed);
            let now = Instant::now();
            let unthrottled = now < state.unthrottled_until;
            if !unthrottled && state.delayed_ack.is_some() {
                state.acknowledge(frame.session)?;
                return Ok(());
            }
            if unthrottled {
                state.acknowledge(frame.session)?;
            } else {
                state.delayed_ack = Some((frame.session, now + THROTTLE));
            }
            drop(state);
            let mut frames = recording.frames.lock().unwrap();
            if !frames.accepting() {
                return Ok(());
            }
            if ![frame.metadata.device_width, frame.metadata.device_height]
                .iter()
                .all(|value| value.is_finite() && *value > 0.0 && *value <= u32::MAX as f64)
                || frame
                    .metadata
                    .timestamp
                    .is_some_and(|value| !value.is_finite() || value < 0.0)
            {
                return Err(protocol_error(
                    "invalid screencast dimensions or compositor timestamp",
                ));
            }
            frames.check_capacity(frame.data.len())?;
            let reservation = recording.budget.reserve(frame.data.len())?;
            let encoded = match frame.data {
                Cow::Borrowed(data) => Cow::Borrowed(data.as_bytes()),
                Cow::Owned(data) => Cow::Owned(data.into_bytes()),
            };
            let payload = BinaryPayload::new(
                encoded,
                AttachmentEncoding::Base64,
                MAXIMUM_FRAME_BYTES,
                "context.trace.filmstrip",
            )?;
            if payload.decoded_length == 0 {
                return Err(protocol_error("empty screencast image"));
            }
            let wall_time = frame
                .metadata
                .timestamp
                .filter(|value| *value != 0.0)
                .map(|value| value * 1000.0)
                .unwrap_or_else(|| {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64()
                        * 1000.0
                });
            if !wall_time.is_finite() {
                return Err(protocol_error(
                    "compositor timestamp exceeds its numeric range",
                ));
            }
            let metadata = FrameMetadata {
                token: 0,
                page: self.identifier.clone(),
                width: frame.metadata.device_width,
                height: frame.metadata.device_height,
                timestamp,
                frame_swap_wall_time: wall_time,
                byte_length: payload.decoded_length,
            };
            frames.insert(metadata, payload, published, reservation)
        })();
        if let Err(error) = result {
            recording.fail(error);
        }
        self.changed.notify_one();
    }

    async fn run(
        self: Arc<Self>,
        recording: Arc<Filmstrip>,
        command: Result<Command, ErrorRecord>,
    ) {
        let mut stopping = recording.stopping.subscribe();
        let registered = command.is_ok();
        let start_result = match command {
            Ok(mut command) => {
                if *stopping.borrow() {
                    Err(crate::closed("context.trace.filmstrip.start"))
                } else {
                    tokio::select! {
                        biased;
                        _ = stopping.changed() => Err(crate::closed("context.trace.filmstrip.start")),
                        result = timeout(COMMAND_BUDGET, self.page.state.while_alive("context.trace.filmstrip.start", command.response())) => {
                            result.unwrap_or_else(|_| Err(command_timeout("start"))).map(|_| ())
                        }
                    }
                }
            }
            Err(error) => Err(error),
        };
        let start_result = if self.page_closed() {
            Ok(())
        } else {
            start_result
        };
        self.started.send_replace(Some(start_result.clone()));
        if let Err(error) = &start_result {
            recording.fail(error.clone());
        }
        if start_result.is_ok()
            && !self.page_closed()
            && let Err(error) = self.acknowledge_frames(&mut stopping).await
            && !self.page_closed()
        {
            recording.fail(error);
        }
        {
            let mut state = self.state.lock().unwrap();
            state.accepting = false;
            state.delayed_ack = None;
            state.immediate_acks.clear();
        }
        if registered && !self.page_closed() {
            self.stop_cast(&recording).await;
        }
        self.finish();
        recording.pages.lock().unwrap().remove(&self.identifier);
    }

    async fn acknowledge_frames(
        &self,
        stopping: &mut watch::Receiver<bool>,
    ) -> Result<(), ErrorRecord> {
        let mut page_changes = self.page.state.changed.subscribe();
        loop {
            if *stopping.borrow() || self.page_closed() {
                return Ok(());
            }
            let (acknowledgement, deadline) = {
                let mut state = self.state.lock().unwrap();
                if state
                    .delayed_ack
                    .is_some_and(|(_, deadline)| deadline <= Instant::now())
                {
                    let (session, _) = state.delayed_ack.take().unwrap();
                    state.acknowledge(session)?;
                }
                (
                    state.immediate_acks.pop_front(),
                    state.delayed_ack.map(|(_, deadline)| deadline),
                )
            };
            if let Some(session) = acknowledgement {
                tokio::select! {
                    biased;
                    _ = stopping.changed() => return Ok(()),
                    result = timeout(COMMAND_BUDGET, self.page.state.while_alive("context.trace.filmstrip.ack", self.connection.call("Page.screencastFrameAck", json!({"sessionId":session}), Some(&self.page.session_identifier)))) => {
                        result.unwrap_or_else(|_| Err(command_timeout("ack")))?;
                    }
                }
                continue;
            }
            tokio::select! {
                biased;
                _ = stopping.changed() => return Ok(()),
                _ = page_changes.changed() => {},
                _ = self.changed.notified() => {},
                _ = sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {},
            }
        }
    }

    /// An uncertain stop keeps the page owner quarantined until a late reply or page closure.
    async fn stop_cast(&self, recording: &Filmstrip) {
        let mut command = match self.connection.start_command(
            "Page.stopScreencast",
            json!({}),
            Some(&self.page.session_identifier),
        ) {
            Ok(command) => command,
            Err(error) => {
                recording.fail(error);
                let _ = self
                    .page
                    .state
                    .while_alive::<()>("context.trace.filmstrip.stop", std::future::pending())
                    .await;
                return;
            }
        };
        let stopped = timeout(
            COMMAND_BUDGET,
            self.page
                .state
                .while_alive("context.trace.filmstrip.stop", command.response()),
        )
        .await;
        match stopped {
            Ok(Ok(_)) => {}
            _ if self.page_closed() => {}
            Err(_) => {
                recording.fail(command_timeout("stop"));
                if self
                    .page
                    .state
                    .while_alive("context.trace.filmstrip.stop", command.response())
                    .await
                    .is_err()
                    && !self.page_closed()
                {
                    let _ = self
                        .page
                        .state
                        .while_alive::<()>("context.trace.filmstrip.stop", std::future::pending())
                        .await;
                }
            }
            Ok(Err(error)) => {
                recording.fail(error);
                let _ = self
                    .page
                    .state
                    .while_alive::<()>("context.trace.filmstrip.stop", std::future::pending())
                    .await;
            }
        }
    }

    fn finish(&self) {
        let never_started = self.started.borrow().is_none();
        if never_started {
            self.started
                .send_replace(Some(Err(crate::closed("context.trace.filmstrip.start"))));
        }
        self.reservation.lock().unwrap().take();
        self.finished.send_replace(true);
    }
}

fn protocol_error(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, "context.trace.filmstrip", message)
}
fn command_timeout(stage: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Timeout,
        "context.trace.filmstrip",
        format!("screencast {stage} did not settle within two seconds"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> CaptureState {
        CaptureState {
            accepting: true,
            retired_cast: 0,
            current_cast: None,
            unthrottled_until: Instant::now(),
            delayed_ack: None,
            immediate_acks: VecDeque::new(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn activity_releases_the_pending_ack_once_and_extends_the_window() {
        let mut state = idle();
        state.delayed_ack = Some((7, Instant::now() + THROTTLE));
        state.activity().unwrap();
        assert!(state.delayed_ack.is_none());
        assert_eq!(state.immediate_acks.pop_front(), Some(7));
        tokio::time::advance(Duration::from_millis(400)).await;
        assert!(Instant::now() < state.unthrottled_until);
        state.activity().unwrap();
        assert!(state.immediate_acks.is_empty());
        tokio::time::advance(Duration::from_millis(400)).await;
        assert!(Instant::now() < state.unthrottled_until);
        tokio::time::advance(Duration::from_millis(101)).await;
        assert!(Instant::now() > state.unthrottled_until);
    }

    #[test]
    fn stalled_ack_replies_cannot_grow_the_pending_queue_without_bound() {
        let mut state = idle();
        for _ in 0..MAXIMUM_PENDING_ACKS {
            state.acknowledge(9).unwrap();
        }
        assert_eq!(
            state.acknowledge(9).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(state.immediate_acks.len(), MAXIMUM_PENDING_ACKS);
    }

    struct Peer {
        reader: tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
        writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    }

    impl Peer {
        async fn command(&mut self) -> serde_json::Value {
            use tokio::io::AsyncBufReadExt;
            let mut bytes = Vec::new();
            self.reader.read_until(0, &mut bytes).await.unwrap();
            serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap()
        }

        async fn reply(&mut self, command: &serde_json::Value) {
            use tokio::io::AsyncWriteExt;
            self.writer
                .write_all(format!("{}\0", json!({"id":command["id"],"result":{}})).as_bytes())
                .await
                .unwrap();
        }
    }

    fn fixture() -> (Arc<Filmstrip>, Page, Connection, Peer) {
        let (host, peer) = tokio::io::duplex(65536);
        let (reader, writer) = tokio::io::split(host);
        let connection = Connection::new(reader, writer);
        let (reader, writer) = tokio::io::split(peer);
        let page = Page {
            context_identifier: "context".into(),
            target_identifier: "target".into(),
            session_identifier: "session".into(),
            state: Arc::new(crate::PageState::default()),
        };
        let recording = Filmstrip::new(
            "context".into(),
            "generation".into(),
            None,
            Arc::new(super::super::FrameBudget::default()),
        );
        (
            recording,
            page,
            connection,
            Peer {
                reader: tokio::io::BufReader::new(reader),
                writer,
            },
        )
    }

    fn frame(cast: u64) -> String {
        json!({"sessionId":cast,"data":"/9gA/9k=","metadata":{"deviceWidth":800,"deviceHeight":600,"timestamp":1700000000}}).to_string()
    }

    async fn started(
        recording: &Arc<Filmstrip>,
        page: Page,
        connection: Connection,
        peer: &mut Peer,
    ) -> Arc<PageCapture> {
        let capture =
            PageCapture::start(recording, "page".into(), page, connection, 800, 600).unwrap();
        let command = peer.command().await;
        assert_eq!(command["method"], "Page.startScreencast");
        peer.reply(&command).await;
        capture.wait_started().await.unwrap();
        capture
    }

    async fn stopped(recording: &Filmstrip, capture: &PageCapture, peer: &mut Peer) {
        recording.close();
        let command = peer.command().await;
        assert_eq!(command["method"], "Page.stopScreencast");
        peer.reply(&command).await;
        capture.wait_finished().await;
    }

    #[tokio::test(start_paused = true)]
    async fn intervening_frame_ack_does_not_release_the_pending_throttle() {
        let (recording, page, connection, mut peer) = fixture();
        let capture = started(&recording, page, connection, &mut peer).await;
        capture.receive(&frame(1), true);
        capture.receive(&frame(1), true);
        let immediate = peer.command().await;
        assert_eq!(immediate["method"], "Page.screencastFrameAck");
        assert_eq!(immediate["params"]["sessionId"], 1);
        assert!(capture.state.lock().unwrap().delayed_ack.is_some());
        assert_eq!(
            recording.frames.lock().unwrap().claim(128).unwrap().len(),
            1
        );
        peer.reply(&immediate).await;
        capture.activity("context", "old-generation");
        capture.activity("different-context", "generation");
        assert!(capture.state.lock().unwrap().delayed_ack.is_some());
        capture.activity("context", "generation");
        let released = peer.command().await;
        assert_eq!(released["method"], "Page.screencastFrameAck");
        assert!(capture.state.lock().unwrap().delayed_ack.is_none());
        peer.reply(&released).await;
        stopped(&recording, &capture, &mut peer).await;
    }

    #[tokio::test(start_paused = true)]
    async fn sealing_discards_a_delayed_ack_before_stopping_the_cast() {
        let (recording, page, connection, mut peer) = fixture();
        let capture = started(&recording, page, connection, &mut peer).await;
        capture.receive(&frame(1), true);
        assert!(capture.state.lock().unwrap().delayed_ack.is_some());
        stopped(&recording, &capture, &mut peer).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(
            timeout(Duration::from_millis(1), peer.command())
                .await
                .is_err()
        );
        assert!(capture.state.lock().unwrap().delayed_ack.is_none());
        assert_eq!(recording.budget.pages.available_permits(), 128);
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_stop_reply_keeps_ownership_after_the_foreground_budget() {
        let (recording, page, connection, mut peer) = fixture();
        let capture = started(&recording, page.clone(), connection, &mut peer).await;
        recording.close();
        let stop = peer.command().await;
        assert_eq!(stop["method"], "Page.stopScreencast");
        tokio::time::advance(COMMAND_BUDGET + Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(!capture.finished());
        assert_eq!(recording.budget.pages.available_permits(), 127);
        assert!(
            !page
                .state
                .filmstrip_capture
                .lock()
                .unwrap()
                .upgrade()
                .unwrap()
                .finished()
        );
        assert_eq!(
            recording.frames.lock().unwrap().failure().unwrap().code,
            ErrorCode::Timeout
        );
        peer.reply(&stop).await;
        capture.wait_finished().await;
        assert_eq!(recording.budget.pages.available_permits(), 128);
    }

    #[tokio::test(start_paused = true)]
    async fn canceled_start_still_stops_in_wire_order_and_ignores_late_start_reply() {
        let (recording, page, connection, mut peer) = fixture();
        let capture =
            PageCapture::start(&recording, "page".into(), page, connection, 800, 600).unwrap();
        let start = peer.command().await;
        recording.close();
        assert!(capture.wait_started().await.is_err());
        let stop = peer.command().await;
        assert_eq!(start["method"], "Page.startScreencast");
        assert_eq!(stop["method"], "Page.stopScreencast");
        peer.reply(&start).await;
        assert!(!capture.finished());
        peer.reply(&stop).await;
        capture.wait_finished().await;
        assert_eq!(recording.budget.pages.available_permits(), 128);
    }

    #[tokio::test(start_paused = true)]
    async fn old_cast_frames_are_acknowledged_but_never_admitted_into_a_restart() {
        let (recording, page, connection, mut peer) = fixture();
        let capture = started(&recording, page.clone(), connection.clone(), &mut peer).await;
        capture.receive(&frame(1), true);
        stopped(&recording, &capture, &mut peer).await;
        let next = Filmstrip::new(
            "context".into(),
            "next".into(),
            None,
            recording.budget.clone(),
        );
        let replacement = started(&next, page, connection, &mut peer).await;
        replacement.receive(&frame(1), true);
        let old_ack = peer.command().await;
        assert_eq!(old_ack["params"]["sessionId"], 1);
        peer.reply(&old_ack).await;
        assert!(next.frames.lock().unwrap().claim(128).unwrap().is_empty());
        replacement.receive(&frame(2), true);
        assert_eq!(next.frames.lock().unwrap().claim(128).unwrap().len(), 1);
        stopped(&next, &replacement, &mut peer).await;
    }

    #[tokio::test(start_paused = true)]
    async fn input_activity_uses_only_the_operations_original_context_and_chunk() {
        let (recording, page, connection, mut peer) = fixture();
        let capture = started(&recording, page.clone(), connection, &mut peer).await;
        let (_sender, receiver) = watch::channel(false);
        let operation = || crate::Operation::new("locator.run".into(), None, receiver.clone());
        let baseline = capture.state.lock().unwrap().unthrottled_until;
        page.trace_before_input(&operation());
        for (context, generation) in [("other", "generation"), ("context", "retired")] {
            page.trace_before_input(&operation().with_trace_call(Some(
                flashwright_protocol::TraceCall {
                    context: context.into(),
                    generation: generation.into(),
                },
            )));
        }
        assert_eq!(capture.state.lock().unwrap().unthrottled_until, baseline);
        let original = operation().with_trace_call(Some(flashwright_protocol::TraceCall {
            context: "context".into(),
            generation: "generation".into(),
        }));
        page.trace_before_input(&original);
        assert_eq!(
            capture.state.lock().unwrap().unthrottled_until,
            Instant::now() + ACTIVITY
        );
        stopped(&recording, &capture, &mut peer).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let sealed = capture.state.lock().unwrap().unthrottled_until;
        page.trace_before_input(&original);
        assert_eq!(capture.state.lock().unwrap().unthrottled_until, sealed);
    }

    #[tokio::test(start_paused = true)]
    async fn malformed_frame_fails_the_recording_and_preserves_the_shared_connection() {
        let (recording, page, connection, mut peer) = fixture();
        let capture = started(&recording, page, connection.clone(), &mut peer).await;
        capture.receive("null", true);
        assert_eq!(
            recording.frames.lock().unwrap().failure().unwrap().code,
            ErrorCode::Protocol
        );
        let stop = peer.command().await;
        assert_eq!(stop["method"], "Page.stopScreencast");
        peer.reply(&stop).await;
        capture.wait_finished().await;
        let mut successor = connection
            .start_command(
                "Runtime.evaluate",
                json!({"expression":"42"}),
                Some("session"),
            )
            .unwrap();
        let command = peer.command().await;
        peer.reply(&command).await;
        assert!(successor.response().await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn recording_closure_before_the_task_first_polls_still_owns_stop() {
        let (recording, page, connection, mut peer) = fixture();
        let budget = recording.budget.clone();
        let capture =
            PageCapture::start(&recording, "page".into(), page, connection, 800, 600).unwrap();
        recording.close();
        drop(recording);
        let start = peer.command().await;
        assert_eq!(start["method"], "Page.startScreencast");
        let stop = peer.command().await;
        assert_eq!(stop["method"], "Page.stopScreencast");
        assert_eq!(budget.pages.available_permits(), 127);
        peer.reply(&start).await;
        peer.reply(&stop).await;
        capture.wait_finished().await;
        assert_eq!(budget.pages.available_permits(), 128);
    }
}
