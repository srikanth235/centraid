//! THE LINES OF A CONFIRM CARD (#1088, R-1088-2, R-1088-10): one for each row a parked write
//! changes, composed from the runtime's structured facts and the chat's copy.
//!
//! A card is the only thing standing between a 0.8B model's proposal and the vault, so what it
//! says must not be the model's text: [`RowChange`] holds the kind and the title of the row, what
//! moves on it (old and new, spelled for display) and the links it gains or loses, and
//! [`step_of`] says them in the words of `copy/chat.json`. The text the model was shown after the
//! write (`#3 task "…" · status open → done`, with its `#n` handles) is not read here.

use crate::native::park::{FieldChange, RowChange, destructive_verb};

use super::words::{Say, say_with};

/// The most field changes a line spells; the rest are the vault's to show once it is done.
pub const DETAIL_MAX: usize = 3;

/// One line of the card: one row the write changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardStep {
    /// The runtime's verb for the row: `complete`, `edit`, `delete`…
    pub verb: String,
    /// What the row is: `task`, `person`…
    pub kind: String,
    /// The row's name.
    pub title: String,
    /// The whole line, composed from the copy.
    pub summary: String,
    /// This step deletes or removes, cancels, or settles money.
    pub destructive: bool,
}

/// The sentence a verb opens its line with, and whether it says what moved.
fn opening(verb: &str) -> (Say, bool) {
    match verb {
        "create" => (Say::StepCreate, true),
        "reschedule" => (Say::StepReschedule, true),
        "complete" => (Say::StepComplete, false),
        "reopen" => (Say::StepReopen, false),
        "cancel" => (Say::StepCancel, false),
        "delete" => (Say::StepDelete, false),
        "restore" => (Say::StepRestore, false),
        "star" => (Say::StepStar, false),
        "unstar" => (Say::StepUnstar, false),
        "add_to" => (Say::StepAddTo, false),
        "remove_from" => (Say::StepRemoveFrom, false),
        "log" => (Say::StepLog, false),
        "settle_up" => (Say::StepSettleUp, false),
        "settle_debt" => (Say::StepSettleDebt, false),
        "undo" => (Say::StepUndo, false),
        // `edit`, and `reveal` (which the phone never parks: the Locker is off)
        _ => (Say::StepEdit, true),
    }
}

/// One field that moved, in words: `due tomorrow → Fri 9 Oct`.
fn field_text(change: &FieldChange) -> String {
    match (&change.from, &change.to) {
        (Some(from), Some(to)) => say_with(
            Say::StepField,
            &[("field", &change.field), ("from", from), ("to", to)],
        ),
        (None, Some(to)) => say_with(Say::StepFieldNew, &[("field", &change.field), ("to", to)]),
        _ => say_with(Say::StepFieldCleared, &[("field", &change.field)]),
    }
}

/// The container a link names: `list "Kids"`.
fn container_of(change: &RowChange, added: bool) -> Option<String> {
    change
        .links
        .iter()
        .find(|link| link.added == added)
        .map(|link| format!("{} \"{}\"", link.kind, link.title))
}

