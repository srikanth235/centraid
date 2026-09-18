//! THE FOUR QUERIES: `upcoming`, `search`, `day-context` and `parties`.
//!
//! `queries/upcoming.ts` is the one to read first (629 lines). Its doctrine, in
//! its own words: *"`{from, to}` optional (default: today forward); events
//! fetched from BEFORE `from` so multi-day spans arrive — the filter below
//! re-applies the true lower bound."*
//!
//! ## The reads that DISCOVER rows, and the ones that decorate them
//!
//! | Read | What it is |
//! |---|---|
//! | `agenda.upcoming.window` | **the visible range, as a page**: `status <> 'cancelled'` and `dtstart` inside `[from - 31 days, to)`, capped at [`EVENT_WINDOW_CAP`] |
//! | `agenda.upcoming.recurringAnchors` | **the second window**: a series anchors years in the past, so the range predicate would drop it. `rrule IS NOT NULL`, newest first, capped at [`RECURRING_ANCHOR_CAP`] (D-1020-S4) |
//! | `ctx.vault.search` | `search`'s own FTS read, which is `crates/search`'s and not a [`PageQuery`] — the hits arrive here in RANK ORDER and the fold keeps that order |
//! | `agenda.dayContext.birthdays` / `.dueTasks` | the grid's two decorations, each its own stated window |
//! | `agenda.parties.people` | the invite directory: owner-curated, walked with a stated ceiling |
//!
//! Everything else — the calendar edges, the guests, the attachments, the
//! bytes, the parties and the exceptions — is `IN`-bounded by ids one of those
//! already returned.
//!
//! ## Two windows, then the TRUE lower bound
//!
//! The two windows are merged by `event_id` (the recurring read wins, because
//! it carries the anchor row), expanded, and then filtered: an ordinary event
//! is kept only if it is still running at `from`. A recurrence instance is
//! in-range by construction and is never re-filtered — which is why the
//! `SPAN_BUFFER_MS` reach-back cannot leak a month of past occurrences.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages, read_window};
use centraid_apps_kit::representations::{RepresentationIndex, read_representations};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_vault::time::occurrence::StoredExceptionRow;
use centraid_vault::time::recurrence::{Semantics, parse_instant_ms};

use crate::expansion::{
    DEFAULT_EXPAND_MS, SPAN_BUFFER_MS, expand_recurring_events, recurrence_summary,
};
use crate::{Denial, denial_of};

// ---------------------------------------------------------------------------
// The declared bounds (`day-context.ts:83`-`:89`, `upcoming.ts:180`-`:185`).
// ---------------------------------------------------------------------------

/// One visible range must not make first paint read an unbounded table.
pub const EVENT_WINDOW_CAP: usize = 2_000;
/// Series anchors live in the past; cap rows instead of walking unbounded.
pub const RECURRING_ANCHOR_CAP: usize = 1_000;
/// The widest range the grid will answer for, in days.
pub const MAX_RANGE_DAYS: i64 = 400;
/// The default range when the caller states none.
pub const DEFAULT_RANGE_DAYS: i64 = 45;
/// A vault has no upper bound; reads are row-capped.
pub const PARTY_CAP: usize = 2_000;
pub const TASK_CAP: usize = 2_000;
pub const TAG_CAP: usize = 5_000;
/// A shelf LISTS; it never pages.
pub const SHELF_CAP: usize = 8;
/// FTS answers at most this many matches (`search.ts:38`).
pub const SEARCH_LIMIT: usize = 100;

/// A join per windowed event: the kit's default, 500 × 8 = 4,000 rows.
pub const EVENT_JOIN_BOUND: FanOutBound = FanOutBound::new(500, 8);

/// The blob route a `blob:` content URI becomes (`upcoming.ts:106`).
pub const BLOB_ROUTE: &str = "/centraid/_vault/blobs";

/// The flags scheme, and the notation a starred party carries.
pub const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
pub const STARRED_NOTATION: &str = "starred";

/// The statuses an open task carries (`day-context.ts:91`).
pub const OPEN_STATUSES: [&str; 2] = ["needs-action", "in-process"];

/// One `core.event` row, as both of `upcoming`'s windows project it
/// (`upcoming.ts:11`-`:15`).
pub const EVENT_COLUMNS: &str = "event_id, ical_uid, summary, description, dtstart, dtend, \
     start_tz, end_tz, recurrence_semantics, rrule, rrule_support, status, location_place_id, \
     organizer_party_id, sequence, created_at, updated_at";

// ---------------------------------------------------------------------------
// The rows, as the payload carries them.
// ---------------------------------------------------------------------------

