//! Reload/history actions observe navigation events once and never replay a dispatched command.

use super::*;
use crate::navigation::load_state;
use crate::page_state::{NavigationEvent, NavigationOutcome};

impl Engine {
    pub(super) async fn navigate_history(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        validate_keys(method, &parameters, &["page", "waitUntil"])?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let wait_until = load_state(&parameters, "waitUntil", true, method)?;
        let (frame_identifier, before) = {
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            (
                state.main_frame.clone().ok_or_else(|| closed(method))?,
                state.sequence,
            )
        };
        let (command, command_parameters) = if method == "page.reload" {
            ("Page.reload", json!({}))
        } else {
            let history = operation
                .wait(page.state.while_alive(
                    method,
                    browser.connection.call(
                        "Page.getNavigationHistory",
                        json!({}),
                        Some(&page.session_identifier),
                    ),
                ))
                .await?;
            let current_index = history["currentIndex"]
                .as_i64()
                .ok_or_else(|| history_protocol_error(method, "currentIndex"))?;
            let entries = history["entries"]
                .as_array()
                .ok_or_else(|| history_protocol_error(method, "entries"))?;
            let delta = if method == "page.goBack" { -1 } else { 1 };
            let entry = current_index
                .checked_add(delta)
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| entries.get(index));
            let Some(entry) = entry else {
                let state = page.state.state.lock().unwrap();
                state.check(method)?;
                return Ok(json!({"response":null,"frames":state.frame_snapshot()}));
            };
            let identifier = entry["id"]
                .as_i64()
                .ok_or_else(|| history_protocol_error(method, "entry.id"))?;
            ("Page.navigateToHistoryEntry", json!({"entryId":identifier}))
        };
        operation.check()?;
        operation
            .wait(page.state.while_alive(
                method,
                browser.connection.call(
                    command,
                    command_parameters,
                    Some(&page.session_identifier),
                ),
            ))
            .await?;
        let navigation = Self::wait_for_history_navigation(
            &page,
            &frame_identifier,
            before,
            method == "page.reload",
            operation,
            method,
        )
        .await?;
        Self::complete_navigation(
            &page,
            &frame_identifier,
            &navigation,
            before,
            wait_until,
            operation,
            method,
        )
        .await
    }

    pub(super) async fn complete_navigation(
        page: &Page,
        frame_identifier: &str,
        navigation: &NavigationEvent,
        before: u64,
        wait_until: &str,
        operation: &Operation,
        method: &str,
    ) -> Result<Value, ErrorRecord> {
        let (loader, expects_response) = match &navigation.outcome {
            NavigationOutcome::Document {
                loader,
                has_network_request,
            } => (loader, *has_network_request),
            NavigationOutcome::SameDocument { loader } => (loader, false),
            NavigationOutcome::Failed(error) => {
                return Err(ErrorRecord::new(ErrorCode::Navigation, method, error));
            }
        };
        Self::wait_for_document(
            page,
            frame_identifier,
            Some(loader),
            before,
            wait_until,
            operation,
            method,
        )
        .await?;
        let state = page.state.state.lock().unwrap();
        state.check(method)?;
        let response = if matches!(navigation.outcome, NavigationOutcome::Document { .. }) {
            let response = state.response_for_loader(loader);
            if expects_response && response.is_none() {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "navigation response is outside the bounded retained history",
                ));
            }
            response
        } else {
            None
        };
        Ok(json!({"response":response,"frames":state.frame_snapshot()}))
    }

    /// Retain the first matching event even if it arrives before the action acknowledgement.
    pub(super) async fn wait_for_history_navigation(
        page: &Page,
        frame_identifier: &str,
        before: u64,
        requires_new_document: bool,
        operation: &Operation,
        method: &str,
    ) -> Result<NavigationEvent, ErrorRecord> {
        let mut changes = page.state.changed.subscribe();
        loop {
            {
                let state = page.state.state.lock().unwrap();
                state.check(method)?;
                if before < state.discarded_navigation_sequence {
                    return Err(ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        method,
                        "navigation events exceeded the bounded retained history",
                    ));
                }
                if let Some(event) = state.navigation_events.iter().find(|event| {
                    event.sequence > before
                        && event.frame_identifier == frame_identifier
                        && (!requires_new_document
                            || !matches!(event.outcome, NavigationOutcome::SameDocument { .. }))
                }) {
                    return Ok(event.clone());
                }
            }
            operation
                .wait(async { changes.changed().await.map_err(|_| closed(method)) })
                .await?;
        }
    }
}

fn history_protocol_error(method: &str, field: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Protocol,
        method,
        format!("Chromium omitted navigation history {field}"),
    )
}
