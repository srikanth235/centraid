//! What People reads, one table at a time.
//!
//! A person is an `entity` of kind `person` with a `person` row; everything a
//! screen shows about them is another table joined by an edge or a column
//! (#1135). The paged door's one shape is a keyset page of one table, so every
//! read here is a window of `entity` rows and then, per table, the rows that
//! window's ids name — `IN`-bounded by the window, never a whole-table pull.
//!
//! | A screen's word | Read from |
//! |---|---|
//! | the person, their cadence, how you met | `entity` + `person` |
//! | starred | a `tagged` edge to `flag:starred` |
//! | the list they are in | a `contains` edge from a live `list` |
//! | last contacted, the touch log | `with` edges to `activity` rows (**computed here, never stored**) |
//! | a touch's kind and its words | the activity kind concept; a `note` `about` the activity |
//! | their notes | `note`s with an `about` edge to them |
//! | a birthday | the person's own column |
//! | any other important date | a yearly all-day `event` with an `about` edge to them |
//! | how to reach them | `contact_point` rows |
//!
//! **The circle is the people you keep**: every live person of the vault but the
//! owner and a pet (a pet is someone's relationship, not someone to keep in
//! touch with).

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Read, read_pages, read_window};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::Denial;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// The roster's declared window, from the manifest's input schema.
pub const ROSTER_MIN: usize = 20;
pub const ROSTER_MAX: usize = 10_000;
/// The dashboard's window: the whole declared roster.
pub const DASHBOARD_WINDOW: usize = ROSTER_MAX;
/// The dashboard's recent-touch rail.
pub const RECENT_TOUCH_ROWS: usize = 30;
/// The trash shelf's own size.
pub const TRASH_ROWS: usize = 500;
/// How many matches a search asks of the index.
pub const SEARCH_LIMIT: usize = 50;

/// The fan-out of a read over the roster's window, which is five times wider
/// than any other app's: 500 rows a page, 64 pages, 32,000 rows, stated.
pub const WIDE: FanOutBound = FanOutBound::new(500, 64);

/// The label a touch shows when its kind has none.
pub const DEFAULT_TOUCH_LABEL: &str = "Touch";
/// The name a person has when a read did not reach it: an em dash, because a
/// blank cell reads as a person with no name rather than as a gap.
pub const UNKNOWN_NAME: &str = "—";
/// The label the birthday column's date carries.
pub const BIRTHDAY_LABEL: &str = "Birthday";

const STARRED: &str = "flag:starred";
const ENTITY_COLUMNS: &str = "id, title, created_at, updated_at, deleted_at, purge_at";
const PERSON_COLUMNS: &str = "id, form, nickname, role, met, birthday, cadence_days";

fn text(word: &str) -> PageBindValue {
    PageBindValue::Text(word.to_owned())
}

/// A door's refusal is a value the surface renders; the kit's own errors stay
/// errors (a `FanOutExceeded` is this crate having written a read wrong).
pub(crate) fn denial_of(error: KitError) -> KitResult<Denial> {
    match error {
        KitError::Door(message) => Ok(Denial {
            code: None,
            message: Some(message),
            revoked_at: None,
        }),
        other => Err(other),
    }
}

/// `?` for a loader whose answer is `(data, Option<Denial>)`: the value, or an
/// early return of the empty answer with the door's denial.
macro_rules! asked {
    ($read:expr, $empty:expr) => {
        match $read {
            Ok(value) => value,
            Err(error) => return Ok(($empty, Some($crate::queries::denial_of(error)?))),
        }
    };
}
pub(crate) use asked;

// ---------------------------------------------------------------------------
// The person
// ---------------------------------------------------------------------------

/// One person, as every screen draws them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PersonRow {
    pub id: String,
    pub name: String,
    pub form: String,
    pub role: String,
    pub nickname: String,
    pub met: String,
    pub birthday: Option<String>,
    /// 0 is no cadence.
    pub cadence_days: i64,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

/// One person's card, as every rail draws it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PersonCard {
    pub party_id: String,
    pub name: String,
    pub role: String,
}

impl PersonCard {
    #[must_use]
    pub fn of(person: &PersonRow) -> Self {
        Self {
            party_id: person.id.clone(),
            name: person.name.clone(),
            role: person.role.clone(),
        }
    }

