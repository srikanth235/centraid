//! `task.*`: a task's own verbs, and the one place a task row is founded.
//!
//! A task is an entity of kind `task` whose state lives on its kind row. Where it sits is its home,
//! `entity.parent_id`, like every kind's (A19, C1): a project, a section of one, or a parent task
//! (`home_shape` says which). It is made in one (`parent_id` at create) and moved with the shared
//! `entity.move`. Who or what it is about is an `about` edge (a follow-up on Mum, a note's
//! checklist line); a tag, a star, an attachment and the trash are the shared verbs. What is here
//! is what only a task has: being added, edited, completed, reopened, cancelled and organised.
//!
//! ## One time vocabulary (A2, D1)
//!
//! A task's `due` is optional, and when it is there it is one of three things, which the row's
//! `due_timing` says (set exactly when `due` is): a **zoned** due is an instant
//! (`YYYY-MM-DDTHH:MM:SS.fffZ`, with the IANA `zone` it is read in, set exactly then), a
//! **floating** due is a wall clock to the minute (`2026-03-01T09:00`: the same hour wherever the
//! member is), an **all-day** due is a date. A command states a due in any spelling a phone has
//! ([`due_of`]): an instant with no zone takes the vault's, a wall clock with a zone is the instant
//! it is there, a wall clock without one is floating, a date is all-day.
//!
//! `scheduled_on` is another thing (D3): the day the member plans to do it, a bare date that is
//! neither a deadline nor an alert. The Today read ([`crate::task_counts::today`]) includes what is
//! planned for the day as well as what is due.
//!
//! ## An alert is a reminder row (D2)
//!
//! There is no lead column on a task. Each lead is a `reminder` row
//! ([`crate::commands::reminder`]), and `task.add` and `task.edit` take `reminders: [minutes]`:
//! stating it makes the task's leads exactly those, omitting it leaves them. A reminder counts
//! back from a due, so a task with none holds none: a sentence says so, and the database refuses a
//! reminder on a task without a due (and clearing the due takes the reminders with it).
//!
//! **What a task alerts with no word from the member** (the old rule, owner ruling 2026-11-18,
//! kept as rows so the member can remove them): a task made with a timed due (a zoned or floating
//! one) and no `reminders` gets a **0-minute lead**, an alert at its time; an all-day due or none
//! gets none (a day has no moment). A task given its first timed due by an edit, and holding no
//! reminder, gets the same 0-minute lead. Nothing else is defaulted.
//!
//! ## Completion is one operation
//!
//! [`complete`] is the only thing that closes a task as done, whoever asks (Tasks' check box,
//! People's follow-up, an automation, an import). It is a named, idempotent operation and never a
//! toggle, because a toggle's outcome depends on a state the caller did not read, and which screen
//! the member was looking at would decide whether a repeating task got its next occurrence.
//!
//! A repeating task has a **series** (D4): `series_id`, a UUIDv7 minted when the rule is first set
//! (at create or by an edit) that points at no row, so purging the first task never cuts the
//! series. Every occurrence after it copies the id and keeps its own row. The successor of a
//! completed occurrence is a new open task one step on, and it **inherits what belongs to the
//! series**: its home, rule, zone, leads (reminder rows), star, and the `about` and `tagged`
//! edges, so the successor of "call Mum" is still about Mum and still tagged. Cancelling ends the
//! occurrence and spawns nothing.
//!
//! ## A snooze moves the alert, not the due (#1188, NA5)
//!
//! `snoozed_until` is the instant the member asked to be reminded again. While it is set it is the
//! task's one alert (on its smallest lead, [`crate::alerts`]); an edit of the due, the leads or the
//! rule that states no snooze of its own ends it, and so does finishing.
//!
//! ## Priority is not iCalendar's
//!
//! `0` is unset and a higher number is more urgent (Todoist's scale, and the board's order); the
//! column's CHECK is the only range.
//!
//! ## Followed
//!
//! The phone's Reminders are a followed store ([`PHONE_REMINDERS`]): each reminder is a task in
//! the project the origin fills, and the member's own edit of a field stands.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json, json};

use crate::commands::entity::{self, STALE_GUARD, find, home_refusal, lookup_live, with_rev};
use crate::commands::follow::{Child, Gone, Match, OriginRow, SystemMap};
use crate::commands::reminder::{self, MAX_OFFSET_MIN};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, deserialize_patch,
};
use crate::error::{Result, VaultError};
use crate::model::Kind;
use crate::time::recurrence::{
    ExpandInput, NextOccurrenceInput, RecurrenceAnchor, Semantics, expand, next_occurrence,
    parse_instant_ms,
};
use crate::time::zone::{FireZone, add_wall_days, parse_wall_iso, wall_epoch, wall_iso};
use crate::time::{rrule, temporal};

/// The vocabulary of `task.status`, held equal to the CHECK by a test.
pub const STATUSES: [&str; 3] = ["open", "done", "cancelled"];

/// The vocabulary of `task.anchor`, held equal to the CHECK by a test.
pub const ANCHORS: [RecurrenceAnchor; 2] =
    [RecurrenceAnchor::Scheduled, RecurrenceAnchor::Completion];

/// The vocabulary of `task.due_timing`, held equal to the CHECK by a test.
pub const TIMINGS: [&str; 3] = ["zoned", "floating", "all-day"];

/// The most leads one task is given in a command: a size budget, kept here and not in a CHECK.
pub const MAX_REMINDERS: usize = 20;

/// How far ahead a floating repeat looks for its next occurrence, in days.
const FLOATING_HORIZON_DAYS: i64 = 5 * 366;

// ---------------------------------------------------------------------------
// A due, in the one vocabulary
// ---------------------------------------------------------------------------

/// A task's due as its columns hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    /// The instant, wall clock or date.
    pub at: String,
    /// One of [`TIMINGS`].
    pub timing: &'static str,
    /// The zone a zoned due is read in; none otherwise.
    pub zone: Option<String>,
}

