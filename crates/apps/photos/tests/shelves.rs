//! `shelf`: every arm, against a vault the product founds and Photos' own commands
//! fill. One library, eight shelves, and the verdict each one asks: the undated tail
//! after the dated walk, an edit folding its original, the archive that is not the
//! trash, an album that keeps an archived member and loses a trashed one, a place and
//! the photographs with none.

mod common;

use centraid_apps_photos::shelf::{Shelf, ShelfCursor, ShelfData, ShelfInput, load_shelf};
use common::{World, library};
use serde_json::json;

const NOW: i64 = 1_767_312_000_000; // 2026-01-02

fn shelf(w: &World, shelf: Shelf, limit: usize, after: Option<ShelfCursor>) -> ShelfData {
    w.read(|door| {
        load_shelf(
            door,
            &ShelfInput {
                shelf,
                limit,
                after,
            },
            NOW,
        )
        .expect("reads")
    })
}

fn ids(data: &ShelfData) -> Vec<&str> {
    data.cells
        .iter()
        .map(|cell| cell.photo_id.as_str())
        .collect()
}

/// Walk a shelf to its end, `limit` cells at a time.
fn walk(w: &World, which: &Shelf, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let page = shelf(w, which.clone(), limit, after);
        out.extend(page.cells.iter().map(|cell| cell.photo_id.clone()));
        match page.next {
            Some(next) => after = Some(next),
            None => return out,
        }
    }
}

#[test]
fn the_library_is_dated_newest_first_then_the_undated_tail_and_folds_an_edit() {
    let l = library();
    let page = shelf(&l.w, Shelf::Live, 50, None);
    // Dated newest first (the edit folds the original and shares its time), then the
    // undated, newest id first. The archived, the trashed and the folded are absent.
    assert_eq!(
        ids(&page),
        [
            l.new.as_str(),
            l.movie.as_str(),
            l.edit.as_str(),
            l.old.as_str(),
            l.undated_b.as_str(),
            l.undated_a.as_str(),
        ]
    );
    assert_eq!(page.total, Some(6));
    assert_eq!(page.next, None);
    assert!(!ids(&page).contains(&l.original.as_str()));
    let new = &page.cells[0];
    assert!(new.favorite);
    assert_eq!(new.byte_size, Some(3));
    assert_eq!(new.content_id, centraid_vault::blob::content_digest(b"new"));
    assert_eq!(
        new.thumbnail_path, None,
        "no byte store behind the test door"
    );
    assert!(!new.original_held);
    let movie = &page.cells[1];
    assert_eq!(movie.form.as_deref(), Some("video"));
    assert_eq!(movie.duration_s, Some(3.5));
    let old = &page.cells[3];
    assert_eq!(old.title, "Old");
    assert_eq!(old.album_ids, std::slice::from_ref(&l.album));
}

#[test]
fn a_walk_in_small_pages_crosses_from_the_dated_into_the_undated_and_loses_nothing() {
    let l = library();
    let whole: Vec<String> = ids(&shelf(&l.w, Shelf::Live, 50, None))
        .into_iter()
        .map(str::to_owned)
        .collect();
    for limit in [1, 2, 3, 5] {
        assert_eq!(walk(&l.w, &Shelf::Live, limit), whole, "pages of {limit}");
    }
    // The total rides the first page only.
    let first = shelf(&l.w, Shelf::Live, 2, None);
    assert_eq!(first.total, Some(6));
    let second = shelf(&l.w, Shelf::Live, 2, first.next);
    assert_eq!(second.total, None);
    // A cursor inside the tail continues the tail.
    let tail = shelf(
        &l.w,
        Shelf::Live,
        50,
        Some(ShelfCursor {
            sort_key: String::new(),
            id: l.undated_b.clone(),
        }),
    );
    assert_eq!(ids(&tail), [l.undated_a.as_str()]);
}

#[test]
fn trashing_the_edit_brings_the_original_back() {
    let l = library();
    l.w.ok("entity.trash", json!({ "id": l.edit }));
    let page = shelf(&l.w, Shelf::Live, 50, None);
    assert!(ids(&page).contains(&l.original.as_str()));
    assert!(!ids(&page).contains(&l.edit.as_str()));
    assert_eq!(page.total, Some(6));
}

#[test]
fn favorites_videos_place_and_unplaced_are_the_library_under_a_predicate() {
    let l = library();
    assert_eq!(
        ids(&shelf(&l.w, Shelf::Favorites, 50, None)),
        [l.new.as_str()]
    );
    assert_eq!(shelf(&l.w, Shelf::Favorites, 50, None).total, Some(1));
    let videos = shelf(&l.w, Shelf::Videos, 50, None);
    assert_eq!(ids(&videos), [l.movie.as_str()]);
    assert_eq!(videos.total, Some(1));
    let place = shelf(&l.w, Shelf::Place(l.place_a.clone()), 50, None);
    assert_eq!(ids(&place), [l.new.as_str(), l.old.as_str()]);
    assert_eq!(place.total, Some(2));
    assert_eq!(
        place.place.as_ref().map(|place| place.place_id.as_str()),
        Some(l.place_a.as_str())
    );
    let paris = shelf(&l.w, Shelf::Place(l.place_b.clone()), 50, None);
    assert_eq!(ids(&paris), [l.edit.as_str()]);
    let unplaced = shelf(&l.w, Shelf::Unplaced, 50, None);
    assert_eq!(
        ids(&unplaced),
        [l.movie.as_str(), l.undated_b.as_str(), l.undated_a.as_str()]
    );
    assert_eq!(unplaced.total, Some(3));
}

