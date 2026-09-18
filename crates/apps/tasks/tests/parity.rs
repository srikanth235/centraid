//! PARITY WITH v0, CASE BY CASE (#1020, D-1020-D3-6).
//!
//! `contracts/apps/tasks/` is generated from the v0 tree by
//! `contracts/tools/export-tasks-parity.ts`: a fresh vault, the shared
//! `schedule.*` script through the REAL typed commands, then both Tasks queries
//! through the REAL handler path. This suite rebuilds that vault from
//! `rows.json`, reads the same two queries through the ported statements, and
//! compares the answers to `queries.json`.
//!
//! ## Ids are COMPARED here, not masked
//!
//! Nothing in this suite mints an id, so a ported query's answer carries the
//! same ids v0's did and **order is part of the comparison** — which is the
//! whole of the board: due first, then priority, then title, with the families
//! nested and the promotion rule applied.
//!
//! ## The three properties the corpus is built to falsify
//!
//! 1. **The promotion rule.** A completed "Tax return" with an unfinished
//!    "Find the receipts" under it: the child is a root of the open board and
//!    the parent is in the logbook keeping only its closed children. A port
//!    that nested the child under its closed parent loses it; a port that also
//!    listed it under the parent draws it twice.
//! 2. **Nulls last.** Two undated tasks and several dated ones, so "due first,
//!    then priority, then title" is a fact rather than a claim (lane V's
//!    nullable-sort finding).
//! 3. **The repeating task's zone.** "Water the plants" repeats daily at 09:00
//!    New York. Its `missed` count and `next_due` are an hour out if the reader
//!    spells the zone column wrong — which is exactly what v0 did until the
//!    R-1020-35 fix this lane landed (`board.ts` read `task.recurrence_tz`; the
//!    column is `tz`).

use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_tasks::queries::{
    Attachment, Reference, TaskRow, TaskTag, load_board, load_search,
};
use serde_json::{Map, Value, json};

/// The instant the generator stamped the whole run at.
const NOW: &str = "2099-06-01T09:00:00.000Z";

