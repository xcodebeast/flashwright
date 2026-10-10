//! Browser object ownership and semantic operations, independent of the Node test runner.

mod api_requests;
mod aria_snapshots;
mod assertions;
mod console;
mod context_settings;
mod context_state;
mod cookies;
mod devices;
mod diagnostic_sessions;
mod dialogs;
mod downloads;
mod element_actions;
mod element_resolution;
mod evaluation;
mod events;
mod failure_context;
mod file_chooser;
mod file_inputs;
mod filmstrip;
mod handle_allocation;
mod handle_values;
mod handles;
mod history_navigation;
mod init_scripts;
mod input;
mod keyboard;
mod locators;
mod navigation;
mod navigation_waits;
mod network_headers;
mod network_observer;
mod network_request;
mod network_state;
mod operation;
mod page_state;
mod pointer;
mod publication;
mod recording;
mod renderer_sessions;
mod renderer_setup;
mod response_body;
mod routing;
mod routing_state;
mod screenshots;
mod snapshots;
mod storage;
mod trace_diagnostics;
pub use api_requests::RetainedValue;
pub use dialogs::PreparedDialogHandling;
pub use downloads::PreparedDownload;
pub use operation::Operation;
use operation::{ResourceKind, close_resource, dispose};
pub use trace_diagnostics::RetainedDiagnostics;

use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use flashwright_browser::{Chromium, LaunchOptions};
use flashwright_protocol::{
    BinaryAttachment, DriverOutput, ErrorCode, ErrorRecord, ResourceLimits,
};
use page_state::{PagePurpose, PageState};
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
    "browser.newContext.deviceEmulation",
    "browser.newContext.ignoreHTTPSErrors",
    "browser.newContext.javaScriptEnabled",
    "browser.newContext.acceptDownloads",
    "page.event.download",
    "download.path",
    "download.failure",
    "download.saveAs",
    "download.cancel",
    "download.delete",
    "context.newPage",
    "context.close",
    "context.cookies",
    "context.addCookies",
    "context.clearCookies",
    "context.storageState",
    "page.addInitScript",
    "context.addInitScript",
    "initScript.dispose",
    "page.close",
    "page.evaluate",
    "page.evaluateHandle",
    "frame.evaluate",
    "frame.evaluateHandle",
    "frame.waitForSelector",
    "frame.setInputFiles",
    "elementHandle.setInputFiles",
    "elementHandle.selectText",
    "elementHandle.scrollIntoViewIfNeeded",
    "handle.evaluate",
    "handle.evaluateHandle",
    "handle.jsonValue",
    "handle.getProperty",
    "handle.getProperties",
    "handle.dispose",
    "handle.discard",
    "page.event.pageerror",
    "page.navigation.capture",
    "page.navigation.next",
    "page.navigation.complete",
    "page.console.subscribe",
    "page.dialog.subscribe",
    "context.dialog.subscribe",
    "dialog.accept",
    "dialog.dismiss",
    "page.fileChooser.subscribe",
    "context.console.subscribe",
    "context.trace.start",
    "context.trace.pull",
    "context.trace.stop",
    "context.trace.filmstrip.clock",
    "context.trace.filmstrip.activity",
    "context.trace.filmstrip.pull",
    "context.trace.filmstrip.start",
    "context.trace.filmstrip.seal",
    "context.trace.filmstrip.dispose",
    "context.trace.filmstrip.take",
    "page.screenshot",
    "page.goto",
    "page.reload",
    "page.goBack",
    "page.goForward",
    "page.waitForLoadState",
    "response.body",
    "response.body.occurrence",
    "request.postData.bytes",
    "network.request.references",
    "network.routing",
    "network.headers",
    "locator.run",
    "aria.snapshot",
    "assertion.run",
    "diagnostics.pageSnapshot",
    "keyboard.press",
    "keyboard.type",
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
    file_chooser_slots: Arc<tokio::sync::Semaphore>,
    network_budget: Arc<tokio::sync::Semaphore>,
    routing_budget: Arc<routing_state::EngineRoutingBudget>,
    maximum_attachment_bytes: usize,
    maximum_control_frame_bytes: usize,
    maximum_pending_operations: usize,
    filmstrip_budget: OnceLock<Arc<filmstrip::FrameBudget>>,
    diagnostic_sessions: Arc<diagnostic_sessions::DiagnosticSessions>,
    dialog_budget: Arc<dialogs::DialogBudget>,
    download_budget: Arc<downloads::DownloadBudget>,
    snapshot_budget: OnceLock<Arc<snapshots::SnapshotBudget>>,
    trace_network_budget: OnceLock<Arc<recording::network::NetworkBudget>>,
    trace_diagnostic_budget: OnceLock<Arc<tokio::sync::Semaphore>>,
    api_requests: api_requests::RequestRegistry,
}

