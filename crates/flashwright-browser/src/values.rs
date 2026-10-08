//! Lossless Chromium string fields, including JavaScript's unpaired UTF-16 surrogates.

use serde::de::{Error, Visitor};
use serde::{Deserialize, Deserializer};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Utf16String(pub Vec<u16>);

impl<'de> Deserialize<'de> for Utf16String {
    fn deserialize<Decoder: Deserializer<'de>>(decoder: Decoder) -> Result<Self, Decoder::Error> {
        struct StringVisitor;
        impl Visitor<'_> for StringVisitor {
            type Value = Utf16String;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON string preserving UTF-16 code units")
            }

            fn visit_bytes<Failure: Error>(self, mut bytes: &[u8]) -> Result<Self::Value, Failure> {
                // serde_json's byte-string visitor decodes escapes to WTF-8, retaining
                // lone surrogates. Convert only those extra code points explicitly.
                let mut units = Vec::new();
                loop {
                    match std::str::from_utf8(bytes) {
                        Ok(text) => {
                            units.extend(text.encode_utf16());
                            return Ok(Utf16String(units));
                        }
                        Err(error) => {
                            let prefix = &bytes[..error.valid_up_to()];
                            units.extend(
                                std::str::from_utf8(prefix)
                                    .expect("the UTF-8 validator identified a valid prefix")
                                    .encode_utf16(),
                            );
                            bytes = &bytes[error.valid_up_to()..];
                            if bytes.len() < 3
                                || bytes[0] != 0xed
                                || !(0xa0..=0xbf).contains(&bytes[1])
                                || !(0x80..=0xbf).contains(&bytes[2])
                            {
                                return Err(Failure::custom("invalid browser string encoding"));
                            }
                            units.push(
                                0xd000
                                    | (u16::from(bytes[1] & 0x3f) << 6)
                                    | u16::from(bytes[2] & 0x3f),
                            );
                            bytes = &bytes[3..];
                        }
                    }
                }
            }
        }
        decoder.deserialize_bytes(StringVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_utf16_unit_survives_a_json_escape() {
        for unit in 0..=u16::MAX {
            let encoded = format!("\"\\u{unit:04x}\"");
            let decoded: Utf16String = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded.0, [unit], "{encoded}");
        }
    }

    #[test]
    fn mixed_scalars_escapes_and_unpaired_surrogates_keep_their_order() {
        let decoded: Utf16String = serde_json::from_str(
            r#""é😃\ud800X\udfff\ud83d\ude03\ud800\ud800\u0000\"\\\/\b\f\n\r\t""#,
        )
        .unwrap();
        let mut expected: Vec<_> = "é😃".encode_utf16().collect();
        expected.extend([
            0xd800, 88, 0xdfff, 0xd83d, 0xde03, 0xd800, 0xd800, 0, 34, 92, 47, 8, 12, 10, 13, 9,
        ]);
        assert_eq!(decoded.0, expected);
        for invalid in ["null", "42", "[1]", r#""\uZZZZ""#, r#""\x00""#] {
            assert!(serde_json::from_str::<Utf16String>(invalid).is_err());
        }
        assert!(serde_json::from_slice::<Utf16String>(b"\"\xff\"").is_err());
    }
}
