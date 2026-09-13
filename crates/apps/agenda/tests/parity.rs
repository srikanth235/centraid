//! PARITY WITH v0, CASE BY CASE (#1020, D-1020-D3-6).
//!
//! `contracts/apps/agenda/` is generated from the v0 tree by
//! `contracts/tools/export-agenda-parity.ts`: a fresh vault, the shared
//! `schedule.*` script through the REAL typed commands, then all four Agenda
//! queries through the REAL handler path with the same `ctx.time` a seat hands
//! a handler. This suite rebuilds that vault from `rows.json` — a database
//! created from `contracts/schema/vault-ddl.sql` — reads the same four queries
//! through the ported statements, and compares the answers to `queries.json`.
//!
//! ## Ids are COMPARED here, not masked
//!
//! Nothing in this suite mints an id: the rows come from the fixture with their
//! canonical `id-0007` tokens already in them, so a ported query's answer
//! carries the same ids v0's did and **page order is part of the comparison**.
//! A port that returned the right rows in the wrong order fails.
//!
//! ## What the DST case actually proves
//!
//! The corpus carries a daily 09:00 New York series across the March 2026
//! spring transition. In `queries.json` its occurrences are at `14:00Z` on the
//! 6th and 7th and `13:00Z` from the 8th, with `original_start_local` at
//! `09:00:00` throughout — the wall clock surviving an offset change, the skip
//! removing the 10th, the occurrence override moving the 11th, and the
//! future-scope override shifting every occurrence from the 13th. A port that
//! expanded in UTC, or keyed an exception on the resolved instant, fails on
//! that one case alone.
//!
//! ## The one query compared as a SUBSET, and why
//!
//! `search`'s hits come from `crates/search`'s FTS door, which this build does
//! not have, so the suite feeds the ported fold the same rows the index
//! answered — in the fixture's own rank order — and compares the fields the
//! fold produces. The four v0 keys it does not produce are asserted BY NAME
//! ([`SEARCH_ONLY_KEYS`]), so a fifth one appearing is a failure rather than a
//! silent gap.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_agenda::queries::{
    Attachment, Attendee, CalendarRow, EventRow, load_day_context, load_parties, load_search,
    load_upcoming,
};
use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::testdoor::TestDoor;
use serde_json::{Map, Value, json};

/// The instant the generator stamped the whole run at.
const NOW: &str = "2099-06-01T09:00:00.000Z";

/// The keys v0's `search` rows carry that the ported fold does not produce.
///
/// `_rank` is the FTS index's own score; `deleted_at`, `purge_at` and
/// `row_version` are columns the search join projects and `upcoming`'s own
/// projection (`EVENT_COLUMNS`) does not — so a hit row is WIDER than a window
/// row in v0, which is a fact about the two reads and not about the app.
const SEARCH_ONLY_KEYS: [&str; 4] = ["_rank", "deleted_at", "purge_at", "row_version"];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture(name: &str) -> Value {
    let path = root().join("contracts/apps/agenda").join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

/// The fixture vault, built from the committed DDL and `rows.json`.
fn fixture_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let rows = fs::read_to_string(root().join("contracts/apps/agenda/rows.json"))
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

fn input_str<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
    case["input"].get(key).and_then(Value::as_str)
}

// ---------------------------------------------------------------------------
// The mapping onto v0's wire shape. ONE place, so a field name that moved is
// one edit and a comparison that silently stopped comparing is impossible.
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

fn attendee_json(attendee: &Attendee) -> Value {
    let mut out = Map::new();
    // v0's `search` projection omits `attendee_id`; `upcoming`'s carries it.
    if let Some(id) = &attendee.attendee_id {
        out.insert("attendee_id".to_owned(), Value::String(id.clone()));
    }
    out.insert(
        "party_id".to_owned(),
        Value::String(attendee.party_id.clone()),
    );
    out.insert("name".to_owned(), Value::String(attendee.name.clone()));
    out.insert(
        "partstat".to_owned(),
        Value::String(attendee.partstat.clone()),
    );
    if let Some(role) = &attendee.role {
        out.insert("role".to_owned(), Value::String(role.clone()));
    }
    out.insert("is_you".to_owned(), Value::Bool(attendee.is_you));
    Value::Object(out)
}

