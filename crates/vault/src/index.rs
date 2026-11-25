//! The index file: the search indexes, the spatial index and the alerts, kept by the writer.
//!
//! `search` is a contentless FTS5 table whose rowid is `entity.n`, in the attached
//! `<stem>.index.db` (schema `ix`, A15). It is DERIVED DATA: nothing in it was made by a member, and
//! [`rebuild`] rewrites every table in it from `vault.db`.
//!
//! ## How a change reaches it
//!
//! No transaction spans the two files in WAL mode, so a commit never writes the index file. Temp
//! triggers installed at open record every entity whose row, child or edge changes in the
//! transaction (and commands may call `ctx.touch(id)` / `ctx.mark_for_index(id)` for
//! cross-entity effects), and at commit the guard hands them to [`reindex`], which writes
//! `search_owed` in `vault.db`, in the same transaction as the change. Right after the commit,
//! [`after_commit`] writes the index file from what that commit queued (a transaction on the index
//! file), and only then clears the queue (a transaction on the vault). A kill anywhere between the
//! two leaves the rows owed; the idle pass ([`drain_batch`], `Vault::reindex_owed`) pays them, in
//! pieces of [`OWED_BATCH`], and paying a row twice writes what paying it once wrote.
//!
//! `search_owed` has one row per entity number: `after` NULL owes the entity itself (written, or
//! removed when it is gone: a purge leaves no entity to name, only its number, which is never
//! reused); `after` set owes a label's members in id order after that id, so a label of thousands is
//! walked a piece at a time. A file founded again (missing, damaged, another vault's, another
//! tokenizer's: `index_state`) owes every entity.
//!
//! ## What is written for an entity
//!
//! A live entity whose kind has a search text gets its row replaced; anything else (trashed, a
//! kind nobody searches, nothing to say) has its row deleted. The search text is [`text_of`], one
//! function over the entity's own row and children, the titles of what labels it (its tags and
//! flags, the lists and albums that hold it, the notebook, folder, project, calendar, category or
//! account it is filed under), and the bodies of the live notes `about` it, so a person is found by
//! what you wrote about them. A read joins `entity` on `n` for the kind and the trash filter.
//! A photo's or place's coordinates are one point in `geo` (`geo`). What an item said in an EARLIER
//! VERSION is in `search_past`, one row per kept version of a live item (`past`); a trashed item has
//! none.
//!
//! A Locker item is in the index by its **plain** text only ([`text_of`]: never a sealed cell, a
//! one-time-code seed, a passkey's key or any `lk1:` value), now and in its earlier versions.
//! Whether a surface offers it is a question for its readers, not for the index.
//!
//! `tests/index_owed.rs` compares the incremental index with one rebuilt from a copy of the rows
//! after a scripted run, so a command that forgot to touch is red.

use std::collections::{BTreeSet, HashSet};

use centraid_ontology::text::index_words;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::model::Kind;

mod geo;
mod past;
mod text;

pub use geo::{GeoPoint, VIEWPORT, viewport};
pub(crate) use past::version_kept;
pub use past::{EARLIER_COLUMNS, EARLIER_KINDS, earlier_texts, past_rowid, version_text};
pub use text::{MIN_PHONE_DIGITS, SEARCHABLE, text_of, untitled_label};

/// The version of `text::index_words` (and so of what the index file holds). `index_state.tokenizer`
/// records it, and an index file written under another version is founded again, not trusted. Raise
/// it with any change to the tokenizer or to the fold in `centraid_ontology::text`.
pub const TOKENIZER_VERSION: i64 = 1;

/// How many entities a commit writes into the index file itself, right after it commits (the
/// rest stay owed, durably, for the idle pass): a bulk import never holds the vault for the
/// length of its whole index.
pub const INLINE_COMMIT: usize = 1_000;

/// How many entities a label's title feeds that one commit queues for the commit's own pass.
pub const INLINE_DEPENDENTS: usize = 50;

