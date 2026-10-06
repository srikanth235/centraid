//! The one fuzzy name resolver (nt11 R1; SPEC §3.3, "A name is resolved in tiers"). The model
//! does the language, the runtime resolves what is deterministic: a name the person said and the
//! names the vault has meet here, in memory, and nowhere else.
//!
//! Both sides are folded first: case, accents, punctuation, the runs of hyphens, underscores
//! and spaces (`Mother-in-law` is `mother in law`), a possessive `'s` and the apostrophes inside
//! a word (`O'Brien's`). The tiers, the first non-empty one wins:
//!
//! 1. `Equal`: the same after folding (`mother in law`, `Mother-in-law`, `motherinlaw`).
//! 2. `Words`: the same words in any order (`Weiss Benedikt` for `Benedikt Weiss`).
//! 3. `Contains`: every word the person said is a word of the name or the start of one
//!    (`house` for `Beach House 2026`; three letters or more for a start; an article aside).
//!    It is read in two steps, as a name was before tiers: the rows that have every word said
//!    as a whole word, and only when there are none, the rows that have a word's start, so
//!    `Sami` is the two people called Sami and not `Samira` while no one is called Sami.
//! 4. `Typo`: as 3, and each word that does not match is of four letters or more and one edit
//!    from a word of the name (one letter more, fewer or different, or two letters swapped:
//!    Damerau distance, not trigram similarity). Words with a digit are never a typo.
//!
//! Under tier 4 sits one more reading (nt13 R3, `Rank::Light`, off with `--no-normalize`): when
//! nothing better is reached, both sides drop the honorifics (`-san -sama -kun -chan -sensei
//! -ji`, and `dr mr mrs ms prof` as the first word) and compare light stems (`renewal` and
//! `renew`, `booking` and `book`), every word said being a word of the name. It is a tier-4
//! read, so it is said (`matched "Renew passport" for "passport renewal"`) and a write acts on
//! it only when exactly one row is reached.
//!
//! A row answers to its name and, for a person, their nickname: its tier is the best of those.
//! `matches` are the rows of the best tier alone, which is what a write takes; a read takes
//! `reached_all`, the rows of tiers 1 to 3 together (nt10 returned them all, and no read returns
//! fewer rows than it did), or the typo's rows when no row reaches better.

use std::collections::BTreeSet;

use crate::search::{Spoken, aliases, fold, is_apostrophe, spellings_of, spoken_tokens};
use crate::session::Session;
use crate::world::{Key, Row};

/// The shortest prefix of a name word a person's word may be (`kit` for `kitchen`, never `ki`).
const PREFIX_MIN: usize = 3;

/// The shortest word a typo is read in.
const TYPO_MIN: usize = 4;

/// How a name was reached; the lower, the better.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    /// The same after folding.
    Equal = 1,
    /// The same words in any order.
    Words = 2,
    /// Every word said is a word of the name or the start of one.
    Contains = 3,
    /// As `Contains`, with a word one edit from a word of the name.
    Typo = 4,
}

/// How a name was reached, finer than a tier where it matters: tier 3 is read in two steps, as a
/// name was before tiers (every word said is a word of the name, and only then a word's start),
/// so `Sami` is the two people called Sami and not also `Samira`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    Equal,
    Words,
    /// Every word said is a whole word of the name.
    Whole,
    /// Every word said is a whole word of the name or the start of one.
    Start,
    /// Every word said, honorifics dropped and as a light stem, is a word of the name.
    Light,
    Typo,
}

impl Rank {
    fn tier(self) -> Tier {
        match self {
            Self::Equal => Tier::Equal,
            Self::Words => Tier::Words,
            Self::Whole | Self::Start => Tier::Contains,
            Self::Light | Self::Typo => Tier::Typo,
        }
    }
}

/// What `resolve` found: the best tier any candidate reaches and the candidates at that tier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution<T> {
    /// `None` when no candidate reaches any tier.
    pub tier: Option<Tier>,
    /// The candidates of the best tier, in the order given: what a write takes.
    pub matches: Vec<T>,
    /// What a read takes: every candidate that has all the words said as words of its name, or
    /// better, when one does (a read of `house` shows `Beach House 2026` beside `House`, as it
    /// always did); else the candidates of the best tier (a word's start, a typo).
    pub reached_all: Vec<T>,
    /// For each match, the name it answered by.
    pub named: Vec<String>,
}

impl<T> Resolution<T> {
    fn none() -> Self {
        Self {
            tier: None,
            matches: Vec::new(),
            reached_all: Vec::new(),
            named: Vec::new(),
        }
    }

