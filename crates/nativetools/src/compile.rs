//! THE COMPILE STEP: the call a slot trace states.
//!
//! `{"op":"compile","slots":{…}}` on the session protocol takes the slots of a v3 trace as JSON
//! (`experiments/toolchat/native/CONTRACT_V3.md` §2: `intent`, `via`, `verb`, `kind`, `op`,
//! `field`, `group`, `trashed`, `name`, `text`, `where`, `when`, `linked_to`, `within`, `exclude`,
//! `order`, `limit`, `more`, `set`, `rows`, `row`, `value`, `options`, `question`, `reason`, and
//! `pick`) and answers with the call the runtime will execute:
//!
//! ```text
//! {"call":   {"tool": …, "args": {…}},   // the call after the grounding and the conventions
//!  "stated": {"tool": …, "args": {…}},   // the call the slots state, before them
//!  "notes":  [ … ],                      // what normalising, grounding and the conventions changed
//!  "normalized": [ … ],                  // the repairs of `normalize.rs`, as the effect lists them
//!  "resolved": {"picks": […], "dates": […]}}
//! ```
//!
//! or `{"refused": {"slot": "pick[1]", "why": "…"}}`, naming the slot that does not compile.
//! Running `stated` through `call` gives the same effect as running `call`, and the notes then
//! appear under the observation as they do for any call.
//!
//! The assembly follows the stateless compiler (`think.rs`, which reads a think's text with no
//! vault and is the compiler the decoder and the data builders use): the tool is `via`, else the
//! intent's own; the rows are the explicit `rows` / `row` slot, else the `ok` rows of `pick`, and
//! only when no other handle slot is explicit. What both state is stated once, here: the order of
//! a call's arguments, the date spellings, the default tool, where a pick's rows go and the kind a
//! verb fixes.
//!
//! - `where` is a list of typed conditions, never a string: `{"field","op","value"}` with op in
//!   `= != < <= > >=`, `contains`, `in` (a list), `is empty`, `is set`, or
//!   `{"link":"person","op":">=","value":2}` for a linked count. Each is rendered in the one
//!   spelling the runtime reads and checked against the kind (`whr::parse`).
//! - a `pick` is a list of entries, each naming one thing the user block showed: a row by its
//!   `#n` (`{"row":"#3","verdict":"ok"}`, `"no"` for a candidate left out), a row of the `focus:`
//!   line by its index (`{"focus":0}`), or an entry of the `dates:` line by its index
//!   (`{"date":1}`, with `"reading":"past"|"upcoming"` when the line gives two, and `"into"`:
//!   `"when"` by default or `"set:<key>"`). A row resolves to its handle and its vault id, a date
//!   to the date expression of its resolution. A `pick` entry also stands where a handle or a
//!   date is written: `{"pick":{…}}` in `linked_to`, `within`, `rows`, `when`, `set`.
//! - a row handle must be one the model can see: the directory, the pre-grounded rows, the
//!   `focus:` line or a visible observation. Anything else is refused with the slot named.
//!
//! THE v4 TRACE (`CONTRACT_V3.md` §8): `"trace": "v4"` among the slots. The model writes fewer
//! slots and this step infers the rest, naming what it inferred in the reply (`inferred`):
//!
//! - a `pick` is one row with its reason (`{"row":"#3","verdict":"ok","reason":"focus"}`), and it
//!   states the rows of the call even beside another handle slot; a pick and an explicit `rows`
//!   or `row` slot together are refused;
//! - an act that names a row by `name` alone (no rows, no other handle slot) and no `kind` takes
//!   the one kind its verb applies to (`complete`: task, `cancel`: event, `log`: person, …):
//!   rule 4 of `normalize.rs`, which a `target` used to feed, now reads the `name`;
//! - `scope` and `refer` are not written: `inferred` carries `scope: one|all` (the rows or the
//!   selector the call names) and `refer: it|that -> …` (a pick whose reason is `focus`, `asked`
//!   or `created`, or a result handle), the values a v3.1 trace had to state.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use crate::dates;
use crate::meta::{FieldType, Kind, Verb};
use crate::normalize::name_lift_report;
use crate::session::Session;
use crate::whr;

/// The order the arguments are written in a call.
pub const CALL_ORDER: [&str; 23] = [
    "verb",
    "op",
    "field",
    "rows",
    "row",
    "kind",
    "group",
    "name",
    "text",
    "trashed",
    "linked_to",
    "within",
    "when",
    "where",
    "exclude",
    "order",
    "limit",
    "more",
    "value",
    "args",
    "options",
    "question",
    "reason",
];

/// Every slot name the compile step reads.
const SLOTS: [&str; 29] = [
    "trace",
    "intent",
    "via",
    "verb",
    "scope",
    "refer",
    "target",
    "kind",
    "op",
    "field",
    "group",
    "trashed",
    "name",
    "text",
    "where",
    "when",
    "linked_to",
    "within",
    "exclude",
    "order",
    "limit",
    "more",
    "set",
    "pick",
    "rows",
    "row",
    "value",
    "options",
    "question",
];
/// The slots that name rows or results (`reason` is plain text).
pub(crate) const HANDLE_SLOTS: [&str; 7] = [
    "rows",
    "row",
    "within",
    "value",
    "linked_to",
    "exclude",
    "options",
];

