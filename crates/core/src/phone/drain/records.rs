//! Snapshot capture, settle, retention, and read-back verification.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use centraid_media::sealed::ChunkDigest;
use centraid_vault::backup::files::ContentFile;
use centraid_vault::backup::mover::{self, Stop};
use centraid_vault::backup::naming::{BackupKeys, Name};
use centraid_vault::backup::retention;
use centraid_vault::backup::snapshot::{self, Manifest, RangeSealer, Settled};
use centraid_vault::backup::spool::Spool;
use centraid_vault::backup::state::{DeviceState, OutboxKind};
use centraid_vault::backup::store::{self as plane_store, Store, StoreError};
use centraid_vault::clock::SystemClock;
use centraid_vault::pagesource;

use super::policy::{Conditions, Kind};
use super::{APP, Flow, Pass, absorb, each};
use crate::error::{CoreError, Result};
use crate::handle::HandleState as Handle;
use crate::phone::link::{GatewayStore, Reached};
use crate::phone::{Keyring, Plane, now_ms, plane_error, row_backed_up, store_error};

/// Read back a keyed random sample of what `store` holds of the newest snapshot this phone set
/// there and open each part (E10): a part it no longer holds, or bytes that no longer open, are
/// deleted at the gateway (a damaged name is freed at once, decision 30) so the retaken snapshot
/// seals and sends them again, and the pass owes that snapshot.
pub(super) fn verify_sample(
    plane: &Plane,
    state: &DeviceState,
    store: &GatewayStore,
    keys: &BackupKeys,
    metered: bool,
    pass: &mut Pass,
) -> Result<()> {
    use centraid_vault::backup::verify::{SAMPLE_CHUNKS, SAMPLE_CHUNKS_METERED, sample};
    let id = store.gateway_id();
    note_held(plane, store)?;
    let Some(head) = state
        .gateway(id)
        .map_err(plane_error)?
        .and_then(|row| row.head)
    else {
        return Ok(());
    };
    // THE HEAD'S OWN MANIFEST NAMES THE RANGES: read and opened, a read of one small part.
    let manifest = match manifest_of(store, keys, &head) {
        Ok(manifest) => manifest,
        Err(error @ CoreError::Unavailable { .. }) => return Err(error),
        Err(error) => {
            tracing::warn!(%error, gateway = %id, "the head's manifest would not open");
            plane.set_snapshot_owed(true);
            plane.set_rolled(id, true);
            plane.note(id, |notes| notes.manifest_unreadable = true);
            pass.rolled.insert(id.to_owned());
            return Ok(());
        }
    };
    let pieces = centraid_vault::backup::verify::population(&manifest);
    let counter = state.next_sample_counter(id).map_err(plane_error)?;
    let found = sample(
        store,
        keys,
        &pieces,
        counter,
        if metered {
            SAMPLE_CHUNKS_METERED
        } else {
            SAMPLE_CHUNKS
        },
        metered,
    );
    pass.sampled = pass.sampled.saturating_add(found.checked);
    plane.note(id, |notes| {
        notes.sample_checked = u32::try_from(found.checked).unwrap_or(u32::MAX);
        notes.sample_of = u32::try_from(pieces.len()).unwrap_or(u32::MAX);
        notes.sample_unverified = 0;
        notes.manifest_unreadable = false;
    });
    if let Some(error) = found.unanswered {
        return Err(store_error(error));
    }
    if found.wrong.is_empty() {
        return Ok(());
    }
    // A CHUNK THAT WAS WRONG, THE GATEWAY NOT KNOWING IT (decision 34): ask it, by a signed
    // check, to hash that one object. At most the pass's sample size are asked. A name it finds
    // damaged is left for the mover (the one signed delete): its re-sent part meets `NAME_TAKEN`
    // (damaged) and the mover frees the name and sends it again; one it finds intact is
    // NOT deleted (the read-back and the gateway disagree: the part is counted unverified and
    // read again next pass); one it does not hold is found by the walk's `exists`.
    let mut confirmed_wrong = found.freeable.len();
    let mut unverified = 0_u32;
    // CHUNKS THE READ-BACK COULD NOT STAND BEHIND: wrong to it, intact to the gateway. They are
    // in `sample_of` and not in `sample_checked`, so the rate sentence never overstates.
    let mut unverified_chunks = 0_usize;
    for name in found
        .wrong
        .iter()
        .filter(|name| !found.freeable.contains(name))
        .take(SAMPLE_CHUNKS)
    {
        match store.check_name(name) {
            Ok(centraid_vault::backup::store::NameCheck::Damaged) => {
                confirmed_wrong += 1;
            }
            Ok(centraid_vault::backup::store::NameCheck::Intact) => {
                unverified += 1;
                unverified_chunks += found.wrong_chunks.get(name).copied().unwrap_or(1);
            }
            // GONE, OR A GATEWAY THAT CANNOT CHECK: the walk's `exists` finds a missing one.
            Ok(
                centraid_vault::backup::store::NameCheck::Missing
                | centraid_vault::backup::store::NameCheck::Unsupported,
            ) => confirmed_wrong += 1,
            // BUSY or a failed ask: the part is read again next pass.
            Err(error @ StoreError::Unreachable(_)) => return Err(store_error(error)),
            Err(_) => {
                unverified += 1;
                unverified_chunks += found.wrong_chunks.get(name).copied().unwrap_or(1);
            }
        }
    }
    pass.sampled = pass.sampled.saturating_sub(unverified_chunks);
    plane.note(id, |notes| {
        notes.sample_unverified = unverified;
        notes.sample_checked = notes
            .sample_checked
            .saturating_sub(u32::try_from(unverified_chunks).unwrap_or(u32::MAX));
    });
    if unverified > 0 {
        tracing::warn!(
            gateway = %id,
            unverified,
            "the read-back found chunks wrong that the gateway says are intact; nothing deleted"
        );
    }
    if confirmed_wrong == 0 {
        return Ok(());
    }
    tracing::warn!(
        gateway = %id,
        wrong = confirmed_wrong,
        "a gateway no longer holds what it acknowledged"
    );
    state.set_cursor(id, 0).map_err(plane_error)?;
    plane.set_snapshot_owed(true);
    // The head is retaken at once and, until a current one is set, the status says so.
    plane.set_rolled(id, true);
    pass.rolled.insert(id.to_owned());
    pass.repairing.insert(id.to_owned());
    Ok(())
}

