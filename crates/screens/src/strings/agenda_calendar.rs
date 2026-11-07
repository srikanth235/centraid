//! The calendar import's own sentences: what the status line says while the
//! phone's calendars are read and when they could not be. The outcome lines
//! (`import_calendar_done`, `…_one`, `…_none`, …) are `strings::agenda`'s.

catalog! {
    plain import_calendar_denied = ("Calendar access is off. Turn it on in Settings.", "Calendar access is off. Turn it on in Settings.");
    plain sync_failed = ("Some changes did not reach your phone's calendar. They will be tried again.", "Some changes did not reach your phone's calendar. They will be tried again.");
    counted sync_kept = ("{n} deleted event was kept on your phone's calendar because it changed there.", "{n} deleted events were kept on your phone's calendar because they changed there.");
    plain import_calendar_running = ("Importing calendar", "Importing calendar");
}
