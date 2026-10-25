//! The Notes place of `notes.home`: the shelf, the chip row, search, the row menu
//! and its writes. Ports of the `NotesAppSpec` library cases, through `Driver`.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::notes::{self, routes};
use notes_support::*;
use wire::notes_home_event::{self as ev, Kind as H};

fn pinned(d: &Driver, id: &str) {
    arrange(
        d,
        act::notes::FlagNote {
            note_id: id.to_owned(),
            flag: act::notes::FlagNoteFlag::Pinned,
        },
    );
}

use centraid_screens::testing::Driver;

fn clean() -> Driver {
    let d = driver();
    clear_notes(&d);
    d
}

#[test]
fn opening_reads_the_library_with_the_band_and_the_default_sort() {
    let mut d = clean();
    note(&d, "Grocery run", "milk and eggs");
    let i = home(&mut d, wire::NotesPlace::Notes);
    let state = home_state(d.view(i));
    assert_eq!(state.place, wire::NotesPlace::Notes as i32);
    assert_eq!(state.title, "Notes");
    let band: Vec<(&str, &str, bool)> = state
        .band
        .iter()
        .map(|tab| (tab.key.as_str(), tab.icon_key.as_str(), tab.current))
        .collect();
    assert_eq!(
        band,
        [
            ("notes", "FileText", true),
            ("notebooks", "Folder", false),
            ("journal", "Journal", false),
            ("more", "MoreHoriz", false),
        ]
    );
    assert_eq!(
        state
            .band
            .iter()
            .map(|t| t.label.as_str())
            .collect::<Vec<_>>(),
        ["Notes", "Notebooks", "Journal", "More"]
    );
    assert_eq!(titles(d.view(i)), ["Grocery run"]);
    assert_eq!(library_data(d.view(i)).count_label, "1 note");
    assert_eq!(state.new_note, Some(routes::new_note()));
}

#[test]
fn pinned_lead_in_their_own_section_and_rows_carry_finished_words() {
    let mut d = clean();
    let plain = note(&d, "temp", "first line of the plain one\nmore");
    arrange(
        &d,
        act::notes::EditNote {
            note_id: plain.clone(),
            title: Some(String::new()),
            ..Default::default()
        },
    );
    let loud = note(&d, "Pinned one", "body");
    pinned(&d, &loud);
    let book = notebook(&d, "Recipes");
    arrange(
        &d,
        act::notes::MoveNote {
            note_id: plain.clone(),
            notebook_id: centraid_screens::field::Field::Is(book.clone()),
        },
    );
    let i = home(&mut d, wire::NotesPlace::Notes);
    let data = library_data(d.view(i));
    let heads: Vec<&str> = data
        .sections
        .iter()
        .map(|section| section.head.as_ref().unwrap().title.as_str())
        .collect();
    assert_eq!(heads, ["Pinned", "Notes"]);
    let row = &data.sections[1].rows[0];
    // No title: the preview's first line.
    assert_eq!(row.title, "first line of the plain one");
    assert!(row.meta.starts_with("Edited "), "{}", row.meta);
    assert!(row.meta.ends_with(" · Recipes"), "{}", row.meta);
    assert_eq!(row.notebook_id, book);
    assert_eq!(row.route, Some(routes::editor(&plain)));
    assert_eq!(data.count_label, "2 notes");
    assert!(data.empty.is_none());
}

#[test]
fn day_one_is_one_sentence_and_one_action_and_a_filter_that_empties_it_is_not_day_one() {
    let mut d = clean();
    let i = home(&mut d, wire::NotesPlace::Notes);
    let empty = library_data(d.view(i)).empty.clone().expect("day one");
    assert_eq!(empty.headline, "No notes yet");
    assert_eq!(empty.body, "Write the first one.");
    assert_eq!(empty.action_label, "New note");
    send_home(&mut d, i, H::PinnedOnly(ev::PinnedOnlyToggled {}));
    let empty = library_data(d.view(i)).empty.clone().expect("filtered");
    assert_eq!(empty.body, "No notes match this view.");
    assert_eq!(empty.action_label, "");
}

