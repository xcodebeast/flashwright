//! Page lifecycle and network state, updated in Chromium event order before notifying waiters.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, Weak};

use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::network_observer::{
    NetworkEvent, NetworkIngress, NetworkObservation, NetworkObserver, PublicNetworkEvents,
};
use crate::network_request::RequestState;
use crate::network_state::{HeaderKind, NetworkRequests};

const MAXIMUM_EXECUTION_CONTEXTS: usize = 1024;
const MAXIMUM_INITIAL_EVENTS: usize = 1024;
const MAXIMUM_INITIAL_EVENT_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_NAVIGATION_EVENTS: usize = 1024;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum PagePurpose {
    #[default]
    Public,
    Storage,
}

pub(crate) struct PageState {
    pub purpose: PagePurpose,
    pub routing_registered: std::sync::atomic::AtomicBool,
    pub diagnostic_session_destroyed: std::sync::atomic::AtomicBool,
    pub state: Mutex<DocumentState>,
    pub changed: watch::Sender<u64>,
    pub locator_realms: tokio::sync::Mutex<HashMap<String, super::locators::LocatorRealm>>,
    pub evaluation_runtimes: Mutex<HashMap<String, Arc<super::evaluation::EvaluationRuntime>>>,
    pub handles: Mutex<HashMap<String, super::handles::Handle>>,
    pub handle_slots: Arc<tokio::sync::Semaphore>,
    pub event_handle_cleanup: Mutex<super::console::EventHandleCleanup>,
    pub file_chooser: Mutex<super::file_chooser::FileChooserState>,
    pub file_chooser_control: tokio::sync::Mutex<()>,
    pub dialogs: Mutex<super::dialogs::DialogState>,
    pub native_input: tokio::sync::Mutex<()>,
    pub init_scripts: Mutex<HashMap<String, String>>,
    pub screenshots: tokio::sync::Mutex<()>,
    pub filmstrip_capture: Mutex<Weak<super::filmstrip::PageCapture>>,
    pub filmstrip_cast: AtomicU64,
}

#[derive(Default)]
pub(crate) struct DocumentState {
    pub frames: HashMap<String, FrameState>,
    pub main_frame: Option<String>,
    pub main_worlds: HashMap<String, ExecutionContext>,
    pub execution_contexts: HashMap<(Arc<str>, u64), ExecutionContext>,
    pub requests: NetworkRequests,
    pub interception: crate::routing_state::RequestInterception,
    pub completed_lifecycle: HashMap<String, HashSet<String>>,
    recent_loaders: VecDeque<String>,
    pub active_requests: HashSet<String>,
    ignored_requests: HashSet<String>,
    pub idle_since: Option<Instant>,
    pub failure: Option<ErrorRecord>,
    pub navigation_events: VecDeque<NavigationEvent>,
    pub discarded_navigation_sequence: u64,
    pub sequence: u64,
    pub published: bool,
    pub console_enabled: bool,
    pub dialog_open: bool,
    pub initial_events: Vec<Value>,
    initial_event_bytes: usize,
}

#[derive(Clone)]
pub(crate) struct NavigationEvent {
    pub sequence: u64,
    pub frame_identifier: String,
    pub outcome: NavigationOutcome,
    pub url: String,
}

#[derive(Clone)]
pub(crate) enum NavigationOutcome {
    Document {
        loader: String,
        has_network_request: bool,
    },
    SameDocument {
        loader: String,
    },
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExecutionContext {
    pub session_identifier: Arc<str>,
    pub identifier: u64,
    pub unique_identifier: String,
    pub frame_identifier: String,
}

impl ExecutionContext {
    pub fn key(&self) -> (Arc<str>, u64) {
        (self.session_identifier.clone(), self.identifier)
    }
}

#[derive(Default)]
pub(crate) struct FrameState {
    pub identifier: String,
    pub session_identifier: Arc<str>,
    pub parent: Option<String>,
    pub name: String,
    pub url: String,
    pub loader: String,
    pub lifecycle: HashSet<String>,
    pub navigation_sequence: u64,
    pub remote: bool,
    pub pending_navigation: Option<PendingNavigation>,
}

pub(crate) struct PendingNavigation {
    pub sequence: u64,
    pub loader: Option<String>,
}

impl Default for PageState {
    fn default() -> Self {
        Self {
            purpose: PagePurpose::Public,
            routing_registered: std::sync::atomic::AtomicBool::new(false),
            diagnostic_session_destroyed: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(DocumentState {
                idle_since: Some(Instant::now()),
                ..Default::default()
            }),
            changed: watch::channel(0).0,
            locator_realms: tokio::sync::Mutex::new(HashMap::new()),
            evaluation_runtimes: Mutex::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
            handle_slots: Arc::new(tokio::sync::Semaphore::new(super::handles::MAXIMUM_HANDLES)),
            event_handle_cleanup: Mutex::new(super::console::EventHandleCleanup::default()),
            file_chooser: Mutex::new(super::file_chooser::FileChooserState::default()),
            file_chooser_control: tokio::sync::Mutex::new(()),
            dialogs: Mutex::new(super::dialogs::DialogState::default()),
            native_input: tokio::sync::Mutex::new(()),
            init_scripts: Mutex::new(HashMap::new()),
            screenshots: tokio::sync::Mutex::new(()),
            filmstrip_capture: Mutex::new(Weak::new()),
            filmstrip_cast: AtomicU64::new(0),
        }
    }
}

impl PageState {
    pub async fn while_execution_context<T>(
        &self,
        context: &ExecutionContext,
        work: impl std::future::Future<Output = Result<T, ErrorRecord>>,
    ) -> Result<T, ErrorRecord> {
        let mut changes = self.changed.subscribe();
        let lost = async {
            loop {
                {
                    let state = self.state.lock().unwrap();
                    if let Err(error) = state.check("page.evaluate") {
                        return error;
                    }
                    if !state.context_is_alive(context) {
                        return super::evaluation::context_destroyed();
                    }
                }
                if changes.changed().await.is_err() {
                    return super::closed("page.evaluate");
                }
            }
        };
        tokio::select! {
            biased;
            error = lost => Err(error),
            result = work => result,
        }
    }

    pub async fn while_alive<T>(
        &self,
        method: &str,
        work: impl std::future::Future<Output = Result<T, ErrorRecord>>,
    ) -> Result<T, ErrorRecord> {
        let mut changes = self.changed.subscribe();
        let lost = async {
            loop {
                if let Err(error) = self.state.lock().unwrap().check(method) {
                    return error;
                }
                if changes.changed().await.is_err() {
                    return super::closed(method);
                }
            }
        };
        tokio::select! {
            biased;
            error = lost => Err(error),
            result = work => result,
        }
    }
}

impl FrameState {
    pub fn snapshot(&self) -> Value {
        json!({ "identifier": self.identifier, "parent": self.parent, "name": self.name, "url": self.url, "navigationSequence": self.navigation_sequence, "loader": self.loader })
    }
}

impl DocumentState {
    /// Establish the root owner before enabling domains that can emit initial worlds or lifecycle.
    pub(crate) fn initialize_main_frame(&mut self, identifier: &str, session_identifier: &str) {
        self.frames.insert(
            identifier.to_owned(),
            FrameState {
                identifier: identifier.to_owned(),
                session_identifier: session_identifier.into(),
                url: "about:blank".into(),
                ..Default::default()
            },
        );
    }

    fn owns_frame(&self, identifier: &str, session_identifier: &str) -> bool {
        self.frames
            .get(identifier)
            .is_some_and(|frame| frame.session_identifier.as_ref() == session_identifier)
    }

