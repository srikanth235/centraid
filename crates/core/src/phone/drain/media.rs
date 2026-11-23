//! Blob claims walking, OS library staging negotiation, sealing, and interleaved media rounds.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Instant;

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{self, ChunkDigest, PartSealer};
use centraid_vault::backup::files::ContentFile;
use centraid_vault::backup::mover;
use centraid_vault::backup::naming::{BackupKeys, Name, name as part_name, names_of, part_count};
use centraid_vault::backup::spool::Spool;
use centraid_vault::backup::state::{DeviceState, LocalSource, Outbox, OutboxKind, Waiting};
use centraid_vault::backup::store::{self as plane_store, Store};
use centraid_vault::clock::SystemClock;

use super::policy::{Conditions, Kind};
use super::{Flow, MAX_NEED_BYTES, Pass, READ_CHUNK};
use crate::error::{CoreError, Result};
use crate::handle::HandleState as Handle;
use crate::phone::link::{GatewayStore, Reached};
use crate::phone::{now_ms, plane_error, store_error};
use crate::stage::{bytes_of_parts, window_within};

// ─── the media ──────────────────────────────────────────────────────────────

/// One gateway's side of a pass's media rounds, and what a pass works out once for it.
pub(super) struct Feed<'a> {
    pub(super) reached: &'a Reached,
    /// Set when the gateway has had its last round: it finished, or left the pass.
    pub(super) finished: bool,
    /// The walk of the vault's new claims reached the end for this gateway, this pass.
    walked: bool,
    /// The lapsed rows were looked at again, this pass.
    examined: bool,
    /// What the vault says of each blob this gateway is owed, read once and kept.
    files: BTreeMap<centraid_vault::backup::naming::PlaintextHash, ContentFile>,
}

impl<'a> Feed<'a> {
    pub(super) fn new(reached: &'a Reached) -> Self {
        Self {
            reached,
            finished: false,
            walked: false,
            examined: false,
            files: BTreeMap::new(),
        }
    }
}

/// How many claims one step of the cursor walk reads (E11).
const WALK_PAGE: usize = 500;

/// **The cursor's walk** (#1191, E11, B12): the vault's claims made since the gateway's cursor,
/// in order, a page at a time. For each blob the part names are worked out and the gateway is
/// asked `exists`; each name it lacks becomes an outbox row, and the cursor moves past the page in
/// the same transaction. An unchanged library returns no claims: one statement, and no gateway
/// call. A blob only lapsed entities rent leaves a `lapsed` row and is not asked about. Answers
/// whether the walk reached the end.
#[allow(clippy::too_many_arguments)]
fn walk_claims(
    handle: &Handle,
    state: &DeviceState,
    spool: &Spool,
    store: &GatewayStore,
    keys: &BackupKeys,
    feed_files: &mut BTreeMap<centraid_vault::backup::naming::PlaintextHash, ContentFile>,
    deadline: Instant,
    pass: &mut Pass,
) -> Result<bool> {
    use centraid_vault::backup::files::{Found, content_files_for};
    use centraid_vault::backup::naming::claims_after;
    let gateway = store.gateway_id().to_owned();
    loop {
        if Instant::now() >= deadline {
            return Ok(false);
        }
        store.checkpoint()?;
        let Some(row) = state.gateway(&gateway).map_err(plane_error)? else {
            return Ok(true);
        };
        let after = i64::try_from(row.cursor).unwrap_or(i64::MAX);
        let claims = handle
            .with_vault(|vault| claims_after(vault, after, WALK_PAGE).map_err(plane_error))?;
        let Some(last) = claims.last().map(|claim| claim.seq) else {
            return Ok(true);
        };
        let hashes: Vec<_> = claims.iter().map(|claim| claim.hash).collect();
        let found =
            handle.with_vault(|vault| content_files_for(vault, &hashes).map_err(plane_error))?;
        let now = now_ms();
        let mut ask: Vec<Name> = Vec::new();
        let mut rows: Vec<Outbox> = Vec::new();
        let mut owed: Vec<(
            Name,
            centraid_vault::backup::naming::PlaintextHash,
            ContentFile,
        )> = Vec::new();
        for claim in &claims {
            let names = names_of(keys, &claim.hash, claim.len);
            match found.get(&claim.hash) {
                Some(Found::Live(file)) => {
                    for name in names {
                        ask.push(name);
                        owed.push((name, claim.hash, file.clone()));
                    }
                }
                Some(Found::Lapsed) => {
                    for name in names {
                        let mut row = blob_row(
                            &gateway,
                            name,
                            claim.hash,
                            "application/octet-stream",
                            false,
                            now,
                        );
                        row.waiting = Some(Waiting::Lapsed);
                        rows.push(row);
                    }
                }
                // COLLECTED SINCE THE WALK READ IT: nothing to back up.
                None => {}
            }
        }
        if !ask.is_empty() {
            pass.asks += ask.len();
            let missing = plane_store::missing(store, &ask).map_err(store_error)?;
            for (name, hash, file) in owed {
                if missing.contains(&name) {
                    rows.push(blob_row(
                        &gateway,
                        name,
                        hash,
                        &file.media_type,
                        file.variant.is_some(),
                        now,
                    ));
                    feed_files.insert(hash, file);
                } else {
                    pass.media_confirmed = pass.media_confirmed.saturating_add(1);
                    // THE GATEWAY HOLDS IT: a file the stage door sealed for nobody is not wanted.
                    if spool.contains(&name)
                        && state.owed_among(&[name]).map_err(plane_error)?.is_empty()
                    {
                        spool.remove(&name).map_err(plane_error)?;
                    }
                }
            }
        }
        state
            .advance(&gateway, &rows, u64::try_from(last).unwrap_or(0))
            .map_err(plane_error)?;
    }
}

