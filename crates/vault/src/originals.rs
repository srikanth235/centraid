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
//! ## WHAT THIS DOES NOT COUNT, AND WHY THAT IS THE POINT
//!
//! There is no `freeable` total here. v0 offered to delete a phone's originals
//! only where a copy elsewhere was PROVED (`selectFreeUpCandidates`: a settled
//! `casAck` and a verified hash), and the honest version of that number on this
//! device is not zero — it is **not a number anybody can compute**: the drain
//! uploads the vault's pages, never an original's bytes (`crates/core/src/phone/drain.rs`
//! seals bases, segments and manifests; nothing outside the restore drill calls
//! `backup::custody::admit`). A total over a predicate that no byte can satisfy
//! would be a field that is always zero and reads as a finding. So the census
//! reports what is true — what is here, and what is kept — and the proof that
//! would make an original releasable is a missing plane, named in
//! `docs/decisions.md` (R-1029-PH-1), not a zero.
//!
//! ## THE KEPT JOIN IS BY ALBUM MEMBERSHIP, AND ONLY A PHOTOGRAPH'S
//!
//! `core_collection_entry.target_type` is polymorphic; only `media.asset` is a
//! photograph (v0's `protectedAssetIdsFromPins` made the same cut). v0 also had
//! to reach every identity a SHA-merged row answered to, because its timeline
//! folded a device copy and a vault copy into one row. This vault has one row
//! per set of bytes — `core_content_item.content_hash` is UNIQUE and
//! `media_asset.content_id` is UNIQUE — so the asset id IS the identity and
//! there is nothing to fold.

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
            "SELECT c.content_hash, c.byte_size,
                    EXISTS (SELECT 1 FROM core_collection_entry e
                             WHERE e.target_type = 'media.asset'
                               AND e.target_id = a.asset_id
                               AND e.collection_id IN (SELECT value FROM json_each(?1)))
               FROM media_asset a
               JOIN core_content_item c ON c.content_id = a.content_id
              WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL",
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
