//! THE COVERAGE GRID (#1166): what the sampler draws from and what the report counts.
//!
//! The full cross product of the issue's eight axes is tens of thousands of cells, and many are
//! meaningless (a `decline` with four constraints, a pronoun with nothing before it), so "every
//! cell has a solvable intent" would be either false or vacuous against it. The grid is therefore
//! two things:
//!
//! * **Primary cells**: (tool, app/kind, verb or op), derived from the catalog. Each is `Live`
//!   (the sampler can draw it and the runtime can serve it), `NotLive` (the runtime or the world
//!   cannot serve it yet; never faked) or `Invalid` (structurally meaningless, left out of every
//!   denominator). The coverage claim is made for `Live` primary cells.
//! * **The other axes**, as marginals counted over every solved turn: constraints (0, 1, 2, 3,
//!   4+), reference, outcome, span and turns; plus declared pairs (outcome x tool, reference x
//!   tool, constraints x app, span x turns) so the places where two axes interact are watched
//!   instead of hoped for. Minimal pairs are not a corpus: they are two draws of one cell that
//!   differ in one argument, tagged by the sampler.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::catalog::Catalog;
use crate::intent::{Intent, Target, TurnIntent};

/// (tool, kind, verb or op). `kind` is `-` for a cell no kind decides (`decline`, `undo`, a
/// recall).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Cell {
    pub tool: String,
    pub kind: String,
    pub verb: String,
}

impl Cell {
    #[must_use]
    pub fn new(tool: &str, kind: &str, verb: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            kind: kind.to_owned(),
            verb: verb.to_owned(),
        }
    }
}

impl fmt::Display for Cell {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}/{}", self.tool, self.kind, self.verb)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "why", rename_all = "snake_case")]
pub enum Live {
    Live,
    NotLive(String),
    Invalid(String),
}

/// Constraint buckets of the eval report (`assist_eval::args::bucket`).
pub const CONSTRAINTS: [&str; 5] = ["0", "1", "2", "3", "4+"];

/// The cell a turn is drawn from.
#[must_use]
pub fn cell_of(turn: &TurnIntent) -> Cell {
    match &turn.intent {
        Intent::Read { sel } => Cell::new("find", &sel.kind, "read"),
        Intent::Count { sel } => Cell::new("compute", &sel.kind, "count"),
        Intent::Measure { measure } => Cell::new(
            "compute",
            &measure.sel.kind,
            if measure.group.is_some() {
                "group"
            } else {
                &measure.op
            },
        ),
        Intent::Compare { a, .. } => Cell::new("compute", &a.sel.kind, "compare"),
        Intent::Write { target, verb, .. } => {
            let kind = match target {
                Target::Name { kind, .. } => kind.as_str(),
                Target::Select { sel } => sel.kind.as_str(),
                Target::Turn { kind, .. } => kind.as_str(),
            };
            Cell::new("do", if verb == "undo" { "-" } else { kind }, verb)
        }
        Intent::Edit { target, .. } => Cell::new("edit", target_kind(target), "edit"),
        Intent::Create { kind, .. } => Cell::new("create", kind, "create"),
        Intent::Recall { value, .. } => {
            Cell::new("answer", "-", if *value { "value" } else { "rows" })
        }
        Intent::Ask { kind, .. } => Cell::new("ask", kind, "ask"),
        Intent::Decline { reason } => Cell::new("decline", "-", reason),
    }
}

fn target_kind(target: &Target) -> &str {
    match target {
        Target::Name { kind, .. } => kind,
        Target::Select { sel } => &sel.kind,
        Target::Turn { kind, .. } => kind,
    }
}

/// Number fields a `compute` can fold, per kind, as the sampler reads them off a world.
#[must_use]
pub fn measurable(kind: &str) -> &'static [&'static str] {
    match kind {
        "person" => &["cadence"],
        "event" => &["duration"],
        "task" => &["effort", "priority"],
        "transaction" => &["amount"],
        "workout" => &["moving", "distance", "energy", "heart_rate", "climb"],
        "daily figure" => &["value"],
        "budget" => &["amount"],
        _ => &[],
    }
}