/// The line for one changed row.
#[must_use]
pub fn step_of(change: &RowChange) -> CardStep {
    let (mut which, detailed) = opening(change.verb);
    // an add or a removal names the container; one that moved no link says what changed instead
    let container = match change.verb {
        "add_to" => container_of(change, true),
        "remove_from" => container_of(change, false),
        _ => None,
    };
    if matches!(change.verb, "add_to" | "remove_from") && container.is_none() {
        which = Say::StepEdit;
    }
    let mut summary = say_with(
        which,
        &[
            ("kind", change.kind),
            ("title", &change.title),
            ("container", container.as_deref().unwrap_or_default()),
        ],
    );
    let says_fields = detailed || which == Say::StepEdit;
    let moved: Vec<String> = change
        .fields
        .iter()
        .take(DETAIL_MAX)
        .map(field_text)
        .collect();
    if says_fields && !moved.is_empty() {
        summary = say_with(
            Say::StepDetail,
            &[("step", &summary), ("changes", &moved.join(", "))],
        );
    }
    CardStep {
        verb: change.verb.to_owned(),
        kind: change.kind.to_owned(),
        title: change.title.clone(),
        summary,
        destructive: destructive_verb(change.verb),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::meta::VERBS;
    use crate::native::park::LinkChange;

    fn row(verb: &'static str) -> RowChange {
        RowChange {
            verb,
            kind: "task",
            title: "Call plumber".to_owned(),
            created: false,
            fields: Vec::new(),
            links: Vec::new(),
        }
    }

    fn moved(field: &str, from: Option<&str>, to: Option<&str>) -> FieldChange {
        FieldChange {
            field: field.to_owned(),
            from: from.map(str::to_owned),
            to: to.map(str::to_owned),
        }
    }

    #[test]
    fn a_plain_verb_names_the_kind_and_the_title_and_nothing_the_model_was_shown() {
        let mut change = row("complete");
        change.fields = vec![
            moved("status", Some("needs-action"), Some("completed")),
            moved("completed", None, Some("today")),
        ];
        let step = step_of(&change);
        assert_eq!(step.summary, "Complete task \"Call plumber\"");
        assert_eq!(step.verb, "complete");
        assert_eq!(
            (step.kind.as_str(), step.title.as_str()),
            ("task", "Call plumber")
        );
        assert!(!step.destructive);
        assert!(
            !step.summary.contains('#'),
            "no `#n` handle: {}",
            step.summary
        );
    }

    #[test]
    fn an_edit_and_a_reschedule_say_what_moved_old_to_new() {
        let mut change = row("reschedule");
        change.fields = vec![moved("due", Some("tomorrow"), Some("Fri 9 Oct"))];
        assert_eq!(
            step_of(&change).summary,
            "Reschedule task \"Call plumber\": due tomorrow → Fri 9 Oct"
        );
        let mut change = row("edit");
        change.fields = vec![
            moved(
                "name",
                Some("\"Call plumber\""),
                Some("\"Call the plumber\""),
            ),
            moved("priority", Some("3"), None),
            moved("effort", None, Some("30 min")),
        ];
        assert_eq!(
            step_of(&change).summary,
            "Change task \"Call plumber\": name \"Call plumber\" → \"Call the plumber\", priority cleared, effort 30 min"
        );
    }

    #[test]
    fn at_most_three_changes_are_spelled() {
        let mut change = row("edit");
        change.fields = (0..6)
            .map(|n| moved(&format!("f{n}"), Some("a"), Some("b")))
            .collect();
        let summary = step_of(&change).summary;
        assert!(summary.contains("f2 a → b"), "{summary}");
        assert!(!summary.contains("f3"), "{summary}");
    }

    #[test]
    fn a_new_row_starts_with_its_values() {
        let mut change = row("create");
        change.created = true;
        change.fields = vec![moved("due", None, Some("tomorrow"))];
        assert_eq!(
            step_of(&change).summary,
            "Add task \"Call plumber\": due tomorrow"
        );
    }

    #[test]
    fn deleting_and_removing_are_destructive_and_completing_is_not() {
        for (verb, destructive) in [
            ("delete", true),
            ("remove_from", true),
            ("cancel", true),
            ("settle_up", true),
            ("settle_debt", true),
            ("complete", false),
            ("edit", false),
            ("create", false),
            ("star", false),
            ("add_to", false),
        ] {
            assert_eq!(step_of(&row(verb)).destructive, destructive, "{verb}");
        }
    }

    #[test]
    fn an_add_or_a_removal_names_the_container_it_moved_the_row_in_or_out_of() {
        let mut change = row("add_to");
        change.links = vec![LinkChange {
            added: true,
            kind: "list",
            title: "Kids".to_owned(),
        }];
        assert_eq!(
            step_of(&change).summary,
            "Add task \"Call plumber\" to list \"Kids\""
        );
        let mut change = row("remove_from");
        change.links = vec![LinkChange {
            added: false,
            kind: "list",
            title: "Kids".to_owned(),
        }];
        assert_eq!(
            step_of(&change).summary,
            "Remove task \"Call plumber\" from list \"Kids\""
        );
        // a link that did not move says the row, not a container it cannot name
        assert_eq!(
            step_of(&row("add_to")).summary,
            "Change task \"Call plumber\""
        );
    }

    #[test]
    fn every_verb_the_runtime_has_makes_a_line_and_none_leaves_a_hole() {
        for verb in VERBS.iter().map(|spec| spec.name) {
            let mut change = row(verb);
            change.links = vec![LinkChange {
                added: verb == "add_to",
                kind: "list",
                title: "Kids".to_owned(),
            }];
            let step = step_of(&change);
            assert!(step.summary.contains("Call plumber"), "{verb}");
            assert!(!step.summary.contains('{'), "{verb}: {}", step.summary);
            assert!(!step.summary.is_empty(), "{verb}");
        }
    }
}
