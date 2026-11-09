//! Notes' fixed sentences. Every sentence a Notes screen shows is one of these; the ones with a hole in them
//! are filled with [`crate::strings::fill`].

catalog! {
    plain band_journal = ("Journal", "Journal");
    plain band_more = ("More", "More");
    plain band_notebooks = ("Notebooks", "Notebooks");
    plain band_notes = ("Notes", "Notes");
    plain body_placeholder = ("Write something", "Write something");
    plain cancel = ("Cancel", "Cancel");
    plain checklist = ("Checklist", "Checklist");
    plain checklist_checked = ("Checked", "Checked");
    plain checklist_unchecked = ("Not checked", "Not checked");
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
    plain domain_events = ("Calendar", "Calendar");
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
    plain about_chip = ("About · {subject}", "About · {subject}");
    plain filter_about_events = ("About events", "About events");
    plain filter_about_people = ("About people", "About people");
    plain filter_pinned = ("Pinned", "Pinned");
    plain filter_title = ("Show", "Show");
    plain history_empty_body = (
        "Versions appear here as the note changes.",
        "Versions appear here as the note changes."
    );
    plain history_empty_headline = ("No earlier versions", "No earlier versions");
    plain history_title = ("Version history", "Version history");
    plain home = ("Home", "Home");
    plain item_checked = ("Item checked", "Item checked");
    plain item_unchecked = ("Item unchecked", "Item unchecked");
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
    plain keyboard_hide = ("Hide keyboard", "Hide keyboard");
    plain link_label = ("Add link", "Add link");
    plain link_create = ("Create note", "Create note");
    plain link_restore = ("Restore", "Restore");
    plain link_missing = ("No note called {title}", "No note called {title}");
    plain link_missing_spoken = ("Missing note {title}", "Missing note {title}");
    plain link_note_spoken = ("Note {title}", "Note {title}");
    plain link_no_match_body = ("Nothing matches that search.", "Nothing matches that search.");
    plain link_search = ("Search everything", "Search everything");
    plain link_title = ("Link to", "Link to");
    plain link_trashed = ("{title} is in the trash", "{title} is in the trash");
    plain link_trashed_spoken = ("Note in trash {title}", "Note in trash {title}");
    plain link_web_spoken = ("Link {label}", "Link {label}");
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
    plain notebook_scope = ("Notebook {name}", "Notebook {name}");
    plain notebooks_empty_body = (
        "A notebook keeps related notes together.",
        "A notebook keeps related notes together."
    );
    plain notebooks_empty_headline = ("No notebooks yet", "No notebooks yet");
    plain notebooks_title = ("Notebooks", "Notebooks");
    plain pin = ("Pin", "Pin");
    plain powerbox_foot = (
        "Locker items link by name; their secrets stay locked.",
        "Locker items link by name; their secrets stay locked."
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
    plain send_to_agenda = ("Send to Reminders", "Send to Reminders");
    plain show_every_note = ("Show every note", "Show every note");
    plain sort_created = ("Date created", "Date created");
    plain sort_title = ("Sort notes", "Sort notes");
    plain sort_title_az = ("Title", "Title");
    plain sort_updated = ("Last edited", "Last edited");
    plain title = ("Notes", "Notes");
    plain title_placeholder = ("Title", "Title");
    plain trash_label = ("Trash", "Trash");
    plain more_export = ("Export", "Export");
    plain more_import = ("Import", "Import");
    plain transfer_choose_files_action = ("Choose files", "Choose files");
    plain transfer_choose_folder_action = ("Choose folder", "Choose folder");
    plain transfer_choose_again_action = ("Choose again", "Choose again");
    plain transfer_export_all = ("All notes", "All notes");
    plain transfer_export_done = ("Exported {n} notes", "Exported {n} notes");
    plain transfer_export_failed = ("Could not export", "Could not export");
    plain transfer_export_headline = ("Choose what to export", "Choose what to export");
    plain transfer_export_lede = (
        "Markdown files in one archive. Links stay as [[links]].",
        "Markdown files in one archive. Links stay as [[links]]."
    );
    plain transfer_export_title = ("Export notes", "Export notes");
    plain transfer_import_action = ("Import {n} notes", "Import {n} notes");
    plain transfer_import_done = ("Imported {n} notes", "Imported {n} notes");
    plain transfer_import_failed = ("Could not import", "Could not import");
    plain transfer_import_headline = ("Choose what to import", "Choose what to import");
    plain transfer_import_lede = (
        "Markdown or text files, or a folder. Links and tags come along.",
        "Markdown or text files, or a folder. Links and tags come along."
    );
    plain transfer_import_nothing = ("No notes in that choice", "No notes in that choice");
    plain transfer_import_ready = ("Ready to import", "Ready to import");
    plain transfer_import_title = ("Import notes", "Import notes");
    plain transfer_row_ignored = ("Not notes", "Not notes");
    plain transfer_row_links = ("Links", "Links");
    plain transfer_row_notebooks = ("Notebooks", "Notebooks");
    plain transfer_row_notes = ("Notes", "Notes");
    plain transfer_row_skipped = ("Already here", "Already here");
    plain transfer_row_tags = ("Tags", "Tags");
    plain transfer_row_unlinked = ("Links to nothing yet", "Links to nothing yet");
    plain unfiled_row = ("Unfiled", "Unfiled");
    plain undo = ("Undo", "Undo");
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
