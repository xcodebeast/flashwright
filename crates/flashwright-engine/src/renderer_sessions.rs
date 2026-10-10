//! Renderer setup and retirement retain the original session independently of logical frames.

use std::collections::HashMap;
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};

use flashwright_protocol::{ErrorCode, ErrorRecord};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

const MAXIMUM_RENDERER_SESSIONS: usize = 128;

pub(crate) struct RendererSession {
    pub target_identifier: String,
    pub session_identifier: String,
    parent: Option<Arc<RendererSession>>,
    retired: watch::Sender<bool>,
    ready: AtomicBool,
    destroyed: AtomicBool,
    _reservation: OwnedSemaphorePermit,
}

impl RendererSession {
    pub(crate) fn is_retired(&self) -> bool {
        *self.retired.borrow()
    }

    pub(crate) fn retirement(&self) -> watch::Receiver<bool> {
        self.retired.subscribe()
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire) && !self.is_retired()
    }

    pub(crate) fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
    }

    pub(crate) fn is_destroyed(&self) -> bool {
        self.destroyed.load(Ordering::Acquire)
    }

    pub(crate) fn mark_destroyed(&self) {
        self.destroyed.store(true, Ordering::Release);
    }

    pub(crate) fn parent_session_identifier(&self) -> Option<&str> {
        self.parent
            .as_ref()
            .map(|parent| parent.session_identifier.as_str())
    }

    fn descends_from(&self, ancestor: &RendererSession) -> bool {
        let mut current = Some(self);
        while let Some(session) = current {
            if std::ptr::eq(session, ancestor) {
                return true;
            }
            current = session.parent.as_deref();
        }
        false
    }
}

pub(crate) struct RendererSessions {
    sessions: HashMap<String, Arc<RendererSession>>,
    original_sessions: HashMap<String, Weak<RendererSession>>,
    capacity: Arc<Semaphore>,
}

impl Default for RendererSessions {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            original_sessions: HashMap::new(),
            capacity: Arc::new(Semaphore::new(MAXIMUM_RENDERER_SESSIONS)),
        }
    }
}

fn invalid(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, "frame.attach", message)
}

impl RendererSessions {
    pub(crate) fn get(&self, identifier: &str) -> Option<Arc<RendererSession>> {
        self.sessions.get(identifier).cloned()
    }

    pub(crate) fn original(&self, identifier: &str) -> Option<Arc<RendererSession>> {
        self.original_sessions
            .get(identifier)
            .and_then(Weak::upgrade)
    }

    pub(crate) fn for_target(&self, identifier: &str) -> Option<Arc<RendererSession>> {
        self.sessions
            .values()
            .find(|owner| owner.target_identifier == identifier)
            .cloned()
    }

    /// Root registration precedes commands that can deliver descendant attachment events.
    pub(crate) fn register_root(
        &mut self,
        target: &str,
        session: &str,
    ) -> Result<Arc<RendererSession>, ErrorRecord> {
        if !self.sessions.is_empty() {
            return Err(invalid("renderer root is already registered"));
        }
        self.insert(target, session, None)
    }

    /// An old setup lease cannot attach children after its registry ownership has retired.
    pub(crate) fn register_child(
        &mut self,
        parent: &Arc<RendererSession>,
        target: &str,
        session: &str,
    ) -> Result<Arc<RendererSession>, ErrorRecord> {
        if !self
            .sessions
            .get(&parent.session_identifier)
            .is_some_and(|current| Arc::ptr_eq(current, parent))
            || parent.is_retired()
        {
            return Err(invalid("renderer parent is no longer owned"));
        }
        self.insert(target, session, Some(parent.clone()))
    }

