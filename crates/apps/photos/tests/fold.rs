//! THE LIBRARY DRAWS AN EDIT AND KEEPS THE CAMERA'S ORIGINAL UNDERNEATH
//! (#1127, A20(1), R-1127-5; #1135).
//!
//! The fold is the kit's one verdict (`centraid_apps_kit::rules::Standing`) that
//! every shelf asks. This runs the `live` shelf over real `photo` rows in a vault
//! the product founds, so a rule that folds the wrong photograph fails here and
//! not on a member's phone. It carries the cases the Kotlin `PhotoFold` page test
//! pinned before the fold moved into Rust.

mod common;

use centraid_apps_photos::shelf::{Shelf, ShelfData, ShelfInput, load_shelf};
use common::World;
use serde_json::json;

const NOW: i64 = 1_767_312_000_000;

fn add(w: &World, id: &str, form: &str, burst: Option<&str>, from: Option<&str>) {
    w.photo(
        id,
        json!({ "id": id, "form": form, "media_type": if form == "video" { "video/mp4" } else { "image/jpeg" },
                "taken_at": "2019-08-03T10:11:12Z", "burst": burst, "edited_from": from }),
    );
    w.clock.advance_ms(1_000);
}

/// What the library draws, in id order.
fn drawn(w: &World) -> Vec<String> {
    let data: ShelfData = w.read(|door| {
        load_shelf(
            door,
            &ShelfInput {
                shelf: Shelf::Live,
                limit: 200,
                after: None,
            },
            NOW,
        )
        .expect("the shelf reads")
    });
    let mut ids: Vec<String> = data
        .cells
        .iter()
        .map(|cell| cell.photo_id.clone())
        .collect();
    ids.sort();
    ids
}

#[test]
fn the_edit_draws_and_the_original_stays_under_it() {
    let w = World::new();
    add(&w, "orig", "photo", Some("G"), None);
    add(&w, "edit", "photo", Some("G"), Some("orig"));
    assert_eq!(drawn(&w), vec!["edit"]);
}

#[test]
fn trashing_or_archiving_the_edit_brings_the_original_back() {
    let w = World::new();
    add(&w, "orig", "photo", Some("G"), None);
    add(&w, "edit", "photo", Some("G"), Some("orig"));
    w.ok("flag.set", json!({ "id": "edit", "flag": "archived" }));
    assert_eq!(drawn(&w), vec!["orig"]);
    w.ok("flag.clear", json!({ "id": "edit", "flag": "archived" }));
    assert_eq!(drawn(&w), vec!["edit"]);
    w.ok("entity.trash", json!({ "id": "edit" }));
    assert_eq!(drawn(&w), vec!["orig"]);
}

#[test]
fn a_second_edit_folds_the_first() {
    let w = World::new();
    add(&w, "a-orig", "photo", Some("G"), None);
    add(&w, "b-one", "photo", Some("G"), Some("a-orig"));
    add(&w, "c-two", "photo", Some("G"), Some("a-orig"));
    assert_eq!(drawn(&w), vec!["c-two"]);
}

#[test]
fn an_edit_wins_whatever_the_ids_say() {
    let w = World::new();
    // The edit's id sorts BEFORE the original's: it folds the original by lineage.
    add(&w, "z-orig", "photo", Some("G"), None);
    add(&w, "a-edit", "photo", Some("G"), Some("z-orig"));
    assert_eq!(drawn(&w), vec!["a-edit"]);
}

#[test]
fn a_crop_saved_from_the_editor_and_an_ungrouped_photograph_both_draw() {
    let w = World::new();
    // R-1029-PH-5: the editor's save is a new photograph the member chose to
    // make, with lineage and no burst. Both stay.
    add(&w, "plain", "photo", None, None);
    add(&w, "crop", "photo", None, Some("plain"));
    assert_eq!(drawn(&w), vec!["crop", "plain"]);
}

#[test]
fn a_live_photos_movie_is_not_folded_by_its_still() {
    let w = World::new();
    add(&w, "still", "photo", Some("L"), None);
    add(&w, "movie", "video", Some("L"), None);
    // The screen folds the movie into its still itself (`photos::cells::dedupe_live`).
    assert_eq!(drawn(&w), vec!["movie", "still"]);
}

#[test]
fn a_file_edited_in_place_folds_its_ungrouped_earlier_version_by_lineage() {
    let w = World::new();
    // THE EARLIER VERSION WAS BACKED UP BEFORE THE EDIT EXISTED, so it has no
    // burst; the edit carries one and names it as its source.
    add(&w, "before", "photo", None, None);
    add(&w, "after", "photo", Some("image:7"), Some("before"));
    assert_eq!(drawn(&w), vec!["after"]);
    // A SECOND EDIT, whose source is the first.
    add(&w, "again", "photo", Some("image:7"), Some("after"));
    assert_eq!(drawn(&w), vec!["again"]);
    // Trashing the newest brings the one before it back, and no further.
    w.ok("entity.trash", json!({ "id": "again" }));
    assert_eq!(drawn(&w), vec!["after"]);
}

#[test]
fn a_crop_of_an_edit_folds_nothing() {
    let w = World::new();
    add(&w, "before", "photo", None, None);
    add(&w, "edit", "photo", Some("image:7"), Some("before"));
    // The editor's save of the edit: lineage, no burst.
    add(&w, "crop", "photo", None, Some("edit"));
    assert_eq!(drawn(&w), vec!["crop", "edit"]);
}
