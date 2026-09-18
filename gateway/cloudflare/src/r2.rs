//! `ByteStore` over R2 (#1029 §3).
//!
//! **This module stores; it does not decide.** Whether an object may be
//! presigned, whether a commit verifies, what a quota is — every one of those
//! is `centraid-gateway-core`'s. What is here is a bucket.
//!
//! # THE ONE CONSTRAINT THAT SHAPES EVERYTHING BELOW
//!
//! **R2 records `checksums.sha256` only if the client sent it.** The binding
//! says so in its own types: `Object::checksum().sha256` is an `Option`, and a
//! `None` is not an error condition — it is an ordinary upload by a client that
//! omitted the header. So [`ByteStore::evidence`] answers
//! [`ChecksumEvidence::None`] for it, `checksum::verify` refuses it, and a
//! commit fails on **no checksum** and not merely on **wrong checksum**.
//! Without that, an object with no attestation at all commits happily and
//! write-once is a comment.
//!
//! # THE MODE IS AN INPUT, AND `Attest` IS WHAT A DEPLOYED WORKER USES
//!
//! `ChecksumMode` is a property of the store the adapter was pointed at, not of
//! the adapter — there is no `GatewayMode` anywhere and this is the closest
//! thing to one. R2 attests, so a deployed Worker is built in
//! [`ChecksumMode::Attest`] and never reads the bytes at commit, which is the
//! property that lets it commit a 16 MiB object inside a Worker's CPU budget.
//!
//! [`ChecksumMode::ReadAndHash`] is implemented all the same, and it is not
//! dead code: it is the mode the conformance suite runs two of its cases in,
//! and running them against **this** store rather than skipping them is what
//! proves the stronger check behaves identically on both deployments. It reads
//! the object back through the binding and computes both names itself.
//!
//! **Neither mode excuses a missing attestation.** Read-and-hash is the
//! stronger check *over an attested object*, never a substitute for the
//! attestation: an unattested upload answers [`ChecksumEvidence::None`] in both
//! modes, because that is what R2 produces and what the rule refuses. The
//! standalone adapter's S3 store was reading and hashing one anyway, which
//! would have accepted an object this adapter refuses — the exact divergence
//! the shared suite exists to catch.
//!
//! `read` also serves the blind scrub, which re-hashes stored objects and has
//! to see them. It is the only place bytes pass through Worker code, it is
//! never on a commit path in a deployed Worker, and it is why the scrub is a
//! scheduled job.
//!
//! # BYTES GO STRAIGHT TO R2, WHICH TAKES TWO APIS
//!
//! The binding cannot presign; presigning is S3's. So the gateway's own reads
//! use the binding and the phone's transfer uses a presigned S3 URL, and
//! `sigv4.rs` is the seam. An operator who has not configured the S3
//! credentials gets a refused presign with a message that says which secret is
//! missing, rather than a URL that 403s on a phone.

use centraid_gateway_core::checksum::{AttestedChecksum, ChecksumEvidence, ChecksumMode};
use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::store::{ByteStore, StoreFault, UploadTarget};
use centraid_gateway_core::time::{Duration, ServerTime};
use worker::Bucket;

use crate::sigv4::{self, Credentials, PresignRequest};

/// How long a presigned target is good for.
///
/// SigV4's ceiling, and the bound that matters is a phone rather than a
/// security margin: an iOS background `URLSession` transfer can be deferred for
/// days on a metered connection, and a target that expired underneath it is an
/// upload that fails at the end.
pub const TARGET_LIFETIME: Duration = Duration::from_days(7);

/// The store key one object sits at.
///
/// `<vault hex>/<object hex>`, **the same shape the standalone adapter uses**
/// (`gateway-server/src/bytes/mod.rs`), so that an operator moving between the
/// two copies rather than rewrites. Both halves are hex of a 32-byte value the
/// gateway already holds — a public key and a hash of ciphertext — so a key
/// leaks exactly what the object index already does and nothing more.
///
/// The vault is the **first** segment, which is what makes byte scope per vault
/// structural: one tenant's prefix cannot reach another's even by construction.
#[must_use]
pub fn object_key(vault: &VaultId, name: &ObjectName) -> String {
    format!("{}/{}", vault.hex(), name.hex())
}

