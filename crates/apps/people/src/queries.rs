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
use centraid_apps_kit::graph;
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
const PERSON_COLUMNS: &str =
    "id, form, nickname, role, met, birthday, birthday_reminder, cadence_days";

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
    /// Whether the birthday's reminder is on (the member's per-person switch; on by default).
    pub birthday_reminder: bool,
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
pub(crate) fn owner(door: &dyn PageDoor) -> KitResult<Option<String>> {
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

/// MY CARD (#1173): the owner's own person, as a card; none when the vault names no owner or
/// the owner has no person row to read. The circle never holds it.
pub(crate) fn owner_card(door: &dyn PageDoor) -> KitResult<Option<PersonCard>> {
    let Some(id) = owner(door)? else {
        return Ok(None);
    };
    Ok(
        people_among_with(door, std::slice::from_ref(&id), true, true)?
            .get(&id)
            .map(PersonCard::of),
    )
}

/// The people the `entity` rows are, in their order: the kind row's columns
/// joined on, the owner and the pets left out.
fn members(door: &dyn PageDoor, entities: &[Row], with_owner: bool) -> KitResult<Vec<PersonRow>> {
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
            if form == "pet" || (!with_owner && owner.as_deref() == Some(id.as_str())) {
                return None;
            }
            Some(PersonRow {
                name: text_of(entity, "title").unwrap_or_default(),
                role: text_of(kind, "role").unwrap_or_default(),
                nickname: text_of(kind, "nickname").unwrap_or_default(),
                met: text_of(kind, "met").unwrap_or_default(),
                birthday: text_of(kind, "birthday"),
                birthday_reminder: kind
                    .get("birthday_reminder")
                    .and_then(Cell::integer)
                    .is_none_or(|on| on != 0),
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
    people_among_with(door, ids, live, false)
}

/// As [`people_among`], and the owner's own person too when `with_owner`: My card's sheet and
/// editor read it, while the circle, the search and merge never do (#1173).
pub(crate) fn people_among_with(
    door: &dyn PageDoor,
    ids: &[String],
    live: bool,
    with_owner: bool,
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
    Ok(members(door, &entities, with_owner)?
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
        members: members(door, &read.rows, false)?,
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
        members: members(door, &read.rows, false)?,
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
    // A TOUCH IN THE TRASH IS NO TOUCH: it counts toward nothing (#1146 M21).
    let live: BTreeSet<String> = Read {
        name: "people.touches.live",
        table: "entity",
        select: "id",
        order: ("id", "id"),
        column: "id",
    }
    .among(
        WIDE,
        door,
        &activity_ids,
        Some(("kind = ? AND deleted_at IS NULL", vec![text("activity")])),
    )?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .collect();
    let activity_ids: Vec<String> = live.into_iter().collect();
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

/// Which end of a `related` edge a sheet's person is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationDirection {
    /// The sheet's person listed the other as `label` ("Beth is Ada's Mum": Ada's sheet).
    Outgoing,
    /// The other listed the sheet's person as `label` (Beth's sheet reads "Mum of Ada").
    Incoming,
}

/// One relationship of a person, as the sheet draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationRow {
    /// The other person.
    pub person_id: String,
    pub name: String,
    /// What the edge's relation concept is called ("Mum"): what the TARGET is to the SOURCE.
    pub label: String,
    pub direction: RelationDirection,
}

/// The live relationships of one person, both directions: the `related` edges that start at them
/// (the other is what `label` says) and end at them (they are what `label` says to the other).
/// The other end must be live: a relative in the trash is not shown. A pet is shown on its
/// owner's sheet (an outgoing edge).
pub(crate) fn relations(door: &dyn PageDoor, id: &str) -> KitResult<Vec<RelationRow>> {
    let ids = [id.to_owned()];
    let wide = |name: &'static str, order, column| Read {
        name,
        table: "edge",
        select: "from_id, to_id, label_id",
        order,
        column,
    };
    let outgoing = wide("people.relations.out", ("from_id", "to_id"), "from_id").among(
        WIDE,
        door,
        &ids,
        Some(("rel = ?", vec![text("related")])),
    )?;
    let incoming = wide("people.relations.in", ("to_id", "from_id"), "to_id").among(
        WIDE,
        door,
        &ids,
        Some(("rel = ?", vec![text("related")])),
    )?;
    let mut pairs: Vec<(String, String, RelationDirection)> = Vec::new();
    for (rows, direction, other) in [
        (&outgoing, RelationDirection::Outgoing, "to_id"),
        (&incoming, RelationDirection::Incoming, "from_id"),
    ] {
        for row in rows {
            if let (Some(other), Some(label)) = (text_of(row, other), text_of(row, "label_id")) {
                pairs.push((other, label, direction));
            }
        }
    }
    let others: Vec<String> = pairs
        .iter()
        .map(|(other, ..)| other.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let live: BTreeMap<String, String> = Read {
        name: "people.relations.who",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .among(
        WIDE,
        door,
        &others,
        Some(("deleted_at IS NULL", Vec::new())),
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect();
    let labels = titles(
        door,
        &pairs
            .iter()
            .map(|(_, label, _)| label.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>(),
    )?;
    let mut rows: Vec<RelationRow> = pairs
        .into_iter()
        .filter_map(|(other, label, direction)| {
            Some(RelationRow {
                name: live.get(&other)?.clone(),
                label: labels.get(&label)?.clone(),
                person_id: other,
                direction,
            })
        })
        .collect();
    rows.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.person_id.cmp(&right.person_id))
            .then_with(|| left.label.cmp(&right.label))
    });
    Ok(rows)
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

/// One person a transaction, a document or a photograph is joined to by hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedPerson {
    pub party_id: String,
    pub name: String,
    /// The vault's owner: the person the vault is about.
    pub is_owner: bool,
}

/// The people ONE thing is joined to, in name order: the live people at the end of its `with`
/// (a payment), `about` (a document) and `depicts` (a photograph) edges, read through the graph
/// ([`centraid_apps_kit::graph`]). A person in the trash is not here. Locker's links end at a
/// person as well, and the door does not serve them to this read: an item's own links are
/// Locker's read.
pub(crate) fn linked_people(door: &dyn PageDoor, entity_id: &str) -> KitResult<Vec<LinkedPerson>> {
    let joined = graph::outgoing(
        door,
        WIDE,
        &[entity_id.to_owned()],
        "",
        &["with", "about", "depicts"],
    )?;
    let mut ids: Vec<String> = joined.into_iter().map(|link| link.to).collect();
    ids.sort();
    ids.dedup();
    let owner = graph::owner(door)?;
    let mut people: Vec<LinkedPerson> = Read {
        name: "people.links.entity",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .within(
        WIDE,
        door,
        &ids,
        Some(("kind = ? AND deleted_at IS NULL", vec![text("person")])),
    )?
    .iter()
    .filter_map(|row| {
        let party_id = text_of(row, "id")?;
        Some(LinkedPerson {
            is_owner: owner.as_deref() == Some(party_id.as_str()),
            name: text_of(row, "title")?,
            party_id,
        })
    })
    .collect();
    people.sort_by_cached_key(|person| (person.name.to_lowercase(), person.party_id.clone()));
    Ok(people)
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

// ---------------------------------------------------------------------------
// In your vault (#1173)
// ---------------------------------------------------------------------------

/// The most of one kind "In your vault" shows: the rest is counted, not listed.
pub const VAULT_PER_KIND: usize = 3;

/// What kind of thing in the vault is about a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum VaultKind {
    /// An event the person is a guest of, or that is about them (not a yearly date).
    Event,
    Task,
    /// A note that links to them (a note written about them is one of their `notes`).
    Note,
    /// A document attached to them, or to an event or task that is about them (the menu on
    /// "Dinner with Maya").
    Document,
    /// A transaction that is with them: a payment to or from them (Money).
    Txn,
    /// A photograph they are in, tagged by hand (Photos).
    Photo,
}

impl VaultKind {
    #[must_use]
    pub fn key(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Task => "task",
            Self::Note => "note",
            Self::Document => "document",
            Self::Txn => "txn",
            Self::Photo => "photo",
        }
    }
}

/// One thing in the vault that is about a person, from another app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultItem {
    pub id: String,
    pub kind: VaultKind,
    pub title: String,
    pub created_at: String,
    /// An event's first start, its timing and zone; none on a recurring event (its first start
    /// is not when it is next).
    pub starts: Option<String>,
    pub timing: Option<String>,
    pub zone: Option<String>,
    /// A document attached to an item rather than to the person: that item's title.
    pub via: Option<String>,
}

/// What else in the vault is about one person: the items shown (events, then tasks, then
/// notes, then documents; newest first within a kind; at most [`VAULT_PER_KIND`] of each) and how many more
/// there are than shown.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VaultLinks {
    pub items: Vec<VaultItem>,
    pub more: usize,
}

/// The things in the vault about one person, read through the graph
/// ([`centraid_apps_kit::graph`]) from the joins that END at them (`edge_to`, one `to_id`): an
/// event's `attendee` or `about` edge, a task's `about`, a note's `links`, a document's `about`,
/// a transaction's `with`, a photograph's `depicts`. A yearly all-day event is one of their
/// dates, a cancelled event is not on the calendar, a void line is not a payment, and a row in
/// the trash is no row. A note's `about` edge is People's own note.
///
/// DOCUMENTS are also the `attached` edges that START at the person or at one of their events
/// or tasks. A document is a link to an item only when the item is one this list shows: the
/// edge that ties it to the person is the item's. **Locker is never here**: its links end at
/// the person like any other edge, and the door does not serve them to this read, so the only
/// place a Locker item shows its person is the item's own "Linked to".
pub(crate) fn vault_links(door: &dyn PageDoor, id: &str) -> KitResult<VaultLinks> {
    let incoming = graph::incoming(
        door,
        WIDE,
        id,
        "person",
        &["about", "attendee", "links", "with", "depicts"],
    )?;
    let mut sources: Vec<(String, String)> = incoming
        .iter()
        .map(|joined| (joined.from.clone(), joined.relation.clone()))
        .collect();
    sources.sort();
    sources.dedup();
    let from: Vec<String> = sources.iter().map(|(id, _)| id.clone()).collect();
    let entities = Read {
        name: "people.vault.entity",
        table: "entity",
        select: "id, kind, title, created_at",
        order: ("id", "id"),
        column: "id",
    }
    .within(
        WIDE,
        door,
        &from,
        Some((
            "kind IN (?, ?, ?, ?, ?, ?) AND deleted_at IS NULL",
            vec![
                text("event"),
                text("task"),
                text("note"),
                text("document"),
                text("txn"),
                text("photo"),
            ],
        )),
    )?;
    let event_ids: Vec<String> = entities
        .iter()
        .filter(|row| text_of(row, "kind").as_deref() == Some("event"))
        .filter_map(|row| text_of(row, "id"))
        .collect();
    let events: BTreeMap<String, Row> = Read {
        name: "people.vault.event",
        table: "event",
        select: "id, starts, timing, zone, rule, status",
        order: ("id", "id"),
        column: "id",
    }
    .within(WIDE, door, &event_ids, None)?
    .into_iter()
    .filter_map(|row| Some((text_of(&row, "id")?, row)))
    .collect();
    // A void line is no payment: it stays on the ledger and is not a link to a person.
    let line_ids: Vec<String> = entities
        .iter()
        .filter(|row| text_of(row, "kind").as_deref() == Some("txn"))
        .filter_map(|row| text_of(row, "id"))
        .collect();
    let void: BTreeSet<String> = Read {
        name: "people.vault.txn",
        table: "txn",
        select: "id",
        order: ("id", "id"),
        column: "id",
    }
    .within(
        WIDE,
        door,
        &line_ids,
        Some(("status = ?", vec![text("void")])),
    )?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .collect();
    let mut items: Vec<VaultItem> = Vec::new();
    for row in &entities {
        let (Some(item_id), Some(kind), Some(title), Some(created_at)) = (
            text_of(row, "id"),
            text_of(row, "kind"),
            text_of(row, "title"),
            text_of(row, "created_at"),
        ) else {
            continue;
        };
        let rels = |wanted: &[&str]| {
            sources
                .iter()
                .any(|(from, rel)| *from == item_id && wanted.contains(&rel.as_str()))
        };
        let (kind, starts, timing, zone) = match kind.as_str() {
            "event" => {
                let Some(event) = events.get(&item_id) else {
                    continue;
                };
                let rule = text_of(event, "rule");
                let timing = text_of(event, "timing");
                let yearly_date = timing.as_deref() == Some("all-day")
                    && rule
                        .as_deref()
                        .is_some_and(|rule| rule.starts_with("FREQ=YEARLY"));
                if text_of(event, "status").as_deref() == Some("cancelled")
                    || yearly_date
                    || !rels(&["about", "attendee"])
                {
                    continue;
                }
                let recurring = rule.is_some();
                (
                    VaultKind::Event,
                    text_of(event, "starts").filter(|_| !recurring),
                    timing.filter(|_| !recurring),
                    text_of(event, "zone"),
                )
            }
            "task" if rels(&["about"]) => (VaultKind::Task, None, None, None),
            "note" if rels(&["links"]) => (VaultKind::Note, None, None, None),
            "document" if rels(&["about"]) => (VaultKind::Document, None, None, None),
            "txn" if rels(&["with"]) && !void.contains(&item_id) => {
                (VaultKind::Txn, None, None, None)
            }
            "photo" if rels(&["depicts"]) => (VaultKind::Photo, None, None, None),
            _ => continue,
        };
        items.push(VaultItem {
            id: item_id,
            kind,
            title,
            created_at,
            starts,
            timing,
            zone,
            via: None,
        });
    }
    let direct: BTreeSet<String> = items.iter().map(|item| item.id.clone()).collect();
    items.extend(
        attached_documents(door, id, &items)?
            .into_iter()
            .filter(|item| !direct.contains(&item.id)),
    );
    items.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    let total = items.len();
    let mut shown_of: BTreeMap<VaultKind, usize> = BTreeMap::new();
    items.retain(|item| {
        let shown = shown_of.entry(item.kind).or_default();
        *shown += 1;
        *shown <= VAULT_PER_KIND
    });
    Ok(VaultLinks {
        more: total - items.len(),
        items,
    })
}

/// The live documents attached to the person (`via` none) or to one of the events and tasks in
/// `shown` (`via` that item's title). One document attached to several is listed once, under
/// the person if it is attached to them, else under the first item by id.
fn attached_documents(
    door: &dyn PageDoor,
    id: &str,
    shown: &[VaultItem],
) -> KitResult<Vec<VaultItem>> {
    let mut carriers: Vec<String> = vec![id.to_owned()];
    let titles: BTreeMap<&str, &str> = shown
        .iter()
        .filter(|item| matches!(item.kind, VaultKind::Event | VaultKind::Task))
        .map(|item| (item.id.as_str(), item.title.as_str()))
        .collect();
    carriers.extend(titles.keys().map(|id| (*id).to_owned()));
    let attached = Read {
        name: "people.vault.attached",
        table: "edge",
        select: "from_id, to_id",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .within(
        WIDE,
        door,
        &carriers,
        Some(("rel = ?", vec![text("attached")])),
    )?;
    // The person's own first, so a document attached to both is theirs.
    let mut owner_of: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut pairs: Vec<(String, String)> = attached
        .iter()
        .filter_map(|row| Some((text_of(row, "from_id")?, text_of(row, "to_id")?)))
        .collect();
    pairs.sort_by(|(left, _), (right, _)| {
        (left != id)
            .cmp(&(right != id))
            .then_with(|| left.cmp(right))
    });
    for (from, document) in pairs {
        owner_of.entry(document).or_insert_with(|| {
            (from != id).then(|| {
                titles
                    .get(from.as_str())
                    .copied()
                    .unwrap_or_default()
                    .to_owned()
            })
        });
    }
    let documents: Vec<String> = owner_of.keys().cloned().collect();
    let rows = Read {
        name: "people.vault.document",
        table: "entity",
        select: "id, title, created_at",
        order: ("id", "id"),
        column: "id",
    }
    .within(
        WIDE,
        door,
        &documents,
        Some(("kind = ? AND deleted_at IS NULL", vec![text("document")])),
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let document = text_of(row, "id")?;
            Some(VaultItem {
                via: owner_of.get(&document).cloned().flatten(),
                id: document,
                kind: VaultKind::Document,
                title: text_of(row, "title")?,
                created_at: text_of(row, "created_at")?,
                starts: None,
                timing: None,
                zone: None,
            })
        })
        .collect())
}

/// The important dates of these people: the birthday column, and the yearly
/// all-day events `about` them. **A birthday has its reminder unless the member turned it off**
/// (`person.set_birthday_reminder`); any other date has one when its event does.
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
                reminder_on: person.birthday_reminder,
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