    fn insert(
        &mut self,
        target: &str,
        session: &str,
        parent: Option<Arc<RendererSession>>,
    ) -> Result<Arc<RendererSession>, ErrorRecord> {
        if [target, session]
            .iter()
            .any(|identifier| identifier.is_empty() || identifier.len() > 256)
        {
            return Err(invalid("invalid renderer target or session identity"));
        }
        self.original_sessions
            .retain(|_, owner| owner.strong_count() != 0);
        if self.original_sessions.contains_key(session) {
            return Err(invalid("renderer session is already registered"));
        }
        if self
            .sessions
            .values()
            .any(|owner| owner.target_identifier == target)
        {
            return Err(invalid("renderer target still has an active owner"));
        }
        let reservation = self.capacity.clone().try_acquire_owned().map_err(|_| {
            ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "frame.attach",
                "page renderer owners exceed 128",
            )
        })?;
        let owner = Arc::new(RendererSession {
            target_identifier: target.into(),
            session_identifier: session.into(),
            parent,
            retired: watch::channel(false).0,
            ready: AtomicBool::new(false),
            destroyed: AtomicBool::new(false),
            _reservation: reservation,
        });
        self.sessions.insert(session.into(), owner.clone());
        self.original_sessions
            .insert(session.into(), Arc::downgrade(&owner));
        Ok(owner)
    }

    /// Retirement cancels semantic ownership, not proof of native destruction. Setup/cleanup
    /// leases retain capacity until their original commands settle, including removed descendants.
    pub(crate) fn retire(&mut self, original: &Arc<RendererSession>) {
        self.sessions.retain(|_, owner| {
            if owner.descends_from(original) {
                owner.retired.send_replace(true);
                false
            } else {
                true
            }
        });
    }

    pub(crate) fn retire_all(&mut self) {
        for (_, owner) in self.sessions.drain() {
            owner.retired.send_replace(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retiring_a_parent_retires_only_its_original_subtree() {
        let mut sessions = RendererSessions::default();
        let root = sessions.register_root("page", "root").unwrap();
        let child = sessions
            .register_child(&root, "child", "child-one")
            .unwrap();
        let grandchild = sessions
            .register_child(&child, "nested", "nested-one")
            .unwrap();
        let sibling = sessions
            .register_child(&root, "sibling", "sibling-one")
            .unwrap();
        let retired = grandchild.retirement();
        sessions.retire(&child);
        assert!(*retired.borrow());
        assert!(child.is_retired());
        assert!(!root.is_retired());
        assert!(!sibling.is_retired());
        assert!(sessions.get("nested-one").is_none());
        assert!(
            sessions
                .register_child(&child, "late-child", "late-session")
                .is_err()
        );
        let replacement = sessions
            .register_child(&root, "child", "child-two")
            .unwrap();
        replacement.mark_ready();
        sessions.retire(&child);
        assert!(replacement.is_ready());
        assert!(sessions.get("child-two").is_some());
    }

    #[test]
    fn retired_setup_lease_cannot_publish_readiness_or_release_its_credit_early() {
        let mut sessions = RendererSessions::default();
        let root = sessions.register_root("page", "root").unwrap();
        let mut leases = Vec::new();
        for index in 1..MAXIMUM_RENDERER_SESSIONS {
            leases.push(
                sessions
                    .register_child(
                        &root,
                        &format!("frame-{index}"),
                        &format!("session-{index}"),
                    )
                    .unwrap(),
            );
        }
        let removed = leases.pop().unwrap();
        sessions.retire(&removed);
        removed.mark_ready();
        assert!(!removed.is_ready());
        assert_eq!(
            sessions
                .register_child(&root, "new", "new-session")
                .err()
                .unwrap()
                .code,
            ErrorCode::ResourceLimit
        );
        drop(removed);
        assert!(sessions.register_child(&root, "new", "new-session").is_ok());
        sessions.retire_all();
        assert!(root.is_retired());
        assert!(leases.iter().all(|owner| owner.is_retired()));
    }

    #[test]
    fn identities_cannot_be_rebound_while_their_owner_is_active() {
        let mut sessions = RendererSessions::default();
        let root = sessions.register_root("page", "root").unwrap();
        let child = sessions
            .register_child(&root, "child", "child-session")
            .unwrap();
        assert!(
            sessions
                .register_child(&root, "different", "child-session")
                .is_err()
        );
        assert!(
            sessions
                .register_child(&root, "child", "different-session")
                .is_err()
        );
        assert!(
            sessions
                .register_child(&root, "page", "different-session")
                .is_err()
        );
        assert!(sessions.register_root("other-page", "other-root").is_err());
        assert!(Arc::ptr_eq(&sessions.get("child-session").unwrap(), &child));
    }

    #[test]
    fn original_terminal_owner_survives_retirement_without_claiming_its_replacement() {
        let mut sessions = RendererSessions::default();
        let root = sessions.register_root("page", "root").unwrap();
        let original = sessions
            .register_child(&root, "frame", "old-session")
            .unwrap();
        sessions.retire(&original);
        let replacement = sessions
            .register_child(&root, "frame", "new-session")
            .unwrap();
        let terminal = sessions.original("old-session").unwrap();
        assert!(Arc::ptr_eq(&terminal, &original));
        terminal.mark_destroyed();
        sessions.retire(&terminal);
        assert!(original.is_destroyed());
        assert!(!replacement.is_destroyed());
        assert!(!replacement.is_retired());
        assert!(
            sessions
                .register_child(&root, "different-frame", "old-session")
                .is_err()
        );
        drop(terminal);
        drop(original);
        assert!(sessions.original("old-session").is_none());
    }
}
