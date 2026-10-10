//! Native pointer transactions: fresh readiness, retained hit guards and navigation signals.

use super::handle_allocation::{release_group, wait_for_allocation};
use super::locators::{LocatorRealm, check_exception, context_was_destroyed};
use super::*;
use flashwright_protocol::InputDelivery;
use serde::Serialize;
use tokio::time::sleep;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Button {
    #[default]
    Left,
    Right,
    Middle,
}
impl Button {
    fn mask(self) -> u8 {
        match self {
            Self::Left => 1,
            Self::Right => 2,
            Self::Middle => 4,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
enum Modifier {
    Alt,
    Control,
    ControlOrMeta,
    Meta,
    Shift,
}
impl Modifier {
    fn resolved(self) -> Self {
        if self == Self::ControlOrMeta {
            if cfg!(target_os = "macos") {
                Self::Meta
            } else {
                Self::Control
            }
        } else {
            self
        }
    }
    fn description(self) -> (&'static str, &'static str, u8, u32) {
        match self.resolved() {
            Self::Alt => ("Alt", "AltLeft", 1, 18),
            Self::Control => ("Control", "ControlLeft", 2, 17),
            Self::Meta => ("Meta", "MetaLeft", 4, 91),
            Self::Shift => ("Shift", "ShiftLeft", 8, 16),
            Self::ControlOrMeta => unreachable!(),
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PointerOptions {
    #[serde(default)]
    force: bool,
    #[serde(default)]
    trial: bool,
    #[serde(default)]
    no_wait_after: bool,
    #[serde(default)]
    button: Button,
    position: Option<Point>,
    click_count: Option<u32>,
    delay: Option<f64>,
    modifiers: Option<Vec<Modifier>>,
    checked: Option<bool>,
}

struct PointerAction<'operation> {
    engine: &'operation Engine,
    page_identifier: String,
    page: Page,
    browser: Arc<Chromium>,
    frame: String,
    request: Vec<u16>,
    action: String,
    method: String,
    options: PointerOptions,
    operation: &'operation Operation,
}

struct PointerAttempt<'action, 'operation> {
    action: &'action PointerAction<'operation>,
    request: &'action [u16],
    realm: LocatorRealm,
    token: String,
    delivery: InputDelivery,
    point: Point,
    pressed_button: Option<Button>,
    pressed_modifiers: Vec<Modifier>,
    completed_input: bool,
    objects_released: bool,
}

enum Outcome {
    Complete,
    Ready,
    Retry(String),
}
enum InputEffect {
    None,
    ButtonDown(Button),
    ButtonUp,
    ModifierDown(Modifier),
    ModifierUp(Modifier),
}

impl Engine {
    pub(crate) async fn run_pointer(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let action = identifier(&parameters, "action", "locator.run")?.to_owned();
        let method = format!("locator.{action}");
        let page = self.page(identifier(&parameters, "page", &method)?, &method)?;
        let context = self.context(&page.context_identifier, &method)?;
        let browser = self.browser(&context.browser_identifier, &method)?;
        let options: PointerOptions = parse(&method, parameters["pointer"].clone())?;
        if ["check", "uncheck", "setChecked"].contains(&action.as_str())
            != options.checked.is_some()
        {
            return Err(invalid(
                &method,
                "checked state must be supplied only for checkbox operations",
            ));
        }
        if options
            .position
            .is_some_and(|point| !point.x.is_finite() || !point.y.is_finite())
            || options
                .delay
                .is_some_and(|delay| !delay.is_finite() || delay < 0.0 || delay > u32::MAX as f64)
            || options
                .click_count
                .is_some_and(|count| count == 0 || count > 100)
        {
            return Err(invalid(
                &method,
                "invalid pointer position, delay or click count",
            ));
        }
        let request: Vec<u16> = parse(&method, parameters["request"].clone())?;
        if request.len() > 100000 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "locator request exceeds 100000 UTF-16 units",
            ));
        }
        PointerAction {
            engine: self,
            page_identifier: identifier(&parameters, "page", &method)?.to_owned(),
            page,
            browser,
            frame: identifier(&parameters, "frame", &method)?.to_owned(),
            request,
            action,
            method,
            options,
            operation,
        }
        .run()
        .await?;
        Ok(json!({ "kind": "undefined" }))
    }
}

impl PointerAction<'_> {
    async fn run(&self) -> Result<(), ErrorRecord> {
        let mut selector = super::locators::FrameSelector::new(
            &self.page_identifier,
            &self.frame,
            &self.request,
            true,
            None,
        );
        let mut delivery = InputDelivery::NotDispatched;
        let mut retry_count = 0_usize;
        loop {
            self.operation
                .check()
                .map_err(|error| self.decorate(error, delivery))?;
            if !self.options.force {
                self.page
                    .wait_for_input_navigation(0, self.operation, &self.method)
                    .await
                    .map_err(|error| self.decorate(error, delivery))?;
            }
            let realm = match self
                .engine
                .resolve_frame_selector(
                    &self.page,
                    &self.browser,
                    &mut selector,
                    self.operation,
                    &self.method,
                )
                .await
            {
                Ok(Some(realm)) => realm,
                Ok(None) => {
                    self.pause(retry_count, "frame selector resolved to no frame", delivery)
                        .await?;
                    retry_count += 1;
                    continue;
                }
                Err(error) if context_was_destroyed(&error) => {
                    self.pause(retry_count, "document changed", delivery)
                        .await?;
                    retry_count += 1;
                    continue;
                }
                Err(error) => return Err(self.decorate(error, delivery)),
            };
            // Only a single attempt owns native pointer state. Retry delays and navigation waits
            // release this lock so another action can make a waiting target ready.
            let input_lock = self
                .operation
                .wait(self.page.state.while_alive(&self.method, async {
                    Ok(self.page.state.native_input.lock().await)
                }))
                .await
                .map_err(|error| self.decorate(error, delivery))?;
            let mut attempt = PointerAttempt {
                action: self,
                request: &selector.request,
                realm,
                token: self.engine.identifier("pointer"),
                delivery: InputDelivery::NotDispatched,
                point: Point { x: 0.0, y: 0.0 },
                pressed_button: None,
                pressed_modifiers: Vec::new(),
                completed_input: false,
                objects_released: false,
            };
            let result = attempt.perform(retry_count).await;
            if !matches!(attempt.delivery, InputDelivery::NotDispatched) {
                delivery = attempt.delivery;
            }
            let cleanup = attempt.cleanup().await;
            let cleanup = match cleanup {
                Ok(()) => "residentReleased".to_owned(),
                Err(()) => dispose(
                    self.browser.as_ref(),
                    ResourceKind::Page,
                    &self.page.target_identifier,
                )
                .await
                .to_owned(),
            };
            drop(input_lock);
            if cleanup != "residentReleased" {
                let mut error = result.err().unwrap_or_else(|| {
                    ErrorRecord::new(
                        ErrorCode::TargetClosed,
                        &self.method,
                        "pointer cleanup could not complete; the owned page was closed",
                    )
                });
                error.cleanup = Some(cleanup.into());
                return Err(self.decorate(error, delivery));
            }
            let reason = match result {
                Ok((Outcome::Complete, navigation_start)) => {
                    if let Some(before) = navigation_start {
                        let result = self
                            .page
                            .complete_input(&self.browser, before, self.operation, &self.method)
                            .await;
                        result.map_err(|error| self.decorate(error, delivery))?;
                    }
                    return Ok(());
                }
                Ok((Outcome::Retry(reason), _)) => reason,
                Ok((Outcome::Ready, _)) => {
                    return Err(ErrorRecord::new(
                        ErrorCode::Protocol,
                        &self.method,
                        "pointer attempt ended without completion",
                    ));
                }
                Err(error)
                    if context_was_destroyed(&error)
                        && matches!(attempt.delivery, InputDelivery::NotDispatched) =>
                {
                    self.page
                        .state
                        .locator_realms
                        .lock()
                        .await
                        .remove(&self.frame);
                    "document changed while preparing pointer input".to_owned()
                }
                Err(mut error) => {
                    error.cleanup = Some(cleanup.into());
                    return Err(self.decorate(error, delivery));
                }
            };
            self.pause(retry_count, &reason, delivery).await?;
            retry_count += 1;
        }
    }

    fn decorate(&self, mut error: ErrorRecord, delivery: InputDelivery) -> ErrorRecord {
        error.method = self.method.clone().into();
        if matches!(error.input_delivery, InputDelivery::NotDispatched) {
            error.input_delivery = delivery;
        }
        error
    }

    async fn pause(
        &self,
        retry_count: usize,
        reason: &str,
        delivery: InputDelivery,
    ) -> Result<(), ErrorRecord> {
        self.operation
            .wait(self.page.state.while_alive(&self.method, async {
                sleep(Duration::from_millis(
                    [0, 20, 100, 100, 500][retry_count.min(4)],
                ))
                .await;
                Ok(())
            }))
            .await
            .map_err(|error| {
                let mut error = self.decorate(error, delivery);
                error.message = format!("{}; last observation: {reason}", error.message).into();
                error
            })
    }

    async fn call(&self, method: &str, parameters: Value) -> Result<Value, ErrorRecord> {
        self.operation
            .wait(self.page.state.while_alive(
                &self.method,
                self.browser.connection.call(
                    method,
                    parameters,
                    Some(&self.page.session_identifier),
                ),
            ))
            .await
    }
}

impl PointerAttempt<'_, '_> {
    /// Keep private node aliases and resident preparation owned until their replies settle.
    async fn allocation_call(
        &self,
        realm: &LocatorRealm,
        method: &str,
        parameters: Value,
        executes_user_code: bool,
    ) -> Result<Value, ErrorRecord> {
        let mut command = self.action.browser.connection.start_command(
            method,
            parameters,
            Some(&self.action.page.session_identifier),
        )?;
        match wait_for_allocation(
            &self.action.browser.connection,
            &self.action.page,
            &realm.context,
            self.action.operation,
            &mut command,
            executes_user_code,
        )
        .await
        {
            Ok(value) => Ok(value),
            Err(mut failure) => {
                if failure.reply_pending {
                    failure.error.cleanup = Some(
                        dispose(
                            self.action.browser.as_ref(),
                            ResourceKind::Page,
                            &self.action.page.target_identifier,
                        )
                        .await
                        .into(),
                    );
                }
                Err(failure.error)
            }
        }
    }