    /// The card of a person a read did not reach.
    #[must_use]
    pub fn unknown(id: &str) -> Self {
        Self {
            party_id: id.to_owned(),
            name: UNKNOWN_NAME.to_owned(),
            role: String::new(),
        }
    }
}

/// The owner's own person: the one the circle leaves out.
fn owner(door: &dyn PageDoor) -> KitResult<Option<String>> {
    let page = door.page(
        &PageQuery::new(
            "people.owner",
            "self_id",
            "vault",
            PageOrder::asc("self_id", "self_id"),
        ),
        &centraid_apps_kit::page::PageRequest::first(1),
    )?;
    Ok(page.rows.first().and_then(|row| text_of(row, "self_id")))
}

/// The people the `entity` rows are, in their order: the kind row's columns
/// joined on, the owner and the pets left out.
fn members(door: &dyn PageDoor, entities: &[Row]) -> KitResult<Vec<PersonRow>> {
    let ids: Vec<String> = entities
        .iter()
        .filter_map(|row| text_of(row, "id"))
        .collect();
    let rows = Read {
        name: "people.rows.person",
        table: "person",
        select: PERSON_COLUMNS,
        order: ("id", "id"),
        column: "id",
    }
    .among(WIDE, door, &ids, None)?;
    let by_id: BTreeMap<String, &Row> = rows
        .iter()
        .filter_map(|row| text_of(row, "id").map(|id| (id, row)))
        .collect();
    let owner = owner(door)?;
    Ok(entities
        .iter()
        .filter_map(|entity| {
            let id = text_of(entity, "id")?;
            let kind = by_id.get(&id)?;
            let form = text_of(kind, "form").unwrap_or_default();
            if form == "pet" || owner.as_deref() == Some(id.as_str()) {
                return None;
            }
            Some(PersonRow {
                name: text_of(entity, "title").unwrap_or_default(),
                role: text_of(kind, "role").unwrap_or_default(),
                nickname: text_of(kind, "nickname").unwrap_or_default(),
                met: text_of(kind, "met").unwrap_or_default(),
                birthday: text_of(kind, "birthday"),
                cadence_days: kind
                    .get("cadence_days")
                    .and_then(Cell::integer)
                    .unwrap_or_default(),
                created_at: text_of(entity, "created_at").unwrap_or_default(),
                deleted_at: text_of(entity, "deleted_at"),
                purge_at: text_of(entity, "purge_at"),
                form,
                id,
            })
        })
        .collect())
}

/// The people among `ids`, live or in the trash as asked, in no particular order.
pub(crate) fn people_among(
    door: &dyn PageDoor,
    ids: &[String],
    live: bool,
) -> KitResult<BTreeMap<String, PersonRow>> {
    let entities = Read {
        name: "people.rows.entity",
        table: "entity",
        select: ENTITY_COLUMNS,
        order: ("id", "id"),
        column: "id",
    }
    .among(
        WIDE,
        door,
        ids,
        Some((
            if live {
                "kind = ? AND deleted_at IS NULL"
            } else {
                "kind = ?"
            },
            vec![text("person")],
        )),
    )?;
    Ok(members(door, &entities)?
        .into_iter()
        .map(|person| (person.id.clone(), person))
        .collect())
}

