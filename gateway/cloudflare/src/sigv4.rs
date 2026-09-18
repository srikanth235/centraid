//! PRESIGNING AN R2 URL, AND THE ONE MODULE IN THIS CRATE THAT NAMES SHA-256.
//!
//! # Why a Worker has to sign at all
//!
//! The R2 **binding** (`env.bucket("OBJECTS")`) can `put`, `get`, `head` and
//! `delete`, and it cannot presign: presigning is an S3-API notion and the
//! binding is not the S3 API. But §3 says *bytes never pass through gateway
//! code on the hosted adapter* — a phone `PUT`s straight to R2 through a
//! background `URLSession` — so a URL a phone can use has to be produced, and
//! producing one means signing it here.
//!
//! So this crate speaks **both**: the binding for `evidence`, `read` and
//! `purge`, which are the gateway's own reads, and a presigned S3 URL for the
//! transfer the phone makes. `r2.rs` is where that split is drawn.
//!
//! # The carve-out
//!
//! AWS Signature Version 4 is HMAC-SHA256 over a SHA-256 payload digest. A
//! signature restated in BLAKE3 opens no bucket: it is somebody else's
//! protocol, the same carve-out `crates/gateway-core/src/checksum.rs` and
//! `crates/gateway-server/src/bytes/sigv4.rs` already hold, and it is confined
//! to this one file with its own allowlist entry in
//! `crates/vault/tests/one_hash.rs`. Everything Centraid defines for itself —
//! every object name, every commitment — stays BLAKE3.
//!
//! # WHAT THIS IS NOT
//!
//! It is not a second copy of `gateway-server`'s SigV4 client. That one signs
//! *headers* for requests the server itself makes and streams bodies through
//! `reqwest`; this signs a *query string* for a request the server never makes,
//! and has no client in it at all. They overlap in the string-to-sign and the
//! signing key, and that overlap is real duplication — see this crate's README,
//! which recommends extracting it and says why that was not done in this lane.
//!
//! # UNSIGNED-PAYLOAD IS CORRECT HERE AND IS NOT A WEAKENING
//!
//! A presigned `PUT` names `UNSIGNED-PAYLOAD` because the signer does not have
//! the bytes: the phone does. The integrity of those bytes is **not** what this
//! signature is for — `gateway-core`'s checksum rule is, at commit, from the
//! store's own attestation. What the signature bounds is *who may write* and
//! *for how long*, and the name it may write to is inside the signed path.

use hmac::{Hmac, KeyInit as _, Mac as _};
use sha2::{Digest as _, Sha256};

/// The algorithm token, as SigV4 spells it.
pub const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// What a presigned request names as its payload when the signer does not hold
/// the bytes. See the module docs.
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// The longest a presigned URL may live, in seconds.
///
/// SigV4's own ceiling is 7 days and this takes all of it, because the bound
/// that matters is not a security margin but a **phone**: an iOS background
/// `URLSession` transfer can be deferred for days on a metered connection, and
/// a target that expired underneath it is an upload that fails at the end and
/// is retried from the beginning.
pub const MAX_EXPIRY_SECONDS: u32 = 7 * 24 * 60 * 60;

/// An R2 account's S3 credentials.
#[derive(Debug, Clone)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// R2's region token. `auto` for every R2 bucket; it is a parameter because
    /// the string is part of the signature and not because it varies.
    pub region: String,
}

/// What is being presigned.
#[derive(Debug, Clone, Copy)]
pub struct PresignRequest<'a> {
    /// `PUT` or `GET`.
    pub method: &'a str,
    /// The bucket's S3 host, e.g. `<account>.r2.cloudflarestorage.com`.
    pub host: &'a str,
    /// The path, already including the bucket and the key, each segment
    /// encoded. Use [`encode_path`].
    pub path: &'a str,
    /// `YYYYMMDDTHHMMSSZ`, the instant the signature is anchored to.
    pub timestamp: &'a str,
    /// Seconds the URL stays good for, capped at [`MAX_EXPIRY_SECONDS`].
    pub expires_in: u32,
}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hex_digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `YYYYMMDD` out of `YYYYMMDDTHHMMSSZ`.
#[must_use]
pub fn scope_date(timestamp: &str) -> &str {
    &timestamp[..8]
}

