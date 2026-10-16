//! Context policy applies before public-page scripts, independently of private storage pages.

use flashwright_protocol::ErrorRecord;
use serde_json::{Value, json};

use crate::parse;

/// Null deliberately removes an override; absence selects the pinned default.
fn media_feature(parameters: &Value, name: &str, values: &[&str]) -> Result<String, ErrorRecord> {
    match parameters.get(name) {
        None => Ok(values[0].to_owned()),
        Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value)) if values.contains(&value.as_str()) => Ok(value.clone()),
        _ => Err(crate::invalid(
            "browser.newContext",
            &format!("invalid {name} media preference"),
        )),
    }
}

#[derive(Clone)]
pub(crate) struct ContextSettings {
    media_parameters: Value,
    pub ignore_https_errors: bool,
    pub javascript_enabled: bool,
}

impl ContextSettings {
    pub fn media_parameters(&self) -> Value {
        self.media_parameters.clone()
    }

    /// Reject malformed settings before creating a Chromium context.
    pub fn parse(parameters: &Value) -> Result<Self, ErrorRecord> {
        let media_parameters = json!({"media":"", "features":[
            {"name":"prefers-color-scheme", "value":media_feature(parameters, "colorScheme", &["light", "dark", "no-preference"])?},
            {"name":"prefers-reduced-motion", "value":media_feature(parameters, "reducedMotion", &["no-preference", "reduce"])?},
            {"name":"forced-colors", "value":media_feature(parameters, "forcedColors", &["none", "active"])?},
            {"name":"prefers-contrast", "value":media_feature(parameters, "contrast", &["no-preference", "more"])?},
        ]});
        Ok(Self {
            media_parameters,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_explicit_values_and_null_have_distinct_wire_meaning() {
        let defaults = ContextSettings::parse(&json!({}))
            .unwrap()
            .media_parameters();
        assert_eq!(defaults["features"][0]["value"], "light");
        for (index, (key, values)) in [
            ("colorScheme", vec!["light", "dark", "no-preference"]),
            ("reducedMotion", vec!["no-preference", "reduce"]),
            ("forcedColors", vec!["none", "active"]),
            ("contrast", vec!["no-preference", "more"]),
        ]
        .into_iter()
        .enumerate()
        {
            for value in values {
                let parameters = ContextSettings::parse(&json!({key:value}))
                    .unwrap()
                    .media_parameters();
                assert_eq!(parameters["features"][index]["value"], value);
            }
            let parameters = ContextSettings::parse(&json!({key:null}))
                .unwrap()
                .media_parameters();
            assert_eq!(parameters["features"][index]["value"], "");
            for value in [
                json!(false),
                json!(0),
                json!([]),
                json!({}),
                json!(""),
                json!("no-override"),
                json!("invalid"),
            ] {
                assert!(
                    ContextSettings::parse(&json!({key:value})).is_err(),
                    "{key}: {value}"
                );
            }
        }
    }
}
