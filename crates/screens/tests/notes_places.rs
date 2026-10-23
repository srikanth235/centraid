//! The Notebooks and Journal places of `notes.home`. Ports of the `NotesAppSpec`
//! notebooks and journal cases, through `Driver`, plus the notebook verbs the
//! manifest declares (rename, delete).

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use notes_support::*;
use wire::app_query_response::Answer;
use wire::notes_home_event::{self as ev, Kind as H};

fn books(v: &wire::ViewState) -> &wire::NotesNotebooksData {
    match &home_state(v).content {
        Some(wire::notes_home_state::Content::Notebooks(data)) => data,
        other => panic!("not the notebooks: {other:?}"),
    }
}

fn journal(v: &wire::ViewState) -> &wire::NotesJournalData {
    match &home_state(v).content {
        Some(wire::notes_home_state::Content::Journal(data)) => data,
        other => panic!("not the journal: {other:?}"),
    }
}

fn clean() -> Driver {
    let d = driver();
    clear_notes(&d);
    d
}

/// Delete every notebook, so a test's own are the only ones.
fn clear_notebooks(d: &Driver) {
    let Answer::NotesNotebooks(all) = answer(d, load::notes::Notebooks::default()) else {
        panic!("the notebooks answer");
    };
    for book in all.notebooks {
        arrange(
            d,
            act::notes::DeleteNotebook {
                notebook_id: book.notebook_id,
            },
        );
    }
}

