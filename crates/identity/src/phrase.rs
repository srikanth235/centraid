//! The 24-word phrase, and the seed underneath it (#1029 §0).
//!
//! The phone keeps the seed as one synchronizable keychain item; the written
//! phrase is the fallback, shown once at setup and re-checkable in settings.
//! Both paths land here, so this module has exactly three jobs: mint a phrase
//! from operating-system entropy, parse one a person typed, and hand back the
//! 64-byte seed [`crate::derive`] builds the tree from.
//!
//! ## THE PASSPHRASE IS EMPTY, AND THAT IS A PRODUCT DECISION
//!
//! BIP39 allows a 25th-word passphrase that changes the seed. This product does
//! not offer one: it is a second secret with no recovery path, and a person who
//! forgets it has lost every vault with no way to tell that from a mistyped
//! word. [`RecoveryPhrase::seed`] therefore takes no argument. Adding one later
//! is a new method, never a changed default — a default that grew a passphrase
//! would silently re-derive every address in the product.

use bip39::{Language, Mnemonic};

/// A recovery phrase is 24 words. Twelve would be 128 bits of entropy, which is
/// enough against a brute force and not enough against the product's own
/// promise: this one phrase is every vault a person will ever have, for life.
pub const PHRASE_WORDS: usize = 24;

/// 256 bits, which is what 24 BIP39 words encode (`24 * 11 = 264` bits, 256 of
/// entropy and 8 of checksum).
pub const PHRASE_ENTROPY_BYTES: usize = 32;

/// BIP39 seeds are 64 bytes, out of PBKDF2-HMAC-SHA512 at 2048 rounds.
pub const SEED_BYTES: usize = 64;

/// What can go wrong between a person's handwriting and a seed.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PhraseError {
    /// The phrase is not [`PHRASE_WORDS`] words. Reported before any checksum
    /// work, because "you have 23 words" is an answer a person can act on and
    /// "invalid phrase" is not.
    #[error("a recovery phrase is {PHRASE_WORDS} words, and this is {found}")]
    WordCount {
        /// How many words were actually supplied.
        found: usize,
    },
    /// The words parse but the BIP39 checksum does not close, or a word is not
    /// in the English list.
    #[error("this is not a valid recovery phrase: {reason}")]
    Invalid {
        /// `bip39`'s own account of what failed, rendered.
        reason: String,
    },
    /// The operating system would not give us entropy. Not a fallback case: a
    /// phrase drawn from a thread-local generator is a phrase an attacker can
    /// reproduce, so this fails loudly instead.
    #[error("the operating system refused entropy for a new phrase: {reason}")]
    NoEntropy {
        /// The OS error, rendered.
        reason: String,
    },
}

/// The 24 words, validated. Constructing one is the validation.
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveryPhrase(Mnemonic);

impl RecoveryPhrase {
    /// A fresh phrase from operating-system entropy.
    ///
    /// `try_os_rng` rather than a thread-local generator, for the same reason
    /// `centraid_net::ticket::fresh_secret` uses it: a predictable phrase hands
    /// over every vault this person will ever have, so the source is the
    /// operating system and a failure to read it is an error, never a fallback.
    pub fn generate() -> Result<Self, PhraseError> {
        use rand::TryRngCore as _;

        let mut entropy = [0u8; PHRASE_ENTROPY_BYTES];
        rand::rngs::OsRng
            .try_fill_bytes(&mut entropy)
            .map_err(|error| PhraseError::NoEntropy {
                reason: error.to_string(),
            })?;
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy).map_err(|error| {
            PhraseError::Invalid {
                reason: error.to_string(),
            }
        })?;
        Ok(Self(mnemonic))
    }

    /// Parse a phrase a person typed, or read back in settings.
    ///
    /// Whitespace and case are normalised before parsing, because a phrase
    /// arrives from a keyboard and a person who typed a leading space has not
    /// made a mistake worth an error message.
    pub fn parse(input: &str) -> Result<Self, PhraseError> {
        let normalised = input.split_whitespace().collect::<Vec<_>>().join(" ");
        let found = normalised.split_whitespace().count();
        if found != PHRASE_WORDS {
            return Err(PhraseError::WordCount { found });
        }
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalised.to_lowercase())
            .map_err(|error| PhraseError::Invalid {
                reason: error.to_string(),
            })?;
        Ok(Self(mnemonic))
    }

    /// The words, in order, for the setup screen and the settings re-check.
    pub fn words(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.0.words()
    }

    /// The phrase as a person would write it down: 24 lowercase words, single
    /// spaces.
    pub fn to_phrase_string(&self) -> String {
        self.words().collect::<Vec<_>>().join(" ")
    }

    /// The settings re-check: does what the person typed match the phrase this
    /// vault was built from?
    ///
    /// Compares the parsed phrases, never the strings, so a re-check does not
    /// fail on a trailing space or a capital letter — and does not *pass* on a
    /// string that merely looks similar.
    pub fn matches(&self, typed: &str) -> bool {
        Self::parse(typed).is_ok_and(|other| other == *self)
    }

    /// The 64-byte seed. See the module header for why there is no passphrase
    /// argument.
    pub fn seed(&self) -> Seed {
        Seed(self.0.to_seed_normalized(""))
    }
}

