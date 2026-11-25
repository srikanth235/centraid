//! `reading.*`: one measurement taken at a moment (F1): weight, blood pressure (with its second
//! figure), glucose, temperature. A reading is an ENTITY kind, so it has the trash, a restore,
//! Delete forever and earlier versions like a workout (the shared verbs: `entity.trash`,
//! `entity.restore`, `entity.purge`, `history.*`), and a followed one follows its phone store
//! through `source` like a workout does (`health` yields it): a member's edit of a followed
//! reading is kept and "Phone says X" stays readable.
//!
//! **Guards, so thousands of readings do not flood the vault** (F1). A reading's title is EMPTY
//! (the kind's `may_be_named` is 0, so the database refuses a title) and the read formats the
//! figure in the member's units ([`over_time`], [`latest`]); it is not a link end and not a
//! `[[title]]` target (`entity_kind.linkable` is 0), takes no tag (`edge_shape`), and is never
//! queued for search (the writer owes the index nothing for it); `value` may be negative (a
//! difference can be). A continuous series (a heart-rate sample every few seconds) is never a run
//! of readings: it arrives as that day's totals ([`measurement`](super::measurement)).
//!
//! Which metrics are readings, whether a metric carries a second figure and the unit it is kept in
//! come from `health_metric`; this module names none. A metric whose cadence is a daily total is
//! refused here with a sentence, and by the table's key.
//!
//! **What the file refuses too**: the metric must be a reading's, the second figure is present
//! exactly when the metric has one (`reading`'s composite key into `health_metric`), the person
//! must be a person, and the instant must be in the clock's one form.

use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value as Json};

use crate::commands::entity::{STALE_GUARD, lookup_live, with_rev};
use crate::commands::follow::{Gone, Match, OriginRow, SystemMap, canonical_instants};
use crate::commands::measurement::Units;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// The most readings one read of a person's metric holds.
pub const OVER_TIME_LIMIT: i64 = 500;

/// The longest a reading's context may be: free words ("fasting", "after a meal").
pub const CONTEXT_MAX: usize = 120;

// ---------------------------------------------------------------------------------------------
// following the health store: the map
// ---------------------------------------------------------------------------------------------

/// What the health store states of a reading. The person is the vault's owner (a phone's health
/// store is the owner's), so the record states only the figure: its metric, its moment, its value
/// and second value, and its context.
pub const MAP: SystemMap = SystemMap {
    system: "health",
    command: "follow.health_readings",
    kind: Kind::Reading,
    claims: None,
    fields: &["metric", "at", "value", "value2", "context"],
    fixed: &[],
    children: &[],
    match_on: &[Match::Column("metric"), Match::Minute("at")],
    gone: Gone::Forget,
    window: Some("at"),
    defaults: owner_defaults,
    founds: None,
    shape,
    settle: nothing_to_settle,
    named: nothing_to_settle,
};

