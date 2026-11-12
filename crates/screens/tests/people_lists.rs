//! People's lists through the door a shell uses: a list is made, renamed and moved to the trash from
//! its own page, it is a row of People's trash called a list, and a restore brings it back with its
//! people in it again (#1185).

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::people::{self, routes};
use centraid_screens::testing::Driver;
use people_support::*;
use wire::people_lists_event::{self as ev, Kind as L};
use wire::trash_event::Kind as T;

fn lists_state(v: &wire::ViewState) -> &wire::PeopleListsState {
    match &v.kind {
        Some(wire::view_state::Kind::PeopleLists(state)) => state,
        other => panic!("not the lists page: {other:?}"),
    }
}

fn lists_data(v: &wire::ViewState) -> &wire::PeopleListsData {
    match &lists_state(v).content {
        Some(wire::people_lists_state::Content::Data(data)) => data,
        other => panic!("not the lists' data: {other:?}"),
    }
}

/// The names drawn; none while the page is empty (no list yet has no data).
fn names(d: &Driver, i: u64) -> Vec<String> {
    match &lists_state(d.view(i)).content {
        Some(wire::people_lists_state::Content::Data(data)) => {
            data.rows.iter().map(|row| row.name.clone()).collect()
        }
        None => Vec::new(),
    }
}

fn send_lists(d: &mut Driver, i: u64, event: L) {
    d.send(
        i,
        wire::screen_event::Kind::PeopleLists(wire::PeopleListsEvent { kind: Some(event) }),
    );
}

fn type_name(d: &mut Driver, i: u64, text: &str) {
    send_lists(
        d,
        i,
        L::NameChanged(ev::NameChanged {
            text: text.to_owned(),
        }),
    );
}

fn status(d: &Driver, i: u64) -> Option<wire::StatusLine> {
    lists_state(d.view(i)).status.clone()
}

/// The lists page, pushed from People's home as its More row does.
fn open(d: &mut Driver) -> u64 {
    d.push(people::TAB, routes::lists("People"))
}

fn made(d: &Driver, title: &str) -> String {
    id_of(&arrange(
        d,
        act::people::CreateList {
            title: title.to_owned(),
            id: None,
        },
    ))
}

fn trash_of(v: &wire::ViewState) -> &wire::TrashView {
    match &v.kind {
        Some(wire::view_state::Kind::Trash(view)) => view,
        other => panic!("not the trash: {other:?}"),
    }
}

fn trash_rows(v: &wire::ViewState) -> Vec<wire::TrashRow> {
    let view = trash_of(v);
    match &view.content {
        Some(wire::trash_view::Content::Data(data)) => data.rows.clone(),
        // A trash with nothing in it is the empty page and carries no rows.
        None if matches!(
            view.page.as_ref().and_then(|page| page.state.as_ref()),
            Some(wire::page_state::State::Empty(_))
        ) =>
        {
            Vec::new()
        }
        other => panic!("not the trash's data: {other:?}"),
    }
}

fn send_trash(d: &mut Driver, i: u64, event: T) {
    d.send(
        i,
        wire::screen_event::Kind::Trash(wire::TrashEvent { kind: Some(event) }),
    );
}

fn listed(d: &Driver, i: u64, id: &str) -> bool {
    trash_rows(d.view(i)).iter().any(|row| row.id == id)
}

#[test]
fn more_reaches_the_lists_page() {
    let mut d = clean();
    let home = begin(&mut d);
    let more = &home_state(d.view(home)).more_rows;
    let row = more.iter().find(|row| row.key == "lists").expect("Lists");
    assert_eq!(
        (row.label.as_str(), row.icon_key.as_str()),
        ("Lists", "List")
    );
    let route = row.route.clone().expect("a route");
    assert_eq!(route.screen, "people.lists");
    let i = d.push(people::TAB, route);
    assert_eq!(lists_state(d.view(i)).back_label, "People");
}