#[test]
fn the_archive_is_not_the_trash_and_the_trash_is_every_trashed_photograph() {
    let l = library();
    let archive = shelf(&l.w, Shelf::Archive, 50, None);
    // Archived and not trashed: the archived one, not the one also thrown away.
    assert_eq!(ids(&archive), [l.archived.as_str()]);
    assert_eq!(archive.total, Some(1));
    assert!(archive.cells[0].archived);
    let trash = shelf(&l.w, Shelf::Trash, 50, None);
    assert_eq!(trash.total, Some(2));
    let mut trashed: Vec<&str> = ids(&trash);
    trashed.sort_unstable();
    let mut expected = [l.trashed.as_str(), l.both.as_str()];
    expected.sort_unstable();
    assert_eq!(trashed, expected);
    for cell in &trash.cells {
        assert!(cell.deleted_at.is_some());
        assert!(cell.purge_at.is_some());
        assert_eq!(cell.purge_in_days, Some(29), "trashed at the frozen clock");
    }
    // Newest trashed first; a walk in pages of one agrees.
    assert_eq!(walk(&l.w, &Shelf::Trash, 1), ids(&trash));
    // The trashed one that was also archived is archived on its cell.
    assert!(trash.cells.iter().any(|cell| cell.archived));
    // Restoring brings a photograph back to the shelf it was put away from.
    l.w.ok("entity.restore", json!({ "id": l.both }));
    assert_eq!(
        ids(&shelf(&l.w, Shelf::Archive, 50, None)).len(),
        2,
        "the archived photograph returns to the archive, not the library"
    );
}

#[test]
fn an_album_draws_an_archived_member_and_not_a_trashed_one() {
    let l = library();
    let album = shelf(&l.w, Shelf::Album(l.album.clone()), 50, None);
    assert_eq!(
        ids(&album),
        [l.archived.as_str(), l.old.as_str(), l.undated_a.as_str()]
    );
    assert_eq!(album.total, Some(3));
    assert_eq!(
        album.album.as_ref().map(|head| head.title.as_str()),
        Some("Summer")
    );
    assert!(
        album
            .album
            .as_ref()
            .is_some_and(|head| head.deleted_at.is_none())
    );
    // The trashed member is in the trash and comes back with a restore.
    l.w.ok("entity.restore", json!({ "id": l.trashed }));
    assert_eq!(
        shelf(&l.w, Shelf::Album(l.album.clone()), 50, None).total,
        Some(4)
    );
    // A trashed album is still an album, with its stamp.
    l.w.ok("entity.trash", json!({ "id": l.album }));
    let gone = shelf(&l.w, Shelf::Album(l.album.clone()), 50, None);
    let head = gone.album.expect("the album is still there");
    assert!(head.deleted_at.is_some());
    assert!(head.purge_in_days.is_some());
    // No such album is no heading, not an error.
    assert!(
        shelf(&l.w, Shelf::Album("nope".to_owned()), 50, None)
            .album
            .is_none()
    );
}

#[test]
fn a_live_photo_is_a_still_that_says_so_and_a_movie_that_names_it() {
    let w = World::new();
    let still = w.photo(
        "still",
        json!({ "taken_at": "2025-01-01T00:00:00.000Z", "burst": "live-1" }),
    );
    let movie = w.photo(
        "movie",
        json!({ "taken_at": "2025-01-01T00:00:00.000Z", "burst": "live-1", "form": "video", "media_type": "video/quicktime" }),
    );
    let page = shelf(&w, Shelf::Live, 10, None);
    assert_eq!(page.cells.len(), 2, "both photographs are on the shelf");
    let by = |id: &str| {
        page.cells
            .iter()
            .find(|cell| cell.photo_id == id)
            .expect("a cell")
    };
    assert!(by(&still).live);
    assert_eq!(by(&still).live_movie_id.as_deref(), Some(movie.as_str()));
    assert_eq!(
        by(&still).live_content_id.as_deref(),
        Some(centraid_vault::blob::content_digest(b"movie").as_str())
    );
    assert_eq!(by(&movie).live_of.as_deref(), Some(still.as_str()));
    // A trashed movie un-pairs the still.
    w.ok("entity.trash", json!({ "id": movie }));
    assert!(!shelf(&w, Shelf::Live, 10, None).cells[0].live);
}

#[test]
fn a_shelf_page_is_bounded_and_a_zero_limit_asks_for_one() {
    let l = library();
    assert_eq!(shelf(&l.w, Shelf::Live, 0, None).cells.len(), 1);
}
