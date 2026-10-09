//! Decode supported content encodings without releasing the compressed body's original custody.

use super::allocation::BoundedAllocator;
use super::budget::{BodyBuffer, MAXIMUM_BODY_BYTES, PairedBudget, RetainedBody};
use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, SliceWrapperMut};
use flashwright_protocol::{ErrorCode, ErrorRecord};
use flate2::{Decompress, FlushDecompress, Status};
use std::sync::Arc;

const CHUNK_BYTES: usize = 64 * 1024;
const COOPERATIVE_BYTES: usize = 1024 * 1024;
// The pinned zlib-rs inflate state uses one allocation containing fixed tables,
// a 32 KiB window and alignment padding. No gzip name/comment/extra is retained:
// the low-level decoder has no header capture target. This ceiling includes the
// state wrapper and is verified against the pinned allocation layout in tests.
const ZLIB_WORKING_BYTES: usize = 128 * 1024;

pub(super) async fn decode(
    encoded: Arc<RetainedBody>,
    encoding: &str,
    budget: PairedBudget,
    mut check: impl FnMut() -> Result<(), ErrorRecord>,
) -> Result<Arc<RetainedBody>, ErrorRecord> {
    check()?;
    if encoded.bytes.is_empty() || !matches!(encoding, "gzip" | "x-gzip" | "deflate" | "br") {
        return Ok(encoded);
    }
    let allocator = BoundedAllocator::new(budget.clone());
    let mut scratch = allocator.allocate::<u8>(CHUNK_BYTES)?;
    let mut output = BodyBuffer::new(budget.clone(), MAXIMUM_BODY_BYTES);
    if encoding == "br" {
        let _working = budget.reserve(
            std::mem::size_of::<BrotliState<BoundedAllocator, BoundedAllocator, BoundedAllocator>>(
            ),
            "apiRequest.fetch",
        )?;
        brotli(
            &encoded.bytes,
            scratch.slice_mut(),
            &mut output,
            allocator,
            &mut check,
        )
        .await?;
    } else {
        let _working = budget.reserve(ZLIB_WORKING_BYTES, "apiRequest.fetch")?;
        zlib(
            &encoded.bytes,
            encoding != "deflate",
            scratch.slice_mut(),
            &mut output,
            &mut check,
        )
        .await?;
    }
    check()?;
    Ok(output.finish())
}

async fn zlib(
    input: &[u8],
    gzip: bool,
    scratch: &mut [u8],
    output: &mut BodyBuffer,
    check: &mut impl FnMut() -> Result<(), ErrorRecord>,
) -> Result<(), ErrorRecord> {
    let create_decoder = || {
        if gzip {
            Decompress::new_gzip(15)
        } else {
            Decompress::new(true)
        }
    };
    let mut decoder = Some(create_decoder());
    let mut position: usize = 0;
    let mut work = 0;
    loop {
        check()?;
        let current = decoder.as_mut().expect("active gzip member");
        let before_input = current.total_in();
        let before_output = current.total_out();
        let end = position.saturating_add(CHUNK_BYTES).min(input.len());
        let status = current
            .decompress(&input[position..end], scratch, FlushDecompress::Sync)
            .map_err(|error| invalid_encoding(if gzip { "gzip" } else { "deflate" }, error))?;
        let consumed = (current.total_in() - before_input) as usize;
        let produced = (current.total_out() - before_output) as usize;
        check()?;
        position += consumed;
        output.append(&scratch[..produced], "apiRequest.fetch")?;
        work += consumed + produced;
        if work >= COOPERATIVE_BYTES {
            tokio::task::yield_now().await;
            work = 0;
        }
        if status == Status::StreamEnd {
            if !gzip || position == input.len() || input[position] == 0 {
                return Ok(());
            }
            // A second member must not transiently allocate another inflate state.
            drop(decoder.take());
            decoder = Some(create_decoder());
            continue;
        }
        if consumed == 0 && produced == 0 {
            return if gzip && position == input.len() {
                // Pinned gunzip uses Z_SYNC_FLUSH at EOF, preserving partial decoded output.
                Ok(())
            } else {
                Err(invalid_encoding(
                    if gzip { "gzip" } else { "deflate" },
                    "incomplete compressed stream",
                ))
            };
        }
    }
}

