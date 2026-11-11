//! THE GENERAL LINK, READ (#1185): `shell.links` and `shell.link-candidates`, the two reads behind
//! every screen's "Linked to" section and its picker.
//!
//! The vault answers both (`centraid_vault::links`); nothing is stored here. They are the shell's
//! because a link joins an item of one app to an item of another, so no one app's manifest owns
//! them, and every app's screen reads the same two.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::links;

use super::Answer;
use crate::error::Result;

/// `shell.links` for one entity.
pub(crate) fn linked(vault: &Vault, entity_id: &str) -> Result<Answer> {
    let rows = vault.read(|connection| links::linked(connection, entity_id))?;
    Ok(Answer::LinkedItems(wire::LinkedItems {
        items: rows
            .into_iter()
            .map(|row| wire::LinkedItem {
                id: row.id,
                kind: row.key.to_owned(),
                title: row.title,
                is_owner: row.is_owner,
                in_text: row.in_text,
            })
            .collect(),
    }))
}

/// `shell.link-candidates`: the items of `kind` the term finds, `limit` at most.
pub(crate) fn candidates(vault: &Vault, kind: &str, term: &str, limit: usize) -> Result<Answer> {
    let rows = vault.read(|connection| links::candidates(connection, kind, term, limit))?;
    Ok(Answer::LinkCandidates(wire::LinkCandidates {
        candidates: rows
            .into_iter()
            .map(|row| wire::LinkCandidate {
                id: row.id,
                title: row.title,
                is_owner: row.is_owner,
            })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_vault::commands::Registry;
    use centraid_vault::{Command, CommandStatus, Principal};

    fn run(vault: &Vault, name: &str, input: serde_json::Value) -> serde_json::Value {
        let registry = Registry::with_system_commands().expect("the registry builds");
        let ran = vault
            .execute(
                &registry,
                &Principal::owner("test-device"),
                &Command::new(name, input),
            )
            .expect("the command is answered");
        assert_eq!(
            ran.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            ran.reason
        );
        ran.output
    }

    /// A LINK MADE ON A NOTE IS READ ON THE TASK IT POINTS AT, and the picker finds it by a typed
    /// term, never offering a Locker item.
    #[test]
    fn a_link_is_read_from_both_ends_and_the_picker_never_offers_a_locker_item() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let id = |output: serde_json::Value| output["id"].as_str().expect("an id").to_owned();
        let note = id(run(
            &vault,
            "note.create",
            serde_json::json!({"title": "Trip", "body": "pack"}),
        ));
        let task = id(run(
            &vault,
            "task.add",
            serde_json::json!({"title": "Book flight"}),
        ));
        run(
            &vault,
            "edge.add",
            serde_json::json!({"from": note, "rel": "links", "to": task}),
        );
        run(
            &vault,
            "locker.add_item",
            serde_json::json!({"item_id": "lk1", "type": "login", "title": "Flight login"}),
        );
        let Answer::LinkedItems(on_task) = linked(&vault, &task).expect("reads") else {
            panic!("linked items");
        };
        assert_eq!(on_task.items.len(), 1);
        assert_eq!(
            (on_task.items[0].id.as_str(), on_task.items[0].kind.as_str()),
            (note.as_str(), "note")
        );
        let Answer::LinkCandidates(found) = candidates(&vault, "task", "flig", 10).expect("reads")
        else {
            panic!("candidates");
        };
        assert_eq!(found.candidates.len(), 1);
        let Answer::LinkCandidates(none) =
            candidates(&vault, "locker_item", "flight", 10).expect("reads")
        else {
            panic!("candidates");
        };
        assert!(none.candidates.is_empty(), "never a Locker item");
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
