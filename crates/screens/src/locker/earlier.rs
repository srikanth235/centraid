//! LOCKER'S EARLIER VERSIONS: the kit's one earlier-versions screen with Locker's spec (#1185),
//! for what the vault keeps of an item.
//!
//! **A changed secret keeps its earlier value, SEALED.** The vault keeps a replaced password, card
//! number, CVV, note, one-time-code seed or sealed custom field as the `lk1:` ciphertext it was,
//! never a plaintext (`centraid_vault::history`). This screen never holds one: a version that held
//! a secret says so in its line ("Password changed") and draws the secret as dots with a Reveal
//! behind the same owner check as the item's own (the unlocked Locker session: the core opens that
//! version's cell with the key in its memory, stamps the item as used, and the value lives on the
//! screen for the reveal window, then is concealed on Conceal, on the timer, on leaving and on a
//! relock). A one-time-code seed comes back with a restore but is drawn as dots with no Reveal,
//! as it never is live. A restore puts the sealed values back with the plain ones.
//!
//! A line is `Username: ada · Password changed`, in the page's own words for each field; what the
//! page does not show reads "Other details". A one-time-code custom field's value is never worded.
//!
//! **Every Locker rule holds.** The entry is on the item page, which is blank while Locker is
//! locked, and the screen reads, reveals and restores nothing behind a shut wall ([`Wall::closed`]:
//! it draws the locked gate, as the trash does). Earlier values reach no search and no assistant:
//! the three shell reads are not reachable from chat.

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;
use wire::app_query_response::Answer;

use super::shared::{self, Opened, Refused};
use super::types;
use crate::catalog::load;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names, Secret, Wall};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{fill, locker as words, shared as kit_words};

/// Locker's earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "locker",
    noun: kit_words::trash_noun_item,
    denied: shared::gate,
    parts,
    know: Some(know),
    gate: Some(&WALL),
};

/// Locker's lock, and the sealed values its versions hold.
static WALL: Wall = Wall {
    closed: shared::closed,
    secrets,
    open,
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

/// The kind of a custom field is kept beside its label under `<id>#kind`.
const KIND: &str = "#kind";

/// The labels and kinds of the item's custom fields by id, for a change to a column of one whose
/// row is not whole. A label says which field; no field's value is read here.
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
        for field in &item.fields {
            names.insert(field.field_id.clone(), field.label.clone());
            names.insert(format!("{}{KIND}", field.field_id), field.kind.clone());
        }
    }
    names
}

/// Whether a custom field of this kind has a value a line may carry.
fn speakable(kind: &str) -> bool {
    matches!(kind, "text" | "url" | "date")
}

/// The key of a custom field's secret: `field:<id>`.
const FIELD: &str = "field:";

/// The sealed cells among a set of fields: for each, the secret it names and whether the set held a
/// value there (`false`: the cell held nothing).
fn sealed_cells(look: &Look, fields: &[Field]) -> Vec<(Secret, bool)> {
    let locale = look.locale;
    let mut cells = Vec::new();
    for field in fields {
        if let Some(column) = field.name.strip_prefix("locker_item.")
            && types::is_secret(column)
        {
            cells.push((
                Secret {
                    key: column.to_owned(),
                    label: types::label(locale, column),
                    // A seed is the second factor: dots for good.
                    revealable: column != types::SEED,
                },
                !field.value.is_null(),
            ));
            continue;
        }
        // A passkey's key: dots for good, as it is never shown live.
        let passkey = match (field.name.as_str(), &field.value) {
            ("locker_item_passkey.private_key", value) => Some(!value.is_null()),
            ("locker_item_passkey", Value::Object(row)) => {
                Some(row.get("private_key").is_some_and(|value| !value.is_null()))
            }
            _ => None,
        };
        if let Some(held) = passkey {
            cells.push((
                Secret {
                    key: "private_key".to_owned(),
                    label: words::passkey_head(locale),
                    revealable: false,
                },
                held,
            ));
            continue;
        }
        let Some((id, column)) = custom(field) else {
            continue;
        };
        let (kind, label, held) = match (column, &field.value) {
            // One column of a field that stayed: its kind and label as the item holds it now.
            (Some("value_sealed"), value) => (
                look.names.get(&format!("{id}{KIND}")).cloned(),
                look.names.get(id).cloned(),
                !value.is_null(),
            ),
            // The whole row, held then (a removed field) or now (an added one).
            (None, Value::Object(row)) => (
                row.get("kind").and_then(Value::as_str).map(str::to_owned),
                row.get("label").and_then(Value::as_str).map(str::to_owned),
                row.get("value_sealed")
                    .is_some_and(|value| !value.is_null()),
            ),
            _ => continue,
        };
        if !matches!(kind.as_deref(), Some("sealed" | "otp")) {
            continue;
        }
        cells.push((
            Secret {
                key: format!("{FIELD}{id}"),
                label: label
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or_else(|| types::label(locale, "value")),
                revealable: kind.as_deref() == Some("sealed"),
            },
            held,
        ));
    }
    cells
}

/// The secrets a version held: only those it held a value of.
fn secrets(look: &Look, fields: &[Field]) -> Vec<Secret> {
    sealed_cells(look, fields)
        .into_iter()
        .filter_map(|(secret, held)| held.then_some(secret))
        .collect()
}

/// Open a version's secret: the core opens its sealed cell behind the unlocked session, as it
/// does the live one.
fn open(ctx: &Ctx, item_id: &str, seq: i64, key: &str) -> earlier::Opened {
    let (column, field_id) = match key.strip_prefix(FIELD) {
        Some(id) => ("value_sealed", id),
        None => (key, ""),
    };
    match shared::reveal(ctx, item_id, column, field_id, false, seq) {
        Ok(Opened { value, life }) => Ok((value, life)),
        Err(Refused::Locked) => Err(None),
        Err(Refused::Said(sentence)) => Err(Some(sentence)),
    }
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
fn parts(look: &Look, fields: &[Field]) -> Vec<String> {
    let locale = look.locale;
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let mut lines = Vec::new();
    if let Some(field) = named("entity.title") {
        lines.push(said(
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
        lines.push(said(locale, &types::label(locale, column), value));
    }
    if let Some(field) = named("locker_item_passkey.display_name") {
        lines.push(said(
            locale,
            &words::passkey_head(locale),
            text(&field.value),
        ));
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
                lines.push(said(locale, &types::label(locale, "url"), Some(url)));
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
                    lines.push(said(
                        locale,
                        label.trim(),
                        row.get("value_text").and_then(text),
                    ));
                }
            }
            // One column of a row that stayed: named from the item as it is now.
            (Some("value_text"), value) => {
                if let Some(label) = look.names.get(id) {
                    lines.push(said(locale, label, text(value)));
                }
            }
            _ => {}
        }
    }
    // A secret is never worded, only that it changed (or held nothing): its value is not here.
    for (secret, held) in sealed_cells(look, fields) {
        // A whole version shows what it held as dots: a Reveal is on the list, never here.
        if look.whole {
            if held {
                lines.push(said(
                    locale,
                    &secret.label,
                    Some(earlier::MASKED.to_owned()),
                ));
            }
            continue;
        }
        lines.push(if held {
            fill(
                &words::earlier_secret_changed(locale),
                &[("label", &secret.label)],
            )
        } else {
            fill(&words::earlier_cleared(locale), &[("label", &secret.label)])
        });
    }
    lines
}
