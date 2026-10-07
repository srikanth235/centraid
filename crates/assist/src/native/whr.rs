//! THE `where` MINI-LANGUAGE (SPEC §4.1).
//!
//! `field op value` joined by ` and `, with op in `= != < <= > >=`,
//! `contains "…"` (text fields), `in ("a", "b")`, `is empty`, `is set`, and a
//! linked-count condition `<kind> count op N`. No `or` except through `in`, no
//! `not` except through `!=` / `is empty`. `name` and `date` are not fields
//! here: names are filtered only by `name`, dates only by `when`.
//!
//! THE STATUS CONVENTION (D-1044-7): `status = open` selects the active rows.
//! On a status that has an `in_progress` value (a task's) that is `open` and
//! `in_progress`; `status != open` leaves out both, and `status in (…)` reads
//! each member the same way. `in_progress`, `completed` and `cancelled` select
//! only themselves, and so does `open` on a status without `in_progress` (a
//! debt's). The rule is `selects`; `edit` and `create` write the value they
//! are given and never go through it.

use crate::native::meta::{self, FieldType, Kind};
use crate::native::world::{Row, Val, World, minor_of};

/// The status a `where` writes for the active rows.
const OPEN: &str = "open";
/// The status that is active beside `open` (a task that has been started).
const IN_PROGRESS: &str = "in_progress";

/// A comparison operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

impl Op {
    pub const ALL: [(&'static str, Self); 6] = [
        ("!=", Self::Ne),
        ("<=", Self::Le),
        (">=", Self::Ge),
        ("=", Self::Eq),
        ("<", Self::Lt),
        (">", Self::Gt),
    ];

    fn holds(self, ordering: std::cmp::Ordering) -> bool {
        use std::cmp::Ordering::{Equal, Greater, Less};
        match self {
            Self::Eq => ordering == Equal,
            Self::Ne => ordering != Equal,
            Self::Lt => ordering == Less,
            Self::Le => ordering != Greater,
            Self::Gt => ordering == Greater,
            Self::Ge => ordering != Less,
        }
    }
}

/// One condition.
#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Number {
        field: &'static str,
        op: Op,
        value: f64,
        currency: Option<String>,
    },
    Text {
        field: &'static str,
        op: Op,
        value: String,
    },
    Enum {
        field: &'static str,
        op: Op,
        value: &'static str,
    },
    Bool {
        field: &'static str,
        op: Op,
        value: bool,
    },
    Contains {
        field: &'static str,
        text: String,
    },
    In {
        field: &'static str,
        values: Vec<String>,
    },
    Presence {
        field: &'static str,
        set: bool,
    },
    LinkCount {
        kind: Kind,
        op: Op,
        count: i64,
    },
}

/// `error: tasks have no field "due_on". task fields: date, status, … For that use date.`
#[must_use]
pub fn no_field(kind: Kind, field: &str) -> String {
    format!(
        "error: {} have no field \"{field}\". {} fields: {}.{}",
        kind.plural(),
        kind.name(),
        field_list(kind),
        field_fix(kind, field, FieldUse::Where)
    )
}

/// Where a field was named: what the call to send instead says (`field_fix`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldUse {
    /// A condition, an order or a `field` of a computation: the date is `date`.
    Where,
    /// A line of an `edit`: a date changes with `reschedule`.
    Edit,
    /// An arg of a `create`.
    Create,
}

/// Words a person or a model uses for the free text of a row.
const FREE_TEXT_WORDS: [&str; 15] = [
    "notes",
    "note",
    "details",
    "detail",
    "text",
    "comment",
    "comments",
    "memo",
    "desc",
    "content",
    "summary",
    "info",
    "about",
    "remarks",
    "description",
];

/// Words for the date of a row (a task's due date, an event's start).
const DATE_WORDS: [&str; 11] = [
    "due",
    "due_date",
    "due_on",
    "deadline",
    "start",
    "starts",
    "when",
    "dtstart",
    "scheduled",
    "day",
    "last_contacted",
];

/// THE ONE FIELD RESOLVER (SPEC §3.3, nt12 R2): the field this kind uses for what a person or the
/// model called `word` (free text is `description` on a task or an event, `body` on a note; a due
/// date or a start is the `date`; an event's `duration` is a task's `effort`), or `None` when the
/// kind has no field of that meaning. A word that already is a field of the kind resolves to
/// itself, so a caller may ask first.
#[must_use]
pub fn resolve_field(kind: Kind, word: &str) -> Option<&'static str> {
    let word = word.trim().to_lowercase().replace([' ', '-'], "_");
    let spec = kind.spec();
    let own = |name: &str| -> Option<&'static str> {
        if name == "date" {
            return spec.date.is_some().then_some("date");
        }
        spec.field(name).map(|field| field.name)
    };
    if let Some(field) = own(&word) {
        return Some(field);
    }
    if FREE_TEXT_WORDS.contains(&word.as_str()) {
        ["description", "body", "notes"].into_iter().find_map(own)
    } else if DATE_WORDS.contains(&word.as_str()) {
        own("date")
    } else {
        match word.as_str() {
            "duration" | "length" | "minutes" | "mins" | "estimate" => {
                own("effort").or_else(|| own("duration"))
            }
            "effort" => own("duration"),
            "importance" | "urgency" | "prio" => own("priority"),
            "favorite" | "favourite" | "fav" | "star" => own("starred"),
            "sum" | "owed" | "money" | "value" | "price" | "cost" => own("amount"),
            "job" | "title" | "occupation" | "company" => own("role"),
            _ => None,
        }
    }
}

