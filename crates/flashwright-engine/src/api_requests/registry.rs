//! Publication, disposal, and body transfers share the original request-context ownership.

use super::budget::{
    ContextBudget, EngineBudget, MAXIMUM_METADATA_BYTES, PairedBudget, PairedReservation,
    Reservation, RetainedBody,
};
use super::connector::SocketConnector;
use super::cookie_jar::CookieJar;
use super::exchange::{Header, ResponseMetadata};
use super::options::{ContextOptions, Cookie, StorageOrigin};
use super::resolver::BoundedResolver;
use super::tls::{self, HttpClient};
use flashwright_protocol::{ErrorCode, ErrorRecord, ResourceLimits};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

pub(super) type PublicationCustody = Arc<dyn fmt::Debug + Send + Sync>;

/// A storage snapshot owns its JSON allocation until its final encoded frame is dropped.
pub struct RetainedValue {
    value: Value,
    context: Arc<RequestContext>,
    _reservation: PairedReservation,
}

impl fmt::Debug for RetainedValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RetainedValue")
            .finish_non_exhaustive()
    }
}

impl RetainedValue {
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }

    pub(crate) fn prepare<Prepared>(
        self: &Arc<Self>,
        prepare: impl FnOnce(&Value, PublicationCustody) -> Result<Prepared, ErrorRecord>,
    ) -> Result<Prepared, ErrorRecord> {
        let state = self.context.state.lock().expect("API context lock");
        if state.disposed || !state.published {
            return Err(closed_error("apiRequest.storageState"));
        }
        prepare(&self.value, self.clone())
    }
}

pub(crate) struct RequestRegistry {
    budget: EngineBudget,
    pub(super) limits: ResourceLimits,
    state: Mutex<RegistryState>,
}

impl Default for RequestRegistry {
    fn default() -> Self {
        Self::with_limits(ResourceLimits::default())
    }
}

#[derive(Default)]
struct RegistryState {
    closed: bool,
    contexts: BTreeMap<String, Arc<RequestContext>>,
}

impl Drop for RequestRegistry {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(super) struct RequestContext {
    pub(super) identifier: String,
    pub(super) options: ContextOptions,
    pub(super) origins: Vec<StorageOrigin>,
    pub(super) cookies: Mutex<CookieJar>,
    pub(super) budget: ContextBudget,
    state: Mutex<ContextState>,
    pub(super) local_dates: super::local_dates::PendingDates,
    closed: watch::Sender<bool>,
    strict_client: OnceLock<HttpClient>,
    ignoring_client: OnceLock<HttpClient>,
    pool_custody: Arc<tls::PoolCustody>,
    // Keep configuration and owner credits after every object that uses them.
    _configuration: PairedReservation,
    owner: Arc<Reservation>,
}

struct ContextState {
    published: bool,
    disposed: bool,
    responses: BTreeMap<String, ResponseEntry>,
    trace_bodies: BTreeMap<String, TraceBodyEntry>,
    retired_trace_generations: BTreeMap<String, PairedReservation>,
    trace_retention_disabled: bool,
}

struct TraceBodyEntry {
    generation: String,
    body: Arc<RetainedBody>,
    _metadata: PairedReservation,
}

struct ResponseEntry {
    response: Arc<Response>,
    published: bool,
}

#[derive(Debug)]
pub(super) struct Response {
    identifier: String,
    _context: String,
    _url: String,
    _metadata: ResponseMetadata,
    pub(super) body: Arc<RetainedBody>,
    closed: watch::Sender<bool>,
    _publication: PairedReservation,
    _entry: PairedReservation,
    _owner: Arc<Reservation>,
}

// Context diagnostics deliberately omit credentials and stored application data.
impl fmt::Debug for RequestContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RequestContext")
            .field("identifier", &self.identifier)
            .finish_non_exhaustive()
    }
}

impl RequestRegistry {
    pub(crate) fn with_limits(limits: ResourceLimits) -> Self {
        Self {
            budget: EngineBudget::default(),
            limits,
            state: Mutex::default(),
        }
    }

