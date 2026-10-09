//! Context policy applies before public-page scripts, independently of private storage pages.

use flashwright_protocol::ErrorRecord;
use serde_json::{Value, json};

use crate::parse;

/// Public-page CSS uses the pinned defaults instead of operating-system preferences.
pub(crate) fn default_media_parameters() -> Value {
    json!({"media":"", "features":[
        {"name":"prefers-color-scheme", "value":"light"},
        {"name":"prefers-reduced-motion", "value":"no-preference"},
        {"name":"forced-colors", "value":"none"},
        {"name":"prefers-contrast", "value":"no-preference"},
    ]})
}

#[derive(Clone)]
pub(crate) struct ContextSettings {
    pub ignore_https_errors: bool,
    pub javascript_enabled: bool,
}

impl ContextSettings {
    /// Reject malformed settings before creating a Chromium context.
    pub fn parse(parameters: &Value) -> Result<Self, ErrorRecord> {
        Ok(Self {
            ignore_https_errors: parameters
                .get("ignoreHTTPSErrors")
                .map(|value| parse::<bool>("browser.newContext", value.clone()))
                .transpose()?
                .unwrap_or(false),
            javascript_enabled: parameters
                .get("javaScriptEnabled")
                .map(|value| parse::<bool>("browser.newContext", value.clone()))
                .transpose()?
                .unwrap_or(true),
        })
    }
}