/// THE CALL TO SEND INSTEAD OF A FIELD THE KIND LACKS, when it is decidable (SPEC §5): the field
/// this kind uses for that meaning (free text is `description` on a task or an event, `body` on
/// a note; a due date or a start is the `date`; an event's `duration` is a task's `effort`), else
/// the kinds that do have a field of that name. A sentence with a leading space, or nothing.
#[must_use]
pub fn field_fix(kind: Kind, field: &str, using: FieldUse) -> String {
    let word = field.trim().to_lowercase().replace([' ', '-'], "_");
    let meant = resolve_field(kind, &word);
    if let Some(meant) = meant.filter(|meant| *meant != word) {
        return match (meant, using) {
            ("date", FieldUse::Edit) => {
                " A date changes with reschedule (to: <date expression>).".to_owned()
            }
            ("starred", FieldUse::Edit) => " Use star or unstar.".to_owned(),
            _ => format!(" For that use {meant}."),
        };
    }
    let others: Vec<&str> = Kind::ALL
        .iter()
        .filter(|other| **other != kind && other.spec().field(&word).is_some())
        .map(|other| other.plural())
        .take(3)
        .collect();
    if others.is_empty() {
        String::new()
    } else {
        format!(" {word} is a field of {}.", others.join(", "))
    }
}

/// THE CALL TO SEND INSTEAD OF A LINK THE KINDS LACK, when it is decidable: a group's money is
/// `op balance` on the group (debts are the person's, a group's money is its balance; only a
/// debt is asked of a group that way, so no other kind gets the sentence), and the photos of a person or of an album are the photos `linked_to` that row. A
/// sentence with a leading space, or nothing.
#[must_use]
pub fn link_fix(kind: Kind, target: Kind) -> String {
    match (kind, target) {
        (Kind::Debt, Kind::Group) => " A group's money is compute op balance, kind group, linked_to the person (none means you)."
            .to_owned(),
        (Kind::Person, Kind::Album) | (Kind::Album, Kind::Person) => {
            " The photos of a person or an album: find kind photo, linked_to that row.".to_owned()
        }
        // nt15 R1a: a task's or an event's notes are its description, not rows
        (Kind::Task | Kind::Event, Kind::Note) => format!(
            " {} notes are its description: where description is empty (or is set, or contains \"…\").",
            if kind == Kind::Task { "A task's" } else { "An event's" }
        ),
        (Kind::Note, Kind::Task | Kind::Event) => format!(
            " {} notes are its description, not linked rows: where description is set (or contains \"…\") on the {}.",
            if target == Kind::Task { "A task's" } else { "An event's" },
            target.name()
        ),
        _ => String::new(),
    }
}

/// A condition on how many NOTES a task or an event is linked to (`note count = 0`), as the
/// `description` condition that says the same (nt15 R1a: their notes are their description):
/// `(clause, "empty" or "set")`. Only the counts that mean one or the other, `= 0`, `<= 0`, `< 1`
/// (empty) and `> 0`, `>= 1`, `!= 0` (set); any other count has no such reading.
#[must_use]
pub(crate) fn notes_as_description(kind: Kind, part: &str) -> Option<(String, &'static str)> {
    if !matches!(kind, Kind::Task | Kind::Event) {
        return None;
    }
    let lower = part.trim().to_lowercase();
    let (word, rest) = lower.split_once(" count ")?;
    if !matches!(word.trim(), "note" | "notes") {
        return None;
    }
    let (op, value) = split_op(rest)?;
    let count = value.trim().parse::<i64>().ok()?;
    let empty = match (op, count) {
        (Op::Eq | Op::Le, 0) | (Op::Lt, 1) => true,
        (Op::Ne | Op::Gt, 0) | (Op::Ge, 1) => false,
        _ => return None,
    };
    let state = if empty { "empty" } else { "set" };
    Some((format!("description is {state}"), state))
}

/// The fields a kind has, as the error lists them.
#[must_use]
pub fn field_list(kind: Kind) -> String {
    let spec = kind.spec();
    let mut names: Vec<String> = Vec::new();
    if spec.date.is_some() {
        names.push("date".to_owned());
    }
    names.extend(spec.fields.iter().map(|field| field.name.to_owned()));
    if names.is_empty() {
        "none (only name)".to_owned()
    } else {
        names.join(", ")
    }
}

/// Split on ` and ` outside quotes.
pub(crate) fn split_and(text: &str) -> Vec<String> {
    split_on(text, " and ")
}

/// Split on a separator (lower case, spaces included) outside quotes.
fn split_on(text: &str, separator: &str) -> Vec<String> {
    let width = separator.chars().count();
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        if char == '"' {
            quoted = !quoted;
        }
        if !quoted {
            let rest: String = chars[index..].iter().take(width).collect();
            if rest.to_lowercase() == separator {
                parts.push(current.trim().to_owned());
                current.clear();
                index += width;
                continue;
            }
        }
        current.push(char);
        index += 1;
    }
    parts.push(current.trim().to_owned());
    parts
}

const HOUR_WORDS: [&str; 5] = ["hour", "hours", "hr", "hrs", "h"];
const WEEK_WORDS: [&str; 5] = ["week", "weeks", "wk", "wks", "w"];

