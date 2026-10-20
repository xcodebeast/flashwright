use super::{DocumentState, NavigationOutcome};
use serde_json::Value;

/// The pre-network intent present when a beforeunload modal opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BeforeUnloadNavigation {
    intent_sequence: u64,
    document_sequence: u64,
}

impl DocumentState {
    pub(crate) fn beforeunload_navigation(&self) -> Option<BeforeUnloadNavigation> {
        let frame = self.frames.get(self.main_frame.as_ref()?)?;
        let pending = frame.pending_navigation.as_ref()?;
        pending.loader.is_none().then_some(BeforeUnloadNavigation {
            intent_sequence: pending.sequence,
            document_sequence: frame.document_navigation_sequence,
        })
    }

    /// A rejected modal cannot cancel a successor intent or an already-started network request.
    pub(crate) fn cancel_beforeunload_navigation(
        &mut self,
        original: BeforeUnloadNavigation,
    ) -> Option<Value> {
        if self.beforeunload_navigation() != Some(original) {
            return None;
        }
        let identifier = self.main_frame.as_ref()?.clone();
        self.frames.get_mut(&identifier)?.pending_navigation = None;
        Some(self.record_navigation(
            identifier,
            NavigationOutcome::Failed("navigation cancelled by beforeunload dialog".into()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page_state::{FrameState, PendingNavigation};

    fn pending() -> DocumentState {
        let mut state = DocumentState {
            main_frame: Some("main".into()),
            sequence: 21,
            ..Default::default()
        };
        state.frames.insert(
            "main".into(),
            FrameState {
                identifier: "main".into(),
                url: "https://example.test/original".into(),
                document_navigation_sequence: 10,
                pending_navigation: Some(PendingNavigation {
                    sequence: 20,
                    loader: None,
                }),
                ..Default::default()
            },
        );
        state
    }

    #[test]
    fn rejected_beforeunload_retires_original_intent_and_records_failure() {
        let mut state = pending();
        let original = state.beforeunload_navigation().unwrap();
        state.sequence += 1;
        let event = state.cancel_beforeunload_navigation(original).unwrap();
        assert!(state.frames["main"].pending_navigation.is_none());
        assert_eq!(event["kind"], "failed");
        assert_eq!(event["sequence"], 22);
        assert_eq!(event["url"], "https://example.test/original");
        assert_eq!(state.navigation_events.len(), 1);
        assert_eq!(state.navigation_events[0].frame_identifier, "main");
        assert!(matches!(
            &state.navigation_events[0].outcome,
            NavigationOutcome::Failed(reason) if reason.contains("beforeunload")
        ));
        assert!(state.cancel_beforeunload_navigation(original).is_none());
    }

    #[test]
    fn late_modal_cannot_cancel_successor_intent_document_or_network_request() {
        for change in 0..4 {
            let mut state = pending();
            let original = state.beforeunload_navigation().unwrap();
            let frame = state.frames.get_mut("main").unwrap();
            match change {
                0 => frame.pending_navigation.as_mut().unwrap().sequence += 1,
                1 => frame.document_navigation_sequence += 1,
                2 => frame.pending_navigation.as_mut().unwrap().loader = Some("loader".into()),
                _ => state.main_frame = None,
            }
            assert!(state.cancel_beforeunload_navigation(original).is_none());
            assert!(state.frames["main"].pending_navigation.is_some());
            assert!(state.navigation_events.is_empty());
        }
    }
}
