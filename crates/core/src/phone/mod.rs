//! THE PHONE'S BACKUP PLANE, AS THE CORE'S DOORS (#1029 W15,
//! [#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! `phone.proto` states the shapes and why none of them is a registered
//! command. This module is the core's half of them, over
//! `centraid_vault::backup2` — the snapshot, the ledger, the spool, the mover,
//! retention and restore — and the gateway's pinned client:
//!
//! | Module | Door |
//! |---|---|
//! | [`pair`] | `pair_phone`: a scanned pairing payload becomes a destination in the ledger |
//! | [`drain`] | `drain`, the pass; `handoff`, `settle` and `reconcile`, the operating system's half of it |
//! | [`fetch`] | `fetch_original`, and the derivatives a restore brings back |
//! | [`restore`] | `restore`: every vault back from 24 words and a gateway's pairing payload |
//! | [`link`] | the client to one gateway, and the plane's `Store` over it |
//! | this file | `backup_status`, `pins`, `forget_destination`, `releasable`, `released` |
//!
//! # WHERE THE PLANE'S STATE LIVES, AND WHY IT IS NOT IN THE VAULT
//!
//! Beside the vault file, never inside it, all of it device-local and derived
//! (#1080, "WHAT IS DEVICE-LOCAL AND DERIVED"): `<stem>.backup.db` is the
//! ledger — the gateways this phone is paired with, their tokens and pinned
//! certificates, every acknowledgement, the queue, and where each content
//! hash's bytes are on this phone; `<stem>.spool/` holds sealed parts waiting
//! to move; `<stem>.scratch/` holds a snapshot's page-identical copy while it
//! is described. A snapshot of the vault therefore never carries the state of
//! its own upload, and a restored phone inherits no dead phone's token. Lose
//! all three and the phone re-pairs and re-asks the gateway what it holds; the
//! backup is not lost. The shells exclude the whole directory from OS backup.
//!
//! # WHERE THE KEYS COME FROM, AND WHY THIS FILE HOLDS NONE
//!
//! Every object is sealed and named from the vault's root key
//! (`K_backup = derive_key("centraid backup v2 root", root)`), and a claim is
//! signed by the vault's identity key; both derive from the 24 words at this
//! vault's index. **This core does not write them down.** They arrive the way
//! `CONTRACT.md` §4b says a secret arrives — from the shell's secure store,
//! through the open configuration — and a core opened without them reads and
//! writes its vault perfectly well and cannot back up, which is an honest
//! state a shell draws ("unlock to back up") and not a failure.

pub mod drain;
pub mod fetch;
pub mod link;
pub mod pair;
pub mod phrase;
pub mod restore;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_gateway2::rules::ids::VaultId;
use centraid_vault::Vault;
use centraid_vault::backup2::PlaneError;
use centraid_vault::backup2::files::{ContentFile, content_files};
use centraid_vault::backup2::ledger::{Destination, Ledger, LocalSource};
use centraid_vault::backup2::naming::{BackupKeys, Name, PlaintextHash, keys_from_root, names_of};
use centraid_vault::backup2::spool::Spool;
use centraid_vault::backup2::store::StoreError;

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

/// THE PLANE'S FILES FOR ONE VAULT, beside the vault file, stated once.
///
/// One expression per path, because the shells exclude a directory from OS
/// backup and a second call site that chose another name would be a member's
/// sealed vault in somebody's cloud backup (#1029 W13, F5 rows 6-7).
///
/// **THE SPOOL IS OPENED ONCE A CORE.** Opening it sweeps the half-written
/// parts a crash left, and a part being written — a pass sealing a range, the
/// stage door sealing a library item as it streams — is half-written until it
/// is renamed. A second open while either runs would delete it under its
/// writer, so a core holds one `Plane` and opens its spool once, under a lock.
#[derive(Debug)]
pub struct Plane {
    vault_file: PathBuf,
    spool: std::sync::Mutex<Option<Spool>>,
}

impl Plane {
    /// The plane of the vault at `vault_file`.
    #[must_use]
    pub fn of(vault_file: &Path) -> Self {
        Self {
            vault_file: vault_file.to_path_buf(),
            spool: std::sync::Mutex::new(None),
        }
    }

    /// `<stem>.backup.db`.
    #[must_use]
    pub fn ledger_path(&self) -> PathBuf {
        Ledger::path_for(&self.vault_file)
    }

    /// `<stem>.spool/`.
    #[must_use]
    pub fn spool_dir(&self) -> PathBuf {
        Spool::dir_for(&self.vault_file)
    }

    /// `<stem>.scratch/`: a snapshot's page-identical copy, for as long as
    /// describing and spooling it takes.
    #[must_use]
    pub fn scratch_dir(&self) -> PathBuf {
        self.vault_file.with_extension("scratch")
    }

    /// Open the ledger, creating it when absent.
    ///
    /// # Errors
    /// A file that is not a ledger, one a newer build wrote, or SQLite's
    /// refusal.
    pub fn ledger(&self) -> Result<Ledger> {
        Ledger::open(self.ledger_path()).map_err(plane_error)
    }

