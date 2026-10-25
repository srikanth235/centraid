//! WHERE A REFERENCE TO ONE ROW OPENS (R-CHROME-6).
//!
//! A row reference is an app, the row's noun in that app (`task`, `event`, `person`…), its id and
//! a second key. A chat card, a Home search hit and an import's "open" all land on the same screen
//! through this one table, which is the Rust form of the KMP `RowRoutes`:
//!
//! | app | entity | route |
//! |---|---|---|
//! | agenda | `task` | the task's detail |
//! | agenda | `project` | the project's list |
//! | agenda | `event` | the event's page (`qualifier` is the occurrence) |
//! | notes | `note` | the note's editor |
//! | notes | `notebook` | the library under that notebook |
//! | docs | `document` / `folder` | the document / the folder's page; `parent` is the pushing page's title |
//! | people | `person` | the person page |
//! | photos | `photo` | the lightbox, with the neighbours as its swipe |
//! | photos | `album` | the album's shelf |
//! | money | `transaction` | the transaction page |
//! | health | `workout` | the workout page |
//! | locker | `locker_item` | the item's page; a card with a member-action qualifier runs that action |
//! | chat | `thread` | none: a conversation opens in the Chat tab ([`is_thread`]) |
//!
//! An entity this table has no row for opens the app's home; an app it does not know is `None`.

use centraid_api_proto::core_v1 as wire;

/// A row reference in plain fields.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RowRef {
    pub app: String,
    pub entity: String,
    pub id: String,
    pub title: String,
    /// The second key some nouns need: an event's occurrence, a Locker card's member action.
    pub qualifier: String,
}

/// The kind of a Locker card's member action (#1135).
///
/// The assistant never holds a sealed value, so a reveal, a code or a secret to type is offered as
/// an ordinary card for a Locker item whose `qualifier` is `<action>:<column>`. It is parsed once,
/// here, at the card edge; a qualifier of any other shape is no action, so the card is the plain
/// "open the item" card, never a crash. The value a tap reveals is Locker's and never rides the chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemberAction {
    /// `reveal:<column>`: the item, and reveal that field.
    Reveal,
    /// `code:otp_seed`: the item, and show its one-time code.
    Code,
    /// `edit_secret:<column>`: Locker's editor on the item.
    EditSecret,
    /// `export:`: Locker's export; the card's item id may be empty.
    Export,
}

impl MemberAction {
    /// The action a Locker item card carries, or `None` for a card that is only a reference.
    #[must_use]
    pub fn parse(row: &RowRef) -> Option<Self> {
        if row.app != "locker" || row.entity != "locker_item" {
            return None;
        }
        let (word, column) = row
            .qualifier
            .split_once(':')
            .unwrap_or((&row.qualifier, ""));
        let kind = match word {
            "reveal" => Self::Reveal,
            "code" => Self::Code,
            "edit_secret" => Self::EditSecret,
            "export" => Self::Export,
            _ => return None,
        };
        if kind != Self::Export && (row.id.is_empty() || column.is_empty()) {
            return None;
        }
        Some(kind)
    }
}

/// Whether a reference names one of the member's conversations, which opens in the Chat tab and
/// is no route.
#[must_use]
pub fn is_thread(row: &RowRef) -> bool {
    row.app == "chat" && row.entity == "thread"
}

/// Where `row` opens. `parent` is the pushing page's title, which a pushed page's back says;
/// `neighbours` are the photographs a lightbox swipe walks, in the order they were shown.
#[must_use]
pub fn route_of(row: &RowRef, parent: &str, neighbours: &[String]) -> Option<wire::Route> {
    use crate::{agenda, docs, health, locker, money, notes, people, photos};
    let id = row.id.as_str();
    let title = row.title.as_str();
    match (row.app.as_str(), row.entity.as_str()) {
        ("agenda", "task") => Some(agenda::routes::task(id)),
        ("agenda", "project") => Some(agenda::routes::project(id, title)),
        ("agenda", "event") => Some(agenda::routes::event(id, &row.qualifier, None, "")),
        ("notes", "note") => Some(notes::routes::editor(id)),
        ("notes", "notebook") => Some(notes::routes::home(
            wire::NotesPlace::Notes,
            id,
            title,
            false,
        )),
        ("photos", "album") => Some(photos::routes::shelf(
            wire::PhotosShelfKind::Album,
            id,
            title,
        )),
        ("photos", "photo") => {
            let among: Vec<String> = if neighbours.is_empty() {
                vec![id.to_owned()]
            } else {
                neighbours.to_vec()
            };
            Some(photos::routes::lightbox(id, &among, ""))
        }
        ("docs", "folder") => Some(docs::routes::folder(id, title, parent)),
        ("docs", "document") => Some(docs::routes::document(id, title, parent)),
        ("people", "person") => Some(people::routes::person(id, title, false)),
        ("money", "transaction") => Some(money::routes::transaction(id, parent)),
        ("health", "workout") => Some(health::routes::workout(id, parent)),
        ("locker", "locker_item") => Some(match MemberAction::parse(row) {
            None => locker::routes::item(id, parent, ""),
            Some(MemberAction::Reveal | MemberAction::Code) => {
                locker::routes::item(id, parent, &row.qualifier)
            }
            Some(MemberAction::EditSecret) => locker::routes::edit(id),
            Some(MemberAction::Export) => locker::routes::export(parent),
        }),
        (app, _) => app_home(app),
    }
}