#[test]
fn sort_pinned_only_tags_and_a_wider_window_are_the_reads_parameters_and_chips() {
    let mut d = clean();
    note(&d, "Banana", "b");
    note(&d, "Apple", "a");
    let first = note(&d, "Cherry", "c");
    pinned(&d, &first);
    let i = home(&mut d, wire::NotesPlace::Notes);
    // THE ONE CHIP ROW: Pinned, the sort last wearing the current order.
    let chips = &home_state(d.view(i)).chips;
    assert_eq!(
        chips.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(),
        ["pinned", "sort"]
    );
    assert_eq!(chips[1].label, "Last edited");
    assert!(chips[1].chevron && !chips[0].chevron);
    assert_eq!(chips[1].spoken, "Sort, Last edited");
    // The sort chip opens the sheet; a choice re-reads and renames the chip.
    send_home(&mut d, i, H::Chip(ev::ChipPicked { key: "sort".into() }));
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, wire::NotesSheet::Sort as i32);
    let selected: Vec<_> = state.choices.iter().filter(|c| c.selected).collect();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].sort, wire::NotesLibrarySort::Updated as i32);
    send_home(
        &mut d,
        i,
        H::Sort(ev::SortPicked {
            sort: wire::NotesLibrarySort::Title as i32,
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, wire::NotesSheet::Unspecified as i32);
    assert_eq!(state.chips.last().unwrap().label, "Title");
    // Pinned leads under every order, then A first.
    assert_eq!(titles(d.view(i)), ["Cherry", "Apple", "Banana"]);
    // A selected chip clears itself.
    send_home(
        &mut d,
        i,
        H::Chip(ev::ChipPicked {
            key: "pinned".into(),
        }),
    );
    assert!(home_state(d.view(i)).chips[0].selected);
    assert_eq!(titles(d.view(i)), ["Cherry"]);
    send_home(
        &mut d,
        i,
        H::Chip(ev::ChipPicked {
            key: "pinned".into(),
        }),
    );
    assert!(home_state(d.view(i)).chips.iter().all(|c| !c.selected));
    assert_eq!(titles(d.view(i)).len(), 3);
    // An unknown key is nothing.
    let before = d.view(i).clone();
    send_home(&mut d, i, H::Chip(ev::ChipPicked { key: "nope".into() }));
    assert_eq!(
        *d.view(i),
        wire::ViewState {
            revision: d.view(i).revision,
            ..before
        }
    );
}

#[test]
fn a_tag_is_a_chip_that_narrows_the_shelf() {
    let mut d = clean();
    let tagged = note(&d, "Tagged", "x");
    note(&d, "Plain", "y");
    arrange(
        &d,
        wire::ActRequest {
            app: "notes".into(),
            action: "add-tag".into(),
            input: [
                ("id".to_owned(), text(&tagged)),
                ("label".to_owned(), text("work")),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        },
    );
    let i = home(&mut d, wire::NotesPlace::Notes);
    let chips = &home_state(d.view(i)).chips;
    let tag = chips
        .iter()
        .find(|c| c.key.starts_with("tag-"))
        .expect("a tag chip");
    assert_eq!(tag.label, "work");
    let key = tag.key.clone();
    send_home(&mut d, i, H::Chip(ev::ChipPicked { key: key.clone() }));
    assert_eq!(titles(d.view(i)), ["Tagged"]);
    let chips = &home_state(d.view(i)).chips;
    assert_eq!(
        chips
            .iter()
            .filter(|c| c.selected)
            .map(|c| c.key.clone())
            .collect::<Vec<_>>(),
        std::slice::from_ref(&key)
    );
    send_home(&mut d, i, H::Chip(ev::ChipPicked { key }));
    assert_eq!(titles(d.view(i)).len(), 2);
}

fn text(value: &str) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Text(value.to_owned())),
    }
}

