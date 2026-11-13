//! The words of Agenda's notifications (#1173): the buttons on a reminder, the
//! line the phone says after one is pressed, and how a reminder's second line
//! reads. The title of a reminder is the task's or the event's own.

catalog! {
    plain at_time = ("{day} at {time}", "{day} at {time}");
    plain mark_done = ("Mark as done", "Mark as done");
    plain moved_tomorrow = ("Moved to tomorrow", "Moved to tomorrow");
    plain snooze_hour = ("Snooze 1 hour", "Snooze 1 hour");
    plain channel_reminders = ("Reminders and events", "Reminders and events");
    plain private_task_title = ("Reminder", "Reminder");
    plain private_event_title = ("Event", "Event");
    plain private_body = ("Open Centraid to see it.", "Open Centraid to see it.");
    plain date_only_task_alert = ("A reminder for a day with no time sounds at 09:00 that day.", "A reminder for a day with no time sounds at 09:00 that day.");
    plain all_day_event_alert = ("An alert for an all-day event sounds at 09:00 that day.", "An alert for an all-day event sounds at 09:00 that day.");
    plain all_day_event_alert_row = ("On the day, {time}", "On the day, {time}");
    plain snoozed_hour = ("Snoozed for 1 hour", "Snoozed for 1 hour");
}
