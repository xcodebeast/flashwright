use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Reactor-owned standard pipes can be cancelled without leaving Tokio blocking threads alive.
pub struct Pipe {
    descriptor: AsyncFd<File>,
}

impl Pipe {
    pub fn new(descriptor: OwnedFd) -> std::io::Result<Self> {
        let file = File::from(descriptor);
        let flags = fcntl(&file, FcntlArg::F_GETFL).map_err(std::io::Error::from)?;
        fcntl(
            &file,
            FcntlArg::F_SETFL(OFlag::from_bits_retain(flags) | OFlag::O_NONBLOCK),
        )
        .map_err(std::io::Error::from)?;
        Ok(Self {
            descriptor: AsyncFd::new(file)?,
        })
    }
}

impl AsyncRead for Pipe {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        loop {
            let mut readiness = ready!(self.descriptor.poll_read_ready(context))?;
            match readiness
                .try_io(|descriptor| descriptor.get_ref().read(buffer.initialize_unfilled()))
            {
                Ok(Ok(length)) => {
                    buffer.advance(length);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}

impl AsyncWrite for Pipe {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        loop {
            let mut readiness = ready!(self.descriptor.poll_write_ready(context))?;
            match readiness.try_io(|descriptor| descriptor.get_ref().write(bytes)) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
