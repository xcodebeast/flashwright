//! Request allocations retain their original credits across disposal and transport publication.

use flashwright_protocol::{ErrorCode, ErrorRecord};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) const MAXIMUM_BODY_BYTES: usize = 32 * 1024 * 1024;
pub(super) const MAXIMUM_METADATA_BYTES: usize = 256 * 1024;
const CONTEXT_BYTES: usize = 64 * 1024 * 1024;
const ENGINE_BYTES: usize = 256 * 1024 * 1024;
pub(super) const CONNECTION_WORKING_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct Budget {
    maximum: usize,
    retained: AtomicUsize,
    description: &'static str,
}

impl Budget {
    pub(super) fn new(maximum: usize, description: &'static str) -> Arc<Self> {
        Arc::new(Self {
            maximum,
            retained: AtomicUsize::new(0),
            description,
        })
    }

    /// Retained objects never wait for user disposal and are never silently evicted.
    pub(super) fn reserve(
        self: &Arc<Self>,
        amount: usize,
        method: &str,
    ) -> Result<Reservation, ErrorRecord> {
        self.retained
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |retained| {
                retained
                    .checked_add(amount)
                    .filter(|next| *next <= self.maximum)
            })
            .map_err(|_| ErrorRecord::new(ErrorCode::ResourceLimit, method, self.description))?;
        Ok(Reservation {
            budget: self.clone(),
            amount,
        })
    }
}

#[derive(Debug)]
pub(super) struct Reservation {
    budget: Arc<Budget>,
    amount: usize,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget
            .retained
            .fetch_sub(self.amount, Ordering::AcqRel);
    }
}

#[derive(Debug, Clone)]
pub(super) struct PairedBudget {
    context: Arc<Budget>,
    engine: Arc<Budget>,
}

#[derive(Debug)]
pub(super) struct PairedReservation {
    _context: Reservation,
    _engine: Reservation,
}

impl PairedBudget {
    fn new(maximum: usize, description: &'static str, engine: &Arc<Budget>) -> Self {
        Self {
            context: Budget::new(maximum, description),
            engine: engine.clone(),
        }
    }

    pub(super) fn reserve(
        &self,
        amount: usize,
        method: &str,
    ) -> Result<PairedReservation, ErrorRecord> {
        let context = self.context.reserve(amount, method)?;
        let engine = self.engine.reserve(amount, method)?;
        Ok(PairedReservation {
            _context: context,
            _engine: engine,
        })
    }

    #[cfg(test)]
    pub(super) fn testing(maximum: usize) -> Self {
        Self::new(
            maximum,
            "context full",
            &Budget::new(maximum, "engine full"),
        )
    }

