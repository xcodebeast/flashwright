//! One ordered browser-event group supplies public lifecycle and optional recording observers.

use std::time::Instant;

use serde_json::{Value, json};

use crate::network_request::RequestState;
use crate::network_state::HeaderKind;

#[derive(Clone, Copy, Debug)]
pub(crate) struct NetworkIngress {
    pub sequence: u64,
    pub received_at: Instant,
}

#[derive(Clone, Copy)]
pub(crate) struct NetworkEvent<'event> {
    pub method: &'event str,
    pub parameters: &'event Value,
    pub ingress: NetworkIngress,
}

#[derive(Clone, Copy)]
pub(crate) enum NetworkTransition<'state> {
    Created(&'state RequestState),
    Ready(&'state RequestState),
    Routed(&'state RequestState),
    Responded(&'state RequestState),
    Completed(&'state RequestState),
    Retired(&'state RequestState),
    Cached(&'state RequestState),
    ExtraInfo {
        identifier: &'state str,
        kind: HeaderKind,
    },
    DiscardedExtra {
        kind: HeaderKind,
        ingress: NetworkIngress,
    },
    Headers {
        identity: &'state str,
        kind: HeaderKind,
        headers: &'state Value,
        ingress: NetworkIngress,
    },
}

/// Implementations admit bounded immutable data synchronously and own their failures separately.
/// The caller keeps one recording lock across the complete event group, never one lock per transition.
pub(crate) trait NetworkObserver {
    fn created(
        &mut self,
        event: &NetworkEvent<'_>,
        request: &RequestState,
        original: &Value,
        predecessor: Option<&str>,
        original_sequence: u64,
        received_at: Instant,
    );
    /// Public metadata is complete after any Network/Fetch join; original ingress is unchanged.
    fn ready(&mut self, _event: &NetworkEvent<'_>, _request: &RequestState) {}
    fn routed(&mut self, _event: &NetworkEvent<'_>, _request: &RequestState) {}
    fn responded(&mut self, event: &NetworkEvent<'_>, request: &RequestState);
    fn completed(&mut self, event: &NetworkEvent<'_>, request: &RequestState);
    fn retired(&mut self, event: &NetworkEvent<'_>, request: &RequestState);
    fn cached(&mut self, event: &NetworkEvent<'_>, request: &RequestState);
    fn extra_info(&mut self, event: &NetworkEvent<'_>, identifier: &str, kind: HeaderKind);
    fn discarded_extra(
        &mut self,
        event: &NetworkEvent<'_>,
        kind: HeaderKind,
        ingress: NetworkIngress,
    );
    fn headers(
        &mut self,
        event: &NetworkEvent<'_>,
        identity: &str,
        kind: HeaderKind,
        headers: &Value,
        ingress: NetworkIngress,
    );
}

pub(crate) struct NetworkObservation<'observer, 'event> {
    pub event: NetworkEvent<'event>,
    observer: Option<&'observer mut dyn NetworkObserver>,
}

impl<'observer, 'event> NetworkObservation<'observer, 'event> {
    pub(crate) fn new(
        event: NetworkEvent<'event>,
        observer: &'observer mut dyn NetworkObserver,
    ) -> Self {
        Self {
            event,
            observer: Some(observer),
        }
    }

    pub(crate) fn emit(&mut self, transition: NetworkTransition<'_>) {
        if let Some(observer) = self.observer.as_mut() {
            match transition {
                NetworkTransition::Created(request) => {
                    let ingress = request.ingress();
                    observer.created(
                        &self.event,
                        request,
                        request.original_metadata(),
                        request.predecessor(),
                        ingress.sequence,
                        ingress.received_at,
                    );
                }
                NetworkTransition::Ready(request) => observer.ready(&self.event, request),
                NetworkTransition::Routed(request) => observer.routed(&self.event, request),
                NetworkTransition::Responded(request) => observer.responded(&self.event, request),
                NetworkTransition::Completed(request) => observer.completed(&self.event, request),
                NetworkTransition::Retired(request) => observer.retired(&self.event, request),
                NetworkTransition::Cached(request) => observer.cached(&self.event, request),
                NetworkTransition::ExtraInfo { identifier, kind } => {
                    observer.extra_info(&self.event, identifier, kind)
                }
                NetworkTransition::DiscardedExtra { kind, ingress } => {
                    observer.discarded_extra(&self.event, kind, ingress)
                }
                NetworkTransition::Headers {
                    identity,
                    kind,
                    headers,
                    ingress,
                } => observer.headers(&self.event, identity, kind, headers, ingress),
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn ignored() -> Self {
        Self {
            event: NetworkEvent {
                method: "",
                parameters: &Value::Null,
                ingress: NetworkIngress {
                    sequence: 0,
                    received_at: Instant::now(),
                },
            },
            observer: None,
        }
    }
}

/// Recording sees the same accepted transitions before their public projection is copied.
pub(crate) struct PublicNetworkEvents<'observer> {
    pub events: Vec<(&'static str, Value)>,
    pub observer: Option<&'observer mut dyn NetworkObserver>,
}

impl NetworkObserver for PublicNetworkEvents<'_> {
    fn created(
        &mut self,
        event: &NetworkEvent<'_>,
        request: &RequestState,
        original: &Value,
        predecessor: Option<&str>,
        original_sequence: u64,
        received_at: Instant,
    ) {
        if let Some(observer) = self.observer.as_mut() {
            observer.created(
                event,
                request,
                original,
                predecessor,
                original_sequence,
                received_at,
            );
        }
    }
    fn ready(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        if let Some(observer) = self.observer.as_mut() {
            observer.ready(event, request);
        }
        self.events.push(("request", request.metadata().clone()));
    }
    fn routed(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        if let Some(observer) = self.observer.as_mut() {
            observer.routed(event, request);
        }
        self.events.push(("route", request.reference()));
    }
    fn responded(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        if let Some(observer) = self.observer.as_mut() {
            observer.responded(event, request);
        }
        if let Some(response) = &request.response {
            self.events.push(("response", response.clone()));
        }
    }
    fn completed(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        if let Some(observer) = self.observer.as_mut() {
            observer.completed(event, request);
        }
        if let Some(failure) = &request.failure {
            self.events.push((
                "requestfailed",
                json!({ "request": request.reference(), "errorText": failure }),
            ));
        } else {
            let mut reference = request.reference();
            if request.redirecting {
                reference["redirecting"] = json!(true);
            }
            self.events.push(("requestfinished", reference));
        }
    }
    fn retired(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        if let Some(observer) = self.observer.as_mut() {
            observer.retired(event, request);
        }
    }
    fn cached(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        if let Some(observer) = self.observer.as_mut() {
            observer.cached(event, request);
        }
    }
    fn extra_info(&mut self, event: &NetworkEvent<'_>, identifier: &str, kind: HeaderKind) {
        if let Some(observer) = self.observer.as_mut() {
            observer.extra_info(event, identifier, kind);
        }
    }
    fn discarded_extra(
        &mut self,
        event: &NetworkEvent<'_>,
        kind: HeaderKind,
        ingress: NetworkIngress,
    ) {
        if let Some(observer) = self.observer.as_mut() {
            observer.discarded_extra(event, kind, ingress);
        }
    }
    fn headers(
        &mut self,
        event: &NetworkEvent<'_>,
        identity: &str,
        kind: HeaderKind,
        headers: &Value,
        ingress: NetworkIngress,
    ) {
        if let Some(observer) = self.observer.as_mut() {
            observer.headers(event, identity, kind, headers, ingress);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_state::{NetworkRequests, encoded_bytes};
    use crate::page_state::DocumentState;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    /// A bounded recording stand-in exercises ownership without installing a recording endpoint.
    struct Recording {
        events: Vec<Value>,
        starts: HashMap<String, (u64, Instant)>,
        extra: HashMap<u64, Value>,
        maximum_bytes: usize,
        bytes: usize,
        failed: bool,
    }

    impl Recording {
        fn new(maximum_bytes: usize) -> Self {
            Self {
                events: Vec::new(),
                starts: HashMap::new(),
                extra: HashMap::new(),
                maximum_bytes,
                bytes: 0,
                failed: false,
            }
        }
        fn admit(&mut self, value: &Value) -> bool {
            if self.failed {
                return false;
            }
            let bytes = encoded_bytes(value);
            if self.bytes + bytes > self.maximum_bytes {
                self.failed = true;
                self.events.clear();
                self.starts.clear();
                self.extra.clear();
                self.bytes = 0;
                return false;
            }
            self.bytes += bytes;
            true
        }
        fn record(
            &mut self,
            event: &NetworkEvent<'_>,
            kind: &str,
            request: &RequestState,
            predecessor: Option<&str>,
        ) {
            let value = json!({"group":event.ingress.sequence, "kind":kind, "identity":request.identity(), "original":request.original_metadata()["url"], "effective":request.metadata()["url"], "finished":request.finished, "failure":request.failure, "predecessor":predecessor});
            if self.admit(&value) {
                self.events.push(value);
            }
        }
    }

    impl NetworkObserver for Recording {
        fn created(
            &mut self,
            event: &NetworkEvent<'_>,
            request: &RequestState,
            original: &Value,
            predecessor: Option<&str>,
            original_sequence: u64,
            received_at: Instant,
        ) {
            assert_eq!(original, request.original_metadata());
            self.record(event, "created", request, predecessor);
            if !self.failed {
                self.starts
                    .insert(request.identity().into(), (original_sequence, received_at));
            }
        }
        fn responded(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
            self.record(event, "responded", request, None);
        }
        fn completed(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
            self.record(event, "completed", request, None);
        }
        fn retired(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
            self.record(event, "retired", request, None);
        }
        fn cached(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
            self.record(event, "cached", request, None);
        }
        fn extra_info(&mut self, event: &NetworkEvent<'_>, _identifier: &str, _kind: HeaderKind) {
            if self.admit(event.parameters) {
                self.extra
                    .insert(event.ingress.sequence, event.parameters.clone());
            }
        }
        fn discarded_extra(
            &mut self,
            _event: &NetworkEvent<'_>,
            _kind: HeaderKind,
            ingress: NetworkIngress,
        ) {
            if let Some(metadata) = self.extra.remove(&ingress.sequence) {
                self.bytes -= encoded_bytes(&metadata);
            }
        }
        fn headers(
            &mut self,
            event: &NetworkEvent<'_>,
            identity: &str,
            kind: HeaderKind,
            headers: &Value,
            ingress: NetworkIngress,
        ) {
            if self.failed {
                return;
            }
            let metadata = self
                .extra
                .remove(&ingress.sequence)
                .expect("raw observation precedes pairing");
            self.bytes -= encoded_bytes(&metadata);
            let value = json!({"group":event.ingress.sequence, "kind":"headers", "identity":identity, "headerKind":match kind {HeaderKind::Request=>"request",HeaderKind::Response=>"response"}, "sourceGroup":ingress.sequence, "headers":headers, "metadata":metadata});
            if self.admit(&value) {
                self.events.push(value);
            }
        }
    }

    fn request(identifier: &str, url: &str) -> Value {
        json!({"requestId":identifier, "type":"Fetch", "frameId":"frame", "loaderId":"loader", "request":{"url":url,"method":"GET","headers":{}}})
    }

    fn observe(
        state: &mut DocumentState,
        recording: Option<&mut Recording>,
        sequence: u64,
        received_at: Instant,
        method: &str,
        parameters: &Value,
    ) -> Vec<(&'static str, Value)> {
        state.observe_event(
            NetworkEvent {
                method,
                parameters,
                ingress: NetworkIngress {
                    sequence,
                    received_at,
                },
            },
            recording.map(|recording| recording as &mut dyn NetworkObserver),
        )
    }

    #[test]
    fn redirect_group_preserves_original_ingress_and_predecessor_before_successor() {
        let mut state = DocumentState::default();
        let mut recording = Recording::new(1024 * 1024);
        let first_time = Instant::now();
        observe(
            &mut state,
            Some(&mut recording),
            10,
            first_time,
            "Network.requestWillBeSent",
            &request("shared", "https://example.test/original"),
        );
        let first_identity = state.requests.get("shared").unwrap().identity().to_owned();
        let mut effective = state.requests.get("shared").unwrap().metadata().clone();
        effective["url"] = json!("https://example.test/effective");
        state.requests.get_mut("shared").unwrap().effective_metadata = Some(effective);
        let second_time = first_time + std::time::Duration::from_millis(5);
        let mut successor = request("shared", "https://example.test/successor");
        successor["redirectResponse"] = json!({"url":"https://example.test/effective","status":302,"headers":{"location":"/successor"}});
        let public = observe(
            &mut state,
            Some(&mut recording),
            20,
            second_time,
            "Network.requestWillBeSent",
            &successor,
        );
        assert_eq!(
            public.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
            ["response", "requestfinished", "request"]
        );
        let second_identity = state.requests.get("shared").unwrap().identity().to_owned();
        let group: Vec<_> = recording
            .events
            .iter()
            .filter(|event| event["group"] == 20)
            .collect();
        assert_eq!(
            group
                .iter()
                .map(|event| event["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["responded", "completed", "created"]
        );
        assert_eq!(group[0]["identity"], first_identity);
        assert_eq!(group[1]["identity"], first_identity);
        assert_eq!(group[1]["finished"], true);
        assert_eq!(group[0]["original"], "https://example.test/original");
        assert_eq!(group[0]["effective"], "https://example.test/effective");
        assert_eq!(group[2]["predecessor"], first_identity);
        assert_eq!(group[2]["identity"], second_identity);
        assert_eq!(recording.starts[&first_identity], (10, first_time));
        assert_eq!(recording.starts[&second_identity], (20, second_time));
    }

    #[test]
    fn late_headers_bind_original_ingress_after_public_history_expiry() {
        let mut state = DocumentState::default();
        let mut recording = Recording::new(2 * 1024 * 1024);
        let time = Instant::now();
        observe(
            &mut state,
            Some(&mut recording),
            10,
            time,
            "Network.requestWillBeSent",
            &request("shared", "https://example.test/first"),
        );
        let first = state.requests.get("shared").unwrap().identity().to_owned();
        // First request headers precede the redirect response that establishes their target.
        observe(
            &mut state,
            Some(&mut recording),
            11,
            time,
            "Network.requestWillBeSentExtraInfo",
            &json!({"requestId":"shared","headers":{"Hop":"first"},"associatedCookies":[{"cookie":{"name":"owned"}}]}),
        );
        let mut successor = request("shared", "https://example.test/second");
        successor["redirectResponse"] =
            json!({"url":"https://example.test/first","status":302,"headers":{}});
        successor["redirectHasExtraInfo"] = json!(true);
        observe(
            &mut state,
            Some(&mut recording),
            20,
            time,
            "Network.requestWillBeSent",
            &successor,
        );
        let second = state.requests.get("shared").unwrap().identity().to_owned();
        observe(
            &mut state,
            Some(&mut recording),
            30,
            time,
            "Network.responseReceived",
            &json!({"requestId":"shared","response":{"url":"https://example.test/second","status":200,"headers":{}},"hasExtraInfo":true}),
        );
        observe(
            &mut state,
            Some(&mut recording),
            31,
            time,
            "Network.loadingFinished",
            &json!({"requestId":"shared"}),
        );
        for index in 0..1030 {
            let identifier = format!("later-{index}");
            observe(
                &mut state,
                Some(&mut recording),
                100 + index * 2,
                time,
                "Network.requestWillBeSent",
                &request(&identifier, "https://example.test/later"),
            );
            observe(
                &mut state,
                Some(&mut recording),
                101 + index * 2,
                time,
                "Network.loadingFinished",
                &json!({"requestId":identifier}),
            );
        }
        assert!(state.requests.headers(&first, HeaderKind::Request).is_err());
        assert!(
            state
                .requests
                .headers(&second, HeaderKind::Response)
                .is_err()
        );
        for (sequence, method, headers, extra) in [
            (
                4000,
                "Network.responseReceivedExtraInfo",
                json!({"Hop":"first"}),
                json!({"statusCode":302}),
            ),
            (
                4001,
                "Network.requestWillBeSentExtraInfo",
                json!({"Hop":"second"}),
                json!({"associatedCookies":[]}),
            ),
            (
                4002,
                "Network.responseReceivedExtraInfo",
                json!({"Hop":"second"}),
                json!({"statusCode":200}),
            ),
        ] {
            let mut parameters = extra;
            parameters["requestId"] = json!("shared");
            parameters["headers"] = headers;
            assert!(
                observe(
                    &mut state,
                    Some(&mut recording),
                    sequence,
                    time,
                    method,
                    &parameters
                )
                .is_empty()
            );
        }
        assert!(state.failure.is_none());
        assert!(!recording.failed);
        assert!(recording.extra.is_empty());
        let headers: Vec<_> = recording
            .events
            .iter()
            .filter(|event| event["kind"] == "headers")
            .collect();
        assert_eq!(headers.len(), 4);
        assert_eq!(headers[0]["identity"], first);
        assert_eq!(headers[0]["sourceGroup"], 11);
        assert_eq!(headers[0]["group"], 20);
        assert_eq!(
            headers[0]["metadata"]["associatedCookies"][0]["cookie"]["name"],
            "owned"
        );
        assert_eq!(headers[1]["identity"], first);
        assert_eq!(headers[1]["metadata"]["statusCode"], 302);
        assert_eq!(headers[2]["identity"], second);
        assert_eq!(headers[3]["identity"], second);
        assert_eq!(headers[3]["metadata"]["statusCode"], 200);
    }

    #[test]
    fn recording_overflow_cannot_change_public_events_or_network_admission() {
        let mut recorded = DocumentState::default();
        let mut plain = DocumentState::default();
        let recorded_budget = Arc::new(Semaphore::new(4096));
        let plain_budget = Arc::new(Semaphore::new(4096));
        recorded.requests = NetworkRequests::new(recorded_budget.clone());
        plain.requests = NetworkRequests::new(plain_budget.clone());
        let mut recording = Recording::new(4096);
        let time = Instant::now();
        for (index, (method, parameters)) in [
            ("Network.requestWillBeSent", request("owner", "https://example.test/")),
            ("Network.requestWillBeSentExtraInfo", json!({"requestId":"owner", "headers":{"Exact":"value"}, "diagnostic":"x".repeat(8192)})),
            ("Network.responseReceived", json!({"requestId":"owner", "response":{"status":200,"headers":{}},"hasExtraInfo":true})),
            ("Network.responseReceivedExtraInfo", json!({"requestId":"owner", "headers":{"Exact":"response"}})),
            ("Network.loadingFinished", json!({"requestId":"owner"})),
        ].iter().enumerate() {
            assert_eq!(observe(&mut recorded, Some(&mut recording), index as u64, time, method, parameters), observe(&mut plain, None, index as u64, time, method, parameters));
            assert!(recorded.failure.is_none()); assert!(plain.failure.is_none());
            assert_eq!(recorded_budget.available_permits(), plain_budget.available_permits());
        }
        assert!(recording.failed);
        assert!(recording.events.is_empty());
        assert!(recording.extra.is_empty());
        let identity = recorded.requests.get("owner").unwrap().identity();
        assert_eq!(
            recorded
                .requests
                .headers(identity, HeaderKind::Request)
                .unwrap()
                .unwrap()[0]["value"],
            "value"
        );
    }

    #[test]
    fn cache_retirement_and_failure_keep_exact_owners_without_public_duplicates() {
        let mut state = DocumentState::default();
        let mut recording = Recording::new(16384);
        let time = Instant::now();
        observe(
            &mut state,
            Some(&mut recording),
            1,
            time,
            "Network.requestWillBeSent",
            &request("shared", "https://example.test/retired"),
        );
        let retired = state.requests.get("shared").unwrap().identity().to_owned();
        let public = observe(
            &mut state,
            Some(&mut recording),
            2,
            time,
            "Network.requestWillBeSent",
            &request("shared", "https://example.test/current"),
        );
        assert_eq!(public.len(), 1);
        assert_eq!(public[0].0, "request");
        let current = state.requests.get("shared").unwrap().identity().to_owned();
        observe(
            &mut state,
            Some(&mut recording),
            3,
            time,
            "Network.requestServedFromCache",
            &json!({"requestId":"shared"}),
        );
        let public = observe(
            &mut state,
            Some(&mut recording),
            4,
            time,
            "Network.loadingFailed",
            &json!({"requestId":"shared","errorText":"net::ERR_FAILED"}),
        );
        assert_eq!(public.len(), 1);
        assert_eq!(public[0].0, "requestfailed");
        assert_eq!(
            recording
                .events
                .iter()
                .map(|event| event["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["created", "retired", "created", "cached", "completed"]
        );
        assert_eq!(recording.events[1]["identity"], retired);
        assert_eq!(recording.events[1]["finished"], true);
        assert!(recording.events[2]["predecessor"].is_null());
        assert_eq!(recording.events[3]["identity"], current);
        assert_eq!(recording.events[4]["identity"], current);
    }

    #[test]
    fn ignored_requests_and_terminal_leftovers_discard_exact_extra_info_keys() {
        let mut state = DocumentState::default();
        let mut recording = Recording::new(16384);
        let time = Instant::now();
        observe(
            &mut state,
            Some(&mut recording),
            1,
            time,
            "Network.requestWillBeSentExtraInfo",
            &json!({"requestId":"icon", "headers":{"Cookie":"private"}}),
        );
        assert!(recording.extra.contains_key(&1));
        let public = observe(
            &mut state,
            Some(&mut recording),
            2,
            time,
            "Network.requestWillBeSent",
            &request("icon", "https://example.test/favicon.ico"),
        );
        assert!(public.is_empty());
        assert!(recording.extra.is_empty());
        observe(
            &mut state,
            Some(&mut recording),
            3,
            time,
            "Network.requestWillBeSent",
            &request("failed", "https://example.test/failed"),
        );
        observe(
            &mut state,
            Some(&mut recording),
            4,
            time,
            "Network.requestWillBeSentExtraInfo",
            &json!({"requestId":"failed", "headers":{"Cookie":"request"}}),
        );
        observe(
            &mut state,
            Some(&mut recording),
            5,
            time,
            "Network.responseReceivedExtraInfo",
            &json!({"requestId":"failed", "headers":{"Set-Cookie":"response"}}),
        );
        assert_eq!(recording.extra.len(), 2);
        let public = observe(
            &mut state,
            Some(&mut recording),
            6,
            time,
            "Network.loadingFailed",
            &json!({"requestId":"failed", "errorText":"net::ERR_FAILED"}),
        );
        assert_eq!(public.len(), 1);
        assert_eq!(public[0].0, "requestfailed");
        assert!(recording.extra.is_empty());
        assert!(!recording.failed);
        assert!(state.failure.is_none());
    }
}
