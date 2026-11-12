//! STAGE 6, THE THINK: the v4 trace of a reference call (`CONTRACT_V3.md` §8, with the tools of §9), checked by the
//! runtime's own compiler.
//!
//! The model writes a think (slots: what the turn is for, the verb, the row, the filters, the dates) and the harness
//! compiles the call from it (`centraid_assist::native::think::compile_think_with`, which `decode_step` runs on the
//! phone). Training data is therefore the think, and the call text that follows it is not written here: it is what the
//! compiler gives back. [`trace`] derives the think from a reference call and refuses it unless the compiler reads the
//! think back as the same call. A think that does not round-trip is never a record.
//!
//! What the think states, per slot (the v4 order):
//!
//! | slot | from the reference call |
//! | --- | --- |
//! | `retry` | `rejected` on the step after a call the runtime refused |
//! | `intent` | the turn's act (`read`, `count`, `write`, `ask`, `decline`) and the opening words of the message |
//! | `via` | `find` or `compute` for those tools |
//! | `verb` | `create`, `edit`, or the `do` verb |
//! | `pick` | one `#n` row, with the reason the context gives (`name`, `kind`, `date`, `focus`, `created`, `asked`, `nick`) |
//! | `rows`, `value`, `options`, `linked_to`, `within`, `exclude` | the handles as the call writes them |
//! | `kind`, `op`, `field`, `group`, `trashed`, `name`, `text`, `order`, `limit`, `more`, `question`, `reason` | the argument |
//! | `where` | the typed segments (`status = open · priority >= 1`), a number the message says as `nums[i]` |
//! | `when` | `"<phrase>" = dates[i]` when the `dates:` line reads the call's period, else the compact date |
//! | `set`, `time` | the `args` lines of a create, an edit or a `do` (`name = Pay rent`), a date as `~week+1 wd5` |

use std::collections::BTreeMap;

use centraid_assist::native::meta::{self, Kind};
use centraid_assist::native::nums;
use centraid_assist::native::think::{
    Call, Context, RowText, TraceMode, compile_think_with, date_to_compact, pick_reason_of,
    where_slot,
};
use jiff::civil::Date;
use serde_json::{Value, json};

use crate::intent::Period;

/// A reference call, as a record writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefCall {
    pub tool: String,
    /// The arguments in the record's order (keys sorted).
    pub args: Vec<(String, String)>,
    /// A call the runtime is expected to refuse: the first half of an error-then-repair turn.
    pub bad: bool,
}

impl RefCall {
    /// The call of a `ref` entry.
    #[must_use]
    pub fn of(value: &Value) -> Option<Self> {
        let args = value["args"]
            .as_object()?
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned),
                )
            })
            .collect();
        Some(Self {
            tool: value["tool"].as_str()?.to_owned(),
            args,
            bad: value["bad"].as_bool().unwrap_or(false),
        })
    }

    fn with_arg(&self, key: &str, value: &str) -> Self {
        let mut next = self.clone();
        for (name, held) in &mut next.args {
            if name == key {
                value.clone_into(held);
            }
        }
        next
    }

    fn arg(&self, key: &str) -> Option<&str> {
        self.args
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}

/// What the model can read when it writes a step.
pub struct Setting<'a> {
    /// The turn's user message.
    pub message: &'a str,
    /// The day the session runs on.
    pub today: Date,
    /// What the turn is for, as the guard reads it: `read`, `count`, `write`, `ask` or `decline`.
    pub intent: &'static str,
    /// The turn's block (`vault:`, `focus:`, `dates:`, `nums:` lines), without the message.
    pub block: &'a str,
    /// The rows shown so far, by number, as the pick's reason reads them.
    pub rows: &'a BTreeMap<String, RowText>,
    /// Date expressions an earlier call of the session already used (compact JSON).
    pub earlier_dates: &'a [Value],
    /// Everything the model has read so far in the session after the system turn: the blocks and the observations.
    pub seen: &'a str,
    /// The kind of the last lookup this turn made (`find` or `compute`), which a write on `@k` is about.
    pub turn_kind: Option<&'a str>,
    /// The step follows a call the runtime refused.
    pub retry: bool,
}

