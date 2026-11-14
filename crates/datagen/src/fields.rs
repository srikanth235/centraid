//! FIELDS AS A BALANCED DIMENSION: which (kind, field) pairs `create` and `edit` can set through the tools, and which of
//! them the sampler can draw.
//!
//! The pairs come from the runtime's own tables (`meta::create_args`, `meta::edit_actions`, the kind's fields), never from
//! a list written here. Each is `Live` (the sampler draws a value for it and the runtime sets it), `NotLive` (with the
//! reason beside it; never faked) or left out (`date` is not edited: a date changes with `reschedule`). The label of a
//! pair is `create/task/priority`; the mix balances and reports them like cells.

use std::collections::BTreeMap;

use centraid_assist::native::meta::{self, FieldType, Kind};

use crate::catalog::Catalog;
use crate::grid::{Cell, Grid, Live};
use crate::intent::{Change, Intent, Target, TurnIntent};

/// The two tools whose fields are balanced.
pub const VERBS: [&str; 2] = ["create", "edit"];

/// Fields an `edit` handles as a command of its own, not as a column of the kind's edit (`plan_edit` in the runtime).
const SPECIAL_EDITS: &[(&str, &str)] = &[("task", "status"), ("note", "pinned"), ("list", "area")];

/// Fields that name a row by `#n`: a create that sets one needs a `find` ahead of it, which no draw makes.
const ROW_ARGS: &[(&str, &str)] = &[
    ("task", "list"),
    ("task", "parent"),
    ("note", "notebook"),
    ("document", "folder"),
];

/// The label of a pair.
#[must_use]
pub fn label(verb: &str, kind: &str, field: &str) -> String {
    format!("{verb}/{kind}/{field}")
}

/// `(verb, kind, field)` of a label made by [`label`].
#[must_use]
pub fn split(label: &str) -> Option<(&str, &str, &str)> {
    let (verb, rest) = label.split_once('/')?;
    let (kind, field) = rest.rsplit_once('/')?;
    Some((verb, kind, field))
}

/// Every pair `create` and `edit` can be asked to set, with its state.
#[must_use]
pub fn pairs(catalog: &Catalog, grid: &Grid) -> BTreeMap<String, Live> {
    let mut out = BTreeMap::new();
    for kind in &catalog.kinds {
        let Some(meta_kind) = Kind::parse(&kind.name) else {
            continue;
        };
        let spec = meta_kind.spec();
        let field_type = |name: &str| spec.field(name).map(|f| f.ty);
        // create
        let create_cell = grid.cells.get(&Cell::new("create", &kind.name, "create"));
        for field in meta::create_args(meta_kind) {
            let state = match create_cell {
                Some(Live::Live) => {
                    if ROW_ARGS.contains(&(kind.name.as_str(), field)) {
                        Live::NotLive(
                            "it names another row by `#n`; no draw puts a `find` ahead of the create".into(),
                        )
                    } else if kind.name == "workout" && matches!(field, "end" | "type") {
                        Live::NotLive(
                            "the runtime reads no `end` or `type` of a new workout, so nothing shows it was set".into(),
                        )
                    } else if !crate::sample::draws_field("create", &kind.name, field) {
                        Live::NotLive("the sampler draws no value for it".into())
                    } else {
                        Live::Live
                    }
                }
                Some(other) => other.clone(),
                None => Live::NotLive("the runtime has no `create` for this kind".into()),
            };
            out.insert(label("create", &kind.name, field), state);
        }
        // money fields are not create args: the runtime drops them (`opening` of an account), a transaction is not created
        // edit
        let edit_cell = grid.cells.get(&Cell::new("edit", &kind.name, "edit"));
        let mut edit_fields: Vec<&str> = Vec::new();
        for action in meta::edit_actions(meta_kind) {
            for name in action.chat_names() {
                if name != "date" && !edit_fields.contains(&name) {
                    edit_fields.push(name);
                }
            }
        }
        for (k, field) in SPECIAL_EDITS {
            if *k == kind.name && !edit_fields.contains(field) {
                edit_fields.push(field);
            }
        }
        for field in edit_fields {
            let state = match edit_cell {
                Some(Live::Live) => {
                    if matches!(field_type(field), Some(FieldType::Money | FieldType::Date)) {
                        Live::NotLive(format!("the runtime answers `{field} cannot be edited`"))
                    } else if kind.name == "daily figure" {
                        Live::NotLive(
                            "a followed Health store states every figure, so the runtime refuses the edit".into(),
                        )
                    } else if !crate::sample::draws_field("edit", &kind.name, field) {
                        Live::NotLive("the sampler draws no value for it".into())
                    } else {
                        Live::Live
                    }
                }
                Some(other) => other.clone(),
                None => Live::NotLive("the runtime has no `edit` for this kind".into()),
            };
            out.insert(label("edit", &kind.name, field), state);
        }
    }
    // a money amount is set by no tool: a transaction and a budget are not created in chat, the runtime drops the opening
    // balance of a new account and refuses to edit a money field, so these pairs are listed as the gap they are
    for kind in &catalog.kinds {
        for field in kind.fields.iter().filter(|f| f.ty == "money") {
            out.entry(label("create", &kind.name, &field.name))
                .or_insert_with(|| {
                    Live::NotLive(
                        "no create sets a money field: the runtime drops it (`create_arg_dropped`) or creates no such kind"
                            .into(),
                    )
                });
            out.entry(label("edit", &kind.name, &field.name))
                .or_insert_with(|| {
                    Live::NotLive(format!(
                        "the runtime answers `{} cannot be edited`",
                        field.name
                    ))
                });
        }
    }
    out
}

