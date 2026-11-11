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
    let state = state(d, instance);
    match &state.data {
        Some(data) => data,
        None => panic!("the shelf has no data: {:?}", state.page),
    }
}

fn shown(d: &Driver, instance: u64) -> Vec<String> {
    // A shelf that holds nothing is the page's Empty state, which carries no cells.
    let state = state(d, instance);
    if state.data.is_none()
        && matches!(
            state.page.as_ref().and_then(|page| page.state.as_ref()),
            Some(wire::page_state::State::Empty(_))
        )
    {
        return Vec::new();
    }
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
    select(
        d,
        instance,
        sel::Kind::Toggled(sel::Toggled {
            photo_id: id.to_owned(),
        }),
    );
}

fn tap(d: &mut Driver, instance: u64, verb: Verb) {
    select(
        d,
        instance,
        sel::Kind::Action(sel::ActionTapped { kind: verb as i32 }),
    );
}

fn confirm_selection(d: &mut Driver, instance: u64) {
    select(d, instance, sel::Kind::Confirmed(sel::Confirmed {}));
}

fn prompt(d: &mut Driver, instance: u64, prompt: Prompt) {
    send(
        d,
        instance,
        ev::Kind::PromptOpened(ev::PromptOpened {
            prompt: prompt as i32,
        }),
    );
}

fn confirm_prompt(d: &mut Driver, instance: u64) {
    send(
        d,
        instance,
        ev::Kind::PromptConfirmed(ev::PromptConfirmed {}),
    );
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
    assert_eq!(
        shown(&d, trash_shelf),
        sorted(vec![a.clone(), b.clone(), c.clone()])
    );
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
    assert_eq!(
        shown(&d, after),
        vec![late.clone()],
        "only what was not shown is left"
    );
    assert!(state(&d, trash_shelf).status.is_none());
}

#[test]
fn empty_trash_is_offered_on_the_trash_only_and_a_dismissed_sheet_purges_nothing() {
    let mut d = driver();
    let a = photo(&d, "a");
    star(&d, &a);
    let favorites = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    prompt(&mut d, favorites, Prompt::EmptyTrash);
    assert_eq!(state(&d, favorites).prompt, Prompt::Unspecified as i32);
    assert_eq!(data(&d, favorites).empty_trash_label, None);

    trash(&d, &a);
    let trash_shelf = open(&mut d, wire::PhotosShelfKind::Trash, "");
    prompt(&mut d, trash_shelf, Prompt::EmptyTrash);
    send(
        &mut d,
        trash_shelf,
        ev::Kind::PromptDismissed(ev::PromptDismissed {}),
    );
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
    assert_eq!(
        verbs,
        vec![Verb::Restore as i32, Verb::DeleteForever as i32]
    );
    tap(&mut d, shelf, Verb::Restore);
    assert_eq!(
        shown(&d, shelf),
        vec![b],
        "the restored photograph left the trash"
    );
    assert!(
        !state(&d, shelf)
            .selection
            .as_ref()
            .expect("a bar")
            .selecting
    );
}

#[test]
fn a_trashed_album_can_be_restored_from_its_shelf() {
    let mut d = driver();
    let kept = photo(&d, "kept");
    let album_id = album(&d, "Portugal");
    put_in(&d, &album_id, &kept);
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &album_id);
    assert!(!state(&d, shelf).album.as_ref().expect("an album").trashed);
    send(
        &mut d,
        shelf,
        ev::Kind::PromptOpened(ev::PromptOpened {
            prompt: Prompt::DeleteAlbum as i32,
        }),
    );
    confirm_prompt(&mut d, shelf);
    assert!(
        state(&d, shelf).dismissed,
        "a deleted album closes its shelf"
    );

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

// -- Titles, empty sentences, the rule ----------------------------------------

/// The shelf's page must be Empty (never ready data), and this is its sentence.
fn empty(d: &Driver, instance: u64) -> &wire::EmptyState {
    let state = state(d, instance);
    assert!(state.data.is_none(), "an empty shelf carries no data");
    match state.page.as_ref().and_then(|page| page.state.as_ref()) {
        Some(wire::page_state::State::Empty(empty)) => empty,
        other => panic!("expected the empty state, found {other:?}"),
    }
}

