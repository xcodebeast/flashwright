//! Optional diagnostics retain admission through their final encoded output frame.

use super::*;
use serde::Serialize;
use std::collections::VecDeque;
use std::fmt;
use std::io::{self, Write};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAXIMUM_EVENTS: usize = 1024;
const MAXIMUM_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const CONTEXT_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const ENGINE_BYTES: usize = 64 * 1024 * 1024;
// Charge the queue's possible growth and fixed generation bookkeeping before starting it.
const RECORDING_BYTES: usize = 1024 + 2 * MAXIMUM_EVENTS * std::mem::size_of::<Diagnostic>();

struct DiagnosticBudget {
    context: Arc<Semaphore>,
    engine: Arc<Semaphore>,
}

impl DiagnosticBudget {
    fn reserve(&self, bytes: usize) -> Result<DiagnosticReservation, ErrorRecord> {
        let bytes = u32::try_from(bytes).map_err(|_| exhausted())?;
        let context = self
            .context
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(|_| exhausted())?;
        let engine = self
            .engine
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(|_| exhausted())?;
        Ok(DiagnosticReservation {
            _context: context,
            _engine: engine,
        })
    }
}

struct DiagnosticReservation {
    _context: OwnedSemaphorePermit,
    _engine: OwnedSemaphorePermit,
}

struct DiagnosticOwner {
    closed: Mutex<bool>,
    budget: DiagnosticBudget,
}

struct Diagnostic {
    value: Value,
    published: bool,
    bytes: usize,
    reservation: DiagnosticReservation,
}

struct Recording {
    generation: String,
    events: VecDeque<Diagnostic>,
    queued_bytes: usize,
    maximum_bytes: usize,
    failure: Option<ErrorRecord>,
    _reservation: DiagnosticReservation,
}

#[derive(Default)]
pub(crate) struct TraceDiagnostics {
    closed: bool,
    // This context's allowance survives stop/start while old drains still own its bytes.
    owner: Option<Arc<DiagnosticOwner>>,
    recording: Option<Recording>,
}

/// An accepted drain owns the original values; it never reads a successor recording.
pub struct RetainedDiagnostics {
    value: Value,
    owner: Arc<DiagnosticOwner>,
    encoded_bytes: usize,
    _events: Vec<DiagnosticReservation>,
    _reservation: DiagnosticReservation,
}

impl fmt::Debug for RetainedDiagnostics {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RetainedDiagnostics")
            .finish_non_exhaustive()
    }
}

struct DiagnosticFrameCustody {
    _batch: Arc<RetainedDiagnostics>,
    _reservation: DiagnosticReservation,
}

impl fmt::Debug for DiagnosticFrameCustody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DiagnosticFrameCustody")
            .finish_non_exhaustive()
    }
}

impl RetainedDiagnostics {
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }

    pub(crate) fn prepare<Prepared>(
        self: &Arc<Self>,
        prepare: impl FnOnce(&Value, Arc<dyn fmt::Debug + Send + Sync>) -> Result<Prepared, ErrorRecord>,
    ) -> Result<Prepared, ErrorRecord> {
        let closed = self.owner.closed.lock().unwrap();
        if *closed {
            return Err(super::closed("context.trace"));
        }
        // The encoding Vec can grow geometrically. The envelope, generation and
        // custody objects have fixed headroom. Each preparation owns a separate charge.
        let reservation = self.owner.budget.reserve(2 * (self.encoded_bytes + 1024))?;
        let custody = Arc::new(DiagnosticFrameCustody {
            _batch: self.clone(),
            _reservation: reservation,
        });
        prepare(&self.value, custody)
    }
}