impl Due {
    /// Whether the due is a moment of the day (a zoned or floating one) and so alerts at its time
    /// by default; a day is not.
    #[must_use]
    pub fn is_timed(&self) -> bool {
        self.timing != "all-day"
    }
}

/// The vault's own zone, when it has one.
fn vault_zone(connection: &Connection) -> Result<Option<String>> {
    Ok(connection
        .query_row("SELECT zone FROM vault", [], |row| row.get(0))
        .optional()?
        .flatten())
}

/// The zone a name says, or the sentence for why it says none.
fn zone_named(name: &str) -> std::result::Result<FireZone, String> {
    FireZone::named(name).map_err(|_| format!("“{name}” is not a time zone this vault knows"))
}

/// A due as a command states it, in the form its columns hold, or the sentence for why not.
///
/// `zone` is the zone the command names; `kept` is the zone the task already has, which a new
/// instant keeps when the command names none, and failing both the vault's own and then UTC.
///
/// # Errors
/// SQLite's refusal.
pub fn due_of(
    connection: &Connection,
    text: &str,
    zone: Option<&str>,
    kept: Option<&str>,
) -> Result<std::result::Result<Due, String>> {
    let readings = [
        temporal::Kind::Instant,
        temporal::Kind::FloatingDateTime,
        temporal::Kind::LocalDate,
    ];
    let named = match zone {
        Some(name) => match zone_named(name) {
            Ok(zone) => Some(zone),
            Err(sentence) => return Ok(Err(sentence)),
        },
        None => None,
    };
    Ok(match temporal::classify(text) {
        Some(temporal::Kind::LocalDate) => {
            if zone.is_some() {
                Err("a day has no zone: a zone goes with a due that is a moment".to_owned())
            } else {
                Ok(Due {
                    at: text.to_owned(),
                    timing: "all-day",
                    zone: None,
                })
            }
        }
        Some(temporal::Kind::FloatingDateTime) => {
            let Some(minute) = temporal::floating_minute(text) else {
                return Ok(Err(format!(
                    "due: {text:?} has seconds, and a floating time is to the minute \
                     (2026-03-01T09:00)"
                )));
            };
            match named {
                // A wall clock in a named zone is the instant it is there.
                Some(zone) => {
                    let wall = parse_wall_iso(&minute).ok_or_else(|| VaultError::Invariant {
                        context: format!("`{minute}` classified as a wall clock and did not parse"),
                    })?;
                    Ok(Due {
                        at: zone.resolve_wall_time_forward(wall).instant,
                        timing: "zoned",
                        zone: Some(zone.name().to_owned()),
                    })
                }
                None => Ok(Due {
                    at: minute,
                    timing: "floating",
                    zone: None,
                }),
            }
        }
        Some(temporal::Kind::Instant) => {
            let zone = match named {
                Some(zone) => zone.name().to_owned(),
                None => match kept {
                    Some(kept) => kept.to_owned(),
                    None => vault_zone(connection)?.unwrap_or_else(|| "Etc/UTC".to_owned()),
                },
            };
            Ok(Due {
                at: temporal::canonical(text),
                timing: "zoned",
                zone: Some(zone),
            })
        }
        _ => Err(temporal::refusal("due", text, &readings)),
    })
}

/// The leads a stated list names, each once, smallest first; or the sentence for why not.
fn leads_of(value: &Json) -> std::result::Result<Vec<i64>, String> {
    let sentence = || "a reminder comes 0 minutes to a year before, not after".to_owned();
    let list = value.as_array().ok_or_else(sentence)?;
    let mut leads = Vec::with_capacity(list.len());
    for item in list {
        let minutes = item
            .as_i64()
            .filter(|minutes| (0..=MAX_OFFSET_MIN).contains(minutes))
            .ok_or_else(sentence)?;
        leads.push(minutes);
    }
    leads.sort_unstable();
    leads.dedup();
    Ok(leads)
}