    /// The spool, opened — and swept of a part a crash left half-written —
    /// the first time it is asked for, and only then.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn spool(&self) -> Result<Spool> {
        let mut held = self
            .spool
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(spool) = held.as_ref() {
            return Ok(spool.clone());
        }
        let opened = Spool::open(self.spool_dir()).map_err(plane_error)?;
        *held = Some(opened.clone());
        Ok(opened)
    }

    /// How many sealed bytes the spool may hold: 2 GiB, or a tenth of the
    /// free space on its volume, whichever is smaller (`Spool::budget`). A
    /// volume that will not say how much is free is read as full: the spool
    /// is then given nothing, and the phone fills no disk on a guess.
    #[must_use]
    pub fn budget(&self) -> u64 {
        let dir = self.spool_dir();
        let free =
            rustix::fs::statvfs(&dir).map_or(0, |stat| stat.f_bavail.saturating_mul(stat.f_frsize));
        Spool::budget(free)
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
        other => CoreError::Invariant {
            context: format!("the backup plane: {other}"),
        },
    }
}

/// What a store refusal is to a shell. See [`plane_error`].
pub(crate) fn store_error(error: StoreError) -> CoreError {
    match error {
        StoreError::Unreachable(reason) => CoreError::Unavailable { reason },
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

/// A ledger destination as a shell draws it. Nothing here is a token.
#[must_use]
pub fn wire_destination(destination: &Destination) -> wire::Destination {
    wire::Destination {
        gateway_id: destination.gateway_id.clone(),
        label: destination.label.clone(),
        addrs: destination.addrs.clone(),
        cert_der: destination.cert_der.clone(),
        last_seen_ms: destination
            .last_seen_ms
            .and_then(|ms| i64::try_from(ms).ok())
            .unwrap_or(0),
        last_ack_ms: destination
            .last_ack_ms
            .and_then(|ms| i64::try_from(ms).ok())
            .unwrap_or(0),
    }
}

/// The gateway this phone was superseded at, and the epoch that superseded
/// it, when one did. A phone moved at any destination is no longer the
/// vault's writer and freezes read-only for it (#1029 F1).
///
/// # Errors
/// The ledger's refusal.
pub fn moved(ledger: &Ledger) -> Result<Option<(String, u64)>> {
    for destination in ledger.destinations().map_err(plane_error)? {
        if let Some(epoch) = ledger.moved(&destination.gateway_id).map_err(plane_error)? {
            return Ok(Some((destination.gateway_id, epoch)));
        }
    }
    Ok(None)
}

/// A raw 32-byte content hash off the wire.
pub(crate) fn hash_of(raw: &[u8]) -> Result<PlaintextHash> {
    <[u8; 32]>::try_from(raw)
        .map(PlaintextHash::from_bytes)
        .map_err(|_| CoreError::InvalidRequest {
            detail: format!("a content hash is 32 bytes, and this one is {}", raw.len()),
        })
}

// ─── pins and forget ────────────────────────────────────────────────────────

/// **The certificates a shell's own TLS pins** (`pins`). Read from the
/// ledger; nothing is dialled.
///
/// # Errors
/// The ledger's refusal.
pub fn pins(plane: &Plane) -> Result<wire::PinsResponse> {
    let ledger = plane.ledger()?;
    Ok(wire::PinsResponse {
        destinations: ledger
            .destinations()
            .map_err(plane_error)?
            .iter()
            .map(wire_destination)
            .collect(),
    })
}

/// **Forget one gateway** (`forget_destination`, the root's ruling A5). Its
/// row and every acknowledgement it gave leave the ledger, so what it held is
/// prepared again for the gateways left; what it stores is left as it is.
///
/// # Errors
/// The ledger's refusal.
pub fn forget_destination(
    plane: &Plane,
    request: &wire::ForgetDestinationRequest,
) -> Result<wire::ForgetDestinationResponse> {
    let ledger = plane.ledger()?;
    let known = ledger
        .destination(&request.gateway_id)
        .map_err(plane_error)?
        .is_some();
    if known {
        ledger
            .remove_destination(&request.gateway_id)
            .map_err(plane_error)?;
    }
    Ok(wire::ForgetDestinationResponse { forgotten: known })
}

// ─── status ─────────────────────────────────────────────────────────────────

/// Where every file the vault knows stands, against the ledger.
#[derive(Debug, Default)]
pub(crate) struct Standing {
    pub total: u64,
    pub confirmed: u64,
    /// Plaintext bytes of every file some name of which no gateway holds.
    pub pending_bytes: u64,
    pub waiting: BTreeMap<i32, u64>,
}

/// Count where the vault's files stand. `files` and `keys` are absent on a
/// core with no vault or no seed, and then only the ledger answers.
pub(crate) fn standing(
    ledger: &Ledger,
    files: &[ContentFile],
    keys: &BackupKeys,
) -> Result<Standing> {
    let confirmed = ledger.confirmed_anywhere().map_err(plane_error)?;
    let queued: BTreeMap<Name, centraid_vault::backup2::ledger::Queued> = ledger
        .queued()
        .map_err(plane_error)?
        .into_iter()
        .map(|part| (part.name, part))
        .collect();
    let conditions = drain::Conditions::remembered(ledger)?;
    let reachable = drain::last_reach(ledger)?;
    let paired = !ledger.destinations().map_err(plane_error)?.is_empty();
    let mut out = Standing::default();
    for file in files {
        out.total += 1;
        let names = names_of(keys, &file.h, file.len);
        if names.iter().all(|name| confirmed.contains(name)) {
            out.confirmed += 1;
            continue;
        }
        out.pending_bytes = out.pending_bytes.saturating_add(file.len);
        let kind = drain::Kind::of_file(file);
        if !conditions.counts(kind) {
            // A video the member left out of the backup is not waiting: it
            // is the member's choice, and the line counts it as not backed
            // up without a reason to wait out.
            continue;
        }
        let reason = if !paired || !reachable {
            wire::WaitReason::Gateway
        } else {
            let spooled = names
                .iter()
                .filter(|name| !confirmed.contains(name))
                .all(|name| queued.contains_key(name));
            let library = !spooled
                && ledger
                    .local(&file.h)
                    .map_err(plane_error)?
                    .is_some_and(|local| local.source == LocalSource::Os);
            conditions.waits_for(kind, spooled, library)
        };
        *out.waiting.entry(reason as i32).or_default() += 1;
    }
    Ok(out)
}

/// **What the shell draws on the backup screen** (`backup_status`). Reads the
/// ledger, the spool and the vault's rows; it dials nothing, because drawing a
/// screen must not depend on somebody else's network.
///
/// # Errors
/// The ledger's or the spool's refusal, or a vault that will not read.
pub fn backup_status(
    plane: &Plane,
    vault: Option<&Vault>,
    keys: Option<&Keyring>,
) -> Result<wire::BackupStatusResponse> {
    let ledger = plane.ledger()?;
    let spool = plane.spool()?;
    let destinations = ledger.destinations().map_err(plane_error)?;
    let mut acked_at_ms: Option<u64> = None;
    for destination in &destinations {
        if let Some(at) = ledger
            .head_acked(&destination.gateway_id)
            .map_err(plane_error)?
        {
            acked_at_ms = Some(acked_at_ms.map_or(at, |held| held.max(at)));
        }
    }
    let last_snapshot_ms = ledger
        .snapshots()
        .map_err(plane_error)?
        .iter()
        .filter(|snapshot| snapshot.acked_ms.is_some())
        .map(|snapshot| snapshot.taken_at_ms)
        .max();
    let standing = match (vault, keys) {
        (Some(vault), Some(keys)) => {
            let files = content_files(vault).map_err(plane_error)?;
            standing(&ledger, &files, &keys.backup)?
        }
        _ => Standing::default(),
    };
    let records_waiting: u64 = ledger
        .queued()
        .map_err(plane_error)?
        .iter()
        .filter(|part| drain::Kind::of_part(part) == drain::Kind::Records)
        .map(|part| part.size)
        .sum();
    Ok(wire::BackupStatusResponse {
        destinations: destinations.iter().map(wire_destination).collect(),
        acked_at_ms: acked_at_ms.and_then(|ms| i64::try_from(ms).ok()),
        last_snapshot_ms: last_snapshot_ms.and_then(|ms| i64::try_from(ms).ok()),
        pending_bytes: standing.pending_bytes.saturating_add(records_waiting),
        content_total: standing.total,
        content_confirmed: standing.confirmed,
        spool_bytes: spool.bytes().map_err(plane_error)?,
        waiting: standing
            .waiting
            .iter()
            .map(|(reason, count)| wire::Waiting {
                reason: *reason,
                count: *count,
            })
            .collect(),
        frozen: moved(&ledger)?.is_some(),
    })
}

// ─── free up space ──────────────────────────────────────────────────────────

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
    let ledger = plane.ledger()?;
    let confirmed = ledger.confirmed_anywhere().map_err(plane_error)?;
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
    let mut by_ref: BTreeMap<String, Vec<centraid_vault::backup2::ledger::LocalBytes>> =
        BTreeMap::new();
    for local in ledger.locals().map_err(plane_error)? {
        if local.source == LocalSource::Os
            && let Some(os_ref) = local.os_ref.clone()
        {
            by_ref.entry(os_ref).or_default().push(local);
        }
    }
    let mut items: Vec<(String, Vec<wire::Releasable>)> = Vec::new();
    for (os_ref, locals) in by_ref {
        let mut group = Vec::with_capacity(locals.len());
        let mut created = String::new();
        let whole = locals.iter().all(|local| {
            let Some(file) = files.get(&local.hash) else {
                // A hash the vault no longer names is no original of it.
                return false;
            };
            let safe = !local.edited
                && !kept.contains(&local.hash.to_hex())
                && names_of(&keys.backup, &file.h, file.len)
                    .iter()
                    .all(|name| confirmed.contains(name));
            if safe {
                if created.is_empty() || file.created_at < created {
                    created.clone_from(&file.created_at);
                }
                group.push(wire::Releasable {
                    content_hash: file.h.as_bytes().to_vec(),
                    os_ref: os_ref.clone(),
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
    let ledger = plane.ledger()?;
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