fn event_json(event: &EventRow, upcoming: bool) -> Value {
    let mut out = Map::new();
    out.insert("event_id".to_owned(), Value::String(event.event_id.clone()));
    out.insert("ical_uid".to_owned(), text(event.ical_uid.as_ref()));
    out.insert("summary".to_owned(), text(event.summary.as_ref()));
    out.insert("description".to_owned(), text(event.description.as_ref()));
    out.insert("dtstart".to_owned(), Value::String(event.dtstart.clone()));
    out.insert("dtend".to_owned(), text(event.dtend.as_ref()));
    out.insert("start_tz".to_owned(), text(event.start_tz.as_ref()));
    out.insert("end_tz".to_owned(), text(event.end_tz.as_ref()));
    out.insert(
        "recurrence_semantics".to_owned(),
        text(event.recurrence_semantics.as_ref()),
    );
    out.insert("rrule".to_owned(), text(event.rrule.as_ref()));
    out.insert(
        "rrule_support".to_owned(),
        text(event.rrule_support.as_ref()),
    );
    out.insert("status".to_owned(), text(event.status.as_ref()));
    out.insert(
        "location_place_id".to_owned(),
        text(event.location_place_id.as_ref()),
    );
    out.insert(
        "organizer_party_id".to_owned(),
        text(event.organizer_party_id.as_ref()),
    );
    out.insert("sequence".to_owned(), number(event.sequence));
    out.insert("created_at".to_owned(), text(event.created_at.as_ref()));
    out.insert("updated_at".to_owned(), text(event.updated_at.as_ref()));
    out.insert("calendar_id".to_owned(), text(event.calendar_id.as_ref()));
    out.insert(
        "attachments".to_owned(),
        Value::Array(event.attachments.iter().map(attachment_json).collect()),
    );
    out.insert(
        "attendees".to_owned(),
        Value::Array(event.attendees.iter().map(attendee_json).collect()),
    );
    out.insert(
        "recurrence_summary".to_owned(),
        text(event.recurrence_summary.as_ref()),
    );
    if upcoming {
        out.insert(
            "conferencing_uri".to_owned(),
            text(event.conferencing_uri.as_ref()),
        );
        out.insert(
            "reminders_json".to_owned(),
            text(event.reminders_json.as_ref()),
        );
        out.insert(
            "is_recurrence_instance".to_owned(),
            Value::Bool(event.is_recurrence_instance),
        );
        out.insert(
            "instance_key".to_owned(),
            Value::String(event.instance_key.clone()),
        );
        // Only an EXPANDED row carries these two, which is how v0 spreads them.
        if let Some(key) = &event.original_start_local {
            out.insert(
                "original_start_local".to_owned(),
                Value::String(key.clone()),
            );
        }
        if let Some(overlap) = event.recurrence_overlap {
            out.insert("recurrence_overlap".to_owned(), Value::Bool(overlap));
        }
    } else if let Some(snippet) = &event.snippet {
        out.insert("snippet".to_owned(), Value::String(snippet.clone()));
    }
    Value::Object(out)
}

fn calendar_json(calendar: &CalendarRow) -> Value {
    json!({
        "calendar_id": calendar.calendar_id,
        "owner_party_id": text(calendar.owner_party_id.as_ref()),
        "name": text(calendar.name.as_ref()),
        "color": text(calendar.color.as_ref()),
        "default_tz": text(calendar.default_tz.as_ref()),
        "visibility": text(calendar.visibility.as_ref()),
    })
}

/// v0's object minus the keys the port does not model, so the comparison says
/// what it means.
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
// upcoming.
// ---------------------------------------------------------------------------