    async fn runtime(
        &self,
        realm: &LocatorRealm,
        function: &str,
        arguments: Value,
        return_by_value: bool,
    ) -> Result<Value, ErrorRecord> {
        let result = self.allocation_call(realm, "Runtime.callFunctionOn", json!({
            "uniqueContextId": realm.context.unique_identifier, "functionDeclaration": function, "arguments": arguments,
            "awaitPromise": true, "returnByValue": return_by_value, "objectGroup": self.token, "userGesture": true,
        }), true).await?;
        check_exception(&result, &self.action.method)?;
        Ok(if return_by_value {
            result["result"]["value"].clone()
        } else {
            result["result"].clone()
        })
    }

    async fn perform(&mut self, retry_count: usize) -> Result<(Outcome, Option<u64>), ErrorRecord> {
        let mut settings = json!(self.action.options);
        settings["action"] = json!(self.action.action);
        let prepared = self.runtime(&self.realm, "function(request, deadline, token, settings) { return globalThis.__flashwrightLocatorRuntime.preparePointer(request, deadline, token, settings); }", json!([{ "value": self.request }, { "value": self.action.operation.renderer_deadline() }, { "value": self.token }, { "value": settings }]), true).await?;
        match outcome(prepared, &self.action.method)? {
            Outcome::Ready => {}
            result => return Ok((result, None)),
        }
        let element = self.runtime(&self.realm, "function(token) { return globalThis.__flashwrightLocatorRuntime.pointerElement(token); }", json!([{ "value": self.token }]), false).await?;
        let Some(object) = element["objectId"].as_str() else {
            return Ok((Outcome::Retry("element detached".into()), None));
        };
        let mut scroll = json!({ "objectId": object });
        if let Some(position) = self.action.options.position {
            scroll["rect"] = json!({ "x": position.x, "y": position.y, "width": 0, "height": 0 });
        }
        self.action.page.trace_before_input(self.action.operation);
        if retry_count.is_multiple_of(4) {
            if let Err(error) = self.action.call("DOM.scrollIntoViewIfNeeded", scroll).await {
                if error.message.contains("Node does not have a layout object") {
                    return self.geometry_failure("Element is not visible");
                }
                if error.message.contains("Node is detached from document") {
                    return Ok((Outcome::Retry("element detached".into()), None));
                }
                return Err(error);
            }
        } else {
            let alignment = ["", "end", "center", "start"][retry_count % 4];
            self.runtime(&self.realm, "function(token, alignment) { globalThis.__flashwrightLocatorRuntime.scrollPointer(token, alignment); return true; }", json!([{ "value": self.token }, { "value": alignment }]), true).await?;
        }
        self.action
            .engine
            .capture_snapshot_phase(
                &self.action.page_identifier,
                &self.action.page,
                recording::SnapshotPhase::Input,
                Some(snapshots::SnapshotNode {
                    object_identifier: object.into(),
                    context: self.realm.context.clone(),
                }),
                self.action.operation,
            )
            .await;
        let Some(point) = self.clickable_point(object).await? else {
            return self.geometry_failure(
                "Element is outside of the viewport or has no visible content quad",
            );
        };
        self.point = Point {
            x: (point.x * 100.0).trunc() / 100.0,
            y: (point.y * 100.0).trunc() / 100.0,
        };
        let mut frame_point = Some(self.point);
        if !self.action.options.force {
            let result = self.point_in_frame(self.point).await?;
            match result {
                Ok(point) => frame_point = point,
                Err(reason) => return Ok((Outcome::Retry(reason), None)),
            }
        }
        let armed = self.runtime(&self.realm, "function(token, point) { return globalThis.__flashwrightLocatorRuntime.armPointer(token, point); }", json!([{ "value": self.token }, { "value": frame_point }]), true).await?;
        match outcome(armed, &self.action.method)? {
            Outcome::Ready => {}
            result => return Ok((result, None)),
        }
        self.action
            .call(
                "Runtime.releaseObjectGroup",
                json!({ "objectGroup": self.token }),
            )
            .await?;
        self.objects_released = true;
        let before = self
            .action
            .page
            .input_sequence_start(
                &self.action.browser,
                self.action.operation,
                &self.action.method,
            )
            .await?;
        let modifiers = self.action.options.modifiers.clone().unwrap_or_default();
        for modifier in [
            Modifier::Alt,
            Modifier::Control,
            Modifier::Meta,
            Modifier::Shift,
        ] {
            if modifiers
                .iter()
                .any(|requested| requested.resolved() == modifier)
            {
                self.key(modifier, true).await?;
            }
        }
        if self.action.action == "hover" {
            self.mouse("mouseMoved", None, 0).await?;
        } else {
            let count = if self.action.action == "dblclick" {
                2
            } else {
                self.action.options.click_count.unwrap_or(1)
            };
            if self.action.options.delay.unwrap_or(0.0) == 0.0 {
                self.click_without_delay(count).await?;
            } else {
                self.mouse("mouseMoved", None, 0).await?;
                for click in 1..=count {
                    self.mouse("mousePressed", Some(self.action.options.button), click)
                        .await?;
                    self.delay().await?;
                    self.mouse("mouseReleased", Some(self.action.options.button), click)
                        .await?;
                    if click < count {
                        self.delay().await?;
                    }
                }
            }
        }
        while let Some(modifier) = self.pressed_modifiers.first().copied() {
            self.key(modifier, false).await?;
        }
        self.completed_input = true;
        let mut changes = self.action.page.state.changed.subscribe();
        let navigation_started = async {
            loop {
                if self.navigation_can_stall() {
                    return;
                }
                if changes.changed().await.is_err() {
                    return;
                }
            }
        };
        let finished = tokio::select! {
            biased;
            _ = navigation_started => None,
            result = self.runtime(&self.realm, "function(token) { return globalThis.__flashwrightLocatorRuntime.finishPointer(token); }", json!([{ "value": self.token }]), true) => Some(result),
        };
        let result = match finished {
            None => Outcome::Complete,
            Some(Ok(value)) => outcome(value, &self.action.method)?,
            Some(Err(error)) if context_was_destroyed(&error) => Outcome::Complete,
            Some(Err(error)) => return Err(error),
        };
        let wait_navigation = self.action.action == "click" && !self.action.options.no_wait_after;
        Ok((result, wait_navigation.then_some(before)))
    }

