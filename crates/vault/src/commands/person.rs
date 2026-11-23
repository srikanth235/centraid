//! `person.*`: a person's own verbs — add, edit, file in a list, log a touch,
//! write about them — and `person.merge`, two people who are one.
//!
//! A person is an entity of kind `person` and what a member records about them
//! is other entities joined to it: an interaction is an `activity` of an
//! activity kind with a `with` edge; the words kept of it, a note about a
//! person and a journal entry are `note`s with an `about` edge; a follow-up and
//! a gift idea are `task`s `about` them; an anniversary or any important date
//! but the birthday is a yearly `event` `about` them (R-FP-2); a relationship
//! is a `related` edge labelled by a relation concept; a list holds a person
//! with a `contains` edge. The birthday and the cadence are columns of the
//! person. Last contacted is **computed at read** from the activities; nothing
//! stores it. What is not People's alone is a shared verb (`entity.trash`,
//! `flag.set`, `edge.add`, `container.create`), and not wrapped here.
//!
//! The merged person's every reference is re-pointed at the person who stays,
//! by walking what the file says points at a person or at an entity (every
//! foreign key into `person` or `entity`, read from `PRAGMA foreign_key_list`,
//! as the blob plane reads what rents a blob) and the `edge` table, and then the
//! merged person is purged (its history, a `revision` row, goes with it: it is the history of a
//! person who no longer exists, and is never re-pointed). Nothing here lists a renting table: a table added
//! tomorrow that points at `entity` is merged correctly today
//! ([#1146](https://github.com/srikanth235/centraid/issues/1146)). **A merge is
//! confirmed**: it ends a person for good, like a purge.
//!
//! What a merge keeps when both people say something: the surviving person's
//! own value wins, and a blank is filled from the merged person; a contact
//! point both have is kept once; a daily measurement both have is the
//! surviving person's. The merged person's source, if it was followed, goes to
//! the survivor (the phone's record is the survivor's now, so the follower
//! neither adds it again nor loses the link); when the survivor is followed
//! already, it becomes a tombstone with the purge (`source.entity_id` nulls
//! itself), so the follower still never adds the same contact again.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::edge::{self, Extras};
use crate::commands::entity::{self, find, lookup_live, purge_one};
use crate::commands::event::{self, NewEvent};
use crate::commands::note;
use crate::commands::tag::{ensure_concept, set_tagged};
use crate::commands::task::{self, NewTask};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk, arrival,
};
use crate::error::{Result, VaultError};
use crate::model::{Kind, Rel};
use crate::time::Semantics;
use crate::time::recurrence::parse_instant_ms;
use crate::time::zone::{FireZone, WallTime, parse_wall_iso, wall_epoch};

/// The tag a gift idea carries: a task about a person that is a present, not a
/// follow-up. One word, the member's own to see and to search.
pub const GIFT_TAG: &str = "gift";

fn pre_merge(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (from, into) = (ctx.required_str("from")?, ctx.required_str("into")?);
    if from == into {
        return Ok(Some("a person cannot be merged into themselves".to_owned()));
    }
    for id in [from, into] {
        let found = match lookup_live(ctx.connection(), id)? {
            Ok(found) => found,
            Err(sentence) => return Ok(Some(sentence)),
        };
        if found.kind != Kind::Person {
            return Ok(Some(format!(
                "“{}” is a {}, and only people are merged",
                found.title,
                found.kind.noun()
            )));
        }
    }
    let is_you: bool =
        ctx.connection()
            .query_row("SELECT self_id = ?1 FROM vault", [from], |row| row.get(0))?;
    Ok(is_you.then(|| "this is you; merge the other person into you instead".to_owned()))
}

#[derive(serde::Deserialize)]
struct MergePersonInput {
    from: String,
    into: String,
}

fn merge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: MergePersonInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let (loser, winner) = (input.from.as_str(), input.into.as_str());

    // Edges: an edge cannot change its ends, so each is written again at the
    // surviving person and the old one goes with the purge. One that already
    // exists, or that would join the person to themselves, is dropped.
    let moved = connection.execute(
        "INSERT OR IGNORE INTO edge (from_id, rel, to_id, label_id, position, state, anchor, created_at)
         SELECT CASE from_id WHEN ?1 THEN ?2 ELSE from_id END, rel,
                CASE to_id WHEN ?1 THEN ?2 ELSE to_id END,
                label_id, position, state, anchor, created_at
           FROM edge WHERE from_id = ?1 OR to_id = ?1",
        [loser, winner],
    )?;

    // A person may hold one preferred contact point of a kind; the survivor's
    // preference stands.
    connection.execute(
        "UPDATE contact_point SET preferred = 0
          WHERE person_id = ?1 AND kind IN
                (SELECT kind FROM contact_point WHERE person_id = ?2 AND preferred = 1)",
        [loser, winner],
    )?;

    // Every foreign key into `person`, wherever it is. A row that would
    // collide with one the survivor has is left behind and goes with the purge.
    let mut repointed = 0usize;
    for (table, column) in references_to_a_person(connection)? {
        repointed += connection.execute(
            &format!(
                "UPDATE OR IGNORE {} SET {} = ?2 WHERE {} = ?1",
                crate::log::quoted(&table),
                crate::log::quoted(&column),
                crate::log::quoted(&column)
            ),
            [loser, winner],
        )?;
    }

    // Blanks are filled from the person who goes.
    connection.execute(
        "UPDATE person SET
           sort_name    = COALESCE(person.sort_name, l.sort_name),
           nickname     = COALESCE(person.nickname, l.nickname),
           role         = COALESCE(person.role, l.role),
           met          = COALESCE(person.met, l.met),
           birthday     = COALESCE(person.birthday, l.birthday),
           avatar       = COALESCE(person.avatar, l.avatar),
           cadence_days = COALESCE(person.cadence_days, l.cadence_days)
         FROM (SELECT * FROM person WHERE id = ?1) AS l
         WHERE person.id = ?2",
        [loser, winner],
    )?;

    let mut purged = Vec::new();
    purge_one(ctx, loser, &mut purged)?;
    Ok(serde_json::json!({ "into": winner, "edges": moved, "rows": repointed }))
}

