//! EVERY ACTION IS TAKEN BACK, OR ASKS FIRST (#1185), through the core's own door.
//!
//! | Case | What it proves |
//! |---|---|
//! | [`an_undo_names_the_version_the_act_made_and_a_changed_record_refuses_it`] | the generic `Earlier` inverse restores exactly the state before THIS act, and refuses once the record changed again |
//! | [`an_act_the_history_does_not_capture_offers_no_earlier_undo`] | classification is the vault's answer (did a version appear), never a name |
//! | [`a_claim_of_writing_nothing_is_proven_by_running_the_action`] | `writes_nothing` is true for every action that says it, mechanically |
//! | `<app>_*` | one round trip per action an app takes back by its earlier version: do it, undo it, the state equals what it was |

mod common;

use std::collections::HashMap;

use centraid_api_proto::core_v1 as wire;
use common::chat::Sample;
use serde_json::{Value, json};

/// A seeded vault and the calls a shell makes.
pub struct World {
    pub sample: Sample,
    next: std::cell::Cell<u32>,
    /// The `(app, action)` pairs a round trip has proven.
    pub proven: std::cell::RefCell<std::collections::BTreeSet<(String, String)>>,
}

/// An act's answer, decoded.
pub struct Done {
    pub response: wire::ActResponse,
}

impl Done {
    pub fn output(&self) -> Value {
        serde_json::from_slice(&self.response.output).unwrap_or(Value::Null)
    }

    pub fn executed(&self) -> bool {
        self.response.status == wire::ActStatus::Executed as i32
    }

    pub fn refusal(&self) -> String {
        self.response
            .refusal
            .as_ref()
            .map(|refusal| refusal.detail.clone())
            .unwrap_or_default()
    }

    /// The inverse as `(action, input)`.
    pub fn inverse(&self) -> Option<(String, Value)> {
        let inverse = self.response.inverse.as_ref()?;
        let input: serde_json::Map<String, Value> = inverse
            .input
            .iter()
            .map(|(name, value)| {
                let json = match value.kind.clone() {
                    Some(wire::value::Kind::Text(text)) => Value::String(text),
                    Some(wire::value::Kind::Integer(number)) => json!(number),
                    Some(wire::value::Kind::Real(number)) => json!(number),
                    _ => Value::Null,
                };
                (name.clone(), json)
            })
            .collect();
        Some((inverse.action.clone(), Value::Object(input)))
    }
}

fn wire_input(input: &Value) -> HashMap<String, wire::Value> {
    input
        .as_object()
        .expect("an object")
        .iter()
        .map(|(name, value)| {
            let kind = match value {
                Value::Null => wire::value::Kind::Null(wire::NullValue {}),
                Value::Bool(flag) => wire::value::Kind::Integer(i64::from(*flag)),
                Value::Number(number) => number.as_i64().map_or_else(
                    || wire::value::Kind::Real(number.as_f64().unwrap_or_default()),
                    wire::value::Kind::Integer,
                ),
                Value::String(text) => wire::value::Kind::Text(text.clone()),
                structured => wire::value::Kind::Text(structured.to_string()),
            };
            (name.clone(), wire::Value { kind: Some(kind) })
        })
        .collect()
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    pub fn new() -> Self {
        // A core opened with the member's seed, so Locker can be unlocked and seals what it is
        // given: the same world serves every app.
        let seed = centraid_identity::RecoveryPhrase::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon art",
        )
        .expect("the words parse")
        .seed();
        Self {
            sample: common::chat::sample_with_seed(seed),
            next: std::cell::Cell::new(0),
            proven: std::cell::RefCell::default(),
        }
    }

    fn key(&self) -> String {
        self.next.set(self.next.get() + 1);
        format!("undo-plane-{}", self.next.get())
    }

    /// Run an action under a fresh key.
    pub fn act(&self, app: &str, action: &str, input: &Value) -> Done {
        let answer = self
            .sample
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Act(Box::new(wire::ActRequest {
                    app: app.to_owned(),
                    action: action.to_owned(),
                    input: wire_input(input),
                    invoke_key: self.key(),
                }))),
            })
            .unwrap_or_else(|error| panic!("{app}.{action}: {error}"));
        match answer.kind {
            Some(wire::response::Kind::Act(done)) => Done { response: *done },
            other => panic!("an act answered {other:?}"),
        }
    }

    /// Run an action that must execute; its output.
    pub fn ok(&self, app: &str, action: &str, input: &Value) -> Done {
        let done = self.act(app, action, input);
        assert!(
            done.executed(),
            "{app}.{action} {input} was refused: {}",
            done.refusal()
        );
        done
    }

    /// Make a record and answer its id: the output's, or the Undo's.
    pub fn make(&self, app: &str, action: &str, input: &Value) -> String {
        let done = self.ok(app, action, input);
        let output = done.output();
        output
            .get("id")
            .or_else(|| output.get("item_id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                done.inverse()
                    .and_then(|(_, input)| input["id"].as_str().map(str::to_owned))
            })
            .unwrap_or_else(|| panic!("{app}.{action} made no id: {output:?}"))
    }

    /// The first live entity of a kind the seeded scenario holds, by id.
    pub fn first(&self, kind: &str) -> String {
        self.page_first("kind = ? AND deleted_at IS NULL", kind)
            .unwrap_or_else(|| panic!("the scenario holds no {kind}"))
    }

    /// Whether a record is live (not in the trash).
    pub fn live(&self, id: &str) -> bool {
        self.page_first("id = ? AND deleted_at IS NULL", id)
            .is_some()
    }

    /// The list a person is filed in, if any.
    pub fn list_of(&self, person: &str) -> Option<String> {
        self.page_from("edge", "from_id", "rel = 'contains' AND to_id = ?", person)
    }

    fn page_first(&self, predicate: &str, bind: &str) -> Option<String> {
        self.page_from("entity", "id", predicate, bind)
    }

    fn page_from(&self, from: &str, column: &str, predicate: &str, bind: &str) -> Option<String> {
        let answer = self
            .sample
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Page(wire::PageRequest {
                    query: Some(wire::PageQuery {
                        name: "undo_plane.first".to_owned(),
                        select: vec![column.to_owned()],
                        from: from.to_owned(),
                        r#where: Some(predicate.to_owned()),
                        bind: vec![wire::Value {
                            kind: Some(wire::value::Kind::Text(bind.to_owned())),
                        }],
                        order: Some(wire::PageOrder {
                            sort_column: column.to_owned(),
                            pk_column: column.to_owned(),
                            descending: false,
                        }),
                        ..wire::PageQuery::default()
                    }),
                    limit: 1,
                    after: None,
                })),
            })
            .expect("a page");
        let Some(wire::response::Kind::Page(page)) = answer.kind else {
            panic!("a page answered {:?}", answer.kind);
        };
        let row = page.rows.first()?;
        match row.values.first().and_then(|cell| cell.kind.clone()) {
            Some(wire::value::Kind::Text(id)) => Some(id),
            other => panic!("an id was {other:?}"),
        }
    }

    /// The record's state as the history reads it.
    pub fn state(&self, id: &str) -> Value {
        self.sample
            .handle
            .with_vault(|vault| {
                Ok(vault
                    .read(|connection| centraid_vault::history::current_state(connection, id))?)
            })
            .expect("a state")
            .unwrap_or(Value::Null)
    }

    pub fn versions(&self, id: &str) -> u32 {
        self.sample
            .handle
            .with_vault(|vault| {
                Ok(vault.read(|connection| centraid_vault::history::count(connection, id))?)
            })
            .expect("a count")
    }

    /// Change the record behind the act's back, as another edit would.
    pub fn change_again(&self, id: &str) {
        let outcome = self
            .sample
            .handle
            .command(
                "entity.retitle",
                &json!({ "id": id, "title": "Changed again" }),
                &self.key(),
            )
            .expect("a retitle");
        assert!(outcome.reason.is_none(), "{:?}", outcome.reason);
    }

    /// DO `action`, UNDO IT, AND THE RECORD IS AS IT WAS: the Undo is `undo-change` naming the
    /// record and the version this act made, run under the same app's door.
    pub fn round_trip(&self, app: &str, action: &str, id: &str, input: &Value) {
        let before = self.state(id);
        let versions = self.versions(id);
        let done = self.ok(app, action, input);
        let (undo, undo_input) = done.inverse().unwrap_or_else(|| {
            panic!(
                "{app}.{action} made a change and offers no Undo (versions {versions} then {})",
                self.versions(id)
            )
        });
        assert_eq!(undo, "undo-change", "{app}.{action}");
        assert_eq!(undo_input["id"], json!(id), "{app}.{action}");
        assert_ne!(
            self.state(id),
            before,
            "{app}.{action} changed nothing the history holds"
        );
        let back = self.ok(app, &undo, &undo_input);
        assert_eq!(
            self.state(id),
            before,
            "{app}.{action}: undo puts the record back as it was"
        );
        assert!(back.executed());
        self.proven
            .borrow_mut()
            .insert((app.to_owned(), action.to_owned()));
    }
}

