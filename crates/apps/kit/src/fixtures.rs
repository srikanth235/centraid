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
//! The generators today are Notes', People', Agenda's, Tasks', Docs' and Photos';
//! the next lane that needs a volume adds its own beside them.

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

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/// The volume a People roster is stated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3PeopleShape {
    /// People, live and trashed together (pets are besides these).
    pub people: usize,
    pub trashed: usize,
    /// Pets: persons of form `pet`, which the circle leaves out.
    pub pets: usize,
    /// People carrying the star.
    pub starred: usize,
    /// Lists, and how many people are filed in one.
    pub lists: usize,
    pub filed: usize,
    /// People who carry a birthday column.
    pub birthdays: usize,
    /// Yearly all-day events about a person (an anniversary and the like), and
    /// how many of them have a reminder on.
    pub dates: usize,
    pub reminded: usize,
    /// Touches (an activity `with` a person), and how many have a note about them.
    pub touches: usize,
    pub touch_notes: usize,
    /// Notes about a person, and contact points.
    pub notes: usize,
    pub contact_points: usize,
}

/// THE YEAR-3 PEOPLE PROFILE: 5,000 people, 12,000 important dates (2,000 of
/// them birthdays, the rest yearly events), 20,000 touches.
///
/// * **5,000 against a 10,000-row window**: the roster is declared that wide,
///   so a year-3 roster fits and the walk is ten pages of 500.
/// * **20,000 touches**: last-contacted is computed from them, so the roster's
///   cost is the activities `with` its people.
/// * **8,000 touch notes and 3,000 notes about people**: the notes the search
///   folds into a person's text and the sheet lists.
pub const YEAR3_PEOPLE: Year3PeopleShape = Year3PeopleShape {
    people: 5_000,
    trashed: 250,
    pets: 100,
    starred: 400,
    lists: 12,
    filed: 3_000,
    birthdays: 2_000,
    dates: 10_000,
    reminded: 6_000,
    touches: 20_000,
    touch_notes: 8_000,
    notes: 3_000,
    contact_points: 8_000,
};

/// What one People seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3PeopleCounts {
    /// Live people the circle holds (not trashed, not the owner, not a pet).
    pub live: usize,
    pub trashed: usize,
    pub pets: usize,
    pub starred: usize,
    pub filed: usize,
    pub birthdays: usize,
    pub dates: usize,
    pub reminded: usize,
    pub touches: usize,
    pub touch_notes: usize,
    pub notes: usize,
    pub contact_points: usize,
}