#[test]
fn every_upcoming_case_agrees_with_v0() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let cases = cases("upcoming");
    assert_eq!(cases.len(), 5, "the fixture carries five upcoming cases");
    let mut compared = 0_usize;
    for case in &cases {
        let label = format!("upcoming {}", case["input"]);
        let (data, denial) =
            load_upcoming(&door, input_str(case, "from"), input_str(case, "to"), NOW)
                .unwrap_or_else(|error| panic!("{label}: {error}"));
        assert!(denial.is_none(), "{label}: an unexpected denial");
        let want = &case["output"];
        let want_events = want["events"].as_array().expect("events");
        assert_eq!(
            data.events.len(),
            want_events.len(),
            "{label}: event count (found {:?})",
            data.events
                .iter()
                .map(|event| (event.summary.clone(), event.dtstart.clone()))
                .collect::<Vec<_>>()
        );
        for (index, (event, expected)) in data.events.iter().zip(want_events).enumerate() {
            assert_eq!(
                event_json(event, true),
                *expected,
                "{label}: event {index} ({})",
                event.instance_key
            );
            compared += 1;
        }
        let want_calendars = want["calendars"].as_array().expect("calendars");
        assert_eq!(
            data.calendars.len(),
            want_calendars.len(),
            "{label}: calendars"
        );
        for (calendar, expected) in data.calendars.iter().zip(want_calendars) {
            assert_eq!(calendar_json(calendar), *expected, "{label}: calendar");
        }
    }
    assert!(compared > 200, "{compared} event rows compared");
}

/// THE DST CASE, named. It is already inside the sweep above; this asserts the
/// PROPERTY so a fixture regenerated wrong is caught here rather than agreeing
/// with itself.
#[test]
fn the_dst_window_keeps_its_wall_clock_and_honours_its_exceptions() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let (data, _) = load_upcoming(
        &door,
        Some("2026-03-01T00:00:00.000Z"),
        Some("2026-03-20T00:00:00.000Z"),
        NOW,
    )
    .expect("the DST window reads");
    // The 09:00 New York series only: the corpus also carries a weekly
    // Europe/London run, and a test that swept both would be asserting
    // something about two zones at once.
    let standups: Vec<&EventRow> = data
        .events
        .iter()
        .filter(|event| {
            event
                .summary
                .as_deref()
                .is_some_and(|summary| summary.starts_with("Standup"))
        })
        .collect();
    assert!(standups.len() > 8, "the series expanded");
    // EVERY occurrence is at 09:00 local…
    for event in &standups {
        let key = event
            .original_start_local
            .as_deref()
            .unwrap_or_else(|| panic!("an occurrence with no key: {}", event.instance_key));
        assert!(key.ends_with("T09:00:00"), "{key} is not 09:00 local");
    }
    // …and the instants straddle the transition.
    let instants: std::collections::BTreeSet<&str> = standups
        .iter()
        .filter(|event| event.summary.as_deref() == Some("Standup"))
        .map(|event| &event.dtstart[11..16])
        .collect();
    assert!(
        instants.len() > 1,
        "the wall clock survived an offset change: {instants:?}"
    );
    // The SKIP removed its occurrence…
    assert!(
        !standups
            .iter()
            .any(|event| event.original_start_local.as_deref() == Some("2026-03-10T09:00:00")),
        "the skip matched"
    );
    // …and the OVERRIDE moved one without moving its key.
    let moved = standups
        .iter()
        .find(|event| event.original_start_local.as_deref() == Some("2026-03-11T09:00:00"))
        .expect("the overridden occurrence is still drawn");
    assert_eq!(moved.summary.as_deref(), Some("Standup (late)"));
    assert_eq!(moved.dtstart, "2026-03-11T18:00:00.000Z");
}

// ---------------------------------------------------------------------------
// search.
// ---------------------------------------------------------------------------

