//! One HTTP exchange preserves original headers and bounded response custody across decoding.

use super::budget::{
    BodyBuffer, ContextBudget, MAXIMUM_BODY_BYTES, MAXIMUM_METADATA_BYTES, PairedReservation,
    RetainedBody,
};
use super::response_decoder;
use super::tls::HttpClient;
use super::transport_error::TransportError;
use bytes::Bytes;
use flashwright_protocol::{ErrorCode, ErrorRecord};
use http::{Request, response::Parts};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::ext::OriginalResponseHeaders;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// Workspace for extracting Latin-1 metadata. Incoming separately retains the
// connection credit for the raw block, cached HeaderMap capacity and read-ahead.
const HEADER_WORKING_BYTES: usize = 2 * 1024 * 1024;
const MAXIMUM_REQUEST_METADATA_BYTES: usize = 1024 * 1024;
const MAXIMUM_REQUEST_HEADERS: usize = 4096;

/// Bound the final merged request before Hyper serializes it into a connection buffer.
/// Count the full URI conservatively and leave room for generated Host and framing fields.
fn validate_request_metadata(request: &Request<Full<Bytes>>) -> Result<(), ErrorRecord> {
    let rejected = || {
        ErrorRecord::new(
            ErrorCode::ResourceLimit,
            "apiRequest.fetch",
            "API request wire metadata exceeds 1 MiB or 4096 headers",
        )
    };
    if request.headers().len() > MAXIMUM_REQUEST_HEADERS {
        return Err(rejected());
    }
    let mut remaining = MAXIMUM_REQUEST_METADATA_BYTES;
    let mut count = |length: usize| -> Result<(), ErrorRecord> {
        remaining = remaining.checked_sub(length).ok_or_else(rejected)?;
        Ok(())
    };
    count(128)?;
    count(request.method().as_str().len())?;
    let destination = request.uri();
    if let Some(scheme) = destination.scheme_str() {
        count(scheme.len())?;
    }
    if let Some(authority) = destination.authority() {
        count(authority.as_str().len())?;
        count(authority.as_str().len())?;
    }
    if let Some(path) = destination.path_and_query() {
        count(path.as_str().len())?;
    }
    for (name, value) in request.headers() {
        count(name.as_str().len())?;
        count(value.as_bytes().len())?;
        count(4)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Header {
    pub(super) name: String,
    pub(super) value: String,
}

#[derive(Debug)]
pub(super) struct ResponseMetadata {
    pub(super) status: u16,
    pub(super) status_text: String,
    pub(super) headers: Vec<Header>,
    _capacity: PairedReservation,
}

impl ResponseMetadata {
    pub(super) fn first(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str())
    }

    /// Node joins duplicate content encodings with a comma. Such a combined encoding
    /// is deliberately left raw by the pinned API instead of decoding one field.
    fn encoding(&self) -> String {
        self.headers
            .iter()
            .filter(|header| header.name.eq_ignore_ascii_case("content-encoding"))
            .map(|header| header.value.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

pub(super) struct Exchange {
    // Incoming may retain connection/parser state until body completion or redirect drop.
    incoming: Incoming,
    pub(super) metadata: ResponseMetadata,
    _working: PairedReservation,
}

#[derive(Debug)]
pub(super) struct Failure {
    pub(super) error: ErrorRecord,
    pub(super) connection_reset: bool,
}

impl From<ErrorRecord> for Failure {
    fn from(error: ErrorRecord) -> Self {
        Self {
            error,
            connection_reset: false,
        }
    }
}

/// The owning request races this entire future against its original deadline and closure.
/// The request body must itself retain original input custody through Hyper's writer.
pub(super) async fn start(
    client: &HttpClient,
    request: Request<Full<Bytes>>,
    budget: &ContextBudget,
    mut check: impl FnMut() -> Result<(), ErrorRecord>,
) -> Result<Exchange, Failure> {
    check()?;
    validate_request_metadata(&request)?;
    let working = budget
        .metadata
        .reserve(HEADER_WORKING_BYTES, "apiRequest.fetch")?;
    let tunnel_request = request.method() == http::Method::CONNECT;
    let response = client
        .request(request)
        .await
        .map_err(request_head_failure)?;
    check()?;
    if response.status() == http::StatusCode::SWITCHING_PROTOCOLS
        || (tunnel_request && response.status().is_success())
    {
        // The pinned request API has no upgrade/connect listener, so these replies
        // settle only through the caller's original deadline or owner disposal.
        // Automatic upgrades are disabled: read-ahead stays inside the guarded task.
        drop(response);
        drop(working);
        return std::future::pending().await;
    }
    let (parts, incoming) = response.into_parts();
    // Keep Incoming's connection custody alive until the original head has been
    // consumed, including metadata-validation failures.
    let metadata = metadata(parts, budget)?;
    Ok(Exchange {
        incoming,
        metadata,
        _working: working,
    })
}

impl Exchange {
    /// Body ownership and decoder workspace remain charged together until actual drop.
    pub(super) async fn finish(
        mut self,
        budget: &ContextBudget,
        mut check: impl FnMut() -> Result<(), ErrorRecord>,
    ) -> Result<(ResponseMetadata, Arc<RetainedBody>), Failure> {
        let mut encoded = BodyBuffer::new(budget.bodies.clone(), MAXIMUM_BODY_BYTES);
        while let Some(frame) = self.incoming.frame().await {
            check()?;
            let frame = frame.map_err(|error| {
                let mut failure = network_failure(error);
                // Pinned response-body aborts have no ECONNRESET retry code.
                failure.connection_reset = false;
                failure
            })?;
            if let Some(bytes) = frame.data_ref() {
                encoded.append(bytes, "apiRequest.fetch")?;
            }
        }
        check()?;
        let body = response_decoder::decode(
            encoded.finish(),
            &self.metadata.encoding(),
            budget.bodies.clone(),
            check,
        )
        .await?;
        Ok((self.metadata, body))
    }
}

fn metadata(parts: Parts, budget: &ContextBudget) -> Result<ResponseMetadata, ErrorRecord> {
    let original = parts
        .extensions
        .get::<OriginalResponseHeaders>()
        .ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::Protocol,
                "apiRequest.fetch",
                "HTTP transport omitted original response headers",
            )
        })?;
    let headers: Vec<_> = original
        .iter()
        .map(|(name, value)| Header {
            name: latin1(name),
            value: latin1(value),
        })
        .collect();
    let status_text = latin1(original.reason_phrase());
    // Count JSON without allocating an encoded copy. The caller adds final URL and identifiers
    // and checks the complete response envelope again before registry publication.
    let mut encoded = EncodedSize(0);
    serde_json::to_writer(
        &mut encoded,
        &(parts.status.as_u16(), &status_text, &headers),
    )
    .map_err(|error| {
        ErrorRecord::new(ErrorCode::Protocol, "apiRequest.fetch", error.to_string())
    })?;
    if encoded.0 > MAXIMUM_METADATA_BYTES {
        return Err(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            "apiRequest.fetch",
            "API response metadata exceeds 256 KiB",
        ));
    }
    let capacity = status_text.capacity()
        + headers.capacity() * std::mem::size_of::<Header>()
        + headers
            .iter()
            .map(|header| header.name.capacity() + header.value.capacity())
            .sum::<usize>();
    // Reserve both the retained strings and their eventual JSON representation. The publication
    // owner will carry this reservation through the actual encoded-frame write.
    let capacity = budget
        .metadata
        .reserve(capacity + encoded.0, "apiRequest.fetch")?;
    Ok(ResponseMetadata {
        status: parts.status.as_u16(),
        status_text,
        headers,
        _capacity: capacity,
    })
}

