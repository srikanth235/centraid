//! `photos.lightbox` (#1135): the port of `PhotoLightboxSpec`, through a real
//! core. The Kotlin read legs, amendments and seat are gone (one `photos.photo`
//! answer holds the photograph); what is pinned is what a member sees, which
//! verbs can run and why one cannot, and what the screen may write.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::{Field, Keyed};
use centraid_screens::kit::act as kit_act;
use centraid_screens::photos::lightbox::{self, FILM_REACH};
use centraid_screens::photos::{self, routes};
use centraid_screens::testing::Driver;
use wire::photo_tile::Held;
use wire::photos_lightbox_event as ev;
use wire::photos_lightbox_share_choice::Precision;
use wire::photos_lightbox_state::Sheet;
use wire::photos_lightbox_verb::Kind as V;
use wire::screen_event::Kind as E;

type View = wire::PhotosLightboxState;

fn stage(d: &Driver, bytes: &[u8]) -> wire::StageHandle {
    let send = |kind| {
        let answer = d
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Stage(wire::StageRequest {
                    kind: Some(kind),
                })),
            })
            .expect("stage frame");
        let Some(wire::response::Kind::Stage(stage)) = answer.kind else {
            panic!("a stage frame answers");
        };
        stage.kind.expect("kind")
    };
    let wire::stage_response::Kind::Begun(begun) =
        send(wire::stage_request::Kind::Begin(wire::StageBegin {
            media_type: "image/jpeg".to_owned(),
            byte_size: bytes.len() as u64,
            source: wire::StageSource::Owned as i32,
            ..Default::default()
        }))
    else {
        panic!("begun");
    };
    let ceiling = usize::try_from(begun.chunk_bytes).expect("fits");
    for (seq, window) in bytes.chunks(ceiling).enumerate() {
        send(wire::stage_request::Kind::Chunk(wire::StageChunk {
            staging_id: begun.staging_id.clone(),
            seq: seq as u64,
            payload: window.to_vec(),
        }));
    }
    let wire::stage_response::Kind::Handle(staged) =
        send(wire::stage_request::Kind::End(wire::StageEnd {
            staging_id: begun.staging_id,
        }))
    else {
        panic!("a handle");
    };
    staged
}

struct Shot<'a> {
    seed: &'a str,
    bytes: bool,
    title: Option<&'a str>,
    taken_at: Option<&'a str>,
    offset: Option<i64>,
    form: act::photos::UploadForm,
    lat_lon: Option<(f64, f64)>,
}

impl<'a> Shot<'a> {
    fn new(seed: &'a str) -> Self {
        Self {
            seed,
            bytes: true,
            title: None,
            taken_at: None,
            offset: None,
            form: act::photos::UploadForm::Photo,
            lat_lon: None,
        }
    }
}

fn photo(d: &Driver, shot: Shot) -> String {
    let (hash, size) = if shot.bytes {
        let staged = stage(d, shot.seed.as_bytes());
        (staged.content_hash, staged.byte_size as i64)
    } else {
        (
            centraid_vault::blob::content_digest(shot.seed.as_bytes()),
            shot.seed.len() as i64,
        )
    };
    let mut upload = act::photos::Upload {
        blob: hash,
        media_type: "image/jpeg".to_owned(),
        size: Some(size),
        form: Some(shot.form),
        title: shot.title.map(str::to_owned),
        width: Field::Is(400),
        height: Field::Is(300),
        ..Default::default()
    };
    if let Some(at) = shot.taken_at {
        upload.taken_at = Field::Is(at.to_owned());
    }
    if let Some(offset) = shot.offset {
        upload.offset_min = Field::Is(offset);
    }
    if let Some((lat, lon)) = shot.lat_lon {
        upload.lat = Field::Is(lat);
        upload.lon = Field::Is(lon);
    }
    let response = d.act(upload.request().keyed(format!("lb:{}", kit_act::fresh())));
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    let value: serde_json::Value = serde_json::from_slice(&response.output).expect("json");
    value["id"].as_str().expect("an id").to_owned()
}

fn driver() -> Driver {
    let mut d = Driver::with_runtime(photos::runtime());
    d.start();
    d
}

fn open(d: &mut Driver, id: &str, neighbours: &[String], album: &str) -> u64 {
    d.push("photos", routes::lightbox(id, neighbours, album))
}

fn view(d: &Driver, at: u64) -> View {
    match &d.view(at).kind {
        Some(wire::view_state::Kind::PhotosLightbox(state)) => (**state).clone(),
        other => panic!("not the lightbox: {other:?}"),
    }
}

fn photo_of(state: &View) -> &wire::PhotosLightboxPhoto {
    match &state.content {
        Some(wire::photos_lightbox_state::Content::Photo(photo)) => photo,
        other => panic!("no photograph: {other:?}"),
    }
}

fn send(d: &mut Driver, at: u64, kind: ev::Kind) -> wire::ScreenUpdate {
    d.send(
        at,
        E::PhotosLightbox(wire::PhotosLightboxEvent { kind: Some(kind) }),
    )
}