/// Percent-encode a path, leaving `/` alone.
///
/// S3's unreserved set is `A-Za-z0-9-._~`, and **an object key of ours is hex
/// and slashes**, so nothing here ever actually escapes. It is written anyway
/// because a signature computed over a differently-encoded path is a signature
/// the store rejects with no explanation, and the day a key stops being hex is
/// not the day to discover that.
#[must_use]
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Percent-encode one query-string value. Unlike a path, `/` is escaped.
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// THE PRESIGNED URL, WHOLE.
///
/// Query-string signing: every `X-Amz-*` parameter but the signature itself
/// goes into the canonical query string, the signature is computed over it, and
/// then the signature is appended. The canonical query string must be sorted by
/// key, which is why the parameters are assembled and sorted rather than
/// concatenated in a convenient order — a store that sorted differently would
/// compute a different signature and answer 403 with nothing an operator can
/// act on.
#[must_use]
pub fn presign(request: &PresignRequest<'_>, credentials: &Credentials) -> String {
    let expires_in = request.expires_in.min(MAX_EXPIRY_SECONDS);
    let date = scope_date(request.timestamp);
    let scope = format!("{date}/{}/s3/aws4_request", credentials.region);
    let credential = format!("{}/{scope}", credentials.access_key_id);

    let mut parameters = vec![
        ("X-Amz-Algorithm".to_owned(), ALGORITHM.to_owned()),
        ("X-Amz-Credential".to_owned(), credential),
        ("X-Amz-Date".to_owned(), request.timestamp.to_owned()),
        ("X-Amz-Expires".to_owned(), expires_in.to_string()),
        ("X-Amz-SignedHeaders".to_owned(), "host".to_owned()),
    ];
    parameters.sort_by(|left, right| left.0.cmp(&right.0));
    let canonical_query = parameters
        .iter()
        .map(|(key, value)| format!("{}={}", encode_query(key), encode_query(value)))
        .collect::<Vec<_>>()
        .join("&");

    // The canonical request. `host` is the only signed header, which is the
    // whole point of a presigned URL: a phone's HTTP stack adds its own
    // `User-Agent`, `Accept-Encoding` and whatever else, and a signature over
    // any of those would be a signature a background transfer breaks.
    let canonical_request = format!(
        "{method}\n{path}\n{query}\nhost:{host}\n\nhost\n{payload}",
        method = request.method,
        path = request.path,
        query = canonical_query,
        host = request.host,
        payload = UNSIGNED_PAYLOAD,
    );

    let string_to_sign = format!(
        "{ALGORITHM}\n{timestamp}\n{scope}\n{digest}",
        timestamp = request.timestamp,
        digest = hex_digest(canonical_request.as_bytes()),
    );

    let signing_key = {
        let date_key = hmac(
            format!("AWS4{}", credentials.secret_access_key).as_bytes(),
            date,
        );
        let region_key = hmac(&date_key, &credentials.region);
        let service_key = hmac(&region_key, "s3");
        hmac(&service_key, "aws4_request")
    };
    let signature = hex::encode(hmac(&signing_key, &string_to_sign));

    format!(
        "https://{host}{path}?{canonical_query}&X-Amz-Signature={signature}",
        host = request.host,
        path = request.path,
    )
}

/// `YYYYMMDDTHHMMSSZ` for a millisecond instant.
///
/// Written out rather than taken from a date library because the only calendar
/// this needs is the one SigV4 spells, and a Worker has no `SystemTime` to
/// reach for anyway — the instant is an argument, exactly as it is for every
/// rule in `gateway-core`.
#[must_use]
pub fn timestamp(millis: i64) -> String {
    let seconds = millis.div_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let time_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z",
        hour = time_of_day / 3_600,
        minute = (time_of_day % 3_600) / 60,
        second = time_of_day % 60,
    )
}