    pub(super) fn create(
        &self,
        identifier: String,
        mut options: ContextOptions,
    ) -> Result<Arc<RequestContext>, ErrorRecord> {
        let method = "apiRequest.newContext";
        let owner = Arc::new(self.budget.owners.reserve(1, method)?);
        let budget = ContextBudget::new(&self.budget);
        let configuration = budget.metadata.reserve(
            options.retained_bytes() + identifier.capacity() + identifier.len() + 4096,
            method,
        )?;
        let storage = options.storage_state.take().unwrap_or_default();
        let cookies = CookieJar::new(
            storage.cookies,
            budget.metadata.clone(),
            super::unix_milliseconds(),
            method,
        )?;
        let pool_custody = tls::pool_custody(&budget.metadata, owner.clone())?;
        let (closed, _) = watch::channel(false);
        let context = Arc::new(RequestContext {
            identifier: identifier.clone(),
            options,
            origins: storage.origins,
            cookies: Mutex::new(cookies),
            budget,
            state: Mutex::new(ContextState {
                published: false,
                disposed: false,
                responses: BTreeMap::new(),
                trace_bodies: BTreeMap::new(),
                retired_trace_generations: BTreeMap::new(),
                trace_retention_disabled: false,
            }),
            closed,
            local_dates: super::local_dates::PendingDates::default(),
            strict_client: OnceLock::new(),
            ignoring_client: OnceLock::new(),
            pool_custody,
            _configuration: configuration,
            owner,
        });
        let mut state = self.state.lock().expect("API registry lock");
        if state.closed {
            return Err(closed_error(method));
        }
        if state.contexts.contains_key(&identifier) {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                method,
                "API request context identifier was reused",
            ));
        }
        state.contexts.insert(identifier, context.clone());
        Ok(context)
    }

    pub(super) fn context(
        &self,
        identifier: &str,
        method: &str,
    ) -> Result<Arc<RequestContext>, ErrorRecord> {
        let context = self.original_context(identifier, method)?;
        let state = context.state.lock().expect("API context lock");
        if state.disposed || !state.published {
            return Err(closed_error(method));
        }
        drop(state);
        Ok(context)
    }

    fn original_context(
        &self,
        identifier: &str,
        method: &str,
    ) -> Result<Arc<RequestContext>, ErrorRecord> {
        self.state
            .lock()
            .expect("API registry lock")
            .contexts
            .get(identifier)
            .cloned()
            .ok_or_else(|| closed_error(method))
    }

    /// The encoder receives custody while the same lock excludes disposal. Never
    /// perform a second, post-encoding lookup to attach a potentially different owner.
    pub(crate) fn prepare_publication<Prepared>(
        &self,
        method: &str,
        result: &Value,
        prepare: impl FnOnce(&Value, PublicationCustody) -> Result<Prepared, ErrorRecord>,
    ) -> Result<Prepared, ErrorRecord> {
        let identifier = result["identifier"]
            .as_str()
            .ok_or_else(|| invalid_publication(method))?;
        if method == "apiRequest.newContext" {
            let context = self.original_context(identifier, method)?;
            let mut state = context.state.lock().expect("API context lock");
            if state.disposed {
                return Err(closed_error(method));
            }
            let prepared = prepare(result, context.clone())?;
            state.published = true;
            return Ok(prepared);
        }
        if method != "apiRequest.fetch" {
            return Err(invalid_publication(method));
        }
        let context_identifier = result["context"]
            .as_str()
            .ok_or_else(|| invalid_publication(method))?;
        let context = self.original_context(context_identifier, method)?;
        let mut state = context.state.lock().expect("API context lock");
        if state.disposed || !state.published {
            return Err(closed_error(method));
        }
        let entry = state
            .responses
            .get_mut(identifier)
            .ok_or_else(|| closed_error(method))?;
        let prepared = prepare(result, entry.response.clone())?;
        entry.published = true;
        Ok(prepared)
    }

    pub(crate) fn dispose_context(&self, identifier: &str) -> bool {
        let context = self
            .state
            .lock()
            .expect("API registry lock")
            .contexts
            .remove(identifier);
        if let Some(context) = context {
            context.dispose();
            true
        } else {
            false
        }
    }

    pub(crate) fn dispose_response(&self, context: &str, response: &str) -> bool {
        self.original_context(context, "apiResponse.dispose")
            .is_ok_and(|context| context.dispose_response(response))
    }

    pub(crate) fn shutdown(&self) {
        let contexts = {
            let mut state = self.state.lock().expect("API registry lock");
            state.closed = true;
            std::mem::take(&mut state.contexts)
        };
        for context in contexts.into_values() {
            context.dispose();
        }
    }
}

