//! WHERE A ROW GOES (#1135): the one table that turns "this thing in that app"
//! into the page that opens it, as a [`wire::Route`] a shell pushes. A search
//! hit, a chat card and an app's own "open this" all land here, so the three
//! cannot send the same row to three pages. A shell never names a destination.
//!
//! An app's own pages are its `routes` module's; this file only chooses between
//! them by `(app, entity)`. A row of an app the shell has no page for opens that
//! app's home, and a row of no app opens nothing.

use centraid_api_proto::core_v1 as wire;

use crate::{agenda, docs, health, locker, money, notes, people, photos};

/// A row to open: the app it lives in, what kind of thing it is, its id, its
/// title (which rides to the page's head so it has words before its read lands)
/// and a qualifier (an occurrence's instance key, a Locker member action).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RowRef {
    pub app: String,
    pub entity: String,
    pub id: String,
    pub title: String,
    pub qualifier: String,
}

impl RowRef {
    #[must_use]
    pub fn new(app: &str, entity: &str, id: &str, title: &str) -> Self {
        Self {
            app: app.to_owned(),
            entity: entity.to_owned(),
            id: id.to_owned(),
            title: title.to_owned(),
            qualifier: String::new(),
        }
    }
}

/// An app's home, landing on its default place; `None` for an id that is no app.
#[must_use]
pub fn app_home(app: &str) -> Option<wire::Route> {
    Some(match app {
        "agenda" => agenda::routes::home(wire::AgendaDestination::Day, ""),
        "docs" => docs::routes::drive(wire::DocsDestination::All, "", "", ""),
        "health" => health::routes::home(wire::HealthDestination::Today),
        "locker" => locker::routes::home(wire::LockerDestination::Items),
        "money" => money::routes::home(wire::MoneyDestination::Spending),
        "notes" => notes::routes::home(wire::NotesPlace::Notes, "", "", false),
        "people" => people::routes::home(wire::PeopleDestination::People),
        "photos" => photos::routes::home(wire::PhotosDestination::Library, None),
        _ => return None,
    })
}

/// The page that opens `row`. `parent` is the pushing page's title (a back
/// label); `among` are the rows beside it, whose photographs a lightbox pages
/// through.
#[must_use]
pub fn route(row: &RowRef, parent: &str, among: &[RowRef]) -> Option<wire::Route> {
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
            let mut neighbours: Vec<String> = among
                .iter()
                .filter(|other| other.app == "photos" && other.entity == "photo")
                .map(|other| other.id.clone())
                .collect();
            if neighbours.is_empty() {
                neighbours.push(id.to_owned());
            }
            Some(photos::routes::lightbox(id, &neighbours, ""))
        }
        ("docs", "folder") => Some(docs::routes::folder(id, title, parent)),
        ("docs", "document") => Some(docs::routes::document(id, title, parent)),
        ("people", "person") => Some(people::routes::person(id, title, false)),
        ("money", "transaction") => Some(money::routes::transaction(id, parent)),
        ("health", "workout") => Some(health::routes::workout(id, parent)),
        ("locker", "locker_item") => Some(locker_item(row, parent)),
        // A kind with no page of its own opens its app. Locker is the exception: a
        // row it does not name is not a reason to open the vault's secrets.
        ("locker", _) => None,
        (app, _) => app_home(app),
    }
}

