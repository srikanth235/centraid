//! THE WORDS THE RUNTIME SAYS (R-1088-10): composed from an effect, never generated.
//!
//! The model writes a call, and at most the question of an `ask`. Everything else a member reads at
//! the end of a native turn (how many rows were found, what a value is, why a request was declined)
//! is a sentence of the chat's copy, filled from the step's effect. No second generation, so the
//! same effect always reads the same, and the copy rulebook (`DESIGN.md` § Copy) governs every word.
//!
//! The sentences live in `copy/chat.json`, the file the shells' `ChatCopy.kt` mirrors, under the
//! `SAID_` prefix, and are compiled in from there: this module owns the key names and the fill
//! points, and a test fails when a key here is missing from the file or a placeholder is left open.

use std::collections::BTreeMap;
use std::sync::OnceLock;

/// `copy/chat.json`, the source of the chat's sentences.
const CHAT_COPY: &str = include_str!("../../../../copy/chat.json");

/// One sentence of what the runtime says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Say {
    /// `Balance {value}.`: a balance with no one to name.
    Balance,
    /// `You and {name} are settled up.`
    BalanceEven,
    /// `{name} owes you {value}.`
    BalanceOwed,
    /// `You owe {name} {value}.`
    BalanceOwing,
    /// The turn ran out of steps with nothing to ask.
    Cap,
    /// `Counted {what}.`
    Count,
    DeclineFabricatedSecret,
    DeclineNeverMind,
    DeclineOutOfScope,
    DeclineSealedEgress,
    DeclineUnboundedDestruction,
    /// `Found {what}.`
    Found,
    /// `Found {what}. Showing {shown}.`: more rows than cards.
    FoundSome,
    /// `Highest {field}: {value}.`
    Highest,
    /// `Lowest {field}: {value}.`
    Lowest,
    /// A read that found nothing, and the decline `not_found`.
    Nothing,
    /// `Total {field}: {value}.`
    Total,
    /// `Proposed: {what}.`: a write waiting for the member's tap.
    Proposed,
    /// A confirmed card ran.
    Applied,
    /// A confirmed card's rows changed since it was planned.
    Stale,
    /// `Not done. {reason}`: the vault refused a step of a confirmed card.
    NotDone,
    /// A tap on a card that is no longer waiting.
    NothingWaiting,
    /// `Add {kind} "{title}" to {container}`: a row put in a list, album, folder, notebook or group.
    StepAddTo,
    /// `Cancel {kind} "{title}"`
    StepCancel,
    /// `Complete {kind} "{title}"`
    StepComplete,
    /// `Add {kind} "{title}"`: a new row.
    StepCreate,
    /// `Delete {kind} "{title}"`
    StepDelete,
    /// `{step}: {changes}`: a step with what moves on its row.
    StepDetail,
    /// `Change {kind} "{title}"`
    StepEdit,
    /// `{field} {from} → {to}`: a field that moved.
    StepField,
    /// `{field} cleared`: a field that went away.
    StepFieldCleared,
    /// `{field} {to}`: a field of a row that is new.
    StepFieldNew,
    /// `Log a contact with "{title}"`
    StepLog,
    /// `Remove {kind} "{title}" from {container}`
    StepRemoveFrom,
    /// `Reopen {kind} "{title}"`
    StepReopen,
    /// `Reschedule {kind} "{title}"`
    StepReschedule,
    /// `Restore {kind} "{title}"`
    StepRestore,
    /// `Settle {kind} "{title}"`
    StepSettleDebt,
    /// `Settle up with "{title}"`
    StepSettleUp,
    /// `Star {kind} "{title}"`
    StepStar,
    /// `Undo {kind} "{title}"`
    StepUndo,
    /// `Unstar {kind} "{title}"`
    StepUnstar,
}

impl Say {
    /// Every sentence, for the test that holds them against the copy file.
    pub const ALL: [Self; 42] = [
        Self::Balance,
        Self::BalanceEven,
        Self::BalanceOwed,
        Self::BalanceOwing,
        Self::Cap,
        Self::Count,
        Self::DeclineFabricatedSecret,
        Self::DeclineNeverMind,
        Self::DeclineOutOfScope,
        Self::DeclineSealedEgress,
        Self::DeclineUnboundedDestruction,
        Self::Found,
        Self::FoundSome,
        Self::Highest,
        Self::Lowest,
        Self::Nothing,
        Self::Total,
        Self::Proposed,
        Self::Applied,
        Self::Stale,
        Self::NotDone,
        Self::NothingWaiting,
        Self::StepAddTo,
        Self::StepCancel,
        Self::StepComplete,
        Self::StepCreate,
        Self::StepDelete,
        Self::StepDetail,
        Self::StepEdit,
        Self::StepField,
        Self::StepFieldCleared,
        Self::StepFieldNew,
        Self::StepLog,
        Self::StepRemoveFrom,
        Self::StepReopen,
        Self::StepReschedule,
        Self::StepRestore,
        Self::StepSettleDebt,
        Self::StepSettleUp,
        Self::StepStar,
        Self::StepUndo,
        Self::StepUnstar,
    ];

