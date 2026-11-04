//! STAGE 4, THE TYPO PASS: a seeded Rust pass over the writer's text, the way thumbs mistype.
//!
//! It never touches what the runtime must read: the free-text spans the reference calls copy
//! (names, titles, notes), any word with a digit in it, the words that name a date or a period
//! ("last", "week", "march", "yesterday") and the verbs a turn acts with ("unstar", "undo"). Light
//! by default (about a third of messages carry one slip); [`Level::Heavy`] is the noise split's
//! copy of val.

use crate::rng::Rng;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Light,
    Heavy,
}

/// Words the runtime reads for dates and periods; a slip here would change what is asked.
const KEPT: &[&str] = &[
    "today",
    "tomorrow",
    "yesterday",
    "tonight",
    "week",
    "weeks",
    "month",
    "months",
    "year",
    "years",
    "last",
    "next",
    "this",
    "ago",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "weekend",
    "between",
    "from",
    "through",
    "until",
    "since",
    "before",
    "after",
    "around",
    "during",
    // the verbs a turn acts with: a slip in `unstar` reads as `star`
    "unstar",
    "star",
    "undo",
    "restore",
    "delete",
    "complete",
    "reopen",
    "cancel",
    "reschedule",
    "unlink",
    "archive",
    "revert",
];

const NEAR: &[(char, &str)] = &[
    ('a', "sqz"),
    ('b', "vgn"),
    ('c', "xvd"),
    ('d', "sfe"),
    ('e', "wrd"),
    ('f', "dgr"),
    ('g', "fht"),
    ('h', "gjy"),
    ('i', "uok"),
    ('j', "hku"),
    ('k', "jli"),
    ('l', "kop"),
    ('m', "nk"),
    ('n', "bmh"),
    ('o', "ipl"),
    ('p', "ol"),
    ('r', "etf"),
    ('s', "adw"),
    ('t', "ryg"),
    ('u', "yij"),
    ('v', "cbf"),
    ('w', "qes"),
    ('x', "zcs"),
    ('y', "tuh"),
    ('z', "xa"),
];

/// Byte ranges of every case-insensitive occurrence of each span.
fn protected(text: &str, spans: &[String]) -> Vec<(usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    for span in spans {
        let needle = span.to_ascii_lowercase();
        if needle.is_empty() {
            continue;
        }
        let mut from = 0;
        while let Some(at) = lower[from..].find(&needle) {
            out.push((from + at, from + at + needle.len()));
            from += at + needle.len();
        }
    }
    out
}

/// The word slips of `text`: `(start, end)` byte ranges of the words a slip may touch.
fn eligible(text: &str, spans: &[String]) -> Vec<(usize, usize)> {
    let keep = protected(text, spans);
    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    let mut digit = false;
    let close = |start: &mut Option<usize>, end: usize, digit: &mut bool, words: &mut Vec<_>| {
        if let Some(s) = start.take()
            && !*digit
        {
            words.push((s, end));
        }
        *digit = false;
    };
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() || c == '\'' {
            if start.is_none() {
                start = Some(i);
            }
            digit |= c.is_numeric();
        } else {
            close(&mut start, i, &mut digit, &mut words);
        }
    }
    close(&mut start, text.len(), &mut digit, &mut words);
    words
        .into_iter()
        .filter(|(s, e)| {
            let word = &text[*s..*e];
            word.chars().count() >= 4
                && word.chars().all(|c| c.is_ascii_alphabetic())
                && !KEPT.contains(&word.to_ascii_lowercase().as_str())
                && !keep.iter().any(|(a, b)| s < b && a < e)
        })
        .collect()
}

/// One slip in `word` (ASCII letters, at least four): the first letter stays.
fn slip(word: &str, rng: &mut Rng) -> String {
    let mut chars: Vec<char> = word.chars().collect();
    // never the last letter: "them" to "the" is a different word, not a slip
    let i = 1 + rng.below(chars.len() - 2);
    match rng.below(4) {
        0 => {
            chars.remove(i);
        }
        1 if i + 2 < chars.len() => chars.swap(i, i + 1),
        2 => chars.insert(i, chars[i]),
        _ => {
            let lower = chars[i].to_ascii_lowercase();
            if let Some((_, near)) = NEAR.iter().find(|(c, _)| *c == lower) {
                let pick: Vec<char> = near.chars().collect();
                chars[i] = *rng.pick(&pick);
            } else {
                chars.remove(i);
            }
        }
    }
    chars.into_iter().collect()
}

/// `text` with slips at `level`, leaving `spans` and date words alone.
#[must_use]
pub fn apply(text: &str, spans: &[String], rng: &mut Rng, level: Level) -> String {
    let words = eligible(text, spans);
    if words.is_empty() {
        return text.to_owned();
    }
    let count = match level {
        Level::Light => {
            if rng.chance(0.33) {
                1 + usize::from(words.len() > 5 && rng.chance(0.2))
            } else {
                0
            }
        }
        Level::Heavy => {
            let n = words.iter().filter(|_| rng.chance(0.45)).count();
            n.max(2.min(words.len()))
        }
    };
    let mut picks = rng.sample(words.len(), count);
    picks.sort_unstable();
    let mut out = String::new();
    let mut at = 0;
    for p in picks {
        let (s, e) = words[p];
        out.push_str(&text[at..s]);
        out.push_str(&slip(&text[s..e], rng));
        at = e;
    }
    out.push_str(&text[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_dates_and_numbers_survive_even_heavy_noise() {
        let spans = vec!["Fix the bike light".to_owned()];
        let text = "rename fix the bike light to something longer yesterday, 45 km over march";
        for seed in 0..200 {
            let out = apply(text, &spans, &mut Rng::new(seed), Level::Heavy);
            assert!(out.to_lowercase().contains("fix the bike light"), "{out}");
            for kept in ["yesterday", "45", "km", "march"] {
                assert!(out.contains(kept), "{out}");
            }
        }
    }

    #[test]
    fn a_seed_is_a_message() {
        let text = "what is due this week for the garden project";
        assert_eq!(
            apply(text, &[], &mut Rng::new(3), Level::Light),
            apply(text, &[], &mut Rng::new(3), Level::Light)
        );
        let heavy = apply(text, &[], &mut Rng::new(3), Level::Heavy);
        assert_ne!(heavy, text);
    }

    #[test]
    fn light_noise_touches_a_minority_of_messages() {
        let text = "show me the overdue tasks about the garden";
        let hit = (0..300)
            .filter(|s| apply(text, &[], &mut Rng::new(*s), Level::Light) != text)
            .count();
        assert!((40..160).contains(&hit), "{hit}");
    }
}
