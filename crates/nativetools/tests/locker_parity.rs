//! The assistant is the member in Locker, but for a sealed value's plaintext (the owner's direction,
//! #1135): a sealed value is a channel the runtime keeps closed, and nothing else of Locker is.
//!
//! PARITY: the runtime finds a Locker item by its title and its username, reads its plain fields,
//! stars it, retitles it, trashes it and restores it, as it does any other kind.
//!
//! THE CHANNEL: it reads no sealed column (a sealed cell is a presence bit and nothing else); a
//! call that would show a sealed value ends the turn in a member action (a card the member
//! completes in Locker), never in a value and never in a decline; a secret the member typed is
//! sealed by the door when the write runs; and a planted sealed plaintext, or the ciphertext it is
//! stored as, is in no byte the model receives: no tool result, no pre-grounded block, no prompt,
//! no directory.

mod common;

use std::sync::{Arc, Mutex};

use centraid_nativetools::vaultio::{Door, Handle, Ran, SetClock};
use centraid_nativetools::{Flags, Session, dates, vaultio};
use common::{TODAY, World, call, seeded};
use serde_json::{Value, json};

/// Everything the runtime asked a door for.
#[derive(Default)]
struct Log {
    /// `(table, columns)` of every read.
    tables: Vec<(String, String)>,
    searches: Vec<String>,
    commands: Vec<String>,
    /// `(command, input)` of every write, as the door received it.
    inputs: Vec<(String, Value)>,
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
        {
            let mut log = self.log.lock().unwrap();
            log.commands.push(command.to_owned());
            log.inputs.push((command.to_owned(), input.clone()));
        }
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
}

