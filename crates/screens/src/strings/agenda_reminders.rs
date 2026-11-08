//! The Reminders half of the 1173 redesign: the band, the smart lists, the
//! Today buckets and the swipe. The sentences are the boards' own
//! (`design/mockups/Today`, `List`, `Swipe`, `EmptyReminders`).

catalog! {
    plain add_list = ("Add List", "Add List");
    plain afternoon = ("Afternoon", "Afternoon");
    plain band_calendar = ("Calendar", "Calendar");
    plain band_invites = ("Invites", "Invites");
    plain band_reminders = ("Reminders", "Reminders");
    plain clear_completed = ("Clear", "Clear");
    plain completed_cleared = ("Completed cleared", "Completed cleared");
    plain details = ("Details", "Details");
    plain flag = ("Flag", "Flag");
    plain flagged_empty = ("Nothing is flagged.", "Nothing is flagged.");
    plain hide_completed = ("Hide", "Hide");
    plain move_down = ("Move down", "Move down");
    plain move_up = ("Move up", "Move up");
    plain morning = ("Morning", "Morning");
    plain my_lists = ("My Lists", "My Lists");
    plain new_reminder = ("New Reminder", "New Reminder");
    plain quick_chip_day_time = ("{day}, {time}", "{day}, {time}");
    plain quick_chip_every_day = ("Every day", "Every day");
    plain quick_chip_every_month = ("Every month", "Every month");
    plain quick_chip_every_named = ("Every {weekday}", "Every {weekday}");
    plain quick_chip_every_work_day = ("Every weekday", "Every weekday");
    plain quick_chip_every_year = ("Every year", "Every year");
    plain quick_chip_keep_text = ("Keep as text", "Keep as text");
    plain quick_chip_saves_due = ("Saves as “{title}”, due {when}", "Saves as “{title}”, due {when}");
    plain quick_chip_saves_repeats = ("Saves as “{title}”, repeating {when}", "Saves as “{title}”, repeating {when}");
    plain quick_chip_spoken_due = ("Due {when}. Saves as {title}.", "Due {when}. Saves as {title}.");
    plain quick_chip_spoken_repeats = ("{when}. Saves as {title}.", "{when}. Saves as {title}.");
    plain row_unflagged = ("Flag removed", "Flag removed");
    plain row_flagged = ("Flagged", "Flagged");
    plain scheduled_empty = ("Nothing is scheduled.", "Nothing is scheduled.");
    plain show_completed = ("Show", "Show");
    plain smart_all = ("All", "All");
    plain smart_completed = ("Completed", "Completed");
    plain smart_flagged = ("Flagged", "Flagged");
    plain smart_scheduled = ("Scheduled", "Scheduled");
    plain smart_today = ("Today", "Today");
    plain today_empty = ("Nothing is due today.", "Nothing is due today.");
    plain tonight = ("Tonight", "Tonight");
    plain view_day = ("Day", "Day");
    plain view_list = ("List", "List");
    plain view_menu = ("View", "View");
    plain unflag = ("Unflag", "Unflag");
    counted completed_count = ("{n} completed", "{n} completed");
    counted today_done = ("{n} done", "{n} done");
    counted today_to_do = ("{n} to do", "{n} to do");
}