/// The reasons of a v4 `pick`: why this row is the one.
pub const PICK_REASONS: [&str; 7] = ["name", "kind", "date", "focus", "created", "asked", "nick"];
/// The reasons that say the row is not named by the message but comes from an earlier turn.
const REFER_REASONS: [&str; 3] = ["focus", "asked", "created"];
/// The verbs that act on one row at a time: a selector under one of them stands for one row.
pub const SINGLE_ROW_VERBS: [&str; 6] = [
    "edit",
    "reschedule",
    "log",
    "reveal",
    "settle_up",
    "settle_debt",
];

/// A slot that does not compile.
struct Refusal {
    slot: String,
    why: String,
}

type Compiled<T> = Result<T, Refusal>;

fn refuse<T>(slot: impl Into<String>, why: impl Into<String>) -> Compiled<T> {
    Err(Refusal {
        slot: slot.into(),
        why: why.into(),
    })
}

/// What picks resolved to, for the answer.
#[derive(Default)]
struct Resolved {
    picks: Vec<Value>,
    dates: Vec<Value>,
}

impl Session {
    /// Compile the slots of a trace into the call the runtime will execute.
    pub fn compile(&mut self, slots: &Value) -> Value {
        match self.compile_slots(slots) {
            Ok(done) => done,
            Err(refusal) => json!({"refused": {"slot": refusal.slot, "why": refusal.why}}),
        }
    }

    fn compile_slots(&mut self, slots: &Value) -> Compiled<Value> {
        let Some(slots) = slots.as_object() else {
            return refuse("slots", "slots is an object of slot name to value");
        };
        if let Some(unknown) = slots
            .keys()
            .find(|key| !SLOTS.contains(&key.as_str()) && key.as_str() != "reason")
        {
            return refuse(unknown.clone(), format!("no slot \"{unknown}\""));
        }
        let v4 = match slots.get("trace") {
            None | Some(Value::Null) => false,
            Some(Value::String(text)) if text == "v3.1" => false,
            Some(Value::String(text)) if text == "v4" => true,
            Some(_) => return refuse("trace", "trace is \"v3.1\" or \"v4\""),
        };
        let intent = match slots.get("intent").and_then(Value::as_str) {
            Some(intent @ ("read" | "count" | "write" | "ask" | "decline")) => intent,
            Some(other) => {
                return refuse(
                    "intent",
                    format!("intent is read, count, write, ask or decline, not \"{other}\""),
                );
            }
            None => return refuse("intent", "every trace has an intent"),
        };
        let tool = match slots.get("via").and_then(Value::as_str) {
            Some(via @ ("find" | "search" | "open" | "compute")) => via,
            Some(other) => {
                return refuse(
                    "via",
                    format!("via is find, search, open or compute, not \"{other}\""),
                );
            }
            None => default_tool(intent),
        };
        let mut resolved = Resolved::default();
        let mut args: Map<String, Value> = Map::new();

        if tool == "act" {
            let Some(verb) = slots.get("verb").and_then(Value::as_str) else {
                return refuse("verb", "an act needs a verb");
            };
            if Verb::parse(verb).is_none() {
                return refuse("verb", format!("no verb \"{verb}\""));
            }
            args.insert("verb".to_owned(), json!(verb));
        }
        for key in ["op", "field", "group", "name", "text", "question", "reason"] {
            if let Some(value) = slots.get(key).filter(|value| !value.is_null()) {
                let Some(text) = value.as_str() else {
                    return refuse(key, format!("{key} is text"));
                };
                args.insert(key.to_owned(), json!(text));
            }
        }
        if let Some(value) = slots.get("kind").filter(|value| !value.is_null()) {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Array(items) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
                _ => return refuse("kind", "kind is a kind name or a list of them"),
            };
            args.insert("kind".to_owned(), json!(text));
        }
        for key in ["trashed", "more"] {
            if let Some(value) = slots.get(key).filter(|value| !value.is_null()) {
                let flag = value
                    .as_bool()
                    .or_else(|| value.as_str().and_then(crate::whr::parse_bool));
                let Some(flag) = flag else {
                    return refuse(
                        key,
                        crate::whr::bool_error(key, &value.to_string())
                            .trim_start_matches("error: ")
                            .to_owned(),
                    );
                };
                args.insert(key.to_owned(), json!(flag));
            }
        }
        if let Some(value) = slots.get("limit").filter(|value| !value.is_null()) {
            let number = match value {
                Value::Number(number) => number.as_i64(),
                Value::String(text) => text.trim().parse().ok(),
                _ => None,
            };
            match number {
                Some(limit) if limit >= 1 => {
                    args.insert("limit".to_owned(), json!(limit));
                }
                _ => return refuse("limit", "limit is a positive whole number"),
            }
        }
        if let Some(value) = slots.get("order").filter(|value| !value.is_null()) {
            args.insert("order".to_owned(), json!(order_text(value)?));
        }

