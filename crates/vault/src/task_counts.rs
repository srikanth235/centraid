//! THE TRUE COUNTS OF OPEN TASKS (#1173): one aggregate, at any vault size.
//!
//! A board is a window, so a count taken over its rows says how many the window
//! held, not how many there are. The widgets say "12 due today" and the member
//! believes it, so the figure is counted in SQL over the whole table: one
//! statement over the open tasks, no row returned, `task_by_due (status, ...)`
//! leading it and the entity and the edge reached by their keys.
//!
//! **What is counted is what the board draws**: the open ROOTS of live tasks. A
//! subtask of an open, live parent belongs to its parent; an unfinished child
//! of a closed or trashed parent is a root of its own (the promotion rule,
//! `crates/apps/agenda`'s `board`).
//!
//! **What this statement cannot read is a repeating task's due.** Its effective
//! due is the next open period, which the one recurrence engine computes in
//! Rust, so a task with a `rule` is left out of `overdue` and `today` here and
//! counted by the caller; it is in `flagged`, which no due decides.
//!
//! **A stored due has three spellings** (`crates/apps/agenda`'s `local`):
//!
//! | Stored | Read as |
//! |---|---|
//! | `YYYY-MM-DD` | a civil date: the same day in every zone |
//! | `YYYY-MM-DDTHH:MM`, no designator | the member's wall clock: its own date |
//! | `...Z` or `...+HH:MM` | an instant: before or after the zone's midnights |
//!
//! The caller states the day and the two midnights (this one's and the next's)
//! as epoch seconds, so the zone arithmetic stays in Rust and the statement
//! only compares.

use crate::error::Result;
use crate::file::Vault;
use crate::model::Flag;

/// The day the counts are read against, in the member's zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CountDay<'a> {
    /// `YYYY-MM-DD`: today.
    pub today: &'a str,
    /// The instant today begins in the zone, in epoch seconds.
    pub starts_at: i64,
    /// The instant tomorrow begins in the zone, in epoch seconds.
    pub ends_at: i64,
}

/// What the statement counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OpenTaskCounts {
    /// Open roots with no repeat rule, due on a day before today.
    pub overdue: u64,
    /// Open roots with no repeat rule, due today.
    pub today: u64,
    /// Open roots carrying the Flag, repeating or not.
    pub flagged: u64,
}

/// The statement: `?1` today, `?2` the midnight today begins, `?3` the midnight
/// tomorrow begins, `?4` the Flag's id.
const OPEN_TASK_COUNTS: &str = "SELECT \
     count(*) FILTER (WHERE t.rule IS NULL AND t.due IS NOT NULL AND \
         CASE WHEN (length(t.due) > 10 AND substr(t.due, 11, 1) = 'T' \
                    AND (t.due LIKE '%Z' OR substr(t.due, 12) GLOB '*[+-]*')) \
              THEN CAST(strftime('%s', t.due) AS INTEGER) < ?2 \
              ELSE substr(t.due, 1, 10) < ?1 END), \
     count(*) FILTER (WHERE t.rule IS NULL AND t.due IS NOT NULL AND \
         CASE WHEN (length(t.due) > 10 AND substr(t.due, 11, 1) = 'T' \
                    AND (t.due LIKE '%Z' OR substr(t.due, 12) GLOB '*[+-]*')) \
              THEN CAST(strftime('%s', t.due) AS INTEGER) >= ?2 \
                   AND CAST(strftime('%s', t.due) AS INTEGER) < ?3 \
              ELSE substr(t.due, 1, 10) = ?1 END), \
     count(*) FILTER (WHERE EXISTS (SELECT 1 FROM edge f \
         WHERE f.from_id = t.id AND f.rel = 'tagged' AND f.to_id = ?4)) \
     FROM task t JOIN entity e ON e.id = t.id \
     WHERE t.status = 'open' AND e.deleted_at IS NULL \
       AND (t.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM task p JOIN entity pe ON pe.id = p.id \
            WHERE p.id = t.parent_id AND p.status = 'open' AND pe.deleted_at IS NULL))";

impl Vault {
    /// How many open root tasks are overdue, due today and flagged, over the
    /// whole file. See the module for what is counted and what the caller adds.
    ///
    /// # Errors
    /// Whatever SQLite refused.
    pub fn open_task_counts(&self, day: &CountDay<'_>) -> Result<OpenTaskCounts> {
        self.read(|connection| {
            Ok(connection.query_row(
                OPEN_TASK_COUNTS,
                rusqlite::params![day.today, day.starts_at, day.ends_at, Flag::Starred.id()],
                |row| {
                    let count = |at: usize| -> rusqlite::Result<u64> {
                        Ok(u64::try_from(row.get::<_, i64>(at)?).unwrap_or_default())
                    };
                    Ok(OpenTaskCounts {
                        overdue: count(0)?,
                        today: count(1)?,
                        flagged: count(2)?,
                    })
                },
            )?)
        })
    }
}
