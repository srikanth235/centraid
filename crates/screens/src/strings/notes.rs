//! Notes' fixed sentences (`copy/notes.json` is the Kotlin copy source for the
//! Home tile, which stays on that side until the shell lane ports it). Every
//! sentence a Notes screen shows is one of these; the ones with a hole in them
//! are filled with [`crate::strings::fill`].

catalog! {
    plain band_journal = ("Journal", "Journal");
    plain band_more = ("More", "More");
    plain band_notebooks = ("Notebooks", "Notebooks");
    plain band_notes = ("Notes", "Notes");
    plain body_placeholder = ("Write something", "Write something");
    plain cancel = ("Cancel", "Cancel");
    plain chip_pinned = ("Pinned", "Pinned");
    plain close = ("Close", "Close");
    plain create = ("Create", "Create");
    plain current_version = ("Current version", "Current version");
    plain delete_note_body = (
        "It stays restorable for 30 days, with its links, tags and files.",
        "It stays restorable for 30 days, with its links, tags and files."
    );
    plain delete_note_title = ("Move this note to trash?", "Move this note to trash?");
    plain delete_note_verb = ("Trash", "Trash");
    plain delete_notebook_body = (
        "Its notes go to the trash with it, restorable for 30 days.",
        "Its notes go to the trash with it, restorable for 30 days."
    );
    plain delete_notebook_title = ("Delete this notebook?", "Delete this notebook?");
    plain delete_notebook_verb = ("Delete", "Delete");
    plain denied_body = (
        "Ask the owner of this vault for access.",
        "Ask the owner of this vault for access."
    );
    plain denied_title = ("Notes cannot read this vault", "Notes cannot read this vault");
    plain domain_docs = ("Docs", "Docs");
    plain domain_events = ("Agenda", "Agenda");
    plain domain_locker = ("Locker", "Locker");
    plain domain_notes = ("Notes", "Notes");
    plain domain_other = ("Other", "Other");
    plain domain_people = ("People", "People");
    plain domain_photos = ("Photos", "Photos");
    plain domain_tasks = ("Tasks", "Tasks");
    plain done = ("Done", "Done");
    plain edited = ("Edited", "Edited");
    plain empty_day_one = ("Write the first one.", "Write the first one.");
    plain empty_day_one_headline = ("No notes yet", "No notes yet");
    plain empty_filtered_body = ("No notes match this view.", "No notes match this view.");
    plain empty_filtered_headline = ("Nothing here", "Nothing here");
    plain empty_notebook_body = (
        "Nothing is filed in this notebook yet.",
        "Nothing is filed in this notebook yet."
    );
    plain file_title = ("File into notebook", "File into notebook");
    plain file_verb = ("File into notebook", "File into notebook");
    plain history_empty_body = (
        "Versions appear here as the note changes.",
        "Versions appear here as the note changes."
    );
    plain history_empty_headline = ("No earlier versions", "No earlier versions");
    plain history_title = ("Version history", "Version history");
    plain home = ("Home", "Home");
    plain journal_empty_body = (
        "Entries you write about people in People appear here.",
        "Entries you write about people in People appear here."
    );
    plain journal_empty_headline = ("No journal entries yet", "No journal entries yet");
    plain journal_line = ("A line about your day", "A line about your day");
    plain journal_mood = ("Mood", "Mood");
    plain journal_origin = (
        "Journal entries are written in People and kept apart from your notes.",
        "Journal entries are written in People and kept apart from your notes."
    );
    plain journal_save = ("Save", "Save");
    plain journal_title = ("Journal", "Journal");
    plain link_empty_body = (
        "Type to find a note, person, event or task.",
        "Type to find a note, person, event or task."
    );
    plain link_empty_headline = ("Nothing to link", "Nothing to link");
    plain link_kind_document = ("Document", "Document");
    plain link_kind_event = ("Event", "Event");
    plain link_kind_locker_item = ("Locker item", "Locker item");
    plain link_kind_note = ("Note", "Note");
    plain link_kind_person = ("Person", "Person");
    plain link_kind_photograph = ("Photo", "Photo");
    plain link_kind_task = ("Task", "Task");
    plain link_label = ("Add link", "Add link");
    plain link_no_match_body = ("Nothing matches that search.", "Nothing matches that search.");
    plain link_search = ("Search everything", "Search everything");
    plain link_title = ("Link to", "Link to");
    plain loading = ("Loading notes", "Loading notes");
    plain loading_history = ("Loading versions", "Loading versions");
    plain loading_journal = ("Loading the journal", "Loading the journal");
    plain loading_links = ("Looking for things to link", "Looking for things to link");
    plain loading_notebooks = ("Loading notebooks", "Loading notebooks");
    plain more_title = ("More", "More");
    plain new_entry = ("New entry for today", "New entry for today");
    plain new_note = ("New note", "New note");
    plain new_notebook = ("New notebook", "New notebook");
    plain no_notebook = ("No notebook", "No notebook");
    plain note_title = ("Note", "Note");
    plain note_missing = ("This note isn't on this phone.", "This note isn't on this phone.");
    plain note_trashed = ("This note is in the trash.", "This note is in the trash.");
    plain notebook_name = ("Notebook name", "Notebook name");
    plain notebooks_empty_body = (
        "A notebook keeps related notes together.",
        "A notebook keeps related notes together."
    );
    plain notebooks_empty_headline = ("No notebooks yet", "No notebooks yet");
    plain notebooks_title = ("Notebooks", "Notebooks");
    plain pin = ("Pin", "Pin");
    plain powerbox_foot = (
        "Locker items link by name; their secrets stay sealed.",
        "Locker items link by name; their secrets stay sealed."
    );
    plain remove_tag = ("Remove tag", "Remove tag");
    plain tag_placeholder = ("Add a tag", "Add a tag");
    plain rename = ("Rename", "Rename");
    plain rename_notebook = ("Rename notebook", "Rename notebook");
    plain restore = ("Restore", "Restore");
    plain retry = ("Try again", "Try again");
    plain row_menu = ("Note actions", "Note actions");
    plain notebook_menu = ("Notebook actions", "Notebook actions");
    plain saved = ("Saved", "Saved");
    plain saving = ("Saving…", "Saving…");
    plain search_close = ("Close search", "Close search");
    plain search_empty = ("Type to search titles and bodies.", "Type to search titles and bodies.");
    plain search_label = ("Search", "Search");
    plain search_no_match_body = ("No notes match that search.", "No notes match that search.");
    plain search_no_match_headline = ("No matches", "No matches");
    plain search_placeholder = ("Search notes", "Search notes");
    plain section_notes = ("Notes", "Notes");
    plain section_pinned = ("Pinned", "Pinned");
    plain send_to_agenda = ("Send to Agenda", "Send to Agenda");
    plain sort_chip_spoken = ("Sort, {order}", "Sort, {order}");
    plain sort_created = ("Date created", "Date created");
    plain sort_title = ("Sort notes", "Sort notes");
    plain sort_title_az = ("Title", "Title");
    plain sort_updated = ("Last edited", "Last edited");
    plain title = ("Notes", "Notes");
    plain title_placeholder = ("Title", "Title");
    plain trash_label = ("Trash", "Trash");
    plain unfiled_row = ("Unfiled", "Unfiled");
    plain unpin = ("Unpin", "Unpin");
    plain untitled = ("Untitled note", "Untitled note");
    plain untitled_notebook = ("Untitled notebook", "Untitled notebook");
    plain window_end_label = ("Older notes not shown.", "Older notes not shown.");
    plain window_end_verb = ("Show older", "Show older");
    plain write_a_line = ("Write a line first.", "Write a line first.");
    // Counted and templated sentences.
    counted notes_count = ("{n} note", "{n} notes");
    counted notes_count_more = ("{n}+ note", "{n}+ notes");
    plain checks_done = ("{done} of {total} done", "{done} of {total} done");
    plain edited_on = ("Edited {day}", "Edited {day}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strings::Locale;

    #[test]
    fn counts_pick_their_plural() {
        assert_eq!(notes_count(Locale::En, 1), "1 note");
        assert_eq!(notes_count(Locale::En, 12), "12 notes");
        assert_eq!(notes_count_more(Locale::En, 200), "200+ notes");
    }
}
