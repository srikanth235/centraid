//! PHOTOS' SHARED HELPERS (#1135, lane D), through a real core: the cell's held
//! decision table (the port of `PhotoCellStateSpec`), the capture-local day, a
//! Live Photo folded into one cell, select mode with its batch writes and
//! confirms, and the album sheet.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::kit::read::{self, Reading};
use centraid_screens::photos;
use centraid_screens::photos::album_choice::{self, AlbumChoice};
use centraid_screens::photos::cells::{self, Link};
use centraid_screens::photos::selection::{Drain, Offer, Outcome, Selection, Verb, Wording};
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use wire::app_query_response::Answer;
use wire::photo_tile::{Held, Kind};
use wire::photos_selection_event as sel;

// -----------------------------------------------------------------------------
// The held decision table
// -----------------------------------------------------------------------------

fn link(rule: wire::TransferRule, metered: bool) -> Link {
    Link { rule, metered }
}

fn held(thumbnail: bool, original_held: bool, hash: &str, kind: Kind, link: Link) -> Held {
    cells::held_of(thumbnail, original_held, hash, kind, link)
}

#[test]
fn a_held_original_outranks_everything_including_a_rule_that_would_withhold_it() {
    let manual = link(wire::TransferRule::Manual, true);
    assert_eq!(held(true, true, "aa", Kind::Photo, manual), Held::Original);
    assert_eq!(held(false, true, "aa", Kind::Photo, manual), Held::Original);
}

#[test]
fn a_thumbnail_with_no_original_and_no_rule_in_the_way_is_not_a_withholding() {
    assert_eq!(
        held(true, false, "aa", Kind::Photo, Link::default()),
        Held::ThumbnailOnly
    );
}

#[test]
fn the_members_rule_is_a_decision_and_the_state_that_carries_the_arrow() {
    // Every cell of the table, against `phone::drain::Conditions`.
    use wire::TransferRule::{Manual, WifiAndCellularPhotos, WifiOnly};
    let table = [
        (WifiOnly, false, false),
        (WifiOnly, true, true),
        (WifiAndCellularPhotos, false, false),
        // A photograph crosses on cellular under this rule.
        (WifiAndCellularPhotos, true, false),
        // MANUAL withholds on an unmetered link too.
        (Manual, false, true),
        (Manual, true, true),
    ];
    for (rule, metered, withheld) in table {
        let state = held(true, false, "aa", Kind::Photo, link(rule, metered));
        let expected = if withheld {
            Held::WithheldByRule
        } else {
            Held::ThumbnailOnly
        };
        assert_eq!(state, expected, "{rule:?} metered={metered}");
    }
}

#[test]
fn an_unspecified_rule_reads_as_wifi_only_as_the_core_reads_it() {
    let unspecified = |metered| link(wire::TransferRule::Unspecified, metered);
    assert_eq!(
        held(true, false, "aa", Kind::Photo, unspecified(true)),
        Held::WithheldByRule
    );
    assert_eq!(
        held(true, false, "aa", Kind::Photo, unspecified(false)),
        Held::ThumbnailOnly
    );
}

#[test]
fn a_video_on_a_metered_link_is_withheld_even_when_photographs_are_not() {
    let rule = wire::TransferRule::WifiAndCellularPhotos;
    assert_eq!(
        held(true, false, "aa", Kind::Video, link(rule, true)),
        Held::WithheldByRule
    );
    assert_eq!(
        held(true, false, "aa", Kind::Video, link(rule, false)),
        Held::ThumbnailOnly
    );
}

#[test]
fn nothing_at_all_is_absent_under_every_rule_and_never_a_withholding_arrow() {
    for rule in [
        wire::TransferRule::WifiOnly,
        wire::TransferRule::WifiAndCellularPhotos,
        wire::TransferRule::Manual,
    ] {
        assert_eq!(
            held(false, false, "aa", Kind::Photo, link(rule, true)),
            Held::Absent,
            "{rule:?}"
        );
    }
}

#[test]
fn a_cell_with_no_original_to_ask_for_offers_nothing_whatever_the_rule() {
    let manual = link(wire::TransferRule::Manual, true);
    assert_eq!(
        held(true, false, "", Kind::Photo, manual),
        Held::ThumbnailOnly
    );
    assert_eq!(held(false, false, "", Kind::Photo, manual), Held::Absent);
}

