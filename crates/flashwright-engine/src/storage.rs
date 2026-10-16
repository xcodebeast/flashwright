//! Storage state uses private origin pages whose requests are fulfilled without network access.

use super::*;
use cookies::{Cookie, get_cookies, set_cookies};
use flashwright_browser::Connection;
use serde::Serialize;
use tokio::sync::broadcast;

const STORAGE_RUNTIME: &str = include_str!("../../../packages/resident-runtime/storage.cjs");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StorageState {
    cookies: Vec<Cookie>,
    origins: Vec<StorageOrigin>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageOrigin {
    origin: String,
    local_storage: Vec<StorageEntry>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StorageEntry {
    name: Vec<u16>,
    value: Vec<u16>,
}

impl StorageState {
    pub fn parse(value: Value, method: &str) -> Result<Self, ErrorRecord> {
        let state: Self = parse(method, value)?;
        if state.origins.len() > context_state::MAXIMUM_STORAGE_ORIGINS {
            return Err(storage_limit(method));
        }
        for cookie in &state.cookies {
            cookie.validate(method)?;
        }
        for origin in &state.origins {
            if !origin.origin.starts_with("http://") && !origin.origin.starts_with("https://") {
                return Err(ErrorRecord::new(
                    ErrorCode::UnsupportedFeature,
                    method,
                    "storage state currently supports HTTP and HTTPS origins",
                ));
            }
        }
        Ok(state)
    }
}

impl Engine {
    pub(crate) async fn restore_initial_storage(
        &self,
        identifier: &str,
        storage: StorageState,
        operation: &Operation,
    ) -> Result<(), ErrorRecord> {
        let context = self.context(identifier, "browser.newContext")?;
        let browser = self.browser(&context.browser_identifier, "browser.newContext")?;
        if !storage.cookies.is_empty() {
            set_cookies(&context, &browser, &storage.cookies, operation).await?;
        }
        if !storage.origins.is_empty() {
            self.storage_pages(
                identifier,
                &context,
                &browser,
                &storage.origins,
                true,
                operation,
            )
            .await?;
            for origin in &storage.origins {
                context.state.visit(&origin.origin)?;
            }
        }
        Ok(())
    }

    pub(crate) async fn storage_state(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "context.storageState";
        validate_keys(method, &parameters, &["context"])?;
        let identifier = identifier(&parameters, "context", method)?;
        let context = self.context(identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let _exclusive = operation
            .wait(context.state.while_alive(method, async {
                Ok(context.state.storage_operations.lock().await)
            }))
            .await?;
        operation
            .wait(
                context
                    .state
                    .while_alive(method, browser.connection.synchronize_events()),
            )
            .await?;
        if let Some(error) = context.state.storage_failure.lock().unwrap().clone() {
            return Err(error);
        }
        let origins: Vec<_> = context
            .state
            .origins
            .lock()
            .unwrap()
            .iter()
            .map(|origin| StorageOrigin {
                origin: origin.clone(),
                local_storage: Vec::new(),
            })
            .collect();
        let cookies = get_cookies(&context, &browser, operation, method).await?;
        let origins = if origins.is_empty() {
            Vec::new()
        } else {
            self.storage_pages(identifier, &context, &browser, &origins, false, operation)
                .await?
        };
        let result = json!({ "cookies": cookies, "origins": origins });
        if serde_json::to_vec(&result)
            .map_err(|error| invalid(method, &error.to_string()))?
            .len()
            > 7 * 1024 * 1024
        {
            return Err(storage_limit(method));
        }
        Ok(result)
    }

    /// A temporary page remains registered for close/crash handling but never publishes
    /// application events. Its paused requests and late replies end with its target.
    #[allow(clippy::too_many_arguments)]
    async fn storage_pages(
        &self,
        context_identifier: &str,
        context: &Context,
        browser: &Chromium,
        origins: &[StorageOrigin],
        restore: bool,
        operation: &Operation,
    ) -> Result<Vec<StorageOrigin>, ErrorRecord> {
        let method = if restore {
            "browser.newContext.storageState"
        } else {
            "context.storageState"
        };
        let created = self
            .create_page(context_identifier, PagePurpose::Storage, operation)
            .await?;
        let page_identifier = identifier(&created, "identifier", method)?;
        let page = self.page(page_identifier, method)?;
        let mut events = browser.connection.subscribe();
        let intercept = async {
            loop {
                let event = events.recv().await.map_err(|error| match error {
                    broadcast::error::RecvError::Lagged(_) => ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        method,
                        "storage interception event queue overflowed",
                    ),
                    broadcast::error::RecvError::Closed => closed(method),
                })?;
                if event.session_identifier.as_deref() != Some(&page.session_identifier)
                    || event.method != "Fetch.requestPaused"
                {
                    continue;
                }
                let parameters: Value = match event.parameters {
                    Some(parameters) => serde_json::from_str(parameters.get())
                        .map_err(|error| invalid(method, &error.to_string()))?,
                    None => return Err(invalid(method, "Chromium omitted paused storage request")),
                };
                let request = string_field(&parameters, "requestId")?;
                fulfill_storage_request(&browser.connection, &page.session_identifier, &request)
                    .await?;
            }
        };
        let work = async {
            browser
                .connection
                .call(
                    "Network.setBypassServiceWorker",
                    json!({ "bypass": true }),
                    Some(&page.session_identifier),
                )
                .await?;
            browser
                .connection
                .call(
                    "Fetch.enable",
                    json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] }),
                    Some(&page.session_identifier),
                )
                .await?;
            let mut collected = Vec::new();
            let mut units = 0_usize;
            for origin in origins {
                self.navigate(json!({ "page": page_identifier, "url": origin.origin, "waitUntil": "domcontentloaded" }), operation).await?;
                browser.connection.synchronize_events().await?;
                let execution_context = page
                    .state
                    .state
                    .lock()
                    .unwrap()
                    .main_execution_context()
                    .cloned()
                    .ok_or_else(evaluation::context_destroyed)?;
                let invocation = if restore {
                    format!(
                        "exports.restoreLocalStorage({})",
                        serde_json::to_string(&origin.local_storage)
                            .map_err(|error| invalid(method, &error.to_string()))?
                    )
                } else {
                    "exports.collectLocalStorage()".into()
                };
                let result = page.state.while_execution_context(&execution_context, browser.connection.call(
                    "Runtime.evaluate", json!({
                        "expression": format!("(() => {{ const exports = {{}}; {STORAGE_RUNTIME}; return {invocation}; }})()"),
                        "uniqueContextId": execution_context.unique_identifier, "returnByValue": true,
                    }), Some(&execution_context.session_identifier),
                )).await?;
                crate::locators::check_exception(&result, method)?;
                let value = &result["result"]["value"];
                match value["outcome"].as_str() {
                    Some("limit") => return Err(storage_limit(method)),
                    Some("error") => {
                        let message: Vec<u16> = parse(method, value["message"].clone())?;
                        let mut error = ErrorRecord::new(
                            ErrorCode::Evaluation,
                            method,
                            String::from_utf16_lossy(&message),
                        );
                        error.message_utf16 = Some(message.into_boxed_slice());
                        return Err(error);
                    }
                    Some("success") => {}
                    _ => return Err(invalid(method, "Chromium omitted storage result")),
                }
                let entries: Vec<StorageEntry> = parse(method, value["entries"].clone())?;
                units += entries
                    .iter()
                    .map(|entry| entry.name.len() + entry.value.len() + 2)
                    .sum::<usize>();
                if units > 100000 {
                    return Err(storage_limit(method));
                }
                if !entries.is_empty() {
                    collected.push(StorageOrigin {
                        origin: origin.origin.clone(),
                        local_storage: entries,
                    });
                }
            }
            Ok(collected)
        };
        let result = operation
            .wait(context.state.while_alive(
                method,
                page.state.while_alive(method, async {
                    tokio::select! {
                        result = work => result,
                        result = intercept => result,
                    }
                }),
            ))
            .await;
        let result = match result {
            Ok(value) => operation
                .wait(self.close_page(page_identifier))
                .await
                .map(|()| value),
            Err(error) => Err(error),
        };
        match result {
            Ok(value) => Ok(value),
            Err(mut error) => {
                self.registry.lock().unwrap().pages.remove(page_identifier);
                self.finish_page(page_identifier, &page, closed(method), "close");
                error.method = method.into();
                error.cleanup = Some(
                    page.state
                        .disposal
                        .dispose(browser, &page.target_identifier)
                        .await
                        .into(),
                );
                Err(error)
            }
        }
    }
}

