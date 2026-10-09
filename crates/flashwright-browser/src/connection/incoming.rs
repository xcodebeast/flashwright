//! Bound wire storage independently from the explicitly admitted reply representation.

use std::borrow::Cow;
use std::sync::{Arc, Weak};

use flashwright_protocol::attachment::MAXIMUM_ATTACHMENT_BYTES;
use flashwright_protocol::{AttachmentEncoding, BinaryPayload, ErrorCode, ErrorRecord};
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::oneshot;

mod request_event;

use super::{
    ConnectionState, MAXIMUM_CONTROL_BYTES, Reply, disconnected, dispatch_event, fail_connection,
    protocol_error,
};

// A valid raw body can encode every byte as a six-byte JSON escape. Base64 is smaller.
const MAXIMUM_WIRE_BYTES: usize = MAXIMUM_ATTACHMENT_BYTES * 6 + 64 * 1024;
const RETAINED_BUFFER_BYTES: usize = 64 * 1024;

pub(super) enum ReplySender {
    Value(oneshot::Sender<Reply>),
    Raw(oneshot::Sender<Reply<Box<RawValue>>>),
    Binary {
        kind: BinaryReplyKind,
        sender: oneshot::Sender<Reply<BinaryPayload>>,
        maximum_decoded_bytes: usize,
    },
}

pub(super) enum BinaryReplyKind {
    ResponseBody,
    Screenshot,
}

#[derive(Deserialize)]
struct Screenshot<'message> {
    #[serde(borrow)]
    data: Cow<'message, str>,
}

fn decode_screenshot(
    result: Option<&RawValue>,
    maximum_decoded_bytes: usize,
) -> Reply<BinaryPayload> {
    let result =
        result.ok_or_else(|| protocol_error("browser omitted screenshot data".to_owned()))?;
    let screenshot: Screenshot<'_> =
        serde_json::from_str(result.get()).map_err(|error| protocol_error(error.to_string()))?;
    let bytes = match screenshot.data {
        Cow::Borrowed(data) => Cow::Borrowed(data.as_bytes()),
        Cow::Owned(data) => Cow::Owned(data.into_bytes()),
    };
    BinaryPayload::new(
        bytes,
        AttachmentEncoding::Base64,
        maximum_decoded_bytes,
        "Page.captureScreenshot",
    )
}

#[derive(Deserialize)]
struct Envelope<'message> {
    id: Option<u64>,
    #[serde(borrow)]
    method: Option<Cow<'message, str>>,
    #[serde(rename = "sessionId", borrow)]
    session_identifier: Option<Cow<'message, str>>,
    #[serde(borrow)]
    params: Option<&'message RawValue>,
    #[serde(borrow)]
    result: Option<&'message RawValue>,
    #[serde(borrow)]
    error: Option<&'message RawValue>,
}

#[derive(Deserialize)]
struct ResponseBody<'message> {
    #[serde(borrow)]
    body: Cow<'message, str>,
    #[serde(rename = "base64Encoded")]
    base64_encoded: bool,
}

impl ReplySender {
    pub(super) fn fail(self, error: ErrorRecord) {
        match self {
            Self::Value(sender) => {
                let _ = sender.send(Err(error));
            }
            Self::Raw(sender) => {
                let _ = sender.send(Err(error));
            }
            Self::Binary { sender, .. } => {
                let _ = sender.send(Err(error));
            }
        }
    }

    fn complete(self, envelope: &Envelope<'_>, frame_bytes: usize) {
        if let Some(error) = envelope.error {
            if frame_bytes > MAXIMUM_CONTROL_BYTES {
                self.fail(resource_error(
                    "CDP error reply exceeds control-message limit",
                ));
                return;
            }
            let mut record = protocol_error(error.get().to_owned());
            record.browser_error_code = serde_json::from_str::<Value>(error.get())
                .ok()
                .and_then(|value| value["code"].as_i64());
            self.fail(record);
            return;
        }
        match self {
            Self::Raw(sender) => {
                let result = if frame_bytes > MAXIMUM_CONTROL_BYTES {
                    Err(resource_error("CDP reply exceeds control-message limit"))
                } else {
                    envelope
                        .result
                        .map(RawValue::to_owned)
                        .ok_or_else(|| protocol_error("browser omitted the command result".into()))
                };
                let _ = sender.send(result);
            }
            Self::Value(sender) => {
                let result = if frame_bytes > MAXIMUM_CONTROL_BYTES {
                    Err(resource_error("CDP reply exceeds control-message limit"))
                } else {
                    envelope
                        .result
                        .map(|result| {
                            serde_json::from_str(result.get())
                                .map_err(|error| protocol_error(error.to_string()))
                        })
                        .unwrap_or(Ok(Value::Null))
                };
                let _ = sender.send(result);
            }
            Self::Binary {
                sender,
                kind,
                maximum_decoded_bytes,
            } => {
                let result = match kind {
                    BinaryReplyKind::ResponseBody => {
                        decode_response_body(envelope.result, maximum_decoded_bytes)
                    }
                    BinaryReplyKind::Screenshot => {
                        decode_screenshot(envelope.result, maximum_decoded_bytes)
                    }
                };
                let _ = sender.send(result);
            }
        }
    }
}

