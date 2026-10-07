//! THE STATELESS COMPILER: the call a think states, and the v4 text of a v3.1 think.
//!
//! A think is the model's slot trace (`experiments/toolchat/native/CONTRACT_V3.md`):
//!
//! ```text
//! intent: write "cancel it"
//! verb: cancel
//! pick: #7 (name)
//! ```
//!
//! [`compile_think`] turns its slots into the call text the renderer writes after `</think>`: a pure function of the think,
//! the `dates:` line of the prompt (for a `dates[i]`) and the trace version. It is the compiler the trainer's data check, the
//! decoder's forced call and the data builder's round trip all use, through `nativetools think`; the session's `compile` op
//! (`compile.rs`) is the same step with a vault behind it, which grounds the rows and repairs the call. The two share the
//! facts they both state (the order of a call's arguments, the date spellings, the kind a verb fixes, where a pick's rows go);
//! this one reads nothing but its arguments and refuses nothing a session would check against a world.
//!
//! [`v4_think`] rewrites a v3.1 think as v4 (CONTRACT_V3 §8) and checks that both compile to the same call; the pick's reason
//! is read from the context in front of the call ([`Context`]) or, without one, from the v3.1 pick ([`reason_hint`]).
//!
//! Nothing here is a process or a protocol: `bin/nativetools.rs` wraps it in JSON lines (`nativetools think`).

mod text;

use std::collections::BTreeMap;

use serde_json::Value;

use crate::native::compile::{
    CALL_ORDER, HANDLE_SLOTS, PICK_REASONS, date_text, default_tool, infers_kind,
    kind_a_verb_fixes, pick_states_rows, reading_expr, rows_key,
};
use crate::native::meta::Verb;
use text::{
    focus_sets, has_time_phrase, is_word, nickname, normal_int, own_text, py_repr, py_rstrip,
    py_split_ws, py_strip, same, shows_date, words,
};

// ---------------------------------------------------------------------------------------------
// the vocabulary
// ---------------------------------------------------------------------------------------------

const INTENTS: [&str; 5] = ["read", "count", "write", "ask", "decline"];
const SCOPES: [&str; 3] = ["one", "some", "all"];
const REFERS: [&str; 4] = ["it", "both", "that", "nth"];
/// The reasons a v3.1 pick gives for leaving a candidate out.
const REASONS: [&str; 6] = ["kind", "name", "position", "date", "status", "other"];
const VIA3: [&str; 4] = ["find", "search", "open", "compute"];
const VIA4: [&str; 3] = ["search", "open", "compute"];
/// `label: <the argument as the call carries it>`.
const RAW: [&str; 20] = [
    "kind",
    "op",
    "field",
    "group",
    "trashed",
    "name",
    "text",
    "where",
    "linked_to",
    "within",
    "exclude",
    "order",
    "limit",
    "more",
    "rows",
    "row",
    "value",
    "options",
    "question",
    "reason",
];
const ORDER3: [&str; 31] = [
    "retry",
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
    "time",
    "pick",
    "rows",
    "row",
    "value",
    "options",
    "question",
    "reason",
];
/// v4: the row decision comes right after the verb, and `scope`, `refer` and `target` are not slots.
const ORDER4: [&str; 28] = [
    "retry",
    "intent",
    "via",
    "verb",
    "pick",
    "rows",
    "row",
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
    "time",
    "value",
    "options",
    "question",
    "reason",
];
const UNITS: [&str; 6] = ["minute", "hour", "day", "week", "month", "year"];

/// The version of the trace a text with no construct of either version is read as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceMode {
    V31,
    V4,
}

impl TraceMode {
    /// `v3.1` or `v4`.
    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "v3.1" => Some(Self::V31),
            "v4" => Some(Self::V4),
            _ => None,
        }
    }
}

/// The call a think states: the tool and its arguments as text, in the order a call writes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub tool: String,
    pub args: Vec<(String, String)>,
}

/// A think that does not state a whole call. `class` is `CompileError` for a text that is no trace or states no call, and
/// `ValueError` for the one malformed `where` the parser reads back after respelling it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub class: &'static str,
    pub message: String,
}

fn refuse<T>(message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal {
        class: "CompileError",
        message: message.into(),
    })
}

// ---------------------------------------------------------------------------------------------
// the slots
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    Quote(String),
    Now,
    Earlier(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Refer {
    kind: String,
    quote: String,
    handles: Vec<String>,
}

/// The slots of a think, as `authored/trace.py`'s `parse3` / `parse4` read them.
#[derive(Debug, Clone, Default)]
struct Slots {
    v4: bool,
    retry: Option<String>,
    intent: (String, String),
    via: Option<String>,
    verb: Option<String>,
    scope: Option<(String, String)>,
    refer: Option<Refer>,
    target: Option<Vec<String>>,
    raw: BTreeMap<&'static str, String>,
    when: Option<Source>,
    when_expr: Option<String>,
    set: Option<Vec<(String, String, bool)>>,
    time: Option<Vec<String>>,
    /// The rows of a pick: the number as written without leading zeros, and the reason a v3.1 pick left it out (`None`: ok).
    pick: Option<Vec<(String, Option<String>)>>,
    pick_reason: Option<String>,
}

impl Slots {
    fn has(&self, key: &str) -> bool {
        self.raw.contains_key(key)
    }

    fn any_handle_slot(&self) -> bool {
        HANDLE_SLOTS.iter().any(|key| self.has(key))
    }
}

/// The text between `"` and `"` at the start of `text` (no quote inside), and what follows the closing one.
fn quoted(text: &str) -> Option<(&str, &str)> {
    let inner = text.strip_prefix('"')?;
    let close = inner.find('"')?;
    let quote = &inner[..close];
    (!quote.contains('\n')).then(|| (quote, &inner[close + 1..]))
}

/// ` "<phrase>"` or nothing, and then the end of the text.
fn optional_quote(rest: &str) -> Option<String> {
    if rest.is_empty() {
        return Some(String::new());
    }
    let (quote, after) = quoted(rest.strip_prefix(' ')?)?;
    after.is_empty().then(|| quote.to_owned())
}

fn is_number(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|letter| letter.is_ascii_digit())
}

/// `[#@]\d+`.
fn is_handle(text: &str) -> bool {
    text.strip_prefix(['#', '@']).is_some_and(is_number)
}

/// What a line holds, before the order of the lines is checked.
enum Held {
    Retry(String),
    Intent(String, String),
    Word(String),
    Scope(String, String),
    Refer(Refer),
    Target(Vec<String>),
    When(Source, Option<String>),
    Set(String),
    Time(String),
    Pick3(Vec<(String, Option<String>)>),
    Pick4(String, String),
    Raw(String),
}

/// `word` and an optional quoted phrase, for `intent` and `scope`.
fn word_and_quote(rest: &str, words: &[&str]) -> Option<(String, String)> {
    words.iter().find_map(|word| {
        let tail = rest.strip_prefix(word)?;
        optional_quote(tail).map(|quote| ((*word).to_owned(), quote))
    })
}

