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
//! by walking what the file says points at a person (the foreign keys into
//! `person`, read from `PRAGMA foreign_key_list`) and the `edge` table, and
//! then the merged person is purged. Nothing here lists a renting table: a
//! table added tomorrow that points at `person` is merged correctly today.
//!
//! What a merge keeps when both people say something: the surviving person's
//! own value wins, and a blank is filled from the merged person; a contact
//! point both have is kept once; a daily measurement both have is the
//! surviving person's. The merged person's source, if it was followed, becomes
//! a tombstone with the purge (`source.entity_id` nulls itself), so the contact
//! follower never adds the same contact again.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::edge::{self, Extras};
use crate::commands::entity::{find, lookup_live, purge_one};
use crate::commands::event::{self, NewEvent};
use crate::commands::note;
use crate::commands::tag::{ensure_concept, set_tagged};
use crate::commands::task::{self, NewTask};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
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

fn merge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let connection = ctx.connection();
    let (loser, winner) = (ctx.required_str("from")?, ctx.required_str("into")?);

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
    // The notes about the merged person are about the survivor now.
    ctx.mark_for_index(winner);

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
    for (table, column) in person_references(connection)? {
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
    ctx.touch(winner)?;
    Ok(serde_json::json!({ "into": winner, "edges": moved, "rows": repointed }))
}