    /// Whether the best tier is a typo: a read says so, a write asks.
    #[must_use]
    pub fn is_typo(&self) -> bool {
        self.tier == Some(Tier::Typo)
    }

    /// The matches when they are no typo's: the rows a name reaches as it is said.
    #[must_use]
    pub fn reached(&self) -> &[T] {
        if self.is_typo() { &[] } else { &self.matches }
    }

    /// The line a read adds when its rows are a typo's: `matched "Farrukh Kasimov" for "Farukh"`.
    #[must_use]
    pub fn typo_line(&self, query: &str) -> Option<String> {
        if !self.is_typo() {
            return None;
        }
        let mut names: Vec<&str> = Vec::new();
        for name in &self.named {
            if !names.contains(&name.as_str()) {
                names.push(name);
            }
        }
        let names: Vec<String> = names.iter().map(|name| format!("\"{name}\"")).collect();
        Some(format!("matched {} for \"{query}\"", names.join(", ")))
    }
}

/// A query read once: its folded forms and its words.
struct Query {
    /// The light stems of the words said, honorifics dropped (nt13 R3); empty when the reading
    /// is off or nothing is left to say.
    light: Vec<String>,
    /// Each folded form: the words of the text with its possessive dropped, and with it kept.
    forms: Vec<Vec<String>>,
    /// The words an article aside, as `Spoken` (a word with a joiner reads as its parts or the
    /// one word they make).
    tokens: Vec<Spoken>,
}

