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
use common::chat::{Sample, sample};
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
        Self {
            sample: sample(),
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

    fn page_first(&self, predicate: &str, bind: &str) -> Option<String> {
        let answer = self
            .sample
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Page(wire::PageRequest {
                    query: Some(wire::PageQuery {
                        name: "undo_plane.first".to_owned(),
                        select: vec!["id".to_owned()],
                        from: "entity".to_owned(),
                        r#where: Some(predicate.to_owned()),
                        bind: vec![wire::Value {
                            kind: Some(wire::value::Kind::Text(bind.to_owned())),
                        }],
                        order: Some(wire::PageOrder {
                            sort_column: "id".to_owned(),
                            pk_column: "id".to_owned(),
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
];

#[test]
fn a_claim_of_writing_nothing_is_proven_by_running_the_action() {
    let w = World::new();
    for (app, action, input) in WRITES_NOTHING {
        let input: Value = serde_json::from_str(input).expect("json");
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
    docs(&w);
    notes(&w);
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
