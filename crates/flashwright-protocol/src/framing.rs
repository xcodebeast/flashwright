use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Read corruption and failed/partial writes invalidate the stream. Encoding limits
/// reject before publication and leave it usable; corrupted bytes are never resynchronized.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("control frame size {received} exceeds the negotiated limit {limit}")]
    TooLarge { received: usize, limit: usize },
    #[error("zero-length control frames are invalid")]
    Empty,
    #[error("transport ended inside a control frame")]
    Truncated,
    #[error("transport is invalid after a previous framing or write failure")]
    Invalidated,
    #[error("invalid control JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("control transport failed: {0}")]
    Io(#[from] std::io::Error),
}

/// Incremental reader with bounded allocation and clean-EOF versus truncation distinction.
pub struct FrameReader<Reader> {
    reader: Reader,
    maximum_bytes: usize,
    invalidated: bool,
}

impl<Reader: AsyncRead + Unpin> FrameReader<Reader> {
    pub fn new(reader: Reader, maximum_bytes: usize) -> Self {
        Self {
            reader,
            maximum_bytes,
            invalidated: false,
        }
    }

    /// Apply negotiated limits between complete frames.
    pub fn set_maximum_bytes(&mut self, maximum_bytes: usize) {
        self.maximum_bytes = maximum_bytes;
    }

    /// Read exactly one frame. Cancelled reads invalidate the reader to avoid desynchronization.
    pub async fn read<Message: DeserializeOwned>(&mut self) -> Result<Option<Message>, FrameError> {
        if self.invalidated {
            return Err(FrameError::Invalidated);
        }
        self.invalidated = true;
        let result = self.read_frame().await;
        if result.is_ok() {
            self.invalidated = false;
        }
        result
    }

    async fn read_frame<Message: DeserializeOwned>(
        &mut self,
    ) -> Result<Option<Message>, FrameError> {
        let mut header = [0_u8; 4];
        if self.reader.read(&mut header[..1]).await? == 0 {
            return Ok(None);
        }
        read_remaining(&mut self.reader, &mut header[1..]).await?;
        let length = u32::from_le_bytes(header) as usize;
        if length == 0 {
            return Err(FrameError::Empty);
        }
        if length > self.maximum_bytes {
            return Err(FrameError::TooLarge {
                received: length,
                limit: self.maximum_bytes,
            });
        }
        let mut body = vec![0; length];
        read_remaining(&mut self.reader, &mut body).await?;
        Ok(Some(serde_json::from_slice(&body)?))
    }
}

async fn read_remaining<Reader: AsyncRead + Unpin>(
    reader: &mut Reader,
    destination: &mut [u8],
) -> Result<(), FrameError> {
    match reader.read_exact(destination).await {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            Err(FrameError::Truncated)
        }
        Err(error) => Err(FrameError::Io(error)),
    }
}

/// A complete bounded JSON payload prepared before transport publication.
#[derive(Debug)]
pub struct EncodedFrame {
    body: Vec<u8>,
}

impl EncodedFrame {
    pub fn encode<Message: Serialize>(
        message: &Message,
        maximum_bytes: usize,
    ) -> Result<Self, FrameError> {
        let mut body = BoundedBuffer {
            bytes: Vec::new(),
            limit: maximum_bytes.min(u32::MAX as usize),
            exceeded: false,
        };
        if let Err(error) = serde_json::to_writer(&mut body, message) {
            return if body.exceeded {
                Err(FrameError::TooLarge {
                    received: body.limit + 1,
                    limit: body.limit,
                })
            } else {
                Err(FrameError::Json(error))
            };
        }
        Ok(Self { body: body.bytes })
    }
}

/// A single task owns each writer; cancelled or partial writes poison the stream.
pub struct FrameWriter<Writer> {
    writer: Writer,
    maximum_bytes: usize,
    invalidated: bool,
}

impl<Writer: AsyncWrite + Unpin> FrameWriter<Writer> {
    pub fn new(writer: Writer, maximum_bytes: usize) -> Self {
        Self {
            writer,
            maximum_bytes,
            invalidated: false,
        }
    }

    pub async fn write<Message: Serialize>(&mut self, message: &Message) -> Result<(), FrameError> {
        if self.invalidated {
            return Err(FrameError::Invalidated);
        }
        let frame = EncodedFrame::encode(message, self.maximum_bytes)?;
        self.write_frame(&frame).await
    }

    pub async fn write_frame(&mut self, frame: &EncodedFrame) -> Result<(), FrameError> {
        if self.invalidated {
            return Err(FrameError::Invalidated);
        }
        let body = &frame.body;
        if body.len() > self.maximum_bytes {
            return Err(FrameError::TooLarge {
                received: body.len(),
                limit: self.maximum_bytes,
            });
        }
        self.invalidated = true;
        self.writer
            .write_all(&(body.len() as u32).to_le_bytes())
            .await?;
        self.writer.write_all(body).await?;
        self.writer.flush().await?;
        self.invalidated = false;
        Ok(())
    }
}

struct BoundedBuffer {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl std::io::Write for BoundedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("control frame limit exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