/// Every `(table, column)` with a foreign key into `person(id)` or `entity(id)`
/// that a person can be named by, but the edges (a merge writes those again at
/// the survivor) and the kind rows' own link to their entity (`id`).
fn references_to_a_person(connection: &rusqlite::Connection) -> Result<Vec<(String, String)>> {
    let tables: Vec<String> = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
                AND name NOT IN ('person', 'edge', 'revision')
               AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
              ORDER BY name",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut found = Vec::new();
    for table in tables {
        let mut statement = connection.prepare(&format!(
            "PRAGMA foreign_key_list({})",
            crate::log::quoted(&table)
        ))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // A composite key names the target's `kind` as well as its `id`: only the
        // column that holds the id is re-pointed, and a kind row's own `id` is
        // the link to its entity, not a reference to a person.
        found.extend(
            rows.into_iter()
                .filter(|(target, column, to)| {
                    (target == "person" || target == "entity")
                        && to.as_deref().is_none_or(|to| to == "id")
                        && column != "id"
                })
                .map(|(_, column, _)| (table.clone(), column)),
        );
    }
    Ok(found)
}

// ---------------------------------------------------------------------------
// Founding and editing a person
// ---------------------------------------------------------------------------

/// A sentence unless this is a live person.
pub(crate) fn refusal_unless_live_person(
    connection: &Connection,
    id: &str,
) -> Result<Option<String>> {
    Ok(match lookup_live(connection, id)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Person => Some(format!(
            "“{}” is a {}, not a person",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

fn pre_live_person(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    refusal_unless_live_person(ctx.connection(), ctx.required_str("id")?)
}

/// A sentence unless `day` is a birthday the column takes: `MM-DD` or `YYYY-MM-DD`.
fn birthday_refusal(connection: &Connection, day: &str) -> Result<Option<String>> {
    let real: bool = connection.query_row(
        "SELECT (length(?1) = 5 AND date('2000-' || ?1) = '2000-' || ?1)
             OR (length(?1) = 10 AND date(?1) = ?1)",
        [day],
        |row| row.get(0),
    )?;
    Ok((!real).then(|| format!("{day} is not a day; write MM-DD, or YYYY-MM-DD")))
}

/// What a new person is told. A form of `None` is a person; a pet's `role` is
/// its species.
#[derive(Default)]
pub struct NewPerson<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub form: Option<&'a str>,
    pub nickname: Option<&'a str>,
    pub role: Option<&'a str>,
    pub met: Option<&'a str>,
    pub birthday: Option<&'a str>,
    pub cadence_days: Option<i64>,
}

/// Found a person: the entity and the kind row. Returns its id. A value that is
/// blank is no value.
pub fn found(ctx: &CommandCtx<'_, '_>, person: &NewPerson<'_>) -> Result<String> {
    fn blank(text: Option<&str>) -> Option<&str> {
        text.map(str::trim).filter(|text| !text.is_empty())
    }
    let title = person.title.trim();
    let id = match person.id {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Person, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Person, title)?,
    };
    ctx.connection().execute(
        "INSERT INTO person (id, form, nickname, role, met, birthday, cadence_days)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            id,
            person.form.unwrap_or("person"),
            blank(person.nickname),
            blank(person.role),
            blank(person.met),
            blank(person.birthday),
            person.cadence_days.filter(|days| *days > 0),
        ],
    )?;
    Ok(id)
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a person needs a name".to_owned()));
    }
    if let Some(id) = ctx.optional_str("id")
        && find(ctx.connection(), id)?.is_some()
    {
        return Ok(Some(
            "a person already holds the id this write minted".to_owned(),
        ));
    }
    if let Some(day) = ctx.optional_str("birthday")
        && let Some(sentence) = birthday_refusal(ctx.connection(), day)?
    {
        return Ok(Some(sentence));
    }
    list_refusal(ctx, ctx.optional_str("list_id"))
}