fn hold_when(rest: &str) -> Option<(Source, Option<String>)> {
    // ` = <date>` or nothing
    let tail = |after: &str| -> Option<Option<String>> {
        if after.is_empty() {
            return Some(None);
        }
        after
            .strip_prefix(" = ")
            .filter(|date| !date.is_empty())
            .map(|date| Some(date.to_owned()))
    };
    if let Some((quote, after)) = quoted(rest) {
        return tail(after).map(|date| (Source::Quote(quote.to_owned()), date));
    }
    if let Some(after) = rest.strip_prefix("now") {
        return tail(after).map(|date| (Source::Now, date));
    }
    let after = rest.strip_prefix("earlier")?;
    if let Some((quote, beyond)) = after.strip_prefix(' ').and_then(quoted)
        && let Some(date) = tail(beyond)
    {
        return Some((Source::Earlier(quote.to_owned()), date));
    }
    tail(after).map(|date| (Source::Earlier(String::new()), date))
}

fn hold_refer(rest: &str) -> Option<Refer> {
    if rest == "none" {
        return Some(Refer {
            kind: "none".to_owned(),
            quote: String::new(),
            handles: Vec::new(),
        });
    }
    let kind = REFERS.iter().find(|kind| rest.starts_with(**kind))?;
    let mut tail = &rest[kind.len()..];
    let mut quote = String::new();
    if let Some((phrase, after)) = tail.strip_prefix(' ').and_then(quoted) {
        quote = phrase.to_owned();
        tail = after;
    }
    let handles: Vec<String> = tail
        .strip_prefix(" -> ")?
        .split(", ")
        .map(str::to_owned)
        .collect();
    handles
        .iter()
        .all(|handle| is_handle(handle))
        .then(|| Refer {
            kind: (*kind).to_owned(),
            quote,
            handles,
        })
}

fn hold_pick3(rest: &str) -> Option<Vec<(String, Option<String>)>> {
    let mut out = Vec::new();
    for item in rest.split(" · ") {
        let (number, verdict) = item.strip_prefix('#')?.split_once(' ')?;
        if !is_number(number) {
            return None;
        }
        let why = if verdict == "ok" {
            None
        } else {
            let reason = verdict.strip_prefix("no (")?.strip_suffix(')')?;
            REASONS.contains(&reason).then_some(())?;
            Some(reason.to_owned())
        };
        out.push((normal_int(number), why));
    }
    Some(out)
}

fn hold_pick4(rest: &str) -> Option<(String, String)> {
    let (number, tail) = rest.strip_prefix('#')?.split_once(' ')?;
    let reason = tail.strip_prefix('(')?.strip_suffix(')')?;
    (is_number(number) && PICK_REASONS.contains(&reason))
        .then(|| (normal_int(number), reason.to_owned()))
}

/// The line `key: ...` as its slot holds it, or `None` when the line is not one (`LINE_RX3` / `LINE_RX4`).
fn hold(key: &str, line: &str, v4: bool) -> Option<Held> {
    let rest = line.strip_prefix(key)?.strip_prefix(": ")?;
    match key {
        "retry" => {
            let plain = !rest.is_empty()
                && rest
                    .chars()
                    .all(|letter| letter.is_ascii_lowercase() || letter == '_');
            let counted = rest
                .strip_suffix(']')
                .and_then(|head| head.split_once('['))
                .is_some_and(|(name, number)| {
                    !name.is_empty()
                        && name
                            .chars()
                            .all(|letter| letter.is_ascii_lowercase() || letter == '_')
                        && is_number(number)
                });
            (rest == "rejected" || plain || counted).then(|| Held::Retry(rest.to_owned()))
        }
        "intent" => word_and_quote(rest, &INTENTS).map(|(word, quote)| Held::Intent(word, quote)),
        "verb" => {
            (!rest.is_empty() && rest.chars().all(is_word)).then(|| Held::Word(rest.to_owned()))
        }
        "via" => (if v4 { &VIA4[..] } else { &VIA3[..] })
            .contains(&rest)
            .then(|| Held::Word(rest.to_owned())),
        "scope" if !v4 => {
            word_and_quote(rest, &SCOPES).map(|(word, quote)| Held::Scope(word, quote))
        }
        "refer" if !v4 => hold_refer(rest).map(Held::Refer),
        "target" if !v4 => {
            let mut spans = Vec::new();
            let mut tail = rest;
            loop {
                let (span, after) = quoted(tail)?;
                spans.push(span.to_owned());
                if after.is_empty() {
                    break;
                }
                tail = after.strip_prefix(" · ")?;
            }
            Some(Held::Target(spans))
        }
        "when" => hold_when(rest).map(|(source, date)| Held::When(source, date)),
        "set" => (!rest.is_empty()).then(|| Held::Set(rest.to_owned())),
        "time" => (!rest.is_empty()).then(|| Held::Time(rest.to_owned())),
        "pick" if v4 => hold_pick4(rest).map(|(number, reason)| Held::Pick4(number, reason)),
        "pick" => hold_pick3(rest).map(Held::Pick3),
        _ => (RAW.contains(&key) && !rest.is_empty()).then(|| Held::Raw(rest.to_owned())),
    }
}

/// `trace.py` `_parse`: the slots of a trace text, or what is wrong with it.
fn parse_slots(text: &str, v4: bool) -> Result<Slots, String> {
    let order: &[&str] = if v4 { &ORDER4 } else { &ORDER3 };
    let mut slots = Slots {
        v4,
        ..Slots::default()
    };
    let mut last: Option<usize> = None;
    let mut have_intent = false;
    for raw in py_strip(text).split('\n') {
        let line = py_rstrip(raw);
        let key = line.split(':').next().unwrap_or_default();
        let Some(position) = order.iter().position(|slot| *slot == key) else {
            return Err(format!("not a slot: {}", py_repr(line)));
        };
        let Some(held) = hold(key, line, v4) else {
            return Err(format!("bad {key} line: {}", py_repr(line)));
        };
        if last.is_some_and(|before| position <= before) {
            return Err(format!("slot out of order: {}", py_repr(line)));
        }
        last = Some(position);
        match held {
            Held::Retry(value) => slots.retry = Some(value),
            Held::Intent(word, quote) => {
                slots.intent = (word, quote);
                have_intent = true;
            }
            Held::Word(word) if key == "via" => slots.via = Some(word),
            Held::Word(word) => slots.verb = Some(word),
            Held::Scope(word, quote) => slots.scope = Some((word, quote)),
            Held::Refer(refer) => slots.refer = Some(refer),
            Held::Target(spans) => slots.target = Some(spans),
            Held::When(source, date) => {
                slots.when = Some(source);
                slots.when_expr = date;
            }
            Held::Set(rest) => {
                let mut entries = Vec::new();
                for part in rest.split(" · ") {
                    let Some((name, value)) =
                        part.split_once(" = ").filter(|(name, _)| !name.is_empty())
                    else {
                        return Err(format!("bad set entry: {}", py_repr(part)));
                    };
                    entries.push(match value.strip_prefix('~') {
                        Some(date) => (name.to_owned(), date.to_owned(), true),
                        None => (name.to_owned(), value.to_owned(), false),
                    });
                }
                slots.set = Some(entries);
            }
            Held::Time(rest) => slots.time = Some(rest.split(" · ").map(str::to_owned).collect()),
            Held::Pick3(rows) => slots.pick = Some(rows),
            Held::Pick4(number, reason) => {
                slots.pick = Some(vec![(number, None)]);
                slots.pick_reason = Some(reason);
            }
            Held::Raw(value) => {
                if let Some(name) = RAW.iter().find(|name| **name == key) {
                    slots.raw.insert(name, value);
                }
            }
        }
    }
    if !have_intent {
        return Err("no intent line".to_owned());
    }
    Ok(slots)
}