/// The keys v0's `search` rows carry that the ported fold does not produce.
///
/// `deleted_at`, `purge_at`, `row_version`, `owner_party_id` and
/// `remind_before_min` are columns the FTS join projects and the board's own
/// `TASK_COLUMNS` does not — a hit row is WIDER than a board row in v0, which
/// is a fact about the two reads and not about the app.
const SEARCH_ONLY_KEYS: [&str; 5] = [
    "deleted_at",
    "owner_party_id",
    "purge_at",
    "remind_before_min",
    "row_version",
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture(name: &str) -> Value {
    let path = root().join("contracts/apps/tasks").join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

fn fixture_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let rows = fs::read_to_string(root().join("contracts/apps/tasks/rows.json"))
        .expect("the committed rows are readable");
    open_contract_vault(&ddl, &rows).expect("the fixture vault is built")
}

fn cases(query: &str) -> Vec<Value> {
    fixture("queries.json")
        .as_array()
        .expect("the cases are a list")
        .iter()
        .filter(|case| case["query"] == json!(query))
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// The mapping onto v0's wire shape. ONE place.
// ---------------------------------------------------------------------------

fn text(value: Option<&String>) -> Value {
    value.map_or(Value::Null, |text| Value::String(text.clone()))
}

fn number(value: Option<i64>) -> Value {
    value.map_or(Value::Null, Into::into)
}

fn attachment_json(attachment: &Attachment) -> Value {
    json!({
        "attachment_id": attachment.attachment_id,
        "content_id": attachment.content_id,
        "role": text(attachment.role.as_ref()),
        "is_primary": number(attachment.is_primary),
        "media_type": attachment.media_type,
        "content_uri": attachment.content_uri,
        "byte_size": attachment.byte_size,
    })
}

fn tag_json(tag: &TaskTag) -> Value {
    json!({ "tag_id": tag.tag_id, "concept_id": tag.concept_id, "label": tag.label })
}

/// A reference, with v0's UNRESOLVABLE card shape where the port has no
/// resolver. See [`Reference::card`]'s note: the entity-card resolver is
/// `crates/vault`'s and is not in this build, so what the port answers is the
/// fallback v0 itself answers for a ref nothing resolved.
fn reference_json(reference: &Reference) -> Value {
    json!({
        "link_id": reference.link_id,
        "selector": reference.selector.clone().unwrap_or(Value::Null),
        "card": reference.card.clone().unwrap_or_else(|| json!({
            "type": reference.to_type,
            "id": reference.to_id,
            "status": "unknown",
            "title": Value::Null,
            "subtitle": Value::Null,
            "thumbnail_content_id": Value::Null,
        })),
    })
}

fn task_json(task: &TaskRow, board: bool, root_row: bool) -> Value {
    let mut out = Map::new();
    out.insert("task_id".to_owned(), Value::String(task.task_id.clone()));
    out.insert(
        "parent_task_id".to_owned(),
        text(task.parent_task_id.as_ref()),
    );
    out.insert("project_id".to_owned(), text(task.project_id.as_ref()));
    out.insert("section_id".to_owned(), text(task.section_id.as_ref()));
    out.insert("status".to_owned(), Value::String(task.status.clone()));
    out.insert("title".to_owned(), Value::String(task.title.clone()));
    out.insert("description".to_owned(), text(task.description.as_ref()));
    out.insert("priority".to_owned(), number(task.priority));
    out.insert("due_at".to_owned(), text(task.due_at.as_ref()));
    out.insert("completed_at".to_owned(), text(task.completed_at.as_ref()));
    out.insert("effort_min".to_owned(), number(task.effort_min));
    out.insert("rrule".to_owned(), text(task.rrule.as_ref()));
    out.insert("tz".to_owned(), text(task.tz.as_ref()));
    out.insert(
        "recurrence_anchor".to_owned(),
        text(task.recurrence_anchor.as_ref()),
    );
    out.insert("series_id".to_owned(), text(task.series_id.as_ref()));
    out.insert("sort_order".to_owned(), number(task.sort_order));
    out.insert("created_at".to_owned(), text(task.created_at.as_ref()));
    out.insert("updated_at".to_owned(), text(task.updated_at.as_ref()));
    out.insert(
        "attachments".to_owned(),
        Value::Array(task.attachments.iter().map(attachment_json).collect()),
    );
    if board {
        out.insert(
            "references".to_owned(),
            Value::Array(task.references.iter().map(reference_json).collect()),
        );
        out.insert(
            "tags".to_owned(),
            Value::Array(task.tags.iter().map(tag_json).collect()),
        );
    }
    // THE RECURRENCE FACTS ARE SPREAD ONLY ON A REPEATING TASK, exactly as v0
    // spreads `{}` for a one-off: an absent key and a null one are different
    // answers on a screen that draws a cadence.
    if let Some(summary) = &task.recurrence.recurrence_summary {
        out.insert(
            "recurrence_summary".to_owned(),
            Value::String(summary.clone()),
        );
    }
    if task.rrule.is_some() && task.due_at.is_some() {
        if let Some(missed) = task.recurrence.missed {
            out.insert("missed".to_owned(), missed.into());
        }
        out.insert(
            "next_due".to_owned(),
            task.recurrence
                .next_due
                .clone()
                .map_or(Value::Null, Value::String),
        );
    }
    if root_row {
        out.insert(
            "children".to_owned(),
            Value::Array(
                task.children
                    .iter()
                    .map(|child| task_json(child, board, false))
                    .collect(),
            ),
        );
        out.insert(
            "done_children".to_owned(),
            task.done_children.unwrap_or_default().into(),
        );
    }
    if let Some(snippet) = &task.snippet {
        out.insert("snippet".to_owned(), Value::String(snippet.clone()));
    }
    Value::Object(out)
}

fn without(value: &Value, keys: &[&str]) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    Value::Object(
        object
            .iter()
            .filter(|(key, _)| !keys.contains(&key.as_str()))
            .map(|(key, child)| (key.clone(), child.clone()))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// board.
// ---------------------------------------------------------------------------

#[test]
fn every_board_case_agrees_with_v0() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let cases = cases("board");
    assert_eq!(cases.len(), 6, "the fixture carries six board cases");
    let mut compared = 0_usize;
    for case in &cases {
        let label = format!("board {}", case["input"]);
        let limit = case["input"].get("limit").and_then(Value::as_i64);
        let (data, denial) =
            load_board(&door, limit, NOW).unwrap_or_else(|error| panic!("{label}: {error}"));
        assert!(denial.is_none(), "{label}: an unexpected denial");
        let want = &case["output"];
        assert_eq!(
            json!(data.window),
            want["window"],
            "{label}: the declared clamp"
        );
        assert_eq!(
            json!(data.truncated),
            want["truncated"],
            "{label}: `truncated` is the page's own cursor"
        );
        assert_eq!(
            json!({ "open": data.open_count, "closed": data.closed_count }),
            want["counts"],
            "{label}: counts describe what was FETCHED"
        );
        for (shelf, found) in [("open", &data.open), ("logbook", &data.logbook)] {
            let expected = want[shelf].as_array().expect("a shelf");
            assert_eq!(
                found.len(),
                expected.len(),
                "{label}: {shelf} (found {:?})",
                found.iter().map(|task| &task.title).collect::<Vec<_>>()
            );
            for (task, wanted) in found.iter().zip(expected) {
                assert_eq!(
                    task_json(task, true, true),
                    *wanted,
                    "{label}: {shelf} row {}",
                    task.title
                );
                compared += 1;
            }
        }
        let projects: Vec<Value> = data
            .projects
            .iter()
            .map(|project| {
                json!({
                    "project_id": project.project_id,
                    "name": text(project.name.as_ref()),
                    "area": text(project.area.as_ref()),
                    "color": text(project.color.as_ref()),
                    "sort_order": number(project.sort_order),
                })
            })
            .collect();
        assert_eq!(
            Value::Array(projects),
            want["projects"],
            "{label}: projects"
        );
        let sections: Vec<Value> = data
            .sections
            .iter()
            .map(|section| {
                json!({
                    "section_id": section.section_id,
                    "project_id": text(section.project_id.as_ref()),
                    "name": text(section.name.as_ref()),
                    "sort_order": number(section.sort_order),
                })
            })
            .collect();
        assert_eq!(
            Value::Array(sections),
            want["sections"],
            "{label}: sections"
        );
        let tags: Vec<Value> = data
            .tags
            .iter()
            .map(|chip| json!({ "concept_id": chip.concept_id, "label": chip.label }))
            .collect();
        assert_eq!(Value::Array(tags), want["tags"], "{label}: tag chips");
    }
    assert!(compared > 20, "{compared} task rows compared");
}

/// The three properties, named. They are inside the sweep above; this asserts
/// them so a fixture regenerated wrong is caught here rather than agreeing
/// with itself.
#[test]
fn the_board_promotes_releases_and_orders_the_way_the_doctrine_says() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let (data, _) = load_board(&door, None, NOW).expect("the board reads");
    let open: Vec<&str> = data.open.iter().map(|task| task.title.as_str()).collect();
    let logbook: Vec<&str> = data
        .logbook
        .iter()
        .map(|task| task.title.as_str())
        .collect();
    // 1. THE PROMOTION RULE.
    assert!(
        open.contains(&"Find the receipts"),
        "the unfinished child of a completed parent is a root: {open:?}"
    );
    assert!(logbook.contains(&"Tax return"), "{logbook:?}");
    let parent = data
        .logbook
        .iter()
        .find(|task| task.title == "Tax return")
        .expect("the logbook parent");
    assert!(
        parent
            .children
            .iter()
            .all(|child| child.status == "completed" || child.status == "cancelled"),
        "the logbook parent keeps only closed children, so no row is drawn twice"
    );
    // 2. NULLS LAST.
    let undated = open
        .iter()
        .position(|title| *title == "Learn to make sourdough")
        .expect("the undated task is on the board");
    let dated = open
        .iter()
        .position(|title| *title == "Plan the Tahoe trip")
        .expect("a dated task is on the board");
    assert!(dated < undated, "due first, then the undated: {open:?}");
    // 3. THE REPEATING TASK'S ZONE.
    let watering = data
        .open
        .iter()
        .find(|task| task.title == "Water the plants")
        .expect("the repeating task");
    assert_eq!(watering.tz.as_deref(), Some("America/New_York"));
    assert_eq!(
        watering.recurrence.recurrence_summary.as_deref(),
        Some("Daily")
    );
    assert_eq!(
        watering.recurrence.next_due.as_deref(),
        Some("2099-06-01T13:00:00.000Z"),
        "09:00 New York, not 09:00 UTC — the R-1020-35 fix"
    );
    // A ONE-OFF CARRIES NO CADENCE AT ALL, rather than a null one.
    let oneoff = data
        .open
        .iter()
        .find(|task| task.title == "Plan the Tahoe trip")
        .expect("a one-off");
    assert_eq!(oneoff.recurrence.recurrence_summary, None);
    assert_eq!(oneoff.recurrence.missed, None);
}

// ---------------------------------------------------------------------------
// search.
// ---------------------------------------------------------------------------

fn hits_of(case: &Value) -> Vec<Row> {
    case["output"]["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .map(|task| {
            let mut row = Row::new();
            for column in [
                "task_id",
                "parent_task_id",
                "project_id",
                "section_id",
                "status",
                "title",
                "description",
                "due_at",
                "completed_at",
                "rrule",
                "tz",
                "recurrence_anchor",
                "series_id",
                "created_at",
                "updated_at",
            ] {
                match task.get(column) {
                    Some(Value::String(value)) => {
                        row.insert(column.to_owned(), Cell::Text(value.clone()));
                    }
                    _ => {
                        row.insert(column.to_owned(), Cell::Null);
                    }
                }
            }
            for column in ["priority", "effort_min", "sort_order"] {
                match task.get(column).and_then(Value::as_i64) {
                    Some(value) => {
                        row.insert(column.to_owned(), Cell::Integer(value));
                    }
                    None => {
                        row.insert(column.to_owned(), Cell::Null);
                    }
                }
            }
            if let Some(snippet) = task.get("snippet").and_then(Value::as_str) {
                row.insert("_snippet".to_owned(), Cell::Text(snippet.to_owned()));
            }
            row
        })
        .collect()
}