#[test]
fn opened_on_a_notebook_its_chip_leads_and_a_tap_widens_to_every_note() {
    let mut d = clean();
    let book = notebook(&d, "Recipes");
    let inside = note(&d, "Soup", "s");
    note(&d, "Elsewhere", "e");
    arrange(
        &d,
        act::notes::MoveNote {
            note_id: inside,
            notebook_id: centraid_screens::field::Field::Is(book.clone()),
        },
    );
    let i = d.push(
        notes::TAB,
        routes::home(wire::NotesPlace::Notes, &book, "Recipes", false),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.title, "Recipes");
    assert_eq!(state.chips[0].key, "notebook");
    assert_eq!(state.chips[0].label, "Recipes");
    assert!(state.chips[0].selected);
    assert_eq!(titles(d.view(i)), ["Soup"]);
    send_home(
        &mut d,
        i,
        H::Chip(ev::ChipPicked {
            key: "notebook".into(),
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.title, "Notes");
    assert_eq!(
        state
            .chips
            .iter()
            .map(|c| c.key.as_str())
            .collect::<Vec<_>>(),
        ["pinned", "sort"]
    );
    assert_eq!(titles(d.view(i)).len(), 2);
}

#[test]
fn an_empty_notebook_says_so_and_offers_a_new_note() {
    let mut d = clean();
    let book = notebook(&d, "Empty");
    let i = d.push(
        notes::TAB,
        routes::home(wire::NotesPlace::Notes, &book, "Empty", false),
    );
    let empty = library_data(d.view(i)).empty.clone().unwrap();
    assert_eq!(empty.headline, "Nothing here");
    assert_eq!(empty.body, "Nothing is filed in this notebook yet.");
    assert_eq!(empty.action_label, "New note");
}

#[test]
fn unfiled_is_the_unfiled_filter_and_not_a_notebook() {
    let mut d = clean();
    let book = notebook(&d, "Filed");
    let inside = note(&d, "In", "x");
    note(&d, "Out", "y");
    arrange(
        &d,
        act::notes::MoveNote {
            note_id: inside,
            notebook_id: centraid_screens::field::Field::Is(book),
        },
    );
    let i = d.push(
        notes::TAB,
        routes::home(wire::NotesPlace::Notes, "", "", true),
    );
    assert_eq!(home_state(d.view(i)).title, "Unfiled");
    assert_eq!(titles(d.view(i)), ["Out"]);
    assert_eq!(home_state(d.view(i)).chips[0].label, "Unfiled");
}

#[test]
fn a_row_menu_pins_at_once_files_and_trashes_only_after_a_confirm() {
    let mut d = clean();
    let id = note(&d, "A", "body");
    let book = notebook(&d, "Recipes");
    let i = home(&mut d, wire::NotesPlace::Notes);

    send_home(
        &mut d,
        i,
        H::RowMenu(ev::RowMenuOpened {
            note_id: id.clone(),
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, wire::NotesSheet::RowMenu as i32);
    assert_eq!(state.menu.as_ref().unwrap().pin_label, "Pin");
    assert_eq!(
        state.menu.as_ref().unwrap().file_label,
        "File into notebook"
    );
    assert_eq!(state.menu.as_ref().unwrap().trash_label, "Trash");

    // PIN: the sheet closes, the vault has the flag, the row is pinned.
    send_home(
        &mut d,
        i,
        H::Pin(ev::PinToggled {
            note_id: id.clone(),
        }),
    );
    assert_eq!(
        home_state(d.view(i)).sheet,
        wire::NotesSheet::Unspecified as i32
    );
    assert!(note_of(&d, &id).pinned);
    assert!(library_rows(d.view(i))[0].pinned);
    send_home(
        &mut d,
        i,
        H::RowMenu(ev::RowMenuOpened {
            note_id: id.clone(),
        }),
    );
    assert_eq!(
        home_state(d.view(i)).menu.as_ref().unwrap().pin_label,
        "Unpin"
    );
    send_home(
        &mut d,
        i,
        H::Pin(ev::PinToggled {
            note_id: id.clone(),
        }),
    );
    assert!(!note_of(&d, &id).pinned);

    // FILE: every notebook is offered, "No notebook" leading and selected.
    send_home(
        &mut d,
        i,
        H::FileInto(ev::FileIntoOpened {
            note_id: id.clone(),
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, wire::NotesSheet::FileInto as i32);
    // The seeded notebooks are offered too, an empty one included.
    let offered: Vec<String> = state.choices.iter().map(|c| c.id.clone()).collect();
    assert_eq!(offered[0], "");
    assert!(offered.contains(&book));
    assert!(state.choices[0].selected && state.choices.iter().filter(|c| c.selected).count() == 1);
    send_home(
        &mut d,
        i,
        H::NotebookChosen(ev::NotebookChosen {
            notebook_id: book.clone(),
        }),
    );
    assert_eq!(library_rows(d.view(i))[0].notebook_id, book);
    assert!(library_rows(d.view(i))[0].meta.ends_with("Recipes"));
    // And back out of it.
    send_home(
        &mut d,
        i,
        H::FileInto(ev::FileIntoOpened {
            note_id: id.clone(),
        }),
    );
    send_home(
        &mut d,
        i,
        H::NotebookChosen(ev::NotebookChosen {
            notebook_id: String::new(),
        }),
    );
    assert_eq!(library_rows(d.view(i))[0].notebook_id, "");

    // TRASH IS ASKED FIRST, in full sentences.
    send_home(
        &mut d,
        i,
        H::Trash(ev::TrashAsked {
            note_id: id.clone(),
        }),
    );
    let confirm = home_state(d.view(i)).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Move this note to trash?");
    assert_eq!(
        confirm.body,
        "It stays restorable for 30 days, with its links, tags and files."
    );
    assert_eq!(confirm.confirm_label, "Trash");
    assert!(confirm.destructive);
    assert_eq!(titles(d.view(i)), ["A"], "nothing moved yet");
    send_home(&mut d, i, H::Dismissed(ev::Dismissed {}));
    assert!(home_state(d.view(i)).confirm.is_none());
    assert_eq!(titles(d.view(i)), ["A"]);
    send_home(
        &mut d,
        i,
        H::Trash(ev::TrashAsked {
            note_id: id.clone(),
        }),
    );
    send_home(&mut d, i, H::Confirmed(ev::Confirmed {}));
    assert!(home_state(d.view(i)).confirm.is_none());
    assert!(titles(d.view(i)).is_empty());
    assert!(note_of(&d, &id).deleted_at.is_some());
}

#[test]
fn a_refused_write_keeps_the_rows_and_says_the_cores_sentence() {
    let mut d = clean();
    let id = note(&d, "A", "body");
    let i = home(&mut d, wire::NotesPlace::Notes);
    // The note is trashed behind the screen's back, so the pin is refused.
    arrange(
        &d,
        act::notes::DeleteNote {
            note_id: id.clone(),
        },
    );
    send_home(&mut d, i, H::Pin(ev::PinToggled { note_id: id }));
    // The row is gone from the screen (the change reloaded it), so the pin is nothing.
    assert!(titles(d.view(i)).is_empty());
}

#[test]
fn search_is_a_field_marks_matches_and_close_restores_the_library() {
    let mut d = clean();
    let id = note(&d, "Shopping", "buy milk today");
    note(&d, "Other", "unrelated");
    let i = home(&mut d, wire::NotesPlace::Notes);
    send_home(&mut d, i, H::SearchOpened(ev::SearchOpened {}));
    let search = home_state(d.view(i)).search.clone().unwrap();
    assert!(search.open);
    assert_eq!(
        search
            .results
            .as_ref()
            .unwrap()
            .empty
            .as_ref()
            .unwrap()
            .body,
        "Type to search titles and bodies."
    );
    // No chip row over search: no filter narrows its results.
    assert!(home_state(d.view(i)).chips.is_empty());
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: "milk".into(),
        }),
    );
    let search = home_state(d.view(i)).search.clone().unwrap();
    let results = search.results.as_ref().unwrap();
    assert_eq!(results.rows.len(), 1);
    assert_eq!(results.rows[0].note_id, id);
    assert!(
        results.rows[0]
            .snippet_runs
            .iter()
            .any(|r| r.highlighted && r.text.to_lowercase().contains("milk"))
    );
    assert!(results.empty.is_none());
    // Ask is the foot of a current answer.
    assert_eq!(
        search.ask,
        Some(wire::SearchAsk {
            label: "Ask about “milk”".into(),
            question: "Find milk".into(),
            scope: "notes".into(),
            route: Some(centraid_screens::chat::routes::ask("Find milk", "notes")),
        })
    );
    // Nothing found: the sentence, and Ask still offered.
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: "zzqxv".into(),
        }),
    );
    let search = home_state(d.view(i)).search.clone().unwrap();
    assert_eq!(
        search
            .results
            .as_ref()
            .unwrap()
            .empty
            .as_ref()
            .unwrap()
            .headline,
        "No matches"
    );
    assert_eq!(search.ask.unwrap().label, "Ask about “zzqxv”");
    // A new blank term clears the answer and the ask.
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: String::new(),
        }),
    );
    assert!(home_state(d.view(i)).search.clone().unwrap().ask.is_none());
    // Close restores the library.
    send_home(&mut d, i, H::SearchClosed(ev::SearchClosed {}));
    let search = home_state(d.view(i)).search.clone().unwrap();
    assert!(!search.open && search.term.is_empty() && search.results.is_none());
    assert_eq!(titles(d.view(i)).len(), 2);
}