/// Learn what deletes `store` is holding for this vault, for the status to show: how many, and
/// when the earliest goes for good. One listing of up to 200 names; a gateway that does not answer
/// leaves what was known.
fn note_held(plane: &Plane, store: &GatewayStore) -> Result<()> {
    match plane_store::Store::held(store, None, 200) {
        Ok(held) => {
            plane.note(store.gateway_id(), |notes| {
                notes.held_count = u32::try_from(held.len()).unwrap_or(u32::MAX);
                notes.held_purge_at_ms = held
                    .iter()
                    .map(|entry| entry.purge_after_ms)
                    .min()
                    .and_then(|at| i64::try_from(at).ok())
                    .unwrap_or(0);
            });
            Ok(())
        }
        // A GATEWAY THAT WILL NOT SAY leaves what was known: the status is not the pass.
        Err(error) => {
            tracing::debug!(%error, gateway = %store.gateway_id(), "the gateway did not list its holds");
            Ok(())
        }
    }
}

/// What the records' half of a pass needs, so the pass can run it twice: when
/// it begins, and when it has confirmed files whose rows nothing covers.
pub(super) struct Round<'a> {
    pub(super) handle: &'a Handle,
    pub(super) keyring: &'a Keyring,
    pub(super) plane: &'a Plane,
    pub(super) state: &'a DeviceState,
    pub(super) spool: &'a Spool,
    pub(super) deadline: Instant,
}

