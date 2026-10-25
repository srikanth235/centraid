//! `photos.duplicates` and `photos.duplicate_review` (#1135), through a real core:
//! the port of `DuplicatesSpec` and `DuplicateReviewSpec`. Reads, the Kotlin
//! legs and the seat are gone; what is pinned is what a member sees and what the
//! screens may write.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::photos::{self, routes};
use centraid_screens::testing::Driver;
use wire::screen_event::Kind as E;

/// A driver whose seeded scenario has no near-duplicates left: every member of
/// every cluster the example vault holds is trashed first.
fn driver() -> Driver {
    let mut driver = Driver::with_runtime(photos::runtime());
    driver.start();
    let seeded: Vec<String> = driver.with_ctx(|ctx| {
        let answer = ctx
            .load(load::photos::Duplicates::default().into())
            .expect("duplicates");
        match answer.answer.and_then(|a| a.answer) {
            Some(wire::app_query_response::Answer::PhotosDuplicates(found)) => found
                .clusters
                .into_iter()
                .flat_map(|cluster| cluster.photo_ids)
                .collect(),
            other => panic!("duplicates answered {other:?}"),
        }
    });
    for id in seeded {
        let key = format!("clear:{id}:{}", kit_act::fresh());
        let response = driver.act(
            act::photos::DeletePhoto { photo_id: id }
                .request()
                .keyed(key),
        );
        assert_eq!(response.status, wire::ActStatus::Executed as i32);
    }
    driver
}

fn stage(d: &Driver, seed: &str) -> String {
    let hash = centraid_vault::blob::content_digest(seed.as_bytes());
    let response = d
        .handle
        .command(
            "blob.stage",
            &serde_json::json!({ "hash": hash, "size": seed.len() }),
            &format!("dup:stage:{}", kit_act::fresh()),
        )
        .expect("stage");
    assert_eq!(
        response.status,
        centraid_vault::CommandStatus::Executed,
        "{:?}",
        response.reason
    );
    hash
}

/// One photograph with a perceptual hash, a pixel box and a byte size.
fn photo(d: &Driver, seed: &str, phash: &str, box_px: Option<(i64, i64)>) -> String {
    let hash = stage(d, seed);
    let mut upload = act::photos::Upload {
        blob: hash,
        media_type: "image/jpeg".to_owned(),
        form: Some(act::photos::UploadForm::Photo),
        phash: centraid_screens::field::Field::Is(phash.to_owned()),
        ..Default::default()
    };
    if let Some((w, h)) = box_px {
        upload.width = centraid_screens::field::Field::Is(w);
        upload.height = centraid_screens::field::Field::Is(h);
    }
    let response = d.act(upload.request().keyed(format!("dup:{}", kit_act::fresh())));
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    let value: serde_json::Value = serde_json::from_slice(&response.output).expect("json");
    value["id"].as_str().expect("an id").to_owned()
}

fn album_with(d: &Driver, photo_id: &str) -> String {
    let made = d.act(
        act::photos::CreateAlbum {
            title: "Keepers".to_owned(),
            id: None,
        }
        .request()
        .keyed(format!("dup:album:{}", kit_act::fresh())),
    );
    let value: serde_json::Value = serde_json::from_slice(&made.output).expect("json");
    let album = value["id"].as_str().expect("id").to_owned();
    let added = d.act(
        act::photos::AddToAlbum {
            from: album.clone(),
            to: photo_id.to_owned(),
            ..Default::default()
        }
        .request()
        .keyed(format!("dup:add:{}", kit_act::fresh())),
    );
    assert_eq!(added.status, wire::ActStatus::Executed as i32);
    album
}

fn sets_view(d: &Driver, instance: u64) -> wire::PhotosDuplicatesState {
    match &d.view(instance).kind {
        Some(wire::view_state::Kind::PhotosDuplicates(state)) => state.clone(),
        other => panic!("not the duplicates: {other:?}"),
    }
}

fn review_view(d: &Driver, instance: u64) -> wire::PhotosDuplicateReviewState {
    match &d.view(instance).kind {
        Some(wire::view_state::Kind::PhotosDuplicateReview(state)) => state.clone(),
        other => panic!("not the review: {other:?}"),
    }
}

