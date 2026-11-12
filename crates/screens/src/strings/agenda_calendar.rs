//! The calendar import's own sentences: what the status line says while the
//! phone's calendars are read and when they could not be. The outcome lines
//! (`import_calendar_done`, `…_one`, `…_none`, …) are `strings::agenda`'s.

catalog! {
    plain calendars_kept = ("events", "events");
    plain calendars_stopped = ("Calendar stopped reading your phone calendars.", "Calendar stopped reading your phone calendars.");
    plain import_calendar_running = ("Importing calendar", "Importing calendar");
}