/// A number written in a unit the field does not use, when the conversion is fixed (nt12 R3):
/// hours for a field of minutes, weeks for a field of days. `("120", "120 minutes")` for `2
/// hours`; `None` when the text is no such number (a plain number, the field's own unit, or a
/// word with no fixed conversion, which `number_arg` and the `where` parser refuse).
#[must_use]
pub fn convert_unit(unit: Option<&str>, text: &str) -> Option<(String, String)> {
    let mut words = text.split_whitespace();
    let number: f64 = words.next()?.parse().ok()?;
    let word = words.next()?.to_lowercase();
    if words.next().is_some() {
        return None;
    }
    let (factor, label) = match unit? {
        "min" if HOUR_WORDS.contains(&word.as_str()) => (60.0, "minutes"),
        "days" if WEEK_WORDS.contains(&word.as_str()) => (7.0, "days"),
        _ => return None,
    };
    let converted = (number * factor).round() as i64;
    Some((converted.to_string(), format!("{converted} {label}")))
}

/// The unit a field name carries in any kind (`effort` minutes, `cadence` days).
#[must_use]
pub fn unit_of_field(name: &str) -> Option<&'static str> {
    Kind::ALL
        .iter()
        .find_map(|kind| kind.spec().field(name).and_then(|field| field.unit))
}

/// A `where` read leniently (nt12 R3): one field compared with `=` to several values joined by
/// `or` is `field in (...)`, and a number in a unit with a fixed conversion is the field's own
/// unit (`effort > 1 hour` is `effort > 60`). The rewritten text and one note each; text it
/// cannot read is left for `parse` to refuse.
#[must_use]
pub fn lenient_where(kind: Kind, text: &str) -> (String, Vec<String>) {
    let mut notes = Vec::new();
    let mut text = text.trim().to_owned();
    if split_and(&text).len() == 1 {
        let parts = split_on(&text, " or ");
        if parts.len() > 1
            && let Some(rewritten) = in_of_equals(&parts)
        {
            notes.push(format!("note: read {text} as {rewritten}"));
            text = rewritten;
        }
    }
    let spec = kind.spec();
    let clauses: Vec<String> = split_and(&text)
        .into_iter()
        .map(|clause| {
            let field_name: String = clause
                .chars()
                .take_while(|char| char.is_alphanumeric() || *char == '_')
                .collect();
            let rest = clause[field_name.len()..].trim();
            let op: String = rest.chars().take_while(|c| "=!<>".contains(*c)).collect();
            let value = rest[op.len()..].trim();
            let converted = spec
                .field(&field_name.to_lowercase())
                .filter(|field| field.ty == FieldType::Number && !op.is_empty())
                .and_then(|field| convert_unit(field.unit, value));
            match converted {
                Some((number, shown)) => {
                    notes.push(format!("note: read {value} as {shown}"));
                    format!("{field_name} {op} {number}")
                }
                None => clause,
            }
        })
        .collect();
    (clauses.join(" and "), notes)
}

// ---------------------------------------------------------------------------------------------
// nt13 R1: an enumerated value the model wrote loosely

/// A value spelled without case, spaces, underscores, hyphens or dots.
fn squash(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// THE VALUE A LITERAL MEANS for a field with a closed set of values (nt13 R1), when exactly one
/// value fits; the tiers, the first that holds any value decides: the same ignoring case, space,
/// underscore and hyphen (`Bank-Account`); a whole word of the value or the start of it, three
/// letters or more (`bank` for `bank_account`, `complete` for `completed`); one edit away
/// (Damerau, a literal of four letters or more: `canceled`, `in progres`). Several values on the
/// deciding tier, or none, resolve to nothing: the error names them all.
#[must_use]
pub fn resolve_value(kind: Kind, field: &str, literal: &str) -> Option<&'static str> {
    let spec = kind.spec().field(field)?;
    if spec.values.is_empty() {
        return None;
    }
    let said = squash(literal);
    if said.is_empty() {
        return None;
    }
    let names: Vec<&'static str> = spec.values.iter().map(|(name, _)| *name).collect();
    let tiers: [&dyn Fn(&str) -> bool; 3] = [
        &|name| squash(name) == said,
        &|name| {
            said.chars().count() >= 3
                && (squash(name).starts_with(&said)
                    || name.split('_').any(|part| squash(part) == said))
        },
        &|name| crate::native::resolve::one_edit(&said, &squash(name)),
    ];
    for tier in tiers {
        let found: Vec<&'static str> = names.iter().copied().filter(|name| tier(name)).collect();
        match found.as_slice() {
            [] => {}
            [only] => return Some(only),
            _ => return None,
        }
    }
    None
}

/// The currency words a person says, and the codes each may be (nt13 R1): the vault's own codes
/// decide which one is meant.
const CURRENCY_NAMES: [(&str, &[&str]); 29] = [
    ("dollar", &["USD", "CAD", "AUD", "NZD", "SGD", "HKD"]),
    ("buck", &["USD"]),
    ("euro", &["EUR"]),
    ("pound", &["GBP"]),
    ("sterling", &["GBP"]),
    ("quid", &["GBP"]),
    (
        "peso",
        &["MXN", "COP", "ARS", "CLP", "PHP", "UYU", "DOP", "CUP"],
    ),
    ("rupee", &["INR", "PKR", "LKR", "NPR"]),
    ("yen", &["JPY"]),
    ("yuan", &["CNY"]),
    ("renminbi", &["CNY"]),
    ("franc", &["CHF", "XOF", "XAF"]),
    ("krona", &["SEK", "ISK"]),
    ("krone", &["NOK", "DKK"]),
    ("won", &["KRW"]),
    ("baht", &["THB"]),
    ("real", &["BRL"]),
    ("rand", &["ZAR"]),
    ("dirham", &["AED", "MAD"]),
    ("riyal", &["SAR", "QAR"]),
    ("shekel", &["ILS"]),
    ("lira", &["TRY"]),
    ("ruble", &["RUB"]),
    ("rouble", &["RUB"]),
    ("zloty", &["PLN"]),
    ("forint", &["HUF"]),
    ("dong", &["VND"]),
    ("ringgit", &["MYR"]),
    ("rupiah", &["IDR"]),
];

