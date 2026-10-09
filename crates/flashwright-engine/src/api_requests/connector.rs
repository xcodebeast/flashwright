//! A pooled connection owns socket admission until its actual I/O object is dropped.

use super::budget::{PairedBudget, PairedReservation, Reservation};
use super::resolver::BoundedResolver;
use super::transport_error::{BoxedError, TransportError, closed};
use http::Uri;
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::TokioIo;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tower_service::Service;

#[derive(Clone)]
pub(super) struct SocketConnector {
    resolver: BoundedResolver,
    budget: PairedBudget,
    closed: watch::Receiver<bool>,
    owner: Arc<Reservation>,
}

impl SocketConnector {
    pub(super) fn owner_credit(&self) -> Arc<Reservation> {
        self.owner.clone()
    }

    pub(super) fn new(
        resolver: BoundedResolver,
        budget: PairedBudget,
        closed: watch::Receiver<bool>,
        owner: Arc<Reservation>,
    ) -> Self {
        Self {
            resolver,
            budget,
            closed,
            owner,
        }
    }

    async fn connect(&mut self, destination: Uri) -> Result<SocketConnection, BoxedError> {
        let port = match destination.scheme_str() {
            Some("http") => destination.port_u16().unwrap_or(80),
            Some("https") => destination.port_u16().unwrap_or(443),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "expected HTTP or HTTPS URI",
                )
                .into());
            }
        };
        let host = destination
            .host()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "URI has no host"))?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if host.len() > 1024 {
            return Err(Box::new(TransportError(
                flashwright_protocol::ErrorRecord::new(
                    flashwright_protocol::ErrorCode::ResourceLimit,
                    "apiRequest.fetch",
                    "DNS name exceeds 1024 bytes",
                ),
            )));
        }
        let addresses = if let Ok(address) = host.parse::<IpAddr>() {
            vec![SocketAddr::new(address, port)]
        } else {
            self.resolver
                .call(host.parse()?)
                .await?
                .map(|mut address| {
                    address.set_port(port);
                    address
                })
                .collect()
        };
        self.connect_addresses(addresses).await
    }

    /// Race address families after the usual fallback delay, charging every real attempt.
    async fn connect_addresses(
        &self,
        addresses: Vec<SocketAddr>,
    ) -> Result<SocketConnection, BoxedError> {
        let first_is_ipv6 = addresses.first().is_some_and(SocketAddr::is_ipv6);
        let (preferred, fallback): (Vec<_>, Vec<_>) = addresses
            .into_iter()
            .partition(|address| address.is_ipv6() == first_is_ipv6);
        if fallback.is_empty() {
            return self.connect_family(preferred).await;
        }
        race_families(
            self.connect_family(preferred),
            self.connect_family(fallback),
        )
        .await
    }

    async fn connect_family(
        &self,
        addresses: Vec<SocketAddr>,
    ) -> Result<SocketConnection, BoxedError> {
        let mut first_error = None;
        for address in addresses {
            if *self.closed.borrow() {
                return Err(Box::new(closed()));
            }
            let reservation = self
                .budget
                .reserve(1, "apiRequest.fetch")
                .map_err(TransportError)?;
            match TcpStream::connect(address).await {
                Ok(stream) => {
                    stream.set_nodelay(true)?;
                    return Ok(SocketConnection {
                        stream: TokioIo::new(stream),
                        owner_closed: Box::pin(wait_for_close(self.closed.clone())),
                        owner_ended: false,
                        _reservation: reservation,
                        _owner: self.owner.clone(),
                    });
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        Err(first_error
            .unwrap_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotConnected,
                    "DNS returned no usable addresses",
                )
            })
            .into())
    }
}

/// Resource and owner failures stop all attempts; only connection failures try the other family.
async fn race_families<Value>(
    preferred: impl Future<Output = Result<Value, BoxedError>>,
    fallback: impl Future<Output = Result<Value, BoxedError>>,
) -> Result<Value, BoxedError> {
    tokio::pin!(preferred, fallback);
    tokio::select! {
        biased;
        result = &mut preferred => return match result {
            Err(error) if error.downcast_ref::<TransportError>().is_none() => fallback.await,
            result => result,
        },
        _ = tokio::time::sleep(Duration::from_millis(300)) => {},
    }
    tokio::select! {
        biased;
        result = &mut preferred => match result {
            Err(error) if error.downcast_ref::<TransportError>().is_none() => fallback.await,
            result => result,
        },
        result = &mut fallback => match result {
            Err(error) if error.downcast_ref::<TransportError>().is_none() => preferred.await,
            result => result,
        },
    }
}

impl Service<Uri> for SocketConnector {
    type Response = SocketConnection;
    type Error = BoxedError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        if *self.closed.borrow() {
            return Poll::Ready(Err(Box::new(closed())));
        }
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, destination: Uri) -> Self::Future {
        if *self.closed.borrow() {
            return Box::pin(async { Err(Box::new(closed()) as BoxedError) });
        }
        let mut connector = self.clone();
        let mut closed_state = self.closed.clone();
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = closed_state.wait_for(|closed| *closed) => Err(Box::new(closed()) as BoxedError),
                stream = connector.connect(destination) => stream,
            }
        })
    }
}

