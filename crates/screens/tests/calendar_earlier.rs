//! EARLIER VERSIONS of an event (#1185): the entry at the foot of the page with its count (absent
//! at zero), the kit's one list with each version in the page's own words, Restore with no confirm,
//! Undo, and a change the phone's calendar made reading "From your phone". Every test goes through
//! `Driver`, over a vault seeded at a fixed instant.

mod calendar_support;

use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::calendar;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::{Registry, agenda};
use serde_json::json;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn world() -> World {
    World::seeded_with(
        Registry::default().with(calendar::EARLIER, calendar::earlier::build),
        SEEDED_AT_MS,
    )
}

fn edit(w: &mut World, id: &str, change: impl FnOnce(&mut act::calendar::EditEvent)) {
    let mut request = act::calendar::EditEvent {
        event_id: id.to_owned(),
        ..Default::default()
    };
    change(&mut request);
    w.act(request);
}

/// "Review" at 14:00 to 15:00, moved to 15:00 and renamed "Design sync", then given a new title: two
/// earlier versions.
fn edited(w: &mut World) -> String {
    let id = w.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    edit(w, &id, |e| {
        e.title = Some("Design sync".to_owned());
        e.starts = Some("2099-06-15T15:00:00".to_owned());
        e.ends = Field::Is("2099-06-15T16:00:00".to_owned());
        e.zone = Field::Is(calendar_support::ZONE.to_owned());
    });
    edit(w, &id, |e| e.title = Some("Design sync (moved)".to_owned()));
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

fn open_earlier(w: &mut World, id: &str) -> u64 {
    let page = w.open_event(id, id, None, "2099-06-15");
    let entry = w
        .event_state(page)
        .earlier
        .clone()
        .expect("the entry on the page");
    w.driver.push(agenda::TAB, entry.route.expect("a route"))
}

fn send(w: &mut World, i: u64, kind: wire::earlier_event::Kind) {
    w.driver.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

fn title_of(w: &World, id: &str) -> String {
    w.event_row(id)
        .and_then(|event| event.summary)
        .expect("a title")
}

#[test]
fn the_page_offers_the_entry_with_the_count_only_once_there_is_something_earlier() {
    let mut w = world();
    let id = w.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let page = w.open_event(&id, &id, None, "2099-06-15");
    assert!(
        w.event_state(page).earlier.is_none(),
        "an event never edited has nothing earlier"
    );

    edit(&mut w, &id, |e| e.title = Some("Design sync".to_owned()));
    edit(&mut w, &id, |e| e.title = Some("Design sync 2".to_owned()));
    let page = w.open_event(&id, &id, None, "2099-06-15");
    let entry = w.event_state(page).earlier.clone().expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    assert_eq!(entry.accessibility_label, "Earlier versions, 2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, calendar::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
    assert_eq!(args.back_label, "Design sync 2", "the page it came from");
}

#[test]
fn the_list_is_the_current_state_then_each_version_in_the_pages_words() {
    let mut w = world();
    let id = edited(&mut w);
    let i = open_earlier(&mut w, &id);
    assert_eq!(earlier_view(w.driver.view(i)).title, "Earlier versions");
    let listed = rows(w.driver.view(i)).to_vec();
    assert_eq!(listed.len(), 3, "current, then two earlier");
    assert!(listed[0].current && listed[0].restore_label.is_empty());
    assert!(
        listed[1..]
            .iter()
            .all(|row| !row.current && row.restore_label == "Restore")
    );
    let lines: Vec<&str> = listed.iter().map(|row| row.value.as_str()).collect();
    assert_eq!(
        lines,
        [
            "Design sync (moved)",
            "Design sync",
            "Review · Monday 15 June, 14:00 – 15:00",
        ]
    );
    assert!(
        listed.iter().all(|row| !row.label.contains("From")),
        "the member's own changes say nothing of who made them"
    );
}

#[test]
fn a_field_the_page_does_not_show_reads_as_other_details() {
    let mut w = world();
    let id = w.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    edit(&mut w, &id, |e| {
        e.status = Some(act::calendar::EditEventStatus::Tentative);
    });
    edit(&mut w, &id, |e| {
        e.status = Some(act::calendar::EditEventStatus::Confirmed);
    });
    let i = open_earlier(&mut w, &id);
    let listed = rows(w.driver.view(i)).to_vec();
    assert!(
        listed.iter().all(|row| row.value == "Other details"),
        "{:?}",
        listed.iter().map(|r| &r.value).collect::<Vec<_>>()
    );
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut w = world();
    let id = edited(&mut w);
    let i = open_earlier(&mut w, &id);
    let oldest = rows(w.driver.view(i)).last().expect("a row").seq;
    send(
        &mut w,
        i,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert_eq!(title_of(&w, &id), "Review", "the field is back");
    let status = earlier_view(w.driver.view(i))
        .status
        .clone()
        .expect("the status line");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");
    assert!(!status.refused);

    send(
        &mut w,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(
        title_of(&w, &id),
        "Design sync (moved)",
        "the restore is undone"
    );
    let status = earlier_view(w.driver.view(i))
        .status
        .clone()
        .expect("a status");
    assert_eq!(status.sentence, "Undone");
}

#[test]
fn a_change_the_phones_calendar_made_reads_as_coming_from_the_phone() {
    let mut w = World::seeded_with(
        Registry::default().with(calendar::EARLIER, calendar::earlier::build),
        SEEDED_AT_MS,
    );
    let mut follow = |title: &str| {
        w.act(act::calendar::FollowCalendar {
            origin: json!({ "ref": "calendar:work", "label": "Work", "device_id": "phone-1" })
                .to_string(),
            records: json!([{ "external_id": "uid:1", "device_id": "phone-1", "fields": {
                "title": title, "starts": "2099-06-19T09:00", "ends": "2099-06-19T10:00",
                "timing": "floating", "busy": 1
            } }])
            .to_string(),
            complete: Some(true),
            since: None,
            ..Default::default()
        });
    };
    follow("Design sync");
    follow("Design sync (moved)");
    let id = w
        .window("2099-06-19T00:00:00Z", "2099-06-20T00:00:00Z")
        .first()
        .expect("the followed event")
        .event_id
        .clone();
    let i = open_earlier(&mut w, &id);
    let listed = rows(w.driver.view(i)).to_vec();
    assert_eq!(listed.len(), 2);
    assert!(
        listed[0].label.ends_with(" · From your phone"),
        "the phone's pass made the current state: {}",
        listed[0].label
    );
    assert!(!listed[1].label.contains("From"));
    assert!(listed[0].value.starts_with("Design sync (moved)"));
    assert!(listed[1].value.starts_with("Design sync"));
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = centraid_screens::testing::Driver::unfounded(agenda::runtime());
    d.start();
    let route = centraid_screens::kit::earlier::route(calendar::EARLIER, "some-id", "Event");
    let i = d.push(agenda::TAB, route);
    assert!(matches!(
        earlier_view(d.view(i))
            .page
            .as_ref()
            .and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Failed(_))
    ));
}

#[test]
fn a_guest_is_named_with_their_reply_and_an_own_zone_is_said_as_the_page_says_it() {
    let mut w = world();
    let priya = w.person("Maya Alvarez");
    let id = w.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |p| {
            p.zone = Field::Is("America/New_York".to_owned());
            p.attendees = Some(serde_json::to_string(&[&priya]).expect("json"));
        },
    );
    edit(&mut w, &id, |e| {
        e.starts = Some("2099-06-15T16:00:00".to_owned());
        e.ends = Field::Is("2099-06-15T17:00:00".to_owned());
        e.zone = Field::Is("America/New_York".to_owned());
    });
    edit(&mut w, &id, |e| {
        e.attendees = Some("[]".to_owned());
    });
    let i = open_earlier(&mut w, &id);
    let lines: Vec<String> = rows(w.driver.view(i))
        .iter()
        .map(|row| row.value.clone())
        .collect();
    assert_eq!(lines.len(), 3);
    assert!(lines[1].contains("Maya"), "the guest she was: {lines:?}");
    assert!(
        lines[2].contains("14:00") && lines[2].contains("New York"),
        "{lines:?}"
    );
}

#[test]
fn a_followed_event_says_its_calendar_and_a_typed_one_does_not() {
    let mut w = World::seeded_with(
        Registry::default().with(calendar::EARLIER, calendar::earlier::build),
        SEEDED_AT_MS,
    );
    w.act(act::calendar::FollowCalendar {
        origin: json!({ "ref": "calendar:work", "label": "Work", "device_id": "phone-1" })
            .to_string(),
        records: json!([{ "external_id": "uid:1", "device_id": "phone-1", "fields": {
            "title": "Design sync", "starts": "2099-06-19T09:00", "ends": "2099-06-19T10:00",
            "timing": "floating", "busy": 1
        } }])
        .to_string(),
        complete: Some(true),
        since: None,
        ..Default::default()
    });
    let followed = w
        .window("2099-06-19T00:00:00Z", "2099-06-20T00:00:00Z")
        .first()
        .expect("the followed event")
        .event_id
        .clone();
    let page = w.open_event(&followed, &followed, None, "2099-06-19");
    let line = w.event_state(page).origin.clone().expect("a line");
    assert_eq!(line.text, "From Work");
    assert_eq!(line.accessibility_label, "Came from Work");
    let typed = w.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let page = w.open_event(&typed, &typed, None, "2099-06-15");
    assert_eq!(w.event_state(page).origin, None);
}