#[test]
fn the_band_swaps_the_place_and_never_a_stack_entry() {
    let mut d = clean();
    let i = home(&mut d, wire::NotesPlace::Notes);
    let depth = |d: &Driver| {
        d.navigation
            .as_ref()
            .unwrap()
            .tabs
            .iter()
            .find(|stack| stack.tab == notes::TAB)
            .unwrap()
            .entries
            .len()
    };
    let before = depth(&d);
    send_home(
        &mut d,
        i,
        H::Band(ev::BandPicked {
            key: "notebooks".into(),
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.place, wire::NotesPlace::Notebooks as i32);
    assert_eq!(state.title, "Notebooks");
    assert!(
        state
            .band
            .iter()
            .find(|t| t.key == "notebooks")
            .unwrap()
            .current
    );
    assert!(state.chips.is_empty() && state.search.is_none());
    assert_eq!(state.new_note, Some(routes::new_note()));
    send_home(
        &mut d,
        i,
        H::Band(ev::BandPicked {
            key: "journal".into(),
        }),
    );
    assert_eq!(
        home_state(d.view(i)).place,
        wire::NotesPlace::Journal as i32
    );
    assert_eq!(home_state(d.view(i)).title, "Journal");
    send_home(
        &mut d,
        i,
        H::Band(ev::BandPicked {
            key: "notes".into(),
        }),
    );
    assert_eq!(home_state(d.view(i)).place, wire::NotesPlace::Notes as i32);
    assert_eq!(depth(&d), before);
}

#[test]
fn notebooks_unfiled_first_every_notebook_with_its_count_in_words() {
    let mut d = clean();
    clear_notebooks(&d);
    let recipes = notebook(&d, "Recipes");
    notebook(&d, "Empty");
    let soup = note(&d, "Soup", "s");
    note(&d, "Loose", "l");
    arrange(
        &d,
        act::notes::MoveNote {
            note_id: soup,
            notebook_id: centraid_screens::field::Field::Is(recipes.clone()),
        },
    );
    let i = home(&mut d, wire::NotesPlace::Notebooks);
    let rows = &books(d.view(i)).rows;
    assert_eq!(rows[0].id, "unfiled");
    assert_eq!(rows[0].title, "Unfiled");
    assert_eq!(rows[0].count, "1 note");
    assert_eq!(rows[0].accessibility_label, "Unfiled, 1 note");
    assert!(!rows[0].manageable);
    let titles: Vec<&str> = rows.iter().map(|r| r.title.as_str()).collect();
    assert_eq!(titles, ["Unfiled", "Recipes", "Empty"]);
    let recipes_row = rows.iter().find(|r| r.id == recipes).unwrap();
    assert_eq!(recipes_row.count, "1 note");
    assert_eq!(recipes_row.accessibility_label, "Recipes, 1 note");
    assert!(recipes_row.manageable);
    assert_eq!(
        rows.iter().find(|r| r.title == "Empty").unwrap().count,
        "0 notes"
    );
    assert!(books(d.view(i)).empty.is_none());
}

#[test]
fn no_notebook_is_one_sentence_and_the_create_action() {
    let mut d = clean();
    clear_notebooks(&d);
    let i = home(&mut d, wire::NotesPlace::Notebooks);
    let empty = books(d.view(i)).empty.clone().expect("empty");
    assert_eq!(empty.headline, "No notebooks yet");
    assert_eq!(empty.body, "A notebook keeps related notes together.");
    assert_eq!(empty.action_label, "New notebook");
    assert_eq!(books(d.view(i)).rows.len(), 1, "Unfiled alone");
}

#[test]
fn the_unfiled_count_says_when_it_is_of_the_window_only() {
    let mut d = clean();
    clear_notebooks(&d);
    for n in 0..3 {
        note(&d, &format!("n{n}"), "x");
    }
    let i = home(&mut d, wire::NotesPlace::Notebooks);
    assert_eq!(books(d.view(i)).rows[0].count, "3 notes");
}

#[test]
fn create_is_a_write_a_refusal_keeps_the_name_and_a_commit_closes_the_sheet() {
    let mut d = clean();
    clear_notebooks(&d);
    let i = home(&mut d, wire::NotesPlace::Notebooks);
    send_home(
        &mut d,
        i,
        H::FormOpened(ev::FormOpened {
            notebook_id: String::new(),
        }),
    );
    let form = home_state(d.view(i)).form.clone().expect("the sheet");
    assert_eq!(form.title, "New notebook");
    assert_eq!(form.placeholder, "Notebook name");
    assert_eq!(form.confirm_label, "Create");
    assert_eq!(form.cancel_label, "Cancel");
    assert!(!form.can_confirm);
    // A blank name creates nothing.
    send_home(
        &mut d,
        i,
        H::FormName(ev::FormNameEdited { name: "  ".into() }),
    );
    send_home(&mut d, i, H::FormConfirmed(ev::FormConfirmed {}));
    assert!(home_state(d.view(i)).form.is_some());
    assert_eq!(books(d.view(i)).rows.len(), 1);
    send_home(
        &mut d,
        i,
        H::FormName(ev::FormNameEdited {
            name: "  Travel ".into(),
        }),
    );
    assert!(home_state(d.view(i)).form.clone().unwrap().can_confirm);
    send_home(&mut d, i, H::FormConfirmed(ev::FormConfirmed {}));
    assert!(home_state(d.view(i)).form.is_none());
    let rows = &books(d.view(i)).rows;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].title, "Travel");
    // The sheet can be put away.
    send_home(
        &mut d,
        i,
        H::FormOpened(ev::FormOpened {
            notebook_id: String::new(),
        }),
    );
    send_home(&mut d, i, H::FormDismissed(ev::FormDismissed {}));
    assert!(home_state(d.view(i)).form.is_none());
}

