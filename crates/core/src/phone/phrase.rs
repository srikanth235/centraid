//! THE 24 WORDS, FOR A SHELL THAT HAS NO BIP39 OF ITS OWN (#1047 E1).
//!
//! `phone.proto`'s `PhraseRequest`: mint, check, seed. Each is a pure function
//! of its input and the operating system's entropy — no vault, no file, no
//! network — which is why the arm runs on a core opened over no vault at all
//! (a first launch, a fresh install mid-restore).
//!
//! # WHAT NEVER LEAVES THIS FILE AS TEXT
//!
//! The words and the seed are the answer and nothing else. No error built here
//! quotes a word: `centraid_identity::PhraseError` names a count or bip39's own
//! reason (an index, "invalid checksum"), and the refusal a shell reads is that
//! and no more. `handle.rs` logs a refused request's `Display`, so that rule is
//! what keeps a mistyped phrase out of the log.

use centraid_api_proto::core_v1 as wire;
use centraid_identity::phrase::{self, PHRASE_WORDS, RecoveryPhrase};

use crate::error::{CoreError, Result};

/// How many list words a cell that is not yet a word offers.
pub const SUGGESTIONS: usize = 4;

/// Answer one `PhraseRequest`.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a request with no op, and for `seed` over
/// words that are not a valid phrase — never with the words in the detail.
/// [`CoreError::Unavailable`] when the operating system refuses entropy for
/// `mint`, which is a failure and never a fallback to a weaker source.
pub fn answer(request: &wire::PhraseRequest) -> Result<wire::PhraseResponse> {
    use wire::phrase_request::Op;
    use wire::phrase_response::Answer;
    let answer = match &request.op {
        Some(Op::Mint(_)) => Answer::Minted(mint()?),
        Some(Op::Check(check)) => Answer::Checked(judge(&check.words)),
        Some(Op::Seed(seed)) => Answer::Seeded(seeded(&seed.words)?),
        None => {
            return Err(CoreError::InvalidRequest {
                detail: "a phrase request names no op".to_owned(),
            });
        }
    };
    Ok(wire::PhraseResponse {
        answer: Some(answer),
    })
}

fn mint() -> Result<wire::PhraseMinted> {
    let minted = RecoveryPhrase::generate().map_err(|error| CoreError::Unavailable {
        reason: format!("this phone could not mint your words: {error}"),
    })?;
    Ok(wire::PhraseMinted {
        words: minted.words().map(str::to_owned).collect(),
    })
}

/// A cell as the list sees it: trimmed and lowercased.
fn cell(typed: &str) -> String {
    typed.trim().to_lowercase()
}

/// Judge every cell, then the phrase.
///
/// The verdict's order is the order a member can act on: count first (a
/// missing word is found by counting), then an unknown word (named by its
/// position), then the checksum, which only means something once every word is
/// a list word.
fn judge(typed: &[String]) -> wire::PhraseChecked {
    use wire::phrase_checked::Verdict;
    let cells: Vec<String> = typed.iter().map(|word| cell(word)).collect();
    let words: Vec<wire::PhraseWord> = cells
        .iter()
        .enumerate()
        .map(|(at, word)| {
            let known = !word.is_empty() && phrase::is_word(word);
            wire::PhraseWord {
                position: u32::try_from(at + 1).unwrap_or(u32::MAX),
                empty: word.is_empty(),
                known,
                suggestions: if known || word.is_empty() {
                    Vec::new()
                } else {
                    phrase::words_starting_with(word, SUGGESTIONS)
                        .into_iter()
                        .map(str::to_owned)
                        .collect()
                },
            }
        })
        .collect();
    let first_unknown = words
        .iter()
        .find(|word| !word.empty && !word.known)
        .map_or(0, |word| word.position);
    let filled = cells.iter().filter(|word| !word.is_empty()).count();
    let verdict = if filled < PHRASE_WORDS {
        Verdict::Incomplete
    } else if filled > PHRASE_WORDS {
        Verdict::TooMany
    } else if first_unknown != 0 {
        Verdict::UnknownWord
    } else if RecoveryPhrase::parse(&joined(&cells)).is_ok() {
        Verdict::Valid
    } else {
        Verdict::BadChecksum
    };
    wire::PhraseChecked {
        words,
        verdict: verdict as i32,
        first_unknown,
    }
}

