//! The phone imports' sentences: the camera-roll lines, "Open {name}" and the reminders lines
//! that the importers did not already own.
//! The contacts, calendar and reminders outcome lines are `strings::people`, `strings::agenda` and
//! `strings::task`'s; the camera roll's grant sentences are `strings::photos`'.

catalog! {
    plain app_agenda = ("Agenda", "Agenda");
    plain app_people = ("People", "People");
    plain app_photos = ("Photos", "Photos");
    plain in_cloud = (
        "Some originals are only in iCloud. Centraid fetches them on Wi-Fi.",
        "Some originals are only in iCloud. Centraid fetches them on Wi-Fi."
    );
    plain no_vault = ("No vault is open.", "No vault is open.");
    plain open_app = ("Open {name}", "Open {name}");
    plain photo_unreadable = ("Couldn't read that photo.", "Couldn't read that photo.");
    plain photo_refused = ("Couldn't add that photo.", "Couldn't add that photo.");
    plain reminders_denied = (
        "Reminders access is off. Turn it on in Settings.",
        "Reminders access is off. Turn it on in Settings."
    );
    plain reminders_running = ("Importing reminders", "Importing reminders");
    plain follow_failed = ("That folder could not be followed.", "That folder could not be followed.");
}
