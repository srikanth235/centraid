//! PARITY WITH v0, CASE BY CASE (#1020, D-1020-D3-6).
//!
//! `contracts/apps/people/` is generated from the v0 tree by
//! `contracts/tools/export-people-parity.ts`: a fresh vault, the app's own demo
//! seed and a scripted set of all twenty-eight `people.*` commands, all four
//! `social.*` ones and `core.merge_party`, then all seven People queries through
//! the REAL handler path. This suite rebuilds that vault from `rows.json` — a
//! database created from `contracts/schema/vault-ddl.sql`, the committed schema
//! of the #929 golden corpus — reads the same seven queries through the ported
//! statements, and compares the answers to `queries.json`.
//!
//! ## Ids are COMPARED here, not masked
//!
//! Nothing in this suite mints an id: the rows come from the fixture with their
//! canonical `id-0007` tokens already in them, so a ported query's answer
//! carries the same ids v0's did.
//!
//! ## D-1020-PE10 — which lists are compared IN ORDER, and which as sets
//!
//! **A list whose statement orders by a MINTED ID is compared as a set.** The
//! canonicaliser assigns `id-NNNN` in first-appearance order across the whole
//! bundle, and a date whose id first appears inside a revision's
//! `snapshot_json` gets a lower token than one that first appears in its own
//! table — so in the rebuilt vault `ORDER BY date_id` is a different order from
//! the one v0 read. That order is a fact about the canonicaliser, not about the
//! vault, and comparing it would be comparing the fixture to itself.
//!
//! Compared as a SET, each named here: the roster row's `reminders`, and the
//! person sheet's `dates`, `contact`, `tasks`, `gifts` and `relationships`.
//!
//! A set is sorted by [`canonical_text`], not by `Value::to_string` — finding
//! PE-F8: `serde_json`'s `preserve_order` feature is turned on four crates away
//! by `agent-client-protocol`, cargo unifies features across a build, and
//! `to_string` therefore prints an object's keys in insertion order under
//! `cargo test --workspace` and in name order under `cargo test -p
//! centraid-apps-people`. A sort key that changes with the rest of the build is
//! a test that passes in one command and fails in the other.
//!
//! Compared IN ORDER, which is every other list in the payload: the roster's
//! `people` (by `created_at DESC`), the dashboard's `upcoming` (by days-until,
//! in the vault's zone), `recent` (by `started_at DESC`) and `reconnect` (by
//! days-over), the journal's `entries` (by instant), `search`'s `people` (FTS
//! RANK, which the fixture preserves because the hits arrive ranked), `trash`'s
//! shelf (by `deleted_at DESC`), `history`'s rail (by `recorded_at DESC`) and
//! the person sheet's `notes`, `interactions` and `vaults`.
//!
//! ## The three stated divergences
//!
//! 1. **`window` is the roster's declared 10,000 here and 9,999 in v0**
//!    (D-1020-PE4): v0 clamps for a look-ahead row it no longer takes. The
//!    mapping lowers the port's answer onto v0's so the comparison is exact,
//!    and the finding is in the receipt rather than in a changed fixture.
//! 2. **`vault_count` is inside the reading here and beside a `null` `linked`
//!    in v0** (D-1020-PE1). The mapping emits v0's shape;
//!    `crates/apps/people/tests/three_state.rs` is what proves the two are
//!    still distinguishable on this side.
//! 3. **`truncated` is the walked window's answer here and one page's cursor in
//!    v0** (finding PE-F3). On this corpus — three live people against a window
//!    of at least twenty — both are `false`, so the comparison is exact and the
//!    divergence is named rather than hidden.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_people::dashboard::{DashboardData, load_dashboard};
use centraid_apps_people::dates::CivilDate;
use centraid_apps_people::journal::{JournalData, JournalEntry, load_journal};
use centraid_apps_people::person::{Person, PersonData, load_history, load_person};
use centraid_apps_people::queries::{ROSTER_MAX, V0_ROSTER_MAX};
use centraid_apps_people::roster::{
    PeopleData, PeopleInput, RosterRow, SearchData, SearchHit, TrashData, load_people, load_search,
    load_trash,
};
use centraid_apps_people::{Denial, ReadState};
use serde_json::{Value, json};

