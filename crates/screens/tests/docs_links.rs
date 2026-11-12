//! A document's page and its "Linked to" section (#1185): what the document is linked to from
//! either end, the picker over every kind but Locker, and the write through `docs.add-about` /
//! `remove-about` with rel links, with its Undo. It is separate from About, which is people the
//! document is about. Over a real vault, through the door a shell uses.

mod docs_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::docs::{self, routes};
use centraid_screens::testing::Driver;
use docs_support::*;
use wire::docs_document_event::Kind as DD;
use wire::link_event::Kind as L;
use wire::link_event::{AddTapped, Picked, RemoveTapped};

fn open(d: &mut Driver, id: &str, title: &str) -> u64 {
    d.push(docs::TAB, routes::document(id, title, ""))
}

fn link(d: &mut Driver, i: u64, kind: L) {
    document_send(d, i, DD::Link(wire::LinkEvent { kind: Some(kind) }));
}

fn rows(d: &Driver, i: u64) -> Vec<(String, String)> {
    document_data(d.view(i))
        .links
        .as_ref()
        .expect("the Linked to section")
        .rows
        .iter()
        .map(|row| (row.title.clone(), row.meta.clone()))
        .collect()
}

fn add(d: &mut Driver, i: u64, kind: &str, to: &str) {
    link(d, i, L::Add(AddTapped { key: "link".into() }));
    link(d, i, L::Pick(Picked { id: kind.into() }));
    link(d, i, L::Pick(Picked { id: to.into() }));
}

#[test]
fn the_page_lists_what_the_document_is_linked_to_and_a_pick_links_through_the_docs_action() {
    let mut d = driver();
    let lease = text(&d, "Lease", "terms");
    let receipt = text(&d, "Receipt", "paid");
    let i = open(&mut d, &lease, "Lease");
    assert!(rows(&d, i).is_empty());
    let section = document_data(d.view(i)).links.clone().expect("section");
    assert_eq!(section.title, "Linked to");
    assert_eq!(section.empty, "Nothing linked yet");
    assert_eq!(section.adds.len(), 1, "one Add link row for many kinds");

    link(&mut d, i, L::Add(AddTapped { key: "link".into() }));
    let picker = document_state(d.view(i))
        .link_picker
        .clone()
        .expect("chooser");
    assert!(picker.open);
    assert!(
        picker.candidates.iter().any(|row| row.id == "document"),
        "a document may link to another document"
    );
    link(
        &mut d,
        i,
        L::Pick(Picked {
            id: "document".into(),
        }),
    );
    let picker = document_state(d.view(i))
        .link_picker
        .clone()
        .expect("documents");
    assert!(picker.candidates.iter().any(|row| row.id == receipt));
    assert!(
        picker.candidates.iter().all(|row| row.id != lease),
        "a document is never offered itself"
    );
    link(
        &mut d,
        i,
        L::Pick(Picked {
            id: receipt.clone(),
        }),
    );

    let state = document_state(d.view(i)).clone();
    assert!(state.link_picker.is_none_or(|picker| !picker.open));
    let status = state.status.expect("status");
    assert_eq!(status.sentence, "Linked");
    assert_eq!(status.action_label, "Undo");
    assert_eq!(rows(&d, i), [("Receipt".to_owned(), "Document".to_owned())]);
    // It is a link, not an about: the About section is untouched.
    assert!(
        document_data(d.view(i))
            .about
            .as_ref()
            .is_some_and(|about| about.rows.is_empty())
    );

    // The link has no direction: the other document's page lists this one.
    let there = open(&mut d, &receipt, "Receipt");
    assert_eq!(
        rows(&d, there),
        [("Lease".to_owned(), "Document".to_owned())]
    );
}

#[test]
fn a_tap_on_remove_unlinks_and_undo_links_again() {
    let mut d = driver();
    let lease = text(&d, "Lease", "terms");
    let receipt = text(&d, "Receipt", "paid");
    let i = open(&mut d, &lease, "Lease");
    add(&mut d, i, "document", &receipt);
    assert_eq!(rows(&d, i).len(), 1);

    link(
        &mut d,
        i,
        L::Remove(RemoveTapped {
            id: receipt.clone(),
        }),
    );
    assert!(rows(&d, i).is_empty());
    let status = document_state(d.view(i)).status.clone().expect("status");
    assert_eq!(status.sentence, "Link removed");
    assert_eq!(status.action_label, "Undo");

    d.send(
        i,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
    assert_eq!(rows(&d, i).len(), 1, "Undo puts the link back");
}

#[test]
fn a_document_in_the_trash_has_no_linked_section() {
    let mut d = driver();
    let lease = text(&d, "Lease", "terms");
    let i = open(&mut d, &lease, "Lease");
    assert!(document_data(d.view(i)).links.is_some());
    arrange(
        &d,
        centraid_screens::catalog::act::docs::Trash {
            document_id: lease.clone(),
        },
    );
    d.send(
        i,
        wire::screen_event::Kind::DataChanged(wire::DataChanged::default()),
    );
    assert!(
        document_data(d.view(i)).links.is_none(),
        "no section on a document in the trash"
    );
}