/// Write the profile into a founded vault's connection. Deterministic in `seed`.
///
/// People are numbered oldest first, so the trashed are the low indexes and the
/// window (newest first) is the rest. Every touch and date is aimed at a live
/// person, because a trashed one carries their own words to the trash.
///
/// # Errors
///
/// Whatever the vault refuses a row for; the generator writes only rows the
/// baseline's own constraints accept.
pub fn year3_people(
    connection: &Connection,
    shape: Year3PeopleShape,
    seed: u64,
) -> KitResult<Year3PeopleCounts> {
    let mut random = Seeded::new(seed);
    let at = |index: usize| instant(index, shape.people);
    let mut counts = Year3PeopleCounts::default();
    let mut entity = connection
        .prepare_cached(
            "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(door)?;
    let mut edge = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO edge (from_id, rel, to_id, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(door)?;
    let plain = |kind: &str, id: &str, title: String, created: String| -> KitResult<()> {
        connection
            .prepare_cached(
                "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            )
            .map_err(door)?
            .execute(params![id, kind, title, created])
            .map_err(door)?;
        Ok(())
    };

    for index in 0..shape.lists {
        let list = id("list", index);
        plain("list", &list, format!("List {index}"), at(0))?;
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'list', ?2)",
                params![list, index as f64],
            )
            .map_err(door)?;
    }
    let roles = ["Friend", "Colleague", "Family", "Neighbour", "Mentor"];
    let total = shape.people + shape.pets;
    let filed_every = shape.people / shape.filed.max(1);
    for index in 0..total {
        let pet = index >= shape.people;
        let person = id("person", index);
        let trashed = !pet && index < shape.trashed;
        let created = at(index.min(shape.people));
        entity
            .execute(params![
                person,
                "person",
                format!("Person {index} of {}", random.upto(900)),
                created,
                created,
                trashed.then(|| at(index)),
                trashed.then(|| at(index + shape.people)),
            ])
            .map_err(door)?;
        let birthday = (!pet
            && index % (shape.people / shape.birthdays.max(1)).max(1) == 0
            && counts.birthdays < shape.birthdays)
            .then(|| format!("{:02}-{:02}", 1 + random.upto(12), 1 + random.upto(28)));
        connection
            .execute(
                "INSERT INTO person (id, form, role, birthday, cadence_days) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    person,
                    if pet { "pet" } else { "person" },
                    if pet { "dog".to_owned() } else { roles[index % roles.len()].to_owned() },
                    birthday,
                    (!pet && index % 3 != 0).then(|| [7_i64, 14, 30, 90][index % 4]),
                ],
            )
            .map_err(door)?;
        if birthday.is_some() {
            counts.birthdays += 1;
        }
        if pet {
            counts.pets += 1;
            continue;
        }
        if trashed {
            counts.trashed += 1;
            continue;
        }
        counts.live += 1;
        if index % filed_every == 0 && counts.filed < shape.filed {
            edge.execute(params![
                id("list", random.upto(shape.lists.max(1))),
                "contains",
                person,
                counts.filed as f64,
                created
            ])
            .map_err(door)?;
            counts.filed += 1;
        }
    }
    let live = |k: usize| id("person", shape.trashed + k % (shape.people - shape.trashed));
    for k in 0..shape.starred {
        edge.execute(params![
            live(k * 11),
            "tagged",
            "flag:starred",
            None::<f64>,
            at(k)
        ])
        .map_err(door)?;
        counts.starred += 1;
    }
    for k in 0..shape.dates {
        let date = id("date", k);
        plain("event", &date, format!("Anniversary {k}"), at(k))?;
        let reminded = k < shape.reminded;
        connection
            .execute(
                "INSERT INTO event (id, starts, timing, rule, calendar_id, reminders)
                 VALUES (?1, ?2, 'all-day', 'FREQ=YEARLY', 'calendar:default', ?3)",
                params![
                    date,
                    format!("2024-{:02}-{:02}", 1 + k % 12, 1 + k % 28),
                    reminded.then_some("[0]")
                ],
            )
            .map_err(door)?;
        edge.execute(params![date, "about", live(k * 7), None::<f64>, at(k)])
            .map_err(door)?;
        counts.dates += 1;
        counts.reminded += usize::from(reminded);
    }
    let kinds = ["call", "message", "met-up", "note"];
    for k in 0..shape.touches {
        let touch = id("touch", k);
        plain("activity", &touch, "Touch".to_owned(), at(k))?;
        connection
            .execute(
                "INSERT INTO activity (id, type_id, type_kind, starts) VALUES (?1, ?2, 'activity_kind', ?3)",
                params![touch, format!("activity_kind:{}", kinds[k % kinds.len()]), at(k * shape.people / shape.touches.max(1))],
            )
            .map_err(door)?;
        edge.execute(params![
            touch,
            "with",
            live(random.upto(shape.people)),
            None::<f64>,
            at(k)
        ])
        .map_err(door)?;
        counts.touches += 1;
        if k < shape.touch_notes {
            let note = id("touch-note", k);
            plain("note", &note, "Touch".to_owned(), at(k))?;
            connection
                .execute(
                    "INSERT INTO note (id, body, format) VALUES (?1, ?2, 'plain')",
                    params![note, format!("talked about topic {}", random.upto(500))],
                )
                .map_err(door)?;
            edge.execute(params![note, "about", touch, None::<f64>, at(k)])
                .map_err(door)?;
            counts.touch_notes += 1;
        }
    }
    for k in 0..shape.notes {
        let note = id("person-note", k);
        plain("note", &note, format!("Note {k}"), at(k))?;
        connection
            .execute(
                "INSERT INTO note (id, body, format) VALUES (?1, ?2, 'plain')",
                params![note, format!("a thing to remember, number {k}")],
            )
            .map_err(door)?;
        edge.execute(params![
            note,
            "about",
            live(random.upto(shape.people)),
            None::<f64>,
            at(k)
        ])
        .map_err(door)?;
        counts.notes += 1;
    }
    let mut point = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO contact_point (id, person_id, kind, value, normalized, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(door)?;
    for k in 0..shape.contact_points {
        let (kind, value) = if k % 2 == 0 {
            ("phone", format!("+1555{k:07}"))
        } else {
            ("email", format!("person{k}@example.test"))
        };
        point
            .execute(params![
                id("point", k),
                live(k),
                kind,
                value.clone(),
                value,
                k as f64
            ])
            .map_err(door)?;
        counts.contact_points += 1;
    }
    Ok(counts)
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

/// The volume an Agenda is stated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3EventsShape {
    /// Zoned one-off events across three years, and all-day ones.
    pub timed: usize,
    pub all_day: usize,
    /// Series: the first `daily` every day, the rest mostly weekly and some monthly; the first
    /// `overridden` of them carry occurrence rows (one moved, one cancelled).
    pub series: usize,
    /// How many of the series (the first) repeat every day.
    pub daily: usize,
    pub overridden: usize,
    /// Events carrying the cancelled status, and events in the trash.
    pub cancelled: usize,
    pub trashed: usize,
    /// Guests: people on the roster, and how many events have two of them.
    pub guests: usize,
    pub guested: usize,
}

/// THE YEAR-3 AGENDA PROFILE: 12,000 events (2,000 all-day) and 800 daily
/// series, 600 of them with overrides, 300 cancelled, 200 trashed and 3,000 with
/// guests.
///
/// * **12,000 events against `EVENT_WINDOW_CAP` 2,000**: a year-3 calendar is six
///   windows deep, so the window is a stated ceiling rather than "everything".
/// * **800 series against `RECURRING_ANCHOR_CAP` 1,000**: under the cap on
///   purpose, close enough that a port which merged the two reads would show it.
/// * **800 DAILY series over the default window is tens of thousands of
///   occurrences against `MAX_TOTAL_INSTANCES` 1,500**: the year-3 agenda TRIPS
///   the expansion bound, which is the only way to know the bound reports the
///   size it reaches rather than returning a short agenda that reads as a whole
///   one (D-1020-D3-12). A realistic calendar (a few dozen series, a handful
///   daily) is the agenda test's own shape and answers whole.
pub const YEAR3_EVENTS: Year3EventsShape = Year3EventsShape {
    timed: 10_000,
    all_day: 2_000,
    series: 800,
    daily: 800,
    overridden: 600,
    cancelled: 300,
    trashed: 200,
    guests: 400,
    guested: 3_000,
};

/// What one Agenda seeding wrote.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Year3EventsCounts {
    /// Events not trashed (cancelled ones included).
    pub live: usize,
    pub series: usize,
    pub overrides: usize,
    pub cancelled: usize,
    pub trashed: usize,
    /// The trashed events' ids, so a read's answer can be checked against them.
    pub trashed_ids: Vec<String>,
    pub attendees: usize,
}