impl Round<'_> {
    /// Take a snapshot when `take` (planned against every gateway still in the pass), move the
    /// records' parts to each, and move each head once every part of the newest snapshot is
    /// confirmed there. Answers whether the pass stopped at its deadline.
    pub(super) fn records(
        &self,
        take: bool,
        live: &mut Vec<&Reached>,
        budget: u64,
        pass: &mut Pass,
    ) -> Result<bool> {
        if take {
            let stores: Vec<&GatewayStore> = live.iter().map(|reached| &reached.store).collect();
            let failures = match take_snapshot(
                self.handle,
                self.keyring,
                self.state,
                self.spool,
                &stores,
                budget,
                &mut pass.abandoned,
            )? {
                // NOT ENOUGH ROOM TO SPOOL THE SNAPSHOT: it stays owed, the status says why
                // (`WAIT_REASON_NO_ROOM`), and the rest of the pass runs.
                Taken::NoRoom => {
                    self.plane.set_no_room(true);
                    self.plane.set_snapshot_owed(true);
                    Vec::new()
                }
                Taken::Done(failures) => {
                    self.plane.set_no_room(false);
                    if failures.len() < stores.len() {
                        self.plane.set_snapshot_owed(false);
                    }
                    failures
                }
            };
            for (id, error) in failures {
                if let Some(at) = live
                    .iter()
                    .position(|reached| reached.gateway.gateway_id == id)
                {
                    let gateway = live.remove(at);
                    absorb(self.state, pass, gateway, error)?;
                }
            }
        }
        let mut stopped = false;
        let now = self
            .handle
            .with_vault(|vault| Ok(u64::try_from(vault.clock().now_ms()).unwrap_or(0)))?;
        each(live, self.state, pass, |reached, pass| {
            let store = &reached.store;
            let moved = mover::move_queue_where(
                self.state,
                self.spool,
                store,
                self.deadline,
                &SystemClock,
                &|part| part.handed_ms.is_none() && Kind::of_part(part) == Kind::Records,
            )
            .map_err(plane_error)?;
            pass.count(moved.confirmed.len());
            if pass.stopped_by(&moved.stopped)? {
                stopped |= matches!(moved.stopped, Stop::Deadline);
                return Ok(Flow::Stop);
            }
            // RETENTION IS JUDGED ON THE VAULT'S OWN CLOCK, the one every snapshot's
            // `taken_at_ms` is dated by.
            settle_newest(
                self.handle,
                self.plane,
                self.state,
                store,
                self.keyring,
                now,
                pass,
            )?;
            Ok(Flow::Continue)
        })?;
        Ok(stopped)
    }
}

/// **A FILE THE MEMBER BACKS UP, WHOSE BYTES `gateway_id` HOLDS AND WHOSE ROW NO SNAPSHOT THIS
/// PHONE TOOK COVERS** (R-1080-C15): the file the status would read as waiting for the next
/// snapshot. "Covers" counts the snapshot spooled for the gateway — one still on its way
/// included, since it is already in flight — by the vault's own clock, as [`row_backed_up`] does.
pub(super) fn rows_uncovered(
    handle: &Handle,
    state: &DeviceState,
    gateway_id: &str,
    conditions: &Conditions,
    files: &[ContentFile],
) -> Result<bool> {
    let Some(gateway) = state.gateway(gateway_id).map_err(plane_error)? else {
        return Ok(false);
    };
    let behind = handle.with_vault(|vault| crate::phone::behind_hashes(state, vault, &gateway))?;
    let covered_at = gateway.snapshot_ms;
    Ok(files.iter().any(|file| {
        conditions.counts(Kind::of_file(file))
            && !behind.contains(&file.h)
            && !row_backed_up(file, covered_at)
    }))
}

/// The names the newest snapshot gave each range, as far as every gateway of the pass still holds
/// them: what the walk may leave unsealed. Nothing known (no head, a manifest that will not open,
/// a gateway that will not answer) is an empty answer, and then every range is sealed.
fn known_ranges(
    state: &DeviceState,
    keyring: &Keyring,
    stores: &[&GatewayStore],
) -> Vec<Option<(Name, Vec<ChunkDigest>)>> {
    let mut newest: Option<(u64, &GatewayStore, Name)> = None;
    for store in stores {
        let Ok(Some(row)) = state.gateway(store.gateway_id()) else {
            continue;
        };
        let Some(head) = row.head else { continue };
        let at = row.head_ms.unwrap_or(0);
        if newest.is_none_or(|(held, ..)| at > held) {
            newest = Some((at, store, head));
        }
    }
    let Some((_, source, head)) = newest else {
        return Vec::new();
    };
    let Ok(manifest) = manifest_of(source, &keyring.backup, &head) else {
        return Vec::new();
    };
    let names: Vec<Name> = manifest.range_names().into_iter().collect();
    let mut gone = BTreeSet::new();
    for store in stores {
        match centraid_vault::backup::store::missing(*store, &names) {
            Ok(missing) => gone.extend(missing),
            Err(_) => return Vec::new(),
        }
    }
    manifest
        .ranges
        .iter()
        .map(|range| (!gone.contains(&range.name)).then(|| (range.name, range.d.clone())))
        .collect()
}

