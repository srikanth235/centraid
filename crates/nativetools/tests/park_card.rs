//! The lines of a confirm card are the runtime's facts in the chat's words (#1088, R-1088-2).
//!
//! The card is the only thing between a small model's proposal and the vault, so it is checked
//! against every `(verb, kind)` pair the table maps, driven on the fixture world in `Writes::Park`:
//! each write that parks names its row, says its verb, asks twice exactly when it deletes, removes,
//! cancels or settles, and carries none of the model's `#n` handles. `native_turn::pending` holds
//! the composition; this holds it to the runtime's real rows.

mod common;

use std::sync::OnceLock;

use centraid_assist::native::park::{RowChange, destructive_verb};
use centraid_assist::native_turn::pending::step_of;
use centraid_nativetools::Flags;
use centraid_nativetools::meta::VERBS;
use centraid_nativetools::park::Writes;
use common::drive::drive;
use common::{call, seeded};

/// One driven pair, and what its parked write left waiting.
struct Parked {
    pair: String,
    verb: &'static str,
    /// `None`: nothing parked (a reveal).
    pending: Option<Waiting>,
}

struct Waiting {
    changes: Vec<RowChange>,
    preview: Vec<String>,
    destructive: bool,
    not_undoable: bool,
}

/// Every pair the table maps, driven once on the fixture world in `Writes::Park` (the sweep is slow
/// and its three readers share it).
fn sweep() -> &'static [Parked] {
    static SWEEP: OnceLock<Vec<Parked>> = OnceLock::new();
    SWEEP.get_or_init(|| {
        let mut out = Vec::new();
        for spec in VERBS {
            for (kind, command) in spec.commands {
                let world = seeded();
                let flags = Flags {
                    writes: Writes::Park,
                    ..Flags::default()
                };
                let mut session = world.session_with(common::TODAY, flags);
                let drove = drive(&mut session, spec.name, *kind, &mut |session, args| {
                    call(session, "act", args)
                });
                if drove.is_some() {
                    out.push(Parked {
                        pair: format!("{} {} -> {command}", spec.name, kind.name()),
                        verb: spec.name,
                        pending: session.pending().map(|pending| Waiting {
                            changes: pending.changes.clone(),
                            preview: pending.preview.clone(),
                            destructive: pending.destructive(),
                            not_undoable: !pending.not_undoable.is_empty(),
                        }),
                    });
                }
            }
        }
        out
    })
}

#[test]
fn every_mapped_write_makes_a_line_that_names_its_row_and_asks_twice_only_when_it_takes_something_away()
 {
    let mut lines = 0;
    for Parked {
        pair,
        verb,
        pending,
    } in sweep()
    {
        // a reveal reads and writes nothing; every other pair parked a write
        if *verb == "reveal" {
            continue;
        }
        let waiting = pending
            .as_ref()
            .unwrap_or_else(|| panic!("{pair}: nothing is waiting"));
        assert!(!waiting.changes.is_empty(), "{pair}: the card names no row");
        for change in &waiting.changes {
            let step = step_of(change);
            lines += 1;
            assert_eq!(step.verb, *verb, "{pair}");
            assert!(
                !change.title.is_empty() && !change.kind.is_empty(),
                "{pair}"
            );
            assert!(
                step.summary.contains(&format!("\"{}\"", change.title)),
                "{pair}: the line does not name the row: {}",
                step.summary
            );
            assert!(
                !step.summary.contains('#') && !step.summary.contains('{'),
                "{pair}: a handle or a hole in the line: {}",
                step.summary
            );
            assert_eq!(step.destructive, destructive_verb(verb), "{pair}");
            assert_eq!(
                step.destructive,
                matches!(
                    *verb,
                    "delete" | "remove_from" | "cancel" | "settle_up" | "settle_debt"
                ),
                "{pair}"
            );
        }
        assert_eq!(
            waiting.destructive,
            waiting.changes.iter().any(|c| step_of(c).destructive) || waiting.not_undoable,
            "{pair}: the card and its lines disagree about asking twice"
        );
    }
    assert!(lines >= 60, "the sweep drove {lines} lines");
}

#[test]
fn the_card_is_not_the_text_the_model_was_shown() {
    let mut handles = 0;
    for Parked {
        pair,
        verb,
        pending,
    } in sweep()
    {
        let Some(waiting) = pending else { continue };
        if *verb == "reveal" {
            continue;
        }
        // the model's change lines name rows by `#n`; the card never does
        handles += waiting
            .preview
            .iter()
            .filter(|line| line.contains('#'))
            .count();
        for change in &waiting.changes {
            let summary = step_of(change).summary;
            assert!(!summary.contains('#'), "{pair}: {summary}");
        }
    }
    assert!(handles > 40, "the model's lines carry handles ({handles})");
}

#[test]
fn a_rename_names_the_row_as_the_member_knew_it_and_a_reschedule_says_old_to_new() {
    let seen: std::collections::BTreeMap<&str, String> = sweep()
        .iter()
        .filter_map(|parked| {
            let change = parked.pending.as_ref()?.changes.first()?;
            Some((parked.pair.as_str(), step_of(change).summary))
        })
        .collect();
    assert_eq!(
        seen["edit person -> people.edit_person"],
        "Change person \"Ray Ochoa\": name \"Ray Ochoa\" → \"Ray renamed\""
    );
    assert_eq!(
        seen["reschedule task -> schedule.edit_task"],
        "Reschedule task \"Book the cabin\": due next Friday 09:00 → tomorrow 09:00"
    );
    assert_eq!(
        seen["add_to task -> schedule.organize_task"],
        "Add task \"Pay rent\" to list \"Home\""
    );
    assert_eq!(
        seen["remove_from task -> schedule.organize_task"],
        "Remove task \"Book the cabin\" from list \"Home\""
    );
    assert_eq!(
        seen["create task -> schedule.add_task"],
        "Add task \"Call plumber\": due tomorrow, status open, effort 15 min"
    );
    assert_eq!(
        seen["delete task -> schedule.delete_task"],
        "Delete task \"Mend reed for Benedikt\""
    );
}
