//! Recording-scoped request versions and resources share the canonical browser-event lock.

mod journal;
mod observer;
mod ownership;
mod resources;
mod worker;

use crate::network_observer::NetworkEvent;
use crate::page_state::DocumentState;
use flashwright_protocol::{ErrorCode, ErrorRecord};
use journal::{
    BodyOutcome, BodyUnavailable, BodyWork, JournalBudget, JournalError, JournalLimits,
    NetworkJournal, NetworkPrefix, Occurrence,
};
use ownership::{BodyGuard, BodyOwners};
use resources::NetworkResources;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

pub(crate) use resources::NetworkBudget;
pub(super) use worker::BodyJob;

struct RawExtra {
    value: Value,
    _reservation: journal::Reservation,
}

pub(super) struct NetworkRecording {
    epoch: Instant,
    journal: NetworkJournal,
    budget: Arc<JournalBudget>,
    engine: Arc<NetworkBudget>,
    resources: NetworkResources,
    owners: BodyOwners,
    extras: HashMap<(String, u8, u64), RawExtra>,
    closed: watch::Sender<bool>,
}

pub(super) struct SealedNetwork {
    prefix: NetworkPrefix,
}

fn recording_error(error: JournalError) -> ErrorRecord {
    let (code, message) = match error {
        JournalError::ResourceLimit(message) => (ErrorCode::ResourceLimit, message),
        JournalError::Protocol(message) => (ErrorCode::Protocol, message),
    };
    ErrorRecord::new(code, "tracing.network", message)
}

fn native_time(epoch: Instant, instant: Instant) -> f64 {
    if instant >= epoch {
        instant.duration_since(epoch).as_secs_f64() * 1000.0
    } else {
        -epoch.duration_since(instant).as_secs_f64() * 1000.0
    }
}

fn wall_time() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

impl NetworkRecording {
    pub(super) fn new(epoch: Instant, engine: Arc<NetworkBudget>) -> Self {
        let budget = JournalBudget::recording(64 * 1024 * 1024, engine.metadata.clone());
        Self {
            epoch,
            journal: NetworkJournal::new(
                JournalLimits::default(),
                budget.clone(),
                engine.pending.clone(),
            ),
            resources: NetworkResources::new(&engine, budget.clone()),
            budget,
            engine,
            owners: BodyOwners::default(),
            extras: HashMap::new(),
            closed: watch::channel(false).0,
        }
    }

    /// Closing admission does not cancel a dispatched CDP command or release its byte custody.
    pub(super) fn close(&mut self) {
        self.closed.send_replace(true);
        self.extras.clear();
    }

    fn fail(&mut self, error: JournalError) {
        self.journal.fail(error);
        self.close();
        self.resources.clear();
    }

    pub(super) fn pending(&self) -> bool {
        self.journal.body_work_pending() || self.resources.pending()
    }

    pub(super) fn page_closed(&mut self, page: &str) {
        self.owners.page_closed(page);
    }

    pub(super) fn seal(&mut self) -> Result<SealedNetwork, ErrorRecord> {
        self.journal
            .seal()
            .map(|prefix| SealedNetwork { prefix })
            .map_err(recording_error)
    }

    pub(super) fn observe_group(
        &mut self,
        page: &str,
        state: &mut DocumentState,
        event: NetworkEvent<'_>,
    ) -> (Vec<(&'static str, Value)>, Vec<BodyJob>) {
        if event.method == "Network.requestWillBeSent"
            && let Some(identifier) = event.parameters["requestId"].as_str()
        {
            self.owners.request_started(page, identifier);
        }
        if *self.closed.borrow() {
            return (state.observe_event(event, None), Vec::new());
        }
        let mut observer = observer::RecordingObserver::new(self, page);
        let events = state.observe_event(event, Some(&mut observer));
        let jobs = observer.finish();
        (events, jobs)
    }
}

impl SealedNetwork {
    /// A caller retries this same version until its pre-admitted body settles; membership never grows.
    fn entry(&self, index: usize) -> Result<Value, ErrorRecord> {
        let Some(version) = self.prefix.versions.get(index) else {
            return Ok(json!({"done":true,"count":self.prefix.versions.len()}));
        };
        let body = match &version.body {
            Some(capture) => match capture.result() {
                Some(Ok(outcome)) => serde_json::to_value(outcome).expect("body outcome is JSON"),
                Some(Err(error)) => return Err(recording_error(error.clone())),
                None => return Ok(json!({"ready":false,"index":index})),
            },
            None => json!({"kind":"pending"}),
        };
        let metadata: Value = serde_json::from_slice(version.metadata()).map_err(|_| {
            recording_error(JournalError::Protocol("sealed network metadata is invalid"))
        })?;
        if metadata["page"] != version.occurrence.page
            || metadata["identity"] != version.occurrence.identity
        {
            return Err(recording_error(JournalError::Protocol(
                "sealed network occurrence does not match metadata",
            )));
        }
        Ok(json!({"ready":true,"done":false,"index":index,"metadata":metadata,"body":body}))
    }
}

fn journal_error(error: &ErrorRecord) -> JournalError {
    if error.code == ErrorCode::ResourceLimit {
        JournalError::ResourceLimit("network recording resource allowance failed")
    } else {
        JournalError::Protocol("network recording failed")
    }
}

impl NetworkRecording {
    pub(super) fn recording_failed(&mut self, error: &ErrorRecord) {
        self.fail(journal_error(error));
    }

