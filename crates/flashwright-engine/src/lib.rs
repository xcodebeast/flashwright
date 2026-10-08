//! Browser object ownership and semantic operations, independent of the Node test runner.

mod assertions;
mod console;
mod context_state;
mod cookies;
mod evaluation;
mod events;
mod handle_values;
mod handles;
mod input;
mod keyboard;
mod locators;
mod navigation;
mod operation;
mod page_state;
mod pointer;
mod publication;
mod screenshots;
mod storage;
pub use operation::Operation;
use operation::{ResourceKind, close_resource, dispose};

use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use flashwright_browser::{Chromium, LaunchOptions};
use flashwright_protocol::{
    BinaryAttachment, DriverOutput, ErrorCode, ErrorRecord, ResourceLimits,
};
use page_state::PageState;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::time::{Duration, timeout};

const VALUE_CODEC: &str = include_str!("../../../packages/resident-runtime/serialization.cjs");
pub const RESIDENT_RUNTIME_SHA256: &str = env!("FLASHWRIGHT_RUNTIME_SHA256");
pub const CAPABILITIES: &[&str] = &[
    "browser.launch",
    "browser.close",
    "browser.newContext",
    "context.newPage",
    "context.close",
    "context.cookies",
    "context.addCookies",
    "context.clearCookies",
    "context.storageState",
    "page.close",
    "page.evaluate",
    "page.evaluateHandle",
    "frame.evaluate",
    "frame.evaluateHandle",
    "handle.evaluate",
    "handle.evaluateHandle",
    "handle.jsonValue",
    "handle.getProperty",
    "handle.getProperties",
    "handle.dispose",
    "handle.discard",
    "page.event.pageerror",
    "page.console.subscribe",
    "context.console.subscribe",
    "page.screenshot",
    "page.goto",
    "page.waitForLoadState",
    "response.body",
    "locator.run",
    "assertion.run",
    "keyboard.press",
];

pub struct Engine {
    next_identifier: AtomicU64,
    registry: Mutex<Registry>,
    parent_liveness: Option<OwnedFd>,
    outgoing: mpsc::Sender<DriverOutput>,
    fatal: watch::Sender<bool>,
    resident_assertions: bool,
    condition_instrumentation: bool,
    attachment_slots: Arc<tokio::sync::Semaphore>,
    maximum_attachment_bytes: usize,
}

pub enum OperationResult {
    Value(Value),
    Binary(BinaryAttachment),
}

#[derive(Default)]
struct Registry {
    browsers: HashMap<String, Browser>,
    contexts: HashMap<String, Context>,
    pages: HashMap<String, Page>,
}

struct Browser {
    browser: Arc<Chromium>,
    published: bool,
}

#[derive(Clone)]
struct Context {
    browser_identifier: String,
    protocol_identifier: String,
    viewport: Option<Viewport>,
    state: Arc<context_state::ContextState>,
    published: bool,
}

