//! Rare timezone-less expiry conversion uses the original host VM's timezone database.
//! Replies bypass operation admission so a full fetch queue cannot deadlock itself.

use super::budget::PairedReservation;
use super::cookie_date::{self, DateValue};
use super::cookie_jar::{CookieJar, CookieUrl};
use super::exchange::Header;
use super::registry::RequestContext;
use crate::{Engine, Operation};
use flashwright_protocol::{DriverOutput, EncodedFrame, ErrorCode, ErrorRecord};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

const METHOD: &str = "apiRequest.fetch";
const MAXIMUM_DATES: usize = 1024;

type DateReply = Vec<Option<f64>>;

#[derive(Default)]
pub(super) struct PendingDates(Mutex<PendingState>);
#[derive(Default)]
struct PendingState {
    closed: bool,
    entries: BTreeMap<String, PendingEntry>,
}
struct PendingEntry {
    count: usize,
    sender: oneshot::Sender<DateReply>,
}

impl PendingDates {
    pub(super) fn close(&self) {
        let mut state = self.0.lock().expect("API local date lock");
        state.closed = true;
        state.entries.clear();
    }

    fn insert(
        &self,
        lookup: String,
        count: usize,
        sender: oneshot::Sender<DateReply>,
        limit: usize,
    ) -> Result<(), ErrorRecord> {
        let mut state = self.0.lock().expect("API local date lock");
        if state.closed {
            return Err(closed());
        }
        if state.entries.len() >= limit {
            return Err(resource("too many pending local date conversions"));
        }
        state.entries.insert(lookup, PendingEntry { count, sender });
        Ok(())
    }

    fn resolve(&self, lookup: &str, milliseconds: DateReply) -> Result<(), ErrorRecord> {
        let mut state = self.0.lock().expect("API local date lock");
        let Some(entry) = state.entries.get(lookup) else {
            return Ok(());
        };
        if entry.count != milliseconds.len() {
            return Err(protocol("local date reply count changed"));
        }
        let entry = state
            .entries
            .remove(lookup)
            .expect("existing local date entry");
        let _ = entry.sender.send(milliseconds);
        Ok(())
    }
}

// Original context and allocation credits survive every queued frame and pending reply.
#[derive(Debug)]
struct DateCustody {
    _context: Arc<RequestContext>,
    _reservation: PairedReservation,
}
struct PendingGuard {
    context: Arc<RequestContext>,
    lookup: String,
    _custody: Arc<DateCustody>,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.context
            .local_dates
            .0
            .lock()
            .expect("API local date lock")
            .entries
            .remove(&self.lookup);
    }
}

#[derive(Serialize)]
struct DateEvent<'value> {
    kind: &'static str,
    target: &'value str,
    event: &'static str,
    parameters: DateParameters<'value>,
}
#[derive(Serialize)]
struct DateParameters<'value> {
    lookup: &'value str,
    dates: &'value [[i32; 7]],
}

impl Engine {
    /// Called synchronously by the reader, outside the bounded operation queue.
    pub fn resolve_api_dates(
        &self,
        context: &str,
        lookup: &str,
        milliseconds: DateReply,
    ) -> Result<(), ErrorRecord> {
        if !valid_identifier(context)
            || !valid_identifier(lookup)
            || milliseconds.len() > MAXIMUM_DATES
            || milliseconds.iter().flatten().any(|value| {
                !value.is_finite() || value.fract() != 0.0 || value.abs() > 8_640_000_000_000_000.0
            })
        {
            return Err(protocol("invalid local date reply"));
        }
        // Cancellation/disposal may overtake a valid conversion reply.
        if let Ok(context) = self.api_requests.context(context, METHOD) {
            context.local_dates.resolve(lookup, milliseconds)?;
        }
        Ok(())
    }

