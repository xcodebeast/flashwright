//! Lifecycle omissions are distinct from failed admitted diagnostics.

use flashwright_protocol::{ErrorCode, ErrorRecord};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SnapshotUnavailable {
    NoExistingMainContext,
    OriginalDocumentChanged,
    PendingNavigation,
    DialogOpen,
}

#[derive(Clone, Debug)]
pub(crate) enum SnapshotFailure {
    Unavailable(SnapshotUnavailable),
    Failed(ErrorRecord),
}

impl From<ErrorRecord> for SnapshotFailure {
    fn from(error: ErrorRecord) -> Self {
        Self::Failed(error)
    }
}

impl SnapshotFailure {
    /// Once a predecessor is accepted, even lifecycle loss must fail its unsettled transaction.
    /// Callers decide whether an earlier, unadmitted frame omission can instead be recorded.
    pub(crate) fn recording_error(&self) -> ErrorRecord {
        match self {
            Self::Failed(error) => error.clone(),
            Self::Unavailable(reason) => ErrorRecord::new(
                ErrorCode::Evaluation,
                "tracing.snapshot",
                match reason {
                    SnapshotUnavailable::NoExistingMainContext => {
                        "snapshot has no existing main context"
                    }
                    SnapshotUnavailable::OriginalDocumentChanged => {
                        "original snapshot document is no longer current"
                    }
                    SnapshotUnavailable::PendingNavigation => {
                        "snapshot frame has pending navigation"
                    }
                    SnapshotUnavailable::DialogOpen => {
                        "snapshot page has an open JavaScript dialog"
                    }
                },
            ),
        }
    }
}

impl From<crate::diagnostic_sessions::SessionFailure> for SnapshotFailure {
    fn from(error: crate::diagnostic_sessions::SessionFailure) -> Self {
        match error {
            crate::diagnostic_sessions::SessionFailure::Unavailable => {
                Self::Unavailable(SnapshotUnavailable::OriginalDocumentChanged)
            }
            crate::diagnostic_sessions::SessionFailure::Failed(error) => Self::Failed(error),
        }
    }
}
