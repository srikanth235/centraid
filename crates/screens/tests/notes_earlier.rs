//! EARLIER VERSIONS of a note (#1185): the entry in the editor's menu with its count, the kit's one
//! screen listing what the note was (its words, its title, its notebook), Restore with no confirm,
//! Undo, and a read that fails saying so. Every test goes through `Driver`, over a vault seeded at
//! a fixed instant.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use notes_support::*;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn driver() -> Driver {
    let mut d = Driver::with_runtime_at(notes::runtime(), SEEDED_AT_MS);
    d.start();
    d
}

fn edit(d: &Driver, id: &str, change: impl FnOnce(&mut act::notes::EditNote)) {
    let mut request = act::notes::EditNote {
        note_id: id.to_owned(),
        ..Default::default()
    };
    change(&mut request);
    arrange(d, request);
}

fn file(d: &Driver, id: &str, notebook: Field<String>) {
    arrange(
        d,
        act::notes::MoveNote {
            note_id: id.to_owned(),
            notebook_id: notebook,
        },
    );
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

fn lines(d: &Driver, i: u64) -> Vec<String> {
    rows(d.view(i))
        .iter()
        .map(|row| row.value.clone())
        .collect()
}

fn refresh(d: &mut Driver, i: u64) {
    send_editor(
        d,
        i,
        wire::notes_editor_event::Kind::Refreshed(wire::notes_editor_event::Refreshed {}),
    );
}

fn open_earlier(d: &mut Driver, id: &str) -> u64 {
    let i = d.push(notes::TAB, routes::editor(id));
    let entry = editor_state(d.view(i)).earlier.clone().expect("the entry");
    d.push(notes::TAB, entry.route.expect("the entry's route"))
}

fn event(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

#[test]
fn the_menu_offers_the_entry_with_the_count_only_once_there_is_something_earlier() {
    let mut d = driver();
    let id = note(&d, "Plans", "first words");
    let i = d.push(notes::TAB, routes::editor(&id));
    assert!(
        editor_state(d.view(i)).earlier.is_none(),
        "a note never edited has nothing earlier"
    );

    edit(&d, &id, |e| e.body = Some("second words".to_owned()));
    edit(&d, &id, |e| e.body = Some("third words".to_owned()));
    refresh(&mut d, i);
    let state = editor_state(d.view(i));
    let entry = state.earlier.clone().expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    assert_eq!(entry.accessibility_label, "Earlier versions, 2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, notes::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
    assert_eq!(args.back_label, "Plans", "the note it came from");
    assert!(
        !state.chrome.as_ref().unwrap().menu_label.is_empty(),
        "the editor still has its menu"
    );
}

#[test]
fn the_list_is_current_then_what_each_version_held_words_title_and_notebook() {
    let mut d = driver();
    let travel = notebook(&d, "Travel");
    let food = notebook(&d, "Food");
    let id = note(&d, "Plans", "first words\nand a second line");
    edit(&d, &id, |e| e.body = Some("second words".to_owned()));
    edit(&d, &id, |e| e.title = Some("Plans B".to_owned()));
    file(&d, &id, Field::Is(travel));
    file(&d, &id, Field::Is(food));

    let i = open_earlier(&mut d, &id);
    let view = earlier_view(d.view(i));
    assert_eq!(view.title, "Earlier versions");
    assert_eq!(view.back_label, "Plans B");
    assert_eq!(
        lines(&d, i),
        ["Food", "Travel", "Unfiled", "Plans", "first words"],
        "the current notebook, the earlier ones by name, the earlier title and the first line of the earlier words"
    );
    let rows = rows(d.view(i));
    assert!(rows[0].current && rows[0].current_label == "Current");
    assert!(rows[0].restore_label.is_empty());
    assert!(
        rows[1..]
            .iter()
            .all(|row| !row.current && row.restore_label == "Restore")
    );
    assert!(
        rows.iter().all(|row| row.label.contains(" · ")),
        "a day and a time"
    );
}

#[test]
fn earlier_words_are_cut_short_as_the_library_cuts_a_note() {
    let mut d = driver();
    let long = "word ".repeat(40);
    let id = note(&d, "Essay", &long);
    edit(&d, &id, |e| e.body = Some("short".to_owned()));
    let i = open_earlier(&mut d, &id);
    let earlier = lines(&d, i).pop().expect("the earlier row");
    assert!(earlier.ends_with('…'), "{earlier}");
    assert!(earlier.chars().count() <= 81, "{earlier}");
    assert!(earlier.starts_with("word word"));
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut d = driver();
    let id = note(&d, "Plans", "first words");
    edit(&d, &id, |e| e.body = Some("second words".to_owned()));
    edit(&d, &id, |e| e.body = Some("third words".to_owned()));
    let i = open_earlier(&mut d, &id);
    let oldest = rows(d.view(i)).last().expect("a row").seq;
    event(
        &mut d,
        i,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert!(matches!(
        earlier_view(d.view(i)).content,
        Some(wire::earlier_view::Content::Data(_))
    ));
    assert_eq!(note_of(&d, &id).body, "first words");
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");
    // A restore is a version of its own: three earlier ones now.
    assert_eq!(
        lines(&d, i),
        ["first words", "third words", "second words", "first words"]
    );

    event(
        &mut d,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(note_of(&d, &id).body, "third words");
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Restore undone");
    assert!(status.action_label.is_empty());
}

#[test]
fn the_menu_count_follows_a_new_version() {
    let mut d = driver();
    let id = note(&d, "Plans", "first words");
    edit(&d, &id, |e| e.body = Some("second words".to_owned()));
    let i = d.push(notes::TAB, routes::editor(&id));
    assert_eq!(
        editor_state(d.view(i))
            .earlier
            .as_ref()
            .unwrap()
            .count_label,
        "1"
    );
    edit(&d, &id, |e| e.body = Some("third words".to_owned()));
    refresh(&mut d, i);
    assert_eq!(
        editor_state(d.view(i))
            .earlier
            .as_ref()
            .unwrap()
            .count_label,
        "2"
    );
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = Driver::unfounded(notes::runtime());
    d.start();
    let route = centraid_screens::kit::earlier::route(notes::EARLIER, "some-id", "Plans");
    let i = d.push(notes::TAB, route);
    assert!(matches!(
        earlier_view(d.view(i)).content,
        Some(wire::earlier_view::Content::Failure(_))
    ));
}

#[test]
fn an_imported_note_says_its_folder_and_a_typed_one_does_not() {
    let mut d = driver();
    let imported = arrange(
        &d,
        act::notes::ImportNotes {
            files: serde_json::json!([{ "path": "Vault/a.md", "text": "# Cabin\nlantern" }])
                .to_string(),
            arrived_system: Some(act::notes::ImportNotesArrivedSystem::Markdown),
            arrived_label: Some("Vault".to_owned()),
            ..Default::default()
        },
    );
    let output: serde_json::Value = serde_json::from_slice(&imported.output).expect("json");
    let imported = output["ids"][0].as_str().expect("an id").to_owned();
    let typed = note(&d, "Typed", "words");
    let i = d.push(notes::TAB, routes::editor(&imported));
    let line = editor_state(d.view(i)).origin.clone().expect("a line");
    assert_eq!(line.text, "From Vault");
    assert_eq!(line.accessibility_label, "Came from Vault");
    let i = d.push(notes::TAB, routes::editor(&typed));
    assert_eq!(editor_state(d.view(i)).origin, None);
}

#[test]
fn a_trashed_note_offers_no_entry_and_the_entry_returns_with_the_note() {
    let mut d = driver();
    let id = note(&d, "Plans", "first words");
    edit(&d, &id, |e| e.body = Some("second words".to_owned()));
    let i = d.push(notes::TAB, routes::editor(&id));
    assert!(editor_state(d.view(i)).earlier.is_some());

    arrange(
        &d,
        act::notes::DeleteNote {
            note_id: id.clone(),
        },
    );
    refresh(&mut d, i);
    assert!(
        editor_state(d.view(i)).earlier.is_none(),
        "an item in the trash offers no earlier versions"
    );

    arrange(
        &d,
        act::notes::RestoreNote {
            note_id: id.clone(),
        },
    );
    refresh(&mut d, i);
    assert!(editor_state(d.view(i)).earlier.is_some());
}
