//! EARLIER VERSIONS of a photograph (#1185): the entry on the details sheet with its count (absent
//! at zero), the kit's one list with each version in the sheet's own words (caption, capture time,
//! place), Restore with no confirm, and Undo. A flag, a label or an edited copy is never a version.
//! Every test goes through `Driver`, over a vault seeded at a fixed instant.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::{Field, Keyed};
use centraid_screens::kit::act as kit_act;
use centraid_screens::photos::{self, routes};
use centraid_screens::testing::Driver;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn driver() -> Driver {
    let mut d = Driver::with_runtime_at(photos::runtime(), SEEDED_AT_MS);
    d.start();
    d
}

fn run(d: &Driver, request: wire::ActRequest) -> serde_json::Value {
    let response = d.act(request.keyed(format!("pe:{}", kit_act::fresh())));
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    serde_json::from_slice(&response.output).unwrap_or(serde_json::Value::Null)
}

fn upload(d: &Driver, seed: &str, change: impl FnOnce(&mut act::photos::Upload)) -> String {
    let mut upload = act::photos::Upload {
        blob: centraid_vault::blob::content_digest(seed.as_bytes()),
        media_type: "image/jpeg".to_owned(),
        size: Some(seed.len() as i64),
        form: Some(act::photos::UploadForm::Photo),
        width: Field::Is(400),
        height: Field::Is(300),
        ..Default::default()
    };
    change(&mut upload);
    run(d, upload.request())["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn retitle(d: &Driver, id: &str, title: &str) {
    run(
        d,
        act::photos::RetitlePhoto {
            photo_id: id.to_owned(),
            title: title.to_owned(),
            expected_rev: None,
        }
        .request(),
    );
}

fn cell_of(d: &Driver, id: &str) -> wire::PhotosCell {
    d.with_ctx(|ctx| {
        let answer = ctx
            .load(load::photos::Photo { id: id.to_owned() }.into())
            .expect("photo");
        match answer.answer.and_then(|a| a.answer) {
            Some(wire::app_query_response::Answer::PhotosPhoto(found)) => {
                found.photo.expect("photo").cell.expect("cell")
            }
            other => panic!("photo answered {other:?}"),
        }
    })
}

fn entry_of(d: &mut Driver, id: &str) -> Option<wire::EarlierEntry> {
    let at = d.push("photos", routes::lightbox(id, &[], ""));
    let state = match &d.view(at).kind {
        Some(wire::view_state::Kind::PhotosLightbox(state)) => (**state).clone(),
        other => panic!("not the lightbox: {other:?}"),
    };
    let entry = match state.content {
        Some(wire::photos_lightbox_state::Content::Photo(photo)) => photo.earlier,
        None => panic!("no photograph: {:?}", state.page),
    };
    d.pop("photos", at);
    entry
}

fn earlier_view(v: &wire::ViewState) -> &wire::EarlierView {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => view,
        other => panic!("not the earlier-versions screen: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> &[wire::EarlierRow] {
    match &earlier_view(v).content {
        Some(wire::earlier_view::Content::Data(data)) => &data.rows,
        other => panic!("no data: {other:?}"),
    }
}

fn open_earlier(d: &mut Driver, id: &str) -> u64 {
    let entry = entry_of(d, id).expect("the entry");
    d.push("photos", entry.route.expect("a route"))
}

fn lines(d: &Driver, at: u64) -> Vec<String> {
    rows(d.view(at)).iter().map(|r| r.value.clone()).collect()
}

fn send(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

/// A photograph captioned three times.
fn captioned(d: &Driver) -> String {
    let id = upload(d, "pe-caption", |u| u.title = Some("Walk".to_owned()));
    retitle(d, &id, "Morning walk");
    retitle(d, &id, "Morning walk before work");
    id
}

#[test]
fn the_entry_appears_with_its_count_only_once_there_is_something_earlier() {
    let mut d = driver();
    let id = upload(&d, "pe-entry", |u| u.title = Some("Walk".to_owned()));
    assert!(entry_of(&mut d, &id).is_none(), "never edited: no entry");

    // A star and a label are part of the photo's history: each is a version of its own.
    run(
        &d,
        act::photos::FlagPhoto {
            photo_id: id.clone(),
        }
        .request(),
    );
    run(
        &d,
        act::photos::TagPhoto {
            photo_id: id.clone(),
            label: "trees".to_owned(),
        }
        .request(),
    );
    let entry = entry_of(&mut d, &id).expect("the star and the label are versions");
    assert_eq!(entry.count_label, "2");

    retitle(&d, &id, "Morning walk");
    retitle(&d, &id, "Morning walk before work");
    let entry = entry_of(&mut d, &id).expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "4");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, photos::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
    assert_eq!(args.back_label, "Morning walk before work");
}

#[test]
fn the_list_is_the_current_caption_then_each_version_in_the_sheets_words() {
    let mut d = driver();
    let id = captioned(&d);
    let at = open_earlier(&mut d, &id);
    assert_eq!(
        lines(&d, at),
        [
            "Caption: Morning walk before work",
            "Caption: Morning walk",
            "Caption: Walk"
        ]
    );
    assert!(rows(d.view(at))[0].current);
}

#[test]
fn a_corrected_date_and_a_changed_place_read_as_the_sheet_reads_them() {
    let mut d = driver();
    let id = upload(&d, "pe-when", |u| {
        u.taken_at = Field::Is("2026-11-04T02:18:00Z".to_owned());
        u.offset_min = Field::Is(330);
        u.lat = Field::Is(12.97);
        u.lon = Field::Is(77.59);
    });
    let other = upload(&d, "pe-elsewhere", |u| {
        u.lat = Field::Is(51.7);
        u.lon = Field::Is(-2.9);
    });
    let place_of = |d: &Driver, id: &str| cell_of(d, id).place_id.expect("a place");
    let here = place_of(&d, &id);
    let there = place_of(&d, &other);
    for (place, title) in [(&here, "Cubbon Park"), (&there, "Forest of Dean")] {
        run(
            &d,
            act::photos::NamePlace {
                place_id: place.clone(),
                title: title.to_owned(),
                expected_rev: None,
            }
            .request(),
        );
    }
    run(
        &d,
        act::photos::EditPhoto {
            photo_id: id.clone(),
            taken_at: Field::Is("2026-11-05T02:18:00Z".to_owned()),
            ..Default::default()
        }
        .request(),
    );
    run(
        &d,
        act::photos::SetPlace {
            id: id.clone(),
            place_id: Field::Is(there),
        }
        .request(),
    );
    let at = open_earlier(&mut d, &id);
    let listed = lines(&d, at);
    assert_eq!(listed[0], "Forest of Dean", "{listed:?}");
    // Each row is what its change moved: the place was moved away from Cubbon Park, and the date
    // from 4 November (read in the photograph's own offset).
    assert_eq!(listed[1], "Cubbon Park", "{listed:?}");
    assert_eq!(listed[2], "4 November 2026 07:48", "{listed:?}");
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut d = driver();
    let id = captioned(&d);
    let at = open_earlier(&mut d, &id);
    let oldest = rows(d.view(at)).last().expect("a row").seq;
    send(
        &mut d,
        at,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert_eq!(cell_of(&d, &id).title, "Walk");
    let status = earlier_view(d.view(at)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");

    send(
        &mut d,
        at,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(cell_of(&d, &id).title, "Morning walk before work");
}

#[test]
fn editing_the_pixels_makes_a_new_photograph_and_never_a_version_of_the_original() {
    let mut d = driver();
    let original = upload(&d, "pe-original", |u| u.title = Some("Walk".to_owned()));
    // The editor saves the result as another photograph with the original as its source.
    let edited = upload(&d, "pe-original-cropped", |u| {
        u.title = Some("Walk".to_owned());
        u.edited_from = Field::Is(original.clone());
    });
    assert_ne!(edited, original);
    assert!(
        entry_of(&mut d, &original).is_none(),
        "the original keeps no version of the edit"
    );
    assert!(entry_of(&mut d, &edited).is_none(), "nor is the copy one");
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = Driver::unfounded(photos::runtime());
    d.start();
    let route = centraid_screens::kit::earlier::route(photos::EARLIER, "some-id", "Walk");
    let i = d.push("photos", route);
    assert!(matches!(
        earlier_view(d.view(i))
            .page
            .as_ref()
            .and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Failed(_))
    ));
}

fn origin_of(d: &mut Driver, id: &str) -> Option<wire::OriginLine> {
    let at = d.push("photos", routes::lightbox(id, &[], ""));
    let state = match &d.view(at).kind {
        Some(wire::view_state::Kind::PhotosLightbox(state)) => (**state).clone(),
        other => panic!("not the lightbox: {other:?}"),
    };
    let origin = match state.content {
        Some(wire::photos_lightbox_state::Content::Photo(photo)) => photo.origin,
        None => panic!("no photograph: {:?}", state.page),
    };
    d.pop("photos", at);
    origin
}

#[test]
fn a_camera_roll_photo_says_so_and_a_typed_one_does_not() {
    let mut d = driver();
    let rolled = upload(&d, "rolled", |u| {
        u.arrived_system = Some(act::photos::UploadArrivedSystem::CameraRoll);
        u.arrived_label = Some("Camera roll".to_owned());
    });
    let picked = upload(&d, "picked", |u| {
        u.arrived_system = Some(act::photos::UploadArrivedSystem::Picker);
        u.arrived_label = Some("IMG_0042.jpg".to_owned());
    });
    let typed = upload(&d, "typed", |_| {});
    let line = origin_of(&mut d, &rolled).expect("a line");
    assert_eq!(line.text, "From Camera roll");
    assert_eq!(line.accessibility_label, "Came from Camera roll");
    assert_eq!(
        origin_of(&mut d, &picked).map(|line| line.text),
        Some("From IMG_0042.jpg".to_owned())
    );
    assert_eq!(origin_of(&mut d, &typed), None);
}