struct EncodedSize(usize);
impl std::io::Write for EncodedSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("metadata size overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

/// Quota and owner failures embedded in connector errors must never become retryable errors.
fn request_head_failure(error: impl std::error::Error + 'static) -> Failure {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    let mut incomplete_response = false;
    while let Some(current) = source {
        if let Some(http) = current.downcast_ref::<hyper::Error>() {
            incomplete_response |= http.is_incomplete_message();
        }
        source = current.source();
    }
    let mut failure = network_failure(error);
    // Node reports EOF before a complete response head as ECONNRESET (socket hang up).
    if failure.error.code == ErrorCode::Request {
        failure.connection_reset |= incomplete_response;
    }
    failure
}

fn network_failure(error: impl std::error::Error + 'static) -> Failure {
    let mut deepest: &(dyn std::error::Error + 'static) = &error;
    let mut source = Some(deepest);
    let mut connection_reset = false;
    while let Some(current) = source {
        if let Some(original) = current.downcast_ref::<TransportError>() {
            return original.0.clone().into();
        }
        let network = current.downcast_ref::<std::io::Error>();
        if let Some(network) = network {
            connection_reset |= network.kind() == std::io::ErrorKind::ConnectionReset;
        }
        // Hyper's top-level label omits the actionable connection/TLS cause.
        deepest = current;
        // io::Error::source skips its custom payload and calls that payload's
        // source. Inspect get_ref first so a directly wrapped typed cause survives.
        source = network
            .and_then(|network| network.get_ref())
            .map(|inner| inner as &(dyn std::error::Error + 'static))
            .or_else(|| current.source());
    }
    Failure {
        error: ErrorRecord::new(
            ErrorCode::Request,
            "apiRequest.fetch",
            super::network_diagnostic::message(deepest),
        ),
        connection_reset,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        budget::EngineBudget, connector::SocketConnector, resolver::BoundedResolver, tls,
    };
    use super::*;
    use std::io::Write;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::watch;

    #[derive(Debug)]
    struct UnformattedWrapper(Box<dyn std::error::Error>);

    impl std::fmt::Display for UnformattedWrapper {
        fn fmt(&self, _formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("discarded error-chain labels must never be formatted");
        }
    }
    impl std::error::Error for UnformattedWrapper {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(self.0.as_ref())
        }
    }

    #[test]
    fn failure_classification_precedes_formatting_and_only_the_deepest_cause_is_rendered() {
        let failure = network_failure(UnformattedWrapper(Box::new(UnformattedWrapper(Box::new(
            std::io::Error::new(std::io::ErrorKind::ConnectionReset, "original reset"),
        )))));
        assert_eq!(failure.error.message.as_ref(), "original reset");
        assert_eq!(failure.error.code, ErrorCode::Request);
        assert!(failure.connection_reset);
        let failure = network_failure(UnformattedWrapper(Box::new(TransportError(
            ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "original.method",
                "original quota",
            ),
        ))));
        assert_eq!(failure.error.code, ErrorCode::ResourceLimit);
        assert_eq!(failure.error.method.as_ref(), "original.method");
        assert_eq!(failure.error.message.as_ref(), "original quota");
        assert!(!failure.connection_reset);
        for code in [ErrorCode::ResourceLimit, ErrorCode::TargetClosed] {
            let failure = network_failure(UnformattedWrapper(Box::new(std::io::Error::other(
                TransportError(ErrorRecord::new(
                    code,
                    "original.method",
                    "wrapped original",
                )),
            ))));
            assert_eq!(failure.error.code, code);
            assert_eq!(failure.error.method.as_ref(), "original.method");
            assert_eq!(failure.error.message.as_ref(), "wrapped original");
            assert!(!failure.connection_reset);
        }
        let failure = network_failure(std::io::Error::other(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "nested original reset",
        )));
        assert_eq!(failure.error.message.as_ref(), "nested original reset");
        assert!(failure.connection_reset);
    }

    #[tokio::test]
    async fn actual_http_preserves_raw_metadata_and_decodes_under_original_budgets() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let (closed, receiver) = watch::channel(false);
        let resolver =
            BoundedResolver::new(budget.lookups.clone(), owner.clone(), receiver.clone());
        let pool = tls::pool_custody(&budget.metadata, owner.clone()).unwrap();
        let client = tls::client(
            SocketConnector::new(resolver, budget.sockets.clone(), receiver, owner),
            false,
            budget.connections.clone(),
            pool,
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                assert!(request.len() < 4096);
            }
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(b"original decoded bytes").unwrap();
            let body = encoder.finish().unwrap();
            let mut response = b"HTTP/1.1 201 Custom \xe9\r\nX-Mixed: one\r\nx-mIXED: two\r\nX-Latin: \xff\r\nContent-Encoding: gzip\r\nConnection: close\r\nContent-Length: ".to_vec();
            response.extend_from_slice(body.len().to_string().as_bytes());
            response.extend_from_slice(b"\r\n\r\n");
            response.extend_from_slice(&body);
            socket.write_all(&response).await.unwrap();
        });
        let request = Request::get(destination)
            .body(Full::new(Bytes::new()))
            .unwrap();
        let exchange = start(&client, request, &budget, || Ok(())).await.unwrap();
        assert_eq!(exchange.metadata.status, 201);
        assert_eq!(exchange.metadata.status_text, "Custom é");
        assert_eq!(exchange.metadata.headers[0].name, "X-Mixed");
        assert_eq!(exchange.metadata.headers[1].name, "x-mIXED");
        assert_eq!(exchange.metadata.first("x-latin"), Some("ÿ"));
        assert!(budget.metadata.retained() >= HEADER_WORKING_BYTES);
        let (metadata, body) = exchange.finish(&budget, || Ok(())).await.unwrap();
        assert_eq!(body.bytes.as_slice(), b"original decoded bytes");
        assert!(budget.metadata.retained() < HEADER_WORKING_BYTES);
        drop((metadata, body));
        assert_eq!(budget.bodies.retained(), 0);
        closed.send_replace(true);
        drop(client);
        server.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while budget.metadata.retained() != 0 || budget.connections.retained() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn connector_quota_failure_cannot_be_reclassified_as_a_retryable_reset() {
        let original = ErrorRecord::new(
            ErrorCode::ResourceLimit,
            "apiRequest.fetch",
            "original quota",
        );
        let failure = network_failure(TransportError(original));
        assert_eq!(failure.error.code, ErrorCode::ResourceLimit);
        assert_eq!(failure.error.message.as_ref(), "original quota");
        assert!(!failure.connection_reset);
        assert!(
            network_failure(std::io::Error::from(std::io::ErrorKind::ConnectionReset))
                .connection_reset
        );
        assert!(
            !network_failure(std::io::Error::from(std::io::ErrorKind::ConnectionAborted))
                .connection_reset
        );
    }

    #[tokio::test]
    async fn oversized_final_headers_reject_before_connecting_and_successor_is_admitted() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let (_closed, receiver) = watch::channel(false);
        let resolver =
            BoundedResolver::new(budget.lookups.clone(), owner.clone(), receiver.clone());
        let pool = tls::pool_custody(&budget.metadata, owner.clone()).unwrap();
        let client = tls::client(
            SocketConnector::new(resolver, budget.sockets.clone(), receiver, owner),
            false,
            budget.connections.clone(),
            pool,
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = format!("http://{}/", listener.local_addr().unwrap());
        let oversized = Request::get(&destination)
            .header("x-large", "a".repeat(MAXIMUM_REQUEST_METADATA_BYTES))
            .body(Full::new(Bytes::new()))
            .unwrap();
        let failure = match start(&client, oversized, &budget, || Ok(())).await {
            Err(failure) => failure,
            Ok(_) => panic!("oversized final wire headers must fail"),
        };
        assert_eq!(failure.error.code, ErrorCode::ResourceLimit);
        assert!(!failure.connection_reset);
        assert_eq!(budget.metadata.retained(), tls::POOL_WORKING_BYTES);
        assert_eq!(budget.connections.retained(), 0);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), listener.accept())
                .await
                .is_err()
        );
        let valid = Request::get(&destination)
            .body(Full::new(Bytes::new()))
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let exchange = start(&client, valid, &budget, || Ok(())).await.unwrap();
        assert_eq!(exchange.metadata.status, 200);
        drop(exchange.finish(&budget, || Ok(())).await.unwrap());
        server.await.unwrap();
    }

    #[test]
    fn outgoing_admission_counts_uri_header_duplicates_and_generated_field_allowance() {
        let mut request = Request::get("http://a/")
            .header("x", "a".repeat(MAXIMUM_REQUEST_METADATA_BYTES - 143))
            .body(Full::new(Bytes::new()))
            .unwrap();
        // 128 framing allowance + GET(3) + http(4) + authority twice(2) + /(1) + x/colon/CRLF(5).
        assert!(validate_request_metadata(&request).is_ok());
        request.headers_mut().insert(
            "x",
            http::HeaderValue::from_str(&"a".repeat(MAXIMUM_REQUEST_METADATA_BYTES - 142)).unwrap(),
        );
        assert_eq!(
            validate_request_metadata(&request).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        let destination = format!("http://a/{}", "a".repeat(16 * 1024));
        let request = Request::get(destination)
            .header("x", "a".repeat(MAXIMUM_REQUEST_METADATA_BYTES - 16 * 1024))
            .body(Full::new(Bytes::new()))
            .unwrap();
        assert!(validate_request_metadata(&request).is_err());
        let mut request = Request::get("http://a/")
            .body(Full::new(Bytes::new()))
            .unwrap();
        for _ in 0..MAXIMUM_REQUEST_HEADERS {
            request
                .headers_mut()
                .append("x", http::HeaderValue::from_static("a"));
        }
        assert!(validate_request_metadata(&request).is_ok());
        request
            .headers_mut()
            .append("x", http::HeaderValue::from_static("a"));
        assert!(validate_request_metadata(&request).is_err());
    }

    #[tokio::test]
    async fn upgrade_and_connect_replies_wait_for_outer_deadline_without_retaining_transport() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let (_closed, receiver) = watch::channel(false);
        let resolver =
            BoundedResolver::new(budget.lookups.clone(), owner.clone(), receiver.clone());
        let pool = tls::pool_custody(&budget.metadata, owner.clone()).unwrap();
        let client = tls::client(
            SocketConnector::new(resolver, budget.sockets.clone(), receiver, owner),
            false,
            budget.connections.clone(),
            pool,
        );
        for method in [http::Method::GET, http::Method::CONNECT] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let destination = format!("http://{}/", listener.local_addr().unwrap());
            let response: &[u8] = if method == http::Method::CONNECT {
                b"HTTP/1.1 200 Connected\r\n\r\nread-ahead"
            } else {
                b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nread-ahead"
            };
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                socket.write_all(response).await.unwrap();
            });
            let request = Request::builder()
                .method(method)
                .uri(destination)
                .body(Full::new(Bytes::new()))
                .unwrap();
            assert!(
                tokio::time::timeout(
                    std::time::Duration::from_millis(100),
                    start(&client, request, &budget, || Ok(()))
                )
                .await
                .is_err()
            );
            server.await.unwrap();
            assert_eq!(budget.metadata.retained(), tls::POOL_WORKING_BYTES);
            assert_eq!(budget.connections.retained(), 0);
            assert!(budget.sockets.reserve(16, "test").is_ok());
        }
        drop(client);
        assert_eq!(budget.metadata.retained(), 0);
    }
}
