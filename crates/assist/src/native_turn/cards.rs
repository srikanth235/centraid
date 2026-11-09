//! A RESULT IS THE CHAT'S EXISTING CARD (R-1088-7): the kind to app and entity table.
//!
//! The runtime's rows are fourteen kinds; the chat's card names one of eight apps and an entity the
//! shell routes by. This is the one place that says which. A card is a reference (`app`,
//! `entity`, `id`) and a few words; the app's own tile draws the row.
//!
//! | kind | app | entity | a tap opens |
//! |---|---|---|---|
//! | person | people | `person` | the person |
//! | event | calendar | `event` | the event |
//! | task | tasks | `task` | the task |
//! | note | notes | `note` | the note |
//! | document | docs | `document` | the document |
//! | photo | photos | `photo` | the lightbox |
//! | album | photos | `album` | the album's shelf |
//! | notebook | notes | `notebook` | the library under that notebook |
//! | folder | docs | `folder` | the folder's page |
//! | list | tasks | `project` | the project |
//! | transaction | money | `transaction` | the transaction's page |
//! | locker item | locker | `locker_item` | the item's page, behind the Locker's lock wall |
//! | workout | health | `workout` | the workout's page |
//! | daily figure | health | `daily_figure` | Health's front door: a day's total has no page of its own |
//! | account, category, budget, rule | money | the kind's name | Money's home |
//!
//! The album, notebook and folder routes are the shell's since the containers became search results
//! (#1097, `ChatRouting.swift`): the card's `id` is the container's id and its `title` the name the route needs.
//! The kinds with no row route open their app's home, which is what the shell does with any entity
//! it has no route for (`ChatRouting.appHome`): a tap that reached nothing would read as a broken
//! card. Giving one a route is a shell change and no schema change: `chat_message_card.entity` holds
//! any non-empty word, and `app` is one of the eight this table maps into.

use jiff::civil::Date;

use crate::app::App;
use crate::native::meta::Kind;
use crate::native::world::{Row, Val};
use crate::result::Card;

/// Where a tap on a card lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opens {
    /// The row itself: the shell has a route for this `(app, entity)`.
    Row,
    /// The app's home: the shell has no route for the entity.
    AppHome,
}

/// How one kind is drawn as a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CardKind {
    pub kind: Kind,
    pub app: App,
    pub entity: &'static str,
    pub opens: Opens,
}

const fn row(kind: Kind, app: App, entity: &'static str) -> CardKind {
    CardKind {
        kind,
        app,
        entity,
        opens: Opens::Row,
    }
}

const fn home(kind: Kind, app: App, entity: &'static str) -> CardKind {
    CardKind {
        kind,
        app,
        entity,
        opens: Opens::AppHome,
    }
}

/// THE TABLE. Every kind.
pub const TABLE: [CardKind; 18] = [
    row(Kind::Person, App::People, "person"),
    row(Kind::Event, App::Calendar, "event"),
    row(Kind::Task, App::Reminders, "task"),
    row(Kind::Note, App::Notes, "note"),
    row(Kind::Document, App::Docs, "document"),
    row(Kind::Photo, App::Photos, "photo"),
    row(Kind::Album, App::Photos, "album"),
    row(Kind::Notebook, App::Notes, "notebook"),
    row(Kind::Folder, App::Docs, "folder"),
    row(Kind::List, App::Reminders, "project"),
    row(Kind::Transaction, App::Money, "transaction"),
    row(Kind::LockerItem, App::Locker, "locker_item"),
    row(Kind::Workout, App::Health, "workout"),
    CardKind {
        kind: Kind::DailyFigure,
        app: App::Health,
        entity: "daily_figure",
        opens: Opens::AppHome,
    },
    // Money's account, category, budget and rule have no page of their own in the shell's row
    // routes: a tap opens Money's home, where the lists they live in are one tap away.
    home(Kind::Account, App::Money, "account"),
    home(Kind::Category, App::Money, "category"),
    home(Kind::Budget, App::Money, "budget"),
    home(Kind::Rule, App::Money, "rule"),
];