fn parse3(text: &str) -> Result<Slots, String> {
    parse_slots(text, false)
}

fn parse4(text: &str) -> Result<Slots, String> {
    let slots = parse_slots(text, true)?;
    if slots.pick.is_some() && (slots.has("rows") || slots.has("row")) {
        return Err("a pick and a rows slot both name the rows".to_owned());
    }
    Ok(slots)
}

/// `pick: #\d+ \(` at the start of a line.
fn is_one_row_pick(line: &str) -> bool {
    line.strip_prefix("pick: #").is_some_and(|rest| {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && rest[digits..].starts_with(" (")
    })
}

/// A line only a v3.1 trace has: `scope`, `refer`, `target`, `via: find` or a candidate pick.
fn is_v31_line(line: &str) -> bool {
    ["scope: ", "refer: ", "target: ", "pick: "]
        .iter()
        .any(|start| line.starts_with(start))
        || line == "via: find"
}

/// `trace.py` `parse_any`: a trace of either version. A think with a construct of only one version is read as that version
/// whatever the mode, so data of both stays readable; any other think is read in the mode, because the two versions differ only
/// in what the compile step infers.
fn parse_any(text: &str, mode: TraceMode) -> Result<Slots, String> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.iter().any(|line| is_one_row_pick(line)) {
        return parse4(text);
    }
    if lines.iter().any(|line| is_v31_line(line)) {
        return parse3(text);
    }
    match mode {
        TraceMode::V4 => parse4(text),
        TraceMode::V31 => parse3(text),
    }
}

// ---------------------------------------------------------------------------------------------
// the compact date of a trace (`week+1 wd5`, `2026-03-27 t`, `from ... to ...`)
// ---------------------------------------------------------------------------------------------

/// A date point as the JSON text it will be written as: keys in the order the tokens came, an int as its digits.
#[derive(Debug, Default, Clone)]
struct Point(Vec<(String, Scalar)>);

#[derive(Debug, Clone)]
enum Scalar {
    Int(String),
    Text(String),
}

impl Point {
    fn set(&mut self, key: &str, value: Scalar) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    fn json(&self) -> String {
        let parts: Vec<String> = self
            .0
            .iter()
            .map(|(key, value)| {
                format!(
                    "\"{key}\":{}",
                    match value {
                        Scalar::Int(digits) => digits.clone(),
                        Scalar::Text(text) => json_string(text),
                    }
                )
            })
            .collect();
        format!("{{{}}}", parts.join(","))
    }
}

fn json_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// `int("+05")`, as the digits Python prints.
fn signed_int(text: &str) -> String {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(digits) => (true, digits),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits = normal_int(digits);
    if negative && digits != "0" {
        format!("-{digits}")
    } else {
        digits
    }
}

fn is_sign_number(word: &str) -> bool {
    word.strip_prefix(['+', '-']).is_some_and(is_number)
}

/// `^(minute|hour|day|week|month|year)([+-]\d+)?$`.
fn unit_word(word: &str) -> Option<(&'static str, Option<&str>)> {
    UNITS.iter().find_map(|unit| {
        let tail = word.strip_prefix(unit)?;
        if tail.is_empty() {
            Some((*unit, None))
        } else {
            is_sign_number(tail).then_some((*unit, Some(tail)))
        }
    })
}

/// `^\d{4}(?:-\d\d(?:-\d\d)?)?$`.
fn is_date_word(word: &str) -> bool {
    let digits = |text: &str, count: usize| text.len() == count && is_number(text);
    let mut parts = word.split('-');
    let ok = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(year), None, ..) => digits(year, 4),
        (Some(year), Some(month), None, _) => digits(year, 4) && digits(month, 2),
        (Some(year), Some(month), Some(day), None) => {
            digits(year, 4) && digits(month, 2) && digits(day, 2)
        }
        _ => false,
    };
    ok && word.is_ascii()
}

fn date_point(words: &[&str], times: &mut Vec<String>) -> Result<Point, Refusal> {
    let mut point = Point::default();
    for word in words {
        if let Some((unit, rel)) = unit_word(word) {
            point.set("unit", Scalar::Text(unit.to_owned()));
            if let Some(rel) = rel {
                point.set("rel", Scalar::Int(signed_int(rel)));
            }
        } else if is_sign_number(word) {
            point.set("rel", Scalar::Int(signed_int(word)));
        } else if let Some(day) = word.strip_prefix("wd").filter(|digits| is_number(digits)) {
            point.set("weekday", Scalar::Int(normal_int(day)));
        } else if let Some(number) = word.strip_prefix('m').filter(|digits| is_number(digits)) {
            point.set("name", Scalar::Int(normal_int(number)));
        } else if matches!(*word, "row" | "today") {
            point.set("anchor", Scalar::Text((*word).to_owned()));
        } else if *word == "t" {
            if times.is_empty() {
                return refuse("a `t` marker with no time value");
            }
            point.set("time", Scalar::Text(times.remove(0)));
        } else if is_date_word(word) {
            point.set("date", Scalar::Text((*word).to_owned()));
        } else {
            return refuse(format!("date token {}", py_repr(word)));
        }
    }
    if point.0.is_empty() {
        return refuse("empty date point");
    }
    Ok(point)
}

/// `trace.py` `date_from_compact`: the JSON text of a compact date; `times` is consumed from the front, one per `t`.
fn date_from_compact(text: &str, times: &mut Vec<String>) -> Result<String, Refusal> {
    let words = py_split_ws(text);
    if words.is_empty() {
        return refuse("empty date");
    }
    if !matches!(words[0], "from" | "to") {
        return Ok(date_point(&words, times)?.json());
    }
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current: Option<&str> = None;
    let mut buffer: Vec<&str> = Vec::new();
    let mut flush =
        |current: Option<&str>, buffer: &[&str], times: &mut Vec<String>| -> Result<(), Refusal> {
            if let Some(name) = current {
                let json = date_point(buffer, times)?.json();
                match out.iter_mut().find(|(key, _)| key == name) {
                    Some(slot) => slot.1 = json,
                    None => out.push((name.to_owned(), json)),
                }
            }
            Ok(())
        };
    for word in &words {
        if matches!(*word, "from" | "to") {
            flush(current, &buffer, times)?;
            current = Some(*word);
            buffer.clear();
        } else {
            buffer.push(word);
        }
    }
    flush(current, &buffer, times)?;
    let parts: Vec<String> = out
        .iter()
        .map(|(key, json)| format!("\"{key}\":{json}"))
        .collect();
    Ok(format!("{{{}}}", parts.join(",")))
}

// ---------------------------------------------------------------------------------------------
// the dates line
// ---------------------------------------------------------------------------------------------

/// The entries of a `dates:` line as (phrase, resolution), in the order the runtime indexes them.
fn dates_entries(line: &str) -> Vec<(String, String)> {
    let body: String = line.chars().skip("dates: ".len()).collect();
    body.split(" · ")
        .filter_map(|part| {
            let (phrase, resolution) = part.split_once(" = ")?;
            Some((py_strip(phrase).to_owned(), py_strip(resolution).to_owned()))
        })
        .collect()
}

