//! THE SCORER: a turn's effect against the effects its gold accepts (the retired `eval/score.py`: `match_value`, `diff_match`,
//! `value_match`, `judge_accept`, `judge_turn`). Same rules, same problem texts, so a failed turn reads alike in
//! both reports.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

use crate::EvalError;
use crate::effect::{Effect, Ending, NetDiff};
use crate::gold::{Accept, AcceptKind, Diff, Money, Turn};

/// World keys → vault ids and back, plus the rows the run created in earlier turns (`score.py` `Ids`).
#[derive(Debug, Clone, Default)]
pub struct Ids {
    keys: BTreeMap<String, String>,
    by_id: HashMap<String, String>,
    /// Rows the run created in earlier turns, in order: gold's `+1` is the first.
    pub created: Vec<String>,
}

impl Ids {
    #[must_use]
    pub fn new(keys: BTreeMap<String, String>) -> Self {
        let by_id = keys.iter().map(|(k, v)| (v.clone(), k.clone())).collect();
        Self {
            keys,
            by_id,
            created: Vec::new(),
        }
    }

    /// # Errors
    /// [`EvalError::Data`] when gold names a key the world does not have.
    pub fn id(&self, key: &str) -> Result<String, EvalError> {
        if let Some(index) = key.strip_prefix('+') {
            let index: usize = index
                .parse()
                .map_err(|_| EvalError::Data(format!("gold names row {key:?}")))?;
            return Ok(self
                .created
                .get(index.wrapping_sub(1))
                .cloned()
                .unwrap_or_else(|| format!("<no created row {key}>")));
        }
        self.keys
            .get(key)
            .cloned()
            .ok_or_else(|| EvalError::Data(format!("gold names unknown world key {key:?}")))
    }

    /// A row as a report reads it: its world key, else a prefix of its id.
    #[must_use]
    pub fn name(&self, id: &str) -> String {
        self.by_id
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.chars().take(8).collect())
    }
}

fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

fn fold(text: &str) -> String {
    text.trim().to_lowercase()
}

fn py_text(value: &Value) -> String {
    fold(
        &value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned),
    )
}

/// Does a value the vault holds match what gold wants (`score.py` `match_value`)?
///
/// # Errors
/// [`EvalError::Data`] for a matcher the scorer does not know.
pub fn match_value(want: &Value, got: &Value) -> Result<bool, EvalError> {
    if let Value::Object(matcher) = want {
        if matcher.get("any").is_some_and(|v| v != &Value::Bool(false)) {
            return Ok(true);
        }
        if let Some(Value::Array(options)) = matcher.get("oneof") {
            for option in options {
                if match_value(option, got)? {
                    return Ok(true);
                }
            }
            return Ok(false);
        }
        if let Some(Value::Array(words)) = matcher.get("has") {
            let Value::String(got) = got else {
                return Ok(false);
            };
            let got = got.to_lowercase();
            return Ok(words.iter().all(|word| {
                word.as_str()
                    .is_some_and(|w| got.contains(&w.to_lowercase()))
            }));
        }
        if let Some(prefix) = matcher.get("prefix") {
            return Ok(
                matches!((got, prefix), (Value::String(g), Value::String(p)) if g.starts_with(p.as_str())),
            );
        }
        return Err(EvalError::Data(format!("unknown matcher {want}")));
    }
    // money: {"amount": 24.0, "unit": "USD"}
    if let Some(amount) = got.get("amount") {
        return match_value(want, amount);
    }
    if want.is_null() || got.is_null() {
        return Ok(want.is_null() && got.is_null());
    }
    if want.is_boolean() || got.is_boolean() {
        return Ok(want == got);
    }
    if let (Value::Number(w), Value::Number(g)) = (want, got) {
        return Ok((w.as_f64().unwrap_or(f64::NAN) - g.as_f64().unwrap_or(f64::NAN)).abs() < 0.005);
    }
    if let (Value::String(w), Value::String(g)) = (want, got) {
        if is_date(w) && is_date(g) {
            return Ok(g.starts_with(w.as_str()));
        }
        return Ok(fold(w) == fold(g));
    }
    Ok(py_text(want) == py_text(got))
}

