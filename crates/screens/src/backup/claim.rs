//! WHAT A SENTENCE MAY CLAIM ABOUT BACKUP (#1029 §3, W5B-2), and what a member is
//! told about a pass.
//!
//! The umbrella's UI invariant, in the one place a shell could break it: **the
//! phone never claims backup the gateway has not acknowledged.** The rule itself
//! is the core's (`centraid_gateway_client::spool::BackupState`, whose only
//! "backed up" constructor takes a gateway's own `committed_at_ms` out of a
//! commit acknowledgement). Nothing here decides it: it is handed the one fact
//! that acknowledgement produced and turns it into a sentence, so there is no
//! constructor that takes "true". Everything comes from `acked_at_ms` being
//! present or not.
//!
//! There is deliberately **no "Backing up…" that outlives a pass**. A phone with
//! unsent changes says how many, not that it is busy: "busy" is a promise about
//! the future.

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, backup as line_words, backup_home as words, fill};

/// The whole line, from the only facts a gateway produced: `acked_at_ms` is the
/// gateway's own `committed_at_ms` (never this phone's clock) or `None` when it
/// never acknowledged a commit; `unacked` how many changes are still in the
/// spool; `relative` how long ago it was, already worded.
#[must_use]
pub fn line(locale: Locale, acked_at_ms: Option<i64>, unacked: u64, relative: &str) -> String {
    match (acked_at_ms, unacked) {
        (None, _) => words::claim_never(locale),
        (Some(_), 0) => fill(&words::claim_up_to_date(locale), &[("when", relative)]),
        // IT LEADS WITH WHAT IS NOT BACKED UP, because that is the part a member
        // would be wrong about: "Backed up 2 minutes ago" over three unsent
        // changes is the claim this module exists to prevent.
        (Some(_), n) => fill(&words::claim_behind(locale, n), &[("when", relative)]),
    }
}

/// Whether a sentence may use the word "backed up" about this vault without a
/// qualifier: only over an acknowledgement with an empty spool. Asked, not
/// inferred, so the assertion has one name.
#[must_use]
pub fn is_backed_up(acked_at_ms: Option<i64>, unacked: u64) -> bool {
    acked_at_ms.is_some() && unacked == 0
}

/// The sentence for a vault that has moved to another phone. Never "lost" and
/// never "deleted": the move freezes and shows, it wipes nothing.
#[must_use]
pub fn frozen(locale: Locale, unacked: u64, since: &str) -> String {
    if unacked == 0 {
        words::claim_moved_nothing(locale)
    } else {
        fill(
            &words::claim_moved_unsent(locale, unacked),
            &[("since", since)],
        )
    }
}

/// Bytes in a member's units: decimal, because a phone's own storage screen is
/// decimal, and whole units, because "3.27183 MB" is a number nobody can use.
#[must_use]
pub fn bytes(count: u64) -> String {
    match count {
        0..=999 => format!("{count} bytes"),
        1_000..=999_999 => format!("{} KB", count / 1_000),
        1_000_000..=999_999_999 => format!("{} MB", count / 1_000_000),
        _ => format!("{} GB", count / 1_000_000_000),
    }
}

/// What a member is told when a pass stopped, one sentence per reason.
///
/// **`DEADLINE` is not an error and does not say so**: a window that ran out
/// with bytes left is the ordinary case for a first backup of a camera roll.
/// `EMPTY` is the spool's, not the library's: an item still waiting for Wi-Fi or
/// a charger was never sealed, so "everything" would be a claim.
#[must_use]
pub fn stopped_sentence(locale: Locale, stopped: wire::DrainStop, pending_bytes: u64) -> String {
    use wire::DrainStop as S;
    match stopped {
        S::Empty => words::pass_stopped_empty(locale),
        S::Deadline => fill(
            &words::pass_stopped_deadline(locale),
            &[("size", &bytes(pending_bytes))],
        ),
        // AN UNSPECIFIED STOP READS AS UNREACHABLE: "try again" is never a
        // harmful remedy.
        S::Unreachable | S::Unspecified => words::pass_stopped_unreachable(locale),
        S::Untrusted => words::pass_stopped_untrusted(locale),
        S::Refused => line_words::backup_refused(locale),
    }
}

/// The sentence for a pass the gateway superseded: the vault moved to another
/// phone, so this one is read-only.
#[must_use]
pub fn moved_sentence(locale: Locale) -> String {
    words::pass_stopped_moved(locale)
}
