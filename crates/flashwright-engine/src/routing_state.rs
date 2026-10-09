//! Bounded Fetch pauses join immutable Network occurrences without delaying their ingress.

use std::collections::HashMap;
use std::sync::Arc;

use flashwright_browser::connection::fetch_body::{
    ContinueRequest, FetchBodyCommand, FetchBodySource, FetchHeader, FulfillRequest,
};
use flashwright_protocol::{ErrorCode, ErrorRecord, InputAttachment};
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::network_observer::NetworkObservation;
use crate::network_state::{NetworkRequests, encoded_bytes};

const PAGE_BYTES: usize = 64 * 1024 * 1024;
const ENGINE_BYTES: usize = 256 * 1024 * 1024;
const PAGE_OWNERS: usize = 1024;
const ENGINE_OWNERS: usize = 8192;
const OWNER_OVERHEAD: usize = 1024;

pub(crate) struct EngineRoutingBudget {
    bytes: Arc<Semaphore>,
    owners: Arc<Semaphore>,
}

impl Default for EngineRoutingBudget {
    fn default() -> Self {
        Self {
            bytes: Arc::new(Semaphore::new(ENGINE_BYTES)),
            owners: Arc::new(Semaphore::new(ENGINE_OWNERS)),
        }
    }
}

struct RoutingBudget {
    engine: Arc<EngineRoutingBudget>,
    bytes: Arc<Semaphore>,
    owners: Arc<Semaphore>,
}

struct Reservation {
    page_bytes: OwnedSemaphorePermit,
    engine_bytes: OwnedSemaphorePermit,
    _page_owner: OwnedSemaphorePermit,
    _engine_owner: OwnedSemaphorePermit,
}

impl RoutingBudget {
    fn reserve(&self, bytes: usize) -> Result<Reservation, ErrorRecord> {
        let bytes = bytes
            .checked_add(OWNER_OVERHEAD)
            .filter(|bytes| *bytes <= PAGE_BYTES)
            .ok_or_else(|| limited("route owner exceeds page byte allowance"))?
            as u32;
        Ok(Reservation {
            page_bytes: self
                .bytes
                .clone()
                .try_acquire_many_owned(bytes)
                .map_err(|_| limited("page route byte allowance exhausted"))?,
            engine_bytes: self
                .engine
                .bytes
                .clone()
                .try_acquire_many_owned(bytes)
                .map_err(|_| limited("engine route byte allowance exhausted"))?,
            _page_owner: self
                .owners
                .clone()
                .try_acquire_owned()
                .map_err(|_| limited("page route owner allowance exhausted"))?,
            _engine_owner: self
                .engine
                .owners
                .clone()
                .try_acquire_owned()
                .map_err(|_| limited("engine route owner allowance exhausted"))?,
        })
    }
}

impl RoutingBudget {
    fn resize(&self, reservation: &mut Reservation, bytes: usize) -> Result<(), ErrorRecord> {
        let required = bytes
            .checked_add(OWNER_OVERHEAD)
            .filter(|bytes| *bytes <= PAGE_BYTES)
            .ok_or_else(|| limited("route metadata exceeds page byte allowance"))?;
        let current = reservation.page_bytes.num_permits();
        if required > current {
            let additional = (required - current) as u32;
            let page = self
                .bytes
                .clone()
                .try_acquire_many_owned(additional)
                .map_err(|_| limited("page route byte allowance exhausted"))?;
            let engine = self
                .engine
                .bytes
                .clone()
                .try_acquire_many_owned(additional)
                .map_err(|_| limited("engine route byte allowance exhausted"))?;
            reservation.page_bytes.merge(page);
            reservation.engine_bytes.merge(engine);
        } else {
            reservation.reduce_to(bytes);
        }
        Ok(())
    }
}

impl Reservation {
    fn reduce_to(&mut self, bytes: usize) {
        let retained = bytes + OWNER_OVERHEAD;
        for permit in [&mut self.page_bytes, &mut self.engine_bytes] {
            if permit.num_permits() > retained {
                drop(permit.split(permit.num_permits() - retained));
            }
        }
    }
}

/// Route-owned bytes do not keep one of the host's two input slots occupied.
pub(crate) struct RouteBody {
    bytes: Arc<Vec<u8>>,
    _reservation: Reservation,
}

