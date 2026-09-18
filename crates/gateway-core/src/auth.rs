//! Request authentication, identical on both adapters (#1029 §3).
//!
//! Every request is signed by the phone's **device key** over the method, the
//! path, a body digest and a timestamp, with a replay window; it carries the
//! **device certificate** chaining to the vault identity key; and a lease claim
//! is *additionally* signed by the identity key. The server holds only public
//! keys and never learns an email address, a phone number or a name.
//!
//! # Why the preimage is built here and not in each adapter
//!
//! An HTTP message signature assembled from header text differs between a
//! Worker's `Request` and axum's — header casing, whitespace, which headers are
//! covered, how a repeated header is joined. A phone that signs one shape and
//! is verified against the other fails for a reason nobody can read in a log.
//! So the bytes are assembled **once**, here, from typed fields, and the
//! adapters only decide how those fields arrive.
//!
//! Every field is length-prefixed, so `path = "/v/a/b"` with `method = "GET"`
//! cannot be reshuffled into `path = "/v/a"` with `method = "GETb"`.
//!
//! # What this module does NOT own
//!
//! Decoding a [`CertifiedDevice`] from the 136 bytes on the wire is
//! `centraid_identity::DeviceCertificate`'s job — the certificate's byte layout
//! and its own signature belong to the crate that mints them, and a second copy
//! of that layout here would be a second place for it to drift. What is owned
//! here is every *policy* over it: the epoch ordering, the binding to the
//! vault, the replay window and the skew answer.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::error::Refusal;
use crate::ids::{DeviceId, VaultId};
use crate::time::{Duration, ServerTime};

/// The domain separator. A signature over a gateway request cannot be replayed
/// as a signature over anything else this product signs.
pub const REQUEST_CONTEXT: &[u8] = b"centraid-gateway-request-v1";

/// The default replay window.
///
/// Five minutes each way. Wide enough that a phone which has been asleep and a
/// server on a slightly different NTP source agree; narrow enough that a
/// captured request is not a standing credential. A phone outside it is told
/// the server's time and re-signs **once** — see [`Refusal::ClockSkew`].
pub const DEFAULT_REPLAY_WINDOW: Duration = Duration::from_millis(300_000);

/// A device certificate that has already been decoded and whose own signature
/// has already been verified.
///
/// Built by the adapter with
/// `centraid_identity::DeviceCertificate::from_bytes(..)` followed by
/// `.verify()`. Passing an unverified one in is the one thing this type cannot
/// check, which is why its constructor is named for what the caller must have
/// done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CertifiedDevice {
    /// The vault identity key that issued the certificate.
    pub identity: VaultId,
    /// The device key it certifies.
    pub device: DeviceId,
    /// The lease epoch the certificate names. **The lease's own monotonic
    /// counter**, never a backup generation, which is 128 random bits and has
    /// no order (F3).
    pub epoch: u64,
}

impl CertifiedDevice {
    /// Name what the caller has already done.
    #[must_use]
    pub const fn already_verified(identity: VaultId, device: DeviceId, epoch: u64) -> Self {
        Self {
            identity,
            device,
            epoch,
        }
    }
}

/// The typed form of one signed request.
#[derive(Debug, Clone)]
pub struct SignedRequest<'a> {
    /// Uppercase, as the method is written.
    pub method: &'a str,
    /// The path with its query, from the first `/`. **Not the origin**: a phone
    /// that signed the host would have to re-sign when a self-hoster put the
    /// same server behind a second name.
    pub path: &'a str,
    /// BLAKE3-256 of the body, and the 32 zero bytes of an empty body's digest
    /// for a body-less request. BLAKE3 because this is our digest over our
    /// bytes (#1025 S4).
    pub body_digest: [u8; 32],
    /// The client's clock, in milliseconds since the Unix epoch.
    pub timestamp_ms: i64,
    /// The `Centraid-Protocol` value, inside the signature so a middlebox
    /// cannot rewrite the header to force a downgrade.
    pub protocol: u32,
    /// The certificate bytes exactly as they arrived, so the signature covers
    /// them and a certificate cannot be swapped for another of the same shape.
    pub certificate_bytes: &'a [u8],
    /// Ed25519 over [`preimage`], by the device key the certificate names.
    pub signature: &'a [u8],
}