/// How a kind is drawn.
#[must_use]
pub fn card_kind(kind: Kind) -> Option<&'static CardKind> {
    TABLE.iter().find(|entry| entry.kind == kind)
}

/// The app a kind belongs to.
#[must_use]
pub fn app_of(kind: Kind) -> Option<App> {
    card_kind(kind).map(|entry| entry.app)
}

/// The card of a row: its name, its date, and one word of state.
#[must_use]
pub fn card_of(row: &Row, today: Date) -> Option<Card> {
    let how = card_kind(row.kind)?;
    let mut card = Card::new(how.app, how.entity, row.id.clone(), row.name.clone());
    // A person's date is when the row was made, which says nothing about them; every other kind's
    // is the day it is about.
    if let Some(stamp) = row.date.filter(|_| row.kind != Kind::Person) {
        card = card.subtitle(friendly(stamp, today));
    }
    match row.kind {
        Kind::Event => card = card.subtitle(event_line(row, today)),
        Kind::Person => card = card.subtitle(person_line(row, today)),
        _ => {}
    }
    // A transaction's one word is what it moved: `-42.00 USD`.
    let state = match (row.kind, row.field("amount"), row.field("status")) {
        (Kind::Transaction, Some(amount), _) => amount.show(None),
        // the ordinary state of a row is not worth a word on a card
        (_, _, Some(Val::Enum(status))) if !matches!(*status, "confirmed" | "open" | "posted") => {
            (*status).to_owned()
        }
        _ => String::new(),
    };
    Some(card.meta(state))
}

/// An event's second line as the board draws it: the day and the span, then the place
/// (`Today · 11:15 – 12:30 · Café Lume`). The end is the start and the event's length.
fn event_line(row: &Row, today: Date) -> String {
    use crate::native::dates::clock;
    let mut line = row
        .date
        .map(|stamp| friendly(stamp, today))
        .unwrap_or_default();
    if let (Some(start), Some(Val::Num(minutes))) = (row.date, row.field("duration"))
        && start.time.is_some()
        && *minutes > 0
        && let Ok(end) = start
            .at()
            .checked_add(jiff::SignedDuration::from_mins(*minutes))
        && end.date() == start.date
    {
        line = format!("{line} – {}", clock(end.time()));
    }
    match row.extra.get("place") {
        Some(place) if !line.is_empty() => format!("{line} · {place}"),
        Some(place) => place.clone(),
        None => line,
    }
}

/// A person's second line: what they are to the member and the one fact worth a word today,
/// their birthday when it is near (`Landlord · birthday today`).
fn person_line(row: &Row, today: Date) -> String {
    let role = match row.field("role") {
        Some(Val::Text(role)) => role.clone(),
        _ => String::new(),
    };
    let birthday = row
        .extra
        .get("birthday")
        .and_then(|day| birthday_fact(day, today));
    match (role.is_empty(), birthday) {
        (false, Some(fact)) => format!("{role} · {fact}"),
        (false, None) => role,
        (true, Some(fact)) => fact,
        (true, None) => String::new(),
    }
}

/// `birthday today`, `birthday tomorrow`, or `birthday Fri 6 Nov` when it falls in the next
/// month; none when it is further off or past. The stored day is `MM-DD` or a full date.
fn birthday_fact(day: &str, today: Date) -> Option<String> {
    let (month, date) = match day.len() {
        5 => day.split_once('-')?,
        10 => day[5..].split_once('-')?,
        _ => return None,
    };
    let (month, date): (i8, i8) = (month.parse().ok()?, date.parse().ok()?);
    let next = [today.year(), today.year() + 1]
        .into_iter()
        .find_map(|year| {
            let found = Date::new(year, month, date).ok()?;
            (found >= today).then_some(found)
        })?;
    match (next - today).get_days() {
        0 => Some("birthday today".to_owned()),
        1 => Some("birthday tomorrow".to_owned()),
        2..=30 => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            Some(format!(
                "birthday {} {} {}",
                crate::native::dates::weekday_abbrev(next),
                next.day(),
                MONTHS[usize::try_from(next.month() - 1).unwrap_or(0)]
            ))
        }
        _ => None,
    }
}

