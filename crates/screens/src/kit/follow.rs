//! WHAT THE PHONE SAYS (#1183), once, for the four detail screens that draw it (a person, an event,
//! a document and a workout).
//!
//! A followed row's field is the member's the moment they change it, and the store's words about it
//! stay worth keeping. Only the detail screen says where the two differ: a line under the field
//! ("Phone says Ada Lovelase") with one tap to take the store's value back. A list, a tile, Home and
//! search show the member's value and no mark.
//!
//! - **The read** is `shell.phone-differences`: the vault works the differences out on each read
//!   from what the store last stated and what the vault holds. Nothing is stored, so the line goes
//!   by itself once the two agree.
//! - **The words** are the screen's: it formats each value as it already shows that field (a number
//!   as numbers are shown, a distance in the member's units, a date in its zone), then [`says`] or
//!   [`still_has`] makes the line in the store's name.
//! - **The tap** is one [`wire::PhoneSaysTaken`] on every page. The screen runs [`take`], reads
//!   again, and a refusal is its own status sentence, never silence.
//!
//! A read that does not land draws no line, and says so: the member's own values are all on
//! screen, but no line is not "the phone agrees" when the check was not made. The page's status line
//! carries one sentence ([`Phone::status`]) over the page as it otherwise is. A read that was
//! refused says the same: nothing on this path answers "refused" for a row that follows nothing (that
//! is an empty answer), so a refusal is a check that was not made.

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, follow as words, shared};

/// One field the member's value differs on.
#[derive(Clone, Debug, PartialEq)]
pub struct Difference {
    pub field: String,
    pub stated: Value,
    pub held: Value,
    /// For a field made of items, those that differ, in key order.
    pub items: Vec<Item>,
}

/// One item of a field made of items.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub key: String,
    /// `None`: the store never stated it, the member added it.
    pub stated: Option<Value>,
    /// `None`: the vault no longer holds it, the member removed it.
    pub held: Option<Value>,
}

fn json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// What the phone's store says that differs on a row, and whether the check was made. It reads as
/// the slice of differences; an unchecked one has none, and [`Phone::status`] says why.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Phone {
    found: Vec<Difference>,
    unchecked: bool,
}

impl std::ops::Deref for Phone {
    type Target = [Difference];

    fn deref(&self) -> &[Difference] {
        &self.found
    }
}

impl Phone {
    /// The one sentence for a check that was not made, in the store's name; `None` when it was.
    #[must_use]
    pub fn status(&self, locale: Locale, source: Source<'_>) -> Option<wire::StatusLine> {
        if !self.unchecked {
            return None;
        }
        let sentence = match source {
            Source::Phone => words::unchecked_phone_status(locale),
            Source::Folder => words::unchecked_folder_status(locale),
            Source::Store(name) => fill(&words::unchecked_store_status(locale), &[("store", name)]),
        };
        Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: false,
        })
    }
}

/// What differs on `entity_id`: nothing when it differs on nothing or when nothing follows it, and
/// nothing but an unchecked mark when the read does not land.
pub fn read(ctx: &Ctx, entity_id: &str) -> Phone {
    if entity_id.is_empty() {
        return Phone::default();
    }
    let reading = read::read(
        ctx,
        load::shell::PhoneDifferences {
            entity_id: entity_id.to_owned(),
        },
        |answer| match answer {
            Answer::FollowDifferences(found) => Some(found),
            _ => None,
        },
    );
    let Reading::Data(found) = reading else {
        return Phone {
            found: Vec::new(),
            unchecked: true,
        };
    };
    let found = found
        .fields
        .into_iter()
        .map(|difference| Difference {
            field: difference.field,
            stated: json(&difference.stated_json),
            held: json(&difference.held_json),
            items: difference
                .items
                .into_iter()
                .map(|item| Item {
                    key: item.key,
                    stated: item.stated_json.as_deref().map(json),
                    held: item.held_json.as_deref().map(json),
                })
                .collect(),
        })
        .collect();
    Phone {
        found,
        unchecked: false,
    }
}

/// The difference of `field`, when there is one.
#[must_use]
pub fn of<'a>(found: &'a [Difference], field: &str) -> Option<&'a Difference> {
    found.iter().find(|difference| difference.field == field)
}

/// A JSON string with something in it, trimmed.
#[must_use]
pub fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Whose words the line quotes.
#[derive(Clone, Copy, Debug)]
pub enum Source<'a> {
    /// The phone's contacts and calendar.
    Phone,
    /// A followed folder.
    Folder,
    /// The health store, by its name ("Apple Health").
    Store(&'a str),
}

fn line(
    lead: String,
    action: String,
    spoken: String,
    field: &str,
    item: Option<&str>,
) -> wire::PhoneSays {
    wire::PhoneSays {
        lead,
        action_label: action,
        accessibility_label: spoken,
        take: Some(wire::PhoneSaysTake {
            field: field.to_owned(),
            item_key: item.map(str::to_owned),
        }),
    }
}