/// Problems a turn's net diff has against a gold diff, and which of them are vault changes gold never asked for.
///
/// # Errors
/// [`EvalError::Data`] for a gold key the world lacks.
pub fn diff_match(
    want: &Diff,
    got: &NetDiff,
    ids: &Ids,
) -> Result<(Vec<String>, Vec<String>), EvalError> {
    let mut problems = Vec::new();
    let mut unwanted = Vec::new();
    let mut matched: HashSet<&str> = HashSet::new();
    let mut created_ids: Vec<&str> = Vec::new();
    for spec in &want.rows {
        if let Some(kind) = &spec.new {
            let mut hit = None;
            for row in &got.rows {
                if matched.contains(row.id.as_str()) || row.change != "created" || &row.kind != kind
                {
                    continue;
                }
                let mut all = true;
                for (field, value) in &spec.fields {
                    match row.fields.get(field) {
                        Some((_, new)) if match_value(value, new)? => {}
                        _ => {
                            all = false;
                            break;
                        }
                    }
                }
                if all {
                    hit = Some(row);
                    break;
                }
            }
            if let Some(row) = hit {
                matched.insert(&row.id);
                created_ids.push(&row.id);
                continue;
            }
            let cand = got.rows.iter().find(|r| {
                r.change == "created" && &r.kind == kind && !matched.contains(r.id.as_str())
            });
            if let Some(row) = cand {
                let have: BTreeMap<&String, &Value> =
                    row.fields.iter().map(|(f, (_, n))| (f, n)).collect();
                problems.push(format!(
                    "created {kind} with wrong fields: {have:?} want {:?}",
                    spec.fields
                ));
                unwanted.push(format!("created {kind} with wrong fields"));
                matched.insert(&row.id);
                created_ids.push(&row.id);
            } else {
                problems.push(format!("missing create of {kind} {:?}", spec.fields));
            }
            continue;
        }
        let key = spec.key.as_deref().ok_or_else(|| {
            EvalError::Data("a gold row names neither a key nor a new kind".to_owned())
        })?;
        let rid = ids.id(key)?;
        let Some(row) = got.rows.iter().find(|r| r.id == rid) else {
            problems.push(format!(
                "missing change on {key} {}",
                if spec.fields.is_empty() {
                    spec.change.clone().unwrap_or_default()
                } else {
                    format!("{:?}", spec.fields)
                }
            ));
            continue;
        };
        matched.insert(&row.id);
        let change = spec.change.as_deref().unwrap_or("updated");
        if row.change != change {
            problems.push(format!("{key}: change {} want {change}", row.change));
            unwanted.push(format!("{key}: {}", row.change));
            continue;
        }
        if change == "updated" {
            for (field, (_, new)) in &row.fields {
                match spec.fields.get(field) {
                    None => {
                        problems.push(format!("{key}: unexpected field {field} -> {new}"));
                        unwanted.push(format!("{key}.{field}"));
                    }
                    Some(want) if !match_value(want, new)? => {
                        problems.push(format!("{key}.{field} = {new}, want {want}"));
                        unwanted.push(format!("{key}.{field} wrong value"));
                    }
                    Some(_) => {}
                }
            }
            for field in spec.fields.keys() {
                if !row.fields.contains_key(field) {
                    problems.push(format!("{key}: field {field} unchanged"));
                }
            }
        }
    }
    for row in &got.rows {
        if !matched.contains(row.id.as_str()) {
            let label = ids.name(&row.id);
            let fields: Vec<&String> = row.fields.keys().collect();
            problems.push(format!(
                "unwanted {} of {} {label} {fields:?}",
                row.change, row.kind
            ));
            unwanted.push(format!("{} {label}", row.change));
        }
    }
    let mut used: HashSet<usize> = HashSet::new();
    for link in &want.links {
        let mut hit = None;
        for (i, got_link) in got.links.iter().enumerate() {
            if used.contains(&i) || got_link.change != link.change {
                continue;
            }
            let side = |want: &str, got: &str| -> Result<bool, EvalError> {
                Ok(if want == "new" {
                    created_ids.contains(&got)
                } else {
                    got == ids.id(want)?
                })
            };
            if side(&link.from, &got_link.from)? && side(&link.to, &got_link.to)? {
                hit = Some(i);
                break;
            }
        }
        match hit {
            Some(i) => {
                used.insert(i);
            }
            None => problems.push(format!(
                "missing link {} {} -> {}",
                link.change, link.from, link.to
            )),
        }
    }
    for (i, link) in got.links.iter().enumerate() {
        if !used.contains(&i) {
            problems.push(format!(
                "unwanted link {} {} -> {}",
                link.change,
                ids.name(&link.from),
                ids.name(&link.to)
            ));
            unwanted.push(format!("link {}", link.change));
        }
    }
    Ok((problems, unwanted))
}

