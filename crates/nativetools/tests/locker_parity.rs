//! The assistant has the owner's access to Locker items, except to a sealed value (the owner's
//! ruling of 2026-10-22, #1135; `Flags::secrets`, #1088 R-1088-3 and R-1088-10).
//!
//! PARITY: with the secrets off, as on the phone, the runtime finds a Locker item by its title and
//! its username, reads its plain fields, stars it, retitles it, trashes it and restores it, as it
//! does any other kind.
//!
//! THE BOUNDARY: it reads no sealed column (a sealed cell is a presence bit and nothing else),
//! a call that reveals or sets a sealed value ends in the typed decline `sealed_egress`, and a
//! planted sealed plaintext, or the ciphertext it is stored as, is in no byte the model receives:
//! no tool result, no pre-grounded block, no prompt, no directory.

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

    fn table_where(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
        predicate: &str,
        binds: &[String],
    ) -> Result<Vec<centraid_apps_kit::row::Row>, String> {
        self.log
            .lock()
            .unwrap()
            .tables
            .push((table.to_owned(), columns.to_owned()));
        Door::table_where(&self.inner, table, columns, sort, pk, predicate, binds)
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

fn flags(secrets: bool) -> Flags {
    Flags {
        secrets,
        ..Flags::default()
    }
}

/// A session over the world through a recording door.
fn recorded(world: &World, secrets: bool) -> (Session, Arc<Mutex<Log>>) {
    let now = dates::parse_now(TODAY).expect("a date");
    let clock = SetClock::at(vaultio::millis_of(now));
    let inner = Handle::open(world.path(), clock, "locker-parity").expect("the vault opens");
    let log = Arc::new(Mutex::new(Log::default()));
    let door = Recording {
        inner,
        log: Arc::clone(&log),
    };
    let session = Session::with_door(Box::new(door), now, "", flags(secrets)).expect("it opens");
    (session, log)
}

fn sealed_columns() -> Vec<&'static str> {
    centraid_vault::commands::locker::SEALED_ITEM_CELLS.to_vec()
}

/// Every recorded read that named a sealed column as a value. The presence test
/// (`<cell> IS NOT NULL AS has_<cell>`) names it as a bit and is not one.
fn sealed_reads(log: &Log) -> Vec<String> {
    let sealed = sealed_columns();
    log.tables
        .iter()
        .filter(|(_, columns)| {
            columns
                .split(',')
                .map(str::trim)
                .any(|column| sealed.contains(&column))
        })
        .map(|(table, columns)| format!("{table}: {columns}"))
        .collect()
}

/// The fixture's planted plaintexts: what `locker.password` seals under the harness key.
const PLANTED: [&str; 2] = ["hunter2", "s3cret"];

/// The bytes a model would receive, searched for a planted secret and for the `lk1:` ciphertext
/// it is stored as.
fn assert_no_secret(what: &str, bytes: &str) {
    for planted in PLANTED {
        assert!(
            !bytes.contains(planted),
            "{what} carried `{planted}`: {bytes}"
        );
    }
    assert!(
        !bytes.contains("lk1:"),
        "{what} carried a ciphertext: {bytes}"
    );
}

/// A script of ordinary calls, a Locker item among them.
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

// ---------------------------------------------------------------------------
// PARITY
// ---------------------------------------------------------------------------

#[test]
fn the_assistant_finds_a_locker_item_by_its_title_and_by_its_username() {
    let world = seeded();
    let (mut session, log) = recorded(&world, false);

    // by its title, by kind and by name
    session.user("find my wifi login");
    let by_name = call(
        &mut session,
        "find",
        json!({"kind": "locker item", "name": "wifi"}),
    );
    assert!(
        by_name["text"].as_str().unwrap().contains("Home wifi"),
        "{by_name}"
    );
    let all = call(&mut session, "find", json!({"kind": "locker items"}));
    let text = all["text"].as_str().unwrap();
    assert!(
        text.contains("Home wifi") && text.contains("Bank login"),
        "{text}"
    );

    // by a word of its title, through search
    session.user("anything about the bank");
    let by_title = call(&mut session, "search", json!({"text": "bank"}));
    assert!(
        by_title["text"].as_str().unwrap().contains("Bank login"),
        "{by_title}"
    );

    // by its USERNAME, which the title does not hold: the vault's index does
    session.user("which login is sam");
    let by_username = call(&mut session, "search", json!({"text": "sam"}));
    assert!(
        by_username["text"].as_str().unwrap().contains("Bank login"),
        "a Locker item is found by its username: {by_username}"
    );
    // A sealed value is no word of the index: searching for the planted secrets finds no item.
    for planted in PLANTED {
        session.user("search the planted secret");
        let found = call(&mut session, "search", json!({"text": planted}));
        assert_eq!(
            found["effect"]["rows"],
            json!([]),
            "a sealed value is findable: {found}"
        );
    }
    let log = log.lock().unwrap();
    assert!(
        log.searches.iter().any(|entity| entity == "locker_item"),
        "the full-text leg asked the door for Locker items: {:?}",
        log.searches
    );
}