/// A currency word without its plural: `pesos`, `euros`, `reais`, `kronor`.
fn currency_name(word: &str) -> Option<&'static [&'static str]> {
    let word = word.trim().to_lowercase();
    let singular = match word.as_str() {
        "reais" => "real",
        "kronor" | "kronur" | "kronas" => "krona",
        "kroner" | "kronen" => "krone",
        other => other
            .strip_suffix("es")
            .filter(|rest| CURRENCY_NAMES.iter().any(|(name, _)| name == rest))
            .or_else(|| other.strip_suffix('s'))
            .unwrap_or(other),
    };
    CURRENCY_NAMES
        .iter()
        .find(|(name, _)| *name == singular)
        .map(|(_, codes)| *codes)
}

/// THE CURRENCY CODE A LITERAL MEANS (nt13 R1), among the `held` codes of the vault, when exactly
/// one fits: a name or its plural (`pesos`, `euro`: the held codes among the ones that name
/// can be), or a near code (`MX` the start of `MXN`, `MXP` one letter off it). A literal that is
/// a held code is already a value, and a code of the names above that is not held is a currency
/// the vault does not have: neither resolves.
#[must_use]
pub fn resolve_currency(literal: &str, held: &[String]) -> Option<String> {
    let said = literal.trim().trim_matches('"').trim();
    if said.is_empty() || held.iter().any(|code| code.eq_ignore_ascii_case(said)) {
        return None;
    }
    let upper = said.to_uppercase();
    let one = |found: Vec<&String>| match found.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    };
    if let Some(codes) = currency_name(said) {
        return one(held
            .iter()
            .filter(|code| codes.contains(&code.as_str()))
            .collect());
    }
    let known = CURRENCY_NAMES
        .iter()
        .any(|(_, codes)| codes.contains(&upper.as_str()));
    if known
        || !said.chars().all(|c| c.is_ascii_alphabetic())
        || !(2..=4).contains(&said.chars().count())
    {
        return None;
    }
    let lower = said.to_lowercase();
    one(held
        .iter()
        .filter(|code| {
            let code = code.to_lowercase();
            code.starts_with(&lower) || crate::native::resolve::within_one(&lower, &code)
        })
        .collect())
}

/// A `where` with its enumerated values and currencies read (nt13 R1): the value of an enum
/// field that is none of its values, the code of a group's `currency` and the code word of a
/// money amount, each resolved by `resolve_value` and `resolve_currency`, one note each
/// (`note: read bank as bank_account`). Anything that resolves to nothing stays for `parse` to
/// refuse, naming the values.
#[must_use]
pub fn resolve_where(kind: Kind, text: &str, held: &[String]) -> (String, Vec<String>) {
    let mut notes = Vec::new();
    let spec = kind.spec();
    let mut changed = false;
    let clauses: Vec<String> = split_and(text.trim())
        .into_iter()
        .map(|clause| {
            let field_name: String = clause
                .chars()
                .take_while(|char| char.is_alphanumeric() || *char == '_')
                .collect();
            let Some(field) = spec.field(&field_name.to_lowercase()) else {
                return clause;
            };
            let rest = clause[field_name.len()..].trim();
            let mut read = |literal: &str, resolved: Option<String>| -> String {
                match resolved {
                    Some(value) => {
                        notes.push(format!("note: read {literal} as {value}"));
                        changed = true;
                        value
                    }
                    None => literal.to_owned(),
                }
            };
            let is_enum = field.ty == FieldType::Enum;
            let is_code = field.ty == FieldType::Text && field.name == "currency";
            if is_enum || is_code {
                let value_of = |literal: &str| -> Option<String> {
                    if is_enum {
                        enum_value(kind, field.name, literal)
                            .is_err()
                            .then(|| resolve_value(kind, field.name, literal).map(str::to_owned))
                            .flatten()
                    } else {
                        resolve_currency(literal, held)
                    }
                };
                if let Some(list) = rest
                    .strip_prefix("in ")
                    .or_else(|| rest.strip_prefix("in("))
                    .map(str::trim)
                    && let Some(inner) = list
                        .trim_start()
                        .strip_prefix('(')
                        .and_then(|list| list.strip_suffix(')'))
                {
                    let values: Vec<String> = inner
                        .split(',')
                        .map(word)
                        .filter(|value| !value.is_empty())
                        .collect();
                    let read_all: Vec<String> = values
                        .iter()
                        .map(|literal| read(literal, value_of(literal)))
                        .collect();
                    if read_all != values {
                        let quoted: Vec<String> = read_all
                            .iter()
                            .map(|value| format!("\"{value}\""))
                            .collect();
                        return format!("{field_name} in ({})", quoted.join(", "));
                    }
                    return clause;
                }
                let op: String = rest.chars().take_while(|c| "=!".contains(*c)).collect();
                if op == "=" || op == "!=" {
                    let literal = word(&rest[op.len()..]);
                    let value = read(&literal, value_of(&literal));
                    if value != literal {
                        return format!("{field_name} {op} {value}");
                    }
                }
                return clause;
            }
            if field.ty == FieldType::Money {
                let op: String = rest.chars().take_while(|c| "=!<>".contains(*c)).collect();
                let value = rest[op.len()..].trim();
                let mut words = value.split_whitespace();
                if !op.is_empty()
                    && let (Some(number), Some(code), None) =
                        (words.next(), words.next(), words.next())
                    && let Some(resolved) = resolve_currency(code, held)
                {
                    let code = read(code, Some(resolved));
                    return format!("{field_name} {op} {number} {code}");
                }
            }
            clause
        })
        .collect();
    if changed {
        (clauses.join(" and "), notes)
    } else {
        (text.trim().to_owned(), Vec::new())
    }
}

