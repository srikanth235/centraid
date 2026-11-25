//! FILES BACK FROM A GATEWAY, BY REF (#1080 ruling 4, [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! **The newest tree is the whole index.** A file's chunks are listed in the tree this phone last
//! snapshotted or restored (`centraid_vault::backup::tree`), each a ref (name, digest, length,
//! class), so a phone asks for a file by walking refs: no listing, no custody row. Every chunk
//! opens under `K_backup` against its own ref and the whole is checked against the file's hash
//! before it lands in the app's own store: a gateway that substituted, truncated or reordered
//! anything is refused, never stored.
//!
//! Two callers: `fetch_original`, one original a member tapped, a chunk at a time into a file;
//! and a restore, whose originals phase (R3) brings every original back newest first, a pass
//! at a time ([`bring_originals`]).

use std::collections::BTreeMap;
use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use centraid_blobs::{ByteStore, ContentHash};
use centraid_media::sealed::{self, BackupKeys, Class, Name, PlaintextHash, Ref};
use centraid_vault::backup::files::content_files;
use centraid_vault::backup::state::{DeviceState, LocalSource};
use centraid_vault::backup::store::{
    BUNDLE_BYTES, FRAME_HEADER_BYTES, NAMES_PER_CALL, Store, StoreError,
};
use centraid_vault::backup::tree;

use super::link::GatewayStore;
use super::{Keyring, hash_of, plane_error, status, store_error};
use crate::error::{CoreError, Result};
use crate::handle::HandleState as Handle;

/// What assembling one file came to.
pub(crate) enum Assembled {
    /// Checked against its hash and stored; the file it is in.
    Landed(PathBuf),
    /// The gateway answered and does not hold every chunk.
    Missing,
    /// The gateway did not answer.
    Unreachable,
    /// The machine that answered is not the pinned gateway; nothing was
    /// taken from it.
    Untrusted,
    /// The copy on the gateway did not open: bytes off their digest, a chunk
    /// that does not open under the vault's key, or chunks that are not the
    /// file they are listed for. Nothing landed.
    Damaged,
}

/// Fetch the chunks `refs` of the file `h` from `store` one at a time, open each against its ref,
/// check the whole against `h`, and keep it in `bytes`. At most one chunk is in memory; a refused
/// file leaves nothing in the store.
pub(crate) fn assemble_into(
    store: &dyn Store,
    keys: &BackupKeys,
    h: &PlaintextHash,
    refs: &[Ref],
    bytes: &ByteStore,
) -> Result<Assembled> {
    let mut writer = bytes.writer().map_err(|error| CoreError::Invariant {
        context: format!("the content store would not take a fetched file: {error}"),
    })?;
    for reference in refs {
        let mut object = Vec::new();
        match store.get(&reference.name, &mut object) {
            Ok(_) => {}
            Err(StoreError::Missing(_)) => return Ok(Assembled::Missing),
            Err(StoreError::Unreachable(reason)) => {
                tracing::debug!(%reason, "the gateway stopped answering mid-fetch");
                return Ok(Assembled::Unreachable);
            }
            Err(StoreError::Untrusted(reason)) => {
                tracing::warn!(%reason, "a fetch reached a machine that is not the pinned gateway");
                return Ok(Assembled::Untrusted);
            }
            Err(StoreError::Damaged(reason)) => {
                tracing::warn!(%reason, "a fetched chunk is off its digest");
                return Ok(Assembled::Damaged);
            }
            Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(store_error(StoreError::Io(error)));
            }
            Err(error) => {
                tracing::debug!(%error, "the gateway refused a fetch");
                return Ok(Assembled::Unreachable);
            }
        }
        match sealed::open(keys, reference, &object) {
            Ok(plain) => {
                writer.write(&plain).map_err(|error| CoreError::Invariant {
                    context: format!("the content store would not take a fetched chunk: {error}"),
                })?;
            }
            Err(error) => {
                tracing::warn!(%error, "a chunk of {h} the gateway answered would not open");
                return Ok(Assembled::Damaged);
            }
        }
    }
    let stored = writer.finish().map_err(|error| CoreError::Invariant {
        context: format!("the content store would not keep {h}: {error}"),
    })?;
    if stored.hash.as_bytes() != h.as_bytes() {
        // The store keeps what hashed; take back a file that is not the one named.
        tracing::warn!("the chunks listed for {h} are not the file it names");
        let _ = bytes.remove(stored.hash);
        return Ok(Assembled::Damaged);
    }
    Ok(Assembled::Landed(stored.path))
}

