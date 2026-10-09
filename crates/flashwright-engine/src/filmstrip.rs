//! Manual filmstrip capture owns bounded frames separately from public event delivery.

use super::*;
use flashwright_browser::connection::Event;
use serde_json::json;

mod frame_store;
mod page_capture;
pub(crate) use frame_store::FrameBudget;
use frame_store::{FrameMetadata, FrameStore, MAXIMUM_FRAME_BYTES, resource_limit};
pub(crate) use page_capture::PageCapture;

pub(crate) struct Filmstrip {
    context: String,
    generation: String,
    width: u32,
    height: u32,
    budget: Arc<FrameBudget>,
    frames: Mutex<FrameStore>,
    pages: Mutex<HashMap<String, Arc<PageCapture>>>,
    stopping: watch::Sender<bool>,
}

impl Filmstrip {
    fn new(
        context: String,
        generation: String,
        viewport: Option<&Viewport>,
        budget: Arc<FrameBudget>,
    ) -> Arc<Self> {
        let (width, height) = capture_size(viewport);
        Arc::new(Self {
            context,
            generation,
            width,
            height,
            budget,
            frames: Mutex::new(FrameStore::default()),
            pages: Mutex::new(HashMap::new()),
            stopping: watch::channel(false).0,
        })
    }

    fn fail(&self, error: ErrorRecord) {
        self.frames.lock().unwrap().fail(error);
        self.stopping.send_replace(true);
    }

    pub(crate) fn close(&self) {
        self.frames.lock().unwrap().discard();
        self.stopping.send_replace(true);
    }

    pub(crate) fn publish(&self, page: &str) {
        self.frames.lock().unwrap().publish(page);
    }
    pub(crate) fn discard_unpublished(&self, page: &str) {
        self.frames.lock().unwrap().discard_unpublished(page);
    }

    fn enroll(
        self: &Arc<Self>,
        identifier: &str,
        page: &Page,
        browser: &Arc<Chromium>,
    ) -> Result<Option<Arc<PageCapture>>, ErrorRecord> {
        if page.state.purpose != PagePurpose::Public {
            return Ok(None);
        }
        let page_closed = page.state.state.lock().unwrap().failure.is_some();
        if page_closed {
            return Ok(None);
        }
        // Admission shares the seal lock through registration, with no awaited CDP work.
        let frames = self.frames.lock().unwrap();
        if !frames.accepting() {
            return Ok(None);
        }
        if let Some(existing) = self.pages.lock().unwrap().get(identifier).cloned() {
            return Ok(Some(existing));
        }
        if page
            .state
            .filmstrip_capture
            .lock()
            .unwrap()
            .upgrade()
            .is_some_and(|capture| !capture.finished())
        {
            return Err(resource_limit(
                "previous page filmstrip cleanup has not settled",
            ));
        }
        let result = PageCapture::start(
            self,
            identifier.to_owned(),
            page.clone(),
            browser.connection.clone(),
            self.width,
            self.height,
        )
        .map(Some);
        drop(frames);
        result
    }

    async fn seal(&self) {
        self.frames.lock().unwrap().seal();
        self.stopping.send_replace(true);
        let pages: Vec<_> = self.pages.lock().unwrap().values().cloned().collect();
        for page in pages {
            page.wait_finished().await;
        }
    }
}

fn capture_size(viewport: Option<&Viewport>) -> (u32, u32) {
    let (width, height) = viewport
        .map(|size| (size.width, size.height))
        .unwrap_or((800, 600));
    let scale = (800.0 / f64::from(width.max(height))).min(1.0);
    (
        ((f64::from(width) * scale).floor() as u32) & !1,
        ((f64::from(height) * scale).floor() as u32) & !1,
    )
}

impl Page {
    /// The original call's exact context/generation is the only source of input activity.
    pub(crate) fn trace_before_input(&self, operation: &Operation) {
        let Some(trace_call) = operation.trace_call() else {
            return;
        };
        if trace_call.context != self.context_identifier {
            return;
        }
        let capture = self.state.filmstrip_capture.lock().unwrap().upgrade();
        if let Some(capture) = capture {
            capture.activity(&trace_call.context, &trace_call.generation);
        }
    }
}

