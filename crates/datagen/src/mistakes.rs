//! The mistakes a repair turn makes: calls the runtime refuses, built from what the runtime itself refuses.
//!
//! A repair turn shows a bad call, the runtime's real refusal as the observation, and the reference call as the repair.
//! The families below mirror the refusal families of `contracts/assist/export/errors.json` and the nativetools error
//! catalogue: a field the kind does not have, a value outside a fixed list, a date filter on a kind with no date, an unknown verb, a missing argument, a kind that does not exist, a row that was never shown. Each is built from the
//! catalogue (the kind's own fields, values and verbs) so it is a mistake a model could make on that kind; none is a
//! made-up string that no model would write.
//!
//! The runtime decides: the planner runs the call and demands that it is refused (`Step.bad`). A call the runtime
//! accepts ends the turn as a drop, so a family that stops being refused shows in the drop count instead of in the data.
//! The tests run every family against a real vault.
//!
//! `--mistakes <file>` adds refused calls from a model's own rollouts ([`observed`]); those replace a constructed
//! mistake of the same tool when there is one. Only read calls are taken from rollouts: a rejected read changes nothing,
//! while a write the runtime accepted would change the vault.

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::catalog::{Catalog, Field, Kind};

/// A call the runtime is expected to refuse, and the family it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mistake {
    /// The family, as the tag `mistake:<family>` says it.
    pub family: &'static str,
    pub tool: &'static str,
    pub args: Vec<(&'static str, String)>,
}

/// The families, for the report and the tests that count them.
pub const FAMILIES: [&str; 11] = [
    "wrong_field_for_kind",
    "unknown_list_value",
    "no_date_on_kind",
    "unknown_kind",
    "bad_order_field",
    "limit_not_a_number",
    "unknown_verb",
    "missing_argument",
    "empty_edit",
    "create_takes_no_rows",
    "row_not_shown",
];

/// Kinds an `edit` ends on a decline instead of an error: the runtime says the edit does not apply (a category, a
/// budget) or that Health keeps the row (a daily figure, a workout). A bad edit there is a decline turn, not a repair.
/// The same holds for a verb the kind lacks (`reschedule` on a document): the runtime ends that turn with its
/// `does_not_apply` decline, so it is taught as a decline and no repair is built from it.
const NO_EDIT: [&str; 4] = ["category", "budget", "daily figure", "workout"];

/// A value no fixed list holds.
const NOT_A_VALUE: &str = "zz_not_a_value";

fn other_field<'c>(catalog: &'c Catalog, kind: &Kind) -> Option<&'c Field> {
    catalog
        .kinds
        .iter()
        .filter(|k| k.name != kind.name)
        .flat_map(|k| &k.fields)
        .find(|f| f.name != "name" && !kind.fields.iter().any(|own| own.name == f.name))
}

fn list_field(kind: &Kind) -> Option<&Field> {
    kind.fields.iter().find(|f| !f.values.is_empty())
}

/// Mistakes a read can make on `kind`; `computes` when the turn computes a figure rather than finds rows.
#[must_use]
pub fn for_read(catalog: &Catalog, kind: &str, computes: bool) -> Vec<Mistake> {
    let Some(k) = catalog.kind(kind) else {
        return Vec::new();
    };
    let tool: &'static str = if computes { "compute" } else { "find" };
    let base = |kind: &str, extra: Vec<(&'static str, String)>| {
        let mut args = vec![("kind", kind.to_owned())];
        if computes {
            args.push(("op", "count".to_owned()));
        }
        args.extend(extra);
        args
    };
    let mut out = Vec::new();
    if let Some(f) = other_field(catalog, k) {
        out.push(Mistake {
            family: "wrong_field_for_kind",
            tool,
            args: base(kind, vec![("where", format!("{} = x", f.name))]),
        });
    }
    if let Some(f) = list_field(k) {
        out.push(Mistake {
            family: "unknown_list_value",
            tool,
            args: base(kind, vec![("where", format!("{} = {NOT_A_VALUE}", f.name))]),
        });
    }
    if k.date.is_none() {
        out.push(Mistake {
            family: "no_date_on_kind",
            tool,
            args: base(kind, vec![("when", "this month".to_owned())]),
        });
    }
    out.push(Mistake {
        family: "unknown_kind",
        tool,
        args: base("gadget", Vec::new()),
    });
    if !computes {
        out.push(Mistake {
            family: "bad_order_field",
            tool,
            args: base(kind, vec![("order", "zz_nothing asc".to_owned())]),
        });
        out.push(Mistake {
            family: "limit_not_a_number",
            tool,
            args: base(kind, vec![("limit", "all of them".to_owned())]),
        });
    }
    out
}

