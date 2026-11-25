//! `person.*`: a person's own verbs: add, edit, an avatar, file in a list, write about them, relate
//! them; vCards and spreadsheets in and out; and `person.merge`, two people who are one.
//!
//! A person is an entity of kind `person`; what a member records about them is other rows joined
//! to it. Their **dates** (the birthday and every other) are `person_date` rows
//! ([`super::person_date`]), their **contact points** are `contact_point` rows
//! ([`super::contact_point`]), a **touch** (a call, a message, a meet-up) is its own kind joined
//! `with` them ([`super::touch`]) and last contacted is computed at read from those; the words
//! kept about them are a note `about` them; a relationship is a `related` edge labelled by a
//! relation concept; a list holds a person with a `contains` edge. What is not People's alone is a
//! shared verb (`entity.trash`, `entity.restore`, `tag.add`, `edge.add`, `reminder.add`) and not
//! wrapped here. People is in no list of its own: it is found by search, by its earlier versions
//! and by [`in_your_vault`], which lists what a person is linked to, a Locker item like any other.
//!
//! **A person is a followed record, with several sources.** The phone's contacts are followed
//! ([`CONTACTS`] is its map in the follow engine); a vCard or a spreadsheet is an arrival
//! (`arrived_via`), not an origin. A followed person is edited field by field and the phone's own
//! word stays readable (`follow::differences`: "Phone says X").
//!
//! **A merge is confirmed** and ends a person for good. It keeps everything of the one that goes
//! ([`merge`]): every followed source (`follow::move_sources`), every link, edge and mention with
//! no duplicate in either direction (`links::repoint`), every date, contact point, invitation,
//! touch, reading and measurement; and then purges the one that goes. The owner is never merged
//! away, trashed, purged or made a followed record.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::contact_point::{self, reach_key};
use crate::commands::edge::{self, Extras};
use crate::commands::entity::{self, find, lookup_live, purge_one};
use crate::commands::follow::{self, Child, Gone, Match, SystemMap};
use crate::commands::note::{self, Founding};
use crate::commands::person_date;
use crate::commands::person_portable::{self as portable, Card, CardDate, Point};
use crate::commands::tag::ensure_concept;
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk, arrival, reminder,
};
use crate::error::{Result, VaultError};
use crate::links;
use crate::model::{Kind, Rel};

// ---------------------------------------------------------------------------
// The phone's contacts, followed
// ---------------------------------------------------------------------------

/// What a contact record states that is not a row of its own.
fn contact_shape(
    _: &CommandCtx<'_, '_>,
    fields: &mut serde_json::Map<String, Json>,
) -> std::result::Result<(), String> {
    // A contact with no name is no person (the kind needs one): the record is counted and left out.
    match fields.get("title").and_then(Json::as_str) {
        Some(title) if !title.trim().is_empty() => {}
        _ => return Err("a contact needs a name".to_owned()),
    }
    // A phone's own words for a blank are no word.
    for (_, value) in fields.iter_mut() {
        if let Json::String(text) = value
            && text.trim().is_empty()
        {
            *value = Json::Null;
        }
    }
    Ok(())
}

fn no_defaults(
    _: &Connection,
    _: &follow::OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(Vec::new())
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

/// The phone's contacts as the follow engine reads them (`follow.contacts`): a person's names,
/// organisation and role, their contact points and their dates. What the member set themselves
/// (how they met, a cadence, the avatar) is not the phone's to say.
pub const CONTACTS: SystemMap = SystemMap {
    system: "contacts",
    command: "follow.contacts",
    kind: Kind::Person,
    claims: None,
    fields: &[
        "form",
        "sort_name",
        "given",
        "family",
        "phonetic",
        "nickname",
        "role",
        "org",
    ],
    fixed: &[],
    children: &[
        Child {
            name: "points",
            read: contact_point::read,
            canon: contact_point::canon,
            merge: contact_point::merge,
            items: Some(contact_point::items),
            take: contact_point::take,
            stamp: None,
        },
        Child {
            name: "dates",
            read: person_date::read,
            canon: person_date::canon,
            merge: person_date::merge,
            items: Some(person_date::items),
            take: person_date::take,
            stamp: None,
        },
    ],
    match_on: &[Match::Title],
    gone: Gone::Trash,
    window: None,
    defaults: no_defaults,
    founds: None,
    shape: contact_shape,
    settle: nothing_to_settle,
    named: nothing_to_settle,
};

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

/// A sentence when this is not a form a person row can be (`person_form`).
fn form_refusal(connection: &Connection, form: &str) -> Result<Option<String>> {
    let known: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM person_form WHERE code = ?1)",
        [form],
        |row| row.get(0),
    )?;
    Ok((!known).then(|| format!("“{form}” is not a kind of person")))
}