async fn brotli(
    input: &[u8],
    scratch: &mut [u8],
    output: &mut BodyBuffer,
    allocator: BoundedAllocator,
    check: &mut impl FnMut() -> Result<(), ErrorRecord>,
) -> Result<(), ErrorRecord> {
    // Allocation failure is sticky across all three typed allocators. In the pinned
    // decoder, a failed initial length table therefore forces the checked ring-buffer
    // allocation to fail before Huffman table use. A failed group-index allocation
    // likewise forces its following checked code-table allocation to fail.
    let mut state =
        BrotliState::new_strict(allocator.clone(), allocator.clone(), allocator.clone());
    allocator.check()?;
    let mut position = 0;
    let mut total_output = 0;
    let mut work = 0;
    loop {
        check()?;
        let before_input = position;
        let mut available_input = (input.len() - position).min(CHUNK_BYTES);
        let mut available_output = scratch.len();
        let mut produced = 0;
        let status = BrotliDecompressStream(
            &mut available_input,
            &mut position,
            input,
            &mut available_output,
            &mut produced,
            scratch,
            &mut total_output,
            &mut state,
        );
        allocator.check()?;
        check()?;
        output.append(&scratch[..produced], "apiRequest.fetch")?;
        work += position - before_input + produced;
        if work >= COOPERATIVE_BYTES {
            tokio::task::yield_now().await;
            work = 0;
        }
        match status {
            BrotliResult::ResultSuccess => return Ok(()),
            BrotliResult::NeedsMoreInput if position == input.len() => return Ok(()),
            BrotliResult::NeedsMoreInput | BrotliResult::NeedsMoreOutput => {}
            other => return Err(invalid_encoding("br", format_args!("{other:?}"))),
        }
    }
}