impl RequestContext {
    pub(super) fn storage_snapshot(self: &Arc<Self>) -> Result<Arc<RetainedValue>, ErrorRecord> {
        let method = "apiRequest.storageState";
        let state = self.state.lock().expect("API context lock");
        if state.disposed || !state.published {
            return Err(closed_error(method));
        }
        let _references = self
            .budget
            .metadata
            .reserve(4096 * size_of::<&Cookie>(), method)?;
        let mut jar = self.cookies.lock().expect("API cookies lock");
        let cookies = jar
            .all_cookies(super::unix_milliseconds())
            .collect::<Vec<_>>();
        #[derive(Serialize)]
        struct StorageWire<'a> {
            cookies: &'a [&'a Cookie],
            origins: &'a [StorageOrigin],
        }
        let wire = StorageWire {
            cookies: &cookies,
            origins: &self.origins,
        };
        let encoded_bytes = encoded_size(&wire)?;
        let mut allocation_bytes = encoded_bytes
            .saturating_mul(2)
            .saturating_add(4096)
            .saturating_add(cookies.len().saturating_mul(4096));
        for origin in &self.origins {
            allocation_bytes = allocation_bytes
                .saturating_add(1024)
                .saturating_add(origin.local_storage.len().saturating_mul(1024));
            for entry in &origin.local_storage {
                allocation_bytes = allocation_bytes.saturating_add(
                    entry
                        .name
                        .len()
                        .saturating_add(entry.value.len())
                        .saturating_mul(32),
                );
            }
        }
        let reservation = self.budget.metadata.reserve(allocation_bytes, method)?;
        let value = serde_json::to_value(wire)
            .map_err(|error| ErrorRecord::new(ErrorCode::Protocol, method, error.to_string()))?;
        Ok(Arc::new(RetainedValue {
            value,
            context: self.clone(),
            _reservation: reservation,
        }))
    }

    pub(super) fn check(&self, method: &str) -> Result<(), ErrorRecord> {
        if *self.closed.borrow() {
            Err(closed_error(method))
        } else {
            Ok(())
        }
    }

    pub(super) fn client(&self, call_ignores_https_errors: bool) -> &HttpClient {
        let ignore = self.options.ignore_https_errors || call_ignores_https_errors;
        let client = if ignore {
            &self.ignoring_client
        } else {
            &self.strict_client
        };
        client.get_or_init(|| {
            let closed = self.closed.subscribe();
            let resolver = BoundedResolver::new(
                self.budget.lookups.clone(),
                self.owner.clone(),
                closed.clone(),
            );
            let connector = SocketConnector::new(
                resolver,
                self.budget.sockets.clone(),
                closed,
                self.owner.clone(),
            );
            tls::client(
                connector,
                ignore,
                self.budget.connections.clone(),
                self.pool_custody.clone(),
            )
        })
    }

    /// Outer Operation::wait keeps the caller's original deadline; this race binds owner closure.
    pub(super) async fn while_alive<Output>(
        &self,
        method: &str,
        future: impl Future<Output = Result<Output, ErrorRecord>>,
    ) -> Result<Output, ErrorRecord> {
        let mut closed = self.closed.subscribe();
        self.check(method)?;
        tokio::select! {
            biased;
            _ = closed.wait_for(|closed| *closed) => Err(closed_error(method)),
            result = future => { self.check(method)?; result },
        }
    }

    /// Install only completed bodies. Allocation or encoding failure leaves no response entry.
    pub(super) fn retain_response(
        &self,
        identifier: String,
        url: String,
        metadata: ResponseMetadata,
        body: Arc<RetainedBody>,
        trace_generation: Option<&str>,
    ) -> Result<Value, ErrorRecord> {
        let method = "apiRequest.fetch";
        let entry_credit = self.budget.responses.reserve(1, method)?;
        let wire = ResponseWire {
            identifier: &identifier,
            context: &self.identifier,
            url: &url,
            status: metadata.status,
            status_text: &metadata.status_text,
            headers: &metadata.headers,
            body_length: body.bytes.len(),
        };
        let encoded_length = encoded_size(&wire)?;
        if encoded_length > MAXIMUM_METADATA_BYTES {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "API response metadata exceeds 256 KiB",
            ));
        }
        // Each two-field header JSON object receives a conservative 1 KiB node allowance;
        // strings, the top-level tree, registry node and final encoded frame are additional.
        // This credit follows the response through publication and binary transfer disposal.
        let publication = reserve_publication(
            &self.budget.metadata,
            &identifier,
            &url,
            &wire,
            encoded_length,
        )?;
        let value = serde_json::to_value(wire)
            .map_err(|error| ErrorRecord::new(ErrorCode::Protocol, method, error.to_string()))?;
        let (closed, _) = watch::channel(false);
        let trace_entry = if let Some(generation) = trace_generation {
            self.budget
                .metadata
                .reserve(
                    identifier
                        .capacity()
                        .saturating_add(generation.len())
                        .saturating_add(256),
                    method,
                )
                .ok()
                .map(|metadata| TraceBodyEntry {
                    generation: generation.to_owned(),
                    body: body.clone(),
                    _metadata: metadata,
                })
        } else {
            None
        };
        let response = Arc::new(Response {
            identifier: identifier.clone(),
            _context: self.identifier.clone(),
            _url: url,
            _metadata: metadata,
            body,
            closed,
            _publication: publication,
            _entry: entry_credit,
            _owner: self.owner.clone(),
        });
        let mut state = self.state.lock().expect("API context lock");
        if state.disposed || !state.published {
            return Err(closed_error(method));
        }
        if state.responses.contains_key(&identifier) {
            return Err(invalid_publication(method));
        }
        state.responses.insert(
            identifier.clone(),
            ResponseEntry {
                response,
                published: false,
            },
        );
        if !state.trace_retention_disabled
            && trace_generation
                .is_none_or(|generation| !state.retired_trace_generations.contains_key(generation))
            && state.trace_bodies.len() < 64
            && let Some(entry) = trace_entry
        {
            state.trace_bodies.insert(identifier.clone(), entry);
        }
        Ok(value)
    }

    pub(super) fn trace_body(
        &self,
        identifier: &str,
        method: &str,
    ) -> Result<Arc<RetainedBody>, ErrorRecord> {
        let state = self.state.lock().expect("API context lock");
        if state.disposed {
            return Err(closed_error(method));
        }
        state
            .trace_bodies
            .get(identifier)
            .map(|entry| entry.body.clone())
            .ok_or_else(|| closed_error(method))
    }

    pub(super) fn ingest_trace_body(
        &self,
        identifier: &str,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        let mut state = self.state.lock().expect("API context lock");
        if state.disposed {
            return Err(closed_error(method));
        }
        state
            .trace_bodies
            .remove(identifier)
            .map(|_| ())
            .ok_or_else(|| closed_error(method))
    }

    pub(super) fn retire_trace_bodies(
        &self,
        generation: &str,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        let mut state = self.state.lock().expect("API context lock");
        if state.disposed {
            return Err(closed_error(method));
        }
        if !state.retired_trace_generations.contains_key(generation) {
            if state.retired_trace_generations.len() >= 1024 {
                state.trace_retention_disabled = true;
                state.trace_bodies.clear();
                return Err(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "API context exceeds 1024 retired trace generations",
                ));
            }
            let credit = match self
                .budget
                .metadata
                .reserve(generation.len().saturating_add(128), method)
            {
                Ok(credit) => credit,
                Err(error) => {
                    state.trace_retention_disabled = true;
                    state.trace_bodies.clear();
                    return Err(error);
                }
            };
            state
                .retired_trace_generations
                .insert(generation.to_owned(), credit);
        }
        state
            .trace_bodies
            .retain(|_, entry| entry.generation != generation);
        Ok(())
    }

    pub(super) fn response(
        &self,
        identifier: &str,
        method: &str,
    ) -> Result<Arc<Response>, ErrorRecord> {
        let state = self.state.lock().expect("API context lock");
        if state.disposed {
            return Err(closed_error(method));
        }
        let entry = state
            .responses
            .get(identifier)
            .filter(|entry| entry.published)
            .ok_or_else(|| closed_error(method))?;
        Ok(entry.response.clone())
    }

    /// A disposed response also wakes transfer admission even while its context remains healthy.
    pub(super) async fn while_response_alive<Output>(
        &self,
        response: &Response,
        method: &str,
        future: impl Future<Output = Result<Output, ErrorRecord>>,
    ) -> Result<Output, ErrorRecord> {
        let mut closed = response.closed.subscribe();
        if *closed.borrow() {
            return Err(closed_error(method));
        }
        self.while_alive(method, async {
            tokio::select! {
                biased;
                _ = closed.wait_for(|closed| *closed) => Err(closed_error(method)),
                result = future => {
                    let current = self.response(&response.identifier, method)?;
                    if !std::ptr::eq(current.as_ref(), response) { return Err(closed_error(method)); }
                    result
                },
            }
        }).await
    }

    fn dispose_response(&self, identifier: &str) -> bool {
        let mut state = self.state.lock().expect("API context lock");
        if let Some(entry) = state.responses.remove(identifier) {
            entry.response.closed.send_replace(true);
            true
        } else {
            false
        }
    }

    fn dispose(&self) {
        let mut state = self.state.lock().expect("API context lock");
        if state.disposed {
            return;
        }
        state.disposed = true;
        self.closed.send_replace(true);
        self.local_dates.close();
        for entry in std::mem::take(&mut state.responses).into_values() {
            entry.response.closed.send_replace(true);
        }
        state.trace_bodies.clear();
        state.retired_trace_generations.clear();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseWire<'a> {
    identifier: &'a str,
    context: &'a str,
    url: &'a str,
    status: u16,
    status_text: &'a str,
    headers: &'a [Header],
    body_length: usize,
}

