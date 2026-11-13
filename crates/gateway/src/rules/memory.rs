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
use crate::rules::engine::{Arrival, Finding, Gateway, Operated, PutOutcome, examine};
use crate::rules::ids::{Digest, GatewayId, Name, Secret, SecretHash, Token, TokenHash, VaultId};
use crate::rules::range::{ByteRange, resolve};
use crate::rules::state::{
    ClaimRecord, Fault, HeadRecord, Hold, ObjectRecord, RevokedToken, SecretRecord, SnapshotRecord,
    State, StoreFault, TokenRecord, VaultRecord,
};
use crate::rules::wire::{
    BundleAnswer, DeleteAnswer, DeleteRequest, HeadView, HeldEntry, Info, NameRefusal, NonceAnswer,
    ObjectEntry, PairRequest, Paired, SetHead, SnapshotView, UndoRequest, Undone,
};

/// [`State`] over ordered maps.
#[derive(Debug, Clone, Default)]
pub struct MemoryState {
    vaults: BTreeMap<VaultId, VaultRecord>,
    tokens: BTreeMap<TokenHash, TokenRecord>,
    revoked: BTreeMap<TokenHash, RevokedToken>,
    claims: BTreeMap<VaultId, ClaimRecord>,
    nonces: BTreeMap<[u8; 16], i64>,
    secrets: BTreeMap<SecretHash, SecretRecord>,
    heads: BTreeMap<VaultId, HeadRecord>,
    snapshots: BTreeMap<(VaultId, Name), SnapshotRecord>,
    objects: BTreeMap<(VaultId, Name), ObjectRecord>,
}

impl MemoryState {
    /// The epochs of a vault's tokens, for the suite's probes.
    #[must_use]
    pub fn token_epochs(&self, vault: &VaultId) -> Vec<u64> {
        self.tokens
            .values()
            .filter(|token| token.vault == *vault)
            .map(|token| token.epoch)
            .collect()
    }

    /// How many revoked-token tombstones a vault keeps.
    #[must_use]
    pub fn revoked_count(&self, vault: &VaultId) -> u64 {
        self.revoked
            .values()
            .filter(|revoked| revoked.vault == *vault)
            .count() as u64
    }

    /// The nonce table's rows as bytes, for the suite's probes.
    #[must_use]
    pub fn nonce_rows(&self) -> Vec<Vec<u8>> {
        self.nonces
            .iter()
            .map(|(nonce, at)| {
                let mut row = nonce.to_vec();
                row.extend_from_slice(&at.to_be_bytes());
                row
            })
            .collect()
    }

    fn held_rows(&self, vault: &VaultId) -> impl Iterator<Item = &ObjectRecord> {
        self.objects
            .range((*vault, Name::from_bytes([0; 32]))..)
            .take_while(move |((owner, _), _)| owner == vault)
            .map(|(_, record)| record)
    }
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

    fn vaults(
        &self,
        after: Option<&VaultId>,
        limit: usize,
    ) -> Result<Vec<VaultRecord>, StoreFault> {
        Ok(self
            .vaults
            .values()
            .filter(|record| after.is_none_or(|after| record.vault > *after))
            .take(limit)
            .copied()
            .collect())
    }

