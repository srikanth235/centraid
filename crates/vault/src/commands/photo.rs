//! `photo.*` and `album.set_cover`: a photograph enters the library, its
//! capture facts and its place are corrected, an album chooses its cover.
//!
//! A photograph is an entity of kind `photo` over one blob; the blob is unique
//! to it, so **the same bytes are one photograph**: adding them again adopts the
//! photograph that is there (and brings it back from the trash — re-upload is
//! restore). Its title is the member's caption and may be empty. Everything a
//! member does to a photograph that is not about its capture is a shared verb:
//! the caption (`entity.retitle`), a heart or the archive (`flag.set` of
//! `starred` or `archived`), a label (`tag.add`), the trash and the purge
//! (`entity.*`), an album (`container.create` of kind `album`; `edge.add` and
//! `edge.remove` of `contains`, ordered), a promoted caption
//! (`entity.retitle`), a perceptual hash or a thumbnail (`derivative.write`).
//!
//! ## Thumbnails
//!
//! A photograph the Rust fallback can decode (JPEG, PNG) gets its `thumb` and
//! `preview` derivatives from the command itself when the shell staged none; the
//! platform renders what the fallback cannot (HEIC, a film's poster) and stages
//! it through `derivative.write`.
//!
//! ## What an edit keeps
//!
//! A photograph made from another (a crop, a filter) names it in `edited_from`
//! and **keeps the original's date, place and caption** unless it says
//! otherwise: the in-app editor spells them out, but an edit made in the phone's
//! own Photos app arrives from the walker holding only the library's view of it.
//!
//! ## Place
//!
//! Coordinates found in the bytes become a `place` through
//! [`crate::commands::place::find_or_found`]; a place the member points at
//! (`photo.set_place`) is used as it is.
//!
//! ## An album's cover
//!
//! An album's `cover` is the blob of one of its photographs. A cover that is no
//! longer a member (taken out of the album, or purged) is not drawn: the read
//! falls back to the album's first photograph, and a purge clears the covers
//! that named the purged bytes so the bytes can be collected.

use rusqlite::OptionalExtension;

use crate::commands::blob::{claim, pre_claimable};
use crate::commands::entity::lookup_live;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, place};
use crate::error::Result;
use crate::model::Kind;

/// What the bytes are, as the library draws them; `None` for what is not a
/// picture at all (audio is a document).
fn form_of(media_type: &str) -> Option<&'static str> {
    if media_type.starts_with("audio/") {
        None
    } else if media_type.starts_with("video/") {
        Some("video")
    } else if media_type.starts_with("image/") {
        Some("photo")
    } else {
        Some("scan")
    }
}