/// One attachment on an event, joined to its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Attachment {
    pub attachment_id: String,
    pub content_id: String,
    pub role: Option<String>,
    pub is_primary: Option<i64>,
    /// **The ATTACHMENT's own reading of the bytes** (#996 R20(b)); bytes carry
    /// neither a media type nor a title of their own.
    pub media_type: String,
    pub content_uri: String,
    pub byte_size: i64,
}

/// One guest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attendee {
    /// Absent on `search`'s projection, and on a guest an override introduced.
    pub attendee_id: Option<String>,
    pub party_id: String,
    pub name: String,
    pub partstat: String,
    pub role: Option<String>,
    /// **"You" sorts FIRST so RSVP controls lead** (#337); this is the vault's
    /// own `self_party_id`, never a guess.
    pub is_you: bool,
}

/// A calendar, as the picker draws it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CalendarRow {
    pub calendar_id: String,
    pub owner_party_id: Option<String>,
    pub name: Option<String>,
    pub color: Option<String>,
    pub default_tz: Option<String>,
    pub visibility: Option<String>,
}

/// One event row — or one OCCURRENCE of one, which is the same row with a
/// different `dtstart` and an `instance_key`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EventRow {
    pub event_id: String,
    pub ical_uid: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub dtstart: String,
    pub dtend: Option<String>,
    pub start_tz: Option<String>,
    pub end_tz: Option<String>,
    pub recurrence_semantics: Option<String>,
    pub rrule: Option<String>,
    pub rrule_support: Option<String>,
    pub status: Option<String>,
    pub location_place_id: Option<String>,
    pub organizer_party_id: Option<String>,
    pub sequence: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub calendar_id: Option<String>,
    pub conferencing_uri: Option<String>,
    pub reminders_json: Option<String>,
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
    /// `inner` means STARRED. **No `relationship_tier` column exists**
    /// (`day-context.ts:79`), so the tier is derived and the derivation is
    /// named here rather than implied.
    pub tier: &'static str,
}

/// One due task on a day's shelf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueTask {
    pub task_id: String,
    pub title: String,
}

/// One day with work due on it. **Days with none are ABSENT, not zero-filled.**
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueFact {
    pub day: String,
    pub count: usize,
    /// In due order. A shelf lists; it never pages.
    pub tasks: Vec<DueTask>,
}

/// What `day-context` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DayContextData {
    pub birthdays: Vec<BirthdayFact>,
    pub due: Vec<DueFact>,
    /// **No holiday source exists in the vault**; the field holds the shape
    /// open (`day-context.ts:263`) and is empty by construction, not by
    /// accident.
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
// Statements.
// ---------------------------------------------------------------------------

/// `agenda.upcoming.window` — the visible range, as a page.
///
/// `dtstart` is `NOT NULL` on `core_event`, so the page is continuable.
#[must_use]
pub fn event_window_statement(from_lower: &str, to: Option<&str>) -> PageQuery {
    let mut bind = vec![
        PageBindValue::Text("cancelled".to_owned()),
        PageBindValue::Text(from_lower.to_owned()),
    ];
    let predicate = match to {
        Some(upper) => {
            bind.push(PageBindValue::Text(upper.to_owned()));
            "status <> ? AND dtstart >= ? AND dtstart < ?"
        }
        None => "status <> ? AND dtstart >= ?",
    };
    PageQuery::new(
        "agenda.upcoming.window",
        EVENT_COLUMNS,
        "core_event",
        PageOrder::asc("dtstart", "event_id"),
    )
    .filter(predicate, bind)
}

/// `agenda.upcoming.recurringAnchors` — THE SECOND WINDOW.
///
/// A recurring series anchors years in the past, so the range predicate would
/// drop it; the anchors are fetched separately and merged before the range
/// check (`upcoming.ts:352`-`:354`).
#[must_use]
pub fn recurring_anchors_statement() -> PageQuery {
    PageQuery::new(
        "agenda.upcoming.recurringAnchors",
        EVENT_COLUMNS,
        "core_event",
        PageOrder::desc("dtstart", "event_id"),
    )
    .filter(
        "status <> ? AND rrule IS NOT NULL",
        vec![PageBindValue::Text("cancelled".to_owned())],
    )
}

/// `agenda.upcoming.calendars` — the member's own calendars: owner-curated and
/// small.
#[must_use]
pub fn calendars_statement() -> PageQuery {
    PageQuery::new(
        "agenda.upcoming.calendars",
        "calendar_id, owner_party_id, name, color, default_tz, visibility",
        "schedule_calendar",
        PageOrder::asc("calendar_id", "calendar_id"),
    )
}

