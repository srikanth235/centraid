//! AWS SIGNATURE VERSION 4, AND THE ONE MODULE UNDER THIS CRATE THAT NAMES
//! SHA-256 (#1025 S4, D-1025-S4-5; W0.5-R1; #1029 §3).
//!
//! This is the same carve-out `crates/gateway-core/src/checksum.rs` carries and
//! the same boundary. Everything Centraid defines for itself stays BLAKE3: an
//! object's **name** is the BLAKE3-256 of its ciphertext, a request body digest
//! is BLAKE3, the scrub re-hashes with BLAKE3. What is here is **somebody
//! else's protocol**: SigV4 is defined as an HMAC-SHA256 chain over a canonical
//! request whose payload is identified by its SHA-256, and a signature restated
//! in BLAKE3 would not open an S3 bucket — it would be a different protocol
//! that no store implements.
//!
//! `crates/vault/tests/one_hash.rs`'s allowlist carries this file with that
//! reason. The boundary is the point: no other file in
//! `crates/gateway-server` names that function, and the S3 store beside this
//! one calls in here for a signature and nothing else.
//!
//! # What is signed, and what is not
//!
//! The signature covers the method, the canonical URI and query, a fixed set of
//! headers, and the payload digest. **The payload digest of a proxied upload is
//! computed over bytes the gateway is streaming through**, which is the one
//! place this server touches an object's bytes at all — and they are ciphertext
//! it cannot open, exactly as they are on the way past.

use hmac::{Hmac, KeyInit as _, Mac as _};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// The algorithm token SigV4 names itself by, in a header and in a query.
///
/// Spelled here and nowhere else in this crate, for the same reason as the two
/// header names below: the boundary the module docs describe is one file.
pub const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// The header every S3-compatible store carries the payload digest in.
///
/// Spelled here and nowhere else in this crate, so the boundary the module docs
/// describe is one file rather than a habit.
pub const CONTENT_DIGEST_HEADER: &str = "x-amz-content-sha256";

/// The header a store **attests** an object's checksum in, and the reason
/// `ChecksumMode::Attest` exists at all.
///
/// R2 and S3 record it only when the client sent it, and B2 and MinIO differ on
/// whether they will compute it themselves — which is precisely why
/// `ChecksumMode::ReadAndHash` is the other half of the rule rather than a
/// fallback this file could choose on its own.
pub const CHECKSUM_HEADER: &str = "x-amz-checksum-sha256";

/// What a request is signed against.
#[derive(Debug, Clone)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// `us-east-1` for most S3-compatible stores that have no regions.
    pub region: String,
}

/// One request to sign.
#[derive(Debug, Clone)]
pub struct CanonicalRequest<'a> {
    /// Uppercase.
    pub method: &'a str,
    /// Percent-encoded, beginning with `/`.
    pub uri: &'a str,
    /// Canonical query string, already sorted. Empty for none.
    pub query: &'a str,
    /// `(lowercase name, value)`, already sorted by name.
    pub headers: &'a [(String, String)],
    /// Lowercase hex of the payload digest, or `UNSIGNED-PAYLOAD`.
    pub payload_digest: &'a str,
    /// `YYYYMMDDTHHMMSSZ`.
    pub timestamp: &'a str,
}

/// The lowercase hex digest an S3 store identifies a payload by.
///
/// Somebody else's protocol; see the module docs.
#[must_use]
pub fn payload_digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The digest of an empty body, which every body-less S3 request carries.
#[must_use]
pub fn empty_payload_digest() -> String {
    payload_digest(&[])
}

/// The `YYYYMMDD` half of a credential scope.
#[must_use]
pub fn scope_date(timestamp: &str) -> &str {
    timestamp.get(..8).unwrap_or(timestamp)
}

/// `Authorization` header value for one request.
///
/// The four-step derivation is RFC-shaped and is written out rather than folded
/// into a loop, because each step's input is a different thing and a reader
/// checking this against the specification reads it line by line.
#[must_use]
pub fn authorization(request: &CanonicalRequest<'_>, credentials: &Credentials) -> String {
    let signed_headers: Vec<&str> = request
        .headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    let signed_headers = signed_headers.join(";");

    let mut canonical = String::new();
    canonical.push_str(request.method);
    canonical.push('\n');
    canonical.push_str(request.uri);
    canonical.push('\n');
    canonical.push_str(request.query);
    canonical.push('\n');
    for (name, value) in request.headers {
        canonical.push_str(name);
        canonical.push(':');
        canonical.push_str(value.trim());
        canonical.push('\n');
    }
    canonical.push('\n');
    canonical.push_str(&signed_headers);
    canonical.push('\n');
    canonical.push_str(request.payload_digest);

    let date = scope_date(request.timestamp);
    let scope = format!("{date}/{}/{SERVICE}/aws4_request", credentials.region);
    let to_sign = format!(
        "{ALGORITHM}\n{}\n{scope}\n{}",
        request.timestamp,
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );

    let signature = hex::encode(sign(
        &signing_key(credentials, date, SERVICE),
        to_sign.as_bytes(),
    ));
    format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        credentials.access_key_id
    )
}

