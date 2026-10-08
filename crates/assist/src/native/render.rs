//! How rows, results and values read in an observation (SPEC §5).

use jiff::civil::Date;

use crate::native::dates::{Stamp, relative_label};
use crate::native::meta::{FieldType, Kind};
use crate::native::world::{Row, Val, World};

/// `Fri 2026-06-19 09:00 (this Friday)`.
#[must_use]
pub fn when(stamp: Stamp, today: Date) -> String {
    match relative_label(stamp.date, today) {
        Some(label) => format!("{} ({label})", stamp.show()),
        None => stamp.show(),
    }
}

/// A date for the member's confirm card: `tomorrow 09:00`, `next Friday`, or the day itself when
/// it is farther off (`Fri 2026-10-02 09:00`). [`when`] is the model's spelling of the same date.
#[must_use]
pub fn card_when(stamp: Stamp, today: Date) -> String {
    match (relative_label(stamp.date, today), stamp.time) {
        (Some(label), Some(time)) => format!("{label} {}", crate::native::dates::clock(time)),
        (Some(label), None) => label,
        (None, _) => stamp.show(),
    }
}

/// The longest note body, task description or event description a row line shows WHOLE
/// (nt15 R2a); a longer text is cut as every other text field is (`CUT`).
pub const WHOLE: usize = 200;
/// Where any other text, and a body or description past `WHOLE`, is cut.
const CUT: usize = 60;

/// One text field as a fact: `body "…"`. The free text of a row (a note's body, a task's or an
/// event's description) is shown whole when it is `WHOLE` characters or fewer, so an edit of it
/// is made over text the model has seen; any other text, and a longer one, is cut at `CUT`.
fn text_fact(name: &str, text: &str) -> String {
    let free = matches!(name, "body" | "description");
    let total = text.chars().count();
    if free && total <= WHOLE {
        return format!("{name} \"{text}\"");
    }
    let short: String = text.chars().take(CUT).collect();
    let ellipsis = if total > CUT { "…" } else { "" };
    format!("{name} \"{short}{ellipsis}\"")
}

/// The body or description of a row as facts, for a reply that must show it (a `restore`).
#[must_use]
pub fn text_facts(row: &Row) -> Vec<String> {
    row.kind
        .spec()
        .fields
        .iter()
        .filter(|field| matches!(field.name, "body" | "description"))
        .filter_map(|field| match row.field(field.name) {
            Some(Val::Text(text)) => Some(text_fact(field.name, text)),
            _ => None,
        })
        .collect()
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
            (FieldType::Text, Val::Text(text)) => out.push(text_fact(field.name, text)),
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
            Some(currency) => crate::native::world::money(*value, currency),
            None => value.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

/// The name of a row for an echo, with its number.
#[must_use]
pub fn named(world: &World, number: usize, key: &crate::native::world::Key) -> String {
    world
        .row(key)
        .map_or_else(|| format!("#{number}"), |row| short(number, row))
}

/// How many live rows a container holds, with the word for them: `(75,
/// "tasks")`. A list, notebook, album, folder or group is a container, and so
/// is a task that has subtasks; nothing else holds rows.
#[must_use]
pub fn contents(world: &World, key: &crate::native::world::Key) -> Option<(usize, &'static str)> {
    let link = key.0.holds()?;
    let count = world
        .edges
        .iter()
        .filter(|edge| {
            edge.from == *key
                && edge.via == link.via
                && edge.to.0 == link.kind
                && world.row(&edge.to).is_some_and(|row| !row.trashed)
        })
        .count();
    Some((count, link.label))
}

/// A row of the vault block: `#37 list "Kids" (75 tasks)`. A container adds
/// how many rows it holds after the closing quote, so the name part reads
/// exactly as `named`'s; a task shows its subtasks only when it has some.
#[must_use]
pub fn grounded(world: &World, number: usize, key: &crate::native::world::Key) -> String {
    let line = named(world, number, key);
    match contents(world, key) {
        Some((count, label)) if count > 0 || key.0.spec().container => {
            let word = if count == 1 {
                label.strip_suffix('s').unwrap_or(label)
            } else {
                label
            };
            format!("{line} ({count} {word})")
        }
        _ => line,
    }
}
