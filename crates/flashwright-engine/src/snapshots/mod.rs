//! Original-document workers own capture transactions independently of waiting callers.

mod archive;
mod budget;
mod document;
mod outcome;
mod sessions;

pub(crate) use archive::{SnapshotArchive, SnapshotMetadata};
pub(crate) use budget::SnapshotBudget;
pub(crate) use document::{
    CaptureOptions, PreparedSnapshot, SnapshotDecision, SnapshotDocument, SnapshotFrame,
    SnapshotNode, SnapshotRealm,
};
pub(crate) use outcome::{SnapshotFailure, SnapshotUnavailable};
pub(crate) use sessions::SnapshotSessions;
