//! `photos.editor` (#1135): crop, rotate, straighten and flip one photograph.
//!
//! ## The editor's one promise
//!
//! NOTHING IS WRITTEN UNTIL "Save new photo", AND THEN IT IS A NEW PHOTOGRAPH.
//! The original is never touched. That is structural: the only place a write is
//! made is [`Editor::rendered`], reached from the one `EditRendered` answer to
//! the one [`wire::RenderEdit`] effect, which is sent from [`Editor::save`]; every
//! tool is a pure change to the [`wire::PhotosEditPlan`].
//!
//! ## What Rust owns, and what it cannot
//!
//! The plan is data and is reduced here with v0's clamping (a crop never leaves
//! the frame or shrinks below a tenth of it); so are the sentences (status line,
//! the live labels, the refusal) and the geometry the shell mirrors
//! ([`crop_pixels`], half up). The pixel work is the platform's: the
//! [`wire::RenderEdit`] effect carries the original's file and the plan, and the
//! answer names the bytes the shell staged. The save is then `upload` with
//! `edited_from`, which keeps the original's date, place and caption.
//!
//! Dropped with the Kotlin machine: the seat, the read legs, the pending-render
//! map (the effect id is the runtime's), the content-door call in a bridge (the
//! screen asks `Ctx::content_urls`).

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_edit_plan::{Flip, Ratio};
use wire::photos_editor_event::Kind as K;
use wire::photos_editor_state::Phase;
use wire::screen_event::Kind as E;

use super::cells::{self, Link};
use super::{media, routes};
use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, photos as words, photos_lightbox as own, shared};

/// The slider's reach each way, in whole degrees.
pub const STRAIGHTEN_LIMIT: i32 = 15;
/// Smallest crop side, as a fraction of the frame.
pub const MIN_CROP: f64 = 0.1;
/// The longest edge of a stage's decode: a preview, never the original.
pub const PREVIEW_EDGE: u32 = 2_048;
pub const JPEG_QUALITY_PERCENT: u32 = 92;

pub const FULL_CROP: wire::PhotosEditCrop = wire::PhotosEditCrop {
    x: 0.0,
    y: 0.0,
    w: 1.0,
    h: 1.0,
};

#[must_use]
pub fn fresh_plan() -> wire::PhotosEditPlan {
    wire::PhotosEditPlan {
        quarters: 0,
        straighten: 0,
        flip: Flip::Unspecified as i32,
        ratio: Ratio::Original as i32,
        crop: Some(FULL_CROP),
    }
}

fn crop_of(plan: &wire::PhotosEditPlan) -> wire::PhotosEditCrop {
    plan.crop.unwrap_or(FULL_CROP)
}

// -----------------------------------------------------------------------------
// The geometry (v0's `photo-edit-model.ts`)
// -----------------------------------------------------------------------------

/// The slider's angle, held inside its reach either way.
#[must_use]
pub fn clamp_straighten(degrees: i32) -> i32 {
    degrees.clamp(-STRAIGHTEN_LIMIT, STRAIGHTEN_LIMIT)
}

/// The minus is U+2212, not a hyphen: a number in the numeric register.
#[must_use]
pub fn signed_degrees(degrees: i32) -> String {
    match degrees {
        0 => "0°".to_owned(),
        d if d < 0 => format!("−{}°", d.abs()),
        d => format!("+{d}°"),
    }
}

#[must_use]
pub fn total_rotation(quarters: u32, straighten: i32) -> i32 {
    (quarters % 4) as i32 * 90 + straighten
}

/// Straightening is not a multiple of 90°, so the box grows rather than swapping
/// sides.
#[must_use]
pub fn rotated_box(width: f64, height: f64, degrees: i32) -> (f64, f64) {
    let radians = f64::from(degrees).to_radians();
    let (c, s) = (radians.cos().abs(), radians.sin().abs());
    (width * c + height * s, width * s + height * c)
}

#[must_use]
pub fn rotated_frame_ratio(asset_ratio: f64, degrees: i32) -> f64 {
    let (width, height) = rotated_box(asset_ratio, 1.0, degrees);
    if height > 0.0 {
        width / height
    } else {
        asset_ratio
    }
}