        // the picks first: they fix the handles the other slots may name
        let picked = self.compile_picks(slots.get("pick"), &mut resolved)?;

        for key in HANDLE_SLOTS {
            let Some(value) = slots.get(key).filter(|value| !value.is_null()) else {
                continue;
            };
            let handles = self.compile_handles(key, value, &mut resolved)?;
            let scalar = matches!(key, "row" | "within" | "value");
            if scalar {
                if handles.len() != 1 {
                    return refuse(key, format!("{key} is exactly one handle"));
                }
                args.insert(key.to_owned(), json!(handles[0]));
            } else {
                args.insert(key.to_owned(), json!(handles));
            }
        }
        let explicit = HANDLE_SLOTS.iter().any(|key| args.contains_key(*key));
        if v4 && !picked.rows.is_empty() && (args.contains_key("rows") || args.contains_key("row"))
        {
            return refuse(
                "pick",
                "a pick and a rows slot both name the rows; write one",
            );
        }
        // a v3.1 pick states the rows only when no other handle slot does; a v4 pick always does
        if pick_states_rows(v4, explicit) && !picked.rows.is_empty() {
            let key = rows_key(tool);
            if tool == "open" {
                args.insert(key.to_owned(), json!(picked.rows[0]));
            } else {
                args.insert(key.to_owned(), json!(picked.rows));
            }
        }

