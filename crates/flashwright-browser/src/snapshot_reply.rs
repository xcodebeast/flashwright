//! Independently admit raw snapshot DATA without expanding its DOM into a native Value tree.

use std::borrow::Cow;

use flashwright_protocol::{AttachmentEncoding, BinaryPayload, ErrorCode, ErrorRecord};
use serde::Deserialize;
use serde::de::{self, SeqAccess, Visitor};
use serde_json::value::RawValue;

const METHOD: &str = "tracing.snapshot";
pub const MAXIMUM_DATA_BYTES: usize = 4 * 1024 * 1024 - 64 * 1024;
pub const MAXIMUM_WRAPPER_BYTES: usize = 64 * 1024;
const MAXIMUM_JSON_DEPTH: usize = 260;
const MAXIMUM_JSON_VALUES: usize = 400000;

#[derive(Clone, Copy, Debug)]
pub struct SnapshotReplyAdmission {
    maximum_data_bytes: usize,
    maximum_wrapper_bytes: usize,
}

impl SnapshotReplyAdmission {
    pub(crate) fn maximum_wrapper_bytes(self) -> usize {
        self.maximum_wrapper_bytes
    }

    /// Lower grants preserve the fixed protocol ceiling; callers reserve ownership before dispatch.
    pub fn new(data_bytes: usize, wrapper_bytes: usize) -> Result<Self, ErrorRecord> {
        if data_bytes > MAXIMUM_DATA_BYTES || wrapper_bytes > MAXIMUM_WRAPPER_BYTES {
            return Err(limited("snapshot admission exceeds the supported ceiling"));
        }
        Ok(Self {
            maximum_data_bytes: data_bytes,
            maximum_wrapper_bytes: wrapper_bytes,
        })
    }
}

#[derive(Debug)]
pub enum SnapshotReply {
    Captured(Box<CapturedSnapshot>),
    Exception(Box<RawValue>),
}

