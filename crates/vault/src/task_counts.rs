//! THE TASK READS (#1173, #1214 D1, D3, A14): the true counts of open tasks and the Today, Upcoming
//! and Done lists, each a bounded walk of one index at any vault size.
//!
//! A board is a window, so a count taken over its rows says how many the window held, not how many
//! there are. The widgets say "12 due today" and the member believes it, so every figure is
//! counted in SQL over the whole table, one statement per figure and no row returned.
//!
//! **What is counted and listed is what the board draws**: the open ROOTS of live tasks. A subtask
//! of an open, live parent belongs to its parent; an unfinished child of a closed or trashed
//! parent is a root of its own (the promotion rule, `crates/apps/reminders`' `board`).
//!
//! **A due has three forms** (`task.due_timing`, A2), and each is compared as what it is, against
//! a [`Day`] the caller states in the member's zone, so the zone arithmetic stays with the caller
//! and the statements only compare text:
//!
//! | `due_timing` | Stored | Is today when |
//! |---|---|---|
//! | `all-day` | `YYYY-MM-DD` | it is `today` |
//! | `floating` | `YYYY-MM-DDTHH:MM` | its date is `today` (the member's own wall clock) |
//! | `zoned` | `YYYY-MM-DDTHH:MM:SS.fffZ` | it falls between `starts` and `ends`, the zone's midnights |
//!
//! Each form is one range of `task_by_due (status, due, id)` (an instant's fixed width makes its
//! text order its time order), the other forms inside the range are dropped by the timing, and the
//! tasks planned for the day (`scheduled_on`, D3) are one equality seek of `task_by_scheduled`.
//! Starred is `entity.starred_at` (A14), one range of the partial `entity_starred`.
//!
//! **What these statements cannot read is a repeating task's due.** Its effective due is the next
//! open period, which the one recurrence engine computes in Rust, so a task with a `rule` is left
//! out of `overdue` and `today` in the counts and the caller counts it; the lists return it with
//! [`TaskRow::repeats`] so the caller can place it. It is counted in `starred` and `planned`,
//! which no due decides.

use rusqlite::Connection;

use crate::error::Result;
use crate::file::Vault;

/// The day the reads are made against, in the member's zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Day<'a> {
    /// `YYYY-MM-DD`: today.
    pub today: &'a str,
    /// `YYYY-MM-DD`: tomorrow.
    pub tomorrow: &'a str,
    /// The instant today begins in the zone, `YYYY-MM-DDTHH:MM:SS.fffZ`.
    pub starts: &'a str,
    /// The instant tomorrow begins in the zone, in the same form.
    pub ends: &'a str,
}

/// What the statements counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OpenTaskCounts {
    /// Open roots with no repeat rule, due before today.
    pub overdue: u64,
    /// Open roots with no repeat rule, due today.
    pub today: u64,
    /// Open roots the member plans for today (`scheduled_on`), repeating or not.
    pub planned: u64,
    /// Open roots the member starred, repeating or not.
    pub starred: u64,
}

/// A task as a list shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: i64,
    pub due: Option<String>,
    pub due_timing: Option<String>,
    pub zone: Option<String>,
    pub scheduled_on: Option<String>,
    pub done_at: Option<String>,
    /// The task repeats: its due is the current period's, and placing it is the caller's.
    pub repeats: bool,
}

/// The promotion rule: a task is a root unless its home is an open, live task.
macro_rules! root {
    () => {
        "NOT EXISTS (SELECT 1 FROM task p JOIN entity pe ON pe.id = p.id \
          WHERE p.id = e.parent_id AND p.status = 'open' AND pe.deleted_at IS NULL)"
    };
}

/// One list statement: the tasks `$filter` keeps, live roots, in `$order`, at most `?$limit`.
macro_rules! list {
    ($filter:expr, $order:expr, $limit:expr) => {
        concat!(
            "SELECT t.id, e.title, t.status, t.priority, t.due, t.due_timing, t.zone, \
                    t.scheduled_on, t.done_at, t.rule IS NOT NULL \
               FROM task t JOIN entity e ON e.id = t.id \
              WHERE ",
            $filter,
            " AND e.deleted_at IS NULL AND ",
            root!(),
            " ORDER BY ",
            $order,
            " LIMIT ",
            $limit
        )
    };
}

