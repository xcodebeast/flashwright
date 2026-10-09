//! Preserve resource and original owner errors through the HTTP connector's error chain.

use flashwright_protocol::{ErrorCode, ErrorRecord};
use std::fmt;

pub(super) type BoxedError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug)]
pub(super) struct TransportError(pub(super) ErrorRecord);

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0.message)
    }
}

impl std::error::Error for TransportError {}

pub(super) fn closed() -> TransportError {
    TransportError(ErrorRecord::new(
        ErrorCode::TargetClosed,
        "apiRequest.fetch",
        "original API request context was disposed",
    ))
}