/// The length and digest of a sealed file in the spool.
fn file_seal(path: &Path) -> std::io::Result<(u64, centraid_vault::backup::naming::Digest)> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; READ_CHUNK];
    let mut len = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        len += read as u64;
    }
    Ok((
        len,
        centraid_vault::backup::naming::Digest::from_bytes(*hasher.finalize().as_bytes()),
    ))
}

/// An owed blob part, not sealed yet.
fn blob_row(
    gateway: &str,
    name: Name,
    hash: centraid_vault::backup::naming::PlaintextHash,
    media_type: &str,
    derivative: bool,
    now: u64,
) -> Outbox {
    Outbox {
        gateway_id: gateway.to_owned(),
        name,
        kind: OutboxKind::Blob,
        hash: Some(hash),
        part_path: None,
        waiting: None,
        size: None,
        digest: None,
        media_type: Some(media_type.to_owned()),
        created_ms: now,
        handed_ms: None,
        attempts: 0,
        last_error: None,
        derivative,
    }
}

/// Look again at the rows that wait for the vault's own collection: a blob rented again is owed
/// (the walk will not meet it again, so it is asked about here), and a blob gone has its rows
/// deleted. The cost is the number of lapsed blobs, never the library.
fn reexamine_lapsed(
    handle: &Handle,
    state: &DeviceState,
    store: &GatewayStore,
    keys: &BackupKeys,
    feed_files: &mut BTreeMap<centraid_vault::backup::naming::PlaintextHash, ContentFile>,
    pass: &mut Pass,
) -> Result<()> {
    use centraid_vault::backup::files::{Found, content_files_for};
    let gateway = store.gateway_id();
    let lapsed = state.outbox_waiting(gateway).map_err(plane_error)?;
    let hashes: BTreeSet<_> = lapsed
        .iter()
        .filter(|row| row.waiting == Some(Waiting::Lapsed))
        .filter_map(|row| row.hash)
        .collect();
    if hashes.is_empty() {
        return Ok(());
    }
    let hashes: Vec<_> = hashes.into_iter().collect();
    let found =
        handle.with_vault(|vault| content_files_for(vault, &hashes).map_err(plane_error))?;
    let mut ask: Vec<(
        Name,
        centraid_vault::backup::naming::PlaintextHash,
        ContentFile,
    )> = Vec::new();
    let mut gone: Vec<Name> = Vec::new();
    for row in lapsed
        .iter()
        .filter(|row| row.waiting == Some(Waiting::Lapsed))
    {
        let Some(hash) = row.hash else { continue };
        match found.get(&hash) {
            Some(Found::Lapsed) => {}
            Some(Found::Live(file)) => {
                gone.push(row.name);
                ask.push((row.name, hash, file.clone()));
            }
            None => gone.push(row.name),
        }
    }
    state.done_many(gateway, &gone).map_err(plane_error)?;
    if ask.is_empty() {
        return Ok(());
    }
    let names: Vec<Name> = ask.iter().map(|(name, _, _)| *name).collect();
    pass.asks += names.len();
    let missing = plane_store::missing(store, &names).map_err(store_error)?;
    let now = now_ms();
    let mut rows = Vec::new();
    for (name, hash, file) in ask {
        if missing.contains(&name) {
            rows.push(blob_row(
                gateway,
                name,
                hash,
                &file.media_type,
                file.variant.is_some(),
                now,
            ));
            feed_files.insert(hash, file);
        }
    }
    state.put_outbox_many(&rows).map_err(plane_error)?;
    let _ = keys;
    Ok(())
}

