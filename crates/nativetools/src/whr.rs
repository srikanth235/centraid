//! THE `where` MINI-LANGUAGE (SPEC §4.1).
//!
//! `field op value` joined by ` and `, with op in `= != < <= > >=`,
//! `contains "…"` (text fields), `in ("a", "b")`, `is empty`, `is set`, and a
//! linked-count condition `<kind> count op N`. No `or` except through `in`, no
//! `not` except through `!=` / `is empty`. `name` and `date` are not fields
//! here: names are filtered only by `name`, dates only by `when`.

use crate::meta::{self, FieldType, Kind};
use crate::world::{Row, Val, World, minor_of};

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

/// `error: tasks have no field "due_on". task fields: date, status, …`.
#[must_use]
pub fn no_field(kind: Kind, field: &str) -> String {
    format!(
        "error: {} have no field \"{field}\". {} fields: {}.",
        kind.plural(),
        kind.name(),
        field_list(kind)
    )
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
fn split_and(text: &str) -> Vec<String> {
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
            let rest: String = chars[index..].iter().take(5).collect();
            if rest.to_lowercase() == " and " {
                parts.push(current.trim().to_owned());
                current.clear();
                index += 5;
                continue;
            }
        }
        current.push(char);
        index += 1;
    }
    parts.push(current.trim().to_owned());
    parts
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

fn parse_cond(kind: Kind, part: &str) -> Result<Cond, String> {
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
                "error: {} are not linked to {}. {} links: {}.",
                kind.plural(),
                linked_kind.plural(),
                kind.name(),
                link_names(kind)
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
            let number = words.next().unwrap_or_default();
            let number = number.trim_start_matches(['$', '€', '£']);
            let parsed = number
                .parse::<f64>()
                .map_err(|_| format!("error: {} is a number; \"{value}\" is not.", field.name))?;
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
                (_, []) => None,
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
            let value = match word(value).to_lowercase().as_str() {
                "yes" | "true" => true,
                "no" | "false" => false,
                other => {
                    return Err(format!(
                        "error: {} is yes or no, not \"{other}\".",
                        field.name
                    ));
                }
            };
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
            let same = row.field(field) == Some(&Val::Enum(value));
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
            Some(Val::Enum(value)) => values
                .iter()
                .any(|want| want.to_lowercase().replace(' ', "_") == *value),
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

/// The per-kind grammar, in Lark, for constrained decoding (SPEC §9).
#[must_use]
pub fn lark() -> String {
    let mut out = String::from(
        "// The `where` mini-language, one start rule per kind (generated from the metadata table).\n\
         // Conditions join with \" and \"; no \"or\" except `in`; no \"not\" except != / is empty.\n\n",
    );
    for kind in Kind::ALL {
        let rule = kind.name().replace(' ', "_");
        let spec = kind.spec();
        out.push_str(&format!(
            "where_{rule}: cond_{rule} (\" and \" cond_{rule})*\n"
        ));
        let mut alternatives: Vec<String> = Vec::new();
        for field in spec.fields {
            let name = format!("\"{}\"", field.name);
            match field.ty {
                FieldType::Number | FieldType::Money => {
                    alternatives.push(format!("{name} \" \" CMP \" \" NUMBER (\" \" CURRENCY)?"));
                }
                FieldType::Text => {
                    alternatives.push(format!("{name} \" \" EQ \" \" STRING"));
                    alternatives.push(format!("{name} \" contains \" STRING"));
                    alternatives.push(format!("{name} \" in (\" STRING (\", \" STRING)* \")\""));
                }
                FieldType::Enum => {
                    let values: Vec<String> = field
                        .values
                        .iter()
                        .map(|(value, _)| format!("\"{value}\""))
                        .collect();
                    let set = format!("({})", values.join(" | "));
                    alternatives.push(format!("{name} \" \" EQ \" \" {set}"));
                    alternatives.push(format!(
                        "{name} \" in (\" \"\\\"\" {set} \"\\\"\" (\", \" \"\\\"\" {set} \"\\\"\")* \")\""
                    ));
                }
                FieldType::Bool => {
                    alternatives.push(format!("{name} \" \" EQ \" \" (\"yes\" | \"no\")"));
                }
                FieldType::Date => {}
            }
            if field.ty != FieldType::Bool {
                alternatives.push(format!("{name} (\" is empty\" | \" is set\")"));
            }
        }
        for link in spec.links {
            alternatives.push(format!("\"{} count \" CMP \" \" INT", link.kind.name()));
        }
        if alternatives.is_empty() {
            alternatives.push("\"\"".to_owned());
        }
        out.push_str(&format!(
            "cond_{rule}: {}\n\n",
            alternatives.join("\n    | ")
        ));
    }
    out.push_str(
        "CMP: \"=\" | \"!=\" | \"<\" | \"<=\" | \">\" | \">=\"\n\
         EQ: \"=\" | \"!=\"\n\
         NUMBER: /-?[0-9]+(\\.[0-9]+)?/\n\
         INT: /[0-9]+/\n\
         CURRENCY: /[A-Z]{3}/\n\
         STRING: /\"[^\"\\n]*\"/\n",
    );
    out
}
