//! The Notes editor's page and toolbar (#1173): the line over the title and the
//! checklist key. Through `Driver`, like the rest of Notes' tests.

mod notes_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use notes_support::*;
use wire::notes_editor_event::{self as ev, Kind as N};

fn open(d: &mut Driver, id: &str) -> u64 {
    d.push(notes::TAB, routes::editor(id))
}

fn body_of(v: &wire::ViewState) -> String {
    match &editor_state(v).draft {
        Some(draft) => draft.body.clone(),
        None => panic!("not a draft: {:?}", editor_state(v).page),
    }
}

#[test]
fn the_line_over_the_title_names_the_notebook_then_the_edit_day() {
    let mut d = driver();
    let id = note(&d, "Lisbon trip", "Flights are booked");
    let i = open(&mut d, &id);
    // Filed nowhere: the day alone.
    let unfiled = editor_state(d.view(i)).meta.clone();
    assert!(unfiled.starts_with("Edited "), "{unfiled}");
    assert!(!unfiled.contains(" · "), "{unfiled}");
    // Filed: the notebook's name leads.
    let travel = notebook(&d, "Travel");
    arrange(
        &d,
        act::notes::MoveNote {
            note_id: id.clone(),
            notebook_id: centraid_screens::field::Field::Is(travel),
        },
    );
    send_editor(&mut d, i, N::Refreshed(ev::Refreshed {}));
    let filed = editor_state(d.view(i)).meta.clone();
    assert_eq!(filed, format!("Travel · {unfiled}"));
    // A note that does not exist yet has no line.
    let fresh = d.push(notes::TAB, routes::new_note());
    assert_eq!(editor_state(d.view(fresh)).meta, "");
}

#[test]
fn a_row_carries_its_own_actions_as_words_on_the_home_chrome() {
    let mut d = driver();
    clear_notes(&d);
    let id = note(&d, "A", "body");
    let i = home(&mut d, wire::NotesPlace::Notes);
    let chrome = home_state(d.view(i)).chrome.clone().unwrap();
    assert_eq!(
        (
            chrome.pin_label.as_str(),
            chrome.unpin_label.as_str(),
            chrome.file_label.as_str(),
            chrome.trash_label.as_str()
        ),
        ("Pin", "Unpin", "File into notebook", "Trash")
    );
    // The long press and the swipe send the row's own events: a pin is a write at once.
    send_home(
        &mut d,
        i,
        wire::notes_home_event::Kind::Pin(wire::notes_home_event::PinToggled {
            note_id: id.clone(),
        }),
    );
    assert!(library_rows(d.view(i))[0].pinned);
}

#[test]
fn the_checklist_key_starts_an_unchecked_line_on_its_own_line() {
    let mut d = driver();
    let id = note(&d, "Packing", "Passport");
    let i = open(&mut d, &id);
    let chrome = editor_state(d.view(i)).chrome.clone().unwrap();
    assert_eq!(chrome.checklist_label, "Checklist");
    assert_eq!(chrome.keyboard_label, "Hide keyboard");
    send_editor(&mut d, i, N::ChecklistRequested(ev::ChecklistRequested {}));
    assert_eq!(body_of(d.view(i)), "Passport\n- [ ] ");
    // A second key adds a second line.
    send_editor(&mut d, i, N::ChecklistRequested(ev::ChecklistRequested {}));
    assert_eq!(body_of(d.view(i)), "Passport\n- [ ] \n- [ ] ");
    d.pump(Duration::from_millis(1500));
    assert_eq!(note_of(&d, &id).body, "Passport\n- [ ] \n- [ ] ");
}
