//! Connection work keeps its original memory and owner credits outside TLS and HTTP state.

pub(super) use super::budget::CONNECTION_WORKING_BYTES;
use super::budget::{PairedBudget, PairedReservation, Reservation};
use super::transport_error::{BoxedError, TransportError};
use http::Uri;
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper_util::client::legacy::connect::{Connected, Connection};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tower_service::Service;

#[derive(Debug)]
struct ConnectionCustody {
    _memory: PairedReservation,
    _owner: Arc<Reservation>,
}

/// A failed handshake can return owned certificate diagnostics. Keep their original
/// credit until the returned error chain is converted or dropped, not merely until
/// the connector future finishes.
#[derive(Debug)]
struct CustodiedError {
    inner: BoxedError,
    _custody: Arc<ConnectionCustody>,
}
impl std::fmt::Display for CustodiedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.inner.fmt(formatter)
    }
}
impl std::error::Error for CustodiedError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.inner.as_ref())
    }
}

#[derive(Clone)]
pub(super) struct BudgetedConnector<Connector> {
    inner: Connector,
    budget: PairedBudget,
    owner: Arc<Reservation>,
}

impl<Connector> BudgetedConnector<Connector> {
    pub(super) fn new(inner: Connector, budget: PairedBudget, owner: Arc<Reservation>) -> Self {
        Self {
            inner,
            budget,
            owner,
        }
    }
}

/// Field order matters on cancellation: drop the whole pending handshake before its credit.
struct CustodiedFuture<Inner> {
    inner: Pin<Box<Inner>>,
    _custody: Arc<ConnectionCustody>,
}

impl<Inner: Future> Future for CustodiedFuture<Inner> {
    type Output = Inner::Output;
    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        self.inner.as_mut().poll(context)
    }
}

impl<Connector> Service<Uri> for BudgetedConnector<Connector>
where
    Connector: Service<Uri>,
    Connector::Error: Into<BoxedError>,
    Connector::Future: Send + 'static,
    Connector::Response: Send + 'static,
{
    type Response = BudgetedStream<Connector::Response>;
    type Error = BoxedError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context).map_err(Into::into)
    }

    fn call(&mut self, destination: Uri) -> Self::Future {
        let memory = match self
            .budget
            .reserve(CONNECTION_WORKING_BYTES, "apiRequest.fetch")
        {
            Ok(memory) => memory,
            Err(error) => {
                return Box::pin(async { Err(Box::new(TransportError(error)) as BoxedError) });
            }
        };
        let custody = Arc::new(ConnectionCustody {
            _memory: memory,
            _owner: self.owner.clone(),
        });
        let connecting = self.inner.call(destination);
        let stream_custody = custody.clone();
        let future = async move {
            let inner = connecting.await.map_err(|error| {
                Box::new(CustodiedError {
                    inner: error.into(),
                    _custody: stream_custody.clone(),
                }) as BoxedError
            })?;
            Ok(BudgetedStream {
                inner,
                custody: stream_custody,
            })
        };
        Box::pin(CustodiedFuture {
            inner: Box::pin(future),
            _custody: custody,
        })
    }
}

/// Drop the entire TLS stream before the final connector-held memory credit.
/// Hyper Util separately carries the same credit outside its HTTP connection task.
pub(super) struct BudgetedStream<Stream> {
    inner: Stream,
    custody: Arc<ConnectionCustody>,
}

impl<Stream: Connection> Connection for BudgetedStream<Stream> {
    fn connected(&self) -> Connected {
        self.inner
            .connected()
            .with_custody(self.custody.clone())
            .without_upgrades()
    }
}

impl<Stream: Read + Unpin> Read for BudgetedStream<Stream> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl<Stream: Write + Unpin> Write for BudgetedStream<Stream> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        // Tokio Rustls otherwise moves a pending KeyUpdate reply into its output
        // queue before checking application capacity. Retrying a blocked write
        // could therefore grow that queue indefinitely while peer reads progress.
        std::task::ready!(Pin::new(&mut self.inner).poll_flush(context))?;
        Pin::new(&mut self.inner).poll_write(context, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(context)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        std::task::ready!(Pin::new(&mut self.inner).poll_flush(context))?;
        Pin::new(&mut self.inner).poll_write_vectored(context, buffers)
    }
}

#[cfg(test)]
#[path = "tls_backpressure.rs"]
mod tls_backpressure;

#[cfg(test)]
mod tests {
    use super::super::budget::EngineBudget;
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::task::Waker;

