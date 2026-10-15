//! A RESULT IS THE CHAT'S EXISTING CARD (R-1088-7): the kind to app and entity table.
//!
//! The runtime's rows are twelve kinds; the chat's card names one of seven apps (Money's is the
//! seventh, since rung fifteen) and an entity the
//! shell routes by. This is the one place that says which. A card is a reference (`app`,
//! `entity`, `id`) and a few words; the app's own tile draws the row.
//!
//! | kind | app | entity | a tap opens |
//! |---|---|---|---|
//! | person | people | `person` | the person |
//! | event | agenda | `event` | the event |
//! | task | tasks | `task` | the task |
//! | note | notes | `note` | the note |
//! | document | docs | `document` | the document |
//! | photo | photos | `photo` | the lightbox |
//! | album | photos | `album` | the album's shelf |
//! | notebook | notes | `notebook` | the library under that notebook |
//! | folder | docs | `folder` | the folder's page |
//! | list | tasks | `project` | the project |
//! | transaction | money | `transaction` | Money's home (no row route yet) |
//! | locker item | none | none | never drawn: the Locker is off on the phone (R-1088-3) |
//!
//! The album, notebook and folder routes are the shell's since the containers became search results
//! (#1097, `ChatRouting.swift`): the card's `id` is the container's id and its `title` the name the route needs.
//! The kinds with no row route open their app's home, which is what the shell does with any entity
//! it has no route for (`ChatRouting.appHome`): a tap that reached nothing would read as a broken
//! card. Giving one a route is a shell change and no schema change: `chat_message_card.entity` holds
//! any non-empty word, and `app` is one of the seven this table maps into.

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

/// THE TABLE. Every kind but the Locker item.
pub const TABLE: [CardKind; 11] = [
    row(Kind::Person, App::People, "person"),
    row(Kind::Event, App::Agenda, "event"),
    row(Kind::Task, App::Tasks, "task"),
    row(Kind::Note, App::Notes, "note"),
    row(Kind::Document, App::Docs, "document"),
    row(Kind::Photo, App::Photos, "photo"),
    row(Kind::Album, App::Photos, "album"),
    row(Kind::Notebook, App::Notes, "notebook"),
    row(Kind::Folder, App::Docs, "folder"),
    row(Kind::List, App::Tasks, "project"),
    home(Kind::Transaction, App::Money, "transaction"),
];

/// How a kind is drawn, or `None` for the one that is never drawn.
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
pub fn card_of(row: &Row, _today: Date) -> Option<Card> {
    let how = card_kind(row.kind)?;
    let mut card = Card::new(how.app, how.entity, row.id.clone(), row.name.clone());
    if let Some(stamp) = row.date {
        card = card.subtitle(stamp.show());
    }
    // A transaction's one word is what it moved: `-42.00 USD`.
    let state = match (row.kind, row.field("amount"), row.field("status")) {
        (Kind::Transaction, Some(amount), _) => amount.show(None),
        (_, _, Some(Val::Enum(status))) => (*status).to_owned(),
        _ => String::new(),
    };
    Some(card.meta(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell's routes, as the iOS file states them: the entities it opens by row.
    const ROUTING: &str = include_str!("../../../../mobile/iosApp/Sources/Chat/ChatRouting.swift");

    #[test]
    fn every_kind_but_the_locker_item_has_one_row_and_the_locker_item_has_none() {
        for kind in Kind::ALL {
            let rows = TABLE.iter().filter(|entry| entry.kind == kind).count();
            if kind == Kind::LockerItem {
                assert_eq!(rows, 0);
                assert!(card_kind(kind).is_none() && app_of(kind).is_none());
            } else {
                assert_eq!(rows, 1, "{kind:?}");
            }
        }
    }

    #[test]
    fn no_card_names_locker_and_every_app_is_one_the_chat_stores() {
        for entry in TABLE {
            assert_ne!(entry.app.id(), "locker");
            assert!(App::from_id(entry.app.id()).is_some(), "{entry:?}");
        }
    }

    #[test]
    fn the_shells_row_routes_are_exactly_the_entries_that_open_a_row() {
        for entry in TABLE {
            let route = format!("(\"{}\", \"{}\")", entry.app.id(), entry.entity);
            assert_eq!(
                ROUTING.contains(&route),
                entry.opens == Opens::Row,
                "{} {}: ChatRouting.swift and the table disagree about whether a tap opens the row",
                entry.app.id(),
                entry.entity
            );
        }
    }
    #[test]
    fn a_transaction_card_names_money_opens_its_home_and_carries_the_signed_amount() {
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
            Some(Opens::AppHome)
        );
    }
}
