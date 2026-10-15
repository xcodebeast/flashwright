//! Content replacement preserves the original world while starting fresh load-state observation.

use super::*;
use crate::page_state::ExecutionContext;
use std::sync::atomic::AtomicBool;

const METHOD: &str = "page.setContent";
const MAXIMUM_HTML_UNITS: usize = 1_000_000;
const MARKER_PREFIX: &str = "__flashwright_content_";

const REPLACE_DOCUMENT: &str = r#"function(encodedHtml, token, deadline) {
    const expired = () => deadline !== null && Date.now() >= deadline;
    if (expired()) return false;
    const bytes = atob(encodedHtml);
    let html = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) {
        const units = [];
        const end = Math.min(offset + 16384, bytes.length);
        for (let index = offset; index < end; index += 2)
            units.push(bytes.charCodeAt(index) | (bytes.charCodeAt(index + 1) << 8));
        html += String.fromCharCode(...units);
    }
    if (expired()) return false;
    document.open();
    console.debug(token);
    globalThis.__flashwrightLocatorRuntime.documentReplaced();
    document.write(html);
    document.close();
    return true;
}"#;

pub(crate) struct ContentMarker {
    context: ExecutionContext,
    observed: Arc<AtomicBool>,
}

struct MarkerRegistration {
    page: Arc<PageState>,
    token: String,
}

impl Drop for MarkerRegistration {
    fn drop(&mut self) {
        self.page
            .content_markers
            .lock()
            .unwrap()
            .remove(&self.token);
    }
}

