//! THE ASSISTANT'S READS ARE BOUNDED BY CONSTRUCTION (#1188, C3).
//!
//! The world the model reads used to hold every row of ten tables and was read again after every
//! write: past a hundred thousand rows in one table the door refused and the turn failed. Now each
//! kind is its newest `WINDOW_ROWS` entities, and everything else is read by chunks of those ids.
//! These tests count what a world asks of the door (statements, rows in one answer, rows held) and
//! never how long it took: the bounds are constants of the runtime, so they hold at any vault size.

mod year3_corpus;

use std::sync::{Arc, Mutex};

use centraid_apps_kit::row::Row;
use centraid_apps_kit::search_corpus::{SearchCorpusShape, YEAR3_ROWS};
use centraid_assist::native::dates::parse_now;
use centraid_assist::native::door::{Occurrence, Window, WindowQuery};
use centraid_assist::native::meta::Kind;
use centraid_assist::native::session::{Flags, Session};
use centraid_assist::native::world::{PINNED_ROWS, Standing, WINDOW_ROWS, World};
use centraid_assist::native::{Call, Door, Ran};
use centraid_search::Target;
use serde_json::{Value, json};

/// What the door was asked, by counts.
#[derive(Debug, Default, Clone, Copy)]
struct Asked {
    /// Statements: one per page of a table read, window, event window and search.
    statements: usize,
    /// Rows the door answered in all.
    rows: usize,
    /// The most rows any one answer held.
    widest: usize,
    /// Reads that took a table without a predicate (the whole table, bar the vault's one row).
    whole_tables: usize,
}

struct Counting {
    inner: centraid_core::assist::door::CoreDoor,
    asked: Arc<Mutex<Asked>>,
}

impl Counting {
    fn of(handle: &centraid_core::Handle) -> (Self, Arc<Mutex<Asked>>) {
        let asked = Arc::new(Mutex::new(Asked::default()));
        (
            Self {
                inner: handle.assist_door(),
                asked: Arc::clone(&asked),
            },
            asked,
        )
    }

    fn note(&self, rows: usize) {
        let mut asked = self.asked.lock().expect("counts");
        asked.statements += 1;
        asked.rows += rows;
        asked.widest = asked.widest.max(rows);
    }
}

impl Door for Counting {
    fn table(&self, table: &str, columns: &str, sort: &str, pk: &str) -> Result<Vec<Row>, String> {
        let rows = self.inner.table(table, columns, sort, pk)?;
        self.note(rows.len());
        if table != "vault" {
            self.asked.lock().expect("counts").whole_tables += 1;
        }
        Ok(rows)
    }

    fn table_where(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
        predicate: &str,
        binds: &[String],
    ) -> Result<Vec<Row>, String> {
        let rows = self
            .inner
            .table_where(table, columns, sort, pk, predicate, binds)?;
        self.note(rows.len());
        Ok(rows)
    }

    fn window(&self, query: &WindowQuery<'_>) -> Result<Window, String> {
        let window = self.inner.window(query)?;
        self.note(window.rows.len());
        Ok(window)
    }

    fn events(&self, from_day: &str, to_day: &str, tz: &str) -> Result<Vec<Occurrence>, String> {
        let found = self.inner.events(from_day, to_day, tz)?;
        self.note(found.len());
        Ok(found)
    }

    fn search(&self, entity: &str, text: &str, limit: usize) -> Result<Vec<Target>, String> {
        let found = self.inner.search(entity, text, limit)?;
        self.note(found.len());
        Ok(found)
    }

    fn act(&self, call: &Call, input: Value) -> Result<Ran, String> {
        self.inner.act(call, input)
    }

    fn advance(&self) {
        self.inner.advance();
    }

    fn now_ms(&self) -> i64 {
        self.inner.now_ms()
    }

    fn mint_id(&self) -> String {
        self.inner.mint_id()
    }
}

const TODAY: &str = "2026-11-12";

fn standing() -> Standing {
    Standing {
        today: "2026-11-12".parse().expect("a date"),
        tz: "Etc/UTC".to_owned(),
    }
}

/// The most statements a world's load may ask, whatever the vault holds: the vault row, one window
/// per windowed kind, the ids of every kind in chunks of 200 (kind rows, flags, links, containers'
/// photos, guests, last contacts), the stated month windows and the lists. Worked out from the
/// constants: 14 windows, at most 8,000 ids (7,000 windowed, 1,024 pinned) in 40 chunks, five reads per chunk.
const LOAD_STATEMENTS: usize = 14 + 40 * 5 + 40;

/// The widest answer one read may give: an edge chunk's newest `200 * 8`; the budgets' window is
/// `500 * 4`.
const WIDEST_ANSWER: usize = 2_000;

