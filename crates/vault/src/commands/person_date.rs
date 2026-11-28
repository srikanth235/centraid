//! A person's dates (G3): the birthday, an anniversary, any other day the member keeps.
//!
//! EVERY date is a `person_date` row with its own id, the birthday included. `date` is a full day
//! (`1990-03-14`) or a yearless one in vCard's own form (`--03-14`). `kind` is a lookup the app
//! translates (`person_date_kind`); `label` is only the member's own words, absent when they gave
//! none. A kind that is `single` (the lookup row says so, nothing here names which) is held once
//! per person by the database's partial unique index. A reminder on a date is optional and is the
//! reminder module's (`reminder::add` with the date's id); Calendar reads the dates it shows from
//! [`on_day`] and [`in_month`].
//!
//! A followed store states a person's dates as a list ([`read`] and friends are its `dates`
//! field): the member's own edit of one date stands against the phone's next word, like a contact
//! point's.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::person::refusal_unless_live_person;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, reminder};
use crate::error::Result;

/// A day as it is kept: `YYYY-MM-DD`, or `--MM-DD` when it has no year. `MM-DD` and `--MMDD` and
/// `YYYYMMDD` are read as the same days; anything else is not a day.
#[must_use]
pub fn normalize(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let real = |year: Option<&str>, month: &str, day: &str| -> Option<String> {
        let tail = format!("{month}-{day}");
        let check = format!("{}-{tail}", year.unwrap_or("2000"));
        // `date()` is SQLite's own: the same test the column's CHECK makes.
        let ok = month.len() == 2
            && day.len() == 2
            && check.len() == 10
            && chrono_like_is_day(&check)
            && check
                .bytes()
                .filter(|b| *b != b'-')
                .all(|b| b.is_ascii_digit());
        ok.then(|| match year {
            Some(year) => format!("{year}-{tail}"),
            None => format!("--{tail}"),
        })
    };
    if let Some(rest) = raw.strip_prefix("--") {
        let rest = rest.replace('-', "");
        return (rest.len() == 4).then(|| real(None, &rest[..2], &rest[2..]))?;
    }
    if raw.len() == 5 && raw.as_bytes()[2] == b'-' {
        return real(None, &raw[..2], &raw[3..]);
    }
    if raw.len() == 8 && raw.bytes().all(|b| b.is_ascii_digit()) {
        return real(Some(&raw[..4]), &raw[4..6], &raw[6..]);
    }
    if raw.len() == 10 && raw.as_bytes()[4] == b'-' && raw.as_bytes()[7] == b'-' {
        return real(Some(&raw[..4]), &raw[5..7], &raw[8..]);
    }
    None
}

/// Whether `YYYY-MM-DD` is a real day of the proleptic calendar (a leap day only in a leap year).
fn chrono_like_is_day(text: &str) -> bool {
    let (Ok(year), Ok(month), Ok(day)) = (
        text[..4].parse::<u32>(),
        text[5..7].parse::<u32>(),
        text[8..].parse::<u32>(),
    ) else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let most = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=most).contains(&day) && year >= 1
}

/// The `MM-DD` of a date, whatever its year.
#[must_use]
pub fn month_day(date: &str) -> &str {
    &date[date.len().saturating_sub(5)..]
}

/// The year of a date, when it has one.
#[must_use]
pub fn year_of(date: &str) -> Option<i32> {
    (!date.starts_with("--"))
        .then(|| date.get(..4).and_then(|year| year.parse().ok()))
        .flatten()
}

/// A person's date as a screen reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonDate {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    pub date: String,
}

