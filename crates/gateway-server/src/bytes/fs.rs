//! A directory as the object store (#1029 §3).
//!
//! The default for a home box, because most of them have one disk and no
//! bucket. Objects sit at `<root>/<vault hex>/<object hex>`, which is the same
//! key [`crate::bytes::s3::S3Bytes`] uses, so moving from one to the other is a
//! copy rather than a migration.
//!
//! **There is no path a client chooses.** Both segments are hex of a 32-byte
//! value the gateway already holds, so there is nothing to escape and no
//! traversal to defend against — which is a property of content addressing
//! rather than a check this file performs, and is worth stating because the
//! absence of a sanitiser is otherwise the thing a reviewer stops on.

use std::path::{Path, PathBuf};

use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::store::{ByteStore, StoreFault, StoredBytes, UploadTarget};
use centraid_gateway_core::time::{Duration, ServerTime};

use crate::bytes::object_key;

/// How long an upload target is good for.
///
/// **Seven days, and the number is not a taste.** It must exceed the longest
/// background deferral a phone can be put through: an iOS device that has been
/// off charge and off Wi-Fi for a week comes back to finish a transfer, and a
/// target that expired in a pocket is a silent failure.
///
/// It used to cite SigV4's seven-day presign cap as the other half of the
/// reason. With the S3 byte store struck from v0 (scope amendment 2026-09-21)
/// nothing presigns anything — every target is a path on this server — so the
/// deferral is the whole of it, and it matches
/// `centraid_gateway_client::spool::LONGEST_DEFERRAL_MS`, which is the number
/// the phone compares against.
pub const TARGET_LIFETIME: Duration = Duration::from_days(7);

/// A directory of sealed objects.
#[derive(Debug)]
pub struct FilesystemBytes {
    root: PathBuf,
    /// The origin a proxied upload target is built on, e.g.
    /// `https://vault.example.org`. Empty for a store that is only ever driven
    /// in-process, as the conformance harness drives it.
    origin: String,
}

impl FilesystemBytes {
    /// Open or create the store.
    ///
    /// # Errors
    ///
    /// A store fault if the root cannot be created.
    pub fn open(root: &Path, origin: &str) -> Result<Self, StoreFault> {
        std::fs::create_dir_all(root).map_err(io)?;
        Ok(Self {
            root: root.to_path_buf(),
            origin: origin.trim_end_matches('/').to_owned(),
        })
    }

    fn path(&self, vault: &VaultId, name: &ObjectName) -> PathBuf {
        self.root.join(vault.hex()).join(name.hex())
    }

    /// The `PUT` a phone makes to a proxied target, as the server performs it.
    ///
    /// It records no attestation sidecar any more: the store-attested checksum
    /// and its "no checksum is a rejection" rule existed for a store the gateway
    /// could not read, and v0's store is a directory on the member's own
    /// laptop (scope amendment 2026-09-21). `stored` reads and hashes.
    ///
    /// # Errors
    ///
    /// A store fault if the bytes cannot be written.
    pub fn put(&self, vault: &VaultId, name: &ObjectName, bytes: &[u8]) -> Result<(), StoreFault> {
        let path = self.path(vault, name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        std::fs::write(&path, bytes).map_err(io)
    }

    /// Flip one stored object's first bit, for the scrub's own test.
    ///
    /// # Errors
    ///
    /// A store fault if the object cannot be read back or rewritten.
    pub fn corrupt(&self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        let path = self.path(vault, name);
        let mut bytes = std::fs::read(&path).map_err(io)?;
        if let Some(first) = bytes.first_mut() {
            *first ^= 0b0000_0001;
        }
        std::fs::write(&path, &bytes).map_err(io)
    }

    /// Every object the store holds. The canary's first window.
    ///
    /// # Errors
    ///
    /// A store fault if the tree cannot be walked.
    pub fn every_stored_object(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        let mut out = Vec::new();
        let Ok(vaults) = std::fs::read_dir(&self.root) else {
            return Ok(out);
        };
        for vault in vaults.flatten() {
            let Ok(objects) = std::fs::read_dir(vault.path()) else {
                continue;
            };
            for object in objects.flatten() {
                let path = object.path();
                out.push(std::fs::read(&path).map_err(io)?);
            }
        }
        out.sort();
        Ok(out)
    }

    /// The root, for an operator's `du` and for the canary's raw scan.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
}

fn io(error: std::io::Error) -> StoreFault {
    StoreFault::new(error.to_string())
}

impl ByteStore for FilesystemBytes {
    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        _padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault> {
        // A directory has nothing to presign, so the target is always a path on
        // this server and the bytes are always proxied. That is the DEFAULT for
        // the S3 store too; here it is the only possibility, and it is the
        // shape a self-hoster behind a tunnel needs.
        Ok(UploadTarget {
            name: *name,
            url: format!("{}/v1/objects/{}", self.origin, object_key(vault, name)),
            expires_at: now + TARGET_LIFETIME,
            already_committed: false,
        })
    }

    async fn stored(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredBytes>, StoreFault> {
        // READ AND HASH. There is one mode, and this is it: the name a commit
        // is judged against is computed from the bytes on disk, never read off
        // anything a client wrote.
        let Ok(bytes) = std::fs::read(self.path(vault, name)) else {
            return Ok(None);
        };
        Ok(Some(StoredBytes {
            name: ObjectName::of(&bytes),
            size: bytes.len() as u64,
        }))
    }

    async fn read(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<Vec<u8>>, StoreFault> {
        match std::fs::read(self.path(vault, name)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(error)),
        }
    }

    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        let path = self.path(vault, name);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io(error)),
        }
        Ok(())
    }
}