fn headline(d: &Driver, instance: u64) -> String {
    empty(d, instance).headline.clone()
}

/// The seeded scenario holds photographs on every shelf: trash them all, then
/// empty the trash through the screen, so each shelf is truly empty.
fn clear_library(d: &mut Driver) {
    use centraid_screens::catalog::load;
    use centraid_screens::kit::read::{self, Reading};
    for view in [
        load::photos::ShelfView::Live,
        load::photos::ShelfView::Archive,
    ] {
        let ids: Vec<String> = d.with_ctx(|ctx| {
            match read::read(
                ctx,
                load::photos::Shelf {
                    limit: 200,
                    view,
                    after: None,
                    id: None,
                },
                |answer| match answer {
                    wire::app_query_response::Answer::PhotosShelf(shelf) => Some(*shelf),
                    _ => None,
                },
            ) {
                Reading::Data(shelf) => shelf.cells.into_iter().map(|cell| cell.photo_id).collect(),
                other => panic!("{other:?}"),
            }
        });
        for id in ids {
            trash(d, &id);
        }
    }
    let trash_shelf = open(d, wire::PhotosShelfKind::Trash, "");
    prompt(d, trash_shelf, Prompt::EmptyTrash);
    confirm_prompt(d, trash_shelf);
    assert!(shown(d, trash_shelf).is_empty(), "the library is clear");
}

#[test]
fn every_shelf_has_its_own_title_and_its_own_sentence_when_empty() {
    use wire::PhotosShelfKind as K;
    let mut d = driver();
    clear_library(&mut d);
    let cases = [
        (
            K::Favorites,
            "Favorites",
            "No favorites yet — tap the heart on any photo.",
        ),
        (K::Archive, "Archive", "Archive is empty."),
        (K::Trash, "Trash", "Trash is empty."),
        (
            K::Videos,
            "Videos",
            "Videos you capture or import collect here.",
        ),
        (K::Unplaced, "No location yet", "Every photo has a place."),
    ];
    for (kind, title, sentence) in cases {
        let shelf = open(&mut d, kind, "");
        assert_eq!(state(&d, shelf).title, title);
        assert_eq!(headline(&d, shelf), sentence);
    }
    let album_id = album(&d, "Portugal");
    let shelf = open(&mut d, K::Album, &album_id);
    assert_eq!(state(&d, shelf).title, "Portugal");
    let place = d.push(
        photos::TAB,
        photos::routes::shelf(K::Place, "no-such-place", "Lisbon"),
    );
    assert_eq!(headline(&d, place), "No photos at Lisbon yet.");
    assert_eq!(headline(&d, shelf), "Nothing in this album yet.");
    assert_eq!(
        empty(&d, shelf).body,
        "An album points to a photo where it lives."
    );
}

#[test]
fn the_trash_states_its_rule_and_no_other_shelf_does() {
    use wire::PhotosShelfKind as K;
    let mut d = driver();
    let trash_shelf = open(&mut d, K::Trash, "");
    assert_eq!(
        state(&d, trash_shelf).purge_window,
        "Photos here are deleted forever 30 days after you trash them."
    );
    let favorites = open(&mut d, K::Favorites, "");
    assert_eq!(state(&d, favorites).purge_window, "");
}

#[test]
fn a_shelf_without_its_kind_is_not_a_screen() {
    let mut d = driver();
    let route = photos::routes::shelf(wire::PhotosShelfKind::Unspecified, "", "");
    assert!(
        d.try_call(wire::screen_request::Kind::Nav(wire::NavEvent {
            kind: Some(wire::nav_event::Kind::Push(wire::NavPush {
                tab: photos::TAB.to_owned(),
                route: Some(route),
            })),
        }))
        .is_err()
    );
}

#[test]
fn the_count_is_exact_when_the_shelf_is_whole_and_a_cell_opens_its_photograph() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    let album_id = album(&d, "Trip");
    put_in(&d, &album_id, &a);
    put_in(&d, &album_id, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &album_id);
    assert_eq!(data(&d, shelf).count_label, "2 photos");
    assert!(!data(&d, shelf).can_show_more);
    let cell = &data(&d, shelf).cells[0];
    let Some(wire::route::Args::PhotosLightbox(route)) =
        cell.open.as_ref().and_then(|route| route.args.clone())
    else {
        panic!("a cell opens the lightbox");
    };
    assert_eq!(route.photo_id, cell.tile.as_ref().expect("tile").photo_id);
    assert_eq!(route.album_id, album_id);
    assert_eq!(route.neighbour_ids.len(), 2);
}