        if let Some(value) = slots.get("when").filter(|value| !value.is_null()) {
            let expr = self.compile_date("when", value, &mut resolved)?;
            args.insert("when".to_owned(), json!(date_text(&expr)));
        } else if let Some(expr) = picked.when {
            args.insert("when".to_owned(), json!(date_text(&expr)));
        }
        // conditions on `name` are no `where` (`where has no name field`): `name = "x"` is the
        // `name` selector, any other operator is left out (`normalize.rs`, rule 5)
        let mut notes: Vec<String> = Vec::new();
        let mut entries: Vec<Value> = Vec::new();
        let mut inferred: Vec<String> = Vec::new();
        let mut conds = slots.get("where").filter(|value| !value.is_null()).cloned();
        if let Some(Value::Array(list)) = &conds {
            let (kept, lifted, mut dropped) = self.split_name_conditions(list);
            if kept.len() != list.len() {
                let have = args
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.trim().to_lowercase());
                let mut names: Vec<String> = Vec::new();
                for name in lifted {
                    match &have {
                        Some(have) if *have == name.to_lowercase() => {}
                        Some(_) => dropped.push(format!("name = \"{name}\"")),
                        None if names.is_empty() => names.push(name),
                        None => dropped.push(format!("name = \"{name}\"")),
                    }
                }
                if let Some(name) = names.first() {
                    args.insert("name".to_owned(), json!(name));
                }
                let (said, kept_entries) = name_lift_report(&names, &dropped);
                notes.extend(said);
                entries.extend(kept_entries);
                conds = (!kept.is_empty()).then_some(Value::Array(kept));
            }
        }
        if v4 {
            infer_kind(tool, slots, &mut args, &mut inferred);
        }
        if let Some(value) = conds.as_ref() {
            let text = self.compile_where(slots, &args, value)?;
            args.insert("where".to_owned(), json!(text));
        }
        if let Some(value) = slots.get("set").filter(|value| !value.is_null()) {
            let text = self.compile_set(value, &picked.into_set, &mut resolved)?;
            args.insert("args".to_owned(), json!(text));
        } else if !picked.into_set.is_empty() {
            let lines: Vec<String> = picked
                .into_set
                .iter()
                .map(|(key, expr)| format!("{key}: {expr}"))
                .collect();
            args.insert("args".to_owned(), json!(lines.join("\n")));
        }

        let mut ordered = Map::new();
        for key in CALL_ORDER {
            if let Some(value) = args.remove(key) {
                ordered.insert(key.to_owned(), value);
            }
        }
        if v4 {
            self.infer_scope_and_refer(tool, slots, &ordered, &picked.reasons, &mut inferred);
        }
        let stated = json!({"tool": tool, "args": Value::Object(ordered.clone())});
        // the call a malformed trace states is repaired here, before its first send; the
        // trace's `target` is the name of a write whose every pick was rejected (rule 4)
        let target = match slots.get("target") {
            Some(Value::String(text)) => Some(text.as_str()),
            Some(Value::Array(spans)) => spans.iter().find_map(Value::as_str),
            _ => None,
        };
        let mut repaired = self.normalize(tool, &Value::Object(ordered), target);
        notes.append(&mut repaired.notes);
        entries.append(&mut repaired.entries);
        let (grounded, grounding) = self.ground(tool, &repaired.args);
        // a default the grounding filled is recorded like a repair, and its note rides with the
        // call: the step that runs `call` finds the slot filled and has nothing left to say
        let defaults = crate::follow::default_notes(&grounding);
        entries.extend(crate::follow::default_entries(&defaults));
        let mut carried = notes.clone();
        carried.extend(defaults);
        self.remember_compiled(tool, &grounded, &carried, &entries);
        notes.extend(grounding);
        let mut reply = json!({
            "call": {"tool": tool, "args": grounded},
            "stated": stated,
            "notes": notes,
            "normalized": entries,
            "resolved": {"picks": resolved.picks, "dates": resolved.dates},
        });
        if v4 {
            reply["inferred"] = json!(inferred);
        }
        Ok(reply)
    }

    /// The `#n` the model can see: the directory, the pre-grounded rows, the `focus:` line and
    /// the rows of the observations still shown.
    fn block_numbers(&self) -> BTreeSet<usize> {
        let mut out: BTreeSet<usize> = self.directory.iter().copied().collect();
        out.extend(self.preground.iter().copied());
        if let Some(line) = crate::prompt::focus_line(self) {
            out.extend(numbers_in(&line));
        }
        for obs in &self.observations {
            out.extend(obs.visible());
        }
        out.extend(self.acted.iter().copied());
        out.extend(self.created.iter().copied());
        out
    }

    /// One `#n` or `@n` the slot names: the handle itself, or refused with the slot.
    fn check_handle(&self, slot: &str, handle: &str) -> Compiled<String> {
        let handle = handle.trim();
        if handle.starts_with('@') {
            return match self.resolve_result(handle) {
                Ok(_) => Ok(handle.to_owned()),
                Err(why) => refuse(slot, why.trim_start_matches("error: ").to_owned()),
            };
        }
        let number = handle
            .strip_prefix('#')
            .and_then(|digits| digits.parse::<usize>().ok());
        let Some(number) = number else {
            return refuse(slot, format!("\"{handle}\" is not a row; rows are #n"));
        };
        if !self.block_numbers().contains(&number) {
            return refuse(slot, format!("#{number} is not in the block"));
        }
        match self.resolve_row(handle) {
            Ok(_) => Ok(format!("#{number}")),
            Err(why) => refuse(slot, why.trim_start_matches("error: ").to_owned()),
        }
    }

    /// The handles of a handle slot: strings, lists of them, or `{"pick":…}` entries.
    fn compile_handles(
        &self,
        slot: &str,
        value: &Value,
        resolved: &mut Resolved,
    ) -> Compiled<Vec<String>> {
        let items: Vec<&Value> = match value {
            Value::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        let mut out: Vec<String> = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let place = if matches!(value, Value::Array(_)) {
                format!("{slot}[{index}]")
            } else {
                slot.to_owned()
            };
            let handle = match item {
                Value::String(text) => {
                    for part in crate::session::handle_list(&Value::String(text.clone())) {
                        let checked = self.check_handle(&place, &part)?;
                        if !out.contains(&checked) {
                            out.push(checked);
                        }
                    }
                    continue;
                }
                Value::Object(object) if object.contains_key("pick") => {
                    self.compile_row_pick(&place, &object["pick"], resolved)?
                }
                _ => return refuse(place, "a handle is \"#n\", \"@n\" or {\"pick\": …}"),
            };
            if !out.contains(&handle) {
                out.push(handle);
            }
        }
        if out.is_empty() {
            return refuse(slot, format!("{slot} names no row"));
        }
        Ok(out)
    }

    /// A row pick written where a handle goes: `{"row":"#3"}` or `{"focus":0}`, or `"#3"`.
    fn compile_row_pick(
        &self,
        place: &str,
        pick: &Value,
        resolved: &mut Resolved,
    ) -> Compiled<String> {
        let handle = match pick {
            Value::String(text) => self.check_handle(place, text)?,
            Value::Object(object) => {
                if let Some(row) = object.get("row").and_then(Value::as_str) {
                    self.check_handle(place, row)?
                } else if let Some(index) = object.get("focus").and_then(Value::as_u64) {
                    self.focus_handle(place, index)?
                } else {
                    return refuse(place, "a pick names a row (\"row\" or \"focus\")");
                }
            }
            _ => return refuse(place, "a pick is \"#n\" or an object"),
        };
        self.note_pick(place, &handle, resolved);
        Ok(handle)
    }

    /// The `index`-th row of the `focus:` line, as `#n`.
    fn focus_handle(&self, place: &str, index: u64) -> Compiled<String> {
        let numbers: Vec<usize> = crate::prompt::focus_line(self)
            .map(|line| numbers_in(&line))
            .unwrap_or_default();
        usize::try_from(index)
            .ok()
            .and_then(|index| numbers.get(index))
            .map(|number| format!("#{number}"))
            .map_or_else(
                || {
                    refuse(
                        place,
                        format!(
                            "the focus line holds {} rows, not {}",
                            numbers.len(),
                            index + 1
                        ),
                    )
                },
                Ok,
            )
    }

    fn note_pick(&self, place: &str, handle: &str, resolved: &mut Resolved) {
        let Some(number) = handle
            .strip_prefix('#')
            .and_then(|digits| digits.parse::<usize>().ok())
        else {
            return;
        };
        if let Some(key) = self.by_number.get(number - 1) {
            let name = self
                .world
                .row(key)
                .map(|row| row.name.clone())
                .unwrap_or_default();
            resolved.picks.push(
                json!({"slot": place, "handle": handle, "id": key.1, "kind": key.0.name(), "name": name}),
            );
        }
    }

    /// The `pick` slot: verdicts on rows, focus rows and dates-line entries.
    fn compile_picks(&self, value: Option<&Value>, resolved: &mut Resolved) -> Compiled<Picked> {
        let mut picked = Picked::default();
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Ok(picked);
        };
        let Some(entries) = value.as_array() else {
            return refuse("pick", "pick is a list of entries");
        };
        for (index, entry) in entries.iter().enumerate() {
            let place = format!("pick[{index}]");
            let Some(object) = entry.as_object() else {
                return refuse(place, "a pick entry is an object");
            };
            let verdict = object
                .get("verdict")
                .and_then(Value::as_str)
                .unwrap_or("ok");
            if verdict != "ok" && verdict != "no" {
                return refuse(place, "verdict is ok or no");
            }
            let reason = match object.get("reason") {
                None | Some(Value::Null) => None,
                Some(Value::String(text)) if PICK_REASONS.contains(&text.as_str()) => {
                    Some(text.clone())
                }
                Some(_) => {
                    return refuse(
                        place,
                        format!("a pick's reason is one of {}", PICK_REASONS.join(", ")),
                    );
                }
            };
            if object.contains_key("date") {
                let expr = self.pick_date(&place, object, resolved)?;
                match object.get("into").and_then(Value::as_str).unwrap_or("when") {
                    "when" => picked.when = Some(expr),
                    into => match into.strip_prefix("set:") {
                        Some(key) if !key.is_empty() => {
                            picked.into_set.push((key.to_owned(), date_text(&expr)));
                        }
                        _ => return refuse(place, "into is \"when\" or \"set:<key>\""),
                    },
                }
                continue;
            }
            let handle = self.compile_row_pick(&place, &Value::Object(object.clone()), resolved)?;
            if verdict == "ok" && !picked.rows.contains(&handle) {
                picked.rows.push(handle);
                picked.reasons.extend(reason);
            }
        }
        Ok(picked)
    }

    /// A dates-line entry as the date expression of its resolution.
    fn pick_date(
        &self,
        place: &str,
        pick: &Map<String, Value>,
        resolved: &mut Resolved,
    ) -> Compiled<Value> {
        let readings = self.date_readings(&self.message);
        let Some(index) = pick.get("date").and_then(Value::as_u64) else {
            return refuse(place, "date is the index of an entry of the dates line");
        };
        let Some(reading) = usize::try_from(index)
            .ok()
            .and_then(|index| readings.get(index))
        else {
            return refuse(
                place,
                format!(
                    "the dates line holds {} entries, not {}",
                    readings.len(),
                    index + 1
                ),
            );
        };
        let which = pick.get("reading").and_then(Value::as_str);
        match reading_expr(&reading.resolution, which) {
            Ok(expr) => {
                resolved.dates.push(json!({
                    "slot": place,
                    "phrase": reading.phrase,
                    "resolution": reading.resolution,
                    "expr": expr,
                }));
                Ok(expr)
            }
            Err(why) => refuse(place, format!("\"{}\": {why}", reading.phrase)),
        }
    }

    /// A date expression: as written, or a pick of the dates line.
    fn compile_date(&self, slot: &str, value: &Value, resolved: &mut Resolved) -> Compiled<Value> {
        let expr = match value {
            Value::Object(object) if object.len() == 1 && object.contains_key("pick") => {
                match object["pick"].as_object() {
                    Some(pick) => self.pick_date(slot, pick, resolved)?,
                    None => return refuse(slot, "a date pick is {\"pick\":{\"date\":index}}"),
                }
            }
            Value::String(text) => match serde_json::from_str::<Value>(text) {
                Ok(parsed) => parsed,
                Err(_) => return refuse(slot, "a date is a date expression object"),
            },
            other => other.clone(),
        };
        // the runtime reads a lenient form (`9pm`, `"rel": "1"`, nt12 R3) and says so when the
        // call runs; the compile step keeps the expression as it was written
        let readable = if self.flags.normalize {
            dates::lenient(&expr).0
        } else {
            expr.clone()
        };
        match dates::parse(&readable) {
            Ok(_) => Ok(expr),
            Err(why) => refuse(slot, dates::rejection(&why).trim_start_matches("error: ")),
        }
    }

    /// `where` from typed conditions.
    fn compile_where(
        &self,
        slots: &Map<String, Value>,
        args: &Map<String, Value>,
        value: &Value,
    ) -> Compiled<String> {
        if value.is_string() {
            return refuse(
                "where",
                "where is a list of {field, op, value} conditions, not text",
            );
        }
        let Some(conds) = value.as_array() else {
            return refuse("where", "where is a list of {field, op, value} conditions");
        };
        let kind = slots
            .get("kind")
            .and_then(|kind| match kind {
                Value::String(text) => Some(text.clone()),
                Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
                _ => None,
            })
            .and_then(|text| {
                text.split(',')
                    .next()
                    .and_then(|part| Kind::parse(part.trim()))
            })
            .or_else(|| {
                args.get("kind")
                    .and_then(Value::as_str)
                    .and_then(|text| Kind::parse(text.trim()))
            })
            .or_else(|| {
                args.get("within")
                    .and_then(Value::as_str)
                    .and_then(|handle| self.resolve_result(handle).ok())
                    .and_then(|handle| self.results[handle - 1].kinds.first().copied())
            });
        let Some(kind) = kind else {
            return refuse("where", "where needs the kind slot (fields are per kind)");
        };
        let mut parts: Vec<String> = Vec::new();
        for (index, cond) in conds.iter().enumerate() {
            let place = format!("where[{index}]");
            let text = render_cond(kind, cond).map_err(|why| Refusal {
                slot: place.clone(),
                why,
            })?;
            if let Err(why) = whr::parse(kind, &text) {
                return refuse(place, why.trim_start_matches("error: ").to_owned());
            }
            parts.push(text);
        }
        if parts.is_empty() {
            return refuse("where", "where holds no condition");
        }
        Ok(parts.join(" and "))
    }

    /// `set` into the lines of an act's `args`.
    fn compile_set(
        &self,
        value: &Value,
        picked: &[(String, String)],
        resolved: &mut Resolved,
    ) -> Compiled<String> {
        let Some(entries) = value.as_array() else {
            return refuse("set", "set is a list of {key, value} entries");
        };
        let mut lines: Vec<String> = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let place = format!("set[{index}]");
            let Some(object) = entry.as_object() else {
                return refuse(place, "a set entry is {key, value} or {key, date}");
            };
            let Some(key) = object.get("key").and_then(Value::as_str) else {
                return refuse(place, "a set entry has a key");
            };
            if let Some(date) = object.get("date") {
                let expr = self.compile_date(&place, date, resolved)?;
                lines.push(format!("{key}: {}", date_text(&expr)));
            } else if let Some(value) = object.get("value") {
                let text = match value {
                    Value::String(text) => text.clone(),
                    Value::Object(object) if object.contains_key("pick") => {
                        self.compile_row_pick(&place, &object["pick"], resolved)?
                    }
                    Value::Number(number) => number.to_string(),
                    Value::Bool(flag) => flag.to_string(),
                    _ => return refuse(place, "a set value is text, a number or a pick"),
                };
                lines.push(format!("{key}: {text}"));
            } else {
                return refuse(place, "a set entry has a value or a date");
            }
        }
        for (key, expr) in picked {
            lines.push(format!("{key}: {expr}"));
        }
        Ok(lines.join("\n"))
    }
}

