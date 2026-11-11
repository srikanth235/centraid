//! WHAT EVERY STATE OF CALENDAR'S HOME CARRIES: the band, the Calendar's header, the day bar, the
//! Calendars sheet's rows and the fixed words, recomputed on every view so no native view derives
//! one field from another.

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;

use super::grid;
use crate::calendar::routes;
use crate::kit::civil;
use crate::kit::export;
use crate::kit::schedule::rows;
use crate::kit::schedule::rule_words::long_day;
use crate::strings::{
    Locale, agenda as words, agenda_grid as sayings, agenda_home as sentences,
    agenda_lists as lists, agenda_reminders as reminders, fill, shared,
};

/// `AgendaBandTab.key`s: what `BandPicked` carries.
pub const BAND_CALENDAR: &str = "calendar";
pub const BAND_INVITES: &str = "invites";
pub const BAND_MORE: &str = "more";
/// The band's last place (`Calendar.dc.html`): the sheet of Calendar's own places, Trash today.
pub const BAND_MENU: &str = "menu";

/// `AgendaMoreRow.key`s: what `MoreRowPicked` carries.
pub const MORE_READS: &str = "reads";
pub const MORE_CALENDAR: &str = "calendar-";
/// The row that opens the new-calendar sheet (#1173).
pub const MORE_NEW_CALENDAR: &str = "new-calendar";
/// The menu sheet's row to the trash (#1185).
pub const MORE_TRASH: &str = "trash";
/// The menu sheet's row that stops reading the phone's calendars (#1185); it opens a confirm.
pub const MORE_STOP: &str = "stop";

/// The band (places only, R-CHROME-5): Calendar, Calendars (the sheet of calendars to show or hide,
/// Apple's middle key) and Invites (Apple's Inbox; the old Waiting). Calendar holds Day, Week, Month,
/// List and Year behind its view menu ([`calendar_views`]). SEARCH IS A MODE OVER THE PLACE, not a
/// place: the destination's tab stays lit while the field is open.
#[must_use]
pub fn band(
    locale: Locale,
    destination: Dest,
    calendars_up: bool,
    menu_up: bool,
) -> Vec<wire::AgendaBandTab> {
    let tab = |key: &str, label: String, icon: &str, current: bool| wire::AgendaBandTab {
        key: key.to_owned(),
        label,
        icon_key: icon.to_owned(),
        current,
    };
    vec![
        tab(
            BAND_CALENDAR,
            reminders::band_calendar(locale),
            "Calendar",
            grid::is_calendar_view(destination) && !calendars_up && !menu_up,
        ),
        tab(
            BAND_MORE,
            reminders::band_calendars(locale),
            "List",
            calendars_up,
        ),
        tab(
            BAND_INVITES,
            reminders::band_invites(locale),
            "Inbox",
            destination == Dest::Waiting,
        ),
        tab(BAND_MENU, words::band_more(locale), "MoreHoriz", menu_up),
    ]
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

/// THE CALENDAR'S HEADER (#1173, `Calendar.dc.html`): the month chip, the layout
/// key, Day's all-day lane and the Today key's visibility. `data` is the
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
    if !shown || !has_calendar_header(destination) {
        return wire::AgendaCalendarHeader::default();
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
    if !shown || anchor.is_empty() || today.is_empty() || has_calendar_header(destination) {
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

/// CALENDAR'S SHEET ("Calendars"): every calendar as a show/hide toggle, a new calendar, and what
/// Calendar may read. Never Search, never a sort or a filter (R-CHROME-4).
#[must_use]
pub fn more_rows(
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

/// CALENDAR'S MENU SHEET (`MoreCalendar.dc.html`): the places that are not a view of the calendar.
/// Trash, with the rule that every trash states: 30 days, then erased.
#[must_use]
pub fn menu_rows(locale: Locale, can_stop: bool) -> Vec<wire::AgendaMoreRow> {
    let label = shared::trash_entry(locale);
    let meta = shared::trash_entry_meta(locale);
    let export = export::entry(locale, super::super::EXPORT);
    vec![
        wire::AgendaMoreRow {
            key: export.key.to_owned(),
            spoken: export.label.clone(),
            label: export.label,
            icon_key: export.icon_key.to_owned(),
            route: Some(export.route),
            ..wire::AgendaMoreRow::default()
        },
        wire::AgendaMoreRow {
            key: MORE_TRASH.to_owned(),
            spoken: format!("{label}, {meta}"),
            label,
            meta,
            icon_key: "Trash".to_owned(),
            route: Some(routes::trash()),
            ..wire::AgendaMoreRow::default()
        },
    ]
    .into_iter()
    // THE STOP ROW, last (as Health's and People's): the same words for every followed store, and
    // no route of its own, so its tap asks first.
    .chain(can_stop.then(|| {
        let label = crate::kit::follow::stop_row(locale, &stop_store(locale));
        wire::AgendaMoreRow {
            key: MORE_STOP.to_owned(),
            spoken: label.clone(),
            label,
            icon_key: "Stop".to_owned(),
            ..wire::AgendaMoreRow::default()
        }
    }))
    .collect()
}

/// What the stop row and its confirm call the store: "Phone calendars", as the Reconnect list does.
#[must_use]
pub fn stop_store(locale: Locale) -> String {
    crate::strings::follow::reconnect_calendars(locale)
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