impl Engine {
    pub(crate) async fn set_content(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        validate_keys(
            METHOD,
            &parameters,
            &["page", "htmlUtf16Base64", "waitUntil"],
        )?;
        let html = parameters["htmlUtf16Base64"]
            .as_str()
            .ok_or_else(|| invalid(METHOD, "htmlUtf16Base64 must be a string"))?;
        let byte_length = flashwright_protocol::attachment::base64_decoded_length(html.as_bytes())
            .filter(|length| length.is_multiple_of(2))
            .ok_or_else(|| {
                invalid(
                    METHOD,
                    "HTML must be canonical base64 containing complete UTF-16LE units",
                )
            })?;
        if byte_length / 2 > MAXIMUM_HTML_UNITS {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                METHOD,
                "HTML exceeds 1000000 UTF-16 units",
            ));
        }
        let wait_until = navigation::load_state(&parameters, "waitUntil", true, METHOD)?;
        let page = self.page(identifier(&parameters, "page", METHOD)?, METHOD)?;
        let context = self.context(&page.context_identifier, METHOD)?;
        let browser = self.browser(&context.browser_identifier, METHOD)?;
        let frame = page
            .state
            .state
            .lock()
            .unwrap()
            .main_frame
            .clone()
            .ok_or_else(|| closed(METHOD))?;
        let realm = self
            .locator_realm(&page, &browser, &frame, operation, METHOD)
            .await?;
        let token = format!("{MARKER_PREFIX}{}", self.identifier("replacement"));
        let observed = Arc::new(AtomicBool::new(false));
        {
            let mut markers = page.state.content_markers.lock().unwrap();
            if markers.len() >= 128 {
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    METHOD,
                    "too many pending content replacements",
                ));
            }
            markers.insert(
                token.clone(),
                ContentMarker {
                    context: realm.context.clone(),
                    observed: observed.clone(),
                },
            );
        }
        let _registration = MarkerRegistration {
            page: page.state.clone(),
            token: token.clone(),
        };
        operation.check()?;
        let mut command = browser.connection.start_command("Runtime.callFunctionOn", json!({
            "uniqueContextId": realm.context.unique_identifier,
            "functionDeclaration": REPLACE_DOCUMENT,
            "arguments": [{"value":html},{"value":token},{"value":operation.renderer_deadline()}],
            "returnByValue":true, "userGesture":true,
        }), Some(&realm.context.session_identifier))?;
        let result = operation
            .wait(
                page.state
                    .while_execution_context(&realm.context, command.response()),
            )
            .await;
        let result = match result {
            Err(mut error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                if command.prevent_dispatch() {
                    error.cleanup = Some("notDispatched".into());
                } else if matches!(command.try_response(), Some(Ok(_))) {
                    error.cleanup = Some("contentReplacementFinished".into());
                } else {
                    // An already submitted write may be queued behind arbitrary application JS.
                    // Retire its owner instead of allowing a late mutation after cancellation.
                    error.cleanup = Some(
                        page.state
                            .disposal
                            .dispose(browser.as_ref(), &page.target_identifier)
                            .await
                            .into(),
                    );
                }
                return Err(error);
            }
            result => result?,
        };
        locators::check_exception(&result, METHOD)?;
        if result["result"]["value"] != true {
            return Err(ErrorRecord::new(
                ErrorCode::Timeout,
                METHOD,
                "content replacement expired before dispatch",
            ));
        }
        operation
            .wait(
                page.state
                    .while_alive(METHOD, browser.connection.synchronize_events()),
            )
            .await?;
        if !observed.load(Ordering::Acquire) {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                METHOD,
                "content replacement lifecycle boundary was not observed",
            ));
        }
        Self::wait_for_document(&page, &frame, None, 0, wait_until, operation, METHOD).await?;
        Ok(Value::Null)
    }

    /// Consume only a registered marker from its original isolated world, before public console capture.
    pub(crate) fn content_marker(&self, page: &Page, session: &str, message: &str) -> bool {
        if !message.contains(MARKER_PREFIX) {
            return false;
        }
        let Ok(event) = serde_json::from_str::<Value>(message) else {
            return false;
        };
        let Some(arguments) = event["args"].as_array() else {
            return false;
        };
        if event["type"] != "debug" || arguments.len() != 1 {
            return false;
        }
        let Some(token) = arguments[0]["value"].as_str() else {
            return false;
        };
        let markers = page.state.content_markers.lock().unwrap();
        let Some(marker) = markers.get(token) else {
            return false;
        };
        let mut state = page.state.state.lock().unwrap();
        if marker.context.session_identifier.as_ref() != session
            || event["executionContextId"].as_u64() != Some(marker.context.identifier)
            || !state.context_is_alive(&marker.context)
            || marker.observed.load(Ordering::Acquire)
        {
            return false;
        }
        let frame_identifier = &marker.context.frame_identifier;
        let Some(frame) = state.frames.get_mut(frame_identifier) else {
            return false;
        };
        frame.lifecycle.clear();
        frame.lifecycle.insert("commit".to_owned());
        let loader = frame.loader.clone();
        if let Some(history) = state.completed_lifecycle.get_mut(&loader) {
            history.clear();
            history.insert("commit".to_owned());
        }
        let retained: Vec<String> = state
            .active_requests
            .iter()
            .filter(|identifier| {
                state.requests.get(identifier).is_some_and(|request| {
                    request.metadata()["frame"] != *frame_identifier
                        || (request.metadata()["navigation"] == true
                            && request.metadata()["loader"] == loader)
                })
            })
            .cloned()
            .collect();
        state.active_requests = retained.into_iter().collect();
        state.idle_since = state
            .active_requests
            .is_empty()
            .then(tokio::time::Instant::now);
        state.sequence += 1;
        page.state.changed.send_replace(state.sequence);
        marker.observed.store(true, Ordering::Release);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Engine, Page, Arc<AtomicBool>) {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Engine::new(None, outgoing, fatal, ResourceLimits::default());
        let state = Arc::new(PageState::default());
        let context = ExecutionContext {
            session_identifier: "session".into(),
            identifier: 7,
            unique_identifier: "original-world".into(),
            frame_identifier: "main".into(),
        };
        {
            let mut document = state.state.lock().unwrap();
            document.initialize_main_frame("main", "session");
            document.observe_in_session(
                "session",
                "Page.frameNavigated",
                &json!({"frame":{"id":"main","url":"http://fixture/","loaderId":"loader"}}),
            );
            document
                .execution_contexts
                .insert(context.key(), context.clone());
            document.main_worlds.insert("main".into(), context.clone());
            document
                .frames
                .get_mut("main")
                .unwrap()
                .lifecycle
                .extend(["load".into(), "networkidle".into()]);
            document
                .completed_lifecycle
                .get_mut("loader")
                .unwrap()
                .extend(["load".into(), "networkidle".into()]);
            document.idle_since = Some(tokio::time::Instant::now() - Duration::from_secs(1));
        }
        let observed = Arc::new(AtomicBool::new(false));
        state.content_markers.lock().unwrap().insert(
            "__flashwright_content_test".into(),
            ContentMarker {
                context,
                observed: observed.clone(),
            },
        );
        (
            engine,
            Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state,
            },
            observed,
        )
    }

    fn event(context: u64) -> String {
        json!({"type":"debug","executionContextId":context,"args":[{"type":"string","value":"__flashwright_content_test"}]}).to_string()
    }

    #[test]
    fn original_marker_restarts_load_history_without_destroying_the_world() {
        let (engine, page, observed) = fixture();
        assert!(engine.content_marker(&page, "session", &event(7)));
        assert!(observed.load(Ordering::Acquire));
        let state = page.state.state.lock().unwrap();
        assert_eq!(
            state.completed_lifecycle["loader"],
            std::collections::HashSet::from(["commit".to_owned()])
        );
        assert_eq!(
            state.frames["main"].lifecycle,
            std::collections::HashSet::from(["commit".to_owned()])
        );
        assert!(state.idle_since.unwrap().elapsed() < Duration::from_millis(100));
        assert!(state.context_is_alive(&state.main_worlds["main"]));
    }

    #[test]
    fn marker_from_another_session_or_reused_numeric_world_cannot_reset_lifecycle() {
        let (engine, page, observed) = fixture();
        assert!(!engine.content_marker(&page, "other-session", &event(7)));
        assert!(!engine.content_marker(&page, "session", &event(8)));
        {
            let mut state = page.state.state.lock().unwrap();
            state
                .execution_contexts
                .get_mut(&("session".into(), 7))
                .unwrap()
                .unique_identifier = "replacement-world".into();
        }
        assert!(!engine.content_marker(&page, "session", &event(7)));
        assert!(!observed.load(Ordering::Acquire));
        assert!(page.state.state.lock().unwrap().completed_lifecycle["loader"].contains("load"));
    }

    #[test]
    fn retired_registration_cannot_consume_a_console_event() {
        let (engine, page, _) = fixture();
        drop(MarkerRegistration {
            page: page.state.clone(),
            token: "__flashwright_content_test".into(),
        });
        assert!(!engine.content_marker(&page, "session", &event(7)));
        assert!(page.state.content_markers.lock().unwrap().is_empty());
    }
}