/// The tool a trace's intent calls when no `via` says otherwise (`read` and `count` an `answer`, a write an `act`).
pub(crate) fn default_tool(intent: &str) -> &'static str {
    match intent {
        "read" | "count" => "answer",
        "write" => "act",
        "ask" => "ask",
        _ => "decline",
    }
}

/// The argument a call states its rows under: `row` for an `open`, else `rows`.
pub(crate) fn rows_key(tool: &str) -> &'static str {
    if tool == "open" { "row" } else { "rows" }
}

/// Does a pick state the rows of the call? A v4 pick always does; a v3.1 pick only when no other handle slot is explicit.
pub(crate) fn pick_states_rows(v4: bool, explicit_handle_slot: bool) -> bool {
    v4 || !explicit_handle_slot
}

/// The one kind a verb applies to (`complete`: task, `cancel`: event, `log`: person, ...), when it applies to exactly one:
/// what an act that names a row by `name` alone takes as its `kind` in a v4 trace.
pub(crate) fn kind_a_verb_fixes(verb: Option<&str>) -> Option<&'static str> {
    let kinds = verb.and_then(Verb::parse)?.kinds();
    match kinds.as_slice() {
        [only] => Some(only.name()),
        _ => None,
    }
}

/// v4: does an act that names a row by `name` alone (no other handle slot) and says no `kind` take the kind its verb fixes?
pub(crate) fn infers_kind(
    tool: &str,
    has_kind: bool,
    has_name: bool,
    has_handle_slot: bool,
) -> bool {
    tool == "act" && !has_kind && has_name && !has_handle_slot
}