#[test]
fn an_undo_names_the_version_the_act_made_and_a_changed_record_refuses_it() {
    let w = World::new();
    let task = w.make(
        "reminders",
        "add-task",
        &json!({ "title": "Water the plants" }),
    );
    assert_eq!(w.versions(&task), 0, "a creation keeps no history");

    // The Undo names the version THIS act made.
    let done = w.ok(
        "reminders",
        "edit-task",
        &json!({ "id": task, "title": "Water the ferns" }),
    );
    let (action, input) = done.inverse().expect("an edit is taken back");
    assert_eq!(
        (action.as_str(), input["seq"].as_i64()),
        ("undo-change", Some(1))
    );

    // Changed again since: the old Undo is refused and the later change stays.
    w.change_again(&task);
    let refused = w.act("reminders", &action, &input);
    assert!(!refused.executed());
    assert!(
        refused.refusal().contains("can no longer be undone"),
        "{}",
        refused.refusal()
    );
    assert_eq!(w.state(&task)["entity"]["title"], "Changed again");

    // The fresh edit's own Undo is the new newest version and works.
    let again = w.ok(
        "reminders",
        "edit-task",
        &json!({ "id": task, "title": "Feed the cat" }),
    );
    let (action, input) = again.inverse().expect("taken back");
    assert_eq!(input["seq"].as_i64(), Some(3));
    w.ok("reminders", &action, &input);
    assert_eq!(w.state(&task)["entity"]["title"], "Changed again");

    // An edit that changed nothing the history holds makes no version and offers no Undo.
    let same = w.ok(
        "reminders",
        "edit-task",
        &json!({ "id": task, "title": "Changed again" }),
    );
    assert!(same.inverse().is_none());
}

#[test]
fn an_act_the_history_does_not_capture_offers_no_earlier_undo() {
    // A tag is not a part of any record's state (`history::RELATIONS_OUTSIDE`): the act makes no
    // version, so a row giving it the earlier-version inverse would offer a lie. The core offers
    // exactly what the vault answers, and the table names the act's own inverse instead.
    let w = World::new();
    let task = w.make("reminders", "add-task", &json!({ "title": "Tagged" }));
    let tagged = w.ok(
        "reminders",
        "add-task-tag",
        &json!({ "id": task, "label": "home" }),
    );
    assert_eq!(w.versions(&task), 0);
    assert_eq!(
        tagged.inverse().map(|(action, _)| action).as_deref(),
        Some("remove-task-tag")
    );
}

fn reminders(w: &World) {
    let task = w.make(
        "reminders",
        "add-task",
        &json!({ "title": "Plan the week" }),
    );
    let project = w.make(
        "reminders",
        "create-project",
        &json!({ "kind": "project", "title": "Home" }),
    );
    w.round_trip(
        "reminders",
        "edit-task",
        &task,
        &json!({ "id": task, "title": "Plan the month", "priority": 4 }),
    );
    w.round_trip(
        "reminders",
        "organize-task",
        &task,
        &json!({ "id": task, "project_id": project }),
    );
    w.round_trip(
        "reminders",
        "rename-list",
        &project,
        &json!({ "id": project, "title": "House" }),
    );
    w.round_trip(
        "reminders",
        "style-container",
        &project,
        &json!({ "id": project, "color": "violet" }),
    );
}

/// What an action that writes nothing is asked, to prove it: `(app, action, input)`.
const WRITES_NOTHING: &[(&str, &str, &str)] = &[
    ("notes", "export-notes", "{}"),
    ("people", "export-vcf", "{}"),
    // Birthday reminders always stay on: the command refuses an off request, and an on request
    // restates what the person already has. The recipe asks for a person's birthday first.
    (
        "people",
        "set-birthday-reminder",
        "{\"id\":\"$BIRTHDAY_PERSON\",\"on\":true}",
    ),
];

