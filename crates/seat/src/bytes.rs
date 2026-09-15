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
//! own `content_hash` and `byte_size`; `core_content_item` is the original. Two
//! queries and not a union, because the two carry different columns and a union
//! that papered over that would need a synthetic variant for the original —
//! which is exactly the kind of invented value that later gets stored.
//!
//! The `text`, `transcript`, `embedding`, `phash` and `thumbhash` variants are
//! deliberately absent: the schema's own CHECK says those carry `text_content`
//! and a NULL `content_hash`, so they are already in the row and there is nothing to
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
    /// THESE BYTES ARE A MOVING IMAGE (#1025 S4).
    ///
    /// Read off `core_content_representation.media_type` — ANY `video/*`
    /// reading of these bytes — and never off the `media_asset.kind` a screen
    /// draws: this plane is content
    /// and not assets, and a document's attached clip is as much a video as a
    /// camera roll's is.
    ///
    /// The one distinction the member's transfer rule draws inside the
    /// originals tier, and false for every derivative: a video's POSTER is a
    /// thumbnail, costs kilobytes and crosses on any link, which is what puts
    /// the video's cell in the grid at all.
    ///
    /// **A CONTENT NOTHING STATES A READING FOR IS NOT MOVING.** A row with no
    /// representation is handled by whichever rule covers photographs, which
    /// fails towards a member getting their file rather than towards silence —
    /// and a file with no stated reading is not a 900 MB clip by default.
    pub moving: bool,
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

    // DERIVATIVES FIRST, and the `content_hash IS NOT NULL` is not belt and braces:
    // the text-bearing variants have a NULL hash by CHECK, and a row with no
    // hash is a row with nothing to fetch.
    let mut statement = connection.prepare(
        "SELECT d.content_hash, d.variant, d.byte_size, d.created_at
           FROM core_content_derivative d
           JOIN core_content_item i ON i.content_id = d.content_id
          WHERE d.content_hash IS NOT NULL
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
            // A DERIVATIVE IS NEVER "MOVING", whatever it is a derivative OF.
            // A video's poster is a still frame of a few kilobytes and is the
            // grid; the rule that withholds videos on a metered link is about
            // the ORIGINAL and must not reach past it.
            moving: false,
        })
    })?;
    for row in rows {
        needs.push(row?);
    }

    // THE ORIGINALS. `content_uri` and not `content_hash`, because the URI carries
    // the hash's NAME: `blob:blake3-<hex>` is the one form this plane addresses
    // (#1025 S3, D-1025-S3-3) and a value that is not it is a row with nothing
    // to fetch, which a bare hash column could not express.
    let mut statement = connection.prepare(
        // THE READING IS ON THE REPRESENTATION, NOT ON THE ITEM (#1025 S4).
        // `core_content_item` carries a hash, a size and a URI and no media
        // type at all — what a set of bytes IS READ AS is
        // `core_content_representation.media_type`, one row per owner, because
        // a representation exists because something is being read as something.
        //
        // A CORRELATED EXISTS AND NOT A JOIN, for the reason the grid's
        // thumbnail column gives: one content may have several
        // representations, and a join would multiply the row and hand the
        // planner the same original several times over.
        //
        // ANY reading being a video makes it moving. A file two owners read
        // two ways is still the same 900 MB, and the rule that withholds it
        // must not be escaped by the second owner's reading.
        "SELECT i.content_uri, i.byte_size, i.created_at,
                EXISTS (SELECT 1 FROM core_content_representation r
                         WHERE r.content_id = i.content_id
                           AND r.media_type LIKE 'video/%')
           FROM core_content_item i
          WHERE i.deleted_at IS NULL
          ORDER BY i.created_at DESC
          LIMIT ?1",
    )?;
    let rows = statement.query_map([limit], |row| {
        Ok(BlobNeed {
            locator: row.get(0)?,
            variant: None,
            byte_size: row.get(1)?,
            created_at: row.get(2)?,
            moving: row.get::<_, i64>(3)? != 0,
        })
    })?;
    for row in rows {
        needs.push(row?);
    }
    Ok(needs)
}

