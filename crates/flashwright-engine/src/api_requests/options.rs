//! Standalone request context admission validates the host's canonical storage wire shape.

use super::exchange::Header;
use flashwright_protocol::{ErrorCode, ErrorRecord};
use http::HeaderName;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::mem::size_of;

const METHOD: &str = "apiRequest.newContext";
const MAXIMUM_METADATA_BYTES: usize = 1024 * 1024;
const MAXIMUM_HEADERS: usize = 4096;
const MAXIMUM_COOKIES: usize = 4096;
const MAXIMUM_STORAGE_BYTES: usize = 7 * 1024 * 1024;
const MAXIMUM_STORAGE_ORIGINS: usize = 1024;
const MAXIMUM_STORAGE_ENTRIES: usize = 100000;
const MAXIMUM_STORAGE_CODE_UNITS: usize = 100000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ContextOptions {
    #[serde(default, rename = "extraHTTPHeaders")]
    pub(super) extra_http_headers: Vec<Header>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) user_agent: Option<String>,
    #[serde(default, rename = "ignoreHTTPSErrors")]
    pub(super) ignore_https_errors: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) http_credentials: Option<HttpCredentials>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) storage_state: Option<StorageState>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HttpCredentials {
    pub(super) username: String,
    pub(super) password: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) origin: Option<String>,
    #[serde(default)]
    pub(super) send: CredentialSend,
}

