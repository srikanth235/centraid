//! THE PHONE'S BACKUP PLANE, AS THE CORE'S DOORS (#1029 W15,
//! [#1209](https://github.com/srikanth235/centraid/issues/1209), `contracts/backup/spec.md`).
//!
//! `phone.proto` states the shapes and why none of them is a registered
//! command. This module is the core's half of them: a thin I/O driver around
//! `centraid_vault::backup` (the tree, the snapshot, the device state, the
//! engine, retention and restore) and the gateway's pinned client. The engine
//! decides what is owed and what is confirmed; this module owns the windows
//! and deadlines, the member's rule per class, staging, the photo-library
//! bytes the shell streams in, the OS bundle files, and the status.
//!
//! | Module | Door |
//! |---|---|
//! | [`pair`] | `pair_phone`: a scanned pairing payload becomes a gateway in the device state |
//! | [`drive`] | `drain`, the pass: a snapshot when one is due, then the engine's passes over every reachable gateway |
//! | [`fetch`] | `fetch_original`, and the derivatives a restore brings back |
//! | [`restore`] | `restore`: every vault back from 24 words and a gateway's pairing payload |
//! | [`link`] | the client to one gateway, and the plane's `Store` over it |
//! | this file | `backup_status`, `pins`, `forget_destination`, `held_whole`, `releasable`, `released` |
//!
//! # WHERE THE PLANE'S STATE LIVES, AND WHY IT IS NOT IN THE VAULT
//!
//! Beside the vault file, never inside it, all of it device-local and derived:
//! `<stem>.state.db` is the device state (the gateways this phone is paired
//! with, never their tokens: those live in memory and the shell's secret
//! store; what each confirmed; the tree nodes; where each content hash's bytes
//! are on this phone); `<stem>.staging/` holds the few sealed bytes that cannot
//! be rebuilt from their source; `<stem>.scratch/` exists only while a check
//! restores a backup into it. No snapshot is ever copied to disk: the vault's
//! pages are read through one pinned reader and sealed as they go. Lose the
//! state and the phone re-pairs and re-asks the gateway what it holds; the
//! backup is not lost. The shells exclude the whole directory from OS backup.
//!
//! # WHERE THE KEYS COME FROM, AND WHY THIS FILE HOLDS NONE
//!
//! Every object is sealed and named from the vault's root key, and a claim is
//! signed by the vault's identity key; both derive from the 24 words at this
//! vault's index. **This core does not write them down.** They arrive the way
//! `CONTRACT.md` §4b says a secret arrives, from the shell's secure store,
//! through the open configuration, and a core opened without them reads and
//! writes its vault perfectly well and cannot back up, which is an honest
//! state a shell draws ("unlock to back up") and not a failure.

pub(crate) mod backup_reads;
pub mod check;
pub mod drive;
pub mod fetch;
pub mod link;
pub mod pair;
pub mod phrase;
pub mod restore;
pub(crate) mod shell_reads;
mod status;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_gateway::rules::ids::VaultId;
use centraid_media::sealed::Class;
use centraid_vault::Vault;
use centraid_vault::backup::PlaneError;
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::naming::{BackupKeys, PlaintextHash, keys_from_root};
use centraid_vault::backup::staging::Staging;
use centraid_vault::backup::state::{DeviceState, Gateway, LocalSource, Reach};
use centraid_vault::backup::store::StoreError;

use crate::error::{CoreError, Result};

/// EVERY KEY THIS CORE HOLDS FOR ONE VAULT, and none of them on disk.
///
/// Built at `centraid_open` from the seed the shell handed in
/// (`CONTRACT.md` §4b), and dropped when the handle is.
pub struct Keyring {
    /// The vault's own keys, at its derivation index — including Locker's
    /// `K` (`seed / vault'(i) / locker'`, #1047 Q-1047-11), which a Locker
    /// unlock copies into its session and a relock zeroes there, and the
    /// identity key a claim is signed with.
    pub vault: centraid_identity::VaultKeys,
    /// `K_backup` and `K_name`: every part is sealed under the first and
    /// named under the second (#1080, "Identity, keys and names").
    pub backup: BackupKeys,
}

impl Keyring {
    /// Derive everything from a seed and an index.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] when the index is the reserved account
    /// index, which is the one thing `restore_vault_keys` refuses.
    pub fn derive(seed: &centraid_identity::Seed, index: u32) -> Result<Self> {
        let vault =
            centraid_identity::derive::restore_vault_keys(seed, index).map_err(|error| {
                CoreError::InvalidRequest {
                    detail: format!("the vault seed will not derive: {error}"),
                }
            })?;
        Ok(Self::of(vault))
    }

    /// The keyring over keys already derived.
    #[must_use]
    pub fn of(vault: centraid_identity::VaultKeys) -> Self {
        let backup = keys_from_root(vault.root.as_bytes());
        Self { vault, backup }
    }

    /// The vault's id: its identity public key.
    #[must_use]
    pub fn vault_id(&self) -> VaultId {
        VaultId::from_bytes(self.vault.identity.public().to_bytes())
    }

    /// The vault's id in its one spelling, 64 lowercase hex characters.
    #[must_use]
    pub fn vault_hex(&self) -> String {
        hex::encode(self.vault.identity.public().to_bytes())
    }
}

/// What a pass learned of one gateway that the status draws without dialling (#1191): the
/// deletes it is holding, the last read-back, whether a kept manifest could not be read.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct GatewayNotes {
    pub held_count: u32,
    /// The earliest purge among the holds, on the gateway's clock; 0 when none is held.
    pub held_purge_at_ms: i64,
    pub sample_checked: u32,
    pub sample_of: u32,
    pub manifest_unreadable: bool,
    /// When retention last collected there, on the phone's clock; 0 until the gateway was first
    /// seen by a pass.
    pub collected_ms: u64,
    /// Why the last pass stopped at this gateway when it refused (its disk is full, an object
    /// too large, another code): the reason the status names, until a pass is not refused there.
    pub refusal: Option<wire::WaitReason>,
}