/// The directory of every gateway this phone is paired with: ids, addresses, certificate pins and
/// labels, never a token (E8).
fn directory_of(state: &DeviceState) -> Result<centraid_vault::backup::directory::Directory> {
    use centraid_vault::backup::directory::{Directory, Entry};
    let entries = state
        .gateways()
        .map_err(plane_error)?
        .into_iter()
        .take(centraid_vault::backup::directory::MAX_GATEWAYS)
        .map(|gateway| Entry {
            pin: centraid_gateway::rules::ids::Pin::of(&gateway.cert_der).to_string(),
            gateway_id: gateway.gateway_id,
            addrs: gateway.addrs,
            label: gateway.label,
        })
        .collect();
    Directory::new(entries).map_err(plane_error)
}

/// Read the vault under one pin, sealing the ranges the newest snapshot did not name into the
/// spool as they are read; ask every gateway what it holds of those; and owe each what it lacks:
/// a part is sealed once and owed to each gateway that lacks it. **No copy of the vault is
/// written** and the writer is not held: the pin lives inside [`snapshot::capture_at`] and ends
/// before a gateway is asked anything. What the new snapshot supersedes, and no other snapshot
/// needs, leaves the outbox.
///
/// Answers the gateways whose own questions failed (by id), which the caller takes out of the
/// pass; the snapshot is spooled for the rest.
fn take_snapshot(
    handle: &Handle,
    keyring: &Keyring,
    state: &DeviceState,
    spool: &Spool,
    stores: &[&GatewayStore],
    budget: u64,
    abandoned: &mut BTreeMap<String, Name>,
) -> Result<Taken> {
    // WHAT THE LAST SNAPSHOT NAMED comes from the gateways, before the pin: a pin never spans a
    // gateway call.
    let known = known_ranges(state, keyring, stores);
    let (path, taken_at_ms) = handle.with_vault(|vault| {
        Ok((
            vault.path().to_path_buf(),
            u64::try_from(vault.clock().now_ms()).unwrap_or(0),
        ))
    })?;
    let sealer = RangeSealer::new(spool, &keyring.backup, budget)
        .map_err(plane_error)?
        .with_part_digests(state.part_digests().map_err(plane_error)?);
    // THE SEALED DIRECTORY OF THE MEMBER'S GATEWAYS (E8) rides in every snapshot: its name is
    // a function of its content, so an unchanged set is one `exists` and nothing sent.
    let directory = directory_of(state)?;
    let mut sealer = sealer.with_directory(&directory).map_err(plane_error)?;
    debug_assert_eq!(pagesource::live_pins(), 0);
    let taken = snapshot::capture_at(
        &path,
        taken_at_ms,
        &keyring.backup,
        &keyring.vault_hex(),
        APP,
        &|i| {
            known
                .get(usize::try_from(i).unwrap_or(usize::MAX))
                .cloned()
                .flatten()
        },
        &mut sealer,
    )
    .map_err(plane_error)?;
    debug_assert_eq!(pagesource::live_pins(), 0, "no pin outlives the walk");
    handle.note_walk(taken.sealed.names.len() as u64);

    let mut plans: Vec<(String, snapshot::Plan)> = Vec::with_capacity(stores.len());
    let mut failures = Vec::new();
    for store in stores {
        match snapshot::plan(&taken, *store) {
            Ok(planned) => plans.push((store.gateway_id().to_owned(), planned)),
            Err(error) => failures.push((store.gateway_id().to_owned(), store_error_of(error))),
        }
    }
    if plans.is_empty() {
        // NOBODY TO OWE: what the walk sealed has no row and goes with the next sweep.
        return Ok(Taken::Done(failures));
    }
    // A SNAPSHOT SPOOLED FOR A GATEWAY AND NEVER ITS HEAD is superseded by this one.
    for (gateway, _) in &plans {
        if let Some(row) = state.gateway(gateway).map_err(plane_error)?
            && let Some(previous) = row.snapshot
            && row.head != Some(previous)
            && previous != taken.manifest_name
        {
            abandoned.insert(gateway.clone(), previous);
        }
    }
    let spooled = snapshot::spool(
        &taken,
        &plans,
        spool,
        state,
        &keyring.backup,
        budget,
        now_ms(),
    )
    .map_err(plane_error)?;
    // WHAT THE NEWER SNAPSHOT SUPERSEDES IS NOT SENT: a gateway still behind is brought to
    // the new snapshot, never walked through the old ones.
    let mut keep = taken.manifest.part_names();
    keep.insert(taken.manifest_name);
    for (gateway, _) in &plans {
        let stale: Vec<Name> = state
            .outbox(gateway)
            .map_err(plane_error)?
            .into_iter()
            .filter(|row| {
                matches!(
                    row.kind,
                    OutboxKind::Range | OutboxKind::Leaf | OutboxKind::Manifest
                ) && !keep.contains(&row.name)
            })
            .map(|row| row.name)
            .collect();
        mover::release_many(state, spool, gateway, &stale, false).map_err(plane_error)?;
    }
    // THE SPOOL COULD NOT TAKE THE WHOLE SNAPSHOT because the phone's free space, and not the
    // spool's own ceiling, set its budget: the snapshot stays owed and the status says why.
    if !spooled.deferred.is_empty() && handle.plane().room_limited() {
        return Ok(Taken::NoRoom);
    }
    Ok(Taken::Done(failures))
}