/// DOES THIS DEVICE ALREADY HOLD THESE BYTES? (#1025 S5.)
///
/// The question `bytes.fetch` asks before it asks anything else: a second tap
/// on a photograph this device has is nothing to do, and answering it as a
/// no-op BY CODE rather than by running a window that plans nothing is what
/// keeps "nothing happened" from meaning two different things.
///
/// `seat_blob_held` is this crate's own table, written in the window a blob
/// completes and released in the window the sweep forgets one
/// (D-1025-S7-20) — so it is the same truth the grid's `thumbnail_path`
/// column reads, and the two cannot disagree.
pub fn holds(connection: &Connection, hash: &str) -> Result<bool> {
    crate::held::open(connection)?;
    let held: i64 = connection.query_row(
        "SELECT COUNT(*) FROM seat_blob_held WHERE content_hash = ?1",
        [hash],
        |row| row.get(0),
    )?;
    Ok(held > 0)
}

/// DOES THIS REPLICA HAVE A ROW NAMING THESE BYTES? (#1025 S5.)
///
/// The other half of `bytes.fetch`'s refusal, and it is a different answer
/// from [`holds`]: a hash this replica has never heard of is a member tapping
/// a cell that is not theirs, or a shell that has drifted from its own read,
/// and either way the honest answer is a code and not an empty window.
///
/// Both sides of the join, for the reason `asset_rows_for` gives: an original
/// is named by `content_uri` (`blob:blake3-<hex>`) and a derivative by a bare
/// `content_hash`, and a member may tap either.
pub fn knows(connection: &Connection, hash: &str) -> Result<bool> {
    let uri = format!("blob:blake3-{hash}");
    let known: i64 = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM core_content_item
                  WHERE content_uri = ?1 AND deleted_at IS NULL)
              + (SELECT COUNT(*) FROM core_content_derivative d
                   JOIN core_content_item i ON i.content_id = d.content_id
                  WHERE d.content_hash = ?2 AND i.deleted_at IS NULL)",
        rusqlite::params![uri, hash],
        |row| row.get(0),
    )?;
    Ok(known > 0)
}