    #[cfg(test)]
    pub(super) fn retained(&self) -> usize {
        self.context.retained.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
pub(super) struct EngineBudget {
    pub(super) owners: Arc<Budget>,
    bodies: Arc<Budget>,
    metadata: Arc<Budget>,
    responses: Arc<Budget>,
    sockets: Arc<Budget>,
    lookups: Arc<Budget>,
    connections: Arc<Budget>,
}

impl Default for EngineBudget {
    fn default() -> Self {
        Self {
            owners: Budget::new(128, "API request engine exceeds 128 live context owners"),
            bodies: Budget::new(
                ENGINE_BYTES,
                "API request engine body allocation exceeds 256 MiB",
            ),
            metadata: Budget::new(
                ENGINE_BYTES,
                "API request engine metadata allocation exceeds 256 MiB",
            ),
            responses: Budget::new(
                65_536,
                "API request engine exceeds 65536 retained responses",
            ),
            sockets: Budget::new(256, "API request engine exceeds 256 open sockets"),
            lookups: Budget::new(64, "API request engine exceeds 64 pending DNS lookups"),
            connections: Budget::new(
                256 * CONNECTION_WORKING_BYTES,
                "API request engine connection workspace exceeds 2 GiB",
            ),
        }
    }
}

#[derive(Debug)]
pub(super) struct ContextBudget {
    pub(super) bodies: PairedBudget,
    pub(super) metadata: PairedBudget,
    pub(super) responses: PairedBudget,
    pub(super) sockets: PairedBudget,
    pub(super) lookups: PairedBudget,
    pub(super) connections: PairedBudget,
}

impl ContextBudget {
    pub(super) fn new(engine: &EngineBudget) -> Self {
        Self {
            bodies: PairedBudget::new(
                CONTEXT_BYTES,
                "API request context body allocation exceeds 64 MiB",
                &engine.bodies,
            ),
            metadata: PairedBudget::new(
                CONTEXT_BYTES,
                "API request context metadata allocation exceeds 64 MiB",
                &engine.metadata,
            ),
            responses: PairedBudget::new(
                16_384,
                "API request context exceeds 16384 retained responses",
                &engine.responses,
            ),
            sockets: PairedBudget::new(
                16,
                "API request context exceeds 16 open sockets",
                &engine.sockets,
            ),
            lookups: PairedBudget::new(
                16,
                "API request context exceeds 16 pending DNS lookups",
                &engine.lookups,
            ),
            connections: PairedBudget::new(
                16 * CONNECTION_WORKING_BYTES,
                "API request context connection workspace exceeds 128 MiB",
                &engine.connections,
            ),
        }
    }
}

/// Bytes and their allocation credit remain together until the final response or transfer drops.
#[derive(Debug)]
pub(super) struct RetainedBody {
    pub(super) bytes: Arc<Vec<u8>>,
    _capacity: Vec<PairedReservation>,
}

pub(super) struct BodyBuffer {
    bytes: Vec<u8>,
    capacity: Vec<PairedReservation>,
    budget: PairedBudget,
    maximum: usize,
}

impl BodyBuffer {
    pub(super) fn new(budget: PairedBudget, maximum: usize) -> Self {
        Self {
            bytes: Vec::new(),
            capacity: Vec::new(),
            budget,
            maximum,
        }
    }

    /// Admit replacement capacity while the old allocation remains charged. Failed growth
    /// leaves the original bytes intact; successful growth frees them before returning credits.
    pub(super) fn append(&mut self, bytes: &[u8], method: &str) -> Result<(), ErrorRecord> {
        let length = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|length| *length <= self.maximum)
            .ok_or_else(|| {
                ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "API response body exceeds its byte limit",
                )
            })?;
        if length > self.bytes.capacity() {
            let requested = length
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.maximum);
            let mut charges = vec![self.budget.reserve(requested, method)?];
            let mut replacement = Vec::new();
            replacement.try_reserve_exact(requested).map_err(|_| {
                ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "API response body allocation failed",
                )
            })?;
            if replacement.capacity() > requested {
                charges.push(
                    self.budget
                        .reserve(replacement.capacity() - requested, method)?,
                );
            }
            replacement.extend_from_slice(&self.bytes);
            let previous_bytes = std::mem::replace(&mut self.bytes, replacement);
            let previous_charge = std::mem::replace(&mut self.capacity, charges);
            drop(previous_bytes);
            drop(previous_charge);
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub(super) fn finish(self) -> Arc<RetainedBody> {
        Arc::new(RetainedBody {
            bytes: Arc::new(self.bytes),
            _capacity: self.capacity,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiny_retained_responses_charge_actual_capacity_instead_of_a_full_read_chunk() {
        let engine = Budget::new(256, "engine full");
        let pair = PairedBudget::new(256, "context full", &engine);
        let mut responses = Vec::new();
        for _ in 0..128 {
            let mut body = BodyBuffer::new(pair.clone(), MAXIMUM_BODY_BYTES);
            body.append(b"ok", "test").unwrap();
            responses.push(body.finish());
        }
        assert_eq!(engine.retained.load(Ordering::Acquire), 256);
        assert!(responses.iter().all(|body| body.bytes.as_slice() == b"ok"));
        drop(responses);
        assert_eq!(engine.retained.load(Ordering::Acquire), 0);
    }

    #[test]
    fn failed_engine_admission_returns_context_credit_without_eviction() {
        let engine = Budget::new(8, "engine full");
        let pair = PairedBudget::new(16, "context full", &engine);
        let original = pair.reserve(8, "test").unwrap();
        assert_eq!(
            pair.reserve(1, "test").unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(pair.context.retained.load(Ordering::Acquire), 8);
        drop(original);
        assert_eq!(pair.context.retained.load(Ordering::Acquire), 0);
        assert!(pair.reserve(8, "test").is_ok());
    }

    #[test]
    fn growing_buffer_charges_both_allocations_and_preserves_original_on_failure() {
        let engine = Budget::new(128 * 1024, "engine full");
        let pair = PairedBudget::new(128 * 1024, "context full", &engine);
        let mut body = BodyBuffer::new(pair.clone(), 128 * 1024);
        body.append(&vec![1; 64 * 1024], "test").unwrap();
        assert_eq!(
            body.append(&[2], "test").unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(body.bytes, vec![1; 64 * 1024]);
        let retained = body.finish();
        let transfer = retained.clone();
        drop(retained);
        assert_eq!(pair.context.retained.load(Ordering::Acquire), 64 * 1024);
        drop(transfer);
        assert_eq!(pair.context.retained.load(Ordering::Acquire), 0);
    }

    #[test]
    fn response_limit_rejects_before_allocation_and_successful_growth_releases_old_capacity() {
        let engine = Budget::new(512 * 1024, "engine full");
        let pair = PairedBudget::new(512 * 1024, "context full", &engine);
        let mut body = BodyBuffer::new(pair.clone(), 100_000);
        body.append(&[3], "test").unwrap();
        body.append(&vec![4; 70_000], "test").unwrap();
        assert_eq!(
            pair.context.retained.load(Ordering::Acquire),
            body.bytes.capacity()
        );
        assert_eq!(
            body.append(&vec![5; 30_000], "test").unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(body.bytes.len(), 70_001);
        drop(body);
        assert_eq!(engine.retained.load(Ordering::Acquire), 0);
    }
}
