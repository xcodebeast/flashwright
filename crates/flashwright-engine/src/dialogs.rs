//! JavaScript dialogs bind public metadata and browser handling to one original modal occurrence.

mod control;
mod events;
mod handling;
mod state;
pub use handling::PreparedDialogHandling;

pub(crate) use state::{DialogBudget, DialogState};
