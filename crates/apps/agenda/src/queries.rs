//! THE FOUR QUERIES: `upcoming`, `search`, `day-context` and `parties`, read one
//! table at a time over the model's own tables (#1135).
//!
//! An event is an `entity` of kind `event` with an `event` row; what a screen
//! shows about it is another table joined by a column or an edge. The paged
//! door's one shape is a keyset page of one table, so a read here is a window of
//! `event` rows and then, per table, the rows that window's ids name,
//! `IN`-bounded by the window and never a whole-table pull.
//!
//! | A screen's word | Read from |
//! |---|---|
//! | the event, its times, its rule | `event` (the window, ordered by `starts`) |
//! | its title, when it was made | `entity` (live ones only: a trashed event is not on the agenda) |
//! | its guests and their answers | `attendee` edges to people, the answer in `state` |
//! | what is attached | `attached` edges to documents and photos ([`centraid_apps_kit::attached`]) |
//! | where | the `place` entity's title |
//! | the calendar and its colour | the `calendar` entity and its `container` row |
//! | a skipped or moved day | `occurrence` rows, keyed by the series-local wall clock |
//! | a birthday | the person's own column |
//!
//! ## Two windows, then the TRUE lower bound
//!
//! `upcoming` reads the events whose `starts` fall inside `[from - 31 days, to)`
//! and, separately, every series (`rule IS NOT NULL`), because a series anchors
//! years in the past and the range predicate would drop it. The two are merged
//! by id, expanded, and then filtered: **every** row, an ordinary event and an
//! expanded occurrence alike, is kept only if it is still running at `from` or
//! starts at or after it ([`still_running_at`]). The expansion runs from the
//! reach-back, which is what finds a multi-day occurrence that began before the
//! range; without the filter every series leaked a month of PAST occurrences
//! into the answer (#1046).
//!
//! ## A trashed event is not on the agenda
//!
//! The window is read from `event`, which has no trash; the trash is `entity`'s,
//! so the entity rows of the window are read live-only and an event with none is
//! dropped. `search` needs no clause of its own: the index drops a trashed row.
//!
//! ## The zone a range is read in
//!
//! `upcoming` and `day-context` take the REQUEST's zone, the device's, stated by
//! the shell ([`crate::local`]). An empty `from` is the first instant of today
//! THERE, not 00:00Z; a floating wall clock and an all-day date are read there
//! when the lower bound asks whether they have ended.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Read, read_pages, read_window};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_vault::time::occurrence::{SeriesType, StoredExceptionRow};
use centraid_vault::time::recurrence::{Semantics, parse_instant_ms};
use centraid_vault::time::zone::FireZone;

pub use centraid_apps_kit::attached::Attachment;

use crate::expansion::{
    DEFAULT_EXPAND_MS, SPAN_BUFFER_MS, expand_recurring_events, recurrence_summary,
};
use crate::{Denial, denial_of};

// ---------------------------------------------------------------------------
// The declared bounds.
// ---------------------------------------------------------------------------

/// One visible range must not make first paint read an unbounded table.
pub const EVENT_WINDOW_CAP: usize = 2_000;
/// The second window: every series, newest anchor first.
pub const RECURRING_ANCHOR_CAP: usize = 1_000;
/// The longest range `day-context` answers.
pub const MAX_RANGE_DAYS: i64 = 400;
/// `day-context`'s default range.
pub const DEFAULT_RANGE_DAYS: i64 = 45;
/// The people the invite directory and the birthday grid walk.
pub const PARTY_CAP: usize = 2_000;
/// How many ranked hits `search` folds.
pub const SEARCH_LIMIT: usize = 100;
/// The fan-out of a join over a bounded set.
pub const EVENT_JOIN_BOUND: FanOutBound = FanOutBound::new(500, 8);

const STARRED: &str = "flag:starred";
const EVENT_COLUMNS: &str = "id, starts, ends, timing, zone, rule, rule_supported, status, \
     calendar_id, place_id, url, reminders, description";
const ENTITY_COLUMNS: &str = "id, title, created_at, updated_at";

fn text(word: &str) -> PageBindValue {
    PageBindValue::Text(word.to_owned())
}

