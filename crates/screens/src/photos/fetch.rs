//! BRINGING ONE ORIGINAL BACK (#1080), as every Photos screen asks for it: the
//! library's download arrow and the lightbox's "Load the original" send the
//! same [`wire::FetchOriginal`] effect, and the shell answers
//! [`wire::OriginalFetched`]. This file is the sentences for how it ended.
//!
//! A fetch that [`landed`] means the bytes are on this phone now, so the next
//! read serves the original; every other outcome is a line that names why it
//! did not. No answer at all (`EffectFailed`) is [`no_answer`], never silence: a
//! photograph left fetching because nobody said "it did not happen" is the state
//! this ends.

use centraid_api_proto::core_v1 as wire;
use wire::OriginalFetchOutcome as Outcome;

use crate::strings::{Locale, photos_home as words};

/// The effect that fetches the original whose bytes hash to `content_hash`.
#[must_use]
pub fn effect(content_hash: &str) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::FetchOriginal(wire::FetchOriginal {
            content_hash: content_hash.to_owned(),
        })),
    }
}

/// Are the bytes on this phone now? An unspecified outcome reads as unreachable:
/// "try again" is never a harmful remedy.
#[must_use]
pub fn landed(outcome: Outcome) -> bool {
    matches!(outcome, Outcome::Landed | Outcome::AlreadyHeld)
}

/// The line for a fetch that did not bring the original back; empty when it did.
#[must_use]
pub fn failure_sentence(locale: Locale, outcome: Outcome) -> String {
    match outcome {
        Outcome::Landed | Outcome::AlreadyHeld => String::new(),
        Outcome::NotInBackup => words::fetch_not_in_backup(locale),
        Outcome::Untrusted => words::fetch_untrusted(locale),
        Outcome::Damaged => words::fetch_damaged(locale),
        Outcome::Unreachable | Outcome::Unspecified => words::fetch_unreachable(locale),
    }
}

/// The line for a platform that gave no answer at all.
#[must_use]
pub fn no_answer(locale: Locale) -> String {
    words::fetch_no_answer(locale)
}

/// What a fetch's `EffectResult` came to: `Ok` when the original landed, else
/// the sentence to show.
///
/// # Errors
/// The member-facing sentence when the original did not come back.
pub fn settle(locale: Locale, result: &wire::EffectResult) -> Result<(), String> {
    match &result.outcome {
        Some(wire::effect_result::Outcome::OriginalFetched(fetched)) => {
            let outcome = Outcome::try_from(fetched.outcome).unwrap_or(Outcome::Unspecified);
            if landed(outcome) {
                Ok(())
            } else {
                Err(failure_sentence(locale, outcome))
            }
        }
        _ => Err(no_answer(locale)),
    }
}