/// THE ASSET ROWS A SET OF ARRIVED BLOBS BELONGS TO (#1025 S5, rewritten for
/// the "a landed byte is a row" ruling, D-1025-S7-20).
///
/// `hashes` are lowercase-hex content hashes the byte plane has just completed;
/// the answer is the `media_asset.asset_id` of every row those bytes belong to,
/// deduplicated, in a stable order.
///
/// **Why this exists.** 19 photographs landed on a device and nothing on the
/// screen moved: no ROW changed, so no change event fired, and the member read
/// "not on this device yet" over a device that had them. A blob arriving asks a
/// screen exactly the question a row changing asks — *do I need to re-read?* —
/// and the only thing missing was the join from a hash back to the rows that
/// name it.
///
/// **ASSET IDS AND NOT CONTENT IDS**, which is the whole of the change: a grid
/// is keyed by asset id, so the ids the core pushes have to be the ids the grid
/// compares against. They used to be `core_content_item.content_id`, which
/// matched nothing a screen was showing — and the compensation was an event
/// type of its own (`BytesArrived`) whose only instruction was "re-read
/// everything". With the ids right, a landed byte is an ordinary `RowsChanged`
/// over `media_asset` and there is no second event kind for a shell to learn.
///
/// BOTH SIDES OF THE JOIN. An original is named by `content_uri`
/// (`blob:blake3-<hex>`, the one form this plane addresses) and a derivative by
/// `core_content_derivative.content_hash`, which is a bare hash; a thumbnail
/// arriving changes the same cell as its original, so both map to the asset
/// that owns the content.
///
/// **Bytes no asset owns answer nothing**, and that is honest rather than a
/// gap: a document's attachment landing moves no photo grid, and the screen it
/// does move will ask for its own join when it has one.
pub fn asset_rows_for(connection: &Connection, hashes: &[String]) -> Result<Vec<String>> {
    let mut found: Vec<String> = Vec::new();
    // ONE STATEMENT PER HASH rather than an `IN` list built by formatting: a
    // list spliced into SQL is the shape injection takes, and a completed-blob
    // set is at most a window's worth of items.
    let mut by_uri = connection.prepare(
        "SELECT a.asset_id
           FROM media_asset a
           JOIN core_content_item i ON i.content_id = a.content_id
          WHERE i.content_uri = ?1 AND i.deleted_at IS NULL AND a.deleted_at IS NULL",
    )?;
    let mut by_derivative = connection.prepare(
        "SELECT a.asset_id
           FROM core_content_derivative d
           JOIN core_content_item i ON i.content_id = d.content_id
           JOIN media_asset a ON a.content_id = i.content_id
          WHERE d.content_hash = ?1 AND i.deleted_at IS NULL AND a.deleted_at IS NULL",
    )?;
    for hash in hashes {
        let uri = format!("blob:blake3-{hash}");
        for id in by_uri.query_map([&uri], |row| row.get::<_, String>(0))? {
            let id = id?;
            if !found.contains(&id) {
                found.push(id);
            }
        }
        for id in by_derivative.query_map([hash], |row| row.get::<_, String>(0))? {
            let id = id?;
            if !found.contains(&id) {
                found.push(id);
            }
        }
    }
    Ok(found)
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
                   content_hash TEXT NOT NULL,
                   byte_size INTEGER NOT NULL,
                   deleted_at TEXT,
                   created_at TEXT NOT NULL);
                 CREATE TABLE core_content_derivative (
                   derivative_id TEXT PRIMARY KEY,
                   content_id TEXT NOT NULL,
                   variant TEXT NOT NULL,
                   content_hash TEXT,
                   byte_size INTEGER NOT NULL,
                   text_content TEXT,
                   created_at TEXT NOT NULL);
                 INSERT INTO core_content_item VALUES
                   ('c1','blob:blake3-aa','aa',9000000,NULL,'2026-01-02T00:00:00Z'),
                   ('c2','blob:blake3-bb','bb',8000000,'2026-01-03T00:00:00Z','2026-01-01T00:00:00Z'),
                   ('c3','blob:blake3-ee','ee',900000000,NULL,'2026-01-04T00:00:00Z');
                 -- WHAT THE BYTES ARE READ AS lives here and not on the item
                 -- (#1025 S4). `c3` is a clip; `c1` is a photograph; nothing
                 -- states a reading for `c2`.
                 CREATE TABLE core_content_representation (
                   representation_id TEXT PRIMARY KEY,
                   content_id TEXT NOT NULL,
                   media_type TEXT NOT NULL);
                 INSERT INTO core_content_representation VALUES
                   ('r1','c1','image/jpeg'),
                   ('r3','c3','video/quicktime');
                 CREATE TABLE media_asset (
                   asset_id TEXT PRIMARY KEY,
                   content_id TEXT NOT NULL,
                   deleted_at TEXT);
                 INSERT INTO core_content_derivative VALUES
                   ('d1','c1','thumb','cc',9000,NULL,'2026-01-02T00:00:00Z'),
                   ('d2','c1','phash',NULL,0,'abc','2026-01-02T00:00:00Z'),
                   ('d3','c2','thumb','dd',9000,NULL,'2026-01-01T00:00:00Z');
                 INSERT INTO media_asset VALUES
                   ('a1','c1',NULL),
                   ('a2','c2','2026-01-03T00:00:00Z'),
                   ('a3','c3',NULL);",
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

    /// THE ONE DISTINCTION THE MEMBER'S TRANSFER RULE DRAWS (#1025 S4).
    ///
    /// A clip's original is `moving` and a photograph's is not, and the
    /// reading comes off `core_content_representation` — the only table that
    /// states one. **A THUMBNAIL IS NEVER MOVING**, whatever it is a thumbnail
    /// of: a video's poster is a still frame of a few kilobytes and is the
    /// grid, and a rule that reached past the original would leave a video's
    /// cell blank on every metered link.
    #[test]
    fn a_video_original_is_moving_and_its_thumbnail_is_not() {
        let connection = a_replica_with_one_photograph();
        let needs = needed_blobs(&connection, 100).expect("the query runs");
        let moving_of = |locator: &str| {
            needs
                .iter()
                .find(|need| need.locator == locator)
                .map(|need| need.moving)
        };
        assert_eq!(moving_of("blob:blake3-ee"), Some(true), "{needs:?}");
        assert_eq!(moving_of("blob:blake3-aa"), Some(false), "{needs:?}");
        // The photograph's `thumb`, by its bare hash.
        assert_eq!(moving_of("cc"), Some(false), "{needs:?}");
    }

    /// A CONTENT NOTHING STATES A READING FOR IS NOT MOVING. The failure mode
    /// of an unstated type is a file that arrives, not a 900 MB clip assumed
    /// into a member's data plan — and the rule that covers photographs is the
    /// one that then covers it.
    #[test]
    fn a_content_with_no_stated_reading_is_not_moving() {
        let connection = Connection::open_in_memory().expect("memory");
        connection
            .execute_batch(
                "CREATE TABLE core_content_item (
                   content_id TEXT PRIMARY KEY,
                   content_uri TEXT NOT NULL,
                   content_hash TEXT NOT NULL,
                   byte_size INTEGER NOT NULL,
                   deleted_at TEXT,
                   created_at TEXT NOT NULL);
                 CREATE TABLE core_content_derivative (
                   derivative_id TEXT PRIMARY KEY,
                   content_id TEXT NOT NULL,
                   variant TEXT NOT NULL,
                   content_hash TEXT,
                   byte_size INTEGER NOT NULL,
                   text_content TEXT,
                   created_at TEXT NOT NULL);
                 CREATE TABLE core_content_representation (
                   representation_id TEXT PRIMARY KEY,
                   content_id TEXT NOT NULL,
                   media_type TEXT NOT NULL);
                 INSERT INTO core_content_item VALUES
                   ('c1','blob:blake3-aa','aa',9000,NULL,'2026-01-02T00:00:00Z');",
            )
            .expect("the fixture builds");
        let needs = needed_blobs(&connection, 100).expect("the query runs");
        assert_eq!(needs.len(), 1);
        assert!(!needs[0].moving);
    }

    /// `seat_blob_held` ANSWERS THE FETCH COMMAND'S FIRST TWO QUESTIONS
    /// (#1025 S5), and they are different questions: a hash this device holds
    /// is a no-op, and a hash this replica never heard of is a refusal. A
    /// window that planned nothing would look identical for both.
    #[test]
    fn holds_and_knows_are_two_different_answers() {
        let connection = a_replica_with_one_photograph();
        crate::held::open(&connection).expect("the held table");
        // KNOWN BY BOTH SIDES OF THE JOIN: `aa` is an original's hash and `cc`
        // is a derivative's, and a member may tap either.
        assert!(knows(&connection, "aa").expect("the join runs"));
        assert!(knows(&connection, "cc").expect("the join runs"));
        // A soft-deleted item's bytes are not worth a metered byte and are not
        // known to this command either.
        assert!(!knows(&connection, "bb").expect("the join runs"));
        assert!(!knows(&connection, "ff").expect("the join runs"));
        // NOTHING IS HELD until the byte pass says so.
        assert!(!holds(&connection, "aa").expect("the read runs"));
        // The row directly, rather than `held::record`: that function also
        // decides `drawable` from the replica's representations, which is
        // `held`'s own test's subject and not this one's.
        connection
            .execute(
                "INSERT INTO seat_blob_held VALUES ('aa','/tmp/aa',9000000,1,'2026-01-05T00:00:00Z')",
                [],
            )
            .expect("the write runs");
        assert!(holds(&connection, "aa").expect("the read runs"));
    }

    /// A BLOB LANDING IS A ROW CHANGE ON THE ASSET IT BELONGS TO, and the ids
    /// are the ones a grid keys its cells by. An original and its thumbnail
    /// both answer the same asset: one cell, two ways for it to fill in.
    #[test]
    fn a_landed_original_and_a_landed_thumbnail_name_the_same_asset() {
        let connection = a_replica_with_one_photograph();
        let by_original =
            asset_rows_for(&connection, &["aa".to_owned()]).expect("the join runs");
        assert_eq!(by_original, vec!["a1".to_owned()]);
        let by_thumbnail =
            asset_rows_for(&connection, &["cc".to_owned()]).expect("the join runs");
        assert_eq!(by_thumbnail, vec!["a1".to_owned()]);
    }

    /// A soft-deleted asset is not a cell any grid is showing, so waking one
    /// over it would be a redraw with nothing behind it.
    #[test]
    fn a_soft_deleted_asset_is_never_named() {
        let connection = a_replica_with_one_photograph();
        assert!(
            asset_rows_for(&connection, &["bb".to_owned(), "dd".to_owned()])
                .expect("the join runs")
                .is_empty()
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
