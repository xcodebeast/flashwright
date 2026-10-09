//! Typed Fetch bodies share input ownership and stream one indivisible CDP frame.

use super::*;
use flashwright_protocol::attachment::{MAXIMUM_ATTACHMENT_BYTES, encode_base64};
use std::io::{self, Write};

const RAW_CHUNK_BYTES: usize = 48 * 1024;
const BODY_SUFFIX: &[u8] = b"\"}}\0";

/// A body owner retains its admission credits for every queued or in-progress write.
/// Route continuations may own separate byte credits after host input slots are released.
pub trait FetchBodySource: Send + Sync {
    fn bytes(&self) -> &[u8];
}

impl FetchBodySource for InputAttachment {
    fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Clone, Serialize)]
pub struct FetchHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueRequest {
    #[serde(rename = "requestId")]
    pub request_identifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<Vec<FetchHeader>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FulfillRequest {
    #[serde(rename = "requestId")]
    pub request_identifier: String,
    pub response_code: u16,
    pub response_headers: Vec<FetchHeader>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_phrase: Option<String>,
}

pub enum FetchBodyCommand {
    Continue(ContinueRequest),
    Fulfill(FulfillRequest),
}

impl FetchBodyCommand {
    fn method(&self) -> &'static str {
        match self {
            Self::Continue(_) => "Fetch.continueRequest",
            Self::Fulfill(_) => "Fetch.fulfillRequest",
        }
    }

    fn prefix(&self, identifier: u64, session: &str) -> Result<Vec<u8>, ErrorRecord> {
        #[derive(Clone, Serialize)]
        struct Envelope<'text> {
            #[serde(rename = "id")]
            identifier: u64,
            method: &'text str,
            #[serde(rename = "sessionId")]
            session: &'text str,
        }
        let mut writer = MetadataWriter {
            bytes: Vec::new(),
            exceeded: false,
        };
        let encode = |writer: &mut MetadataWriter| -> Result<(), serde_json::Error> {
            serde_json::to_writer(
                &mut *writer,
                &Envelope {
                    identifier,
                    method: self.method(),
                    session,
                },
            )?;
            writer.bytes.pop();
            writer
                .write_all(b",\"params\":")
                .map_err(serde_json::Error::io)?;
            match self {
                Self::Continue(parameters) => serde_json::to_writer(&mut *writer, parameters)?,
                Self::Fulfill(parameters) => serde_json::to_writer(&mut *writer, parameters)?,
            }
            writer.bytes.pop();
            writer
                .write_all(match self {
                    Self::Continue(_) => b",\"postData\":\"",
                    Self::Fulfill(_) => b",\"body\":\"",
                })
                .map_err(serde_json::Error::io)?;
            Ok(())
        };
        encode(&mut writer).map_err(|error| {
            if writer.exceeded {
                ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    self.method(),
                    "Fetch command metadata exceeds control-message limit",
                )
            } else {
                protocol_error(error.to_string())
            }
        })?;
        Ok(writer.bytes)
    }
}

/// Bound metadata while encoding it; payload bytes never enter this JSON buffer.
struct MetadataWriter {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl Write for MetadataWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len()
            > (MAXIMUM_CONTROL_BYTES - BODY_SUFFIX.len()).saturating_sub(self.bytes.len())
        {
            self.exceeded = true;
            return Err(io::Error::other("Fetch metadata limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Connection {
    /// Only these two protocol fields may bypass the ordinary outgoing control-frame bound.
    pub fn start_fetch_body(
        &self,
        parameters: FetchBodyCommand,
        input: Arc<dyn FetchBodySource>,
        session: &str,
    ) -> Result<Command, ErrorRecord> {
        if input.bytes().len() > MAXIMUM_ATTACHMENT_BYTES {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                parameters.method(),
                "Fetch body exceeds the supported attachment bound",
            ));
        }
        let identifier = self.inner.next_identifier.fetch_add(1, Ordering::Relaxed);
        let outgoing = OutgoingCommand {
            identifier,
            bytes: parameters.prefix(identifier, session)?,
            input: Some(input),
        };
        let (sender, receiver) = oneshot::channel();
        let command = Command {
            identifier,
            state: self.inner.clone(),
            receiver,
        };
        self.register_commands(
            vec![outgoing],
            vec![(
                identifier,
                PendingReply {
                    sender: ReplySender::Value(sender),
                    dispatch_started: false,
                },
            )],
            parameters.method(),
        )?;
        Ok(command)
    }
}

impl OutgoingCommand {
    /// Dropping a dispatched receiver cannot interrupt a JSON message or release its input lease.
    pub(super) async fn write_to<Writer: AsyncWrite + Unpin>(
        &self,
        writer: &mut Writer,
    ) -> io::Result<()> {
        writer.write_all(&self.bytes).await?;
        if let Some(input) = &self.input {
            for bytes in input.bytes().chunks(RAW_CHUNK_BYTES) {
                let encoded = encode_base64(bytes);
                writer.write_all(encoded.as_bytes()).await?;
            }
            writer.write_all(BODY_SUFFIX).await?;
        }
        Ok(())
    }
}
