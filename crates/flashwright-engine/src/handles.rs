//! Native object references belong to their original execution context and allocation group.

use super::evaluation::evaluation_result;
use super::handle_allocation::{CLEANUP_BUDGET, release_group, wait_for_allocation};
use super::handle_values::{RemoteObject, RemoteProperties};
use super::page_state::ExecutionContext;
use super::*;
use flashwright_browser::connection::Command;
use tokio::sync::OwnedSemaphorePermit;

pub(crate) const MAXIMUM_HANDLES: usize = 4096;

#[derive(Clone)]
pub(crate) struct Handle {
    pub context: ExecutionContext,
    pub object_identifier: Option<String>,
    pub primitive: Option<Value>,
    pub element: bool,
    pub group: String,
    pub uses_object_group: bool,
    pub published: bool,
    pub background_discard: bool,
    _reservation: Arc<OwnedSemaphorePermit>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HandleReference {
    pub page: String,
    pub identifier: String,
}

pub(crate) struct HandleOwner<'owner> {
    pub context: &'owner ExecutionContext,
    pub group: &'owner str,
    pub uses_object_group: bool,
    pub published: bool,
    pub background_discard: bool,
}

pub(crate) struct HandleArguments {
    pub arguments: Vec<Value>,
    pub primitive: Vec<bool>,
    pub retained: Vec<Handle>,
}

pub(crate) struct HandleAllocation<'owner> {
    pub engine: &'owner Engine,
    pub page_identifier: &'owner str,
    pub page: &'owner Page,
    pub browser: &'owner Chromium,
    pub context: ExecutionContext,
    pub operation: &'owner Operation,
    pub method: &'owner str,
    pub group: String,
    pub uses_object_group: bool,
}

impl Engine {
    pub(super) async fn evaluate_handle(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let reservation = self.reserve_handle(&page, method)?;
        let prepared = self
            .prepare_evaluation(method, parameters, operation)
            .await?;
        let allocation = HandleAllocation {
            engine: self,
            page_identifier: &prepared.page_identifier,
            page: &prepared.page,
            browser: &prepared.browser,
            context: prepared.runtime.context.clone(),
            operation,
            method,
            group: self.identifier("handle-group"),
            uses_object_group: true,
        };
        let result = async {
            operation.check()?;
            let mut command = prepared.browser.connection.start_command("Runtime.callFunctionOn", prepared.command_parameters(Some(&allocation.group)), Some(&prepared.page.session_identifier))?;
            let response = allocation.wait(&mut command, true).await?;
            let value = allocation.evaluation_value(&response).await?;
            let handle = allocation.retain(value, reservation)?;
            Ok(json!({ "page": prepared.page_identifier, "group": allocation.group, "handles": [handle] }))
        }.await;
        allocation.finish(result).await
    }

    pub(super) async fn handle_json_value(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "handle.jsonValue";
        validate_keys(method, &parameters, &["page", "handle"])?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let handle =
            self.owned_handle(&page, identifier(&parameters, "handle", method)?, method)?;
        if let Some(value) = handle.primitive {
            return Ok(value);
        }
        self.evaluate(
            "handle.evaluate",
            json!({
                "page": parameters["page"], "handle": parameters["handle"],
                "source": "value => value".encode_utf16().collect::<Vec<_>>(),
                "isFunction": true, "argument": { "kind": "undefined" },
            }),
            operation,
        )
        .await
        .map_err(|mut error| {
            error.method = method.into();
            error
        })
    }

    pub(super) async fn handle_get_property(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "handle.getProperty";
        validate_keys(method, &parameters, &["page", "handle", "name"])?;
        let name: Vec<u16> = parse(method, parameters["name"].clone())?;
        self.evaluate_handle(
            method,
            json!({
                "page": parameters["page"], "handle": parameters["handle"],
                "source": "(value, name) => value[name]".encode_utf16().collect::<Vec<_>>(),
                "isFunction": true, "argument": { "kind": "string", "units": name },
            }),
            operation,
        )
        .await
    }

