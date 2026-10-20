//! Modal occurrences retain their original owner and admission until all command custody ends.

use std::sync::Arc;

use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::page_state::BeforeUnloadNavigation;

pub(super) const MAXIMUM_DIALOG_BYTES: usize = 1024 * 1024;
const MAXIMUM_ENGINE_DIALOGS: usize = 128;
const MAXIMUM_ENGINE_DIALOG_BYTES: usize = 8 * 1024 * 1024;
const MAXIMUM_PAGE_DIALOGS: usize = 16;
const MAXIMUM_PAGE_DIALOG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum DialogKind {
    Alert,
    Confirm,
    Prompt,
    Beforeunload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpeningFields {
    frame_id: String,
    #[serde(rename = "type")]
    kind: DialogKind,
    message: Box<RawValue>,
    default_prompt: Option<Box<RawValue>>,
}

pub(crate) struct DialogBudget {
    occurrences: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
}

impl DialogBudget {
    pub(crate) fn engine() -> Arc<Self> {
        Self::new(MAXIMUM_ENGINE_DIALOGS, MAXIMUM_ENGINE_DIALOG_BYTES)
    }

    fn new(occurrences: usize, bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            occurrences: Arc::new(Semaphore::new(occurrences)),
            bytes: Arc::new(Semaphore::new(bytes)),
        })
    }

    fn reserve(engine: &Self, page: &Self, bytes: usize) -> Result<DialogReservation, ErrorRecord> {
        let exhausted = |_| resource_error("dialog occurrence or metadata budget exhausted");
        let bytes = u32::try_from(bytes)
            .map_err(|_| resource_error("dialog metadata exceeds its retention limit"))?;
        let engine_occurrence = engine
            .occurrences
            .clone()
            .try_acquire_owned()
            .map_err(exhausted)?;
        let engine_bytes = engine
            .bytes
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(exhausted)?;
        let page_occurrence = page
            .occurrences
            .clone()
            .try_acquire_owned()
            .map_err(exhausted)?;
        let page_bytes = page
            .bytes
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(exhausted)?;
        Ok(DialogReservation {
            _engine_occurrence: engine_occurrence,
            _engine_bytes: engine_bytes,
            _page_occurrence: page_occurrence,
            _page_bytes: page_bytes,
        })
    }
}

struct DialogReservation {
    _engine_occurrence: OwnedSemaphorePermit,
    _engine_bytes: OwnedSemaphorePermit,
    _page_occurrence: OwnedSemaphorePermit,
    _page_bytes: OwnedSemaphorePermit,
}

pub(super) struct DialogOccurrence {
    pub identifier: String,
    pub page_identifier: String,
    pub session_identifier: String,
    pub frame_identifier: String,
    pub kind: DialogKind,
    pub event_json: Box<str>,
    _reservation: DialogReservation,
}

struct CurrentDialog {
    occurrence: Arc<DialogOccurrence>,
    handling: bool,
    navigation: Option<BeforeUnloadNavigation>,
}

pub(super) struct ClosedDialog {
    pub kind: DialogKind,
    pub navigation: Option<BeforeUnloadNavigation>,
}

pub(crate) struct DialogState {
    pub subscribed: bool,
    budget: Arc<DialogBudget>,
    current: Option<CurrentDialog>,
}

impl Default for DialogState {
    fn default() -> Self {
        Self {
            subscribed: false,
            budget: DialogBudget::new(MAXIMUM_PAGE_DIALOGS, MAXIMUM_PAGE_DIALOG_BYTES),
            current: None,
        }
    }
}