#[test]
fn every_search_case_agrees_with_v0_on_the_fields_the_fold_produces() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let cases = cases("search");
    assert_eq!(cases.len(), 5);
    let mut compared = 0_usize;
    for case in &cases {
        let label = format!("search {}", case["input"]);
        let hits = hits_of(case);
        let (data, denial) =
            load_search(&door, &hits, NOW).unwrap_or_else(|error| panic!("{label}: {error}"));
        assert!(denial.is_none(), "{label}: an unexpected denial");
        let want = case["output"]["tasks"].as_array().expect("tasks");
        assert_eq!(data.tasks.len(), want.len(), "{label}: hit count");
        for (task, expected) in data.tasks.iter().zip(want) {
            let found = task_json(task, false, false);
            let extra: Vec<&str> = expected
                .as_object()
                .expect("an object")
                .keys()
                .map(String::as_str)
                .filter(|key| !found.as_object().expect("an object").contains_key(*key))
                .collect();
            assert_eq!(extra, SEARCH_ONLY_KEYS, "{label}: unmodelled keys moved");
            assert_eq!(
                found,
                without(expected, &SEARCH_ONLY_KEYS),
                "{label}: {}",
                task.title
            );
            compared += 1;
        }
    }
    assert!(compared > 0, "the search cases are not all empty");
}