// -- The pick -----------------------------------------------------------------

#[test]
fn a_pick_survives_a_reload_and_leaving_the_mode_empties_it() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    star(&d, &a);
    star(&d, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    pick(&mut d, shelf, &a);
    assert_eq!(
        state(&d, shelf).selection.as_ref().unwrap().selected_ids,
        vec![a.clone()]
    );
    assert!(state(&d, shelf).selection.as_ref().unwrap().selecting);
    // Something moved under the shelf: it reads again, the pick stays.
    d.send(
        shelf,
        wire::screen_event::Kind::DataChanged(wire::DataChanged::default()),
    );
    assert_eq!(
        state(&d, shelf).selection.as_ref().unwrap().selected_ids,
        vec![a]
    );
    select(
        &mut d,
        shelf,
        sel::Kind::Mode(sel::ModeSet { selecting: false }),
    );
    let selection = state(&d, shelf).selection.as_ref().unwrap();
    assert!(!selection.selecting && selection.selected_ids.is_empty());
}

#[test]
fn a_new_shelf_starts_with_nothing_picked() {
    let mut d = driver();
    let a = photo(&d, "a");
    star(&d, &a);
    let first = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    pick(&mut d, first, &a);
    let second = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    assert!(
        state(&d, second)
            .selection
            .as_ref()
            .unwrap()
            .selected_ids
            .is_empty()
    );
}

#[test]
fn the_archives_restore_is_an_unarchive_and_the_photograph_leaves_it() {
    let mut d = driver();
    let a = photo(&d, "a");
    arrange(
        &d,
        centraid_screens::catalog::act::photos::ArchivePhoto {
            photo_id: a.clone(),
        },
    );
    let shelf = open(&mut d, wire::PhotosShelfKind::Archive, "");
    assert_eq!(shown(&d, shelf), vec![a.clone()]);
    pick(&mut d, shelf, &a);
    tap(&mut d, shelf, Verb::Unarchive);
    assert!(shown(&d, shelf).is_empty());
    // It is live again, not trashed.
    let favorites = open(&mut d, wire::PhotosShelfKind::Videos, "");
    let _ = favorites;
}

#[test]
fn move_to_trash_asks_nothing_and_delete_forever_asks_first() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    star(&d, &a);
    star(&d, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    pick(&mut d, shelf, &a);
    tap(&mut d, shelf, Verb::Trash);
    assert!(
        state(&d, shelf)
            .selection
            .as_ref()
            .unwrap()
            .confirm
            .is_none()
    );
    assert!(!shown(&d, shelf).contains(&a) && shown(&d, shelf).contains(&b));
    let status = state(&d, shelf).status.clone().expect("a status line");
    assert_eq!(status.sentence, "1 photo moved to trash");
    assert_eq!(status.action_label, "Undo");

    let trash_shelf = open(&mut d, wire::PhotosShelfKind::Trash, "");
    assert_eq!(shown(&d, trash_shelf), vec![a.clone()]);
    pick(&mut d, trash_shelf, &a);
    tap(&mut d, trash_shelf, Verb::DeleteForever);
    assert!(
        state(&d, trash_shelf)
            .selection
            .as_ref()
            .unwrap()
            .confirm
            .is_some()
    );
    assert_eq!(shown(&d, trash_shelf), vec![a.clone()]);
    confirm_selection(&mut d, trash_shelf);
    assert!(shown(&d, trash_shelf).is_empty());
}

#[test]
fn a_refused_write_keeps_the_rows_and_the_pick_and_says_why() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    star(&d, &a);
    star(&d, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    pick(&mut d, shelf, &a);
    // Another surface trashed it while the member was choosing.
    trash(&d, &a);
    tap(&mut d, shelf, Verb::Trash);
    confirm_selection(&mut d, shelf);
    let view = state(&d, shelf);
    let status = view.status.as_ref().expect("the vault's sentence");
    assert!(status.refused && !status.sentence.is_empty());
    assert!(view.data.is_some());
    assert_eq!(view.selection.as_ref().unwrap().selected_ids, vec![a]);
}

