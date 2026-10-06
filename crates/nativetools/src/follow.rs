//! "WHAT ELSE": a follow-up that asks for the rest leaves out what was just shown (D-1044-8).
//!
//! A message with an else/other/after cue ("what else", "anything else", "the other ones", "the
//! one after", "next one after that", "besides X", "apart from X", "not the X") asks for rows
//! the previous answer did not show. The trained model writes the read again without the
//! `exclude` slot and gets the same rows back, so the harness composes the exclusion
//! (`Session::exclusion`, run by `Session::conventions`): the previous result as `@n`, or, for
//! "besides X", the one row of the focus line whose name fits X. A message that re-asks the same
//! thing with no cue is never touched, and neither is a call that states its own `exclude`.

use serde_json::Value;

use crate::meta::Kind;
use crate::session::{Session, words};

/// Words after "other" that make it part of a date or a figure of speech, not a cue.
const OTHER_NOT: [&str; 12] = [
    "day", "days", "week", "weeks", "month", "year", "hand", "than", "time", "times", "way", "side",
];
/// Words that start a name without being part of it ("besides the dentist").
const FILLER: [&str; 9] = ["the", "a", "an", "my", "this", "that", "one", "ones", "our"];

/// What the message asks to leave out.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Cue {
    /// "what else", "the other ones", "the one after": what was shown.
    Shown,
    /// "besides X", "apart from X", "not the X": the row named, or else what was shown.
    Named { words: Vec<String>, fallback: bool },
}

/// Whether the "other" at `tokens[at]` asks for more ("the other ones", "other events"), not a
/// date or a figure of speech ("the other day", "one or the other", "on the other hand").
fn says_other(tokens: &[String], at: usize) -> bool {
    let next = tokens.get(at + 1).map(String::as_str);
    let prev = at.checked_sub(1).map(|back| tokens[back].as_str());
    let either =
        prev == Some("the") && at >= 2 && matches!(tokens[at - 2].as_str(), "or" | "and" | "one");
    !(next.is_some_and(|next| OTHER_NOT.contains(&next))
        || matches!(prev, Some("each" | "one" | "every"))
        || either)
}

/// The cue the message carries, if any.
pub(crate) fn cue(tokens: &[String]) -> Option<Cue> {
    for (at, word) in tokens.iter().enumerate() {
        let next = tokens.get(at + 1).map(String::as_str);
        let prev = at.checked_sub(1).map(|back| tokens[back].as_str());
        let named = |from: usize, fallback: bool| Cue::Named {
            words: tokens[from.min(tokens.len())..].to_vec(),
            fallback,
        };
        match word.as_str() {
            "else" if prev != Some("or") => return Some(Cue::Shown),
            "others" => return Some(Cue::Shown),
            "other" if says_other(tokens, at) => return Some(Cue::Shown),
            "after" if matches!(prev, Some("one" | "ones")) => return Some(Cue::Shown),
            "besides" | "except" => return Some(named(at + 1, true)),
            "apart" | "aside" if next == Some("from") => return Some(named(at + 2, true)),
            "not" if matches!(next, Some("the" | "my" | "this" | "that")) => {
                return Some(named(at + 1, false));
            }
            _ => {}
        }
    }
    None
}

/// How many words of what follows "besides" are looked at for a name.
const NAME_WORDS: usize = 4;