    fn navigation_can_stall(&self) -> bool {
        let state = self.action.page.state.state.lock().unwrap();
        let mut identifier = Some(self.action.frame.as_str());
        while let Some(frame) = identifier.and_then(|identifier| state.frames.get(identifier)) {
            if frame.pending_navigation.is_some() {
                return true;
            }
            identifier = frame.parent.as_deref();
        }
        false
    }

    async fn delay(&self) -> Result<(), ErrorRecord> {
        let delay = self.action.options.delay.unwrap_or(0.0);
        if delay > 0.0 {
            self.action
                .operation
                .wait(async {
                    sleep(Duration::from_secs_f64(delay / 1000.0)).await;
                    Ok(())
                })
                .await?;
        }
        Ok(())
    }

    fn geometry_failure(&self, reason: &str) -> Result<(Outcome, Option<u64>), ErrorRecord> {
        if self.action.options.force {
            Err(ErrorRecord::new(
                ErrorCode::Evaluation,
                &self.action.method,
                reason,
            ))
        } else {
            Ok((Outcome::Retry(reason.into()), None))
        }
    }

    async fn clickable_point(&self, object: &str) -> Result<Option<Point>, ErrorRecord> {
        if let Some(position) = self.action.options.position {
            let model = self
                .action
                .call("DOM.getBoxModel", json!({ "objectId": object }))
                .await?;
            let border = self.runtime(&self.realm, "function(token) { return globalThis.__flashwrightLocatorRuntime.border(token); }", json!([{ "value": self.token }]), true).await?;
            let Some(quad) = quad(&model["model"]["border"]) else {
                return Ok(None);
            };
            let Some(left) = border["left"].as_f64() else {
                return Ok(None);
            };
            let Some(top) = border["top"].as_f64() else {
                return Ok(None);
            };
            return Ok(Some(Point {
                x: quad
                    .iter()
                    .map(|point| point.x)
                    .fold(f64::INFINITY, f64::min)
                    + left
                    + position.x,
                y: quad
                    .iter()
                    .map(|point| point.y)
                    .fold(f64::INFINITY, f64::min)
                    + top
                    + position.y,
            }));
        }
        let quads = self
            .action
            .call("DOM.getContentQuads", json!({ "objectId": object }))
            .await?;
        let main_frame = self
            .action
            .page
            .state
            .state
            .lock()
            .unwrap()
            .main_frame
            .clone()
            .ok_or_else(|| closed(&self.action.method))?;
        let main_realm = self
            .action
            .engine
            .locator_realm(
                &self.action.page,
                &self.action.browser,
                &main_frame,
                self.action.operation,
                &self.action.method,
            )
            .await?;
        let viewport = self
            .runtime(
                &main_realm,
                "function() { return globalThis.__flashwrightLocatorRuntime.viewport(); }",
                json!([]),
                true,
            )
            .await?;
        let width = viewport["width"]
            .as_f64()
            .ok_or_else(|| invalid(&self.action.method, "missing viewport width"))?;
        let height = viewport["height"]
            .as_f64()
            .ok_or_else(|| invalid(&self.action.method, "missing viewport height"))?;
        for value in quads["quads"].as_array().into_iter().flatten() {
            let Some(mut points) = quad(value) else {
                continue;
            };
            for point in &mut points {
                point.x = point.x.clamp(0.0, width);
                point.y = point.y.clamp(0.0, height);
            }
            let area = (0..4)
                .map(|index| {
                    let next = points[(index + 1) % 4];
                    (points[index].x * next.y - next.x * points[index].y) / 2.0
                })
                .sum::<f64>()
                .abs();
            if area > 0.99 {
                return Ok(Some(Point {
                    x: points.iter().map(|point| point.x).sum::<f64>() / 4.0,
                    y: points.iter().map(|point| point.y).sum::<f64>() / 4.0,
                }));
            }
        }
        Ok(None)
    }