/// The leads a task is given when the member states none: a timed due alerts at its time.
fn default_leads(due: Option<&Due>) -> Vec<i64> {
    match due {
        Some(due) if due.is_timed() => vec![0],
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Founding
// ---------------------------------------------------------------------------

/// What a new task is told: the rest of its row takes the column defaults (open, unprioritised,
/// no rule, last in its place).
#[derive(Default)]
pub struct NewTask<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    /// A day, a wall clock, or an instant ([`due_of`]).
    pub due: Option<&'a str>,
    /// The zone a wall clock is read in, or a zoned due keeps.
    pub zone: Option<&'a str>,
    pub description: Option<&'a str>,
    pub priority: Option<i64>,
    pub effort_min: Option<i64>,
    pub rule: Option<&'a str>,
    pub anchor: Option<&'a str>,
    /// Its home: a project, a section or a parent task; none: the top level.
    pub parent: Option<&'a str>,
    pub position: Option<f64>,
    /// A link the task points at.
    pub url: Option<&'a str>,
    /// The day the member plans it.
    pub scheduled_on: Option<&'a str>,
    /// Closed as done at this instant: an import of an item already completed. `None` is open.
    pub done_at: Option<&'a str>,
    /// Its leads, minutes before the due; `None` takes the default (see the module).
    pub reminders: Option<&'a [i64]>,
}

/// Found a task: the entity in its home, the kind row, its series when it repeats and its
/// reminders. Returns its id. The one place a task is born, so a command of another app that
/// writes a task (an import, a person's follow-up) founds it the same way.
///
/// # Errors
/// [`VaultError::InvalidInput`] with the sentence of why the due or the leads are not allowed (the
/// commands refuse these first), or SQLite's refusal.
pub fn found(ctx: &CommandCtx<'_, '_>, task: &NewTask<'_>) -> Result<String> {
    let title = task.title.trim();
    let id = match task.id {
        Some(id) => {
            ctx.insert_entity_in(id, Kind::Task, title, task.parent)?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(Kind::Task, title, task.parent)?,
    };
    let invalid = |name: &str, detail: String| VaultError::InvalidInput {
        name: name.to_owned(),
        detail,
    };
    let due = match task.due {
        Some(text) => Some(
            due_of(ctx.connection(), text, task.zone, None)?
                .map_err(|sentence| invalid("due", sentence))?,
        ),
        None => None,
    };
    let rule = task.rule.map(rrule::canonicalize);
    let series = rule.as_ref().map(|_| ctx.next_id());
    // Last in its place by default: the clock's second as the position, so no scan of the tasks
    // already there is read, and a member's own ordering (any REAL between two) still fits.
    let position = task.position.unwrap_or_else(|| {
        parse_instant_ms(&ctx.now).map_or(0.0, |millis| (millis / 1_000) as f64)
    });
    let done_at = task.done_at.map(temporal::canonical);
    ctx.connection().execute(
        "INSERT INTO task (id, due, due_timing, zone, scheduled_on, description, priority,
                           effort_min, rule, anchor, series_id, position, url, status, done_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 0), ?8, ?9, COALESCE(?10, 'scheduled'),
                 ?11, ?12, ?13, CASE WHEN ?14 IS NULL THEN 'open' ELSE 'done' END, ?14)",
        rusqlite::params![
            id,
            due.as_ref().map(|d| d.at.as_str()),
            due.as_ref().map(|d| d.timing),
            due.as_ref().and_then(|d| d.zone.as_deref()),
            task.scheduled_on,
            task.description,
            task.priority,
            task.effort_min,
            rule,
            task.anchor,
            series,
            position,
            task.url.map(str::trim),
            done_at,
        ],
    )?;
    let leads = match (task.reminders, &done_at) {
        (Some(stated), _) => stated.to_vec(),
        // A task founded done alerts nothing.
        (None, Some(_)) => Vec::new(),
        (None, None) => default_leads(due.as_ref()),
    };
    if !leads.is_empty() {
        reminder::set_leads(ctx, &id, &leads)?;
    }
    Ok(id)
}

// ---------------------------------------------------------------------------
// What a task is, and what it will be
// ---------------------------------------------------------------------------

/// The columns an edit reads of a task as it stands.
struct Held {
    status: String,
    due: Option<String>,
    timing: Option<String>,
    zone: Option<String>,
    rule: Option<String>,
    anchor: String,
    series_id: Option<String>,
    scheduled_on: Option<String>,
    priority: i64,
    effort_min: Option<i64>,
    description: Option<String>,
    url: Option<String>,
    snoozed_until: Option<String>,
}

fn held(connection: &Connection, id: &str) -> Result<Option<Held>> {
    Ok(connection
        .query_row(
            "SELECT status, due, due_timing, zone, rule, anchor, series_id, scheduled_on, priority,
                    effort_min, description, url, snoozed_until
               FROM task WHERE id = ?1",
            [id],
            |row| {
                Ok(Held {
                    status: row.get(0)?,
                    due: row.get(1)?,
                    timing: row.get(2)?,
                    zone: row.get(3)?,
                    rule: row.get(4)?,
                    anchor: row.get(5)?,
                    series_id: row.get(6)?,
                    scheduled_on: row.get(7)?,
                    priority: row.get(8)?,
                    effort_min: row.get(9)?,
                    description: row.get(10)?,
                    url: row.get(11)?,
                    snoozed_until: row.get(12)?,
                })
            },
        )
        .optional()?)
}

impl Held {
    fn due(&self) -> Option<Due> {
        let (at, timing) = (self.due.clone()?, self.timing.as_deref()?);
        Some(Due {
            at,
            timing: TIMINGS.iter().find(|known| **known == timing).copied()?,
            zone: self.zone.clone(),
        })
    }
}

