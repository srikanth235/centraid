//! An in-memory adapter, so the conformance suite has something to run against
//! in this crate.
//!
//! **It is a harness, not a deployment.** It holds no file, opens no socket and
//! keeps nothing after the process ends — the two real adapters are W4b's
//! standalone server and W4c's Worker, and neither of them is here.
//!
//! What it is *for* is proving that the suite runs against the ports rather
//! than against one adapter's internals: a suite that only passes on the
//! implementation it was written beside proves nothing about the other one. It
//! also carries the honest version of the checksum modes — the same object
//! store answers [`ChecksumEvidence::Attested`] or
//! [`ChecksumEvidence::ReadAndHashed`] depending on how it was built, which is
//! exactly the difference between R2 and a MinIO that does not attest.

use std::collections::BTreeMap;

use crate::checksum::{AttestedChecksum, ChecksumEvidence, ChecksumMode};
use crate::commit;
use crate::ids::{ObjectName, VaultId};
use crate::retention::BaseRecord;
use crate::store::{ByteStore, StateStore, StoreFault, StoredObject, UploadTarget, VaultState};
use crate::time::{Duration, ServerTime};

/// How long an in-memory presigned target is good for. The real adapters use
/// something that exceeds the longest background deferral a phone can be put
/// through; this only has to be non-zero.
const TARGET_LIFETIME: Duration = Duration::from_days(7);

/// The state store, in memory.
#[derive(Debug, Default)]
pub struct MemoryState {
    vaults: BTreeMap<VaultId, VaultState>,
    objects: BTreeMap<(VaultId, ObjectName), StoredObject>,
    bases: BTreeMap<(VaultId, ObjectName), BaseRecord>,
    client_base_deletes: BTreeMap<VaultId, ServerTime>,
}

impl MemoryState {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Put a vault in without going through a rule. The adapter's registration
    /// path does this; the suite uses it to set a vault up.
    pub fn register(&mut self, state: VaultState) {
        self.vaults.insert(state.vault, state);
    }
}

impl StateStore for MemoryState {
    async fn vault(&self, vault: &VaultId) -> Result<Option<VaultState>, StoreFault> {
        Ok(self.vaults.get(vault).cloned())
    }

    async fn put_vault(&mut self, state: &VaultState) -> Result<(), StoreFault> {
        self.vaults.insert(state.vault, state.clone());
        Ok(())
    }

    async fn object(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredObject>, StoreFault> {
        Ok(self.objects.get(&(*vault, *name)).cloned())
    }

    async fn put_object(
        &mut self,
        vault: &VaultId,
        object: &StoredObject,
    ) -> Result<(), StoreFault> {
        self.objects.insert((*vault, object.name), object.clone());
        Ok(())
    }

    async fn objects(&self, vault: &VaultId) -> Result<Vec<StoredObject>, StoreFault> {
        Ok(self
            .objects
            .iter()
            .filter(|((held, _), _)| held == vault)
            .map(|(_, object)| object.clone())
            .collect())
    }

    async fn bases(&self, vault: &VaultId) -> Result<Vec<BaseRecord>, StoreFault> {
        Ok(self
            .bases
            .iter()
            .filter(|((held, _), _)| held == vault)
            .map(|(_, base)| base.clone())
            .collect())
    }

    async fn put_base(&mut self, vault: &VaultId, base: &BaseRecord) -> Result<(), StoreFault> {
        self.bases.insert((*vault, base.id), base.clone());
        Ok(())
    }

    /// THE COMPARE-AND-SET, THROUGH THE ONE RULE.
    ///
    /// `&mut self` is this adapter's atomicity: the borrow checker is the lock.
    /// A Durable Object gets the same property from running one request at a
    /// time, and the standalone adapter from an immediate transaction — three
    /// mechanisms, one rule, and the rule is
    /// [`crate::commit::compare_and_set`] in every case.
    async fn compare_and_set_head(
        &mut self,
        vault: &VaultId,
        expected: Option<ObjectName>,
        next: ObjectName,
    ) -> Result<Option<ObjectName>, StoreFault> {
        let Some(state) = self.vaults.get_mut(vault) else {
            return Err(StoreFault::new("no such vault"));
        };
        if commit::compare_and_set(state.head, expected, next).is_ok() {
            state.head = Some(next);
        }
        Ok(state.head)
    }

    async fn last_client_base_delete(
        &self,
        vault: &VaultId,
    ) -> Result<Option<ServerTime>, StoreFault> {
        Ok(self.client_base_deletes.get(vault).copied())
    }

    async fn record_client_base_delete(
        &mut self,
        vault: &VaultId,
        at: ServerTime,
    ) -> Result<(), StoreFault> {
        self.client_base_deletes.insert(*vault, at);
        Ok(())
    }
}

/// The byte store, in memory, in one of the two checksum modes.
#[derive(Debug)]
pub struct MemoryBytes {
    mode: ChecksumMode,
    blobs: BTreeMap<(VaultId, ObjectName), Vec<u8>>,
    /// Names whose stored bytes carry no attestation.
    ///
    /// **R2 records the attested checksum only when the client sent it**, so this
    /// is not a contrived state: it is what a real bucket looks like after an
    /// upload that omitted the header, and the suite needs to be able to build
    /// one.
    unattested: Vec<(VaultId, ObjectName)>,
}

impl MemoryBytes {
    /// A store in the given mode.
    #[must_use]
    pub fn new(mode: ChecksumMode) -> Self {
        Self {
            mode,
            blobs: BTreeMap::new(),
            unattested: Vec::new(),
        }
    }