#[must_use]
pub fn clamp_crop(rect: wire::PhotosEditCrop) -> wire::PhotosEditCrop {
    let w = rect.w.clamp(MIN_CROP, 1.0);
    let h = rect.h.clamp(MIN_CROP, 1.0);
    wire::PhotosEditCrop {
        x: rect.x.clamp(0.0, 1.0 - w),
        y: rect.y.clamp(0.0, 1.0 - h),
        w,
        h,
    }
}

/// The size never changes: a resizing drag would silently change the ratio.
#[must_use]
pub fn move_crop(rect: wire::PhotosEditCrop, dx: f64, dy: f64) -> wire::PhotosEditCrop {
    clamp_crop(wire::PhotosEditCrop {
        x: rect.x + dx,
        y: rect.y + dy,
        ..rect
    })
}

/// Keeps its aspect.
#[must_use]
pub fn scale_crop(rect: wire::PhotosEditCrop, factor: f64) -> wire::PhotosEditCrop {
    let (cx, cy) = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0);
    let w = (rect.w * factor).clamp(MIN_CROP, 1.0);
    let h = (rect.h * factor).clamp(MIN_CROP, 1.0);
    clamp_crop(wire::PhotosEditCrop {
        x: cx - w / 2.0,
        y: cy - h / 2.0,
        w,
        h,
    })
}

/// THE CROP A STRAIGHTEN LEAVES FULL OF PHOTOGRAPH: the largest centred rectangle of the photograph's
/// own shape that lies inside the turned photograph, as fractions of the turned box (the frame the
/// crop is in). The board draws the preview cropped to it, so no corner of the frame is empty;
/// `None` when the angle leaves nothing to cut or the shape is unknown.
#[must_use]
pub fn inscribed_crop(
    source_ratio: f64,
    quarters: u32,
    straighten: i32,
) -> Option<wire::PhotosEditCrop> {
    if straighten == 0 || source_ratio <= 0.0 {
        return None;
    }
    // The photograph as it lies after the quarter turns: its sides swap on an odd number.
    let (a, b) = if quarters % 2 == 1 {
        (1.0, source_ratio)
    } else {
        (source_ratio, 1.0)
    };
    let radians = f64::from(straighten).to_radians();
    let (c, s) = (radians.cos().abs(), radians.sin().abs());
    let k = 1.0 / (c + (a / b).max(b / a) * s);
    let (box_w, box_h) = (a * c + b * s, a * s + b * c);
    let (w, h) = (k * a / box_w, k * b / box_h);
    Some(clamp_crop(wire::PhotosEditCrop {
        x: (1.0 - w) / 2.0,
        y: (1.0 - h) / 2.0,
        w,
        h,
    }))
}

/// The centred rectangle of `ratio` inside a frame of `frame_ratio`.
#[must_use]
pub fn centred_crop(frame_ratio: f64, ratio: f64) -> wire::PhotosEditCrop {
    if ratio >= frame_ratio {
        let h = frame_ratio / ratio;
        wire::PhotosEditCrop {
            x: 0.0,
            y: (1.0 - h) / 2.0,
            w: 1.0,
            h,
        }
    } else {
        let w = ratio / frame_ratio;
        wire::PhotosEditCrop {
            x: (1.0 - w) / 2.0,
            y: 0.0,
            w,
            h: 1.0,
        }
    }
}

#[must_use]
pub fn ratio_value(ratio: Ratio) -> Option<f64> {
    match ratio {
        Ratio::Square => Some(1.0),
        Ratio::ThreeTwo => Some(1.5),
        Ratio::Original | Ratio::Unspecified => None,
    }
}

