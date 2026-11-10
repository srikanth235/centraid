//! EARLIER VERSIONS of a person (#1185): the entry at the foot of the page with its count, the
//! kit's one screen listing what the person was, Restore with no confirm, Undo, who made a change
//! in the member's words, and a read that fails saying so. Every test goes through `Driver`, over a
//! vault seeded at a fixed instant.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::people;
use centraid_screens::testing::Driver;
use people_support::*;
use serde_json::json;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn driver() -> Driver {
    let mut d = Driver::with_runtime_at(people::runtime(), SEEDED_AT_MS);
    d.start();
    d
}

fn edit(d: &Driver, id: &str, change: impl FnOnce(&mut act::people::EditPerson)) {
    let mut request = act::people::EditPerson {
        person_id: id.to_owned(),
        ..Default::default()
    };
    change(&mut request);
    arrange(d, request);
}

/// Ada, renamed twice: two earlier versions, "Ada" then "Ada L." (the person is "Ada Lovelace" now).
fn renamed(d: &Driver) -> String {
    let id = person(d, "Ada");
    edit(d, &id, |e| e.title = Some("Ada L.".to_owned()));
    edit(d, &id, |e| e.title = Some("Ada Lovelace".to_owned()));
    id
}

fn earlier_view(v: &wire::ViewState) -> &wire::EarlierView {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => view,
        other => panic!("not the earlier-versions screen: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> &[wire::EarlierRow] {
    match &earlier_view(v).content {
        Some(wire::earlier_view::Content::Data(data)) => &data.rows,
        other => panic!("no data: {other:?}"),
    }
}

fn open_earlier(d: &mut Driver, id: &str) -> u64 {
    let entry = {
        let i = open_person(d, id, "Ada");
        person_state(d.view(i)).earlier.clone().expect("the entry")
    };
    d.push(people::TAB, entry.route.expect("the entry's route"))
}

fn event(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

#[test]
fn the_page_offers_the_entry_with_the_count_only_once_there_is_something_earlier() {
    let mut d = driver();
    let id = person(&d, "Ada");
    let i = open_person(&mut d, &id, "Ada");
    assert!(
        person_state(d.view(i)).earlier.is_none(),
        "a record never edited has nothing earlier"
    );

    edit(&d, &id, |e| e.title = Some("Ada L.".to_owned()));
    edit(&d, &id, |e| e.title = Some("Ada Lovelace".to_owned()));
    refresh(&mut d, i);
    let entry = person_state(d.view(i)).earlier.clone().expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    assert_eq!(entry.accessibility_label, "Earlier versions, 2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, people::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
    assert_eq!(args.back_label, "Ada Lovelace", "the page it came from");
}

#[test]
fn the_list_is_the_current_value_then_each_earlier_one_newest_first_with_restore() {
    let mut d = driver();
    let id = renamed(&d);
    let i = open_earlier(&mut d, &id);
    let view = earlier_view(d.view(i));
    assert_eq!(view.title, "Earlier versions");
    assert_eq!(view.back_label, "Ada Lovelace");
    let rows = rows(d.view(i));
    let lines: Vec<&str> = rows.iter().map(|row| row.value.as_str()).collect();
    assert_eq!(lines, ["Ada Lovelace", "Ada L.", "Ada"]);
    assert!(
        rows[0].current && rows[0].current_label == "Current" && rows[0].restore_label.is_empty()
    );
    assert!(
        rows[1..]
            .iter()
            .all(|row| !row.current && row.restore_label == "Restore")
    );
    assert!(
        rows[1].seq > rows[2].seq && rows[2].seq >= 1,
        "named by seq, newest first"
    );
    assert!(
        rows.iter().all(|row| row.label.contains(" · ")),
        "a day and a time"
    );
    assert!(
        rows.iter().all(|row| !row.label.contains("From")),
        "the member's own changes say nothing of who made them"
    );
    assert!(earlier_view(d.view(i)).status.is_none());
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut d = driver();
    let id = renamed(&d);
    let i = open_earlier(&mut d, &id);
    let oldest = rows(d.view(i)).last().expect("a row").seq;
    event(
        &mut d,
        i,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert!(
        matches!(
            earlier_view(d.view(i)).content,
            Some(wire::earlier_view::Content::Data(_))
        ),
        "no confirm: the list is still the list"
    );
    assert_eq!(
        sheet_of(&d, &id)
            .sheet
            .expect("a sheet")
            .person
            .expect("a person")
            .name,
        "Ada"
    );
    let status = earlier_view(d.view(i))
        .status
        .clone()
        .expect("the status line");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");
    assert!(!status.refused);
    // A restore is a version of its own: three earlier ones now, the current one first.
    let lines: Vec<String> = rows(d.view(i))
        .iter()
        .map(|row| row.value.clone())
        .collect();
    assert_eq!(lines, ["Ada", "Ada Lovelace", "Ada L.", "Ada"]);

    event(
        &mut d,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(
        sheet_of(&d, &id)
            .sheet
            .expect("a sheet")
            .person
            .expect("a person")
            .name,
        "Ada Lovelace"
    );
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Restore undone");
    assert!(status.action_label.is_empty());
    // A second Undo tap has nothing to undo.
    let before = rows(d.view(i)).len();
    event(
        &mut d,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(rows(d.view(i)).len(), before);
}

#[test]
fn restoring_a_version_that_is_not_there_is_nothing_and_restoring_the_current_row_too() {
    let mut d = driver();
    let id = renamed(&d);
    let i = open_earlier(&mut d, &id);
    let before = rows(d.view(i)).len();
    for seq in [0, 99] {
        event(
            &mut d,
            i,
            wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq }),
        );
    }
    assert_eq!(rows(d.view(i)).len(), before);
    assert!(earlier_view(d.view(i)).status.is_none());
    assert_eq!(
        sheet_of(&d, &id)
            .sheet
            .expect("a sheet")
            .person
            .expect("a person")
            .name,
        "Ada Lovelace"
    );
}

#[test]
fn a_page_is_a_keyset_page_and_show_more_reads_the_next() {
    let mut d = driver();
    let id = person(&d, "v0");
    for n in 1..=22 {
        edit(&d, &id, |e| e.title = Some(format!("v{n}")));
    }
    let i = open_earlier(&mut d, &id);
    let page = |d: &Driver| match &earlier_view(d.view(i)).content {
        Some(wire::earlier_view::Content::Data(data)) => data.clone(),
        other => panic!("no data: {other:?}"),
    };
    let first = page(&d);
    assert_eq!(first.rows.len(), 21, "the current row and a page of twenty");
    assert_eq!(first.more_label, "Show more");
    assert_eq!(first.rows[1].value, "v21");
    event(
        &mut d,
        i,
        wire::earlier_event::Kind::More(wire::earlier_event::MoreTapped {}),
    );
    let second = page(&d);
    assert_eq!(second.rows.len(), 23, "the current row and all twenty-two");
    assert!(second.more_label.is_empty());
    assert_eq!(second.rows.last().expect("oldest").value, "v0");
}

#[test]
fn a_change_a_follow_pass_made_reads_as_coming_from_the_phone() {
    let mut d = driver();
    let statement = |title: &str| act::people::FollowContacts {
        origin: json!({ "ref": "phone", "label": "Phone" }).to_string(),
        records: json!([{ "external_id": "c1", "fields": { "title": title } }]).to_string(),
        complete: Some(true),
        since: None,
    };
    arrange(&d, statement("Ada Lovelase"));
    let id = roster_of(&d)
        .people
        .iter()
        .find(|row| row.name == "Ada Lovelase")
        .expect("the followed person")
        .party_id
        .clone();
    arrange(&d, statement("Ada Lovelace"));

    let i = open_earlier(&mut d, &id);
    let listed = rows(d.view(i)).to_vec();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].value, "Ada Lovelace");
    assert!(
        listed[0].label.ends_with(" · From your phone"),
        "the phone's pass made the current name: {}",
        listed[0].label
    );
    assert_eq!(listed[1].value, "Ada Lovelase");
    assert!(
        !listed[1].label.contains("From"),
        "the first state came from no change"
    );
    for word in ["store", "source", "sync", "contacts"] {
        assert!(
            !listed[0].label.to_lowercase().contains(word),
            "the transport's word `{word}` is not the member's"
        );
    }

    // The member's own edit after it is the member's; the version it replaced came from the phone.
    edit(&d, &id, |e| e.title = Some("Ada".to_owned()));
    event(
        &mut d,
        i,
        wire::earlier_event::Kind::Refreshed(wire::earlier_event::Refreshed {}),
    );
    let listed = rows(d.view(i)).to_vec();
    assert_eq!(listed.len(), 3);
    assert!(!listed[0].label.contains("From"));
    assert_eq!(listed[1].value, "Ada Lovelace");
    assert!(listed[1].label.ends_with(" · From your phone"));
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = Driver::unfounded(people::runtime());
    d.start();
    let route = centraid_screens::kit::earlier::route(people::EARLIER, "some-id", "Ada");
    let i = d.push(people::TAB, route);
    assert!(matches!(
        earlier_view(d.view(i)).content,
        Some(wire::earlier_view::Content::Failure(_))
    ));
}

#[test]
fn a_record_with_no_id_opens_nothing() {
    let mut d = driver();
    let route = centraid_screens::kit::earlier::route(people::EARLIER, "", "Ada");
    assert!(
        centraid_screens::people::earlier::build(&route).is_none(),
        "nothing to read: no screen"
    );
    let _ = &mut d;
}
