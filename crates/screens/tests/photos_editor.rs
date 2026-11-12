//! `photos.editor` (#1135): the port of `PhotoEditorGeometrySpec` and of the
//! editor machine's behaviour, through a real core. The pixel work is the
//! shell's (`RenderEdit`); these tests answer it the way a shell does, with
//! bytes staged through the stage door.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::photos::editor::{self, FULL_CROP};
use centraid_screens::photos::{self, routes};
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use wire::photos_edit_plan::{Flip, Ratio};
use wire::photos_editor_event as ev;
use wire::photos_editor_state::Phase;
use wire::screen_event::Kind as E;

fn crop(x: f64, y: f64, w: f64, h: f64) -> wire::PhotosEditCrop {
    wire::PhotosEditCrop { x, y, w, h }
}

// -----------------------------------------------------------------------------
// The geometry
// -----------------------------------------------------------------------------

#[test]
fn a_crop_is_clamped_into_the_frame_before_it_is_rounded() {
    // A side below the minimum grows to it; a rectangle off the edge is pulled in.
    let rect = editor::clamp_crop(crop(0.95, -0.2, 0.01, 2.0));
    assert_eq!(editor::crop_pixels(rect, 1000, 1000), (900, 0, 100, 1000));
    // No crop in the plan is the whole frame.
    assert_eq!(
        editor::crop_pixels(FULL_CROP, 4032, 3024),
        (0, 0, 4032, 3024)
    );
}

#[test]
fn a_tie_on_a_half_pixel_goes_up_and_a_rectangle_never_leaves_the_bitmap() {
    // 0.0625 and 0.3125 are exact in binary: half a pixel and two and a half.
    assert_eq!(editor::crop_pixels(crop(0.0625, 0.0, 0.5, 0.5), 8, 8).0, 1);
    assert_eq!(editor::crop_pixels(crop(0.0, 0.0, 0.3125, 0.5), 8, 8).2, 3);
    let (x, y, w, h) = editor::crop_pixels(crop(0.5, 0.5, 0.5, 0.5), 3, 3);
    assert!(x + w <= 3 && y + h <= 3);
}

#[test]
fn the_tools_are_pure_changes_to_the_plan() {
    // The straighten slider's angle is held inside its reach either way.
    assert_eq!(editor::clamp_straighten(0), 0);
    assert_eq!(editor::clamp_straighten(7), 7);
    assert_eq!(editor::clamp_straighten(-15), -15);
    assert_eq!(editor::clamp_straighten(40), 15);
    assert_eq!(editor::clamp_straighten(-40), -15);
    assert_eq!(editor::signed_degrees(0), "0°");
    assert_eq!(editor::signed_degrees(-3), "−3°");
    assert_eq!(editor::signed_degrees(90), "+90°");
    assert_eq!(editor::total_rotation(5, -2), 88);
    // A move never resizes; a scale keeps the aspect; both stay in the frame.
    let moved = editor::move_crop(crop(0.2, 0.2, 0.5, 0.5), 5.0, -5.0);
    assert_eq!(moved, crop(0.5, 0.0, 0.5, 0.5));
    let scaled = editor::scale_crop(crop(0.25, 0.25, 0.5, 0.5), 0.5);
    assert_eq!(scaled, crop(0.375, 0.375, 0.25, 0.25));
    assert_eq!(editor::scale_crop(FULL_CROP, 0.01).w, editor::MIN_CROP);
    // A ratio is the centred rectangle of that ratio inside the frame.
    assert_eq!(editor::centred_crop(2.0, 1.0), crop(0.25, 0.0, 0.5, 1.0));
    assert_eq!(editor::centred_crop(0.5, 1.0), crop(0.0, 0.25, 1.0, 0.5));
    // A straighten grows the frame.
    let (w, h) = editor::rotated_box(4.0, 3.0, 90);
    assert!((w - 3.0).abs() < 1e-9 && (h - 4.0).abs() < 1e-9);
}

