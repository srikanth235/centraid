//! What a typed turn is, for the mix and the report: the words of the shares (outcome, action, row reference), the kinds it
//! touches, whether it asks for what the vault cannot do, and the combinations the split by combination reserves.
//!
//! Everything here reads the typed [`TurnIntent`]; nothing reads text.

use std::collections::BTreeSet;

use crate::intent::{Intent, Outcome, Reference, Selector, Target, TurnIntent, VerbArg};

/// Decline reasons that ask for what the vault cannot do (the runtime's decline outcome). `not_found` is a lookup of a
/// person who is not there, which the vault can answer.
pub const IMPOSSIBLE: [&str; 3] = ["out_of_scope", "unbounded_destruction", "fabricated_secret"];

/// The turn's outcome as the mix names it.
#[must_use]
pub fn outcome(turn: &TurnIntent) -> &'static str {
    turn.outcome.word()
}

/// `read` (read, count, measure, compare), `write` (create, edit, any other write) or `recall` (an earlier answer shown
/// again, an undo). A decline has no action, so it has none of these: `""`.
#[must_use]
pub fn action(turn: &TurnIntent) -> &'static str {
    match &turn.intent {
        Intent::Read { .. }
        | Intent::Count { .. }
        | Intent::Measure { .. }
        | Intent::Compare { .. } => "read",
        Intent::Create { .. } | Intent::Edit { .. } => "write",
        Intent::Write { verb, .. } if verb == "undo" => "recall",
        Intent::Write { .. } => "write",
        Intent::Recall { .. } => "recall",
        Intent::Ask { verb, .. } => {
            if verb.is_some() {
                "write"
            } else {
                "read"
            }
        }
        Intent::Decline { .. } => "",
    }
}

/// How the turn points at a row: `name`, `filters`, `pronoun` (a pronoun or an earlier answer) or `nickname` (a nickname or
/// a misspelling). A turn that points at no row (a count, a measure, a create, a decline) has none: `""`.
#[must_use]
pub fn reference(turn: &TurnIntent) -> &'static str {
    let points = match &turn.intent {
        Intent::Read { .. } | Intent::Recall { .. } | Intent::Ask { .. } => true,
        Intent::Write { verb, .. } => verb != "undo",
        Intent::Edit { .. } => true,
        Intent::Count { .. }
        | Intent::Measure { .. }
        | Intent::Compare { .. }
        | Intent::Create { .. }
        | Intent::Decline { .. } => false,
    };
    if !points {
        return "";
    }
    match turn.reference {
        Reference::Name => "name",
        Reference::Select => "filters",
        Reference::Pronoun | Reference::Handle => "pronoun",
        Reference::Nickname | Reference::Misspelling => "nickname",
    }
}

/// Does the turn ask for what the vault cannot do?
#[must_use]
pub fn impossible(turn: &TurnIntent) -> bool {
    matches!(&turn.intent, Intent::Decline { reason } if IMPOSSIBLE.contains(&reason.as_str()))
}

fn selector_kinds(sel: &Selector, out: &mut BTreeSet<String>) {
    out.insert(sel.kind.clone());
    out.extend(sel.also.iter().cloned());
    for link in [&sel.link, &sel.anchor].into_iter().flatten() {
        out.insert(link.kind.clone());
    }
}

fn target_kinds(target: &Target, out: &mut BTreeSet<String>) {
    match target {
        Target::Name { kind, .. } => {
            out.insert(kind.clone());
        }
        Target::Select { sel } => selector_kinds(sel, out),
        Target::Turn { .. } => {}
    }
}

/// The kinds the turn names: the kind it reads or changes and the kind of a row it is linked to or a period is read off.
#[must_use]
pub fn kinds(turn: &TurnIntent) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    match &turn.intent {
        Intent::Read { sel } | Intent::Count { sel } => selector_kinds(sel, &mut out),
        Intent::Measure { measure } => selector_kinds(&measure.sel, &mut out),
        Intent::Compare { a, b } => {
            selector_kinds(&a.sel, &mut out);
            selector_kinds(&b.sel, &mut out);
        }
        Intent::Write { target, arg, .. } => {
            target_kinds(target, &mut out);
            if let VerbArg::Container(link) = arg {
                out.insert(link.kind.clone());
            }
        }
        Intent::Edit { target, .. } => target_kinds(target, &mut out),
        Intent::Create { kind, .. } | Intent::Ask { kind, .. } => {
            out.insert(kind.clone());
        }
        Intent::Recall { .. } | Intent::Decline { .. } => {}
    }
    out.remove("-");
    out
}