    pub(super) async fn handle_get_properties(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "handle.getProperties";
        validate_keys(method, &parameters, &["page", "handle"])?;
        let page_identifier = identifier(&parameters, "page", method)?;
        let page = self.page(page_identifier, method)?;
        let handle =
            self.owned_handle(&page, identifier(&parameters, "handle", method)?, method)?;
        if handle.primitive.is_some() {
            return Ok(json!({ "page": page_identifier, "group": null, "handles": [] }));
        }
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let allocation = HandleAllocation {
            engine: self,
            page_identifier,
            page: &page,
            browser: &browser,
            context: handle.context.clone(),
            operation,
            method,
            group: self.identifier("handle-group"),
            uses_object_group: true,
        };
        let result = async {
            // An alias places all newly discovered property objects in a new group.
            // Cancelling this discovery must never release the public parent handle.
            let mut alias = browser.connection.start_command("Runtime.callFunctionOn", json!({
                "objectId": handle.object_identifier, "functionDeclaration": "function() { 'use strict'; return this; }",
                "objectGroup": allocation.group, "returnByValue": false,
            }), Some(&page.session_identifier))?;
            let response = allocation.wait(&mut alias, false).await?;
            if response.get("exceptionDetails").is_some() { evaluation_result(method, &response)?; }
            let object_identifier = response["result"]["objectId"].as_str().ok_or_else(|| ErrorRecord::new(ErrorCode::Protocol, method, "Chromium omitted the property inspection identity"))?;
            let properties = allocation.properties(object_identifier).await?;
            let mut handles = Vec::new();
            for property in properties.result {
                if property.enumerable && let Some(value) = property.value {
                    let reservation = self.reserve_handle(&page, method)?;
                    let mut initialization = allocation.retain(value, reservation)?;
                    initialization["nameUnits"] = json!(property.name.0);
                    handles.push(initialization);
                }
            }
            if handles.is_empty() {
                let cleanup = allocation.rollback().await;
                if cleanup != "handleGroupDisposed" { return Err(ErrorRecord::new(ErrorCode::TargetClosed, method, "property inspection owner closed during cleanup")); }
                return Ok(json!({ "page": page_identifier, "group": null, "handles": [] }));
            }
            let mut release = browser.connection.start_command("Runtime.releaseObject", json!({ "objectId": object_identifier }), Some(&page.session_identifier))?;
            allocation.wait(&mut release, false).await?;
            Ok(json!({ "page": page_identifier, "group": allocation.group, "handles": handles }))
        }.await;
        allocation.finish(result).await
    }

    pub(super) async fn dispose_handle(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "handle.dispose";
        validate_keys(method, &parameters, &["page", "handle"])?;
        let page_identifier = identifier(&parameters, "page", method)?;
        let handle_identifier = identifier(&parameters, "handle", method)?;
        let page = match self.page(page_identifier, method) {
            Ok(page) => page,
            Err(error) if error.code == ErrorCode::TargetClosed => return Ok(Value::Null),
            Err(error) => return Err(error),
        };
        let (handle, last_in_group) = {
            let mut handles = page.state.handles.lock().unwrap();
            let Some(handle) = handles.remove(handle_identifier) else {
                return Ok(Value::Null);
            };
            let last = !handles.values().any(|other| other.group == handle.group);
            (handle, last)
        };
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let allocation = HandleAllocation {
            engine: self,
            page_identifier,
            page: &page,
            browser: &browser,
            context: handle.context.clone(),
            operation,
            method,
            group: handle.group.clone(),
            uses_object_group: handle.uses_object_group,
        };
        if !allocation.context_is_alive() {
            return Ok(Value::Null);
        }
        let (release_method, release_parameters) = if last_in_group && handle.uses_object_group {
            (
                "Runtime.releaseObjectGroup",
                json!({ "objectGroup": handle.group }),
            )
        } else if let Some(identifier) = handle.object_identifier {
            ("Runtime.releaseObject", json!({ "objectId": identifier }))
        } else {
            return Ok(Value::Null);
        };
        let mut command = browser.connection.start_command(
            release_method,
            release_parameters.clone(),
            Some(&page.session_identifier),
        );
        let result = match &mut command {
            Ok(command) => {
                operation
                    .wait(page.state.while_alive(method, command.response()))
                    .await
            }
            Err(error) => Err(error.clone()),
        };
        if let Err(mut error) = result {
            if !allocation.context_is_alive()
                || (release_method == "Runtime.releaseObject" && remote_reference_is_gone(&error))
            {
                return Ok(Value::Null);
            }
            // A cancelled wait leaves its receiver unread; other failures may have
            // consumed it already. Retrying this exact release is idempotent.
            let pending = command.as_mut().ok().filter(|command| {
                matches!(error.code, ErrorCode::Timeout | ErrorCode::Cancelled)
                    && !command.prevent_dispatch()
            });
            let cleanup = if let Some(command) = pending {
                timeout(CLEANUP_BUDGET, command.response()).await
            } else {
                timeout(
                    CLEANUP_BUDGET,
                    browser.connection.call(
                        release_method,
                        release_parameters,
                        Some(&page.session_identifier),
                    ),
                )
                .await
            };
            error.cleanup = Some(
                match cleanup {
                    Ok(Ok(_)) => "handleDisposed",
                    Ok(Err(error))
                        if release_method == "Runtime.releaseObject"
                            && remote_reference_is_gone(&error) =>
                    {
                        "handleDisposed"
                    }
                    _ => allocation.retire_page().await,
                }
                .into(),
            );
            return Err(error);
        }
        Ok(Value::Null)
    }

