//! People's trash through the door a shell uses: the kit's one trash screen with
//! People's spec. Restore asks nothing, delete forever (`entity.purge`) is asked
//! first, there is no emptying, and a profile change re-reads the shelf.

mod people_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::people::{self, routes};
use people_support::*;
use wire::trash_event::Kind as T;

fn trash_of(v: &wire::ViewState) -> &wire::TrashView {
    match &v.kind {
        Some(wire::view_state::Kind::Trash(view)) => view,
        other => panic!("not the trash: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> Vec<wire::TrashRow> {
    match &trash_of(v).content {
        Some(wire::trash_view::Content::Data(data)) => data.rows.clone(),
        other => panic!("not the trash's data: {other:?}"),
    }
}

fn send(d: &mut centraid_screens::testing::Driver, i: u64, event: T) {
    d.send(
        i,
        wire::screen_event::Kind::Trash(wire::TrashEvent { kind: Some(event) }),
    );
}

/// Is this person on the open shelf? (The seed's own people are on it too.)
fn is_listed(d: &centraid_screens::testing::Driver, i: u64, id: &str) -> bool {
    rows(d.view(i)).iter().any(|row| row.id == id)
}

fn trashed_dana(d: &centraid_screens::testing::Driver) -> String {
    let id = person(d, "Dana");
    arrange(
        d,
        act::people::TrashPerson {
            person_id: id.clone(),
        },
    );
    id
}

#[test]
fn a_trashed_person_is_a_row_with_the_days_the_members_zone_reads() {
    let mut d = clean();
    let id = trashed_dana(&d);
    let i = d.push(people::TAB, routes::trash());
    let view = trash_of(d.view(i));
    assert_eq!(view.app_id, "people");
    assert_eq!(view.title, "Trash");
    assert_eq!(view.back_label, "People");
    let row = rows(d.view(i))
        .into_iter()
        .find(|row| row.id == id)
        .expect("her row");
    assert_eq!(row.title, "Dana");
    // The days are the core's civil days: "Deleted <day> · Erased <day>".
    assert!(row.meta.starts_with("Deleted "), "{}", row.meta);
    assert!(row.meta.contains(" · Erased "), "{}", row.meta);
    // DELETE FOREVER is `entity.purge`; there is no emptying.
    assert!(!row.purge_label.is_empty());
    assert!(!row.restore_label.is_empty());
    match &trash_of(d.view(i)).content {
        Some(wire::trash_view::Content::Data(data)) => assert_eq!(data.empty_label, ""),
        other => panic!("{other:?}"),
    }
}

#[test]
fn restore_asks_nothing_and_the_person_is_back_in_the_roster() {
    let mut d = clean();
    let id = trashed_dana(&d);
    let i = d.push(people::TAB, routes::trash());
    send(
        &mut d,
        i,
        T::Restore(wire::trash_event::RestoreTapped { id: id.clone() }),
    );
    assert!(!is_listed(&d, i, &id));
    assert_eq!(
        roster_of(&d)
            .people
            .iter()
            .map(|p| p.party_id.clone())
            .collect::<Vec<_>>(),
        [id]
    );
}

#[test]
fn delete_forever_is_asked_first_in_full_sentences_then_the_person_is_gone() {
    let mut d = clean();
    let id = trashed_dana(&d);
    let i = d.push(people::TAB, routes::trash());
    send(
        &mut d,
        i,
        T::Purge(wire::trash_event::PurgeTapped { id: id.clone() }),
    );
    let confirm = trash_of(d.view(i)).confirm.clone().expect("asked first");
    assert!(confirm.destructive);
    assert!(
        confirm
            .body
            .starts_with("Their profile, dates, notes and touches leave this vault for good.")
    );
    send(&mut d, i, T::Dismissed(wire::trash_event::Dismissed {}));
    assert!(is_listed(&d, i, &id), "dismissing wrote nothing");
    send(
        &mut d,
        i,
        T::Purge(wire::trash_event::PurgeTapped { id: id.clone() }),
    );
    send(&mut d, i, T::Confirmed(wire::trash_event::Confirmed {}));
    assert!(!is_listed(&d, i, &id));
    assert!(trash_of(d.view(i)).status.is_none());
}

#[test]
fn a_person_trashed_elsewhere_reaches_the_open_shelf() {
    let mut d = clean();
    let i = d.push(people::TAB, routes::trash());
    let id = person(&d, "Sam");
    assert!(!is_listed(&d, i, &id));
    arrange(
        &d,
        act::people::TrashPerson {
            person_id: id.clone(),
        },
    );
    d.pump(Duration::from_millis(400));
    assert!(is_listed(&d, i, &id));
}
