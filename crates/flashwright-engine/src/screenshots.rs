//! Page-scoped captures retain document preparation until restoration is confirmed.

use super::*;
use crate::locators::{check_exception, context_was_destroyed};
use crate::page_state::{ExecutionContext, ExecutionContextDestruction};
use crate::renderer_sessions::RendererSession;
use flashwright_browser::connection::Command;
use flashwright_protocol::BinaryPayload;

const METHOD: &str = "page.screenshot";
const PREPARATION: &str =
    include_str!("../../../packages/resident-runtime/screenshot-preparation.js");
const RUNTIME: &str = include_str!("../../../packages/resident-runtime/screenshot-runtime.js");
const CLEANUP_BUDGET: Duration = Duration::from_millis(500);
const MAXIMUM_DIMENSION: f64 = 32767.0;
const MAXIMUM_PIXELS: f64 = 16777216.0;

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Format {
    #[default]
    Png,
    Jpeg,
}
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Caret {
    #[default]
    Hide,
    Initial,
}
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Animations {
    #[default]
    Allow,
    Disabled,
}
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Scale {
    #[default]
    Device,
    Css,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rectangle {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScreenshotOptions {
    page: String,
    #[serde(rename = "type", default)]
    format: Format,
    quality: Option<u8>,
    #[serde(default)]
    full_page: bool,
    clip: Option<Rectangle>,
    #[serde(default)]
    caret: Caret,
    #[serde(default)]
    animations: Animations,
    #[serde(default)]
    style_units: Vec<u16>,
    #[serde(default)]
    omit_background: bool,
    #[serde(default)]
    scale: Scale,
}

impl ScreenshotOptions {
    fn validate(&self) -> Result<(), ErrorRecord> {
        if let Some(quality) = self.quality
            && (self.format != Format::Jpeg || quality > 100)
        {
            return Err(invalid(
                METHOD,
                "quality requires JPEG and must be an integer from 0 to 100",
            ));
        }
        if let Some(clip) = self.clip
            && (![
                clip.x,
                clip.y,
                clip.width,
                clip.height,
                clip.x + clip.width,
                clip.y + clip.height,
            ]
            .iter()
            .all(|value| value.is_finite())
                || clip.width <= 0.0
                || clip.height <= 0.0)
        {
            return Err(invalid(
                METHOD,
                "clip must contain finite coordinates and positive width and height",
            ));
        }
        if self.style_units.len() > 100000 {
            return Err(resource_error(
                "screenshot style exceeds 100000 UTF-16 units",
            ));
        }
        Ok(())
    }
    fn modifies_documents(&self) -> bool {
        self.caret == Caret::Hide
            || self.animations == Animations::Disabled
            || !self.style_units.is_empty()
    }
}

struct PreparedDocument {
    object_identifier: String,
    world: ScreenshotWorld,
}

#[derive(Clone)]
struct ScreenshotWorld {
    context: ExecutionContext,
    destruction: Arc<ExecutionContextDestruction>,
    renderer: Arc<RendererSession>,
}

struct PendingCommand {
    command: Command,
    _world: Option<ScreenshotWorld>,
}

impl ScreenshotWorld {
    fn destroyed(&self) -> bool {
        *self.destruction.destroyed.borrow() || *self.renderer.destruction().borrow()
    }
}

struct Capture<'owner> {
    engine: &'owner Engine,
    page: &'owner Page,
    browser: &'owner Chromium,
    options: &'owner ScreenshotOptions,
    operation: &'owner Operation,
    prepared: Vec<PreparedDocument>,
    pending: Vec<PendingCommand>,
    uncertain_preparation: bool,
    background_may_be_changed: bool,
}

impl Engine {
    /// Serialize page preparation while retaining independent deadline and attachment ownership.
    pub(crate) async fn screenshot(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<BinaryAttachment, ErrorRecord> {
        validate_keys(
            METHOD,
            &parameters,
            &[
                "page",
                "type",
                "quality",
                "fullPage",
                "clip",
                "caret",
                "animations",
                "styleUnits",
                "omitBackground",
                "scale",
            ],
        )?;
        let options: ScreenshotOptions = parse(METHOD, parameters)?;
        options.validate()?;
        let page = self.page(&options.page, METHOD)?;
        let context = self.context(&page.context_identifier, METHOD)?;
        let browser = self.browser(&context.browser_identifier, METHOD)?;
        let _capture_guard = operation
            .wait(
                page.state
                    .while_alive(METHOD, async { Ok(page.state.screenshots.lock().await) }),
            )
            .await?;
        operation
            .wait(
                page.state
                    .while_alive(METHOD, browser.connection.synchronize_events()),
            )
            .await?;
        let (main_frame, frames) = {
            let state = page.state.state.lock().unwrap();
            state.check(METHOD)?;
            let main = state.main_frame.clone().ok_or_else(|| closed(METHOD))?;
            let mut frames: Vec<_> = state
                .frames
                .values()
                .filter(|frame| frame.identifier != main)
                .map(|frame| frame.identifier.clone())
                .collect();
            frames.sort();
            frames.insert(0, main.clone());
            (main, frames)
        };
        let reservation = operation
            .wait(page.state.while_alive(METHOD, async {
                self.attachment_slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| closed(METHOD))
            }))
            .await?;
        let cleanup_admission = operation
            .wait(page.state.while_alive(METHOD, async {
                self.mutation_cleanup_slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| closed(METHOD))
            }))
            .await?;
        let mut capture = Capture {
            engine: self,
            page: &page,
            browser: &browser,
            options: &options,
            operation,
            prepared: Vec::new(),
            pending: Vec::new(),
            uncertain_preparation: false,
            background_may_be_changed: false,
        };
        let result = capture
            .run(
                &main_frame,
                &frames,
                context.viewport.as_ref(),
                context.devices.device_scale_factor,
                self.maximum_attachment_bytes,
            )
            .await;
        let restored = matches!(timeout(CLEANUP_BUDGET, capture.restore()).await, Ok(Ok(())));
        let cleanup = if restored {
            "screenshotRestored"
        } else {
            let removed = self.registry.lock().unwrap().pages.remove(&options.page);
            if let Some(page) = removed {
                self.finish_page(&options.page, &page, closed(METHOD), "close");
            }
            page.state
                .disposal
                .dispose(browser.as_ref(), &page.target_identifier)
                .await
        };
        if !capture.pending.is_empty() {
            let pending = std::mem::take(&mut capture.pending);
            let page = page.clone();
            let browser = browser.clone();
            tokio::spawn(async move {
                let _owners = (page, browser, cleanup_admission);
                for mut pending in pending {
                    let _ = pending.command.response().await;
                }
            });
        }
        let payload = match result {
            Err(mut error) => {
                error.method = METHOD.into();
                error.cleanup = Some(cleanup.into());
                return Err(error);
            }
            Ok(_) if !restored => {
                let mut error = ErrorRecord::new(
                    ErrorCode::Protocol,
                    METHOD,
                    "screenshot restoration could not be confirmed; the affected page was retired",
                );
                error.cleanup = Some(cleanup.into());
                return Err(error);
            }
            Ok(payload) => payload,
        };
        operation.check().map_err(|mut error| {
            error.cleanup = Some(cleanup.into());
            error
        })?;
        Ok(BinaryAttachment::from_payload(payload, reservation))
    }
}

