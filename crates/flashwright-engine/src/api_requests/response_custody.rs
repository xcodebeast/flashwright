//! Returned HTTP allocations retain the connection credit after the socket closes.

use super::super::budget::{CONNECTION_WORKING_BYTES, ContextBudget, EngineBudget};
use super::super::connection_custody::BudgetedConnector;
use super::super::connector::SocketConnector;
use super::super::resolver::BoundedResolver;
use super::pool_custody;
use bytes::Bytes;
use http::{HeaderValue, Request, header::HeaderName};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use std::future::Future;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

#[derive(Clone)]
struct TrackedExecutor(Arc<AtomicUsize>);

impl<Work> hyper::rt::Executor<Work> for TrackedExecutor
where
    Work: Future + Send + 'static,
    Work::Output: Send,
{
    fn execute(&self, work: Work) {
        self.0.fetch_add(1, Ordering::SeqCst);
        let active = self.0.clone();
        tokio::spawn(async move {
            work.await;
            active.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

#[tokio::test]
async fn returned_response_retains_original_credit_after_socket_and_client_drop() {
    tokio::time::timeout(Duration::from_secs(5), async {
        for (reply, read_body) in [
            (
                &b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"[..],
                true,
            ),
            (
                &b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"[..],
                true,
            ),
            (
                &b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"[..],
                false,
            ),
            (
                &b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok"[..],
                true,
            ),
        ] {
            let engine = EngineBudget::default();
            let budget = ContextBudget::new(&engine);
            let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
            let original_owner = Arc::downgrade(&owner);
            let (closed, closed_receiver) = watch::channel(false);
            let resolver = BoundedResolver::new(
                budget.lookups.clone(),
                owner.clone(),
                closed_receiver.clone(),
            );
            let connector = SocketConnector::new(
                resolver,
                budget.sockets.clone(),
                closed_receiver,
                owner.clone(),
            );
            let active_tasks = Arc::new(AtomicUsize::new(0));
            let client: Client<_, Full<Bytes>> =
                Client::builder(TrackedExecutor(active_tasks.clone()))
                    .pool_custody(pool_custody(&budget.metadata, owner.clone()).unwrap())
                    .build(BudgetedConnector::new(
                        connector,
                        budget.connections.clone(),
                        owner,
                    ));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let destination = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut received = Vec::new();
                let mut buffer = [0; 4096];
                while !received.ends_with(b"\r\n\r\n") {
                    let length = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(length, 0);
                    received.extend_from_slice(&buffer[..length]);
                    assert!(received.len() < 1024 * 1024);
                }
                socket.write_all(reply).await.unwrap();
            });
            let mut request = Request::get(destination)
                .body(Full::new(Bytes::new()))
                .unwrap();
            for index in 0..3000 {
                request.headers_mut().insert(
                    HeaderName::from_bytes(format!("x-request-{index}").as_bytes()).unwrap(),
                    HeaderValue::from_static("value"),
                );
            }
            let original_capacity = request.headers().capacity();
            let response = client.request(request).await.unwrap();
            assert!(response.headers().capacity() >= original_capacity);
            let (parts, mut incoming) = response.into_parts();
            let mut received = Vec::new();
            let mut failed = false;
            if read_body {
                while let Some(frame) = incoming.frame().await {
                    match frame {
                        Ok(frame) => {
                            if let Some(bytes) = frame.data_ref() {
                                received.extend_from_slice(bytes);
                            }
                        }
                        Err(_) => {
                            failed = true;
                            break;
                        }
                    }
                }
            }
            assert_eq!(
                failed,
                reply.windows(17).any(|part| part == b"Content-Length: 3")
            );
            assert_eq!(
                received,
                if parts.status == 204 || !read_body {
                    b""
                } else {
                    &b"ok"[..]
                }
            );
            server.await.unwrap();
            closed.send_replace(true);
            drop(client);
            while active_tasks.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
            assert_eq!(budget.sockets.retained(), 0);
            assert_eq!(budget.metadata.retained(), 0);
            assert_eq!(budget.connections.retained(), CONNECTION_WORKING_BYTES);
            assert!(original_owner.upgrade().is_some());
            drop(parts);
            assert_eq!(budget.connections.retained(), CONNECTION_WORKING_BYTES);
            drop(incoming);
            assert_eq!(budget.connections.retained(), 0);
            assert!(original_owner.upgrade().is_none());
        }
    })
    .await
    .unwrap();
}