/// v4: an act that names a row by `name` alone (no rows, no other handle slot) and says no `kind` takes the one kind its verb
/// applies to.
fn infer_kind(
    tool: &str,
    slots: &Map<String, Value>,
    args: &mut Map<String, Value>,
    inferred: &mut Vec<String>,
) {
    // any handle slot (`within` carries its own kind, `linked_to` its own context) leaves the kind to the model
    let has_handle_slot = HANDLE_SLOTS.iter().any(|key| args.contains_key(*key));
    if !infers_kind(
        tool,
        args.contains_key("kind"),
        args.contains_key("name"),
        has_handle_slot,
    ) {
        return;
    }
    if let Some(only) = kind_a_verb_fixes(slots.get("verb").and_then(Value::as_str)) {
        args.insert("kind".to_owned(), json!(only));
        inferred.push(format!("kind: {only}"));
    }
}

impl Session {
    /// v4: the `scope` and `refer` a v3.1 trace had to state, read off the call instead. A write
    /// on rows is `one` for one row and `all` for more; one by a selector is `all` unless its
    /// verb acts on a single row. A pick whose reason is `focus`, `asked` or `created`, or a
    /// result handle, is a `refer`.
    fn infer_scope_and_refer(
        &self,
        tool: &str,
        slots: &Map<String, Value>,
        args: &Map<String, Value>,
        reasons: &[String],
        inferred: &mut Vec<String>,
    ) {
        let rows = args
            .get("rows")
            .or_else(|| args.get("row"))
            .filter(|value| !value.is_null());
        let verb = slots
            .get("verb")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let count = rows.and_then(|rows| self.resolve_rows(rows).ok().map(|keys| keys.len()));
        if tool == "act" && !matches!(verb, "create" | "undo") {
            let scope = match (count, Self::has_selector(args)) {
                (Some(1), _) => Some("one"),
                (Some(_), _) => Some("all"),
                (None, true) if SINGLE_ROW_VERBS.contains(&verb) => Some("one"),
                (None, true) => Some("all"),
                (None, false) => None,
            };
            inferred.extend(scope.map(|scope| format!("scope: {scope}")));
        }
        let Some(rows) = rows else {
            return;
        };
        let handles = crate::session::handle_list(rows);
        let from_result = handles.iter().any(|handle| handle.starts_with('@'));
        if reasons
            .iter()
            .any(|reason| REFER_REASONS.contains(&reason.as_str()))
            || from_result
        {
            let kind = if count == Some(1) { "it" } else { "that" };
            inferred.push(format!("refer: {kind} -> {}", handles.join(", ")));
        }
    }
}

