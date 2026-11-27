//! HOME'S OWN SENTENCES (#1135): the springboard, its tiles and day-one page,
//! the vault switcher, the band and the search, plus the tile sentences the app
//! string modules here do not have (Calendar's, Docs', Notes', People's, Health's). A tile's
//! sentence an app module already has (Locker's, Money's, Photos') is read from
//! there, not restated.

catalog! {
    plain backup_status_open = ("Open backup", "Open backup");
    plain band_backup = ("Backup", "Backup");
    plain band_backup_spoken = ("Backup and recovery key", "Backup and recovery key");
    plain band_chat = ("Chat", "Chat");
    plain band_current_spoken = ("current place", "current place");
    plain band_home = ("Home", "Home");
    plain home_backup_unpaired_status = ("Not backed up yet", "Not backed up yet");
    plain home_backup_unpaired_action = ("Pair", "Pair");
    plain home_welcome = ("Nothing in here yet. Start with what this phone already holds.", "Nothing in here yet. Start with what this phone already holds.");
    plain first_launch_body = ("Apps and an assistant on this phone, backed up to your own devices.", "Apps and an assistant on this phone, backed up to your own devices.");
    plain first_launch_house_title = ("Apps on this phone", "Apps on this phone");
    plain first_launch_house_body = ("Photos, notes, documents, money and more, with no account to make.", "Photos, notes, documents, money and more, with no account to make.");
    plain first_launch_assistant_title = ("An assistant on this phone", "An assistant on this phone");
    plain first_launch_assistant_body = ("Ask about your own things. It runs on this phone.", "Ask about your own things. It runs on this phone.");
    plain first_launch_backup_title = ("Encrypted backups", "Encrypted backups");
    plain first_launch_backup_body = ("Pair a backup device. It keeps a copy it can't open.", "Pair a backup device. It keeps a copy it can't open.");
    plain first_launch_title = ("Welcome to Centraid", "Welcome to Centraid");
    plain first_launch_make = ("Get started", "Get started");
    plain first_launch_restore = ("Restore backup", "Restore backup");
    plain home_loading = ("Loading", "Loading");
    plain home_no_vault = ("No vault is open.", "No vault is open.");
    plain home_search_chat_group = ("Chats", "Chats");
    plain home_search_group = ("{name}, {n} results", "{name}, {n} results");
    plain home_search_group_one = ("{name}, 1 result", "{name}, 1 result");
    plain home_search_kind_when = ("{kind} · {when}", "{kind} · {when}");
    plain home_search_loading = ("Searching", "Searching");
    plain home_search_no_match_body = ("Nothing in this vault matches “{term}”.", "Nothing in this vault matches “{term}”.");
    plain home_search_no_match_headline = ("No matches", "No matches");
    plain home_search_note = ("Searches every app.", "Searches every app.");
    plain home_search_placeholder = ("Search everything", "Search everything");
    plain home_search_recent_label = ("Recent", "Recent");
    plain home_search_scope_label = ("All apps", "All apps");
    plain home_photos_absent = ("These photos aren't on this phone yet.", "These photos aren't on this phone yet.");
    plain open_app = ("Open {name}", "Open {name}");
    plain restore_first_action = ("Restore my vault", "Restore my vault");
    plain search_kind_chat = ("Chat", "Chat");
    plain search_kind_document = ("Document", "Document");
    plain search_kind_event = ("Event", "Event");
    plain search_kind_locker_item = ("Locker item", "Locker item");
    plain search_kind_note = ("Note", "Note");
    plain search_kind_person = ("Person", "Person");
    plain search_kind_metric = ("Metric", "Metric");
    plain search_kind_photo = ("Photo", "Photo");
    plain search_kind_transaction = ("Payment", "Payment");
    plain search_kind_workout = ("Workout", "Workout");
    plain health_search_placeholder = ("Search Health", "Search Health");
    plain search_kind_task = ("Task", "Task");
    plain vault_denied_title = ("No vault access yet.", "No vault access yet.");
    plain vault_unnamed = ("Unnamed vault", "Unnamed vault");

    // ---- the apps' names ----
    plain app_calendar = ("Calendar", "Calendar");
    plain app_docs = ("Docs", "Docs");
    plain app_health = ("Health", "Health");
    plain app_locker = ("Locker", "Locker");
    plain app_money = ("Money", "Money");
    plain app_notes = ("Notes", "Notes");
    plain app_people = ("People", "People");
    plain app_photos = ("Photos", "Photos");
    plain app_reminders = ("Reminders", "Reminders");

    // ---- the tiles ----
    plain tile_calendar_count = ("upcoming events", "upcoming events");
    plain tile_calendar_finished_today = ("No more events today", "No more events today");
    plain tile_calendar_foot_more = ("Calendar · {n} more", "Calendar · {n} more");
    plain tile_calendar_none_today = ("No events today", "No events today");
    plain tile_docs_count_one = ("document", "document");
    plain tile_docs_count_many = ("documents", "documents");
    plain tile_reminders_due = ("due", "due");
    plain tile_health_caption = ("steps today", "steps today");
    plain tile_health_slept = ("Slept {duration}", "Slept {duration}");
    plain tile_notes_count_one = ("note", "note");
    plain tile_notes_count_many = ("notes", "notes");
    plain tile_notes_edited_on = ("Edited {day}", "Edited {day}");
    plain tile_notes_edited_today = ("Edited today", "Edited today");
    plain tile_notes_edited_yesterday = ("Edited yesterday", "Edited yesterday");
    plain tile_people_reconnect = ("reconnect", "reconnect");
    plain tile_people_count_one = ("person", "person");
    plain tile_people_count_many = ("people", "people");
    plain tile_empty_calendar = ("Import your calendar", "Import your calendar");
    plain tile_empty_docs = ("Add a document", "Add a document");
    plain tile_empty_health = ("Connect Apple Health", "Connect Apple Health");
    plain tile_empty_health_connect = ("Turn on Health Connect", "Turn on Health Connect");
    plain tile_empty_locker = ("Set up Locker", "Set up Locker");
    plain tile_empty_money = ("Import a statement", "Import a statement");
    plain tile_empty_notes = ("Write your first note", "Write your first note");
    plain tile_empty_reminders = ("Import your reminders", "Import your reminders");
    plain tile_empty_reminders_by_hand = ("Write your first reminder", "Write your first reminder");
    plain tile_quiet_calendar = ("Nothing coming up", "Nothing coming up");
    plain tile_quiet_money = ("Nothing spent this month", "Nothing spent this month");
    plain tile_empty_people = ("Import contacts", "Import contacts");
    plain tile_photos_refused = ("Photo access is off · Open Settings", "Photo access is off · Open Settings");
    plain tile_calendar_refused = ("Calendar access is off · Open Settings", "Calendar access is off · Open Settings");
    plain tile_contacts_refused = ("Contacts access is off · Open Settings", "Contacts access is off · Open Settings");
    plain tile_reminders_refused = ("Reminders access is off · Open Settings", "Reminders access is off · Open Settings");
    plain tile_empty_photos = ("Import your camera roll", "Import your camera roll");

    // ---- first open and refused ----
    plain first_open_calendar = ("Your events and invitations, day by day.", "Your events and invitations, day by day.");
    plain first_open_people = ("The people you know, and what you write about them.", "The people you know, and what you write about them.");
    plain first_open_reminders = ("Things to do, by day and by list.", "Things to do, by day and by list.");
    plain first_open_reminders_by_hand = ("Add the first thing you must not forget.", "Add the first thing you must not forget.");
    plain first_open_notes = ("Write down what you want to keep.", "Write down what you want to keep.");
    plain first_open_docs = ("Documents you own, kept in your vault.", "Documents you own, kept in your vault.");
    plain first_open_money = ("Your statements, sorted and searchable.", "Your statements, sorted and searchable.");
    plain first_open_health = ("Steps, sleep and workouts, read from Apple Health.", "Steps, sleep and workouts, read from Apple Health.");
    plain first_open_health_connect = ("Steps, sleep and workouts, read from Health Connect.", "Steps, sleep and workouts, read from Health Connect.");
    plain first_open_or_write = ("Or tap + to write one.", "Or tap + to write one.");
    plain first_open_or_add = ("Or tap + to add one.", "Or tap + to add one.");
    plain first_open_write = ("Tap + to write one.", "Tap + to write one.");
    plain first_open_import_calendar = ("Import your calendar", "Import your calendar");
    plain first_open_import_reminders = ("Import your reminders", "Import your reminders");
    plain first_open_import_contacts = ("Import contacts", "Import contacts");
    plain first_open_import_photos = ("Import your camera roll", "Import your camera roll");
    plain locker_step_one = ("Step 1 of 2", "Step 1 of 2");
    plain locker_step_one_title = ("Your passwords and secure notes", "Your passwords and secure notes");
    plain locker_step_one_body = ("Locker opens with your face or your passcode, every time.", "Locker opens with your face or your passcode, every time.");
    plain locker_step_one_action = ("Confirm it's you", "Confirm it's you");
    plain locker_step_two = ("Step 2 of 2", "Step 2 of 2");
    plain locker_step_two_title = ("Add your first item.", "Add your first item.");
    plain locker_step_two_body = ("A password, a card, a Wi\u{2011}Fi network or a code.", "A password, a card, a Wi\u{2011}Fi network or a code.");
    plain tile_locker_locked = ("Locked", "Locked");
    plain refused_open_settings = ("Open Settings", "Open Settings");
    plain refused_photos_title = ("Photo access is off.", "Photo access is off.");
    plain refused_photos_body = ("Turn it on in Settings to import your camera roll.", "Turn it on in Settings to import your camera roll.");
    plain refused_calendar_title = ("Calendar access is off.", "Calendar access is off.");
    plain refused_calendar_body = ("Turn it on in Settings to import your calendar.", "Turn it on in Settings to import your calendar.");
    plain refused_contacts_title = ("Contacts access is off.", "Contacts access is off.");
    plain refused_contacts_body = ("Turn it on in Settings to import your contacts.", "Turn it on in Settings to import your contacts.");
    plain refused_reminders_title = ("Reminders access is off.", "Reminders access is off.");
    plain refused_reminders_body = ("Turn it on in Settings to import your reminders.", "Turn it on in Settings to import your reminders.");
}