impl TraceDiagnostics {
    fn start(
        &mut self,
        generation: &str,
        control_frame_bytes: usize,
        engine: Arc<Semaphore>,
    ) -> Result<Value, ErrorRecord> {
        if self.closed {
            return Err(closed("context.trace.start"));
        }
        if self.recording.is_some() {
            return Err(invalid(
                "context.trace.start",
                "diagnostic recording is already active",
            ));
        }
        let owner = self.owner.get_or_insert_with(|| {
            Arc::new(DiagnosticOwner {
                closed: Mutex::new(false),
                budget: DiagnosticBudget {
                    context: Arc::new(Semaphore::new(CONTEXT_BYTES)),
                    engine,
                },
            })
        });
        let reservation = owner.budget.reserve(RECORDING_BYTES)?;
        self.recording = Some(Recording {
            generation: generation.to_owned(),
            events: VecDeque::new(),
            queued_bytes: 0,
            maximum_bytes: MAXIMUM_QUEUE_BYTES.min(control_frame_bytes / 2),
            failure: None,
            _reservation: reservation,
        });
        Ok(Value::Null)
    }

    /// Count the borrowed serialization before copying any event data.
    pub(crate) fn capture(&mut self, page: &str, published: bool, kind: &str, raw: &str) {
        let Some(recording) = &mut self.recording else {
            return;
        };
        if recording.failure.is_some() {
            return;
        }
        if raw.len() > MAXIMUM_DIAGNOSTIC_BYTES || page.len() > 64 || kind.len() > 64 {
            self.fail("diagnostic exceeds its field byte limits");
            return;
        }
        #[derive(Serialize)]
        struct BorrowedDiagnostic<'a> {
            page: &'a str,
            kind: &'a str,
            raw: &'a str,
        }
        let mut counter = ByteCounter(0);
        serde_json::to_writer(&mut counter, &BorrowedDiagnostic { page, kind, raw })
            .expect("counting bounded strings cannot fail");
        let bytes = counter.0 + 1;
        if recording.events.len() >= MAXIMUM_EVENTS
            || recording.queued_bytes + bytes > recording.maximum_bytes
        {
            self.fail("diagnostic queue exceeds its event or byte limit");
            return;
        }
        // The three owned strings plus fixed Value/map bookkeeping. Queue capacity
        // is charged by the recording; drained vectors and output frames charge separately.
        let reservation = match self
            .owner
            .as_ref()
            .unwrap()
            .budget
            .reserve(raw.len() + page.len() + kind.len() + 1024)
        {
            Ok(reservation) => reservation,
            Err(_) => {
                self.fail("diagnostic retained allowance exhausted");
                return;
            }
        };
        let value = json!({ "page": page, "kind": kind, "raw": raw });
        recording.queued_bytes += bytes;
        recording.events.push_back(Diagnostic {
            value,
            published,
            bytes,
            reservation,
        });
    }

    fn fail(&mut self, message: &str) {
        let recording = self.recording.as_mut().unwrap();
        recording.failure.get_or_insert_with(|| {
            ErrorRecord::new(ErrorCode::ResourceLimit, "context.trace", message)
        });
        recording.events = VecDeque::new();
        recording.queued_bytes = 0;
    }

    pub(crate) fn publish_page(&mut self, page: &str) {
        if let Some(recording) = &mut self.recording {
            for event in &mut recording.events {
                if event.value["page"] == page {
                    event.published = true;
                }
            }
        }
    }

    pub(crate) fn discard_unpublished_page(&mut self, page: &str) {
        if let Some(recording) = &mut self.recording {
            recording
                .events
                .retain(|event| event.published || event.value["page"] != page);
            recording.queued_bytes = recording.events.iter().map(|event| event.bytes).sum();
        }
    }

    fn drain(
        &mut self,
        generation: &str,
        stop: bool,
    ) -> Result<Arc<RetainedDiagnostics>, ErrorRecord> {
        if self.closed {
            return Err(closed("context.trace"));
        }
        if self
            .recording
            .as_ref()
            .map(|recording| recording.generation.as_str())
            != Some(generation)
        {
            return Err(invalid(
                "context.trace",
                "diagnostic generation is not active",
            ));
        }
        let result = self.drain_current();
        if result.is_err() && self.recording.as_ref().unwrap().failure.is_none() {
            self.fail("diagnostic retained allowance exhausted while draining");
        }
        if stop {
            self.recording = None;
        }
        result
    }

    fn drain_current(&mut self) -> Result<Arc<RetainedDiagnostics>, ErrorRecord> {
        let recording = self.recording.as_mut().unwrap();
        if let Some(error) = &recording.failure {
            return Err(error.clone());
        }
        let owner = self.owner.as_ref().unwrap();
        let count = recording
            .events
            .iter()
            .filter(|event| event.published)
            .count();
        let reservation = owner.budget.reserve(
            1024 + count
                * (std::mem::size_of::<Value>() + std::mem::size_of::<DiagnosticReservation>()),
        )?;
        let mut values = Vec::with_capacity(count);
        let mut reservations = Vec::with_capacity(count);
        let mut encoded_bytes = 0;
        // Move each original Value exactly once, retaining unpublished events in order.
        for _ in 0..recording.events.len() {
            let event = recording.events.pop_front().unwrap();
            if event.published {
                recording.queued_bytes -= event.bytes;
                encoded_bytes += event.bytes;
                values.push(event.value);
                reservations.push(event.reservation);
            } else {
                recording.events.push_back(event);
            }
        }
        let mut value = serde_json::Map::new();
        value.insert(
            "generation".into(),
            Value::String(recording.generation.clone()),
        );
        value.insert("events".into(), Value::Array(values));
        Ok(Arc::new(RetainedDiagnostics {
            value: Value::Object(value),
            owner: owner.clone(),
            encoded_bytes,
            _events: reservations,
            _reservation: reservation,
        }))
    }

    /// Teardown rejects unpublished drains, while already prepared frames keep their custody.
    pub(crate) fn close(&mut self) {
        self.closed = true;
        if let Some(owner) = &self.owner {
            *owner.closed.lock().unwrap() = true;
        }
        self.recording = None;
    }
}

