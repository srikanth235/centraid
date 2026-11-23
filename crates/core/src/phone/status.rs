//! **WHAT THE SHELL DRAWS ON THE BACKUP SCREEN** (`backup_status`, spec §6.6).
//!
//! Read from the device state, the tree nodes it caches and the vault's rows; it dials nothing,
//! because drawing a screen must not depend on somebody else's network.
//!
//! "Backed up" is per gateway and per class: records at `conf`; thumbnails and originals whole
//! when `troot` and `oroot` equal `conf`'s root (`engine::standing`). A file is confirmed when
//! every paired gateway lists its chunks in the confirmed tree of its class, so the line counts
//! what a restore would bring back and nothing a gateway merely said once.

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{self, Class, Name, PlaintextHash, Ref};
use centraid_vault::Vault;
use centraid_vault::backup::engine::{self, Env, Policy};
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::state::{DeviceState, Gateway, LocalSource, Reach};
use centraid_vault::backup::tree;

use super::drive::Conditions;
use super::{Keyring, Plane, first_item_ms, moved, plane_error, wire_destination};
use crate::error::Result;

/// How a gateway last answered, in the word the Backup screen draws.
const fn reach_state_of(reach: Reach, repairing: bool) -> wire::DestinationReach {
    use wire::DestinationReach as R;
    match reach {
        Reach::Ok if repairing => R::Repairing,
        Reach::Ok => R::Ok,
        Reach::Unreachable => R::Unreachable,
        Reach::Busy => R::Busy,
        Reach::Untrusted => R::Untrusted,
        Reach::PairAgain => R::PairAgain,
        Reach::Moved => R::Moved,
        Reach::Frozen => R::Frozen,
        Reach::TooOld => R::GatewayOld,
    }
}

/// The reason a gateway's last answer gives for waiting, when it gives one.
const fn wait_reason_of(reach: Reach) -> Option<wire::WaitReason> {
    use wire::WaitReason as W;
    match reach {
        Reach::Ok => None,
        Reach::Unreachable | Reach::Busy | Reach::Frozen => Some(W::Gateway),
        Reach::Untrusted => Some(W::Untrusted),
        Reach::PairAgain => Some(W::PairAgain),
        Reach::Moved => None,
        // "Update your gateway" is drawn from `DestinationReach::GatewayOld`; as a wait it is the
        // gateway's.
        Reach::TooOld => Some(W::Gateway),
    }
}

/// The sealed ref of a cached tree node, when the cache holds it and it still seals to its name.
pub(crate) fn node_ref(state: &DeviceState, keys: &sealed::BackupKeys, name: &Name) -> Option<Ref> {
    let plaintext = state.get_node(name).ok()??;
    let reference = sealed::seal(keys, Class::Records, &plaintext)
        .ok()?
        .reference();
    (reference.name == *name).then_some(reference)
}

/// The hashes a confirmed root lists whole, by class: originals whose chunks are all listed, and
/// derivatives whose chunks are.
pub(crate) fn listed_hashes(
    state: &DeviceState,
    keys: &sealed::BackupKeys,
    pointer: Option<(Name, u64)>,
    class: Class,
) -> BTreeSet<PlaintextHash> {
    let mut out = BTreeSet::new();
    let Some((name, _)) = pointer else {
        return out;
    };
    let Some(reference) = node_ref(state, keys, &name) else {
        return out;
    };
    let Ok(root) = tree::root_of(state, &reference) else {
        return out;
    };
    let Ok(entries) = tree::entries_of(state, &root.blobs) else {
        return out;
    };
    for entry in entries {
        let refs = entry.refs(class);
        if !refs.is_empty() || (entry.size == 0 && class == Class::Originals) {
            out.insert(entry.h);
        }
    }
    out
}

/// R4: the gateways that hold the original `h` whole, from the device state alone: every chunk of
/// it listed in the tree the gateway's `oroot` names. A gateway a newer writer superseded is not
/// one this phone feeds, and not one that counts.
///
/// # Errors
/// The device state's refusal.
pub(crate) fn holders(
    state: &DeviceState,
    keys: &sealed::BackupKeys,
    h: &PlaintextHash,
) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for gateway in state.gateways().map_err(plane_error)? {
        if gateway.moved_epoch.is_none()
            && listed_hashes(state, keys, gateway.oroot, Class::Originals).contains(h)
        {
            out.push(gateway.gateway_id);
        }
    }
    Ok(out)
}

