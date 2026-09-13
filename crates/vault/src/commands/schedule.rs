//! THE SIXTEEN `schedule.*` COMMANDS — events, their occurrences, projects,
//! sections and tasks (#1020, wave 4 lane Schedule).
//!
//! v0 spreads them over four files (`commands/schedule.ts`,
//! `schedule-organize.ts`, `schedule-projects.ts`, `tasks.ts`); they are one
//! schema and one lane owns it (census §Cross-lane).
//!
//! ## The doctrine the port keeps
//!
//! - **An event is an iCalendar identity, and a revision of it bumps
//!   `SEQUENCE`.** `reschedule_event` and `cancel_event` never write a new
//!   row: attendees' clients see a revision, never a silent vanish.
//! - **Cancelling is not deleting.** `cancel_event` is a STATUS revision
//!   attendees see; `delete_event` is the reversible trash every other app
//!   carries (#883, ruling O-trash), with a 30-day grace and a restore that
//!   **refuses a lapsed window** (#916 review 1.5).
//! - **AN OCCURRENCE'S IDENTITY IS ITS WALL CLOCK** (#996 R21, ONT-25). An
//!   exception is keyed on `original_start_local`, and
//!   [`crate::time::occurrence`] is the one place that spelling appears. An
//!   edit that moves the series may not orphan its exceptions:
//!   [`stranded_exceptions`] refuses rather than leaving skips matching
//!   nothing.
//! - **A repeat rule is refused where the member wrote it** — `assert_supported`
//!   at the write boundary (D-1020-S1), never stored as an executable rule
//!   whose expansion is quietly wrong.
//! - **Completion is one operation** ([`crate::operations::task_lifecycle`]),
//!   never a toggle, and the successor inherits the series and its links
//!   (ONT-27).
//! - **Save is an upsert, and `add` is a create** (#922 G2).
//!   `save_project`/`save_section` honour a seat-minted id WITHOUT refusing a
//!   repeat, because refusing an id the vault holds would refuse every rename;
//!   `add_task` and `propose_event` refuse one, because adding is only ever a
//!   create.
//!
//! ## Two gates, never one (census §A0)
//!
//! `confirm` on a definition parks a NON-OWNER invocation regardless of risk;
//! the manifest's `confirmation: "required"` is the owner-facing prompt.
//! **This schema has FOUR of the first** — `reschedule_event`, `cancel_event`,
//! `edit_event` and `edit_event_occurrence`, each because it restates a
//! commitment other people may hold (#306 decision 1) — and, in v0, **none of
//! the second** on either app. The census records three; the fourth is
//! `edit_event_occurrence` and the count is a finding, not a difference
//! (D-1020-S6).
//!
//! ## What is deliberately absent
//!
//! `queueProviderWriteback` (`packages/vault/src/commands/provider-writeback.ts`)
//! runs after `reschedule_event`, `cancel_event`, `edit_event` and the series
//! branch of `edit_event_occurrence`, turning a local edit of a
//! provider-owned row into an already-approved outbox artifact. It writes
//! `sync_*`, which is the connectors plane — **on the back burner by the
//! owner's ruling (2026-09-12)** — so it is not ported here and is named in
//! the receipt as a hand-off rather than left as a silent omission. Nothing in
//! this schema's own behaviour depends on it; a vault with no connector has no
//! mapping and v0's call is a no-op.

use rusqlite::Connection;

use crate::error::{Result, VaultError};
use crate::operations::task_lifecycle::{self as lifecycle, TaskLifecycle};
use crate::operations::task_write::{Stated, TASK_WRITE_CONDITIONS, TaskWriteDraft, task_image};
use crate::time::occurrence::{OCCURRENCE_LOCAL_START_COLUMN, SEARCH_WINDOW_DAYS, search_window};
use crate::time::recurrence::{ExpandInput, Semantics};
use crate::time::zone::FireZone;
use crate::time::{recurrence, rrule};

use super::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};

/// The grace window Docs, Photos, Locker, People and Tally carry (#883).
pub const PURGE_DAYS: i64 = 30;

/// Every `schedule.*` command in the catalogue.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        propose_event(),
        reschedule_event(),
        respond_rsvp(),
        cancel_event(),
        delete_event(),
        restore_event(),
        edit_event(),
        edit_event_occurrence(),
        save_project(),
        save_section(),
        organize_task(),
        add_task(),
        set_task_status(),
        edit_task(),
        delete_task(),
        restore_task(),
    ]
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/// The three per-command judgements, as one value.
///
/// They travel together because they are one decision — how safe this is to
/// run again, how loudly it is presented, and whether a NON-OWNER invocation
/// parks — and reading them as three positional arguments at a call site is
/// how `confirm` got lost on `cancel_event` in v0 for a release.
#[derive(Debug, Clone, Copy)]
struct Gates {
    idempotency: Idempotency,
    risk: Risk,
    /// A non-owner invocation parks regardless of risk; this is the
    /// owner-facing gate on top of that (census §A0: two gates, never one).
    confirm: bool,
}

impl Gates {
    const fn new(idempotency: Idempotency, risk: Risk) -> Self {
        Self {
            idempotency,
            risk,
            confirm: false,
        }
    }

    /// Restates a commitment other people may hold (#306 decision 1).
    const fn parks(mut self) -> Self {
        self.confirm = true;
        self
    }
}

fn definition(
    name: &'static str,
    input_schema: &'static str,
    gates: Gates,
    preconditions: &'static [CommandCondition],
    postconditions: &'static [CommandCondition],
    handler: super::CommandHandler,
) -> CommandDefinition {
    CommandDefinition {
        name,
        owner_schema: "schedule",
        input_schema,
        idempotency: gates.idempotency,
        risk: gates.risk,
        confirm: gates.confirm,
        preconditions,
        postconditions,
        handler,
        sealed_input: &[],
        online_only: false,
    }
}

fn count(ctx: &CommandCtx<'_, '_>, sql: &str, bind: &[&dyn rusqlite::ToSql]) -> Result<i64> {
    Ok(ctx.connection().query_row(sql, bind, |row| row.get(0))?)
}

fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

/// The id a caller supplied, else a fresh one (#922 G2).
fn minted_id(ctx: &CommandCtx<'_, '_>, key: &str) -> String {
    ctx.optional_str(key)
        .map_or_else(|| ctx.next_id(), str::to_owned)
}

/// An instant `PURGE_DAYS` later, in the shape the column holds.
fn purge_at(now: &str) -> Result<String> {
    let millis = crate::clock::parse_iso_ms(now).ok_or_else(|| VaultError::Invariant {
        context: format!("`{now}` is not an instant this vault writes"),
    })?;
    Ok(crate::clock::format_iso_ms(
        millis + PURGE_DAYS * 86_400_000,
    ))
}

/// The vault's owner. A vault with none cannot hold a task at all.
fn owner_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    ctx.connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| VaultError::Invariant {
            context: "this vault has no owner yet; enrol one before writing a task".to_owned(),
        })
}

/// The vault's own zone, when its settings name one. **The second tier, and
/// there is no third** ([`crate::time::zone`]).
fn vault_zone(connection: &Connection) -> Option<String> {
    let settings: Option<String> = connection
        .query_row("SELECT settings_json FROM core_vault LIMIT 1", [], |row| {
            row.get(0)
        })
        .ok()
        .flatten();
    let parsed: serde_json::Value = serde_json::from_str(settings.as_deref()?).ok()?;
    parsed
        .get("timeZone")
        .or_else(|| parsed.get("timezone"))
        .or_else(|| parsed.get("time_zone"))
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// WHAT `dtstart` MEANS (#916 R2 / review 3.3).
///
/// `zoned` says it is a real instant expanded in `start_tz`, so both halves
/// have to be there; an event arriving with no zone is FLOATING — a wall clock
/// — and saying `zoned` anyway is what the schema's CHECK refuses. **The
/// default follows the input rather than a constant**, because the caller who
/// omits a zone is telling us which of the two this is.
#[must_use]
pub fn event_semantics(
    recurrence_semantics: Option<&str>,
    start_tz: Option<&str>,
    dtstart: Option<&str>,
) -> &'static str {
    if let Some(stated) = recurrence_semantics {
        return match stated {
            "zoned" => "zoned",
            "all-day" => "all-day",
            _ => "floating",
        };
    }
    if start_tz.is_some_and(|zone| !zone.is_empty())
        && dtstart.is_some_and(|start| start.ends_with('Z'))
    {
        "zoned"
    } else {
        "floating"
    }
}