/// A list the person may be filed in: there, live and a list.
fn list_refusal(ctx: &CommandCtx<'_, '_>, list: Option<&str>) -> Result<Option<String>> {
    let Some(list) = list else {
        return Ok(None);
    };
    Ok(match lookup_live(ctx.connection(), list)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::List => Some(format!(
            "“{}” is a {}, not a list",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

#[derive(serde::Deserialize)]
struct AddPersonInput {
    id: Option<String>,
    title: String,
    form: Option<String>,
    nickname: Option<String>,
    role: Option<String>,
    met: Option<String>,
    birthday: Option<String>,
    cadence_days: Option<i64>,
    list_id: Option<String>,
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddPersonInput = ctx.parse_input()?;
    let id = found(
        ctx,
        &NewPerson {
            id: input.id.as_deref(),
            title: &input.title,
            form: input.form.as_deref(),
            nickname: input.nickname.as_deref(),
            role: input.role.as_deref(),
            met: input.met.as_deref(),
            birthday: input.birthday.as_deref(),
            cadence_days: input.cadence_days,
        },
    )?;
    if let Some(list) = input.list_id.as_deref() {
        edge::put(ctx, list, Rel::Contains, &id, None, &Extras::default())?;
    }
    Ok(json!({ "id": id }))
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_live_person(ctx)? {
        return Ok(Some(sentence));
    }
    if ctx
        .optional_str("title")
        .is_some_and(|title| title.trim().is_empty())
    {
        return Ok(Some("a person needs a name".to_owned()));
    }
    match ctx.optional_str("birthday").filter(|day| !day.is_empty()) {
        Some(day) => birthday_refusal(ctx.connection(), day),
        None => Ok(None),
    }
}

#[derive(serde::Deserialize)]
struct EditPersonInput {
    id: String,
    title: Option<String>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    sort_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    nickname: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    role: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    met: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    birthday: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    cadence_days: Option<Option<i64>>,
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditPersonInput = ctx.parse_input()?;
    let (connection, id) = (ctx.connection(), input.id.as_str());
    if let Some(title) = input.title.as_deref() {
        connection.execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.trim()],
        )?;
    }
    for (column, patch) in [
        ("sort_name", input.sort_name),
        ("nickname", input.nickname),
        ("role", input.role),
        ("met", input.met),
        ("birthday", input.birthday),
    ] {
        if let Some(value) = patch {
            let text = value
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            connection.execute(
                &format!("UPDATE person SET {column} = ?2 WHERE id = ?1"),
                rusqlite::params![id, text],
            )?;
        }
    }
    if let Some(days) = input.cadence_days {
        connection.execute(
            "UPDATE person SET cadence_days = ?2 WHERE id = ?1",
            rusqlite::params![id, days.filter(|days| *days > 0)],
        )?;
    }
    ctx.touch(id)?;
    entity::with_rev(ctx, id, json!({ "id": id }))
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

fn pre_move(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_live_person(ctx)? {
        return Ok(Some(sentence));
    }
    list_refusal(ctx, ctx.optional_str("list_id"))
}

#[derive(serde::Deserialize)]
struct MovePersonInput {
    id: String,
    list_id: Option<String>,
}

/// A person is in one list at a time (or none): filing them somewhere takes
/// them out of the list they were in.
fn move_person(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: MovePersonInput = ctx.parse_input()?;
    let id = input.id.as_str();
    // The list they were in, so the move is taken back by moving them there again (`null`: none).
    let was: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT from_id FROM edge WHERE rel = 'contains' AND to_id = ?1
                AND from_id IN (SELECT id FROM container WHERE kind = 'list')",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    ctx.connection().execute(
        "DELETE FROM edge WHERE rel = 'contains' AND to_id = ?1
            AND from_id IN (SELECT id FROM container WHERE kind = 'list')",
        [id],
    )?;
    if let Some(list) = input.list_id.as_deref() {
        edge::put(ctx, list, Rel::Contains, id, None, &Extras::default())?;
    }
    Ok(json!({
        "id": id,
        "list_id": input.list_id,
        "replaced": { "list_id": was }
    }))
}

// ---------------------------------------------------------------------------
// What a member records about a person
// ---------------------------------------------------------------------------

/// A note's title from its words: the first line, short.
fn headline(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty());
    line.unwrap_or_default().chars().take(60).collect()
}

fn pre_text_about_a_person(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("text")?.trim().is_empty() {
        return Ok(Some("there is nothing written".to_owned()));
    }
    pre_live_person(ctx)
}

fn pre_log(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if crate::model::fold_label(ctx.required_str("kind")?).is_empty() {
        return Ok(Some("say what kind of touch it was".to_owned()));
    }
    pre_live_person(ctx)
}

#[derive(serde::Deserialize)]
struct LogInteractionInput {
    id: String,
    kind: String,
    text: Option<String>,
}

/// A touch: an `activity` of an activity kind, `with` the person, starting now.
/// The words kept of it are a note `about` the activity.
fn log_interaction(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: LogInteractionInput = ctx.parse_input()?;
    let (connection, person) = (ctx.connection(), input.id.as_str());
    let kind = ensure_concept(ctx, Kind::ActivityKind, &input.kind)?;
    let title: String =
        connection.query_row("SELECT title FROM entity WHERE id = ?1", [&kind], |row| {
            row.get(0)
        })?;
    let activity = ctx.insert_entity(Kind::Activity, &title)?;
    connection.execute(
        "INSERT INTO activity (id, type_id, type_kind, starts) VALUES (?1, ?2, 'activity_kind', ?3)",
        rusqlite::params![activity, kind, ctx.now],
    )?;
    edge::put(ctx, &activity, Rel::With, person, None, &Extras::default())?;
    if let Some(text) = input.text.as_deref().filter(|t| !t.trim().is_empty()) {
        let words = note::found(ctx, None, &title, text, "plain", None)?;
        edge::put(ctx, &words, Rel::About, &activity, None, &Extras::default())?;
    }
    Ok(json!({ "interaction_id": activity }))
}

#[derive(serde::Deserialize)]
struct PersonTextInput {
    id: String,
    text: String,
}

/// A note about a person: a `note` with an `about` edge, so it is found with them.
fn add_note(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: PersonTextInput = ctx.parse_input()?;
    let words = note::found(
        ctx,
        None,
        &headline(&input.text),
        &input.text,
        "plain",
        None,
    )?;
    edge::put(ctx, &words, Rel::About, &input.id, None, &Extras::default())?;
    Ok(json!({ "note_id": words }))
}

fn pre_journal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("mood")?.trim().is_empty() || ctx.required_str("text")?.trim().is_empty() {
        return Ok(Some("a journal entry needs a mood and a line".to_owned()));
    }
    Ok(journal_stamp(ctx).err())
}