// -- An album -----------------------------------------------------------------

#[test]
fn an_album_renames_covers_removes_and_deletes() {
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    let album_id = album(&d, "Trip");
    put_in(&d, &album_id, &a);
    put_in(&d, &album_id, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &album_id);

    // The album's own add goes to the picker over this album.
    let head = state(&d, shelf).album.clone().expect("an album");
    let Some(wire::route::Args::PhotosPicker(picker)) = head.add_route.and_then(|r| r.args) else {
        panic!("add opens the picker");
    };
    assert_eq!(
        (picker.album_id.as_str(), picker.album_name.as_str()),
        (album_id.as_str(), "Trip")
    );

    // Rename retitles the head; the same name and a blank one write nothing.
    send(
        &mut d,
        shelf,
        ev::Kind::PromptOpened(ev::PromptOpened {
            prompt: Prompt::RenameAlbum as i32,
        }),
    );
    assert_eq!(
        state(&d, shelf).rename.as_ref().expect("a sheet").current,
        "Trip"
    );
    send(
        &mut d,
        shelf,
        ev::Kind::AlbumRenamed(ev::AlbumRenamed {
            title: "  Portugal ".to_owned(),
        }),
    );
    assert_eq!(state(&d, shelf).title, "Portugal");
    assert_eq!(state(&d, shelf).prompt, Prompt::Unspecified as i32);
    send(
        &mut d,
        shelf,
        ev::Kind::AlbumRenamed(ev::AlbumRenamed {
            title: "   ".to_owned(),
        }),
    );
    assert_eq!(state(&d, shelf).title, "Portugal");

    // Make key photo wants exactly one pick.
    pick(&mut d, shelf, &a);
    pick(&mut d, shelf, &b);
    assert!(!state(&d, shelf).bar.as_ref().unwrap().make_key_enabled);
    send(&mut d, shelf, ev::Kind::CoverChosen(ev::CoverChosen {}));
    pick(&mut d, shelf, &b);
    assert!(state(&d, shelf).bar.as_ref().unwrap().make_key_enabled);
    send(&mut d, shelf, ev::Kind::CoverChosen(ev::CoverChosen {}));
    let status = state(&d, shelf).status.clone().expect("a line");
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Cover changed", "Undo")
    );

    // Remove takes the reference and never the photograph.
    tap(&mut d, shelf, Verb::RemoveFromAlbum);
    assert_eq!(shown(&d, shelf), vec![b.clone()]);
    let all = open(&mut d, wire::PhotosShelfKind::Trash, "");
    assert!(shown(&d, all).is_empty());

    // Deleting asks first and closes the shelf; the photographs stay.
    send(
        &mut d,
        shelf,
        ev::Kind::PromptOpened(ev::PromptOpened {
            prompt: Prompt::DeleteAlbum as i32,
        }),
    );
    assert_eq!(
        state(&d, shelf).confirm.as_ref().unwrap().title,
        "Delete this album?"
    );
    assert!(!state(&d, shelf).dismissed);
    confirm_prompt(&mut d, shelf);
    assert!(state(&d, shelf).dismissed);
}

#[test]
fn the_sheet_adds_the_pick_to_another_album_and_leaves_this_one_out_of_its_list() {
    let mut d = driver();
    let a = photo(&d, "a");
    let (here, there) = (album(&d, "Here"), album(&d, "There"));
    put_in(&d, &here, &a);
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &here);
    pick(&mut d, shelf, &a);
    tap(&mut d, shelf, Verb::AddToAlbum);
    let sheet = state(&d, shelf).album_choice.clone().expect("a sheet");
    assert!(sheet.open);
    let titles: Vec<String> = sheet.entries.iter().map(|e| e.title.clone()).collect();
    assert!(titles.contains(&"There".to_owned()));
    assert!(
        !titles.contains(&"Here".to_owned()),
        "an album is not offered itself"
    );
    send(
        &mut d,
        shelf,
        ev::Kind::AlbumChoice(wire::PhotosAlbumChoiceEvent {
            kind: Some(wire::photos_album_choice_event::Kind::Chosen(
                wire::photos_album_choice_event::Chosen {
                    album_id: there.clone(),
                },
            )),
        }),
    );
    assert!(!state(&d, shelf).album_choice.as_ref().unwrap().open);
    let there_shelf = open(&mut d, wire::PhotosShelfKind::Album, &there);
    assert_eq!(shown(&d, there_shelf), vec![a]);
}

