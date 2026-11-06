//! WHAT EACH HOME TILE SAYS (#1135): one function per app, each reading through
//! that app's OWN named query (`ctx.load`, the one read) and making a finished
//! tile of the answer. There is no tile query and no second copy of an app's
//! rules: Photos' count is Photos' own shelf, so a photograph folded under an
//! edit is left out here for the reason it is left out there.
//!
//! ## Absent is not zero, on every one of them
//!
//! A read that was refused or denied is a tile that is `UNKNOWN` ([`unknown`]),
//! never `EMPTY`: a launcher that could not read has not learned that the app
//! holds nothing. A read that landed and found nothing is `EMPTY` and still
//! states its count (zero is a true answer to "how many" once a read returned).
//!
//! ## A count is the read's own
//!
//! A reader answers the rows of a window. A count that fills its window is
//! `capped` and drawn `812+`, because it is a floor and not a total.
//!
//! ## Locker counts, and shows nothing
//!
//! Its tile says how many live items and whether the Locker is open, which is all
//! a launcher may say about a place that holds secrets. The open state is the
//! session's, asked of the core.

use centraid_api_proto::core_v1 as wire;
use wire::HomeTileStatus as Status;
use wire::app_query_response::Answer;
use wire::home_tile_body::Kind as Body;

use crate::catalog::load;
use crate::health::figures::grouped;
use crate::kit::civil;
use crate::kit::money::{self, Amount};
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{
    Locale, fill, health, home as words, locker, money as money_words, notes, photos,
};

/// The photographs a mosaic draws.
pub const PHOTO_CELLS: usize = 4;
/// How many rows a body draws; the rest are only counted.
pub const PREVIEW: usize = 3;
/// How far ahead Agenda's next-event line looks, and how far its count does.
const WINDOW_DAYS: i64 = 14;
const COUNT_DAYS: i64 = 7;
/// The photographs asked for beyond the four drawn, so a video with no poster
/// frame does not hold a blank cell in the strip.
const PHOTO_WINDOW: u32 = 24;
/// The amounts' locale: the same one Money's own screens write in.
const AMOUNT_LOCALE: &str = "en-US";

/// What one tile's read came to, before it is dressed as a [`wire::HomeTile`].
pub struct Made {
    pub status: Status,
    pub count: Option<wire::HomeTileCount>,
    pub count_label: String,
    pub body: Option<Body>,
}

/// A tile that could not be read.
#[must_use]
pub fn unknown() -> Made {
    Made {
        status: Status::Unknown,
        count: None,
        count_label: String::new(),
        body: None,
    }
}

/// A tile that is still reading.
#[must_use]
pub fn loading() -> Made {
    Made {
        status: Status::Loading,
        ..unknown()
    }
}

/// The noun for `count`: singular only at exactly one, and never when capped
/// ("1+" is a floor, not a count of one). Zero takes the plural.
fn noun(count: u32, capped: bool, one: String, many: String) -> String {
    if count == 1 && !capped { one } else { many }
}

fn counted(
    count: u32,
    capped: bool,
    one: String,
    many: String,
) -> (Option<wire::HomeTileCount>, String) {
    (
        Some(wire::HomeTileCount {
            value: count,
            capped,
        }),
        noun(count, capped, one, many),
    )
}

fn empty_with(count: u32, one: String, many: String) -> Made {
    let (count, count_label) = counted(count, false, one, many);
    Made {
        status: Status::Empty,
        count,
        count_label,
        body: None,
    }
}

fn content(count: u32, capped: bool, one: String, many: String, body: Body) -> Made {
    let (count, count_label) = counted(count, capped, one, many);
    Made {
        status: Status::Content,
        count,
        count_label,
        body: Some(body),
    }
}

/// Read one app's widgets: one, except Agenda's two (the day, and what is owed
/// when anything is). Each is keyed by its widget id.
#[must_use]
pub fn read(ctx: &Ctx, app: &str) -> Vec<(&'static str, Made)> {
    match app {
        "photos" => vec![("photos", photos(ctx))],
        "docs" => vec![("docs", docs(ctx))],
        "agenda" => {
            let (day, owed) = agenda(ctx);
            let mut out = vec![("agenda", day)];
            out.extend(owed.map(|owed| (REMINDERS, owed)));
            out
        }
        "notes" => vec![("notes", notes(ctx))],
        "money" => vec![("money", money(ctx))],
        "health" => vec![("health", health(ctx))],
        "people" => vec![("people", people(ctx))],
        "locker" => vec![("locker", locker(ctx))],
        _ => Vec::new(),
    }
}

/// The widget of what Agenda is owed today: an app's colour, a place of its own.
pub const REMINDERS: &str = "reminders";

// -- photos -------------------------------------------------------------------

/// THE LIVE LIBRARY, by Photos' own shelf: its `total` is exact, so the tile's
/// count is not a floor.
fn photos(ctx: &Ctx) -> Made {
    let Reading::Data(shelf) = read::read(
        ctx,
        load::photos::Shelf {
            limit: PHOTO_WINDOW,
            view: load::photos::ShelfView::Live,
            ..Default::default()
        },
        |answer| match answer {
            Answer::PhotosShelf(shelf) => Some(shelf),
            _ => None,
        },
    ) else {
        return unknown();
    };
    photos_tile(ctx.locale(), &shelf)
}

fn photos_tile(locale: Locale, shelf: &wire::PhotosShelf) -> Made {
    let held = u32::try_from(shelf.cells.len()).unwrap_or(u32::MAX);
    let total = shelf.total.unwrap_or(held).max(held);
    let (one, many) = (
        photos::tile_count_one(locale),
        photos::tile_count_many(locale),
    );
    if total == 0 {
        return empty_with(0, one, many);
    }
    // THE NEWEST FOUR THAT CAN BE DRAWN. An asset can have no thumbnail for a
    // reason that never goes away (a video with no poster frame), so the strip
    // steps over them. When NO cell in the window is drawable the newest four are
    // kept as they are: that is "these photographs are not on this device yet",
    // whose grey strip is the truthful answer, and an empty strip would draw as a
    // count with nothing beneath it.
    let drawable: Vec<&wire::PhotosCell> = shelf
        .cells
        .iter()
        .filter(|cell| {
            cell.thumbnail_path
                .as_deref()
                .is_some_and(|path| !path.is_empty())
        })
        .collect();
    let chosen: Vec<&wire::PhotosCell> = if drawable.is_empty() {
        shelf.cells.iter().collect()
    } else {
        drawable
    };
    let cells: Vec<wire::home_tile_body::photos::Cell> = chosen
        .into_iter()
        .take(PHOTO_CELLS)
        .map(|cell| wire::home_tile_body::photos::Cell {
            thumbnail_path: cell.thumbnail_path.clone().filter(|path| !path.is_empty()),
        })
        .collect();
    // A strip with no cell to draw says why, under the grey.
    let absent_line = if cells.iter().any(|cell| cell.thumbnail_path.is_some()) {
        String::new()
    } else {
        words::home_photos_absent(locale)
    };
    content(
        total,
        false,
        one,
        many,
        Body::Photos(wire::home_tile_body::Photos { cells, absent_line }),
    )
}