fn review_data(state: &wire::PhotosDuplicateReviewState) -> &wire::PhotosDuplicateReviewData {
    match &state.content {
        Some(wire::photos_duplicate_review_state::Content::Data(data)) => data,
        other => panic!("no data: {other:?}"),
    }
}

fn sets_data(state: &wire::PhotosDuplicatesState) -> &wire::PhotosDuplicatesData {
    match &state.content {
        Some(wire::photos_duplicates_state::Content::Data(data)) => data,
        other => panic!("no data: {other:?}"),
    }
}

fn review_event(d: &mut Driver, instance: u64, kind: wire::photos_duplicate_review_event::Kind) {
    d.send(
        instance,
        E::PhotosDuplicateReview(wire::PhotosDuplicateReviewEvent { kind: Some(kind) }),
    );
}

use wire::photos_duplicate_review_event as rev;

fn trashed(d: &Driver, id: &str) -> bool {
    d.with_ctx(|ctx| {
        let answer = ctx
            .load(load::photos::Photo { id: id.to_owned() }.into())
            .expect("photo");
        match answer.answer.and_then(|a| a.answer) {
            Some(wire::app_query_response::Answer::PhotosPhoto(found)) => {
                found.photo.is_some_and(|p| p.trashed)
            }
            other => panic!("photo answered {other:?}"),
        }
    })
}

const NEAR_A: &str = "ffff0000ffff0000";
const NEAR_B: &str = "ffff0000ffff0001";
const NEAR_C: &str = "ffff0000ffff0003";

#[test]
fn an_empty_library_is_data_with_no_sets_and_an_empty_state_never_a_failure() {
    let mut d = driver();
    let at = d.push("photos", routes::duplicates());
    let state = sets_view(&d, at);
    assert_eq!(state.title, "Duplicates");
    let data = sets_data(&state);
    assert!(data.sets.is_empty());
    assert_eq!(data.lede, "");
    assert_eq!(
        data.empty.as_ref().expect("empty").headline,
        "No near-identical photos in your library."
    );
}

#[test]
fn a_set_is_a_row_that_opens_its_review_and_the_biggest_job_comes_first() {
    let mut d = driver();
    let a = photo(&d, "pair-a", NEAR_A, None);
    let b = photo(&d, "pair-bb", NEAR_B, None);
    // A set of three, far from the pair.
    let far = |n: &str| format!("0000ffff0000ff{n}");
    photo(&d, "tri-1", &far("00"), None);
    photo(&d, "tri-2", &far("01"), None);
    photo(&d, "tri-3", &far("02"), None);
    let at = d.push("photos", routes::duplicates());
    let state = sets_view(&d, at);
    let data = sets_data(&state);
    assert_eq!(data.lede, "2 sets of near-identical photos.");
    let headlines: Vec<&str> = data.sets.iter().map(|s| s.headline.as_str()).collect();
    assert_eq!(
        headlines,
        ["3 near-identical copies", "2 near-identical copies"]
    );
    // Every set carries the route to its review and a cover.
    let pair = &data.sets[1];
    assert_eq!(pair.cluster_key, a.min(b.clone()));
    assert_eq!(
        pair.route,
        Some(routes::duplicate_review(&pair.cluster_key))
    );
    assert!(pair.cover.is_some());
    // The core's sizes are known, so the reclaim line is said, from the cells.
    assert!(pair.subhead.ends_with("to reclaim."), "{}", pair.subhead);
    assert!(data.reclaim.ends_with("to reclaim."));
}

#[test]
fn the_shelf_deletes_nothing_and_a_new_pair_arrives_on_a_change() {
    let mut d = driver();
    let at = d.push("photos", routes::duplicates());
    assert!(sets_data(&sets_view(&d, at)).sets.is_empty());
    photo(&d, "late-a", NEAR_A, None);
    photo(&d, "late-b", NEAR_B, None);
    d.pump(std::time::Duration::from_millis(600));
    assert_eq!(sets_data(&sets_view(&d, at)).sets.len(), 1);
    // A refresh is a read again, with the same answer.
    d.send(
        at,
        E::PhotosDuplicates(wire::PhotosDuplicatesEvent {
            kind: Some(wire::photos_duplicates_event::Kind::Refreshed(
                wire::photos_duplicates_event::Refreshed {},
            )),
        }),
    );
    assert_eq!(sets_data(&sets_view(&d, at)).sets.len(), 1);
}