// ---------------------------------------------------------------------------
// The script.
// ---------------------------------------------------------------------------

#[test]
fn the_script_carries_the_refusals_a_port_has_to_reproduce() {
    let commands = fixture("commands.json");
    let steps = commands.as_array().expect("the script is a list");
    assert_eq!(steps.len(), 26);
    let refused: Vec<&Value> = steps
        .iter()
        .filter(|step| step["status"] != json!("executed"))
        .collect();
    assert_eq!(refused.len(), 5, "five deliberate refusals");
    // ONT-31: `due_at: "banana"` is refused with the MODEL's sentence, not
    // "invalid date".
    let banana = refused
        .iter()
        .find(|step| step["input"]["due_at"] == json!("banana"))
        .expect("the unreadable due date is in the script");
    assert!(
        banana["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("not a time this vault can read"),
        "{}",
        banana["reason"]
    );
    // D-1020-S1: the cautionary rule is refused on a TASK, at the write
    // boundary, by the same parser the expander uses.
    let bysetpos = refused
        .iter()
        .find(|step| step["input"]["rrule"] == json!("FREQ=MONTHLY;BYSETPOS=-1"))
        .expect("the cautionary rule is in the script");
    assert!(
        bysetpos["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("BYSETPOS"),
        "{}",
        bysetpos["reason"]
    );
    // ONT-26: a section of another project is refused with the MODEL's
    // sentence, which every task writer meets.
    let filing = refused
        .iter()
        .find(|step| step["command"] == json!("schedule.organize_task"))
        .expect("the cross-project filing is in the script");
    assert!(
        filing["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("different project"),
        "{}",
        filing["reason"]
    );
}