/// What a new person is told. A form of `None` is the first one the lookup holds that a plain
/// person is (the column's default); a pet's `role` is its species.
#[derive(Default)]
pub struct NewPerson<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub form: Option<&'a str>,
    pub given: Option<&'a str>,
    pub family: Option<&'a str>,
    pub phonetic: Option<&'a str>,
    pub nickname: Option<&'a str>,
    pub org: Option<&'a str>,
    pub role: Option<&'a str>,
    pub met: Option<&'a str>,
    pub cadence_days: Option<i64>,
}

/// Found a person: the entity and the kind row. Returns its id. A value that is blank is no value.
///
/// # Errors
/// SQLite's refusal (a blank name among them).
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
        "INSERT INTO person (id, given, family, phonetic, nickname, org, role, met, cadence_days)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            id,
            blank(person.given),
            blank(person.family),
            blank(person.phonetic),
            blank(person.nickname),
            blank(person.org),
            blank(person.role),
            blank(person.met),
            person.cadence_days.filter(|days| *days > 0),
        ],
    )?;
    // A form the caller names; else the column's own default.
    if let Some(form) = person.form {
        ctx.connection().execute(
            "UPDATE person SET form = ?2 WHERE id = ?1",
            [id.as_str(), form],
        )?;
    }
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
    if let Some(form) = ctx.optional_str("form")
        && let Some(sentence) = form_refusal(ctx.connection(), form)?
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
    given: Option<String>,
    family: Option<String>,
    phonetic: Option<String>,
    nickname: Option<String>,
    org: Option<String>,
    role: Option<String>,
    met: Option<String>,
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
            given: input.given.as_deref(),
            family: input.family.as_deref(),
            phonetic: input.phonetic.as_deref(),
            nickname: input.nickname.as_deref(),
            org: input.org.as_deref(),
            role: input.role.as_deref(),
            met: input.met.as_deref(),
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
    match ctx.optional_str("form") {
        Some(form) => form_refusal(ctx.connection(), form),
        None => Ok(None),
    }
}

