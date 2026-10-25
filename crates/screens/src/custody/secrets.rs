//! THE SEED A CORE IS OPENED WITH, AND WHAT THIS PHONE KEEPS BESIDE IT
//! (#1029 W18, `crates/core-ffi/CONTRACT.md` §4b), decided in Rust.
//!
//! The shell keeps bytes (Keychain, Keystore, iCloud Keychain, Block Store) and
//! answers [`wire::SecretBatch`] effects; every decision about them is here. The
//! values are held in a cache this struct owns, **filled from the shell's
//! answers and never ahead of them**: a builder returns the ops to send, and
//! [`VaultSecrets::absorb`] folds the answers in, so a read after a write sees
//! what the platform said it stored, not what a screen hoped. The cache is
//! loaded once ([`VaultSecrets::load_ops`]); until then nothing is known and a
//! flow waits in its loading state.
//!
//! | What | Store | Why |
//! |---|---|---|
//! | the vault's **seed** (128 hex) | [`wire::SecretStore::Synced`] | it is the 24 words; iCloud Keychain carrying it to the member's next phone is the point |
//! | the **words**, each vault's **index**, and the seed when no synchronised store took it | [`wire::SecretStore::Device`] | facts about THIS phone's vaults |
//!
//! ## The seed is synchronised and that is deliberate
//!
//! The seed **is** the recovery phrase, so a member whose phone is at the
//! bottom of a river is restored by the thing that followed their Apple ID
//! rather than by a piece of paper they did not write. Android is not
//! symmetric: Block Store returns a key only inside the new-phone setup flow,
//! so the written words are the common way back there (`strings::custody`).
//!
//! ## There is no device secret (#1080 A21)
//!
//! A gateway knows a phone by a bearer token in the core's backup ledger, so no
//! device key is stored here and a core is opened with none.
//!
//! ## Absent is not an error
//!
//! A core opened with no seed reads and writes its vault and cannot seal a
//! backup. **Present and malformed is an error**: [`is_seed`] is the one check.
//!
//! ## Redaction
//!
//! A seed, an entry's seed and the words are keys to a vault. [`VaultSecrets`]
//! and [`OwnSeed`] print none of them.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use centraid_api_proto::core_v1 as wire;
use rand::RngCore;

/// 64 bytes, as 128 lowercase hex characters.
pub const SEED_HEX_LENGTH: usize = 128;
/// How many words a phrase is.
pub const WORDS: usize = 24;

/// Per VAULT: `vault-index.<vaultId>`. A phone holding two vaults holds two
/// indices, and one shared across them would be two vaults at one identity.
pub const INDEX_PREFIX: &str = "vault-index.";
/// The highest index this phone ever recorded; never lowered.
pub const INDEX_HIGH_WATER: &str = "vault-index-high-water";
/// Device-only: the seed, when the synchronised store refused it.
pub const LOCAL_SEED: &str = "recovery-seed.this-device";
/// Device-only: the 24 words, space-separated.
pub const LOCAL_WORDS: &str = "recovery-words.this-device";
/// Device-only: vaults' own keys still to be filed in Locker, `<id>\t<name>` per line.
pub const PENDING_FILINGS: &str = "vault-seeds.to-file";
/// Device-only: the member saved a copy of their key.
pub const WORDS_SAVED: &str = "recovery-words-saved";
/// Device-only: this phone's seed is its own to make vaults from.
pub const SEED_SETTLED: &str = "seed-settled";
/// Synchronised: the member's seed.
pub const SEED_KEY: &str = "recovery-seed";
/// Synchronised: one vault's own seed, by entry id (R-1047-E18).
pub const OWN_SEED_PREFIX: &str = "vault-seed.";
/// Synchronised: `<id>\t<label>` per line, every vault seed synchronised.
pub const OWN_SEED_INDEX: &str = "vault-seeds";
/// Device-only: a vault's own seed the synchronised store did not take.
pub const LOCAL_OWN_SEED_PREFIX: &str = "vault-seed.this-device.";
/// Device-only: the index of [`LOCAL_OWN_SEED_PREFIX`] entries.
pub const LOCAL_OWN_INDEX: &str = "vault-seeds.this-device";
/// Device-only: a vault's own 24 words.
pub const LOCAL_OWN_WORDS_PREFIX: &str = "vault-words.this-device.";
/// Device-only, per vault: the entry it is kept on.
pub const OWN_VAULT_PREFIX: &str = "vault-own.";

