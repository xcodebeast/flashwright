//! Recovery commands use reserved capacity without exceeding the negotiated pending total.

const MAXIMUM_RECOVERY_RESERVE: usize = 16;
pub const MINIMUM_DIALOG_PENDING_OPERATIONS: usize = 2;

/// A one-slot protocol peer can run serial operations, but cannot subscribe to host dialogs.
pub fn ordinary_operation_limit(total: usize) -> usize {
    if total < MINIMUM_DIALOG_PENDING_OPERATIONS {
        return total;
    }
    total - MAXIMUM_RECOVERY_RESERVE.min(total - 1)
}

pub fn is_recovery_operation(method: &str) -> bool {
    matches!(
        method,
        "dialog.accept"
            | "dialog.dismiss"
            | "page.dialog.subscribe"
            | "context.dialog.subscribe"
            | "page.console.subscribe"
            | "context.console.subscribe"
            | "page.close"
            | "context.close"
            | "browser.close"
            | "apiRequest.dispose"
            | "apiResponse.dispose"
    )
}

/// Collection cannot wait for renderer work, including when attachment permits are occupied.
pub fn is_trace_collection(method: &str) -> bool {
    matches!(
        method,
        "context.trace.snapshot.pull"
            | "context.trace.snapshot.take"
            | "context.trace.snapshot.ingested"
            | "context.trace.network.pull"
            | "context.trace.network.take"
            | "context.trace.network.ingested"
    )
}

pub fn admits_operation(pending: usize, total: usize, method: &str) -> bool {
    pending
        < if is_recovery_operation(method) || is_trace_collection(method) {
            total
        } else {
            ordinary_operation_limit(total)
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modal_recovery_fits_when_ordinary_admission_is_full() {
        for total in [2, 3, 16, 17, 1024] {
            let ordinary = ordinary_operation_limit(total);
            assert!(ordinary >= 1 && ordinary < total);
            assert!(admits_operation(ordinary - 1, total, "page.evaluate"));
            assert!(!admits_operation(ordinary, total, "page.evaluate"));
            for method in [
                "dialog.accept",
                "dialog.dismiss",
                "page.dialog.subscribe",
                "context.dialog.subscribe",
                "page.console.subscribe",
                "context.console.subscribe",
                "page.close",
                "context.close",
                "browser.close",
                "apiRequest.dispose",
                "apiResponse.dispose",
            ] {
                assert!(admits_operation(ordinary, total, method));
                assert!(!admits_operation(total, total, method));
            }
        }
    }

    #[test]
    fn serial_protocol_capacity_is_not_silently_increased() {
        assert_eq!(ordinary_operation_limit(0), 0);
        assert_eq!(ordinary_operation_limit(1), 1);
        assert!(!admits_operation(1, 1, "dialog.accept"));
        assert!(admits_operation(0, 1, "browser.launch"));
        assert!(!is_recovery_operation("dialog.accept.extra"));
        assert!(!is_recovery_operation("page.console.subscribe.extra"));
        assert!(!is_recovery_operation("apiRequest.dispose.extra"));
        assert!(!is_recovery_operation("apiResponse.body"));
        assert!(!is_recovery_operation("page.evaluate"));
        assert!(!is_recovery_operation("context.trace.stop"));
    }

    #[test]
    fn only_native_collection_can_use_reserved_capacity_to_release_capture_bytes() {
        for total in [1, 2, 3, 17, 1024] {
            for method in [
                "context.trace.snapshot.pull",
                "context.trace.snapshot.take",
                "context.trace.snapshot.ingested",
                "context.trace.network.pull",
                "context.trace.network.take",
                "context.trace.network.ingested",
            ] {
                assert!(admits_operation(total - 1, total, method));
                assert!(!admits_operation(total, total, method));
            }
        }
        for method in [
            "context.trace.snapshot.after",
            "context.trace.snapshot.take.extra",
            "context.trace.filmstrip.activity",
            "context.trace.network.entry",
        ] {
            assert!(!is_trace_collection(method));
            assert!(!admits_operation(1, 2, method));
        }
    }

    #[test]
    fn ordinary_requests_count_existing_recovery_requests_within_the_same_total() {
        for total in [2, 3, 17, 1024] {
            let ordinary = ordinary_operation_limit(total);
            let mut pending = 0;
            assert!(admits_operation(pending, total, "dialog.accept"));
            pending += 1;
            while pending < ordinary {
                assert!(admits_operation(pending, total, "page.evaluate"));
                pending += 1;
            }
            assert!(!admits_operation(pending, total, "page.evaluate"));
            while pending < total {
                assert!(admits_operation(pending, total, "page.close"));
                pending += 1;
            }
            assert!(!admits_operation(pending, total, "dialog.dismiss"));
            assert!(!admits_operation(pending, total, "page.evaluate"));
        }
    }
}