/// Which of `ids` are live people of the circle (not the owner, not a pet): what
/// Home asks of a person hit before it opens People at it.
pub fn circle_among(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeSet<String>> {
    Ok(people_among(door, ids, true)?.into_keys().collect())
}

/// The circle's window: live people, newest-added first.
pub struct Circle {
    pub members: Vec<PersonRow>,
    /// More live people exist than the window read (the walk's own answer).
    pub filled: bool,
}

/// Read the circle's window. **Measured before the owner and the pets are left
/// out**, so `members` may hold fewer rows than the window.
pub fn read_circle(door: &dyn PageDoor, window: usize) -> KitResult<Circle> {
    let query = PageQuery::new(
        "people.window",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("created_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", vec![text("person")]);
    let read = read_window(door, &query, window)?;
    Ok(Circle {
        members: members(door, &read.rows)?,
        filled: read.filled,
    })
}

/// The trash shelf's window: people, most recently trashed first.
pub fn read_trashed(door: &dyn PageDoor) -> KitResult<Circle> {
    let query = PageQuery::new(
        "people.trash",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("deleted_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NOT NULL", vec![text("person")]);
    let read = read_window(door, &query, TRASH_ROWS)?;
    Ok(Circle {
        members: members(door, &read.rows)?,
        filled: read.filled,
    })
}

// ---------------------------------------------------------------------------
// What hangs off a window of people
// ---------------------------------------------------------------------------

fn edges(name: &'static str, order: (&'static str, &'static str), column: &'static str) -> Read {
    Read {
        name,
        table: "edge",
        select: "from_id, to_id",
        order,
        column,
    }
}

/// The people carrying the star.
pub(crate) fn starred(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeSet<String>> {
    Ok(edges("people.starred", ("from_id", "to_id"), "from_id")
        .among(
            WIDE,
            door,
            ids,
            Some(("rel = ? AND to_id = ?", vec![text("tagged"), text(STARRED)])),
        )?
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect())
}

/// One of the owner's lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListEntry {
    pub list_id: String,
    pub name: String,
}

/// The live lists, by name.
pub fn lists(door: &dyn PageDoor) -> KitResult<Vec<ListEntry>> {
    let query = PageQuery::new(
        "people.lists",
        "id, title",
        "entity",
        PageOrder::asc("title", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", vec![text("list")]);
    Ok(read_pages(door, &query, WIDE)?
        .iter()
        .filter_map(|row| {
            Some(ListEntry {
                list_id: text_of(row, "id")?,
                name: text_of(row, "title")?,
            })
        })
        .collect())
}

/// The list each person is in: the first, by name, of the live lists that hold them.
pub(crate) fn list_of(
    door: &dyn PageDoor,
    ids: &[String],
    lists: &[ListEntry],
) -> KitResult<BTreeMap<String, String>> {
    let held = edges("people.filed", ("to_id", "from_id"), "to_id").among(
        WIDE,
        door,
        ids,
        Some(("rel = ?", vec![text("contains")])),
    )?;
    let mut by_person: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &held {
        if let (Some(list), Some(person)) = (text_of(row, "from_id"), text_of(row, "to_id")) {
            by_person.entry(person).or_default().push(list);
        }
    }
    Ok(by_person
        .into_iter()
        .filter_map(|(person, held)| {
            lists
                .iter()
                .find(|list| held.contains(&list.list_id))
                .map(|list| (person, list.list_id.clone()))
        })
        .collect())
}

/// One touch before it is described: an activity `with` a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TouchStub {
    pub id: String,
    pub person_id: String,
    pub at: String,
    pub kind_id: String,
}

/// The touches of these people, newest first: the `with` edges to them and the
/// activities those edges start at. **Last contacted is the newest of these**;
/// nothing stores it.
pub(crate) fn touch_stubs(door: &dyn PageDoor, ids: &[String]) -> KitResult<Vec<TouchStub>> {
    let with = edges("people.touches.with", ("to_id", "from_id"), "to_id").among(
        WIDE,
        door,
        ids,
        Some(("rel = ?", vec![text("with")])),
    )?;
    let person_of: BTreeMap<String, String> = with
        .iter()
        .filter_map(|row| Some((text_of(row, "from_id")?, text_of(row, "to_id")?)))
        .collect();
    let activity_ids: Vec<String> = person_of.keys().cloned().collect();
    let mut stubs: Vec<TouchStub> = Read {
        name: "people.touches.activity",
        table: "activity",
        select: "id, type_id, starts",
        order: ("id", "id"),
        column: "id",
    }
    .among(
        WIDE,
        door,
        &activity_ids,
        Some(("type_kind = ?", vec![text("activity_kind")])),
    )?
    .iter()
    .filter_map(|row| {
        let id = text_of(row, "id")?;
        Some(TouchStub {
            person_id: person_of.get(&id)?.clone(),
            at: text_of(row, "starts")?,
            kind_id: text_of(row, "type_id")?,
            id,
        })
    })
    .collect();
    stubs.sort_by(|left, right| right.at.cmp(&left.at).then_with(|| left.id.cmp(&right.id)));
    Ok(stubs)
}

/// When each person was last touched.
#[must_use]
pub(crate) fn last_contacts(stubs: &[TouchStub]) -> BTreeMap<String, String> {
    let mut last: BTreeMap<String, String> = BTreeMap::new();
    for stub in stubs {
        last.entry(stub.person_id.clone())
            .and_modify(|at| {
                if stub.at > *at {
                    at.clone_from(&stub.at);
                }
            })
            .or_insert_with(|| stub.at.clone());
    }
    last
}

/// One touch, with what it was and what was said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Touch {
    pub id: String,
    pub person_id: String,
    pub at: String,
    /// The kind concept's key (`call`, `met-up`): the sheet shows it.
    pub kind: String,
    /// The kind concept's title (`Call`, `Met up`): the dashboard shows it.
    pub label: String,
    /// The words kept of it: a note `about` the touch.
    pub text: String,
}

/// Describe the stubs: their kinds, and the note kept of each.
pub(crate) fn describe(door: &dyn PageDoor, stubs: &[TouchStub]) -> KitResult<Vec<Touch>> {
    let kind_ids: Vec<String> = stubs
        .iter()
        .map(|stub| stub.kind_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let keys: BTreeMap<String, String> = Read {
        name: "people.touches.kind_key",
        table: "concept",
        select: "id, key",
        order: ("id", "id"),
        column: "id",
    }
    .within(WIDE, door, &kind_ids, None)?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "key")?)))
    .collect();
    let labels = titles(door, &kind_ids)?;
    let ids: Vec<String> = stubs.iter().map(|stub| stub.id.clone()).collect();
    let said = words_about(door, &ids)?;
    Ok(stubs
        .iter()
        .map(|stub| Touch {
            id: stub.id.clone(),
            person_id: stub.person_id.clone(),
            at: stub.at.clone(),
            kind: keys.get(&stub.kind_id).cloned().unwrap_or_default(),
            label: labels.get(&stub.kind_id).cloned().unwrap_or_default(),
            text: said
                .get(&stub.id)
                .and_then(|notes| notes.first())
                .map(|note| note.body.clone())
                .unwrap_or_default(),
        })
        .collect())
}

