//! People's fixed sentences (`copy/people.json` stays the Kotlin copy source for the Home tile, which is the
//! shell lane's to port). Every sentence a People screen shows is one of these; the ones with a hole in
//! them are filled with [`crate::strings::fill`].

catalog! {
    plain action_call = ("Call", "Call");
    plain action_copy = ("Copy", "Copy");
    plain action_mail = ("Email", "Email");
    plain action_map = ("Open map", "Open map");
    plain add = ("Add", "Add");
    plain add_channel = ("Add channel", "Add channel");
    plain add_date = ("Add date", "Add date");
    plain add_note = ("Add note", "Add note");
    plain add_person = ("Add person", "Add person");
    plain also_on = ("Also on {names}'s card", "Also on {names}'s card");
    plain app_title = ("People", "People");
    plain back = ("Back", "Back");
    plain band_home = ("Home", "Home");
    plain band_more = ("More", "More");
    plain band_people = ("People", "People");
    plain band_touch = ("Touch", "Touch");
    counted cadence_days = ("{n} day", "{n} days");
    counted cadence_every = ("Every {n} day", "Every {n} days");
    plain cadence_every_one = ("Every day", "Every day");
    plain cadence_never = ("Never", "Never");
    plain cadence_none = ("No cadence", "No cadence");
    plain cancel = ("Cancel", "Cancel");
    plain channel_a11y = ("{kind}, {value}", "{kind}, {value}");
    plain channel_address = ("Address", "Address");
    plain channel_email = ("Email", "Email");
    plain channel_handle = ("Handle", "Handle");
    plain channel_label_field = ("Label", "Label");
    plain channel_phone = ("Phone", "Phone");
    plain channel_preferred = ("Preferred", "Preferred");
    plain channel_value_field = ("Value", "Value");
    plain chip_a11y = ("{label}, {count}", "{label}, {count}");
    plain chip_all = ("All", "All");
    plain chip_due = ("Overdue", "Overdue");
    plain chip_overdue = ("Overdue", "Overdue");
    plain chip_reminder = ("{label} · {when}", "{label} · {when}");
    plain chip_starred = ("Starred", "Starred");
    plain confirm_merge_body = ("Merging cannot be undone.", "Merging cannot be undone.");
    plain confirm_merge_title = ("Merge {dupe} into {keep}?", "Merge {dupe} into {keep}?");
    plain confirm_remove_channel_body = (
        "There is no undo for this one.",
        "There is no undo for this one."
    );
    plain confirm_remove_channel_title = ("Remove this {kind}?", "Remove this {kind}?");
    plain confirm_trash_body = ("Restorable for 30 days.", "Restorable for 30 days.");
    plain confirm_trash_title = ("Move {name} to trash?", "Move {name} to trash?");
    plain date_a11y = ("{label}, {day}", "{label}, {day}");
    plain date_field = ("Date", "Date");
    plain date_invalid = ("Use month and day, like 08-14.", "Use month and day, like 08-14.");
    plain date_label_field = ("Label", "Label");
    plain date_placeholder = ("MM-DD", "MM-DD");
    counted days_over = ("{n} day over", "{n} days over");
    plain denied_body = ("People can’t read this vault.", "People can’t read this vault.");
    plain denied_title = ("People cannot read your circle", "People cannot read your circle");
    plain done = ("Done", "Done");
    plain edit = ("Edit", "Edit");
    plain editor_edit = ("Edit person", "Edit person");
    plain editor_new = ("New person", "New person");
    plain empty_channels = ("No channels.", "No channels.");
    plain empty_dates = ("No dates.", "No dates.");
    plain empty_due = ("Nobody is overdue.", "Nobody is overdue.");
    plain empty_merge = ("Nobody to merge in.", "Nobody to merge in.");
    plain empty_notes = ("No notes.", "No notes.");
    plain empty_no_match = ("Nothing matches.", "Nothing matches.");
    plain empty_no_match_body = ("Search looks at names.", "Search looks at names.");
    plain empty_recent = ("Nothing logged yet.", "Nothing logged yet.");
    plain empty_reconnect = ("Nobody is overdue.", "Nobody is overdue.");
    plain empty_roster_body = (
        "Add someone, set how often to reach out, and log a touch each time you do.",
        "Add someone, set how often to reach out, and log a touch each time you do."
    );
    plain empty_roster_title = ("Add people you keep up with", "Add people you keep up with");
    plain empty_starred = ("Nobody is starred.", "Nobody is starred.");
    plain empty_touches = ("Nothing logged yet.", "Nothing logged yet.");
    plain empty_upcoming = ("No dates coming up.", "No dates coming up.");
    plain fact_met = ("How you met", "How you met");
    plain fact_nickname = ("Nickname", "Nickname");
    plain field_cadence = ("Reach out every", "Reach out every");
    plain field_met = ("How you met", "How you met");
    plain field_name = ("Name", "Name");
    plain field_nickname = ("Nickname", "Nickname");
    plain field_role = ("Role", "Role");
    plain field_role_placeholder = ("One line", "One line");
    plain gone_body = (
        "They were moved to the trash or merged into someone else.",
        "They were moved to the trash or merged into someone else."
    );
    plain gone_title = ("This person is not in People.", "This person is not in People.");
    plain import_contacts_add_account = (
        "No contacts found. Add your Google or other account in your phone's Settings, then come back.",
        "No contacts found. Add your Google or other account in your phone's Settings, then come back."
    );
    plain import_contacts_denied = (
        "Contacts access is off. Turn it on in Settings.",
        "Contacts access is off. Turn it on in Settings."
    );
    counted import_contacts_done = ("{n} person imported", "{n} people imported");
    plain import_contacts_failed = ("Contacts did not import.", "Contacts did not import.");
    plain import_contacts_none = ("No contacts to import", "No contacts to import");
    plain import_contacts_running = ("Importing contacts", "Importing contacts");
    plain import_origin_this_phone = ("This phone's contacts", "This phone's contacts");
    counted in_days = ("In {n} day", "In {n} days");
    plain kind_call = ("Call", "Call");
    plain kind_message = ("Message", "Message");
    plain kind_met_up = ("Met up", "Met up");
    plain kind_note = ("Note", "Note");
    plain kind_touch = ("Touch", "Touch");
    plain loading = ("Loading people", "Loading people");
    plain log = ("Log", "Log");
    plain log_hint = ("Logging stamps last contacted.", "Logging stamps last contacted.");
    plain log_touch = ("Log a touch", "Log a touch");
    plain merge = ("Merge", "Merge");
    plain merge_body = (
        "Pick who to fold into {name}. Merging cannot be undone.",
        "Pick who to fold into {name}. Merging cannot be undone."
    );
    plain merge_title = ("Merge in", "Merge in");
    counted meta_days = ("Last touch {n} day ago", "Last touch {n} days ago");
    plain meta_never = ("No touch logged yet", "No touch logged yet");
    plain meta_today = ("Last touch today", "Last touch today");
    plain meta_yesterday = ("Last touch yesterday", "Last touch yesterday");
    plain more_title = ("More", "More");
    plain move_to_trash = ("Move to trash", "Move to trash");
    plain name_needed = ("A person needs a name.", "A person needs a name.");
    plain note_label = ("Note", "Note");
    plain note_placeholder = ("Optional", "Optional");
    plain note_sheet_placeholder = ("What to remember", "What to remember");
    plain outcome_channel_removed = ("{kind} removed", "{kind} removed");
    plain outcome_channel_saved = ("{kind} saved", "{kind} saved");
    plain outcome_dated = ("Date added · {name}", "Date added · {name}");
    plain outcome_logged = ("{kind} logged · {name}", "{kind} logged · {name}");
    plain outcome_merged = ("{dupe} merged into {keep}", "{dupe} merged into {keep}");
    plain outcome_noted = ("Note added · {name}", "Note added · {name}");
    plain outcome_reminder_off = ("Reminder off · {label}", "Reminder off · {label}");
    plain outcome_reminder_on = ("Reminder on · {label}", "Reminder on · {label}");
    plain outcome_starred = ("{name} starred", "{name} starred");
    plain outcome_trashed = ("{name} moved to trash", "{name} moved to trash");
    plain outcome_unstarred = ("Star removed · {name}", "Star removed · {name}");
    counted people_count = ("{n} person", "{n} people");
    plain preferred = ("preferred", "preferred");
    plain recent_a11y = ("{kind} with {name}, {when}", "{kind} with {name}, {when}");
    plain reminder_off = ("Reminder off", "Reminder off");
    plain reminder_on = ("Reminder on", "Reminder on");
    plain reminder_turn_off = (
        "Turn off the reminder for {label}",
        "Turn off the reminder for {label}"
    );
    plain reminder_turn_on = (
        "Turn on the reminder for {label}",
        "Turn on the reminder for {label}"
    );
    plain remove = ("Remove", "Remove");
    plain remove_channel = ("Remove this {kind}", "Remove this {kind}");
    plain retry = ("Try again", "Try again");
    plain row_a11y = ("{name}", "{name}");
    plain row_a11y_due = ("{name}, overdue", "{name}, overdue");
    plain row_a11y_due_starred = ("{name}, starred, overdue", "{name}, starred, overdue");
    plain row_a11y_starred = ("{name}, starred", "{name}, starred");
    plain save = ("Save", "Save");
    plain saved = ("Saved", "Saved");
    plain saving = ("Saving…", "Saving…");
    plain search_close = ("Close search", "Close search");
    plain search_label = ("Search people", "Search people");
    plain search_placeholder = ("Search names", "Search names");
    plain section_channels = ("Channels", "Channels");
    plain section_dates = ("Dates", "Dates");
    plain section_notes = ("Notes", "Notes");
    plain section_recent = ("Recent", "Recent");
    plain section_reconnect = ("Reconnect", "Reconnect");
    plain section_touches = ("Touches", "Touches");
    plain section_upcoming = ("Upcoming", "Upcoming");
    plain sort_chip_spoken = ("Sort, {order}", "Sort, {order}");
    plain sort_heading = ("Sort", "Sort");
    plain sort_name = ("Name", "Name");
    plain sort_recent = ("Recently added", "Recently added");
    plain star = ("Star {name}", "Star {name}");
    plain star_verb = ("Star", "Star");
    plain status_roster = (
        "{people} · {due} to reconnect · {starred} starred",
        "{people} · {due} to reconnect · {starred} starred"
    );
    plain status_roster_shown = (
        "{people} shown · {due} to reconnect · {starred} starred",
        "{people} shown · {due} to reconnect · {starred} starred"
    );
    plain status_touch = ("{people} · {due} overdue", "{people} · {due} overdue");
    plain tile_all = ("People", "People");
    plain tile_reconnect = ("Reconnect", "Reconnect");
    plain tile_starred = ("Starred", "Starred");
    plain tile_upcoming = ("Upcoming", "Upcoming");
    plain touch_a11y = ("{kind}, {when}", "{kind}, {when}");
    plain trash_erases = ("Erased {day}", "Erased {day}");
    plain trash_label = ("Trash", "Trash");
    plain trash_purge_body = (
        "Their profile, dates, notes and touches leave this vault for good. A task about them stays yours. This cannot be undone.",
        "Their profile, dates, notes and touches leave this vault for good. A task about them stays yours. This cannot be undone."
    );
    plain unstar = ("Remove star from {name}", "Remove star from {name}");
    plain unstar_verb = ("Remove star", "Remove star");
    plain upcoming_a11y = ("{name}, {label}, {when}", "{name}, {label}, {when}");
    plain write_failed = ("Couldn’t save. Try again.", "Couldn’t save. Try again.");
}