/// Give every gateway that owes `name` the sealed file just written: the spool holds one file a
/// name, shared. A name nobody owes (it was let go while it was sealing) leaves the spool.
fn adopt_sealed(
    state: &DeviceState,
    name: &Name,
    path: &Path,
    size: u64,
    digest: &centraid_vault::backup::naming::Digest,
    chunks: &[ChunkDigest],
) -> Result<()> {
    state.record_digests(name, chunks).map_err(plane_error)?;
    let filled = state
        .seal_everywhere(name, path, size, digest)
        .map_err(plane_error)?;
    if filled == 0 {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// One bounded round for one gateway: walk the claims it has not met, seal what fits the spool,
/// move it. `Continue` when more remains (another round is owed), `Stop` when the gateway left
/// the pass; a gateway whose round sealed and moved nothing is finished.
#[allow(clippy::too_many_arguments)]
pub(super) fn media_round<'a>(
    feed: &mut Feed<'a>,
    handle: &Handle,
    state: &DeviceState,
    spool: &Spool,
    keys: &BackupKeys,
    bytes: Option<&centraid_blobs::ByteStore>,
    conditions: &Conditions,
    budget: u64,
    deadline: Instant,
    reachable: &[String],
    pass: &mut Pass,
) -> Result<Flow> {
    let store = &feed.reached.store;
    if spool.bytes().map_err(plane_error)? >= budget {
        // THE SPOOL IS FULL OF PARTS A GATEWAY THAT DID NOT ANSWER STILL OWES: the room is
        // needed more than the wait; that gateway is fed again from the vault when it returns.
        mover::release_to_reachable(state, spool, reachable).map_err(plane_error)?;
    }
    if !feed.examined {
        reexamine_lapsed(handle, state, store, keys, &mut feed.files, pass)?;
        feed.examined = true;
    }
    if !feed.walked {
        feed.walked = walk_claims(
            handle,
            state,
            spool,
            store,
            keys,
            &mut feed.files,
            deadline,
            pass,
        )?;
    }
    let sealed = prepare(
        feed, handle, state, spool, keys, bytes, conditions, budget, deadline, pass,
    )?;
    if Instant::now() >= deadline {
        pass.stopped = wire::DrainStop::Deadline;
        return Ok(Flow::Stop);
    }
    let store = &feed.reached.store;
    let moved = mover::move_queue_where(state, spool, store, deadline, &SystemClock, &|part| {
        let kind = Kind::of_part(part);
        part.handed_ms.is_none() && kind != Kind::Records && conditions.may_move(kind)
    })
    .map_err(plane_error)?;
    pass.count(moved.confirmed.len());
    pass.media_confirmed = pass.media_confirmed.saturating_add(moved.confirmed.len());
    if pass.stopped_by(&moved.stopped)? {
        return Ok(Flow::Stop);
    }
    // A ROUND THAT MOVED PARTS FREED ROOM, so one more prepare asks for the next window of a
    // library item larger than the spool (R-1080-C39) before the pass answers; a round that
    // did neither, with the walk at its end, is the end.
    if sealed == 0 && moved.confirmed.is_empty() && feed.walked {
        feed.finished = true;
        pass.fed += 1;
    }
    Ok(Flow::Continue)
}

/// Seal what a gateway is owed of the vault's files into the spool, up to its budget:
/// derivatives first, the grid, then originals, newest first within each. Answers how many
/// parts were sealed.
#[allow(clippy::too_many_arguments)]
fn prepare<'a>(
    feed: &mut Feed<'a>,
    handle: &Handle,
    state: &DeviceState,
    spool: &Spool,
    keys: &BackupKeys,
    bytes: Option<&centraid_blobs::ByteStore>,
    conditions: &Conditions,
    budget: u64,
    deadline: Instant,
    pass: &mut Pass,
) -> Result<usize> {
    use centraid_vault::backup::files::{Found, content_files_for};
    let reached = feed.reached;
    let store = &reached.store;
    let gateway = store.gateway_id();
    // WHAT THIS GATEWAY IS OWED AND NOTHING SEALED YET, grouped by file: the part names it lacks
    // and each one's index. Every gateway is a full replica (#1188, B1).
    let unsealed = state.outbox_unsealed(gateway).map_err(plane_error)?;
    let missing_info: Vec<_> = unsealed
        .iter()
        .filter_map(|row| row.hash)
        .filter(|hash| !feed.files.contains_key(hash))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if !missing_info.is_empty() {
        let found = handle
            .with_vault(|vault| content_files_for(vault, &missing_info).map_err(plane_error))?;
        let mut gone: Vec<Name> = Vec::new();
        for row in &unsealed {
            let Some(hash) = row.hash else { continue };
            if feed.files.contains_key(&hash) {
                continue;
            }
            match found.get(&hash) {
                Some(Found::Live(file)) => {
                    feed.files.insert(hash, file.clone());
                }
                Some(Found::Lapsed) => {
                    state
                        .set_waiting(gateway, &row.name, Some(Waiting::Lapsed))
                        .map_err(plane_error)?;
                }
                // COLLECTED SINCE IT WAS OWED: nobody owes it now.
                None => gone.push(row.name),
            }
        }
        state.done_many(gateway, &gone).map_err(plane_error)?;
    }
    let mut by_file: BTreeMap<centraid_vault::backup::naming::PlaintextHash, Vec<(u32, Name)>> =
        BTreeMap::new();
    for row in &unsealed {
        let Some(hash) = row.hash else { continue };
        let Some(file) = feed.files.get(&hash) else {
            continue;
        };
        if let Some(index) = pass
            .names_of(keys, file)
            .iter()
            .position(|name| *name == row.name)
        {
            by_file
                .entry(hash)
                .or_default()
                .push((u32::try_from(index).unwrap_or(u32::MAX), row.name));
        }
    }
    let mut candidates: Vec<(&ContentFile, Vec<(u32, Name)>)> = by_file
        .into_iter()
        .filter_map(|(hash, parts)| Some((feed.files.get(&hash)?, parts)))
        .filter(|(file, _)| conditions.counts(Kind::of_file(file)))
        .filter(|(file, _)| conditions.may_prepare(Kind::of_file(file)))
        .collect();
    // NEWEST FIRST, DERIVATIVES BEFORE ORIGINALS: they are kilobytes and they are the grid.
    candidates.sort_by(|a, b| b.0.created_at.cmp(&a.0.created_at));
    candidates.sort_by_key(|(file, _)| file.variant.is_none());

    let mut held_bytes = spool
        .bytes()
        .map_err(plane_error)?
        .saturating_add(pass.promised);
    let mut sealed = 0_usize;
    let mut library: Vec<LibraryAsk<'_>> = Vec::new();
    for (file, parts) in candidates {
        store.checkpoint()?;
        if Instant::now() >= deadline {
            break;
        }
        // A PART SOME OTHER GATEWAY SEALED ALREADY IS NOT SEALED AGAIN: the spool's file is
        // shared, and this gateway's row takes its size and digest.
        let mut fresh: Vec<(u32, Name)> = Vec::new();
        for (index, name) in parts {
            match state.sealed_copy(&name).map_err(plane_error)? {
                Some(copy) if spool.contains(&name) => {
                    if let (Some(path), Some(size), Some(digest)) =
                        (copy.part_path.as_ref(), copy.size, copy.digest.as_ref())
                    {
                        state
                            .seal_outbox(gateway, &name, path, size, digest)
                            .map_err(plane_error)?;
                    }
                }
                // A FILE THE STAGE DOOR SEALED BEFORE ANY ROW OWED IT sits in the spool unowned:
                // this gateway's row takes it, sized and digested from the file itself.
                None if spool.contains(&name) => {
                    let path = spool.path(&name);
                    match file_seal(&path) {
                        Ok((size, digest)) => {
                            state
                                .seal_outbox(gateway, &name, &path, size, &digest)
                                .map_err(plane_error)?;
                        }
                        Err(error) => {
                            tracing::warn!(%error, "a spooled part cannot be read; it is sealed again");
                            spool.remove(&name).map_err(plane_error)?;
                            fresh.push((index, name));
                        }
                    }
                }
                _ => fresh.push((index, name)),
            }
        }
        if fresh.is_empty() {
            continue;
        }
        let content = centraid_blobs::ContentHash::from_bytes(*file.h.as_bytes());
        let path = bytes
            .map(|store| store.path_of(content))
            .transpose()
            .map_err(|error| CoreError::Invariant {
                context: format!("the content store: {error}"),
            })?
            .flatten();
        if let Some(path) = path {
            if held_bytes >= budget {
                continue;
            }
            let indices: BTreeSet<u32> = fresh.iter().map(|(index, _)| *index).collect();
            sealed += seal_store_file(
                &path,
                store,
                file,
                &indices,
                keys,
                spool,
                state,
                budget,
                deadline,
                pass.free,
                &mut held_bytes,
            )?;
            continue;
        }
        let local = state.local(&file.h).map_err(plane_error)?;
        if let Some(local) = local.filter(|local| local.source == LocalSource::Os) {
            let first = pass
                .names_of(keys, file)
                .first()
                .copied()
                .unwrap_or_else(|| part_name(keys, &file.h, 0));
            pass.waiting_bytes.insert(first);
            if let Some(os_ref) = local.os_ref.filter(|os_ref| !os_ref.is_empty()) {
                library.push(LibraryAsk {
                    file,
                    os_ref,
                    parts: fresh.iter().map(|(index, _)| *index).collect(),
                });
            }
        }
        // NOWHERE ON THIS PHONE: a restored phone that has not fetched an
        // original, or bytes a member released. Nothing here can send them.
    }
    plan_library(
        &library,
        budget.saturating_sub(held_bytes),
        (held_bytes == 0).then_some(pass.free),
        pass,
    );
    Ok(sealed)
}