/// The `X-Amz-Signature` for a presigned URL.
///
/// Query-string signing, which is what a presigned `PUT` is. The payload is
/// `UNSIGNED-PAYLOAD`, because the phone has not sent the bytes yet and the
/// store is the party that will see them.
#[must_use]
pub fn presigned_signature(request: &CanonicalRequest<'_>, credentials: &Credentials) -> String {
    let signed_headers: Vec<&str> = request
        .headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    let signed_headers = signed_headers.join(";");

    let mut canonical = String::new();
    canonical.push_str(request.method);
    canonical.push('\n');
    canonical.push_str(request.uri);
    canonical.push('\n');
    canonical.push_str(request.query);
    canonical.push('\n');
    for (name, value) in request.headers {
        canonical.push_str(name);
        canonical.push(':');
        canonical.push_str(value.trim());
        canonical.push('\n');
    }
    canonical.push('\n');
    canonical.push_str(&signed_headers);
    canonical.push('\n');
    canonical.push_str(request.payload_digest);

    let date = scope_date(request.timestamp);
    let scope = format!("{date}/{}/{SERVICE}/aws4_request", credentials.region);
    let to_sign = format!(
        "{ALGORITHM}\n{}\n{scope}\n{}",
        request.timestamp,
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    hex::encode(sign(
        &signing_key(credentials, date, SERVICE),
        to_sign.as_bytes(),
    ))
}

/// The service a bucket's signatures are scoped to. Always `s3` here; the
/// parameter below exists so the chain can be pinned against AWS's own
/// published example, which is written for `iam`.
const SERVICE: &str = "s3";

/// The four-step derivation. `service` is a parameter only so that
/// [`tests::the_signing_key_is_the_four_step_chain`] can check it against a
/// published vector rather than against a value this file made up.
fn signing_key(credentials: &Credentials, date: &str, service: &str) -> Vec<u8> {
    let initial = format!("AWS4{}", credentials.secret_access_key);
    let by_date = sign(initial.as_bytes(), date.as_bytes());
    let by_region = sign(&by_date, credentials.region.as_bytes());
    let by_service = sign(&by_region, service.as_bytes());
    sign(&by_service, b"aws4_request")
}

fn sign(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

/// Percent-encode one path segment the way S3 canonicalisation requires.
///
/// The unreserved set is RFC 3986's, and `/` is **not** escaped in a URI path.
/// An object key here is hex and a separator (`crate::bytes::object_key`), so
/// nothing in practice needs escaping — this exists so that a future key shape
/// does not silently sign one string and send another.
#[must_use]
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> Credentials {
        Credentials {
            access_key_id: "AKIDEXAMPLE".to_owned(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_owned(),
            region: "us-east-1".to_owned(),
        }
    }

    /// RFC 4231's own HMAC-SHA256 test case 2, which pins the primitive this
    /// whole derivation is a chain of. A signature that is wrong here is wrong
    /// against every store, and the symptom is a 403 nobody can read.
    #[test]
    fn the_mac_matches_rfc_4231_case_two() {
        assert_eq!(
            hex::encode(sign(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// AWS's own worked example of the Signature Version 4 signing process
    /// publishes this signing key for `20150830`, `us-east-1`, `iam`. It is
    /// **their** number and not one this file produced, which is the only kind
    /// of vector worth having: the four-step chain is what every signature
    /// hangs off, and a chain that is subtly wrong fails against every store
    /// with a message that says only "signature mismatch".
    #[test]
    fn the_signing_key_is_the_four_step_chain() {
        let key = signing_key(&credentials(), "20150830", "iam");
        assert_eq!(
            hex::encode(&key),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }

    /// The digest of an empty body is the constant every body-less S3 request
    /// sends, and getting it wrong fails every `GET` and `HEAD` at once.
    #[test]
    fn the_empty_payload_digest_is_the_constant_stores_expect() {
        assert_eq!(
            empty_payload_digest(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// An `Authorization` header names the credential, the signed headers and
    /// a 64-hex signature, in that order — the shape every store parses.
    #[test]
    fn an_authorization_header_carries_the_scope_and_a_signature() {
        let headers = vec![
            ("host".to_owned(), "store.example.org".to_owned()),
            ("x-amz-date".to_owned(), "20150830T123600Z".to_owned()),
        ];
        let header = authorization(
            &CanonicalRequest {
                method: "PUT",
                uri: "/bucket/aa/bb",
                query: "",
                headers: &headers,
                payload_digest: &empty_payload_digest(),
                timestamp: "20150830T123600Z",
            },
            &credentials(),
        );
        assert!(header.starts_with(&format!(
            "{ALGORITHM} Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request"
        )));
        assert!(header.contains("SignedHeaders=host;x-amz-date"));
        let signature = header.rsplit("Signature=").next().expect("a signature");
        assert_eq!(signature.len(), 64, "{header}");
        assert!(signature.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// Two different requests must not sign the same, or the signature is
    /// covering nothing.
    #[test]
    fn changing_the_uri_changes_the_signature() {
        let headers = vec![("host".to_owned(), "store.example.org".to_owned())];
        let one = CanonicalRequest {
            method: "PUT",
            uri: "/bucket/aa",
            query: "",
            headers: &headers,
            payload_digest: &empty_payload_digest(),
            timestamp: "20150830T123600Z",
        };
        let two = CanonicalRequest {
            uri: "/bucket/bb",
            ..one.clone()
        };
        assert_ne!(
            authorization(&one, &credentials()),
            authorization(&two, &credentials())
        );
    }

    #[test]
    fn a_hex_object_key_needs_no_escaping_and_a_space_does() {
        assert_eq!(encode_path("/aa/bb"), "/aa/bb");
        assert_eq!(encode_path("/a b"), "/a%20b");
    }
}
