//! WHAT THE CORE'S DEVICE SERVICES READ: whether an entity exists, and what is on a day (the
//! widget's Today). SQL lives only in the crates that may hold it; the core asks here. These are
//! plain reads, not registered ones: Calendar's and Reminders' own `today` reads replace
//! [`today`] when those apps land.

use rusqlite::Connection;

/// One item on a day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub title: String,
}

/// A day, in the three spellings a stored moment takes.
#[derive(Debug, Clone)]
pub struct Day<'a> {
    /// `YYYY-MM-DD`, the member's.
    pub day: &'a str,
    /// The day's start and end as instants (`…Z`), for zoned moments.
    pub from: &'a str,
    pub to: &'a str,
    /// The day's first and last minute as wall clocks, for floating moments.
    pub floating_from: &'a str,
    pub floating_to: &'a str,
}

/// What is on one day: events that start or run through it, and open tasks due or scheduled on it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Today {
    pub events: Vec<Item>,
    pub tasks: Vec<Item>,
}

/// Whether an entity with `id` exists, trashed or not.
///
/// # Errors
/// SQLite's refusal.
pub fn entity_held(connection: &Connection, id: &str) -> rusqlite::Result<bool> {
    let held: i64 =
        connection.query_row("SELECT COUNT(*) FROM entity WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    Ok(held > 0)
}

fn items(
    connection: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> rusqlite::Result<Vec<Item>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params, |row| {
        Ok(Item {
            id: row.get(0)?,
            title: row.get(1)?,
        })
    })?;
    rows.collect()
}

/// The live events and open tasks of `day`. A repeating event is not expanded.
///
/// # Errors
/// SQLite's refusal.
pub fn today(connection: &Connection, day: &Day<'_>) -> rusqlite::Result<Today> {
    let events = items(
        connection,
        "SELECT e.id, n.title FROM event e JOIN entity n ON n.id = e.id
          WHERE n.deleted_at IS NULL AND e.status <> 'cancelled' AND e.rule IS NULL AND (
                (e.timing = 'zoned' AND e.starts >= ?1 AND e.starts < ?2)
             OR (e.timing = 'floating' AND e.starts >= ?3 AND e.starts <= ?4)
             OR (e.timing = 'all-day' AND e.starts <= ?5 AND ifnull(e.ends, e.starts) >= ?5))
          ORDER BY e.starts, e.id",
        &[
            &day.from,
            &day.to,
            &day.floating_from,
            &day.floating_to,
            &day.day,
        ],
    )?;
    let tasks = items(
        connection,
        "SELECT t.id, n.title FROM task t JOIN entity n ON n.id = t.id
          WHERE n.deleted_at IS NULL AND t.status = 'open' AND (
                (t.due_timing = 'zoned' AND t.due >= ?1 AND t.due < ?2)
             OR (t.due_timing = 'floating' AND t.due >= ?3 AND t.due <= ?4)
             OR (t.due_timing = 'all-day' AND t.due = ?5)
             OR t.scheduled_on = ?5)
          ORDER BY t.due, t.id",
        &[
            &day.from,
            &day.to,
            &day.floating_from,
            &day.floating_to,
            &day.day,
        ],
    )?;
    Ok(Today { events, tasks })
}