fn reserve_publication(
    budget: &PairedBudget,
    identifier: &String,
    url: &String,
    wire: &ResponseWire<'_>,
    encoded_length: usize,
) -> Result<PairedReservation, ErrorRecord> {
    let copied_strings = identifier.len() * 2
        + wire.context.len() * 2
        + url.len()
        + wire.status_text.len()
        + wire
            .headers
            .iter()
            .map(|header| header.name.len() + header.value.len())
            .sum::<usize>();
    // Original URL and registry-key allocations can have spare capacity. Their
    // retained bytes are independent of the shorter copies encoded into the reply.
    let bytes = 4096 + wire.headers.len() * 1024 + copied_strings + encoded_length;
    let bytes = bytes
        .saturating_add(identifier.capacity())
        .saturating_add(url.capacity());
    budget.reserve(bytes, "apiRequest.fetch")
}

fn encoded_size(value: &impl Serialize) -> Result<usize, ErrorRecord> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("metadata length overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).map_err(|error| {
        ErrorRecord::new(ErrorCode::Protocol, "apiRequest.fetch", error.to_string())
    })?;
    Ok(counter.0)
}

fn closed_error(method: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::TargetClosed,
        method,
        "original API request owner was disposed",
    )
}
fn invalid_publication(method: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Protocol,
        method,
        "invalid API allocation publication",
    )
}