async fn wait_for_close(mut closed_state: watch::Receiver<bool>) {
    let _ = closed_state.wait_for(|closed| *closed).await;
}

pub(super) struct SocketConnection {
    stream: TokioIo<TcpStream>,
    owner_closed: Pin<Box<dyn Future<Output = ()> + Send>>,
    owner_ended: bool,
    _reservation: PairedReservation,
    _owner: Arc<Reservation>,
}

impl SocketConnection {
    fn check_owner(&mut self, context: &mut Context<'_>) -> io::Result<()> {
        if self.owner_ended || self.owner_closed.as_mut().poll(context).is_ready() {
            self.owner_ended = true;
            Err(io::Error::other(closed()))
        } else {
            Ok(())
        }
    }
}

impl Connection for SocketConnection {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

impl Read for SocketConnection {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        self.check_owner(context)?;
        Pin::new(&mut self.stream).poll_read(context, buffer)
    }
}

impl Write for SocketConnection {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check_owner(context)?;
        Pin::new(&mut self.stream).poll_write(context, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check_owner(context)?;
        Pin::new(&mut self.stream).poll_flush(context)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(context)
    }
    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        self.check_owner(context)?;
        Pin::new(&mut self.stream).poll_write_vectored(context, buffers)
    }
}

#[cfg(test)]
mod tests {
    use super::super::budget::{ContextBudget, EngineBudget};
    use super::*;
    use flashwright_protocol::ErrorCode;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn fallback_owns_its_own_credit_and_drops_the_losing_attempt() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let occupied = budget.sockets.reserve(14, "test").unwrap();
        let preferred = async {
            let _reservation = budget.sockets.reserve(1, "test").unwrap();
            std::future::pending::<Result<PairedReservation, BoxedError>>().await
        };
        let fallback = async {
            let reservation = budget.sockets.reserve(1, "test").unwrap();
            assert!(budget.sockets.reserve(1, "test").is_err());
            Ok(reservation)
        };
        let winner = race_families(preferred, fallback).await.unwrap();
        assert!(budget.sockets.reserve(1, "test").is_ok());
        assert!(budget.sockets.reserve(2, "test").is_err());
        drop((winner, occupied));
        assert!(budget.sockets.reserve(16, "test").is_ok());
    }

    #[tokio::test]
    async fn fallback_pressure_is_terminal_and_cancels_the_stalled_primary() {
        let engine = EngineBudget::default();
        let budget = ContextBudget::new(&engine);
        let occupied = budget.sockets.reserve(15, "test").unwrap();
        let preferred = async {
            let _reservation = budget.sockets.reserve(1, "test").unwrap();
            std::future::pending::<Result<PairedReservation, BoxedError>>().await
        };
        let fallback = async {
            budget
                .sockets
                .reserve(1, "test")
                .map_err(|error| Box::new(TransportError(error)) as BoxedError)
        };
        let error = race_families(preferred, fallback).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<TransportError>().unwrap().0.code,
            ErrorCode::ResourceLimit
        );
        assert!(budget.sockets.reserve(1, "test").is_ok());
        drop(occupied);
        assert!(budget.sockets.reserve(16, "test").is_ok());
    }

    #[tokio::test]
    async fn real_sockets_keep_credit_until_drop_and_owner_close_wakes_io() {
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
        let mut connector =
            SocketConnector::new(resolver, budget.sockets.clone(), closed_receiver, owner);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination: Uri = format!("http://{}/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let mut connections = Vec::new();
        let mut peers = Vec::new();
        for _ in 0..16 {
            connections.push(connector.call(destination.clone()).await.unwrap());
            peers.push(listener.accept().await.unwrap().0);
        }
        let error = match connector.call(destination.clone()).await {
            Ok(_) => panic!("seventeenth connection exceeded the socket cap"),
            Err(error) => error,
        };
        assert_eq!(
            error.downcast_ref::<TransportError>().unwrap().0.code,
            ErrorCode::ResourceLimit
        );
        drop(connections.pop());
        let mut successor = TokioIo::new(connector.call(destination).await.unwrap());
        peers.push(listener.accept().await.unwrap().0);
        let mut byte = [0];
        {
            let read = successor.read(&mut byte);
            tokio::pin!(read);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut read)
                    .await
                    .is_err()
            );
            closed_sender.send_replace(true);
            assert!(
                tokio::time::timeout(Duration::from_secs(1), &mut read)
                    .await
                    .unwrap()
                    .is_err()
            );
        }
        drop(connector);
        assert!(original_owner.upgrade().is_some());
        assert!(budget.sockets.reserve(1, "test").is_err());
        drop((connections, successor));
        assert!(original_owner.upgrade().is_none());
        assert!(budget.sockets.reserve(16, "test").is_ok());
        for mut peer in peers {
            assert_eq!(peer.read(&mut byte).await.unwrap(), 0);
        }
    }
}