struct EventSeries {
    rrule: Option<String>,
    dtstart: String,
    start_tz: Option<String>,
    semantics: Semantics,
}

fn event_series(connection: &Connection, event_id: &str) -> Result<EventSeries> {
    connection
        .query_row(
            "SELECT rrule, dtstart, start_tz, recurrence_semantics
               FROM core_event WHERE event_id = ?1",
            [event_id],
            |row| {
                let semantics: Option<String> = row.get(3)?;
                Ok(EventSeries {
                    rrule: row.get(0)?,
                    dtstart: row.get(1)?,
                    start_tz: row.get(2)?,
                    semantics: Semantics::from_stored(semantics.as_deref()),
                })
            },
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("no event {event_id}"),
        })
}

/// Expand a series over a window, in its OWN zone.
fn expand_series(series: &EventSeries, from: &str, to: &str, at_most: usize) -> Vec<String> {
    let Some(rule) = series.rrule.as_deref() else {
        return Vec::new();
    };
    let zone = series
        .start_tz
        .as_deref()
        .and_then(|name| FireZone::named(name).ok());
    let mut input = ExpandInput::new(rule, &series.dtstart, from, to)
        .with_semantics(series.semantics)
        .at_most(at_most);
    input.zone = zone.as_ref();
    recurrence::expand(&input)
        .into_iter()
        .map(|occurrence| occurrence.wall_start)
        .collect()
}

/// THE OCCURRENCE A SERIES-LOCAL WALL CLOCK NAMES, or `None` when the series
/// does not land there (#996 R21, ONT-25).
///
/// The key is **not an instant**, so the window comes from the shared adapter
/// rather than from a date parse, which read the key in the host's zone and
/// found nothing for every series outside UTC.
fn occurrence_wall_start(
    connection: &Connection,
    event_id: &str,
    local_start: &str,
) -> Result<Option<String>> {
    let series = event_series(connection, event_id)?;
    if series.rrule.is_none() {
        return Ok(None);
    }
    let Some((from, to)) = search_window(local_start, SEARCH_WINDOW_DAYS) else {
        return Ok(None);
    };
    Ok(expand_series(&series, &from, &to, 16)
        .into_iter()
        .find(|wall| wall == local_start))
}

/// Exceptions whose wall clock no longer lands on an occurrence of the series
/// as it now stands.
fn stranded_exceptions(connection: &Connection, event_id: &str) -> Result<usize> {
    let mut statement = connection.prepare(&format!(
        "SELECT {OCCURRENCE_LOCAL_START_COLUMN} FROM schedule_recurrence_exception
          WHERE target_type = 'core.event' AND target_id = ?1 AND scope = 'occurrence'"
    ))?;
    let mut stamps: Vec<String> = statement
        .query_map([event_id], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    drop(statement);
    if stamps.is_empty() {
        return Ok(0);
    }
    stamps.sort();
    let series = event_series(connection, event_id)?;
    if series.rrule.is_none() {
        return Ok(stamps.len());
    }
    let last = stamps.last().cloned().unwrap_or_default();
    let to = recurrence::parse_instant_ms(&last)
        .or_else(|| crate::time::zone::parse_wall_iso(&last).map(crate::time::zone::wall_epoch))
        .map_or_else(
            || last.clone(),
            |millis| crate::clock::format_iso_ms(millis + 86_400_000),
        );
    let first = stamps.first().cloned().unwrap_or_default();
    let live: std::collections::BTreeSet<String> = expand_series(&series, &first, &to, 1_000)
        .into_iter()
        .collect();
    Ok(stamps.iter().filter(|stamp| !live.contains(*stamp)).count())
}

/// Refuse a series edit that would leave its exceptions matching nothing.
fn assert_no_stranded_exceptions(ctx: &CommandCtx<'_, '_>, event_id: &str) -> Result<()> {
    let stranded = stranded_exceptions(ctx.connection(), event_id)?;
    if stranded > 0 {
        return Err(invalid(
            "event_id",
            format!(
                "this change to the series leaves {stranded} occurrence exception(s) matching \
                 nothing: remove or re-anchor them first"
            ),
        ));
    }
    Ok(())
}

fn optional_bool(ctx: &CommandCtx<'_, '_>, key: &str) -> bool {
    ctx.input
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_default()
}

fn optional_i64(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<i64> {
    ctx.input.get(key).and_then(serde_json::Value::as_i64)
}

/// A draft reader, plus the model's five conditions spliced in front of a
/// command's own.
///
/// **The model's sentence comes first** (#996 R21): when both have something
/// to say, the member should read "a task cannot be its own parent", not a
/// command's narrower "that parent is not open and top-level".
fn task_model_check(
    ctx: &CommandCtx<'_, '_>,
    index: usize,
    reader: fn(&CommandCtx<'_, '_>) -> TaskWriteDraft,
) -> Option<String> {
    let image = task_image(ctx.connection(), reader(ctx));
    (TASK_WRITE_CONDITIONS[index].assert)(ctx.connection(), &image)
}

macro_rules! task_write_conditions {
    ($reader:path) => {
        [
            CommandCondition {
                predicate: "task_due_at_is_a_time",
                check: |ctx| Ok(task_model_check(ctx, 0, $reader)),
            },
            CommandCondition {
                predicate: "task_rrule_is_supported",
                check: |ctx| Ok(task_model_check(ctx, 1, $reader)),
            },
            CommandCondition {
                predicate: "task_rrule_needs_a_due_at",
                check: |ctx| Ok(task_model_check(ctx, 2, $reader)),
            },
            CommandCondition {
                predicate: "task_hierarchy_is_acyclic",
                check: |ctx| Ok(task_model_check(ctx, 3, $reader)),
            },
            CommandCondition {
                predicate: "task_section_agrees_with_project",
                check: |ctx| Ok(task_model_check(ctx, 4, $reader)),
            },
        ]
    };
}

// A seat-minted row id is a UUID and nothing else (#922 G2): honouring a
// minted id without a shape means honouring any non-empty string as a primary
// key. The pattern is spliced into the two CREATING commands' schemas below
// with `concat!`, which is the only way a `&'static str` schema can share a
// fragment.

// ---------------------------------------------------------------------------
// Events.
// ---------------------------------------------------------------------------

fn propose_event() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "event_id_free",
            check: |ctx| {
                let Some(event_id) = ctx.optional_str("event_id") else {
                    return Ok(None);
                };
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_event WHERE event_id = ?1",
                    &[&event_id],
                )?;
                Ok((found != 0).then(|| "an event with that id already exists".to_owned()))
            },
        },
        CommandCondition {
            predicate: "calendar_exists",
            check: |ctx| {
                let calendar_id = ctx.required_str("calendar_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_calendar WHERE calendar_id = ?1",
                    &[&calendar_id],
                )?;
                Ok((found != 1).then(|| "That calendar doesn't exist.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "no_busy_conflict",
            check: |ctx| {
                let dtstart = ctx.required_str("dtstart")?;
                let dtend = ctx.required_str("dtend")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*)
                       FROM core_event e JOIN schedule_event_ext x ON x.event_id = e.event_id
                      WHERE x.busy = 'busy' AND e.status != 'cancelled'
                        AND e.dtstart < ?1 AND (e.dtend IS NULL OR e.dtend > ?2)",
                    &[&dtend, &dtstart],
                )?;
                Ok((found != 0)
                    .then(|| "This time conflicts with another event on your calendar.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "dtend_after_dtstart",
            check: |ctx| {
                let dtstart = ctx.required_str("dtstart")?.to_owned();
                let dtend = ctx.required_str("dtend")?;
                Ok((dtend <= dtstart.as_str())
                    .then(|| "An event must end after it starts.".to_owned()))
            },
        },
        CommandCondition {
            // THE RULE IS REFUSED WHERE THE MEMBER WROTE IT (D-1020-S1).
            //
            // v0 checks only the prefix here and parses the rule read-side —
            // which is how `FREQ=MONTHLY;BYSETPOS=-1` got stored and fired on
            // the wrong date forever. `assert_supported` is the same parser
            // the expander uses, so a rule that stores is a rule that expands.
            predicate: "rrule_is_supported",
            check: |ctx| {
                let Some(rule) = ctx.optional_str("rrule") else {
                    return Ok(None);
                };
                Ok(rrule::assert_supported(rule)
                    .err()
                    .map(|refusal| rrule::refusal_sentence(&refusal, rule)))
            },
        },
    ];
    static POST: &[CommandCondition] = &[
        // A POSTCONDITION SEES THE INPUT, NOT THE OUTPUT (the Rust runner
        // hands conditions a `CommandCtx`, and a minted id is not in it), so
        // these two are keyed on what the caller SAID rather than on the id
        // the handler produced. Where the caller minted one they are exact;
        // where it did not, the pair `(summary, dtstart)` is what identifies
        // the row this invocation wrote.
        CommandCondition {
            predicate: "event_created_tentative",
            check: |ctx| {
                let summary = ctx.required_str("summary")?;
                let dtstart = ctx.required_str("dtstart")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_event
                      WHERE summary = ?1 AND dtstart = ?2 AND status = 'tentative'",
                    &[&summary, &dtstart],
                )?;
                Ok((found < 1).then(|| "the event was not created".to_owned()))
            },
        },
        CommandCondition {
            predicate: "event_ext_attached",
            check: |ctx| {
                let summary = ctx.required_str("summary")?;
                let dtstart = ctx.required_str("dtstart")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_event_ext x
                       JOIN core_event e ON e.event_id = x.event_id
                      WHERE e.summary = ?1 AND e.dtstart = ?2",
                    &[&summary, &dtstart],
                )?;
                Ok((found < 1).then(|| "the calendar edge was not attached".to_owned()))
            },
        },
    ];
    definition(
        "schedule.propose_event",
        concat!(
            r#"{
          "type": "object",
          "required": ["summary", "dtstart", "dtend", "calendar_id"],
          "additionalProperties": false,
          "properties": {
            "event_id": "#,
            r#"{
            "type": "string", "minLength": 36, "maxLength": 36,
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          }"#,
            r#",
            "summary": { "type": "string", "minLength": 1 },
            "description": { "type": "string" },
            "dtstart": { "type": "string", "minLength": 1 },
            "dtend": { "type": "string", "minLength": 1 },
            "start_tz": { "type": "string" },
            "end_tz": { "type": "string" },
            "recurrence_semantics": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
            "calendar_id": { "type": "string", "minLength": 1 },
            "location_place_id": { "type": "string" },
            "attendee_party_ids": { "type": "array", "items": { "type": "string" } },
            "rrule": { "type": "string", "minLength": 1 },
            "conferencing_uri": { "type": "string", "minLength": 1 },
            "reminders": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["minutes_before"],
                "additionalProperties": false,
                "properties": { "minutes_before": { "type": "integer", "minimum": 0 } }
              }
            }
          }
        }"#
        ),
        Gates::new(Idempotency::Once, Risk::Medium),
        PRE,
        POST,
        |ctx| {
            let organizer = owner_party_id(ctx)?;
            let event_id = minted_id(ctx, "event_id");
            let summary = ctx.required_str("summary")?.to_owned();
            let dtstart = ctx.required_str("dtstart")?.to_owned();
            let dtend = ctx.required_str("dtend")?.to_owned();
            let calendar_id = ctx.required_str("calendar_id")?.to_owned();
            let start_tz = ctx.optional_str("start_tz").map(str::to_owned);
            let end_tz = ctx
                .optional_str("end_tz")
                .map(str::to_owned)
                .or_else(|| start_tz.clone());
            let semantics = event_semantics(
                ctx.optional_str("recurrence_semantics"),
                start_tz.as_deref(),
                Some(&dtstart),
            );
            let canonical_rule = ctx.optional_str("rrule").map(rrule::canonicalize);
            ctx.connection().execute(
                "INSERT INTO core_event
                   (event_id, ical_uid, summary, description, dtstart, dtend, start_tz,
                    rrule, status, location_place_id, organizer_party_id, sequence,
                    created_at, updated_at, end_tz, recurrence_semantics)
                 VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, 'tentative', ?8, ?9, 0, ?10, ?10,
                         ?11, ?12)",
                rusqlite::params![
                    event_id,
                    summary,
                    ctx.optional_str("description"),
                    dtstart,
                    dtend,
                    start_tz,
                    canonical_rule,
                    ctx.optional_str("location_place_id"),
                    organizer,
                    ctx.now,
                    end_tz,
                    semantics,
                ],
            )?;
            let reminders = ctx.input.get("reminders").and_then(|value| {
                let list = value.as_array()?;
                (!list.is_empty()).then(|| value.to_string())
            });
            // The write is recorded under the ext row's OWN primary key, not
            // the event id: every downstream sweep deletes by the physical pk,
            // so an event-keyed registration deleted nothing and left the ext
            // row holding an FK on an event that would not die (#708).
            let event_ext_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO schedule_event_ext
                   (event_ext_id, event_id, calendar_id, busy, conferencing_uri,
                    reminders_json, travel_buffer_min)
                 VALUES (?1, ?2, ?3, 'busy', ?4, ?5, NULL)",
                rusqlite::params![
                    event_ext_id,
                    event_id,
                    calendar_id,
                    ctx.optional_str("conferencing_uri"),
                    reminders,
                ],
            )?;
            let attendees = attendee_party_ids(ctx);
            for party_id in &attendees {
                let attendee_id = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO schedule_attendee
                       (attendee_id, event_id, party_id, role, partstat, responded_at)
                     VALUES (?1, ?2, ?3, 'required', 'needs-action', NULL)",
                    rusqlite::params![attendee_id, event_id, party_id],
                )?;
            }
            Ok(serde_json::json!({
                "event_id": event_id,
                "attendees": attendees.len(),
            }))
        },
    )
}