impl Capture<'_> {
    async fn call(&self, method: &str, parameters: Value) -> Result<Value, ErrorRecord> {
        self.operation
            .wait(self.page.state.while_alive(
                METHOD,
                self.browser.connection.call(
                    method,
                    parameters,
                    Some(&self.page.session_identifier),
                ),
            ))
            .await
    }

    async fn select_world(&self, frame: &str) -> Result<ScreenshotWorld, ErrorRecord> {
        let main = self
            .engine
            .evaluation_context(
                self.page,
                self.browser,
                Some(frame),
                self.operation,
                METHOD,
                true,
            )
            .await?;
        let created = self
            .operation
            .wait(self.page.state.while_execution_context(
                &main,
                self.browser.connection.call(
                    "Page.createIsolatedWorld",
                    json!({
                        "frameId": frame, "worldName": "__flashwright_screenshot_world__",
                    }),
                    Some(&main.session_identifier),
                ),
            ))
            .await?;
        let identifier = created["executionContextId"]
            .as_u64()
            .ok_or_else(|| invalid(METHOD, "Chromium omitted screenshot context identity"))?;
        let mut state = self.page.state.state.lock().unwrap();
        if !state.context_is_alive(&main) {
            return Err(evaluation::context_destroyed());
        }
        let context = state
            .execution_contexts
            .get(&(main.session_identifier.clone(), identifier))
            .filter(|context| {
                context.frame_identifier == frame
                    && context.unique_identifier != main.unique_identifier
            })
            .cloned()
            .ok_or_else(evaluation::context_destroyed)?;
        let renderer = self
            .page
            .state
            .renderer_sessions
            .lock()
            .unwrap()
            .get(&context.session_identifier)
            .filter(|renderer| renderer.is_ready())
            .ok_or_else(evaluation::context_destroyed)?;
        let destruction = state.watch_context_destruction(&context)?;
        Ok(ScreenshotWorld {
            context,
            destruction,
            renderer,
        })
    }

    /// A read-only capture still depends on each participating renderer responding.
    async fn synchronize_world(&self, world: &ScreenshotWorld) -> Result<(), ErrorRecord> {
        let result = self
            .operation
            .wait(self.page.state.while_execution_context(
                &world.context,
                self.browser.connection.call(
                    "Runtime.evaluate",
                    json!({
                        "expression": "void 0", "uniqueContextId": world.context.unique_identifier,
                        "returnByValue": true,
                    }),
                    Some(&world.context.session_identifier),
                ),
            ))
            .await?;
        check_exception(&result, METHOD)
    }

    /// Retain original command and realm ownership when cancellation wins the public wait.
    async fn prepare(&mut self, world: ScreenshotWorld) -> Result<(), ErrorRecord> {
        let settings = json!({ "styleUnits": self.options.style_units, "hideCaret": self.options.caret == Caret::Hide, "disableAnimations": self.options.animations == Animations::Disabled, "deadline": self.operation.renderer_deadline() });
        let expression = format!(
            "(() => {{ {PREPARATION}\n {RUNTIME}\n return createScreenshotCapture({settings}); }})()"
        );
        self.operation.check()?;
        let command = self.browser.connection.start_command(
            "Runtime.evaluate",
            json!({
                "expression": expression, "uniqueContextId": world.context.unique_identifier,
                "returnByValue": false,
            }),
            Some(&world.context.session_identifier),
        )?;
        self.pending.push(PendingCommand {
            command,
            _world: Some(world.clone()),
        });
        let mut replied = false;
        let result = {
            let command = &mut self.pending.last_mut().unwrap().command;
            self.operation
                .wait(
                    self.page
                        .state
                        .while_execution_context(&world.context, async {
                            let result = command.response().await;
                            replied = true;
                            result
                        }),
                )
                .await
        };
        if replied {
            self.pending.pop();
        }
        match result {
            Ok(result) => self.retain_preparation(result, world),
            Err(error) => {
                if replied {
                    self.uncertain_preparation |= !world.destroyed();
                    return Err(error);
                }
                if self.pending.last().unwrap().command.prevent_dispatch() {
                    self.pending.pop();
                } else {
                    match timeout(
                        CLEANUP_BUDGET,
                        self.pending.last_mut().unwrap().command.response(),
                    )
                    .await
                    {
                        Ok(Ok(result)) => {
                            self.pending.pop();
                            if self.retain_preparation(result, world.clone()).is_err() {
                                self.uncertain_preparation |= !world.destroyed();
                            }
                        }
                        Ok(Err(_)) => {
                            self.pending.pop();
                            self.uncertain_preparation |= !world.destroyed();
                        }
                        Err(_) => self.uncertain_preparation |= !world.destroyed(),
                    }
                }
                Err(error)
            }
        }
    }

    fn retain_preparation(
        &mut self,
        result: Value,
        world: ScreenshotWorld,
    ) -> Result<(), ErrorRecord> {
        if let Err(error) = check_exception(&result, METHOD) {
            self.uncertain_preparation |= !world.destroyed();
            return Err(error);
        }
        let Some(identifier) = result["result"]["objectId"].as_str() else {
            self.uncertain_preparation |= !world.destroyed();
            return Err(invalid(
                METHOD,
                "Chromium omitted screenshot restoration identity",
            ));
        };
        self.prepared.push(PreparedDocument {
            object_identifier: identifier.to_owned(),
            world,
        });
        Ok(())
    }

    /// A dropped bounded cleanup future leaves its original command in the capture owner.
    async fn cleanup_call(
        &mut self,
        method: &str,
        parameters: Value,
        world: Option<&ScreenshotWorld>,
    ) -> Result<Value, ErrorRecord> {
        let session = world
            .map(|world| world.context.session_identifier.as_ref())
            .unwrap_or(&self.page.session_identifier);
        let command = self
            .browser
            .connection
            .start_command(method, parameters, Some(session))?;
        self.pending.push(PendingCommand {
            command,
            _world: world.cloned(),
        });
        let result = self.pending.last_mut().unwrap().command.response().await;
        self.pending.pop();
        result
    }

    async fn run(
        &mut self,
        main_frame: &str,
        frames: &[String],
        viewport: Option<&Viewport>,
        configured_device_scale: f64,
        maximum_bytes: usize,
    ) -> Result<BinaryPayload, ErrorRecord> {
        let viewport_size = match viewport {
            Some(viewport) => (f64::from(viewport.width), f64::from(viewport.height)),
            None => self.document_size(main_frame, false).await?,
        };
        let mut worlds = Vec::with_capacity(frames.len());
        // Resolve and admit every original owner before any document mutation.
        for frame in frames {
            match self.select_world(frame).await {
                Ok(world) => worlds.push(world),
                Err(error) if frame != main_frame && context_was_destroyed(&error) => {}
                Err(error) => return Err(error),
            }
        }
        for world in worlds {
            let is_main = world.context.frame_identifier == main_frame;
            let result = if !is_main && !self.options.modifies_documents() {
                self.synchronize_world(&world).await
            } else {
                self.prepare(world).await
            };
            if let Err(error) = result {
                if !is_main && context_was_destroyed(&error) && !self.uncertain_preparation {
                    continue;
                }
                return Err(error);
            }
        }
        let main_document = self
            .prepared
            .first()
            .ok_or_else(|| invalid(METHOD, "main screenshot document was not prepared"))?;
        match self
            .operation
            .wait(self.page.state.while_execution_context(
                &main_document.world.context,
                self.browser.connection.call(
                    "Runtime.callFunctionOn",
                    json!({
                        "objectId": main_document.object_identifier,
                        "functionDeclaration": "function() { return this.waitForFonts(); }",
                        "awaitPromise": true, "returnByValue": true,
                    }),
                    Some(&main_document.world.context.session_identifier),
                ),
            ))
            .await
        {
            Ok(result) => check_exception(&result, METHOD)?,
            // Navigation can finish the old document's font wait without replaying preparation.
            Err(error) if context_was_destroyed(&error) => {}
            Err(error) => return Err(error),
        }
        let dimensions = if self.options.full_page {
            self.document_size(main_frame, true).await?
        } else {
            viewport_size
        };
        let fits_viewport = !self.options.full_page
            || dimensions.0 <= viewport_size.0 && dimensions.1 <= viewport_size.1;
        let mut rectangle = trim_clip(self.options.clip, dimensions)?;
        let metrics = self.call("Page.getLayoutMetrics", json!({})).await?;
        let visual_scale = number(&metrics["visualViewport"], "scale")?;
        if visual_scale <= 0.0 {
            return Err(invalid(METHOD, "invalid browser viewport scale"));
        }
        let mut clip_scale = if self.options.full_page {
            1.0
        } else {
            visual_scale
        };
        if !self.options.full_page {
            rectangle.x += number(&metrics["visualViewport"], "pageX")?;
            rectangle.y += number(&metrics["visualViewport"], "pageY")?;
            rectangle.width = (rectangle.width / visual_scale + 0.001).floor();
            rectangle.height = (rectangle.height / visual_scale + 0.001).floor();
        }
        let device_scale = if viewport.is_some() {
            configured_device_scale
        } else {
            let ratio = number(&metrics["contentSize"], "width")?
                / number(&metrics["cssContentSize"], "width")?;
            if ratio.is_finite() && ratio > 0.0 {
                ratio
            } else {
                1.0
            }
        };
        if self.options.scale == Scale::Css {
            clip_scale /= device_scale;
        }
        validate_pixels(
            rectangle.width * clip_scale * device_scale,
            rectangle.height * clip_scale * device_scale,
        )?;
        if self.options.omit_background && self.options.format == Format::Png {
            self.background_may_be_changed = true;
            self.call(
                "Emulation.setDefaultBackgroundColorOverride",
                json!({ "color": {"r":0,"g":0,"b":0,"a":0} }),
            )
            .await?;
        }
        let mut parameters = json!({ "format": if self.options.format == Format::Jpeg { "jpeg" } else { "png" }, "clip": {"x":rectangle.x,"y":rectangle.y,"width":rectangle.width,"height":rectangle.height,"scale":clip_scale}, "captureBeyondViewport": !fits_viewport });
        if self.options.format == Format::Jpeg {
            parameters["quality"] = json!(self.options.quality.unwrap_or(80));
        }
        self.operation
            .wait(self.page.state.while_alive(
                METHOD,
                self.browser.connection.capture_screenshot(
                    parameters,
                    &self.page.session_identifier,
                    maximum_bytes,
                ),
            ))
            .await
    }

    /// Retry only read-only geometry across document replacement, without replaying preparation.
    async fn document_size(
        &self,
        main_frame: &str,
        full_page: bool,
    ) -> Result<(f64, f64), ErrorRecord> {
        loop {
            let measured = async {
                let created = self.call("Page.createIsolatedWorld", json!({ "frameId": main_frame, "worldName": "__flashwright_screenshot_world__" })).await?;
                let context = created["executionContextId"].as_u64().ok_or_else(|| invalid(METHOD, "Chromium omitted screenshot context identity"))?;
                let expression = format!("(() => {{ {RUNTIME}\n return screenshotDocumentSize({full_page}); }})()");
                let result = self.call("Runtime.evaluate", json!({ "expression": expression, "contextId": context, "returnByValue": true })).await?;
                check_exception(&result, METHOD)?;
                let value = &result["result"]["value"];
                if value.is_null() { Ok(None) }
                else { Ok(Some((number(value, "width")?, number(value, "height")?))) }
            }.await;
            match measured {
                Ok(Some(size)) => return Ok(size),
                Ok(None) => {}
                Err(error) if context_was_destroyed(&error) => {}
                Err(error) => return Err(error),
            }
            self.operation
                .wait(self.page.state.while_alive(METHOD, async {
                    tokio::time::sleep(Duration::from_millis(16)).await;
                    Ok(())
                }))
                .await?;
        }
    }

    /// Cleanup addresses the original renderer and object, even after logical retirement.
    async fn restore(&mut self) -> Result<(), ErrorRecord> {
        let mut restored = !self.uncertain_preparation;
        while let Some(document) = self.prepared.pop() {
            if document.world.destroyed() {
                continue;
            }
            let result = self.cleanup_call("Runtime.callFunctionOn", json!({
                "objectId": document.object_identifier,
                "functionDeclaration": "function() { this.restore(); }", "returnByValue": true,
            }), Some(&document.world)).await;
            restored &= match result {
                Ok(result) => check_exception(&result, METHOD).is_ok(),
                Err(_) => document.world.destroyed(),
            };
            if !document.world.destroyed() {
                let result = self
                    .cleanup_call(
                        "Runtime.releaseObject",
                        json!({
                            "objectId": document.object_identifier,
                        }),
                        Some(&document.world),
                    )
                    .await;
                restored &= result.is_ok() || document.world.destroyed();
            }
        }
        if self.background_may_be_changed {
            restored &= self
                .cleanup_call(
                    "Emulation.setDefaultBackgroundColorOverride",
                    json!({}),
                    None,
                )
                .await
                .is_ok();
        }
        if restored {
            Ok(())
        } else {
            Err(invalid(METHOD, "screenshot restoration failed"))
        }
    }
}

