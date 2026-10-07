//! A write that parks shows the model what a write that runs shows it (#1088, R-1088-6).
//!
//! `Writes::Park` applies the steps of a write to a patched copy of the world and leaves the vault
//! alone. These tests hold that to the vault on the fixture world, for every `(verb, kind)` of
//! `meta::VERBS`:
//!
//! * `Writes::Shadow` runs each pair for real AND through the patch and keeps where the two parted:
//!   the patched world is the vault's, field for field, after every pair;
//! * a parked pair answers the text and the effect a run answers (ids aside: the vault mints some
//!   inside a command that a parked step has not run), and writes nothing;
//! * a chain in one turn that names the row its first write made works while parked.
//!
//! The same is held over hundreds of authored sessions by `experiments/toolchat/native/authored/
//! park_oracle.py`.

mod common;

use std::collections::BTreeMap;

use centraid_nativetools::meta::VERBS;
use centraid_nativetools::park::Writes;
use centraid_nativetools::{Flags, Session};
use common::drive::drive;
use common::{World, call, journal, seeded};
use serde_json::{Value, json};

fn flags(writes: Writes) -> Flags {
    Flags {
        writes,
        ..Flags::default()
    }
}

/// A value with its ids renamed by order of appearance: the vault mints ids inside a command that a
/// parked step has not run, so a run and a park draw different ones for the rows they make.
fn canon(value: &Value) -> String {
    fn walk(value: &mut Value, seen: &mut Vec<String>) {
        match value {
            Value::String(text) if is_id(text) => {
                let at = seen
                    .iter()
                    .position(|have| have == text)
                    .unwrap_or_else(|| {
                        seen.push(text.clone());
                        seen.len() - 1
                    });
                *value = json!(format!("ID{at}"));
            }
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, seen)),
            Value::Object(map) => map.values_mut().for_each(|item| walk(item, seen)),
            _ => {}
        }
    }
    let mut value = value.clone();
    walk(&mut value, &mut Vec::new());
    value.to_string()
}

fn is_id(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(at, c)| {
            matches!(at, 8 | 13 | 18 | 23) == (c == '-') && (c == '-' || c.is_ascii_hexdigit())
        })
}

/// Drive every pair of `VERBS` once on a fresh fixture world, in `writes` mode, and hand each
/// pair's session, world and measured response to `check`.
fn each_pair(writes: Writes, mut check: impl FnMut(&str, &mut Session, &World, &Value)) {
    for spec in VERBS {
        for (kind, command) in spec.commands {
            let pair = format!("{} {} -> {command}", spec.name, kind.name());
            let world = seeded();
            let mut session = world.session_with(common::TODAY, flags(writes));
            let mut measured = None;
            let drove = drive(&mut session, spec.name, *kind, &mut |session, args| {
                let response = call(session, "act", args);
                measured = Some(response.clone());
                response
            });
            if drove.is_none() {
                continue;
            }
            check(
                &pair,
                &mut session,
                &world,
                &measured.expect("a driven pair makes its measured call"),
            );
        }
    }
}

#[test]
fn the_patched_world_is_the_vaults_after_every_mapped_write() {
    let mut driven = 0;
    each_pair(Writes::Shadow, |pair, session, _, _| {
        driven += 1;
        let drift = session.take_drift();
        assert!(
            drift.is_empty(),
            "{pair}: the patch parted from the vault:\n{}",
            drift.join("\n")
        );
    });
    let pairs: usize = VERBS.iter().map(|spec| spec.commands.len()).sum();
    assert_eq!(driven, pairs, "every pair of the table is driven");
}

#[test]
fn a_parked_write_answers_what_a_run_answers_and_writes_nothing() {
    let mut run = BTreeMap::new();
    each_pair(Writes::Run, |pair, _, _, response| {
        run.insert(
            pair.to_owned(),
            (response["text"].clone(), canon(&response["effect"])),
        );
    });
    let fresh = seeded_journal();
    let mut compared = 0;
    each_pair(Writes::Park, |pair, _, world, response| {
        let (text, effect) = &run[pair];
        assert_eq!(&response["text"], text, "{pair}: the observation text");
        assert_eq!(&canon(&response["effect"]), effect, "{pair}: the effect");
        assert_eq!(
            journal(world),
            fresh,
            "{pair}: a parked write reached the vault"
        );
        compared += 1;
    });
    assert_eq!(compared, run.len());
}

/// The commands the seeding ran, before any session: the journal of a fresh world.
fn seeded_journal() -> BTreeMap<(String, String), usize> {
    journal(&seeded())
}

#[test]
fn a_parked_session_leaves_the_vault_as_it_found_it() {
    let world = seeded();
    let before = journal(&world);
    assert_eq!(before, seeded_journal());
    let mut session = world.session_with(common::TODAY, flags(Writes::Park));
    session.user("make a task and finish it");
    let made = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: Renew passport", "more": true}),
    );
    assert!(
        made["text"].as_str().unwrap().starts_with("created:"),
        "{}",
        made["text"]
    );
    assert_eq!(
        journal(&world),
        before,
        "a parked create does not reach the vault"
    );
    assert_eq!(session.parked().len(), 1, "its one step is kept, in order");
    assert_eq!(session.parked()[0].command, "schedule.add_task");
}

#[test]
fn a_parked_chain_names_the_row_its_first_write_made() {
    let world = seeded();
    let before = journal(&world);
    let mut session = world.session_with(common::TODAY, flags(Writes::Park));
    session.user("add a task to renew the passport and tick it off");
    let made = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: Renew passport", "more": true}),
    );
    let number = format!("#{}", made["effect"]["created"][0]["n"]);
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": number}),
    );
    let text = done["text"].as_str().unwrap();
    assert!(
        text.starts_with("completed:")
            && text.contains("Renew passport")
            && text.contains("status open → completed"),
        "{text}"
    );
    assert_eq!(journal(&world), before, "neither write reached the vault");
    let steps: Vec<&str> = session
        .parked()
        .iter()
        .map(|step| step.command.as_str())
        .collect();
    assert_eq!(steps, ["schedule.add_task", "schedule.set_task_status"]);
    // the id the second step names is the id the first one makes
    assert_eq!(
        session.parked()[1].input["task_id"],
        session.parked()[0].input["task_id"]
    );
}