fn attendee_party_ids(ctx: &CommandCtx<'_, '_>) -> Vec<String> {
    ctx.input
        .get("attendee_party_ids")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The live event, not cancelled and not trashed.
const fn event_live_not_cancelled() -> CommandCondition {
    CommandCondition {
        predicate: "event_exists_not_cancelled",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event
                  WHERE event_id = ?1 AND status != 'cancelled' AND deleted_at IS NULL",
                &[&event_id],
            )?;
            Ok((found != 1).then(|| "That event is not here to change.".to_owned()))
        },
    }
}

fn bump_sequence(ctx: &CommandCtx<'_, '_>, event_id: &str) -> Result<i64> {
    let current: i64 = ctx
        .connection()
        .query_row(
            "SELECT sequence FROM core_event WHERE event_id = ?1",
            [event_id],
            |row| row.get(0),
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("event {event_id} vanished between check and execute"),
        })?;
    Ok(current + 1)
}

fn reschedule_event() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        event_live_not_cancelled(),
        CommandCondition {
            predicate: "dtend_after_dtstart",
            check: |ctx| {
                let dtstart = ctx.required_str("dtstart")?.to_owned();
                let dtend = ctx.required_str("dtend")?;
                Ok((dtend <= dtstart.as_str())
                    .then(|| "An event must end after it starts.".to_owned()))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        // Reschedules increment RFC 5545 SEQUENCE on the same identity, never
        // a new row.
        predicate: "sequence_incremented_and_moved",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let dtstart = ctx.required_str("dtstart")?;
            let dtend = ctx.required_str("dtend")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event
                  WHERE event_id = ?1 AND dtstart = ?2 AND dtend = ?3",
                &[&event_id, &dtstart, &dtend],
            )?;
            Ok((found != 1).then(|| "the event did not move".to_owned()))
        },
    }];
    definition(
        "schedule.reschedule_event",
        r#"{
          "type": "object",
          "required": ["event_id", "dtstart", "dtend"],
          "additionalProperties": false,
          "properties": {
            "event_id": { "type": "string", "minLength": 1 },
            "dtstart": { "type": "string", "minLength": 1 },
            "dtend": { "type": "string", "minLength": 1 }
          }
        }"#,
        // RESTATES A COMMITMENT OTHERS MAY HOLD (#306 decision 1) — parks for
        // owner confirmation on every non-owner invocation. Without this the
        // manifest's "parks for the owner" claim was cosmetic: any caller with
        // the install-time grant moved the event immediately.
        Gates::new(Idempotency::RetrySafe, Risk::Medium).parks(),
        PRE,
        POST,
        |ctx| {
            let event_id = ctx.required_str("event_id")?.to_owned();
            let dtstart = ctx.required_str("dtstart")?.to_owned();
            let dtend = ctx.required_str("dtend")?.to_owned();
            let sequence = bump_sequence(ctx, &event_id)?;
            ctx.connection().execute(
                "UPDATE core_event SET dtstart = ?1, dtend = ?2, sequence = ?3, updated_at = ?4
                  WHERE event_id = ?5",
                rusqlite::params![dtstart, dtend, sequence, ctx.now, event_id],
            )?;
            Ok(serde_json::json!({ "event_id": event_id, "sequence": sequence }))
        },
    )
}

