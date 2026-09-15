//! Breaker policy: how long a failing harness is left alone (#1020,
//! D-1020-AS4).
//!
//! The rows are `crates/vault::ledger::health`'s; the *decisions* are here.
//!
//! ## Failure class decides the shape of the backoff, not the count
//!
//! Eight classes, and they are not eight degrees of the same thing:
//!
//! | Class | What it means | Backoff |
//! |---|---|---|
//! | `auth` | not signed in, or the subscription lapsed | **permanent** |
//! | `quota` | the plan's limit is spent | long, fixed |
//! | `spawn` | the binary is not there, or would not start | medium |
//! | `init` | it started but never completed ACP `initialize` | medium |
//! | `timeout` | it accepted the prompt and went quiet | exponential |
//! | `wedge` | it is alive and not making progress | exponential |
//! | `exit` | it died mid-turn | exponential |
//! | `unknown` | none of the above | exponential |
//!
//! `auth` is [`centraid_vault::ledger::health::PERMANENT`] because backing off
//! exponentially from "you are not signed in" just delays the sentence the
//! member needs to read, and the thing that clears it is a member action, not
//! the passage of time. That is what makes the `-1` sentinel a design decision
//! rather than an encoding trick — and why `goose`'s habit of answering an
//! unconfigured provider with a bare `-32603` matters
//! (`harness-errors.ts`, `registry.ts:313`): misclassifying that as `unknown`
//! would retry a harness that will never succeed, while classifying every
//! `-32603` as `auth` would permanently open a breaker on a transient
//! internal error. So the classification looks at the *message* for goose and
//! at the code for everyone else.
//!
//! ## Failover reads the posture, not the breaker
//!
//! A shut breaker says *this kind is not worth trying now*. Whether the turn
//! then tries a different kind is [`crate::turn::Failover`]'s answer: a chat
//! turn retries at the turn boundary, an automation at the fire boundary, and
//! some postures not at all. Two questions, two owners.

use centraid_vault::ledger::health::{self, PERMANENT};

/// The eight classes, closed as the table's CHECK is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    Spawn,
    Auth,
    Init,
    Timeout,
    Quota,
    Wedge,
    Exit,
    Unknown,
}

impl FailureClass {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Spawn => "spawn",
            Self::Auth => "auth",
            Self::Init => "init",
            Self::Timeout => "timeout",
            Self::Quota => "quota",
            Self::Wedge => "wedge",
            Self::Exit => "exit",
            Self::Unknown => "unknown",
        }
    }
}

/// The backoff ladder for the exponential classes, in milliseconds.
///
/// Capped rather than unbounded: an hour is long enough that a wedged harness
/// stops costing anything, and short enough that a member who fixed the problem
/// does not have to wait out a doubling they cannot see.
pub const BACKOFF_LADDER_MS: [i64; 6] = [
    30_000,    // 30 s
    120_000,   // 2 min
    600_000,   // 10 min
    1_800_000, // 30 min
    3_600_000, // 1 h
    3_600_000, // and no further
];

/// A fixed, long wait for a spent quota: the window that resets it is usually
/// hours, and probing it more often than that is noise.
pub const QUOTA_BACKOFF_MS: i64 = 4 * 3_600_000;

/// A medium wait for a harness that will not start.
pub const STARTUP_BACKOFF_MS: i64 = 300_000;

/// The deadline to record for the `consecutive_failures`-th failure of a class.
///
/// `failures` counts the failure being recorded, so the first is `1`.
#[must_use]
pub fn breaker_until(class: FailureClass, failures: i64, now_ms: i64) -> Option<i64> {
    match class {
        // NEVER a deadline. The sentinel, and the reason it exists.
        FailureClass::Auth => Some(PERMANENT),
        FailureClass::Quota => Some(now_ms.saturating_add(QUOTA_BACKOFF_MS)),
        FailureClass::Spawn | FailureClass::Init => {
            // One failure is not a breaker: a cold start that lost a race is
            // the ordinary case. The second is.
            (failures >= 2).then(|| now_ms.saturating_add(STARTUP_BACKOFF_MS))
        }
        FailureClass::Timeout
        | FailureClass::Wedge
        | FailureClass::Exit
        | FailureClass::Unknown => {
            if failures < 2 {
                return None;
            }
            let step = usize::try_from(failures - 2).unwrap_or(usize::MAX);
            let wait = BACKOFF_LADDER_MS[step.min(BACKOFF_LADDER_MS.len() - 1)];
            Some(now_ms.saturating_add(wait))
        }
    }
}

/// Whether a turn may be attempted for this kind right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// No breaker, or the class is clean.
    Open,
    /// The breaker is shut until this instant, or forever at `-1`.
    Shut {
        failure_class: String,
        until_ms: i64,
    },
    /// The deadline has passed and this caller claimed the single probe.
    HalfOpen { failure_class: String },
}