#[test]
fn the_decode_constants_are_the_shared_ones() {
    assert_eq!(editor::PREVIEW_EDGE, 2048);
    assert_eq!(editor::JPEG_QUALITY_PERCENT, 92);
    assert!((editor::MIN_CROP - 0.1).abs() < f64::EPSILON);
}

#[test]
fn the_new_photographs_title_is_the_caption_or_an_edited_file_name() {
    let en = Locale::En;
    assert_eq!(editor::saved_title(en, "  Pier day "), "Pier day");
    assert_eq!(
        editor::saved_title(en, "IMG_0042.JPG"),
        "IMG_0042-edited.jpg"
    );
    assert_eq!(editor::saved_title(en, ""), "photo-edited.jpg");
    assert_eq!(editor::saved_title(en, "a b.c"), "a b.c");
}

#[test]
fn the_status_line_says_what_changed_and_nothing_when_nothing_did() {
    let en = Locale::En;
    let mut plan = editor::fresh_plan();
    assert_eq!(editor::editor_status(en, &plan), "");
    plan.ratio = Ratio::ThreeTwo as i32;
    plan.quarters = 1;
    plan.straighten = -3;
    plan.flip = Flip::Horizontal as i32;
    assert_eq!(
        editor::editor_status(en, &plan),
        "Cropped to 3 : 2, rotated +87°, flipped left to right"
    );
    assert!(editor::is_edited(&plan));
    assert!(!editor::is_edited(&editor::fresh_plan()));
}

// -----------------------------------------------------------------------------
// The screen
// -----------------------------------------------------------------------------