/// One paired gateway as a file is judged against it.
struct Replica {
    gateway: Gateway,
    originals: BTreeSet<PlaintextHash>,
    thumbnails: BTreeSet<PlaintextHash>,
    standing: engine::Standing,
    debt: engine::Debt,
    /// `conf` is the newest snapshot's root: records are backed up as of now.
    current: bool,
    behind_files: u64,
    behind_bytes: u64,
    held_bytes: u64,
}

impl Replica {
    fn holds(&self, file: &ContentFile) -> bool {
        if file.is_original() {
            self.originals.contains(&file.h)
        } else {
            self.thumbnails.contains(&file.h)
        }
    }

    fn classes(&self) -> Vec<wire::ClassStatus> {
        class_rows(
            self.current,
            self.current && self.standing.thumbnails,
            self.current && self.standing.originals,
            self.debt,
        )
    }
}

fn class_rows(
    records: bool,
    thumbnails: bool,
    originals: bool,
    debt: engine::Debt,
) -> Vec<wire::ClassStatus> {
    vec![
        wire::ClassStatus {
            class: wire::BackupClass::Records as i32,
            backed_up: records,
            owed: debt.records,
        },
        wire::ClassStatus {
            class: wire::BackupClass::Thumbnails as i32,
            backed_up: thumbnails,
            owed: debt.thumbnails,
        },
        wire::ClassStatus {
            class: wire::BackupClass::Originals as i32,
            backed_up: originals,
            owed: debt.originals,
        },
    ]
}

/// What the files say, in the shape the status needs.
#[derive(Default)]
struct Counted {
    total: u64,
    confirmed: u64,
    total_bytes: u64,
    confirmed_bytes: u64,
    pending_bytes: u64,
    left_out_items: u64,
    left_out_bytes: u64,
    waiting: BTreeMap<i32, u64>,
    oldest_waiting_ms: Option<i64>,
}