/// The instant the generator stamped the whole run at, and the civil date the
/// vault's zone reads it as. The generator refuses to run outside UTC, so the
/// two agree by construction (`people-parity-bundle.ts`).
const PARITY_EPOCH: &str = "2099-06-01T09:00:00.000Z";
const PARITY_TODAY: CivilDate = CivilDate::new(2099, 6, 1);

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture(name: &str) -> Value {
    let path = root().join("contracts/apps/people").join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

/// The fixture vault, built from the committed DDL and `rows.json`.
fn fixture_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let rows = fs::read_to_string(root().join("contracts/apps/people/rows.json"))
        .expect("the committed rows are readable");
    open_contract_vault(&ddl, &rows).expect("the fixture vault is built")
}

/// Every case the fixture recorded for one query, in the order it recorded them.
fn cases(query: &str) -> Vec<(Value, Value)> {
    fixture("queries.json")
        .as_array()
        .expect("queries.json is an array")
        .iter()
        .filter(|case| case["query"] == json!(query))
        .map(|case| (case["input"].clone(), case["output"].clone()))
        .collect()
}

// ---------------------------------------------------------------------------
// The mapping onto v0's wire shape. One place, so a field name that moved is
// one edit and a comparison that silently stopped comparing is impossible.
// ---------------------------------------------------------------------------

/// A list compared as a SET: sorted by its own JSON text, on both sides.
fn as_set(value: &Value) -> Value {
    let Some(items) = value.as_array() else {
        return value.clone();
    };
    let mut sorted: Vec<Value> = items.clone();
    sorted.sort_by_key(canonical_text);
    Value::Array(sorted)
}

