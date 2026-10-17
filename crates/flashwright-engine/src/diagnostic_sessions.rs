//! Session destruction remains observable after the public page registry entry is removed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde_json::Value;
use tokio::sync::watch;

const MAXIMUM_SESSIONS: usize = 128;

#[derive(Debug)]
pub(crate) enum SessionFailure {
    Unavailable,
    Failed(ErrorRecord),
}

impl From<ErrorRecord> for SessionFailure {
    fn from(error: ErrorRecord) -> Self {
        Self::Failed(error)
    }
}

#[derive(Hash, PartialEq, Eq)]
struct SessionIdentity {
    browser: String,
    session: String,
}

struct SessionSignal {
    target: String,
    session: String,
    destroyed: watch::Sender<bool>,
}

/// Holding this lease retains the signal without granting authority to declare destruction.
#[derive(Clone)]
pub(crate) struct SessionLifetime {
    signal: Arc<SessionSignal>,
}

#[derive(Default)]
pub(crate) struct DiagnosticSessions {
    sessions: Mutex<HashMap<SessionIdentity, Weak<SessionSignal>>>,
}

fn invalid(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, "tracing.recording", message)
}

impl SessionLifetime {
    pub(crate) fn belongs_to(&self, target: &str, session: &str) -> bool {
        self.signal.target == target && self.signal.session == session
    }

    pub(crate) fn destruction(&self) -> watch::Receiver<bool> {
        self.signal.destroyed.subscribe()
    }

    #[cfg(test)]
    pub(crate) fn controlled(target: &str, session: &str, destroyed: watch::Sender<bool>) -> Self {
        Self {
            signal: Arc::new(SessionSignal {
                target: target.into(),
                session: session.into(),
                destroyed,
            }),
        }
    }
}

impl DiagnosticSessions {
    /// Register before asynchronous capture setup, then revalidate the original public page.
    pub(crate) fn register(
        &self,
        browser: &str,
        target: &str,
        session: &str,
    ) -> Result<SessionLifetime, ErrorRecord> {
        if browser.is_empty()
            || browser.len() > 64
            || target.is_empty()
            || target.len() > 256
            || session.is_empty()
            || session.len() > 256
        {
            return Err(invalid("invalid diagnostic session identity"));
        }
        let identity = SessionIdentity {
            browser: browser.into(),
            session: session.into(),
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, signal| signal.strong_count() != 0);
        if let Some(signal) = sessions.get(&identity).and_then(Weak::upgrade) {
            if signal.target != target {
                return Err(invalid(
                    "diagnostic session was registered for another original target",
                ));
            }
            if *signal.destroyed.borrow() {
                return Err(invalid("diagnostic session is already destroyed"));
            }
            return Ok(SessionLifetime { signal });
        }
        if sessions.len() == MAXIMUM_SESSIONS {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "tracing.recording",
                "diagnostic session owners exceed 128",
            ));
        }
        let signal = Arc::new(SessionSignal {
            target: target.into(),
            session: session.into(),
            destroyed: watch::channel(false).0,
        });
        sessions.insert(identity, Arc::downgrade(&signal));
        Ok(SessionLifetime { signal })
    }

    /// Only terminal target/session events establish proof; ordinary failures are deliberately ignored.
    /// Call before filtering events through the mutable public-page registry.
    pub(crate) fn observe(&self, browser: &str, method: &str, parameters: &Value) {
        enum Terminal<'event> {
            Target(&'event str),
            Session(&'event str),
        }
        let terminal = match method {
            "Target.targetDestroyed" => parameters["targetId"].as_str().map(Terminal::Target),
            "Target.detachedFromTarget" => parameters["sessionId"].as_str().map(Terminal::Session),
            _ => None,
        };
        let Some(terminal) = terminal else {
            return;
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|identity, signal| {
            let Some(signal) = signal.upgrade() else {
                return false;
            };
            let matches = identity.browser == browser
                && match terminal {
                    Terminal::Target(target) => signal.target == target,
                    Terminal::Session(session) => identity.session == session,
                };
            if matches {
                signal.destroyed.send_replace(true);
            }
            true
        });
    }

    /// The caller invokes this only after the original browser guardian confirms successful cleanup.
    pub(crate) fn browser_cleanup_finished(&self, browser: &str, result: &Result<(), ErrorRecord>) {
        if result.is_err() {
            return;
        }
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|identity, signal| {
            let Some(signal) = signal.upgrade() else {
                return false;
            };
            if identity.browser == browser {
                signal.destroyed.send_replace(true);
            }
            true
        });
    }
}

impl crate::Engine {
    /// Registration and terminal-event observation share registry order, including events before page removal.
    pub(crate) fn diagnostic_session(
        &self,
        identifier: &str,
        page: &crate::Page,
    ) -> Result<SessionLifetime, SessionFailure> {
        self.diagnostic_session_for_page(identifier, page, true, None)
    }

    /// Initial popup responses may finish before publication, while their registered public page is alive.
    pub(crate) fn network_diagnostic_session(
        &self,
        identifier: &str,
        page: &crate::Page,
    ) -> Result<SessionLifetime, SessionFailure> {
        self.diagnostic_session_for_page(identifier, page, false, None)
    }

    pub(crate) fn network_diagnostic_session_for_renderer(
        &self,
        identifier: &str,
        page: &crate::Page,
        session: &str,
    ) -> Result<SessionLifetime, SessionFailure> {
        if session == page.session_identifier {
            return self.network_diagnostic_session(identifier, page);
        }
        self.diagnostic_session_for_page(identifier, page, false, Some(session))
    }

