//! Page lifecycle and network state, updated in Chromium event order before notifying waiters.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use flashwright_protocol::ErrorRecord;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::Instant;

const MAXIMUM_RETAINED_REQUESTS: usize = 1024;

pub(crate) struct PageState {
    pub state: Mutex<DocumentState>,
    pub changed: watch::Sender<u64>,
    pub locator_realms: tokio::sync::Mutex<HashMap<String, super::locators::LocatorRealm>>,
    pub native_input: tokio::sync::Mutex<()>,
}

#[derive(Default)]
pub(crate) struct DocumentState {
    pub frames: HashMap<String, FrameState>,
    pub main_frame: Option<String>,
    pub requests: HashMap<String, RequestState>,
    completed_requests: VecDeque<String>,
    pub response_by_loader: HashMap<String, Value>,
    pub completed_lifecycle: HashMap<String, HashSet<String>>,
    recent_loaders: VecDeque<String>,
    pub active_requests: HashSet<String>,
    ignored_requests: HashSet<String>,
    pub idle_since: Option<Instant>,
    pub failure: Option<ErrorRecord>,
    pub sequence: u64,
    pub published: bool,
}

#[derive(Default)]
pub(crate) struct FrameState {
    pub identifier: String,
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

pub(crate) struct RequestState {
    pub metadata: Value,
    pub response: Option<Value>,
    pub finished: bool,
    pub failure: Option<String>,
}

impl Default for PageState {
    fn default() -> Self {
        Self {
            state: Mutex::new(DocumentState {
                idle_since: Some(Instant::now()),
                ..Default::default()
            }),
            changed: watch::channel(0).0,
            locator_realms: tokio::sync::Mutex::new(HashMap::new()),
            native_input: tokio::sync::Mutex::new(()),
        }
    }
}

impl PageState {
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
        json!({ "identifier": self.identifier, "parent": self.parent, "name": self.name, "url": self.url, "navigationSequence": self.navigation_sequence })
    }
}

impl DocumentState {
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