    async fn point_in_frame(
        &self,
        root_point: Point,
    ) -> Result<Result<Option<Point>, String>, ErrorRecord> {
        let mut ancestors = Vec::new();
        {
            let state = self.action.page.state.state.lock().unwrap();
            let mut child = self.realm.context.frame_identifier.clone();
            while let Some(parent) = state
                .frames
                .get(&child)
                .and_then(|frame| frame.parent.clone())
            {
                ancestors.push((child, parent.clone()));
                child = parent;
            }
        }
        let mut point = root_point;
        for (child, parent) in ancestors.into_iter().rev() {
            let realm = self
                .action
                .engine
                .locator_realm(
                    &self.action.page,
                    &self.action.browser,
                    &parent,
                    self.action.operation,
                    &self.action.method,
                )
                .await?;
            let owner = self
                .action
                .call("DOM.getFrameOwner", json!({ "frameId": child }))
                .await?;
            let element = self.allocation_call(&realm, "DOM.resolveNode", json!({ "backendNodeId": owner["backendNodeId"], "executionContextId": realm.context.identifier, "objectGroup": self.token }), false).await?;
            let object = string_field(&element["object"], "objectId")?;
            let result = self.runtime(&realm, "function(element, point) { return globalThis.__flashwrightLocatorRuntime.framePoint(element, point); }", json!([{ "objectId": object }, { "value": point }]), true).await?;
            if result["status"] == "transformed" {
                return Ok(Ok(None));
            }
            if result["status"] != "ready" {
                return Ok(Err(result["reason"]
                    .as_str()
                    .unwrap_or("iframe does not receive input")
                    .into()));
            }
            point = parse(&self.action.method, result["point"].clone())?;
        }
        Ok(Ok(Some(point)))
    }

