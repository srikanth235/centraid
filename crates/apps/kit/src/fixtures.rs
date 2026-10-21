//! FIXTURE GENERATORS ON THE NEW MODEL (#1135): a vault written at a stated
//! volume, so a read is measured over rows and not over a handful.
//!
//! **Why here.** `sql-confinement` (`cargo xtask rules`) keeps SQL out of every
//! crate but `crates/{ontology,vault,seat,search}` and this one, and a fixture
//! is thousands of `INSERT`s. An app crate's volume test calls these through a
//! vault's own commit guard and asks its own reads about the result.
//!
//! **What they are not.** They write rows, not commands: nothing here is a
//! command's behavior, and nothing is indexed (the `search` table is the
//! vault's, kept by the writer; a test that searches rebuilds it). A generator
//! is deterministic — a named LCG, so the bytes of a fixture never move.
//!
//! The only generator today is Notes'; the next lane that needs a volume adds
//! its own beside it.

use rusqlite::{Connection, params};

use crate::error::{KitError, KitResult};

/// A seeded integer stream: a named, tiny LCG rather than a crate, because a
/// fixture's value is that its bytes never move.
struct Seeded(u64);

impl Seeded {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(2).wrapping_add(1))
    }

    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 16
    }

    fn upto(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        usize::try_from(self.next() % bound as u64).expect("a bound is a usize")
    }
}

fn door(error: rusqlite::Error) -> KitError {
    KitError::Door(error.to_string())
}

/// `note-000123`: a prefix and a zero-padded index.
fn id(prefix: &str, index: usize) -> String {
    format!("{prefix}-{index:06}")
}

/// The instant `index` steps into a three-year span, in the vault's text form.
fn instant(index: usize, of: usize) -> String {
    // 2024-01-01 to 2026-12-31, in minutes.
    let minutes = 1_576_800 * index / of.max(1);
    let (day, minute) = (minutes / 1_440, minutes % 1_440);
    // A civil calendar for 2024..=2026 by walking the months, so no date crate.
    let (mut year, mut left) = (2024, day);
    loop {
        let length = if year % 4 == 0 { 366 } else { 365 };
        if left < length {
            break;
        }
        left -= length;
        year += 1;
    }
    let months = [
        31,
        if year % 4 == 0 { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0;
    while left >= months[month] {
        left -= months[month];
        month += 1;
    }
    format!(
        "{year:04}-{:02}-{:02}T{:02}:{:02}:00.000Z",
        month + 1,
        left + 1,
        minute / 60,
        minute % 60
    )
}

/// The volume a Notes library is stated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3NotesShape {
    /// Notes, live and trashed together.
    pub notes: usize,
    /// How many of them are in the trash.
    pub trashed: usize,
    /// How many carry a pin. Every one is read BESIDE the window, and the
    /// oldest notes carry them, so each has aged out of it.
    pub pinned: usize,
    /// How many are memos (People-journal entries): notes with an `about` edge,
    /// excluded from the library, search and the powerbox.
    pub memos: usize,
    /// Notebooks, and how many notes are filed into one.
    pub notebooks: usize,
    pub filed: usize,
    /// Tags, and how many notes carry one.
    pub tags: usize,
    pub tagged: usize,
    /// Revisions beyond none, spread over the notes.
    pub revisions: usize,
    /// `links` edges between notes, and how many carry an anchor.
    pub links: usize,
    pub anchored: usize,
    /// The length of a LONG body, in bytes of text: the largest the product
    /// holds (the 64 KiB budget is its ceiling).
    pub long_body_bytes: usize,
    /// How many notes carry one.
    pub long_bodies: usize,
}

/// THE YEAR-3 NOTES PROFILE: 10,000 notes against a 2,000-row window, 600 of
/// them carrying a 48 KiB body.
///
/// * **10,000 notes against a 2,000-row window**: the library's declared
///   maximum is 2,000, so a year-3 library is five windows deep.
/// * **200 pinned notes, which is `SHELF_ROWS` exactly**, all older than the
///   window, so a library that clamped its answer to the window would drop them.
/// * **600 long bodies at 48 KiB**: a list row carries a 200-character preview,
///   so the fold reads 28 MB of text to draw 120 KB of shelf.
/// * **1,200 memos**: the exclusion walks every `about` edge, and its cost is
///   part of the library's.
pub const YEAR3_NOTES: Year3NotesShape = Year3NotesShape {
    notes: 10_000,
    trashed: 400,
    pinned: 200,
    memos: 1_200,
    notebooks: 60,
    filed: 6_000,
    tags: 300,
    tagged: 3_000,
    revisions: 2_000,
    links: 1_500,
    anchored: 700,
    long_body_bytes: 48 * 1024,
    long_bodies: 600,
};

/// What one seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3NotesCounts {
    pub notes: usize,
    /// Live notes that are not memos: what the library's shelf can hold.
    pub live_shelf_notes: usize,
    pub trashed: usize,
    pub pinned: usize,
    pub memos: usize,
    pub notebooks: usize,
    pub tagged: usize,
    pub revisions: usize,
    pub links: usize,
    pub body_bytes: usize,
}