impl Session {
    /// The handles a follow-up with a cue leaves out of a read of `kinds`, and the note that says
    /// so: `["@2", "#5"]` and `(excluding @2, #5)`.
    ///
    /// WHAT THE CONVERSATION HAS ALREADY PUT IN PLAY, for rows of the call's kind (a row of
    /// another kind is never left out): the last result of the previous turn that holds such
    /// rows (a turn that wrote showed no answer to go on from, so only its written rows count),
    /// the options of the ask that ended the previous turn, the rows the previous turn's write
    /// created or changed, and the row the message or the message before it names. "besides X"
    /// names a focus row and leaves out that one in place of the previous result.
    pub(crate) fn exclusion(
        &self,
        tokens: &[String],
        kinds: &[Kind],
    ) -> Option<(Vec<String>, String)> {
        let cue = cue(tokens)?;
        let mut named_focus = None;
        if let Cue::Named { words, fallback } = &cue {
            named_focus = self.focus_row_named(words, kinds);
            if named_focus.is_none() && !fallback {
                return None;
            }
        }
        let mut handles: Vec<String> = Vec::new();
        let mut numbers: Vec<usize> = Vec::new();
        let mut covered: Vec<usize> = Vec::new();
        if let Some(number) = named_focus {
            numbers.push(number);
        } else if let Some(handle) = self.previous_result(kinds) {
            handles.push(format!("@{handle}"));
            if let Some(result) = self.results.get(handle - 1) {
                covered = result
                    .keys
                    .iter()
                    .filter_map(|key| self.numbers.get(key).copied())
                    .collect();
            }
        }
        numbers.extend(self.put_in_play(kinds));
        for number in numbers {
            let handle = format!("#{number}");
            if !covered.contains(&number) && !handles.contains(&handle) {
                handles.push(handle);
            }
        }
        if handles.is_empty() {
            return None;
        }
        let note = format!("(excluding {})", handles.join(", "));
        Some((handles, note))
    }

    /// The `#n` of the rows of `kinds` the previous turn put in play besides its result: the
    /// options of the ask that ended it, the rows its write created or changed, and the rows the
    /// message or the message before it names by a whole name of their own.
    fn put_in_play(&self, kinds: &[Kind]) -> Vec<usize> {
        let of_kind = |number: usize| {
            self.by_number
                .get(number.wrapping_sub(1))
                .and_then(|key| self.world.row(key))
                .is_some_and(|row| kinds.contains(&row.kind))
        };
        let mut out: Vec<usize> = Vec::new();
        let add = |number: usize, out: &mut Vec<usize>| {
            if of_kind(number) && !out.contains(&number) {
                out.push(number);
            }
        };
        let (asked_turn, options) = &self.last_ask;
        if asked_turn + 1 == self.turn {
            for number in options {
                add(*number, &mut out);
            }
        }
        for mark in &self.marks {
            if mark.written && mark.turn + 1 == self.turn {
                add(mark.number, &mut out);
            }
        }
        // THE ROW A MESSAGE NAMES: a live row of the kind that has one whole name (or a person's
        // nickname) the message says word for word, when no other live row of the kind answers
        // to that name (a recurring series is no one row).
        let said: std::collections::BTreeSet<String> =
            crate::search::spellings_of(&format!("{} {}", self.prev_message, self.message))
                .into_iter()
                .collect();
        for row in self.world.rows.values() {
            if row.trashed || !kinds.contains(&row.kind) {
                continue;
            }
            let named = crate::search::aliases(row).into_iter().any(|alias| {
                let tokens = crate::search::spoken_tokens(alias);
                let words = words(alias);
                !tokens.is_empty()
                    && (words.len() > 1 || words.iter().any(|word| word.chars().count() >= 4))
                    && tokens
                        .iter()
                        .all(|token| token.is_among(true, |word| said.contains(word)))
            });
            if !named {
                continue;
            }
            let twins = self
                .world
                .of_kind(row.kind)
                .filter(|other| !other.trashed && other.name == row.name)
                .count();
            if twins == 1
                && let Some(number) = self.numbers.get(&row.key())
            {
                add(*number, &mut out);
            }
        }
        out
    }

    /// The `@n` of the result a READ of the previous turn ended on, when it holds rows of one of `kinds`.
    fn previous_result(&self, kinds: &[Kind]) -> Option<usize> {
        // a turn that wrote (or asked) showed no answer to go on from: "pin X and Y", then "what
        // else is pinned": the written rows are left out by number (`put_in_play`), not the
        // lookups the write was made from
        let wrote = self.writes.iter().any(|(turn, _, _)| turn + 1 == self.turn)
            || self.marks.iter().any(|mark| mark.turn + 1 == self.turn);
        if wrote {
            return None;
        }
        self.observations
            .iter()
            .rev()
            .filter(|obs| obs.result && obs.turn + 1 == self.turn)
            .filter_map(|obs| obs.handle)
            .find(|handle| {
                self.results.get(handle - 1).is_some_and(|result| {
                    !result.keys.is_empty() && result.kinds.iter().any(|kind| kinds.contains(kind))
                })
            })
    }

