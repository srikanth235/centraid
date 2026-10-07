//! A RESULT IS THE CHAT'S EXISTING CARD (R-1088-7): the kind to app and entity table.
//!
//! The runtime's rows are thirteen kinds; the chat's card names one of seven apps and an entity the
//! shell routes by. This is the one place that says which. A card is a reference (`app`,
//! `entity`, `id`) and a few words; the app's own tile draws the row.
//!
//! | kind | app | entity | a tap opens |
//! |---|---|---|---|
//! | person | people | `person` | the person |
//! | group | tally | `group` | Tally's home |
//! | event | agenda | `event` | the event |
//! | task | tasks | `task` | the task |
//! | note | notes | `note` | the note |
//! | document | docs | `document` | the document |
//! | photo | photos | `photo` | the lightbox |
//! | album | photos | `album` | Photos' home |
//! | debt | tally | `debt` | Tally's home |
//! | notebook | notes | `notebook` | Notes' home |
//! | folder | docs | `folder` | Docs' home |
//! | list | tasks | `project` | the project |
//! | locker item | none | none | never drawn: the Locker is off on the phone (R-1088-3) |
//!
//! The kinds with no row route open their app's home, which is what the shell does with any entity
//! it has no route for (`ChatRouting.appHome`): a tap that reached nothing would read as a broken
//! card. Giving one a route is a shell change and no schema change: `chat_message_card.entity` holds
//! any non-empty word, and `app` is one of the seven this table maps into.

use jiff::civil::Date;

use crate::native::meta::Kind;
use crate::native::world::{Row, Val};
use crate::result::Card;
use crate::tool::App;

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
pub const TABLE: [CardKind; 12] = [
    row(Kind::Person, App::People, "person"),
    home(Kind::Group, App::Tally, "group"),
    row(Kind::Event, App::Agenda, "event"),
    row(Kind::Task, App::Tasks, "task"),
    row(Kind::Note, App::Notes, "note"),
    row(Kind::Document, App::Docs, "document"),
    row(Kind::Photo, App::Photos, "photo"),
    home(Kind::Album, App::Photos, "album"),
    home(Kind::Debt, App::Tally, "debt"),
    home(Kind::Notebook, App::Notes, "notebook"),
    home(Kind::Folder, App::Docs, "folder"),
    row(Kind::List, App::Tasks, "project"),
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
    let state = match row.field("status") {
        Some(Val::Enum(status)) => (*status).to_owned(),
        _ => match (row.kind, row.field("amount")) {
            (Kind::Debt, Some(amount)) => amount.show(None),
            _ => String::new(),
        },
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
}