/// A stated string: `Some(Some)` sets it, `Some(None)` clears it (`null`), and `None` says
/// nothing.
fn stated(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<Option<String>> {
    ctx.input
        .get(key)
        .map(|value| value.as_str().map(str::to_owned))
}

/// The due the task will have after the command: the stated one (with the zone stated or kept),
/// the held one with a new zone, or the held one. The sentence says why that is not allowed.
fn resulting_due(
    ctx: &CommandCtx<'_, '_>,
    held: Option<&Held>,
) -> Result<std::result::Result<Option<Due>, String>> {
    let zone = stated(ctx, "zone");
    let kept = held.and_then(|held| held.zone.as_deref());
    match stated(ctx, "due") {
        Some(None) => Ok(if matches!(zone, Some(Some(_))) {
            Err("a zone goes with a due that is a moment, and this task will have none".to_owned())
        } else {
            Ok(None)
        }),
        Some(Some(text)) => {
            let named = zone.as_ref().and_then(|zone| zone.as_deref());
            Ok(due_of(ctx.connection(), &text, named, kept)?.map(Some))
        }
        None => {
            let Some(due) = held.and_then(Held::due) else {
                return Ok(if matches!(zone, Some(Some(_))) {
                    Err(
                        "a zone goes with a due that is a moment, and this task has none"
                            .to_owned(),
                    )
                } else {
                    Ok(None)
                });
            };
            match zone {
                None => Ok(Ok(Some(due))),
                Some(None) if due.timing == "zoned" => {
                    Ok(Err("a due that is a moment is read in a zone".to_owned()))
                }
                Some(Some(_) | None) if due.timing != "zoned" => Ok(Err(
                    "only a due that is a moment has a zone; this one is a day or a wall clock"
                        .to_owned(),
                )),
                Some(name) => Ok(zone_named(name.as_deref().unwrap_or_default()).map(|zone| {
                    Some(Due {
                        zone: Some(zone.name().to_owned()),
                        ..due
                    })
                })),
            }
        }
    }
}

/// A sentence when `day` is not a calendar date.
fn day_refusal(connection: &Connection, key: &str, day: Option<&str>) -> Result<Option<String>> {
    let Some(day) = day else { return Ok(None) };
    let valid: bool = connection.query_row("SELECT date(?1) IS ?1", [day], |row| row.get(0))?;
    Ok((!valid).then(|| format!("{key}: “{day}” is not a day; write it as 2026-03-01")))
}

/// The sentence a member reads when the task, as it would be, is not allowed.
fn model_refusal(ctx: &CommandCtx<'_, '_>, held: Option<&Held>) -> Result<Option<String>> {
    let due = match resulting_due(ctx, held)? {
        Ok(due) => due,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let rule_stated = stated(ctx, "rule");
    if let Some(Some(rule)) = &rule_stated
        && let Err(why) = rrule::inspect(rule)
    {
        return Ok(Some(format!("{rule}: {}", why.message())));
    }
    let rule = match rule_stated {
        Some(rule) => rule,
        None => held.and_then(|held| held.rule.clone()),
    };
    if rule.is_some() && due.is_none() {
        return Ok(Some(
            "A repeating task needs a due date to repeat from.".to_owned(),
        ));
    }
    if let Some(list) = ctx.input.get("reminders").filter(|value| !value.is_null()) {
        let leads = match leads_of(list) {
            Ok(leads) => leads,
            Err(sentence) => return Ok(Some(sentence)),
        };
        if !leads.is_empty() && due.is_none() {
            return Ok(Some(
                "A reminder needs a due date to count back from.".to_owned(),
            ));
        }
    }
    if let Some(day) = ctx.optional_str("scheduled_on")
        && let Some(sentence) = day_refusal(ctx.connection(), "scheduled_on", Some(day))?
    {
        return Ok(Some(sentence));
    }
    if let Some(Some(until)) = stated(ctx, "snoozed_until") {
        if !matches!(temporal::classify(&until), Some(temporal::Kind::Instant)) {
            return Ok(Some(temporal::refusal(
                "snoozed_until",
                &until,
                &[temporal::Kind::Instant],
            )));
        }
        if held.is_some_and(|held| held.status != "open") {
            return Ok(Some("Only an open task can be snoozed.".to_owned()));
        }
    }
    Ok(None)
}

fn live_task(ctx: &CommandCtx<'_, '_>) -> Result<std::result::Result<(), String>> {
    Ok(
        match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
            Err(sentence) => Err(sentence),
            Ok(found) if found.kind != Kind::Task => Err(format!(
                "“{}” is a {}, not a task",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => Ok(()),
        },
    )
}

/// A link, when one is stated, says something: a blank one is cleared with `null`, not kept.
fn url_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.optional_str("url")
        .filter(|url| url.trim().is_empty())
        .map(|_| "a link needs an address; clear it instead".to_owned())
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a task needs a title".to_owned()));
    }
    if let Some(sentence) = url_refusal(ctx) {
        return Ok(Some(sentence));
    }
    if let Some(done_at) = ctx.optional_str("done_at")
        && !matches!(temporal::classify(done_at), Some(temporal::Kind::Instant))
    {
        return Ok(Some(temporal::refusal(
            "done_at",
            done_at,
            &[temporal::Kind::Instant],
        )));
    }
    if let Some(id) = ctx.optional_str("id")
        && find(ctx.connection(), id)?.is_some()
    {
        return Ok(Some("a task with that id already exists".to_owned()));
    }
    if let Some(sentence) = home_refusal(
        ctx.connection(),
        Kind::Task,
        None,
        ctx.optional_str("parent_id"),
    )? {
        return Ok(Some(sentence));
    }
    model_refusal(ctx, None)
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_task(ctx)? {
        return Ok(Some(sentence));
    }
    if ctx.input.get("title").is_some() && ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a task needs a title".to_owned()));
    }
    if let Some(sentence) = url_refusal(ctx) {
        return Ok(Some(sentence));
    }
    let held = held(ctx.connection(), ctx.required_str("id")?)?;
    model_refusal(ctx, held.as_ref())
}

fn pre_live(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    live_task(ctx).map(std::result::Result::err)
}