fn stage_bytes(d: &Driver, bytes: &[u8]) -> wire::StageHandle {
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

fn upload(d: &Driver, bytes: &[u8], title: Option<&str>, edited_from: Option<&str>) -> String {
    let staged = stage_bytes(d, bytes);
    let response = d.act(
        act::photos::Upload {
            blob: staged.content_hash,
            size: Some(staged.byte_size as i64),
            media_type: "image/jpeg".to_owned(),
            form: Some(act::photos::UploadForm::Photo),
            title: title.map(str::to_owned),
            width: centraid_screens::field::Field::Is(400),
            height: centraid_screens::field::Field::Is(300),
            taken_at: centraid_screens::field::Field::Is("2026-07-30T17:42:00Z".to_owned()),
            edited_from: edited_from
                .map(|id| centraid_screens::field::Field::Is(id.to_owned()))
                .unwrap_or_default(),
            ..Default::default()
        }
        .request()
        .keyed(format!("editor:{}", kit_act::fresh())),
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

fn state_of(d: &Driver, at: u64) -> wire::PhotosEditorState {
    match &d.view(at).kind {
        Some(wire::view_state::Kind::PhotosEditor(state)) => state.clone(),
        other => panic!("not the editor: {other:?}"),
    }
}

fn send(d: &mut Driver, at: u64, kind: ev::Kind) -> wire::ScreenUpdate {
    d.send(
        at,
        E::PhotosEditor(wire::PhotosEditorEvent { kind: Some(kind) }),
    )
}

fn opened(bytes: &[u8]) -> (Driver, u64, String) {
    let mut d = Driver::with_runtime(photos::runtime());
    d.start();
    let id = upload(&d, bytes, Some("Pier day"), None);
    let at = d.push("photos", routes::editor(&id));
    // The Photos home root asks the platform for its tile size; that is not ours.
    d.effects.clear();
    (d, at, id)
}

fn data(state: &wire::PhotosEditorState) -> &wire::PhotosEditorData {
    match &state.content {
        Some(wire::photos_editor_state::Content::Data(data)) => data,
        None => panic!("no data: {:?}", state.page),
    }
}

#[test]
fn it_opens_fresh_on_the_original_with_the_date_the_shutter_fired() {
    let (d, at, _) = opened(b"editor-open-1");
    let state = state_of(&d, at);
    assert_eq!(state.title, "Crop and rotate");
    assert_eq!(state.phase, Phase::Editing as i32);
    assert_eq!(state.plan, Some(editor::fresh_plan()));
    assert!(!state.edited);
    assert_eq!(state.status_line, "");
    assert_eq!(state.straighten_label, "Straighten 0°");
    assert_eq!(state.flip_label, "Flip");
    assert_eq!(data(&state).meta, "from a photo taken 30 July 2026");
    assert_eq!(
        (data(&state).width, data(&state).height),
        (400, 300),
        "the vault's own box, not a decode"
    );
    // The bytes are on this phone, so the original is located and Save is live.
    assert!(!data(&state).original_path.is_empty());
    assert_eq!(state.save_refusal, "");
}

#[test]
fn a_photograph_whose_original_is_not_here_cannot_be_saved_and_says_why() {
    let mut d = Driver::with_runtime(photos::runtime());
    d.start();
    // Staged by hash only: the vault has the photograph and not its bytes.
    let hash = centraid_vault::blob::content_digest(b"no bytes here");
    d.handle
        .command(
            "blob.stage",
            &serde_json::json!({ "hash": hash, "size": 13 }),
            &format!("editor:stage:{}", kit_act::fresh()),
        )
        .expect("stage");
    let made = d.act(
        act::photos::Upload {
            blob: hash,
            media_type: "image/jpeg".to_owned(),
            form: Some(act::photos::UploadForm::Photo),
            ..Default::default()
        }
        .request()
        .keyed(format!("editor:{}", kit_act::fresh())),
    );
    let value: serde_json::Value = serde_json::from_slice(&made.output).expect("json");
    let id = value["id"].as_str().expect("id").to_owned();
    let at = d.push("photos", routes::editor(&id));
    let state = state_of(&d, at);
    assert_ne!(state.save_refusal, "");
    // Save emits no effect and changes nothing.
    let before = d.effects.len();
    send(&mut d, at, ev::Kind::Save(ev::Saved {}));
    assert_eq!(d.effects.len(), before);
    assert_eq!(state_of(&d, at).phase, Phase::Editing as i32);
}

#[test]
fn a_quarter_turn_resets_the_crop_and_the_ratio_and_every_tool_updates_the_words() {
    let (mut d, at, _) = opened(b"editor-tools-1");
    send(
        &mut d,
        at,
        ev::Kind::Ratio(ev::RatioChosen {
            ratio: Ratio::Square as i32,
            frame_ratio: 2.0,
        }),
    );
    let state = state_of(&d, at);
    assert_eq!(
        state.plan.expect("plan").crop,
        Some(crop(0.25, 0.0, 0.5, 1.0))
    );
    assert!(state.edited);
    assert!(
        state
            .ratios
            .iter()
            .find(|r| r.selected)
            .is_some_and(|r| r.label == "Square")
    );
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    let plan = state_of(&d, at).plan.expect("plan");
    assert_eq!(plan.quarters, 1);
    assert_eq!(plan.crop, Some(FULL_CROP));
    assert_eq!(plan.ratio, Ratio::Original as i32);
    send(
        &mut d,
        at,
        ev::Kind::Straighten(ev::Straightened { degrees: -1 }),
    );
    send(&mut d, at, ev::Kind::Flip(ev::Flipped {}));
    let state = state_of(&d, at);
    assert_eq!(state.straighten_limit, 15);
    assert_eq!(state.straighten_label, "Straighten −1°");
    assert_eq!(state.flip_label, "Flip ↔");
    assert_eq!(state.status_line, "Rotated +89°, flipped left to right");
    send(&mut d, at, ev::Kind::Flip(ev::Flipped {}));
    assert_eq!(state_of(&d, at).flip_label, "Flip ↕");
    send(&mut d, at, ev::Kind::Flip(ev::Flipped {}));
    assert_eq!(state_of(&d, at).flip_label, "Flip");
    // THE SLIDER SETS THE ANGLE: either side of level, to the limit and no further.
    send(
        &mut d,
        at,
        ev::Kind::Straighten(ev::Straightened { degrees: 3 }),
    );
    assert_eq!(state_of(&d, at).straighten_label, "Straighten +3°");
    assert_eq!(state_of(&d, at).plan.expect("plan").straighten, 3);
    send(
        &mut d,
        at,
        ev::Kind::Straighten(ev::Straightened { degrees: -99 }),
    );
    assert_eq!(state_of(&d, at).plan.expect("plan").straighten, -15);
    send(
        &mut d,
        at,
        ev::Kind::Straighten(ev::Straightened { degrees: 0 }),
    );
    assert_eq!(state_of(&d, at).straighten_label, "Straighten 0°");
    send(&mut d, at, ev::Kind::Reset(ev::Reset {}));
    assert!(!state_of(&d, at).edited);
    // A move and a scale respect the clamp.
    send(
        &mut d,
        at,
        ev::Kind::CropScaled(ev::CropScaled { factor: 0.5 }),
    );
    send(
        &mut d,
        at,
        ev::Kind::CropMoved(ev::CropMoved { dx: 9.0, dy: 9.0 }),
    );
    assert_eq!(
        state_of(&d, at).plan.expect("plan").crop,
        Some(crop(0.5, 0.5, 0.5, 0.5))
    );
    send(
        &mut d,
        at,
        ev::Kind::CropScaled(ev::CropScaled { factor: 0.0 }),
    );
    assert_eq!(
        state_of(&d, at).plan.expect("plan").crop,
        Some(crop(0.5, 0.5, 0.5, 0.5))
    );
}

#[test]
fn cancel_closes_at_once_when_untouched_and_asks_first_when_there_is_something_to_lose() {
    let (mut d, at, _) = opened(b"editor-cancel-1");
    send(&mut d, at, ev::Kind::Cancel(ev::Cancelled {}));
    let state = state_of(&d, at);
    assert!(state.dismissed);
    assert_eq!(state.phase, Phase::Closed as i32);

    let (mut d, at, _) = opened(b"editor-cancel-2");
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    send(&mut d, at, ev::Kind::Cancel(ev::Cancelled {}));
    let state = state_of(&d, at);
    assert!(!state.dismissed);
    assert_eq!(
        state.discard.as_ref().expect("asked").title,
        "Discard this edit?"
    );
    // The tools are inert while the question is up.
    send(&mut d, at, ev::Kind::Flip(ev::Flipped {}));
    assert_eq!(
        state_of(&d, at).plan.expect("plan").flip,
        Flip::Unspecified as i32
    );
    // Keep editing.
    send(
        &mut d,
        at,
        ev::Kind::Discard(ev::DiscardAnswered { discard: false }),
    );
    let state = state_of(&d, at);
    assert!(state.discard.is_none() && !state.dismissed);
    assert_eq!(state.plan.expect("plan").quarters, 1, "the edit survives");
    // Discard.
    send(&mut d, at, ev::Kind::Cancel(ev::Cancelled {}));
    send(
        &mut d,
        at,
        ev::Kind::Discard(ev::DiscardAnswered { discard: true }),
    );
    assert!(state_of(&d, at).dismissed);
}

fn title_of(d: &Driver, id: &str) -> (String, Option<String>) {
    d.with_ctx(|ctx| {
        let answer = ctx
            .load(load::photos::Photo { id: id.to_owned() }.into())
            .expect("photo");
        match answer.answer.and_then(|a| a.answer) {
            Some(wire::app_query_response::Answer::PhotosPhoto(found)) => {
                let cell = found.photo.expect("photo").cell.expect("cell");
                (cell.title, cell.edited_from)
            }
            other => panic!("photo answered {other:?}"),
        }
    })
}

#[test]
fn save_asks_the_shell_to_render_and_the_answer_becomes_a_new_photograph_over_the_original() {
    let (mut d, at, original) = opened(b"editor-save-original");
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    send(
        &mut d,
        at,
        ev::Kind::Straighten(ev::Straightened { degrees: -1 }),
    );
    let before = d.effects.len();
    send(&mut d, at, ev::Kind::Save(ev::Saved {}));
    assert_eq!(d.effects.len(), before + 1);
    let state = state_of(&d, at);
    assert_eq!(state.phase, Phase::Saving as i32);
    assert_eq!(state.status_line, "Saving new photo");
    let wire::effect::Kind::RenderEdit(render) = d
        .effects
        .last()
        .expect("effect")
        .effect
        .clone()
        .and_then(|e| e.kind)
        .expect("kind")
    else {
        panic!("not a render");
    };
    assert!(
        !render.source_path.is_empty(),
        "the original, not the thumbnail"
    );
    assert_eq!(render.jpeg_quality_percent, 92);
    let plan = render.plan.expect("plan");
    assert_eq!((plan.quarters, plan.straighten), (1, -1));
    // The tools are inert while the render runs.
    send(&mut d, at, ev::Kind::Flip(ev::Flipped {}));
    assert_eq!(
        state_of(&d, at).plan.expect("plan").flip,
        Flip::Unspecified as i32
    );

    // The shell renders, stages the bytes and answers.
    d.effects.drain(..d.effects.len() - 1);
    let staged = stage_bytes(&d, b"rendered edit bytes");
    d.answer_effect(wire::effect_result::Outcome::EditRendered(
        wire::EditRendered {
            content_hash: staged.content_hash,
            byte_size: staged.byte_size,
            media_type: "image/jpeg".to_owned(),
            width: 300,
            height: 400,
        },
    ));
    let state = state_of(&d, at);
    assert_eq!(state.phase, Phase::Saved as i32);
    assert!(state.dismissed);
    let route = state.saved_route.expect("the new photograph's route");
    let Some(wire::route::Args::PhotosLightbox(args)) = route.args else {
        panic!("not the lightbox");
    };
    assert_ne!(args.photo_id, original);
    // The new photograph is an edit of the original and keeps its caption.
    let (title, from) = title_of(&d, &args.photo_id);
    assert_eq!(from.as_deref(), Some(original.as_str()));
    assert_eq!(title, "Pier day");
    // The original is untouched.
    assert_eq!(title_of(&d, &original).0, "Pier day");
}

#[test]
fn a_render_the_shell_could_not_do_is_a_sentence_beside_the_editor_and_the_plan_survives() {
    let (mut d, at, _) = opened(b"editor-fail-1");
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    send(&mut d, at, ev::Kind::Save(ev::Saved {}));
    d.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        reason: "no decoder".to_owned(),
        denied: false,
        cancelled: false,
        ..Default::default()
    }));
    let state = state_of(&d, at);
    assert_eq!(state.phase, Phase::Editing as i32);
    assert!(!state.dismissed);
    assert_eq!(
        state.plan.expect("plan").quarters,
        1,
        "the crop is not redone"
    );
    let failure = state.save_failure.expect("a refusal");
    assert_eq!(failure.sentence, "Photo not saved.");
    assert!(!failure.remedy.is_empty());
    // And a fresh attempt clears the old sentence.
    send(&mut d, at, ev::Kind::Save(ev::Saved {}));
    assert!(state_of(&d, at).save_failure.is_none());
    d.pump(Duration::from_millis(50));
}