fn tap(d: &mut Driver, at: u64, kind: V) {
    send(d, at, ev::Kind::Verb(ev::VerbTapped { kind: kind as i32 }));
}

fn verb(state: &View, kind: V) -> wire::PhotosLightboxVerb {
    state
        .toolbar
        .iter()
        .chain(state.menu.iter())
        .find(|verb| verb.kind == kind as i32)
        .unwrap_or_else(|| panic!("no {kind:?} verb"))
        .clone()
}

fn cell_of(d: &Driver, id: &str) -> (wire::PhotosCell, bool) {
    d.with_ctx(|ctx| {
        let answer = ctx
            .load(load::photos::Photo { id: id.to_owned() }.into())
            .expect("photo");
        match answer.answer.and_then(|a| a.answer) {
            Some(wire::app_query_response::Answer::PhotosPhoto(found)) => {
                let detail = found.photo.expect("photo");
                (detail.cell.expect("cell"), detail.trashed)
            }
            other => panic!("photo answered {other:?}"),
        }
    })
}

fn effects_of(d: &mut Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .drain(..)
        .filter_map(|request| request.effect.and_then(|e| e.kind))
        .collect()
}

// -----------------------------------------------------------------------------
// Opening, words and the chrome
// -----------------------------------------------------------------------------

#[test]
fn it_opens_with_its_chrome_drawn_and_the_photograph_read() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-open"));
    let at = open(&mut d, &id, std::slice::from_ref(&id), "");
    let state = view(&d, at);
    assert!(
        state.chrome_visible,
        "a photograph that arrives bare has no way back"
    );
    assert_eq!(state.sheet, Sheet::None as i32);
    assert!(!state.slideshow && !state.dismissed);
    assert_eq!(photo_of(&state).tile.as_ref().expect("tile").photo_id, id);
    assert_eq!(state.words.as_ref().expect("words").close, "Close");
    // Chrome is a state: a tap hides it and a rotation does not bring it back.
    send(
        &mut d,
        at,
        ev::Kind::Chrome(ev::ChromeToggled { visible: false }),
    );
    assert!(!view(&d, at).chrome_visible);
}

#[test]
fn the_stamp_is_the_evening_the_shutter_fired_and_no_offset_is_utc() {
    let mut d = driver();
    // 23:30 UTC at +01:00 is the next morning there.
    let late = photo(
        &d,
        Shot {
            taken_at: Some("2026-07-30T23:30:00Z"),
            offset: Some(60),
            ..Shot::new("lb-stamp-1")
        },
    );
    let at = open(&mut d, &late, &[], "");
    let p = view(&d, at);
    assert_eq!(photo_of(&p).stamp_date, "31 July 2026");
    assert_eq!(photo_of(&p).stamp_line, "00:30");
    let captured = &photo_of(&p).facts[0];
    assert_eq!(captured.label, "Captured");
    assert_eq!(captured.text, "31 July 2026 00:30 · UTC+01:00");

    let evening = photo(
        &d,
        Shot {
            taken_at: Some("2026-07-30T17:42:00Z"),
            offset: Some(0),
            ..Shot::new("lb-stamp-2")
        },
    );
    let at = open(&mut d, &evening, &[], "");
    let state = view(&d, at);
    assert_eq!(photo_of(&state).stamp_date, "30 July 2026");
    assert_eq!(photo_of(&state).facts[0].text, "30 July 2026 17:42 · UTC");
}

#[test]
fn a_row_with_no_capture_time_says_no_date_and_no_captured_fact() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-undated"));
    let at = open(&mut d, &id, &[], "");
    let state = view(&d, at);
    assert_eq!(photo_of(&state).stamp_date, "");
    assert_eq!(photo_of(&state).stamp_line, "");
    assert!(photo_of(&state).facts.iter().all(|f| f.label != "Captured"));
    // The facts the vault does hold are rows: the pixel box and the file.
    let labels: Vec<&str> = photo_of(&state)
        .facts
        .iter()
        .map(|f| f.label.as_str())
        .collect();
    assert_eq!(labels, ["Size", "File"]);
    assert_eq!(photo_of(&state).facts[0].text, "400 × 300");
}

