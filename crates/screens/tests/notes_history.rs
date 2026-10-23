//! A note's version history (`notes.history`) and Notes' trash (`notes.trash`,
//! the kit's screen with Notes' spec). Ports of the `NotesAppSpec` history and
//! trash cases, through `Driver`.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use notes_support::*;
use wire::notes_history_event::{self as ev, Kind as H};
use wire::trash_event::{self as te, Kind as T};

fn edit(d: &Driver, id: &str, body: &str) {
    arrange(
        d,
        act::notes::EditNote {
            note_id: id.to_owned(),
            body: Some(body.to_owned()),
            ..Default::default()
        },
    );
}

fn rows(v: &wire::ViewState) -> &Vec<wire::NotesVersionRow> {
    match &history_state(v).content {
        Some(wire::notes_history_state::Content::Data(data)) => &data.rows,
        other => panic!("not history data: {other:?}"),
    }
}

#[test]
fn versions_newest_first_the_current_one_unrestorable_and_restore_is_a_write() {
    let mut d = driver();
    let id = note(&d, "Plans", "first words");
    edit(&d, &id, "second words");
    edit(&d, &id, "third words");
    let i = d.push(notes::TAB, routes::history(&id, "Plans"));
    let state = history_state(d.view(i));
    assert_eq!(state.title, "Version history");
    assert_eq!(state.back, "Plans");
    assert_eq!(state.close, "Close");
    let versions = rows(d.view(i)).clone();
    assert_eq!(versions.len(), 3);
    assert_eq!(versions[0].label, "Current version");
    assert!(versions[0].current);
    assert_eq!(versions[0].preview, "third words");
    assert_eq!(versions[0].restore_label, "");
    assert_eq!(versions[1].preview, "second words");
    assert_eq!(versions[2].preview, "first words");
    assert_eq!(versions[2].restore_label, "Restore");
    assert!(versions[2].label.contains(" · "), "{}", versions[2].label);
    // No empty sentence over a history with versions.
    match &history_state(d.view(i)).content {
        Some(wire::notes_history_state::Content::Data(data)) => assert!(data.empty.is_none()),
        other => panic!("{other:?}"),
    }
    // The current version restores nothing.
    send_history(
        &mut d,
        i,
        H::Restore(ev::RestoreTapped {
            content_id: versions[0].content_id.clone(),
        }),
    );
    assert_eq!(note_of(&d, &id).body, "third words");
    // RESTORING ASKS NOTHING and writes the words it replaces as a new version.
    let oldest = versions[2].content_id.clone();
    send_history(
        &mut d,
        i,
        H::Restore(ev::RestoreTapped { content_id: oldest }),
    );
    assert_eq!(note_of(&d, &id).body, "first words");
    let after = rows(d.view(i));
    assert_eq!(after.len(), 4, "the restore is itself a version");
    assert_eq!(after[0].preview, "first words");
    assert!(history_state(d.view(i)).status.is_none());
}

#[test]
fn a_note_with_one_version_says_there_is_nothing_earlier() {
    let mut d = driver();
    let id = note(&d, "Once", "only words");
    let i = d.push(notes::TAB, routes::history(&id, ""));
    assert_eq!(history_state(d.view(i)).back, "Untitled note");
    match &history_state(d.view(i)).content {
        Some(wire::notes_history_state::Content::Data(data)) => {
            let empty = data.empty.as_ref().expect("the sentence");
            assert_eq!(empty.headline, "No earlier versions");
            assert_eq!(empty.body, "Versions appear here as the note changes.");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_history_of_nothing_is_a_failure_not_an_empty_list() {
    let mut d = driver();
    let i = d.push(notes::TAB, routes::history("", ""));
    assert!(matches!(
        history_state(d.view(i)).content,
        Some(wire::notes_history_state::Content::Failure(_))
    ));
}

// ---------------------------------------------------------------------------
// notes.trash
// ---------------------------------------------------------------------------

fn trashed_ids(v: &wire::ViewState) -> Vec<String> {
    match &trash_state(v).content {
        Some(wire::trash_view::Content::Data(data)) => {
            data.rows.iter().map(|row| row.id.clone()).collect()
        }
        other => panic!("not trash data: {other:?}"),
    }
}

/// Trash everything live and restore-then-trash what was already trashed, so the
/// trash holds only a test's own notes.
fn clean_trash(d: &Driver) {
    clear_notes(d);
}

#[test]
fn the_trash_lists_trashed_notes_with_their_day_restore_only() {
    let mut d = driver();
    clean_trash(&d);
    let named = note(&d, "Gone", "x");
    let unnamed = note(&d, "temp", "first line here\nmore");
    arrange(
        &d,
        act::notes::EditNote {
            note_id: unnamed.clone(),
            title: Some(String::new()),
            ..Default::default()
        },
    );
    arrange(
        &d,
        act::notes::DeleteNote {
            note_id: named.clone(),
        },
    );
    arrange(
        &d,
        act::notes::DeleteNote {
            note_id: unnamed.clone(),
        },
    );
    let i = d.push(notes::TAB, routes::trash());
    let view = trash_state(d.view(i));
    assert_eq!(view.app_id, "notes");
    assert_eq!(view.title, "Trash");
    assert_eq!(view.back_label, "Notes");
    assert_eq!(view.purge_window_days, 30);
    let Some(wire::trash_view::Content::Data(data)) = &view.content else {
        panic!("no data");
    };
    let row = data.rows.iter().find(|r| r.id == named).unwrap();
    assert_eq!(row.title, "Gone");
    assert!(row.meta.starts_with("Deleted "), "{}", row.meta);
    assert_eq!(row.icon_key, "FileText");
    assert_eq!(row.restore_label, "Restore");
    // A note with no title is named by its first line.
    assert_eq!(
        data.rows.iter().find(|r| r.id == unnamed).unwrap().title,
        "first line here"
    );
    // RESTORE ONLY: no purge, no empty.
    assert!(data.rows.iter().all(|r| r.purge_label.is_empty()));
    assert_eq!(data.empty_label, "");
    send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: named.clone() }));
    send_trash(&mut d, i, T::Empty(te::EmptyTapped {}));
    assert!(
        trash_state(d.view(i)).confirm.is_none(),
        "nothing to confirm"
    );
    // Restore asks nothing and brings the note back.
    send_trash(
        &mut d,
        i,
        T::Restore(te::RestoreTapped { id: named.clone() }),
    );
    assert!(!trashed_ids(d.view(i)).contains(&named));
    assert!(trashed_ids(d.view(i)).contains(&unnamed));
    assert!(note_of(&d, &named).deleted_at.is_none());
    send_trash(
        &mut d,
        i,
        T::Restore(te::RestoreTapped {
            id: unnamed.clone(),
        }),
    );
    assert!(!trashed_ids(d.view(i)).contains(&unnamed));
}