fn half_up(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// Where the crop lands in pixels: rounded half up (v0's `Math.round`, not the
/// even neighbour) and clamped so rounding cannot ask for a rectangle running
/// off the bitmap. The shells mirror this, so one crop is one rectangle.
/// Returns `(x, y, w, h)`.
#[must_use]
pub fn crop_pixels(rect: wire::PhotosEditCrop, width: i64, height: i64) -> (i64, i64, i64, i64) {
    let w = half_up(rect.w * width as f64).max(1);
    let h = half_up(rect.h * height as f64).max(1);
    let x = half_up(rect.x * width as f64).clamp(0, (width - w).max(0));
    let y = half_up(rect.y * height as f64).clamp(0, (height - h).max(0));
    (x, y, w.min(width), h.min(height))
}

#[must_use]
pub fn is_edited(plan: &wire::PhotosEditPlan) -> bool {
    let crop = crop_of(plan);
    let ratio = Ratio::try_from(plan.ratio).unwrap_or(Ratio::Unspecified);
    !matches!(ratio, Ratio::Original | Ratio::Unspecified)
        || total_rotation(plan.quarters, plan.straighten) != 0
        || crop != FULL_CROP
        || plan.flip != Flip::Unspecified as i32
}

/// The new photograph's title: the original's caption when it has one, else
/// `<stem>-edited.jpg` (v0's `editedFilename`, so the member can find it by
/// name). A title still shaped like a file name was never captioned: it gives
/// its stem.
#[must_use]
pub fn saved_title(locale: Locale, title: &str) -> String {
    let trimmed = title.trim();
    if !trimmed.is_empty() && !looks_like_file_name(trimmed) {
        return trimmed.to_owned();
    }
    let stem = if trimmed.is_empty() {
        ""
    } else {
        trimmed.rsplit_once('.').map_or(trimmed, |(stem, _)| stem)
    };
    let stem = if stem.is_empty() {
        own::edit_fallback_name(locale)
    } else {
        stem.to_owned()
    };
    format!("{stem}-edited.jpg")
}

/// `^[^\s/]+\.[A-Za-z0-9]{2,5}$`
fn looks_like_file_name(text: &str) -> bool {
    let Some((stem, extension)) = text.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && !text.chars().any(|c| c.is_whitespace() || c == '/')
        && (2..=5).contains(&extension.len())
        && extension.chars().all(|c| c.is_ascii_alphanumeric())
}

fn ratio_name(locale: Locale, ratio: Ratio) -> String {
    match ratio {
        Ratio::Square => words::photos_edit_ratio_square(locale),
        Ratio::ThreeTwo => words::photos_edit_ratio_three_two(locale),
        Ratio::Original | Ratio::Unspecified => words::photos_edit_ratio_original(locale),
    }
}

fn flip_label(locale: Locale, flip: Flip) -> String {
    match flip {
        Flip::Horizontal => own::edit_flip_horizontal(locale),
        Flip::Vertical => own::edit_flip_vertical(locale),
        Flip::Unspecified => own::edit_flip(locale),
    }
}

fn next_flip(flip: i32) -> i32 {
    match Flip::try_from(flip).unwrap_or(Flip::Unspecified) {
        Flip::Unspecified => Flip::Horizontal as i32,
        Flip::Horizontal => Flip::Vertical as i32,
        Flip::Vertical => Flip::Unspecified as i32,
    }
}

/// What the plan has changed, in words a member would say: `Cropped to Square,
/// rotated +90°`. Nothing changed is nothing said.
#[must_use]
pub fn editor_status(locale: Locale, plan: &wire::PhotosEditPlan) -> String {
    let mut parts = Vec::new();
    let ratio = Ratio::try_from(plan.ratio).unwrap_or(Ratio::Unspecified);
    if !matches!(ratio, Ratio::Original | Ratio::Unspecified) {
        parts.push(fill(
            &own::edit_status_crop(locale),
            &[("ratio", &ratio_name(locale, ratio))],
        ));
    }
    let turned = total_rotation(plan.quarters, plan.straighten);
    if turned != 0 {
        parts.push(fill(
            &own::edit_status_rotate(locale),
            &[("degrees", &signed_degrees(turned))],
        ));
    }
    match Flip::try_from(plan.flip).unwrap_or(Flip::Unspecified) {
        Flip::Horizontal => parts.push(own::edit_status_flip_horizontal(locale)),
        Flip::Vertical => parts.push(own::edit_status_flip_vertical(locale)),
        Flip::Unspecified => {}
    }
    // One sentence: only the first clause keeps its capital.
    let mut sentence = String::new();
    for (at, part) in parts.iter().enumerate() {
        if at > 0 {
            sentence.push_str(", ");
            let mut letters = part.chars();
            if let Some(first) = letters.next() {
                sentence.extend(first.to_lowercase());
                sentence.push_str(letters.as_str());
            }
        } else {
            sentence.push_str(part);
        }
    }
    sentence
}

/// The lightbox's Edit button: live, or refused with the sentence that says why
/// (no verb enabled that cannot run, none disabled without a reason). Crop and
/// rotate are raster work on a still.
#[must_use]
pub fn edit_refusal(
    locale: Locale,
    cell: Option<&wire::PhotosCell>,
    fetching: bool,
) -> Option<String> {
    let Some(cell) = cell.filter(|cell| !cell.photo_id.is_empty()) else {
        return Some(own::not_in_vault(locale));
    };
    if !matches!(cell.form.as_deref(), Some("photo" | "scan")) {
        return Some(words::photos_edit_not_a_photo(locale));
    }
    if cell.original_held {
        None
    } else if fetching {
        Some(words::photos_edit_still_loading(locale))
    } else {
        Some(words::photos_edit_not_on_phone(locale))
    }
}

// -----------------------------------------------------------------------------
// The screen
// -----------------------------------------------------------------------------

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PhotosEditor(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Editor {
        photo_id: args.photo_id.clone(),
        content: Content::Loading,
        plan: fresh_plan(),
        phase: Phase::Editing,
        discard_open: false,
        save_failure: None,
        saved_route: None,
        rendering: None,
        crop_touched: false,
        undo: Undo::default(),
    }))
}