#[derive(serde::Deserialize)]
struct AddJournalInput {
    mood: String,
    text: String,
}

/// A journal entry: a note about the owner, titled by its mood, filed on its own
/// day.
fn add_journal_entry(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddJournalInput = ctx.parse_input()?;
    let filed_at = journal_stamp(ctx).map_err(|detail| VaultError::InvalidInput {
        name: "entry_date".to_owned(),
        detail,
    })?;
    let owner: String = ctx
        .connection()
        .query_row("SELECT self_id FROM vault", [], |row| row.get(0))?;
    let entry = note::found(ctx, None, &input.mood, &input.text, "plain", None)?;
    ctx.connection().execute(
        "UPDATE entity SET created_at = ?2 WHERE id = ?1",
        [&entry, &filed_at],
    )?;
    edge::put(ctx, &entry, Rel::About, &owner, None, &Extras::default())?;
    Ok(json!({ "entry_id": entry }))
}

/// The instant an entry is filed at: noon on its day, in the member's zone,
/// kept inside that day's UTC date so a reader of either agrees which day it is.
fn journal_stamp(ctx: &CommandCtx<'_, '_>) -> std::result::Result<String, String> {
    let entry_date = ctx.optional_str("entry_date");
    let Some(tz) = ctx.optional_str("tz") else {
        let day = entry_date.map_or_else(
            || ctx.now.get(0..10).unwrap_or_default().to_owned(),
            str::to_owned,
        );
        return Ok(format!("{day}T12:00:00.000Z"));
    };
    let zone = FireZone::named(tz).map_err(|_| format!("{tz} is not a time zone."))?;
    let day = match entry_date {
        Some(day) => {
            let shape = format!("`entry_date` is a day, YYYY-MM-DD; got {day}.");
            if day.len() != 10 {
                return Err(shape);
            }
            parse_wall_iso(day).ok_or(shape)?
        }
        None => {
            let now = parse_instant_ms(&ctx.now).ok_or_else(|| {
                format!(
                    "The vault clock reads {}, which is not an instant.",
                    ctx.now
                )
            })?;
            zone.zoned_parts(now)
        }
    };
    let at = |hour: i64, millisecond: i64| WallTime {
        hour,
        minute: if hour == 23 { 59 } else { 0 },
        second: if hour == 23 { 59 } else { 0 },
        millisecond,
        ..day
    };
    let day_text = format!("{:04}-{:02}-{:02}", day.year, day.month, day.day);
    let local_noon = zone
        .resolve_wall_time(at(12, 0))
        .and_then(|resolved| parse_instant_ms(&resolved.instant))
        .ok_or_else(|| format!("{day_text} does not exist in {zone}: the clocks skip it."))?;
    let landed = local_noon.clamp(wall_epoch(at(0, 0)), wall_epoch(at(23, 999)));
    let zoned = zone.zoned_parts(landed);
    let stays = (zoned.year, zoned.month, zoned.day) == (day.year, day.month, day.day);
    Ok(crate::clock::format_iso_ms(if stays {
        landed
    } else {
        local_noon
    }))
}

/// A task about a person: a follow-up, or (`gift`) a present they might like.
fn add_task_about(ctx: &CommandCtx<'_, '_>, gift: bool) -> Result<Json> {
    let input: PersonTextInput = ctx.parse_input()?;
    let id = task::found(
        ctx,
        &NewTask {
            title: &input.text,
            ..NewTask::default()
        },
    )?;
    edge::put(ctx, &id, Rel::About, &input.id, None, &Extras::default())?;
    if gift {
        let tag = ensure_concept(ctx, Kind::Tag, GIFT_TAG)?;
        set_tagged(ctx, &id, &tag, true)?;
    }
    Ok(json!({ "task_id": id }))
}

fn add_task(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    add_task_about(ctx, false)
}

fn add_gift(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    add_task_about(ctx, true)
}

fn pre_date(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("label")?.trim().is_empty() {
        return Ok(Some("a date needs a label".to_owned()));
    }
    if let Some(sentence) = birthday_refusal(ctx.connection(), ctx.required_str("month_day")?)? {
        return Ok(Some(sentence));
    }
    pre_live_person(ctx)
}