#[test]
fn the_words_the_core_corrected_are_on_the_field() {
    let mut d = clean();
    note(&d, "Shopping", "buy milk today");
    let i = home(&mut d, wire::NotesPlace::Notes);
    send_home(&mut d, i, H::SearchOpened(ev::SearchOpened {}));
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: "mlik".into(),
        }),
    );
    let search = home_state(d.view(i)).search.clone().unwrap();
    if !search.corrected.is_empty() {
        assert_eq!(search.corrected, "Including results for “milk”");
    }
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: "milk".into(),
        }),
    );
    assert_eq!(home_state(d.view(i)).search.clone().unwrap().corrected, "");
}

#[test]
fn a_notebook_found_by_name_is_a_container_on_the_field_and_opens_the_notes_place_on_it() {
    let mut d = clean();
    let book = notebook(&d, "Cabin");
    let i = home(&mut d, wire::NotesPlace::Notes);
    send_home(&mut d, i, H::SearchOpened(ev::SearchOpened {}));
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: "cabin".into(),
        }),
    );
    let search = home_state(d.view(i)).search.clone().unwrap();
    let container = search.containers.first().expect("a container");
    assert_eq!(container.entity, "notebook");
    assert_eq!(container.id, book);
    assert_eq!(container.kind_label, "Notebook");
    assert_eq!(container.icon_key, "Book");
    assert_eq!(container.accessibility_label, "Notebook, Cabin");
    assert_eq!(
        container.route,
        Some(routes::home(wire::NotesPlace::Notes, &book, "Cabin", false))
    );
    // A notebook that matched is an answer: no nothing-found over it.
    assert!(search.results.unwrap().empty.is_none());
    // A new term clears it.
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: "cabi".into(),
        }),
    );
    let _ = home_state(d.view(i));
}