#[derive(Debug)]
pub struct CapturedSnapshot {
    pub data: BinaryPayload,
    pub token: String,
    pub snapshot_number: u64,
    pub counters: SnapshotCounters,
    pub committed_cache: SnapshotCache,
    pub tentative_cache: SnapshotCache,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotCounters {
    pub bytes: usize,
    pub override_bytes: usize,
    pub css_read_bytes: usize,
    pub nodes: usize,
    pub depth: usize,
    pub css_depth: usize,
    pub attributes: usize,
    pub sheets: usize,
    pub rules: usize,
    pub override_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotCache {
    pub bytes: usize,
    pub nodes: usize,
    pub attributes: usize,
    pub sheets: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationReply<'message> {
    #[serde(borrow)]
    result: &'message RawValue,
    #[serde(borrow)]
    exception_details: Option<&'message RawValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CapturedObject<'message> {
    #[serde(rename = "type", borrow)]
    kind: &'message RawValue,
    #[serde(borrow)]
    value: &'message RawValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureValue<'message> {
    #[serde(borrow)]
    token: &'message RawValue,
    snapshot_number: u64,
    #[serde(borrow)]
    data: &'message RawValue,
    counters: SnapshotCounters,
    committed_cache: SnapshotCache,
    tentative_cache: SnapshotCache,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotData<'message> {
    #[serde(borrow)]
    html: &'message RawValue,
    #[serde(borrow)]
    url: &'message RawValue,
    #[serde(borrow)]
    doctype: &'message RawValue,
    viewport: Viewport,
    wall_time: f64,
    collection_time: f64,
    #[serde(borrow)]
    resource_overrides: &'message RawValue,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Viewport {
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StylesheetOverride<'message> {
    #[serde(borrow)]
    url: &'message RawValue,
    #[serde(borrow)]
    content: &'message RawValue,
    #[serde(borrow)]
    content_type: &'message RawValue,
}

fn limited(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, METHOD, message)
}

fn invalid(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, METHOD, message)
}

fn parse<'message, Decoded: Deserialize<'message>>(
    raw: &'message RawValue,
) -> Result<Decoded, ErrorRecord> {
    serde_json::from_str(raw.get()).map_err(|_| invalid("invalid snapshot reply shape"))
}

fn string(raw: &RawValue) -> bool {
    raw.get().starts_with('"')
}

fn short_string(raw: &RawValue, maximum_units: usize) -> Result<String, ErrorRecord> {
    if raw.get().len() > 6 * maximum_units + 2 {
        return Err(limited("snapshot metadata string exceeds its limit"));
    }
    let value: String = parse(raw)?;
    if value.encode_utf16().count() > maximum_units {
        return Err(limited("snapshot metadata string exceeds its limit"));
    }
    Ok(value)
}

/// RawValue already checked JSON grammar. This pass bounds structure without decoding strings.
fn validate_structure(raw: &RawValue) -> Result<(), ErrorRecord> {
    let bytes = raw.get().as_bytes();
    let mut offset = 0;
    let mut depth = 0;
    let mut values = 0;
    while offset < bytes.len() {
        match bytes[offset] {
            b'"' => {
                values += 1;
                offset += 1;
                while bytes[offset] != b'"' {
                    if bytes[offset] == b'\\' {
                        offset += 1;
                    }
                    offset += 1;
                }
            }
            b'[' | b'{' => {
                depth += 1;
                values += 1;
            }
            b']' | b'}' => depth -= 1,
            b',' | b':' | b' ' | b'\n' | b'\r' | b'\t' => {}
            _ => {
                values += 1;
                while offset + 1 < bytes.len()
                    && !matches!(
                        bytes[offset + 1],
                        b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t'
                    )
                {
                    offset += 1;
                }
            }
        }
        if depth > MAXIMUM_JSON_DEPTH || values > MAXIMUM_JSON_VALUES {
            return Err(limited("snapshot JSON depth or value limit exceeded"));
        }
        offset += 1;
    }
    Ok(())
}

fn count_overrides(raw: &RawValue) -> Result<usize, ErrorRecord> {
    struct OverrideVisitor<'count>(&'count mut usize);
    impl<'message> Visitor<'message> for OverrideVisitor<'_> {
        type Value = ();
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("bounded stylesheet overrides")
        }
        fn visit_seq<Sequence: SeqAccess<'message>>(
            self,
            mut sequence: Sequence,
        ) -> Result<Self::Value, Sequence::Error> {
            while let Some(entry) = sequence.next_element::<StylesheetOverride<'message>>()? {
                *self.0 += 1;
                if *self.0 > 1024 {
                    return Err(de::Error::custom("too many stylesheet overrides"));
                }
                if !string(entry.url)
                    || !string(entry.content)
                    || short_string(entry.content_type, 8).ok().as_deref() != Some("text/css")
                {
                    return Err(de::Error::custom("invalid stylesheet override"));
                }
            }
            Ok(())
        }
    }
    let mut count = 0;
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    let result = serde::Deserializer::deserialize_seq(&mut decoder, OverrideVisitor(&mut count));
    if count > 1024 {
        return Err(limited("snapshot exceeds 1024 stylesheet overrides"));
    }
    result.map_err(|_| invalid("invalid snapshot stylesheet overrides"))?;
    Ok(count)
}

fn validate_cache(cache: &SnapshotCache) -> Result<(), ErrorRecord> {
    if cache.bytes > 2 * 1024 * 1024
        || cache.nodes > 12500
        || cache.attributes > 50000
        || cache.sheets > 512
    {
        return Err(limited("snapshot cache exceeds its generation ceiling"));
    }
    Ok(())
}

