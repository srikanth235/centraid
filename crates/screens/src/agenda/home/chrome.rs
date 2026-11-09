//! WHAT EVERY STATE CARRIES: the band, the day bar, the More sheet's rows and
//! the fixed words, recomputed on every view so no native view derives one
//! field from another.

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;

use super::fold::long_day;
use super::grid;
use crate::agenda::routes;
use crate::agenda::todo::rows;
use crate::kit::civil;
use crate::strings::{
    Locale, agenda as words, agenda_grid as sayings, agenda_home as sentences,
    agenda_lists as lists, agenda_reminders as reminders, fill, imports, task,
};

/// `AgendaBandTab.key`s: what `BandPicked` carries.
pub const BAND_CALENDAR: &str = "calendar";
pub const BAND_REMINDERS: &str = "reminders";
pub const BAND_INVITES: &str = "invites";
pub const BAND_MORE: &str = "more";

/// `AgendaMoreRow.key`s: what `MoreRowPicked` carries.
pub const MORE_READS: &str = "reads";
pub const MORE_CALENDAR: &str = "calendar-";
/// The row that opens the new-calendar sheet (#1173).
pub const MORE_NEW_CALENDAR: &str = "new-calendar";
pub const MORE_ANYTIME: &str = "anytime";
pub const MORE_LOGBOOK: &str = "logbook";
pub const MORE_REMINDERS: &str = "reminders";
pub const MORE_TRASH: &str = "trash";
/// The row that opens the Import reminders option sheet: offered only where the platform has a
/// reminders source ([`crate::Ctx::reminders_source`]).
pub const MORE_IMPORT_REMINDERS: &str = "import-reminders";

/// The Tasks places a More row opens as a page.
pub const TASK_PLACES: [&str; 4] = [MORE_ANYTIME, MORE_LOGBOOK, MORE_REMINDERS, MORE_TRASH];

/// The band, per app (round 10 of #1173), places only (R-CHROME-5). **Calendar**: Calendar, Calendars
/// (the sheet of calendars to show or hide, Apple's middle key) and Invites (Apple's Inbox; the old
/// Waiting). **Reminders**: Reminders and More, since Apple's Reminders has no band of places. Calendar
/// holds Day, Week, Month, List and Year behind its view menu ([`calendar_views`]). SEARCH IS A MODE
/// OVER THE PLACE, not a place: the destination's tab stays lit while the field is open.
#[must_use]
pub fn band(
    locale: Locale,
    app: super::App,
    destination: Dest,
    sheet_up: bool,
) -> Vec<wire::AgendaBandTab> {
    let tab = |key: &str, label: String, icon: &str, current: bool| wire::AgendaBandTab {
        key: key.to_owned(),
        label,
        icon_key: icon.to_owned(),
        current,
    };
    match app {
        super::App::Calendar => vec![
            tab(
                BAND_CALENDAR,
                reminders::band_calendar(locale),
                "Calendar",
                grid::is_calendar_view(destination) && !sheet_up,
            ),
            tab(
                BAND_MORE,
                reminders::band_calendars(locale),
                "List",
                sheet_up,
            ),
            tab(
                BAND_INVITES,
                reminders::band_invites(locale),
                "Inbox",
                destination == Dest::Waiting,
            ),
        ],
        super::App::Reminders => vec![
            tab(
                BAND_REMINDERS,
                reminders::band_reminders(locale),
                "Todo",
                !sheet_up,
            ),
            wire::AgendaBandTab {
                key: BAND_MORE.to_owned(),
                label: words::band_more(locale),
                icon_key: "MoreHoriz".to_owned(),
                current: sheet_up,
            },
        ],
    }
}