/// "Phone says {value}" with "Use phone’s": a field, or an item, the member holds differently.
/// `noun` is what the thing is called to a screen reader ("name", "number").
#[must_use]
pub fn says(
    locale: Locale,
    source: Source<'_>,
    value: &str,
    noun: &str,
    field: &str,
    item: Option<&str>,
) -> wire::PhoneSays {
    let (lead, action, spoken, store) = match source {
        Source::Phone => (
            words::says_phone_lead(locale),
            words::use_phone_action(locale),
            words::use_phone_spoken(locale),
            String::new(),
        ),
        Source::Folder => (
            words::says_folder_lead(locale),
            words::use_folder_action(locale),
            words::use_folder_spoken(locale),
            String::new(),
        ),
        Source::Store(name) => (
            words::says_store_lead(locale),
            words::use_store_action(locale),
            words::use_store_spoken(locale),
            name.to_owned(),
        ),
    };
    let holes = [("value", value), ("noun", noun), ("store", store.as_str())];
    line(
        fill(&lead, &holes),
        fill(&action, &holes),
        fill(&spoken, &holes),
        field,
        item,
    )
}

/// "Phone still has {value}" with "Add back": an item the member removed.
#[must_use]
pub fn still_has(
    locale: Locale,
    source: Source<'_>,
    value: &str,
    noun: &str,
    field: &str,
    item: Option<&str>,
) -> wire::PhoneSays {
    let (lead, spoken, store) = match source {
        Source::Phone => (
            words::has_phone_lead(locale),
            words::back_phone_spoken(locale),
            String::new(),
        ),
        Source::Folder => (
            words::has_folder_lead(locale),
            words::back_folder_spoken(locale),
            String::new(),
        ),
        Source::Store(name) => (
            words::has_store_lead(locale),
            words::back_store_spoken(locale),
            name.to_owned(),
        ),
    };
    let holes = [("value", value), ("noun", noun), ("store", store.as_str())];
    line(
        fill(&lead, &holes),
        words::back_action(locale),
        fill(&spoken, &holes),
        field,
        item,
    )
}

/// The lines for a field made of items: a changed item says what the store says, one the member
/// removed says what the store still has, one the member added has none. `show` words an item's
/// value (given the item, and the value the store states of it) and the noun a screen reader calls
/// it; an item it cannot word (`None`) has no line.
#[must_use]
pub fn item_lines(
    locale: Locale,
    source: Source<'_>,
    difference: &Difference,
    show: impl Fn(&Item, &Value) -> Option<(String, String)>,
) -> Vec<wire::PhoneSays> {
    difference
        .items
        .iter()
        .filter_map(|item| {
            let stated = item.stated.as_ref()?;
            let (value, noun) = show(item, stated)?;
            let key = Some(item.key.as_str());
            Some(if item.held.is_none() {
                still_has(locale, source, &value, &noun, &difference.field, key)
            } else {
                says(locale, source, &value, &noun, &difference.field, key)
            })
        })
        .collect()
}

/// Take the store's value back for the field (and item) a line named.
pub fn take(ctx: &Ctx, entity_id: &str, taken: &wire::PhoneSaysTaken) -> Option<Settled> {
    let take = taken.take.as_ref().filter(|take| !take.field.is_empty())?;
    let request = act::shell::TakeStated {
        entity: entity_id.to_owned(),
        field: take.field.clone(),
        item_key: take.item_key.clone(),
    };
    let key = kit_act::key(
        &[
            "take-stated",
            entity_id,
            &take.field,
            take.item_key.as_deref().unwrap_or_default(),
        ],
        kit_act::fresh(),
    );
    Some(kit_act::act(ctx, request, &key))
}

/// THE MORE ROW THAT STOPS READING A FOLLOWED STORE ("Stop reading Apple Health"), the same words
/// for every store the phone keeps that an app follows (#1185). It opens [`stop_confirm`].
#[must_use]
pub fn stop_row(locale: Locale, store: &str) -> String {
    fill(&shared::follow_stop_row(locale), &[("store", store)])
}

/// THE STOP SHEET: "Stop reading {store}?", what stays ("The days and workouts already here
/// stay"), and a destructive "Stop reading". `app` is the app's name and `kept` what it already
/// holds from the store, which stopping leaves as ordinary rows.
#[must_use]
pub fn stop_confirm(locale: Locale, app: &str, store: &str, kept: &str) -> wire::Confirm {
    wire::Confirm {
        title: fill(&shared::follow_stop_title(locale), &[("store", store)]),
        body: fill(
            &shared::follow_stop_body(locale),
            &[("app", app), ("store", store), ("kept", kept)],
        ),
        confirm_label: shared::follow_stop_confirm(locale),
        destructive: true,
    }
}
