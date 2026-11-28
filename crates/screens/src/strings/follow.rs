//! What a More sheet says about following a phone store (app-plane §16): one row to turn it on, one
//! to stop, and the state when the phone said no. A store's own noun is `store_*`.

catalog! {
    plain follow_row = ("Follow {store}", "Follow {store}");
    plain following_row = ("Following {store}", "Following {store}");
    plain following_meta = ("Read from your phone when Centraid opens.", "Read from your phone when Centraid opens.");
    plain stop_row = ("Stop following {store}", "Stop following {store}");
    plain stopped_status = ("Stopped following {store}. What it added stays.", "Stopped following {store}. What it added stays.");
    plain stop_title = ("Stop following {store}?", "Stop following {store}?");
    plain stop_body = (
        "Centraid stops reading {source}. What it already added stays.",
        "Centraid stops reading {source}. What it already added stays."
    );
    plain stop_confirm = ("Stop following", "Stop following");
    plain off_row = ("{store} is off", "{store} is off");
    plain open_settings_row = ("Open Settings", "Open Settings");
    plain unavailable_row = ("{store} isn’t on this phone", "{store} isn’t on this phone");
    plain restricted_row = ("Your phone doesn’t allow {store}", "Your phone doesn’t allow {store}");
    plain follow_files_row = ("Follow a folder", "Follow a folder");
    plain following_files_row = ("Following folders", "Following folders");
    plain asking_status = ("Waiting for your phone.", "Waiting for your phone.");

    plain doubted_status = (
        "Far fewer items than before in {source}, so nothing was removed.",
        "Far fewer items than before in {source}, so nothing was removed."
    );
    plain incomplete_status = (
        "Only part of {source} was readable, so this shows what was read.",
        "Only part of {source} was readable, so this shows what was read."
    );

    plain store_contacts = ("Contacts", "Contacts");
    plain store_calendar = ("Calendars", "Calendars");
    plain store_reminders = ("Reminders", "Reminders");
    plain store_health = ("Health", "Health");
    plain store_camera_roll = ("Camera roll", "Camera roll");
    plain store_files = ("Folders", "Folders");

    plain source_contacts = ("your phone’s contacts", "your phone’s contacts");
    plain source_calendar = ("your phone’s calendars", "your phone’s calendars");
    plain source_reminders = ("your phone’s reminders", "your phone’s reminders");
    plain source_health = ("your health store", "your health store");
    plain source_camera_roll = ("your camera roll", "your camera roll");
    plain source_files = ("the folder", "the folder");
}
