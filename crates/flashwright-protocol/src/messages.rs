use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CAPABILITY_INVENTORY_VERSION, PACKAGE_VERSION, PROTOCOL_VERSION};

/// Internal queue entries preserve already encoded replies without serializing them twice.
#[derive(Debug)]
pub enum DriverOutput {
    Message(DriverMessage),
    Frame(crate::EncodedFrame),
    Attachment(crate::AttachmentStream),
}

impl From<DriverMessage> for DriverOutput {
    fn from(message: DriverMessage) -> Self {
        Self::Message(message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLimits {
    pub control_frame_bytes: usize,
    pub pending_operations: usize,
    pub queued_messages: usize,
    pub value_depth: usize,
    pub value_nodes: usize,
    pub binary_attachment_bytes: usize,
    pub pending_attachments: usize,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            control_frame_bytes: 8 * 1024 * 1024,
            pending_operations: 1024,
            queued_messages: 128,
            value_depth: 64,
            value_nodes: 100_000,
            binary_attachment_bytes: 32 * 1024 * 1024,
            pending_attachments: 2,
        }
    }
}

impl ResourceLimits {
    /// Negotiate only positive limits, never silently exceeding either party's advertised bounds.
    pub fn negotiate(&self, peer: &Self) -> Result<Self, ErrorRecord> {
        let limits = Self {
            control_frame_bytes: self.control_frame_bytes.min(peer.control_frame_bytes),
            pending_operations: self.pending_operations.min(peer.pending_operations),
            queued_messages: self.queued_messages.min(peer.queued_messages),
            value_depth: self.value_depth.min(peer.value_depth),
            value_nodes: self.value_nodes.min(peer.value_nodes),
            binary_attachment_bytes: self
                .binary_attachment_bytes
                .min(peer.binary_attachment_bytes),
            pending_attachments: self.pending_attachments.min(peer.pending_attachments),
        };
        if limits.control_frame_bytes < 1024
            || limits.pending_operations == 0
            || limits.queued_messages == 0
            || limits.value_depth == 0
            || limits.value_nodes == 0
            || limits.binary_attachment_bytes == 0
            || limits.pending_attachments == 0
        {
            return Err(ErrorRecord::new(
                ErrorCode::InvalidArgument,
                "handshake",
                "resource limits must be positive and control frames must allow at least 1024 bytes",
            ));
        }
        Ok(limits)
    }

