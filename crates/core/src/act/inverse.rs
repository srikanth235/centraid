//! HOW AN EXECUTED ACTION IS TAKEN BACK (#1135).
//!
//! Undo is a second action, not a rollback: the commit stays in the vault
//! and a new one reverses it. This table names, per app, the action that
//! reverses another and where the reversing input comes from. An action with no
//! row has no inverse — a purge, an import, a merge, an edit whose prior state
//! the input does not carry.
//!
//! The table is data held to the manifests by the tests below: every action it
//! names exists, and the inverse input it builds satisfies the inverse
//! action's required properties.
//!
//! # EVERY ACTION IS TAKEN BACK, OR ASKS FIRST (#1185)
//!
//! An action of a manifest is in exactly one of three places, and a test over every manifest
//! holds it (the promise register's Undo row reads the same two files):
//!
//! 1. a row here: another action reverses it (`Same`, `Id`, `Created`), or the vault's history
//!    puts the record back as it was (`Earlier`);
//! 2. `"confirmation": "required"` in its manifest: it cannot be taken back, so the member is
//!    asked first (a purge, an empty trash, a merge);
//! 3. `"writes_nothing": true` in its manifest: it changes nothing in the vault, so there is
//!    nothing to take back (an export). The core's tests run each such action and read the
//!    commit's census, so the claim cannot be made falsely.
//!
//! The manifest's `inverse` and this table are one list: the table says HOW (where the input
//! comes from), the manifest says WHICH action, and a test fails when they differ.
//!
//! # `Earlier`: THE RECORD GOES BACK TO WHAT IT WAS BEFORE THIS ACT
//!
//! The vault keeps every record's earlier state ([`centraid_vault::history`]). An edit of one
//! record is taken back by `undo-change {id, seq}`, which names the version THIS act made, and
//! the vault refuses it when a newer version exists (the record changed again since): the later
//! change is never lost to an old Undo. Whether an act made a version is not a list of names: the
//! core asks the vault how many versions the record held before and after the command and offers
//! the Undo only when exactly one more exists. An act the history does not capture (a tag, a
//! star, a link, a bank-stated column) makes no version and so offers nothing; it is never given
//! this inverse by a row.

use serde_json::{Map, Value};