// ---------------------------------------------------------------------------
// The rows, as the payload carries them.
// ---------------------------------------------------------------------------

/// One guest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attendee {
    pub party_id: String,
    pub name: String,
    /// `needs-action`, `accepted`, `declined` or `tentative`.
    pub partstat: String,
    /// **"You" sorts FIRST so RSVP controls lead** (#337): the vault's own
    /// `self_id`, never a guess.
    pub is_you: bool,
}

/// A calendar, as the picker draws it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CalendarRow {
    pub calendar_id: String,
    pub name: Option<String>,
    pub color: Option<String>,
}

/// One event row, or one OCCURRENCE of one, which is the same row with a
/// different `dtstart` and an `instance_key`. The wire's words are kept
/// (`dtstart`, `rrule`, `summary`): `starts`, `rule` and the title are the
/// model's.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EventRow {
    pub event_id: String,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub dtstart: String,
    pub dtend: Option<String>,
    /// The zone of a zoned event; both ends are in it.
    pub start_tz: Option<String>,
    pub end_tz: Option<String>,
    pub recurrence_semantics: Option<String>,
    pub rrule: Option<String>,
    /// `supported` or `unsupported`.
    pub rrule_support: Option<String>,
    pub status: Option<String>,
    pub location_place_id: Option<String>,
    /// The place's name, so a detail can say where without a second read.
    pub location_name: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub calendar_id: Option<String>,
    /// The joining link.
    pub conferencing_uri: Option<String>,
    /// Minutes before it starts, in the order they were set.
    pub reminders: Vec<i64>,
    pub attachments: Vec<Attachment>,
    pub attendees: Vec<Attendee>,
    /// The ONE member-facing recurrence sentence; **never the rule** (#834).
    pub recurrence_summary: Option<String>,
    pub is_recurrence_instance: bool,
    /// The series id for a one-off, and `<event_id>:<wall clock>` for an
    /// occurrence. **The list's key, never the row's identity.**
    pub instance_key: String,
    /// The occurrence's own identity, on an expanded row.
    pub original_start_local: Option<String>,
    /// This occurrence's wall clock happens twice that day.
    pub recurrence_overlap: Option<bool>,
    /// `search` only: the index's own excerpt.
    pub snippet: Option<String>,
}

impl EventRow {
    /// Which reading this series' times are under.
    #[must_use]
    pub fn semantics(&self) -> Semantics {
        Semantics::from_stored(self.recurrence_semantics.as_deref())
    }
}

/// What `upcoming` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UpcomingData {
    pub events: Vec<EventRow>,
    pub calendars: Vec<CalendarRow>,
}

/// What `search` answers: the same rows, in **vault rank order**.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub events: Vec<EventRow>,
}

/// One birthday on the grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BirthdayFact {
    pub party_id: String,
    pub name: String,
    pub month: i64,
    pub day: i64,
    /// `inner` means STARRED; the tier is derived and the derivation is named
    /// here rather than implied.
    pub tier: &'static str,
}

/// What `day-context` answers.
///
/// **NO DUE WORK**: a dated task is a row in its day, read from `tasks.board`
/// (R-1128-F1, #1128).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DayContextData {
    pub birthdays: Vec<BirthdayFact>,
    /// **No holiday source exists in the vault**; the field holds the shape open
    /// and is empty by construction.
    pub holidays: Vec<String>,
}

/// One person the create-event picker can invite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartyEntry {
    pub party_id: String,
    pub name: String,
    pub is_you: bool,
}

/// What `parties` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PartiesData {
    pub parties: Vec<PartyEntry>,
    pub me: Option<String>,
}

// ---------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------

/// `agenda.upcoming.window`: the events whose `starts` fall in the range.
#[must_use]
pub fn event_window_statement(from_lower: &str, to: Option<&str>) -> PageQuery {
    let mut bind = vec![text("cancelled"), text(from_lower)];
    let predicate = match to {
        Some(upper) => {
            bind.push(text(upper));
            "status <> ? AND starts >= ? AND starts < ?"
        }
        None => "status <> ? AND starts >= ?",
    };
    PageQuery::new(
        "agenda.upcoming.window",
        EVENT_COLUMNS,
        "event",
        PageOrder::asc("starts", "id"),
    )
    .filter(predicate, bind)
}