/// The stored card of one proposed step, so a thread reopened later can draw the proposal's row
/// (title and when) inert. A step whose kind belongs to no app has none.
pub const PROPOSAL_STEP: &str = "proposal_step";

/// The step cards of a parked write, in order: `qualifier` is the verb, `meta` the kind, `title`
/// the row's name and `subtitle` when it is.
#[must_use]
pub fn step_cards(steps: &[crate::native_turn::CardStep]) -> Vec<Card> {
    steps
        .iter()
        .enumerate()
        .filter_map(|(at, step)| {
            let kind = Kind::ALL
                .into_iter()
                .find(|kind| kind.name() == step.kind)?;
            let mut card = Card::new(
                app_of(kind)?,
                PROPOSAL_STEP,
                (at + 1).to_string(),
                step.title.clone(),
            )
            .subtitle(step.when.clone())
            .meta(step.kind.clone());
            card.qualifier.clone_from(&step.verb);
            Some(card)
        })
        .collect()
}

/// A card's day in the member's words (the board's "Today · 11:15"): today, tomorrow and
/// yesterday by name, any other day as `Fri 6 Nov` (with the year when it is not this one), then
/// the time when the row has one.
fn friendly(stamp: crate::native::dates::Stamp, today: Date) -> String {
    use crate::native::dates::{clock, weekday_abbrev};
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let date = stamp.date;
    let day = match (date - today).get_days() {
        0 => "Today".to_owned(),
        1 => "Tomorrow".to_owned(),
        -1 => "Yesterday".to_owned(),
        _ => {
            let month = MONTHS[usize::try_from(date.month() - 1).unwrap_or(0)];
            let year = if date.year() == today.year() {
                String::new()
            } else {
                format!(" {}", date.year())
            };
            format!("{} {} {month}{year}", weekday_abbrev(date), date.day())
        }
    };
    match stamp.time {
        Some(time) => format!("{day} · {}", clock(time)),
        None => day,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_has_one_row() {
        for kind in Kind::ALL {
            let rows = TABLE.iter().filter(|entry| entry.kind == kind).count();
            assert_eq!(rows, 1, "{kind:?}");
        }
    }

    #[test]
    fn a_card_never_carries_a_sealed_value_and_every_app_is_one_the_chat_stores() {
        for entry in TABLE {
            assert!(centraid_vault::roster::is_app(entry.app.id()), "{entry:?}");
            assert!(App::from_id(entry.app.id()).is_some(), "{entry:?}");
        }
        // A Locker item's card holds its title and its type, the plain half of the row.
        let item = Row {
            kind: Kind::LockerItem,
            id: "i1".to_owned(),
            name: "Bank".to_owned(),
            date: None,
            fields: std::collections::BTreeMap::new(),
            trashed: false,
            created: String::new(),
            updated: String::new(),
            extra: std::collections::BTreeMap::from([("password", "lk1:x".to_owned())]),
        };
        let card = card_of(&item, Date::constant(2026, 10, 22)).expect("a Locker item has a card");
        assert!(!format!("{card:?}").contains("lk1:x"));
        assert_eq!(card.app, App::Locker);
    }

    #[test]
    fn a_transaction_card_names_money_opens_its_row_and_carries_the_signed_amount() {
        use crate::native::dates::Stamp;
        use std::collections::BTreeMap;
        let mut fields = BTreeMap::new();
        fields.insert("amount", Val::Money(-450, "USD".to_owned()));
        fields.insert("status", Val::Enum("posted"));
        let row = Row {
            kind: Kind::Transaction,
            id: "t1".to_owned(),
            name: "Blue Bottle".to_owned(),
            date: Stamp::parse("2026-09-26"),
            fields,
            trashed: false,
            created: String::new(),
            updated: String::new(),
            extra: BTreeMap::new(),
        };
        let card = card_of(&row, jiff::civil::date(2026, 9, 27)).expect("a transaction is drawn");
        assert_eq!((card.app, card.entity), (App::Money, "transaction"));
        assert_eq!(card.title, "Blue Bottle");
        assert_eq!(card.meta, "-4.50 USD");
        assert_eq!(
            card_kind(Kind::Transaction).map(|how| how.opens),
            Some(Opens::Row)
        );
    }

    fn blank(kind: Kind, name: &str) -> Row {
        Row {
            kind,
            id: "r1".to_owned(),
            name: name.to_owned(),
            date: None,
            fields: std::collections::BTreeMap::new(),
            trashed: false,
            created: String::new(),
            updated: String::new(),
            extra: std::collections::BTreeMap::new(),
        }
    }

    #[test]
    fn an_event_card_carries_its_span_and_its_place() {
        use crate::native::dates::Stamp;
        let today = Date::constant(2026, 11, 8);
        let mut row = blank(Kind::Event, "Lunch with Ana");
        row.date = Stamp::parse("2026-11-08T11:15:00");
        row.fields.insert("duration", Val::Num(75));
        row.extra.insert("place", "Café Lume".to_owned());
        assert_eq!(
            card_of(&row, today).unwrap().subtitle,
            "Today · 11:15 – 12:30 · Café Lume"
        );
        row.extra.clear();
        assert_eq!(
            card_of(&row, today).unwrap().subtitle,
            "Today · 11:15 – 12:30"
        );
        row.fields.clear();
        assert_eq!(card_of(&row, today).unwrap().subtitle, "Today · 11:15");
        row.date = Stamp::parse("2026-11-09");
        row.extra.insert("place", "Café Lume".to_owned());
        assert_eq!(
            card_of(&row, today).unwrap().subtitle,
            "Tomorrow · Café Lume"
        );
    }

    #[test]
    fn a_person_card_carries_their_role_and_a_near_birthday() {
        let today = Date::constant(2026, 11, 8);
        let mut row = blank(Kind::Person, "Ana Díaz");
        assert_eq!(card_of(&row, today).unwrap().subtitle, "");
        row.fields.insert("role", Val::Text("Landlord".to_owned()));
        assert_eq!(card_of(&row, today).unwrap().subtitle, "Landlord");
        for (born, said) in [
            ("11-08", "Landlord · birthday today"),
            ("1984-11-09", "Landlord · birthday tomorrow"),
            ("11-14", "Landlord · birthday Sat 14 Nov"),
            ("03-02", "Landlord"),
        ] {
            row.extra.insert("birthday", born.to_owned());
            assert_eq!(card_of(&row, today).unwrap().subtitle, said, "{born}");
        }
        row.fields.clear();
        row.extra.insert("birthday", "11-08".to_owned());
        assert_eq!(card_of(&row, today).unwrap().subtitle, "birthday today");
    }

    #[test]
    fn a_proposed_step_is_stored_as_a_card_a_reopened_thread_can_draw() {
        let step = crate::native_turn::CardStep {
            verb: "create".to_owned(),
            kind: "task".to_owned(),
            title: "Bring Ana a birthday card".to_owned(),
            summary: String::new(),
            when: "today 10:45".to_owned(),
            changes: String::new(),
            destructive: false,
        };
        let cards = step_cards(&[step]);
        assert_eq!(cards.len(), 1);
        let card = &cards[0];
        assert_eq!((card.app, card.entity), (App::Reminders, PROPOSAL_STEP));
        assert_eq!(
            (
                card.qualifier.as_str(),
                card.meta.as_str(),
                card.subtitle.as_str()
            ),
            ("create", "task", "today 10:45")
        );
    }

    #[test]
    fn a_card_says_its_day_in_words_and_a_person_has_none() {
        use crate::native::dates::Stamp;
        let today = Date::constant(2026, 11, 8);
        let at = |text: &str| friendly(Stamp::parse(text).unwrap(), today);
        assert_eq!(at("2026-11-08T16:00:00"), "Today · 16:00");
        assert_eq!(at("2026-11-09"), "Tomorrow");
        assert_eq!(at("2026-11-07"), "Yesterday");
        assert_eq!(at("2026-11-05 06:09"), "Thu 5 Nov · 06:09");
        assert_eq!(at("2027-01-02"), "Sat 2 Jan 2027");
    }
}
