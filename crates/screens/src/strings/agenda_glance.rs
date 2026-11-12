//! Agenda outside the app (#1173): the words of the widgets' snapshot, Siri's
//! sentences, and the static names the platform needs at COMPILE time (widget
//! gallery entries, intent titles and phrases, Android shortcut labels).
//!
//! The static words (`widget_*`, `intent_*`, `shortcut_*`) are exported to both
//! shells by `cargo xtask design` (`GlanceWords.swift`, `AgendaShortcuts.swift`,
//! `glance_strings.xml`), because a Siri phrase must be a string literal and a
//! manifest cannot call into Rust. A static row therefore stays one line and
//! `plain`. The rest travel inside the snapshot document and are finished here.
//!
//! `{app}` in an `intent_*_phrase` stands for the app's name, which the
//! platform fills; `{title}` and `{time}` in a `siri_*` row are filled by
//! [`super::fill`].

catalog! {
    plain add_label = ("New Reminder", "New Reminder");
    plain intent_add_phrase = ("Add a reminder in {app}", "Add a reminder in {app}");
    plain intent_add_title = ("Add a reminder", "Add a reminder");
    plain intent_add_title_parameter = ("Reminder", "Reminder");
    plain intent_next_phrase = ("What's next in {app}", "What's next in {app}");
    plain intent_next_title = ("What's next", "What's next");
    plain no_reminders = ("Nothing due today", "Nothing due today");
    plain nothing_next = ("Nothing else today", "Nothing else today");
    plain reminders_title = ("Reminders", "Reminders");
    plain shortcut_add_long = ("Add a reminder", "Add a reminder");
    plain shortcut_add_short = ("New reminder", "New reminder");
    plain shortcut_next_long = ("What's next", "What's next");
    plain shortcut_next_short = ("What's next", "What's next");
    plain siri_next = ("Next is {title} at {time}.", "Next is {title} at {time}.");
    plain siri_next_all_day = ("Next is {title}, all day.", "Next is {title}, all day.");
    plain siri_next_tomorrow = ("Next is {title} tomorrow at {time}.", "Next is {title} tomorrow at {time}.");
    plain siri_next_tomorrow_all_day = ("Next is {title} tomorrow, all day.", "Next is {title} tomorrow, all day.");
    plain siri_nothing = ("Nothing else on your day.", "Nothing else on your day.");
    plain siri_unavailable = ("Open Centraid to see your day.", "Open Centraid to see your day.");
    plain stale = ("Open Centraid to refresh", "Open Centraid to refresh");
    plain today_title = ("Today", "Today");
    plain unavailable = ("Open Centraid to see your day", "Open Centraid to see your day");
    plain up_next_title = ("Up next", "Up next");
    plain widget_reminders_description = ("Today's and overdue reminders.", "Today's and overdue reminders.");
    plain widget_reminders_name = ("Reminders", "Reminders");
    plain widget_up_next_description = ("What's next today, from your Calendar.", "What's next today, from your Calendar.");
    plain widget_up_next_name = ("Up next", "Up next");
    counted flagged_label = ("{n} flagged", "{n} flagged");
    counted overdue_label = ("{n} overdue", "{n} overdue");
    counted today_label = ("{n} today", "{n} today");
}