fn value_list_match(want: &[Money], got: &[Value]) -> bool {
    if want.len() != got.len() {
        return false;
    }
    let unit = |u: Option<&str>| u.filter(|u| !u.is_empty()).map(str::to_owned);
    let mut rest: Vec<&Value> = got.iter().collect();
    for w in want {
        let hit = rest.iter().position(|g| {
            unit(g["unit"].as_str()) == unit(w.unit.as_deref())
                && g["amount"]
                    .as_f64()
                    .is_some_and(|a| (a - w.amount).abs() < 0.005)
        });
        match hit {
            Some(i) => {
                rest.remove(i);
            }
            None => return false,
        }
    }
    true
}

fn value_match(accept: &Accept, got: &Value) -> bool {
    if let Some(groups) = &accept.groups {
        let have: BTreeMap<String, Vec<Value>> = got["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|g| {
                let key = g["key"]
                    .as_str()
                    .map_or_else(|| g["key"].to_string(), str::to_owned);
                (
                    key.to_lowercase(),
                    g["values"].as_array().cloned().unwrap_or_default(),
                )
            })
            .collect();
        let want: BTreeMap<String, &Vec<Money>> =
            groups.iter().map(|(k, v)| (k.to_lowercase(), v)).collect();
        if have.keys().ne(want.keys()) {
            return false;
        }
        return want.iter().all(|(k, v)| value_list_match(v, &have[k]));
    }
    value_list_match(
        &accept.values,
        got["values"].as_array().map_or(&[], Vec::as_slice),
    )
}

/// One acceptable gold effect against the turn's effect: `(pass, problems, unwanted)`.
///
/// # Errors
/// [`EvalError::Data`] for a gold key the world lacks or a matcher the scorer does not know.
pub fn judge_accept(
    accept: &Accept,
    effect: &Effect,
    ids: &Ids,
) -> Result<(bool, Vec<String>, Vec<String>), EvalError> {
    let (mut problems, unwanted) = diff_match(&accept.diff, &effect.diff, ids)?;
    let got = effect.ending;
    match accept.kind {
        AcceptKind::Rows => {
            if got == Ending::Rows {
                let want: Vec<String> = accept
                    .rows
                    .iter()
                    .map(|k| ids.id(k))
                    .collect::<Result<_, _>>()?;
                if accept.order {
                    if effect.rows != want {
                        problems.push("rows or their order differ".to_owned());
                    }
                } else {
                    let have: HashSet<&String> = effect.rows.iter().collect();
                    let need: HashSet<&String> = want.iter().collect();
                    if have != need {
                        let names = |set: Vec<&&String>| -> Vec<String> {
                            let mut v: Vec<String> = set.iter().map(|r| ids.name(r)).collect();
                            v.sort();
                            v.truncate(6);
                            v
                        };
                        problems.push(format!(
                            "rows differ: extra {:?} missing {:?}",
                            names(have.difference(&need).collect()),
                            names(need.difference(&have).collect())
                        ));
                    }
                }
            } else {
                problems.push(format!("ended in {}, want rows", got.word()));
            }
        }
        AcceptKind::Value => {
            if got != Ending::Value {
                problems.push(format!("ended in {}, want value", got.word()));
            } else if !value_match(accept, &effect.value) {
                problems.push(format!(
                    "value {} want {:?}",
                    effect.value,
                    accept
                        .groups
                        .as_ref()
                        .map_or_else(|| format!("{:?}", accept.values), |g| format!("{g:?}"))
                ));
            }
        }
        AcceptKind::Diff => {
            // judged by the vault diff: a write that landed counts even if the model then looped or hit the step cap
            if matches!(got, Ending::Ask | Ending::Decline) {
                problems.push(format!("ended in {}, want a write", got.word()));
            }
            for key in &accept.already {
                if !effect.already.contains(&ids.id(key)?) {
                    problems.push(format!("no already: for {key}"));
                }
            }
            for reveal in &accept.reveal {
                if !effect
                    .revealed
                    .iter()
                    .any(|text| text.contains(&reveal.contains))
                {
                    problems.push(format!("secret of {} not revealed", reveal.key));
                }
            }
        }
        AcceptKind::Ask => {
            if got != Ending::Ask {
                problems.push(format!("ended in {}, want ask", got.word()));
            } else {
                let mut missing = Vec::new();
                for key in &accept.candidates {
                    if !effect.options.contains(&ids.id(key)?) {
                        missing.push(key.clone());
                    }
                }
                if !missing.is_empty() {
                    problems.push(format!("ask options miss {missing:?}"));
                }
            }
        }
        AcceptKind::Decline => {
            if got != Ending::Decline {
                problems.push(format!("ended in {}, want decline", got.word()));
            } else if !effect
                .reason
                .as_ref()
                .is_some_and(|r| accept.reasons.contains(r))
            {
                problems.push(format!(
                    "decline {:?} want {:?}",
                    effect.reason, accept.reasons
                ));
            }
        }
    }
    if accept.kind != AcceptKind::Diff && !effect.revealed.is_empty() {
        problems.push("revealed a secret gold did not ask for".to_owned());
    }
    Ok((problems.is_empty(), problems, unwanted))
}

