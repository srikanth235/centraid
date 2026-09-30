//! The four headers, and the key that produces them (#1029 §3, W5B-1).
//!
//! # WHAT THIS MODULE IS ALLOWED TO DECIDE
//!
//! How a signature becomes header *text*. Not what it covers: the covered bytes
//! are [`centraid_gateway_core::auth::preimage`]'s, which is the function the
//! server verifies with, and a second assembly of them here would be the
//! drift that module's header opens by refusing.
//!
//! # THE CLOCK OFFSET IS PART OF THE SIGNER AND NOT OF A CALLER
//!
//! A phone that has been off for a month comes back with a wrong clock, and the
//! answer is a 401 carrying the server's own time. Applying it is *arithmetic
//! on every subsequent timestamp*, so it belongs to the thing that stamps them.
//! A caller that had to remember to add an offset is a caller that forgets on
//! the one path nobody exercises — and the failure is a phone that cannot back
//! up and says `SignatureInvalid`.
//!
//! The offset is **not** a clock the phone believes. It is never written to a
//! vault row, never shown, and never used for anything but a request timestamp:
//! the moment a gateway's refusal could move a phone's idea of *when a thing
//! happened*, a gateway would be able to backdate a member's history.

use centraid_gateway_core::auth::{self, SignedRequest};
use centraid_gateway_core::ids::ObjectName;
use centraid_identity::{DeviceCertificate, DeviceKey};
use ed25519_dalek::Signer as _;

/// The four header names, spelled once on this side.
///
/// They are `centraid-gateway-server`'s constants read back, because a client
/// with its own spelling of `centraid-signature` is a client that cannot
/// authenticate and a test that passes. They live here as `&str` rather than as
/// a dependency on that crate: the standalone server is one deployment, the
/// Worker is the other, and a client may not depend on either.
pub const CERTIFICATE_HEADER: &str = "centraid-certificate";
/// See [`CERTIFICATE_HEADER`].
pub const SIGNATURE_HEADER: &str = "centraid-signature";
/// See [`CERTIFICATE_HEADER`].
pub const TIMESTAMP_HEADER: &str = "centraid-timestamp";
/// See [`CERTIFICATE_HEADER`].
pub const PROTOCOL_HEADER: &str = "centraid-protocol";

/// The four values one signed request carries.
///
/// A plain struct rather than a map, because it is exactly four things and a
/// map would let a caller omit one and find out on the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedHeaders {
    /// The device certificate, hex.
    pub certificate: String,
    /// Ed25519 over the preimage, hex.
    pub signature: String,
    /// The timestamp that was signed — **with the offset already applied**.
    pub timestamp_ms: i64,
    /// The protocol version that was signed.
    pub protocol: u32,
}

impl SignedHeaders {
    /// The four `(name, value)` pairs, in the order a reader would want them.
    ///
    /// A background task carries these and nothing else; this is the shape it
    /// carries them in.
    #[must_use]
    pub fn pairs(&self) -> [(&'static str, String); 4] {
        [
            (CERTIFICATE_HEADER, self.certificate.clone()),
            (SIGNATURE_HEADER, self.signature.clone()),
            (TIMESTAMP_HEADER, self.timestamp_ms.to_string()),
            (PROTOCOL_HEADER, self.protocol.to_string()),
        ]
    }
}

/// This device's key, its certificate, and the offset the server last taught
/// it.
///
/// One per vault, because a certificate names one vault: the identity key that
/// issued it is the vault id, and the server refuses a request whose path names
/// a different one (two-tenant isolation).
#[derive(Debug)]
pub struct DeviceSigner {
    key: DeviceKey,
    certificate_bytes: Vec<u8>,
    protocol: u32,
    /// Server time minus phone time, in milliseconds. Zero until a 401 says
    /// otherwise.
    offset_ms: i64,
}

impl DeviceSigner {
    /// Build a signer from this device's key and the certificate the vault
    /// identity issued it.
    ///
    /// The certificate's bytes are kept rather than re-encoded per request: the
    /// signature covers them *exactly as they go on the wire*, so a re-encode
    /// that differed by one byte would verify against nothing.
    #[must_use]
    pub fn new(key: DeviceKey, certificate: &DeviceCertificate, protocol: u32) -> Self {
        Self {
            key,
            certificate_bytes: certificate.to_bytes().to_vec(),
            protocol,
            offset_ms: 0,
        }
    }