#[derive(serde::Deserialize)]
struct EditPersonInput {
    id: String,
    title: Option<String>,
    form: Option<String>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    sort_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    given: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    family: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    phonetic: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    nickname: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    role: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    org: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    met: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    cadence_days: Option<Option<i64>>,
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditPersonInput = ctx.parse_input()?;
    let (connection, id) = (ctx.connection(), input.id.as_str());
    if let Some(title) = input.title.as_deref() {
        entity::rename(ctx, id, title.trim())?;
    }
    if let Some(form) = input.form.as_deref() {
        connection.execute("UPDATE person SET form = ?2 WHERE id = ?1", [id, form])?;
    }
    for (column, patch) in [
        ("sort_name", input.sort_name),
        ("given", input.given),
        ("family", input.family),
        ("phonetic", input.phonetic),
        ("nickname", input.nickname),
        ("role", input.role),
        ("org", input.org),
        ("met", input.met),
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
// The avatar
// ---------------------------------------------------------------------------

fn pre_avatar(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_live_person(ctx)? {
        return Ok(Some(sentence));
    }
    let Some(hash) = ctx.optional_str("blob") else {
        return Ok(None);
    };
    if ctx.blobs().is_none() {
        return Ok(Some(
            "this vault has nowhere to keep a file's bytes".to_owned(),
        ));
    }
    let held = ctx
        .blobs()
        .is_some_and(|store| crate::blob::is_hash(hash) && store.has(hash).unwrap_or(false));
    Ok((!held).then(|| "those bytes are not in this vault's store".to_owned()))
}

/// Set a person's picture to bytes the store holds, or take it off (`blob` null). The picture a
/// version replaced is kept by that version (slot `avatar`), not collected here.
fn set_avatar(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let hash = ctx.optional_str("blob");
    if let (Some(hash), Some(store)) = (hash, ctx.blobs()) {
        let size = store.size(hash).map_err(|error| VaultError::Invariant {
            context: format!("the content store lost a file between a check and a write: {error}"),
        })?;
        crate::blob::stage(
            ctx.connection(),
            hash,
            i64::try_from(size).unwrap_or(i64::MAX),
        )?;
    }
    ctx.connection().execute(
        "UPDATE person SET avatar = ?2 WHERE id = ?1",
        rusqlite::params![id, hash],
    )?;
    ctx.touch(id)?;
    Ok(json!({ "id": id, "blob": hash }))
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

/// A person is in one list at a time (or none): filing them somewhere takes them out of the list
/// they were in.
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
    ctx.touch(id)?;
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
        &Founding {
            title: &headline(&input.text),
            body: &input.text,
            format: Some("plain"),
            ..Founding::default()
        },
    )?;
    edge::put(ctx, &words, Rel::About, &input.id, None, &Extras::default())?;
    Ok(json!({ "note_id": words }))
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/// The person a relationship names: the one given, else a live one of that name and form (two
/// "Mum"s is how a vault grows a duplicate nobody meant).
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

/// A `related` edge from the person to a relative, labelled by what the relative is to them. A
/// relative not yet in the vault is founded: a pet is a person of form `pet` whose `role` is its
/// species.
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

// ---------------------------------------------------------------------------
// "In your vault" (K2)
// ---------------------------------------------------------------------------

/// What a person is linked to in the vault, each thing once, in name order: a hand-made link
/// joins them to anything linkable, a Locker item as much as a note, and nothing here names a kind.
///
/// # Errors
/// SQLite's refusal.
pub fn in_your_vault(connection: &Connection, person: &str) -> Result<Vec<links::Linked>> {
    links::linked(connection, person)
}

// ---------------------------------------------------------------------------
// Merge (A8)
// ---------------------------------------------------------------------------

fn pre_merge(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (from, into) = (ctx.required_str("from")?, ctx.required_str("into")?);
    if from == into {
        return Ok(Some("a person cannot be merged into themselves".to_owned()));
    }
    let mut titles = Vec::new();
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
        titles.push(found.title);
    }
    if entity::is_self(ctx.connection(), from)? {
        return Ok(Some(
            "this is you; merge the other person into you instead".to_owned(),
        ));
    }
    // The owner is nobody's followed record: a person a phone's contacts state cannot become them.
    if entity::is_self(ctx.connection(), into)? {
        let followed: bool = ctx.connection().query_row(
            "SELECT EXISTS (SELECT 1 FROM source WHERE entity_id = ?1)",
            [from],
            |row| row.get(0),
        )?;
        if followed {
            return Ok(Some(format!(
                "“{}” is kept in step with your phone, and you are not a record of it; stop following them first",
                titles[0]
            )));
        }
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct MergePersonInput {
    from: String,
    into: String,
}

/// What a merge of the dates chose, for the screen to say.
#[derive(Default)]
struct DatesMerged {
    kept: usize,
    same: usize,
    /// The winner's single date that stood, and the loser's that became another date.
    moved: Vec<(String, String, String)>,
}

fn merge_dates(ctx: &CommandCtx<'_, '_>, loser: &str, winner: &str) -> Result<DatesMerged> {
    let connection = ctx.connection();
    let singles: BTreeSet<String> = connection
        .prepare_cached("SELECT code FROM person_date_kind WHERE single = 1")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let plain: String = connection.query_row(
        "SELECT code FROM person_date_kind WHERE single = 0 ORDER BY code DESC LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    let reminders = reminder::list(connection, loser)?;
    let mut done = DatesMerged::default();
    for date in person_date::of_person(connection, loser)? {
        let mine = person_date::of_person(connection, winner)?;
        let words = |label: &Option<String>| label.as_deref().map(crate::model::fold_label);
        let twin = mine.iter().find(|held| {
            held.kind == date.kind
                && held.date == date.date
                && words(&held.label) == words(&date.label)
        });
        let target = if let Some(twin) = twin {
            done.same += 1;
            twin.id.clone()
        } else {
            let held_single =
                singles.contains(&date.kind) && mine.iter().any(|held| held.kind == date.kind);
            let (kind, label) = if held_single {
                // Two birthdays: the winner's stands; the loser's is kept as another date, wearing
                // the word it had.
                let kept = mine
                    .iter()
                    .find(|held| held.kind == date.kind)
                    .map(|held| held.date.clone())
                    .unwrap_or_default();
                done.moved
                    .push((date.kind.clone(), kept, date.date.clone()));
                (
                    plain.clone(),
                    Some(date.label.clone().unwrap_or_else(|| date.kind.clone())),
                )
            } else {
                (date.kind.clone(), date.label.clone())
            };
            done.kept += 1;
            person_date::put(ctx, winner, &kind, label.as_deref(), &date.date)?
        };
        // Its reminders follow it to the date it became (a lead the date has already is one).
        for row in reminders
            .iter()
            .filter(|row| row.date_id.as_deref() == Some(&date.id))
        {
            if reminder::refusal(connection, winner, Some(&target), None, row.offset_min)?.is_none()
            {
                reminder::add(ctx, winner, Some(&target), None, row.offset_min)?;
            }
        }
    }
    Ok(done)
}

fn merge_points(connection: &Connection, loser: &str, winner: &str) -> Result<(usize, usize)> {
    // A kind the winner already has a preferred point of keeps theirs; a point both have is the
    // winner's (and takes the preference when only the loser's was preferred).
    connection.execute(
        "UPDATE contact_point SET preferred = 1
          WHERE person_id = ?2 AND preferred = 0
            AND NOT EXISTS (SELECT 1 FROM contact_point w WHERE w.person_id = ?2 AND w.kind = contact_point.kind AND w.preferred = 1)
            AND EXISTS (SELECT 1 FROM contact_point l WHERE l.person_id = ?1 AND l.kind = contact_point.kind
                         AND l.normalized = contact_point.normalized AND l.preferred = 1)",
        [loser, winner],
    )?;
    let same = connection.execute(
        "DELETE FROM contact_point WHERE person_id = ?1 AND EXISTS (
           SELECT 1 FROM contact_point w WHERE w.person_id = ?2
              AND w.kind = contact_point.kind AND w.normalized = contact_point.normalized)",
        [loser, winner],
    )?;
    connection.execute(
        "UPDATE contact_point SET preferred = 0
          WHERE person_id = ?1 AND preferred = 1
            AND EXISTS (SELECT 1 FROM contact_point w WHERE w.person_id = ?2 AND w.kind = contact_point.kind AND w.preferred = 1)",
        [loser, winner],
    )?;
    let base: f64 = connection.query_row(
        "SELECT COALESCE(MAX(position), 0) FROM contact_point WHERE person_id = ?1",
        [winner],
        |row| row.get(0),
    )?;
    let moved = connection.execute(
        "UPDATE contact_point SET person_id = ?2, position = position + ?3 WHERE person_id = ?1",
        rusqlite::params![loser, winner, base],
    )?;
    Ok((moved, same))
}

/// `person.merge`: the person `from` and the person `into` are one, and `into` stays. Everything
/// of `from` is put with `into` and then `from` is purged (its history goes with it: it is the
/// history of a person who no longer exists).
fn merge(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: MergePersonInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let (loser, winner) = (input.from.as_str(), input.into.as_str());

    // Blanks are filled from the person who goes; what the survivor says stands.
    connection.execute(
        "UPDATE person SET
           sort_name    = COALESCE(person.sort_name, l.sort_name),
           given        = COALESCE(person.given, l.given),
           family       = COALESCE(person.family, l.family),
           phonetic     = COALESCE(person.phonetic, l.phonetic),
           nickname     = COALESCE(person.nickname, l.nickname),
           role         = COALESCE(person.role, l.role),
           org          = COALESCE(person.org, l.org),
           met          = COALESCE(person.met, l.met),
           avatar       = COALESCE(person.avatar, l.avatar),
           cadence_days = COALESCE(person.cadence_days, l.cadence_days)
         FROM (SELECT * FROM person WHERE id = ?1) AS l
         WHERE person.id = ?2",
        [loser, winner],
    )?;

    // Every store that followed either is still followed, each against its own statement.
    // (The owner is nobody's record, so a person merged into the owner has none: the precondition
    // refuses a followed one.)
    let followed: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM source WHERE entity_id = ?1)",
        [loser],
        |row| row.get(0),
    )?;
    let sources = if followed {
        follow::move_sources(connection, loser, winner)?
    } else {
        0
    };
    // Every link, edge (a touch `with`, a list `contains`, a note `about`, a relation, a photo
    // `depicts`) and `[[mention]]`, with no duplicate in either direction.
    let repointed = links::repoint(connection, loser, winner)?;
    let dates = merge_dates(ctx, loser, winner)?;
    let (points, same_points) = merge_points(connection, loser, winner)?;
    // The invitations the loser was a guest of, and the readings and daily figures they own.
    let guests = connection.execute(
        "UPDATE event_guest SET person_id = ?2 WHERE person_id = ?1",
        [loser, winner],
    )?;
    let readings = connection.execute(
        "UPDATE reading SET person_id = ?2 WHERE person_id = ?1",
        [loser, winner],
    )?;
    // A day the survivor has a figure for is theirs; the rest move (the loser's leftovers go with
    // the purge).
    let measurements = connection.execute(
        "UPDATE OR IGNORE measurement SET person_id = ?2 WHERE person_id = ?1",
        [loser, winner],
    )?;

    let mut purged = Vec::new();
    purge_one(ctx, loser, &mut purged)?;
    ctx.touch(winner)?;
    ctx.mark_for_index(winner);
    Ok(json!({
        "into": winner,
        "sources": sources,
        "links": repointed.links,
        "edges": repointed.edges,
        "mentions": repointed.mentions,
        "dates": {
            "kept": dates.kept,
            "same": dates.same,
            "moved": dates.moved.iter().map(|(kind, kept, moved)| {
                json!({ "kind": kind, "kept": kept, "became_other": moved })
            }).collect::<Vec<_>>(),
        },
        "points": { "moved": points, "same": same_points },
        "guests": guests,
        "readings": readings,
        "measurements": measurements,
    }))
}

// ---------------------------------------------------------------------------
// Cards in and out (#1173, item 20): vCard files and spreadsheets share one import
// ---------------------------------------------------------------------------

/// The most cards one import takes.
const CARD_MAX: usize = 20_000;

/// A person's own fields a card may fill.
#[derive(Default, Clone)]
struct Fields {
    given: Option<String>,
    family: Option<String>,
    phonetic: Option<String>,
    nickname: Option<String>,
    org: Option<String>,
    role: Option<String>,
}

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
    /// A person's dates, as (kind, day), and the kinds that are held once per person.
    dates: BTreeSet<(String, String, String)>,
    singles: BTreeSet<String>,
}

