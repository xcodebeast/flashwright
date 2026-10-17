//! Native key chords and sequential typing with owned input delivery and cancellation cleanup.

use super::input::dispatch_input;
use super::locators::{check_exception, context_was_destroyed, retry_reason};
use super::*;
use flashwright_protocol::InputDelivery;
use std::sync::OnceLock;
use tokio::time::sleep;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyDescription {
    key: String,
    code: String,
    text: String,
    key_code_without_location: u32,
    location: u8,
    shifted: Option<Box<KeyDescription>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyboardLayout {
    keys: HashMap<String, KeyDescription>,
    mac_editing_commands: HashMap<String, Value>,
}

fn layout() -> &'static KeyboardLayout {
    static LAYOUT: OnceLock<KeyboardLayout> = OnceLock::new();
    LAYOUT.get_or_init(|| {
        serde_json::from_str(include_str!("keyboard-layout.json"))
            .expect("checked-in keyboard layout must be valid")
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyboardOptions {
    key_units: Vec<u16>,
    delay: Option<f64>,
    #[serde(default)]
    no_wait_after: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TypingOptions {
    text_units: Vec<u16>,
    delay: Option<f64>,
}

enum KeyboardSequence {
    Chord(Vec<String>),
    Text(String),
}

/// Decode the entire sequence before focusing so unsupported text cannot partially mutate a page.
fn typing_text(units: &[u16], method: &str) -> Result<String, ErrorRecord> {
    if units.len() > 100000 {
        return Err(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            method,
            "text exceeds 100000 UTF-16 units",
        ));
    }
    String::from_utf16(units).map_err(|_| {
        ErrorRecord::new(
            ErrorCode::UnsupportedFeature,
            method,
            "native text input containing unpaired UTF-16 surrogates is not implemented",
        )
    })
}

/// Resolve every token before focus or input so a malformed chord cannot leave held modifiers.
fn chord(units: &[u16], method: &str) -> Result<Vec<String>, ErrorRecord> {
    let key = String::from_utf16(units)
        .map_err(|_| invalid(method, "Unknown key: unpaired UTF-16 surrogate"))?;
    let mut names = Vec::new();
    let mut building = String::new();
    for character in key.chars() {
        if character == '+' && !building.is_empty() {
            names.push(std::mem::take(&mut building));
        } else {
            building.push(character);
        }
    }
    names.push(building);
    if names.len() > 128 {
        return Err(ErrorRecord::new(
            ErrorCode::ResourceLimit,
            method,
            "keyboard chord exceeds 128 keys",
        ));
    }
    for name in &mut names {
        if name == "ControlOrMeta" {
            *name = if cfg!(target_os = "macos") {
                "Meta"
            } else {
                "Control"
            }
            .into();
        }
        if !layout().keys.contains_key(name) {
            return Err(invalid(method, &format!("Unknown key: {name:?}")));
        }
    }
    Ok(names)
}

fn modifier_mask(key: &str) -> u8 {
    match key {
        "Alt" => 1,
        "Control" => 2,
        "Meta" => 4,
        "Shift" => 8,
        _ => 0,
    }
}

#[derive(Default)]
struct KeyboardState {
    modifiers: u8,
    held: Vec<KeyDescription>,
}

impl KeyboardState {
    fn description(&self, name: &str) -> KeyDescription {
        let description = &layout().keys[name];
        let mut description = if self.modifiers & 8 != 0 {
            description.shifted.as_deref().unwrap_or(description)
        } else {
            description
        }
        .clone();
        if self.modifiers & !8 != 0 {
            description.text.clear();
        }
        description
    }

    fn commands(&self, code: &str, modifiers: u8) -> Vec<String> {
        if !cfg!(target_os = "macos") {
            return Vec::new();
        }
        let mut parts: Vec<_> = ["Shift", "Control", "Alt", "Meta"]
            .into_iter()
            .filter(|key| modifiers & modifier_mask(key) != 0)
            .collect();
        parts.push(code);
        let commands = &layout()
            .mac_editing_commands
            .get(&parts.join("+"))
            .cloned()
            .unwrap_or(Value::Null);
        let commands = match commands {
            Value::String(command) => vec![command.as_str()],
            Value::Array(commands) => commands.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        commands
            .into_iter()
            .filter(|command| !command.starts_with("insert"))
            .map(|command| command.strip_suffix(':').unwrap_or(command).to_owned())
            .collect()
    }

    fn event(&self, description: &KeyDescription, down: bool, modifiers: u8) -> Value {
        let mut parameters = json!({
            "type": if down { if description.text.is_empty() { "rawKeyDown" } else { "keyDown" } } else { "keyUp" },
            "key": description.key, "code": description.code, "windowsVirtualKeyCode": description.key_code_without_location,
            "location": description.location, "modifiers": modifiers,
        });
        if down {
            parameters["text"] = json!(description.text);
            parameters["unmodifiedText"] = json!(description.text);
            parameters["isKeypad"] = json!(description.location == 3);
            parameters["autoRepeat"] =
                json!(self.held.iter().any(|held| held.code == description.code));
            parameters["commands"] = json!(self.commands(&description.code, modifiers));
        }
        parameters
    }

    async fn key(
        &mut self,
        name: &str,
        down: bool,
        page: &Page,
        browser: &Chromium,
        operation: &Operation,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        let description = self.description(name);
        let modifiers = if down {
            self.modifiers | modifier_mask(&description.key)
        } else {
            self.modifiers & !modifier_mask(&description.key)
        };
        let dispatch = dispatch_input(
            page,
            browser,
            "Input.dispatchKeyEvent",
            self.event(&description, down, modifiers),
            operation,
            method,
        )
        .await;
        if dispatch.delivery != InputDelivery::NotDispatched {
            self.modifiers = modifiers;
            if down && !self.held.iter().any(|held| held.code == description.code) {
                self.held.push(description);
            } else if !down && dispatch.delivery == InputDelivery::Acknowledged {
                self.held.retain(|held| held.code != description.code);
            }
        }
        dispatch.result
    }

    async fn release(&mut self, page: &Page, browser: &Chromium) -> bool {
        let cleanup = async {
            for description in self.held.iter().rev() {
                self.modifiers &= !modifier_mask(&description.key);
                browser
                    .connection
                    .call(
                        "Input.dispatchKeyEvent",
                        self.event(description, false, self.modifiers),
                        Some(&page.session_identifier),
                    )
                    .await?;
            }
            Ok::<(), ErrorRecord>(())
        };
        matches!(
            timeout(Duration::from_millis(500), cleanup).await,
            Ok(Ok(()))
        )
    }
}

async fn press_chord(
    keys: &[String],
    delay: Option<f64>,
    page: &Page,
    browser: &Chromium,
    operation: &Operation,
    method: &str,
) -> Result<(), ErrorRecord> {
    let mut state = KeyboardState::default();
    let result = async {
        for name in keys {
            state
                .key(name, true, page, browser, operation, method)
                .await?;
        }
        if let Some(delay) = delay.filter(|delay| *delay > 0.0) {
            operation
                .wait(page.state.while_alive(method, async {
                    sleep(Duration::from_secs_f64(delay / 1000.0)).await;
                    Ok(())
                }))
                .await?;
        }
        for name in keys.iter().rev() {
            state
                .key(name, false, page, browser, operation, method)
                .await?;
        }
        Ok::<(), ErrorRecord>(())
    }
    .await;
    if let Err(mut error) = result {
        error.cleanup = Some(if state.release(page, browser).await {
            "keyboardReleased".into()
        } else {
            page.state
                .disposal
                .dispose(browser, &page.target_identifier)
                .await
                .into()
        });
        error.method = method.into();
        return Err(error);
    }
    Ok(())
}

fn validate_delay(delay: Option<f64>, method: &str) -> Result<(), ErrorRecord> {
    if delay.is_some_and(|delay| !delay.is_finite() || delay < 0.0 || delay > u32::MAX as f64) {
        return Err(invalid(
            method,
            "delay must be a finite nonnegative number within the supported timer range",
        ));
    }
    Ok(())
}

/// Preserve the pinned code-point loop: key pairs for layout characters, insertion for other text.
async fn type_text(
    text: &str,
    delay: Option<f64>,
    page: &Page,
    browser: &Chromium,
    operation: &Operation,
    method: &str,
) -> Result<(), ErrorRecord> {
    for character in text.chars() {
        operation.check()?;
        let character = character.to_string();
        if layout().keys.contains_key(&character) {
            press_chord(&[character], delay, page, browser, operation, method).await?;
        } else {
            if let Some(delay) = delay.filter(|delay| *delay > 0.0) {
                operation
                    .wait(page.state.while_alive(method, async {
                        sleep(Duration::from_secs_f64(delay / 1000.0)).await;
                        Ok(())
                    }))
                    .await?;
            }
            dispatch_input(
                page,
                browser,
                "Input.insertText",
                json!({ "text": character }),
                operation,
                method,
            )
            .await
            .result?;
        }
    }
    Ok(())
}

impl Engine {
    /// Insert one complete native text payload into the browser's current focus and selection.
    pub(crate) async fn insert_page_text(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "keyboard.insertText";
        validate_keys(method, &parameters, &["page", "textUnits"])?;
        let units: Vec<u16> = parse(method, parameters["textUnits"].clone())?;
        let text = typing_text(&units, method)?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let _input_lock = operation
            .wait(
                page.state
                    .while_alive(method, async { Ok(page.state.native_input.lock().await) }),
            )
            .await?;
        self.capture_snapshot_phase(
            identifier(&parameters, "page", method)?,
            &page,
            recording::SnapshotPhase::Input,
            None,
            operation,
        )
        .await;
        dispatch_input(
            &page,
            &browser,
            "Input.insertText",
            json!({ "text": text }),
            operation,
            method,
        )
        .await
        .result?;
        Ok(Value::Null)
    }

    /// Page typing holds native input ownership for the whole sequence without changing focus.
    pub(crate) async fn type_page_text(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "keyboard.type";
        validate_keys(method, &parameters, &["page", "textUnits", "delay"])?;
        let units: Vec<u16> = parse(method, parameters["textUnits"].clone())?;
        let text = typing_text(&units, method)?;
        let delay: Option<f64> = parse(method, parameters["delay"].clone())?;
        validate_delay(delay, method)?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let _input_lock = operation
            .wait(
                page.state
                    .while_alive(method, async { Ok(page.state.native_input.lock().await) }),
            )
            .await?;
        self.capture_snapshot_phase(
            identifier(&parameters, "page", method)?,
            &page,
            recording::SnapshotPhase::Input,
            None,
            operation,
        )
        .await;
        // Optional capture can outlive cancellation even when there are no keys to dispatch.
        operation.check()?;
        type_text(&text, delay, &page, &browser, operation, method).await?;
        Ok(Value::Null)
    }

    /// Page keyboard input uses the existing focus and has no locator or navigation waiting phase.
    pub(crate) async fn press_page_key(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "keyboard.press";
        validate_keys(method, &parameters, &["page", "keyUnits", "delay"])?;
        let key_units: Vec<u16> = parse(method, parameters["keyUnits"].clone())?;
        if key_units.len() > 100000 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "key exceeds 100000 UTF-16 units",
            ));
        }
        let delay: Option<f64> = parse(method, parameters["delay"].clone())?;
        validate_delay(delay, method)?;
        let keys = chord(&key_units, method)?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let _input_lock = operation
            .wait(
                page.state
                    .while_alive(method, async { Ok(page.state.native_input.lock().await) }),
            )
            .await?;
        self.capture_snapshot_phase(
            identifier(&parameters, "page", method)?,
            &page,
            recording::SnapshotPhase::Input,
            None,
            operation,
        )
        .await;
        press_chord(&keys, delay, &page, &browser, operation, method).await?;
        Ok(Value::Null)
    }

    pub(crate) async fn run_locator_keyboard(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let sequential = parameters["action"] == "pressSequentially";
        let method = if sequential {
            "locator.pressSequentially"
        } else {
            "locator.press"
        };
        if parameters.get("pointer").is_some() {
            return Err(invalid(
                method,
                "pointer settings require a pointer operation",
            ));
        }
        let (sequence, delay, wait_after) = if sequential {
            let options: TypingOptions = parse(method, parameters["keyboard"].clone())?;
            (
                KeyboardSequence::Text(typing_text(&options.text_units, method)?),
                options.delay,
                false,
            )
        } else {
            let options: KeyboardOptions = parse(method, parameters["keyboard"].clone())?;
            (
                KeyboardSequence::Chord(chord(&options.key_units, method)?),
                options.delay,
                !options.no_wait_after,
            )
        };
        validate_delay(delay, method)?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let frame = identifier(&parameters, "frame", method)?;
        let request: Vec<u16> = parse(method, parameters["request"].clone())?;
        if request.len() > 100000 {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "locator request exceeds 100000 UTF-16 units",
            ));
        }
        let mut selector = super::locators::FrameSelector::new(
            identifier(&parameters, "page", method)?,
            frame,
            &request,
            true,
            None,
        );
        let mut attempts = 0;
        loop {
            page.wait_for_input_navigation(0, operation, method).await?;
            let realm = match self
                .resolve_frame_selector(&page, &browser, &mut selector, operation, method)
                .await
            {
                Ok(Some(realm)) => realm,
                Ok(None) => {
                    operation
                        .wait(page.state.while_alive(method, async {
                            sleep(Duration::from_millis(20)).await;
                            Ok(())
                        }))
                        .await?;
                    continue;
                }
                Err(error) if context_was_destroyed(&error) => continue,
                Err(error) => return Err(error),
            };
            let input_lock = operation
                .wait(
                    page.state
                        .while_alive(method, async { Ok(page.state.native_input.lock().await) }),
                )
                .await?;
            let before = page
                .input_sequence_start(&browser, operation, method)
                .await?;
            let preparation = if operation
                .trace_call()
                .is_some_and(|trace| trace.recording.is_some())
            {
                self.traced_locator_action(
                    identifier(&parameters, "page", method)?,
                    &page,
                    &browser,
                    &realm,
                    &selector.request,
                    operation,
                    method,
                )
                .await
            } else {
                operation.check()?;
                page.trace_before_input(operation);
                let command = browser.connection.start_command("Runtime.callFunctionOn", json!({
                    "uniqueContextId": realm.context.unique_identifier,
                    "functionDeclaration": "function(request, deadline) { return globalThis.__flashwrightLocatorRuntime.prepareKeyboard(request, deadline); }",
                    "arguments": [{ "value": selector.request }, { "value": operation.renderer_deadline() }],
                    "returnByValue": true, "awaitPromise": true, "userGesture": true,
                }), Some(&realm.context.session_identifier))?;
                match self
                    .locator_mutation_response(&page, &browser, &realm, operation, command)
                    .await
                {
                    Ok(result) => {
                        check_exception(&result, method)?;
                        Ok(result["result"]["value"].clone())
                    }
                    Err(error) => Err(error),
                }
            };
            let result = match preparation {
                Ok(result) => result,
                Err(error)
                    if context_was_destroyed(&error)
                        && matches!(error.input_delivery, InputDelivery::NotDispatched) =>
                {
                    page.state.locator_realms.lock().await.remove(frame);
                    drop(input_lock);
                    continue;
                }
                Err(mut error) => {
                    error.method = method.into();
                    return Err(error);
                }
            };
            match result["status"].as_str() {
                Some("success") => {
                    match &sequence {
                        KeyboardSequence::Chord(keys) => {
                            press_chord(keys, delay, &page, &browser, operation, method).await?
                        }
                        KeyboardSequence::Text(text) => {
                            type_text(text, delay, &page, &browser, operation, method).await?
                        }
                    }
                    drop(input_lock);
                    if wait_after {
                        page.complete_input(&browser, before, operation, method)
                            .await?;
                    }
                    return Ok(json!({ "kind": "undefined" }));
                }
                Some("error") => {
                    let units: Vec<u16> = parse(method, result["message"]["units"].clone())?;
                    let mut error = ErrorRecord::new(
                        ErrorCode::Evaluation,
                        method,
                        String::from_utf16_lossy(&units),
                    );
                    error.message_utf16 = Some(units.into_boxed_slice());
                    return Err(error);
                }
                Some("expired") => {
                    return Err(ErrorRecord::new(
                        ErrorCode::Timeout,
                        method,
                        "operation deadline exceeded before renderer dispatch",
                    ));
                }
                Some("retry") => {
                    let reason = retry_reason(&result, method)?;
                    drop(input_lock);
                    let delay = [20, 50, 100][attempts.min(2)];
                    attempts += 1;
                    operation
                        .wait(page.state.while_alive(method, async {
                            sleep(Duration::from_millis(delay)).await;
                            Ok(())
                        }))
                        .await
                        .map_err(|mut error| {
                            error.method = method.into();
                            error.message =
                                format!("{}; last observation: {reason}", error.message).into();
                            error
                        })?;
                }
                _ => {
                    return Err(ErrorRecord::new(
                        ErrorCode::Protocol,
                        method,
                        "invalid resident keyboard outcome",
                    ));
                }
            }
        }
    }
}
