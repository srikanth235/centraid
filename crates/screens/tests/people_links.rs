//! A person's page and its "Linked to" section (#1185): what the person is linked to from either
//! end, the picker over every kind but Locker, and the write through `people.link` / `unlink`
//! with its Undo. Over a real vault, through the door a shell uses.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use people_support::*;
use wire::link_event::Kind as L;
use wire::link_event::{AddTapped, Picked, RemoveTapped};
use wire::people_person_event::Kind as P;

fn link(d: &mut centraid_screens::testing::Driver, i: u64, kind: L) {
    send_person(d, i, P::Link(wire::LinkEvent { kind: Some(kind) }));
}

fn rows(d: &centraid_screens::testing::Driver, i: u64) -> Vec<(String, String)> {
    person_data(d.view(i))
        .links
        .as_ref()
        .expect("the Linked to section")
        .rows
        .iter()
        .map(|row| (row.title.clone(), row.meta.clone()))
        .collect()
}

/// Add the person `to` through the kit picker: the Add row, the kind, the item.
fn add(d: &mut centraid_screens::testing::Driver, i: u64, kind: &str, to: &str) {
    link(d, i, L::Add(AddTapped { key: "link".into() }));
    link(d, i, L::Pick(Picked { id: kind.into() }));
    link(d, i, L::Pick(Picked { id: to.into() }));
}

#[test]
fn the_page_lists_what_the_person_is_linked_to_and_a_pick_links_through_people_link() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let charles = person(&d, "Charles Babbage");
    let i = open_person(&mut d, &ada, "Ada Lovelace");
    assert!(rows(&d, i).is_empty());
    let section = person_data(d.view(i)).links.clone().expect("section");
    assert_eq!(section.title, "Linked to");
    assert_eq!(section.empty, "Nothing linked yet");
    assert_eq!(section.adds.len(), 1, "one Add link row for many kinds");

    link(&mut d, i, L::Add(AddTapped { key: "link".into() }));
    let picker = person_state(d.view(i))
        .link_picker
        .clone()
        .expect("chooser");
    assert!(picker.open);
    assert!(
        picker.candidates.iter().any(|row| row.id == "person"),
        "a person may link to another person"
    );
    link(
        &mut d,
        i,
        L::Pick(Picked {
            id: "person".into(),
        }),
    );
    let picker = person_state(d.view(i)).link_picker.clone().expect("people");
    assert!(picker.candidates.iter().any(|row| row.id == charles));
    assert!(
        picker.candidates.iter().all(|row| row.id != ada),
        "a person is never offered themselves"
    );
    link(
        &mut d,
        i,
        L::Pick(Picked {
            id: charles.clone(),
        }),
    );

    let state = person_state(d.view(i)).clone();
    assert!(state.link_picker.is_none_or(|picker| !picker.open));
    let status = state.status.expect("status");
    assert_eq!(status.sentence, "Linked");
    assert_eq!(status.action_label, "Undo");
    assert_eq!(
        rows(&d, i),
        [("Charles Babbage".to_owned(), "Person".to_owned())]
    );

    // The link has no direction: the other person's page lists this one.
    let j = open_person(&mut d, &charles, "Charles Babbage");
    assert_eq!(
        rows(&d, j),
        [("Ada Lovelace".to_owned(), "Person".to_owned())]
    );
}

#[test]
fn a_tap_on_remove_unlinks_and_undo_links_again() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let charles = person(&d, "Charles Babbage");
    let i = open_person(&mut d, &ada, "Ada Lovelace");
    add(&mut d, i, "person", &charles);
    assert_eq!(rows(&d, i).len(), 1);

    link(
        &mut d,
        i,
        L::Remove(RemoveTapped {
            id: charles.clone(),
        }),
    );
    assert!(rows(&d, i).is_empty());
    let status = person_state(d.view(i)).status.clone().expect("status");
    assert_eq!(status.sentence, "Link removed");
    assert_eq!(status.action_label, "Undo");

    d.send(
        i,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
    assert_eq!(rows(&d, i).len(), 1, "Undo puts the link back");
}

#[test]
fn a_person_can_link_to_a_note_and_the_row_says_what_it_is() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let note = id_of(&arrange(
        &d,
        centraid_screens::catalog::act::notes::CreateNote {
            title: "Engine sketch".to_owned(),
            body: "Gears and cards".to_owned(),
            ..Default::default()
        },
    ));
    let i = open_person(&mut d, &ada, "Ada Lovelace");
    add(&mut d, i, "note", &note);
    assert_eq!(
        rows(&d, i),
        [("Engine sketch".to_owned(), "Note".to_owned())]
    );
}

#[test]
fn a_note_that_links_to_the_person_from_its_own_end_shows_once_in_linked_to_not_in_the_vault() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let note = id_of(&arrange(
        &d,
        centraid_screens::catalog::act::notes::CreateNote {
            title: "Chess night".to_owned(),
            body: "with Ada".to_owned(),
            ..Default::default()
        },
    ));
    // The note's end of the link, as a `[[` link or the note's own Linked to would make it.
    arrange(
        &d,
        centraid_screens::catalog::act::notes::Link {
            from: note.clone(),
            to: ada.clone(),
            anchor: None,
        },
    );
    let i = open_person(&mut d, &ada, "Ada Lovelace");
    assert_eq!(
        rows(&d, i),
        [("Chess night".to_owned(), "Note".to_owned())],
        "the link is in Linked to"
    );
    assert!(
        person_data(d.view(i))
            .vault
            .iter()
            .all(|row| row.title != "Chess night"),
        "and is not shown a second time in In your vault"
    );
}