#[test]
fn the_assistant_reads_a_locker_items_plain_fields_and_sees_its_secrets_as_a_bit() {
    let world = seeded();
    let mut session = world.session_with(TODAY, flags(false));
    let n = common::number(&mut session, "locker item", "bank");
    let opened = call(&mut session, "open", json!({"row": n}));
    let text = opened["text"].as_str().unwrap();
    assert!(text.contains("Bank login"), "{text}");
    assert!(text.contains("sam"), "the username: {text}");
    assert!(text.contains("https://bank.example"), "the url: {text}");
    assert!(
        text.contains("sealed: password") && text.contains("reveals it in Locker"),
        "the secret is a presence bit and says where the member opens it: {text}"
    );
    assert_no_secret("open", &opened.to_string());
    // its fields are queryable like any kind's
    session.user("which logins are on a bank site");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "locker item", "where": "username = sam"}),
    );
    assert!(
        found["text"].as_str().unwrap().contains("Bank login"),
        "{found}"
    );
}

#[test]
fn the_assistant_stars_retitles_trashes_and_restores_a_locker_item() {
    let world = seeded();
    let mut session = world.session_with(TODAY, flags(false));

    let n = common::number(&mut session, "locker item", "bank");
    let starred = call(&mut session, "act", json!({"verb": "star", "rows": n}));
    assert!(
        starred["text"].as_str().unwrap().contains("starred"),
        "{starred}"
    );

    session.user("rename the bank login");
    let n = common::find_in_turn(&mut session, "locker item", "bank");
    let renamed = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": n, "args": "name: Savings bank"}),
    );
    assert!(
        renamed["effect"]["refusal"].is_null(),
        "a rename runs on a Locker item: {renamed}"
    );
    session.user("and its username");
    let n = common::find_in_turn(&mut session, "locker item", "savings");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": n, "args": "username: sam2"}),
    );
    assert!(edited["effect"]["refusal"].is_null(), "{edited}");

    // The edit rewrote the plain fields and LEFT THE SEALED CELL ALONE: the owner's door still
    // unseals the password the fixture planted.
    let now = dates::parse_now(TODAY).expect("a date");
    let owner = Handle::open(world.path(), SetClock::at(vaultio::millis_of(now)), "owner")
        .expect("the vault opens");
    let rows = owner
        .table_where(
            "locker_item",
            "id, username, key_id, password",
            "id",
            "id",
            "username = ?",
            &["sam2".to_owned()],
        )
        .expect("the owner reads");
    let [row] = rows.as_slice() else {
        panic!("the edited item: {rows:?}");
    };
    let Some(centraid_apps_kit::row::Cell::Text(sealed)) = row.get("password") else {
        panic!("the password cell is gone: {row:?}");
    };
    let Some(centraid_apps_kit::row::Cell::Text(key_id)) = row.get("key_id") else {
        panic!("no key id");
    };
    let Some(centraid_apps_kit::row::Cell::Text(id)) = row.get("id") else {
        panic!("no id");
    };
    assert_eq!(
        Door::unseal(&owner, key_id, id, sealed).as_deref(),
        Ok("s3cret"),
        "an edit by the assistant kept the password"
    );

    session.user("bin it");
    let n = common::find_in_turn(&mut session, "locker item", "savings");
    let deleted = call(&mut session, "act", json!({"verb": "delete", "rows": n}));
    assert!(deleted["effect"]["refusal"].is_null(), "{deleted}");
    session.user("put it back");
    let n = common::trashed_number(&mut session, "locker item", "savings");
    let restored = call(&mut session, "act", json!({"verb": "restore", "rows": n}));
    assert!(restored["effect"]["refusal"].is_null(), "{restored}");
}

#[test]
fn a_world_without_a_locker_behaves_the_same_with_the_secrets_on_or_off() {
    let on_world = without_locker();
    let off_world = without_locker();
    let on = script(&mut on_world.session_with(TODAY, flags(true)));
    let off = script(&mut off_world.session_with(TODAY, flags(false)));
    assert_eq!(on.len(), off.len());
    for (index, (on, off)) in on.iter().zip(&off).enumerate() {
        assert_eq!(on, off, "call {index} differs");
    }
}

#[test]
fn the_locker_items_of_a_world_are_in_it_with_the_secrets_on_or_off() {
    let (off_world, on_world) = (seeded(), seeded());
    let mut off = off_world.session_with(TODAY, flags(false));
    let mut on = on_world.session_with(TODAY, flags(true));
    for session in [&mut off, &mut on] {
        session.user("the logins");
    }
    let listed = |session: &mut Session| -> String {
        call(session, "find", json!({"kind": "locker items"}))["text"]
            .as_str()
            .expect("a text")
            .to_owned()
    };
    let (with, without) = (listed(&mut on), listed(&mut off));
    assert_eq!(with, without);
    assert!(
        with.contains("Home wifi") && with.contains("Bank login"),
        "{with}"
    );
}

