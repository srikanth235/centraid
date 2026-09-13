//! THE `media` SCHEMA: twenty commands, and they are the vault's.
//!
//! Photos is a projection (`crates/apps/photos`); every write it makes is one
//! of these. The split, counted off v0's definitions:
//! **twelve `idempotent`, six `once`, two `retry-safe`** — the census reads the
//! `once` arm as five (`census-wave4.md:47`), which misses `media.add_asset`;
//! `the_idempotency_split_matches_v0` below is the count.
//!
//! ## Two gates, never one (census §A0)
//!
//! The manifest's `confirmation: "required"` is what the DISPATCHING SURFACE
//! asks before sending — Photos declares it on `purge-asset` and
//! `delete-album`. A definition's `confirm: true` parks a **non-owner**
//! invocation regardless of risk, and in this whole schema exactly one command
//! carries it: `media.forget_person`, which **no Photos action invokes at
//! all**. Collapsing the two would simultaneously add a dialog in front of a
//! member's own purge and drop the park in front of an agent's.
//!
//! ## Conditions read `:ctx_now`, never SQLite's clock
//!
//! `media.restore_asset` refuses a LAPSED grace window, and the window is
//! compared against the invocation's own instant — lane V made v0's conditions
//! do the same. A condition that read `strftime('now')` could not be fixtured
//! at any instant but the host's (D-1020-D3-6's two-clocks finding).
//!
//! ## `media.add_asset`, and the door it waited on
//!
//! It was registered with its real schema, idempotency and risk, and its
//! handler refused every call with a sentence naming the missing seam: moving
//! bytes needs a blob door on [`CommandCtx`], and `CommandCtx` had none. The
//! port had carried v0's text-versus-binary split
//! (`packages/vault/src/blob/mint.ts:88`-`:99`) without the store behind it,
//! so a vault could hold a note and not a photograph. `FsBlobStore` existed
//! the whole time, for the backup plane, and was simply not wired to a command
//! context.
//!
//! [`Vault::with_blobs`](crate::file::Vault::with_blobs) is that wiring and
//! this command is real. What did NOT change is the rule the refusal was
//! protecting: a vault opened with no store still refuses binary inline bytes,
//! because a `core_content_item` whose `content_uri` names bytes nothing kept
//! is a library of rows with no photographs in it.

use crate::commands::core::{
    decode_data_uri, minted_bytes, pre_exactly_one_source, pre_inline_bytes_are_storable,
    pre_is_data_uri, pre_staged_or_owned, pre_within_size_cap, set_representation,
};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// The polymorphic target type every media row uses for an asset.
const ASSET_TARGET_TYPE: &str = "media.asset";

/// The album's own entity type in the revision plane.
const ALBUM_ENTITY_TYPE: &str = "media.album";

/// The trash grace window (#274). Thirty days, in v0's arithmetic.
const PURGE_AFTER_DAYS: i64 = 30;

/// The flags scheme, and the star's notation.
///
/// **An `https` URI, not a `urn:`, and that is not drift**: flag SQL fragments
/// are interpolated into condition SQL, where `:flags` reads as a NAMED
/// PARAMETER (#258, the colon-literal trap) and no parameter name can start
/// with a slash (`packages/vault/src/commands/flags.ts:11-15`). The tags
/// scheme, which is never interpolated, is `centraid:tags:v1`.
const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
const STARRED_NOTATION: &str = "starred";

/// Place kinds a member may declare. The column's CHECK also permits
/// `'virtual'`; it is **not offered**, because a virtual place is not somewhere
/// a photograph was taken.
const PLACE_KINDS: &[&str] = &["home", "work", "venue", "city", "region", "other"];

/// The gazetteer sources this build accepts.
const GAZETTEER_SOURCES: &[&str] = &["geonames-cities15000"];

/// Every `media.*` command this build carries.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_asset(),
        update_asset(),
        promote_caption(),
        set_asset_place(),
        name_place(),
        set_favorite(),
        set_archived(),
        delete_asset(),
        restore_asset(),
        purge_asset(),
        create_album(),
        rename_album(),
        set_album_cover(),
        delete_album(),
        restore_album(),
        add_to_album(),
        remove_from_album(),
        forget_person(),
        answer_face_proposal(),
        set_place_gazetteer(),
    ]
}

// ---------------------------------------------------------------------------
// Shared helpers. Each one is a fact about the model, not a convenience.
// ---------------------------------------------------------------------------

/// The acting party: the vault's owner. An app or a device calling on the
/// owner's behalf is still the owner's act.
fn owner_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    ctx.connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| VaultError::Invariant {
            context: "this vault has no owner yet; enrol one before writing to the library"
                .to_owned(),
        })
}

/// `now + 30 days`, in the vault's own instant spelling.
///
/// Computed on the ISO text rather than through a calendar crate, and exact
/// because the vault writes `YYYY-MM-DDTHH:MM:SS.sssZ` and nothing else.
fn purge_at(now: &str) -> Result<String> {
    let millis = parse_instant_ms(now).ok_or_else(|| VaultError::Invariant {
        context: format!("`{now}` is not an instant this vault writes"),
    })?;
    Ok(format_instant_ms(
        millis + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1_000,
    ))
}

/// Milliseconds since the epoch for `YYYY-MM-DDTHH:MM:SS[.sss]Z`.
fn parse_instant_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> { text.get(from..to)?.parse().ok() };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let millis = if bytes.get(19) == Some(&b'.') {
        number(20, 23).unwrap_or(0)
    } else {
        0
    };
    Some(
        ((days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60_000
            + second * 1_000
            + millis,
    )
}

/// The inverse. Round-trips every instant [`parse_instant_ms`] accepts.
fn format_instant_ms(millis: i64) -> String {
    let (days, rest) = (millis.div_euclid(86_400_000), millis.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second, milli) = (
        rest / 3_600_000,
        (rest / 60_000) % 60,
        (rest / 1_000) % 60,
        rest % 1_000,
    );
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Howard Hinnant's `days_from_civil`: exact for every year the vault holds,
/// and needs no calendar crate.
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Its inverse, `civil_from_days`.
const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + if month <= 2 { 1 } else { 0 }, month, day)
}

/// A precondition that counts rows and says a sentence when the count is wrong.
macro_rules! counts {
    ($predicate:literal, $sentence:literal, $sql:literal, $key:literal, $want:literal) => {
        CommandCondition {
            predicate: $predicate,
            check: |ctx| {
                let id = ctx.required_str($key)?;
                let count: i64 = ctx.connection().query_row($sql, [id], |row| row.get(0))?;
                Ok((count != $want).then(|| $sentence.to_owned()))
            },
        }
    };
}

/// The `starred` concept id, minted on first use.
fn starred_concept_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let scheme_id: String = match ctx.connection().query_row(
        "SELECT scheme_id FROM core_concept_scheme WHERE uri = ?1",
        [FLAGS_SCHEME_URI],
        |row| row.get(0),
    ) {
        Ok(id) => id,
        Err(_) => {
            let id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_concept_scheme
                   (scheme_id, uri, title, publisher, version, created_at)
                 VALUES (?1, ?2, 'Flags', 'centraid', '1', ?3)",
                rusqlite::params![id, FLAGS_SCHEME_URI, ctx.now],
            )?;
            id
        }
    };
    match ctx.connection().query_row(
        "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
        rusqlite::params![scheme_id, STARRED_NOTATION],
        |row| row.get(0),
    ) {
        Ok(id) => Ok(id),
        Err(_) => {
            let id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    definition, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'Starred', '[\"Favorite\"]',
                         'Owner attention: one star across every surface', ?4, ?4)",
                rusqlite::params![id, scheme_id, STARRED_NOTATION, ctx.now],
            )?;
            Ok(id)
        }
    }
}