// -- docs ---------------------------------------------------------------------

/// THE DRIVE'S RECENT SHELF, which is the newest-added first and carries the
/// live count; a count that fills the drive's window is a floor.
fn docs(ctx: &Ctx) -> Made {
    let Reading::Data(drive) = read::read(
        ctx,
        load::docs::Drive {
            shelf: Some("recent".to_owned()),
            ..Default::default()
        },
        |answer| match answer {
            Answer::DocsDrive(drive) => Some(drive),
            _ => None,
        },
    ) else {
        return unknown();
    };
    docs_tile(ctx.locale(), &drive)
}

fn docs_tile(locale: Locale, drive: &wire::DocsDrive) -> Made {
    let (one, many) = (
        words::tile_docs_count_one(locale),
        words::tile_docs_count_many(locale),
    );
    if drive.all_count == 0 && drive.documents.is_empty() {
        return empty_with(0, one, many);
    }
    let capped = drive.window > 0 && drive.all_count >= drive.window;
    let rows = drive
        .documents
        .iter()
        .take(PREVIEW)
        .map(|document| wire::home_tile_body::docs::Row {
            document_id: document.document_id.clone(),
            name: document.title.clone(),
            size: document.size.clone(),
        })
        .collect();
    content(
        drive
            .all_count
            .max(u32::try_from(drive.documents.len()).unwrap_or(u32::MAX)),
        capped,
        one,
        many,
        Body::Docs(wire::home_tile_body::Docs { rows }),
    )
}

// -- agenda -------------------------------------------------------------------

fn midnight(day: &str) -> Option<String> {
    civil::epoch_day_of(day).map(|_| format!("{day}T00:00:00Z"))
}

/// What is owed today: overdue and due-today tasks, and the first few titles,
/// overdue first.
struct Due {
    count: u32,
    titles: Vec<String>,
}

impl Due {
    fn none() -> Self {
        Self {
            count: 0,
            titles: Vec::new(),
        }
    }

    fn of(board: &wire::AgendaTaskBoard) -> Self {
        use wire::AgendaTaskGroupKind as Kind;
        let count = board
            .counts
            .as_ref()
            .map_or(0, |counts| counts.overdue + counts.today);
        let rank = |kind: i32| {
            if kind == Kind::Overdue as i32 {
                Some(0)
            } else if kind == Kind::Today as i32 {
                Some(1)
            } else {
                None
            }
        };
        let mut groups: Vec<&wire::AgendaTaskGroup> = board
            .groups
            .iter()
            .filter(|group| rank(group.kind).is_some())
            .collect();
        groups.sort_by_key(|group| rank(group.kind));
        let titles = groups
            .iter()
            .flat_map(|group| group.tasks.iter())
            .take(PREVIEW)
            .map(|task| task.title.clone())
            .collect();
        Self { count, titles }
    }
}

const DAY: usize = 10;

fn day_of(local: &str) -> &str {
    local.get(..DAY).unwrap_or(local)
}

/// Whether an occurrence is over. A timed end is exclusive (an end EXACTLY at
/// now has ended); an all-day run is over once its last day is before today.
fn ended_by(event: &wire::AgendaEvent, today: &str, now: &str) -> bool {
    if event.all_day {
        let end = if event.local_end.is_empty() {
            &event.local_start
        } else {
            &event.local_end
        };
        return day_of(end) < today;
    }
    if event.local_end.is_empty() {
        return event.local_start.as_str() < now;
    }
    event.local_end.as_str() <= now
}

fn first_day(event: &wire::AgendaEvent) -> &str {
    event
        .local_days
        .first()
        .map_or_else(|| day_of(&event.local_start), String::as_str)
}

fn event_title(locale: Locale, event: &wire::AgendaEvent) -> String {
    event
        .summary
        .as_deref()
        .filter(|summary| !summary.trim().is_empty())
        .map_or_else(|| crate::strings::agenda::untitled(locale), str::to_owned)
}

/// The core's own today, in the device's zone: the day-context query.
fn today_of(ctx: &Ctx) -> Option<String> {
    match read::read(
        ctx,
        load::agenda::DayContext::default(),
        |answer| match answer {
            Answer::AgendaDayContext(context) => Some(context),
            _ => None,
        },
    ) {
        Reading::Data(context) => Some(context.today),
        _ => None,
    }
}

/// THE CALENDAR WIDGET AND THE REMINDERS WIDGET, from Agenda's own upcoming
/// window and its Today board: the next occurrence of whatever repeats is the
/// core's recurrence engine's to say, so nothing here expands a series. A DUE
/// READ THAT DID NOT LAND COSTS THE DAY ITS REMINDERS AND NOTHING ELSE: the
/// events are the calendar, what is owed rides in the other widget.
fn agenda(ctx: &Ctx) -> (Made, Option<Made>) {
    let Some(today) = today_of(ctx) else {
        return (unknown(), None);
    };
    let Some(to) = civil::plus_days(&today, WINDOW_DAYS + 1).and_then(|day| midnight(&day)) else {
        return (unknown(), None);
    };
    let Reading::Data(upcoming) = read::read(
        ctx,
        load::agenda::Upcoming {
            from: None,
            to: Some(to),
        },
        |answer| match answer {
            Answer::AgendaUpcoming(upcoming) => Some(upcoming),
            _ => None,
        },
    ) else {
        return (unknown(), None);
    };
    let board = read::read(
        ctx,
        load::agenda::Board {
            limit: 100,
            view: Some(load::agenda::BoardView::Today),
            project_id: None,
        },
        |answer| match answer {
            Answer::AgendaTaskBoard(board) => Some(board),
            _ => None,
        },
    );
    agenda_tile(ctx.locale(), &upcoming, board.data())
}

/// The day's full name, "Wednesday", or empty for a day that does not parse.
fn weekday_long(locale: Locale, day: &str) -> String {
    use crate::strings::agenda as w;
    match civil::iso_weekday_of(day) {
        Some(1) => w::weekday_full_mon(locale),
        Some(2) => w::weekday_full_tue(locale),
        Some(3) => w::weekday_full_wed(locale),
        Some(4) => w::weekday_full_thu(locale),
        Some(5) => w::weekday_full_fri(locale),
        Some(6) => w::weekday_full_sat(locale),
        Some(7) => w::weekday_full_sun(locale),
        _ => String::new(),
    }
}

