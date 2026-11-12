//! EARLIER VERSIONS (#1185), once for every detail screen that keeps them: the entry's label, the
//! screen's words, and who a change came from, in the member's words (a phone, a folder, Apple
//! Health, a statement), never the transport's. "Restore", "Undo" and "Show more" are the kit's
//! (`strings::shared`).

catalog! {
    plain current = ("Current", "Current");
    plain empty_body = (
        "When this {noun} changes, what it was is kept here.",
        "When this {noun} changes, what it was is kept here."
    );
    plain empty_headline = ("Nothing earlier yet", "Nothing earlier yet");
    plain entry_label = ("Earlier versions", "Earlier versions");
    plain entry_spoken = ("Earlier versions, {n}", "Earlier versions, {n}");
    plain entry_unread_status = (
        "Couldn’t read the earlier versions.",
        "Couldn’t read the earlier versions."
    );
    plain from_folder = ("From the folder", "From the folder");
    plain from_health = ("From Apple Health", "From Apple Health");
    plain from_import = ("From an import", "From an import");
    plain from_phone = ("From your phone", "From your phone");
    plain from_statement = ("From a statement", "From a statement");
    plain other_details = ("Other details", "Other details");
    plain reveal = ("Reveal", "Reveal");
    plain conceal = ("Conceal", "Conceal");
    plain secret_hidden = ("{label}, hidden", "{label}, hidden");
    plain secret_revealed = ("{label}, revealed", "{label}, revealed");
    plain restored = ("Earlier version restored", "Earlier version restored");
    plain restored_already = ("Already how it is now", "Already how it is now");
    plain title = ("Earlier versions", "Earlier versions");
    plain not_tagged = ("Without {tags}", "Without {tags}");
    plain flag_starred = ("Starred", "Starred");
    plain flag_pinned = ("Pinned", "Pinned");
    plain flag_archived = ("Archived", "Archived");
    plain flag_not_starred = ("Not starred", "Not starred");
    plain flag_not_pinned = ("Not pinned", "Not pinned");
    plain flag_not_archived = ("Not archived", "Not archived");
    plain in_list = ("In {names}", "In {names}");
    plain not_in_list = ("Not in {names}", "Not in {names}");
    plain linked_to = ("Linked to {names}", "Linked to {names}");
    plain not_linked_to = ("Not linked to {names}", "Not linked to {names}");
    plain about_names = ("About {names}", "About {names}");
    plain not_about_names = ("Not about {names}", "Not about {names}");
    plain shows_names = ("Shows {names}", "Shows {names}");
    plain not_shows_names = ("Does not show {names}", "Does not show {names}");
    plain item_gone = ("an item that is gone", "an item that is gone");
    plain preview_title = ("Earlier version", "Earlier version");
    plain preview_as_it_was = ("As it was on {when}", "As it was on {when}");
    plain preview_as_it_was_undated = ("As it was earlier", "As it was earlier");
    plain preview_changed = ("Changed on {when} to {line}", "Changed on {when} to {line}");
    plain preview_changed_undated = ("Changed to {line}", "Changed to {line}");
    plain preview_changed_on = ("Changed on {when}", "Changed on {when}");
    plain preview_note = ("Read only. Nothing changes until you restore it.", "Read only. Nothing changes until you restore it.");
    plain preview_restore = ("Restore this version", "Restore this version");
    plain preview_close = ("Close", "Close");
    plain preview_spoken = ("Earlier version, {headline}. {note}", "Earlier version, {headline}. {note}");
}
