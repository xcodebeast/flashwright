//! Context lifetime and visited origins outlive any individual page.

use super::*;
use std::collections::BTreeSet;
use std::future::Future;

pub(crate) const MAXIMUM_STORAGE_ORIGINS: usize = 1024;
type CleanupCompletion = watch::Receiver<Option<Result<(), ErrorRecord>>>;

pub(crate) struct ContextState {
    pub downloads: OnceLock<Arc<crate::downloads::Downloads>>,
    pub cleanup: Mutex<Option<CleanupCompletion>>,
    pub origins: Mutex<BTreeSet<String>>,
    pub routing_registered: std::sync::atomic::AtomicBool,
    pub trace_enabled: std::sync::atomic::AtomicBool,
    pub trace_diagnostics: Mutex<crate::trace_diagnostics::TraceDiagnostics>,
    pub recording: Mutex<crate::recording::RecordingState>,
    pub recording_enabled: std::sync::atomic::AtomicBool,
    pub snapshot_enrollment: tokio::sync::Mutex<()>,
    pub filmstrip: Mutex<Option<Arc<crate::filmstrip::Filmstrip>>>,
    pub filmstrip_closed: std::sync::atomic::AtomicBool,
    pub console_enabled: std::sync::atomic::AtomicBool,
    pub dialog_enabled: std::sync::atomic::AtomicBool,
    pub storage_failure: Mutex<Option<ErrorRecord>>,
    pub page_configuration: tokio::sync::RwLock<()>,
    pub storage_operations: tokio::sync::Mutex<()>,
    pub closed: watch::Sender<Option<ErrorRecord>>,
}

impl Default for ContextState {
    fn default() -> Self {
        Self {
            downloads: OnceLock::new(),
            cleanup: Mutex::new(None),
            origins: Mutex::new(BTreeSet::new()),
            routing_registered: std::sync::atomic::AtomicBool::new(false),
            trace_enabled: std::sync::atomic::AtomicBool::new(false),
            trace_diagnostics: Mutex::new(crate::trace_diagnostics::TraceDiagnostics::default()),
            recording: Mutex::new(crate::recording::RecordingState::default()),
            recording_enabled: std::sync::atomic::AtomicBool::new(false),
            snapshot_enrollment: tokio::sync::Mutex::new(()),
            filmstrip: Mutex::new(None),
            filmstrip_closed: std::sync::atomic::AtomicBool::new(false),
            console_enabled: std::sync::atomic::AtomicBool::new(false),
            dialog_enabled: std::sync::atomic::AtomicBool::new(false),
            storage_failure: Mutex::new(None),
            page_configuration: tokio::sync::RwLock::new(()),
            storage_operations: tokio::sync::Mutex::new(()),
            closed: watch::channel(None).0,
        }
    }
}

impl ContextState {
    pub(crate) fn close_trace(&self) {
        self.filmstrip_closed.store(true, Ordering::Release);
        if let Some(capture) = self.filmstrip.lock().unwrap().take() {
            capture.close();
        }
        self.trace_enabled.store(false, Ordering::Relaxed);
        self.trace_diagnostics.lock().unwrap().close();
        self.recording.lock().unwrap().close();
        self.recording_enabled.store(false, Ordering::Release);
    }

    pub fn visit(&self, origin: &str) -> Result<(), ErrorRecord> {
        if !origin.starts_with("http://") && !origin.starts_with("https://") {
            if !["null", "://", ""].contains(&origin) {
                *self.storage_failure.lock().unwrap() = Some(ErrorRecord::new(
                    ErrorCode::UnsupportedFeature,
                    "context.storageState",
                    "storage collection for non-HTTP origins is not implemented",
                ));
            }
            return Ok(());
        }
        let mut origins = self.origins.lock().unwrap();
        if origins.len() >= MAXIMUM_STORAGE_ORIGINS && !origins.contains(origin) {
            let error = ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "context.storageState",
                "context exceeds 1024 retained storage origins",
            );
            *self.storage_failure.lock().unwrap() = Some(error.clone());
            return Err(error);
        }
        origins.insert(origin.to_owned());
        Ok(())
    }

    pub async fn while_alive<T>(
        &self,
        method: &str,
        work: impl Future<Output = Result<T, ErrorRecord>>,
    ) -> Result<T, ErrorRecord> {
        let mut changes = self.closed.subscribe();
        let lost = async {
            loop {
                if let Some(mut error) = changes.borrow().clone() {
                    error.method = method.into();
                    return error;
                }
                if changes.changed().await.is_err() {
                    return closed(method);
                }
            }
        };
        tokio::select! {
            biased;
            error = lost => Err(error),
            result = work => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_limit_retains_failure_instead_of_returning_partial_state() {
        let state = ContextState::default();
        for index in 0..MAXIMUM_STORAGE_ORIGINS {
            state
                .visit(&format!("https://origin-{index}.test"))
                .unwrap();
        }
        state.visit("https://origin-0.test").unwrap();
        assert_eq!(
            state.visit("https://overflow.test").unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(state.origins.lock().unwrap().len(), MAXIMUM_STORAGE_ORIGINS);
        assert_eq!(
            state.storage_failure.lock().unwrap().as_ref().unwrap().code,
            ErrorCode::ResourceLimit
        );
    }

    #[test]
    fn opaque_frames_are_ignored_but_file_storage_is_explicitly_unsupported() {
        let state = ContextState::default();
        for origin in ["null", "://", ""] {
            state.visit(origin).unwrap();
        }
        assert!(state.origins.lock().unwrap().is_empty());
        assert!(state.storage_failure.lock().unwrap().is_none());
        state.visit("file://").unwrap();
        assert_eq!(
            state.storage_failure.lock().unwrap().as_ref().unwrap().code,
            ErrorCode::UnsupportedFeature
        );
    }

    #[tokio::test]
    async fn context_closure_interrupts_waiting_storage_operations() {
        let state = ContextState::default();
        let operation = state.while_alive::<()>("context.cookies", std::future::pending());
        let close = async {
            tokio::task::yield_now().await;
            state.closed.send_replace(Some(closed("context")));
        };
        let (result, ()) = tokio::join!(operation, close);
        assert_eq!(result.unwrap_err().code, ErrorCode::TargetClosed);
        assert_eq!(
            state
                .while_alive("context.cookies", async { Ok(()) })
                .await
                .unwrap_err()
                .code,
            ErrorCode::TargetClosed
        );
    }
}