fn bounded_world(year3: &year3_corpus::Year3) -> World {
    let (door, asked) = Counting::of(&year3.handle);
    let world = World::load_in(&door, Some(&standing())).expect("a world loads");
    let asked = *asked.lock().expect("counts");
    assert!(
        asked.statements <= LOAD_STATEMENTS,
        "a world load asked {} statements, more than the {LOAD_STATEMENTS} its windows allow",
        asked.statements
    );
    assert!(
        asked.widest <= WIDEST_ANSWER,
        "one read answered {} rows, past the {WIDEST_ANSWER} a chunk or window holds",
        asked.widest
    );
    assert_eq!(
        asked.whole_tables, 0,
        "a table was read whole; every read is a window or a chunk of ids"
    );
    world
}

fn count(world: &World, kind: Kind) -> usize {
    world.of_kind(kind).count()
}

#[test]
fn a_year_three_world_holds_each_kinds_newest_rows_and_says_it_left_older_ones() {
    let year3 = year3_corpus::found_rows();
    let world = bounded_world(&year3);
    for kind in [Kind::Note, Kind::Photo, Kind::Task, Kind::Person] {
        assert!(
            count(&world, kind) <= WINDOW_ROWS,
            "{kind:?}: {} rows held, past the window of {WINDOW_ROWS}",
            count(&world, kind)
        );
        assert!(count(&world, kind) > 0, "{kind:?}: the window is not empty");
        assert!(
            world.older.contains(&kind),
            "{kind:?}: the corpus holds more than a window, and the world says it left some"
        );
    }
    // the held notes are the newest: none is older than every one the window dropped
    let oldest_held = world
        .of_kind(Kind::Note)
        .map(|row| row.created.clone())
        .min()
        .expect("a note is held");
    let (door, _) = Counting::of(&year3.handle);
    let newer = door
        .window(&WindowQuery {
            table: "entity",
            columns: "id, created_at",
            sort: "created_at",
            pk: "id",
            predicate: "kind = ? AND created_at > ?",
            binds: &["note".to_owned(), oldest_held],
            limit: WINDOW_ROWS * 2,
            newest_first: true,
        })
        .expect("a window");
    assert!(
        newer.rows.len() < WINDOW_ROWS,
        "no more than the window's rest is newer than the oldest note held"
    );
}

#[test]
fn a_row_older_than_the_window_is_reached_by_name_and_kept() {
    let year3 = year3_corpus::found_rows();
    let (door, asked) = Counting::of(&year3.handle);
    let world = World::load_in(&door, Some(&standing())).expect("a world loads");
    let oldest_held = world
        .of_kind(Kind::Note)
        .map(|row| row.created.clone())
        .min()
        .expect("a note is held");
    // a note the window dropped: the newest one created before the oldest held
    let dropped = door
        .window(&WindowQuery {
            table: "entity",
            columns: "id, title, created_at",
            sort: "created_at",
            pk: "id",
            predicate: "kind = ? AND created_at < ?",
            binds: &["note".to_owned(), oldest_held],
            limit: 1,
            newest_first: true,
        })
        .expect("a window")
        .rows
        .into_iter()
        .next()
        .expect("the corpus holds notes older than the window");
    let id = centraid_assist::native::door::text(&dropped, "id").expect("an id");
    let title = centraid_assist::native::door::text(&dropped, "title").expect("a title");
    assert!(world.row(&(Kind::Note, id.clone())).is_none());

    let now = parse_now(TODAY).expect("a date");
    let mut session =
        Session::with_door_in(Box::new(door), now, "Etc/UTC", "", Flags::default()).expect("opens");
    assert!(session.world().row(&(Kind::Note, id.clone())).is_none());
    let before = *asked.lock().expect("counts");
    session.call("search", &json!({"text": title, "kind": "note"}));
    let after = *asked.lock().expect("counts");
    assert!(
        session.world().row(&(Kind::Note, id.clone())).is_some(),
        "the note {title:?} was reached by its name"
    );
    assert!(session.pinned().contains(&id), "and it is kept");
    assert!(
        after.statements - before.statements <= LOAD_STATEMENTS + 2 * 6 * 8 + 16,
        "reaching a row costs a bounded number of reads: {}",
        after.statements - before.statements
    );
    // a world loaded after the next write still holds it
    let reloaded = session.load_world().expect("a world loads");
    assert!(reloaded.row(&(Kind::Note, id)).is_some());
    assert!(session.pinned().len() <= PINNED_ROWS);
}

/// A vault with more notes than the door's old ceiling of a hundred thousand rows a table: the
/// turn used to fail; now it reads the same bounded set.
#[test]
fn more_notes_than_the_old_ceiling_read_the_same_bounded_world() {
    let shape = SearchCorpusShape {
        notes: 110_000,
        long_notes: 0,
        note_words: 3,
        ..YEAR3_ROWS
    };
    let year3 = year3_corpus::found_shape(shape);
    let world = bounded_world(&year3);
    assert!(count(&world, Kind::Note) <= WINDOW_ROWS);
    assert!(world.older.contains(&Kind::Note));
}