/// THE PLANE'S FILES FOR ONE VAULT, beside the vault file, stated once.
///
/// One expression per path, because the shells exclude a directory from OS
/// backup and a second call site that chose another name would be a member's
/// sealed vault in somebody's cloud backup (#1029 W13, F5 rows 6-7).
///
/// **STAGING IS OPENED ONCE A CORE.** Opening it sweeps the partial files a
/// crash left, and a file being written (a pass staging a sealed range, the
/// stage door sealing a library item as it streams) is partial until it is
/// renamed. A second open while either runs would delete it under its writer,
/// so a core holds one `Plane` and opens its staging area once, under a lock.
#[derive(Debug)]
pub struct Plane {
    vault_file: PathBuf,
    staging: std::sync::Mutex<Option<std::sync::Arc<Staging>>>,
    /// The most staging may hold whatever the free space
    /// (`CoreConfig::staging_ceiling`).
    ceiling: u64,
    /// Whether a pass the member asked for ("Back up now") is running now.
    /// The status read draws the work as the tap's, not as waiting for a link
    /// the tap already let it past ([`Plane::ask`]).
    asked: std::sync::atomic::AtomicBool,
    /// Free bytes a test pretends the volume has; `u64::MAX` reads the volume.
    pretend_free: std::sync::atomic::AtomicU64,
    /// The gateway tokens the shell handed over (#1191, E12), in memory only.
    tokens: std::sync::Mutex<link::Tokens>,
    /// What the last drain request told this core, kept for the status read, which carries no
    /// request of its own: the member's rule and the link as that pass saw them. In memory
    /// only: the rule is the shell's to send again with every request (#1191).
    conditions: std::sync::Mutex<Option<drive::Conditions>>,
    /// A snapshot something asked for that no pass has taken yet: the shell, or a library item
    /// whose chunks were just sealed (the tree lists them only in the next snapshot).
    snapshot_owed: std::sync::atomic::AtomicBool,
    /// What the last pass learned of each gateway that the status shows and does not dial for.
    notes: std::sync::Mutex<BTreeMap<String, GatewayNotes>>,
    /// The last snapshot could not be staged for want of room.
    no_room: std::sync::atomic::AtomicBool,
    /// The bundle files the last pass handed the OS: they stay until the pass after next, so
    /// a task still reading one is not undone by the next pass's housekeeping.
    os_files: std::sync::Mutex<Vec<Vec<PathBuf>>>,
}

