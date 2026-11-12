//! THE FULL PREVIEW OF AN EARLIER VERSION of a person (#1185): a row of the list opens it, it draws
//! the person as they were under a banner that says which version it is, Restore asks nothing and
//! closes with the list saying so (with Undo), Close changes nothing, and a read that fails says
//! so. Every test goes through `Driver`, over a vault seeded at a fixed instant.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::kit::earlier;
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

/// Ada, edited twice: "Ada" (no role), then "Ada L." the Countess, then "Ada Lovelace" the Countess.
fn renamed(d: &Driver) -> String {
    let id = person(d, "Ada");
    edit(d, &id, |e| {
        e.title = Some("Ada L.".to_owned());
        e.role = Some("Countess".to_owned());
    });
    edit(d, &id, |e| e.title = Some("Ada Lovelace".to_owned()));
    id
}

fn list_view(v: &wire::ViewState) -> &wire::EarlierView {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => view,
        other => panic!("not the earlier-versions list: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> &[wire::EarlierRow] {
    match &list_view(v).content {
        Some(wire::earlier_view::Content::Data(data)) => &data.rows,
        other => panic!("no data: {other:?}"),
    }
}

fn preview_view(v: &wire::ViewState) -> &wire::EarlierPreviewView {
    match &v.kind {
        Some(wire::view_state::Kind::EarlierPreview(view)) => view,
        other => panic!("not the preview: {other:?}"),
    }
}

fn shown(v: &wire::ViewState) -> &wire::EarlierPreviewData {
    preview_view(v).data.as_ref().expect("a ready preview")
}

fn open_list(d: &mut Driver, id: &str) -> u64 {
    let entry = {
        let i = open_person(d, id, "Ada");
        person_state(d.view(i)).earlier.clone().expect("the entry")
    };
    d.push(people::TAB, entry.route.expect("the entry's route"))
}

/// The preview of the list's row `row` (0 is the current one).
fn open_preview(d: &mut Driver, list: u64, row: usize) -> u64 {
    let route = rows(d.view(list))[row].preview.clone().expect("a route");
    d.push(people::TAB, route)
}

fn event(d: &mut Driver, i: u64, kind: wire::earlier_preview_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::EarlierPreview(wire::EarlierPreviewEvent { kind: Some(kind) }),
    );
}

fn name_now(d: &Driver, id: &str) -> String {
    sheet_of(d, id)
        .sheet
        .expect("a sheet")
        .person
        .expect("a person")
        .name
}

#[test]
fn every_earlier_row_opens_a_preview_and_the_current_row_opens_nothing() {
    let mut d = driver();
    let id = renamed(&d);
    let list = open_list(&mut d, &id);
    let listed = rows(d.view(list)).to_vec();
    assert!(listed[0].current && listed[0].preview.is_none());
    for row in &listed[1..] {
        let route = row.preview.clone().expect("a route");
        assert_eq!(route.screen, people::EARLIER);
        let Some(wire::route::Args::EarlierPreview(args)) = route.args else {
            panic!("the preview's route");
        };
        assert_eq!((args.entity_id.as_str(), args.seq), (id.as_str(), row.seq));
        assert_eq!(args.back_label, "Earlier versions", "the list it came from");
    }
}

#[test]
fn the_preview_is_the_person_as_they_were_under_a_banner_naming_the_version() {
    let mut d = driver();
    let id = renamed(&d);
    let list = open_list(&mut d, &id);
    // Newest first: row 1 is "Ada L." the Countess, row 2 is "Ada".
    let i = open_preview(&mut d, list, 1);
    let view = preview_view(d.view(i));
    assert_eq!(view.title, "Earlier version");
    assert_eq!(view.back_label, "Earlier versions");
    assert!(!view.done && view.status.is_none());
    let data = shown(d.view(i));
    assert!(
        data.banner_headline.starts_with("As it was on ") && data.banner_headline.contains(" · "),
        "{}",
        data.banner_headline
    );
    assert!(
        data.banner_changed.starts_with("Changed on ")
            && data.banner_changed.ends_with(" to Ada Lovelace"),
        "what replaced it: {}",
        data.banner_changed
    );
    assert_eq!(
        data.banner_note,
        "Read only. Nothing changes until you restore it."
    );
    assert_eq!(data.heading, "Ada L.");
    assert_eq!(data.details, ["Countess"], "the rest of what it held");
    assert_eq!(data.restore_label, "Restore this version");
    assert_eq!(data.close_label, "Close");
    assert!(data.accessibility_label.contains(&data.banner_headline));

    let first = open_preview(&mut d, list, 2);
    let data = shown(d.view(first));
    assert_eq!(data.heading, "Ada");
    assert!(data.details.is_empty(), "no role then");
    assert!(
        data.banner_changed.ends_with(" to Ada L. · Countess"),
        "what changed it: {}",
        data.banner_changed
    );
    // Looking changes nothing.
    assert_eq!(name_now(&d, &id), "Ada Lovelace");
}

