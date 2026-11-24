//! The vault's content bytes, read as chunks (spec §3: a file is cut into
//! chunks of at most 4 MiB, each sealed on its own).
//!
//! The bytes are the local content store's ([`crate::bytes::BlobStore`]).
//! Nothing here keeps a sealed chunk: it is rebuilt from the file whenever it
//! is owed.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use centraid_media::sealed::{self, BackupKeys, CHUNK_BYTES, Class, PlaintextHash, Ref, Sealed};

use super::Result;
use crate::file::Vault;

/// How many chunks a file of `len` bytes is: none for an empty file.
#[must_use]
pub const fn chunk_count(len: u64) -> u64 {
    len.div_ceil(CHUNK_BYTES as u64)
}

enum Source {
    File(File),
    Memory(Vec<u8>),
}

fn open(vault: &Vault, h: &PlaintextHash) -> Result<Option<Source>> {
    let Some(store) = vault.blobs() else {
        return Ok(None);
    };
    let id = h.to_hex();
    match store.path_of(&id) {
        Ok(Some(path)) => {
            return Ok(File::open(path).ok().map(Source::File));
        }
        Ok(None) => {}
        Err(_) => return Ok(None),
    }
    match store.has(&id) {
        Ok(true) => Ok(store.get(&id).ok().map(Source::Memory)),
        _ => Ok(None),
    }
}

/// Chunk `index` of the content `h`, when the local store holds it whole.
///
/// # Errors
/// Only a vault that will not read; absent bytes are `None`.
pub fn read_chunk(vault: &Vault, h: &PlaintextHash, index: u64) -> Result<Option<Vec<u8>>> {
    let Some(source) = open(vault, h)? else {
        return Ok(None);
    };
    let at = index * CHUNK_BYTES as u64;
    Ok(match source {
        Source::File(mut file) => {
            let mut bytes = Vec::new();
            if file.seek(SeekFrom::Start(at)).is_err()
                || (&mut file)
                    .take(CHUNK_BYTES as u64)
                    .read_to_end(&mut bytes)
                    .is_err()
            {
                return Ok(None);
            }
            Some(bytes)
        }
        Source::Memory(all) => {
            let start = usize::try_from(at).unwrap_or(usize::MAX);
            (start <= all.len()).then(|| all[start..all.len().min(start + CHUNK_BYTES)].to_vec())
        }
    })
}

/// Seal chunk `index` of `h` as `class`, when the bytes are there.
///
/// # Errors
/// A vault that will not read, or a chunk that does not seal.
pub fn seal_chunk(
    vault: &Vault,
    keys: &BackupKeys,
    h: &PlaintextHash,
    index: u64,
    class: Class,
) -> Result<Option<Sealed>> {
    read_chunk(vault, h, index)?
        .map(|bytes| sealed::seal(keys, class, &bytes).map_err(Into::into))
        .transpose()
}

/// Every chunk's ref of the content `h`, read and sealed in one pass, **only
/// when the bytes hash to `h`**: a file that changed under its name is not
/// backed up under it.
///
/// # Errors
/// A vault that will not read, or a chunk that does not seal.
pub fn refs_of(
    vault: &Vault,
    keys: &BackupKeys,
    h: &PlaintextHash,
    len: u64,
    class: Class,
) -> Result<Option<Vec<Ref>>> {
    let mut hasher = blake3::Hasher::new();
    let mut refs = Vec::new();
    for index in 0..chunk_count(len) {
        let Some(bytes) = read_chunk(vault, h, index)? else {
            return Ok(None);
        };
        hasher.update(&bytes);
        refs.push(sealed::seal(keys, class, &bytes)?.reference());
    }
    if refs.is_empty() && open(vault, h)?.is_none() && len > 0 {
        return Ok(None);
    }
    Ok((hasher.finalize().as_bytes() == h.as_bytes()).then_some(refs))
}