#[cfg(test)]
mod tests {
    use super::super::exchange;
    use super::*;
    use crate::{Engine, Operation};
    use bytes::Bytes;
    use flashwright_protocol::{BinaryAttachment, DriverMessage, InputDelivery};
    use http_body_util::Full;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Semaphore;
    use tokio::time::{Duration, timeout};

    fn context(registry: &RequestRegistry) -> Arc<RequestContext> {
        let context = registry
            .create("context".into(), ContextOptions::parse(json!({})).unwrap())
            .unwrap();
        registry
            .prepare_publication(
                "apiRequest.newContext",
                &json!({"identifier":"context"}),
                |_, _custody| Ok(()),
            )
            .unwrap();
        context
    }

    #[tokio::test]
    async fn original_pool_custody_survives_context_disposal_until_last_client_clone_drops() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        let metadata = context.budget.metadata.clone();
        let original = Arc::downgrade(&context);
        let pool = Arc::downgrade(&context.pool_custody);
        let client = context.client(false).clone();
        let ignoring_client = context.client(true).clone();
        registry.dispose_context(&context.identifier);
        drop(context);
        assert!(
            original.upgrade().is_none(),
            "no client/context reference cycle"
        );
        assert!(pool.upgrade().is_some());
        assert_eq!(metadata.retained(), tls::POOL_WORKING_BYTES);
        drop(client);
        assert!(pool.upgrade().is_some());
        assert_eq!(metadata.retained(), tls::POOL_WORKING_BYTES);
        drop(ignoring_client);
        assert!(pool.upgrade().is_none());
        assert_eq!(metadata.retained(), 0);
    }

    async fn response_parts(context: &RequestContext) -> (ResponseMetadata, Arc<RetainedBody>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 4096);
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 Original\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody",
                )
                .await
                .unwrap();
        });
        let request = http::Request::get(destination)
            .body(Full::new(Bytes::new()))
            .unwrap();
        let exchange = exchange::start(context.client(false), request, &context.budget, || {
            context.check("test")
        })
        .await
        .unwrap();
        let parts = exchange
            .finish(&context.budget, || context.check("test"))
            .await
            .unwrap();
        server.await.unwrap();
        parts
    }

    async fn response(
        registry: &RequestRegistry,
        context: &RequestContext,
        identifier: &str,
    ) -> Value {
        let (metadata, body) = response_parts(context).await;
        let value = context
            .retain_response(
                identifier.into(),
                "http://example.test/".into(),
                metadata,
                body,
                None,
            )
            .unwrap();
        registry
            .prepare_publication("apiRequest.fetch", &value, |_, _custody| Ok(()))
            .unwrap();
        value
    }

    #[test]
    fn rejected_context_publication_stays_private_and_cannot_revive_after_disposal() {
        let registry = RequestRegistry::default();
        let original = registry
            .create("context".into(), ContextOptions::parse(json!({})).unwrap())
            .unwrap();
        let value = json!({"identifier":"context"});
        let error = registry
            .prepare_publication("apiRequest.newContext", &value, |_, _| {
                Err::<(), _>(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    "test",
                    "encoding failed",
                ))
            })
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        assert!(registry.context("context", "test").is_err());
        assert!(registry.dispose_context("context"));
        assert_eq!(
            original.check("test").unwrap_err().code,
            ErrorCode::TargetClosed
        );
        assert!(
            registry
                .prepare_publication(
                    "apiRequest.newContext",
                    &value,
                    |_, _| -> Result<(), ErrorRecord> { panic!("closed context must not encode") }
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn encoded_reply_keeps_original_owner_credit_after_registry_disposal() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        let original_owner = Arc::downgrade(&context.owner);
        let value = response(&registry, &context, "response").await;
        let frame = registry
            .prepare_publication("apiRequest.fetch", &value, |value, custody| {
                let mut frame = DriverMessage::encode_result(
                    1,
                    value,
                    InputDelivery::NotDispatched,
                    1024 * 1024,
                )
                .unwrap();
                frame.retain_reservation(custody);
                Ok(frame)
            })
            .unwrap();
        registry.dispose_context("context");
        drop(context);
        tokio::task::yield_now().await;
        assert!(original_owner.upgrade().is_some());
        assert!(registry.budget.owners.reserve(128, "test").is_err());
        drop(frame);
        timeout(Duration::from_secs(1), async {
            while original_owner.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(registry.budget.owners.reserve(128, "test").is_ok());
    }

    #[tokio::test]
    async fn binary_transfer_retains_response_and_original_context_credit_until_drop() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        response(&registry, &context, "response").await;
        let original = context.response("response", "test").unwrap();
        let weak_response = Arc::downgrade(&original);
        let original_owner = Arc::downgrade(&context.owner);
        let original_bytes = original.body.bytes.clone();
        let semaphore = Arc::new(Semaphore::new(1));
        let attachment = BinaryAttachment::from_shared_raw(
            original_bytes.clone(),
            original,
            1024,
            semaphore.acquire_owned().await.unwrap(),
            "test",
        )
        .unwrap();
        assert!(Arc::ptr_eq(&attachment.bytes, &original_bytes));
        registry.dispose_context("context");
        drop(context);
        assert!(weak_response.upgrade().is_some());
        assert!(original_owner.upgrade().is_some());
        assert!(registry.budget.owners.reserve(128, "test").is_err());
        drop(attachment);
        assert!(weak_response.upgrade().is_none());
        drop(original_bytes);
        timeout(Duration::from_secs(1), async {
            while original_owner.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(registry.budget.owners.reserve(128, "test").is_ok());
    }

    #[tokio::test]
    async fn trace_body_survives_public_disposal_while_attachment_slots_are_occupied() {
        let (outgoing, _receiver) = tokio::sync::mpsc::channel(8);
        let (fatal, _) = watch::channel(false);
        let engine = Engine::new(
            None,
            outgoing,
            fatal,
            flashwright_protocol::ResourceLimits::default(),
        );
        let context = context(&engine.api_requests);
        let (metadata, body) = response_parts(&context).await;
        let original = Arc::downgrade(&body);
        let value = context
            .retain_response(
                "traced".into(),
                "http://example.test/".into(),
                metadata,
                body,
                Some("generation-1"),
            )
            .unwrap();
        engine
            .api_requests
            .prepare_publication("apiRequest.fetch", &value, |_, _| Ok(()))
            .unwrap();
        let (_, cancelled) = watch::channel(false);
        let operation = Operation::new("apiRequest.traceBody.take".into(), None, cancelled);
        let parameters = json!({"context":"context","response":"traced"});
        let occupied = engine
            .attachment_slots
            .clone()
            .try_acquire_many_owned(2)
            .unwrap();
        assert!(
            engine
                .api_trace_body_take(parameters.clone(), &operation)
                .await
                .unwrap()
                .is_none()
        );
        assert!(engine.api_requests.dispose_response("context", "traced"));
        assert!(
            original.upgrade().is_some(),
            "trace retains the original body after public disposal"
        );
        drop(occupied);
        let attachment = engine
            .api_trace_body_take(parameters.clone(), &operation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attachment.bytes.as_slice(), b"body");
        engine
            .api_request_control("apiRequest.traceBody.ingested", parameters, &operation)
            .unwrap();
        assert!(context.trace_body("traced", "test").is_err());
        drop(attachment);
        assert!(original.upgrade().is_none());
        let (metadata, body) = response_parts(&context).await;
        let pending = Arc::downgrade(&body);
        let value = context
            .retain_response(
                "unread".into(),
                "http://example.test/".into(),
                metadata,
                body,
                Some("generation-1"),
            )
            .unwrap();
        engine
            .api_requests
            .prepare_publication("apiRequest.fetch", &value, |_, _| Ok(()))
            .unwrap();
        engine.api_requests.dispose_response("context", "unread");
        assert!(pending.upgrade().is_some());
        context.retire_trace_bodies("generation-1", "test").unwrap();
        assert!(
            pending.upgrade().is_none(),
            "retiring the recording releases unread original bodies"
        );
        let (metadata, body) = response_parts(&context).await;
        let late = Arc::downgrade(&body);
        let value = context
            .retain_response(
                "late".into(),
                "http://example.test/".into(),
                metadata,
                body,
                Some("generation-1"),
            )
            .unwrap();
        engine
            .api_requests
            .prepare_publication("apiRequest.fetch", &value, |_, _| Ok(()))
            .unwrap();
        engine.api_requests.dispose_response("context", "late");
        assert!(
            late.upgrade().is_none(),
            "late responses cannot revive a retired trace body generation"
        );
        {
            let mut state = context.state.lock().unwrap();
            for index in 0..1023 {
                let generation = format!("retired-{index}");
                let credit = context
                    .budget
                    .metadata
                    .reserve(generation.len() + 128, "test")
                    .unwrap();
                state.retired_trace_generations.insert(generation, credit);
            }
        }
        let (metadata, body) = response_parts(&context).await;
        let unfenced = Arc::downgrade(&body);
        let value = context
            .retain_response(
                "unfenced".into(),
                "http://example.test/".into(),
                metadata,
                body,
                Some("generation-2"),
            )
            .unwrap();
        engine
            .api_requests
            .prepare_publication("apiRequest.fetch", &value, |_, _| Ok(()))
            .unwrap();
        engine.api_requests.dispose_response("context", "unfenced");
        assert!(unfenced.upgrade().is_some());
        assert_eq!(
            context
                .retire_trace_bodies("generation-2", "test")
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert!(
            unfenced.upgrade().is_none(),
            "failed fence closes original trace retention before returning"
        );
        let (metadata, body) = response_parts(&context).await;
        let later = Arc::downgrade(&body);
        let value = context
            .retain_response(
                "later".into(),
                "http://example.test/".into(),
                metadata,
                body,
                Some("generation-2"),
            )
            .unwrap();
        engine
            .api_requests
            .prepare_publication("apiRequest.fetch", &value, |_, _| Ok(()))
            .unwrap();
        engine.api_requests.dispose_response("context", "later");
        assert!(
            later.upgrade().is_none(),
            "failed fencing cannot admit a late trace body"
        );
    }

    #[tokio::test]
    async fn response_disposal_wakes_blocked_output_admission_without_harming_successor() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        response(&registry, &context, "first").await;
        response(&registry, &context, "second").await;
        let original = context.response("first", "test").unwrap();
        let semaphore = Arc::new(Semaphore::new(0));
        let pending = context.while_response_alive(&original, "apiResponse.body", async {
            semaphore
                .acquire_owned()
                .await
                .map_err(|_| closed_error("test"))
        });
        tokio::pin!(pending);
        assert!(
            timeout(Duration::from_millis(5), &mut pending)
                .await
                .is_err()
        );
        assert!(registry.dispose_response("context", "first"));
        let error = timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::TargetClosed);
        assert_eq!(
            context
                .response("second", "test")
                .unwrap()
                .body
                .bytes
                .as_slice(),
            b"body"
        );
        registry.shutdown();
    }

    #[tokio::test]
    async fn context_disposal_cancels_original_pending_work_and_prevents_late_publication() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        let value = response(&registry, &context, "response").await;
        let pending = context.while_alive(
            "apiRequest.fetch",
            std::future::pending::<Result<(), ErrorRecord>>(),
        );
        tokio::pin!(pending);
        assert!(
            timeout(Duration::from_millis(5), &mut pending)
                .await
                .is_err()
        );
        registry.dispose_context("context");
        assert_eq!(
            timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap_err()
                .code,
            ErrorCode::TargetClosed
        );
        assert!(
            registry
                .prepare_publication(
                    "apiRequest.fetch",
                    &value,
                    |_, _| -> Result<(), ErrorRecord> {
                        panic!("disposed response must not publish")
                    }
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn failed_response_encoding_stays_private_and_discard_releases_only_original_response() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        response(&registry, &context, "healthy").await;
        let (metadata, body) = response_parts(&context).await;
        let value = context
            .retain_response(
                "rejected".into(),
                "http://example.test/".into(),
                metadata,
                body,
                None,
            )
            .unwrap();
        assert!(
            registry
                .prepare_publication("apiRequest.fetch", &value, |_, _| Err::<(), _>(
                    ErrorRecord::new(ErrorCode::ResourceLimit, "test", "encoding failed")
                ))
                .is_err()
        );
        assert!(context.response("rejected", "test").is_err());
        assert!(registry.dispose_response("context", "rejected"));
        assert!(context.response("healthy", "test").is_ok());
        registry.shutdown();
    }

    #[tokio::test]
    async fn complete_metadata_envelope_limit_includes_final_url_before_response_installation() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        let (metadata, body) = response_parts(&context).await;
        let error = context
            .retain_response(
                "oversized".into(),
                "x".repeat(MAXIMUM_METADATA_BYTES),
                metadata,
                body,
                None,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        assert!(context.state.lock().unwrap().responses.is_empty());
        assert_eq!(context.budget.bodies.retained(), 0);
        assert!(context.budget.responses.reserve(16384, "test").is_ok());
        registry.shutdown();
    }

    #[test]
    fn shutdown_closes_all_original_owners_and_rejects_future_creation() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        registry.shutdown();
        assert!(context.check("test").is_err());
        assert!(
            registry
                .create(
                    "successor".into(),
                    ContextOptions::parse(json!({})).unwrap()
                )
                .is_err()
        );
        assert!(!registry.dispose_context("context"));
    }

    #[test]
    fn registry_drop_retires_an_original_context_still_held_by_pending_work() {
        let registry = RequestRegistry::default();
        let context = context(&registry);
        drop(registry);
        assert_eq!(
            context.check("test").unwrap_err().code,
            ErrorCode::TargetClosed
        );
    }

    #[test]
    fn short_url_and_identifier_with_large_capacity_still_require_original_allocation_credit() {
        let budget = PairedBudget::testing(256 * 1024);
        for oversized_identifier in [false, true] {
            let mut identifier =
                String::with_capacity(if oversized_identifier { 256 * 1024 } else { 16 });
            identifier.push_str("response");
            let mut url = String::with_capacity(if oversized_identifier { 32 } else { 256 * 1024 });
            url.push_str("http://example.test/");
            let wire = ResponseWire {
                identifier: &identifier,
                context: "context",
                url: &url,
                status: 200,
                status_text: "OK",
                headers: &[],
                body_length: 0,
            };
            let encoded_length = encoded_size(&wire).unwrap();
            assert!(encoded_length < 1024);
            assert_eq!(
                reserve_publication(&budget, &identifier, &url, &wire, encoded_length)
                    .unwrap_err()
                    .code,
                ErrorCode::ResourceLimit
            );
            assert_eq!(budget.retained(), 0);
        }
        let identifier = String::from("response");
        let url = String::from("http://example.test/");
        let wire = ResponseWire {
            identifier: &identifier,
            context: "context",
            url: &url,
            status: 200,
            status_text: "OK",
            headers: &[],
            body_length: 0,
        };
        let successor = reserve_publication(
            &budget,
            &identifier,
            &url,
            &wire,
            encoded_size(&wire).unwrap(),
        )
        .unwrap();
        assert!(budget.retained() > 0);
        drop(successor);
        assert_eq!(budget.retained(), 0);
    }
}
