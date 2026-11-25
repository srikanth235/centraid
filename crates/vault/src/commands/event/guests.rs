//! An event's guests (A6): who it invited, whether or not they are in People.
//!
//! A guest is an `event_guest` row whose identity on the event is its ADDRESS (an email, lower
//! case): somebody with no row in People is still a guest, and `person_id` is only the person the
//! address resolves to (a live person's email point), re-pointed by `person.merge` and set NULL by
//! the database when that person is purged. One guest may be the organizer; the database holds that
//! with a partial unique index.
//!
//! Also the followed calendar's `attendees` field (a phone states `{name, email, state}` per guest):
//! merged per guest by address, so a guest the member changed, added or took off stands.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::CommandCtx;
use crate::error::Result;

use super::{ANSWERS, ROLES};

/// The kind of contact point a guest's address is looked up in.
pub const GUEST_ADDRESS_KIND: &str = "email";

/// The key two spellings of one address share: trimmed, without a `mailto:`, lower case.
#[must_use]
pub fn address_key(raw: &str) -> String {
    let trimmed = raw.trim();
    let bare = trimmed
        .get(..7)
        .filter(|head| head.eq_ignore_ascii_case("mailto:"))
        .map_or(trimmed, |_| &trimmed[7..]);
    bare.trim().to_lowercase()
}

/// The read [`person_of_address`] makes: a seek into `contact_point_by_value`.
pub const PERSON_OF_ADDRESS: &str =
    "SELECT p.person_id FROM contact_point p JOIN entity e ON e.id = p.person_id
      WHERE p.kind = 'email' AND p.normalized = ?1 AND e.deleted_at IS NULL
      ORDER BY p.person_id LIMIT 1";

/// The live person an address is, by an exact match with one of their email points.
///
/// # Errors
/// SQLite's refusal.
pub fn person_of_address(connection: &Connection, address: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(PERSON_OF_ADDRESS, [address_key(address)], |row| row.get(0))
        .optional()?)
}

/// One guest a command states.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct GuestIn {
    pub address: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub status: Option<String>,
    pub organizer: Option<bool>,
    /// The person the guest is, when the caller knows; else the address finds them.
    pub person_id: Option<String>,
}

/// A guest as the vault reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guest {
    pub address: String,
    pub name: Option<String>,
    pub role: String,
    pub status: String,
    pub organizer: bool,
    /// The person the guest is: the stored one, else whoever the address names now.
    pub person_id: Option<String>,
}

/// The read of an event's guests: one range of the table's key, in address order.
pub const GUESTS: &str = "SELECT g.address, g.name, g.role, g.status, g.organizer,
        COALESCE(g.person_id, (SELECT p.person_id FROM contact_point p
                                JOIN entity e ON e.id = p.person_id
                               WHERE p.kind = 'email' AND p.normalized = g.address
                                 AND e.deleted_at IS NULL
                               ORDER BY p.person_id LIMIT 1))
   FROM event_guest g WHERE g.event_id = ?1 ORDER BY g.address";