fn exhausted() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::ResourceLimit,
        "context.trace",
        "diagnostic retained allowance exhausted",
    )
}

struct ByteCounter(usize);
impl Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Engine {
    /// Driver acceptance orders diagnostic fences before asynchronous public operations.
    pub fn execute_diagnostic_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Option<Result<OperationResult, ErrorRecord>> {
        if !matches!(
            method,
            "context.trace.start" | "context.trace.pull" | "context.trace.stop"
        ) {
            return None;
        }
        Some(self.trace_diagnostic_control(method, parameters, operation))
    }

    fn trace_diagnostic_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Result<OperationResult, ErrorRecord> {
        operation.check()?;
        validate_keys(method, parameters, &["context", "generation"])?;
        let context = self.context(identifier(parameters, "context", method)?, method)?;
        if !context.published {
            return Err(invalid(method, "tracing requires a published context"));
        }
        let generation = identifier(parameters, "generation", method)?;
        if generation.len() > 64 {
            return Err(invalid(method, "generation exceeds 64 bytes"));
        }
        let mut diagnostics = context.state.trace_diagnostics.lock().unwrap();
        match method {
            "context.trace.start" => {
                let engine = self
                    .trace_diagnostic_budget
                    .get_or_init(|| Arc::new(Semaphore::new(ENGINE_BYTES)))
                    .clone();
                let result =
                    diagnostics.start(generation, self.maximum_control_frame_bytes, engine)?;
                context.state.trace_enabled.store(true, Ordering::Relaxed);
                Ok(OperationResult::Value(result))
            }
            "context.trace.pull" => diagnostics
                .drain(generation, false)
                .map(OperationResult::RetainedDiagnostics),
            "context.trace.stop" => {
                let result = diagnostics.drain(generation, true);
                if diagnostics.recording.is_none() {
                    context.state.trace_enabled.store(false, Ordering::Relaxed);
                }
                result.map(OperationResult::RetainedDiagnostics)
            }
            _ => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests;