fn decode_response_body(
    result: Option<&RawValue>,
    maximum_decoded_bytes: usize,
) -> Reply<BinaryPayload> {
    let result =
        result.ok_or_else(|| protocol_error("browser omitted response body".to_owned()))?;
    let body: ResponseBody<'_> =
        serde_json::from_str(result.get()).map_err(|error| protocol_error(error.to_string()))?;
    let encoding = if body.base64_encoded {
        AttachmentEncoding::Base64
    } else {
        AttachmentEncoding::Raw
    };
    let bytes = match body.body {
        Cow::Borrowed(body) => Cow::Borrowed(body.as_bytes()),
        Cow::Owned(body) => Cow::Owned(body.into_bytes()),
    };
    BinaryPayload::new(
        bytes,
        encoding,
        maximum_decoded_bytes,
        "Network.getResponseBody",
    )
}

fn resource_error(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, "chromium", message)
}

struct FrameBuffer {
    bytes: Vec<u8>,
    maximum_bytes: usize,
}

impl FrameBuffer {
    fn new(maximum_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            maximum_bytes,
        }
    }

    fn append(&mut self, bytes: &[u8]) -> Result<(), ErrorRecord> {
        let length = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|length| *length <= self.maximum_bytes)
            .ok_or_else(|| resource_error("CDP incoming wire-frame limit exceeded"))?;
        if length > self.bytes.capacity() {
            // Vec's automatic doubling must not reserve beyond the hard wire bound.
            let capacity = length
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.maximum_bytes);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .map_err(|_| resource_error("CDP incoming frame allocation failed"))?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn reset(&mut self) {
        if self.bytes.capacity() > RETAINED_BUFFER_BYTES {
            self.bytes = Vec::new();
        } else {
            self.bytes.clear();
        }
    }
}

fn receive_message(state: &Arc<ConnectionState>, message: &[u8]) -> Result<(), ErrorRecord> {
    let received_at = std::time::Instant::now();
    let envelope: Envelope<'_> =
        serde_json::from_slice(message).map_err(|error| protocol_error(error.to_string()))?;
    if let Some(identifier) = envelope.id {
        // Release the registration lock before parsing a potentially large body.
        let reply = state.pending.lock().unwrap().replies.remove(&identifier);
        if let Some(reply) = reply {
            reply.sender.complete(&envelope, message.len());
        }
    } else if let Some(method) = envelope.method {
        let parameters = if message.len() > MAXIMUM_CONTROL_BYTES {
            if !matches!(
                method.as_ref(),
                "Network.requestWillBeSent" | "Fetch.requestPaused"
            ) {
                return Err(resource_error("CDP event exceeds control-message limit"));
            }
            let parameters = envelope
                .params
                .ok_or_else(|| protocol_error("browser omitted request event parameters".into()))?;
            let overhead = message.len() - parameters.get().len();
            let maximum_bytes = MAXIMUM_CONTROL_BYTES.checked_sub(overhead).ok_or_else(|| {
                resource_error("CDP event envelope exceeds control-message limit")
            })?;
            Some(request_event::project(parameters, maximum_bytes)?)
        } else {
            envelope.params.map(RawValue::to_owned)
        };
        // Opaque event JSON preserves escaped lone UTF-16 surrogates.
        dispatch_event(
            state,
            method.into_owned(),
            envelope.session_identifier.map(Cow::into_owned),
            parameters,
            received_at,
        )?;
    } else {
        return Err(protocol_error(
            "CDP message has neither a reply identity nor an event method".to_owned(),
        ));
    }
    Ok(())
}