    fn modifiers_mask(&self) -> u8 {
        self.pressed_modifiers
            .iter()
            .fold(0, |mask, modifier| mask | modifier.description().2)
    }

    fn mouse_parameters(&self, event: &str, button: Option<Button>, click_count: u32) -> Value {
        let buttons = if event == "mousePressed" {
            button.map_or(0, Button::mask)
        } else {
            0
        };
        let mut parameters = json!({ "type": event, "x": self.point.x, "y": self.point.y, "button": button.map(|button| json!(button)).unwrap_or(json!("none")), "buttons": buttons, "modifiers": self.modifiers_mask() });
        if event != "mouseMoved" {
            parameters["clickCount"] = json!(click_count);
        }
        if event != "mouseReleased" {
            parameters["force"] = json!(if buttons > 0 { 0.5 } else { 0.0 });
        }
        parameters
    }

    /// Chromium receives move, press and release in order, without an acknowledgement
    /// barrier between them. Explicit delays use the sequential path instead.
    async fn click_without_delay(&mut self, count: u32) -> Result<(), ErrorRecord> {
        let button = Some(self.action.options.button);
        let mut parameters = vec![self.mouse_parameters("mouseMoved", None, 0)];
        let mut effects = vec![InputEffect::None];
        for click in 1..=count {
            parameters.push(self.mouse_parameters("mousePressed", button, click));
            effects.push(InputEffect::ButtonDown(self.action.options.button));
            parameters.push(self.mouse_parameters("mouseReleased", button, click));
            effects.push(InputEffect::ButtonUp);
        }
        let dispatch = super::input::dispatch_input_sequence(
            &self.action.page,
            &self.action.browser,
            "Input.dispatchMouseEvent",
            parameters,
            self.action.operation,
            &self.action.method,
        )
        .await;
        for (delivery, effect) in dispatch.deliveries.into_iter().zip(effects) {
            self.record_delivery(delivery, effect);
        }
        dispatch.result
    }

