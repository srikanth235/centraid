//! EARLIER VERSIONS of a task (#1185): the entry at the foot of the page with its count (absent at
//! zero), the kit's one list with each version in the task page's words, Restore with no confirm,
//! Undo, and a failed read. Every test goes through `Driver`, over a vault seeded at a fixed
//! instant.

mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::testing::Driver;
use centraid_screens::{agenda, reminders};
use reminders_support::*;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn seeded() -> Driver {
    let mut d = Driver::with_runtime_at(agenda::runtime(), SEEDED_AT_MS);
    d.start();
    d
}

fn edit(d: &Driver, id: &str, change: impl FnOnce(&mut act::reminders::EditTask)) {
    let mut request = act::reminders::EditTask {
        task_id: id.to_owned(),
        ..Default::default()
    };
    change(&mut request);
    arrange(d, request);
}

/// "Pay rent" given a due day and a priority, renamed with its day moved, then renamed again: three
/// earlier versions, the first holding no day and no priority (so it has no words).
fn edited(d: &Driver) -> String {
    let id = task(d, "Pay rent");
    edit(d, &id, |e| {
        e.due = Field::Is("2026-03-05T09:00".to_owned());
        e.priority = Some(3);
    });
    edit(d, &id, |e| {
        e.title = Some("Pay the rent".to_owned());
        e.due = Field::Is("2026-03-06".to_owned());
    });
    edit(d, &id, |e| e.title = Some("Pay the rent today".to_owned()));
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
    let page = d.push(agenda::TAB, routes::task(id));
    let entry = detail(d.view(page)).earlier.clone().expect("the entry");
    d.push(agenda::TAB, entry.route.expect("a route"))
}

fn send(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

#[test]
fn the_page_offers_the_entry_with_the_count_only_once_there_is_something_earlier() {
    let mut d = seeded();
    let id = task(&d, "Pay rent");
    let page = d.push(agenda::TAB, routes::task(&id));
    assert!(
        detail(d.view(page)).earlier.is_none(),
        "a task never edited has nothing earlier"
    );
    d.pop(agenda::TAB, page);

    edit(&d, &id, |e| e.title = Some("Pay the rent".to_owned()));
    edit(&d, &id, |e| e.title = Some("Pay the rent now".to_owned()));
    let page = d.push(agenda::TAB, routes::task(&id));
    let entry = detail(d.view(page)).earlier.clone().expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    assert_eq!(entry.accessibility_label, "Earlier versions, 2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, reminders::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
    assert_eq!(args.back_label, "Pay the rent now");
}

#[test]
fn the_list_is_the_current_state_then_each_version_in_the_pages_words() {
    let mut d = seeded();
    let id = edited(&d);
    let i = open_earlier(&mut d, &id);
    let listed = rows(d.view(i)).to_vec();
    assert_eq!(listed.len(), 4, "current, then three earlier");
    let lines: Vec<&str> = listed.iter().map(|row| row.value.as_str()).collect();
    assert_eq!(
        lines,
        [
            "Pay the rent today",
            "Pay the rent",
            "Pay rent · Thu 5 March, 09:00",
            "Other details",
        ]
    );
    assert!(listed[0].current && listed[0].restore_label.is_empty());
    assert!(listed[1..].iter().all(|row| row.restore_label == "Restore"));
}

#[test]
fn a_version_that_held_a_due_time_and_a_priority_says_so() {
    let mut d = seeded();
    let id = task(&d, "Pay rent");
    edit(&d, &id, |e| {
        e.due = Field::Is("2026-03-05T09:00".to_owned());
        e.priority = Some(3);
    });
    edit(&d, &id, |e| {
        e.due = Field::Is("2026-03-06".to_owned());
        e.priority = Some(1);
    });
    let i = open_earlier(&mut d, &id);
    let lines: Vec<String> = rows(d.view(i)).iter().map(|r| r.value.clone()).collect();
    assert_eq!(lines[1], "Thu 5 March, 09:00 · !!!");
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut d = seeded();
    let id = edited(&d);
    let i = open_earlier(&mut d, &id);
    let oldest = rows(d.view(i)).last().expect("a row").seq;
    send(
        &mut d,
        i,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert_eq!(task_of(&d, &id).title, "Pay rent", "the field is back");
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");

    send(
        &mut d,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(task_of(&d, &id).title, "Pay the rent today");
    assert_eq!(
        earlier_view(d.view(i))
            .status
            .clone()
            .expect("a status")
            .sentence,
        "Restore undone"
    );
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = Driver::unfounded(agenda::runtime());
    d.start();
    let route = centraid_screens::kit::earlier::route(reminders::EARLIER, "some-id", "Task");
    let i = d.push(agenda::TAB, route);
    assert!(matches!(
        earlier_view(d.view(i)).content,
        Some(wire::earlier_view::Content::Failure(_))
    ));
}