/// A reading's refusal in the words of a think (`dates[1] past`), not of the session's JSON (`"reading": "past"`).
fn in_the_words_of_a_think(why: &str) -> String {
    if why.starts_with("two readings") {
        return "two readings; say past or upcoming".to_owned();
    }
    for lead in ["cannot read ", ""] {
        let trail = if lead.is_empty() {
            " is a clock, not a date"
        } else {
            ""
        };
        if let Some(inner) = why
            .strip_prefix(lead)
            .and_then(|rest| rest.strip_prefix('"'))
        {
            let inner = if trail.is_empty() {
                inner.strip_suffix('"')
            } else {
                inner.strip_suffix(&format!("\"{trail}"))
            };
            if let Some(inner) = inner {
                return format!("{lead}{}{trail}", py_repr(inner));
            }
        }
    }
    why.to_owned()
}

/// `^dates\[(\d+)\](?: (past|upcoming))?$`: the digits as written and the reading.
fn dates_ref(text: &str) -> Option<(&str, Option<&str>)> {
    let rest = text.strip_prefix("dates[")?;
    let close = rest.find(']')?;
    let digits = &rest[..close];
    if !is_number(digits) {
        return None;
    }
    match &rest[close + 1..] {
        "" => Some((digits, None)),
        " past" => Some((digits, Some("past"))),
        " upcoming" => Some((digits, Some("upcoming"))),
        _ => None,
    }
}

fn resolve(dates: &str, digits: &str, reading: Option<&str>) -> Result<Value, String> {
    let entries = dates_entries(dates);
    let index: u128 = digits.parse().unwrap_or(u128::MAX);
    match usize::try_from(index).ok().and_then(|at| entries.get(at)) {
        Some((_, resolution)) => {
            reading_expr(resolution, reading).map_err(|why| in_the_words_of_a_think(&why))
        }
        None => Err(format!(
            "the dates line holds {} entries, not {}",
            entries.len(),
            index.saturating_add(1)
        )),
    }
}

// ---------------------------------------------------------------------------------------------
// the typed `where`
// ---------------------------------------------------------------------------------------------

/// The words a typed condition writes bare (`status = open`); any other text is quoted.
const ENUM_WORDS: &[&str] = &[
    "open",
    "in_progress",
    "completed",
    "cancelled",
    "settled",
    "owes_me",
    "i_owe",
    "owed_to_me",
    "yes",
    "no",
    "confirmed",
    "tentative",
    "true",
    "false",
    "low",
    "high",
    "call",
    "message",
    "visit",
    "coffee",
    "password",
    "code",
    "card_number",
    "cvv",
    "content",
    "login",
    "card",
    "note",
    "identity",
    "wifi",
    "ssh_key",
    "api_credential",
    "passport",
    "bank_account",
    "driving_licence",
    "software_licence",
    "crypto_wallet",
    "membership",
    "document",
    "asc",
    "desc",
    "me",
    "self",
];
const COMPARISONS: [&str; 6] = ["=", "!=", "<=", ">=", "<", ">"];