/// A value's text with **every object's keys in name order**, at every depth.
///
/// FINDING PE-F8, AS CODE. `serde_json::Value::to_string` is not a canonical
/// form: with the `preserve_order` feature a `Map` is an `IndexMap` and prints
/// in insertion order, and without it a `BTreeMap` printing in key order. The
/// feature is not this crate's to choose — `agent-client-protocol`, four
/// crates away through `centraid-assist`, turns it on, and cargo unifies
/// features across a build — so `cargo test -p centraid-apps-people` and
/// `cargo test --workspace` hand the same code two different `to_string`s.
/// Sorting a set by that text therefore agreed with the fixture in one command
/// and disagreed in the other, which is a test whose answer depends on which
/// other crates were in the build.
///
/// The fixture's own side is written by `stableJson`, which sorts keys. This is
/// the same normal form on this side, so the sort key is a fact about the
/// VALUE and the feature cannot reach it.
fn canonical_text(value: &Value) -> String {
    let mut text = String::new();
    write_canonical(value, &mut text);
    text
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let ordered: BTreeMap<&String, &Value> = map.iter().collect();
            out.push('{');
            for (index, (key, item)) in ordered.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(item, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

fn roster_row_json(
    row: &RosterRow,
    links: &ReadState<centraid_apps_people::roster::VaultLinks>,
) -> Value {
    let mut value = json!({
        "party_id": row.party_id,
        "name": row.name,
        "role": row.role,
        "avatar_color": row.avatar_color,
        "cadence_days": row.cadence_days,
        "last_contacted_at": row.last_contacted_at,
        "created_at": row.created_at,
        "list_id": row.list_id,
        "starred": row.starred,
        "reminders": as_set(&json!(
            row.reminders
                .iter()
                .map(|reminder| json!({
                    "date_id": reminder.date_id,
                    "label": reminder.label,
                    "month_day": reminder.month_day,
                }))
                .collect::<Vec<Value>>()
        )),
    });
    // v0's `linked` is `null` when the plane is denied and `vault_count` is `0`
    // beside it; here both live inside the reading.
    match links.ready() {
        Some(links) => {
            value["linked"] = json!(links.linked(&row.party_id));
            value["vault_count"] = json!(links.vault_count(&row.party_id));
        }
        None => {
            value["linked"] = Value::Null;
            value["vault_count"] = json!(0);
        }
    }
    value
}

fn people_json(data: &PeopleData) -> Value {
    json!({
        "people": data
            .people
            .iter()
            .map(|row| roster_row_json(row, &data.links))
            .collect::<Vec<Value>>(),
        "lists": data
            .lists
            .iter()
            .map(|list| json!({ "list_id": list.list_id, "name": list.name }))
            .collect::<Vec<Value>>(),
        "truncated": data.truncated,
        // D-1020-PE4: v0 clamps the declared 10,000 to 9,999.
        "window": if data.window == ROSTER_MAX { V0_ROSTER_MAX } else { data.window },
        "links_available": data.links.known(),
    })
}

fn search_json(data: &SearchData) -> Value {
    json!({
        "people": data
            .people
            .iter()
            .map(|row| {
                let mut value = json!({
                    "party_id": row.party_id,
                    "name": row.name,
                    "role": row.role,
                    "avatar_color": row.avatar_color,
                    "cadence_days": row.cadence_days,
                    "last_contacted_at": row.last_contacted_at,
                    "created_at": row.created_at,
                    "list_id": row.list_id,
                    "starred": row.starred,
                    "reminders": json!([]),
                    "snippet": row.snippet.clone().unwrap_or_default(),
                });
                value["reminders"] = json!([]);
                value
            })
            .collect::<Vec<Value>>(),
    })
}

fn trash_json(data: &TrashData) -> Value {
    json!({
        "people": data
            .people
            .iter()
            .map(|row| json!({
                "party_id": row.party_id,
                "name": row.name,
                "role": row.role,
                "purge_at": row.purge_at,
            }))
            .collect::<Vec<Value>>(),
    })
}

fn card_json(card: &centraid_apps_people::queries::PersonCard) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("party_id".to_owned(), json!(card.party_id));
    map.insert("name".to_owned(), json!(card.name));
    map.insert("avatar_color".to_owned(), json!(card.avatar_color));
    map.insert("role".to_owned(), json!(card.role));
    map
}

fn dashboard_json(data: &DashboardData) -> Value {
    let mut counts = json!({
        "all": data.counts.all,
        "reconnect": data.counts.reconnect,
        "upcoming": data.counts.upcoming,
        "starred": data.counts.starred,
    });
    match data.links.ready() {
        Some(links) => {
            counts["linked"] = json!(links.linked);
            counts["to_link"] = json!(links.to_link);
        }
        None => {
            counts["linked"] = Value::Null;
            counts["to_link"] = Value::Null;
        }
    }
    json!({
        "reconnect": data.reconnect.iter().map(|card| Value::Object(card_json(card))).collect::<Vec<Value>>(),
        "upcoming": data
            .upcoming
            .iter()
            .map(|row| {
                let mut map = card_json(&row.card);
                map.insert("date_id".to_owned(), json!(row.date_id));
                map.insert("label".to_owned(), json!(row.label));
                map.insert("month_day".to_owned(), json!(row.month_day));
                Value::Object(map)
            })
            .collect::<Vec<Value>>(),
        "recent": data
            .recent
            .iter()
            .map(|row| {
                let mut map = card_json(&row.card);
                map.insert("interaction_id".to_owned(), json!(row.interaction_id));
                map.insert("kind".to_owned(), json!(row.kind));
                map.insert("text".to_owned(), json!(row.text));
                map.insert("occurred_at".to_owned(), json!(row.occurred_at));
                Value::Object(map)
            })
            .collect::<Vec<Value>>(),
        "counts": counts,
    })
}

fn journal_json(data: &JournalData) -> Value {
    json!({
        "entries": data
            .entries
            .iter()
            .map(|entry| match entry {
                JournalEntry::Owner { id, sort_at, date, mood, text } => json!({
                    "kind": "entry",
                    "id": id,
                    "sort_at": sort_at,
                    "date": date,
                    "mood": mood,
                    "text": text,
                }),
                JournalEntry::Auto {
                    id, sort_at, date, touch, text, party_id, name, avatar_color,
                } => json!({
                    "kind": "auto",
                    "id": id,
                    "sort_at": sort_at,
                    "date": date,
                    "touch": touch,
                    "text": text,
                    "party_id": party_id,
                    "name": name,
                    "avatar_color": avatar_color,
                }),
            })
            .collect::<Vec<Value>>(),
    })
}

fn person_json(data: &PersonData) -> Value {
    let Some(person) = data.person.as_ref() else {
        return json!({ "person": Value::Null });
    };
    json!({ "person": person_body(person) })
}

fn person_body(person: &Person) -> Value {
    let profile = &person.profile;
    let mut value = json!({
        "party_id": profile.party_id,
        "name": profile.name,
        "role": profile.role,
        "nickname": profile.nickname,
        "avatar_color": profile.avatar_color,
        "cadence_days": profile.cadence_days,
        "last_contacted_at": profile.last_contacted_at,
        "created_at": profile.created_at,
        "met": profile.met,
        "list_id": profile.list_id,
        "starred": profile.starred,
        "contact": as_set(&json!(
            profile
                .contact
                .iter()
                .map(|entry| json!({
                    "channel_id": entry.channel_id,
                    "kind": entry.kind,
                    "label": entry.label,
                    "value": entry.value,
                    "normalized_value": entry.normalized_value,
                    "preferred": entry.preferred,
                    "provenance": entry.provenance,
                    "duplicate_party_ids": entry.duplicate_party_ids,
                    "duplicate_names": entry.duplicate_names,
                }))
                .collect::<Vec<Value>>()
        )),
        "dates": as_set(&json!(
            profile
                .dates
                .iter()
                .map(|date| json!({
                    "date_id": date.date_id,
                    "label": date.label,
                    "month_day": date.month_day,
                    "reminder_on": date.reminder_on,
                }))
                .collect::<Vec<Value>>()
        )),
        "notes": profile
            .notes
            .iter()
            .map(|note| json!({
                "annotation_id": note.annotation_id,
                "text": note.text,
                "created_at": note.created_at,
            }))
            .collect::<Vec<Value>>(),
    });
    // THE THREE READINGS, lowered onto v0's flat shape.
    let links = person.links.ready();
    value["relationships"] = as_set(&json!(links.map_or_else(Vec::new, |links| {
        links
            .relationships
            .iter()
            .map(|relation| {
                json!({
                    "relationship_id": relation.relationship_id,
                    "related_party_id": relation.related_party_id,
                    "name": relation.name,
                    "kind": relation.kind,
                    "pet": relation.pet,
                })
            })
            .collect::<Vec<Value>>()
    })));
    value["tasks"] = as_set(&json!(links.map_or_else(Vec::new, |links| {
        links
            .tasks
            .iter()
            .map(|task| {
                json!({
                    "task_id": task.task_id,
                    "text": task.text,
                    "done": task.done,
                })
            })
            .collect::<Vec<Value>>()
    })));
    value["gifts"] = as_set(&json!(links.map_or_else(Vec::new, |links| {
        links
            .gifts
            .iter()
            .map(|gift| {
                json!({
                    "gift_id": gift.gift_id,
                    "text": gift.text,
                    "state": gift.state,
                })
            })
            .collect::<Vec<Value>>()
    })));
    value["interactions"] = json!(links.map_or_else(Vec::new, |links| {
        links
            .interactions
            .iter()
            .map(|interaction| {
                json!({
                    "interaction_id": interaction.interaction_id,
                    "kind": interaction.kind,
                    "text": interaction.text,
                    "occurred_at": interaction.occurred_at,
                })
            })
            .collect::<Vec<Value>>()
    }));
    value["debts"] = json!(
        person
            .obligations
            .ready()
            .map_or_else(Vec::new, |obligations| obligations
                .debts
                .iter()
                .map(|debt| json!({
                    "debt_id": debt.debt_id,
                    "direction": debt.direction.as_str(),
                    "amount_minor": debt.amount.amount_minor,
                    "currency": debt.amount.currency.code(),
                    "reason": debt.reason,
                }))
                .collect::<Vec<Value>>())
    );
    value["vaults"] = match person.sharing.ready() {
        Some(sharing) => json!(
            sharing
                .vaults
                .iter()
                .map(|binding| json!({
                    "binding_id": binding.binding_id,
                    "vault_id": binding.vault_id,
                    "linked_at": binding.linked_at,
                }))
                .collect::<Vec<Value>>()
        ),
        None => Value::Null,
    };
    value
}

/// v0 answers `{…, vaultDenied}` on a denial and omits the key otherwise. Every
/// case in this corpus runs under the owner's own credential, so the port's
/// denial must be absent everywhere — asserted rather than assumed.
fn no_denial(query: &str, denial: Option<Denial>) {
    assert!(
        denial.is_none(),
        "`{query}` was denied over a fixture the owner wrote: {denial:?}"
    );
}

/// The lists compared as a SET rather than in order (D-1020-PE10), by the key
/// they are carried under. Named once, so the two sides cannot drift apart.
const SET_COMPARED: &[&str] = &[
    "reminders",
    "dates",
    "contact",
    "tasks",
    "gifts",
    "relationships",
];

/// Sort every set-compared list in a value, wherever it appears.
fn sort_sets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if SET_COMPARED.contains(&key.as_str()) {
                    *child = as_set(child);
                } else {
                    sort_sets(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                sort_sets(item);
            }
        }
        _ => {}
    }
}