/// The exact bytes a request signature covers.
///
/// Length-prefixed, big-endian, in field order. Both adapters call this and
/// neither assembles its own.
#[must_use]
pub fn preimage(request: &SignedRequest<'_>) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        REQUEST_CONTEXT.len()
            + request.method.len()
            + request.path.len()
            + request.certificate_bytes.len()
            + 64,
    );
    push(&mut out, REQUEST_CONTEXT);
    push(&mut out, request.method.as_bytes());
    push(&mut out, request.path.as_bytes());
    push(&mut out, &request.body_digest);
    push(&mut out, &request.timestamp_ms.to_be_bytes());
    push(&mut out, &request.protocol.to_be_bytes());
    push(&mut out, request.certificate_bytes);
    out
}

fn push(out: &mut Vec<u8>, field: &[u8]) {
    // A `u32` length is enough for every field here and keeps the encoding the
    // same width on every platform. The cast cannot lose: no field a gateway
    // accepts is 4 GiB, and the request body is never in the preimage at all —
    // only its digest.
    let length = u32::try_from(field.len()).unwrap_or(u32::MAX);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(field);
}

/// The body digest of an empty body.
#[must_use]
pub fn empty_body_digest() -> [u8; 32] {
    *blake3::hash(&[]).as_bytes()
}