/// The first year, from `year` on, in which `month_day` is a day.
fn first_year_with(year: i64, month_day: &str) -> i64 {
    let leap = |y: i64| (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    (year..)
        .find(|y| month_day != "02-29" || leap(*y))
        .unwrap_or(year)
}

#[derive(serde::Deserialize)]
struct AddDateInput {
    id: String,
    label: String,
    month_day: String,
    reminder_on: Option<bool>,
}

/// An important date. The birthday is the person's own column; any other is a
/// yearly all-day `event` `about` them (R-FP-2), which Agenda shows on its day.
fn add_date(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddDateInput = ctx.parse_input()?;
    let (person, label) = (input.id.as_str(), input.label.trim());
    let month_day = input.month_day.as_str();
    if crate::model::fold_label(label) == "birthday" {
        ctx.connection().execute(
            "UPDATE person SET birthday = CASE WHEN length(birthday) = 10 AND substr(birthday, 6) = ?2
                                               THEN birthday ELSE ?2 END
              WHERE id = ?1",
            [person, month_day],
        )?;
        return Ok(json!({ "id": person }));
    }
    let year: i64 = ctx
        .now
        .get(0..4)
        .and_then(|y| y.parse().ok())
        .unwrap_or(2000);
    let starts = format!("{}-{month_day}", first_year_with(year, month_day));
    let reminded = input.reminder_on.unwrap_or(false);
    let date = event::found(
        ctx,
        &NewEvent {
            title: label,
            starts: &starts,
            timing: Semantics::AllDay,
            rule: Some("FREQ=YEARLY"),
            reminders: if reminded { &[0] } else { &[] },
            ..NewEvent::default()
        },
    )?;
    edge::put(ctx, &date, Rel::About, person, None, &Extras::default())?;
    Ok(json!({ "date_id": date }))
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/// The person a relationship names: the one given, else a live one of that name
/// and form (two "Mum"s is how a vault grows a duplicate nobody meant).
fn relative(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(id) = ctx.optional_str("related_id") {
        return Ok(Some(id.to_owned()));
    }
    let form = if ctx.optional_str("pet").is_some() {
        "pet"
    } else {
        "person"
    };
    Ok(ctx
        .connection()
        .query_row(
            "SELECT e.id FROM entity e JOIN person p ON p.id = e.id
              WHERE e.kind = 'person' AND e.deleted_at IS NULL AND p.form = ?1
                AND e.title = ?2 COLLATE NOCASE
              ORDER BY e.created_at, e.id LIMIT 1",
            [form, ctx.required_str("name")?.trim()],
            |row| row.get(0),
        )
        .optional()?)
}

fn pre_relationship(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("name")?.trim().is_empty() {
        return Ok(Some("a relative needs a name".to_owned()));
    }
    if crate::model::fold_label(ctx.required_str("kind")?).is_empty() {
        return Ok(Some("say how they are related".to_owned()));
    }
    if let Some(sentence) = pre_live_person(ctx)? {
        return Ok(Some(sentence));
    }
    if let Some(related) = ctx.optional_str("related_id")
        && let Some(sentence) = refusal_unless_live_person(ctx.connection(), related)?
    {
        return Ok(Some(sentence));
    }
    Ok((relative(ctx)?.as_deref() == ctx.optional_str("id"))
        .then(|| "a person cannot be related to themselves".to_owned()))
}

#[derive(serde::Deserialize)]
struct AddRelationshipInput {
    id: String,
    name: String,
    kind: String,
    pet: Option<String>,
}

/// A `related` edge from the person to a relative, labelled by what the relative
/// is to them. A relative not yet in the vault is founded: a pet is a person of
/// form `pet` whose `role` is its species.
fn add_relationship(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddRelationshipInput = ctx.parse_input()?;
    let pet = input.pet.as_deref();
    let target = match relative(ctx)? {
        Some(id) => id,
        None => found(
            ctx,
            &NewPerson {
                title: &input.name,
                form: pet.map(|_| "pet"),
                role: pet,
                ..NewPerson::default()
            },
        )?,
    };
    let label = ensure_concept(ctx, Kind::Relation, &input.kind)?;
    edge::put(
        ctx,
        &input.id,
        Rel::Related,
        &target,
        Some(&label),
        &Extras::default(),
    )?;
    Ok(json!({ "related_id": target }))
}

const ADD: &str = r#"{
  "type": "object",
  "required": ["title"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "minLength": 1 },
    "form": { "type": "string", "enum": ["person", "org", "group", "pet"] },
    "nickname": { "type": "string" },
    "role": { "type": "string" },
    "met": { "type": "string" },
    "birthday": { "type": "string" },
    "cadence_days": { "type": "integer", "minimum": 0 },
    "list_id": { "type": "string", "minLength": 1 }
  }
}"#;

const EDIT: &str = r#"{
  "type": "object",
  "required": ["id"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "minLength": 1 },
    "sort_name": { "type": ["string", "null"] },
    "nickname": { "type": ["string", "null"] },
    "role": { "type": ["string", "null"] },
    "met": { "type": ["string", "null"] },
    "birthday": { "type": ["string", "null"] },
    "cadence_days": { "type": ["integer", "null"], "minimum": 0 },
    "expected_rev": { "type": "integer", "minimum": 0 }
  }
}"#;

const MOVE: &str = r#"{
  "type": "object",
  "required": ["id"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "list_id": { "type": ["string", "null"], "minLength": 1 }
  }
}"#;

const LOG: &str = r#"{
  "type": "object",
  "required": ["id", "kind"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "kind": { "type": "string", "minLength": 1 },
    "text": { "type": "string" }
  }
}"#;

const TEXT: &str = r#"{
  "type": "object",
  "required": ["id", "text"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "text": { "type": "string", "minLength": 1 }
  }
}"#;

const JOURNAL: &str = r#"{
  "type": "object",
  "required": ["mood", "text"],
  "additionalProperties": false,
  "properties": {
    "mood": { "type": "string", "minLength": 1 },
    "text": { "type": "string", "minLength": 1 },
    "entry_date": { "type": "string" },
    "tz": {
      "type": "string",
      "minLength": 1,
      "description": "The member's IANA zone: the entry is filed on `entry_date` (or on today) in this zone. Absent, it is dated by UTC."
    }
  }
}"#;

const DATE: &str = r#"{
  "type": "object",
  "required": ["id", "label", "month_day"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "label": { "type": "string", "minLength": 1 },
    "month_day": { "type": "string", "pattern": "^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])$" },
    "reminder_on": { "type": "boolean" }
  }
}"#;