fn is_photo(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<std::result::Result<(), String>> {
    Ok(match lookup_live(ctx.connection(), id)? {
        Err(sentence) => Err(sentence),
        Ok(found) if found.kind != Kind::Photo => Err(format!(
            "“{}” is a {}, not a photograph",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => Ok(()),
    })
}

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

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let media_type = ctx.required_str("media_type")?;
    if form_of(media_type).is_none() {
        return Ok(Some(
            "sound is kept in Docs; Photos holds photographs, video and scans".to_owned(),
        ));
    }
    if let Some(sentence) = pre_claimable(ctx, "blob")? {
        return Ok(Some(sentence));
    }
    let given = |key: &str| ctx.input.get(key).is_some_and(|value| !value.is_null());
    if given("lat") != given("lon") {
        return Ok(Some(
            "a place's coordinates are a latitude and a longitude together".to_owned(),
        ));
    }
    if let Some(source) = ctx.optional_str("edited_from")
        && let Err(sentence) = is_photo(ctx, source)?
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
    place_id: Option<String>,
}

fn inherited(ctx: &CommandCtx<'_, '_>) -> Result<Inherited> {
    let Some(source) = ctx.optional_str("edited_from") else {
        return Ok(Inherited::default());
    };
    Ok(ctx.connection().query_row(
        "SELECT e.title, p.taken_at, p.offset_min, p.place_id
           FROM photo p JOIN entity e ON e.id = p.id WHERE p.id = ?1",
        [source],
        |row| {
            Ok(Inherited {
                title: row.get(0)?,
                taken_at: row.get(1)?,
                offset_min: row.get(2)?,
                place_id: row.get(3)?,
            })
        },
    )?)
}

fn number(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<f64> {
    ctx.input.get(key).and_then(serde_json::Value::as_f64)
}

fn whole(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<i64> {
    ctx.input.get(key).and_then(serde_json::Value::as_i64)
}

/// Take back a photograph the same bytes already are: out of the trash if it
/// was there, and into the burst the bytes now say they belong to.
fn adopt(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<()> {
    ctx.connection().execute(
        "UPDATE entity SET deleted_at = NULL, purge_at = NULL WHERE id = ?1",
        [id],
    )?;
    if let Some(burst) = ctx.optional_str("burst") {
        ctx.connection().execute(
            "UPDATE photo SET burst = ?2 WHERE id = ?1 AND burst IS NULL",
            [id, burst],
        )?;
    }
    ctx.touch(id)
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let blob = ctx.required_str("blob")?;
    let media_type = ctx.required_str("media_type")?;
    claim(ctx, "blob")?;
    let existing: Option<String> = ctx
        .connection()
        .query_row("SELECT id FROM photo WHERE blob = ?1", [blob], |row| {
            row.get(0)
        })
        .optional()?;
    if let Some(id) = existing {
        adopt(ctx, &id)?;
        return Ok(serde_json::json!({ "id": id, "deduped": true }));
    }
    let source = inherited(ctx)?;
    let place_id = match (
        ctx.optional_str("place_id"),
        number(ctx, "lat"),
        number(ctx, "lon"),
    ) {
        (Some(id), _, _) => Some(id.to_owned()),
        (None, Some(lat), Some(lon)) => Some(place::find_or_found(ctx, lat, lon)?),
        (None, _, _) => source.place_id,
    };
    let title = ctx.optional_str("title").unwrap_or(&source.title).trim();
    let id = match ctx.optional_str("id") {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Photo, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Photo, title)?,
    };
    let form = ctx
        .optional_str("form")
        .or_else(|| form_of(media_type))
        .unwrap_or("scan");
    let exif = ctx
        .input
        .get("exif")
        .filter(|value| value.is_object())
        .map(ToString::to_string);
    ctx.connection().execute(
        "INSERT INTO photo (id, blob, media_type, form, taken_at, offset_min, width, height,
                            duration_s, exif, burst, edited_from, place_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            id,
            blob,
            media_type,
            form,
            ctx.optional_str("taken_at")
                .map(str::to_owned)
                .or(source.taken_at),
            whole(ctx, "offset_min").or(source.offset_min),
            whole(ctx, "width"),
            whole(ctx, "height"),
            number(ctx, "duration_s"),
            exif,
            ctx.optional_str("burst"),
            ctx.optional_str("edited_from"),
            place_id,
        ],
    )?;
    // What the phone worked out about the picture rides with it: two small
    // values, so a library of thousands is one command each, not three.
    for variant in ["phash", "thumbhash"] {
        if let Some(value) = ctx.optional_str(variant) {
            crate::blob::write_derivative(
                ctx.connection(),
                &ctx.now,
                blob,
                variant,
                None,
                Some(value),
            )?;
        }
    }
    derive_image_tiers(ctx, blob, media_type)?;
    Ok(serde_json::json!({ "id": id, "deduped": false }))
}

/// Write the `thumb` and `preview` derivatives of an image the core can decode,
/// when the shell staged none (#1025 S3, D-1025-S7-50).
///
/// **A failed thumbnail never costs the member the original.** Every branch that
/// cannot produce one returns quietly: a type the Rust fallback cannot decode
/// (HEIC, RAW, a film's poster — the platform renders those and stages them), a
/// vault with no content store, bytes this device does not hold, a store that
/// refuses a write. The page door's `held_thumbnail` falls back through `thumb`,
/// `poster` and the original, so a missing derivative is a slower first paint and
/// never a blank cell. It asks the index first, so a re-add decodes nothing.
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
    if let Err(sentence) = is_photo(ctx, id)? {
        return Ok(Some(sentence));
    }
    let Some(source) = ctx.optional_str("edited_from") else {
        return Ok(None);
    };
    if let Err(sentence) = is_photo(ctx, source)? {
        return Ok(Some(sentence));
    }
    // Climb from the source: finding the photograph itself would make it an
    // edit of its own edit.
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

/// Set the capture facts that were named; a name given as `null` clears its fact.
fn edit(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    for column in ["taken_at", "offset_min", "edited_from"] {
        if let Some(value) = ctx.input.get(column) {
            ctx.connection().execute(
                &format!("UPDATE photo SET {column} = ?2 WHERE id = ?1"),
                rusqlite::params![id, crate::commands::follow::to_sql(value)],
            )?;
        }
    }
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id }))
}

fn pre_set_place(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = is_photo(ctx, ctx.required_str("id")?)? {
        return Ok(Some(sentence));
    }
    place_refusal(ctx)
}

/// Point the photograph at a place, or (no `place_id`) clear it back to unknown.
fn set_place(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    ctx.connection().execute(
        "UPDATE photo SET place_id = ?2 WHERE id = ?1",
        rusqlite::params![id, ctx.optional_str("place_id")],
    )?;
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id }))
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

/// Choose one of the album's photographs as its cover, or (no `photo_id`) let
/// the album fall back to its first.
fn set_cover(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let blob: Option<String> = match ctx.optional_str("photo_id") {
        Some(photo) => Some(ctx.connection().query_row(
            "SELECT blob FROM photo WHERE id = ?1",
            [photo],
            |row| row.get(0),
        )?),
        None => None,
    };
    ctx.connection().execute(
        "UPDATE container SET cover = ?2 WHERE id = ?1",
        rusqlite::params![id, blob],
    )?;
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "photograph_has_arrived_bytes_a_picture_form_and_a_place",
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
            r#"{
              "type": "object",
              "required": ["blob", "media_type"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
                "size": { "type": "integer", "minimum": 0 },
                "media_type": { "type": "string", "minLength": 1 },
                "form": { "type": "string", "enum": ["photo", "video", "scan"] },
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
                "phash": { "type": ["string", "null"], "maxLength": 128 },
                "thumbhash": { "type": ["string", "null"], "maxLength": 512 }
              }
            }"#,
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