struct Source {
    cell: wire::PhotosCell,
    original_path: String,
    /// The operating system's library holds the original (no file in the store):
    /// the shell resolves it by this reference.
    os_ref: String,
    absent_reason: String,
}

enum Content {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Data(Box<Source>),
}

struct Editor {
    photo_id: String,
    content: Content,
    plan: wire::PhotosEditPlan,
    phase: Phase,
    discard_open: bool,
    save_failure: Option<wire::Failure>,
    saved_route: Option<wire::Route>,
    /// The effect that is rendering: an answer for any other is stale.
    rendering: Option<RenderKey>,
    /// The member moved, resized or ratio-picked the crop: a straighten leaves it alone.
    /// Until then the crop is the frame a straighten leaves full of photograph.
    crop_touched: bool,
    /// The kit's one door; the save leaves the page, so it only ever holds a refusal.
    undo: Undo,
}

/// The plan a render was asked for, so a settle for a plan the member has since
/// changed is recognisably not this one.
type RenderKey = String;

impl Editor {
    fn reload(&mut self, ctx: &Ctx) {
        let reading = read::read(
            ctx,
            load::photos::Photo {
                id: self.photo_id.clone(),
            },
            |answer| match answer {
                Answer::PhotosPhoto(found) => Some(found),
                _ => None,
            },
        );
        match reading {
            Reading::Data(found) => match found.photo.and_then(|detail| detail.cell) {
                Some(cell) => {
                    let (original_path, os_ref, absent_reason) = locate(ctx, &cell);
                    self.content = Content::Data(Box::new(Source {
                        cell,
                        original_path,
                        os_ref,
                        absent_reason,
                    }));
                }
                None => self.content = Content::Failed,
            },
            Reading::Denied(denial) => self.content = Content::Denied(denial),
            Reading::Failed => {
                if !matches!(self.content, Content::Data(_)) {
                    self.content = Content::Failed;
                }
            }
        }
    }

    /// Why Save cannot fire, or `None`.
    ///
    /// THE ORIGINAL, NEVER THE DISPLAY COPY: rendering from a thumbnail would
    /// silently write a smaller photograph than the one the member edited.
    fn save_refusal(&self, locale: Locale) -> Option<String> {
        let Content::Data(source) = &self.content else {
            return Some(words::photos_edit_not_loaded(locale));
        };
        if !matches!(source.cell.form.as_deref(), Some("photo" | "scan")) {
            return Some(words::photos_edit_not_a_photo(locale));
        }
        if source.original_path.is_empty() && source.os_ref.is_empty() {
            return Some(if source.absent_reason.is_empty() {
                words::photos_edit_not_on_phone(locale)
            } else {
                source.absent_reason.clone()
            });
        }
        None
    }

