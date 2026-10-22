//! HOW AN EXECUTED ACTION IS TAKEN BACK (#1135).
//!
//! Undo is a second action, not a rollback: the commit stays in the journal
//! and a new one reverses it. This table names, per app, the action that
//! reverses another and where the reversing input comes from. An action with no
//! row has no inverse — a purge, an import, a merge, an edit whose prior state
//! the input does not carry.
//!
//! The table is data held to the manifests by the tests below: every action it
//! names exists, and the inverse input it builds satisfies the inverse
//! action's required properties.

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
}

type Row = (&'static str, &'static str, Input);

/// `(action, its inverse, where the inverse's input comes from)`.
const TASKS: &[Row] = &[
    ("add", "delete", Input::Created),
    ("complete", "reopen", Input::Id),
    ("reopen", "complete", Input::Id),
    ("cancel", "reopen", Input::Id),
    ("delete", "restore", Input::Id),
    ("restore", "delete", Input::Id),
    ("create-project", "delete", Input::Created),
    ("create-section", "delete", Input::Created),
    ("attach", "detach", Input::Same),
    ("detach", "attach", Input::Same),
    ("add-tag", "remove-tag", Input::Same),
    ("remove-tag", "add-tag", Input::Same),
];
const AGENDA: &[Row] = &[
    ("propose", "cancel-event", Input::Created),
    ("attach", "detach", Input::Same),
    ("detach", "attach", Input::Same),
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
];
const LOCKER: &[Row] = &[
    ("add-item", "trash-item", Input::Created),
    ("duplicate-item", "trash-item", Input::Created),
    ("trash-item", "restore-item", Input::Id),
    ("restore-item", "trash-item", Input::Id),
    ("star-item", "unstar-item", Input::Same),
    ("unstar-item", "star-item", Input::Same),
    ("archive-item", "unarchive-item", Input::Same),
    ("unarchive-item", "archive-item", Input::Same),
    ("add-tag", "remove-tag", Input::Same),
    ("remove-tag", "add-tag", Input::Same),
];
const MONEY: &[Row] = &[
    ("close-account", "reopen-account", Input::Same),
    ("reopen-account", "close-account", Input::Same),
    ("add-rule", "delete-rule", Input::Created),
    ("link-transfer", "unlink-transfer", Input::Id),
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
];
const PEOPLE: &[Row] = &[
    ("add-person", "trash-person", Input::Created),
    ("trash-person", "restore-person", Input::Id),
    ("restore-person", "trash-person", Input::Id),
    ("star-person", "unstar-person", Input::Same),
    ("unstar-person", "star-person", Input::Same),
    ("complete-task", "reopen-task", Input::Id),
    ("reopen-task", "complete-task", Input::Id),
    ("create-list", "delete-list", Input::Created),
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
    ("add-to-album", "remove-from-album", Input::Same),
    ("remove-from-album", "add-to-album", Input::Same),
    ("tag-photo", "untag-photo", Input::Same),
    ("untag-photo", "tag-photo", Input::Same),
];

fn rows(app: &str) -> &'static [Row] {
    match app {
        "tasks" => TASKS,
        "agenda" => AGENDA,
        "docs" => DOCS,
        "locker" => LOCKER,
        "money" => MONEY,
        "notes" => NOTES,
        "people" => PEOPLE,
        "photos" => PHOTOS,
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
    let (_, inverse, from) = rows(app).iter().find(|row| row.0 == action)?;
    let built = match from {
        Input::Same => input.clone(),
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
                let back = manifest
                    .action(inverse)
                    .unwrap_or_else(|| panic!("{}.{inverse} is not in its manifest", app.id));
                let required: Vec<&str> = back.input["required"]
                    .as_array()
                    .map(|names| names.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                match from {
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

    #[test]
    fn the_input_comes_from_the_shell_or_the_commands_output() {
        let minted: Map<String, Value> =
            serde_json::from_str(r#"{"id":"t1","title":"x"}"#).unwrap();
        let (action, input) = of("tasks", "add", &minted, &Value::Null).expect("undoable");
        assert_eq!(
            (action, Value::Object(input)),
            ("delete", serde_json::json!({"id":"t1"}))
        );

        let unminted: Map<String, Value> = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        let output = serde_json::json!({"id":"made"});
        let (_, input) = of("tasks", "add", &unminted, &output).expect("undoable");
        assert_eq!(Value::Object(input), serde_json::json!({"id":"made"}));
        assert!(of("tasks", "add", &unminted, &Value::Null).is_none());

        let flag: Map<String, Value> =
            serde_json::from_str(r#"{"id":"i","flag":"starred"}"#).unwrap();
        let (action, input) = of("locker", "star-item", &flag, &Value::Null).expect("undoable");
        assert_eq!(action, "unstar-item");
        assert_eq!(Value::Object(input), Value::Object(flag));

        assert!(of("tasks", "purge", &minted, &Value::Null).is_none());
        assert!(of("health", "delete-workout", &minted, &Value::Null).is_none());
    }
}