/// A Locker item, or the member action a chat card asks of it
/// (`reveal:password`, `code:totp`, `edit_secret:password`, `export:`).
fn locker_item(row: &RowRef, parent: &str) -> wire::Route {
    let (word, column) = row
        .qualifier
        .split_once(':')
        .unwrap_or((row.qualifier.as_str(), ""));
    match word {
        "reveal" | "code" if !row.id.is_empty() && !column.is_empty() => {
            locker::routes::item(&row.id, parent, &row.qualifier)
        }
        "edit_secret" if !row.id.is_empty() && !column.is_empty() => locker::routes::edit(&row.id),
        "export" => locker::routes::export(parent),
        _ => locker::routes::item(&row.id, parent, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(route: Option<wire::Route>) -> String {
        route.map(|route| route.screen).unwrap_or_default()
    }

    #[test]
    fn every_app_has_a_home_and_a_stranger_has_none() {
        for app in super::super::policy::ORDER {
            assert!(app_home(app).is_some(), "{app} has no home route");
        }
        assert!(app_home("chat").is_none());
        assert!(app_home("tasks").is_none());
    }

    #[test]
    fn a_row_opens_the_page_of_its_own_kind() {
        let open =
            |app: &str, entity: &str| screen(route(&RowRef::new(app, entity, "x", "T"), "", &[]));
        assert_eq!(open("agenda", "task"), agenda::TASK);
        assert_eq!(open("notes", "note"), notes::EDITOR);
        assert_eq!(open("docs", "document"), docs::DOCUMENT);
        assert_eq!(open("people", "person"), people::PERSON);
        assert_eq!(open("photos", "photo"), photos::LIGHTBOX);
        assert_eq!(open("money", "transaction"), money::TRANSACTION);
        assert_eq!(open("health", "workout"), health::WORKOUT);
        // A kind with no page of its own opens the app.
        assert_eq!(open("agenda", "nonsense"), agenda::HOME);
        assert_eq!(open("chat", "thread"), "");
    }

    #[test]
    fn notes_rows_route_by_their_kind_a_note_to_its_editor_a_notebook_to_the_home_filtered_to_it() {
        let note = route(&RowRef::new("notes", "note", "n1", "Plans"), "", &[]).unwrap();
        let Some(wire::route::Args::NotesEditor(editor)) = note.args else {
            panic!("not an editor");
        };
        assert_eq!(editor.note_id, "n1");
        let book = route(&RowRef::new("notes", "notebook", "nb", "Cabin"), "", &[]).unwrap();
        let Some(wire::route::Args::NotesHome(home)) = book.args else {
            panic!("not a home");
        };
        assert_eq!(
            (home.notebook_id.as_str(), home.notebook_name.as_str()),
            ("nb", "Cabin")
        );
        assert_eq!(app_home("notes").unwrap().screen, notes::HOME);
    }

    #[test]
    fn docs_rows_carry_the_pushing_pages_title_as_their_back_word() {
        let folder = route(&RowRef::new("docs", "folder", "f1", "Taxes"), "Search", &[]).unwrap();
        let Some(wire::route::Args::DocsDrive(drive)) = folder.args else {
            panic!("not a drive");
        };
        assert_eq!(drive.destination, wire::DocsDestination::Folders as i32);
        assert_eq!(
            (
                drive.folder_id.as_str(),
                drive.folder_name.as_str(),
                drive.parent.as_str()
            ),
            ("f1", "Taxes", "Search")
        );
        assert_eq!(
            route(
                &RowRef::new("docs", "document", "d1", "Lease"),
                "Search",
                &[]
            ),
            Some(docs::routes::document("d1", "Lease", "Search"))
        );
    }

    #[test]
    fn agenda_rows_route_by_their_kind_and_an_occurrence_carries_its_instance() {
        let task = route(&RowRef::new("agenda", "task", "t1", ""), "", &[]).unwrap();
        assert_eq!(task, agenda::routes::task("t1"));
        let project = route(&RowRef::new("agenda", "project", "p1", "Garden"), "", &[]).unwrap();
        assert_eq!(project, agenda::routes::project("p1", "Garden"));
        let mut row = RowRef::new("agenda", "event", "e1", "");
        row.qualifier = "2026-10-17".to_owned();
        let event = route(&row, "", &[]).unwrap();
        let Some(wire::route::Args::AgendaEvent(args)) = event.args else {
            panic!("not an event");
        };
        assert_eq!(
            (args.event_id.as_str(), args.instance_key.as_str()),
            ("e1", "2026-10-17")
        );
        // A kind with no page opens Agenda's home, on Day.
        let home = route(&RowRef::new("agenda", "tag", "x", ""), "", &[]).unwrap();
        let Some(wire::route::Args::AgendaHome(args)) = home.args else {
            panic!("not a home");
        };
        assert_eq!(args.destination, wire::AgendaDestination::Day as i32);
    }

    #[test]
    fn health_and_people_rows_and_the_apps_that_open_their_home() {
        assert_eq!(
            route(&RowRef::new("health", "workout", "w1", ""), "Today", &[]),
            Some(health::routes::workout("w1", "Today"))
        );
        // A day's total has no page of its own: it opens Health's front door.
        assert_eq!(
            route(
                &RowRef::new("health", "daily_figure", "2026-10-20", ""),
                "",
                &[]
            )
            .unwrap()
            .screen,
            health::HOME
        );
        assert_eq!(
            route(&RowRef::new("people", "tag", "x", ""), "", &[]),
            app_home("people")
        );
        assert!(route(&RowRef::new("money", "tag", "x", ""), "", &[]).is_some());
        assert!(route(&RowRef::new("photos", "tag", "x", ""), "", &[]).is_some());
        assert!(route(&RowRef::new("weather", "forecast", "x", ""), "", &[]).is_none());
        // A row Locker does not name is not a reason to open it.
        assert!(route(&RowRef::new("locker", "tag", "x", ""), "", &[]).is_none());
        // The tile's own door is the Locker's home.
        assert_eq!(app_home("locker").unwrap().screen, locker::HOME);
    }

    #[test]
    fn a_container_opens_where_its_app_opens_it() {
        let cases = [
            ("notes", "notebook", notes::HOME),
            ("photos", "album", photos::SHELF),
            ("agenda", "project", agenda::PROJECT),
            ("docs", "folder", docs::DRIVE),
        ];
        for (app, entity, screen) in cases {
            let opened = route(&RowRef::new(app, entity, "c1", "Cabin"), "", &[]).unwrap();
            assert_eq!(opened.screen, screen, "{app} {entity}");
        }
    }

    #[test]
    fn a_lightbox_pages_through_the_photographs_beside_it() {
        let row = RowRef::new("photos", "photo", "b", "");
        let among = [
            RowRef::new("photos", "photo", "a", ""),
            RowRef::new("notes", "note", "n", ""),
            RowRef::new("photos", "photo", "b", ""),
        ];
        let Some(wire::Route {
            args: Some(wire::route::Args::PhotosLightbox(lightbox)),
            ..
        }) = route(&row, "", &among)
        else {
            panic!("not a lightbox");
        };
        assert_eq!(lightbox.neighbour_ids, vec!["a", "b"]);
        // Alone, it pages through itself.
        let Some(wire::Route {
            args: Some(wire::route::Args::PhotosLightbox(lightbox)),
            ..
        }) = route(&row, "", &[])
        else {
            panic!("not a lightbox");
        };
        assert_eq!(lightbox.neighbour_ids, vec!["b"]);
    }

    #[test]
    fn a_locker_member_action_picks_the_page_that_performs_it() {
        let mut row = RowRef::new("locker", "locker_item", "i1", "Bank");
        assert_eq!(screen(route(&row, "", &[])), locker::ITEM);
        row.qualifier = "reveal:password".to_owned();
        let Some(wire::Route {
            args: Some(wire::route::Args::LockerItem(item)),
            ..
        }) = route(&row, "", &[])
        else {
            panic!("not an item");
        };
        assert_eq!(item.follow, "reveal:password");
        row.qualifier = "edit_secret:password".to_owned();
        assert_eq!(screen(route(&row, "", &[])), locker::EDITOR);
        row.qualifier = "export:".to_owned();
        assert_eq!(screen(route(&row, "", &[])), locker::EXPORT);
        // A reveal naming no column is only the item.
        // no action, an unknown one, or one with no field: the plain card, never a crash
        for plain in [
            "",
            "wipe:password",
            "reveal:",
            "reveal",
            ":password",
            "2026-10-08",
        ] {
            row.qualifier = plain.to_owned();
            let Some(wire::Route {
                args: Some(wire::route::Args::LockerItem(item)),
                ..
            }) = route(&row, "Chat", &[])
            else {
                panic!("not an item for `{plain}`");
            };
            assert!(item.follow.is_empty(), "`{plain}` follows nothing");
            assert_eq!(item.parent, "Chat");
        }
        row.qualifier = "reveal:".to_owned();
        let Some(wire::Route {
            args: Some(wire::route::Args::LockerItem(item)),
            ..
        }) = route(&row, "", &[])
        else {
            panic!("not an item");
        };
        assert!(item.follow.is_empty());
    }
}
