//! THE TWO DOORS THAT WAIT ON A GATEWAY, as this screen asks them: forgetting a
//! gateway (it revokes this phone's token there before it answers) and a pass.
//! Neither is called inside `update`, which holds the runtime's lock: the shell
//! performs the request off the UI thread and the answer comes back as an event
//! carrying the tag below.

use centraid_api_proto::core_v1 as wire;
use prost::Message;

use super::rule::TransferRule;

/// The tag of a pass this screen asked for.
pub(super) const PASS: &str = "backup.pass";

/// The tag of a forget, naming the gateway so the answer finds its label.
pub(super) fn forget_tag(gateway_id: &str) -> String {
    format!("backup.forget:{gateway_id}")
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
    /// The pass ended, however it ended: the ledger says how it went.
    Pass,
}

/// The request that forgets `gateway_id`.
pub(super) fn forget_request(gateway_id: &str) -> wire::Request {
    wire::Request {
        kind: Some(wire::request::Kind::ForgetDestination(
            wire::ForgetDestinationRequest {
                gateway_id: gateway_id.to_owned(),
            },
        )),
    }
}

/// THE MEMBER TAPPED "BACK UP NOW": a snapshot now (`wants_snapshot`) and the
/// member's own tap (`asked`, the only thing that sets it: under MANUAL it is
/// what lets originals be sealed). The rule and the videos bit are the ones the
/// screen shows. **The link is not this screen's to know**: it sends what a shell
/// that cannot tell sends (metered, not charging), the conservative reading, and
/// the pass service refines it from the platform's own answer.
pub(super) fn pass_request(rule: TransferRule, include_videos: bool) -> wire::Request {
    wire::Request {
        kind: Some(wire::request::Kind::Drain(wire::DrainRequest {
            deadline_ms: 0,
            rule: rule.to_wire() as i32,
            metered: true,
            charging: false,
            wants_snapshot: true,
            exclude_videos: !include_videos,
            asked: true,
        })),
    }
}

/// The effect that performs `request` off the UI thread.
pub(super) fn call(request: &wire::Request) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::CoreCall(wire::CoreCall {
            request: request.encode_to_vec(),
        })),
    }
}

/// What a finished call means for the forget it was for.
pub(super) fn forgot(gateway_id: &str, called: &wire::CoreCalled) -> Done {
    let answer = wire::Response::decode(called.response.as_slice())
        .ok()
        .and_then(|response| match response.kind {
            Some(wire::response::Kind::ForgetDestination(answer)) => Some(answer),
            _ => None,
        });
    Done::Forgot {
        gateway_id: gateway_id.to_owned(),
        // NO ANSWER (no core, or a refusal) IS NOT FORGOTTEN.
        forgotten: answer.as_ref().is_some_and(|answer| answer.forgotten),
        revoked: answer.as_ref().is_some_and(|answer| answer.revoked),
    }
}
