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

use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use centraid_blobs::{ByteStore, ContentHash};
use centraid_media::sealed::{self, BackupKeys, Class, PlaintextHash, Ref};
use centraid_vault::backup::files::content_files;
use centraid_vault::backup::state::{DeviceState, LocalSource};
use centraid_vault::backup::store::{Store, StoreError};
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
            Err(error) => return Err(store_error(error)),
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

/// The refs of the original `h` in the newest tree this phone holds: the way to ask a gateway for
/// it. Empty when the tree does not list its bytes.
pub(crate) fn refs_of_original(
    state: &DeviceState,
    keys: &BackupKeys,
    h: &PlaintextHash,
) -> Result<Vec<Ref>> {
    let Some((name, _)) = state.device().map_err(plane_error)?.newest else {
        return Ok(Vec::new());
    };
    let Some(reference) = status::node_ref(state, keys, &name) else {
        return Ok(Vec::new());
    };
    let root = tree::root_of(state, &reference).map_err(plane_error)?;
    Ok(tree::entries_of(state, &root.blobs)
        .map_err(plane_error)?
        .into_iter()
        .find(|entry| entry.h == *h)
        .map(|entry| entry.refs(Class::Originals).to_vec())
        .unwrap_or_default())
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

/// **A RESTORE'S ORIGINALS PHASE (R3)**: every original the newest tree lists that this phone
/// does not hold, newest first, a pass at a time. Runs only while the restore left the marker
/// ([`Plane::originals_marker`](super::Plane::originals_marker)): an original the member freed
/// from this phone on purpose is not one to bring back. At most `limit` files per call; the
/// marker goes when nothing is missing.
///
/// Answers `(landed, still_missing)`.
///
/// # Errors
/// The device state's or the content store's refusal; a stop.
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
    let tokens = plane.tokens();
    let mut stores = Vec::new();
    for gateway in state.gateways().map_err(plane_error)? {
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
    let (mut landed, mut missing) = (0_usize, 0_usize);
    for entry in entries {
        if entry.original.is_empty() {
            continue;
        }
        let have = bytes
            .path_of(ContentHash::from_bytes(*entry.h.as_bytes()))
            .map_err(|error| CoreError::Invariant {
                context: format!("the content store: {error}"),
            })?
            .is_some();
        if have
            || state
                .local(&entry.h)
                .map_err(plane_error)?
                .is_some_and(|local| local.source == LocalSource::Os)
        {
            continue;
        }
        let video = entry
            .media_type
            .trim()
            .to_ascii_lowercase()
            .starts_with("video/");
        if landed >= limit || out_of_time() || !admits(video) {
            missing += 1;
            continue;
        }
        let mut got = false;
        for store in &stores {
            if let Some(stop) = &cancellation {
                stop.check()?;
            }
            if let Assembled::Landed(_) =
                assemble_into(store, &keyring.backup, &entry.h, &entry.original, bytes)?
            {
                got = true;
                break;
            }
        }
        if got {
            landed += 1;
            let assets = handle.with_vault(|vault| {
                centraid_vault::originals::assets_for_hashes(vault, &[entry.h.to_hex()])
                    .map_err(CoreError::from)
            })?;
            crate::events::ChangeFeed::new(handle.events()).blobs_arrived(&assets);
        } else {
            missing += 1;
        }
    }
    if missing == 0 {
        let _ = std::fs::remove_file(plane.originals_marker());
    }
    Ok((landed, missing))
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
