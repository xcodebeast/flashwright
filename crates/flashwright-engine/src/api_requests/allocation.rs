//! Decoder allocations fail once and retain their original credits until their buffers drop.

use super::budget::{PairedBudget, PairedReservation};
use brotli_decompressor::{Allocator, SliceWrapper, SliceWrapperMut};
use flashwright_protocol::{ErrorCode, ErrorRecord};
use std::mem::size_of;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct WorkingMemory<Value> {
    values: Vec<Value>,
    _capacity: Vec<PairedReservation>,
}

impl<Value> SliceWrapper<Value> for WorkingMemory<Value> {
    fn slice(&self) -> &[Value] {
        &self.values
    }
}

impl<Value> SliceWrapperMut<Value> for WorkingMemory<Value> {
    fn slice_mut(&mut self) -> &mut [Value] {
        &mut self.values
    }
}

struct AllocationState {
    budget: PairedBudget,
    failure: Option<ErrorRecord>,
}

#[derive(Clone)]
pub(super) struct BoundedAllocator {
    state: Arc<Mutex<AllocationState>>,
}

impl BoundedAllocator {
    pub(super) fn new(budget: PairedBudget) -> Self {
        Self {
            state: Arc::new(Mutex::new(AllocationState {
                budget,
                failure: None,
            })),
        }
    }

    pub(super) fn check(&self) -> Result<(), ErrorRecord> {
        self.state
            .lock()
            .expect("decoder allocation lock")
            .failure
            .clone()
            .map_or(Ok(()), Err)
    }

    pub(super) fn allocate<Value: Default + Clone>(
        &self,
        length: usize,
    ) -> Result<WorkingMemory<Value>, ErrorRecord> {
        let mut state = self.state.lock().expect("decoder allocation lock");
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        let result = allocate(&state.budget, length);
        if let Err(error) = &result {
            state.failure = Some(error.clone());
        }
        result
    }
}

fn allocate<Value: Default + Clone>(
    budget: &PairedBudget,
    length: usize,
) -> Result<WorkingMemory<Value>, ErrorRecord> {
    let bytes = length
        .checked_mul(size_of::<Value>())
        .ok_or_else(allocation_failure)?;
    let mut capacity = vec![budget.reserve(bytes, "apiRequest.fetch")?];
    let mut values = Vec::new();
    values
        .try_reserve_exact(length)
        .map_err(|_| allocation_failure())?;
    if values.capacity() > length {
        let excess = (values.capacity() - length)
            .checked_mul(size_of::<Value>())
            .ok_or_else(allocation_failure)?;
        capacity.push(budget.reserve(excess, "apiRequest.fetch")?);
    }
    values.resize(length, Value::default());
    Ok(WorkingMemory {
        values,
        _capacity: capacity,
    })
}

fn allocation_failure() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::ResourceLimit,
        "apiRequest.fetch",
        "API response decoder allocation failed",
    )
}

impl<Value: Default + Clone> Allocator<Value> for BoundedAllocator {
    type AllocatedMemory = WorkingMemory<Value>;

    fn alloc_cell(&mut self, length: usize) -> Self::AllocatedMemory {
        self.allocate(length).unwrap_or_default()
    }

    fn free_cell(&mut self, memory: Self::AllocatedMemory) {
        drop(memory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_failure_survives_frees_and_every_allocator_clone() {
        let budget = PairedBudget::testing(16);
        let allocator = BoundedAllocator::new(budget.clone());
        let mut decoder_allocator = allocator.clone();
        let original = allocator.allocate::<u32>(4).unwrap();
        assert_eq!(budget.retained(), 16);
        let rejected: WorkingMemory<u8> = decoder_allocator.alloc_cell(1);
        assert!(rejected.slice().is_empty());
        let first = allocator.check().unwrap_err();
        assert_eq!(first.code, ErrorCode::ResourceLimit);
        drop(original);
        assert_eq!(budget.retained(), 0);
        assert_eq!(
            allocator.allocate::<u8>(1).err().unwrap().message,
            first.message
        );
        let rejected: WorkingMemory<u32> = decoder_allocator.alloc_cell(1);
        assert!(rejected.slice().is_empty());
        assert_eq!(budget.retained(), 0);
        let successor = BoundedAllocator::new(budget.clone())
            .allocate::<u8>(16)
            .unwrap();
        assert_eq!(budget.retained(), 16);
        drop(successor);
        assert_eq!(budget.retained(), 0);
    }
}
