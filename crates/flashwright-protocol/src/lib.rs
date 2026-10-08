//! The versioned TypeScript ↔ Rust control protocol, separate from Chromium CDP.

pub mod attachment;
pub mod framing;
pub mod messages;

pub use attachment::{AttachmentEncoding, AttachmentFrame, AttachmentStream, BinaryAttachment};

pub use framing::{EncodedFrame, FrameError, FrameReader, FrameWriter};
pub use messages::{
    ClientMessage, DriverMessage, DriverOutput, ErrorCode, ErrorRecord, Handshake, InputDelivery,
    ResourceLimits,
};

pub const PROTOCOL_VERSION: u32 = 5;
pub const CAPABILITY_INVENTORY_VERSION: u32 = 1;
pub const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");
