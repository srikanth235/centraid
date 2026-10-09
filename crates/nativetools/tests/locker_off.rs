//! The Locker policy (`Flags::locker`, #1088 R-1088-3 and R-1088-10): with it off, the runtime
//! reads no Locker table and no sealed column, a call that names a Locker kind or the `reveal`
//! verb ends in the typed decline `sealed_egress`, and nothing else changes.

mod common;

use std::sync::{Arc, Mutex};

use centraid_nativetools::vaultio::{Door, Handle, Ran, SetClock};
use centraid_nativetools::{Flags, Session, dates, vaultio};
use common::{FIXTURE, TODAY, World, call, seeded, seeded_with};
use serde_json::{Value, json};

/// Everything the runtime asked a door for.
#[derive(Default)]
struct Log {
    /// `(table, columns)` of every read.
    tables: Vec<(String, String)>,
    searches: Vec<String>,
    commands: Vec<String>,
    seals: usize,
    unseals: usize,
}

/// A door that records what it is asked and answers from a real vault file.
struct Recording {
    inner: Handle,
    log: Arc<Mutex<Log>>,
}

impl Door for Recording {
    fn table(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
    ) -> Result<Vec<centraid_apps_kit::row::Row>, String> {
        self.log
            .lock()
            .unwrap()
            .tables
            .push((table.to_owned(), columns.to_owned()));
        Door::table(&self.inner, table, columns, sort, pk)
    }

    fn tally(&self) -> Result<centraid_apps_tally::queries::TallyData, String> {
        Door::tally(&self.inner)
    }

    fn search(
        &self,
        entity: &str,
        text: &str,
        limit: usize,
    ) -> Result<Vec<centraid_search::Target>, String> {
        self.log.lock().unwrap().searches.push(entity.to_owned());
        Door::search(&self.inner, entity, text, limit)
    }

    fn run(&self, command: &str, input: Value) -> Result<Ran, String> {
        self.log.lock().unwrap().commands.push(command.to_owned());
        Door::run(&self.inner, command, input)
    }

    fn advance(&self) {
        Door::advance(&self.inner);
    }

    fn now_ms(&self) -> i64 {
        Door::now_ms(&self.inner)
    }

    fn mint_id(&self) -> String {
        Door::mint_id(&self.inner)
    }

    fn seal(&self, item_id: &str, value: &str) -> Result<(String, String), String> {
        self.log.lock().unwrap().seals += 1;
        Door::seal(&self.inner, item_id, value)
    }

    fn unseal(&self, key_id: &str, item_id: &str, sealed: &str) -> Result<String, String> {
        self.log.lock().unwrap().unseals += 1;
        Door::unseal(&self.inner, key_id, item_id, sealed)
    }
}

fn flags(locker: bool) -> Flags {
    Flags {
        locker,
        ..Flags::default()
    }
}

/// A session over the world through a recording door.
fn recorded(world: &World, locker: bool) -> (Session, Arc<Mutex<Log>>) {
    let now = dates::parse_now(TODAY).expect("a date");
    let clock = SetClock::at(vaultio::millis_of(now));
    let inner = Handle::open(world.path(), clock, "locker-off").expect("the vault opens");
    let log = Arc::new(Mutex::new(Log::default()));
    let door = Recording {
        inner,
        log: Arc::clone(&log),
    };
    let session = Session::with_door(Box::new(door), now, "", flags(locker)).expect("it opens");
    (session, log)
}

fn sealed_columns() -> Vec<&'static str> {
    centraid_vault::commands::locker::SEALED_ITEM_CELLS.to_vec()
}

/// Whether any recorded read touched a Locker table or named a sealed column.
fn locker_reads(log: &Log) -> Vec<String> {
    let sealed = sealed_columns();
    log.tables
        .iter()
        .filter(|(table, columns)| {
            table.starts_with("locker")
                || columns
                    .split(',')
                    .map(str::trim)
                    .any(|column| sealed.contains(&column))
        })
        .map(|(table, columns)| format!("{table}: {columns}"))
        .collect()
}

/// A script of ordinary calls that touch no Locker row.
fn script(session: &mut Session) -> Vec<Value> {
    let mut out = Vec::new();
    session.user("what is on my plate");
    out.push(call(session, "find", json!({"kind": "task"})));
    out.push(call(session, "search", json!({"text": "cabin"})));
    out.push(call(
        session,
        "compute",
        json!({"kind": "task", "op": "count"}),
    ));
    let cabin = common::find_in_turn(session, "task", "cabin");
    out.push(call(session, "act", json!({"verb": "star", "rows": cabin})));
    session.user("add one");
    out.push(call(
        session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: pack bags"}),
    ));
    out.push(call(session, "act", json!({"verb": "undo"})));
    session.user("the notes");
    out.push(call(session, "find", json!({"kind": "note"})));
    out
}

/// The fixture with its Locker taken out.
fn without_locker() -> World {
    let mut world: Value = serde_json::from_str(FIXTURE).expect("the fixture is JSON");
    world["locker"] = json!([]);
    seeded_with(&world)
}