// ---------------------------------------------------------------------------
// THE SECRET BOUNDARY
// ---------------------------------------------------------------------------

#[test]
fn with_the_secrets_off_no_sealed_column_is_read_as_a_value() {
    let world = seeded();
    let (mut session, log) = recorded(&world, false);
    script(&mut session);
    session.user("anything about the wifi");
    call(&mut session, "search", json!({"text": "wifi"}));
    call(&mut session, "find", json!({"kind": "locker item"}));
    let log = log.lock().unwrap();
    assert!(
        log.tables.iter().any(|(table, _)| table == "locker_item"),
        "the Locker items were read through the door"
    );
    assert_eq!(sealed_reads(&log), Vec::<String>::new());
    assert!(
        log.tables
            .iter()
            .any(|(table, columns)| table == "locker_item"
                && columns.contains("password IS NOT NULL AS has_password")),
        "a sealed cell is read as its presence"
    );
    assert!(
        log.commands
            .iter()
            .all(|command| !command.starts_with("locker.")),
        "{:?}",
        log.commands
    );
    assert_eq!((log.seals, log.unseals), (0, 0));
}

#[test]
fn the_recording_door_does_read_the_sealed_cells_when_the_secrets_are_on() {
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
        !sealed_reads(&log).is_empty(),
        "the control reads sealed columns, so the silence above is the policy's: {:?}",
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
    assert_eq!(response["effect"]["secrets_off"], true, "{what}");
}

#[test]
fn a_reveal_and_a_create_that_sets_a_secret_decline_sealed_egress() {
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
        (
            "create a login with a password",
            "act",
            json!({"verb": "create", "kind": "locker item", "args": "name: Gym\ntype: login\npassword: PLANTED-NEW-PASSWORD"}),
        ),
        (
            "create a card with a number",
            "act",
            json!({"verb": "create", "kind": "locker item", "args": "name: Visa\ntype: card\ncard_number: PLANTED-4111"}),
        ),
    ];
    for (what, tool, args) in calls {
        session.user("show me the wifi password");
        let response = call(&mut session, tool, args);
        assert_sealed_egress(&response, what);
        assert_no_secret(what, &response.to_string());
    }
    let log = log.lock().unwrap();
    assert_eq!(sealed_reads(&log), Vec::<String>::new());
    assert!(log.commands.is_empty(), "nothing ran: {:?}", log.commands);
    assert_eq!((log.seals, log.unseals), (0, 0));
}

#[test]
fn a_note_items_notes_are_sealed_and_the_assistant_cannot_set_them() {
    let world = seeded();
    let (mut session, log) = recorded(&world, false);
    session.user("add a gym combo note");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "locker item", "args": "name: Gym combo\ntype: note\nnotes: 12-34-56"}),
    );
    assert!(
        created["text"].as_str().unwrap().contains("sealed"),
        "the refusal says the notes are sealed: {created}"
    );
    let log = log.lock().unwrap();
    assert!(log.commands.is_empty(), "nothing ran: {:?}", log.commands);
    assert_eq!(log.seals, 0);
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

/// Every byte the model receives about the Locker, searched for a planted secret and for its
/// ciphertext: the pre-grounded block of a turn, every tool result, the prompt and its directory.
#[test]
fn no_sealed_plaintext_or_ciphertext_reaches_the_model_in_any_byte() {
    let world = seeded();
    let mut session = world.session_with(TODAY, flags(false));
    let mut received = String::new();
    for message in [
        "what is the password for the wifi",
        "show me the bank login and its password",
    ] {
        received.push_str(&session.user(message).to_string());
        for (tool, args) in [
            ("find", json!({"kind": "locker item"})),
            ("find", json!({"kind": "locker item", "name": "bank"})),
            ("search", json!({"text": "bank"})),
            ("search", json!({"text": "wifi"})),
            ("compute", json!({"kind": "locker item", "op": "count"})),
        ] {
            received.push_str(&call(&mut session, tool, args).to_string());
        }
        let n = common::find_in_turn(&mut session, "locker item", "bank");
        received.push_str(&call(&mut session, "open", json!({"row": n})).to_string());
        received.push_str(
            &call(
                &mut session,
                "act",
                json!({"verb": "reveal", "rows": n, "args": "field: password"}),
            )
            .to_string(),
        );
    }
    received.push_str(&session.prompt().to_string());
    assert!(
        received.contains("Bank login"),
        "the items are in what the model receives"
    );
    for planted in PLANTED {
        assert!(
            !received.contains(planted),
            "a planted sealed value reached the model: `{planted}`"
        );
    }
    assert!(!received.contains("lk1:"), "a ciphertext reached the model");
}
