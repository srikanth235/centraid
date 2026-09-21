//! The store an operator actually configured, and the optional mirror beside
//! it (#1029 §3).
//!
//! The rules are generic over `ByteStore`, so nothing above this file knows
//! where the bytes are. What this file adds is the
//! two things a *deployment* needs and a rule must never see:
//!
//! 1. **One type for the backend**, so the HTTP surface and the sweeps are
//!    not generic over a choice made in a config file;
//! 2. **A second store beside the first**, which is what makes the blind scrub
//!    able to *repair* rather than only report.
//!
//! # THE MIRROR IS A DEPLOYMENT DETAIL AND NOT A RULE
//!
//! `crates/gateway-core/src/scrub.rs` says so in as many words: "The schedule,
//! the batch size and the second replica are the adapter's… What is here is the
//! verdict." So the mirror is written to on every proxied upload, read from
//! only when the primary has nothing or has rot, and never consulted by a rule.
//! A corrupt object repaired from the mirror is still a corrupt object in the
//! scrub's report — the report says what was found, and the repair is what the
//! operator's sweep did about it.
//!
//! **The mirror does not change what the gateway can see.** Both copies are the
//! same ciphertext under the same name; a second store is a second place that
//! holds bytes nobody there can open.

use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::scrub;
use centraid_gateway_core::store::{ByteStore, StoreFault, StoredBytes, UploadTarget};
use centraid_gateway_core::time::ServerTime;

use crate::bytes::ProxyWrite;
use crate::bytes::fs::FilesystemBytes;

/// One backend.
#[derive(Debug)]
pub enum Backend {
    /// A directory. The default for a home box.
    Filesystem(FilesystemBytes),
}

impl ByteStore for Backend {
    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault> {
        match self {
            Self::Filesystem(store) => store.presign_put(vault, name, padded_size, now).await,
        }
    }

    async fn stored(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredBytes>, StoreFault> {
        match self {
            Self::Filesystem(store) => store.stored(vault, name).await,
        }
    }

    async fn read(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<Vec<u8>>, StoreFault> {
        match self {
            Self::Filesystem(store) => store.read(vault, name).await,
        }
    }

    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        match self {
            Self::Filesystem(store) => store.purge(vault, name).await,
        }
    }
}

impl ProxyWrite for Backend {
    async fn write(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        bytes: Vec<u8>,
    ) -> Result<(), StoreFault> {
        match self {
            Self::Filesystem(store) => store.put(vault, name, &bytes),
        }
    }
}

impl Backend {
    /// Every object this backend holds, for the canary.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn every_stored_object(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        match self {
            Self::Filesystem(store) => store.every_stored_object(),
        }
    }

    /// Flip one stored object's bits, for the scrub's own test.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn corrupt(&self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        match self {
            Self::Filesystem(store) => store.corrupt(vault, name),
        }
    }
}

/// The primary store, and the mirror if the operator configured one.
#[derive(Debug)]
pub struct ConfiguredBytes {
    primary: Backend,
    mirror: Option<Backend>,
}

impl ConfiguredBytes {
    /// One store, no mirror.
    #[must_use]
    pub const fn new(primary: Backend) -> Self {
        Self {
            primary,
            mirror: None,
        }
    }

    /// One store with a second beside it.
    #[must_use]
    pub const fn mirrored(primary: Backend, mirror: Backend) -> Self {
        Self {
            primary,
            mirror: Some(mirror),
        }
    }

    /// The primary, for the reads that are a deployment's and not a rule's.
    #[must_use]
    pub const fn primary(&self) -> &Backend {
        &self.primary
    }

    /// Is there a mirror to repair from?
    #[must_use]
    pub const fn has_mirror(&self) -> bool {
        self.mirror.is_some()
    }

    /// **REPAIR ONE OBJECT FROM THE MIRROR.**
    ///
    /// The scrub reports; this is what an operator's sweep does about a report.
    /// The mirror's copy is accepted only if it hashes to the name — a repair
    /// that copied the wrong bytes over the right ones would be the scrub doing
    /// the damage it exists to find, and the check needs no key.
    ///
    /// Returns whether the object was repaired.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn repair(&self, vault: &VaultId, name: &ObjectName) -> Result<bool, StoreFault> {
        let Some(mirror) = &self.mirror else {
            return Ok(false);
        };
        let Some(bytes) = mirror.read(vault, name).await? else {
            return Ok(false);
        };
        if scrub::examine(*name, Some(&bytes)) != scrub::Finding::Intact {
            return Ok(false);
        }
        self.primary.write(vault, name, bytes).await?;
        Ok(true)
    }
}

impl ByteStore for ConfiguredBytes {
    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault> {
        self.primary
            .presign_put(vault, name, padded_size, now)
            .await
    }

    async fn stored(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredBytes>, StoreFault> {
        self.primary.stored(vault, name).await
    }

    async fn read(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<Vec<u8>>, StoreFault> {
        // The primary answers, including when it answers with rot: the scrub's
        // verdict is about what the PRIMARY holds, and silently substituting
        // the mirror would make a store that is quietly rotting look clean
        // forever.
        self.primary.read(vault, name).await
    }

    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        self.primary.purge(vault, name).await?;
        if let Some(mirror) = &mut self.mirror {
            // A tombstone that lapsed is a tombstone in both copies. A mirror
            // that kept what the primary purged would be a delete that did not
            // happen, which is the one thing a member cannot check.
            mirror.purge(vault, name).await?;
        }
        Ok(())
    }
}

impl ProxyWrite for ConfiguredBytes {
    async fn write(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        bytes: Vec<u8>,
    ) -> Result<(), StoreFault> {
        self.primary.write(vault, name, bytes.clone()).await?;
        if let Some(mirror) = &self.mirror {
            mirror.write(vault, name, bytes).await?;
        }
        Ok(())
    }
}