    pub fn observe(&mut self, method: &str, parameters: &Value) -> Vec<(&'static str, Value)> {
        self.record_idle();
        self.sequence += 1;
        let mut events = Vec::new();
        match method {
            "Page.frameAttached" => {
                let identifier = text(parameters, "frameId");
                let frame = self
                    .frames
                    .entry(identifier.clone())
                    .or_insert_with(|| FrameState {
                        identifier,
                        parent: parameters["parentFrameId"].as_str().map(str::to_owned),
                        url: "about:blank".into(),
                        ..Default::default()
                    });
                events.push(("frameattached", frame.snapshot()));
            }
            "Page.frameNavigated" => {
                let description = &parameters["frame"];
                let identifier = text(description, "id");
                // Chromium can replace a document without individual detach events for
                // each child. Those frame identities belong to the predecessor document.
                events.extend(self.remove_frames(&identifier, false));
                let parent = description["parentId"].as_str().map(str::to_owned);
                if parent.is_none() {
                    self.main_frame = Some(identifier.clone());
                }
                let loader = text(description, "loaderId");
                let frame = self.frames.entry(identifier.clone()).or_default();
                if frame.loader != loader {
                    frame.lifecycle.clear();
                    frame.loader = loader;
                }
                frame.identifier = identifier;
                frame.parent = parent;
                frame.name = text(description, "name");
                frame.url =
                    text(description, "url") + description["urlFragment"].as_str().unwrap_or("");
                frame.navigation_sequence = self.sequence;
                frame.pending_navigation = None;
                frame.remote = false;
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
                        request.metadata["frame"] != current_frame
                            || request.metadata["loader"] == current_loader
                    })
                });
                if self.active_requests.is_empty() {
                    self.idle_since = Some(Instant::now());
                }
                // Only loaders belonging to live documents or unfinished navigations are useful.
                if self.response_by_loader.len() > 128 {
                    let loaders: HashSet<_> = self
                        .frames
                        .values()
                        .map(|frame| frame.loader.clone())
                        .collect();
                    self.response_by_loader
                        .retain(|loader, _| loaders.contains(loader));
                }
            }
            "Page.navigatedWithinDocument" => {
                if let Some(frame) = self.frames.get_mut(&text(parameters, "frameId")) {
                    frame.url = text(parameters, "url");
                    frame.navigation_sequence = self.sequence;
                    frame.pending_navigation = None;
                    events.push(("framenavigated", frame.snapshot()));
                }
            }
            "Page.frameRequestedNavigation" => {
                if parameters["disposition"] == "currentTab"
                    && let Some(frame) = self.frames.get_mut(&text(parameters, "frameId"))
                {
                    frame.pending_navigation = Some(PendingNavigation {
                        sequence: self.sequence,
                        loader: None,
                    });
                }
            }
            "Page.frameDetached" => {
                let identifier = text(parameters, "frameId");
                if parameters["reason"] == "swap" {
                    if let Some(frame) = self.frames.get_mut(&identifier) {
                        frame.remote = true;
                    }
                } else {
                    events.extend(self.remove_frames(&identifier, true));
                }
            }
            "Page.lifecycleEvent" => {
                let identifier = text(parameters, "frameId");
                let loader = text(parameters, "loaderId");
                let name = text(parameters, "name");
                let frame = self
                    .frames
                    .entry(identifier.clone())
                    .or_insert_with(|| FrameState {
                        identifier,
                        ..Default::default()
                    });
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
                if let Some(previous) = self.requests.get(&identifier)
                    && parameters.get("redirectResponse").is_some()
                {
                    let response = response_metadata(
                        &identifier,
                        &previous.metadata,
                        &parameters["redirectResponse"],
                    );
                    events.push(("response", response));
                    events.push(("requestfinished", previous.metadata.clone()));
                }
                let request = &parameters["request"];
                // Playwright excludes favicon requests (and their redirects) from events and idle accounting.
                if self.ignored_requests.contains(&identifier)
                    || request["url"]
                        .as_str()
                        .is_some_and(|url| url.ends_with("/favicon.ico"))
                {
                    self.ignored_requests.insert(identifier);
                    return events;
                }
                let metadata = json!({ "identifier": identifier, "identity": format!("{identifier}:{}", self.sequence), "url": request["url"], "method": request["method"], "headers": request["headers"], "postData": request["postData"], "resourceType": parameters["type"], "frame": parameters["frameId"], "loader": parameters["loaderId"], "navigation": parameters["type"] == "Document" && parameters["requestId"] == parameters["loaderId"] });
                if metadata["navigation"] == true
                    && let Some(frame) = self.frames.get_mut(&text(parameters, "frameId"))
                {
                    let navigation = frame.pending_navigation.get_or_insert(PendingNavigation {
                        sequence: self.sequence,
                        loader: None,
                    });
                    navigation.loader = Some(identifier.clone());
                }
                self.requests.insert(
                    identifier.clone(),
                    RequestState {
                        metadata: metadata.clone(),
                        response: None,
                        finished: false,
                        failure: None,
                    },
                );
                self.active_requests.insert(identifier);
                self.idle_since = None;
                events.push(("request", metadata));
            }
            "Network.responseReceived" => {
                let identifier = text(parameters, "requestId");
                if let Some(request) = self.requests.get_mut(&identifier) {
                    let response =
                        response_metadata(&identifier, &request.metadata, &parameters["response"]);
                    if request.metadata["navigation"] == true {
                        self.response_by_loader
                            .insert(text(&request.metadata, "loader"), response.clone());
                    }
                    request.response = Some(response.clone());
                    events.push(("response", response));
                }
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                let identifier = text(parameters, "requestId");
                if self.ignored_requests.remove(&identifier) {
                    return events;
                }
                if let Some(request) = self.requests.get_mut(&identifier) {
                    request.finished = true;
                    if method == "Network.loadingFailed" {
                        if request.metadata["navigation"] == true
                            && let Some(frame) =
                                self.frames.get_mut(&text(&request.metadata, "frame"))
                            && frame.pending_navigation.as_ref().is_some_and(|pending| {
                                pending
                                    .loader
                                    .as_deref()
                                    .is_none_or(|loader| loader == identifier)
                            })
                        {
                            frame.pending_navigation = None;
                        }
                        request.failure = Some(text(parameters, "errorText"));
                        events.push((
                            "requestfailed",
                            json!({ "request": request.metadata, "errorText": request.failure }),
                        ));
                    } else {
                        events.push(("requestfinished", request.metadata.clone()));
                    }
                    self.completed_requests.push_back(identifier.clone());
                }
                let was_active = self.active_requests.remove(&identifier);
                if was_active && self.active_requests.is_empty() {
                    self.idle_since = Some(Instant::now());
                }
                while self.requests.len() > MAXIMUM_RETAINED_REQUESTS {
                    let Some(oldest) = self.completed_requests.pop_front() else {
                        break;
                    };
                    self.requests.remove(&oldest);
                }
            }
            _ => {}
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
        events
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
        self.active_requests.retain(|identifier| {
            self.requests.get(identifier).is_some_and(|request| {
                !depths.contains_key(request.metadata["frame"].as_str().unwrap_or(""))
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

fn response_metadata(identifier: &str, request: &Value, response: &Value) -> Value {
    json!({ "identifier": identifier, "request": request, "url": response["url"], "status": response["status"], "statusText": response["statusText"], "headers": response["headers"], "fromServiceWorker": response["fromServiceWorker"] })
}

fn text(value: &Value, field: &str) -> String {
    value[field].as_str().unwrap_or_default().to_owned()
}