/// Write the profile into a founded vault's connection, notes aimed at `owner`
/// (a person id) for the memos' `about` edges. Deterministic in `seed`.
///
/// Notes are numbered oldest first, so the pinned and the trashed are the low
/// indexes and the window (newest first) never reaches them.
///
/// # Errors
///
/// Whatever the vault refuses a row for; the generator writes only rows the
/// baseline's own constraints accept.
pub fn year3_notes(
    connection: &Connection,
    owner: &str,
    shape: Year3NotesShape,
    seed: u64,
) -> KitResult<Year3NotesCounts> {
    let mut random = Seeded::new(seed);
    let at = |index: usize| instant(index, shape.notes);
    let mut counts = Year3NotesCounts::default();

    let mut entity = connection
        .prepare_cached(
            "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(door)?;
    let mut edge = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO edge (from_id, rel, to_id, anchor, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(door)?;

    for index in 0..shape.notebooks {
        let notebook = id("notebook", index);
        entity
            .execute(params![
                notebook,
                "notebook",
                format!("Notebook {index}"),
                at(0),
                at(0),
                None::<String>,
                None::<String>
            ])
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'notebook', ?2)",
                params![notebook, index as f64],
            )
            .map_err(door)?;
        counts.notebooks += 1;
    }
    for index in 0..shape.tags {
        let tag = id("tag", index);
        entity
            .execute(params![
                tag,
                "tag",
                format!("label {index}"),
                at(0),
                at(0),
                None::<String>,
                None::<String>
            ])
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO concept (id, kind, key) VALUES (?1, 'tag', ?2)",
                params![tag, format!("label {index}")],
            )
            .map_err(door)?;
    }

    let long = "the quick brown fox jumps over the lazy dog and keeps going "
        .repeat(shape.long_body_bytes / 60 + 1);
    let long = &long[..shape.long_body_bytes.min(long.len())];
    // Memos are spread evenly over the live unpinned notes, which start here.
    let first_memo = shape.trashed + shape.pinned;
    let eligible = shape.notes - first_memo;
    let long_every = shape.notes / shape.long_bodies.max(1);
    let filed_every = shape.notes / shape.filed.max(1);
    for index in 0..shape.notes {
        let note = id("note", index);
        let trashed = index < shape.trashed;
        let (deleted, purge) = if trashed {
            (Some(at(index)), Some(at(index + shape.notes)))
        } else {
            (None, None)
        };
        entity
            .execute(params![
                note,
                "note",
                format!("Note {index} about topic {}", random.upto(500)),
                at(index),
                at(index + random.upto(50)),
                deleted,
                purge
            ])
            .map_err(door)?;
        let body = if index % long_every == 0 {
            long.to_owned()
        } else {
            format!(
                "- [ ] first thing for note {index}\n- [x] second thing\n\nsome words about topic {}",
                random.upto(500)
            )
        };
        counts.body_bytes += body.len();
        let notebook = (index % filed_every == 0 && index / filed_every < shape.filed)
            .then(|| id("notebook", random.upto(shape.notebooks.max(1))));
        connection
            .execute(
                "INSERT INTO note (id, body, format, notebook_id) VALUES (?1, ?2, 'markdown', ?3)",
                params![note, body, notebook],
            )
            .map_err(door)?;
        counts.notes += 1;
        if trashed {
            counts.trashed += 1;
        } else {
            counts.live_shelf_notes += 1;
        }
        // Memos are live and unpinned, so each is in exactly one place: the Journal.
        let step = index.saturating_sub(first_memo);
        if index >= first_memo
            && step * shape.memos / eligible != (step + 1) * shape.memos / eligible
        {
            edge.execute(params![note, "about", owner, None::<String>, at(index)])
                .map_err(door)?;
            counts.memos += 1;
            counts.live_shelf_notes -= 1;
        }
    }

    // Pins on the oldest live notes, so every one is outside the window.
    for index in shape.trashed..shape.trashed + shape.pinned {
        edge.execute(params![
            id("note", index),
            "tagged",
            "flag:pinned",
            None::<String>,
            at(index)
        ])
        .map_err(door)?;
        counts.pinned += 1;
    }
    for k in 0..shape.tagged {
        let note = id("note", random.upto(shape.notes));
        let tag = id("tag", k % shape.tags.max(1));
        edge.execute(params![note, "tagged", tag, None::<String>, at(k)])
            .map_err(door)?;
        counts.tagged += 1;
    }
    for k in 0..shape.links {
        let from = random.upto(shape.notes);
        let to = (from * 7 + 3 + k) % shape.notes;
        if from == to {
            continue;
        }
        let anchor = (k < shape.anchored)
            .then(|| format!("{{\"exact\":\"topic {k}\",\"start\":{}}}", k % 40));
        edge.execute(params![
            id("note", from),
            "links",
            id("note", to),
            anchor,
            at(k)
        ])
        .map_err(door)?;
        counts.links += 1;
    }
    let mut next_seq: std::collections::BTreeMap<usize, i64> = std::collections::BTreeMap::new();
    for k in 0..shape.revisions {
        let note = random.upto(shape.notes);
        let seq = next_seq.entry(note).or_insert(0);
        *seq += 1;
        connection
            .execute(
                "INSERT INTO revision (entity_id, seq, at, body) VALUES (?1, ?2, ?3, ?4)",
                params![id("note", note), *seq, at(k), format!("an older draft {k}")],
            )
            .map_err(door)?;
        counts.revisions += 1;
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::instant;

    #[test]
    fn the_span_is_three_civil_years_in_the_vaults_text_form() {
        assert_eq!(instant(0, 10), "2024-01-01T00:00:00.000Z");
        let last = instant(9, 10);
        assert!(last.starts_with("2026-"), "{last}");
        // A leap day exists in 2024 and is walked through.
        assert_eq!(instant(59 * 1_440, 1_576_800), "2024-02-29T00:00:00.000Z");
        assert_eq!(instant(60 * 1_440, 1_576_800), "2024-03-01T00:00:00.000Z");
    }
}