fn respond_rsvp() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "attendee_invited",
            check: |ctx| {
                let event_id = ctx.required_str("event_id")?;
                let party_id = ctx.required_str("party_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_attendee
                      WHERE event_id = ?1 AND party_id = ?2",
                    &[&event_id, &party_id],
                )?;
                Ok((found != 1).then(|| "That person is not invited to this event.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "event_not_cancelled",
            check: |ctx| {
                let event_id = ctx.required_str("event_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_event
                      WHERE event_id = ?1 AND status != 'cancelled' AND deleted_at IS NULL",
                    &[&event_id],
                )?;
                Ok((found != 1).then(|| "That event is cancelled.".to_owned()))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "partstat_recorded",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let party_id = ctx.required_str("party_id")?;
            let partstat = ctx.required_str("partstat")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_attendee
                  WHERE event_id = ?1 AND party_id = ?2 AND partstat = ?3
                    AND responded_at IS NOT NULL",
                &[&event_id, &party_id, &partstat],
            )?;
            Ok((found != 1).then(|| "the response was not recorded".to_owned()))
        },
    }];
    definition(
        "schedule.respond_rsvp",
        r#"{
          "type": "object",
          "required": ["event_id", "party_id", "partstat"],
          "additionalProperties": false,
          "properties": {
            "event_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 },
            "partstat": { "type": "string", "enum": ["accepted", "declined", "tentative"] }
          }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        PRE,
        POST,
        |ctx| {
            let event_id = ctx.required_str("event_id")?.to_owned();
            let party_id = ctx.required_str("party_id")?.to_owned();
            let partstat = ctx.required_str("partstat")?.to_owned();
            let attendee_id: String = ctx
                .connection()
                .query_row(
                    "SELECT attendee_id FROM schedule_attendee
                      WHERE event_id = ?1 AND party_id = ?2",
                    [&event_id, &party_id],
                    |row| row.get(0),
                )
                .map_err(|_| VaultError::Invariant {
                    context: "attendee vanished between check and execute".to_owned(),
                })?;
            ctx.connection().execute(
                "UPDATE schedule_attendee SET partstat = ?1, responded_at = ?2
                  WHERE attendee_id = ?3",
                rusqlite::params![partstat, ctx.now, attendee_id],
            )?;
            Ok(serde_json::json!({ "attendee_id": attendee_id, "partstat": partstat }))
        },
    )
}

fn cancel_event() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[event_live_not_cancelled()];
    static POST: &[CommandCondition] = &[CommandCondition {
        // RFC 5545: cancellation is a revision of the same identity, so
        // attendees' clients see a SEQUENCE bump, never a silent vanish.
        predicate: "cancelled_at_new_sequence",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event WHERE event_id = ?1 AND status = 'cancelled'",
                &[&event_id],
            )?;
            Ok((found != 1).then(|| "the event was not cancelled".to_owned()))
        },
    }];
    definition(
        "schedule.cancel_event",
        r#"{
          "type": "object",
          "required": ["event_id"],
          "additionalProperties": false,
          "properties": { "event_id": { "type": "string", "minLength": 1 } }
        }"#,
        // Like reschedule_event: restates a commitment others may hold.
        // Parking rides `confirm` alone — without the flag the cancellation
        // executed immediately under the install-time grant.
        Gates::new(Idempotency::RetrySafe, Risk::Medium).parks(),
        PRE,
        POST,
        |ctx| {
            let event_id = ctx.required_str("event_id")?.to_owned();
            let sequence = bump_sequence(ctx, &event_id)?;
            ctx.connection().execute(
                "UPDATE core_event SET status = 'cancelled', sequence = ?1, updated_at = ?2
                  WHERE event_id = ?3",
                rusqlite::params![sequence, ctx.now, event_id],
            )?;
            Ok(serde_json::json!({ "event_id": event_id, "sequence": sequence }))
        },
    )
}

fn delete_event() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "event_live",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event WHERE event_id = ?1 AND deleted_at IS NULL",
                &[&event_id],
            )?;
            Ok((found != 1).then(|| "That event is not here to delete.".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "event_trashed",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event
                  WHERE event_id = ?1 AND deleted_at IS NOT NULL AND purge_at IS NOT NULL",
                &[&event_id],
            )?;
            Ok((found != 1).then(|| "the event was not moved to the trash".to_owned()))
        },
    }];
    definition(
        "schedule.delete_event",
        r#"{
          "type": "object",
          "required": ["event_id"],
          "additionalProperties": false,
          "properties": { "event_id": { "type": "string", "minLength": 1 } }
        }"#,
        Gates::new(Idempotency::Once, Risk::Medium),
        PRE,
        POST,
        |ctx| {
            let event_id = ctx.required_str("event_id")?.to_owned();
            let purge = purge_at(&ctx.now)?;
            ctx.connection().execute(
                "UPDATE core_event SET deleted_at = ?1, purge_at = ?2, updated_at = ?1
                  WHERE event_id = ?3",
                rusqlite::params![ctx.now, purge, event_id],
            )?;
            Ok(serde_json::json!({ "event_id": event_id, "purge_at": purge }))
        },
    )
}

fn restore_event() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        // RESTORE REFUSES A LAPSED WINDOW (#916 review 1.5): a restore past
        // the purge date resurrects what the member was told had been deleted.
        predicate: "event_trashed",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let now = ctx.now.clone();
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event
                  WHERE event_id = ?1 AND deleted_at IS NOT NULL
                    AND (purge_at IS NULL OR purge_at > ?2)",
                &[&event_id, &now],
            )?;
            Ok((found != 1).then(|| "That event is not in the trash any more.".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "event_live_again",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event
                  WHERE event_id = ?1 AND deleted_at IS NULL AND purge_at IS NULL",
                &[&event_id],
            )?;
            Ok((found != 1).then(|| "the event was not restored".to_owned()))
        },
    }];
    definition(
        "schedule.restore_event",
        r#"{
          "type": "object",
          "required": ["event_id"],
          "additionalProperties": false,
          "properties": { "event_id": { "type": "string", "minLength": 1 } }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        PRE,
        POST,
        |ctx| {
            let event_id = ctx.required_str("event_id")?.to_owned();
            ctx.connection().execute(
                "UPDATE core_event SET deleted_at = NULL, purge_at = NULL, updated_at = ?1
                  WHERE event_id = ?2",
                rusqlite::params![ctx.now, event_id],
            )?;
            Ok(serde_json::json!({ "event_id": event_id }))
        },
    )
}

