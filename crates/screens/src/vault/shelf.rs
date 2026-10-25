//! EVERY VAULT THIS PHONE HOLDS, AND THE ONE OBJECT THAT ADDS OR REMOVES ONE
//! (#1025 S7-9, #1029 §1, ported from Kotlin by #1135, lane H2).
//!
//! **The phone is the vault**: a vault is a file on this phone, and this is the
//! set of them. The shelf holds [`Holding`]s — a vault id, the file it lives in,
//! what it is called and its OPEN CORE — and [`Shelf::found`] and
//! [`Shelf::forget`] are the only things that add or remove one.
//!
//! ## RUST HOLDS THE CORES
//!
//! The shell opens ONE core, over the shelf's directory
//! ([`centraid_core::ShelfConfig`]), and that core is the *front*: it holds no
//! vault, runs the screen runtime, and sends every request that is about a vault
//! to [`Shelf::foreground_core`]'s core (`centraid_core::vaults`). This type
//! opens, rests, wakes, freezes and closes the others, keys each open from the
//! phone's secrets and forwards the foreground vault's events to the front's
//! queue. The shell never sees a second core and never names a vault file.
//!
//! ## A HELD VAULT'S CORE IS OPEN (#1025 S7-13)
//!
//! Every holding's core is open from the moment it is founded or the shelf
//! launches, and it STAYS open: bringing a vault to the front is a pointer move
//! on this struct, nothing is closed and nothing is reopened. Two handles on one
//! FILE is the hazard (two writers for one vault); two handles on two files
//! share nothing. The only two things that close a background core are
//! [`Shelf::forget`] and [`Shelf::rest`] (the operating system asking for its
//! memory back), which closes every core but the foreground's; a rested holding
//! reopens on the next touch. There is deliberately no idle timeout.
//!
//! ## EVERY OPEN IS KEYED WHEN IT CAN BE (#1047 W2)
//!
//! A core is KEYED when it is opened with a seed and this vault's derivation
//! index; only then does it hold the vault's keys — Locker's `K` among them.
//! The seed is read out of [`VaultSecrets`] at the moment of each open, handed
//! to `Core::open` and dropped: no field here, on a [`Holding`] or on any state
//! holds it. A vault with no seed on this phone, or no index recorded for it,
//! opens UNKEYED — reads and writes as before — and Locker draws its no-words
//! wall rather than a failure.
//!
//! ## THE SHELF TALKS TO NOBODY
//!
//! The phone's secrets are the shell's (Keychain, Keystore). Every method here
//! is synchronous, reads the cache [`VaultSecrets`] holds, and RETURNS the
//! writes the shell must perform as [`SecretOp`]s; the screen that called sends
//! them in one batch and absorbs the answers.
//!
//! ## THE CRASH WINDOW
//!
//! A found spends an index before the core makes the file, and the vault's id —
//! what the index is recorded under — only exists afterwards. The record that
//! closes the window is [`files::Marker`], written into the new vault's own
//! directory before the core touches it; see there.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::vaults::{HeldVault, SHELF_TABLE, Vaults};
use centraid_core::{Core, CoreConfig, EventQueue, Handle, Seed};

use super::files::{self, Marker};
use super::types::{Effected, Foreground, Found, FoundRefusal, Restored};
use crate::custody::keeper::Keeper;
use crate::custody::secrets::{VaultKey, VaultSecrets};
use crate::passes::{Held, Holdings};
use crate::strings::{self, Locale, custody as custody_words, fill};

/// What the demo seed's vaults are indexed at: `seed-demo-vault` seals under the
/// public all-`abandon` words at index 0.
pub const DEV_INDEX: u32 = 0;

/// How a freshly opened core is made ready (its byte store, an engine): the
/// core crate's shell does this for the one core it opens, and the shelf does it
/// for each it opens.
pub type Prepare = Arc<dyn Fn(&Handle) + Send + Sync>;

/// The default preparation: the core owns its byte store, `vault.bytes` beside
/// the file. A store that will not open is not a failed open: the rows are
/// readable and every text write lands; photographs are refused by name.
pub fn default_prepare(handle: &Handle) {
    if handle.holds_a_replica() {
        let _ = handle.open_own_bytes(handle.path().with_extension("bytes"));
    }
}

/// THIS VAULT MOVED TO ANOTHER PHONE (#1029 F1).
///
/// Cooperation, not enforcement: both phones hold the same seed, so no epoch
/// and no lock can DECIDE who owns a vault. This state does three things and no
/// more: writes are refused (the core refuses them itself, from the ledger),
/// what no gateway acknowledged is SHOWN, and it is KEPT. Never wipe, never
/// auto-take-back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Moved {
    /// The instant the line dates from, RFC 3339: the last acknowledgement on
    /// the gateway's clock, else the move's own time.
    pub at_iso: String,
    /// How many items this phone holds that no gateway acknowledged.
    pub unacked: u64,
}

/// One vault, as this phone holds it.
struct Holding {
    vault_id: String,
    path: PathBuf,
    name: String,
    /// Its open core, or `None` while the holding is RESTING.
    core: Option<Handle>,
    moved: Option<Moved>,
    /// What this vault opens with, once known: its index, under the member's
    /// seed or an entry's.
    key: Option<VaultKey>,
    /// The open carried the seed and the index.
    keyed: bool,
    /// A found whose index the secret store has not been seen to hold.
    marker: Option<Marker>,
}

