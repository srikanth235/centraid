//! Notes' trash (`notes.trash`, the kit's screen with Notes' spec). Ports of the `NotesAppSpec`
//! trash cases, through `Driver`.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use notes_support::*;
use wire::trash_event::{self as te, Kind as T};

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
    // EVERY TRASH CAN DELETE FOREVER AND EMPTY (#1185), each behind a confirm.
    assert!(data.rows.iter().all(|r| r.purge_label == "Delete forever"));
    assert_eq!(data.empty_label, "Empty trash");
    send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: named.clone() }));
    let confirm = trash_state(d.view(i)).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Delete this note forever?");
    assert!(confirm.destructive);
    send_trash(&mut d, i, T::Dismissed(te::Dismissed {}));
    send_trash(&mut d, i, T::Empty(te::EmptyTapped {}));
    assert_eq!(
        trash_state(d.view(i))
            .confirm
            .as_ref()
            .expect("a confirm")
            .title,
        "Empty trash?"
    );
    send_trash(&mut d, i, T::Dismissed(te::Dismissed {}));
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