/// A person's dates in the order they were set.
///
/// # Errors
/// SQLite's refusal.
pub fn of_person(connection: &Connection, person: &str) -> Result<Vec<PersonDate>> {
    let mut statement = connection.prepare_cached(
        "SELECT id, kind, label, date FROM person_date WHERE person_id = ?1 ORDER BY position, id",
    )?;
    Ok(statement
        .query_map([person], |row| {
            Ok(PersonDate {
                id: row.get(0)?,
                kind: row.get(1)?,
                label: row.get(2)?,
                date: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// One date of the people on a day or in a month: Calendar's read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateOn {
    pub date_id: String,
    pub person_id: String,
    pub person: String,
    pub kind: String,
    pub label: Option<String>,
    pub date: String,
    /// The year it began in, when it has one (a birthday's age is the screen's to work out).
    pub year: Option<i32>,
}

fn dates_between(connection: &Connection, from: &str, to: &str) -> Result<Vec<DateOn>> {
    // `person_date_by_day` is (substr(date, -5), person_id): a day or a month is one range of it.
    let mut statement = connection.prepare_cached(
        "SELECT d.id, d.person_id, e.title, d.kind, d.label, d.date
           FROM person_date d CROSS JOIN entity e ON e.id = d.person_id
          WHERE substr(d.date, -5) BETWEEN ?1 AND ?2 AND e.deleted_at IS NULL
          ORDER BY substr(d.date, -5), e.title COLLATE NOCASE, d.id",
    )?;
    Ok(statement
        .query_map([from, to], |row| {
            let date: String = row.get(5)?;
            Ok(DateOn {
                date_id: row.get(0)?,
                person_id: row.get(1)?,
                person: row.get(2)?,
                kind: row.get(3)?,
                label: row.get(4)?,
                year: year_of(&date),
                date,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// WHOSE DATES FALL ON THIS DAY (`MM-DD`), whatever year each was set in, the people in the trash
/// left out. The one read Calendar takes for People's dates.
///
/// # Errors
/// SQLite's refusal.
pub fn on_day(connection: &Connection, month_day: &str) -> Result<Vec<DateOn>> {
    dates_between(connection, month_day, month_day)
}

/// The same for a month (`MM`), in day order.
///
/// # Errors
/// SQLite's refusal.
pub fn in_month(connection: &Connection, month: &str) -> Result<Vec<DateOn>> {
    dates_between(connection, &format!("{month}-01"), &format!("{month}-31"))
}

/// A sentence when this is not a kind of date.
fn kind_refusal(connection: &Connection, kind: &str) -> Result<Option<String>> {
    let known: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM person_date_kind WHERE code = ?1)",
        [kind],
        |row| row.get(0),
    )?;
    Ok((!known).then(|| format!("“{kind}” is not a kind of date")))
}

/// The kind a date of this person is when the member names none: the kind that is not `single`
/// and sorts first (the lookup says which are single; no name is read here).
fn plain_kind(connection: &Connection) -> Result<String> {
    Ok(connection.query_row(
        "SELECT code FROM person_date_kind WHERE single = 0 ORDER BY code DESC LIMIT 1",
        [],
        |row| row.get(0),
    )?)
}

/// A sentence when a person already holds a date of a `single` kind, other than `except`.
fn single_refusal(
    connection: &Connection,
    person: &str,
    kind: &str,
    except: Option<&str>,
) -> Result<Option<String>> {
    let held: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM person_date d JOIN person_date_kind k ON k.code = d.kind
                         WHERE d.person_id = ?1 AND d.kind = ?2 AND k.single = 1 AND d.id IS NOT ?3)",
        rusqlite::params![person, kind, except],
        |row| row.get(0),
    )?;
    Ok(held.then(|| format!("a person has one date of this kind: edit the {kind} they have")))
}

fn day_refusal(raw: &str) -> Option<String> {
    normalize(raw)
        .is_none()
        .then(|| format!("{raw} is not a day; write YYYY-MM-DD, or --MM-DD without a year"))
}

/// Add a date; returns its id. The one writer ([`add`] and a card's import call it). `kind` is a
/// code of `person_date_kind`.
///
/// # Errors
/// SQLite's refusal.
pub fn put(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    kind: &str,
    label: Option<&str>,
    date: &str,
) -> Result<String> {
    let id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO person_date (id, person_id, kind, single, label, date, position)
         SELECT ?1, ?2, k.code, k.single, ?4, ?5,
                (SELECT COALESCE(MAX(position), 0) + 1 FROM person_date WHERE person_id = ?2)
           FROM person_date_kind k WHERE k.code = ?3",
        rusqlite::params![
            id,
            person,
            kind,
            label.map(str::trim).filter(|label| !label.is_empty()),
            date
        ],
    )?;
    ctx.touch(person)?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// The member's verbs
// ---------------------------------------------------------------------------

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let person = ctx.required_str("id")?;
    if let Some(sentence) = refusal_unless_live_person(ctx.connection(), person)? {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = day_refusal(ctx.required_str("date")?) {
        return Ok(Some(sentence));
    }
    let kind = match ctx.optional_str("kind") {
        Some(kind) => kind.to_owned(),
        None => plain_kind(ctx.connection())?,
    };
    if let Some(sentence) = kind_refusal(ctx.connection(), &kind)? {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = single_refusal(ctx.connection(), person, &kind, None)? {
        return Ok(Some(sentence));
    }
    // A reminder on the date is checked as the reminder module says it: the lead is a real one.
    for lead in leads(ctx) {
        if !(0..=reminder::MAX_OFFSET_MIN).contains(&lead) {
            return Ok(Some(
                "a reminder comes 0 minutes to a year before, not after".to_owned(),
            ));
        }
    }
    Ok(None)
}

fn leads(ctx: &CommandCtx<'_, '_>) -> Vec<i64> {
    let mut leads: Vec<i64> = ctx
        .input
        .get("reminders")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_i64)
        .collect();
    leads.sort_unstable();
    leads.dedup();
    leads
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let person = ctx.required_str("id")?;
    let kind = match ctx.optional_str("kind") {
        Some(kind) => kind.to_owned(),
        None => plain_kind(ctx.connection())?,
    };
    let date = normalize(ctx.required_str("date")?).unwrap_or_default();
    let id = put(ctx, person, &kind, ctx.optional_str("label"), &date)?;
    let mut reminders = Vec::new();
    for lead in leads(ctx) {
        reminders.push(reminder::add(ctx, person, Some(&id), None, lead)?);
    }
    Ok(json!({ "id": person, "date_id": id, "reminders": reminders }))
}

/// The person a date belongs to, when it exists.
fn owner_of(connection: &Connection, date: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT person_id FROM person_date WHERE id = ?1",
            [date],
            |row| row.get(0),
        )
        .optional()?)
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let date_id = ctx.required_str("date_id")?;
    let Some(person) = owner_of(ctx.connection(), date_id)? else {
        return Ok(Some("there is no date with that id".to_owned()));
    };
    if let Some(sentence) = refusal_unless_live_person(ctx.connection(), &person)? {
        return Ok(Some(sentence));
    }
    if let Some(day) = ctx.optional_str("date")
        && let Some(sentence) = day_refusal(day)
    {
        return Ok(Some(sentence));
    }
    if let Some(kind) = ctx.optional_str("kind") {
        if let Some(sentence) = kind_refusal(ctx.connection(), kind)? {
            return Ok(Some(sentence));
        }
        return single_refusal(ctx.connection(), &person, kind, Some(date_id));
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct EditInput {
    date_id: String,
    kind: Option<String>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    label: Option<Option<String>>,
    date: Option<String>,
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let person = owner_of(connection, &input.date_id)?.unwrap_or_default();
    if let Some(kind) = input.kind.as_deref() {
        // A kind and its `single` move together: the row's composite key says so.
        connection.execute(
            "UPDATE person_date SET kind = ?2, single = (SELECT single FROM person_date_kind WHERE code = ?2)
              WHERE id = ?1",
            [input.date_id.as_str(), kind],
        )?;
    }
    if let Some(label) = input.label {
        connection.execute(
            "UPDATE person_date SET label = ?2 WHERE id = ?1",
            rusqlite::params![
                input.date_id,
                label
                    .as_deref()
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
            ],
        )?;
    }
    if let Some(date) = input.date.as_deref().and_then(normalize) {
        connection.execute(
            "UPDATE person_date SET date = ?2 WHERE id = ?1",
            [input.date_id.as_str(), date.as_str()],
        )?;
    }
    ctx.touch(&person)?;
    Ok(json!({ "id": person, "date_id": input.date_id }))
}

fn pre_remove(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(owner_of(ctx.connection(), ctx.required_str("date_id")?)?
        .is_none()
        .then(|| "there is no date with that id".to_owned()))
}

fn remove(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let date = ctx.required_str("date_id")?;
    let person = owner_of(ctx.connection(), date)?.unwrap_or_default();
    // Its reminders go with it (the key cascades).
    ctx.connection()
        .execute("DELETE FROM person_date WHERE id = ?1", [date])?;
    ctx.touch(&person)?;
    Ok(json!({ "id": person }))
}

// ---------------------------------------------------------------------------
// The follower's `dates` field
// ---------------------------------------------------------------------------

/// A date row held: its id, its (kind, label) and its day.
type Held = (String, (Said, String));

/// A statement of one date: its kind, its day and its label.
type Said = (String, Option<String>);

/// The key a date is named by across statements: its kind and its label's words, and, for a date
/// with no label, its day, so two plain dates of a kind stay two. A `single` kind has one date,
/// whatever its day: the label is empty and the day is not in its key (see [`keyed`]).
fn key_of(kind: &str, label: Option<&str>, date: &str, plain: bool) -> String {
    match label.filter(|label| !label.trim().is_empty()) {
        Some(label) => format!("{kind}:{}", crate::model::fold_label(label)),
        None if plain => format!("{kind}:{date}"),
        None => kind.to_owned(),
    }
}

/// The dates a statement says, by key. `singles` are the kinds the lookup says are `single`.
fn keyed(dates: &Json, singles: &BTreeSet<String>) -> BTreeMap<String, (Said, String)> {
    let mut out = BTreeMap::new();
    for item in dates.as_array().into_iter().flatten() {
        let (Some(kind), Some(raw)) = (
            item.get("kind").and_then(Json::as_str),
            item.get("date").and_then(Json::as_str),
        ) else {
            continue;
        };
        let Some(date) = normalize(raw) else {
            continue;
        };
        let label = item
            .get("label")
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(str::to_owned);
        let key = key_of(kind, label.as_deref(), &date, !singles.contains(kind));
        out.entry(key).or_insert(((kind.to_owned(), label), date));
    }
    out
}

fn singles(connection: &Connection) -> Result<BTreeSet<String>> {
    Ok(connection
        .prepare_cached("SELECT code FROM person_date_kind WHERE single = 1")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// A person's dates as the follower states them, in one canonical order.
pub(crate) fn read(connection: &Connection, person: &str) -> Result<Json> {
    let mut statement = connection.prepare_cached(
        "SELECT kind, label, date FROM person_date WHERE person_id = ?1 ORDER BY kind, date, label",
    )?;
    let dates = statement
        .query_map([person], |row| {
            let label: Option<String> = row.get(1)?;
            let mut date =
                json!({ "kind": row.get::<_, String>(0)?, "date": row.get::<_, String>(2)? });
            if let Some(label) = label {
                date["label"] = Json::String(label);
            }
            Ok(date)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json::Array(dates))
}

/// A list of dates in one form: a day in its own canonical spelling, one entry per key, in key
/// order.
pub(crate) fn canon(dates: &Json) -> Json {
    // The kinds that are single need a connection; the canonical form does not: it keeps one entry
    // per (kind, label, day), which is a superset of one per key and compares the same two lists.
    let mut seen = BTreeMap::new();
    for item in dates.as_array().into_iter().flatten() {
        let (Some(kind), Some(raw)) = (
            item.get("kind").and_then(Json::as_str),
            item.get("date").and_then(Json::as_str),
        ) else {
            continue;
        };
        let Some(date) = normalize(raw) else {
            continue;
        };
        let label = item
            .get("label")
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty());
        let mut entry = json!({ "kind": kind, "date": date });
        if let Some(label) = label {
            entry["label"] = Json::String(label.to_owned());
        }
        seen.insert(
            (
                kind.to_owned(),
                date.clone(),
                label.map(crate::model::fold_label).unwrap_or_default(),
            ),
            entry,
        );
    }
    Json::Array(seen.into_values().collect())
}

/// The dates of a canonical list by the key that names each across statements.
pub(crate) fn items(dates: &Json) -> BTreeMap<String, Json> {
    // Without the lookup a statement's items are named by kind, label and day: a changed day is a
    // removal and an addition, which the merge reads (a `single` kind's old date goes first).
    dates
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let kind = item.get("kind")?.as_str()?;
            let date = item.get("date")?.as_str()?;
            let label = item.get("label").and_then(Json::as_str).unwrap_or_default();
            Some((
                format!("{kind}:{}:{date}", crate::model::fold_label(label)),
                item.clone(),
            ))
        })
        .collect()
}

/// One date row made what a statement says (`None`: not there).
fn put_one(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    key: &str,
    held: Option<&(String, (Said, String))>,
    wants: Option<&(Said, String)>,
) -> Result<bool> {
    let connection = ctx.connection();
    Ok(match (held, wants) {
        (Some((id, _)), None) => {
            connection.execute("DELETE FROM person_date WHERE id = ?1", [id])? > 0
        }
        (Some((id, _)), Some(((kind, label), date))) => {
            connection.execute(
                "UPDATE person_date SET kind = ?2, single = (SELECT single FROM person_date_kind WHERE code = ?2),
                        label = ?3, date = ?4 WHERE id = ?1",
                rusqlite::params![id, kind, label, date],
            )? > 0
        }
        (None, Some(((kind, label), date))) => {
            let _ = key;
            // A kind the lookup does not know is not stated (the phone's own words for a date
            // are mapped before they get here).
            let known: bool = connection.query_row(
                "SELECT EXISTS (SELECT 1 FROM person_date_kind WHERE code = ?1)",
                [kind],
                |row| row.get(0),
            )?;
            if !known {
                return Ok(false);
            }
            put(ctx, person, kind, label.as_deref(), date)?;
            true
        }
        (None, None) => false,
    })
}

fn held_by_key(
    connection: &Connection,
    person: &str,
    singles: &BTreeSet<String>,
) -> Result<BTreeMap<String, Held>> {
    let mut out = BTreeMap::new();
    for row in of_person(connection, person)? {
        let key = key_of(
            &row.kind,
            row.label.as_deref(),
            &row.date,
            !singles.contains(&row.kind),
        );
        out.entry(key)
            .or_insert((row.id, ((row.kind, row.label), row.date)));
    }
    Ok(out)
}

/// Make the dates what the source last stated (one date, named by its [`items`] key, or all),
/// forced. Returns whether a row changed.
pub(crate) fn take(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let single = singles(connection)?;
    let said = keyed(stated, &single);
    let held = held_by_key(connection, person, &single)?;
    let named = |key: &str, value: &(Said, String)| {
        item.is_none_or(|item| {
            format!(
                "{}:{}:{}",
                (value.0).0,
                (value.0)
                    .1
                    .as_deref()
                    .map(crate::model::fold_label)
                    .unwrap_or_default(),
                value.1
            ) == item
                || key == item
        })
    };
    let mut changed = false;
    // Removals first: a `single` kind's old date makes room for the new one.
    for (key, (id, value)) in &held {
        if !said.contains_key(key) && named(key, value) {
            changed |= put_one(ctx, person, key, Some(&(id.clone(), value.clone())), None)?;
        }
    }
    for (key, value) in &said {
        if !named(key, value) {
            continue;
        }
        let mine = held.get(key);
        if mine.is_none_or(|(_, held)| held != value) {
            changed |= put_one(ctx, person, key, mine, Some(value))?;
        }
    }
    Ok(changed)
}

/// A three-way merge of a person's dates, per date (the follower's rule): a date the member has
/// not changed takes the source's word now (its new day, its removal); one the member changed,
/// added or removed stands as they left it. `stated` is what the source said last.
pub(crate) fn merge(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    stated: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let single = singles(connection)?;
    let (was, now) = (
        stated.map(|s| keyed(s, &single)).unwrap_or_default(),
        keyed(new, &single),
    );
    let held = held_by_key(connection, person, &single)?;
    let keys: BTreeSet<&String> = was.keys().chain(now.keys()).chain(held.keys()).collect();
    let mut changed = false;
    // Removals first, so a `single` kind never holds two while one is being replaced.
    for key in &keys {
        let (mine, said, wants) = (held.get(*key), was.get(*key), now.get(*key));
        if wants.is_none() && mine.is_some() && mine.map(|(_, value)| value) == said {
            changed |= put_one(ctx, person, key, mine, None)?;
        }
    }
    for key in &keys {
        let (mine, said, wants) = (held.get(*key), was.get(*key), now.get(*key));
        // The member changed this date: it stands.
        if mine.map(|(_, value)| value) != said || mine.map(|(_, value)| value) == wants {
            continue;
        }
        if wants.is_some() {
            changed |= put_one(ctx, person, key, mine, wants)?;
        }
    }
    Ok(changed)
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "person.add_date",
            "person",
            r#"{
              "type": "object",
              "required": ["id", "date"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "date": { "type": "string", "minLength": 1 },
                "kind": { "type": "string", "minLength": 1 },
                "label": { "type": "string", "maxLength": 200 },
                "reminders": {
                  "type": "array",
                  "maxItems": 10,
                  "items": { "type": "integer", "minimum": 0, "maximum": 525600 }
                }
              }
            }"#,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "date_is_a_day_of_a_person",
                check: pre_add,
            }],
            add,
        ),
        CommandDefinition::plain(
            "person.edit_date",
            "person",
            r#"{
              "type": "object",
              "required": ["date_id"],
              "additionalProperties": false,
              "properties": {
                "date_id": { "type": "string", "minLength": 1 },
                "date": { "type": "string", "minLength": 1 },
                "kind": { "type": "string", "minLength": 1 },
                "label": { "type": ["string", "null"], "maxLength": 200 }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "date_can_be_edited",
                check: pre_edit,
            }],
            edit,
        ),
        CommandDefinition::plain(
            "person.remove_date",
            "person",
            r#"{
              "type": "object",
              "required": ["date_id"],
              "additionalProperties": false,
              "properties": { "date_id": { "type": "string", "minLength": 1 } }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "date_exists",
                check: pre_remove,
            }],
            remove,
        ),
    ]
}