const SETTLED: &str = "1";
const OWN_ID_BYTES: usize = 8;

/// A lowercase seed of the right length.
#[must_use]
pub fn is_seed(text: &str) -> bool {
    is_hex(text, SEED_HEX_LENGTH)
}

fn is_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A lowercase ASCII word: the shape of a BIP39 English list word, not the list.
fn is_word(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_lowercase())
}

/// What opens one vault: an index, under the member's seed or entry `own`'s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultKey {
    pub index: u32,
    pub own: Option<String>,
}

/// One vault seed on its own words. **Redacted**: `seed_hex` is a key to a vault.
#[derive(Clone, PartialEq, Eq)]
pub struct OwnSeed {
    pub id: String,
    pub label: String,
    pub seed_hex: String,
}

impl fmt::Debug for OwnSeed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OwnSeed({}, {}, <redacted>)", self.id, self.label)
    }
}

#[derive(Default)]
struct Cache {
    loaded: bool,
    device: BTreeMap<String, String>,
    synced: BTreeMap<String, String>,
}

/// The phone's vault secrets. Cheap to clone: every clone is the same cache, so
/// the screens of one runtime and the shelf share what the shell last said.
#[derive(Clone, Default)]
pub struct VaultSecrets {
    cache: Arc<Mutex<Cache>>,
    /// The pass conductor, shared by the pass service and the Backup screen the
    /// same way the cache is: reachable from here so `registry(&secrets)` hands
    /// both the one object.
    conductor: crate::passes::Conductor,
}

impl fmt::Debug for VaultSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VaultSecrets(loaded={}, <redacted>)", self.loaded())
    }
}

fn device(op: wire::secret_op::Op, key: &str, value: &str) -> wire::SecretOp {
    wire::SecretOp {
        op: op as i32,
        store: wire::SecretStore::Device as i32,
        key: key.to_owned(),
        value: value.as_bytes().to_vec(),
    }
}

fn synced(op: wire::secret_op::Op, key: &str, value: &str) -> wire::SecretOp {
    wire::SecretOp {
        store: wire::SecretStore::Synced as i32,
        ..device(op, key, value)
    }
}

/// Set a device-only key; an empty value deletes it (an empty secret that reads
/// back as present is a credential the app believes it has).
fn set_device(key: &str, value: &str) -> wire::SecretOp {
    device(wire::secret_op::Op::Set, key, value)
}

fn read_index(raw: Option<&str>) -> Vec<(String, String)> {
    raw.unwrap_or_default()
        .split('\n')
        .filter_map(|line| {
            let (id, label) = line.split_once('\t').unwrap_or((line, ""));
            is_hex(id, OWN_ID_BYTES * 2).then(|| (id.to_owned(), label.to_owned()))
        })
        .collect()
}

