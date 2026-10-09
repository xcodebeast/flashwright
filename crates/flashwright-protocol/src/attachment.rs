//! Request-scoped binary transfers keep payloads out of control JSON values.

use serde::Serialize;
use std::borrow::Cow;
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, mpsc, oneshot};

use crate::{EncodedFrame, ErrorCode, ErrorRecord};

pub const ATTACHMENT_CHUNK_BYTES: usize = 64 * 1024;
pub const ATTACHMENT_HEADER_BYTES: usize = 13;
pub const MAXIMUM_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;

/// Encode one bounded browser-bound chunk using canonical RFC 4648 padding.
pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 3) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((second & 15) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(third & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

/// Validated request bytes retain their input reservation through operation completion.
#[derive(Debug)]
pub struct InputAttachment {
    pub bytes: Arc<Vec<u8>>,
    pub reservation: OwnedSemaphorePermit,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentEncoding {
    Raw,
    Base64,
}

/// Validated bytes retain their browser representation until the final consumer decodes them.
#[derive(Debug)]
pub struct BinaryPayload {
    pub bytes: Vec<u8>,
    pub encoding: AttachmentEncoding,
    pub decoded_length: usize,
}

impl BinaryPayload {
    pub fn new(
        bytes: Cow<'_, [u8]>,
        encoding: AttachmentEncoding,
        maximum_decoded_bytes: usize,
        method: &str,
    ) -> Result<Self, ErrorRecord> {
        let decoded_length = match encoding {
            AttachmentEncoding::Raw => bytes.len(),
            AttachmentEncoding::Base64 => base64_decoded_length(&bytes).ok_or_else(|| {
                ErrorRecord::new(
                    ErrorCode::Protocol,
                    method,
                    "browser returned invalid base64",
                )
            })?,
        };
        if decoded_length > maximum_decoded_bytes {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "binary attachment exceeds negotiated byte limit",
            ));
        }
        Ok(Self {
            bytes: bytes.into_owned(),
            encoding,
            decoded_length,
        })
    }
}

/// The reservation stays owned until the writer acknowledges the terminal frame.
#[derive(Debug)]
pub struct BinaryAttachment {
    pub bytes: Vec<u8>,
    pub encoding: AttachmentEncoding,
    pub decoded_length: usize,
    pub reservation: OwnedSemaphorePermit,
}

impl BinaryAttachment {
    pub fn new(
        bytes: Vec<u8>,
        encoding: AttachmentEncoding,
        maximum_decoded_bytes: usize,
        reservation: OwnedSemaphorePermit,
        method: &str,
    ) -> Result<Self, ErrorRecord> {
        let payload = BinaryPayload::new(bytes.into(), encoding, maximum_decoded_bytes, method)?;
        Ok(Self::from_payload(payload, reservation))
    }

    pub fn from_payload(payload: BinaryPayload, reservation: OwnedSemaphorePermit) -> Self {
        Self {
            bytes: payload.bytes,
            encoding: payload.encoding,
            decoded_length: payload.decoded_length,
            reservation,
        }
    }
}

/// A single queued frame provides backpressure; early producer loss is stream corruption.
#[derive(Debug)]
pub struct AttachmentStream {
    pub frames: mpsc::Receiver<AttachmentFrame>,
}

#[derive(Debug)]
pub enum AttachmentFrame {
    Data(EncodedFrame),
    Terminal {
        frame: EncodedFrame,
        written: oneshot::Sender<()>,
    },
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Validate canonical padding without allocating or transcoding Chromium's base64 string.
pub fn base64_decoded_length(bytes: &[u8]) -> Option<usize> {
    if bytes.is_empty() {
        return Some(0);
    }
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 {
        return None;
    }
    let data = &bytes[..bytes.len() - padding];
    if data.iter().any(|byte| base64_value(*byte).is_none()) {
        return None;
    }
    let last = base64_value(*data.last()?)?;
    if (padding == 2 && last & 15 != 0) || (padding == 1 && last & 3 != 0) {
        return None;
    }
    Some(bytes.len() / 4 * 3 - padding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_chunks_match_rfc_vectors_and_binary_bytes() {
        for (bytes, encoded) in [
            (b"".as_slice(), ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
            (&[0, 128, 255], "AID/"),
        ] {
            assert_eq!(encode_base64(bytes), encoded);
            assert_eq!(base64_decoded_length(encoded.as_bytes()), Some(bytes.len()));
        }
    }

    #[test]
    fn canonical_base64_lengths_preserve_empty_binary_and_reject_corruption() {
        for (input, length) in [
            ("", 0),
            ("AA==", 1),
            ("AP8=", 2),
            ("AID/", 3),
            ("YWJjZGU=", 5),
        ] {
            assert_eq!(base64_decoded_length(input.as_bytes()), Some(length));
        }
        for input in [
            "A", "====", "A===", "A=AA", "AA A", "AA\nA", "AB==", "AAF=", "AA-_", "AA==AAAA",
        ] {
            assert_eq!(base64_decoded_length(input.as_bytes()), None, "{input}");
        }
    }
}