/// Write the Agenda profile into a founded vault's connection.
///
/// Events are numbered oldest first; the trashed and the cancelled are spread
/// by stride so a window finds both. Every event is in the default calendar.
///
/// # Errors
///
/// Whatever the vault refuses a row for.
pub fn year3_events(
    connection: &Connection,
    shape: Year3EventsShape,
    seed: u64,
) -> KitResult<Year3EventsCounts> {
    let mut random = Seeded::new(seed);
    let total = shape.timed + shape.all_day + shape.series;
    let at = |index: usize| instant(index, total);
    let mut counts = Year3EventsCounts::default();
    let mut entity = connection
        .prepare_cached(
            "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)",
        )
        .map_err(door)?;
    let mut event = connection
        .prepare_cached(
            "INSERT INTO event (id, starts, ends, timing, zone, rule, status, calendar_id, description)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'calendar:default', ?8)",
        )
        .map_err(door)?;
    let mut edge = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO edge (from_id, rel, to_id, state, created_at)
             VALUES (?1, 'attendee', ?2, ?3, ?4)",
        )
        .map_err(door)?;
    for k in 0..shape.guests {
        let guest = id("guest", k);
        connection
            .execute(
                "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES (?1, 'person', ?2, ?3, ?3)",
                params![guest, format!("Guest {k}"), at(0)],
            )
            .map_err(door)?;
        connection
            .execute("INSERT INTO person (id) VALUES (?1)", params![guest])
            .map_err(door)?;
    }
    // The first `daily` series repeat every day; the rest are mostly weekly.
    let rule_of = |ordinal: usize| match ordinal {
        _ if ordinal < shape.daily => "FREQ=DAILY",
        _ if ordinal.is_multiple_of(4) => "FREQ=MONTHLY",
        _ => "FREQ=WEEKLY",
    };
    let zones = ["Europe/London", "America/New_York", "Asia/Kolkata"];
    let cancel_every = total / shape.cancelled.max(1);
    let trash_every = total / shape.trashed.max(1);
    for index in 0..total {
        let (kind, ordinal) = if index < shape.series {
            ("series", index)
        } else if index < shape.series + shape.timed {
            ("timed", index - shape.series)
        } else {
            ("all-day", index - shape.series - shape.timed)
        };
        let row = id("event", index);
        let start = at(index);
        let trashed = counts.trashed < shape.trashed && index % trash_every.max(1) == 1;
        let cancelled =
            !trashed && counts.cancelled < shape.cancelled && index % cancel_every.max(1) == 2;
        entity
            .execute(params![
                row,
                "event",
                format!("Event {index} of {}", random.upto(900)),
                start,
                trashed.then(|| at(index + 1)),
                trashed.then(|| at(index + total)),
            ])
            .map_err(door)?;
        let status = if cancelled { "cancelled" } else { "confirmed" };
        let note = (index % 5 == 0).then(|| format!("agenda item {index}"));
        match kind {
            "all-day" => event.execute(params![
                row,
                &start[..10],
                None::<String>,
                "all-day",
                None::<String>,
                None::<String>,
                status,
                note
            ]),
            _ => {
                let rule = (kind == "series").then(|| rule_of(ordinal).to_owned());
                let end = at(index + 1);
                event.execute(params![
                    row,
                    start,
                    // A series spans an hour; a one-off is the next step in the span.
                    if rule.is_some() { start.clone() } else { end },
                    "zoned",
                    zones[index % zones.len()],
                    rule,
                    status,
                    note
                ])
            }
        }
        .map_err(door)?;
        if trashed {
            counts.trashed += 1;
            counts.trashed_ids.push(row);
            continue;
        }
        counts.live += 1;
        counts.cancelled += usize::from(cancelled);
        if kind == "series" {
            counts.series += 1;
            if ordinal < shape.overridden {
                for (day, cancel) in [(7_i64, false), (14, true)] {
                    connection
                        .execute(
                            "INSERT INTO occurrence (series_id, original_start, scope, cancelled, starts, ends)
                             VALUES (?1, ?2, 'occurrence', ?3, ?4, ?5)",
                            params![
                                row,
                                format!("{}T{}", plus_days(&start, day), &start[11..23]),
                                i64::from(cancel),
                                (!cancel).then(|| format!("{}T{}", plus_days(&start, day), "17:00:00.000Z")),
                                (!cancel).then(|| format!("{}T{}", plus_days(&start, day), "18:00:00.000Z")),
                            ],
                        )
                        .map_err(door)?;
                    counts.overrides += 1;
                }
            }
        }
        if counts.attendees / 2 < shape.guested && shape.guests > 1 && index % 3 == 0 {
            for _ in 0..2 {
                let inserted = edge
                    .execute(params![
                        row,
                        id("guest", random.upto(shape.guests)),
                        ["accepted", "needs-action", "tentative", "declined"][random.upto(4)],
                        start
                    ])
                    .map_err(door)?;
                counts.attendees += inserted;
            }
        }
    }
    Ok(counts)
}