/// The verdict on one turn.
#[derive(Debug, Clone)]
pub struct Verdict {
    pub pass: bool,
    pub problems: Vec<String>,
    /// An unwanted vault change under every acceptable reading.
    pub wrong_write: bool,
    pub effect: Effect,
    pub gold_type: AcceptKind,
    /// Did the turn end in the kind of act the gold wants (answer, write, ask or decline)? The effect-level reading
    /// of "the right tool": a wrong value is not a wrong tool.
    pub tool_ok: bool,
}

/// Does `ending` read as the act an accept of `kind` wants?
#[must_use]
pub fn ending_fits(kind: AcceptKind, ending: Ending) -> bool {
    match kind {
        AcceptKind::Rows => ending == Ending::Rows,
        AcceptKind::Value => ending == Ending::Value,
        // a write that also answers its row (`act log`) ends in rows
        AcceptKind::Diff => matches!(ending, Ending::Act | Ending::Rows),
        AcceptKind::Ask => ending == Ending::Ask,
        AcceptKind::Decline => ending == Ending::Decline,
    }
}

/// Judge a turn against all its acceptable readings.
///
/// # Errors
/// [`EvalError::Data`] for bad gold.
pub fn judge_turn(turn: &Turn, effect: Effect, ids: &Ids) -> Result<Verdict, EvalError> {
    let mut results = Vec::new();
    for accept in &turn.gold {
        results.push(judge_accept(accept, &effect, ids)?);
    }
    let pass = results.iter().any(|r| r.0);
    let best = results
        .iter()
        .find(|r| r.0)
        .or_else(|| results.iter().min_by_key(|r| (r.1.len(), r.2.len())))
        .ok_or_else(|| EvalError::Data("a turn has no gold".to_owned()))?;
    let wrong_write = results.iter().all(|r| !r.2.is_empty());
    let tool_ok = turn.gold.iter().any(|a| ending_fits(a.kind, effect.ending));
    Ok(Verdict {
        pass,
        problems: best.1.clone(),
        wrong_write,
        gold_type: turn.gold[0].kind,
        tool_ok,
        effect,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::effect::turn_effect;

    fn ids() -> Ids {
        let keys = [
            ("dentist", "id-dentist"),
            ("vet", "id-vet"),
            ("me", "id-me"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        Ids::new(keys)
    }

    fn turn(gold: Value) -> Turn {
        serde_json::from_value(json!({"user": "q", "gold": gold})).expect("turn")
    }

    fn rows_effect(ids: &[&str]) -> Effect {
        let rows: Vec<Value> = ids.iter().map(|id| json!({"id": id, "n": 1})).collect();
        turn_effect(&[
            json!({"ends_turn": true, "effect": {"tool": "answer", "answer": {"rows": rows}}}),
        ])
    }

    fn update(id: &str, field: &str, old: Value, new: Value) -> Effect {
        let diff = json!({"rows": [{"id": id, "kind": "task", "change": "updated", "fields": {field: [old, new]}}]});
        turn_effect(&[json!({"ends_turn": true, "effect": {"tool": "act", "diff": diff}})])
    }

    #[test]
    fn a_rows_turn_passes_on_the_exact_set_in_any_order() {
        let t = turn(json!([{"type": "rows", "rows": ["dentist", "vet"]}]));
        let ok = judge_turn(&t, rows_effect(&["id-vet", "id-dentist"]), &ids()).expect("judge");
        assert!(ok.pass && ok.tool_ok && !ok.wrong_write);
        let extra =
            judge_turn(&t, rows_effect(&["id-vet", "id-dentist", "id-me"]), &ids()).expect("judge");
        assert!(!extra.pass);
        assert_eq!(
            extra.problems,
            vec!["rows differ: extra [\"me\"] missing []".to_owned()]
        );
        assert!(extra.tool_ok, "a wrong set is not a wrong tool");
    }

    #[test]
    fn order_counts_only_when_gold_says_so() {
        let t = turn(json!([{"type": "rows", "rows": ["dentist", "vet"], "order": true}]));
        assert!(
            !judge_turn(&t, rows_effect(&["id-vet", "id-dentist"]), &ids())
                .expect("judge")
                .pass
        );
        assert!(
            judge_turn(&t, rows_effect(&["id-dentist", "id-vet"]), &ids())
                .expect("judge")
                .pass
        );
    }

    #[test]
    fn a_write_passes_on_its_net_field_change_and_fails_on_a_wrong_value() {
        let t = turn(
            json!([{"type": "diff", "diff": {"rows": [{"key": "dentist", "change": "updated", "fields": {"date": "2026-03-18"}}], "links": []}}]),
        );
        let ok = update(
            "id-dentist",
            "date",
            json!("2026-03-11T19:00"),
            json!("2026-03-18T19:00"),
        );
        assert!(
            judge_turn(&t, ok, &ids()).expect("judge").pass,
            "a date matches by its day prefix"
        );
        let wrong = update(
            "id-dentist",
            "date",
            json!("2026-03-11"),
            json!("2026-03-19"),
        );
        let verdict = judge_turn(&t, wrong, &ids()).expect("judge");
        assert!(!verdict.pass && verdict.wrong_write);
        assert_eq!(
            verdict.problems[0],
            "dentist.date = \"2026-03-19\", want \"2026-03-18\""
        );
        let other = update("id-vet", "date", json!("a"), json!("b"));
        let verdict = judge_turn(&t, other, &ids()).expect("judge");
        assert!(
            verdict
                .problems
                .iter()
                .any(|p| p.starts_with("missing change on dentist"))
        );
        assert!(
            verdict
                .problems
                .iter()
                .any(|p| p.starts_with("unwanted updated of task vet"))
        );
    }

    #[test]
    fn any_of_several_accepted_readings_passes() {
        let t = turn(json!([
            {"type": "rows", "rows": ["dentist"]},
            {"type": "decline", "reasons": ["not_found", "out_of_scope"]}
        ]));
        let declined = turn_effect(&[
            json!({"ends_turn": true, "effect": {"tool": "decline", "decline": {"reason": "out_of_scope"}}}),
        ]);
        assert!(judge_turn(&t, declined, &ids()).expect("judge").pass);
        let asked = turn_effect(&[
            json!({"ends_turn": true, "effect": {"tool": "ask", "ask": {"options": []}}}),
        ]);
        let verdict = judge_turn(&t, asked, &ids()).expect("judge");
        assert!(!verdict.pass && !verdict.tool_ok);
    }

    #[test]
    fn values_match_by_amount_and_unit_ignoring_order() {
        let t = turn(
            json!([{"type": "value", "values": [{"amount": 70, "unit": "USD"}, {"amount": 3, "unit": null}]}]),
        );
        let said = |values: Value| {
            turn_effect(&[
                json!({"ends_turn": true, "effect": {"tool": "answer", "value": {"values": values}}}),
            ])
        };
        let ok = said(json!([{"amount": 3.0, "unit": null}, {"amount": 70.004, "unit": "USD"}]));
        assert!(judge_turn(&t, ok, &ids()).expect("judge").pass);
        let wrong_unit =
            said(json!([{"amount": 3.0, "unit": null}, {"amount": 70.0, "unit": "EUR"}]));
        assert!(!judge_turn(&t, wrong_unit, &ids()).expect("judge").pass);
    }

    #[test]
    fn grouped_values_match_by_case_folded_key() {
        let t =
            turn(json!([{"type": "value", "groups": {"Food": [{"amount": 12, "unit": "USD"}]}}]));
        let eff = turn_effect(&[
            json!({"ends_turn": true, "effect": {"tool": "answer", "value": {"groups": [{"key": "food", "values": [{"amount": 12.0, "unit": "USD"}]}]}}}),
        ]);
        assert!(judge_turn(&t, eff, &ids()).expect("judge").pass);
    }

    #[test]
    fn matchers_cover_any_oneof_has_and_prefix() {
        assert!(match_value(&json!({"any": true}), &json!("x")).expect("m"));
        assert!(match_value(&json!({"oneof": ["a", "b"]}), &json!("B")).expect("m"));
        assert!(match_value(&json!({"has": ["Plumber"]}), &json!("call the plumber")).expect("m"));
        assert!(!match_value(&json!({"has": ["plumber"]}), &json!(3)).expect("m"));
        assert!(match_value(&json!({"prefix": "Call"}), &json!("Call mum")).expect("m"));
        assert!(match_value(&json!(24), &json!({"amount": 24.001, "unit": "USD"})).expect("m"));
        assert!(match_value(&json!(null), &json!(null)).expect("m"));
        assert!(!match_value(&json!(null), &json!("")).expect("m"));
        assert!(match_value(&json!("  Café "), &json!("café")).expect("m"));
        assert!(match_value(&json!({"nope": 1}), &json!(1)).is_err());
    }

    #[test]
    fn a_created_row_matches_by_kind_and_fields_and_a_link_to_it_by_new() {
        let t = turn(json!([{"type": "diff", "diff": {
            "rows": [{"new": "task", "fields": {"name": {"has": ["plumber"]}}}],
            "links": [{"change": "added", "from": "new", "to": "dentist"}]}}]));
        let eff = |name: &str| {
            let diff = json!({"rows": [{"id": "n1", "kind": "task", "change": "created", "fields": {"name": [null, name]}}],
                              "links": [{"change": "added", "from": {"id": "n1"}, "to": {"id": "id-dentist"}}]});
            turn_effect(&[json!({"ends_turn": true, "effect": {"tool": "act", "diff": diff}})])
        };
        assert!(
            judge_turn(&t, eff("Call the Plumber"), &ids())
                .expect("judge")
                .pass
        );
        let verdict = judge_turn(&t, eff("Call mum"), &ids()).expect("judge");
        assert!(!verdict.pass && verdict.wrong_write);
    }

    #[test]
    fn a_revealed_secret_fails_a_read_and_a_missing_one_fails_a_reveal() {
        let read = turn(json!([{"type": "rows", "rows": ["dentist"]}]));
        let mut eff = rows_effect(&["id-dentist"]);
        eff.revealed.push("hunter2".to_owned());
        assert!(!judge_turn(&read, eff, &ids()).expect("judge").pass);
        let reveal =
            turn(json!([{"type": "diff", "reveal": [{"key": "dentist", "contains": "hunter2"}]}]));
        let mut eff = turn_effect(&[json!({"ends_turn": true, "effect": {"tool": "act"}})]);
        assert!(
            !judge_turn(&reveal, eff.clone(), &ids())
                .expect("judge")
                .pass
        );
        eff.revealed.push("the password is hunter2".to_owned());
        assert!(judge_turn(&reveal, eff, &ids()).expect("judge").pass);
    }

    #[test]
    fn gold_naming_a_key_the_world_lacks_is_an_error_not_a_failed_turn() {
        let t = turn(json!([{"type": "rows", "rows": ["ghost"]}]));
        assert!(judge_turn(&t, rows_effect(&["id-vet"]), &ids()).is_err());
    }

    #[test]
    fn plus_n_names_the_nth_row_the_session_created() {
        let mut ids = ids();
        ids.created.push("id-new".to_owned());
        assert_eq!(ids.id("+1").expect("id"), "id-new");
        assert_eq!(ids.id("+2").expect("id"), "<no created row +2>");
    }
}