/// Howard Hinnant's `civil_from_days`, which is the shortest correct answer to
/// "what date is day N after 1970-01-01" and is the one every date library uses
/// underneath. Days before the epoch are handled, which matters only because a
/// clock that is wrong should produce a wrong signature rather than a panic.
const fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> Credentials {
        Credentials {
            access_key_id: "AKIDEXAMPLE".to_owned(),
            secret_access_key: "a secret this test invented".to_owned(),
            region: "auto".to_owned(),
        }
    }

    /// A SIGNATURE IS A FUNCTION OF EVERY PART OF THE REQUEST.
    ///
    /// The failure this guards against is a parameter that is assembled into
    /// the URL but left out of the string that was signed: the URL looks right,
    /// the store answers 403, and nothing says which parameter.
    #[test]
    fn changing_any_signed_part_changes_the_signature() {
        let base = PresignRequest {
            method: "PUT",
            host: "account.r2.cloudflarestorage.com",
            path: "/vault/aa/bb",
            timestamp: "20260918T000000Z",
            expires_in: 3_600,
        };
        let signature = |request: &PresignRequest<'_>| {
            presign(request, &credentials())
                .split("X-Amz-Signature=")
                .nth(1)
                .expect("a signature")
                .to_owned()
        };
        let original = signature(&base);
        for changed in [
            PresignRequest {
                method: "GET",
                ..base
            },
            PresignRequest {
                path: "/vault/aa/cc",
                ..base
            },
            PresignRequest {
                timestamp: "20260918T000001Z",
                ..base
            },
            PresignRequest {
                expires_in: 3_601,
                ..base
            },
            PresignRequest {
                host: "other.r2.cloudflarestorage.com",
                ..base
            },
        ] {
            assert_ne!(
                original,
                signature(&changed),
                "a part of the request is in the URL and not in the signature"
            );
        }
    }

    /// THE CANONICAL QUERY STRING IS SORTED. S3 computes its own over the
    /// sorted parameters, so a URL assembled in any other order signs something
    /// the store will not reproduce.
    #[test]
    fn the_query_parameters_are_in_sorted_order() {
        let url = presign(
            &PresignRequest {
                method: "PUT",
                host: "account.r2.cloudflarestorage.com",
                path: "/vault/aa/bb",
                timestamp: "20260918T000000Z",
                expires_in: 60,
            },
            &credentials(),
        );
        let query = url.split('?').nth(1).expect("a query string");
        let names: Vec<&str> = query
            .split('&')
            .map(|pair| pair.split('=').next().unwrap_or_default())
            .collect();
        // The signature is appended last, after the signed set.
        assert_eq!(names.last(), Some(&"X-Amz-Signature"));
        let signed = &names[..names.len() - 1];
        let mut sorted = signed.to_vec();
        sorted.sort_unstable();
        assert_eq!(signed, sorted.as_slice());
    }

    /// SEVEN DAYS IS THE CEILING AND IT IS APPLIED, not documented.
    #[test]
    fn an_expiry_beyond_the_ceiling_is_clamped_rather_than_sent() {
        let url = presign(
            &PresignRequest {
                method: "PUT",
                host: "account.r2.cloudflarestorage.com",
                path: "/vault/aa/bb",
                timestamp: "20260918T000000Z",
                expires_in: u32::MAX,
            },
            &credentials(),
        );
        assert!(url.contains(&format!("X-Amz-Expires={MAX_EXPIRY_SECONDS}")));
    }

    #[test]
    fn the_timestamp_is_the_calendar_sigv4_spells() {
        // 2026-09-18T12:34:56Z
        assert_eq!(timestamp(1_789_734_896_000), "20260918T123456Z");
        assert_eq!(timestamp(0), "19700101T000000Z");
    }

    /// An object key of ours is hex and slashes, and nothing in it escapes —
    /// which is worth asserting because the day it stops being true is the day
    /// a signature silently stops matching.
    #[test]
    fn a_hex_key_survives_encoding_unchanged() {
        let key = format!("/vault/{}/{}", "ab".repeat(32), "cd".repeat(32));
        assert_eq!(encode_path(&key), key);
    }
}