/// One count statement over the same tasks.
macro_rules! count {
    ($filter:expr) => {
        concat!(
            "SELECT count(*) FROM task t JOIN entity e ON e.id = t.id WHERE ",
            $filter,
            " AND e.deleted_at IS NULL AND ",
            root!()
        )
    };
}

/// Open tasks due before today, zoned: `?1` the instant today begins, `?2` the limit.
pub const OVERDUE_ZONED: &str = list!(
    "t.status = 'open' AND t.due_timing = 'zoned' AND t.due < ?1",
    "t.due, t.id",
    "?2"
);
/// Open tasks due before today, a day or a wall clock: `?1` today, `?2` the limit.
pub const OVERDUE_DAYS: &str = list!(
    "t.status = 'open' AND t.due_timing <> 'zoned' AND t.due < ?1",
    "t.due, t.id",
    "?2"
);
/// Open tasks due today, zoned: `?1` the instant today begins, `?2` tomorrow's, `?3` the limit.
pub const TODAY_ZONED: &str = list!(
    "t.status = 'open' AND t.due_timing = 'zoned' AND t.due >= ?1 AND t.due < ?2",
    "t.due, t.id",
    "?3"
);
/// Open tasks due today, a day or a wall clock: `?1` today, `?2` tomorrow, `?3` the limit.
pub const TODAY_DAYS: &str = list!(
    "t.status = 'open' AND t.due_timing <> 'zoned' AND t.due >= ?1 AND t.due < ?2",
    "t.due, t.id",
    "?3"
);
/// Open tasks the member plans for a day: `?1` the day, `?2` the limit.
pub const PLANNED: &str = list!("t.scheduled_on = ?1 AND t.status = 'open'", "t.id", "?2");
/// Open tasks due after today, zoned: `?1` the instant tomorrow begins, `?2` the limit.
pub const UPCOMING_ZONED: &str = list!(
    "t.status = 'open' AND t.due_timing = 'zoned' AND t.due >= ?1",
    "t.due, t.id",
    "?2"
);
/// Open tasks due after today, a day or a wall clock: `?1` tomorrow, `?2` the limit.
pub const UPCOMING_DAYS: &str = list!(
    "t.status = 'open' AND t.due_timing <> 'zoned' AND t.due >= ?1",
    "t.due, t.id",
    "?2"
);
/// Done tasks, latest first: `?1` the instant to read before, `?2` the limit.
pub const DONE: &str = list!(
    "t.status = 'done' AND t.done_at < ?1",
    "t.done_at DESC, t.id DESC",
    "?2"
);

/// Counts: `OVERDUE_ZONED`'s tasks, `?1` the instant today begins.
pub const COUNT_OVERDUE_ZONED: &str =
    count!("t.status = 'open' AND t.rule IS NULL AND t.due_timing = 'zoned' AND t.due < ?1");
/// Counts: `OVERDUE_DAYS`'s tasks, `?1` today.
pub const COUNT_OVERDUE_DAYS: &str =
    count!("t.status = 'open' AND t.rule IS NULL AND t.due_timing <> 'zoned' AND t.due < ?1");
/// Counts: `TODAY_ZONED`'s tasks, `?1` the instant today begins, `?2` tomorrow's.
pub const COUNT_TODAY_ZONED: &str = count!(
    "t.status = 'open' AND t.rule IS NULL AND t.due_timing = 'zoned' AND t.due >= ?1 AND t.due < ?2"
);
/// Counts: `TODAY_DAYS`'s tasks, `?1` today, `?2` tomorrow.
pub const COUNT_TODAY_DAYS: &str = count!(
    "t.status = 'open' AND t.rule IS NULL AND t.due_timing <> 'zoned' AND t.due >= ?1 AND t.due < ?2"
);
/// Counts: the tasks planned for a day, `?1`.
pub const COUNT_PLANNED: &str = count!("t.scheduled_on = ?1 AND t.status = 'open'");
/// Counts: the open tasks the member starred, by the partial index of `starred_at`.
pub const COUNT_STARRED: &str = concat!(
    "SELECT count(*) FROM entity e JOIN task t ON t.id = e.id \
      WHERE e.kind = 'task' AND e.starred_at IS NOT NULL AND e.deleted_at IS NULL \
        AND t.status = 'open' AND ",
    root!()
);

