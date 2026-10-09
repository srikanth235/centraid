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

use centraid_nativetools::meta::VERBS;
use centraid_nativetools::vaultio::{self, SetClock};
use common::drive::drive;
use common::{World, call, seeded};
use serde_json::Value;

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