/// An app's own front door, for a reference whose noun has no row route.
#[must_use]
pub fn app_home(app: &str) -> Option<wire::Route> {
    use crate::{agenda, docs, health, locker, money, notes, people, photos};
    Some(match app {
        "agenda" => agenda::routes::home(wire::AgendaDestination::Day, ""),
        "notes" => notes::routes::home(wire::NotesPlace::Notes, "", "", false),
        "docs" => docs::routes::drive(wire::DocsDestination::All, "", "", ""),
        "people" => people::routes::home(wire::PeopleDestination::People),
        "photos" => photos::routes::home(wire::PhotosDestination::Library, None),
        "money" => money::routes::home(wire::MoneyDestination::Spending),
        "health" => health::routes::home(wire::HealthDestination::Today),
        "locker" => locker::routes::home(wire::LockerDestination::Items),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(app: &str, entity: &str, id: &str, qualifier: &str) -> RowRef {
        RowRef {
            app: app.to_owned(),
            entity: entity.to_owned(),
            id: id.to_owned(),
            title: "T".to_owned(),
            qualifier: qualifier.to_owned(),
        }
    }

    #[test]
    fn a_row_opens_its_own_page_and_an_unknown_noun_opens_the_apps_home() {
        let note = route_of(&row("notes", "note", "n1", ""), "", &[]).unwrap();
        assert_eq!(note.screen, "notes.editor");
        let book = route_of(&row("notes", "notebook", "nb", ""), "", &[]).unwrap();
        assert_eq!(book.screen, "notes.home");
        let odd = route_of(&row("people", "mystery", "x", ""), "", &[]).unwrap();
        assert_eq!(
            odd.screen,
            crate::people::routes::home(wire::PeopleDestination::People).screen
        );
        assert!(route_of(&row("nowhere", "thing", "x", ""), "", &[]).is_none());
    }

    #[test]
    fn a_photo_swipes_among_its_neighbours_or_alone() {
        let alone = route_of(&row("photos", "photo", "p1", ""), "", &[]).unwrap();
        let Some(wire::route::Args::PhotosLightbox(lightbox)) = alone.args else {
            panic!("a lightbox");
        };
        assert_eq!(lightbox.neighbour_ids, vec!["p1".to_owned()]);
        let among = route_of(
            &row("photos", "photo", "p2", ""),
            "",
            &["p1".to_owned(), "p2".to_owned()],
        )
        .unwrap();
        let Some(wire::route::Args::PhotosLightbox(lightbox)) = among.args else {
            panic!("a lightbox");
        };
        assert_eq!(lightbox.neighbour_ids.len(), 2);
    }

    #[test]
    fn a_member_action_parses_once_and_a_stranger_is_the_plain_item() {
        assert_eq!(
            MemberAction::parse(&row("locker", "locker_item", "i1", "reveal:card_number")),
            Some(MemberAction::Reveal)
        );
        assert_eq!(
            MemberAction::parse(&row("locker", "locker_item", "i1", "code:otp_seed")),
            Some(MemberAction::Code)
        );
        assert_eq!(
            MemberAction::parse(&row("locker", "locker_item", "", "export:")),
            Some(MemberAction::Export)
        );
        for none in [
            row("locker", "locker_item", "", "reveal:password"),
            row("agenda", "task", "t1", "reveal:password"),
            row("locker", "locker_item", "i1", ""),
            row("locker", "locker_item", "i1", "reveal:"),
        ] {
            assert_eq!(MemberAction::parse(&none), None, "{none:?}");
        }
        let follow = route_of(
            &row("locker", "locker_item", "i1", "code:otp_seed"),
            "Chat",
            &[],
        )
        .unwrap();
        let Some(wire::route::Args::LockerItem(item)) = follow.args else {
            panic!("an item");
        };
        assert_eq!(
            (item.follow.as_str(), item.parent.as_str()),
            ("code:otp_seed", "Chat")
        );
        let plain = route_of(&row("locker", "locker_item", "i1", "junk"), "Chat", &[]).unwrap();
        let Some(wire::route::Args::LockerItem(item)) = plain.args else {
            panic!("an item");
        };
        assert_eq!(item.follow, "");
        let edit = route_of(
            &row("locker", "locker_item", "i1", "edit_secret:cvv"),
            "",
            &[],
        )
        .unwrap();
        assert_eq!(edit.screen, "locker.editor");
        let export = route_of(&row("locker", "locker_item", "", "export:"), "Chat", &[]).unwrap();
        assert_eq!(export.screen, "locker.export");
    }

    #[test]
    fn a_conversation_is_no_route() {
        assert!(is_thread(&row("chat", "thread", "t", "")));
        assert!(route_of(&row("chat", "thread", "t", ""), "", &[]).is_none());
    }
}