/// What this Worker was told about its bucket's S3 face.
#[derive(Debug, Clone)]
pub struct S3Face {
    /// `<account id>.r2.cloudflarestorage.com`.
    pub host: String,
    /// The bucket name, which is the first path segment of an S3 URL.
    pub bucket: String,
    pub credentials: Credentials,
}

/// The bytes, in R2.
pub struct R2Bytes {
    bucket: Bucket,
    /// `None` when the S3 credentials were not configured. Presigning then
    /// refuses with a message naming the secret, which is a better failure than
    /// a URL that 403s on somebody's phone.
    s3: Option<S3Face>,
    mode: ChecksumMode,
}

impl R2Bytes {
    /// A store over one bucket, in the mode a deployed Worker uses.
    #[must_use]
    pub const fn new(bucket: Bucket, s3: Option<S3Face>) -> Self {
        Self {
            bucket,
            s3,
            mode: ChecksumMode::Attest,
        }
    }

    /// The same store in a named mode. **The conformance suite**, which runs
    /// two of its cases in read-and-hash and must run them against this store
    /// rather than skip them.
    #[must_use]
    pub const fn in_mode(bucket: Bucket, s3: Option<S3Face>, mode: ChecksumMode) -> Self {
        Self { bucket, s3, mode }
    }

    /// The bucket, for the routes that hand bytes back directly.
    #[must_use]
    pub const fn bucket(&self) -> &Bucket {
        &self.bucket
    }

    /// Every key under one vault's prefix, for the canary and the garbage
    /// collector.
    ///
    /// **Uncommitted uploads sit at their final key** — R2 has no rename — so
    /// the only way to find bytes the index does not know about is to list.
    ///
    /// # Errors
    ///
    /// A store fault if the listing fails.
    pub async fn keys_under(&self, vault: &VaultId) -> Result<Vec<String>, StoreFault> {
        let listed = self
            .bucket
            .list()
            .prefix(format!("{}/", vault.hex()))
            .execute()
            .await
            .map_err(fault)?;
        Ok(listed.objects().iter().map(worker::Object::key).collect())
    }
}

fn fault(error: worker::Error) -> StoreFault {
    StoreFault::new(error.to_string())
}

/// THE `PUT` A PHONE MAKES, PERFORMED HERE INSTEAD OF BY THE PHONE.
///
/// The conformance suite has to make the upload a phone would make, in both of
/// the two shapes a real client produces: **with** the attestation header, and
/// **without** it — which is what R2 gives anyone who did not opt in, and the
/// reason a commit must fail on "no checksum" and not only on "wrong checksum".
///
/// It lives in this module rather than in the harness so that the store's own
/// checksum field is named in one place: `r2.rs` names it and `sigv4.rs`
/// computes one, and `crates/vault/tests/one_hash.rs` allowlists exactly those
/// two with the reason. A harness that spelled it would be a third.
///
/// **Not on the `ByteStore` port**, and that is deliberate: the port has no
/// `put` because the hosted adapter never performs one — bytes go straight to
/// R2 by presigned URL and the gateway learns about them only through
/// [`ByteStore::evidence`]. This is the suite standing in for a phone.
///
/// # Errors
///
/// A store fault if the write fails.
pub async fn put_as_a_phone_would(
    bucket: &Bucket,
    vault: &VaultId,
    name: &ObjectName,
    bytes: Vec<u8>,
    attested: bool,
) -> Result<(), StoreFault> {
    let key = object_key(vault, name);
    let put = bucket.put(key, bytes.clone());
    let put = if attested {
        put.sha256(AttestedChecksum::of(&bytes).as_bytes().to_vec())
    } else {
        put
    };
    put.execute().await.map(|_| ()).map_err(fault)
}