/// A session over the world through a recording door.
fn recorded(world: &World) -> (Session, Arc<Mutex<Log>>) {
    let now = dates::parse_now(TODAY).expect("a date");
    let clock = SetClock::at(vaultio::millis_of(now));
    let inner = Handle::open(world.path(), clock, "locker-parity").expect("the vault opens");
    let log = Arc::new(Mutex::new(Log::default()));
    let door = Recording {
        inner,
        log: Arc::clone(&log),
    };
    let session = Session::with_door(Box::new(door), now, "", Flags::default()).expect("it opens");
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

// ---------------------------------------------------------------------------
// PARITY
// ---------------------------------------------------------------------------

#[test]
fn the_assistant_finds_a_locker_item_by_its_title_and_by_its_username() {
    let world = seeded();
    let (mut session, log) = recorded(&world);

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
    let mut session = world.session();
    let n = common::number(&mut session, "locker item", "bank");
    let opened = call(&mut session, "open", json!({"row": n}));
    let text = opened["text"].as_str().unwrap();
    assert!(text.contains("Bank login"), "{text}");
    assert!(text.contains("sam"), "the username: {text}");
    assert!(text.contains("https://bank.example"), "the url: {text}");
    assert!(
        text.contains("sealed: password") && text.contains("reveal offers it to the member"),
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
    let mut session = world.session();

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
        centraid_vault::custody::locker_key::decrypt_under_locker_key(
            vaultio::HARNESS_LOCKER_KEY,
            key_id,
            id,
            sealed,
        )
        .ok()
        .as_deref(),
        Some("s3cret"),
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
fn the_locker_items_of_a_world_are_in_it() {
    let world = seeded();
    let mut session = world.session();
    session.user("the logins");
    let listed = call(&mut session, "find", json!({"kind": "locker items"}))["text"]
        .as_str()
        .expect("a text")
        .to_owned();
    assert!(
        listed.contains("Home wifi") && listed.contains("Bank login"),
        "{listed}"
    );
}

// ---------------------------------------------------------------------------
// THE SECRET BOUNDARY
// ---------------------------------------------------------------------------

#[test]
fn no_sealed_column_is_read_as_a_value() {
    let world = seeded();
    let (mut session, log) = recorded(&world);
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
}

/// A call that would show a sealed value does not run and does not decline: it ends the turn in a
/// member action, and the observation says what was offered and never a value.
fn assert_offered(response: &Value, what: &str, action: &str, field: &str) {
    assert_eq!(response["ends_turn"], true, "{what}: {response}");
    let offered = &response["effect"]["member_actions"][0];
    assert_eq!(offered["action"], action, "{what}: {response}");
    assert_eq!(offered["field"], field, "{what}: {response}");
    assert!(
        response["text"]
            .as_str()
            .unwrap()
            .starts_with("offered to the member: "),
        "{what}: {response}"
    );
    assert!(response["effect"]["decline"].is_null(), "{what}");
}

#[test]
fn a_reveal_ends_the_turn_in_a_member_action_and_runs_nothing() {
    let world = seeded();
    let (mut session, log) = recorded(&world);
    session.user("show me the wifi password");
    let wifi = common::number(&mut session, "locker item", "wifi");
    let calls = [
        (
            "reveal by name",
            json!({"verb": "reveal", "kind": "locker item", "name": "Home wifi", "args": "field: password"}),
            "reveal",
            "password",
        ),
        (
            "reveal by handle",
            json!({"verb": "reveal", "rows": wifi, "args": "field: password"}),
            "reveal",
            "password",
        ),
    ];
    for (what, args, action, field) in calls {
        session.user("show me the wifi password");
        let response = call(&mut session, "act", args);
        assert_offered(&response, what, action, field);
        assert_no_secret(what, &response.to_string());
    }
    // the one-time code is its own action, and the seed is never the field
    session.user("my bank code");
    let bank = common::find_in_turn(&mut session, "locker item", "bank");
    let code = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": bank, "args": "field: code"}),
    );
    if code["effect"]["member_actions"].is_array() {
        assert_offered(&code, "the code", "code", "otp_seed");
    }
    let log = log.lock().unwrap();
    assert_eq!(sealed_reads(&log), Vec::<String>::new());
    assert!(log.commands.is_empty(), "nothing ran: {:?}", log.commands);
}

#[test]
fn an_edit_of_a_secret_with_no_value_is_the_members_to_type() {
    let world = seeded();
    let (mut session, log) = recorded(&world);
    session.user("change my wifi password");
    let n = common::find_in_turn(&mut session, "locker item", "wifi");
    let response = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": n, "args": "password: "}),
    );
    assert_offered(&response, "edit", "edit_secret", "password");
    assert!(log.lock().unwrap().commands.is_empty());
}

#[test]
fn a_secret_the_member_typed_reaches_the_door_as_typed_and_is_stored_sealed() {
    let world = seeded();
    let (mut session, log) = recorded(&world);
    session.user("save my gym login, password PLANTED-NEW-PASSWORD");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "locker item", "args": "name: Gym\ntype: login\npassword: PLANTED-NEW-PASSWORD"}),
    );
    assert!(created["effect"]["error"].is_null(), "{created}");
    assert!(
        !created.to_string().contains("PLANTED-NEW-PASSWORD"),
        "the observation does not echo the secret: {created}"
    );
    {
        let log = log.lock().unwrap();
        let (command, input) = log.inputs.last().expect("a write");
        assert_eq!(command, "locker.add_item");
        assert_eq!(input["password"], "PLANTED-NEW-PASSWORD");
    }
    // the vault holds ciphertext the owner can open, and no plaintext
    let now = dates::parse_now(TODAY).expect("a date");
    let owner = Handle::open(world.path(), SetClock::at(vaultio::millis_of(now)), "owner")
        .expect("the vault opens");
    let rows = owner
        .table_where(
            "locker_item",
            "id, key_id, password",
            "id",
            "id",
            "id != ?",
            &[String::new()],
        )
        .expect("the owner reads");
    let stored: Vec<_> = rows
        .iter()
        .filter_map(|row| match row.get("password") {
            Some(centraid_apps_kit::row::Cell::Text(text)) => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert!(!stored.is_empty() && stored.iter().all(|text| text.starts_with("lk1:")));
    assert!(
        stored
            .iter()
            .all(|text| !text.contains("PLANTED-NEW-PASSWORD"))
    );
}

/// Every byte the model receives about the Locker, searched for a planted secret and for its
/// ciphertext: the pre-grounded block of a turn, every tool result, the prompt and its directory.
#[test]
fn no_sealed_plaintext_or_ciphertext_reaches_the_model_in_any_byte() {
    let world = seeded();
    let mut session = world.session();
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