/// One library item a pass could ask the shell to stream.
pub(super) struct LibraryAsk<'a> {
    pub(super) file: &'a ContentFile,
    pub(super) os_ref: String,
    /// The parts no gateway holds and nothing queued, ascending.
    pub(super) parts: Vec<u32>,
}

/// **Ask for the library items the spool has room for** (`NeedBytes`,
/// R-1080-C39): each that fits whole, in the order given; then the first that
/// did not, for as many of its parts as the room the others left will hold.
/// An item is asked for only when at least one of its parts fits, so a shell
/// never reads an item the stage door could only hash. What is asked for is
/// promised, so a later round of the same pass cannot spend it before the
/// shell streams.
fn plan_library(
    asks: &[LibraryAsk<'_>],
    mut room: u64,
    empty_spool_free: Option<u64>,
    pass: &mut Pass,
) {
    let mut larger: Option<&LibraryAsk<'_>> = None;
    for ask in asks {
        if pass.need.len() >= MAX_NEED_BYTES {
            return;
        }
        if pass.has_asked(ask) {
            continue;
        }
        let whole = bytes_of_parts(ask.file.len, &ask.parts);
        if whole <= room {
            room -= whole;
            pass.ask_for(ask, ask.parts.clone());
        } else if larger.is_none() {
            // THE FIRST ITEM LARGER THAN THE ROOM waits for what the rest
            // leave, so photographs keep moving past a film.
            larger = Some(ask);
        }
    }
    if let Some(ask) = larger {
        let window = window_within(room, ask.file.len, &ask.parts, empty_spool_free);
        if !window.is_empty() {
            pass.ask_for(ask, window);
        }
    }
}

/// Seal the parts `indices` of a file the app's own store holds, one part at
/// a time straight into the spool: the file's hash is known, so every part's
/// name is too, and a film larger than the spool is sealed a part at a time
/// as the mover drains it. Each sealed part fills every gateway's row that owes it. Answers how
/// many parts were sealed.
#[allow(clippy::too_many_arguments)]
fn seal_store_file(
    path: &std::path::Path,
    store: &GatewayStore,
    file: &ContentFile,
    indices: &BTreeSet<u32>,
    keys: &BackupKeys,
    spool: &Spool,
    state: &DeviceState,
    budget: u64,
    deadline: Instant,
    free: u64,
    held_bytes: &mut u64,
) -> Result<usize> {
    let invariant = |what: &str, error: &dyn std::fmt::Display| CoreError::Invariant {
        context: format!("sealing {} ({what}): {error}", file.h),
    };
    let mut reader = File::open(path).map_err(|error| invariant("open", &error))?;
    let actual = reader
        .metadata()
        .map_err(|error| invariant("measure", &error))?
        .len();
    if actual != file.len {
        // THE STORE NAMES A FILE BY ITS BYTES, and the vault's row disagrees
        // about how many there are: the names would be wrong, so nothing is
        // sealed under them.
        tracing::warn!(
            content = %file.h,
            held = actual,
            row = file.len,
            "a stored file is not the length its row names; it is not sealed"
        );
        return Ok(0);
    }
    let mut buffer = vec![0_u8; READ_CHUNK];
    let mut sealed = 0;
    for index in 0..part_count(file.len) {
        store.checkpoint()?;
        let len = sealed::part_len(file.len, index).map_err(|error| invariant("cut", &error))?;
        if !indices.contains(&index) {
            reader
                .seek(SeekFrom::Current(i64::try_from(len).unwrap_or(i64::MAX)))
                .map_err(|error| invariant("seek", &error))?;
            continue;
        }
        // THE SPOOL NEVER HOLDS MORE THAN ITS BUDGET: a part that would pass
        // it waits for the room the mover frees (`Spool`'s "admits").
        if Instant::now() >= deadline
            || !centraid_vault::backup::spool::admits_on(*held_bytes, len, budget, free)
        {
            break;
        }
        let name = part_name(keys, &file.h, index);
        let writer = spool.writer(&name).map_err(plane_error)?;
        let mut sealer = PartSealer::new(keys, index, len, false, writer)
            .map_err(|error| invariant("begin", &error))?;
        let mut left = len;
        while left > 0 {
            store.checkpoint()?;
            let take = usize::try_from(left.min(READ_CHUNK as u64)).unwrap_or(READ_CHUNK);
            reader
                .read_exact(&mut buffer[..take])
                .map_err(|error| invariant("read", &error))?;
            sealer
                .update(&buffer[..take])
                .map_err(|error| invariant("seal", &error))?;
            left -= take as u64;
        }
        let (writer, seal) = sealer
            .finish()
            .map_err(|error| invariant("finish", &error))?;
        let part_path = writer.finish().map_err(plane_error)?;
        adopt_sealed(
            state,
            &name,
            &part_path,
            seal.len,
            &seal.digest,
            &seal.chunk_digests,
        )?;
        *held_bytes = held_bytes.saturating_add(seal.len);
        sealed += 1;
    }
    Ok(sealed)
}

/// Keep the parts the stage door sealed beside a library item's stream (the root's ruling A8):
/// each is moved to its name in the spool and fills every gateway's row that owes it. A part no
/// row owes yet is kept all the same while any gateway is paired: the blob walk meets the new
/// claim a moment later and finds the file already sealed (`prepare`). With nothing paired they
/// are dropped. Answers how many were kept.
///
/// # Errors
/// The device state's or the spool's refusal.
pub fn queue_sealed(
    spool: &Spool,
    state: &DeviceState,
    sealed: &sealed::FileSeal,
    _media_type: &str,
) -> Result<usize> {
    let paired = !state.gateways().map_err(plane_error)?.is_empty();
    let mut count = 0;
    for part in &sealed.parts {
        // A PART IS SEALED ONCE: one already in the spool is not replaced.
        if !paired || spool.contains(&part.name) {
            let _ = std::fs::remove_file(&part.path);
            continue;
        }
        let part_path = spool.adopt(&part.path, &part.name).map_err(plane_error)?;
        state
            .record_digests(&part.name, &part.chunk_digests)
            .map_err(plane_error)?;
        state
            .seal_everywhere(&part.name, &part_path, part.len, &part.digest)
            .map_err(plane_error)?;
        count += 1;
    }
    Ok(count)
}
