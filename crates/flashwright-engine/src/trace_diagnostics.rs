//! Optional tracing owns a pull queue; capture failure never enters the fatal event outbox.

use super::*;
use std::collections::VecDeque;

const MAXIMUM_EVENTS: usize = 1024;
const MAXIMUM_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_DIAGNOSTIC_BYTES: usize = 64 * 1024;

struct Diagnostic {
    page: String,
    published: bool,
    value: Value,
    bytes: usize,
}

#[derive(Default)]
pub(crate) struct TraceDiagnostics {
    closed: bool,
    generation: Option<String>,
    events: VecDeque<Diagnostic>,
    queued_bytes: usize,
    maximum_bytes: usize,
    failure: Option<ErrorRecord>,
}

impl TraceDiagnostics {
    fn start(
        &mut self,
        generation: &str,
        control_frame_bytes: usize,
    ) -> Result<Value, ErrorRecord> {
        if self.closed {
            return Err(closed("context.trace.start"));
        }
        if self.generation.is_some() {
            return Err(invalid(
                "context.trace.start",
                "diagnostic recording is already active",
            ));
        }
        self.generation = Some(generation.to_owned());
        self.maximum_bytes = MAXIMUM_QUEUE_BYTES.min(control_frame_bytes / 2);
        Ok(Value::Null)
    }

    /// Admission and byte accounting share one lock with drains and publication.
    pub(crate) fn capture(&mut self, page: &str, published: bool, kind: &str, raw: &str) {
        if self.generation.is_none() || self.failure.is_some() {
            return;
        }
        if raw.len() > MAXIMUM_DIAGNOSTIC_BYTES {
            self.fail("diagnostic exceeds 64 KiB");
            return;
        }
        let value = json!({ "page": page, "kind": kind, "raw": raw });
        let bytes = value.to_string().len() + 1;
        if self.events.len() >= MAXIMUM_EVENTS || self.queued_bytes + bytes > self.maximum_bytes {
            self.fail("diagnostic queue exceeds its event or byte limit");
            return;
        }
        self.queued_bytes += bytes;
        self.events.push_back(Diagnostic {
            page: page.into(),
            published,
            value,
            bytes,
        });
    }

    fn fail(&mut self, message: &str) {
        self.failure = Some(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            "context.trace",
            message,
        ));
        self.events.clear();
        self.queued_bytes = 0;
    }

    pub(crate) fn publish_page(&mut self, page: &str) {
        for event in &mut self.events {
            if event.page == page {
                event.published = true;
            }
        }
    }

    pub(crate) fn discard_unpublished_page(&mut self, page: &str) {
        self.events
            .retain(|event| event.published || event.page != page);
        self.queued_bytes = self.events.iter().map(|event| event.bytes).sum();
    }

    fn drain(&mut self, generation: &str, stop: bool) -> Result<Value, ErrorRecord> {
        if self.generation.as_deref() != Some(generation) {
            return Err(invalid(
                "context.trace",
                "diagnostic generation is not active",
            ));
        }
        let result = if let Some(error) = &self.failure {
            Err(error.clone())
        } else {
            let mut published = Vec::new();
            self.events.retain(|event| {
                if event.published {
                    published.push(event.value.clone());
                    false
                } else {
                    true
                }
            });
            self.queued_bytes = self.events.iter().map(|event| event.bytes).sum();
            Ok(json!({ "generation": generation, "events": published }))
        };
        if stop {
            *self = Self::default();
        }
        result
    }

    /// Owner teardown cannot retain initial diagnostics through outstanding context references.
    pub(crate) fn close(&mut self) {
        *self = Self::default();
        self.closed = true;
    }
}

impl Engine {
    /// Synchronous driver acceptance is the fence; no diagnostic push consumes the outbox.
    pub(crate) fn trace_diagnostic_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
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
                let result = diagnostics.start(generation, self.maximum_control_frame_bytes)?;
                context.state.trace_enabled.store(true, Ordering::Relaxed);
                Ok(result)
            }
            "context.trace.pull" => diagnostics.drain(generation, false),
            "context.trace.stop" => {
                let result = diagnostics.drain(generation, true);
                if diagnostics.generation.is_none() {
                    context.state.trace_enabled.store(false, Ordering::Relaxed);
                }
                result
            }
            _ => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_publication_never_exposes_initial_diagnostics() {
        let mut queue = TraceDiagnostics::default();
        queue.start("first", 8 * 1024 * 1024).unwrap();
        queue.capture("unpublished", false, "console-api", "{}");
        queue.capture("existing", true, "console-api", "{}");
        assert_eq!(
            queue.drain("first", false).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        queue.discard_unpublished_page("unpublished");
        assert_eq!(queue.queued_bytes, 0);
        assert!(
            queue.drain("first", true).unwrap()["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn publication_releases_initial_events_and_stop_rejects_old_generations() {
        let mut queue = TraceDiagnostics::default();
        queue.start("first", 8 * 1024 * 1024).unwrap();
        queue.capture("page", false, "console-api", "{}");
        queue.publish_page("page");
        assert_eq!(
            queue.drain("first", true).unwrap()["events"][0]["page"],
            "page"
        );
        queue.start("second", 8 * 1024 * 1024).unwrap();
        assert!(queue.drain("first", true).is_err());
        queue.capture("new-page", true, "console-api", "{}");
        assert_eq!(
            queue.drain("second", true).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn overflow_is_sticky_until_stop_and_does_not_grow_the_queue() {
        let mut queue = TraceDiagnostics::default();
        queue.start("first", 8 * 1024 * 1024).unwrap();
        for _ in 0..=MAXIMUM_EVENTS {
            queue.capture("page", true, "console-api", "{}");
        }
        assert_eq!(
            queue.drain("first", false).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        queue.capture("page", true, "console-api", "{}");
        assert!(queue.events.is_empty());
        assert_eq!(
            queue.drain("first", true).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        queue.start("second", 1024).unwrap();
        queue.capture("page", true, "console-api", &"x".repeat(512));
        assert_eq!(
            queue.drain("second", true).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
    }
}