impl Plane {
    /// The plane of the vault at `vault_file`.
    #[must_use]
    pub fn of(vault_file: &Path) -> Self {
        Self {
            vault_file: vault_file.to_path_buf(),
            staging: std::sync::Mutex::new(None),
            ceiling: centraid_vault::backup::staging::BUDGET_CEILING,
            asked: std::sync::atomic::AtomicBool::new(false),
            pretend_free: std::sync::atomic::AtomicU64::new(u64::MAX),
            tokens: std::sync::Mutex::new(link::Tokens::new()),
            conditions: std::sync::Mutex::new(None),
            snapshot_owed: std::sync::atomic::AtomicBool::new(false),
            notes: std::sync::Mutex::new(BTreeMap::new()),
            no_room: std::sync::atomic::AtomicBool::new(false),
            os_files: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Remember what a drain request said (the rule and the link).
    pub(crate) fn remember(&self, conditions: drive::Conditions) {
        *self
            .conditions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(conditions);
    }

    /// What the last drain request said, when one has run in this core's life.
    pub(crate) fn remembered(&self) -> Option<drive::Conditions> {
        *self
            .conditions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// What the last pass learned of `gateway_id`.
    pub(crate) fn notes(&self, gateway_id: &str) -> GatewayNotes {
        self.notes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(gateway_id)
            .copied()
            .unwrap_or_default()
    }

    /// Change what is known of `gateway_id`.
    pub(crate) fn note(&self, gateway_id: &str, change: impl FnOnce(&mut GatewayNotes)) {
        let mut held = self
            .notes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        change(held.entry(gateway_id.to_owned()).or_default());
    }

    /// Whether a snapshot something asked for is still owed.
    #[doc(hidden)]
    pub fn snapshot_owed(&self) -> bool {
        self.snapshot_owed.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn set_snapshot_owed(&self, owed: bool) {
        self.snapshot_owed
            .store(owed, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether the last snapshot could not be staged for want of room.
    pub(crate) fn no_room(&self) -> bool {
        self.no_room.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn set_no_room(&self, no_room: bool) {
        self.no_room
            .store(no_room, std::sync::atomic::Ordering::SeqCst);
    }

    /// Replace the gateway tokens held in memory (#1191, E12).
    pub fn set_tokens(&self, tokens: link::Tokens) {
        *self
            .tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = tokens;
    }

    /// The gateway tokens held in memory.
    #[must_use]
    pub fn tokens(&self) -> link::Tokens {
        self.tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Pretend the volume has `bytes` free (`None`: read it again). For tests only.
    #[doc(hidden)]
    pub fn pretend_free_bytes(&self, bytes: Option<u64>) {
        self.pretend_free.store(
            bytes.unwrap_or(u64::MAX),
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    /// Mark a pass the member asked for as running until the answer drops.
    /// One pass runs at a time (`Handle::drain`), so a flag is enough.
    #[must_use]
    pub fn ask(&self) -> Asked<'_> {
        self.asked.store(true, std::sync::atomic::Ordering::SeqCst);
        Asked(self)
    }

    /// Whether a pass the member asked for is running now.
    #[must_use]
    pub fn asking(&self) -> bool {
        self.asked.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The same plane, its staging area held under `ceiling` bytes.
    #[must_use]
    pub fn with_ceiling(mut self, ceiling: Option<u64>) -> Self {
        if let Some(ceiling) = ceiling {
            self.ceiling = ceiling;
        }
        self
    }

    /// `<stem>.state.db`.
    #[must_use]
    pub fn state_path(&self) -> PathBuf {
        DeviceState::path_for(&self.vault_file)
    }

    /// `<stem>.staging/`.
    #[must_use]
    pub fn staging_dir(&self) -> PathBuf {
        self.vault_file.with_extension("staging")
    }

    /// `<stem>.originals-owed`: present from a restore until every original it left behind has
    /// come back (R3, phase 3). An original the member freed from this phone on purpose is not
    /// one a restore owes.
    #[must_use]
    pub fn originals_marker(&self) -> PathBuf {
        self.vault_file.with_extension("originals-owed")
    }

    /// `<stem>.scratch/`: where a check restores a backup to prove it opens.
    #[must_use]
    pub fn scratch_dir(&self) -> PathBuf {
        self.vault_file.with_extension("scratch")
    }

    /// Remove what a crash left in `<stem>.scratch/` (a check's restore). A core calls this
    /// when it opens, before any pass can begin.
    pub fn sweep_scratch(&self) {
        if let Err(error) = std::fs::remove_dir_all(self.scratch_dir())
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "the scratch directory could not be removed");
        }
    }

    /// Open the device state, creating it when absent.
    ///
    /// # Errors
    /// A file that is not a device state, one a newer build wrote, or SQLite's refusal.
    pub fn state(&self) -> Result<DeviceState> {
        DeviceState::open_beside(&self.vault_file).map_err(plane_error)
    }

    /// The staging area, opened (and swept of the partial files a crash left) the first time it
    /// is asked for, and only then. Its budget is the smaller of the ceiling and a tenth of the
    /// free space, read when it is opened.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn staging(&self) -> Result<std::sync::Arc<Staging>> {
        let mut held = self
            .staging
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(staging) = held.as_ref() {
            return Ok(std::sync::Arc::clone(staging));
        }
        std::fs::create_dir_all(self.staging_dir()).map_err(|error| plane_error(error.into()))?;
        let opened = std::sync::Arc::new(
            Staging::open(self.staging_dir(), self.budget()).map_err(plane_error)?,
        );
        // A SNAPSHOT'S COPY A CRASH LEFT in `<stem>.scratch/`: the next check would clear it but
        // that may be a long while off. No check of this core's has begun.
        self.sweep_scratch();
        *held = Some(std::sync::Arc::clone(&opened));
        Ok(opened)
    }

    /// How many bytes staging may hold: the ceiling, or a tenth of the free space on its volume,
    /// whichever is smaller. A volume that will not say how much is free is read as full: staging
    /// is then given nothing, and the phone fills no disk on a guess.
    #[must_use]
    pub fn budget(&self) -> u64 {
        centraid_vault::backup::staging::budget_for(self.free_bytes()).min(self.ceiling)
    }

    /// How many bytes are free on the staging area's volume; zero for a volume that will not say,
    /// which reads as full.
    #[must_use]
    pub fn free_bytes(&self) -> u64 {
        let dir = self
            .vault_file
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf();
        // `statvfs` is POSIX, which covers both phones; on any other target the volume is read
        // as full, which gives staging nothing (C-D23) rather than a budget the target cannot
        // vouch for.
        #[cfg(unix)]
        let free =
            rustix::fs::statvfs(&dir).map_or(0, |stat| stat.f_bavail.saturating_mul(stat.f_frsize));
        #[cfg(not(unix))]
        let free = {
            let _ = &dir;
            0_u64
        };
        free.min(self.pretend_free.load(std::sync::atomic::Ordering::SeqCst))
    }

    /// Hand the files of this pass's OS bundles over, and take the ones to remove: the files of
    /// the generation before. A task the OS has not finished by the next pass lost its file, and
    /// that only wakes a pass: the pass re-reads the head and diffs.
    pub(crate) fn rotate_os_files(&self, mine: Vec<PathBuf>) -> Vec<PathBuf> {
        let mut held = self
            .os_files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        held.push(mine);
        if held.len() > 1 {
            held.remove(0)
        } else {
            Vec::new()
        }
    }
}

/// A pass the member asked for, running ([`Plane::ask`]). Dropping it, on
/// any path out of the pass, is what ends it.
#[derive(Debug)]
pub struct Asked<'plane>(&'plane Plane);

impl Drop for Asked<'_> {
    fn drop(&mut self) {
        self.0
            .asked
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The phone's clock, in milliseconds since the Unix epoch. Never a moment a
/// member is shown as "backed up": that is always the gateway's.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
        .saturating_add(CLOCK_SKEW_MS.load(std::sync::atomic::Ordering::Relaxed))
}

/// How far a test has set the phone's clock ahead (see [`now_ms`]); zero everywhere else.
pub(crate) fn skew_ms() -> u64 {
    CLOCK_SKEW_MS.load(std::sync::atomic::Ordering::Relaxed)
}

/// How far a test has set the phone's clock ahead; zero everywhere else.
static CLOCK_SKEW_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Set the phone's clock `ms` ahead of the system's, so a test can pass a day without waiting
/// one. For tests only: nothing in a shell calls it.
#[doc(hidden)]
pub fn set_clock_skew_ms(ms: u64) {
    CLOCK_SKEW_MS.store(ms, std::sync::atomic::Ordering::Relaxed);
}

/// What a plane refusal is to a shell.
///
/// A gateway that could not be reached is [`CoreError::Unavailable`], one
/// that superseded this phone is [`CoreError::VaultMoved`], one that refused is
/// [`CoreError::GatewayRefused`], and the rest — the ledger, the spool, a seal
/// that would not open — is the core's own [`CoreError::Invariant`].
pub(crate) fn plane_error(error: PlaneError) -> CoreError {
    match error {
        PlaneError::Store(store) => store_error(store),
        // A DAMAGED VAULT is not backed up and says so by its own code, never as a plane fault:
        // no head is signed over a page that fails the quick check (#1191, V21).
        PlaneError::Vault(damaged @ centraid_vault::VaultError::Damaged { .. }) => {
            CoreError::Vault(damaged)
        }
        other => CoreError::Invariant {
            context: format!("the backup plane: {other}"),
        },
    }
}

/// What a store refusal is to a shell. See [`plane_error`].
pub(crate) fn store_error(error: StoreError) -> CoreError {
    match error {
        StoreError::Unreachable(reason) => CoreError::Unavailable { reason },
        StoreError::Untrusted(reason) => CoreError::GatewayRefused { reason },
        StoreError::Moved { epoch } => CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        },
        StoreError::Refused(refusal) => CoreError::GatewayRefused {
            reason: refusal.code().to_owned(),
        },
        other => CoreError::Invariant {
            context: format!("the gateway: {other}"),
        },
    }
}

/// A paired gateway as a shell draws it. Nothing here is a token.
#[must_use]
pub fn wire_destination(gateway: &Gateway) -> wire::Destination {
    wire::Destination {
        gateway_id: gateway.gateway_id.clone(),
        label: gateway.label.clone(),
        addrs: gateway.addrs.clone(),
        cert_der: gateway.cert_der.clone(),
        last_seen_ms: gateway
            .reach_ms
            .and_then(|ms| i64::try_from(ms).ok())
            .unwrap_or(0),
        last_ack_ms: gateway
            .conf
            .and_then(|(_, ms)| i64::try_from(ms).ok())
            .unwrap_or(0),
        // `backup_status` reads the row's reach; a pairing's answer and the
        // pins are the gateway as it was written.
        pair_again: gateway.reach == Reach::PairAgain,
        held_bytes: 0,
        behind_files: 0,
        behind_bytes: 0,
        records_behind: false,
        head_snapshot_ms: None,
        reach: wire::WaitReason::Unspecified as i32,
        rolled_back: gateway.regressed,
        paired_at_ms: i64::try_from(gateway.paired_ms).unwrap_or(0),
        waiting_apps: Vec::new(),
        refused_limit_bytes: 0,
        reach_state: wire::DestinationReach::Unspecified as i32,
        held_count: 0,
        held_purge_at_ms: 0,
        held_undoable: 0,
        sample_checked: 0,
        sample_of: 0,
        manifest_unreadable: false,
        classes: Vec::new(),
    }
}

/// The gateway this phone was superseded at, and the epoch that superseded
/// it, when one did: what the status line reads ("another phone has taken
/// over", as soon as any row is moved). **It stops nothing by itself** (#1191,
/// E4): a gateway that proved a takeover stops the pass to that gateway only,
/// and [`superseded_everywhere`] is what refuses a whole door.
///
/// # Errors
/// The ledger's refusal.
pub fn moved(state: &DeviceState) -> Result<Option<(String, u64)>> {
    for gateway in state.gateways().map_err(plane_error)? {
        if let Some(epoch) = gateway.moved_epoch {
            return Ok(Some((gateway.gateway_id, epoch)));
        }
    }
    Ok(None)
}

/// The epoch that superseded this phone **at every paired gateway**, when it
/// was superseded at all of them: only then is there nowhere left to write,
/// and a door that writes refuses [`CoreError::VaultMoved`] (#1191, E4).
///
/// # Errors
/// The device state's refusal.
pub fn superseded_everywhere(state: &DeviceState) -> Result<Option<u64>> {
    let mut highest = None;
    for gateway in state.gateways().map_err(plane_error)? {
        match gateway.moved_epoch {
            Some(epoch) => highest = Some(highest.map_or(epoch, |seen: u64| seen.max(epoch))),
            None => return Ok(None),
        }
    }
    Ok(highest)
}

/// A raw 32-byte content hash off the wire.
pub(crate) fn hash_of(raw: &[u8]) -> Result<PlaintextHash> {
    <[u8; 32]>::try_from(raw)
        .map(PlaintextHash::from_bytes)
        .map_err(|_| CoreError::InvalidRequest {
            detail: format!("a content hash is 32 bytes, and this one is {}", raw.len()),
        })
}

// ─── gateway tokens ─────────────────────────────────────────────────────────

/// **The tokens the shell keeps for this vault** (`gateway_tokens`, #1191,
/// E12): the core replaces its in-memory set with the ones for this vault and
/// answers every paired gateway it was handed none for, which the next pass
/// treats as pair again. Nothing is written: a token is never in a file the
/// core owns.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a token or an id that is not hex of its
/// length; the device state's refusal.
pub fn gateway_tokens(
    plane: &Plane,
    keyring: Option<&Keyring>,
    request: &wire::GatewayTokensRequest,
) -> Result<wire::GatewayTokensResponse> {
    let vault_hex = keyring.map(Keyring::vault_hex);
    let mut held = link::Tokens::new();
    for given in &request.tokens {
        if vault_hex
            .as_deref()
            .is_some_and(|vault| vault != given.vault_id)
        {
            continue;
        }
        let token: centraid_gateway::rules::ids::Token =
            given.token.parse().map_err(|_| CoreError::InvalidRequest {
                detail: format!("the token for gateway {} is not 64 hex", given.gateway_id),
            })?;
        link::gateway_of(&given.gateway_id)?;
        held.insert(given.gateway_id.clone(), token);
    }
    let paired: Vec<String> = plane
        .state()?
        .gateways()
        .map_err(plane_error)?
        .into_iter()
        .map(|gateway| gateway.gateway_id)
        .collect();
    let pair_again = paired
        .into_iter()
        .filter(|gateway_id| !held.contains_key(gateway_id))
        .collect();
    plane.set_tokens(held);
    Ok(wire::GatewayTokensResponse { pair_again })
}

// ─── undo ───────────────────────────────────────────────────────────────────

/// How long retention leaves a name be after the member's Undo lifted its hold: the gateway's own
/// week, so an Undo is not undone by the next pass.
const UNDO_KEEP_MS: u64 = centraid_vault::backup::engine::UNDO_KEEP_MS;

/// **Lift every hold a gateway has for this vault** (`undo_held`, #1191, E6), signed by the vault
/// key, and remember the names so retention does not delete them again at once.
///
/// # Errors
/// [`CoreError::VaultMoved`] for a gateway that proved a takeover; [`CoreError::Unavailable`] for
/// one that does not answer or has no token here; the device state's refusal.
pub fn undo_held(
    plane: &Plane,
    keyring: &Keyring,
    runtime: &tokio::runtime::Handle,
    request: &wire::UndoHeldRequest,
) -> Result<wire::UndoHeldResponse> {
    use centraid_vault::backup::store::Store as _;
    let state = plane.state()?;
    let Some(row) = state.gateway(&request.gateway_id).map_err(plane_error)? else {
        return Ok(wire::UndoHeldResponse::default());
    };
    if let Some(epoch) = row.moved_epoch {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    let Some(token) = plane.tokens().get(&row.gateway_id).copied() else {
        return Err(CoreError::Unavailable {
            reason: "pair this gateway again to undo what it holds".to_owned(),
        });
    };
    let store =
        link::GatewayStore::for_gateway(&row, token, keyring.vault.identity.signing(), runtime)?;
    // THE NAMES FIRST, so retention knows what the Undo restored.
    let mut names = Vec::new();
    let mut after = None;
    loop {
        let page = store.held(after.as_ref(), 200).map_err(store_error)?;
        let Some(last) = page.last().map(|entry| entry.name) else {
            break;
        };
        names.extend(page.iter().map(|entry| entry.name));
        after = Some(last);
    }
    let restored = store.undo(None).map_err(store_error)?;
    state
        .undone_add(
            &row.gateway_id,
            &names,
            now_ms().saturating_add(UNDO_KEEP_MS),
        )
        .map_err(plane_error)?;
    plane.note(&row.gateway_id, |notes| {
        notes.held_count = 0;
        notes.held_purge_at_ms = 0;
    });
    Ok(wire::UndoHeldResponse {
        restored: u32::try_from(restored).unwrap_or(u32::MAX),
    })
}

// ─── pins and forget ────────────────────────────────────────────────────────

/// **The certificates a shell's own TLS pins** (`pins`). Read from the
/// ledger; nothing is dialled.
///
/// # Errors
/// The ledger's refusal.
pub fn pins(plane: &Plane) -> Result<wire::PinsResponse> {
    let state = plane.state()?;
    Ok(wire::PinsResponse {
        destinations: state
            .gateways()
            .map_err(plane_error)?
            .iter()
            .map(wire_destination)
            .collect(),
    })
}

/// **Forget one gateway** (`forget_destination`, the root's ruling A5). Its
/// row and every confirmation it gave leave the device state; what it stores is left as it is.
///
/// **It also revokes this phone's token there, best-effort** (#1080, the
/// audit's finding 2): a forgotten gateway that still honoured the token would
/// keep answering anyone who copied the ledger. Any answer from the pinned
/// gateway that the token opens nothing — the revoke, or `UNAUTHORIZED`
/// because its operator already revoked it — is `revoked`; an unreachable
/// gateway, a machine that is not the pinned one, or a core with no vault keys
/// to name the vault with is not, and the row goes anyway.
///
/// **The row goes before the token is revoked**, with the token read first: a
/// pass running meanwhile is refused only once the gateway forgot the token,
/// and by then finds its gateway forgotten here too, which it answers as a
/// pass with nothing paired (`drain::run`) rather than as a refusal.
///
/// **A superseded phone forgets nothing** (#1080, the sweep's R6): the row is
/// what carries its `MOVED` mark. Gone, the phone would read as no longer
/// frozen, and pairing again would find no record of the gateway and take
/// the vault over with this phone's older copy (`pair`'s "superseded").
///
/// # Errors
/// [`CoreError::VaultMoved`] for a phone a gateway superseded; the ledger's
/// refusal.
pub fn forget_destination(
    plane: &Plane,
    keyring: Option<&Keyring>,
    runtime: &tokio::runtime::Handle,
    request: &wire::ForgetDestinationRequest,
) -> Result<wire::ForgetDestinationResponse> {
    let state = plane.state()?;
    let Some(destination) = state.gateway(&request.gateway_id).map_err(plane_error)? else {
        return Ok(wire::ForgetDestinationResponse::default());
    };
    // ONLY THE GATEWAY THAT PROVED A TAKEOVER is refused (E4): its row is what
    // carries the mark.
    if let Some(epoch) = destination.moved_epoch {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    // The row goes (with what it confirmed); the token is read from memory first.
    let token = plane.tokens().get(&request.gateway_id).copied();
    state
        .remove_gateway(&request.gateway_id)
        .map_err(plane_error)?;
    // THE DIRECTORY OF GATEWAYS CHANGED (E8): every gateway left owes a snapshot that writes it.
    for left in state.gateways().map_err(plane_error)? {
        state
            .set_directory_dirty(&left.gateway_id, true)
            .map_err(plane_error)?;
    }
    plane.set_snapshot_owed(true);
    let revoked = keyring.is_some_and(|keyring| revoke(&destination, token, keyring, runtime));
    Ok(wire::ForgetDestinationResponse {
        forgotten: true,
        revoked,
        // THE SHELL DELETES THE TOKEN IT KEEPS (#1191, E12), named by its key.
        forget_token: keyring.map(|keyring| wire::GatewayToken {
            vault_id: keyring.vault_hex(),
            gateway_id: destination.gateway_id.clone(),
            token: String::new(),
        }),
    })
}

/// The most candidates one refresh dials, and the most addresses the ledger
/// keeps for a gateway: a LAN advertises a handful of interface addresses, and
/// a list that only grows would dial its dead ones for ever.
const ADDRESS_CAP: usize = 8;

/// How long one candidate may take to answer. A browse's addresses are on the
/// LAN or nowhere, so this is far shorter than a pass's own dial.
const REFRESH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// **A paired gateway found again at new addresses** (`refresh_destination`,
/// Q-1080-D3). The shell's foreground browse of `_centraid-gateway._tcp` hands
/// over the addresses of whatever advertised this gateway's id; **the shell's
/// match is a hint and this is the check**. Each candidate is dialled with the
/// certificate this phone pinned at pairing, so a machine that only claims the
/// id is refused by TLS, and must answer `GET /v1/info` with this gateway's own
/// id. The ones that did are recorded first, ahead of what the ledger had; the
/// ones that did not are not recorded at all.
///
/// It sends no token and writes nothing to the gateway, and it changes only the
/// addresses of one ledger row: the certificate, the token and every
/// acknowledgement stay. A superseded phone refuses it like every other door
/// that reaches a gateway ([`CoreError::VaultMoved`]).
///
/// # Errors
/// [`CoreError::VaultMoved`] for a phone a gateway superseded; the ledger's
/// refusal.
pub fn refresh_destination(
    plane: &Plane,
    runtime: &tokio::runtime::Handle,
    request: &wire::RefreshDestinationRequest,
) -> Result<wire::RefreshDestinationResponse> {
    use centraid_gateway::client::Client;

    let state = plane.state()?;
    let Some(destination) = state.gateway(&request.gateway_id).map_err(plane_error)? else {
        return Ok(wire::RefreshDestinationResponse::default());
    };
    // ONLY THE GATEWAY THAT PROVED A TAKEOVER is refused (E4): its row is what
    // carries the mark.
    if let Some(epoch) = destination.moved_epoch {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    let candidates = refresh_candidates(&request.candidates);
    let mut answered: Vec<String> = Vec::new();
    for candidate in candidates {
        let client = Client::trusting(vec![candidate.clone()], destination.cert_der.clone());
        let info = runtime.block_on(async {
            tokio::time::timeout(REFRESH_TIMEOUT, client.info())
                .await
                .ok()
                .and_then(std::result::Result::ok)
        });
        // THE GATEWAY'S OWN ID, NOT THE ADVERTISEMENT'S: TLS has already shown
        // the certificate is the pinned one, and this is the second check.
        if info.is_some_and(|info| info.gateway_id.hex() == destination.gateway_id) {
            answered.push(candidate);
        }
    }
    if answered.is_empty() {
        return Ok(wire::RefreshDestinationResponse {
            refreshed: false,
            addrs: destination.addrs,
        });
    }
    let mut addrs = answered;
    for recorded in &destination.addrs {
        if !addrs.contains(recorded) {
            addrs.push(recorded.clone());
        }
    }
    addrs.truncate(ADDRESS_CAP);
    let mut renewed = destination.clone();
    renewed.addrs.clone_from(&addrs);
    // The row is written over, and what it confirmed stays (the epoch is the same): only where
    // to reach it changed, which the directory records, so it is marked stale.
    state.add_gateway(&renewed).map_err(plane_error)?;
    Ok(wire::RefreshDestinationResponse {
        refreshed: true,
        addrs,
    })
}

/// The candidates a refresh will dial: IP socket addresses only (a name is the
/// platform's to resolve and the core never resolves one here), no duplicates,
/// and no IPv6 link-local address, which cannot be dialled without a scope the
/// advertisement does not carry. At most [`ADDRESS_CAP`].
pub(crate) fn refresh_candidates(given: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for text in given {
        let Ok(address) = text.trim().parse::<std::net::SocketAddr>() else {
            continue;
        };
        if address.port() == 0 || address.ip().is_unspecified() || address.ip().is_multicast() {
            continue;
        }
        if let std::net::IpAddr::V6(v6) = address.ip()
            && (v6.segments()[0] & 0xffc0) == 0xfe80
        {
            continue;
        }
        let canonical = address.to_string();
        if !kept.contains(&canonical) {
            kept.push(canonical);
        }
        if kept.len() == ADDRESS_CAP {
            break;
        }
    }
    kept
}

/// Ask `destination` to revoke this phone's token for `vault`. Whether the
/// pinned gateway answered that the token opens nothing there now.
fn revoke(
    destination: &Gateway,
    token: Option<centraid_gateway::rules::ids::Token>,
    keyring: &Keyring,
    runtime: &tokio::runtime::Handle,
) -> bool {
    use centraid_gateway::client::ClientError;
    use centraid_gateway::rules::Refusal;
    // NO TOKEN IN MEMORY (the shell never handed one): there is nothing to revoke with.
    let Some(token) = token else {
        return false;
    };
    let vault = keyring.vault_id();
    let store = match link::GatewayStore::for_gateway(
        destination,
        token,
        keyring.vault.identity.signing(),
        runtime,
    ) {
        Ok(store) => store,
        Err(error) => {
            tracing::debug!(%error, "a forgotten gateway's store does not open");
            return false;
        }
    };
    match runtime.block_on(store.client().revoke(&vault)) {
        Ok(answer) => answer.revoked,
        Err(ClientError::Refused(Refusal::Unauthorized)) => true,
        Err(error) => {
            tracing::debug!(
                gateway = %destination.gateway_id,
                %error,
                "a forgotten gateway did not revoke this phone's token"
            );
            false
        }
    }
}

// ─── status ─────────────────────────────────────────────────────────────────

pub use status::backup_status;

/// THE MEMBER'S FIRST ITEM: the earliest `created_at` of a row they made or imported. One bounded
/// read, a `MIN` per kind over the `entity_by_created` index (nothing is scanned or counted). The
/// starter notes and the retired starter tasks are not the member's, and nor is the founding person.
pub(crate) fn first_item_ms(vault: &Vault) -> Option<i64> {
    let titles: Vec<&str> = crate::starters::NOTES
        .iter()
        .map(|(title, _)| *title)
        .chain(crate::starters::RETIRED_TASKS.iter().copied())
        .collect();
    centraid_vault::first_item::first_item_at(vault, &titles)
        .and_then(|at| centraid_vault::clock::parse_iso_ms(&at))
}

// ─── held whole (R4) ────────────────────────────────────────────────────────

/// **WHICH GATEWAYS HOLD ONE ORIGINAL WHOLE** (`held_whole`, R4): the delete warning's read. A
/// photo is held whole at a gateway when every chunk of its original is reachable from that
/// gateway's confirmed `oroot`; the same test the Backup screen draws. Nothing is dialled.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a hash that is not 32 bytes; the device state's refusal.
pub fn held_whole(
    plane: &Plane,
    keyring: &Keyring,
    request: &wire::HeldWholeRequest,
) -> Result<wire::HeldWholeResponse> {
    let state = plane.state()?;
    let (gateway_ids, held_whole) = if request.content_hash.is_empty()
        && !request.content_hashes.is_empty()
    {
        (Vec::new(), false)
    } else {
        let h = hash_of(&request.content_hash)?;
        let gateway_ids = status::holders(&state, &keyring.backup, &h)?;
        let held = !gateway_ids.is_empty();
        (gateway_ids, held)
    };
    let many = request
        .content_hashes
        .iter()
        .map(|raw| hash_of(raw))
        .collect::<Result<Vec<_>>>()?;
    let not_held = if many.is_empty() {
        Vec::new()
    } else {
        status::unheld(&state, &keyring.backup, &many)?
            .into_iter()
            .map(|h| h.as_bytes().to_vec())
            .collect()
    };
    Ok(wire::HeldWholeResponse {
        held_whole,
        gateway_ids,
        not_held,
    })
}

// ─── free up space ──────────────────────────────────────────────────────────

/// The library item a ref names. A shell may suffix a ref with `#<part>` for
/// one part of a single item — iOS names a Live Photo's movie
/// `<identifier>#pairedVideo` beside the still's `<identifier>` — and A20's
/// "every hash under one item" groups by the part before the `#`, so a Live
/// Photo is offered whole or not at all whichever of its halves is confirmed.
fn item_of(os_ref: &str) -> &str {
    os_ref.split('#').next().unwrap_or(os_ref)
}

/// **The originals a member may delete from the library** (`releasable`, the
/// root's rulings A19 and A20). See `ReleasableRequest` for the rule; the
/// kept albums are `<stem>.keep-originals.json` (`crate::originals`).
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a zero limit; the ledger's refusal, or a
/// vault that will not read.
pub fn releasable(
    plane: &Plane,
    vault_file: &Path,
    vault: &Vault,
    keys: &Keyring,
    request: &wire::ReleasableRequest,
) -> Result<wire::ReleasableResponse> {
    if request.limit == 0 {
        return Err(CoreError::InvalidRequest {
            detail: "a releasable request names a limit; zero is never read as \"no limit\""
                .to_owned(),
        });
    }
    let state = plane.state()?;
    // HELD WHOLE AT EVERY GATEWAY THIS PHONE FEEDS, and at least one: a file one gateway lacks
    // is not safe to release.
    let mut fed = 0_usize;
    let mut holders: BTreeMap<PlaintextHash, usize> = BTreeMap::new();
    for gateway in state.gateways().map_err(plane_error)? {
        if gateway.moved_epoch.is_some() {
            continue;
        }
        fed += 1;
        for h in status::listed_hashes(&state, &keys.backup, gateway.oroot, Class::Originals) {
            *holders.entry(h).or_default() += 1;
        }
    }
    let kept_albums = crate::originals::KeptAlbums::read(vault_file)?.album_ids;
    let kept = centraid_vault::originals::kept_hashes(vault, &kept_albums)?;
    let files: BTreeMap<PlaintextHash, ContentFile> = content_files(vault)
        .map_err(plane_error)?
        .into_iter()
        .filter(ContentFile::is_original)
        .map(|file| (file.h, file))
        .collect();
    // ONE LIBRARY ITEM, EVERY HASH UNDER IT (A20): a Live Photo is a still and
    // a film under one identifier, and the item is offered whole or not at all.
    let mut by_ref: BTreeMap<String, Vec<centraid_vault::backup::state::LocalBytes>> =
        BTreeMap::new();
    for local in state.locals().map_err(plane_error)? {
        if local.source == LocalSource::Os
            && let Some(os_ref) = local.os_ref.as_deref()
        {
            by_ref
                .entry(item_of(os_ref).to_owned())
                .or_default()
                .push(local);
        }
    }
    let mut items: Vec<(String, Vec<wire::Releasable>)> = Vec::new();
    for (item, locals) in by_ref {
        let mut group = Vec::with_capacity(locals.len());
        let mut created = String::new();
        let whole = locals.iter().all(|local| {
            let Some(file) = files.get(&local.hash) else {
                // A hash the vault no longer names is no original of it.
                return false;
            };
            // BACKED UP, ROW AND BYTES: an original whose chunks and row are in no gateway's
            // confirmed tree would, deleted from the library and lost with the phone, come back
            // nowhere. `oroot` is only ever confirmed at a root whose records were.
            let safe = !local.edited
                && !kept.contains(&local.hash.to_hex())
                && fed > 0
                && holders.get(&file.h).copied().unwrap_or(0) == fed;
            if safe {
                if created.is_empty() || file.created_at < created {
                    created.clone_from(&file.created_at);
                }
                group.push(wire::Releasable {
                    content_hash: file.h.as_bytes().to_vec(),
                    os_ref: local.os_ref.clone().unwrap_or_else(|| item.clone()),
                    size: file.len,
                    media_type: file.media_type.clone(),
                });
            }
            safe
        });
        if whole && !group.is_empty() {
            items.push((created, group));
        }
    }
    // OLDEST FIRST: the photographs a member is least likely to open again.
    items.sort_by(|left, right| left.0.cmp(&right.0));
    let total_bytes = items
        .iter()
        .flat_map(|(_, group)| group.iter().map(|item| item.size))
        .fold(0_u64, u64::saturating_add);
    let limit = usize::try_from(request.limit).unwrap_or(usize::MAX);
    let mut answered: Vec<wire::Releasable> = Vec::new();
    for (_, group) in items {
        if answered.len() + group.len() > limit && !answered.is_empty() {
            break;
        }
        answered.extend(group);
    }
    Ok(wire::ReleasableResponse {
        items: answered,
        total_bytes,
    })
}

/// **The library items the member deleted** (`released`). Their bytes are no
/// longer on this phone: the ledger forgets them in the library, and a grid
/// is told through the ordinary change event, so it draws them as fetchable.
/// Answers the asset ids that changed, for the caller to announce.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a hash that is not 32 bytes; the
/// ledger's refusal, or a vault that will not read.
pub fn released(
    plane: &Plane,
    vault: &Vault,
    request: &wire::ReleasedRequest,
) -> Result<(wire::ReleasedResponse, Vec<String>)> {
    let ledger = plane.state()?;
    let mut recorded = 0_u32;
    let mut gone: BTreeSet<String> = BTreeSet::new();
    for raw in &request.content_hash {
        let h = hash_of(raw)?;
        let in_library = ledger
            .local(&h)
            .map_err(plane_error)?
            .is_some_and(|local| local.source == LocalSource::Os);
        if in_library {
            ledger.forget_local(&h).map_err(plane_error)?;
            recorded = recorded.saturating_add(1);
            gone.insert(h.to_hex());
        }
    }
    let assets =
        centraid_vault::originals::assets_for_hashes(vault, &gone.into_iter().collect::<Vec<_>>())?;
    Ok((wire::ReleasedResponse { recorded }, assets))
}

/// The most refs one `library_assets` request may name.
pub const MAX_LIBRARY_ASSET_REFS: usize = 100;

/// **WHICH ASSET A LIBRARY ITEM WAS BACKED UP AS** (`library_assets`, #1127,
/// A20). See `LibraryAssetsRequest` for the rule: the item most recently staged
/// under a ref, and only if a live asset wraps its bytes.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for more refs than
/// [`MAX_LIBRARY_ASSET_REFS`] or a hash the ledger holds that is not 32 bytes;
/// the ledger's refusal, or a vault that will not read.
pub fn library_assets(
    plane: &Plane,
    vault: &Vault,
    request: &wire::LibraryAssetsRequest,
) -> Result<wire::LibraryAssetsResponse> {
    if request.os_ref.len() > MAX_LIBRARY_ASSET_REFS {
        return Err(CoreError::InvalidRequest {
            detail: format!("a library_assets request names at most {MAX_LIBRARY_ASSET_REFS} refs"),
        });
    }
    let wanted: BTreeSet<&str> = request
        .os_ref
        .iter()
        .map(String::as_str)
        .filter(|os_ref| !os_ref.is_empty())
        .collect();
    if wanted.is_empty() {
        return Ok(wire::LibraryAssetsResponse::default());
    }
    // THE NEWEST ITEM STAGED UNDER EACH REF: a ref an edit re-staged holds two
    // hashes, and the edit's source is the version before it, which is the
    // newer of the two at the moment the shell asks (it asks before staging).
    let mut newest: BTreeMap<&str, centraid_vault::backup::state::LocalBytes> = BTreeMap::new();
    let locals = plane.state()?.locals().map_err(plane_error)?;
    for local in locals {
        if local.source != LocalSource::Os {
            continue;
        }
        let Some(os_ref) = local
            .os_ref
            .as_deref()
            .and_then(|os_ref| wanted.get(os_ref).copied())
        else {
            continue;
        };
        // THE LAST RECORDED IS THE NEWEST (`DeviceState::locals` reads in recording order).
        newest.insert(os_ref, local);
    }
    let hashes: Vec<String> = newest.values().map(|local| local.hash.to_hex()).collect();
    let live: BTreeMap<String, String> =
        centraid_vault::originals::live_assets_for_hashes(vault, &hashes)?
            .into_iter()
            .collect();
    let items = newest
        .into_iter()
        .filter_map(|(os_ref, local)| {
            let asset_id = live.get(&local.hash.to_hex())?;
            Some(wire::LibraryAsset {
                os_ref: os_ref.to_owned(),
                asset_id: asset_id.clone(),
                content_hash: local.hash.as_bytes().to_vec(),
            })
        })
        .collect();
    Ok(wire::LibraryAssetsResponse { items })
}

#[cfg(test)]
mod asked_tests {
    /// **THE TAP IS HELD FOR EXACTLY AS LONG AS ITS PASS** (#1080, the
    /// simulator smoke): the status read follows a running "Back up now", and
    /// a pass that ends on any path stops being one.
    #[test]
    fn the_members_tap_is_held_for_exactly_its_pass() {
        let plane = super::Plane::of(std::path::Path::new("vault.db"));
        assert!(!plane.asking(), "no pass runs on a fresh plane");
        let asked = plane.ask();
        assert!(plane.asking());
        drop(asked);
        assert!(!plane.asking(), "a pass that ended is not still asking");
    }
}

#[cfg(test)]
mod first_item_tests {
    use centraid_vault::clock::{FixedClock, SeededIds};
    use centraid_vault::model::Kind;

    fn note(vault: &centraid_vault::Vault, id: &str, title: &str, at: &str) {
        vault
            .commit(|tx| {
                tx.set_producer("test.note");
                tx.insert_entity(id, Kind::Note, title, at)?;
                Ok(())
            })
            .expect("a note");
    }

    /// **THE STATUS'S `first_item_ms`**: only the starter notes and the founding person give none;
    /// the member's first note gives its own time.
    #[test]
    fn the_first_item_is_the_first_note_in_milliseconds_and_never_a_starter() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = centraid_vault::Vault::create_with(
            dir.path().join("vault.db"),
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("first-item-core")),
        )
        .expect("a vault");
        vault.found("Test", "Test Owner").expect("founded");
        for (at, (title, _)) in ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"]
            .iter()
            .zip(crate::starters::NOTES)
        {
            note(&vault, &format!("starter-{at}"), title, at);
        }
        assert_eq!(super::first_item_ms(&vault), None);
        note(&vault, "mine", "Groceries", "2026-02-03T04:05:06.000Z");
        note(&vault, "later", "Later", "2026-03-01T00:00:00.000Z");
        assert_eq!(
            super::first_item_ms(&vault),
            centraid_vault::clock::parse_iso_ms("2026-02-03T04:05:06.000Z")
        );
    }
}

#[cfg(test)]
mod item_tests {
    #[test]
    fn a_live_photo_is_one_item_under_both_its_refs() {
        assert_eq!(super::item_of("ABC-123"), "ABC-123");
        assert_eq!(super::item_of("ABC-123#pairedVideo"), "ABC-123");
        assert_eq!(
            super::item_of("content://media/external/images/media/42"),
            "content://media/external/images/media/42"
        );
    }
}

#[cfg(test)]
mod refresh_tests {
    fn given(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|text| (*text).to_owned()).collect()
    }

    /// **THE CORE DIALS IP SOCKET ADDRESSES AND NOTHING ELSE** (Q-1080-D3): a
    /// name is the platform's to resolve, a link-local IPv6 address cannot be
    /// dialled without a scope, and the list is bounded.
    #[test]
    fn only_dialable_ip_addresses_are_candidates() {
        let kept = super::refresh_candidates(&given(&[
            "192.168.1.44:7443",
            " 192.168.1.44:7443 ",
            "[2001:db8::7]:7443",
            "[fe80::1]:7443",
            "laptop.local:7443",
            "192.168.1.44",
            "192.168.1.44:0",
            "0.0.0.0:7443",
            "224.0.0.251:5353",
            "",
        ]));
        assert_eq!(kept, given(&["192.168.1.44:7443", "[2001:db8::7]:7443"]));
        let many: Vec<String> = (1..=20).map(|n| format!("10.0.0.{n}:7443")).collect();
        assert_eq!(super::refresh_candidates(&many).len(), super::ADDRESS_CAP);
    }
}