#[test]
fn a_claim_of_writing_nothing_is_proven_by_running_the_action() {
    let w = World::new();
    for (app, action, input) in WRITES_NOTHING {
        // A recipe that needs a person with a birthday names one, and one is made for it.
        let input = if input.contains("$BIRTHDAY_PERSON") {
            let person = w.make(
                "people",
                "add-person",
                &json!({ "title": "Birthday Bo", "birthday": "05-05" }),
            );
            input.replace("$BIRTHDAY_PERSON", &person)
        } else {
            (*input).to_owned()
        };
        let input: Value = serde_json::from_str(&input).expect("json");
        let done = w.ok(app, action, &input);
        assert!(
            done.response.tables.is_empty(),
            "{app}.{action} changed {:?}",
            done.response.tables
        );
        assert!(done.inverse().is_none());
    }
    // Every action a manifest says writes nothing has a recipe above, which was just run. A recipe
    // for an action that does write fails above, so a claim is never trusted: it is proven.
    for app in [
        "calendar",
        "docs",
        "health",
        "locker",
        "money",
        "notes",
        "people",
        "photos",
        "reminders",
    ] {
        let path = format!("{}/../apps/{app}/manifest.json", env!("CARGO_MANIFEST_DIR"));
        let manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("a manifest"))
                .expect("json");
        for entry in manifest["actions"].as_array().expect("actions") {
            if entry["writes_nothing"] == json!(true) {
                let name = entry["name"].as_str().expect("a name");
                assert!(
                    WRITES_NOTHING
                        .iter()
                        .any(|(a, action, _)| *a == app && *action == name),
                    "{app}.{name} claims `writes_nothing` and nothing proves it: add it to WRITES_NOTHING"
                );
            }
        }
    }
}

fn docs(w: &World) {
    let doc = w.make(
        "docs",
        "create-text",
        &json!({ "title": "Lease", "body_text": "first words" }),
    );
    let folder = w.make(
        "docs",
        "create-folder",
        &json!({ "kind": "folder", "title": "Home papers" }),
    );
    w.round_trip(
        "docs",
        "rename",
        &doc,
        &json!({ "id": doc, "title": "Lease 2026" }),
    );
    w.round_trip(
        "docs",
        "move",
        &doc,
        &json!({ "id": doc, "folder_id": folder }),
    );
    w.round_trip(
        "docs",
        "rename-folder",
        &folder,
        &json!({ "id": folder, "title": "Papers" }),
    );
    w.round_trip(
        "docs",
        "edit",
        &doc,
        &json!({ "id": doc, "body_text": "second words", "title": "Lease final" }),
    );
    let bytes = "a replacement document";
    let hash = centraid_vault::blob::content_digest(bytes.as_bytes());
    w.sample
        .handle
        .command(
            "blob.stage",
            &json!({ "hash": hash, "size": bytes.len() }),
            "stage-bytes",
        )
        .expect("stage");
    w.round_trip(
        "docs",
        "replace",
        &doc,
        &json!({ "id": doc, "blob": hash, "media_type": "text/plain" }),
    );
    // A change that stays, so that the first version is a state to go back to.
    w.ok(
        "docs",
        "edit",
        &json!({ "id": doc, "body_text": "kept words" }),
    );
    w.round_trip(
        "docs",
        "restore-version",
        &doc,
        &json!({ "id": doc, "seq": 1 }),
    );
}

fn notes(w: &World) {
    let book = w.make(
        "notes",
        "create-notebook",
        &json!({ "kind": "notebook", "title": "Ideas" }),
    );
    let note = w.make(
        "notes",
        "create-note",
        &json!({ "title": "Plan", "body": "one" }),
    );
    w.round_trip(
        "notes",
        "edit-note",
        &note,
        &json!({ "id": note, "body": "two" }),
    );
    w.round_trip(
        "notes",
        "move-note",
        &note,
        &json!({ "id": note, "notebook_id": book }),
    );
    w.round_trip(
        "notes",
        "rename-notebook",
        &book,
        &json!({ "id": book, "title": "Big ideas" }),
    );
    w.ok(
        "notes",
        "edit-note",
        &json!({ "id": note, "body": "kept words" }),
    );
    w.round_trip(
        "notes",
        "restore-note-version",
        &note,
        &json!({ "id": note, "seq": 1 }),
    );
    // `undo-create` is the shell's, run under any app: what an act created goes to the trash.
    let made = w.make(
        "reminders",
        "add-task",
        &json!({ "title": "Made by mistake" }),
    );
    assert!(w.live(&made));
    w.ok("notes", "undo-create", &json!({ "id": made }));
    assert!(!w.live(&made), "the task is in the trash");
}

fn calendar(w: &World) {
    let person = w.first("person");
    let event = w.make(
        "calendar",
        "propose",
        &json!({ "title": "Standup", "starts": "2030-01-10T09:00:00", "ends": "2030-01-10T09:30:00", "timing": "floating", "attendees": [person] }),
    );
    w.round_trip(
        "calendar",
        "edit-event",
        &event,
        &json!({ "id": event, "title": "Standup moved", "description": "Room 4" }),
    );
    w.round_trip(
        "calendar",
        "rsvp",
        &event,
        &json!({ "id": event, "person_id": person, "state": "accepted" }),
    );
    w.round_trip("calendar", "cancel-event", &event, &json!({ "id": event }));
    let series = w.make(
        "calendar",
        "propose",
        &json!({ "title": "Weekly review", "starts": "2030-02-04T14:00:00", "ends": "2030-02-04T14:30:00", "timing": "floating", "rule": "FREQ=WEEKLY" }),
    );
    w.round_trip(
        "calendar",
        "edit-occurrence",
        &series,
        &json!({ "id": series, "original_start": "2030-02-11T14:00:00", "scope": "occurrence", "action": "skip" }),
    );
    let side = w.make(
        "calendar",
        "create-calendar",
        &json!({ "kind": "calendar", "title": "Side" }),
    );
    w.round_trip(
        "calendar",
        "rename-calendar",
        &side,
        &json!({ "id": side, "title": "Side projects" }),
    );
    w.round_trip(
        "calendar",
        "style-calendar",
        &side,
        &json!({ "id": side, "color": "violet" }),
    );
    // What an act created goes to the trash when taken back.
    let made = w.ok("calendar", "add-place", &json!({ "title": "Mistake cove" }));
    let (undo, back) = made
        .inverse()
        .unwrap_or_else(|| panic!("a creation is taken back: {:?}", made.response));
    assert_eq!(undo, "undo-create");
    let id = back["id"].as_str().expect("an id").to_owned();
    assert!(w.live(&id));
    w.ok("calendar", &undo, &back);
    assert!(!w.live(&id), "the place is in the trash");
}

