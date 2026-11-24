//! Every `(verb, kind, command)` of `meta::VERBS` lands through the runtime.
//!
//! The metadata table says which typed command each verb runs on each kind.
//! The registry validates a command's input against its `input_schema` when
//! it executes, so a mapped pair is only proven when a call to the runtime
//! made the vault EXECUTE that command. This test drives each pair once
//! against the fixture world and reads the commands the harness's door ran
//! on it, so a pair the runtime never reaches (or reaches with
//! input the schema rejects) fails here and is named in the message. A pair
//! that cannot be driven from the fixture world is listed in `UNDRIVEN` with
//! its reason; an empty reason fails.
//!
//! `undo` has no command of its own (it runs the inverse of an earlier
//! write), so it has no pair; `tests/verbs.rs` covers it.

mod common;

use std::collections::BTreeMap;

use centraid_nativetools::meta::VERBS;
use centraid_nativetools::vaultio;
use common::drive::drive;
use common::{World, call, seeded};
use serde_json::Value;

/// Pairs the fixture world cannot drive: `(verb, kind, reason)`. Every other pair of the table is
/// driven below.
const UNDRIVEN: &[(&str, &str, &str)] = &[
    // --- Health (fixture world has no Health rows; tests/health_kind.rs drives Health) ---
    (
        "create",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "edit",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "delete",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "restore",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "purge",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "empty_trash",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "link",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "unlink",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "attach",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "detach",
        "workout",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "create",
        "daily figure",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "delete",
        "daily figure",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "edit",
        "daily figure",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    (
        "unfollow",
        "daily figure",
        "the fixture world holds no Health rows; tests/health_kind.rs drives it on its own world",
    ),
    // --- MemberAction cards (Reveal / Handoff emit a card, not a vault command) ---
    (
        "reveal",
        "locker item",
        "a reveal runs no command: it ends the turn in a member action the member completes in Locker (#1146); tests/locker_parity.rs drives it",
    ),
    (
        "configure",
        "account",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "configure",
        "locker passkey",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "edit_media",
        "photo",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "document",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "event",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "locker item",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "note",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "person",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "photo",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "task",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "transaction",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "export",
        "workout",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "follow",
        "daily figure",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "follow",
        "event",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "follow",
        "person",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "follow",
        "task",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "follow",
        "workout",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "import",
        "document",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "import",
        "note",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "import",
        "person",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "import",
        "photo",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    (
        "import",
        "transaction",
        "handoff action emits a MemberAction::Handoff card rather than executing a vault command",
    ),
    // --- Trashed rows unreachable by selector ---
    (
        "restore",
        "album",
        "a trashed album leaves the model with the photos it held, so no selector reaches it to restore; undo brings it back",
    ),
    (
        "restore",
        "transaction",
        "a trashed transaction is in no read the assistant has, so no selector reaches it to restore; undo brings it back",
    ),
    (
        "purge",
        "transaction",
        "a trashed transaction is in no read the assistant has, so no selector reaches it to purge",
    ),
    // --- Fixture world lacks seeded rows or sub-row context ---
    ("edit", "budget", "the fixture world holds no budget rows"),
    (
        "delete",
        "locker passkey",
        "the fixture world holds no passkey rows",
    ),
    (
        "create",
        "gift",
        "sub-row create requires person id and gift text; covered by full_action_coverage",
    ),
    (
        "create",
        "important date",
        "sub-row create requires person id, label, and month_day; covered by full_action_coverage",
    ),
    (
        "edit",
        "important date",
        "the fixture world holds no important_date rows",
    ),
    (
        "create",
        "journal entry",
        "sub-row create requires mood and text; covered by full_action_coverage",
    ),
    (
        "edit",
        "contact point",
        "the fixture world holds no contact_point rows",
    ),
    (
        "delete",
        "contact point",
        "the fixture world holds no contact_point rows",
    ),
    (
        "edit",
        "locker field",
        "the fixture world holds no custom locker_field rows",
    ),
    (
        "delete",
        "locker field",
        "the fixture world holds no custom locker_field rows",
    ),
    (
        "edit",
        "calendar",
        "calendar container edit covered on dedicated setup",
    ),
    (
        "delete",
        "calendar",
        "calendar container delete covered on dedicated setup",
    ),
    (
        "restore",
        "calendar",
        "calendar container restore covered on dedicated setup",
    ),
    (
        "edit",
        "people list",
        "people_list container edit covered on dedicated setup",
    ),
    (
        "delete",
        "people list",
        "people_list container delete covered on dedicated setup",
    ),
    (
        "restore",
        "people list",
        "people_list container restore covered on dedicated setup",
    ),
    ("edit", "place", "the fixture world holds no place rows"),
    (
        "create",
        "rule",
        "rule creation covered on dedicated money world",
    ),
    (
        "delete",
        "rule",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "edit",
        "transaction",
        "txn.edit covered in full_action_coverage",
    ),
    (
        "add_to",
        "person",
        "person.move requires a seeded people_list",
    ),
    (
        "remove_from",
        "person",
        "person.move requires a seeded people_list",
    ),
    (
        "restore_version",
        "document",
        "the fixture world holds no prior document version history",
    ),
    (
        "restore_version",
        "note",
        "the fixture world holds no prior note version history",
    ),
    (
        "unfollow",
        "event",
        "the fixture world holds no external follow subscriptions",
    ),
    (
        "unfollow",
        "person",
        "the fixture world holds no external follow subscriptions",
    ),
    (
        "unfollow",
        "task",
        "the fixture world holds no external follow subscriptions",
    ),
    // --- Newly closed Direct gap verbs (covered in full_action_coverage.rs) ---
    (
        "categorize",
        "transaction",
        "covered in full_action_coverage",
    ),
    ("respond", "event", "covered in full_action_coverage"),
    ("recolor", "document", "covered in full_action_coverage"),
    (
        "merge",
        "category",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "merge",
        "person",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "purge",
        "document",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "purge",
        "event",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "purge",
        "locker item",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "purge",
        "note",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "purge",
        "person",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "purge",
        "photo",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "purge",
        "task",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "document",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "event",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "locker item",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "note",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "person",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "photo",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "task",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "empty_trash",
        "transaction",
        "confirmation: required; covered in full_action_coverage",
    ),
    (
        "link",
        "document",
        "generic edge link covered in full_action_coverage",
    ),
    (
        "link",
        "event",
        "generic edge link covered in full_action_coverage",
    ),
    (
        "link",
        "locker item",
        "generic edge link covered in full_action_coverage",
    ),
    (
        "link",
        "note",
        "generic edge link covered in full_action_coverage",
    ),
    (
        "link",
        "person",
        "generic edge link covered in full_action_coverage",
    ),
    (
        "link",
        "photo",
        "generic edge link covered in full_action_coverage",
    ),
    (
        "link",
        "task",
        "generic edge link covered in full_action_coverage",
    ),
    (
        "link",
        "transaction",
        "transfer link covered in full_action_coverage",
    ),
    (
        "unlink",
        "document",
        "generic edge unlink covered via edge.remove",
    ),
    (
        "unlink",
        "event",
        "generic edge unlink covered via edge.remove",
    ),
    (
        "unlink",
        "locker item",
        "generic edge unlink covered via edge.remove",
    ),
    (
        "unlink",
        "note",
        "generic edge unlink covered via edge.remove",
    ),
    (
        "unlink",
        "person",
        "generic edge unlink covered via edge.remove",
    ),
    (
        "unlink",
        "photo",
        "generic edge unlink covered via edge.remove",
    ),
    (
        "unlink",
        "task",
        "generic edge unlink covered via edge.remove",
    ),
    (
        "attach",
        "document",
        "generic edge attach covered in full_action_coverage",
    ),
    (
        "attach",
        "event",
        "generic edge attach covered in full_action_coverage",
    ),
    (
        "attach",
        "note",
        "generic edge attach covered in full_action_coverage",
    ),
    (
        "attach",
        "person",
        "generic edge attach covered in full_action_coverage",
    ),
    (
        "attach",
        "photo",
        "generic edge attach covered in full_action_coverage",
    ),
    (
        "attach",
        "task",
        "generic edge attach covered in full_action_coverage",
    ),
    (
        "attach",
        "transaction",
        "generic edge attach covered in full_action_coverage",
    ),
    (
        "detach",
        "document",
        "generic edge detach covered in full_action_coverage",
    ),
    (
        "detach",
        "event",
        "generic edge detach covered in full_action_coverage",
    ),
    (
        "detach",
        "note",
        "generic edge detach covered in full_action_coverage",
    ),
    (
        "detach",
        "person",
        "generic edge detach covered in full_action_coverage",
    ),
    (
        "detach",
        "photo",
        "generic edge detach covered in full_action_coverage",
    ),
    (
        "detach",
        "task",
        "generic edge detach covered in full_action_coverage",
    ),
    (
        "detach",
        "transaction",
        "generic edge detach covered in full_action_coverage",
    ),
];

/// Executed commands the harness's door has run on the world's vault, counted per command id.
fn executed(world: &World) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for ((command, outcome), count) in vaultio::commands_run(world.path()) {
        if outcome == "executed" {
            counts.insert(command, count);
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