/// Ask the ledger whether this kind may be tried, claiming the half-open probe
/// if one is available.
///
/// The claim is a write, and that is deliberate: "may I try" and "I am trying"
/// must be one atomic step, or two fires both get told yes.
pub fn admit(
    vault: &centraid_vault::Vault,
    workspace_context: &str,
    harness_kind: &str,
    now_ms: i64,
) -> centraid_vault::Result<Admission> {
    let classes = health::classes_for(vault, workspace_context, harness_kind)?;
    for row in &classes {
        if !health::is_open(row.breaker_until, now_ms) {
            continue;
        }
        if row.breaker_until == Some(PERMANENT) {
            return Ok(Admission::Shut {
                failure_class: row.failure_class.clone(),
                until_ms: PERMANENT,
            });
        }
        return Ok(Admission::Shut {
            failure_class: row.failure_class.clone(),
            until_ms: row.breaker_until.unwrap_or_default(),
        });
    }
    // Nothing is shut. An expired deadline still holds its probe: claim it, so
    // exactly one caller retries and the rest wait for its answer.
    for row in &classes {
        if row.breaker_until.is_some()
            && row.breaker_until != Some(PERMANENT)
            && row.half_open_claimed_at.is_none()
            && health::claim_half_open(
                vault,
                workspace_context,
                harness_kind,
                &row.failure_class,
                now_ms,
            )?
        {
            return Ok(Admission::HalfOpen {
                failure_class: row.failure_class.clone(),
            });
        }
    }
    Ok(Admission::Open)
}

/// Classify a harness failure into one of the eight classes.
///
/// `code` is the JSON-RPC error code when there is one.
#[must_use]
pub fn classify(kind: &str, code: Option<i64>, message: &str) -> FailureClass {
    let lowered = message.to_ascii_lowercase();
    if lowered.contains("not signed in")
        || lowered.contains("unauthorized")
        || lowered.contains("authentication")
        || lowered.contains("auth_required")
        || lowered.contains("login")
    {
        return FailureClass::Auth;
    }
    if lowered.contains("quota")
        || lowered.contains("rate limit")
        || lowered.contains("usage limit")
    {
        return FailureClass::Quota;
    }
    // GOOSE'S `-32603`. An unconfigured provider answers with a bare internal
    // error and never `AUTH_REQUIRED` (`registry.ts:313`), so for goose alone
    // an internal error that mentions a provider is read as a configuration
    // problem — permanent until `goose configure` is run.
    if kind == "goose"
        && code == Some(-32_603)
        && (lowered.contains("provider") || lowered.contains("configure"))
    {
        return FailureClass::Auth;
    }
    if lowered.contains("enoent") || lowered.contains("not found on path") {
        return FailureClass::Spawn;
    }
    if lowered.contains("initialize") {
        return FailureClass::Init;
    }
    if lowered.contains("timed out") || lowered.contains("timeout") {
        return FailureClass::Timeout;
    }
    if lowered.contains("exited") || lowered.contains("killed") || lowered.contains("signal") {
        return FailureClass::Exit;
    }
    FailureClass::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_auth_failure_opens_the_breaker_permanently_on_the_first_try() {
        assert_eq!(breaker_until(FailureClass::Auth, 1, 1_000), Some(PERMANENT));
        assert!(health::is_open(Some(PERMANENT), i64::MAX));
    }

    #[test]
    fn one_transient_failure_is_not_a_breaker() {
        assert_eq!(breaker_until(FailureClass::Timeout, 1, 1_000), None);
        assert_eq!(breaker_until(FailureClass::Spawn, 1, 1_000), None);
    }

    #[test]
    fn the_ladder_doubles_and_then_stops() {
        let waits: Vec<i64> = (2..=9)
            .map(|failures| breaker_until(FailureClass::Wedge, failures, 0).expect("a deadline"))
            .collect();
        assert_eq!(
            waits,
            [
                30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000
            ],
            "the ladder is capped, so a fixed problem is not punished for an hour more each time"
        );
    }

    #[test]
    fn a_spent_quota_waits_for_the_window_not_for_a_doubling() {
        assert_eq!(
            breaker_until(FailureClass::Quota, 1, 0),
            Some(QUOTA_BACKOFF_MS)
        );
        assert_eq!(
            breaker_until(FailureClass::Quota, 7, 0),
            Some(QUOTA_BACKOFF_MS),
            "a quota breaker does not grow: the reset is a clock, not a penalty"
        );
    }

    #[test]
    fn gooses_bare_internal_error_is_read_as_a_configuration_problem() {
        assert_eq!(
            classify(
                "goose",
                Some(-32_603),
                "Internal error: no provider configured"
            ),
            FailureClass::Auth
        );
        // The same code from any other kind is not an auth failure: that would
        // permanently shut a breaker on a transient internal error.
        assert_eq!(
            classify("codex", Some(-32_603), "Internal error: transient"),
            FailureClass::Unknown
        );
        // And an unrelated goose internal error is still not auth.
        assert_eq!(
            classify("goose", Some(-32_603), "Internal error: disk full"),
            FailureClass::Unknown
        );
    }

    #[test]
    fn classification_prefers_the_message_a_member_can_act_on() {
        assert_eq!(classify("codex", None, "ENOENT"), FailureClass::Spawn);
        assert_eq!(
            classify("codex", None, "please run `codex login`"),
            FailureClass::Auth
        );
        assert_eq!(
            classify("grok", None, "usage limit reached"),
            FailureClass::Quota
        );
        assert_eq!(
            classify("pi", None, "prompt timed out after 600s"),
            FailureClass::Timeout
        );
        assert_eq!(classify("pi", None, "exited 137"), FailureClass::Exit);
    }
}