// Context debugging must never print Basic authentication credentials.
impl std::fmt::Debug for HttpCredentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpCredentials")
            .field("username", &"<redacted>")
            .field("password", &"<redacted>")
            .field("origin", &self.origin.as_ref().map(|_| "<redacted>"))
            .field("send", &self.send)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum CredentialSend {
    #[default]
    Unauthorized,
    Always,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StorageState {
    pub(super) cookies: Vec<Cookie>,
    pub(super) origins: Vec<StorageOrigin>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cookie {
    pub(super) name: String,
    pub(super) value: String,
    pub(super) domain: String,
    pub(super) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) expires: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) same_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) partition_key: Option<String>,
    #[serde(
        rename = "_crHasCrossSiteAncestor",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) has_cross_site_ancestor: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StorageOrigin {
    pub(super) origin: String,
    pub(super) local_storage: Vec<StorageEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StorageEntry {
    pub(super) name: Vec<u16>,
    pub(super) value: Vec<u16>,
}

impl ContextOptions {
    /// Validate before creating a context, retaining ordered duplicate header fields.
    pub(super) fn parse(value: Value) -> Result<Self, ErrorRecord> {
        // The host counts send only when supplied; its implicit default consumes no raw bytes.
        let explicit_credential_send = value
            .get("httpCredentials")
            .and_then(|credentials| credentials.get("send"))
            .is_some();
        // Count the incoming wire so integer expiry values keep their host JSON size.
        let mut encoded_storage = EncodedSize(0);
        if let Some(storage) = value.get("storageState") {
            serde_json::to_writer(&mut encoded_storage, storage).map_err(|error| {
                ErrorRecord::new(ErrorCode::Protocol, METHOD, error.to_string())
            })?;
        }
        let options: Self =
            serde_json::from_value(value).map_err(|error| invalid(error.to_string()))?;
        options.validate_metadata(explicit_credential_send)?;
        if let Some(storage) = &options.storage_state {
            storage.validate(encoded_storage.0)?;
        }
        Ok(options)
    }

    fn validate_metadata(&self, explicit_credential_send: bool) -> Result<(), ErrorRecord> {
        if self.extra_http_headers.len() > MAXIMUM_HEADERS {
            return Err(resource("request context exceeds 4096 headers"));
        }
        let mut bytes = 0usize;
        for header in &self.extra_http_headers {
            if HeaderName::from_bytes(header.name.as_bytes()).is_err() {
                return Err(invalid("invalid HTTP header name"));
            }
            validate_header_value(&header.value)?;
            bytes = bytes
                .saturating_add(header.name.len())
                .saturating_add(header.value.len());
        }
        if let Some(user_agent) = &self.user_agent {
            validate_header_value(user_agent)?;
            bytes = bytes.saturating_add(user_agent.len());
        }
        if let Some(credentials) = &self.http_credentials {
            bytes = bytes
                .saturating_add(credentials.username.len())
                .saturating_add(credentials.password.len())
                .saturating_add(credentials.origin.as_ref().map_or(0, String::len));
            if explicit_credential_send {
                bytes = bytes.saturating_add(match credentials.send {
                    CredentialSend::Unauthorized => "unauthorized".len(),
                    CredentialSend::Always => "always".len(),
                });
            }
        }
        if bytes > MAXIMUM_METADATA_BYTES {
            return Err(resource("request context metadata exceeds 1 MiB"));
        }
        Ok(())
    }

    /// Charge owned structures and allocated capacities without allocating a serialized copy.
    pub(super) fn retained_bytes(&self) -> usize {
        let mut bytes = size_of::<Self>().saturating_add(vector_bytes(&self.extra_http_headers));
        for header in &self.extra_http_headers {
            bytes = bytes
                .saturating_add(header.name.capacity())
                .saturating_add(header.value.capacity());
        }
        bytes = bytes.saturating_add(string_bytes(&self.user_agent));
        if let Some(credentials) = &self.http_credentials {
            bytes = bytes
                .saturating_add(credentials.username.capacity())
                .saturating_add(credentials.password.capacity())
                .saturating_add(string_bytes(&credentials.origin));
        }
        if let Some(storage) = &self.storage_state {
            bytes = bytes
                .saturating_add(vector_bytes(&storage.cookies))
                .saturating_add(vector_bytes(&storage.origins));
            for cookie in &storage.cookies {
                bytes = bytes
                    .saturating_add(cookie.name.capacity())
                    .saturating_add(cookie.value.capacity())
                    .saturating_add(cookie.domain.capacity())
                    .saturating_add(cookie.path.capacity())
                    .saturating_add(string_bytes(&cookie.url))
                    .saturating_add(string_bytes(&cookie.same_site))
                    .saturating_add(string_bytes(&cookie.partition_key));
            }
            for origin in &storage.origins {
                bytes = bytes
                    .saturating_add(origin.origin.capacity())
                    .saturating_add(vector_bytes(&origin.local_storage));
                for entry in &origin.local_storage {
                    bytes = bytes
                        .saturating_add(vector_bytes(&entry.name))
                        .saturating_add(vector_bytes(&entry.value));
                }
            }
        }
        bytes
    }
}

impl StorageState {
    fn validate(&self, encoded_bytes: usize) -> Result<(), ErrorRecord> {
        if self.cookies.len() > MAXIMUM_COOKIES {
            return Err(resource("storage state exceeds 4096 cookies"));
        }
        if self.origins.len() > MAXIMUM_STORAGE_ORIGINS {
            return Err(resource("storage state exceeds 1024 origins"));
        }
        for cookie in &self.cookies {
            if cookie.domain.is_empty() || cookie.path.is_empty() {
                return Err(invalid("cookies require a domain and path"));
            }
            if cookie.expires.is_some_and(|expires| {
                !expires.is_finite()
                    || (expires < 0.0 && expires != -1.0)
                    || expires > 253402300799.0
            }) {
                return Err(invalid(
                    "cookie expiry must be -1 or a valid nonnegative Unix timestamp",
                ));
            }
            if cookie
                .same_site
                .as_deref()
                .is_some_and(|value| !["Strict", "Lax", "None"].contains(&value))
            {
                return Err(invalid("sameSite must be Strict, Lax or None"));
            }
        }
        let mut entries = 0usize;
        let mut code_units = 0usize;
        for origin in &self.origins {
            // The host has already normalized these with WHATWG URL, as for browser storage.
            if !origin.origin.starts_with("http://") && !origin.origin.starts_with("https://") {
                return Err(ErrorRecord::new(
                    ErrorCode::UnsupportedFeature,
                    METHOD,
                    "storage state currently supports HTTP and HTTPS origins",
                ));
            }
            entries = entries.saturating_add(origin.local_storage.len());
            if entries > MAXIMUM_STORAGE_ENTRIES {
                return Err(resource(
                    "storage state exceeds 100000 localStorage entries",
                ));
            }
            for entry in &origin.local_storage {
                code_units = code_units
                    .saturating_add(entry.name.len())
                    .saturating_add(entry.value.len())
                    .saturating_add(2);
                if code_units > MAXIMUM_STORAGE_CODE_UNITS {
                    return Err(resource(
                        "storage state exceeds 100000 localStorage code units",
                    ));
                }
            }
        }
        if encoded_bytes > MAXIMUM_STORAGE_BYTES {
            return Err(resource("storage state exceeds 7 MiB of serialized JSON"));
        }
        Ok(())
    }
}

fn validate_header_value(value: &str) -> Result<(), ErrorRecord> {
    // Node's HTTP validator permits tab, printable ASCII and Latin-1, but rejects DEL.
    if value
        .chars()
        .any(|character| !matches!(character as u32, 9 | 32..=126 | 128..=255))
    {
        return Err(invalid("invalid HTTP header value"));
    }
    Ok(())
}

fn vector_bytes<T>(values: &Vec<T>) -> usize {
    values.capacity().saturating_mul(size_of::<T>())
}

fn string_bytes(value: &Option<String>) -> usize {
    value.as_ref().map_or(0, String::capacity)
}

struct EncodedSize(usize);

impl std::io::Write for EncodedSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("storage size overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::InvalidArgument, METHOD, message)
}

fn resource(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, METHOD, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cookie() -> Value {
        json!({ "name": "session", "value": "secret", "domain": ".example.test", "path": "/" })
    }

    fn storage(cookies: Vec<Value>, origins: Vec<Value>) -> Value {
        json!({ "storageState": { "cookies": cookies, "origins": origins } })
    }

    fn assert_error(value: Value, expected: ErrorCode) {
        let error = ContextOptions::parse(value).unwrap_err();
        assert_eq!(error.code, expected);
        assert_eq!(error.method.as_ref(), METHOD);
    }

    #[test]
    fn defaults_leave_user_agent_unspecified_and_credentials_unauthorized() {
        let options = ContextOptions::parse(json!({})).unwrap();
        assert!(options.extra_http_headers.is_empty());
        assert!(options.user_agent.is_none());
        assert!(!options.ignore_https_errors);
        assert!(options.storage_state.is_none());
        let options = ContextOptions::parse(json!({
            "httpCredentials": { "username": "original-user", "password": "original-password", "origin": "original-scope" }
        }))
        .unwrap();
        assert_eq!(
            options.http_credentials.as_ref().unwrap().send,
            CredentialSend::Unauthorized
        );
        let diagnostic = format!("{options:?}");
        assert!(!diagnostic.contains("original-user"));
        assert!(!diagnostic.contains("original-password"));
        assert!(!diagnostic.contains("original-scope"));
    }

    #[test]
    fn headers_preserve_case_order_duplicates_and_latin1_values() {
        let options = ContextOptions::parse(json!({
            "extraHTTPHeaders": [
                { "name": "X-First", "value": "\t é\u{80}ÿ" },
                { "name": "x-first", "value": "second" }
            ],
            "userAgent": ""
        }))
        .unwrap();
        assert_eq!(options.extra_http_headers[0].name, "X-First");
        assert_eq!(options.extra_http_headers[0].value, "\t é\u{80}ÿ");
        assert_eq!(options.extra_http_headers[1].name, "x-first");
        assert_eq!(options.extra_http_headers[1].value, "second");
        assert_eq!(options.user_agent.as_deref(), Some(""));
    }

    #[test]
    fn headers_reject_invalid_names_controls_and_non_latin1_values() {
        for name in ["", "x name", "x:name", "x-é", "x\r\n"] {
            assert_error(
                json!({ "extraHTTPHeaders": [{ "name": name, "value": "valid" }] }),
                ErrorCode::InvalidArgument,
            );
        }
        for value in ["\0", "\r", "\n", "\u{7f}", "\u{1f}", "Ā", "😀"] {
            assert_error(
                json!({ "extraHTTPHeaders": [{ "name": "x-valid", "value": value }] }),
                ErrorCode::InvalidArgument,
            );
            assert_error(json!({ "userAgent": value }), ErrorCode::InvalidArgument);
        }
    }

    #[test]
    fn metadata_limit_counts_raw_utf8_and_only_explicit_send() {
        let password = "a".repeat(MAXIMUM_METADATA_BYTES);
        ContextOptions::parse(
            json!({ "httpCredentials": { "username": "", "password": password } }),
        )
        .unwrap();
        assert_error(
            json!({ "httpCredentials": { "username": "", "password": password, "send": "always" } }),
            ErrorCode::ResourceLimit,
        );
        ContextOptions::parse(json!({ "userAgent": "é".repeat(MAXIMUM_METADATA_BYTES / 2) }))
            .unwrap();
        assert_error(
            json!({ "userAgent": "é".repeat(MAXIMUM_METADATA_BYTES / 2 + 1) }),
            ErrorCode::ResourceLimit,
        );
        assert_error(
            json!({ "userAgent": "a".repeat(MAXIMUM_METADATA_BYTES), "extraHTTPHeaders": [{ "name": "x", "value": "" }] }),
            ErrorCode::ResourceLimit,
        );
        ContextOptions::parse(json!({ "httpCredentials": { "username": "", "password": "", "origin": "scope", "send": "always" } })).unwrap();
    }

    #[test]
    fn unknown_fields_and_wrong_wire_types_are_invalid_arguments() {
        for value in [
            json!({ "baseURL": "https://example.test" }),
            json!({ "extraHTTPHeaders": {} }),
            json!({ "extraHTTPHeaders": [{ "name": "x", "value": "v", "extra": true }] }),
            json!({ "ignoreHTTPSErrors": "true" }),
            json!({ "httpCredentials": { "username": "u" } }),
            json!({ "httpCredentials": { "username": "u", "password": "p", "send": "sometimes" } }),
            json!({ "httpCredentials": { "username": "u", "password": "p", "extra": true } }),
            json!({ "storageState": { "cookies": [], "origins": [], "extra": true } }),
            json!({ "storageState": { "cookies": [], "origins": [{ "origin": "https://example.test", "localStorage": [], "extra": true }] } }),
            json!({ "storageState": { "cookies": [], "origins": [{ "origin": "https://example.test", "localStorage": [{ "name": [], "value": [], "extra": true }] }] } }),
        ] {
            assert_error(value, ErrorCode::InvalidArgument);
        }
        let mut value = cookie();
        value["extra"] = json!(true);
        assert_error(storage(vec![value], vec![]), ErrorCode::InvalidArgument);
    }

    #[test]
    fn cookie_optional_fields_survive_without_fabricated_defaults() {
        let mut present = cookie();
        present["url"] = json!("https://example.test/path");
        present["expires"] = json!(-1.0);
        present["httpOnly"] = json!(false);
        present["secure"] = json!(false);
        present["sameSite"] = json!("None");
        present["partitionKey"] = json!("https://top.example");
        present["_crHasCrossSiteAncestor"] = json!(false);
        let input = storage(vec![cookie(), present], vec![]);
        let options = ContextOptions::parse(input.clone()).unwrap();
        let output = serde_json::to_value(options.storage_state.unwrap()).unwrap();
        assert_eq!(output, input["storageState"]);
    }

    #[test]
    fn cookie_expiry_and_canonical_domain_path_boundaries_are_enforced() {
        for expires in [-1.0, 0.0, 0.5, 253402300799.0] {
            let mut value = cookie();
            value["expires"] = json!(expires);
            ContextOptions::parse(storage(vec![value], vec![])).unwrap();
        }
        for expires in [-2.0, -0.5, 253402300800.0] {
            let mut value = cookie();
            value["expires"] = json!(expires);
            assert_error(storage(vec![value], vec![]), ErrorCode::InvalidArgument);
        }
        for field in ["domain", "path"] {
            let mut value = cookie();
            value[field] = json!("");
            assert_error(storage(vec![value], vec![]), ErrorCode::InvalidArgument);
        }
        for same_site in ["Strict", "Lax", "None"] {
            let mut value = cookie();
            value["sameSite"] = json!(same_site);
            ContextOptions::parse(storage(vec![value], vec![])).unwrap();
        }
        let mut value = cookie();
        value["sameSite"] = json!("strict");
        assert_error(storage(vec![value], vec![]), ErrorCode::InvalidArgument);
    }

    #[test]
    fn storage_preserves_lone_surrogates_and_requires_u16_wire_units() {
        let origin = json!({ "origin": "https://example.test", "localStorage": [{ "name": [0, 55296, 65535], "value": [56320] }] });
        let options = ContextOptions::parse(storage(vec![], vec![origin.clone()])).unwrap();
        assert_eq!(
            serde_json::to_value(options.storage_state.unwrap()).unwrap()["origins"][0],
            origin
        );
        for name in [json!([-1]), json!([65536]), json!([1.5]), json!("text")] {
            assert_error(
                storage(
                    vec![],
                    vec![
                        json!({ "origin": "https://example.test", "localStorage": [{ "name": name, "value": [] }] }),
                    ],
                ),
                ErrorCode::InvalidArgument,
            );
        }
        assert_error(
            storage(
                vec![],
                vec![json!({ "origin": "file:///tmp", "localStorage": [] })],
            ),
            ErrorCode::UnsupportedFeature,
        );
    }

    #[test]
    fn collection_limits_accept_the_boundary_and_reject_the_next_item() {
        let header = json!({ "name": "x", "value": "" });
        ContextOptions::parse(json!({ "extraHTTPHeaders": vec![header.clone(); MAXIMUM_HEADERS] }))
            .unwrap();
        assert_error(
            json!({ "extraHTTPHeaders": vec![header; MAXIMUM_HEADERS + 1] }),
            ErrorCode::ResourceLimit,
        );
        ContextOptions::parse(storage(vec![cookie(); MAXIMUM_COOKIES], vec![])).unwrap();
        assert_error(
            storage(vec![cookie(); MAXIMUM_COOKIES + 1], vec![]),
            ErrorCode::ResourceLimit,
        );
        let origin = json!({ "origin": "http://example.test", "localStorage": [] });
        ContextOptions::parse(storage(
            vec![],
            vec![origin.clone(); MAXIMUM_STORAGE_ORIGINS],
        ))
        .unwrap();
        assert_error(
            storage(vec![], vec![origin; MAXIMUM_STORAGE_ORIGINS + 1]),
            ErrorCode::ResourceLimit,
        );
    }

    #[test]
    fn local_storage_limits_include_two_units_for_each_entry() {
        let origin = |length| json!({ "origin": "https://example.test", "localStorage": [{ "name": vec![0u16; length], "value": [] }] });
        ContextOptions::parse(storage(
            vec![],
            vec![origin(MAXIMUM_STORAGE_CODE_UNITS - 2)],
        ))
        .unwrap();
        assert_error(
            storage(vec![], vec![origin(MAXIMUM_STORAGE_CODE_UNITS - 1)]),
            ErrorCode::ResourceLimit,
        );
        let empty = json!({ "name": [], "value": [] });
        assert_error(
            storage(
                vec![],
                vec![
                    json!({ "origin": "https://example.test", "localStorage": vec![empty; MAXIMUM_STORAGE_ENTRIES + 1] }),
                ],
            ),
            ErrorCode::ResourceLimit,
        );
    }

    #[test]
    fn storage_limit_counts_json_escaping_at_exact_boundary() {
        let mut value = cookie();
        value["value"] = json!("");
        value["expires"] = json!(-1);
        let base = storage(vec![value.clone()], vec![]);
        let overhead = serde_json::to_vec(&base["storageState"]).unwrap().len();
        value["value"] = json!("a".repeat(MAXIMUM_STORAGE_BYTES - overhead));
        ContextOptions::parse(storage(vec![value.clone()], vec![])).unwrap();
        value["value"] = json!("a".repeat(MAXIMUM_STORAGE_BYTES - overhead + 1));
        assert_error(
            storage(vec![value.clone()], vec![]),
            ErrorCode::ResourceLimit,
        );
        value["value"] = json!("\0".repeat(MAXIMUM_STORAGE_BYTES / 6));
        assert_error(storage(vec![value], vec![]), ErrorCode::ResourceLimit);
    }

    #[test]
    fn retained_bytes_include_unused_string_and_vector_capacity() {
        let mut options = ContextOptions::parse(storage(vec![cookie()], vec![json!({
            "origin": "https://example.test", "localStorage": [{ "name": [55296], "value": [56320] }]
        })])).unwrap();
        let original = options.retained_bytes();
        let storage = options.storage_state.as_mut().unwrap();
        let previous_capacity = storage.cookies[0].value.capacity();
        storage.cookies[0].value.reserve(1024);
        let string_growth = storage.cookies[0].value.capacity() - previous_capacity;
        let previous_capacity = storage.origins[0].local_storage[0].name.capacity();
        storage.origins[0].local_storage[0].name.reserve(1024);
        let unit_growth = (storage.origins[0].local_storage[0].name.capacity() - previous_capacity)
            * size_of::<u16>();
        assert_eq!(
            options.retained_bytes(),
            original + string_growth + unit_growth
        );
        assert!(
            ContextOptions::parse(json!({})).unwrap().retained_bytes()
                >= size_of::<ContextOptions>()
        );
    }
}