/// The refs of the original `h` in the newest tree this phone holds (in `O(depth)`), falling
/// back to `state.blob_chunks(h, Class::Originals)` when the newest tree does not list it yet.
pub(crate) fn refs_of_original(
    state: &DeviceState,
    keys: &BackupKeys,
    h: &PlaintextHash,
) -> Result<Vec<Ref>> {
    if let Some((name, _)) = state.device().map_err(plane_error)?.newest
        && let Some(reference) = status::node_ref(state, keys, &name)
    {
        let root = tree::root_of(state, &reference).map_err(plane_error)?;
        if let Some(entry) = tree::lookup_entry(state, &root.blobs, h).map_err(plane_error)?
            && entry.kind == tree::EntryKind::Original
            && !entry.original.is_empty()
        {
            return Ok(entry.original);
        }
    }
    state.blob_chunks(h, Class::Originals).map_err(plane_error)
}

/// **Bring one original back** (`fetch_original`).
///
/// Already on this phone — in the app's store, or in the operating system's
/// library, which the shell opens itself — is answered without dialling. Else
/// each paired gateway is asked in the ledger's order, a superseded one
/// included: its reads still answer. A file that lands is announced through
/// the ordinary change event, so a lightbox waiting on it redraws.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a hash that is not 32 bytes or that the
/// vault does not name; [`CoreError::Unavailable`] for a core with no content
/// store. A copy that did not open is `FETCH_OUTCOME_DAMAGED`, an answer and
/// not an error, and lands nothing.
pub fn fetch_original(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::FetchOriginalRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::FetchOriginalResponse> {
    fetch_original_cancellable(handle, keyring, request, runtime, None)
}

pub(crate) fn fetch_original_cancellable(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::FetchOriginalRequest,
    runtime: &tokio::runtime::Handle,
    cancellation: Option<crate::handle::Cancellation>,
) -> Result<wire::FetchOriginalResponse> {
    if let Some(stop) = &cancellation {
        stop.check()?;
    }
    let h = hash_of(&request.content_hash)?;
    let Some(door) = handle.bytes() else {
        return Err(CoreError::Unavailable {
            reason: "this core has no content store, so it cannot keep a fetched original"
                .to_owned(),
        });
    };
    let bytes = door.store();
    let answer = |outcome: wire::FetchOutcome, path: Option<PathBuf>| wire::FetchOriginalResponse {
        outcome: outcome as i32,
        path: path
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    if let Some(path) = bytes
        .path_of(ContentHash::from_bytes(*h.as_bytes()))
        .map_err(|error| CoreError::Invariant {
            context: format!("the content store: {error}"),
        })?
    {
        return Ok(answer(wire::FetchOutcome::AlreadyHeld, Some(path)));
    }
    let ledger = handle.plane().state()?;
    if ledger
        .local(&h)
        .map_err(plane_error)?
        .is_some_and(|local| local.source == LocalSource::Os)
    {
        return Ok(answer(wire::FetchOutcome::AlreadyHeld, None));
    }
    let file = handle
        .with_vault(|vault| content_files(vault).map_err(plane_error))?
        .into_iter()
        .find(|file| file.h == h)
        .ok_or_else(|| CoreError::InvalidRequest {
            detail: "this vault names no content with that hash".to_owned(),
        })?;
    // THE TREE THIS PHONE HOLDS LISTS THE CHUNKS: a file the newest tree does not list as bytes
    // (claimed since, or never readable) is not in any backup yet.
    let refs = refs_of_original(&ledger, &keyring.backup, &h)?;
    if refs.is_empty() && file.len > 0 {
        return Ok(answer(wire::FetchOutcome::NotInBackup, None));
    }
    // WHEN NONE LANDS, the gateway that said the most is answered: a copy that
    // would not open, then one that does not hold it, then a machine that is
    // not the pinned gateway, then silence.
    let mut outcome = wire::FetchOutcome::Unreachable;
    let rank = |outcome: wire::FetchOutcome| match outcome {
        wire::FetchOutcome::Damaged => 3,
        wire::FetchOutcome::NotInBackup => 2,
        wire::FetchOutcome::Untrusted => 1,
        _ => 0,
    };
    let tokens = handle.plane().tokens();
    for destination in ledger.gateways().map_err(plane_error)? {
        // A GATEWAY THE SHELL HOLDS NO TOKEN FOR is one to pair again, not one to ask.
        let Some(token) = tokens.get(&destination.gateway_id) else {
            continue;
        };
        let mut store = GatewayStore::for_gateway(
            &destination,
            *token,
            keyring.vault.identity.signing(),
            runtime,
        )?;
        store.set_cancellation(cancellation.clone());
        let assembled = assemble_into(&store, &keyring.backup, &h, &refs, bytes);
        if assembled.is_err() {
            store.checkpoint()?;
        }
        let heard = match assembled? {
            Assembled::Landed(path) => {
                let assets = handle.with_vault(|vault| {
                    centraid_vault::originals::assets_for_hashes(vault, &[h.to_hex()])
                        .map_err(CoreError::from)
                })?;
                crate::events::ChangeFeed::new(handle.events()).blobs_arrived(&assets);
                return Ok(answer(wire::FetchOutcome::Landed, Some(path)));
            }
            Assembled::Missing => wire::FetchOutcome::NotInBackup,
            Assembled::Untrusted => wire::FetchOutcome::Untrusted,
            Assembled::Damaged => wire::FetchOutcome::Damaged,
            Assembled::Unreachable => wire::FetchOutcome::Unreachable,
        };
        if rank(heard) > rank(outcome) {
            outcome = heard;
        }
    }
    Ok(answer(outcome, None))
}

fn have_local(state: &DeviceState, bytes: &ByteStore, h: &PlaintextHash) -> Result<bool> {
    let in_store = bytes
        .path_of(ContentHash::from_bytes(*h.as_bytes()))
        .map_err(|error| CoreError::Invariant {
            context: format!("the content store: {error}"),
        })?
        .is_some();
    if in_store {
        return Ok(true);
    }
    Ok(state
        .local(h)
        .map_err(plane_error)?
        .is_some_and(|local| local.source == LocalSource::Os))
}

fn store_plain(bytes: &ByteStore, h: &PlaintextHash, plain: &[u8]) -> Result<bool> {
    let mut writer = bytes.writer().map_err(|error| CoreError::Invariant {
        context: format!("the content store would not take a fetched file: {error}"),
    })?;
    writer.write(plain).map_err(|error| CoreError::Invariant {
        context: format!("the content store would not take a fetched chunk: {error}"),
    })?;
    let stored = writer.finish().map_err(|error| CoreError::Invariant {
        context: format!("the content store would not keep {h}: {error}"),
    })?;
    if stored.hash.as_bytes() != h.as_bytes() {
        tracing::warn!("the chunks listed for {h} are not the file it names");
        let _ = bytes.remove(stored.hash);
        return Ok(false);
    }
    Ok(true)
}

/// Fetch one batch of single-chunk thumbnails via `POST fetch` (`Store::get_many`).
/// Returns `Ok(true)` if the store stayed healthy, `Ok(false)` if it became unreachable/refused.
fn fetch_thumb_batch(
    store: &dyn Store,
    keys: &BackupKeys,
    bytes: &ByteStore,
    batch: &[(usize, &tree::Entry)],
    landed: &mut [bool],
    cancellation: &Option<crate::handle::Cancellation>,
) -> Result<bool> {
    if batch.is_empty() {
        return Ok(true);
    }
    let mut names = Vec::with_capacity(batch.len());
    let mut by_name: BTreeMap<Name, Vec<usize>> = BTreeMap::new();
    for (pos, (_, entry)) in batch.iter().enumerate() {
        let name = entry.thumbnail[0].name;
        let slots = by_name.entry(name).or_default();
        if slots.is_empty() {
            names.push(name);
        }
        slots.push(pos);
    }
    let mut store_err: Option<CoreError> = None;
    let outcome = store.get_many(&names, &mut |name, object| {
        if let Some(positions) = by_name.get(name) {
            for &pos in positions {
                let (idx, entry) = batch[pos];
                if landed[idx] {
                    continue;
                }
                let Ok(plain) = sealed::open(keys, &entry.thumbnail[0], object) else {
                    tracing::warn!(h = %entry.h, "a thumbnail chunk would not open");
                    continue;
                };
                if PlaintextHash::of(&plain) != entry.h {
                    tracing::warn!(h = %entry.h, "a thumbnail did not hash to its entry");
                    continue;
                }
                match store_plain(bytes, &entry.h, &plain) {
                    Ok(true) => landed[idx] = true,
                    Ok(false) => {}
                    Err(error) => {
                        store_err = Some(error);
                        return Err(std::io::Error::other("content store write failed"));
                    }
                }
            }
        }
        Ok(())
    });
    if let Some(error) = store_err {
        return Err(error);
    }
    if let Some(stop) = cancellation {
        stop.check()?;
    }
    match outcome {
        Ok(_) | Err(StoreError::Missing(_)) => Ok(true),
        Err(StoreError::Damaged(_)) => {
            // A frame in the bundle was damaged on the wire, which stopped the stream; fall back
            // to individual fetches for the remaining items in this batch so one damaged thumbnail
            // never costs the rest of the batch.
            for &(idx, entry) in batch {
                if landed[idx] {
                    continue;
                }
                if let Some(stop) = cancellation {
                    stop.check()?;
                }
                match assemble_into(store, keys, &entry.h, &entry.thumbnail, bytes) {
                    Ok(Assembled::Landed(_)) => landed[idx] = true,
                    Ok(Assembled::Unreachable | Assembled::Untrusted) => return Ok(false),
                    Ok(Assembled::Missing | Assembled::Damaged) => {}
                    Err(error) => {
                        if let Some(stop) = cancellation {
                            stop.check()?;
                        }
                        tracing::debug!(%error, "thumbnail fallback fetch failed");
                        return Ok(false);
                    }
                }
            }
            Ok(true)
        }
        Err(error) => {
            tracing::debug!(%error, "the gateway stopped answering during thumbnail fetch");
            Ok(false)
        }
    }
}

/// R3, phase 2: fetch every missing thumbnail in `entries` (newest first) in `get_many` batches
/// before any originals are fetched. Returns `(landed, still_missing)`.
#[allow(clippy::too_many_arguments)]
fn bring_thumbnails(
    entries: &[tree::Entry],
    state: &DeviceState,
    bytes: &ByteStore,
    keys: &BackupKeys,
    stores: &[GatewayStore],
    dead: &mut [bool],
    paired_count: usize,
    cancellation: &Option<crate::handle::Cancellation>,
    out_of_time: &dyn Fn() -> bool,
) -> Result<(usize, usize)> {
    let mut needed: Vec<&tree::Entry> = Vec::new();
    for entry in entries {
        if entry.kind != tree::EntryKind::Thumbnail
            || entry.thumbnail.is_empty()
            || have_local(state, bytes, &entry.h)?
        {
            continue;
        }
        needed.push(entry);
    }
    if needed.is_empty() {
        return Ok((0, 0));
    }
    let mut thumb_landed = vec![false; needed.len()];
    let mut timed_out = false;

    for (store_idx, store) in stores.iter().enumerate() {
        if dead[store_idx] {
            continue;
        }
        if thumb_landed.iter().all(|&done| done) {
            break;
        }
        let mut batch: Vec<(usize, &tree::Entry)> = Vec::new();
        let mut batch_bytes = 0_u64;
        for (idx, entry) in needed.iter().copied().enumerate() {
            if thumb_landed[idx] {
                continue;
            }
            if out_of_time() {
                timed_out = true;
                break;
            }
            let single_cost = if entry.thumbnail.len() == 1 {
                u64::from(entry.thumbnail[0].len).saturating_add(FRAME_HEADER_BYTES)
            } else {
                u64::MAX
            };
            if entry.thumbnail.len() == 1 && single_cost <= BUNDLE_BYTES {
                if !batch.is_empty()
                    && (batch.len() >= NAMES_PER_CALL
                        || batch_bytes.saturating_add(single_cost) > BUNDLE_BYTES)
                {
                    if !fetch_thumb_batch(
                        store,
                        keys,
                        bytes,
                        &batch,
                        &mut thumb_landed,
                        cancellation,
                    )? {
                        dead[store_idx] = true;
                        break;
                    }
                    batch.clear();
                    batch_bytes = 0;
                    if out_of_time() {
                        timed_out = true;
                        break;
                    }
                }
                batch.push((idx, entry));
                batch_bytes = batch_bytes.saturating_add(single_cost);
            } else {
                // Flush any pending single-chunk batch first to preserve newest-first order.
                if !batch.is_empty() {
                    if !fetch_thumb_batch(
                        store,
                        keys,
                        bytes,
                        &batch,
                        &mut thumb_landed,
                        cancellation,
                    )? {
                        dead[store_idx] = true;
                        break;
                    }
                    batch.clear();
                    batch_bytes = 0;
                }
                if let Some(stop) = cancellation {
                    stop.check()?;
                }
                match assemble_into(store, keys, &entry.h, &entry.thumbnail, bytes) {
                    Ok(Assembled::Landed(_)) => thumb_landed[idx] = true,
                    Ok(Assembled::Unreachable | Assembled::Untrusted) => {
                        dead[store_idx] = true;
                        break;
                    }
                    Ok(Assembled::Missing | Assembled::Damaged) => {}
                    Err(error) => {
                        if let Some(stop) = cancellation {
                            stop.check()?;
                        }
                        tracing::debug!(%error, "multi-chunk thumbnail fetch failed");
                        dead[store_idx] = true;
                        break;
                    }
                }
            }
        }
        if !dead[store_idx] && !batch.is_empty() && !out_of_time() {
            if !fetch_thumb_batch(store, keys, bytes, &batch, &mut thumb_landed, cancellation)? {
                dead[store_idx] = true;
            }
        } else if !batch.is_empty() && out_of_time() {
            timed_out = true;
        }
        if timed_out {
            break;
        }
    }

    let landed = thumb_landed.iter().filter(|&&done| done).count();
    let unlanded = needed.len() - landed;
    let all_gateways_answered =
        paired_count > 0 && stores.len() == paired_count && !dead.iter().any(|&d| d);
    let still_missing = if !timed_out && all_gateways_answered {
        // Every paired gateway answered and none held an openable copy: confirmed absent.
        0
    } else {
        unlanded
    };
    Ok((landed, still_missing))
}

/// **A RESTORE'S MEDIA PHASES (R3)**: thumbnails first (batched via `fetch`, newest first), then
/// every original the newest tree lists that this phone does not hold, newest first, a pass at a
/// time. Runs only while the restore left the marker
/// ([`Plane::originals_marker`](super::Plane::originals_marker)): an original the member freed
/// from this phone on purpose is not one to bring back. At most `limit` originals per call; the
/// marker goes when only excluded or confirmed-absent items remain.
///
/// Answers `(landed, still_missing)`.
///
/// # Errors
/// The device state's or the content store's refusal; a stop.
#[allow(clippy::too_many_lines)]
pub(crate) fn bring_originals(
    handle: &Handle,
    keyring: &Keyring,
    runtime: &tokio::runtime::Handle,
    cancellation: Option<crate::handle::Cancellation>,
    admits: &dyn Fn(bool) -> bool,
    out_of_time: &dyn Fn() -> bool,
    limit: usize,
) -> Result<(usize, usize)> {
    let plane = handle.plane();
    if !plane.originals_marker().exists() {
        return Ok((0, 0));
    }
    let Some(door) = handle.bytes() else {
        return Ok((0, 0));
    };
    let bytes = door.store();
    let state = plane.state()?;
    let Some((root_name, _)) = state.device().map_err(plane_error)?.newest else {
        return Ok((0, 0));
    };
    let Some(root_ref) = status::node_ref(&state, &keyring.backup, &root_name) else {
        return Ok((0, 0));
    };
    let root = tree::root_of(&state, &root_ref).map_err(plane_error)?;
    let mut entries = tree::entries_of(&state, &root.blobs).map_err(plane_error)?;
    entries.sort_by_key(|entry| (std::cmp::Reverse(entry.taken_at_ms), entry.h));

    let gateways = state.gateways().map_err(plane_error)?;
    let paired_count = gateways
        .iter()
        .filter(|gateway| gateway.moved_epoch.is_none())
        .count();
    let tokens = plane.tokens();
    let mut stores = Vec::new();
    for gateway in gateways {
        if gateway.moved_epoch.is_some() {
            continue;
        }
        let Some(token) = tokens.get(&gateway.gateway_id) else {
            continue;
        };
        let mut store =
            GatewayStore::for_gateway(&gateway, *token, keyring.vault.identity.signing(), runtime)?;
        store.set_cancellation(cancellation.clone());
        stores.push(store);
    }
    let mut dead = vec![false; stores.len()];
    let exclude_videos = plane.remembered().is_some_and(|c| c.exclude_videos);

    // R3, PHASE 2: missing thumbnails first, in batches, retried on subsequent passes until held
    // or confirmed absent on every paired gateway.
    let (thumbs_landed, thumbs_missing) = bring_thumbnails(
        &entries,
        &state,
        bytes,
        &keyring.backup,
        &stores,
        &mut dead,
        paired_count,
        &cancellation,
        out_of_time,
    )?;

    // R3, PHASE 3: originals, newest first, bounded by `limit`, deadline, and the member's rule.
    let mut originals_landed = 0_usize;
    let mut missing = thumbs_missing;
    for entry in &entries {
        if entry.kind != tree::EntryKind::Original
            || entry.original.is_empty()
            || have_local(&state, bytes, &entry.h)?
        {
            continue;
        }
        let video = entry
            .media_type
            .trim()
            .to_ascii_lowercase()
            .starts_with("video/");
        if video && exclude_videos {
            continue;
        }
        if originals_landed >= limit || out_of_time() || !admits(video) {
            missing += 1;
            continue;
        }
        let mut got = false;
        let mut answered_absent = 0_usize;
        for (store_idx, store) in stores.iter().enumerate() {
            if dead[store_idx] {
                continue;
            }
            if let Some(stop) = &cancellation {
                stop.check()?;
            }
            match assemble_into(store, &keyring.backup, &entry.h, &entry.original, bytes) {
                Ok(Assembled::Landed(_)) => {
                    got = true;
                    break;
                }
                Ok(Assembled::Unreachable | Assembled::Untrusted) => {
                    dead[store_idx] = true;
                }
                Ok(Assembled::Missing | Assembled::Damaged) => {
                    answered_absent += 1;
                }
                Err(error) => {
                    if let Some(stop) = &cancellation {
                        stop.check()?;
                    }
                    tracing::debug!(%error, "original fetch failed");
                    dead[store_idx] = true;
                }
            }
        }
        if got {
            originals_landed += 1;
            let assets = handle.with_vault(|vault| {
                centraid_vault::originals::assets_for_hashes(vault, &[entry.h.to_hex()])
                    .map_err(CoreError::from)
            })?;
            crate::events::ChangeFeed::new(handle.events()).blobs_arrived(&assets);
        } else {
            let confirmed_absent = paired_count > 0 && answered_absent == paired_count;
            if !confirmed_absent {
                missing += 1;
            }
        }
    }
    if missing == 0 {
        let _ = std::fs::remove_file(plane.originals_marker());
    }
    Ok((thumbs_landed + originals_landed, missing))
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_vault::backup::store::{MemoryStore, Outgoing};

    fn chunks(keys: &BackupKeys, plain: &[u8]) -> (Vec<Ref>, Vec<Outgoing>) {
        let mut refs = Vec::new();
        let mut frames = Vec::new();
        for chunk in plain.chunks(sealed::CHUNK_BYTES) {
            let sealed = sealed::seal(keys, Class::Originals, chunk).expect("seals");
            refs.push(sealed.reference());
            frames.push(Outgoing::of(sealed.name, sealed.object));
        }
        (refs, frames)
    }

    /// **A FILE LANDS ONLY WHEN EVERY CHUNK OPENS AND THE WHOLE IS THE FILE NAMED**, and a file
    /// the gateway cannot complete leaves nothing in the store.
    #[test]
    fn a_file_lands_only_whole_and_a_refused_one_leaves_nothing() {
        let dir = tempfile::tempdir().expect("a directory");
        let bytes = ByteStore::open(dir.path().join("bytes")).expect("a byte store");
        let keys = centraid_vault::backup::naming::keys_from_root(&[7; 32]);
        let plain: Vec<u8> = (0..sealed::CHUNK_BYTES + 1000)
            .map(|n| (n % 251) as u8)
            .collect();
        let h = PlaintextHash::of(&plain);
        let (refs, frames) = chunks(&keys, &plain);
        let store = MemoryStore::new("gw");
        store.bundle(&frames).expect("stores");
        match assemble_into(&store, &keys, &h, &refs, &bytes).expect("assembles") {
            Assembled::Landed(path) => assert_eq!(std::fs::read(path).expect("reads"), plain),
            _ => panic!("a whole file lands"),
        }
        // A chunk the gateway lacks: nothing is published.
        let other = MemoryStore::new("empty");
        let again = ByteStore::open(dir.path().join("again")).expect("a byte store");
        assert!(matches!(
            assemble_into(&other, &keys, &h, &refs, &again).expect("assembles"),
            Assembled::Missing
        ));
        assert!(again.hashes().expect("hashes").is_empty());
        // Chunks that are not the file they are listed for: refused, and nothing is kept.
        let wrong = PlaintextHash::of(b"another file");
        assert!(matches!(
            assemble_into(&store, &keys, &wrong, &refs, &again).expect("assembles"),
            Assembled::Damaged
        ));
        assert!(again.hashes().expect("hashes").is_empty());
    }
}