/// What a pass found when it came to take a snapshot.
enum Taken {
    /// Taken and spooled; the gateways whose own questions failed, by id.
    Done(Vec<(String, CoreError)>),
    /// This phone has too little free space to spool its snapshot.
    NoRoom,
}

/// Whether the vault shows what the newest snapshot was taken from and every gateway in the pass
/// holds that snapshot whole under its head: nothing a copy could add.
pub(super) fn newest_stands(
    handle: &Handle,
    state: &DeviceState,
    live: &[&Reached],
    rolled: &BTreeSet<String>,
) -> Result<Option<u64>> {
    let mut oldest: Option<u64> = None;
    let mut writes: Option<u64> = None;
    for reached in live {
        let id = reached.store.gateway_id();
        let Some(gateway) = state.gateway(id).map_err(plane_error)? else {
            return Ok(None);
        };
        // A GATEWAY THIS PHONE HAS SET NO HEAD AT (a restored phone's first pass) is owed one,
        // and so is one whose head went backwards or whose parts are still owed.
        let whole = gateway.head.is_some()
            && gateway.head == gateway.snapshot
            && !rolled.contains(id)
            && state.outbox(id).map_err(plane_error)?.is_empty();
        if !whole || writes.is_some_and(|held| held != gateway.writes) {
            return Ok(None);
        }
        writes = Some(gateway.writes);
        // THE GATEWAY'S OWN TIME for the head it already holds: what a pass that copied nothing answers.
        oldest = match (oldest, gateway.ack_ms) {
            (Some(held), Some(at)) => Some(held.min(at)),
            (held, at) => held.or(at),
        };
    }
    let Some(writes) = writes else {
        return Ok(None);
    };
    let same =
        handle.with_vault(|vault| snapshot::unchanged_since(vault, writes).map_err(plane_error))?;
    Ok(if same { oldest } else { None })
}

/// A plane error from one gateway's question, as the pass's error for that gateway.
fn store_error_of(error: centraid_vault::backup::PlaneError) -> CoreError {
    match error {
        centraid_vault::backup::PlaneError::Store(error) => store_error(error),
        other => plane_error(other),
    }
}

/// Move the head to the newest snapshot spooled for `store` once nothing of it is owed there;
/// and when it moves, let retention drop what it no longer keeps.
fn settle_newest(
    handle: &Handle,
    plane: &Plane,
    state: &DeviceState,
    store: &GatewayStore,
    keyring: &Keyring,
    now: u64,
    pass: &mut Pass,
) -> Result<()> {
    match snapshot::settle(state, store, &SystemClock).map_err(plane_error)? {
        Settled::HeadSet(head) => {
            plane.set_rolled(store.gateway_id(), false);
            pass.acked_at_ms = i64::try_from(head.set_at_ms).ok();
            // AN ABANDONED SNAPSHOT'S PARTS ARE GARBAGE LIKE ANY OTHER: the union names no more.
            pass.abandoned.remove(store.gateway_id());
            retain(handle, state, store, &keyring.backup, now)?;
        }
        Settled::Nothing => {}
        Settled::Waiting { unconfirmed } => {
            tracing::debug!(
                waiting = unconfirmed.len(),
                "the snapshot waits on parts not yet acknowledged"
            );
        }
        Settled::Conflict { current } => {
            tracing::warn!(
                ?current,
                "the gateway's head is not where this phone left it; the head did not move"
            );
        }
    }
    Ok(())
}