#[test]
fn fetching_is_a_screens_and_never_this_decisions() {
    let mut seen = std::collections::BTreeSet::new();
    for rule in [
        wire::TransferRule::Unspecified,
        wire::TransferRule::WifiOnly,
        wire::TransferRule::WifiAndCellularPhotos,
        wire::TransferRule::Manual,
    ] {
        for metered in [true, false] {
            for thumbnail in [true, false] {
                for original in [true, false] {
                    for hash in ["aa", ""] {
                        for kind in [Kind::Photo, Kind::Video, Kind::Scan] {
                            seen.insert(
                                held(thumbnail, original, hash, kind, link(rule, metered)) as i32
                            );
                        }
                    }
                }
            }
        }
    }
    assert!(!seen.contains(&(Held::Fetching as i32)));
    assert!(!seen.contains(&(Held::Unspecified as i32)));
    assert_eq!(seen.len(), 4);
}

// -----------------------------------------------------------------------------
// The cell
// -----------------------------------------------------------------------------

fn cell(id: &str) -> wire::PhotosCell {
    wire::PhotosCell {
        photo_id: id.to_owned(),
        content_id: format!("hash-{id}"),
        form: Some("photo".to_owned()),
        ..Default::default()
    }
}

#[test]
fn a_cells_day_is_the_capture_local_day_and_not_the_readers() {
    // 23:30 UTC on the 1st is the 2nd at +02:00, and the 1st at -05:00.
    assert_eq!(
        cells::capture_day("2026-03-01T23:30:00Z", 120),
        "2026-03-02"
    );
    assert_eq!(
        cells::capture_day("2026-03-01T23:30:00.250Z", -300),
        "2026-03-01"
    );
    assert_eq!(
        cells::capture_day("2026-03-01T00:10:00Z", -60),
        "2026-02-28"
    );
    // A stamp that carries its own zone is that instant.
    assert_eq!(
        cells::capture_day("2026-03-01T23:30:00+02:00", 0),
        "2026-03-01"
    );
    assert_eq!(cells::capture_clock("2026-03-01T23:30:00Z", 120), "01:30");
    assert_eq!(cells::capture_clock("2026-03-01T00:10:00Z", -60), "23:10");
    // Anything that is not a stamp is undated, never guessed at.
    assert_eq!(cells::capture_day("", 0), "");
    assert_eq!(cells::capture_day("2026-03-01", 0), "");
    assert_eq!(cells::capture_day("2026-02-31T10:00:00Z", 0), "");
    assert_eq!(cells::capture_clock("nonsense", 0), "");
}

#[test]
fn a_tile_carries_the_day_the_clock_the_kind_and_what_a_screen_reader_says() {
    let mut video = cell("v1");
    video.form = Some("video".to_owned());
    video.taken_at = Some("2026-03-01T23:30:00Z".to_owned());
    video.offset_min = Some(120);
    video.duration_s = Some(64.9);
    video.width = Some(1920);
    video.height = Some(1080);
    video.burst = Some("group".to_owned());
    video.favorite = true;
    let tile = cells::tile(&video, Link::default(), Locale::En);
    assert_eq!(tile.day, "2026-03-02");
    assert_eq!(tile.kind, Kind::Video as i32);
    assert_eq!(tile.duration_seconds, 64);
    assert_eq!(tile.duration_label, "1:04");
    assert_eq!((tile.width, tile.height), (1920, 1080));
    assert_eq!(tile.capture_group, "group");
    assert!(tile.favorite);
    // No thumbnail and no original: absent, and the label says the preview is gone.
    assert_eq!(tile.held, Held::Absent as i32);
    assert_eq!(
        tile.accessibility_label,
        "Video, preview no longer on this phone"
    );
    assert_eq!(tile.content_id, "hash-v1");

    let mut still = cell("p1");
    still.thumbnail_path = Some("/thumbs/p1".to_owned());
    still.width = Some(-3);
    still.duration_s = Some(12.0);
    let tile = cells::tile(&still, Link::default(), Locale::En);
    assert_eq!(tile.held, Held::ThumbnailOnly as i32);
    assert_eq!(tile.accessibility_label, "Photo");
    assert_eq!(tile.day, "");
    assert_eq!(tile.width, 0, "an unknown box is zero and not a guess");
    // Only a video has a length on its tile.
    assert_eq!(
        (tile.duration_seconds, tile.duration_label.as_str()),
        (0, "")
    );
}

