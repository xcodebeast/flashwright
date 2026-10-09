use rustls::pki_types::SubjectPublicKeyInfoDer;
use rustls::{CertificateError, Error};

const SEQUENCE: u8 = 0x30;
const INTEGER: u8 = 0x02;
const BIT_STRING: u8 = 0x03;
const EXPLICIT_VERSION: u8 = 0xa0;

/// Borrows the original SPKI encoding without validating certificate trust.
///
/// This fixed-depth traversal validates certificate field boundaries and order.
/// Names, algorithms and extensions remain opaque; the TLS signature verifier
/// validates the extracted algorithm and key before accepting proof of possession.
pub(super) fn subject_public_key_info(
    certificate: &[u8],
) -> Result<SubjectPublicKeyInfoDer<'_>, Error> {
    let mut document = DerReader::new(certificate);
    let certificate_sequence = document.read(SEQUENCE)?;
    document.finish()?;

    let mut certificate_fields = DerReader::new(certificate_sequence.contents);
    let signed_certificate = certificate_fields.read(SEQUENCE)?;
    certificate_fields.read(SEQUENCE)?;
    validate_bit_string(certificate_fields.read(BIT_STRING)?.contents)?;
    certificate_fields.finish()?;

    let mut signed_fields = DerReader::new(signed_certificate.contents);
    let version = if signed_fields.next_tag() == Some(EXPLICIT_VERSION) {
        let explicit_version = signed_fields.read(EXPLICIT_VERSION)?;
        let mut version_fields = DerReader::new(explicit_version.contents);
        let version_integer = version_fields.read(INTEGER)?;
        version_fields.finish()?;
        match version_integer.contents {
            [1] => 1,
            [2] => 2,
            // DER omits the DEFAULT v1 value rather than encoding it explicitly.
            _ => return Err(bad_encoding()),
        }
    } else {
        0
    };

    let serial_number = signed_fields.read(INTEGER)?;
    validate_integer(serial_number.contents)?;
    signed_fields.read(SEQUENCE)?; // Signature algorithm.
    signed_fields.read(SEQUENCE)?; // Issuer name.
    signed_fields.read(SEQUENCE)?; // Validity.
    signed_fields.read(SEQUENCE)?; // Subject name.
    let public_key = signed_fields.read(SEQUENCE)?;

    let mut public_key_fields = DerReader::new(public_key.contents);
    public_key_fields.read(SEQUENCE)?;
    validate_bit_string(public_key_fields.read(BIT_STRING)?.contents)?;
    public_key_fields.finish()?;

    if signed_fields.next_tag() == Some(0x81) {
        if version == 0 {
            return Err(bad_encoding());
        }
        validate_bit_string(signed_fields.read(0x81)?.contents)?;
    }
    if signed_fields.next_tag() == Some(0x82) {
        if version == 0 {
            return Err(bad_encoding());
        }
        validate_bit_string(signed_fields.read(0x82)?.contents)?;
    }
    if signed_fields.next_tag() == Some(0xa3) {
        if version != 2 {
            return Err(bad_encoding());
        }
        let extensions = signed_fields.read(0xa3)?;
        let mut extension_fields = DerReader::new(extensions.contents);
        extension_fields.read(SEQUENCE)?;
        extension_fields.finish()?;
    }
    signed_fields.finish()?;

    Ok(SubjectPublicKeyInfoDer::from(public_key.encoded))
}

struct DerElement<'certificate> {
    encoded: &'certificate [u8],
    contents: &'certificate [u8],
}

struct DerReader<'certificate> {
    remaining: &'certificate [u8],
}

impl<'certificate> DerReader<'certificate> {
    fn new(encoded: &'certificate [u8]) -> Self {
        Self { remaining: encoded }
    }

    fn next_tag(&self) -> Option<u8> {
        self.remaining.first().copied()
    }

    /// Reads one expected element, rejecting indefinite and noncanonical lengths.
    fn read(&mut self, expected_tag: u8) -> Result<DerElement<'certificate>, Error> {
        let encoded = self.remaining;
        let [tag, first_length, rest @ ..] = encoded else {
            return Err(bad_encoding());
        };
        if *tag != expected_tag {
            return Err(bad_encoding());
        }

        let (contents_length, contents) = if first_length & 0x80 == 0 {
            (usize::from(*first_length), rest)
        } else {
            let length_octets = usize::from(first_length & 0x7f);
            if length_octets == 0 || length_octets > size_of::<usize>() {
                return Err(bad_encoding());
            }
            let length_bytes = rest.get(..length_octets).ok_or_else(bad_encoding)?;
            if length_bytes[0] == 0 {
                return Err(bad_encoding());
            }
            let mut contents_length = 0_usize;
            for length_byte in length_bytes {
                contents_length = contents_length
                    .checked_mul(256)
                    .and_then(|length| length.checked_add(usize::from(*length_byte)))
                    .ok_or_else(bad_encoding)?;
            }
            if contents_length < 128 {
                return Err(bad_encoding());
            }
            (contents_length, &rest[length_octets..])
        };