#[derive(Debug, Clone, PartialEq)]
enum CondValue {
    Str(String),
    Int(String),
    Bool(bool),
    List(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
struct Cond {
    /// The field, or the link of a linked count.
    name: String,
    link: bool,
    op: String,
    value: Option<CondValue>,
    /// A number with a unit (`35 BRL`, `1 hour`): written unquoted.
    bare: bool,
}

/// `str.split` at the separators that are outside double quotes, trimmed, empty parts dropped.
fn split_segments(text: &str, seps: &[&str]) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut inside = false;
    let mut at = 0;
    while at < text.len() {
        let letter = text[at..].chars().next().unwrap_or(' ');
        if letter == '"' {
            inside = !inside;
        }
        if !inside && let Some(sep) = seps.iter().find(|sep| text[at..].starts_with(**sep)) {
            parts.push(std::mem::take(&mut current));
            at += sep.len();
            continue;
        }
        current.push(letter);
        at += letter.len_utf8();
    }
    parts.push(current);
    parts
        .iter()
        .map(|part| py_strip(part).to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

/// The leading `\w+` of a text and the rest.
fn word_run(text: &str) -> (&str, &str) {
    let end = text
        .char_indices()
        .find(|(_, letter)| !is_word(*letter))
        .map_or(text.len(), |(at, _)| at);
    (&text[..end], &text[end..])
}

fn is_unit_number(text: &str) -> bool {
    // `-?\d+(?:\.\d+)?(?: [A-Za-z]+)?`
    let body = text.strip_prefix('-').unwrap_or(text);
    let (number, unit) = match body.split_once(' ') {
        Some((number, unit)) => (number, Some(unit)),
        None => (body, None),
    };
    let numeric = match number.split_once('.') {
        Some((whole, fraction)) => is_number(whole) && is_number(fraction),
        None => is_number(number),
    };
    numeric
        && unit.is_none_or(|unit| {
            !unit.is_empty() && unit.chars().all(|letter| letter.is_ascii_alphabetic())
        })
}

fn is_identifier(text: &str) -> bool {
    let mut letters = text.chars();
    letters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && letters.all(|letter| letter.is_ascii_alphanumeric() || letter == '_')
}

/// `trace.py` `parse_cond`: one typed condition from a segment, or why it is not one.
fn parse_cond(part: &str) -> Result<Cond, String> {
    let part = py_strip(part);
    let (name, rest) = word_run(part);
    let cond = |op: &str, value: Option<CondValue>| Cond {
        name: name.to_owned(),
        link: false,
        op: op.to_owned(),
        value,
        bare: false,
    };
    if !name.is_empty() && rest.starts_with(' ') {
        let rest = &rest[1..];
        // `debt count >= 2`
        if let Some(tail) = rest.strip_prefix("count ")
            && let Some(op) = COMPARISONS
                .iter()
                .find(|op| tail.starts_with(&format!("{op} ")))
        {
            let number = &tail[op.len() + 1..];
            if number
                .strip_prefix('-')
                .unwrap_or(number)
                .chars()
                .all(|letter| letter.is_ascii_digit())
                && !number.strip_prefix('-').unwrap_or(number).is_empty()
            {
                return Ok(Cond {
                    link: true,
                    ..cond(op, Some(CondValue::Int(signed_int(number))))
                });
            }
        }
        if rest == "is empty" || rest == "is set" {
            return Ok(cond(rest, None));
        }
        if let Some(inner) = rest
            .strip_prefix("in (")
            .and_then(|tail| tail.strip_suffix(')'))
        {
            let mut items = Vec::new();
            let mut tail = inner;
            while let Some(after) = tail.strip_prefix('"') {
                let Some(close) = after.find('"') else { break };
                items.push(after[..close].to_owned());
                tail = after[close + 1..]
                    .strip_prefix(", ")
                    .unwrap_or(&after[close + 1..]);
            }
            let rebuilt = items
                .iter()
                .map(|item| format!("\"{item}\""))
                .collect::<Vec<_>>()
                .join(", ");
            if items.is_empty() || rebuilt != inner {
                return Err(format!("a list of quoted values, not {}", py_repr(inner)));
            }
            return Ok(cond("in", Some(CondValue::List(items))));
        }
        if let Some(value) = rest
            .strip_prefix("contains \"")
            .and_then(|tail| tail.strip_suffix('"'))
            && !value.contains('"')
        {
            return Ok(cond("contains", Some(CondValue::Str(value.to_owned()))));
        }
        if let Some(op) = COMPARISONS
            .iter()
            .find(|op| rest.starts_with(&format!("{op} ")) && rest.len() > op.len() + 1)
        {
            let value = &rest[op.len() + 1..];
            if value.starts_with('"') {
                let inner = value
                    .strip_prefix('"')
                    .and_then(|tail| tail.strip_suffix('"'))
                    .filter(|inner| !inner.contains('"'));
                return match inner {
                    Some(inner) => Ok(cond(op, Some(CondValue::Str(inner.to_owned())))),
                    None => Err(format!("unbalanced quotes in {}", py_repr(part))),
                };
            }
            let digits = value.strip_prefix('-').unwrap_or(value);
            if is_number(digits) {
                return Ok(cond(op, Some(CondValue::Int(signed_int(value)))));
            }
            if value == "yes" || value == "no" {
                return Ok(cond(op, Some(CondValue::Bool(value == "yes"))));
            }
            if is_unit_number(value) {
                return Ok(Cond {
                    bare: true,
                    ..cond(op, Some(CondValue::Str(value.to_owned())))
                });
            }
            if is_identifier(value) {
                return Ok(cond(op, Some(CondValue::Str(value.to_owned()))));
            }
            return Err(format!("cannot type the value of {}", py_repr(part)));
        }
    }
    Err(format!("not a typed condition: {}", py_repr(part)))
}

/// The trace spelling of a condition: a closed word bare, any other text quoted.
fn cond_text(cond: &Cond) -> String {
    if cond.link {
        let Some(CondValue::Int(count)) = &cond.value else {
            return String::new();
        };
        return format!("{} count {} {count}", cond.name, cond.op);
    }
    if cond.op == "is empty" || cond.op == "is set" {
        return format!("{} {}", cond.name, cond.op);
    }
    match (&cond.op[..], &cond.value) {
        ("in", Some(CondValue::List(items))) => {
            let items: Vec<String> = items.iter().map(|item| format!("\"{item}\"")).collect();
            format!("{} in ({})", cond.name, items.join(", "))
        }
        ("contains", Some(CondValue::Str(value))) => format!("{} contains \"{value}\"", cond.name),
        (_, Some(value)) => {
            let spelled = match value {
                CondValue::Bool(flag) => if *flag { "yes" } else { "no" }.to_owned(),
                CondValue::Int(number) => number.clone(),
                CondValue::Str(text)
                    if cond.bare
                        || (ENUM_WORDS.contains(&text.as_str())
                            && text != "yes"
                            && text != "no") =>
                {
                    text.clone()
                }
                CondValue::Str(text) => format!("\"{text}\""),
                CondValue::List(_) => String::new(),
            };
            format!("{} {} {spelled}", cond.name, cond.op)
        }
        _ => String::new(),
    }
}

/// The one spelling the runtime reads (`compile.rs` `render_cond`): strings quoted (`'` for an inner `"`), numbers and yes/no
/// bare, a unit number bare.
fn cond_render(cond: &Cond) -> String {
    let text = cond_text(cond);
    let plain = cond.link
        || matches!(&cond.op[..], "is empty" | "is set" | "in" | "contains")
        || matches!(cond.value, Some(CondValue::Bool(_) | CondValue::Int(_)))
        || cond.bare;
    match (&cond.value, plain) {
        (Some(CondValue::Str(value)), false) => {
            format!("{} {} \"{}\"", cond.name, cond.op, value.replace('"', "'"))
        }
        _ => text,
    }
}

/// `trace.py` `where_respell`: a call's `where` in the runtime's spelling, or `None` when it is not a list of typed
/// conditions or when its spelling differs by more than quotes.
fn where_respell(text: &str) -> Result<Option<String>, Refusal> {
    let parsed: Result<Vec<Cond>, String> = split_segments(text, &[" · ", " and "])
        .iter()
        .map(|part| parse_cond(part))
        .collect();
    let Ok(conds) = parsed else { return Ok(None) };
    if conds.is_empty() {
        return Ok(None);
    }
    // the slot is read back, so what the model writes is what compiles
    let slot = conds.iter().map(cond_text).collect::<Vec<_>>().join(" · ");
    let mut again = Vec::new();
    for part in split_segments(&slot, &[" · "]) {
        match parse_cond(&part) {
            Ok(cond) => again.push(cond),
            Err(message) => {
                return Err(Refusal {
                    class: "ValueError",
                    message,
                });
            }
        }
    }
    let call = again
        .iter()
        .map(cond_render)
        .collect::<Vec<_>>()
        .join(" and ");
    let plain = |text: &str| text.replace('"', "");
    Ok((plain(&call) == plain(text).replace(" · ", " and ")).then_some(call))
}

// ---------------------------------------------------------------------------------------------
// the call
// ---------------------------------------------------------------------------------------------

/// The rows a trace states by itself: the `ok` rows of `pick`, else the handles of a real `refer`.
fn derived_rows(slots: &Slots) -> Option<String> {
    if let Some(pick) = slots.pick.as_ref().filter(|pick| !pick.is_empty()) {
        let ok: Vec<String> = pick
            .iter()
            .filter(|(_, why)| why.is_none())
            .map(|(number, _)| format!("#{number}"))
            .collect();
        return (!ok.is_empty()).then(|| ok.join(", "));
    }
    slots
        .refer
        .as_ref()
        .filter(|refer| !refer.handles.is_empty())
        .map(|refer| refer.handles.join(", "))
}

fn set_arg(args: &mut Vec<(String, String)>, key: &str, value: String) {
    match args.iter_mut().find(|(name, _)| name == key) {
        Some(slot) => slot.1 = value,
        None => args.push((key.to_owned(), value)),
    }
}

fn has_arg(args: &[(String, String)], key: &str) -> bool {
    args.iter().any(|(name, _)| name == key)
}

/// `trace.py` `compile_call` over parsed slots.
fn compile_slots(slots: &Slots, dates: Option<&str>) -> Result<Call, Refusal> {
    let tool = slots
        .via
        .clone()
        .unwrap_or_else(|| default_tool(&slots.intent.0).to_owned());
    let mut args: Vec<(String, String)> = Vec::new();
    let mut times: Vec<String> = slots.time.clone().unwrap_or_default();
    if tool == "act" {
        let Some(verb) = &slots.verb else {
            return refuse("an act without a verb slot");
        };
        set_arg(&mut args, "verb", verb.clone());
    }
    for key in RAW {
        if let Some(value) = slots.raw.get(key) {
            set_arg(&mut args, key, value.clone());
        }
    }
    if let Some((_, spelled)) = args.iter().find(|(key, _)| key == "where").cloned()
        && let Some(call) = where_respell(&spelled)?
    {
        set_arg(&mut args, "where", call);
    }
    if pick_states_rows(slots.v4, slots.any_handle_slot())
        && let Some(rows) = derived_rows(slots)
    {
        set_arg(&mut args, rows_key(&tool), rows);
    }
    // inferred in v4: the one kind the verb applies to, for a name and no other handle
    if slots.v4
        && infers_kind(
            &tool,
            has_arg(&args, "kind"),
            has_arg(&args, "name"),
            HANDLE_SLOTS.iter().any(|key| has_arg(&args, key)),
        )
        && let Some(kind) = slots.verb.as_deref().and_then(kind_of_exact_verb)
    {
        set_arg(&mut args, "kind", kind.to_owned());
    }

    let date = |text: &str, times: &mut Vec<String>| -> Result<String, Refusal> {
        let Some((digits, reading)) = dates_ref(text) else {
            return date_from_compact(text, times);
        };
        let Some(line) = dates else {
            return refuse("a dates[i] needs the dates line");
        };
        match resolve(line, digits, reading) {
            Ok(expr) => Ok(date_text(&expr)),
            Err(why) => refuse(format!("dates[{digits}]: {why}")),
        }
    };
    if let Some(expr) = slots.when_expr.as_ref().filter(|expr| !expr.is_empty()) {
        let value = date(expr, &mut times)?;
        set_arg(&mut args, "when", value);
    }
    if let Some(set) = slots.set.as_ref().filter(|set| !set.is_empty()) {
        let mut lines = Vec::new();
        for (key, value, is_date) in set {
            let spelled = if *is_date {
                date(value, &mut times)?
            } else {
                value.clone()
            };
            lines.push(format!("{key}: {spelled}"));
        }
        set_arg(&mut args, "args", lines.join("\n"));
    }
    if !times.is_empty() {
        return refuse(format!("{} time values with no `t` marker", times.len()));
    }
    let mut ordered: Vec<(String, String)> = Vec::new();
    for key in CALL_ORDER {
        if let Some((_, value)) = args.iter().find(|(name, _)| name == key) {
            ordered.push((key.to_owned(), value.clone()));
        }
    }
    if ordered.len() != args.len() {
        let mut outside: Vec<&str> = args
            .iter()
            .map(|(name, _)| name.as_str())
            .filter(|name| !CALL_ORDER.contains(name))
            .collect();
        outside.sort_unstable();
        return refuse(format!(
            "an argument outside the call order: {}",
            outside.join(", ")
        ));
    }
    Ok(Call {
        tool,
        args: ordered,
    })
}

/// The one kind a verb fixes, when the verb is written as the table writes it.
fn kind_of_exact_verb(verb: &str) -> Option<&'static str> {
    Verb::parse(verb).filter(|known| known.spec().name == verb)?;
    kind_a_verb_fixes(Some(verb))
}

/// The call a think states: a pure function of the think, the `dates:` line of the prompt (what a `dates[i]` is read
/// against; `None`: the prompt has none) and the trace version a text with no construct of either version is read as
/// (`trace.py` `compile_call`).
///
/// # Errors
///
/// A [`Refusal`] when the text is no trace, or does not state a whole call.
pub fn compile_think(think: &str, dates: Option<&str>, mode: TraceMode) -> Result<Call, Refusal> {
    match parse_any(think, mode) {
        Ok(slots) => compile_slots(&slots, dates),
        Err(message) => refuse(message),
    }
}

// ---------------------------------------------------------------------------------------------
// the v4 rewrite
// ---------------------------------------------------------------------------------------------

/// A row of the block as the model reads it: the name and the line it is shown on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowText {
    pub name: String,
    pub line: String,
}

/// What a pick's reason is read from: the context in front of the call, and no more.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Context {
    /// The turn's user message.
    pub message: String,
    /// The block's `focus:` line, without its `focus: ` lead.
    pub focus: Option<String>,
    /// The rows the think names, by number as written without leading zeros: the last line that showed each.
    pub rows: BTreeMap<String, RowText>,
}