/// `agenda.upcoming.recurringAnchors`: THE SECOND WINDOW, every series, which
/// anchors years in the past and so escapes the range predicate.
#[must_use]
pub fn recurring_anchors_statement() -> PageQuery {
    PageQuery::new(
        "agenda.upcoming.recurringAnchors",
        EVENT_COLUMNS,
        "event",
        PageOrder::desc("starts", "id"),
    )
    .filter("status <> ? AND rule IS NOT NULL", vec![text("cancelled")])
}

/// The id-keyed read of one table: `column IN (the ids)`.
fn by_ids(
    name: &'static str,
    table: &'static str,
    select: &'static str,
    column: &'static str,
) -> Read {
    Read {
        name,
        table,
        select,
        order: (column, column),
        column,
    }
}

fn ids_of(rows: &[Row], column: &str) -> Vec<String> {
    rows.iter()
        .filter_map(|row| text_of(row, column))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

/// The `event` rows' events: the entity's words joined on, in the rows' order,
/// a trashed or purged event left out.
fn live_events(door: &dyn PageDoor, rows: &[Row]) -> KitResult<Vec<EventRow>> {
    let ids = ids_of(rows, "id");
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let entities: BTreeMap<String, Row> =
        by_ids("agenda.events.entity", "entity", ENTITY_COLUMNS, "id")
            .among(
                EVENT_JOIN_BOUND,
                door,
                &ids,
                Some(("kind = ? AND deleted_at IS NULL", vec![text("event")])),
            )?
            .into_iter()
            .filter_map(|row| text_of(&row, "id").map(|id| (id, row)))
            .collect();
    let mut seen = BTreeSet::new();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            let entity = entities.get(&id)?;
            seen.insert(id.clone()).then(|| event_of(row, entity))
        })
        .collect())
}

fn event_of(row: &Row, entity: &Row) -> EventRow {
    let reminders = text_of(row, "reminders")
        .and_then(|json| serde_json::from_str::<Vec<i64>>(&json).ok())
        .unwrap_or_default();
    let zone = text_of(row, "zone");
    EventRow {
        event_id: text_of(row, "id").unwrap_or_default(),
        summary: text_of(entity, "title"),
        description: text_of(row, "description"),
        dtstart: text_of(row, "starts").unwrap_or_default(),
        dtend: text_of(row, "ends"),
        start_tz: zone.clone(),
        end_tz: zone,
        recurrence_semantics: text_of(row, "timing"),
        rrule: text_of(row, "rule"),
        rrule_support: Some(
            if row.get("rule_supported").and_then(Cell::integer) == Some(0) {
                "unsupported"
            } else {
                "supported"
            }
            .to_owned(),
        ),
        status: text_of(row, "status"),
        location_place_id: text_of(row, "place_id"),
        created_at: text_of(entity, "created_at"),
        updated_at: text_of(entity, "updated_at"),
        calendar_id: text_of(row, "calendar_id"),
        conferencing_uri: text_of(row, "url"),
        reminders,
        ..EventRow::default()
    }
}

/// The vault's owner.
fn me(door: &dyn PageDoor) -> KitResult<Option<String>> {
    let page = door.page(
        &PageQuery::new(
            "agenda.vault",
            "self_id",
            "vault",
            PageOrder::asc("self_id", "self_id"),
        ),
        &centraid_apps_kit::page::PageRequest::first(1),
    )?;
    Ok(page.rows.first().and_then(|row| text_of(row, "self_id")))
}