/// How many of today's events a calendar widget lists; the rest are counted.
pub const DAY_EVENTS: usize = 2;

/// The calendar widget's tile, and the reminders widget's when anything is
/// owed. The calendar's count is the occurrences of the next [`COUNT_DAYS`] days
/// plus what is owed today, so its spoken label agrees with the lines in it; the
/// reminders' is what is owed.
fn agenda_tile(
    locale: Locale,
    upcoming: &wire::AgendaUpcoming,
    board: Option<&wire::AgendaTaskBoard>,
) -> (Made, Option<Made>) {
    let (today, now) = (upcoming.today.as_str(), upcoming.now_local.as_str());
    let owed = board.map_or(Due::none(), Due::of);
    let live: Vec<&wire::AgendaEvent> = upcoming
        .events
        .iter()
        .filter(|event| !event.local_start.is_empty() && !ended_by(event, today, now))
        .collect();
    let (one, many) = (
        words::tile_agenda_count(locale),
        words::tile_agenda_count(locale),
    );
    let reminders = (owed.count > 0).then(|| {
        content(
            owed.count,
            false,
            words::tile_reminders_due(locale),
            words::tile_reminders_due(locale),
            Body::Reminders(wire::home_tile_body::Reminders {
                titles: owed.titles.clone(),
                caption: crate::strings::shared::today(locale),
            }),
        )
    });
    if live.is_empty() && owed.count == 0 {
        return (empty_with(0, one, many), None);
    }
    // TODAY'S: what is still to come on the day, or still running (an all-day
    // run that covers it).
    let todays: Vec<&&wire::AgendaEvent> = live
        .iter()
        .filter(|event| first_day(event) <= today)
        .collect();
    let events: Vec<wire::home_tile_body::agenda::Event> = todays
        .iter()
        .take(DAY_EVENTS)
        .map(|event| wire::home_tile_body::agenda::Event {
            title: event_title(locale, event),
            span: civil::span(locale, &event.local_start, &event.local_end, event.all_day),
        })
        .collect();
    let rest = todays.len().saturating_sub(DAY_EVENTS);
    let foot = if todays.is_empty() {
        words::tile_agenda_none_today(locale)
    } else if rest > 0 {
        fill(
            &words::tile_agenda_foot_more(locale),
            &[("n", &rest.to_string())],
        )
    } else {
        words::app_agenda(locale)
    };
    let horizon = civil::plus_days(today, COUNT_DAYS);
    let week = live
        .iter()
        .filter(|event| {
            horizon
                .as_deref()
                .is_none_or(|horizon| first_day(event) < horizon)
        })
        .count();
    let count = u32::try_from(week).unwrap_or(u32::MAX) + owed.count;
    let calendar = content(
        count,
        false,
        one,
        many,
        Body::Agenda(wire::home_tile_body::Agenda {
            weekday: weekday_long(locale, today),
            day: civil::day_of_month_of(today)
                .map(|day| day.to_string())
                .unwrap_or_default(),
            events,
            foot,
        }),
    );
    (calendar, reminders)
}

// -- notes --------------------------------------------------------------------

fn note_title(locale: Locale, row: &wire::NotesRow) -> String {
    row.title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            row.preview
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| notes::untitled(locale))
}

/// A SHELF OF NOTEBOOKS with their counts, which only Notes' own reads can say:
/// the library for the newest note and the count, the notebooks for the shelf.
fn notes(ctx: &Ctx) -> Made {
    let Reading::Data(library) =
        read::read(
            ctx,
            load::notes::Library::default(),
            |answer| match answer {
                Answer::NotesLibrary(library) => Some(library),
                _ => None,
            },
        )
    else {
        return unknown();
    };
    notes_tile(ctx.locale(), &library, today_of(ctx).as_deref())
}

/// "Edited yesterday", "Edited today", else "Edited Wed 11 March"; empty for a
/// note with no edit day. `today` is the core's day; without it the day is named.
fn edited_line(locale: Locale, day: &str, today: Option<&str>) -> String {
    if day.is_empty() {
        return String::new();
    }
    match today {
        Some(today) if day == today => words::tile_notes_edited_today(locale),
        Some(today) if civil::plus_days(today, -1).as_deref() == Some(day) => {
            words::tile_notes_edited_yesterday(locale)
        }
        _ => fill(
            &words::tile_notes_edited_on(locale),
            &[("day", &civil::day_month(locale, day))],
        ),
    }
}

/// THE NEWEST NOTE, and when it was last edited.
fn notes_tile(locale: Locale, library: &wire::NotesLibrary, today: Option<&str>) -> Made {
    let (one, many) = (
        words::tile_notes_count_one(locale),
        words::tile_notes_count_many(locale),
    );
    let total = u32::try_from(library.notes.len()).unwrap_or(u32::MAX);
    let Some(newest) = library.notes.first() else {
        return empty_with(0, one, many);
    };
    content(
        total,
        library.truncated,
        one,
        many,
        Body::Notes(wire::home_tile_body::Notes {
            note_id: newest.note_id.clone(),
            title: note_title(locale, newest),
            edited: edited_line(locale, &newest.updated_local_day, today),
        }),
    )
}

// -- money --------------------------------------------------------------------

/// THIS MONTH'S SPENDING, by the core's own tile reader: one finished amount per
/// currency, and nothing added across currencies.
fn money(ctx: &Ctx) -> Made {
    let Reading::Data(tile) =
        read::read(
            ctx,
            load::money::HomeTile::default(),
            |answer| match answer {
                Answer::MoneyHomeTile(tile) => Some(tile),
                _ => None,
            },
        )
    else {
        return unknown();
    };
    money_tile(ctx.locale(), &tile)
}

fn money_tile(locale: Locale, tile: &wire::MoneyHomeTile) -> Made {
    if tile.empty || tile.spent.is_empty() {
        return Made {
            status: Status::Empty,
            count: None,
            count_label: String::new(),
            body: None,
        };
    }
    let month = tile
        .month
        .get(5..)
        .and_then(|month| month.parse::<u32>().ok())
        .map(|month| civil::month_name(locale, month))
        .unwrap_or_default();
    let caption = if month.is_empty() {
        money_words::tile_caption_no_month(locale)
    } else {
        fill(&money_words::tile_caption(locale), &[("month", &month)])
    };
    Made {
        status: Status::Content,
        count: None,
        count_label: String::new(),
        body: Some(Body::Money(wire::home_tile_body::Money {
            amounts: tile
                .spent
                .iter()
                .map(|amount| {
                    money::format(
                        &Amount::new(amount.minor, &amount.currency, amount.exponent),
                        AMOUNT_LOCALE,
                    )
                })
                .collect(),
            caption,
        })),
    }
}