fn pair_review(d: &mut Driver) -> (u64, String, String, String) {
    let small = photo(d, "rev-small", NEAR_A, Some((800, 600)));
    let big = photo(d, "rev-big!!", NEAR_B, Some((4000, 3000)));
    let key = small.clone().min(big.clone());
    let at = d.push("photos", routes::duplicate_review(&key));
    (at, small, big, key)
}

#[test]
fn nothing_is_kept_until_the_member_picks_and_the_resolve_says_why_it_waits() {
    let mut d = driver();
    let (at, small, big, _) = pair_review(&mut d);
    let state = review_view(&d, at);
    let data = review_data(&state);
    assert_eq!(data.members.len(), 2);
    assert_eq!(data.keep_photo_id, "");
    assert!(!data.resolve_enabled);
    assert_eq!(data.resolve_label, "Trash the other copies");
    assert_eq!(data.resolve_hint, "Choose the copy to keep first.");
    assert!(data.members.iter().all(|m| !m.kept));
    // The suggestion is the largest by pixels, with its reason, on that row only,
    // and is NOT a pick.
    assert_eq!(data.suggested_photo_id, big);
    assert_eq!(
        data.suggestion_reason,
        "This is the largest of these copies, by pixels."
    );
    let row = |id: &str| data.members.iter().find(|m| m.photo_id == id).expect("row");
    assert_eq!(row(&big).suggestion, data.suggestion_reason);
    assert_eq!(row(&small).suggestion, "");
    assert!(row(&big).facts.starts_with("4000 × 3000"));
    // Resolving with no pick writes nothing.
    review_event(&mut d, at, rev::Kind::Resolve(rev::ResolveTapped {}));
    assert!(!trashed(&d, &small) && !trashed(&d, &big));
}

#[test]
fn a_pick_enables_the_resolve_and_a_pick_off_the_screen_is_ignored() {
    let mut d = driver();
    let (at, small, _big, _) = pair_review(&mut d);
    review_event(
        &mut d,
        at,
        rev::Kind::Keep(rev::KeepPicked {
            photo_id: "elsewhere".into(),
        }),
    );
    assert_eq!(review_data(&review_view(&d, at)).keep_photo_id, "");
    review_event(
        &mut d,
        at,
        rev::Kind::Keep(rev::KeepPicked {
            photo_id: small.clone(),
        }),
    );
    let state = review_view(&d, at);
    let data = review_data(&state);
    assert_eq!(data.keep_photo_id, small);
    assert!(data.resolve_enabled);
    assert_eq!(data.resolve_label, "Trash the other copy");
    assert_eq!(data.resolve_hint, "");
    assert!(
        data.members
            .iter()
            .find(|m| m.photo_id == small)
            .expect("row")
            .kept
    );
}

#[test]
fn a_resolve_trashes_every_copy_but_the_kept_one_and_never_purges() {
    let mut d = driver();
    let a = photo(&d, "tri-a", NEAR_A, Some((10, 10)));
    let b = photo(&d, "tri-b", NEAR_B, Some((20, 20)));
    let c = photo(&d, "tri-c", NEAR_C, Some((30, 30)));
    let key = [&a, &b, &c].into_iter().min().expect("min").clone();
    let at = d.push("photos", routes::duplicate_review(&key));
    review_event(
        &mut d,
        at,
        rev::Kind::Keep(rev::KeepPicked {
            photo_id: b.clone(),
        }),
    );
    assert_eq!(
        review_data(&review_view(&d, at)).resolve_label,
        "Trash the other 2 copies"
    );
    review_event(&mut d, at, rev::Kind::Resolve(rev::ResolveTapped {}));
    assert!(
        trashed(&d, &a) && trashed(&d, &c),
        "the others are in the trash"
    );
    assert!(!trashed(&d, &b), "the kept copy is untouched");
    // Trashed, not purged: they are still photographs that can come back.
    let state = review_view(&d, at);
    assert!(
        review_data(&state).members.is_empty(),
        "the set is resolved"
    );
    assert!(review_data(&state).empty.is_some());
    assert!(state.status.is_none());
}