    /// The `PUT` the phone would make to the presigned target.
    pub fn upload(&mut self, vault: VaultId, name: ObjectName, bytes: Vec<u8>) {
        self.blobs.insert((vault, name), bytes);
    }

    /// The same upload, by a client that sent no checksum header.
    pub fn upload_without_attestation(&mut self, vault: VaultId, name: ObjectName, bytes: Vec<u8>) {
        self.unattested.push((vault, name));
        self.blobs.insert((vault, name), bytes);
    }

    /// Flip one stored object's bits, for the scrub.
    pub fn corrupt(&mut self, vault: VaultId, name: ObjectName) {
        if let Some(bytes) = self.blobs.get_mut(&(vault, name))
            && let Some(first) = bytes.first_mut()
        {
            *first ^= 0b0000_0001;
        }
    }

    /// Everything the store holds, for the canary.
    pub fn stored(&self) -> impl Iterator<Item = (&(VaultId, ObjectName), &Vec<u8>)> {
        self.blobs.iter()
    }
}

impl ByteStore for MemoryBytes {
    fn checksum_mode(&self) -> ChecksumMode {
        self.mode
    }

    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        _padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault> {
        Ok(UploadTarget {
            name: *name,
            url: format!("memory://{}/{}", vault.hex(), name.hex()),
            expires_at: now + TARGET_LIFETIME,
            already_committed: false,
        })
    }

    async fn evidence(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<ChecksumEvidence, StoreFault> {
        let Some(bytes) = self.blobs.get(&(*vault, *name)) else {
            return Ok(ChecksumEvidence::None);
        };
        if self.unattested.contains(&(*vault, *name)) {
            return Ok(ChecksumEvidence::None);
        }
        let stored_size = bytes.len() as u64;
        Ok(match self.mode {
            ChecksumMode::Attest => ChecksumEvidence::Attested {
                checksum: AttestedChecksum::of(bytes),
                stored_size,
            },
            ChecksumMode::ReadAndHash => ChecksumEvidence::ReadAndHashed {
                checksum: AttestedChecksum::of(bytes),
                name: ObjectName::of(bytes),
                stored_size,
            },
        })
    }

    async fn read(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<Vec<u8>>, StoreFault> {
        Ok(self.blobs.get(&(*vault, *name)).cloned())
    }

    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        self.blobs.remove(&(*vault, *name));
        Ok(())
    }
}