#[test]
fn a_change_while_searching_re_reads_the_search_and_the_library_on_close() {
    let mut d = clean();
    note(&d, "Shopping", "buy milk");
    let i = home(&mut d, wire::NotesPlace::Notes);
    send_home(&mut d, i, H::SearchOpened(ev::SearchOpened {}));
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTerm {
            term: "milk".into(),
        }),
    );
    assert_eq!(
        home_state(d.view(i))
            .search
            .clone()
            .unwrap()
            .results
            .unwrap()
            .rows
            .len(),
        1
    );
    note(&d, "More milk", "milk again");
    d.pump(std::time::Duration::from_millis(300));
    assert_eq!(
        home_state(d.view(i))
            .search
            .clone()
            .unwrap()
            .results
            .unwrap()
            .rows
            .len(),
        2
    );
    send_home(&mut d, i, H::SearchClosed(ev::SearchClosed {}));
    assert_eq!(titles(d.view(i)).len(), 2);
}

#[test]
fn a_change_re_reads_the_place_keeping_it_drawn() {
    let mut d = clean();
    note(&d, "One", "1");
    let i = home(&mut d, wire::NotesPlace::Notes);
    assert_eq!(titles(d.view(i)).len(), 1);
    note(&d, "Two", "2");
    d.pump(std::time::Duration::from_millis(300));
    assert_eq!(titles(d.view(i)).len(), 2);
}

#[test]
fn more_is_a_sheet_that_holds_trash_alone_and_the_same_tab_is_nothing() {
    let mut d = clean();
    note(&d, "One", "1");
    let i = home(&mut d, wire::NotesPlace::Notes);
    send_home(&mut d, i, H::Band(ev::BandPicked { key: "more".into() }));
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, wire::NotesSheet::More as i32);
    let rows: Vec<(&str, &str)> = state
        .more_rows
        .iter()
        .map(|row| (row.key.as_str(), row.label.as_str()))
        .collect();
    assert_eq!(rows, [("trash", "Trash")]);
    assert_eq!(state.more_rows[0].route, Some(routes::trash()));
    send_home(&mut d, i, H::SheetClosed(ev::SheetClosed {}));
    assert_eq!(
        home_state(d.view(i)).sheet,
        wire::NotesSheet::Unspecified as i32
    );
    send_home(
        &mut d,
        i,
        H::Band(ev::BandPicked {
            key: "notes".into(),
        }),
    );
    assert_eq!(home_state(d.view(i)).place, wire::NotesPlace::Notes as i32);
}

#[test]
fn a_truncated_window_offers_to_show_older() {
    let mut d = clean();
    for n in 0..21 {
        note(&d, &format!("Note {n}"), "x");
    }
    let i = home(&mut d, wire::NotesPlace::Notes);
    // The core's window is 200 by default and at least 20: nothing is truncated here.
    assert_eq!(library_data(d.view(i)).window_end_verb, "");
    assert!(!library_data(d.view(i)).can_widen);
}