// -- health -------------------------------------------------------------------

fn duration(locale: Locale, minutes: f64) -> String {
    let total = (minutes.round() as i64).max(0);
    let (hours, rest) = (total / 60, (total % 60).to_string());
    if hours == 0 {
        fill(&health::duration_minutes(locale), &[("m", &rest)])
    } else {
        fill(
            &health::duration_hours(locale),
            &[("h", &hours.to_string()), ("m", &rest)],
        )
    }
}

/// TODAY'S STEPS AND LAST NIGHT'S SLEEP, from Health's own today.
fn health(ctx: &Ctx) -> Made {
    let Reading::Data(today) =
        read::read(ctx, load::health::Today::default(), |answer| match answer {
            Answer::HealthToday(today) => Some(today),
            _ => None,
        })
    else {
        return unknown();
    };
    health_tile(ctx.locale(), &today)
}

/// A phone that has not connected a health store is an empty tile that says to
/// connect; and a figure the store did not give is never a zero.
fn health_tile(locale: Locale, today: &wire::HealthToday) -> Made {
    if !today.connected {
        return Made {
            status: Status::Empty,
            count: None,
            count_label: String::new(),
            body: None,
        };
    }
    let value_of = |metric: wire::HealthMetric| {
        today
            .metrics
            .iter()
            .find(|row| {
                row.metric == metric as i32 && row.day.as_deref() == Some(today.today.as_str())
            })
            .and_then(|row| row.value)
    };
    let steps = value_of(wire::HealthMetric::Steps);
    let sleep = value_of(wire::HealthMetric::SleepMin);
    let figure = steps
        .map(|steps| grouped(steps.round() as i64))
        .unwrap_or_default();
    Made {
        status: Status::Content,
        count: None,
        count_label: String::new(),
        body: Some(Body::Health(wire::home_tile_body::Health {
            figure,
            caption: if steps.is_none() {
                health::when_nothing(locale)
            } else {
                words::tile_health_caption(locale)
            },
            line: sleep
                .map(|sleep| {
                    fill(
                        &words::tile_health_slept(locale),
                        &[("duration", &duration(locale, sleep))],
                    )
                })
                .unwrap_or_default(),
        })),
    }
}

// -- people -------------------------------------------------------------------

/// THE CIRCLE People's own roster lists (live, neither the owner nor a pet), so
/// the widget and the app agree on how many.
fn people(ctx: &Ctx) -> Made {
    let Reading::Data(roster) =
        read::read(
            ctx,
            load::people::People::default(),
            |answer| match answer {
                Answer::PeopleRoster(roster) => Some(roster),
                _ => None,
            },
        )
    else {
        return unknown();
    };
    people_tile(ctx.locale(), &roster)
}

/// HOW MANY ARE DUE FOR A CATCH-UP when any are ("3 reconnect"), else how many
/// people there are. Both are People's own counts, never a number made here.
fn people_tile(locale: Locale, roster: &wire::PeopleRoster) -> Made {
    let (one, many) = (
        words::tile_people_count_one(locale),
        words::tile_people_count_many(locale),
    );
    if roster.people.is_empty() {
        return empty_with(0, one, many);
    }
    let total = u32::try_from(roster.people.len())
        .unwrap_or(u32::MAX)
        .max(roster.count_all);
    let (figure, caption) = if roster.count_due > 0 {
        (
            grouped(i64::from(roster.count_due)),
            words::tile_people_reconnect(locale),
        )
    } else {
        (
            grouped(i64::from(total)),
            noun(total, roster.truncated, one.clone(), many.clone()),
        )
    };
    content(
        total,
        roster.truncated,
        one,
        many,
        Body::People(wire::home_tile_body::People { figure, caption }),
    )
}

// -- locker -------------------------------------------------------------------

/// Whether the Locker is open right now, as the session says.
fn locker_open(ctx: &Ctx) -> bool {
    ctx.locker(&wire::LockerSessionRequest {
        step: Some(wire::locker_session_request::Step::State(
            wire::LockerStateAsk::default(),
        )),
    })
    .is_ok_and(|answer| answer.state == wire::LockerSessionState::Unlocked as i32)
}

/// HOW MANY ITEMS AND WHETHER IT IS OPEN, never an item: the read is Locker's own
/// list of metadata, and this keeps only its count.
fn locker(ctx: &Ctx) -> Made {
    let Reading::Data(items) = read::read(
        ctx,
        load::locker::Items {
            limit: 1,
            ..Default::default()
        },
        |answer| match answer {
            Answer::LockerItems(items) => Some(items),
            _ => None,
        },
    ) else {
        return unknown();
    };
    let open = locker_open(ctx);
    locker_tile(ctx.locale(), &items, open)
}