#[test]
fn the_camera_the_header_names_is_a_fact_and_a_stale_answer_lands_on_nothing() {
    let mut d = driver();
    let first = photo(&d, Shot::new("lb-camera-1"));
    let second = photo(&d, Shot::new("lb-camera-2"));
    let shelf = [first.clone(), second.clone()];
    let at = open(&mut d, &first, &shelf, "");
    // The original is on this phone, so the platform is asked to read its header.
    let asked = effects_of(&mut d);
    assert!(
        asked
            .iter()
            .any(|e| matches!(e, wire::effect::Kind::ReadCamera(r) if !r.path.is_empty())),
        "{asked:?}"
    );
    // A swipe issues the next photograph's own ask; the first answer is then late.
    let late = wire::effect_result::Outcome::CameraRead(wire::CameraRead {
        camera: "Apple iPhone 15 Pro".to_owned(),
    });
    send(
        &mut d,
        at,
        ev::Kind::Moved(ev::Moved {
            photo_id: second.clone(),
        }),
    );
    d.effects.clear();
    let second_ask = d.send(
        at,
        E::EffectResult(wire::EffectResult {
            effect_id: 1,
            outcome: Some(late),
        }),
    );
    drop(second_ask);
    let state = view(&d, at);
    // The answer was for whichever ask was oldest: it lands on the photograph it
    // was asked about, and never on one it was not.
    let facts = &photo_of(&state).facts;
    let camera = facts.iter().find(|f| f.label == "Camera");
    if let Some(camera) = camera {
        assert_eq!(camera.text, "Apple iPhone 15 Pro");
    }
    assert!(state.photo_id == second);
}

// -----------------------------------------------------------------------------
// Verbs and refusals
// -----------------------------------------------------------------------------

#[test]
fn no_verb_is_enabled_without_being_able_to_run_and_none_is_disabled_without_a_reason() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-verbs"));
    let at = open(&mut d, &id, &[], "");
    let state = view(&d, at);
    let kinds: Vec<i32> = state.toolbar.iter().map(|v| v.kind).collect();
    assert_eq!(
        kinds,
        [
            V::Share,
            V::Favorite,
            V::Info,
            V::Edit,
            V::Archive,
            V::Trash
        ]
        .map(|k| k as i32)
    );
    for verb in state.toolbar.iter().chain(state.menu.iter()) {
        assert_eq!(verb.enabled, verb.why.is_empty(), "{:?}", verb.kind);
    }
    // Info only reads, so it is never refused; edit is live over a still held here.
    assert!(verb(&state, V::Info).enabled);
    let edit = verb(&state, V::Edit);
    assert!(edit.enabled);
    assert_eq!(edit.route, Some(routes::editor(&id)));
}

#[test]
fn edit_is_refused_over_a_video_and_over_an_original_this_phone_does_not_hold() {
    let mut d = driver();
    let video = photo(
        &d,
        Shot {
            form: act::photos::UploadForm::Video,
            ..Shot::new("lb-video")
        },
    );
    let at = open(&mut d, &video, &[], "");
    let edit = verb(&view(&d, at), V::Edit);
    assert!(!edit.enabled);
    assert_eq!(edit.why, "Crop and rotate work on photos only.");
    // Tapping a refused verb does nothing.
    tap(&mut d, at, V::Edit);

    let absent = photo(
        &d,
        Shot {
            bytes: false,
            ..Shot::new("lb-absent")
        },
    );
    let at = open(&mut d, &absent, &[], "");
    let edit = verb(&view(&d, at), V::Edit);
    assert_eq!(edit.why, "The original is not on this phone yet.");
}

#[test]
fn a_write_over_no_photograph_is_withheld_with_the_not_in_a_vault_sentence_and_never_submitted() {
    let mut d = driver();
    let at = open(&mut d, "no-such-photo", &[], "");
    let state = view(&d, at);
    assert!(matches!(
        state.content,
        Some(wire::photos_lightbox_state::Content::Failure(_))
    ));
    // Writes over nothing are refused, whatever event arrives.
    send(
        &mut d,
        at,
        ev::Kind::TagAdded(ev::TagAdded { label: "x".into() }),
    );
    let state = view(&d, at);
    let status = state.status.expect("a refusal");
    assert!(status.refused);
    assert_eq!(status.sentence, "This photo is not in a vault yet.");
}

#[test]
fn favorite_and_archive_toggle_through_the_flag_edges_and_a_committed_write_re_reads() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-flags"));
    let at = open(&mut d, &id, &[], "");
    tap(&mut d, at, V::Favorite);
    let state = view(&d, at);
    assert!(photo_of(&state).tile.as_ref().expect("tile").favorite);
    assert!(verb(&state, V::Favorite).on);
    assert_eq!(verb(&state, V::Favorite).label, "Unfavorite");
    assert!(cell_of(&d, &id).0.favorite);
    tap(&mut d, at, V::Favorite);
    assert!(
        !photo_of(&view(&d, at))
            .tile
            .as_ref()
            .expect("tile")
            .favorite
    );

    tap(&mut d, at, V::Archive);
    let state = view(&d, at);
    assert!(photo_of(&state).tile.as_ref().expect("tile").archived);
    assert_eq!(verb(&state, V::Archive).label, "Unarchive");
    tap(&mut d, at, V::Archive);
    assert!(!cell_of(&d, &id).0.archived);
}

