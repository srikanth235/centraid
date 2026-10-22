//! `place.*`: somewhere the vault knows, and the offline gazetteer's word for it.
//!
//! A place is an entity of kind `place`: its name is the entity's title (so
//! `entity.retitle` names one, and a photograph or an event at it follows the
//! name into its search text), its coordinates and address are columns of the
//! row, and `locality` is **derived** — the nearest city the offline gazetteer
//! matched — and written by [`locate`] alone, so a rename cannot undo it and a
//! member's address is never mistaken for it.
//!
//! A photograph that carries coordinates founds its place through
//! [`find_or_found`]: a place the member has already named within ~170 m is
//! adopted (a cabin covers its garden), else the place at the same ~11 m
//! rounding, else a new one titled by its coordinates. A coordinate-as-name is
//! never adopted as a name: adopting one would spread a placeholder over every
//! later photograph taken nearby.

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::Kind;

/// ~170 m in degrees: the radius at which a place the member named is adopted.
const NAMED_RADIUS_DEG: f64 = 0.0015;

/// The title of a place nobody has named: its coordinates, at ~11 m.
fn coordinate_label(lat: f64, lon: f64) -> String {
    format!("{lat:.4}, {lon:.4}")
}

/// Whether a title is a coordinate pair rather than a name.
fn is_coordinate_label(title: &str) -> bool {
    let Some((lat, lon)) = title.trim().split_once(',') else {
        return false;
    };
    let decimal = |text: &str| {
        let text = text.trim();
        let text = text.strip_prefix('-').unwrap_or(text);
        text.split_once('.').is_some_and(|(whole, fraction)| {
            (1..=3).contains(&whole.len())
                && whole.bytes().all(|b| b.is_ascii_digit())
                && !fraction.is_empty()
                && fraction.bytes().all(|b| b.is_ascii_digit())
        })
    };
    decimal(lat) && decimal(lon)
}

/// Insert the entity and the row of a place; the caller says what it holds.
fn found(
    ctx: &CommandCtx<'_, '_>,
    id: Option<&str>,
    title: &str,
    coordinates: Option<(f64, f64)>,
    address: Option<&str>,
    zone: Option<&str>,
) -> Result<String> {
    let id = match id {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Place, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Place, title)?,
    };
    ctx.connection().execute(
        "INSERT INTO place (id, lat, lon, address, zone) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            id,
            coordinates.map(|(lat, _)| lat),
            coordinates.map(|(_, lon)| lon),
            address,
            zone
        ],
    )?;
    Ok(id)
}

/// The place at these coordinates: the member's own named place nearby, else
/// the one at the same rounding, else a new one.
pub(crate) fn find_or_found(ctx: &CommandCtx<'_, '_>, lat: f64, lon: f64) -> Result<String> {
    // The box is widened by 1/cos(lat) so it stays roughly square away from the
    // equator; SQLite has no trigonometry, so the shaping happens here.
    let lon_radius = NAMED_RADIUS_DEG / lat.to_radians().cos().max(0.05);
    let nearby: Vec<(String, String)> = ctx
        .connection()
        .prepare_cached(
            "SELECT p.id, e.title FROM place p JOIN entity e ON e.id = p.id
              WHERE e.deleted_at IS NULL AND p.lat BETWEEN ?1 AND ?2 AND p.lon BETWEEN ?3 AND ?4
              ORDER BY (p.lat - ?5) * (p.lat - ?5) + (p.lon - ?6) * (p.lon - ?6), p.id
              LIMIT 8",
        )?
        .query_map(
            rusqlite::params![
                lat - NAMED_RADIUS_DEG,
                lat + NAMED_RADIUS_DEG,
                lon - lon_radius,
                lon + lon_radius,
                lat,
                lon
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
        .collect::<rusqlite::Result<_>>()?;
    if let Some((id, _)) = nearby.iter().find(|(_, title)| !is_coordinate_label(title)) {
        return Ok(id.clone());
    }
    let label = coordinate_label(lat, lon);
    if let Some((id, _)) = nearby.iter().find(|(_, title)| *title == label) {
        return Ok(id.clone());
    }
    found(ctx, None, &label, Some((lat, lon)), None, None)
}

fn pair_of(ctx: &CommandCtx<'_, '_>) -> Option<(f64, f64)> {
    let number = |key: &str| ctx.input.get(key).and_then(serde_json::Value::as_f64);
    Some((number("lat")?, number("lon")?))
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a place needs a name".to_owned()));
    }
    let given = |key: &str| ctx.input.get(key).is_some_and(|v| !v.is_null());
    Ok((given("lat") != given("lon"))
        .then(|| "a place's coordinates are a latitude and a longitude together".to_owned()))
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = found(
        ctx,
        ctx.optional_str("id"),
        ctx.required_str("title")?.trim(),
        pair_of(ctx),
        ctx.optional_str("address"),
        ctx.optional_str("zone"),
    )?;
    Ok(serde_json::json!({ "id": id }))
}

fn pre_locate(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(
        match crate::commands::entity::lookup(ctx.connection(), ctx.required_str("id")?)? {
            Err(sentence) => Some(sentence),
            Ok(found) if found.kind != Kind::Place => Some(format!(
                "“{}” is a {}, not a place",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => None,
        },
    )
}

/// Record the gazetteer's answer: the nearest city, or none (`null`).
fn locate(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let locality = ctx
        .optional_str("locality")
        .map(str::trim)
        .filter(|text| !text.is_empty());
    ctx.connection().execute(
        "UPDATE place SET locality = ?2 WHERE id = ?1",
        rusqlite::params![id, locality],
    )?;
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id, "matched": locality.is_some() }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "place_has_a_name_and_whole_coordinates",
        check: pre_add,
    }];
    const LOCATE: &[CommandCondition] = &[CommandCondition {
        predicate: "entity_is_a_place",
        check: pre_locate,
    }];
    vec![
        CommandDefinition::plain(
            "place.add",
            "place",
            r#"{
              "type": "object",
              "required": ["title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 120 },
                "lat": { "type": ["number", "null"], "minimum": -90, "maximum": 90 },
                "lon": { "type": ["number", "null"], "minimum": -180, "maximum": 180 },
                "address": { "type": ["string", "null"], "maxLength": 1000 },
                "zone": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Once,
            ADD,
            add,
        ),
        CommandDefinition::plain(
            "place.locate",
            "place",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "locality": { "type": ["string", "null"], "maxLength": 200 }
              }
            }"#,
            Idempotency::Idempotent,
            LOCATE,
            locate,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::is_coordinate_label;

    #[test]
    fn a_pair_of_decimals_is_a_label_and_a_name_is_not() {
        assert!(is_coordinate_label("12.3400, 56.7800"));
        assert!(is_coordinate_label("-33.8688, 151.2093"));
        assert!(!is_coordinate_label("The cabin"));
        assert!(!is_coordinate_label("Paris, France"));
        assert!(!is_coordinate_label("12, 56"));
    }
}