fn pre_organize(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_task(ctx)? {
        return Ok(Some(sentence));
    }
    let held = held(ctx.connection(), ctx.required_str("id")?)?;
    model_refusal(ctx, held.as_ref())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct AddTaskInput {
    id: Option<String>,
    title: String,
    due: Option<String>,
    zone: Option<String>,
    description: Option<String>,
    priority: Option<i64>,
    effort_min: Option<i64>,
    rule: Option<String>,
    anchor: Option<String>,
    parent_id: Option<String>,
    position: Option<f64>,
    url: Option<String>,
    scheduled_on: Option<String>,
    done_at: Option<String>,
    reminders: Option<Vec<i64>>,
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddTaskInput = ctx.parse_input()?;
    let leads = input.reminders.as_deref().map(|leads| {
        let mut leads = leads.to_vec();
        leads.sort_unstable();
        leads.dedup();
        leads
    });
    let id = found(
        ctx,
        &NewTask {
            id: input.id.as_deref(),
            title: &input.title,
            due: input.due.as_deref(),
            zone: input.zone.as_deref(),
            description: input.description.as_deref(),
            priority: input.priority,
            effort_min: input.effort_min,
            rule: input.rule.as_deref(),
            anchor: input.anchor.as_deref(),
            parent: input.parent_id.as_deref(),
            position: input.position,
            url: input.url.as_deref(),
            scheduled_on: input.scheduled_on.as_deref(),
            done_at: input.done_at.as_deref(),
            reminders: leads.as_deref(),
        },
    )?;
    Ok(json!({ "id": id }))
}

#[derive(serde::Deserialize)]
struct EditTaskInput {
    id: String,
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    due: Option<Option<String>>,
    priority: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    effort_min: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    rule: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    scheduled_on: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    snoozed_until: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    url: Option<Option<String>>,
    reminders: Option<Vec<i64>>,
}

/// The columns an edit changes, written in ONE statement: the table's CHECKs judge the row after
/// the statement, so a due and the rule that needs it are never seen half-written.
#[derive(Default)]
struct Sets(Vec<(&'static str, Sql)>);

impl Sets {
    fn change<T: PartialEq + Clone + Into<Sql>>(&mut self, column: &'static str, was: &T, now: T) {
        if *was != now {
            self.0.push((column, now.into()));
        }
    }

    /// Write them; whether any changed.
    fn apply(self, ctx: &CommandCtx<'_, '_>, id: &str) -> Result<bool> {
        if self.0.is_empty() {
            return Ok(false);
        }
        let sets = self
            .0
            .iter()
            .enumerate()
            .map(|(index, (column, _))| format!("{column} = ?{}", index + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let mut values: Vec<Sql> = vec![id.to_owned().into()];
        values.extend(self.0.into_iter().map(|(_, value)| value));
        ctx.connection().execute(
            &format!("UPDATE task SET {sets} WHERE id = ?1"),
            rusqlite::params_from_iter(values),
        )?;
        Ok(true)
    }
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditTaskInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let was = held(connection, &input.id)?.ok_or_else(|| VaultError::Invariant {
        context: format!(
            "`{}` is not a task, and a precondition said it was",
            input.id
        ),
    })?;
    let due = resulting_due(ctx, Some(&was))?.map_err(|sentence| VaultError::InvalidInput {
        name: "due".to_owned(),
        detail: sentence,
    })?;
    let mut sets = Sets::default();
    sets.change("due", &was.due, due.as_ref().map(|due| due.at.clone()));
    sets.change(
        "due_timing",
        &was.timing,
        due.as_ref().map(|due| due.timing.to_owned()),
    );
    sets.change(
        "zone",
        &was.zone,
        due.as_ref().and_then(|due| due.zone.clone()),
    );
    let rule = match &input.rule {
        Some(rule) => rule.as_deref().map(rrule::canonicalize),
        None => was.rule.clone(),
    };
    sets.change("rule", &was.rule, rule.clone());
    // The series begins when the rule is first set, and the identity is minted once and then
    // never moves (a cleared rule keeps it: the task was in that series).
    if rule.is_some() && was.series_id.is_none() {
        sets.change("series_id", &was.series_id, Some(ctx.next_id()));
    }
    if let Some(description) = &input.description {
        sets.change("description", &was.description, description.clone());
    }
    if let Some(priority) = input.priority {
        sets.change("priority", &was.priority, priority);
    }
    if let Some(effort) = input.effort_min {
        sets.change("effort_min", &was.effort_min, effort);
    }
    if let Some(day) = &input.scheduled_on {
        sets.change("scheduled_on", &was.scheduled_on, day.clone());
    }
    if let Some(url) = &input.url {
        sets.change(
            "url",
            &was.url,
            url.as_deref().map(|url| url.trim().to_owned()),
        );
    }
    // A SNOOZE BELONGS TO THE DUE, THE LEADS AND THE RULE IT WAS SET AGAINST (#1188, NA5): an
    // edit of any of them that does not state a snooze of its own ends it.
    let snooze = match &input.snoozed_until {
        Some(until) => until.as_deref().map(temporal::canonical),
        None if input.due.is_some() || input.reminders.is_some() || input.rule.is_some() => None,
        None => was.snoozed_until.clone(),
    };
    sets.change("snoozed_until", &was.snoozed_until, snooze);
    let mut changed = sets.apply(ctx, &input.id)?;
    if let Some(title) = input.title.as_deref() {
        changed |= entity::rename(ctx, &input.id, title.trim())?;
    }
    if let Some(leads) = &input.reminders {
        changed |= reminder::set_leads(ctx, &input.id, leads)?;
    } else if due.as_ref().is_some_and(Due::is_timed)
        && !was.due().as_ref().is_some_and(Due::is_timed)
        && reminder::list(connection, &input.id)?.is_empty()
    {
        // A task given its first moment alerts at it, as one made with a moment does.
        changed |= reminder::set_leads(ctx, &input.id, &default_leads(due.as_ref()))?;
    }
    if changed {
        ctx.touch(&input.id)?;
    }
    with_rev(ctx, &input.id, json!({ "id": input.id }))
}

#[derive(serde::Deserialize)]
struct OrganizeTaskInput {
    id: String,
    position: Option<f64>,
    anchor: Option<String>,
}

/// Order a task and say how its repeat is measured: its place among its neighbours, the anchor of
/// its repeat and the zone its moment is read in. Where it is filed is `entity.move`'s.
fn organize(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: OrganizeTaskInput = ctx.parse_input()?;
    let was = held(ctx.connection(), &input.id)?.ok_or_else(|| VaultError::Invariant {
        context: format!(
            "`{}` is not a task, and a precondition said it was",
            input.id
        ),
    })?;
    let due = resulting_due(ctx, Some(&was))?.map_err(|sentence| VaultError::InvalidInput {
        name: "zone".to_owned(),
        detail: sentence,
    })?;
    let mut sets = Sets::default();
    sets.change("zone", &was.zone, due.and_then(|due| due.zone));
    if let Some(anchor) = input.anchor {
        sets.change("anchor", &was.anchor, anchor);
    }
    let mut changed = sets.apply(ctx, &input.id)?;
    if let Some(position) = input.position {
        changed |= ctx.connection().execute(
            "UPDATE task SET position = ?2 WHERE id = ?1 AND position <> ?2",
            rusqlite::params![input.id, position],
        )? > 0;
    }
    if changed {
        ctx.touch(&input.id)?;
    }
    with_rev(ctx, &input.id, json!({ "id": input.id }))
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/// What closing a task as done did.
pub struct Completion {
    pub id: String,
    /// The series the task belongs to, when it repeats.
    pub series_id: Option<String>,
    /// The next occurrence, when there is one.
    pub next_id: Option<String>,
    pub next_due: Option<String>,
}

/// The zone a task's repeat rolls over in: its own, else the vault's, else UTC.
fn zone_of(connection: &Connection, task: Option<&str>) -> Option<FireZone> {
    let vault = vault_zone(connection).ok().flatten();
    FireZone::resolve(task, vault.as_deref())
        .or_else(|_| FireZone::named("Etc/UTC"))
        .ok()
}

/// The due one step on, in the form the task's due has, or none when the series has run out.
fn next_due(
    connection: &Connection,
    rule: &str,
    due: &Due,
    anchor: RecurrenceAnchor,
    now: &str,
) -> Option<String> {
    let zone = zone_of(connection, due.zone.as_deref());
    let from_completion = anchor == RecurrenceAnchor::Completion;
    if due.timing != "floating" {
        let found = next_occurrence(&NextOccurrenceInput {
            rrule: rule,
            scheduled_start: &due.at,
            after: if from_completion { now } else { &due.at },
            zone: zone.as_ref(),
            anchor,
        })?;
        return Some(temporal::canonical(&found));
    }
    // A wall clock repeats on the wall clock, never through a zone.
    let after = if from_completion {
        let wall = zone.as_ref()?.zoned_parts(parse_instant_ms(now)?);
        wall_iso(wall, true)
    } else {
        due.at.clone()
    };
    let after_wall = parse_wall_iso(&after)?;
    let horizon = wall_iso(add_wall_days(after_wall, FLOATING_HORIZON_DAYS), true);
    let start = if from_completion { &after } else { &due.at };
    let found = expand(
        &ExpandInput::new(rule, start, &after, &horizon)
            .with_semantics(Semantics::Floating)
            .at_most(4_000),
    )
    .into_iter()
    .find(|occurrence| {
        parse_wall_iso(&occurrence.start)
            .is_some_and(|wall| wall_epoch(wall) > wall_epoch(after_wall))
    })?;
    temporal::floating_minute(&found.start)
}

/// Complete a task, once. Completing a task already done answers the same and never spawns a
/// second successor.
///
/// # Errors
///
/// A task that is not there, or a database error.
pub fn complete(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Completion> {
    let connection = ctx.connection();
    let task = held(connection, id)?.ok_or_else(|| VaultError::Invariant {
        context: format!("`{id}` is not a task, and a precondition said it was"),
    })?;
    // A repeating task whose series was never named (a followed one, whose rule a phone wrote)
    // begins it now.
    let series = match (&task.series_id, &task.rule) {
        (Some(series), _) => Some(series.clone()),
        (None, Some(_)) => Some(ctx.next_id()),
        (None, None) => None,
    };
    let mut done = Completion {
        id: id.to_owned(),
        series_id: series.clone(),
        next_id: None,
        next_due: None,
    };
    if task.status == "done" {
        return Ok(done);
    }
    connection.execute(
        "UPDATE task SET status = 'done', done_at = ?2, snoozed_until = NULL, series_id = ?3
          WHERE id = ?1",
        rusqlite::params![id, ctx.now, series],
    )?;
    ctx.touch(id)?;
    let (Some(rule), Some(due)) = (task.rule.as_deref(), task.due()) else {
        return Ok(done);
    };
    let anchor = RecurrenceAnchor::from_stored(Some(&task.anchor));
    let Some(next_due) = next_due(connection, rule, &due, anchor, &ctx.now) else {
        // A series that has run out stops here.
        return Ok(done);
    };
    let (title, home): (String, Option<String>) = connection.query_row(
        "SELECT title, parent_id FROM entity WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let next = ctx.insert_entity_under(Kind::Task, &title, home.as_deref())?;
    connection.execute(
        "INSERT INTO task (id, status, priority, due, due_timing, zone, rule, anchor, series_id,
                           effort_min, description, position, url)
         SELECT ?2, 'open', priority, ?3, due_timing, zone, rule, anchor, ?4, effort_min,
                description, position, url
           FROM task WHERE id = ?1",
        rusqlite::params![id, next, next_due, series],
    )?;
    connection.execute(
        "UPDATE entity SET starred_at = (SELECT starred_at FROM entity WHERE id = ?1) WHERE id = ?2",
        [id, next.as_str()],
    )?;
    connection.execute(
        "INSERT INTO edge (from_id, rel, to_id, label_id, position, anchor, created_at)
         SELECT ?2, rel, to_id, label_id, position, anchor, ?3 FROM edge
          WHERE from_id = ?1 AND rel IN ('about', 'tagged')",
        rusqlite::params![id, next, ctx.now],
    )?;
    let leads: Vec<i64> = reminder::list(connection, id)?
        .into_iter()
        .filter(|row| row.date_id.is_none() && row.field_id.is_none())
        .map(|row| row.offset_min)
        .collect();
    if !leads.is_empty() {
        reminder::set_leads(ctx, &next, &leads)?;
    }
    done.next_id = Some(next);
    done.next_due = Some(next_due);
    Ok(done)
}

#[derive(serde::Deserialize)]
struct TaskIdInput {
    id: String,
}

fn complete_command(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: TaskIdInput = ctx.parse_input()?;
    let done = complete(ctx, &input.id)?;
    Ok(json!({
        "id": done.id,
        "status": "done",
        "series_id": done.series_id,
        "next_id": done.next_id,
        "next_due": done.next_due,
    }))
}

/// Close or reopen a task without a successor: cancelling ends the occurrence, reopening makes a
/// closed one open again. Both are idempotent. A snooze ends with the task being open.
fn settle(ctx: &CommandCtx<'_, '_>, status: &str) -> Result<Json> {
    let input: TaskIdInput = ctx.parse_input()?;
    let changed = ctx.connection().execute(
        "UPDATE task SET status = ?2, done_at = NULL, snoozed_until = NULL
          WHERE id = ?1 AND status <> ?2",
        [input.id.as_str(), status],
    )?;
    if changed > 0 {
        ctx.touch(&input.id)?;
    }
    Ok(json!({ "id": input.id, "status": status }))
}

fn reopen(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    settle(ctx, "open")
}

fn cancel(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    settle(ctx, "cancelled")
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const ADD_SCHEMA: &str = r#"{
  "type": "object", "required": ["title"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "due": { "type": ["string", "null"], "description": "A day, a wall clock to the minute or an instant." },
    "zone": { "type": ["string", "null"], "description": "The zone a moment is read in (an IANA name)." },
    "scheduled_on": { "type": ["string", "null"], "description": "The day the member plans to do it." },
    "priority": { "type": "integer", "minimum": 0, "maximum": 9 },
    "effort_min": { "type": ["integer", "null"], "minimum": 1 },
    "reminders": { "type": "array", "maxItems": 20, "items": { "type": "integer", "minimum": 0, "maximum": 525600 },
      "description": "Minutes before the due, each once. Omitted: a timed due alerts at its time." },
    "rule": { "type": ["string", "null"], "description": "An RFC 5545 recurrence rule." },
    "anchor": { "type": "string", "enum": ["scheduled", "completion"] },
    "parent_id": { "type": ["string", "null"], "description": "Its home: a project, a section or a parent task." },
    "position": { "type": "number" },
    "url": { "type": ["string", "null"], "maxLength": 2048, "description": "A link the task points at." },
    "done_at": { "type": ["string", "null"], "description": "Founds the task already done, at this instant (an import of a completed item)." }
  }
}"#;

const EDIT_SCHEMA: &str = r#"{
  "type": "object", "required": ["id"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "due": { "type": ["string", "null"] },
    "zone": { "type": ["string", "null"] },
    "scheduled_on": { "type": ["string", "null"] },
    "priority": { "type": "integer", "minimum": 0, "maximum": 9 },
    "effort_min": { "type": ["integer", "null"], "minimum": 1 },
    "reminders": { "type": "array", "maxItems": 20, "items": { "type": "integer", "minimum": 0, "maximum": 525600 },
      "description": "States the task's leads: exactly these. Omitted: they stay." },
    "rule": { "type": ["string", "null"] },
    "snoozed_until": { "type": ["string", "null"], "description": "A UTC instant: the reminder sounds again then, the due unmoved." },
    "url": { "type": ["string", "null"], "maxLength": 2048 },
    "expected_rev": { "type": "integer", "minimum": 0 }
  }
}"#;

const ORGANIZE_SCHEMA: &str = r#"{
  "type": "object", "required": ["id"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "position": { "type": "number" },
    "anchor": { "type": "string", "enum": ["scheduled", "completion"] },
    "zone": { "type": ["string", "null"] },
    "expected_rev": { "type": "integer", "minimum": 0 }
  }
}"#;

const BY_ID: &str = r#"{ "type": "object", "required": ["id"], "additionalProperties": false,
  "properties": { "id": { "type": "string", "minLength": 1 } } }"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "task_has_a_title_a_home_and_a_model_that_holds",
        check: pre_add,
    }];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "task_is_live_and_a_model_that_holds",
            check: pre_edit,
        },
    ];
    const ORGANIZE: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "task_is_live_and_a_zone_that_holds",
            check: pre_organize,
        },
    ];
    const LIVE: &[CommandCondition] = &[CommandCondition {
        predicate: "task_is_live",
        check: pre_live,
    }];
    vec![
        CommandDefinition::plain("task.add", "task", ADD_SCHEMA, Idempotency::Once, ADD, add),
        CommandDefinition::plain(
            "task.edit",
            "task",
            EDIT_SCHEMA,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "task.organize",
            "task",
            ORGANIZE_SCHEMA,
            Idempotency::Idempotent,
            ORGANIZE,
            organize,
        ),
        CommandDefinition::plain(
            "task.complete",
            "task",
            BY_ID,
            Idempotency::Idempotent,
            LIVE,
            complete_command,
        ),
        CommandDefinition::plain(
            "task.reopen",
            "task",
            BY_ID,
            Idempotency::Idempotent,
            LIVE,
            reopen,
        ),
        CommandDefinition::plain(
            "task.cancel",
            "task",
            BY_ID,
            Idempotency::Idempotent,
            LIVE,
            cancel,
        ),
    ]
}