fn write_index(entries: &[(String, String)]) -> String {
    let mut seen = std::collections::BTreeSet::new();
    entries
        .iter()
        .filter(|(id, _)| seen.insert(id.clone()))
        .map(|(id, label)| format!("{id}\t{label}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn clean_label(label: &str) -> String {
    label.replace(['\t', '\n'], " ").trim().to_owned()
}

impl VaultSecrets {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The pass conductor every clone shares (`crate::passes`).
    #[must_use]
    pub fn conductor(&self) -> &crate::passes::Conductor {
        &self.conductor
    }

    /// A device-only value the shell last said, for a setting that is not a
    /// key (the transfer rule; `crate::passes::rule`).
    #[must_use]
    pub(crate) fn device_value(&self, key: &str) -> Option<String> {
        self.device_get(key)
    }

    /// The op that sets a device-only value; an empty value deletes it.
    #[must_use]
    pub(crate) fn device_set(key: &str, value: &str) -> wire::SecretOp {
        set_device(key, value)
    }

    // ---- loading ---------------------------------------------------------

    /// Whether the shell's secrets have been read once.
    #[must_use]
    pub fn loaded(&self) -> bool {
        self.cache().loaded
    }

    /// The ops that read everything this phone keeps. Send them, then
    /// [`Self::absorb`] the answers.
    #[must_use]
    pub fn load_ops() -> Vec<wire::SecretOp> {
        vec![
            device(wire::secret_op::Op::List, "", ""),
            synced(wire::secret_op::Op::List, "", ""),
        ]
    }

    /// The ops that read what a store cannot enumerate: the per-vault keys an
    /// earlier build wrote under names built from a vault's id (the Android
    /// store lists only names it has indexed). Send them after the load, once
    /// the shelf knows the vault ids, then [`Self::absorb`] the answers.
    #[must_use]
    pub fn hydrate_ops(vault_ids: &[String]) -> Vec<wire::SecretOp> {
        vault_ids
            .iter()
            .flat_map(|id| {
                [
                    device(wire::secret_op::Op::Get, &format!("{INDEX_PREFIX}{id}"), ""),
                    device(
                        wire::secret_op::Op::Get,
                        &format!("{OWN_VAULT_PREFIX}{id}"),
                        "",
                    ),
                ]
            })
            .collect()
    }

    /// Fold the shell's answers to `ops` into the cache. The answers are in the
    /// order of the ops; an answer short of them is a shell that failed the
    /// batch and changes nothing.
    pub fn absorb(&self, ops: &[wire::SecretOp], answers: &[wire::SecretAnswer]) {
        if answers.len() < ops.len() {
            return;
        }
        let mut cache = self.cache();
        for (op, answer) in ops.iter().zip(answers) {
            let synced_store = op.store == wire::SecretStore::Synced as i32;
            let map = if synced_store {
                &mut cache.synced
            } else {
                &mut cache.device
            };
            let value = String::from_utf8_lossy(&op.value).into_owned();
            match wire::secret_op::Op::try_from(op.op) {
                Ok(wire::secret_op::Op::List) if answer.ok => {
                    map.retain(|key, _| !key.starts_with(&op.key));
                    for entry in &answer.entries {
                        let text = String::from_utf8_lossy(&entry.value).into_owned();
                        if !text.is_empty() {
                            map.insert(entry.key.clone(), text);
                        }
                    }
                    if op.key.is_empty() {
                        // The load lists each store whole: the cache is now known.
                        cache.loaded = true;
                    }
                }
                Ok(wire::secret_op::Op::Get) if answer.ok => {
                    let text = String::from_utf8_lossy(&answer.value).into_owned();
                    if answer.found && !text.is_empty() {
                        map.insert(op.key.clone(), text);
                    } else {
                        map.remove(&op.key);
                    }
                }
                Ok(wire::secret_op::Op::Set) if answer.ok => {
                    if value.is_empty() {
                        map.remove(&op.key);
                    } else {
                        map.insert(op.key.clone(), value);
                    }
                }
                Ok(wire::secret_op::Op::Delete) if answer.ok => {
                    map.remove(&op.key);
                }
                _ => {}
            }
        }
    }

    // ---- the member's seed -----------------------------------------------

    fn device_get(&self, key: &str) -> Option<String> {
        self.cache().device.get(key).cloned()
    }

    fn synced_get(&self, key: &str) -> Option<String> {
        self.cache().synced.get(key).cloned()
    }

    /// This member's seed, or `None` when this phone holds none: the
    /// synchronised store's, else this device's own copy.
    #[must_use]
    pub fn seed(&self) -> Option<String> {
        self.synced_get(SEED_KEY)
            .filter(|seed| is_seed(seed))
            .or_else(|| self.device_get(LOCAL_SEED).filter(|seed| is_seed(seed)))
    }

    /// The ops that remember the seed, in two steps because the second depends
    /// on what the first answered.
    ///
    /// **A platform that will not take it still leaves it on this phone** (#1047
    /// E1, R-1047-E6): Block Store refuses without Google Play services, and a
    /// phone whose seed was stored nowhere could never open a vault keyed. So a
    /// refused synchronised write falls back to the device-only store; a
    /// synchronised write that succeeds removes the device copy, so there is
    /// one seed and not two. `sync: false` is the member's opt-out
    /// (R-1047-E16): this phone only, and no synced copy left behind.
    ///
    /// # Panics
    /// When `seed_hex` is not a seed (a caller bug, not input).
    #[must_use]
    pub fn remember_seed(seed_hex: &str, sync: bool) -> SeedWrite {
        assert!(
            is_seed(seed_hex),
            "a seed is {SEED_HEX_LENGTH} lowercase hex characters"
        );
        SeedWrite {
            seed: seed_hex.to_owned(),
            sync,
        }
    }

    /// Whether the synchronised store holds this phone's seed right now, read
    /// from what the shell last said.
    #[must_use]
    pub fn seed_synced(&self) -> bool {
        self.seed()
            .is_some_and(|held| self.synced_get(SEED_KEY).as_deref() == Some(held.as_str()))
    }

    /// The member said they saved a copy of their recovery key.
    #[must_use]
    pub fn words_saved(&self) -> bool {
        self.device_get(WORDS_SAVED).as_deref() == Some(SETTLED)
    }

    /// Record [`Self::words_saved`].
    #[must_use]
    pub fn mark_words_saved() -> wire::SecretOp {
        set_device(WORDS_SAVED, SETTLED)
    }

    /// Forget the seed everywhere this object put it, and the words with it.
    #[must_use]
    pub fn forget_seed() -> Vec<wire::SecretOp> {
        vec![
            synced(wire::secret_op::Op::Delete, SEED_KEY, ""),
            set_device(LOCAL_SEED, ""),
            set_device(LOCAL_WORDS, ""),
            set_device(WORDS_SAVED, ""),
        ]
    }

    /// The 24 words, kept so Settings can show them again (Q-1047-19). Device
    /// only and never synchronised: the synchronised seed already carries what
    /// a next phone needs.
    ///
    /// # Panics
    /// When `words` are not 24 lowercase list words (a caller bug).
    #[must_use]
    pub fn remember_words(words: &[String]) -> wire::SecretOp {
        assert!(
            words.len() == WORDS && words.iter().all(|w| is_word(w)),
            "the words are {WORDS} lowercase list words"
        );
        set_device(LOCAL_WORDS, &words.join(" "))
    }

    /// The words kept by [`Self::remember_words`].
    #[must_use]
    pub fn words(&self) -> Option<Vec<String>> {
        self.device_get(LOCAL_WORDS)
            .and_then(|raw| parse_words(&raw))
    }

    /// Whether this phone knows which indices its seed has spent: the seed is
    /// synchronised and the indices are not, so a seed that arrived through
    /// iCloud carries no record of the vaults made with it elsewhere and the
    /// next index would be 0, the index of a vault that already exists.
    #[must_use]
    pub fn seed_settled(&self) -> bool {
        self.high_water().is_some() || self.device_get(SEED_SETTLED).as_deref() == Some(SETTLED)
    }

    /// Record that this phone's seed is its own to make vaults from.
    #[must_use]
    pub fn settle_seed() -> wire::SecretOp {
        set_device(SEED_SETTLED, SETTLED)
    }

    // ---- vault indices -----------------------------------------------------

    fn high_water(&self) -> Option<u32> {
        self.device_get(INDEX_HIGH_WATER)
            .and_then(|raw| raw.parse().ok())
    }

    /// Whether this phone has recorded any vault index at all.
    #[must_use]
    pub fn any_vault_index(&self) -> bool {
        self.high_water().is_some()
    }

    /// The derivation index `vault_id` sits at under the seed. **Absent is a
    /// state**: a core opened without an index opens without the seed. Never a
    /// guess at 0: two vaults at one index are one identity and one Locker `K`.
    #[must_use]
    pub fn vault_index(&self, vault_id: &str) -> Option<u32> {
        self.device_get(&format!("{INDEX_PREFIX}{vault_id}"))
            .and_then(|raw| raw.parse().ok())
    }

    /// Record `vault_id`'s index and raise the high-water mark past it. The
    /// mark is never lowered, so [`Self::next_vault_index`] never hands out an
    /// index a vault this phone once held was sealed under.
    #[must_use]
    pub fn remember_vault_index(&self, vault_id: &str, index: u32) -> Vec<wire::SecretOp> {
        let mut ops = vec![set_device(
            &format!("{INDEX_PREFIX}{vault_id}"),
            &index.to_string(),
        )];
        if self.high_water().is_none_or(|mark| index > mark) {
            ops.push(set_device(INDEX_HIGH_WATER, &index.to_string()));
        }
        ops
    }

    /// Drop one vault's index. The high-water mark stays where it is.
    #[must_use]
    pub fn forget_vault_index(vault_id: &str) -> wire::SecretOp {
        set_device(&format!("{INDEX_PREFIX}{vault_id}"), "")
    }

    /// The index a vault founded now takes: one past the highest ever recorded.
    #[must_use]
    pub fn next_vault_index(&self) -> u32 {
        self.high_water().map_or(0, |mark| mark + 1)
    }

    // ---- vaults on their own words (R-1047-E18) ------------------------------

    fn synced_index(&self) -> Vec<(String, String)> {
        read_index(self.synced_get(OWN_SEED_INDEX).as_deref())
    }

    fn local_index(&self) -> Vec<(String, String)> {
        read_index(self.device_get(LOCAL_OWN_INDEX).as_deref())
    }

    /// Which seed and index open `vault_id`, or `None` when this phone cannot
    /// key it. A vault on its own words is its entry's seed at its recorded
    /// index (always 0 when this phone made it); any other vault is the
    /// member's seed at its recorded index.
    #[must_use]
    pub fn vault_key(&self, vault_id: &str) -> Option<VaultKey> {
        let index = self.vault_index(vault_id)?;
        match self.own_seed_of(vault_id) {
            Some(own) => self.own_seed(&own).map(|_| VaultKey {
                index,
                own: Some(own),
            }),
            None => self.seed().map(|_| VaultKey { index, own: None }),
        }
    }

    /// The seed `key` opens with: its entry's, or the member's.
    #[must_use]
    pub fn seed_for(&self, key: &VaultKey) -> Option<String> {
        match &key.own {
            Some(own) => self.own_seed(own),
            None => self.seed(),
        }
    }

    /// A fresh id for a seed entry: eight random bytes, as hex.
    #[must_use]
    pub fn fresh_entry_id() -> String {
        let mut bytes = [0u8; OWN_ID_BYTES];
        rand::rng().fill_bytes(&mut bytes);
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Keep a fresh seed for one vault, before that vault is founded, under the
    /// entry `id`. Synchronised when `sync` (and the platform takes it), else
    /// on this phone only; never the member's slot. Two steps like
    /// [`Self::remember_seed`]: [`OwnSeedWrite`].
    ///
    /// # Panics
    /// When `seed_hex` is not a seed.
    #[must_use]
    pub fn keep_own_seed(&self, id: &str, seed_hex: &str, label: &str, sync: bool) -> OwnSeedWrite {
        assert!(
            is_seed(seed_hex),
            "a seed is {SEED_HEX_LENGTH} lowercase hex characters"
        );
        OwnSeedWrite {
            id: id.to_owned(),
            seed: seed_hex.to_owned(),
            label: clean_label(label),
            sync,
            synced_index: self.synced_index(),
            local_index: self.local_index(),
        }
    }

    /// Every vault seed this phone can reach, with its label.
    #[must_use]
    pub fn own_seeds(&self) -> Vec<OwnSeed> {
        let from_sync = self.synced_index().into_iter().filter_map(|(id, label)| {
            self.synced_get(&format!("{OWN_SEED_PREFIX}{id}"))
                .filter(|seed| is_seed(seed))
                .map(|seed_hex| OwnSeed {
                    id,
                    label,
                    seed_hex,
                })
        });
        let from_here = self.local_index().into_iter().filter_map(|(id, label)| {
            self.device_get(&format!("{LOCAL_OWN_SEED_PREFIX}{id}"))
                .filter(|seed| is_seed(seed))
                .map(|seed_hex| OwnSeed {
                    id,
                    label,
                    seed_hex,
                })
        });
        let mut seen = std::collections::BTreeSet::new();
        from_sync
            .chain(from_here)
            .filter(|seed| seen.insert(seed.id.clone()))
            .collect()
    }

    /// Entry `id`'s seed.
    #[must_use]
    pub fn own_seed(&self, id: &str) -> Option<String> {
        self.synced_get(&format!("{OWN_SEED_PREFIX}{id}"))
            .filter(|seed| is_seed(seed))
            .or_else(|| {
                self.device_get(&format!("{LOCAL_OWN_SEED_PREFIX}{id}"))
                    .filter(|seed| is_seed(seed))
            })
    }

    /// The entry whose seed already is `seed_hex`.
    #[must_use]
    pub fn own_seed_matching(&self, seed_hex: &str) -> Option<String> {
        self.own_seeds()
            .into_iter()
            .find(|seed| seed.seed_hex == seed_hex)
            .map(|seed| seed.id)
    }

    /// Rename entry `id`'s label wherever it is listed.
    #[must_use]
    pub fn label_own_seed(&self, id: &str, label: &str) -> Vec<wire::SecretOp> {
        let clean = clean_label(label);
        let relabel = |entries: Vec<(String, String)>| -> Vec<(String, String)> {
            entries
                .into_iter()
                .map(|(entry, old)| {
                    if entry == id {
                        (entry, clean.clone())
                    } else {
                        (entry, old)
                    }
                })
                .collect()
        };
        let mut ops = Vec::new();
        let in_sync = self.synced_index();
        if in_sync.iter().any(|(entry, _)| entry == id) {
            ops.push(synced(
                wire::secret_op::Op::Set,
                OWN_SEED_INDEX,
                &write_index(&relabel(in_sync)),
            ));
        }
        let in_here = self.local_index();
        if in_here.iter().any(|(entry, _)| entry == id) {
            ops.push(set_device(LOCAL_OWN_INDEX, &write_index(&relabel(in_here))));
        }
        ops
    }

    /// Forget entry `id` everywhere: its seed, its words, its line in either
    /// index and anything still to be filed for it.
    #[must_use]
    pub fn forget_own_seed(&self, id: &str) -> Vec<wire::SecretOp> {
        let mut ops = vec![synced(
            wire::secret_op::Op::Delete,
            &format!("{OWN_SEED_PREFIX}{id}"),
            "",
        )];
        let in_sync = self.synced_index();
        if in_sync.iter().any(|(entry, _)| entry == id) {
            let kept: Vec<_> = in_sync
                .into_iter()
                .filter(|(entry, _)| entry != id)
                .collect();
            ops.push(synced(
                wire::secret_op::Op::Set,
                OWN_SEED_INDEX,
                &write_index(&kept),
            ));
        }
        ops.push(set_device(&format!("{LOCAL_OWN_SEED_PREFIX}{id}"), ""));
        ops.push(set_device(&format!("{LOCAL_OWN_WORDS_PREFIX}{id}"), ""));
        let kept: Vec<_> = self
            .local_index()
            .into_iter()
            .filter(|(entry, _)| entry != id)
            .collect();
        ops.push(set_device(LOCAL_OWN_INDEX, &write_index(&kept)));
        ops.extend(self.clear_pending_filing(id));
        ops
    }

    /// A vault's own key still to be filed in the main vault's Locker
    /// (R-ONBOARD-10): `(id, vault name)`. The core seals a Locker secret only
    /// while that Locker is unlocked, which it never is when a vault is made, so
    /// the filing waits for the member's next unlock of the main vault.
    #[must_use]
    pub fn pending_filings(&self) -> Vec<(String, String)> {
        read_index(self.device_get(PENDING_FILINGS).as_deref())
    }

    /// Record entry `id`, made as `name`, as still to be filed.
    #[must_use]
    pub fn add_pending_filing(&self, id: &str, name: &str) -> wire::SecretOp {
        let mut entries: Vec<_> = self
            .pending_filings()
            .into_iter()
            .filter(|(entry, _)| entry != id)
            .collect();
        entries.push((id.to_owned(), clean_label(name)));
        set_device(PENDING_FILINGS, &write_index(&entries))
    }

    /// Entry `id` was filed, or forgotten: nothing left to file for it.
    #[must_use]
    pub fn clear_pending_filing(&self, id: &str) -> Vec<wire::SecretOp> {
        let kept: Vec<_> = self
            .pending_filings()
            .into_iter()
            .filter(|(entry, _)| entry != id)
            .collect();
        vec![set_device(PENDING_FILINGS, &write_index(&kept))]
    }

    /// Every entry in `ids` was filed, or forgotten: one write, so a batch
    /// clearing several does not leave the last one's list standing.
    #[must_use]
    pub fn clear_pending_filings(&self, ids: &[String]) -> Vec<wire::SecretOp> {
        let kept: Vec<_> = self
            .pending_filings()
            .into_iter()
            .filter(|(entry, _)| !ids.contains(entry))
            .collect();
        vec![set_device(PENDING_FILINGS, &write_index(&kept))]
    }

    /// Entry `id`'s 24 words, device-only, so Settings can show them again.
    ///
    /// # Panics
    /// When `words` are not 24 lowercase list words.
    #[must_use]
    pub fn remember_own_words(id: &str, words: &[String]) -> wire::SecretOp {
        assert!(
            words.len() == WORDS && words.iter().all(|w| is_word(w)),
            "the words are {WORDS} lowercase list words"
        );
        set_device(&format!("{LOCAL_OWN_WORDS_PREFIX}{id}"), &words.join(" "))
    }

    /// The words kept by [`Self::remember_own_words`].
    #[must_use]
    pub fn own_words(&self, id: &str) -> Option<Vec<String>> {
        self.device_get(&format!("{LOCAL_OWN_WORDS_PREFIX}{id}"))
            .and_then(|raw| parse_words(&raw))
    }

    /// `vault_id` opens with entry `own`'s seed at `index`. The member's
    /// high-water mark is not touched: the index is under another seed.
    #[must_use]
    pub fn bind_own_vault(vault_id: &str, own: &str, index: u32) -> Vec<wire::SecretOp> {
        vec![
            set_device(&format!("{OWN_VAULT_PREFIX}{vault_id}"), own),
            set_device(&format!("{INDEX_PREFIX}{vault_id}"), &index.to_string()),
        ]
    }

    /// The entry `vault_id` is kept on, or `None` for a vault on the member's words.
    #[must_use]
    pub fn own_seed_of(&self, vault_id: &str) -> Option<String> {
        self.device_get(&format!("{OWN_VAULT_PREFIX}{vault_id}"))
            .filter(|own| !own.is_empty())
    }

    /// Unbind `vault_id` and forget its entry: what forgetting a vault on its
    /// own words does.
    #[must_use]
    pub fn forget_own_vault(&self, vault_id: &str) -> Vec<wire::SecretOp> {
        let Some(own) = self.own_seed_of(vault_id) else {
            return Vec::new();
        };
        let mut ops = vec![set_device(&format!("{OWN_VAULT_PREFIX}{vault_id}"), "")];
        ops.extend(self.forget_own_seed(&own));
        ops
    }
}

fn parse_words(raw: &str) -> Option<Vec<String>> {
    let words: Vec<String> = raw.split(' ').map(str::to_owned).collect();
    (words.len() == WORDS && words.iter().all(|w| is_word(w))).then_some(words)
}

/// The two steps of remembering the member's seed.
pub struct SeedWrite {
    seed: String,
    sync: bool,
}

impl fmt::Debug for SeedWrite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SeedWrite(sync={}, <redacted>)", self.sync)
    }
}

impl SeedWrite {
    /// The first batch. A synchronised store verifies its own write by reading
    /// it back and answers `ok` only when the value is there.
    #[must_use]
    pub fn first(&self) -> Vec<wire::SecretOp> {
        if self.sync {
            vec![synced(wire::secret_op::Op::Set, SEED_KEY, &self.seed)]
        } else {
            // THE MEMBER OPTED OUT: this phone only, and no synced copy left behind.
            vec![
                synced(wire::secret_op::Op::Delete, SEED_KEY, ""),
                set_device(LOCAL_SEED, &self.seed),
            ]
        }
    }

    /// Whether the platform synchronises the seed, from the first batch's answers.
    #[must_use]
    pub fn synchronised(&self, answers: &[wire::SecretAnswer]) -> bool {
        self.sync && answers.first().is_some_and(|answer| answer.ok)
    }

    /// The second batch, once the first answered: the device copy is removed
    /// when the platform synchronises the seed, else it is the only one.
    /// Empty for an opt-out, whose first batch already wrote it.
    #[must_use]
    pub fn second(&self, answers: &[wire::SecretAnswer]) -> Vec<wire::SecretOp> {
        if !self.sync {
            return Vec::new();
        }
        vec![set_device(
            LOCAL_SEED,
            if self.synchronised(answers) {
                ""
            } else {
                &self.seed
            },
        )]
    }
}

/// The two steps of keeping a seed for one vault.
pub struct OwnSeedWrite {
    id: String,
    seed: String,
    label: String,
    sync: bool,
    synced_index: Vec<(String, String)>,
    local_index: Vec<(String, String)>,
}

impl fmt::Debug for OwnSeedWrite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OwnSeedWrite({}, <redacted>)", self.id)
    }
}