#[derive(Clone)]
struct Page {
    context_identifier: String,
    target_identifier: String,
    session_identifier: String,
    state: Arc<PageState>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Viewport {
    width: u32,
    height: u32,
}

impl Engine {
    pub fn new(
        parent_liveness: Option<OwnedFd>,
        outgoing: mpsc::Sender<DriverOutput>,
        fatal: watch::Sender<bool>,
        limits: ResourceLimits,
    ) -> Self {
        Self {
            attachment_slots: Arc::new(tokio::sync::Semaphore::new(limits.pending_attachments)),
            maximum_attachment_bytes: limits.binary_attachment_bytes,
            resident_assertions: std::env::var("FLASHWRIGHT_RESIDENT_ASSERTIONS").as_deref()
                != Ok("0"),
            condition_instrumentation: std::env::var("FLASHWRIGHT_CONDITION_INSTRUMENTATION")
                .as_deref()
                == Ok("1"),
            parent_liveness,
            outgoing,
            fatal,
            next_identifier: AtomicU64::new(0),
            registry: Mutex::new(Registry::default()),
        }
    }
    fn identifier(&self, kind: &str) -> String {
        format!(
            "{kind}-{}",
            self.next_identifier.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    pub async fn execute(
        self: &Arc<Self>,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<OperationResult, ErrorRecord> {
        operation.check()?;
        if let Some(result) = self.execute_control(method, &parameters, operation) {
            return result.map(OperationResult::Value);
        }
        if method == "page.screenshot" {
            return self
                .screenshot(parameters, operation)
                .await
                .map(OperationResult::Binary);
        }
        if method == "response.body" {
            return self
                .response_body(parameters, operation)
                .await
                .map(OperationResult::Binary);
        }
        self.execute_value(method, parameters, operation)
            .await
            .map(OperationResult::Value)
    }

    async fn execute_value(
        self: &Arc<Self>,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        operation.check()?;
        match method {
            "browser.launch" => {
                validate_keys(method, &parameters, &["executablePath", "headless"])?;
                let options: LaunchOptions = parse(method, parameters)?;
                let browser = Arc::new(
                    operation
                        .wait(Chromium::launch(options, self.parent_liveness.as_ref()))
                        .await?,
                );
                let identifier = self.identifier("browser");
                let result = json!({ "identifier": identifier, "version": browser.version.split('/').next_back(), "processIdentifier": browser.process_identifier() });
                self.registry.lock().unwrap().browsers.insert(
                    identifier.clone(),
                    Browser {
                        browser: browser.clone(),
                        published: false,
                    },
                );
                if let Err(mut error) = operation
                    .wait(async {
                        self.observe_browser(identifier.clone(), &browser)?;
                        browser
                            .connection
                            .call(
                                "Target.setDiscoverTargets",
                                json!({ "discover": true }),
                                None,
                            )
                            .await
                    })
                    .await
                {
                    error.cleanup = self
                        .discard_unreturned_allocation(method, &result)
                        .await
                        .map(Into::into);
                    return Err(error);
                }
                Ok(result)
            }
            "browser.newContext" => self.new_context(parameters, operation).await,
            "context.newPage" => self.new_page(parameters, operation).await,
            "context.cookies" | "context.addCookies" | "context.clearCookies" => {
                self.context_cookies(method, parameters, operation).await
            }
            "context.storageState" => self.storage_state(parameters, operation).await,
            "page.goto" => self.navigate(parameters, operation).await,
            "page.waitForLoadState" => self.wait_for_load_state(parameters, operation).await,
            "locator.run" => self.run_locator(parameters, operation).await,
            "assertion.run" => self.run_assertion(parameters, operation).await,
            "keyboard.press" => self.press_page_key(parameters, operation).await,
            "page.evaluate" | "frame.evaluate" | "handle.evaluate" => self
                .evaluate(method, parameters, operation)
                .await
                .map_err(|mut error| {
                    error.method = method.into();
                    error
                }),
            "page.evaluateHandle" | "frame.evaluateHandle" | "handle.evaluateHandle" => self
                .evaluate_handle(method, parameters, operation)
                .await
                .map_err(|mut error| {
                    error.method = method.into();
                    error
                }),
            "handle.jsonValue" => self.handle_json_value(parameters, operation).await,
            "handle.getProperty" => self.handle_get_property(parameters, operation).await,
            "handle.getProperties" => self.handle_get_properties(parameters, operation).await,
            "handle.dispose" => self.dispose_handle(parameters, operation).await,
            "handle.discard" => self.discard_handle_group(parameters).await,
            "browser.close" => {
                validate_keys(method, &parameters, &["browser"])?;
                let identifier = identifier(&parameters, "browser", method)?;
                self.close_browser(identifier).await?;
                Ok(Value::Null)
            }
            "context.close" => {
                validate_keys(method, &parameters, &["context"])?;
                self.close_context(identifier(&parameters, "context", method)?)
                    .await?;
                Ok(Value::Null)
            }
            "page.close" => {
                validate_keys(method, &parameters, &["page"])?;
                self.close_page(identifier(&parameters, "page", method)?)
                    .await?;
                Ok(Value::Null)
            }
            _ => Err(ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                method,
                "operation is not implemented in this development build",
            )),
        }
    }

    fn browser(&self, identifier: &str, method: &str) -> Result<Arc<Chromium>, ErrorRecord> {
        self.registry
            .lock()
            .unwrap()
            .browsers
            .get(identifier)
            .map(|entry| entry.browser.clone())
            .ok_or_else(|| closed(method))
    }

    fn context(&self, identifier: &str, method: &str) -> Result<Context, ErrorRecord> {
        self.registry
            .lock()
            .unwrap()
            .contexts
            .get(identifier)
            .cloned()
            .ok_or_else(|| closed(method))
    }

    fn page(&self, identifier: &str, method: &str) -> Result<Page, ErrorRecord> {
        self.registry
            .lock()
            .unwrap()
            .pages
            .get(identifier)
            .cloned()
            .ok_or_else(|| closed(method))
    }

    async fn new_context(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "browser.newContext";
        validate_keys(
            method,
            &parameters,
            &["browser", "viewport", "storageState"],
        )?;
        let storage = parameters
            .get("storageState")
            .map(|value| storage::StorageState::parse(value.clone(), method))
            .transpose()?;
        let browser_identifier = identifier(&parameters, "browser", method)?.to_owned();
        let browser = self.browser(&browser_identifier, method)?;
        let viewport = match parameters.get("viewport") {
            None => Some(Viewport {
                width: 1280,
                height: 720,
            }),
            Some(Value::Null) => None,
            Some(value) => Some(parse::<Viewport>(method, value.clone())?),
        };
        if viewport
            .as_ref()
            .is_some_and(|viewport| viewport.width == 0 || viewport.height == 0)
        {
            return Err(ErrorRecord::new(
                ErrorCode::InvalidArgument,
                method,
                "viewport dimensions must be positive integers",
            ));
        }
        let protocol_identifier = operation
            .allocate(
                browser.as_ref(),
                "Target.createBrowserContext",
                json!({ "disposeOnDetach": true }),
                ResourceKind::Context,
            )
            .await?;
        let mut result = (|| {
            let mut registry = self.registry.lock().unwrap();
            operation.check()?;
            if !registry.browsers.contains_key(&browser_identifier) {
                return Err(closed(method));
            }
            let identifier = self.identifier("context");
            registry.contexts.insert(
                identifier.clone(),
                Context {
                    browser_identifier,
                    protocol_identifier: protocol_identifier.clone(),
                    viewport,
                    state: Arc::new(context_state::ContextState::default()),
                    published: false,
                },
            );
            Ok(json!({ "identifier": identifier }))
        })();
        if let (Ok(created), Some(storage)) = (&result, storage) {
            let identifier = identifier(created, "identifier", method)?.to_owned();
            if let Err(error) = self
                .restore_initial_storage(&identifier, storage, operation)
                .await
            {
                self.remove_context(&identifier);
                result = Err(error);
            }
        }
        if let Err(mut error) = result {
            error.cleanup = Some(
                dispose(
                    browser.as_ref(),
                    ResourceKind::Context,
                    &protocol_identifier,
                )
                .await
                .into(),
            );
            return Err(error);
        }
        result
    }

    async fn new_page(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "context.newPage";
        validate_keys(method, &parameters, &["context"])?;
        let context_identifier = identifier(&parameters, "context", method)?.to_owned();
        self.create_page(&context_identifier, operation).await
    }

    async fn create_page(
        &self,
        context_identifier: &str,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "context.newPage";
        let context_identifier = context_identifier.to_owned();
        let context = self.context(&context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let target_identifier = operation
            .allocate(
                browser.as_ref(),
                "Target.createTarget",
                json!({ "url": "about:blank", "browserContextId": context.protocol_identifier }),
                ResourceKind::Page,
            )
            .await?;
        let page_identifier = self.identifier("page");
        let result = async {
            let session = operation.wait(browser.connection.call("Target.attachToTarget", json!({ "targetId": target_identifier, "flatten": true }), None)).await?;
            let session_identifier = string_field(&session, "sessionId")?;
            let state = Arc::new(PageState::default());
            let page = Page { context_identifier: context_identifier.clone(), target_identifier: target_identifier.clone(), session_identifier: session_identifier.clone(), state: state.clone() };
            {
                let mut registry = self.registry.lock().unwrap();
                if !registry.contexts.contains_key(&context_identifier) { return Err(closed(method)); }
                registry.pages.insert(page_identifier.clone(), page);
            }
            operation.wait(browser.connection.call("Page.enable", json!({}), Some(&session_identifier))).await?;
            operation.wait(browser.connection.call("Page.setLifecycleEventsEnabled", json!({ "enabled": true }), Some(&session_identifier))).await?;
            operation.wait(browser.connection.call("Network.enable", json!({}), Some(&session_identifier))).await?;
            operation.wait(browser.connection.call("Runtime.enable", json!({}), Some(&session_identifier))).await?;
            operation.wait(browser.connection.call("Log.enable", json!({}), Some(&session_identifier))).await?;
            // Match the reference's page focus/visibility policy so fresh frame checks
            // keep running when another page becomes the browser's active tab.
            operation.wait(browser.connection.call("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), Some(&session_identifier))).await?;
            if let Some(viewport) = context.viewport {
                configure_viewport(&browser, &viewport, &session_identifier, operation).await?;
            }
            let tree = operation.wait(browser.connection.call("Page.getFrameTree", json!({}), Some(&session_identifier))).await?;
            let registry = self.registry.lock().unwrap();
            operation.check()?;
            if !registry.contexts.contains_key(&context_identifier) || !registry.pages.contains_key(&page_identifier) { return Err(closed(method)); }
            let mut document = state.state.lock().unwrap();
            // Page.enable normally supplies the initial frame; getFrameTree covers an idle about:blank.
            if document.main_frame.is_none() { document.observe("Page.frameNavigated", &json!({ "frame": tree["frameTree"]["frame"] })); }
            Ok(json!({ "identifier": page_identifier, "frames": document.frame_snapshot(), "mainFrame": document.main_frame }))
        }.await;
        if let Err(mut error) = result {
            self.registry.lock().unwrap().pages.remove(&page_identifier);
            error.cleanup = Some(
                dispose(browser.as_ref(), ResourceKind::Page, &target_identifier)
                    .await
                    .into(),
            );
            return Err(error);
        }
        result
    }

    async fn close_page(&self, identifier: &str) -> Result<(), ErrorRecord> {
        let page = self.registry.lock().unwrap().pages.remove(identifier);
        if let Some(page) = page {
            self.finish_page(identifier, &page, closed("page"), "close");
            let context = self.context(&page.context_identifier, "page.close")?;
            let browser = self.browser(&context.browser_identifier, "page.close")?;
            close_resource(
                browser.as_ref(),
                ResourceKind::Page,
                &page.target_identifier,
            )
            .await;
        }
        Ok(())
    }

    async fn close_context(&self, identifier: &str) -> Result<(), ErrorRecord> {
        let context = self.remove_context(identifier);
        if let Some(context) = context {
            let browser = self.browser(&context.browser_identifier, "context.close")?;
            close_resource(
                browser.as_ref(),
                ResourceKind::Context,
                &context.protocol_identifier,
            )
            .await;
        }
        Ok(())
    }

    async fn close_browser(&self, identifier: &str) -> Result<(), ErrorRecord> {
        if let Some(browser) = self.remove_browser(identifier) {
            browser.close().await?;
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let browsers = {
            let mut registry = self.registry.lock().unwrap();
            for context in registry.contexts.values() {
                context.state.closed.send_replace(Some(closed("context")));
            }
            registry.contexts.clear();
            registry.pages.clear();
            std::mem::take(&mut registry.browsers)
        };
        let mut closing = tokio::task::JoinSet::new();
        for browser in browsers.into_values() {
            closing.spawn(async move {
                if let Err(error) = browser.browser.close().await {
                    eprintln!("flashwright cleanup: {}", error.message);
                }
            });
        }
        while closing.join_next().await.is_some() {}
    }
}

fn validate_keys(method: &str, parameters: &Value, supported: &[&str]) -> Result<(), ErrorRecord> {
    let object = parameters
        .as_object()
        .ok_or_else(|| invalid(method, "parameters must be an object"))?;
    if let Some(key) = object.keys().find(|key| !supported.contains(&key.as_str())) {
        return Err(ErrorRecord::new(
            ErrorCode::UnsupportedFeature,
            format!("{method}.{key}"),
            "option is not implemented in this development build",
        ));
    }
    Ok(())
}

fn parse<Type: for<'de> Deserialize<'de>>(method: &str, value: Value) -> Result<Type, ErrorRecord> {
    serde_json::from_value(value).map_err(|error| invalid(method, &error.to_string()))
}

fn identifier<'value>(
    parameters: &'value Value,
    key: &str,
    method: &str,
) -> Result<&'value str, ErrorRecord> {
    parameters
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(method, &format!("{key} must identify an owned object")))
}

fn string_field(value: &Value, key: &str) -> Result<String, ErrorRecord> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::Protocol,
                "chromium",
                format!("missing protocol field {key}"),
            )
        })
}