/// v0's own expectation, with the keys the port does not model stripped and the
/// set-compared lists put in one order.
///
/// `vaultDenied` is absent in every case here (asserted above), and v0's
/// pending-overlay stamps (`__centraid_pending_key`) never appear on a fixture
/// written through the gateway rather than through a seat's outbox.
fn expected(output: &Value) -> Value {
    let mut value = output.clone();
    if let Some(map) = value.as_object_mut() {
        map.remove("vaultDenied");
    }
    sort_sets(&mut value);
    value
}

// ---------------------------------------------------------------------------
// The suites.
// ---------------------------------------------------------------------------

#[test]
fn the_roster_answers_what_v0_answered_at_every_declared_window() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let recorded = cases("people");
    assert_eq!(recorded.len(), 6, "the fixture records six roster windows");
    for (input, output) in recorded {
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|limit| usize::try_from(limit).ok());
        let (data, denial) = load_people(&door, PeopleInput { limit }).expect("the roster reads");
        no_denial("people", denial);
        assert_eq!(
            people_json(&data),
            expected(&output),
            "the roster diverged at {input}"
        );
    }
}

#[test]
fn the_person_sheet_answers_what_v0_answered_for_every_party() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let recorded = cases("person");
    assert_eq!(recorded.len(), 7);
    let mut found = 0;
    for (input, output) in recorded {
        let party_id = input.get("party_id").and_then(Value::as_str).unwrap_or("");
        let (data, denial) = load_person(&door, party_id).expect("the sheet reads");
        no_denial("person", denial);
        if data.person.is_some() {
            found += 1;
        }
        assert_eq!(
            person_json(&data),
            expected(&output),
            "the person sheet diverged at {input}"
        );
    }
    // THE ABSENT CASES ARE CASES. A suite that only ever saw live people could
    // not tell `{person: null}` from a denial.
    assert!(found >= 3, "only {found} of the cases found a person");
}