/// `start` (the vault's instant text) moved `days` later, as its date only.
fn plus_days(start: &str, days: i64) -> String {
    let parse = |from: usize, to: usize| start[from..to].parse::<i64>().unwrap_or(1);
    let (mut year, mut month, mut day) = (parse(0, 4), parse(5, 7), parse(8, 10) + days);
    loop {
        let length = match month {
            2 if year % 4 == 0 => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if day <= length {
            break;
        }
        day -= length;
        month += 1;
        if month > 12 {
            month = 1;
            year += 1;
        }
    }
    format!("{year:04}-{month:02}-{day:02}")
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/// The volume a Tasks board is stated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3TasksShape {
    /// Open, done and cancelled tasks, live; the trashed are besides these.
    pub open: usize,
    pub done: usize,
    pub cancelled: usize,
    pub trashed: usize,
    /// Projects, and sections in each.
    pub projects: usize,
    pub sections: usize,
    /// Open tasks with a due day (the rest are the Inbox), and repeating ones.
    pub dated: usize,
    pub repeating: usize,
    /// Open tasks that are a subtask of another, and tagged ones.
    pub subtasks: usize,
    pub tagged: usize,
}

/// THE YEAR-3 TASKS PROFILE: 3,000 open and 12,000 done tasks over three
/// years, 40 projects of 4 sections, 200 repeating.
///
/// * **12,000 closed**: the logbook is a bounded read of the newest, and the
///   open walk never touches them.
/// * **3,000 open against a 32,000-row walk**: the board fits.
pub const YEAR3_TASKS: Year3TasksShape = Year3TasksShape {
    open: 3_000,
    done: 12_000,
    cancelled: 400,
    trashed: 300,
    projects: 40,
    sections: 4,
    dated: 1_800,
    repeating: 200,
    subtasks: 600,
    tagged: 1_200,
};

/// What one Tasks seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3TasksCounts {
    pub open: usize,
    pub done: usize,
    pub cancelled: usize,
    pub trashed: usize,
    pub projects: usize,
    pub sections: usize,
    pub dated: usize,
    pub repeating: usize,
    pub subtasks: usize,
    pub tagged: usize,
}