    /// The protocol version this signer stamps.
    #[must_use]
    pub const fn protocol(&self) -> u32 {
        self.protocol
    }

    /// Speak a lower version than this build's maximum, after a negotiation.
    ///
    /// The value is the one [`centraid_gateway_core::version::negotiate`]
    /// answered and never a guess: a client that picked its own would be the
    /// second copy of that comparison the module exists to prevent.
    pub const fn speak(&mut self, protocol: u32) {
        self.protocol = protocol;
    }

    /// The offset the last skew refusal taught this signer, in milliseconds.
    #[must_use]
    pub const fn offset_ms(&self) -> i64 {
        self.offset_ms
    }

    /// Learn the server's clock from a skew refusal.
    ///
    /// `server_time_ms` is what the 401 carried and `phone_now_ms` is what this
    /// device thought at the moment it signed. Saturating, because a phone
    /// whose clock is at `i64::MIN` is a phone that really exists and a panic
    /// in a background task is a crash report instead of a backup.
    pub const fn learn_clock(&mut self, server_time_ms: i64, phone_now_ms: i64) {
        self.offset_ms = server_time_ms.saturating_sub(phone_now_ms);
    }

    /// This device's timestamp for a request: its own clock, corrected.
    #[must_use]
    pub const fn stamp(&self, phone_now_ms: i64) -> i64 {
        phone_now_ms.saturating_add(self.offset_ms)
    }

    /// Sign one request.
    ///
    /// `path` is the path **with its query**, from the first `/`, and never the
    /// origin — so a self-hoster who puts the same server behind a second name
    /// does not make every phone re-sign
    /// ([`centraid_gateway_core::auth::SignedRequest`]).
    #[must_use]
    pub fn sign(&self, method: &str, path: &str, body: &[u8], phone_now_ms: i64) -> SignedHeaders {
        self.sign_digest(method, path, *blake3::hash(body).as_bytes(), phone_now_ms)
    }

    /// Sign one request whose body digest the caller already knows.
    ///
    /// The door [`Self::sign_object_put`] goes through, and the door a caller
    /// with a streamed body goes through.
    #[must_use]
    pub fn sign_digest(
        &self,
        method: &str,
        path: &str,
        body_digest: [u8; 32],
        phone_now_ms: i64,
    ) -> SignedHeaders {
        let timestamp_ms = self.stamp(phone_now_ms);
        let certificate = hex::encode(&self.certificate_bytes);
        let request = SignedRequest {
            method,
            path,
            body_digest,
            timestamp_ms,
            protocol: self.protocol,
            certificate_bytes: &self.certificate_bytes,
            signature: &[],
        };
        let signature = self.key.signing().sign(&auth::preimage(&request));
        SignedHeaders {
            certificate,
            signature: hex::encode(signature.to_bytes()),
            timestamp_ms,
            protocol: self.protocol,
        }
    }

    /// **Sign an object PUT without reading the object.**
    ///
    /// This is the line that makes iOS's `uploadTask(with:fromFile:)` usable at
    /// all. A background upload hands the OS a file and is not running when the
    /// bytes go out, so it cannot compute a digest at send time — and reading
    /// 16 MiB back to compute one would give up the exact property the
    /// file-based API is for.
    ///
    /// It does not have to. An object's name **is** the BLAKE3-256 of its
    /// sealed bytes, which is the rule the gateway's own `read-and-hash`
    /// checksum mode and its blind scrubber both enforce
    /// ([`centraid_gateway_core::ids::ObjectName::of`]). So the digest the
    /// signature covers is already in the path, and
    /// `a_signed_object_put_covers_the_bytes_it_names` holds the two sides
    /// together.
    #[must_use]
    pub fn sign_object_put(
        &self,
        vault_hex: &str,
        name: &ObjectName,
        phone_now_ms: i64,
    ) -> (String, SignedHeaders) {
        let path = format!("/v1/objects/{vault_hex}/{}", name.hex());
        let headers = self.sign_digest("PUT", &path, *name.as_bytes(), phone_now_ms);
        (path, headers)
    }
}

#[cfg(test)]
mod tests {
    use centraid_gateway_core::auth::{CertifiedDevice, DEFAULT_REPLAY_WINDOW, verify_request};
    use centraid_gateway_core::ids::Key32;
    use centraid_gateway_core::time::ServerTime;
    use centraid_identity::{Epoch, RecoveryPhrase, VaultMint};

