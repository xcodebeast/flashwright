//! In-process writer receipts; these do not change the application wire protocol.

use tokio::sync::watch;

use crate::{ErrorCode, ErrorRecord};

#[derive(Clone, Debug, Default)]
struct Progress {
    written: u64,
    failure: Option<ErrorRecord>,
}

/// Registration and queue insertion must share one serialization boundary.
#[derive(Debug)]
pub struct OutputDelivery {
    issued: u64,
    progress: watch::Sender<Progress>,
}

impl Default for OutputDelivery {
    fn default() -> Self {
        Self {
            issued: 0,
            progress: watch::channel(Progress::default()).0,
        }
    }
}

impl OutputDelivery {
    pub fn register(&mut self) -> Result<OutputAcknowledgement, ErrorRecord> {
        self.issued = self.issued.checked_add(1).ok_or_else(delivery_failed)?;
        Ok(OutputAcknowledgement {
            sequence: self.issued,
            progress: self.progress.clone(),
            completed: false,
        })
    }

    /// Capture a finite prefix. Later publications cannot extend this wait.
    pub fn pending(&self) -> Option<OutputBarrier> {
        let finished = {
            let progress = self.progress.borrow();
            progress.failure.is_none() && progress.written == self.issued
        };
        if finished {
            return None;
        }
        Some(OutputBarrier {
            sequence: self.issued,
            progress: self.progress.subscribe(),
        })
    }
}

#[derive(Debug)]
pub struct OutputAcknowledgement {
    sequence: u64,
    progress: watch::Sender<Progress>,
    completed: bool,
}

impl OutputAcknowledgement {
    /// Called only after the original complete frame has been written.
    pub fn complete(mut self) {
        self.progress.send_modify(|progress| {
            if progress.written.checked_add(1) == Some(self.sequence) {
                progress.written = self.sequence;
            } else {
                // A missing or reordered receipt is not proof of a written prefix.
                progress.failure.get_or_insert_with(delivery_failed);
            }
        });
        self.completed = true;
    }

    /// Reject the original frame before any potentially blocked replacement write.
    pub fn reject(mut self, error: ErrorRecord) {
        self.progress.send_modify(|progress| {
            progress.failure.get_or_insert(error);
        });
        self.completed = true;
    }
}

impl Drop for OutputAcknowledgement {
    fn drop(&mut self) {
        if !self.completed {
            self.progress.send_modify(|progress| {
                progress.failure.get_or_insert_with(delivery_failed);
            });
        }
    }
}

pub struct OutputBarrier {
    sequence: u64,
    progress: watch::Receiver<Progress>,
}

impl OutputBarrier {
    pub async fn wait(mut self) -> Result<(), ErrorRecord> {
        loop {
            let outcome = {
                let progress = self.progress.borrow_and_update();
                if let Some(error) = &progress.failure {
                    Some(Err(error.clone()))
                } else if progress.written >= self.sequence {
                    Some(Ok(()))
                } else {
                    None
                }
            };
            if let Some(outcome) = outcome {
                return outcome;
            }
            self.progress
                .changed()
                .await
                .map_err(|_| delivery_failed())?;
        }
    }
}

fn delivery_failed() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::Protocol,
        "protocol.output",
        "event output delivery stopped before the complete frame was written",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Duration, timeout};

    #[tokio::test]
    async fn captured_prefix_waits_for_all_original_receipts_but_not_later_work() {
        let mut delivery = OutputDelivery::default();
        assert!(delivery.pending().is_none());
        let first = delivery.register().unwrap();
        let second = delivery.register().unwrap();
        let mut barrier = Box::pin(delivery.pending().unwrap().wait());
        let later = delivery.register().unwrap();
        first.complete();
        assert!(
            timeout(Duration::from_millis(10), &mut barrier)
                .await
                .is_err()
        );
        second.complete();
        timeout(Duration::from_secs(1), barrier)
            .await
            .unwrap()
            .unwrap();
        assert!(delivery.pending().is_some());
        later.complete();
        assert!(delivery.pending().is_none());
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_discard_queued_output_or_its_later_observer() {
        let mut delivery = OutputDelivery::default();
        let output = delivery.register().unwrap();
        assert!(
            timeout(
                Duration::from_millis(10),
                delivery.pending().unwrap().wait()
            )
            .await
            .is_err()
        );
        let observer = delivery.pending().unwrap();
        output.complete();
        observer.wait().await.unwrap();
    }

    #[tokio::test]
    async fn missing_or_reordered_receipt_cannot_establish_success() {
        for reorder in [false, true] {
            let mut delivery = OutputDelivery::default();
            let first = delivery.register().unwrap();
            let second = delivery.register().unwrap();
            let barrier = delivery.pending().unwrap();
            if reorder {
                second.complete();
            } else {
                drop(second);
            }
            first.complete();
            assert_eq!(barrier.wait().await.unwrap_err().code, ErrorCode::Protocol);
        }
    }
}
