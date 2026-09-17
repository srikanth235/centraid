//! The two object stores a self-hoster can point this server at (#1029 §3).
//!
//! `ByteStore` is one of the two ports, and **which store is behind it is the
//! only thing the two deployments genuinely differ about** besides admission.
//! The hosted adapter puts R2 there. Here there are two:
//!
//! - [`fs::FilesystemBytes`] — a directory. A home box with one disk, which is
//!   what most self-hosters actually have.
//! - [`s3::S3Bytes`] — anything S3-compatible: MinIO, Backblaze B2, Wasabi,
//!   Garage, or R2 through its S3 endpoint.
//!
//! and [`configured::ConfiguredBytes`] holds one of them with an **optional
//! second store beside it** — the mirror, which is what gives the blind scrub
//! something to repair *from*.
//!
//! # BYTES ARE PROXIED BY DEFAULT, AND THE PRESIGNED URL IS THE OPT-IN
//!
//! This is the reverse of the hosted adapter's default, and it is deliberate.
//! The hosted adapter presigns because R2 is reachable from every phone and the
//! Worker is billed per request; a self-hoster's bucket usually is *not*
//! reachable. The common shapes are a home box behind a Cloudflare Tunnel, a
//! Tailscale Funnel, or a reverse proxy on one hostname — in every one of them
//! the gateway's own name is the only name that resolves from outside, and a
//! presigned `http://minio.lan:9000/...` handed to a phone on cellular is a
//! transfer that hangs and then times out.
//!
//! So [`UploadTarget::url`] is a path on this server by default and the phone
//! `PUT`s there; the server streams the bytes through to the store. Presigning
//! is `presign = true` in the config, for the self-hoster who really does have
//! a publicly reachable bucket and wants the bytes off their uplink.
//!
//! The rules do not know which was chosen and must not: `presign_put` returns
//! a `UploadTarget` either way, and `evidence` answers the same question either
//! way. That is what keeps [`crate::conformance`] able to run every combination.
//!
//! # THE CHECKSUM MODE IS A PROPERTY OF THE STORE
//!
//! `ChecksumMode` is an input to both stores rather than a branch inside them.
//! A filesystem attests nothing on its own, so [`fs::FilesystemBytes`] can be
//! built in either mode and answers honestly in the one it was built in; B2 and
//! MinIO differ on which checksum headers they attest, so
//! [`s3::S3Bytes`] takes the mode from its configuration. An operator who
//! points this at a store that does not attest and configures `attest` gets
//! `ChecksumEvidence::None` and a refused commit — which is the rule working,
//! not a bug, and is why the conformance suite runs both modes against both
//! stores.

pub mod configured;
pub mod fs;
pub mod s3;
pub mod sigv4;

use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::store::StoreFault;

/// The store key one object sits at.
///
/// `<vault hex>/<object hex>`, and it is the same shape in every store so an
/// operator moving from a directory to a bucket copies rather than rewrites.
/// Both halves are hex of a 32-byte value the gateway already holds — a public
/// key and a hash of ciphertext — so a key leaks exactly what the state file
/// already does and nothing more.
#[must_use]
pub fn object_key(vault: &VaultId, name: &ObjectName) -> String {
    format!("{}/{}", vault.hex(), name.hex())
}

/// Putting bytes into a store, which `ByteStore` deliberately has no operation
/// for.
///
/// **The port has none because the hosted adapter never performs one**: bytes
/// go straight to R2 by presigned URL and the gateway learns about them only
/// through `ByteStore::evidence`. A `put` on the port would be an operation one
/// adapter could not implement, which is the shape of trait the whole design
/// avoids.
///
/// Here it is the proxy's own operation, above the port and below no rule: the
/// server is streaming through bytes it cannot open, and every decision about
/// whether they may be committed is still made by `gateway-core` afterwards.
#[expect(
    async_fn_in_trait,
    reason = "matching centraid_gateway_core::store, whose ports carry no Send \
              bound so that a Worker's !Send futures can implement them. A \
              second convention in the same call graph would be worse than an \
              unused degree of freedom."
)]
pub trait ProxyWrite {
    /// Write the bytes, recording whether the client attested a checksum.
    ///
    /// # Errors
    ///
    /// A store fault if the store refuses the write.
    async fn write(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        bytes: Vec<u8>,
        attested: bool,
    ) -> Result<(), StoreFault>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_gateway_core::ids::Key32;

    /// TWO TENANTS NEVER SHARE A KEY. The vault is the first path segment, so
    /// one household's prefix cannot reach another's even by construction.
    #[test]
    fn a_key_is_the_vault_then_the_object_and_both_are_hex() {
        let key = object_key(
            &Key32::from_bytes([0x11; 32]),
            &Key32::from_bytes([0x22; 32]),
        );
        assert_eq!(key, format!("{}/{}", "11".repeat(32), "22".repeat(32)));
        assert!(!key.contains(".."), "a key can never traverse");
        assert!(
            key.chars().all(|c| c.is_ascii_hexdigit() || c == '/'),
            "a key is hex and separators, so no store has to escape one"
        );
    }
}
