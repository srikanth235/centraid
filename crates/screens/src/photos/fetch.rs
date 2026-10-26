//! BRINGING ONE ORIGINAL BACK (#1080), as every Photos screen asks for it: the
//! library's download arrow and the lightbox's "Load the original" call the
//! same core door, `fetch_original`, off the runtime's lock (it dials a
//! gateway, [`start`]), and read the same answer ([`answered`]). No shell is in
//! the loop: the bytes land in the vault's own store and a read draws them.
//!
//! A fetch that [`landed`] means the bytes are on this phone now, so the next
//! read serves the original; every other outcome is a line that names why it
//! did not. A door that refused to answer at all is [`no_answer`], never
//! silence: a photograph left fetching because nobody said "it did not happen"
//! is the state this ends.

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;
use prost::Message;
use wire::FetchOutcome as Outcome;

use crate::screen::Ctx;
use crate::strings::{Locale, photos_home as words};

/// The off-thread tag a fetch answers under, followed by the hash it asked for.
const TAG: &str = "photos.fetch-original:";

/// Ask the core for the original whose bytes hash to `content_hash` (64 hex
/// characters, `PhotoTile.content_id`). The answer reaches the asking screen as
/// `OffThreadDone`, which [`answered`] reads. False when the hash is not one, so
/// nothing was asked.
pub fn start(ctx: &Ctx, content_hash: &str) -> bool {
    let Some(raw) = unhex(content_hash) else {
        return false;
    };
    ctx.vault_async(
        &format!("{TAG}{content_hash}"),
        VaultRequest::FetchOriginal(wire::FetchOriginalRequest { content_hash: raw }),
    );
    true
}

/// How one fetch ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetched {
    /// The hash that was asked for, so a screen with several fetches in flight
    /// knows which one this answers.
    pub content_hash: String,
    /// The core's outcome, or `None` when its door refused to answer.
    pub outcome: Option<Outcome>,
}

/// The fetch a job's answer is, or `None` when the job was not a fetch.
#[must_use]
pub fn answered(done: &wire::OffThreadDone) -> Option<Fetched> {
    let content_hash = done.tag.strip_prefix(TAG)?.to_owned();
    let outcome = wire::VaultCalled::decode(done.bytes.as_slice())
        .ok()
        .filter(|called| called.error.is_none())
        .and_then(|called| wire::Response::decode(called.response.as_slice()).ok())
        .and_then(|response| match response.kind {
            Some(wire::response::Kind::FetchOriginal(fetched)) => {
                Some(Outcome::try_from(fetched.outcome).unwrap_or(Outcome::Unspecified))
            }
            _ => None,
        });
    Some(Fetched {
        content_hash,
        outcome,
    })
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

/// The line for a door that gave no answer at all.
#[must_use]
pub fn no_answer(locale: Locale) -> String {
    words::fetch_no_answer(locale)
}

/// What a fetch came to: `Ok` when the original landed, else the sentence to
/// show.
///
/// # Errors
/// The member-facing sentence when the original did not come back.
pub fn settle(locale: Locale, fetched: &Fetched) -> Result<(), String> {
    match fetched.outcome {
        Some(outcome) if landed(outcome) => Ok(()),
        Some(outcome) => Err(failure_sentence(locale, outcome)),
        None => Err(no_answer(locale)),
    }
}

/// 64 hex characters as 32 bytes.
fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done(tag: &str, called: &wire::VaultCalled) -> wire::OffThreadDone {
        wire::OffThreadDone {
            tag: tag.to_owned(),
            bytes: called.encode_to_vec(),
        }
    }

    #[test]
    fn an_answer_names_its_hash_and_the_cores_outcome_and_a_refusal_is_no_answer() {
        let hash = "ab".repeat(32);
        let response = wire::Response {
            kind: Some(wire::response::Kind::FetchOriginal(
                wire::FetchOriginalResponse {
                    outcome: Outcome::NotInBackup as i32,
                    path: String::new(),
                },
            )),
        };
        let answer = answered(&done(
            &format!("{TAG}{hash}"),
            &wire::VaultCalled {
                response: response.encode_to_vec(),
                error: None,
            },
        ))
        .expect("a fetch");
        assert_eq!(answer.content_hash, hash);
        assert_eq!(answer.outcome, Some(Outcome::NotInBackup));
        assert_eq!(
            settle(Locale::En, &answer),
            Err(failure_sentence(Locale::En, Outcome::NotInBackup))
        );
        let refused = answered(&done(
            &format!("{TAG}{hash}"),
            &wire::VaultCalled {
                response: Vec::new(),
                error: Some(wire::Error::default()),
            },
        ))
        .expect("a fetch");
        assert_eq!(settle(Locale::En, &refused), Err(no_answer(Locale::En)));
        assert!(answered(&done("drain:aa", &wire::VaultCalled::default())).is_none());
    }

    #[test]
    fn only_a_content_hash_is_asked_for() {
        assert_eq!(unhex(&"0f".repeat(32)), Some(vec![15; 32]));
        assert!(unhex("abc").is_none());
        assert!(unhex(&"zz".repeat(32)).is_none());
    }
}