#[test]
fn the_lightboxs_edit_button_is_live_only_over_a_still_whose_original_is_here() {
    let en = Locale::En;
    let cell = |form: &str, held: bool| wire::PhotosCell {
        photo_id: "p".to_owned(),
        form: Some(form.to_owned()),
        original_held: held,
        ..Default::default()
    };
    assert_eq!(
        editor::edit_refusal(en, Some(&cell("photo", true)), false),
        None
    );
    assert_eq!(
        editor::edit_refusal(en, Some(&cell("video", true)), false).as_deref(),
        Some("Crop and rotate work on photos only.")
    );
    assert_eq!(
        editor::edit_refusal(en, Some(&cell("photo", false)), false).as_deref(),
        Some("The original is not on this phone yet.")
    );
    assert_eq!(
        editor::edit_refusal(en, Some(&cell("photo", false)), true).as_deref(),
        Some("The original is still loading.")
    );
    assert_eq!(
        editor::edit_refusal(en, None, false).as_deref(),
        Some("This photo is not in a vault yet.")
    );
}

/// THE EDITOR ONLY CROPS, ROTATES AND FLIPS (#1173, decided): no adjustments, no filters, no
/// markup. Both matches below are exhaustive on purpose: a new tool is a new event kind or a
/// new plan field, and either stops this test compiling until the decision is revisited.
#[test]
fn the_editor_only_crops_rotates_and_flips_and_saves_a_new_photograph() {
    // The plan: the quarter turns and the straighten (rotate), the flip, and the crop with its
    // ratio. Nothing about light, colour or marks.
    let wire::PhotosEditPlan {
        quarters: _,
        straighten: _,
        flip: _,
        ratio: _,
        crop: _,
    } = editor::fresh_plan();
    // The events: each is crop, rotate, flip, or the editor's own frame (read, reset, save,
    // cancel, discard).
    let tool = |kind: &ev::Kind| match kind {
        ev::Kind::Ratio(_) | ev::Kind::CropMoved(_) | ev::Kind::CropScaled(_) => "crop",
        ev::Kind::Rotate(_) | ev::Kind::Straighten(_) => "rotate",
        ev::Kind::Flip(_) => "flip",
        ev::Kind::Refreshed(_)
        | ev::Kind::Reset(_)
        | ev::Kind::Save(_)
        | ev::Kind::Cancel(_)
        | ev::Kind::Discard(_) => "frame",
    };
    assert_eq!(tool(&ev::Kind::Flip(ev::Flipped {})), "flip");

    let (mut d, at, original) = opened(b"editor-set-1");
    let state = state_of(&d, at);
    // The words the board shows, from the core.
    assert_eq!(state.title, "Crop and rotate");
    let words = state.words.clone().expect("words");
    assert_eq!(words.save, "Save new photo");
    assert_eq!(words.rotate, "Rotate 90°");
    assert_eq!(words.reset, "Reset");
    // The ratios offered are the three crops: Original, Square and 3 : 2.
    let ratios: Vec<&str> = state.ratios.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(ratios, ["Original", "Square", "3 : 2"]);
    // Saving is a new photograph and never a change to the original's file.
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    send(&mut d, at, ev::Kind::Save(ev::Saved {}));
    let wire::effect::Kind::RenderEdit(_) = d
        .effects
        .last()
        .expect("effect")
        .effect
        .clone()
        .and_then(|e| e.kind)
        .expect("kind")
    else {
        panic!("not a render");
    };
    let staged = stage_bytes(&d, b"rendered edit bytes for the set");
    d.answer_effect(wire::effect_result::Outcome::EditRendered(
        wire::EditRendered {
            content_hash: staged.content_hash,
            byte_size: staged.byte_size,
            media_type: "image/jpeg".to_owned(),
            width: 300,
            height: 400,
        },
    ));
    let route = state_of(&d, at).saved_route.expect("the new photograph");
    let Some(wire::route::Args::PhotosLightbox(args)) = route.args else {
        panic!("not the lightbox");
    };
    assert_ne!(args.photo_id, original, "a new photograph");
    assert_eq!(
        title_of(&d, &args.photo_id).1.as_deref(),
        Some(original.as_str()),
        "an edit of the original"
    );
}