#[test]
fn the_dashboard_answers_what_v0_answered_in_the_vaults_own_zone() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let now_ms = centraid_apps_people::dates::parse_instant(PARITY_EPOCH).expect("an instant");
    let recorded = cases("dashboard");
    assert_eq!(recorded.len(), 1);
    for (input, output) in recorded {
        let (data, denial) =
            load_dashboard(&door, PARITY_TODAY, now_ms).expect("the dashboard reads");
        no_denial("dashboard", denial);
        assert_eq!(
            dashboard_json(&data),
            expected(&output),
            "the dashboard diverged at {input}"
        );
    }
}

#[test]
fn the_journal_the_trash_and_the_history_rail_answer_what_v0_answered() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);

    for (input, output) in cases("journal") {
        let (data, denial) = load_journal(&door).expect("the journal reads");
        no_denial("journal", denial);
        assert_eq!(
            journal_json(&data),
            expected(&output),
            "the journal diverged at {input}"
        );
    }

    for (input, output) in cases("trash") {
        let (data, denial) = load_trash(&door).expect("the shelf reads");
        no_denial("trash", denial);
        assert_eq!(
            trash_json(&data),
            expected(&output),
            "the trash shelf diverged at {input}"
        );
    }

    let history = cases("history");
    assert_eq!(history.len(), 6);
    let mut with_revisions = 0;
    for (input, output) in history {
        let party_id = input.get("party_id").and_then(Value::as_str).unwrap_or("");
        let (data, denial) = load_history(&door, party_id).expect("the rail reads");
        no_denial("history", denial);
        if !data.revisions.is_empty() {
            with_revisions += 1;
        }
        assert_eq!(
            json!({
                "revisions": data
                    .revisions
                    .iter()
                    .map(|revision| json!({
                        "revision_id": revision.revision_id,
                        "operation": revision.operation,
                        "snapshot": revision.snapshot,
                        "recorded_at": revision.recorded_at,
                        "undo_until": revision.undo_until,
                        "undone_at": revision.undone_at,
                    }))
                    .collect::<Vec<Value>>(),
            }),
            expected(&output),
            "the history rail diverged at {input}"
        );
    }
    assert!(
        with_revisions >= 2,
        "no case carried a revision: the rail proves nothing"
    );
}