/// Why a reference call has no think.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The call carries something a slot cannot spell (a field value with a line break or ` · `, a date outside the
    /// compact form).
    Unspellable(String),
    /// The compiler reads the think as another call, or refuses it.
    Roundtrip(String),
}

impl Failure {
    /// The short word a report counts it under.
    #[must_use]
    pub const fn word(&self) -> &'static str {
        match self {
            Self::Unspellable(_) => "unspellable",
            Self::Roundtrip(_) => "roundtrip",
        }
    }

    #[must_use]
    pub fn detail(&self) -> &str {
        match self {
            Self::Unspellable(detail) | Self::Roundtrip(detail) => detail,
        }
    }
}

/// How a step's slots were sourced, counted by the report.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sourcing {
    /// A period read as `dates[i]`.
    pub dates_ref: bool,
    /// A period written as the compact date (the `dates:` line did not read it).
    pub dates_literal: bool,
    /// A number read as `nums[i]`.
    pub nums_ref: bool,
}

/// A step's think, and the call the compiler gives back for it.
#[derive(Debug, Clone)]
pub struct Traced {
    pub think: String,
    pub call: Call,
    pub sourcing: Sourcing,
    /// The `when` the step carries when it is not the reference call's: a period the member's own dates say (`aug 17 to
    /// aug 23`) that the planner wrote relative to today (`week-8`), as the days it covers. The same days, so the same
    /// effect; the record's `ref` takes this spelling so that it is the call the think states.
    pub when: Option<String>,
}

/// The think of `call`, round-tripped through the compiler.
///
/// # Errors
///
/// A [`Failure`] when a slot cannot spell the call, or the compiler reads the think as another call.
pub fn trace(call: &RefCall, setting: &Setting<'_>) -> Result<Traced, Failure> {
    let dates = line_of(setting.block, "dates:");
    let nums_line = line_of(setting.block, "nums:");
    let explicit = call
        .arg("when")
        .and_then(|when| explicit_period(when, setting.today, dates));
    let effective;
    let call = match &explicit {
        Some(when) => {
            effective = call.with_arg("when", when);
            &effective
        }
        None => call,
    };
    let kind = kind_of(call, setting);
    let mut base = slots(call, setting, kind)?;
    let mut sourcing = Sourcing::default();

    // the period: `dates[i]` when the line reads it, else the compact date
    if let Some(expr) = base.when.clone() {
        base.when_slot = Some(match dates_slot(&base, setting, dates, nums_line, &expr) {
            Some(slot) => {
                sourcing.dates_ref = true;
                slot
            }
            None => {
                sourcing.dates_literal = true;
                literal_when(&expr, setting, dates)
            }
        });
    }

    // numbers the message says are read from the `nums:` line when the compiler gives the same call
    let mut chosen = base.clone();
    if let Some(line) = nums_line {
        let with = base.with_nums(&nums::values(line));
        if with.text != base.text || with.set != base.set {
            let think = with.think(setting);
            if check(call, &think, dates, nums_line, kind).is_ok() {
                chosen = with;
                sourcing.nums_ref = true;
            }
        }
    }
    let think = chosen.think(setting);
    let compiled = check(call, &think, dates, nums_line, kind)?;
    Ok(Traced {
        think,
        call: compiled,
        sourcing,
        when: explicit,
    })
}

/// A period written relative to today (`{"unit":"week","rel":-8}`) as the days it covers, when the `dates:` line reads a day
/// of them: the message says the days (`aug 17 to aug 23`), so the call states the days it said, not a count of weeks from
/// today the model would have to work out. `None` for any other period, or when the line reads nothing in it.
fn explicit_period(when: &str, today: Date, dates: Option<&str>) -> Option<String> {
    let period: Period = serde_json::from_str(when).ok()?;
    if matches!(period, Period::Between { .. }) {
        return None;
    }
    let (from, to) = period.range(today)?;
    let body = dates?.strip_prefix("dates: ")?;
    let touched = body.split(" · ").any(|entry| {
        entry
            .split(|c: char| !(c.is_ascii_digit() || c == '-'))
            .filter(|day| day.len() == 10)
            .filter_map(|day| day.parse::<Date>().ok())
            .any(|day| from <= day && day <= to)
    });
    touched.then(|| {
        json!({"from": {"date": from.to_string()}, "to": {"date": to.to_string()}}).to_string()
    })
}