/// Verify one request: the clock first, then the signature.
///
/// **The clock is checked first on purpose.** A phone with a wrong clock is the
/// common case and its answer is actionable — re-sign once with the server's
/// time. Checking the signature first would answer it with
/// `SignatureInvalid`, which is the answer for an attacker, and the phone would
/// have nothing to do about it.
///
/// # Errors
///
/// - [`Refusal::ClockSkew`], carrying the **server's** time and the window;
/// - [`Refusal::SignatureInvalid`] for a signature that does not verify against
///   the certified device, which includes a malformed signature and a malformed
///   key. Unknown and invalid are the same refusal.
pub fn verify_request(
    request: &SignedRequest<'_>,
    device: &CertifiedDevice,
    now: ServerTime,
    window: Duration,
) -> Result<(), Refusal> {
    let claimed = ServerTime::from_millis(request.timestamp_ms);
    if now.distance(claimed) > window {
        return Err(Refusal::ClockSkew {
            server_time: now,
            window,
        });
    }

    let Ok(key) = VerifyingKey::from_bytes(device.device.as_bytes()) else {
        return Err(Refusal::SignatureInvalid);
    };
    let Ok(bytes) = <[u8; 64]>::try_from(request.signature) else {
        return Err(Refusal::SignatureInvalid);
    };
    key.verify(&preimage(request), &Signature::from_bytes(&bytes))
        .map_err(|_| Refusal::SignatureInvalid)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;
    use crate::ids::Key32;

    fn signer() -> SigningKey {
        SigningKey::from_bytes(&[7_u8; 32])
    }

    fn certified() -> CertifiedDevice {
        CertifiedDevice::already_verified(
            Key32::from_bytes([1_u8; 32]),
            Key32::from_bytes(signer().verifying_key().to_bytes()),
            3,
        )
    }

    fn request<'a>(signature: &'a [u8], timestamp_ms: i64) -> SignedRequest<'a> {
        SignedRequest {
            method: "POST",
            path: "/v/0101/commit",
            body_digest: *blake3::hash(b"a body").as_bytes(),
            timestamp_ms,
            protocol: 1,
            certificate_bytes: &[9_u8; 136],
            signature,
        }
    }

    fn sign(timestamp_ms: i64) -> Vec<u8> {
        let empty = Vec::new();
        let unsigned = request(&empty, timestamp_ms);
        signer().sign(&preimage(&unsigned)).to_bytes().to_vec()
    }

    #[test]
    fn a_well_formed_request_inside_the_window_verifies() {
        let now = ServerTime::from_millis(1_770_000_000_000);
        let signature = sign(now.millis());
        assert_eq!(
            verify_request(
                &request(&signature, now.millis()),
                &certified(),
                now,
                DEFAULT_REPLAY_WINDOW
            ),
            Ok(())
        );
    }

    /// THE 401 RETURNS SERVER TIME (Reference B, "Protocol"). Replay windows
    /// fail on phones with wrong clocks, and a phone that has been off for a
    /// month comes back with one.
    #[test]
    fn a_wrong_clock_is_told_the_server_time_and_re_signs_once() {
        let now = ServerTime::from_millis(1_770_000_000_000);
        // The phone thinks it is an hour earlier.
        let wrong = now.millis() - 3_600_000;
        let signature = sign(wrong);
        let refusal = verify_request(
            &request(&signature, wrong),
            &certified(),
            now,
            DEFAULT_REPLAY_WINDOW,
        )
        .expect_err("outside the window");
        let Refusal::ClockSkew { server_time, .. } = refusal else {
            panic!("a skew refusal, not {refusal:?}");
        };
        assert_eq!(
            server_time, now,
            "the server's own clock, so the phone can correct"
        );
        assert!(refusal.is_retryable_once());

        // The phone applies the offset and re-signs. Once.
        let corrected = sign(server_time.millis());
        assert_eq!(
            verify_request(
                &request(&corrected, server_time.millis()),
                &certified(),
                now,
                DEFAULT_REPLAY_WINDOW
            ),
            Ok(())
        );
    }

    /// The clock is judged before the signature, so the actionable refusal wins
    /// over the one an attacker would get.
    #[test]
    fn a_skewed_request_is_told_about_the_clock_and_not_about_the_signature() {
        let now = ServerTime::from_millis(1_770_000_000_000);
        let wrong = now.millis() - 3_600_000;
        assert!(matches!(
            verify_request(
                &request(&[0_u8; 64], wrong),
                &certified(),
                now,
                DEFAULT_REPLAY_WINDOW
            ),
            Err(Refusal::ClockSkew { .. })
        ));
    }

    /// Every field is covered, and length-prefixed so none can be shifted into
    /// another. One test per field a tamper could move.
    #[test]
    fn tampering_with_any_covered_field_invalidates_the_signature() {
        let now = ServerTime::from_millis(1_770_000_000_000);
        let signature = sign(now.millis());
        let good = request(&signature, now.millis());

        let mut cases = Vec::new();
        let mut tampered = good.clone();
        tampered.method = "GET";
        cases.push(tampered);
        let mut tampered = good.clone();
        tampered.path = "/v/0101/commi";
        cases.push(tampered);
        let mut tampered = good.clone();
        tampered.body_digest = *blake3::hash(b"another body").as_bytes();
        cases.push(tampered);
        let mut tampered = good.clone();
        tampered.protocol = 2;
        cases.push(tampered);
        let mut tampered = good.clone();
        tampered.certificate_bytes = &[8_u8; 136];
        cases.push(tampered);

        for case in cases {
            assert_eq!(
                verify_request(&case, &certified(), now, DEFAULT_REPLAY_WINDOW),
                Err(Refusal::SignatureInvalid),
                "a covered field moved and the signature still verified: {} {}",
                case.method,
                case.path
            );
        }
    }

    /// A shifted boundary is the attack the length prefixes exist to stop.
    #[test]
    fn a_field_boundary_cannot_be_moved_between_two_fields() {
        let one = preimage(&SignedRequest {
            method: "GET",
            path: "/ab",
            ..request(&[], 0)
        });
        let other = preimage(&SignedRequest {
            method: "GETa",
            path: "/b",
            ..request(&[], 0)
        });
        assert_ne!(one, other);
    }

    #[test]
    fn a_malformed_signature_is_the_same_refusal_as_a_wrong_one() {
        let now = ServerTime::from_millis(1_770_000_000_000);
        assert_eq!(
            verify_request(
                &request(&[0_u8; 7], now.millis()),
                &certified(),
                now,
                DEFAULT_REPLAY_WINDOW
            ),
            Err(Refusal::SignatureInvalid)
        );
    }
}