fn storage_limit(method: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::ResourceLimit,
        method,
        "storage snapshot exceeds its origin, UTF-16 or control-message limit",
    )
}

/// Navigation can retire a paused subresource before its fulfillment is dispatched.
/// That request is already gone; consume the rejection without replaying it or
/// failing collection from the successor origin. Other protocol failures remain fatal.
async fn fulfill_storage_request(
    connection: &Connection,
    session_identifier: &str,
    request_identifier: &str,
) -> Result<(), ErrorRecord> {
    // Full Chrome can request a fallback favicon after the private target starts
    // closing and interception is detached. Give this inert document its own
    // inline icon so storage collection never initiates that network request.
    let document = b"<!doctype html><title>Storage</title><link rel=\"icon\" href=\"data:,\">";
    let result = connection.call("Fetch.fulfillRequest", json!({
        "requestId": request_identifier, "responseCode": 200,
        "responseHeaders": [{ "name": "Content-Type", "value": "text/html; charset=utf-8" }],
        "body": flashwright_protocol::attachment::encode_base64(document),
    }), Some(session_identifier)).await;
    match result {
        Ok(_) => Ok(()),
        Err(error)
            if error.browser_error_code == Some(-32602)
                && serde_json::from_str::<Value>(&error.message)
                    .ok()
                    .is_some_and(|value| value["message"] == "Invalid InterceptionId.") =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex, split};

    async fn fulfillment_replies(replies: Vec<Value>) -> Vec<Result<(), ErrorRecord>> {
        let (host, peer) = duplex(4096);
        let (reader, writer) = split(host);
        let connection = Connection::new(reader, writer);
        let (reader, mut writer) = split(peer);
        let mut reader = BufReader::new(reader);
        let fulfillments = async {
            let mut results = Vec::new();
            for index in 0..replies.len() {
                results.push(
                    fulfill_storage_request(
                        &connection,
                        "storage-page",
                        &format!("request-{index}"),
                    )
                    .await,
                );
            }
            results
        };
        let chromium = async {
            for (index, reply) in replies.iter().enumerate() {
                let mut bytes = Vec::new();
                reader.read_until(0, &mut bytes).await.unwrap();
                let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
                assert_eq!(command["method"], "Fetch.fulfillRequest");
                assert_eq!(command["sessionId"], "storage-page");
                assert_eq!(command["params"]["requestId"], format!("request-{index}"));
                let mut reply = reply.clone();
                reply["id"] = command["id"].clone();
                let mut bytes = serde_json::to_vec(&reply).unwrap();
                bytes.push(0);
                writer.write_all(&bytes).await.unwrap();
            }
        };
        let (results, ()) = tokio::join!(fulfillments, chromium);
        results
    }

    #[tokio::test]
    async fn cancelled_interception_does_not_replay_or_fail_the_successor() {
        let results = fulfillment_replies(vec![
            json!({ "error": { "code": -32602, "message": "Invalid InterceptionId." } }),
            json!({ "result": {} }),
        ])
        .await;
        assert!(results.into_iter().all(|result| result.is_ok()));
    }

    #[tokio::test]
    async fn unrelated_fulfillment_errors_are_not_hidden() {
        let results = fulfillment_replies(vec![
            json!({ "error": { "code": -32602, "message": "Invalid parameters." } }),
            json!({ "error": { "code": -32000, "message": "Invalid InterceptionId." } }),
        ])
        .await;
        assert!(results.into_iter().all(|result| result.is_err()));
    }
}