/// Deliberately not `Debug`-derived: a phrase that reaches a log or a panic
/// message is every vault this person has.
impl core::fmt::Debug for RecoveryPhrase {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("RecoveryPhrase(<redacted>)")
    }
}

/// The master secret. Everything in [`crate::derive`] is a function of these
/// 64 bytes.
#[derive(Clone)]
pub struct Seed([u8; SEED_BYTES]);

impl Seed {
    /// Adopt seed bytes that came from the platform keychain rather than from a
    /// phrase typed this session.
    pub const fn from_bytes(bytes: [u8; SEED_BYTES]) -> Self {
        Self(bytes)
    }

    /// The bytes, for the keychain write. There is no other legitimate caller.
    pub const fn as_bytes(&self) -> &[u8; SEED_BYTES] {
        &self.0
    }
}

/// Redacted for the same reason [`RecoveryPhrase`] is.
impl core::fmt::Debug for Seed {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Seed(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BIP39's own English test vector: the 256-bit all-`0x00` entropy row of
    /// Trezor's `vectors.json`. An external phrase, not one of ours, so the
    /// wordlist and the checksum are BIP39's.
    const ZERO_ENTROPY_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    /// `PBKDF2-HMAC-SHA512(password = phrase, salt = "mnemonic", 2048, 64)`.
    ///
    /// The published Trezor row salts with `mnemonicTREZOR`; this product has
    /// no passphrase (see the module header), so the pinned value is the
    /// empty-passphrase seed of the same phrase. Both were checked against a
    /// PBKDF2 implementation outside this workspace before being written here,
    /// so what this asserts is BIP39's parameters and not `bip39`'s agreement
    /// with itself.
    const ZERO_ENTROPY_SEED_HEX: &str = "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840";

    #[test]
    fn the_bip39_vector_is_what_this_build_computes() {
        let phrase = RecoveryPhrase::parse(ZERO_ENTROPY_PHRASE).expect("the BIP39 vector parses");
        assert_eq!(phrase.words().count(), PHRASE_WORDS);
        assert_eq!(hex::encode(phrase.seed().as_bytes()), ZERO_ENTROPY_SEED_HEX);
    }

    #[test]
    fn a_generated_phrase_round_trips_and_is_twenty_four_words() {
        let phrase = RecoveryPhrase::generate().expect("OS entropy");
        assert_eq!(phrase.words().count(), PHRASE_WORDS);
        let reparsed = RecoveryPhrase::parse(&phrase.to_phrase_string()).expect("round trip");
        assert_eq!(reparsed.seed().as_bytes(), phrase.seed().as_bytes());
    }

    #[test]
    fn two_generated_phrases_differ() {
        let a = RecoveryPhrase::generate().expect("OS entropy");
        let b = RecoveryPhrase::generate().expect("OS entropy");
        assert_ne!(a.to_phrase_string(), b.to_phrase_string());
    }

    #[test]
    fn a_short_phrase_is_counted_not_merely_refused() {
        let twenty_three = ZERO_ENTROPY_PHRASE
            .split_whitespace()
            .take(23)
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            RecoveryPhrase::parse(&twenty_three),
            Err(PhraseError::WordCount { found: 23 })
        );
    }

    #[test]
    fn a_broken_checksum_is_refused() {
        // Same 24 words with the last one swapped for another list word: the
        // words are all valid, so only the checksum catches it.
        let tampered = ZERO_ENTROPY_PHRASE.replace(" art", " zoo");
        assert!(matches!(
            RecoveryPhrase::parse(&tampered),
            Err(PhraseError::Invalid { .. })
        ));
    }

    #[test]
    fn the_settings_recheck_forgives_spacing_and_case_only() {
        let phrase = RecoveryPhrase::parse(ZERO_ENTROPY_PHRASE).expect("parses");
        assert!(phrase.matches(&format!("  {}  ", ZERO_ENTROPY_PHRASE.to_uppercase())));
        assert!(!phrase.matches(&ZERO_ENTROPY_PHRASE.replace(" art", " zoo")));
    }

    #[test]
    fn neither_secret_prints_itself() {
        let phrase = RecoveryPhrase::parse(ZERO_ENTROPY_PHRASE).expect("parses");
        assert_eq!(format!("{phrase:?}"), "RecoveryPhrase(<redacted>)");
        assert_eq!(format!("{:?}", phrase.seed()), "Seed(<redacted>)");
    }
}
