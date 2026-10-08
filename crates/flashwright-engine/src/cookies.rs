//! Native Chromium cookie storage stays scoped to its owning browser context.

use super::*;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Cookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    url: Option<String>,
    expires: Option<f64>,
    http_only: Option<bool>,
    secure: Option<bool>,
    same_site: Option<String>,
    partition_key: Option<String>,
    #[serde(rename = "_crHasCrossSiteAncestor")]
    has_cross_site_ancestor: Option<bool>,
}

impl Cookie {
    pub fn validate(&self, method: &str) -> Result<(), ErrorRecord> {
        if self.domain.is_empty() || self.path.is_empty() {
            return Err(invalid(method, "cookies require a domain and path"));
        }
        if self.expires.is_some_and(|expires| {
            !expires.is_finite() || (expires < 0.0 && expires != -1.0) || expires > 253402300799.0
        }) {
            return Err(invalid(
                method,
                "cookie expiry must be -1 or a valid nonnegative Unix timestamp",
            ));
        }
        if self
            .same_site
            .as_deref()
            .is_some_and(|value| !["Strict", "Lax", "None"].contains(&value))
        {
            return Err(invalid(method, "sameSite must be Strict, Lax or None"));
        }
        Ok(())
    }

    fn chromium_parameters(&self) -> Value {
        let mut value = json!({ "name": self.name, "value": self.value, "domain": self.domain, "path": self.path });
        for (name, field) in [
            ("url", self.url.as_ref().map(|value| json!(value))),
            ("expires", self.expires.map(|value| json!(value))),
            ("httpOnly", self.http_only.map(|value| json!(value))),
            ("secure", self.secure.map(|value| json!(value))),
            (
                "sameSite",
                self.same_site.as_ref().map(|value| json!(value)),
            ),
        ] {
            if let Some(field) = field {
                value[name] = field;
            }
        }
        if let Some(partition) = &self.partition_key {
            value["partitionKey"] = json!({ "topLevelSite": partition, "hasCrossSiteAncestor": self.has_cross_site_ancestor.unwrap_or(true) });
        }
        value
    }
}

pub(crate) fn parse_cookies(value: Value, method: &str) -> Result<Vec<Cookie>, ErrorRecord> {
    let cookies: Vec<Cookie> = parse(method, value)?;
    for cookie in &cookies {
        cookie.validate(method)?;
    }
    Ok(cookies)
}

impl Engine {
    pub(crate) async fn context_cookies(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        validate_keys(
            method,
            &parameters,
            if method == "context.addCookies" {
                &["context", "cookies"]
            } else {
                &["context"]
            },
        )?;
        let context_identifier = identifier(&parameters, "context", method)?;
        let context = self.context(context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let cookies = if method == "context.addCookies" {
            Some(parse_cookies(parameters["cookies"].clone(), method)?)
        } else {
            None
        };
        let _exclusive = operation
            .wait(context.state.while_alive(method, async {
                Ok(context.state.storage_operations.lock().await)
            }))
            .await?;
        if method == "context.cookies" {
            return get_cookies(&context, &browser, operation, method).await;
        }
        let (command, parameters) = if let Some(cookies) = cookies {
            (
                "Storage.setCookies",
                json!({ "browserContextId": context.protocol_identifier, "cookies": cookies.iter().map(Cookie::chromium_parameters).collect::<Vec<_>>() }),
            )
        } else {
            (
                "Storage.clearCookies",
                json!({ "browserContextId": context.protocol_identifier }),
            )
        };
        operation.check()?;
        let mut pending = browser
            .connection
            .start_command(command, parameters, None)?;
        let result = operation
            .wait(context.state.while_alive(method, pending.response()))
            .await;
        if let Err(mut error) = result {
            error.method = method.into();
            if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) {
                if pending.prevent_dispatch() {
                    error.cleanup = Some("notDispatched".into());
                } else if pending.try_response().is_none() {
                    // A lost mutation acknowledgement cannot leave delayed writes in a
                    // reusable context. Retire this owner without replaying the command.
                    self.remove_context(context_identifier);
                    error.cleanup = Some(
                        dispose(
                            browser.as_ref(),
                            ResourceKind::Context,
                            &context.protocol_identifier,
                        )
                        .await
                        .into(),
                    );
                }
            } else if error.browser_error_code == Some(-32602) {
                error.code = ErrorCode::InvalidArgument;
            }
            return Err(error);
        }
        Ok(Value::Null)
    }
}

pub(crate) async fn get_cookies(
    context: &Context,
    browser: &Chromium,
    operation: &Operation,
    method: &str,
) -> Result<Value, ErrorRecord> {
    let result = operation
        .wait(context.state.while_alive(
            method,
            browser.connection.call(
                "Storage.getCookies",
                json!({ "browserContextId": context.protocol_identifier }),
                None,
            ),
        ))
        .await?;
    let cookies = result["cookies"]
        .as_array()
        .ok_or_else(|| invalid(method, "Chromium omitted cookies"))?;
    let cookies: Vec<_> = cookies.iter().map(|cookie| {
        let mut result = json!({
            "name": cookie["name"], "value": cookie["value"], "domain": cookie["domain"], "path": cookie["path"],
            "expires": cookie["expires"], "httpOnly": cookie["httpOnly"], "secure": cookie["secure"],
            "sameSite": cookie.get("sameSite").cloned().unwrap_or(json!("Lax")),
        });
        if let Some(partition) = cookie.get("partitionKey") {
            result["partitionKey"] = partition["topLevelSite"].clone();
            result["_crHasCrossSiteAncestor"] = partition["hasCrossSiteAncestor"].clone();
        }
        result
    }).collect();
    Ok(json!(cookies))
}

pub(crate) async fn set_cookies(
    context: &Context,
    browser: &Chromium,
    cookies: &[Cookie],
    operation: &Operation,
) -> Result<(), ErrorRecord> {
    operation.wait(context.state.while_alive("browser.newContext", browser.connection.call(
        "Storage.setCookies", json!({ "browserContextId": context.protocol_identifier, "cookies": cookies.iter().map(Cookie::chromium_parameters).collect::<Vec<_>>() }), None,
    ))).await.map_err(|mut error| {
        error.method = "browser.newContext.storageState.cookies".into();
        if error.browser_error_code == Some(-32602) { error.code = ErrorCode::InvalidArgument; }
        error
    })?;
    Ok(())
}