impl FetchBodySource for RouteBody {
    fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

struct Pause {
    identifier: String,
    network_identifier: String,
    request: Value,
    frame: String,
    redirected: bool,
    reservation: Reservation,
}

pub(crate) struct RouteOwner {
    pub fetch_identifier: String,
    pub network_identifier: String,
    pub identity: String,
    _reservation: Reservation,
}

struct Continuation {
    parameters: Arc<ContinueRequest>,
    body: Option<Arc<RouteBody>>,
    _reservation: Reservation,
}

pub(crate) enum RoutingCommand {
    Continue(Arc<ContinueRequest>),
    Fulfill(FulfillRequest),
    Abort {
        request_identifier: String,
        reason: String,
    },
}

/// Command ownership survives removal from page maps and cancellation of the public caller.
pub(crate) struct RoutingAction {
    pub command: RoutingCommand,
    pub body: Option<Arc<RouteBody>>,
    _owner: ActionOwner,
}

enum ActionOwner {
    Pause {
        _reservation: Reservation,
    },
    Route {
        _route: RouteOwner,
    },
    Continuation {
        _continuation: Arc<Continuation>,
        _pause: Option<Reservation>,
    },
}

impl RoutingAction {
    pub(crate) fn start(
        &self,
        connection: &flashwright_browser::connection::Connection,
        session: &str,
    ) -> Result<flashwright_browser::connection::Command, ErrorRecord> {
        match (&self.command, &self.body) {
            (RoutingCommand::Continue(parameters), Some(body)) => connection.start_fetch_body(
                FetchBodyCommand::Continue((**parameters).clone()),
                body.clone(),
                session,
            ),
            (RoutingCommand::Fulfill(parameters), Some(body)) => connection.start_fetch_body(
                FetchBodyCommand::Fulfill(parameters.clone()),
                body.clone(),
                session,
            ),
            (RoutingCommand::Continue(parameters), None) => connection.start_command(
                "Fetch.continueRequest",
                serde_json::to_value(parameters.as_ref()).unwrap(),
                Some(session),
            ),
            (RoutingCommand::Fulfill(parameters), None) => connection.start_command(
                "Fetch.fulfillRequest",
                serde_json::to_value(parameters).unwrap(),
                Some(session),
            ),
            (
                RoutingCommand::Abort {
                    request_identifier,
                    reason,
                },
                _,
            ) => connection.start_command(
                "Fetch.failRequest",
                json!({"requestId":request_identifier,"errorReason":reason}),
                Some(session),
            ),
        }
    }
}

pub(crate) struct RequestInterception {
    pub enabled: bool,
    budget: RoutingBudget,
    pauses: HashMap<String, Pause>,
    preflights: HashMap<String, Reservation>,
    routes: HashMap<String, RouteOwner>,
    continued: HashMap<String, Arc<Continuation>>,
    actions: Vec<RoutingAction>,
}

impl Default for RequestInterception {
    fn default() -> Self {
        Self::new(Arc::new(EngineRoutingBudget::default()))
    }
}

impl RequestInterception {
    pub(crate) fn new(engine: Arc<EngineRoutingBudget>) -> Self {
        Self {
            enabled: false,
            budget: RoutingBudget {
                engine,
                bytes: Arc::new(Semaphore::new(PAGE_BYTES)),
                owners: Arc::new(Semaphore::new(PAGE_OWNERS)),
            },
            pauses: HashMap::new(),
            preflights: HashMap::new(),
            routes: HashMap::new(),
            continued: HashMap::new(),
            actions: Vec::new(),
        }
    }

    pub(crate) fn body(&self, input: &InputAttachment) -> Result<Arc<RouteBody>, ErrorRecord> {
        Ok(Arc::new(RouteBody {
            bytes: input.bytes.clone(),
            _reservation: self.budget.reserve(input.bytes.len())?,
        }))
    }

    pub(crate) fn take_actions(&mut self) -> Vec<RoutingAction> {
        std::mem::take(&mut self.actions)
    }