impl DialogState {
    /// Admission is synchronous in browser-event order; it never waits for another modal to settle.
    pub(super) fn open(
        &mut self,
        engine_budget: &DialogBudget,
        identifier: String,
        page_identifier: &str,
        session_identifier: &str,
        event_json: &str,
    ) -> Result<Arc<DialogOccurrence>, ErrorRecord> {
        if self.current.is_some() {
            return Err(protocol_error(
                "a new modal arrived before the current modal closed",
            ));
        }
        if event_json.len() > MAXIMUM_DIALOG_BYTES {
            return Err(resource_error("dialog metadata exceeds 1 MiB"));
        }
        let fields: OpeningFields =
            serde_json::from_str(event_json).map_err(|error| protocol_error(&error.to_string()))?;
        if fields.frame_id.is_empty()
            || !is_string(&fields.message)
            || fields
                .default_prompt
                .as_ref()
                .is_some_and(|value| !is_string(value))
        {
            return Err(protocol_error(
                "dialog opening omitted its frame or string metadata",
            ));
        }
        let retained_bytes = event_json
            .len()
            .checked_add(identifier.len())
            .and_then(|bytes| bytes.checked_add(page_identifier.len()))
            .and_then(|bytes| bytes.checked_add(session_identifier.len()))
            .and_then(|bytes| bytes.checked_add(fields.frame_id.len()))
            .ok_or_else(|| resource_error("dialog metadata size overflow"))?;
        let reservation = DialogBudget::reserve(engine_budget, &self.budget, retained_bytes)?;
        let occurrence = Arc::new(DialogOccurrence {
            identifier,
            page_identifier: page_identifier.to_owned(),
            session_identifier: session_identifier.to_owned(),
            frame_identifier: fields.frame_id,
            kind: fields.kind,
            event_json: event_json.into(),
            _reservation: reservation,
        });
        self.current = Some(CurrentDialog {
            occurrence: occurrence.clone(),
            handling: false,
            navigation: None,
        });
        Ok(occurrence)
    }

    /// The handler claims once before dispatch; its Arc retains credits beyond the closing event.
    pub(super) fn claim(
        &mut self,
        identifier: &str,
        method: &str,
    ) -> Result<Arc<DialogOccurrence>, ErrorRecord> {
        let current = self
            .current
            .as_mut()
            .filter(|current| current.occurrence.identifier == identifier)
            .ok_or_else(|| {
                ErrorRecord::new(
                    ErrorCode::Protocol,
                    method,
                    "the original dialog is no longer open",
                )
            })?;
        if current.handling {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                method,
                "Cannot handle dialog which is already handled!",
            ));
        }
        current.handling = true;
        Ok(current.occurrence.clone())
    }

    /// Bind the intent in the same event turn that admits the modal.
    pub(super) fn bind_navigation(&mut self, navigation: Option<BeforeUnloadNavigation>) {
        if let Some(current) = self.current.as_mut()
            && current.occurrence.kind == DialogKind::Beforeunload
        {
            current.navigation = navigation;
        }
    }

    /// Only browser events clear current visibility. A command reply never clears a successor.
    pub(super) fn closed(
        &mut self,
        session_identifier: &str,
        frame_identifier: &str,
    ) -> Option<ClosedDialog> {
        if self.current.as_ref().is_some_and(|current| {
            current.occurrence.session_identifier == session_identifier
                && current.occurrence.frame_identifier == frame_identifier
        }) {
            let current = self.current.take().unwrap();
            return Some(ClosedDialog {
                kind: current.occurrence.kind,
                navigation: current.navigation,
            });
        }
        None
    }

    pub(crate) fn retire(&mut self) {
        self.subscribed = false;
        self.current = None;
    }
}

fn is_string(value: &RawValue) -> bool {
    value.get().starts_with('"')
}

fn resource_error(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, "page.dialog", message)
}