/// Write the Tasks profile into a founded vault's connection.
///
/// Tasks are numbered oldest first. A subtask is the open task before it, so a
/// parent is never trashed or closed under its child; a repeating task is its
/// own series.
///
/// # Errors
///
/// Whatever the vault refuses a row for.
pub fn year3_tasks(
    connection: &Connection,
    shape: Year3TasksShape,
    seed: u64,
) -> KitResult<Year3TasksCounts> {
    let mut random = Seeded::new(seed);
    let total = shape.open + shape.done + shape.cancelled + shape.trashed;
    let at = |index: usize| instant(index, total);
    let mut counts = Year3TasksCounts::default();
    let plain = |kind: &str, row: &str, title: String, created: &str| -> KitResult<()> {
        connection
            .prepare_cached(
                "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            )
            .map_err(door)?
            .execute(params![row, kind, title, created])
            .map_err(door)?;
        Ok(())
    };
    for p in 0..shape.projects {
        let project = id("project", p);
        plain("project", &project, format!("Project {p}"), &at(0))?;
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'project', ?2)",
                params![project, p as f64],
            )
            .map_err(door)?;
        counts.projects += 1;
        for q in 0..shape.sections {
            let section = id(&format!("section-{p}"), q);
            plain("section", &section, format!("Section {q}"), &at(0))?;
            connection
                .execute(
                    "INSERT INTO container (id, kind, parent_id, position) VALUES (?1, 'section', ?2, ?3)",
                    params![section, project, q as f64],
                )
                .map_err(door)?;
            counts.sections += 1;
        }
    }
    let tags = 20;
    for t in 0..tags {
        let tag = id("tag", t);
        plain("tag", &tag, format!("tag{t}"), &at(0))?;
        connection
            .execute(
                "INSERT INTO concept (id, kind, key) VALUES (?1, 'tag', ?2)",
                params![tag, format!("tag{t}")],
            )
            .map_err(door)?;
    }
    let mut entity = connection
        .prepare_cached(
            "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
             VALUES (?1, 'task', ?2, ?3, ?3, ?4, ?5)",
        )
        .map_err(door)?;
    let mut task = connection
        .prepare_cached(
            "INSERT INTO task (id, status, priority, due, done_at, rule, series_id, parent_id,
                               project_id, section_id, description, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11)",
        )
        .map_err(door)?;
    let mut tagged = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO edge (from_id, rel, to_id, created_at) VALUES (?1, 'tagged', ?2, ?3)",
        )
        .map_err(door)?;
    let (closed_end, cancelled_end) = (shape.done, shape.done + shape.cancelled);
    let mut last_open: Option<String> = None;
    for index in 0..total {
        let row = id("task", index);
        let created = at(index);
        let (status, trashed) = if index < closed_end {
            ("done", false)
        } else if index < cancelled_end {
            ("cancelled", false)
        } else if index < cancelled_end + shape.trashed {
            ("open", true)
        } else {
            ("open", false)
        };
        entity
            .execute(params![
                row,
                format!("Task {index} of {}", random.upto(900)),
                created,
                trashed.then(|| at(index + 1)),
                trashed.then(|| at(index + total)),
            ])
            .map_err(door)?;
        let live_open = status == "open" && !trashed;
        let open_ordinal = counts.open;
        let dated = live_open && open_ordinal < shape.dated;
        let repeating = dated && open_ordinal < shape.repeating;
        let subtask = live_open
            && !repeating
            && counts.subtasks < shape.subtasks
            && open_ordinal % 4 == 3
            && last_open.is_some();
        let number = index % shape.projects.max(1);
        let project = (index % 3 != 0 && !trashed).then(|| id("project", number));
        let section = project
            .as_ref()
            .filter(|_| index % 2 == 0)
            .map(|_| id(&format!("section-{number}"), index % shape.sections.max(1)));
        task.execute(params![
            row,
            status,
            (index % 10).min(9) as i64,
            (dated || (status == "done" && index % 2 == 0))
                .then(|| at(index.saturating_sub(1))[..10].to_owned()),
            (status == "done").then(|| at(index)),
            repeating.then_some("FREQ=WEEKLY"),
            subtask.then(|| last_open.clone()).flatten(),
            project,
            section,
            (index % 7 == 0).then(|| format!("remember {index}")),
            index as f64,
        ])
        .map_err(door)?;
        match status {
            "done" => counts.done += 1,
            "cancelled" => counts.cancelled += 1,
            _ if trashed => counts.trashed += 1,
            _ => {
                counts.open += 1;
                counts.dated += usize::from(dated);
                counts.repeating += usize::from(repeating);
                counts.subtasks += usize::from(subtask);
                if !subtask {
                    last_open = Some(row.clone());
                }
            }
        }
        if live_open && counts.tagged < shape.tagged && index % 2 == 1 {
            tagged
                .execute(params![row, id("tag", random.upto(tags)), created])
                .map_err(door)?;
            counts.tagged += 1;
        }
    }
    Ok(counts)
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

/// A 64-hex blob hash that is a function of a namespace and an index: unique,
/// well formed (the `blob.hash` CHECK), and ordered the way the index is.
fn hash_of(namespace: u64, index: usize) -> String {
    format!("{:016x}{:048x}", namespace, index)
}

/// The volume a Docs drive is stated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3DocsShape {
    /// Documents, live and trashed together.
    pub documents: usize,
    /// How many of them are in the trash (the oldest, so the window never reaches them).
    pub trashed: usize,
    /// How many carry a star.
    pub starred: usize,
    /// Folders, spread over `folder_depth` levels.
    pub folders: usize,
    pub folder_depth: usize,
    /// Labels (tags), and how many documents carry one.
    pub labels: usize,
    pub labelled: usize,
    /// Documents whose bytes were replaced once: a `revision` row each.
    pub extra_versions: usize,
}