/// An `edit` or `create` arg line with its enumerated value or currency code read (nt13 R1):
/// the new value text and the note, or nothing when the arg is no such field or already a value.
#[must_use]
pub fn resolve_arg(kind: Kind, key: &str, raw: &str, held: &[String]) -> Option<(String, String)> {
    let field = kind.spec().field(key)?;
    let literal = word(raw);
    let value = match field.ty {
        FieldType::Enum if enum_value(kind, field.name, &literal).is_err() => {
            resolve_value(kind, field.name, &literal).map(str::to_owned)
        }
        FieldType::Text if field.name == "currency" => resolve_currency(&literal, held),
        _ => None,
    }?;
    let note = format!("note: read {literal} as {value}");
    Some((value, note))
}

/// `a = x or a = y` as `a in ("x", "y")`: every part is an equality on the one field.
fn in_of_equals(parts: &[String]) -> Option<String> {
    let mut field: Option<String> = None;
    let mut values: Vec<String> = Vec::new();
    for part in parts {
        let name: String = part
            .chars()
            .take_while(|char| char.is_alphanumeric() || *char == '_')
            .collect();
        let value = part[name.len()..].trim().strip_prefix('=')?;
        if value.starts_with('=') || name.is_empty() || name.eq_ignore_ascii_case("name") {
            return None;
        }
        match &field {
            Some(have) if !have.eq_ignore_ascii_case(&name) => return None,
            Some(_) => {}
            None => field = Some(name),
        }
        let value = word(value);
        if value.is_empty() {
            return None;
        }
        values.push(format!("\"{value}\""));
    }
    Some(format!("{} in ({})", field?, values.join(", ")))
}

fn unquote(text: &str) -> Option<String> {
    let text = text.trim();
    let inner = text.strip_prefix('"')?.strip_suffix('"')?;
    Some(inner.to_owned())
}

fn word(text: &str) -> String {
    unquote(text).unwrap_or_else(|| text.trim().to_owned())
}

/// Whether `word` spells a number field's own unit (`min`: "min", "mins",
/// "minute", "minutes"; `days`: "day", "days").
fn unit_word(unit: Option<&str>, word: &str) -> bool {
    let word = word.to_lowercase();
    match unit {
        Some("min") => matches!(word.as_str(), "min" | "mins" | "minute" | "minutes"),
        Some("days") => matches!(word.as_str(), "day" | "days"),
        _ => false,
    }
}

/// Parse a number argument of an `act` (`effort: 90`, `effort: 90 minutes`,
/// `cadence: 14 days`). A trailing word must be the field's own unit; any
/// other word ("1.5 hours") is refused with the same text `where` uses, since
/// silently taking the number would store a different quantity than asked.
pub fn number_arg(field: &meta::Field, text: &str) -> Result<i64, String> {
    let mut words = text.split_whitespace();
    let value = words.next().unwrap_or_default();
    let rest: Vec<&str> = words.collect();
    let shape = match (field.ty, field.unit) {
        (_, Some("min")) => "a number of minutes (60, not 1 hour)",
        (_, Some("days")) => "a number of days (14, not 2 weeks)",
        _ => "a number",
    };
    let refuse = || {
        format!(
            "error: {} is {shape}; \"{}\" is not.",
            field.name,
            text.trim()
        )
    };
    let parsed = value.parse::<f64>().map_err(|_| refuse())?;
    match rest.as_slice() {
        [] => {}
        [word] if unit_word(field.unit, word) => {}
        _ => return Err(refuse()),
    }
    Ok(parsed.round() as i64)
}

/// The currency symbols an amount may start with, and the ISO codes each names (nt12 B5). A
/// symbol names a currency: `€` is the euro, `$` is any of the dollars.
const SYMBOLS: [(char, &[&str]); 4] = [
    ('$', &["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"]),
    ('\u{20ac}', &["EUR"]),
    ('\u{a3}', &["GBP"]),
    ('\u{a5}', &["JPY", "CNY"]),
];

/// The currency symbol an amount starts with.
fn symbol_of(text: &str) -> Option<char> {
    let first = text.trim().chars().next()?;
    SYMBOLS
        .iter()
        .any(|(symbol, _)| *symbol == first)
        .then_some(first)
}

fn is_symbol(text: &str) -> bool {
    let mut chars = text.chars();
    matches!((chars.next(), chars.next()), (Some(symbol), None) if SYMBOLS.iter().any(|(known, _)| *known == symbol))
}

/// `Err` when the amount `text` starts with a symbol that names another currency than the
/// `currency` it is written in (a `€` amount in a dollar group): the symbol says what the person
/// means, and dropping it would store another sum.
pub fn symbol_conflict(text: &str, currency: &str) -> Result<(), String> {
    let Some(symbol) = symbol_of(text) else {
        return Ok(());
    };
    let family = SYMBOLS
        .iter()
        .find(|(known, _)| *known == symbol)
        .map_or(&[][..], |(_, codes)| *codes);
    if family.contains(&currency) {
        return Ok(());
    }
    Err(format!(
        "error: amounts are in {currency} here; \"{}\" names {}. Write the number in {currency}.",
        text.trim(),
        family.join(" or ")
    ))
}

