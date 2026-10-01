//! How rows, results and values read in an observation (SPEC §5).

use jiff::civil::Date;

use crate::dates::{Stamp, relative_label};
use crate::meta::{FieldType, Kind};
use crate::world::{Row, Val, World};

/// `Fri 2026-06-19 09:00 (this Friday)`.
#[must_use]
pub fn when(stamp: Stamp, today: Date) -> String {
    match relative_label(stamp.date, today) {
        Some(label) => format!("{} ({label})", stamp.show()),
        None => stamp.show(),
    }
}

/// The facts of a row after its name: date, then fields in card order.
#[must_use]
pub fn facts(row: &Row, today: Date) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(stamp) = row.date {
        out.push(when(stamp, today));
    }
    let spec = row.kind.spec();
    for field in spec.fields {
        let Some(value) = row.field(field.name) else {
            continue;
        };
        match (field.ty, value) {
            (FieldType::Bool, Val::Bool(true)) => out.push(field.name.to_owned()),
            (FieldType::Bool, _) => {}
            (FieldType::Text, Val::Text(text)) => {
                let short: String = text.chars().take(60).collect();
                let ellipsis = if text.chars().count() > 60 { "…" } else { "" };
                out.push(format!("{} \"{short}{ellipsis}\"", field.name));
            }
            _ => out.push(format!("{} {}", field.name, value.show(Some(field)))),
        }
    }
    if row.trashed {
        out.push("trashed".to_owned());
    }
    out
}

/// `#12 [1] task "Book the cabin" · Fri 2026-06-19 09:00 (this Friday) · status open`.
#[must_use]
pub fn row_line(number: usize, position: Option<usize>, row: &Row, today: Date) -> String {
    let mut line = format!("#{number}");
    if let Some(position) = position {
        line.push_str(&format!(" [{position}]"));
    }
    line.push_str(&format!(" {} \"{}\"", row.kind.name(), row.name));
    for fact in facts(row, today) {
        line.push_str(" · ");
        line.push_str(&fact);
    }
    line
}

/// `#3 person "Neha Rao"`.
#[must_use]
pub fn short(number: usize, row: &Row) -> String {
    format!("#{number} {} \"{}\"", row.kind.name(), row.name)
}

/// `[task: date (due), status, effort, completed]`.
#[must_use]
pub fn card_hint(kind: Kind) -> String {
    let spec = kind.spec();
    let mut names: Vec<String> = Vec::new();
    if let Some(date) = spec.date {
        names.push(format!("date ({})", date.label));
    }
    names.extend(spec.fields.iter().map(|field| field.name.to_owned()));
    if names.is_empty() {
        format!("[{}]", kind.name())
    } else {
        format!("[{}: {}]", kind.name(), names.join(", "))
    }
}

/// `5 tasks` or `3 rows: 2 tasks, 1 event`.
#[must_use]
pub fn count_phrase(kinds: &[Kind], rows: &[&Row]) -> String {
    if kinds.len() == 1 {
        return kinds[0].count(rows.len());
    }
    let parts: Vec<String> = kinds
        .iter()
        .map(|kind| kind.count(rows.iter().filter(|row| row.kind == *kind).count()))
        .collect();
    format!("{} rows: {}", rows.len(), parts.join(", "))
}

/// The kinds, as a phrase: `tasks`, `tasks or events`.
#[must_use]
pub fn plural_list(kinds: &[Kind]) -> String {
    kinds
        .iter()
        .map(|kind| kind.plural())
        .collect::<Vec<_>>()
        .join(" or ")
}

/// The one-line kind card (SPEC §6.0.3).
#[must_use]
pub fn card_line(kind: Kind, currency: &str) -> String {
    let spec = kind.spec();
    // `name` first on every card: it is a field like any other, and a
    // rename is `edit name: …`.
    let mut parts: Vec<String> = vec!["name".to_owned()];
    if let Some(date) = spec.date {
        parts.push(format!("date ({})", date.label));
    }
    parts.extend(spec.fields.iter().map(|field| field.card(currency)));
    let mut line = format!("{}: {}", kind.name(), parts.join(", "));
    if !spec.links.is_empty() {
        let links: Vec<&str> = spec.links.iter().map(|link| link.label).collect();
        line.push_str(&format!(" · links: {}", links.join(", ")));
    }
    let verbs: Vec<&str> = spec.verbs().iter().map(|verb| verb.spec().name).collect();
    if !verbs.is_empty() {
        line.push_str(&format!(" · verbs: {}", verbs.join(" ")));
    }
    if let Some(balance) = spec.balance {
        line.push_str(&format!(" · balance: {balance}"));
    }
    line
}

/// Linked rows inline on a search hit: `links: person #3, album #7`.
#[must_use]
pub fn links_inline(parts: &[String]) -> String {
    if parts.is_empty() {
        String::new()
    } else {
        format!(" · links: {}", parts.join(", "))
    }
}

/// A value, as `@5 = …` spells it.
#[must_use]
pub fn amounts(values: &[(i64, Option<String>)]) -> String {
    if values.is_empty() {
        return "0".to_owned();
    }
    values
        .iter()
        .map(|(value, currency)| match currency {
            Some(currency) => crate::world::money(*value, currency),
            None => value.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

/// The name of a row for an echo, with its number.
#[must_use]
pub fn named(world: &World, number: usize, key: &crate::world::Key) -> String {
    world
        .row(key)
        .map_or_else(|| format!("#{number}"), |row| short(number, row))
}