    /// Bound total payload work as well as byte size; containers count as values.
    pub fn validate_value(&self, value: &Value) -> Result<(), ErrorRecord> {
        let mut pending = vec![(value, 1_usize)];
        let mut count = 0;
        while let Some((value, depth)) = pending.pop() {
            count += 1;
            if count > self.value_nodes || depth > self.value_depth {
                return Err(Self::value_limit_error());
            }
            let children = match value {
                Value::Array(values) => values.len(),
                Value::Object(values) => values.len(),
                _ => 0,
            };
            if children > self.value_nodes.saturating_sub(count + pending.len())
                || (children > 0 && depth == self.value_depth)
            {
                return Err(Self::value_limit_error());
            }
            match value {
                Value::Array(values) => {
                    pending.extend(values.iter().map(|value| (value, depth + 1)))
                }
                Value::Object(values) => {
                    pending.extend(values.values().map(|value| (value, depth + 1)));
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Dynamic diagnostics share one value budget; fixed error-envelope metadata remains
    /// available even when the negotiated payload budget cannot represent the original failure.
    pub fn validate_error(&self, error: &ErrorRecord) -> Result<(), ErrorRecord> {
        let text_nodes = error
            .message_utf16
            .as_ref()
            .map_or(0, |units| units.len().saturating_add(1));
        if text_nodes > self.value_nodes
            || (error
                .message_utf16
                .as_ref()
                .is_some_and(|units| !units.is_empty())
                && self.value_depth < 2)
        {
            return Err(Self::value_limit_error());
        }
        if let Some(diagnostics) = &error.diagnostics {
            let mut remaining = self.clone();
            remaining.value_nodes -= text_nodes;
            remaining.validate_value(diagnostics)?;
        }
        Ok(())
    }

    fn value_limit_error() -> ErrorRecord {
        ErrorRecord::new(
            ErrorCode::ResourceLimit,
            "protocol",
            "control value exceeds negotiated depth or node limits",
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handshake {
    pub package_version: String,
    pub protocol_version: u32,
    pub capability_inventory_version: u32,
    pub limits: ResourceLimits,
}

impl Default for Handshake {
    fn default() -> Self {
        Self {
            package_version: PACKAGE_VERSION.to_owned(),
            protocol_version: PROTOCOL_VERSION,
            capability_inventory_version: CAPABILITY_INVENTORY_VERSION,
            limits: ResourceLimits::default(),
        }
    }
}

impl Handshake {
    pub fn validate(&self) -> Result<ResourceLimits, ErrorRecord> {
        if self.protocol_version != PROTOCOL_VERSION
            || self.capability_inventory_version != CAPABILITY_INVENTORY_VERSION
            || self.package_version != PACKAGE_VERSION
        {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                "handshake",
                "package, protocol or capability inventory version mismatch",
            ));
        }
        ResourceLimits::default().negotiate(&self.limits)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ClientMessage {
    Handshake {
        handshake: Handshake,
    },
    Command {
        #[serde(rename = "requestId")]
        request_id: u64,
        method: String,
        parameters: Value,
        #[serde(rename = "timeoutMilliseconds")]
        timeout_milliseconds: Option<u64>,
    },
    Cancel {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DriverMessage {
    Event {
        target: String,
        event: String,
        parameters: Value,
    },
    Handshake {
        handshake: Handshake,
        capabilities: Vec<String>,
        #[serde(rename = "residentRuntimeSha256")]
        resident_runtime_sha256: String,
        #[serde(rename = "browserIdentity")]
        browser_identity: Option<String>,
        #[serde(rename = "browserEncodings")]
        browser_encodings: Vec<String>,
    },
    Result {
        #[serde(rename = "requestId")]
        request_id: u64,
        value: Value,
        #[serde(rename = "inputDelivery")]
        input_delivery: InputDelivery,
    },
    Error {
        #[serde(rename = "requestId")]
        request_id: Option<u64>,
        error: ErrorRecord,
    },
}

impl DriverMessage {
    /// Encode a borrowed result without cloning potentially large value graphs.
    pub fn encode_result(
        request_id: u64,
        value: &Value,
        input_delivery: InputDelivery,
        maximum_bytes: usize,
    ) -> Result<crate::EncodedFrame, crate::FrameError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ResultMessage<'value> {
            kind: &'static str,
            request_id: u64,
            value: &'value Value,
            input_delivery: InputDelivery,
        }
        crate::EncodedFrame::encode(
            &ResultMessage {
                kind: "result",
                request_id,
                value,
                input_delivery,
            },
            maximum_bytes,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorCode {
    #[serde(rename = "UnsupportedFeatureError")]
    UnsupportedFeature,
    #[serde(rename = "InvalidArgumentError")]
    InvalidArgument,
    #[serde(rename = "TimeoutError")]
    Timeout,
    #[serde(rename = "TargetClosedError")]
    TargetClosed,
    #[serde(rename = "BrowserDisconnectedError")]
    BrowserDisconnected,
    #[serde(rename = "ProtocolError")]
    Protocol,
    #[serde(rename = "ResourceLimitError")]
    ResourceLimit,
    #[serde(rename = "CancelledError")]
    Cancelled,
    #[serde(rename = "EvaluationError")]
    Evaluation,
    #[serde(rename = "NavigationError")]
    Navigation,
    #[serde(rename = "PageCrashedError")]
    PageCrashed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorDetails {
    pub code: ErrorCode,
    pub method: Box<str>,
    pub message: Box<str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_utf16: Option<Box<[u16]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<Box<str>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Box<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_error_code: Option<i64>,
    pub reference_version: Box<str>,
    pub browser: Box<str>,
    pub input_delivery: InputDelivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputDelivery {
    NotDispatched,
    Acknowledged,
    Uncertain,
}

/// Keep operation results small as optional failure diagnostics grow.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ErrorRecord(Box<ErrorDetails>);

impl std::ops::Deref for ErrorRecord {
    type Target = ErrorDetails;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for ErrorRecord {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl ErrorRecord {
    pub fn new(code: ErrorCode, method: impl Into<String>, message: impl Into<String>) -> Self {
        Self(Box::new(ErrorDetails {
            code,
            method: method.into().into_boxed_str(),
            message: message.into().into_boxed_str(),
            message_utf16: None,
            cleanup: None,
            diagnostics: None,
            browser_error_code: None,
            reference_version: "1.60.0".into(),
            browser: "chromium".into(),
            input_delivery: InputDelivery::NotDispatched,
        }))
    }
}
