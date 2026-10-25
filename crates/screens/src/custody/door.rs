//! THE CORE'S DOORS THE WORDS USE (#1135, lane H2): the phrase door (`phone.proto`'s
//! `PhraseRequest`: mint, judge, seed) and the restore request.
//!
//! This crate has no BIP39 (no word list, no checksum, no PBKDF2) and must not
//! grow one: a second implementation is a second opinion about which words are
//! a member's vaults. Minting, judging and seeding are one request kind on the
//! core and this module is the whole of what crosses. **`None` is "the core
//! could not be asked"**, never a verdict. The words and the seed never reach a
//! log line, an error or a `Debug`.

use std::fmt;

use centraid_api_proto::core_v1 as wire;

use super::secrets::{SEED_HEX_LENGTH, WORDS};
use crate::screen::Ctx;

fn phrase(ctx: &Ctx, op: wire::phrase_request::Op) -> Option<wire::PhraseResponse> {
    let request = wire::Request {
        kind: Some(wire::request::Kind::Phrase(wire::PhraseRequest {
            op: Some(op),
        })),
    };
    match ctx.door(&request).ok()?.kind? {
        wire::response::Kind::Phrase(answer) => Some(answer),
        _ => None,
    }
}

/// 24 words from the core's CSPRNG, or `None`.
#[must_use]
pub fn mint(ctx: &Ctx) -> Option<Vec<String>> {
    match phrase(ctx, wire::phrase_request::Op::Mint(wire::PhraseMint {}))?.answer? {
        wire::phrase_response::Answer::Minted(minted) if minted.words.len() == WORDS => {
            Some(minted.words)
        }
        _ => None,
    }
}

/// The seed (128 lowercase hex) the words make, or `None` when they are not a
/// phrase.
#[must_use]
pub fn seed(ctx: &Ctx, words: &[String]) -> Option<String> {
    let op = wire::phrase_request::Op::Seed(wire::PhraseSeed {
        words: words.to_vec(),
    });
    match phrase(ctx, op)?.answer? {
        wire::phrase_response::Answer::Seeded(seeded)
            if seeded.seed.len() == SEED_HEX_LENGTH / 2 =>
        {
            Some(to_hex(&seeded.seed))
        }
        _ => None,
    }
}

/// What the core said of the words as typed.
pub struct Verdict {
    pub cells: Vec<Cell>,
    pub verdict: Judged,
    /// 1-based; 0 for none.
    pub first_unknown: u32,
}

pub struct Cell {
    pub known: bool,
    pub suggestions: Vec<String>,
}

impl fmt::Debug for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Verdict({:?}, first_unknown={}, <redacted>)",
            self.verdict, self.first_unknown
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Judged {
    Incomplete,
    UnknownWord,
    BadChecksum,
    Valid,
    TooMany,
}

/// Each cell and the phrase judged, or `None`.
#[must_use]
pub fn check(ctx: &Ctx, words: &[String]) -> Option<Verdict> {
    let op = wire::phrase_request::Op::Check(wire::PhraseCheck {
        words: words.to_vec(),
    });
    let wire::phrase_response::Answer::Checked(checked) = phrase(ctx, op)?.answer? else {
        return None;
    };
    use wire::phrase_checked::Verdict as V;
    Some(Verdict {
        cells: checked
            .words
            .iter()
            .map(|cell| Cell {
                known: cell.known,
                suggestions: cell.suggestions.clone(),
            })
            .collect(),
        verdict: match V::try_from(checked.verdict) {
            Ok(V::Valid) => Judged::Valid,
            Ok(V::UnknownWord) => Judged::UnknownWord,
            Ok(V::BadChecksum) => Judged::BadChecksum,
            Ok(V::TooMany) => Judged::TooMany,
            // UNSPECIFIED IS READ AS INCOMPLETE: a verdict this build has no
            // name for never opens the Restore button.
            _ => Judged::Incomplete,
        },
        first_unknown: checked.first_unknown,
    })
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/// WHY A RESTORE BROUGHT NOTHING BACK, by the core's code and never by its
/// logs-only detail. "No vault for these words" is not here: it is an answer
/// with no vaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreRefusal {
    /// `PEER_UNREACHABLE` and everything unrecognised: the gateway did not
    /// answer. The one refusal whose remedy, trying again, is never harmful.
    Unreachable,
    /// `UNAUTHORIZED`: the gateway answered and would not take this phone's
    /// claim on the vault.
    NotTaken,
    /// `INTERNAL`: what the gateway sent did not open, or failed its checks.
    /// Nothing was laid down and nothing was claimed, so the old phone still
    /// backs up (#1047 R3).
    DidNotCheck,
}

impl RestoreRefusal {
    /// The refusal a core error is.
    #[must_use]
    pub fn of(code: wire::ErrorCode) -> Self {
        match code {
            wire::ErrorCode::Internal => Self::DidNotCheck,
            wire::ErrorCode::Unauthorized => Self::NotTaken,
            _ => Self::Unreachable,
        }
    }
}

/// One vault a restore laid down.
#[derive(Clone, PartialEq, Eq)]
pub struct RestoredVaultAt {
    pub path: String,
    pub index: u32,
    pub rows: i64,
    pub safety_number: String,
    /// The entry it came back from when it is on its own words; `None` for the
    /// member's.
    pub own: Option<String>,
}

/// One vault a restore checked and could not claim. The core's `reason` is a
/// support-log string and is not carried: a member's sentence is never built
/// from logs-only detail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnclaimedVaultAt {
    pub index: u32,
    pub vault_id: String,
    pub own: Option<String>,
}

