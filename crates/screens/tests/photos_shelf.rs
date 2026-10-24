//! `photos.shelf`, through a real core: the port of `PhotoShelfSpec`, plus the
//! two defects the Kotlin screens had (Empty Trash purged more than the trash
//! showed; a trashed album had no restore).

mod photos_w2_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::photos;
use centraid_screens::testing::Driver;
use photos_w2_support::*;
use wire::photos_batch_action::Kind as Verb;
use wire::photos_selection_event as sel;
use wire::photos_shelf_event as ev;
use wire::photos_shelf_state::Prompt;

fn open(d: &mut Driver, kind: wire::PhotosShelfKind, id: &str) -> u64 {
    d.push(photos::TAB, photos::routes::shelf(kind, id, ""))
}

fn state(d: &Driver, instance: u64) -> &wire::PhotosShelfState {
    match &d.view(instance).kind {
        Some(wire::view_state::Kind::PhotosShelf(state)) => state,
        other => panic!("not a shelf: {other:?}"),
    }
}

fn data(d: &Driver, instance: u64) -> &wire::PhotosShelfData {
    match &state(d, instance).content {
        Some(wire::photos_shelf_state::Content::Data(data)) => data,
        other => panic!("the shelf has no data: {other:?}"),
    }
}

fn shown(d: &Driver, instance: u64) -> Vec<String> {
    let mut shown: Vec<String> = data(d, instance)
        .cells
        .iter()
        .map(|cell| cell.tile.as_ref().expect("a tile").photo_id.clone())
        .collect();
    shown.sort();
    shown
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

fn send(d: &mut Driver, instance: u64, kind: ev::Kind) -> wire::ScreenUpdate {
    d.send(
        instance,
        wire::screen_event::Kind::PhotosShelf(wire::PhotosShelfEvent { kind: Some(kind) }),
    )
}

fn select(d: &mut Driver, instance: u64, kind: sel::Kind) {
    send(
        d,
        instance,
        ev::Kind::Selection(wire::PhotosSelectionEvent { kind: Some(kind) }),
    );
}

fn pick(d: &mut Driver, instance: u64, id: &str) {
    select(d, instance, sel::Kind::Toggled(sel::Toggled { photo_id: id.to_owned() }));
}

fn tap(d: &mut Driver, instance: u64, verb: Verb) {
    select(d, instance, sel::Kind::Action(sel::ActionTapped { kind: verb as i32 }));
}

fn confirm_selection(d: &mut Driver, instance: u64) {
    select(d, instance, sel::Kind::Confirmed(sel::Confirmed {}));
}

fn prompt(d: &mut Driver, instance: u64, prompt: Prompt) {
    send(d, instance, ev::Kind::PromptOpened(ev::PromptOpened { prompt: prompt as i32 }));
}

fn confirm_prompt(d: &mut Driver, instance: u64) {
    send(d, instance, ev::Kind::PromptConfirmed(ev::PromptConfirmed {}));
}

// -- Empty Trash (defect a) ---------------------------------------------------

#[test]
fn empty_trash_purges_exactly_the_photographs_the_trash_shows() {
    let mut d = driver();
    let (a, b, c) = (photo(&d, "a"), photo(&d, "b"), photo(&d, "c"));
    let late = photo(&d, "late");
    for id in [&a, &b, &c] {
        trash(&d, id);
    }
    let trash_shelf = open(&mut d, wire::PhotosShelfKind::Trash, "");
    assert_eq!(shown(&d, trash_shelf), sorted(vec![a.clone(), b.clone(), c.clone()]));
    assert_eq!(
        data(&d, trash_shelf).empty_trash_label.as_deref(),
        Some("Empty trash")
    );

    // Something is trashed elsewhere AFTER the member looked, and before they
    // confirm. It was not shown, so it is not purged.
    trash(&d, &late);
    prompt(&mut d, trash_shelf, Prompt::EmptyTrash);
    assert_eq!(state(&d, trash_shelf).prompt, Prompt::EmptyTrash as i32);
    confirm_prompt(&mut d, trash_shelf);

    let after = open(&mut d, wire::PhotosShelfKind::Trash, "");
    assert_eq!(shown(&d, after), vec![late.clone()], "only what was not shown is left");
    assert!(state(&d, trash_shelf).status.is_none());
}

#[test]
fn empty_trash_is_offered_on_the_trash_only_and_a_dismissed_sheet_purges_nothing() {
    let mut d = driver();
    let a = photo(&d, "a");
    star(&d, &a);
    let favorites = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    prompt(&mut d, favorites, Prompt::EmptyTrash);
    assert_eq!(state(&d, favorites).prompt, Prompt::None as i32);
    assert_eq!(data(&d, favorites).empty_trash_label, None);

    trash(&d, &a);
    let trash_shelf = open(&mut d, wire::PhotosShelfKind::Trash, "");
    prompt(&mut d, trash_shelf, Prompt::EmptyTrash);
    send(&mut d, trash_shelf, ev::Kind::PromptDismissed(ev::PromptDismissed {}));
    confirm_prompt(&mut d, trash_shelf);
    assert_eq!(shown(&d, trash_shelf), vec![a]);
}

// -- Restore (defect b) -------------------------------------------------------

#[test]
fn a_trashed_photograph_is_restored_from_the_trash_shelf() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    trash(&d, &a);
    trash(&d, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Trash, "");
    pick(&mut d, shelf, &a);
    let verbs: Vec<i32> = state(&d, shelf)
        .selection
        .as_ref()
        .expect("a bar")
        .actions
        .iter()
        .map(|action| action.kind)
        .collect();
    assert_eq!(verbs, vec![Verb::Restore as i32, Verb::DeleteForever as i32]);
    tap(&mut d, shelf, Verb::Restore);
    assert_eq!(shown(&d, shelf), vec![b], "the restored photograph left the trash");
    assert!(!state(&d, shelf).selection.as_ref().expect("a bar").selecting);
}

#[test]
fn a_trashed_album_can_be_restored_from_its_shelf() {
    let mut d = driver();
    let kept = photo(&d, "kept");
    let album_id = album(&d, "Portugal");
    put_in(&d, &album_id, &kept);
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &album_id);
    assert!(!state(&d, shelf).album.as_ref().expect("an album").trashed);
    send(&mut d, shelf, ev::Kind::PromptOpened(ev::PromptOpened { prompt: Prompt::DeleteAlbum as i32 }));
    confirm_prompt(&mut d, shelf);
    assert!(state(&d, shelf).dismissed, "a deleted album closes its shelf");

    // The trash lists it; opening it offers the way back.
    let again = open(&mut d, wire::PhotosShelfKind::Album, &album_id);
    let head = state(&d, again).album.as_ref().expect("an album");
    assert!(head.trashed);
    assert_eq!(head.trashed_note, "This album is in the trash.");
    send(&mut d, again, ev::Kind::AlbumRestored(ev::AlbumRestored {}));
    let head = state(&d, again).album.as_ref().expect("an album");
    assert!(!head.trashed, "restored");
    assert_eq!(shown(&d, again), vec![kept]);
}