/// The `do` verbs the sampler can draw, with the kinds each is drawn on; a catalog pair outside
/// this table is `NotLive` with the reason beside it.
fn do_support(kind: &str, verb: &str) -> Result<(), &'static str> {
    match (verb, kind) {
        ("reveal", _) => Err(
            "reveal opens a sealed value; a world carries only a placeholder, and a placeholder must not reach a prompt",
        ),
        ("tag" | "untag", _) => Err(
            "a tag is a label row; no world seeds one and `tag` of an unknown label changes nothing",
        ),
        ("unarchive", _) => Err("no world seeds an archived row to bring back"),
        ("unlink", "transaction") => Ok(()),
        ("archive", _) => Err(
            "archiving changes no field the diff can show (`no field changed`), so a gold effect would be empty",
        ),
        ("star" | "unstar", "person" | "note" | "document" | "photo" | "locker item") => Ok(()),
        ("reschedule", "event" | "task") => Ok(()),
        ("cancel", "event" | "task") => Ok(()),
        ("complete" | "reopen", "task") => Ok(()),
        ("restore", "album") => {
            Err("no world puts an album in the trash, so there is nothing to restore")
        }
        (
            "delete" | "restore",
            "person" | "event" | "task" | "note" | "document" | "photo" | "locker item",
        ) => Ok(()),
        ("delete", "album") => Ok(()),
        ("delete", "notebook" | "folder") => Ok(()),
        ("add_to" | "remove_from", "task" | "note" | "document" | "photo") => Ok(()),
        ("log", "person") => Ok(()),
        _ => Err("the sampler draws no such pair yet"),
    }
}

/// Kinds a name can be shared by, for `ask`.
const ASKABLE: &[&str] = &[
    "person",
    "event",
    "task",
    "note",
    "document",
    "photo",
    "transaction",
    "locker item",
];

#[derive(Debug, Clone, Serialize)]
pub struct Grid {
    pub cells: BTreeMap<Cell, Live>,
}

