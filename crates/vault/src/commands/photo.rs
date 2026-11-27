//! `photo.*` and `album.set_cover`: a photograph enters the library, its capture facts are
//! corrected, an album chooses its cover. The camera roll is followed through [`ROLL`].
//!
//! A photograph is an entity of kind `photo` over one blob. **`photo.blob` is not unique** (A11):
//! identity is never taken from a value. "A re-offered photograph commits once" is the command's
//! rule: `photo.add` reads the offered bytes' hash through `photo_by_blob`, and when a photograph
//! is already over them (live or in the trash) it answers that one and writes nothing. **It never
//! pulls a photograph out of the trash**: the member trashed it, so it stays trashed and the answer
//! says so. A photograph the member picked or uploaded is an *arrival* (`arrived_via`), not an
//! origin; the camera roll is a followed store whose purged photographs are tombstones, so a
//! photograph the member trashed stays trashed after a rescan and one purged is never added again.
//!
//! Its title is the member's caption and may be empty. Everything a member does to a photograph
//! that is not about its capture is a shared verb: the caption (`entity.retitle`), a heart or the
//! archive (`entity.star`, `entity.archive`), a label (`tag.add`), the trash and the purge
//! (`entity.*`), an album (`container.create` of kind `album`; `edge.add`, `edge.move` and
//! `edge.remove` of `contains`, ordered: a photograph may be in several albums), a perceptual
//! hash, a caption or a thumbnail (`derivative.write`).
//!
//! ## Where it was taken, and where it belongs
//!
//! `lat`/`lon` are where the photograph was taken, read from its bytes or corrected by the member
//! (`photo.edit`); the map reads them through the spatial index (`index::viewport`), which the
//! commit maintains from these rows. **A photograph never creates a place** (H3, D5): `place_id`
//! is a *named place the member has*, chosen by the member (`photo.set_place`, or `place_id` at
//! add), never made from a coordinate or from the words a phone gave.
//!
//! ## A Live or Motion Photo
//!
//! The clip is `motion_blob` with its `motion_duration_s` (H1): kept by a version like any blob
//! (history slot `motion`) and rented by the photograph (the backup's renter row).
//!
//! ## Shelves
//!
//! What the bytes are is `photo.form` (a lookup: [`Form`]): the Videos and Scans shelves read
//! `photo_by_form`. An edit made from another photograph names it in `edited_from` and **keeps the
//! original's date, place, coordinates and caption** unless it says otherwise.
//!
//! ## Thumbnails
//!
//! A photograph the Rust fallback can decode (JPEG, PNG) gets its `thumb` and `preview`
//! derivatives from the command itself when the shell staged none; the platform renders what the
//! fallback cannot (HEIC, a film's poster) and stages it through `derivative.write`. Whether a
//! variant is a file or text is the lookup's (`derivative_variant.has_out`), checked by the
//! derivative's own key.
//!
//! ## An album's cover
//!
//! An album's `cover` is the blob of one of its photographs. A cover that is no longer a member
//! (taken out of the album, or purged) is not drawn: the read falls back to the album's first
//! photograph, and a purge clears the covers that named the purged bytes so the bytes can be
//! collected.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::commands::document::{claim, pre_claimable};
use crate::commands::entity::{home_refusal, lookup_live};
use crate::commands::follow::{Gone, OriginRow, SystemMap};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, arrival, deserialize_patch,
};
use crate::error::Result;
use crate::model::Kind;

/// What the bytes are, as the library draws them: the `photo_form` lookup's rows, held equal to
/// the table by `tests/lookups.rs`. Whether a value is one is the table's (the column's key); this
/// is only how a media type reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Form {
    /// A still picture.
    Photo,
    /// A film.
    Video,
    /// A page scanned or photographed as a document.
    Scan,
}

impl Form {
    /// Every form, in the order of the lookup's codes.
    pub const ALL: [Self; 3] = [Self::Photo, Self::Scan, Self::Video];