fn owner_defaults(
    connection: &rusqlite::Connection,
    _: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    let owner: String = connection.query_row("SELECT self_id FROM vault", [], |row| row.get(0))?;
    Ok(vec![("person_id", Sql::Text(owner))])
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

/// Read a store's record: a reading has no title (the row's is empty, whatever the store says), a
/// moment in the clock's one form and the figures it states.
fn shape(
    ctx: &CommandCtx<'_, '_>,
    fields: &mut Map<String, Json>,
) -> std::result::Result<(), String> {
    fields.remove("title");
    let metric = fields
        .get("metric")
        .and_then(Json::as_str)
        .ok_or("a reading states its metric")?
        .to_owned();
    if !fields.get("value").is_some_and(Json::is_number) {
        return Err("a reading states its value".to_owned());
    }
    if !fields.contains_key("at") {
        return Err("a reading states when it was taken".to_owned());
    }
    canonical_instants(fields, &["at"]);
    let connection = ctx.connection();
    let at = fields.get("at").and_then(Json::as_str).unwrap_or_default();
    let held: Option<String> = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", [at], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    if held.as_deref() != Some(at) {
        return Err(format!("`{at}` is not an instant"));
    }
    // A reading states the second figure exactly when its metric has one: a record that does not
    // say so is one the vault cannot keep.
    let second = fields.get("value2").is_some_and(|value| !value.is_null());
    match metric_row(connection, &metric).map_err(|error| error.to_string())? {
        None => return Err(format!("`{metric}` is not a figure Health keeps")),
        Some(row) if row.cadence != "reading" => {
            return Err(format!("`{metric}` is a daily total, not a reading"));
        }
        Some(row) if row.has_value2 != second => {
            return Err(if row.has_value2 {
                format!("a `{metric}` reading states both its figures")
            } else {
                format!("a `{metric}` reading has one figure")
            });
        }
        Some(_) => {}
    }
    // `null` and absent say the same thing of the second figure and the context.
    for name in ["value2", "context"] {
        if fields.get(name).is_some_and(Json::is_null) {
            fields.remove(name);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// the metrics the file knows
// ---------------------------------------------------------------------------------------------

struct MetricRow {
    cadence: String,
    has_value2: bool,
}

fn metric_row(connection: &rusqlite::Connection, code: &str) -> Result<Option<MetricRow>> {
    Ok(connection
        .query_row(
            "SELECT cadence, has_value2 FROM health_metric WHERE code = ?1",
            [code],
            |row| {
                Ok(MetricRow {
                    cadence: row.get(0)?,
                    has_value2: row.get(1)?,
                })
            },
        )
        .optional()?)
}

/// A sentence when `code` is not a metric a reading may be of, or its second figure is wrong.
fn metric_refusal(
    connection: &rusqlite::Connection,
    code: &str,
    value2: Option<bool>,
) -> Result<Option<String>> {
    let Some(row) = metric_row(connection, code)? else {
        return Ok(Some(format!("`{code}` is not a figure Health keeps.")));
    };
    if row.cadence != "reading" {
        return Ok(Some(format!(
            "`{code}` is a daily total, not a reading; set the day's figure instead."
        )));
    }
    Ok(match value2 {
        Some(given) if given != row.has_value2 => Some(if row.has_value2 {
            format!("A `{code}` reading has two figures; give both.")
        } else {
            format!("A `{code}` reading has one figure.")
        }),
        _ => None,
    })
}

fn instant(
    connection: &rusqlite::Connection,
    text: &str,
) -> Result<std::result::Result<String, String>> {
    let found: Option<String> =
        connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", [text], |row| {
            row.get(0)
        })?;
    Ok(found.ok_or_else(|| format!("`{text}` is not a day or an instant.")))
}

fn context_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    let context = ctx.optional_str("context")?;
    (context.chars().count() > CONTEXT_MAX)
        .then(|| format!("A reading's context is at most {CONTEXT_MAX} characters."))
}

// ---------------------------------------------------------------------------------------------
// a reading a member adds by hand
// ---------------------------------------------------------------------------------------------

fn subject(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    Ok(match ctx.optional_str("person_id") {
        Some(person) => person.to_owned(),
        None => ctx
            .connection()
            .query_row("SELECT self_id FROM vault", [], |row| row.get(0))?,
    })
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let second = ctx.input.get("value2").is_some_and(|value| !value.is_null());
    if let Some(sentence) = metric_refusal(connection, ctx.required_str("metric")?, Some(second))? {
        return Ok(Some(sentence));
    }
    match lookup_live(connection, &subject(ctx)?)? {
        Err(sentence) => return Ok(Some(sentence)),
        Ok(found) if found.kind != Kind::Person => {
            return Ok(Some(format!(
                "“{}” is a {}, not a person",
                found.title,
                found.kind.noun()
            )));
        }
        Ok(_) => {}
    }
    if let Err(sentence) = instant(connection, ctx.required_str("at")?)? {
        return Ok(Some(sentence));
    }
    Ok(context_refusal(ctx))
}

