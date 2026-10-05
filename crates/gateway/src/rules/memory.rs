//! The rules over memory: the reference target the suite runs first (#1080).
//!
//! [`MemoryState`] is [`State`] over ordered maps, with `atomically` as a copy
//! restored on error; [`MemoryTarget`] is the whole gateway — those rules, a
//! map of bytes, a clock that moves only when told and a deterministic
//! generator — behind the suite's [`Target`]. Nothing here waits on anything,
//! so its futures are ready on their first poll.

use std::collections::BTreeMap;

use crate::rules::bundle::Frame;
use crate::rules::code::Refusal;
use crate::rules::conformance::{Failure, PutAnswer, ScrubCounts, Target};
use crate::rules::engine::{Access, Arrival, Finding, Gateway, PutOutcome, examine};
use crate::rules::ids::{Digest, GatewayId, Name, Secret, SecretHash, Token, TokenHash, VaultId};
use crate::rules::range::{ByteRange, resolve};
use crate::rules::state::{
    Fault, HeadRecord, ObjectRecord, SecretRecord, State, StoreFault, TokenRecord, VaultRecord,
};
use crate::rules::wire::{
    BundleAnswer, DeleteAnswer, HeadView, Info, NameRefusal, ObjectEntry, PairRequest, Paired,
    SetHead, SnapshotView,
};

/// [`State`] over ordered maps.
#[derive(Debug, Clone, Default)]
pub struct MemoryState {
    vaults: BTreeMap<VaultId, VaultRecord>,
    tokens: BTreeMap<TokenHash, TokenRecord>,
    secrets: BTreeMap<SecretHash, SecretRecord>,
    heads: BTreeMap<VaultId, HeadRecord>,
    snapshots: BTreeMap<(VaultId, Name), SnapshotView>,
    objects: BTreeMap<(VaultId, Name), ObjectRecord>,
}

impl State for MemoryState {
    fn atomically<T>(
        &mut self,
        op: impl FnOnce(&mut Self) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let before = self.clone();
        let outcome = op(self);
        if outcome.is_err() {
            *self = before;
        }
        outcome
    }

    fn vault(&self, vault: &VaultId) -> Result<Option<VaultRecord>, StoreFault> {
        Ok(self.vaults.get(vault).copied())
    }

    fn put_vault(&mut self, record: &VaultRecord) -> Result<(), StoreFault> {
        self.vaults.insert(record.vault, *record);
        Ok(())
    }

    fn vaults(&self) -> Result<Vec<VaultRecord>, StoreFault> {
        Ok(self.vaults.values().copied().collect())
    }

    fn token(&self, hash: &TokenHash) -> Result<Option<TokenRecord>, StoreFault> {
        Ok(self.tokens.get(hash).cloned())
    }

    fn put_token(&mut self, record: &TokenRecord) -> Result<(), StoreFault> {
        self.tokens.insert(record.hash, record.clone());
        Ok(())
    }

    fn remove_token(&mut self, hash: &TokenHash) -> Result<bool, StoreFault> {
        Ok(self.tokens.remove(hash).is_some())
    }

    fn tokens(&self) -> Result<Vec<TokenRecord>, StoreFault> {
        let mut tokens: Vec<TokenRecord> = self.tokens.values().cloned().collect();
        tokens.sort_by_key(|token| (token.vault, token.created_at_ms, token.hash));
        Ok(tokens)
    }

    fn secret(&self, hash: &SecretHash) -> Result<Option<SecretRecord>, StoreFault> {
        Ok(self.secrets.get(hash).copied())
    }

    fn put_secret(&mut self, record: &SecretRecord) -> Result<(), StoreFault> {
        self.secrets.insert(record.hash, *record);
        Ok(())
    }

    fn secrets(&self) -> Result<Vec<SecretRecord>, StoreFault> {
        let mut secrets: Vec<SecretRecord> = self.secrets.values().copied().collect();
        secrets.sort_by_key(|secret| (secret.created_at_ms, secret.hash));
        Ok(secrets)
    }