#[test]
fn a_straighten_crops_to_the_frame_the_turned_photograph_fills() {
    // Level, or an unknown shape: nothing to cut.
    assert_eq!(editor::inscribed_crop(1.5, 0, 0), None);
    assert_eq!(editor::inscribed_crop(0.0, 0, 7), None);
    for (ratio, quarters, degrees) in [(1.5, 0, 7), (1.5, 0, -15), (1.5, 1, 9), (0.75, 0, 4)] {
        let fit = editor::inscribed_crop(ratio, quarters, degrees).expect("a crop");
        // Centred, and smaller than the grown box.
        assert!((fit.x - (1.0 - fit.w) / 2.0).abs() < 1e-9 && fit.w < 1.0 && fit.h < 1.0);
        // Every corner of the crop, turned back, lies inside the photograph.
        let (a, b) = if quarters % 2 == 1 {
            (1.0, ratio)
        } else {
            (ratio, 1.0)
        };
        let (box_w, box_h) = editor::rotated_box(a, b, degrees);
        let radians = f64::from(degrees).to_radians();
        for (fx, fy) in [(fit.x, fit.y), (fit.x + fit.w, fit.y + fit.h)] {
            let (x, y) = ((fx - 0.5) * box_w, (fy - 0.5) * box_h);
            let (u, v) = (
                x * radians.cos() + y * radians.sin(),
                -x * radians.sin() + y * radians.cos(),
            );
            assert!(
                u.abs() <= a / 2.0 + 1e-9 && v.abs() <= b / 2.0 + 1e-9,
                "{ratio} {degrees}"
            );
        }
        // And it keeps the photograph's own shape.
        assert!(((fit.w * box_w) / (fit.h * box_h) - a / b).abs() < 1e-9);
    }
}