    async fn mouse(
        &mut self,
        event: &str,
        button: Option<Button>,
        click_count: u32,
    ) -> Result<(), ErrorRecord> {
        let parameters = self.mouse_parameters(event, button, click_count);
        let effect = match event {
            "mousePressed" => InputEffect::ButtonDown(button.unwrap()),
            "mouseReleased" => InputEffect::ButtonUp,
            _ => InputEffect::None,
        };
        self.input("Input.dispatchMouseEvent", parameters, effect)
            .await
    }

    async fn key(&mut self, modifier: Modifier, down: bool) -> Result<(), ErrorRecord> {
        let (key, code, mask, virtual_key) = modifier.description();
        let modifiers = if down {
            self.modifiers_mask() | mask
        } else {
            self.modifiers_mask() & !mask
        };
        self.input("Input.dispatchKeyEvent", json!({ "type": if down { "rawKeyDown" } else { "keyUp" }, "key": key, "code": code, "windowsVirtualKeyCode": virtual_key, "location": 1, "modifiers": modifiers }), if down { InputEffect::ModifierDown(modifier) } else { InputEffect::ModifierUp(modifier) }).await
    }

    async fn input(
        &mut self,
        method: &str,
        parameters: Value,
        effect: InputEffect,
    ) -> Result<(), ErrorRecord> {
        let dispatch = super::input::dispatch_input(
            &self.action.page,
            &self.action.browser,
            method,
            parameters,
            self.action.operation,
            &self.action.method,
        )
        .await;
        self.record_delivery(dispatch.delivery, effect);
        dispatch.result.map_err(|mut error| {
            error.input_delivery = error.input_delivery.max(self.delivery);
            error
        })
    }