/// Settle the currency symbols of a parsed `where` against the currencies the vault holds
/// (`codes`): a symbol is the one code of its family the vault has; with none it is the family's
/// first code when the family has one meaning (`€`, `£`) or its common one (`$` is USD, `¥` is
/// JPY); with several (`$` in a vault of USD and CAD) it is an error naming them.
pub(crate) fn settle_currencies(conds: &mut [Cond], codes: &[String]) -> Result<(), String> {
    for cond in conds {
        let Cond::Number {
            currency: Some(symbol),
            ..
        } = cond
        else {
            continue;
        };
        if !is_symbol(symbol) {
            continue;
        }
        let Some(symbol_char) = symbol.chars().next() else {
            continue;
        };
        let family = SYMBOLS
            .iter()
            .find(|(known, _)| *known == symbol_char)
            .map_or(&[][..], |(_, codes)| *codes);
        let held: Vec<&str> = family
            .iter()
            .copied()
            .filter(|code| codes.iter().any(|have| have == code))
            .collect();
        *symbol = match held.as_slice() {
            [] => family.first().copied().unwrap_or("USD").to_owned(),
            [only] => (*only).to_owned(),
            several => {
                return Err(format!(
                    "error: {symbol_char} names more than one currency here ({}); write the amount with its code (50 {}).",
                    several.join(", "),
                    several[0]
                ));
            }
        };
    }
    Ok(())
}

/// An amount as a person writes it, in currency units: `12`, `12.50`,
/// `1,500`, `$2k`, `500k`, `2.5K`, `1.2m`. A trailing `k` is a thousand and
/// `m` a million; a currency symbol in front is dropped. `None` for anything
/// else ("fifty", "500kk", "1e3"). Only money takes these suffixes: on a
/// number of minutes or days "30m" stays an error.
#[must_use]
pub fn parse_amount(text: &str) -> Option<f64> {
    let text = text
        .trim()
        .trim_start_matches(['$', '\u{20ac}', '\u{a3}', '\u{a5}']);
    let (digits, scale) = match text.chars().last()? {
        'k' | 'K' => (&text[..text.len() - 1], 1_000.0),
        'm' | 'M' => (&text[..text.len() - 1], 1_000_000.0),
        _ => (text, 1.0),
    };
    let grouped = digits.split_once('.').map_or(digits, |(whole, _)| whole);
    let digits = if grouped.contains(',') {
        let mut groups = grouped.split(',');
        let first = groups.next().unwrap_or_default();
        let ok = (1..=3).contains(&first.len()) && groups.all(|group| group.len() == 3);
        if !ok {
            return None;
        }
        digits.replace(',', "")
    } else {
        digits.to_owned()
    };
    let mut dots = 0;
    let plain = !digits.is_empty()
        && digits.chars().all(|c| {
            dots += usize::from(c == '.');
            c.is_ascii_digit() || c == '.'
        })
        && dots <= 1
        && digits.chars().any(|c| c.is_ascii_digit());
    plain
        .then(|| digits.parse::<f64>().ok())
        .flatten()
        .map(|n| n * scale)
}

/// THE ONE BOOL PARSER (SPEC §3.3, nt12 B2): `yes`, `true`, `1`, `on` and `no`, `false`, `0`,
/// `off`, in any case; anything else is `None`, never a silent no.
#[must_use]
pub fn parse_bool(text: &str) -> Option<bool> {
    match text.trim().to_lowercase().as_str() {
        "yes" | "true" | "1" | "on" => Some(true),
        "no" | "false" | "0" | "off" => Some(false),
        _ => None,
    }
}

/// The error for a value `parse_bool` cannot read: it names the values it does.
#[must_use]
pub fn bool_error(what: &str, got: &str) -> String {
    format!("error: {what} is one of yes, true, 1, on, no, false, 0, off, not \"{got}\".")
}

/// Parse a `where` string for one kind. Errors are the observation text.
pub fn parse(kind: Kind, text: &str) -> Result<Vec<Cond>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    if contains_word(text, "or") && !text.contains('"') {
        return Err(
            "error: where has no \"or\"; use field in (\"a\", \"b\"). Conditions join with \" and \"."
                .to_owned(),
        );
    }
    split_and(text)
        .iter()
        .map(|part| parse_cond(kind, part))
        .collect()
}

fn contains_word(text: &str, word: &str) -> bool {
    text.split_whitespace()
        .any(|token| token.eq_ignore_ascii_case(word))
}