#[test]
fn an_untouched_crop_follows_the_straighten_and_a_chosen_one_stays() {
    let (mut d, at, _) = opened(b"editor-straighten-fit");
    let crop_of = |d: &Driver| state_of(d, at).plan.expect("plan").crop;
    let straighten = |d: &mut Driver, degrees: i32| {
        send(d, at, ev::Kind::Straighten(ev::Straightened { degrees }));
    };
    // The vault knows this photograph is 400 x 300: a straighten crops to what the turn fills.
    straighten(&mut d, 7);
    let fit = editor::inscribed_crop(400.0 / 300.0, 0, 7);
    assert!(fit.is_some() && fit != Some(FULL_CROP));
    assert_eq!(crop_of(&d), fit);
    // Another angle refits; level goes back to the full frame.
    straighten(&mut d, -4);
    assert_eq!(crop_of(&d), editor::inscribed_crop(400.0 / 300.0, 0, -4));
    straighten(&mut d, 0);
    assert_eq!(crop_of(&d), Some(FULL_CROP));
    // A crop the member moved stays put through the next straighten.
    straighten(&mut d, 5);
    send(
        &mut d,
        at,
        ev::Kind::CropMoved(ev::CropMoved { dx: 0.02, dy: 0.0 }),
    );
    let moved = crop_of(&d);
    straighten(&mut d, 9);
    assert_eq!(crop_of(&d), moved);
    // Picking "Original" gives the crop back to the straighten.
    send(
        &mut d,
        at,
        ev::Kind::Ratio(ev::RatioChosen {
            ratio: Ratio::Original as i32,
            frame_ratio: 1.4,
        }),
    );
    assert_eq!(crop_of(&d), editor::inscribed_crop(400.0 / 300.0, 0, 9));
    // A picked ratio is the member's: the next straighten leaves it.
    send(
        &mut d,
        at,
        ev::Kind::Ratio(ev::RatioChosen {
            ratio: Ratio::Square as i32,
            frame_ratio: 1.4,
        }),
    );
    let square = crop_of(&d);
    straighten(&mut d, 3);
    assert_eq!(crop_of(&d), square);
    // A quarter turn resets the crop to the whole frame, then fits it to the straighten again.
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    assert_eq!(crop_of(&d), editor::inscribed_crop(400.0 / 300.0, 1, 3));
    send(&mut d, at, ev::Kind::Reset(ev::Reset {}));
    assert_eq!(crop_of(&d), Some(FULL_CROP));
}

