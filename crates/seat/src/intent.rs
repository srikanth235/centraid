//! The intent grammar: three vocabularies, kept distinct (D-1020-D2-1).
//!
//! v0 spelled all three as TypeScript string unions, and the compiler could
//! not tell `"queued"` the seat's state from `"queued"` the gateway's status.
//! They are three closed sets owned by three different parties:
//!
//! - [`IntentState`] — **ten** values. The seat's own bookkeeping. `sending` is
//!   a fact about this seat's socket, and `conflict-base-missing` is its own
//!   verdict rather than a flavour of `conflict` because the remedy differs:
//!   a version mismatch is re-read-and-retry, a missing base is "the row you
//!   were editing is gone".
//! - [`GatewayStatus`] — **seven** values, what `replica_intent_outcome.status`
//!   holds. No `awaiting-change`, no `expired`, no `conflict-base-missing`:
//!   those are things a seat concludes, not things a ledger records.
//! - [`OutcomeStatus`] — **five** values, what an *answer* may say. An answer
//!   can never say `queued` or `sending`, because by the time there is an
//!   answer the gateway is no longer queuing.
//!
//! [`OVERLAY_STATES`] is nine of the ten — everything but `executed`. An
//! overlay is this seat's optimistic paint over the mirrored rows, and
//! `executed` is precisely the state in which the real rows have arrived.

use crate::error::{Result, SeatError};

/// The seat's own state for one queued write. Ten values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IntentState {
    Queued,
    Sending,
    /// Executed on the gateway, and this seat has not yet applied the commit
    /// the effect landed in. The overlay must stay until it has, or the screen
    /// flickers back to the pre-edit value for one frame.
    AwaitingChange,
    Parked,
    Executed,
    Denied,
    Conflict,
    /// The base row is gone, not merely at a different version.
    ConflictBaseMissing,
    Expired,
    Failed,
}

impl IntentState {
    /// The wire and column spelling. v0's, because the `CHECK` constraint is.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Sending => "sending",
            Self::AwaitingChange => "awaiting-change",
            Self::Parked => "parked",
            Self::Executed => "executed",
            Self::Denied => "denied",
            Self::Conflict => "conflict",
            Self::ConflictBaseMissing => "conflict-base-missing",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }

    /// Parse one. An unknown value is refused rather than defaulted: a state
    /// this build does not know is a file written by a build that did, and
    /// guessing at it would either replay a settled intent or drop a queued
    /// one.
    pub fn parse(text: &str) -> Result<Self> {
        ALL_STATES
            .iter()
            .copied()
            .find(|state| state.as_str() == text)
            .ok_or_else(|| SeatError::Invariant {
                context: format!("`{text}` is not one of the ten intent states"),
            })
    }

    /// Whether this state still paints an overlay over the mirrored rows.
    #[must_use]
    pub fn holds_overlay(self) -> bool {
        OVERLAY_STATES.contains(&self)
    }

    /// Whether this state is owed the member's attention.
    ///
    /// `expired` and `parked` are retained but NOT actionable: a parked intent
    /// is waiting on somebody else's decision and an expired one is waiting on
    /// nothing, so neither is a button the member can press.
    #[must_use]
    pub fn retained_attention(self) -> bool {
        matches!(
            self,
            Self::Denied
                | Self::Failed
                | Self::Conflict
                | Self::ConflictBaseMissing
                | Self::Expired
                | Self::Parked
        )
    }

    /// Attention the member can act on now.
    #[must_use]
    pub fn actionable_attention(self) -> bool {
        self.retained_attention() && !matches!(self, Self::Expired | Self::Parked)
    }

    /// Whether the outbox may stop tracking this intent.
    ///
    /// `awaiting-change` is deliberately NOT terminal: the gateway is done and
    /// this seat is not.
    #[must_use]
    pub fn is_settled(self) -> bool {
        matches!(self, Self::Executed)
    }

    /// Whether a retry could ever change this answer. The chain's `NEVER` set.
    #[must_use]
    pub fn never_retried(self) -> bool {
        matches!(self, Self::Denied | Self::Expired)
    }
}

/// All ten, in declaration order.
pub const ALL_STATES: [IntentState; 10] = [
    IntentState::Queued,
    IntentState::Sending,
    IntentState::AwaitingChange,
    IntentState::Parked,
    IntentState::Executed,
    IntentState::Denied,
    IntentState::Conflict,
    IntentState::ConflictBaseMissing,
    IntentState::Expired,
    IntentState::Failed,
];