impl Grid {
    /// The primary cells of `catalog`, each with its state.
    #[must_use]
    pub fn build(catalog: &Catalog) -> Self {
        let mut cells = BTreeMap::new();
        let live = |name: &str| catalog.tools.iter().any(|t| t.name == name && t.live);
        let op_live = |name: &str| catalog.ops.iter().any(|o| o.name == name && o.live);
        let unnameable = |kind: &str| matches!(kind, "daily figure" | "budget");
        for kind in &catalog.kinds {
            let k = kind.name.as_str();
            // find
            cells.insert(
                Cell::new("find", k, "read"),
                if !live("find") {
                    Live::NotLive("the runtime has no `find`".into())
                } else if unnameable(k) {
                    Live::NotLive("the seed document keys no daily figure or budget, so an eval cannot name the rows an answer shows".into())
                } else {
                    Live::Live
                },
            );
            // compute
            cells.insert(
                Cell::new("compute", k, "count"),
                if live("compute") {
                    Live::Live
                } else {
                    Live::NotLive("no `compute`".into())
                },
            );
            let fields = measurable(k);
            for op in ["sum", "avg", "min", "max"] {
                let state = if fields.is_empty() {
                    if kind
                        .fields
                        .iter()
                        .any(|f| f.ty == "number" || f.ty == "money")
                    {
                        Live::NotLive("the world document does not carry that number field".into())
                    } else {
                        Live::Invalid("the kind has no number field".into())
                    }
                } else if !op_live(op) {
                    Live::NotLive(format!("the runtime has no `{op}`"))
                } else {
                    Live::Live
                };
                cells.insert(Cell::new("compute", k, op), state);
            }
            let groupable = !fields.is_empty();
            cells.insert(
                Cell::new("compute", k, "group"),
                if !groupable {
                    Live::Invalid("nothing to fold".into())
                } else if op_live("group") {
                    Live::Live
                } else {
                    Live::NotLive("the runtime has no `group`".into())
                },
            );
            let compare = matches!(k, "transaction" | "workout" | "daily figure");
            cells.insert(
                Cell::new("compute", k, "compare"),
                if !compare {
                    Live::Invalid("only money and health figures are set side by side".into())
                } else if op_live("compare") {
                    Live::Live
                } else {
                    Live::NotLive(
                        "the runtime has no `compare` op yet (the tool regroup has not landed it)"
                            .into(),
                    )
                },
            );
            // create / edit
            let has = |verb: &str| kind.verbs.iter().any(|v| v == verb);
            cells.insert(
                Cell::new("create", k, "create"),
                if matches!(k, "workout" | "daily figure") {
                    Live::NotLive("workouts and daily figures are read-only in chat".into())
                } else if has("create") && live("create") {
                    Live::Live
                } else {
                    Live::NotLive("the runtime has no `create` for this kind".into())
                },
            );
            cells.insert(
                Cell::new("edit", k, "edit"),
                if k == "rule" {
                    Live::NotLive("the runtime answers `edit does not apply to rule`".into())
                } else if has("edit") && live("edit") {
                    Live::Live
                } else if matches!(k, "workout" | "daily figure" | "budget") {
                    Live::NotLive("read-only in chat".into())
                } else {
                    Live::NotLive("the runtime has no `edit` for this kind".into())
                },
            );
            // do
            for verb in &kind.verbs {
                if verb == "create" || verb == "edit" {
                    continue;
                }
                let state = match do_support(k, verb) {
                    _ if !live("do") => Live::NotLive("no `do`".into()),
                    Ok(()) => Live::Live,
                    Err(why) => Live::NotLive(why.into()),
                };
                cells.insert(Cell::new("do", k, verb), state);
            }
            // ask
            if ASKABLE.contains(&k) {
                cells.insert(Cell::new("ask", k, "ask"), Live::Live);
            }
        }
        cells.insert(Cell::new("do", "-", "undo"), Live::Live);
        cells.insert(Cell::new("answer", "-", "rows"), Live::Live);
        cells.insert(Cell::new("answer", "-", "value"), Live::Live);
        for reason in [
            "out_of_scope",
            "unbounded_destruction",
            "fabricated_secret",
            "not_found",
        ] {
            cells.insert(Cell::new("decline", "-", reason), Live::Live);
        }
        cells.insert(
            Cell::new("decline", "-", "never_mind"),
            Live::NotLive(
                "the runtime ends the turn from the user's own words, and the placeholder has none"
                    .into(),
            ),
        );
        Self { cells }
    }

    #[must_use]
    pub fn live(&self) -> Vec<&Cell> {
        self.cells
            .iter()
            .filter(|(_, s)| **s == Live::Live)
            .map(|(c, _)| c)
            .collect()
    }

    #[must_use]
    pub fn not_live(&self) -> Vec<(&Cell, &str)> {
        self.cells
            .iter()
            .filter_map(|(c, s)| match s {
                Live::NotLive(why) => Some((c, why.as_str())),
                _ => None,
            })
            .collect()
    }

    /// `(live, not_live, invalid)`.
    #[must_use]
    pub fn counts(&self) -> (usize, usize, usize) {
        let mut n = (0, 0, 0);
        for state in self.cells.values() {
            match state {
                Live::Live => n.0 += 1,
                Live::NotLive(_) => n.1 += 1,
                Live::Invalid(_) => n.2 += 1,
            }
        }
        n
    }

    #[must_use]
    pub fn is_live(&self, cell: &Cell) -> bool {
        self.cells.get(cell) == Some(&Live::Live)
    }
}

/// `do_support` for the sampler: may it draw `verb` on `kind`?
#[must_use]
pub fn draws(kind: &str, verb: &str) -> bool {
    do_support(kind, verb).is_ok()
}