fn rows(connection: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<TaskRow>> {
    Ok(connection
        .prepare_cached(sql)?
        .query_map(params, |row| {
            Ok(TaskRow {
                id: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                priority: row.get(3)?,
                due: row.get(4)?,
                due_timing: row.get(5)?,
                zone: row.get(6)?,
                scheduled_on: row.get(7)?,
                done_at: row.get(8)?,
                repeats: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Two lists in due order, merged and cut to `limit`: each form's walk is already in order.
fn merged(mut first: Vec<TaskRow>, second: Vec<TaskRow>, limit: usize) -> Vec<TaskRow> {
    first.extend(second);
    first.sort_by(|a, b| (&a.due, &a.id).cmp(&(&b.due, &b.id)));
    first.truncate(limit);
    first
}

fn limit_of(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(i64::MAX)
}

/// The open tasks due before today, earliest first.
///
/// # Errors
/// Whatever SQLite refused.
pub fn overdue(connection: &Connection, day: &Day<'_>, limit: usize) -> Result<Vec<TaskRow>> {
    let n = limit_of(limit);
    Ok(merged(
        rows(connection, OVERDUE_ZONED, rusqlite::params![day.starts, n])?,
        rows(connection, OVERDUE_DAYS, rusqlite::params![day.today, n])?,
        limit,
    ))
}

/// Today: the open tasks due today, earliest first, then those the member planned for today that
/// are not due then (D3). The planned day and the due are two things: a task can be one, the
/// other or both.
///
/// # Errors
/// Whatever SQLite refused.
pub fn today(connection: &Connection, day: &Day<'_>, limit: usize) -> Result<Vec<TaskRow>> {
    let n = limit_of(limit);
    let mut list = merged(
        rows(
            connection,
            TODAY_ZONED,
            rusqlite::params![day.starts, day.ends, n],
        )?,
        rows(
            connection,
            TODAY_DAYS,
            rusqlite::params![day.today, day.tomorrow, n],
        )?,
        limit,
    );
    for planned in rows(connection, PLANNED, rusqlite::params![day.today, n])? {
        if list.len() >= limit {
            break;
        }
        if !list.iter().any(|row| row.id == planned.id) {
            list.push(planned);
        }
    }
    Ok(list)
}

/// The open tasks due after today, earliest first.
///
/// # Errors
/// Whatever SQLite refused.
pub fn upcoming(connection: &Connection, day: &Day<'_>, limit: usize) -> Result<Vec<TaskRow>> {
    let n = limit_of(limit);
    Ok(merged(
        rows(connection, UPCOMING_ZONED, rusqlite::params![day.ends, n])?,
        rows(
            connection,
            UPCOMING_DAYS,
            rusqlite::params![day.tomorrow, n],
        )?,
        limit,
    ))
}

/// The done tasks, latest first; `before` is the `done_at` the page before ended at (none: from
/// the latest).
///
/// # Errors
/// Whatever SQLite refused.
pub fn done(connection: &Connection, before: Option<&str>, limit: usize) -> Result<Vec<TaskRow>> {
    rows(
        connection,
        DONE,
        rusqlite::params![before.unwrap_or("9999"), limit_of(limit)],
    )
}

fn count(connection: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<u64> {
    let n: i64 = connection
        .prepare_cached(sql)?
        .query_row(params, |row| row.get(0))?;
    Ok(u64::try_from(n).unwrap_or_default())
}

impl Vault {
    /// How many open root tasks are overdue, due today, planned for today and starred, over the
    /// whole file. See the module for what is counted and what the caller adds.
    ///
    /// # Errors
    /// Whatever SQLite refused.
    pub fn open_task_counts(&self, day: &Day<'_>) -> Result<OpenTaskCounts> {
        self.read(|connection| {
            Ok(OpenTaskCounts {
                overdue: count(
                    connection,
                    COUNT_OVERDUE_ZONED,
                    rusqlite::params![day.starts],
                )? + count(connection, COUNT_OVERDUE_DAYS, rusqlite::params![day.today])?,
                today: count(
                    connection,
                    COUNT_TODAY_ZONED,
                    rusqlite::params![day.starts, day.ends],
                )? + count(
                    connection,
                    COUNT_TODAY_DAYS,
                    rusqlite::params![day.today, day.tomorrow],
                )?,
                planned: count(connection, COUNT_PLANNED, rusqlite::params![day.today])?,
                starred: count(connection, COUNT_STARRED, [])?,
            })
        })
    }
}