    pub(super) async fn discard_handle_group(
        self: &Arc<Self>,
        parameters: Value,
    ) -> Result<Value, ErrorRecord> {
        validate_keys("handle.discard", &parameters, &["page", "group"])?;
        identifier(&parameters, "page", "handle.discard")?;
        identifier(&parameters, "group", "handle.discard")?;
        if self.discard_event_handle_group(&parameters)? {
            return Ok(Value::Null);
        }
        self.discard_handle_allocation(&parameters).await;
        Ok(Value::Null)
    }

    pub(crate) async fn discard_handle_allocation(&self, result: &Value) -> Option<&'static str> {
        let group = result["group"].as_str()?;
        let page_identifier = result["page"].as_str()?;
        let Ok(page) = self.page(page_identifier, "handle.discard") else {
            return Some("ownerAlreadyClosing");
        };
        let handle = page
            .state
            .handles
            .lock()
            .unwrap()
            .values()
            .find(|handle| handle.group == group)
            .cloned();
        let Some(handle) = handle else {
            return Some("handleGroupAlreadyDisposed");
        };
        let Some(browser) = self
            .context(&page.context_identifier, "handle.discard")
            .ok()
            .and_then(|context| {
                self.browser(&context.browser_identifier, "handle.discard")
                    .ok()
            })
        else {
            return Some("ownerAlreadyClosing");
        };
        let (_cancellation, receiver) = watch::channel(false);
        let operation = Operation::new("handle.discard".into(), None, receiver);
        let allocation = HandleAllocation {
            engine: self,
            page_identifier,
            page: &page,
            browser: &browser,
            context: handle.context,
            operation: &operation,
            method: "handle.discard",
            group: group.to_owned(),
            uses_object_group: handle.uses_object_group,
        };
        Some(allocation.rollback().await)
    }

    pub(crate) fn prepare_handle_publication<Prepared>(
        &self,
        result: &Value,
        required_main_context: Option<&ExecutionContext>,
        prepare: impl FnOnce(&Value) -> Result<Prepared, ErrorRecord>,
    ) -> Result<Prepared, ErrorRecord> {
        let Some(group) = result["group"].as_str() else {
            return prepare(result);
        };
        let page = self.page(
            result["page"]
                .as_str()
                .expect("handle allocations have a page"),
            "handle.publish",
        )?;
        let state = page.state.state.lock().unwrap();
        state.check("handle.publish")?;
        if let Some(context) = required_main_context
            && (!state.context_is_alive(context)
                || state.main_worlds.get(&context.frame_identifier) != Some(context))
        {
            return Err(evaluation::context_destroyed());
        }
        let mut handles = page.state.handles.lock().unwrap();
        let initializations = result["handles"]
            .as_array()
            .expect("handle allocations have initializations");
        for initialization in initializations {
            let handle = handles
                .get(initialization["identifier"].as_str().unwrap())
                .filter(|handle| handle.group == group)
                .ok_or_else(|| closed("handle.publish"))?;
            if handle.object_identifier.is_some() && !state.context_is_alive(&handle.context) {
                return Err(evaluation::context_destroyed());
            }
        }
        let prepared = prepare(result)?;
        for initialization in initializations {
            handles
                .get_mut(initialization["identifier"].as_str().unwrap())
                .unwrap()
                .published = true;
        }
        Ok(prepared)
    }

    pub(crate) fn owned_handle(
        &self,
        page: &Page,
        identifier: &str,
        method: &str,
    ) -> Result<Handle, ErrorRecord> {
        page.state.state.lock().unwrap().check(method)?;
        page.state
            .handles
            .lock()
            .unwrap()
            .get(identifier)
            .filter(|handle| handle.published)
            .cloned()
            .ok_or_else(|| {
                ErrorRecord::new(
                    ErrorCode::TargetClosed,
                    method,
                    "JSHandle has been disposed or its execution context was destroyed",
                )
            })
    }

    pub(crate) fn handle_arguments(
        &self,
        page_identifier: &str,
        context: &ExecutionContext,
        references: &[HandleReference],
        method: &str,
    ) -> Result<HandleArguments, ErrorRecord> {
        let mut result = HandleArguments {
            arguments: Vec::new(),
            primitive: Vec::new(),
            retained: Vec::new(),
        };
        for reference in references {
            let owner = self.page(&reference.page, method)?;
            let handle = self.owned_handle(&owner, &reference.identifier, method)?;
            if let Some(primitive) = &handle.primitive {
                result.arguments.push(json!({ "value": primitive }));
                result.primitive.push(true);
            } else {
                if reference.page != page_identifier || handle.context != *context {
                    let (code, message) = if handle.element {
                        (
                            ErrorCode::UnsupportedFeature,
                            "ElementHandle adoption across execution contexts is not implemented",
                        )
                    } else {
                        (
                            ErrorCode::Evaluation,
                            "JSHandles can be evaluated only in the context they were created",
                        )
                    };
                    return Err(ErrorRecord::new(code, method, message));
                }
                result
                    .arguments
                    .push(json!({ "objectId": handle.object_identifier }));
                result.primitive.push(false);
            }
            result.retained.push(handle);
        }
        Ok(result)
    }

    pub(crate) fn retain_handle(
        &self,
        page: &Page,
        owner: HandleOwner<'_>,
        value: RemoteObject,
        reservation: OwnedSemaphorePermit,
        method: &str,
    ) -> Result<Value, ErrorRecord> {
        let HandleOwner {
            context,
            group,
            uses_object_group,
            published,
            background_discard,
        } = owner;
        let state = page.state.state.lock().unwrap();
        state.check(method)?;
        if !state.context_is_alive(context) {
            return Err(evaluation::context_destroyed());
        }
        let primitive = value.primitive(method)?;
        let element = value.subtype.as_deref() == Some("node");
        let identifier = self.identifier("handle");
        let preview = if element {
            Some("JSHandle@node".encode_utf16().collect::<Vec<_>>())
        } else {
            value.description.map(|text| text.0)
        };
        let initialization = json!({ "identifier": identifier, "primitive": primitive, "previewUnits": preview, "element": element, "frame": context.frame_identifier });
        page.state.handles.lock().unwrap().insert(
            identifier,
            Handle {
                context: context.clone(),
                object_identifier: value.object_id,
                primitive,
                element,
                group: group.to_owned(),
                published,
                background_discard,
                uses_object_group,
                _reservation: Arc::new(reservation),
            },
        );
        Ok(initialization)
    }

    pub(crate) fn reserve_handle(
        &self,
        page: &Page,
        method: &str,
    ) -> Result<OwnedSemaphorePermit, ErrorRecord> {
        page.state
            .handle_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ErrorRecord::new(
                    ErrorCode::ResourceLimit,
                    method,
                    "page exceeds the limit of 4096 retained or pending handles",
                )
            })
    }
}

