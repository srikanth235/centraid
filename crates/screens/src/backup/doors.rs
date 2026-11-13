//! THE DOOR THAT WAITS ON A GATEWAY, as this screen asks it: forgetting a gateway (it revokes
//! this phone's token there before it answers). It is not called inside `update`, which holds the
//! runtime's lock: it runs off-thread (`Ctx::vault_async`) and its answer comes back as an
//! `OffThreadDone` carrying the tag below. **A pass is not this screen's door**: "Back up now" is
//! asked of the pass conductor (`crate::passes`), which runs every pass.

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;
use prost::Message;

const FORGET: &str = "backup.forget:";
const UNDO: &str = "backup.undo:";

/// The tag of a forget, naming the gateway so the answer finds its label.
pub(super) fn forget_tag(gateway_id: &str) -> String {
    format!("{FORGET}{gateway_id}")
}

/// The tag of an undo, naming the gateway so the answer finds its label.
pub(super) fn undo_tag(gateway_id: &str) -> String {
    format!("{UNDO}{gateway_id}")
}

/// What a door came back with.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Done {
    /// The ledger dropped the gateway (or held none by that id), and whether the
    /// gateway confirmed this phone's token opens nothing there any more.
    Forgot {
        gateway_id: String,
        forgotten: bool,
        revoked: bool,
    },
    /// The deletes a gateway was holding were lifted (`restored` names), or the door did not
    /// answer (`None`): the signed undo reached nobody, so nothing is claimed.
    Undid {
        gateway_id: String,
        restored: Option<u32>,
    },
}

/// The request that forgets `gateway_id`.
pub(super) fn forget_request(gateway_id: &str) -> VaultRequest {
    VaultRequest::ForgetDestination(wire::ForgetDestinationRequest {
        gateway_id: gateway_id.to_owned(),
    })
}

/// The request that lifts every delete `gateway_id` is holding for this vault.
pub(super) fn undo_request(gateway_id: &str) -> VaultRequest {
    VaultRequest::UndoHeld(wire::UndoHeldRequest {
        gateway_id: gateway_id.to_owned(),
    })
}

/// What a finished job means: the tag it was asked under and the bytes it came
/// back with (an encoded `VaultCalled`). `None` for a tag this screen did not
/// ask.
pub(super) fn done(tag: &str, bytes: &[u8]) -> Option<Done> {
    let response = wire::VaultCalled::decode(bytes)
        .ok()
        .filter(|called| called.error.is_none())
        .and_then(|called| wire::Response::decode(called.response.as_slice()).ok());
    if let Some(gateway_id) = tag.strip_prefix(UNDO) {
        return Some(Done::Undid {
            gateway_id: gateway_id.to_owned(),
            restored: response.and_then(|response| match response.kind {
                Some(wire::response::Kind::UndoHeld(answer)) => Some(answer.restored),
                _ => None,
            }),
        });
    }
    let gateway_id = tag.strip_prefix(FORGET)?;
    let answer = response.and_then(|response| match response.kind {
        Some(wire::response::Kind::ForgetDestination(answer)) => Some(answer),
        _ => None,
    });
    Some(Done::Forgot {
        gateway_id: gateway_id.to_owned(),
        // NO ANSWER (no core, or a refusal) IS NOT FORGOTTEN.
        forgotten: answer.as_ref().is_some_and(|answer| answer.forgotten),
        revoked: answer.as_ref().is_some_and(|answer| answer.revoked),
    })
}