/// How many rows one idle-pass batch writes (a label's members count as that many).
pub const OWED_BATCH: usize = INLINE_DEPENDENTS;

/// THE COMMIT'S SIDE OF THE INDEX (A15). The index file is a second database file and WAL gives no
/// atomic transaction across two files, so a commit never writes it: it writes `search_owed`, in
/// `vault.db`, in the same transaction as the change, and [`after_commit`] (and the idle pass,
/// [`drain_batch`]) write the index file afterwards and only then clear what they wrote. A kill
/// between the two leaves the rows owed, and writing a row twice is the same as writing it once.
///
/// Called with the entities a commit touched. A note's body is part of the text of everything it
/// is `about`, so a touched note brings its targets with it; and of the people a touch it is
/// about was `with`, so it brings those too. A title is part of the text of everything it labels
/// ([`DEPENDENTS`]), so a touched tag, list, project or account brings what it labels: a bounded
/// first piece is queued whole and the rest is owed as one row of its own (`after` is not NULL),
/// which the idle pass walks in id order.
///
/// # Errors
/// SQLite's refusal.
pub fn reindex(connection: &Connection, touched: &BTreeSet<String>) -> Result<()> {
    let mut work = touched.clone();
    let mut about = connection.prepare_cached(
        "SELECT e.to_id FROM edge e JOIN entity n ON n.id = e.from_id
          WHERE e.from_id = ?1 AND e.rel = 'about' AND n.kind = 'note'",
    )?;
    // Only a touch's participants are found by the notes about it: a line or a Locker item
    // that is `with` someone is not part of their text.
    let mut with = connection.prepare_cached(
        "SELECT w.to_id FROM edge w JOIN entity a ON a.id = w.from_id
          WHERE w.from_id = ?1 AND w.rel = 'with' AND a.kind = 'touch'",
    )?;
    for id in touched {
        let targets = about
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // An activity can be marked directly when an about edge is removed or
        // its note is purged; the note no longer names that target then.
        for target in std::iter::once(id).chain(targets.iter()) {
            work.extend(
                with.query_map([target], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }
        work.extend(targets);
    }
    for id in touched {
        let mut piece = dependents_after(connection, id, "", INLINE_DEPENDENTS + 1)?;
        if piece.len() > INLINE_DEPENDENTS {
            piece.truncate(INLINE_DEPENDENTS);
            // Restarts the walk at this piece's end: what is before it is queued whole below.
            connection
                .prepare_cached(
                    "INSERT INTO search_owed (n, after) SELECT n, ?2 FROM entity WHERE id = ?1
                     ON CONFLICT (n) DO UPDATE SET after = excluded.after",
                )?
                .execute(rusqlite::params![
                    id,
                    piece.last().map_or("", String::as_str)
                ])?;
        }
        work.extend(piece);
    }
    for id in &work {
        queue_id(connection, id)?;
    }
    Ok(())
}

/// Owe the index file one entity, by id. A kind nobody searches (a reading, a flag) is never
/// queued: the writer owes the index nothing for it.
fn queue_id(connection: &Connection, id: &str) -> Result<()> {
    let row: Option<(i64, String)> = connection
        .prepare_cached("SELECT n, kind FROM entity WHERE id = ?1")?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((n, kind)) = row
        && (crate::alerts::TARGET_KINDS.contains(&kind.as_str())
            || Kind::parse(&kind).is_some_and(|kind| SEARCHABLE.contains(&kind)))
    {
        queue(connection, n)?;
    }
    Ok(())
}

/// Owe the index file the entity numbered `n`: durably in `vault.db` (the change's own
/// transaction), and on this connection's scratch list of what the commit just queued, so the
/// commit's own pass knows what to write without scanning the queue.
fn queue(connection: &Connection, n: i64) -> Result<()> {
    connection
        .prepare_cached("INSERT INTO search_owed (n) VALUES (?1) ON CONFLICT (n) DO NOTHING")?
        .execute([n])?;
    connection
        .prepare_cached("INSERT OR IGNORE INTO temp.centraid_index_recent (n) VALUES (?1)")?
        .execute([n])?;
    Ok(())
}

/// The connection's scratch tables the commit leaves for its own after-commit pass. They are
/// temp objects: they live on this connection only and a rollback takes their rows with it. What
/// they hold is only ever an optimisation or a clean-up of the durable queue: a kill loses them
/// and nothing else.
///
/// * `centraid_index_recent`: the `n`s this commit queued.
/// * `centraid_index_forget`: the words of an entity this commit purged: dropped from `search_word`
///   once no row holds them.
/// * `centraid_index_compact`: a purge asked for the segments to be merged.
pub(crate) fn install(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS centraid_index_recent (n INTEGER PRIMARY KEY);
         CREATE TEMP TABLE IF NOT EXISTS centraid_index_forget (word TEXT PRIMARY KEY);
         CREATE TEMP TABLE IF NOT EXISTS centraid_index_compact (one INTEGER PRIMARY KEY CHECK (one = 1));",
    )?;
    Ok(())
}

/// Whether a table is one of this module's scratch tables (not a change a screen reads).
pub(crate) fn is_scratch(table: &str) -> bool {
    table.starts_with("centraid_index_")
}

/// The ids [`DEPENDENTS`] names for `id` after `after`, in id order, at most `limit`.
fn dependents_after(
    connection: &Connection,
    id: &str,
    after: &str,
    limit: usize,
) -> Result<Vec<String>> {
    // `?1` is the touched id in every arm of the union; `?2` and `?3` bound the piece.
    let sql =
        format!("SELECT DISTINCT dep FROM ({DEPENDENTS}) WHERE dep > ?2 ORDER BY dep LIMIT ?3");
    Ok(connection
        .prepare_cached(&sql)?
        .query_map(
            rusqlite::params![id, after, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<_>>()?)
}

/// How many rows are owed, counted up to a thousand (the queue of a restored vault is every
/// entity, and a caller asks "is there more", not "how many").
///
/// # Errors
/// SQLite's refusal.
pub fn owed_count(connection: &Connection) -> Result<usize> {
    Ok(usize::try_from(connection.query_row(
        "SELECT count(*) FROM (SELECT 1 FROM search_owed LIMIT 1000)",
        [],
        |row| row.get::<_, i64>(0),
    )?)
    .unwrap_or(0))
}

/// Whether the index file owes anything.
///
/// # Errors
/// SQLite's refusal.
pub fn owed(connection: &Connection) -> Result<usize> {
    Ok(
        connection.query_row("SELECT EXISTS (SELECT 1 FROM search_owed)", [], |row| {
            row.get::<_, i64>(0)
        })? as usize,
    )
}

/// Whatever a touched entity's title is part of the text of: one parameter, the
/// touched id, and one arm per way a thing is labelled. Each arm is an indexed
/// lookup and answers nothing for an entity that labels nothing, so asking it of
/// every touched id costs a handful of probes.
///
/// A link added or removed (a tag put on a note, a photograph put in an album)
/// is not a touch of the label, so the command that writes the link marks the
/// labelled end for the index itself.
const DEPENDENTS: &str = "\
    SELECT id AS dep FROM entity WHERE parent_id = ?1
    UNION ALL SELECT id FROM event WHERE place_id = ?1
    UNION ALL SELECT id FROM photo WHERE place_id = ?1
    UNION ALL SELECT id FROM workout WHERE place_id = ?1
    UNION ALL SELECT id FROM workout WHERE type_id = ?1
    UNION ALL SELECT id FROM touch WHERE place_id = ?1
    UNION ALL SELECT id FROM touch WHERE type_id = ?1
    UNION ALL SELECT txn_id FROM txn_split WHERE category_id = ?1
    UNION ALL SELECT id FROM txn WHERE account_id = ?1
    UNION ALL SELECT from_id FROM edge WHERE to_id = ?1 AND rel = 'tagged'
    UNION ALL SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains'
    UNION ALL SELECT from_id FROM edge WHERE label_id = ?1
    UNION ALL SELECT to_id FROM edge WHERE label_id = ?1";

/// Throw the index file's contents away and write them again from the rows: every table in it
/// (the alerts included: `alerts::sync` writes them from the reminder rows) is emptied, every searchable entity
/// is owed, and the queue is drained to the end.
///
/// What a restored vault runs (through the idle pass, a bounded batch at a time, not through this
/// call: this one holds the vault for the length of the index), and what the tests compare the
/// incremental index with. May be called inside a commit (then it is that commit's writes).
///
/// # Errors
/// SQLite's refusal.
pub fn rebuild(connection: &Connection, now: i64) -> Result<()> {
    in_tx(connection, |connection| {
        // The word list is rewritten from the rows too: this is where a word an edit dropped
        // finally goes.
        connection.execute_batch(
            "DELETE FROM search; DELETE FROM search_past; DELETE FROM search_word;
             DELETE FROM geo; DELETE FROM alert; DELETE FROM ix.index_state;",
        )?;
        Ok(())
    })?;
    connection.execute("DELETE FROM search_owed", [])?;
    owe_everything(connection)?;
    while owed_count(connection)? > 0 {
        drain_batch(connection, usize::MAX >> 16, now)?;
    }
    // A rebuilt index is a new one, and the planner has statistics of the old.
    optimize(connection);
    Ok(())
}

/// Owe the index file every entity: what a refounded or restored index file needs written. A kind
/// nobody searches costs the pass three empty deletes (a reading is not queued by the writer, but a
/// file founded again owes every row, because it cannot know what the lost file held).
///
/// # Errors
/// SQLite's refusal.
pub fn owe_everything(connection: &Connection) -> Result<()> {
    connection.execute(
        "INSERT INTO search_owed (n) SELECT n FROM entity WHERE true ON CONFLICT (n) DO NOTHING",
        [],
    )?;
    Ok(())
}

/// Let SQLite re-analyse the tables whose shape changed enough since they were
/// last analysed (`PRAGMA optimize`), reading at most 1,000 index entries of
/// each so that the cost is bounded however large the vault is.
///
/// Called when a vault closes and when the index is rebuilt. **A failure is
/// ignored**: the statistics are advisory (without them a plan is slower, never
/// wrong), and neither a close nor a rebuild may fail for the sake of them.
pub(crate) fn optimize(connection: &Connection) {
    let _ = connection.execute_batch("PRAGMA analysis_limit = 1000; PRAGMA optimize;");
}

/// Run `body` as one transaction, unless the caller already holds one (then it is the caller's).
pub(crate) fn in_tx<T>(
    connection: &Connection,
    body: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    if !connection.is_autocommit() {
        return body(connection);
    }
    connection.execute_batch("BEGIN IMMEDIATE")?;
    match body(connection) {
        Ok(value) => {
            connection.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// What an owed row asked and what became of it, for the vault's side to settle.
#[derive(Debug)]
enum Settled {
    /// The entity itself was written (or removed).
    Whole(i64),
    /// A label's members were written up to `now`; `None` is the end of them.
    Members {
        n: i64,
        was: String,
        now: Option<String>,
    },
}

/// WRITE THE NEXT BATCH OF WHAT THE INDEX OWES: up to `limit` whole-entity rows (`after` is NULL), or,
/// when there are none, one label's next `limit` members. The index file is written first, in a
/// transaction of its own; only then are the rows cleared in `vault.db`, in another. A kill between
/// the two leaves them owed and they are written again, to the same result.
///
/// Returns how many rows are still owed (counted up to a thousand).
///
/// # Errors
/// SQLite's refusal. Nothing is cleared that was not written.
pub fn drain_batch(connection: &Connection, limit: usize, now: i64) -> Result<usize> {
    let limit = limit.max(1);
    let sql_limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let whole: Vec<i64> = connection
        .prepare_cached("SELECT n FROM search_owed WHERE after IS NULL ORDER BY n LIMIT ?1")?
        .query_map([sql_limit], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let members: Option<(i64, String)> = if whole.is_empty() {
        connection
            .prepare_cached(
                "SELECT n, after FROM search_owed WHERE after IS NOT NULL ORDER BY n LIMIT 1",
            )?
            .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?
    } else {
        None
    };
    if whole.is_empty() && members.is_none() {
        return Ok(0);
    }
    let settled = in_tx(connection, |connection| {
        write_rows(connection, &whole, members.as_ref(), limit, now)
    })?;
    crate::stage::reached(crate::stage::Stage::IndexWritten)?;
    in_tx(connection, |connection| settle(connection, &settled))?;
    compact_if_asked(connection)?;
    owed_count(connection)
}

/// The commit's own pass: write into the index file what the commit that just landed queued (up
/// to [`INLINE_COMMIT`] entities; the rest is owed for the idle pass), so a screen that reads
/// after its write reads its own change. **It never fails the commit**: the commit is durable,
/// and a pass that could not finish leaves its rows owed.
pub(crate) fn after_commit(connection: &Connection, now: i64) {
    if let Err(error) = catch_up(connection, now) {
        tracing::warn!(%error, "the index file is behind; the idle pass writes it");
    }
}

fn catch_up(connection: &Connection, now: i64) -> Result<()> {
    let busy: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM temp.centraid_index_recent)
             OR EXISTS (SELECT 1 FROM temp.centraid_index_forget)
             OR EXISTS (SELECT 1 FROM temp.centraid_index_compact)",
        [],
        |row| row.get(0),
    )?;
    if !busy {
        return Ok(());
    }
    let whole: Vec<i64> = connection
        .prepare_cached("SELECT n FROM temp.centraid_index_recent ORDER BY n LIMIT ?1")?
        .query_map([INLINE_COMMIT as i64], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    // What did not fit stays in `search_owed`, which is the durable record; the scratch list is
    // only this pass's.
    connection.execute("DELETE FROM temp.centraid_index_recent", [])?;
    let settled = in_tx(connection, |connection| {
        write_rows(connection, &whole, None, 0, now)
    })?;
    crate::stage::reached(crate::stage::Stage::IndexWritten)?;
    in_tx(connection, |connection| settle(connection, &settled))?;
    compact_if_asked(connection)
}

/// Write the index file's side of some owed rows. Called inside a transaction on the index file.
fn write_rows(
    connection: &Connection,
    whole: &[i64],
    members: Option<&(i64, String)>,
    limit: usize,
    now: i64,
) -> Result<Vec<Settled>> {
    ensure_state(connection)?;
    let mut settled = Vec::with_capacity(whole.len() + 1);
    for &n in whole {
        apply_n(connection, n, now)?;
        settled.push(Settled::Whole(n));
    }
    if let Some((n, after)) = members {
        // The label itself is written too: an owed row is one row per entity, so a label that is
        // both owed whole and owed its members is one row, and this is where its own half is paid.
        apply_n(connection, *n, now)?;
        let id: Option<String> = connection
            .prepare_cached("SELECT id FROM entity WHERE n = ?1")?
            .query_row([n], |row| row.get(0))
            .optional()?;
        let now = match id {
            // A purged label: its members were queued when it went (`index::purge` is called
            // with the edges still there), so there is nothing to walk.
            None => None,
            Some(id) => {
                let mut piece = dependents_after(connection, &id, after, limit + 1)?;
                let finished = piece.len() <= limit;
                piece.truncate(limit);
                for member in &piece {
                    apply_id(connection, member, now)?;
                }
                if finished {
                    None
                } else {
                    piece.last().cloned()
                }
            }
        };
        settled.push(Settled::Members {
            n: *n,
            was: after.clone(),
            now,
        });
    }
    forget_words(connection)?;
    Ok(settled)
}

/// Clear what the index file wrote from the queue in `vault.db`. A row that was queued again in
/// the meantime is the same row, written once more by the next pass.
fn settle(connection: &Connection, settled: &[Settled]) -> Result<()> {
    let mut clear =
        connection.prepare_cached("DELETE FROM search_owed WHERE n = ?1 AND after IS NULL")?;
    let mut finish =
        connection.prepare_cached("DELETE FROM search_owed WHERE n = ?1 AND after = ?2")?;
    let mut advance = connection
        .prepare_cached("UPDATE search_owed SET after = ?3 WHERE n = ?1 AND after = ?2")?;
    for one in settled {
        match one {
            Settled::Whole(n) => {
                clear.execute([n])?;
            }
            Settled::Members { n, was, now: None } => {
                finish.execute(rusqlite::params![n, was])?;
            }
            Settled::Members {
                n,
                was,
                now: Some(now),
            } => {
                advance.execute(rusqlite::params![n, was, now])?;
            }
        }
    }
    Ok(())
}

/// The index file's `index_state` row exists once the vault is founded: what this file is a copy
/// of. Written in the first transaction that writes the file, so a file with rows has one.
fn ensure_state(connection: &Connection) -> Result<()> {
    connection
        .prepare_cached(
            "INSERT INTO ix.index_state (id, self_id, tokenizer, built_at)
             SELECT 1, self_id, ?1, COALESCE(written_at, created_at) FROM vault
              WHERE NOT EXISTS (SELECT 1 FROM ix.index_state)",
        )?
        .execute([TOKENIZER_VERSION])?;
    Ok(())
}

/// Merge the segments when a purge asked, after the rows are gone: the words of a purged item
/// leave the pages. Once per pass, however many items it purged.
fn compact_if_asked(connection: &Connection) -> Result<()> {
    let asked: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM temp.centraid_index_compact)",
        [],
        |row| row.get(0),
    )?;
    if !asked {
        return Ok(());
    }
    connection.execute("DELETE FROM temp.centraid_index_compact", [])?;
    merge(connection)
}

/// Drop from the word list the words a purge named, unless some row still holds them.
fn forget_words(connection: &Connection) -> Result<()> {
    let words: Vec<String> = connection
        .prepare_cached("SELECT word FROM temp.centraid_index_forget")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if words.is_empty() {
        return Ok(());
    }
    let mut held = connection.prepare_cached(
        "SELECT 1 FROM search_vocab WHERE term = ?1
         UNION ALL SELECT 1 FROM search_past_vocab WHERE term = ?1 LIMIT 1",
    )?;
    let mut drop = connection.prepare_cached("DELETE FROM search_word WHERE word = ?1")?;
    for word in &words {
        if !held.exists([word])? {
            drop.execute([word])?;
        }
    }
    connection.execute("DELETE FROM temp.centraid_index_forget", [])?;
    Ok(())
}

/// What a purge does before it deletes the entity, because after it the `n` is not findable:
/// owe the index the entity's removal (its `search`, `search_past` and `geo` rows go in the
/// commit's own pass, by `n`), and remember its words so they leave the word list unless some
/// other row still holds them.
///
/// **The word list is a superset of the index's own vocabulary until a [`rebuild`].** The index is
/// contentless, so an edit that drops a word cannot say which word it dropped: the word stays in
/// the list. This is the one place a word leaves the list while the vault runs, and it can only
/// name the words the entity holds now (and said before). The list never misses a word the index
/// can find.
///
/// # Errors
/// SQLite's refusal.
pub fn purge(connection: &Connection, id: &str) -> Result<()> {
    let row: Option<(i64, String, String)> = connection
        .query_row(
            "SELECT n, kind, title FROM entity WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((n, kind, title)) = row else {
        return Ok(());
    };
    let Some(kind) = Kind::parse(&kind).filter(|kind| SEARCHABLE.contains(kind)) else {
        return Ok(());
    };
    let body = text_of(connection, id, kind)?.unwrap_or_default();
    let earlier = past::words_of(connection, id)?;
    queue(connection, n)?;
    let mut words = distinct_words(&[&title, &body]);
    words.extend(earlier);
    let mut note = connection
        .prepare_cached("INSERT OR IGNORE INTO temp.centraid_index_forget (word) VALUES (?1)")?;
    for word in words {
        note.execute([&word])?;
    }
    Ok(())
}

/// **Ask for the search indexes to be merged so that what a purge removed leaves their
/// segments.** The indexes are contentless: deleting a row only marks it, and the words of a
/// purged item stay in the segment pages (and so in the file) until a merge rewrites them.
/// `optimize` merges every segment into one and drops the marked rows.
///
/// Inside a commit this only marks the request: the rows are removed after the commit, by the
/// commit's own pass, and the merge runs once at its end ([`merge`]).
///
/// **Bounded by construction:** the work is one merge of each index per *member action* (a
/// purge, an emptied trash) or per *launch pass* ([`crate::Vault::compact_search`], run once at
/// the end of a pass that purged something), never per purged item; and it runs only when
/// something was asked. Its cost is the size of the two indexes, paid once.
///
/// # Errors
/// A database error.
pub fn compact(connection: &Connection) -> Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO temp.centraid_index_compact (one) VALUES (1)",
        [],
    )?;
    Ok(())
}

/// Merge the two search indexes now (the work [`compact`] asks for).
///
/// # Errors
/// A database error.
pub fn merge(connection: &Connection) -> Result<()> {
    in_tx(connection, |connection| {
        connection.execute("INSERT INTO search(search) VALUES ('optimize')", [])?;
        connection.execute(
            "INSERT INTO search_past(search_past) VALUES ('optimize')",
            [],
        )?;
        Ok(())
    })
}

/// The words of some texts, in the order they first appear, each once.
fn distinct_words(texts: &[&str]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut words = Vec::new();
    for text in texts {
        for word in index_words(text) {
            if !seen.contains(&word) {
                seen.insert(word.clone());
                words.push(word);
            }
        }
    }
    words
}

/// Add the words of a text just indexed to the list. A word already in the list
/// keeps its number.
fn remember(connection: &Connection, title: &str, body: &str) -> Result<()> {
    let mut add =
        connection.prepare_cached("INSERT OR IGNORE INTO search_word (word) VALUES (?1)")?;
    for word in distinct_words(&[title, body]) {
        add.execute([&word])?;
    }
    Ok(())
}

/// Remove an entity's rows from every table of the index file, by its number.
fn forget_all(connection: &Connection, n: i64) -> Result<()> {
    connection
        .prepare_cached("DELETE FROM search WHERE rowid = ?1")?
        .execute([n])?;
    past::forget_entity(connection, n)?;
    crate::alerts::forget(connection, n)?;
    geo::forget(connection, n)
}

/// One entity's row, as the index reads it.
struct Row {
    n: i64,
    id: String,
    kind: String,
    title: String,
    deleted_at: Option<String>,
}

fn row_by(connection: &Connection, column: &str, key: impl rusqlite::ToSql) -> Result<Option<Row>> {
    Ok(connection
        .prepare_cached(&format!(
            "SELECT n, id, kind, title, deleted_at FROM entity WHERE {column} = ?1"
        ))?
        .query_row([key], |row| {
            Ok(Row {
                n: row.get(0)?,
                id: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                deleted_at: row.get(4)?,
            })
        })
        .optional()?)
}

/// Write the index file's rows of the entity numbered `n`: what it says now, or nothing when it is
/// gone (a purge: its row is not there to name, but its number is never reused).
fn apply_n(connection: &Connection, n: i64, now: i64) -> Result<()> {
    match row_by(connection, "n", n)? {
        None => forget_all(connection, n),
        Some(row) => apply(connection, &row, now),
    }
}

fn apply_id(connection: &Connection, id: &str, now: i64) -> Result<()> {
    match row_by(connection, "id", id)? {
        None => Ok(()),
        Some(row) => apply(connection, &row, now),
    }
}

fn apply(connection: &Connection, row: &Row, now: i64) -> Result<()> {
    let n = row.n;
    // The alerts of a reminder's holder: written by the same pass, from the same rows, and gone with
    // a trash (they come back with a restore).
    crate::alerts::sync(connection, n, now)?;
    connection
        .prepare_cached("DELETE FROM search WHERE rowid = ?1")?
        .execute([n])?;
    let kind = Kind::parse(&row.kind).filter(|kind| SEARCHABLE.contains(kind));
    let Some(kind) = kind.filter(|_| row.deleted_at.is_none()) else {
        // A trashed entity leaves the index with what it said before and where it was; a kind
        // nobody searches was never in it.
        past::forget_entity(connection, n)?;
        return geo::forget(connection, n);
    };
    geo::sync(connection, n, &row.id, kind)?;
    // Back from the trash, or an index thrown away: the past rows are written from the versions
    // the entity has. A version kept later is written by the pass that follows its commit.
    past::sync(connection, n, &row.id, kind)?;
    let Some(body) = text_of(connection, &row.id, kind)? else {
        return Ok(());
    };
    if row.title.trim().is_empty() && body.trim().is_empty() {
        return Ok(());
    }
    connection
        .prepare_cached("INSERT INTO search (rowid, title, body) VALUES (?1, ?2, ?3)")?
        .execute(rusqlite::params![n, row.title, body])?;
    remember(connection, &row.title, &body)
}

/// Whether a file's `index_state` says it is a copy of THIS vault under THIS tokenizer; used by
/// the opener to decide between trusting a file and founding it again.
///
/// `self_id` is the vault's own (`None` before it is founded: a file that names a vault then is
/// another's).
#[must_use]
pub fn state_is_current(connection: &Connection, self_id: Option<&str>) -> bool {
    let state: Option<(String, i64)> = connection
        .query_row("SELECT self_id, tokenizer FROM index_state", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()
        .unwrap_or(None);
    match (state, self_id) {
        (Some((found, tokenizer)), Some(own)) => found == own && tokenizer == TOKENIZER_VERSION,
        (None, None) => true,
        _ => false,
    }
}

/// Which file is the vault's index file, given the vault's path: the one derived file that is
/// **never in a snapshot, in staging or in the dirty-range record** (a restore founds it again
/// and owes it every entity, [`owe_everything`]). The backup plane asks this of every path it
/// is about to send, keep or record.
#[must_use]
pub fn index_file_for(vault_path: &std::path::Path) -> std::path::PathBuf {
    vault_path.with_extension("index.db")
}

/// Whether `candidate` is the index file of the vault at `vault_path`, or one of its SQLite
/// sidecars (`-wal`, `-shm`, `-journal`, and the `.founding` side file its founding is built in).
#[must_use]
pub fn is_index_file(vault_path: &std::path::Path, candidate: &std::path::Path) -> bool {
    let index = index_file_for(vault_path);
    let Some(name) = candidate.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(base) = index.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    candidate.parent() == index.parent()
        && name.strip_prefix(base).is_some_and(|rest| {
            matches!(rest, "" | "-wal" | "-shm" | "-journal" | ".founding")
                || rest.starts_with(".founding-")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list a reader filters by and the function the index is written from
    /// are one fact: a kind is in `SEARCHABLE` exactly when `text_of` has an
    /// answer for it.
    #[test]
    fn the_searchable_kinds_are_the_kinds_text_of_answers_for() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = crate::Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault
            .read(|connection| {
                for kind in Kind::ALL {
                    let answered = text_of(connection, "no-such-entity", kind)?.is_some();
                    assert_eq!(answered, SEARCHABLE.contains(&kind), "{}", kind.as_str());
                }
                Ok(())
            })
            .expect("reads");
    }
}
