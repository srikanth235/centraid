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