    fn remove_vault(&mut self, vault: &VaultId) -> Result<(), StoreFault> {
        self.vaults.remove(vault);
        self.tokens.retain(|_, token| token.vault != *vault);
        self.revoked.retain(|_, token| token.vault != *vault);
        self.claims.remove(vault);
        self.heads.remove(vault);
        self.snapshots.retain(|(owner, _), _| owner != vault);
        self.objects.retain(|(owner, _), _| owner != vault);
        Ok(())
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

    fn tokens_of(
        &self,
        vault: &VaultId,
        after: Option<(i64, &TokenHash)>,
        limit: usize,
    ) -> Result<Vec<TokenRecord>, StoreFault> {
        let mut tokens: Vec<TokenRecord> = self
            .tokens
            .values()
            .filter(|token| token.vault == *vault)
            .filter(|token| {
                after.is_none_or(|(at, hash)| (token.created_at_ms, token.hash) > (at, *hash))
            })
            .cloned()
            .collect();
        tokens.sort_by_key(|token| (token.created_at_ms, token.hash));
        tokens.truncate(limit);
        Ok(tokens)
    }

    fn take_tokens(&mut self, vault: &VaultId) -> Result<Vec<TokenRecord>, StoreFault> {
        let mut taken: Vec<TokenRecord> = self
            .tokens
            .values()
            .filter(|token| token.vault == *vault)
            .cloned()
            .collect();
        taken.sort_by_key(|token| (token.created_at_ms, token.hash));
        self.tokens.retain(|_, token| token.vault != *vault);
        Ok(taken)
    }

    fn revoked_token(&self, hash: &TokenHash) -> Result<Option<RevokedToken>, StoreFault> {
        Ok(self.revoked.get(hash).copied())
    }

    fn put_revoked(&mut self, record: &RevokedToken) -> Result<(), StoreFault> {
        self.revoked.insert(record.hash, *record);
        Ok(())
    }

    fn trim_revoked(&mut self, vault: &VaultId, keep: u64) -> Result<(), StoreFault> {
        // Writers' tombstones (epoch 1 and up) outlive read grants' (epoch 0):
        // the superseded writer must always hear MOVED.
        let mut mine: Vec<(u64, i64, TokenHash)> = self
            .revoked
            .values()
            .filter(|revoked| revoked.vault == *vault)
            .map(|revoked| (revoked.epoch, revoked.revoked_at_ms, revoked.hash))
            .collect();
        mine.sort_unstable_by(|left, right| right.cmp(left));
        for (_, _, hash) in mine
            .into_iter()
            .skip(usize::try_from(keep).unwrap_or(usize::MAX))
        {
            self.revoked.remove(&hash);
        }
        Ok(())
    }

    fn prune_revoked(&mut self, before_ms: i64) -> Result<u64, StoreFault> {
        let before = self.revoked.len();
        self.revoked
            .retain(|_, revoked| revoked.revoked_at_ms > before_ms);
        Ok((before - self.revoked.len()) as u64)
    }

    fn claim(&self, vault: &VaultId) -> Result<Option<ClaimRecord>, StoreFault> {
        Ok(self.claims.get(vault).copied())
    }

    fn put_claim(&mut self, record: &ClaimRecord) -> Result<(), StoreFault> {
        self.claims.insert(record.vault, *record);
        Ok(())
    }

    fn spend_nonce(&mut self, id: &[u8; 16], issued_at_ms: i64) -> Result<bool, StoreFault> {
        Ok(self.nonces.insert(*id, issued_at_ms).is_none())
    }

    fn live_nonces(&self, not_before_ms: i64) -> Result<u64, StoreFault> {
        Ok(self
            .nonces
            .values()
            .filter(|issued| **issued > not_before_ms)
            .count() as u64)
    }

    fn prune_nonces(&mut self, before_ms: i64) -> Result<u64, StoreFault> {
        let before = self.nonces.len();
        self.nonces.retain(|_, issued| *issued > before_ms);
        Ok((before - self.nonces.len()) as u64)
    }

    fn secret(&self, hash: &SecretHash) -> Result<Option<SecretRecord>, StoreFault> {
        Ok(self.secrets.get(hash).copied())
    }

    fn put_secret(&mut self, record: &SecretRecord) -> Result<(), StoreFault> {
        self.secrets.insert(record.hash, *record);
        Ok(())
    }

    fn secrets(
        &self,
        after: Option<(i64, &SecretHash)>,
        limit: usize,
    ) -> Result<Vec<SecretRecord>, StoreFault> {
        let mut secrets: Vec<SecretRecord> = self
            .secrets
            .values()
            .filter(|secret| {
                after.is_none_or(|(at, hash)| (secret.created_at_ms, secret.hash) > (at, *hash))
            })
            .copied()
            .collect();
        secrets.sort_by_key(|secret| (secret.created_at_ms, secret.hash));
        secrets.truncate(limit);
        Ok(secrets)
    }

    fn live_secrets(&self, now_ms: i64) -> Result<u64, StoreFault> {
        Ok(self
            .secrets
            .values()
            .filter(|secret| secret.is_live(now_ms))
            .count() as u64)
    }

    fn oldest_live_secret(&self, now_ms: i64) -> Result<Option<SecretRecord>, StoreFault> {
        Ok(self
            .secrets
            .values()
            .filter(|secret| secret.is_live(now_ms))
            .min_by_key(|secret| (secret.created_at_ms, secret.hash))
            .copied())
    }

    fn remove_secret(&mut self, hash: &SecretHash) -> Result<(), StoreFault> {
        self.secrets.remove(hash);
        Ok(())
    }

    fn prune_secrets(
        &mut self,
        used_before_ms: i64,
        expired_before_ms: i64,
    ) -> Result<u64, StoreFault> {
        let before = self.secrets.len();
        self.secrets.retain(|_, secret| match secret.used_at_ms {
            Some(used) => used > used_before_ms,
            None => secret.expires_at_ms > expired_before_ms,
        });
        Ok((before - self.secrets.len()) as u64)
    }

    fn head(&self, vault: &VaultId) -> Result<Option<HeadRecord>, StoreFault> {
        Ok(self.heads.get(vault).copied())
    }

    fn put_head(&mut self, vault: &VaultId, head: &HeadRecord) -> Result<(), StoreFault> {
        self.heads.insert(*vault, *head);
        Ok(())
    }

    fn snapshot(&self, vault: &VaultId, name: &Name) -> Result<Option<SnapshotRecord>, StoreFault> {
        Ok(self.snapshots.get(&(*vault, *name)).copied())
    }

    fn snapshots(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<SnapshotRecord>, StoreFault> {
        Ok(self
            .snapshots
            .range((*vault, Name::from_bytes([0; 32]))..)
            .take_while(|((owner, _), _)| owner == vault)
            .filter(|((_, name), _)| after.is_none_or(|after| name > after))
            .take(limit)
            .map(|(_, snapshot)| *snapshot)
            .collect())
    }

    fn put_snapshot(
        &mut self,
        vault: &VaultId,
        snapshot: &SnapshotRecord,
    ) -> Result<(), StoreFault> {
        let registered = self
            .snapshots
            .get(&(*vault, snapshot.name))
            .map(|held| held.registered_at_ms);
        let mut record = *snapshot;
        if let Some(registered) = registered {
            record.registered_at_ms = registered;
        }
        self.snapshots.insert((*vault, snapshot.name), record);
        Ok(())
    }

    fn remove_snapshot(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault> {
        self.snapshots.remove(&(*vault, *name));
        Ok(())
    }

    fn remove_heads_and_snapshots(&mut self, vault: &VaultId) -> Result<(), StoreFault> {
        self.heads.remove(vault);
        self.snapshots.retain(|(owner, _), _| owner != vault);
        self.claims.remove(vault);
        self.revoked.retain(|_, token| token.vault != *vault);
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

    fn set_hold(
        &mut self,
        vault: &VaultId,
        name: &Name,
        hold: Option<Hold>,
    ) -> Result<(), StoreFault> {
        if let Some(object) = self.objects.get_mut(&(*vault, *name)) {
            object.hold = hold;
        }
        if let Some(snapshot) = self.snapshots.get_mut(&(*vault, *name)) {
            snapshot.hold = hold;
        }
        Ok(())
    }

    fn live_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault> {
        Ok(self
            .held_rows(vault)
            .filter(|record| {
                after.is_none_or(|after| record.name > *after) && record.hold.is_none()
            })
            .take(limit)
            .copied()
            .collect())
    }

    fn held_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault> {
        Ok(self
            .held_rows(vault)
            .filter(|record| {
                after.is_none_or(|after| record.name > *after) && record.hold.is_some()
            })
            .take(limit)
            .copied()
            .collect())
    }

    fn vault_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault> {
        Ok(self
            .held_rows(vault)
            .filter(|record| after.is_none_or(|after| record.name > *after))
            .take(limit)
            .copied()
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

    fn purgeable(
        &self,
        after: Option<(i64, &VaultId, &Name)>,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<(i64, VaultId, Name)>, StoreFault> {
        let mut due: Vec<(i64, VaultId, Name)> = self
            .objects
            .iter()
            .filter_map(|((vault, name), record)| {
                record
                    .hold
                    .filter(|hold| hold.purge_after_ms <= now_ms)
                    .map(|hold| (hold.purge_after_ms, *vault, *name))
            })
            .filter(|(at, vault, name)| {
                after.is_none_or(|(a, v, n)| (*at, *vault, *name) > (a, *v, *n))
            })
            .collect();
        due.sort_unstable();
        due.truncate(limit);
        Ok(due)
    }

    fn clear_holds(&mut self, vault: &VaultId) -> Result<u64, StoreFault> {
        let mut cleared = 0;
        for ((owner, _), object) in &mut self.objects {
            if owner == vault && object.hold.take().is_some() {
                cleared += 1;
            }
        }
        for ((owner, _), snapshot) in &mut self.snapshots {
            if owner == vault {
                snapshot.hold = None;
            }
        }
        Ok(cleared)
    }

    fn shift_holds(&mut self, vault: &VaultId, delta_ms: i64) -> Result<(), StoreFault> {
        let shift = |hold: &mut Option<Hold>| {
            if let Some(hold) = hold {
                hold.purge_after_ms = hold.purge_after_ms.saturating_add(delta_ms);
            }
        };
        for ((owner, _), object) in &mut self.objects {
            if owner == vault {
                shift(&mut object.hold);
            }
        }
        for ((owner, _), snapshot) in &mut self.snapshots {
            if owner == vault {
                shift(&mut snapshot.hold);
            }
        }
        Ok(())
    }

    fn make_holds_due(&mut self, vault: &VaultId, due_ms: i64) -> Result<u64, StoreFault> {
        let mut made = 0;
        for ((owner, _), object) in &mut self.objects {
            if owner == vault
                && let Some(hold) = &mut object.hold
            {
                hold.purge_after_ms = due_ms;
                made += 1;
            }
        }
        for ((owner, _), snapshot) in &mut self.snapshots {
            if owner == vault
                && let Some(hold) = &mut snapshot.hold
            {
                hold.purge_after_ms = due_ms;
            }
        }
        Ok(made)
    }

    fn shift_all_holds(&mut self, delta_ms: i64) -> Result<(), StoreFault> {
        for object in self.objects.values_mut() {
            if let Some(hold) = &mut object.hold {
                hold.purge_after_ms = hold.purge_after_ms.saturating_add(delta_ms);
            }
        }
        for snapshot in self.snapshots.values_mut() {
            if let Some(hold) = &mut snapshot.hold {
                hold.purge_after_ms = hold.purge_after_ms.saturating_add(delta_ms);
            }
        }
        Ok(())
    }
}

/// The reference gateway: the rules over memory, as a [`Target`].
#[derive(Debug)]
pub struct MemoryTarget {
    gateway: Gateway<MemoryState>,
    bytes: BTreeMap<(VaultId, Name), Vec<u8>>,
    now_ms: i64,
    draws: u64,
    /// When the purge sweep last ran, as `sweeps.json` records it.
    last_purge_ms: i64,
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
            gateway: Gateway::new(
                MemoryState::default(),
                GatewayId::from_bytes([0x6a; 16]),
                [0x4e; 32],
            ),
            bytes: BTreeMap::new(),
            now_ms: START_MS,
            draws: 0,
            last_purge_ms: START_MS,
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
        let now = self.now_ms;
        self.gateway
            .account_for_gap(self.last_purge_ms, now)
            .map_err(|fault| fault.to_string())?;
        let mut cursor: Option<(i64, VaultId, Name)> = None;
        loop {
            let due = self
                .gateway
                .purgeable(
                    cursor.as_ref().map(|(at, vault, name)| (*at, vault, name)),
                    now,
                    64,
                )
                .map_err(|fault| fault.to_string())?;
            let Some(last) = due.last().copied() else {
                break;
            };
            cursor = Some(last);
            for (_, vault, name) in due {
                let Self { gateway, bytes, .. } = self;
                if gateway
                    .purge(&vault, &name, now, || {
                        bytes.remove(&(vault, name));
                        Ok(())
                    })
                    .map_err(|fault| fault.to_string())?
                {
                    purged += 1;
                }
            }
        }
        self.gateway.prune(now).map_err(|fault| fault.to_string())?;
        self.last_purge_ms = now;
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
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<SnapshotView>, Failure> {
        self.gateway
            .snapshots(vault, token, after, limit)
            .map_err(failure)
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
        let arrivals: Vec<Arrival> = frames
            .iter()
            .map(|frame| Arrival {
                name: frame.name,
                declared: frame.digest,
                digest: Digest::of(&frame.bytes),
                size: frame.bytes.len() as u64,
            })
            .collect();
        let Self {
            gateway,
            bytes,
            now_ms,
            ..
        } = self;
        let outcomes = gateway
            .put_bundle(vault, token, &arrivals, *now_ms, |index| {
                let frame = &frames[index];
                bytes.insert((*vault, frame.name), frame.bytes.clone());
                Ok(())
            })
            .map_err(failure)?;
        let mut answer = BundleAnswer::default();
        for (frame, outcome) in frames.iter().zip(outcomes) {
            match outcome {
                Ok(PutOutcome::Stored(_)) => answer.stored.push(frame.name),
                Ok(PutOutcome::AlreadyStored(_)) => answer.already.push(frame.name),
                Err(refusal) => answer.refused.push(NameRefusal::of(frame.name, &refusal)),
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
        request: &DeleteRequest,
    ) -> Result<DeleteAnswer, Failure> {
        let Self { gateway, bytes, .. } = self;
        gateway
            .delete(vault, token, request, self.now_ms, |name| {
                bytes.remove(&(*vault, *name));
                Ok(())
            })
            .map_err(failure)
    }

    async fn undo(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &UndoRequest,
    ) -> Result<Undone, Failure> {
        self.gateway.undo(vault, token, request).map_err(failure)
    }

    async fn held(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<HeldEntry>, Failure> {
        self.gateway
            .held(vault, token, after, limit)
            .map_err(failure)
    }

    async fn nonce(&mut self) -> Result<NonceAnswer, Failure> {
        let draw = self.draw();
        let mut random = [0_u8; 16];
        random.copy_from_slice(&draw[..16]);
        self.gateway
            .issue_nonce(random, self.now_ms)
            .map_err(failure)
    }

    async fn freeze(&mut self, vault: &VaultId) -> Result<(), String> {
        match self
            .gateway
            .freeze(vault, self.now_ms)
            .map_err(|fault| fault.to_string())?
        {
            Operated::Done(()) => Ok(()),
            other => Err(format!("freeze: {other:?}")),
        }
    }

    async fn unfreeze(&mut self, vault: &VaultId) -> Result<i64, String> {
        match self
            .gateway
            .unfreeze(vault, self.now_ms)
            .map_err(|fault| fault.to_string())?
        {
            Operated::Done(lasted) => Ok(lasted),
            other => Err(format!("unfreeze: {other:?}")),
        }
    }

    async fn operator_undo(&mut self, vault: &VaultId) -> Result<u64, String> {
        match self
            .gateway
            .operator_undo(vault)
            .map_err(|fault| fault.to_string())?
        {
            Operated::Done(count) => Ok(count),
            other => Err(format!("undo: {other:?}")),
        }
    }

    async fn token_epochs(&mut self, vault: &VaultId) -> Result<Vec<u64>, String> {
        Ok(self.gateway.state.token_epochs(vault))
    }

    async fn revoked_count(&mut self, vault: &VaultId) -> Result<u64, String> {
        Ok(self.gateway.state.revoked_count(vault))
    }

    async fn secret_count(&mut self) -> Result<u64, String> {
        Ok(self
            .gateway
            .secrets()
            .map_err(|fault| fault.to_string())?
            .len() as u64)
    }

    async fn nonce_rows(&mut self) -> Result<Vec<Vec<u8>>, String> {
        Ok(self.gateway.state.nonce_rows())
    }

    async fn revoke(&mut self, token: &Token, vault: &VaultId) -> Result<(), Failure> {
        self.gateway.revoke(vault, token).map_err(failure)
    }
}