fn health(w: &World) {
    let workout = w.make(
        "health",
        "log-workout",
        &json!({ "type": "run", "title": "Morning run", "starts": "2030-03-01T07:00:00", "distance_m": 5000 }),
    );
    w.round_trip(
        "health",
        "edit-workout",
        &workout,
        &json!({ "id": workout, "title": "Long run", "distance_m": 8000 }),
    );
}

fn money(w: &World) {
    let account = w.first("account");
    w.round_trip(
        "money",
        "edit-account",
        &account,
        &json!({ "id": account, "title": "Everyday spending", "on_budget": false }),
    );
    let line = w.first("txn");
    w.round_trip(
        "money",
        "set-display-name",
        &line,
        &json!({ "id": line, "title": "Corner shop" }),
    );
}

/// What the Locker session reveals of `column` of `item`, live.
fn reveal(w: &World, item: &str, column: &str) -> Option<String> {
    let answer = w
        .sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(wire::locker_session_request::Step::Reveal(
                    wire::LockerReveal {
                        item_id: item.to_owned(),
                        column: column.to_owned(),
                        ..wire::LockerReveal::default()
                    },
                )),
            })),
        })
        .expect("the session answers");
    let Some(wire::response::Kind::Locker(answer)) = answer.kind else {
        panic!("a locker answer");
    };
    answer.revealed.map(|shown| shown.value)
}

/// Locker: every edit is taken back by the version it made, a changed secret included, and the
/// SEALED old value is what comes back (the round trip compares the whole state, ciphertext and
/// all; the reveal at the end opens it).
fn locker(w: &World) {
    let answer = w
        .sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(wire::locker_session_request::Step::Unlock(
                    wire::LockerUnlock::default(),
                )),
            })),
        })
        .expect("the session answers");
    let Some(wire::response::Kind::Locker(answer)) = answer.kind else {
        panic!("a locker answer");
    };
    assert_eq!(answer.state, wire::LockerSessionState::Unlocked as i32);

    let item = w.make(
        "locker",
        "add-item",
        &json!({ "type": "login", "title": "Bank", "username": "ada@example.com",
                 "url": "https://bank.example", "password": "first password" }),
    );
    w.round_trip(
        "locker",
        "edit-item",
        &item,
        &json!({ "item_id": item, "title": "Bank", "username": "ada@example.com",
                 "url": "https://bank.example", "password": "second password" }),
    );
    assert_eq!(
        reveal(w, &item, "password").as_deref(),
        Some("first password"),
        "the undo of a password change puts the old sealed password back"
    );
    w.round_trip(
        "locker",
        "set-memo",
        &item,
        &json!({ "item_id": item, "note": "Ask for Priya" }),
    );
    w.round_trip(
        "locker",
        "set-addresses",
        &item,
        &json!({ "item_id": item, "addresses": "[{\"url\":\"https://bank.example/login\"}]" }),
    );
    w.ok(
        "locker",
        "set-field",
        &json!({ "item_id": item, "field_id": "f-plain", "label": "Branch", "kind": "text", "value": "Main" }),
    );
    w.round_trip(
        "locker",
        "set-field",
        &item,
        &json!({ "item_id": item, "field_id": "f-pin", "label": "PIN", "kind": "sealed", "value": "1234" }),
    );
    w.ok(
        "locker",
        "set-field",
        &json!({ "item_id": item, "field_id": "f-pin", "label": "PIN", "kind": "sealed", "value": "1234" }),
    );
    w.round_trip(
        "locker",
        "set-field",
        &item,
        &json!({ "item_id": item, "field_id": "f-pin", "label": "PIN", "kind": "sealed", "value": "5678" }),
    );
    w.round_trip(
        "locker",
        "remove-field",
        &item,
        &json!({ "item_id": item, "field_id": "f-pin" }),
    );
    w.ok(
        "locker",
        "set-passkey",
        &json!({ "item_id": item, "rp_id": "bank.example", "display_name": "Laptop" }),
    );
    w.round_trip(
        "locker",
        "set-passkey",
        &item,
        &json!({ "item_id": item, "rp_id": "bank.example", "display_name": "Phone" }),
    );
    w.round_trip(
        "locker",
        "clear-passkey",
        &item,
        &json!({ "item_id": item }),
    );
}

