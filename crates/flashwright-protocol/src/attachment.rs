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
    pub bytes: Arc<Vec<u8>>,
    pub encoding: AttachmentEncoding,
    pub decoded_length: usize,
    pub reservation: OwnedSemaphorePermit,
    /// Native byte custody survives owner failure while the transport still holds the payload.
    byte_reservations: Vec<Arc<dyn std::fmt::Debug + Send + Sync>>,
}

impl BinaryAttachment {
    /// Share the original byte charge until this transfer's terminal writer acknowledgement.
    pub fn retain_byte_reservation<Reservation: std::fmt::Debug + Send + Sync + 'static>(
        &mut self,
        reservation: Arc<Reservation>,
    ) {
        self.byte_reservations.push(reservation);
    }

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

    /// Transfer retained raw bytes and their custody without copying the allocation.
    pub fn from_shared_raw<Reservation: std::fmt::Debug + Send + Sync + 'static>(
        bytes: Arc<Vec<u8>>,
        byte_reservation: Arc<Reservation>,
        maximum_decoded_bytes: usize,
        reservation: OwnedSemaphorePermit,
        method: &str,
    ) -> Result<Self, ErrorRecord> {
        if bytes.len() > maximum_decoded_bytes {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "binary attachment exceeds negotiated byte limit",
            ));
        }
        Ok(Self {
            decoded_length: bytes.len(),
            bytes,
            encoding: AttachmentEncoding::Raw,
            reservation,
            byte_reservations: vec![byte_reservation],
        })
    }

    pub fn from_payload(payload: BinaryPayload, reservation: OwnedSemaphorePermit) -> Self {
        Self {
            bytes: Arc::new(payload.bytes),
            encoding: payload.encoding,
            decoded_length: payload.decoded_length,
            reservation,
            byte_reservations: Vec::new(),
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

/// Append one independently padded entry only after validating its entire input and output bound.
pub fn append_base64(
    encoded: &[u8],
    output: &mut Vec<u8>,
    maximum_bytes: usize,
    method: &str,
) -> Result<(), ErrorRecord> {
    let length = base64_decoded_length(encoded).ok_or_else(|| {
        ErrorRecord::new(
            ErrorCode::Protocol,
            method,
            "browser returned invalid base64",
        )
    })?;
    output
        .len()
        .checked_add(length)
        .filter(|total| *total <= maximum_bytes)
        .ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "decoded body exceeds its byte limit",
            )
        })?;
    output.reserve(length);
    for chunk in encoded.as_chunks::<4>().0 {
        let first = base64_value(chunk[0]).expect("validated alphabet");
        let second = base64_value(chunk[1]).expect("validated alphabet");
        output.push(first << 2 | second >> 4);
        if chunk[2] != b'=' {
            let third = base64_value(chunk[2]).expect("validated alphabet");
            output.push(second << 4 | third >> 2);
            if chunk[3] != b'=' {
                output.push(third << 6 | base64_value(chunk[3]).expect("validated alphabet"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_transfer_keeps_original_bytes_and_charge_until_its_last_owner_drops() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let budget = Arc::new(tokio::sync::Semaphore::new(64));
        let charge = Arc::new(budget.clone().try_acquire_many_owned(32).unwrap());
        let bytes = Arc::new(vec![42; 32]);
        let attachment = BinaryAttachment::from_shared_raw(
            bytes.clone(),
            charge.clone(),
            64,
            slots.clone().try_acquire_owned().unwrap(),
            "test",
        )
        .unwrap();
        assert!(Arc::ptr_eq(&attachment.bytes, &bytes));
        drop(bytes);
        drop(charge);
        assert_eq!(budget.available_permits(), 32);
        assert_eq!(slots.available_permits(), 0);
        assert_eq!(attachment.bytes.as_slice(), &[42; 32]);
        drop(attachment);
        assert_eq!(budget.available_permits(), 64);
        assert_eq!(slots.available_permits(), 1);
    }

    #[test]
    fn rejected_shared_transfer_returns_both_reservations_without_copying() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let budget = Arc::new(tokio::sync::Semaphore::new(64));
        let charge = Arc::new(budget.clone().try_acquire_many_owned(32).unwrap());
        let bytes = Arc::new(vec![42; 32]);
        let result = BinaryAttachment::from_shared_raw(
            bytes.clone(),
            charge,
            31,
            slots.clone().try_acquire_owned().unwrap(),
            "test",
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::ResourceLimit);
        assert_eq!(Arc::strong_count(&bytes), 1);
        assert_eq!(budget.available_permits(), 64);
        assert_eq!(slots.available_permits(), 1);
    }

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

    #[test]
    fn independently_padded_entries_preserve_bytes_and_reject_without_mutation() {
        let original: Vec<u8> = (0..=255).collect();
        for entry_size in 1..=7 {
            let mut decoded = Vec::new();
            for entry in original.chunks(entry_size) {
                append_base64(encode_base64(entry).as_bytes(), &mut decoded, 256, "test").unwrap();
            }
            assert_eq!(decoded, original);
            for (encoded, code) in [
                ("AB==", ErrorCode::Protocol),
                ("AA==", ErrorCode::ResourceLimit),
            ] {
                assert_eq!(
                    append_base64(encoded.as_bytes(), &mut decoded, 256, "test")
                        .unwrap_err()
                        .code,
                    code
                );
                assert_eq!(decoded, original);
            }
        }
    }
}