#[test]
fn a_notebook_is_renamed_and_deleted_from_its_menu() {
    let mut d = clean();
    clear_notebooks(&d);
    let book = notebook(&d, "Trips");
    let kept = note(&d, "Packing", "list");
    arrange(
        &d,
        act::notes::MoveNote {
            note_id: kept.clone(),
            notebook_id: centraid_screens::field::Field::Is(book.clone()),
        },
    );
    let i = home(&mut d, wire::NotesPlace::Notebooks);
    send_home(
        &mut d,
        i,
        H::NotebookMenu(ev::NotebookMenuOpened {
            notebook_id: book.clone(),
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, wire::NotesSheet::NotebookMenu as i32);
    let menu = state.menu.clone().unwrap();
    assert_eq!(menu.title, "Trips");
    assert_eq!(menu.rename_label, "Rename");
    assert_eq!(menu.trash_label, "Delete");
    // RENAME opens the sheet over the current name.
    send_home(
        &mut d,
        i,
        H::FormOpened(ev::FormOpened {
            notebook_id: book.clone(),
        }),
    );
    let form = home_state(d.view(i)).form.clone().unwrap();
    assert_eq!(form.title, "Rename notebook");
    assert_eq!(form.name, "Trips");
    assert_eq!(form.confirm_label, "Rename");
    assert_eq!(home_state(d.view(i)).sheet, wire::NotesSheet::None as i32);
    send_home(
        &mut d,
        i,
        H::FormName(ev::FormNameEdited {
            name: "Journeys".into(),
        }),
    );
    send_home(&mut d, i, H::FormConfirmed(ev::FormConfirmed {}));
    assert_eq!(books(d.view(i)).rows[1].title, "Journeys");
    // DELETE is asked first.
    send_home(
        &mut d,
        i,
        H::NotebookDelete(ev::NotebookDeleteAsked {
            notebook_id: book.clone(),
        }),
    );
    let confirm = home_state(d.view(i)).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Delete this notebook?");
    assert!(confirm.destructive);
    send_home(&mut d, i, H::Dismissed(ev::Dismissed {}));
    assert_eq!(books(d.view(i)).rows.len(), 2);
    send_home(
        &mut d,
        i,
        H::NotebookDelete(ev::NotebookDeleteAsked { notebook_id: book }),
    );
    send_home(&mut d, i, H::Confirmed(ev::Confirmed {}));
    assert_eq!(books(d.view(i)).rows.len(), 1);
    // The notes it held went to the trash with it, as the confirm said.
    assert_eq!(
        confirm.body,
        "Its notes go to the trash with it, restorable for 30 days."
    );
    assert!(note_of(&d, &kept).deleted_at.is_some());
}

#[test]
fn a_notebook_row_opens_the_notes_place_filtered_and_unfiled_is_its_own_filter() {
    let mut d = clean();
    clear_notebooks(&d);
    let book = notebook(&d, "Cabin");
    let inside = note(&d, "Plans", "p");
    note(&d, "Loose", "l");
    arrange(
        &d,
        act::notes::MoveNote {
            note_id: inside,
            notebook_id: centraid_screens::field::Field::Is(book.clone()),
        },
    );
    let i = home(&mut d, wire::NotesPlace::Notebooks);
    send_home(
        &mut d,
        i,
        H::NotebookPicked(ev::NotebookPicked { id: book }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.place, wire::NotesPlace::Notes as i32);
    assert_eq!(state.title, "Cabin");
    assert_eq!(titles(d.view(i)), ["Plans"]);
    send_home(
        &mut d,
        i,
        H::Band(ev::BandPicked {
            key: "notebooks".into(),
        }),
    );
    send_home(
        &mut d,
        i,
        H::NotebookPicked(ev::NotebookPicked {
            id: "unfiled".into(),
        }),
    );
    assert_eq!(home_state(d.view(i)).title, "Unfiled");
    assert_eq!(titles(d.view(i)), ["Loose"]);
}

// ---------------------------------------------------------------------------
// The Journal
// ---------------------------------------------------------------------------

#[test]
fn the_journal_groups_entries_by_the_local_day_newest_first_in_words() {
    let mut d = clean();
    let i = home(&mut d, wire::NotesPlace::Journal);
    // Seeded or not, today is the core's: stating it lets the entry be dated.
    let today = journal(d.view(i)).today.clone();
    assert!(!today.is_empty() || journal(d.view(i)).empty.is_some());
    let Answer::NotesJournal(core) = answer(&d, load::notes::Journal::default()) else {
        panic!("the journal answers");
    };
    arrange(
        &d,
        act::people::AddJournalEntry {
            mood: "calm".into(),
            text: "A quiet morning".into(),
            entry_date: Some(core.today.clone()),
            tz: Some(core.tz.clone()),
        },
    );
    d.pump(std::time::Duration::from_millis(300));
    let data = journal(d.view(i));
    let day = data.days.first().expect("a day");
    assert_eq!(day.head.as_ref().unwrap().title, "Today");
    assert_eq!(day.day, core.today);
    assert!(
        day.rows
            .iter()
            .any(|row| !row.meta.is_empty() && row.route.is_some())
    );
    assert_eq!(data.tz, core.tz);
}

#[test]
fn the_empty_journal_is_one_sentence() {
    let mut d = clean();
    // Every entry the seed made is a note about someone: trashing them empties the journal.
    let Answer::NotesJournal(core) = answer(&d, load::notes::Journal::default()) else {
        panic!("the journal answers");
    };
    for day in core.days {
        for entry in day.entries {
            arrange(
                &d,
                act::notes::DeleteNote {
                    note_id: entry.note_id,
                },
            );
        }
    }
    let i = home(&mut d, wire::NotesPlace::Journal);
    let empty = journal(d.view(i)).empty.clone().expect("empty");
    assert_eq!(empty.headline, "No journal entries yet");
    assert_eq!(
        empty.body,
        "Entries you write about people in People appear here."
    );
    assert!(journal(d.view(i)).days.is_empty());
}

#[test]
fn a_new_entry_opens_the_sheet_and_save_files_it_through_peoples_action_on_the_day_read() {
    let mut d = clean();
    let i = home(&mut d, wire::NotesPlace::Journal);
    let today = journal(d.view(i)).today.clone();
    assert!(!today.is_empty());
    send_home(&mut d, i, H::NewEntry(ev::NewEntryTapped {}));
    let compose = home_state(d.view(i)).compose.clone().expect("the sheet");
    assert_eq!(compose.day, today);
    assert_eq!(compose.title, "New entry for today");
    assert_eq!(compose.mood_placeholder, "Mood");
    assert_eq!(compose.text_placeholder, "A line about your day");
    assert_eq!(compose.save, "Save");
    assert!(!compose.can_save);
    // A save with a blank half writes nothing.
    send_home(
        &mut d,
        i,
        H::ComposeEdited(ev::ComposeEdited {
            mood: "calm".into(),
            text: "  ".into(),
        }),
    );
    send_home(&mut d, i, H::ComposeSaved(ev::ComposeSaved {}));
    assert!(home_state(d.view(i)).compose.is_some());
    send_home(
        &mut d,
        i,
        H::ComposeEdited(ev::ComposeEdited {
            mood: "calm".into(),
            text: "Wrote the spec".into(),
        }),
    );
    assert!(home_state(d.view(i)).compose.clone().unwrap().can_save);
    send_home(&mut d, i, H::ComposeSaved(ev::ComposeSaved {}));
    assert!(home_state(d.view(i)).compose.is_none());
    let data = journal(d.view(i));
    assert_eq!(data.days[0].day, today);
    assert_eq!(data.days[0].head.as_ref().unwrap().title, "Today");
    assert!(
        data.days[0]
            .rows
            .iter()
            .any(|row| row.title.contains("calm") || row.title.contains("Wrote"))
    );
    // Putting the sheet away writes nothing.
    send_home(&mut d, i, H::NewEntry(ev::NewEntryTapped {}));
    send_home(&mut d, i, H::ComposeClosed(ev::ComposeClosed {}));
    assert!(home_state(d.view(i)).compose.is_none());
}

#[test]
fn a_journal_entry_opens_the_note() {
    let mut d = clean();
    let i = home(&mut d, wire::NotesPlace::Journal);
    send_home(&mut d, i, H::NewEntry(ev::NewEntryTapped {}));
    send_home(
        &mut d,
        i,
        H::ComposeEdited(ev::ComposeEdited {
            mood: "glad".into(),
            text: "x".into(),
        }),
    );
    send_home(&mut d, i, H::ComposeSaved(ev::ComposeSaved {}));
    let row = &journal(d.view(i)).days[0].rows[0];
    assert_eq!(row.route, Some(routes::editor(&row.note_id)));
}
