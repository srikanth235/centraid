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
    plain undone = ("Restore undone", "Restore undone");
}
