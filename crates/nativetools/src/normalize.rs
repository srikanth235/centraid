//! NORMALISING A MALFORMED CALL BEFORE ITS FIRST SEND (#1044, slice H1b).
//!
//! The replay of the trained model shows that most calls the runtime refuses and then
//! sees repeated are malformed WRITES the runtime could have repaired the first time:
//! an arg a kind does not take, a `when` on a create, a container of the wrong kind, a
//! `where` on `name`, a selector beside explicit rows. Each repair here changes nothing
//! the person asked for, never guesses a row, and says so:
//!
//! - a `note:` line under the reply (`Session::pending_notes`);
//! - a `normalized: [{rule, …}]` entry in the effect, for audit.
//!
//! The rules run in `Session::step` on every call (a hand-written one, or the one the
//! compile step built), before the date grounding, and in `Session::compile`, which also
//! knows the trace's `target` slot (rule 4). A compiled call arrives already repaired, so
//! compile leaves what it did in `Session::compiled`, and the step that runs that very call
//! reports it (`carry_over`). The repeat fail-soft (`failsoft.rs`) stays the backstop.
//!
//! 1. `create` args the kind does not take are dropped (`ignored area: family (notebooks
//!    have no area)`). A locker secret (`password`, `code`, `card_number`, `cvv`) is kept
//!    when the item's type keeps it, and sealed by the create; a type that keeps no such
//!    column loses it, and the note says the secret was not stored (never its value).
//! 2. `when` on a create is dropped; with no `date:` in the args and `when` one day or
//!    instant, it becomes the `date:` arg.
//! 3. `list: #n` of a task is `parent: #n`, `parent: #n` of a list is `list: #n`; a
//!    `notebook:`, `folder:`, `album:` (or either of those two) that points at a row
//!    which is not that container is dropped. A container is never guessed.
//! 4. An act with no rows and no selector (every pick candidate was rejected), whose trace
//!    has a `target:`, matches by `name: <target>` and the verb's one kind, so the
//!    runtime's own matching (fuzzy, nickname) runs.
//! 5. A `where` clause on `name` (the parser refuses them all): `name = "x"` and `name contains
//!    "x"` become the `name:` selector, any other operator drops the clause; the rest of the `where` stays.
//! 6. An act with explicit `rows` beside a selector runs on the rows (the selector's
//!    `kind` stays, as the check it is).
//! 8. A `where` of one field joined by `or` is `in (...)`; a number in a unit with a fixed
//!    conversion (`effort > 1 hour`, `cadence: 2 weeks`) is the field's own unit.
//! 10. (nt13 R1) An enumerated value written loosely (`type = bank` for `bank_account`,
//!     `status = canceled`, a currency name or a near code) is the one value it means, in a
//!     `where` and in an `edit` or `create` arg (`whr::resolve_where`, `resolve_arg`).
//! 11. (nt13 R5) A compute's `group` written as a condition (`starred = yes`) groups by its field.
//! 12. (nt14 N4) A `reveal`'s `field` written as another name for a secret (`2fa`, `cvc`,
//!     `card no`, `pw`) is the field the item keeps (`REVEAL_SYNONYMS`, a closed table; `pin`
//!     and every other word stay the error), with `note: read field 2fa as code`.
//! 13. (nt15 R1a) A condition on `note count` of a task or an event (`note count = 0`, `> 0`) is the
//!     condition on its `description` that says the same (`description is empty`, `is set`):
//!     their notes are their description (`whr::notes_as_description`).
//! 14. (nt15 R1b) `within: #43, #44` names rows, not a result: it is `rows: #43, #44` when every
//!     `#n` is a row and nothing else selects (`Session::within_rows`).
//! 16. (nt15 R2b) `notes+:` of a task is `description+:` (the append form, `act::appended`).
//! 15. (nt15 R1c) A `linked_to` that names rows of several kinds keeps the ones the kind is linked
//!     to when at least one is (`Session::keep_valid_links`).
//! 7. A `when` written leniently (`9pm`, `"rel": "1"`, a weekday or a month as a word) is the
//!    grammar's own form, with a note (`dates::lenient`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::act::{arg_lines, arg_value, create_allowed, create_arg_alias};
use crate::dates;
use crate::meta::{self, Kind};
use crate::session::{Session, arg_str, canonical_json};
use crate::whr;

/// A call after its repairs: the args, one `note:` line and one `normalized` entry each.
pub(crate) struct Normalized {
    pub args: Value,
    pub notes: Vec<String>,
    pub entries: Vec<Value>,
}

