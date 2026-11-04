//! A TURN'S EFFECT, from the responses the runtime gave to the model's calls (`eval/lib.py` `turn_effect`,
//! `merge_diffs`, `effect_rows`). Computed from the runtime's own `effect` records, never from call text.

use std::collections::BTreeMap;

use serde_json::Value;

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Ending {
    Rows,
    Value,
    /// A write that did not also answer.
    Act,
    Ask,
    Decline,
    /// The runtime had nothing to say (no tool).
    None,
    /// The model never ended the turn within the step cap.
    Cap,
    /// The runtime's loop breaker ended it.
    Loop,
    Error,
}

impl Ending {
    #[must_use]
    pub fn word(self) -> &'static str {
        match self {
            Self::Rows => "rows",
            Self::Value => "value",
            Self::Act => "act",
            Self::Ask => "ask",
            Self::Decline => "decline",
            Self::None => "none",
            Self::Cap => "cap",
            Self::Loop => "loop",
            Self::Error => "error",
        }
    }
}

/// A row the turn changed, net of the steps (a field that ends where it started is gone).
#[derive(Debug, Clone, PartialEq)]
pub struct RowChange {
    pub id: String,
    pub kind: String,
    /// `created` | `removed` | `trashed` | `restored` | `updated`.
    pub change: String,
    /// Field → (old, new).
    pub fields: BTreeMap<String, (Value, Value)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkChange {
    /// `added` | `removed`.
    pub change: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NetDiff {
    pub rows: Vec<RowChange>,
    pub links: Vec<LinkChange>,
}

#[derive(Debug, Clone)]
pub struct Effect {
    pub diff: NetDiff,
    pub already: Vec<String>,
    pub revealed: Vec<String>,
    pub steps: usize,
    pub ending: Ending,
    /// `Rows`: the row ids the answer names, in order.
    pub rows: Vec<String>,
    /// `Value`: `{values: […]}` or `{groups: […]}` as the runtime gave it.
    pub value: Value,
    /// `Ask`: the option row ids.
    pub options: Vec<String>,
    /// `Decline`: the reason.
    pub reason: Option<String>,
}

impl Effect {
    /// What a turn with no step at all did: nothing.
    #[must_use]
    pub fn not_run() -> Self {
        turn_effect(&[])
    }
}

/// The tools that change the vault: S2's `act`, and the regrouped `create`, `edit` and `do`.
fn is_write(tool: &str) -> bool {
    matches!(tool, "act" | "create" | "edit" | "do")
}

/// Numbers compare as numbers (Python's `1 == 1.0`), everything else as values.
#[must_use]
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn text_of(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

fn ids_of(list: &Value) -> Vec<String> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect()
}

#[derive(Default)]
struct Pending {
    created: bool,
    removed: bool,
    kind: String,
    fields: Vec<(String, Value, Value)>,
}

/// The net vault change of a turn: fields that end where they started drop out; a link added and removed in the
/// same turn cancels.
#[must_use]
pub fn merge_diffs(diffs: &[&Value]) -> NetDiff {
    let mut order: Vec<String> = Vec::new();
    let mut rows: BTreeMap<String, Pending> = BTreeMap::new();
    for diff in diffs {
        for row in diff["rows"].as_array().into_iter().flatten() {
            let Some(id) = row["id"].as_str() else {
                continue;
            };
            if !rows.contains_key(id) {
                order.push(id.to_owned());
            }
            let cur = rows.entry(id.to_owned()).or_default();
            cur.kind = text_of(&row["kind"]);
            match row["change"].as_str() {
                Some("created") => cur.created = true,
                Some("removed") => cur.removed = true,
                _ => {}
            }
            for (field, pair) in row["fields"].as_object().into_iter().flatten() {
                let (old, new) = (pair[0].clone(), pair[1].clone());
                match cur.fields.iter_mut().find(|(name, _, _)| name == field) {
                    Some(held) => held.2 = new,
                    None => cur.fields.push((field.clone(), old, new)),
                }
            }
        }
    }
    let mut out = NetDiff::default();
    for id in order {
        let cur = &rows[&id];
        // a sealed field (locker notes) reports sealed -> sealed when it changed: keep it
        let fields: BTreeMap<String, (Value, Value)> = cur
            .fields
            .iter()
            .filter(|(_, old, new)| cur.created || !same(old, new) || new == "sealed")
            .map(|(name, old, new)| (name.clone(), (old.clone(), new.clone())))
            .collect();
        if cur.created && cur.removed {
            continue;
        }
        if fields.is_empty() && !cur.created && !cur.removed {
            continue;
        }
        let change = if cur.removed {
            "removed"
        } else if cur.created {
            "created"
        } else if let Some((_, new)) = fields.get("trashed") {
            if truthy(new) { "trashed" } else { "restored" }
        } else {
            "updated"
        };
        out.rows.push(RowChange {
            id,
            kind: cur.kind.clone(),
            change: change.to_owned(),
            fields,
        });
    }
    let mut order: Vec<(String, String)> = Vec::new();
    let mut net: BTreeMap<(String, String), i32> = BTreeMap::new();
    for diff in diffs {
        for link in diff["links"].as_array().into_iter().flatten() {
            let key = (text_of(&link["from"]["id"]), text_of(&link["to"]["id"]));
            if !net.contains_key(&key) {
                order.push(key.clone());
            }
            let step = if link["change"] == "added" { 1 } else { -1 };
            *net.entry(key).or_default() += step;
        }
    }
    for key in order {
        let count = net[&key];
        if count != 0 {
            out.links.push(LinkChange {
                change: if count > 0 { "added" } else { "removed" }.to_owned(),
                from: key.0,
                to: key.1,
            });
        }
    }
    out
}

/// Python truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// Summarise one turn from its runtime responses (each `{text, ends_turn, effect, …}`).
#[must_use]
pub fn turn_effect(steps: &[Value]) -> Effect {
    let mut diffs: Vec<&Value> = Vec::new();
    let mut already = Vec::new();
    let mut revealed = Vec::new();
    let mut final_response: Option<&Value> = None;
    for step in steps {
        let eff = &step["effect"];
        if is_write(eff["tool"].as_str().unwrap_or_default()) {
            if truthy(&eff["diff"]) {
                diffs.push(&eff["diff"]);
            }
            already.extend(ids_of(&eff["already"]));
            if truthy(&eff["revealed"]) {
                revealed.push(text_of(&eff["revealed"]));
            }
        }
        if step["ends_turn"].as_bool().unwrap_or(false) {
            final_response = Some(step);
            break;
        }
    }
    let mut out = Effect {
        diff: merge_diffs(&diffs),
        already,
        revealed,
        steps: steps.len(),
        ending: Ending::None,
        rows: Vec::new(),
        value: Value::Null,
        options: Vec::new(),
        reason: None,
    };
    let Some(response) = final_response else {
        out.ending = Ending::Cap; // the driver stopped without the runtime ending the turn
        return out;
    };
    let eff = &response["effect"];
    let tool = eff["tool"].as_str().unwrap_or_default();
    if truthy(&eff["loop"]) {
        out.ending = Ending::Loop;
    } else if truthy(&eff["cap"]) {
        out.ending = Ending::Cap;
    } else if (tool == "answer" || is_write(tool)) && eff.get("answer").is_some() {
        // an `act log` that ends the turn also answers the row it logged (rows + diff)
        out.ending = Ending::Rows;
        out.rows = ids_of(&eff["answer"]["rows"]);
    } else if tool == "answer" && eff.get("value").is_some() {
        out.ending = Ending::Value;
        out.value = eff["value"].clone();
    } else if tool == "ask" {
        out.ending = Ending::Ask;
        out.options = ids_of(&eff["ask"]["options"]);
    } else if tool == "decline" {
        out.ending = Ending::Decline;
        out.reason = eff["decline"]["reason"].as_str().map(str::to_owned);
    } else if is_write(tool) && eff.get("error").is_none() {
        out.ending = Ending::Act;
    } else if truthy(&eff["error"]) {
        out.ending = Ending::Error;
    }
    out
}

/// Every `{id, n}` an effect names: the runtime's `#n` for a row, which a reference call's `$key` becomes.
#[must_use]
pub fn effect_rows(effect: &Value) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut take = |list: &Value| {
        for row in list.as_array().into_iter().flatten() {
            if let (Some(id), Some(n)) = (row["id"].as_str(), row["n"].as_u64()) {
                out.push((id.to_owned(), n));
            }
        }
    };
    for key in ["rows", "created", "ambiguous", "already"] {
        take(&effect[key]);
    }
    take(&effect["answer"]["rows"]);
    take(&effect["ask"]["options"]);
    take(&effect["diff"]["rows"]);
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn act(diff: &Value) -> Value {
        json!({"ends_turn": false, "effect": {"tool": "act", "diff": diff}})
    }

    #[test]
    fn a_field_that_ends_where_it_started_leaves_the_diff() {
        let first = json!({"rows": [{"id": "a", "kind": "task", "change": "updated", "fields": {"status": ["open", "completed"]}}]});
        let back = json!({"rows": [{"id": "a", "kind": "task", "change": "updated", "fields": {"status": ["completed", "open"]}}]});
        let net = merge_diffs(&[&first, &back]);
        assert!(net.rows.is_empty());
        let net = merge_diffs(&[&first]);
        assert_eq!(net.rows[0].change, "updated");
    }

    #[test]
    fn a_trash_and_a_created_then_removed_row_read_as_the_runtime_meant() {
        let trash = json!({"rows": [{"id": "a", "kind": "task", "change": "updated", "fields": {"trashed": [false, true]}}]});
        assert_eq!(merge_diffs(&[&trash]).rows[0].change, "trashed");
        let made = json!({"rows": [{"id": "n", "kind": "task", "change": "created", "fields": {"name": [null, "x"]}}]});
        let gone =
            json!({"rows": [{"id": "n", "kind": "task", "change": "removed", "fields": {}}]});
        assert!(merge_diffs(&[&made, &gone]).rows.is_empty());
    }

    #[test]
    fn a_link_added_and_removed_in_one_turn_cancels() {
        let add = json!({"links": [{"change": "added", "from": {"id": "a"}, "to": {"id": "b"}}]});
        let del = json!({"links": [{"change": "removed", "from": {"id": "a"}, "to": {"id": "b"}}]});
        assert!(merge_diffs(&[&add, &del]).links.is_empty());
        assert_eq!(merge_diffs(&[&add]).links[0].change, "added");
    }

    #[test]
    fn a_turn_the_runtime_never_ended_is_a_cap_and_a_decline_reads_its_reason() {
        let step = act(&json!({"rows": []}));
        assert_eq!(turn_effect(&[step]).ending, Ending::Cap);
        let ended = json!({"ends_turn": true, "effect": {"tool": "decline", "decline": {"reason": "not_found"}}});
        let effect = turn_effect(&[ended]);
        assert_eq!(effect.ending, Ending::Decline);
        assert_eq!(effect.reason.as_deref(), Some("not_found"));
    }

    #[test]
    fn an_act_that_answers_ends_in_rows_with_its_diff_kept() {
        let write = json!({"ends_turn": true, "effect": {"tool": "act",
            "diff": {"rows": [{"id": "a", "kind": "task", "change": "updated", "fields": {"status": ["open", "completed"]}}]},
            "answer": {"rows": [{"id": "a", "n": 3}]}}});
        let effect = turn_effect(&[write]);
        assert_eq!(effect.ending, Ending::Rows);
        assert_eq!(effect.rows, vec!["a".to_owned()]);
        assert_eq!(effect.diff.rows.len(), 1);
    }

    #[test]
    fn the_regrouped_writes_are_writes_as_act_was() {
        for tool in ["do", "edit", "create"] {
            let write = json!({"ends_turn": true, "effect": {"tool": tool,
                "diff": {"rows": [{"id": "a", "kind": "task", "change": "updated", "fields": {"status": ["open", "completed"]}}]}}});
            let effect = turn_effect(&[write]);
            assert_eq!(effect.ending, Ending::Act, "{tool}");
            assert_eq!(effect.diff.rows.len(), 1, "{tool}");
        }
    }

    #[test]
    fn effect_rows_collects_every_numbered_row() {
        let effect = json!({"rows": [{"id": "a", "n": 1}], "answer": {"rows": [{"id": "b", "n": 2}]}, "ask": {"options": [{"id": "c", "n": 3}]}});
        let mut rows = effect_rows(&effect);
        rows.sort();
        assert_eq!(
            rows,
            vec![
                ("a".to_owned(), 1),
                ("b".to_owned(), 2),
                ("c".to_owned(), 3)
            ]
        );
    }
}