    /// The photograph's own shape (width over height), when the vault knows its pixels.
    fn source_ratio(&self) -> f64 {
        match &self.content {
            Content::Data(source) => match (source.cell.width, source.cell.height) {
                (Some(width), Some(height)) if width > 0 && height > 0 => {
                    width as f64 / height as f64
                }
                _ => 0.0,
            },
            _ => 0.0,
        }
    }

    /// An untouched crop follows the straighten: the frame the turned photograph fills.
    fn refit(&mut self) {
        if self.crop_touched {
            return;
        }
        let fit = inscribed_crop(
            self.source_ratio(),
            self.plan.quarters,
            self.plan.straighten,
        );
        self.plan.crop = Some(fit.unwrap_or(FULL_CROP));
    }

    fn edit(&mut self, kind: K) {
        let touches = matches!(&kind, K::CropMoved(_) | K::CropScaled(_))
            || matches!(&kind, K::Ratio(chosen) if chosen.ratio != Ratio::Original as i32);
        let refits = matches!(&kind, K::Rotate(_) | K::Straighten(_) | K::Reset(_))
            || matches!(&kind, K::Ratio(chosen) if chosen.ratio == Ratio::Original as i32);
        if touches {
            self.crop_touched = true;
        }
        if matches!(&kind, K::Rotate(_) | K::Reset(_))
            || matches!(&kind, K::Ratio(chosen) if chosen.ratio == Ratio::Original as i32)
        {
            self.crop_touched = false;
        }
        self.apply(kind);
        if refits {
            self.refit();
        }
    }

    fn apply(&mut self, kind: K) {
        let plan = &mut self.plan;
        match kind {
            // ROTATION MUST NOT SILENTLY RE-CROP AGAINST THE OLD ORIENTATION.
            K::Rotate(_) => {
                plan.quarters = (plan.quarters + 1) % 4;
                plan.crop = Some(FULL_CROP);
                plan.ratio = Ratio::Original as i32;
            }
            K::Straighten(set) => plan.straighten = clamp_straighten(set.degrees),
            K::Flip(_) => plan.flip = next_flip(plan.flip),
            K::Ratio(chosen) => {
                let ratio = Ratio::try_from(chosen.ratio).unwrap_or(Ratio::Unspecified);
                plan.ratio = chosen.ratio;
                plan.crop = Some(match ratio_value(ratio) {
                    Some(value) if chosen.frame_ratio > 0.0 => {
                        centred_crop(chosen.frame_ratio, value)
                    }
                    _ => FULL_CROP,
                });
            }
            K::CropMoved(moved) => {
                plan.crop = Some(move_crop(crop_of(plan), moved.dx, moved.dy));
            }
            K::CropScaled(scaled) => {
                if scaled.factor > 0.0 {
                    plan.crop = Some(scale_crop(crop_of(plan), scaled.factor));
                }
            }
            K::Reset(_) => *plan = fresh_plan(),
            _ => {}
        }
    }

