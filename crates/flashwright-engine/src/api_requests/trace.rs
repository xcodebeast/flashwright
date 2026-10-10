//! Optional per-wire-attempt metadata keeps its original request-context custody.

use super::budget::PairedReservation;
use super::exchange::{Header, ResponseMetadata};
use super::registry::RequestContext;
use crate::Engine;
use flashwright_protocol::{DriverOutput, EncodedFrame};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;

const MAXIMUM_TRACE_FRAME_BYTES: usize = 256 * 1024;
const MAXIMUM_TRACE_HEADER_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TraceCapture {
    pub(super) generation: String,
    pub(super) call: String,
}

impl TraceCapture {
    pub(super) fn valid(&self) -> bool {
        [self.generation.as_str(), self.call.as_str()]
            .iter()
            .all(|value| !value.is_empty() && value.len() <= 128 && value.is_ascii())
    }
}

#[derive(Serialize)]
struct AttemptEvent<'value> {
    kind: &'static str,
    target: &'value str,
    event: &'static str,
    parameters: AttemptParameters<'value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttemptParameters<'value> {
    generation: &'value str,
    call: &'value str,
    attempt: &'value str,
    url: &'value str,
    method: &'value str,
    request_headers: &'value [Header],
    request_body_size: usize,
    status: u16,
    status_text: &'value str,
    http_version: &'static str,
    response_headers: &'value [Header],
    response_body_size: Option<usize>,
    started_wall_time: f64,
    elapsed_milliseconds: f64,
}

#[derive(Serialize)]
struct FailureEvent<'value> {
    kind: &'static str,
    target: &'value str,
    event: &'static str,
    parameters: FailureParameters<'value>,
}

#[derive(Serialize)]
struct FailureParameters<'value> {
    generation: &'value str,
    call: &'value str,
    message: &'static str,
}

#[derive(Debug)]
struct TraceCustody {
    _context: Arc<RequestContext>,
    _reservation: PairedReservation,
}

pub(super) struct WireAttempt<'value> {
    pub(super) identifier: &'value str,
    pub(super) url: &'value str,
    pub(super) method: &'value str,
    pub(super) request_headers: &'value [Header],
    pub(super) request_body_size: usize,
    pub(super) response: &'value ResponseMetadata,
    pub(super) response_body_size: Option<usize>,
    pub(super) started_wall_time: f64,
    pub(super) started: Instant,
}

pub(super) async fn record_attempt(
    engine: &Engine,
    context: &Arc<RequestContext>,
    capture: &TraceCapture,
    attempt: WireAttempt<'_>,
) {
    let header_bytes = attempt
        .request_headers
        .iter()
        .chain(&attempt.response.headers)
        .fold(0usize, |total, header| {
            total
                .saturating_add(header.name.len())
                .saturating_add(header.value.len())
                .saturating_add(64)
        });
    let overhead = attempt
        .url
        .len()
        .saturating_add(attempt.method.len())
        .saturating_add(attempt.response.status_text.len());
    if header_bytes.saturating_add(overhead) > MAXIMUM_TRACE_HEADER_BYTES {
        fail(
            engine,
            context,
            capture,
            "API trace attempt metadata exceeds its bounded event allowance",
        )
        .await;
        return;
    }
    let custody = match context
        .budget
        .metadata
        .reserve(MAXIMUM_TRACE_FRAME_BYTES * 2, "apiRequest.trace")
    {
        Ok(reservation) => Arc::new(TraceCustody {
            _context: context.clone(),
            _reservation: reservation,
        }),
        Err(_) => {
            fail(
                engine,
                context,
                capture,
                "API trace event could not reserve its original metadata credit",
            )
            .await;
            return;
        }
    };
    let event = AttemptEvent {
        kind: "event",
        target: &context.identifier,
        event: "apiRequest.traceAttempt",
        parameters: AttemptParameters {
            generation: &capture.generation,
            call: &capture.call,
            attempt: attempt.identifier,
            url: attempt.url,
            method: attempt.method,
            request_headers: attempt.request_headers,
            request_body_size: attempt.request_body_size,
            status: attempt.response.status,
            status_text: &attempt.response.status_text,
            http_version: match attempt.response.version {
                http::Version::HTTP_09 => "0.9",
                http::Version::HTTP_10 => "1.0",
                http::Version::HTTP_11 => "1.1",
                http::Version::HTTP_2 => "2.0",
                http::Version::HTTP_3 => "3.0",
                _ => "?",
            },
            response_headers: &attempt.response.headers,
            response_body_size: attempt.response_body_size,
            started_wall_time: attempt.started_wall_time,
            elapsed_milliseconds: attempt.started.elapsed().as_secs_f64() * 1000.0,
        },
    };
    let mut frame = match EncodedFrame::encode(
        &event,
        engine
            .maximum_control_frame_bytes
            .min(MAXIMUM_TRACE_FRAME_BYTES),
    ) {
        Ok(frame) => frame,
        Err(_) => {
            fail(
                engine,
                context,
                capture,
                "API trace attempt exceeded its encoded event allowance",
            )
            .await;
            return;
        }
    };
    frame.retain_reservation(custody);
    let _ = engine.outgoing.send(DriverOutput::Frame(frame)).await;
}

async fn fail(
    engine: &Engine,
    context: &Arc<RequestContext>,
    capture: &TraceCapture,
    message: &'static str,
) {
    let event = FailureEvent {
        kind: "event",
        target: &context.identifier,
        event: "apiRequest.traceFailure",
        parameters: FailureParameters {
            generation: &capture.generation,
            call: &capture.call,
            message,
        },
    };
    if let Ok(mut frame) =
        EncodedFrame::encode(&event, engine.maximum_control_frame_bytes.min(4096))
    {
        frame.retain_reservation(context.clone());
        let _ = engine.outgoing.send(DriverOutput::Frame(frame)).await;
    }
}