    /// The key in `copy/chat.json`.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Balance => "SAID_BALANCE",
            Self::BalanceEven => "SAID_BALANCE_EVEN",
            Self::BalanceOwed => "SAID_BALANCE_OWED",
            Self::BalanceOwing => "SAID_BALANCE_OWING",
            Self::Cap => "SAID_CAP",
            Self::Count => "SAID_COUNT",
            Self::DeclineFabricatedSecret => "SAID_DECLINE_FABRICATED_SECRET",
            Self::DeclineNeverMind => "SAID_DECLINE_NEVER_MIND",
            Self::DeclineOutOfScope => "SAID_DECLINE_OUT_OF_SCOPE",
            Self::DeclineSealedEgress => "SAID_DECLINE_SEALED_EGRESS",
            Self::DeclineUnboundedDestruction => "SAID_DECLINE_UNBOUNDED_DESTRUCTION",
            Self::Found => "SAID_FOUND",
            Self::FoundSome => "SAID_FOUND_SOME",
            Self::Highest => "SAID_HIGHEST",
            Self::Lowest => "SAID_LOWEST",
            Self::Nothing => "SAID_NOTHING",
            Self::Total => "SAID_TOTAL",
            Self::Proposed => "SAID_PROPOSED",
            Self::Applied => "SAID_APPLIED",
            Self::Stale => "SAID_STALE",
            Self::NotDone => "SAID_NOT_DONE",
            Self::NothingWaiting => "SAID_NOTHING_WAITING",
            Self::StepAddTo => "SAID_STEP_ADD_TO",
            Self::StepCancel => "SAID_STEP_CANCEL",
            Self::StepComplete => "SAID_STEP_COMPLETE",
            Self::StepCreate => "SAID_STEP_CREATE",
            Self::StepDelete => "SAID_STEP_DELETE",
            Self::StepDetail => "SAID_STEP_DETAIL",
            Self::StepEdit => "SAID_STEP_EDIT",
            Self::StepField => "SAID_STEP_FIELD",
            Self::StepFieldCleared => "SAID_STEP_FIELD_CLEARED",
            Self::StepFieldNew => "SAID_STEP_FIELD_NEW",
            Self::StepLog => "SAID_STEP_LOG",
            Self::StepRemoveFrom => "SAID_STEP_REMOVE_FROM",
            Self::StepReopen => "SAID_STEP_REOPEN",
            Self::StepReschedule => "SAID_STEP_RESCHEDULE",
            Self::StepRestore => "SAID_STEP_RESTORE",
            Self::StepSettleDebt => "SAID_STEP_SETTLE_DEBT",
            Self::StepSettleUp => "SAID_STEP_SETTLE_UP",
            Self::StepStar => "SAID_STEP_STAR",
            Self::StepUndo => "SAID_STEP_UNDO",
            Self::StepUnstar => "SAID_STEP_UNSTAR",
        }
    }

    /// The sentence a decline reason is said as. `not_found` is `Nothing`; a reason the runtime
    /// does not list is the general one.
    #[must_use]
    pub fn of_decline(reason: &str) -> Self {
        match reason {
            "unbounded_destruction" => Self::DeclineUnboundedDestruction,
            "sealed_egress" => Self::DeclineSealedEgress,
            "fabricated_secret" => Self::DeclineFabricatedSecret,
            "never_mind" => Self::DeclineNeverMind,
            "not_found" => Self::Nothing,
            _ => Self::DeclineOutOfScope,
        }
    }
}

