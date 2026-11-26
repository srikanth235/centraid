//! THE ROOM PLANE'S OWN SENTENCES: what the status line says after an action, and what a
//! notification says (app-plane §9). Settings and Backup keep their own files.

catalog! {
    plain act_trashed = ("Moved to trash", "Moved to trash");
    plain act_restored = ("Restored", "Restored");
    plain act_done = ("Done", "Done");
    plain act_undone = ("Undone", "Undone");
    plain act_refused = ("That didn't work. Try again.", "That didn't work. Try again.");
    plain notify_snooze = ("Snooze", "Snooze");
    plain notify_done = ("Done", "Done");
    plain notify_channel = ("Reminders and events", "Reminders and events");
    plain notify_backup_channel = ("Backup warnings", "Backup warnings");
    plain notify_locker_title = ("An item in Locker expires soon", "An item in Locker expires soon");
    plain notify_event_body = ("Starts {when}", "Starts {when}");
    plain notify_task_body = ("Due {when}", "Due {when}");
    plain notify_untitled = ("Untitled", "Untitled");
    plain notify_private_event = ("An event is coming up", "An event is coming up");
    plain notify_private_task = ("A reminder is due", "A reminder is due");
    plain notify_private_date = ("A date is coming up", "A date is coming up");
    plain notify_private_body = ("Open Centraid to see it.", "Open Centraid to see it.");
    plain notify_birthday = ("Birthday", "Birthday");
    plain notify_anniversary = ("Anniversary", "Anniversary");
    plain notify_date = ("Date", "Date");
    plain home_title = ("Centraid", "Centraid");
    plain home_settings_tile = ("Settings", "Settings");
    plain home_backup_tile = ("Backup", "Backup");
    plain backup_title = ("Backup", "Backup");
    plain backup_back_up_now = ("Back up now", "Back up now");
    plain backup_waiting = ("Waiting", "Waiting");
    plain backup_devices = ("Backup devices", "Backup devices");
    plain backup_no_devices = ("No backup device yet", "No backup device yet");
    plain backup_no_devices_body = ("Pair a laptop to keep a copy it can't open.", "Pair a laptop to keep a copy it can't open.");
    plain backup_not_ready = ("Backup isn't ready yet.", "Backup isn't ready yet.");
    plain backup_retry = ("Try again", "Try again");
    plain backup_started = ("Backing up", "Backing up");
    plain backup_refused = ("Couldn't back up just now. Try again.", "Couldn't back up just now. Try again.");
    plain device_last_backup = ("Last backed up {when}", "Last backed up {when}");
    plain device_never = ("Never backed up", "Never backed up");
    plain settings_version_value = ("Centraid", "Centraid");
}
