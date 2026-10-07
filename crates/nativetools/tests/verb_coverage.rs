//! Every `(verb, kind, command)` of `meta::VERBS` lands through the runtime.
//!
//! The metadata table says which typed command each verb runs on each kind.
//! The registry validates a command's input against its `input_schema` when
//! it executes, so a mapped pair is only proven when a call to the runtime
//! made the vault EXECUTE that command. This test drives each pair once
//! against the fixture world and reads the vault's own invocation journal
//! for the command, so a pair the runtime never reaches (or reaches with
//! input the schema rejects) fails here and is named in the message. A pair
//! that cannot be driven from the fixture world is listed in `UNDRIVEN` with
//! its reason; an empty reason fails.
//!
//! `undo` has no command of its own (it runs the inverse of an earlier
//! write), so it has no pair; `tests/verbs.rs` covers it.

mod common;

use std::collections::BTreeMap;

use centraid_nativetools::Session;
use centraid_nativetools::meta::{Kind, VERBS};
use centraid_nativetools::vaultio::{self, SetClock};
use common::{World, call, number, numbers, seeded, trashed_number};
use serde_json::{Value, json};

/// Pairs the fixture world cannot drive: `(verb, kind, reason)`. Empty: every
/// pair of the table is driven below.
const UNDRIVEN: &[(&str, &str, &str)] = &[];

/// Executed commands in the vault's journal, counted per command id.
fn executed(world: &World) -> BTreeMap<String, usize> {
    let handle = vaultio::Handle::open(world.path(), SetClock::at(1_800_000_000_000), "coverage")
        .expect("the journal opens");
    let rows = handle
        .table(
            "agent_command_invocation",
            "invocation_id, command_id, status, requested_at",
            "requested_at",
            "invocation_id",
        )
        .expect("the journal reads");
    let mut counts = BTreeMap::new();
    for row in &rows {
        if vaultio::text(row, "status").as_deref() == Some("executed") {
            let command = vaultio::text(row, "command_id").unwrap_or_default();
            *counts.entry(command).or_insert(0) += 1;
        }
    }
    counts
}

/// The measured call: the one whose journal delta is checked.
type Measure<'a> = &'a mut dyn FnMut(&mut Session, Value) -> Value;

