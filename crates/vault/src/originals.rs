//! THE ORIGINALS THIS DEVICE HOLDS, AND THE SHARE OF THEM A MEMBER KEPT
//! (#1029, the photos port — v0's `photos-library-pins.ts` and
//! `free-up-space.ts`).
//!
//! One question, asked of two places at once: which photographs' ORIGINAL
//! bytes are whole in this device's content store, and how many of those sit in
//! an album the member said to keep on this phone. The rows say which bytes are
//! an original and which album holds them; the store says whether the bytes are
//! here. Neither can answer alone, and the SQL half stays in this crate because
//! SQL is confined to it (`sql-confinement`).
//!
//! ## WHAT THIS DOES NOT COUNT
//!
//! There is no `freeable` total here. v0 offered to delete a phone's originals
//! only where a copy elsewhere was PROVED (`selectFreeUpCandidates`: a settled
//! `casAck` and a verified hash), and the proof on this device is a gateway's
//! acknowledgement of every part of an original, which the backup ledger
//! records and the vault never sees (#1080 ruling 7). So the releasable
//! originals are the phone core's answer over that ledger
//! (`crates/core/src/phone`, the `releasable` door), and this module gives it
//! the two facts only the rows hold: which originals sit in a kept album
//! ([`kept_hashes`]), and which asset rows a set of bytes belongs to
//! ([`assets_for_hashes`]).
//!
//! ## THE KEPT JOIN IS BY ALBUM MEMBERSHIP
//!
//! An album holds a photograph by a `contains` edge, and `edge_shape` allows no
//! other kind into an album, so the join needs no type test. A photograph's
//! `blob` is UNIQUE, so the photograph's id IS the identity of its bytes and
//! there is nothing to fold ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//! The Photos lane owns what an original means beyond these four questions.

use std::collections::BTreeSet;

use crate::error::Result;
use crate::file::Vault;

/// A count and the bytes it adds up to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    pub count: u64,
    pub bytes: u64,
}

impl Totals {
    const fn add(self, bytes: u64) -> Self {
        Self {
            count: self.count + 1,
            bytes: self.bytes + bytes,
        }
    }
}

/// What [`census`] found.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OriginalsCensus {
    /// Every live photograph whose original is whole on this device.
    pub on_device: Totals,
    /// The part of [`Self::on_device`] that is in at least one kept album.
    /// Counted once however many kept albums hold it.
    pub kept: Totals,
}

/// **Count the originals on this device, and the kept share of them.**
///
/// `kept_albums` is the member's list of albums whose originals stay on this
/// phone. An id naming no album — one deleted since, whose pin outlived it so a
/// restore brings the promise back with the album — matches no entry and
/// changes nothing.
///
/// `Ok(None)` when no content store is attached: a vault with no byte door
/// cannot say what is on the disk, and "0 originals here" would be a claim
/// about a store nobody asked. A shell draws that as "not counted", never as
/// zero.
///
/// **Live rows only.** A trashed photograph's bytes are still here until the
/// purge takes them, and that purge is the trash's own promise with its own
/// window; counting them here would offer the same bytes to two verbs.
///
/// # Errors
/// [`crate::error::VaultError`] for anything SQLite refused, or a store that
/// could not list what it holds.
pub fn census(vault: &Vault, kept_albums: &BTreeSet<String>) -> Result<Option<OriginalsCensus>> {
    let Some(store) = vault.blobs() else {
        return Ok(None);
    };
    // ONE LISTING AND NOT ONE LOOKUP PER ROW. A camera roll is tens of
    // thousands of photographs, and `ids()` is one round trip to the store's
    // actor where `has()` per row would be one each.
    let held = store
        .ids()
        .map_err(|error| crate::error::VaultError::Invariant {
            context: format!("the content store could not list what it holds: {error}"),
        })?;
    let kept_json = serde_json::to_string(&kept_albums.iter().collect::<Vec<_>>())
        .unwrap_or_else(|_| "[]".to_owned());
    let rows: Vec<(String, i64, bool)> = vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT p.blob, b.size,
                    EXISTS (SELECT 1 FROM edge g
                             WHERE g.rel = 'contains' AND g.to_id = p.id
                               AND g.from_id IN (SELECT value FROM json_each(?1)))
               FROM photo p
               JOIN entity e ON e.id = p.id
               JOIN blob b ON b.hash = p.blob
              WHERE e.deleted_at IS NULL",
        )?;
        let rows = statement.query_map([kept_json], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    let mut census = OriginalsCensus::default();
    for (hash, bytes, kept) in rows {
        if !held.contains(&hash) {
            continue;
        }
        let bytes = u64::try_from(bytes).unwrap_or(0);
        census.on_device = census.on_device.add(bytes);
        if kept {
            census.kept = census.kept.add(bytes);
        }
    }
    Ok(Some(census))
}

/// The content hashes of every live photograph in at least one of
/// `kept_albums`: originals the member said to keep on this phone, which no
/// verb may offer to delete from it.
///
/// # Errors
/// [`crate::error::VaultError`] for anything SQLite refused.
pub fn kept_hashes(vault: &Vault, kept_albums: &BTreeSet<String>) -> Result<BTreeSet<String>> {
    if kept_albums.is_empty() {
        return Ok(BTreeSet::new());
    }
    let kept_json = serde_json::to_string(&kept_albums.iter().collect::<Vec<_>>())
        .unwrap_or_else(|_| "[]".to_owned());
    vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT DISTINCT p.blob
               FROM photo p
               JOIN entity e ON e.id = p.id
               JOIN edge g ON g.rel = 'contains' AND g.to_id = p.id
              WHERE e.deleted_at IS NULL
                AND g.from_id IN (SELECT value FROM json_each(?1))",
        )?;
        let rows = statement.query_map([kept_json], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<BTreeSet<_>>>()?)
    })
}

/// The asset rows whose bytes are any of `hashes` (64 lowercase hex each),
/// live or trashed: the ids a grid is keyed by, for the change event that
/// tells it bytes arrived or left (`ChangeFeed::blobs_arrived`).
///
/// # Errors
/// [`crate::error::VaultError`] for anything SQLite refused.
pub fn assets_for_hashes(vault: &Vault, hashes: &[String]) -> Result<Vec<String>> {
    if hashes.is_empty() {
        return Ok(Vec::new());
    }
    let hashes_json = serde_json::to_string(hashes).unwrap_or_else(|_| "[]".to_owned());
    vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT p.id FROM photo p
              WHERE p.blob IN (SELECT value FROM json_each(?1))
              ORDER BY p.id",
        )?;
        let rows = statement.query_map([hashes_json], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// The LIVE asset wrapping each of `hashes` (64 lowercase hex each), as
/// `(hash, asset_id)`: a trashed asset is not an answer, and neither is a hash
/// the vault holds no content row for (#1127, A20 — an edit made in place
/// names the asset it is an edit of, and a trashed or absent one is not
/// something to name).
///
/// # Errors
/// [`crate::error::VaultError`] for anything SQLite refused.
pub fn live_assets_for_hashes(vault: &Vault, hashes: &[String]) -> Result<Vec<(String, String)>> {
    if hashes.is_empty() {
        return Ok(Vec::new());
    }
    let hashes_json = serde_json::to_string(hashes).unwrap_or_else(|_| "[]".to_owned());
    vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT p.blob, p.id
               FROM photo p
               JOIN entity e ON e.id = p.id
              WHERE e.deleted_at IS NULL
                AND p.blob IN (SELECT value FROM json_each(?1))
              ORDER BY p.id",
        )?;
        let rows = statement.query_map([hashes_json], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}