    /// Page construction shares the engine's network allowance without changing idle initialization.
    pub(crate) fn with_network_budget(budget: Arc<tokio::sync::Semaphore>) -> Self {
        Self {
            requests: NetworkRequests::new(budget),
            idle_since: Some(Instant::now()),
            ..Self::default()
        }
    }

    /// Navigation and body metadata share one occurrence record rather than retaining duplicate payloads.
    pub(crate) fn response_for_loader(&self, loader: &str) -> Option<&Value> {
        self.requests
            .get(loader)
            .and_then(|request| request.response.as_ref())
    }
    /// A reused CDP request identifier cannot transfer body ownership to a successor.
    pub(crate) fn request_for_occurrence(
        &self,
        request_identifier: &str,
        occurrence_identity: &str,
        method: &str,
    ) -> Result<&RequestState, ErrorRecord> {
        self.check(method)?;
        let request = self.requests.get(request_identifier).ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "response is outside the bounded retained request history",
            )
        })?;
        if request.identity() != occurrence_identity {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                method,
                "response no longer belongs to its original request occurrence",
            ));
        }
        Ok(request)
    }

    /// Numeric IDs can be reused within a session and collide across renderer sessions.
    pub fn context_is_alive(&self, context: &ExecutionContext) -> bool {
        self.execution_contexts.get(&context.key()) == Some(context)
    }

    /// Keep diagnostics private until the owning page's allocation reply can be published.
    pub fn buffer_initial_event(
        &mut self,
        event: &str,
        parameters: Value,
    ) -> Result<(), ErrorRecord> {
        let record = json!({ "event": event, "parameters": parameters });
        let bytes = serde_json::to_vec(&record)
            .expect("JSON values serialize")
            .len();
        if self.initial_events.len() >= MAXIMUM_INITIAL_EVENTS
            || self.initial_event_bytes.saturating_add(bytes) > MAXIMUM_INITIAL_EVENT_BYTES
        {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "context.newPage",
                "initial page diagnostics exceed 1024 events or 4 MiB",
            ));
        }
        self.initial_event_bytes += bytes;
        self.initial_events.push(record);
        Ok(())
    }

    fn record_navigation(&mut self, frame_identifier: String, outcome: NavigationOutcome) -> Value {
        let url = self
            .frames
            .get(&frame_identifier)
            .map(|frame| frame.url.clone())
            .unwrap_or_default();
        let (kind, error) = match &outcome {
            NavigationOutcome::Document { .. } => ("document", None),
            NavigationOutcome::SameDocument { .. } => ("sameDocument", None),
            NavigationOutcome::Failed(error) => ("failed", Some(error.as_str())),
        };
        let event = json!({"sequence":self.sequence,"url":url,"kind":kind,"error":error});
        self.navigation_events.push_back(NavigationEvent {
            sequence: self.sequence,
            url,
            frame_identifier,
            outcome,
        });
        while self.navigation_events.len() > MAXIMUM_NAVIGATION_EVENTS {
            self.discarded_navigation_sequence =
                self.navigation_events.pop_front().unwrap().sequence;
        }
        event
    }

    pub fn main_execution_context(&self) -> Option<&ExecutionContext> {
        self.main_frame
            .as_ref()
            .and_then(|frame| self.main_worlds.get(frame))
    }

    pub fn check(&self, method: &str) -> Result<(), ErrorRecord> {
        match &self.failure {
            Some(error) => {
                let mut error = error.clone();
                error.method = method.into();
                Err(error)
            }
            None => Ok(()),
        }
    }

    pub fn frame_snapshot(&self) -> Vec<Value> {
        self.frames.values().map(FrameState::snapshot).collect()
    }

    #[cfg(test)]
    pub fn observe(&mut self, method: &str, parameters: &Value) -> Vec<(&'static str, Value)> {
        self.observe_in_session("", method, parameters)
    }

    pub fn observe_in_session(
        &mut self,
        session_identifier: &str,
        method: &str,
        parameters: &Value,
    ) -> Vec<(&'static str, Value)> {
        self.observe_event(
            NetworkEvent {
                session_identifier,
                method,
                parameters,
                ingress: NetworkIngress {
                    sequence: self.sequence + 1,
                    received_at: std::time::Instant::now(),
                },
            },
            None,
        )
    }

    pub(crate) fn release_interception(
        &mut self,
        observer: Option<&mut dyn NetworkObserver>,
    ) -> Vec<(&'static str, Value)> {
        self.interception.clear();
        let event = NetworkEvent {
            session_identifier: "",
            method: "Fetch.disable",
            parameters: &Value::Null,
            ingress: NetworkIngress {
                sequence: self.sequence,
                received_at: std::time::Instant::now(),
            },
        };
        let mut events = PublicNetworkEvents {
            events: Vec::new(),
            observer,
        };
        let mut observation = NetworkObservation::new(event, &mut events);
        if let Err(error) = self.requests.publish_pending(&mut observation) {
            self.failure = Some(error);
        }
        events.events
    }

    /// The caller retains any recording lock until all transitions for this browser event finish.
    pub(crate) fn observe_event(
        &mut self,
        event: NetworkEvent<'_>,
        observer: Option<&mut dyn NetworkObserver>,
    ) -> Vec<(&'static str, Value)> {
        let method = event.method;
        let parameters = event.parameters;
        let session_identifier = event.session_identifier;
        self.record_idle();
        self.sequence += 1;
        let mut events = Vec::new();
        let mut network_events = PublicNetworkEvents {
            events: Vec::new(),
            observer,
        };
        let mut observation = NetworkObservation::new(event, &mut network_events);
        match method {
            "Page.javascriptDialogOpening" => self.dialog_open = true,
            "Page.javascriptDialogClosed" => self.dialog_open = false,
            "Runtime.executionContextCreated" => {
                let description = &parameters["context"];
                let is_default = description["auxData"]["isDefault"] == true;
                if let Some(frame) = description["auxData"]["frameId"].as_str()
                    && !self.owns_frame(frame, session_identifier)
                {
                    return events;
                }
                if is_default || description["auxData"]["frameId"].is_string() {
                    match (
                        description["id"].as_u64(),
                        description["uniqueId"]
                            .as_str()
                            .filter(|identifier| !identifier.is_empty()),
                        description["auxData"]["frameId"]
                            .as_str()
                            .filter(|identifier| !identifier.is_empty()),
                    ) {
                        (Some(identifier), Some(unique_identifier), Some(frame_identifier)) => {
                            let context = ExecutionContext {
                                session_identifier: session_identifier.into(),
                                identifier,
                                unique_identifier: unique_identifier.to_owned(),
                                frame_identifier: frame_identifier.to_owned(),
                            };
                            if is_default
                                && let Some(previous) = self.main_worlds.get(frame_identifier)
                                && previous != &context
                            {
                                self.execution_contexts.remove(&previous.key());
                            }
                            if self.execution_contexts.len() >= MAXIMUM_EXECUTION_CONTEXTS
                                && !self.execution_contexts.contains_key(&context.key())
                            {
                                self.failure = Some(ErrorRecord::new(
                                    ErrorCode::ResourceLimit,
                                    "page.evaluate",
                                    "too many live execution contexts across page worlds",
                                ));
                            } else {
                                self.main_worlds.retain(|_, previous| {
                                    previous.session_identifier.as_ref() != session_identifier
                                        || previous.identifier != identifier
                                        || previous == &context
                                });
                                self.execution_contexts
                                    .insert(context.key(), context.clone());
                                if is_default {
                                    self.main_worlds
                                        .insert(frame_identifier.to_owned(), context);
                                }
                            }
                        }
                        _ => {
                            self.failure = Some(ErrorRecord::new(
                                ErrorCode::Protocol,
                                "page.evaluate",
                                "Chromium omitted a page execution context identity",
                            ))
                        }
                    }
                }
            }
            "Runtime.executionContextDestroyed" => {
                self.execution_contexts.retain(|_, context| {
                    if context.session_identifier.as_ref() != session_identifier {
                        return true;
                    }
                    if let Some(unique) = parameters["executionContextUniqueId"].as_str() {
                        context.unique_identifier != unique
                    } else {
                        Some(context.identifier) != parameters["executionContextId"].as_u64()
                    }
                });
                self.main_worlds.retain(|_, context| {
                    self.execution_contexts.get(&context.key()) == Some(context)
                });
            }
            "Runtime.executionContextsCleared" => {
                self.main_worlds
                    .retain(|_, context| context.session_identifier.as_ref() != session_identifier);
                self.execution_contexts
                    .retain(|_, context| context.session_identifier.as_ref() != session_identifier);
            }
            "Page.frameAttached" => {
                let identifier = text(parameters, "frameId");
                let parent = parameters["parentFrameId"].as_str().map(str::to_owned);
                if !parent
                    .as_ref()
                    .is_some_and(|parent| self.owns_frame(parent, session_identifier))
                {
                    return events;
                }
                if self.frames.contains_key(&identifier) {
                    // Reattachment hands an existing remote frame back to its parent renderer.
                    // It does not create a second public Frame.
                    if self.frames[&identifier].session_identifier.as_ref() != session_identifier {
                        events.extend(self.remove_frames(&identifier, false));
                        self.retire_frame_contexts(&identifier);
                        let remote = self.session_is_remote(session_identifier);
                        let frame = self.frames.get_mut(&identifier).unwrap();
                        frame.session_identifier = session_identifier.into();
                        frame.remote = remote;
                        frame.lifecycle.clear();
                    }
                } else {
                    let frame = FrameState {
                        identifier: identifier.clone(),
                        session_identifier: session_identifier.into(),
                        parent,
                        remote: self.session_is_remote(session_identifier),
                        url: "about:blank".into(),
                        ..Default::default()
                    };
                    events.push(("frameattached", frame.snapshot()));
                    self.frames.insert(identifier, frame);
                }
            }
            "Target.attachedToTarget" if parameters["targetInfo"]["type"] == "iframe" => {
                let identifier = text(&parameters["targetInfo"], "targetId");
                let Some(frame) = self.frames.get(&identifier) else {
                    // A removed logical frame cannot be revived by delayed target attachment.
                    return events;
                };
                let Some(renderer) = parameters["sessionId"]
                    .as_str()
                    .filter(|identifier| !identifier.is_empty())
                else {
                    self.failure = Some(ErrorRecord::new(
                        ErrorCode::Protocol,
                        "frame.attach",
                        "renderer attachment omitted its session identity",
                    ));
                    return events;
                };
                if frame.session_identifier.as_ref() == renderer {
                    return events;
                }
                let owns_parent = frame
                    .parent
                    .as_ref()
                    .and_then(|parent| self.frames.get(parent))
                    .is_some_and(|parent| parent.session_identifier.as_ref() == session_identifier);
                if frame.session_identifier.as_ref() != session_identifier && !owns_parent {
                    return events;
                }
                events.extend(self.remove_frames(&identifier, false));
                self.retire_frame_contexts(&identifier);
                let frame = self.frames.get_mut(&identifier).unwrap();
                frame.session_identifier = renderer.into();
                frame.remote = true;
                frame.lifecycle.clear();
            }
            "Page.frameNavigated" => {
                let description = &parameters["frame"];
                let identifier = text(description, "id");
                if !self.owns_frame(&identifier, session_identifier) {
                    return events;
                }
                // Chromium can replace a document without individual detach events for
                // each child. Those frame identities belong to the predecessor document.
                events.extend(self.remove_frames(&identifier, false));
                let parent = description["parentId"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| {
                        self.frames
                            .get(&identifier)
                            .and_then(|frame| frame.parent.clone())
                    });
                if parent.is_none() {
                    self.main_frame = Some(identifier.clone());
                }
                let loader = text(description, "loaderId");
                let remote = self.session_is_remote(session_identifier);
                let frame = self.frames.entry(identifier.clone()).or_default();
                if frame.loader != loader {
                    frame.lifecycle.clear();
                    frame.loader = loader;
                }
                frame.identifier = identifier;
                frame.session_identifier = session_identifier.into();
                frame.parent = parent;
                frame.name = text(description, "name");
                frame.url =
                    text(description, "url") + description["urlFragment"].as_str().unwrap_or("");
                frame.navigation_sequence = self.sequence;
                frame.pending_navigation = None;
                frame.remote = remote;
                let public_navigation_index = events.len();
                events.push(("framenavigated", frame.snapshot()));
                if !frame.loader.is_empty() && !self.completed_lifecycle.contains_key(&frame.loader)
                {
                    self.completed_lifecycle
                        .insert(frame.loader.clone(), HashSet::from(["commit".to_owned()]));
                    self.recent_loaders.push_back(frame.loader.clone());
                    while self.recent_loaders.len() > 1024 {
                        if let Some(oldest) = self.recent_loaders.pop_front() {
                            self.completed_lifecycle.remove(&oldest);
                        }
                    }
                }
                let current_frame = frame.identifier.clone();
                let current_loader = frame.loader.clone();
                self.active_requests.retain(|identifier| {
                    self.requests.get(identifier).is_some_and(|request| {
                        request.metadata()["frame"] != current_frame
                            || request.metadata()["loader"] == current_loader
                    })
                });
                if self.active_requests.is_empty() {
                    self.idle_since = Some(Instant::now());
                }
                if self.main_frame.as_deref() == Some(&current_frame) {
                    let has_network_request = self
                        .requests
                        .get(&current_loader)
                        .is_some_and(|request| request.metadata()["navigation"] == true);
                    let navigation_event = self.record_navigation(
                        current_frame.clone(),
                        NavigationOutcome::Document {
                            loader: current_loader.clone(),
                            has_network_request,
                        },
                    );
                    events.insert(public_navigation_index, ("navigation", navigation_event));
                }
            }
            "Page.navigatedWithinDocument" => {
                let identifier = text(parameters, "frameId");
                if !self.owns_frame(&identifier, session_identifier) {
                    return events;
                }
                let public_navigation_index = events.len();
                let navigation = if let Some(frame) = self.frames.get_mut(&identifier) {
                    frame.url = text(parameters, "url");
                    frame.navigation_sequence = self.sequence;
                    frame.pending_navigation = None;
                    events.push(("framenavigated", frame.snapshot()));
                    Some(NavigationOutcome::SameDocument {
                        loader: frame.loader.clone(),
                    })
                } else {
                    None
                };
                if self.main_frame.as_deref() == Some(&identifier)
                    && let Some(navigation) = navigation
                {
                    let navigation_event = self.record_navigation(identifier, navigation);
                    events.insert(public_navigation_index, ("navigation", navigation_event));
                }
            }
            "Page.frameRequestedNavigation" => {
                if parameters["disposition"] == "currentTab"
                    && let Some(frame) = self.frames.get_mut(&text(parameters, "frameId"))
                    && frame.session_identifier.as_ref() == session_identifier
                {
                    frame.pending_navigation = Some(PendingNavigation {
                        sequence: self.sequence,
                        loader: None,
                    });
                }
            }
            "Page.frameDetached" => {
                let identifier = text(parameters, "frameId");
                let Some(frame) = self.frames.get(&identifier) else {
                    return events;
                };
                let owns_frame = frame.session_identifier.as_ref() == session_identifier;
                if parameters["reason"] == "swap" {
                    if !owns_frame {
                        return events;
                    }
                    events.extend(self.remove_frames(&identifier, false));
                    self.retire_frame_contexts(&identifier);
                    if let Some(frame) = self.frames.get_mut(&identifier) {
                        frame.remote = true;
                    }
                } else {
                    let owns_parent = frame
                        .parent
                        .as_ref()
                        .and_then(|parent| self.frames.get(parent))
                        .is_some_and(|parent| {
                            parent.session_identifier.as_ref() == session_identifier
                        });
                    if !owns_frame && !owns_parent {
                        return events;
                    }
                    events.extend(self.remove_frames(&identifier, true));
                }
            }
            "Page.lifecycleEvent" => {
                let identifier = text(parameters, "frameId");
                if !self.owns_frame(&identifier, session_identifier) {
                    return events;
                }
                let loader = text(parameters, "loaderId");
                let name = text(parameters, "name");
                let frame = self.frames.get_mut(&identifier).unwrap();
                if name == "init" {
                    frame.loader = loader.clone();
                    frame.lifecycle.clear();
                }
                if frame.loader == loader {
                    frame.lifecycle.insert(name.clone());
                }
                if self.main_frame.as_deref() == Some(&frame.identifier) {
                    if name == "DOMContentLoaded" {
                        events.push(("domcontentloaded", Value::Null));
                    }
                    if name == "load" {
                        events.push(("load", Value::Null));
                    }
                }
            }
            "Network.requestWillBeSent" => {
                let identifier = text(parameters, "requestId");
                let predecessor = parameters
                    .get("redirectResponse")
                    .and_then(|_| self.requests.get(&identifier))
                    .map(|request| request.identity().to_owned());
                if let Some(previous) = self.requests.get(&identifier)
                    && predecessor.is_some()
                {
                    let response =
                        response_metadata(&identifier, previous, &parameters["redirectResponse"]);
                    if let Err(error) = self.requests.respond(
                        &identifier,
                        response,
                        parameters["redirectHasExtraInfo"] == true,
                        &mut observation,
                    ) {
                        self.failure = Some(error);
                        events.extend(network_events.events);
                        return events;
                    }
                    if let Err(error) =
                        self.requests
                            .finish(&identifier, None, false, &mut observation)
                    {
                        self.failure = Some(error);
                        events.extend(network_events.events);
                        return events;
                    }
                }
                let request = &parameters["request"];
                let preflight = self.interception.enabled
                    && request["method"] == "OPTIONS"
                    && parameters["initiator"]["type"] == "preflight";
                // Playwright excludes favicon requests (and their redirects) from events and idle accounting.
                if preflight
                    || self.ignored_requests.contains(&identifier)
                    || request["url"]
                        .as_str()
                        .is_some_and(|url| url.ends_with("/favicon.ico"))
                {
                    self.requests.forget_headers(&identifier, &mut observation);
                    if let Err(error) = self.interception.ignored(&identifier, preflight) {
                        self.failure = Some(error);
                    }
                    self.ignored_requests.insert(identifier);
                    events.extend(network_events.events);
                    return events;
                }
                let mut request =
                    RequestState::from_event(&identifier, self.sequence, &event, predecessor);
                request.awaiting_interception = self.interception.enabled
                    && !request.original_metadata()["url"]
                        .as_str()
                        .is_some_and(|url| url.starts_with("data:"));
                if request.metadata()["navigation"] == true
                    && let Some(frame) = self.frames.get_mut(&text(parameters, "frameId"))
                {
                    let navigation = frame.pending_navigation.get_or_insert(PendingNavigation {
                        sequence: self.sequence,
                        loader: None,
                    });
                    navigation.loader = Some(identifier.clone());
                }
                if let Err(error) =
                    self.requests
                        .insert(identifier.clone(), request, &mut observation)
                {
                    self.failure = Some(error);
                    events.extend(network_events.events);
                    return events;
                }
                if let Err(error) =
                    self.interception
                        .created(&identifier, &mut self.requests, &mut observation)
                {
                    self.failure = Some(error);
                }
                self.active_requests.insert(identifier);
                self.idle_since = None;
            }
            "Fetch.requestPaused" => {
                let ignored = parameters["networkId"]
                    .as_str()
                    .is_some_and(|identifier| self.ignored_requests.contains(identifier));
                if let Err(error) = self.interception.paused(
                    parameters,
                    &mut self.requests,
                    &mut observation,
                    ignored,
                ) {
                    self.failure = Some(error);
                }
            }
            "Network.responseReceived" => {
                let identifier = text(parameters, "requestId");
                if let Some(request) = self.requests.get(&identifier) {
                    let response = response_metadata(&identifier, request, &parameters["response"]);
                    if let Err(error) = self.requests.respond(
                        &identifier,
                        response,
                        parameters["hasExtraInfo"] == true,
                        &mut observation,
                    ) {
                        self.failure = Some(error);
                        events.extend(network_events.events);
                        return events;
                    }
                }
            }
            "Network.requestServedFromCache" => self
                .requests
                .served_from_cache(&text(parameters, "requestId"), &mut observation),
            "Network.requestWillBeSentExtraInfo" | "Network.responseReceivedExtraInfo" => {
                let identifier = text(parameters, "requestId");
                if !self.ignored_requests.contains(&identifier) {
                    let kind = if method == "Network.requestWillBeSentExtraInfo" {
                        HeaderKind::Request
                    } else {
                        HeaderKind::Response
                    };
                    if let Err(error) = self.requests.extra_headers(
                        &identifier,
                        parameters["headers"].clone(),
                        kind,
                        &mut observation,
                    ) {
                        self.failure = Some(error);
                    }
                }
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                let identifier = text(parameters, "requestId");
                self.interception.finished(&identifier);
                if self.ignored_requests.remove(&identifier) {
                    self.requests.forget_headers(&identifier, &mut observation);
                    events.extend(network_events.events);
                    return events;
                }
                let mut failed_navigation = None;
                let public_failure_index = events.len();
                if method == "Network.loadingFailed"
                    && let Some(request) = self.requests.get(&identifier)
                    && request.metadata()["navigation"] == true
                    && let Some(frame) = self.frames.get_mut(&text(request.metadata(), "frame"))
                    && frame.pending_navigation.as_ref().is_some_and(|pending| {
                        pending
                            .loader
                            .as_deref()
                            .is_none_or(|loader| loader == identifier)
                    })
                {
                    frame.pending_navigation = None;
                    if self.main_frame.as_deref() == Some(&frame.identifier) {
                        failed_navigation = Some((
                            frame.identifier.clone(),
                            NavigationOutcome::Failed(text(parameters, "errorText")),
                        ));
                    }
                }
                if let Err(error) = self.requests.finish(
                    &identifier,
                    (method == "Network.loadingFailed").then(|| text(parameters, "errorText")),
                    true,
                    &mut observation,
                ) {
                    self.failure = Some(error);
                    events.extend(network_events.events);
                    return events;
                }
                if let Some((frame, outcome)) = failed_navigation {
                    let navigation_event = self.record_navigation(frame, outcome);
                    events.insert(public_failure_index, ("navigation", navigation_event));
                }
                let was_active = self.active_requests.remove(&identifier);
                if was_active && self.active_requests.is_empty() {
                    self.idle_since = Some(Instant::now());
                }
            }
            _ => {}
        }
        if matches!(method, "Page.frameNavigated" | "Page.frameDetached")
            && let Err(error) = self
                .requests
                .retain_live_loaders(self.frames.values().map(|frame| frame.loader.clone()))
        {
            self.failure = Some(error);
        }
        if let Some(main) = self
            .main_frame
            .as_ref()
            .and_then(|identifier| self.frames.get(identifier))
        {
            for lifecycle in ["DOMContentLoaded", "load"] {
                if !main.loader.is_empty()
                    && self
                        .frames
                        .values()
                        .all(|frame| !frame.remote && frame.lifecycle.contains(lifecycle))
                {
                    self.completed_lifecycle
                        .entry(main.loader.clone())
                        .or_default()
                        .insert(lifecycle.to_owned());
                }
            }
        }
        events.extend(network_events.events);
        events
    }

    fn session_is_remote(&self, session_identifier: &str) -> bool {
        self.main_frame
            .as_ref()
            .and_then(|frame| self.frames.get(frame))
            .is_some_and(|frame| frame.session_identifier.as_ref() != session_identifier)
    }

    fn retire_frame_contexts(&mut self, frame_identifier: &str) {
        self.main_worlds.remove(frame_identifier);
        self.execution_contexts
            .retain(|_, context| context.frame_identifier != frame_identifier);
    }

    fn remove_frames(&mut self, root: &str, include_root: bool) -> Vec<(&'static str, Value)> {
        let mut depths = HashMap::from([(root.to_owned(), 0_usize)]);
        loop {
            let descendants: Vec<_> = self
                .frames
                .values()
                .filter_map(|frame| {
                    if depths.contains_key(&frame.identifier) {
                        return None;
                    }
                    frame
                        .parent
                        .as_ref()
                        .and_then(|parent| depths.get(parent))
                        .map(|depth| (frame.identifier.clone(), depth + 1))
                })
                .collect();
            if descendants.is_empty() {
                break;
            }
            depths.extend(descendants);
        }
        if !include_root {
            depths.remove(root);
        }
        self.main_worlds
            .retain(|frame, _| !depths.contains_key(frame));
        self.execution_contexts
            .retain(|_, context| !depths.contains_key(&context.frame_identifier));
        self.active_requests.retain(|identifier| {
            self.requests.get(identifier).is_some_and(|request| {
                !depths.contains_key(request.metadata()["frame"].as_str().unwrap_or(""))
            })
        });
        if self.active_requests.is_empty() {
            self.idle_since = Some(Instant::now());
        }
        let mut removed: Vec<_> = depths.into_iter().collect();
        removed.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
        removed
            .into_iter()
            .filter_map(|(identifier, _)| {
                self.frames
                    .remove(&identifier)
                    .map(|frame| ("framedetached", frame.snapshot()))
            })
            .collect()
    }

    pub fn record_idle(&mut self) {
        if self.frames.values().any(|frame| frame.remote) {
            return;
        }
        if self
            .idle_since
            .is_some_and(|instant| instant.elapsed() >= std::time::Duration::from_millis(500))
            && let Some(main) = self
                .main_frame
                .as_ref()
                .and_then(|identifier| self.frames.get_mut(identifier))
        {
            main.lifecycle.insert("networkidle".to_owned());
            if !main.loader.is_empty() {
                self.completed_lifecycle
                    .entry(main.loader.clone())
                    .or_default()
                    .insert("networkidle".to_owned());
            }
        }
    }
}