/// What a restore answered. `Debug` carries counts only: a path or a safety
/// number is not a log line's to keep.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct RestoreAnswer {
    pub vaults: Vec<RestoredVaultAt>,
    pub gap_scanned: u32,
    pub unclaimed: Vec<UnclaimedVaultAt>,
}

impl fmt::Debug for RestoreAnswer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "RestoreAnswer(vaults={}, unclaimed={}, gap_scanned={})",
            self.vaults.len(),
            self.unclaimed.len(),
            self.gap_scanned
        )
    }
}

impl fmt::Debug for RestoredVaultAt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RestoredVaultAt(index={}, rows={})", self.index, self.rows)
    }
}

impl RestoreAnswer {
    /// This answer's vaults, marked as entry `id`'s.
    #[must_use]
    pub fn tagged_own(&self, id: &str) -> Self {
        Self {
            vaults: self
                .vaults
                .iter()
                .map(|vault| RestoredVaultAt {
                    own: Some(id.to_owned()),
                    ..vault.clone()
                })
                .collect(),
            gap_scanned: self.gap_scanned,
            unclaimed: self
                .unclaimed
                .iter()
                .map(|vault| UnclaimedVaultAt {
                    own: Some(id.to_owned()),
                    ..vault.clone()
                })
                .collect(),
        }
    }

    /// One answer out of several.
    #[must_use]
    pub fn merged(mut answers: Vec<Self>) -> Self {
        if answers.len() == 1 {
            return answers.remove(0);
        }
        Self {
            vaults: answers.iter().flat_map(|a| a.vaults.clone()).collect(),
            gap_scanned: answers.iter().map(|a| a.gap_scanned).sum(),
            unclaimed: answers.iter().flat_map(|a| a.unclaimed.clone()).collect(),
        }
    }
}

/// What a restore asks with: the words (as typed), the seed this phone holds,
/// or only the indices that stayed, from that seed. **Redacted.**
#[derive(Clone)]
pub enum Source {
    Words(Vec<String>),
    Seed(String),
    Stayed(String, Vec<u32>),
}

impl fmt::Debug for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Source(<redacted>)")
    }
}

/// The wire request for `source`, against the gateway `payload` names (the
/// pairing text its `pair` verb printed). `None` when a seed is not a seed.
#[must_use]
pub fn restore_request(source: &Source, payload: &str) -> Option<wire::RestoreRequest> {
    Some(match source {
        // THE WORDS AS ONE STRING, because `RecoveryPhrase::parse` owns what a
        // phrase is and a second parser here would disagree with it.
        Source::Words(words) => wire::RestoreRequest {
            phrase: words.join(" "),
            payload: payload.to_owned(),
            ..wire::RestoreRequest::default()
        },
        // `phrase` is left empty: the core refuses a request carrying both.
        Source::Seed(seed) => wire::RestoreRequest {
            seed: Some(from_hex(seed)?),
            payload: payload.to_owned(),
            ..wire::RestoreRequest::default()
        },
        Source::Stayed(seed, indices) => wire::RestoreRequest {
            seed: Some(from_hex(seed)?),
            payload: payload.to_owned(),
            indices: indices.clone(),
            ..wire::RestoreRequest::default()
        },
    })
}

/// The answer a restore response is.
#[must_use]
pub fn restore_answer(response: &wire::RestoreResponse) -> RestoreAnswer {
    RestoreAnswer {
        vaults: response
            .vaults
            .iter()
            .map(|vault| RestoredVaultAt {
                path: vault.path.clone(),
                index: vault.index,
                rows: vault.rows,
                safety_number: vault.safety_number.clone(),
                own: None,
            })
            .collect(),
        gap_scanned: response.gap_scanned,
        // A VAULT THAT STAYED WITH THE OLD PHONE (R-1047-R5), by index and id.
        unclaimed: response
            .unclaimed
            .iter()
            .map(|vault| UnclaimedVaultAt {
                index: vault.index,
                vault_id: vault.vault_id.clone(),
                own: None,
            })
            .collect(),
    }
}

/// Where a restore request went.
pub enum Sent {
    /// It already answered.
    Done(Result<RestoreAnswer, RestoreRefusal>),
}

/// Send a restore. A restore waits on a gateway, so it does not belong on the
/// screen runtime's lock; the transport is this function's alone.
pub fn restore(ctx: &Ctx, request: wire::RestoreRequest) -> Sent {
    let asked = wire::Request {
        kind: Some(wire::request::Kind::Restore(request)),
    };
    Sent::Done(match ctx.door(&asked) {
        Ok(wire::Response {
            kind: Some(wire::response::Kind::Restore(response)),
        }) => Ok(restore_answer(&response)),
        // AN ANSWER WITH NO RESTORE ON IT is read as silence.
        Ok(_) => Err(RestoreRefusal::Unreachable),
        // THE CODE SAYS WHICH REFUSAL (#1047 R3); the detail stays in the logs.
        Err(error) => Err(RestoreRefusal::of(error.code())),
    })
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

#[must_use]
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The 64-byte seed from its 128 hex characters, or `None`: a value read off a
/// screen is mistyped, and a malformed one is a refusal and not a crash.
#[must_use]
pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    let hex: Vec<u8> = text
        .trim()
        .to_ascii_lowercase()
        .bytes()
        .filter(|b| *b != b' ' && *b != b'-')
        .collect();
    if hex.len() != SEED_HEX_LENGTH || !hex.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    hex.chunks(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16)?;
            let low = (pair[1] as char).to_digit(16)?;
            u8::try_from(high * 16 + low).ok()
        })
        .collect()
}