#[test]
fn restore_asks_nothing_closes_and_the_list_says_so_with_undo() {
    let mut d = driver();
    let id = renamed(&d);
    let list = open_list(&mut d, &id);
    let i = open_preview(&mut d, list, 2);
    event(
        &mut d,
        i,
        wire::earlier_preview_event::Kind::Restore(Default::default()),
    );
    assert!(preview_view(d.view(i)).done, "the shell pops it");
    assert_eq!(name_now(&d, &id), "Ada");

    d.pop(people::TAB, i);
    let status = list_view(d.view(list))
        .status
        .clone()
        .expect("the list's line");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");
    assert!(!status.refused);
    let lines: Vec<String> = rows(d.view(list))
        .iter()
        .map(|row| row.value.clone())
        .collect();
    assert_eq!(lines[0], "Ada", "the restore is a version of its own");

    d.send(
        list,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent {
            kind: Some(wire::earlier_event::Kind::StatusActed(
                wire::earlier_event::StatusActed {},
            )),
        }),
    );
    assert_eq!(name_now(&d, &id), "Ada Lovelace");
}

#[test]
fn restoring_what_the_record_already_holds_says_so_and_offers_no_undo() {
    let mut d = driver();
    let id = renamed(&d);
    let list = open_list(&mut d, &id);
    let i = open_preview(&mut d, list, 1);
    // Make the record what the version holds, then restore the version.
    edit(&d, &id, |e| {
        e.title = Some("Ada L.".to_owned());
        e.role = Some("Countess".to_owned());
    });
    event(
        &mut d,
        i,
        wire::earlier_preview_event::Kind::Restore(Default::default()),
    );
    assert!(preview_view(d.view(i)).done);
    d.pop(people::TAB, i);
    let status = list_view(d.view(list)).status.clone().expect("a line");
    assert_eq!(status.sentence, "Already how it is now");
    assert!(status.action_label.is_empty());
}

#[test]
fn close_closes_and_changes_nothing() {
    let mut d = driver();
    let id = renamed(&d);
    let list = open_list(&mut d, &id);
    let i = open_preview(&mut d, list, 1);
    let before = rows(d.view(list)).len();
    event(
        &mut d,
        i,
        wire::earlier_preview_event::Kind::Close(Default::default()),
    );
    assert!(preview_view(d.view(i)).done);
    d.pop(people::TAB, i);
    assert_eq!(name_now(&d, &id), "Ada Lovelace");
    assert_eq!(rows(d.view(list)).len(), before, "no new version");
    assert!(list_view(d.view(list)).status.is_none());
}

#[test]
fn a_version_a_phone_made_says_whose_it_was() {
    let mut d = driver();
    let statement = |title: &str| act::people::FollowContacts {
        origin: json!({ "ref": "phone", "label": "Phone" }).to_string(),
        records: json!([{ "external_id": "c1", "fields": { "title": title } }]).to_string(),
        complete: Some(true),
        since: None,
        ..Default::default()
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
    edit(&d, &id, |e| e.title = Some("Ada".to_owned()));

    let list = open_list(&mut d, &id);
    // Row 1 is "Ada Lovelace", which the phone's pass made and the member's edit replaced.
    let i = open_preview(&mut d, list, 1);
    assert!(
        shown(d.view(i))
            .banner_headline
            .ends_with(" · From your phone"),
        "{}",
        shown(d.view(i)).banner_headline
    );
    assert!(
        !shown(d.view(i)).banner_changed.contains("From"),
        "the member replaced it"
    );
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_record() {
    let mut d = Driver::unfounded(people::runtime());
    d.start();
    let route = earlier::preview_route(people::EARLIER, "some-id", 1, "Earlier versions");
    let i = d.push(people::TAB, route);
    let view = preview_view(d.view(i));
    assert!(view.data.is_none());
    assert!(matches!(
        view.page.as_ref().and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Failed(_))
    ));
}

#[test]
fn a_version_the_record_does_not_hold_is_the_failed_state() {
    let mut d = driver();
    let id = renamed(&d);
    let route = earlier::preview_route(people::EARLIER, &id, 99, "Earlier versions");
    let i = d.push(people::TAB, route);
    assert!(preview_view(d.view(i)).data.is_none());
}

#[test]
fn a_record_or_version_with_no_number_opens_nothing() {
    for (entity, seq) in [("", 1), ("an-id", 0), ("an-id", -3)] {
        let route = earlier::preview_route(people::EARLIER, entity, seq, "Earlier versions");
        assert!(
            people::earlier::build(&route).is_none(),
            "{entity:?} version {seq} names nothing"
        );
    }
}
