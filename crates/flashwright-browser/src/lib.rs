//! Owned Chromium processes and multiplexed JSON pipe CDP.

pub mod chromium;
pub mod connection;
pub mod snapshot_reply;
pub mod supervision;
pub mod values;

pub use chromium::{Chromium, LaunchOptions};
pub use connection::Connection;

mod guardian_metadata;
mod guardian_reap_audit;
mod launch_audit;
mod native_resource_capture;
mod process_group;