const RELATIONSHIP: &str = r#"{
  "type": "object",
  "required": ["id", "name", "kind"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "name": { "type": "string", "minLength": 1 },
    "kind": { "type": "string", "minLength": 1 },
    "pet": { "type": "string" },
    "related_id": { "type": "string", "minLength": 1 }
  }
}"#;

const MERGE: &str = r#"{
  "type": "object",
  "required": ["from", "into"],
  "additionalProperties": false,
  "properties": {
    "from": { "type": "string", "minLength": 1 },
    "into": { "type": "string", "minLength": 1 }
  }
}"#;

/// A merge ends a person for good, so it is presented the way a purge is: medium
/// risk, and parked for the owner's confirmation on every non-owner-device
/// invocation (the level `entity.purge` carries).
// ---------------------------------------------------------------------------
// vCards in and out (#1173, item 20)
// ---------------------------------------------------------------------------
use crate::commands::contact_point::reach_key;
use crate::commands::person_portable::{self as vcard, Card};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The most cards one import takes.
const VCARD_MAX: usize = 20_000;

/// A person's nickname, role and birthday: the fields a card may fill.
type Fields = (Option<String>, Option<String>, Option<String>);

/// What the vault already holds of the people a file may name: their names and the points they
/// are reached at, folded to the keys two spellings share.
struct Known {
    by_name: BTreeMap<String, String>,
    /// A person's own name, for saying whom a card would merge into.
    titles: BTreeMap<String, String>,
    by_point: BTreeMap<(String, String), String>,
    /// A person's own fields and points, for what a card would add.
    fields: BTreeMap<String, Fields>,
    points: BTreeSet<(String, String, String)>,
}

fn known_people(ctx: &CommandCtx<'_, '_>) -> Result<Known> {
    let c = ctx.connection();
    let mut known = Known {
        by_name: BTreeMap::new(),
        titles: BTreeMap::new(),
        by_point: BTreeMap::new(),
        fields: BTreeMap::new(),
        points: BTreeSet::new(),
    };
    let mut people = c.prepare_cached(
        "SELECT e.id, e.title, p.nickname, p.role, p.birthday
           FROM entity e JOIN person p ON p.id = e.id
          WHERE e.kind = 'person' AND e.deleted_at IS NULL ORDER BY e.created_at, e.id",
    )?;
    let rows = people
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, title, nickname, role, birthday) in rows {
        known
            .by_name
            .entry(crate::model::fold_label(&title))
            .or_insert_with(|| id.clone());
        known.titles.insert(id.clone(), title);
        known.fields.insert(id, (nickname, role, birthday));
    }
    let mut points = c.prepare_cached(
        "SELECT cp.person_id, cp.kind, cp.normalized FROM contact_point cp
           JOIN entity e ON e.id = cp.person_id AND e.deleted_at IS NULL",
    )?;
    let rows = points
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (person, kind, key) in rows {
        if matches!(kind.as_str(), "phone" | "email") {
            known
                .by_point
                .entry((kind.clone(), key.clone()))
                .or_insert_with(|| person.clone());
        }
        known.points.insert((person, kind, key));
    }
    Ok(known)
}

/// The person a card is: one with its name, else one reached at a number or an address of it.
fn match_of(known: &Known, card: &Card) -> Option<String> {
    known
        .by_name
        .get(&crate::model::fold_label(&card.name))
        .cloned()
        .or_else(|| {
            card.points
                .iter()
                .filter(|point| matches!(point.kind, "phone" | "email"))
                .find_map(|point| {
                    known
                        .by_point
                        .get(&(point.kind.to_owned(), reach_key(point.kind, &point.value)))
                        .cloned()
                })
        })
}

/// What a card would add to the person it matches: the fields they leave blank and the points
/// they lack. Nothing already there is ever replaced.
struct Adds {
    nickname: Option<String>,
    role: Option<String>,
    birthday: Option<String>,
    points: Vec<usize>,
}

impl Adds {
    fn count(&self) -> usize {
        usize::from(self.nickname.is_some())
            + usize::from(self.role.is_some())
            + usize::from(self.birthday.is_some())
            + self.points.len()
    }
}

fn adds_of(known: &Known, person: &str, card: &Card) -> Adds {
    let (nickname, role, birthday) = known.fields.get(person).cloned().unwrap_or_default();
    let blank = |value: &Option<String>| value.as_deref().is_none_or(|v| v.trim().is_empty());
    Adds {
        nickname: card.nickname.clone().filter(|_| blank(&nickname)),
        role: card.role.clone().filter(|_| blank(&role)),
        birthday: card.birthday.clone().filter(|_| blank(&birthday)),
        points: card
            .points
            .iter()
            .enumerate()
            .filter(|(_, point)| {
                !reach_key(point.kind, &point.value).is_empty()
                    && !known.points.contains(&(
                        person.to_owned(),
                        point.kind.to_owned(),
                        reach_key(point.kind, &point.value),
                    ))
            })
            .map(|(index, _)| index)
            .collect(),
    }
}

