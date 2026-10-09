//! Exercise real Rustls/Tokio Rustls queues with a writable peer and a blocked client socket.

use super::super::budget::EngineBudget;
use super::*;
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use std::collections::VecDeque;
use std::io::{Read as _, Write as _};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::Waker;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};

struct Peer {
    session: rustls::ServerConnection,
    outgoing: VecDeque<u8>,
    received: Vec<u8>,
}

struct MemorySocket {
    peer: Arc<Mutex<Peer>>,
    writes_blocked: Arc<AtomicBool>,
}

impl AsyncRead for MemorySocket {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut peer = self.peer.lock().unwrap();
        let mut encrypted = Vec::new();
        peer.session.write_tls(&mut encrypted)?;
        peer.outgoing.extend(encrypted);
        if peer.outgoing.is_empty() {
            return Poll::Pending;
        }
        while output.remaining() != 0 {
            let Some(byte) = peer.outgoing.pop_front() else {
                break;
            };
            output.put_slice(&[byte]);
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for MemorySocket {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.writes_blocked.load(Ordering::SeqCst) {
            return Poll::Pending;
        }
        let mut peer = self.peer.lock().unwrap();
        let consumed = peer.session.read_tls(&mut io::Cursor::new(input))?;
        peer.session
            .process_new_packets()
            .map_err(io::Error::other)?;
        let mut plaintext = [0; 4096];
        loop {
            match peer.session.reader().read(&mut plaintext) {
                Ok(0) => break,
                Ok(length) => peer.received.extend_from_slice(&plaintext[..length]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Poll::Ready(Err(error)),
            }
        }
        Poll::Ready(Ok(consumed))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

type TestStream = TokioIo<BudgetedStream<TokioIo<tokio_rustls::client::TlsStream<MemorySocket>>>>;

fn queued_tls_bytes(stream: &mut TestStream) -> usize {
    stream
        .inner_mut()
        .inner
        .inner_mut()
        .get_mut()
        .1
        .process_new_packets()
        .unwrap()
        .tls_bytes_to_write()
}

#[tokio::test]
async fn blocked_tls_writes_cannot_accumulate_key_update_replies_and_reads_still_progress() {
    exercise_key_updates(false).await;
    exercise_key_updates(true).await;
}

async fn exercise_key_updates(guarded: bool) {
    let certificate = CertificateDer::from(
        include_bytes!("../../../../compatibility/fixtures/api-tls/test-certificate.der").to_vec(),
    );
    let private_key = PrivatePkcs8KeyDer::from(
        include_bytes!("../../../../compatibility/fixtures/api-tls/test-key.pk8").to_vec(),
    );
    let configuration = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![certificate], private_key.into())
    .unwrap();
    let peer = Arc::new(Mutex::new(Peer {
        session: rustls::ServerConnection::new(Arc::new(configuration)).unwrap(),
        outgoing: VecDeque::new(),
        received: Vec::new(),
    }));
    let writes_blocked = Arc::new(AtomicBool::new(false));
    let socket = MemorySocket {
        peer: peer.clone(),
        writes_blocked: writes_blocked.clone(),
    };
    let tls = tokio_rustls::TlsConnector::from(Arc::new(super::super::tls::configuration(true)))
        .connect("flashwright.test".try_into().unwrap(), socket)
        .await
        .unwrap();
    let engine = EngineBudget::default();
    let budget = PairedBudget::testing(CONNECTION_WORKING_BYTES);
    let custody = Arc::new(ConnectionCustody {
        _memory: budget.reserve(CONNECTION_WORKING_BYTES, "test").unwrap(),
        _owner: Arc::new(engine.owners.reserve(1, "test").unwrap()),
    });
    let mut stream = TokioIo::new(BudgetedStream {
        inner: TokioIo::new(tls),
        custody,
    });
    writes_blocked.store(true, Ordering::SeqCst);
    let payload = vec![42; 64 * 1024];
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(
        AsyncWrite::poll_write(Pin::new(&mut stream), &mut context, &payload),
        Poll::Ready(Ok(65_536))
    ));
    let initial_queue = queued_tls_bytes(&mut stream);
    for iteration in 0..128 {
        {
            let mut peer = peer.lock().unwrap();
            peer.session.refresh_traffic_keys().unwrap();
            peer.session.writer().write_all(&[iteration as u8]).unwrap();
        }
        let mut response = [0];
        stream.read_exact(&mut response).await.unwrap();
        assert_eq!(response, [iteration as u8]);
        let buffers = [io::IoSlice::new(b"more"), io::IoSlice::new(b"data")];
        let written = match (guarded, iteration % 2 == 0) {
            (true, true) => AsyncWrite::poll_write(Pin::new(&mut stream), &mut context, b"more"),
            (true, false) => {
                AsyncWrite::poll_write_vectored(Pin::new(&mut stream), &mut context, &buffers)
            }
            // Exercise the identical underlying Tokio Rustls stream without our admission guard.
            (false, true) => Write::poll_write(
                Pin::new(&mut stream.inner_mut().inner),
                &mut context,
                b"more",
            ),
            (false, false) => Write::poll_write_vectored(
                Pin::new(&mut stream.inner_mut().inner),
                &mut context,
                &buffers,
            ),
        };
        assert!(written.is_pending());
    }
    if !guarded {
        assert_eq!(queued_tls_bytes(&mut stream), initial_queue + 128 * 27);
        drop(stream);
        assert_eq!(budget.retained(), 0);
        return;
    }
    assert_eq!(queued_tls_bytes(&mut stream), initial_queue);
    writes_blocked.store(false, Ordering::SeqCst);
    tokio::io::AsyncWriteExt::write_all(&mut stream, b"successor")
        .await
        .unwrap();
    tokio::io::AsyncWriteExt::flush(&mut stream).await.unwrap();
    let received = peer.lock().unwrap().received.clone();
    assert_eq!(&received[..payload.len()], payload);
    assert_eq!(&received[payload.len()..], b"successor");
    drop(stream);
    assert_eq!(budget.retained(), 0);
}
