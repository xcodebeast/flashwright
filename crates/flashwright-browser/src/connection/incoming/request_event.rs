//! Drop only the unused text body before owning a large request-event projection.

use std::cell::Cell;
use std::fmt;
use std::io::{self, Write};

use serde::de::{DeserializeSeed, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;

use super::{Reply, protocol_error, resource_error};

const MAXIMUM_FIELDS: usize = 1024;
type Fields<'message> = Vec<(String, &'message RawValue)>;

/// Borrow nested JSON spans, including byte entries, without decoding the discarded text body.
fn fields(value: &RawValue) -> Reply<Fields<'_>> {
    struct FieldReader<'flag>(&'flag Cell<bool>);
    impl<'message> DeserializeSeed<'message> for FieldReader<'_> {
        type Value = Fields<'message>;
        fn deserialize<Deserializer: serde::Deserializer<'message>>(
            self,
            deserializer: Deserializer,
        ) -> Result<Self::Value, Deserializer::Error> {
            deserializer.deserialize_map(self)
        }
    }
    impl<'message> Visitor<'message> for FieldReader<'_> {
        type Value = Fields<'message>;
        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a request event object")
        }
        fn visit_map<Map: MapAccess<'message>>(
            self,
            mut map: Map,
        ) -> Result<Self::Value, Map::Error> {
            let mut fields = Vec::new();
            while let Some(field) = map.next_entry::<String, &'message RawValue>()? {
                if fields.len() == MAXIMUM_FIELDS {
                    self.0.set(true);
                    return Err(serde::de::Error::custom(
                        "request event field limit exceeded",
                    ));
                }
                fields.push(field);
            }
            Ok(fields)
        }
    }
    let limited = Cell::new(false);
    let mut deserializer = serde_json::Deserializer::from_str(value.get());
    FieldReader(&limited)
        .deserialize(&mut deserializer)
        .map_err(|error| {
            if limited.get() {
                resource_error("CDP request event exceeds 1024 inspected fields")
            } else {
                protocol_error(error.to_string())
            }
        })
}

struct RequestProjection<'fields, 'message> {
    fields: &'fields Fields<'message>,
}

impl Serialize for RequestProjection<'_, '_> {
    fn serialize<Output: Serializer>(
        &self,
        serializer: Output,
    ) -> Result<Output::Ok, Output::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (name, value) in self.fields {
            if name != "postData" {
                map.serialize_entry(name, value)?;
            }
        }
        map.end()
    }
}

struct EventProjection<'fields, 'message> {
    fields: &'fields Fields<'message>,
    request: &'fields Fields<'message>,
}

impl Serialize for EventProjection<'_, '_> {
    fn serialize<Output: Serializer>(
        &self,
        serializer: Output,
    ) -> Result<Output::Ok, Output::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (name, value) in self.fields {
            if name == "request" {
                map.serialize_entry(
                    name,
                    &RequestProjection {
                        fields: self.request,
                    },
                )?;
            } else {
                map.serialize_entry(name, value)?;
            }
        }
        map.end()
    }
}

struct BoundedProjection {
    bytes: Vec<u8>,
    maximum_bytes: usize,
    limited: bool,
}

impl Write for BoundedProjection {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(length) = self.bytes.len().checked_add(bytes.len()) else {
            self.limited = true;
            return Err(io::Error::other("request projection length overflow"));
        };
        if length > self.maximum_bytes {
            self.limited = true;
            return Err(io::Error::other("request projection exceeds control limit"));
        }
        if length > self.bytes.capacity() {
            let capacity = length
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.maximum_bytes);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .map_err(|_| {
                    self.limited = true;
                    io::Error::other("request projection allocation failed")
                })?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The caller keeps original envelope overhead within the same control allowance.
pub(super) fn project(parameters: &RawValue, maximum_bytes: usize) -> Reply<Box<RawValue>> {
    let event_fields = fields(parameters)?;
    let request_value = event_fields
        .iter()
        .rev()
        .find(|(name, _)| name == "request")
        .map(|(_, value)| *value)
        .ok_or_else(|| protocol_error("browser omitted request event metadata".into()))?;
    let request_fields = fields(request_value)?;
    let projection = EventProjection {
        fields: &event_fields,
        request: &request_fields,
    };
    let mut output = BoundedProjection {
        bytes: Vec::new(),
        maximum_bytes,
        limited: false,
    };
    serde_json::to_writer(&mut output, &projection).map_err(|error| {
        if output.limited {
            resource_error("CDP request event projection exceeds control-message limit")
        } else {
            protocol_error(error.to_string())
        }
    })?;
    // RawValue owns this exact validated JSON buffer; no intermediate Value tree is constructed.
    RawValue::from_string(
        String::from_utf8(output.bytes).map_err(|error| protocol_error(error.to_string()))?,
    )
    .map_err(|error| protocol_error(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flashwright_protocol::ErrorCode;
    use serde_json::{Value, json};

    #[test]
    fn projection_preserves_all_fields_except_request_text() {
        let parameters = json!({"requestId":"owner", "unknown":{"nested":[1,2,3]}, "request":{
            "url":"https://example.test/", "postData":"lossy text", "postDataEntries":[{"bytes":"AP8="}],
            "headers":{"X-Value":"a\nb"}, "postDataOther":"preserved"
        }});
        let raw = serde_json::value::to_raw_value(&parameters).unwrap();
        let projected = project(&raw, 4096).unwrap();
        let actual: Value = serde_json::from_str(projected.get()).unwrap();
        let mut expected = parameters;
        expected["request"]
            .as_object_mut()
            .unwrap()
            .remove("postData");
        assert_eq!(actual, expected);
        assert_eq!(
            projected.get().len(),
            serde_json::to_vec(&expected).unwrap().len()
        );
    }

    #[test]
    fn projection_bound_applies_before_an_oversized_byte_entry_is_owned() {
        let parameters = serde_json::value::to_raw_value(&json!({"request":{
            "postData":"discarded", "postDataEntries":[{"bytes":"x".repeat(4096)}]
        }}))
        .unwrap();
        assert_eq!(
            project(&parameters, 1024).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        let projected = project(&parameters, 8192).unwrap();
        assert!(project(&parameters, projected.get().len()).is_ok());
        assert_eq!(
            project(&parameters, projected.get().len() - 1)
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
    }

    #[test]
    fn discarded_text_is_not_decoded_or_used_to_fabricate_missing_bytes() {
        let parameters = RawValue::from_string(
            r#"{"request":{"postData":"\ud800","headers":{}},"requestId":"owner"}"#.into(),
        )
        .unwrap();
        let projected = project(&parameters, 4096).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(projected.get()).unwrap(),
            json!({"request":{"headers":{}},"requestId":"owner"})
        );
    }

    #[test]
    fn request_and_event_field_tables_are_bounded() {
        let fields: serde_json::Map<String, Value> = (0..MAXIMUM_FIELDS)
            .map(|index| (format!("field{index}"), Value::Null))
            .collect();
        let mut request = fields.clone();
        request.insert("postData".into(), json!("ignored"));
        let oversized_request =
            serde_json::value::to_raw_value(&json!({"request":request})).unwrap();
        assert_eq!(
            project(&oversized_request, 1024 * 1024).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        let mut event = fields;
        event.insert("request".into(), json!({}));
        let oversized_event = serde_json::value::to_raw_value(&event).unwrap();
        assert_eq!(
            project(&oversized_event, 1024 * 1024).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
    }
}