/// Where the reversing action's input comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Input {
    /// The same input, verbatim: a flag set and cleared, a tag added and
    /// removed, an edge added and removed.
    Same,
    /// Only the target: `{id}`, from the input's `id`.
    Id,
    /// The id of what the action created: the input's own `id` (or Locker's
    /// `item_id`) when one was stated, else the one in the command's output.
    Created,
    /// The record's own earlier version: `undo-change {id, seq}` with the `seq` of the version
    /// this act made (see the module note). The row's inverse is `undo-change`, or the action
    /// itself where chat takes it back by running it again with the values it replaced.
    Earlier,
    /// The same action again, with the values it replaced: the command answers them under
    /// `replaced` (`{"replaced": {"color": "blue"}}`) and each one overwrites the input's value of
    /// the same name. For a change the history does not keep (a label's colour is not a record).
    /// Offered only when the command named every value it replaced.
    Replaced,
    /// The id of what the action created, which the command answers under the named output key
    /// (`interaction_id`, `note_id`): the input's own `id` is the person it was about, so it is
    /// never read. Taken back by the shell's `undo-create`.
    CreatedAs(&'static str),
    /// An act that creates something on one path (the output names it under the key) and edits
    /// one record on the other, as a date does (a birthday is the person's own column; any other
    /// is an event made about them): the created one by the trash, the edited one by the version
    /// it made.
    CreatedElseEarlier(&'static str),
    /// A use of a secret (Locker's `reveal`): the owner check is the ask, the action stamps the
    /// item as used and changes nothing a version holds, so nothing is offered to take back.
    /// The manifest names the action as its own inverse only so chat runs it as a direct action
    /// (an action with no inverse is a card), which is what the row records.
    Asks,
    /// The same action again with each value the command says it replaced under `replaced`,
    /// `null` included: a person who was in no list is moved back out of the one they were filed
    /// in by a move to `null`.
    Prior,
    /// A relationship made between two people, taken back by `remove-relationship` naming the
    /// same two people and the same label.
    Related,
    /// A pass over a phone's store, taken back by disconnecting it: the shell's owner ruling that
    /// connecting a store is undone by disconnecting it, and the rows the pass brought stay. The
    /// inverse is the app's `stop-following` for the named system with the pass's own
    /// `origin.ref`; a call that names no origin (the health follower's day totals) offers none.
    Stops(&'static str),
    /// The id of what the action created, with fixed fields beside it: a category has no trash, so
    /// taking its creation back archives it (`{id, flag: "archived"}`).
    CreatedWith(&'static str, &'static str),
    /// A transfer ended (`unlink-transfer`), which answers the other half under `replaced`:
    /// linked again by `link-transfer {id, other_id}`.
    Relinks,
    /// A figure set by hand (`measurement.log`), whose command answers the value it replaced under
    /// `replaced`, `null` when the day held none. Taken back by the figure that was there, or by
    /// `clear-figure` when there was none.
    Figure,
    /// A figure cleared (`measurement.clear`), which answers the value it removed under
    /// `replaced`: taken back by logging that value for the same day and metric.
    Cleared,
}

/// The shell action that puts a record back to a named earlier version. Any app's act can run it.
pub(crate) const UNDO_CHANGE: &str = "undo-change";

type Row = (&'static str, &'static str, Input);

/// `(action, its inverse, where the inverse's input comes from)`.
#[rustfmt::skip]
const CALENDAR: &[Row] = &[
    ("propose", "cancel-event", Input::Created),
    ("trash-event", "restore-event", Input::Id),
    ("restore-event", "trash-event", Input::Id),
    ("attach", "detach", Input::Same),
    ("detach", "attach", Input::Same),
    ("rsvp", "rsvp", Input::Earlier),
    ("edit-event", "edit-event", Input::Earlier),
    ("edit-occurrence", "undo-change", Input::Earlier),
    ("cancel-event", "edit-event", Input::Earlier),
    ("rename-calendar", "rename-calendar", Input::Earlier),
    ("style-calendar", "style-calendar", Input::Earlier),
    ("add-place", "undo-create", Input::Created),
    // A calendar is a holder: taking its creation back moves it, and its events, to the trash.
    ("create-calendar", "undo-create", Input::Created),
    ("follow-calendar", "stop-following", Input::Stops("calendar")),
];

const REMINDERS: &[Row] = &[
    ("attach", "detach", Input::Same),
    ("detach", "attach", Input::Same),
    ("add-task", "delete-task", Input::Created),
    ("star-task", "unstar-task", Input::Same),
    ("unstar-task", "star-task", Input::Same),
    ("complete-task", "reopen-task", Input::Id),
    ("reopen-task", "complete-task", Input::Id),
    ("cancel-task", "reopen-task", Input::Id),
    ("delete-task", "restore-task", Input::Id),
    ("restore-task", "delete-task", Input::Id),
    ("create-project", "delete-task", Input::Created),
    ("create-section", "delete-task", Input::Created),
    ("add-task-tag", "remove-task-tag", Input::Same),
    ("remove-task-tag", "add-task-tag", Input::Same),
    ("edit-task", "edit-task", Input::Earlier),
    ("organize-task", "organize-task", Input::Earlier),
    ("rename-list", "rename-list", Input::Earlier),
    ("style-container", "style-container", Input::Earlier),
];
const DOCS: &[Row] = &[
    ("upload", "trash", Input::Created),
    ("create-text", "trash", Input::Created),
    ("create-folder", "delete-folder", Input::Created),
    ("trash", "restore", Input::Id),
    ("delete-folder", "restore", Input::Id),
    ("restore", "trash", Input::Id),
    ("star", "unstar", Input::Same),
    ("unstar", "star", Input::Same),
    ("tag", "untag", Input::Same),
    ("untag", "tag", Input::Same),
    ("add-about", "remove-about", Input::Same),
    ("remove-about", "add-about", Input::Same),
    ("rename", "rename", Input::Earlier),
    ("move", "move", Input::Earlier),
    ("rename-folder", "rename-folder", Input::Earlier),
    ("edit", "undo-change", Input::Earlier),
    ("replace", "undo-change", Input::Earlier),
    ("restore-version", "undo-change", Input::Earlier),
    ("recolor-label", "recolor-label", Input::Replaced),
];
const LOCKER: &[Row] = &[
    ("add-item", "trash-item", Input::Created),
    ("duplicate-item", "undo-create", Input::CreatedAs("item_id")),
    ("trash-item", "restore-item", Input::Id),
    ("restore-item", "trash-item", Input::Id),
    ("star-item", "unstar-item", Input::Same),
    ("unstar-item", "star-item", Input::Same),
    ("archive-item", "unarchive-item", Input::Same),
    ("unarchive-item", "archive-item", Input::Same),
    ("add-tag", "remove-tag", Input::Same),
    ("remove-tag", "add-tag", Input::Same),
    ("add-link", "remove-link", Input::Same),
    ("remove-link", "add-link", Input::Same),
    // A reveal changes nothing a version holds and asks first: see [`Input::Asks`].
    ("reveal", "reveal", Input::Asks),
    // Every edit of the item, secrets included, is taken back by the version it made: the vault
    // keeps a changed password, card number, CVV, note, seed, sealed field and passkey key as the
    // ciphertext they were, so the Undo of a password change puts the old SEALED value back
    // (#1185). A reveal or a copy is not in this table: it asks first (the owner check).
    ("edit-item", "edit-item", Input::Earlier),
    ("set-field", "undo-change", Input::Earlier),
    ("remove-field", "undo-change", Input::Earlier),
    ("set-addresses", "undo-change", Input::Earlier),
    ("set-memo", "undo-change", Input::Earlier),
    ("set-passkey", "undo-change", Input::Earlier),
    ("clear-passkey", "undo-change", Input::Earlier),
];
const HEALTH: &[Row] = &[
    // The follow pass writes the store's day totals and its workouts, and is taken back by
    // disconnecting the store. A day total names no origin, so it offers none of its own.
    ("record-days", "stop-following", Input::Stops("health")),
    ("follow-workouts", "stop-following", Input::Stops("health")),
    ("edit-workout", "edit-workout", Input::Earlier),
    ("edit-figure", "edit-figure", Input::Figure),
    ("log-figure", "clear-figure", Input::Figure),
    ("clear-figure", "log-figure", Input::Cleared),
    ("log-workout", "delete-workout", Input::Created),
    ("delete-workout", "restore-workout", Input::Id),
    ("restore-workout", "delete-workout", Input::Id),
];
/// Money. A statement import is taken back by nothing and asks first (the Import screen previews
/// the lines and the statement balance, and writes on the tap), as does the balance it records.
/// A line's category is taken back by filing the lines it changed under the one they held (when
/// they held one), a plan, a rule, a saved layout and an ended transfer by the values the command
/// answers it replaced: none of them is a record the history keeps. A category has no trash, so
/// its creation is taken back by archiving it, and a new account by closing it (the same flag):
/// the chat prompt is pinned to `create` being a direct act, which the shell's `undo-create` as
/// its inverse would turn into a card.
#[rustfmt::skip]
const MONEY: &[Row] = &[
    ("add-account", "close-account", Input::CreatedWith("flag", "archived")),
    ("edit-account", "edit-account", Input::Earlier),
    ("set-display-name", "set-display-name", Input::Earlier),
    ("categorize", "categorize", Input::Prior),
    ("save-import-profile", "save-import-profile", Input::Prior),
    ("unlink-transfer", "link-transfer", Input::Relinks),
    ("set-target", "set-target", Input::Prior),
    ("set-carry", "set-carry", Input::Prior),
    ("edit-rule", "edit-rule", Input::Prior),
    ("add-category", "archive-category", Input::CreatedWith("flag", "archived")),
    ("archive-category", "unarchive-category", Input::Same),
    ("unarchive-category", "archive-category", Input::Same),
    ("close-account", "reopen-account", Input::Same),
    ("reopen-account", "close-account", Input::Same),
    ("add-rule", "delete-rule", Input::Created),
    ("link-transfer", "unlink-transfer", Input::Id),
    ("add-with", "remove-with", Input::Same),
    ("remove-with", "add-with", Input::Same),
    ("trash-transaction", "restore-transaction", Input::Id),
    ("restore-transaction", "trash-transaction", Input::Id),
];
const NOTES: &[Row] = &[
    ("create-note", "delete-note", Input::Created),
    ("create-notebook", "delete-notebook", Input::Created),
    ("delete-note", "restore-note", Input::Id),
    ("delete-notebook", "restore-note", Input::Id),
    ("restore-note", "delete-note", Input::Id),
    ("flag-note", "unflag-note", Input::Same),
    ("unflag-note", "flag-note", Input::Same),
    ("link", "detach", Input::Same),
    ("attach", "detach", Input::Same),
    ("detach", "attach", Input::Same),
    ("add-tag", "remove-tag", Input::Same),
    ("remove-tag", "add-tag", Input::Same),
    ("edit-note", "edit-note", Input::Earlier),
    ("move-note", "move-note", Input::Earlier),
    ("rename-notebook", "rename-notebook", Input::Earlier),
    ("restore-note-version", "undo-change", Input::Earlier),
    ("send-to-tasks", "undo-create", Input::Created),
];
/// People. A person's edit is taken back by the version it made. What is made about a person (a
/// touch, a note, a task, a gift, a journal line, a date) is its own entity and goes to the trash
/// by the shell's `undo-create` under the key its command answers it by. A list's move is the
/// same move with the list it replaced; a list's delete is its restore. A relationship is an edge,
/// which is no record's state (the history leaves `related` outside), so its Undo is removing that
/// edge. A contact channel is a child row of the person, which the history keeps on the person.
#[rustfmt::skip]
const PEOPLE: &[Row] = &[
    ("add-person", "trash-person", Input::Created),
    ("trash-person", "restore-person", Input::Id),
    ("restore-person", "trash-person", Input::Id),
    ("star-person", "unstar-person", Input::Same),
    ("unstar-person", "star-person", Input::Same),
    ("complete-task", "undo-change", Input::Earlier),
    ("reopen-task", "undo-change", Input::Earlier),
    ("create-list", "delete-list", Input::Created),
    ("edit-person", "edit-person", Input::Earlier),
    ("set-cadence", "set-cadence", Input::Earlier),
    ("log-interaction", "undo-create", Input::CreatedAs("interaction_id")),
    ("move-person", "move-person", Input::Prior),
    ("add-note", "undo-create", Input::CreatedAs("note_id")),
    ("add-task", "undo-create", Input::CreatedAs("task_id")),
    ("add-gift", "undo-create", Input::CreatedAs("task_id")),
    ("add-important-date", "undo-create", Input::CreatedElseEarlier("date_id")),
    ("set-reminder", "set-reminder", Input::Earlier),
    ("add-relationship", "remove-relationship", Input::Related),
    ("rename-list", "rename-list", Input::Earlier),
    ("add-journal-entry", "undo-create", Input::CreatedAs("entry_id")),
    ("save-contact-channel", "save-contact-channel", Input::Earlier),
    ("follow-contacts", "stop-following", Input::Stops("contacts")),
];
const PHOTOS: &[Row] = &[
    ("upload", "delete-photo", Input::Created),
    ("create-album", "delete-album", Input::Created),
    ("delete-photo", "restore-photo", Input::Id),
    ("restore-photo", "delete-photo", Input::Id),
    ("delete-album", "restore-album", Input::Id),
    ("restore-album", "delete-album", Input::Id),
    ("flag-photo", "unflag-photo", Input::Same),
    ("unflag-photo", "flag-photo", Input::Same),
    ("archive-photo", "unarchive-photo", Input::Same),
    ("unarchive-photo", "archive-photo", Input::Same),
    ("add-to-album", "remove-from-album", Input::Same),
    ("remove-from-album", "add-to-album", Input::Same),
    ("tag-photo", "untag-photo", Input::Same),
    ("untag-photo", "tag-photo", Input::Same),
    ("add-person", "remove-person", Input::Same),
    ("remove-person", "add-person", Input::Same),
    ("edit-photo", "undo-change", Input::Earlier),
    ("retitle-photo", "retitle-photo", Input::Earlier),
    ("rename-album", "rename-album", Input::Earlier),
    ("set-album-cover", "undo-change", Input::Earlier),
    ("set-place", "undo-change", Input::Earlier),
    ("name-place", "undo-change", Input::Earlier),
];

fn rows(app: &str) -> &'static [Row] {
    match app {
        "calendar" => CALENDAR,
        "docs" => DOCS,
        "health" => HEALTH,
        "locker" => LOCKER,
        "money" => MONEY,
        "notes" => NOTES,
        "people" => PEOPLE,
        "photos" => PHOTOS,
        "reminders" => REMINDERS,
        _ => &[],
    }
}

/// The action and input that take back `action` run with `input`, which
/// answered `output`; `None` when it has no inverse or the input to build one
/// is not there.
pub(crate) fn of(
    app: &str,
    action: &str,
    input: &Map<String, Value>,
    output: &Value,
) -> Option<(&'static str, Map<String, Value>)> {
    let (name, inverse, from) = rows(app).iter().find(|row| row.0 == action)?;
    let mut inverse = *inverse;
    let built = match from {
        Input::Same => input.clone(),
        Input::Earlier | Input::Asks => return None,
        Input::CreatedElseEarlier(key) | Input::CreatedAs(key) => {
            id_only(output.get(*key).filter(|id| id.is_string())?)?
        }
        Input::Prior => {
            let replaced = output.get("replaced")?.as_object()?;
            let mut again = input.clone();
            for (name, value) in replaced {
                again.insert(name.clone(), value.clone());
            }
            again
        }
        Input::Related => {
            let mut back = Map::new();
            back.insert("from".to_owned(), input.get("id")?.clone());
            back.insert("rel".to_owned(), Value::String("related".to_owned()));
            back.insert("to".to_owned(), output.get("related_id")?.clone());
            back.insert("label".to_owned(), input.get("kind")?.clone());
            back
        }
        Input::CreatedWith(key, value) => {
            let mut back = Map::new();
            back.insert(
                "id".to_owned(),
                output.get("id").filter(|id| id.is_string())?.clone(),
            );
            back.insert((*key).to_owned(), Value::String((*value).to_owned()));
            back
        }
        Input::Relinks => {
            let mut back = Map::new();
            back.insert("id".to_owned(), input.get("id")?.clone());
            back.insert(
                "other_id".to_owned(),
                output.get("replaced")?.get("other_id")?.clone(),
            );
            back
        }
        Input::Stops(system) => {
            let mut stop = Map::new();
            stop.insert("system".to_owned(), Value::String((*system).to_owned()));
            stop.insert("ref".to_owned(), input.get("origin")?.get("ref")?.clone());
            stop
        }
        Input::Figure => {
            let replaced = output.get("replaced")?;
            let mut again = Map::new();
            if let Some(person) = input.get("person_id") {
                again.insert("person_id".to_owned(), person.clone());
            }
            again.insert("day".to_owned(), output.get("day")?.clone());
            again.insert("metric".to_owned(), output.get("metric")?.clone());
            if replaced.is_null() {
                inverse = "clear-figure";
            } else {
                // The figure that was there comes back under the action that replaced it.
                inverse = name;
                again.insert("value".to_owned(), replaced.clone());
            }
            again
        }
        Input::Cleared => {
            let mut again = Map::new();
            if let Some(person) = input.get("person_id") {
                again.insert("person_id".to_owned(), person.clone());
            }
            again.insert("day".to_owned(), output.get("day")?.clone());
            again.insert("metric".to_owned(), output.get("metric")?.clone());
            again.insert("value".to_owned(), output.get("replaced")?.clone());
            again
        }
        Input::Replaced => {
            let replaced = output.get("replaced")?.as_object()?;
            let mut again = input.clone();
            for (name, value) in replaced {
                if value.is_null() || !again.contains_key(name) {
                    return None;
                }
                again.insert(name.clone(), value.clone());
            }
            (!replaced.is_empty()).then_some(again)?
        }
        Input::Id => id_only(input.get("id")?)?,
        Input::Created => id_only(
            input
                .get("id")
                .or_else(|| input.get("item_id"))
                .filter(|id| id.is_string())
                .or_else(|| output.get("id"))
                .or_else(|| output.get("item_id"))?,
        )?,
    };
    Some((inverse, built))
}

/// Whether the action is taken back by the record's earlier version (an `Earlier` row).
pub(crate) fn is_earlier(app: &str, action: &str) -> bool {
    rows(app).iter().any(|row| {
        row.0 == action && matches!(row.2, Input::Earlier | Input::CreatedElseEarlier(_))
    })
}

/// The Undo of an act that made version `seq` of record `id`.
pub(crate) fn earlier(id: &str, seq: u32) -> (&'static str, Map<String, Value>) {
    let mut input = Map::new();
    input.insert("id".to_owned(), Value::String(id.to_owned()));
    input.insert("seq".to_owned(), Value::from(seq));
    (UNDO_CHANGE, input)
}

fn id_only(id: &Value) -> Option<Map<String, Value>> {
    id.is_string().then(|| {
        let mut only = Map::new();
        only.insert("id".to_owned(), id.clone());
        only
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::APPS;

    #[test]
    fn every_row_names_real_actions_and_an_input_the_inverse_can_take() {
        for app in APPS {
            let manifest = app.manifest();
            for (action, inverse, from) in rows(app.id) {
                let forward = manifest
                    .action(action)
                    .unwrap_or_else(|| panic!("{}.{action} is not in its manifest", app.id));
                if centraid_apps_kit::manifest::SHELL_UNDOS.contains(inverse) {
                    assert!(
                        crate::shell::manifest().action(inverse).is_some(),
                        "the shell does not carry {inverse}"
                    );
                    continue;
                }
                let back = manifest
                    .action(inverse)
                    .unwrap_or_else(|| panic!("{}.{inverse} is not in its manifest", app.id));
                let required: Vec<&str> = back.input["required"]
                    .as_array()
                    .map(|names| names.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                match from {
                    // The action again, `undo-change`, or the edit the manifest names for the same
                    // record (a cancelled event is put back by an edit of its status).
                    Input::Earlier => {}
                    Input::Replaced => assert_eq!(
                        action, inverse,
                        "{}.{action}: a replaced-values undo is the action run again",
                        app.id
                    ),
                    Input::Prior => assert_eq!(
                        action, inverse,
                        "{}.{action}: a prior-values undo is the action run again",
                        app.id
                    ),
                    Input::Related => {
                        assert_eq!(*inverse, "remove-relationship");
                        for name in ["from", "rel", "to", "label"] {
                            assert!(
                                back.input["properties"]
                                    .as_object()
                                    .is_some_and(|offered| offered.contains_key(name)),
                                "{}.{inverse} does not take `{name}`",
                                app.id
                            );
                        }
                    }
                    Input::CreatedWith(key, _) => {
                        for name in ["id", *key] {
                            assert!(
                                back.input["properties"]
                                    .as_object()
                                    .is_some_and(|offered| offered.contains_key(name)),
                                "{}.{inverse} does not take `{name}`",
                                app.id
                            );
                        }
                        assert!(
                            required.iter().all(|name| ["id", *key].contains(name)),
                            "{}.{inverse} needs more than the id and `{key}`",
                            app.id
                        );
                    }
                    Input::Relinks => {
                        assert_eq!(required, ["id", "other_id"], "{}.{inverse}", app.id);
                    }
                    Input::Stops(_) => {
                        for name in ["system", "ref"] {
                            assert!(
                                back.input["properties"]
                                    .as_object()
                                    .is_some_and(|offered| offered.contains_key(name)),
                                "{}.{inverse} does not take `{name}`",
                                app.id
                            );
                        }
                    }
                    Input::Figure => assert!(
                        action == inverse || *inverse == "clear-figure",
                        "{}.{action}: a figure is put back by itself or cleared",
                        app.id
                    ),
                    Input::Cleared => assert_eq!(*inverse, "log-figure"),
                    Input::Asks => assert_eq!(
                        action, inverse,
                        "{}.{action}: a use names itself so chat runs it directly",
                        app.id
                    ),
                    Input::CreatedAs(_) | Input::CreatedElseEarlier(_) => {
                        unreachable!("{}.{action}: these are the shell's undo-create", app.id)
                    }
                    Input::Id | Input::Created => assert_eq!(
                        required,
                        ["id"],
                        "{}.{inverse} takes more than an id to undo {action}",
                        app.id
                    ),
                    Input::Same => {
                        let offered = forward.input["properties"]
                            .as_object()
                            .expect("an input object");
                        for name in required {
                            assert!(
                                offered.contains_key(name),
                                "{}.{inverse} needs `{name}` and {action} does not carry it",
                                app.id
                            );
                        }
                    }
                }
            }
        }
    }

    /// THE MANIFEST AND THE TABLE SAY ONE THING: an action chat runs and the table reverses is the
    /// action its manifest names as its inverse, and every inverse a manifest names is an action of
    /// it. The chat's undo reads the manifest's; a screen's toast reads this table's. A card is the
    /// member's to finish and chat never takes it back, so the table may reverse what the manifest
    /// names no inverse for (a section made on a screen).
    #[test]
    fn the_table_reverses_by_the_action_the_manifest_names() {
        use centraid_apps_kit::manifest::ChatSurface;
        for app in APPS {
            let manifest = app.manifest();
            for (action, inverse, _) in rows(app.id) {
                let entry = manifest
                    .action(action)
                    .unwrap_or_else(|| panic!("{}.{action} is not in its manifest", app.id));
                let declared = entry.inverse.as_deref();
                assert!(
                    declared == Some(*inverse)
                        || (declared.is_none() && entry.surface() == ChatSurface::Card),
                    "{}.{action}: the table reverses it with `{inverse}`, its manifest names {declared:?}",
                    app.id
                );
            }
            for entry in &manifest.actions {
                if let Some(inverse) = &entry.inverse {
                    assert!(
                        centraid_apps_kit::manifest::SHELL_UNDOS.contains(&inverse.as_str())
                            || manifest.action(inverse).is_some(),
                        "{}.{}",
                        app.id,
                        entry.name
                    );
                }
            }
        }
    }

    /// The apps whose Undo row of the promise register (`cargo xtask rules`) is still Owed: the
    /// two checks below hold for every other app, and an app leaves this list in the change that
    /// takes its row to Kept.
    const OWED: &[&str] = &[];

    /// Single actions still owed in an app whose other actions are held to the check below.
    const OWED_ACTIONS: &[(&str, &str)] = &[];

    /// EVERY ACTION IS TAKEN BACK, ASKS FIRST, OR WRITES NOTHING, AND THE TWO LISTS ARE ONE.
    ///
    /// The register's part A and B (`crates/xtask/src/promises.rs`), held here too so `cargo test`
    /// fails where the register does: an action has a row, or `confirmation: "required"`, or
    /// `writes_nothing`; and the inverse its manifest names is exactly the row's.
    #[test]
    fn every_action_has_a_row_asks_first_or_writes_nothing_and_the_manifest_agrees() {
        use centraid_apps_kit::manifest::Confirmation;
        for app in APPS.iter().filter(|app| !OWED.contains(&app.id)) {
            for entry in &app.manifest().actions {
                if OWED_ACTIONS.contains(&(app.id, entry.name.as_str())) {
                    continue;
                }
                let row = rows(app.id).iter().find(|row| row.0 == entry.name);
                assert!(
                    row.is_some()
                        || entry.confirmation == Confirmation::Required
                        || entry.writes_nothing,
                    "{}.{} is not taken back, does not ask first and does not say it writes nothing",
                    app.id,
                    entry.name
                );
                assert_eq!(
                    row.map(|row| row.1),
                    entry.inverse.as_deref(),
                    "{}.{}: the table and the manifest name different inverses",
                    app.id,
                    entry.name
                );
                assert!(
                    !(entry.writes_nothing && row.is_some()),
                    "{}.{} writes nothing and so has nothing to take back",
                    app.id,
                    entry.name
                );
            }
        }
    }

    /// A task made from a note (a composite the assistant runs as two steps) is taken back by the
    /// shell's `undo-create`, naming the id the command answered.
    #[test]
    fn a_task_made_from_a_note_is_taken_back_by_the_shells_trash() {
        let input: Map<String, Value> =
            serde_json::from_str(r#"{"title":"x","note_id":"n1"}"#).unwrap();
        let output = serde_json::json!({"id":"made"});
        let (action, built) = of("notes", "send-to-tasks", &input, &output).expect("undoable");
        assert_eq!(
            (action, Value::Object(built)),
            ("undo-create", serde_json::json!({"id":"made"}))
        );
    }

    #[test]
    fn the_input_comes_from_the_shell_or_the_commands_output() {
        let minted: Map<String, Value> =
            serde_json::from_str(r#"{"id":"t1","title":"x"}"#).unwrap();
        let (action, input) = of("reminders", "add-task", &minted, &Value::Null).expect("undoable");
        assert_eq!(
            (action, Value::Object(input)),
            ("delete-task", serde_json::json!({"id":"t1"}))
        );

        let unminted: Map<String, Value> = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        let output = serde_json::json!({"id":"made"});
        let (_, input) = of("reminders", "add-task", &unminted, &output).expect("undoable");
        assert_eq!(Value::Object(input), serde_json::json!({"id":"made"}));
        assert!(of("reminders", "add-task", &unminted, &Value::Null).is_none());

        let flag: Map<String, Value> =
            serde_json::from_str(r#"{"id":"i","flag":"starred"}"#).unwrap();
        let (action, input) = of("locker", "star-item", &flag, &Value::Null).expect("undoable");
        assert_eq!(action, "unstar-item");
        assert_eq!(Value::Object(input), Value::Object(flag));

        assert!(of("reminders", "purge-task", &minted, &Value::Null).is_none());
        let (action, _) = of("health", "delete-workout", &minted, &Value::Null).expect("undoable");
        assert_eq!(action, "restore-workout");
    }
}