fn locker_tile(locale: Locale, items: &wire::LockerItems, open: bool) -> Made {
    let (one, many) = (
        locker::tile_count_one(locale),
        locker::tile_count_many(locale),
    );
    let total = items
        .total
        .unwrap_or(u32::try_from(items.items.len()).unwrap_or(u32::MAX));
    if total == 0 {
        return empty_with(0, one, many);
    }
    content(
        total,
        false,
        one,
        many,
        Body::Locker(wire::home_tile_body::Locker {
            state_label: if open {
                locker::tile_open(locale)
            } else {
                locker::tile_locked(locale)
            },
            line: if open {
                locker::tile_open_line(locale)
            } else {
                locker::tile_locked_line(locale)
            },
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // The answer's clock throughout: Monday 15 June 2026, 09:00 on the device.
    const TODAY: &str = "2026-06-15";
    const NOW: &str = "2026-06-15T09:00";

    fn timed(id: &str, summary: &str, start: &str, end: &str) -> wire::AgendaEvent {
        wire::AgendaEvent {
            event_id: id.to_owned(),
            summary: Some(summary.to_owned()),
            instance_key: format!("{id}:{start}"),
            local_start: start.to_owned(),
            local_end: end.to_owned(),
            local_days: vec![start[..10].to_owned()],
            ..Default::default()
        }
    }

    fn all_day(id: &str, summary: &str, first: &str, last: &str) -> wire::AgendaEvent {
        let mut days = vec![first.to_owned()];
        while days.last().unwrap().as_str() < last {
            days.push(civil::plus_days(days.last().unwrap(), 1).unwrap());
        }
        wire::AgendaEvent {
            event_id: id.to_owned(),
            summary: Some(summary.to_owned()),
            instance_key: id.to_owned(),
            all_day: true,
            local_start: first.to_owned(),
            local_end: last.to_owned(),
            local_days: days,
            ..Default::default()
        }
    }

    fn upcoming(events: Vec<wire::AgendaEvent>) -> wire::AgendaUpcoming {
        wire::AgendaUpcoming {
            events,
            today: TODAY.to_owned(),
            now_local: NOW.to_owned(),
            ..Default::default()
        }
    }

    fn due_task(title: &str) -> wire::AgendaTask {
        wire::AgendaTask {
            task_id: format!("t-{title}"),
            title: title.to_owned(),
            status: "open".to_owned(),
            ..Default::default()
        }
    }

    fn board(overdue: &[&str], due: &[&str]) -> wire::AgendaTaskBoard {
        use wire::AgendaTaskGroupKind as Kind;
        let group = |kind: Kind, key: &str, titles: &[&str]| {
            (!titles.is_empty()).then(|| wire::AgendaTaskGroup {
                kind: kind as i32,
                key: key.to_owned(),
                tasks: titles.iter().map(|title| due_task(title)).collect(),
                ..Default::default()
            })
        };
        wire::AgendaTaskBoard {
            today: TODAY.to_owned(),
            now_local: NOW.to_owned(),
            groups: [
                group(Kind::Overdue, "overdue", overdue),
                group(Kind::Today, "today", due),
            ]
            .into_iter()
            .flatten()
            .collect(),
            counts: Some(wire::AgendaTaskCounts {
                overdue: u32::try_from(overdue.len()).unwrap(),
                today: u32::try_from(due.len()).unwrap(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The calendar widget alone, with nothing owed.
    fn agenda_of(events: Vec<wire::AgendaEvent>) -> Made {
        agenda_tile(Locale::En, &upcoming(events), Some(&board(&[], &[]))).0
    }

    fn agenda_body(made: &Made) -> &wire::home_tile_body::Agenda {
        let Some(Body::Agenda(body)) = &made.body else {
            panic!("not an agenda body");
        };
        body
    }

    fn count(made: &Made) -> u32 {
        made.count.expect("a count").value
    }

    fn lines(body: &wire::home_tile_body::Agenda) -> Vec<(&str, &str)> {
        body.events
            .iter()
            .map(|event| (event.title.as_str(), event.span.as_str()))
            .collect()
    }

    // -- Agenda: the calendar widget and the reminders widget --------------------

    #[test]
    fn the_calendar_widget_names_the_day_and_lists_two_events_with_the_rest_counted() {
        let made = agenda_of(vec![
            timed("a", "Lunch with Ana", "2026-06-15T11:15", "2026-06-15T12:30"),
            timed("b", "Lease call", "2026-06-15T11:45", ""),
            timed("c", "Dentist", "2026-06-15T14:00", "2026-06-15T15:00"),
            timed("d", "Gym", "2026-06-15T18:00", "2026-06-15T19:00"),
        ]);
        assert_eq!(made.status, Status::Content);
        let body = agenda_body(&made);
        assert_eq!((body.weekday.as_str(), body.day.as_str()), ("Monday", "15"));
        assert_eq!(
            lines(body),
            [("Lunch with Ana", "11:15 \u{2013} 12:30"), ("Lease call", "11:45")]
        );
        assert_eq!(body.foot, "Agenda \u{b7} 2 more");
        // The count is what the spoken label says: four events in the week.
        assert_eq!(count(&made), 4);
        assert_eq!(made.count_label, "on your plate");
    }

    #[test]
    fn with_no_more_than_two_the_foot_is_the_apps_name_and_nothing_today_says_so() {
        let two = agenda_of(vec![
            timed("a", "Lunch", "2026-06-15T11:15", ""),
            timed("b", "Call", "2026-06-15T11:45", ""),
        ]);
        assert_eq!(agenda_body(&two).foot, "Agenda");
        // An event on a later day is in the week and not in the day.
        let later = agenda_of(vec![timed("a", "Survey", "2026-06-17T08:15", "")]);
        assert_eq!(later.status, Status::Content);
        let body = agenda_body(&later);
        assert!(body.events.is_empty());
        assert_eq!(body.foot, "No events today");
        assert_eq!(count(&later), 1);
    }

    #[test]
    fn an_event_that_has_ended_is_left_out_and_one_ending_exactly_now_has_ended() {
        let made = agenda_of(vec![
            timed("e", "School run", "2026-06-15T07:30", "2026-06-15T08:00"),
            // A timed end is exclusive.
            timed("s", "Stand-up", "2026-06-15T08:45", "2026-06-15T09:00"),
            timed("c", "Call with Ana", "2026-06-15T08:30", "2026-06-15T09:30"),
            timed("v", "Survey", "2026-06-15T10:00", ""),
        ]);
        assert_eq!(
            lines(agenda_body(&made)),
            [("Call with Ana", "08:30 \u{2013} 09:30"), ("Survey", "10:00")]
        );
        assert_eq!(count(&made), 2);
    }

    #[test]
    fn an_all_day_event_is_a_day_and_never_a_clock_time_and_a_run_covering_today_is_todays() {
        let made = agenda_of(vec![
            all_day("old", "Conference", "2026-06-12", "2026-06-14"),
            all_day("trip", "Lisbon", "2026-06-13", "2026-06-16"),
            all_day("move", "Moving day", "2026-06-18", "2026-06-18"),
        ]);
        // The run that ended yesterday is gone; the one covering today leads.
        assert_eq!(lines(agenda_body(&made)), [("Lisbon", "All day")]);
        assert_eq!(count(&made), 2);
    }

    #[test]
    fn an_untitled_event_is_called_one() {
        let made = agenda_of(vec![timed("x", "", "2026-06-15T10:00", "")]);
        assert_eq!(agenda_body(&made).events[0].title, "Untitled event");
    }

    #[test]
    fn a_repeating_series_counts_every_occurrence_and_lists_the_first_two() {
        // SEVEN occurrences of one series, expanded BY THE CORE: this side expands nothing.
        let mut events: Vec<wire::AgendaEvent> = (15..=21)
            .map(|day| {
                timed(
                    "evt-standup",
                    "Stand-up",
                    &format!("2026-06-{day}T10:00"),
                    &format!("2026-06-{day}T10:15"),
                )
            })
            .collect();
        events.push(timed("evt-dentist", "Dentist", "2026-06-16T14:00", ""));
        events.sort_by(|a, b| a.local_start.cmp(&b.local_start));
        let made = agenda_of(events);
        // Only today's occurrence is the day's; the other six are the week's.
        assert_eq!(lines(agenda_body(&made)), [("Stand-up", "10:00 \u{2013} 10:15")]);
        assert_eq!(count(&made), 8);
    }

    #[test]
    fn the_count_is_today_and_the_six_days_after_it() {
        let made = agenda_of(vec![
            timed("evt-a", "A", "2026-06-15T10:00", ""),
            timed("evt-b", "B", "2026-06-21T23:30", ""),
            // The EIGHTH day: in the read's window, outside the count's.
            timed("evt-c", "C", "2026-06-22T00:00", ""),
        ]);
        assert_eq!(count(&made), 2);
    }

    #[test]
    fn what_is_owed_is_its_own_widget_with_its_count_and_the_first_three_titles() {
        let (calendar, reminders) = agenda_tile(
            Locale::En,
            &upcoming(vec![timed("e", "Dentist", "2026-06-15T14:00", "")]),
            Some(&board(
                &["File the taxes"],
                &["Call Mum", "Water the plants", "Pay rent"],
            )),
        );
        let reminders = reminders.expect("something is owed");
        assert_eq!(reminders.status, Status::Content);
        // Overdue first, then today's; four are owed and three are named.
        assert_eq!(count(&reminders), 4);
        assert_eq!(reminders.count_label, "due");
        let Some(Body::Reminders(body)) = &reminders.body else {
            panic!("not a reminders body");
        };
        assert_eq!(body.titles, ["File the taxes", "Call Mum", "Water the plants"]);
        assert_eq!(body.caption, "Today");
        // The calendar's own count agrees with both widgets: one event and four due.
        assert_eq!(count(&calendar), 5);
    }

    #[test]
    fn nothing_owed_is_no_reminders_widget_and_a_due_read_that_failed_costs_only_that() {
        let (_, none) = agenda_tile(Locale::En, &upcoming(vec![]), Some(&board(&[], &[])));
        assert!(none.is_none());
        let events = vec![timed("e", "Dentist", "2026-06-15T14:00", "")];
        let (calendar, none) = agenda_tile(Locale::En, &upcoming(events), None);
        assert!(none.is_none());
        assert_eq!(calendar.status, Status::Content);
        assert_eq!(lines(agenda_body(&calendar)), [("Dentist", "14:00")]);
    }

    #[test]
    fn tasks_owed_and_no_event_is_content_with_an_empty_day() {
        let (calendar, reminders) = agenda_tile(
            Locale::En,
            &upcoming(vec![]),
            Some(&board(&[], &["Call Mum"])),
        );
        assert_eq!(calendar.status, Status::Content);
        let body = agenda_body(&calendar);
        assert!(body.events.is_empty());
        assert_eq!(body.foot, "No events today");
        assert_eq!(count(&calendar), 1);
        assert!(reminders.is_some());
    }

    #[test]
    fn nothing_coming_up_and_nothing_owed_is_empty_with_a_zero_count_and_no_reminders() {
        let (made, reminders) = agenda_tile(Locale::En, &upcoming(vec![]), Some(&board(&[], &[])));
        assert_eq!(made.status, Status::Empty);
        assert_eq!(count(&made), 0);
        assert!(made.body.is_none() && reminders.is_none());
        assert_eq!(made.count_label, "on your plate");
        // An event that is over leaves the same: nothing to say.
        let over = agenda_of(vec![timed("e", "School run", "2026-06-15T07:30", "2026-06-15T08:00")]);
        assert_eq!(over.status, Status::Empty);
    }

    #[test]
    fn the_weekday_is_spelled_out_for_each_day_and_empty_for_a_day_that_is_not_one() {
        let week = [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
        ];
        for (offset, name) in week.iter().enumerate() {
            let day = civil::plus_days("2026-06-15", i64::try_from(offset).unwrap()).unwrap();
            assert_eq!(weekday_long(Locale::En, &day), *name);
        }
        assert_eq!(weekday_long(Locale::En, "soon"), "");
    }

    // -- Notes (ports of HomeNotesTileSpec) -----------------------------------

    fn note(id: &str, title: Option<&str>, preview: &str) -> wire::NotesRow {
        wire::NotesRow {
            note_id: id.to_owned(),
            title: title.map(str::to_owned),
            preview: preview.to_owned(),
            ..Default::default()
        }
    }

    fn notebook(id: &str, name: Option<&str>, count: u32) -> wire::NotesNotebook {
        wire::NotesNotebook {
            notebook_id: id.to_owned(),
            name: name.map(str::to_owned),
            note_count: count,
            ..Default::default()
        }
    }

    fn notes_of(notes: Vec<wire::NotesRow>, truncated: bool, today: Option<&str>) -> Made {
        notes_tile(
            Locale::En,
            &wire::NotesLibrary {
                notes,
                truncated,
                ..Default::default()
            },
            today,
        )
    }

    fn notes_body(made: &Made) -> &wire::home_tile_body::Notes {
        let Some(Body::Notes(body)) = &made.body else {
            panic!("not a notes body");
        };
        body
    }

    fn edited(day: &str) -> wire::NotesRow {
        wire::NotesRow {
            updated_local_day: day.to_owned(),
            ..note("n1", Some("Link with [["), "")
        }
    }

    #[test]
    fn the_notes_widget_is_the_newest_note_and_when_it_was_edited() {
        let made = notes_of(
            vec![
                note("n1", Some("Grocery run"), "milk"),
                note("n2", Some("Older"), "x"),
            ],
            false,
            Some(TODAY),
        );
        assert_eq!(made.status, Status::Content);
        let body = notes_body(&made);
        assert_eq!(
            (body.note_id.as_str(), body.title.as_str()),
            ("n1", "Grocery run")
        );
        // No edit day on the row: no line, and never a made-up one.
        assert_eq!(body.edited, "");
    }

    #[test]
    fn edited_is_today_yesterday_or_the_day_named() {
        let line = |day: &str, today: Option<&str>| {
            notes_body(&notes_of(vec![edited(day)], false, today)).edited.clone()
        };
        assert_eq!(line("2026-06-15", Some(TODAY)), "Edited today");
        assert_eq!(line("2026-06-14", Some(TODAY)), "Edited yesterday");
        assert_eq!(line("2026-06-01", Some(TODAY)), "Edited Mon 1 June");
        // With no day from the core the edit day is named, never guessed.
        assert_eq!(line("2026-06-14", None), "Edited Sun 14 June");
    }

    #[test]
    fn an_untitled_note_is_named_by_its_first_line_or_called_one() {
        let made = notes_of(
            vec![note("n1", Some(" "), "\n  Buy oat milk\nlemons")],
            false,
            None,
        );
        assert_eq!(notes_body(&made).title, "Buy oat milk");
        let bare = notes_of(vec![note("n1", None, "")], false, None);
        assert_eq!(notes_body(&bare).title, "Untitled note");
    }

    #[test]
    fn the_notes_count_is_the_librarys_and_capped_when_it_says_more_exist() {
        let made = notes_of(
            vec![
                note("n0", None, "a"),
                note("n1", None, "a"),
                note("n2", None, "a"),
            ],
            true,
            None,
        );
        assert_eq!(
            made.count,
            Some(wire::HomeTileCount {
                value: 3,
                capped: true
            })
        );
        assert_eq!(made.count_label, "notes");
        assert_eq!(
            notes_of(vec![note("n1", None, "a")], false, None).count_label,
            "note"
        );
    }

    #[test]
    fn no_notes_is_empty_with_a_stated_zero() {
        let made = notes_of(vec![], false, None);
        assert_eq!(made.status, Status::Empty);
        assert_eq!(count(&made), 0);
        assert!(made.body.is_none());
    }

    // -- Health, Money (ports of the tile specs) --------------------------------

    fn metric(m: wire::HealthMetric, value: Option<f64>, day: &str) -> wire::HealthTodayMetric {
        wire::HealthTodayMetric {
            metric: m as i32,
            value,
            day: value.map(|_| day.to_owned()),
            ..Default::default()
        }
    }

    fn health_today(metrics: Vec<wire::HealthTodayMetric>, connected: bool) -> wire::HealthToday {
        wire::HealthToday {
            today: "2026-10-20".to_owned(),
            connected,
            metrics,
            ..Default::default()
        }
    }

    #[test]
    fn health_draws_todays_steps_and_last_nights_sleep_and_never_a_zero_it_was_not_told() {
        let day = "2026-10-20";
        let made = health_tile(
            Locale::En,
            &health_today(
                vec![
                    metric(wire::HealthMetric::Steps, Some(8_412.0), day),
                    metric(wire::HealthMetric::SleepMin, Some(432.0), day),
                ],
                true,
            ),
        );
        assert_eq!(made.status, Status::Content);
        let Some(Body::Health(body)) = &made.body else {
            panic!("not health")
        };
        assert_eq!(
            (
                body.figure.as_str(),
                body.caption.as_str(),
                body.line.as_str()
            ),
            ("8,412", "steps today", "Slept 7 h 12 m")
        );
        // Connected with no figures: nothing is invented.
        let quiet = health_tile(Locale::En, &health_today(vec![], true));
        let Some(Body::Health(body)) = &quiet.body else {
            panic!("not health")
        };
        assert_eq!(
            (
                body.figure.as_str(),
                body.caption.as_str(),
                body.line.as_str()
            ),
            ("", "Nothing yet today", "")
        );
        // A phone with no store connected is an empty tile.
        assert_eq!(
            health_tile(Locale::En, &health_today(vec![], false)).status,
            Status::Empty
        );
        // Yesterday's steps are not today's.
        let stale = health_tile(
            Locale::En,
            &health_today(
                vec![metric(wire::HealthMetric::Steps, Some(9.0), "2026-10-19")],
                true,
            ),
        );
        let Some(Body::Health(body)) = &stale.body else {
            panic!("not health")
        };
        assert_eq!(body.figure, "");
    }

    #[test]
    fn money_draws_this_months_spending_per_currency_and_day_one_is_empty() {
        let amount = |minor, currency: &str| wire::MoneyAmount {
            minor,
            currency: currency.to_owned(),
            exponent: 2,
        };
        let made = money_tile(
            Locale::En,
            &wire::MoneyHomeTile {
                month: "2026-10".to_owned(),
                spent: vec![amount(331_458, "USD"), amount(12_000, "CAD")],
                empty: false,
            },
        );
        assert_eq!(made.status, Status::Content);
        assert!(made.count.is_none());
        let Some(Body::Money(body)) = &made.body else {
            panic!("not money")
        };
        assert_eq!(body.amounts, ["$3,314.58", "CA$120.00"]);
        assert_eq!(body.caption, "spent in October");
        let empty = money_tile(
            Locale::En,
            &wire::MoneyHomeTile {
                empty: true,
                ..Default::default()
            },
        );
        assert_eq!(empty.status, Status::Empty);
        assert!(empty.body.is_none());
        // A month the core did not name draws the plain caption.
        let plain = money_tile(
            Locale::En,
            &wire::MoneyHomeTile {
                spent: vec![amount(100, "USD")],
                ..Default::default()
            },
        );
        let Some(Body::Money(body)) = &plain.body else {
            panic!("not money")
        };
        assert_eq!(body.caption, "spent this month");
    }

    // -- the page-read tiles ------------------------------------------------------

    #[test]
    fn the_mosaic_steps_over_an_asset_with_no_thumbnail_and_the_count_still_counts_it() {
        let cell = |id: &str, thumb: Option<&str>| wire::PhotosCell {
            photo_id: id.to_owned(),
            thumbnail_path: thumb.map(str::to_owned),
            ..Default::default()
        };
        let shelf = wire::PhotosShelf {
            // Newest first: the video (no poster) is the newest asset.
            cells: vec![
                cell("video", None),
                cell("a", Some("/s/a")),
                cell("b", Some("/s/b")),
                cell("c", Some("/s/c")),
                cell("d", Some("/s/d")),
                cell("e", Some("/s/e")),
            ],
            total: Some(6),
            ..Default::default()
        };
        let made = photos_tile(Locale::En, &shelf);
        assert_eq!(count(&made), 6);
        let Some(Body::Photos(body)) = &made.body else {
            panic!("not photos")
        };
        assert_eq!(
            body.cells
                .iter()
                .map(|c| c.thumbnail_path.as_deref())
                .collect::<Vec<_>>(),
            [Some("/s/a"), Some("/s/b"), Some("/s/c"), Some("/s/d")]
        );
    }

    #[test]
    fn with_nothing_drawable_the_newest_four_stay_as_grey_cells() {
        let shelf = wire::PhotosShelf {
            cells: (1..=6)
                .map(|n| wire::PhotosCell {
                    photo_id: format!("p{n}"),
                    ..Default::default()
                })
                .collect(),
            total: Some(6),
            ..Default::default()
        };
        let made = photos_tile(Locale::En, &shelf);
        let Some(Body::Photos(body)) = &made.body else {
            panic!("not photos")
        };
        assert_eq!(body.cells.len(), 4);
        assert!(body.cells.iter().all(|c| c.thumbnail_path.is_none()));
        assert_eq!(body.absent_line, "These photos aren't on this phone yet.");
    }

    #[test]
    fn a_count_is_the_shelfs_exact_total_not_the_page_it_asked_for() {
        let shelf = wire::PhotosShelf {
            cells: vec![wire::PhotosCell {
                photo_id: "a".to_owned(),
                ..Default::default()
            }],
            total: Some(812),
            ..Default::default()
        };
        assert_eq!(
            photos_tile(Locale::En, &shelf).count,
            Some(wire::HomeTileCount {
                value: 812,
                capped: false
            })
        );
    }

    #[test]
    fn every_tiles_count_noun_is_singular_at_one_plural_at_zero_and_for_a_floor() {
        // "1 note", never "1 notes"; "0 photos"; a capped "1+" is a floor, not one.
        let docs = |n: usize, window: u32| {
            docs_tile(
                Locale::En,
                &wire::DocsDrive {
                    documents: (0..n)
                        .map(|i| wire::DocsDocumentRow {
                            document_id: format!("d{i}"),
                            ..Default::default()
                        })
                        .collect(),
                    all_count: u32::try_from(n).unwrap(),
                    window,
                    ..Default::default()
                },
            )
        };
        assert_eq!(docs(1, 200).count_label, "document");
        assert_eq!(docs(2, 200).count_label, "documents");
        assert_eq!(docs(0, 200).count_label, "documents");
        // A count that fills the drive's window is a floor.
        let full = docs(1, 1);
        assert_eq!(
            full.count,
            Some(wire::HomeTileCount {
                value: 1,
                capped: true
            })
        );
        assert_eq!(full.count_label, "documents");
        let person = |n: usize| {
            people_tile(
                Locale::En,
                &wire::PeopleRoster {
                    people: (0..n)
                        .map(|i| wire::PeopleRosterRow {
                            party_id: format!("p{i}"),
                            name: "Ada Lovelace".to_owned(),
                            ..Default::default()
                        })
                        .collect(),
                    count_all: u32::try_from(n).unwrap(),
                    ..Default::default()
                },
            )
        };
        assert_eq!(person(1).count_label, "person");
        assert_eq!(person(2).count_label, "people");
        assert_eq!(person(0).count_label, "people");
        let items = |n: u32| wire::LockerItems {
            total: Some(n),
            ..Default::default()
        };
        assert_eq!(
            locker_tile(Locale::En, &items(1), false).count_label,
            "item"
        );
        assert_eq!(
            locker_tile(Locale::En, &items(2), false).count_label,
            "items"
        );
        assert_eq!(
            locker_tile(Locale::En, &items(0), false).count_label,
            "items"
        );
    }

    #[test]
    fn the_docs_tile_names_the_newest_three_with_the_size_the_core_worded() {
        let row = |id: &str, title: &str, size: &str| wire::DocsDocumentRow {
            document_id: id.to_owned(),
            title: title.to_owned(),
            size: size.to_owned(),
            ..Default::default()
        };
        let made = docs_tile(
            Locale::En,
            &wire::DocsDrive {
                documents: vec![
                    row("1", "Lease", "2.4 MB"),
                    row("2", "Tax", "12 KB"),
                    row("3", "Notes", "1 KB"),
                    row("4", "Old", "9 KB"),
                ],
                all_count: 4,
                window: 200,
                ..Default::default()
            },
        );
        let Some(Body::Docs(body)) = &made.body else {
            panic!("not docs")
        };
        assert_eq!(
            body.rows
                .iter()
                .map(|r| (r.name.as_str(), r.size.as_str()))
                .collect::<Vec<_>>(),
            [("Lease", "2.4 MB"), ("Tax", "12 KB"), ("Notes", "1 KB")]
        );
        assert_eq!(count(&made), 4);
    }

    fn roster(names: &[&str], count_due: u32) -> wire::PeopleRoster {
        wire::PeopleRoster {
            people: names
                .iter()
                .enumerate()
                .map(|(i, name)| wire::PeopleRosterRow {
                    party_id: format!("party-{i}"),
                    name: (*name).to_owned(),
                    ..Default::default()
                })
                .collect(),
            count_all: u32::try_from(names.len()).unwrap(),
            count_due,
            ..Default::default()
        }
    }

    fn people_body(made: &Made) -> (&str, &str) {
        let Some(Body::People(body)) = &made.body else {
            panic!("not people")
        };
        (body.figure.as_str(), body.caption.as_str())
    }

    #[test]
    fn the_people_widget_says_how_many_are_due_for_a_catch_up_when_any_are() {
        let made = people_tile(
            Locale::En,
            &roster(&["Ada", "Grace", "Alan", "Edsger"], 3),
        );
        assert_eq!(made.status, Status::Content);
        assert_eq!(people_body(&made), ("3", "reconnect"));
        // The tile's own count stays everyone, for the spoken label.
        assert_eq!(count(&made), 4);
        assert_eq!(made.count_label, "people");
    }

    #[test]
    fn with_no_one_due_the_people_widget_says_how_many_there_are() {
        let many = people_tile(Locale::En, &roster(&["Ada", "Grace"], 0));
        assert_eq!(people_body(&many), ("2", "people"));
        let one = people_tile(Locale::En, &roster(&["Ada"], 0));
        assert_eq!(people_body(&one), ("1", "person"));
        let none = people_tile(Locale::En, &roster(&[], 0));
        assert_eq!(none.status, Status::Empty);
        assert_eq!(count(&none), 0);
    }

    #[test]
    fn locker_counts_and_says_whether_it_is_open_and_shows_nothing_else() {
        let items = wire::LockerItems {
            total: Some(3),
            ..Default::default()
        };
        let locked = locker_tile(Locale::En, &items, false);
        let Some(Body::Locker(body)) = &locked.body else {
            panic!("not locker")
        };
        assert_eq!(
            (body.state_label.as_str(), body.line.as_str()),
            ("Locked", "Unlock to see your items")
        );
        let open = locker_tile(Locale::En, &items, true);
        let Some(Body::Locker(body)) = &open.body else {
            panic!("not locker")
        };
        assert_eq!(body.state_label, "Open");
        // An empty Locker is an empty tile with a stated zero, open or not.
        let none = locker_tile(
            Locale::En,
            &wire::LockerItems {
                total: Some(0),
                ..Default::default()
            },
            true,
        );
        assert_eq!(none.status, Status::Empty);
        assert_eq!(count(&none), 0);
    }

    #[test]
    fn a_tile_that_cannot_be_read_is_unknown_and_never_empty() {
        let made = unknown();
        assert_eq!(made.status, Status::Unknown);
        assert!(made.count.is_none() && made.body.is_none());
        assert_eq!(loading().status, Status::Loading);
    }

    #[test]
    fn a_count_that_fills_its_window_is_never_singular() {
        assert_eq!(noun(1, false, "item".into(), "items".into()), "item");
        assert_eq!(noun(1, true, "item".into(), "items".into()), "items");
        assert_eq!(noun(0, false, "item".into(), "items".into()), "items");
    }

    #[test]
    fn a_duration_is_hours_and_minutes() {
        assert_eq!(duration(Locale::En, 45.0), "45 m");
        assert_eq!(duration(Locale::En, 7.0 * 60.0 + 12.0), "7 h 12 m");
        assert_eq!(duration(Locale::En, -3.0), "0 m");
    }
}