#[test]
fn the_keep_switch_is_the_cores_list_and_only_an_albums() {
    let mut d = driver();
    let album_id = album(&d, "Trip");
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &album_id);
    let row = state(&d, shelf).keep_originals.clone().expect("a switch");
    assert!(row.ready && !row.keep);
    assert_eq!(row.meta, "Included in Free up space");
    send(
        &mut d,
        shelf,
        ev::Kind::KeepToggled(ev::KeepToggled { keep: true }),
    );
    let row = state(&d, shelf).keep_originals.clone().unwrap();
    assert!(row.keep);
    assert_eq!(row.meta, "Kept out of Free up space");
    // Open again: the list remembers.
    let again = open(&mut d, wire::PhotosShelfKind::Album, &album_id);
    assert!(state(&d, again).keep_originals.as_ref().unwrap().keep);
    let favorites = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    assert!(state(&d, favorites).keep_originals.is_none());
}

// -- Send a copy, Download original ------------------------------------------

fn exported(
    status: wire::originals_exported::Status,
    handed: u32,
    missing: u32,
) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OriginalsExported(wire::OriginalsExported {
        status: status as i32,
        handed,
        missing,
    })
}

#[test]
fn send_a_copy_asks_how_much_place_travels_then_hands_the_pick_to_the_platform() {
    use wire::originals_exported::Status;
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    star(&d, &a);
    star(&d, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    // Nothing picked: no sheet.
    prompt(&mut d, shelf, Prompt::SendLocation);
    assert_eq!(state(&d, shelf).prompt, Prompt::Unspecified as i32);

    pick(&mut d, shelf, &a);
    pick(&mut d, shelf, &b);
    prompt(&mut d, shelf, Prompt::SendLocation);
    let choice = state(&d, shelf).location_choice.clone().expect("a choice");
    assert_eq!(choice.title, "Include which location?");
    assert_eq!(
        (choice.none_label.as_str(), choice.exact_label.as_str()),
        ("No location", "Exact location")
    );
    d.effects.clear();
    send(
        &mut d,
        shelf,
        ev::Kind::LocationChosen(ev::LocationChosen { exact: false }),
    );
    // The tap raises the owner check and nothing leaves yet.
    assert_eq!(d.effects.len(), 1);
    assert!(matches!(
        d.effects[0].effect.clone().and_then(|e| e.kind),
        Some(wire::effect::Kind::OwnerCheck(c)) if c.ask
    ));
    d.answer_effect(owner_checked(wire::owner_checked::Outcome::Succeeded));
    assert_eq!(d.effects.len(), 1);
    let Some(wire::effect::Kind::ExportOriginals(export)) =
        d.effects[0].effect.clone().and_then(|e| e.kind)
    else {
        panic!("an export");
    };
    assert_eq!(export.photo_ids, vec![a.clone(), b.clone()]);
    assert_eq!(export.mode, wire::export_originals::Mode::Send as i32);
    assert!(!export.keep_location, "no location unless asked for");

    // The sheet says what it did; the screen says only what did not go.
    d.answer_effect(exported(Status::Done, 1, 1));
    assert_eq!(
        state(&d, shelf).notice,
        "1 original is not on this phone, so it was left out."
    );
    // The pick stays: a copy writes nothing.
    assert_eq!(
        state(&d, shelf)
            .selection
            .as_ref()
            .unwrap()
            .selected_ids
            .len(),
        2
    );

    d.effects.clear();
    send(&mut d, shelf, ev::Kind::Download(ev::DownloadRequested {}));
    let Some(wire::effect::Kind::ExportOriginals(save)) =
        d.effects[0].effect.clone().and_then(|e| e.kind)
    else {
        panic!("an export");
    };
    assert_eq!(save.mode, wire::export_originals::Mode::Save as i32);
    d.answer_effect(exported(Status::Done, 2, 0));
    assert_eq!(state(&d, shelf).notice, "2 saved to your photos.");

    d.effects.clear();
    send(&mut d, shelf, ev::Kind::Download(ev::DownloadRequested {}));
    d.answer_effect(exported(Status::NoneHere, 0, 2));
    assert_eq!(
        state(&d, shelf).notice,
        "The originals are not on this phone, so nothing was sent."
    );
    send(&mut d, shelf, ev::Kind::Download(ev::DownloadRequested {}));
    d.answer_effect(exported(Status::LocationNotRemovable, 0, 0));
    assert_eq!(
        state(&d, shelf).notice,
        "Could not remove the location from every file, so nothing was sent."
    );
    send(&mut d, shelf, ev::Kind::Download(ev::DownloadRequested {}));
    d.answer_effect(wire::effect_result::Outcome::Failed(
        wire::EffectFailed::default(),
    ));
    assert_eq!(state(&d, shelf).notice, "Photos not exported. Try again.");
}

// -- The trash keeps the uniform promise in the kit's words (#1185) ----------------

/// The trash is a grid of thumbnails, not the kit's list, and says everything the kit's trash says,
/// word for word: Restore, "Delete this photo forever?" with the confirm "Delete forever", and the
/// whole-trash confirm. "Empty trash" is the shared verb: when the trash is still what the shelf
/// showed, it empties it.
#[test]
fn the_trash_says_the_kits_words_and_empties_through_the_shared_verb() {
    use centraid_screens::kit::trash;
    use centraid_screens::strings::{Locale, shared};
    let mut d = driver();
    let (a, b) = (photo(&d, "a"), photo(&d, "b"));
    trash(&d, &a);
    trash(&d, &b);
    let shelf = open(&mut d, wire::PhotosShelfKind::Trash, "");
    pick(&mut d, shelf, &a);
    let labels: Vec<(Verb, String)> = state(&d, shelf)
        .selection
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .map(|action| (action.kind(), action.label.clone()))
        .collect();
    assert_eq!(
        labels,
        [
            (Verb::Restore, shared::trash_restore(Locale::En)),
            (Verb::DeleteForever, shared::trash_purge(Locale::En)),
        ],
        "the trash offers Restore and Delete forever, nothing else"
    );
    tap(&mut d, shelf, Verb::DeleteForever);
    let confirm = state(&d, shelf)
        .selection
        .as_ref()
        .unwrap()
        .confirm
        .clone()
        .expect("a confirm");
    assert_eq!(
        confirm.title,
        trash::purge_title(Locale::En, shared::trash_noun_photo)
    );
    assert_eq!(confirm.confirm_label, shared::trash_purge(Locale::En));
    assert!(confirm.destructive);

    // Empty trash, in the kit's sentences, through `empty-trash`: both photographs go.
    send(
        &mut d,
        shelf,
        ev::Kind::PromptDismissed(ev::PromptDismissed {}),
    );
    prompt(&mut d, shelf, Prompt::EmptyTrash);
    let confirm = state(&d, shelf).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, shared::trash_empty_title(Locale::En));
    assert_eq!(confirm.body, shared::trash_empty_body(Locale::En));
    assert_eq!(
        confirm.confirm_label,
        shared::trash_empty_action(Locale::En)
    );
    confirm_prompt(&mut d, shelf);
    assert!(shown(&d, shelf).is_empty(), "the trash is empty");
    assert!(state(&d, shelf).status.is_none());
}