/// Drive one pair: set the world up with unmeasured calls, then make the one
/// measured `act`. `None` when the pair has no driver.
#[allow(clippy::too_many_lines)]
fn drive(session: &mut Session, verb: &str, kind: Kind, measure: Measure<'_>) -> Option<Value> {
    let name = kind.name();
    // The row each kind's single-row verbs act on, by a find that selects one.
    let subject = match kind {
        Kind::Person => "Ray",
        Kind::Group => "Flat",
        Kind::Event => "Dentist",
        Kind::Task => "cabin",
        Kind::Note => "Dal",
        Kind::Document => "Lease",
        Kind::Photo => "Hike",
        Kind::Album => "Summer",
        Kind::Debt => "concert tickets",
        Kind::LockerItem => "Bank",
        Kind::Notebook => "Recipes",
        Kind::Folder => "Taxes",
        Kind::List => "Home",
    };
    Some(match verb {
        "create" => {
            session.user("");
            let args = match kind {
                Kind::Person => json!({"name": "Ada Lovelace", "role": "friend"}),
                Kind::Group => json!({"name": "Book club"}),
                Kind::Event => {
                    json!({"name": "Coffee", "date": {"unit": "week", "rel": 1, "weekday": 1, "time": "14:00"}})
                }
                Kind::Task => {
                    json!({"name": "Call plumber", "date": {"unit": "day", "rel": 1}, "effort": 15})
                }
                Kind::Note => json!({"name": "Packing list", "body": "socks"}),
                Kind::Document => json!({"name": "Receipt", "text": "paid"}),
                Kind::Album => json!({"name": "Autumn"}),
                Kind::Debt => {
                    let neha = number(session, "person", "Neha Rao");
                    json!({"name": "taxi", "person": neha, "amount": 18.5, "direction": "owes_me"})
                }
                Kind::LockerItem => json!({"name": "Gym", "type": "membership"}),
                Kind::Notebook => json!({"name": "Travel"}),
                Kind::Folder => json!({"name": "Medical"}),
                Kind::List => json!({"name": "Errands"}),
                Kind::Photo => return None,
            };
            measure(
                session,
                json!({"verb": "create", "kind": name, "args": args}),
            )
        }
        "edit" => {
            let row = number(session, name, subject);
            let args = match kind {
                Kind::Note => json!({"body+": "and salt"}),
                Kind::Task => json!({"effort": 45}),
                Kind::LockerItem => json!({"username": "sam2"}),
                _ => json!({"name": format!("{subject} renamed")}),
            };
            measure(session, json!({"verb": "edit", "rows": row, "args": args}))
        }
        "reschedule" => {
            let row = number(session, name, subject);
            let args = json!({"to": {"unit": "day", "rel": 1}});
            measure(
                session,
                json!({"verb": "reschedule", "rows": row, "args": args}),
            )
        }
        "complete" => {
            let row = number(session, name, subject);
            measure(session, json!({"verb": "complete", "rows": row}))
        }
        "reopen" => {
            let row = number(session, name, "Write report");
            measure(session, json!({"verb": "reopen", "rows": row}))
        }
        "cancel" => {
            let row = number(session, name, subject);
            measure(session, json!({"verb": "cancel", "rows": row}))
        }
        "delete" => {
            // A group with expenses, a folder with documents and a notebook
            // with notes ask first; the empty ones go.
            let target = match kind {
                Kind::Group => "Flat",
                Kind::Folder => {
                    session.user("");
                    let made = call(
                        session,
                        "act",
                        json!({"verb": "create", "kind": "folder", "args": {"name": "Scratch"}}),
                    );
                    assert!(made["text"].as_str().unwrap().starts_with("created"));
                    "Scratch"
                }
                Kind::Notebook => "Ideas",
                Kind::Album => "Wedding",
                Kind::Person => "Ray",
                other => match other {
                    Kind::Event => "Dentist",
                    Kind::Task => "reed",
                    Kind::Note => "Diary",
                    Kind::Document => "Lease",
                    Kind::Photo => "Hike",
                    _ => "Bank",
                },
            };
            let row = number(session, name, target);
            measure(session, json!({"verb": "delete", "rows": row}))
        }
        "restore" => {
            // The fixture's own trashed task where it has one (its trashed person is past the restore window); otherwise
            // delete one first.
            let already = match kind {
                Kind::Task => Some("Library"),
                _ => None,
            };
            let target = already.unwrap_or(match kind {
                Kind::Person => "Ray",
                Kind::Event => "Dentist",
                Kind::Note => "Diary",
                Kind::Document => "Lease",
                Kind::Photo => "Hike",
                _ => "Bank",
            });
            if already.is_none() {
                let row = number(session, name, target);
                let deleted = call(session, "act", json!({"verb": "delete", "rows": row}));
                assert!(
                    deleted["text"].as_str().unwrap().starts_with("deleted"),
                    "{}",
                    deleted["text"]
                );
            }
            let row = trashed_number(session, name, target);
            measure(session, json!({"verb": "restore", "rows": row}))
        }
        "star" | "unstar" => {
            let row_name = match (kind, verb) {
                (Kind::Person, "star") => "Benedikt",
                (Kind::Person, _) => "Neha Rao",
                (Kind::Document, "star") => "Lease",
                (Kind::Document, _) => "W2",
                (Kind::Photo, "star") => "Hike",
                (Kind::Photo, _) => "Beach",
                (_, "star") => "Bank",
                _ => "wifi",
            };
            let row = number(session, name, row_name);
            measure(session, json!({"verb": verb, "rows": row}))
        }
        "add_to" | "remove_from" => {
            let (row_name, container_kind, container) = match (kind, verb) {
                (Kind::Person, "add_to") => ("Benedikt", "group", "Tahoe"),
                (Kind::Person, _) => ("Benedikt", "group", "Flat"),
                (Kind::Photo, "add_to") => ("Hike", "album", "Wedding"),
                (Kind::Photo, _) => ("Hike", "album", "Summer"),
                (Kind::Note, "add_to") => ("Diary", "notebook", "Ideas"),
                (Kind::Note, _) => ("Dal", "notebook", "Recipes"),
                (Kind::Document, "add_to") => ("Lease", "folder", "Taxes"),
                (Kind::Document, _) => ("W2", "folder", "Taxes"),
                (_, "add_to") => ("Pay rent", "list", "Home"),
                _ => ("cabin", "list", "Home"),
            };
            let found = numbers(session, &[(name, row_name), (container_kind, container)]);
            let args = if verb == "add_to" {
                format!("to: {}", found[1])
            } else {
                format!("from: {}", found[1])
            };
            measure(
                session,
                json!({"verb": verb, "rows": found[0], "args": args}),
            )
        }
        "log" => {
            let row = number(session, name, subject);
            measure(
                session,
                json!({"verb": "log", "rows": row, "args": "kind: coffee"}),
            )
        }
        "settle_up" => {
            let found = numbers(session, &[("person", "Ray"), ("group", "Tahoe")]);
            let args = format!("group: {}", found[1]);
            measure(
                session,
                json!({"verb": "settle_up", "rows": found[0], "args": args}),
            )
        }
        "settle_debt" => {
            let row = number(session, name, subject);
            measure(session, json!({"verb": "settle_debt", "rows": row}))
        }
        "reveal" => {
            let row = number(session, name, "wifi");
            measure(
                session,
                json!({"verb": "reveal", "rows": row, "args": "field: password"}),
            )
        }
        _ => return None,
    })
}