fn number(value: &Value, name: &str) -> Result<f64, ErrorRecord> {
    value[name]
        .as_f64()
        .filter(|number| number.is_finite())
        .ok_or_else(|| {
            invalid(
                METHOD,
                &format!("Chromium omitted finite screenshot {name}"),
            )
        })
}
fn resource_error(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, METHOD, message)
}
fn validate_pixels(width: f64, height: f64) -> Result<(), ErrorRecord> {
    let width = width.ceil();
    let height = height.ceil();
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > MAXIMUM_DIMENSION
        || height > MAXIMUM_DIMENSION
        || width * height > MAXIMUM_PIXELS
    {
        return Err(resource_error(
            "screenshot exceeds the 32767-axis or 16777216-pixel output limit",
        ));
    }
    Ok(())
}
fn trim_clip(clip: Option<Rectangle>, size: (f64, f64)) -> Result<Rectangle, ErrorRecord> {
    if !size.0.is_finite() || !size.1.is_finite() || size.0 <= 0.0 || size.1 <= 0.0 {
        return Err(ErrorRecord::new(
            ErrorCode::Protocol,
            METHOD,
            "Chromium returned invalid screenshot dimensions",
        ));
    }
    let rectangle = match clip {
        None => Rectangle {
            x: 0.0,
            y: 0.0,
            width: size.0,
            height: size.1,
        },
        Some(clip) => {
            let x = clip.x.clamp(0.0, size.0);
            let y = clip.y.clamp(0.0, size.1);
            Rectangle {
                x,
                y,
                width: (clip.x + clip.width).clamp(0.0, size.0) - x,
                height: (clip.y + clip.height).clamp(0.0, size.1) - y,
            }
        }
    };
    if rectangle.width <= 0.0 || rectangle.height <= 0.0 {
        return Err(invalid(
            METHOD,
            "clipped area is empty or outside the resulting image",
        ));
    }
    Ok(rectangle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_bounds_reject_invalid_geometry_before_browser_materialization() {
        for size in [(f64::NAN, 10.0), (-1.0, 10.0), (10.0, 0.0)] {
            assert!(trim_clip(None, size).is_err());
        }
        let clipped = trim_clip(
            Some(Rectangle {
                x: -10.0,
                y: -20.0,
                width: 50.0,
                height: 70.0,
            }),
            (320.0, 240.0),
        )
        .unwrap();
        assert_eq!(
            (clipped.x, clipped.y, clipped.width, clipped.height),
            (0.0, 0.0, 40.0, 50.0)
        );
        assert!(validate_pixels(4096.0, 4096.0).is_ok());
        assert_eq!(
            validate_pixels(4097.0, 4096.0).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        assert!(validate_pixels(32767.0, 1.0).is_ok());
        assert!(validate_pixels(32768.0, 1.0).is_err());
    }
}