    /// The `photo_form.code`.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Photo => "photo",
            Self::Video => "video",
            Self::Scan => "scan",
        }
    }

    /// What a media type is shown as; `None` for what is not a picture at all (sound is a
    /// document).
    #[must_use]
    pub fn of(media_type: &str) -> Option<Self> {
        let media_type = media_type.to_ascii_lowercase();
        if media_type.starts_with("audio/") {
            None
        } else if media_type.starts_with("video/") {
            Some(Self::Video)
        } else if media_type.starts_with("image/") {
            Some(Self::Photo)
        } else {
            Some(Self::Scan)
        }
    }
}

fn is_photo(connection: &Connection, id: &str) -> Result<std::result::Result<(), String>> {
    Ok(match lookup_live(connection, id)? {
        Err(sentence) => Err(sentence),
        Ok(found) if found.kind != Kind::Photo => Err(format!(
            "“{}” is a {}, not a photograph",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => Ok(()),
    })
}

/// A sentence when `place_id` is not a live place the member has.
fn place_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(id) = ctx.optional_str("place_id") else {
        return Ok(None);
    };
    Ok(match lookup_live(ctx.connection(), id)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Place => Some(format!(
            "“{}” is a {}, not a place",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

/// A sentence when the command gives one of `lat`/`lon` without the other.
fn together_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    let given = |key: &str| ctx.input.get(key).is_some_and(|value| !value.is_null());
    (given("lat") != given("lon"))
        .then(|| "a latitude and a longitude go together: give both or neither".to_owned())
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let media_type = ctx.required_str("media_type")?;
    if Form::of(media_type).is_none() {
        return Ok(Some(
            "sound is kept in Docs; Photos holds photographs, video and scans".to_owned(),
        ));
    }
    if let Some(form) = ctx.optional_str("form") {
        let known: bool = ctx.connection().query_row(
            "SELECT EXISTS (SELECT 1 FROM vocab WHERE domain = 'photo_form' AND code = ?1)",
            [form],
            |row| row.get(0),
        )?;
        if !known {
            return Ok(Some(format!(
                "“{form}” is not a kind of picture this library keeps"
            )));
        }
    }
    if let Some(sentence) = pre_claimable(ctx, "blob", "size")? {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = pre_claimable(ctx, "motion_blob", "motion_size")? {
        return Ok(Some(sentence));
    }
    if ctx
        .input
        .get("motion_duration_s")
        .is_some_and(|d| !d.is_null())
        && ctx.optional_str("motion_blob").is_none()
    {
        return Ok(Some(
            "a clip's length needs the clip: give its bytes too".to_owned(),
        ));
    }
    if let Some(sentence) = together_refusal(ctx) {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = home_refusal(
        ctx.connection(),
        Kind::Photo,
        None,
        ctx.optional_str("home"),
    )? {
        return Ok(Some(sentence));
    }
    if let Some(source) = ctx.optional_str("edited_from")
        && let Err(sentence) = is_photo(ctx.connection(), source)?
    {
        return Ok(Some(sentence));
    }
    place_refusal(ctx)
}

/// The facts an edit takes from the photograph it was made from.
#[derive(Default)]
struct Inherited {
    title: String,
    taken_at: Option<String>,
    offset_min: Option<i64>,
    lat: Option<f64>,
    lon: Option<f64>,
    place_id: Option<String>,
}

fn inherited(ctx: &CommandCtx<'_, '_>, source: Option<&str>) -> Result<Inherited> {
    let Some(source) = source else {
        return Ok(Inherited::default());
    };
    Ok(ctx.connection().query_row(
        "SELECT e.title, p.taken_at, p.offset_min, p.lat, p.lon, p.place_id
           FROM photo p JOIN entity e ON e.id = p.id WHERE p.id = ?1",
        [source],
        |row| {
            Ok(Inherited {
                title: row.get(0)?,
                taken_at: row.get(1)?,
                offset_min: row.get(2)?,
                lat: row.get(3)?,
                lon: row.get(4)?,
                place_id: row.get(5)?,
            })
        },
    )?)
}

/// The photograph the offered bytes already are in the same home (the library, or the item a
/// capture is filed inside), by the hash read through `photo_by_blob`: the oldest one, in the trash
/// or not, and whether it is in the trash.
fn photograph_over(
    ctx: &CommandCtx<'_, '_>,
    blob: &str,
    home: Option<&str>,
) -> Result<Option<(String, bool)>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT p.id, e.deleted_at IS NOT NULL
               FROM photo p JOIN entity e ON e.id = p.id
              WHERE p.blob = ?1 AND e.parent_id IS ?2 ORDER BY e.n LIMIT 1",
            rusqlite::params![blob, home],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// A photo's time is an instant: a stated date or wall clock is read as UTC.
fn instant(stated: &str) -> String {
    crate::time::recurrence::parse_instant_ms(stated)
        .map_or_else(|| stated.to_owned(), crate::clock::format_iso_ms)
}

#[derive(serde::Deserialize)]
struct AddPhotoInput {
    id: Option<String>,
    blob: String,
    media_type: String,
    form: Option<String>,
    title: Option<String>,
    taken_at: Option<String>,
    offset_min: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    duration_s: Option<f64>,
    exif: Option<serde_json::Value>,
    burst: Option<String>,
    edited_from: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    place_id: Option<String>,
    home: Option<String>,
    motion_blob: Option<String>,
    motion_duration_s: Option<f64>,
    phash: Option<String>,
    thumbhash: Option<String>,
}

/// `photo.add`: a photograph the member picked, took or edited in the app enters the library as
/// an arrival. The same bytes offered again commit once (see the module header).
fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AddPhotoInput = ctx.parse_input()?;
    claim(ctx, "blob", "size")?;
    claim(ctx, "motion_blob", "motion_size")?;
    if let Some((id, trashed)) = photograph_over(ctx, &input.blob, input.home.as_deref())? {
        // The burst the bytes now say they belong to, on a photograph that has none yet; a
        // photograph in the trash is left exactly as the member left it.
        if let (Some(burst), false) = (input.burst.as_deref(), trashed) {
            ctx.connection().execute(
                "UPDATE photo SET burst = ?2 WHERE id = ?1 AND burst IS NULL",
                [id.as_str(), burst],
            )?;
        }
        return Ok(serde_json::json!({ "id": id, "deduped": true, "trashed": trashed }));
    }
    let source = inherited(ctx, input.edited_from.as_deref())?;
    let (lat, lon) = match (input.lat, input.lon) {
        (Some(lat), Some(lon)) => (Some(lat), Some(lon)),
        _ => (source.lat, source.lon),
    };
    let place_id = input.place_id.or(source.place_id);
    let title = input.title.as_deref().unwrap_or(&source.title).trim();
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_in(id, Kind::Photo, title, input.home.as_deref())?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(Kind::Photo, title, input.home.as_deref())?,
    };
    let form = input
        .form
        .as_deref()
        .or_else(|| Form::of(&input.media_type).map(Form::code))
        .unwrap_or_else(|| Form::Scan.code());
    let exif = input
        .exif
        .filter(Json::is_object)
        .map(|value| value.to_string());
    ctx.connection().execute(
        "INSERT INTO photo (id, blob, media_type, form, taken_at, offset_min, width, height,
                            duration_s, lat, lon, motion_blob, motion_duration_s, exif, burst,
                            edited_from, place_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        rusqlite::params![
            id,
            input.blob,
            input.media_type,
            form,
            input.taken_at.as_deref().map(instant).or(source.taken_at),
            input.offset_min.or(source.offset_min),
            input.width,
            input.height,
            input.duration_s,
            lat,
            lon,
            input.motion_blob,
            input.motion_duration_s,
            exif,
            input.burst,
            input.edited_from,
            place_id,
        ],
    )?;
    // What the phone worked out about the picture rides with it: two small values, so a library of
    // thousands is one command each, not three.
    for (variant, value) in [
        ("phash", input.phash.as_deref()),
        ("thumbhash", input.thumbhash.as_deref()),
    ] {
        if let Some(value) = value {
            crate::blob::write_derivative(
                ctx.connection(),
                &ctx.now,
                &input.blob,
                variant,
                None,
                Some(value),
            )?;
        }
    }
    derive_image_tiers(ctx, &input.blob, &input.media_type)?;
    arrival::record(ctx, &id, Kind::Photo)?;
    Ok(serde_json::json!({ "id": id, "deduped": false, "trashed": false }))
}

/// Write the `thumb` and `preview` derivatives of an image the core can decode, when the shell
/// staged none (#1025 S3, D-1025-S7-50).
///
/// **A failed thumbnail never costs the member the original.** Every branch that cannot produce
/// one returns quietly: a type the Rust fallback cannot decode (HEIC, RAW, a film's poster — the
/// platform renders those and stages them), a vault with no content store, bytes this device does
/// not hold, a store that refuses a write. The page door's `held_thumbnail` falls back through
/// `thumb`, `poster` and the original, so a missing derivative is a slower first paint and never a
/// blank cell. It asks the index first, so a re-add decodes nothing.
fn derive_image_tiers(ctx: &CommandCtx<'_, '_>, blob: &str, media_type: &str) -> Result<()> {
    if !centraid_media::renditions::is_derivable(media_type) {
        return Ok(());
    }
    let already: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM derivative WHERE blob = ?1 AND variant IN ('thumb', 'preview')",
        [blob],
        |row| row.get(0),
    )?;
    let Some(store) = ctx.blobs().filter(|_| already == 0) else {
        return Ok(());
    };
    let Ok(bytes) = store.get(blob) else {
        return Ok(());
    };
    for rendition in centraid_media::renditions::renditions_of(&bytes, media_type) {
        let Ok(out) = store.put(&rendition.bytes) else {
            continue;
        };
        crate::blob::write_derivative(
            ctx.connection(),
            &ctx.now,
            blob,
            rendition.variant,
            Some((
                &out,
                i64::try_from(rendition.bytes.len()).unwrap_or(i64::MAX),
                centraid_media::renditions::DERIVATIVE_MEDIA_TYPE,
            )),
            None,
        )?;
    }
    Ok(())
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let id = ctx.required_str("id")?;
    if let Err(sentence) = is_photo(ctx.connection(), id)? {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = together_refusal(ctx) {
        return Ok(Some(sentence));
    }
    let Some(source) = ctx.optional_str("edited_from") else {
        return Ok(None);
    };
    if let Err(sentence) = is_photo(ctx.connection(), source)? {
        return Ok(Some(sentence));
    }
    // Climb from the source: finding the photograph itself would make it an edit of its own edit.
    // (The database refuses the same row: `photo_lineage_is_acyclic`.)
    let loops: bool = ctx.connection().query_row(
        "WITH RECURSIVE up(id) AS (
           SELECT ?1 UNION SELECT p.edited_from FROM photo p JOIN up ON p.id = up.id
            WHERE p.edited_from IS NOT NULL)
         SELECT EXISTS (SELECT 1 FROM up WHERE id = ?2)",
        [source, id],
        |row| row.get(0),
    )?;
    Ok(loops.then(|| "a photograph cannot be an edit of its own edit".to_owned()))
}

#[derive(serde::Deserialize)]
struct EditPhotoInput {
    id: String,
    #[serde(default, deserialize_with = "deserialize_patch")]
    taken_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    offset_min: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    lat: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    lon: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    edited_from: Option<Option<String>>,
}

/// Set the capture facts that were named; a name given as `null` clears its fact.
fn edit(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: EditPhotoInput = ctx.parse_input()?;
    if let Some(taken_at) = input.taken_at {
        let canonical = taken_at.as_deref().map(crate::time::temporal::canonical);
        ctx.connection().execute(
            "UPDATE photo SET taken_at = ?2 WHERE id = ?1",
            rusqlite::params![input.id, canonical],
        )?;
    }
    if let Some(offset_min) = input.offset_min {
        ctx.connection().execute(
            "UPDATE photo SET offset_min = ?2 WHERE id = ?1",
            rusqlite::params![input.id, offset_min],
        )?;
    }
    if let (Some(lat), Some(lon)) = (input.lat, input.lon) {
        // One statement: the table holds a latitude and a longitude together after it.
        ctx.connection().execute(
            "UPDATE photo SET lat = ?2, lon = ?3 WHERE id = ?1",
            rusqlite::params![input.id, lat, lon],
        )?;
    }
    if let Some(edited_from) = input.edited_from {
        ctx.connection().execute(
            "UPDATE photo SET edited_from = ?2 WHERE id = ?1",
            rusqlite::params![input.id, edited_from],
        )?;
    }
    ctx.touch(&input.id)?;
    Ok(serde_json::json!({ "id": input.id }))
}

fn pre_set_place(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = is_photo(ctx.connection(), ctx.required_str("id")?)? {
        return Ok(Some(sentence));
    }
    place_refusal(ctx)
}

#[derive(serde::Deserialize)]
struct SetPlaceInput {
    id: String,
    place_id: Option<String>,
}

/// Point the photograph at a place the member has, or (no `place_id`) clear it back to none. Where
/// it was taken (`lat`, `lon`) is not touched: a place is a name, a coordinate is a fact.
fn set_place(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: SetPlaceInput = ctx.parse_input()?;
    ctx.connection().execute(
        "UPDATE photo SET place_id = ?2 WHERE id = ?1",
        rusqlite::params![input.id, input.place_id],
    )?;
    ctx.touch(&input.id)?;
    Ok(serde_json::json!({ "id": input.id }))
}

fn pre_cover(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let album = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Err(sentence) => return Ok(Some(sentence)),
        Ok(found) if found.kind != Kind::Album => {
            return Ok(Some(format!(
                "“{}” is a {}, not an album",
                found.title,
                found.kind.noun()
            )));
        }
        Ok(found) => found,
    };
    let Some(photo) = ctx.optional_str("photo_id") else {
        return Ok(None);
    };
    let member: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'contains' AND to_id = ?2",
        [&album.id, photo],
        |row| row.get(0),
    )?;
    Ok((member == 0).then(|| format!("that photograph is not in “{}”", album.title)))
}

#[derive(serde::Deserialize)]
struct SetCoverInput {
    id: String,
    photo_id: Option<String>,
}

/// Choose one of the album's photographs as its cover, or (no `photo_id`) let the album fall back
/// to its first.
fn set_cover(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: SetCoverInput = ctx.parse_input()?;
    let blob: Option<String> = match input.photo_id.as_deref() {
        Some(photo) => Some(ctx.connection().query_row(
            "SELECT blob FROM photo WHERE id = ?1",
            [photo],
            |row| row.get(0),
        )?),
        None => None,
    };
    ctx.connection().execute(
        "UPDATE container SET cover = ?2 WHERE id = ?1",
        rusqlite::params![input.id, blob],
    )?;
    ctx.touch(&input.id)?;
    Ok(serde_json::json!({ "id": input.id }))
}

// ---------------------------------------------------------------------------
// The camera roll, followed
// ---------------------------------------------------------------------------

/// A record of the roll: the file's own facts are read as the library draws them. A record with
/// no media type, or whose bytes are sound, is not a photograph (the pass counts it refused); the
/// form is the one the bytes say when the phone did not name it; a clip's bytes are claimed at the
/// size the phone counted (`motion_size`), and the capture's metadata is kept as one JSON text.
fn roll_shape(
    ctx: &CommandCtx<'_, '_>,
    fields: &mut serde_json::Map<String, Json>,
) -> std::result::Result<(), String> {
    let media_type = fields
        .get("media_type")
        .and_then(Json::as_str)
        .ok_or_else(|| "a photograph says what its bytes are".to_owned())?;
    let form = Form::of(media_type).ok_or_else(|| "sound is kept in Docs".to_owned())?;
    fields
        .entry("form")
        .or_insert_with(|| Json::String(form.code().to_owned()));
    if let Some(size) = fields.remove("motion_size").and_then(|size| size.as_i64())
        && let Some(hash) = fields.get("motion_blob").and_then(Json::as_str)
    {
        crate::blob::stage(ctx.connection(), hash, size).map_err(|error| error.to_string())?;
    }
    // The capture's metadata is one JSON text, so what the row holds and what was stated compare.
    if let Some(exif) = fields.get_mut("exif")
        && exif.is_object()
    {
        *exif = Json::String(exif.to_string());
    }
    crate::commands::follow::canonical_instants(fields, &["taken_at"]);
    Ok(())
}

fn no_defaults(
    _: &Connection,
    _: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(Vec::new())
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

/// The `camera_roll` system (A11): a photograph of the phone's library, over the bytes the phone
/// staged. The file's own facts are written once (`fixed`); where and when it was taken are the
/// phone's word until the member corrects them. A photograph gone from the phone stays in the
/// vault (`Gone::Forget`), one the member trashed stays trashed, one purged is a tombstone and is
/// never added again. Nothing names a match key: two photographs are never "the same".
pub const ROLL: SystemMap = SystemMap {
    system: "camera_roll",
    command: "follow.camera_roll",
    kind: Kind::Photo,
    claims: Some("blob"),
    fields: &[
        "blob",
        "media_type",
        "form",
        "width",
        "height",
        "duration_s",
        "exif",
        "taken_at",
        "offset_min",
        "lat",
        "lon",
        "motion_blob",
        "motion_duration_s",
        "burst",
    ],
    fixed: &[
        "blob",
        "media_type",
        "form",
        "width",
        "height",
        "duration_s",
        "exif",
    ],
    children: &[],
    match_on: &[],
    gone: Gone::Forget,
    window: Some("taken_at"),
    defaults: no_defaults,
    founds: None,
    shape: roll_shape,
    settle: nothing_to_settle,
    named: nothing_to_settle,
};

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "photograph_has_arrived_bytes_a_picture_form_and_a_place_the_member_has",
        check: pre_add,
    }];
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "photograph_is_live_and_lineage_is_not_a_loop",
        check: pre_edit,
    }];
    const SET_PLACE: &[CommandCondition] = &[CommandCondition {
        predicate: "photograph_is_live_and_place_exists",
        check: pre_set_place,
    }];
    const COVER: &[CommandCondition] = &[CommandCondition {
        predicate: "album_is_live_and_cover_is_a_member",
        check: pre_cover,
    }];
    vec![
        CommandDefinition::plain(
            "photo.add",
            "photo",
            concat!(
                r#"{
              "type": "object",
              "required": ["blob", "media_type"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
                "size": { "type": "integer", "minimum": 0 },
                "media_type": { "type": "string", "minLength": 1 },
                "form": { "type": "string", "minLength": 1,
                  "description": "A `photo_form` code; the bytes' own when omitted." },
                "title": { "type": "string", "maxLength": 1000 },
                "taken_at": { "type": ["string", "null"] },
                "offset_min": { "type": ["integer", "null"], "minimum": -1080, "maximum": 1080 },
                "width": { "type": ["integer", "null"], "minimum": 1 },
                "height": { "type": ["integer", "null"], "minimum": 1 },
                "duration_s": { "type": ["number", "null"], "minimum": 0 },
                "exif": { "type": ["object", "null"] },
                "burst": { "type": ["string", "null"] },
                "edited_from": { "type": ["string", "null"] },
                "lat": { "type": ["number", "null"], "minimum": -90, "maximum": 90 },
                "lon": { "type": ["number", "null"], "minimum": -180, "maximum": 180 },
                "place_id": { "type": ["string", "null"] },
                "home": { "type": ["string", "null"],
                  "description": "The item a capture is filed inside (a payment, an event, a workout, a note, a task, a person): it stays out of the library and goes with the item." },
                "motion_blob": { "type": ["string", "null"], "minLength": 64, "maxLength": 64 },
                "motion_size": { "type": "integer", "minimum": 0 },
                "motion_duration_s": { "type": ["number", "null"], "minimum": 0 },
                "phash": { "type": ["string", "null"], "maxLength": 128 },
                "thumbhash": { "type": ["string", "null"], "maxLength": 512 },
                "#,
                crate::commands::arrival::arrived_property!(),
                r#"
              }
            }"#
            ),
            Idempotency::Once,
            ADD,
            add,
        ),
        CommandDefinition::plain(
            "photo.edit",
            "photo",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "taken_at": { "type": ["string", "null"] },
                "offset_min": { "type": ["integer", "null"], "minimum": -1080, "maximum": 1080 },
                "lat": { "type": ["number", "null"], "minimum": -90, "maximum": 90 },
                "lon": { "type": ["number", "null"], "minimum": -180, "maximum": 180 },
                "edited_from": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "photo.set_place",
            "photo",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "place_id": { "type": ["string", "null"], "minLength": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            SET_PLACE,
            set_place,
        ),
        CommandDefinition::plain(
            "album.set_cover",
            "album",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "photo_id": { "type": ["string", "null"], "minLength": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            COVER,
            set_cover,
        ),
    ]
}