#[test]
fn trash_is_reversible_in_place_and_delete_forever_asks_first_and_then_the_screen_is_done() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-trash"));
    let at = open(&mut d, &id, &[], "");
    tap(&mut d, at, V::Trash);
    let (_, trashed) = cell_of(&d, &id);
    assert!(trashed);
    let state = view(&d, at);
    assert!(photo_of(&state).trashed);
    assert!(photo_of(&state).trash_line.ends_with("left in the trash"));
    let kinds: Vec<i32> = state.toolbar.iter().map(|v| v.kind).collect();
    assert_eq!(kinds, [V::Restore, V::DeleteForever].map(|k| k as i32));
    // Restore brings it back, with the bottom row it had.
    tap(&mut d, at, V::Restore);
    assert!(!cell_of(&d, &id).1);
    assert_eq!(view(&d, at).toolbar.len(), 6);

    tap(&mut d, at, V::Trash);
    tap(&mut d, at, V::DeleteForever);
    let asked = view(&d, at);
    let confirm = asked.confirm.expect("asked first");
    assert_eq!(confirm.title, "Delete 1 photo forever?");
    assert!(confirm.destructive);
    assert!(cell_of(&d, &id).1, "nothing was purged by asking");
    // Dismissing takes the question back.
    send(
        &mut d,
        at,
        ev::Kind::ConfirmDismissed(ev::ConfirmDismissed {}),
    );
    assert!(view(&d, at).confirm.is_none());
    tap(&mut d, at, V::DeleteForever);
    send(&mut d, at, ev::Kind::Confirmed(ev::Confirmed {}));
    assert!(view(&d, at).dismissed, "the photograph is gone");
    let gone = d.with_ctx(|ctx| {
        ctx.load(load::photos::Photo { id: id.clone() }.into())
            .expect("photo")
            .answer
            .and_then(|a| a.answer)
    });
    assert!(matches!(
        gone,
        Some(wire::app_query_response::Answer::PhotosPhoto(found)) if found.photo.is_none()
    ));
}

#[test]
fn the_caption_is_trimmed_and_an_unchanged_one_is_not_a_write() {
    let mut d = driver();
    let id = photo(
        &d,
        Shot {
            title: Some("Pier day"),
            ..Shot::new("lb-caption")
        },
    );
    let at = open(&mut d, &id, &[], "");
    send(
        &mut d,
        at,
        ev::Kind::Caption(ev::CaptionChanged {
            caption: "  Pier day ".into(),
        }),
    );
    assert!(view(&d, at).status.is_none());
    assert_eq!(cell_of(&d, &id).0.title, "Pier day");
    send(
        &mut d,
        at,
        ev::Kind::Caption(ev::CaptionChanged {
            caption: "  Low tide ".into(),
        }),
    );
    assert_eq!(photo_of(&view(&d, at)).caption, "Low tide");
    assert_eq!(cell_of(&d, &id).0.title, "Low tide");
    // A caption may be cleared.
    send(
        &mut d,
        at,
        ev::Kind::Caption(ev::CaptionChanged {
            caption: String::new(),
        }),
    );
    assert_eq!(cell_of(&d, &id).0.title, "");
}

#[test]
fn labels_are_added_by_their_words_and_removed_by_the_chip_that_says_which() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-tags"));
    let at = open(&mut d, &id, &[], "");
    assert_eq!(
        photo_of(&view(&d, at)).labels_line,
        "No labels on this photo."
    );
    // An empty label is not a write.
    send(
        &mut d,
        at,
        ev::Kind::TagAdded(ev::TagAdded {
            label: "   ".into(),
        }),
    );
    assert!(photo_of(&view(&d, at)).labels.is_empty());
    send(
        &mut d,
        at,
        ev::Kind::TagAdded(ev::TagAdded {
            label: " pier ".into(),
        }),
    );
    send(
        &mut d,
        at,
        ev::Kind::TagAdded(ev::TagAdded {
            label: "sea".into(),
        }),
    );
    let state = view(&d, at);
    let labels: Vec<&str> = photo_of(&state)
        .labels
        .iter()
        .map(|l| l.label.as_str())
        .collect();
    assert_eq!(labels.len(), 2);
    assert!(labels.contains(&"pier") && labels.contains(&"sea"));
    assert_eq!(photo_of(&state).labels_line, "");
    let pier = photo_of(&state)
        .labels
        .iter()
        .find(|l| l.label == "pier")
        .expect("pier");
    assert_eq!(pier.remove_label, "Remove pier");
    send(
        &mut d,
        at,
        ev::Kind::TagRemoved(ev::TagRemoved {
            tag_id: pier.tag_id.clone(),
        }),
    );
    let labels: Vec<String> = photo_of(&view(&d, at))
        .labels
        .iter()
        .map(|l| l.label.clone())
        .collect();
    assert_eq!(labels, ["sea"]);
    // A chip that is not there removes nothing.
    send(
        &mut d,
        at,
        ev::Kind::TagRemoved(ev::TagRemoved {
            tag_id: "nope".into(),
        }),
    );
    assert_eq!(photo_of(&view(&d, at)).labels.len(), 1);
}

