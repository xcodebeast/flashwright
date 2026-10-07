//! Owned Chromium processes and multiplexed JSON pipe CDP.

pub mod chromium;
pub mod connection;
pub mod supervision;

pub use chromium::{Chromium, LaunchOptions};
pub use connection::Connection;

mod process_group;