fn invalid_encoding(encoding: &str, reason: impl std::fmt::Display) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Request,
        "apiRequest.fetch",
        format!("failed to decompress '{encoding}' encoding: {reason}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn pinned_zlib_layout_fits_its_preallocated_working_allowance() {
        let state = zlib_rs::inflate::INFLATE_STATE_SIZE;
        let allocated = (state.next_multiple_of(64) + 32768 + 64 + 63).next_multiple_of(64);
        // Include the temporary initializer state and the public decoder wrapper too.
        assert!(allocated + state + std::mem::size_of::<Decompress>() <= ZLIB_WORKING_BYTES);
    }

    fn body(bytes: &[u8], budget: &PairedBudget) -> Arc<RetainedBody> {
        let mut buffer = BodyBuffer::new(budget.clone(), MAXIMUM_BODY_BYTES);
        buffer.append(bytes, "test").unwrap();
        buffer.finish()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[tokio::test]
    async fn compressed_and_decoded_custody_overlap_until_original_release() {
        let budget = PairedBudget::testing(512 * 1024);
        let encoded = body(&gzip(b"original bytes"), &budget);
        let compressed_capacity = budget.retained();
        let original = encoded.clone();
        let decoded = decode(encoded, "gzip", budget.clone(), || Ok(()))
            .await
            .unwrap();
        assert_eq!(decoded.bytes.as_slice(), b"original bytes");
        assert_eq!(
            budget.retained(),
            compressed_capacity + decoded.bytes.capacity()
        );
        drop(original);
        assert_eq!(budget.retained(), decoded.bytes.capacity());
        drop(decoded);
        assert_eq!(budget.retained(), 0);
    }

    #[tokio::test]
    async fn quota_failure_drops_only_this_decode_and_a_successor_can_continue() {
        let budget = PairedBudget::testing(256 * 1024);
        let encoded = body(&gzip(b"original bytes"), &budget);
        let original = encoded.clone();
        let pressure = budget
            .reserve(256 * 1024 - original.bytes.capacity(), "other request")
            .unwrap();
        assert_eq!(
            decode(encoded, "gzip", budget.clone(), || Ok(()))
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(budget.retained(), 256 * 1024);
        drop(pressure);
        assert_eq!(budget.retained(), original.bytes.capacity());
        let unchanged = decode(original, "gzip", budget.clone(), || Ok(()))
            .await
            .unwrap();
        assert_eq!(unchanged.bytes.as_slice(), b"original bytes");
        assert_eq!(budget.retained(), unchanged.bytes.capacity());
        drop(unchanged);
        assert_eq!(budget.retained(), 0);
    }

    #[tokio::test]
    async fn decode_checks_cancellation_between_bounded_chunks_and_releases_workspace() {
        let budget = PairedBudget::testing(8 * 1024 * 1024);
        let encoded = body(&gzip(&vec![7; 2 * 1024 * 1024]), &budget);
        let mut checks = 0;
        let error = decode(encoded, "gzip", budget.clone(), || {
            checks += 1;
            if checks == 8 {
                Err(ErrorRecord::new(
                    ErrorCode::Cancelled,
                    "apiRequest.fetch",
                    "original cancellation",
                ))
            } else {
                Ok(())
            }
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.message.as_ref(), "original cancellation");
        assert_eq!(budget.retained(), 0);
    }

    #[tokio::test]
    async fn partial_gzip_and_empty_encoded_bodies_keep_the_pinned_contract() {
        let budget = PairedBudget::testing(1024 * 1024);
        let compressed = gzip(b"decoded bytes");
        let truncated = body(&compressed[..compressed.len() - 8], &budget);
        let decoded = decode(truncated, "gzip", budget.clone(), || Ok(()))
            .await
            .unwrap();
        assert_eq!(decoded.bytes.as_slice(), b"decoded bytes");
        drop(decoded);
        let malformed = body(b"not gzip", &budget);
        assert_eq!(
            decode(malformed, "gzip", budget.clone(), || Ok(()))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Request
        );
        let empty = body(&[], &budget);
        assert!(
            decode(empty, "deflate", budget.clone(), || Ok(()))
                .await
                .unwrap()
                .bytes
                .is_empty()
        );
        assert_eq!(budget.retained(), 0);
    }

    #[tokio::test]
    async fn long_gzip_header_is_scanned_in_bounded_chunks_without_another_header_copy() {
        let budget = PairedBudget::testing(1024 * 1024);
        let compressed = gzip(b"original body");
        let mut extended = compressed[..10].to_vec();
        extended[3] |= 8;
        extended.extend(std::iter::repeat_n(b'a', 160 * 1024));
        extended.push(0);
        extended.extend_from_slice(&compressed[10..]);
        let encoded = body(&extended, &budget);
        let encoded_capacity = budget.retained();
        let mut checks = 0;
        let mut peak = 0;
        let decoded = decode(encoded, "gzip", budget.clone(), || {
            checks += 1;
            peak = peak.max(budget.retained());
            Ok(())
        })
        .await
        .unwrap();
        assert!(checks >= 8);
        assert!(peak <= encoded_capacity + ZLIB_WORKING_BYTES + CHUNK_BYTES * 2);
        assert_eq!(decoded.bytes.as_slice(), b"original body");
        assert_eq!(budget.retained(), decoded.bytes.capacity());
        drop(decoded);
        assert_eq!(budget.retained(), 0);
    }

    #[tokio::test]
    async fn brotli_pressure_keeps_the_original_body_and_recovers_after_other_work_releases() {
        let compressed = [
            27, 255, 4, 248, 29, 7, 185, 41, 243, 34, 250, 143, 236, 28, 37, 176, 197, 69, 56, 214,
            238, 247, 16, 149, 44, 132, 181, 233, 86, 39, 222, 32, 72, 66, 145, 103, 114, 133, 27,
            40, 193, 230, 21, 101, 88, 146, 203, 91, 110, 108, 73, 42, 1,
        ];
        let expected = "decoded body\0 and unicode ℵ, repeated ".repeat(32);
        let mut failures = 0;
        let mut successes = 0;
        for allowance in (1024..=256 * 1024).step_by(1024) {
            let budget = PairedBudget::testing(512 * 1024);
            let encoded = body(&compressed, &budget);
            let original_capacity = budget.retained();
            let pressure = budget
                .reserve(512 * 1024 - allowance, "other request")
                .unwrap();
            match decode(encoded.clone(), "br", budget.clone(), || Ok(())).await {
                Ok(decoded) => {
                    assert_eq!(decoded.bytes.as_slice(), expected.as_bytes());
                    successes += 1;
                }
                Err(error) => {
                    assert_eq!(error.code, ErrorCode::ResourceLimit);
                    failures += 1;
                }
            }
            assert_eq!(
                budget.retained(),
                original_capacity + 512 * 1024 - allowance
            );
            assert_eq!(encoded.bytes.as_slice(), compressed);
            drop(pressure);
            let decoded = decode(encoded, "br", budget.clone(), || Ok(()))
                .await
                .unwrap();
            assert_eq!(decoded.bytes.as_slice(), expected.as_bytes());
            drop(decoded);
            assert_eq!(budget.retained(), 0);
        }
        assert!(failures > 0 && successes > 0);
    }

    #[tokio::test]
    async fn dropping_a_yielded_decode_releases_workspace_before_returning_original_credit() {
        let budget = PairedBudget::testing(8 * 1024 * 1024);
        let encoded = body(&gzip(&vec![9; 4 * 1024 * 1024]), &budget);
        let original_capacity = budget.retained();
        let mut decoding = Box::pin(decode(encoded.clone(), "gzip", budget.clone(), || Ok(())));
        std::future::poll_fn(|context| {
            assert!(std::future::Future::poll(decoding.as_mut(), context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        assert!(budget.retained() > original_capacity + ZLIB_WORKING_BYTES);
        drop(decoding);
        assert_eq!(budget.retained(), original_capacity);
        drop(encoded);
        assert_eq!(budget.retained(), 0);
    }
}
