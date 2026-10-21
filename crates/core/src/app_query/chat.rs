//! THE CHAT'S ARM OF THE APP QUERY (R-CHAT-1): the thread list, one thread, and
//! whether a card's row is still there.
//!
//! **Not served until the chat lane lands** ([#1135](https://github.com/srikanth235/centraid/issues/1135),
//! lane 7): a conversation is a `thread` entity and its `message`s now, written
//! by `thread.*` commands that lane writes, and the readers over them come with
//! them. The arms answer a typed "not yet available" rather than an empty list,
//! because an empty history reads as a conversation that was never had.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;

use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

fn not_yet() -> CoreError {
    CoreError::NotYetAvailable {
        what: "the chat history",
        lands_in: "the chat lane of #1135",
    }
}

pub(super) fn threads(
    _vault: &Vault,
    _door: &super::VaultDoor<'_>,
    _asked: &wire::ChatThreadsRequest,
) -> Result<Answer> {
    Err(not_yet())
}

pub(super) fn thread(_vault: &Vault, _asked: &wire::ChatThreadRequest) -> Result<Answer> {
    Err(not_yet())
}

pub(super) fn card(_vault: &Vault, _asked: &wire::ChatCardRequest) -> Result<Answer> {
    Err(not_yet())
}

/// A stored refusal word as the plane's reason. The words are the schema's
/// CHECK list, so a word this does not know is a build that is older than its
/// file, and it reads as the generic failure rather than as nothing.
#[expect(
    dead_code,
    reason = "the chat lane reads history again (#1135, lane 7)"
)]
pub(crate) fn refusal_of(word: &str) -> wire::AssistRefusalReason {
    use wire::AssistRefusalReason as R;
    match word {
        "no_tool_fits" => R::NoToolFits,
        "query_failed" => R::QueryFailed,
        "unparsable" => R::Unparsable,
        "model_absent" => R::ModelAbsent,
        "model_failed" => R::ModelFailed,
        "vision_absent" => R::VisionAbsent,
        "attachment_unsupported" => R::AttachmentUnsupported,
        "attachment_unreadable" => R::AttachmentUnreadable,
        "attachment_too_large" => R::AttachmentTooLarge,
        _ => R::Unspecified,
    }
}

/// A stored outcome word as the wire's. The words are the schema's CHECK list (a proposal's five
/// beside the three a told answer has), so a word this does not know is a build that is older than its
/// file, and it reads as unspecified rather than as one of the others.
#[expect(
    dead_code,
    reason = "the chat lane reads history again (#1135, lane 7)"
)]
pub(crate) fn outcome_of(word: &str) -> wire::ChatStoredOutcome {
    use wire::ChatStoredOutcome as O;
    match word {
        "sent" => O::Sent,
        "answered" => O::Answered,
        "stopped" => O::Stopped,
        "refused" => O::Refused,
        "proposed" => O::Proposed,
        "applied" => O::Applied,
        "dismissed" => O::Dismissed,
        "stale" => O::Stale,
        "failed" => O::Failed,
        _ => O::Unspecified,
    }
}