fn people(w: &World) {
    let person = w.make("people", "add-person", &json!({ "title": "Una Undo" }));
    let list = w.make(
        "people",
        "create-list",
        &json!({ "kind": "list", "title": "Family" }),
    );
    w.round_trip(
        "people",
        "edit-person",
        &person,
        &json!({ "id": person, "role": "Chef" }),
    );
    w.round_trip(
        "people",
        "set-cadence",
        &person,
        &json!({ "id": person, "cadence_days": 14 }),
    );
    w.round_trip(
        "people",
        "rename-list",
        &list,
        &json!({ "id": list, "title": "Relatives" }),
    );
    // A contact channel is a child row of the person, which the history keeps on the person.
    w.round_trip(
        "people",
        "save-contact-channel",
        &person,
        &json!({ "id": person, "kind": "phone", "value": "+44 7700 900123" }),
    );
    // A follow-up is a task: completing it and reopening it are each one record's edit.
    let task = w
        .ok(
            "people",
            "add-task",
            &json!({ "id": person, "text": "send the photos" }),
        )
        .output()["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    w.round_trip("people", "complete-task", &task, &json!({ "id": task }));
    w.ok("people", "complete-task", &json!({ "id": task }));
    w.round_trip("people", "reopen-task", &task, &json!({ "id": task }));
    // An important date is an event, so changing its reminder is one record's edit.
    let date = w
        .ok(
            "people",
            "add-important-date",
            &json!({ "id": person, "label": "Anniversary", "month_day": "06-01" }),
        )
        .output()["date_id"]
        .as_str()
        .expect("a date")
        .to_owned();
    w.round_trip(
        "people",
        "set-reminder",
        &date,
        &json!({ "id": date, "reminders": [0] }),
    );
}

/// What a member records about a person is its own entity, and taking the act back puts it in the
/// trash; a move between lists is the same move with the list it replaced; a relationship is taken back by removing that edge; a birthday date is the person's
/// own column, so it is taken back by the person's earlier version.
#[test]
fn what_is_recorded_about_a_person_is_taken_back_and_a_list_comes_back_whole() {
    let w = World::new();
    let person = w.make("people", "add-person", &json!({ "title": "Una Undo" }));
    let other = w.make("people", "add-person", &json!({ "title": "Otis Other" }));

    let trashed_by_undo = |action: &str, input: &Value, key: &str| {
        let done = w.ok("people", action, input);
        let id = done.output()[key].as_str().expect("an id").to_owned();
        let (undo, back) = done
            .inverse()
            .unwrap_or_else(|| panic!("{action} is taken back"));
        assert_eq!(
            (undo.as_str(), &back["id"]),
            ("undo-create", &json!(id)),
            "{action}"
        );
        assert!(w.live(&id), "{action} made {id}");
        w.ok("people", &undo, &back);
        assert!(!w.live(&id), "{action}: what it made is in the trash");
        assert!(w.live(&person), "{action}: the person stays");
    };
    trashed_by_undo(
        "log-interaction",
        &json!({ "id": person, "kind": "coffee", "text": "caught up" }),
        "interaction_id",
    );
    trashed_by_undo(
        "add-note",
        &json!({ "id": person, "text": "likes tea" }),
        "note_id",
    );
    trashed_by_undo(
        "add-task",
        &json!({ "id": person, "text": "send the photos" }),
        "task_id",
    );
    trashed_by_undo(
        "add-gift",
        &json!({ "id": person, "text": "a kettle" }),
        "task_id",
    );
    trashed_by_undo(
        "add-journal-entry",
        &json!({ "mood": "calm", "text": "a good day" }),
        "entry_id",
    );
    trashed_by_undo(
        "add-important-date",
        &json!({ "id": person, "label": "Moved in", "month_day": "09-09" }),
        "date_id",
    );

    // A birthday is the person's own column: the date act edits the person, and the Undo is
    // their earlier version.
    let before = w.state(&person);
    let birthday = w.ok(
        "people",
        "add-important-date",
        &json!({ "id": person, "label": "Birthday", "month_day": "03-03" }),
    );
    let (undo, back) = birthday.inverse().expect("a birthday is taken back");
    assert_eq!(undo, "undo-change");
    assert_ne!(w.state(&person), before);
    w.ok("people", &undo, &back);
    assert_eq!(w.state(&person), before);

    // A move between lists is taken back by moving them where they were, or out.
    let family = w.make(
        "people",
        "create-list",
        &json!({ "kind": "list", "title": "Family" }),
    );
    let work = w.make(
        "people",
        "create-list",
        &json!({ "kind": "list", "title": "Work" }),
    );
    let into_family = w.ok(
        "people",
        "move-person",
        &json!({ "id": person, "list_id": family }),
    );
    let (undo, back) = into_family.inverse().expect("a move is taken back");
    assert_eq!(undo, "move-person");
    assert_eq!(
        back["list_id"],
        Value::Null,
        "they were in no list: out again"
    );
    assert_eq!(w.list_of(&person).as_deref(), Some(family.as_str()));
    w.ok("people", &undo, &back);
    assert_eq!(w.list_of(&person), None, "undone: in no list again");
    w.ok(
        "people",
        "move-person",
        &json!({ "id": person, "list_id": family }),
    );
    let into_work = w.ok(
        "people",
        "move-person",
        &json!({ "id": person, "list_id": work }),
    );
    let (undo, back) = into_work.inverse().expect("a move is taken back");
    assert_eq!(back["list_id"], json!(family));
    assert_eq!(w.list_of(&person).as_deref(), Some(work.as_str()));
    w.ok("people", &undo, &back);
    assert_eq!(w.list_of(&person).as_deref(), Some(family.as_str()));

    // A relationship is an edge, which the history does not keep: taking it back removes it.
    let linked = w.ok(
        "people",
        "add-relationship",
        &json!({ "id": person, "name": "Otis Other", "kind": "friend", "related_id": other }),
    );
    let (undo, back) = linked.inverse().expect("a relationship is taken back");
    assert_eq!(undo, "remove-relationship");
    assert_eq!(back["to"], json!(other));
    let removed = w.ok("people", &undo, &back);
    assert_eq!(removed.output()["removed"], json!(true));
}

fn photos(w: &World) {
    let photo = w.first("photo");
    let album = w.make(
        "photos",
        "create-album",
        &json!({ "kind": "album", "title": "Undo album" }),
    );
    // A place the photograph is not at yet, so that pointing it there is a change.
    let place = w
        .sample
        .handle
        .command("place.add", &json!({ "title": "Undo cove" }), "undo-cove")
        .expect("a place")
        .output["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.round_trip(
        "photos",
        "edit-photo",
        &photo,
        &json!({ "id": photo, "taken_at": "2026-01-02T03:04:05Z" }),
    );
    w.round_trip(
        "photos",
        "retitle-photo",
        &photo,
        &json!({ "id": photo, "title": "A new caption" }),
    );
    w.round_trip(
        "photos",
        "rename-album",
        &album,
        &json!({ "id": album, "title": "Renamed album" }),
    );
    w.round_trip(
        "photos",
        "set-place",
        &photo,
        &json!({ "id": photo, "place_id": place }),
    );
    w.round_trip(
        "photos",
        "name-place",
        &place,
        &json!({ "id": place, "title": "Somewhere new" }),
    );
    w.ok(
        "photos",
        "add-to-album",
        &json!({ "from": album, "to": photo, "rel": "contains" }),
    );
    w.round_trip(
        "photos",
        "set-album-cover",
        &album,
        &json!({ "id": album, "photo_id": photo }),
    );
}

/// EVERY ROW THAT TAKES AN ACTION BACK BY ITS EARLIER VERSION IS PROVEN BY A ROUND TRIP, and the
/// rows are read from the table itself: the classification of "the history captures this" is
/// the vault answering that the act made a version (the round trip asserts the state changed and
/// came back), never a list of names kept here.
#[test]
fn every_earlier_row_round_trips_and_nothing_else_is_claimed() {
    let w = World::new();
    reminders(&w);
    calendar(&w);
    docs(&w);
    health(&w);
    money(&w);
    locker(&w);
    notes(&w);
    people(&w);
    photos(&w);
    let proven = w.proven.borrow().clone();

    let table = include_str!("../src/act/inverse.rs");
    let mut declared = std::collections::BTreeSet::new();
    let mut app = "";
    for line in table.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("const ")
            && rest.contains(": &[Row]")
        {
            app = match rest.split(':').next().unwrap_or_default() {
                "CALENDAR" => "calendar",
                "DOCS" => "docs",
                "HEALTH" => "health",
                "LOCKER" => "locker",
                "MONEY" => "money",
                "NOTES" => "notes",
                "PEOPLE" => "people",
                "PHOTOS" => "photos",
                "REMINDERS" => "reminders",
                other => panic!("an unknown table {other}"),
            };
        }
        if line.ends_with("Input::Earlier),")
            && let Some(action) = line
                .strip_prefix("(\"")
                .and_then(|rest| rest.split('"').next())
        {
            declared.insert((app.to_owned(), action.to_owned()));
        }
    }
    assert_eq!(
        proven, declared,
        "a row without a round trip, or a round trip without a row"
    );
}

