//! A LANDED BYTE IS A ROW (#1025 S1 of the Rust-core umbrella, D-1025-S7-20).
//!
//! Until this module "does this device hold these bytes?" lived in the byte
//! store's actor and nowhere else. A blob landing was therefore not a row
//! change, and a page read could not ask the question at all — so the Photos
//! grid drew a hundred and twenty placeholders over a device that held
//! nineteen photographs, and an event type of its own (`BytesArrived`) existed
//! purely to tell a screen to go and ask the store again.
//!
//! `seat_blob_held` is that fact as a table: one row per whole blob this
//! device holds, written in the same window the blob completes, deleted when
//! the eviction sweep forgets it, and **rebuilt from
//! `ByteStore::complete_hashes` every time a core opens**, so no drift can
//! survive a launch.
//!
//! ## It is device-local, like the outbox
//!
//! It is not in the vault DDL and never in the log: the gateway has never heard
//! of it, and two devices holding the same vault hold different files. So it
//! lives in [`crate::schema::SEAT_OWN_TABLES`] beside the cursor and the
//! outbox, which is what makes the gateway shape a bootstrap blob with it
//! already present and a re-bootstrap carry it across.
//!
//! ## `drawable` is the byte door's refusal, decided ONCE, here
//!
//! `Vault::content_location` refuses to call `image/svg+xml` embeddable — a
//! renderer executes it in the embedding page's origin — and the mosaic's
//! caller refused anything that was not a still image on top of that, because
//! a video's original is not a frame. A page read joins this table by HASH and
//! has no media type in hand, so the refusal is applied WHERE THE PATH IS
//! PRODUCED and stored as one column: a row with `drawable = 0` never hands a
//! surface a path. The alternative — a media-type predicate written into the
//! read — would put a security rule in the shell's statement, which is exactly
//! where it must not be.
//!
//! A hash whose media type nothing in this replica states is NOT drawable:
//! **no type is not permission** (`crates/vault/src/content.rs`).
//!
//! SQL literals are allowed here: `crates/seat` is one of the five crates the
//! `sql-confinement` rule names, and this table is this crate's own.

use rusqlite::Connection;

use crate::error::Result;

/// The table, and the one index a rebuild wants.
pub const SEAT_BLOB_HELD_DDL: &str = r"
CREATE TABLE IF NOT EXISTS seat_blob_held (
  content_hash TEXT PRIMARY KEY,
  -- The file the platform opens. Absolute, inside this app's own container,
  -- and the store's to name: this crate never composes it.
  path         TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  -- 1 when every reading of these bytes in this replica is a still image a
  -- surface may embed. See the module header: this is the byte door's refusal,
  -- decided once, where the path is produced.
  drawable     INTEGER NOT NULL,
  landed_at    TEXT NOT NULL
) STRICT;
";

/// One whole blob this device holds.
///
/// `hash` is lowercase hex, `path` is the store's own answer for it. Carried
/// from the byte plane rather than re-derived, because the store is the one
/// thing that knows where its bytes are ([D-1025-S3-1]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldBlob {
    pub hash: String,
    pub path: String,
    pub byte_size: i64,
}

/// Create the table if it is not there.
pub fn open(connection: &Connection) -> Result<()> {
    connection.execute_batch(SEAT_BLOB_HELD_DDL)?;
    Ok(())
}

