//! `photos.picker`, through a real core: the port of `PhotoPickerSpec`.

mod photos_w2_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::photos;
use centraid_screens::testing::Driver;
use photos_w2_support::*;
use wire::photos_picker_event as ev;

fn open(d: &mut Driver, album_id: &str, name: &str) -> u64 {
    d.push(photos::TAB, photos::routes::picker(album_id, name))
}

#[test]
fn both_pickers_are_sheets_and_the_pages_beside_them_are_not() {
    assert!(photos::routes::picker("album", "Portugal").sheet);
    assert!(photos::routes::attach_picker().sheet);
    assert!(!photos::routes::places().sheet);
    assert!(!photos::routes::editor("photo").sheet);
}

fn state(d: &Driver, instance: u64) -> &wire::PhotosPickerState {
    match &d.view(instance).kind {
        Some(wire::view_state::Kind::PhotosPicker(state)) => state,
        other => panic!("not a picker: {other:?}"),
    }
}

/// The picker's page must be Empty (never ready data), and this is its sentence.
fn empty(d: &Driver, instance: u64) -> &wire::EmptyState {
    let state = state(d, instance);
    assert!(state.content.is_none(), "nothing left carries no data");
    match state.page.as_ref().and_then(|page| page.state.as_ref()) {
        Some(wire::page_state::State::Empty(empty)) => empty,
        other => panic!("expected the empty state, found {other:?}"),
    }
}

fn data(d: &Driver, instance: u64) -> &wire::PhotosPickerData {
    let state = state(d, instance);
    match &state.content {
        Some(wire::photos_picker_state::Content::Data(data)) => data,
        None => panic!("no data: {:?}", state.page),
    }
}

fn cell<'a>(d: &'a Driver, instance: u64, id: &str) -> &'a wire::PhotosPickerCell {
    data(d, instance)
        .cells
        .iter()
        .find(|cell| cell.tile.as_ref().is_some_and(|tile| tile.photo_id == id))
        .unwrap_or_else(|| panic!("{id} is not drawn"))
}

fn send(d: &mut Driver, instance: u64, kind: ev::Kind) {
    d.send(
        instance,
        wire::screen_event::Kind::PhotosPicker(wire::PhotosPickerEvent { kind: Some(kind) }),
    );
}

fn pick(d: &mut Driver, instance: u64, id: &str) {
    send(
        d,
        instance,
        ev::Kind::Pick(ev::PickToggled {
            photo_id: id.to_owned(),
        }),
    );
}

#[test]
fn the_head_names_the_album_before_anything_is_chosen() {
    let mut d = driver();
    let album_id = album(&d, "Portugal");
    let picker = open(&mut d, &album_id, "Portugal");
    let view = state(&d, picker);
    assert_eq!(view.title, "Add to “Portugal”");
    assert_eq!(view.chosen_label, "Nothing chosen yet");
    assert_eq!(view.add_label, "Add");
    assert!(!view.add_enabled);
    assert_eq!(
        view.refers_note,
        "An album points to a photo where it lives."
    );
}

#[test]
fn what_the_album_already_holds_is_drawn_taken_and_cannot_be_picked() {
    let mut d = driver();
    let (held, free) = (photo(&d, "held"), photo(&d, "free"));
    let album_id = album(&d, "Trip");
    put_in(&d, &album_id, &held);
    let picker = open(&mut d, &album_id, "Trip");
    assert!(cell(&d, picker, &held).taken);
    assert!(!cell(&d, picker, &free).taken);
    pick(&mut d, picker, &held);
    assert!(
        !cell(&d, picker, &held).picked,
        "a taken cell does not tick"
    );
    assert!(!state(&d, picker).add_enabled);
}

#[test]
fn a_taken_cell_is_spoken_in_the_picker_s_own_words() {
    let mut d = driver();
    let held = photo(&d, "held");
    let album_id = album(&d, "Trip");
    put_in(&d, &album_id, &held);
    let picker = open(&mut d, &album_id, "Trip");
    assert_eq!(data(&d, picker).taken_label, "Already in this album");
}

#[test]
fn a_pick_is_a_toggle_and_the_button_counts() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    let album_id = album(&d, "Trip");
    let picker = open(&mut d, &album_id, "Trip");
    pick(&mut d, picker, &a);
    pick(&mut d, picker, &b);
    assert!(cell(&d, picker, &a).picked && cell(&d, picker, &b).picked);
    assert_eq!(state(&d, picker).chosen_label, "2 chosen");
    assert_eq!(state(&d, picker).add_label, "Add 2");
    pick(&mut d, picker, &a);
    assert!(!cell(&d, picker, &a).picked);
    assert_eq!(state(&d, picker).add_label, "Add 1");
    // A photograph the screen is not showing is not a pick.
    pick(&mut d, picker, "nothing");
    assert_eq!(state(&d, picker).add_label, "Add 1");
}