    /// THE COMMIT, OR NOTHING: a refused save changes nothing, because the
    /// refusal is already beside an outlined commit.
    fn save(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        if self.save_refusal(locale).is_some() {
            return Vec::new();
        }
        let Content::Data(source) = &self.content else {
            return Vec::new();
        };
        let mut plan = self.plan;
        plan.crop = Some(clamp_crop(crop_of(&plan)));
        let key = save_key(&self.photo_id, &plan);
        self.phase = Phase::Saving;
        self.save_failure = None;
        self.rendering = Some(key);
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::RenderEdit(wire::RenderEdit {
                source_path: source.original_path.clone(),
                os_ref: source.os_ref.clone(),
                plan: Some(plan),
                jpeg_quality_percent: JPEG_QUALITY_PERCENT,
            })),
        }]
    }

    /// A render landed (or did not): the new photograph is committed through
    /// `upload`, which keeps the original's date, place and caption.
    fn rendered(&mut self, result: &wire::EffectResult, ctx: &Ctx) {
        let locale = ctx.locale();
        if self.phase != Phase::Saving || self.rendering.is_none() {
            return;
        }
        self.rendering = None;
        let rendered = match &result.outcome {
            Some(wire::effect_result::Outcome::EditRendered(done)) => done.clone(),
            _ => return self.refused(locale, &own::edit_no_vault(locale)),
        };
        let key = kit_act::key(
            &["edit", &self.photo_id, &rendered.content_hash],
            kit_act::fresh(),
        );
        // The editor leaves for the new photograph on success, so the write says nothing here (the
        // new photograph is in the library, and the lightbox moves it to trash with Undo).
        let settled = self.undo.act_quietly(
            ctx,
            act::photos::Upload {
                blob: rendered.content_hash,
                media_type: rendered.media_type,
                size: i64::try_from(rendered.byte_size).ok(),
                form: Some(act::photos::UploadForm::Photo),
                edited_from: Field::Is(self.photo_id.clone()),
                width: positive(rendered.width),
                height: positive(rendered.height),
                ..Default::default()
            },
            &key,
        );
        if settled.committed {
            self.phase = Phase::Saved;
            self.saved_route = settled
                .output_text("id")
                .map(|id| routes::lightbox(&id, &[], ""));
        } else {
            self.refused(locale, &settled.refusal);
        }
    }

    /// Back to editing with the plan INTACT, the noun and the way forward beside
    /// the editor: a member can press Save again without redoing the crop.
    fn refused(&mut self, locale: Locale, why: &str) {
        self.phase = Phase::Editing;
        self.save_failure = Some(wire::Failure {
            sentence: words::photos_error_edit_not_saved(locale),
            remedy: if why.is_empty() {
                own::edit_retry(locale)
            } else {
                why.to_owned()
            },
        });
    }
}

fn positive(value: u32) -> Field<i64> {
    if value > 0 {
        Field::Is(i64::from(value))
    } else {
        Field::Keep
    }
}

/// The key is the photograph and the plan, never a counter.
fn save_key(photo_id: &str, plan: &wire::PhotosEditPlan) -> String {
    let crop = crop_of(plan);
    format!(
        "edit:{photo_id}:{}:{}:{}:{},{},{},{}",
        plan.quarters, plan.straighten, plan.flip, crop.x, crop.y, crop.w, crop.h
    )
}

/// The original's file on this phone, and the door's reason when it is not here.
fn locate(ctx: &Ctx, cell: &wire::PhotosCell) -> (String, String, String) {
    if cell.content_id.is_empty() {
        return (String::new(), String::new(), String::new());
    }
    let request = wire::ContentUrlRequest {
        refs: vec![wire::ContentRef {
            content_id: cell.content_id.clone(),
            owner_type: "photo".to_owned(),
            owner_id: cell.photo_id.clone(),
        }],
    };
    match ctx
        .content_urls(&request)
        .ok()
        .and_then(|urls| urls.urls.into_iter().next())
    {
        Some(url) => (url.path.unwrap_or_default(), url.os_ref, url.absent_reason),
        None => (String::new(), String::new(), String::new()),
    }
}