/// THE YEAR-3 DOCS PROFILE: 8,000 documents over 400 folders four levels deep.
///
/// Each number is the reason it is here:
///
/// * **8,000 documents against a 2,000-row window.** The drive's declared
///   maximum is 2,000, so a year-3 drive is four windows deep and `truncated`
///   has to be the page's own cursor rather than a row count.
/// * **400 folders four levels deep**: the folder rail is read whole and the
///   path of a document is walked up the tree.
/// * **2,000 labels over 4,000 documents** and **600 stars**: `docs.rows.tagged`
///   is a `(document, tag)` pair read over the window, which is why its bound is
///   a fan-out bound and not a row count.
/// * **2,000 replaced versions**: each is a `revision` row and a second blob, so
///   10,000 blobs stand behind 8,000 documents.
pub const YEAR3_DOCS: Year3DocsShape = Year3DocsShape {
    documents: 8_000,
    trashed: 400,
    starred: 600,
    folders: 400,
    folder_depth: 4,
    labels: 2_000,
    labelled: 4_000,
    extra_versions: 2_000,
};

/// What one year-3 Docs seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3DocsCounts {
    pub documents: usize,
    pub live_documents: usize,
    pub trashed: usize,
    pub starred: usize,
    pub folders: usize,
    /// Blob rows: one per document, one more per replaced version.
    pub blobs: usize,
    pub revisions: usize,
    /// Label edges (the star is counted apart).
    pub labelled: usize,
}

/// Write the Docs profile into a founded vault's connection. Deterministic in
/// `seed`. Documents are numbered oldest first, and the trashed are the low
/// indexes, so a window (newest first) never reaches them and the trash shelf
/// has to read its own set.
///
/// **Creation instants repeat on purpose**: two documents share every `created_at`,
/// because the keyset page's whole reason for carrying the pk is that the sort key
/// is not unique.
///
/// # Errors
///
/// Whatever the vault refuses a row for; the generator writes only rows the
/// baseline's own constraints accept.
pub fn year3_docs(
    connection: &Connection,
    shape: Year3DocsShape,
    seed: u64,
) -> KitResult<Year3DocsCounts> {
    let mut random = Seeded::new(seed);
    let at = |index: usize| instant(index / 2, shape.documents.div_ceil(2));
    let mut counts = Year3DocsCounts::default();

    let mut entity = connection
        .prepare_cached(
            "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(door)?;
    let mut blob = connection
        .prepare_cached("INSERT INTO blob (hash, size) VALUES (?1, ?2)")
        .map_err(door)?;
    let mut edge = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO edge (from_id, rel, to_id, anchor, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(door)?;

    // The tree. A folder's parent is one of the previous LEVEL's, so the depth is
    // a property of the arithmetic and not of a random pick.
    let per_level = (shape.folders / shape.folder_depth.max(1)).max(1);
    for index in 0..shape.folders {
        let folder = id("folder", index);
        let level = index / per_level;
        let parent = (level > 0).then(|| id("folder", (index - per_level).min(shape.folders - 1)));
        entity
            .execute(params![
                folder,
                "folder",
                format!("Folder {index:06}"),
                at(0),
                at(0),
                None::<String>,
                None::<String>
            ])
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO container (id, kind, parent_id, position) VALUES (?1, 'folder', ?2, ?3)",
                params![folder, parent, index as f64],
            )
            .map_err(door)?;
        counts.folders += 1;
    }
    for index in 0..shape.labels {
        let tag = id("label", index);
        entity
            .execute(params![
                tag,
                "tag",
                format!("label-{index:06}"),
                at(0),
                at(0),
                None::<String>,
                None::<String>
            ])
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO concept (id, kind, key) VALUES (?1, 'tag', ?2)",
                params![tag, format!("label-{index:06}")],
            )
            .map_err(door)?;
    }

    let mut older_blobs = 0usize;
    for index in 0..shape.documents {
        let document = id("document", index);
        let trashed = index < shape.trashed;
        let stamped = at(index);
        let body = format!("# Document {index:06}\n\nFiled {stamped}.\n");
        let current = hash_of(0xd0c5, index);
        blob.execute(params![current, body.len() as i64])
            .map_err(door)?;
        counts.blobs += 1;
        let (deleted, purge) = if trashed {
            (Some(stamped.clone()), Some(at(index + shape.documents)))
        } else {
            (None, None)
        };
        entity
            .execute(params![
                document,
                "document",
                format!("Document {index:06}"),
                stamped,
                stamped,
                deleted,
                purge
            ])
            .map_err(door)?;
        let folder = id("folder", random.upto(shape.folders.max(1)));
        connection
            .execute(
                "INSERT INTO document (id, blob, media_type, folder_id)
                 VALUES (?1, ?2, 'text/markdown', ?3)",
                params![document, current, (shape.folders > 0).then_some(folder)],
            )
            .map_err(door)?;
        counts.documents += 1;
        if trashed {
            counts.trashed += 1;
        } else {
            counts.live_documents += 1;
        }
        // The replaced version: a second blob, and the revision that holds it.
        if index < shape.extra_versions {
            let older = hash_of(0x01d0, older_blobs);
            older_blobs += 1;
            blob.execute(params![older, 40_i64]).map_err(door)?;
            counts.blobs += 1;
            connection
                .execute(
                    "INSERT INTO revision (entity_id, seq, at, blob, media_type)
                     VALUES (?1, 1, ?2, ?3, 'text/markdown')",
                    params![document, stamped, older],
                )
                .map_err(door)?;
            counts.revisions += 1;
        }
        if index < shape.starred {
            edge.execute(params![
                document,
                "tagged",
                "flag:starred",
                None::<String>,
                stamped
            ])
            .map_err(door)?;
            counts.starred += 1;
        }
        if index < shape.labelled {
            let label = id("label", random.upto(shape.labels.max(1)));
            edge.execute(params![document, "tagged", label, None::<String>, stamped])
                .map_err(door)?;
            counts.labelled += 1;
        }
    }
    Ok(counts)
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/// The volume a Photos library is stated at.
///
/// **A count is not a distribution.** `near_duplicate_families` and `family_size`
/// are what give the clustering something to find; without them a 90,000-photo
/// fixture measures a table scan and calls it a duplicates screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3PhotosShape {
    pub assets: usize,
    /// One in this many photographs is trashed, so the trash shelf is non-empty
    /// and the live window has to exclude something.
    pub trashed_every: usize,
    /// One in this many is archived: in NEITHER shelf.
    pub archived_every: usize,
    /// One in this many is starred: a flag edge, so the fixture exercises the
    /// join every Photos surface makes.
    pub starred_every: usize,
    /// Groups of visually similar frames, so the clustering finds something.
    pub near_duplicate_families: usize,
    pub family_size: usize,
    /// Places, so the grid's place join is not trivial.
    pub places: usize,
    /// Albums, and how many members each carries.
    pub albums: usize,
    pub album_members: usize,
    /// One in this many photographs starts a burst of two stills (the older is
    /// folded under the newer), so the library's fold has work to do.
    pub burst_every: usize,
}

