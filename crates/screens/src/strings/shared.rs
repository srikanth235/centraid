//! The kit's sentences, shared by every app's screens: civil words (weekdays,
//! months, Today), trash, autosave and search. The native kit's
//! fixed words (`KitWords`) are emitted from this file by
//! `contracts/tools/export-native-words.ts`. A lane that needs another shared
//! sentence adds it here in its own block.

catalog! {
    plain all_day = ("All day", "All day");
    plain autosave_changed_elsewhere = ("Changed on another device", "Changed on another device");
    plain autosave_edited = ("Edited", "Edited");
    plain autosave_not_saved = ("Not saved", "Not saved");
    plain autosave_saved = ("Saved", "Saved");
    plain autosave_saving = ("Saving…", "Saving…");
    plain back = ("Back", "Back");
    plain back_to = ("Back to {parent}", "Back to {parent}");
    plain kit_band_home = ("Home", "Home");
    plain kit_band_more = ("More", "More");
    plain kit_cancel = ("Cancel", "Cancel");
    plain kit_close_search = ("Close search", "Close search");
    plain kit_dismiss = ("Dismiss", "Dismiss");
    plain kit_done = ("Done", "Done");
    plain kit_loading_more = ("Loading more", "Loading more");
    plain kit_open = ("Open", "Open");
    plain kit_opening = ("Opening", "Opening");
    plain kit_pending = ("Saving", "Saving");
    plain kit_refresh = ("Refresh", "Refresh");
    plain kit_retry = ("Try again", "Try again");
    plain kit_save = ("Save", "Save");
    plain kit_search = ("Search", "Search");
    plain kit_select = ("Select", "Select");
    plain kit_show_more = ("Show more", "Show more");
    plain month_01 = ("January", "January");
    plain month_02 = ("February", "February");
    plain month_03 = ("March", "March");
    plain month_04 = ("April", "April");
    plain month_05 = ("May", "May");
    plain month_06 = ("June", "June");
    plain month_07 = ("July", "July");
    plain month_08 = ("August", "August");
    plain month_09 = ("September", "September");
    plain month_10 = ("October", "October");
    plain month_11 = ("November", "November");
    plain month_12 = ("December", "December");
    plain search_ask_about = ("Ask about “{term}”", "Ask about “{term}”");
    plain search_ask_question = ("Find {term}", "Find {term}");
    plain search_corrected = ("Including results for “{corrected}”", "Including results for “{corrected}”");
    plain search_kind_album = ("Album", "Album");
    plain search_kind_folder = ("Folder", "Folder");
    plain search_kind_notebook = ("Notebook", "Notebook");
    plain search_kind_project = ("Project", "Project");
    plain today = ("Today", "Today");
    plain tomorrow = ("Tomorrow", "Tomorrow");
    plain trash_deleted = ("Deleted", "Deleted");
    plain trash_empty_action = ("Empty trash", "Empty trash");
    plain trash_empty_body = ("Everything in trash leaves this vault for good. This cannot be undone.", "Everything in trash leaves this vault for good. This cannot be undone.");
    plain trash_empty_headline = ("Trash is empty.", "Trash is empty.");
    plain trash_empty_state_body = ("Deleted items wait here until emptied.", "Deleted items wait here until emptied.");
    plain trash_empty_title = ("Empty trash?", "Empty trash?");
    plain trash_purge = ("Delete forever", "Delete forever");
    plain trash_purge_body = ("It leaves this vault for good. This cannot be undone.", "It leaves this vault for good. This cannot be undone.");
    plain trash_purge_title = ("Delete this forever?", "Delete this forever?");
    plain trash_restore = ("Restore", "Restore");
    plain trash_title = ("Trash", "Trash");
    plain trash_untitled = ("Untitled", "Untitled");
    plain weekday_fri = ("Fri", "Fri");
    plain weekday_mon = ("Mon", "Mon");
    plain weekday_sat = ("Sat", "Sat");
    plain weekday_sun = ("Sun", "Sun");
    plain weekday_thu = ("Thu", "Thu");
    plain weekday_tue = ("Tue", "Tue");
    plain weekday_wed = ("Wed", "Wed");
    plain yesterday = ("Yesterday", "Yesterday");
    plain read_failed = ("Couldn't read this. Try again.", "Couldn't read this. Try again.");
    plain read_incomplete = ("Part of this didn't arrive. Try again.", "Part of this didn't arrive. Try again.");
    plain write_refused = ("That change wasn't saved.", "That change wasn't saved.");
}
