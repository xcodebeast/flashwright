//! The versioned TypeScript ↔ Rust control protocol, separate from Chromium CDP.

mod admission;
pub mod attachment;
pub mod framing;
pub mod messages;
mod output_delivery;

pub use output_delivery::{OutputAcknowledgement, OutputBarrier, OutputDelivery};

pub use admission::{
    MINIMUM_DIALOG_PENDING_OPERATIONS, admits_operation, is_recovery_operation,
    ordinary_operation_limit,
};

pub use attachment::{
    AttachmentEncoding, AttachmentFrame, AttachmentStream, BinaryAttachment, BinaryPayload,
    InputAttachment,
};

pub use framing::{EncodedFrame, FrameError, FrameReader, FrameWriter};
pub use messages::{
    ClientFrame, ClientMessage, DriverMessage, DriverOutput, ErrorCode, ErrorRecord, Handshake,
    InputDelivery, ResourceLimits, TraceCall,
};

pub const PROTOCOL_VERSION: u32 = 7;
pub const CAPABILITY_INVENTORY_VERSION: u32 = 1;
pub const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");