/// The `year3-photos` volume: 90,000 photographs and 3,000 near-duplicate families.
///
/// 3,000 families of three are 9,000 fingerprints against a 4,000-fingerprint
/// duplicates read, so the review surface is built to trip its cap.
pub const YEAR3_PHOTOS: Year3PhotosShape = Year3PhotosShape {
    assets: 90_000,
    trashed_every: 250,
    archived_every: 500,
    starred_every: 50,
    near_duplicate_families: 3_000,
    family_size: 3,
    places: 400,
    albums: 40,
    album_members: 50,
    burst_every: 100,
};

/// The `year3-50k-assets` volume: the 50,000 photographs a reference phone is asked
/// to browse (the figure `tests/journeys.json` states its device targets at), with
/// 1,500 families of three. The library, the trash and the duplicates read meet the
/// same bounds here as at 90,000; only the sweep's volume differs.
pub const YEAR3_50K_ASSETS: Year3PhotosShape = Year3PhotosShape {
    assets: 50_000,
    near_duplicate_families: 1_500,
    ..YEAR3_PHOTOS
};

/// What a year-3 Photos seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3PhotosCounts {
    pub assets: usize,
    /// Neither trashed nor archived.
    pub live_assets: usize,
    pub trashed: usize,
    pub archived: usize,
    pub starred: usize,
    pub phashes: usize,
    /// Live photographs in a near-duplicate family.
    pub clustered: usize,
    pub places: usize,
    pub album_entries: usize,
    pub bursts: usize,
}