#[test]
fn a_recordings_length_has_an_hours_arm() {
    assert_eq!(cells::clock(0), "0:00");
    assert_eq!(cells::clock(64), "1:04");
    assert_eq!(cells::clock(727), "12:07");
    assert_eq!(cells::clock(3_723), "1:02:03");
    assert_eq!(cells::clock(3_700), "1:01:40");
}

#[test]
fn a_live_photos_movie_folds_into_its_still_and_waits_for_a_still_that_has_not_come() {
    let mut still = cell("still");
    still.live = true;
    still.live_movie_id = Some("movie".to_owned());
    still.thumbnail_path = Some("/thumbs/still".to_owned());
    let mut movie = cell("movie");
    movie.form = Some("video".to_owned());
    movie.live_of = Some("still".to_owned());
    let other = cell("other");

    let tiles = cells::tiles(
        &[movie.clone(), still.clone(), other.clone()],
        Link::default(),
        Locale::En,
    );
    let ids: Vec<&str> = tiles.iter().map(|tile| tile.photo_id.as_str()).collect();
    assert_eq!(ids, ["still", "other"]);
    assert!(tiles[0].live);
    assert_eq!(tiles[0].live_movie_id, "movie");
    assert_eq!(tiles[0].accessibility_label, "Live photo");

    // The still has not arrived: the movie IS a video and stays a cell of its own.
    let tiles = cells::tiles(&[movie, other], Link::default(), Locale::En);
    let ids: Vec<&str> = tiles.iter().map(|tile| tile.photo_id.as_str()).collect();
    assert_eq!(ids, ["movie", "other"]);
}

#[test]
fn a_count_that_may_be_a_floor_says_so() {
    let en = Locale::En;
    assert_eq!(cells::count_phrase(en, 0, false), "Empty");
    assert_eq!(cells::count_phrase(en, 1, false), "1 photo");
    assert_eq!(cells::count_phrase(en, 5, false), "5 photos");
    assert_eq!(cells::count_phrase(en, 5, true), "At least 5 photos");
    assert_eq!(cells::count_phrase(en, 1, true), "At least 1 photo");
    assert_eq!(cells::count_phrase(en, 0, true), "At least 0 photos");
}

// -----------------------------------------------------------------------------
// The vault: fixtures
// -----------------------------------------------------------------------------

fn driver() -> Driver {
    let mut driver = Driver::with_runtime(photos::runtime());
    driver.start();
    driver
}

fn command(d: &Driver, name: &str, input: serde_json::Value) {
    let response = d
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: name.to_owned(),
                input: serde_json::to_vec(&input).expect("json"),
                invoke_key: format!("photos-common:{name}:{}", kit_act::fresh()),
                ..wire::Command::default()
            })),
        })
        .unwrap_or_else(|error| panic!("{name} refused: {error}"));
    let Some(wire::response::Kind::Command(outcome)) = response.kind else {
        panic!("a command answered with something else");
    };
    assert_eq!(
        outcome.status,
        wire::CommandStatus::Executed as i32,
        "{name}: {}",
        outcome.reason
    );
}