// ---------------------------------------------------------------------------------------------

/// The slots of a step, minus the period's spelling.
#[derive(Debug, Clone)]
struct Slots {
    text: Vec<(&'static str, String)>,
    /// `set` entries (`name`, value, is a date).
    set: Vec<(String, String, bool)>,
    /// The `time` values the dates in `set` and `when` stand for.
    times: Vec<String>,
    when: Option<Value>,
    when_slot: Option<(String, Vec<String>)>,
    pick: Option<(String, String)>,
}

/// The kind a write's fields are the fields of: the kind a `create` names, else the kind of the row it acts on (the line that
/// showed `#n`, or the lookup of the turn for an `@k`).
fn kind_of(call: &RefCall, setting: &Setting<'_>) -> Option<Kind> {
    if call.tool == "create" {
        return call.arg("kind").and_then(Kind::parse);
    }
    if !matches!(call.tool.as_str(), "edit" | "do") {
        return None;
    }
    let rows = call.arg("rows")?;
    if let Some(number) = rows.strip_prefix('#')
        && let Some(row) = setting.rows.get(number.trim_start_matches('0'))
        && let Some(at) = row.line.find(&format!("#{number} "))
    {
        let rest = &row.line[at + number.len() + 2..];
        let rest = rest
            .strip_prefix('[')
            .map_or(rest, |r| r.split_once("] ").map_or(r, |(_, after)| after));
        if let Some(kind) = rest.split(" \"").next().and_then(Kind::parse) {
            return Some(kind);
        }
    }
    setting.turn_kind.and_then(Kind::parse)
}

/// The name chat writes a field under: `date` for the `due` of a task, as the kind card says it.
fn canonical(kind: Option<Kind>, tool: &str, name: &str) -> String {
    let Some(kind) = kind else {
        return name.to_owned();
    };
    let found = match tool {
        "create" => meta::create_arg_canonical(kind, name),
        "edit" => meta::edit_actions(kind)
            .iter()
            .find_map(|action| action.canonical_name(name)),
        _ => None,
    };
    found.unwrap_or(name).to_owned()
}

fn slots(call: &RefCall, setting: &Setting<'_>, kind: Option<Kind>) -> Result<Slots, Failure> {
    let mut text: Vec<(&'static str, String)> = Vec::new();
    let mut out = Slots {
        text: Vec::new(),
        set: Vec::new(),
        times: Vec::new(),
        when: None,
        when_slot: None,
        pick: None,
    };
    let write_tool = matches!(call.tool.as_str(), "create" | "edit" | "do");
    match call.tool.as_str() {
        "find" => text.push(("via", "find".to_owned())),
        "compute" => text.push(("via", "compute".to_owned())),
        "create" => text.push(("verb", "create".to_owned())),
        "edit" => text.push(("verb", "edit".to_owned())),
        "do" => {
            let verb = call
                .arg("verb")
                .ok_or_else(|| Failure::Unspellable("a `do` with no verb".to_owned()))?;
            text.push(("verb", verb.to_owned()));
        }
        _ => {}
    }
    for (key, value) in &call.args {
        match key.as_str() {
            "verb" | "when" => {}
            "args" if write_tool => {
                for line in value.split('\n') {
                    let (name, rest) =
                        line.split_once(": ")
                            .filter(|(name, _)| !name.is_empty())
                            .ok_or_else(|| Failure::Unspellable(format!("args line {line:?}")))?;
                    if rest.contains(" · ") || rest.is_empty() || name.contains(' ') {
                        return Err(Failure::Unspellable(format!("args line {line:?}")));
                    }
                    let name = canonical(kind, &call.tool, name);
                    let name = name.as_str();
                    match serde_json::from_str::<Value>(rest) {
                        Ok(expr) if expr.is_object() => {
                            let (compact, times) = date_to_compact(&expr).ok_or_else(|| {
                                Failure::Unspellable(format!("date {rest} in args"))
                            })?;
                            out.times.extend(times);
                            out.set.push((name.to_owned(), compact, true));
                        }
                        _ => out.set.push((name.to_owned(), rest.to_owned(), false)),
                    }
                }
            }
            "rows" if write_tool || call.tool == "answer" => {
                let handles = split_handles(value);
                if let [single] = handles.as_slice()
                    && let Some(number) = single.strip_prefix('#')
                {
                    out.pick = Some((number.to_owned(), String::new()));
                } else {
                    text.push(("rows", handles.join(", ")));
                }
            }
            "rows" | "linked_to" | "within" | "exclude" | "value" | "options" => {
                text.push((slot_name(key), split_handles(value).join(", ")));
            }
            "where" => text.push(("where", where_slot(value).unwrap_or_else(|| value.clone()))),
            other => {
                let slot = slot_name(other);
                if slot.is_empty() {
                    return Err(Failure::Unspellable(format!("argument {other}")));
                }
                if value.contains('\n') {
                    return Err(Failure::Unspellable(format!("{other} has a line break")));
                }
                text.push((slot, value.clone()));
            }
        }
    }
    if let Some(when) = call.arg("when") {
        out.when = Some(
            serde_json::from_str::<Value>(when)
                .map_err(|_| Failure::Unspellable(format!("when {when:?}")))?,
        );
    }
    if let Some((number, _)) = out.pick.take() {
        let context = context_of(setting);
        let reason = pick_reason_of(&context, &number);
        out.pick = Some((number, reason.to_owned()));
    }
    out.text = text;
    Ok(out)
}

fn slot_name(key: &str) -> &'static str {
    const NAMES: [&str; 20] = [
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
        "value",
        "options",
        "question",
        "reason",
        "row",
    ];
    NAMES
        .iter()
        .find(|name| **name == key)
        .copied()
        .unwrap_or("")
}

/// `#4,#7` or `@1, @2` as a list of handles.
fn split_handles(text: &str) -> Vec<String> {
    text.split(',')
        .map(|part| part.trim().to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

impl Slots {
    /// A `nums[i]` for every number a condition or a field value states that the `nums:` line has.
    fn with_nums(&self, values: &[String]) -> Self {
        let mut next = self.clone();
        for (key, value) in &mut next.text {
            if *key == "where" {
                *value = value
                    .split(" · ")
                    .map(|cond| num_cond(cond, values))
                    .collect::<Vec<_>>()
                    .join(" · ");
            }
        }
        for (_, value, is_date) in &mut next.set {
            if !*is_date && let Some(at) = values.iter().position(|v| v == value) {
                *value = format!("nums[{at}]");
            }
        }
        next
    }

    /// The think, slots in the v4 order.
    fn think(&self, setting: &Setting<'_>) -> String {
        let mut lines: Vec<String> = Vec::new();
        if setting.retry {
            lines.push("retry: rejected".to_owned());
        }
        lines.push(format!(
            "intent: {}{}",
            setting.intent,
            phrase_of(setting.message)
        ));
        let has = |key: &str| self.text.iter().find(|(name, _)| *name == key);
        let ordered = |keys: &[&str], lines: &mut Vec<String>| {
            for key in keys {
                if let Some((name, value)) = has(key) {
                    lines.push(format!("{name}: {value}"));
                }
            }
        };
        ordered(&["via", "verb"], &mut lines);
        if let Some((number, reason)) = &self.pick {
            lines.push(format!("pick: #{number} ({reason})"));
        }
        ordered(&["rows"], &mut lines);
        ordered(
            &[
                "kind", "op", "field", "group", "trashed", "name", "text", "where",
            ],
            &mut lines,
        );
        if let Some((compact, _)) = &self.when_slot {
            lines.push(format!("when: {compact}"));
        }
        ordered(
            &["linked_to", "within", "exclude", "order", "limit", "more"],
            &mut lines,
        );
        if !self.set.is_empty() {
            let entries: Vec<String> = self
                .set
                .iter()
                .map(|(name, value, is_date)| {
                    format!("{name} = {}{value}", if *is_date { "~" } else { "" })
                })
                .collect();
            lines.push(format!("set: {}", entries.join(" · ")));
        }
        let times: Vec<&String> = self
            .when_slot
            .iter()
            .flat_map(|(_, times)| times.iter())
            .chain(self.times.iter())
            .collect();
        if !times.is_empty() {
            lines.push(format!(
                "time: {}",
                times
                    .iter()
                    .map(|t| t.as_str())
                    .collect::<Vec<_>>()
                    .join(" · ")
            ));
        }
        ordered(&["value", "options", "question", "reason"], &mut lines);
        lines.join("\n")
    }
}

/// `field op nums[i] unit` for a numeric value the line has; any other condition unchanged.
fn num_cond(cond: &str, values: &[String]) -> String {
    for op in ["<=", ">=", "!=", "<", ">", "="] {
        let Some((field, value)) = cond.split_once(&format!(" {op} ")) else {
            continue;
        };
        let (number, unit) = value
            .split_once(' ')
            .map_or((value, None), |(number, unit)| (number, Some(unit)));
        if let Some(at) = values.iter().position(|v| v == number) {
            return match unit {
                Some(unit) => format!("{field} {op} nums[{at}] {unit}"),
                None => format!("{field} {op} nums[{at}]"),
            };
        }
        return cond.to_owned();
    }
    cond.to_owned()
}

/// ` "<the opening of the message>"`: no lexeme decides the intent word, so the message itself when it is short, else
/// its first clause or first words.
fn phrase_of(message: &str) -> String {
    let words: Vec<&str> = message.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }
    let clean = |text: &str| -> String {
        text.trim()
            .trim_end_matches(['?', '!', '.', ',', ';', ':'])
            .replace('"', "'")
            .replace('\n', " ")
    };
    let phrase = if words.len() <= 7 {
        clean(message)
    } else {
        let clause = message
            .split(['.', '!', '?', ',', ';', ':'])
            .next()
            .unwrap_or_default();
        let n = clause.split_whitespace().count();
        if (2..=7).contains(&n) {
            clean(clause)
        } else {
            clean(&words[..5].join(" "))
        }
    };
    if phrase.is_empty() {
        String::new()
    } else {
        format!(" \"{phrase}\"")
    }
}

// ---------------------------------------------------------------------------------------------
// the period
// ---------------------------------------------------------------------------------------------

/// `"<phrase>" = dates[i]` when an entry of the `dates:` line reads the call's period; `None` otherwise.
fn dates_slot(
    slots: &Slots,
    setting: &Setting<'_>,
    dates: Option<&str>,
    nums_line: Option<&str>,
    expr: &Value,
) -> Option<(String, Vec<String>)> {
    let line = dates?;
    let body = line.strip_prefix("dates: ")?;
    for (index, entry) in body.split(" · ").enumerate() {
        let Some((phrase, _)) = entry.split_once(" = ") else {
            continue;
        };
        let phrase = phrase.trim().replace('"', "'");
        for reading in ["", " past", " upcoming"] {
            let slot = format!("\"{phrase}\" = dates[{index}]{reading}");
            let mut candidate = slots.clone();
            candidate.when_slot = Some((slot.clone(), Vec::new()));
            let think = candidate.think(setting);
            if let Ok(compiled) = compile_think_with(
                &think,
                Some(line),
                nums_line,
                TraceMode::V4,
                crate::plan::tools_mode(),
            ) && let Some((_, when)) = compiled.args.iter().find(|(key, _)| key == "when")
                && serde_json::from_str::<Value>(when).is_ok_and(|got| &got == expr)
            {
                return Some((slot, Vec::new()));
            }
        }
    }
    None
}

/// Is the period read off something the model has already seen: a day of it written in what it has read (an event's date in
/// an observation, "the days of the dentist")?
fn said_before(expr: &Value, seen: &str) -> bool {
    fn leaves(value: &Value, out: &mut Vec<Date>) {
        if let Value::Object(map) = value {
            for (key, inner) in map {
                if key == "date" {
                    if let Some(day) = inner
                        .as_str()
                        .and_then(|d| d.get(..10))
                        .and_then(|d| d.parse().ok())
                    {
                        out.push(day);
                    }
                } else {
                    leaves(inner, out);
                }
            }
        }
    }
    let mut days = Vec::new();
    leaves(expr, &mut days);
    let (Some(first), Some(last)) = (days.iter().min(), days.iter().max()) else {
        return false;
    };
    seen.split(|c: char| !(c.is_ascii_digit() || c == '-'))
        .filter(|word| word.len() == 10)
        .filter_map(|word| word.parse::<Date>().ok())
        .any(|day| *first <= day && day <= *last)
}

/// The phrases of the `dates:` line whose reading holds a day the expression names, joined as the message says a range
/// (`aug 17 to aug 23`); `None` when the line holds none of them.
fn said_phrase(expr: &Value, dates: Option<&str>) -> Option<String> {
    let body = dates?.strip_prefix("dates: ")?;
    let text = expr.to_string();
    let mut phrases: Vec<String> = Vec::new();
    for entry in body.split(" · ") {
        let (phrase, resolution) = entry.split_once(" = ")?;
        // the days the reading holds, as they are written in the expression
        let days: Vec<&str> = resolution
            .split(|c: char| !(c.is_ascii_digit() || c == '-'))
            .filter(|day| day.len() == 10)
            .collect();
        if days.iter().any(|day| text.contains(day)) {
            let phrase = phrase.trim().replace('"', "'");
            if !phrases.contains(&phrase) {
                phrases.push(phrase);
            }
        }
    }
    (!phrases.is_empty()).then(|| phrases.join(" to "))
}

/// The compact date. Its source is the message when the `dates:` line reads a day of it (`"aug 17 to aug 23"`), `earlier`
/// when a call of the session used the same expression or its days are written in what the model has read, else `now`.
fn literal_when(expr: &Value, setting: &Setting<'_>, dates: Option<&str>) -> (String, Vec<String>) {
    let (compact, times) = date_to_compact(expr).unwrap_or_else(|| (String::new(), Vec::new()));
    let source = if let Some(phrase) = said_phrase(expr, dates) {
        format!("\"{phrase}\"")
    } else if setting.earlier_dates.contains(expr) || said_before(expr, setting.seen) {
        "earlier".to_owned()
    } else {
        "now".to_owned()
    };
    (format!("{source} = {compact}"), times)
}

// ---------------------------------------------------------------------------------------------
// the round trip
// ---------------------------------------------------------------------------------------------

/// The call the compiler gives for `think`, when it is the reference call.
fn check(
    call: &RefCall,
    think: &str,
    dates: Option<&str>,
    nums_line: Option<&str>,
    kind: Option<Kind>,
) -> Result<Call, Failure> {
    let compiled = compile_think_with(
        think,
        dates,
        nums_line,
        TraceMode::V4,
        crate::plan::tools_mode(),
    )
    .map_err(|refusal| Failure::Roundtrip(format!("does not compile: {}", refusal.message)))?;
    match same(call, &compiled, kind) {
        Ok(()) => Ok(compiled),
        Err(why) => Err(Failure::Roundtrip(why)),
    }
}

/// Is `compiled` the reference call? The tool and every argument alike, order aside: a date as the expression it spells,
/// handles without their spaces, a create's or edit's flat fields as the `args` lines they stand for.
///
/// # Errors
///
/// What differs.
pub fn same(call: &RefCall, compiled: &Call, kind: Option<Kind>) -> Result<(), String> {
    if call.tool != compiled.tool {
        return Err(format!("tool {} compiled to {}", call.tool, compiled.tool));
    }
    let wanted = normal(&call.tool, &call.args, kind);
    let got = normal(&compiled.tool, &compiled.args, kind);
    if wanted == got {
        Ok(())
    } else {
        Err(format!("wanted {wanted:?}, compiled {got:?}"))
    }
}

/// A call's arguments in a form two spellings of one call share.
fn normal(tool: &str, args: &[(String, String)], kind: Option<Kind>) -> BTreeMap<String, String> {
    let own: &[&str] = match tool {
        "create" => &["kind", "args", "more"],
        "edit" => &["rows", "args", "more"],
        _ => &[],
    };
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut lines: Vec<String> = Vec::new();
    for (key, value) in args {
        let flat = matches!(tool, "create" | "edit") && !own.contains(&key.as_str());
        if flat {
            lines.push(format!("{}: {value}", canonical(kind, tool, key)));
            continue;
        }
        let value = match key.as_str() {
            "when" => serde_json::from_str::<Value>(value)
                .map_or_else(|_| value.clone(), |json| json.to_string()),
            "rows" | "linked_to" | "within" | "exclude" | "value" | "options" => value
                .split(',')
                .map(str::trim)
                .collect::<Vec<_>>()
                .join(","),
            // the runtime reads a condition's quotes either way (`colour = red`, `colour = "red"`)
            "where" => value.replace('"', ""),
            "args" => {
                let parts: Vec<String> = value
                    .split('\n')
                    .map(|line| match line.split_once(": ") {
                        Some((name, rest)) => {
                            let name = canonical(kind, tool, name);
                            serde_json::from_str::<Value>(rest)
                                .ok()
                                .filter(Value::is_object)
                                .map_or_else(
                                    || format!("{name}: {rest}"),
                                    |json| format!("{name}: {json}"),
                                )
                        }
                        None => line.to_owned(),
                    })
                    .collect();
                parts.join("\n")
            }
            _ => value.clone(),
        };
        out.insert(key.clone(), value);
    }
    if !lines.is_empty() {
        let mut all: Vec<String> = out
            .remove("args")
            .map(|existing| existing.split('\n').map(str::to_owned).collect())
            .unwrap_or_default();
        for line in lines {
            all.push(match line.split_once(": ") {
                Some((name, rest)) => serde_json::from_str::<Value>(rest)
                    .ok()
                    .filter(Value::is_object)
                    .map_or_else(|| line.clone(), |json| format!("{name}: {json}")),
                None => line,
            });
        }
        out.insert("args".to_owned(), all.join("\n"));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// the context
// ---------------------------------------------------------------------------------------------

/// The line of a block that starts with `lead`.
#[must_use]
pub fn line_of<'a>(block: &'a str, lead: &str) -> Option<&'a str> {
    block.lines().find(|line| line.starts_with(lead))
}

fn context_of(setting: &Setting<'_>) -> Context {
    Context {
        message: setting.message.to_owned(),
        focus: line_of(setting.block, "focus: ").map(|line| line["focus: ".len()..].to_owned()),
        rows: setting.rows.clone(),
    }
}

/// Every row `#n` a text shows, with the line it is shown on (the last line that showed it wins).
pub fn show_rows(rows: &mut BTreeMap<String, RowText>, text: &str) {
    for line in text.lines() {
        let mut rest = line;
        while let Some(at) = rest.find('#') {
            let after = &rest[at + 1..];
            let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                let number = digits.trim_start_matches('0');
                let number = if number.is_empty() { "0" } else { number };
                let tail = &after[digits.len()..];
                let name: String = tail
                    .split_once('"')
                    .and_then(|(_, rest)| rest.split_once('"'))
                    .map(|(name, _)| name.to_owned())
                    .unwrap_or_default();
                rows.insert(
                    number.to_owned(),
                    RowText {
                        name,
                        line: line.to_owned(),
                    },
                );
            }
            rest = &after[digits.len()..];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setting<'a>(
        message: &'a str,
        block: &'a str,
        rows: &'a BTreeMap<String, RowText>,
    ) -> Setting<'a> {
        Setting {
            message,
            today: "2026-10-12".parse().unwrap(),
            intent: "read",
            block,
            rows,
            earlier_dates: &[],
            seen: "",
            turn_kind: None,
            retry: false,
        }
    }

    fn call(tool: &str, args: &[(&str, &str)]) -> RefCall {
        RefCall {
            tool: tool.to_owned(),
            args: args
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            bad: false,
        }
    }

    #[test]
    fn a_read_is_a_find_with_typed_filters_and_a_dates_reference() {
        let rows = BTreeMap::new();
        let block = "dates: last month = 2026-09-01..2026-09-30";
        let s = setting("which tasks are open from last month", block, &rows);
        let c = call(
            "find",
            &[
                ("kind", "task"),
                (
                    "when",
                    r#"{"from":{"date":"2026-09-01"},"to":{"date":"2026-09-30"}}"#,
                ),
                ("where", r#"status = "open" and priority >= 1"#),
            ],
        );
        let traced = trace(&c, &s).expect("round trip");
        assert_eq!(
            traced.think,
            "intent: read \"which tasks are open from last month\"\nvia: find\nkind: task\nwhere: status = open · priority >= 1\nwhen: \"last month\" = dates[0]"
        );
        assert!(traced.sourcing.dates_ref);
        assert!(same(&c, &traced.call, None).is_ok());
    }

    #[test]
    fn a_relative_period_the_message_says_in_days_is_written_in_days() {
        let rows = BTreeMap::new();
        let block = "dates: aug 17 = 2026-08-17 (past) / 2027-08-17 (upcoming) · aug 23 = 2026-08-23 (past) / 2027-08-23 (upcoming)";
        let s = setting("workouts aug 17 to aug 23", block, &rows);
        let c = call(
            "find",
            &[("kind", "workout"), ("when", r#"{"unit":"week","rel":-8}"#)],
        );
        let traced = trace(&c, &s).expect("round trip");
        assert!(
            traced
                .think
                .contains("when: \"aug 17 to aug 23\" = from 2026-08-17 to 2026-08-23"),
            "{}",
            traced.think
        );
        assert_eq!(
            traced.when.as_deref(),
            Some(r#"{"from":{"date":"2026-08-17"},"to":{"date":"2026-08-23"}}"#)
        );
        // a month the line reads whole is `dates[i]`
        let block =
            "dates: august = 2026-08-01..2026-08-31 (past) / 2027-08-01..2027-08-31 (upcoming)";
        let s = setting("and how many in august", block, &rows);
        let c = call(
            "compute",
            &[
                ("kind", "photo"),
                ("op", "count"),
                ("when", r#"{"unit":"month","rel":-2}"#),
            ],
        );
        let traced = trace(&c, &s).expect("round trip");
        assert!(
            traced.think.contains("when: \"august\" = dates[0] past"),
            "{}",
            traced.think
        );
        assert!(traced.sourcing.dates_ref);
    }

    #[test]
    fn a_period_the_line_does_not_read_is_the_compact_date() {
        let rows = BTreeMap::new();
        let s = setting("and the month after", "", &rows);
        let c = call(
            "compute",
            &[
                ("kind", "task"),
                ("op", "count"),
                ("when", r#"{"unit":"month","rel":1}"#),
            ],
        );
        let traced = trace(&c, &s).expect("round trip");
        assert!(traced.think.contains("when: now = month+1"));
        assert!(traced.sourcing.dates_literal);
    }

    #[test]
    fn a_number_the_message_says_is_read_from_the_nums_line() {
        let rows = BTreeMap::new();
        let block = "nums: fifty = 50";
        let s = setting("tasks with effort at most fifty", block, &rows);
        let c = call("find", &[("kind", "task"), ("where", "effort <= 50")]);
        let traced = trace(&c, &s).expect("round trip");
        assert!(traced.think.contains("where: effort <= nums[0]"));
        assert!(traced.sourcing.nums_ref);
    }

    #[test]
    fn a_write_on_one_row_picks_it_and_a_create_sets_its_fields() {
        // the regrouped tools' compiler: the build reads the model record's block (`sig`); held here so the test says what it reads
        let mut record = centraid_assist::record::record();
        record.current.tools_mode = "sig".to_owned();
        centraid_assist::record::held_for(record, || {
            let mut rows = BTreeMap::new();
            show_rows(&mut rows, "#31 task \"Pay rent\" · open");
            let mut s = setting("complete pay rent", "", &rows);
            s.intent = "write";
            let c = call("do", &[("rows", "#31"), ("verb", "complete")]);
            let traced = trace(&c, &s).expect("round trip");
            assert!(traced.think.contains("verb: complete\npick: #31 (name)"));

            let c = call(
                "create",
                &[
                    ("args", "name: Sort the receipts\neffort: 30"),
                    ("kind", "task"),
                ],
            );
            let traced = trace(&c, &s).expect("round trip");
            assert!(
                traced
                    .think
                    .contains("set: name = Sort the receipts · effort = 30")
            );
            // the compiler writes the fields as parameters of their own
            assert!(traced.call.args.iter().any(|(k, _)| k == "effort"));
        });
    }

    #[test]
    fn a_value_a_slot_cannot_spell_is_refused_not_guessed() {
        let rows = BTreeMap::new();
        let mut s = setting("note it", "", &rows);
        s.intent = "write";
        let c = call("create", &[("args", "name: a · b"), ("kind", "note")]);
        assert!(matches!(trace(&c, &s), Err(Failure::Unspellable(_))));
    }

    #[test]
    fn a_step_after_a_refusal_says_so() {
        let rows = BTreeMap::new();
        let mut s = setting("complete it", "", &rows);
        s.intent = "write";
        s.retry = true;
        let c = call("do", &[("rows", "@2"), ("verb", "complete")]);
        let traced = trace(&c, &s).expect("round trip");
        assert!(traced.think.starts_with("retry: rejected\nintent: write"));
    }
}