/// The Calendar's view menu: Day, Week, Month, List (Schedule) and Year, in
/// that order. Empty off the Calendar tab, where there is nothing to switch.
#[must_use]
pub fn calendar_views(locale: Locale, destination: Dest) -> Vec<wire::AgendaCalendarView> {
    // Day and Week carry their layouts on the Calendar's header instead.
    if !grid::is_calendar_view(destination) {
        return Vec::new();
    }
    let view = |key: &str, label: String, icon: &str, of: Dest| wire::AgendaCalendarView {
        key: key.to_owned(),
        label,
        icon_key: icon.to_owned(),
        destination: of as i32,
        current: destination == of,
    };
    vec![
        view("day", reminders::view_day(locale), "Clock", Dest::Day),
        view("week", sayings::view_week(locale), "Table", Dest::Week),
        view(
            "month",
            sayings::view_month(locale),
            "Calendar",
            Dest::Month,
        ),
        view("list", reminders::view_list(locale), "List", Dest::Schedule),
        view("year", sayings::view_year(locale), "Grid", Dest::Year),
    ]
}

/// Whether the Calendar's own header ([`calendar_header`]) stands in for the
/// app's title, the view menu and the day bar: Day and Week only. Month, Year
/// and List keep theirs.
#[must_use]
pub fn has_calendar_header(destination: Dest) -> bool {
    matches!(destination, Dest::Day | Dest::Week)
}

/// Whether the place wears the shared header ([`calendar_header`]) at all: the Calendar's Day and
/// Week, and Reminders, whose board (`Main.dc.html`) is the same bar with no chip and no layout
/// key, and the place's own title under it. One model, one view per shell, drawn by both.
#[must_use]
pub fn has_place_header(destination: Dest) -> bool {
    has_calendar_header(destination) || destination == Dest::Todo
}