/// The guests of an event: the organizer first, then by address.
///
/// # Errors
/// SQLite's refusal.
pub fn guests_of(connection: &Connection, event_id: &str) -> Result<Vec<Guest>> {
    let mut guests: Vec<Guest> = connection
        .prepare_cached(GUESTS)?
        .query_map([event_id], |row| {
            Ok(Guest {
                address: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                status: row.get(3)?,
                organizer: row.get(4)?,
                person_id: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    // Stable: the organizer to the front, the rest as the key gave them.
    guests.sort_by_key(|guest| !guest.organizer);
    Ok(guests)
}

/// The sentence for a list of guests that cannot be, or `None`.
pub(super) fn refusal(connection: &Connection, guests: &[GuestIn]) -> Result<Option<String>> {
    let mut organizers = 0;
    for guest in guests {
        let key = address_key(&guest.address);
        if key.is_empty() || key.contains(char::is_whitespace) {
            return Ok(Some(format!(
                "“{}” is not an address a guest can be reached at",
                guest.address.trim()
            )));
        }
        if let Some(role) = &guest.role
            && !ROLES.contains(&role.as_str())
        {
            return Ok(Some(format!("“{role}” is not a guest role")));
        }
        if let Some(status) = &guest.status
            && !ANSWERS.contains(&status.as_str())
        {
            return Ok(Some(format!("“{status}” is not an answer a guest gives")));
        }
        if let Some(name) = &guest.name
            && name.trim().is_empty()
        {
            return Ok(Some(
                "a guest's name says something; leave it out instead".into(),
            ));
        }
        if guest.organizer == Some(true) {
            organizers += 1;
        }
        if let Some(person) = &guest.person_id {
            match crate::commands::entity::lookup_live(connection, person)? {
                Err(sentence) => return Ok(Some(sentence)),
                Ok(found) if found.kind != crate::model::Kind::Person => {
                    return Ok(Some(format!(
                        "“{}” is a {}, not a person",
                        found.title,
                        found.kind.noun()
                    )));
                }
                Ok(_) => {}
            }
        }
    }
    Ok((organizers > 1).then(|| "an event has one organizer".to_owned()))
}

/// Make the event's guests exactly `wanted`: a guest already invited keeps what the command does
/// not state (their answer above all), a new one has not answered, one left out is taken off the
/// list. Returns whether anything changed.
pub(super) fn set_guests(
    ctx: &CommandCtx<'_, '_>,
    event_id: &str,
    wanted: &[GuestIn],
) -> Result<bool> {
    let connection = ctx.connection();
    let mut by_key: BTreeMap<String, &GuestIn> = BTreeMap::new();
    for guest in wanted {
        by_key.insert(address_key(&guest.address), guest);
    }
    let held: Vec<Guest> = guests_of(connection, event_id)?;
    let mut changed = false;
    for guest in held.iter().filter(|g| !by_key.contains_key(&g.address)) {
        connection.execute(
            "DELETE FROM event_guest WHERE event_id = ?1 AND address = ?2",
            [event_id, guest.address.as_str()],
        )?;
        changed = true;
    }
    // One organizer: a new one takes the badge from whoever had it.
    if let Some((key, _)) = by_key.iter().find(|(_, g)| g.organizer == Some(true)) {
        changed |= connection.execute(
            "UPDATE event_guest SET organizer = 0
              WHERE event_id = ?1 AND organizer = 1 AND address <> ?2",
            [event_id, key.as_str()],
        )? > 0;
    }
    for (key, guest) in &by_key {
        let current = held.iter().find(|g| &g.address == key);
        let person = match &guest.person_id {
            Some(person) => Some(person.clone()),
            None => person_of_address(connection, key)?,
        };
        let name = guest.name.as_deref().map(str::trim);
        match current {
            None => {
                connection.execute(
                    "INSERT INTO event_guest (event_id, address, person_id, name, role, status, organizer)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        event_id,
                        key,
                        person,
                        name,
                        guest.role.as_deref().unwrap_or("required"),
                        guest.status.as_deref().unwrap_or("needs-action"),
                        guest.organizer.unwrap_or(false),
                    ],
                )?;
                changed = true;
            }
            Some(held) => {
                let after = Guest {
                    address: key.clone(),
                    name: name.map(str::to_owned).or_else(|| held.name.clone()),
                    role: guest.role.clone().unwrap_or_else(|| held.role.clone()),
                    status: guest.status.clone().unwrap_or_else(|| held.status.clone()),
                    organizer: guest.organizer.unwrap_or(held.organizer),
                    person_id: held.person_id.clone().or(person.clone()),
                };
                if &after != held {
                    connection.execute(
                        "UPDATE event_guest SET person_id = ?3, name = ?4, role = ?5, status = ?6,
                                                organizer = ?7
                          WHERE event_id = ?1 AND address = ?2",
                        rusqlite::params![
                            event_id,
                            key,
                            after.person_id,
                            after.name,
                            after.role,
                            after.status,
                            after.organizer,
                        ],
                    )?;
                    changed = true;
                }
            }
        }
    }
    if changed {
        ctx.touch(event_id)?;
    }
    Ok(changed)
}

/// A guest's answer. Returns whether it changed.
pub(super) fn respond(
    ctx: &CommandCtx<'_, '_>,
    event_id: &str,
    address: &str,
    status: &str,
) -> Result<bool> {
    let changed = ctx.connection().execute(
        "UPDATE event_guest SET status = ?3 WHERE event_id = ?1 AND address = ?2 AND status <> ?3",
        [event_id, &address_key(address), status],
    )?;
    if changed > 0 {
        ctx.touch(event_id)?;
    }
    Ok(changed > 0)
}

// ---------------------------------------------------------------------------
// The guests a phone states
// ---------------------------------------------------------------------------

/// One guest a phone states, in the one form two statements of the same guest share: an email
/// (lower case), a name, an answer of [`ANSWERS`] and a role of [`ROLES`] (`required` unless it
/// says otherwise); `organizer` only when it is.
fn guest_canon(guest: &Json) -> Json {
    let text = |key: &str| {
        guest
            .get(key)
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let state = text("state")
        .filter(|state| ANSWERS.contains(state))
        .unwrap_or("needs-action");
    let role = text("role")
        .filter(|role| ROLES.contains(role))
        .unwrap_or("required");
    let mut out = serde_json::Map::new();
    if let Some(name) = text("name") {
        out.insert("name".to_owned(), name.into());
    }
    if let Some(email) = text("email") {
        out.insert("email".to_owned(), address_key(email).into());
    }
    out.insert("state".to_owned(), state.into());
    out.insert("role".to_owned(), role.into());
    if guest.get("organizer").and_then(Json::as_bool) == Some(true) {
        out.insert("organizer".to_owned(), true.into());
    }
    Json::Object(out)
}

/// `attendees`, canonical: each guest in its one form, in a stable order.
pub(crate) fn guests_canon(statement: &Json) -> Json {
    let Some(list) = statement.as_array() else {
        return statement.clone();
    };
    let mut guests: Vec<Json> = list.iter().map(guest_canon).collect();
    guests.sort_by_key(Json::to_string);
    Json::Array(guests)
}

/// The guests of a canonical list by the key that names each across statements: their address, or
/// their name when they have none.
pub(crate) fn guests_items(guests: &Json) -> BTreeMap<String, Json> {
    let mut out = BTreeMap::new();
    for guest in guests.as_array().into_iter().flatten() {
        let key = guest
            .get("email")
            .and_then(Json::as_str)
            .map(str::to_owned)
            .or_else(|| {
                guest
                    .get("name")
                    .and_then(Json::as_str)
                    .map(|name| format!("name:{}", name.to_lowercase()))
            });
        if let Some(key) = key {
            out.entry(key).or_insert_with(|| guest.clone());
        }
    }
    out
}

/// A guest the vault holds, in the form a phone states it.
fn stated_form(guest: &Guest) -> Json {
    let mut out = json!({ "email": guest.address, "state": guest.status, "role": guest.role });
    if let Some(name) = &guest.name {
        out["name"] = Json::String(name.clone());
    }
    if guest.organizer {
        out["organizer"] = Json::Bool(true);
    }
    guest_canon(&out)
}

/// The guests the event holds, in the form a phone states them.
pub(crate) fn guests_read(connection: &Connection, id: &str) -> Result<Json> {
    let held: Vec<Json> = guests_of(connection, id)?.iter().map(stated_form).collect();
    Ok(guests_canon(&Json::Array(held)))
}

/// A guest with no email is kept in the statement only: the vault's guests are addresses.
fn addressed(statement: &Json) -> BTreeMap<String, Json> {
    guests_items(&guests_canon(statement))
        .into_iter()
        .filter(|(_, guest)| guest.get("email").is_some())
        .collect()
}

fn write_guest(ctx: &CommandCtx<'_, '_>, id: &str, address: &str, guest: &Json) -> Result<()> {
    let text = |key: &str| guest.get(key).and_then(Json::as_str);
    let organizer = guest.get("organizer").and_then(Json::as_bool) == Some(true);
    if organizer {
        ctx.connection().execute(
            "UPDATE event_guest SET organizer = 0 WHERE event_id = ?1 AND address <> ?2",
            [id, address],
        )?;
    }
    let person = person_of_address(ctx.connection(), address)?;
    ctx.connection().execute(
        "INSERT INTO event_guest (event_id, address, person_id, name, role, status, organizer)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (event_id, address) DO UPDATE SET
           name = excluded.name, role = excluded.role, status = excluded.status,
           organizer = excluded.organizer, person_id = COALESCE(person_id, excluded.person_id)",
        rusqlite::params![
            id,
            address,
            person,
            text("name"),
            text("role").unwrap_or("required"),
            text("state").unwrap_or("needs-action"),
            organizer,
        ],
    )?;
    Ok(())
}

fn held_by_address(connection: &Connection, id: &str) -> Result<BTreeMap<String, Json>> {
    Ok(guests_of(connection, id)?
        .iter()
        .map(|guest| (guest.address.clone(), stated_form(guest)))
        .collect())
}

/// The follower's `attendees` merge, **per guest** (by address): a guest the phone states becomes
/// an `event_guest` row with the answer the phone states; one the phone no longer states is taken
/// off. A guest the member has not changed (the row holds what the phone last stated, or there is
/// no row and the phone had none) takes the phone's word; one the member changed (answered
/// differently, took off, or added) stands. A guest with no address stays in the statement only.
pub(crate) fn guests_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    before: Option<&Json>,
    now: &Json,
) -> Result<bool> {
    let (wanted, had) = (addressed(now), before.map(addressed).unwrap_or_default());
    let held = held_by_address(ctx.connection(), id)?;
    let mut changed = false;
    for key in wanted.keys().chain(had.keys()) {
        let (mine, said, wants) = (held.get(key), had.get(key), wanted.get(key));
        // The member changed this guest, or there is nothing to change: it stands.
        if mine != said || mine == wants {
            continue;
        }
        match wants {
            None => {
                changed |= ctx.connection().execute(
                    "DELETE FROM event_guest WHERE event_id = ?1 AND address = ?2",
                    [id, key.as_str()],
                )? > 0;
            }
            Some(guest) => {
                write_guest(ctx, id, key, guest)?;
                changed = true;
            }
        }
    }
    if changed {
        ctx.touch(id)?;
    }
    Ok(changed)
}

/// Make the guests what the phone last stated (one guest, named by its [`guests_items`] key, or
/// all): an answer is put back, a guest the member added is taken off, and one they took off is
/// invited again. Returns whether a row changed.
pub(crate) fn guests_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    let wanted = addressed(stated);
    let held = held_by_address(ctx.connection(), id)?;
    let mut changed = false;
    for key in wanted.keys().chain(held.keys()) {
        if item.is_some_and(|item| item != key) {
            continue;
        }
        let (mine, wants) = (held.get(key), wanted.get(key));
        if mine == wants {
            continue;
        }
        match wants {
            None => {
                changed |= ctx.connection().execute(
                    "DELETE FROM event_guest WHERE event_id = ?1 AND address = ?2",
                    [id, key.as_str()],
                )? > 0;
            }
            Some(guest) => {
                write_guest(ctx, id, key, guest)?;
                changed = true;
            }
        }
    }
    if changed {
        ctx.touch(id)?;
    }
    Ok(changed)
}