/// The nine states that still paint an overlay: everything but `executed`.
pub const OVERLAY_STATES: [IntentState; 9] = [
    IntentState::Queued,
    IntentState::Sending,
    IntentState::AwaitingChange,
    IntentState::Parked,
    IntentState::Denied,
    IntentState::Conflict,
    IntentState::ConflictBaseMissing,
    IntentState::Expired,
    IntentState::Failed,
];

/// Whatever the gateway's ledger holds. Seven values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayStatus {
    Queued,
    Sending,
    Parked,
    Executed,
    Denied,
    Failed,
    Conflict,
}

impl GatewayStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Sending => "sending",
            Self::Parked => "parked",
            Self::Executed => "executed",
            Self::Denied => "denied",
            Self::Failed => "failed",
            Self::Conflict => "conflict",
        }
    }

    pub fn parse(text: &str) -> Result<Self> {
        GATEWAY_STATUSES
            .iter()
            .copied()
            .find(|status| status.as_str() == text)
            .ok_or_else(|| SeatError::Invariant {
                context: format!("`{text}` is not one of the seven gateway statuses"),
            })
    }

    /// The gateway's own terminal set: four of the seven.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Executed | Self::Denied | Self::Failed | Self::Conflict
        )
    }
}

/// All seven.
pub const GATEWAY_STATUSES: [GatewayStatus; 7] = [
    GatewayStatus::Queued,
    GatewayStatus::Sending,
    GatewayStatus::Parked,
    GatewayStatus::Executed,
    GatewayStatus::Denied,
    GatewayStatus::Failed,
    GatewayStatus::Conflict,
];

/// What an ANSWER may say. Five values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeStatus {
    Executed,
    Parked,
    Denied,
    Failed,
    Conflict,
}

impl OutcomeStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Executed => "executed",
            Self::Parked => "parked",
            Self::Denied => "denied",
            Self::Failed => "failed",
            Self::Conflict => "conflict",
        }
    }

    /// An answer's status from the gateway's, refusing the two that cannot be
    /// answers.
    ///
    /// `queued` and `sending` are the gateway saying "I have not decided", and
    /// a seat that treated them as an answer would settle an intent whose
    /// effect has not happened.
    pub fn from_gateway(status: GatewayStatus) -> Result<Self> {
        Ok(match status {
            GatewayStatus::Executed => Self::Executed,
            GatewayStatus::Parked => Self::Parked,
            GatewayStatus::Denied => Self::Denied,
            GatewayStatus::Failed => Self::Failed,
            GatewayStatus::Conflict => Self::Conflict,
            GatewayStatus::Queued | GatewayStatus::Sending => {
                return Err(SeatError::Invariant {
                    context: format!(
                        "`{}` is a gateway status and never an answer",
                        status.as_str()
                    ),
                });
            }
        })
    }
}

/// All five.
pub const OUTCOME_STATUSES: [OutcomeStatus; 5] = [
    OutcomeStatus::Executed,
    OutcomeStatus::Parked,
    OutcomeStatus::Denied,
    OutcomeStatus::Failed,
    OutcomeStatus::Conflict,
];

/// Who a parked intent is waiting on. `Intent`'s label is the PREDECESSOR'S
/// intent id — the only name a seat can match against its own outbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitingOnSeat {
    Owner,
    Origin,
    Gateway,
    Intent,
}

impl WaitingOnSeat {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Origin => "origin",
            Self::Gateway => "gateway",
            Self::Intent => "intent",
        }
    }
}

/// One wait.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitingOn {
    pub seat: WaitingOnSeat,
    pub label: String,
}

/// One row of the outbox, with everything a verdict and a chain need.
#[derive(Debug, Clone, PartialEq)]
pub struct IntentRecord {
    pub intent_id: String,
    pub created_order: i64,
    pub app_id: String,
    pub action: String,
    pub input: serde_json::Value,
    pub payload_hash: String,
    pub state: IntentState,
    pub attempts: i64,
    pub depends_on: Vec<String>,
    pub base_versions: Vec<centraid_vault::intents::BaseVersion>,
    /// The seat's optimistic paint, as `(table, pk-json)` → image.
    pub optimistic: Option<serde_json::Value>,
    /// The commit the gateway says the effect landed in.
    pub commit_seq: Option<i64>,
    pub waiting_on: Vec<WaitingOn>,
    pub needs_blobs: Vec<String>,
    pub enqueued_at: String,
    pub updated_at: String,
    /// The owner-facing sentence, on a refusal.
    pub reason: Option<String>,
    pub conflicts: Vec<crate::occ::Conflict>,
    pub online_only: bool,
}