/// Seed the Photos axis of year-3 volume into a founded vault's connection.
///
/// **Capture times repeat on purpose.** Photographs share a `taken_at` in pairs,
/// because the keyset page's whole reason for carrying the pk is that the sort
/// key is not unique: a fixture with distinct timestamps cannot trip the page
/// boundary the cursor exists for.
///
/// # Errors
///
/// Whatever the vault refuses a row for.
#[expect(
    clippy::too_many_lines,
    reason = "one generator, one reading order, as the others here"
)]
pub fn year3_photos(
    connection: &Connection,
    shape: Year3PhotosShape,
    seed: u64,
) -> KitResult<Year3PhotosCounts> {
    let mut random = Seeded::new(seed);
    let at = |index: usize| instant(index / 2, shape.assets.div_ceil(2));
    let created = at(0);
    let mut counts = Year3PhotosCounts::default();

    let mut entity = connection
        .prepare_cached(
            "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(door)?;
    let mut edge = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO edge (from_id, rel, to_id, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(door)?;

    for index in 0..shape.places {
        let place = id("place", index);
        entity
            .execute(params![
                place,
                "place",
                format!("Place {index:04}"),
                created,
                created,
                None::<String>,
                None::<String>
            ])
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO place (id, lat, lon, locality, zone) VALUES (?1, ?2, ?3, ?4, 'America/Los_Angeles')",
                params![
                    place,
                    36.0 + (index as f64) / 1_000.0,
                    -122.0 + (index as f64) / 1_000.0,
                    format!("Town {index:04}")
                ],
            )
            .map_err(door)?;
        counts.places += 1;
    }
    for index in 0..shape.albums {
        let album = id("album", index);
        entity
            .execute(params![
                album,
                "album",
                format!("Album {index:03}"),
                created,
                created,
                None::<String>,
                None::<String>
            ])
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'album', ?2)",
                params![album, index as f64],
            )
            .map_err(door)?;
    }

    for index in 0..shape.assets {
        let photo = id("asset", index);
        let hash = hash_of(0x9407, index);
        let taken = at(index);
        let trashed = index.is_multiple_of(shape.trashed_every);
        // The LAST of each `archived_every`, never the first: `archived_every` is a
        // multiple of `trashed_every`, and the first of each would always be trashed.
        let archived = !trashed && index % shape.archived_every == shape.archived_every - 1;
        connection
            .execute(
                "INSERT INTO blob (hash, size) VALUES (?1, ?2)",
                params![hash, 2_000_000 + random.upto(1_000_000) as i64],
            )
            .map_err(door)?;
        entity
            .execute(params![
                photo,
                "photo",
                format!("Frame {index:06}"),
                taken,
                taken,
                trashed.then(|| taken.clone()),
                trashed.then(|| at(index + shape.assets)),
            ])
            .map_err(door)?;
        // A burst is a pair of stills: the older is folded under the newer.
        let burst = (shape.burst_every > 0 && index / 2 % shape.burst_every == 0)
            .then(|| id("burst", index / 2));
        if burst.is_some() && index % 2 == 0 {
            counts.bursts += 1;
        }
        connection
            .execute(
                "INSERT INTO photo
                   (id, blob, media_type, form, taken_at, offset_min, width, height, burst, place_id)
                 VALUES (?1, ?2, 'image/jpeg', 'photo', ?3, -420, 4032, 3024, ?4, ?5)",
                params![
                    photo,
                    hash,
                    taken,
                    burst,
                    (shape.places > 0).then(|| id("place", index % shape.places)),
                ],
            )
            .map_err(door)?;
        counts.assets += 1;
        if trashed {
            counts.trashed += 1;
        } else if archived {
            counts.archived += 1;
        } else {
            counts.live_assets += 1;
        }
        if archived {
            edge.execute(params![
                photo,
                "tagged",
                "flag:archived",
                None::<f64>,
                taken
            ])
            .map_err(door)?;
        }
        if index.is_multiple_of(shape.starred_every) {
            edge.execute(params![photo, "tagged", "flag:starred", None::<f64>, taken])
                .map_err(door)?;
            counts.starred += 1;
        }
        // The perceptual hash, and the near-duplicate families: the first
        // `families * family_size` photographs are grouped, every member of a
        // family sharing a base digest with one bit flipped (two members are
        // two bits apart, inside the threshold of six). Every later photograph
        // gets a digest far from every other.
        let family = index / shape.family_size.max(1);
        let phash = if family < shape.near_duplicate_families {
            let member = index % shape.family_size.max(1);
            let base = (family as u64).wrapping_mul(0x9e37_79b9) & 0x0fff_ffff_ffff_ffff;
            format!("{:016x}", base ^ (1_u64 << (member * 4)))
        } else {
            format!(
                "{:016x}",
                (index as u64).wrapping_mul(0xff51_afd7_ed55_8ccd)
            )
        };
        connection
            .execute(
                "INSERT INTO derivative (blob, variant, text, created_at)
                 VALUES (?1, 'phash', ?2, ?3)",
                params![hash, phash, taken],
            )
            .map_err(door)?;
        counts.phashes += 1;
        if family < shape.near_duplicate_families && !trashed {
            counts.clustered += 1;
        }
        if index < shape.album_members * shape.albums {
            edge.execute(params![
                id("album", index % shape.albums),
                "contains",
                photo,
                (index / shape.albums) as f64,
                taken
            ])
            .map_err(door)?;
            counts.album_entries += 1;
        }
    }
    Ok(counts)
}

/// Every photograph's perceptual hash, as `(photo id, phash)`: the fingerprints a
/// test hands the clustering to prove the generator seeded a real cluster.
///
/// # Errors
///
/// Whatever the vault refuses a read for.
pub fn photo_fingerprints(connection: &Connection) -> KitResult<Vec<(String, String)>> {
    let mut statement = connection
        .prepare(
            "SELECT p.id, d.text FROM photo p JOIN derivative d ON d.blob = p.blob AND d.variant = 'phash'
             WHERE p.id IN (SELECT id FROM entity WHERE deleted_at IS NULL) ORDER BY p.id",
        )
        .map_err(door)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(door)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(door)?;
    Ok(rows)
}

/// How many photographs are neither trashed nor archived.
///
/// # Errors
///
/// Whatever the vault refuses a read for.
pub fn live_photo_count(connection: &Connection) -> KitResult<i64> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM photo
             WHERE id IN (SELECT id FROM entity WHERE deleted_at IS NULL)
               AND id NOT IN (SELECT from_id FROM edge WHERE rel = 'tagged' AND to_id = 'flag:archived')",
            [],
            |row| row.get(0),
        )
        .map_err(door)
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