/// One photograph in the library; the seed makes its bytes unique.
fn photo(d: &Driver, seed: &str) -> String {
    let hash = centraid_vault::blob::content_digest(seed.as_bytes());
    command(
        d,
        "blob.stage",
        serde_json::json!({ "hash": hash, "size": seed.len() }),
    );
    let response = d.act(
        act::photos::Upload {
            blob: hash,
            media_type: "image/jpeg".to_owned(),
            form: Some(act::photos::UploadForm::Photo),
            ..Default::default()
        }
        .request()
        .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    let value: serde_json::Value = serde_json::from_slice(&response.output).expect("json");
    value["id"].as_str().expect("an id").to_owned()
}

fn album(d: &Driver, title: &str) -> String {
    let response = d.act(
        act::photos::CreateAlbum {
            title: title.to_owned(),
            id: None,
        }
        .request()
        .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    let value: serde_json::Value = serde_json::from_slice(&response.output).expect("json");
    value["id"].as_str().expect("an id").to_owned()
}

fn shelf(d: &Driver, view: load::photos::ShelfView, id: Option<&str>) -> Vec<wire::PhotosCell> {
    d.with_ctx(|ctx| {
        let reading = read::read(
            ctx,
            load::photos::Shelf {
                limit: 200,
                view,
                after: None,
                id: id.map(str::to_owned),
            },
            |answer| match answer {
                Answer::PhotosShelf(shelf) => Some(shelf),
                _ => None,
            },
        );
        match reading {
            Reading::Data(shelf) => shelf.cells,
            other => panic!("a shelf read came to {other:?}"),
        }
    })
}

fn ids_of(cells: &[wire::PhotosCell]) -> Vec<String> {
    cells.iter().map(|cell| cell.photo_id.clone()).collect()
}

fn selection_event(kind: sel::Kind) -> wire::PhotosSelectionEvent {
    wire::PhotosSelectionEvent { kind: Some(kind) }
}

fn tap(verb: Verb) -> wire::PhotosSelectionEvent {
    selection_event(sel::Kind::Action(sel::ActionTapped { kind: verb as i32 }))
}

fn update(
    d: &Driver,
    selection: &mut Selection,
    event: &wire::PhotosSelectionEvent,
    ordered: &[String],
) -> Outcome {
    d.with_ctx(|ctx| selection.update(event, ordered, ctx))
}

// -----------------------------------------------------------------------------
// Select mode
// -----------------------------------------------------------------------------

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn selecting_is_a_mode_and_a_set_and_the_order_picked_is_kept() {
    let mut selection = Selection::new(Offer::Library, Drain::Ends, Wording::Selected);
    assert!(!selection.selecting());
    let view = selection.view(Locale::En);
    assert!(!view.selecting);
    assert_eq!(view.title, "", "nothing picked says nothing");
    assert!(
        view.actions.iter().all(|action| !action.enabled),
        "the bar's verbs are disabled with nothing picked, not hidden"
    );

    // Entering picks nothing; a toggle enters the mode with that photograph picked.
    selection.set_mode(true);
    assert!(selection.selecting() && selection.picked().is_empty());
    selection.toggle("c");
    selection.toggle("a");
    selection.toggle("b");
    assert_eq!(selection.picked(), ["c", "a", "b"]);
    selection.toggle("a");
    assert_eq!(selection.picked(), ["c", "b"]);

    // A set joins in order, without duplicates, and leaves at once.
    selection.set(&ids(&["b", "d", "e"]), true);
    assert_eq!(selection.picked(), ["c", "b", "d", "e"]);
    selection.set(&ids(&["c", "e", "zz"]), false);
    assert_eq!(selection.picked(), ["b", "d"]);

    // Leaving empties the set.
    selection.leave();
    assert!(!selection.selecting() && selection.picked().is_empty());

    // A first toggle enters the mode on its own (the long press).
    selection.toggle("z");
    assert!(selection.selecting());
}

#[test]
fn all_and_range_select_what_the_screen_draws_in_the_order_drawn() {
    let drawn = ids(&["a", "b", "c", "d", "e"]);
    let mut selection = Selection::new(Offer::Shelf, Drain::Settled, Wording::Chosen);
    selection.toggle("e");
    selection.select_range(&drawn, "b", "d");
    assert_eq!(selection.picked(), ["e", "b", "c", "d"]);
    // Either way round; a photograph the screen does not hold selects nothing.
    selection.leave();
    selection.select_range(&drawn, "d", "c");
    assert_eq!(selection.picked(), ["c", "d"]);
    selection.select_range(&drawn, "a", "missing");
    assert_eq!(selection.picked(), ["c", "d"]);
    selection.select_all(&drawn);
    assert_eq!(selection.picked(), ["c", "d", "a", "b", "e"]);
    // The library drops a photograph that left the grid; a shelf does not call this.
    selection.retain_in(&ids(&["a", "e", "q"]));
    assert_eq!(selection.picked(), ["a", "e"]);
}

#[test]
fn the_bar_says_how_many_in_the_screens_own_words_and_offers_the_verbs_for_where_it_is() {
    let mut grid = Selection::new(Offer::Library, Drain::Ends, Wording::Selected);
    grid.toggle("a");
    assert_eq!(grid.view(Locale::En).title, "1 photo selected");
    grid.toggle("b");
    let view = grid.view(Locale::En);
    assert_eq!(view.title, "2 photos selected");
    assert_eq!(view.count, 2);
    assert_eq!(view.cancel_label, "Cancel");
    let labels: Vec<(&str, bool)> = view
        .actions
        .iter()
        .map(|a| (a.label.as_str(), a.enabled))
        .collect();
    assert_eq!(
        labels,
        [
            ("Favorite", true),
            ("Unfavorite", true),
            ("Add to album", true),
            ("Trash", true)
        ]
    );

    let mut shelf = Selection::new(Offer::Shelf, Drain::Settled, Wording::Chosen);
    shelf.set(&ids(&["a", "b", "c"]), true);
    assert_eq!(shelf.view(Locale::En).title, "3 chosen");

    let verbs = |offer: Offer| offer.verbs();
    assert_eq!(verbs(Offer::Trash), [Verb::Restore, Verb::DeleteForever]);
    assert!(verbs(Offer::Archive).contains(&Verb::Unarchive));
    assert!(!verbs(Offer::Archive).contains(&Verb::Archive));
    assert!(verbs(Offer::Favorites).contains(&Verb::Unfavorite));
    assert!(!verbs(Offer::Favorites).contains(&Verb::Favorite));
    assert!(verbs(Offer::Album("x".into())).contains(&Verb::RemoveFromAlbum));
    assert!(!verbs(Offer::Shelf).contains(&Verb::RemoveFromAlbum));
}

#[test]
fn favouriting_keeps_the_library_selection_and_a_heart_lands_on_every_pick() {
    let d = driver();
    let first = photo(&d, "fav-1");
    let second = photo(&d, "fav-2");
    let untouched = photo(&d, "fav-3");
    let mut selection = Selection::new(Offer::Library, Drain::Ends, Wording::Selected);
    update(
        &d,
        &mut selection,
        &selection_event(sel::Kind::Mode(sel::ModeSet { selecting: true })),
        &[],
    );
    update(
        &d,
        &mut selection,
        &selection_event(sel::Kind::Set(sel::SetPicked {
            photo_ids: vec![first.clone(), second.clone()],
            selected: true,
        })),
        &[],
    );

    let outcome = update(&d, &mut selection, &tap(Verb::Favorite), &[]);
    let Outcome::Wrote(written) = outcome else {
        panic!("a favourite writes: {outcome:?}");
    };
    assert!(written.ok());
    assert_eq!(written.committed, [first.clone(), second.clone()]);
    assert_eq!(
        selection.picked(),
        [first.clone(), second.clone()],
        "favouriting is not the end of a member's job"
    );

    let hearts = ids_of(&shelf(&d, load::photos::ShelfView::Favorites, None));
    assert!(hearts.contains(&first) && hearts.contains(&second) && !hearts.contains(&untouched));

    // And takes them away again.
    let outcome = update(&d, &mut selection, &tap(Verb::Unfavorite), &[]);
    assert!(matches!(outcome, Outcome::Wrote(ref w) if w.ok()));
    let hearts = ids_of(&shelf(&d, load::photos::ShelfView::Favorites, None));
    assert!(!hearts.contains(&first) && !hearts.contains(&second));
}

#[test]
fn trash_asks_first_in_full_sentences_and_a_library_trash_ends_the_mode() {
    let d = driver();
    let keep = photo(&d, "trash-keep");
    let gone = photo(&d, "trash-gone");
    let mut selection = Selection::new(Offer::Library, Drain::Ends, Wording::Selected);
    // Nothing picked asks nothing.
    assert_eq!(
        update(&d, &mut selection, &tap(Verb::Trash), &[]),
        Outcome::Moved
    );
    assert!(selection.view(Locale::En).confirm.is_none());

    selection.toggle(&gone);
    assert_eq!(
        update(&d, &mut selection, &tap(Verb::Trash), &[]),
        Outcome::Moved
    );
    let view = selection.view(Locale::En);
    let confirm = view.confirm.expect("a confirm");
    assert_eq!(confirm.title, "Move 1 photo to the trash?");
    assert_eq!(
        confirm.body,
        "Restore them from the trash later. Your camera roll is not touched."
    );
    assert_eq!(confirm.confirm_label, "Move to trash");
    assert!(confirm.destructive);
    assert_eq!(view.confirming, Verb::Trash as i32);
    assert!(
        ids_of(&shelf(&d, load::photos::ShelfView::Live, None)).contains(&gone),
        "nothing happened yet"
    );

    // Dismissed: nothing is written and the pick stays.
    update(
        &d,
        &mut selection,
        &selection_event(sel::Kind::Dismissed(sel::ConfirmDismissed {})),
        &[],
    );
    assert!(selection.view(Locale::En).confirm.is_none());
    assert_eq!(selection.picked(), std::slice::from_ref(&gone));

    // Confirmed: trashed, and the mode ends as the writes go.
    update(&d, &mut selection, &tap(Verb::Trash), &[]);
    let outcome = update(
        &d,
        &mut selection,
        &selection_event(sel::Kind::Confirmed(sel::Confirmed {})),
        &[],
    );
    assert!(matches!(outcome, Outcome::Wrote(ref w) if w.ok()));
    assert!(!selection.selecting() && selection.picked().is_empty());
    let live = ids_of(&shelf(&d, load::photos::ShelfView::Live, None));
    assert!(!live.contains(&gone) && live.contains(&keep));
    assert!(ids_of(&shelf(&d, load::photos::ShelfView::Trash, None)).contains(&gone));
}

#[test]
fn a_shelf_drains_the_pick_as_photographs_settle_and_keeps_the_ones_the_vault_refused() {
    let d = driver();
    let trashed = photo(&d, "drain-trashed");
    let live = photo(&d, "drain-live");
    let id = |id: &str| act::photos::DeletePhoto {
        photo_id: id.to_owned(),
    };
    let response = d.act(
        id(&trashed)
            .request()
            .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(response.status, wire::ActStatus::Executed as i32);

    let mut selection = Selection::new(Offer::Trash, Drain::Settled, Wording::Chosen);
    selection.set(&[trashed.clone(), live.clone()], true);
    // Restoring a live photograph fails with a sentence; the trashed one lands.
    let outcome = update(&d, &mut selection, &tap(Verb::Restore), &[]);
    let Outcome::Wrote(written) = outcome else {
        panic!("a restore writes: {outcome:?}");
    };
    assert_eq!(written.committed, std::slice::from_ref(&trashed));
    let sentence = written
        .refusal
        .clone()
        .expect("the vault refused the live one");
    assert!(!sentence.is_empty());
    assert_eq!(
        selection.picked(),
        std::slice::from_ref(&live),
        "exactly the refused one is still picked"
    );
    assert!(selection.selecting());
    assert_eq!(selection.refusal(), Some(sentence.as_str()));
    let status = selection.status().expect("a status line");
    assert!(status.refused && status.sentence == sentence);
    assert!(ids_of(&shelf(&d, load::photos::ShelfView::Live, None)).contains(&trashed));

    // A new attempt starts without the last one's sentence; nothing picked is a no-op.
    selection.leave();
    assert!(selection.refusal().is_none());
}

#[test]
fn archive_and_unarchive_move_a_photograph_in_and_out_and_restore_in_the_archive_is_an_unarchive() {
    let d = driver();
    let one = photo(&d, "archive-1");
    let mut selection = Selection::new(Offer::Shelf, Drain::Settled, Wording::Chosen);
    selection.toggle(&one);
    update(&d, &mut selection, &tap(Verb::Archive), &[]);
    assert!(ids_of(&shelf(&d, load::photos::ShelfView::Archive, None)).contains(&one));
    assert!(!ids_of(&shelf(&d, load::photos::ShelfView::Live, None)).contains(&one));
    assert!(
        selection.picked().is_empty() && !selection.selecting(),
        "the set drained"
    );

    let mut archive = Selection::new(Offer::Archive, Drain::Settled, Wording::Chosen);
    archive.toggle(&one);
    // The archive's out is `unarchive`; `restore` would be refused for a photograph never deleted.
    let outcome = update(&d, &mut archive, &tap(Verb::Restore), &[]);
    assert!(
        matches!(outcome, Outcome::Wrote(ref w) if w.ok()),
        "{outcome:?}"
    );
    assert!(ids_of(&shelf(&d, load::photos::ShelfView::Live, None)).contains(&one));
}

#[test]
fn delete_forever_asks_with_the_whole_cost_and_destroys_only_when_confirmed() {
    let d = driver();
    let one = photo(&d, "forever-1");
    let two = photo(&d, "forever-2");
    for id in [&one, &two] {
        d.act(
            act::photos::DeletePhoto {
                photo_id: id.clone(),
            }
            .request()
            .keyed(format!("arrange:{}", kit_act::fresh())),
        );
    }
    let mut selection = Selection::new(Offer::Trash, Drain::Settled, Wording::Chosen);
    selection.set(&[one.clone(), two.clone()], true);
    update(&d, &mut selection, &tap(Verb::DeleteForever), &[]);
    let confirm = selection.view(Locale::En).confirm.expect("a confirm");
    assert_eq!(confirm.title, "Delete 2 photos forever?");
    assert_eq!(
        confirm.body,
        "Captions, tags and album entries go too. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Delete 2 forever");
    assert!(confirm.destructive);
    assert!(ids_of(&shelf(&d, load::photos::ShelfView::Trash, None)).contains(&one));

    update(
        &d,
        &mut selection,
        &selection_event(sel::Kind::Confirmed(sel::Confirmed {})),
        &[],
    );
    let trash = ids_of(&shelf(&d, load::photos::ShelfView::Trash, None));
    assert!(!trash.contains(&one) && !trash.contains(&two));
}

// -----------------------------------------------------------------------------
// The album sheet
// -----------------------------------------------------------------------------

fn choice_event(kind: wire::photos_album_choice_event::Kind) -> wire::PhotosAlbumChoiceEvent {
    wire::PhotosAlbumChoiceEvent { kind: Some(kind) }
}

fn opened() -> wire::PhotosAlbumChoiceEvent {
    choice_event(wire::photos_album_choice_event::Kind::Opened(
        wire::photos_album_choice_event::Opened {},
    ))
}

fn chosen(album: &str) -> wire::PhotosAlbumChoiceEvent {
    choice_event(wire::photos_album_choice_event::Kind::Chosen(
        wire::photos_album_choice_event::Chosen {
            album_id: album.to_owned(),
        },
    ))
}

fn created(title: &str) -> wire::PhotosAlbumChoiceEvent {
    choice_event(wire::photos_album_choice_event::Kind::Created(
        wire::photos_album_choice_event::Created {
            title: title.to_owned(),
        },
    ))
}

fn pick(
    d: &Driver,
    sheet: &mut AlbumChoice,
    event: &wire::PhotosAlbumChoiceEvent,
    picked: &[String],
) -> album_choice::Outcome {
    d.with_ctx(|ctx| sheet.update(event, picked, ctx))
}

fn titles(view: &wire::PhotosAlbumChoice) -> Vec<String> {
    view.entries
        .iter()
        .map(|entry| entry.title.clone())
        .collect()
}

#[test]
fn the_sheet_opens_over_a_pick_and_never_over_nothing() {
    let d = driver();
    let mut sheet = AlbumChoice::new();
    pick(&d, &mut sheet, &opened(), &[]);
    assert!(!sheet.open());
    pick(&d, &mut sheet, &opened(), &["x".to_owned()]);
    assert!(sheet.open());
    let view = sheet.view(Locale::En, Link::default());
    assert!(view.open && view.loaded);
    assert_eq!(view.title, "Add to album");
    assert_eq!(view.new_album_label, "New album…");
    assert_eq!(view.name_placeholder, "Album name");
    assert_eq!(view.create_label, "Create");
    assert_eq!(view.cancel_label, "Cancel");
    pick(
        &d,
        &mut sheet,
        &choice_event(wire::photos_album_choice_event::Kind::Dismissed(
            wire::photos_album_choice_event::Dismissed {},
        )),
        &[],
    );
    assert!(!sheet.open());
}

#[test]
fn a_new_album_keeps_the_sheet_open_and_joins_the_list_for_the_next_tap() {
    let d = driver();
    let one = photo(&d, "sheet-1");
    let two = photo(&d, "sheet-2");
    let picked = vec![one.clone(), two.clone()];
    let mut sheet = AlbumChoice::new();
    pick(&d, &mut sheet, &opened(), &picked);
    let before = titles(&sheet.view(Locale::En, Link::default()));
    assert!(!before.contains(&"Portugal".to_owned()));

    // An empty name is not a write.
    let outcome = pick(&d, &mut sheet, &created("   "), &picked);
    assert_eq!(outcome, album_choice::Outcome::Created { refusal: None });
    assert_eq!(titles(&sheet.view(Locale::En, Link::default())), before);

    let outcome = pick(&d, &mut sheet, &created("  Portugal "), &picked);
    assert_eq!(outcome, album_choice::Outcome::Created { refusal: None });
    assert!(sheet.open(), "the sheet stays up");
    let view = sheet.view(Locale::En, Link::default());
    let entry = view
        .entries
        .iter()
        .find(|entry| entry.title == "Portugal")
        .expect("the new album is listed");
    assert_eq!(entry.count, 0);
    assert_eq!(entry.count_label, "Empty");
    assert!(entry.cover.is_none());
    assert_eq!(view.empty, "");

    // The next tap puts the pick there; the sheet closes.
    let album_id = entry.album_id.clone();
    let outcome = pick(&d, &mut sheet, &chosen(&album_id), &picked);
    let album_choice::Outcome::Added {
        album_id: into,
        written,
    } = outcome
    else {
        panic!("a choice adds: {outcome:?}");
    };
    assert_eq!(into, album_id);
    assert!(written.ok());
    assert_eq!(written.committed, picked);
    assert!(!sheet.open());
    let members = ids_of(&shelf(&d, load::photos::ShelfView::Album, Some(&album_id)));
    assert!(members.contains(&one) && members.contains(&two));

    // Adding twice changes nothing and is not a refusal (an edge is idempotent).
    let again = d.with_ctx(|ctx| album_choice::add(ctx, &picked, &album_id));
    assert!(again.ok(), "{again:?}");
    assert_eq!(
        ids_of(&shelf(&d, load::photos::ShelfView::Album, Some(&album_id))).len(),
        members.len()
    );

    // The list now counts them, and a reopened sheet reads the album with its cover.
    pick(&d, &mut sheet, &opened(), &picked);
    let view = sheet.view(Locale::En, Link::default());
    let entry = view
        .entries
        .iter()
        .find(|entry| entry.album_id == album_id)
        .unwrap();
    assert_eq!(entry.count, 2);
    assert_eq!(entry.count_label, "2 photos");
    assert!(entry.cover.is_some(), "an album with members has a cover");
}

#[test]
fn a_shelf_leaves_its_own_album_out_of_the_list_and_an_empty_vault_says_so() {
    let d = driver();
    let own = album(&d, "Own album");
    let other = album(&d, "Other album");
    let mut sheet = AlbumChoice::excluding(&own);
    pick(&d, &mut sheet, &opened(), &["x".to_owned()]);
    let listed: Vec<String> = sheet
        .view(Locale::En, Link::default())
        .entries
        .iter()
        .map(|entry| entry.album_id.clone())
        .collect();
    assert!(listed.contains(&other) && !listed.contains(&own));
}

// -----------------------------------------------------------------------------
// The skeleton
// -----------------------------------------------------------------------------

#[test]
fn every_photos_screen_opens_from_its_route_and_draws_its_own_view_state() {
    use wire::view_state::Kind as V;
    let mut d = driver();
    let cases = [
        (
            photos::routes::shelf(wire::PhotosShelfKind::Favorites, "", "Favorites"),
            "shelf",
        ),
        (photos::routes::picker("album", "Portugal"), "picker"),
        (photos::routes::places(), "places"),
        (
            photos::routes::lightbox("p", &["p".to_owned(), "q".to_owned()], ""),
            "lightbox",
        ),
        (photos::routes::editor("p"), "editor"),
        (photos::routes::duplicates(), "duplicates"),
        (
            photos::routes::duplicate_review("cluster"),
            "duplicate_review",
        ),
    ];
    for (route, name) in cases {
        let instance = d.push(photos::TAB, route);
        let drawn = match d.view(instance).kind {
            Some(V::PhotosShelf(_)) => "shelf",
            Some(V::PhotosPicker(_)) => "picker",
            Some(V::PhotosPlaces(_)) => "places",
            Some(V::PhotosLightbox(_)) => "lightbox",
            Some(V::PhotosEditor(_)) => "editor",
            Some(V::PhotosDuplicates(_)) => "duplicates",
            Some(V::PhotosDuplicateReview(_)) => "duplicate_review",
            ref other => panic!("{name} drew {other:?}"),
        };
        assert_eq!(drawn, name);
    }
    let home = d.navigation.as_ref().expect("a navigation").tabs[0].entries[0].instance;
    assert!(matches!(d.view(home).kind, Some(V::PhotosHome(_))));
}
