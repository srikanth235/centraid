//! FILES BACK FROM A GATEWAY, BY NAME (#1080 ruling 4).
//!
//! **The database plus the words is the whole index.** A file's parts are
//! named from its plaintext hash, which the vault holds for every content item
//! and derivative, so a phone asks for a file by computing names — no listing,
//! no custody row. Each part opens under `K_backup` and the whole is checked
//! against its hash before it lands in the app's own store: a gateway that
//! substituted, truncated or reordered anything is refused, never stored.
//!
//! Two callers: `fetch_original`, one original a member tapped, a part at a
//! time into a file; and a restore, which brings back every derivative so the
//! grid is whole, a thousand names to a fetch.

use std::io::Write;
use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use centraid_blobs::{ByteStore, ContentHash};
use centraid_media::sealed::{self, Assembler};
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::ledger::LocalSource;
use centraid_vault::backup::naming::{
    BackupKeys, Name, PlaintextHash, name as part_name, part_count,
};
use centraid_vault::backup::store::{
    BUNDLE_BYTES, FRAME_HEADER_BYTES, NAMES_PER_CALL, Store, StoreError,
};

use super::link::GatewayStore;
use super::{Keyring, hash_of, plane_error, store_error};
use crate::error::{CoreError, Result};
use crate::handle::Handle;

/// What assembling one file came to.
pub(crate) enum Assembled {
    /// Checked against its hash and stored; the file it is in.
    Landed(PathBuf),
    /// The gateway answered and does not hold every part.
    Missing,
    /// The gateway did not answer.
    Unreachable,
}

/// A byte store's write, wearing `std::io::Write` for the assembler.
struct Into<'a>(&'a mut centraid_blobs::Writer);

impl Write for Into<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf).map_err(std::io::Error::other)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Fetch the `len`-byte file `h` from `store` a part at a time, open each
/// part, check the whole against `h`, and keep it in `bytes`. At most one
/// part is in memory; a refused file leaves nothing in the store.
pub(crate) fn assemble_into(
    store: &dyn Store,
    keys: &BackupKeys,
    h: &PlaintextHash,
    len: u64,
    bytes: &ByteStore,
) -> Result<Assembled> {
    let mut writer = bytes.writer().map_err(|error| CoreError::Invariant {
        context: format!("the content store would not take a fetched file: {error}"),
    })?;
    let mut assembler = Assembler::new(*h, len);
    while let Some(name) = assembler.next_name(keys) {
        let mut sealed_bytes = Vec::new();
        match store.get(&name, &mut sealed_bytes) {
            Ok(_) => {}
            Err(StoreError::Missing(_)) => return Ok(Assembled::Missing),
            Err(StoreError::Unreachable(reason)) => {
                tracing::debug!(%reason, "the gateway stopped answering mid-fetch");
                return Ok(Assembled::Unreachable);
            }
            Err(error) => return Err(store_error(error)),
        }
        assembler
            .part(keys, sealed_bytes.as_slice(), &mut Into(&mut writer))
            .map_err(|error| CoreError::Invariant {
                context: format!("a part of {h} the gateway answered would not open: {error}"),
            })?;
    }
    assembler.finish().map_err(|error| CoreError::Invariant {
        context: format!("the parts of {h} are not the file it names: {error}"),
    })?;
    let stored = writer.finish().map_err(|error| CoreError::Invariant {
        context: format!("the content store would not keep {h}: {error}"),
    })?;
    if stored.hash.as_bytes() != h.as_bytes() {
        return Err(CoreError::Invariant {
            context: format!("the content store named {h} as {}", stored.hash),
        });
    }
    Ok(Assembled::Landed(stored.path))
}

