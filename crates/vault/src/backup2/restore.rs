//! Restore: a vault file rebuilt from a destination, and every check that it
//! is the file the snapshot took (#1080, "Restore").
//!
//! ```text
//! fetch the manifest by the head's name   open it; its name must derive from its bytes
//! fetch the ranges, 1,000 names a fetch   open each; its name must derive from its bytes
//! write it at i × 64 KiB                  truncate to db_len
//! db_hash                                 BLAKE3 of the whole file, against the manifest
//! integrity_check, page_size, user_version
//! census                                  table by table, against the manifest
//! ```
//!
//! The ranges come back through [`Store::get_many`], the protocol's `fetch`
//! (the root's ruling A15): a snapshot is hundreds of 64 KiB ranges, and one
//! request each would be hundreds of round trips. A fetch answers a name once,
//! and two ranges with the same bytes have one name, so each answer is written
//! at every index that names it.
//!
//! Every check refuses with a [`RestoreError`] naming the check or the table,
//! and a refused restore leaves nothing at the output path: the file is built
//! as `<out>.partial` and renamed only when every check passed. It never opens
//! the file through the ladder — the caller does, with `Vault::open`, which
//! migrates a file a newer build reads.
//!
//! **The checks are about rows, not only pages.** `integrity_check` speaks
//! about the b-tree, and a perfect file with nobody's rows in it passes it;
//! the census is what says the rows came back.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use centraid_media::sealed;

use super::PlaneError;
use super::naming::{BackupKeys, Name, PlaintextHash};
use super::snapshot::{Manifest, RANGE_BYTES, RangeRef, census_of, read_copy};
use super::store::{NAMES_PER_CALL, Store, StoreError};
use crate::migrations::APPLICATION_ID;

/// Why a restore refused the file.
#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    #[error("{0} already exists; a restore never writes over a file")]
    Exists(PathBuf),
    #[error("the destination has no head: nothing to restore")]
    NoHead,
    #[error(transparent)]
    Plane(#[from] PlaneError),
    #[error("the manifest: {0}")]
    Manifest(String),
    #[error("range {i}: {reason}")]
    Range { i: u32, reason: String },
    #[error("db_hash: the restored file is not the file the snapshot took")]
    DbHash,
    #[error("integrity_check: {0}")]
    Integrity(String),
    #[error("{check}: the manifest says {expected} and the restored file says {found}")]
    Header {
        check: &'static str,
        expected: i64,
        found: i64,
    },
    #[error(
        "census: {table}: the manifest says {expected:?} rows and the restored file holds {found:?}"
    )]
    Census {
        table: String,
        expected: Option<i64>,
        found: Option<i64>,
    },
}

impl From<StoreError> for RestoreError {
    fn from(error: StoreError) -> Self {
        Self::Plane(error.into())
    }
}

impl From<std::io::Error> for RestoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Plane(error.into())
    }
}

/// One check that passed, for the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: &'static str,
    pub detail: String,
}

/// A restored file, every check passed.
#[derive(Debug, Clone)]
pub struct Restored {
    pub manifest: Manifest,
    pub manifest_name: Name,
    pub path: PathBuf,
    pub checks: Vec<Check>,
}

fn fetch(store: &dyn Store, name: &Name) -> Result<Vec<u8>, StoreError> {
    let mut bytes = Vec::new();
    store.get(name, &mut bytes)?;
    Ok(bytes)
}

fn partial_of(out_path: &Path) -> PathBuf {
    let mut partial = out_path.as_os_str().to_owned();
    partial.push(".partial");
    PathBuf::from(partial)
}

/// Restore the snapshot the destination's head names.
///
/// # Errors
/// [`RestoreError::NoHead`] for a destination that never registered one, and
/// everything [`fetch_and_assemble`] refuses.
pub fn restore_head(
    store: &dyn Store,
    keys: &BackupKeys,
    out_path: &Path,
) -> Result<Restored, RestoreError> {
    let head = store.head()?.ok_or(RestoreError::NoHead)?;
    fetch_and_assemble(store, keys, &head.name, out_path)
}

