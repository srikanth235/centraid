//! WHAT THE PHONE SAYS THAT DIFFERS (#1183): `shell.phone-differences`, the fields of one followed
//! row that the member's edit holds apart from what the phone's store last stated.
//!
//! The vault derives it on each read (`centraid_vault::commands::follow::differences`): nothing is
//! stored here or there. The answer carries both values as the vault keeps them, as JSON text; the
//! detail screen of the kind words them (a number as the screen shows numbers, a distance in the
//! member's units) and draws the line, because only a detail screen says so. A row nothing
//! follows, a trashed one and one that agrees answer no fields.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::commands::follow;

use super::Answer;
use crate::error::Result;

/// `shell.phone-differences` for one entity.
pub(crate) fn differences(vault: &Vault, entity_id: &str) -> Result<Answer> {
    let found = vault.read(|connection| follow::differences(connection, entity_id))?;
    let text = |value: &serde_json::Value| value.to_string();
    Ok(Answer::FollowDifferences(wire::FollowDifferences {
        fields: found
            .into_iter()
            .map(|difference| wire::FollowDifference {
                field: difference.field,
                stated_json: text(&difference.stated),
                held_json: text(&difference.held),
                items: difference
                    .items
                    .into_iter()
                    .map(|item| wire::FollowItemDifference {
                        key: item.key,
                        stated_json: item.stated.as_ref().map(text),
                        held_json: item.held.as_ref().map(text),
                    })
                    .collect(),
            })
            .collect(),
    }))
}

/// `shell.origin-of` for one entity: its origin's system and label, both empty when the member
/// typed it. A Locker item's label is the file's name (the import records nothing else).
pub(crate) fn origin_of(vault: &Vault, entity_id: &str) -> Result<Answer> {
    let found = vault
        .read(|connection| centraid_vault::commands::arrival::origin_of(connection, entity_id))?;
    let (system, label) = found.unwrap_or_default();
    Ok(Answer::OriginOf(wire::OriginOf { system, label }))
}

#[cfg(test)]
mod origin_tests {
    use super::*;
    use crate::config::CoreConfig;
    use crate::handle::Core;

    fn say(vault: &Vault, id: &str) -> (String, String) {
        match origin_of(vault, id).expect("answers") {
            Answer::OriginOf(found) => (found.system, found.label),
            other => panic!("answered as {other:?}"),
        }
    }

    /// `shell.origin-of`: a typed item answers nothing, a one-shot arrival says its file (the
    /// followed stores' rows are read in the vault's own test).
    #[test]
    fn the_read_names_an_arrival_and_a_followed_store_and_is_empty_for_a_typed_item() {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a directory");
        let handle = Core::open(CoreConfig::new(dir.join("vault.db"))).expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Home", "Owner")?))
            .expect("it founds");
        let run = |name: &str, input: serde_json::Value| {
            let key = format!("origin-test-{name}-{}", input);
            let outcome = handle.command(name, &input, &key).expect("a command");
            assert_eq!(
                outcome.status,
                centraid_vault::CommandStatus::Executed,
                "{name}: {:?}",
                outcome.reason
            );
            outcome.output
        };
        let typed = run("task.add", serde_json::json!({ "title": "typed" }));
        let arrived = run(
            "task.add",
            serde_json::json!({ "title": "a", "arrived_system": "phone_reminders",
                                "arrived_label": "Groceries" }),
        );
        handle
            .with_vault(|vault| {
                let id_of = |output: &serde_json::Value| output["id"].as_str().unwrap().to_owned();
                assert_eq!(say(vault, &id_of(&typed)), (String::new(), String::new()));
                assert_eq!(
                    say(vault, &id_of(&arrived)),
                    ("phone_reminders".to_owned(), "Groceries".to_owned())
                );
                Ok(())
            })
            .expect("a vault");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