/// A label's colour is no record's state, so the history keeps none: the command answers the colour
/// it replaced and the Undo is the same action with it.
#[test]
fn a_label_colour_is_taken_back_by_the_colour_it_replaced() {
    let w = World::new();
    let doc = w.make("docs", "create-text", &json!({ "title": "Lease" }));
    w.ok("docs", "tag", &json!({ "id": doc, "label": "keep" }));
    w.ok(
        "docs",
        "recolor-label",
        &json!({ "label": "keep", "color": "violet" }),
    );
    let first = w.ok(
        "docs",
        "recolor-label",
        &json!({ "label": "keep", "color": "petrol" }),
    );
    let (undo, back) = first.inverse().expect("a colour is taken back");
    assert_eq!(
        (undo.as_str(), &back["color"]),
        ("recolor-label", &json!("violet"))
    );
    let second = w.ok("docs", &undo, &back);
    let (_, forward) = second.inverse().expect("and taken back again");
    assert_eq!(forward["color"], json!("petrol"));
}

impl World {
    /// Whether the vault follows a phone store: the origin of a system and ref, if it holds one.
    pub fn followed(&self, system: &str, reference: &str) -> bool {
        self.sample
            .handle
            .with_vault(|vault| {
                Ok(vault.read(|connection| {
                    Ok(connection.query_row(
                        "SELECT EXISTS (SELECT 1 FROM origin WHERE system = ?1 AND ref = ?2)",
                        [system, reference],
                        |row| row.get::<_, bool>(0),
                    )?)
                })?)
            })
            .expect("an origin count")
    }
}

/// Connecting the phone's contacts is taken back by disconnecting the store (owner ruling): the
/// store is no longer followed and the people the pass brought stay.
#[test]
fn following_the_contacts_is_taken_back_by_stopping_and_the_people_stay() {
    let w = World::new();
    let origin = json!({ "ref": "phone-contacts", "label": "Phone" });
    let done = w.ok(
        "people",
        "follow-contacts",
        &json!({ "origin": origin, "complete": true, "records": [
            { "external_id": "c1", "fields": { "title": "Ada Lovelace" } }
        ] }),
    );
    assert!(w.followed("contacts", "phone-contacts"));
    let (undo, back) = done.inverse().expect("a connection is taken back");
    assert_eq!(undo, "stop-following");
    assert_eq!(
        back,
        json!({ "system": "contacts", "ref": "phone-contacts" })
    );
    let stopped = w.ok("people", &undo, &back);
    assert_eq!(stopped.output()["stopped"], json!(true));
    assert!(
        !w.followed("contacts", "phone-contacts"),
        "no longer followed"
    );
    let ada = w.sample.handle.with_vault(|vault| {
        Ok(vault.read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM entity WHERE title = 'Ada Lovelace' AND deleted_at IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })?)
    });
    assert_eq!(ada.expect("a count"), 1, "the followed person remains");
    // Stopping what is not followed is nothing, and the action answers so.
    let again = w.ok("people", "stop-following", &back);
    assert_eq!(again.output()["stopped"], json!(false));
}

impl World {
    /// The figure a person's day holds for a metric (the vault owner's, as the actions here name).
    pub fn figure(&self, day: &str, metric: &str) -> Option<f64> {
        self.sample
            .handle
            .with_vault(|vault| {
                Ok(vault.read(|connection| {
                    Ok(connection
                        .query_row(
                            "SELECT value FROM measurement WHERE day = ?1 AND metric = ?2",
                            [day, metric],
                            |row| row.get::<_, f64>(0),
                        )
                        .ok())
                })?)
            })
            .expect("a figure")
    }
}

/// A figure is outside the history, so each act answers the value it replaced and the Undo puts
/// exactly that back: a new figure is cleared, a replaced one is the one that was there, and a
/// cleared one is logged again.
#[test]
fn a_figure_comes_back_as_it_was_and_a_cleared_one_is_logged_again() {
    let w = World::new();
    let (day, metric) = ("2030-03-02", "weight_kg");
    // New: its Undo clears it.
    let first = w.ok(
        "health",
        "log-figure",
        &json!({ "day": day, "metric": metric, "value": 70.5 }),
    );
    let (undo, back) = first.inverse().expect("a new figure is taken back");
    assert_eq!(undo, "clear-figure");
    assert_eq!(w.figure(day, metric), Some(70.5));
    w.ok("health", &undo, &back);
    assert_eq!(w.figure(day, metric), None, "undone: no figure");
    // Replaced, by either action: the Undo is the figure that was there.
    w.ok(
        "health",
        "log-figure",
        &json!({ "day": day, "metric": metric, "value": 70.5 }),
    );
    for action in ["log-figure", "edit-figure"] {
        let replaced = w.ok(
            "health",
            action,
            &json!({ "day": day, "metric": metric, "value": 72.25 }),
        );
        let (undo, back) = replaced.inverse().expect("a replaced figure is taken back");
        assert_eq!((undo.as_str(), &back["value"]), (action, &json!(70.5)));
        assert_eq!(w.figure(day, metric), Some(72.25));
        w.ok("health", &undo, &back);
        assert_eq!(
            w.figure(day, metric),
            Some(70.5),
            "{action}: the exact prior figure"
        );
    }
    // Cleared: the Undo logs the value that went.
    let cleared = w.ok(
        "health",
        "clear-figure",
        &json!({ "day": day, "metric": metric }),
    );
    let (undo, back) = cleared.inverse().expect("a clearing is taken back");
    assert_eq!(undo, "log-figure");
    assert_eq!(w.figure(day, metric), None);
    w.ok("health", &undo, &back);
    assert_eq!(w.figure(day, metric), Some(70.5));
}