// ---------------------------------------------------------------------------
// The phone's Reminders, followed
// ---------------------------------------------------------------------------

/// The leads a statement of reminders names, each once, smallest first; no reminder is `null`.
fn canon_reminders(statement: &Json) -> Json {
    let list = match statement {
        Json::String(text) => serde_json::from_str::<Json>(text).unwrap_or(Json::Null),
        other => other.clone(),
    };
    match leads_of(&list) {
        Ok(leads) if !leads.is_empty() => json!(leads),
        Ok(_) => Json::Null,
        Err(_) => statement.clone(),
    }
}

fn leads_stated(statement: &Json) -> Vec<i64> {
    match canon_reminders(statement) {
        Json::Array(list) => list.iter().filter_map(Json::as_i64).collect(),
        _ => Vec::new(),
    }
}

fn leads_held(connection: &Connection, id: &str) -> Result<Vec<i64>> {
    Ok(connection
        .prepare_cached(
            "SELECT offset_min FROM reminder
              WHERE entity_id = ?1 AND date_id IS NULL AND field_id IS NULL ORDER BY offset_min",
        )?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?)
}

/// The alerts the vault holds, in the form a source states them (`null` for none).
fn reminders_read(connection: &Connection, id: &str) -> Result<Json> {
    let held = leads_held(connection, id)?;
    Ok(if held.is_empty() {
        Json::Null
    } else {
        json!(held)
    })
}

