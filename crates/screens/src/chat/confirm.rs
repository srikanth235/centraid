//! The confirm button's own words (#1173): "Add reminder", "Delete note", not "Confirm". The
//! label is read off the steps the core parked: when every step is the same verb on the same
//! kind of row it names both; when they share only the verb it names the verb; anything else, and
//! a verb or kind this table lacks, keeps the generic "Confirm".

use crate::strings::{Locale, chat as generic, chat_confirm as words};

/// The runtime verbs the table knows (`assist.proto`'s `AssistPendingStep.verb`), as the static
/// key a step carries. Empty for a verb it does not know.
pub(super) fn verb_of(verb: &str) -> &'static str {
    match verb {
        "create" => "create",
        "complete" => "complete",
        "reopen" => "reopen",
        "reschedule" => "reschedule",
        "cancel" => "cancel",
        "delete" => "delete",
        "restore" => "restore",
        "star" => "star",
        "unstar" => "unstar",
        "log" => "log",
        "edit" => "edit",
        "add_to" => "add_to",
        "remove_from" => "remove_from",
        "undo" => "undo",
        "tag" => "tag",
        "untag" => "untag",
        "unlink" => "unlink",
        "archive" => "archive",
        "unarchive" => "unarchive",
        _ => "",
    }
}

/// The kind of row a step changes, as the noun key the member reads it by. A task is a reminder
/// (the Agenda board's word for it). Empty for a kind the table lacks.
pub(super) fn noun_of(kind: &str) -> &'static str {
    match kind {
        "task" | "reminder" => "reminder",
        "event" => "event",
        "project" | "list" => "list",
        "section" => "section",
        "person" | "contact" | "people" => "person",
        "touch" => "touch",
        "note" => "note",
        "notebook" => "notebook",
        "doc" | "document" | "file" => "document",
        "folder" => "folder",
        "photo" | "asset" => "photo",
        "album" => "album",
        "transaction" => "transaction",
        "account" => "account",
        "category" => "category",
        "rule" => "rule",
        "budget" => "budget",
        "metric" => "metric",
        "workout" => "workout",
        "item" | "secret" => "item",
        _ => "",
    }
}

fn noun(key: &str, locale: Locale) -> Option<String> {
    Some(match key {
        "reminder" => words::noun_reminder(locale),
        "event" => words::noun_event(locale),
        "list" => words::noun_list(locale),
        "section" => words::noun_section(locale),
        "person" => words::noun_person(locale),
        "touch" => words::noun_touch(locale),
        "note" => words::noun_note(locale),
        "notebook" => words::noun_notebook(locale),
        "document" => words::noun_document(locale),
        "folder" => words::noun_folder(locale),
        "photo" => words::noun_photo(locale),
        "album" => words::noun_album(locale),
        "transaction" => words::noun_transaction(locale),
        "account" => words::noun_account(locale),
        "category" => words::noun_category(locale),
        "rule" => words::noun_rule(locale),
        "budget" => words::noun_budget(locale),
        "metric" => words::noun_metric(locale),
        "workout" => words::noun_workout(locale),
        "item" => words::noun_item(locale),
        _ => return None,
    })
}

/// The verb alone, or the phrase a verb reads as on its own (`edit` is "Save changes").
enum Say {
    Verb(String),
    Phrase(String),
}

fn say(verb: &str, locale: Locale) -> Option<Say> {
    Some(match verb {
        "create" => Say::Verb(words::verb_create(locale)),
        "complete" => Say::Verb(words::verb_complete(locale)),
        "reopen" => Say::Verb(words::verb_reopen(locale)),
        "reschedule" => Say::Verb(words::verb_reschedule(locale)),
        "cancel" => Say::Verb(words::verb_cancel(locale)),
        "delete" => Say::Verb(words::verb_delete(locale)),
        "restore" => Say::Verb(words::verb_restore(locale)),
        "star" => Say::Verb(words::verb_star(locale)),
        "unstar" => Say::Verb(words::verb_unstar(locale)),
        "log" => Say::Verb(words::verb_log(locale)),
        "archive" => Say::Verb(words::verb_archive(locale)),
        "unarchive" => Say::Verb(words::verb_unarchive(locale)),
        "tag" => Say::Phrase(words::phrase_tag(locale)),
        "untag" => Say::Phrase(words::phrase_untag(locale)),
        "unlink" => Say::Phrase(words::phrase_unlink(locale)),
        "edit" => Say::Phrase(words::phrase_edit(locale)),
        "add_to" => Say::Phrase(words::phrase_add_to(locale)),
        "remove_from" => Say::Phrase(words::phrase_remove_from(locale)),
        "undo" => Say::Phrase(words::phrase_undo(locale)),
        _ => return None,
    })
}