/// A selector's constraints: its filters, its period, its link or the row its period is read off.
#[must_use]
pub fn constraints(sel: &Selector) -> usize {
    sel.filters.len()
        + usize::from(sel.period.is_some())
        + usize::from(sel.link.is_some())
        + usize::from(sel.anchor.is_some())
}

/// The (kind, field) pairs a turn sets, as `create/task/priority` (`fields::of_turn`): what the mix balances beside the
/// cells.
#[must_use]
pub fn fields(turn: &TurnIntent) -> Vec<String> {
    crate::fields::of_turn(turn)
}

/// The combinations a turn is an instance of: `kf:<kind>:<field>` for each field a selector filters on and
/// `kvn:<kind>:<verb or op>:<constraints>` for what it does with a selector. They are what a split by combination
/// reserves: a combination in test is one train and val never show.
#[must_use]
pub fn combos(turn: &TurnIntent) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut selector = |sel: &Selector, what: &str| {
        for f in &sel.filters {
            out.insert(format!("kf:{}:{}", sel.kind, f.field));
        }
        out.insert(format!("kvn:{}:{what}:{}", sel.kind, constraints(sel)));
    };
    match &turn.intent {
        Intent::Read { sel } => selector(sel, "read"),
        Intent::Count { sel } => selector(sel, "count"),
        Intent::Measure { measure } => selector(&measure.sel, &measure.op),
        Intent::Compare { a, b } => {
            selector(&a.sel, &a.op);
            selector(&b.sel, &b.op);
        }
        Intent::Write {
            target: Target::Select { sel },
            verb,
            ..
        } => selector(sel, verb),
        Intent::Edit {
            target: Target::Select { sel },
            ..
        } => selector(sel, "edit"),
        _ => {}
    }
    out
}

/// The outcome names, for the tests that count them.
#[must_use]
pub fn outcome_of(word: &str) -> Option<Outcome> {
    Outcome::ALL.into_iter().find(|o| o.word() == word)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{Cmp, Dep, Filter, Lit};

    fn turn(intent: Intent, reference: Reference, outcome: Outcome) -> TurnIntent {
        TurnIntent {
            intent,
            reference,
            outcome,
            dep: None::<(usize, Dep)>,
            apps: Vec::new(),
        }
    }

    #[test]
    fn a_turn_is_labelled_by_what_the_model_decides() {
        let mut sel = Selector::of("task");
        sel.filters.push(Filter {
            field: "status".into(),
            cmp: Cmp::Eq,
            value: Lit::Text("open".into()),
        });
        let read = turn(Intent::Read { sel }, Reference::Select, Outcome::Done);
        assert_eq!(action(&read), "read");
        assert_eq!(reference(&read), "filters");
        assert!(!impossible(&read));
        assert!(combos(&read).contains("kf:task:status"));
        assert!(combos(&read).contains("kvn:task:read:1"));
        let count = turn(
            Intent::Count {
                sel: Selector::of("task"),
            },
            Reference::Select,
            Outcome::Done,
        );
        assert_eq!(reference(&count), "", "a count points at no row");
        let decline = turn(
            Intent::Decline {
                reason: "out_of_scope".into(),
            },
            Reference::Select,
            Outcome::Decline,
        );
        assert!(impossible(&decline));
        assert_eq!(action(&decline), "");
        let missing = turn(
            Intent::Decline {
                reason: "not_found".into(),
            },
            Reference::Select,
            Outcome::Decline,
        );
        assert!(
            !impossible(&missing),
            "a person who is not there is a lookup"
        );
        let undo = turn(
            Intent::Write {
                target: Target::Turn {
                    turn: 0,
                    kind: "-".into(),
                },
                verb: "undo".into(),
                arg: VerbArg::None,
            },
            Reference::Pronoun,
            Outcome::Done,
        );
        assert_eq!(action(&undo), "recall");
        assert_eq!(reference(&undo), "");
        assert!(kinds(&undo).is_empty());
    }
}