/// Set or clear the star. **Delete-then-insert**, which keeps it idempotent and
/// refreshes who-starred-when on a re-star.
fn set_starred(ctx: &CommandCtx<'_, '_>, asset_id: &str, starred: bool) -> Result<()> {
    let concept_id = starred_concept_id(ctx)?;
    ctx.connection().execute(
        "DELETE FROM core_tag
          WHERE target_type = ?1 AND target_id = ?2 AND concept_id = ?3",
        rusqlite::params![ASSET_TARGET_TYPE, asset_id, concept_id],
    )?;
    if starred {
        let tag_id = ctx.next_id();
        let actor = owner_party_id(ctx)?;
        ctx.connection().execute(
            "INSERT INTO core_tag
               (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                confidence, tagged_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
            rusqlite::params![
                tag_id,
                ASSET_TARGET_TYPE,
                asset_id,
                concept_id,
                actor,
                ctx.now
            ],
        )?;
    }
    Ok(())
}

/// Whether the asset is starred.
fn is_starred(ctx: &CommandCtx<'_, '_>, asset_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ?1 AND t.target_id = ?2
            AND s.uri = ?3 AND c.notation = ?4",
        rusqlite::params![
            ASSET_TARGET_TYPE,
            asset_id,
            FLAGS_SCHEME_URI,
            STARRED_NOTATION
        ],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// An asset's content id.
fn content_id_of(ctx: &CommandCtx<'_, '_>, asset_id: &str) -> Result<String> {
    ctx.connection()
        .query_row(
            "SELECT content_id FROM media_asset WHERE asset_id = ?1",
            [asset_id],
            |row| row.get(0),
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("asset {asset_id} vanished between the check and the write"),
        })
}

/// THE REFERENCE LIST. Does anything still rent these bytes?
///
/// The LAST reference decides whether the bytes soft-delete. The list is the
/// registry's — `contracts/schema/v0-registries.json`'s `contentReferences` —
/// read at runtime rather than copied here, so a new byte-bearing column
/// cannot leave this answer behind (#883, ruling O-attach).
fn content_unreferenced(ctx: &CommandCtx<'_, '_>, content_id: &str) -> Result<bool> {
    for reference in &centraid_ontology::registries::v0_registries().content_references {
        // `only_live` is the registry's own clause text, and the only value it
        // ever holds is `deleted_at IS NULL` — asserted in the test below, so a
        // registry that grows a second clause fails here rather than
        // interpolating an unreviewed predicate.
        let live = match reference.only_live.as_deref() {
            None => "",
            Some("deleted_at IS NULL") => " AND deleted_at IS NULL",
            Some(other) => {
                return Err(VaultError::Invariant {
                    context: format!(
                        "the content-reference registry carries a liveness clause this build has                          not reviewed: `{other}`"
                    ),
                });
            }
        };
        let count: i64 = ctx.connection().query_row(
            &format!(
                "SELECT COUNT(*) FROM {} WHERE {} = ?1{live}",
                crate::log::quoted(&reference.table),
                crate::log::quoted(&reference.column)
            ),
            [content_id],
            |row| row.get(0),
        )?;
        if count > 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Soft-delete the bytes with the standard grace window, if nothing rents them.
pub(crate) fn release_content_if_unreferenced(
    ctx: &CommandCtx<'_, '_>,
    content_id: &str,
) -> Result<bool> {
    if !content_unreferenced(ctx, content_id)? {
        return Ok(false);
    }
    ctx.connection().execute(
        "UPDATE core_content_item SET deleted_at = ?1, purge_at = ?2 WHERE content_id = ?3",
        rusqlite::params![ctx.now, purge_at(&ctx.now)?, content_id],
    )?;
    Ok(true)
}

/// Collapse the grace window to NOW when unrented. The handler has no CAS
/// delete; the sweep reclaims the bytes.
fn release_content_now(ctx: &CommandCtx<'_, '_>, content_id: &str) -> Result<bool> {
    if !content_unreferenced(ctx, content_id)? {
        return Ok(false);
    }
    ctx.connection().execute(
        "UPDATE core_content_item
            SET deleted_at = COALESCE(deleted_at, ?1), purge_at = ?1
          WHERE content_id = ?2",
        rusqlite::params![ctx.now, content_id],
    )?;
    Ok(true)
}

/// Hand every album whose cover was these bytes to its next media member.
///
/// **Before the entries go**, because the hand-off reads them.
fn hand_off_covers(ctx: &CommandCtx<'_, '_>, content_id: &str) -> Result<()> {
    let covered: Vec<String> = {
        let connection = ctx.connection();
        let mut statement = connection
            .prepare("SELECT collection_id FROM core_collection WHERE cover_content_id = ?1")?;
        let rows = statement.query_map([content_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };
    for collection_id in covered {
        ctx.connection().execute(
            "UPDATE core_collection SET cover_content_id =
               (SELECT a.content_id FROM core_collection_entry e
                  JOIN media_asset a ON a.asset_id = e.target_id
                 WHERE e.collection_id = ?1 AND e.target_type = ?2
                 ORDER BY e.position LIMIT 1)
             WHERE collection_id = ?1",
            rusqlite::params![collection_id, ASSET_TARGET_TYPE],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The definitions.
// ---------------------------------------------------------------------------

fn add_asset() -> CommandDefinition {
    CommandDefinition {
        name: "media.add_asset",
        owner_schema: "media",
        // v0's schema, transcribed. `data_uri` XOR `staged_sha` is a
        // precondition in v0 rather than a schema rule, because JSON Schema's
        // `oneOf` would make the error message name the schema instead of the
        // choice.
        input_schema: r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "data_uri": { "type": "string", "minLength": 6 },
            "staged_sha": { "type": "string", "minLength": 64, "maxLength": 64 },
            "kind": { "type": "string", "enum": ["photo", "video", "audio", "scan"] },
            "captured_at": { "type": "string" },
            "tz_offset_min": { "type": "integer", "minimum": -1080, "maximum": 1080 },
            "capture_group_id": { "type": "string", "minLength": 1, "maxLength": 200 },
            "source_asset_id": { "type": "string", "minLength": 1, "maxLength": 200 },
            "title": { "type": "string" },
            "width": { "type": "integer", "minimum": 1 },
            "height": { "type": "integer", "minimum": 1 },
            "duration_s": { "type": "number", "minimum": 0 },
            "phash": { "type": "string", "minLength": 4, "maxLength": 64,
                       "pattern": "^[0-9a-f]+$" },
            "thumbhash": { "type": "string", "minLength": 6, "maxLength": 100,
                           "pattern": "^[A-Za-z0-9+/]+$" },
            "latitude": { "type": "number", "minimum": -90, "maximum": 90 },
            "longitude": { "type": "number", "minimum": -180, "maximum": 180 }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: ADD_ASSET_PRE,
        postconditions: &[CommandCondition {
            predicate: "asset_backed_by_content",
            check: |ctx| {
                // THE WHOLE CLAIM, CHECKED THROUGH THE BYTES: a live asset now
                // stands over the bytes this call carried. A `media_asset`
                // whose content item is trashed is a photograph in a library
                // that has already thrown it away.
                //
                // By SHA and not by asset id, deliberately. A postcondition is
                // handed the INPUT and never the output, and this command's
                // input names no asset — so an id-based check would have to
                // guess one out of `produced_ids`, which breaks twice over:
                // the mint takes the first id (bytes come before the wrapper
                // here, unlike a document), and the DEDUPE path produces no
                // asset id at all because it adopted an existing row. The sha
                // is derivable from the input in both cases and is the thing
                // the caller actually asked about.
                let Some(sha) = sha_of_input(ctx)? else {
                    // Neither door named bytes; `exactly_one_source` already
                    // refused this and has the better sentence.
                    return Ok(None);
                };
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM media_asset a
                       JOIN core_content_item c ON c.content_id = a.content_id
                      WHERE c.sha256 = ?1 AND c.deleted_at IS NULL AND a.deleted_at IS NULL",
                    [&sha],
                    |row| row.get(0),
                )?;
                Ok((count < 1).then(|| "the asset did not enter the library".to_owned()))
            },
        }],
        handler: add_asset_handler,
        sealed_input: &[],
        online_only: false,
    }
}

/// v0's six gates, plus the one this build adds
/// (`packages/vault/src/commands/media.ts:344`-`:395`).
const ADD_ASSET_PRE: &[CommandCondition] =
    &[
        CommandCondition {
            predicate: "exactly_one_source",
            check: pre_exactly_one_source,
        },
        CommandCondition {
            predicate: "coordinate_pair_complete",
            check: |ctx| {
                // A COORDINATE IS A PAIR. Half of one is no location at all, and
                // dropping it silently would let a caller believe it had placed a
                // photograph it had not.
                let lat = ctx.input.get("latitude").is_some_and(|v| !v.is_null());
                let lng = ctx.input.get("longitude").is_some_and(|v| !v.is_null());
                Ok((lat != lng)
                    .then(|| "A location needs both a latitude and a longitude.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "is_data_uri",
            check: pre_is_data_uri,
        },
        CommandCondition {
            predicate: "within_size_cap",
            check: pre_within_size_cap,
        },
        CommandCondition {
            predicate: "inline_bytes_are_storable",
            check: pre_inline_bytes_are_storable,
        },
        CommandCondition {
            predicate: "staged_or_owned",
            check: pre_staged_or_owned,
        },
        CommandCondition {
            predicate: "source_asset_exists",
            check: |ctx| {
                // A claimed source must be a real asset in THIS vault (#711). Named
                // here rather than left to the foreign key, so a mistyped lineage
                // names the failing gate instead of a raw constraint error landing
                // mid-insert.
                let Some(source) = ctx.optional_str("source_asset_id") else {
                    return Ok(None);
                };
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
                    [source],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "That photo is not in this library.".to_owned()))
            },
        },
    ];

/// The digest of the bytes this call carries, whichever door they came through.
///
/// `None` when it named neither, which `exactly_one_source` has already
/// refused.
fn sha_of_input(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sha) = ctx.optional_str("staged_sha") {
        return Ok(Some(sha.to_owned()));
    }
    let Some(uri) = ctx.optional_str("data_uri") else {
        return Ok(None);
    };
    // THE RAW DECODED BYTES, never the URI text — the same identity the mint
    // uses, and the reason the same photograph declared under two media types
    // is one content item rather than two (v0's dedup hole, `blob/mint.ts:6`).
    let (_, bytes) = decode_data_uri(uri)?;
    Ok(Some(centraid_media::format::sha256_hex(&bytes)))
}

/// The `kind` bytes imply, when the caller does not say
/// (`packages/vault/src/commands/media.ts:71`-`:76`).
fn asset_kind_for(media_type: &str) -> &'static str {
    if media_type.starts_with("video/") {
        "video"
    } else if media_type.starts_with("audio/") {
        "audio"
    } else if media_type.starts_with("image/") {
        "photo"
    } else {
        "scan"
    }
}

/// ~11m identity precision, so burst photos share one `core_place`. The ROW
/// keeps the precise coordinates (#352).
fn round_coord(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// ~170m: the radius at which an existing NAMED place is adopted. Looser than
/// the ~11m identity rung on purpose — "the cabin" covers a garden.
const NAMED_PLACE_RADIUS_DEG: f64 = 0.0015;

/// A COORDINATE-AS-NAME IS NOT A NAME, so it is never adopted: adopting one
/// would spread a placeholder over every later photograph taken nearby, and
/// the member would then have to rename a place they never named.
fn is_coordinate_label(name: &str) -> bool {
    let trimmed = name.trim();
    let Some((lat, lng)) = trimmed.split_once(',') else {
        return false;
    };
    fn is_decimal(text: &str) -> bool {
        let text = text.trim();
        let text = text.strip_prefix('-').unwrap_or(text);
        matches!(text.split_once('.'), Some((whole, fraction))
            if (1..=3).contains(&whole.len())
                && whole.bytes().all(|b| b.is_ascii_digit())
                && !fraction.is_empty()
                && fraction.bytes().all(|b| b.is_ascii_digit()))
    }
    is_decimal(lat) && is_decimal(lng)
}

/// Find-or-create a place: a NAMED one within ~170m, else the rounded identity
/// rung at ~11m, else a new coordinate-labelled row. The stored coordinates
/// stay precise either way (`packages/vault/src/commands/media.ts:97`-`:147`).
fn find_or_create_place(ctx: &CommandCtx<'_, '_>, lat: f64, lng: f64) -> Result<String> {
    // The box is divided by cos(lat) so it stays roughly square as it moves
    // away from the equator — SQLite has no trigonometry, so the shaping
    // happens here and the query gets a plain bounding box.
    let lng_radius = NAMED_PLACE_RADIUS_DEG / (lat.to_radians().cos()).max(0.05);
    let mut statement = ctx.connection().prepare(
        "SELECT place_id, name FROM core_place
          WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL
            AND geo_lat BETWEEN ?1 AND ?2
            AND geo_lng BETWEEN ?3 AND ?4
            AND name IS NOT NULL AND trim(name) <> ''
          ORDER BY (geo_lat - ?5) * (geo_lat - ?5) + (geo_lng - ?6) * (geo_lng - ?6)
          LIMIT 8",
    )?;
    let named: Vec<(String, String)> = statement
        .query_map(
            rusqlite::params![
                lat - NAMED_PLACE_RADIUS_DEG,
                lat + NAMED_PLACE_RADIUS_DEG,
                lng - lng_radius,
                lng + lng_radius,
                lat,
                lng,
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
        .collect::<std::result::Result<_, _>>()?;
    if let Some((place_id, _)) = named.iter().find(|(_, name)| !is_coordinate_label(name)) {
        return Ok(place_id.clone());
    }
    drop(statement);

    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT place_id FROM core_place
              WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL
                AND ROUND(geo_lat, 4) = ?1 AND ROUND(geo_lng, 4) = ?2
              LIMIT 1",
            rusqlite::params![round_coord(lat), round_coord(lng)],
            |row| row.get(0),
        )
        .ok();
    if let Some(place_id) = existing {
        return Ok(place_id);
    }
    let place_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_place
           (place_id, name, kind, geo_lat, geo_lng, geohash, address_json, tz,
            parent_place_id, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, NULL, NULL, NULL, NULL, ?5, ?5)",
        rusqlite::params![place_id, format!("{lat:.4}, {lng:.4}"), lat, lng, ctx.now],
    )?;
    Ok(place_id)
}

/// The staging band's own reading of these bytes, as JSON.
///
/// v0's gateway sniffs the type and reads EXIF server-side at staging time, and
/// the claim then inherits what it found. v1 has the column and no producer
/// filling it yet, so this is almost always `{}` — which is why every read of
/// it below is a FALLBACK behind the caller's own value, exactly as v0 orders
/// them, rather than a field this command depends on.
fn staged_meta(ctx: &CommandCtx<'_, '_>) -> serde_json::Value {
    let Some(sha) = ctx.optional_str("staged_sha") else {
        return serde_json::Value::Null;
    };
    ctx.connection()
        .query_row(
            "SELECT meta_json FROM blob_staging WHERE sha256 = ?1 AND variant IS NULL",
            [sha],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// UNIQUE `content_id`: ADOPT, do not duplicate.
///
/// Two members importing the same photograph, or one member importing it
/// twice, are one asset — `media_asset.content_id` is unique and says so. A
/// re-upload of trashed bytes RESTORES them, which is `media.add_asset`'s own
/// rule and the reason the schema calls it "re-upload = restore".
///
/// It deliberately does not stamp `source_asset_id` (#711): these bytes do not
/// DERIVE from that asset, they ARE it.
fn adopt_asset_for_content(
    ctx: &CommandCtx<'_, '_>,
    content_id: &str,
    capture_group_id: Option<&str>,
) -> Result<Option<String>> {
    let existing: Option<(String, Option<String>, Option<String>)> = ctx
        .connection()
        .query_row(
            "SELECT asset_id, deleted_at, capture_group_id FROM media_asset
              WHERE content_id = ?1",
            [content_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();
    let Some((asset_id, deleted_at, group)) = existing else {
        return Ok(None);
    };
    if deleted_at.is_some() || (group.is_none() && capture_group_id.is_some()) {
        ctx.connection().execute(
            "UPDATE media_asset
                SET deleted_at = NULL,
                    purge_at = NULL,
                    capture_group_id = COALESCE(capture_group_id, ?1)
              WHERE asset_id = ?2",
            rusqlite::params![capture_group_id, asset_id],
        )?;
    }
    Ok(Some(asset_id))
}

/// EXIF as this command stores it: everything the staging band read, minus the
/// extracted text (`packages/vault/src/commands/media.ts:149`-`:155`).
///
/// The text is excluded because it belongs in the search index rather than in a
/// JSON blob nothing queries, and because an OCR pass over a page of a passport
/// would otherwise sit in a column no policy covers.
fn exif_json_for_meta(meta: &serde_json::Value) -> Option<String> {
    let object = meta.as_object()?;
    let kept: serde_json::Map<String, serde_json::Value> = object
        .iter()
        .filter(|(key, value)| key.as_str() != "text" && !value.is_null())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    (!kept.is_empty()).then(|| serde_json::Value::Object(kept).to_string())
}

/// A number the caller gave, else one the staging band read, else nothing.
fn number_of(ctx: &CommandCtx<'_, '_>, meta: &serde_json::Value, key: &str) -> Option<f64> {
    ctx.input
        .get(key)
        .and_then(serde_json::Value::as_f64)
        .or_else(|| meta.get(key).and_then(serde_json::Value::as_f64))
}

/// The same, for a string.
fn text_of(ctx: &CommandCtx<'_, '_>, meta: &serde_json::Value, key: &str) -> Option<String> {
    ctx.optional_str(key).map(str::to_owned).or_else(|| {
        meta.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    })
}

/// ONE PHOTOGRAPH ENTERS THE LIBRARY
/// (`packages/vault/src/commands/media.ts:414`-`:549`).
///
/// The order is v0's and each step depends on the one before it: the bytes are
/// minted or claimed FIRST, because an asset is meaning over bytes and there is
/// nothing to mean without them; the adopt check comes next, because
/// `media_asset.content_id` is unique and a second wrapper over one sha is the
/// same photograph; and the asset's own id is minted before anything hangs off
/// it, which is what makes `produced_ids[0]` the asset for the postcondition.
fn add_asset_handler(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let meta = staged_meta(ctx);
    let minted = minted_bytes(ctx)?;
    let content_id = minted.content_id.clone();
    let capture_group_id = ctx.optional_str("capture_group_id").map(str::to_owned);

    if let Some(adopted) = adopt_asset_for_content(ctx, &content_id, capture_group_id.as_deref())? {
        return Ok(serde_json::json!({
            "asset_id": adopted,
            "content_id": content_id,
            "deduped": 1,
        }));
    }

    let asset_id = ctx.next_id();
    // The caller's pair wins over the staging band's, like every other field on
    // this command. Staged GPS only rides here when the owner kept it — it has
    // already passed the location policy at staging time.
    let place_id = match (
        number_of(ctx, &meta, "latitude"),
        number_of(ctx, &meta, "longitude"),
    ) {
        (Some(lat), Some(lng)) => Some(find_or_create_place(ctx, lat, lng)?),
        _ => None,
    };
    let kind = ctx.optional_str("kind").map_or_else(
        || asset_kind_for(&minted.media_type).to_owned(),
        str::to_owned,
    );
    ctx.connection().execute(
        "INSERT INTO media_asset
           (asset_id, content_id, kind, title, captured_at, tz_offset_min, capture_group_id,
            source_asset_id, place_id, camera_device_id, width, height, duration_s, exif_json,
            deleted_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13, NULL, ?14, ?14)",
        rusqlite::params![
            asset_id,
            content_id,
            kind,
            ctx.optional_str("title"),
            text_of(ctx, &meta, "captured_at"),
            number_of(ctx, &meta, "tz_offset_min").map(|value| value as i64),
            capture_group_id,
            // EDIT LINEAGE (#711) has deliberately no fallback: only the caller
            // knows it, because nothing in the bytes says "I was cropped out of
            // that one".
            ctx.optional_str("source_asset_id"),
            place_id,
            number_of(ctx, &meta, "width").map(|value| value as i64),
            number_of(ctx, &meta, "height").map(|value| value as i64),
            number_of(ctx, &meta, "duration_s"),
            exif_json_for_meta(&meta),
            ctx.now,
        ],
    )?;

    // PERCEPTUAL HASH (#299 §2, Tier 0): producer-agnostic, like thumbnails.
    // Derived data in a sidecar — near-duplicates are one join away and nothing
    // is merged automatically, which is the rule the whole tier exists under.
    let contributed: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT text_content FROM core_content_derivative
              WHERE content_id = ?1 AND variant = 'phash'",
            [&content_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(phash) = ctx.optional_str("phash").map(str::to_owned).or(contributed) {
        ctx.connection().execute(
            "INSERT INTO media_asset_phash (asset_id, phash, computed_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT (asset_id) DO UPDATE SET
               phash = excluded.phash, computed_at = excluded.computed_at",
            rusqlite::params![asset_id, phash, ctx.now],
        )?;
    }

    // A DEVICE-CONTRIBUTED THUMBHASH (#419) lands only in the inline derivative
    // row. It is a placeholder a client draws while the real thumbnail loads,
    // never a thumbnail: it has no sha, because there are no bytes in the store
    // behind it.
    if let Some(thumbhash) = ctx.optional_str("thumbhash") {
        let byte_size = i64::try_from(thumbhash.len()).unwrap_or(i64::MAX);
        ctx.connection().execute(
            "INSERT INTO core_content_derivative
               (derivative_id, content_id, variant, sha256, media_type, byte_size,
                text_content, created_at, updated_at)
             VALUES (?1, ?2, 'thumbhash', NULL, 'text/plain', ?3, ?4, ?5, ?5)
             ON CONFLICT (content_id, variant) DO UPDATE SET
               text_content = excluded.text_content,
               byte_size = excluded.byte_size,
               media_type = excluded.media_type,
               created_at = excluded.created_at",
            rusqlite::params![ctx.next_id(), content_id, byte_size, thumbhash, ctx.now],
        )?;
    }

    // THIS ASSET'S OWN READING OF THE BYTES (#996, R20(b)). The same sha pinned
    // to two rows carries two readings, so the media type goes on the
    // REPRESENTATION and never on the byte row.
    set_representation(
        ctx,
        &content_id,
        ASSET_TARGET_TYPE,
        &asset_id,
        &minted.media_type,
        Some("original"),
    )?;

    Ok(serde_json::json!({
        "asset_id": asset_id,
        "content_id": content_id,
        "deduped": 0,
    }))
}

fn update_asset() -> CommandDefinition {
    CommandDefinition {
        name: "media.update_asset",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id"],
          "additionalProperties": false,
          "properties": {
            "asset_id": { "type": "string", "minLength": 1 },
            "captured_at": { "type": "string" },
            "title": { "type": "string" },
            "favorite": { "type": "integer", "enum": [0, 1] },
            "archived": { "type": "integer", "enum": [0, 1] }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[counts!(
            "asset_exists",
            "there is no photograph with that id",
            "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
            "asset_id",
            1
        )],
        postconditions: &[CommandCondition {
            predicate: "edits_applied",
            check: |ctx| {
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                for column in ["captured_at", "title"] {
                    let Some(wanted) = ctx.optional_str(column) else {
                        continue;
                    };
                    let found: Option<String> = ctx.connection().query_row(
                        &format!(
                            "SELECT {} FROM media_asset WHERE asset_id = ?1",
                            crate::log::quoted(column)
                        ),
                        [&asset_id],
                        |row| row.get(0),
                    )?;
                    if found.as_deref() != Some(wanted) {
                        return Ok(Some(format!(
                            "`{column}` did not take the value it was sent"
                        )));
                    }
                }
                if let Some(favorite) = ctx
                    .input
                    .get("favorite")
                    .and_then(serde_json::Value::as_i64)
                    && is_starred(ctx, &asset_id)? != (favorite == 1)
                {
                    return Ok(Some(
                        "the star did not take the value it was sent".to_owned(),
                    ));
                }
                if let Some(archived) = ctx
                    .input
                    .get("archived")
                    .and_then(serde_json::Value::as_i64)
                {
                    let archived_at: Option<String> = ctx.connection().query_row(
                        "SELECT archived_at FROM media_asset WHERE asset_id = ?1",
                        [&asset_id],
                        |row| row.get(0),
                    )?;
                    if archived_at.is_some() != (archived == 1) {
                        return Ok(Some(
                            "the archive flag did not take the value it was sent".to_owned(),
                        ));
                    }
                }
                Ok(None)
            },
        }],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            if let Some(captured_at) = ctx.optional_str("captured_at") {
                ctx.connection().execute(
                    "UPDATE media_asset SET captured_at = ?1 WHERE asset_id = ?2",
                    rusqlite::params![captured_at, asset_id],
                )?;
            }
            if let Some(favorite) = ctx
                .input
                .get("favorite")
                .and_then(serde_json::Value::as_i64)
            {
                set_starred(ctx, &asset_id, favorite == 1)?;
            }
            if let Some(archived) = ctx
                .input
                .get("archived")
                .and_then(serde_json::Value::as_i64)
            {
                let stamp = (archived == 1).then(|| ctx.now.clone());
                ctx.connection().execute(
                    "UPDATE media_asset SET archived_at = ?1 WHERE asset_id = ?2",
                    rusqlite::params![stamp, asset_id],
                )?;
            }
            if let Some(title) = ctx.optional_str("title") {
                // THE AUTHORED TITLE, ON THE ASSET (#996, R20(b)). It used to be
                // written onto the shared byte row, where a generated caption
                // overwrote it and two assets over one sha shared it.
                ctx.connection().execute(
                    "UPDATE media_asset SET title = ?1 WHERE asset_id = ?2",
                    rusqlite::params![title, asset_id],
                )?;
            }
            Ok(serde_json::json!({ "asset_id": asset_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn promote_caption() -> CommandDefinition {
    CommandDefinition {
        name: "media.promote_caption",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id"],
          "additionalProperties": false,
          "properties": { "asset_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            counts!(
                "asset_exists",
                "there is no photograph with that id",
                "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
                "asset_id",
                1
            ),
            CommandCondition {
                predicate: "caption_exists",
                check: |ctx| {
                    let asset_id = ctx.required_str("asset_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM knowledge_annotation an
                           JOIN core_content_representation r
                             ON r.representation_id = an.target_id
                          WHERE an.target_type = 'core.content_representation'
                            AND r.owner_type = ?1 AND r.owner_id = ?2",
                        rusqlite::params![ASSET_TARGET_TYPE, asset_id],
                        |row| row.get(0),
                    )?;
                    Ok((count < 1).then(|| {
                        "there is no generated caption on this photograph to keep".to_owned()
                    }))
                },
            },
        ],
        postconditions: &[counts!(
            "title_authored",
            "the caption did not become the photograph's title",
            "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1 AND title IS NOT NULL",
            "asset_id",
            1
        )],
        // PROMOTING IS NOT ACCEPTING. The derived row is untouched, so a later
        // re-caption replaces it without touching what the owner chose to keep.
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let caption: String = ctx
                .connection()
                .query_row(
                    "SELECT an.body_text FROM knowledge_annotation an
                       JOIN core_content_representation r
                         ON r.representation_id = an.target_id
                      WHERE an.target_type = 'core.content_representation'
                        AND r.owner_type = ?1 AND r.owner_id = ?2
                      ORDER BY an.created_at DESC, an.annotation_id DESC LIMIT 1",
                    rusqlite::params![ASSET_TARGET_TYPE, asset_id],
                    |row| row.get(0),
                )
                .map_err(|_| VaultError::Invariant {
                    context: format!("the caption on {asset_id} vanished between check and write"),
                })?;
            ctx.connection().execute(
                "UPDATE media_asset SET title = ?1 WHERE asset_id = ?2",
                rusqlite::params![caption, asset_id],
            )?;
            Ok(serde_json::json!({ "asset_id": asset_id, "title": caption }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn set_asset_place() -> CommandDefinition {
    CommandDefinition {
        name: "media.set_asset_place",
        owner_schema: "media",
        // An OMITTED `place_id` CLEARS the place (#352) — the same
        // "omit to reset" convention `core.move_document` uses for a folder.
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id"],
          "additionalProperties": false,
          "properties": {
            "asset_id": { "type": "string", "minLength": 1 },
            "place_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            counts!(
                "asset_exists",
                "there is no photograph with that id",
                "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
                "asset_id",
                1
            ),
            CommandCondition {
                predicate: "place_exists_if_given",
                check: |ctx| {
                    let Some(place_id) = ctx.optional_str("place_id") else {
                        return Ok(None);
                    };
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_place WHERE place_id = ?1",
                        [place_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| {
                        "this vault knows no place with that id; there is no app-plane command \
                         that mints one"
                            .to_owned()
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "place_applied",
            check: |ctx| {
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let wanted = ctx.optional_str("place_id").map(str::to_owned);
                let found: Option<String> = ctx.connection().query_row(
                    "SELECT place_id FROM media_asset WHERE asset_id = ?1",
                    [&asset_id],
                    |row| row.get(0),
                )?;
                Ok((found != wanted).then(|| "the place did not change".to_owned()))
            },
        }],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let place_id = ctx.optional_str("place_id").map(str::to_owned);
            ctx.connection().execute(
                "UPDATE media_asset SET place_id = ?1 WHERE asset_id = ?2",
                rusqlite::params![place_id, asset_id],
            )?;
            Ok(serde_json::json!({ "asset_id": asset_id, "place_id": place_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn name_place() -> CommandDefinition {
    CommandDefinition {
        name: "media.name_place",
        owner_schema: "media",
        // 120 is a SIGNAGE ceiling, not a storage one: a heading no surface can
        // draw is not a name anybody typed on purpose.
        input_schema: r#"{
          "type": "object",
          "required": ["place_id", "name"],
          "additionalProperties": false,
          "properties": {
            "place_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 120 },
            "kind": { "type": "string",
                      "enum": ["home", "work", "venue", "city", "region", "other"] }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            counts!(
                "place_exists",
                "this vault knows no place with that id",
                "SELECT COUNT(*) FROM core_place WHERE place_id = ?1",
                "place_id",
                1
            ),
            CommandCondition {
                // `minLength` catches `""`; only this catches `"   "`. A
                // whitespace name reads as NAMED everywhere and says nothing.
                predicate: "name_not_blank",
                check: |ctx| {
                    let name = ctx.required_str("name")?;
                    Ok(name.trim().is_empty().then(|| {
                        "a place's name cannot be only whitespace — it would read as named \
                         everywhere and say nothing"
                            .to_owned()
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "name_applied",
            check: |ctx| {
                let place_id = ctx.required_str("place_id")?.to_owned();
                let wanted = ctx.required_str("name")?.trim().to_owned();
                let (name, kind): (String, Option<String>) = ctx.connection().query_row(
                    "SELECT name, kind FROM core_place WHERE place_id = ?1",
                    [&place_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if name != wanted {
                    return Ok(Some("the name did not take".to_owned()));
                }
                if let Some(asked) = ctx.optional_str("kind")
                    && kind.as_deref() != Some(asked)
                {
                    return Ok(Some("the kind did not take".to_owned()));
                }
                Ok(None)
            },
        }],
        // Writes `name` (and `kind` when asked) and NOTHING ELSE: the
        // gazetteer's derived address, geohash and timezone have their own
        // writers, and a rename must not undo them.
        handler: |ctx| {
            let place_id = ctx.required_str("place_id")?.to_owned();
            let name = ctx.required_str("name")?.trim().to_owned();
            ctx.connection().execute(
                "UPDATE core_place SET name = ?1 WHERE place_id = ?2",
                rusqlite::params![name, place_id],
            )?;
            // Two statements rather than one COALESCE, so an ABSENT kind cannot
            // be confused with a member clearing it: this command cannot say
            // "no kind", and rewriting the column on every rename would undo a
            // declared "this is home".
            let kind = ctx.optional_str("kind").map(str::to_owned);
            if let Some(kind) = kind.as_deref() {
                if !PLACE_KINDS.contains(&kind) {
                    return Err(VaultError::InvalidInput {
                        name: "kind".to_owned(),
                        detail: format!("`{kind}` is not a place kind a member may declare"),
                    });
                }
                ctx.connection().execute(
                    "UPDATE core_place SET kind = ?1 WHERE place_id = ?2",
                    rusqlite::params![kind, place_id],
                )?;
            }
            Ok(serde_json::json!({ "place_id": place_id, "name": name, "kind": kind }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// The two flag commands share everything but the column they touch.
fn live_asset_precondition() -> &'static [CommandCondition] {
    // A TRASHED ASSET IS NOT EDITABLE (#916, adversarial BUG-7): the
    // precondition used to ask only that the row exist, so Photos could star
    // and archive a photograph the member had already thrown away.
    &[counts!(
        "live_asset_exists",
        "that photograph is in the trash; restore it before changing it",
        "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1 AND deleted_at IS NULL",
        "asset_id",
        1
    )]
}

fn set_favorite() -> CommandDefinition {
    CommandDefinition {
        name: "media.set_favorite",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id", "favorite"],
          "additionalProperties": false,
          "properties": {
            "asset_id": { "type": "string", "minLength": 1 },
            "favorite": { "type": "integer", "enum": [0, 1] }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: live_asset_precondition(),
        postconditions: &[CommandCondition {
            // ONE truth (#916): the star IS the tag, and the tag says what was
            // asked. There is no column to disagree with it.
            predicate: "favorite_applied",
            check: |ctx| {
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let wanted = ctx
                    .input
                    .get("favorite")
                    .and_then(serde_json::Value::as_i64)
                    == Some(1);
                Ok((is_starred(ctx, &asset_id)? != wanted)
                    .then(|| "the star did not take the value it was sent".to_owned()))
            },
        }],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let favorite = ctx
                .input
                .get("favorite")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default();
            set_starred(ctx, &asset_id, favorite == 1)?;
            Ok(serde_json::json!({ "asset_id": asset_id, "favorite": favorite }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn set_archived() -> CommandDefinition {
    CommandDefinition {
        name: "media.set_archived",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id", "archived"],
          "additionalProperties": false,
          "properties": {
            "asset_id": { "type": "string", "minLength": 1 },
            "archived": { "type": "integer", "enum": [0, 1] }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: live_asset_precondition(),
        postconditions: &[CommandCondition {
            predicate: "archive_applied",
            check: |ctx| {
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let wanted = ctx
                    .input
                    .get("archived")
                    .and_then(serde_json::Value::as_i64)
                    == Some(1);
                let archived_at: Option<String> = ctx.connection().query_row(
                    "SELECT archived_at FROM media_asset WHERE asset_id = ?1",
                    [&asset_id],
                    |row| row.get(0),
                )?;
                Ok((archived_at.is_some() != wanted)
                    .then(|| "the archive flag did not take".to_owned()))
            },
        }],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let archived = ctx
                .input
                .get("archived")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default();
            let stamp = (archived == 1).then(|| ctx.now.clone());
            ctx.connection().execute(
                "UPDATE media_asset SET archived_at = ?1 WHERE asset_id = ?2",
                rusqlite::params![stamp, asset_id],
            )?;
            Ok(serde_json::json!({ "asset_id": asset_id, "archived": archived }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn delete_asset() -> CommandDefinition {
    CommandDefinition {
        name: "media.delete_asset",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id"],
          "additionalProperties": false,
          "properties": { "asset_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[counts!(
            // Only a LIVE asset can be trashed: a double-delete must fail
            // loudly rather than silently re-stamp the trash date and move the
            // purge window out from under a member who is deciding.
            "asset_exists_live",
            "that photograph is already in the trash",
            "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1 AND deleted_at IS NULL",
            "asset_id",
            1
        )],
        postconditions: &[counts!(
            "asset_trashed",
            "the photograph was not moved to the trash",
            "SELECT COUNT(*) FROM media_asset
              WHERE asset_id = ?1 AND deleted_at IS NOT NULL AND purge_at IS NOT NULL",
            "asset_id",
            1
        )],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let content_id = content_id_of(ctx, &asset_id)?;
            // Covers hand off BEFORE the entries go: the hand-off reads them.
            hand_off_covers(ctx, &content_id)?;
            ctx.connection().execute(
                "DELETE FROM core_collection_entry
                  WHERE target_type = ?1 AND target_id = ?2",
                rusqlite::params![ASSET_TARGET_TYPE, asset_id],
            )?;
            ctx.connection().execute(
                "UPDATE media_asset SET deleted_at = ?1, purge_at = ?2 WHERE asset_id = ?3",
                rusqlite::params![ctx.now, purge_at(&ctx.now)?, asset_id],
            )?;
            let released = release_content_if_unreferenced(ctx, &content_id)?;
            Ok(serde_json::json!({
                "asset_id": asset_id,
                "content_released": i64::from(released)
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn restore_asset() -> CommandDefinition {
    CommandDefinition {
        name: "media.restore_asset",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id"],
          "additionalProperties": false,
          "properties": { "asset_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // RESTORE REFUSES A LAPSED WINDOW (#916, review 1.5), and the
            // window is compared against THE INVOCATION'S OWN INSTANT — not
            // SQLite's `now`, which no injected clock reaches and which makes
            // the condition unfixturable at any instant but the host's.
            predicate: "asset_is_trashed_within_its_window",
            check: |ctx| {
                let asset_id = ctx.required_str("asset_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM media_asset
                      WHERE asset_id = ?1 AND deleted_at IS NOT NULL
                        AND (purge_at IS NULL OR purge_at > ?2)",
                    rusqlite::params![asset_id, ctx.now],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| {
                    "that photograph is not in the trash, or its thirty days have run out"
                        .to_owned()
                }))
            },
        }],
        postconditions: &[counts!(
            "asset_live_with_live_content",
            "the photograph came back without its bytes",
            "SELECT COUNT(*) FROM media_asset a
               JOIN core_content_item c ON c.content_id = a.content_id
              WHERE a.asset_id = ?1 AND a.deleted_at IS NULL AND a.purge_at IS NULL
                AND c.deleted_at IS NULL",
            "asset_id",
            1
        )],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let content_id = content_id_of(ctx, &asset_id)?;
            ctx.connection().execute(
                "UPDATE media_asset SET deleted_at = NULL, purge_at = NULL WHERE asset_id = ?1",
                [&asset_id],
            )?;
            // The bytes come back too. **Album membership does NOT** — it was
            // deleted, not soft-deleted, and re-inventing it would put a
            // photograph back into an album the member may since have curated.
            ctx.connection().execute(
                "UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL
                  WHERE content_id = ?1 AND deleted_at IS NOT NULL",
                [&content_id],
            )?;
            Ok(serde_json::json!({ "asset_id": asset_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn purge_asset() -> CommandDefinition {
    CommandDefinition {
        name: "media.purge_asset",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id"],
          "additionalProperties": false,
          "properties": { "asset_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::High,
        // NOT `confirm: true`, deliberately: the owner's confirmation is the
        // MANIFEST's, in front of the command, and a command-level confirm
        // would additionally park the member's own act.
        confirm: false,
        preconditions: &[
            counts!(
                "asset_is_trashed",
                "Only a photograph that is already in the trash can be deleted forever.",
                "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1 AND deleted_at IS NOT NULL",
                "asset_id",
                1
            ),
            counts!(
                "no_derived_assets",
                "An edited copy was made from this photograph. Delete the copy forever first, so \
                 its record of where it came from stays true.",
                "SELECT COUNT(*) FROM media_asset WHERE source_asset_id = ?1",
                "asset_id",
                0
            ),
        ],
        postconditions: &[
            counts!(
                "asset_destroyed",
                "the photograph is still in the library",
                "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
                "asset_id",
                0
            ),
            counts!(
                // NOTHING MAY STILL POINT AT THE ROW (#441): every engine FK,
                // the self-FK and every polymorphic mechanism in ONE
                // predicate, so a clause dropped in a later edit fails here
                // rather than in a member's library.
                "nothing_references_the_asset",
                "something still names the photograph that was just destroyed",
                "SELECT (
                   (SELECT COUNT(*) FROM media_face_region WHERE asset_id = ?1)
                 + (SELECT COUNT(*) FROM media_asset_phash WHERE asset_id = ?1)
                 + (SELECT COUNT(*) FROM media_asset WHERE source_asset_id = ?1)
                 + (SELECT COUNT(*) FROM media_memory_member WHERE asset_id = ?1)
                 + (SELECT COUNT(*) FROM core_collection_entry
                     WHERE target_type = 'media.asset' AND target_id = ?1)
                 + (SELECT COUNT(*) FROM core_tag
                     WHERE target_type = 'media.asset' AND target_id = ?1)
                 + (SELECT COUNT(*) FROM knowledge_annotation
                     WHERE target_type = 'media.asset' AND target_id = ?1)
                 + (SELECT COUNT(*) FROM core_link
                     WHERE valid_to IS NULL
                       AND ((from_type = 'media.asset' AND from_id = ?1)
                         OR (to_type = 'media.asset' AND to_id = ?1)))
                 )",
                "asset_id",
                0
            ),
        ],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let content_id = content_id_of(ctx, &asset_id)?;
            // An asset can be filed into an album WHILE trashed, so membership
            // may still exist; covers hand off before the entries go.
            hand_off_covers(ctx, &content_id)?;
            ctx.connection().execute(
                "DELETE FROM core_collection_entry
                  WHERE target_type = ?1 AND target_id = ?2",
                rusqlite::params![ASSET_TARGET_TYPE, asset_id],
            )?;
            // Face regions have no ON DELETE CASCADE from the asset, so they go
            // by hand; everything that POINTS AT a region — its vectors, its
            // derivation stamps — is a composite foreign key into `core_entity`
            // since #916, so the engine carries those away with each region.
            ctx.connection().execute(
                "DELETE FROM media_face_region WHERE asset_id = ?1",
                [&asset_id],
            )?;
            ctx.connection()
                .execute("DELETE FROM media_asset WHERE asset_id = ?1", [&asset_id])?;
            let released = release_content_now(ctx, &content_id)?;
            Ok(serde_json::json!({
                "asset_id": asset_id,
                "content_released": i64::from(released)
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn create_album() -> CommandDefinition {
    CommandDefinition {
        name: "media.create_album",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["title"],
          "additionalProperties": false,
          "properties": {
            "album_id": { "type": "string", "minLength": 1, "maxLength": 200 },
            "title": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // A SEAT-MINTED ID MUST BE FREE (#922 G2). The seat mints the row
            // id so its own offline projection carries the id the origin will
            // honour; a taken id is a collision the member has to be told
            // about, not one to resolve by minting a second row.
            predicate: "minted_id_is_free",
            check: |ctx| {
                let Some(album_id) = ctx.optional_str("album_id") else {
                    return Ok(None);
                };
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
                    [album_id],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "an album with that id already exists".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "album_created",
            check: |ctx| {
                let album_id = ctx
                    .optional_str("album_id")
                    .map(str::to_owned)
                    .or_else(|| ctx.produced_ids.borrow().first().cloned())
                    .unwrap_or_default();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
                    [&album_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the album was not created".to_owned()))
            },
        }],
        handler: |ctx| {
            let title = ctx.required_str("title")?.to_owned();
            let album_id = ctx
                .optional_str("album_id")
                .map_or_else(|| ctx.next_id(), str::to_owned);
            let owner = owner_party_id(ctx)?;
            // An album is a TOP-LEVEL collection, and `sort_order` is
            // sibling-scoped — `IS NULL`, not `= NULL`, so null parents group
            // together rather than each being its own sibling set.
            ctx.connection().execute(
                "INSERT INTO core_collection
                   (collection_id, owner_party_id, name, cover_content_id,
                    parent_collection_id, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, NULL,
                         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM core_collection
                           WHERE parent_collection_id IS NULL), ?4, ?4)",
                rusqlite::params![album_id, owner, title, ctx.now],
            )?;
            Ok(serde_json::json!({ "album_id": album_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn rename_album() -> CommandDefinition {
    CommandDefinition {
        name: "media.rename_album",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["album_id", "title"],
          "additionalProperties": false,
          "properties": {
            "album_id": { "type": "string", "minLength": 1 },
            "title": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[counts!(
            "album_exists",
            "there is no album with that id",
            "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
            "album_id",
            1
        )],
        postconditions: &[CommandCondition {
            predicate: "title_applied",
            check: |ctx| {
                let album_id = ctx.required_str("album_id")?.to_owned();
                let title = ctx.required_str("title")?.to_owned();
                let name: String = ctx.connection().query_row(
                    "SELECT name FROM core_collection WHERE collection_id = ?1",
                    [&album_id],
                    |row| row.get(0),
                )?;
                Ok((name != title).then(|| "the album's title did not take".to_owned()))
            },
        }],
        handler: |ctx| {
            let album_id = ctx.required_str("album_id")?.to_owned();
            let title = ctx.required_str("title")?.to_owned();
            ctx.connection().execute(
                "UPDATE core_collection SET name = ?1 WHERE collection_id = ?2",
                rusqlite::params![title, album_id],
            )?;
            Ok(serde_json::json!({ "album_id": album_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn set_album_cover() -> CommandDefinition {
    CommandDefinition {
        name: "media.set_album_cover",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["album_id", "asset_id"],
          "additionalProperties": false,
          "properties": {
            "album_id": { "type": "string", "minLength": 1 },
            "asset_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // A cover is chosen from the album's MEMBERS. A photograph that is
            // not in the album is not a cover for it.
            predicate: "asset_is_album_member",
            check: |ctx| {
                let album_id = ctx.required_str("album_id")?.to_owned();
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection_entry
                      WHERE collection_id = ?1 AND target_type = ?2 AND target_id = ?3",
                    rusqlite::params![album_id, ASSET_TARGET_TYPE, asset_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "that photograph is not in this album".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "cover_applied",
            check: |ctx| {
                let album_id = ctx.required_str("album_id")?.to_owned();
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection c
                       JOIN media_asset a ON a.content_id = c.cover_content_id
                      WHERE c.collection_id = ?1 AND a.asset_id = ?2",
                    rusqlite::params![album_id, asset_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the cover did not take".to_owned()))
            },
        }],
        handler: |ctx| {
            let album_id = ctx.required_str("album_id")?.to_owned();
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            // The cover is the asset's CANONICAL CONTENT ITEM, not the asset:
            // a collection can cover itself with a document's bytes too.
            ctx.connection().execute(
                "UPDATE core_collection SET cover_content_id =
                   (SELECT content_id FROM media_asset WHERE asset_id = ?1)
                 WHERE collection_id = ?2",
                rusqlite::params![asset_id, album_id],
            )?;
            Ok(serde_json::json!({ "album_id": album_id, "asset_id": asset_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// The album snapshot a delete records and a restore replays.
fn album_snapshot(ctx: &CommandCtx<'_, '_>, album_id: &str) -> Result<serde_json::Value> {
    let album: serde_json::Value = ctx
        .connection()
        .query_row(
            "SELECT owner_party_id, name, cover_content_id, parent_collection_id,
                    sort_order, created_at
               FROM core_collection WHERE collection_id = ?1",
            [album_id],
            |row| {
                Ok(serde_json::json!({
                    "owner_party_id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "cover_content_id": row.get::<_, Option<String>>(2)?,
                    "parent_collection_id": row.get::<_, Option<String>>(3)?,
                    "sort_order": row.get::<_, i64>(4)?,
                    "created_at": row.get::<_, String>(5)?,
                }))
            },
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("album {album_id} vanished between the check and the write"),
        })?;
    let entries: Vec<serde_json::Value> = {
        let connection = ctx.connection();
        let mut statement = connection.prepare(
            "SELECT entry_id, target_type, target_id, position, added_at
               FROM core_collection_entry WHERE collection_id = ?1
              ORDER BY position, entry_id",
        )?;
        let rows = statement.query_map([album_id], |row| {
            Ok(serde_json::json!({
                "entry_id": row.get::<_, String>(0)?,
                "target_type": row.get::<_, String>(1)?,
                "target_id": row.get::<_, String>(2)?,
                "position": row.get::<_, i64>(3)?,
                "added_at": row.get::<_, String>(4)?,
            }))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(serde_json::json!({ "album": album, "entries": entries }))
}

fn delete_album() -> CommandDefinition {
    CommandDefinition {
        name: "media.delete_album",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["album_id"],
          "additionalProperties": false,
          "properties": { "album_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[
            counts!(
                "album_exists",
                "there is no album with that id",
                "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
                "album_id",
                1
            ),
            counts!(
                // The album surface manages FLAT collections only; a nested one
                // came from the notebook surface and keeps its children until
                // they move.
                "album_has_no_children",
                "this collection has collections inside it; empty it from the surface that \
                 nested them",
                "SELECT COUNT(*) FROM core_collection WHERE parent_collection_id = ?1",
                "album_id",
                0
            ),
        ],
        postconditions: &[counts!(
            // The CURATION is gone; the photographs it pointed at are
            // untouched.
            "album_removed",
            "the album is still there",
            "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
            "album_id",
            0
        )],
        handler: |ctx| {
            let album_id = ctx.required_str("album_id")?.to_owned();
            // THE SNAPSHOT IS THE UNDO. An album is an ordered curation and
            // nothing else holds the order, so deleting it without recording
            // the membership makes "restore" unimplementable.
            let snapshot = album_snapshot(ctx, &album_id)?;
            let revision_id = ctx.next_id();
            let undo_until = purge_at(&ctx.now)?;
            ctx.connection().execute(
                "INSERT INTO core_entity_revision
                   (revision_id, entity_type, entity_id, operation, snapshot_json,
                    recorded_at, undo_until, undone_at)
                 VALUES (?1, ?2, ?3, 'trash', ?4, ?6, ?5, NULL)",
                rusqlite::params![
                    revision_id,
                    ALBUM_ENTITY_TYPE,
                    album_id,
                    serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".to_owned()),
                    undo_until,
                    ctx.now
                ],
            )?;
            ctx.connection().execute(
                "DELETE FROM core_collection_entry WHERE collection_id = ?1",
                [&album_id],
            )?;
            ctx.connection().execute(
                "DELETE FROM core_collection WHERE collection_id = ?1",
                [&album_id],
            )?;
            Ok(serde_json::json!({
                "album_id": album_id,
                "revision_id": revision_id,
                "undo_until": undo_until
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn restore_album() -> CommandDefinition {
    CommandDefinition {
        name: "media.restore_album",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["album_id", "revision_id"],
          "additionalProperties": false,
          "properties": {
            "album_id": { "type": "string", "minLength": 1 },
            "revision_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            counts!(
                "album_is_absent",
                "that album is already there",
                "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
                "album_id",
                0
            ),
            CommandCondition {
                predicate: "revision_is_this_albums_and_not_undone",
                check: |ctx| {
                    let album_id = ctx.required_str("album_id")?.to_owned();
                    let revision_id = ctx.required_str("revision_id")?.to_owned();
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_entity_revision
                          WHERE revision_id = ?1 AND entity_type = ?2 AND entity_id = ?3
                            AND undone_at IS NULL",
                        rusqlite::params![revision_id, ALBUM_ENTITY_TYPE, album_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| {
                        "that undo record is not this album's, or it has already been used"
                            .to_owned()
                    }))
                },
            },
        ],
        postconditions: &[counts!(
            "album_restored",
            "the album did not come back",
            "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
            "album_id",
            1
        )],
        handler: |ctx| {
            let album_id = ctx.required_str("album_id")?.to_owned();
            let revision_id = ctx.required_str("revision_id")?.to_owned();
            let snapshot_json: String = ctx.connection().query_row(
                "SELECT snapshot_json FROM core_entity_revision WHERE revision_id = ?1",
                [&revision_id],
                |row| row.get(0),
            )?;
            let snapshot: serde_json::Value =
                serde_json::from_str(&snapshot_json).map_err(|source| VaultError::Json {
                    context: format!("revision {revision_id} does not hold an album snapshot"),
                    source,
                })?;
            let album = &snapshot["album"];
            ctx.connection().execute(
                "INSERT INTO core_collection
                   (collection_id, owner_party_id, name, cover_content_id,
                    parent_collection_id, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    album_id,
                    album["owner_party_id"].as_str().unwrap_or_default(),
                    album["name"].as_str().unwrap_or_default(),
                    album["cover_content_id"].as_str(),
                    album["parent_collection_id"].as_str(),
                    album["sort_order"].as_i64().unwrap_or_default(),
                    album["created_at"].as_str().unwrap_or(ctx.now.as_str()),
                    ctx.now
                ],
            )?;
            // THE ORDER COMES BACK WITH THE MEMBERSHIP. `entry_id` and
            // `position` are replayed from the snapshot rather than re-minted,
            // so a surface holding an entry id from before the delete still
            // names the same row.
            for entry in snapshot["entries"].as_array().unwrap_or(&Vec::new()) {
                ctx.connection().execute(
                    "INSERT INTO core_collection_entry
                       (entry_id, collection_id, target_type, target_id, position, added_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        entry["entry_id"].as_str().unwrap_or_default(),
                        album_id,
                        entry["target_type"].as_str().unwrap_or_default(),
                        entry["target_id"].as_str().unwrap_or_default(),
                        entry["position"].as_i64().unwrap_or_default(),
                        entry["added_at"].as_str().unwrap_or(ctx.now.as_str()),
                    ],
                )?;
            }
            // A used undo record is marked used, so it cannot restore twice.
            ctx.connection().execute(
                "UPDATE core_entity_revision SET undone_at = ?1 WHERE revision_id = ?2",
                rusqlite::params![ctx.now, revision_id],
            )?;
            Ok(serde_json::json!({ "album_id": album_id, "revision_id": revision_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn add_to_album() -> CommandDefinition {
    CommandDefinition {
        name: "media.add_to_album",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["album_id", "asset_id"],
          "additionalProperties": false,
          "properties": {
            "album_id": { "type": "string", "minLength": 1 },
            "asset_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            counts!(
                "album_exists",
                "there is no album with that id",
                "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
                "album_id",
                1
            ),
            counts!(
                "asset_exists",
                "there is no photograph with that id",
                "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
                "asset_id",
                1
            ),
            CommandCondition {
                // A RECEIPTED REFUSAL BEATS A UNIQUE-CONSTRAINT THROW: the
                // member reads a sentence rather than a constraint name.
                predicate: "not_already_in_album",
                check: |ctx| {
                    let album_id = ctx.required_str("album_id")?.to_owned();
                    let asset_id = ctx.required_str("asset_id")?.to_owned();
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_collection_entry
                          WHERE collection_id = ?1 AND target_type = ?2 AND target_id = ?3",
                        rusqlite::params![album_id, ASSET_TARGET_TYPE, asset_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0).then(|| "that photograph is already in this album".to_owned()))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "entry_created",
            check: |ctx| {
                let album_id = ctx.required_str("album_id")?.to_owned();
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection_entry
                      WHERE collection_id = ?1 AND target_type = ?2 AND target_id = ?3",
                    rusqlite::params![album_id, ASSET_TARGET_TYPE, asset_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the photograph did not enter the album".to_owned()))
            },
        }],
        handler: |ctx| {
            let album_id = ctx.required_str("album_id")?.to_owned();
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            // Position is ONE ordered list per collection, across member types:
            // an album holding a document and a photograph has one order, not
            // two interleaved ones.
            let position: i64 = ctx.connection().query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM core_collection_entry
                  WHERE collection_id = ?1",
                [&album_id],
                |row| row.get(0),
            )?;
            let entry_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_collection_entry
                   (entry_id, collection_id, target_type, target_id, position, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    entry_id,
                    album_id,
                    ASSET_TARGET_TYPE,
                    asset_id,
                    position,
                    ctx.now
                ],
            )?;
            // The first photograph into a coverless album becomes its cover.
            ctx.connection().execute(
                "UPDATE core_collection SET cover_content_id =
                   (SELECT content_id FROM media_asset WHERE asset_id = ?1)
                 WHERE collection_id = ?2 AND cover_content_id IS NULL",
                rusqlite::params![asset_id, album_id],
            )?;
            Ok(serde_json::json!({ "entry_id": entry_id, "position": position }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn remove_from_album() -> CommandDefinition {
    CommandDefinition {
        name: "media.remove_from_album",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["album_id", "asset_id"],
          "additionalProperties": false,
          "properties": {
            "album_id": { "type": "string", "minLength": 1 },
            "asset_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "entry_exists",
            check: |ctx| {
                let album_id = ctx.required_str("album_id")?.to_owned();
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection_entry
                      WHERE collection_id = ?1 AND target_type = ?2 AND target_id = ?3",
                    rusqlite::params![album_id, ASSET_TARGET_TYPE, asset_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "that photograph is not in this album".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "entry_removed",
            check: |ctx| {
                let album_id = ctx.required_str("album_id")?.to_owned();
                let asset_id = ctx.required_str("asset_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection_entry
                      WHERE collection_id = ?1 AND target_type = ?2 AND target_id = ?3",
                    rusqlite::params![album_id, ASSET_TARGET_TYPE, asset_id],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "the photograph did not leave the album".to_owned()))
            },
        }],
        handler: |ctx| {
            let album_id = ctx.required_str("album_id")?.to_owned();
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let content_id = content_id_of(ctx, &asset_id)?;
            ctx.connection().execute(
                "DELETE FROM core_collection_entry
                  WHERE collection_id = ?1 AND target_type = ?2 AND target_id = ?3",
                rusqlite::params![album_id, ASSET_TARGET_TYPE, asset_id],
            )?;
            // A cover that just left the album hands off to the next member —
            // and only then: a cover that is still a member stays.
            let cover: Option<String> = ctx.connection().query_row(
                "SELECT cover_content_id FROM core_collection WHERE collection_id = ?1",
                [&album_id],
                |row| row.get(0),
            )?;
            if cover.as_deref() == Some(content_id.as_str()) {
                ctx.connection().execute(
                    "UPDATE core_collection SET cover_content_id =
                       (SELECT a.content_id FROM core_collection_entry e
                          JOIN media_asset a ON a.asset_id = e.target_id
                         WHERE e.collection_id = ?1 AND e.target_type = ?2
                         ORDER BY e.position LIMIT 1)
                     WHERE collection_id = ?1",
                    rusqlite::params![album_id, ASSET_TARGET_TYPE],
                )?;
            }
            Ok(serde_json::json!({ "album_id": album_id, "asset_id": asset_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn forget_person() -> CommandDefinition {
    CommandDefinition {
        name: "media.forget_person",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id"],
          "additionalProperties": false,
          "properties": { "party_id": { "type": "string", "minLength": 1 } }
        }"#,
        // RETRY-SAFE rather than `once`: a second call finds nothing and says
        // so with a zero count. Refusing it as a replay would leave a member
        // unsure whether the first landed, with no way to make sure.
        idempotency: Idempotency::RetrySafe,
        risk: Risk::High,
        // THE ONE COMMAND IN THIS SCHEMA WITH THE COMMAND-LEVEL GATE, and no
        // Photos action invokes it: an agent or an app asking to destroy a
        // person's face data parks for the owner.
        confirm: true,
        preconditions: &[counts!(
            "party_exists",
            "That person is not in this library, so there is no face data to forget.",
            "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
            "party_id",
            1
        )],
        postconditions: &[counts!(
            // THE GATE, IN ONE PREDICATE: every table that can name the party
            // through a face, counted together. A non-zero total is an
            // incomplete cascade, and a FIFTH mechanism added without a clause
            // here fails the gate rather than leaving a vector behind.
            "no_face_data_names_the_party",
            "face data naming that person survived the erasure",
            "SELECT (
               (SELECT COUNT(*) FROM media_face_region
                 WHERE party_id = ?1 OR confirmed_by_party_id = ?1)
             + (SELECT COUNT(*) FROM enrich_embedding
                 WHERE target_type = 'media.face_region'
                   AND target_id NOT IN (SELECT region_id FROM media_face_region))
             + (SELECT COUNT(*) FROM enrich_derivation
                 WHERE target_type = 'media.face_region'
                   AND target_id NOT IN (SELECT region_id FROM media_face_region))
             + (SELECT COUNT(*) FROM media_face_cluster
                 WHERE region_id NOT IN (SELECT region_id FROM media_face_region))
             )",
            "party_id",
            0
        )],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            // THE PARTY'S OWN FACES, AND ONLY THOSE (#1020, R-1020-35,
            // D-1020-CL2). `confirmed_by_party_id` names the member who JUDGED
            // the region, not the person in it; in a single-member vault that
            // is the owner on every confirmation, so deleting on both columns
            // made "forget me" erase everyone's confirmed faces. The judgement
            // is erased below instead, by clearing the column — and the state
            // goes with it, because the schema pins the two to each other
            // (`CHECK ((review_state = 'confirmed') = (confirmed_by_party_id
            // IS NOT NULL))`).
            let regions: Vec<String> = {
                let connection = ctx.connection();
                let mut statement = connection.prepare(
                    "SELECT region_id FROM media_face_region
                      WHERE party_id = ?1
                      ORDER BY region_id",
                )?;
                let rows = statement.query_map([&party_id], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<String>>>()?
            };
            let mut embeddings = 0_i64;
            for region_id in &regions {
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM enrich_embedding
                      WHERE target_type = 'media.face_region' AND target_id = ?1",
                    [region_id],
                    |row| row.get(0),
                )?;
                embeddings += count;
                // The grouping first (it references the region), then the
                // region: every polymorphic pointer AT the region is a
                // composite foreign key into `core_entity` since #916, so the
                // engine carries them away as each region goes — through a set
                // complete by construction rather than a list kept in step.
                ctx.connection().execute(
                    "DELETE FROM media_face_cluster WHERE region_id = ?1",
                    [region_id],
                )?;
                ctx.connection().execute(
                    "DELETE FROM media_face_region WHERE region_id = ?1",
                    [region_id],
                )?;
            }
            // The judgements this member made about OTHER people's faces. Read
            // after the deletions, so a region that was both theirs and judged
            // by them is counted once, as a deletion. The region goes back to
            // being a PROPOSAL — the face is still there, still named, and no
            // longer vouched for by anyone.
            ctx.connection().execute(
                "UPDATE media_face_region
                    SET confirmed_by_party_id = NULL, review_state = 'proposed'
                  WHERE confirmed_by_party_id = ?1",
                [&party_id],
            )?;
            // NOTHING IS KEPT (#916): a pre-mutation snapshot of a forgotten
            // face is a copy of exactly what the member asked to be destroyed,
            // sitting where the next export would carry it out. So this
            // command records no revision — `core.party` itself is untouched,
            // which is `people.trash_person`'s job.
            Ok(serde_json::json!({
                "party_id": party_id,
                "regions_forgotten": regions.len(),
                "embeddings_forgotten": embeddings
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// The three answers, as a TABLE rather than a branch chain, so a fourth answer
/// is one row rather than an edit at every site. `keeps_party` is the invariant
/// the DDL also enforces: only proposed and confirmed regions carry a party.
const FACE_ANSWERS: &[(&str, &str, bool)] = &[
    ("confirm", "confirmed", true),
    ("reject", "rejected", false),
    ("dismiss", "dismissed", false),
];

fn answer_face_proposal() -> CommandDefinition {
    CommandDefinition {
        // Named `media.*` and living here because the region is media's, even
        // though v0 files it beside the enrichment commands that WRITE the
        // proposals. **This is the only writer of `review_state`.**
        name: "media.answer_face_proposal",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["region_id", "answer"],
          "additionalProperties": false,
          "properties": {
            "region_id": { "type": "string", "minLength": 1 },
            "answer": { "type": "string", "enum": ["confirm", "reject", "dismiss"] },
            "party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        // RETRY-SAFE, not `once`: answering the same region twice is how a
        // member corrects themself, so the second answer must land.
        idempotency: Idempotency::RetrySafe,
        // Low by design: this curates DERIVED proposals, the same class as
        // captioning, so the in-app review loop stays live under the app
        // ceiling.
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            counts!(
                "region_exists",
                "there is no face proposal with that id",
                "SELECT COUNT(*) FROM media_face_region WHERE region_id = ?1",
                "region_id",
                1
            ),
            CommandCondition {
                // THE UNION RULE IN ONE PREDICATE. JSON Schema has no `oneOf`
                // that could say it, and two conditions would conflict.
                predicate: "answer_names_a_party_iff_confirm",
                check: |ctx| {
                    let answer = ctx.required_str("answer")?.to_owned();
                    let party_id = ctx.optional_str("party_id").map(str::to_owned);
                    if answer == "confirm" {
                        let Some(party_id) = party_id else {
                            return Ok(Some(
                                "a 'confirm' answer must name the person the face is".to_owned(),
                            ));
                        };
                        let count: i64 = ctx.connection().query_row(
                            "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                            [&party_id],
                            |row| row.get(0),
                        )?;
                        return Ok((count != 1).then(|| {
                            "a 'confirm' answer must name a party that exists in this vault"
                                .to_owned()
                        }));
                    }
                    Ok(party_id.is_some().then(|| {
                        "'reject' and 'dismiss' name nobody — a refused face asserts no identity"
                            .to_owned()
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "answer_recorded",
            check: |ctx| {
                let region_id = ctx.required_str("region_id")?.to_owned();
                let answer = ctx.required_str("answer")?.to_owned();
                let wanted = FACE_ANSWERS
                    .iter()
                    .find(|(name, _, _)| *name == answer)
                    .map(|(_, state, _)| *state)
                    .unwrap_or_default();
                let state: String = ctx.connection().query_row(
                    "SELECT review_state FROM media_face_region WHERE region_id = ?1",
                    [&region_id],
                    |row| row.get(0),
                )?;
                Ok((state != wanted).then(|| "the answer was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let region_id = ctx.required_str("region_id")?.to_owned();
            let answer = ctx.required_str("answer")?.to_owned();
            let Some((_, state, keeps_party)) =
                FACE_ANSWERS.iter().find(|(name, _, _)| *name == answer)
            else {
                return Err(VaultError::InvalidInput {
                    name: "answer".to_owned(),
                    detail: format!("`{answer}` is not an answer this command knows"),
                });
            };
            // The confirmer is the acting party — the owner when an app or a
            // device calls. Only a confirm has one, and the table's own CHECK
            // refuses the pair coming apart.
            let confirmer = if *keeps_party {
                Some(owner_party_id(ctx)?)
            } else {
                None
            };
            let party_id = if *keeps_party {
                ctx.optional_str("party_id").map(str::to_owned)
            } else {
                None
            };
            ctx.connection().execute(
                "UPDATE media_face_region
                    SET review_state = ?1, party_id = ?2, confirmed_by_party_id = ?3
                  WHERE region_id = ?4",
                rusqlite::params![state, party_id, confirmer, region_id],
            )?;
            Ok(serde_json::json!({ "region_id": region_id, "review_state": state }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn set_place_gazetteer() -> CommandDefinition {
    CommandDefinition {
        // THE MACHINE HALF of naming a place (#816). `core_place.name` is the
        // MEMBER's: this command never writes it or `kind`, owning only
        // `$.gazetteer` inside `address_json`, and every other key there
        // survives. **No media bytes at all** — the `place-names` recipe reads
        // a coordinate and a vendored gazetteer, and nothing else.
        name: "media.set_place_gazetteer",
        owner_schema: "media",
        input_schema: r#"{
          "type": "object",
          "required": ["place_id", "source"],
          "additionalProperties": false,
          "properties": {
            "place_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 120 },
            "admin": { "type": "string", "maxLength": 16 },
            "country": { "type": "string", "maxLength": 2 },
            "distance_km": { "type": "number", "minimum": 0, "maximum": 200 },
            "source": { "type": "string", "enum": ["geonames-cities15000"] },
            "snapshot": { "type": "string", "minLength": 1, "maxLength": 32 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[counts!(
            "place_exists",
            "this vault knows no place with that id",
            "SELECT COUNT(*) FROM core_place WHERE place_id = ?1",
            "place_id",
            1
        )],
        postconditions: &[CommandCondition {
            // `checked_at` is what the re-scan keys off, and the member's own
            // `name` surviving is the other half — asserted in the test below,
            // because no postcondition can see a pre-value.
            predicate: "gazetteer_recorded",
            check: |ctx| {
                let place_id = ctx.required_str("place_id")?.to_owned();
                let checked: Option<String> = ctx.connection().query_row(
                    "SELECT json_extract(address_json, '$.gazetteer.checked_at')
                       FROM core_place WHERE place_id = ?1",
                    [&place_id],
                    |row| row.get(0),
                )?;
                Ok(checked
                    .is_none()
                    .then(|| "the gazetteer answer was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let place_id = ctx.required_str("place_id")?.to_owned();
            let source = ctx.required_str("source")?.to_owned();
            if !GAZETTEER_SOURCES.contains(&source.as_str()) {
                return Err(VaultError::InvalidInput {
                    name: "source".to_owned(),
                    detail: format!("`{source}` is not a gazetteer this build accepts"),
                });
            }
            let name = ctx.optional_str("name").map(str::trim).unwrap_or_default();
            let mut record = serde_json::Map::new();
            if name.is_empty() {
                // A MISS IS A RESULT. Without a none-marker the automation's
                // "no gazetteer key" selection re-examines every mid-ocean
                // coordinate forever.
                record.insert("none".to_owned(), serde_json::Value::Bool(true));
            } else {
                record.insert(
                    "name".to_owned(),
                    serde_json::Value::String(name.to_owned()),
                );
                // A stored `""` reads as "checked, none", not "not a fact
                // here", so a blank qualifier is omitted rather than written.
                for key in ["admin", "country"] {
                    if let Some(value) = ctx.optional_str(key).map(str::trim)
                        && !value.is_empty()
                    {
                        record.insert(key.to_owned(), serde_json::Value::String(value.to_owned()));
                    }
                }
                if let Some(distance) = ctx.input.get("distance_km")
                    && distance.is_number()
                {
                    record.insert("distance_km".to_owned(), distance.clone());
                }
            }
            record.insert("source".to_owned(), serde_json::Value::String(source));
            if let Some(snapshot) = ctx.optional_str("snapshot") {
                record.insert(
                    "snapshot".to_owned(),
                    serde_json::Value::String(snapshot.to_owned()),
                );
            }
            record.insert(
                "checked_at".to_owned(),
                serde_json::Value::String(ctx.now.clone()),
            );
            // `json_set` over the existing document: every other key in
            // `address_json` — the member's own address among them — survives.
            ctx.connection().execute(
                "UPDATE core_place
                    SET address_json = json_set(COALESCE(address_json, '{}'),
                                                '$.gazetteer', json(?1))
                  WHERE place_id = ?2",
                rusqlite::params![
                    serde_json::to_string(&record).unwrap_or_else(|_| "{}".to_owned()),
                    place_id
                ],
            )?;
            Ok(serde_json::json!({
                "place_id": place_id,
                "matched": !name.is_empty(),
                "name": (!name.is_empty()).then(|| name.to_owned())
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_definition_is_named_under_its_owner_schema_and_has_a_valid_schema() {
        for definition in definitions() {
            assert!(
                definition.name.starts_with("media."),
                "{} is not a media command",
                definition.name
            );
            assert_eq!(definition.owner_schema, "media");
            let schema: serde_json::Value = serde_json::from_str(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            assert_eq!(
                schema["additionalProperties"],
                serde_json::json!(false),
                "{} accepts unrecognised keys",
                definition.name
            );
        }
    }

    #[test]
    fn the_schema_carries_twenty_commands() {
        assert_eq!(definitions().len(), 20);
    }

    /// v0's split, counted. The census reads the `once` arm as five and misses
    /// `media.add_asset`; this is the number.
    #[test]
    fn the_idempotency_split_matches_v0() {
        let count = |wanted: Idempotency| {
            definitions()
                .iter()
                .filter(|definition| definition.idempotency == wanted)
                .count()
        };
        assert_eq!(count(Idempotency::Idempotent), 12);
        assert_eq!(count(Idempotency::Once), 6);
        assert_eq!(count(Idempotency::RetrySafe), 2);
    }

    /// EXACTLY ONE command-level `confirm`, and it is not one Photos invokes.
    #[test]
    fn only_forget_person_carries_the_non_owner_park() {
        let confirmed: Vec<&str> = definitions()
            .iter()
            .filter(|definition| definition.confirm)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(confirmed, ["media.forget_person"]);
        // And `purge_asset`, which the MANIFEST confirms, does not carry it.
        let purge = definitions()
            .into_iter()
            .find(|definition| definition.name == "media.purge_asset")
            .expect("registered");
        assert!(!purge.confirm);
        assert_eq!(purge.risk, Risk::High);
    }

    #[test]
    fn no_media_command_is_online_only_and_none_seals_an_input() {
        for definition in definitions() {
            assert!(!definition.online_only, "{}", definition.name);
            assert!(definition.sealed_input.is_empty(), "{}", definition.name);
        }
    }

    #[test]
    fn the_grace_window_is_thirty_days_in_the_vaults_own_spelling() {
        assert_eq!(
            purge_at("2026-03-01T00:00:00.000Z").unwrap(),
            "2026-03-31T00:00:00.000Z"
        );
        // Across a year boundary and a leap day.
        assert_eq!(
            purge_at("2028-02-10T12:34:56.789Z").unwrap(),
            "2028-03-11T12:34:56.789Z"
        );
        assert!(purge_at("not-an-instant").is_err());
    }

    /// The reference list is the REGISTRY's, and this is the claim that lets it
    /// be interpolated: every liveness clause is one string this build reviewed.
    #[test]
    fn every_content_reference_clause_is_one_this_build_reviewed() {
        let references = &centraid_ontology::registries::v0_registries().content_references;
        assert!(!references.is_empty());
        for reference in references {
            assert!(
                reference.only_live.is_none()
                    || reference.only_live.as_deref() == Some("deleted_at IS NULL"),
                "{}.{} carries an unreviewed clause",
                reference.table,
                reference.column
            );
        }
        // `media_asset` and `core_collection` are the two Photos itself
        // creates; a library whose reference list lost either would release
        // bytes a photograph or an album cover still rents.
        let named: Vec<&str> = references
            .iter()
            .map(|reference| reference.table.as_str())
            .collect();
        assert!(named.contains(&"media_asset"));
        assert!(named.contains(&"core_collection"));
    }

    #[test]
    fn the_instant_round_trips() {
        for text in [
            "1970-01-01T00:00:00.000Z",
            "2026-03-01T00:00:00.000Z",
            "2099-06-01T09:00:00.000Z",
            "2024-02-29T23:59:59.999Z",
        ] {
            let millis = parse_instant_ms(text).expect(text);
            assert_eq!(format_instant_ms(millis), text);
        }
    }
}