    /// Retirement discards unexported bytes while actual transfers retain their independent reservations.
    pub(super) fn retire(&mut self) {
        self.close();
        self.resources.clear();
    }
}

impl super::TraceRecording {
    pub(crate) fn observe_page_event(
        &mut self,
        page: &str,
        state: &mut DocumentState,
        event: NetworkEvent<'_>,
    ) -> (Vec<(&'static str, Value)>, Vec<BodyJob>) {
        let result = if let Some(network) = self.network.as_mut() {
            network.observe_group(page, state, event)
        } else {
            (state.observe_event(event, None), Vec::new())
        };
        if let Some(error) = self
            .network
            .as_ref()
            .and_then(|network| network.journal.failure())
            .cloned()
        {
            self.fail(recording_error(error));
        }
        self.observed_group(event.ingress.sequence);
        result
    }

    pub(crate) fn network_page_closed(&mut self, page: &str) {
        if let Some(network) = self.network.as_mut() {
            network.page_closed(page);
        }
    }
}

impl crate::Engine {
    pub(crate) fn network_trace_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &crate::Operation,
    ) -> Result<Value, ErrorRecord> {
        use crate::{identifier, invalid, validate_keys};
        operation.check()?;
        let fields: &[&str] = match method {
            "context.trace.network.entry" => &["context", "recording", "chunk", "index"],
            "context.trace.network.ingested" => &["context", "recording", "token"],
            _ => &["context", "recording"],
        };
        validate_keys(method, parameters, fields)?;
        let context = self.context(identifier(parameters, "context", method)?, method)?;
        let identity = identifier(parameters, "recording", method)?;
        let mut owner = context.state.recording.lock().unwrap();
        let recording = owner.get_mut(identity)?;
        if let Some(error) = &recording.failure {
            return Err(error.clone());
        }
        if method.ends_with(".entry") {
            let chunk = identifier(parameters, "chunk", method)?;
            let index = parameters["index"]
                .as_u64()
                .and_then(|index| usize::try_from(index).ok())
                .ok_or_else(|| invalid(method, "index must be a nonnegative integer"))?;
            let chunk = recording.original_chunk(chunk)?;
            if chunk.cutoff.is_none() {
                return Err(invalid(
                    method,
                    "network entry requires the original sealed chunk",
                ));
            }
            return chunk
                .network
                .as_ref()
                .ok_or_else(|| invalid(method, "network recording is disabled"))?
                .entry(index);
        }
        let network = recording
            .network
            .as_mut()
            .ok_or_else(|| invalid(method, "network recording is disabled"))?;
        if method.ends_with(".ingested") {
            network
                .resources
                .ingested(identifier(parameters, "token", method)?)
                .map_err(recording_error)?;
            Ok(Value::Null)
        } else {
            Ok(
                json!({"recording":identity,"resources":network.resources.pull(),"pending":network.pending()}),
            )
        }
    }

    pub(crate) async fn take_network_resource(
        &self,
        parameters: Value,
        operation: &crate::Operation,
    ) -> Result<Option<flashwright_protocol::BinaryAttachment>, ErrorRecord> {
        use crate::{identifier, invalid, validate_keys};
        let method = "context.trace.network.take";
        validate_keys(method, &parameters, &["context", "recording", "token"])?;
        let context = self.context(identifier(&parameters, "context", method)?, method)?;
        let identity = identifier(&parameters, "recording", method)?;
        let token = identifier(&parameters, "token", method)?;
        operation.check()?;
        let mut owner = context.state.recording.lock().unwrap();
        let recording = owner.get_mut(identity)?;
        if let Some(error) = &recording.failure {
            return Err(error.clone());
        }
        let network = recording
            .network
            .as_mut()
            .ok_or_else(|| invalid(method, "network recording is disabled"))?;
        network
            .resources
            .validate_take(token, self.maximum_attachment_bytes)
            .map_err(recording_error)?;
        let Some(reservation) = self.try_trace_attachment(method)? else {
            return Ok(None);
        };
        network
            .resources
            .take(token, reservation, self.maximum_attachment_bytes)
            .map(Some)
            .map_err(recording_error)
    }
}

impl super::TraceRecording {
    pub(crate) fn network_route_decision(
        &mut self,
        page: &str,
        identity: &str,
        command: &crate::routing_state::RoutingCommand,
        fallback: bool,
    ) {
        use crate::routing_state::RoutingCommand;
        let Some(network) = self.network.as_mut() else {
            return;
        };
        if *network.closed.borrow() {
            return;
        }
        let occurrence = Occurrence {
            page: page.into(),
            identity: identity.into(),
        };
        if !network.journal.contains(&occurrence) {
            return;
        }
        let result = network.journal.update(&occurrence, |metadata| {
            metadata["routeDecided"] = json!(true);
            match command {
                RoutingCommand::Continue(parameters) => {
                    if !fallback {
                        metadata["routing"]["continued"] = json!(true);
                    }
                    if let Some(url) = &parameters.url {
                        metadata["effectiveRequest"]["url"] = json!(url);
                    }
                    if let Some(method) = &parameters.method {
                        metadata["effectiveRequest"]["method"] = json!(method);
                    }
                    if let Some(headers) = &parameters.headers {
                        metadata["requestHeaders"] =
                            serde_json::to_value(headers).expect("typed routing headers are JSON");
                        metadata["requestHeadersReady"] = json!(true);
                        metadata["interceptionHeaders"] = json!(true);
                    }
                }
                RoutingCommand::Fulfill(_) => metadata["routing"]["fulfilled"] = json!(true),
                RoutingCommand::Abort { .. } => metadata["routing"]["aborted"] = json!(true),
            }
        });
        if let Err(error) = result {
            self.fail(recording_error(error));
        }
    }