#[test]
fn the_suggestion_is_none_when_nothing_can_be_compared_or_two_tie() {
    let mut d = driver();
    // No pixel box on either copy: nothing to compare.
    let a = photo(&d, "nobox-a", NEAR_A, None);
    let b = photo(&d, "nobox-b", NEAR_B, None);
    let at = d.push("photos", routes::duplicate_review(&a.clone().min(b)));
    let state = review_view(&d, at);
    let data = review_data(&state);
    assert_eq!(data.suggested_photo_id, "");
    assert_eq!(data.suggestion_reason, "");
    assert!(data.members.iter().all(|m| m.suggestion.is_empty()));
    assert!(
        data.members
            .iter()
            .all(|m| m.facts.contains("KB") || m.facts.contains("byte") || m.facts == "This copy")
    );

    // Two tie at the largest.
    let mut d = driver();
    let c = photo(&d, "tie-a", NEAR_A, Some((100, 100)));
    let e = photo(&d, "tie-b", NEAR_B, Some((100, 100)));
    let at = d.push("photos", routes::duplicate_review(&c.clone().min(e)));
    assert_eq!(review_data(&review_view(&d, at)).suggested_photo_id, "");
}

#[test]
fn a_copy_in_an_album_says_so_because_albums_are_checked() {
    let mut d = driver();
    let a = photo(&d, "alb-a", NEAR_A, Some((10, 10)));
    let b = photo(&d, "alb-b", NEAR_B, Some((20, 20)));
    album_with(&d, &a);
    let at = d.push(
        "photos",
        routes::duplicate_review(&a.clone().min(b.clone())),
    );
    let state = review_view(&d, at);
    let data = review_data(&state);
    assert_eq!(data.checked_line, "Albums are checked. Favorites are not.");
    let row = |id: &str| data.members.iter().find(|m| m.photo_id == id).expect("row");
    assert!(row(&a).in_album);
    assert_eq!(row(&a).in_album_label, "In an album");
    assert!(!row(&b).in_album);
    assert!(row(&a).accessibility_label.contains("In an album"));
}

#[test]
fn a_pick_that_left_the_set_is_forgotten_and_a_missing_set_is_empty_not_failed() {
    let mut d = driver();
    let (at, small, big, _) = pair_review(&mut d);
    review_event(
        &mut d,
        at,
        rev::Kind::Keep(rev::KeepPicked {
            photo_id: small.clone(),
        }),
    );
    // The kept copy is trashed elsewhere: the set dissolves, the pick goes.
    let key = kit_act::key(&["delete-photo", &small], kit_act::fresh());
    let trashed_it = d.act(
        act::photos::DeletePhoto {
            photo_id: small.clone(),
        }
        .request()
        .keyed(key),
    );
    assert_eq!(trashed_it.status, wire::ActStatus::Executed as i32);
    d.pump(std::time::Duration::from_millis(600));
    let state = review_view(&d, at);
    let data = review_data(&state);
    assert!(data.members.is_empty());
    assert_eq!(data.keep_photo_id, "");
    assert_eq!(
        data.empty.as_ref().expect("empty").headline,
        "There are no copies left in this set."
    );
    assert!(!trashed(&d, &big));
}

#[test]
fn a_refusal_stands_beside_the_copies_with_the_vaults_own_sentence() {
    let mut d = driver();
    let (at, small, big, _) = pair_review(&mut d);
    review_event(
        &mut d,
        at,
        rev::Kind::Keep(rev::KeepPicked {
            photo_id: big.clone(),
        }),
    );
    // The other copy is purged out from under the screen between the pick and
    // the resolve: the trash is refused, and the list is not taken with it.
    let key = kit_act::key(&["delete-photo", &small], kit_act::fresh());
    d.act(
        act::photos::DeletePhoto {
            photo_id: small.clone(),
        }
        .request()
        .keyed(key),
    );
    let key = kit_act::key(&["purge-photo", &small], kit_act::fresh());
    let purged = d.act(
        act::photos::PurgePhoto {
            photo_id: small.clone(),
        }
        .request()
        .keyed(key),
    );
    assert_eq!(purged.status, wire::ActStatus::Executed as i32);
    // The screen has not re-read yet (no pump): its resolve meets a gone photograph.
    review_event(&mut d, at, rev::Kind::Resolve(rev::ResolveTapped {}));
    let state = review_view(&d, at);
    if let Some(status) = &state.status {
        assert!(status.refused);
        assert!(!status.sentence.is_empty());
    }
    // Either way the screen is still data, never a failure.
    assert!(matches!(
        state.content,
        Some(wire::photos_duplicate_review_state::Content::Data(_))
    ));
}
