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
    /// The admitted wrapper is bounded; only the actual exception's first line identifies its cause.
    pub(super) fn from_renderer_exception(exception: &serde_json::value::RawValue) -> Self {
        let details: serde_json::Value =
            serde_json::from_str(exception.get()).unwrap_or(serde_json::Value::Null);
        let description = details["exception"]["description"]
            .as_str()
            .and_then(|description| description.lines().next())
            .unwrap_or("snapshot renderer rejected capture");
        let description = description.strip_prefix("Error: ").unwrap_or(description);
        if matches!(
            description,
            "SnapshotTargetDocumentChanged" | "SnapshotFrameDocumentChanged"
        ) {
            return Self::Unavailable(SnapshotUnavailable::OriginalDocumentChanged);
        }
        let (code, message) =
            if let Some(message) = description.strip_prefix("SnapshotResourceLimit: ") {
                (ErrorCode::ResourceLimit, message)
            } else if let Some(message) = description.strip_prefix("SnapshotUnsupported: ") {
                (ErrorCode::UnsupportedFeature, message)
            } else {
                (ErrorCode::Evaluation, description)
            };
        let message: String = message.chars().take(512).collect();
        Self::Failed(ErrorRecord::new(code, "tracing.snapshot", &message))
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    fn exception(description: &str) -> SnapshotFailure {
        let raw = serde_json::value::to_raw_value(&serde_json::json!({
            "text": "Uncaught", "exception": { "description": description }
        }))
        .unwrap();
        SnapshotFailure::from_renderer_exception(&raw)
    }

    #[test]
    fn renderer_failures_retain_the_actual_bounded_reason_and_ignore_stack_markers() {
        for (prefix, code) in [
            ("SnapshotResourceLimit", ErrorCode::ResourceLimit),
            ("SnapshotUnsupported", ErrorCode::UnsupportedFeature),
        ] {
            let error = exception(&format!("Error: {prefix}: specific reason\n at capture()"))
                .recording_error();
            assert_eq!(error.code, code);
            assert_eq!(error.message.as_ref(), "specific reason");
        }
        let error =
            exception("Error: original failure\n at SnapshotUnsupported: other").recording_error();
        assert_eq!(error.code, ErrorCode::Evaluation);
        assert_eq!(error.message.as_ref(), "original failure");
        let error = exception(&format!(
            "Error: SnapshotUnsupported: {}",
            "🌍".repeat(1000)
        ))
        .recording_error();
        assert_eq!(error.message.chars().count(), 512);
        assert!(matches!(
            exception("Error: SnapshotFrameDocumentChanged\n at capture()"),
            SnapshotFailure::Unavailable(SnapshotUnavailable::OriginalDocumentChanged)
        ));
    }
}
