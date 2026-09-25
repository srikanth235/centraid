//! The object store this server keeps bytes in (#1029 §3).
//!
//! `ByteStore` is one of the two ports. Behind it is
//! [`fs::FilesystemBytes`] — a directory — because the machine a member runs
//! this on has a disk. An S3/SigV4 backend stood beside it, for MinIO, B2,
//! Wasabi, Garage or R2 through its S3 endpoint; the scope amendment of
//! 2026-09-21 strikes it, because v0's destination is the member's own laptop
//! and its store is the filesystem.
//!
//! [`configured::Backend`] still holds ONE of them with an **optional second
//! store beside it** — the mirror, which is what gives the blind scrub
//! something to repair *from*. Keeping the enum with one arm is deliberate: the
//! HTTP surface and the sweeps stay non-generic over a choice made in a config
//! file, and a second backend is an arm rather than a refactor.
//!
//! # BYTES ARE PROXIED BY DEFAULT, AND THE PRESIGNED URL IS THE OPT-IN
//!
//! [`UploadTarget::url`] is a path on this server and the phone `PUT`s there;
//! the server streams the bytes through to the store. Presigning was the
//! opt-in for a self-hoster with a publicly reachable bucket; with no bucket
//! backend it has no subject, and W17 decides what an upload target looks like
//! over iroh.
//!
//! # THE CHECKSUM MODE IS A PROPERTY OF THE STORE
//!
//! The checksum mode was an input to the store rather than a branch inside it. A
//! filesystem attests nothing on its own, so [`fs::FilesystemBytes`] can be
//! built in either mode and answers honestly in the one it was built in. The
//! amendment also rules that the attested checksum goes and the gateway hashes
//! what it stores; **that is W17's change, because it changes the wire**, and
//! this module does not start it.

pub mod configured;
pub mod fs;

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
    /// Write the bytes.
    ///
    /// # Errors
    ///
    /// A store fault if the store refuses the write.
    async fn write(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        bytes: Vec<u8>,
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