/// Renderer counters use JSON.stringify's UTF-8 string representation. CDP may
/// instead escape Unicode, including surrogate pairs. Count that extra encoding
/// without allocating decoded strings (which cannot represent lone surrogates).
/// RawValue has already validated every escape; actual wire/storage limits still
/// apply to the original bytes independently of this counter comparison.
fn string_escape_overhead(raw: &RawValue) -> usize {
    fn hex_unit(bytes: &[u8]) -> u16 {
        bytes.iter().fold(0, |value, byte| {
            (value << 4)
                | u16::from(match byte {
                    b'0'..=b'9' => byte - b'0',
                    b'a'..=b'f' => byte - b'a' + 10,
                    b'A'..=b'F' => byte - b'A' + 10,
                    _ => unreachable!("RawValue validated the escape"),
                })
        })
    }
    let bytes = raw.get().as_bytes();
    let mut offset = 0;
    let mut overhead = 0;
    while offset < bytes.len() {
        if bytes[offset] != b'\\' {
            offset += 1;
            continue;
        }
        match bytes[offset + 1] {
            b'/' => overhead += 1,
            b'u' => {
                let unit = hex_unit(&bytes[offset + 2..offset + 6]);
                offset += 6;
                let encoded_bytes = match unit {
                    8 | 9 | 10 | 12 | 13 | 34 | 92 => 2,
                    0..=31 => 6,
                    32..=127 => 1,
                    128..=2047 => 2,
                    0xd800..=0xdbff
                        if bytes.get(offset..offset + 2) == Some(b"\\u")
                            && (0xdc00..=0xdfff)
                                .contains(&hex_unit(&bytes[offset + 2..offset + 6])) =>
                    {
                        // Two six-byte escapes encode one four-byte UTF-8 scalar.
                        overhead += 8;
                        offset += 6;
                        continue;
                    }
                    0xd800..=0xdfff => 6,
                    _ => 3,
                };
                overhead += 6 - encoded_bytes;
                continue;
            }
            _ => {}
        }
        offset += 2;
    }
    overhead
}