/// The session over a counting door, and what the door was asked.
fn session_of(year3: &year3_corpus::Year3) -> (Session, Arc<Mutex<Asked>>) {
    let (door, asked) = Counting::of(&year3.handle);
    let now = parse_now(TODAY).expect("a date");
    let session =
        Session::with_door_in(Box::new(door), now, "Etc/UTC", "", Flags::default()).expect("opens");
    (session, asked)
}

fn live_count(year3: &year3_corpus::Year3, vault_kind: &str) -> u64 {
    year3
        .handle
        .assist_door()
        .count(
            "entity",
            "kind = ? AND deleted_at IS NULL",
            &[vault_kind.to_owned()],
        )
        .expect("the store counts")
}

/// A WHOLE-KIND NUMBER COMES FROM THE STORE, NEVER FROM THE WINDOW: "how many notes" over more
/// notes than a window holds is the store's count, and a figure the store cannot give exactly
/// (a name over a kind with unread rows) is refused, not guessed.
#[test]
fn a_count_of_a_whole_kind_is_the_stores_and_any_other_is_refused_not_guessed() {
    let year3 = year3_corpus::found_rows();
    let total = live_count(&year3, "note");
    assert!(
        total > WINDOW_ROWS as u64,
        "the corpus holds more notes than a window"
    );
    let (mut session, asked) = session_of(&year3);
    let before = *asked.lock().expect("counts");
    let answered = session.call("compute", &json!({"op": "count", "kind": "note"}));
    let after = *asked.lock().expect("counts");
    assert!(
        answered.to_string().contains(&format!("= {total} ")),
        "the count is the store's {total}: {answered}"
    );
    assert!(
        after.statements - before.statements <= 3,
        "a whole-kind count is a handful of statements, not a walk: {}",
        after.statements - before.statements
    );
    let refused = session.call(
        "compute",
        &json!({"op": "count", "kind": "note", "name": "zzzqqq"}),
    );
    assert!(
        refused.to_string().contains("narrow it with a date"),
        "a figure over unread rows is refused: {refused}"
    );
}

/// A DATE-RANGED ASK REACHES ITS ROWS BY AN INDEXED RANGE READ: a task due today that was made
/// years ago is outside the newest rows and is found by its due date.
#[test]
fn a_task_due_on_a_day_is_found_though_it_was_made_before_the_window() {
    let year3 = year3_corpus::found_rows();
    let add = |title: &str, due: Option<&str>, key: &str| -> String {
        let outcome = year3
            .handle
            .command("task.add", &json!({"title": title, "due": due}), key)
            .expect("the task is added");
        outcome.output["id"].as_str().expect("an id").to_owned()
    };
    // the corpus gives no task a due date: one is made, then more tasks than a window holds
    let id = add("Renew the passport", Some(TODAY), "scale:dated");
    for index in 0..WINDOW_ROWS + 100 {
        add(
            &format!("Filler {index}"),
            None,
            &format!("scale:filler:{index}"),
        );
    }
    let (mut session, asked) = session_of(&year3);
    assert!(
        session.world().row(&(Kind::Task, id.clone())).is_none(),
        "the dated task is older than the newest {WINDOW_ROWS} tasks"
    );
    let before = *asked.lock().expect("counts");
    session.call("find", &json!({"kind": "task", "when": TODAY}));
    let after = *asked.lock().expect("counts");
    assert!(
        session.world().row(&(Kind::Task, id)).is_some(),
        "the task due {TODAY} was reached by its date"
    );
    assert!(
        after.statements - before.statements <= LOAD_STATEMENTS + 16,
        "a date range costs a bounded number of reads: {}",
        after.statements - before.statements
    );
}

/// "THE OLDEST": an ordered read with a limit takes its rows from the store in that order.
#[test]
fn the_oldest_note_is_the_oldest_in_the_store_not_in_the_window() {
    let year3 = year3_corpus::found_rows();
    let (mut session, _) = session_of(&year3);
    let door = year3.handle.assist_door();
    let oldest = door
        .window(&WindowQuery {
            table: "entity",
            columns: "id, created_at",
            sort: "created_at",
            pk: "id",
            predicate: "kind = ?",
            binds: &["note".to_owned()],
            limit: 1,
            newest_first: false,
        })
        .expect("a window")
        .rows
        .into_iter()
        .next()
        .and_then(|row| centraid_assist::native::door::text(&row, "id"))
        .expect("a note");
    assert!(session.world().row(&(Kind::Note, oldest.clone())).is_none());
    session.call(
        "find",
        &json!({"kind": "note", "order": "date asc", "limit": 1}),
    );
    assert!(
        session.world().row(&(Kind::Note, oldest)).is_some(),
        "the oldest note in the store was read in"
    );
}