/// The hits the index answered, rebuilt as rows in the fixture's own RANK
/// ORDER. The FTS read itself is `crates/search`'s; the fold is the app's.
fn hits_of(case: &Value) -> Vec<Row> {
    case["output"]["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|event| {
            let mut row = Row::new();
            for column in [
                "event_id",
                "ical_uid",
                "summary",
                "description",
                "dtstart",
                "dtend",
                "start_tz",
                "end_tz",
                "recurrence_semantics",
                "rrule",
                "rrule_support",
                "status",
                "location_place_id",
                "organizer_party_id",
                "created_at",
                "updated_at",
            ] {
                match event.get(column) {
                    Some(Value::String(value)) => {
                        row.insert(column.to_owned(), Cell::Text(value.clone()));
                    }
                    _ => {
                        row.insert(column.to_owned(), Cell::Null);
                    }
                }
            }
            if let Some(sequence) = event.get("sequence").and_then(Value::as_i64) {
                row.insert("sequence".to_owned(), Cell::Integer(sequence));
            }
            if let Some(snippet) = event.get("snippet").and_then(Value::as_str) {
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
            load_search(&door, &hits).unwrap_or_else(|error| panic!("{label}: {error}"));
        assert!(denial.is_none(), "{label}: an unexpected denial");
        let want = case["output"]["events"].as_array().expect("events");
        assert_eq!(data.events.len(), want.len(), "{label}: hit count");
        for (event, expected) in data.events.iter().zip(want) {
            // THE FOUR UNMODELLED KEYS ARE ASSERTED BY NAME: a fifth appearing
            // is a failure, not a silent gap.
            let extra: Vec<&str> = expected
                .as_object()
                .expect("an object")
                .keys()
                .map(String::as_str)
                .filter(|key| {
                    !event_json(event, false)
                        .as_object()
                        .expect("an object")
                        .contains_key(*key)
                })
                .collect();
            assert_eq!(extra, SEARCH_ONLY_KEYS, "{label}: unmodelled keys moved");
            assert_eq!(
                event_json(event, false),
                without(expected, &SEARCH_ONLY_KEYS),
                "{label}: {}",
                event.event_id
            );
            compared += 1;
        }
    }
    assert!(compared > 0, "the search cases are not all empty");
}

// ---------------------------------------------------------------------------
// day-context and parties.
// ---------------------------------------------------------------------------

#[test]
fn every_day_context_case_agrees_with_v0() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let cases = cases("day-context");
    assert_eq!(cases.len(), 5);
    for case in &cases {
        let label = format!("day-context {}", case["input"]);
        let (data, denial) =
            load_day_context(&door, input_str(case, "from"), input_str(case, "to"), NOW)
                .unwrap_or_else(|error| panic!("{label}: {error}"));
        assert!(denial.is_none(), "{label}: an unexpected denial");
        let found = json!({
            "birthdays": data.birthdays.iter().map(|birthday| json!({
                "party_id": birthday.party_id,
                "name": birthday.name,
                "month": birthday.month,
                "day": birthday.day,
                "tier": birthday.tier,
            })).collect::<Vec<Value>>(),
            "due": data.due.iter().map(|due| json!({
                "day": due.day,
                "count": due.count,
                "tasks": due.tasks.iter().map(|task| json!({
                    "task_id": task.task_id,
                    "title": task.title,
                })).collect::<Vec<Value>>(),
            })).collect::<Vec<Value>>(),
            "holidays": data.holidays,
        });
        assert_eq!(found, case["output"], "{label}");
    }
}

#[test]
fn the_parties_case_agrees_with_v0() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let cases = cases("parties");
    assert_eq!(cases.len(), 1);
    let (data, denial) = load_parties(&door).expect("the directory reads");
    assert!(denial.is_none());
    let found = json!({
        "me": text(data.me.as_ref()),
        "parties": data.parties.iter().map(|party| json!({
            "party_id": party.party_id,
            "name": party.name,
            "is_you": party.is_you,
        })).collect::<Vec<Value>>(),
    });
    assert_eq!(found, cases[0]["output"]);
}

// ---------------------------------------------------------------------------
// The script.
// ---------------------------------------------------------------------------

