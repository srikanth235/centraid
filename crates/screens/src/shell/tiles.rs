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

/// Read one app's tile.
#[must_use]
pub fn read(ctx: &Ctx, app: &str) -> Made {
    match app {
        "photos" => photos(ctx),
        "docs" => docs(ctx),
        "agenda" => agenda(ctx),
        "notes" => notes(ctx),
        "money" => money(ctx),
        "health" => health(ctx),
        "people" => people(ctx),
        "locker" => locker(ctx),
        _ => unknown(),
    }
}

// -- photos -------------------------------------------------------------------

/// THE LIVE LIBRARY, by Photos' own shelf: its `total` is exact, so the tile's
/// count is not a floor.
fn photos(ctx: &Ctx) -> Made {
    let locale = ctx.locale();
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
    let cells = chosen
        .into_iter()
        .take(PHOTO_CELLS)
        .map(|cell| wire::home_tile_body::photos::Cell {
            asset_id: cell.photo_id.clone(),
            thumbnail_path: cell.thumbnail_path.clone().filter(|path| !path.is_empty()),
        })
        .collect();
    content(
        total,
        false,
        one,
        many,
        Body::Photos(wire::home_tile_body::Photos { cells }),
    )
}

// -- docs ---------------------------------------------------------------------

/// THE DRIVE'S RECENT SHELF, which is the newest-added first and carries the
/// live count; a count that fills the drive's window is a floor.
fn docs(ctx: &Ctx) -> Made {
    let locale = ctx.locale();
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

/// What is owed today: overdue and due-today tasks, and the first one's title.
struct Due {
    count: u32,
    title: String,
}

impl Due {
    fn of(board: &wire::TasksBoard) -> Self {
        use wire::TasksGroupKind as Kind;
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
        let mut groups: Vec<&wire::TasksGroup> = board
            .groups
            .iter()
            .filter(|group| rank(group.kind).is_some())
            .collect();
        groups.sort_by_key(|group| rank(group.kind));
        let title = groups
            .iter()
            .find_map(|group| group.tasks.first())
            .map(|task| task.title.clone())
            .unwrap_or_default();
        Self { count, title }
    }

    fn on(
        &self,
        locale: Locale,
        mut body: wire::home_tile_body::Agenda,
    ) -> wire::home_tile_body::Agenda {
        if self.count > 0 {
            body.due_count = self.count;
            body.due_label = fill(
                &words::tile_agenda_due(locale),
                &[("n", &self.count.to_string())],
            );
            body.due_title.clone_from(&self.title);
        }
        body
    }
}

const DAY: usize = 10;

fn ended_by(event: &wire::AgendaEvent, today: &str, now: &str) -> bool {
    if event.all_day {
        let end = if event.local_end.is_empty() {
            &event.local_start
        } else {
            &event.local_end
        };
        return end.get(..DAY).unwrap_or(end) < today;
    }
    if event.local_end.is_empty() {
        return event.local_start.as_str() < now;
    }
    event.local_end.as_str() <= now
}

fn first_day(event: &wire::AgendaEvent) -> &str {
    event.local_days.first().map_or_else(
        || event.local_start.get(..DAY).unwrap_or(&event.local_start),
        String::as_str,
    )
}

fn event_title(locale: Locale, event: &wire::AgendaEvent) -> String {
    event
        .summary
        .as_deref()
        .filter(|summary| !summary.trim().is_empty())
        .map_or_else(|| crate::strings::agenda::untitled(locale), str::to_owned)
}

fn when_line(locale: Locale, event: &wire::AgendaEvent, today: &str) -> String {
    let start_day = event.local_start.get(..DAY).unwrap_or(&event.local_start);
    if event.all_day {
        let day = if start_day <= today {
            crate::strings::agenda::today(locale)
        } else {
            civil::dated(locale, start_day)
        };
        return format!("{day} · {}", words::tile_agenda_all_day(locale));
    }
    let clock = civil::clock(&event.local_start);
    if start_day == today {
        clock
    } else {
        format!("{} · {clock}", civil::dated(locale, start_day))
    }
}

fn after_line(
    locale: Locale,
    next: &wire::AgendaEvent,
    after: Option<&wire::AgendaEvent>,
    today: &str,
) -> String {
    let Some(after) = after else {
        return words::tile_agenda_nothing_after(locale);
    };
    let then = || {
        format!(
            "{} {}",
            words::tile_agenda_then(locale),
            event_title(locale, after)
        )
    };
    let headline = first_day(next).max(today);
    let after_day = first_day(after);
    if after_day <= headline {
        return then();
    }
    match civil::day_of_month_of(after_day) {
        Some(day) => format!(
            "{} {}",
            words::tile_agenda_nothing_until(locale),
            civil::ordinal(day)
        ),
        None => then(),
    }
}

/// THE NEXT EVENT AND WHAT IS OWED, from Agenda's own upcoming window and its
/// Today board: the next occurrence of whatever repeats is the core's
/// recurrence engine's to say. The count is what lands in a week plus what is
/// owed today.
fn agenda(ctx: &Ctx) -> Made {
    let locale = ctx.locale();
    let Reading::Data(board) = read::read(
        ctx,
        load::agenda::Board {
            limit: 100,
            view: Some(load::agenda::BoardView::Today),
            project_id: None,
        },
        |answer| match answer {
            Answer::TasksBoard(board) => Some(board),
            _ => None,
        },
    ) else {
        return unknown();
    };
    let Some(to) = civil::plus_days(&board.today, WINDOW_DAYS + 1).and_then(|day| midnight(&day))
    else {
        return unknown();
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
        return unknown();
    };
    let (today, now) = (upcoming.today.as_str(), upcoming.now_local.as_str());
    let owed = Due::of(&board);
    let live: Vec<&wire::AgendaEvent> = upcoming
        .events
        .iter()
        .filter(|event| !event.local_start.is_empty() && !ended_by(event, today, now))
        .collect();
    let (one, many) = (
        words::tile_agenda_count(locale),
        words::tile_agenda_count(locale),
    );
    let Some(next) = live.first().copied() else {
        if owed.count == 0 {
            return empty_with(0, one, many);
        }
        let body = owed.on(
            locale,
            wire::home_tile_body::Agenda {
                title: words::tile_agenda_no_events(locale),
                ..Default::default()
            },
        );
        return content(owed.count, false, one, many, Body::Agenda(body));
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
    let after = live
        .iter()
        .skip(1)
        .find(|event| event.event_id != next.event_id)
        .copied();
    let body = owed.on(
        locale,
        wire::home_tile_body::Agenda {
            title: event_title(locale, next),
            at: when_line(locale, next, today),
            after: after_line(locale, next, after, today),
            ..Default::default()
        },
    );
    content(count, false, one, many, Body::Agenda(body))
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
    let locale = ctx.locale();
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
    let Reading::Data(spine) =
        read::read(
            ctx,
            load::notes::Notebooks::default(),
            |answer| match answer {
                Answer::NotesNotebooks(spine) => Some(spine),
                _ => None,
            },
        )
    else {
        return unknown();
    };
    let (one, many) = (
        words::tile_notes_count_one(locale),
        words::tile_notes_count_many(locale),
    );
    let total = u32::try_from(library.notes.len()).unwrap_or(u32::MAX);
    let Some(newest) = library.notes.first() else {
        return empty_with(0, one, many);
    };
    let shelf: Vec<wire::home_tile_body::notes::Notebook> = spine
        .notebooks
        .iter()
        .filter(|notebook| notebook.note_count > 0)
        .take(PREVIEW)
        .map(|notebook| wire::home_tile_body::notes::Notebook {
            notebook_id: notebook.notebook_id.clone(),
            name: notebook
                .name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map_or_else(|| notes::untitled_notebook(locale), str::to_owned),
            note_count: notebook.note_count,
        })
        .collect();
    let recent = if shelf.is_empty() {
        library
            .notes
            .iter()
            .take(PREVIEW)
            .map(|note| wire::home_tile_body::notes::Recent {
                note_id: note.note_id.clone(),
                title: note_title(locale, note),
            })
            .collect()
    } else {
        Vec::new()
    };
    content(
        total,
        library.truncated,
        one,
        many,
        Body::Notes(wire::home_tile_body::Notes {
            note_id: newest.note_id.clone(),
            title: note_title(locale, newest),
            notebooks: shelf,
            recent,
        }),
    )
}

// -- money --------------------------------------------------------------------

/// THIS MONTH'S SPENDING, by the core's own tile reader: one finished amount per
/// currency, and nothing added across currencies.
fn money(ctx: &Ctx) -> Made {
    let locale = ctx.locale();
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

/// TODAY'S STEPS AND LAST NIGHT'S SLEEP, from Health's own today. A phone that has
/// not connected a health store is an empty tile that says to connect.
fn health(ctx: &Ctx) -> Made {
    let locale = ctx.locale();
    let Reading::Data(today) =
        read::read(ctx, load::health::Today::default(), |answer| match answer {
            Answer::HealthToday(today) => Some(today),
            _ => None,
        })
    else {
        return unknown();
    };
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

/// A person's initials from the display name: one letter for one word, the
/// first and LAST word's for more, because a middle name is not the letter
/// anybody recognises.
fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let first = |word: &str| {
        word.chars()
            .next()
            .map(|c| c.to_uppercase().collect::<String>())
    };
    match words.as_slice() {
        [] => "?".to_owned(),
        [only] => first(only).unwrap_or_default(),
        [head, .., last] => first(head).unwrap_or_default() + &first(last).unwrap_or_default(),
    }
}

/// THE CIRCLE People's own roster lists (live, neither the owner nor a pet), so
/// the tile and the app agree on how many.
fn people(ctx: &Ctx) -> Made {
    let locale = ctx.locale();
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
    let (one, many) = (
        words::tile_people_count_one(locale),
        words::tile_people_count_many(locale),
    );
    if roster.people.is_empty() {
        return empty_with(0, one, many);
    }
    let faces: Vec<wire::home_tile_body::people::Face> = roster
        .people
        .iter()
        .take(PREVIEW)
        .map(|person| wire::home_tile_body::people::Face {
            party_id: person.party_id.clone(),
            initials: initials(&person.name),
            // THE HUE IS RESOLVED HERE, ONCE, FOR BOTH SHELLS: derived from the
            // id, so a corrected spelling never repaints a person.
            color: centraid_design::party_hue_key(&person.party_id, None).map(str::to_owned),
        })
        .collect();
    let total = u32::try_from(roster.people.len())
        .unwrap_or(u32::MAX)
        .max(roster.count_all);
    let more = total.saturating_sub(u32::try_from(faces.len()).unwrap_or(0));
    content(
        total,
        roster.truncated,
        one,
        many,
        Body::People(wire::home_tile_body::People {
            faces,
            more,
            more_label: if more > 0 {
                fill(
                    &words::tile_people_more(locale),
                    &[("n", &more.to_string())],
                )
            } else {
                words::tile_people_everyone(locale)
            },
        }),
    )
}

// -- locker -------------------------------------------------------------------

/// Whether the Locker is open right now, as the session says.
fn locker_open(ctx: &Ctx) -> bool {
    ctx.locker(&wire::LockerSessionRequest {
        step: Some(wire::locker_session_request::Step::State(
            wire::LockerStateAsk {},
        )),
    })
    .is_ok_and(|answer| answer.state == wire::LockerSessionState::Unlocked as i32)
}

/// HOW MANY ITEMS AND WHETHER IT IS OPEN, never an item: the read is Locker's own
/// list of metadata, and this keeps only its count.
fn locker(ctx: &Ctx) -> Made {
    let locale = ctx.locale();
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
    let open = locker_open(ctx);
    content(
        total,
        false,
        one,
        many,
        Body::Locker(wire::home_tile_body::Locker {
            locked: !open,
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

    #[test]
    fn initials_take_the_first_and_last_word() {
        assert_eq!(initials("ada"), "A");
        assert_eq!(initials("Ada Lovelace"), "AL");
        assert_eq!(initials("Ada Augusta King Lovelace"), "AL");
        assert_eq!(initials("   "), "?");
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