/// A vault file the launch survey named.
struct Surveyed {
    path: PathBuf,
    vault_id: String,
    name: String,
    marker: Option<Marker>,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    holdings: Vec<Holding>,
    foreground: Option<String>,
    /// The highest index this process handed to a found or saw in a marker,
    /// possibly not yet in the secret store's cache. A found never takes an
    /// index at or below it.
    spent: Option<u32>,
    surveyed: Vec<Surveyed>,
    /// What the last vault made says, once, for Home's status line: taken by
    /// [`Shelf::take_outcome`].
    outcome: Option<String>,
}

/// What the shelf needs from the core that fronts it.
struct Front {
    events: Arc<EventQueue>,
    dir: PathBuf,
    dev_seed: Option<String>,
    prepare: Prepare,
}

/// The vaults this phone holds.
pub struct Shelf {
    me: Weak<Shelf>,
    secrets: VaultSecrets,
    front: OnceLock<Front>,
    inner: Mutex<Inner>,
}

impl Shelf {
    /// A shelf over `secrets`, bound to nothing: [`Self::bind`] ties it to the
    /// core that fronts it.
    #[must_use]
    pub fn new(secrets: &VaultSecrets) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            secrets: secrets.clone(),
            front: OnceLock::new(),
            inner: Mutex::new(Inner::default()),
        })
    }

    /// Tie this shelf to `handle` when it was opened as a shelf's door
    /// ([`CoreConfig::fronting`]): the directory, the demo seed, the queue the
    /// foreground's events are forwarded to. A core that is not a door leaves
    /// the shelf unbound and the shelf answers nothing. Answers whether it bound.
    pub fn bind(self: &Arc<Self>, handle: &Handle, prepare: Prepare) -> bool {
        let Some(config) = handle.shelf_config() else {
            return false;
        };
        let bound = self.bind_to(
            handle.events(),
            config.dir.clone(),
            config.dev_seed.clone(),
            prepare,
        );
        if bound {
            handle.attach_vaults(Arc::clone(self) as Arc<dyn Vaults>);
        }
        bound
    }

    /// [`Self::bind`] over its parts, for a host that is not a handle.
    pub fn bind_to(
        &self,
        events: Arc<EventQueue>,
        dir: PathBuf,
        dev_seed: Option<String>,
        prepare: Prepare,
    ) -> bool {
        self.front
            .set(Front {
                events,
                dir,
                dev_seed,
                prepare,
            })
            .is_ok()
    }

    /// The cache of the phone's secrets this shelf keys its opens from.
    #[must_use]
    pub fn secrets(&self) -> VaultSecrets {
        self.secrets.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The debug build's demo seed, if the shell handed one over. A key: never
    /// printed.
    #[must_use]
    pub fn dev_seed(&self) -> Option<String> {
        self.front.get().and_then(|front| front.dev_seed.clone())
    }

    /// The directory the shelf holds its vaults in, once bound.
    #[must_use]
    pub fn dir(&self) -> Option<&Path> {
        self.front.get().map(|front| front.dir.as_path())
    }

    /// Whether the shelf has read its directory (see [`Self::open_all`]).
    #[must_use]
    pub fn loaded(&self) -> bool {
        self.lock().loaded
    }

    // ---- launch ----------------------------------------------------------

    /// FIRST HALF OF THE LAUNCH: ask each file which vault it is, and answer
    /// the secret writes that launch owes (an index a found recorded only in its
    /// marker; the demo seed's index for a vault that has none).
    ///
    /// Every `<name>/vault.db` is opened UNKEYED, because which index to derive
    /// at is a fact about the VAULT and a file name is not an identity. A file
    /// that will not open, or will not say which vault it is, is simply not a
    /// holding: a row that fails on tap is a door that does not open. A
    /// directory holding a marker and no vault, or a vault file that names none,
    /// is a found the process did not live to finish and is deleted whole.
    /// Two files that name one vault are a copy taken by hand or a restore
    /// written beside the original: the first, in sorted order, wins.
    ///
    /// The caller sends the writes, absorbs the answers, and calls
    /// [`Self::open_all`], which reads the cache for the keys.
    pub fn survey(&self) -> Vec<wire::SecretOp> {
        let Some(front) = self.front.get() else {
            return Vec::new();
        };
        let mut inner = self.lock();
        inner.surveyed.clear();
        let mut writes = Vec::new();
        for home in files::homes(&front.dir) {
            let file = home.join(files::VAULT_FILE);
            let marker = Marker::read(&home);
            if marker.is_some() && !file.exists() {
                // KILLED BEFORE THE CORE MADE THE FILE: an empty directory, and
                // for a vault on its own words an entry whose seed keys nothing.
                files::delete_vault(&front.dir, &file);
                writes.extend(self.released(marker.as_ref()));
                continue;
            }
            if !file.exists() {
                continue;
            }
            let named = self.open(&file, false, None, false).and_then(|(probe, _)| {
                let named = identify(&probe);
                shut(&probe);
                named
            });
            let Some((vault_id, name)) = named else {
                if marker.is_some() {
                    files::delete_vault(&front.dir, &file);
                    writes.extend(self.released(marker.as_ref()));
                }
                continue;
            };
            if inner.surveyed.iter().any(|seen| seen.vault_id == vault_id) {
                continue;
            }
            if let Some(marker) = &marker {
                inner.spent = Some(inner.spent.map_or(marker.index, |s| s.max(marker.index)));
            }
            writes.extend(self.owed(&vault_id, &name, marker.as_ref()));
            inner.surveyed.push(Surveyed {
                path: file,
                vault_id,
                name,
                marker,
            });
        }
        // THE DEMO SEED'S INDEX for a vault no marker or cache speaks for.
        if front.dev_seed.is_some() {
            for surveyed in &inner.surveyed {
                if self.secrets.vault_index(&surveyed.vault_id).is_none()
                    && surveyed.marker.is_none()
                {
                    writes.extend(
                        self.secrets
                            .remember_vault_index(&surveyed.vault_id, DEV_INDEX),
                    );
                }
            }
        }
        writes
    }

    /// What a found that never finished gives back: nothing for the member's
    /// own index (it was never recorded, so there is nothing to lower), and for
    /// a vault on its own words the entry whose seed keys nothing now.
    fn released(&self, marker: Option<&Marker>) -> Vec<wire::SecretOp> {
        marker
            .and_then(|marker| marker.own.as_deref())
            .map(|own| self.secrets.forget_own_seed(own))
            .unwrap_or_default()
    }

    /// What a marker owes the secret store: the index it spent, recorded under
    /// the id the file names, unless the cache already holds it.
    fn owed(&self, vault_id: &str, name: &str, marker: Option<&Marker>) -> Vec<wire::SecretOp> {
        let Some(marker) = marker else {
            return Vec::new();
        };
        if self.secrets.vault_index(vault_id) == Some(marker.index) {
            return Vec::new();
        }
        match &marker.own {
            Some(own) => {
                let mut ops = VaultSecrets::bind_own_vault(vault_id, own, marker.index);
                ops.extend(self.secrets.label_own_seed(own, name));
                ops
            }
            None => self.secrets.remember_vault_index(vault_id, marker.index),
        }
    }

    /// SECOND HALF OF THE LAUNCH: open every surveyed vault, keyed when it can
    /// be, and choose the foreground — the vault the member last had in front,
    /// else the first. The shelf is loaded afterwards, and announces itself.
    pub fn open_all(&self) {
        let Some(front) = self.front.get() else {
            return;
        };
        let mut inner = self.lock();
        let surveyed = std::mem::take(&mut inner.surveyed);
        let mut held = Vec::new();
        for found in surveyed {
            let key = self.key_for(&found.vault_id, found.marker.as_ref());
            let Some((core, keyed)) = self.open_keyed_or_not(&found.path, key.as_ref()) else {
                continue;
            };
            self.pump(&found.vault_id, &core);
            held.push(Holding {
                vault_id: found.vault_id,
                path: found.path,
                name: found.name,
                core: Some(core),
                moved: None,
                key,
                keyed,
                marker: found.marker,
            });
        }
        inner.holdings = held;
        let remembered = files::read_foreground(&front.dir);
        inner.foreground = inner
            .holdings
            .iter()
            .find(|holding| Some(&holding.vault_id) == remembered.as_ref())
            .or_else(|| inner.holdings.first())
            .map(|holding| holding.vault_id.clone());
        inner.loaded = true;
        drop(inner);
        self.announce();
    }

    /// What opens `vault_id`: the cache's key, else the marker's, else the demo
    /// seed's.
    fn key_for(&self, vault_id: &str, marker: Option<&Marker>) -> Option<VaultKey> {
        self.secrets
            .vault_key(vault_id)
            .or_else(|| {
                marker
                    .map(|marker| VaultKey {
                        index: marker.index,
                        own: marker.own.clone(),
                    })
                    .filter(|key| self.secrets.seed_for(key).is_some())
            })
            .or_else(|| {
                self.dev_seed()
                    .map(|_| VaultKey {
                        index: DEV_INDEX,
                        own: None,
                    })
                    .filter(|key| self.secrets.seed_for(key).is_some())
            })
    }

    /// The ids of the vaults the survey named, for reading the per-vault keys an
    /// earlier build wrote under names built from them.
    #[must_use]
    pub fn surveyed_ids(&self) -> Vec<String> {
        self.lock()
            .surveyed
            .iter()
            .map(|surveyed| surveyed.vault_id.clone())
            .collect()
    }

    /// What making a vault says, once: "{name} is on this phone, and your
    /// recovery key brings it back." Home's status line takes it.
    pub fn take_outcome(&self) -> Option<String> {
        self.lock().outcome.take()
    }

    /// Forget every marker the secret store is seen to hold, and answer the
    /// writes for those it is not (a shell that lost them). Called when the app
    /// goes to the background and before each found.
    pub fn settle(&self) -> Vec<wire::SecretOp> {
        let mut inner = self.lock();
        self.settle_locked(&mut inner)
    }

    fn settle_locked(&self, inner: &mut Inner) -> Vec<wire::SecretOp> {
        let mut writes = Vec::new();
        for holding in &mut inner.holdings {
            let Some(marker) = &holding.marker else {
                continue;
            };
            let recorded = self.secrets.vault_index(&holding.vault_id) == Some(marker.index)
                && self.secrets.own_seed_of(&holding.vault_id) == marker.own;
            if recorded {
                if let Some(home) = holding.path.parent() {
                    Marker::remove(home);
                }
                holding.marker = None;
            } else {
                writes.extend(self.owed(&holding.vault_id, &holding.name, Some(marker)));
            }
        }
        writes
    }

    // ---- found -----------------------------------------------------------

    /// MAKE A VAULT ON THIS PHONE (#1029 §1): a fresh directory, a file the
    /// core creates there, and the vault founded inside it. The new vault is in
    /// front. `own` is the entry a vault on its own words is kept on
    /// (R-1047-E18): its seed, at index 0, keys the vault instead of the
    /// member's at the next index, and the member's high-water mark is not
    /// touched. The member's FIRST vault gets the teaching starter rows.
    ///
    /// The order is open → found → identify, and the identify is not redundant:
    /// the NAME held must come out of the vault and never off the string this
    /// function was given. A refusal on any step deletes the directory and gives
    /// the index back: nothing was sealed under it and nothing left this phone.
    pub fn found(&self, own: Option<&str>, name: &str) -> Effected<Found> {
        self.found_vault(own, name, None)
    }

    /// [`Self::found`] with the owner party's display name. `None` is "Me".
    pub fn found_vault(
        &self,
        own: Option<&str>,
        name: &str,
        owner: Option<&str>,
    ) -> Effected<Found> {
        let Some(front) = self.front.get() else {
            return Effected::new(Found::NoSession);
        };
        let mut inner = self.lock();
        if !inner.loaded {
            return Effected::new(Found::NoSession);
        }
        let mut writes = self.settle_locked(&mut inner);
        let refuse = |because| Effected {
            value: Found::Refused(because),
            writes: Vec::new(),
        };
        // THE INDEX IS SPENT BEFORE THE OPEN, and it can be, because it does not
        // depend on the vault id: one past the highest this phone ever recorded
        // or this process ever handed out. No seed, no index: an index names a
        // node under a seed.
        let before = inner.spent;
        let key = match own {
            Some(entry) => {
                if self.secrets.own_seed(entry).is_none() {
                    return refuse(FoundRefusal::NoCore);
                }
                Some(VaultKey {
                    index: 0,
                    own: Some(entry.to_owned()),
                })
            }
            None if self.secrets.seed().is_some() => {
                let index = self
                    .secrets
                    .next_vault_index()
                    .max(inner.spent.map_or(0, |spent| spent + 1));
                inner.spent = Some(index);
                Some(VaultKey { index, own: None })
            }
            None => None,
        };
        let first = inner.holdings.is_empty();
        let Ok(path) = files::fresh_vault_file(&front.dir) else {
            inner.spent = before;
            return refuse(FoundRefusal::NoCore);
        };
        let give_back = |inner: &mut Inner, core: Option<&Handle>, because| {
            if let Some(core) = core {
                shut(core);
            }
            files::delete_vault(&front.dir, &path);
            inner.spent = before;
            Effected {
                value: Found::Refused(because),
                writes: Vec::new(),
            }
        };
        if let Some(key) = &key {
            let marker = Marker {
                index: key.index,
                own: key.own.clone(),
            };
            if path.parent().is_none_or(|home| marker.write(home).is_err()) {
                return give_back(&mut inner, None, FoundRefusal::NoCore);
            }
        }
        let Some((core, keyed)) = self.open(&path, true, key.as_ref(), true) else {
            return give_back(&mut inner, None, FoundRefusal::NoCore);
        };
        let content = if first {
            wire::FoundContent::Starters
        } else {
            wire::FoundContent::Unspecified
        };
        let display = if name.trim().is_empty() {
            strings::vault::default_vault_name(Locale::En)
        } else {
            name.to_owned()
        };
        let asked = wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: display,
                owner_name: owner.map_or_else(
                    || strings::vault::default_owner_name(Locale::En),
                    str::to_owned,
                ),
                content: content as i32,
            })),
        };
        let founded = matches!(
            core.call(&asked).map(|answer| answer.kind),
            Ok(Some(wire::response::Kind::Found(ref found))) if !found.vault_id.is_empty()
        );
        if !founded {
            return give_back(&mut inner, Some(&core), FoundRefusal::NotFounded);
        }
        let Some((vault_id, named)) = identify(&core).filter(|(id, _)| !id.is_empty()) else {
            return give_back(&mut inner, Some(&core), FoundRefusal::NotFounded);
        };
        if inner.holdings.iter().any(|held| held.vault_id == vault_id) {
            return give_back(&mut inner, Some(&core), FoundRefusal::AlreadyHeld);
        }
        let marker = match (&key, keyed) {
            (Some(key), true) => {
                writes.extend(match &key.own {
                    Some(entry) => VaultSecrets::bind_own_vault(&vault_id, entry, key.index),
                    None => self.secrets.remember_vault_index(&vault_id, key.index),
                });
                Some(Marker {
                    index: key.index,
                    own: key.own.clone(),
                })
            }
            _ => {
                if let Some(home) = path.parent() {
                    Marker::remove(home);
                }
                None
            }
        };
        self.pump(&vault_id, &core);
        inner.outcome = Some(fill(
            &if own.is_some() {
                custody_words::made_own_body(Locale::En)
            } else {
                custody_words::made_body(Locale::En)
            },
            &[("name", &named)],
        ));
        inner.holdings.push(Holding {
            vault_id: vault_id.clone(),
            path,
            name: named.clone(),
            core: Some(core),
            moved: None,
            key: key.filter(|_| keyed),
            keyed,
            marker,
        });
        self.set_foreground(&mut inner, Some(vault_id));
        drop(inner);
        self.announce();
        Effected {
            value: Found::Made(named),
            writes,
        }
    }

    // ---- forget ----------------------------------------------------------

    /// REMOVE A VAULT FROM THIS PHONE (#1025 S7-9).
    ///
    /// **This is the one thing on this type that destroys a member's rows.** THIS
    /// vault's core is closed — every other holding's stays open — the holding
    /// drops off the shelf, and the file, its byte store and its SQLite sidecars
    /// are deleted, its backup ledger and spool with them. What survives is a
    /// paired gateway's sealed copy, which the 24 words and that gateway's
    /// pairing payload restore; a vault never backed up has no copy anywhere
    /// else. Whatever calls this owes the member a confirmation that says so.
    ///
    /// The index goes with the vault and the high-water mark does not, so a
    /// later found never reuses it. A vault on its own words takes its entry
    /// with it, so a restore never lists a vault this member deleted. The next
    /// foreground is the first remaining holding, or none. Answers whether a
    /// vault was held under `vault_id`.
    pub fn forget(&self, vault_id: &str) -> Effected<bool> {
        let Some(front) = self.front.get() else {
            return Effected::new(false);
        };
        let mut inner = self.lock();
        let Some(at) = inner
            .holdings
            .iter()
            .position(|holding| holding.vault_id == vault_id)
        else {
            return Effected::new(false);
        };
        let going = inner.holdings.remove(at);
        if let Some(core) = &going.core {
            core.relock();
            shut(core);
        }
        files::delete_vault(&front.dir, &going.path);
        let mut writes = vec![VaultSecrets::forget_vault_index(vault_id)];
        writes.extend(self.secrets.forget_own_vault(vault_id));
        if inner.foreground.as_deref() == Some(vault_id) {
            let next = inner
                .holdings
                .first()
                .map(|holding| holding.vault_id.clone());
            self.set_foreground(&mut inner, next.clone());
            if let Some(next) = next {
                self.wake_locked(&mut inner, &next);
            }
        }
        drop(inner);
        self.announce();
        Effected {
            value: true,
            writes,
        }
    }

    // ---- rename ----------------------------------------------------------

    /// RENAME A VAULT, IN ITS OWN FILE: `vault.rename` writes `vault.name`, the
    /// one place a vault's name lives, and the holding takes the name the
    /// command wrote. A resting holding is woken to be written; a vault that
    /// moved is read-only and is not renamed. `false` when the name is blank or
    /// the core refused it.
    pub fn rename(&self, vault_id: &str, name: &str) -> bool {
        let wanted = name.trim();
        if wanted.is_empty() {
            return false;
        }
        let mut inner = self.lock();
        let Some(held) = inner
            .holdings
            .iter()
            .find(|holding| holding.vault_id == vault_id)
        else {
            return false;
        };
        if held.moved.is_some() {
            return false;
        }
        let Some(core) = self.wake_locked(&mut inner, vault_id) else {
            return false;
        };
        let input = serde_json::json!({ "name": wanted })
            .to_string()
            .into_bytes();
        let asked = wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: "vault.rename".to_owned(),
                input,
                invoke_key: format!("shelf:rename:{}", files_token()),
                ..wire::Command::default()
            })),
        };
        let executed = matches!(
            core.call(&asked).map(|answer| answer.kind),
            Ok(Some(wire::response::Kind::Command(ref outcome)))
                if outcome.status == wire::CommandStatus::Executed as i32
        );
        if !executed {
            return false;
        }
        if let Some(holding) = inner
            .holdings
            .iter_mut()
            .find(|holding| holding.vault_id == vault_id)
        {
            wanted.clone_into(&mut holding.name);
        }
        drop(inner);
        self.announce();
        true
    }

    // ---- restore and re-key ----------------------------------------------

    /// HOLD WHAT A RESTORE BROUGHT BACK, KEYED (#1047 E1, R-1047-E3).
    ///
    /// Each file is asked which vault it is — the id the shelf keys on is the one
    /// the file names — and that id is given the index the restore found it at.
    /// The SEED must already be stored. A vault restored from its own words
    /// opens with them (R-1047-E18), and its entry takes the vault's name for a
    /// later restore's list. Answers how many vaults were added.
    pub fn adopt_restored(&self, restored: &[Restored]) -> Effected<usize> {
        if self.front.get().is_none() {
            return Effected::new(0);
        }
        let mut inner = self.lock();
        let mut writes = Vec::new();
        let mut added = 0;
        for vault in restored {
            let path = PathBuf::from(&vault.path);
            let Some(named) = self.open(&path, false, None, false).and_then(|(probe, _)| {
                let named = identify(&probe);
                shut(&probe);
                named
            }) else {
                continue;
            };
            let (vault_id, name) = named;
            if vault_id.is_empty() || inner.holdings.iter().any(|held| held.vault_id == vault_id) {
                continue;
            }
            let key = VaultKey {
                index: vault.index,
                own: vault.own.clone(),
            };
            let Some((core, keyed)) = self.open_keyed_or_not(&path, Some(&key)) else {
                continue;
            };
            match &vault.own {
                Some(own) => {
                    writes.extend(VaultSecrets::bind_own_vault(&vault_id, own, vault.index));
                    writes.extend(self.secrets.label_own_seed(own, &name));
                }
                None => writes.extend(self.secrets.remember_vault_index(&vault_id, vault.index)),
            }
            self.pump(&vault_id, &core);
            inner.holdings.push(Holding {
                vault_id: vault_id.clone(),
                path,
                name,
                core: Some(core),
                moved: None,
                key: Some(key),
                keyed,
                marker: None,
            });
            if inner.foreground.is_none() {
                self.set_foreground(&mut inner, Some(vault_id));
            }
            added += 1;
        }
        drop(inner);
        if added > 0 {
            self.announce();
        }
        Effected {
            value: added,
            writes,
        }
    }

    /// REOPEN EVERY UNKEYED HOLDING THAT CAN NOW BE KEYED (#1047 E1, R-1047-E5).
    ///
    /// What handing the words back does: the seed is stored again, and every
    /// holding with a recorded index is closed and reopened with it. A holding
    /// with no recorded index stays as it is — the shelf never guesses one.
    /// Answers how many holdings are keyed afterwards.
    pub fn rekey(&self) -> usize {
        if self.front.get().is_none() {
            return 0;
        }
        let mut inner = self.lock();
        let mut changed = false;
        for at in 0..inner.holdings.len() {
            let holding = &inner.holdings[at];
            if holding.keyed {
                continue;
            }
            let Some(key) = holding
                .key
                .clone()
                .or_else(|| self.secrets.vault_key(&holding.vault_id))
                .filter(|key| self.secrets.seed_for(key).is_some())
            else {
                continue;
            };
            let (vault_id, path) = (holding.vault_id.clone(), holding.path.clone());
            if let Some(core) = &holding.core {
                shut(core);
            }
            let reopened = self.open_keyed_or_not(&path, Some(&key));
            if let Some((core, _)) = &reopened {
                self.pump(&vault_id, core);
            }
            let holding = &mut inner.holdings[at];
            changed = true;
            match reopened {
                Some((core, keyed)) => {
                    holding.core = Some(core);
                    holding.keyed = keyed;
                    holding.key = Some(key);
                }
                None => {
                    holding.core = None;
                    holding.keyed = false;
                }
            }
        }
        let keyed = inner
            .holdings
            .iter()
            .filter(|holding| holding.keyed)
            .count();
        drop(inner);
        if changed {
            self.announce();
        }
        keyed
    }

    /// How many holdings have an index recorded on this phone.
    #[must_use]
    pub fn indexed_holdings(&self) -> usize {
        self.lock()
            .holdings
            .iter()
            .filter(|holding| {
                holding.key.is_some() || self.secrets.vault_index(&holding.vault_id).is_some()
            })
            .count()
    }

    /// Whether any vault is on this phone.
    #[must_use]
    pub fn holds_a_vault(&self) -> bool {
        !self.lock().holdings.is_empty()
    }

    /// The vault in front, if any.
    #[must_use]
    pub fn foreground(&self) -> Option<Foreground> {
        let inner = self.lock();
        let front = inner.foreground.as_ref()?;
        inner
            .holdings
            .iter()
            .find(|holding| &holding.vault_id == front)
            .map(|holding| Foreground {
                vault_id: holding.vault_id.clone(),
                name: holding.name.clone(),
            })
    }

    // ---- rest ------------------------------------------------------------

    /// CLOSE EVERY CORE BUT THE FOREGROUND'S (#1025 S7-13, ruling F): the
    /// operating system asking for its memory back. The only thing besides
    /// [`Self::forget`] that closes a background core. The foreground is kept
    /// because closing it would tear the screen the member is looking at out
    /// from under them. The log is folded into the file as each one closes.
    pub fn rest(&self) {
        let mut inner = self.lock();
        let front = inner.foreground.clone();
        let mut changed = false;
        for holding in &mut inner.holdings {
            if Some(&holding.vault_id) == front.as_ref() {
                continue;
            }
            if let Some(core) = holding.core.take() {
                core.relock();
                shut(&core);
                changed = true;
            }
        }
        drop(inner);
        if changed {
            self.announce();
        }
    }

    // ---- plumbing --------------------------------------------------------

    fn set_foreground(&self, inner: &mut Inner, vault_id: Option<String>) {
        if let Some(front) = self.front.get() {
            files::write_foreground(&front.dir, vault_id.as_deref());
        }
        inner.foreground = vault_id;
    }

    /// Reopen a RESTING holding, or answer the core it already has. Called with
    /// the lock held.
    fn wake_locked(&self, inner: &mut Inner, vault_id: &str) -> Option<Handle> {
        self.front.get()?;
        let at = inner
            .holdings
            .iter()
            .position(|holding| holding.vault_id == vault_id)?;
        if let Some(core) = &inner.holdings[at].core {
            return Some(core.clone());
        }
        let key = inner.holdings[at]
            .key
            .clone()
            .or_else(|| self.secrets.vault_key(vault_id));
        let path = inner.holdings[at].path.clone();
        let (core, keyed) = self.open_keyed_or_not(&path, key.as_ref())?;
        self.pump(vault_id, &core);
        let holding = &mut inner.holdings[at];
        holding.core = Some(core.clone());
        holding.keyed = keyed;
        if keyed {
            holding.key = key;
        }
        Some(core)
    }

    /// Open `path` keyed when `key` says how and the seed is on this phone,
    /// and unkeyed otherwise: a keyed open the core refuses falls back to the
    /// unkeyed one rather than losing the vault from the shelf.
    fn open_keyed_or_not(&self, path: &Path, key: Option<&VaultKey>) -> Option<(Handle, bool)> {
        if key.is_some()
            && let Some(opened) = self.open(path, false, key, true)
            && opened.1
        {
            return Some(opened);
        }
        self.open(path, false, None, true)
    }

    /// THE ONE OPEN (#1029 §1): a path, whether this call may found a vault
    /// there, and the key to open it at (#1047 W2). Answers the core and
    /// whether it was KEYED: a key with no seed on this phone opens unkeyed. The
    /// seed lives for this call and no longer; a `String` cannot be zeroed, so
    /// the defence is scope, not scrubbing.
    fn open(
        &self,
        path: &Path,
        create: bool,
        key: Option<&VaultKey>,
        prepare: bool,
    ) -> Option<(Handle, bool)> {
        let seed = key.and_then(|key| {
            self.secrets
                .seed_for(key)
                .and_then(|hex| files::unhex(&hex))
                .and_then(|bytes| <[u8; centraid_core::SEED_BYTES]>::try_from(bytes).ok())
                .map(|bytes| (Seed::from_bytes(bytes), key.index))
        });
        let mut config = CoreConfig::new(path);
        if !create {
            config = config.opening_existing();
        }
        let keyed = seed.is_some();
        if let Some((seed, index)) = seed {
            config = config.with_seed(seed, index);
        }
        let core = Core::open(config).ok()?;
        if prepare && let Some(front) = self.front.get() {
            (front.prepare)(&core);
        }
        Some((core, keyed))
    }

    /// Forward the events of `core` to the front while its vault is in front.
    /// One thread per open core; it ends when the core is closed, and drops
    /// what a background vault says (a screen reads the vault in front, and a
    /// switch reopens every screen).
    fn pump(&self, vault_id: &str, core: &Handle) {
        let shelf = self.me.clone();
        let vault_id = vault_id.to_owned();
        let core = core.clone();
        std::thread::spawn(move || {
            loop {
                match core.next_event(Duration::from_millis(250)) {
                    Ok(Some(event)) => {
                        let Some(shelf) = shelf.upgrade() else {
                            return;
                        };
                        shelf.forward(&vault_id, event);
                    }
                    Ok(None) => {
                        if shelf.strong_count() == 0 {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
    }

    fn forward(&self, vault_id: &str, event: wire::Event) {
        let Some(front) = self.front.get() else {
            return;
        };
        if self.lock().foreground.as_deref() != Some(vault_id) {
            return;
        }
        // A FULL QUEUE IS A STALL THE PRODUCER WAITS OUT, never a drop.
        while !front.events.push(event.clone()) {
            if front.events.is_closed() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Tell every screen that read `holdings` that the shelf changed.
    fn announce(&self) {
        let Some(front) = self.front.get() else {
            return;
        };
        let event = wire::Event {
            kind: Some(wire::event::Kind::Change(wire::ChangeEvent {
                table: SHELF_TABLE.to_owned(),
                pk_set: Vec::new(),
            })),
        };
        if front.events.push(event.clone()) {
            return;
        }
        let events = Arc::clone(&front.events);
        std::thread::spawn(move || {
            while !events.push(event.clone()) {
                if events.is_closed() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    }
}

/// ENROLLMENT'S SEAM (`custody::keeper`): the words screens found a vault, hold
/// what a restore laid down and re-key through the shelf.
impl Keeper for Shelf {
    fn found(&self, own: Option<&str>, name: &str) -> Effected<Found> {
        Self::found(self, own, name)
    }

    fn adopt_restored(&self, restored: &[Restored]) -> Effected<usize> {
        Self::adopt_restored(self, restored)
    }

    fn rekey(&self) -> usize {
        Self::rekey(self)
    }

    fn indexed_holdings(&self) -> usize {
        Self::indexed_holdings(self)
    }

    fn holds_a_vault(&self) -> bool {
        Self::holds_a_vault(self)
    }

    fn foreground(&self) -> Option<Foreground> {
        Self::foreground(self)
    }
}

/// THE PASS SERVICE'S SEAM (`passes::conductor`): which vaults are held and
/// drainable, and a vault's own core to run its pass on.
impl Holdings for Shelf {
    fn held(&self) -> Vec<Held> {
        Vaults::held(self)
            .into_iter()
            .map(|held| Held {
                vault_id: held.vault_id,
                drainable: held.drainable,
            })
            .collect()
    }

    fn core(&self, vault_id: &str) -> Option<Handle> {
        Vaults::core_of(self, vault_id)
    }
}

impl Vaults for Shelf {
    fn foreground_id(&self) -> Option<String> {
        self.lock().foreground.clone()
    }

    fn foreground_core(&self) -> Option<Handle> {
        let mut inner = self.lock();
        let front = inner.foreground.clone()?;
        self.wake_locked(&mut inner, &front)
    }

    fn held(&self) -> Vec<HeldVault> {
        let inner = self.lock();
        ordered(&inner)
            .into_iter()
            .map(|holding| HeldVault {
                vault_id: holding.vault_id.clone(),
                drainable: holding.core.is_some() && holding.moved.is_none(),
            })
            .collect()
    }

    fn core_of(&self, vault_id: &str) -> Option<Handle> {
        let mut inner = self.lock();
        self.wake_locked(&mut inner, vault_id)
    }

    fn awake(&self) -> Vec<Handle> {
        self.lock()
            .holdings
            .iter()
            .filter_map(|holding| holding.core.clone())
            .collect()
    }

    fn holdings(&self) -> wire::Holdings {
        let inner = self.lock();
        wire::Holdings {
            loaded: inner.loaded,
            foreground: inner.foreground.clone().unwrap_or_default(),
            vaults: ordered(&inner)
                .into_iter()
                .map(|holding| wire::HeldVault {
                    vault_id: holding.vault_id.clone(),
                    name: holding.name.clone(),
                    foreground: inner.foreground.as_ref() == Some(&holding.vault_id),
                    resting: holding.core.is_none(),
                    keyed: holding.keyed,
                    own_words: self.secrets.own_seed_of(&holding.vault_id).is_some(),
                    frozen: holding.moved.as_ref().map(|moved| wire::HeldFrozen {
                        since: moved.at_iso.chars().take(DATE_CHARS).collect(),
                        unacked: moved.unacked,
                    }),
                })
                .collect(),
        }
    }

    fn bring_to_front(&self, vault_id: &str) -> bool {
        let mut inner = self.lock();
        if self.wake_locked(&mut inner, vault_id).is_none() {
            return false;
        }
        if inner.foreground.as_deref() != Some(vault_id) {
            // THE VAULT LEFT IS RELOCKED: an unlocked Locker is a fact about the
            // vault the member is looking at.
            if let Some(core) = inner
                .foreground
                .as_ref()
                .and_then(|front| inner.holdings.iter().find(|h| &h.vault_id == front))
                .and_then(|holding| holding.core.as_ref())
            {
                core.relock();
            }
            self.set_foreground(&mut inner, Some(vault_id.to_owned()));
            drop(inner);
            self.announce();
        }
        true
    }

    fn freeze(&self, vault_id: &str, at: &str, unacked: u64) {
        let mut inner = self.lock();
        let Some(holding) = inner
            .holdings
            .iter_mut()
            .find(|holding| holding.vault_id == vault_id)
        else {
            return;
        };
        let moved = Moved {
            at_iso: at.to_owned(),
            unacked,
        };
        if holding.moved.as_ref() == Some(&moved) {
            return;
        }
        holding.moved = Some(moved);
        drop(inner);
        self.announce();
    }

    fn close_all(&self) {
        let mut inner = self.lock();
        for holding in &mut inner.holdings {
            if let Some(core) = holding.core.take() {
                core.relock();
                shut(&core);
            }
        }
    }
}

/// `YYYY-MM-DD` — an RFC 3339 instant's date part.
const DATE_CHARS: usize = 10;

/// The foreground first, and otherwise the shelf's own order, which is the
/// directory's. A roster that re-sorted itself as states moved would move the
/// row under a member's thumb.
fn ordered(inner: &Inner) -> Vec<&Holding> {
    let front = inner
        .holdings
        .iter()
        .find(|holding| Some(&holding.vault_id) == inner.foreground.as_ref());
    front
        .into_iter()
        .chain(
            inner
                .holdings
                .iter()
                .filter(|holding| Some(&holding.vault_id) != inner.foreground.as_ref()),
        )
        .collect()
}

/// Ask an open core which vault it holds: its id and its name. An unnamed,
/// unidentified file is not a vault, and a roster row for it would be a blank
/// the member could tap.
fn identify(core: &Handle) -> Option<(String, String)> {
    let (id, name) = core
        .with_vault(|vault| Ok((vault.self_id()?, vault.display_name()?)))
        .ok()?;
    let id = id.unwrap_or_default();
    let name = name.unwrap_or_default();
    (!id.is_empty() || !name.is_empty()).then_some((id, name))
}

/// Close a core and fold its log into the file, so what is on disk is the whole
/// vault and a directory about to be deleted or a file about to be reopened has
/// no other connection open on it.
fn shut(core: &Handle) {
    core.close();
    let _ = core.close_file();
}

/// A token for an invoke key.
fn files_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