#[test]
fn a_refused_write_is_a_sentence_beside_the_photograph_and_does_not_travel_with_a_swipe() {
    let mut d = driver();
    let first = photo(&d, Shot::new("lb-refuse-1"));
    let second = photo(&d, Shot::new("lb-refuse-2"));
    let shelf = [first.clone(), second.clone()];
    let at = open(&mut d, &first, &shelf, "");
    send(
        &mut d,
        at,
        ev::Kind::PlaceChosen(ev::PlaceChosen {
            place_id: "no-such-place".into(),
        }),
    );
    let state = view(&d, at);
    let status = state.status.expect("the vault's sentence");
    assert!(status.refused && !status.sentence.is_empty());
    // The photograph is still on screen, not replaced by the error.
    assert!(matches!(
        state.content,
        Some(wire::photos_lightbox_state::Content::Photo(_))
    ));
    // A refusal is about the photograph it was tried on.
    send(&mut d, at, ev::Kind::Moved(ev::Moved { photo_id: second }));
    assert!(view(&d, at).status.is_none());
}

// -----------------------------------------------------------------------------
// The shelf: swipe, strip, slideshow
// -----------------------------------------------------------------------------

fn shelf_of(d: &Driver, count: usize, tag: &str) -> Vec<String> {
    (0..count)
        .map(|n| photo(d, Shot::new(&format!("lb-shelf-{tag}-{n}"))))
        .collect()
}

#[test]
fn a_swipe_keeps_the_shelfs_order_re_shows_the_chrome_and_closes_the_sheet() {
    let mut d = driver();
    let shelf = shelf_of(&d, 3, "swipe");
    let at = open(&mut d, &shelf[1], &shelf, "");
    let state = view(&d, at);
    assert_eq!(
        (state.previous_id.as_str(), state.next_id.as_str()),
        (shelf[0].as_str(), shelf[2].as_str())
    );
    assert_eq!(state.position, "2 of 3");
    send(
        &mut d,
        at,
        ev::Kind::Chrome(ev::ChromeToggled { visible: false }),
    );
    tap(&mut d, at, V::Info);
    assert_eq!(view(&d, at).sheet, Sheet::Info as i32);
    send(
        &mut d,
        at,
        ev::Kind::Moved(ev::Moved {
            photo_id: shelf[2].clone(),
        }),
    );
    let state = view(&d, at);
    assert_eq!(state.photo_id, shelf[2]);
    assert!(state.chrome_visible);
    assert_eq!(state.sheet, Sheet::None as i32);
    assert_eq!(state.next_id, "", "the last has nowhere to go");
    assert_eq!(
        state.previous_id, shelf[1],
        "the order is the shelf's, kept"
    );
    assert_eq!(
        photo_of(&state).tile.as_ref().expect("tile").photo_id,
        shelf[2]
    );
    // A photograph off the shelf has no position.
    let stranger = photo(&d, Shot::new("lb-stranger"));
    send(
        &mut d,
        at,
        ev::Kind::Moved(ev::Moved { photo_id: stranger }),
    );
    assert_eq!(view(&d, at).position, "");
}

#[test]
fn the_strip_is_a_window_around_the_photograph_and_every_frame_knows_its_tile() {
    let neighbours: Vec<String> = (0..100).map(|n| format!("p{n}")).collect();
    assert!(lightbox::film_window(&neighbours, "missing").is_empty());
    assert!(
        lightbox::film_window(&neighbours[..1], "p0").is_empty(),
        "a shelf of one has no strip"
    );
    assert_eq!(
        lightbox::film_window(&neighbours, "p0").len(),
        FILM_REACH + 1
    );
    assert_eq!(
        lightbox::film_window(&neighbours, "p50").len(),
        2 * FILM_REACH + 1
    );
    assert_eq!(
        lightbox::film_window(&neighbours, "p99").len(),
        FILM_REACH + 1
    );

    let mut d = driver();
    let shelf = shelf_of(&d, 3, "film");
    let at = open(&mut d, &shelf[0], &shelf, "");
    let state = view(&d, at);
    assert_eq!(state.film.len(), 3);
    assert!(state.film[0].current && !state.film[1].current);
    assert!(state.film.iter().all(|frame| frame.tile.is_some()));
    assert_eq!(state.film[0].accessibility_label, "Show photo 1 of 3");
    assert_eq!(state.film[2].accessibility_label, "Show photo 3 of 3");
    assert_eq!(state.words.as_ref().expect("words").filmstrip, "Filmstrip");
}