/// Titles by id.
fn titles(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeMap<String, String>> {
    Ok(Read {
        name: "people.titles",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .within(WIDE, door, ids, None)?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect())
}

/// One live note about something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteAbout {
    pub id: String,
    pub body: String,
    pub created_at: String,
}

/// The live notes about each of `ids`, newest first.
pub(crate) fn words_about(
    door: &dyn PageDoor,
    ids: &[String],
) -> KitResult<BTreeMap<String, Vec<NoteAbout>>> {
    let about = edges("people.notes.about", ("to_id", "from_id"), "to_id").within(
        WIDE,
        door,
        ids,
        Some(("rel = ?", vec![text("about")])),
    )?;
    let note_ids: Vec<String> = about
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect();
    let entities = Read {
        name: "people.notes.entity",
        table: "entity",
        select: "id, created_at",
        order: ("id", "id"),
        column: "id",
    }
    .within(
        WIDE,
        door,
        &note_ids,
        Some(("kind = ? AND deleted_at IS NULL", vec![text("note")])),
    )?;
    let live: BTreeMap<String, String> = entities
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "created_at")?)))
        .collect();
    let bodies: BTreeMap<String, String> = Read {
        name: "people.notes.note",
        table: "note",
        select: "id, body",
        order: ("id", "id"),
        column: "id",
    }
    .within(WIDE, door, &live.keys().cloned().collect::<Vec<_>>(), None)?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "body")?)))
    .collect();
    let mut by_subject: BTreeMap<String, Vec<NoteAbout>> = BTreeMap::new();
    for row in &about {
        let (Some(note), Some(subject)) = (text_of(row, "from_id"), text_of(row, "to_id")) else {
            continue;
        };
        if let (Some(created_at), Some(body)) = (live.get(&note), bodies.get(&note)) {
            by_subject.entry(subject).or_default().push(NoteAbout {
                id: note,
                body: body.clone(),
                created_at: created_at.clone(),
            });
        }
    }
    for notes in by_subject.values_mut() {
        notes.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
    }
    Ok(by_subject)
}