/// **What the shell draws on the backup screen** (`backup_status`).
///
/// # Errors
/// The device state's refusal, or a vault that will not read.
pub fn backup_status(
    plane: &Plane,
    vault: Option<&Vault>,
    keys: Option<&Keyring>,
) -> Result<wire::BackupStatusResponse> {
    let state = plane.state()?;
    let staging_bytes = plane.staging()?.used().map_err(plane_error)?;
    let gateways = state.gateways().map_err(plane_error)?;
    let conditions = Conditions::remembered(plane, plane.asking());
    let staging = plane.staging()?;
    let env = match (vault, keys) {
        (Some(vault), Some(keys)) => Some(Env::new(
            vault,
            &keys.backup,
            &state,
            &staging,
            Policy::WIFI,
            super::now_ms(),
        )),
        _ => None,
    };
    let newest = match &env {
        Some(env) => env.newest().map_err(plane_error)?,
        None => None,
    };
    let mut replicas: Vec<Replica> = Vec::new();
    for gateway in &gateways {
        let standing = engine::standing(&state, &gateway.gateway_id).map_err(plane_error)?;
        let debt = match &env {
            Some(env) => engine::debt(env, &gateway.gateway_id).map_err(plane_error)?,
            None => engine::Debt::default(),
        };
        let (originals, thumbnails) = match keys {
            Some(keys) => (
                listed_hashes(&state, &keys.backup, gateway.oroot, Class::Originals),
                listed_hashes(&state, &keys.backup, gateway.troot, Class::Thumbnails),
            ),
            None => (BTreeSet::new(), BTreeSet::new()),
        };
        replicas.push(Replica {
            current: gateway.conf.map(|(name, _)| name) == newest.as_ref().map(|root| root.name),
            gateway: gateway.clone(),
            originals,
            thumbnails,
            standing,
            debt,
            behind_files: 0,
            behind_bytes: 0,
            held_bytes: 0,
        });
    }
    // A GATEWAY A NEWER WRITER SUPERSEDED IS NOT FED, and so is not one a file waits for.
    let fed: Vec<usize> = replicas
        .iter()
        .enumerate()
        .filter(|(_, replica)| replica.gateway.moved_epoch.is_none())
        .map(|(index, _)| index)
        .collect();

    let mut counted = Counted::default();
    if let Some(vault) = vault
        && keys.is_some()
    {
        let earliest_pairing = gateways
            .iter()
            .filter(|gateway| gateway.moved_epoch.is_none())
            .map(|gateway| i64::try_from(gateway.paired_ms).unwrap_or(0))
            .min();
        for file in content_files(vault).map_err(plane_error)? {
            counted.total += 1;
            let leaves_out = file.is_original() && file.video && !conditions.counts(true);
            if leaves_out {
                counted.left_out_items += 1;
                counted.left_out_bytes = counted.left_out_bytes.saturating_add(file.len);
                continue;
            }
            counted.total_bytes = counted.total_bytes.saturating_add(file.len);
            let lagging: Vec<usize> = fed
                .iter()
                .copied()
                .filter(|index| !replicas[*index].holds(&file))
                .collect();
            for index in &fed {
                if replicas[*index].holds(&file) {
                    replicas[*index].held_bytes =
                        replicas[*index].held_bytes.saturating_add(file.len);
                }
            }
            if !fed.is_empty() && lagging.is_empty() {
                counted.confirmed += 1;
                counted.confirmed_bytes = counted.confirmed_bytes.saturating_add(file.len);
                continue;
            }
            counted.pending_bytes = counted.pending_bytes.saturating_add(file.len);
            if let Some(made) = centraid_vault::clock::parse_iso_ms(&file.created_at) {
                counted.oldest_waiting_ms =
                    Some(counted.oldest_waiting_ms.map_or(made, |old| old.min(made)));
            }
            for index in &lagging {
                replicas[*index].behind_files += 1;
                replicas[*index].behind_bytes =
                    replicas[*index].behind_bytes.saturating_add(file.len);
            }
            let reason = match lagging.first().map(|index| &replicas[*index]) {
                None => wire::WaitReason::Gateway,
                Some(replica) => {
                    waiting_reason(plane, &state, &conditions, replica, &file, newest.as_ref())?
                }
            };
            *counted.waiting.entry(reason as i32).or_default() += 1;
        }
        counted.oldest_waiting_ms = counted
            .oldest_waiting_ms
            .map(|made| made.max(earliest_pairing.unwrap_or(0)));
    }

    // THE OLDEST CONFIRMATION, not the newest: "backed up" says all are current (NB1).
    let acked_at_ms = fed
        .iter()
        .filter_map(|index| replicas[*index].gateway.conf.map(|(_, at)| at))
        .min()
        .filter(|_| {
            fed.iter()
                .all(|index| replicas[*index].gateway.conf.is_some())
        });
    let snapshot_ms = |gateway: &Gateway| -> Option<u64> {
        let (name, _) = gateway.conf?;
        let reference = node_ref(&state, &keys?.backup, &name)?;
        tree::root_of(&state, &reference)
            .ok()
            .map(|root| root.taken_at_ms)
    };
    let last_snapshot_ms = fed
        .iter()
        .map(|index| snapshot_ms(&replicas[*index].gateway))
        .collect::<Option<Vec<u64>>>()
        .and_then(|all| all.into_iter().min());
    let newest_taken = newest
        .as_ref()
        .and_then(|reference| tree::root_of(&state, reference).ok())
        .map(|root| root.taken_at_ms);

    let mut wired = Vec::with_capacity(replicas.len());
    for replica in &replicas {
        let gateway = &replica.gateway;
        let mut row = wire_destination(gateway);
        row.held_bytes = replica.held_bytes;
        row.behind_files = replica.behind_files;
        row.behind_bytes = replica.behind_bytes;
        let head_ms = snapshot_ms(gateway);
        row.head_snapshot_ms = head_ms.and_then(|at| i64::try_from(at).ok());
        row.records_behind = match (head_ms, newest_taken) {
            // A GATEWAY WHOSE HEAD NAMES NO SNAPSHOT is behind only when this phone has taken one:
            // with none taken there is nothing for it to be behind on.
            (None, newest) => newest.is_some(),
            (Some(held), Some(newest)) => held < newest,
            (Some(_), None) => false,
        };
        // A gateway whose head went backwards is found and mended by the engine's recovery pass
        // (§6.2 step 1); the status draws the repair as `Repairing` only while it runs.
        row.rolled_back = false;
        let notes = plane.notes(&gateway.gateway_id);
        row.held_count = notes.held_count;
        row.held_purge_at_ms = notes.held_purge_at_ms;
        row.held_undoable = notes.held_count;
        row.sample_checked = notes.sample_checked;
        row.sample_of = notes.sample_of;
        row.manifest_unreadable = notes.manifest_unreadable;
        row.reach_state = reach_state_of(gateway.reach, row.rolled_back) as i32;
        row.reach = wait_reason_of(gateway.reach).unwrap_or(wire::WaitReason::Unspecified) as i32;
        row.classes = replica.classes();
        wired.push(row);
    }
    let classes = aggregate(&replicas, &fed);
    Ok(wire::BackupStatusResponse {
        destinations: wired,
        acked_at_ms: acked_at_ms.and_then(|ms| i64::try_from(ms).ok()),
        last_snapshot_ms: last_snapshot_ms.and_then(|ms| i64::try_from(ms).ok()),
        pending_bytes: counted.pending_bytes,
        content_total: counted.total,
        content_confirmed: counted.confirmed,
        spool_bytes: staging_bytes,
        waiting: counted
            .waiting
            .iter()
            .map(|(reason, count)| wire::Waiting {
                reason: *reason,
                count: *count,
            })
            .collect(),
        frozen: moved(&state)?.is_some(),
        total_bytes: counted.total_bytes,
        confirmed_bytes: counted.confirmed_bytes,
        left_out_items: counted.left_out_items,
        left_out_bytes: counted.left_out_bytes,
        // THE PER-APP ROWS WENT WITH THE VAULT'S PER-APP COUNTS (#1209): the Backup screen's
        // "In this backup" is drawn from `classes` and the totals above until wave 4 redraws it.
        apps: Vec::new(),
        oldest_waiting_ms: counted.oldest_waiting_ms,
        first_item_ms: vault.and_then(first_item_ms),
        classes,
    })
}