    pub(super) async fn apply_api_cookies(
        &self,
        context: &Arc<RequestContext>,
        headers: &[Header],
        url: CookieUrl<'_>,
        operation: &Operation,
    ) -> Result<(), ErrorRecord> {
        let now = super::unix_milliseconds();
        let mut count = 0usize;
        visit(headers, now, &mut |value| {
            if matches!(cookie_date::classify(value), DateValue::Local(_)) {
                count += 1;
            }
            None
        });
        if count > MAXIMUM_DATES {
            return Err(resource("response exceeds 1024 local cookie expiry values"));
        }
        if count == 0 {
            return apply(context, headers, url, now, &[]);
        }
        // Covers both date vectors, reply slots, map entry/identifier, and encoded-frame
        // growth (old and new buffers coexist). No strings or JSON trees are cloned.
        let custody = Arc::new(DateCustody {
            _context: context.clone(),
            _reservation: context
                .budget
                .metadata
                .reserve(count * 512 + 8192, METHOD)?,
        });
        let mut dates = Vec::with_capacity(count);
        visit(headers, now, &mut |value| {
            if let DateValue::Local(date) = cookie_date::classify(value) {
                dates.push(date);
            }
            None
        });
        let lookup = self.identifier("api-date");
        let (sender, receiver) = oneshot::channel();
        context.local_dates.insert(
            lookup.clone(),
            count,
            sender,
            self.maximum_pending_operations,
        )?;
        let _guard = PendingGuard {
            context: context.clone(),
            lookup: lookup.clone(),
            _custody: custody.clone(),
        };
        let mut frame = EncodedFrame::encode(
            &DateEvent {
                kind: "event",
                target: &context.identifier,
                event: "apiRequest.localDates",
                parameters: DateParameters {
                    lookup: &lookup,
                    dates: &dates,
                },
            },
            self.maximum_control_frame_bytes,
        )
        .map_err(|_| resource("local date event exceeds control frame limit"))?;
        // Keep the lexical owner too: dates/reply vectors must drop before their credits.
        frame.retain_reservation(custody.clone());
        self.outgoing
            .send(DriverOutput::Frame(frame))
            .await
            .map_err(|_| closed())?;
        let milliseconds = receiver.await.map_err(|_| closed())?;
        operation.check()?;
        context.check(METHOD)?;
        apply(context, headers, url, now, &milliseconds)
    }
}

fn visit(headers: &[Header], now: f64, visitor: &mut impl FnMut(&str) -> Option<f64>) {
    for field in headers {
        if field.name.eq_ignore_ascii_case("set-cookie") {
            CookieJar::visit_dates(&field.value, now, visitor);
        }
    }
}
fn apply(
    context: &RequestContext,
    headers: &[Header],
    url: CookieUrl<'_>,
    now: f64,
    milliseconds: &[Option<f64>],
) -> Result<(), ErrorRecord> {
    let mut values = milliseconds.iter();
    let mut parse = |value: &str| match cookie_date::classify(value) {
        DateValue::Invalid => None,
        DateValue::Milliseconds(value) => Some(value),
        DateValue::Local(_) => values.next().copied().flatten(),
    };
    let mut cookies = context.cookies.lock().expect("API cookies lock");
    for field in headers {
        if field.name.eq_ignore_ascii_case("set-cookie") {
            cookies.apply_set_cookie(&field.value, url, now, &mut parse, METHOD)?;
        }
    }
    Ok(())
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.is_ascii()
}
fn closed() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::TargetClosed,
        METHOD,
        "local date conversion owner is closed",
    )
}
fn resource(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, METHOD, message)
}
fn protocol(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, METHOD, message)
}

#[cfg(test)]
mod tests {
    use super::super::options::ContextOptions;
    use super::*;
    use flashwright_protocol::{FrameWriter, ResourceLimits};
    use serde_json::json;
    use tokio::sync::{mpsc, watch};
    use tokio::time::{Duration, Instant, timeout};

    fn setup() -> (
        Arc<Engine>,
        Arc<RequestContext>,
        mpsc::Receiver<DriverOutput>,
    ) {
        let (outgoing, receiver) = mpsc::channel(1);
        let (fatal, _) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        let context = engine
            .api_requests
            .create(
                "original-context".into(),
                ContextOptions::parse(json!({})).unwrap(),
            )
            .unwrap();
        engine
            .api_requests
            .prepare_publication(
                "apiRequest.newContext",
                &json!({"identifier": context.identifier}),
                |_, _| Ok(()),
            )
            .unwrap();
        (engine, context, receiver)
    }
    fn begin(
        engine: Arc<Engine>,
        context: Arc<RequestContext>,
        deadline: Option<Instant>,
    ) -> (
        watch::Sender<bool>,
        tokio::task::JoinHandle<Result<(), ErrorRecord>>,
    ) {
        let (sender, cancellation) = watch::channel(false);
        let task = tokio::spawn(async move {
            let operation = Operation::new(METHOD.into(), deadline, cancellation);
            let headers = [Header {
                name: "set-cookie".into(),
                value: "original=value; Expires=2030-01-02T03:04:05; Path=/".into(),
            }];
            operation
                .wait(context.while_alive(
                    METHOD,
                    engine.apply_api_cookies(
                        &context,
                        &headers,
                        CookieUrl {
                            scheme: "http",
                            hostname: "example.test",
                            pathname: "/",
                        },
                        &operation,
                    ),
                ))
                .await
        });
        (sender, task)
    }
    async fn event(receiver: &mut mpsc::Receiver<DriverOutput>) -> (EncodedFrame, String) {
        let DriverOutput::Frame(frame) = timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap()
        else {
            panic!("encoded date event expected");
        };
        let mut bytes = Vec::new();
        FrameWriter::new(&mut bytes, 8 * 1024 * 1024)
            .write_frame(&frame)
            .await
            .unwrap();
        let message: serde_json::Value = serde_json::from_slice(&bytes[4..]).unwrap();
        assert_eq!(message["event"], "apiRequest.localDates");
        (
            frame,
            message["parameters"]["lookup"].as_str().unwrap().to_owned(),
        )
    }

