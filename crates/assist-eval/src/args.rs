//! CONSTRAINTS AND ARGUMENTS: what a turn asks of the model, and how much of it the model got right.
//!
//! Two new measures (no `score.py` counterpart), both read off the turn's reference calls:
//!
//! * [`constraints`]: the number of selection facets the reference call carries, exactly
//!   `authored/hardness.py`'s count, so fail rate by constraint count is the census the issue quotes
//!   (13% / 22% / 37% / 67% at 1 / 2 / 3 / 4).
//! * [`judge_args`]: per argument class (rows, date, filters, amount), did the model's calls state what a reference
//!   call states? An argument is compared as the runtime reads it (case-folded, whitespace-collapsed text; date
//!   expressions as JSON values; a `$key` of a reference as the `#n` the runtime showed). A reference argument whose
//!   `$key` the runtime never showed cannot be compared and is counted as unscorable, not as a miss.
//!
//! The pass/fail of a turn stays the EFFECT's (see [`crate::judge`]); this only says which argument to blame.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::gold::{RefCall, Turn};

/// The four argument classes of #1166's per-argument report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ArgClass {
    /// Which rows: `rows`, `name`, `within`, `linked_to`.
    Rows,
    /// When: `when`, and a date written in `args` (a `to:` of a reschedule, a due date).
    Date,
    /// Which of them: each `where` clause that is not an amount, `status`, `exclude`, `text`, `order`, `limit`,
    /// `op`, `field`, `group`.
    Filters,
    /// How much: a `where` clause or an `args` line on a money field.
    Amount,
}

impl ArgClass {
    pub const ALL: [Self; 4] = [Self::Rows, Self::Date, Self::Filters, Self::Amount];

    #[must_use]
    pub fn word(self) -> &'static str {
        match self {
            Self::Rows => "rows",
            Self::Date => "date",
            Self::Filters => "filters",
            Self::Amount => "amount",
        }
    }
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        Value::Number(_) => true,
    }
}

