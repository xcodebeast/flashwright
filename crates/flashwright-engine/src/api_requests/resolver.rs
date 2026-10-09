//! OS name resolution can outlive cancellation; its original owner and permits cannot.

use super::budget::{PairedBudget, PairedReservation, Reservation};
use super::transport_error::{BoxedError, TransportError, closed};
use flashwright_protocol::{ErrorCode, ErrorRecord};
use hyper_util::client::legacy::connect::dns::Name;
use std::future::Future;
use std::net::{SocketAddr, ToSocketAddrs};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tower_service::Service;

#[derive(Clone, Debug)]
pub(super) struct BoundedResolver {
    budget: PairedBudget,
    owner: Arc<Reservation>,
    closed: watch::Receiver<bool>,
}

impl BoundedResolver {
    pub(super) fn new(
        budget: PairedBudget,
        owner: Arc<Reservation>,
        closed: watch::Receiver<bool>,
    ) -> Self {
        Self {
            budget,
            owner,
            closed,
        }
    }

    /// Move credits into the blocking closure itself. Aborting a JoinHandle cannot
    /// interrupt a running getaddrinfo, and dropping its awaiting future is not settlement.
    fn start_lookup(
        &self,
        lookup: impl FnOnce() -> Result<Vec<SocketAddr>, BoxedError> + Send + 'static,
    ) -> Result<LookupTask, BoxedError> {
        if *self.closed.borrow() {
            return Err(Box::new(closed()));
        }
        let reservation = self
            .budget
            .reserve(1, "apiRequest.fetch")
            .map_err(TransportError)?;
        let owner = self.owner.clone();
        let closed_state = self.closed.clone();
        let task = tokio::task::spawn_blocking(move || {
            if *closed_state.borrow() {
                return Err(Box::new(closed()) as BoxedError);
            }
            let addresses = lookup()?;
            if addresses.len() > 256 {
                return Err(Box::new(TransportError(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    "apiRequest.fetch",
                    "DNS response exceeds 256 addresses",
                ))) as BoxedError);
            }
            Ok(ResolvedAddresses {
                addresses: addresses.into_iter(),
                _reservation: reservation,
                _owner: owner,
            })
        });
        Ok(LookupTask { task })
    }
}

impl Service<Name> for BoundedResolver {
    type Response = ResolvedAddresses;
    type Error = BoxedError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(if *self.closed.borrow() {
            Err(Box::new(closed()))
        } else {
            Ok(())
        })
    }

    fn call(&mut self, name: Name) -> Self::Future {
        if name.as_str().len() > 1024 {
            return Box::pin(async {
                Err(Box::new(TransportError(ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    "apiRequest.fetch",
                    "DNS name exceeds 1024 bytes",
                ))) as BoxedError)
            });
        }
        let task = self
            .start_lookup(move || Ok((name.as_str(), 0).to_socket_addrs()?.take(257).collect()));
        let mut closed_state = self.closed.clone();
        Box::pin(async move {
            let task = task?;
            tokio::select! {
                biased;
                _ = closed_state.wait_for(|closed| *closed) => Err(Box::new(closed()) as BoxedError),
                result = task => result,
            }
        })
    }
}

pub(super) struct ResolvedAddresses {
    addresses: std::vec::IntoIter<SocketAddr>,
    _reservation: PairedReservation,
    _owner: Arc<Reservation>,
}

impl Iterator for ResolvedAddresses {
    type Item = SocketAddr;
    fn next(&mut self) -> Option<Self::Item> {
        self.addresses.next()
    }
}

struct LookupTask {
    task: JoinHandle<Result<ResolvedAddresses, BoxedError>>,
}

impl Future for LookupTask {
    type Output = Result<ResolvedAddresses, BoxedError>;
    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.task).poll(context).map(|result| {
            result.unwrap_or_else(|error| {
                Err(Box::new(TransportError(ErrorRecord::new(
                    ErrorCode::Protocol,
                    "apiRequest.fetch",
                    format!("DNS worker did not settle normally: {error}"),
                ))) as BoxedError)
            })
        })
    }
}

impl Drop for LookupTask {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::super::budget::{ContextBudget, EngineBudget};
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn running_and_queued_lookup_cancellation_preserve_custody_until_real_settlement() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let engine = EngineBudget::default();
            let budget = ContextBudget::new(&engine);
            let owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
            let original_owner = Arc::downgrade(&owner);
            let (closed_sender, closed_receiver) = watch::channel(false);
            let resolver = BoundedResolver::new(budget.lookups.clone(), owner, closed_receiver);
            let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
            let (release_sender, release_receiver) = std::sync::mpsc::channel();
            let running = resolver
                .start_lookup(move || {
                    started_sender.send(()).unwrap();
                    release_receiver.recv().unwrap();
                    Ok(vec!["127.0.0.1:0".parse().unwrap()])
                })
                .unwrap();
            started_receiver.await.unwrap();
            let queued_ran = Arc::new(AtomicBool::new(false));
            let observed = queued_ran.clone();
            let queued = resolver
                .start_lookup(move || {
                    observed.store(true, Ordering::Release);
                    Ok(vec![])
                })
                .unwrap();
            closed_sender.send_replace(true);
            drop(queued);
            drop(running);
            drop(resolver);
            assert!(original_owner.upgrade().is_some());
            assert!(budget.lookups.reserve(16, "test").is_err());
            release_sender.send(()).unwrap();
            tokio::task::spawn_blocking(|| {}).await.unwrap();
            assert!(original_owner.upgrade().is_none());
            assert!(!queued_ran.load(Ordering::Acquire));
            assert!(budget.lookups.reserve(16, "test").is_ok());
            let successor_budget = ContextBudget::new(&engine);
            let successor_owner = Arc::new(engine.owners.reserve(1, "test").unwrap());
            let (_sender, receiver) = watch::channel(false);
            let successor =
                BoundedResolver::new(successor_budget.lookups, successor_owner, receiver);
            let mut addresses = successor
                .start_lookup(|| Ok(vec!["127.0.0.1:0".parse().unwrap()]))
                .unwrap()
                .await
                .unwrap();
            assert_eq!(addresses.next(), Some("127.0.0.1:0".parse().unwrap()));
        });
    }
}