fn owner_checked(outcome: wire::owner_checked::Outcome) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available: outcome != wire::owner_checked::Outcome::Unavailable,
        biometry: wire::Biometry::Face as i32,
        outcome: outcome as i32,
    })
}

#[test]
fn a_send_that_is_not_confirmed_sends_nothing_and_no_passcode_warns() {
    use wire::owner_checked::Outcome as C;
    let mut d = driver();
    let a = photo(&d, "owner");
    star(&d, &a);
    let shelf = open(&mut d, wire::PhotosShelfKind::Favorites, "");
    pick(&mut d, shelf, &a);
    let ask = |d: &mut Driver| {
        d.effects.clear();
        send(
            d,
            shelf,
            ev::Kind::LocationChosen(ev::LocationChosen { exact: false }),
        );
    };
    ask(&mut d);
    d.answer_effect(owner_checked(C::Cancelled));
    assert!(d.effects.is_empty());
    assert!(state(&d, shelf).notice.is_empty());
    ask(&mut d);
    d.answer_effect(owner_checked(C::Failed));
    assert!(d.effects.is_empty());
    assert!(!state(&d, shelf).notice.is_empty());
    ask(&mut d);
    d.answer_effect(owner_checked(C::Unavailable));
    assert!(matches!(
        d.effects[0].effect.clone().and_then(|e| e.kind),
        Some(wire::effect::Kind::ExportOriginals(_))
    ));
    assert!(state(&d, shelf).notice.contains("no passcode"));
}