/// What the compile step repaired in the call it returned, kept for the step that runs
/// that call (`Session::carry_over`).
#[derive(Debug, Clone)]
pub(crate) struct Carry {
    tool: String,
    fingerprint: String,
    notes: Vec<String>,
    entries: Vec<Value>,
}

/// A call's args as one comparable text, whatever a round trip through the call's text
/// did to the types (a list of handles written as `#1, #2`, a flag as `true`).
fn fingerprint(tool: &str, args: &Value) -> String {
    let Some(object) = args.as_object() else {
        return format!("{tool} {}", canonical_json(args));
    };
    let flat: BTreeMap<&String, String> = object
        .iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Array(items) => items
                    .iter()
                    .map(|item| match item {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
                other => other.to_string(),
            };
            (key, text.split_whitespace().collect::<Vec<_>>().join(" "))
        })
        .collect();
    format!("{tool} {flat:?}")
}

/// A create's `args` as the call language writes them: `field: value` lines, in the order
/// written, each value the text of its line (a JSON value is its compact JSON). A repair edits
/// the lines and the args stay that string, so the call renders and re-reads as written.
struct ArgLines(Vec<(String, String)>);

impl ArgLines {
    /// The lines of `args` as the model wrote them: lines, or an object (one line per field).
    fn read(value: Option<&Value>) -> Result<Self, String> {
        Ok(Self(match value {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Object(map)) => map
                .iter()
                .map(|(key, value)| (key.to_lowercase(), text_of(value)))
                .collect(),
            Some(Value::String(text)) => {
                let trimmed = text.trim();
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(Value::Object(map)) if trimmed.starts_with('{') => map
                        .iter()
                        .map(|(key, value)| (key.to_lowercase(), text_of(value)))
                        .collect(),
                    _ => arg_lines(trimmed)?,
                }
            }
            Some(other) => return Err(format!("error: args are lines, not {other}.")),
        }))
    }

    fn has(&self, key: &str) -> bool {
        self.0.iter().any(|(have, _)| have == key)
    }

    /// The value of the last line for `key`, as `act_args` reads it.
    fn get(&self, key: &str) -> Option<Value> {
        self.0
            .iter()
            .rev()
            .find(|(have, _)| have == key)
            .map(|(_, raw)| arg_value(raw))
    }

    fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = Vec::new();
        for (key, _) in &self.0 {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
        keys
    }

    /// Take `key` out; its value text (the last line's).
    fn remove(&mut self, key: &str) -> Option<String> {
        let value = self
            .0
            .iter()
            .rev()
            .find(|(have, _)| have == key)
            .map(|(_, raw)| raw.clone());
        self.0.retain(|(have, _)| have != key);
        value
    }

    fn set(&mut self, key: &str, raw: String) {
        self.0.push((key.to_owned(), raw));
    }

    /// `from` under another key, where it stands.
    fn rename(&mut self, from: &str, to: &str) {
        for (key, _) in &mut self.0 {
            if key == from {
                to.clone_into(key);
            }
        }
    }

    /// The lines, one per field; an object only when a value holds a line break (a line-style
    /// args cannot carry it).
    fn into_value(self) -> Value {
        if self.0.iter().any(|(_, raw)| raw.contains('\n')) {
            return Value::Object(
                self.0
                    .into_iter()
                    .map(|(key, raw)| (key, arg_value(&raw)))
                    .collect(),
            );
        }
        Value::String(
            self.0
                .iter()
                .map(|(key, raw)| format!("{key}: {raw}"))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// The selector parameters a call may carry besides `kind`.
fn selector_params(args: &Map<String, Value>) -> Vec<&'static str> {
    meta::SELECTOR_PARAMS
        .iter()
        .copied()
        .filter(|param| *param != "kind" && args.get(*param).is_some_and(|value| !value.is_null()))
        .collect()
}

/// `"x"` or `x`, unquoted.
fn unquoted(text: &str) -> String {
    let text = text.trim();
    text.strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(text)
        .to_owned()
}

/// What a `where` clause on `name` does: `name = "x"` and `name contains "x"` give the name,
/// anything else is dropped.
enum NameClause {
    Lift(String),
    Drop,
    Other,
}

fn name_clause(part: &str) -> NameClause {
    let field: String = part
        .chars()
        .take_while(|char| char.is_alphanumeric() || *char == '_')
        .collect();
    // only a clause the where parser refuses is touched; one it reads stays as written
    if !field.eq_ignore_ascii_case("name") || whr::parse_cond(Kind::Task, part).is_ok() {
        return NameClause::Other;
    }
    let rest = part[field.len()..].trim();
    let value = match rest.strip_prefix('=') {
        Some(value) if !value.starts_with('=') => Some(value),
        _ => rest
            .get(..8)
            .filter(|word| word.eq_ignore_ascii_case("contains"))
            .map(|_| &rest[8..])
            .filter(|value| value.starts_with(char::is_whitespace) || value.starts_with('"')),
    };
    match value.map(unquoted) {
        Some(name) if !name.is_empty() => NameClause::Lift(name),
        _ => NameClause::Drop,
    }
}

/// The compile step's `where` conditions that are on `name`, taken out of the list:
/// `(kept, lifted names, dropped conditions)`.
fn split_name_conditions_all(conds: &[Value]) -> (Vec<Value>, Vec<String>, Vec<String>) {
    let mut kept = Vec::new();
    let mut lifted = Vec::new();
    let mut dropped = Vec::new();
    for cond in conds {
        let is_name = cond
            .get("field")
            .and_then(Value::as_str)
            .is_some_and(|field| field.eq_ignore_ascii_case("name"));
        if !is_name {
            kept.push(cond.clone());
            continue;
        }
        let op = cond.get("op").and_then(Value::as_str).unwrap_or("=");
        let value = cond.get("value").map(text_of).unwrap_or_default();
        let written = if value.is_empty() {
            format!("name {op}")
        } else {
            format!("name {op} \"{value}\"")
        };
        if whr::parse_cond(Kind::Task, &written).is_ok() {
            kept.push(cond.clone());
        } else if matches!(op, "=" | "contains") && !value.trim().is_empty() {
            lifted.push(value.trim().to_owned());
        } else {
            let shown = if value.is_empty() {
                format!("name {op}")
            } else {
                format!("name {op} \"{value}\"")
            };
            dropped.push(shown);
        }
    }
    (kept, lifted, dropped)
}

/// The notes and entries of name conditions the compile step took out of a typed `where`.
pub(crate) fn name_lift_report(lifted: &[String], dropped: &[String]) -> (Vec<String>, Vec<Value>) {
    let mut notes = Vec::new();
    let mut entries = Vec::new();
    for name in lifted {
        notes.push(format!(
            "note: used name: {name} for the where clause on name"
        ));
        entries.push(json!({"rule": "where_name_lifted", "name": name}));
    }
    for clause in dropped {
        notes.push(format!(
            "note: ignored where {clause} (where has no name field)"
        ));
        entries.push(json!({"rule": "where_name_dropped", "clause": clause}));
    }
    (notes, entries)
}

impl Session {
    /// `split_name_conditions_all` for the compile step; nothing is taken out when the session
    /// does not normalise.
    pub(crate) fn split_name_conditions(
        &self,
        conds: &[Value],
    ) -> (Vec<Value>, Vec<String>, Vec<String>) {
        if self.flags.normalize {
            split_name_conditions_all(conds)
        } else {
            (conds.to_vec(), Vec::new(), Vec::new())
        }
    }

    /// RULE 7 (nt12 R3): a `when` written with the lexical leniency of `dates::lenient` (a time
    /// `9pm`, a `rel` `"1"`, a weekday or month as a word) is the grammar's own form, one note
    /// each. The same reading of an act's `to` and a create's date is made where they are read.
    fn lenient_when(object: &mut Map<String, Value>, out: &mut Normalized) {
        let Some(when) = object.get("when").filter(|when| !when.is_null()) else {
            return;
        };
        let (fixed, notes) = dates::lenient(when);
        if notes.is_empty() {
            return;
        }
        for note in &notes {
            out.entries
                .push(json!({"rule": "date_lenient", "slot": "when", "note": note}));
        }
        out.notes.extend(notes);
        object.insert("when".to_owned(), fixed);
    }

    /// RULE 8 (nt12 R3): a `where` of one field joined by `or` is `in (...)`, and a number in a
    /// unit with a fixed conversion (`effort > 1 hour`) is the field's own unit (`whr::lenient_where`).
    fn lenient_where(object: &mut Map<String, Value>, out: &mut Normalized) {
        let Some(text) = arg_str(object, "where").filter(|text| !text.trim().is_empty()) else {
            return;
        };
        let Some(kind) = arg_str(object, "kind").and_then(|kind| Kind::parse(kind.trim())) else {
            return;
        };
        let (fixed, notes) = whr::lenient_where(kind, &text);
        if notes.is_empty() {
            return;
        }
        for note in &notes {
            out.entries
                .push(json!({"rule": "where_lenient", "note": note}));
        }
        out.notes.extend(notes);
        object.insert("where".to_owned(), json!(fixed));
    }

    /// RULE 13 (nt15 R1a): `note count = 0` on a task or an event is `description is empty`
    /// (`> 0` is `description is set`), with a note: their notes are their description.
    fn note_count_description(object: &mut Map<String, Value>, out: &mut Normalized) {
        let Some(kind) = arg_str(object, "kind").and_then(|kind| Kind::parse(kind.trim())) else {
            return;
        };
        let Some(text) = arg_str(object, "where").filter(|text| !text.trim().is_empty()) else {
            return;
        };
        let mut changed = false;
        let parts: Vec<String> = whr::split_and(&text)
            .into_iter()
            .map(|part| match whr::notes_as_description(kind, &part) {
                Some((clause, state)) => {
                    out.notes.push(format!(
                        "note: read {} as {clause} ({} notes are its description)",
                        part.trim(),
                        if kind == Kind::Task { "a task's" } else { "an event's" }
                    ));
                    out.entries.push(
                        json!({"rule": "note_count_description", "clause": part.trim(), "state": state}),
                    );
                    changed = true;
                    clause
                }
                None => part,
            })
            .collect();
        if changed {
            object.insert("where".to_owned(), json!(parts.join(" and ")));
        }
    }

    /// RULE 16 (nt15 R2b): the append form written with another word for the text (`notes+:` of a
    /// task, `text+:` of a note) is the field's own, `description+:` or `body+:`, with a note
    /// (`whr::resolve_field`, the one resolver of a field's other names).
    fn append_alias(&self, object: &mut Map<String, Value>, out: &mut Normalized) {
        let kind = arg_str(object, "kind")
            .and_then(|kind| Kind::parse(kind.trim()))
            .or_else(|| {
                let rows = self.resolve_rows(object.get("rows")?).ok()?;
                rows.first().map(|key| key.0)
            });
        let (Some(kind), Ok(mut lines)) = (kind, ArgLines::read(object.get("args"))) else {
            return;
        };
        let mut changed = false;
        for key in lines.keys() {
            let Some(word) = key.strip_suffix('+').map(str::trim) else {
                continue;
            };
            let Some(field) = whr::resolve_field(kind, word)
                .filter(|field| matches!(*field, "body" | "description") && *field != word)
            else {
                continue;
            };
            let meant = format!("{field}+");
            if lines.has(&meant) {
                continue;
            }
            lines.rename(&key, &meant);
            out.notes.push(format!("note: read {key} as {meant}"));
            out.entries
                .push(json!({"rule": "append_field_read", "from": key, "to": meant}));
            changed = true;
        }
        if changed {
            object.insert("args".to_owned(), lines.into_value());
        }
    }

    /// RULE 14 (nt15 R1b): `within: #43, #44` is a list of rows, not a result: `rows: #43, #44`,
    /// with a note, when every `#n` is a row of the vault and nothing else selects (a `where`, a
    /// `name`, ... beside it stays the error that names the repair). Not for a `find`, which has
    /// no `rows`: its error says `answer rows: #43, #44`.
    fn within_rows(&self, tool: &str, object: &mut Map<String, Value>, out: &mut Normalized) {
        // `find` has no `rows`: its reply names `answer`, which takes them
        let Some(within) = arg_str(object, "within").filter(|_| tool != "find") else {
            return;
        };
        let parts = crate::session::handle_list(&Value::String(within));
        if parts.is_empty()
            || !parts.iter().all(|part| crate::session::is_row_handle(part))
            || parts.iter().any(|part| self.resolve_row(part).is_err())
            || object.get("rows").is_some_and(|rows| !rows.is_null())
            || selector_params(object) != ["within"]
        {
            return;
        }
        let rows = parts.join(", ");
        object.remove("within");
        object.insert("rows".to_owned(), json!(rows));
        out.notes.push(format!(
            "note: within takes a result (@n); used rows: {rows}"
        ));
        out.entries
            .push(json!({"rule": "within_as_rows", "rows": rows}));
    }

    /// RULE 15 (nt15 R1c): a `linked_to` that names rows of several kinds keeps the rows the
    /// kind of the call is linked to, when at least one is, with a note that names the rest. With
    /// none, or all of them valid, it is left for the reply that names which are which.
    fn keep_valid_links(&self, object: &mut Map<String, Value>, out: &mut Normalized) {
        let Some(value) = object.get("linked_to").filter(|value| !value.is_null()) else {
            return;
        };
        let kinds = match arg_str(object, "kind") {
            Some(text) => self.parse_kinds(&text, false).ok(),
            None => arg_str(object, "within")
                .and_then(|handle| self.resolve_result(&handle).ok())
                .map(|handle| self.results[handle - 1].kinds.clone()),
        };
        let (Some(kinds), Ok(keys)) = (kinds, self.resolve_rows(value)) else {
            return;
        };
        if kinds.is_empty() || keys.len() < 2 {
            return;
        }
        let links = |key: &crate::world::Key| {
            kinds
                .iter()
                .all(|kind| kind.spec().link_to(key.0).is_some())
        };
        let (valid, invalid): (Vec<_>, Vec<_>) = keys.iter().partition(|key| links(key));
        if valid.is_empty() || invalid.is_empty() {
            return;
        }
        let said = |keys: &[&crate::world::Key]| -> Vec<String> {
            keys.iter()
                .map(|key| match self.numbers.get(*key) {
                    Some(number) => format!("#{number} {}", key.0.name()),
                    None => key.0.name().to_owned(),
                })
                .collect()
        };
        let handles: Vec<String> = valid
            .iter()
            .filter_map(|key| self.numbers.get(*key).map(|number| format!("#{number}")))
            .collect();
        if handles.len() != valid.len() {
            return;
        }
        let kind_words: Vec<&str> = kinds.iter().map(|kind| kind.plural()).collect();
        out.notes.push(format!(
            "note: used linked_to {}; ignored {} ({} link to {})",
            handles.join(", "),
            said(&invalid).join(", "),
            kind_words.join(" or "),
            kinds
                .iter()
                .flat_map(|kind| kind.spec().links.iter().map(|link| link.kind.name()))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ")
        ));
        out.entries.push(json!({
            "rule": "linked_to_valid",
            "kept": handles,
            "ignored": said(&invalid),
        }));
        object.insert("linked_to".to_owned(), json!(handles.join(", ")));
    }

    /// RULE 10 (nt13 R1): an enumerated value, a currency name or a near currency code in a
    /// `where`, or in the args of an `edit` or a `create`, is the one value it means, with a note
    /// (`whr::resolve_where`, `resolve_arg`). Several values or none: left for the refusal that
    /// names them all.
    fn resolve_values(
        &mut self,
        tool: &str,
        object: &mut Map<String, Value>,
        out: &mut Normalized,
    ) {
        let kind = arg_str(object, "kind").and_then(|kind| Kind::parse(kind.trim()));
        let held = self.vault_currencies();
        if let (Some(kind), Some(text)) = (
            kind,
            arg_str(object, "where").filter(|text| !text.trim().is_empty()),
        ) {
            let (fixed, notes) = whr::resolve_where(kind, &text, &held);
            if !notes.is_empty() {
                for note in &notes {
                    out.entries
                        .push(json!({"rule": "value_resolved", "note": note}));
                }
                out.notes.extend(notes);
                object.insert("where".to_owned(), json!(fixed));
            }
        }
        let verb = arg_str(object, "verb").unwrap_or_default().to_lowercase();
        if tool != "act" || !matches!(verb.as_str(), "create" | "edit") {
            return;
        }
        let kind = kind.or_else(|| {
            let rows = self.resolve_rows(object.get("rows")?).ok()?;
            rows.first().map(|key| key.0)
        });
        let (Some(kind), Ok(mut lines)) = (kind, ArgLines::read(object.get("args"))) else {
            return;
        };
        let mut changed = false;
        for (key, raw) in &mut lines.0 {
            if let Some((value, note)) = whr::resolve_arg(kind, key, raw, &held) {
                out.entries
                    .push(json!({"rule": "value_resolved", "field": key, "note": note}));
                out.notes.push(note);
                *raw = value;
                changed = true;
            }
        }
        if changed {
            object.insert("args".to_owned(), lines.into_value());
        }
    }

    /// RULE 12 (nt14 N4): a `reveal` whose `field` is a synonym of a secret's name asks for that
    /// secret (`meta::reveal_synonym`).
    fn reveal_synonym(object: &mut Map<String, Value>, out: &mut Normalized) {
        if !arg_str(object, "verb").is_some_and(|verb| verb.eq_ignore_ascii_case("reveal")) {
            return;
        }
        let Ok(mut lines) = ArgLines::read(object.get("args")) else {
            return;
        };
        let Some(written) = lines.get("field").map(|value| text_of(&value)) else {
            return;
        };
        let Some(field) = meta::reveal_synonym(&written) else {
            return;
        };
        let shown = unquoted(&written);
        out.entries
            .push(json!({"rule": "reveal_field_read", "from": shown, "to": field}));
        out.notes
            .push(format!("note: read field {shown} as {field}"));
        lines.remove("field");
        lines.set("field", field.to_owned());
        object.insert("args".to_owned(), lines.into_value());
    }

    /// RULE 11 (nt13 R5): a `group` of a computation written as a condition (`starred = yes`,
    /// `status = open`) groups by that field, with `note: grouped by status`. The field word is
    /// read by the field resolver (nt12 R2); a word that is no field of the kind stays the error.
    fn group_condition(object: &mut Map<String, Value>, out: &mut Normalized) {
        let Some(text) = arg_str(object, "group") else {
            return;
        };
        let Some(kind) = arg_str(object, "kind").and_then(|kind| Kind::parse(kind.trim())) else {
            return;
        };
        let word: String = text
            .trim()
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let rest = text.trim()[word.len()..].trim_start();
        if word.is_empty()
            || !(rest.starts_with(['=', '!', '<', '>'])
                || rest.to_lowercase().starts_with("in ")
                || rest.to_lowercase().starts_with("contains"))
        {
            return;
        }
        let Some(field) = whr::resolve_field(kind, &word).filter(|field| *field != "date") else {
            return;
        };
        let note = format!("note: grouped by {field}");
        out.entries
            .push(json!({"rule": "group_condition", "group": text, "field": field}));
        out.notes.push(note);
        object.insert("group".to_owned(), json!(field));
    }

    /// RULE 9 (nt12 R3): an edit or create arg that is a number in a unit with a fixed conversion
    /// (`effort: 2 hours`, `cadence: 2 weeks`) is the field's own unit, with a note.
    fn convert_units(object: &mut Map<String, Value>, out: &mut Normalized) {
        let Ok(mut lines) = ArgLines::read(object.get("args")) else {
            return;
        };
        let mut changed = false;
        for (key, raw) in &mut lines.0 {
            if let Some(unit) = whr::unit_of_field(key)
                && let Some((number, shown)) = whr::convert_unit(Some(unit), raw)
            {
                out.notes.push(format!("note: read {raw} as {shown}"));
                out.entries
                    .push(json!({"rule": "unit_converted", "field": key, "value": number}));
                *raw = number;
                changed = true;
            }
        }
        if changed {
            object.insert("args".to_owned(), lines.into_value());
        }
    }

    /// Repair a call before it runs; see the module comment. `target` is the first span of the
    /// trace's `target:` slot, known only to the compile step.
    pub(crate) fn normalize(
        &mut self,
        tool: &str,
        args: &Value,
        target: Option<&str>,
    ) -> Normalized {
        let mut out = Normalized {
            args: args.clone(),
            notes: Vec::new(),
            entries: Vec::new(),
        };
        if !self.flags.normalize {
            return out;
        }
        let Some(object) = args.as_object() else {
            return out;
        };
        if !matches!(tool, "find" | "answer" | "compute" | "act") {
            return out;
        }
        let mut object = object.clone();
        Self::lenient_when(&mut object, &mut out);
        Self::lenient_where(&mut object, &mut out);
        Self::note_count_description(&mut object, &mut out);
        self.within_rows(tool, &mut object, &mut out);
        self.keep_valid_links(&mut object, &mut out);
        self.resolve_values(tool, &mut object, &mut out);
        if matches!(tool, "compute" | "answer") {
            Self::group_condition(&mut object, &mut out);
        }
        let verb = arg_str(&object, "verb").unwrap_or_default().to_lowercase();
        if tool == "act" {
            Self::reveal_synonym(&mut object, &mut out);
        }
        if tool == "act" && matches!(verb.as_str(), "create" | "edit") {
            Self::convert_units(&mut object, &mut out);
        }
        if tool == "act" && verb == "edit" {
            self.append_alias(&mut object, &mut out);
        }
        if tool == "act" && verb == "create" {
            self.normalize_create(&mut object, &mut out);
        } else if tool == "act" && verb != "undo" {
            self.drop_selector_beside_rows(&mut object, &mut out);
            Self::lift_where_name(&mut object, &mut out);
            self.name_from_target(&verb, &mut object, target, &mut out);
        } else if tool != "act" {
            Self::lift_where_name(&mut object, &mut out);
        }
        out.args = Value::Object(object);
        out
    }

    /// The step that runs the call the compile step just returned reports what compile repaired.
    pub(crate) fn carry_over(&mut self, tool: &str, args: &Value, out: &mut Normalized) {
        let Some(carry) = self.compiled.take() else {
            return;
        };
        if carry.tool == tool && carry.fingerprint == fingerprint(tool, args) {
            let mut notes = carry.notes;
            notes.append(&mut out.notes);
            out.notes = notes;
            let mut entries = carry.entries;
            entries.append(&mut out.entries);
            out.entries = entries;
        }
    }

    /// Remember what the compile step repaired in `call`.
    pub(crate) fn remember_compiled(
        &mut self,
        tool: &str,
        call: &Value,
        notes: &[String],
        entries: &[Value],
    ) {
        self.compiled = (!entries.is_empty()).then(|| Carry {
            tool: tool.to_owned(),
            fingerprint: fingerprint(tool, call),
            notes: notes.to_vec(),
            entries: entries.to_vec(),
        });
    }

    // -----------------------------------------------------------------
    // Rules 1 to 3: a create's args.
    // -----------------------------------------------------------------

    fn normalize_create(&mut self, object: &mut Map<String, Value>, out: &mut Normalized) {
        let Ok(mut args) = ArgLines::read(object.get("args")) else {
            return;
        };
        let Some(kind) = arg_str(object, "kind")
            .and_then(|text| Kind::parse(text.trim()))
            .filter(|kind| crate::meta::Verb::Create.command(*kind).is_some())
        else {
            return;
        };
        let allowed = create_allowed(kind);
        let mut changed = false;

        // an arg under another spelling of a field is that field, as `create` reads it
        for key in args.keys() {
            let Some(field) = create_arg_alias(kind, &key) else {
                continue;
            };
            if !args.has(field) {
                args.rename(&key, field);
                out.notes.push(format!("note: used {key} as {field}:"));
                out.entries
                    .push(json!({"rule": "create_arg_renamed", "from": key, "to": field}));
                changed = true;
            }
        }

        // 2. `when` is not a create's parameter: at most the day of the new row.
        if let Some(when) = object.get("when").filter(|value| !value.is_null()).cloned() {
            object.remove("when");
            let single = dates::parse(&when)
                .ok()
                .filter(|expr| !dates::uses_row(expr))
                .and_then(|expr| dates::evaluate(&expr, self.now, None).ok())
                .is_some_and(|resolved| resolved.point().is_some());
            if single && allowed.contains(&"date") && !args.has("date") {
                args.set("date", text_of(&when));
                out.notes.push(format!(
                    "note: create takes no when; used {} as date:",
                    text_of(&when)
                ));
                out.entries
                    .push(json!({"rule": "when_as_date", "when": when}));
            } else {
                out.notes.push(format!(
                    "note: ignored when {} (create takes no when parameter)",
                    text_of(&when)
                ));
                out.entries
                    .push(json!({"rule": "when_dropped", "when": when}));
            }
            changed = true;
        }

        // 3. a container the arg does not name: the other container of a task, or none
        for (key, want) in [
            ("list", Kind::List),
            ("parent", Kind::Task),
            ("notebook", Kind::Notebook),
            ("folder", Kind::Folder),
            ("album", Kind::Album),
        ] {
            let Some(value) = args.get(key) else {
                continue;
            };
            let Ok(rows) = self.resolve_rows(&value) else {
                continue;
            };
            let [row] = rows.as_slice() else {
                continue;
            };
            if row.0 == want || (!allowed.contains(&key) && key != "album") {
                continue;
            }
            let number = self.number(row);
            let other = match (key, row.0) {
                ("list", Kind::Task) => Some("parent"),
                ("parent", Kind::List) => Some("list"),
                _ => None,
            };
            let said = format!("{key}: #{number} is {} {}", article(row.0), row.0.name());
            match other.filter(|other| allowed.contains(other) && !args.has(other)) {
                Some(other) => {
                    args.rename(key, other);
                    out.notes.push(format!("note: {said}; used it as {other}:"));
                    out.entries.push(
                        json!({"rule": "container_renamed", "from": key, "to": other, "row": number}),
                    );
                }
                None => {
                    args.remove(key);
                    out.notes.push(format!(
                        "note: ignored {said} ({key} takes {} {}; nothing guessed)",
                        article(want),
                        want.name()
                    ));
                    out.entries
                        .push(json!({"rule": "container_dropped", "arg": key, "row": number}));
                }
            }
            changed = true;
        }

        // 1. args the kind does not take, and the secrets its type keeps no column for
        let item_type = args
            .get("type")
            .map(|value| text_of(&value).to_lowercase())
            .unwrap_or_else(|| "login".to_owned());
        // `kind` inside args has its own refusal (the kind is the top-level parameter)
        for key in args.keys().into_iter().filter(|key| key != "kind") {
            let secret = kind == Kind::LockerItem
                && meta::REVEAL_FIELDS
                    .iter()
                    .any(|(name, column)| *name == key && *column != "content");
            if secret && meta::locker_secret_column(&item_type, &key).is_none() {
                args.remove(&key);
                out.notes.push(format!(
                    "note: ignored {key} (a {item_type} item keeps no {key}; the secret was not stored)"
                ));
                out.entries
                    .push(json!({"rule": "secret_not_stored", "arg": key, "type": item_type}));
                changed = true;
            } else if !allowed.contains(&key.as_str()) {
                let value = args.remove(&key).unwrap_or_default();
                let why = if kind.spec().field(&key).is_some() {
                    format!("{} cannot be created with {key}", kind.plural())
                } else {
                    format!("{} have no {key}", kind.plural())
                };
                out.notes.push(if value.is_empty() {
                    format!("note: ignored {key} ({why})")
                } else {
                    format!("note: ignored {key}: {value} ({why})")
                });
                out.entries
                    .push(json!({"rule": "create_arg_dropped", "arg": key, "kind": kind.name()}));
                changed = true;
            }
        }

        if changed {
            object.insert("args".to_owned(), args.into_value());
        }
    }

    // -----------------------------------------------------------------
    // Rule 6: rows beside a selector, on a write.
    // -----------------------------------------------------------------

    fn drop_selector_beside_rows(&mut self, object: &mut Map<String, Value>, out: &mut Normalized) {
        if object.get("rows").is_none_or(Value::is_null) {
            return;
        }
        let dropped = selector_params(object);
        if dropped.is_empty() {
            return;
        }
        for param in &dropped {
            object.remove(*param);
        }
        out.notes.push(format!(
            "note: ignored {} (the rows were named)",
            dropped.join(", ")
        ));
        out.entries
            .push(json!({"rule": "selector_dropped", "params": dropped}));
    }

    // -----------------------------------------------------------------
    // Rule 5: `where` on `name`.
    // -----------------------------------------------------------------

    fn lift_where_name(object: &mut Map<String, Value>, out: &mut Normalized) {
        let Some(text) = arg_str(object, "where").filter(|text| !text.trim().is_empty()) else {
            return;
        };
        // "name = x or …" is the parser's own refusal (`where has no "or"`)
        if !text.contains('"')
            && text
                .split_whitespace()
                .any(|word| word.eq_ignore_ascii_case("or"))
        {
            return;
        }
        let parts = whr::split_and(&text);
        let mut kept: Vec<String> = Vec::new();
        let mut lifted: Vec<String> = Vec::new();
        let mut dropped: Vec<String> = Vec::new();
        for part in parts {
            match name_clause(&part) {
                NameClause::Lift(name) => lifted.push(name),
                NameClause::Drop => dropped.push(part),
                NameClause::Other => kept.push(part),
            }
        }
        if lifted.is_empty() && dropped.is_empty() {
            return;
        }
        let have = arg_str(object, "name").filter(|name| !name.trim().is_empty());
        let mut first = true;
        for name in lifted {
            match &have {
                Some(have) if have.trim().eq_ignore_ascii_case(&name) => {}
                Some(_) => dropped.push(format!("name = \"{name}\"")),
                None if first => {
                    object.insert("name".to_owned(), json!(name));
                    first = false;
                    let (notes, entries) = name_lift_report(&[name], &[]);
                    out.notes.extend(notes);
                    out.entries.extend(entries);
                }
                None => dropped.push(format!("name = \"{name}\"")),
            }
        }
        let (notes, entries) = name_lift_report(&[], &dropped);
        out.notes.extend(notes);
        out.entries.extend(entries);
        if kept.is_empty() {
            object.remove("where");
        } else {
            object.insert("where".to_owned(), json!(kept.join(" and ")));
        }
    }

    // -----------------------------------------------------------------
    // Rule 4: no pick, a target.
    // -----------------------------------------------------------------

    fn name_from_target(
        &mut self,
        verb: &str,
        object: &mut Map<String, Value>,
        target: Option<&str>,
        out: &mut Normalized,
    ) {
        let Some(target) = target.map(str::trim).filter(|target| !target.is_empty()) else {
            return;
        };
        let rows = object.get("rows").is_some_and(|value| !value.is_null());
        if rows || crate::session::Session::has_selector(object) {
            return;
        }
        // a verb that fits one kind names it; with several the match would have no kind
        let Some(verb) = crate::meta::Verb::parse(verb) else {
            return;
        };
        let kinds = verb.kinds();
        let [only] = kinds.as_slice() else {
            return;
        };
        object.insert("name".to_owned(), json!(target));
        object.insert("kind".to_owned(), json!(only.name()));
        let note = format!(
            "note: no pick: matched by name \"{target}\" among {}",
            only.plural()
        );
        out.notes.push(note);
        out.entries
            .push(json!({"rule": "name_from_target", "name": target}));
    }
}

fn article(kind: Kind) -> &'static str {
    if kind.name().starts_with(['a', 'e', 'i', 'o', 'u']) {
        "an"
    } else {
        "a"
    }
}
