//! WHAT EVERY STATE CARRIES: the band, the day bar, the More sheet's rows and
//! the fixed words, recomputed on every view so no native view derives one
//! field from another.

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;

use super::fold::long_day;
use crate::agenda::routes;
use crate::agenda::todo::rows;
use crate::kit::civil;
use crate::strings::{Locale, agenda as words, agenda_home as sentences, fill, task};

/// `AgendaBandTab.key`s: what `BandPicked` carries.
pub const BAND_DAY: &str = "day";
pub const BAND_SCHEDULE: &str = "schedule";
pub const BAND_WAITING: &str = "waiting";
pub const BAND_TODO: &str = "todo";
pub const BAND_MORE: &str = "more";

/// `AgendaMoreRow.key`s: what `MoreRowPicked` carries.
pub const MORE_READS: &str = "reads";
pub const MORE_CALENDAR: &str = "calendar-";
pub const MORE_ANYTIME: &str = "anytime";
pub const MORE_LOGBOOK: &str = "logbook";
pub const MORE_REMINDERS: &str = "reminders";
pub const MORE_TRASH: &str = "trash";

/// The Tasks places a More row opens as a page.
pub const TASK_PLACES: [&str; 4] = [MORE_ANYTIME, MORE_LOGBOOK, MORE_REMINDERS, MORE_TRASH];

/// The band: places only, then More (R-CHROME-5). SEARCH IS A MODE OVER THE
/// PLACE, not a place: the destination's tab stays lit while the field is open.
#[must_use]
pub fn band(locale: Locale, destination: Dest, sheet_up: bool) -> Vec<wire::AgendaBandTab> {
    let tab = |key: &str, label: String, icon: &str, of: Dest| wire::AgendaBandTab {
        key: key.to_owned(),
        label,
        icon_key: icon.to_owned(),
        current: destination == of,
    };
    vec![
        tab(BAND_DAY, words::band_day(locale), "Clock", Dest::Day),
        tab(
            BAND_SCHEDULE,
            words::band_schedule(locale),
            "List",
            Dest::Schedule,
        ),
        tab(
            BAND_WAITING,
            words::band_waiting(locale),
            "Inbox",
            Dest::Waiting,
        ),
        tab(BAND_TODO, words::band_todo(locale), "Todo", Dest::Todo),
        wire::AgendaBandTab {
            key: BAND_MORE.to_owned(),
            label: words::band_more(locale),
            icon_key: "MoreHoriz".to_owned(),
            current: sheet_up,
        },
    ]
}

/// The day bar. Shown only with an anchor and a today, outside the gate, off
/// To-do (no window) and with no term answering (search results are not a window).
#[must_use]
pub fn toolbar(
    locale: Locale,
    destination: Dest,
    anchor: &str,
    today: &str,
    shown: bool,
) -> wire::AgendaToolbar {
    if !shown || anchor.is_empty() || today.is_empty() || destination == Dest::Todo {
        return wire::AgendaToolbar::default();
    }
    let range_label = if destination == Dest::Day {
        if anchor == today {
            words::today(locale)
        } else if civil::plus_days(today, 1).as_deref() == Some(anchor) {
            words::tomorrow(locale)
        } else if civil::plus_days(today, -1).as_deref() == Some(anchor) {
            words::yesterday(locale)
        } else {
            long_day(locale, anchor)
        }
    } else if anchor == today {
        words::from_today(locale)
    } else {
        fill(
            &sentences::from_day(locale),
            &[("day", &long_day(locale, anchor))],
        )
    };
    wire::AgendaToolbar {
        shown: true,
        range_label,
        month_label: rows::month_year(locale, anchor),
        at_today: anchor == today,
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
    calendars: &[wire::AgendaCalendarChoice],
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
            ..wire::AgendaMoreRow::default()
        })
        .collect();
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
    let mut places = vec![
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
    places[0].section = words::rail_tasks(locale);
    out.extend(places);
    out.push(wire::AgendaMoreRow {
        key: MORE_READS.to_owned(),
        label: words::reads_title(locale),
        spoken: words::reads_title(locale),
        ..wire::AgendaMoreRow::default()
    });
    out
}

/// The screen's fixed words, so a view carries no copy of its own.
#[must_use]
pub fn words_of(locale: Locale) -> wire::AgendaChrome {
    wire::AgendaChrome {
        title: words::app_title(locale),
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
        reads_title: words::reads_title(locale),
        reads_facts: vec![
            wire::AgendaFact {
                label: words::reads_fact_reads(locale),
                detail: words::reads_fact_reads_value(locale),
            },
            wire::AgendaFact {
                label: words::reads_fact_writes(locale),
                detail: words::reads_fact_writes_value(locale),
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