#[test]
fn a_slideshow_needs_somewhere_to_go_wraps_at_the_end_and_leaving_keeps_the_photograph() {
    let mut d = driver();
    let lone = photo(&d, Shot::new("lb-lone"));
    let at = open(&mut d, &lone, std::slice::from_ref(&lone), "");
    assert!(
        view(&d, at)
            .menu
            .iter()
            .all(|v| v.kind != V::Slideshow as i32),
        "the menu does not offer a clock that moves nothing"
    );
    tap(&mut d, at, V::Slideshow);
    assert!(!view(&d, at).slideshow);

    let shelf = shelf_of(&d, 2, "show");
    let at = open(&mut d, &shelf[1], &shelf, "");
    tap(&mut d, at, V::Slideshow);
    let state = view(&d, at);
    assert!(state.slideshow && state.chrome_visible);
    assert_eq!(state.slideshow_meta, "2 of 2, 4 seconds a photo");
    assert_eq!(
        state.slideshow_line,
        "Leaving the slideshow keeps the photo you stopped on"
    );
    // The clock ticks and the screen says where to: it wraps at the end.
    d.pump(Duration::from_millis(4_600));
    let state = view(&d, at);
    assert_eq!(state.photo_id, shelf[0]);
    assert!(state.slideshow);
    assert_eq!(state.slideshow_meta, "1 of 2, 4 seconds a photo");
    // Leave stops the clock and keeps the photograph on screen.
    send(&mut d, at, ev::Kind::SlideshowLeft(ev::SlideshowLeft {}));
    d.pump(Duration::from_millis(4_600));
    let state = view(&d, at);
    assert!(!state.slideshow);
    assert_eq!(state.photo_id, shelf[0]);
}

// -----------------------------------------------------------------------------
// The bytes: fetch, send, save
// -----------------------------------------------------------------------------

#[test]
fn a_tap_paints_the_original_fetching_before_the_bytes_move_and_a_failure_stops_it_with_a_sentence()
{
    // KEYED, as a phone's vault is: the core's backup doors answer only a keyed vault.
    let mut d = Driver::keyed(photos::runtime());
    d.start();
    let id = photo(
        &d,
        Shot {
            bytes: false,
            ..Shot::new("lb-fetch")
        },
    );
    let at = open(&mut d, &id, &[], "");
    let state = view(&d, at);
    assert!(photo_of(&state).offers_fetch);
    assert_eq!(
        state.words.as_ref().expect("words").load_original,
        "Load the original"
    );
    d.effects.clear();
    send(&mut d, at, ev::Kind::FetchOriginal(ev::FetchTapped {}));
    // THE CORE IS ASKED, OFF THE LOCK: nothing is asked of the shell.
    let asked = effects_of(&mut d);
    assert!(asked.is_empty(), "{asked:?}");
    let state = view(&d, at);
    assert!(photo_of(&state).fetching && !photo_of(&state).offers_fetch);
    assert_eq!(
        photo_of(&state).tile.as_ref().expect("tile").held,
        Held::Fetching as i32
    );
    assert_eq!(photo_of(&state).status_line, "Downloading the original…");
    // A second tap while it runs asks for nothing.
    send(&mut d, at, ev::Kind::FetchOriginal(ev::FetchTapped {}));
    assert!(effects_of(&mut d).is_empty());

    // No backup device is paired, so none answers: the spinner stops and the sentence says why.
    for _ in 0..100 {
        if !photo_of(&view(&d, at)).fetching {
            break;
        }
        d.pump(std::time::Duration::from_millis(50));
    }
    let state = view(&d, at);
    assert!(
        !photo_of(&state).fetching && photo_of(&state).offers_fetch,
        "the member can try again"
    );
    let status = state.status.expect("a sentence");
    assert!(status.refused);
    assert_eq!(
        status.sentence,
        "Can't reach your backup device. Try again later."
    );
}

#[test]
fn a_fetch_that_landed_re_reads_so_the_original_is_drawn() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-fetch-ok"));
    let at = open(&mut d, &id, &[], "");
    // Held already: nothing to fetch, and the original is located for the stage.
    let state = view(&d, at);
    assert!(!photo_of(&state).offers_fetch);
    assert!(
        photo_of(&state)
            .original_path
            .as_deref()
            .is_some_and(|p| !p.is_empty())
    );
    assert_eq!(
        photo_of(&state).whereabouts,
        "The original is on this phone."
    );
    send(&mut d, at, ev::Kind::FetchOriginal(ev::FetchTapped {}));
    assert!(!photo_of(&view(&d, at)).fetching);
}

fn export_of(effects: Vec<wire::effect::Kind>) -> wire::ExportOriginals {
    effects
        .into_iter()
        .find_map(|e| match e {
            wire::effect::Kind::ExportOriginals(export) => Some(export),
            _ => None,
        })
        .expect("an export")
}

fn exported(status: wire::originals_exported::Status) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OriginalsExported(wire::OriginalsExported {
        status: status as i32,
        handed: 1,
        missing: 0,
    })
}

