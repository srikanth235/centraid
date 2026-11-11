//! WHAT EVERY STATE OF REMINDERS' HOME CARRIES: the band, the header, the More sheet's rows and the
//! fixed words, recomputed on every view so no native view derives one field from another.

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;

use super::super::routes;
use crate::kit::export;
use crate::kit::schedule::rows;
use crate::strings::{
    Locale, agenda as words, agenda_reminders as reminders, imports, shared, task,
};

/// `AgendaBandTab.key`s: what `BandPicked` carries.
pub const BAND_REMINDERS: &str = "reminders";
pub const BAND_MORE: &str = "more";

/// `AgendaMoreRow.key`s: what `MoreRowPicked` carries.
pub const MORE_READS: &str = "reads";
pub const MORE_ANYTIME: &str = "anytime";
pub const MORE_LOGBOOK: &str = "logbook";
pub const MORE_REMINDERS: &str = "reminders";
pub const MORE_TRASH: &str = "trash";
/// The stop row's slot while Reminders does not read the phone: its tap opens the option sheet,
/// whose verb asks the phone for the permission and imports. Offered only where the platform has
/// a reminders source ([`crate::Ctx::reminders_source`]).
pub const MORE_TURN_ON: &str = "turn-on";
/// The stop row's slot while it does: its tap asks first.
pub const MORE_STOP: &str = "stop";

/// The places a More row opens as a page.
pub const TASK_PLACES: [&str; 4] = [MORE_ANYTIME, MORE_LOGBOOK, MORE_REMINDERS, MORE_TRASH];

/// The band: Reminders and More, since Apple's Reminders has no band of places (R-CHROME-5).
#[must_use]
pub fn band(locale: Locale, sheet_up: bool) -> Vec<wire::AgendaBandTab> {
    vec![
        wire::AgendaBandTab {
            key: BAND_REMINDERS.to_owned(),
            label: reminders::band_reminders(locale),
            icon_key: "Todo".to_owned(),
            current: !sheet_up,
        },
        wire::AgendaBandTab {
            key: BAND_MORE.to_owned(),
            label: words::band_more(locale),
            icon_key: "MoreHoriz".to_owned(),
            current: sheet_up,
        },
    ]
}

/// THE HEADER: the bar and the place's `title`, since there is no month to go back to and no layout
/// to pick. Not `shown` while denied or while a search term is answering.
#[must_use]
pub fn header(locale: Locale, shown: bool) -> wire::AgendaCalendarHeader {
    if !shown {
        return wire::AgendaCalendarHeader::default();
    }
    wire::AgendaCalendarHeader {
        shown: true,
        layout: Dest::Todo as i32,
        title: reminders::reminders_title(locale),
        ..wire::AgendaCalendarHeader::default()
    }
}

/// REMINDERS' SHEET: the places that are not on the home (Anytime, Logbook, Reminders and the trash),
/// the phone's Reminders import where the platform has one, and what Reminders may read.
pub fn more_rows(locale: Locale, has_source: bool, following: bool) -> Vec<wire::AgendaMoreRow> {
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
            shared::trash_entry(locale),
            shared::trash_entry_meta(locale),
            "Trash",
            routes::trash(),
        ),
    ];
    out.extend(places);
    // EXPORT (#1185): the kit's one entry, the same row in every app.
    let export = export::entry(locale, super::super::EXPORT);
    out.push(wire::AgendaMoreRow {
        key: export.key.to_owned(),
        spoken: export.label.clone(),
        label: export.label,
        icon_key: export.icon_key.to_owned(),
        route: Some(export.route),
        ..wire::AgendaMoreRow::default()
    });
    // THE STOP SLOT (as Calendar's, Health's and People's): "Stop reading Phone reminders" while
    // Reminders reads the phone, "Turn on Phone reminders" otherwise, so the slot is never empty.
    // Only where the platform has a Reminders store (iOS); Android shows neither.
    if has_source {
        let store = reminders::phone_reminders(locale);
        let (key, label, icon) = if following {
            (
                MORE_STOP,
                crate::kit::follow::stop_row(locale, &store),
                "Stop",
            )
        } else {
            (
                MORE_TURN_ON,
                crate::kit::follow::turn_on_row(locale, &store),
                "Power",
            )
        };
        out.push(wire::AgendaMoreRow {
            key: key.to_owned(),
            spoken: label.clone(),
            label,
            icon_key: icon.to_owned(),
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
pub fn words_of(locale: Locale) -> wire::AgendaChrome {
    wire::AgendaChrome {
        title: reminders::reminders_title(locale),
        new_event: words::new_event(locale),
        today: words::today(locale),
        previous_day: words::previous_day(locale),
        next_day: words::next_day(locale),
        search_placeholder: reminders::search_placeholder(locale),
        search_label: reminders::search_placeholder(locale),
        search_close: words::close(locale),
        retry: words::retry(locale),
        loading: words::loading(locale),
        more_title: words::band_more(locale),
        reads_title: reminders::reads_reminders_title(locale),
        reads_facts: vec![
            wire::AgendaFact {
                label: words::reads_fact_reads(locale),
                detail: reminders::reads_reminders_reads(locale),
            },
            wire::AgendaFact {
                label: words::reads_fact_writes(locale),
                detail: reminders::reads_reminders_writes(locale),
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