fn joined(cells: &[String]) -> String {
    cells
        .iter()
        .filter(|word| !word.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
}

fn seeded(typed: &[String]) -> Result<wire::PhraseSeeded> {
    let cells: Vec<String> = typed.iter().map(|word| cell(word)).collect();
    let parsed =
        RecoveryPhrase::parse(&joined(&cells)).map_err(|error| CoreError::InvalidRequest {
            detail: format!("those are not your 24 words: {error}"),
        })?;
    Ok(wire::PhraseSeeded {
        seed: parsed.seed().as_bytes().to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::phrase_checked::Verdict;

    /// BIP39's all-zero-entropy English vector — public, and nobody's.
    fn zero() -> Vec<String> {
        let mut words = vec!["abandon".to_owned(); 23];
        words.push("art".to_owned());
        words
    }

    fn check(words: &[String]) -> wire::PhraseChecked {
        judge(words)
    }

    #[test]
    fn a_minted_phrase_is_24_list_words_that_check_valid_and_seed() {
        let minted = mint().expect("OS entropy");
        assert_eq!(minted.words.len(), PHRASE_WORDS);
        assert!(minted.words.iter().all(|word| phrase::is_word(word)));
        assert_eq!(check(&minted.words).verdict, Verdict::Valid as i32);
        let seed = seeded(&minted.words).expect("it seeds");
        assert_eq!(seed.seed.len(), phrase::SEED_BYTES);
        assert_ne!(
            mint().expect("OS entropy").words,
            minted.words,
            "two mints are two phrases"
        );
    }

    #[test]
    fn the_seed_is_bip39s_for_the_published_vector() {
        let seed = seeded(&zero()).expect("the vector seeds");
        assert_eq!(
            hex::encode(seed.seed),
            "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70\
             5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"
        );
    }

    #[test]
    fn case_and_spacing_are_forgiven_in_a_cell() {
        let mut typed = zero();
        typed[0] = "  Abandon ".to_owned();
        assert_eq!(check(&typed).verdict, Verdict::Valid as i32);
        assert_eq!(
            seeded(&typed).expect("seeds").seed,
            seeded(&zero()).expect("seeds").seed
        );
    }

    #[test]
    fn the_verdict_says_count_then_word_then_checksum() {
        let mut short = zero();
        short[5] = String::new();
        let answer = check(&short);
        assert_eq!(answer.verdict, Verdict::Incomplete as i32);
        assert!(answer.words[5].empty);

        let mut unknown = zero();
        unknown[6] = "abandonn".to_owned();
        let answer = check(&unknown);
        assert_eq!(answer.verdict, Verdict::UnknownWord as i32);
        assert_eq!(answer.first_unknown, 7);
        assert!(!answer.words[6].known);

        let mut swapped = zero();
        swapped[23] = "zoo".to_owned();
        assert_eq!(check(&swapped).verdict, Verdict::BadChecksum as i32);

        let mut long = zero();
        long.push("art".to_owned());
        assert_eq!(check(&long).verdict, Verdict::TooMany as i32);
    }

    #[test]
    fn a_cell_that_is_not_yet_a_word_offers_the_words_it_begins() {
        let mut typed = zero();
        typed[2] = "aba".to_owned();
        let cell = &check(&typed).words[2];
        assert!(!cell.known);
        assert_eq!(cell.suggestions, vec!["abandon".to_owned()]);
        let cell = &check(&zero()).words[2];
        assert!(cell.known && cell.suggestions.is_empty());
    }

    #[test]
    fn a_refused_seed_quotes_no_word() {
        let mut typed = zero();
        typed[23] = "zoo".to_owned();
        let error = seeded(&typed).expect_err("a bad checksum is refused");
        let said = error.to_string();
        assert!(!said.contains("abandon") && !said.contains("zoo"), "{said}");
        let mut typed = zero();
        typed[3] = "notaword".to_owned();
        let said = seeded(&typed).expect_err("refused").to_string();
        assert!(!said.contains("notaword"), "{said}");
    }

    #[test]
    fn a_request_with_no_op_is_refused() {
        assert!(matches!(
            answer(&wire::PhraseRequest { op: None }),
            Err(CoreError::InvalidRequest { .. })
        ));
    }
}