/// A three-way merge of the alerts, judged whole: the source's new word replaces the vault's when
/// the member never changed them (they are what its last word implied). A task with no due holds
/// none.
fn reminders_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    before: Option<&Json>,
    now: &Json,
) -> Result<bool> {
    let held = leads_held(ctx.connection(), id)?;
    let wanted = leads_stated(now);
    if wanted == held {
        return Ok(false);
    }
    let ours = match before {
        Some(said) => leads_stated(said) == held,
        None => held.is_empty(),
    };
    if !ours || !has_due(ctx.connection(), id)? {
        return Ok(false);
    }
    reminder::set_leads(ctx, id, &wanted)
}

/// Put the alerts back to what the source last stated.
fn reminders_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    _item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    if !has_due(ctx.connection(), id)? {
        return Ok(false);
    }
    reminder::set_leads(ctx, id, &leads_stated(stated))
}

fn has_due(connection: &Connection, id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM task WHERE id = ?1 AND due IS NOT NULL)",
        [id],
        |row| row.get(0),
    )?)
}

/// What a reminder of the phone states, read into the form the vault holds it, so the statement
/// and the row compare equal (the module doc: `due`, `zone`, `due_timing`, `rule`, `status`,
/// `done_at`, `priority`, `url`, `reminders`). A record it refuses is counted and left out.
fn shape(
    ctx: &CommandCtx<'_, '_>,
    fields: &mut Map<String, Json>,
) -> std::result::Result<(), String> {
    let connection = ctx.connection();
    if fields
        .get("title")
        .and_then(Json::as_str)
        .is_none_or(|title| title.trim().is_empty())
    {
        return Err("a reminder needs a title".to_owned());
    }
    // The due: any spelling, one form; its timing and zone are the vault's reading of it.
    let zone = fields.remove("zone");
    if fields.contains_key("due") {
        match fields.get("due").cloned() {
            Some(Json::String(text)) if !text.trim().is_empty() => {
                let named = zone
                    .as_ref()
                    .and_then(Json::as_str)
                    .filter(|z| !z.trim().is_empty());
                let due = due_of(connection, text.trim(), named, None)
                    .map_err(|error| error.to_string())??;
                fields.insert("due".to_owned(), json!(due.at));
                fields.insert("due_timing".to_owned(), json!(due.timing));
                fields.insert("zone".to_owned(), json!(due.zone));
            }
            Some(Json::String(_) | Json::Null) => {
                fields.insert("due".to_owned(), Json::Null);
                fields.insert("due_timing".to_owned(), Json::Null);
                fields.insert("zone".to_owned(), Json::Null);
            }
            _ => return Err("a reminder's due is a day, a wall clock or an instant".to_owned()),
        }
    } else {
        fields.remove("due_timing");
    }
    let has_due = fields.get("due").is_some_and(|due| !due.is_null());
    crate::commands::follow::canonical_instants(fields, &["done_at"]);
    if let Some(status) = fields.get("status") {
        let status = status.as_str().unwrap_or_default();
        if !STATUSES.contains(&status) {
            return Err(format!("“{status}” is not a status of a reminder"));
        }
        let done_at = fields.get("done_at").is_some_and(|at| !at.is_null());
        if (status == "done") != done_at {
            return Err("a reminder is done exactly when it states when".to_owned());
        }
    }
    if let Some(priority) = fields.get("priority")
        && !priority
            .as_i64()
            .is_some_and(|mark| (0..=9).contains(&mark))
    {
        return Err("a priority is 0 to 9".to_owned());
    }
    // A repeat needs a due to repeat from, and one the vault cannot read is not kept.
    if let Some(rule) = fields.get("rule").cloned() {
        let kept = rule
            .as_str()
            .map(rrule::canonicalize)
            .filter(|rule| has_due && !rule.is_empty() && rrule::inspect(rule).is_ok());
        fields.insert("rule".to_owned(), json!(kept));
    }
    if let Some(url) = fields.get("url").cloned() {
        let kept = url.as_str().map(str::trim).filter(|url| !url.is_empty());
        fields.insert("url".to_owned(), json!(kept));
    }
    // A reminder counts back from a due.
    if let Some(reminders) = fields.get("reminders").cloned() {
        if let Some(list) = reminders.as_array()
            && list.iter().any(|lead| {
                !lead
                    .as_i64()
                    .is_some_and(|m| (0..=MAX_OFFSET_MIN).contains(&m))
            })
        {
            return Err("reminders are minutes before the due".to_owned());
        }
        let leads = if has_due {
            canon_reminders(&reminders)
        } else {
            Json::Null
        };
        fields.insert("reminders".to_owned(), leads);
    }
    Ok(())
}

