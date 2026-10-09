//! Context/page-owned native document initialization, including disposable registrations.

use super::*;
use flashwright_browser::values::Utf16String;
use serde::Serialize;
use serde_json::value::RawValue;

const MAXIMUM_SCRIPTS: usize = 1024;
const MAXIMUM_SOURCE_UNITS: usize = 1_000_032;
const MAXIMUM_CONTEXT_SOURCE_UNITS: usize = 4_000_128;
const CLEANUP_BUDGET: Duration = Duration::from_secs(1);

pub(crate) struct InitScript {
    identifier: String,
    pub(super) context_identifier: String,
    pub(super) page_identifier: Option<String>,
    source: Box<RawValue>,
    source_units: usize,
}

impl Engine {
    pub(super) async fn add_init_script(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let page_scope = method == "page.addInitScript";
        validate_keys(
            method,
            &parameters,
            if page_scope {
                &["page", "sourceJson"]
            } else {
                &["context", "sourceJson"]
            },
        )?;
        let page_identifier = if page_scope {
            Some(identifier(&parameters, "page", method)?.to_owned())
        } else {
            None
        };
        let context_identifier = match &page_identifier {
            Some(identifier) => self.page(identifier, method)?.context_identifier,
            None => identifier(&parameters, "context", method)?.to_owned(),
        };
        let context = self.context(&context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let source_json = parameters["sourceJson"]
            .as_str()
            .ok_or_else(|| invalid(method, "sourceJson must contain a JSON string"))?;
        let units: Utf16String = serde_json::from_str(source_json)
            .map_err(|error| invalid(method, &error.to_string()))?;
        if units.0.len() > MAXIMUM_SOURCE_UNITS {
            return Err(script_limit(method));
        }
        let source = RawValue::from_string(source_json.to_owned())
            .map_err(|error| invalid(method, &error.to_string()))?;
        let _registration = operation
            .wait(context.state.while_alive(method, async {
                Ok(context.state.page_configuration.write().await)
            }))
            .await?;
        let script_identifier = self.identifier("init-script");
        let script = Arc::new(InitScript {
            identifier: script_identifier.clone(),
            context_identifier: context_identifier.clone(),
            page_identifier,
            source,
            source_units: units.0.len(),
        });
        let pages = {
            let registry = self.registry.lock().unwrap();
            let existing: Vec<_> = registry
                .init_scripts
                .values()
                .filter(|script| script.context_identifier == context_identifier)
                .collect();
            if existing.len() >= MAXIMUM_SCRIPTS
                || existing
                    .iter()
                    .map(|script| script.source_units)
                    .sum::<usize>()
                    + script.source_units
                    > MAXIMUM_CONTEXT_SOURCE_UNITS
            {
                return Err(script_limit(method));
            }
            registry
                .pages
                .iter()
                .filter(|(identifier, page)| {
                    page.state.purpose == PagePurpose::Public
                        && page.context_identifier == context_identifier
                        && script
                            .page_identifier
                            .as_ref()
                            .is_none_or(|owner| owner == *identifier)
                })
                .map(|(identifier, page)| (identifier.clone(), page.clone()))
                .collect::<Vec<_>>()
        };
        if script.page_identifier.is_some() && pages.is_empty() {
            return Err(closed(method));
        }
        for (_, page) in &pages {
            check_script_page(page, method)?;
        }
        let result = async {
            for (page_identifier, page) in &pages {
                if let Err(error) = self
                    .install_init_script(&script, page_identifier, page, &browser, false, operation)
                    .await
                {
                    if script.page_identifier.is_none()
                        && operation.check().is_ok()
                        && !self
                            .registry
                            .lock()
                            .unwrap()
                            .pages
                            .contains_key(page_identifier)
                    {
                        continue;
                    }
                    return Err(error);
                }
            }
            for (page_identifier, page) in &pages {
                if self
                    .registry
                    .lock()
                    .unwrap()
                    .pages
                    .contains_key(page_identifier)
                {
                    check_script_page(page, method)?;
                }
            }
            operation.check()?;
            let mut registry = self.registry.lock().unwrap();
            if !registry.contexts.contains_key(&context_identifier)
                || script
                    .page_identifier
                    .as_ref()
                    .is_some_and(|page| !registry.pages.contains_key(page))
            {
                return Err(closed(method));
            }
            registry
                .init_scripts
                .insert(script_identifier.clone(), script.clone());
            Ok(json!({"identifier":script_identifier}))
        }
        .await;
        match result {
            Ok(result) => Ok(result),
            Err(mut error) => {
                error.cleanup = Some(
                    self.cleanup_init_script(&script_identifier, &script, &browser)
                        .await
                        .into(),
                );
                Err(error)
            }
        }
    }

    /// The creation read barrier allows concurrent pages, while excluding registration/disposal.
    pub(super) async fn initialize_page_scripts(
        &self,
        page_identifier: &str,
        page: &Page,
        browser: &Chromium,
        operation: &Operation,
    ) -> Result<(), ErrorRecord> {
        let scripts: Vec<_> = self
            .registry
            .lock()
            .unwrap()
            .init_scripts
            .iter()
            .filter(|(_, script)| {
                script.context_identifier == page.context_identifier
                    && script.page_identifier.is_none()
            })
            .map(|(identifier, script)| (identifier.clone(), script.clone()))
            .collect();
        for (_, script) in scripts {
            self.install_init_script(&script, page_identifier, page, browser, true, operation)
                .await?;
        }
        Ok(())
    }

    async fn install_init_script(
        &self,
        script: &InitScript,
        page_identifier: &str,
        page: &Page,
        browser: &Chromium,
        run_immediately: bool,
        operation: &Operation,
    ) -> Result<(), ErrorRecord> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Parameters<'source> {
            source: &'source RawValue,
            run_immediately: bool,
        }
        let mut command = browser.connection.start_typed_command(
            "Page.addScriptToEvaluateOnNewDocument",
            Parameters {
                source: &script.source,
                run_immediately,
            },
            Some(&page.session_identifier),
        )?;
        let result = operation
            .wait(page.state.while_alive("addInitScript", command.response()))
            .await;
        let response = match result {
            Ok(response) => response,
            Err(mut error) => {
                if !matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) {
                    if error.browser_error_code.is_none()
                        && self
                            .registry
                            .lock()
                            .unwrap()
                            .pages
                            .contains_key(page_identifier)
                    {
                        self.retire_init_script_page(page_identifier, page, browser)
                            .await;
                    }
                    return Err(error);
                }
                if command.prevent_dispatch() {
                    error.cleanup = Some("notDispatched".into());
                    return Err(error);
                }
                match timeout(CLEANUP_BUDGET, command.response()).await {
                    Ok(Ok(response)) => {
                        if let Some(native_identifier) = response["identifier"].as_str() {
                            page.state
                                .init_scripts
                                .lock()
                                .unwrap()
                                .insert(script.identifier.clone(), native_identifier.into());
                        } else {
                            self.retire_init_script_page(page_identifier, page, browser)
                                .await;
                        }
                    }
                    Ok(Err(_))
                        if !self
                            .registry
                            .lock()
                            .unwrap()
                            .pages
                            .contains_key(page_identifier) => {}
                    _ => {
                        self.retire_init_script_page(page_identifier, page, browser)
                            .await;
                    }
                }
                return Err(error);
            }
        };
        let native_identifier = match response["identifier"].as_str() {
            Some(identifier) => identifier,
            None => {
                self.retire_init_script_page(page_identifier, page, browser)
                    .await;
                return Err(ErrorRecord::new(
                    ErrorCode::Protocol,
                    "addInitScript",
                    "Chromium omitted the native script identity",
                ));
            }
        };
        page.state
            .init_scripts
            .lock()
            .unwrap()
            .insert(script.identifier.clone(), native_identifier.into());
        operation.check()
    }

    pub(super) async fn dispose_init_script(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "initScript.dispose";
        validate_keys(method, &parameters, &["script"])?;
        let identifier = identifier(&parameters, "script", method)?;
        let script = self
            .registry
            .lock()
            .unwrap()
            .init_scripts
            .get(identifier)
            .cloned();
        let Some(script) = script else {
            return Ok(Value::Null);
        };
        let context = match self.context(&script.context_identifier, method) {
            Ok(context) => context,
            Err(_) => return Ok(Value::Null),
        };
        let browser = self.browser(&context.browser_identifier, method)?;
        let _registration = operation
            .wait(context.state.while_alive(method, async {
                Ok(context.state.page_configuration.write().await)
            }))
            .await?;
        operation.check()?;
        let script = self
            .registry
            .lock()
            .unwrap()
            .init_scripts
            .remove(identifier);
        let Some(script) = script else {
            return Ok(Value::Null);
        };
        if let Err(mut error) = operation
            .wait(self.remove_native_scripts(identifier, &script, &browser))
            .await
        {
            error.cleanup = Some(
                self.retire_init_script_owner(&script, &browser)
                    .await
                    .into(),
            );
            return Err(error);
        }
        Ok(Value::Null)
    }

    /// Successful registrations whose reply cannot be returned must not affect future documents.
    pub(crate) async fn discard_init_script(&self, result: &Value) -> Option<&'static str> {
        let identifier = result["identifier"].as_str()?;
        let script = self
            .registry
            .lock()
            .unwrap()
            .init_scripts
            .get(identifier)
            .cloned()?;
        let context = self
            .context(&script.context_identifier, "addInitScript")
            .ok()?;
        let browser = self
            .browser(&context.browser_identifier, "addInitScript")
            .ok()?;
        let (_cancellation_sender, cancellation) = watch::channel(false);
        let operation = Operation::new("initScript.dispose".into(), None, cancellation);
        match timeout(
            CLEANUP_BUDGET,
            self.dispose_init_script(json!({"script":identifier}), &operation),
        )
        .await
        {
            Ok(Ok(_)) => Some("initScriptDisposed"),
            _ => Some(self.retire_init_script_owner(&script, &browser).await),
        }
    }

    async fn cleanup_init_script(
        &self,
        identifier: &str,
        script: &InitScript,
        browser: &Chromium,
    ) -> &'static str {
        self.registry
            .lock()
            .unwrap()
            .init_scripts
            .remove(identifier);
        match timeout(
            CLEANUP_BUDGET,
            self.remove_native_scripts(identifier, script, browser),
        )
        .await
        {
            Ok(Ok(())) => "initScriptDisposed",
            _ => self.retire_init_script_owner(script, browser).await,
        }
    }

    async fn remove_native_scripts(
        &self,
        identifier: &str,
        script: &InitScript,
        browser: &Chromium,
    ) -> Result<(), ErrorRecord> {
        let pages: Vec<_> = self
            .registry
            .lock()
            .unwrap()
            .pages
            .iter()
            .filter(|(_, page)| page.context_identifier == script.context_identifier)
            .map(|(identifier, page)| (identifier.clone(), page.clone()))
            .collect();
        for (page_identifier, page) in pages {
            let native_identifier = page
                .state
                .init_scripts
                .lock()
                .unwrap()
                .get(identifier)
                .cloned();
            if let Some(native_identifier) = native_identifier {
                let removal = browser
                    .connection
                    .call(
                        "Page.removeScriptToEvaluateOnNewDocument",
                        json!({"identifier":native_identifier}),
                        Some(&page.session_identifier),
                    )
                    .await;
                if self
                    .registry
                    .lock()
                    .unwrap()
                    .pages
                    .contains_key(&page_identifier)
                {
                    removal?;
                }
                page.state.init_scripts.lock().unwrap().remove(identifier);
            }
        }
        Ok(())
    }

    async fn retire_init_script_owner(
        &self,
        script: &InitScript,
        browser: &Chromium,
    ) -> &'static str {
        if let Some(identifier) = &script.page_identifier {
            let page = self.registry.lock().unwrap().pages.get(identifier).cloned();
            if let Some(page) = page {
                return self
                    .retire_init_script_page(identifier, &page, browser)
                    .await;
            }
        } else if let Some(context) = self.remove_context(&script.context_identifier) {
            return dispose(browser, ResourceKind::Context, &context.protocol_identifier).await;
        }
        "ownerAlreadyClosing"
    }

    async fn retire_init_script_page(
        &self,
        identifier: &str,
        page: &Page,
        browser: &Chromium,
    ) -> &'static str {
        self.registry.lock().unwrap().pages.remove(identifier);
        self.finish_page(identifier, page, closed("addInitScript"), "close");
        dispose(browser, ResourceKind::Page, &page.target_identifier).await
    }
}

fn script_limit(method: &str) -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::ResourceLimit,
        method,
        "init-script source or context registration limit exceeded (1000000 source units, 1024 scripts, 4000000 retained source units)",
    )
}

fn check_script_page(page: &Page, method: &str) -> Result<(), ErrorRecord> {
    let state = page.state.state.lock().unwrap();
    state.check(method)?;
    if state.frames.values().any(|frame| frame.remote) {
        return Err(ErrorRecord::new(
            ErrorCode::UnsupportedFeature,
            method,
            "init scripts in out-of-process frames are not implemented",
        ));
    }
    Ok(())
}