#[test]
fn a_send_is_a_decision_about_bytes_and_every_receipt_says_what_went_none_included() {
    use wire::originals_exported::Status;
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-send"));
    let at = open(&mut d, &id, &[], "");
    tap(&mut d, at, V::Share);
    let state = view(&d, at);
    assert_eq!(state.sheet, Sheet::Share as i32);
    assert_eq!(
        state.words.as_ref().expect("words").share_title,
        "Include which location?"
    );
    let rows: Vec<(&str, &str)> = state
        .share_choices
        .iter()
        .map(|c| (c.label.as_str(), c.detail.as_str()))
        .collect();
    assert_eq!(
        rows,
        [
            ("No location", "No location in the copy."),
            (
                "Exact location",
                "The original file, as the camera recorded it."
            )
        ]
    );
    d.effects.clear();
    send(
        &mut d,
        at,
        ev::Kind::Share(ev::ShareChosen {
            precision: Precision::None as i32,
        }),
    );
    let export = export_of(effects_of(&mut d));
    assert_eq!(export.photo_ids, std::slice::from_ref(&id));
    assert_eq!(export.mode, wire::export_originals::Mode::Send as i32);
    assert!(
        !export.keep_location,
        "no location is the default and is stated"
    );
    assert_eq!(view(&d, at).sheet, Sheet::None as i32);
    d.send(
        at,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(exported(Status::Done)),
        }),
    );
    assert_eq!(
        view(&d, at).status.expect("receipt").sentence,
        "Sent without location."
    );

    send(
        &mut d,
        at,
        ev::Kind::Share(ev::ShareChosen {
            precision: Precision::Exact as i32,
        }),
    );
    assert!(export_of(effects_of(&mut d)).keep_location);
    d.send(
        at,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(exported(Status::Done)),
        }),
    );
    let receipt = view(&d, at).status.expect("receipt");
    assert_eq!(
        (receipt.sentence.as_str(), receipt.refused),
        ("Sent with exact location.", false)
    );

    // A copy that would have carried a place it was told not to is not sent.
    send(
        &mut d,
        at,
        ev::Kind::Share(ev::ShareChosen {
            precision: Precision::None as i32,
        }),
    );
    effects_of(&mut d);
    d.send(
        at,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(exported(Status::LocationNotRemovable)),
        }),
    );
    let refusal = view(&d, at).status.expect("refusal");
    assert!(refusal.refused);
    assert_eq!(
        refusal.sentence,
        "Could not remove the location, so nothing was sent."
    );

    send(
        &mut d,
        at,
        ev::Kind::Share(ev::ShareChosen {
            precision: Precision::None as i32,
        }),
    );
    effects_of(&mut d);
    d.send(
        at,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(exported(Status::NoneHere)),
        }),
    );
    assert_eq!(
        view(&d, at).status.expect("refusal").sentence,
        "The original is not on this phone, so nothing was sent."
    );
}

#[test]
fn download_saves_the_original_into_the_phones_library_and_says_so() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-save"));
    let at = open(&mut d, &id, &[], "");
    d.effects.clear();
    tap(&mut d, at, V::Download);
    let export = export_of(effects_of(&mut d));
    assert_eq!(export.mode, wire::export_originals::Mode::Save as i32);
    assert!(export.keep_location, "a saved original is the original");
    d.send(
        at,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(exported(wire::originals_exported::Status::Done)),
        }),
    );
    assert_eq!(
        view(&d, at).status.expect("receipt").sentence,
        "Saved to your photos."
    );
    // A platform that gave no answer at all is never silence.
    tap(&mut d, at, V::Download);
    effects_of(&mut d);
    d.send(
        at,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::Failed(wire::EffectFailed {
                reason: "x".into(),
                denied: false,
                cancelled: false,
            })),
        }),
    );
    let refusal = view(&d, at).status.expect("sentence");
    assert!(refusal.refused);
    assert_eq!(refusal.sentence, "Photo not exported. Try again.");
}

// -----------------------------------------------------------------------------
// Albums, places, key photo
// -----------------------------------------------------------------------------

fn album(d: &Driver, title: &str) -> String {
    let response = d.act(
        act::photos::CreateAlbum {
            title: title.to_owned(),
            id: None,
        }
        .request()
        .keyed(format!("lb:album:{}", kit_act::fresh())),
    );
    let value: serde_json::Value = serde_json::from_slice(&response.output).expect("json");
    value["id"].as_str().expect("id").to_owned()
}

#[test]
fn the_album_sheet_adds_the_photograph_and_a_create_keeps_the_sheet_open() {
    use wire::photos_album_choice_event as ac;
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-album"));
    let keepers = album(&d, "Keepers");
    let at = open(&mut d, &id, &[], "");
    tap(&mut d, at, V::AddToAlbum);
    let state = view(&d, at);
    let sheet = state.album_choice.expect("sheet");
    assert!(sheet.open && sheet.loaded);
    assert!(sheet.entries.iter().any(|entry| entry.album_id == keepers));
    // A create leaves the sheet open with the new album in the list.
    send(
        &mut d,
        at,
        ev::Kind::AlbumChoice(wire::PhotosAlbumChoiceEvent {
            kind: Some(ac::Kind::Created(ac::Created {
                title: "Pier".into(),
            })),
        }),
    );
    let sheet = view(&d, at).album_choice.expect("sheet");
    assert!(sheet.open);
    assert!(sheet.entries.iter().any(|entry| entry.title == "Pier"));
    // Choosing closes it and files the photograph.
    send(
        &mut d,
        at,
        ev::Kind::AlbumChoice(wire::PhotosAlbumChoiceEvent {
            kind: Some(ac::Kind::Chosen(ac::Chosen {
                album_id: keepers.clone(),
            })),
        }),
    );
    assert!(!view(&d, at).album_choice.expect("sheet").open);
    assert!(cell_of(&d, &id).0.album_ids.contains(&keepers));
    // Dismissing without a choice writes nothing.
    tap(&mut d, at, V::AddToAlbum);
    send(
        &mut d,
        at,
        ev::Kind::AlbumChoice(wire::PhotosAlbumChoiceEvent {
            kind: Some(ac::Kind::Dismissed(ac::Dismissed {})),
        }),
    );
    assert!(!view(&d, at).album_choice.expect("sheet").open);
}