fn invalid(method: &str, message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::InvalidArgument, method, message)
}
fn closed(method: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::TargetClosed,
        method,
        "target has been closed or is not owned by this driver",
    )
}

/// Match the reference's window bounds and screen metrics as well as its DOM viewport.
async fn configure_viewport(
    browser: &Chromium,
    viewport: &Viewport,
    session: &str,
    operation: &Operation,
) -> Result<(), ErrorRecord> {
    let window = operation
        .wait(
            browser
                .connection
                .call("Browser.getWindowForTarget", json!({}), Some(session)),
        )
        .await;
    let window = match window {
        Ok(window) => Some(
            window["windowId"]
                .as_i64()
                .ok_or_else(|| invalid("context.newPage", "Chromium omitted window identity"))?,
        ),
        Err(error) if error.browser_error_code.is_some() => None,
        Err(error) => return Err(error),
    };
    let insets = if browser.headless {
        (0, 0)
    } else {
        match std::env::consts::OS {
            "macos" => (2, 80),
            "linux" => (8, 85),
            _ => (24, 88),
        }
    };
    let width = viewport.width.checked_add(insets.0).ok_or_else(|| {
        invalid(
            "context.newPage",
            "window width overflows its supported range",
        )
    })?;
    let height = viewport.height.checked_add(insets.1).ok_or_else(|| {
        invalid(
            "context.newPage",
            "window height overflows its supported range",
        )
    })?;
    let bounds = async {
        if let Some(window) = window {
            browser
                .connection
                .call(
                    "Browser.setWindowBounds",
                    json!({"windowId":window,"bounds":{"width":width,"height":height}}),
                    Some(session),
                )
                .await?;
        }
        Ok::<(), ErrorRecord>(())
    };
    let metrics = browser.connection.call("Emulation.setDeviceMetricsOverride", json!({"width":viewport.width,"height":viewport.height,"screenWidth":viewport.width,"screenHeight":viewport.height,"deviceScaleFactor":1,"mobile":false,"screenOrientation":{"angle":0,"type":"landscapePrimary"}}), Some(session));
    operation
        .wait(async {
            tokio::try_join!(bounds, metrics)?;
            Ok(())
        })
        .await
}
