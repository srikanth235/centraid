//! WHAT THE VAULT HOLDS, BY KIND, as the Backup screen names it
//! ([#1144](https://github.com/srikanth235/centraid/issues/1144)): how many
//! rows of each kind, how many were written since a moment, which files are a
//! photograph's or a document's, and how big the vault file is.
//!
//! The kinds are the vault's; which app a kind belongs to is the phone core's
//! to say (`crates/core/src/phone/holdings.rs`). The SQL stays here because
//! SQL is confined to this crate.
//!
//! **Every read here plans through an index** (`crates/core/tests/query_plans.rs`):
//! the backup's status is read on every change event and every two seconds
//! while "Back up now" runs, so a read that walked a whole table would be a
//! cost that grows with the vault on the screen's path.

use std::collections::BTreeMap;

use super::naming::PlaintextHash;
use super::{Result, invariant};
use crate::file::Vault;

/// The kinds whose rows own a file: a photograph's or a document's original,
/// and every derivative made from one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FileOwner {
    Photo,
    Document,
}

/// What the vault holds, by kind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Holdings {
    /// Rows of each kind out of the trash, by `entity.kind`.
    pub live: BTreeMap<String, u64>,
    /// Rows of each kind written at or after the moment asked about, trash
    /// included: a row moved to the trash is an edit too. Empty when no moment
    /// was asked about.
    pub edited: BTreeMap<String, u64>,
    /// People in the visible circle, excluding the owner, pets and missing kind rows.
    /// Raw `live` counts remain intact for snapshot byte attribution.
    pub visible_people: u64,
    /// Workouts out of the trash.
    pub workouts: u64,
    /// Days with a reading for the vault's own person, and the readings.
    pub reading_days: u64,
    pub readings: u64,
    /// The file each photograph or document owns, and each derivative of one.
    /// A shared hash has one byte owner; this is not a count of visible items.
    pub owners: BTreeMap<PlaintextHash, FileOwner>,
    /// Original hashes referenced by each app's visible rows, with row multiplicity.
    /// One hash can appear in both apps and in several distinct document wrappers.
    pub original_items: BTreeMap<FileOwner, BTreeMap<PlaintextHash, u64>>,
    /// The vault file's pages: what a snapshot copies.
    pub file_bytes: u64,
}

/// Read what the vault holds. `since` is the moment, on the vault's own
/// timestamps (`YYYY-MM-DDTHH:MM:SS.mmmZ`), that [`Holdings::edited`] counts
/// from; a row written in that same millisecond counts as after it.
///
/// # Errors
/// [`super::PlaneError`] when the vault will not read, or a file row holds a
/// hash that is not 64 lowercase hex characters.
pub fn holdings(vault: &Vault, since: Option<&str>) -> Result<Holdings> {
    type Owned = (Vec<String>, Vec<String>, Vec<(String, String)>);
    let (
        live,
        edited,
        visible_people,
        workouts,
        (reading_days, readings),
        file_bytes,
        owned,
        originals,
    ) = vault.read(|connection| {
        let by_kind = |sql: &str, at: Option<&str>| -> rusqlite::Result<BTreeMap<String, u64>> {
            let mut statement = connection.prepare(sql)?;
            let read =
                |row: &rusqlite::Row<'_>| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?));
            let rows = match at {
                Some(at) => statement
                    .query_map([at], read)?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
                None => statement
                    .query_map([], read)?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            };
            Ok(rows
                .into_iter()
                .map(|(kind, count)| (kind, u64::try_from(count).unwrap_or(0)))
                .collect())
        };
        let live = by_kind(
            "SELECT kind, count(*) FROM entity WHERE deleted_at IS NULL GROUP BY kind",
            None,
        )?;
        let edited = match since {
            Some(at) => by_kind(
                "SELECT kind, count(*) FROM entity WHERE updated_at >= ?1 GROUP BY kind",
                Some(at),
            )?,
            None => BTreeMap::new(),
        };
        let visible_people: i64 = connection.query_row(
            "SELECT count(*) FROM entity e JOIN person p ON p.id = e.id
                  WHERE e.kind = 'person' AND e.deleted_at IS NULL
                    AND coalesce(p.form, '') != 'pet'
                    AND e.id IS NOT (SELECT self_id FROM vault WHERE id = 1)",
            [],
            |row| row.get(0),
        )?;
        let workouts: i64 = connection.query_row(
            "SELECT count(*) FROM entity e JOIN workout w ON w.id = e.id
                  WHERE e.kind = 'activity' AND e.deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        let readings: (i64, i64) = connection.query_row(
            "SELECT count(DISTINCT day), count(*) FROM measurement
                  WHERE person_id = (SELECT self_id FROM vault WHERE id = 1)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let page_count: i64 =
            connection.pragma_query_value(None, "page_count", |row| row.get(0))?;
        let page_size: i64 = connection.pragma_query_value(None, "page_size", |row| row.get(0))?;
        let column = |sql: &str| -> rusqlite::Result<Vec<String>> {
            let mut statement = connection.prepare(sql)?;
            let rows = statement.query_map([], |row| row.get(0))?;
            rows.collect()
        };
        let photos = column("SELECT blob FROM photo")?;
        let documents = column("SELECT blob FROM document")?;
        let originals = [
            (
                FileOwner::Photo,
                column(
                    "SELECT p.blob FROM entity e JOIN photo p ON p.id = e.id
                          WHERE e.kind = 'photo' AND e.deleted_at IS NULL",
                )?,
            ),
            (
                FileOwner::Document,
                column(
                    "SELECT d.blob FROM entity e JOIN document d ON d.id = e.id
                          WHERE e.kind = 'document' AND e.deleted_at IS NULL",
                )?,
            ),
        ];
        let derived = {
            let mut statement =
                connection.prepare("SELECT blob, out FROM derivative WHERE out IS NOT NULL")?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<(String, String)>>>()?
        };
        let owned: Owned = (photos, documents, derived);
        Ok((
            live,
            edited,
            visible_people,
            workouts,
            readings,
            page_count.saturating_mul(page_size),
            owned,
            originals,
        ))
    })?;
    let hash = |text: &str| {
        PlaintextHash::from_hex(text)
            .map_err(|_| invariant(format!("a file row's hash `{text}` cannot be named")))
    };
    let (photos, documents, derived) = owned;
    let mut owners = BTreeMap::new();
    for (texts, owner) in [(photos, FileOwner::Photo), (documents, FileOwner::Document)] {
        for text in texts {
            owners.insert(hash(&text)?, owner);
        }
    }
    // A DERIVATIVE IS ITS SOURCE'S: a photograph's thumbnail is Photos' bytes.
    for (source, out) in derived {
        if let Some(owner) = owners.get(&hash(&source)?).copied() {
            owners.insert(hash(&out)?, owner);
        }
    }
    let mut original_items: BTreeMap<FileOwner, BTreeMap<PlaintextHash, u64>> = BTreeMap::new();
    for (owner, texts) in originals {
        for text in texts {
            let count = original_items
                .entry(owner)
                .or_default()
                .entry(hash(&text)?)
                .or_default();
            *count = count.saturating_add(1);
        }
    }
    let count = |value: i64| u64::try_from(value).unwrap_or(0);
    Ok(Holdings {
        live,
        edited,
        visible_people: count(visible_people),
        workouts: count(workouts),
        reading_days: count(reading_days),
        readings: count(readings),
        owners,
        original_items,
        file_bytes: count(file_bytes),
    })
}
