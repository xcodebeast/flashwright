//! Explicit TLS policies own separate pools; ignored certificate trust never leaks into strict calls.
use std::sync::Arc;
use std::time::Duration;

use hyper_rustls::HttpsConnectorBuilder;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls13_signature_with_raw_key};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error, RootCertStore, SignatureScheme};

use super::budget::{PairedBudget, PairedReservation, Reservation};
use super::connection_custody::BudgetedConnector;
use super::connector::SocketConnector;
use bytes::Bytes;
use flashwright_protocol::ErrorRecord;
use http_body_util::Full;
use hyper_rustls::HttpsConnector;
use std::sync::OnceLock;

pub(super) type HttpClient =
    Client<BudgetedConnector<HttpsConnector<SocketConnector>>, Full<Bytes>>;

// Each pool has at most 1024 waiters and 16 idle sockets. Its hash tables retain
// spare buckets after those owners leave; their separate credit lives with PoolInner.
pub(super) const POOL_WORKING_BYTES: usize = 512 * 1024;

#[derive(Debug)]
pub(super) struct PoolCustody {
    _memory: PairedReservation,
    _owner: Arc<Reservation>,
}

pub(super) fn pool_custody(
    budget: &PairedBudget,
    owner: Arc<Reservation>,
) -> Result<Arc<PoolCustody>, ErrorRecord> {
    Ok(Arc::new(PoolCustody {
        _memory: budget.reserve(POOL_WORKING_BYTES, "apiRequest.newContext")?,
        _owner: owner,
    }))
}

/// The caller computes the pinned context-OR-call policy. Separate clients prevent
/// strict calls from reusing a connection whose certificate trust was ignored.
pub(super) fn client(
    connector: SocketConnector,
    ignore_https_errors: bool,
    memory: PairedBudget,
    pool_custody: Arc<PoolCustody>,
) -> HttpClient {
    let owner = connector.owner_credit();
    static STRICT: OnceLock<ClientConfig> = OnceLock::new();
    static IGNORING: OnceLock<ClientConfig> = OnceLock::new();
    let configuration = if ignore_https_errors {
        &IGNORING
    } else {
        &STRICT
    }
    .get_or_init(|| configuration(ignore_https_errors))
    .clone();
    let connector = HttpsConnectorBuilder::new()
        .with_tls_config(configuration)
        .https_or_http()
        .enable_http1()
        .wrap_connector(connector);
    Client::builder(TokioExecutor::new())
        .pool_custody(pool_custody)
        .cancel_unused_connects(true)
        .http1_writev(true)
        .http1_preserve_header_case(true)
        .http1_max_buf_size(256 * 1024)
        .http1_max_headers(1024)
        .retry_canceled_requests(false)
        .pool_max_idle_per_host(1)
        .pool_timer(TokioTimer::new())
        .pool_idle_timeout(Duration::from_secs(5))
        .build(BudgetedConnector::new(connector, memory, owner))
}

pub(super) fn configuration(ignore_https_errors: bool) -> ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut configuration = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the pinned Ring provider supports TLS 1.2 and TLS 1.3")
        .with_root_certificates(roots)
        .with_no_client_auth();
    // The default cache outlives contexts through the shared configurations and
    // retains opaque certificate/ticket allocations. Enable resumption only with
    // an owned cache whose retained allocations have independent lifetime credits.
    configuration.resumption = rustls::client::Resumption::disabled();
    if ignore_https_errors {
        configuration
            .dangerous()
            .set_certificate_verifier(Arc::new(ExplicitlyIgnoredCertificate { provider }));
    }
    configuration
}