    fn record_delivery(&mut self, delivery: InputDelivery, effect: InputEffect) {
        let acknowledged = delivery == InputDelivery::Acknowledged;
        if delivery != InputDelivery::NotDispatched {
            self.delivery = self.delivery.max(delivery);
            match effect {
                InputEffect::ButtonDown(button) => self.pressed_button = Some(button),
                InputEffect::ModifierDown(modifier) => self.pressed_modifiers.push(modifier),
                InputEffect::ButtonUp if acknowledged => self.pressed_button = None,
                InputEffect::ModifierUp(modifier) if acknowledged => self
                    .pressed_modifiers
                    .retain(|pressed| *pressed != modifier),
                _ => {}
            }
        }
    }

    /// Retained nodes, animation callbacks, hit guards and pressed input share one cleanup budget.
    async fn cleanup(&self) -> Result<(), ()> {
        // An unacknowledged release may already have completed the click. Dispose the
        // owned page rather than send input that could replay an unknown action.
        if self.delivery == InputDelivery::Uncertain {
            return Err(());
        }
        let connection = &self.action.browser.connection;
        let session = Some(self.action.page.session_identifier.as_str());
        let cleanup = async {
            if let Some(button) = self.pressed_button {
                connection.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": self.point.x, "y": self.point.y, "button": button, "buttons": 0, "clickCount": 1, "modifiers": self.modifiers_mask() }), session).await?;
            }
            let mut modifiers = self.modifiers_mask();
            for modifier in self.pressed_modifiers.iter().rev() {
                let (key, code, mask, virtual_key) = modifier.description();
                modifiers &= !mask;
                connection.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": virtual_key, "location": 1, "modifiers": modifiers }), session).await?;
            }
            if !self.completed_input || !self.navigation_can_stall() {
                let cleared = connection.call("Runtime.callFunctionOn", json!({ "uniqueContextId": self.realm.context.unique_identifier, "functionDeclaration": "function(token) { globalThis.__flashwrightLocatorRuntime.cleanupPointer(token); return true; }", "arguments": [{ "value": self.token }], "returnByValue": true }), session).await;
                match cleared {
                    Ok(value) => check_exception(&value, &self.action.method)?,
                    Err(error) if context_was_destroyed(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            if !self.objects_released {
                release_group(connection, &self.action.page, &self.token).await?;
            }
            Ok::<(), ErrorRecord>(())
        };
        if matches!(
            timeout(Duration::from_millis(500), cleanup).await,
            Ok(Ok(()))
        ) || self
            .action
            .page
            .state
            .state
            .lock()
            .unwrap()
            .failure
            .is_some()
        {
            Ok(())
        } else {
            Err(())
        }
    }
}

fn outcome(value: Value, method: &str) -> Result<Outcome, ErrorRecord> {
    match value["status"].as_str() {
        Some("success") => Ok(Outcome::Complete),
        Some("ready") => Ok(Outcome::Ready),
        Some("retry") => Ok(Outcome::Retry(super::locators::retry_reason(
            &value, method,
        )?)),
        Some("expired") => Err(ErrorRecord::new(
            ErrorCode::Timeout,
            method,
            "operation deadline exceeded before renderer dispatch",
        )),
        Some("error") => {
            let units: Vec<u16> = parse(method, value["message"]["units"].clone())?;
            let mut error = ErrorRecord::new(
                ErrorCode::Evaluation,
                method,
                String::from_utf16_lossy(&units),
            );
            error.message_utf16 = Some(units.into_boxed_slice());
            Err(error)
        }
        _ => Err(ErrorRecord::new(
            ErrorCode::Protocol,
            method,
            "invalid pointer runtime outcome",
        )),
    }
}

fn quad(value: &Value) -> Option<[Point; 4]> {
    let values = value.as_array()?;
    if values.len() != 8 {
        return None;
    }
    let mut points = [Point { x: 0.0, y: 0.0 }; 4];
    for (index, point) in points.iter_mut().enumerate() {
        point.x = values[index * 2].as_f64()?;
        point.y = values[index * 2 + 1].as_f64()?;
    }
    Some(points)
}