fn protocol_error(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, "page.dialog", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENING: &str =
        r#"{"frameId":"frame","type":"prompt","message":"\ud800","defaultPrompt":"\udfff"}"#;

    fn open(
        state: &mut DialogState,
        budget: &DialogBudget,
        identifier: &str,
    ) -> Arc<DialogOccurrence> {
        state
            .open(budget, identifier.into(), "page", "session", OPENING)
            .unwrap()
    }

    #[test]
    fn late_command_custody_cannot_clear_or_claim_the_successor() {
        let budget = DialogBudget::engine();
        let mut state = DialogState::default();
        drop(open(&mut state, &budget, "first"));
        let pending_reply = state.claim("first", "dialog.accept").unwrap();
        assert!(state.claim("first", "dialog.dismiss").is_err());
        assert!(state.closed("session", "frame").is_some());
        drop(open(&mut state, &budget, "second"));
        assert_eq!(
            budget.occurrences.available_permits(),
            MAXIMUM_ENGINE_DIALOGS - 2
        );
        drop(pending_reply);
        assert_eq!(
            budget.occurrences.available_permits(),
            MAXIMUM_ENGINE_DIALOGS - 1
        );
        assert!(state.claim("first", "dialog.accept").is_err());
        assert_eq!(
            state.claim("second", "dialog.accept").unwrap().identifier,
            "second"
        );
    }

    #[test]
    fn original_session_and_raw_utf16_survive_page_retirement() {
        let budget = DialogBudget::engine();
        let mut state = DialogState::default();
        let occurrence = open(&mut state, &budget, "first");
        assert_eq!(occurrence.event_json.as_ref(), OPENING);
        assert_eq!(occurrence.kind, DialogKind::Prompt);
        assert_eq!(occurrence.page_identifier, "page");
        assert!(state.closed("other-session", "frame").is_none());
        assert!(state.closed("session", "other-frame").is_none());
        state.retire();
        assert_eq!(occurrence.session_identifier, "session");
        assert_eq!(
            budget.occurrences.available_permits(),
            MAXIMUM_ENGINE_DIALOGS - 1
        );
        drop(occurrence);
        assert_eq!(
            budget.occurrences.available_permits(),
            MAXIMUM_ENGINE_DIALOGS
        );
        assert_eq!(
            budget.bytes.available_permits(),
            MAXIMUM_ENGINE_DIALOG_BYTES
        );
    }

    #[test]
    fn failed_partial_admission_releases_all_engine_credits() {
        let budget = DialogBudget::engine();
        let mut state = DialogState {
            budget: DialogBudget::new(1, 1),
            ..Default::default()
        };
        assert!(
            state
                .open(&budget, "first".into(), "page", "session", OPENING)
                .is_err()
        );
        assert_eq!(
            budget.occurrences.available_permits(),
            MAXIMUM_ENGINE_DIALOGS
        );
        assert_eq!(
            budget.bytes.available_permits(),
            MAXIMUM_ENGINE_DIALOG_BYTES
        );
        assert!(state.current.is_none());
    }

    #[test]
    fn pending_reply_retains_global_admission_after_browser_close_event() {
        let budget = DialogBudget::new(1, MAXIMUM_ENGINE_DIALOG_BYTES);
        let mut first_page = DialogState::default();
        let mut second_page = DialogState::default();
        drop(open(&mut first_page, &budget, "first"));
        let pending_reply = first_page.claim("first", "dialog.accept").unwrap();
        assert!(first_page.closed("session", "frame").is_some());
        assert!(
            second_page
                .open(&budget, "second".into(), "page2", "session2", OPENING)
                .is_err()
        );
        drop(pending_reply);
        assert!(
            second_page
                .open(&budget, "second".into(), "page2", "session2", OPENING)
                .is_ok()
        );
    }

    #[test]
    fn malformed_metadata_cannot_install_an_active_occurrence() {
        let budget = DialogBudget::engine();
        for source in [
            r#"{"frameId":"frame","type":"prompt","message":1}"#,
            r#"{"frameId":"frame","type":"unknown","message":"message"}"#,
            r#"{"frameId":"","type":"alert","message":"message"}"#,
        ] {
            let mut state = DialogState::default();
            assert!(
                state
                    .open(&budget, "first".into(), "page", "session", source)
                    .is_err()
            );
            assert!(state.current.is_none());
            assert_eq!(
                budget.occurrences.available_permits(),
                MAXIMUM_ENGINE_DIALOGS
            );
        }
    }
}
