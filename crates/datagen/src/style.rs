//! The style grid: how a person types, one style per session.
//!
//! Terse, dictated (no punctuation), typos, long and polite, and a correction of the previous turn. A session has one
//! style; the writer is told it in the session's `style` line and the shares are flags. The realised share is
//! reported twice: how many sessions were given the style and how many messages really comply with it (the writer is
//! a model, so a check by words, not a promise).
//!
//! The test split has a style prompt set of its own, worded differently, that no other split's prompt holds: a model
//! trained on train and val has never read the sentence that asked for the test split's messages.

use crate::rng::Rng;

/// The styles, in the order of their shares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Style {
    Terse,
    Dictated,
    Typos,
    LongPolite,
    Correction,
}

pub const ALL: [Style; 5] = [
    Style::Terse,
    Style::Dictated,
    Style::Typos,
    Style::LongPolite,
    Style::Correction,
];

/// The shares of sessions, in the order of [`ALL`].
pub const DEFAULT_SHARES: [f64; 5] = [0.40, 0.15, 0.15, 0.15, 0.15];

impl Style {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Terse => "terse",
            Self::Dictated => "dictated",
            Self::Typos => "typos",
            Self::LongPolite => "long_polite",
            Self::Correction => "correction",
        }
    }

    #[must_use]
    pub fn of(name: &str) -> Option<Self> {
        ALL.into_iter().find(|s| s.name() == name)
    }

    /// What the writer is told for a session in this style. `test` picks the test split's own wording.
    #[must_use]
    pub const fn instruction(self, test: bool) -> &'static str {
        match (self, test) {
            (Self::Terse, false) => {
                "terse: fragments of 2 to 8 words, lowercase, no greeting, no please."
            }
            (Self::Terse, true) => {
                "curt and clipped: a few bare words per message, nothing polite, nothing extra."
            }
            (Self::Dictated, false) => {
                "dictated by voice: all lowercase, no punctuation at all (no commas, full stops or question marks), words run on like speech."
            }
            (Self::Dictated, true) => {
                "spoken aloud into the phone and transcribed: no capital letters and no punctuation marks, the way a voice transcript comes out."
            }
            (Self::Typos, false) => {
                "typed fast with thumbs: ordinary words, some letters swapped or dropped (a few slips per message), never inside the quoted words."
            }
            (Self::Typos, true) => {
                "hurried and sloppy: the odd mistyped word and a missing space, but still readable, and never inside the quoted words."
            }
            (Self::LongPolite, false) => {
                "long and polite: a full sentence of 12 to 25 words that says please or could you, and may add a short thanks."
            }
            (Self::LongPolite, true) => {
                "courteous and wordy: a complete sentence of a dozen words or more, with a polite opening such as would you mind."
            }
            (Self::Correction, false) => {
                "corrections: after the first message, each message corrects the one just before it (no, I meant ... / sorry, ...), while still asking exactly what its ask says."
            }
            (Self::Correction, true) => {
                "self-correcting: from the second message on, the person takes back their last message and restates it (actually ... / wait, I wanted ...), and the ask stays exactly what it says."
            }
        }
    }
}

/// The style of session `id` with `turns` turns: a pure function of the id and the seed, so a rebuild gives the same
/// one. A one-turn session has nothing to correct, so it is never a correction session.
#[must_use]
pub fn assign(shares: &[f64; 5], id: &str, turns: usize, seed: u64) -> Style {
    let mut w = *shares;
    if turns < 2 {
        w[4] = 0.0;
    }
    let total: f64 = w.iter().sum();
    if total <= 0.0 {
        return Style::Terse;
    }
    let mut rng = Rng::new(seed).fork("style").fork(id);
    let u = rng.unit() * total;
    let mut acc = 0.0;
    for (s, x) in ALL.iter().zip(w) {
        acc += x;
        if u < acc {
            return *s;
        }
    }
    Style::Terse
}

fn words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Does the session's text comply with its style? A mechanical check by words and marks. A typo style complies when
/// the message is not empty: the typos are made by the seeded pass, not by the writer.
#[must_use]
pub fn complies(style: Style, messages: &[String]) -> bool {
    match style {
        Style::Terse => messages.iter().all(|m| words(m) <= 10),
        Style::Dictated => messages
            .iter()
            .all(|m| !m.contains([',', '.', '?', '!', ';', ':'])),
        Style::Typos => true,
        Style::LongPolite => messages.iter().all(|m| {
            let l = m.to_lowercase();
            words(m) >= 10
                && [
                    "please",
                    "could you",
                    "would you",
                    "can you",
                    "thank",
                    "kindly",
                ]
                .iter()
                .any(|p| l.contains(p))
        }),
        Style::Correction => messages.iter().skip(1).all(|m| {
            let l = m.to_lowercase();
            [
                "no,", "no ", "sorry", "i meant", "actually", "wait", "i mean", "scratch",
            ]
            .iter()
            .any(|p| l.contains(p))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_style_is_a_pure_function_of_the_session_and_follows_the_shares() {
        assert_eq!(
            assign(&DEFAULT_SHARES, "train-00-001", 3, 1),
            assign(&DEFAULT_SHARES, "train-00-001", 3, 1)
        );
        let mut counts = [0_usize; 5];
        for i in 0..4000 {
            let s = assign(&DEFAULT_SHARES, &format!("s{i}"), 3, 1);
            counts[ALL.iter().position(|a| *a == s).unwrap()] += 1;
        }
        for (c, want) in counts.iter().zip(DEFAULT_SHARES) {
            let got = *c as f64 / 4000.0;
            assert!((got - want).abs() < 0.04, "{got} vs {want}");
        }
        // a one-turn session has nothing to correct
        assert!(
            (0..500).all(|i| assign(&DEFAULT_SHARES, &format!("o{i}"), 1, 1) != Style::Correction)
        );
    }

    #[test]
    fn the_test_split_has_prompt_wording_no_other_split_holds() {
        for s in ALL {
            assert_ne!(s.instruction(true), s.instruction(false), "{}", s.name());
        }
    }

    #[test]
    fn compliance_is_judged_by_words_and_marks() {
        let said = |m: &[&str]| m.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(complies(Style::Terse, &said(&["overdue tasks"])));
        assert!(!complies(
            Style::Dictated,
            &said(&["show my tasks, please"])
        ));
        assert!(complies(Style::Dictated, &said(&["show my tasks"])));
        assert!(complies(
            Style::LongPolite,
            &said(&["could you please show me all of the tasks that are overdue right now"])
        ));
        assert!(complies(
            Style::Correction,
            &said(&["overdue tasks", "no i meant done tasks"])
        ));
        assert!(!complies(
            Style::Correction,
            &said(&["a", "show done tasks"])
        ));
    }
}