pub(super) async fn read_messages<Reader: AsyncRead + Unpin>(
    mut reader: Reader,
    state: Weak<ConnectionState>,
) {
    let mut chunk = [0_u8; 65536];
    let mut message = FrameBuffer::new(MAXIMUM_WIRE_BYTES);
    let failure = 'reading: loop {
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
            if let Err(error) = message.append(&chunk[start..end]) {
                break 'reading error;
            }
            let Some(state) = state.upgrade() else {
                return;
            };
            if let Err(error) = receive_message(&state, &message.bytes) {
                break 'reading error;
            }
            message.reset();
            start = end + 1;
        }
        if let Err(error) = message.append(&chunk[start..length]) {
            break error;
        }
    };
    if let Some(state) = state.upgrade() {
        fail_connection(&state, failure);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn oversized_request_events_keep_bytes_and_wire_order_within_control_admission() {
        let (stream, _peer) = tokio::io::duplex(64);
        let (reader, writer) = tokio::io::split(stream);
        let connection = crate::connection::Connection::new(reader, writer);
        let mut events = connection.subscribe();
        for (index, method) in ["Network.requestWillBeSent", "Fetch.requestPaused"]
            .into_iter()
            .enumerate()
        {
            let message = serde_json::to_vec(&serde_json::json!({"method":method,"sessionId":"original-session","params":{
                "requestId":"original-owner","request":{"postData":"\0".repeat(2 * 1024 * 1024),"postDataEntries":[{"bytes":"AP8="}],"headers":{"X-Original":"kept"}}
            }})).unwrap();
            assert!(message.len() > MAXIMUM_CONTROL_BYTES);
            let before_receipt = std::time::Instant::now();
            receive_message(&connection.inner, &message).unwrap();
            let event = events.try_recv().unwrap();
            assert!(event.received_at >= before_receipt);
            assert!(event.received_at <= std::time::Instant::now());
            assert_eq!(event.sequence, index as u64 + 1);
            assert_eq!(event.method, method);
            assert_eq!(
                event.session_identifier.as_deref(),
                Some("original-session")
            );
            let raw = event.parameters.unwrap();
            assert!(raw.get().len() < MAXIMUM_CONTROL_BYTES);
            let parameters: Value = serde_json::from_str(raw.get()).unwrap();
            assert!(parameters["request"].get("postData").is_none());
            assert_eq!(parameters["request"]["postDataEntries"][0]["bytes"], "AP8=");
            assert_eq!(parameters["request"]["headers"]["X-Original"], "kept");
            assert_eq!(parameters["requestId"], "original-owner");
        }
    }

    #[tokio::test]
    async fn projection_does_not_admit_oversized_entries_envelopes_or_unrelated_events() {
        let (stream, _peer) = tokio::io::duplex(64);
        let (reader, writer) = tokio::io::split(stream);
        let connection = crate::connection::Connection::new(reader, writer);
        let mut events = connection.subscribe();
        let large = "a".repeat(MAXIMUM_CONTROL_BYTES);
        for message in [
            serde_json::json!({"method":"Network.requestWillBeSent","params":{"request":{"postData":"discarded","postDataEntries":[{"bytes":large}]}}}),
            serde_json::json!({"method":"Fetch.requestPaused","sessionId":large,"params":{"request":{"postData":"discarded"}}}),
            serde_json::json!({"method":"Runtime.consoleAPICalled","params":{"request":{"postData":large}}}),
        ] {
            let bytes = serde_json::to_vec(&message).unwrap();
            assert_eq!(
                receive_message(&connection.inner, &bytes).unwrap_err().code,
                ErrorCode::ResourceLimit
            );
            assert!(events.try_recv().is_err());
        }
    }

    #[test]
    fn screenshot_shape_requires_canonical_base64_within_the_decoded_bound() {
        let valid = serde_json::from_str::<&RawValue>(r#"{"data":"AP8="}"#).unwrap();
        assert_eq!(decode_screenshot(Some(valid), 2).unwrap().decoded_length, 2);
        assert_eq!(
            decode_screenshot(Some(valid), 1).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        let invalid = serde_json::from_str::<&RawValue>(r#"{"data":"AB=="}"#).unwrap();
        assert_eq!(
            decode_screenshot(Some(invalid), 2).unwrap_err().code,
            ErrorCode::Protocol
        );
    }

    #[test]
    fn receive_buffer_obeys_allocation_bound_and_releases_large_frames() {
        let mut buffer = FrameBuffer::new(150_000);
        buffer.append(&vec![42; 70_000]).unwrap();
        buffer.append(&vec![42; 70_000]).unwrap();
        buffer.append(&[42; 10_000]).unwrap();
        assert!(buffer.bytes.capacity() <= 150_000);
        assert_eq!(
            buffer.append(&[42]).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(buffer.bytes.len(), 150_000);
        buffer.reset();
        assert_eq!(buffer.bytes.capacity(), 0);
        buffer.append(b"small").unwrap();
        buffer.reset();
        assert!(buffer.bytes.is_empty());
        assert!(buffer.bytes.capacity() <= RETAINED_BUFFER_BYTES);
    }

    #[test]
    fn typed_body_keeps_binary_and_escaped_text_exact_and_rejects_overflow() {
        for (source, expected, maximum) in [
            (r#"{"body":"AP8=","base64Encoded":true}"#, "AP8=", 2),
            (
                r#"{"body":"\u0000\ud83d\ude00é","base64Encoded":false}"#,
                "\0😀é",
                7,
            ),
        ] {
            let raw: &RawValue = serde_json::from_str(source).unwrap();
            assert_eq!(
                decode_response_body(Some(raw), maximum).unwrap().bytes,
                expected.as_bytes()
            );
            assert_eq!(
                decode_response_body(Some(raw), maximum - 1)
                    .unwrap_err()
                    .code,
                ErrorCode::ResourceLimit
            );
        }
        for source in [
            r#"{"body":"AB==","base64Encoded":true}"#,
            r#"{"body":[],"base64Encoded":false}"#,
            r#"{"body":"missing flag"}"#,
        ] {
            let raw: &RawValue = serde_json::from_str(source).unwrap();
            assert_eq!(
                decode_response_body(Some(raw), 100).unwrap_err().code,
                ErrorCode::Protocol
            );
        }
    }
}