/// The rows, the `when` and the `set` lines the `pick` slot stands for.
#[derive(Default)]
struct Picked {
    rows: Vec<String>,
    /// The reasons of the `ok` rows, in order (v4 picks).
    reasons: Vec<String>,
    when: Option<Value>,
    into_set: Vec<(String, String)>,
}

/// The keys of a date expression in the order a call writes them.
pub(crate) const DATE_KEY_ORDER: [&str; 9] = [
    "from", "to", "date", "unit", "rel", "name", "weekday", "time", "anchor",
];

/// A date expression as call text: compact JSON, keys in the order a call writes them.
pub(crate) fn date_text(expr: &Value) -> String {
    match expr {
        Value::Object(object) => {
            let mut parts: Vec<String> = Vec::new();
            for key in DATE_KEY_ORDER {
                if let Some(value) = object.get(key) {
                    parts.push(format!("\"{key}\":{}", date_text(value)));
                }
            }
            for (key, value) in object {
                if !DATE_KEY_ORDER.contains(&key.as_str()) {
                    parts.push(format!("\"{key}\":{}", date_text(value)));
                }
            }
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// `#n` numbers in a line, in order, once each.
fn numbers_in(line: &str) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'#' {
            let digits: String = line[index + 1..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(number) = digits.parse::<usize>()
                && !out.contains(&number)
            {
                out.push(number);
            }
            index += 1 + digits.len();
        } else {
            index += 1;
        }
    }
    out
}

/// `order` as the call carries it: `"date asc"`, or `{"field","dir"}`.
fn order_text(value: &Value) -> Compiled<String> {
    match value {
        Value::String(text) => Ok(text.trim().to_owned()),
        Value::Object(object) => {
            let field = object.get("field").and_then(Value::as_str);
            let dir = object.get("dir").and_then(Value::as_str).unwrap_or("asc");
            match field {
                Some(field) if matches!(dir, "asc" | "desc") => Ok(format!("{field} {dir}")),
                _ => refuse("order", "order is \"field asc|desc\" or {field, dir}"),
            }
        }
        _ => refuse("order", "order is \"field asc|desc\" or {field, dir}"),
    }
}

/// The one spelling of a typed condition.
fn render_cond(kind: Kind, cond: &Value) -> Result<String, String> {
    let Some(object) = cond.as_object() else {
        return Err("a condition is {field, op, value}".to_owned());
    };
    let op = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or("a condition has an op")?;
    if let Some(link) = object.get("link").and_then(Value::as_str) {
        let count = object
            .get("value")
            .and_then(Value::as_i64)
            .ok_or("a linked count has a whole number value")?;
        if !matches!(op, "=" | "!=" | "<" | "<=" | ">" | ">=") {
            return Err(format!("no comparison \"{op}\""));
        }
        return Ok(format!("{link} count {op} {count}"));
    }
    let field = object
        .get("field")
        .and_then(Value::as_str)
        .ok_or("a condition has a field")?;
    match op {
        "is empty" | "is set" => Ok(format!("{field} {op}")),
        "in" => {
            let items = object
                .get("value")
                .and_then(Value::as_array)
                .ok_or("in takes a list of values")?;
            let quoted: Vec<String> = items.iter().map(|item| quoted(&text_of(item))).collect();
            Ok(format!("{field} in ({})", quoted.join(", ")))
        }
        "contains" => {
            let text = object.get("value").map(text_of).unwrap_or_default();
            Ok(format!("{field} contains {}", quoted(&text)))
        }
        "=" | "!=" | "<" | "<=" | ">" | ">=" => {
            let value = object.get("value").ok_or("a condition has a value")?;
            let ty = kind.spec().field(field).map(|spec| spec.ty);
            let rendered = match (ty, value) {
                (Some(FieldType::Number | FieldType::Money), Value::Number(number)) => {
                    number.to_string()
                }
                (Some(FieldType::Number | FieldType::Money), Value::String(text)) => {
                    text.trim().to_owned()
                }
                (Some(FieldType::Bool), Value::Bool(flag)) => {
                    if *flag { "yes" } else { "no" }.to_owned()
                }
                (_, Value::String(text)) => quoted(text),
                (_, Value::Number(number)) => number.to_string(),
                (_, Value::Bool(flag)) => if *flag { "yes" } else { "no" }.to_owned(),
                _ => return Err("a condition value is text, a number or yes/no".to_owned()),
            };
            let rendered = match object.get("currency").and_then(Value::as_str) {
                Some(code) => format!("{rendered} {code}"),
                None => rendered,
            };
            Ok(format!("{field} {op} {rendered}"))
        }
        other => Err(format!("no comparison \"{other}\"")),
    }
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "'"))
}