/// Connecting the health store is taken back by stopping it, and the days and workouts stay. The
/// day totals a pass writes are the pass, not a member's act: they name no store, so offer none.
#[test]
fn following_the_health_store_is_taken_back_by_stopping_and_its_days_stay() {
    let w = World::new();
    let done = w.ok(
        "health",
        "follow-workouts",
        &json!({ "origin": { "ref": "healthkit", "label": "Apple Health" }, "records": [] }),
    );
    assert!(w.followed("health", "healthkit"));
    let (undo, back) = done.inverse().expect("a connection is taken back");
    assert_eq!(undo, "stop-following");
    assert_eq!(back, json!({ "system": "health", "ref": "healthkit" }));
    let days = w.ok(
        "health",
        "record-days",
        &json!({ "days": [{ "day": "2030-03-03", "metric": "steps", "value": 8000 }] }),
    );
    assert!(days.inverse().is_none(), "a day total names no store");
    w.ok("health", &undo, &back);
    assert!(!w.followed("health", "healthkit"));
    assert_eq!(
        w.figure("2030-03-03", "steps"),
        Some(8000.0),
        "the days stay"
    );
}

/// Creating a calendar is taken back by the shell's trash: the calendar and the events that were
/// put on it go to the trash, and the calendar's own restore brings back exactly those.
#[test]
fn a_created_calendar_is_taken_back_by_the_trash_and_restored_whole() {
    let w = World::new();
    let made = w.ok(
        "calendar",
        "create-calendar",
        &json!({ "kind": "calendar", "title": "Side" }),
    );
    let (undo, back) = made.inverse().expect("a calendar is taken back");
    assert_eq!(undo, "undo-create");
    let side = back["id"].as_str().expect("an id").to_owned();
    let event = w.make(
        "calendar",
        "propose",
        &json!({ "title": "Side standup", "starts": "2030-04-01T09:00:00", "ends": "2030-04-01T09:30:00", "timing": "floating", "calendar_id": side }),
    );
    assert!(w.live(&side) && w.live(&event));
    w.ok("calendar", &undo, &back);
    assert!(!w.live(&side), "the calendar is in the trash");
    assert!(!w.live(&event), "and its event went with it");
    w.ok("calendar", "restore-event", &json!({ "id": side }));
    assert!(w.live(&side) && w.live(&event), "restored whole");
}

/// Connecting the phone's calendars is taken back by stopping, and the events stay.
#[test]
fn following_the_phones_calendar_is_taken_back_by_stopping_and_its_events_stay() {
    let w = World::new();
    let done = w.ok(
        "calendar",
        "follow-calendar",
        &json!({ "origin": { "ref": "calendar:work", "label": "Work" }, "complete": true, "records": [
            { "external_id": "uid:1", "fields": { "title": "Sync with the phone",
              "starts": "2030-05-02T09:00", "ends": "2030-05-02T10:00", "timing": "floating",
              "rule": null, "busy": 1 } }
        ] }),
    );
    assert!(w.followed("calendar", "calendar:work"));
    let (undo, back) = done.inverse().expect("a connection is taken back");
    assert_eq!(undo, "stop-following");
    assert_eq!(
        back,
        json!({ "system": "calendar", "ref": "calendar:work" })
    );
    w.ok("calendar", &undo, &back);
    assert!(!w.followed("calendar", "calendar:work"));
    let kept = w.sample.handle.with_vault(|vault| {
        Ok(vault.read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM entity WHERE title = 'Sync with the phone' AND deleted_at IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })?)
    });
    assert_eq!(kept.expect("a count"), 1, "the followed event remains");
}

impl World {
    /// The first column of the first row a query answers, as text; `None` for no row or a NULL.
    pub fn text(&self, sql: &str) -> Option<String> {
        self.sample
            .handle
            .with_vault(|vault| {
                Ok(vault.read(|connection| {
                    Ok(connection
                        .query_row(sql, [], |row| row.get::<_, Option<String>>(0))
                        .ok()
                        .flatten())
                })?)
            })
            .expect("a text")
    }

    /// The whole of what a query answers, as one string, for comparing a state before and after.
    pub fn rows(&self, sql: &str) -> String {
        self.text(&format!(
            "SELECT COALESCE(group_concat(r, ';'), '') FROM (SELECT {sql} AS r)"
        ))
        .unwrap_or_default()
    }
}

fn layout(first_col: u32) -> Value {
    json!({ "header_fingerprint": "date|amount|memo", "delimiter": ",", "date_order": "ymd",
            "sign_mode": "signed", "date_col": first_col, "amount_col": 1, "desc_col": 2 })
}

