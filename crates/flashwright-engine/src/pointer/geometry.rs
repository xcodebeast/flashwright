//! CDP quads are relative to their renderer's local root, while native input is page-relative.

use super::*;
use crate::element_resolution::same_document;

impl PointerAttempt<'_, '_> {
    pub(super) async fn session_offset(&self) -> Result<Option<Point>, ErrorRecord> {
        let boundaries = {
            let state = self.action.page.state.state.lock().unwrap();
            let mut child = self.realm.context.frame_identifier.clone();
            let mut boundaries = Vec::new();
            loop {
                let frame = state
                    .frames
                    .get(&child)
                    .ok_or_else(evaluation::context_destroyed)?;
                let Some(parent) = frame.parent.as_ref() else {
                    break;
                };
                let parent_frame = state
                    .frames
                    .get(parent)
                    .ok_or_else(evaluation::context_destroyed)?;
                if frame.session_identifier != parent_frame.session_identifier {
                    boundaries.push((
                        child.clone(),
                        parent.clone(),
                        frame.session_identifier.clone(),
                        parent_frame.session_identifier.clone(),
                    ));
                }
                child = parent.clone();
            }
            boundaries
        };
        let mut offset = Point { x: 0.0, y: 0.0 };
        for (child, parent, child_session, parent_session) in boundaries {
            let realm = self
                .action
                .engine
                .locator_realm(
                    &self.action.page,
                    &self.action.browser,
                    &parent,
                    self.action.operation,
                    &self.action.method,
                )
                .await?;
            if realm.context.session_identifier != parent_session {
                return Err(evaluation::context_destroyed());
            }
            let owner = self
                .call(&realm, "DOM.getFrameOwner", json!({"frameId":child}))
                .await?;
            let element = self.allocation_call(&realm, "DOM.resolveNode", json!({
                "backendNodeId":owner["backendNodeId"], "executionContextId":realm.context.identifier,
                "objectGroup":self.token,
            }), false).await?;
            let object = string_field(&element["object"], "objectId")?;
            let model = self
                .call(&realm, "DOM.getBoxModel", json!({"objectId":object}))
                .await?;
            if !same_document(&self.action.page, &realm, &realm.context)
                || !same_document(&self.action.page, &self.realm, &self.realm.context)
            {
                return Err(evaluation::context_destroyed());
            }
            {
                let state = self.action.page.state.state.lock().unwrap();
                if !state.frames.get(&child).is_some_and(|frame| {
                    frame.parent.as_deref() == Some(&parent)
                        && frame.session_identifier == child_session
                }) {
                    return Err(evaluation::context_destroyed());
                }
            }
            let Some(points) = quad(&model["model"]["border"]) else {
                return Ok(None);
            };
            // Match the pinned Chromium delegate: add each remote root's iframe border box.
            offset.x += points
                .iter()
                .map(|point| point.x)
                .fold(f64::INFINITY, f64::min);
            offset.y += points
                .iter()
                .map(|point| point.y)
                .fold(f64::INFINITY, f64::min);
        }
        Ok(Some(offset))
    }
}