fn where_clauses(call_args: &Map<String, Value>) -> Vec<String> {
    call_args
        .get("where")
        .filter(|w| truthy(w))
        .map(|w| {
            text(w)
                .split(" and ")
                .filter(|clause| !clause.trim().is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A write: `create`, `edit`, `do`, or the retired `act` they replaced.
fn is_write_tool(tool: &str) -> bool {
    tool == "act" || centraid_assist::native::meta::is_write(tool)
}

/// A call as the eight tools state it: S2's `search`, `open` and `act` renamed by the runtime's own table
/// (`native::legacy::modernize`), any other call as it is. Reference calls of the frozen set and the calls S2 decodes
/// meet here, so they compare in one vocabulary.
#[must_use]
pub fn modern(tool: &str, args: &Map<String, Value>) -> (String, Map<String, Value>) {
    match centraid_assist::native::legacy::modernize(tool, &Value::Object(args.clone())) {
        Some((tool, Value::Object(args))) => (tool.to_owned(), args),
        _ => (tool.to_owned(), args.clone()),
    }
}

/// The verb a modern write names: `create` and `edit` are their own, `do` carries `verb`.
fn verb_of(tool: &str, args: &Map<String, Value>) -> String {
    match tool {
        "create" | "edit" => tool.to_owned(),
        _ => args
            .get("verb")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase(),
    }
}

/// Reads look alike: `find`, `answer` and `compute` all state a selector, and the contract has the model look
/// with one and end with another.
fn is_read(tool: &str) -> bool {
    matches!(tool, "find" | "answer" | "compute")
}

/// Does the model's last call name the act a reference call names? Reads count as one act; a write is its tool and
/// verb. The effect-level counterpart is [`crate::judge::ending_fits`].
#[must_use]
pub fn tool_name_ok(turn: &Turn, model_calls: &[Value]) -> bool {
    let Some(last) = model_calls.last() else {
        return false;
    };
    let (Some(tool), Some(args)) = (last["tool"].as_str(), last["args"].as_object()) else {
        return false;
    };
    let (tool, args) = modern(tool, args);
    turn.reference.iter().filter(|call| !call.bad).any(|call| {
        let (rt, ra) = modern(&call.tool, &call.args);
        if is_read(&tool) && is_read(&rt) {
            return true;
        }
        rt == tool && verb_of(&rt, &ra) == verb_of(&tool, &args)
    })
}

/// The number of constraints a reference call carries (`authored/hardness.py` `constraints`).
#[must_use]
pub fn constraints(call: &RefCall) -> usize {
    let a = &call.args;
    let has = |key: &str| a.get(key).is_some_and(truthy);
    if matches!(call.tool.as_str(), "ask" | "decline" | "open") {
        return 0;
    }
    let mut k = 0;
    if is_write_tool(&call.tool) {
        k += usize::from(has("rows") || has("name"));
    } else {
        k += usize::from(has("name"));
    }
    for facet in ["when", "linked_to", "within", "exclude", "status", "text"] {
        k += usize::from(has(facet));
    }
    k += where_clauses(a).len();
    k += usize::from(has("order") || has("limit"));
    k += usize::from(has("op") || has("field") || has("group"));
    k
}

/// A turn's constraint count: the most any of its accepted reference calls carries (a `bad` call is a repair).
#[must_use]
pub fn turn_constraints(turn: &Turn) -> usize {
    turn.reference
        .iter()
        .filter(|call| !call.bad)
        .map(constraints)
        .max()
        .unwrap_or(0)
}

/// The label of a constraint count in the report: `0`, `1`, `2`, `3`, `4+`.
#[must_use]
pub fn bucket(k: usize) -> &'static str {
    match k {
        0 => "0",
        1 => "1",
        2 => "2",
        3 => "3",
        _ => "4+",
    }
}

fn fold(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// A comparable argument value: JSON when it parses as an object (a date expression), else folded text.
fn norm(raw: &str) -> Value {
    let raw = raw.trim();
    if raw.starts_with('{')
        && let Ok(value @ Value::Object(_)) = serde_json::from_str::<Value>(raw)
    {
        return value;
    }
    Value::String(fold(raw))
}

fn is_date_text(raw: &str) -> bool {
    let raw = raw.trim();
    let b = raw.as_bytes();
    (b.len() >= 10 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-') || raw.starts_with('{')
}

/// Names of the money fields of the kinds a call names; every kind's when it names none.
fn money_fields(call_args: &Map<String, Value>) -> Vec<&'static str> {
    use centraid_assist::native::meta::{FieldType, Kind};
    let kinds: Vec<Kind> = call_args
        .get("kind")
        .map(text)
        .map(|k| k.split(',').filter_map(Kind::parse).collect())
        .unwrap_or_default();
    kinds
        .iter()
        .flat_map(|kind| kind.spec().fields.iter())
        .filter(|field| field.ty == FieldType::Money)
        .map(|field| field.name)
        .collect()
}

/// The arguments of a call, by class: slot → comparable value.
pub type Slots = BTreeMap<String, Value>;

/// Split a call's arguments into the four classes.
#[must_use]
pub fn classify(args: &Map<String, Value>) -> BTreeMap<ArgClass, Slots> {
    let mut out: BTreeMap<ArgClass, Slots> = BTreeMap::new();
    let money = money_fields(args);
    let is_money = |field: &str| money.iter().any(|m| m.eq_ignore_ascii_case(field.trim()));
    for (key, value) in args {
        if !truthy(value) {
            continue;
        }
        let raw = text(value);
        match key.as_str() {
            "rows" | "name" | "within" | "linked_to" => {
                out.entry(ArgClass::Rows)
                    .or_default()
                    .insert(key.clone(), norm(&raw));
            }
            "when" => {
                out.entry(ArgClass::Date)
                    .or_default()
                    .insert(key.clone(), norm(&raw));
            }
            "status" | "exclude" | "text" | "order" | "limit" | "op" | "field" | "group" => {
                out.entry(ArgClass::Filters)
                    .or_default()
                    .insert(key.clone(), norm(&raw));
            }
            "where" => {
                for clause in where_clauses(args) {
                    let field = clause.split_whitespace().next().unwrap_or_default();
                    let class = if is_money(field) {
                        ArgClass::Amount
                    } else {
                        ArgClass::Filters
                    };
                    out.entry(class)
                        .or_default()
                        .insert(format!("where {}", fold(&clause)), Value::Bool(true));
                }
            }
            // the fields a write sets, one `field: value` per line
            "args" => {
                for line in raw.lines() {
                    let Some((field, value)) = line.split_once(':') else {
                        continue;
                    };
                    let field = field.trim();
                    let class = if is_money(field) {
                        Some(ArgClass::Amount)
                    } else if is_date_text(value) {
                        Some(ArgClass::Date)
                    } else {
                        None
                    };
                    if let Some(class) = class {
                        out.entry(class)
                            .or_default()
                            .insert(format!("args {}", fold(field)), norm(value));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A call in the eight tools' names, with its arguments split by class.
type Classed<T> = (String, T, BTreeMap<ArgClass, Slots>);

/// What judging one class of one turn found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArgVerdict {
    /// No reference call states this class: nothing to get right.
    Absent,
    /// A reference states it but names a row the runtime never showed (`$key`, `@prev`), so no call can be compared.
    Unscorable,
    Right,
    Wrong,
}

/// Replace every `$key` of a reference value by the `#n` the runtime showed; `None` when one was never shown.
fn resolve(value: &Value, handle: &dyn Fn(&str) -> Option<String>) -> Option<Value> {
    match value {
        Value::String(s) if s.contains("@prev") => None,
        Value::String(s) if s.contains('$') => {
            let mut out = String::new();
            let mut rest = s.as_str();
            while let Some(at) = rest.find('$') {
                out.push_str(&rest[..at]);
                let tail = &rest[at + 1..];
                let end = tail
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .unwrap_or(tail.len());
                out.push_str(&handle(&tail[..end])?);
                rest = &tail[end..];
            }
            out.push_str(rest);
            Some(Value::String(out))
        }
        other => Some(other.clone()),
    }
}

fn resolved(slots: &Slots, handle: &dyn Fn(&str) -> Option<String>) -> Option<Slots> {
    slots
        .iter()
        .map(|(k, v)| resolve(v, handle).map(|v| (k.clone(), v)))
        .collect()
}

/// Per class: did the model's calls state what an accepted reference call states?
///
/// `model_calls` are the calls the runtime read out of the model's messages (`{tool, args}`); `handle` turns a
/// world key into the `#n` the runtime showed for it. A class is right when some model call and some accepted
/// reference call agree on the act (reads are one act; a write is its tool and verb) and carry the same
/// arguments of that class, or when the model took a write's selector from a read before it. Both sides are put in
/// the eight tools' names first ([`modern`]).
#[must_use]
pub fn judge_args(
    turn: &Turn,
    model_calls: &[Value],
    handle: &dyn Fn(&str) -> Option<String>,
) -> BTreeMap<ArgClass, ArgVerdict> {
    let theirs: Vec<Classed<Map<String, Value>>> = turn
        .reference
        .iter()
        .filter(|call| !call.bad)
        .map(|call| {
            let (tool, args) = modern(&call.tool, &call.args);
            let classes = classify(&args);
            (tool, args, classes)
        })
        .collect();
    let ours: Vec<Classed<String>> = model_calls
        .iter()
        .filter_map(|call| {
            let (tool, args) = modern(call["tool"].as_str()?, call["args"].as_object()?);
            let verb = verb_of(&tool, &args);
            Some((tool, verb, classify(&args)))
        })
        .collect();
    let mut out = BTreeMap::new();
    for class in ArgClass::ALL {
        let stated: Vec<_> = theirs
            .iter()
            .filter(|(_, _, c)| c.contains_key(&class))
            .collect();
        let verdict = if stated.is_empty() {
            ArgVerdict::Absent
        } else {
            let scorable: Vec<_> = stated
                .iter()
                .filter_map(|(tool, args, c)| {
                    resolved(&c[&class], handle).map(|slots| (tool, verb_of(tool, args), slots))
                })
                .collect();
            if scorable.is_empty() {
                ArgVerdict::Unscorable
            } else if scorable.iter().any(|(rt, rverb, slots)| {
                let states =
                    |(_, _, c): &Classed<String>| c.get(&class).is_some_and(|mine| mine == slots);
                // a read states its selector in `find` or `answer` alike; a write is its tool and verb, and a
                // write by `@k` took its selector from a read that came before it
                let same_act = |(t, v, _): &Classed<String>| {
                    (is_read(t) && is_read(rt)) || (t == *rt && v == rverb)
                };
                ours.iter().any(|m| same_act(m) && states(m))
                    || (!is_read(rt)
                        && ours.iter().any(same_act)
                        && ours.iter().any(|m| is_read(&m.0) && states(m)))
            }) {
                ArgVerdict::Right
            } else {
                ArgVerdict::Wrong
            }
        };
        out.insert(class, verdict);
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn call(tool: &str, args: Value) -> RefCall {
        serde_json::from_value(json!({"tool": tool, "args": args})).expect("call")
    }

    fn turn(refs: Value) -> Turn {
        serde_json::from_value(json!({"user": "q", "gold": [{"type": "rows"}], "ref": refs}))
            .expect("turn")
    }

    #[test]
    fn constraints_count_exactly_what_hardness_py_counts() {
        assert_eq!(constraints(&call("answer", json!({"kind": "event"}))), 0);
        assert_eq!(
            constraints(&call(
                "answer",
                json!({"kind": "event", "name": "swimming lesson", "when": "{}"})
            )),
            2
        );
        let wide = call(
            "answer",
            json!({"kind": "task", "linked_to": "$l", "where": "person count <= 0 and status = open", "order": "date", "limit": 3}),
        );
        assert_eq!(constraints(&wide), 1 + 2 + 1);
        assert_eq!(
            constraints(&call("act", json!({"verb": "complete", "rows": "#3"}))),
            1
        );
        assert_eq!(
            constraints(&call(
                "act",
                json!({"verb": "reschedule", "name": "bins", "where": "status = open", "args": "to: x"})
            )),
            2
        );
        assert_eq!(
            constraints(&call(
                "compute",
                json!({"op": "sum", "field": "amount", "group": "category", "when": "{}"})
            )),
            2
        );
        assert_eq!(
            constraints(&call("decline", json!({"reason": "not_found"}))),
            0
        );
        assert_eq!(constraints(&call("answer", json!({"name": ""}))), 0);
    }

    #[test]
    fn a_turn_takes_the_widest_accepted_call_and_ignores_a_repair() {
        let t = turn(json!([
            {"tool": "answer", "args": {"kind": "event", "when": "{}"}, "bad": true},
            {"tool": "answer", "args": {"kind": "event", "name": "a"}},
            {"tool": "answer", "args": {"kind": "event", "name": "a", "when": "{}", "where": "x = 1 and y = 2"}}
        ]));
        assert_eq!(turn_constraints(&t), 4);
        assert_eq!(bucket(4), "4+");
        assert_eq!(bucket(7), "4+");
        assert_eq!(bucket(0), "0");
    }

    #[test]
    fn arguments_fall_into_their_four_classes() {
        let args = json!({"kind": "transaction", "name": "Blue Bottle", "when": "{\"unit\":\"week\",\"rel\":0}",
                          "where": "amount > 20 and category = food", "status": "open"});
        let classes = classify(args.as_object().expect("object"));
        assert!(classes[&ArgClass::Rows].contains_key("name"));
        assert!(classes[&ArgClass::Date].contains_key("when"));
        assert_eq!(
            classes[&ArgClass::Amount].keys().collect::<Vec<_>>(),
            vec!["where amount > 20"]
        );
        assert!(classes[&ArgClass::Filters].contains_key("where category = food"));
        assert!(classes[&ArgClass::Filters].contains_key("status"));
    }

    #[test]
    fn a_writes_args_lines_split_into_date_and_amount() {
        let args = json!({"verb": "reschedule", "rows": "#2", "args": "to: {\"unit\":\"day\",\"rel\":1}\nnote: hello"});
        let classes = classify(args.as_object().expect("object"));
        assert!(classes[&ArgClass::Date].contains_key("args to"));
        assert!(!classes.contains_key(&ArgClass::Amount));
    }

    #[test]
    fn the_model_is_right_on_a_class_when_a_call_states_what_a_reference_states() {
        let t = turn(
            json!([{"tool": "answer", "args": {"kind": "event", "name": "Swimming  lesson", "when": "{\"unit\":\"week\",\"rel\":0}"}}]),
        );
        let calls = vec![
            json!({"tool": "answer", "args": {"kind": "event", "name": "swimming lesson", "when": "{\"rel\":0,\"unit\":\"week\"}"}}),
        ];
        let verdicts = judge_args(&t, &calls, &|_| None);
        assert_eq!(verdicts[&ArgClass::Rows], ArgVerdict::Right);
        assert_eq!(
            verdicts[&ArgClass::Date],
            ArgVerdict::Right,
            "key order of a date expression is not a difference"
        );
        assert_eq!(verdicts[&ArgClass::Filters], ArgVerdict::Absent);
        let off = vec![
            json!({"tool": "answer", "args": {"kind": "event", "name": "swimming lesson", "when": "{\"unit\":\"week\",\"rel\":1}"}}),
        ];
        let verdicts = judge_args(&t, &off, &|_| None);
        assert_eq!(verdicts[&ArgClass::Rows], ArgVerdict::Right);
        assert_eq!(verdicts[&ArgClass::Date], ArgVerdict::Wrong);
    }

    #[test]
    fn a_dollar_key_resolves_through_the_handles_the_runtime_showed() {
        let t = turn(json!([{"tool": "act", "args": {"verb": "complete", "rows": "$tiles"}}]));
        let calls = vec![json!({"tool": "act", "args": {"verb": "complete", "rows": "#4"}})];
        let shown = |key: &str| (key == "tiles").then(|| "#4".to_owned());
        assert_eq!(
            judge_args(&t, &calls, &shown)[&ArgClass::Rows],
            ArgVerdict::Right
        );
        assert_eq!(
            judge_args(&t, &calls, &|_| None)[&ArgClass::Rows],
            ArgVerdict::Unscorable
        );
        let other = vec![json!({"tool": "act", "args": {"verb": "cancel", "rows": "#4"}})];
        assert_eq!(
            judge_args(&t, &other, &shown)[&ArgClass::Rows],
            ArgVerdict::Wrong,
            "another verb is another call"
        );
    }

    #[test]
    fn a_class_the_model_never_stated_is_wrong() {
        let t = turn(
            json!([{"tool": "answer", "args": {"kind": "task", "where": "effort >= 90 minutes"}}]),
        );
        let calls = vec![json!({"tool": "answer", "args": {"kind": "task"}})];
        assert_eq!(
            judge_args(&t, &calls, &|_| None)[&ArgClass::Filters],
            ArgVerdict::Wrong
        );
        assert_eq!(
            judge_args(&t, &[], &|_| None)[&ArgClass::Filters],
            ArgVerdict::Wrong
        );
    }

    #[test]
    fn s2_names_and_the_new_names_compare_alike() {
        let (tool, args) = modern(
            "act",
            json!({"verb": "complete", "name": "tiles"})
                .as_object()
                .expect("object"),
        );
        assert_eq!(
            (tool.as_str(), args["verb"].as_str()),
            ("do", Some("complete"))
        );
        let (tool, args) = modern(
            "act",
            json!({"verb": "edit", "rows": "#2", "args": "name: x"})
                .as_object()
                .expect("object"),
        );
        assert_eq!(tool, "edit");
        assert!(!args.contains_key("verb"));
        assert_eq!(
            modern(
                "search",
                json!({"text": "boiler"}).as_object().expect("object")
            )
            .0,
            "find"
        );
        assert_eq!(
            modern(
                "answer",
                json!({"kind": "task"}).as_object().expect("object")
            )
            .0,
            "answer"
        );
    }

    #[test]
    fn a_find_then_do_by_handle_is_right_against_a_by_name_reference() {
        let t = turn(
            json!([{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "tiles"}}]),
        );
        let calls = vec![
            json!({"tool": "find", "args": {"kind": "task", "name": "tiles"}}),
            json!({"tool": "do", "args": {"verb": "complete", "rows": "@1"}}),
        ];
        assert_eq!(
            judge_args(&t, &calls, &|_| None)[&ArgClass::Rows],
            ArgVerdict::Right
        );
        let wrong = vec![
            json!({"tool": "find", "args": {"kind": "task", "name": "adhesive"}}),
            json!({"tool": "do", "args": {"verb": "complete", "rows": "@1"}}),
        ];
        assert_eq!(
            judge_args(&t, &wrong, &|_| None)[&ArgClass::Rows],
            ArgVerdict::Wrong
        );
        let other_verb = vec![
            json!({"tool": "find", "args": {"kind": "task", "name": "tiles"}}),
            json!({"tool": "do", "args": {"verb": "cancel", "rows": "@1"}}),
        ];
        assert_eq!(
            judge_args(&t, &other_verb, &|_| None)[&ArgClass::Rows],
            ArgVerdict::Wrong
        );
    }

    #[test]
    fn tool_name_accuracy_collapses_reads_and_keeps_a_write_s_verb() {
        let read = turn(json!([{"tool": "answer", "args": {"kind": "event"}}]));
        let find_then_answer = vec![
            json!({"tool": "find", "args": {}}),
            json!({"tool": "answer", "args": {"rows": "@1"}}),
        ];
        assert!(tool_name_ok(&read, &find_then_answer));
        assert!(
            tool_name_ok(&read, &[json!({"tool": "search", "args": {"text": "x"}})]),
            "S2's search is a read"
        );
        assert!(!tool_name_ok(
            &read,
            &[json!({"tool": "decline", "args": {"reason": "not_found"}})]
        ));
        let write = turn(json!([{"tool": "act", "args": {"verb": "complete", "name": "x"}}]));
        assert!(tool_name_ok(
            &write,
            &[json!({"tool": "act", "args": {"verb": "complete", "name": "x"}})]
        ));
        assert!(tool_name_ok(
            &write,
            &[json!({"tool": "do", "args": {"verb": "complete", "rows": "@1"}})]
        ));
        assert!(!tool_name_ok(
            &write,
            &[json!({"tool": "do", "args": {"verb": "cancel", "rows": "@1"}})]
        ));
        assert!(!tool_name_ok(&write, &[]));
    }
}