/// The folded words of a text: possessive `'s` dropped or not as `possessive` says, the
/// apostrophes inside a word gone (`obriens`), everything else that is no letter or digit a
/// separator, so a hyphen, an underscore and a space are one.
fn folded_words(text: &str, possessive: bool) -> Vec<String> {
    let text = if possessive {
        crate::search::without_possessive(text)
    } else {
        text.to_owned()
    };
    let text: String = fold(&text)
        .chars()
        .filter(|letter| !is_apostrophe(*letter))
        .collect();
    text.split(|letter: char| !letter.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The folded forms of a text, without a repeat.
fn forms_of(text: &str) -> Vec<Vec<String>> {
    let mut forms = vec![folded_words(text, true)];
    let kept = folded_words(text, false);
    if !forms.contains(&kept) {
        forms.push(kept);
    }
    forms.retain(|form| !form.is_empty());
    forms
}

/// The words of a query that name something: an article aside unless it is all the person said.
fn fit_tokens(text: &str) -> Vec<Spoken> {
    let mut tokens = spoken_tokens(text);
    if tokens.iter().any(|token| !token.is_article()) {
        tokens.retain(|token| !token.is_article());
    }
    tokens
}

impl Query {
    fn new(text: &str, light: bool) -> Self {
        Self {
            light: if light { light_stems(text) } else { Vec::new() },
            forms: forms_of(text),
            tokens: fit_tokens(text),
        }
    }
}

/// The honorifics said after a name (`Tanaka-san`).
const HONORIFIC_SUFFIXES: [&str; 6] = ["san", "sama", "kun", "chan", "sensei", "ji"];
/// The honorifics said before a name (`Dr. Rao`).
const HONORIFIC_TITLES: [&str; 5] = ["dr", "mr", "mrs", "ms", "prof"];

/// The words of a text, honorifics dropped: a title as the first word, a suffix after one. A
/// text that is only an honorific keeps it (it is that name).
fn without_honorifics(text: &str) -> Vec<String> {
    let words = folded_words(text, true);
    let kept: Vec<String> = words
        .iter()
        .enumerate()
        .filter(|(at, word)| {
            !((*at == 0 && HONORIFIC_TITLES.contains(&word.as_str()))
                || (*at > 0 && HONORIFIC_SUFFIXES.contains(&word.as_str())))
        })
        .map(|(_, word)| word.clone())
        .collect();
    if kept.is_empty() { words } else { kept }
}

/// A word reduced for telling one form of it from another (nt13 R3): a plural, a past tense or
/// an `-ing` first (three letters stay), then `-ation`, `-ment`, `-er` or `-al` from a stem of
/// four letters or more (`renewal` is `renew`, `payment` stays), then a final `e`.
fn light_stem(word: &str) -> String {
    let count = |text: &str| text.chars().count();
    let mut out = word;
    for suffix in ["ings", "ing", "ed", "es", "s"] {
        if let Some(rest) = out.strip_suffix(suffix)
            && count(rest) >= 3
            // `es` is a plural only after a sibilant (`boxes`, `wishes`); else the `s` is
            && (suffix != "es" || rest.ends_with(['s', 'x', 'z']) || rest.ends_with("ch") || rest.ends_with("sh"))
        {
            out = rest;
            break;
        }
    }
    for suffix in ["ation", "ment", "er", "al"] {
        if let Some(rest) = out.strip_suffix(suffix)
            && count(rest) >= 4
        {
            out = rest;
            break;
        }
    }
    match out.strip_suffix('e') {
        Some(rest) if count(rest) >= 3 => rest.to_owned(),
        _ => out.to_owned(),
    }
}

/// The light stems of the words of a text, honorifics dropped.
fn light_stems(text: &str) -> Vec<String> {
    without_honorifics(text)
        .iter()
        .map(|word| light_stem(word))
        .collect()
}

/// Whether `word` is `have` or begins it (three letters or more).
fn starts_alike(word: &str, have: &str) -> bool {
    word == have || (word.chars().count() >= PREFIX_MIN && have.starts_with(word))
}

/// Whether two words are one edit apart: a letter more, fewer or different, or two neighbours
/// swapped. The word said is of `TYPO_MIN` letters or more and has no digit.
pub(crate) fn one_edit(word: &str, have: &str) -> bool {
    if word.chars().count() < TYPO_MIN
        || have.chars().count() < PREFIX_MIN
        || !word.chars().all(char::is_alphabetic)
    {
        return false;
    }
    within_one(word, have)
}

/// Whether two texts are one edit apart, whatever their length (`one_edit` without its limits:
/// a currency code of three letters is read with it).
pub(crate) fn within_one(word: &str, have: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (word.chars().collect(), have.chars().collect());
    if a == b || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    match a.len().cmp(&b.len()) {
        std::cmp::Ordering::Equal => {
            let after = common + 1;
            a[after..] == b[after..]
                || (a.len() > after
                    && a[common] == b[after]
                    && a[after] == b[common]
                    && a[after + 1..] == b[after + 1..])
        }
        std::cmp::Ordering::Greater => a[common + 1..] == b[common..],
        std::cmp::Ordering::Less => a[common..] == b[common + 1..],
    }
}

/// How a literal a person wrote reads a text value of a row (nt13 R2), best first: `0` the same
/// after folding (case, hyphens, spaces: `mother in law` is `Mother-in-law`), `1` the same with
/// one word one edit off (`landlrod`), `2` every word of the value inside the literal (the
/// literal carries an extra qualifier: `lease landlord` for `landlord`). `None` when it does
/// not read it.
#[must_use]
pub(crate) fn text_reading(literal: &str, value: &str) -> Option<u8> {
    let (said, have) = (folded_words(literal, true), folded_words(value, true));
    if said.is_empty() || have.is_empty() {
        return None;
    }
    if said == have || said.concat() == have.concat() {
        return Some(0);
    }
    if said.len() == have.len() {
        let off: Vec<(&String, &String)> = said.iter().zip(&have).filter(|(a, b)| a != b).collect();
        if let [(a, b)] = off.as_slice()
            && one_edit(a, b)
        {
            return Some(1);
        }
    }
    (said.len() > have.len() && have.iter().all(|word| said.contains(word))).then_some(2)
}

/// The best rank a name (one of a row's) reaches for a query, if any.
fn rank_of(query: &Query, name: &str) -> Option<Rank> {
    let plain = plain_rank_of(query, name);
    if plain.is_some_and(|rank| rank < Rank::Light) || query.light.is_empty() {
        return plain;
    }
    let have = light_stems(name);
    if query.light.iter().all(|stem| have.contains(stem)) {
        Some(Rank::Light)
    } else {
        plain
    }
}

fn plain_rank_of(query: &Query, name: &str) -> Option<Rank> {
    let forms = forms_of(name);
    if forms.is_empty() || query.forms.is_empty() {
        return None;
    }
    let squashed = |form: &Vec<String>| form.concat();
    if query.forms.iter().any(|said| {
        forms
            .iter()
            .any(|have| said == have || squashed(said) == squashed(have))
    }) {
        return Some(Rank::Equal);
    }
    let sorted = |form: &Vec<String>| {
        let mut words = form.clone();
        words.sort();
        words
    };
    if query
        .forms
        .iter()
        .any(|said| forms.iter().any(|have| sorted(said) == sorted(have)))
    {
        return Some(Rank::Words);
    }
    if query.tokens.is_empty() {
        return None;
    }
    let have = spellings_of(name);
    let reads = |reaches: &dyn Fn(&str, &str) -> bool| {
        query
            .tokens
            .iter()
            .all(|token| token.is_among(true, |word| have.iter().any(|name| reaches(word, name))))
    };
    if reads(&|word, name| word == name) {
        Some(Rank::Whole)
    } else if reads(&|word, name| starts_alike(word, name)) {
        Some(Rank::Start)
    } else if reads(&|word, name| starts_alike(word, name) || one_edit(word, name)) {
        Some(Rank::Typo)
    } else {
        None
    }
}

/// THE RESOLVER. The candidates are anything a name can be said of, each with every name it
/// answers to; the matches are the candidates of the best tier any of them reaches.
#[must_use]
pub fn resolve<T: Clone, S: AsRef<str>>(query: &str, candidates: &[(T, Vec<S>)]) -> Resolution<T> {
    resolve_with(query, candidates, true)
}

/// `resolve`, with the light reading of honorifics and stems (nt13 R3) on or off: a session that
/// does not normalise (`--no-normalize`, the replay of an author's call) reads names without it.
#[must_use]
pub fn resolve_with<T: Clone, S: AsRef<str>>(
    query: &str,
    candidates: &[(T, Vec<S>)],
    light: bool,
) -> Resolution<T> {
    let query = Query::new(query, light);
    let mut best: Option<Rank> = None;
    let mut found: Vec<(T, String, Rank)> = Vec::new();
    for (item, names) in candidates {
        let reached = names
            .iter()
            .filter_map(|name| rank_of(&query, name.as_ref()).map(|rank| (rank, name.as_ref())))
            .min_by_key(|(rank, _)| *rank);
        if let Some((rank, name)) = reached {
            best = Some(best.map_or(rank, |have| have.min(rank)));
            found.push((item.clone(), name.to_owned(), rank));
        }
    }
    let Some(best) = best else {
        return Resolution::none();
    };
    let mut out = Resolution {
        tier: Some(best.tier()),
        matches: Vec::new(),
        reached_all: Vec::new(),
        named: Vec::new(),
    };
    for (item, name, rank) in found {
        if (best <= Rank::Whole && rank <= Rank::Whole) || rank == best {
            out.reached_all.push(item.clone());
        }
        if rank == best {
            out.matches.push(item);
            out.named.push(name);
        }
    }
    out
}

/// The rows of `pool` a name resolves to: each answers to its name and a person's nickname.
#[must_use]
pub(crate) fn resolve_rows<'a>(
    query: &str,
    rows: impl IntoIterator<Item = &'a Row>,
    light: bool,
) -> Resolution<Key> {
    let candidates: Vec<(Key, Vec<&str>)> = rows
        .into_iter()
        .map(|row| (row.key(), aliases(row)))
        .collect();
    resolve_with(query, &candidates, light)
}

impl Session {
    /// The live (or trashed) rows of `kinds`, and of `within` when it is given, that a name
    /// resolves to.
    pub(crate) fn resolve_name(
        &self,
        name: &str,
        kinds: &[crate::meta::Kind],
        trashed: bool,
        within: Option<&BTreeSet<Key>>,
    ) -> Resolution<Key> {
        resolve_rows(
            name,
            self.world.rows.values().filter(|row| {
                row.trashed == trashed
                    && kinds.contains(&row.kind)
                    && within.is_none_or(|scope| scope.contains(&row.key()))
            }),
            self.flags.normalize,
        )
    }
}

/// The stem of a word, for telling one word from another form of it: a plural ("tires"), a past
/// tense ("rotated") and a noun of the verb ("rotation") share one. A suffix comes off only when
/// four letters are left.
fn stem(word: &str) -> &str {
    const SUFFIXES: [&str; 11] = [
        "ations", "ation", "ings", "ing", "ions", "ion", "ated", "ates", "ed", "es", "s",
    ];
    let mut out = word;
    if let Some(rest) = SUFFIXES
        .iter()
        .filter_map(|suffix| out.strip_suffix(suffix))
        .find(|rest| rest.chars().count() >= 4)
    {
        out = rest;
    }
    match out.strip_suffix('e') {
        Some(rest) if rest.chars().count() >= 4 => rest,
        _ => out,
    }
}

/// A word of a name that a message word stands for: the same, the same word in another form
/// ("tire" / "tires", "rotation" / "rotated"), one letter off in a word of five or more that
/// starts alike ("aadhar" / "aadhaar"; "dental" is not "rental"), or the digits of a numbered
/// name ("9" / "9b", never "3" for "30"). The word-level test of a message against a row's
/// name (`act::ambiguous_pick`), where the tiers are for a name the call states.
#[must_use]
pub(crate) fn word_near(name: &str, word: &str) -> bool {
    if name == word {
        return true;
    }
    if word.chars().all(|c| c.is_ascii_digit()) {
        return name.strip_prefix(word).is_some_and(|rest| {
            let mut letters = rest.chars();
            matches!((letters.next(), letters.next()), (Some(c), None) if c.is_alphabetic())
        });
    }
    let (stem_name, stem_word) = (stem(name), stem(word));
    if stem_name == stem_word && stem_name.chars().count() >= 4 {
        return true;
    }
    if name.chars().count() < 5 || word.chars().count() < 5 {
        return false;
    }
    let (a, b): (Vec<char>, Vec<char>) = (name.chars().collect(), word.chars().collect());
    if a.len().abs_diff(b.len()) > 1 || a[0] != b[0] {
        return false;
    }
    // one substitution, insertion or deletion
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let tail = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    common + tail + 1 >= a.len().max(b.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tier(query: &str, name: &str) -> Option<Tier> {
        resolve(query, &[(0, vec![name])]).tier
    }

    #[test]
    fn the_tiers_of_a_name() {
        assert_eq!(tier("mother in law", "Mother-in-law"), Some(Tier::Equal));
        assert_eq!(tier("motherinlaw", "Mother-in-law"), Some(Tier::Equal));
        assert_eq!(tier("Lucia", "Lucía"), Some(Tier::Equal));
        assert_eq!(tier("gomez lucia", "Lucía Gómez"), Some(Tier::Words));
        assert_eq!(tier("Lucia", "Lucía Gómez"), Some(Tier::Contains));
        assert_eq!(tier("house", "Beach House 2026"), Some(Tier::Contains));
        assert_eq!(
            tier("Lucia's recital", "Lucía's winter ballet recital"),
            Some(Tier::Contains)
        );
        assert_eq!(tier("Luc", "Lucía Gómez"), Some(Tier::Contains)); // a start of three letters
        assert_eq!(tier("Lu", "Lucía Gómez"), None);
        assert_eq!(tier("Amma", "Ama"), Some(Tier::Typo));
        assert_eq!(tier("Farukh Kasimov", "Farrukh Kasimov"), Some(Tier::Typo));
        assert_eq!(tier("house 2025", "Beach House 2026"), None);
        assert_eq!(tier("", "Lucía"), None);
    }

    #[test]
    fn the_best_tier_alone_is_kept() {
        let rows = [(1, vec!["Beach House 2026"]), (2, vec!["House"])];
        let found = resolve("house", &rows);
        assert_eq!((found.tier, found.matches), (Some(Tier::Equal), vec![2]));
    }

    #[test]
    fn one_edit_reads_a_slip_of_one_letter_and_a_swap() {
        assert!(one_edit("farukh", "farrukh")); // a letter fewer
        assert!(one_edit("benedict", "benedikt")); // a letter different
        assert!(one_edit("amma", "ama")); // a letter more
        assert!(one_edit("ochao", "ochoa")); // two swapped
        assert!(!one_edit("amma", "amma"));
        assert!(!one_edit("rental", "dentals"));
        assert!(!one_edit("2025", "2026")); // a digit is no typo
        assert!(!one_edit("abc", "abd")); // under four letters
    }

    #[test]
    fn near_reads_a_slip_of_one_letter() {
        assert!(word_near("aadhaar", "aadhar")); // an insertion
        assert!(word_near("9b", "9")); // the digits of a numbered name
    }

    #[test]
    fn near_reads_one_word_in_another_form() {
        assert!(word_near("tires", "tire"));
        assert!(word_near("rotated", "rotation"));
        assert!(word_near("rotation", "rotated"));
        assert!(word_near("sundays", "sunday"));
        // not a form of one word
        assert!(!word_near("planner", "plant"));
    }

    #[test]
    fn near_does_not_read_another_word() {
        assert!(!word_near("rental", "dental"));
        assert!(!word_near("dental", "mental"));
        assert!(!word_near("test", "text"));
    }

    #[test]
    fn near_does_not_read_a_digit_as_the_start_of_a_longer_number() {
        assert!(!word_near("30", "3"));
        assert!(!word_near("312", "3"));
    }
}
