//! LOCKER'S EARLIER VERSIONS: the kit's one earlier-versions screen with Locker's spec (#1185),
//! for what the vault keeps of an item and nothing else.
//!
//! **The vault keeps no history of a sealed value**: not a password, a one-time-code seed, a card
//! number, a CVV, a note's content, a sealed custom field or a passkey, and not as ciphertext
//! either (`centraid_vault::history::OMITTED`). A retired password is what the member replaced so
//! that it would stop existing. So a version here is a change to the item's PLAIN fields: its name,
//! username, address, notes, cardholder, expiry, brand, full name, email, phone, postal address and
//! network, an added or removed address, and a custom field that is not sealed. A change to a sealed
//! value alone makes no version, so no line and no entry stands for it. A line is `Username: ada ·
//! Address: example.com`, in the page's own words for each field; what the page does not show reads
//! "Other details". A one-time-code custom field is never worded, since its text is a secret by
//! another name.
//!
//! **Every Locker rule holds.** The entry is on the item page, which is blank while Locker is
//! locked, and the screen reads and restores nothing behind a shut wall ([`EarlierSpec::gate`]: it
//! draws the locked gate, as the trash does). Earlier values reach no search and no assistant: the
//! three shell reads are not reachable from chat.

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;
use wire::app_query_response::Answer;

use super::shared;
use super::types;
use crate::catalog::load;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{fill, locker as words, shared as kit_words};

/// Locker's earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "locker",
    noun: kit_words::trash_noun_item,
    denied: shared::gate,
    line,
    know: Some(know),
    gate: Some(shared::closed),
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

/// The plain columns the page shows, in the page's order. A sealed column is never one of them.
const PLAIN: [&str; 11] = [
    "username",
    "url",
    "cardholder",
    "expiry",
    "brand",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
    "notes",
];

/// How many characters of a note a line carries.
const NOTE_REACH: usize = 80;

/// The labels of the item's custom fields by id, for a change to a column of one whose row is not
/// whole. A sealed field and a one-time-code field are not named: their values are not worded.
fn know(ctx: &Ctx, item_id: &str) -> Names {
    let mut names = Names::new();
    if shared::closed(ctx).is_some() {
        return names;
    }
    if let Reading::Data(Some(item)) = read::read(
        ctx,
        load::locker::Item {
            item_id: item_id.to_owned(),
        },
        |answer| match answer {
            Answer::LockerItem(detail) => Some(detail.item),
            _ => None,
        },
    ) {
        for field in item.fields.iter().filter(|field| speakable(&field.kind)) {
            names.insert(field.field_id.clone(), field.label.clone());
        }
    }
    names
}

/// Whether a custom field of this kind has a value a line may carry.
fn speakable(kind: &str) -> bool {
    matches!(kind, "text" | "url" | "date")
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A note's first line, cut short.
fn brief(note: &str) -> String {
    let first = note.lines().next().unwrap_or_default().trim();
    if first.chars().count() > NOTE_REACH {
        let cut: String = first.chars().take(NOTE_REACH).collect();
        format!("{}…", cut.trim_end())
    } else {
        first.to_owned()
    }
}

/// `Label: value`, or `Label: none` where the field was empty.
fn said(locale: crate::strings::Locale, label: &str, value: Option<String>) -> String {
    match value {
        Some(value) => fill(
            &words::earlier_field(locale),
            &[("label", label), ("value", &value)],
        ),
        None => fill(&words::earlier_cleared(locale), &[("label", label)]),
    }
}

/// The id and column of `locker_item_field[<id>]` and `locker_item_field[<id>].value_text`.
fn custom(field: &Field) -> Option<(&str, Option<&str>)> {
    let rest = field.name.strip_prefix("locker_item_field[")?;
    let (id, column) = rest.split_once(']')?;
    Some((id, column.strip_prefix('.')))
}

/// The one line an item's plain fields read as.
fn line(look: &Look, fields: &[Field]) -> String {
    let locale = look.locale;
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let mut parts = Vec::new();
    if let Some(field) = named("entity.title") {
        parts.push(said(
            locale,
            &types::label(locale, "title"),
            text(&field.value),
        ));
    }
    for column in PLAIN {
        // A sealed column is not in the list above; this is the second wall, not the first.
        if types::is_secret(column) {
            continue;
        }
        let Some(field) = named(&format!("locker_item.{column}")) else {
            continue;
        };
        let value = text(&field.value).map(|value| {
            if column == "notes" {
                brief(&value)
            } else {
                value
            }
        });
        parts.push(said(locale, &types::label(locale, column), value));
    }
    for field in fields {
        if let Some(rest) = field.name.strip_prefix("locker_item_address[") {
            // An address the item held (the whole row) or an address changed in place.
            let url = match rest.split_once(']').map(|(_, column)| column) {
                Some("") => field.value.get("url").and_then(text),
                Some(".url") => text(&field.value),
                _ => None,
            };
            if let Some(url) = url {
                parts.push(said(locale, &types::label(locale, "url"), Some(url)));
            }
            continue;
        }
        let Some((id, column)) = custom(field) else {
            continue;
        };
        match (column, &field.value) {
            // The whole row: held then, so its own label and kind say whether it has words.
            (None, Value::Object(row)) => {
                let kind = row.get("kind").and_then(Value::as_str).unwrap_or_default();
                let label = row.get("label").and_then(Value::as_str).unwrap_or_default();
                if speakable(kind) && !label.trim().is_empty() {
                    parts.push(said(
                        locale,
                        label.trim(),
                        row.get("value_text").and_then(text),
                    ));
                }
            }
            // One column of a row that stayed: named from the item as it is now.
            (Some("value_text"), value) => {
                if let Some(label) = look.names.get(id) {
                    parts.push(said(locale, label, text(value)));
                }
            }
            _ => {}
        }
    }
    parts.join(" · ")
}
