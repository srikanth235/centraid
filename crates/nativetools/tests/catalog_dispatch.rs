//! ONE LOOKUP: `(verb, kind, qualifier)` to the manifest action the chat runs (#1135).
//!
//! The runtime names no vault command for a verb: it looks the manifest's action up and hands the
//! door the action (`Door::act`), so these tests record what the door was asked and check it is the
//! action the catalog names, with the command that action invokes and the input its schema says.

mod common;

use std::sync::{Arc, Mutex};

use centraid_nativetools::meta::{self, Kind, Verb};
use centraid_nativetools::vaultio::{Call, Door, Handle, Ran, SetClock};
use centraid_nativetools::{Flags, Session, dates, vaultio};
use common::{TODAY, World, call, number, seeded};
use serde_json::{Value, json};

/// A door that records every write it is asked, as the action and the input.
struct Recording {
    inner: Handle,
    writes: Arc<Mutex<Vec<(Call, Value)>>>,
}

impl Door for Recording {
    fn table(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
    ) -> Result<Vec<centraid_apps_kit::row::Row>, String> {
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
        Door::table_where(&self.inner, table, columns, sort, pk, predicate, binds)
    }

    fn search(
        &self,
        entity: &str,
        text: &str,
        limit: usize,
    ) -> Result<Vec<centraid_search::Target>, String> {
        Door::search(&self.inner, entity, text, limit)
    }

    fn act(&self, call: &Call, input: Value) -> Result<Ran, String> {
        self.writes.lock().unwrap().push((*call, input.clone()));
        Door::act(&self.inner, call, input)
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

fn recorded(world: &World) -> (Session, Arc<Mutex<Vec<(Call, Value)>>>) {
    let now = dates::parse_now(TODAY).expect("a date");
    let clock = SetClock::at(vaultio::millis_of(now));
    let inner = Handle::open(world.path(), clock, "dispatch").expect("the vault opens");
    let writes = Arc::new(Mutex::new(Vec::new()));
    let door = Recording {
        inner,
        writes: Arc::clone(&writes),
    };
    let session = Session::with_door(Box::new(door), now, "", Flags::default()).expect("it opens");
    (session, writes)
}

/// What the door was asked since the last call to this, as `app/action` and the command.
fn taken(writes: &Arc<Mutex<Vec<(Call, Value)>>>) -> Vec<(String, &'static str, Value)> {
    writes
        .lock()
        .unwrap()
        .drain(..)
        .map(|(call, input)| (format!("{}/{}", call.app, call.action), call.command, input))
        .collect()
}

/// One act on a named row, by the verb and its args.
fn act(session: &mut Session, kind: &str, name: &str, verb: &str, args: Value) -> Value {
    let row = number(session, kind, name);
    let mut call_args = json!({"verb": verb, "rows": row});
    if !args.is_null() {
        call_args["args"] = args;
    }
    call(session, "act", call_args)
}

#[test]
fn each_verb_runs_the_action_the_catalog_names() {
    let world = seeded();
    let (mut session, writes) = recorded(&world);
    for (kind, name, verb, args, want) in [
        // a task's cancel is direct (it has an inverse, `reopen`)
        ("task", "cabin", "cancel", Value::Null, "tasks/cancel"),
        // a note's flag is direct (its inverse is `unflag-note`)
        ("note", "Dal", "star", Value::Null, "notes/flag-note"),
        // a project is renamed by its own action
        (
            "list",
            "Home",
            "edit",
            json!("name: House"),
            "tasks/rename-list",
        ),
        // a tag is the catalog's own verb: no bespoke planner owns it
        (
            "task",
            "Pay rent",
            "tag",
            json!("label: urgent"),
            "tasks/add-tag",
        ),
        (
            "locker item",
            "Bank",
            "archive",
            Value::Null,
            "locker/archive-item",
        ),
    ] {
        session.user("");
        let reply = act(&mut session, kind, name, verb, args);
        let text = reply["text"].as_str().unwrap_or_default();
        assert!(!text.starts_with("error"), "{verb} {kind}: {text}");
        let ran = taken(&writes);
        let [(action, command, _)] = ran.as_slice() else {
            panic!("{verb} {kind} ran {ran:?}");
        };
        assert_eq!(action, want, "{verb} {kind}");
        let spec = meta::lookup(Verb::parse(verb).unwrap(), Kind::parse(kind).unwrap(), None)
            .expect("the lookup serves it");
        assert_eq!(*command, spec.command);
    }
}

#[test]
fn an_edit_of_one_field_runs_the_action_that_names_it() {
    let world = seeded();
    let (mut session, writes) = recorded(&world);
    // `edit:cadence` is a person's cadence; every other field of a person is `edit-person`
    session.user("");
    act(&mut session, "person", "Ray", "edit", json!("cadence: 14"));
    let ran = taken(&writes);
    assert_eq!(ran.len(), 1, "{ran:?}");
    assert_eq!(ran[0].0, "people/set-cadence");
    assert_eq!(ran[0].1, "person.edit");
    assert_eq!(ran[0].2["cadence_days"], json!(14));

    session.user("");
    act(
        &mut session,
        "person",
        "Ray",
        "edit",
        json!("role: neighbour"),
    );
    let ran = taken(&writes);
    assert_eq!(ran[0].0, "people/edit-person");
    assert_eq!(ran[0].2["role"], json!("neighbour"));

    // two fields of one command are one step, by the action that takes both
    session.user("");
    act(
        &mut session,
        "person",
        "Ray",
        "edit",
        json!("role: friend\ncadence: 30"),
    );
    let ran = taken(&writes);
    assert_eq!(ran.len(), 1, "{ran:?}");
    assert_eq!(ran[0].0, "people/edit-person");
    assert_eq!(ran[0].2["cadence_days"], json!(30));
    assert_eq!(ran[0].2["role"], json!("friend"));
}

#[test]
fn the_names_chat_says_are_the_aliases_the_manifest_declares() {
    // a task's `date` is its `due`, spelled either way; `effort` is `effort_min`
    let create = meta::lookup(Verb::Create, Kind::Task, None).unwrap();
    assert_eq!(create.property_named("date"), Some("due"));
    assert_eq!(create.property_named("due"), Some("due"));
    assert_eq!(create.property_named("effort"), Some("effort_min"));
    assert_eq!(create.property_named("name"), Some("title"));
    assert_eq!(meta::create_arg_canonical(Kind::Task, "due"), Some("date"));
    assert_eq!(meta::create_arg_canonical(Kind::Task, "date"), None);
    assert!(meta::create_args(Kind::Task).contains(&"parent"));
    assert!(meta::create_args(Kind::Task).contains(&"list"));
    // a kind with no create action is created by no call
    assert!(meta::create_args(Kind::Photo).is_empty());
}

#[test]
fn a_verb_is_live_when_an_action_backs_it() {
    // the verbs no direct action of a writable kind serves are not verbs of the runtime
    for dead in [
        "import",
        "purge",
        "duplicate",
        "merge",
        "attach",
        "detach",
        "respond",
    ] {
        assert!(Verb::parse(dead).is_none(), "{dead} is live");
    }
    for live in [
        "create",
        "edit",
        "cancel",
        "tag",
        "untag",
        "archive",
        "unarchive",
        "undo",
    ] {
        assert!(Verb::parse(live).is_some(), "{live} is not live");
    }
}
