//! What bytes this replica is missing (#1020, D-1020-B5).
//!
//! The seat holds rows long before it holds files: a `core_content_item` names
//! a photograph by hash, and a grid draws "not on this device yet" until the
//! bytes arrive. This module asks the replica's own tables which files it would
//! like, so the byte plane has something to plan over.
//!
//! ## Why the query is here and the planner is not
//!
//! SQL is confined to `crates/{ontology,vault,seat,search}` and
//! `crates/apps/kit`, and a seat's replica is this crate's. So the *finding* is
//! here. The *ordering* — tiers, recency, the window budget — is
//! `centraid_blobs::plan`, which is pure and has no database.
//!
//! The split also keeps iroh out of this crate. [`BlobNeed`] is four plain
//! fields; the caller maps them onto `centraid_blobs::Want` and fills in what
//! the local store already holds, which is the one fact SQL cannot answer.
//!
//! ## Derivatives are rows, originals are the item
//!
//! `core_content_derivative` holds `thumb`, `poster` and `preview` with their
//! own `sha256` and `byte_size`; `core_content_item` is the original. Two
//! queries and not a union, because the two carry different columns and a union
//! that papered over that would need a synthetic variant for the original —
//! which is exactly the kind of invented value that later gets stored.
//!
//! The `text`, `transcript`, `embedding`, `phash` and `thumbhash` variants are
//! deliberately absent: the schema's own CHECK says those carry `text_content`
//! and a NULL `sha256`, so they are already in the row and there is nothing to
//! fetch.

use rusqlite::Connection;

use crate::error::Result;

/// One blob the replica has a row for and may not have bytes for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobNeed {
    /// The `content_uri` for an original, or the bare hash for a derivative.
    /// The caller parses it; this crate does not know the URI scheme.
    pub locator: String,
    /// `None` for the original; otherwise the
    /// `core_content_derivative.variant`.
    pub variant: Option<String>,
    pub byte_size: i64,
    /// `created_at` as a sortable string. Compared, never parsed — the column
    /// is ISO-8601 with a fixed width, so lexical order is chronological order.
    pub created_at: String,
}

/// Every blob this replica has a row for, derivatives and originals.
///
/// **Not filtered by what is held** — that is the local byte store's answer and
/// this crate has no store. Returning everything and letting the planner drop
/// the satisfied ones keeps the one place that knows about holdings the one
/// place that decides.
///
/// Soft-deleted items are excluded. A row on its way to purge is not worth a
/// metered byte, and fetching it would race the purge.
pub fn needed_blobs(connection: &Connection, limit: usize) -> Result<Vec<BlobNeed>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let mut needs = Vec::new();

    // DERIVATIVES FIRST, and the `sha256 IS NOT NULL` is not belt and braces:
    // the text-bearing variants have a NULL hash by CHECK, and a row with no
    // hash is a row with nothing to fetch.
    let mut statement = connection.prepare(
        "SELECT d.sha256, d.variant, d.byte_size, d.created_at
           FROM core_content_derivative d
           JOIN core_content_item i ON i.content_id = d.content_id
          WHERE d.sha256 IS NOT NULL
            AND i.deleted_at IS NULL
          ORDER BY d.created_at DESC
          LIMIT ?1",
    )?;
    let rows = statement.query_map([limit], |row| {
        Ok(BlobNeed {
            locator: row.get(0)?,
            variant: Some(row.get(1)?),
            byte_size: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    for row in rows {
        needs.push(row?);
    }

    // THE ORIGINALS. `content_uri` and not `sha256`, because the URI carries
    // the hash's NAME and a `blob:sha256-` row must be refusable rather than
    // verified against the wrong function — which a bare hash column could not
    // express.
    let mut statement = connection.prepare(
        "SELECT content_uri, byte_size, created_at
           FROM core_content_item
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT ?1",
    )?;
    let rows = statement.query_map([limit], |row| {
        Ok(BlobNeed {
            locator: row.get(0)?,
            variant: None,
            byte_size: row.get(1)?,
            created_at: row.get(2)?,
        })
    })?;
    for row in rows {
        needs.push(row?);
    }
    Ok(needs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_replica_with_one_photograph() -> Connection {
        let connection = Connection::open_in_memory().expect("memory");
        connection
            .execute_batch(
                "CREATE TABLE core_content_item (
                   content_id TEXT PRIMARY KEY,
                   content_uri TEXT NOT NULL,
                   sha256 TEXT NOT NULL,
                   byte_size INTEGER NOT NULL,
                   deleted_at TEXT,
                   created_at TEXT NOT NULL);
                 CREATE TABLE core_content_derivative (
                   derivative_id TEXT PRIMARY KEY,
                   content_id TEXT NOT NULL,
                   variant TEXT NOT NULL,
                   sha256 TEXT,
                   byte_size INTEGER NOT NULL,
                   text_content TEXT,
                   created_at TEXT NOT NULL);
                 INSERT INTO core_content_item VALUES
                   ('c1','blob:blake3-aa','aa',9000000,NULL,'2026-01-02T00:00:00Z'),
                   ('c2','blob:blake3-bb','bb',8000000,'2026-01-03T00:00:00Z','2026-01-01T00:00:00Z');
                 INSERT INTO core_content_derivative VALUES
                   ('d1','c1','thumb','cc',9000,NULL,'2026-01-02T00:00:00Z'),
                   ('d2','c1','phash',NULL,0,'abc','2026-01-02T00:00:00Z'),
                   ('d3','c2','thumb','dd',9000,NULL,'2026-01-01T00:00:00Z');",
            )
            .expect("the fixture builds");
        connection
    }

    #[test]
    fn a_soft_deleted_item_and_its_derivatives_are_not_wanted() {
        let connection = a_replica_with_one_photograph();
        let needs = needed_blobs(&connection, 100).expect("the query runs");
        let locators: Vec<&str> = needs.iter().map(|need| need.locator.as_str()).collect();
        assert!(locators.contains(&"blob:blake3-aa"));
        assert!(locators.contains(&"cc"));
        // c2 is soft-deleted: neither it nor its thumbnail is worth a byte.
        assert!(!locators.contains(&"blob:blake3-bb"), "{locators:?}");
        assert!(!locators.contains(&"dd"), "{locators:?}");
    }

    /// A `phash` has its value IN the row. Asking the network for it would be
    /// asking for something that is already here.
    #[test]
    fn a_text_bearing_derivative_is_not_a_blob() {
        let connection = a_replica_with_one_photograph();
        let needs = needed_blobs(&connection, 100).expect("the query runs");
        assert!(
            needs
                .iter()
                .all(|need| need.variant.as_deref() != Some("phash")),
            "{needs:?}"
        );
    }

    /// The original is named by its URI and not its bare hash, so the hash
    /// FUNCTION travels with it.
    #[test]
    fn an_original_carries_its_uri() {
        let connection = a_replica_with_one_photograph();
        let needs = needed_blobs(&connection, 100).expect("the query runs");
        let original = needs
            .iter()
            .find(|need| need.variant.is_none())
            .expect("an original");
        assert!(original.locator.starts_with("blob:"), "{original:?}");
    }
}