fn edit_event() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "event_exists",
            check: |ctx| {
                let event_id = ctx.required_str("event_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_event WHERE event_id = ?1",
                    &[&event_id],
                )?;
                Ok((found != 1).then(|| "That event is not here to edit.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "event_end_after_start",
            check: |ctx| {
                let Some(dtend) = ctx.optional_str("dtend").map(str::to_owned) else {
                    return Ok(None);
                };
                let start = match ctx.optional_str("dtstart") {
                    Some(dtstart) => dtstart.to_owned(),
                    None => ctx.connection().query_row(
                        "SELECT dtstart FROM core_event WHERE event_id = ?1",
                        [ctx.required_str("event_id")?],
                        |row| row.get(0),
                    )?,
                };
                Ok((dtend <= start).then(|| "An event must end after it starts.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "rrule_is_supported",
            check: |ctx| {
                let Some(rule) = ctx.optional_str("rrule") else {
                    return Ok(None);
                };
                Ok(rrule::assert_supported(rule)
                    .err()
                    .map(|refusal| rrule::refusal_sentence(&refusal, rule)))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "event_revision_advanced",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event WHERE event_id = ?1 AND sequence > 0",
                &[&event_id],
            )?;
            Ok((found != 1).then(|| "the revision did not advance".to_owned()))
        },
    }];
    definition(
        "schedule.edit_event",
        r#"{
          "type": "object",
          "required": ["event_id"],
          "additionalProperties": false,
          "properties": {
            "event_id": { "type": "string", "minLength": 1 },
            "summary": { "type": "string", "minLength": 1 },
            "description": { "type": "string" },
            "clear_description": { "type": "boolean", "const": true },
            "dtstart": { "type": "string", "minLength": 1 },
            "dtend": { "type": "string", "minLength": 1 },
            "start_tz": { "type": "string", "minLength": 1 },
            "end_tz": { "type": "string", "minLength": 1 },
            "recurrence_semantics": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
            "rrule": { "type": "string", "minLength": 1 },
            "clear_rrule": { "type": "boolean", "const": true },
            "calendar_id": { "type": "string", "minLength": 1 },
            "location_place_id": { "type": "string", "minLength": 1 },
            "clear_location": { "type": "boolean", "const": true },
            "conferencing_uri": { "type": "string", "minLength": 1 },
            "clear_conferencing": { "type": "boolean", "const": true },
            "reminders": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["minutes_before"],
                "additionalProperties": false,
                "properties": { "minutes_before": { "type": "integer", "minimum": 0 } }
              }
            },
            "attendee_party_ids": { "type": "array", "items": { "type": "string", "minLength": 1 } }
          }
        }"#,
        // Same parking contract as `reschedule_event`: non-owner callers with
        // the install-time grant must not move a shared commitment silently.
        Gates::new(Idempotency::Idempotent, Risk::Medium).parks(),
        PRE,
        POST,
        |ctx| {
            let event_id = ctx.required_str("event_id")?.to_owned();
            let sequence = bump_sequence(ctx, &event_id)?;
            let canonical_rule = ctx.optional_str("rrule").map(rrule::canonicalize);
            let clear_rrule = optional_bool(ctx, "clear_rrule");
            let mut sets: Vec<String> = Vec::new();
            let mut values: Vec<rusqlite::types::Value> = Vec::new();
            for (column, value) in [
                ("summary", ctx.optional_str("summary").map(str::to_owned)),
                ("dtstart", ctx.optional_str("dtstart").map(str::to_owned)),
                ("dtend", ctx.optional_str("dtend").map(str::to_owned)),
                ("start_tz", ctx.optional_str("start_tz").map(str::to_owned)),
                ("end_tz", ctx.optional_str("end_tz").map(str::to_owned)),
                (
                    "recurrence_semantics",
                    ctx.optional_str("recurrence_semantics").map(str::to_owned),
                ),
            ] {
                if let Some(value) = value {
                    sets.push(format!("{column} = ?"));
                    values.push(value.into());
                }
            }
            for (column, cleared, set) in [
                ("rrule", clear_rrule, canonical_rule),
                (
                    "description",
                    optional_bool(ctx, "clear_description"),
                    ctx.optional_str("description").map(str::to_owned),
                ),
                (
                    "location_place_id",
                    optional_bool(ctx, "clear_location"),
                    ctx.optional_str("location_place_id").map(str::to_owned),
                ),
            ] {
                if cleared {
                    sets.push(format!("{column} = ?"));
                    values.push(rusqlite::types::Value::Null);
                } else if let Some(value) = set {
                    sets.push(format!("{column} = ?"));
                    values.push(value.into());
                }
            }
            if clear_rrule {
                // Dropping the rule leaves every exception on it excepting
                // nothing (#916, adversarial BUG-3).
                let orphaned = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_recurrence_exception
                      WHERE target_type = 'core.event' AND target_id = ?1",
                    &[&event_id],
                )?;
                if orphaned > 0 {
                    return Err(invalid(
                        "clear_rrule",
                        format!(
                            "this event has {orphaned} occurrence exception(s): remove them \
                             before dropping its recurrence"
                        ),
                    ));
                }
            }
            sets.push("sequence = ?".to_owned());
            values.push(sequence.into());
            sets.push("updated_at = ?".to_owned());
            values.push(ctx.now.clone().into());
            values.push(event_id.clone().into());
            ctx.connection().execute(
                &format!(
                    "UPDATE core_event SET {} WHERE event_id = ?",
                    sets.join(", ")
                ),
                rusqlite::params_from_iter(values),
            )?;
            assert_no_stranded_exceptions(ctx, &event_id)?;
            update_event_extension(ctx, &event_id)?;
            replace_attendees(ctx, &event_id)?;
            Ok(serde_json::json!({ "event_id": event_id, "sequence": sequence }))
        },
    )
}

fn update_event_extension(ctx: &CommandCtx<'_, '_>, event_id: &str) -> Result<()> {
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(calendar_id) = ctx.optional_str("calendar_id") {
        sets.push("calendar_id = ?".to_owned());
        values.push(calendar_id.to_owned().into());
    }
    if optional_bool(ctx, "clear_conferencing") {
        sets.push("conferencing_uri = ?".to_owned());
        values.push(rusqlite::types::Value::Null);
    } else if let Some(uri) = ctx.optional_str("conferencing_uri") {
        sets.push("conferencing_uri = ?".to_owned());
        values.push(uri.to_owned().into());
    }
    if let Some(reminders) = ctx.input.get("reminders") {
        sets.push("reminders_json = ?".to_owned());
        values.push(reminders.to_string().into());
    }
    if sets.is_empty() {
        return Ok(());
    }
    values.push(event_id.to_owned().into());
    ctx.connection().execute(
        &format!(
            "UPDATE schedule_event_ext SET {} WHERE event_id = ?",
            sets.join(", ")
        ),
        rusqlite::params_from_iter(values),
    )?;
    Ok(())
}

fn replace_attendees(ctx: &CommandCtx<'_, '_>, event_id: &str) -> Result<()> {
    if ctx.input.get("attendee_party_ids").is_none() {
        return Ok(());
    }
    // THE CHAIR SURVIVES: replacing the guest list never removes the
    // organiser's own row.
    ctx.connection().execute(
        "DELETE FROM schedule_attendee WHERE event_id = ?1 AND role != 'chair'",
        [event_id],
    )?;
    for party_id in attendee_party_ids(ctx) {
        let attendee_id = ctx.next_id();
        ctx.connection().execute(
            "INSERT INTO schedule_attendee
               (attendee_id, event_id, party_id, role, partstat, responded_at)
             VALUES (?1, ?2, ?3, 'required', 'needs-action', NULL)",
            rusqlite::params![attendee_id, event_id, party_id],
        )?;
    }
    Ok(())
}

fn edit_event_occurrence() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "recurring_event_exists",
        check: |ctx| {
            let event_id = ctx.required_str("event_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_event WHERE event_id = ?1 AND rrule IS NOT NULL",
                &[&event_id],
            )?;
            Ok((found != 1).then(|| "That event does not repeat.".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[];
    definition(
        "schedule.edit_event_occurrence",
        r#"{
          "type": "object",
          "required": ["event_id", "original_start_local", "scope", "action"],
          "additionalProperties": false,
          "properties": {
            "event_id": { "type": "string", "minLength": 1 },
            "original_start_local": { "type": "string", "minLength": 1 },
            "scope": { "type": "string", "enum": ["occurrence", "future", "series"] },
            "action": { "type": "string", "enum": ["skip", "override"] },
            "dtstart": { "type": "string", "minLength": 1 },
            "dtend": { "type": "string", "minLength": 1 },
            "summary": { "type": "string", "minLength": 1 },
            "description": { "type": "string" },
            "recurrence_semantics": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
            "calendar_id": { "type": "string", "minLength": 1 },
            "reminders": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["minutes_before"],
                "additionalProperties": false,
                "properties": { "minutes_before": { "type": "integer", "minimum": 0 } }
              }
            },
            "conferencing_uri": { "type": "string" },
            "attendee_party_ids": { "type": "array", "items": { "type": "string", "minLength": 1 } }
          }
        }"#,
        // A series skip cancels the event; occurrence/future overrides restate
        // times. Park like `cancel_event` and `reschedule_event`, so an agent
        // cannot bypass owner confirmation through the newer command surface.
        Gates::new(Idempotency::Idempotent, Risk::Medium).parks(),
        PRE,
        POST,
        |ctx| {
            let event_id = ctx.required_str("event_id")?.to_owned();
            let scope = ctx.required_str("scope")?.to_owned();
            let action = ctx.required_str("action")?.to_owned();
            if scope == "series" {
                return edit_series(ctx, &event_id, &action);
            }
            let local_start = ctx.required_str("original_start_local")?.to_owned();
            let Some(wall_start) =
                occurrence_wall_start(ctx.connection(), &event_id, &local_start)?
            else {
                return Err(invalid(
                    "original_start_local",
                    "original_start_local is not an occurrence of this series",
                ));
            };
            let override_json = occurrence_override_json(ctx, &scope, &action);
            let semantics = event_series(ctx.connection(), &event_id)?.semantics;
            let exception_id = ctx.next_id();
            ctx.connection().execute(
                &format!(
                    "INSERT INTO schedule_recurrence_exception
                       (exception_id, target_type, target_id, {OCCURRENCE_LOCAL_START_COLUMN},
                        recurrence_semantics, scope, action, override_json,
                        created_at, updated_at)
                     VALUES (?1, 'core.event', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                     ON CONFLICT(target_type, target_id, {OCCURRENCE_LOCAL_START_COLUMN}, scope)
                       DO UPDATE SET action = excluded.action,
                         override_json = excluded.override_json,
                         updated_at = excluded.updated_at"
                ),
                rusqlite::params![
                    exception_id,
                    event_id,
                    wall_start,
                    semantics.as_str(),
                    scope,
                    action,
                    override_json,
                    ctx.now,
                ],
            )?;
            Ok(serde_json::json!({ "event_id": event_id, "scope": scope }))
        },
    )
}