/// Every class, least advanced gateway first: backed up only if every fed gateway has it, and
/// the most any of them is still owed.
fn aggregate(replicas: &[Replica], fed: &[usize]) -> Vec<wire::ClassStatus> {
    let mut rows = class_rows(
        !fed.is_empty(),
        !fed.is_empty(),
        !fed.is_empty(),
        engine::Debt::default(),
    );
    for index in fed {
        for (row, theirs) in rows.iter_mut().zip(replicas[*index].classes()) {
            row.backed_up &= theirs.backed_up;
            row.owed = row.owed.max(theirs.owed);
        }
    }
    rows
}

/// Why one unconfirmed file waits at `replica`, in the order the member can act on: what the
/// gateway last said, the phone's room, the member's rule, the bytes only the OS holds, then
/// nothing but time.
fn waiting_reason(
    plane: &Plane,
    state: &DeviceState,
    conditions: &Conditions,
    replica: &Replica,
    file: &ContentFile,
    newest: Option<&Ref>,
) -> Result<wire::WaitReason> {
    if let Some(reason) = wait_reason_of(replica.gateway.reach) {
        return Ok(reason);
    }
    if plane.no_room() {
        return Ok(wire::WaitReason::NoRoom);
    }
    let class = if file.is_original() {
        Class::Originals
    } else {
        Class::Thumbnails
    };
    if !conditions.admits(class, file.video) {
        return Ok(if conditions.rule == wire::TransferRule::Manual {
            wire::WaitReason::Ask
        } else {
            wire::WaitReason::Wifi
        });
    }
    if file.is_original()
        && state
            .local(&file.h)
            .map_err(plane_error)?
            .is_some_and(|local| local.source == LocalSource::Os)
    {
        // The bytes are the library's until they stream once and then, window by window, again.
        return Ok(wire::WaitReason::Bytes);
    }
    let _ = newest;
    Ok(wire::WaitReason::Window)
}