/// A CARD THAT REPEATS AN EARLIER ONE'S NAME IN THE SAME FILE IS THAT PERSON (#1202), by the rule the
/// vault is matched by. It is folded into the first: what that one leaves blank is filled and the
/// points it lacks are added (capped at [`vcard::MAX_POINTS`]), so a second number is not lost with
/// the card that carried it. A shared number alone is not a repeat (a household's landline is two
/// people). Each card is looked up by hash, so a file of thousands is one pass.
fn merge_repeats(cards: Vec<Card>) -> (Vec<Card>, usize) {
    let mut kept: Vec<Card> = Vec::new();
    let mut by_name: HashMap<String, usize> = HashMap::new();
    let mut repeated = 0;
    for card in cards {
        let name_key = crate::model::fold_label(&card.name);
        let Some(&index) = by_name.get(&name_key) else {
            by_name.insert(name_key, kept.len());
            kept.push(card);
            continue;
        };
        repeated += 1;
        let first = &mut kept[index];
        first.nickname = first.nickname.take().or(card.nickname);
        first.role = first.role.take().or(card.role);
        first.birthday = first.birthday.take().or(card.birthday);
        let mut held: BTreeSet<(&'static str, String)> = first
            .points
            .iter()
            .map(|point| (point.kind, reach_key(point.kind, &point.value)))
            .collect();
        for point in card.points {
            if first.points.len() >= vcard::MAX_POINTS {
                break;
            }
            if held.insert((point.kind, reach_key(point.kind, &point.value))) {
                first.points.push(point);
            }
        }
    }
    (kept, repeated)
}

fn write_points(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    card: &Card,
    which: &[usize],
) -> Result<()> {
    for &index in which {
        let point = &card.points[index];
        let key = reach_key(point.kind, &point.value);
        ctx.connection().execute(
            "INSERT OR IGNORE INTO contact_point (id, person_id, kind, value, normalized, label, preferred, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0,
                     (SELECT COALESCE(MAX(position), 0) + 1 FROM contact_point WHERE person_id = ?2))",
            rusqlite::params![ctx.next_id(), person, point.kind, point.value.trim(), key, point.label],
        )?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct ImportVcfInput {
    cards: Option<String>,
    dry_run: Option<bool>,
    merge: Option<bool>,
}

/// `person.import_vcf`: read vCards as people. A card that names someone the vault already has
/// (by name, or by a number or an address) is a **proposal to merge**: it fills what that person
/// leaves blank and adds the points they lack, and replaces nothing. With `dry_run` it writes
/// nothing and answers what importing would do, which is the preview the member confirms; with
/// `merge: false` the matches are left alone and only new people are added. Importing a file
/// twice adds nothing: the second time every card is the person the first made.
fn import_vcf(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ImportVcfInput = ctx.parse_input()?;
    let dry_run = input.dry_run.unwrap_or(false);
    let merge = input.merge.unwrap_or(true);
    let parsed_cards = input
        .cards
        .as_deref()
        .map(vcard::parse)
        .unwrap_or_default()
        .into_iter()
        .take(VCARD_MAX)
        .collect();
    let (cards, repeated) = merge_repeats(parsed_cards);
    // MATCHED AGAINST THE VAULT AS IT WAS, never against what this file has written, so the
    // preview and the write agree card for card.
    let known = known_people(ctx)?;
    let (mut added, mut merged, mut unchanged, mut declined) = (0, 0, 0, 0);
    let mut proposals: Vec<String> = Vec::new();
    for card in &cards {
        let name_key = crate::model::fold_label(&card.name);
        match match_of(&known, card) {
            Some(person) => {
                let adds = adds_of(&known, &person, card);
                if adds.count() == 0 {
                    unchanged += 1;
                } else if !merge {
                    declined += 1;
                } else {
                    merged += 1;
                    if proposals.len() < 5 {
                        // Whom it merges into, when that is not the name the card carries: a
                        // number or an address can name a different person.
                        let into = known.titles.get(&person).cloned().unwrap_or_default();
                        proposals.push(
                            if crate::model::fold_label(&into) == name_key || into.is_empty() {
                                card.name.clone()
                            } else {
                                format!("{} → {into}", card.name)
                            },
                        );
                    }
                    if !dry_run {
                        let c = ctx.connection();
                        c.execute(
                            "UPDATE person SET nickname = COALESCE(nickname, ?2), role = COALESCE(role, ?3),
                                    birthday = COALESCE(birthday, ?4) WHERE id = ?1",
                            rusqlite::params![person, adds.nickname, adds.role, adds.birthday],
                        )?;
                        write_points(ctx, &person, card, &adds.points)?;
                    }
                }
            }
            None => {
                added += 1;
                if !dry_run {
                    let id = found(
                        ctx,
                        &NewPerson {
                            id: None,
                            title: &card.name,
                            form: None,
                            nickname: card.nickname.as_deref(),
                            role: card.role.as_deref(),
                            met: None,
                            birthday: card.birthday.as_deref(),
                            cadence_days: None,
                        },
                    )?;
                    write_points(ctx, &id, card, &(0..card.points.len()).collect::<Vec<_>>())?;
                    arrival::record(ctx, &id, Kind::Person)?;
                }
            }
        }
    }
    Ok(serde_json::json!({
        "cards": cards.len() + repeated,
        "added": added,
        "merged": merged,
        "unchanged": unchanged,
        "declined": declined,
        "repeated": repeated,
        "proposals": proposals,
        "dry_run": dry_run,
    }))
}

#[derive(serde::Deserialize)]
struct ExportVcfInput {
    list_id: Option<String>,
    person_id: Option<String>,
}

/// `person.export_vcf`: everyone, one list's people, or one person (`person_id`, what a detail
/// page shares) as vCards in one file. Writes nothing.
/// The owner's own card is not in it: it is the member's, not someone to add to another book.
fn export_vcf(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ExportVcfInput = ctx.parse_input()?;
    let list = input.list_id.as_deref();
    let person = input.person_id.as_deref();
    let mut file_name = "People".to_owned();
    if let Some(list) = list.or(person) {
        let title: Option<String> = ctx
            .connection()
            .query_row("SELECT title FROM entity WHERE id = ?1", [list], |row| {
                row.get(0)
            })
            .ok();
        file_name = title.map_or_else(|| "People".to_owned(), |t| note::portable_stem(&t));
    }
    let (text, count) = vcard_file(ctx.connection(), list, person)?;
    Ok(serde_json::json!({
        "name": format!("{file_name}.vcf"),
        "media_type": "text/vcard",
        "count": count,
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text),
    }))
}

/// The vCards of everyone (or one list's people, or one person) as one file's text and how many
/// cards it holds. `person.export_vcf` answers it; the whole-vault export writes the same text
/// as `People/people.vcf`.
pub(crate) fn vcard_file(
    connection: &rusqlite::Connection,
    list: Option<&str>,
    person: Option<&str>,
) -> Result<(String, usize)> {
    let mut people = connection.prepare_cached(
        "SELECT e.id, e.title, p.nickname, p.role, p.birthday
           FROM entity e JOIN person p ON p.id = e.id
          WHERE e.kind = 'person' AND e.deleted_at IS NULL AND e.id IS NOT (SELECT self_id FROM vault)
            AND (?1 IS NULL OR e.id IN (SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains'))
            AND (?2 IS NULL OR e.id = ?2)
          ORDER BY e.title COLLATE NOCASE, e.created_at, e.id",
    )?;
    let rows = people
        .query_map(rusqlite::params![list, person], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut points = connection.prepare_cached(
        "SELECT kind, value, label FROM contact_point WHERE person_id = ?1 ORDER BY position",
    )?;
    let mut text = String::new();
    for (id, title, nickname, role, birthday) in &rows {
        let reached = points
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        text.push_str(&vcard::write(&Card {
            name: title.clone(),
            nickname: nickname.clone().filter(|n| !n.trim().is_empty()),
            role: role.clone().filter(|r| !r.trim().is_empty()),
            birthday: birthday.clone(),
            points: reached
                .into_iter()
                .filter_map(|(kind, value, label)| {
                    Some(vcard::Point {
                        kind: match kind.as_str() {
                            "phone" => "phone",
                            "email" => "email",
                            "address" => "address",
                            "url" => "url",
                            _ => return None,
                        },
                        value,
                        label,
                    })
                })
                .collect(),
        }));
    }
    Ok((text, rows.len()))
}

fn permanent(mut definition: CommandDefinition) -> CommandDefinition {
    definition.risk = Risk::Medium;
    definition.confirm = true;
    definition
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "person.import_vcf",
            "person",
            concat!(
                r#"{
              "type": "object",
              "required": ["cards"],
              "additionalProperties": false,
              "properties": {
                "cards": { "type": "string", "maxLength": 20971520 },
                "dry_run": { "type": "boolean" },
                "merge": { "type": "boolean" },
                "#,
                arrival::arrived_property!(),
                r#"
              }
            }"#
            ),
            Idempotency::Idempotent,
            &[],
            import_vcf,
        ),
        CommandDefinition::plain(
            "person.export_vcf",
            "person",
            r#"{
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "list_id": { "type": ["string", "null"] },
                "person_id": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            &[],
            export_vcf,
        ),
        CommandDefinition::plain(
            "person.add",
            "person",
            ADD,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "person_can_be_added",
                check: pre_add,
            }],
            add,
        ),
        CommandDefinition::plain(
            "person.edit",
            "person",
            EDIT,
            Idempotency::Idempotent,
            &[
                entity::STALE_GUARD[0],
                entity::STALE_GUARD[1],
                CommandCondition {
                    predicate: "person_can_be_edited",
                    check: pre_edit,
                },
            ],
            edit,
        ),
        CommandDefinition::plain(
            "person.move",
            "person",
            MOVE,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "person_can_be_filed",
                check: pre_move,
            }],
            move_person,
        ),
        CommandDefinition::plain(
            "person.log_interaction",
            "person",
            LOG,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "touch_is_about_a_person",
                check: pre_log,
            }],
            log_interaction,
        ),
        CommandDefinition::plain(
            "person.add_note",
            "person",
            TEXT,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "note_is_about_a_person",
                check: pre_text_about_a_person,
            }],
            add_note,
        ),
        CommandDefinition::plain(
            "person.add_journal_entry",
            "person",
            JOURNAL,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "entry_is_dated",
                check: pre_journal,
            }],
            add_journal_entry,
        ),
        CommandDefinition::plain(
            "person.add_task",
            "person",
            TEXT,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "task_is_about_a_person",
                check: pre_text_about_a_person,
            }],
            add_task,
        ),
        CommandDefinition::plain(
            "person.add_gift",
            "person",
            TEXT,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "gift_is_for_a_person",
                check: pre_text_about_a_person,
            }],
            add_gift,
        ),
        CommandDefinition::plain(
            "person.add_date",
            "person",
            DATE,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "date_is_a_day",
                check: pre_date,
            }],
            add_date,
        ),
        CommandDefinition::plain(
            "person.add_relationship",
            "person",
            RELATIONSHIP,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "relative_is_another_person",
                check: pre_relationship,
            }],
            add_relationship,
        ),
        permanent(CommandDefinition::plain(
            "person.merge",
            "person",
            MERGE,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "both_are_people",
                check: pre_merge,
            }],
            merge,
        )),
    ]
}