    pub(crate) fn take_route(
        &mut self,
        identity: &str,
        identifier: &str,
    ) -> Result<RouteOwner, ErrorRecord> {
        let route = self.routes.get(identity).ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::InvalidArgument,
                "route",
                "Route is already handled!",
            )
        })?;
        if route.network_identifier != identifier {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                "route",
                "route occurrence does not match request identifier",
            ));
        }
        Ok(self.routes.remove(identity).unwrap())
    }

    pub(crate) fn continue_route(
        &mut self,
        owner: RouteOwner,
        mut parameters: ContinueRequest,
        body: Option<Arc<RouteBody>>,
        original_headers: &Value,
    ) -> Result<RoutingAction, ErrorRecord> {
        parameters.headers = parameters
            .headers
            .as_ref()
            .map(|headers| apply_headers_overrides(original_headers, headers));
        let reservation = match self
            .budget
            .reserve(encoded_bytes(&serde_json::to_value(&parameters).unwrap()))
        {
            Ok(reservation) => reservation,
            Err(error) => {
                self.routes.insert(owner.identity.clone(), owner);
                return Err(error);
            }
        };
        let continuation = Arc::new(Continuation {
            parameters: Arc::new(parameters),
            body,
            _reservation: reservation,
        });
        self.continued
            .insert(owner.network_identifier.clone(), continuation.clone());
        // The active pause no longer needs its metadata reservation after ownership transfers.
        drop(owner);
        Ok(RoutingAction {
            command: RoutingCommand::Continue(continuation.parameters.clone()),
            body: continuation.body.clone(),
            _owner: ActionOwner::Continuation {
                _continuation: continuation,
                _pause: None,
            },
        })
    }

    pub(crate) fn fulfill_route(
        &self,
        owner: RouteOwner,
        parameters: FulfillRequest,
        body: Option<Arc<RouteBody>>,
    ) -> RoutingAction {
        RoutingAction {
            command: RoutingCommand::Fulfill(parameters),
            body,
            _owner: ActionOwner::Route { _route: owner },
        }
    }

    pub(crate) fn abort_route(&self, owner: RouteOwner, reason: String) -> RoutingAction {
        RoutingAction {
            command: RoutingCommand::Abort {
                request_identifier: owner.fetch_identifier.clone(),
                reason,
            },
            body: None,
            _owner: ActionOwner::Route { _route: owner },
        }
    }

    pub(crate) fn paused(
        &mut self,
        parameters: &Value,
        requests: &mut NetworkRequests,
        observation: &mut NetworkObservation<'_, '_>,
        ignored: bool,
    ) -> Result<(), ErrorRecord> {
        let reservation = self.budget.reserve(encoded_bytes(parameters))?;
        let identifier = field(parameters, "requestId")?;
        let network_identifier = parameters["networkId"].as_str().unwrap_or("").to_owned();
        let mut pause = Pause {
            identifier,
            network_identifier: network_identifier.clone(),
            request: parameters["request"].clone(),
            frame: parameters["frameId"].as_str().unwrap_or("").to_owned(),
            redirected: parameters["redirectedRequestId"].is_string(),
            reservation,
        };
        if self.preflights.contains_key(&network_identifier) {
            self.fulfill_preflight(pause)?;
            return Ok(());
        }
        if network_identifier.is_empty()
            || ignored
            || pause.request["url"]
                .as_str()
                .is_some_and(|url| url.starts_with("data:"))
        {
            self.continue_pause(pause, None)?;
            return Ok(());
        }
        if requests
            .get(&network_identifier)
            .is_some_and(|request| request.awaiting_interception && !request.finished)
        {
            return self.join(pause, requests, observation);
        }
        if !pause.redirected
            && let Some(continuation) = self.continued.get(&network_identifier)
        {
            let mut parameters = (*continuation.parameters).clone();
            parameters.request_identifier = pause.identifier;
            self.budget.resize(
                &mut pause.reservation,
                encoded_bytes(&serde_json::to_value(&parameters).unwrap()),
            )?;
            self.actions.push(RoutingAction {
                command: RoutingCommand::Continue(Arc::new(parameters)),
                body: continuation.body.clone(),
                _owner: ActionOwner::Continuation {
                    _continuation: continuation.clone(),
                    _pause: Some(pause.reservation),
                },
            });
            return Ok(());
        }
        if !self.enabled {
            self.continue_pause(pause, None)?;
            return Ok(());
        }
        if self.pauses.contains_key(&network_identifier) {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                "route",
                "two unpaired Fetch pauses share a Network identifier",
            ));
        }
        self.pauses.insert(network_identifier, pause);
        Ok(())
    }

    pub(crate) fn ignored(&mut self, identifier: &str, preflight: bool) -> Result<(), ErrorRecord> {
        if preflight {
            self.preflights.insert(
                identifier.to_owned(),
                self.budget.reserve(identifier.len())?,
            );
        }
        if let Some(pause) = self.pauses.remove(identifier) {
            if preflight {
                self.fulfill_preflight(pause)?;
            } else {
                self.continue_pause(pause, None)?;
            }
        }
        Ok(())
    }

    fn fulfill_preflight(&mut self, mut pause: Pause) -> Result<(), ErrorRecord> {
        let request_headers = &pause.request["headers"];
        let header = |name: &str| {
            request_headers
                .as_object()
                .and_then(|headers| {
                    headers
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case(name))
                })
                .and_then(|(_, value)| value.as_str())
        };
        let mut response_headers = vec![
            FetchHeader {
                name: "Access-Control-Allow-Origin".into(),
                value: header("Origin").unwrap_or("*").into(),
            },
            FetchHeader {
                name: "Access-Control-Allow-Methods".into(),
                value: header("Access-Control-Request-Method")
                    .unwrap_or("GET, POST, OPTIONS, DELETE")
                    .into(),
            },
            FetchHeader {
                name: "Access-Control-Allow-Credentials".into(),
                value: "true".into(),
            },
        ];
        if let Some(value) = header("Access-Control-Request-Headers") {
            response_headers.push(FetchHeader {
                name: "Access-Control-Allow-Headers".into(),
                value: value.into(),
            });
        }
        let parameters = FulfillRequest {
            request_identifier: pause.identifier,
            response_code: 204,
            response_headers,
            response_phrase: Some("No Content".into()),
        };
        self.budget.resize(
            &mut pause.reservation,
            encoded_bytes(&serde_json::to_value(&parameters).unwrap()),
        )?;
        self.actions.push(RoutingAction {
            command: RoutingCommand::Fulfill(parameters),
            body: None,
            _owner: ActionOwner::Pause {
                _reservation: pause.reservation,
            },
        });
        Ok(())
    }

    pub(crate) fn created(
        &mut self,
        identifier: &str,
        requests: &mut NetworkRequests,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        if let Some(pause) = self.pauses.remove(identifier) {
            self.join(pause, requests, observation)?;
        }
        Ok(())
    }

    fn join(
        &mut self,
        mut pause: Pause,
        requests: &mut NetworkRequests,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        let request = requests
            .get(&pause.network_identifier)
            .expect("join has a Network occurrence");
        let identity = request.identity().to_owned();
        let redirected = request.predecessor().is_some();
        let mut metadata: Value = request
            .original_metadata()
            .as_object()
            .expect("request metadata is an object")
            .iter()
            .filter(|(name, _)| {
                !matches!(
                    name.as_str(),
                    "url" | "method" | "headers" | "postDataEntries"
                )
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect::<serde_json::Map<String, Value>>()
            .into();
        for name in ["url", "method", "headers"] {
            metadata[name] = pause.request[name].take();
        }
        let entries: Vec<Value> = pause.request["postDataEntries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry["bytes"].as_str())
            .filter(|bytes| !bytes.is_empty())
            .map(|bytes| json!(bytes))
            .collect();
        metadata["postDataEntries"] = if entries.is_empty() {
            Value::Null
        } else {
            json!(entries)
        };
        if metadata["frame"].as_str().is_none_or(str::is_empty) {
            metadata["frame"] = json!(pause.frame);
        }
        let headers = if redirected {
            self.continued
                .get(&pause.network_identifier)
                .and_then(|continuation| continuation.parameters.headers.as_ref())
                .map(|headers| apply_headers_overrides(&metadata["headers"], headers))
        } else {
            None
        };
        if let Some(headers) = &headers {
            metadata["headers"] = headers
                .iter()
                .map(|header| (header.name.clone(), json!(header.value)))
                .collect::<serde_json::Map<String, Value>>()
                .into();
        }
        requests.publish_request(&pause.network_identifier, Some(metadata), observation)?;
        if redirected || !self.enabled {
            self.continue_pause(pause, headers)?;
        } else {
            pause.reservation.reduce_to(
                pause.identifier.len() + pause.network_identifier.len() + identity.len(),
            );
            let owner = RouteOwner {
                fetch_identifier: pause.identifier,
                network_identifier: pause.network_identifier,
                identity: identity.clone(),
                _reservation: pause.reservation,
            };
            observation.emit(crate::network_observer::NetworkTransition::Routed(
                requests.get(&owner.network_identifier).unwrap(),
            ));
            self.routes.insert(identity, owner);
        }
        Ok(())
    }

    fn continue_pause(
        &mut self,
        mut pause: Pause,
        headers: Option<Vec<FetchHeader>>,
    ) -> Result<(), ErrorRecord> {
        let parameters = Arc::new(ContinueRequest {
            request_identifier: pause.identifier,
            url: None,
            method: None,
            headers,
        });
        self.budget.resize(
            &mut pause.reservation,
            encoded_bytes(&serde_json::to_value(parameters.as_ref()).unwrap()),
        )?;
        if !pause.network_identifier.is_empty()
            && self.continued.contains_key(&pause.network_identifier)
        {
            let continuation = Arc::new(Continuation {
                parameters: parameters.clone(),
                body: None,
                _reservation: pause.reservation,
            });
            self.continued
                .insert(pause.network_identifier, continuation.clone());
            self.actions.push(RoutingAction {
                command: RoutingCommand::Continue(parameters),
                body: None,
                _owner: ActionOwner::Continuation {
                    _continuation: continuation,
                    _pause: None,
                },
            });
        } else {
            self.actions.push(RoutingAction {
                command: RoutingCommand::Continue(parameters),
                body: None,
                _owner: ActionOwner::Pause {
                    _reservation: pause.reservation,
                },
            });
        }
        Ok(())
    }

    pub(crate) fn finished(&mut self, identifier: &str) {
        self.pauses.remove(identifier);
        self.preflights.remove(identifier);
        self.continued.remove(identifier);
        self.routes
            .retain(|_, owner| owner.network_identifier != identifier);
    }

    pub(crate) fn clear(&mut self) {
        self.pauses.clear();
        self.preflights.clear();
        self.routes.clear();
        self.continued.clear();
        self.actions.clear();
    }
}

fn field(parameters: &Value, name: &str) -> Result<String, ErrorRecord> {
    parameters[name]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::Protocol,
                "route",
                format!("Fetch omitted {name}"),
            )
        })
}