/// Mistakes a write can make: `tool` is the reference call's tool (`do`, `edit` or `create`), `args` its arguments.
#[must_use]
pub fn for_write(
    catalog: &Catalog,
    kind: &str,
    tool: &str,
    args: &[(&'static str, String)],
) -> Vec<Mistake> {
    let Some(k) = catalog.kind(kind) else {
        return Vec::new();
    };
    let rows = args
        .iter()
        .find(|(n, _)| *n == "rows")
        .map(|(_, v)| v.clone());
    let mut out = Vec::new();
    match tool {
        "do" => {
            let Some(rows) = rows else {
                return out;
            };
            let verb = args
                .iter()
                .find(|(n, _)| *n == "verb")
                .map_or("", |(_, v)| v.as_str());
            if verb == "undo" {
                return out;
            }
            out.push(Mistake {
                family: "unknown_verb",
                tool: "do",
                args: vec![("verb", "frobnicate".to_owned()), ("rows", rows.clone())],
            });
            if args.iter().any(|(n, _)| *n == "args") {
                out.push(Mistake {
                    family: "missing_argument",
                    tool: "do",
                    args: vec![("verb", verb.to_owned()), ("rows", rows)],
                });
            }
        }
        "edit" => {
            let Some(rows) = rows else {
                return out;
            };
            if NO_EDIT.contains(&kind) {
                return out;
            }
            if let Some(f) = other_field(catalog, k) {
                out.push(Mistake {
                    family: "wrong_field_for_kind",
                    tool: "edit",
                    args: vec![("rows", rows.clone()), ("args", format!("{}: x", f.name))],
                });
            }
            if let Some(f) = list_field(k) {
                out.push(Mistake {
                    family: "unknown_list_value",
                    tool: "edit",
                    args: vec![
                        ("rows", rows.clone()),
                        ("args", format!("{}: {NOT_A_VALUE}", f.name)),
                    ],
                });
            }
            out.push(Mistake {
                family: "empty_edit",
                tool: "edit",
                args: vec![("rows", rows), ("args", String::new())],
            });
        }
        "create" => {
            out.push(Mistake {
                family: "unknown_kind",
                tool: "create",
                args: vec![
                    ("kind", "gadget".to_owned()),
                    ("args", "name: Sample".to_owned()),
                ],
            });
            out.push(Mistake {
                family: "create_takes_no_rows",
                tool: "create",
                args: vec![
                    ("kind", kind.to_owned()),
                    ("rows", "#1".to_owned()),
                    ("args", "name: Sample".to_owned()),
                ],
            });
        }
        _ => {}
    }
    // a row that was never shown: any act the reference makes on rows
    if matches!(tool, "do" | "edit") {
        out.push(Mistake {
            family: "row_not_shown",
            tool: if tool == "edit" { "edit" } else { "do" },
            args: if tool == "edit" {
                vec![
                    ("rows", "#9999".to_owned()),
                    ("args", "name: Sample".to_owned()),
                ]
            } else {
                vec![
                    ("verb", "complete".to_owned()),
                    ("rows", "#9999".to_owned()),
                ]
            },
        });
    }
    out
}

/// One mistake out of `list`, chosen by `seed` (the same seed always gives the same one).
#[must_use]
pub fn pick<'m>(list: &'m [Mistake], seed: &str) -> Option<&'m Mistake> {
    if list.is_empty() {
        return None;
    }
    let h = blake3::hash(seed.as_bytes());
    let mut n = [0_u8; 8];
    n.copy_from_slice(&h.as_bytes()[..8]);
    list.get(usize::try_from(u64::from_le_bytes(n) % list.len() as u64).ok()?)
}