fn no_defaults(_: &Connection, _: &OriginRow) -> Result<Vec<(&'static str, Sql)>> {
    Ok(Vec::new())
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

/// The phone's Reminders (iOS): a task in the project the origin fills. The member's own edit of a
/// field stands; a reminder the phone completes completes the task (the status and the instant
/// are two fields written as one, so the table's own CHECK holds), and one deleted on the phone
/// goes to the trash if the member never touched the task. What the phone alerts for, it alerts:
/// the vault alerts only what the member set or changed (`alerts.rs`, "one alert per real
/// thing"), which it reads from the `due` and `reminders` this map states.
pub const PHONE_REMINDERS: SystemMap = SystemMap {
    system: "phone_reminders",
    command: "follow.reminders",
    kind: Kind::Task,
    claims: None,
    fields: &[
        "description",
        "due",
        "due_timing",
        "zone",
        "priority",
        "rule",
        "url",
        "status",
        "done_at",
    ],
    fixed: &[],
    children: &[Child {
        name: "reminders",
        read: reminders_read,
        canon: canon_reminders,
        merge: reminders_merge,
        items: None,
        take: reminders_take,
        stamp: None,
    }],
    match_on: &[Match::Title],
    gone: Gone::Trash,
    window: None,
    defaults: no_defaults,
    founds: None,
    shape,
    settle: nothing_to_settle,
    named: nothing_to_settle,
};