fn by_event(
    name: &'static str,
    select: &'static str,
    from: &'static str,
    pk: &'static str,
    event_ids: &[String],
) -> KitResult<PageQuery> {
    let fragment = in_list("event_id", event_ids)?;
    Ok(PageQuery::new(name, select, from, PageOrder::asc(pk, pk))
        .filter(&fragment.sql, fragment.bind))
}

fn by_target(
    name: &'static str,
    select: &'static str,
    from: &'static str,
    pk: &'static str,
    target_type: &str,
    event_ids: &[String],
) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", event_ids)?;
    let mut bind = vec![PageBindValue::Text(target_type.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(name, select, from, PageOrder::asc(pk, pk))
        .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `agenda.<query>.eventExt` — the calendar edge.
pub fn event_ext_statement(name: &'static str, event_ids: &[String]) -> KitResult<PageQuery> {
    by_event(
        name,
        "event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, \
         travel_buffer_min",
        "schedule_event_ext",
        "event_ext_id",
        event_ids,
    )
}

/// `agenda.<query>.attendees` — the guests.
pub fn attendees_statement(name: &'static str, event_ids: &[String]) -> KitResult<PageQuery> {
    by_event(
        name,
        "attendee_id, event_id, party_id, partstat, role",
        "schedule_attendee",
        "attendee_id",
        event_ids,
    )
}

/// `agenda.<query>.attachments` — the attachment edges.
pub fn attachments_statement(name: &'static str, event_ids: &[String]) -> KitResult<PageQuery> {
    by_target(
        name,
        "attachment_id, target_type, target_id, content_id, role, is_primary",
        "core_attachment",
        "attachment_id",
        "core.event",
        event_ids,
    )
}

/// `agenda.upcoming.exceptions` — the stored occurrence exceptions.
///
/// **The projection names `original_start_local` through
/// [`centraid_vault::time::occurrence::OCCURRENCE_LOCAL_START_COLUMN`]**, which
/// is the one place the spelling appears (#996 R21, ONT-25).
pub fn exceptions_statement(event_ids: &[String]) -> KitResult<PageQuery> {
    let column = centraid_vault::time::occurrence::OCCURRENCE_LOCAL_START_COLUMN;
    let fragment = in_list("target_id", event_ids)?;
    let mut bind = vec![PageBindValue::Text("core.event".to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "agenda.upcoming.exceptions",
        &format!(
            "exception_id, target_type, target_id, {column}, recurrence_semantics, scope, \
             action, override_json"
        ),
        "schedule_recurrence_exception",
        PageOrder::asc("exception_id", "exception_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `agenda.<query>.vault` — the owner's own party, so a guest that IS you gets
/// RSVP controls (#337).
#[must_use]
pub fn vault_statement(name: &'static str) -> PageQuery {
    PageQuery::new(
        name,
        "vault_id, self_party_id",
        "core_vault",
        PageOrder::asc("vault_id", "vault_id"),
    )
}

/// `agenda.<query>.parties` — the names the guests carry.
pub fn parties_statement(name: &'static str, party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        name,
        "party_id, display_name",
        "core_party",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `agenda.<query>.contents` — the bytes an attachment points at.
pub fn contents_statement(name: &'static str, content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        name,
        "content_id, content_uri, byte_size",
        "core_content_item",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `agenda.dayContext.birthdays` — every person with a birth date.
#[must_use]
pub fn birthdays_statement() -> PageQuery {
    PageQuery::new(
        "agenda.dayContext.birthdays",
        "party_id, display_name, kind, birth_date",
        "core_party",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(
        "kind = ? AND birth_date IS NOT NULL",
        vec![PageBindValue::Text("person".to_owned())],
    )
}

/// `agenda.dayContext.dueTasks` — the open tasks due in the range.
///
/// **`due_at IS NOT NULL` is stated even though the range implies it**: the
/// paged door proves a nullable sort column SYNTACTICALLY, and without the
/// words a continuation over this window would be refused rather than served
/// (#1020, R-1020-35, `day-context.ts:168`-`:172`).
pub fn due_tasks_statement(from: &str, upper: &str) -> KitResult<PageQuery> {
    let fragment = in_list("status", &OPEN_STATUSES.map(str::to_owned))?;
    let mut bind = fragment.bind;
    bind.push(PageBindValue::Text(from.to_owned()));
    bind.push(PageBindValue::Text(upper.to_owned()));
    Ok(PageQuery::new(
        "agenda.dayContext.dueTasks",
        "task_id, status, title, due_at, project_id",
        "schedule_task",
        PageOrder::asc("due_at", "task_id"),
    )
    .filter(
        &format!(
            "{} AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?",
            fragment.sql
        ),
        bind,
    ))
}

/// `agenda.dayContext.flagsScheme` — the flags scheme, if this vault has one.
#[must_use]
pub fn flags_scheme_statement() -> PageQuery {
    PageQuery::new(
        "agenda.dayContext.flagsScheme",
        "scheme_id, uri",
        "core_concept_scheme",
        PageOrder::asc("scheme_id", "scheme_id"),
    )
    .filter(
        "uri = ?",
        vec![PageBindValue::Text(FLAGS_SCHEME_URI.to_owned())],
    )
}

/// `agenda.dayContext.flagConcepts` — its concepts.
#[must_use]
pub fn flag_concepts_statement(scheme_id: &str) -> PageQuery {
    PageQuery::new(
        "agenda.dayContext.flagConcepts",
        "concept_id, scheme_id, notation",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
    .filter(
        "scheme_id = ?",
        vec![PageBindValue::Text(scheme_id.to_owned())],
    )
}

/// `agenda.dayContext.starTags` — who is starred.
#[must_use]
pub fn star_tags_statement(concept_id: &str) -> PageQuery {
    PageQuery::new(
        "agenda.dayContext.starTags",
        "tag_id, target_type, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(
        "target_type = ? AND concept_id = ?",
        vec![
            PageBindValue::Text("core.party".to_owned()),
            PageBindValue::Text(concept_id.to_owned()),
        ],
    )
}

/// `agenda.parties.people` — the invite directory.
///
/// **Agents, orgs and groups are left out**: an invitation is a commitment
/// asked of a person (`parties.ts:1`-`:9`).
#[must_use]
pub fn people_statement() -> PageQuery {
    PageQuery::new(
        "agenda.parties.people",
        "party_id, display_name, kind",
        "core_party",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter("kind = ?", vec![PageBindValue::Text("person".to_owned())])
}

// ---------------------------------------------------------------------------
// The folds.
// ---------------------------------------------------------------------------

fn cell_text(row: &Row, column: &str) -> Option<String> {
    text_of(row, column)
}

fn cell_int(row: &Row, column: &str) -> Option<i64> {
    row.get(column)
        .and_then(centraid_apps_kit::row::Cell::integer)
}

/// Blob-backed bytes serve as same-origin URLs (#296).
fn source_of(content_uri: Option<&str>, content_id: &str) -> String {
    match content_uri {
        Some(uri) if uri.starts_with("blob:") => format!("{BLOB_ROUTE}/{content_id}"),
        Some(uri) => uri.to_owned(),
        None => String::new(),
    }
}

/// The shared attachment projection. `is_primary` first, then the order the
/// read returned — a STABLE sort, as v0's is.
fn attachments_by_subject(
    attachment_rows: &[Row],
    content_rows: &[Row],
    representations: &RepresentationIndex,
) -> BTreeMap<String, Vec<Attachment>> {
    let contents: BTreeMap<String, &Row> = content_rows
        .iter()
        .filter_map(|row| cell_text(row, "content_id").map(|id| (id, row)))
        .collect();
    let mut by_subject: BTreeMap<String, Vec<Attachment>> = BTreeMap::new();
    for row in attachment_rows {
        let Some(attachment_id) = cell_text(row, "attachment_id") else {
            continue;
        };
        let Some(target_id) = cell_text(row, "target_id") else {
            continue;
        };
        let content_id = cell_text(row, "content_id").unwrap_or_default();
        let content = contents.get(&content_id);
        by_subject.entry(target_id).or_default().push(Attachment {
            media_type: representations
                .owner("core.attachment", &attachment_id)
                .or_else(|| representations.content(&content_id))
                .unwrap_or("application/octet-stream")
                .to_owned(),
            content_uri: source_of(
                content
                    .and_then(|row| cell_text(row, "content_uri"))
                    .as_deref(),
                &content_id,
            ),
            byte_size: content
                .and_then(|row| cell_int(row, "byte_size"))
                .unwrap_or(0),
            attachment_id,
            content_id,
            role: cell_text(row, "role"),
            is_primary: cell_int(row, "is_primary"),
        });
    }
    for list in by_subject.values_mut() {
        list.sort_by(|left, right| {
            right
                .is_primary
                .unwrap_or(0)
                .cmp(&left.is_primary.unwrap_or(0))
        });
    }
    by_subject
}

/// The shared guest projection. **"You" sorts FIRST so RSVP controls lead**
/// (#337), then by name.
///
/// v0 orders the name half with `localeCompare`; this is code-point order. For
/// the ASCII display names a vault holds the two agree, and the divergence is
/// stated rather than reconciled — a `localeCompare` port would put ICU in the
/// app plane for a tie-break (the same call `crates/apps/kit::money` records).
fn attendees_by_event(
    attendee_rows: &[Row],
    names: &BTreeMap<String, String>,
    me: Option<&str>,
    carry_attendee_id: bool,
) -> BTreeMap<String, Vec<Attendee>> {
    let mut by_event: BTreeMap<String, Vec<Attendee>> = BTreeMap::new();
    for row in attendee_rows {
        let Some(event_id) = cell_text(row, "event_id") else {
            continue;
        };
        let party_id = cell_text(row, "party_id").unwrap_or_default();
        by_event.entry(event_id).or_default().push(Attendee {
            attendee_id: if carry_attendee_id {
                cell_text(row, "attendee_id")
            } else {
                None
            },
            name: names
                .get(&party_id)
                .cloned()
                .unwrap_or_else(|| "Guest".to_owned()),
            is_you: me.is_some_and(|me| me == party_id),
            party_id,
            partstat: cell_text(row, "partstat").unwrap_or_default(),
            role: cell_text(row, "role"),
        });
    }
    for list in by_event.values_mut() {
        list.sort_by(|left, right| {
            right
                .is_you
                .cmp(&left.is_you)
                .then_with(|| left.name.cmp(&right.name))
        });
    }
    by_event
}

/// One `core_event` row, read off the page.
fn event_of(row: &Row) -> Option<EventRow> {
    Some(EventRow {
        event_id: cell_text(row, "event_id")?,
        ical_uid: cell_text(row, "ical_uid"),
        summary: cell_text(row, "summary"),
        description: cell_text(row, "description"),
        dtstart: cell_text(row, "dtstart").unwrap_or_default(),
        dtend: cell_text(row, "dtend"),
        start_tz: cell_text(row, "start_tz"),
        end_tz: cell_text(row, "end_tz"),
        recurrence_semantics: cell_text(row, "recurrence_semantics"),
        rrule: cell_text(row, "rrule"),
        rrule_support: cell_text(row, "rrule_support"),
        status: cell_text(row, "status"),
        location_place_id: cell_text(row, "location_place_id"),
        organizer_party_id: cell_text(row, "organizer_party_id"),
        sequence: cell_int(row, "sequence"),
        created_at: cell_text(row, "created_at"),
        updated_at: cell_text(row, "updated_at"),
        ..EventRow::default()
    })
}

fn calendar_of(row: &Row) -> Option<CalendarRow> {
    Some(CalendarRow {
        calendar_id: cell_text(row, "calendar_id")?,
        owner_party_id: cell_text(row, "owner_party_id"),
        name: cell_text(row, "name"),
        color: cell_text(row, "color"),
        default_tz: cell_text(row, "default_tz"),
        visibility: cell_text(row, "visibility"),
    })
}

fn exception_of(row: &Row) -> StoredExceptionRow {
    StoredExceptionRow {
        target_type: cell_text(row, "target_type"),
        target_id: cell_text(row, "target_id"),
        original_start_local: cell_text(
            row,
            centraid_vault::time::occurrence::OCCURRENCE_LOCAL_START_COLUMN,
        ),
        recurrence_semantics: cell_text(row, "recurrence_semantics"),
        scope: cell_text(row, "scope"),
        action: cell_text(row, "action"),
        override_json: cell_text(row, "override_json"),
    }
}

/// The owner's own party, from `core_vault`.
fn me_of(rows: &[Row]) -> Option<String> {
    rows.first().and_then(|row| cell_text(row, "self_party_id"))
}

/// Every decoration the two event queries share, read over one windowed set.
struct Decorations {
    ext: BTreeMap<String, Row>,
    attachments: BTreeMap<String, Vec<Attachment>>,
    attendees: BTreeMap<String, Vec<Attendee>>,
}

fn read_decorations(
    door: &dyn PageDoor,
    prefix: &'static str,
    event_ids: &[String],
    carry_attendee_id: bool,
) -> KitResult<Decorations> {
    let ext_rows = read_pages(
        door,
        &event_ext_statement(name_of(prefix, "eventExt"), event_ids)?,
        EVENT_JOIN_BOUND,
    )?;
    let attachment_rows = read_pages(
        door,
        &attachments_statement(name_of(prefix, "attachments"), event_ids)?,
        EVENT_JOIN_BOUND,
    )?;
    let attendee_rows = read_pages(
        door,
        &attendees_statement(name_of(prefix, "attendees"), event_ids)?,
        EVENT_JOIN_BOUND,
    )?;
    let vault_rows = read_pages(
        door,
        &vault_statement(name_of(prefix, "vault")),
        EVENT_JOIN_BOUND,
    )?;
    let me = me_of(&vault_rows);
    let party_ids: Vec<String> = attendee_rows
        .iter()
        .filter_map(|row| cell_text(row, "party_id"))
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let party_rows = if party_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(
            door,
            &parties_statement(name_of(prefix, "parties"), &party_ids)?,
            EVENT_JOIN_BOUND,
        )?
    };
    let names: BTreeMap<String, String> = party_rows
        .iter()
        .filter_map(|row| Some((cell_text(row, "party_id")?, cell_text(row, "display_name")?)))
        .collect();
    let content_ids: Vec<String> = attachment_rows
        .iter()
        .filter_map(|row| cell_text(row, "content_id"))
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let content_rows = if content_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(
            door,
            &contents_statement(name_of(prefix, "contents"), &content_ids)?,
            EVENT_JOIN_BOUND,
        )?
    };
    let representations = read_representations(door, &content_ids, EVENT_JOIN_BOUND)?;
    Ok(Decorations {
        ext: ext_rows
            .into_iter()
            .filter_map(|row| cell_text(&row, "event_id").map(|id| (id, row)))
            .collect(),
        attachments: attachments_by_subject(&attachment_rows, &content_rows, &representations),
        attendees: attendees_by_event(&attendee_rows, &names, me.as_deref(), carry_attendee_id),
    })
}

/// The statement names are v0's, and the prefix says which query asked.
fn name_of(prefix: &'static str, leaf: &'static str) -> &'static str {
    match (prefix, leaf) {
        ("upcoming", "eventExt") => "agenda.upcoming.eventExt",
        ("upcoming", "attachments") => "agenda.upcoming.attachments",
        ("upcoming", "attendees") => "agenda.upcoming.attendees",
        ("upcoming", "vault") => "agenda.upcoming.vault",
        ("upcoming", "parties") => "agenda.upcoming.parties",
        ("upcoming", "contents") => "agenda.upcoming.contents",
        ("search", "eventExt") => "agenda.search.eventExt",
        ("search", "attachments") => "agenda.search.attachments",
        ("search", "attendees") => "agenda.search.attendees",
        ("search", "vault") => "agenda.search.vault",
        ("search", "parties") => "agenda.search.parties",
        ("search", "contents") => "agenda.search.contents",
        _ => "agenda.unknown",
    }
}

fn decorate(event: &mut EventRow, decorations: &Decorations) {
    let ext = decorations.ext.get(&event.event_id);
    event.calendar_id = ext.and_then(|row| cell_text(row, "calendar_id"));
    event.conferencing_uri = ext.and_then(|row| cell_text(row, "conferencing_uri"));
    event.reminders_json = ext.and_then(|row| cell_text(row, "reminders_json"));
    event.attachments = decorations
        .attachments
        .get(&event.event_id)
        .cloned()
        .unwrap_or_default();
    event.attendees = decorations
        .attendees
        .get(&event.event_id)
        .cloned()
        .unwrap_or_default();
    // THE ONE SUMMARISER, RESOLVED HERE (#834): the row carries the sentence
    // and never the raw rule.
    event.recurrence_summary = recurrence_summary(event.rrule.as_deref());
}

fn iso_of(millis: i64) -> String {
    centraid_vault::clock::format_iso_ms(millis)
}

/// `upcoming` — TWO WINDOWS, the expansion, and the true lower bound.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a bound that is reached — the
/// join fan-out, or [`crate::expansion::MAX_TOTAL_INSTANCES`] — is an `Err`
/// naming the size it reached, because a short agenda that reads as a whole one
/// is the truncation flag again (D-1020-D3-12).
pub fn load_upcoming(
    door: &dyn PageDoor,
    from: Option<&str>,
    to: Option<&str>,
    now: &str,
) -> KitResult<(UpcomingData, Option<Denial>)> {
    let from = from.filter(|value| !value.is_empty()).map_or_else(
        || format!("{}T00:00:00Z", &now[..10.min(now.len())]),
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
    let calendars: Vec<CalendarRow> = read_pages(door, &calendars_statement(), EVENT_JOIN_BOUND)?
        .iter()
        .filter_map(calendar_of)
        .collect();

    // THE TWO WINDOWS ARE MERGED BY ID, the anchor read last so its row wins.
    let mut merged: BTreeMap<String, EventRow> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for row in window.rows.iter().chain(anchors.rows.iter()) {
        let Some(event) = event_of(row) else { continue };
        if !merged.contains_key(&event.event_id) {
            order.push(event.event_id.clone());
        }
        merged.insert(event.event_id.clone(), event);
    }
    if merged.is_empty() {
        return Ok((
            UpcomingData {
                events: Vec::new(),
                calendars,
            },
            None,
        ));
    }
    let event_ids: Vec<String> = order.clone();
    let decorations = read_decorations(door, "upcoming", &event_ids, true)?;
    let exception_rows: Vec<StoredExceptionRow> =
        read_pages(door, &exceptions_statement(&event_ids)?, EVENT_JOIN_BOUND)?
            .iter()
            .map(exception_of)
            .collect();
    let mut enriched: Vec<EventRow> = order
        .iter()
        .filter_map(|id| merged.get(id).cloned())
        .collect();
    for event in &mut enriched {
        decorate(event, &decorations);
    }
    // Open-ended "upcoming" still needs a ceiling to expand against, or a
    // doorbell re-expands a year of a DAILY series (#404).
    let expand_to = match to.filter(|value| !value.is_empty()) {
        Some(upper) => upper.to_owned(),
        None => from_ms.map_or_else(|| from.clone(), |millis| iso_of(millis + DEFAULT_EXPAND_MS)),
    };
    let expanded = expand_recurring_events(enriched, &from_lower, &expand_to, &exception_rows)?;
    // THE TRUE LOWER BOUND: keep anything still running at `from`. A recurrence
    // instance is in-range by construction and is never re-filtered.
    let mut events: Vec<EventRow> = expanded
        .into_iter()
        .filter(|event| {
            if event.is_recurrence_instance || event.rrule.is_some() {
                return true;
            }
            let end = event.dtend.clone().unwrap_or_else(|| event.dtstart.clone());
            match (parse_instant_ms(&end), from_ms) {
                (Some(end), Some(from)) => end >= from,
                _ => true,
            }
        })
        .collect();
    events.sort_by(|left, right| left.dtstart.cmp(&right.dtstart));
    Ok((UpcomingData { events, calendars }, None))
}

/// `search` — the same rows, in the order the index ranked them.
///
/// The FTS read is `ctx.vault.search`, which is not a [`PageQuery`] and belongs
/// to `crates/search`; the hits arrive here as the rows the index answered, in
/// RANK ORDER, and the fold keeps that order.
///
/// **A cancelled event drops AFTER the hit**, never before: the index knows
/// text, not status (`search.ts:4`).
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_search(door: &dyn PageDoor, hits: &[Row]) -> KitResult<(SearchData, Option<Denial>)> {
    let live: Vec<&Row> = hits
        .iter()
        .filter(|row| cell_text(row, "status").as_deref() != Some("cancelled"))
        .collect();
    if live.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let event_ids: Vec<String> = live
        .iter()
        .filter_map(|row| cell_text(row, "event_id"))
        .collect();
    if event_ids.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let decorations = match read_decorations(door, "search", &event_ids, false) {
        Ok(decorations) => decorations,
        Err(KitError::Door(message)) => {
            return Ok((SearchData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let events = live
        .into_iter()
        .filter_map(|row| {
            let mut event = event_of(row)?;
            decorate(&mut event, &decorations);
            // v0 spreads only the CALENDAR id onto a search hit, not the rest
            // of the ext row: `calByEvent` maps `event_id -> calendar_id`
            // (`search.ts:279`-`:281`).
            event.conferencing_uri = None;
            event.reminders_json = None;
            event.instance_key = event.event_id.clone();
            event.snippet = Some(cell_text(row, "_snippet").unwrap_or_default());
            Some(event)
        })
        .collect();
    Ok((SearchData { events }, None))
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
/// the default window stands** (`day-context.ts:100`).
#[must_use]
pub fn range_of(from: Option<&str>, to: Option<&str>, now: &str) -> (String, String) {
    let today: String = now.chars().take(10).collect();
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

/// `day-context` — birthdays and due work for the calendar grid.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_day_context(
    door: &dyn PageDoor,
    from: Option<&str>,
    to: Option<&str>,
    now: &str,
) -> KitResult<(DayContextData, Option<Denial>)> {
    let (from, to) = range_of(from, to, now);
    // Half-open, so a date-only and a timed `due_at` both land.
    let due_upper = add_days(&to, 1);
    let parties = match read_window(door, &birthdays_statement(), PARTY_CAP) {
        Ok(window) => window.rows,
        Err(KitError::Door(message)) => {
            return Ok((DayContextData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let tasks = read_window(door, &due_tasks_statement(&from, &due_upper)?, TASK_CAP)?.rows;
    let schemes = read_pages(door, &flags_scheme_statement(), EVENT_JOIN_BOUND)?;
    // NO MARKER MEANS NOBODY IS STARRED: an honest `outer`, never a refusal.
    let starred_concept = match schemes.first().and_then(|row| cell_text(row, "scheme_id")) {
        None => None,
        Some(scheme_id) => {
            let concepts =
                read_pages(door, &flag_concepts_statement(&scheme_id), EVENT_JOIN_BOUND)?;
            concepts
                .iter()
                .find(|row| cell_text(row, "notation").as_deref() == Some(STARRED_NOTATION))
                .and_then(|row| cell_text(row, "concept_id"))
        }
    };
    let starred: BTreeSet<String> = match starred_concept {
        None => BTreeSet::new(),
        Some(concept_id) => read_window(door, &star_tags_statement(&concept_id), TAG_CAP)?
            .rows
            .iter()
            .filter(|row| cell_text(row, "concept_id").as_deref() == Some(concept_id.as_str()))
            .filter_map(|row| cell_text(row, "target_id"))
            .collect(),
    };

    let mut birthdays: Vec<BirthdayFact> = Vec::new();
    for row in &parties {
        let kind = cell_text(row, "kind");
        if kind.as_deref().is_some_and(|kind| kind != "person") {
            continue;
        }
        let Some((month, day)) = month_day_of(cell_text(row, "birth_date").as_deref()) else {
            continue;
        };
        if !recurs_in_range(month, day, &from, &to) {
            continue;
        }
        let Some(party_id) = cell_text(row, "party_id") else {
            continue;
        };
        birthdays.push(BirthdayFact {
            party_id: party_id.clone(),
            name: cell_text(row, "display_name").unwrap_or_default(),
            month,
            day,
            tier: if starred.contains(&party_id) {
                "inner"
            } else {
                "outer"
            },
        });
    }
    birthdays.sort_by(|left, right| {
        left.month
            .cmp(&right.month)
            .then_with(|| left.day.cmp(&right.day))
            .then_with(|| left.name.cmp(&right.name))
    });

    // DAYS WITH NO DUE TASK ARE ABSENT, NOT ZERO-FILLED.
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut listed: BTreeMap<String, Vec<DueTask>> = BTreeMap::new();
    for row in &tasks {
        let status = cell_text(row, "status");
        if status
            .as_deref()
            .is_some_and(|status| !OPEN_STATUSES.contains(&status))
        {
            continue;
        }
        let Some(day) = day_of(cell_text(row, "due_at").as_deref()) else {
            continue;
        };
        if day < from || day > to {
            continue;
        }
        *counts.entry(day.clone()).or_default() += 1;
        let shelf = listed.entry(day).or_default();
        if shelf.len() < SHELF_CAP {
            shelf.push(DueTask {
                task_id: cell_text(row, "task_id").unwrap_or_default(),
                title: cell_text(row, "title").unwrap_or_default(),
            });
        }
    }
    let due: Vec<DueFact> = counts
        .into_iter()
        .map(|(day, count)| DueFact {
            tasks: listed.get(&day).cloned().unwrap_or_default(),
            day,
            count,
        })
        .collect();

    Ok((
        DayContextData {
            birthdays,
            due,
            holidays: Vec::new(),
        },
        None,
    ))
}

/// `parties` — the invite directory.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_parties(door: &dyn PageDoor) -> KitResult<(PartiesData, Option<Denial>)> {
    let vault_rows = match read_pages(
        door,
        &vault_statement("agenda.parties.vault"),
        EVENT_JOIN_BOUND,
    ) {
        Ok(rows) => rows,
        Err(KitError::Door(message)) => {
            return Ok((PartiesData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let me = me_of(&vault_rows);
    let people = read_pages(door, &people_statement(), EVENT_JOIN_BOUND)?;
    let mut parties: Vec<PartyEntry> = people
        .iter()
        .filter_map(|row| {
            let party_id = cell_text(row, "party_id")?;
            Some(PartyEntry {
                is_you: me.as_deref() == Some(party_id.as_str()),
                name: cell_text(row, "display_name").unwrap_or_else(|| "Guest".to_owned()),
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
    Ok((PartiesData { parties, me }, None))
}