    fn diagnostic_session_for_page(
        &self,
        identifier: &str,
        page: &crate::Page,
        require_published: bool,
        renderer_session: Option<&str>,
    ) -> Result<SessionLifetime, SessionFailure> {
        let unavailable = || SessionFailure::Unavailable;
        if page.state.purpose != crate::page_state::PagePurpose::Public {
            return Err(invalid("private pages cannot register diagnostic sessions").into());
        }
        if require_published && !page.state.state.lock().unwrap().published {
            return Err(unavailable());
        }
        let registry = self.registry.lock().unwrap();
        let current = registry
            .pages
            .get(identifier)
            .filter(|current| {
                Arc::ptr_eq(&current.state, &page.state)
                    && current.session_identifier == page.session_identifier
                    && current.target_identifier == page.target_identifier
            })
            .ok_or_else(unavailable)?;
        let context = registry
            .contexts
            .get(&current.context_identifier)
            .filter(|context| context.published)
            .ok_or_else(unavailable)?;
        if current
            .state
            .diagnostic_session_destroyed
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(unavailable());
        }
        let renderer = renderer_session
            .map(|session| {
                current
                    .state
                    .renderer_sessions
                    .lock()
                    .unwrap()
                    .get(session)
                    .filter(|renderer| !renderer.is_retired() && !renderer.is_destroyed())
                    .ok_or_else(unavailable)
            })
            .transpose()?;
        Ok(self.diagnostic_sessions.register(
            &context.browser_identifier,
            renderer
                .as_ref()
                .map_or(&current.target_identifier, |owner| &owner.target_identifier),
            renderer
                .as_ref()
                .map_or(&current.session_identifier, |owner| {
                    &owner.session_identifier
                }),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn original_browser_target_and_session_namespace_prevent_successor_retirement() {
        let registry = DiagnosticSessions::default();
        let original = registry.register("browser", "target", "session").unwrap();
        let other_browser = registry
            .register("other-browser", "target", "session")
            .unwrap();
        let other_target = registry
            .register("browser", "other-target", "other-session")
            .unwrap();
        registry.observe(
            "browser",
            "Target.targetDestroyed",
            &json!({"targetId":"target"}),
        );
        assert!(*original.destruction().borrow());
        assert!(!*other_browser.destruction().borrow());
        assert!(!*other_target.destruction().borrow());
        assert!(registry.register("browser", "target", "session").is_err());
        registry.observe(
            "browser",
            "Target.detachedFromTarget",
            &json!({"sessionId":"other-session"}),
        );
        assert!(*other_target.destruction().borrow());
        assert!(!*other_browser.destruction().borrow());
    }

    #[test]
    fn context_loss_connection_failure_and_lost_producer_do_not_prove_session_destruction() {
        let registry = DiagnosticSessions::default();
        let lease = registry.register("browser", "target", "session").unwrap();
        let duplicate = registry.register("browser", "target", "session").unwrap();
        assert!(Arc::ptr_eq(&lease.signal, &duplicate.signal));
        for method in [
            "Runtime.executionContextDestroyed",
            "Runtime.executionContextsCleared",
            "Flashwright.disconnected",
            "Target.targetCrashed",
            "Inspector.targetCrashed",
            "Inspector.detached",
        ] {
            registry.observe("browser", method, &json!({"targetId":"target"}));
        }
        registry.browser_cleanup_finished("browser", &Err(invalid("guardian completion lost")));
        assert!(!*lease.destruction().borrow());
        assert!(
            registry
                .register("browser", "wrong-target", "session")
                .is_err()
        );
        let receiver = lease.destruction();
        drop(registry);
        drop(duplicate);
        assert!(!*receiver.borrow());
        assert!(receiver.has_changed().is_ok());
    }

    #[test]
    fn successful_guardian_cleanup_only_confirms_its_original_browser() {
        let registry = DiagnosticSessions::default();
        let first = registry.register("first", "target", "session").unwrap();
        let second = registry.register("second", "target", "session").unwrap();
        registry.browser_cleanup_finished("first", &Ok(()));
        assert!(*first.destruction().borrow());
        assert!(!*second.destruction().borrow());
        registry.observe(
            "second",
            "Target.detachedFromTarget",
            &json!({"sessionId":"session"}),
        );
        assert!(*second.destruction().borrow());
    }

    #[test]
    fn capacity_counts_live_session_owners_and_reclaims_only_unowned_entries() {
        let registry = DiagnosticSessions::default();
        let leases: Vec<_> = (0..MAXIMUM_SESSIONS)
            .map(|index| {
                registry
                    .register(
                        "browser",
                        &format!("target-{index}"),
                        &format!("session-{index}"),
                    )
                    .unwrap()
            })
            .collect();
        assert_eq!(
            registry
                .register("browser", "overflow", "overflow")
                .err()
                .unwrap()
                .code,
            ErrorCode::ResourceLimit
        );
        registry.observe(
            "browser",
            "Target.targetDestroyed",
            &json!({"targetId":"target-0"}),
        );
        assert!(
            registry
                .register("browser", "overflow", "overflow")
                .is_err()
        );
        drop(leases);
        drop(
            registry
                .register("browser", "replacement", "replacement")
                .unwrap(),
        );
        assert_eq!(registry.sessions.lock().unwrap().len(), 1);
        drop(registry.register("browser", "next", "next").unwrap());
        assert_eq!(registry.sessions.lock().unwrap().len(), 1);
    }
}