/// Every `(table, column)` with a foreign key into `person(id)`, but the
/// person's own kind-row link to its entity.
fn person_references(connection: &rusqlite::Connection) -> Result<Vec<(String, String)>> {
    let tables: Vec<String> = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'person'
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
                Ok((row.get::<_, String>(2)?, row.get::<_, String>(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        found.extend(
            rows.into_iter()
                .filter(|(target, _)| target == "person")
                .map(|(_, column)| (table.clone(), column)),
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

fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = found(
        ctx,
        &NewPerson {
            id: ctx.optional_str("id"),
            title: ctx.required_str("title")?,
            form: ctx.optional_str("form"),
            nickname: ctx.optional_str("nickname"),
            role: ctx.optional_str("role"),
            met: ctx.optional_str("met"),
            birthday: ctx.optional_str("birthday"),
            cadence_days: ctx.input.get("cadence_days").and_then(Json::as_i64),
        },
    )?;
    if let Some(list) = ctx.optional_str("list_id") {
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

/// The columns a person's edit sets as text. A key that is present is set (a
/// `null` or a blank clears it); a key that is absent is left alone.
const TEXT_COLUMNS: [&str; 5] = ["sort_name", "nickname", "role", "met", "birthday"];

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (connection, id) = (ctx.connection(), ctx.required_str("id")?);
    if let Some(title) = ctx.optional_str("title") {
        connection.execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.trim()],
        )?;
    }
    for column in TEXT_COLUMNS {
        if let Some(value) = ctx.input.get(column) {
            let text = value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            connection.execute(
                &format!("UPDATE person SET {column} = ?2 WHERE id = ?1"),
                rusqlite::params![id, text],
            )?;
        }
    }
    if let Some(days) = ctx.input.get("cadence_days") {
        connection.execute(
            "UPDATE person SET cadence_days = ?2 WHERE id = ?1",
            rusqlite::params![id, days.as_i64().filter(|days| *days > 0)],
        )?;
    }
    ctx.touch(id)?;
    Ok(json!({ "id": id }))
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

/// A person is in one list at a time (or none): filing them somewhere takes
/// them out of the list they were in.
fn move_person(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    ctx.connection().execute(
        "DELETE FROM edge WHERE rel = 'contains' AND to_id = ?1
            AND from_id IN (SELECT id FROM container WHERE kind = 'list')",
        [id],
    )?;
    if let Some(list) = ctx.optional_str("list_id") {
        edge::put(ctx, list, Rel::Contains, id, None, &Extras::default())?;
    }
    Ok(json!({ "id": id, "list_id": ctx.optional_str("list_id") }))
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

/// A touch: an `activity` of an activity kind, `with` the person, starting now.
/// The words kept of it are a note `about` the activity.
fn log_interaction(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (connection, person) = (ctx.connection(), ctx.required_str("id")?);
    let kind = ensure_concept(ctx, Kind::ActivityKind, ctx.required_str("kind")?)?;
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
    if let Some(text) = ctx.optional_str("text").filter(|t| !t.trim().is_empty()) {
        let words = note::found(ctx, None, &title, text, "plain", None)?;
        edge::put(ctx, &words, Rel::About, &activity, None, &Extras::default())?;
    }
    Ok(json!({ "interaction_id": activity }))
}

/// A note about a person: a `note` with an `about` edge, so it is found with them.
fn add_note(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let text = ctx.required_str("text")?;
    let words = note::found(ctx, None, &headline(text), text, "plain", None)?;
    edge::put(
        ctx,
        &words,
        Rel::About,
        ctx.required_str("id")?,
        None,
        &Extras::default(),
    )?;
    Ok(json!({ "note_id": words }))
}

fn pre_journal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("mood")?.trim().is_empty() || ctx.required_str("text")?.trim().is_empty() {
        return Ok(Some("a journal entry needs a mood and a line".to_owned()));
    }
    Ok(journal_stamp(ctx).err())
}

/// A journal entry: a note about the owner, titled by its mood, filed on its own
/// day.
fn add_journal_entry(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let filed_at = journal_stamp(ctx).map_err(|detail| VaultError::InvalidInput {
        name: "entry_date".to_owned(),
        detail,
    })?;
    let owner: String = ctx
        .connection()
        .query_row("SELECT self_id FROM vault", [], |row| row.get(0))?;
    let entry = note::found(
        ctx,
        None,
        ctx.required_str("mood")?,
        ctx.required_str("text")?,
        "plain",
        None,
    )?;
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
    let id = task::found(
        ctx,
        &NewTask {
            title: ctx.required_str("text")?,
            ..NewTask::default()
        },
    )?;
    edge::put(
        ctx,
        &id,
        Rel::About,
        ctx.required_str("id")?,
        None,
        &Extras::default(),
    )?;
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

/// An important date. The birthday is the person's own column; any other is a
/// yearly all-day `event` `about` them (R-FP-2), which Agenda shows on its day.
fn add_date(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (person, label) = (ctx.required_str("id")?, ctx.required_str("label")?.trim());
    let month_day = ctx.required_str("month_day")?;
    if crate::model::fold_label(label) == "birthday" {
        ctx.connection().execute(
            "UPDATE person SET birthday = CASE WHEN length(birthday) = 10 AND substr(birthday, 6) = ?2
                                               THEN birthday ELSE ?2 END
              WHERE id = ?1",
            [person, month_day],
        )?;
        ctx.touch(person)?;
        return Ok(json!({ "id": person }));
    }
    let year: i64 = ctx
        .now
        .get(0..4)
        .and_then(|y| y.parse().ok())
        .unwrap_or(2000);
    let starts = format!("{}-{month_day}", first_year_with(year, month_day));
    let reminded = ctx
        .input
        .get("reminder_on")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let date = event::found(
        ctx,
        &NewEvent {
            title: label,
            starts: &starts,
            timing: Semantics::AllDay,
            rule: Some("FREQ=YEARLY"),
            reminders: reminded.then_some("[0]"),
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
              WHERE e.deleted_at IS NULL AND p.form = ?1 AND e.title = ?2 COLLATE NOCASE
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

/// A `related` edge from the person to a relative, labelled by what the relative
/// is to them. A relative not yet in the vault is founded: a pet is a person of
/// form `pet` whose `role` is its species.
fn add_relationship(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let pet = ctx.optional_str("pet");
    let target = match relative(ctx)? {
        Some(id) => id,
        None => found(
            ctx,
            &NewPerson {
                title: ctx.required_str("name")?,
                form: pet.map(|_| "pet"),
                role: pet,
                ..NewPerson::default()
            },
        )?,
    };
    let label = ensure_concept(ctx, Kind::Relation, ctx.required_str("kind")?)?;
    edge::put(
        ctx,
        ctx.required_str("id")?,
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
    "cadence_days": { "type": ["integer", "null"], "minimum": 0 }
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

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
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
            &[CommandCondition {
                predicate: "person_can_be_edited",
                check: pre_edit,
            }],
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
        CommandDefinition::plain(
            "person.merge",
            "person",
            MERGE,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "both_are_people",
                check: pre_merge,
            }],
            merge,
        ),
    ]
}