/// Record what a window landed.
///
/// `INSERT OR REPLACE`, because a blob that was evicted and fetched again is
/// the same hash at the same path, and a window that re-lands one is ordinary.
/// One transaction: a half-written window is a grid that draws some of what
/// arrived.
pub fn record(connection: &Connection, landed: &[HeldBlob], now: &str) -> Result<usize> {
    if landed.is_empty() {
        return Ok(0);
    }
    open(connection)?;
    let transaction = connection.unchecked_transaction()?;
    let mut written = 0;
    {
        let mut insert = transaction.prepare(
            "INSERT OR REPLACE INTO seat_blob_held
               (content_hash, path, byte_size, drawable, landed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for blob in landed {
            let drawable = i64::from(drawable(&transaction, &blob.hash)?);
            insert.execute(rusqlite::params![
                blob.hash,
                blob.path,
                blob.byte_size,
                drawable,
                now
            ])?;
            written += 1;
        }
    }
    transaction.commit()?;
    Ok(written)
}

/// Forget blobs the eviction sweep took.
///
/// The inverse of [`record`] and it runs in the same window: a table that kept
/// a path to bytes the store has released would hand a surface a file that is
/// about to disappear, which is the drift this table exists to make
/// impossible.
pub fn release(connection: &Connection, hashes: &[String]) -> Result<usize> {
    if hashes.is_empty() {
        return Ok(0);
    }
    open(connection)?;
    let transaction = connection.unchecked_transaction()?;
    let mut removed = 0;
    {
        // ONE STATEMENT PER HASH rather than an `IN` list built by formatting:
        // a list spliced into SQL is the shape injection takes.
        let mut delete =
            transaction.prepare("DELETE FROM seat_blob_held WHERE content_hash = ?1")?;
        for hash in hashes {
            removed += delete.execute([hash])?;
        }
    }
    transaction.commit()?;
    Ok(removed)
}

/// REBUILD THE TABLE FROM THE STORE — what a core open does.
///
/// The store is the authority on which bytes are here; this table is a
/// projection of it that a SQL statement can join. A projection that is only
/// ever updated incrementally drifts — a crash between a fetch and its insert,
/// a file removed underneath the app, a replica carried across a re-bootstrap
/// while the store was not — and drift here is invisible, because a missing
/// row renders exactly like a photograph that has not arrived.
///
/// So every open replaces the whole table with what the store says it holds.
/// In ONE transaction: a core that crashed halfway would otherwise open on a
/// table that had been emptied and not refilled.
pub fn rebuild(connection: &Connection, held: &[HeldBlob], now: &str) -> Result<usize> {
    open(connection)?;
    let transaction = connection.unchecked_transaction()?;
    transaction.execute("DELETE FROM seat_blob_held", [])?;
    let mut written = 0;
    {
        let mut insert = transaction.prepare(
            "INSERT OR REPLACE INTO seat_blob_held
               (content_hash, path, byte_size, drawable, landed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for blob in held {
            let drawable = i64::from(drawable(&transaction, &blob.hash)?);
            insert.execute(rusqlite::params![
                blob.hash,
                blob.path,
                blob.byte_size,
                drawable,
                now
            ])?;
            written += 1;
        }
    }
    transaction.commit()?;
    Ok(written)
}

/// Every reading of these bytes in this replica, and whether all of them are
/// still images a surface may embed.
///
/// BOTH SIDES OF THE JOIN, as [`crate::bytes::asset_rows_for`] has: an original
/// is named by `core_content_item.content_hash` and its type is the OWNER's
/// representation (#996 R20(b)), a derivative carries its own `media_type`.
///
/// **Empty is not permission.** A hash nothing in this replica states a type
/// for is not drawable, which is `ServedUrl::of`'s rule and the reason it is
/// phrased that way round.
fn drawable(connection: &Connection, hash: &str) -> Result<bool> {
    let mut types: Vec<String> = Vec::new();
    let mut derivative = connection
        .prepare("SELECT media_type FROM core_content_derivative WHERE content_hash = ?1")?;
    for media_type in derivative.query_map([hash], |row| row.get::<_, String>(0))? {
        types.push(media_type?);
    }
    let mut representation = connection.prepare(
        "SELECT r.media_type
           FROM core_content_representation r
           JOIN core_content_item i ON i.content_id = r.content_id
          WHERE i.content_hash = ?1",
    )?;
    for media_type in representation.query_map([hash], |row| row.get::<_, String>(0))? {
        types.push(media_type?);
    }
    if types.is_empty() {
        return Ok(false);
    }
    Ok(types.iter().all(|media_type| is_still_image(media_type)))
}

/// A still image the byte door would call embeddable.
///
/// `image/*` AND `may_serve_inline`, which is two rules and not one: the
/// second refuses the three types a renderer executes in the embedding page's
/// origin (`image/svg+xml` among them), and the first refuses a video, whose
/// ORIGINAL is not a frame — handing a grid an MP4 draws a blank cell that
/// looks like a failed render rather than like a video whose poster has not
/// landed.
fn is_still_image(media_type: &str) -> bool {
    let base = centraid_vault::content::base_media_type(media_type);
    base.starts_with("image/") && centraid_vault::content::may_serve_inline(&base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_replica() -> Connection {
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
                   media_type TEXT NOT NULL,
                   byte_size INTEGER NOT NULL,
                   text_content TEXT,
                   created_at TEXT NOT NULL);
                 CREATE TABLE core_content_representation (
                   content_id TEXT NOT NULL,
                   owner_type TEXT NOT NULL,
                   owner_id TEXT NOT NULL,
                   media_type TEXT NOT NULL);
                 INSERT INTO core_content_item VALUES
                   ('c1','blob:blake3-aa','aa',9,NULL,'2026-01-02T00:00:00Z'),
                   ('c2','blob:blake3-bb','bb',9,NULL,'2026-01-02T00:00:00Z'),
                   ('c3','blob:blake3-ee','ee',9,NULL,'2026-01-02T00:00:00Z');
                 INSERT INTO core_content_representation VALUES
                   ('c1','media.asset','a1','image/jpeg'),
                   ('c2','media.asset','a2','video/mp4');
                 INSERT INTO core_content_derivative VALUES
                   ('d1','c2','poster','cc','image/svg+xml',9,NULL,'2026-01-02T00:00:00Z');",
            )
            .expect("the fixture builds");
        open(&connection).expect("the table lays");
        connection
    }

    fn held(hash: &str) -> HeldBlob {
        HeldBlob {
            hash: hash.to_owned(),
            path: format!("/store/{hash}.data"),
            byte_size: 9,
        }
    }

    fn drawable_of(connection: &Connection, hash: &str) -> Option<i64> {
        connection
            .query_row(
                "SELECT drawable FROM seat_blob_held WHERE content_hash = ?1",
                [hash],
                |row| row.get(0),
            )
            .ok()
    }

    #[test]
    fn a_landed_photograph_is_a_drawable_row() {
        let connection = a_replica();
        record(&connection, &[held("aa")], "2026-01-02T00:00:00Z").expect("recorded");
        assert_eq!(drawable_of(&connection, "aa"), Some(1));
    }

    /// The door refuses to call `image/svg+xml` embeddable, and this is the
    /// same refusal one layer earlier: a path a read could hand out would be a
    /// surface for somebody else's script.
    #[test]
    fn an_svg_poster_lands_and_is_never_drawn() {
        let connection = a_replica();
        record(&connection, &[held("cc")], "2026-01-02T00:00:00Z").expect("recorded");
        assert_eq!(drawable_of(&connection, "cc"), Some(0));
    }

    /// A video's ORIGINAL is not a frame. It is held — the row is the truth
    /// about the bytes — and it is not drawn.
    #[test]
    fn a_video_original_is_held_and_not_drawable() {
        let connection = a_replica();
        record(&connection, &[held("bb")], "2026-01-02T00:00:00Z").expect("recorded");
        assert_eq!(drawable_of(&connection, "bb"), Some(0));
    }

    /// No type is not permission.
    #[test]
    fn bytes_no_representation_states_a_type_for_are_not_drawable() {
        let connection = a_replica();
        record(&connection, &[held("ee")], "2026-01-02T00:00:00Z").expect("recorded");
        assert_eq!(drawable_of(&connection, "ee"), Some(0));
    }

    #[test]
    fn the_sweep_takes_a_row_with_the_bytes() {
        let connection = a_replica();
        record(&connection, &[held("aa")], "2026-01-02T00:00:00Z").expect("recorded");
        assert_eq!(
            release(&connection, &["aa".to_owned()]).expect("released"),
            1
        );
        assert_eq!(drawable_of(&connection, "aa"), None);
    }

    /// A rebuild is a REPLACEMENT and not a merge: what the store does not
    /// hold, this table must not claim.
    #[test]
    fn a_rebuild_drops_what_the_store_no_longer_holds() {
        let connection = a_replica();
        record(
            &connection,
            &[held("aa"), held("bb")],
            "2026-01-02T00:00:00Z",
        )
        .expect("recorded");
        rebuild(&connection, &[held("bb")], "2026-01-03T00:00:00Z").expect("rebuilt");
        assert_eq!(drawable_of(&connection, "aa"), None);
        assert_eq!(drawable_of(&connection, "bb"), Some(0));
    }

    /// An empty store empties the table. The one case an incremental writer
    /// cannot express, and the reason the rebuild is a replacement.
    #[test]
    fn a_rebuild_over_an_empty_store_leaves_nothing_behind() {
        let connection = a_replica();
        record(&connection, &[held("aa")], "2026-01-02T00:00:00Z").expect("recorded");
        rebuild(&connection, &[], "2026-01-03T00:00:00Z").expect("rebuilt");
        assert_eq!(drawable_of(&connection, "aa"), None);
    }
}