/// A kept snapshot's manifest, fetched from the gateway and opened.
fn manifest_of(store: &GatewayStore, keys: &BackupKeys, name: &Name) -> Result<Manifest> {
    snapshot::read_manifest(store, keys, name).map_err(|error| match error {
        centraid_vault::backup::PlaneError::Store(error) => store_error(error),
        other => CoreError::Invariant {
            context: format!("a kept snapshot's manifest would not open: {other}"),
        },
    })
}

/// **Retention and the exact collection** (#1080 "Retention", #1191 B10): keep 7 daily, 4 weekly
/// and 6 monthly snapshots, then delete from the gateway everything it holds that nothing needs.
///
/// **What something needs** is the union of: every kept snapshot's root, its leaves, its ranges
/// and the parts of every blob its rows name (its blobs tree); the parts of every blob the vault
/// claims now (`content_names`); what any outbox row owes; what a member's Undo lifted; and what
/// a snapshot spooled and not yet set names. The gateway is **listed first**, then the union is
/// worked out, so a part that lands after the listing is never judged. Anything listed and not
/// in the union is deleted by signed delete: the gateway holds a live name for its week (E6) and
/// frees a damaged one at once (decision 30).
///
/// **DOUBT NEVER DELETES.** A kept snapshot whose manifest will not open, or a snapshot in
/// flight that names a part this gateway holds and cannot be read, stops the collection for the
/// round: nothing is deleted on a guess.
fn retain(
    handle: &Handle,
    state: &DeviceState,
    store: &GatewayStore,
    keys: &BackupKeys,
    now: u64,
) -> Result<()> {
    let listed: Vec<Name> = plane_store::list_all(store)
        .map_err(store_error)?
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    let registered = store.snapshots().map_err(store_error)?;
    let mut decided = retention::keep(&registered, now);
    // WHAT A MEMBER'S UNDO LIFTED IS NOT DELETED AGAIN AT ONCE (E6): such a snapshot is kept
    // until its time is up, and so is every part of it.
    let undone = state
        .undone(store.gateway_id(), now_ms())
        .map_err(plane_error)?;
    let (restored, dropped): (Vec<Name>, Vec<Name>) = decided
        .drop
        .iter()
        .copied()
        .partition(|name| undone.contains(name));
    decided.drop = dropped;
    decided.keep.extend(restored);
    let mut live: BTreeSet<Name> = state.owed_names().map_err(plane_error)?;
    live.extend(undone.iter().copied());
    for name in &decided.keep {
        live.insert(*name);
        match manifest_of(store, keys, name) {
            Ok(manifest) => {
                live.extend(manifest.part_names());
            }
            Err(error @ CoreError::Unavailable { .. }) => return Err(error),
            Err(error) => {
                tracing::warn!(
                    %error,
                    "a kept snapshot's manifest would not open; nothing is collected"
                );
                return Ok(());
            }
        }
    }
    // A SNAPSHOT SPOOLED FOR ANY GATEWAY AND NOT YET SET IS ON ITS WAY: its names are not garbage.
    for gateway in state.gateways().map_err(plane_error)? {
        let Some(name) = gateway.snapshot else {
            continue;
        };
        if live.contains(&name) {
            continue;
        }
        live.insert(name);
        match manifest_of(store, keys, &name) {
            Ok(manifest) => live.extend(manifest.part_names()),
            Err(error @ CoreError::Unavailable { .. }) => return Err(error),
            // NOT HERE (never put on this gateway) or not a manifest: its parts that are here
            // are owed by an outbox row or are an abandoned attempt's.
            Err(_) => {}
        }
    }
    let claimed = handle.with_vault(|vault| {
        centraid_vault::backup::naming::content_names(keys, vault).map_err(plane_error)
    })?;
    live.extend(claimed);
    let doomed = retention::garbage(listed, &live);
    let deleted = plane_store::delete_all(store, &doomed).map_err(store_error)?;
    state.forget_digests_except(&live).map_err(plane_error)?;
    tracing::info!(
        dropped = decided.drop.len(),
        collected = deleted.deleted.len(),
        "retention dropped snapshots and collected what nothing needs"
    );
    Ok(())
}