/// One condition of a `where`; the invalid-repeat fail-soft drops the ones that fail
/// (`Session::failsoft_read`).
pub(crate) fn parse_cond(kind: Kind, part: &str) -> Result<Cond, String> {
    let spec = kind.spec();
    let lower = part.to_lowercase();
    // `<kind> count op N`
    if let Some(at) = lower.find(" count ") {
        let linked = part[..at].trim();
        let rest = part[at + 7..].trim();
        let linked_kind = Kind::parse(linked).ok_or_else(|| {
            format!(
                "error: \"{linked}\" is not a kind. kinds: {}.",
                kind_names()
            )
        })?;
        if spec.link_to(linked_kind).is_none() {
            return Err(format!(
                "error: {} are not linked to {}. {} links: {}.{}",
                kind.plural(),
                linked_kind.plural(),
                kind.name(),
                link_names(kind),
                link_fix(kind, linked_kind)
            ));
        }
        let (op, value) = split_op(rest).ok_or_else(|| {
            format!(
                "error: could not read \"{part}\"; a linked count reads \"{} count >= 2\".",
                linked_kind.name()
            )
        })?;
        let count = value
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("error: \"{value}\" is not a whole number in \"{part}\"."))?;
        return Ok(Cond::LinkCount {
            kind: linked_kind,
            op,
            count,
        });
    }
    let field_name: String = part
        .chars()
        .take_while(|char| char.is_alphanumeric() || *char == '_')
        .collect();
    if field_name.is_empty() {
        return Err(format!("error: could not read the condition \"{part}\"."));
    }
    let rest = part[field_name.len()..].trim();
    let field_lower = field_name.to_lowercase();
    if field_lower == "name" {
        return Err("error: where has no name field; filter names with name=\"…\" (whole words), or search.".to_owned());
    }
    if field_lower == "date" {
        return Err(format!(
            "error: where has no date field; filter the {} date with when=<date expression>.",
            kind.name()
        ));
    }
    let field = spec
        .field(&field_lower)
        .ok_or_else(|| no_field(kind, &field_name))?;
    let rest_lower = rest.to_lowercase();
    if rest_lower == "is empty" || rest_lower == "is set" {
        return Ok(Cond::Presence {
            field: field.name,
            set: rest_lower == "is set",
        });
    }
    if field.ty == FieldType::Date {
        return Err(format!(
            "error: {} is a date; where takes only \"{0} is set\" or \"{0} is empty\". Filter by the {} date with when.",
            field.name,
            kind.name()
        ));
    }
    if rest
        .get(..8)
        .is_some_and(|head| head.eq_ignore_ascii_case("contains"))
    {
        if field.ty != FieldType::Text {
            return Err(format!(
                "error: contains works on text fields; {} is not text.",
                field.name
            ));
        }
        let text = unquote(&rest[8..]).ok_or_else(|| {
            format!(
                "error: contains takes a quoted text: {} contains \"…\".",
                field.name
            )
        })?;
        return Ok(Cond::Contains {
            field: field.name,
            text,
        });
    }
    if rest_lower.starts_with("in ") || rest_lower.starts_with("in(") {
        let list = rest[2..].trim();
        let inner = list
            .strip_prefix('(')
            .and_then(|list| list.strip_suffix(')'))
            .ok_or_else(|| format!("error: in takes a list: {} in (\"a\", \"b\").", field.name))?;
        let values: Vec<String> = inner
            .split(',')
            .map(word)
            .filter(|v| !v.is_empty())
            .collect();
        if field.ty == FieldType::Enum {
            for value in &values {
                enum_value(kind, field.name, value)?;
            }
        }
        return Ok(Cond::In {
            field: field.name,
            values,
        });
    }
    let (op, value) = split_op(rest).ok_or_else(|| {
        format!(
            "error: could not read \"{part}\". Operators: = != < <= > >=, contains \"…\", in (\"a\", \"b\"), is empty, is set."
        )
    })?;
    match field.ty {
        FieldType::Number | FieldType::Money => {
            let mut words = value.split_whitespace();
            let written = words.next().unwrap_or_default();
            let number = written.trim_start_matches(['$', '\u{20ac}', '\u{a3}', '\u{a5}']);
            let symbol = (field.ty == FieldType::Money)
                .then(|| symbol_of(written))
                .flatten();
            let parsed = if field.ty == FieldType::Money {
                parse_amount(number)
            } else {
                number.parse::<f64>().ok()
            }
            .ok_or_else(|| format!("error: {} is a number; \"{value}\" is not.", field.name))?;
            // THE WORD AFTER THE NUMBER is a money field's currency code or a
            // number field's own unit spelled out ("60 min"); anything else
            // ("1 hour") is refused, never dropped, since dropping it would
            // compare against a different quantity than the one asked for.
            let rest: Vec<&str> = words.collect();
            let refuse = || {
                let shape = match (field.ty, field.unit) {
                    (FieldType::Money, _) => {
                        "an amount, optionally with a currency code (50 EUR)".to_owned()
                    }
                    (_, Some("min")) => "a number of minutes (60, not 1 hour)".to_owned(),
                    (_, Some("days")) => "a number of days (14, not 2 weeks)".to_owned(),
                    _ => "a number".to_owned(),
                };
                format!("error: {} is {shape}; \"{value}\" is not.", field.name)
            };
            let currency = match (field.ty, rest.as_slice()) {
                (_, []) => symbol.map(String::from),
                (FieldType::Money, [code])
                    if code.len() == 3 && code.chars().all(|c| c.is_ascii_alphabetic()) =>
                {
                    Some(code.to_uppercase())
                }
                (FieldType::Number, [word]) if unit_word(field.unit, word) => None,
                _ => return Err(refuse()),
            };
            Ok(Cond::Number {
                field: field.name,
                op,
                value: parsed,
                currency,
            })
        }
        FieldType::Text => {
            if !matches!(op, Op::Eq | Op::Ne) {
                return Err(format!(
                    "error: {} is text; compare it with = or != or contains \"…\".",
                    field.name
                ));
            }
            Ok(Cond::Text {
                field: field.name,
                op,
                value: word(value),
            })
        }
        FieldType::Enum => {
            if !matches!(op, Op::Eq | Op::Ne) {
                return Err(format!("error: {} takes = or != or in (…).", field.name));
            }
            Ok(Cond::Enum {
                field: field.name,
                op,
                value: enum_value(kind, field.name, &word(value))?,
            })
        }
        FieldType::Bool => {
            if !matches!(op, Op::Eq | Op::Ne) {
                return Err(format!(
                    "error: {} is yes or no; compare with =.",
                    field.name
                ));
            }
            let value =
                parse_bool(&word(value)).ok_or_else(|| bool_error(field.name, &word(value)))?;
            Ok(Cond::Bool {
                field: field.name,
                op,
                value,
            })
        }
        FieldType::Date => unreachable!("handled above"),
    }
}