#[derive(serde::Deserialize)]
struct AddReadingInput {
    id: Option<String>,
    person_id: Option<String>,
    metric: String,
    at: String,
    value: f64,
    value2: Option<f64>,
    context: Option<String>,
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddReadingInput = ctx.parse_input()?;
    let person = match input.person_id {
        Some(person) => person,
        None => subject(ctx)?,
    };
    let at = instant(ctx.connection(), &input.at)?.map_err(|detail| VaultError::InvalidInput {
        name: "at".to_owned(),
        detail,
    })?;
    // THE TITLE IS EMPTY: the screen formats the figure.
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Reading, "")?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Reading, "")?,
    };
    ctx.connection().execute(
        "INSERT INTO reading (id, person_id, metric, at, value, value2, context)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            id,
            person,
            input.metric,
            at,
            input.value,
            input.value2,
            input
                .context
                .as_deref()
                .map(str::trim)
                .filter(|context| !context.is_empty()),
        ],
    )?;
    Ok(serde_json::json!({ "id": id, "reading_id": id }))
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let id = ctx.required_str("id")?;
    match lookup_live(connection, id)? {
        Err(sentence) => return Ok(Some(sentence)),
        Ok(found) if found.kind != Kind::Reading => {
            return Ok(Some(format!(
                "That is a {}, not a reading.",
                found.kind.noun()
            )));
        }
        Ok(_) => {}
    }
    // NOTHING HERE REFUSES A FOLLOWED READING (L6): the merge keeps the member's figure.
    let (metric, second): (String, bool) = connection.query_row(
        "SELECT metric, value2 IS NOT NULL FROM reading WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let second = match ctx.input.get("value2") {
        Some(value) => !value.is_null(),
        None => second,
    };
    if let Some(sentence) = metric_refusal(connection, &metric, Some(second))? {
        return Ok(Some(sentence));
    }
    if let Some(at) = ctx.optional_str("at")
        && let Err(sentence) = instant(connection, at)?
    {
        return Ok(Some(sentence));
    }
    Ok(context_refusal(ctx))
}