pub enum OperationResult {
    Value(Value),
    RetainedValue(Arc<RetainedValue>),
    RetainedDiagnostics(Arc<RetainedDiagnostics>),
    Binary(BinaryAttachment),
}

impl OperationResult {
    pub fn value(&self) -> Option<&Value> {
        match self {
            Self::Value(value) => Some(value),
            Self::RetainedValue(value) => Some(value.value()),
            Self::RetainedDiagnostics(value) => Some(value.value()),
            Self::Binary(_) => None,
        }
    }
}

#[derive(Default)]
struct Registry {
    browsers: HashMap<String, Browser>,
    contexts: HashMap<String, Context>,
    pages: HashMap<String, Page>,
    init_scripts: HashMap<String, Arc<init_scripts::InitScript>>,
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
    devices: devices::DeviceOptions,
    settings: context_settings::ContextSettings,
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
            file_chooser_slots: Arc::new(tokio::sync::Semaphore::new(
                file_chooser::MAXIMUM_CHOOSERS,
            )),
            attachment_slots: Arc::new(tokio::sync::Semaphore::new(limits.pending_attachments)),
            network_budget: Arc::new(tokio::sync::Semaphore::new(
                network_state::ENGINE_NETWORK_BYTES,
            )),
            routing_budget: Arc::new(routing_state::EngineRoutingBudget::default()),
            maximum_attachment_bytes: limits.binary_attachment_bytes,
            maximum_control_frame_bytes: limits.control_frame_bytes,
            maximum_pending_operations: limits.pending_operations,
            filmstrip_budget: OnceLock::new(),
            diagnostic_sessions: Arc::new(diagnostic_sessions::DiagnosticSessions::default()),
            dialog_budget: dialogs::DialogBudget::engine(),
            download_budget: Arc::new(downloads::DownloadBudget::default()),
            snapshot_budget: OnceLock::new(),
            trace_network_budget: OnceLock::new(),
            trace_diagnostic_budget: OnceLock::new(),
            api_requests: api_requests::RequestRegistry::with_limits(limits),
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
        if operation.input_attachment().is_some()
            && !matches!(
                method,
                "frame.setInputFiles"
                    | "apiRequest.fetch"
                    | "elementHandle.setInputFiles"
                    | "route.continue"
                    | "route.fulfill"
            )
        {
            return Err(ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                method,
                "this operation does not accept binary input",
            ));
        }
        if method == "apiRequest.fetch" {
            return self
                .api_fetch(parameters, operation)
                .await
                .map(OperationResult::Value);
        }
        if method == "apiResponse.body" {
            return self
                .api_response_body(parameters, operation)
                .await
                .map(OperationResult::Binary);
        }
        if method == "apiRequest.traceBody.take" {
            return self
                .api_trace_body_take(parameters, operation)
                .await
                .map(|attachment| match attachment {
                    Some(attachment) => OperationResult::Binary(attachment),
                    None => OperationResult::Value(Value::Null),
                });
        }
        if method.starts_with("apiRequest.") || method.starts_with("apiResponse.") {
            return self.api_request_control(method, parameters, operation);
        }
        if let Some(result) = self.execute_diagnostic_control(method, &parameters, operation) {
            return result;
        }
        if let Some(result) = self.execute_control(method, &parameters, operation) {
            return result.map(OperationResult::Value);
        }
        if let Some(prepared) = self.prepare_dialog_handling(method, &parameters, operation) {
            return prepared?
                .finish(operation)
                .await
                .map(OperationResult::Value);
        }
        self.snapshot_before_operation(method, &parameters, operation)
            .await;
        if method == "page.screenshot" {
            return self
                .screenshot(parameters, operation)
                .await
                .map(OperationResult::Binary);
        }
        if method == "context.trace.filmstrip.take" {
            return self
                .take_filmstrip_frame(parameters, operation)
                .await
                .map(OperationResult::Binary);
        }
        if method == "context.trace.network.take" {
            return self
                .take_network_resource(parameters, operation)
                .await
                .map(|attachment| match attachment {
                    Some(attachment) => OperationResult::Binary(attachment),
                    None => OperationResult::Value(Value::Null),
                });
        }
        if method == "context.trace.snapshot.take" {
            return self.take_snapshot(parameters, operation).await.map(
                |attachment| match attachment {
                    Some(attachment) => OperationResult::Binary(attachment),
                    None => OperationResult::Value(Value::Null),
                },
            );
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
        if method == "network.headers" {
            return self.network_headers(parameters, operation).await;
        }
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
            "context.trace.snapshot.after" => {
                self.snapshot_after_operation(parameters, operation).await
            }
            "context.trace.filmstrip.start" => self.start_filmstrip(parameters, operation).await,
            "context.trace.filmstrip.seal" | "context.trace.filmstrip.dispose" => {
                self.finish_filmstrip(method, parameters, operation).await
            }
            "page.addInitScript" | "context.addInitScript" => {
                self.add_init_script(method, parameters, operation).await
            }
            "initScript.dispose" => self.dispose_init_script(parameters, operation).await,
            "page.route.setEnabled" | "context.route.setEnabled" => {
                self.set_routing(method, parameters, operation).await
            }
            "route.continue" | "route.fulfill" | "route.abort" => {
                self.handle_route(method, parameters, operation).await
            }
            "context.newPage" => self.new_page(parameters, operation).await,
            "context.cookies" | "context.addCookies" | "context.clearCookies" => {
                self.context_cookies(method, parameters, operation).await
            }
            "context.storageState" => self.storage_state(parameters, operation).await,
            "page.goto" => self.navigate(parameters, operation).await,
            "page.navigation.next" => self.next_navigation(parameters, operation).await,
            "page.navigation.complete" => self.finish_navigation_wait(parameters, operation).await,
            "page.reload" | "page.goBack" | "page.goForward" => {
                self.navigate_history(method, parameters, operation).await
            }
            "page.waitForLoadState" => self.wait_for_load_state(parameters, operation).await,
            "aria.snapshot" => self.run_aria_snapshot(parameters, operation).await,
            "locator.run" => self.run_locator(parameters, operation).await,
            "page.fileChooser.subscribe" => {
                self.set_file_chooser_subscription(parameters, operation)
                    .await
            }
            "frame.waitForSelector" => self.wait_for_selector(parameters, operation).await,
            "frame.setInputFiles" | "elementHandle.setInputFiles" => {
                self.set_input_files(method, parameters, operation).await
            }
            "elementHandle.selectText" | "elementHandle.scrollIntoViewIfNeeded" => {
                self.run_element_action(method, parameters, operation).await
            }
            "assertion.run" => self.run_assertion(parameters, operation).await,
            "diagnostics.pageSnapshot" => {
                self.capture_failure_context_snapshot(parameters, operation)
                    .await
            }
            "keyboard.press" => self.press_page_key(parameters, operation).await,
            "keyboard.type" => self.type_page_text(parameters, operation).await,
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
            "download.path" | "download.failure" | "download.saveAs" | "download.cancel"
            | "download.delete" => {
                self.prepare_download_operation(method, &parameters, operation)
                    .expect("download method")?
                    .finish(operation)
                    .await
            }
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
            .filter(|context| context.state.closed.borrow().is_none())
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
            &[
                "browser",
                "viewport",
                "storageState",
                "screen",
                "userAgent",
                "userAgentMetadata",
                "deviceScaleFactor",
                "isMobile",
                "hasTouch",
                "ignoreHTTPSErrors",
                "javaScriptEnabled",
                "acceptDownloads",
            ],
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
        let devices = devices::DeviceOptions::parse(&parameters, viewport.as_ref())?;
        let settings = context_settings::ContextSettings::parse(&parameters)?;
        let accept_downloads = match parameters.get("acceptDownloads") {
            None => true,
            Some(Value::Bool(accepted)) => *accepted,
            Some(_) => {
                return Err(ErrorRecord::new(
                    ErrorCode::InvalidArgument,
                    method,
                    "acceptDownloads must be a boolean",
                ));
            }
        };
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
            let state = Arc::new(context_state::ContextState::default());
            let _ = state.downloads.set(Arc::new(downloads::Downloads::new(
                browser.artifacts_directory.join(&identifier),
                accept_downloads,
                self.download_budget.clone(),
            )));
            registry.contexts.insert(
                identifier.clone(),
                Context {
                    browser_identifier,
                    protocol_identifier: protocol_identifier.clone(),
                    viewport,
                    devices,
                    settings,
                    state,
                    published: false,
                },
            );
            Ok(json!({ "identifier": identifier }))
        })();
        let mut created_downloads = None;
        if let Ok(created) = &result {
            let identifier = identifier(created, "identifier", method)?.to_owned();
            created_downloads = self
                .context(&identifier, method)?
                .state
                .downloads
                .get()
                .cloned();
            let initialized = async {
                self.initialize_downloads(&identifier, operation).await?;
                if let Some(storage) = storage {
                    self.restore_initial_storage(&identifier, storage, operation)
                        .await?;
                }
                Ok(())
            }
            .await;
            if let Err(error) = initialized {
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
            if let Some(downloads) = created_downloads
                && let Err(cleanup) = downloads.remove_files().await
            {
                error.cleanup = Some(format!("downloadCleanupFailed: {}", cleanup.message).into());
            }
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
        self.create_page(&context_identifier, PagePurpose::Public, operation)
            .await
    }

    async fn create_page(
        &self,
        context_identifier: &str,
        purpose: PagePurpose,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "context.newPage";
        let context_identifier = context_identifier.to_owned();
        let context = self.context(&context_identifier, method)?;
        let _initialization = operation
            .wait(context.state.while_alive(method, async {
                Ok(context.state.page_configuration.read().await)
            }))
            .await?;
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
            let mut document = page_state::DocumentState::with_network_budget(self.network_budget.clone());
            document.initialize_main_frame(&target_identifier, &session_identifier);
            document.interception = routing_state::RequestInterception::new(self.routing_budget.clone());
            let state = Arc::new(PageState { purpose, state: Mutex::new(document), ..PageState::default() });
            let page = Page { context_identifier: context_identifier.clone(), target_identifier: target_identifier.clone(), session_identifier: session_identifier.clone(), state: state.clone() };
            let renderer = state.renderer_sessions.lock().unwrap().register_root(&target_identifier, &session_identifier)?;
            {
                let mut registry = self.registry.lock().unwrap();
                if !registry.contexts.contains_key(&context_identifier) { return Err(closed(method)); }
                registry.pages.insert(page_identifier.clone(), page.clone());
            }
            // Setup replies can disappear after native root detachment. Every bare
            // setup command must observe the original page's terminal state.
            let initialize_command = |command: &'static str, parameters| {
                operation.wait(state.while_alive(
                    method,
                    browser.connection.call(command, parameters, Some(&session_identifier)),
                ))
            };
            initialize_command("Page.enable", json!({})).await?;
            initialize_command("Page.setLifecycleEventsEnabled", json!({ "enabled": true })).await?;
            initialize_command("Network.enable", json!({})).await?;
            initialize_command("Runtime.enable", json!({})).await?;
            initialize_command("Log.enable", json!({})).await?;
            if purpose == PagePurpose::Public {
                if context.settings.ignore_https_errors {
                    initialize_command("Security.setIgnoreCertificateErrors", json!({"ignore":true})).await?;
                }
                if !context.settings.javascript_enabled {
                    initialize_command("Emulation.setScriptExecutionDisabled", json!({"value":true})).await?;
                }
                initialize_command("Emulation.setEmulatedMedia", context_settings::default_media_parameters()).await?;
            }
            // Match the reference's page focus/visibility policy so fresh frame checks
            // keep running when another page becomes the browser's active tab.
            initialize_command("Emulation.setFocusEmulationEnabled", json!({ "enabled": true })).await?;
            if let Some(viewport) = &context.viewport {
                state.while_alive(method, configure_viewport(&browser, viewport, &context.devices, &session_identifier, operation)).await?;
            }
            if context.devices.has_touch {
                initialize_command("Emulation.setTouchEmulationEnabled", json!({"enabled":true})).await?;
            }
            if !context.devices.user_agent.is_empty() {
                initialize_command("Emulation.setUserAgentOverride", context.devices.user_agent_override()).await?;
            }
            if purpose == PagePurpose::Public {
                self.configure_page_routing(&page_identifier, &page, &browser, context.state.routing_registered.load(Ordering::Acquire), operation).await?;
                self.initialize_page_scripts(&page_identifier, &page, &browser, operation).await?;
                self.initialize_page_filmstrip(&page_identifier, &page, &context, &browser);
                initialize_command("Target.setAutoAttach", renderer_setup::auto_attach_parameters()).await?;
            }
            let tree = initialize_command("Page.getFrameTree", json!({})).await?;
            let registry = self.registry.lock().unwrap();
            operation.check()?;
            if !registry.contexts.contains_key(&context_identifier) || !registry.pages.contains_key(&page_identifier) { return Err(closed(method)); }
            let mut document = state.state.lock().unwrap();
            // Page.enable normally supplies the initial frame; getFrameTree covers an idle about:blank.
            if document.main_frame.is_none() { document.observe_in_session(&session_identifier, "Page.frameNavigated", &json!({ "frame": tree["frameTree"]["frame"] })); }
            renderer.mark_ready();
            Ok(json!({ "identifier": page_identifier, "frames": document.frame_snapshot(), "mainFrame": document.main_frame, "navigationSequence":document.sequence }))
        }.await;
        if let Err(mut error) = result {
            let page = self.registry.lock().unwrap().pages.remove(&page_identifier);
            if let Some(page) = page {
                self.finish_page(&page_identifier, &page, error.clone(), "close");
            }
            error.cleanup = Some(
                dispose(browser.as_ref(), ResourceKind::Page, &target_identifier)
                    .await
                    .into(),
            );
            if let Some(downloads) = context.state.downloads.get()
                && let Err(cleanup) = downloads
                    .discard_page(&browser, &context.protocol_identifier, &page_identifier)
                    .await
            {
                error.cleanup = cleanup.cleanup.clone();
            }
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

    async fn close_context(self: &Arc<Self>, identifier: &str) -> Result<(), ErrorRecord> {
        let Some(context) = self
            .registry
            .lock()
            .unwrap()
            .contexts
            .get(identifier)
            .cloned()
        else {
            return Ok(());
        };
        let mut completion = {
            let mut cleanup = context.state.cleanup.lock().unwrap();
            if let Some(completion) = cleanup.as_ref() {
                completion.clone()
            } else {
                let browser = self.browser(&context.browser_identifier, "context.close")?;
                let engine = self.clone();
                let identifier = identifier.to_owned();
                let closing_context = context.clone();
                context.state.closed.send_replace(Some(closed("context")));
                if let Some(downloads) = context.state.downloads.get() {
                    downloads.begin_close();
                }
                let (sender, receiver) = watch::channel(None);
                tokio::spawn(async move {
                    if let Some(downloads) = closing_context.state.downloads.get() {
                        downloads
                            .cancel_active(&browser, &closing_context.protocol_identifier)
                            .await;
                    }
                    close_resource(
                        browser.as_ref(),
                        ResourceKind::Context,
                        &closing_context.protocol_identifier,
                    )
                    .await;
                    // Keep original download ownership visible through disposal's event/reply barrier.
                    engine.remove_context(&identifier);
                    let result = if let Some(downloads) = closing_context.state.downloads.get() {
                        downloads.remove_files().await
                    } else {
                        Ok(())
                    };
                    sender.send_replace(Some(result));
                });
                *cleanup = Some(receiver.clone());
                receiver
            }
        };
        completion
            .wait_for(|result| result.is_some())
            .await
            .map_err(|_| {
                ErrorRecord::new(
                    ErrorCode::Protocol,
                    "context.close",
                    "context cleanup owner was lost",
                )
            })?;
        completion
            .borrow()
            .as_ref()
            .expect("context cleanup completed")
            .clone()
    }

    async fn close_browser(&self, identifier: &str) -> Result<(), ErrorRecord> {
        if let Some(browser) = self.remove_browser(identifier) {
            self.begin_browser_cleanup(identifier.to_owned(), browser)
                .await
                .map_err(|error| {
                    ErrorRecord::new(ErrorCode::Protocol, "browser.close", error.to_string())
                })??;
        }
        Ok(())
    }

    /// Cleanup proof outlives cancellation of the foreground browser-close waiter.
    fn begin_browser_cleanup(
        &self,
        identifier: String,
        browser: Arc<Chromium>,
    ) -> tokio::task::JoinHandle<Result<(), ErrorRecord>> {
        let sessions = self.diagnostic_sessions.clone();
        tokio::spawn(async move {
            let result = browser.close().await;
            sessions.browser_cleanup_finished(&identifier, &result);
            result
        })
    }

    pub async fn shutdown(&self) {
        self.api_requests.shutdown();
        let browsers = {
            let mut registry = self.registry.lock().unwrap();
            for context in registry.contexts.values() {
                context.state.close_trace();
                if let Some(downloads) = context.state.downloads.get() {
                    downloads.retire(closed("context"));
                }
                context.state.closed.send_replace(Some(closed("context")));
            }
            registry.contexts.clear();
            registry.pages.clear();
            registry.init_scripts.clear();
            std::mem::take(&mut registry.browsers)
        };
        let mut closing = tokio::task::JoinSet::new();
        for (identifier, browser) in browsers {
            let cleanup = self.begin_browser_cleanup(identifier, browser.browser);
            closing.spawn(async move {
                match cleanup.await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("flashwright cleanup: {}", error.message),
                    Err(error) => eprintln!("flashwright cleanup task: {error}"),
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
    devices: &devices::DeviceOptions,
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
    let metrics = browser.connection.call(
        "Emulation.setDeviceMetricsOverride",
        devices.metrics(viewport),
        Some(session),
    );
    operation
        .wait(async {
            tokio::try_join!(bounds, metrics)?;
            Ok(())
        })
        .await
}