#[test]
fn with_the_locker_off_no_locker_table_and_no_sealed_column_is_read() {
    let world = seeded();
    let (mut session, log) = recorded(&world, false);
    // everything a session reads: opening, a read of each shape, a write and its reload
    script(&mut session);
    session.user("anything about the wifi");
    call(&mut session, "search", json!({"text": "wifi"}));
    call(&mut session, "find", json!({"kind": "note"}));
    let log = log.lock().unwrap();
    assert!(
        !log.tables.is_empty(),
        "the world was read through the door"
    );
    assert_eq!(locker_reads(&log), Vec::<String>::new());
    assert!(
        log.searches.iter().all(|entity| !entity.contains("locker")),
        "{:?}",
        log.searches
    );
    assert!(
        log.commands
            .iter()
            .all(|command| !command.starts_with("locker."))
    );
    assert_eq!((log.seals, log.unseals), (0, 0));
}

#[test]
fn the_recording_door_does_see_the_locker_when_the_policy_is_on() {
    let world = seeded();
    let (mut session, log) = recorded(&world, true);
    let n = common::number(&mut session, "locker item", "wifi");
    let shown = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": n, "args": "field: password"}),
    );
    assert!(
        shown["text"].as_str().unwrap().contains("hunter2"),
        "{shown}"
    );
    let log = log.lock().unwrap();
    assert!(
        locker_reads(&log)
            .iter()
            .any(|read| read.starts_with("locker_item")),
        "{:?}",
        log.tables
    );
    assert_eq!(log.unseals, 1);
}

fn assert_sealed_egress(response: &Value, what: &str) {
    assert_eq!(
        response["text"], "declined: sealed_egress",
        "{what}: {response}"
    );
    assert_eq!(response["ends_turn"], true, "{what}");
    assert_eq!(
        response["effect"]["decline"]["reason"], "sealed_egress",
        "{what}"
    );
    assert_eq!(response["effect"]["locker_off"], true, "{what}");
}

#[test]
fn reveal_and_a_locker_kind_decline_sealed_egress() {
    let world = seeded();
    let (mut session, log) = recorded(&world, false);
    let calls = [
        (
            "reveal by name",
            "act",
            json!({"verb": "reveal", "kind": "locker item", "name": "Home wifi", "args": "field: password"}),
        ),
        (
            "reveal by handle",
            "act",
            json!({"verb": "reveal", "rows": "#1", "args": "field: password"}),
        ),
        ("find a locker kind", "find", json!({"kind": "locker item"})),
        (
            "find the plural",
            "find",
            json!({"kind": "locker items", "name": "wifi"}),
        ),
        (
            "a list of kinds that names it",
            "find",
            json!({"kind": "note, locker item"}),
        ),
        (
            "search a locker kind",
            "search",
            json!({"text": "wifi", "kind": "locker item"}),
        ),
        (
            "count a locker kind",
            "compute",
            json!({"kind": "locker item", "op": "count"}),
        ),
        (
            "create a locker item",
            "act",
            json!({"verb": "create", "kind": "locker item", "args": "name: Gym combo\ntype: note\nnotes: 12-34-56"}),
        ),
    ];
    for (what, tool, args) in calls {
        session.user("show me the wifi password");
        let response = call(&mut session, tool, args);
        assert_sealed_egress(&response, what);
    }
    let log = log.lock().unwrap();
    assert_eq!(locker_reads(&log), Vec::<String>::new());
    assert!(log.commands.is_empty(), "nothing ran: {:?}", log.commands);
    assert_eq!((log.seals, log.unseals), (0, 0));
}

#[test]
fn the_decline_is_the_models_own_decline_observation() {
    let world = seeded();
    let mut off = world.session_with(TODAY, flags(false));
    let mut on = world.session();
    off.user("show me the wifi password");
    on.user("show me the wifi password");
    let declined_off = call(
        &mut off,
        "act",
        json!({"verb": "reveal", "kind": "locker item", "name": "Home wifi", "args": "field: password"}),
    );
    let by_the_model = call(&mut on, "decline", json!({"reason": "sealed_egress"}));
    assert_eq!(declined_off["text"], by_the_model["text"]);
    assert_eq!(declined_off["ends_turn"], by_the_model["ends_turn"]);
    assert_eq!(
        declined_off["effect"]["decline"],
        by_the_model["effect"]["decline"]
    );
}

#[test]
fn with_the_locker_off_a_world_without_one_behaves_exactly_as_with_it_on() {
    let on_world = without_locker();
    let off_world = without_locker();
    let on = script(&mut on_world.session_with(TODAY, flags(true)));
    let off = script(&mut off_world.session_with(TODAY, flags(false)));
    assert_eq!(on.len(), off.len());
    for (index, (on, off)) in on.iter().zip(&off).enumerate() {
        assert_eq!(on, off, "call {index} differs");
    }
    assert!(
        on.iter()
            .any(|response| response["effect"]["diff"].is_array()
                || response["effect"].get("rows").is_some()),
        "the script reads and writes"
    );
}

#[test]
fn the_locker_policy_hides_only_the_locker_rows_of_a_world_that_has_them() {
    // one world each: the script writes
    let (off_world, on_world) = (seeded(), seeded());
    let off = script(&mut off_world.session_with(TODAY, flags(false)));
    let on = script(&mut on_world.session_with(TODAY, flags(true)));
    // the ordinary reads see the same tasks and notes either way (the `#n` shift is the Locker
    // rows the policy leaves out of the numbering)
    let ids = |response: &Value| -> Vec<(String, String)> {
        response["effect"]["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                (
                    row["kind"].as_str().unwrap_or_default().to_owned(),
                    row["id"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect()
    };
    for index in [0, 6] {
        assert_eq!(ids(&on[index]), ids(&off[index]), "call {index}");
    }
}
