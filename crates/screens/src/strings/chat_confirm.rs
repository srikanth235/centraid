//! The words on a Proposed change card's confirm button (#1173, `design/mockups/Chat`): the
//! button says what it will do ("Add reminder"), not a bare "Confirm". One verb word, one noun
//! for the kind of row, and the few verbs that read better as a phrase on their own. A card whose
//! steps disagree, or whose verb or kind this table lacks, keeps `chat::confirm`. The `group_` words are the kind's plural, the first half of the card's
//! second line ("Reminders · today, 10:45").

catalog! {
    plain verb_create = ("Add", "Add");
    plain verb_complete = ("Complete", "Complete");
    plain verb_reopen = ("Reopen", "Reopen");
    plain verb_reschedule = ("Reschedule", "Reschedule");
    plain verb_cancel = ("Cancel", "Cancel");
    plain verb_delete = ("Delete", "Delete");
    plain verb_restore = ("Restore", "Restore");
    plain verb_star = ("Star", "Star");
    plain verb_unstar = ("Unstar", "Unstar");
    plain verb_log = ("Log", "Log");
    plain verb_archive = ("Archive", "Archive");
    plain verb_unarchive = ("Unarchive", "Unarchive");
    plain phrase_tag = ("Add tag", "Add tag");
    plain phrase_untag = ("Remove tag", "Remove tag");
    plain phrase_unlink = ("Remove link", "Remove link");
    plain phrase_edit = ("Save changes", "Save changes");
    plain phrase_add_to = ("Add to list", "Add to list");
    plain phrase_remove_from = ("Remove from list", "Remove from list");
    plain phrase_undo = ("Undo", "Undo");
    plain noun_reminder = ("reminder", "reminder");
    plain noun_event = ("event", "event");
    plain noun_list = ("list", "list");
    plain noun_section = ("section", "section");
    plain noun_person = ("person", "person");
    plain noun_touch = ("touch", "touch");
    plain noun_note = ("note", "note");
    plain noun_notebook = ("notebook", "notebook");
    plain noun_document = ("document", "document");
    plain noun_folder = ("folder", "folder");
    plain noun_photo = ("photo", "photo");
    plain noun_album = ("album", "album");
    plain noun_transaction = ("transaction", "transaction");
    plain noun_account = ("account", "account");
    plain noun_category = ("category", "category");
    plain noun_rule = ("rule", "rule");
    plain noun_budget = ("budget", "budget");
    plain noun_metric = ("metric", "metric");
    plain noun_workout = ("workout", "workout");
    plain noun_item = ("item", "item");
    plain group_reminder = ("Reminders", "Reminders");
    plain group_event = ("Events", "Events");
    plain group_list = ("Lists", "Lists");
    plain group_section = ("Sections", "Sections");
    plain group_person = ("People", "People");
    plain group_touch = ("Touches", "Touches");
    plain group_note = ("Notes", "Notes");
    plain group_notebook = ("Notebooks", "Notebooks");
    plain group_document = ("Documents", "Documents");
    plain group_folder = ("Folders", "Folders");
    plain group_photo = ("Photos", "Photos");
    plain group_album = ("Albums", "Albums");
    plain group_transaction = ("Transactions", "Transactions");
    plain group_account = ("Accounts", "Accounts");
    plain group_category = ("Categories", "Categories");
    plain group_rule = ("Rules", "Rules");
    plain group_budget = ("Budgets", "Budgets");
    plain group_metric = ("Metrics", "Metrics");
    plain group_workout = ("Workouts", "Workouts");
    plain group_item = ("Items", "Items");
}