#[test]
fn a_list_is_made_renamed_and_moved_to_the_trash_from_its_page() {
    let mut d = clean();
    let i = open(&mut d);
    let state = lists_state(d.view(i));
    assert_eq!(state.add_label, "New list");
    // No list yet is the page's own empty state, never ready data.
    assert!(state.content.is_none());
    let Some(wire::page_state::State::Empty(empty)) =
        state.page.as_ref().and_then(|page| page.state.as_ref())
    else {
        panic!("no lists yet is the empty state: {:?}", state.page);
    };
    assert_eq!(empty.headline, "No lists yet");

    // MAKE: a name arms it.
    send_lists(&mut d, i, L::NewTapped(ev::NewTapped {}));
    let sheet = lists_state(d.view(i)).sheet.clone().expect("the sheet");
    assert_eq!(
        (sheet.title.as_str(), sheet.submit_label.as_str()),
        ("New list", "Create")
    );
    assert!(!sheet.can_submit && sheet.trash_label.is_none());
    send_lists(&mut d, i, L::Submitted(ev::Submitted {}));
    assert!(lists_state(d.view(i)).sheet.is_some(), "no name, no list");
    type_name(&mut d, i, "  Family ");
    assert!(lists_state(d.view(i)).sheet.as_ref().unwrap().can_submit);
    send_lists(&mut d, i, L::Submitted(ev::Submitted {}));
    assert!(lists_state(d.view(i)).sheet.is_none());
    assert_eq!(names(&d, i), ["Family"]);
    assert_eq!(status(&d, i).expect("said").sentence, "Family created");
    let family = lists_data(d.view(i)).rows[0].clone();
    assert_eq!(family.meta, "0 people");

    // A person filed in it counts.
    let ada = person(&d, "Ada");
    arrange(
        &d,
        act::people::MovePerson {
            person_id: ada.clone(),
            list_id: Some(family.list_id.clone()),
        },
    );
    refresh(&mut d, i);
    let family = lists_data(d.view(i)).rows[0].clone();
    assert_eq!(
        (family.meta.as_str(), family.accessibility_label.as_str()),
        ("1 person", "Family, 1 person")
    );

    // RENAME: the sheet opens on the list, and Save writes the new name.
    send_lists(
        &mut d,
        i,
        L::RowTapped(ev::RowTapped {
            list_id: family.list_id.clone(),
        }),
    );
    let sheet = lists_state(d.view(i)).sheet.clone().expect("the sheet");
    assert_eq!(
        (
            sheet.title.as_str(),
            sheet.name.as_str(),
            sheet.submit_label.as_str(),
            sheet.trash_label.as_deref()
        ),
        ("Rename list", "Family", "Save", Some("Move to trash"))
    );
    // A name left alone writes nothing and closes.
    send_lists(&mut d, i, L::Submitted(ev::Submitted {}));
    assert!(lists_state(d.view(i)).sheet.is_none());
    send_lists(
        &mut d,
        i,
        L::RowTapped(ev::RowTapped {
            list_id: family.list_id.clone(),
        }),
    );
    type_name(&mut d, i, "Kin");
    send_lists(&mut d, i, L::Submitted(ev::Submitted {}));
    assert_eq!(names(&d, i), ["Kin"]);
    assert_eq!(status(&d, i).expect("said").sentence, "Renamed to Kin");

    // MOVE TO TRASH: no confirm, the people are not touched, and the line carries Undo.
    send_lists(
        &mut d,
        i,
        L::RowTapped(ev::RowTapped {
            list_id: family.list_id.clone(),
        }),
    );
    send_lists(&mut d, i, L::TrashTapped(ev::TrashTapped {}));
    assert!(lists_state(d.view(i)).sheet.is_none());
    assert!(names(&d, i).is_empty());
    let line = status(&d, i).expect("said");
    assert_eq!(
        (
            line.sentence.as_str(),
            line.action_label.as_str(),
            line.refused
        ),
        ("Kin moved to trash", "Undo", false)
    );
    assert!(
        roster_of(&d)
            .people
            .iter()
            .any(|row| row.party_id == ada && row.list_id.is_none()),
        "Ada is still in People, in no list while it is in the trash"
    );

    // UNDO restores it, with Ada in it again.
    d.send(
        i,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
    assert_eq!(names(&d, i), ["Kin"]);
    assert_eq!(lists_data(d.view(i)).rows[0].meta, "1 person");
    let line = status(&d, i).expect("Undone is said");
    assert_eq!(line.sentence, "Undone");
    assert!(line.action_label.is_empty());
}

#[test]
fn a_list_in_the_trash_is_called_a_list_and_comes_back_with_its_people() {
    let mut d = clean();
    let family = made(&d, "Family");
    let ada = person(&d, "Ada");
    arrange(
        &d,
        act::people::MovePerson {
            person_id: ada.clone(),
            list_id: Some(family.clone()),
        },
    );
    arrange(
        &d,
        act::people::DeleteList {
            people_list_id: family.clone(),
        },
    );
    let i = d.push(people::TAB, routes::trash());
    let row = trash_rows(d.view(i))
        .into_iter()
        .find(|row| row.id == family)
        .expect("the list is a row of People's trash");
    assert_eq!(row.title, "Family");
    assert!(row.meta.starts_with("Deleted "), "{}", row.meta);

    // Delete forever names it a list and says nothing of a person's profile.
    send_trash(
        &mut d,
        i,
        T::Purge(wire::trash_event::PurgeTapped { id: family.clone() }),
    );
    let confirm = trash_of(d.view(i)).confirm.clone().expect("asked first");
    assert_eq!(confirm.title, "Delete this list forever?");
    assert!(
        !confirm.body.contains("profile"),
        "the person's sentence is not a list's: {}",
        confirm.body
    );
    send_trash(&mut d, i, T::Dismissed(wire::trash_event::Dismissed {}));

    // RESTORE brings it back, and Ada is in it again.
    send_trash(
        &mut d,
        i,
        T::Restore(wire::trash_event::RestoreTapped { id: family.clone() }),
    );
    assert!(!listed(&d, i, &family));
    let roster = roster_of(&d);
    assert!(roster.lists.iter().any(|list| list.list_id == family));
    assert!(
        roster
            .people
            .iter()
            .any(|row| row.party_id == ada && row.list_id.as_deref() == Some(family.as_str()))
    );
}

#[test]
fn delete_forever_and_empty_trash_take_the_lists_in_the_trash_with_the_people() {
    let mut d = clean();
    let kept = made(&d, "Work");
    let doomed = made(&d, "Family");
    let dana = person(&d, "Dana");
    for id in [&kept, &doomed] {
        arrange(
            &d,
            act::people::DeleteList {
                people_list_id: id.clone(),
            },
        );
    }
    let i = d.push(people::TAB, routes::trash());
    // DELETE FOREVER on one list.
    send_trash(
        &mut d,
        i,
        T::Purge(wire::trash_event::PurgeTapped { id: doomed.clone() }),
    );
    send_trash(&mut d, i, T::Confirmed(wire::trash_event::Confirmed {}));
    assert!(!listed(&d, i, &doomed));
    assert!(listed(&d, i, &kept));
    assert!(trash_of(d.view(i)).status.is_none());

    // EMPTY TRASH takes the rest: the list and the person.
    arrange(
        &d,
        act::people::TrashPerson {
            person_id: dana.clone(),
        },
    );
    send_trash(&mut d, i, T::Refreshed(wire::trash_event::Refreshed {}));
    assert!(listed(&d, i, &dana) && listed(&d, i, &kept));
    send_trash(&mut d, i, T::Empty(wire::trash_event::EmptyTapped {}));
    send_trash(&mut d, i, T::Confirmed(wire::trash_event::Confirmed {}));
    assert!(trash_rows(d.view(i)).is_empty());
    assert!(trash_of(d.view(i)).status.is_none());
}