/// What the gateway's answer says this seat's state becomes.
///
/// The one place the two vocabularies meet, and the split of `conflict` by
/// "is the base missing" is here rather than at each call site because a
/// remedy chosen per screen is a remedy that differs per screen.
#[must_use]
pub fn intent_verdict(status: OutcomeStatus, conflict_base_is_missing: bool) -> IntentState {
    match status {
        OutcomeStatus::Executed => IntentState::Executed,
        OutcomeStatus::Parked => IntentState::Parked,
        OutcomeStatus::Denied => IntentState::Denied,
        OutcomeStatus::Failed => IntentState::Failed,
        OutcomeStatus::Conflict if conflict_base_is_missing => IntentState::ConflictBaseMissing,
        OutcomeStatus::Conflict => IntentState::Conflict,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_vocabularies_are_ten_seven_and_five_wide() {
        assert_eq!(ALL_STATES.len(), 10);
        assert_eq!(GATEWAY_STATUSES.len(), 7);
        assert_eq!(OUTCOME_STATUSES.len(), 5);
        // And they are DISTINCT sets, not three views of one. The seat knows
        // three states no gateway status spells.
        for state in [
            IntentState::AwaitingChange,
            IntentState::ConflictBaseMissing,
            IntentState::Expired,
        ] {
            assert!(
                !GATEWAY_STATUSES
                    .iter()
                    .any(|status| status.as_str() == state.as_str()),
                "`{}` leaked into the gateway's vocabulary",
                state.as_str()
            );
        }
    }

    #[test]
    fn the_overlay_set_is_every_state_but_executed() {
        assert_eq!(OVERLAY_STATES.len(), 9);
        for state in ALL_STATES {
            assert_eq!(
                state.holds_overlay(),
                state != IntentState::Executed,
                "`{}` disagrees",
                state.as_str()
            );
        }
    }

    #[test]
    fn every_state_round_trips_through_its_spelling() {
        for state in ALL_STATES {
            assert_eq!(
                IntentState::parse(state.as_str()).expect("it parses"),
                state
            );
        }
        assert!(IntentState::parse("settled").is_err());
    }

    #[test]
    fn an_answer_can_never_say_queued_or_sending() {
        for status in GATEWAY_STATUSES {
            let answer = OutcomeStatus::from_gateway(status);
            assert_eq!(
                answer.is_ok(),
                status.is_terminal() || status == GatewayStatus::Parked,
                "`{}` disagrees",
                status.as_str()
            );
        }
        assert!(OutcomeStatus::from_gateway(GatewayStatus::Queued).is_err());
    }

    #[test]
    fn a_conflict_splits_on_whether_the_base_is_missing() {
        assert_eq!(
            intent_verdict(OutcomeStatus::Conflict, false),
            IntentState::Conflict
        );
        assert_eq!(
            intent_verdict(OutcomeStatus::Conflict, true),
            IntentState::ConflictBaseMissing
        );
        // Every other status ignores the flag: a missing base is meaningless
        // for an answer that is not a conflict.
        for status in [
            OutcomeStatus::Executed,
            OutcomeStatus::Parked,
            OutcomeStatus::Denied,
            OutcomeStatus::Failed,
        ] {
            assert_eq!(
                intent_verdict(status, true),
                intent_verdict(status, false),
                "`{}` reads the flag",
                status.as_str()
            );
        }
    }

    #[test]
    fn parked_and_expired_are_retained_but_not_actionable() {
        assert!(IntentState::Parked.retained_attention());
        assert!(!IntentState::Parked.actionable_attention());
        assert!(IntentState::Expired.retained_attention());
        assert!(!IntentState::Expired.actionable_attention());
        assert!(IntentState::Conflict.actionable_attention());
        // And `awaiting-change` is neither: the gateway is done and this seat
        // has work to do, which is not the member's problem.
        assert!(!IntentState::AwaitingChange.retained_attention());
    }

    #[test]
    fn awaiting_change_is_not_settled_even_though_the_gateway_is_done() {
        assert!(!IntentState::AwaitingChange.is_settled());
        assert!(IntentState::Executed.is_settled());
    }
}