fn copy() -> &'static BTreeMap<String, String> {
    static COPY: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    COPY.get_or_init(|| {
        let parsed: serde_json::Value = serde_json::from_str(CHAT_COPY).unwrap_or_default();
        parsed
            .get("strings")
            .and_then(serde_json::Value::as_object)
            .map(|strings| {
                strings
                    .iter()
                    .filter_map(|(key, text)| Some((key.clone(), text.as_str()?.to_owned())))
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// A sentence with no placeholder to fill. An absent key reads as the key itself, which a test
/// catches and a member never meets.
#[must_use]
pub fn say(which: Say) -> String {
    copy()
        .get(which.key())
        .cloned()
        .unwrap_or_else(|| which.key().to_owned())
}

/// A sentence with its `{placeholders}` filled.
#[must_use]
pub fn say_with(which: Say, fills: &[(&str, &str)]) -> String {
    let mut text = say(which);
    for (name, value) in fills {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sentence_is_in_the_copy_file_and_none_is_empty() {
        for which in Say::ALL {
            let text = copy()
                .get(which.key())
                .unwrap_or_else(|| panic!("{} is not in copy/chat.json", which.key()));
            assert!(!text.is_empty(), "{}", which.key());
        }
    }

    #[test]
    fn every_said_key_of_the_file_is_a_sentence_here() {
        let known: Vec<&str> = Say::ALL.iter().map(|which| which.key()).collect();
        for key in copy().keys().filter(|key| key.starts_with("SAID_")) {
            assert!(known.contains(&key.as_str()), "{key} has no `Say`");
        }
    }

    #[test]
    fn placeholders_are_the_names_the_fill_points_use() {
        let fills = [
            (Say::Balance, vec!["value"]),
            (Say::BalanceEven, vec!["name"]),
            (Say::BalanceOwed, vec!["name", "value"]),
            (Say::BalanceOwing, vec!["name", "value"]),
            (Say::Count, vec!["what"]),
            (Say::Found, vec!["what"]),
            (Say::FoundSome, vec!["what", "shown"]),
            (Say::Highest, vec!["field", "value"]),
            (Say::Lowest, vec!["field", "value"]),
            (Say::Total, vec!["field", "value"]),
            (Say::Proposed, vec!["what"]),
            (Say::NotDone, vec!["reason"]),
            (Say::StepAddTo, vec!["kind", "title", "container"]),
            (Say::StepCancel, vec!["kind", "title"]),
            (Say::StepComplete, vec!["kind", "title"]),
            (Say::StepCreate, vec!["kind", "title"]),
            (Say::StepDelete, vec!["kind", "title"]),
            (Say::StepDetail, vec!["step", "changes"]),
            (Say::StepEdit, vec!["kind", "title"]),
            (Say::StepField, vec!["field", "from", "to"]),
            (Say::StepFieldCleared, vec!["field"]),
            (Say::StepFieldNew, vec!["field", "to"]),
            (Say::StepLog, vec!["title"]),
            (Say::StepRemoveFrom, vec!["kind", "title", "container"]),
            (Say::StepReopen, vec!["kind", "title"]),
            (Say::StepReschedule, vec!["kind", "title"]),
            (Say::StepRestore, vec!["kind", "title"]),
            (Say::StepSettleDebt, vec!["kind", "title"]),
            (Say::StepSettleUp, vec!["title"]),
            (Say::StepStar, vec!["kind", "title"]),
            (Say::StepUndo, vec!["kind", "title"]),
            (Say::StepUnstar, vec!["kind", "title"]),
        ];
        for (which, names) in &fills {
            let filled: Vec<(&str, &str)> = names.iter().map(|name| (*name, "x")).collect();
            let text = say_with(*which, &filled);
            assert!(!text.contains('{'), "{}: {text}", which.key());
        }
        // a sentence with no entry above has nothing to fill
        for which in Say::ALL {
            if !fills.iter().any(|(filled, _)| *filled == which) {
                assert!(!say(which).contains('{'), "{}", which.key());
            }
        }
    }

    #[test]
    fn the_banned_words_are_not_in_them() {
        for which in Say::ALL {
            let text = say(which).to_lowercase();
            for banned in [
                "please",
                "successfully",
                "simply",
                "in order to",
                "you can",
                "sorry",
            ] {
                assert!(!text.contains(banned), "{}: {text}", which.key());
            }
        }
    }

    #[test]
    fn every_decline_reason_the_runtime_lists_has_a_sentence() {
        for reason in crate::native::meta::DECLINE_REASONS {
            let which = Say::of_decline(reason);
            assert!(!say(which).is_empty(), "{reason}");
            // only the general reason says the general sentence
            assert_eq!(
                which == Say::DeclineOutOfScope,
                *reason == "out_of_scope",
                "{reason}"
            );
        }
    }
}
