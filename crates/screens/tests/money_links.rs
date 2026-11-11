//! A transaction's page and its "Linked to" section (#1185): what the line is linked to from
//! either end, the picker over every kind but Locker, and the write through `money.add-with` /
//! `remove-with` carrying rel links, with its Undo. It is separate from "With", which is who the
//! line was with. Over a real vault, through the door a shell uses.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::money::routes;
use centraid_screens::testing::Driver;
use money_support::*;
use wire::link_event::Kind as L;
use wire::link_event::{AddTapped, Picked, RemoveTapped};
use wire::money_transaction_event as te;

fn state(v: &wire::ViewState) -> &wire::MoneyTransactionState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyTransaction(s)) => s,
        other => panic!("not a transaction: {other:?}"),
    }
}

fn data(v: &wire::ViewState) -> &wire::MoneyTransactionData {
    match &state(v).content {
        Some(wire::money_transaction_state::Content::Data(d)) => d,
        other => panic!("no transaction data: {other:?}"),
    }
}

/// Two different lines of this month's Activity: the first's id, and the second's id and title
/// (the picker finds an item by what it is called).
fn two_lines(d: &mut Driver) -> (String, (String, String)) {
    let i = land_on(d, wire::MoneyDestination::Activity);
    let lines: Vec<(String, String)> = home_data(d.view(i))
        .activity
        .as_ref()
        .unwrap()
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .map(|row| (row.txn_id.clone(), row.title.clone()))
        .collect();
    assert!(lines.len() >= 2, "the seeded month has two lines");
    (lines[0].0.clone(), lines[1].clone())
}

fn open(d: &mut Driver, id: &str) -> u64 {
    push(d, routes::transaction(id, "Money"))
}

fn link(d: &mut Driver, i: u64, kind: L) {
    event(
        d,
        i,
        wire::screen_event::Kind::MoneyTransaction(wire::MoneyTransactionEvent {
            kind: Some(te::Kind::Link(wire::LinkEvent { kind: Some(kind) })),
        }),
    );
}

fn rows(d: &Driver, i: u64) -> Vec<(String, String)> {
    data(d.view(i))
        .links
        .as_ref()
        .expect("the Linked to section")
        .rows
        .iter()
        .map(|row| (row.title.clone(), row.meta.clone()))
        .collect()
}

/// Add `to` through the picker: the Add row, the kind, the name searched, the item.
fn add(d: &mut Driver, i: u64, kind: &str, to: &(String, String)) {
    link(d, i, L::Add(AddTapped { key: "link".into() }));
    link(d, i, L::Pick(Picked { id: kind.into() }));
    link(
        d,
        i,
        L::Query(wire::link_event::QueryChanged { text: to.1.clone() }),
    );
    link(d, i, L::Pick(Picked { id: to.0.clone() }));
}

#[test]
fn the_page_lists_what_the_line_is_linked_to_and_a_pick_links_it_apart_from_who_it_was_with() {
    let mut d = driver();
    let (first, (second, second_title)) = two_lines(&mut d);
    let i = open(&mut d, &first);
    assert!(rows(&d, i).is_empty());
    let section = data(d.view(i)).links.clone().expect("section");
    assert_eq!(section.title, "Linked to");
    assert_eq!(section.empty, "Nothing linked yet");
    assert_eq!(section.adds.len(), 1, "one Add link row for many kinds");

    link(&mut d, i, L::Add(AddTapped { key: "link".into() }));
    let picker = state(d.view(i)).link_picker.clone().expect("chooser");
    assert!(picker.open);
    assert!(
        picker.candidates.iter().any(|row| row.id == "transaction"),
        "a transaction may link to another transaction"
    );
    link(
        &mut d,
        i,
        L::Pick(Picked {
            id: "transaction".into(),
        }),
    );
    link(
        &mut d,
        i,
        L::Query(wire::link_event::QueryChanged {
            text: second_title.clone(),
        }),
    );
    let picker = state(d.view(i)).link_picker.clone().expect("transactions");
    assert!(picker.candidates.iter().any(|row| row.id == second));
    assert!(
        picker.candidates.iter().all(|row| row.id != first),
        "a line is never offered itself"
    );
    link(&mut d, i, L::Pick(Picked { id: second.clone() }));

    let current = state(d.view(i)).clone();
    assert!(current.link_picker.is_none_or(|picker| !picker.open));
    let status = current.status.expect("status");
    assert_eq!(status.sentence, "Linked");
    assert_eq!(status.action_label, "Undo");
    assert_eq!(rows(&d, i).len(), 1);
    assert_eq!(rows(&d, i)[0].1, "Transaction");
    let with = data(d.view(i))
        .facts
        .iter()
        .find(|fact| fact.label == "With")
        .map(|fact| fact.detail.clone());
    assert_eq!(
        with.as_deref(),
        Some("No one"),
        "a link is not who it was with"
    );

    // The link has no direction: the other line lists this one.
    let there = open(&mut d, &second);
    assert_eq!(rows(&d, there).len(), 1);
}

#[test]
fn a_tap_on_remove_unlinks_a_line_and_undo_links_it_again() {
    let mut d = driver();
    let (first, second) = two_lines(&mut d);
    let i = open(&mut d, &first);
    add(&mut d, i, "transaction", &second);
    assert_eq!(rows(&d, i).len(), 1);

    link(
        &mut d,
        i,
        L::Remove(RemoveTapped {
            id: second.0.clone(),
        }),
    );
    assert!(rows(&d, i).is_empty());
    let status = state(d.view(i)).status.clone().expect("status");
    assert_eq!(status.sentence, "Link removed");
    assert_eq!(status.action_label, "Undo");

    event(
        &mut d,
        i,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
    assert_eq!(rows(&d, i).len(), 1, "Undo puts the link back");
}
