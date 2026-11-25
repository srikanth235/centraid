//! A day's totals from a health store: the one writer of `measurement.origin_id`.
//!
//! A day's total is not an item (no trash, no title): one figure per person, day and metric, a
//! correction overwrites it, and `origin_id` says which store it came from (F1, A12). The column
//! is a plain foreign key into `origin` (amendment 7), so **that the origin is a health store is
//! this writer's rule**, and it reads it from the file: a health store is an origin whose system
//! yields readings (`source_shape`), not one the code names.

use rusqlite::{Connection, OptionalExtension};

use crate::error::{Result, VaultError};

/// Write one person's totals for `day` as read from the health store `origin`: each
/// `(metric, value)` replaces the figure the person has for that day and metric, and names the
/// origin. Answers how many figures were written. Nothing is written when any one is refused.
///
/// A metric the file does not know, one whose cadence is not a daily total (a reading), and a
/// value below zero or a day that is not a date are refused by the table's own keys; what only
/// this writer can say is refused here first, with a sentence: the origin is not a store the
/// member follows now, or does not yield readings.
///
/// # Errors
///
/// [`VaultError::InvalidInput`] with a sentence for the refusals above; a database error.
pub fn write_day_totals(
    connection: &Connection,
    origin: &str,
    person: &str,
    day: &str,
    totals: &[(&str, f64)],
) -> Result<usize> {
    let invalid = |name: &str, detail: String| VaultError::InvalidInput {
        name: name.to_owned(),
        detail,
    };
    let held: Option<(String, bool)> = connection
        .query_row(
            "SELECT system, retired_at IS NOT NULL FROM origin WHERE id = ?1",
            [origin],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((system, retired)) = held else {
        return Err(invalid("origin", format!("there is no store `{origin}`")));
    };
    let health: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM source_shape WHERE system = ?1 AND entity_kind = 'reading')",
        [&system],
        |row| row.get(0),
    )?;
    if !health {
        return Err(invalid(
            "origin",
            format!("`{system}` is not a health store: it states no readings"),
        ));
    }
    if retired {
        return Err(invalid(
            "origin",
            "that health store is not followed now".to_owned(),
        ));
    }
    let mut statement = connection.prepare_cached(
        "INSERT INTO measurement (person_id, day, metric, value, origin_id)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (person_id, day, metric) DO UPDATE
            SET value = excluded.value, origin_id = excluded.origin_id",
    )?;
    let mut written = 0;
    for (metric, value) in totals {
        written += statement.execute(rusqlite::params![person, day, metric, value, origin])?;
    }
    Ok(written)
}