/// The caller supplies the complete wire frame size, including the outer CDP id/session envelope.
/// Native ownership must still check the returned token, sequence and counters against its exact grants.
/// Decoding does not release remote exception objects; the capture caller retains its attempt object group.
pub fn decode_snapshot_reply(
    result: &RawValue,
    frame_bytes: usize,
    admission: SnapshotReplyAdmission,
) -> Result<SnapshotReply, ErrorRecord> {
    if frame_bytes < result.get().len() {
        return Err(invalid(
            "snapshot wire size cannot be smaller than its result",
        ));
    }
    if frame_bytes > admission.maximum_data_bytes + admission.maximum_wrapper_bytes {
        return Err(limited("snapshot wire reply exceeds its admitted size"));
    }
    validate_structure(result)?;
    let evaluation: EvaluationReply<'_> = parse(result)?;
    if let Some(exception) = evaluation.exception_details {
        if frame_bytes > admission.maximum_wrapper_bytes {
            return Err(limited("snapshot exception envelope exceeds its limit"));
        }
        if !exception.get().starts_with('{') {
            return Err(invalid("invalid snapshot exception details"));
        }
        return Ok(SnapshotReply::Exception(exception.to_owned()));
    }
    let object: CapturedObject<'_> = parse(evaluation.result)?;
    if short_string(object.kind, 6)? != "object" {
        return Err(invalid("snapshot result must be an object"));
    }
    let capture: CaptureValue<'_> = parse(object.value)?;
    let data_bytes = capture.data.get().len();
    if frame_bytes - data_bytes > admission.maximum_wrapper_bytes {
        return Err(limited("snapshot wrapper exceeds its admitted size"));
    }
    let token = short_string(capture.token, 128)?;
    if token.is_empty()
        || !token.is_ascii()
        || capture.snapshot_number == 0
        || capture.snapshot_number > 9_007_199_254_740_991
    {
        return Err(invalid("invalid snapshot capture identity"));
    }
    let data: SnapshotData<'_> = parse(capture.data)?;
    if !matches!(data.html.get().as_bytes()[0], b'[' | b'"')
        || !string(data.url)
        || !string(data.doctype)
        || !data.wall_time.is_finite()
        || data.wall_time < 0.0
        || !data.collection_time.is_finite()
        || data.collection_time < 0.0
    {
        return Err(invalid("invalid snapshot DATA metadata"));
    }
    let _viewport = (data.viewport.width, data.viewport.height);
    let overrides = count_overrides(data.resource_overrides)?;
    let charged_data_bytes = data_bytes + 256 * overrides;
    if charged_data_bytes > admission.maximum_data_bytes {
        return Err(limited(
            "snapshot DATA and alias growth exceed their admitted size",
        ));
    }
    let counters = &capture.counters;
    let renderer_data_bytes = charged_data_bytes - string_escape_overhead(capture.data);
    if counters.bytes < renderer_data_bytes
        || counters.bytes > admission.maximum_data_bytes
        || counters.override_bytes > counters.bytes
        || counters.css_read_bytes > admission.maximum_data_bytes
        || counters.nodes > 25000
        || counters.depth > 128
        || counters.css_depth > 128
        || counters.attributes > 100000
        || counters.sheets > 1024
        || counters.rules > 100000
        || counters.override_count != overrides
    {
        return Err(limited("snapshot capture counters exceed their admission"));
    }
    validate_cache(&capture.committed_cache)?;
    validate_cache(&capture.tentative_cache)?;
    let data = BinaryPayload::new(
        Cow::Borrowed(capture.data.get().as_bytes()),
        AttachmentEncoding::Raw,
        admission.maximum_data_bytes,
        METHOD,
    )?;
    Ok(SnapshotReply::Captured(Box::new(CapturedSnapshot {
        data,
        token,
        snapshot_number: capture.snapshot_number,
        counters: capture.counters,
        committed_cache: capture.committed_cache,
        tentative_cache: capture.tentative_cache,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admission() -> SnapshotReplyAdmission {
        SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES, MAXIMUM_WRAPPER_BYTES).unwrap()
    }

    fn fixture(html: &str, overrides: &str, count: usize) -> Box<RawValue> {
        let data = format!(
            r#"{{"html":{html},"url":"https://example.test/","doctype":"html","viewport":{{"width":1280,"height":720}},"wallTime":1,"collectionTime":0,"resourceOverrides":{overrides}}}"#
        );
        let bytes = data.len() + 256 * count;
        RawValue::from_string(format!(r#"{{"result":{{"type":"object","value":{{"token":"capture-1","snapshotNumber":1,"data":{data},"counters":{{"bytes":{bytes},"overrideBytes":0,"cssReadBytes":0,"nodes":1,"depth":1,"cssDepth":0,"attributes":0,"sheets":{count},"rules":0,"overrideCount":{count}}},"committedCache":{{"bytes":0,"nodes":0,"attributes":0,"sheets":0}},"tentativeCache":{{"bytes":0,"nodes":0,"attributes":0,"sheets":0}}}}}}}}"#)).unwrap()
    }

    fn frame_bytes(result: &RawValue) -> usize {
        format!(r#"{{"id":7,"sessionId":"page","result":{}}}"#, result.get()).len()
    }

    #[test]
    fn raw_data_preserves_lone_utf16_and_does_not_expand_into_values() {
        let raw = fixture(r#"["HTML",{},"\ud800A\udfff\u0000é😀"]"#, "[]", 0);
        let decoded = decode_snapshot_reply(&raw, frame_bytes(&raw), admission()).unwrap();
        let SnapshotReply::Captured(captured) = decoded else {
            panic!("expected captured DATA")
        };
        let evaluation: EvaluationReply<'_> = parse(&raw).unwrap();
        let object: CapturedObject<'_> = parse(evaluation.result).unwrap();
        let capture: CaptureValue<'_> = parse(object.value).unwrap();
        assert_eq!(captured.data.bytes, capture.data.get().as_bytes());
        assert_eq!(captured.data.decoded_length, capture.data.get().len());
        assert!(matches!(captured.data.encoding, AttachmentEncoding::Raw));
        assert_eq!(captured.token, "capture-1");
        assert_eq!(captured.snapshot_number, 1);
    }

    #[test]
    fn escape_accounting_matches_utf8_for_every_utf16_unit_and_surrogate_edges() {
        for unit in 0..=u16::MAX {
            let raw = RawValue::from_string(format!(r#""\u{unit:04x}""#)).unwrap();
            let canonical_bytes = char::from_u32(u32::from(unit))
                .map(|character| serde_json::to_string(&character).unwrap().len())
                .unwrap_or(8); // A lone surrogate stays escaped, plus quotes.
            assert_eq!(
                raw.get().len() - string_escape_overhead(&raw),
                canonical_bytes
            );
        }
        for (escaped, canonical) in [
            (r#""\uD800\uDC00""#, "\u{10000}"),
            (r#""\udbff\udfff""#, "\u{10ffff}"),
            (r#""\ud83d\ude00""#, "😀"),
            (
                r#""\u0022\u005c\u0008\u0009\u000a\u000c\u000d\/""#,
                "\"\\\x08\t\n\x0c\r/",
            ),
            (r#""\\u00e9\"\\\/é😀""#, "\\u00e9\"\\/é😀"),
        ] {
            let raw = RawValue::from_string(escaped.into()).unwrap();
            assert_eq!(
                raw.get().len() - string_escape_overhead(&raw),
                serde_json::to_string(canonical).unwrap().len(),
                "{escaped}"
            );
        }
        for (escaped, overhead) in [
            (r#""\ud800\ud800\udc00""#, 8),
            (r#""\udc00\ud800""#, 0),
            (r#"["\ud800","\udc00"]"#, 0),
            (r#""\ud800\\udc00""#, 0),
        ] {
            let raw = RawValue::from_string(escaped.into()).unwrap();
            assert_eq!(string_escape_overhead(&raw), overhead, "{escaped}");
        }
    }

    #[test]
    fn escaped_unicode_counters_do_not_relax_wire_data_wrapper_or_alias_limits() {
        let html = r#"["HTML",{"title":"\u00e9\u0394\ud83d\ude00"},"\ud800A\udfff\u0000"]"#;
        let overrides = r#"[{"url":"https://example.test/\u00e9.css","content":"p::before{content:'\ud83d\ude00'}","contentType":"text/css"}]"#;
        let original = fixture(html, overrides, 1);
        let evaluation: EvaluationReply<'_> = parse(&original).unwrap();
        let object: CapturedObject<'_> = parse(evaluation.result).unwrap();
        let capture: CaptureValue<'_> = parse(object.value).unwrap();
        let data_bytes = capture.data.get().len();
        let charged_bytes = data_bytes + 256;
        let renderer_bytes = charged_bytes - 4 - 4 - 8 - 4 - 8;
        assert_eq!(string_escape_overhead(capture.data), 28);
        let raw = RawValue::from_string(original.get().replacen(
            &format!(r#""bytes":{charged_bytes}"#),
            &format!(r#""bytes":{renderer_bytes}"#),
            1,
        ))
        .unwrap();
        let wrapper_bytes = frame_bytes(&raw) - data_bytes;
        let exact = SnapshotReplyAdmission::new(charged_bytes, wrapper_bytes).unwrap();
        let SnapshotReply::Captured(captured) =
            decode_snapshot_reply(&raw, frame_bytes(&raw), exact).unwrap()
        else {
            panic!("expected DATA")
        };
        assert_eq!(captured.data.bytes, capture.data.get().as_bytes());
        assert_eq!(captured.data.decoded_length, data_bytes);
        assert_eq!(captured.counters.bytes, renderer_bytes);
        for limited_admission in [
            SnapshotReplyAdmission::new(charged_bytes - 1, wrapper_bytes).unwrap(),
            SnapshotReplyAdmission::new(charged_bytes, wrapper_bytes - 1).unwrap(),
            SnapshotReplyAdmission::new(renderer_bytes, wrapper_bytes).unwrap(),
        ] {
            assert_eq!(
                decode_snapshot_reply(&raw, frame_bytes(&raw), limited_admission)
                    .unwrap_err()
                    .code,
                ErrorCode::ResourceLimit
            );
        }
        let undercount = RawValue::from_string(raw.get().replacen(
            &format!(r#""bytes":{renderer_bytes}"#),
            &format!(r#""bytes":{}"#, renderer_bytes - 1),
            1,
        ))
        .unwrap();
        assert_eq!(
            decode_snapshot_reply(&undercount, frame_bytes(&undercount), exact)
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
    }

    #[test]
    fn data_wrapper_and_alias_growth_have_independent_exact_boundaries() {
        for (overrides, count) in [
            ("[]", 0),
            (
                r#"[{"url":"https://example.test/style.css","content":"p{}","contentType":"text/css"}]"#,
                1,
            ),
        ] {
            let raw = fixture(r#"["HTML",{}]"#, overrides, count);
            let SnapshotReply::Captured(captured) =
                decode_snapshot_reply(&raw, frame_bytes(&raw), admission()).unwrap()
            else {
                panic!("expected DATA")
            };
            let data_bytes = captured.data.decoded_length + count * 256;
            let wrapper_bytes = frame_bytes(&raw) - captured.data.decoded_length;
            assert!(
                decode_snapshot_reply(
                    &raw,
                    frame_bytes(&raw),
                    SnapshotReplyAdmission::new(data_bytes, wrapper_bytes).unwrap()
                )
                .is_ok()
            );
            for limited_admission in [
                SnapshotReplyAdmission::new(data_bytes - 1, wrapper_bytes).unwrap(),
                SnapshotReplyAdmission::new(data_bytes, wrapper_bytes - 1).unwrap(),
            ] {
                assert_eq!(
                    decode_snapshot_reply(&raw, frame_bytes(&raw), limited_admission)
                        .unwrap_err()
                        .code,
                    ErrorCode::ResourceLimit
                );
            }
        }
        assert!(
            SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES + 1, MAXIMUM_WRAPPER_BYTES).is_err()
        );
        assert!(
            SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES, MAXIMUM_WRAPPER_BYTES + 1).is_err()
        );
    }

    #[test]
    fn exception_envelopes_cannot_borrow_the_data_allowance() {
        let raw = RawValue::from_string(r#"{"result":{"type":"object","subtype":"error","objectId":"exception"},"exceptionDetails":{"text":"Uncaught","exception":{"description":"SnapshotUnsupported: fixture"}}}"#.into()).unwrap();
        let exact = SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES, frame_bytes(&raw)).unwrap();
        let SnapshotReply::Exception(details) =
            decode_snapshot_reply(&raw, frame_bytes(&raw), exact).unwrap()
        else {
            panic!("expected exception")
        };
        assert!(details.get().contains("SnapshotUnsupported"));
        let smaller =
            SnapshotReplyAdmission::new(MAXIMUM_DATA_BYTES, frame_bytes(&raw) - 1).unwrap();
        assert_eq!(
            decode_snapshot_reply(&raw, frame_bytes(&raw), smaller)
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(
            decode_snapshot_reply(&raw, raw.get().len() - 1, admission())
                .unwrap_err()
                .code,
            ErrorCode::Protocol
        );
    }

    #[test]
    fn invalid_identities_shapes_and_reported_cache_limits_are_rejected() {
        let valid = fixture(r#"["HTML",{}]"#, "[]", 0);
        for (from, to) in [
            (
                r#""snapshotNumber":1"#,
                r#""snapshotNumber":1,"snapshotNumber":2"#,
            ),
            (r#""snapshotNumber":1"#, r#""snapshotNumber":0"#),
            (r#""token":"capture-1""#, r#""token":"""#),
            (r#""token":"capture-1""#, r#""token":"\ud800""#),
            (r#""type":"object""#, r#""type":"string""#),
            (r#""width":1280"#, r#""width":-1"#),
            (r#""wallTime":1"#, r#""wallTime":1e9999"#),
            (r#""nodes":0"#, r#""nodes":12501"#),
            (r#""overrideCount":0"#, r#""overrideCount":1"#),
        ] {
            let raw = RawValue::from_string(valid.get().replacen(from, to, 1)).unwrap();
            assert!(
                decode_snapshot_reply(&raw, frame_bytes(&raw), admission()).is_err(),
                "{to}"
            );
        }
    }

    #[test]
    fn structure_limits_count_without_allocating_a_json_tree() {
        for depth in [MAXIMUM_JSON_DEPTH, MAXIMUM_JSON_DEPTH + 1] {
            let raw = RawValue::from_string(format!("{}0{}", "[".repeat(depth), "]".repeat(depth)))
                .unwrap();
            assert_eq!(
                validate_structure(&raw).is_ok(),
                depth == MAXIMUM_JSON_DEPTH
            );
        }
        for elements in [MAXIMUM_JSON_VALUES - 1, MAXIMUM_JSON_VALUES] {
            let raw = RawValue::from_string(format!("[{}0]", "0,".repeat(elements - 1))).unwrap();
            assert_eq!(
                validate_structure(&raw).is_ok(),
                elements == MAXIMUM_JSON_VALUES - 1
            );
        }
        let raw =
            RawValue::from_string(r#"[{"\"[":"\\\"}"},true,false,null,-1.23e4]"#.into()).unwrap();
        assert!(validate_structure(&raw).is_ok());
    }

    #[test]
    fn stylesheet_admission_stops_at_the_first_excess_entry() {
        let entry =
            r#"{"url":"https://example.test/","content":"\ud800","contentType":"text/css"}"#;
        for count in [1024, 1025] {
            let raw = RawValue::from_string(format!("[{}]", vec![entry; count].join(","))).unwrap();
            match count_overrides(&raw) {
                Ok(actual) => assert_eq!((actual, count), (1024, 1024)),
                Err(error) => {
                    assert_eq!(count, 1025);
                    assert_eq!(error.code, ErrorCode::ResourceLimit);
                }
            }
        }
        let invalid =
            RawValue::from_string(format!("[{}]", entry.replace("text/css", "text/html"))).unwrap();
        assert_eq!(
            count_overrides(&invalid).unwrap_err().code,
            ErrorCode::Protocol
        );
    }

    /// Keep captured surrogate escapes while removing report-only indentation, without a Value tree.
    fn compact_json(source: &str) -> String {
        let mut output = Vec::with_capacity(source.len());
        let mut in_string = false;
        let mut escaped = false;
        for byte in source.bytes() {
            if in_string || !byte.is_ascii_whitespace() {
                output.push(byte);
            }
            if in_string {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    in_string = false;
                }
            } else if byte == b'"' {
                in_string = true;
            }
        }
        String::from_utf8(output).unwrap()
    }

    #[test]
    #[ignore = "requires an explicit report directory from probe-snapshot-cdp-reply.mjs"]
    fn captured_direct_cdp_replies_preserve_native_shape_and_boundaries() {
        #[derive(Deserialize)]
        struct Report<'message> {
            #[serde(borrow)]
            cases: Vec<Case<'message>>,
        }
        #[derive(Deserialize)]
        struct Case<'message> {
            label: String,
            accepted: bool,
            #[serde(borrow)]
            reply: &'message RawValue,
        }
        let directory = std::env::var("FLASHWRIGHT_SNAPSHOT_REPLY_FIXTURE_DIRECTORY")
            .expect("explicit captured report directory");
        let source =
            std::fs::read_to_string(std::path::Path::new(&directory).join("report.json")).unwrap();
        let report: Report<'_> = serde_json::from_str(&source).unwrap();
        assert_eq!(report.cases.len(), 7);
        for case in report.cases {
            let raw = RawValue::from_string(compact_json(case.reply.get())).unwrap();
            let result = decode_snapshot_reply(&raw, frame_bytes(&raw), admission()).unwrap();
            assert_eq!(
                matches!(result, SnapshotReply::Captured(_)),
                case.accepted,
                "{}",
                case.label
            );
        }
    }
}