impl Screen for Editor {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                // A change while a render runs must not swap the source under it.
                if self.phase == Phase::Editing {
                    self.reload(ctx);
                }
            }
            Some(E::EffectResult(result)) => self.rendered(&result, ctx),
            Some(E::PhotosEditor(event)) => {
                let Some(kind) = event.kind else {
                    return Vec::new();
                };
                match kind {
                    K::Refreshed(_) => self.reload(ctx),
                    // WHILE A SAVE RUNS THE TOOLS ARE INERT: a crop moved while
                    // the render reads the plan would save a plan the member was
                    // no longer looking at.
                    _ if self.phase != Phase::Editing => {}
                    K::Discard(answer) => {
                        if self.discard_open {
                            self.discard_open = false;
                            if answer.discard {
                                self.phase = Phase::Closed;
                            }
                        }
                    }
                    _ if self.discard_open => {}
                    K::Cancel(_) => {
                        if is_edited(&self.plan) {
                            self.discard_open = true;
                        } else {
                            self.phase = Phase::Closed;
                        }
                    }
                    K::Save(_) => return self.save(ctx),
                    other => self.edit(other),
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        use wire::photos_editor_state::Content as C;
        let content = match &self.content {
            Content::Loading => C::Loading(wire::Loading { first_load: true }),
            Content::Failed => C::Failure(read::failure(locale)),
            Content::Denied(denial) => C::Denied(wire::Denied {
                title: own::denied_title(locale),
                body: own::denied_body(locale),
                receipt: denial.code.clone().unwrap_or_default(),
            }),
            Content::Data(source) => {
                let cell = &source.cell;
                let offset = cell.offset_min.unwrap_or(0);
                let date = cell
                    .taken_at
                    .as_deref()
                    .map(|at| media::stamp_date(locale, at, offset))
                    .unwrap_or_default();
                C::Data(Box::new(wire::PhotosEditorData {
                    tile: Some(cells::tile(cell, Link::default(), locale)),
                    original_path: source.original_path.clone(),
                    width: cell.width.map_or(0, |w| u32::try_from(w).unwrap_or(0)),
                    height: cell.height.map_or(0, |h| u32::try_from(h).unwrap_or(0)),
                    meta: if date.is_empty() {
                        words::photos_edit_from_undated(locale)
                    } else {
                        fill(&words::photos_edit_from_dated(locale), &[("date", &date)])
                    },
                }))
            }
        };
        let current = Ratio::try_from(self.plan.ratio).unwrap_or(Ratio::Unspecified);
        let discard = self.discard_open.then(|| wire::Confirm {
            title: words::photos_edit_discard_question(locale),
            body: String::new(),
            confirm_label: words::photos_edit_discard(locale),
            destructive: true,
        });
        let state = wire::PhotosEditorState {
            photo_id: self.photo_id.clone(),
            title: words::photos_editor_title(locale),
            content: Some(content),
            phase: self.phase as i32,
            status_line: if self.phase == Phase::Saving {
                words::photos_edit_saving(locale)
            } else {
                editor_status(locale, &self.plan)
            },
            straighten_label: fill(
                &own::edit_straighten(locale),
                &[("degrees", &signed_degrees(self.plan.straighten))],
            ),
            flip_label: flip_label(
                locale,
                Flip::try_from(self.plan.flip).unwrap_or(Flip::Unspecified),
            ),
            edited: is_edited(&self.plan),
            save_refusal: self.save_refusal(locale).unwrap_or_default(),
            discard,
            save_failure: self.save_failure.clone(),
            saved_route: self.saved_route.clone(),
            dismissed: matches!(self.phase, Phase::Closed | Phase::Saved),
            ratios: [Ratio::Original, Ratio::Square, Ratio::ThreeTwo]
                .into_iter()
                .map(|ratio| wire::PhotosEditorRatio {
                    ratio: ratio as i32,
                    label: ratio_name(locale, ratio),
                    selected: ratio == current
                        || (ratio == Ratio::Original && current == Ratio::Unspecified),
                })
                .collect(),
            words: Some(wire::PhotosEditorWords {
                cancel: words::photos_cancel(locale),
                save: words::photos_save_as_new(locale),
                save_explanation: words::photos_save_as_new_explanation(locale),
                rotate: words::photos_edit_rotate(locale),
                reset: words::photos_edit_reset(locale),
                crop: words::photos_edit_crop(locale),
                crop_hint: words::photos_crop_hint(locale),
                loading: shared::kit_opening(locale),
                retry: shared::kit_retry(locale),
                crop_area: words::photos_crop_area(locale),
                crop_left: words::photos_crop_left(locale),
                crop_right: words::photos_crop_right(locale),
                crop_up: words::photos_crop_up(locale),
                crop_down: words::photos_crop_down(locale),
                crop_larger: words::photos_crop_larger(locale),
                crop_smaller: words::photos_crop_smaller(locale),
            }),
            plan: Some(self.plan),
            straighten_limit: STRAIGHTEN_LIMIT.unsigned_abs(),
        };
        wire::ViewState {
            instance: 0,
            revision: 0,
            kind: Some(wire::view_state::Kind::PhotosEditor(state)),
        }
    }
}