/// THE SHARED HEADER (#1173, `Calendar.dc.html` and `Main.dc.html`): the month chip, the layout
/// key, Day's all-day lane and the Today key's visibility on the Calendar; on Reminders only the
/// bar and the place's `title`, since there is no month to go back to and no layout to pick. `data` is the
/// answer the view draws; the lane is TAKEN from its Day column so it is drawn
/// once. Not `shown` while denied or while a search term is answering.
pub fn calendar_header(
    locale: Locale,
    destination: Dest,
    anchor: &str,
    today: &str,
    shown: bool,
    data: Option<&mut wire::AgendaHomeData>,
) -> wire::AgendaCalendarHeader {
    if !shown || !has_place_header(destination) {
        return wire::AgendaCalendarHeader::default();
    }
    if destination == Dest::Todo {
        return wire::AgendaCalendarHeader {
            shown: true,
            layout: destination as i32,
            title: reminders::reminders_title(locale),
            ..wire::AgendaCalendarHeader::default()
        };
    }
    let month = if anchor.is_empty() {
        String::new()
    } else {
        civil::month_of(locale, anchor)
    };
    let all_day = match (destination, data) {
        (Dest::Day, Some(data)) => data
            .time_grid
            .as_mut()
            .and_then(|grid| grid.days.first_mut())
            .map(|day| std::mem::take(&mut day.all_day))
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    wire::AgendaCalendarHeader {
        shown: true,
        month_accessibility: if month.is_empty() {
            String::new()
        } else {
            fill(&sayings::month_chip_spoken(locale), &[("month", &month)])
        },
        month_label: month,
        layout: destination as i32,
        layout_label: reminders::view_menu(locale),
        layouts: calendar_views(locale, destination),
        all_day_label: sayings::grid_all_day(locale),
        all_day,
        today_shown: !anchor.is_empty() && !today.is_empty() && anchor != today,
        today_label: words::today(locale),
        month_icon_key: "ChevronLeft".to_owned(),
        layout_icon_key: "Rows".to_owned(),
        title: String::new(),
    }
}

/// The day bar of Month, Year and the lists. Shown only with an anchor and a today, outside the gate, off
/// To-do (no window), and off Day and Week (the Calendar's header) and with no term answering (search results are not a window).
#[must_use]
pub fn toolbar(
    locale: Locale,
    destination: Dest,
    anchor: &str,
    today: &str,
    shown: bool,
) -> wire::AgendaToolbar {
    if !shown
        || anchor.is_empty()
        || today.is_empty()
        || destination == Dest::Todo
        || has_calendar_header(destination)
    {
        return wire::AgendaToolbar::default();
    }
    // THE PERIOD'S OWN WORDS: a month or a year, and today is in it when the
    // Today button has nowhere to go. Day and Week have the Calendar's header.
    let year = anchor.get(..4).unwrap_or_default();
    let (range_label, at_today) = match destination {
        Dest::Month => (
            rows::month_year(locale, anchor),
            anchor.get(..7) == today.get(..7),
        ),
        Dest::Year => (year.to_owned(), anchor.get(..4) == today.get(..4)),
        _ => (day_label(locale, anchor, today), anchor == today),
    };
    wire::AgendaToolbar {
        shown: true,
        range_label,
        month_label: if destination == Dest::Year {
            year.to_owned()
        } else {
            rows::month_year(locale, anchor)
        },
        at_today,
    }
}

/// The lists' range label: "From today", "From Wednesday 11 March".
fn day_label(locale: Locale, anchor: &str, today: &str) -> String {
    if anchor == today {
        words::from_today(locale)
    } else {
        fill(
            &sentences::from_day(locale),
            &[("day", &long_day(locale, anchor))],
        )
    }
}

/// THE MORE SHEET, AS ROWS (R-1046-5, R-1128-6): every calendar the answer
/// named, as a show/hide toggle under the Calendars heading, then the Tasks
/// places under their own, then "What Agenda may read". Never Search, never a
/// sort or a filter (R-CHROME-4). All and Catch up are not here: All is Day,
/// Schedule and To-do together, and Catch up is the Overdue group's verb.
#[must_use]
pub fn more_rows(
    locale: Locale,
    app: super::App,
    calendars: &[wire::AgendaCalendarChoice],
    can_add_calendar: bool,
    can_import_reminders: bool,
) -> Vec<wire::AgendaMoreRow> {
    if app == super::App::Reminders {
        return reminders_more_rows(locale, can_import_reminders);
    }
    calendar_more_rows(locale, calendars, can_add_calendar)
}

/// CALENDAR'S SHEET ("Calendars"): every calendar as a show/hide toggle, a new calendar, and what
/// Calendar may read.
fn calendar_more_rows(
    locale: Locale,
    calendars: &[wire::AgendaCalendarChoice],
    can_add_calendar: bool,
) -> Vec<wire::AgendaMoreRow> {
    let mut out: Vec<wire::AgendaMoreRow> = calendars
        .iter()
        .enumerate()
        .map(|(index, calendar)| wire::AgendaMoreRow {
            key: format!("{MORE_CALENDAR}{}", calendar.calendar_id),
            label: calendar.name.clone(),
            meta: calendar.state_label.clone(),
            hue_key: calendar.hue_key.clone(),
            toggle: true,
            on: !calendar.hidden,
            section: if index == 0 {
                words::rail_calendars(locale)
            } else {
                String::new()
            },
            spoken: format!("{}, {}", calendar.name, calendar.state_label),
            icon_key: calendar.icon_key.clone(),
            color_key: calendar.color_key.clone(),
            edit_label: fill(
                &lists::edit_calendar(locale),
                &[("name", calendar.name.as_str())],
            ),
            ..wire::AgendaMoreRow::default()
        })
        .collect();
    if can_add_calendar {
        out.push(wire::AgendaMoreRow {
            key: MORE_NEW_CALENDAR.to_owned(),
            label: lists::new_calendar_title(locale),
            spoken: lists::new_calendar_title(locale),
            icon_key: "CalendarPlus".to_owned(),
            section: if calendars.is_empty() {
                words::rail_calendars(locale)
            } else {
                String::new()
            },
            ..wire::AgendaMoreRow::default()
        });
    }
    out.push(wire::AgendaMoreRow {
        key: MORE_READS.to_owned(),
        label: words::reads_title(locale),
        spoken: words::reads_title(locale),
        ..wire::AgendaMoreRow::default()
    });
    out
}

/// REMINDERS' SHEET: the places that are not on the home (Anytime, Logbook, Reminders and the trash),
/// the phone's Reminders import where the platform has one, and what Reminders may read.
fn reminders_more_rows(locale: Locale, can_import_reminders: bool) -> Vec<wire::AgendaMoreRow> {
    let mut out: Vec<wire::AgendaMoreRow> = Vec::new();
    let place = |key: &str, label: String, meta: String, icon: &str, route: wire::Route| {
        wire::AgendaMoreRow {
            key: key.to_owned(),
            spoken: format!("{label}, {meta}"),
            label,
            meta,
            icon_key: icon.to_owned(),
            route: Some(route),
            ..wire::AgendaMoreRow::default()
        }
    };
    let places = vec![
        place(
            MORE_ANYTIME,
            task::view_anytime(locale),
            task::more_anytime_meta(locale),
            "Layers",
            routes::todo_list(wire::TodoView::Anytime),
        ),
        place(
            MORE_LOGBOOK,
            task::view_logbook(locale),
            task::more_logbook_meta(locale),
            "Book",
            routes::todo_list(wire::TodoView::Logbook),
        ),
        place(
            MORE_REMINDERS,
            task::view_reminders(locale),
            task::more_reminders_meta(locale),
            "Bell",
            routes::todo_list(wire::TodoView::Reminders),
        ),
        place(
            MORE_TRASH,
            task::trash(locale),
            task::more_trash_meta(locale),
            "Trash",
            routes::trash(),
        ),
    ];
    out.extend(places);
    // THE REMINDERS IMPORT, beside the Tasks places: an action row that opens its option sheet.
    // Only where the platform has a Reminders store (iOS).
    if can_import_reminders {
        out.push(wire::AgendaMoreRow {
            key: MORE_IMPORT_REMINDERS.to_owned(),
            label: imports::reminders_import(locale),
            spoken: imports::reminders_import(locale),
            icon_key: "Download".to_owned(),
            ..wire::AgendaMoreRow::default()
        });
    }
    out.push(wire::AgendaMoreRow {
        key: MORE_READS.to_owned(),
        label: reminders::reads_reminders_title(locale),
        spoken: reminders::reads_reminders_title(locale),
        ..wire::AgendaMoreRow::default()
    });
    out
}

/// The Import reminders option sheet: its words are the import line's
/// (`strings::imports`, as `ImportsMadeState` carries them).
#[must_use]
pub fn import_reminders_sheet(
    locale: Locale,
    completed_on: bool,
) -> wire::AgendaImportRemindersSheet {
    wire::AgendaImportRemindersSheet {
        title: imports::reminders_import(locale),
        completed_label: imports::completed_toggle(locale),
        completed_on,
        import_label: imports::reminders_import(locale),
    }
}

/// The screen's fixed words, so a view carries no copy of its own.
#[must_use]
pub fn words_of(locale: Locale, app: super::App) -> wire::AgendaChrome {
    let reminders_app = app == super::App::Reminders;
    wire::AgendaChrome {
        title: if reminders_app {
            reminders::reminders_title(locale)
        } else {
            words::app_title(locale)
        },
        new_event: words::new_event(locale),
        today: words::today(locale),
        previous_day: words::previous_day(locale),
        next_day: words::next_day(locale),
        search_placeholder: words::search_placeholder(locale),
        search_label: words::search_label(locale),
        search_close: words::close(locale),
        retry: words::retry(locale),
        loading: words::loading(locale),
        more_title: words::more_title(locale),
        reads_title: if reminders_app {
            reminders::reads_reminders_title(locale)
        } else {
            words::reads_title(locale)
        },
        reads_facts: vec![
            wire::AgendaFact {
                label: words::reads_fact_reads(locale),
                detail: if reminders_app {
                    reminders::reads_reminders_reads(locale)
                } else {
                    words::reads_fact_reads_value(locale)
                },
            },
            wire::AgendaFact {
                label: words::reads_fact_writes(locale),
                detail: if reminders_app {
                    reminders::reads_reminders_writes(locale)
                } else {
                    words::reads_fact_writes_value(locale)
                },
            },
            wire::AgendaFact {
                label: words::reads_fact_leaves(locale),
                detail: words::reads_fact_leaves_value(locale),
            },
        ],
        home: words::band_home(locale),
        tasks: Some(rows::chrome(locale)),
    }
}