// -- A batch of several is one line with one Undo (#1185) -------------------------------

fn line_of(d: &Driver, shelf: u64) -> (String, String) {
    let status = state(d, shelf).status.clone().expect("a status line");
    assert!(!status.refused, "{status:?}");
    (status.sentence, status.action_label)
}

fn undo(d: &mut Driver, shelf: u64) {
    d.send(
        shelf,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
}

fn favorites_of(d: &Driver, shelf: u64) -> Vec<bool> {
    data(d, shelf)
        .cells
        .iter()
        .map(|cell| cell.tile.as_ref().expect("a tile").favorite)
        .collect()
}

/// Pick all of `ids` on `shelf` and tap `verb`.
fn batch(d: &mut Driver, shelf: u64, ids: &[String], verb: Verb) {
    for id in ids {
        pick(d, shelf, id);
    }
    tap(d, shelf, verb);
}

#[test]
fn a_batch_of_three_says_so_once_with_one_undo_that_takes_back_all_three() {
    let mut d = driver();
    let photos: Vec<String> = ["a", "b", "c"].iter().map(|s| photo(&d, s)).collect();
    let (here, there) = (album(&d, "Here"), album(&d, "There"));
    for id in &photos {
        put_in(&d, &here, id);
    }
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &here);
    let all = sorted(photos.clone());
    let undone = ("Undone".to_owned(), String::new());

    // FAVOURITE, then UNFAVOURITE.
    batch(&mut d, shelf, &photos, Verb::Favorite);
    assert_eq!(
        line_of(&d, shelf),
        ("3 photos added to Favorites.".to_owned(), "Undo".to_owned())
    );
    assert!(favorites_of(&d, shelf).iter().all(|on| *on));
    undo(&mut d, shelf);
    assert!(favorites_of(&d, shelf).iter().all(|on| !*on));
    assert_eq!(line_of(&d, shelf), undone);

    for id in &photos {
        star(&d, id);
    }
    send(&mut d, shelf, ev::Kind::Refreshed(ev::Refreshed {}));
    batch(&mut d, shelf, &photos, Verb::Unfavorite);
    assert_eq!(
        line_of(&d, shelf),
        (
            "3 photos removed from Favorites.".to_owned(),
            "Undo".to_owned()
        )
    );
    undo(&mut d, shelf);
    assert!(favorites_of(&d, shelf).iter().all(|on| *on));

    // ARCHIVE.
    batch(&mut d, shelf, &photos, Verb::Archive);
    assert_eq!(
        line_of(&d, shelf),
        (
            "3 photos moved to the archive.".to_owned(),
            "Undo".to_owned()
        )
    );
    let archive_shelf = open(&mut d, wire::PhotosShelfKind::Archive, "");
    assert_eq!(shown(&d, archive_shelf), all);
    undo(&mut d, shelf);
    send(&mut d, archive_shelf, ev::Kind::Refreshed(ev::Refreshed {}));
    assert!(
        shown(&d, archive_shelf).is_empty(),
        "one Undo unarchived all three"
    );

    // ADD TO ANOTHER ALBUM.
    for id in &photos {
        pick(&mut d, shelf, id);
    }
    tap(&mut d, shelf, Verb::AddToAlbum);
    send(
        &mut d,
        shelf,
        ev::Kind::AlbumChoice(wire::PhotosAlbumChoiceEvent {
            kind: Some(wire::photos_album_choice_event::Kind::Chosen(
                wire::photos_album_choice_event::Chosen {
                    album_id: there.clone(),
                },
            )),
        }),
    );
    assert_eq!(
        line_of(&d, shelf),
        ("3 photos added to There.".to_owned(), "Undo".to_owned())
    );
    let there_shelf = open(&mut d, wire::PhotosShelfKind::Album, &there);
    assert_eq!(shown(&d, there_shelf), all);
    undo(&mut d, shelf);
    assert_eq!(line_of(&d, shelf), undone);
    send(&mut d, there_shelf, ev::Kind::Refreshed(ev::Refreshed {}));
    assert!(
        shown(&d, there_shelf).is_empty(),
        "one Undo took all three out"
    );

    // REMOVE FROM THIS ALBUM.
    batch(&mut d, shelf, &photos, Verb::RemoveFromAlbum);
    assert_eq!(
        line_of(&d, shelf),
        (
            "3 photos removed from the album".to_owned(),
            "Undo".to_owned()
        )
    );
    assert!(shown(&d, shelf).is_empty());
    undo(&mut d, shelf);
    assert_eq!(shown(&d, shelf), all);

    // TRASH, then RESTORE from the trash.
    batch(&mut d, shelf, &photos, Verb::Trash);
    assert_eq!(
        line_of(&d, shelf),
        ("3 photos moved to trash".to_owned(), "Undo".to_owned())
    );
    assert!(shown(&d, shelf).is_empty());
    let trash_shelf = open(&mut d, wire::PhotosShelfKind::Trash, "");
    batch(&mut d, trash_shelf, &photos, Verb::Restore);
    assert_eq!(
        line_of(&d, trash_shelf),
        ("3 photos restored".to_owned(), "Undo".to_owned())
    );
    assert!(shown(&d, trash_shelf).is_empty());
    undo(&mut d, trash_shelf);
    assert_eq!(
        shown(&d, trash_shelf),
        all,
        "one Undo trashed all three again"
    );
}