/// A v3.1 think v4 cannot say, or says as another call. `reason` is `find`, `rows+row`, `unparsable` or `roundtrip`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skip {
    pub reason: &'static str,
    pub detail: String,
}

fn skip<T>(reason: &'static str, detail: impl Into<String>) -> Result<T, Skip> {
    Err(Skip {
        reason,
        detail: detail.into(),
    })
}

/// Why row `number` is the one the call takes, one of `PICK_REASONS`, read from the context the model sees. A row the message
/// does not name is `created` (this session made it), `asked` (the runtime asked about it) or `focus` (the focus line shows
/// it), whichever the focus line says; a row the message names is `name`, or `nick` when only the person's nickname is said;
/// else `date` when the message has a date and the row one, else `kind`.
fn pick_reason(context: &Context, number: &str) -> &'static str {
    let row = context.rows.get(number);
    let said = words(&context.message);
    let named = row.is_some_and(|row| {
        words(&row.name)
            .iter()
            .any(|word| !text::is_stop(word) && said.iter().any(|other| same(word, other)))
    });
    if named {
        return "name";
    }
    if let Some(focus) = &context.focus {
        let shown = focus_sets(focus);
        for why in ["created", "asked", "focus"] {
            if shown
                .iter()
                .any(|(heading, rows)| *heading == why && rows.iter().any(|row| row == number))
            {
                return why;
            }
        }
    }
    let own = row.map(|row| own_text(number, &row.line));
    if let Some(nick) = own.and_then(nickname)
        && words(nick)
            .iter()
            .any(|word| said.iter().any(|other| same(word, other)))
    {
        return "nick";
    }
    if own.is_some_and(shows_date) && has_time_phrase(&context.message) {
        return "date";
    }
    "kind"
}

/// `pick_reason` without a context (the golden file keeps thinks, not conversations): `focus` for a row an earlier turn showed
/// (a real `refer`), else what the rejected candidates of the v3.1 pick said, else `kind`.
fn hint_of(slots: &Slots) -> &'static str {
    if slots
        .refer
        .as_ref()
        .is_some_and(|refer| !refer.handles.is_empty())
    {
        return "focus";
    }
    let whys: Vec<&str> = slots
        .pick
        .iter()
        .flatten()
        .filter_map(|(_, why)| why.as_deref())
        .collect();
    if whys.contains(&"name") {
        "name"
    } else if whys.contains(&"date") {
        "date"
    } else {
        "kind"
    }
}

/// The handles of a handle slot (`#4, #5`, `@2`), or `None` when it holds anything else.
fn pure_handles(text: &str) -> Option<Vec<&str>> {
    let handles: Vec<&str> = text.split(',').map(py_strip).collect();
    handles
        .iter()
        .all(|handle| is_handle(handle))
        .then_some(handles)
}