    /// Publishing pending requests on routing disable is command-side work, not a new browser sequence.
    pub(crate) fn release_network_interception(
        &mut self,
        page: &str,
        state: &mut DocumentState,
    ) -> Vec<(&'static str, Value)> {
        let Some(network) = self.network.as_mut() else {
            return state.release_interception(None);
        };
        if *network.closed.borrow() {
            return state.release_interception(None);
        }
        let mut observer = observer::RecordingObserver::new(network, page);
        let events = state.release_interception(Some(&mut observer));
        let jobs = observer.finish();
        debug_assert!(
            jobs.is_empty(),
            "routing disable only publishes pending requests"
        );
        if let Some(error) = self
            .network
            .as_ref()
            .and_then(|network| network.journal.failure())
            .cloned()
        {
            self.fail(recording_error(error));
        }
        events
    }
}

#[cfg(test)]
mod collection_tests {
    use super::*;

    #[tokio::test]
    async fn attachment_pressure_never_waits_or_consumes_an_original_network_resource() {
        let (outgoing, _messages) = tokio::sync::mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let mut engine = crate::Engine::new(
            None,
            outgoing,
            fatal,
            flashwright_protocol::ResourceLimits::default(),
        );
        let context = Arc::new(crate::context_state::ContextState::default());
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            crate::Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: crate::devices::DeviceOptions::default(),
                settings: crate::context_settings::ContextSettings::parse(&json!({})).unwrap(),
                state: context.clone(),
                published: true,
            },
        );
        let cancellation = watch::channel(false).0;
        let operation =
            crate::Operation::new("collection-probe".into(), None, cancellation.subscribe());
        engine
            .recording_control(
                "context.trace.recording.start",
                &json!({"context":"context","recording":"recording","network":true}),
                &operation,
            )
            .unwrap();
        let token = {
            let mut state = context.recording.lock().unwrap();
            state
                .get_mut("recording")
                .unwrap()
                .network
                .as_mut()
                .unwrap()
                .resources
                .request(&json!(["YQ=="]), false)
                .unwrap()
                .unwrap()
                .token
        };
        let identity = json!({"context":"context","recording":"recording","token":token});
        let held = engine
            .attachment_slots
            .clone()
            .try_acquire_many_owned(2)
            .unwrap();
        assert!(
            engine
                .take_network_resource(identity.clone(), &operation)
                .await
                .is_err(),
            "unannounced resources must fail even under pressure"
        );
        engine
            .network_trace_control(
                "context.trace.network.pull",
                &json!({"context":"context","recording":"recording"}),
                &operation,
            )
            .unwrap();
        for _ in 0..3 {
            assert!(
                engine
                    .take_network_resource(identity.clone(), &operation)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let mut stale = identity.clone();
        stale["token"] = json!("unknown-original");
        assert!(
            engine
                .take_network_resource(stale, &operation)
                .await
                .is_err()
        );
        engine.maximum_attachment_bytes = 0;
        assert_eq!(
            engine
                .take_network_resource(identity.clone(), &operation)
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        engine.maximum_attachment_bytes = 32 * 1024 * 1024;
        assert!(
            engine
                .network_trace_control("context.trace.network.ingested", &identity, &operation)
                .is_err()
        );
        drop(held);
        let transfer = engine
            .take_network_resource(identity.clone(), &operation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(transfer.bytes, b"a");
        assert!(
            engine
                .take_network_resource(identity.clone(), &operation)
                .await
                .is_err()
        );
        engine
            .network_trace_control("context.trace.network.ingested", &identity, &operation)
            .unwrap();
        drop(transfer);
        let token = {
            let mut state = context.recording.lock().unwrap();
            let resources = &mut state
                .get_mut("recording")
                .unwrap()
                .network
                .as_mut()
                .unwrap()
                .resources;
            let token = resources
                .request(&json!(["Yg=="]), false)
                .unwrap()
                .unwrap()
                .token;
            resources.pull();
            token
        };
        engine.attachment_slots.close();
        assert_eq!(
            engine
                .take_network_resource(
                    json!({"context":"context","recording":"recording","token":token}),
                    &operation
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::TargetClosed
        );
    }
}