/// Fetch the snapshot whose manifest is `head_name`, rebuild the vault file at
/// `out_path`, and check it.
///
/// # Errors
/// An existing `out_path`; a manifest or range that is missing, does not open
/// or is not the file its name derives from; and every check in this module's
/// header.
pub fn fetch_and_assemble(
    store: &dyn Store,
    keys: &BackupKeys,
    head_name: &Name,
    out_path: &Path,
) -> Result<Restored, RestoreError> {
    if out_path.exists() {
        return Err(RestoreError::Exists(out_path.to_path_buf()));
    }
    let partial = partial_of(out_path);
    let outcome = rebuild(store, keys, head_name, &partial);
    match outcome {
        Ok((manifest, checks)) => {
            fs::rename(&partial, out_path)?;
            Ok(Restored {
                manifest,
                manifest_name: *head_name,
                path: out_path.to_path_buf(),
                checks,
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&partial);
            Err(error)
        }
    }
}

/// Fetch every range the manifest names and write each at `i × 64 KiB`.
fn write_ranges(
    store: &dyn Store,
    keys: &BackupKeys,
    manifest: &Manifest,
    file: &mut File,
) -> Result<(), RestoreError> {
    let mut at: BTreeMap<Name, Vec<&RangeRef>> = BTreeMap::new();
    let mut order: Vec<Name> = Vec::new();
    for range in &manifest.ranges {
        let indices = at.entry(range.name).or_default();
        if indices.is_empty() {
            order.push(range.name);
        }
        indices.push(range);
    }
    let mut written: BTreeSet<Name> = BTreeSet::new();
    let mut refused: Option<RestoreError> = None;
    for batch in order.chunks(NAMES_PER_CALL) {
        let fetched = store.get_many(batch, &mut |name, sealed_bytes| {
            let Some(ranges) = at.get(name).filter(|_| !written.contains(name)) else {
                return Ok(());
            };
            let refuse = |refused: &mut Option<RestoreError>, i: u32, reason: String| {
                *refused = Some(RestoreError::Range { i, reason });
                std::io::Error::other("a range was refused")
            };
            let first = ranges.first().map_or(0, |range| range.i);
            let plaintext = sealed::open_whole(keys, name, sealed_bytes)
                .map_err(|error| refuse(&mut refused, first, error.to_string()))?;
            for range in ranges {
                if plaintext.len() as u64 != range.len {
                    return Err(refuse(
                        &mut refused,
                        range.i,
                        format!(
                            "{} bytes where the manifest says {}",
                            plaintext.len(),
                            range.len
                        ),
                    ));
                }
                file.seek(SeekFrom::Start(u64::from(range.i) * RANGE_BYTES))?;
                file.write_all(&plaintext)?;
            }
            written.insert(*name);
            Ok(())
        });
        if let Some(error) = refused.take() {
            return Err(error);
        }
        fetched?;
    }
    // A name the fetch did not hand back is one the destination does not
    // hold; the lowest range it names is reported.
    if let Some(name) = order.iter().find(|name| !written.contains(*name)) {
        let i = at
            .get(name)
            .and_then(|ranges| ranges.first())
            .map_or(0, |range| range.i);
        return Err(RestoreError::Range {
            i,
            reason: format!("the destination does not hold {name}"),
        });
    }
    Ok(())
}

fn rebuild(
    store: &dyn Store,
    keys: &BackupKeys,
    head_name: &Name,
    partial: &Path,
) -> Result<(Manifest, Vec<Check>), RestoreError> {
    let mut checks = Vec::new();

    let manifest_bytes = fetch(store, head_name)?;
    let json = sealed::open_whole(keys, head_name, &manifest_bytes)
        .map_err(|error| RestoreError::Manifest(error.to_string()))?;
    let manifest =
        Manifest::from_json(&json).map_err(|error| RestoreError::Manifest(error.to_string()))?;
    checks.push(Check {
        name: "manifest",
        detail: format!(
            "{} ranges, {} bytes, taken at {}",
            manifest.ranges.len(),
            manifest.db_len,
            manifest.taken_at_ms
        ),
    });

    let mut file = File::create(partial)?;
    write_ranges(store, keys, &manifest, &mut file)?;
    file.set_len(manifest.db_len)?;
    file.sync_all()?;
    drop(file);
    checks.push(Check {
        name: "ranges",
        detail: format!("{} ranges opened under their names", manifest.ranges.len()),
    });

    let mut hasher = blake3::Hasher::new();
    let mut reader = File::open(partial)?;
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    drop(reader);
    if PlaintextHash::from_bytes(*hasher.finalize().as_bytes()) != manifest.db_hash {
        return Err(RestoreError::DbHash);
    }
    checks.push(Check {
        name: "db_hash",
        detail: manifest.db_hash.to_hex(),
    });

    let (integrity, page_size, user_version, application_id, census) =
        read_copy(partial, |connection| {
            let integrity: String =
                connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
            let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
            let user_version: i64 =
                connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            let application_id: i64 =
                connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
            Ok((
                integrity,
                page_size,
                user_version,
                application_id,
                census_of(connection)?,
            ))
        })?;
    if integrity != "ok" {
        return Err(RestoreError::Integrity(integrity));
    }
    checks.push(Check {
        name: "integrity_check",
        detail: integrity,
    });
    for (check, expected, found) in [
        ("application_id", APPLICATION_ID, application_id),
        ("page_size", i64::from(manifest.page_size), page_size),
        ("user_version", manifest.user_version, user_version),
    ] {
        if expected != found {
            return Err(RestoreError::Header {
                check,
                expected,
                found,
            });
        }
    }
    checks.push(Check {
        name: "header",
        detail: format!("page_size {page_size}, user_version {user_version}"),
    });

    let tables: BTreeSet<&String> = manifest.census.keys().chain(census.keys()).collect();
    for table in tables {
        let expected = manifest.census.get(table).copied();
        let found = census.get(table).copied();
        if expected != found {
            return Err(RestoreError::Census {
                table: table.clone(),
                expected,
                found,
            });
        }
    }
    checks.push(Check {
        name: "census",
        detail: format!(
            "{} tables, {} rows",
            census.len(),
            census.values().sum::<i64>()
        ),
    });
    Ok((manifest, checks))
}