/// The v4 slots of a parsed v3.1 trace. The rows the call names are a `pick` when they are one `#n` (the reason read from the
/// context, else `hint_of`), else a `rows` / `row` slot as written; `scope`, `refer` and `target` go; an act's `kind` goes when
/// its verb fixes it and a `name` selects.
fn v4_slots(slots: &Slots, context: Option<&Context>) -> Result<Slots, Skip> {
    if slots.via.as_deref() == Some("find") {
        return skip("find", "a v3.1 lookup step has no v4 form");
    }
    if slots.has("rows") && slots.has("row") {
        return skip("rows+row", "");
    }
    let tool = slots
        .via
        .clone()
        .unwrap_or_else(|| default_tool(&slots.intent.0).to_owned());
    let mut out = slots.clone();
    out.scope = None;
    out.refer = None;
    out.target = None;
    out.pick = None;
    out.pick_reason = None;
    out.raw.remove("rows");
    out.raw.remove("row");
    out.v4 = true;
    let explicit = ["rows", "row"].into_iter().find(|key| slots.has(key));
    let stated: Option<String> = match explicit {
        Some(key) => slots.raw.get(key).cloned(),
        None if slots.any_handle_slot() => None,
        None => derived_rows(slots),
    };
    if let Some(rows) = stated.as_ref().filter(|rows| !rows.is_empty()) {
        let key = explicit.unwrap_or_else(|| rows_key(&tool));
        match pure_handles(rows).as_deref() {
            Some([handle]) if handle.starts_with('#') && key == rows_key(&tool) => {
                let number = normal_int(&handle[1..]);
                let reason =
                    context.map_or_else(|| hint_of(slots), |context| pick_reason(context, &number));
                out.pick = Some(vec![(number, None)]);
                out.pick_reason = Some(reason.to_owned());
            }
            _ => {
                if let Some(name) = RAW.iter().find(|name| **name == key) {
                    out.raw.insert(name, rows.clone());
                }
            }
        }
    }
    let stated_rows = stated.as_ref().is_some_and(|rows| !rows.is_empty());
    if tool == "act"
        && out.has("name")
        && !stated_rows
        && !out.any_handle_slot()
        && let Some(kind) = out.raw.get("kind").filter(|kind| !kind.is_empty())
        && out.verb.as_deref().and_then(kind_of_exact_verb) == Some(kind.as_str())
    {
        out.raw.remove("kind");
    }
    Ok(out)
}

fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "'"))
}

/// `trace.py` `render3` of a v4 trace: one line per slot, in `ORDER4`.
fn render4(slots: &Slots) -> String {
    let mut lines: Vec<String> = Vec::new();
    for key in ORDER4 {
        match key {
            "retry" => {
                if let Some(value) = slots.retry.as_ref().filter(|value| !value.is_empty()) {
                    lines.push(format!("retry: {value}"));
                }
            }
            "intent" => {
                let (word, phrase) = &slots.intent;
                lines.push(if phrase.is_empty() {
                    format!("intent: {word}")
                } else {
                    format!("intent: {word} {}", quote(phrase))
                });
            }
            "via" => lines.extend(slots.via.as_ref().map(|via| format!("via: {via}"))),
            "verb" => lines.extend(slots.verb.as_ref().map(|verb| format!("verb: {verb}"))),
            "pick" => {
                if let (Some(pick), Some(reason)) = (&slots.pick, &slots.pick_reason)
                    && let Some((number, _)) = pick.first()
                {
                    lines.push(format!("pick: #{number} ({reason})"));
                }
            }
            "when" => {
                if let Some(source) = &slots.when {
                    let head = match source {
                        Source::Quote(phrase) => quote(phrase),
                        Source::Earlier(phrase) if phrase.is_empty() => "earlier".to_owned(),
                        Source::Earlier(phrase) => format!("earlier {}", quote(phrase)),
                        Source::Now => "now".to_owned(),
                    };
                    lines.push(
                        match slots.when_expr.as_ref().filter(|expr| !expr.is_empty()) {
                            Some(expr) => format!("when: {head} = {expr}"),
                            None => format!("when: {head}"),
                        },
                    );
                }
            }
            "set" => {
                if let Some(set) = slots.set.as_ref().filter(|set| !set.is_empty()) {
                    let entries: Vec<String> = set
                        .iter()
                        .map(|(name, value, is_date)| {
                            format!("{name} = {}{value}", if *is_date { "~" } else { "" })
                        })
                        .collect();
                    lines.push(format!("set: {}", entries.join(" · ")));
                }
            }
            "time" => {
                if let Some(time) = slots.time.as_ref().filter(|time| !time.is_empty()) {
                    lines.push(format!("time: {}", time.join(" · ")));
                }
            }
            _ => lines.extend(slots.raw.get(key).map(|value| format!("{key}: {value}"))),
        }
    }
    lines.join("\n")
}

/// A call as Python's `json.dumps(call, ensure_ascii=False)` writes it, cut to its first 140 characters.
fn dumps_call(call: &Call) -> String {
    let args: Vec<String> = call
        .args
        .iter()
        .map(|(key, value)| format!("{}: {}", json_string(key), json_string(value)))
        .collect();
    let text = format!(
        "{{\"tool\": {}, \"args\": {{{}}}}}",
        json_string(&call.tool),
        args.join(", ")
    );
    text.chars().take(140).collect()
}

/// One argument as it is compared: a date as the object it spells, so the order of its keys does not matter.
#[derive(PartialEq)]
enum Compared {
    Text(String),
    Json(Value),
    Lines(Vec<(String, Compared)>),
}

fn json_or_text(text: &str) -> Compared {
    serde_json::from_str::<Value>(text)
        .map_or_else(|_| Compared::Text(text.to_owned()), Compared::Json)
}

fn compared(key: &str, value: &str) -> Compared {
    match key {
        "when" => json_or_text(value),
        "args" => Compared::Lines(
            value
                .split('\n')
                .map(|line| {
                    let (name, rest) = line.split_once(": ").unwrap_or((line, ""));
                    (
                        name.to_owned(),
                        if rest.starts_with('{') {
                            json_or_text(rest)
                        } else {
                            Compared::Text(rest.to_owned())
                        },
                    )
                })
                .collect(),
        ),
        _ => Compared::Text(value.to_owned()),
    }
}

/// `trace.py` `same_call`: the same tool and the same arguments, order aside.
fn same_call(a: &Call, b: &Call) -> bool {
    a.tool == b.tool
        && a.args.len() == b.args.len()
        && a.args.iter().all(|(key, value)| {
            b.args
                .iter()
                .find(|(other, _)| other == key)
                .is_some_and(|(_, other)| compared(key, value) == compared(key, other))
        })
}