        let element_contents = contents.get(..contents_length).ok_or_else(bad_encoding)?;
        let trailing = &contents[contents_length..];
        let encoded_length = encoded.len() - trailing.len();
        self.remaining = trailing;
        Ok(DerElement {
            encoded: &encoded[..encoded_length],
            contents: element_contents,
        })
    }

    fn finish(self) -> Result<(), Error> {
        if self.remaining.is_empty() {
            Ok(())
        } else {
            Err(bad_encoding())
        }
    }
}

fn validate_integer(contents: &[u8]) -> Result<(), Error> {
    match contents {
        [] => Err(bad_encoding()),
        [0, second, ..] if second & 0x80 == 0 => Err(bad_encoding()),
        [0xff, second, ..] if second & 0x80 != 0 => Err(bad_encoding()),
        _ => Ok(()),
    }
}

fn validate_bit_string(contents: &[u8]) -> Result<(), Error> {
    let Some((&unused_bits, bytes)) = contents.split_first() else {
        return Err(bad_encoding());
    };
    if unused_bits > 7 {
        return Err(bad_encoding());
    }
    let final_byte = bytes.last().copied().unwrap_or(0);
    if (bytes.is_empty() && unused_bits != 0) || final_byte & ((1_u8 << unused_bits) - 1) != 0 {
        return Err(bad_encoding());
    }
    Ok(())
}

