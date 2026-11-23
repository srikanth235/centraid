//! Event guest (attendee) resolution, matching, and follower child callbacks.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::CommandCtx;
use crate::commands::edge::{self, Extras};
use crate::error::Result;
use crate::model::Rel;

use super::ANSWERS;

// ---------------------------------------------------------------------------
// The guests a phone states
// ---------------------------------------------------------------------------

/// One guest a phone states, in the one form two statements of the same guest share: an email
/// (lower case), a name and an answer of [`ANSWERS`].
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
    let mut out = serde_json::Map::new();
    if let Some(name) = text("name") {
        out.insert("name".to_owned(), name.into());
    }
    if let Some(email) = text("email") {
        out.insert("email".to_owned(), email.to_lowercase().into());
    }
    out.insert("state".to_owned(), state.into());
    Json::Object(out)
}

/// `attendees`, canonical: each guest in its one form, in a stable order.
pub(crate) fn attendees_canon(statement: &Json) -> Json {
    let Some(list) = statement.as_array() else {
        return statement.clone();
    };
    let mut guests: Vec<Json> = list.iter().map(guest_canon).collect();
    guests.sort_by_key(Json::to_string);
    Json::Array(guests)
}

/// The guests of a canonical list by the key that names each across statements: their email, or
/// their name when they have none.
pub(crate) fn attendees_items(guests: &Json) -> std::collections::BTreeMap<String, Json> {
    let mut out = std::collections::BTreeMap::new();
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

/// The read [`person_of_email`] makes: a seek into `contact_point_by_value`, planned as the product
/// makes it by `index_walks.rs` rather than copied there (#1191, L3).
pub const PERSON_OF_EMAIL: &str =
    "SELECT p.person_id FROM contact_point p JOIN entity e ON e.id = p.person_id
              WHERE p.kind = 'email' AND p.normalized = ?1 AND e.deleted_at IS NULL
              ORDER BY p.person_id LIMIT 1";

/// The live person an email is, by an exact match with one of their email points.
fn person_of_email(connection: &Connection, email: &str) -> Result<Option<String>> {
    let key = crate::commands::contact_point::reach_key("email", email);
    Ok(connection
        .query_row(PERSON_OF_EMAIL, [&key], |row| row.get(0))
        .optional()?)
}

/// The people the guests of a statement are, by an exact email match with a live person's email,
/// with the answer each gave.
fn matched_guests(
    connection: &Connection,
    statement: Option<&Json>,
) -> Result<std::collections::BTreeMap<String, String>> {
    let mut people = std::collections::BTreeMap::new();
    for guest in statement.and_then(Json::as_array).into_iter().flatten() {
        let guest = guest_canon(guest);
        let (Some(email), Some(state)) = (
            guest.get("email").and_then(Json::as_str),
            guest.get("state").and_then(Json::as_str),
        ) else {
            continue;
        };
        if let Some(person) = person_of_email(connection, email)? {
            people.insert(person, state.to_owned());
        }
    }
    Ok(people)
}

/// The people the guests of a statement were matched to when the statement was merged
/// ([`attendees_stamp`]), with the answer each gave. A guest with no note matched nobody then.
fn merged_guests(statement: Option<&Json>) -> std::collections::BTreeMap<String, String> {
    let mut people = std::collections::BTreeMap::new();
    for guest in statement.and_then(Json::as_array).into_iter().flatten() {
        let Some(person) = guest.get("person").and_then(Json::as_str) else {
            continue;
        };
        let state = guest_canon(guest)
            .get("state")
            .and_then(Json::as_str)
            .unwrap_or("needs-action")
            .to_owned();
        people.insert(person.to_owned(), state);
    }
    people
}

/// Note on each stated guest the person it was matched to when the statement was merged (a
/// `person` key; [`guest_canon`] leaves it out, so it never counts as a difference). A pass that
/// did not merge the guests keeps the notes already there. This is what lets a later merge tell a
/// guest the member took off (matched then, no edge now) from one who matches a person only now
/// (matched then: nobody), and so attach her.
pub(crate) fn attendees_stamp(
    connection: &Connection,
    before: Option<&Json>,
    now: &Json,
    merged: bool,
) -> Result<Json> {
    let Some(list) = now.as_array() else {
        return Ok(now.clone());
    };
    let noted = |email: &str| {
        before
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
            .find(|guest| guest_canon(guest).get("email").and_then(Json::as_str) == Some(email))
            .and_then(|guest| guest.get("person").cloned())
    };
    let mut out = Vec::with_capacity(list.len());
    for guest in list {
        let mut guest = guest.clone();
        let email = guest_canon(&guest)
            .get("email")
            .and_then(Json::as_str)
            .map(str::to_owned);
        if let Some(object) = guest.as_object_mut() {
            object.remove("person");
            let person = match email.as_deref() {
                Some(email) if merged => person_of_email(connection, email)?.map(Json::String),
                Some(email) => noted(email),
                None => None,
            };
            if let Some(person) = person {
                object.insert("person".to_owned(), person);
            }
        }
        out.push(guest);
    }
    Ok(Json::Array(out))
}

/// The answer each person the event has an `attendee` edge to holds now (a blank answer is
/// `needs-action`, as a statement spells it).
fn held_guests(
    connection: &Connection,
    id: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    connection
        .prepare_cached(
            "SELECT to_id, state FROM edge WHERE from_id = ?1 AND rel = 'attendee' ORDER BY to_id",
        )?
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .map(|row| {
            row.map(|(person, state)| {
                (
                    person,
                    state
                        .filter(|state| ANSWERS.contains(&state.as_str()))
                        .unwrap_or_else(|| "needs-action".to_owned()),
                )
            })
        })
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

/// The guests the event holds, in the form a phone states them: the guests the source last stated
/// stand as stated unless they are a person's, and a person's carry the answer the vault holds (a
/// guest whose edge the member took away is not there); a person the member added as a guest
/// follows, by name and first email.
pub(crate) fn attendees_read(connection: &Connection, id: &str) -> Result<Json> {
    let stated: Option<String> = connection
        .query_row(
            "SELECT stated FROM source WHERE entity_id = ?1 AND origin_id IN
               (SELECT id FROM origin WHERE retired_at IS NULL)",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let stated = stated
        .and_then(|text| serde_json::from_str::<Json>(&text).ok())
        .and_then(|stated| stated.get("attendees").cloned());
    let mut held = held_guests(connection, id)?;
    let mut covered = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for guest in stated
        .as_ref()
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
    {
        let noted = guest
            .get("person")
            .and_then(Json::as_str)
            .map(str::to_owned);
        let mut guest = guest_canon(guest);
        // The person the guest was merged as, else (never merged as anyone) the person the
        // member made of her since, if they hold her as a guest.
        let (person, merged) = match noted {
            Some(person) => (Some(person), true),
            None => {
                let today = match guest.get("email").and_then(Json::as_str) {
                    Some(email) => person_of_email(connection, email)?,
                    None => None,
                };
                (today.filter(|person| held.contains_key(person)), false)
            }
        };
        let Some(person) = person else {
            out.push(guest);
            continue;
        };
        // A person's guest carries the answer held, and a guest merged as a person is not there
        // when the edge is gone. The people the member added are the edges left once the stated
        // guests are accounted for.
        if let Some(state) = held.get(&person) {
            guest["state"] = Json::String(state.clone());
            out.push(guest);
        } else if !merged {
            out.push(guest);
        }
        covered.insert(person);
    }
    held.retain(|person, _| !covered.contains(person));
    for (person, state) in held {
        let (name, email): (String, Option<String>) = connection.query_row(
            "SELECT e.title, (SELECT value FROM contact_point
                               WHERE person_id = e.id AND kind = 'email'
                               ORDER BY position, id LIMIT 1)
               FROM entity e WHERE e.id = ?1",
            [&person],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut guest = json!({ "name": name, "state": state });
        if let Some(email) = email {
            guest["email"] = Json::String(email.to_lowercase());
        }
        out.push(guest_canon(&guest));
    }
    Ok(attendees_canon(&Json::Array(out)))
}

/// The follower's `attendees` merge, **per guest**: a guest the phone states whose email is a
/// person's becomes that person's `attendee` edge, with the answer the phone states; one the
/// phone no longer states is taken off. A guest the member has not changed (the edge holds the
/// answer the phone last stated, or there is no edge and the phone had no answer) takes the
/// phone's word; one the member changed (answered differently, took off, or added) stands. A
/// guest nobody's email matches mints no person and stays in the statement
/// ([`attendees_read`]). Guests are read from the phone and never written to it.
///
/// What the phone "had" said is the guests the last merge matched to people, as noted in the
/// statement ([`attendees_stamp`]), not who the guests match today: a guest whose email became a
/// person's after that merge was never attached or taken off, so she is attached now. A statement
/// from before the notes were kept notes nobody, so each of its guests is attached once.
pub(crate) fn attendees_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    before: Option<&Json>,
    now: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let wanted = matched_guests(connection, Some(now))?;
    let had = merged_guests(before);
    let held = held_guests(connection, id)?;
    let people: std::collections::BTreeSet<&String> = wanted.keys().chain(had.keys()).collect();
    let mut changed = false;
    for person in people {
        let (mine, said, wants) = (held.get(person), had.get(person), wanted.get(person));
        // The member changed this guest, or there is nothing to change: it stands.
        if mine != said || mine == wants {
            continue;
        }
        match wants {
            None => {
                changed |= connection.execute(
                    "DELETE FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
                    [id, person],
                )? > 0;
            }
            Some(state) => {
                edge::put(
                    ctx,
                    id,
                    Rel::Attendee,
                    person,
                    None,
                    &Extras {
                        state: Some(state),
                        ..Extras::default()
                    },
                )?;
                changed = true;
            }
        }
    }
    Ok(changed)
}

/// Make the guests what the phone last stated (one guest, named by its [`attendees_items`] key,
/// or all): a person's answer is put back, a guest the member added is taken off, and one they took
/// off is invited again with the stated answer. A guest nobody's email matches is only in the
/// statement and has nothing to put back. Returns whether an edge changed.
pub(crate) fn attendees_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let wanted = matched_guests(connection, Some(stated))?;
    let held = held_guests(connection, id)?;
    // The key each person goes by: the stated guest's email, else how the read names a guest the
    // member added.
    let mut keys = std::collections::BTreeMap::new();
    for guest in stated.as_array().into_iter().flatten() {
        let guest = guest_canon(guest);
        if let Some(email) = guest.get("email").and_then(Json::as_str)
            && let Some(person) = person_of_email(connection, email)?
        {
            keys.entry(person).or_insert_with(|| email.to_owned());
        }
    }
    for person in held.keys() {
        if keys.contains_key(person) {
            continue;
        }
        let name: String =
            connection.query_row("SELECT title FROM entity WHERE id = ?1", [person], |row| {
                row.get(0)
            })?;
        let email: Option<String> = connection
            .query_row(
                "SELECT value FROM contact_point WHERE person_id = ?1 AND kind = 'email'
                  ORDER BY position, id LIMIT 1",
                [person],
                |row| row.get(0),
            )
            .optional()?;
        let key = email.map_or_else(
            || format!("name:{}", name.to_lowercase()),
            |email| email.to_lowercase(),
        );
        keys.insert(person.clone(), key);
    }
    let people: std::collections::BTreeSet<&String> = wanted.keys().chain(held.keys()).collect();
    let mut changed = false;
    for person in people {
        if item.is_some_and(|item| keys.get(person).map(String::as_str) != Some(item)) {
            continue;
        }
        let (mine, wants) = (held.get(person), wanted.get(person));
        if mine == wants {
            continue;
        }
        match wants {
            None => {
                changed |= connection.execute(
                    "DELETE FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
                    [id, person],
                )? > 0;
            }
            Some(state) => {
                edge::put(
                    ctx,
                    id,
                    Rel::Attendee,
                    person,
                    None,
                    &Extras {
                        state: Some(state),
                        ..Extras::default()
                    },
                )?;
                changed = true;
            }
        }
    }
    Ok(changed)
}