#[test]
fn confirm_adds_each_pick_to_the_album_and_finishes_when_all_landed() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    let album_id = album(&d, "Trip");
    let picker = open(&mut d, &album_id, "Trip");
    // Nothing picked: nothing written, not finished.
    send(&mut d, picker, ev::Kind::Confirm(ev::ConfirmRequested {}));
    assert!(!state(&d, picker).finished);

    pick(&mut d, picker, &a);
    pick(&mut d, picker, &b);
    send(&mut d, picker, ev::Kind::Confirm(ev::ConfirmRequested {}));
    assert!(state(&d, picker).finished);
    // The line goes to the album beneath (its own test below); the closing picker still holds it.
    assert_eq!(
        state(&d, picker)
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some("2 photos added to Trip.")
    );
    assert!(cell(&d, picker, &a).taken && cell(&d, picker, &b).taken);
    assert!(!cell(&d, picker, &a).picked);

    let shelf = d.push(
        photos::TAB,
        photos::routes::shelf(wire::PhotosShelfKind::Album, &album_id, "Trip"),
    );
    let Some(wire::view_state::Kind::PhotosShelf(shelf)) = &d.view(shelf).kind else {
        panic!("a shelf");
    };
    let Some(wire::photos_shelf_state::Content::Data(members)) = &shelf.content else {
        panic!("data");
    };
    assert_eq!(members.cells.len(), 2);
}

#[test]
fn a_refused_add_keeps_the_pick_and_the_grid_and_says_why() {
    let mut d = driver();
    let (good, gone) = (photo(&d, "good"), photo(&d, "gone"));
    let album_id = album(&d, "Trip");
    let picker = open(&mut d, &album_id, "Trip");
    pick(&mut d, picker, &good);
    pick(&mut d, picker, &gone);
    // The photograph was trashed elsewhere while the member was choosing.
    trash(&d, &gone);
    send(&mut d, picker, ev::Kind::Confirm(ev::ConfirmRequested {}));
    let view = state(&d, picker);
    assert!(!view.finished);
    let status = view.status.as_ref().expect("the vault's sentence");
    assert!(status.refused && !status.sentence.is_empty());
    assert!(view.content.is_some());
    // The one that landed is taken; the one the vault refused is still picked.
    assert!(cell(&d, picker, &good).taken);
    assert_eq!(view.add_label, "Add 1");
    // Asking again asks again: the pick is still there to retry from.
    send(&mut d, picker, ev::Kind::Confirm(ev::ConfirmRequested {}));
    assert!(state(&d, picker).status.is_some() && !state(&d, picker).finished);
}

#[test]
fn an_album_that_holds_the_whole_library_says_there_is_nothing_left() {
    let mut d = driver();
    let album_id = album(&d, "All");
    let picker = open(&mut d, &album_id, "All");
    let ids: Vec<String> = data(&d, picker)
        .cells
        .iter()
        .map(|cell| cell.tile.as_ref().unwrap().photo_id.clone())
        .collect();
    for id in &ids {
        pick(&mut d, picker, id);
    }
    send(&mut d, picker, ev::Kind::Confirm(ev::ConfirmRequested {}));
    let empty = empty(&d, picker);
    assert_eq!(
        empty.headline,
        "Everything in your library is already in this album."
    );
}

#[test]
fn adding_several_leaves_one_line_with_one_undo_on_the_album_beneath() {
    let mut d = driver();
    let photos: Vec<String> = ["a", "b", "c"].iter().map(|s| photo(&d, s)).collect();
    let album_id = album(&d, "Portugal");
    let shelf = d.push(
        photos::TAB,
        photos::routes::shelf(wire::PhotosShelfKind::Album, &album_id, ""),
    );
    let picker = open(&mut d, &album_id, "Portugal");
    for id in &photos {
        pick(&mut d, picker, id);
    }
    send(&mut d, picker, ev::Kind::Confirm(ev::ConfirmRequested {}));
    assert!(state(&d, picker).finished, "the picker closes");
    d.pop(photos::TAB, picker);

    let line = |d: &Driver| match &d.view(shelf).kind {
        Some(wire::view_state::Kind::PhotosShelf(state)) => {
            let status = state.status.clone().expect("a line");
            (status.sentence, status.action_label)
        }
        other => panic!("not a shelf: {other:?}"),
    };
    assert_eq!(
        line(&d),
        ("3 photos added to Portugal.".to_owned(), "Undo".to_owned())
    );
    let held = |d: &Driver| match &d.view(shelf).kind {
        Some(wire::view_state::Kind::PhotosShelf(state)) => match &state.content {
            Some(wire::photos_shelf_state::Content::Data(data)) => data.cells.len(),
            None => 0,
        },
        other => panic!("not a shelf: {other:?}"),
    };
    assert_eq!(held(&d), 3);
    d.send(
        shelf,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
    assert_eq!(held(&d), 0, "one Undo took all three out of the album");
    assert_eq!(line(&d), ("Undone".to_owned(), String::new()));
}