#[derive(serde::Deserialize)]
struct EditReadingInput {
    id: String,
    at: Option<String>,
    value: Option<f64>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    value2: Option<Option<f64>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    context: Option<Option<String>>,
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditReadingInput = ctx.parse_input()?;
    let mut sets: Vec<(&str, Sql)> = Vec::new();
    if let Some(at) = input.at.as_deref() {
        let held = instant(ctx.connection(), at)?.map_err(|detail| VaultError::InvalidInput {
            name: "at".to_owned(),
            detail,
        })?;
        sets.push(("at", Sql::Text(held)));
    }
    if let Some(value) = input.value {
        sets.push(("value", Sql::Real(value)));
    }
    if let Some(second) = input.value2 {
        sets.push(("value2", second.map_or(Sql::Null, Sql::Real)));
    }
    if let Some(context) = &input.context {
        sets.push((
            "context",
            match context.as_deref().map(str::trim) {
                Some(text) if !text.is_empty() => Sql::Text(text.to_owned()),
                _ => Sql::Null,
            },
        ));
    }
    if !sets.is_empty() {
        let assignments = sets
            .iter()
            .enumerate()
            .map(|(at, (column, _))| format!("{column} = ?{}", at + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let mut values = vec![Sql::Text(input.id.clone())];
        values.extend(sets.into_iter().map(|(_, value)| value));
        ctx.connection().execute(
            &format!("UPDATE reading SET {assignments} WHERE id = ?1"),
            rusqlite::params_from_iter(values),
        )?;
    }
    ctx.touch(&input.id)?;
    with_rev(
        ctx,
        &input.id,
        serde_json::json!({ "id": input.id, "reading_id": input.id }),
    )
}

// ---------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------

/// One reading, as a list or a chart reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadingRow {
    pub id: String,
    pub person_id: String,
    pub metric: String,
    pub at: String,
    pub value: f64,
    pub value2: Option<f64>,
    pub context: Option<String>,
    /// The figure spelled in the member's units (`72.4 kg`, `159.6 lb`, `120/80 mmHg`): a reading
    /// has no title, so this is what a row says.
    pub shown: String,
}

const COLUMNS: &str = "r.id, r.person_id, r.metric, r.at, r.value, r.value2, r.context, h.unit";

fn row_of(row: &rusqlite::Row<'_>, units: Units) -> rusqlite::Result<ReadingRow> {
    let (value, value2, unit): (f64, Option<f64>, String) = (row.get(4)?, row.get(5)?, row.get(7)?);
    Ok(ReadingRow {
        id: row.get(0)?,
        person_id: row.get(1)?,
        metric: row.get(2)?,
        at: row.get(3)?,
        value,
        value2,
        context: row.get(6)?,
        shown: units.show(&unit, value, value2),
    })
}

/// A person's readings of one metric between two instants (`[from, to)`), oldest first: a walk of
/// `reading_by_person` that stops at the limit, the trash left out.
pub const OVER_TIME_SQL: &str = "SELECT r.id, r.person_id, r.metric, r.at, r.value, r.value2, r.context, h.unit
       FROM reading r
       JOIN entity e ON e.id = r.id
       JOIN health_metric h ON h.code = r.metric
      WHERE r.person_id = ?1 AND r.metric = ?2 AND r.at >= ?3 AND r.at < ?4
        AND e.deleted_at IS NULL
      ORDER BY r.at, r.id
      LIMIT 500";

/// The latest live reading of one metric for a person: the end of `reading_by_person`.
pub const LATEST_SQL: &str = "SELECT r.id, r.person_id, r.metric, r.at, r.value, r.value2, r.context, h.unit
       FROM reading r
       JOIN entity e ON e.id = r.id
       JOIN health_metric h ON h.code = r.metric
      WHERE r.person_id = ?1 AND r.metric = ?2 AND e.deleted_at IS NULL
      ORDER BY r.at DESC, r.id DESC
      LIMIT 1";

/// The metrics a reading may be of, from the file.
pub const READING_METRICS_SQL: &str =
    "SELECT code FROM health_metric WHERE cadence = 'reading' ORDER BY code";

/// A person's readings of a metric over time, oldest first.
///
/// # Errors
///
/// A read the file refuses.
pub fn over_time(
    connection: &rusqlite::Connection,
    person: &str,
    metric: &str,
    from: &str,
    to: &str,
    units: Units,
) -> Result<Vec<ReadingRow>> {
    debug_assert!(OVER_TIME_SQL.contains(COLUMNS));
    let mut statement = connection.prepare_cached(OVER_TIME_SQL)?;
    let rows = statement
        .query_map(rusqlite::params![person, metric, from, to], |row| {
            row_of(row, units)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Health's summary: the latest live reading of each metric a person has, by metric. One bounded
/// probe of the index per reading metric.
///
/// # Errors
///
/// A read the file refuses.
pub fn latest(
    connection: &rusqlite::Connection,
    person: &str,
    units: Units,
) -> Result<BTreeMap<String, ReadingRow>> {
    let metrics = connection
        .prepare_cached(READING_METRICS_SQL)?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut probe = connection.prepare_cached(LATEST_SQL)?;
    let mut out = BTreeMap::new();
    for metric in metrics {
        if let Some(found) = probe
            .query_row(rusqlite::params![person, metric], |row| row_of(row, units))
            .optional()?
        {
            out.insert(metric, found);
        }
    }
    Ok(out)
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "a_reading_is_of_a_reading_metric_with_the_figures_it_has",
        check: pre_add,
    }];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "a_live_reading_keeps_the_figures_its_metric_has",
            check: pre_edit,
        },
    ];
    vec![
        CommandDefinition::plain(
            "reading.add",
            "reading",
            r#"{
              "type": "object",
              "required": ["metric", "at", "value"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "person_id": { "type": "string", "minLength": 1 },
                "metric": { "type": "string", "minLength": 1 },
                "at": { "type": "string", "minLength": 1 },
                "value": { "type": "number" },
                "value2": { "type": ["number", "null"] },
                "context": { "type": "string", "minLength": 1 }
              }
            }"#,
            Idempotency::Once,
            ADD,
            add,
        ),
        CommandDefinition::plain(
            "reading.edit",
            "reading",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "at": { "type": "string", "minLength": 1 },
                "value": { "type": "number" },
                "value2": { "type": ["number", "null"] },
                "context": { "type": ["string", "null"] },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
    ]
}
