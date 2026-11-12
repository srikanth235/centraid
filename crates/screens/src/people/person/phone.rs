//! THE LINES UNDER WHAT THE PHONE SAYS (#1183) on a followed person: the name, the role, the
//! nickname, the birthday and the contact channels, each only where the member's value differs from
//! the phone's, each worded as the page words that field.
//!
//! `sort_name` is stated and followed but the page never shows it, so it has no line. A channel the
//! member added has none; one they changed says what the phone has, one they removed says the phone
//! still has it.

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;

use crate::kit::follow::{self, Difference, Source};
use crate::people::fold;
use crate::strings::{Locale, fill, people as words};

/// The page's lines, by where they sit.
#[derive(Default)]
pub struct Lines {
    pub name: Option<wire::PhoneSays>,
    pub role: Option<wire::PhoneSays>,
    pub nickname: Option<wire::PhoneSays>,
    pub birthday: Option<wire::PhoneSays>,
    pub channels: Vec<wire::PhoneSays>,
}

/// A channel as the page shows it: its value, and its label after it when it has one.
fn channel(locale: Locale, item: &Value) -> Option<(String, String)> {
    let value = follow::text(item.get("value")?)?;
    let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
    let noun = match kind {
        "phone" => words::says_noun_number(locale),
        "email" => words::says_noun_email(locale),
        "address" => words::says_noun_address(locale),
        "handle" => words::says_noun_handle(locale),
        other => fold::channel_kind(locale, other).to_lowercase(),
    };
    let shown = match item.get("label").and_then(follow::text) {
        Some(label) => fill(
            &words::says_labelled(locale),
            &[("value", &value), ("label", &label)],
        ),
        None => value,
    };
    Some((shown, noun))
}

#[must_use]
pub fn lines(locale: Locale, found: &[Difference]) -> Lines {
    let whole = |field: &str, noun: String, show: &dyn Fn(&str) -> String| {
        let difference = follow::of(found, field)?;
        let stated = follow::text(&difference.stated)?;
        Some(follow::says(
            locale,
            Source::Phone,
            &show(&stated),
            &noun,
            field,
            None,
        ))
    };
    Lines {
        name: whole("title", words::says_noun_name(locale), &str::to_owned),
        role: whole("role", words::says_noun_role(locale), &str::to_owned),
        nickname: whole(
            "nickname",
            words::says_noun_nickname(locale),
            &str::to_owned,
        ),
        birthday: whole("birthday", words::says_noun_birthday(locale), &|day| {
            fold::month_day(locale, day)
        }),
        channels: follow::of(found, "points").map_or_else(Vec::new, |points| {
            follow::item_lines(locale, Source::Phone, points, |_, item| {
                channel(locale, item)
            })
        }),
    }
}
