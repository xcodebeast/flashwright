//! A reused socket must cancel the speculative connection that lost the same request's race.

use super::super::budget::{CONNECTION_WORKING_BYTES, ContextBudget, EngineBudget};
use super::super::connector::SocketConnection;
use super::super::resolver::BoundedResolver;
use super::super::transport_error::BoxedError;
use super::*;
use http::Uri;
use http_body_util::BodyExt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Notify, oneshot, watch};
use tower_service::Service;

struct PendingConnect {
    dropped: Arc<AtomicBool>,
}

impl Drop for PendingConnect {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct DelayedSecondConnector {
    inner: SocketConnector,
    calls: Arc<AtomicUsize>,
    second_started: Arc<Notify>,
    second_dropped: Arc<AtomicBool>,
}

impl Service<Uri> for DelayedSecondConnector {
    type Response = SocketConnection;
    type Error = BoxedError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, destination: Uri) -> Self::Future {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return self.inner.call(destination);
        }
        let pending = PendingConnect {
            dropped: self.second_dropped.clone(),
        };
        self.second_started.notify_one();
        Box::pin(async move {
            let _pending = pending;
            std::future::pending().await
        })
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) {
    let mut received = Vec::new();
    while !received.ends_with(b"\r\n\r\n") {
        received.push(socket.read_u8().await.unwrap());
        assert!(received.len() < 4096);
    }
}

#[tokio::test]
async fn pool_reuse_cancels_a_started_losing_connect_and_releases_its_credit() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let (closed, closed_receiver) = watch::channel(false);
        let resolver = BoundedResolver::new(
            budget.lookups.clone(),
            owner.clone(),
            closed_receiver.clone(),
        );
        let second_started = Arc::new(Notify::new());
        let second_dropped = Arc::new(AtomicBool::new(false));
        let connector = DelayedSecondConnector {
            inner: SocketConnector::new(
                resolver,
                budget.sockets.clone(),
                closed_receiver,
                owner.clone(),
            ),
            calls: Arc::new(AtomicUsize::new(0)),
            second_started: second_started.clone(),
            second_dropped: second_dropped.clone(),
        };
        let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new())
            .pool_custody(pool_custody(&budget.metadata, owner.clone()).unwrap())
            .cancel_unused_connects(true)
            .build(BudgetedConnector::new(
                connector,
                budget.connections.clone(),
                owner,
            ));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination: Uri = format!("http://{}/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let (first_seen, first_ready) = oneshot::channel();
        let (release_first, first_released) = oneshot::channel();
        let (release_server, server_released) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            first_seen.send(()).unwrap();
            first_released.await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\non")
                .await
                .unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\ntw")
                .await
                .unwrap();
            server_released.await.unwrap();
        });
        let first_client = client.clone();
        let first_destination = destination.clone();
        let first = tokio::spawn(async move {
            first_client
                .get(first_destination)
                .await
                .unwrap()
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
        });
        first_ready.await.unwrap();
        let second_client = client.clone();
        let second = tokio::spawn(async move {
            second_client
                .get(destination)
                .await
                .unwrap()
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
        });
        second_started.notified().await;
        assert_eq!(budget.connections.retained(), 2 * CONNECTION_WORKING_BYTES);
        release_first.send(()).unwrap();
        assert_eq!(first.await.unwrap(), "on");
        assert_eq!(second.await.unwrap(), "tw");
        assert!(second_dropped.load(Ordering::SeqCst));
        assert_eq!(budget.connections.retained(), CONNECTION_WORKING_BYTES);
        closed.send_replace(true);
        drop(client);
        release_server.send(()).unwrap();
        server.await.unwrap();
        while budget.connections.retained() != 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(budget.metadata.retained(), 0);
    })
    .await
    .unwrap();
}
