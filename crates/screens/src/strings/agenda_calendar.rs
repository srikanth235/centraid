//! The calendar import's own sentences: what the status line says while the
//! phone's calendars are read and when they could not be. The outcome lines
//! (`import_calendar_done`, `…_one`, `…_none`, …) are `strings::agenda`'s.

catalog! {
    plain calendar_write_unsupported = ("Some changes are not supported by this calendar. Make those changes in your calendar app; your Agenda edits are kept.", "Some changes are not supported by this calendar. Make those changes in your calendar app; your Agenda edits are kept.");
    plain calendar_write_refused = ("Some calendar changes could not be saved. Check calendar access and try again; your Agenda edits are kept.", "Some calendar changes could not be saved. Check calendar access and try again; your Agenda edits are kept.");
    plain import_calendar_denied = ("Calendar access is off. Turn it on in Settings.", "Calendar access is off. Turn it on in Settings.");
    plain import_calendar_running = ("Importing calendar", "Importing calendar");
}