fn split_op(text: &str) -> Option<(Op, &str)> {
    let text = text.trim();
    for (spelling, op) in Op::ALL {
        if let Some(rest) = text.strip_prefix(spelling) {
            return Some((op, rest.trim()));
        }
    }
    None
}

/// Resolve an enum's model value, naming every valid one on failure.
pub fn enum_value(kind: Kind, field: &str, value: &str) -> Result<&'static str, String> {
    let spec = kind
        .spec()
        .field(field)
        .ok_or_else(|| no_field(kind, field))?;
    let wanted = value.trim().to_lowercase().replace(' ', "_");
    spec.values
        .iter()
        .find(|(name, _)| *name == wanted)
        .map(|(name, _)| *name)
        .ok_or_else(|| {
            let names: Vec<&str> = spec.values.iter().map(|(name, _)| *name).collect();
            format!(
                "error: {field} has no value \"{value}\". {} {field} values: {}.",
                kind.name(),
                names.join(", ")
            )
        })
}

#[must_use]
pub fn kind_names() -> String {
    Kind::ALL
        .iter()
        .map(|kind| kind.name())
        .collect::<Vec<_>>()
        .join(", ")
}

#[must_use]
pub fn link_names(kind: Kind) -> String {
    let links: Vec<&str> = kind
        .spec()
        .links
        .iter()
        .map(|link| link.kind.name())
        .collect();
    if links.is_empty() {
        "none".to_owned()
    } else {
        links.join(", ")
    }
}

/// Whether a row satisfies every condition.
#[must_use]
pub fn matches(world: &World, row: &Row, conds: &[Cond]) -> bool {
    conds.iter().all(|cond| holds(world, row, cond))
}

/// Whether the enum value `actual` of a row is one the `where` value `want`
/// selects (`want` is a model value: lower case, spaces as underscores).
///
/// `open` is the one value that selects more than itself: on a status that has
/// an `in_progress` value a started task is still to do, so `open` selects
/// both (the module comment has the rule).
fn selects(kind: Kind, field: &str, want: &str, actual: &str) -> bool {
    actual == want
        || (field == "status"
            && want == OPEN
            && actual == IN_PROGRESS
            && kind
                .spec()
                .field(field)
                .is_some_and(|status| status.values.iter().any(|(name, _)| *name == IN_PROGRESS)))
}

fn holds(world: &World, row: &Row, cond: &Cond) -> bool {
    match cond {
        Cond::Number {
            field,
            op,
            value,
            currency,
        } => match row.field(field) {
            Some(Val::Num(number)) => op.holds(number.cmp(&(value.round() as i64))),
            Some(Val::Money(minor, row_currency)) => {
                let wanted = currency.clone().unwrap_or_else(|| world.currency.clone());
                if *row_currency != wanted {
                    return false;
                }
                op.holds(minor.cmp(&minor_of(*value, row_currency)))
            }
            _ => false,
        },
        Cond::Text { field, op, value } => {
            let same = match row.field(field) {
                Some(Val::Text(text)) => text.eq_ignore_ascii_case(value),
                _ => value.is_empty(),
            };
            if *op == Op::Eq { same } else { !same }
        }
        Cond::Enum { field, op, value } => {
            let same = matches!(
                row.field(field),
                Some(Val::Enum(actual)) if selects(row.kind, field, value, actual)
            );
            if *op == Op::Eq { same } else { !same }
        }
        Cond::Bool { field, op, value } => {
            let actual = row.field(field) == Some(&Val::Bool(true));
            let same = actual == *value;
            if *op == Op::Eq { same } else { !same }
        }
        Cond::Contains { field, text } => match row.field(field) {
            Some(Val::Text(value)) => value.to_lowercase().contains(&text.to_lowercase()),
            _ => false,
        },
        Cond::In { field, values } => match row.field(field) {
            Some(Val::Text(value)) => values.iter().any(|want| want.eq_ignore_ascii_case(value)),
            Some(Val::Enum(actual)) => values.iter().any(|want| {
                selects(
                    row.kind,
                    field,
                    &want.to_lowercase().replace(' ', "_"),
                    actual,
                )
            }),
            Some(Val::Num(value)) => values.iter().any(|want| want.parse() == Ok(*value)),
            _ => false,
        },
        Cond::Presence { field, set } => {
            let present = match row.field(field) {
                None | Some(Val::Bool(false)) => false,
                Some(Val::Text(text)) => !text.is_empty(),
                Some(_) => true,
            };
            present == *set
        }
        Cond::LinkCount { kind, op, count } => {
            let key = row.key();
            let linked = world.neighbours(&key).get(kind).map_or(0, |keys| {
                keys.iter()
                    .filter(|other| world.row(other).is_some_and(|row| !row.trashed))
                    .count()
            });
            op.holds(i64::try_from(linked).unwrap_or(i64::MAX).cmp(count))
        }
    }
}