/// The override payload, which is where the shadow occurrence's own values
/// live. A skip carries none, which the schema's CHECK enforces.
fn occurrence_override_json(ctx: &CommandCtx<'_, '_>, scope: &str, action: &str) -> Option<String> {
    if action == "skip" {
        return None;
    }
    let mut override_value = serde_json::Map::new();
    override_value.insert("scope".to_owned(), scope.into());
    for (key, field) in [
        ("dtstart", "start"),
        ("dtend", "end"),
        ("summary", "summary"),
        ("description", "description"),
        ("recurrence_semantics", "recurrence_semantics"),
        ("calendar_id", "calendar_id"),
        ("conferencing_uri", "conferencing_uri"),
    ] {
        if let Some(value) = ctx.input.get(key) {
            override_value.insert(field.to_owned(), value.clone());
        }
    }
    for key in ["reminders", "attendee_party_ids"] {
        if let Some(value) = ctx.input.get(key) {
            override_value.insert(key.to_owned(), value.clone());
        }
    }
    Some(serde_json::Value::Object(override_value).to_string())
}

/// A SERIES-wide skip is cancellation of the series identity — the same
/// terminal state as `schedule.cancel_event`, with the SEQUENCE bump.
fn edit_series(
    ctx: &CommandCtx<'_, '_>,
    event_id: &str,
    action: &str,
) -> Result<serde_json::Value> {
    if action == "skip" {
        let status: String = ctx.connection().query_row(
            "SELECT status FROM core_event WHERE event_id = ?1",
            [event_id],
            |row| row.get(0),
        )?;
        if status == "cancelled" {
            return Ok(serde_json::json!({ "event_id": event_id, "scope": "series" }));
        }
        let sequence = bump_sequence(ctx, event_id)?;
        ctx.connection().execute(
            "UPDATE core_event SET status = 'cancelled', sequence = ?1, updated_at = ?2
              WHERE event_id = ?3",
            rusqlite::params![sequence, ctx.now, event_id],
        )?;
        return Ok(serde_json::json!({
            "event_id": event_id,
            "scope": "series",
            "sequence": sequence,
        }));
    }
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    for (column, key) in [
        ("dtstart", "dtstart"),
        ("dtend", "dtend"),
        ("summary", "summary"),
        ("description", "description"),
    ] {
        if let Some(value) = ctx.optional_str(key) {
            sets.push(format!("{column} = ?"));
            values.push(value.to_owned().into());
        }
    }
    if sets.is_empty() {
        return Ok(serde_json::json!({ "event_id": event_id, "scope": "series" }));
    }
    values.push(ctx.now.clone().into());
    values.push(event_id.to_owned().into());
    ctx.connection().execute(
        &format!(
            "UPDATE core_event SET {}, sequence = sequence + 1, updated_at = ? WHERE event_id = ?",
            sets.join(", ")
        ),
        rusqlite::params_from_iter(values),
    )?;
    assert_no_stranded_exceptions(ctx, event_id)?;
    Ok(serde_json::json!({ "event_id": event_id, "scope": "series" }))
}

// ---------------------------------------------------------------------------
// Projects, sections and the ordering spine (#630).
// ---------------------------------------------------------------------------

/// SAVE IS AN UPSERT, so a seat-minted id is honoured but **not refused**
/// (#922 G2).
///
/// The seat mints `project_id`/`section_id` only when it is making the row,
/// but by the time the write arrives a create and a rename look the same: both
/// carry the id. Refusing an id the vault already holds would refuse every
/// rename, so the minted-id guard `schedule.add_task` uses deliberately does
/// not apply here. The consequence, stated so nobody has to rediscover it: a
/// second save with the same id **overwrites** the row's fields, which is what
/// "save" means and what `Idempotency::Idempotent` declares.
fn save_project() -> CommandDefinition {
    definition(
        "schedule.save_project",
        r#"{
          "type": "object",
          "required": ["name"],
          "additionalProperties": false,
          "properties": {
            "project_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 },
            "area": { "type": "string" },
            "color": { "type": "string" },
            "sort_order": { "type": "integer" }
          }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        &[],
        &[],
        |ctx| {
            let owner = owner_party_id(ctx)?;
            let project_id = minted_id(ctx, "project_id");
            let name = ctx.required_str("name")?.to_owned();
            ctx.connection().execute(
                "INSERT INTO schedule_project
                   (project_id, owner_party_id, name, area, color, sort_order,
                    archived_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)
                 ON CONFLICT(project_id) DO UPDATE SET name = excluded.name,
                   area = excluded.area, color = excluded.color,
                   sort_order = excluded.sort_order, updated_at = excluded.updated_at",
                rusqlite::params![
                    project_id,
                    owner,
                    name,
                    ctx.optional_str("area"),
                    ctx.optional_str("color"),
                    optional_i64(ctx, "sort_order").unwrap_or(0),
                    ctx.now,
                ],
            )?;
            Ok(serde_json::json!({ "project_id": project_id }))
        },
    )
}

fn save_section() -> CommandDefinition {
    definition(
        "schedule.save_section",
        r#"{
          "type": "object",
          "required": ["project_id", "name"],
          "additionalProperties": false,
          "properties": {
            "section_id": { "type": "string", "minLength": 1 },
            "project_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 },
            "sort_order": { "type": "integer" }
          }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        &[],
        &[],
        |ctx| {
            let section_id = minted_id(ctx, "section_id");
            let project_id = ctx.required_str("project_id")?.to_owned();
            let name = ctx.required_str("name")?.to_owned();
            ctx.connection().execute(
                "INSERT INTO schedule_section
                   (section_id, project_id, name, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(section_id) DO UPDATE SET project_id = excluded.project_id,
                   name = excluded.name, sort_order = excluded.sort_order,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    section_id,
                    project_id,
                    name,
                    optional_i64(ctx, "sort_order").unwrap_or(0),
                    ctx.now,
                ],
            )?;
            Ok(serde_json::json!({ "section_id": section_id }))
        },
    )
}

/// FILING IS A TASK WRITE (#996 R21; drift ONT-26).
///
/// A section belongs to exactly one project, and nothing here compared the two
/// columns — so a task could be filed in a section of another project, in two
/// places at once, by this command as easily as by the row editor. The
/// conditions are the OPERATION's; the reader is this command's, because
/// `clear_*` is its own vocabulary for "unfile".
fn organize_task_draft(ctx: &CommandCtx<'_, '_>) -> TaskWriteDraft {
    let clear_project = optional_bool(ctx, "clear_project");
    let clear_section = clear_project || optional_bool(ctx, "clear_section");
    TaskWriteDraft {
        task_id: ctx.optional_str("task_id").map(str::to_owned),
        project_id: Stated::read(
            ctx.optional_str("project_id").map(str::to_owned),
            clear_project,
        ),
        section_id: Stated::read(
            ctx.optional_str("section_id").map(str::to_owned),
            clear_section,
        ),
        ..TaskWriteDraft::default()
    }
}

fn organize_task() -> CommandDefinition {
    const PRE: [CommandCondition; 5] = task_write_conditions!(organize_task_draft);
    definition(
        "schedule.organize_task",
        r#"{
          "type": "object",
          "required": ["task_id", "sort_order"],
          "additionalProperties": false,
          "properties": {
            "task_id": { "type": "string", "minLength": 1 },
            "project_id": { "type": "string", "minLength": 1 },
            "section_id": { "type": "string", "minLength": 1 },
            "clear_project": { "type": "boolean", "const": true },
            "clear_section": { "type": "boolean", "const": true },
            "sort_order": { "type": "integer" },
            "recurrence_anchor": { "type": "string", "enum": ["scheduled", "completion"] },
            "tz": { "type": "string", "minLength": 1 }
          }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        &PRE,
        &[],
        |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            // Placement columns are COALESCE'd: omitting project_id/section_id
            // leaves the current filing in place. The explicit `clear_*` flags
            // are the only NULL path, so an agent can retune recurrence
            // without unfiling the task into Notifications.
            let clear_project = optional_bool(ctx, "clear_project");
            let clear_section = clear_project || optional_bool(ctx, "clear_section");
            ctx.connection().execute(
                "UPDATE schedule_task
                    SET project_id = CASE WHEN ?1 THEN NULL ELSE COALESCE(?2, project_id) END,
                        section_id = CASE WHEN ?3 THEN NULL ELSE COALESCE(?4, section_id) END,
                        sort_order = ?5,
                        recurrence_anchor = COALESCE(?6, recurrence_anchor),
                        tz = COALESCE(?7, tz)
                  WHERE task_id = ?8",
                rusqlite::params![
                    clear_project,
                    ctx.optional_str("project_id"),
                    clear_section,
                    ctx.optional_str("section_id"),
                    optional_i64(ctx, "sort_order").unwrap_or(0),
                    ctx.optional_str("recurrence_anchor"),
                    ctx.optional_str("tz"),
                    task_id,
                ],
            )?;
            Ok(serde_json::json!({ "task_id": task_id }))
        },
    )
}

