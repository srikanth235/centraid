//! ONE PERSON'S SHEET: the person, how to reach them, their dates, what was
//! written about them and the touch log.
//!
//! **Nothing is stored here**: the sheet is a read of the vault's own rows.
//! The header is the roster's row, so a list and the sheet it opens never
//! disagree; the rest is what hangs off the person one table at a time
//! ([`crate::queries`]). `None` is "no live person has this id" (unknown,
//! trashed, the owner or a pet), which is not a denial.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, Read};
use centraid_apps_kit::row::{Cell, text_of};
use centraid_apps_kit::statement::PageBindValue;

use crate::Denial;
use crate::queries::{
    DateRow, Touch, WIDE, asked, dates, describe, lists, people_among, touch_stubs, words_about,
};
use crate::roster::{RosterRow, rows_of};

/// One way to reach a person, and who else holds the same value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactEntry {
    pub channel_id: String,
    /// `phone`, `email`, `address`, `url` or `handle`.
    pub kind: String,
    pub label: Option<String>,
    pub value: String,
    pub preferred: bool,
    /// The other live people holding the same normalized value.
    pub duplicate_names: Vec<String>,
}

/// One note about the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteEntry {
    pub annotation_id: String,
    pub text: String,
    pub created_at: String,
}

/// One person, as the sheet renders them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub profile: RosterRow,
    pub nickname: String,
    pub met: String,
    /// In the order the member keeps them.
    pub contact: Vec<ContactEntry>,
    /// Every date, reminder on or off, by day of the year.
    pub dates: Vec<DateRow>,
    /// Newest first.
    pub notes: Vec<NoteEntry>,
    /// Newest first.
    pub touches: Vec<Touch>,
}

/// What `person` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PersonData {
    pub person: Option<Person>,
}

fn contact_of(door: &dyn PageDoor, id: &str) -> KitResult<Vec<ContactEntry>> {
    let points = Read {
        name: "people.person.contact",
        table: "contact_point",
        select: "id, person_id, kind, value, normalized, label, preferred, position",
        order: ("position", "id"),
        column: "person_id",
    }
    .of(door, &[id.to_owned()], None)?;
    let normalized: Vec<String> = points
        .iter()
        .filter_map(|row| text_of(row, "normalized"))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let others = Read {
        name: "people.person.same_value",
        table: "contact_point",
        select: "id, person_id, kind, normalized",
        order: ("id", "id"),
        column: "normalized",
    }
    .within(
        WIDE,
        door,
        &normalized,
        Some(("person_id <> ?", vec![PageBindValue::Text(id.to_owned())])),
    )?;
    let holders: Vec<String> = others
        .iter()
        .filter_map(|row| text_of(row, "person_id"))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let names: BTreeMap<String, String> = people_among(door, &holders, true)?
        .into_iter()
        .map(|(id, person)| (id, person.name))
        .collect();
    Ok(points
        .iter()
        .filter_map(|point| {
            let (kind, key) = (text_of(point, "kind")?, text_of(point, "normalized")?);
            let mut duplicate_names: Vec<String> = others
                .iter()
                .filter(|other| {
                    text_of(other, "kind").as_deref() == Some(kind.as_str())
                        && text_of(other, "normalized").as_deref() == Some(key.as_str())
                })
                .filter_map(|other| names.get(&text_of(other, "person_id")?).cloned())
                .collect();
            duplicate_names.sort();
            duplicate_names.dedup();
            Some(ContactEntry {
                channel_id: text_of(point, "id")?,
                label: text_of(point, "label"),
                value: text_of(point, "value")?,
                preferred: point.get("preferred").and_then(Cell::integer) == Some(1),
                duplicate_names,
                kind,
            })
        })
        .collect())
}

/// `person` — one person's sheet.
pub fn load_person(
    door: &dyn PageDoor,
    person_id: &str,
) -> KitResult<(PersonData, Option<Denial>)> {
    let id = person_id.trim();
    if id.is_empty() {
        return Ok((PersonData::default(), None));
    }
    let empty = PersonData::default;
    let Some(person) = asked!(people_among(door, &[id.to_owned()], true), empty()).remove(id)
    else {
        return Ok((empty(), None));
    };
    let lists = asked!(lists(door), empty());
    let profile = asked!(
        rows_of(door, std::slice::from_ref(&person), &lists, true),
        empty()
    )
    .remove(0);
    let contact = asked!(contact_of(door, id), empty());
    let dates = asked!(dates(door, &[&person]), empty());
    let notes = asked!(words_about(door, &[id.to_owned()]), empty())
        .remove(id)
        .unwrap_or_default()
        .into_iter()
        .map(|note| NoteEntry {
            annotation_id: note.id,
            text: note.body,
            created_at: note.created_at,
        })
        .collect();
    let stubs = asked!(touch_stubs(door, &[id.to_owned()]), empty());
    let touches = asked!(describe(door, &stubs), empty());
    Ok((
        PersonData {
            person: Some(Person {
                profile,
                nickname: person.nickname,
                met: person.met,
                contact,
                dates,
                notes,
                touches,
            }),
        },
        None,
    ))
}
