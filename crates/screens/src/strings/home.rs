//! HOME'S OWN SENTENCES (#1135): the springboard, its tiles and day-one page,
//! the vault switcher, the band and the search, plus the tile sentences the app
//! string modules here do not have (Agenda's, Docs', Notes', People's, Health's). A tile's
//! sentence an app module already has (Locker's, Money's, Photos') is read from
//! there, not restated.

catalog! {
    plain appearance_to_dark = ("Switch to dark", "Switch to dark");
    plain appearance_to_light = ("Switch to light", "Switch to light");
    plain backup_status_open = ("Open backup", "Open backup");
    plain band_backup = ("Backup", "Backup");
    plain band_backup_spoken = ("Backup and recovery key", "Backup and recovery key");
    plain band_chat = ("Chat", "Chat");
    plain band_current_spoken = ("current place", "current place");
    plain band_home = ("Home", "Home");
    plain home_day_one_body = ("Add photos and documents to get started.", "Add photos and documents to get started.");
    plain home_day_one_title = ("Nothing in here yet", "Nothing in here yet");
    plain first_launch_body = ("Apps and an assistant on this phone, backed up to your own devices.", "Apps and an assistant on this phone, backed up to your own devices.");
    plain first_launch_house_title = ("Apps on this phone", "Apps on this phone");
    plain first_launch_house_body = ("Photos, notes, documents, money and more, with no account to make.", "Photos, notes, documents, money and more, with no account to make.");
    plain first_launch_assistant_title = ("An assistant on this phone", "An assistant on this phone");
    plain first_launch_assistant_body = ("Ask about your own things. It runs on this phone.", "Ask about your own things. It runs on this phone.");
    plain first_launch_backup_title = ("Encrypted backups", "Encrypted backups");
    plain first_launch_backup_body = ("Pair a backup device. It keeps a copy it can't open.", "Pair a backup device. It keeps a copy it can't open.");
    plain first_launch_next = ("Next", "Next");
    plain first_launch_skip = ("Skip", "Skip");
    plain first_launch_make = ("Get started", "Get started");
    plain first_launch_restore = ("Restore backup", "Restore backup");
    plain home_loading = ("Loading", "Loading");
    plain home_no_vault = ("No vault is open.", "No vault is open.");
    plain home_search_chat_group = ("Chats", "Chats");
    plain home_search_group = ("{name}, {n} results", "{name}, {n} results");
    plain home_search_group_one = ("{name}, 1 result", "{name}, 1 result");
    plain home_search_loading = ("Searching", "Searching");
    plain home_search_no_match_body = ("Nothing in this vault matches “{term}”.", "Nothing in this vault matches “{term}”.");
    plain home_search_no_match_headline = ("No matches", "No matches");
    plain home_search_note = ("Searches every app.", "Searches every app.");
    plain home_search_placeholder = ("Search everything", "Search everything");
    plain home_search_recent_label = ("Recent", "Recent");
    plain home_search_scope_label = ("All apps", "All apps");
    plain home_photos_absent = ("These photos aren't on this phone yet.", "These photos aren't on this phone yet.");
    plain open_app = ("Open {name}", "Open {name}");
    plain restore_first_action = ("Restore my vaults", "Restore my vaults");
    plain search_kind_chat = ("Chat", "Chat");
    plain search_kind_document = ("Document", "Document");
    plain search_kind_event = ("Event", "Event");
    plain search_kind_locker_item = ("Locker item", "Locker item");
    plain search_kind_note = ("Note", "Note");
    plain search_kind_person = ("Person", "Person");
    plain search_kind_photo = ("Photo", "Photo");
    plain search_kind_task = ("Task", "Task");
    plain vault_denied_title = ("No vault access yet.", "No vault access yet.");
    plain vault_switch_spoken = ("Switch vault", "Switch vault");
    plain vaults_current = ("Currently open", "Currently open");
    plain vaults_forget = ("Delete", "Delete");
    plain vaults_forget_body = (
        "This deletes the vault from this phone. A backup device keeps its copy and your recovery key restores it; without one, it's gone.",
        "This deletes the vault from this phone. A backup device keeps its copy and your recovery key restores it; without one, it's gone."
    );
    plain vaults_forget_this = ("this vault", "this vault");
    plain vaults_forget_title = ("Delete {name}?", "Delete {name}?");
    plain vaults_keep = ("Keep", "Keep");
    plain vaults_make = ("Make a vault", "Make a vault");
    plain vaults_make_spoken = ("Make a vault on this phone", "Make a vault on this phone");
    plain vaults_one = ("This phone has one vault.", "This phone has one vault.");
    plain vaults_rename = ("Rename", "Rename");
    plain vaults_rename_failed = ("Couldn't save the name. Try again.", "Couldn't save the name. Try again.");
    plain vaults_rename_field = ("Vault name", "Vault name");
    plain vaults_rename_save = ("Save", "Save");
    plain vaults_rename_title = ("Rename vault", "Rename vault");
    plain vaults_title = ("Vaults", "Vaults");
    plain vaults_unnamed = ("Unnamed vault", "Unnamed vault");

    // ---- the apps' names ----
    plain app_agenda = ("Agenda", "Agenda");
    plain app_docs = ("Docs", "Docs");
    plain app_health = ("Health", "Health");
    plain app_locker = ("Locker", "Locker");
    plain app_money = ("Money", "Money");
    plain app_notes = ("Notes", "Notes");
    plain app_people = ("People", "People");
    plain app_photos = ("Photos", "Photos");

    // ---- the tiles ----
    plain tile_agenda_all_day = ("all day", "all day");
    plain tile_agenda_count = ("on your plate", "on your plate");
    plain tile_agenda_due = ("{n} due", "{n} due");
    plain tile_agenda_nothing_after = ("nothing after it", "nothing after it");
    plain tile_agenda_nothing_until = ("then nothing until the", "then nothing until the");
    plain tile_agenda_no_events = ("No events coming up", "No events coming up");
    plain tile_agenda_then = ("then", "then");
    plain tile_docs_count_one = ("document", "document");
    plain tile_docs_count_many = ("documents", "documents");
    plain tile_health_caption = ("steps today", "steps today");
    plain tile_health_slept = ("Slept {duration}", "Slept {duration}");
    plain tile_notes_count_one = ("note", "note");
    plain tile_notes_count_many = ("notes", "notes");
    plain tile_people_count_one = ("person", "person");
    plain tile_people_count_many = ("people", "people");
    plain tile_people_everyone = ("That's everyone in your directory", "That's everyone in your directory");
    plain tile_people_more = ("+{n} more in your directory", "+{n} more in your directory");
    plain tile_empty_agenda = ("Put something on the calendar", "Put something on the calendar");
    plain tile_empty_docs = ("Add your first document", "Add your first document");
    plain tile_empty_health = ("Connect your health app", "Connect your health app");
    plain tile_empty_locker = ("Unlock to see your items", "Unlock to see your items");
    plain tile_empty_money = ("Import your first statement", "Import your first statement");
    plain tile_empty_notes = ("Write your first note", "Write your first note");
    plain tile_empty_people = ("Add someone you know", "Add someone you know");
    plain tile_empty_photos = ("Import your first photo", "Import your first photo");
}