#[test]
fn a_saved_edit_leaves_its_line_and_undo_on_the_new_photo_the_member_lands_on_and_undo_trashes_it()
{
    let mut d = Driver::with_runtime(photos::runtime());
    d.start();
    let original = upload(&d, b"editor-undo-original", Some("Pier day"), None);
    let lightbox = d.push("photos", routes::lightbox(&original, &[], ""));
    let at = d.push("photos", routes::editor(&original));
    d.effects.clear();
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    send(&mut d, at, ev::Kind::Save(ev::Saved {}));
    let staged = stage_bytes(&d, b"rendered for undo");
    d.answer_effect(wire::effect_result::Outcome::EditRendered(
        wire::EditRendered {
            content_hash: staged.content_hash,
            byte_size: staged.byte_size,
            media_type: "image/jpeg".to_owned(),
            width: 300,
            height: 400,
        },
    ));
    let state = state_of(&d, at);
    assert!(state.dismissed, "the editor finishes");
    let route = state.saved_route.expect("route");
    let Some(wire::route::Args::PhotosLightbox(made)) = route.args.clone() else {
        panic!("not the lightbox");
    };

    // THE SHELL POPS THE EDITOR AND THEN PUSHES THE NEW PHOTOGRAPH: the line is not drawn on the
    // photo beneath, which the member never sees, but on the one they land on.
    d.pop("photos", at);
    let beneath = match &d.view(lightbox).kind {
        Some(wire::view_state::Kind::PhotosLightbox(state)) => state.status.clone(),
        other => panic!("not the lightbox: {other:?}"),
    };
    assert!(beneath.is_none(), "{beneath:?}");
    let landed = d.push("photos", route);
    let status = |d: &Driver| match &d.view(landed).kind {
        Some(wire::view_state::Kind::PhotosLightbox(state)) => state.status.clone(),
        other => panic!("not the lightbox: {other:?}"),
    };
    let said = |line: Option<wire::StatusLine>| {
        let line = line.expect("a status line");
        (line.sentence, line.action_label)
    };
    assert_eq!(
        said(status(&d)),
        ("Saved as a new photo".to_owned(), "Undo".to_owned())
    );
    let trashed = |d: &Driver| {
        d.with_ctx(|ctx| {
            let answer = ctx
                .load(
                    load::photos::Photo {
                        id: made.photo_id.clone(),
                    }
                    .into(),
                )
                .expect("photo");
            match answer.answer.and_then(|a| a.answer) {
                Some(wire::app_query_response::Answer::PhotosPhoto(found)) => {
                    found.photo.is_some_and(|photo| photo.trashed)
                }
                other => panic!("photo answered {other:?}"),
            }
        })
    };
    assert!(!trashed(&d));
    d.send(landed, E::StatusActed(wire::StatusActed {}));
    assert!(trashed(&d), "undo moves the new photograph to trash");
    assert_eq!(said(status(&d)), ("Undone".to_owned(), String::new()));
    assert_eq!(title_of(&d, &original).0, "Pier day");
}

