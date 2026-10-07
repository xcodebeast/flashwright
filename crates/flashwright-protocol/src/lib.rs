//! The versioned TypeScript ↔ Rust control protocol, separate from Chromium CDP.

pub mod framing;
pub mod messages;

pub use framing::{FrameError, FrameReader, FrameWriter};
pub use messages::{
    ClientMessage, DriverMessage, ErrorCode, ErrorRecord, Handshake, InputDelivery, ResourceLimits,
};

pub const PROTOCOL_VERSION: u32 = 4;
pub const CAPABILITY_INVENTORY_VERSION: u32 = 1;
pub const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");