impl HandleAllocation<'_> {
    pub(crate) async fn finish(
        &self,
        result: Result<Value, ErrorRecord>,
    ) -> Result<Value, ErrorRecord> {
        let result = match result {
            Ok(value) => self
                .operation
                .wait(self.browser.connection.synchronize_events())
                .await
                .map(|()| value),
            Err(error) => Err(error),
        };
        match result {
            Ok(value) => Ok(value),
            Err(mut error) => {
                let cleanup = self.rollback().await;
                if error.cleanup.is_none() {
                    error.cleanup = Some(cleanup.into());
                }
                Err(error)
            }
        }
    }

    fn context_is_alive(&self) -> bool {
        let state = self.page.state.state.lock().unwrap();
        state.failure.is_none() && state.context_is_alive(&self.context)
    }

    /// Keep every allocating reply owned until it completes or the original page is retired.
    pub async fn wait<Output>(
        &self,
        command: &mut Command<Output>,
        executes_user_code: bool,
    ) -> Result<Output, ErrorRecord> {
        match wait_for_allocation(
            &self.browser.connection,
            self.page,
            &self.context,
            self.operation,
            command,
            executes_user_code,
        )
        .await
        {
            Ok(value) => Ok(value),
            Err(mut failure) => {
                if failure.reply_pending {
                    failure.error.cleanup = Some(self.retire_page().await.into());
                }
                Err(failure.error)
            }
        }
    }

    pub async fn properties(
        &self,
        object_identifier: &str,
    ) -> Result<RemoteProperties, ErrorRecord> {
        self.operation.check()?;
        let mut command = self.browser.connection.start_raw_command(
            "Runtime.getProperties",
            json!({ "objectId": object_identifier, "ownProperties": true }),
            Some(&self.page.session_identifier),
        )?;
        let raw = self.wait(&mut command, false).await?;
        let properties: RemoteProperties = serde_json::from_str(raw.get()).map_err(|error| {
            ErrorRecord::new(ErrorCode::Protocol, self.method, error.to_string())
        })?;
        if properties.exception_details.is_some() {
            return Err(ErrorRecord::new(
                ErrorCode::Evaluation,
                self.method,
                "Chromium could not inspect the handle properties",
            ));
        }
        Ok(properties)
    }

    /// The wrapper owns only engine-created fields; inspecting it never invokes user getters.
    pub async fn evaluation_value(&self, response: &Value) -> Result<RemoteObject, ErrorRecord> {
        if response.get("exceptionDetails").is_some() {
            evaluation_result(self.method, response)?;
        }
        let wrapper = response["result"]["objectId"].as_str().ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::Protocol,
                self.method,
                "Chromium omitted the handle evaluation result identity",
            )
        })?;
        let properties = self.properties(wrapper).await?;
        let mut outcome = None;
        let mut value = None;
        let mut failure = None;
        for property in properties.result {
            match String::from_utf16(&property.name.0).ok().as_deref() {
                Some("outcome") => {
                    outcome = property
                        .value
                        .and_then(|value| value.value)
                        .and_then(|value| serde_json::from_str::<String>(value.get()).ok())
                }
                Some("value") => value = property.value,
                Some("failure") => {
                    failure = property
                        .value
                        .and_then(|value| value.value)
                        .and_then(|value| serde_json::from_str::<String>(value.get()).ok())
                }
                _ => {}
            }
        }
        if outcome.as_deref() == Some("exception") {
            let failure: Value =
                serde_json::from_str(failure.as_deref().ok_or_else(|| {
                    invalid(self.method, "handle evaluation omitted its diagnostic")
                })?)
                .map_err(|error| {
                    ErrorRecord::new(ErrorCode::Protocol, self.method, error.to_string())
                })?;
            evaluation_result(self.method, &json!({ "result": { "value": failure } }))?;
        }
        if outcome.as_deref() != Some("success") {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                self.method,
                "Chromium omitted a valid handle evaluation outcome",
            ));
        }
        // The actual value has its own remote identity in this same private group.
        // Releasing the wrapper cannot dispose the value that will be published.
        let mut release = self.browser.connection.start_command(
            "Runtime.releaseObject",
            json!({ "objectId": wrapper }),
            Some(&self.page.session_identifier),
        )?;
        self.wait(&mut release, false).await?;
        value.ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::Protocol,
                self.method,
                "Chromium omitted the evaluated handle value",
            )
        })
    }

    pub fn retain(
        &self,
        value: RemoteObject,
        reservation: OwnedSemaphorePermit,
    ) -> Result<Value, ErrorRecord> {
        self.retain_with_discard(value, reservation, false)
    }

    /// Unobserved event handles release remotely in the bounded background queue.
    pub fn retain_event(
        &self,
        value: RemoteObject,
        reservation: OwnedSemaphorePermit,
    ) -> Result<Value, ErrorRecord> {
        self.retain_with_discard(value, reservation, true)
    }

    fn retain_with_discard(
        &self,
        value: RemoteObject,
        reservation: OwnedSemaphorePermit,
        background_discard: bool,
    ) -> Result<Value, ErrorRecord> {
        self.operation.check()?;
        self.engine.retain_handle(
            self.page,
            HandleOwner {
                context: &self.context,
                group: &self.group,
                uses_object_group: self.uses_object_group,
                published: false,
                background_discard,
            },
            value,
            reservation,
            self.method,
        )
    }

    pub async fn rollback(&self) -> &'static str {
        let discarded: Vec<_> = self
            .page
            .state
            .handles
            .lock()
            .unwrap()
            .extract_if(|_, handle| handle.group == self.group)
            .map(|(_, handle)| handle)
            .collect();
        if !self.uses_object_group && !self.context_is_alive() {
            return "handleContextDestroyed";
        }
        let cleanup = async {
            if self.uses_object_group {
                release_group(&self.browser.connection, self.page, &self.group).await
            } else {
                release_object_references(
                    self.browser,
                    self.page,
                    &discarded
                        .iter()
                        .filter_map(|handle| handle.object_identifier.clone())
                        .collect::<Vec<_>>(),
                )
                .await
            }
        };
        match timeout(CLEANUP_BUDGET, cleanup).await {
            Ok(Ok(())) => "handleGroupDisposed",
            _ if !self.uses_object_group && !self.context_is_alive() => "handleContextDestroyed",
            _ => self.retire_page().await,
        }
    }

    async fn retire_page(&self) -> &'static str {
        if self
            .engine
            .registry
            .lock()
            .unwrap()
            .pages
            .remove(self.page_identifier)
            .is_some()
        {
            self.engine.finish_page(
                self.page_identifier,
                self.page,
                closed(self.method),
                "close",
            );
        }
        match dispose(
            self.browser,
            ResourceKind::Page,
            &self.page.target_identifier,
        )
        .await
        {
            "resourceDisposed" | "resourceAlreadyDisposed" => {
                "pageClosedAfterUncertainHandleCleanup"
            }
            outcome => outcome,
        }
    }
}