    use super::*;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon abandon abandon abandon abandon art";

    fn signer_pair() -> (DeviceSigner, DeviceCertificate) {
        let seed = RecoveryPhrase::parse(PHRASE)
            .expect("the published vector parses")
            .seed();
        let keys = VaultMint::fresh()
            .mint(&seed, 0)
            .expect("index zero derives");
        let device = DeviceKey::generate().expect("a device key");
        let certificate = DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::new(1));
        (DeviceSigner::new(device, &certificate, 1), certificate)
    }

    /// The whole point: what this client signs, the server's own verifier
    /// accepts. Not a shape test — `verify_request` is the function
    /// `gateway-server` calls.
    #[test]
    fn what_this_client_signs_the_rules_verify() {
        let (signer, certificate) = signer_pair();
        let now = 1_770_000_000_000;
        let body = br#"{"objects":[]}"#;
        let headers = signer.sign("POST", "/v1/vaults/ab/declare", body, now);

        let certificate_bytes = hex::decode(&headers.certificate).expect("hex");
        let signature = hex::decode(&headers.signature).expect("hex");
        let device = CertifiedDevice::already_verified(
            Key32::from_bytes(certificate.identity().to_bytes()),
            Key32::from_bytes(certificate.device().to_bytes()),
            certificate.epoch().get(),
        );
        assert_eq!(
            verify_request(
                &SignedRequest {
                    method: "POST",
                    path: "/v1/vaults/ab/declare",
                    body_digest: *blake3::hash(body).as_bytes(),
                    timestamp_ms: headers.timestamp_ms,
                    protocol: headers.protocol,
                    certificate_bytes: &certificate_bytes,
                    signature: &signature,
                },
                &device,
                ServerTime::from_millis(now),
                DEFAULT_REPLAY_WINDOW,
            ),
            Ok(())
        );
    }

    /// A SIGNED OBJECT PUT COVERS THE BYTES IT NAMES, without reading them.
    /// If `ObjectName::of` ever stopped being the digest of the sealed bytes,
    /// this is where a background uploader would find out — rather than in a
    /// member's crash report a week later.
    #[test]
    fn a_signed_object_put_covers_the_bytes_it_names() {
        let (signer, _) = signer_pair();
        let sealed = b"some sealed ciphertext a phone spooled";
        let name = ObjectName::of(sealed);
        let (path, headers) = signer.sign_object_put("0a0b", &name, 1_770_000_000_000);
        assert_eq!(path, format!("/v1/objects/0a0b/{}", name.hex()));

        // The digest the signature covers is the one an uploader that DID read
        // the file would have computed.
        let read_it = signer.sign("PUT", &path, sealed, 1_770_000_000_000);
        assert_eq!(headers, read_it, "the name is the digest");
    }

    /// THE PHONE WITH THE WRONG CLOCK. It learns an offset and every later
    /// stamp carries it — including the ones a background task makes hours
    /// afterwards, which is why the offset lives on the signer.
    #[test]
    fn a_learned_offset_corrects_every_later_stamp() {
        let (mut signer, _) = signer_pair();
        let phone = 1_000_000_000_000;
        let server = 1_770_000_000_000;
        assert_eq!(signer.stamp(phone), phone);
        signer.learn_clock(server, phone);
        assert_eq!(signer.stamp(phone), server);
        // Later, the phone's own clock has ticked on. So does the correction.
        assert_eq!(signer.stamp(phone + 60_000), server + 60_000);
    }

    /// A clock near the bottom of the range is a phone somebody really owns,
    /// and a background task that panicked there would be a crash report
    /// instead of a backup.
    #[test]
    fn an_absurd_clock_saturates_rather_than_panicking() {
        let (mut signer, _) = signer_pair();
        signer.learn_clock(i64::MAX, i64::MIN);
        let _ = signer.stamp(i64::MAX);
    }

    #[test]
    fn the_four_headers_are_the_servers_four_names() {
        let (signer, _) = signer_pair();
        let headers = signer.sign("GET", "/v1/health", &[], 1);
        let names: Vec<&str> = headers.pairs().iter().map(|(name, _)| *name).collect();
        assert_eq!(
            names,
            vec![
                "centraid-certificate",
                "centraid-signature",
                "centraid-timestamp",
                "centraid-protocol"
            ]
        );
    }
}