/// What a window of events carries beside its own row: the guests, the
/// attachments and the place's name.
pub(crate) fn decorate(door: &dyn PageDoor, events: &mut [EventRow]) -> KitResult<()> {
    let ids: Vec<String> = events.iter().map(|event| event.event_id.clone()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let owner = me(door)?;
    let invited = by_ids(
        "agenda.events.guests",
        "edge",
        "from_id, to_id, state",
        "from_id",
    )
    .of(door, &ids, Some(("rel = ?", vec![text("attendee")])))?;
    let people = ids_of(&invited, "to_id");
    let names = names_of(door, &people)?;
    let mut guests: BTreeMap<String, Vec<Attendee>> = BTreeMap::new();
    for edge in &invited {
        let (Some(event), Some(person)) = (text_of(edge, "from_id"), text_of(edge, "to_id")) else {
            continue;
        };
        guests.entry(event).or_default().push(Attendee {
            name: names
                .get(&person)
                .cloned()
                .unwrap_or_else(|| "Guest".to_owned()),
            partstat: text_of(edge, "state").unwrap_or_else(|| "needs-action".to_owned()),
            is_you: owner.as_deref() == Some(person.as_str()),
            party_id: person,
        });
    }
    for list in guests.values_mut() {
        list.sort_by(|left, right| {
            right
                .is_you
                .cmp(&left.is_you)
                .then_with(|| left.name.cmp(&right.name))
        });
    }
    let places = names_of(
        door,
        &events
            .iter()
            .filter_map(|event| event.location_place_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>(),
    )?;
    let mut attached = centraid_apps_kit::attached::of(door, &ids)?;
    for event in events {
        event.attendees = guests.remove(&event.event_id).unwrap_or_default();
        event.attachments = attached.remove(&event.event_id).unwrap_or_default();
        event.location_name = event
            .location_place_id
            .as_ref()
            .and_then(|place| places.get(place).cloned());
        // THE ONE SUMMARISER, RESOLVED HERE (#834): the row carries the sentence
        // and never the raw rule.
        event.recurrence_summary = recurrence_summary(event.rrule.as_deref());
    }
    Ok(())
}

/// The titles of the entities among `ids` (a person's name, a place's name).
fn names_of(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeMap<String, String>> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(by_ids("agenda.names", "entity", "id, title", "id")
        .among(EVENT_JOIN_BOUND, door, ids, None)?
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
        .collect())
}

/// The days of these series that were skipped or moved, as the recurrence
/// engine reads them. The `occurrence` row is the model's; the engine's stored
/// row is its own, kept, so one adapter turns the one into the other.
pub(crate) fn read_exceptions(
    door: &dyn PageDoor,
    events: &[EventRow],
) -> KitResult<Vec<StoredExceptionRow>> {
    let ids: Vec<String> = events
        .iter()
        .filter(|event| event.rrule.is_some())
        .map(|event| event.event_id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let timing: BTreeMap<&str, &str> = events
        .iter()
        .map(|event| {
            (
                event.event_id.as_str(),
                event.recurrence_semantics.as_deref().unwrap_or("zoned"),
            )
        })
        .collect();
    Ok(by_ids(
        "agenda.events.occurrences",
        "occurrence",
        "series_id, original_start, scope, cancelled, starts, ends, title, description",
        "series_id",
    )
    .of(door, &ids, None)?
    .iter()
    .map(|row| exception_of(row, &timing))
    .collect())
}

pub(crate) fn exception_of(row: &Row, timing: &BTreeMap<&str, &str>) -> StoredExceptionRow {
    let series = text_of(row, "series_id").unwrap_or_default();
    let cancelled = row.get("cancelled").and_then(Cell::integer) == Some(1);
    let said: serde_json::Map<String, serde_json::Value> = [
        ("start", "starts"),
        ("end", "ends"),
        ("summary", "title"),
        ("description", "description"),
    ]
    .into_iter()
    .filter_map(|(key, column)| Some((key.to_owned(), text_of(row, column)?.into())))
    .collect();
    StoredExceptionRow {
        target_type: Some(SeriesType::Event.as_str().to_owned()),
        recurrence_semantics: timing.get(series.as_str()).map(|word| (*word).to_owned()),
        target_id: Some(series),
        original_start_local: text_of(row, "original_start"),
        scope: text_of(row, "scope"),
        action: Some(if cancelled { "skip" } else { "override" }.to_owned()),
        override_json: (!cancelled).then(|| serde_json::Value::Object(said).to_string()),
    }
}

/// The member's calendars: owner-curated and small, by their order.
pub(crate) fn read_calendars(door: &dyn PageDoor) -> KitResult<Vec<CalendarRow>> {
    let named = read_pages(
        door,
        &PageQuery::new(
            "agenda.upcoming.calendars",
            "id, title",
            "entity",
            PageOrder::asc("title", "id"),
        )
        .filter("kind = ?", vec![text("calendar")]),
        EVENT_JOIN_BOUND,
    )?;
    let ids = ids_of(&named, "id");
    let painted: BTreeMap<String, (Option<String>, f64)> = by_ids(
        "agenda.upcoming.colors",
        "container",
        "id, color, position",
        "id",
    )
    .of(door, &ids, None)?
    .iter()
    .filter_map(|row| {
        Some((
            text_of(row, "id")?,
            (
                text_of(row, "color"),
                match row.get("position") {
                    Some(Cell::Real(at)) => *at,
                    _ => 0.0,
                },
            ),
        ))
    })
    .collect();
    let mut calendars: Vec<CalendarRow> = named
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            Some(CalendarRow {
                color: painted.get(&id).and_then(|(color, _)| color.clone()),
                name: text_of(row, "title"),
                calendar_id: id,
            })
        })
        .collect();
    calendars.sort_by(|left, right| {
        let place = |row: &CalendarRow| painted.get(&row.calendar_id).map_or(0.0, |(_, at)| *at);
        place(left).total_cmp(&place(right))
    });
    Ok(calendars)
}

fn iso_of(millis: i64) -> String {
    centraid_vault::clock::format_iso_ms(millis)
}

/// THE TRUE LOWER BOUND, for every row: an occurrence is in the range if it is
/// still running at `from` (it ends AFTER `from`) or starts at or after it. A
/// run that ended exactly at `from` is out, and a zero-length event AT `from` is
/// in. A row whose start does not parse is kept: dropping it would hide a row.
#[must_use]
pub fn still_running_at(event: &EventRow, from_ms: i64, zone: &FireZone) -> bool {
    crate::local::interval_ms(event, zone)
        .is_none_or(|(start, end)| end > from_ms || start >= from_ms)
}

/// `upcoming`: two windows, the expansion, and the true lower bound.
///
/// `zone` is the request's: an empty `from` is the first instant of today in it,
/// and the lower bound reads floating and all-day rows in it.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a bound that is reached, the
/// join fan-out or [`crate::expansion::MAX_TOTAL_INSTANCES`], is an `Err` naming
/// the size it reached, because a short agenda that reads as a whole one is the
/// truncation flag again (D-1020-D3-12).
pub fn load_upcoming(
    door: &dyn PageDoor,
    from: Option<&str>,
    to: Option<&str>,
    now: &str,
    zone: &FireZone,
) -> KitResult<(UpcomingData, Option<Denial>)> {
    // TODAY IS THE ZONE'S: 00:00Z is somebody else's midnight.
    let from = from.filter(|value| !value.is_empty()).map_or_else(
        || {
            parse_instant_ms(now).map_or_else(
                || format!("{}T00:00:00Z", &now[..10.min(now.len())]),
                |millis| crate::local::start_of_day(zone, zone.zoned_parts(millis)),
            )
        },
        str::to_owned,
    );
    let from_ms = parse_instant_ms(&from);
    // Reach back past `from` so a still-running multi-day event is not cut off.
    let from_lower = from_ms.map_or_else(|| from.clone(), |millis| iso_of(millis - SPAN_BUFFER_MS));
    let window = match read_window(
        door,
        &event_window_statement(&from_lower, to.filter(|value| !value.is_empty())),
        EVENT_WINDOW_CAP,
    ) {
        Ok(window) => window,
        Err(KitError::Door(message)) => {
            return Ok((UpcomingData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let anchors = read_window(door, &recurring_anchors_statement(), RECURRING_ANCHOR_CAP)?;
    let calendars = read_calendars(door)?;
    // THE TWO WINDOWS ARE MERGED BY ID, the anchor read last so its row wins.
    let mut rows: Vec<Row> = Vec::new();
    let mut at: BTreeMap<String, usize> = BTreeMap::new();
    for row in window.rows.into_iter().chain(anchors.rows) {
        let Some(id) = text_of(&row, "id") else {
            continue;
        };
        match at.get(&id) {
            Some(index) => rows[*index] = row,
            None => {
                at.insert(id, rows.len());
                rows.push(row);
            }
        }
    }
    let mut events = live_events(door, &rows)?;
    if events.is_empty() {
        return Ok((UpcomingData { events, calendars }, None));
    }
    decorate(door, &mut events)?;
    let exceptions = read_exceptions(door, &events)?;
    // Open-ended "upcoming" still needs a ceiling to expand against, or a
    // doorbell re-expands a year of a DAILY series (#404).
    let expand_to = match to.filter(|value| !value.is_empty()) {
        Some(upper) => upper.to_owned(),
        None => from_ms.map_or_else(|| from.clone(), |millis| iso_of(millis + DEFAULT_EXPAND_MS)),
    };
    let expanded = expand_recurring_events(events, &from_lower, &expand_to, &exceptions)?;
    // THE TRUE LOWER BOUND, on EVERY row: the expansion ran from the reach-back,
    // so an occurrence of a series is no more in range by construction than a
    // one-off is.
    let mut events: Vec<EventRow> = expanded
        .into_iter()
        .filter(|event| from_ms.is_none_or(|from| still_running_at(event, from, zone)))
        .collect();
    events.sort_by(|left, right| left.dtstart.cmp(&right.dtstart));
    Ok((UpcomingData { events, calendars }, None))
}

/// One event by id, live, decorated: what `event` and `search` fold.
pub(crate) fn events_among(door: &dyn PageDoor, ids: &[String]) -> KitResult<Vec<EventRow>> {
    let rows = by_ids("agenda.events.rows", "event", EVENT_COLUMNS, "id").of(door, ids, None)?;
    let mut events = live_events(door, &rows)?;
    decorate(door, &mut events)?;
    Ok(events)
}

/// `search`: the same rows, in the order the index ranked them. **A cancelled
/// event drops AFTER the hit**, never before: the index knows text, not status.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_search(
    door: &dyn PageDoor,
    hits: &[(String, String)],
) -> KitResult<(SearchData, Option<Denial>)> {
    let ids: Vec<String> = hits.iter().map(|(id, _)| id.clone()).collect();
    if ids.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let mut found: BTreeMap<String, EventRow> = match events_among(door, &ids) {
        Ok(events) => events
            .into_iter()
            .map(|event| (event.event_id.clone(), event))
            .collect(),
        Err(KitError::Door(message)) => {
            return Ok((SearchData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let events = hits
        .iter()
        .filter_map(|(id, snippet)| {
            let mut event = found.remove(id)?;
            (event.status.as_deref() != Some("cancelled")).then(|| {
                event.instance_key = event.event_id.clone();
                event.snippet = Some(snippet.clone());
                event
            })
        })
        .collect();
    Ok((SearchData { events }, None))
}

/// The index's kind for an event.
pub const EVENT_KIND: &str = "event";

/// `search` from a TERM: the index's ranked hits, read back as event rows and
/// folded by [`load_search`]. `limit` is the caller's and is clamped to
/// [`SEARCH_LIMIT`]; a zero is the caller's refusal to state one and is answered
/// as nothing. **A term with no searchable word answers the empty shape and no
/// denial.**
///
/// # Errors
///
/// A reached bound, as [`load_search`]; an index the door cannot use at all is
/// the payload's denial, because a surface renders it rather than a failure.
pub fn load_search_term(
    door: &dyn PageDoor,
    search: &dyn centraid_search::Search,
    principal: &centraid_search::Principal,
    term: &str,
    limit: usize,
) -> KitResult<(SearchData, Option<Denial>)> {
    let term = term.trim();
    if term.is_empty() || limit == 0 {
        return Ok((SearchData::default(), None));
    }
    let request = centraid_search::SearchRequest::new(EVENT_KIND, term, limit.min(SEARCH_LIMIT));
    let page = match search.query(principal, &request) {
        Ok(centraid_search::Answer::Data { page, .. }) => page,
        Ok(centraid_search::Answer::Denied(denial)) => {
            return Ok((
                SearchData::default(),
                Some(Denial {
                    code: denial.code,
                    message: denial.message,
                    revoked_at: denial.revoked_at,
                }),
            ));
        }
        Err(centraid_search::SearchError::NoSearchableWords { .. }) => {
            return Ok((SearchData::default(), None));
        }
        Err(other) => return Ok((SearchData::default(), Some(denial_of(other.to_string())))),
    };
    // VAULT ORDER IS RANK ORDER, best match first.
    let hits: Vec<(String, String)> = page
        .rows
        .iter()
        .map(|target| (target.id.clone(), target.snippet.clone()))
        .collect();
    load_search(door, &hits)
}

// ---------------------------------------------------------------------------
// The grid's two decorations.
// ---------------------------------------------------------------------------

/// A `YYYY-MM-DD` day, or `None`.
fn day_of(value: Option<&str>) -> Option<String> {
    let value = value?;
    let head: String = value.chars().take(10).collect();
    centraid_vault::time::zone::parse_wall_iso(&head)
        .filter(|_| head.len() == 10)
        .map(|_| head)
}

/// Civil day arithmetic, never an instant: a day is a day on both sides of a
/// DST boundary.
fn add_days(day: &str, days: i64) -> String {
    centraid_vault::time::zone::parse_wall_iso(day).map_or_else(
        || day.to_owned(),
        |wall| {
            centraid_vault::time::zone::wall_iso(
                centraid_vault::time::zone::add_wall_days(wall, days),
                false,
            )
        },
    )
}

/// The range the grid asked for, clamped. **An unusable range is not an error;
/// the default window stands** (`day-context.ts:100`). The default's first day
/// is TODAY IN `zone` — the vault clock's instant read there, never its UTC
/// date.
#[must_use]
pub fn range_of(
    from: Option<&str>,
    to: Option<&str>,
    now: &str,
    zone: &FireZone,
) -> (String, String) {
    let today: String =
        crate::local::today(zone, now).unwrap_or_else(|| now.chars().take(10).collect());
    let from = day_of(from).unwrap_or(today);
    let asked = day_of(to);
    let fallback = add_days(&from, DEFAULT_RANGE_DAYS);
    let to = match asked {
        Some(asked) if asked >= from => asked,
        _ => fallback,
    };
    let ceiling = add_days(&from, MAX_RANGE_DAYS);
    (from, if to > ceiling { ceiling } else { to })
}

/// **Both stored forms end in the recurring `MM-DD`** — `YYYY-MM-DD` and the
/// year-less `--MM-DD` the vault writes (`day-context.ts:112`).
fn month_day_of(birth_date: Option<&str>) -> Option<(i64, i64)> {
    let value = birth_date?;
    if value.len() < 5 {
        return None;
    }
    let tail = &value[value.len() - 5..];
    let bytes = tail.as_bytes();
    if bytes[2] != b'-' || !bytes[..2].iter().chain(&bytes[3..]).all(u8::is_ascii_digit) {
        return None;
    }
    let month: i64 = tail[..2].parse().ok()?;
    let day: i64 = tail[3..].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((month, day))
}

/// **Day by day, so 29 February stays absent in a non-leap year**
/// (`day-context.ts:129`). A month/day comparison against the range's ends
/// cannot express that, and a birthday that silently appears on 1 March is the
/// failure this walk exists to avoid.
fn recurs_in_range(month: i64, day: i64, from: &str, to: &str) -> bool {
    let target = format!("{month:02}-{day:02}");
    let mut cursor = from.to_owned();
    while cursor.as_str() <= to {
        if cursor.len() >= 10 && cursor[5..10] == target {
            return true;
        }
        let next = add_days(&cursor, 1);
        if next == cursor {
            break;
        }
        cursor = next;
    }
    false
}

/// `day-context`: birthdays for the calendar grid.
///
/// `zone` is the request's, and it decides only which day an empty `from` is: a
/// birthday is a civil day already.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_day_context(
    door: &dyn PageDoor,
    from: Option<&str>,
    to: Option<&str>,
    now: &str,
    zone: &FireZone,
) -> KitResult<(DayContextData, Option<Denial>)> {
    let (from, to) = range_of(from, to, now, zone);
    let born = match read_window(
        door,
        &PageQuery::new(
            "agenda.dayContext.birthdays",
            "id, birthday",
            "person",
            PageOrder::asc("id", "id"),
        )
        .filter("birthday IS NOT NULL", Vec::new()),
        PARTY_CAP,
    ) {
        Ok(window) => window.rows,
        Err(KitError::Door(message)) => {
            return Ok((DayContextData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let due: Vec<&Row> = born
        .iter()
        .filter(|row| {
            month_day_of(text_of(row, "birthday").as_deref())
                .is_some_and(|(month, day)| recurs_in_range(month, day, &from, &to))
        })
        .collect();
    let ids: Vec<String> = due.iter().filter_map(|row| text_of(row, "id")).collect();
    if ids.is_empty() {
        return Ok((DayContextData::default(), None));
    }
    // A trashed person has no birthday on the grid.
    let names: BTreeMap<String, String> =
        by_ids("agenda.dayContext.names", "entity", "id, title", "id")
            .among(
                EVENT_JOIN_BOUND,
                door,
                &ids,
                Some(("deleted_at IS NULL", Vec::new())),
            )?
            .iter()
            .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
            .collect();
    // NO STAR MEANS NOBODY IS STARRED: an honest `outer`, never a refusal.
    let starred: BTreeSet<String> = by_ids(
        "agenda.dayContext.starred",
        "edge",
        "from_id, to_id",
        "from_id",
    )
    .among(
        EVENT_JOIN_BOUND,
        door,
        &ids,
        Some(("rel = ? AND to_id = ?", vec![text("tagged"), text(STARRED)])),
    )?
    .iter()
    .filter_map(|row| text_of(row, "from_id"))
    .collect();
    let mut birthdays: Vec<BirthdayFact> = due
        .iter()
        .filter_map(|row| {
            let party_id = text_of(row, "id")?;
            let (month, day) = month_day_of(text_of(row, "birthday").as_deref())?;
            Some(BirthdayFact {
                name: names.get(&party_id)?.clone(),
                tier: if starred.contains(&party_id) {
                    "inner"
                } else {
                    "outer"
                },
                party_id,
                month,
                day,
            })
        })
        .collect();
    birthdays.sort_by(|left, right| {
        left.month
            .cmp(&right.month)
            .then_with(|| left.day.cmp(&right.day))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok((
        DayContextData {
            birthdays,
            holidays: Vec::new(),
        },
        None,
    ))
}

/// `parties`: the invite directory, the people of the vault (not an
/// organisation, a group or a pet), the owner first.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_parties(door: &dyn PageDoor) -> KitResult<(PartiesData, Option<Denial>)> {
    let owner = match me(door) {
        Ok(owner) => owner,
        Err(KitError::Door(message)) => {
            return Ok((PartiesData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let named = read_window(
        door,
        &PageQuery::new(
            "agenda.parties.people",
            "id, title",
            "entity",
            PageOrder::asc("title", "id"),
        )
        .filter("kind = ? AND deleted_at IS NULL", vec![text("person")]),
        PARTY_CAP,
    )?;
    let ids = ids_of(&named.rows, "id");
    let people: BTreeSet<String> = by_ids("agenda.parties.forms", "person", "id, form", "id")
        .among(
            EVENT_JOIN_BOUND,
            door,
            &ids,
            Some(("form = ?", vec![text("person")])),
        )?
        .iter()
        .filter_map(|row| text_of(row, "id"))
        .collect();
    let mut parties: Vec<PartyEntry> = named
        .rows
        .iter()
        .filter_map(|row| {
            let party_id = text_of(row, "id").filter(|id| people.contains(id))?;
            Some(PartyEntry {
                is_you: owner.as_deref() == Some(party_id.as_str()),
                name: text_of(row, "title").unwrap_or_else(|| "Guest".to_owned()),
                party_id,
            })
        })
        .collect();
    // The owner sorts FIRST and is flagged; everyone else is a peer.
    parties.sort_by(|left, right| {
        right
            .is_you
            .cmp(&left.is_you)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok((PartiesData { parties, me: owner }, None))
}