/// The corpus is a SCRIPT, and a refusal is an answer.
///
/// This does not replay the script — the commands are `crates/vault`'s and are
/// replayed in `crates/vault/tests/schedule_commands.rs` — it asserts that the
/// fixture carries the refusals a port has to reproduce, so a regenerated
/// corpus of only happy paths fails here rather than passing quietly.
#[test]
fn the_script_carries_the_refusals_a_port_has_to_reproduce() {
    let commands = fixture("commands.json");
    let steps = commands.as_array().expect("the script is a list");
    assert!(steps.len() > 30, "{} steps", steps.len());
    let refused: Vec<&str> = steps
        .iter()
        .filter(|step| step["status"] != json!("executed"))
        .map(|step| step["command"].as_str().unwrap_or_default())
        .collect();
    assert!(
        refused.contains(&"schedule.propose_event")
            && refused.contains(&"schedule.add_task")
            && refused.contains(&"schedule.edit_event_occurrence")
            && refused.contains(&"schedule.organize_task"),
        "the refusals are the cases a port gets wrong: {refused:?}"
    );
}

/// THE ONE DELIBERATE DIVERGENCE AT THE WRITE BOUNDARY, held as a test rather
/// than a paragraph (#1020, D-1020-S1; R-1020-35 finding).
///
/// **v0 STORES `FREQ=MONTHLY;BYSETPOS=-1` on an event and refuses it on a
/// task.** `schedule.propose_event`'s `rrule_looks_valid` precondition is a
/// SQL `LIKE 'FREQ=%'` — a prefix check — while `schedule.add_task` goes
/// through `operations/task-write.ts`'s `task_rrule_is_supported`, which runs
/// the real parser. So the same model question is answered two ways by the same
/// schema, and the event side answers it the way `rrule-support.ts`'s own
/// header says caused the bug: *"`FREQ=MONTHLY;BYSETPOS=-1` parsed as a plain
/// monthly rule and a 'last Friday of the month' reminder fired on the wrong
/// date forever."*
///
/// `core_event.rrule_support` exists to carry the other answer — store it and
/// mark it — and **nothing in the tree ever writes `'unsupported'`**, so the
/// column is a dead flag rather than the design it looks like. Which of the two
/// the product wants is an owner question, so this lane refuses at the write
/// boundary (the brief's ruling, and what Tasks already does) and records v0's
/// answer here as a DIFFERENCE. Agreeing with it would be the bug.
#[test]
fn v0_stores_an_unsupported_rule_on_an_event_and_this_port_refuses_it() {
    let commands = fixture("commands.json");
    let steps = commands.as_array().expect("the script is a list");
    let event = steps
        .iter()
        .find(|step| {
            step["input"]["rrule"] == json!("FREQ=MONTHLY;BYSETPOS=-1")
                && step["command"] == json!("schedule.propose_event")
        })
        .expect("the cautionary rule is in the event script");
    assert_eq!(
        event["status"],
        json!("executed"),
        "v0 stores it — this is the difference, not a stale fixture"
    );
    let task = steps
        .iter()
        .find(|step| {
            step["input"]["rrule"] == json!("FREQ=MONTHLY;BYSETPOS=-1")
                && step["command"] == json!("schedule.add_task")
        })
        .expect("the cautionary rule is in the task script");
    assert_eq!(
        task["status"],
        json!("failed"),
        "and v0 refuses the very same rule on a task"
    );
    // The ROW v0 wrote carries `rrule_support = 'supported'`: the column that
    // exists to say otherwise is never written.
    let rows = fixture("rows.json");
    let events = rows
        .as_array()
        .expect("tables")
        .iter()
        .find(|table| table["table"] == json!("core_event"))
        .expect("core_event is in the rows");
    let columns: Vec<&str> = events["columns"]
        .as_array()
        .expect("columns")
        .iter()
        .map(|column| column.as_str().unwrap_or_default())
        .collect();
    let support = columns
        .iter()
        .position(|column| *column == "rrule_support")
        .expect("the column is in the projection");
    let marked = events["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .filter(|row| row[support] == json!("unsupported"))
        .count();
    assert_eq!(marked, 0, "`rrule_support` is a dead flag in v0");
}