/// Bypasses certificate identity/trust only when explicitly requested. Handshake
/// signatures still require proof of possession of the presented private key.
#[derive(Debug)]
struct ExplicitlyIgnoredCertificate {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for ExplicitlyIgnoredCertificate {
    fn verify_server_cert(
        &self,
        _certificate: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        let public_key = super::certificate_key::subject_public_key_info(certificate)?;
        let key = webpki::RawPublicKeyEntity::try_from(&public_key)
            .map_err(|_| Error::InvalidCertificate(rustls::CertificateError::BadEncoding))?;
        let algorithms = self
            .provider
            .signature_verification_algorithms
            .mapping
            .iter()
            .find(|(scheme, _)| *scheme == signature.scheme)
            .map(|(_, algorithms)| *algorithms)
            .ok_or(Error::PeerMisbehaved(
                rustls::PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme,
            ))?;
        for algorithm in algorithms {
            if key
                .verify_signature(*algorithm, message, signature.signature())
                .is_ok()
            {
                return Ok(HandshakeSignatureValid::assertion());
            }
        }
        Err(Error::InvalidCertificate(
            rustls::CertificateError::BadSignature,
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        let public_key = super::certificate_key::subject_public_key_info(certificate)?;
        verify_tls13_signature_with_raw_key(
            message,
            &public_key,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
#[path = "connection_races.rs"]
mod connection_races;

#[cfg(test)]
mod tests {
    use super::super::budget::{ContextBudget, EngineBudget};
    use super::super::resolver::BoundedResolver;
    use super::*;
    use http_body_util::BodyExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, watch};

    async fn wait_for_connection_release(budget: &ContextBudget) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while budget.connections.retained() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(budget.sockets.reserve(16, "test").is_ok());
    }

    fn test_client(
        engine: &EngineBudget,
        budget: &ContextBudget,
    ) -> (
        HttpClient,
        watch::Sender<bool>,
        std::sync::Weak<super::super::budget::Reservation>,
    ) {
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let original_owner = Arc::downgrade(&owner);
        let (closed_sender, closed_receiver) = watch::channel(false);
        let resolver = BoundedResolver::new(
            budget.lookups.clone(),
            owner.clone(),
            closed_receiver.clone(),
        );
        let pool = pool_custody(&budget.metadata, owner.clone()).unwrap();
        let connector =
            SocketConnector::new(resolver, budget.sockets.clone(), closed_receiver, owner);
        (
            client(connector, false, budget.connections.clone(), pool),
            closed_sender,
            original_owner,
        )
    }

    #[tokio::test]
    async fn pending_real_tls_handshake_releases_on_cancellation_and_owner_close() {
        for close_owner in [false, true] {
            let engine = EngineBudget::default();
            let budget = ContextBudget::new(&engine);
            let (client, closed, original_owner) = test_client(&engine, &budget);
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let destination = format!("https://{}/", listener.local_addr().unwrap());
            let pending_client = client.clone();
            let pending = tokio::spawn(async move {
                pending_client
                    .request(
                        http::Request::get(destination)
                            .body(Full::new(Bytes::new()))
                            .unwrap(),
                    )
                    .await
            });
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut record = [0; 4096];
            assert!(socket.read(&mut record).await.unwrap() > 0);
            assert_eq!(record[0], 22, "received the real TLS ClientHello");
            assert_eq!(
                budget.connections.retained(),
                super::super::connection_custody::CONNECTION_WORKING_BYTES
            );
            assert!(original_owner.upgrade().is_some());
            if close_owner {
                closed.send_replace(true);
                assert!(
                    tokio::time::timeout(Duration::from_secs(2), pending)
                        .await
                        .unwrap()
                        .unwrap()
                        .is_err()
                );
            } else {
                pending.abort();
                assert!(pending.await.unwrap_err().is_cancelled());
            }
            drop(client);
            wait_for_connection_release(&budget).await;
            assert!(original_owner.upgrade().is_none());
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut record))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        }
    }

    #[tokio::test]
    async fn real_tls_and_http_parser_failures_release_before_healthy_successor() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let (client, closed, original_owner) = test_client(&engine, &budget);
        for (scheme, healthy) in [("https", false), ("http", false), ("http", true)] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let destination = format!("{scheme}://{}/", listener.local_addr().unwrap());
            let response_bytes: &[u8] = if healthy {
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
            } else {
                b"invalid protocol\r\n\r\n"
            };
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                socket.write_all(response_bytes).await.unwrap();
            });
            let result = client
                .request(
                    http::Request::get(destination)
                        .body(Full::new(Bytes::new()))
                        .unwrap(),
                )
                .await;
            if healthy {
                assert_eq!(
                    result
                        .unwrap()
                        .into_body()
                        .collect()
                        .await
                        .unwrap()
                        .to_bytes(),
                    "ok"
                );
            } else {
                assert!(result.is_err());
                if scheme == "https" {
                    assert_eq!(
                        budget.connections.retained(),
                        super::super::connection_custody::CONNECTION_WORKING_BYTES
                    );
                }
                drop(result);
            }
            server.await.unwrap();
            wait_for_connection_release(&budget).await;
        }
        closed.send_replace(true);
        drop(client);
        assert!(original_owner.upgrade().is_none());
    }

    #[tokio::test]
    async fn upgrade_responses_never_transfer_io_or_read_ahead_outside_guarded_dispatcher() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let (client, closed, original_owner) = test_client(&engine, &budget);
        for method in [http::Method::GET, http::Method::CONNECT] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let destination = format!("http://{}/", listener.local_addr().unwrap());
            let mut reply = if method == http::Method::CONNECT {
                b"HTTP/1.1 200 Connected\r\n\r\n".to_vec()
            } else {
                b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n"
                    .to_vec()
            };
            reply.extend_from_slice(&[42; 4096]);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                let _ = socket.write_all(&reply).await;
            });
            let mut response = client
                .request(
                    http::Request::builder()
                        .method(method)
                        .uri(destination)
                        .body(Full::new(Bytes::new()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(hyper::upgrade::on(&mut response).await.is_err());
            drop(response);
            server.await.unwrap();
            wait_for_connection_release(&budget).await;
        }
        closed.send_replace(true);
        drop(client);
        assert!(original_owner.upgrade().is_none());
    }

    /// Real HTTP connections must release their quota on timer expiry while the client stays alive.
    #[tokio::test]
    async fn pooled_socket_reuse_expiry_and_context_close_release_original_custody() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let original_owner = Arc::downgrade(&owner);
        let (closed_sender, closed_receiver) = watch::channel(false);
        let resolver = BoundedResolver::new(
            budget.lookups.clone(),
            owner.clone(),
            closed_receiver.clone(),
        );
        let pool = pool_custody(&budget.metadata, owner.clone()).unwrap();
        let connector =
            SocketConnector::new(resolver, budget.sockets.clone(), closed_receiver, owner);
        let client = client(connector, false, budget.connections.clone(), pool);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = format!("http://{}/", listener.local_addr().unwrap());
        let (events_sender, mut events_receiver) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            for connection in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                events_sender.send((connection, "accepted")).unwrap();
                loop {
                    let mut request = Vec::new();
                    let mut byte = [0];
                    loop {
                        if socket.read(&mut byte).await.unwrap() == 0 {
                            assert!(request.is_empty());
                            break;
                        }
                        request.push(byte[0]);
                        assert!(request.len() < 4096);
                        if request.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    if request.is_empty() {
                        break;
                    }
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                        .await
                        .unwrap();
                    events_sender.send((connection, "response")).unwrap();
                }
                events_sender.send((connection, "closed")).unwrap();
            }
        });
        for _ in 0..2 {
            let request = http::Request::get(&destination)
                .body(Full::new(Bytes::new()))
                .unwrap();
            let response = client.request(request).await.unwrap();
            assert_eq!(
                response.into_body().collect().await.unwrap().to_bytes(),
                "ok"
            );
        }
        assert_eq!(events_receiver.recv().await.unwrap(), (0, "accepted"));
        assert_eq!(events_receiver.recv().await.unwrap(), (0, "response"));
        assert_eq!(events_receiver.recv().await.unwrap(), (0, "response"));
        assert!(budget.sockets.reserve(16, "test").is_err());
        assert_eq!(
            budget.connections.retained(),
            super::super::connection_custody::CONNECTION_WORKING_BYTES
        );
        // Hyper rejects reuse after five seconds; its periodic sweep can take a second interval.
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(12), events_receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            (0, "closed")
        );
        assert!(budget.sockets.reserve(16, "test").is_ok());
        tokio::time::timeout(Duration::from_secs(1), async {
            while budget.connections.retained() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            budget.metadata.retained(),
            POOL_WORKING_BYTES,
            "idle pool table custody survives socket expiry"
        );
        let request = http::Request::get(&destination)
            .body(Full::new(Bytes::new()))
            .unwrap();
        client
            .request(request)
            .await
            .unwrap()
            .into_body()
            .collect()
            .await
            .unwrap();
        assert_eq!(events_receiver.recv().await.unwrap(), (1, "accepted"));
        assert_eq!(events_receiver.recv().await.unwrap(), (1, "response"));
        closed_sender.send_replace(true);
        drop(client);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), events_receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            (1, "closed")
        );
        server.await.unwrap();
        assert!(budget.sockets.reserve(16, "test").is_ok());
        assert!(original_owner.upgrade().is_none());
        assert_eq!(budget.connections.retained(), 0);
        assert_eq!(budget.metadata.retained(), 0);
    }
}