fn known_people(ctx: &CommandCtx<'_, '_>) -> Result<Known> {
    let c = ctx.connection();
    let mut known = Known {
        by_name: BTreeMap::new(),
        titles: BTreeMap::new(),
        by_point: BTreeMap::new(),
        fields: BTreeMap::new(),
        points: BTreeSet::new(),
        dates: BTreeSet::new(),
        singles: c
            .prepare_cached("SELECT code FROM person_date_kind WHERE single = 1")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?,
    };
    let mut people = c.prepare_cached(
        "SELECT e.id, e.title, p.given, p.family, p.phonetic, p.nickname, p.org, p.role
           FROM entity e JOIN person p ON p.id = e.id
          WHERE e.kind = 'person' AND e.deleted_at IS NULL ORDER BY e.created_at, e.id",
    )?;
    let rows = people
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                Fields {
                    given: row.get(2)?,
                    family: row.get(3)?,
                    phonetic: row.get(4)?,
                    nickname: row.get(5)?,
                    org: row.get(6)?,
                    role: row.get(7)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, title, fields) in rows {
        known
            .by_name
            .entry(crate::model::fold_label(&title))
            .or_insert_with(|| id.clone());
        known.titles.insert(id.clone(), title);
        known.fields.insert(id, fields);
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
    let mut dates = c.prepare_cached(
        "SELECT d.person_id, d.kind, d.date FROM person_date d
           JOIN entity e ON e.id = d.person_id AND e.deleted_at IS NULL",
    )?;
    let rows = dates
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    known.dates.extend(rows);
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

/// What a card would add to the person it matches: the fields they leave blank, the dates and the
/// points they lack. Nothing already there is ever replaced.
struct Adds {
    fields: Fields,
    dates: Vec<usize>,
    points: Vec<usize>,
}

impl Adds {
    fn count(&self) -> usize {
        let f = &self.fields;
        [
            &f.given,
            &f.family,
            &f.phonetic,
            &f.nickname,
            &f.org,
            &f.role,
        ]
        .into_iter()
        .filter(|field| field.is_some())
        .count()
            + self.dates.len()
            + self.points.len()
    }
}

fn adds_of(known: &Known, person: &str, card: &Card) -> Adds {
    let held = known.fields.get(person).cloned().unwrap_or_default();
    let blank = |value: &Option<String>| value.as_deref().is_none_or(|v| v.trim().is_empty());
    let fill = |card: &Option<String>, held: &Option<String>| card.clone().filter(|_| blank(held));
    Adds {
        fields: Fields {
            given: fill(&card.given, &held.given),
            family: fill(&card.family, &held.family),
            phonetic: fill(&card.phonetic, &held.phonetic),
            nickname: fill(&card.nickname, &held.nickname),
            org: fill(&card.org, &held.org),
            role: fill(&card.role, &held.role),
        },
        dates: card
            .dates
            .iter()
            .enumerate()
            .filter(|(_, date)| {
                let has_kind = known
                    .dates
                    .iter()
                    .any(|(who, kind, _)| who == person && kind == date.kind);
                let same = known.dates.contains(&(
                    person.to_owned(),
                    date.kind.to_owned(),
                    date.date.clone(),
                ));
                !(same || (known.singles.contains(date.kind) && has_kind))
            })
            .map(|(index, _)| index)
            .collect(),
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

/// A CARD THAT REPEATS AN EARLIER ONE'S NAME IN THE SAME FILE IS THAT PERSON (#1202), by the rule
/// the vault is matched by. It is folded into the first: what that one leaves blank is filled and
/// the dates and points it lacks are added (capped), so a second number is not lost with the card
/// that carried it. A shared number alone is not a repeat (a household's landline is two people).
/// Each card is looked up by hash, so a file of thousands is one pass.
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
        first.given = first.given.take().or(card.given);
        first.family = first.family.take().or(card.family);
        first.phonetic = first.phonetic.take().or(card.phonetic);
        first.nickname = first.nickname.take().or(card.nickname);
        first.org = first.org.take().or(card.org);
        first.role = first.role.take().or(card.role);
        for date in card.dates {
            let single = date.kind == "birthday";
            let held = first
                .dates
                .iter()
                .any(|d| d.kind == date.kind && (single || d.date == date.date));
            if first.dates.len() < portable::MAX_DATES && !held {
                first.dates.push(date);
            }
        }
        let mut held: BTreeSet<(&'static str, String)> = first
            .points
            .iter()
            .map(|point| (point.kind, reach_key(point.kind, &point.value)))
            .collect();
        for point in card.points {
            if first.points.len() >= portable::MAX_POINTS {
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
             SELECT ?1, ?2, k.code, ?4, ?5, ?6, 0,
                    (SELECT COALESCE(MAX(position), 0) + 1 FROM contact_point WHERE person_id = ?2)
               FROM contact_point_kind k WHERE k.code = ?3",
            rusqlite::params![ctx.next_id(), person, point.kind, point.value.trim(), key, point.label],
        )?;
    }
    Ok(())
}

fn write_dates(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    dates: &[CardDate],
    which: &[usize],
) -> Result<()> {
    for &index in which {
        let date = &dates[index];
        let known: bool = ctx.connection().query_row(
            "SELECT EXISTS (SELECT 1 FROM person_date_kind WHERE code = ?1)",
            [date.kind],
            |row| row.get(0),
        )?;
        if known {
            person_date::put(ctx, person, date.kind, date.label.as_deref(), &date.date)?;
        }
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct ImportInput {
    cards: Option<String>,
    csv: Option<String>,
    dry_run: Option<bool>,
    merge: Option<bool>,
}

/// Read cards as people. A card that names someone the vault already has (by name, or by a number
/// or an address) is a **proposal to merge**: it fills what that person leaves blank and adds the
/// dates and points they lack, and replaces nothing. With `dry_run` it writes nothing and answers
/// what importing would do, which is the preview the member confirms; with `merge: false` the
/// matches are left alone and only new people are added. Importing a file twice adds nothing: the
/// second time every card is the person the first made. A person this makes **arrived** (their
/// `arrived_via` and file name); nothing follows the file.
fn import_cards(ctx: &CommandCtx<'_, '_>, parsed: Vec<Card>) -> Result<Json> {
    let input: ImportInput = ctx.parse_input()?;
    let dry_run = input.dry_run.unwrap_or(false);
    let merge = input.merge.unwrap_or(true);
    let (cards, repeated) = merge_repeats(parsed.into_iter().take(CARD_MAX).collect());
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
                        let f = &adds.fields;
                        ctx.connection().execute(
                            "UPDATE person SET given = COALESCE(given, ?2), family = COALESCE(family, ?3),
                                    phonetic = COALESCE(phonetic, ?4), nickname = COALESCE(nickname, ?5),
                                    org = COALESCE(org, ?6), role = COALESCE(role, ?7) WHERE id = ?1",
                            rusqlite::params![
                                person, f.given, f.family, f.phonetic, f.nickname, f.org, f.role
                            ],
                        )?;
                        write_dates(ctx, &person, &card.dates, &adds.dates)?;
                        write_points(ctx, &person, card, &adds.points)?;
                        ctx.touch(&person)?;
                    }
                }
            }
            None => {
                added += 1;
                if !dry_run {
                    let id = found(
                        ctx,
                        &NewPerson {
                            title: &card.name,
                            given: card.given.as_deref(),
                            family: card.family.as_deref(),
                            phonetic: card.phonetic.as_deref(),
                            nickname: card.nickname.as_deref(),
                            org: card.org.as_deref(),
                            role: card.role.as_deref(),
                            ..NewPerson::default()
                        },
                    )?;
                    write_dates(
                        ctx,
                        &id,
                        &card.dates,
                        &(0..card.dates.len()).collect::<Vec<_>>(),
                    )?;
                    write_points(ctx, &id, card, &(0..card.points.len()).collect::<Vec<_>>())?;
                    arrival::record(ctx, &id, Kind::Person)?;
                }
            }
        }
    }
    Ok(json!({
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

fn import_vcf(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ImportInput = ctx.parse_input()?;
    import_cards(
        ctx,
        portable::parse(input.cards.as_deref().unwrap_or_default()),
    )
}

fn import_csv(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ImportInput = ctx.parse_input()?;
    import_cards(
        ctx,
        portable::csv_parse(input.csv.as_deref().unwrap_or_default()),
    )
}

#[derive(serde::Deserialize)]
struct ExportInput {
    list_id: Option<String>,
    person_id: Option<String>,
}

/// A file name from a title: its words, joined by dashes.
fn file_stem(title: &str) -> String {
    let stem = title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if stem.is_empty() {
        "People".to_owned()
    } else {
        stem
    }
}

fn export(ctx: &CommandCtx<'_, '_>, csv: bool) -> Result<Json> {
    let input: ExportInput = ctx.parse_input()?;
    let (list, person) = (input.list_id.as_deref(), input.person_id.as_deref());
    let mut file_name = "People".to_owned();
    if let Some(of) = list.or(person) {
        let title: Option<String> = ctx
            .connection()
            .query_row("SELECT title FROM entity WHERE id = ?1", [of], |row| {
                row.get(0)
            })
            .ok();
        file_name = title.map_or_else(|| "People".to_owned(), |t| file_stem(&t));
    }
    let cards = cards_of(ctx.connection(), list, person, false)?;
    let (text, extension, media_type) = if csv {
        (portable::csv_write(&cards), "csv", "text/csv")
    } else {
        (
            cards.iter().map(portable::write).collect::<String>(),
            "vcf",
            "text/vcard",
        )
    };
    Ok(json!({
        "name": format!("{file_name}.{extension}"),
        "media_type": media_type,
        "count": cards.len(),
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text),
    }))
}

fn export_vcf(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    export(ctx, false)
}

fn export_csv(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    export(ctx, true)
}

/// The vCards of everyone (or one list's people, or one person) as one file's text and how many
/// cards it holds. `person.export_vcf` answers it; the whole-vault export writes the same text
/// as `People/people.vcf`. The owner's own card is not in it: it is the member's, not someone to
/// add to another book.
///
/// # Errors
/// SQLite's refusal.
pub fn vcard_file(
    connection: &Connection,
    list: Option<&str>,
    person: Option<&str>,
) -> Result<(String, usize)> {
    let cards = cards_of(connection, list, person, false)?;
    Ok((cards.iter().map(portable::write).collect(), cards.len()))
}

/// The aggregate's People folder includes the member's own saved card too.
pub fn vcard_file_for_vault(connection: &Connection) -> Result<(String, usize)> {
    let cards = cards_of(connection, None, None, true)?;
    Ok((cards.iter().map(portable::write).collect(), cards.len()))
}

/// The cards of the people asked for, in name order.
fn cards_of(
    connection: &Connection,
    list: Option<&str>,
    person: Option<&str>,
    include_owner: bool,
) -> Result<Vec<Card>> {
    let mut people = connection.prepare_cached(
        "SELECT e.id, e.title, p.given, p.family, p.phonetic, p.nickname, p.org, p.role
           FROM entity e JOIN person p ON p.id = e.id
          WHERE e.kind = 'person' AND e.deleted_at IS NULL
            AND (?3 OR e.id IS NOT (SELECT self_id FROM vault))
            AND (?1 IS NULL OR e.id IN (SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains'))
            AND (?2 IS NULL OR e.id = ?2)
          ORDER BY e.title COLLATE NOCASE, e.created_at, e.id",
    )?;
    let rows = people
        .query_map(rusqlite::params![list, person, include_owner], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Card {
                    name: row.get(1)?,
                    given: row.get(2)?,
                    family: row.get(3)?,
                    phonetic: row.get(4)?,
                    nickname: row.get(5)?,
                    org: row.get(6)?,
                    role: row.get(7)?,
                    ..Card::default()
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut points = connection.prepare_cached(
        "SELECT kind, value, label FROM contact_point WHERE person_id = ?1 ORDER BY position",
    )?;
    let mut cards = Vec::with_capacity(rows.len());
    for (id, mut card) in rows {
        let blank = |value: &mut Option<String>| {
            if value.as_deref().is_some_and(|v| v.trim().is_empty()) {
                *value = None;
            }
        };
        for field in [
            &mut card.given,
            &mut card.family,
            &mut card.phonetic,
            &mut card.nickname,
            &mut card.org,
            &mut card.role,
        ] {
            blank(field);
        }
        card.dates = person_date::of_person(connection, &id)?
            .into_iter()
            .map(|date| CardDate {
                kind: match date.kind.as_str() {
                    "birthday" => "birthday",
                    "anniversary" => "anniversary",
                    _ => "other",
                },
                date: date.date,
                label: date.label,
            })
            .collect();
        card.points = points
            .query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|(kind, value, label)| {
                Some(Point {
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
            .collect();
        cards.push(card);
    }
    Ok(cards)
}

fn permanent(mut definition: CommandDefinition) -> CommandDefinition {
    definition.risk = Risk::Medium;
    definition.confirm = true;
    definition
}

const ADD: &str = r#"{
  "type": "object",
  "required": ["title"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "minLength": 1 },
    "form": { "type": "string", "minLength": 1 },
    "given": { "type": "string" },
    "family": { "type": "string" },
    "phonetic": { "type": "string" },
    "nickname": { "type": "string" },
    "org": { "type": "string" },
    "role": { "type": "string" },
    "met": { "type": "string" },
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
    "form": { "type": "string", "minLength": 1 },
    "sort_name": { "type": ["string", "null"] },
    "given": { "type": ["string", "null"] },
    "family": { "type": ["string", "null"] },
    "phonetic": { "type": ["string", "null"] },
    "nickname": { "type": ["string", "null"] },
    "role": { "type": ["string", "null"] },
    "org": { "type": ["string", "null"] },
    "met": { "type": ["string", "null"] },
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

const TEXT: &str = r#"{
  "type": "object",
  "required": ["id", "text"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "text": { "type": "string", "minLength": 1 }
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

const AVATAR: &str = r#"{
  "type": "object",
  "required": ["id"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "blob": { "type": ["string", "null"] }
  }
}"#;

const EXPORT: &str = r#"{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "list_id": { "type": ["string", "null"] },
    "person_id": { "type": ["string", "null"] }
  }
}"#;

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
            "person.import_csv",
            "person",
            concat!(
                r#"{
              "type": "object",
              "required": ["csv"],
              "additionalProperties": false,
              "properties": {
                "csv": { "type": "string", "maxLength": 20971520 },
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
            import_csv,
        ),
        CommandDefinition::plain(
            "person.export_vcf",
            "person",
            EXPORT,
            Idempotency::Idempotent,
            &[],
            export_vcf,
        ),
        CommandDefinition::plain(
            "person.export_csv",
            "person",
            EXPORT,
            Idempotency::Idempotent,
            &[],
            export_csv,
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
            "person.set_avatar",
            "person",
            AVATAR,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "avatar_is_bytes_the_store_holds",
                check: pre_avatar,
            }],
            set_avatar,
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