/// The label for a card whose steps are `(verb, noun)` pairs, each a key from [`verb_of`] and
/// [`noun_of`] (empty when unknown).
pub(super) fn label<'a>(
    steps: impl IntoIterator<Item = (&'a str, &'a str)>,
    locale: Locale,
) -> String {
    let mut steps = steps.into_iter();
    let Some((verb, first_noun)) = steps.next() else {
        return generic::confirm(locale);
    };
    let mut noun_key = first_noun;
    for (next_verb, next_noun) in steps {
        if next_verb != verb {
            return generic::confirm(locale);
        }
        if next_noun != noun_key {
            noun_key = "";
        }
    }
    match say(verb, locale) {
        Some(Say::Phrase(phrase)) => phrase,
        Some(Say::Verb(word)) => match noun(noun_key, locale) {
            Some(noun) => format!("{word} {noun}"),
            None => word,
        },
        None => generic::confirm(locale),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    fn of(steps: &[(&str, &str)]) -> String {
        label(
            steps
                .iter()
                .map(|(verb, kind)| (verb_of(verb), noun_of(kind)))
                .collect::<Vec<_>>(),
            EN,
        )
    }

    #[test]
    fn one_verb_on_one_kind_names_both() {
        assert_eq!(of(&[("create", "task")]), "Add reminder");
        assert_eq!(of(&[("complete", "task")]), "Complete reminder");
        assert_eq!(of(&[("delete", "note")]), "Delete note");
        assert_eq!(of(&[("cancel", "event")]), "Cancel event");
        assert_eq!(of(&[("restore", "doc")]), "Restore document");
        assert_eq!(of(&[("log", "touch")]), "Log touch");
    }

    #[test]
    fn many_rows_of_the_same_verb_and_kind_say_the_same_thing() {
        assert_eq!(
            of(&[
                ("complete", "task"),
                ("complete", "reminder"),
                ("complete", "task")
            ]),
            "Complete reminder"
        );
    }

    #[test]
    fn rows_of_different_kinds_keep_the_verb_alone() {
        assert_eq!(of(&[("delete", "task"), ("delete", "event")]), "Delete");
        assert_eq!(of(&[("create", "gadget")]), "Add");
    }

    #[test]
    fn verbs_that_read_as_a_phrase_ignore_the_kind() {
        assert_eq!(of(&[("edit", "task")]), "Save changes");
        assert_eq!(of(&[("add_to", "task")]), "Add to list");
        assert_eq!(of(&[("remove_from", "task")]), "Remove from list");
        assert_eq!(of(&[("undo", "")]), "Undo");
    }

    #[test]
    fn a_card_that_mixes_verbs_or_names_an_unknown_one_keeps_confirm() {
        assert_eq!(of(&[("complete", "task"), ("delete", "task")]), "Confirm");
        assert_eq!(of(&[("teleport", "task")]), "Confirm");
        assert_eq!(of(&[]), "Confirm");
    }

    #[test]
    fn every_verb_the_runtime_has_makes_a_label_that_is_not_confirm() {
        // The runtime's own list, so a verb added there without a label here fails this test.
        // `reveal` is never parked on the phone (the Locker is off), so it has no card.
        let verbs: Vec<&str> = centraid_assist::native::meta::VERBS
            .iter()
            .map(|spec| spec.name)
            .filter(|name| *name != "reveal")
            .collect();
        assert!(!verbs.is_empty());
        for verb in verbs {
            assert_ne!(verb_of(verb), "", "{verb} has no key in the label table");
            assert_ne!(of(&[(verb, "task")]), "Confirm", "{verb}");
        }
    }

    #[test]
    fn every_noun_key_is_spoken() {
        for kind in [
            "task",
            "event",
            "project",
            "section",
            "person",
            "touch",
            "note",
            "notebook",
            "doc",
            "folder",
            "photo",
            "album",
            "transaction",
            "account",
            "category",
            "rule",
            "budget",
            "metric",
            "workout",
            "item",
        ] {
            assert!(noun(noun_of(kind), EN).is_some(), "{kind}");
        }
    }
}