// ---------------------------------------------------------------------------
// Tasks. iCalendar VTODO vocabulary: status is the CHECK-constrained lifecycle
// (needs-action → in-process → completed | cancelled), priority 0 means unset
// and 1 is highest (RFC 5545 §3.8.1.9).
// ---------------------------------------------------------------------------

fn add_task_draft(ctx: &CommandCtx<'_, '_>) -> TaskWriteDraft {
    TaskWriteDraft {
        // The seat's minted id when it sent one (#922 G2), so a task naming
        // ITSELF as its parent meets the operation here rather than the column
        // CHECK — same refusal, same words, whichever writer asks.
        task_id: ctx.optional_str("task_id").map(str::to_owned),
        parent_task_id: Stated::read(ctx.optional_str("parent_task_id").map(str::to_owned), false),
        due_at: Stated::read(ctx.optional_str("due_at").map(str::to_owned), false),
        rrule: Stated::read(ctx.optional_str("rrule").map(str::to_owned), false),
        status: Stated::Set("needs-action".to_owned()),
        ..TaskWriteDraft::default()
    }
}

fn add_task() -> CommandDefinition {
    const MODEL: [CommandCondition; 5] = task_write_conditions!(add_task_draft);
    static PRE: &[CommandCondition] = &[
        // THE MODEL FIRST (#996 R21): when both have something to say the
        // member should read the model's sentence — "a task cannot be its own
        // parent" — not this command's narrower one.
        MODEL[0],
        MODEL[1],
        MODEL[2],
        MODEL[3],
        MODEL[4],
        CommandCondition {
            // One level of nesting: a subtask's parent must exist, be open,
            // and be top-level. An omitted parent passes.
            predicate: "parent_open_and_top_level",
            check: |ctx| {
                let Some(parent) = ctx.optional_str("parent_task_id") else {
                    return Ok(None);
                };
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_task
                      WHERE task_id = ?1 AND parent_task_id IS NULL AND deleted_at IS NULL
                        AND status IN ('needs-action','in-process')",
                    &[&parent],
                )?;
                Ok((found != 1).then(|| "That parent is not an open, top-level task.".to_owned()))
            },
        },
        CommandCondition {
            // rrule advances due_at on completion, so a rule with nothing to
            // advance is refused rather than silently never recurring.
            predicate: "rrule_requires_due_at",
            check: |ctx| {
                Ok(
                    (ctx.optional_str("rrule").is_some() && ctx.optional_str("due_at").is_none())
                        .then(|| "A repeating task needs a due date to repeat from.".to_owned()),
                )
            },
        },
        CommandCondition {
            predicate: "reminder_requires_due_at",
            check: |ctx| {
                Ok((optional_i64(ctx, "remind_before_min").is_some()
                    && ctx.optional_str("due_at").is_none())
                .then(|| "A reminder needs a due date to count back from.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "task_id_free",
            check: |ctx| {
                let Some(task_id) = ctx.optional_str("task_id") else {
                    return Ok(None);
                };
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_task WHERE task_id = ?1",
                    &[&task_id],
                )?;
                Ok((found != 0).then(|| "a task with that id already exists".to_owned()))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        // Keyed on the TITLE for the same reason `propose_event`'s pair is
        // keyed on `(summary, dtstart)`: a postcondition sees the input, and
        // a minted id is not in it.
        predicate: "task_created_open",
        check: |ctx| {
            let title = ctx.required_str("title")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_task
                  WHERE title = ?1 AND status = 'needs-action' AND completed_at IS NULL
                    AND deleted_at IS NULL",
                &[&title],
            )?;
            Ok((found < 1).then(|| "the task was not created".to_owned()))
        },
    }];
    definition(
        "schedule.add_task",
        concat!(
            r#"{
          "type": "object",
          "required": ["title"],
          "additionalProperties": false,
          "properties": {
            "task_id": "#,
            r#"{
            "type": "string", "minLength": 36, "maxLength": 36,
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          }"#,
            r#",
            "title": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "due_at": { "type": "string", "minLength": 1 },
            "priority": { "type": "integer", "minimum": 0, "maximum": 9 },
            "effort_min": { "type": "integer", "minimum": 1 },
            "parent_task_id": { "type": "string", "minLength": 1 },
            "rrule": { "type": "string", "minLength": 1 },
            "remind_before_min": { "type": "integer", "minimum": 0 }
          }
        }"#
        ),
        Gates::new(Idempotency::Once, Risk::Low),
        PRE,
        POST,
        |ctx| {
            let owner = owner_party_id(ctx)?;
            let task_id = minted_id(ctx, "task_id"); // The seat's, or ours (#922 G2).
            let title = ctx.required_str("title")?.to_owned();
            ctx.connection().execute(
                "INSERT INTO schedule_task
                   (task_id, owner_party_id, title, description, status, priority, due_at,
                    completed_at, effort_min, parent_task_id, rrule, remind_before_min)
                 VALUES (?1, ?2, ?3, ?4, 'needs-action', ?5, ?6, NULL, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    task_id,
                    owner,
                    title,
                    ctx.optional_str("description"),
                    optional_i64(ctx, "priority").unwrap_or(0),
                    ctx.optional_str("due_at"),
                    optional_i64(ctx, "effort_min"),
                    ctx.optional_str("parent_task_id"),
                    ctx.optional_str("rrule"),
                    optional_i64(ctx, "remind_before_min"),
                ],
            )?;
            Ok(serde_json::json!({ "task_id": task_id }))
        },
    )
}

/// ONE OPERATION, NOT A TOGGLE (#996 R21; drift ONT-27).
fn set_task_status() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[task_live()];
    static POST: &[CommandCondition] = &[CommandCondition {
        // `completed_at` exists iff the status says completed.
        predicate: "status_and_completion_stamp_agree",
        check: |ctx| {
            let task_id = ctx.required_str("task_id")?;
            let status = ctx.required_str("status")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_task
                  WHERE task_id = ?1 AND status = ?2
                    AND ((status = 'completed') = (completed_at IS NOT NULL))",
                &[&task_id, &status],
            )?;
            Ok((found != 1).then(|| "the status and its stamp disagree".to_owned()))
        },
    }];
    definition(
        "schedule.set_task_status",
        r#"{
          "type": "object",
          "required": ["task_id", "status"],
          "additionalProperties": false,
          "properties": {
            "task_id": { "type": "string", "minLength": 1 },
            "status": {
              "type": "string",
              "enum": ["needs-action", "in-process", "completed", "cancelled"]
            }
          }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        PRE,
        POST,
        |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            let status = ctx.required_str("status")?.to_owned();
            let zone = vault_zone(ctx.connection());
            let next_id = || ctx.next_id();
            let operation = TaskLifecycle {
                connection: ctx.connection(),
                now: &ctx.now,
                next_id: &next_id,
                vault_zone: zone.as_deref(),
            };
            let result = match status.as_str() {
                "completed" => lifecycle::complete(&operation, &task_id)?,
                "cancelled" => lifecycle::cancel(&operation, &task_id)?,
                other => lifecycle::reopen(&operation, &task_id, other)?,
            };
            Ok(result.to_json())
        },
    )
}

/// A trashed task is refused until restored, or purged (#883).
const fn task_live() -> CommandCondition {
    CommandCondition {
        predicate: "task_exists",
        check: |ctx| {
            let task_id = ctx.required_str("task_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_task WHERE task_id = ?1 AND deleted_at IS NULL",
                &[&task_id],
            )?;
            Ok((found != 1).then(|| "That task is not here.".to_owned()))
        },
    }
}

fn edit_task_draft(ctx: &CommandCtx<'_, '_>) -> TaskWriteDraft {
    TaskWriteDraft {
        task_id: ctx.optional_str("task_id").map(str::to_owned),
        due_at: Stated::read(
            ctx.optional_str("due_at").map(str::to_owned),
            optional_bool(ctx, "clear_due"),
        ),
        rrule: Stated::read(
            ctx.optional_str("rrule").map(str::to_owned),
            optional_bool(ctx, "clear_rrule"),
        ),
        ..TaskWriteDraft::default()
    }
}

