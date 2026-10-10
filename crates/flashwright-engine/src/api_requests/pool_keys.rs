//! Pool keys own compact origin bytes and keep their pool allowance through late task teardown.

use super::super::budget::{ContextBudget, EngineBudget};
use super::super::connection_custody::BudgetedConnector;
use super::super::connector::SocketConnector;
use super::super::resolver::BoundedResolver;
use super::response_custody::TrackedExecutor;
use super::{POOL_WORKING_BYTES, pool_custody};
use bytes::Bytes;
use http::{Request, Uri};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};

fn client(
    engine: &EngineBudget,
    budget: &ContextBudget,
    active_tasks: Arc<AtomicUsize>,
) -> (
    Client<BudgetedConnector<SocketConnector>, Full<Bytes>>,
    watch::Sender<bool>,
) {
    let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
    let (closed, receiver) = watch::channel(false);
    let resolver = BoundedResolver::new(budget.lookups.clone(), owner.clone(), receiver.clone());
    let connector = SocketConnector::new(resolver, budget.sockets.clone(), receiver, owner.clone());
    let client = Client::builder(TrackedExecutor(active_tasks))
        .pool_custody(pool_custody(&budget.metadata, owner.clone()).unwrap())
        .pool_max_idle_per_host(1)
        .build(BudgetedConnector::new(
            connector,
            budget.connections.clone(),
            owner,
        ));
    (client, closed)
}

async fn read_head(socket: &mut TcpStream) {
    let mut received = Vec::new();
    let mut buffer = [0; 4096];
    while !received.ends_with(b"\r\n\r\n") {
        let length = socket.read(&mut buffer).await.unwrap();
        assert_ne!(length, 0);
        received.extend_from_slice(&buffer[..length]);
        assert!(received.len() < 1024 * 1024);
    }
}

struct UriOwner {
    bytes: Vec<u8>,
    dropped: Arc<AtomicBool>,
}
impl AsRef<[u8]> for UriOwner {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Drop for UriOwner {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn idle_origin_key_releases_the_original_long_request_uri() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let active_tasks = Arc::new(AtomicUsize::new(0));
        let (client, closed) = client(&engine, &budget, active_tasks.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let owned_uri = UriOwner {
            bytes: format!(
                "http://{}/{}",
                listener.local_addr().unwrap(),
                "a".repeat(16 * 1024)
            )
            .into_bytes(),
            dropped: dropped.clone(),
        };
        let destination = Uri::from_maybe_shared(Bytes::from_owner(owned_uri)).unwrap();
        assert!(!dropped.load(Ordering::SeqCst));
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_head(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
            released.await.unwrap();
        });
        let response = client
            .request(
                Request::get(destination)
                    .body(Full::new(Bytes::new()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "ok"
        );
        assert_eq!(budget.sockets.retained(), 1);
        assert!(
            dropped.load(Ordering::SeqCst),
            "idle origin must not retain the original URI path allocation"
        );
        closed.send_replace(true);
        drop(client);
        release.send(()).unwrap();
        server.await.unwrap();
        while active_tasks.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(budget.metadata.retained(), 0);
        assert_eq!(budget.connections.retained(), 0);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn pending_pool_owner_keeps_pool_credit_after_last_client_drop() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let active_tasks = Arc::new(AtomicUsize::new(0));
        let (client, closed) = client(&engine, &budget, active_tasks.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = format!("http://{}/", listener.local_addr().unwrap());
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_head(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n")
                .await
                .unwrap();
            released.await.unwrap();
            socket.write_all(b"ok").await.unwrap();
        });
        let response = client
            .request(
                Request::get(destination)
                    .body(Full::new(Bytes::new()))
                    .unwrap(),
            )
            .await
            .unwrap();
        drop(client);
        assert!(active_tasks.load(Ordering::SeqCst) > 0);
        assert_eq!(budget.metadata.retained(), POOL_WORKING_BYTES);
        release.send(()).unwrap();
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "ok"
        );
        closed.send_replace(true);
        server.await.unwrap();
        while active_tasks.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(budget.metadata.retained(), 0);
        assert_eq!(budget.connections.retained(), 0);
    })
    .await
    .unwrap();
}