/// One important date, annual.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateRow {
    pub person_id: String,
    /// The event's id; the birthday has none of its own and carries the person's,
    /// prefixed.
    pub date_id: String,
    pub label: String,
    /// `MM-DD`.
    pub month_day: String,
    pub reminder_on: bool,
}

/// A reminder, as the roster draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub date_id: String,
    pub label: String,
    pub month_day: String,
}

impl DateRow {
    #[must_use]
    pub fn reminder(&self) -> Reminder {
        Reminder {
            date_id: self.date_id.clone(),
            label: self.label.clone(),
            month_day: self.month_day.clone(),
        }
    }
}

/// The important dates of these people: the birthday column, and the yearly
/// all-day events `about` them. **A birthday always has its reminder**; any
/// other date has one when its event does.
pub(crate) fn dates(door: &dyn PageDoor, people: &[&PersonRow]) -> KitResult<Vec<DateRow>> {
    let mut found: Vec<DateRow> = people
        .iter()
        .filter_map(|person| {
            let birthday = person.birthday.as_deref()?;
            Some(DateRow {
                person_id: person.id.clone(),
                date_id: format!("birthday:{}", person.id),
                label: BIRTHDAY_LABEL.to_owned(),
                month_day: birthday.get(birthday.len().checked_sub(5)?..)?.to_owned(),
                reminder_on: true,
            })
        })
        .collect();
    let ids: BTreeSet<&str> = people.iter().map(|person| person.id.as_str()).collect();
    let person_ids: Vec<String> = ids.iter().map(|id| (*id).to_owned()).collect();
    // The events about these people, then the yearly all-day ones among them.
    let about = edges("people.dates.about", ("to_id", "from_id"), "to_id").among(
        WIDE,
        door,
        &person_ids,
        Some(("rel = ?", vec![text("about")])),
    )?;
    let event_ids: Vec<String> = about
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect();
    let yearly = Read {
        name: "people.dates.events",
        table: "event",
        select: "id, starts, reminders",
        order: ("id", "id"),
        column: "id",
    }
    .among(
        WIDE,
        door,
        &event_ids,
        Some((
            "rule LIKE ? AND timing = ?",
            vec![text("FREQ=YEARLY%"), text("all-day")],
        )),
    )?;
    let yearly_ids: Vec<String> = yearly.iter().filter_map(|row| text_of(row, "id")).collect();
    let titles: BTreeMap<String, String> = Read {
        name: "people.dates.entity",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .among(
        WIDE,
        door,
        &yearly_ids,
        Some(("kind = ? AND deleted_at IS NULL", vec![text("event")])),
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect();
    let mut about_by_event: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &about {
        if let (Some(event), Some(person)) = (text_of(row, "from_id"), text_of(row, "to_id")) {
            about_by_event.entry(event).or_default().push(person);
        }
    }
    for event in &yearly {
        let (Some(id), Some(starts)) = (text_of(event, "id"), text_of(event, "starts")) else {
            continue;
        };
        let (Some(label), Some(month_day)) = (titles.get(&id), starts.get(5..10)) else {
            continue;
        };
        let reminder_on = text_of(event, "reminders").is_some_and(|set| set != "[]");
        for person in about_by_event.get(&id).into_iter().flatten() {
            found.push(DateRow {
                person_id: person.clone(),
                date_id: id.clone(),
                label: label.clone(),
                month_day: month_day.to_owned(),
                reminder_on,
            });
        }
    }
    found.sort_by(|left, right| {
        left.month_day
            .cmp(&right.month_day)
            .then_with(|| left.label.cmp(&right.label))
            .then_with(|| left.date_id.cmp(&right.date_id))
    });
    Ok(found)
}

/// The reminders that are on, by person.
#[must_use]
pub(crate) fn reminders(dates: &[DateRow]) -> BTreeMap<String, Vec<Reminder>> {
    let mut by_person: BTreeMap<String, Vec<Reminder>> = BTreeMap::new();
    for date in dates.iter().filter(|date| date.reminder_on) {
        by_person
            .entry(date.person_id.clone())
            .or_default()
            .push(date.reminder());
    }
    by_person
}