#[test]
fn a_batch_that_one_photograph_refuses_says_so_and_keeps_the_undo_of_the_others() {
    let mut d = driver();
    let photos: Vec<String> = ["a", "b", "c"].iter().map(|s| photo(&d, s)).collect();
    let here = album(&d, "Here");
    for id in &photos {
        put_in(&d, &here, id);
    }
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &here);
    for id in &photos {
        pick(&mut d, shelf, id);
    }
    // Another surface trashed one while the member was choosing.
    trash(&d, &photos[1]);
    tap(&mut d, shelf, Verb::Archive);
    let status = state(&d, shelf).status.clone().expect("a line");
    assert!(status.refused && !status.sentence.is_empty());
    assert_eq!(
        status.action_label, "Undo",
        "the two that landed can be undone"
    );
    undo(&mut d, shelf);
    assert_eq!(
        shown(&d, shelf),
        sorted(vec![photos[0].clone(), photos[2].clone()])
    );
}

#[test]
fn an_undo_that_fails_partway_names_how_many_were_not_undone_and_keeps_the_rest_undone() {
    let mut d = driver();
    let photos: Vec<String> = ["a", "b", "c"].iter().map(|s| photo(&d, s)).collect();
    let here = album(&d, "Here");
    for id in &photos {
        put_in(&d, &here, id);
    }
    let shelf = open(&mut d, wire::PhotosShelfKind::Album, &here);
    batch(&mut d, shelf, &photos, Verb::Trash);
    assert_eq!(
        line_of(&d, shelf),
        ("3 photos moved to trash".to_owned(), "Undo".to_owned())
    );
    // Another surface brought one back already: putting it back again is refused.
    arrange(
        &d,
        centraid_screens::catalog::act::photos::RestorePhoto {
            photo_id: photos[1].clone(),
        },
    );
    undo(&mut d, shelf);
    let status = state(&d, shelf).status.clone().expect("a line");
    assert_eq!(
        (
            status.sentence.as_str(),
            status.action_label.as_str(),
            status.refused
        ),
        ("1 change was not undone", "", true)
    );
    assert_eq!(
        shown(&d, shelf),
        sorted(photos),
        "the other two stay undone"
    );
}