/// The most a one-part file of `len` plaintext bytes can seal to, with its
/// bundle frame header: a fetch is sized by it before it is asked.
fn sealed_bound(len: u64) -> u64 {
    let chunk = sealed::CHUNK_BYTES as u64;
    let per_chunk = (sealed::CHUNK_FRAME_BYTES + sealed::TAG_BYTES) as u64;
    len.saturating_add(sealed::HEADER_BYTES as u64)
        .saturating_add((len / chunk + 1).saturating_mul(per_chunk))
        .saturating_add(FRAME_HEADER_BYTES)
}

/// Fetch every one of `files` the store holds and `bytes` does not, into
/// `bytes`: one-part files a thousand names to a `fetch` whose answer fits a
/// bundle, a larger file a part at a time. Answers how many landed. A file the
/// gateway does not hold is skipped — the grid falls back for it as for any
/// missing tier.
///
/// # Errors
/// A gateway that stopped answering, or anything that would not open as the
/// file its name derives from.
pub(crate) fn fetch_all(
    store: &dyn Store,
    keys: &BackupKeys,
    files: &[&ContentFile],
    bytes: &ByteStore,
) -> Result<usize> {
    let held = |file: &ContentFile| {
        bytes
            .is_complete(ContentHash::from_bytes(*file.h.as_bytes()))
            .unwrap_or(false)
    };
    let mut landed = 0_usize;
    let mut batch: Vec<Name> = Vec::new();
    let mut batch_bytes = 0_u64;
    let fetch_batch = |batch: &mut Vec<Name>, landed: &mut usize| -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let mut refused: Option<CoreError> = None;
        store
            .get_many(batch, &mut |name, sealed_bytes| {
                let plaintext = sealed::open_whole(keys, name, sealed_bytes).map_err(|error| {
                    refused = Some(CoreError::Invariant {
                        context: format!("{name} would not open as the file it names: {error}"),
                    });
                    std::io::Error::other("refused")
                })?;
                bytes.put_bytes(&plaintext).map_err(|error| {
                    refused = Some(CoreError::Invariant {
                        context: format!("the content store would not keep {name}: {error}"),
                    });
                    std::io::Error::other("refused")
                })?;
                *landed += 1;
                Ok(())
            })
            .map_err(|error| refused.take().unwrap_or_else(|| store_error(error)))?;
        batch.clear();
        Ok(())
    };
    for file in files {
        if held(file) {
            continue;
        }
        if part_count(file.len) > 1 {
            if let Assembled::Landed(_) = assemble_into(store, keys, &file.h, file.len, bytes)? {
                landed += 1;
            }
            continue;
        }
        let bound = sealed_bound(file.len);
        if batch.len() == NAMES_PER_CALL || batch_bytes.saturating_add(bound) > BUNDLE_BYTES {
            fetch_batch(&mut batch, &mut landed)?;
            batch_bytes = 0;
        }
        batch.push(part_name(keys, &file.h, 0));
        batch_bytes = batch_bytes.saturating_add(bound);
    }
    fetch_batch(&mut batch, &mut landed)?;
    Ok(landed)
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
/// store; a file a gateway answered that is not the file it names.
pub fn fetch_original(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::FetchOriginalRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::FetchOriginalResponse> {
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
    let ledger = handle.plane().ledger()?;
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
    let mut answered = false;
    for destination in ledger.destinations().map_err(plane_error)? {
        let store = GatewayStore::for_destination(&destination, keyring.vault_id(), runtime)?;
        match assemble_into(&store, &keyring.backup, &h, file.len, bytes)? {
            Assembled::Landed(path) => {
                let assets = handle.with_vault(|vault| {
                    centraid_vault::originals::assets_for_hashes(vault, &[h.to_hex()])
                        .map_err(CoreError::from)
                })?;
                crate::events::ChangeFeed::new(handle.events()).blobs_arrived(&assets);
                return Ok(answer(wire::FetchOutcome::Landed, Some(path)));
            }
            Assembled::Missing => answered = true,
            Assembled::Unreachable => {}
        }
    }
    Ok(answer(
        if answered {
            wire::FetchOutcome::NotInBackup
        } else {
            wire::FetchOutcome::Unreachable
        },
        None,
    ))
}