/// Money's acts that the history does not keep as a version, taken back by what the command says
/// they replaced: do it, undo it, and what the vault holds is what it held.
#[test]
fn money_acts_are_taken_back_by_what_they_replaced_and_state_equals_before() {
    let w = World::new();

    // A new account is closed again, and reopening it is the Undo of that.
    let flags = |id: &str| {
        w.rows(&format!(
            "(SELECT COUNT(*) FROM edge WHERE from_id = '{id}' AND rel = 'tagged')"
        ))
    };
    let made = w.ok(
        "money",
        "add-account",
        &json!({ "title": "Holiday jar", "type": "cash" }),
    );
    let (undo, back) = made.inverse().expect("an account is taken back");
    assert_eq!(undo, "close-account");
    let id = back["id"].as_str().expect("an id").to_owned();
    assert_eq!(flags(&id), "0");
    let closed = w.ok("money", &undo, &back);
    assert_eq!(flags(&id), "1", "the new account is closed");
    let (undo, back) = closed.inverse().expect("closing is taken back");
    assert_eq!(undo, "reopen-account");
    w.ok("money", &undo, &back);
    assert_eq!(flags(&id), "0");

    // A category filed on a line: the line goes back to the category it held (or none).
    let line = w
        .text("SELECT id FROM txn WHERE category_id IS NULL LIMIT 1")
        .expect("an unfiled line");
    let before = w.state(&line);
    let filed = w.ok(
        "money",
        "categorize",
        &json!({ "ids": [line], "category_id": "category:food.dining" }),
    );
    let (undo, back) = filed.inverse().expect("filing is taken back");
    assert_eq!(undo, "categorize");
    assert_eq!(back["category_id"], Value::Null);
    assert_ne!(w.state(&line), before);
    w.ok("money", &undo, &back);
    assert_eq!(w.state(&line), before, "filed back under nothing");
    // Lines that held different categories are not put back by one act, so none is offered.
    let other = w
        .text("SELECT id FROM txn WHERE category_id IS NOT NULL AND category_id <> 'category:food.dining' LIMIT 1")
        .expect("a filed line");
    let mixed = w.ok(
        "money",
        "categorize",
        &json!({ "ids": [line, other], "category_id": "category:food.dining" }),
    );
    assert!(mixed.inverse().is_none());

    // An ended transfer is linked again, both halves as they were.
    let half = w
        .text(
            "SELECT a.id FROM txn a JOIN txn b ON b.amount_minor = -a.amount_minor
              AND b.account_id <> a.account_id AND b.currency = a.currency
              AND b.transfer_id IS NULL WHERE a.transfer_id IS NULL AND a.amount_minor < 0
              AND a.status <> 'void' AND b.status <> 'void' LIMIT 1",
        )
        .expect("a line with a matching line on another account");
    let partner = w
        .text(&format!(
            "SELECT b.id FROM txn a JOIN txn b ON b.amount_minor = -a.amount_minor
              AND b.account_id <> a.account_id AND b.currency = a.currency
              AND b.transfer_id IS NULL WHERE a.id = '{half}' AND b.status <> 'void' LIMIT 1"
        ))
        .expect("its other half");
    w.ok(
        "money",
        "link-transfer",
        &json!({ "id": half, "other_id": partner }),
    );
    let (a, b) = (w.state(&half), w.state(&partner));
    let ended = w.ok("money", "unlink-transfer", &json!({ "id": half }));
    let (undo, back) = ended.inverse().expect("an unlink is taken back");
    assert_eq!(undo, "link-transfer");
    assert_eq!(back, json!({ "id": half, "other_id": partner }));
    assert_ne!(w.state(&half), a);
    w.ok("money", &undo, &back);
    assert_eq!((w.state(&half), w.state(&partner)), (a, b));

    // A plan: a changed amount comes back, and a month that had none has none again.
    let plan = "SELECT month || '|' || category_id FROM budget LIMIT 1";
    let key = w.text(plan).expect("a plan");
    let (month, category) = key.split_once('|').expect("month|category");
    let plan_of = |month: &str| {
        w.rows(&format!(
            "(SELECT group_concat(amount_minor || currency || carry) FROM budget WHERE month = '{month}' AND category_id = '{category}')"
        ))
    };
    let held = plan_of(month);
    let amount: i64 = w
        .text(&format!(
            "SELECT CAST(amount_minor AS TEXT) FROM budget WHERE month = '{month}' AND category_id = '{category}'"
        ))
        .and_then(|text| text.parse().ok())
        .expect("an amount");
    let raised = w.ok(
        "money",
        "set-target",
        &json!({ "month": month, "category_id": category, "amount_minor": amount + 1_000 }),
    );
    let (undo, back) = raised.inverse().expect("a plan is taken back");
    assert_ne!(plan_of(month), held);
    w.ok("money", &undo, &back);
    assert_eq!(plan_of(month), held, "the plan as it was");
    let fresh = w.ok(
        "money",
        "set-target",
        &json!({ "month": "2031-01", "category_id": category, "amount_minor": 12_345 }),
    );
    let (undo, back) = fresh.inverse().expect("a new plan is taken back");
    assert_eq!(back["amount_minor"], Value::Null);
    w.ok("money", &undo, &back);
    assert_eq!(plan_of("2031-01"), "", "no plan again");
    // Carrying a plan over comes back the same way.
    let flipped = w.ok(
        "money",
        "set-carry",
        &json!({ "month": month, "category_id": category, "carry": !held.ends_with('1') }),
    );
    let (undo, back) = flipped.inverse().expect("carry is taken back");
    assert_ne!(plan_of(month), held);
    w.ok("money", &undo, &back);
    assert_eq!(plan_of(month), held);

    // A rule's edit: every field it stated is put back, one it set from nothing is nothing again.
    let rule_row = |id: &str| {
        w.rows(&format!(
            "(SELECT pattern || '|' || COALESCE(display_name, '-') || '|' || category_id || '|' || position FROM rule WHERE id = '{id}')"
        ))
    };
    let rule = "demo-money-rule-sbux";
    let held = rule_row(rule);
    let edited = w.ok(
        "money",
        "edit-rule",
        &json!({ "id": rule, "text": "STARBUCKS COFFEE", "display_name": "Coffee", "min": 100 }),
    );
    let (undo, back) = edited.inverse().expect("a rule edit is taken back");
    assert_eq!(undo, "edit-rule");
    assert_ne!(rule_row(rule), held);
    w.ok("money", &undo, &back);
    assert_eq!(rule_row(rule), held, "the rule as it was");

    // A remembered layout: the first is forgotten again, a second gives way to the first.
    let account = w.first("account");
    let config = || {
        w.rows(&format!(
            "(SELECT COALESCE(config, '-') FROM origin WHERE system = 'statement' AND fills = '{account}')"
        ))
    };
    let held = config();
    let first = w.ok(
        "money",
        "save-import-profile",
        &json!({ "id": account, "layout": layout(0) }),
    );
    let (undo, back) = first.inverse().expect("a layout is taken back");
    assert_ne!(config(), held);
    let second = w.ok(
        "money",
        "save-import-profile",
        &json!({ "id": account, "layout": layout(3) }),
    );
    let (undo_second, back_second) = second.inverse().expect("a second layout too");
    w.ok("money", &undo_second, &back_second);
    w.ok("money", &undo, &back);
    assert_eq!(config(), held, "the layout as it was");

    // A category made and archived: archiving is the Undo of making, un-archiving of archiving.
    let archived_edges = |id: &str| {
        w.rows(&format!(
            "(SELECT COUNT(*) FROM edge WHERE from_id = '{id}' AND rel = 'tagged')"
        ))
    };
    let category = w.ok("money", "add-category", &json!({ "title": "Pets" }));
    let (undo, back) = category.inverse().expect("a category is taken back");
    assert_eq!(undo, "archive-category");
    let pets = back["id"].as_str().expect("an id").to_owned();
    assert_eq!(archived_edges(&pets), "0");
    let archived = w.ok("money", &undo, &back);
    assert_eq!(archived_edges(&pets), "1");
    let (undo, back) = archived.inverse().expect("archiving is taken back");
    assert_eq!(undo, "unarchive-category");
    w.ok("money", &undo, &back);
    assert_eq!(archived_edges(&pets), "0");
}
