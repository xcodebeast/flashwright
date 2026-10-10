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
    request_body_present: bool,
    status: u16,
    status_text: &'value str,
    http_version: &'static str,
    response_headers: &'value [Header],
    response_body_size: Option<usize>,
    response_identifier: Option<&'value str>,
    started_wall_time: f64,
    elapsed_milliseconds: f64,
    failed: bool,
}

#[derive(Serialize)]
struct FailureEvent<'value> {
    kind: &'static str,
    target: &'value str,
    event: &'static str,
    parameters: FailureParameters<'value>,
}

#[derive(Serialize)]
struct ScalarFailureEvent<'value> {
    kind: &'static str,
    target: &'value str,
    event: &'static str,
    parameters: &'value str,
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
    pub(super) request_body_present: bool,
    pub(super) response: &'value ResponseMetadata,
    pub(super) response_body_size: Option<usize>,
    pub(super) response_identifier: Option<&'value str>,
    pub(super) started_wall_time: f64,
    pub(super) started: Instant,
}

pub(super) struct FailedAttempt<'value> {
    pub(super) identifier: &'value str,
    pub(super) url: &'value str,
    pub(super) method: &'value str,
    pub(super) request_headers: &'value [Header],
    pub(super) request_body_size: usize,
    pub(super) request_body_present: bool,
    pub(super) started_wall_time: f64,
}

pub(super) async fn record_attempt(
    engine: &Engine,
    context: &Arc<RequestContext>,
    capture: &TraceCapture,
    attempt: WireAttempt<'_>,
) {
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
            request_body_present: attempt.request_body_present,
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
            response_identifier: attempt.response_identifier,
            started_wall_time: attempt.started_wall_time,
            elapsed_milliseconds: attempt.started.elapsed().as_secs_f64() * 1000.0,
            failed: false,
        },
    };
    publish_attempt(engine, context, capture, event).await;
}

pub(super) async fn record_failed_attempt(
    engine: &Engine,
    context: &Arc<RequestContext>,
    capture: &TraceCapture,
    attempt: FailedAttempt<'_>,
) {
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
            request_body_present: attempt.request_body_present,
            status: 0,
            status_text: "",
            http_version: "1.1",
            response_headers: &[],
            response_body_size: None,
            response_identifier: None,
            started_wall_time: attempt.started_wall_time,
            elapsed_milliseconds: 0.0,
            failed: true,
        },
    };
    publish_attempt(engine, context, capture, event).await;
}

async fn publish_attempt(
    engine: &Engine,
    context: &Arc<RequestContext>,
    capture: &TraceCapture,
    event: AttemptEvent<'_>,
) {
    let parameters = &event.parameters;
    let header_bytes = parameters
        .request_headers
        .iter()
        .chain(parameters.response_headers)
        .fold(0usize, |total, header| {
            total
                .saturating_add(header.name.len())
                .saturating_add(header.value.len())
                .saturating_add(64)
        });
    let overhead = parameters
        .url
        .len()
        .saturating_add(parameters.method.len())
        .saturating_add(parameters.status_text.len());
    if header_bytes.saturating_add(overhead) > MAXIMUM_TRACE_HEADER_BYTES
        || parameters
            .request_headers
            .len()
            .saturating_add(parameters.response_headers.len())
            > 512
    {
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
    let parameters = match serde_json::to_value(&event.parameters) {
        Ok(parameters) => parameters,
        Err(_) => {
            fail(
                engine,
                context,
                capture,
                "API trace attempt could not serialize its parameters",
            )
            .await;
            return;
        }
    };
    if engine
        .api_requests
        .limits
        .validate_value(&parameters)
        .is_err()
    {
        fail(
            engine,
            context,
            capture,
            "API trace attempt exceeds negotiated value limits",
        )
        .await;
        return;
    }
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
    let parameters = serde_json::to_value(&event.parameters);
    if parameters
        .as_ref()
        .is_ok_and(|value| engine.api_requests.limits.validate_value(value).is_ok())
        && let Ok(mut frame) =
            EncodedFrame::encode(&event, engine.maximum_control_frame_bytes.min(4096))
    {
        frame.retain_reservation(context.clone());
        let _ = engine.outgoing.send(DriverOutput::Frame(frame)).await;
        return;
    }
    // A scalar retains the recording identity even at valueDepth/valueNodes = 1.
    let fallback = ScalarFailureEvent {
        kind: "event",
        target: &context.identifier,
        event: "apiRequest.traceFailure",
        parameters: &capture.generation,
    };
    if let Ok(mut frame) = EncodedFrame::encode(&fallback, engine.maximum_control_frame_bytes) {
        frame.retain_reservation(context.clone());
        let _ = engine.outgoing.send(DriverOutput::Frame(frame)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::options::ContextOptions;
    use super::*;
    use flashwright_protocol::{FrameWriter, ResourceLimits};
    use serde_json::json;
    use tokio::sync::{mpsc, watch};

    #[tokio::test]
    async fn negotiated_single_node_failure_keeps_the_recording_identity() {
        let limits = ResourceLimits {
            value_depth: 1,
            value_nodes: 1,
            ..ResourceLimits::default()
        };
        let (outgoing, mut receiver) = mpsc::channel(1);
        let (fatal, _) = watch::channel(false);
        let engine = Engine::new(None, outgoing, fatal, limits.clone());
        let context = engine
            .api_requests
            .create(
                "original-context".into(),
                ContextOptions::parse(json!({})).unwrap(),
            )
            .unwrap();
        let capture = TraceCapture {
            generation: "original-generation".into(),
            call: "original-call".into(),
        };
        let structured = serde_json::to_value(FailureParameters {
            generation: &capture.generation,
            call: &capture.call,
            message: "capture failed",
        })
        .unwrap();
        assert!(limits.validate_value(&structured).is_err());
        record_failed_attempt(
            &engine,
            &context,
            &capture,
            FailedAttempt {
                identifier: "attempt-1",
                url: "http://127.0.0.1:1/refused",
                method: "GET",
                request_headers: &[],
                request_body_size: 0,
                request_body_present: false,
                started_wall_time: 1.0,
            },
        )
        .await;
        let DriverOutput::Frame(frame) = receiver.recv().await.unwrap() else {
            panic!("failure frame expected")
        };
        let mut bytes = Vec::new();
        FrameWriter::new(&mut bytes, limits.control_frame_bytes)
            .write_frame(&frame)
            .await
            .unwrap();
        let event: serde_json::Value = serde_json::from_slice(&bytes[4..]).unwrap();
        assert_eq!(event["event"], "apiRequest.traceFailure");
        assert_eq!(event["parameters"], "original-generation");
        assert!(limits.validate_value(&event["parameters"]).is_ok());
    }
}