/// The v4 text of a v3.1 think (`trace.py` `v4_think`). `dates` is the prompt's `dates:` line, which a `dates[i]` compiles
/// against; `context` the conversation the pick's reason is read from (none: the reason is `reason_hint`).
///
/// # Errors
///
/// A [`Skip`] when v4 cannot say the think, or when its compiled call is not the v3.1 think's.
pub fn v4_think(
    think: &str,
    dates: Option<&str>,
    context: Option<&Context>,
) -> Result<String, Skip> {
    let old = match parse_any(think, TraceMode::V31) {
        Ok(slots) => slots,
        Err(message) => return skip("unparsable", message),
    };
    if old.v4 {
        return Ok(py_strip(think).to_owned());
    }
    let new = v4_slots(&old, context)?;
    let rendered = render4(&new);
    let compile = |slots: &Slots| compile_slots(slots, dates);
    let (want, got) = match (compile(&old), parse4(&rendered)) {
        (Ok(want), Ok(reread)) => match compile(&reread) {
            Ok(got) => (want, got),
            Err(refusal) => {
                return skip(
                    "roundtrip",
                    format!("does not compile: {}", refusal.message),
                );
            }
        },
        (Err(refusal), _) => {
            return skip(
                "roundtrip",
                format!("does not compile: {}", refusal.message),
            );
        }
        (_, Err(message)) => return skip("roundtrip", format!("does not compile: {message}")),
    };
    if !same_call(&got, &want) {
        return skip(
            "roundtrip",
            format!(
                "v4 compiles to {}, v3.1 to {}",
                dumps_call(&got),
                dumps_call(&want)
            ),
        );
    }
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(think: &str, dates: Option<&str>, mode: TraceMode) -> Call {
        compile_think(think, dates, mode).unwrap_or_else(|refusal| panic!("{think}: {refusal:?}"))
    }

    fn args(call: &Call) -> Vec<(&str, &str)> {
        call.args
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    #[test]
    fn a_v31_think_states_its_call() {
        let c = call(
            "intent: write \"cancel it\"\nverb: cancel\nscope: one\nrefer: it \"it\" -> #7\nkind: event",
            None,
            TraceMode::V31,
        );
        assert_eq!(c.tool, "act");
        assert_eq!(
            args(&c),
            [("verb", "cancel"), ("rows", "#7"), ("kind", "event")]
        );
    }

    #[test]
    fn a_v4_pick_states_the_rows_and_a_name_takes_the_kind_its_verb_fixes() {
        let c = call(
            "intent: write\nverb: complete\npick: #31 (name)\nwithin: @1",
            None,
            TraceMode::V4,
        );
        assert_eq!(
            args(&c),
            [("verb", "complete"), ("rows", "#31"), ("within", "@1")]
        );
        let c = call(
            "intent: write\nverb: complete\nname: Pay rent",
            None,
            TraceMode::V4,
        );
        assert_eq!(
            args(&c),
            [("verb", "complete"), ("kind", "task"), ("name", "Pay rent")]
        );
        let c = call(
            "intent: write\nverb: complete\nname: Pay rent",
            None,
            TraceMode::V31,
        );
        assert_eq!(args(&c), [("verb", "complete"), ("name", "Pay rent")]);
    }

    #[test]
    fn a_date_is_the_compact_form_or_an_entry_of_the_dates_line() {
        let line = "dates: friday = 2026-03-20 · next week = 2026-03-16..2026-03-22";
        let c = call(
            "intent: write\nverb: reschedule\nset: to = ~dates[0]\nrows: #4",
            Some(line),
            TraceMode::V31,
        );
        assert_eq!(args(&c)[2], ("args", "to: {\"date\":\"2026-03-20\"}"));
        let c = call(
            "intent: read\nkind: event\nwhen: \"friday\" = week+0 wd5 t\ntime: 15:00",
            None,
            TraceMode::V31,
        );
        assert_eq!(
            args(&c)[1],
            (
                "when",
                "{\"unit\":\"week\",\"rel\":0,\"weekday\":5,\"time\":\"15:00\"}"
            )
        );
        let c = call(
            "intent: read\nkind: event\nwhen: \"x\" = dates[1]",
            Some(line),
            TraceMode::V31,
        );
        assert_eq!(
            args(&c)[1],
            (
                "when",
                "{\"from\":{\"date\":\"2026-03-16\"},\"to\":{\"date\":\"2026-03-22\"}}"
            )
        );
        let refusal = compile_think(
            "intent: read\nkind: event\nwhen: \"x\" = dates[1]",
            None,
            TraceMode::V31,
        )
        .unwrap_err();
        assert_eq!(refusal.message, "a dates[i] needs the dates line");
        let refusal = compile_think(
            "intent: read\nkind: event\nwhen: \"x\" = dates[3]",
            Some(line),
            TraceMode::V31,
        )
        .unwrap_err();
        assert_eq!(
            refusal.message,
            "dates[3]: the dates line holds 2 entries, not 4"
        );
    }

    #[test]
    fn a_where_is_respelled_in_the_one_spelling() {
        let c = call(
            "intent: read\nkind: task\nwhere: status = open · effort > 60",
            None,
            TraceMode::V31,
        );
        assert_eq!(args(&c)[1], ("where", "status = \"open\" and effort > 60"));
    }

    #[test]
    fn a_think_that_states_no_call_is_refused_naming_why() {
        let refuse_with = |think: &str| {
            compile_think(think, None, TraceMode::V4)
                .unwrap_err()
                .message
        };
        assert_eq!(
            refuse_with("intent: write \"move\"\nkind: event"),
            "an act without a verb slot"
        );
        assert_eq!(
            refuse_with("what is on friday"),
            "not a slot: 'what is on friday'"
        );
        assert_eq!(
            refuse_with("intent: read\nkind: x\nverb: star"),
            "slot out of order: 'verb: star'"
        );
        assert_eq!(refuse_with("verb: star"), "no intent line");
        assert_eq!(
            refuse_with("intent: read\nwhen: now = fortnight+1"),
            "date token 'fortnight+1'"
        );
        assert_eq!(
            refuse_with("intent: read\nlimit:"),
            "bad limit line: 'limit:'"
        );
    }

    #[test]
    fn a_v31_think_is_rewritten_as_v4_when_both_state_the_same_call() {
        let rewritten = v4_think(
            "intent: write \"tick off\"\nverb: complete\nscope: one\nrefer: none\ntarget: \"rent\"\npick: #31 ok · #33 no (kind)",
            None,
            None,
        );
        assert_eq!(
            rewritten.unwrap(),
            "intent: write \"tick off\"\nverb: complete\npick: #31 (kind)"
        );
        let many = v4_think(
            "intent: write \"delete\"\nverb: delete\nscope: some\nrows: #31, #33",
            None,
            None,
        );
        assert_eq!(
            many.unwrap(),
            "intent: write \"delete\"\nverb: delete\nrows: #31, #33"
        );
        let lookup = v4_think(
            "intent: read\nvia: find\nkind: task\nname: Pay rent",
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(lookup.reason, "find");
        let unparsable = v4_think("intent: nonsense", None, None).unwrap_err();
        assert_eq!(unparsable.reason, "unparsable");
    }

    #[test]
    fn the_reason_of_a_pick_is_read_from_the_context() {
        let think =
            "intent: write\nverb: delete\nscope: one\nrefer: none\npick: #31 ok · #33 no (kind)";
        let mut context = Context {
            message: "delete the rent one".to_owned(),
            ..Context::default()
        };
        context.rows.insert(
            "31".to_owned(),
            RowText {
                name: "Pay rent".to_owned(),
                line: "#31 task \"Pay rent\"".to_owned(),
            },
        );
        assert!(
            v4_think(think, None, Some(&context))
                .unwrap()
                .ends_with("pick: #31 (name)")
        );
        context.message = "delete it".to_owned();
        context.focus = Some("@1: #31 task \"Pay rent\" · created #40 task \"x\"".to_owned());
        assert!(
            v4_think(think, None, Some(&context))
                .unwrap()
                .ends_with("pick: #31 (focus)")
        );
        context.focus = Some("created #31 task \"Pay rent\"".to_owned());
        assert!(
            v4_think(think, None, Some(&context))
                .unwrap()
                .ends_with("pick: #31 (created)")
        );
        context.focus = None;
        context.message = "delete the one due friday".to_owned();
        context.rows.get_mut("31").unwrap().line =
            "#31 task \"Pay rent\" due 2026-03-20".to_owned();
        assert!(
            v4_think(think, None, Some(&context))
                .unwrap()
                .ends_with("pick: #31 (date)")
        );
    }
}