impl Engine {
    fn filmstrip_budget(&self) -> Arc<FrameBudget> {
        self.filmstrip_budget
            .get_or_init(|| Arc::new(FrameBudget::default()))
            .clone()
    }

    fn filmstrip(
        &self,
        parameters: &Value,
        method: &str,
    ) -> Result<(Context, Arc<Filmstrip>), ErrorRecord> {
        let context = self.context(identifier(parameters, "context", method)?, method)?;
        let generation = identifier(parameters, "generation", method)?;
        let capture = context
            .state
            .filmstrip
            .lock()
            .unwrap()
            .clone()
            .filter(|capture| capture.generation == generation)
            .ok_or_else(|| invalid(method, "filmstrip generation is not active"))?;
        Ok((context, capture))
    }

    /// Metadata pulls and activity retain the same acceptance-order fence as diagnostics.
    pub(crate) fn filmstrip_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        operation.check()?;
        if method == "context.trace.filmstrip.clock" {
            validate_keys(method, parameters, &["context"])?;
            let context = self.context(identifier(parameters, "context", method)?, method)?;
            if !context.published {
                return Err(invalid(method, "tracing requires a published context"));
            }
            return Ok(json!({"monotonicTime":self.filmstrip_budget().now()}));
        }
        if method == "context.trace.filmstrip.activity" {
            validate_keys(method, parameters, &["context", "generation", "page"])?;
            let context = identifier(parameters, "context", method)?;
            let generation = identifier(parameters, "generation", method)?;
            let page_identifier = identifier(parameters, "page", method)?;
            if let Ok(page) = self.page(page_identifier, method)
                && page.context_identifier == context
            {
                let capture = page.state.filmstrip_capture.lock().unwrap().upgrade();
                if let Some(capture) = capture {
                    capture.activity(context, generation);
                }
            }
            return Ok(Value::Null);
        }
        validate_keys(method, parameters, &["context", "generation"])?;
        let (_, capture) = self.filmstrip(parameters, method)?;
        let maximum = (self.maximum_control_frame_bytes.saturating_sub(512) / 512).clamp(1, 128);
        let frames = capture.frames.lock().unwrap().claim(maximum)?;
        Ok(json!({"generation":capture.generation,"frames":frames}))
    }

    pub(crate) async fn start_filmstrip(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "context.trace.filmstrip.start";
        validate_keys(method, &parameters, &["context", "generation"])?;
        let context_identifier = identifier(&parameters, "context", method)?;
        let generation = identifier(&parameters, "generation", method)?;
        if generation.len() > 64 {
            return Err(invalid(method, "generation exceeds 64 bytes"));
        }
        let context = self.context(context_identifier, method)?;
        if !context.published {
            return Err(invalid(method, "tracing requires a published context"));
        }
        let _initialization = operation
            .wait(context.state.while_alive(method, async {
                Ok(context.state.page_configuration.write().await)
            }))
            .await?;
        if context.state.filmstrip.lock().unwrap().is_some() {
            return Err(invalid(
                method,
                "filmstrip recording or cleanup is already active",
            ));
        }
        let budget = self.filmstrip_budget();
        let browser = self.browser(&context.browser_identifier, method)?;
        let pages: Vec<_> = self
            .registry
            .lock()
            .unwrap()
            .pages
            .iter()
            .filter(|(_, page)| {
                page.context_identifier == context_identifier
                    && page.state.purpose == PagePurpose::Public
            })
            .map(|(identifier, page)| (identifier.clone(), page.clone()))
            .collect();
        if pages.len() > budget.pages.available_permits() {
            return Err(resource_limit(
                "engine filmstrip exceeds 128 page capture owners",
            ));
        }
        let capture = Filmstrip::new(
            context_identifier.into(),
            generation.into(),
            context.viewport.as_ref(),
            budget,
        );
        {
            let mut current = context.state.filmstrip.lock().unwrap();
            if context.state.filmstrip_closed.load(Ordering::Acquire) {
                return Err(closed(method));
            }
            *current = Some(capture.clone());
        }
        let starting = async {
            let mut enrolled = Vec::new();
            for (identifier, page) in pages {
                if let Some(page) = capture.enroll(&identifier, &page, &browser)? {
                    enrolled.push(page);
                }
            }
            for page in enrolled {
                page.wait_started().await?;
            }
            if let Some(error) = capture.frames.lock().unwrap().failure() {
                return Err(error);
            }
            Ok(Value::Null)
        };
        let result = operation
            .wait(context.state.while_alive(method, starting))
            .await;
        if let Err(error) = &result {
            capture.fail(error.clone());
        }
        result
    }

    /// Future pages acquire their cast before publication without waiting on diagnostic replies.
    pub(crate) fn initialize_page_filmstrip(
        &self,
        identifier: &str,
        page: &Page,
        context: &Context,
        browser: &Arc<Chromium>,
    ) {
        let capture = context.state.filmstrip.lock().unwrap().clone();
        if let Some(capture) = capture
            && let Err(error) = capture.enroll(identifier, page, browser)
        {
            capture.fail(error);
        }
    }

    pub(crate) async fn finish_filmstrip(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        validate_keys(method, &parameters, &["context", "generation"])?;
        let (context, capture) = self.filmstrip(&parameters, method)?;
        if method.ends_with(".dispose") {
            capture.close();
        }
        operation
            .wait(context.state.while_alive(method, async {
                capture.seal().await;
                Ok(())
            }))
            .await?;
        if method.ends_with(".dispose") {
            let mut current = context.state.filmstrip.lock().unwrap();
            if current
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &capture))
            {
                *current = None;
            }
        } else if let Some(error) = capture.frames.lock().unwrap().failure() {
            return Err(error);
        }
        Ok(Value::Null)
    }

    pub(crate) async fn take_filmstrip_frame(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<BinaryAttachment, ErrorRecord> {
        let method = "context.trace.filmstrip.take";
        validate_keys(method, &parameters, &["context", "generation", "token"])?;
        let token = parameters["token"]
            .as_u64()
            .filter(|token| *token > 0 && *token <= 9_007_199_254_740_991)
            .ok_or_else(|| {
                invalid(
                    method,
                    "frame token must be a positive JavaScript-safe integer",
                )
            })?;
        let (context, capture) = self.filmstrip(&parameters, method)?;
        let reservation = operation
            .wait(context.state.while_alive(method, async {
                self.attachment_slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| closed(method))
            }))
            .await?;
        operation.check()?;
        let payload = capture.frames.lock().unwrap().take(token)?;
        if payload.decoded_length > self.maximum_attachment_bytes {
            return Err(resource_limit("frame exceeds negotiated attachment limit"));
        }
        Ok(BinaryAttachment::from_payload(payload, reservation))
    }

    /// A frame error is recording-local and must never reach the fatal browser event outbox.
    pub(crate) fn receive_filmstrip_frame(&self, browser_identifier: &str, event: &Event) {
        let Some(session) = &event.session_identifier else {
            return;
        };
        let page = {
            let registry = self.registry.lock().unwrap();
            registry
                .pages
                .values()
                .find(|page| {
                    page.session_identifier == *session
                        && registry
                            .contexts
                            .get(&page.context_identifier)
                            .is_some_and(|context| context.browser_identifier == browser_identifier)
                })
                .cloned()
        };
        let Some(page) = page else {
            return;
        };
        let capture = page.state.filmstrip_capture.lock().unwrap().upgrade();
        if let Some(capture) = capture {
            // Publication and admission share the document-to-frame lock order.
            let state = page.state.state.lock().unwrap();
            if state.failure.is_none() {
                capture.receive(
                    event
                        .parameters
                        .as_ref()
                        .map_or("null", |parameters| parameters.get()),
                    state.published,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_matches_pinned_maximums_without_assuming_jpeg_dimensions() {
        assert_eq!(capture_size(None), (800, 600));
        assert_eq!(
            capture_size(Some(&Viewport {
                width: 1280,
                height: 720
            })),
            (800, 450)
        );
        assert_eq!(
            capture_size(Some(&Viewport {
                width: 1001,
                height: 701
            })),
            (800, 560)
        );
        assert_eq!(
            capture_size(Some(&Viewport {
                width: 2400,
                height: 1600
            })),
            (800, 532)
        );
        assert_eq!(
            capture_size(Some(&Viewport {
                width: 3,
                height: 3
            })),
            (2, 2)
        );
        assert_eq!(
            capture_size(Some(&Viewport {
                width: 1,
                height: 1
            })),
            (0, 0)
        );
    }
}
