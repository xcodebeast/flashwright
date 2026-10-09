//! Recorder body identity survives public-history eviction but never browser identifier reuse.

use super::journal::{BodyUnavailable, JournalError, Occurrence};
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use tokio::sync::watch;

struct GuardState {
    occurrence: Occurrence,
    current: watch::Sender<Option<BodyUnavailable>>,
}

pub(super) struct BodyGuard {
    state: Arc<GuardState>,
}

impl BodyGuard {
    #[cfg(test)]
    pub(super) fn current(&self) -> bool {
        self.state.current.borrow().is_none()
    }

    pub(super) fn unavailable(&self) -> Option<BodyUnavailable> {
        *self.state.current.borrow()
    }

    pub(super) fn changes(&self) -> watch::Receiver<Option<BodyUnavailable>> {
        self.state.current.subscribe()
    }
}

#[derive(Default)]
pub(super) struct BodyOwners {
    requests: HashMap<(String, String), Weak<GuardState>>,
}

impl BodyOwners {
    /// Only actual Network ingress invalidates a reused identifier; public eviction never calls this.
    pub(super) fn request_started(&mut self, page: &str, identifier: &str) {
        if let Some(original) = self.requests.remove(&(page.into(), identifier.into()))
            && let Some(original) = original.upgrade()
        {
            original
                .current
                .send_replace(Some(BodyUnavailable::OriginalRequestReplaced));
        }
    }

    pub(super) fn admit(
        &mut self,
        occurrence: &Occurrence,
        identifier: &str,
    ) -> Result<BodyGuard, JournalError> {
        self.requests
            .retain(|_, original| original.strong_count() != 0);
        if self.requests.len() >= 1024 {
            return Err(JournalError::ResourceLimit(
                "recording exceeds 1024 original body owners",
            ));
        }
        let key = (occurrence.page.clone(), identifier.into());
        if self.requests.get(&key).and_then(Weak::upgrade).is_some() {
            return Err(JournalError::Protocol(
                "original body identifier is already owned",
            ));
        }
        let state = Arc::new(GuardState {
            occurrence: occurrence.clone(),
            current: watch::channel(None).0,
        });
        self.requests.insert(key, Arc::downgrade(&state));
        Ok(BodyGuard { state })
    }

    /// A closed public page invalidates publication, without asserting that its command settled.
    pub(super) fn page_closed(&mut self, page: &str) {
        self.requests.retain(|(owner, _), original| {
            if owner != page {
                return original.strong_count() != 0;
            }
            if let Some(original) = original.upgrade() {
                original
                    .current
                    .send_replace(Some(BodyUnavailable::OriginalPageClosed));
            }
            false
        });
    }

    pub(super) fn settled(&mut self, identifier: &str, guard: &BodyGuard) {
        let key = (guard.state.occurrence.page.clone(), identifier.into());
        if self
            .requests
            .get(&key)
            .and_then(Weak::upgrade)
            .is_some_and(|current| Arc::ptr_eq(&current, &guard.state))
        {
            self.requests.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occurrence(page: &str, identity: &str) -> Occurrence {
        Occurrence {
            page: page.into(),
            identity: identity.into(),
        }
    }

    #[test]
    fn reused_browser_identifiers_invalidate_only_their_original_page_owner() {
        let mut owners = BodyOwners::default();
        let first = owners
            .admit(&occurrence("first-page", "shared:1"), "shared")
            .unwrap();
        let other_page = owners
            .admit(&occurrence("second-page", "shared:1"), "shared")
            .unwrap();
        let mut changed = first.changes();
        owners.request_started("first-page", "shared");
        assert!(!first.current());
        assert!(changed.has_changed().unwrap());
        assert_eq!(
            *changed.borrow_and_update(),
            Some(BodyUnavailable::OriginalRequestReplaced)
        );
        assert!(other_page.current());
        let successor = owners
            .admit(&occurrence("first-page", "shared:2"), "shared")
            .unwrap();
        owners.settled("shared", &first);
        assert!(successor.current());
        assert_eq!(owners.requests.len(), 2);
    }

    #[test]
    fn metadata_and_registry_teardown_cannot_rebind_an_owned_body() {
        let mut owners = BodyOwners::default();
        let original = occurrence("page", "request:1");
        let guard = owners.admit(&original, "request").unwrap();
        drop(original);
        assert!(guard.current());
        owners.page_closed("other-page");
        assert!(guard.current());
        owners.page_closed("page");
        assert!(!guard.current());
        drop(owners);
        assert!(!guard.current());
    }

    #[test]
    fn settled_guard_custody_reclaims_the_bounded_index() {
        let mut owners = BodyOwners::default();
        let mut guards = Vec::new();
        for index in 0..1024 {
            let identifier = format!("request-{index}");
            guards.push(
                owners
                    .admit(&occurrence("page", &identifier), &identifier)
                    .unwrap(),
            );
        }
        assert!(matches!(
            owners.admit(&occurrence("page", "overflow"), "overflow"),
            Err(JournalError::ResourceLimit(_))
        ));
        owners.settled("request-0", &guards[0]);
        let replacement = owners
            .admit(&occurrence("page", "replacement"), "replacement")
            .unwrap();
        assert_eq!(owners.requests.len(), 1024);
        drop(guards);
        drop(replacement);
        let final_owner = owners.admit(&occurrence("page", "final"), "final").unwrap();
        assert_eq!(owners.requests.len(), 1);
        assert!(final_owner.current());
    }
}