/// A `dates:` resolution as a date expression: a day, a day with a clock, or a range (an open
/// end is left out). A clock alone is not a date.
pub(crate) fn reading_expr(resolution: &str, which: Option<&str>) -> Result<Value, String> {
    let resolution = without_source(resolution.trim());
    if let Some((first, second)) = resolution.split_once(" / ") {
        let pick = |text: &str, tag: &str| {
            text.trim()
                .strip_suffix(tag)
                .map(|rest| rest.trim().to_owned())
        };
        let (past, upcoming) = (pick(first, "(past)"), pick(second, "(upcoming)"));
        return match (which, past, upcoming) {
            (Some("past"), Some(past), _) => reading_expr(&past, None),
            (Some("upcoming"), _, Some(upcoming)) => reading_expr(&upcoming, None),
            (None, Some(_), Some(_)) => {
                Err("two readings; say \"reading\": \"past\" or \"upcoming\"".to_owned())
            }
            _ => Err("a clock reads am or pm; write the time in the call".to_owned()),
        };
    }
    if let Some((from, to)) = resolution.split_once("..") {
        let mut out = Map::new();
        if !from.trim().is_empty() {
            out.insert("from".to_owned(), day_expr(from.trim())?);
        }
        if !to.trim().is_empty() {
            out.insert("to".to_owned(), day_expr(to.trim())?);
        }
        if out.is_empty() {
            return Err("an empty range".to_owned());
        }
        return Ok(Value::Object(out));
    }
    day_expr(resolution)
}

/// A resolution without the note that says where it came from: `2027-02-08 (the eighth, turn 2)`
/// and `..2027-03-11 (#30 event "Flight to Berlin")` are the dates before the parenthesis. A
/// pair's `(past)` and `(upcoming)` are no note.
fn without_source(resolution: &str) -> &str {
    match resolution.split_once(" (") {
        Some((head, tail)) if tail.ends_with(')') && !resolution.contains(" / ") => head,
        _ => resolution,
    }
}

/// `2026-10-06` or `2026-10-06 13:00`.
fn day_expr(text: &str) -> Result<Value, String> {
    let (day, clock) = match text.split_once(' ') {
        Some((day, clock)) => (day, Some(clock.trim())),
        None => (text, None),
    };
    let digits =
        |part: &str, len: usize| part.len() == len && part.chars().all(|c| c.is_ascii_digit());
    let is_day = day.len() == 10
        && day.split('-').count() == 3
        && day
            .split('-')
            .zip([4, 2, 2])
            .all(|(part, len)| digits(part, len));
    if !is_day {
        return Err(format!("\"{text}\" is a clock, not a date"));
    }
    match clock {
        None => Ok(json!({"date": day})),
        Some(clock) if clock.len() == 5 && clock.as_bytes()[2] == b':' => {
            Ok(json!({"date": day, "time": clock}))
        }
        Some(other) => Err(format!("cannot read \"{other}\"")),
    }
}