    /// The `#n` of the one focus row of `kinds` whose name fits `words` ("the dentist" fits
    /// "Dentist appointment"); the longest run of words that fits any row decides, and two rows
    /// that fit it are no answer.
    fn focus_row_named(&self, words_after: &[String], kinds: &[Kind]) -> Option<usize> {
        let line = crate::prompt::focus_line(self)?;
        let mut rows: Vec<(usize, Vec<String>)> = Vec::new();
        let mut rest = line.as_str();
        while let Some(at) = rest.find('#') {
            let digits: String = rest[at + 1..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            rest = &rest[at + 1 + digits.len()..];
            let Ok(number) = digits.parse::<usize>() else {
                continue;
            };
            let Some(row) = self
                .by_number
                .get(number.wrapping_sub(1))
                .and_then(|key| self.world.row(key))
            else {
                continue;
            };
            if kinds.contains(&row.kind) && !rows.iter().any(|(have, _)| *have == number) {
                rows.push((number, words(&row.name)));
            }
        }
        let after: Vec<String> = words_after
            .iter()
            .take(NAME_WORDS)
            .skip_while(|word| FILLER.contains(&word.as_str()))
            .cloned()
            .collect();
        for len in (1..=after.len()).rev() {
            let wanted: Vec<&String> = after[..len]
                .iter()
                .filter(|word| !FILLER.contains(&word.as_str()))
                .collect();
            if wanted.is_empty() {
                continue;
            }
            let fits: Vec<usize> = rows
                .iter()
                .filter(|(_, name)| {
                    wanted
                        .iter()
                        .all(|word| name.iter().any(|have| have.starts_with(word.as_str())))
                })
                .map(|(number, _)| *number)
                .collect();
            match fits.as_slice() {
                [] => {}
                [only] => return Some(*only),
                _ => return None,
            }
        }
        None
    }
}

/// The default a note of a grounded call names, when it names one this module records.
fn default_of(note: &str) -> Option<&'static str> {
    if note.starts_with("(excluding ") {
        Some("exclude")
    } else if note.starts_with("next:") {
        Some("next")
    } else if note.starts_with("last:") {
        Some("last")
    } else {
        None
    }
}

/// The notes of a grounded call that say a default filled a slot.
pub(crate) fn default_notes(notes: &[String]) -> Vec<String> {
    notes
        .iter()
        .filter(|note| default_of(note).is_some())
        .cloned()
        .collect()
}

/// The `normalized` entries that record those defaults, as the effect lists a repair.
pub(crate) fn default_entries(notes: &[String]) -> Vec<Value> {
    notes
        .iter()
        .filter_map(|note| {
            let name = default_of(note)?;
            Some(serde_json::json!({"rule": "default", "default": name, "note": note}))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(message: &str) -> Vec<String> {
        words(message)
    }

    #[test]
    fn the_cues_are_read_from_the_words() {
        for message in [
            "what else is there",
            "anything else",
            "the other ones",
            "other events please",
            "the one after",
            "and the next one after that",
        ] {
            assert_eq!(cue(&tokens(message)), Some(Cue::Shown), "{message}");
        }
        for message in [
            "what's on the other day",
            "one or the other",
            "or else",
            "what's on after friday",
            "when's the next standup",
        ] {
            assert_eq!(cue(&tokens(message)), None, "{message}");
        }
    }

    #[test]
    fn a_named_cue_carries_the_words_after_it() {
        assert_eq!(
            cue(&tokens("anything besides the dentist")),
            Some(Cue::Named {
                words: vec!["the".into(), "dentist".into()],
                fallback: true
            })
        );
        assert_eq!(
            cue(&tokens("apart from lunch")),
            Some(Cue::Named {
                words: vec!["lunch".into()],
                fallback: true
            })
        );
        assert_eq!(
            cue(&tokens("not the dentist")),
            Some(Cue::Named {
                words: vec!["the".into(), "dentist".into()],
                fallback: false
            })
        );
    }
}