impl ByteStore for R2Bytes {
    fn checksum_mode(&self) -> ChecksumMode {
        // An input, not a branch on which deployment this is. See the module
        // docs.
        self.mode
    }

    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        _padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault> {
        let Some(s3) = &self.s3 else {
            return Err(StoreFault::new(
                "this Worker has no R2 S3 credentials, so it cannot presign. Set \
                 R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as secrets and \
                 R2_S3_HOST in the environment",
            ));
        };
        let path = sigv4::encode_path(&format!("/{}/{}", s3.bucket, object_key(vault, name)));
        let url = sigv4::presign(
            &PresignRequest {
                method: "PUT",
                host: &s3.host,
                path: &path,
                timestamp: &sigv4::timestamp(now.millis()),
                expires_in: sigv4::MAX_EXPIRY_SECONDS,
            },
            &s3.credentials,
        );
        Ok(UploadTarget {
            name: *name,
            url,
            expires_at: now + TARGET_LIFETIME,
            already_committed: false,
        })
    }

    async fn evidence(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<ChecksumEvidence, StoreFault> {
        let Some(object) = self
            .bucket
            .head(object_key(vault, name))
            .await
            .map_err(fault)?
        else {
            // Nothing at that key at all: the phone never finished the upload.
            return Ok(ChecksumEvidence::None);
        };
        // THE ONE CONSTRAINT. R2 carries the attestation only when the client
        // sent it, so an absent one is a REJECTION and not a shrug — and this
        // adapter must not "helpfully" read the bytes and hash them instead,
        // which would accept an object the rule refuses and is exactly the
        // divergence the shared suite exists to catch.
        let Some(attested) = object.checksum().sha256 else {
            return Ok(ChecksumEvidence::None);
        };
        let Some(checksum) = AttestedChecksum::from_slice(&attested) else {
            // A stored attestation that is not 32 bytes is not an attestation.
            return Ok(ChecksumEvidence::None);
        };
        match self.mode {
            ChecksumMode::Attest => Ok(ChecksumEvidence::Attested {
                checksum,
                stored_size: object.size(),
            }),
            // The stronger check, over an object that WAS attested. Note the
            // order: the attestation is required first and the read only then
            // happens, which is what keeps read-and-hash from quietly becoming
            // a way past the missing-checksum rule.
            ChecksumMode::ReadAndHash => {
                let Some(bytes) = self.read(vault, name).await? else {
                    return Ok(ChecksumEvidence::None);
                };
                Ok(ChecksumEvidence::ReadAndHashed {
                    checksum: AttestedChecksum::of(&bytes),
                    name: ObjectName::of(&bytes),
                    stored_size: bytes.len() as u64,
                })
            }
        }
    }

    async fn read(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<Vec<u8>>, StoreFault> {
        let object = self
            .bucket
            .get(object_key(vault, name))
            .execute()
            .await
            .map_err(fault)?;
        let Some(object) = object else {
            return Ok(None);
        };
        let Some(body) = object.body() else {
            return Ok(None);
        };
        Ok(Some(body.bytes().await.map_err(fault)?))
    }

    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        self.bucket
            .delete(object_key(vault, name))
            .await
            .map_err(fault)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_gateway_core::ids::Key32;

    /// TWO TENANTS NEVER SHARE A KEY, and the two adapters agree on the shape.
    #[test]
    fn a_key_is_the_vault_then_the_object_and_both_are_hex() {
        let key = object_key(
            &Key32::from_bytes([0x11; 32]),
            &Key32::from_bytes([0x22; 32]),
        );
        assert_eq!(key, format!("{}/{}", "11".repeat(32), "22".repeat(32)));
        assert!(!key.contains(".."), "a key can never traverse");
        assert!(key.chars().all(|c| c.is_ascii_hexdigit() || c == '/'));
    }
}