/// `search`'s hits come from `crates/search` rather than from a statement, so
/// the fixture's own ranked answer is replayed and the FOLD is what this
/// compares — which is the half the port owns.
#[test]
fn the_search_fold_answers_what_v0_answered_over_the_same_ranked_hits() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let recorded = cases("search");
    assert_eq!(recorded.len(), 5);
    let mut matched = 0;
    for (input, output) in recorded {
        // The hits, as v0's three indexes ranked them: the fixture's own answer
        // read back, so the fold is compared and the index is not re-run.
        let hits: Vec<SearchHit> = output["people"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        Some(SearchHit {
                            party_id: row["party_id"].as_str()?.to_owned(),
                            snippet: row["snippet"].as_str().map(str::to_owned),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !hits.is_empty() {
            matched += 1;
        }
        let (data, denial) = load_search(&door, &hits).expect("the fold runs");
        no_denial("search", denial);
        assert_eq!(
            search_json(&data),
            expected(&output),
            "the search fold diverged at {input}"
        );
    }
    assert!(matched >= 2, "only {matched} search cases matched anybody");
}

/// THE COMMAND SCRIPT IS COMPARED BY SHAPE HERE, and by REPLAY in
/// `crates/vault/tests/people_commands.rs`. This half asserts what the fixture
/// contains, so a regenerated corpus that quietly stopped covering a command
/// fails on the app side too.
#[test]
fn the_script_names_every_command_of_both_schemas_and_the_merge() {
    let commands = fixture("commands.json");
    let steps = commands.as_array().expect("commands.json is an array");
    let mut names: Vec<&str> = steps
        .iter()
        .filter_map(|step| step["command"].as_str())
        .collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(
        names
            .iter()
            .filter(|name| name.starts_with("people."))
            .count(),
        28
    );
    assert_eq!(
        names
            .iter()
            .filter(|name| name.starts_with("social."))
            .count(),
        4
    );
    assert!(names.contains(&"core.merge_party"));
    assert_eq!(names.len(), 33);

    // EVERY ACTION THE MANIFEST DECLARES HAS ITS COMMAND IN THE SCRIPT.
    let invoked: BTreeMap<&str, usize> = names.iter().map(|name| (*name, 0usize)).collect();
    for row in centraid_apps_people::ACTIONS {
        assert!(
            invoked.contains_key(row.command),
            "{} invokes {}, which the parity script never runs",
            row.action,
            row.command
        );
    }

    // AND THE REFUSALS ARE IN IT. A script of only happy paths cannot tell a
    // port that reproduces the gates from one that has none.
    let refusals = steps
        .iter()
        .filter(|step| step["status"] != json!("executed"))
        .count();
    assert!(refusals >= 12, "only {refusals} steps are refusals");
}

/// FINDING PE-F8, GUARDED. The set comparison's sort key must not change when
/// an object's keys arrive in a different order, because whether they do is a
/// fact about `serde_json`'s `preserve_order` feature — which a crate four
/// dependencies away turns on, and which cargo unifies across a build.
#[test]
fn the_set_sort_key_does_not_depend_on_the_order_keys_arrive_in() {
    let one: Value = serde_json::from_str(r#"{"b":1,"a":{"d":2,"c":[3,{"f":4,"e":5}]}}"#)
        .expect("a value parses");
    let other: Value = serde_json::from_str(r#"{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}"#)
        .expect("the same value, keyed in another order, parses");
    assert_eq!(canonical_text(&one), canonical_text(&other));
    // AND IT IS THE KEY-SORTED TEXT, which is what the generator's `stableJson`
    // writes on the fixture's side.
    assert_eq!(
        canonical_text(&one),
        r#"{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}"#
    );
    // A SET OF TWO OBJECTS SORTS THE SAME WAY WHICHEVER SIDE BUILT IT.
    let set = as_set(&Value::Array(vec![one.clone(), json!({"a": 0, "b": 0})]));
    let mirrored = as_set(&Value::Array(vec![json!({"b": 0, "a": 0}), other]));
    assert_eq!(canonical_text(&set), canonical_text(&mirrored));
}
