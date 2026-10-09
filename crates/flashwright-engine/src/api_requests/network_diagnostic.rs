//! Format one transport cause without constructing unbounded certificate diagnostics.

use std::fmt::{self, Write};

const MAXIMUM_BYTES: usize = 4096;

struct Diagnostic {
    bytes: [u8; MAXIMUM_BYTES],
    length: usize,
    truncated: bool,
}

impl Write for Diagnostic {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.truncated {
            return Err(fmt::Error);
        }
        let available = MAXIMUM_BYTES - self.length;
        let retained = value.floor_char_boundary(available.min(value.len()));
        self.bytes[self.length..self.length + retained]
            .copy_from_slice(&value.as_bytes()[..retained]);
        self.length += retained;
        if retained < value.len() {
            self.truncated = true;
            return Err(fmt::Error);
        }
        Ok(())
    }
}

/// Stop rendering at the byte limit, preserving UTF-8 and an explicit truncation marker.
/// The original error remains owned by the caller while its Display implementation runs.
pub(super) fn message(error: &(dyn std::error::Error + 'static)) -> String {
    let mut diagnostic = Diagnostic {
        bytes: [0; MAXIMUM_BYTES],
        length: 0,
        truncated: false,
    };
    let _ = write!(&mut diagnostic, "{error}");
    let text = std::str::from_utf8(&diagnostic.bytes[..diagnostic.length])
        .expect("diagnostic copies only complete UTF-8 characters");
    if diagnostic.truncated {
        let length = text.floor_char_boundary(text.len().min(MAXIMUM_BYTES - 3));
        diagnostic.bytes[length..length + 3].copy_from_slice(b"...");
        diagnostic.length = length + 3;
    }
    std::str::from_utf8(&diagnostic.bytes[..diagnostic.length])
        .expect("diagnostic marker preserves UTF-8")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug)]
    struct RepeatedError {
        value: &'static str,
        count: usize,
        rendered: AtomicUsize,
    }

    impl fmt::Display for RepeatedError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            for _ in 0..self.count {
                self.rendered.fetch_add(1, Ordering::Relaxed);
                formatter.write_str(self.value)?;
            }
            Ok(())
        }
    }
    impl std::error::Error for RepeatedError {}

    #[test]
    fn oversized_diagnostics_stop_rendering_at_a_complete_utf8_boundary() {
        for value in ["a", "é", "界", "🙂"] {
            let error = RepeatedError {
                value,
                count: 1_000_000,
                rendered: AtomicUsize::new(0),
            };
            let result = message(&error);
            assert!(result.len() <= MAXIMUM_BYTES);
            assert!(result.capacity() <= MAXIMUM_BYTES);
            assert!(result.ends_with("..."));
            assert_eq!(
                result.trim_end_matches('.'),
                value.repeat((MAXIMUM_BYTES - 3) / value.len())
            );
            assert!(error.rendered.load(Ordering::Relaxed) <= MAXIMUM_BYTES / value.len() + 1);
        }
    }

    #[test]
    fn complete_diagnostics_keep_their_original_text_at_the_exact_limit() {
        for count in [0, 1, MAXIMUM_BYTES] {
            let error = RepeatedError {
                value: "a",
                count,
                rendered: AtomicUsize::new(0),
            };
            assert_eq!(message(&error), "a".repeat(count));
            assert_eq!(error.rendered.load(Ordering::Relaxed), count);
        }
    }
}