fn limited(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, "route.observe", message)
}

/// The pinned backend preserves forbidden browser headers, including cookie-jar ownership.
pub(crate) fn apply_headers_overrides(
    original: &Value,
    overrides: &[FetchHeader],
) -> Vec<FetchHeader> {
    let mut result: Vec<_> = overrides
        .iter()
        .filter(|header| !forbidden_header(&header.name, &header.value))
        .cloned()
        .collect();
    if let Some(original) = original.as_object() {
        for (name, value) in original {
            if let Some(value) = value.as_str()
                && forbidden_header(name, value)
            {
                result.retain(|header| !header.name.eq_ignore_ascii_case(name));
                result.push(FetchHeader {
                    name: name.clone(),
                    value: value.into(),
                });
            }
        }
    }
    result
}

fn forbidden_header(name: &str, value: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("proxy-")
        || name.starts_with("sec-")
        || matches!(
            name.as_str(),
            "accept-charset"
                | "accept-encoding"
                | "access-control-request-headers"
                | "access-control-request-method"
                | "connection"
                | "content-length"
                | "cookie"
                | "date"
                | "dnt"
                | "expect"
                | "host"
                | "keep-alive"
                | "origin"
                | "referer"
                | "set-cookie"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "via"
        )
        || (matches!(
            name.as_str(),
            "x-http-method" | "x-http-method-override" | "x-method-override"
        ) && matches!(
            value.to_ascii_uppercase().as_str(),
            "CONNECT" | "TRACE" | "TRACK"
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_state::HeaderKind;
    use crate::page_state::DocumentState;
    use flashwright_browser::Connection;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    use tokio::time::{Duration, timeout};

    fn network(url: &str) -> Value {
        json!({"requestId":"network","loaderId":"loader","frameId":"frame","type":"Fetch","request":{"url":url,"method":"POST","headers":{"Network-Only":"original"},"postDataEntries":[{"bytes":"AP+A"}]}})
    }
    fn pause(url: &str) -> Value {
        json!({"requestId":"fetch","networkId":"network","frameId":"frame","request":{"url":url,"method":"POST","headers":{"Fetch-Only":"joined","Cookie":"jar"},"postDataEntries":[{"bytes":"/wCA"}]}})
    }
    fn state() -> DocumentState {
        let mut state = DocumentState::default();
        state.interception.enabled = true;
        state
    }
    fn joined(state: &mut DocumentState) -> String {
        assert!(
            state
                .observe(
                    "Network.requestWillBeSent",
                    &network("https://example.test/first")
                )
                .is_empty()
        );
        let events = state.observe("Fetch.requestPaused", &pause("https://example.test/first"));
        assert_eq!(
            events.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
            ["request", "route"]
        );
        events[0].1["identity"].as_str().unwrap().into()
    }
    fn continue_request(
        state: &mut DocumentState,
        identity: &str,
        body: Option<Arc<RouteBody>>,
    ) -> RoutingAction {
        let owner = state.interception.take_route(identity, "network").unwrap();
        let parameters = ContinueRequest {
            request_identifier: owner.fetch_identifier.clone(),
            url: Some("https://example.test/override".into()),
            method: Some("PUT".into()),
            headers: Some(vec![
                FetchHeader {
                    name: "X-Override".into(),
                    value: "one".into(),
                },
                FetchHeader {
                    name: "Cookie".into(),
                    value: "old-jar".into(),
                },
            ]),
        };
        state
            .interception
            .continue_route(
                owner,
                parameters,
                body,
                &state.requests.get("network").unwrap().metadata()["headers"],
            )
            .unwrap()
    }

    #[test]
    fn either_arrival_order_publishes_only_joined_metadata_with_original_ingress() {
        for pause_first in [false, true] {
            let mut state = state();
            let network = network("https://example.test/original");
            let pause = pause("https://example.test/effective");
            let (first, second) = if pause_first {
                (
                    ("Fetch.requestPaused", &pause),
                    ("Network.requestWillBeSent", &network),
                )
            } else {
                (
                    ("Network.requestWillBeSent", &network),
                    ("Fetch.requestPaused", &pause),
                )
            };
            assert!(state.observe(first.0, first.1).is_empty());
            if !pause_first {
                let request = state.requests.get("network").unwrap();
                assert!(!request.publicly_ready);
                assert_eq!(request.ingress().sequence, 1);
            }
            let events = state.observe(second.0, second.1);
            assert_eq!(
                events.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
                ["request", "route"]
            );
            let request = state.requests.get("network").unwrap();
            assert_eq!(
                request.original_metadata()["url"],
                "https://example.test/original"
            );
            assert_eq!(
                request.original_metadata()["postDataEntries"],
                json!(["AP+A"])
            );
            assert_eq!(request.metadata()["url"], "https://example.test/effective");
            assert_eq!(request.metadata()["postDataEntries"], json!(["/wCA"]));
            assert_eq!(request.ingress().sequence, if pause_first { 2 } else { 1 });
            assert_eq!(events[1].1, request.reference());
            let identity = request.identity().to_owned();
            state.observe(
                "Network.requestWillBeSentExtraInfo",
                &json!({"requestId":"network","headers":{"Cookie":"later"}}),
            );
            state.observe("Network.responseReceived",&json!({"requestId":"network","hasExtraInfo":true,"response":{"url":"https://example.test/effective","status":200,"headers":{}}}));
            let headers = state
                .requests
                .headers(&identity, HeaderKind::Request)
                .unwrap()
                .unwrap();
            assert!(
                headers
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|header| header["name"] == "Cookie" && header["value"] == "jar")
            );
            assert!(state.failure.is_none());
        }
    }

    #[test]
    fn first_continuation_keeps_cookie_jar_headers_out_of_user_overrides() {
        let mut state = state();
        let identity = joined(&mut state);
        let action = continue_request(&mut state, &identity, None);
        let RoutingCommand::Continue(parameters) = action.command else {
            panic!("expected continue")
        };
        let headers = parameters.headers.as_ref().unwrap();
        let cookies: Vec<_> = headers
            .iter()
            .filter(|header| header.name.eq_ignore_ascii_case("cookie"))
            .collect();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].value, "jar");
        assert!(
            headers
                .iter()
                .any(|header| header.name == "X-Override" && header.value == "one")
        );
    }

    #[test]
    fn redirect_successor_keeps_new_identity_and_only_inherits_allowed_headers() {
        for pause_first in [false, true] {
            let mut state = state();
            let identity = joined(&mut state);
            drop(continue_request(&mut state, &identity, None));
            let mut next_network = network("https://other.test/second");
            next_network["redirectResponse"] = json!({"url":"https://example.test/first","status":302,"headers":{"location":"https://other.test/second"}});
            let mut next_pause = pause("https://other.test/second");
            next_pause["requestId"] = json!("fetch-redirect");
            next_pause["redirectedRequestId"] = json!("fetch");
            next_pause["request"]["headers"]["Cookie"] = json!("new-jar");
            let mut events = Vec::new();
            if pause_first {
                events.extend(state.observe("Fetch.requestPaused", &next_pause));
            }
            events.extend(state.observe("Network.requestWillBeSent", &next_network));
            if !pause_first {
                events.extend(state.observe("Fetch.requestPaused", &next_pause));
            }
            assert_eq!(
                events.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
                ["response", "requestfinished", "request"]
            );
            assert_eq!(events[1].1["identity"], identity);
            assert_ne!(events[2].1["identity"], identity);
            let request = state.requests.get("network").unwrap();
            assert_eq!(request.predecessor(), Some(identity.as_str()));
            assert_eq!(request.metadata()["headers"]["Cookie"], "new-jar");
            let actions = state.interception.take_actions();
            assert_eq!(actions.len(), 1);
            let RoutingCommand::Continue(parameters) = &actions[0].command else {
                panic!("redirect must continue")
            };
            assert_eq!(parameters.request_identifier, "fetch-redirect");
            assert!(parameters.url.is_none());
            assert!(parameters.method.is_none());
            assert!(actions[0].body.is_none());
            assert!(
                parameters
                    .headers
                    .as_ref()
                    .unwrap()
                    .iter()
                    .any(|header| header.name == "Cookie" && header.value == "new-jar")
            );
            assert!(state.interception.routes.is_empty());
            assert!(state.failure.is_none());
        }
    }

    #[test]
    fn preflight_joins_in_either_order_and_fulfills_without_public_request() {
        for pause_first in [false, true] {
            let mut state = state();
            let mut network = network("https://cross.test/resource");
            network["request"]["method"] = json!("OPTIONS");
            network["initiator"] = json!({"type":"preflight"});
            let mut pause = pause("https://cross.test/resource");
            pause["request"]["method"] = json!("OPTIONS");
            pause["request"]["headers"] = json!({"Origin":"https://origin.test","Access-Control-Request-Method":"PUT","Access-Control-Request-Headers":"x-custom"});
            let (first, second) = if pause_first {
                (
                    ("Fetch.requestPaused", &pause),
                    ("Network.requestWillBeSent", &network),
                )
            } else {
                (
                    ("Network.requestWillBeSent", &network),
                    ("Fetch.requestPaused", &pause),
                )
            };
            assert!(state.observe(first.0, first.1).is_empty());
            assert!(state.observe(second.0, second.1).is_empty());
            assert!(state.requests.get("network").is_none());
            assert!(state.active_requests.is_empty());
            let actions = state.interception.take_actions();
            assert_eq!(actions.len(), 1);
            let RoutingCommand::Fulfill(parameters) = &actions[0].command else {
                panic!("preflight must fulfill")
            };
            assert_eq!(parameters.response_code, 204);
            assert_eq!(parameters.response_headers.len(), 4);
            assert_eq!(parameters.response_headers[0].value, "https://origin.test");
            state.observe("Network.loadingFinished", &json!({"requestId":"network"}));
            drop(actions);
            assert_eq!(
                state.interception.budget.bytes.available_permits(),
                PAGE_BYTES
            );
            assert!(state.failure.is_none());
        }
    }

    #[test]
    fn terminal_without_pause_publishes_request_before_failure_and_disable_keeps_ingress_order() {
        let mut state = state();
        state.observe(
            "Network.requestWillBeSent",
            &network("https://example.test/failed"),
        );
        let events = state.observe(
            "Network.loadingFailed",
            &json!({"requestId":"network","errorText":"net::ERR_FAILED"}),
        );
        assert_eq!(
            events.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
            ["request", "requestfailed"]
        );
        let mut first = network("https://example.test/first");
        first["requestId"] = json!("z-first");
        let mut second = network("https://example.test/second");
        second["requestId"] = json!("a-second");
        state.observe("Network.requestWillBeSent", &first);
        state.observe("Network.requestWillBeSent", &second);
        state.interception.enabled = false;
        let events = state.release_interception();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].1["identifier"], "z-first");
        assert_eq!(events[1].1["identifier"], "a-second");
    }

    #[test]
    fn wrong_occurrence_and_duplicate_operations_cannot_take_a_live_route() {
        let mut state = state();
        let identity = joined(&mut state);
        assert!(state.interception.take_route(&identity, "wrong").is_err());
        assert!(
            state
                .interception
                .take_route("network:stale", "network")
                .is_err()
        );
        let owner = state.interception.take_route(&identity, "network").unwrap();
        assert!(state.interception.take_route(&identity, "network").is_err());
        assert_eq!(owner.identity, identity);
    }

    #[test]
    fn continuation_credits_survive_map_removal_without_occupying_input_slots() {
        let mut state = state();
        let identity = joined(&mut state);
        let slots = Arc::new(Semaphore::new(1));
        let input = InputAttachment {
            bytes: Arc::new(vec![0, 255, 128, 0]),
            reservation: slots.clone().try_acquire_owned().unwrap(),
        };
        let body = state.interception.body(&input).unwrap();
        assert!(Arc::ptr_eq(&body.bytes, &input.bytes));
        drop(input);
        assert_eq!(slots.available_permits(), 1);
        drop(continue_request(&mut state, &identity, Some(body)));
        let mut repeated = pause("https://example.test/first");
        repeated["requestId"] = json!("fetch-repeat");
        assert!(state.observe("Fetch.requestPaused", &repeated).is_empty());
        let actions = state.interception.take_actions();
        assert_eq!(actions.len(), 1);
        let RoutingCommand::Continue(parameters) = &actions[0].command else {
            panic!("repeated pause continues")
        };
        assert_eq!(parameters.request_identifier, "fetch-repeat");
        assert_eq!(
            parameters.url.as_deref(),
            Some("https://example.test/override")
        );
        assert_eq!(actions[0].body.as_ref().unwrap().bytes(), [0, 255, 128, 0]);
        state.interception.clear();
        assert!(state.interception.budget.bytes.available_permits() < PAGE_BYTES);
        drop(actions);
        assert_eq!(
            state.interception.budget.bytes.available_permits(),
            PAGE_BYTES
        );
    }

    #[test]
    fn failed_admission_rolls_back_every_credit_and_preserves_the_callback_owner() {
        let engine = Arc::new(EngineRoutingBudget::default());
        let mut state = state();
        state.interception = RequestInterception::new(engine.clone());
        state.interception.enabled = true;
        let identity = joined(&mut state);
        let held = engine
            .bytes
            .clone()
            .try_acquire_many_owned(engine.bytes.available_permits() as u32)
            .unwrap();
        let owner = state.interception.take_route(&identity, "network").unwrap();
        assert!(
            state
                .interception
                .continue_route(
                    owner,
                    ContinueRequest {
                        request_identifier: "fetch".into(),
                        url: None,
                        method: None,
                        headers: None
                    },
                    None,
                    &state.requests.get("network").unwrap().metadata()["headers"],
                )
                .is_err()
        );
        assert!(state.interception.routes.contains_key(&identity));
        drop(held);
        state.interception.clear();
        assert_eq!(engine.bytes.available_permits(), ENGINE_BYTES);
        assert_eq!(engine.owners.available_permits(), ENGINE_OWNERS);
        assert_eq!(
            state.interception.budget.bytes.available_permits(),
            PAGE_BYTES
        );
    }

    #[test]
    fn repeated_pause_admits_expanded_metadata_and_keeps_its_own_credit() {
        let mut state = state();
        let identity = joined(&mut state);
        let owner = state.interception.take_route(&identity, "network").unwrap();
        let parameters = ContinueRequest {
            request_identifier: owner.fetch_identifier.clone(),
            url: None,
            method: None,
            headers: Some(vec![FetchHeader {
                name: "X-Large".into(),
                value: "a".repeat(65536),
            }]),
        };
        let metadata_bytes = encoded_bytes(&serde_json::to_value(&parameters).unwrap());
        drop(
            state
                .interception
                .continue_route(
                    owner,
                    parameters,
                    None,
                    &state.requests.get("network").unwrap().metadata()["headers"],
                )
                .unwrap(),
        );
        let cached_bytes = PAGE_BYTES - state.interception.budget.bytes.available_permits();
        assert!(cached_bytes >= metadata_bytes);
        let mut repeated = pause("https://example.test/first");
        repeated["requestId"] = json!("fetch-repeat");
        assert!(state.observe("Fetch.requestPaused", &repeated).is_empty());
        let actions = state.interception.take_actions();
        assert_eq!(actions.len(), 1);
        assert!(
            PAGE_BYTES - state.interception.budget.bytes.available_permits()
                >= cached_bytes + metadata_bytes
        );
        drop(actions);
        assert_eq!(
            PAGE_BYTES - state.interception.budget.bytes.available_permits(),
            cached_bytes
        );
        state.interception.clear();
        assert_eq!(
            state.interception.budget.bytes.available_permits(),
            PAGE_BYTES
        );
    }

    #[tokio::test]
    async fn body_writer_keeps_route_credit_after_registry_and_caller_disappear() {
        let mut state = state();
        let identity = joined(&mut state);
        let slots = Arc::new(Semaphore::new(1));
        let input = InputAttachment {
            bytes: Arc::new(vec![0x80; 65537]),
            reservation: slots.clone().try_acquire_owned().unwrap(),
        };
        let body = state.interception.body(&input).unwrap();
        drop(input);
        let action = continue_request(&mut state, &identity, Some(body));
        let (host, mut peer) = tokio::io::duplex(64);
        let (reader, writer) = tokio::io::split(host);
        let connection = Connection::new(reader, writer);
        let command = action.start(&connection, "original-session").unwrap();
        let mut first = [0];
        timeout(Duration::from_secs(2), peer.read_exact(&mut first))
            .await
            .unwrap()
            .unwrap();
        drop(command);
        drop(action);
        state.interception.clear();
        assert_eq!(slots.available_permits(), 1);
        assert!(state.interception.budget.bytes.available_permits() < PAGE_BYTES);
        let mut message = vec![first[0]];
        timeout(
            Duration::from_secs(2),
            BufReader::new(&mut peer).read_until(0, &mut message),
        )
        .await
        .unwrap()
        .unwrap();
        let message: Value = serde_json::from_slice(&message[..message.len() - 1]).unwrap();
        assert_eq!(message["method"], "Fetch.continueRequest");
        assert_eq!(
            message["params"]["postData"],
            flashwright_protocol::attachment::encode_base64(&vec![0x80; 65537])
        );
        for _ in 0..20 {
            if state.interception.budget.bytes.available_permits() == PAGE_BYTES {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            state.interception.budget.bytes.available_permits(),
            PAGE_BYTES
        );
        connection.close();
    }
}