fn response_metadata(identifier: &str, request: &RequestState, response: &Value) -> Value {
    json!({ "identifier": identifier, "request": request.reference(), "url": response["url"], "status": response["status"], "statusText": response["statusText"], "headers": response["headers"], "fromServiceWorker": response["fromServiceWorker"] })
}

fn text(value: &Value, field: &str) -> String {
    value[field].as_str().unwrap_or_default().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_request_metadata_is_published_once_and_lifecycle_messages_keep_exact_references() {
        for failed in [false, true] {
            let mut state = DocumentState::default();
            let original = state.observe(
                "Network.requestWillBeSent",
                &json!({
                    "requestId": "body", "type": "Fetch", "request": {
                        "url": "https://example.test/body", "method": "POST",
                        "postDataEntries": [{"bytes": "AAAA".repeat(1024 * 1024)}],
                    },
                }),
            );
            assert_eq!(original.len(), 1);
            assert_eq!(original[0].0, "request");
            let reference = json!({"identifier": "body", "identity": original[0].1["identity"]});
            let response = state.observe("Network.responseReceived", &json!({
                "requestId": "body", "response": {"url": "https://example.test/body", "status": 200, "statusText": "OK", "headers": {}},
            }));
            assert_eq!(response.len(), 1);
            assert_eq!(response[0].1["request"], reference);
            assert!(serde_json::to_vec(&response).unwrap().len() < 512);
            let terminal = state.observe(
                if failed {
                    "Network.loadingFailed"
                } else {
                    "Network.loadingFinished"
                },
                &json!({"requestId": "body", "errorText": "net::ERR_FAILED"}),
            );
            assert_eq!(terminal.len(), 1);
            assert_eq!(
                terminal[0].0,
                if failed {
                    "requestfailed"
                } else {
                    "requestfinished"
                }
            );
            assert_eq!(
                if failed {
                    &terminal[0].1["request"]
                } else {
                    &terminal[0].1
                },
                &reference
            );
            assert!(serde_json::to_vec(&terminal).unwrap().len() < 256);
            assert_eq!(
                state.requests.get("body").unwrap().original_metadata()["postDataEntries"],
                original[0].1["postDataEntries"]
            );
        }
    }

    #[test]
    fn redirected_request_identifiers_keep_distinct_immutable_body_owners() {
        let mut state = DocumentState::default();
        state.observe("Network.requestWillBeSent", &json!({
            "requestId":"shared", "type":"Fetch", "request":{"url":"https://example.test/first", "method":"GET"}
        }));
        let first_identity = state.requests.get("shared").unwrap().metadata()["identity"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            state
                .request_for_occurrence("shared", &first_identity, "response.body")
                .is_ok()
        );
        let events = state.observe("Network.requestWillBeSent", &json!({
            "requestId":"shared", "type":"Fetch", "redirectResponse":{"status":302, "url":"https://example.test/first", "headers":{"location":"/second"}},
            "request":{"url":"https://example.test/second", "method":"GET"}
        }));
        let second_identity = state.requests.get("shared").unwrap().metadata()["identity"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(first_identity, second_identity);
        assert_eq!(events[0].0, "response");
        assert_eq!(events[0].1["request"]["identity"], first_identity);
        assert_eq!(events[1].0, "requestfinished");
        assert_eq!(events[1].1["identity"], first_identity);
        assert_eq!(
            state
                .request_for_occurrence("shared", &first_identity, "response.body")
                .err()
                .unwrap()
                .code,
            ErrorCode::Protocol
        );
        let mut effective = state.requests.get("shared").unwrap().metadata().clone();
        effective["identity"] = json!(first_identity);
        state.requests.get_mut("shared").unwrap().effective_metadata = Some(effective);
        assert!(
            state
                .request_for_occurrence("shared", &second_identity, "response.body")
                .is_ok()
        );
        assert_eq!(
            state
                .request_for_occurrence("missing", &second_identity, "response.body")
                .err()
                .unwrap()
                .code,
            ErrorCode::ResourceLimit
        );
    }

    fn create_context(state: &mut DocumentState, frame: &str, identifier: u64, unique: &str) {
        state.observe(
            "Runtime.executionContextCreated",
            &json!({ "context": {
                "id": identifier, "uniqueId": unique,
                "auxData": { "frameId": frame, "isDefault": true },
            } }),
        );
    }

    fn frame_world(
        state: &mut DocumentState,
        session: &str,
        frame: &str,
        unique: &str,
    ) -> ExecutionContext {
        state.observe_in_session(session, "Runtime.executionContextCreated", &json!({
            "context": {"id": 1, "uniqueId": unique, "auxData": {"frameId": frame, "isDefault": true}}
        }));
        state.main_worlds[frame].clone()
    }

    fn frame_tree() -> DocumentState {
        let mut state = DocumentState::default();
        state.initialize_main_frame("main", "root");
        state.observe_in_session(
            "root",
            "Page.frameNavigated",
            &json!({"frame": {"id":"main", "loaderId":"main-loader", "url":"http://local/root"}}),
        );
        state.observe_in_session(
            "root",
            "Page.frameAttached",
            &json!({"frameId":"child", "parentFrameId":"main"}),
        );
        state.observe_in_session("root", "Page.frameNavigated", &json!({"frame": {"id":"child", "parentId":"main", "loaderId":"child-loader", "url":"http://local/child"}}));
        frame_world(&mut state, "root", "child", "local-child-world");
        state
    }

    #[test]
    fn late_predecessor_swap_cannot_retire_the_new_renderer_document() {
        for swap_first in [true, false] {
            let mut state = frame_tree();
            let local = state.main_worlds["child"].clone();
            if swap_first {
                state.observe_in_session(
                    "root",
                    "Page.frameDetached",
                    &json!({"frameId":"child", "reason":"swap"}),
                );
            }
            let attached = state.observe_in_session(
                "root",
                "Target.attachedToTarget",
                &json!({"sessionId":"remote", "targetInfo":{"type":"iframe", "targetId":"child"}}),
            );
            assert!(attached.is_empty());
            state.observe_in_session("remote", "Page.frameNavigated", &json!({"frame":{"id":"child", "loaderId":"remote-loader", "url":"http://remote/child"}}));
            let remote = frame_world(&mut state, "remote", "child", "remote-child-world");
            state.observe_in_session(
                "remote",
                "Page.frameAttached",
                &json!({"frameId":"new-descendant", "parentFrameId":"child"}),
            );
            state.observe_in_session("remote", "Runtime.executionContextCreated", &json!({"context":{"id":2,"uniqueId":"descendant-world","auxData":{"frameId":"new-descendant","isDefault":true}}}));
            let descendant = state.main_worlds["new-descendant"].clone();
            if !swap_first {
                let late = state.observe_in_session(
                    "root",
                    "Page.frameDetached",
                    &json!({"frameId":"child", "reason":"swap"}),
                );
                assert!(late.is_empty());
            }
            state.observe_in_session(
                "root",
                "Page.lifecycleEvent",
                &json!({"frameId":"child", "loaderId":"stale-loader", "name":"init"}),
            );
            state.observe_in_session("root", "Runtime.executionContextCreated", &json!({"context":{"id":3,"uniqueId":"stale-world","auxData":{"frameId":"child","isDefault":true}}}));
            assert!(!state.context_is_alive(&local));
            assert!(state.context_is_alive(&remote));
            assert!(state.context_is_alive(&descendant));
            assert_eq!(state.main_frame.as_deref(), Some("main"));
            assert_eq!(state.frames["child"].parent.as_deref(), Some("main"));
            assert_eq!(state.frames["child"].loader, "remote-loader");
            assert_eq!(state.frames["child"].session_identifier.as_ref(), "remote");
            assert!(state.frames["child"].remote);
            assert!(state.failure.is_none());
        }
    }

    #[test]
    fn renderer_handoffs_preserve_frame_identity_and_parent_removal_retires_it() {
        let mut state = frame_tree();
        for renderer in ["remote-one", "remote-two"] {
            state.observe_in_session(
                "root",
                "Target.attachedToTarget",
                &json!({"sessionId":renderer,"targetInfo":{"type":"iframe","targetId":"child"}}),
            );
            state.observe_in_session(
                renderer,
                "Page.frameNavigated",
                &json!({"frame":{"id":"child","loaderId":renderer}}),
            );
            frame_world(&mut state, renderer, "child", renderer);
        }
        let original_remote = state.main_worlds["child"].clone();
        state
            .frames
            .get_mut("child")
            .unwrap()
            .lifecycle
            .insert("load".into());
        assert_eq!(original_remote.session_identifier.as_ref(), "remote-two");
        assert!(
            state
                .observe_in_session(
                    "remote-one",
                    "Page.frameDetached",
                    &json!({"frameId":"child","reason":"swap"})
                )
                .is_empty()
        );
        assert!(state.context_is_alive(&original_remote));
        let returned = state.observe_in_session(
            "root",
            "Page.frameAttached",
            &json!({"frameId":"child","parentFrameId":"main"}),
        );
        assert!(returned.is_empty());
        assert!(!state.context_is_alive(&original_remote));
        assert!(!state.frames["child"].remote);
        assert!(state.frames["child"].lifecycle.is_empty());
        let local = frame_world(&mut state, "root", "child", "returned-local-world");
        state.observe_in_session("remote-two", "Runtime.executionContextsCleared", &json!({}));
        assert!(state.context_is_alive(&local));

        state.observe_in_session(
            "root",
            "Target.attachedToTarget",
            &json!({"sessionId":"remote-three","targetInfo":{"type":"iframe","targetId":"child"}}),
        );
        frame_world(&mut state, "remote-three", "child", "third-remote-world");
        let removed = state.observe_in_session(
            "root",
            "Page.frameDetached",
            &json!({"frameId":"child","reason":"remove"}),
        );
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].0, "framedetached");
        assert!(!state.frames.contains_key("child"));
        assert!(!state.main_worlds.contains_key("child"));
        assert_eq!(state.main_frame.as_deref(), Some("main"));
        assert!(state.failure.is_none());
    }

    #[test]
    fn removed_frames_cannot_be_recreated_by_predecessor_events() {
        for handoff in [false, true] {
            let mut state = frame_tree();
            state.observe_in_session(
                "root",
                "Page.frameAttached",
                &json!({"frameId":"old-descendant","parentFrameId":"child"}),
            );
            if handoff {
                state.observe_in_session("root", "Target.attachedToTarget", &json!({"sessionId":"remote","targetInfo":{"type":"iframe","targetId":"child"}}));
            } else {
                state.observe_in_session(
                    "root",
                    "Page.frameDetached",
                    &json!({"frameId":"child","reason":"remove"}),
                );
            }
            let expected_frames = state.frames.len();
            for (session, method, parameters) in [
                (
                    "root",
                    "Page.frameNavigated",
                    json!({"frame":{"id":"old-descendant","parentId":"child","loaderId":"stale"}}),
                ),
                (
                    "root",
                    "Page.lifecycleEvent",
                    json!({"frameId":"old-descendant","loaderId":"stale","name":"init"}),
                ),
                (
                    "root",
                    "Runtime.executionContextCreated",
                    json!({"context":{"id":99,"uniqueId":"stale-world","auxData":{"frameId":"old-descendant","isDefault":true}}}),
                ),
                (
                    "root",
                    "Page.frameAttached",
                    json!({"frameId":"old-descendant","parentFrameId":"child"}),
                ),
                (
                    "root",
                    "Target.attachedToTarget",
                    json!({"sessionId":"stale-renderer","targetInfo":{"type":"iframe","targetId":"old-descendant"}}),
                ),
                (
                    "remote",
                    "Page.frameNavigated",
                    json!({"frame":{"id":"old-descendant","loaderId":"stale"}}),
                ),
            ] {
                assert!(
                    state
                        .observe_in_session(session, method, &parameters)
                        .is_empty(),
                    "{method}"
                );
                assert_eq!(state.frames.len(), expected_frames, "{method}");
                assert_eq!(state.main_frame.as_deref(), Some("main"), "{method}");
                assert!(
                    !state.main_worlds.contains_key("old-descendant"),
                    "{method}"
                );
                assert!(state.failure.is_none(), "{method}");
            }
            if !handoff {
                assert!(
                    state
                        .observe_in_session(
                            "remote",
                            "Page.frameNavigated",
                            &json!({"frame":{"id":"child","loaderId":"late-remote-root"}})
                        )
                        .is_empty()
                );
                assert_eq!(state.main_frame.as_deref(), Some("main"));
                assert!(!state.frames.contains_key("child"));
            }
        }
    }

    #[test]
    fn early_lifecycle_cannot_invent_a_child_or_suppress_its_attachment() {
        let mut state = frame_tree();
        state.observe_in_session(
            "root",
            "Page.lifecycleEvent",
            &json!({"frameId":"new-child","loaderId":"early","name":"init"}),
        );
        assert!(!state.frames.contains_key("new-child"));
        let events = state.observe_in_session(
            "root",
            "Page.frameAttached",
            &json!({"frameId":"new-child","parentFrameId":"main"}),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "frameattached");
        assert_eq!(state.frames["new-child"].parent.as_deref(), Some("main"));
        assert!(state.frames["new-child"].lifecycle.is_empty());
    }

    #[test]
    fn numeric_context_collisions_and_clearing_are_scoped_to_the_original_session() {
        let mut state = DocumentState::default();
        for (session, frame, unique) in [
            ("parent-session", "main", "parent-world"),
            ("child-session", "child", "child-world"),
        ] {
            state.initialize_main_frame(frame, session);
            state.observe_in_session(
                session,
                "Runtime.executionContextCreated",
                &json!({
                    "context": { "id": 1, "uniqueId": unique,
                        "auxData": { "frameId": frame, "isDefault": true } }
                }),
            );
        }
        let parent = state.main_worlds["main"].clone();
        let child = state.main_worlds["child"].clone();
        assert_eq!(state.execution_contexts.len(), 2);
        assert!(state.context_is_alive(&parent));
        assert!(state.context_is_alive(&child));

        // Even a matching unique ID from another session has no authority over this world.
        state.observe_in_session(
            "parent-session",
            "Runtime.executionContextDestroyed",
            &json!({
                "executionContextId": 1, "executionContextUniqueId": "child-world"
            }),
        );
        assert!(state.context_is_alive(&parent));
        assert!(state.context_is_alive(&child));
        state.observe_in_session(
            "parent-session",
            "Runtime.executionContextsCleared",
            &json!({}),
        );
        assert!(!state.context_is_alive(&parent));
        assert!(state.context_is_alive(&child));
        assert!(!state.main_worlds.contains_key("main"));
        assert_eq!(state.main_worlds["child"], child);

        state.observe_in_session(
            "child-session",
            "Runtime.executionContextDestroyed",
            &json!({
                "executionContextId": 1
            }),
        );
        assert!(!state.context_is_alive(&child));
        assert!(state.execution_contexts.is_empty());
        assert!(state.main_worlds.is_empty());
    }

    #[test]
    fn renderer_sessions_share_one_page_execution_context_allowance() {
        let mut state = DocumentState::default();
        for identifier in 0..MAXIMUM_EXECUTION_CONTEXTS {
            state.initialize_main_frame(
                &format!("frame-{identifier}"),
                &format!("session-{identifier}"),
            );
            state.observe_in_session(
                &format!("session-{identifier}"),
                "Runtime.executionContextCreated",
                &json!({ "context": { "id": 1, "uniqueId": format!("world-{identifier}"),
                    "auxData": { "frameId": format!("frame-{identifier}"), "isDefault": true } } }),
            );
        }
        assert!(state.failure.is_none());
        state.initialize_main_frame("extra-frame", "extra-session");
        state.observe_in_session(
            "extra-session",
            "Runtime.executionContextCreated",
            &json!({
                "context": { "id": 1, "uniqueId": "extra-world",
                    "auxData": { "frameId": "extra-frame", "isDefault": true } }
            }),
        );
        assert_eq!(
            state.failure.as_ref().unwrap().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(state.execution_contexts.len(), MAXIMUM_EXECUTION_CONTEXTS);
        assert!(!state.main_worlds.contains_key("extra-frame"));
    }

    #[test]
    fn context_events_can_precede_frame_initialization() {
        let mut state = DocumentState::default();
        state.initialize_main_frame("main", "");
        create_context(&mut state, "main", 1, "main-world");
        assert!(state.main_execution_context().is_none());
        state.observe(
            "Page.frameNavigated",
            &json!({ "frame": { "id": "main", "loaderId": "document" } }),
        );
        assert_eq!(
            state.main_execution_context().unwrap().unique_identifier,
            "main-world"
        );
        // document.open and same-world document changes must not invent realm loss.
        state.observe(
            "Page.frameNavigated",
            &json!({ "frame": { "id": "main", "loaderId": "replacement" } }),
        );
        assert_eq!(
            state.main_execution_context().unwrap().unique_identifier,
            "main-world"
        );
    }

    #[test]
    fn isolated_and_detached_child_worlds_cannot_replace_the_main_world() {
        let mut state = DocumentState {
            main_frame: Some("main".into()),
            ..Default::default()
        };
        state.initialize_main_frame("main", "");
        create_context(&mut state, "main", 1, "main-world");
        state.observe(
            "Runtime.executionContextCreated",
            &json!({ "context": {
                "id": 2, "uniqueId": "isolated-world",
                "auxData": { "frameId": "main", "isDefault": false },
            } }),
        );
        let isolated = state
            .execution_contexts
            .get(&("".into(), 2))
            .unwrap()
            .clone();
        assert!(state.context_is_alive(&isolated));
        for (identifier, reason) in [(3, "swap"), (4, "remove")] {
            state.observe(
                "Page.frameAttached",
                &json!({ "frameId": "child", "parentFrameId": "main" }),
            );
            create_context(&mut state, "child", identifier, "child-world");
            state.observe(
                "Page.frameDetached",
                &json!({ "frameId": "child", "reason": reason }),
            );
            assert!(!state.main_worlds.contains_key("child"));
            assert!(
                !state
                    .execution_contexts
                    .contains_key(&("".into(), identifier))
            );
            assert!(state.context_is_alive(&isolated));
            assert_eq!(
                state.main_execution_context().unwrap().unique_identifier,
                "main-world"
            );
        }
    }

    #[test]
    fn delayed_destruction_cannot_remove_a_reused_numeric_context() {
        let mut state = DocumentState {
            main_frame: Some("main".into()),
            ..Default::default()
        };
        state.initialize_main_frame("main", "");
        create_context(&mut state, "main", 1, "predecessor");
        create_context(&mut state, "main", 1, "successor");
        state.observe(
            "Runtime.executionContextDestroyed",
            &json!({ "executionContextId": 1, "executionContextUniqueId": "predecessor" }),
        );
        assert_eq!(
            state.main_execution_context().unwrap().unique_identifier,
            "successor"
        );
        state.observe(
            "Runtime.executionContextDestroyed",
            &json!({ "executionContextId": 1, "executionContextUniqueId": "successor" }),
        );
        assert!(state.main_execution_context().is_none());
        create_context(&mut state, "main", 2, "third-world");
        state.observe("Runtime.executionContextsCleared", &json!({}));
        assert!(state.main_worlds.is_empty());
        assert!(state.execution_contexts.is_empty());
    }

    #[test]
    fn isolated_identity_reuse_and_document_open_preserve_only_the_live_world() {
        let mut state = DocumentState::default();
        state.initialize_main_frame("main", "");
        create_context(&mut state, "main", 1, "main-world");
        for unique in ["isolated-before", "isolated-after"] {
            state.observe(
                "Runtime.executionContextCreated",
                &json!({"context": {
                    "id": 2, "uniqueId": unique, "auxData": {"frameId": "main", "isDefault": false}
                }}),
            );
        }
        let isolated = state
            .execution_contexts
            .get(&("".into(), 2))
            .unwrap()
            .clone();
        state.observe(
            "Runtime.executionContextDestroyed",
            &json!({
                "executionContextId": 2, "executionContextUniqueId": "isolated-before"
            }),
        );
        for loader in ["original", "document-open"] {
            state.observe(
                "Page.frameNavigated",
                &json!({"frame": {"id": "main", "loaderId": loader}}),
            );
            assert!(state.context_is_alive(&isolated));
            assert_eq!(state.main_execution_context().unwrap().identifier, 1);
        }
        state.observe(
            "Runtime.executionContextDestroyed",
            &json!({
                "executionContextId": 2, "executionContextUniqueId": "isolated-after"
            }),
        );
        assert!(!state.context_is_alive(&isolated));
        assert!(state.main_execution_context().is_some());
    }

    #[test]
    fn frame_swap_retires_descendant_worlds_and_preserves_unrelated_frames() {
        let mut state = DocumentState::default();
        for (frame, parent, identifier) in [
            ("main", None, 1),
            ("child", Some("main"), 2),
            ("nested", Some("child"), 3),
            ("sibling", Some("main"), 4),
        ] {
            if let Some(parent) = parent {
                state.observe(
                    "Page.frameAttached",
                    &json!({"frameId":frame,"parentFrameId":parent}),
                );
            } else {
                state.initialize_main_frame(frame, "");
            }
            state.observe(
                "Page.frameNavigated",
                &json!({"frame": {"id": frame, "parentId": parent, "loaderId": frame}}),
            );
            create_context(&mut state, frame, identifier, frame);
            state.observe("Runtime.executionContextCreated", &json!({"context": {
                "id": identifier + 10, "uniqueId": format!("utility-{frame}"), "auxData": {"frameId": frame, "isDefault": false}
            }}));
        }
        let events = state.observe(
            "Page.frameDetached",
            &json!({"frameId": "child", "reason": "swap"}),
        );
        assert!(
            events
                .iter()
                .any(|(event, value)| *event == "framedetached" && value["identifier"] == "nested")
        );
        assert!(state.frames.get("child").unwrap().remote);
        assert!(!state.frames.contains_key("nested"));
        for identifier in [2, 3, 12, 13] {
            assert!(
                !state
                    .execution_contexts
                    .contains_key(&("".into(), identifier))
            );
        }
        for identifier in [1, 4, 11, 14] {
            assert!(
                state
                    .execution_contexts
                    .contains_key(&("".into(), identifier))
            );
        }
    }

    #[test]
    fn isolated_worlds_share_the_page_context_capacity() {
        let mut state = DocumentState::default();
        state.initialize_main_frame("main", "");
        create_context(&mut state, "main", 1, "main-world");
        for identifier in 2..=MAXIMUM_EXECUTION_CONTEXTS {
            state.observe("Runtime.executionContextCreated", &json!({"context": {
                "id": identifier, "uniqueId": format!("utility-{identifier}"), "auxData": {"frameId": "main", "isDefault": false}
            }}));
        }
        assert!(state.check("page.evaluate").is_ok());
        state.observe("Runtime.executionContextCreated", &json!({"context": {
            "id": MAXIMUM_EXECUTION_CONTEXTS + 1, "uniqueId": "overflow", "auxData": {"frameId": "main", "isDefault": false}
        }}));
        assert_eq!(
            state.check("page.evaluate").unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(state.execution_contexts.len(), MAXIMUM_EXECUTION_CONTEXTS);
        assert_eq!(state.main_worlds.len(), 1);
    }

    #[test]
    fn context_identity_and_live_world_capacity_fail_explicitly() {
        let mut malformed = DocumentState::default();
        malformed.initialize_main_frame("main", "");
        create_context(&mut malformed, "main", 1, "");
        assert_eq!(
            malformed.check("page.evaluate").unwrap_err().code,
            ErrorCode::Protocol
        );
        let mut state = DocumentState::default();
        for identifier in 0..MAXIMUM_EXECUTION_CONTEXTS {
            state.initialize_main_frame(&identifier.to_string(), "");
            create_context(
                &mut state,
                &identifier.to_string(),
                identifier as u64,
                "world",
            );
        }
        create_context(&mut state, "0", 2048, "replacement");
        assert!(state.check("page.evaluate").is_ok());
        state.initialize_main_frame("overflow", "");
        create_context(&mut state, "overflow", 2049, "overflow");
        assert_eq!(
            state.check("page.evaluate").unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(state.main_worlds.len(), MAXIMUM_EXECUTION_CONTEXTS);
    }
    #[test]
    fn navigation_journal_distinguishes_document_same_document_and_failed_main_frame_actions() {
        let mut state = DocumentState::default();
        state.initialize_main_frame("main", "");
        state.observe(
            "Page.frameNavigated",
            &json!({"frame":{"id":"main","loaderId":"initial","url":"about:blank"}}),
        );
        state.observe(
            "Page.frameAttached",
            &json!({"frameId":"child","parentFrameId":"main"}),
        );
        state.observe("Page.frameNavigated", &json!({"frame":{"id":"child","parentId":"main","loaderId":"child-loader","url":"about:blank"}}));
        state.observe(
            "Page.navigatedWithinDocument",
            &json!({"frameId":"child","url":"about:blank#child"}),
        );
        assert_eq!(state.navigation_events.len(), 1);
        state.observe(
            "Page.navigatedWithinDocument",
            &json!({"frameId":"main","url":"about:blank#same"}),
        );
        assert!(
            matches!(&state.navigation_events.back().unwrap().outcome, NavigationOutcome::SameDocument { loader } if loader == "initial")
        );
        state.observe("Network.requestWillBeSent", &json!({"requestId":"second","loaderId":"second","frameId":"main","type":"Document","request":{"url":"https://example.test/second","method":"GET"}}));
        state.observe(
            "Page.frameNavigated",
            &json!({"frame":{"id":"main","loaderId":"second","url":"https://example.test/second"}}),
        );
        assert!(
            matches!(&state.navigation_events.back().unwrap().outcome, NavigationOutcome::Document { loader, has_network_request: true } if loader == "second")
        );
        state.observe("Network.requestWillBeSent", &json!({"requestId":"failed","loaderId":"failed","frameId":"main","type":"Document","request":{"url":"https://example.test/failure","method":"GET"}}));
        state.observe(
            "Network.loadingFailed",
            &json!({"requestId":"failed","errorText":"net::ERR_FAILED"}),
        );
        assert!(
            matches!(&state.navigation_events.back().unwrap().outcome, NavigationOutcome::Failed(error) if error == "net::ERR_FAILED")
        );
        assert_eq!(state.navigation_events.len(), 4);
        let mut previous = 0;
        for event in &state.navigation_events {
            assert!(event.sequence > previous);
            previous = event.sequence;
        }
    }

    #[test]
    fn navigation_journal_retains_a_bounded_suffix_and_reports_the_evicted_sequence() {
        let mut state = DocumentState::default();
        state.initialize_main_frame("main", "");
        state.observe(
            "Page.frameNavigated",
            &json!({"frame":{"id":"main","loaderId":"initial","url":"about:blank"}}),
        );
        let first_sequence = state.navigation_events.front().unwrap().sequence;
        for _ in 0..MAXIMUM_NAVIGATION_EVENTS {
            state.observe(
                "Page.navigatedWithinDocument",
                &json!({"frameId":"main","url":"about:blank#same"}),
            );
        }
        assert_eq!(state.navigation_events.len(), MAXIMUM_NAVIGATION_EVENTS);
        assert_eq!(state.discarded_navigation_sequence, first_sequence);
        assert!(state.navigation_events.front().unwrap().sequence > first_sequence);
    }
}