/// A call a model made and the runtime refused, from a rollout record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub tool: &'static str,
    pub args: Vec<(&'static str, String)>,
}

/// The argument names a read call carries. A name outside this list cannot be spelled as a reference call, so the call
/// is left out (and counted in [`Loaded::unspellable`]).
const ARG_NAMES: [&str; 11] = [
    "kind",
    "name",
    "where",
    "when",
    "order",
    "limit",
    "linked_to",
    "within",
    "rows",
    "op",
    "field",
];

/// What `--mistakes` read.
#[derive(Debug, Clone, Default)]
pub struct Loaded {
    pub calls: Vec<Observed>,
    /// Rollout turns the runtime refused at least one step of.
    pub refused_turns: usize,
    /// Calls left out: not a read, or an argument that cannot be spelled.
    pub unspellable: usize,
}

/// Read refused read calls from rollout results (`*.rollouts.jsonl`, one session per line): the calls of every turn
/// whose `error_steps` is not zero.
///
/// # Errors
/// When the file cannot be read or a line is not a rollout session.
pub fn observed(path: &Path) -> Result<Loaded> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let mut out = Loaded::default();
    for (i, line) in text.lines().enumerate().filter(|(_, l)| !l.is_empty()) {
        let session: Value = serde_json::from_str(line)
            .with_context(|| format!("{}: line {} is not json", path.display(), i + 1))?;
        for turn in session["turns"].as_array().into_iter().flatten() {
            if turn["error_steps"].as_u64().unwrap_or(0) == 0 {
                continue;
            }
            out.refused_turns += 1;
            for call in turn["calls"].as_array().into_iter().flatten() {
                match spell(call) {
                    Some(o) => {
                        if !out.calls.contains(&o) {
                            out.calls.push(o);
                        }
                    }
                    None => out.unspellable += 1,
                }
            }
        }
    }
    Ok(out)
}

fn spell(call: &Value) -> Option<Observed> {
    let tool: &'static str = match call["tool"].as_str()? {
        "find" => "find",
        "compute" => "compute",
        _ => return None,
    };
    let mut args = Vec::new();
    for (name, value) in call["args"].as_object()? {
        let name = ARG_NAMES.iter().find(|n| **n == name)?;
        args.push((*name, value.as_str()?.to_owned()));
    }
    Some(Observed { tool, args })
}

impl From<Observed> for Mistake {
    fn from(o: Observed) -> Self {
        Self {
            family: "observed",
            tool: o.tool,
            args: o.args,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rollouts_refused_calls_are_read_and_the_unspellable_counted() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("r.rollouts.jsonl");
        let line = serde_json::json!({
            "turns": [
                {"error_steps": 1, "calls": [
                    {"tool": "find", "args": {"kind": "task", "where": "colour = red"}},
                    {"tool": "do", "args": {"verb": "complete", "rows": "#1"}},
                    {"tool": "find", "args": {"kind": "task", "frobnicate": "1"}},
                ]},
                {"error_steps": 0, "calls": [{"tool": "find", "args": {"kind": "note"}}]},
            ]
        });
        std::fs::write(&path, format!("{line}\n")).expect("write");
        let loaded = observed(&path).expect("reads");
        assert_eq!(loaded.refused_turns, 1);
        assert_eq!(loaded.calls.len(), 1);
        assert_eq!(loaded.calls[0].tool, "find");
        assert_eq!(loaded.unspellable, 2);
    }

    #[test]
    fn a_pick_is_a_function_of_the_seed() {
        let list: Vec<Mistake> = FAMILIES
            .iter()
            .map(|f| Mistake {
                family: f,
                tool: "find",
                args: Vec::new(),
            })
            .collect();
        assert_eq!(pick(&list, "a"), pick(&list, "a"));
        let seen: std::collections::BTreeSet<&str> = (0..200)
            .filter_map(|i| pick(&list, &format!("seed{i}")))
            .map(|m| m.family)
            .collect();
        assert!(seen.len() > 8, "{seen:?}");
        assert!(pick(&[], "a").is_none());
    }
}