#[test]
fn make_key_photo_is_offered_only_inside_the_album_it_was_opened_from() {
    let mut d = driver();
    let id = photo(&d, Shot::new("lb-key"));
    let keepers = album(&d, "Covers");
    let added = d.act(
        act::photos::AddToAlbum {
            from: keepers.clone(),
            to: id.clone(),
            ..Default::default()
        }
        .request()
        .keyed(format!("lb:add:{}", kit_act::fresh())),
    );
    assert_eq!(added.status, wire::ActStatus::Executed as i32);
    let at = open(&mut d, &id, &[], "");
    assert!(
        view(&d, at)
            .menu
            .iter()
            .all(|v| v.kind != V::MakeKey as i32)
    );
    tap(&mut d, at, V::MakeKey);
    assert!(
        view(&d, at).status.is_none(),
        "without the album there is no cover to set"
    );

    let at = open(&mut d, &id, &[], &keepers);
    assert!(verb(&view(&d, at), V::MakeKey).enabled);
    tap(&mut d, at, V::MakeKey);
    assert!(view(&d, at).status.is_none(), "{:?}", view(&d, at).status);
}

#[test]
fn the_place_picker_lists_places_by_name_and_an_empty_choice_clears_the_place() {
    let mut d = driver();
    let id = photo(
        &d,
        Shot {
            lat_lon: Some((50.7, -2.9)),
            ..Shot::new("lb-place")
        },
    );
    let at = open(&mut d, &id, &[], "");
    tap(&mut d, at, V::AdjustLocation);
    let state = view(&d, at);
    assert_eq!(state.sheet, Sheet::Place as i32);
    assert_eq!(state.place_choices[0].name, "No place", "No place leads");
    assert_eq!(state.place_choices[0].place_id, "");
    let names: Vec<String> = state.place_choices[1..]
        .iter()
        .map(|c| c.name.to_lowercase())
        .collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(
        names, sorted,
        "by name, because a member finds a place by reading it"
    );
    let here = state
        .place_choices
        .iter()
        .find(|c| c.here)
        .expect("one is here");
    assert!(!here.place_id.is_empty());
    // Clearing sends the omitted field and closes the sheet.
    send(
        &mut d,
        at,
        ev::Kind::PlaceChosen(ev::PlaceChosen {
            place_id: String::new(),
        }),
    );
    assert_eq!(view(&d, at).sheet, Sheet::None as i32);
    assert_eq!(cell_of(&d, &id).0.place_id, None);
    assert!(!photo_of(&view(&d, at)).has_place);
    // Choosing a place puts it back.
    tap(&mut d, at, V::AdjustLocation);
    let pick = view(&d, at).place_choices.get(1).cloned();
    if let Some(pick) = pick {
        send(
            &mut d,
            at,
            ev::Kind::PlaceChosen(ev::PlaceChosen {
                place_id: pick.place_id.clone(),
            }),
        );
        assert_eq!(
            cell_of(&d, &id).0.place_id.as_deref(),
            Some(pick.place_id.as_str())
        );
    }
}

#[test]
fn copy_exact_location_is_a_copy_the_member_asked_for_and_only_then() {
    let mut d = driver();
    let id = photo(
        &d,
        Shot {
            lat_lon: Some((51.7234, -2.9381)),
            ..Shot::new("lb-copy-location")
        },
    );
    let at = open(&mut d, &id, &[], "");
    let state = view(&d, at);
    assert!(photo_of(&state).has_place);
    // The coordinate is never drawn: only the offer to copy it.
    assert!(photo_of(&state).can_copy_location);
    assert!(
        !photo_of(&state)
            .place_phrase
            .chars()
            .any(|c| c.is_ascii_digit())
    );
    d.effects.clear();
    send(
        &mut d,
        at,
        ev::Kind::CopyLocation(ev::CopyLocationTapped {}),
    );
    let asked = effects_of(&mut d);
    let [wire::effect::Kind::ClipboardSet(copy)] = &asked[..] else {
        panic!("{asked:?}");
    };
    assert!(
        copy.text.contains("51.72") && copy.text.contains("-2.93"),
        "{}",
        copy.text
    );
    assert_eq!(
        view(&d, at).status.expect("receipt").sentence,
        "Exact location copied."
    );
}