    struct PendingHandshake {
        budget: PairedBudget,
        dropped: Arc<AtomicBool>,
    }
    impl Future for PendingHandshake {
        type Output = Result<(), BoxedError>;
        fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Pending
        }
    }
    impl Drop for PendingHandshake {
        fn drop(&mut self) {
            assert_eq!(self.budget.retained(), CONNECTION_WORKING_BYTES);
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    #[derive(Clone)]
    struct PendingConnector {
        budget: PairedBudget,
        called: Arc<AtomicBool>,
        dropped: Arc<AtomicBool>,
    }
    impl Service<Uri> for PendingConnector {
        type Response = ();
        type Error = BoxedError;
        type Future = PendingHandshake;
        fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn call(&mut self, _destination: Uri) -> Self::Future {
            self.called.store(true, Ordering::SeqCst);
            PendingHandshake {
                budget: self.budget.clone(),
                dropped: self.dropped.clone(),
            }
        }
    }

    #[test]
    fn cancelled_handshake_drops_all_inner_state_before_returning_credit() {
        let engine = EngineBudget::default();
        let budget = PairedBudget::testing(CONNECTION_WORKING_BYTES);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let called = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        let inner = PendingConnector {
            budget: budget.clone(),
            called: called.clone(),
            dropped: dropped.clone(),
        };
        let mut connector = BudgetedConnector::new(inner, budget.clone(), owner);
        let mut pending = connector.call("https://example.test/".parse().unwrap());
        assert!(called.load(Ordering::SeqCst));
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        assert_eq!(budget.retained(), CONNECTION_WORKING_BYTES);
        drop(pending);
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(budget.retained(), 0);
    }

    #[test]
    fn memory_pressure_rejects_before_starting_dns_or_tls() {
        let engine = EngineBudget::default();
        let budget = PairedBudget::testing(CONNECTION_WORKING_BYTES - 1);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let called = Arc::new(AtomicBool::new(false));
        let inner = PendingConnector {
            budget: budget.clone(),
            called: called.clone(),
            dropped: Arc::new(AtomicBool::new(false)),
        };
        let mut connector = BudgetedConnector::new(inner, budget.clone(), owner);
        let mut pending = connector.call("https://example.test/".parse().unwrap());
        let mut context = Context::from_waker(Waker::noop());
        let Poll::Ready(Err(error)) = pending.as_mut().poll(&mut context) else {
            panic!("must reject immediately")
        };
        assert_eq!(
            error.downcast_ref::<TransportError>().unwrap().0.code,
            flashwright_protocol::ErrorCode::ResourceLimit
        );
        assert!(!called.load(Ordering::SeqCst));
        assert_eq!(budget.retained(), 0);
    }
    #[derive(Debug)]
    struct OwnedFailure {
        _payload: Vec<u8>,
        budget: PairedBudget,
        dropped: Arc<AtomicBool>,
    }
    impl std::fmt::Display for OwnedFailure {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("owned handshake failure")
        }
    }
    impl std::error::Error for OwnedFailure {}
    impl Drop for OwnedFailure {
        fn drop(&mut self) {
            assert_eq!(self.budget.retained(), CONNECTION_WORKING_BYTES);
            self.dropped.store(true, Ordering::SeqCst);
        }
    }
    struct FailingConnector {
        budget: PairedBudget,
        dropped: Arc<AtomicBool>,
    }
    impl Service<Uri> for FailingConnector {
        type Response = ();
        type Error = OwnedFailure;
        type Future = std::future::Ready<Result<(), OwnedFailure>>;
        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn call(&mut self, _: Uri) -> Self::Future {
            std::future::ready(Err(OwnedFailure {
                _payload: vec![1; 65535],
                budget: self.budget.clone(),
                dropped: self.dropped.clone(),
            }))
        }
    }
    #[test]
    fn completed_handshake_error_retains_credit_until_original_diagnostics_drop() {
        let engine = EngineBudget::default();
        let budget = PairedBudget::testing(CONNECTION_WORKING_BYTES);
        let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
        let dropped = Arc::new(AtomicBool::new(false));
        let inner = FailingConnector {
            budget: budget.clone(),
            dropped: dropped.clone(),
        };
        let mut connector = BudgetedConnector::new(inner, budget.clone(), owner);
        let mut pending = connector.call("https://example.test/".parse().unwrap());
        let mut context = Context::from_waker(Waker::noop());
        let Poll::Ready(Err(error)) = pending.as_mut().poll(&mut context) else {
            panic!("must return original failure");
        };
        drop(pending);
        drop(connector);
        assert_eq!(budget.retained(), CONNECTION_WORKING_BYTES);
        assert!(!dropped.load(Ordering::SeqCst));
        assert_eq!(error.to_string(), "owned handshake failure");
        assert!(
            error
                .source()
                .unwrap()
                .downcast_ref::<OwnedFailure>()
                .is_some()
        );
        drop(error);
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(budget.retained(), 0);
    }
}
