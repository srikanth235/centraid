//! THE SPATIAL INDEX (A16, H3): one point in `geo` for each photo that has a `lat`/`lon` and each
//! place that has coordinates. `geo.n` is the entity's `n`, so a viewport read is one R-tree query
//! joined to `entity` for the id, the kind and the trash.
//!
//! The rows are written by the same queue as the search rows ([`super::apply`]): a photo's or a
//! place's row changing queues the entity, and writing the entity writes its point, or removes it
//! when the coordinates are gone, the entity is in the trash, or it was purged. So a lane that adds
//! the photo or place commands writes nothing to `geo` itself: it writes its rows, and the commit
//! does the rest.

use rusqlite::Connection;

use crate::error::Result;
use crate::model::Kind;

/// One point on the map.
#[derive(Debug, Clone, PartialEq)]
pub struct GeoPoint {
    /// The entity's id.
    pub id: String,
    /// `photo` or `place`.
    pub kind: String,
    /// Degrees north.
    pub lat: f64,
    /// Degrees east.
    pub lon: f64,
}

/// The viewport read: the live photos and places inside a box, west to east and south to north,
/// as ONE R-tree query joined to `entity` (`?1` west, `?2` east, `?3` south, `?4` north, `?5` the
/// most points to answer, in no order: a map draws what is in view). A box that crosses the
/// antimeridian is two reads. `CROSS JOIN` fixes the order of the loops: the R-tree is searched
/// once, then each point's entity is read by its key.
pub const VIEWPORT: &str = "\
    SELECT e.id, e.kind, g.min_lat, g.min_lon
      FROM geo g CROSS JOIN entity e ON e.n = g.n
     WHERE g.min_lon >= ?1 AND g.max_lon <= ?2 AND g.min_lat >= ?3 AND g.max_lat <= ?4
       AND e.deleted_at IS NULL
     LIMIT ?5";

/// Read a viewport ([`VIEWPORT`]).
///
/// # Errors
/// SQLite's refusal.
pub fn viewport(
    connection: &Connection,
    west: f64,
    east: f64,
    south: f64,
    north: f64,
    limit: usize,
) -> Result<Vec<GeoPoint>> {
    Ok(connection
        .prepare_cached(VIEWPORT)?
        .query_map(
            rusqlite::params![
                west,
                east,
                south,
                north,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |row| {
                Ok(GeoPoint {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    lat: row.get(2)?,
                    lon: row.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?)
}

/// Put the entity's point in the index, or take it out when it has none.
pub(super) fn sync(connection: &Connection, n: i64, id: &str, kind: Kind) -> Result<()> {
    let sql = match kind {
        Kind::Photo => "SELECT lat, lon FROM photo WHERE id = ?1",
        Kind::Place => "SELECT lat, lon FROM place WHERE id = ?1",
        _ => return Ok(()),
    };
    let point: Option<(Option<f64>, Option<f64>)> = connection
        .prepare_cached(sql)?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    forget(connection, n)?;
    if let Some((Some(lat), Some(lon))) = point {
        connection
            .prepare_cached(
                "INSERT INTO geo (n, min_lon, max_lon, min_lat, max_lat) VALUES (?1, ?2, ?2, ?3, ?3)",
            )?
            .execute(rusqlite::params![n, lon, lat])?;
    }
    Ok(())
}

/// Take an entity's point out.
pub(super) fn forget(connection: &Connection, n: i64) -> Result<()> {
    connection
        .prepare_cached("DELETE FROM geo WHERE n = ?1")?
        .execute([n])?;
    Ok(())
}