/// The live pairs of one tool and kind, by field name.
#[must_use]
pub fn live_fields(catalog: &Catalog, grid: &Grid, verb: &str, kind: &str) -> Vec<String> {
    pairs(catalog, grid)
        .into_iter()
        .filter(|(_, state)| *state == Live::Live)
        .filter_map(|(l, _)| {
            let (v, k, f) = split(&l)?;
            (v == verb && k == kind).then(|| f.to_owned())
        })
        .collect()
}

/// The live labels, for the mix.
#[must_use]
pub fn live_labels(catalog: &Catalog, grid: &Grid) -> Vec<String> {
    pairs(catalog, grid)
        .into_iter()
        .filter(|(_, state)| *state == Live::Live)
        .map(|(l, _)| l)
        .collect()
}

/// The pair of a field as the runtime names it: `due` of a task and `start` of an event are its `date`.
fn canonical(verb: &str, kind: &str, field: &str) -> String {
    let named = Kind::parse(kind)
        .filter(|_| verb == "create")
        .and_then(|k| meta::create_arg_canonical(k, field))
        .unwrap_or(field);
    label(verb, kind, named)
}

fn changes_of(changes: &[Change], verb: &str, kind: &str) -> Vec<String> {
    changes
        .iter()
        .map(|c| canonical(verb, kind, &c.field))
        .collect()
}

/// The pairs a turn sets: every field a `create` carries, every field an `edit` changes. An edit the runtime refused (a
/// followed store states the row) sets nothing and carries none.
#[must_use]
pub fn of_turn(turn: &TurnIntent) -> Vec<String> {
    of_intent(&turn.intent, turn.outcome)
}

fn of_intent(intent: &Intent, outcome: crate::intent::Outcome) -> Vec<String> {
    match intent {
        Intent::Both { first, second } => {
            let mut out = of_intent(first, outcome);
            out.extend(of_intent(second, outcome));
            out
        }
        Intent::Create { kind, fields } => changes_of(fields, "create", kind),
        Intent::Edit { target, changes } if outcome != crate::intent::Outcome::Decline => {
            let kind = match target {
                Target::Name { kind, .. } | Target::Turn { kind, .. } => kind.as_str(),
                Target::Select { sel } => sel.kind.as_str(),
            };
            changes_of(changes, "edit", kind)
        }
        _ => Vec::new(),
    }
}