#[test]
fn a_line_left_for_the_page_opened_next_is_dropped_by_any_other_navigation() {
    let mut d = Driver::with_runtime(photos::runtime());
    d.start();
    let original = upload(&d, b"editor-undo-dropped", Some("Pier day"), None);
    let lightbox = d.push("photos", routes::lightbox(&original, &[], ""));
    let at = d.push("photos", routes::editor(&original));
    d.effects.clear();
    send(&mut d, at, ev::Kind::Rotate(ev::Rotated {}));
    send(&mut d, at, ev::Kind::Save(ev::Saved {}));
    let staged = stage_bytes(&d, b"rendered for a dropped line");
    d.answer_effect(wire::effect_result::Outcome::EditRendered(
        wire::EditRendered {
            content_hash: staged.content_hash,
            byte_size: staged.byte_size,
            media_type: "image/jpeg".to_owned(),
            width: 300,
            height: 400,
        },
    ));
    let route = state_of(&d, at).saved_route.expect("route");
    d.pop("photos", at);
    // The member goes back instead of landing on the new photograph: the line is gone, for the
    // page beneath and for any page pushed afterwards.
    d.pop("photos", lightbox);
    let landed = d.push("photos", route);
    match &d.view(landed).kind {
        Some(wire::view_state::Kind::PhotosLightbox(state)) => {
            assert!(state.status.is_none(), "{:?}", state.status);
        }
        other => panic!("not the lightbox: {other:?}"),
    }
}
