//! PEOPLE'S EARLIER VERSIONS: the kit's one earlier-versions screen with People's spec (#1185).
//!
//! A person keeps their name, role, nickname, birthday and how you met, and each contact point
//! (their `contact_point` rows). The line a version reads as is those it held, as the page words
//! them: the name, the role, the nickname, the birthday as "12 September", how you met, and each
//! number, email, address or handle. Fields the page does not show (the sort name, the avatar, the
//! touch cadence) have no words and no line; a version that changed only
//! those reads "Other details".

use serde_json::Value;

use super::{denied, fold};
use crate::kit::earlier::{self, EarlierSpec, Field, Look};
use crate::screen::Screen;
use crate::strings::{Locale, shared};
use centraid_api_proto::core_v1 as wire;

/// People's earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "people",
    noun: shared::trash_noun_person,
    denied,
    parts,
    know: None,
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A contact point's value, whether the field is the whole row or its `value` column.
fn point(field: &Field) -> Option<String> {
    let rest = field.name.strip_prefix("contact_point[")?;
    let (_, column) = rest.split_once(']')?;
    match column {
        "" => text(field.value.get("value")?),
        ".value" => text(&field.value),
        _ => None,
    }
}

fn birthday(locale: Locale, day: &str) -> String {
    // A birthday with its year is shown as the page shows it: the day and the month.
    fold::month_day(
        locale,
        day.get(5..).filter(|_| day.len() == 10).unwrap_or(day),
    )
}

/// The one line a person's fields read as: `Ada Lovelace · Countess · 10 December · +44 20 7946 0000`.
fn parts(look: &Look, fields: &[Field]) -> Vec<String> {
    let locale = look.locale;
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let own = |name: &str| named(name).and_then(|field| text(&field.value));
    let mut parts = vec![
        own("entity.title"),
        own("person.role"),
        own("person.nickname"),
        own("person.birthday").map(|day| birthday(locale, &day)),
        own("person.met"),
    ];
    parts.extend(fields.iter().map(point));
    parts.into_iter().flatten().collect()
}