    #[tokio::test]
    async fn stalled_conversion_uses_original_deadline_and_late_reply_cannot_mutate_cookies() {
        let (engine, context, mut receiver) = setup();
        let baseline = context.budget.metadata.retained();
        let (_cancel, task) = begin(
            engine.clone(),
            context.clone(),
            Some(Instant::now() + Duration::from_millis(50)),
        );
        let (frame, lookup) = event(&mut receiver).await;
        assert_eq!(task.await.unwrap().unwrap_err().code, ErrorCode::Timeout);
        assert!(context.local_dates.0.lock().unwrap().entries.is_empty());
        engine
            .resolve_api_dates(
                &context.identifier,
                &lookup,
                vec![Some(1_900_000_000_000.0)],
            )
            .unwrap();
        assert_eq!(context.cookies.lock().unwrap().all_cookies(0.0).count(), 0);
        assert!(
            context.budget.metadata.retained() > baseline,
            "queued frame retains original credits after timeout"
        );
        drop(frame);
        assert_eq!(context.budget.metadata.retained(), baseline);
    }

    #[tokio::test]
    async fn cancellation_and_context_disposal_withdraw_pending_conversion() {
        for dispose in [false, true] {
            let (engine, context, mut receiver) = setup();
            let baseline = context.budget.metadata.retained();
            let (cancel, task) = begin(engine.clone(), context.clone(), None);
            let (frame, lookup) = event(&mut receiver).await;
            if dispose {
                engine.api_requests.dispose_context(&context.identifier);
            } else {
                cancel.send_replace(true);
            }
            assert!(
                timeout(Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            assert!(context.local_dates.0.lock().unwrap().entries.is_empty());
            engine
                .resolve_api_dates(&context.identifier, &lookup, vec![None])
                .unwrap();
            assert!(context.budget.metadata.retained() > baseline);
            drop(frame);
            assert_eq!(context.budget.metadata.retained(), baseline);
        }
    }

    #[tokio::test]
    async fn blocked_output_cancellation_releases_unsent_frame_and_pending_entry() {
        let (engine, context, mut receiver) = setup();
        engine
            .outgoing
            .send(DriverOutput::Frame(
                EncodedFrame::encode(&json!({"held":true}), 1024).unwrap(),
            ))
            .await
            .unwrap();
        let baseline = context.budget.metadata.retained();
        let (cancel, task) = begin(engine.clone(), context.clone(), None);
        timeout(Duration::from_secs(2), async {
            while context.local_dates.0.lock().unwrap().entries.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        cancel.send_replace(true);
        assert!(task.await.unwrap().is_err());
        assert!(context.local_dates.0.lock().unwrap().entries.is_empty());
        assert_eq!(context.budget.metadata.retained(), baseline);
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn malformed_reply_preserves_waiter_and_valid_reply_settles_exact_original_request() {
        let (engine, context, mut receiver) = setup();
        let (_cancel, task) = begin(engine.clone(), context.clone(), None);
        let (frame, lookup) = event(&mut receiver).await;
        for values in [
            vec![],
            vec![Some(f64::NAN)],
            vec![Some(1.5)],
            vec![Some(8_640_000_000_000_001.0)],
        ] {
            assert_eq!(
                engine
                    .resolve_api_dates(&context.identifier, &lookup, values)
                    .unwrap_err()
                    .code,
                ErrorCode::Protocol
            );
        }
        assert_eq!(context.local_dates.0.lock().unwrap().entries.len(), 1);
        engine
            .resolve_api_dates(
                &context.identifier,
                &lookup,
                vec![Some(1_900_000_000_000.0)],
            )
            .unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(
            context
                .cookies
                .lock()
                .unwrap()
                .all_cookies(0.0)
                .next()
                .unwrap()
                .expires,
            Some(1_900_000_000.0)
        );
        drop(frame);
    }
}