impl OwnSeedWrite {
    /// The entry id the seed is kept under.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The first batch: the synchronised seed and its line in the synchronised
    /// index (both verified by the shell), or nothing when the member opted out.
    #[must_use]
    pub fn first(&self) -> Vec<wire::SecretOp> {
        if !self.sync {
            return Vec::new();
        }
        let mut entries = self.synced_index.clone();
        entries.push((self.id.clone(), self.label.clone()));
        vec![
            synced(
                wire::secret_op::Op::Set,
                &format!("{OWN_SEED_PREFIX}{}", self.id),
                &self.seed,
            ),
            synced(
                wire::secret_op::Op::Set,
                OWN_SEED_INDEX,
                &write_index(&entries),
            ),
        ]
    }

    /// Whether both synchronised writes took.
    #[must_use]
    pub fn synchronised(&self, answers: &[wire::SecretAnswer]) -> bool {
        self.sync && answers.len() >= 2 && answers.iter().take(2).all(|answer| answer.ok)
    }

    /// The second batch: when the synchronised store did not take it, remove
    /// what half-landed there and keep the seed on this phone only.
    #[must_use]
    pub fn second(&self, answers: &[wire::SecretAnswer]) -> Vec<wire::SecretOp> {
        if self.synchronised(answers) {
            return Vec::new();
        }
        let mut entries = self.local_index.clone();
        entries.push((self.id.clone(), self.label.clone()));
        vec![
            synced(
                wire::secret_op::Op::Delete,
                &format!("{OWN_SEED_PREFIX}{}", self.id),
                "",
            ),
            set_device(&format!("{LOCAL_OWN_SEED_PREFIX}{}", self.id), &self.seed),
            set_device(LOCAL_OWN_INDEX, &write_index(&entries)),
        ]
    }
}

/// The effect that sends `ops` to the shell.
#[must_use]
pub fn effect(ops: Vec<wire::SecretOp>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Secrets(wire::SecretBatch { ops })),
    }
}

#[cfg(test)]
mod tests;