#[test]
fn every_mapped_write_lands_through_the_runtime() {
    for (verb, kind, reason) in UNDRIVEN {
        assert!(
            !reason.trim().is_empty(),
            "UNDRIVEN {verb} {kind} gives no reason"
        );
    }
    let mut uncovered = Vec::new();
    let mut driven = 0;
    for spec in VERBS {
        for (kind, command) in spec.commands {
            let pair = format!("{} {} -> {command}", spec.name, kind.name());
            if let Some((_, _, reason)) = UNDRIVEN
                .iter()
                .find(|(verb, undriven, _)| *verb == spec.name && *undriven == kind.name())
            {
                assert!(!reason.trim().is_empty(), "{pair}: no reason");
                continue;
            }
            let world = seeded();
            let mut session = world.session();
            let mut landed: Option<(Value, Vec<String>)> = None;
            let drove = drive(&mut session, spec.name, *kind, &mut |session, args| {
                let before = executed(&world);
                let response = call(session, "act", args);
                let after = executed(&world);
                let new: Vec<String> = after
                    .iter()
                    .filter(|(id, count)| **count > before.get(*id).copied().unwrap_or(0))
                    .map(|(id, _)| id.clone())
                    .collect();
                landed = Some((response.clone(), new));
                response
            });
            if drove.is_none() {
                uncovered.push(format!("{pair}: no driver and not in UNDRIVEN"));
                continue;
            }
            driven += 1;
            let (response, new) = landed.expect("a driven pair makes its measured call");
            if !new.iter().any(|id| id == command) {
                uncovered.push(format!(
                    "{pair}: the runtime executed {new:?} and said {:?}",
                    response["text"]
                ));
            }
        }
    }
    assert!(
        uncovered.is_empty(),
        "mapped (verb, kind, command) pairs no runtime call lands:\n{}",
        uncovered.join("\n")
    );
    let pairs: usize = VERBS.iter().map(|spec| spec.commands.len()).sum();
    assert_eq!(driven + UNDRIVEN.len(), pairs);
}
