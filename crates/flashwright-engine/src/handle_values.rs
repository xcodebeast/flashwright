//! Typed CDP handle metadata keeps JavaScript strings out of Rust's scalar-only String.

use flashwright_browser::values::Utf16String;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::{ErrorCode, ErrorRecord};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteObject {
    #[serde(rename = "type")]
    pub kind: String,
    pub subtype: Option<String>,
    pub object_id: Option<String>,
    pub description: Option<Utf16String>,
    pub value: Option<Box<RawValue>>,
    pub unserializable_value: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct DescribedNode {
    pub node: NodeIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeIdentity {
    pub backend_node_id: u64,
}

#[derive(Deserialize)]
pub(crate) struct ResolvedNode {
    pub object: RemoteObject,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteProperties {
    pub result: Vec<RemoteProperty>,
    pub exception_details: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
pub(crate) struct RemoteProperty {
    pub name: Utf16String,
    #[serde(default)]
    pub enumerable: bool,
    pub value: Option<RemoteObject>,
}

impl RemoteObject {
    /// Primitive handles need no remote object; retain their exact value across navigation.
    pub fn primitive(&self, method: &str) -> Result<Option<Value>, ErrorRecord> {
        if self.object_id.is_some() {
            return Ok(None);
        }
        let invalid = || {
            ErrorRecord::new(
                ErrorCode::Protocol,
                method,
                "Chromium omitted a valid handle value or object identity",
            )
        };
        let value = match self.kind.as_str() {
            "undefined" => json!({ "kind": "undefined" }),
            "object" if self.subtype.as_deref() == Some("null") => json!({ "kind": "null" }),
            "string" => {
                let raw = self.value.as_ref().ok_or_else(invalid)?;
                let value: Utf16String = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
                json!({ "kind": "string", "units": value.0 })
            }
            "number" => {
                if let Some(special) = self.unserializable_value.as_deref() {
                    if !matches!(special, "-0" | "NaN" | "Infinity" | "-Infinity") {
                        return Err(invalid());
                    }
                    json!({ "kind": "special", "value": special })
                } else {
                    let raw = self.value.as_ref().ok_or_else(invalid)?;
                    let number: serde_json::Number =
                        serde_json::from_str(raw.get()).map_err(|_| invalid())?;
                    json!({ "kind": "number", "value": number })
                }
            }
            "boolean" => {
                let raw = self.value.as_ref().ok_or_else(invalid)?;
                let boolean: bool = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
                json!({ "kind": "boolean", "value": boolean })
            }
            "bigint" => {
                let bigint = self
                    .unserializable_value
                    .as_deref()
                    .and_then(|value| value.strip_suffix('n'))
                    .filter(|value| {
                        let digits = value.strip_prefix('-').unwrap_or(value);
                        !digits.is_empty() && digits.bytes().all(|digit| digit.is_ascii_digit())
                    })
                    .ok_or_else(invalid)?;
                json!({ "kind": "bigint", "value": bigint })
            }
            _ => return Err(invalid()),
        };
        Ok(Some(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_primitives_and_property_names_preserve_non_scalar_text() {
        let result: RemoteProperties = serde_json::from_str(
            r#"{"result":[{"name":"\ud800","enumerable":true,"value":{"type":"string","value":"\udfff\u0000"}}]}"#,
        )
        .unwrap();
        assert_eq!(result.result[0].name.0, [0xd800]);
        assert!(result.result[0].enumerable);
        assert!(result.exception_details.is_none());
        assert_eq!(
            result.result[0]
                .value
                .as_ref()
                .unwrap()
                .primitive("test")
                .unwrap(),
            Some(json!({ "kind": "string", "units": [0xdfff, 0] }))
        );
        for (raw, expected) in [
            (r#"{"type":"undefined"}"#, json!({"kind":"undefined"})),
            (
                r#"{"type":"object","subtype":"null","value":null}"#,
                json!({"kind":"null"}),
            ),
            (
                r#"{"type":"bigint","unserializableValue":"-123456789012345678901234567890n"}"#,
                json!({"kind":"bigint","value":"-123456789012345678901234567890"}),
            ),
            (
                r#"{"type":"number","unserializableValue":"-0"}"#,
                json!({"kind":"special","value":"-0"}),
            ),
            (
                r#"{"type":"boolean","value":true}"#,
                json!({"kind":"boolean","value":true}),
            ),
        ] {
            assert_eq!(
                serde_json::from_str::<RemoteObject>(raw)
                    .unwrap()
                    .primitive("test")
                    .unwrap(),
                Some(expected)
            );
        }
        let object: RemoteObject = serde_json::from_str(
            r#"{"type":"object","objectId":"owned","description":"Object\ud800"}"#,
        )
        .unwrap();
        assert_eq!(object.description.unwrap().0.last(), Some(&0xd800));
        for raw in [
            r#"{"type":"number","unserializableValue":"bogus"}"#,
            r#"{"type":"string"}"#,
            r#"{"type":"bigint","unserializableValue":"0xn"}"#,
            r#"{"type":"object"}"#,
        ] {
            assert!(
                serde_json::from_str::<RemoteObject>(raw)
                    .unwrap()
                    .primitive("test")
                    .is_err()
            );
        }
    }
}