/// Event references retain the exact remote disposal operation without retaining public handles.
pub(crate) enum RemoteReference {
    Object(String),
    Group(String),
}

pub(crate) async fn release_event_references(
    browser: &Chromium,
    page: &Page,
    references: &[RemoteReference],
) -> Result<(), ErrorRecord> {
    let mut commands = Vec::with_capacity(references.len());
    for reference in references {
        let (method, parameters) = match reference {
            RemoteReference::Object(identifier) => {
                ("Runtime.releaseObject", json!({"objectId": identifier}))
            }
            RemoteReference::Group(identifier) => (
                "Runtime.releaseObjectGroup",
                json!({"objectGroup": identifier}),
            ),
        };
        commands.push(browser.connection.start_command(
            method,
            parameters,
            Some(&page.session_identifier),
        )?);
    }
    for command in &mut commands {
        if let Err(error) = command.response().await
            && !remote_reference_is_gone(&error)
        {
            return Err(error);
        }
    }
    Ok(())
}

/// Release only the remote IDs owned by an event; never clear Chromium's shared console group.
pub(crate) async fn release_object_references(
    browser: &Chromium,
    page: &Page,
    identifiers: &[String],
) -> Result<(), ErrorRecord> {
    for chunk in identifiers.chunks(64) {
        let mut commands = browser.connection.start_commands(
            "Runtime.releaseObject",
            chunk
                .iter()
                .map(|identifier| json!({ "objectId": identifier }))
                .collect(),
            Some(&page.session_identifier),
        )?;
        for command in &mut commands {
            if let Err(error) = command.response().await
                && !remote_reference_is_gone(&error)
            {
                return Err(error);
            }
        }
    }
    Ok(())
}

/// Navigation and console.clear can release the original reference before explicit disposal.
fn remote_reference_is_gone(error: &ErrorRecord) -> bool {
    error.browser_error_code == Some(-32000)
        && (error
            .message
            .contains("Cannot find context with specified id")
            || error
                .message
                .contains("Could not find object with given id"))
}