fn edit_task() -> CommandDefinition {
    const MODEL: [CommandCondition; 5] = task_write_conditions!(edit_task_draft);
    static PRE: &[CommandCondition] = &[
        task_live(),
        // BOTH TOGETHER IS REFUSED: `clear_*` is the explicit intent, and a
        // magic empty string is not one. Four conditions rather than one
        // because the audit trail names which pair arrived.
        CommandCondition {
            predicate: "due_set_and_clear_are_exclusive",
            check: |ctx| {
                Ok(
                    (ctx.optional_str("due_at").is_some() && optional_bool(ctx, "clear_due"))
                        .then(|| "Set a due date or clear it, not both.".to_owned()),
                )
            },
        },
        CommandCondition {
            predicate: "description_set_and_clear_are_exclusive",
            check: |ctx| {
                Ok((ctx.optional_str("description").is_some()
                    && optional_bool(ctx, "clear_description"))
                .then(|| "Set a description or clear it, not both.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "remind_set_and_clear_are_exclusive",
            check: |ctx| {
                Ok((optional_i64(ctx, "remind_before_min").is_some()
                    && optional_bool(ctx, "clear_remind"))
                .then(|| "Set a reminder or clear it, not both.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "rrule_set_and_clear_are_exclusive",
            check: |ctx| {
                Ok(
                    (ctx.optional_str("rrule").is_some() && optional_bool(ctx, "clear_rrule"))
                        .then(|| "Set a repeat rule or stop it, not both.".to_owned()),
                )
            },
        },
        CommandCondition {
            // A repeating task still needs a due_at once the edit lands:
            // either it had one, or this call sets one.
            predicate: "rrule_edit_keeps_a_due_at",
            check: |ctx| {
                if ctx.optional_str("rrule").is_none() || ctx.optional_str("due_at").is_some() {
                    return Ok(None);
                }
                let task_id = ctx.required_str("task_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_task WHERE task_id = ?1 AND due_at IS NOT NULL",
                    &[&task_id],
                )?;
                Ok((found < 1)
                    .then(|| "A repeating task needs a due date to repeat from.".to_owned()))
            },
        },
        MODEL[0],
        MODEL[1],
        MODEL[2],
        MODEL[3],
        MODEL[4],
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "edits_applied",
        check: |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            for (key, column) in [
                ("title", "title"),
                ("description", "description"),
                ("due_at", "due_at"),
            ] {
                let Some(value) = ctx.optional_str(key) else {
                    continue;
                };
                let found = count(
                    ctx,
                    &format!(
                        "SELECT COUNT(*) FROM schedule_task WHERE task_id = ?1 AND {column} = ?2"
                    ),
                    &[&task_id, &value],
                )?;
                if found < 1 {
                    return Ok(Some(format!("the edit to {key} did not land")));
                }
            }
            if let Some(priority) = optional_i64(ctx, "priority") {
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM schedule_task WHERE task_id = ?1 AND priority = ?2",
                    &[&task_id, &priority],
                )?;
                if found < 1 {
                    return Ok(Some("the edit to priority did not land".to_owned()));
                }
            }
            Ok(None)
        },
    }];
    definition(
        "schedule.edit_task",
        r#"{
          "type": "object",
          "required": ["task_id"],
          "additionalProperties": false,
          "properties": {
            "task_id": { "type": "string", "minLength": 1 },
            "title": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "clear_description": { "type": "boolean", "const": true },
            "due_at": { "type": "string", "minLength": 1 },
            "clear_due": { "type": "boolean", "const": true },
            "priority": { "type": "integer", "minimum": 0, "maximum": 9 },
            "effort_min": { "type": "integer", "minimum": 1 },
            "remind_before_min": { "type": "integer", "minimum": 0 },
            "clear_remind": { "type": "boolean", "const": true },
            "rrule": { "type": "string", "minLength": 1 },
            "clear_rrule": { "type": "boolean", "const": true }
          }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        PRE,
        POST,
        |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            let mut sets: Vec<String> = Vec::new();
            let mut values: Vec<rusqlite::types::Value> = Vec::new();
            for (key, column) in [
                ("title", "title"),
                ("description", "description"),
                ("due_at", "due_at"),
                ("rrule", "rrule"),
            ] {
                if let Some(value) = ctx.optional_str(key) {
                    sets.push(format!("{column} = ?"));
                    values.push(value.to_owned().into());
                }
            }
            for (flag, column) in [
                ("clear_description", "description"),
                ("clear_due", "due_at"),
                ("clear_remind", "remind_before_min"),
                ("clear_rrule", "rrule"),
            ] {
                if optional_bool(ctx, flag) {
                    sets.push(format!("{column} = ?"));
                    values.push(rusqlite::types::Value::Null);
                }
            }
            for key in ["priority", "effort_min", "remind_before_min"] {
                if let Some(value) = optional_i64(ctx, key) {
                    sets.push(format!("{key} = ?"));
                    values.push(value.into());
                }
            }
            if !sets.is_empty() {
                values.push(task_id.clone().into());
                ctx.connection().execute(
                    &format!(
                        "UPDATE schedule_task SET {} WHERE task_id = ?",
                        sets.join(", ")
                    ),
                    rusqlite::params_from_iter(values),
                )?;
            }
            Ok(serde_json::json!({ "task_id": task_id }))
        },
    )
}

fn delete_task() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[task_live()];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "task_and_subtasks_trashed",
        check: |ctx| {
            let task_id = ctx.required_str("task_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_task
                  WHERE (task_id = ?1 OR parent_task_id = ?1) AND deleted_at IS NULL",
                &[&task_id],
            )?;
            Ok((found != 0).then(|| "the task or a subtask is still live".to_owned()))
        },
    }];
    definition(
        "schedule.delete_task",
        r#"{
          "type": "object",
          "required": ["task_id"],
          "additionalProperties": false,
          "properties": { "task_id": { "type": "string", "minLength": 1 } }
        }"#,
        Gates::new(Idempotency::Once, Risk::Medium),
        PRE,
        POST,
        |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            let purge = purge_at(&ctx.now)?;
            // Reversible for the grace window, then the sweep deletes the row
            // and cleans its poly-refs — the two-step every other app's delete
            // is (#883). The poly-ref cleanup deliberately does NOT run here:
            // an annotation on a trashed task must come back with it, or
            // restore means nothing.
            let removed = ctx.connection().execute(
                "UPDATE schedule_task SET deleted_at = ?1, purge_at = ?2
                  WHERE (task_id = ?3 OR parent_task_id = ?3) AND deleted_at IS NULL",
                rusqlite::params![ctx.now, purge, task_id],
            )?;
            Ok(serde_json::json!({ "task_id": task_id, "removed": removed }))
        },
    )
}

fn restore_task() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        // RESTORE REFUSES A LAPSED WINDOW (#916 review 1.5).
        predicate: "task_trashed",
        check: |ctx| {
            let task_id = ctx.required_str("task_id")?;
            let now = ctx.now.clone();
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_task
                  WHERE task_id = ?1 AND deleted_at IS NOT NULL
                    AND (purge_at IS NULL OR purge_at > ?2)",
                &[&task_id, &now],
            )?;
            Ok((found != 1).then(|| "That task is not in the trash any more.".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "task_live_again",
        check: |ctx| {
            let task_id = ctx.required_str("task_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_task WHERE task_id = ?1 AND deleted_at IS NULL",
                &[&task_id],
            )?;
            Ok((found != 1).then(|| "the task was not restored".to_owned()))
        },
    }];
    definition(
        "schedule.restore_task",
        r#"{
          "type": "object",
          "required": ["task_id"],
          "additionalProperties": false,
          "properties": { "task_id": { "type": "string", "minLength": 1 } }
        }"#,
        Gates::new(Idempotency::Idempotent, Risk::Low),
        PRE,
        POST,
        |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            // Subtasks trashed WITH the parent come back with it; one trashed
            // on its own does not — restore undoes the gesture that was made.
            let restored = ctx.connection().execute(
                "UPDATE schedule_task SET deleted_at = NULL, purge_at = NULL
                  WHERE (task_id = ?1 OR parent_task_id = ?1) AND deleted_at IS NOT NULL",
                [&task_id],
            )?;
            Ok(serde_json::json!({ "task_id": task_id, "restored": restored }))
        },
    )
}