    fn head(&self, vault: &VaultId) -> Result<Option<HeadRecord>, StoreFault> {
        Ok(self.heads.get(vault).copied())
    }

    fn put_head(&mut self, vault: &VaultId, head: &HeadRecord) -> Result<(), StoreFault> {
        self.heads.insert(*vault, *head);
        Ok(())
    }

    fn snapshots(&self, vault: &VaultId) -> Result<Vec<SnapshotView>, StoreFault> {
        let mut snapshots: Vec<SnapshotView> = self
            .snapshots
            .iter()
            .filter(|((owner, _), _)| owner == vault)
            .map(|(_, snapshot)| *snapshot)
            .collect();
        snapshots.sort_by_key(|snapshot| (snapshot.taken_at_ms, snapshot.name));
        Ok(snapshots)
    }

    fn put_snapshot(&mut self, vault: &VaultId, snapshot: &SnapshotView) -> Result<(), StoreFault> {
        self.snapshots
            .entry((*vault, snapshot.name))
            .or_insert(*snapshot);
        Ok(())
    }

    fn remove_snapshot(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault> {
        self.snapshots.remove(&(*vault, *name));
        Ok(())
    }

    fn object(&self, vault: &VaultId, name: &Name) -> Result<Option<ObjectRecord>, StoreFault> {
        Ok(self.objects.get(&(*vault, *name)).copied())
    }

    fn put_object(&mut self, vault: &VaultId, record: &ObjectRecord) -> Result<(), StoreFault> {
        self.objects.insert((*vault, record.name), *record);
        Ok(())
    }

    fn remove_object(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault> {
        self.objects.remove(&(*vault, *name));
        Ok(())
    }

    fn live_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault> {
        Ok(self
            .objects
            .range((*vault, Name::from_bytes([0; 32]))..)
            .take_while(|((owner, _), _)| owner == vault)
            .filter(|((_, name), record)| {
                after.is_none_or(|after| name > after) && record.tombstone.is_none()
            })
            .take(limit)
            .map(|(_, record)| *record)
            .collect())
    }

    fn all_objects(
        &self,
        after: Option<(&VaultId, &Name)>,
        limit: usize,
    ) -> Result<Vec<(VaultId, ObjectRecord)>, StoreFault> {
        Ok(self
            .objects
            .iter()
            .filter(|((vault, name), _)| after.is_none_or(|after| (vault, name) > after))
            .take(limit)
            .map(|((vault, _), record)| (*vault, *record))
            .collect())
    }

    fn purgeable(&self, now_ms: i64, limit: usize) -> Result<Vec<(VaultId, Name)>, StoreFault> {
        Ok(self
            .objects
            .iter()
            .filter(|(_, record)| {
                record
                    .tombstone
                    .is_some_and(|tombstone| tombstone.purge_after_ms <= now_ms)
            })
            .take(limit)
            .map(|((vault, name), _)| (*vault, *name))
            .collect())
    }
}

/// The reference gateway: the rules over memory, as a [`Target`].
#[derive(Debug)]
pub struct MemoryTarget {
    gateway: Gateway<MemoryState>,
    bytes: BTreeMap<(VaultId, Name), Vec<u8>>,
    now_ms: i64,
    draws: u64,
}

/// 2026-01-01T00:00:00Z: the reference clock starts somewhere real.
const START_MS: i64 = 1_767_225_600_000;

impl Default for MemoryTarget {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryTarget {
    /// A fresh gateway with a fixed id.
    #[must_use]
    pub fn new() -> Self {
        Self {
            gateway: Gateway::new(MemoryState::default(), GatewayId::from_bytes([0x6a; 16])),
            bytes: BTreeMap::new(),
            now_ms: START_MS,
            draws: 0,
        }
    }

    /// The gateway's rules and state, for a test that looks underneath.
    #[must_use]
    pub const fn gateway(&self) -> &Gateway<MemoryState> {
        &self.gateway
    }

    /// Deterministic "random" bytes: a reference run is reproducible.
    fn draw(&mut self) -> [u8; 32] {
        self.draws += 1;
        blake3::derive_key(
            "centraid gateway memory target draw",
            &self.draws.to_be_bytes(),
        )
    }

    /// One object through the same rule as `PUT`, the bytes landing in the
    /// map only when the rules say "store".
    fn put_one(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        declared: &Digest,
        bytes: &[u8],
    ) -> Result<PutOutcome, Fault> {
        let arrival = Arrival {
            name: *name,
            declared: *declared,
            digest: Digest::of(bytes),
            size: bytes.len() as u64,
        };
        let Self {
            gateway,
            bytes: held,
            now_ms,
            ..
        } = self;
        gateway.put(vault, token, &arrival, *now_ms, || {
            held.insert((*vault, *name), bytes.to_vec());
            Ok(())
        })
    }
}

fn failure(fault: Fault) -> Failure {
    match fault {
        Fault::Refused(refusal) => Failure::Refused(refusal),
        Fault::Store(store) => Failure::Broken(store.to_string()),
    }
}

fn answer(outcome: PutOutcome) -> PutAnswer {
    match outcome {
        PutOutcome::Stored(entry) => PutAnswer::Stored(entry),
        PutOutcome::AlreadyStored(entry) => PutAnswer::AlreadyStored(entry),
    }
}

impl Target for MemoryTarget {
    async fn reset(&mut self) -> Result<(), String> {
        *self = Self::new();
        Ok(())
    }

    fn gateway_id(&self) -> GatewayId {
        self.gateway.id()
    }

    async fn mint_secret(&mut self) -> Result<Secret, String> {
        let draw = self.draw();
        let secret = Secret::from_slice(&draw[..16]).ok_or("a 16-byte draw")?;
        self.gateway
            .mint_secret(&secret, self.now_ms)
            .map_err(|fault| fault.to_string())?;
        Ok(secret)
    }

    async fn advance(&mut self, ms: i64) {
        self.now_ms += ms;
    }

    async fn purge(&mut self) -> Result<u64, String> {
        let mut purged = 0;
        let due = self
            .gateway
            .purgeable(self.now_ms, usize::MAX)
            .map_err(|fault| fault.to_string())?;
        for (vault, name) in due {
            let Self {
                gateway,
                bytes,
                now_ms,
                ..
            } = self;
            if gateway
                .purge(&vault, &name, *now_ms, || {
                    bytes.remove(&(vault, name));
                    Ok(())
                })
                .map_err(|fault| fault.to_string())?
            {
                purged += 1;
            }
        }
        Ok(purged)
    }

    async fn scrub(&mut self) -> Result<ScrubCounts, String> {
        let mut counts = ScrubCounts::default();
        let page = self
            .gateway
            .scrub_page(None, usize::MAX)
            .map_err(|fault| fault.to_string())?;
        for (vault, record) in page {
            let found = self
                .bytes
                .get(&(vault, record.name))
                .map(|bytes| Digest::of(bytes));
            let finding = examine(&record.digest, found.as_ref());
            counts.read += 1;
            match finding {
                Finding::Intact => {}
                Finding::Corrupt => counts.corrupt += 1,
                Finding::Missing => counts.missing += 1,
            }
            self.gateway
                .record_scrub(&vault, &record, finding, self.now_ms)
                .map_err(|fault| fault.to_string())?;
        }
        Ok(counts)
    }

    async fn corrupt(&mut self, vault: &VaultId, name: &Name) -> Result<(), String> {
        let bytes = self
            .bytes
            .get_mut(&(*vault, *name))
            .ok_or("no such object to corrupt")?;
        if let Some(first) = bytes.first_mut() {
            *first ^= 1;
        }
        Ok(())
    }

    async fn at_rest(&mut self) -> Result<Vec<u8>, String> {
        let mut window = format!("{:?}", self.gateway.state).into_bytes();
        for ((vault, name), bytes) in &self.bytes {
            window.extend_from_slice(format!("{vault}/{name}").as_bytes());
            window.extend_from_slice(bytes);
        }
        Ok(window)
    }

    async fn info(&mut self) -> Result<Info, Failure> {
        Ok(self.gateway.info(self.now_ms))
    }

    async fn pair(&mut self, request: &PairRequest) -> Result<Paired, Failure> {
        let token = Token::from_bytes(self.draw());
        self.gateway
            .pair(request, &token, self.now_ms)
            .map_err(failure)
    }

    async fn head(&mut self, token: &Token, vault: &VaultId) -> Result<HeadView, Failure> {
        self.gateway.head(vault, token).map_err(failure)
    }

    async fn set_head(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &SetHead,
    ) -> Result<HeadView, Failure> {
        self.gateway
            .set_head(vault, token, request, self.now_ms)
            .map_err(failure)
    }

    async fn snapshots(
        &mut self,
        token: &Token,
        vault: &VaultId,
    ) -> Result<Vec<SnapshotView>, Failure> {
        self.gateway.snapshots(vault, token).map_err(failure)
    }

    async fn exists(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Name>, Failure> {
        self.gateway.exists(vault, token, names).map_err(failure)
    }

    async fn put(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        bytes: &[u8],
    ) -> Result<PutAnswer, Failure> {
        self.put_one(token, vault, name, digest, bytes)
            .map(answer)
            .map_err(failure)
    }

    async fn get(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>, Failure> {
        let record = self.gateway.object(vault, token, name).map_err(failure)?;
        let bytes = self
            .bytes
            .get(&(*vault, *name))
            .ok_or(Refusal::NotFound { name: Some(*name) })?;
        let header = range.map(|range| range.header());
        Ok(match resolve(header.as_deref(), record.size)? {
            None => bytes.clone(),
            Some(span) => {
                let first = usize::try_from(span.first).unwrap_or(usize::MAX);
                let last = usize::try_from(span.last).unwrap_or(usize::MAX);
                bytes[first..=last].to_vec()
            }
        })
    }

    async fn stat(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
    ) -> Result<(u64, Digest), Failure> {
        let record = self.gateway.object(vault, token, name).map_err(failure)?;
        Ok((record.size, record.digest))
    }

    async fn bundle(
        &mut self,
        token: &Token,
        vault: &VaultId,
        frames: &[Frame],
    ) -> Result<BundleAnswer, Failure> {
        self.gateway
            .authorize(vault, token, Access::Write)
            .map_err(failure)?;
        let mut answer = BundleAnswer::default();
        for frame in frames {
            match self.put_one(token, vault, &frame.name, &frame.digest, &frame.bytes) {
                Ok(PutOutcome::Stored(_)) => answer.stored.push(frame.name),
                Ok(PutOutcome::AlreadyStored(_)) => answer.already.push(frame.name),
                Err(Fault::Refused(refusal)) => answer.refused.push(NameRefusal {
                    name: frame.name,
                    code: refusal.code(),
                }),
                Err(Fault::Store(store)) => return Err(Failure::Broken(store.to_string())),
            }
        }
        Ok(answer)
    }

    async fn fetch(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Frame>, Failure> {
        let plan = self.gateway.fetch(vault, token, names).map_err(failure)?;
        Ok(plan
            .into_iter()
            .filter_map(|record| {
                self.bytes.get(&(*vault, record.name)).map(|bytes| Frame {
                    name: record.name,
                    digest: record.digest,
                    bytes: bytes.clone(),
                })
            })
            .collect())
    }

    async fn objects(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectEntry>, Failure> {
        self.gateway
            .objects(vault, token, after, limit)
            .map_err(failure)
    }

    async fn delete(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<DeleteAnswer, Failure> {
        self.gateway
            .delete(vault, token, names, self.now_ms)
            .map_err(failure)
    }

    async fn revoke(&mut self, token: &Token, vault: &VaultId) -> Result<(), Failure> {
        self.gateway.revoke(vault, token).map_err(failure)
    }
}