fn bad_encoding() -> Error {
    Error::InvalidCertificate(CertificateError::BadEncoding)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(tag: u8, contents: &[u8]) -> Vec<u8> {
        let mut encoded = vec![tag];
        if contents.len() < 128 {
            encoded.push(contents.len() as u8);
        } else {
            let length = contents.len().to_be_bytes();
            let first_nonzero = length.iter().position(|byte| *byte != 0).unwrap();
            let length_bytes = &length[first_nonzero..];
            encoded.push(0x80 | length_bytes.len() as u8);
            encoded.extend_from_slice(length_bytes);
        }
        encoded.extend_from_slice(contents);
        encoded
    }

    fn public_key() -> Vec<u8> {
        element(SEQUENCE, &[0x30, 0, 0x03, 3, 0, 0xa5, 0x5a])
    }

    fn signed_fields(version: Option<u8>) -> Vec<u8> {
        let mut fields = Vec::new();
        if let Some(version) = version {
            fields.extend(element(EXPLICIT_VERSION, &[INTEGER, 1, version]));
        }
        fields.extend([INTEGER, 1, 1]);
        for _ in 0..4 {
            fields.extend([SEQUENCE, 0]);
        }
        fields.extend(public_key());
        fields
    }

    fn certificate(fields: &[u8]) -> Vec<u8> {
        let mut contents = element(SEQUENCE, fields);
        contents.extend([SEQUENCE, 0, BIT_STRING, 2, 0, 0x01]);
        element(SEQUENCE, &contents)
    }

    fn assert_bad_encoding(encoded: &[u8]) {
        assert_eq!(
            subject_public_key_info(encoded).unwrap_err(),
            bad_encoding()
        );
    }

    #[test]
    fn supports_omitted_v1_and_explicit_v2_v3_versions() {
        for version in [None, Some(1), Some(2)] {
            let encoded = certificate(&signed_fields(version));
            assert_eq!(
                subject_public_key_info(&encoded).unwrap().as_ref(),
                public_key()
            );
        }
    }

    #[test]
    fn borrows_the_exact_original_element() {
        let encoded = certificate(&signed_fields(Some(2)));
        let expected = public_key();
        let offset = encoded
            .windows(expected.len())
            .position(|bytes| bytes == expected)
            .unwrap();
        let extracted = subject_public_key_info(&encoded).unwrap();
        assert_eq!(extracted.as_ref().as_ptr(), encoded[offset..].as_ptr());
        assert_eq!(extracted.as_ref().len(), expected.len());
    }

    #[test]
    fn borrows_from_large_certificates_without_copying() {
        let mut fields = signed_fields(Some(2));
        let mut extension_contents = vec![0x06, 2, 0x2a, 3];
        extension_contents.extend(element(0x04, &vec![0; 1_048_576]));
        let extension = element(SEQUENCE, &extension_contents);
        let extensions = element(0xa3, &element(SEQUENCE, &extension));
        fields.extend(extensions);
        let encoded = certificate(&fields);
        let extracted = subject_public_key_info(&encoded).unwrap();
        let expected = public_key();
        let offset = encoded
            .windows(expected.len())
            .position(|bytes| bytes == expected)
            .unwrap();
        assert_eq!(extracted.as_ref().as_ptr(), encoded[offset..].as_ptr());
    }

    #[test]
    fn rejects_every_truncated_certificate_prefix() {
        let encoded = certificate(&signed_fields(Some(2)));
        for end in 0..encoded.len() {
            assert_bad_encoding(&encoded[..end]);
        }
    }

    #[test]
    fn rejects_indefinite_nonminimal_and_overflowing_lengths() {
        for encoded in [
            vec![SEQUENCE, 0x80, 0, 0],
            vec![SEQUENCE, 0x81, 0],
            vec![SEQUENCE, 0x82, 0, 128],
            vec![SEQUENCE, 0x82, 1],
            vec![SEQUENCE, 0x89, 1, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![
                SEQUENCE, 0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            ],
        ] {
            assert_bad_encoding(&encoded);
        }
    }

    #[test]
    fn rejects_wrong_tags_and_crossing_enclosing_bounds() {
        let encoded = certificate(&signed_fields(None));
        for offset in [0, 2, 4, 7, 9, 11, 13, 15, 17, 19, 24, 26] {
            let mut malformed = encoded.clone();
            malformed[offset] = 0x04;
            assert_bad_encoding(&malformed);
        }
        let mut fields = signed_fields(None);
        fields[4] = 127;
        assert_bad_encoding(&certificate(&fields));
    }

    #[test]
    fn rejects_trailing_fields_at_each_structure_boundary() {
        let fields = signed_fields(None);
        let mut encoded = certificate(&fields);
        encoded.extend([0x05, 0]);
        assert_bad_encoding(&encoded);

        let mut trailing_signed_fields = fields.clone();
        trailing_signed_fields.extend([0x05, 0]);
        assert_bad_encoding(&certificate(&trailing_signed_fields));

        let mut certificate_contents = element(SEQUENCE, &fields);
        certificate_contents.extend([SEQUENCE, 0, BIT_STRING, 2, 0, 1, 0x05, 0]);
        assert_bad_encoding(&element(SEQUENCE, &certificate_contents));

        let mut trailing_key_fields = fields[..fields.len() - public_key().len()].to_vec();
        trailing_key_fields.extend(element(SEQUENCE, &[SEQUENCE, 0, BIT_STRING, 1, 0, 0x05, 0]));
        assert_bad_encoding(&certificate(&trailing_key_fields));
    }

    #[test]
    fn validates_version_and_optional_field_order() {
        for version in [0, 3, 255] {
            assert_bad_encoding(&certificate(&signed_fields(Some(version))));
        }
        for version_contents in [
            vec![INTEGER, 1, 2, INTEGER, 1, 2],
            vec![0x04, 1, 2],
            vec![INTEGER, 2, 0, 2],
        ] {
            let mut fields = element(EXPLICIT_VERSION, &version_contents);
            fields.extend(signed_fields(None));
            assert_bad_encoding(&certificate(&fields));
        }
        for version in [None, Some(1), Some(2)] {
            let mut fields = signed_fields(version);
            fields.extend([0x81, 2, 0, 1, 0x82, 2, 0, 2]);
            if version.is_some() {
                assert!(subject_public_key_info(&certificate(&fields)).is_ok());
            } else {
                assert_bad_encoding(&certificate(&fields));
            }
        }
        for optional in [
            vec![0x81, 1, 0, 0x81, 1, 0],
            vec![0x82, 1, 0, 0x81, 1, 0],
            vec![0xa3, 2, SEQUENCE, 0, 0x82, 1, 0],
            vec![0xa3, 4, SEQUENCE, 0, SEQUENCE, 0],
            vec![0xa3, 2, 0x04, 0],
        ] {
            let mut fields = signed_fields(Some(2));
            fields.extend(optional);
            assert_bad_encoding(&certificate(&fields));
        }
        let mut fields = signed_fields(Some(1));
        fields.extend([0xa3, 2, SEQUENCE, 0]);
        assert_bad_encoding(&certificate(&fields));
    }

    #[test]
    fn rejects_malformed_integer_and_bit_string_contents() {
        for contents in [vec![], vec![0, 1], vec![0xff, 0x80]] {
            let mut fields = element(INTEGER, &contents);
            fields.extend_from_slice(&signed_fields(None)[3..]);
            assert_bad_encoding(&certificate(&fields));
        }
        for contents in [vec![], vec![8, 0], vec![1], vec![1, 1]] {
            let fields = signed_fields(None);
            let mut malformed = fields[..fields.len() - public_key().len()].to_vec();
            let mut key_contents = vec![SEQUENCE, 0];
            key_contents.extend(element(BIT_STRING, &contents));
            malformed.extend(element(SEQUENCE, &key_contents));
            assert_bad_encoding(&certificate(&malformed));
        }
    }
}
