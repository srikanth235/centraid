//! `search` and the pre-grounding block (SPEC §3, §4, §6.1): one name index.
//!
//! Resolving a name a call states to rows is `resolve.rs`; this module is the retrieval around
//! it. Text is lower-cased with accents folded (`Lucia` is `Lucía`), and a person answers to their
//! nickname as to their name.
//!
//! `search` ranks by retrieval, not interpretation: the vault's FTS door
//! (`crates/search`, prefix phrases over each domain's label and indexed
//! text) plus a whole-word / prefix / one-edit match over every model row's
//! name, so kinds the FTS door does not index (groups, albums, locker items)
//! are found the same way. The pre-grounding block reads the name index
//! alone: a word or the start of a word of a row's name or a person's nickname.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::meta::{Kind, PREGROUND_CAP, lookup_shown};
use crate::render;
use crate::session::{Outcome, ResultSet, Session};
use crate::world::{Key, Row, Val};

/// The FTS domains and the model kind each answers for.
const FTS: &[(&str, Kind)] = &[
    ("core.party", Kind::Person),
    ("knowledge.note", Kind::Note),
    ("core.event", Kind::Event),
    ("schedule.task", Kind::Task),
    ("core.document", Kind::Document),
];

/// Words a message token must not be matched on.
const STOPWORDS: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "what",
    "whats",
    "who",
    "when",
    "where",
    "which",
    "how",
    "have",
    "has",
    "had",
    "did",
    "does",
    "can",
    "could",
    "would",
    "should",
    "will",
    "are",
    "was",
    "were",
    "you",
    "your",
    "our",
    "his",
    "her",
    "their",
    "them",
    "they",
    "this",
    "that",
    "these",
    "those",
    "from",
    "into",
    "about",
    "any",
    "all",
    "some",
    "been",
    "not",
    "but",
    "out",
    "get",
    "got",
    "please",
    "show",
    "tell",
    "list",
    "find",
    "give",
    "make",
    "add",
    "put",
    "set",
    "move",
    "mark",
    "last",
    "next",
    "today",
    "tomorrow",
    "yesterday",
    "week",
    "month",
    "year",
    "there",
    "here",
    "just",
    "also",
    "then",
    "than",
    "too",
    "very",
    "much",
    "many",
    "more",
    "most",
    "one",
    "two",
];

/// Two-letter words that name nothing on their own: they never let a row into
/// the block, whatever the row's name says (`can_be_whole_name`).
const SHORT_STOP: &[&str] = &[
    "to", "of", "in", "on", "is", "it", "my", "me", "do", "be", "so", "at", "as", "by", "we", "us",
    "up", "or", "no", "go", "an", "if", "he", "hi", "ok", "am", "oh", "re", "vs",
];

/// The request's verb, in the forms people type it: never a name to
/// pre-ground ("star it" is not about "Starlight Theatre"). The metadata's
/// own verb names (split on `_`) are added by `is_verb_word`.
const VERB_FORMS: &[&str] = &[
    "stars",
    "starred",
    "starring",
    "unstarred",
    "deleted",
    "deleting",
    "deletes",
    "completed",
    "completing",
    "completes",
    "done",
    "finish",
    "finished",
    "cancelled",
    "canceled",
    "cancelling",
    "canceling",
    "cancels",
    "restored",
    "restoring",
    "restores",
    "logged",
    "logging",
    "logs",
    "reopened",
    "reopening",
    "rescheduled",
    "rescheduling",
    "postpone",
    "postponed",
    "push",
    "pushed",
    "move",
    "moved",
    "created",
    "creating",
    "new",
    "edited",
    "editing",
    "change",
    "changed",
    "update",
    "updated",
    "rename",
    "renamed",
    "added",
    "adding",
    "removed",
    "removing",
    "settled",
    "settling",
    "pay",
    "paid",
    "revealed",
    "revealing",
    "undone",
    "trash",
    "trashed",
    "pin",
    "pinned",
    "unpin",
    "archive",
    "archived",
    "mark",
    "marked",
    "open",
    "opened",
    "remind",
    "save",
    "saved",
];

/// Whether a message token is a verb word rather than a name.
fn is_verb_word(token: &str) -> bool {
    VERB_FORMS.contains(&token)
        || crate::meta::VERBS
            .iter()
            .any(|verb| verb.name.split('_').any(|part| part == token))
}

/// Whether a message token can stand for a name: three letters or more that are
/// neither a filler nor the verb of the request.
pub(crate) fn can_name(token: &str) -> bool {
    token.chars().count() >= 3 && !STOPWORDS.contains(&token) && !is_verb_word(token)
}

/// Whether a two-letter word of the message can be a whole name (`dj`, `ac`):
/// not a function word (`SHORT_STOP`), not all digits, not the verb of the
/// request. It never counts as a hit of a longer name: it only lets a row
/// whose whole name the message says (`Hit::exact`) into the block.
fn can_be_whole_name(word: &str) -> bool {
    word.chars().count() == 2
        && word.chars().any(char::is_alphabetic)
        && !SHORT_STOP.contains(&word)
        && !is_verb_word(word)
}

// ---------------------------------------------------------------------------
// Folding: one spelling of a name for every comparison.
// ---------------------------------------------------------------------------

/// Letters that lose their accent, as `(first, last, plain letter)` code point
/// runs: Latin-1 and Latin Extended-A, the horn letters of Vietnamese, the
/// comma-below letters of Romanian, and Latin Extended Additional (dotted and
/// underdotted letters of Indic transliteration, the stacked marks of
/// Vietnamese). Sorted by code point.
const UNACCENT: &[(u32, u32, char)] = &[
    (0x00C0, 0x00C5, 'a'),
    (0x00C7, 0x00C7, 'c'),
    (0x00C8, 0x00CB, 'e'),
    (0x00CC, 0x00CF, 'i'),
    (0x00D1, 0x00D1, 'n'),
    (0x00D2, 0x00D6, 'o'),
    (0x00D9, 0x00DC, 'u'),
    (0x00DD, 0x00DD, 'y'),
    (0x00E0, 0x00E5, 'a'),
    (0x00E7, 0x00E7, 'c'),
    (0x00E8, 0x00EB, 'e'),
    (0x00EC, 0x00EF, 'i'),
    (0x00F1, 0x00F1, 'n'),
    (0x00F2, 0x00F6, 'o'),
    (0x00F9, 0x00FC, 'u'),
    (0x00FD, 0x00FD, 'y'),
    (0x00FF, 0x00FF, 'y'),
    (0x0100, 0x0105, 'a'),
    (0x0106, 0x010D, 'c'),
    (0x010E, 0x010F, 'd'),
    (0x0112, 0x011B, 'e'),
    (0x011C, 0x0123, 'g'),
    (0x0124, 0x0125, 'h'),
    (0x0128, 0x0130, 'i'),
    (0x0134, 0x0135, 'j'),
    (0x0136, 0x0137, 'k'),
    (0x0139, 0x013E, 'l'),
    (0x0143, 0x0148, 'n'),
    (0x014C, 0x0151, 'o'),
    (0x0154, 0x0159, 'r'),
    (0x015A, 0x0161, 's'),
    (0x0162, 0x0165, 't'),
    (0x0168, 0x0173, 'u'),
    (0x0174, 0x0175, 'w'),
    (0x0176, 0x0178, 'y'),
    (0x0179, 0x017E, 'z'),
    (0x01A0, 0x01A1, 'o'),
    (0x01AF, 0x01B0, 'u'),
    (0x01CD, 0x01CE, 'a'),
    (0x01CF, 0x01D0, 'i'),
    (0x01D1, 0x01D2, 'o'),
    (0x01D3, 0x01DC, 'u'),
    (0x0218, 0x0219, 's'),
    (0x021A, 0x021B, 't'),
    (0x1E00, 0x1E01, 'a'),
    (0x1E02, 0x1E07, 'b'),
    (0x1E08, 0x1E09, 'c'),
    (0x1E0A, 0x1E13, 'd'),
    (0x1E14, 0x1E1D, 'e'),
    (0x1E1E, 0x1E1F, 'f'),
    (0x1E20, 0x1E21, 'g'),
    (0x1E22, 0x1E2B, 'h'),
    (0x1E2C, 0x1E2F, 'i'),
    (0x1E30, 0x1E35, 'k'),
    (0x1E36, 0x1E3D, 'l'),
    (0x1E3E, 0x1E43, 'm'),
    (0x1E44, 0x1E4B, 'n'),
    (0x1E4C, 0x1E53, 'o'),
    (0x1E54, 0x1E57, 'p'),
    (0x1E58, 0x1E5F, 'r'),
    (0x1E60, 0x1E69, 's'),
    (0x1E6A, 0x1E71, 't'),
    (0x1E72, 0x1E7B, 'u'),
    (0x1E7C, 0x1E7F, 'v'),
    (0x1E80, 0x1E89, 'w'),
    (0x1E8A, 0x1E8D, 'x'),
    (0x1E8E, 0x1E8F, 'y'),
    (0x1E90, 0x1E95, 'z'),
    (0x1E96, 0x1E96, 'h'),
    (0x1E97, 0x1E97, 't'),
    (0x1E98, 0x1E98, 'w'),
    (0x1E99, 0x1E99, 'y'),
    (0x1EA0, 0x1EB7, 'a'),
    (0x1EB8, 0x1EC7, 'e'),
    (0x1EC8, 0x1ECB, 'i'),
    (0x1ECC, 0x1EE3, 'o'),
    (0x1EE4, 0x1EF1, 'u'),
    (0x1EF2, 0x1EF9, 'y'),
];

/// Letters with no accent to drop that people still spell with the plain
/// letters: the ligatures, the barred and stroked letters, the long s.
const SPELLED: &[(char, &str)] = &[
    ('ß', "ss"),
    ('æ', "ae"),
    ('œ', "oe"),
    ('ĳ', "ij"),
    ('ø', "o"),
    ('đ', "d"),
    ('ð', "d"),
    ('þ', "th"),
    ('ħ', "h"),
    ('ł', "l"),
    ('ŀ', "l"),
    ('ŧ', "t"),
    ('ı', "i"),
    ('ſ', "s"),
];

/// `text` lower-cased with the accents dropped: `Lucía` is `lucia`, `Mãe`
/// `mae`, `Tromsø` `tromso`, `Ngongotahā` `ngongotaha`. Combining marks (the
/// decomposed spelling of the same letters) go too. Only accents fold: `Amma`
/// stays `amma`, which is not `ama`.
#[must_use]
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for letter in text.to_lowercase().chars() {
        let code = u32::from(letter);
        if (0x0300..=0x036F).contains(&code) {
            continue;
        }
        if code < 0x00C0 {
            out.push(letter);
        } else if let Some((_, plain)) = SPELLED.iter().find(|(from, _)| *from == letter) {
            out.push_str(plain);
        } else {
            let at = UNACCENT.partition_point(|(_, last, _)| *last < code);
            match UNACCENT.get(at) {
                Some((first, _, plain)) if *first <= code => out.push(*plain),
                _ => out.push(letter),
            }
        }
    }
    out
}

/// The words of a text: folded, split on everything that is not a letter or a
/// digit.
#[must_use]
pub fn fold_words(text: &str) -> Vec<String> {
    fold(text)
        .split(|char: char| !char.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `text` without its possessive `'s` (`Chi's Hen Do` is `Chi Hen Do`), so the
/// name a person says and the name in the vault agree whether or not either
/// carries the apostrophe.
pub(crate) fn without_possessive(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        let possessive = matches!(chars[at], '\'' | '\u{2019}' | '\u{2018}' | '`')
            && at > 0
            && chars[at - 1].is_alphanumeric()
            && matches!(chars.get(at + 1), Some('s' | 'S'))
            && chars.get(at + 2).is_none_or(|next| !next.is_alphanumeric());
        if possessive {
            at += 2;
        } else {
            out.push(chars[at]);
            at += 1;
        }
    }
    out
}

/// The words a name or a message says, for fuzzy matching: folded, possessive
/// dropped.
fn spoken_words(text: &str) -> Vec<String> {
    fold_words(&without_possessive(text))
}

/// A hyphen inside a word of a name (`Yun-ho`, `co-op`).
fn is_hyphen(letter: char) -> bool {
    matches!(letter, '-' | '\u{2010}' | '\u{2011}')
}

/// An apostrophe inside a word of a name (`O'Brien's`), straight, curly or a backtick.
pub(crate) fn is_apostrophe(letter: char) -> bool {
    matches!(letter, '\'' | '\u{2019}' | '\u{2018}' | '`')
}

/// One word a name or a message says, in every spelling its hyphens and apostrophes allow.
///
/// A name with a joiner is written with it, with a space where it is, or without it, and the
/// vault has it one of those ways: `Yun-ho`, `Yun ho` and `Yunho` are one name, `O'Brien's` is
/// `OBriens` and `OBrien`. A word with no joiner is its own only spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Spoken {
    /// The words its joiners split it into, as `fold_words` reads it: `yun`, `ho`.
    parts: Vec<String>,
    /// The same without a trailing possessive `'s`: `chi` for `Chi's`.
    bare: Vec<String>,
    /// The one word the parts make without the joiners: `yunho`, `obriens`; none for a plain
    /// word.
    whole: Option<String>,
    /// The one word the bare parts make: `obrien` for `O'Brien's`; none unless there is a
    /// possessive to drop and more than one word left.
    bare_whole: Option<String>,
}

impl Spoken {
    /// The ways it reads, each a list of words that must all be there: its parts (the bare parts
    /// when a possessive is no part of the match) or the one word they make.
    fn readings(&self, bare: bool) -> Vec<Vec<&str>> {
        let parts = if bare { &self.bare } else { &self.parts };
        let mut out = vec![parts.iter().map(String::as_str).collect::<Vec<_>>()];
        out.extend(self.whole.iter().map(|whole| vec![whole.as_str()]));
        if bare {
            out.extend(self.bare_whole.iter().map(|whole| vec![whole.as_str()]));
        }
        out
    }

    /// Every word it can be reached by: its parts and the wholes they make.
    fn spellings(&self) -> impl Iterator<Item = &str> {
        self.parts
            .iter()
            .map(String::as_str)
            .chain(self.whole.as_deref())
            .chain(self.bare_whole.as_deref())
    }

    /// Whether it is an article (`the`, `a`, `an`), which joins a name without being part of it.
    pub(crate) fn is_article(&self) -> bool {
        self.whole.is_none()
            && matches!(self.bare.as_slice(), [word] if ARTICLES.contains(&word.as_str()))
    }

    /// The word it is when it has no joiner (`dan`); none for `Yun-ho` or `O'Brien's`.
    pub(crate) fn single(&self) -> Option<&str> {
        match (self.parts.as_slice(), &self.whole) {
            ([word], None) => Some(word),
            _ => None,
        }
    }

    /// Whether some reading of it has every word among `have`.
    pub(crate) fn is_among(&self, bare: bool, have: impl Fn(&str) -> bool) -> bool {
        self.readings(bare)
            .iter()
            .any(|reading| reading.iter().all(|word| have(word)))
    }
}

/// The words of a text as `Spoken`: folded, split on everything that is neither a letter, a
/// digit nor a joiner (a hyphen or an apostrophe inside a word).
pub(crate) fn spoken_tokens(text: &str) -> Vec<Spoken> {
    fold(text)
        .split(|letter: char| {
            !letter.is_alphanumeric() && !is_hyphen(letter) && !is_apostrophe(letter)
        })
        .filter_map(spoken_token)
        .collect()
}

/// One run of letters and joiners as a `Spoken`; `None` when it holds no letter or digit.
fn spoken_token(run: &str) -> Option<Spoken> {
    let mut parts: Vec<String> = Vec::new();
    // whether the joiner before each part after the first is an apostrophe
    let mut joined_by: Vec<bool> = Vec::new();
    let mut part = String::new();
    let mut joiner: Option<bool> = None;
    for letter in run.chars() {
        if is_hyphen(letter) || is_apostrophe(letter) {
            if !part.is_empty() {
                parts.push(std::mem::take(&mut part));
            }
            joiner = Some(is_apostrophe(letter));
        } else {
            if part.is_empty() && !parts.is_empty() {
                joined_by.push(joiner.unwrap_or(false));
            }
            part.push(letter);
        }
    }
    if !part.is_empty() {
        parts.push(part);
    }
    if parts.is_empty() {
        return None;
    }
    let possessive = parts.len() >= 2
        && parts.last().is_some_and(|last| last == "s")
        && joined_by.last() == Some(&true);
    let bare: Vec<String> = if possessive {
        parts[..parts.len() - 1].to_vec()
    } else {
        parts.clone()
    };
    let whole = (parts.len() > 1).then(|| parts.concat());
    let bare_whole = (possessive && bare.len() > 1).then(|| bare.concat());
    Some(Spoken {
        parts,
        bare,
        whole,
        bare_whole,
    })
}

/// Every word a text can be reached by, with the wholes its joiners make (`Yun-ho`: `yun`, `ho`,
/// `yunho`): what a query's words are looked for among.
pub(crate) fn spellings_of(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in spoken_tokens(text) {
        for word in token.spellings() {
            if !out.iter().any(|have| have == word) {
                out.push(word.to_owned());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// By-name matching.
// ---------------------------------------------------------------------------

/// What a row answers to: its name and, for a person, their nickname.
pub(crate) fn aliases(row: &Row) -> Vec<&str> {
    let mut out = vec![row.name.as_str()];
    if let Some(Val::Text(nickname)) = row.field("nickname") {
        out.push(nickname.as_str());
    }
    out
}

/// Words that join a name without being part of it: ignored when a query is read for a name
/// (`resolve`), unless they are all it says.
const ARTICLES: &[&str] = &["the", "a", "an"];

/// THE ROWS A NAME REACHES IN PART, when `resolve` reaches none (SPEC §4.8): the rows of `kinds`
/// (and of `within`, when the selector narrows to a result) whose name, nickname or role holds
/// at least half the words the person said, by exact word, word start or near spelling, live and
/// trashed. Only the best-scoring tier is kept: a row that fits one word of three is not the one
/// meant while another fits all. Best first, as `search` lists them. For a lookup of trashed rows
/// (`trashed_only`) the tiers are those of the trashed rows alone. It is a guess for an ask or
/// an answer of near rows, never a row a write goes to.
///
/// For a WRITE (`majority`, nt15 R4) a row must hold MORE than half of the name's content words
/// (articles and kind nouns aside): `renew passport` is not `Renew car insurance`, which shares one of its two,
/// so the act on it is never asked about (at least 2 of a 2-word name, 2 of 3, 3 of 4).
#[must_use]
pub(crate) fn name_in_part(
    session: &Session,
    text: &str,
    kinds: &[Kind],
    within: Option<&BTreeSet<Key>>,
    trashed_only: bool,
    majority: bool,
) -> Vec<Key> {
    // (a kind noun, `debt` or `IOU`, is no word of a name either: `settle the ticket IOU` has
    // one content word)
    let content: Vec<Spoken> = spoken_tokens(text)
        .into_iter()
        .filter(|token| !token.is_article())
        .filter(|token| !token.single().is_some_and(crate::meta::kind_word))
        .collect();
    let hits: Vec<(Key, u32)> = ranked_with(session, text, kinds, false, false)
        .into_iter()
        .filter(|(key, _)| within.is_none_or(|scope| scope.contains(key)))
        .filter(|(key, _)| !trashed_only || session.world.row(key).is_some_and(|row| row.trashed))
        .filter(|(key, _)| {
            !majority
                || session.world.row(key).is_some_and(|row| {
                    let name = row_words(row);
                    let said = content
                        .iter()
                        .filter(|token| {
                            let (_, hit, size) = best_reading(token, &name, false);
                            size > 0 && hit == size
                        })
                        .count();
                    said * 2 > content.len()
                })
        })
        .collect();
    let best = hits.first().map_or(0, |(_, score)| *score);
    hits.into_iter()
        .take_while(|(_, score)| *score == best)
        .map(|(key, _)| key)
        .collect()
}

/// Whether the vault's full-text search reaches into the rows of `kind` (their bodies and
/// descriptions), not only their names.
#[must_use]
pub(crate) fn searches_bodies(kind: Kind) -> bool {
    FTS.iter().any(|(_, searched)| *searched == kind)
}

/// THE ROWS A NAME REACHES BY A WORD, whatever their kind or trash: the rows of `kinds` whose
/// name, nickname or role holds a word of `text` exactly or by its start (the score of two
/// exact or prefix words, or one exact), best first. The empty-read hint's wider look
/// (`Session::miss_hint`): the album `Kyoto 2026` for "kyoto photos", the list `Christmas`
/// for "christmas tasks", a trashed row.
#[must_use]
pub(crate) fn name_reach(session: &Session, text: &str, kinds: &[Kind]) -> Vec<Key> {
    ranked_with(session, text, kinds, false, false)
        .into_iter()
        .filter(|(_, score)| *score >= 2)
        .map(|(key, _)| key)
        .collect()
}

// ---------------------------------------------------------------------------
// `search`.
// ---------------------------------------------------------------------------

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            current.push(
                (previous[j] + cost)
                    .min(previous[j + 1] + 1)
                    .min(current[j] + 1),
            );
        }
        previous = current;
    }
    previous[b.len()]
}

/// 3 exact, 2 prefix, 1 near spelling, 0 none. Both words are folded
/// (`fold_words`).
#[must_use]
pub fn word_score(query: &str, word: &str) -> u32 {
    if query == word {
        3
    } else if query.len() >= 2 && word.starts_with(query) {
        2
    } else {
        let limit = if query.len() >= 7 { 2 } else { 1 };
        if query.len() >= 4 && edit_distance(query, word) <= limit {
            1
        } else {
            0
        }
    }
}

/// The forms a word may be the stem of: itself, and with a light suffix (`ers`, `ing`, `es`, `ed`,
/// `er`, `s`) taken off, a doubled last consonant undone (`babysitter` to `babysit`) or an `e`
/// given back (`baked` to `bake`). A stem is three letters or more.
fn stem_forms(word: &str) -> Vec<String> {
    let mut forms = vec![word.to_owned()];
    for suffix in ["ers", "ing", "es", "ed", "er", "s"] {
        let Some(stem) = word.strip_suffix(suffix) else {
            continue;
        };
        if stem.chars().count() < 3 {
            continue;
        }
        forms.push(stem.to_owned());
        let mut letters = stem.chars().rev();
        if let (Some(last), Some(before)) = (letters.next(), letters.next())
            && last == before
            && !"aeiou".contains(last)
        {
            forms.push(stem[..stem.len() - last.len_utf8()].to_owned());
        }
        if matches!(suffix, "ers" | "ing" | "ed" | "er") {
            forms.push(format!("{stem}e"));
        }
    }
    forms
}

/// Whether two different words are forms of one (`babysitter`, `babysits`; four letters or more
/// each): the same stem after a light suffix is taken off either.
fn same_stem(a: &str, b: &str) -> bool {
    if a == b || a.chars().count() < 4 || b.chars().count() < 4 {
        return false;
    }
    let forms = stem_forms(a);
    stem_forms(b).iter().any(|form| forms.contains(form))
}

/// `word_score`, and a word form of the same stem (`same_stem`) scores as a word's start.
fn word_score_stemmed(query: &str, word: &str) -> u32 {
    let score = word_score(query, word);
    if score < 2 && same_stem(query, word) {
        2
    } else {
        score
    }
}

/// How a word the person said scores among the words of a row, in the reading of it that scores
/// best (its parts, or the one word its joiners leave): `(score, words that scored, words in the
/// reading)`. At the same score the reading with more words scored and fewer words wins. With
/// `stems`, a word form of a name's word counts as its start (`word_score_stemmed`).
fn best_reading(token: &Spoken, have: &[String], stems: bool) -> (u32, usize, usize) {
    token
        .readings(false)
        .into_iter()
        .map(|reading| {
            let scores: Vec<u32> = reading
                .iter()
                .map(|word| {
                    have.iter()
                        .map(|name| {
                            if stems {
                                word_score_stemmed(word, name)
                            } else {
                                word_score(word, name)
                            }
                        })
                        .max()
                        .unwrap_or(0)
                })
                .collect();
            (
                scores.iter().sum::<u32>(),
                scores.iter().filter(|score| **score > 0).count(),
                reading.len(),
            )
        })
        .max_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| b.2.cmp(&a.2))
        })
        .unwrap_or((0, 0, 0))
}

/// The fields a name search also reads: what people call a person.
const ALSO_NAMED: &[&str] = &["nickname", "role"];

/// The words a row answers to: its name, plus its nickname and role.
fn row_words(row: &Row) -> Vec<String> {
    let mut out = spellings_of(&row.name);
    for field in ALSO_NAMED {
        if let Some(Val::Text(text)) = row.field(field) {
            out.extend(spellings_of(text));
        }
    }
    out
}

/// Every row the text reaches, live and trashed, best first; at the same
/// score a live row comes before a trashed one.
fn ranked(session: &Session, text: &str, kinds: &[Kind]) -> Vec<(Key, u32)> {
    ranked_with(session, text, kinds, true, true)
}

/// `ranked`, with or without the full-text hits: the words of a name, a
/// nickname and a role score a row alone (`name_in_part`). With `stems`, another form of a word
/// (`babysitter`, `babysits`) scores as the word's start: the `search` tool's reading alone.
fn ranked_with(
    session: &Session,
    text: &str,
    kinds: &[Kind],
    full_text: bool,
    stems: bool,
) -> Vec<(Key, u32)> {
    let query = spoken_tokens(text);
    if query.is_empty() {
        return Vec::new();
    }
    let mut scores: BTreeMap<Key, u32> = BTreeMap::new();
    for row in session.world.rows.values() {
        if !kinds.contains(&row.kind) {
            continue;
        }
        let name = row_words(row);
        let (mut total, mut matched, mut words) = (0, 0, 0);
        for token in &query {
            let (best, hit, size) = best_reading(token, &name, stems);
            total += best;
            matched += hit;
            words += size;
        }
        if matched * 2 >= words && total > 0 {
            scores.insert(row.key(), total);
        }
    }
    for (entity, kind) in FTS {
        if !full_text || !kinds.contains(kind) {
            continue;
        }
        let Ok(targets) = session.handle.search(entity, text, 50) else {
            continue;
        };
        for target in targets {
            let key = (*kind, target.id.clone());
            if session.world.row(&key).is_some() {
                *scores.entry(key).or_insert(0) += 1;
            }
        }
    }
    let mut out: Vec<(Key, u32)> = scores.into_iter().collect();
    let trashed = |key: &Key| session.world.row(key).is_some_and(|row| row.trashed);
    out.sort_by(|(a, x), (b, y)| {
        y.cmp(x)
            .then_with(|| trashed(a).cmp(&trashed(b)))
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| {
                let name = |key: &Key| {
                    session
                        .world
                        .rows
                        .get(key)
                        .map(|row| row.name.to_lowercase())
                };
                name(a).cmp(&name(b))
            })
            .then_with(|| a.1.cmp(&b.1))
    });
    out
}

/// The `search` tool.
pub fn search(session: &mut Session, args: &Map<String, Value>) -> Result<Outcome, String> {
    let text = match args.get("text") {
        Some(Value::String(text)) if !text.trim().is_empty() => text.trim().to_owned(),
        _ => return Err("error: search needs text.".to_owned()),
    };
    let kinds = match args.get("kind") {
        None | Some(Value::Null) => Kind::ALL.to_vec(),
        Some(Value::String(kind)) => {
            let mut out = Vec::new();
            for part in kind
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
            {
                if part.eq_ignore_ascii_case("any") {
                    out = Kind::ALL.to_vec();
                    break;
                }
                let parsed = Kind::parse(part).ok_or_else(|| {
                    format!(
                        "error: no kind \"{part}\". kinds: any, {}.",
                        crate::whr::kind_names()
                    )
                })?;
                out.push(parsed);
            }
            out
        }
        Some(other) => return Err(format!("error: kind is text, not {other}.")),
    };
    let hits = ranked(session, &text, &kinds);
    let mut outcome = Outcome::text("");
    if hits.is_empty() {
        let message = format!(
            "0 rows match \"{text}\" by name, nickname or role, live or trashed. Try other words, or find with where on a field."
        );
        outcome.effect.insert("recovery".to_owned(), json!("empty"));
        // an empty search is a lookup that came back empty: an `answer` by name after it ends
        // as it always did (`Session::compose_unmatched_read`)
        session.read_misses += 1;
        session.push_obs(
            true,
            None,
            message.clone(),
            message,
            Vec::new(),
            &mut outcome,
        );
        outcome.effect.insert("rows".to_owned(), json!([]));
        return Ok(outcome);
    }
    let keys: Vec<Key> = hits.iter().map(|(key, _)| key.clone()).collect();
    let mut found_kinds: Vec<Kind> = Vec::new();
    for key in &keys {
        if !found_kinds.contains(&key.0) {
            found_kinds.push(key.0);
        }
    }
    found_kinds.sort();
    session.results.push(ResultSet {
        kinds: found_kinds.clone(),
        keys: keys.clone(),
        value: None,
    });
    let handle = session.results.len();
    let rows: Vec<_> = keys
        .iter()
        .filter_map(|key| session.world.row(key).cloned())
        .collect();
    let refs: Vec<_> = rows.iter().collect();
    let summary = format!(
        "search \"{text}\": {}",
        render::count_phrase(&found_kinds, &refs)
    );
    let cap = lookup_shown(rows.len());
    let header = format!("@{handle} · {summary} (showing {})", rows.len().min(cap));
    let mut lines = Vec::new();
    for (position, row) in rows.iter().take(cap).enumerate() {
        let number = session.number(&row.key());
        let mut numbers = vec![number];
        let mut line = render::row_line(number, Some(position + 1), row, session.today());
        let mut parts = Vec::new();
        for (_, others) in session.world.neighbours(&row.key()) {
            for other in others {
                if parts.len() >= 3 {
                    break;
                }
                let Some(other_row) = session.world.row(&other).cloned() else {
                    continue;
                };
                if other_row.trashed {
                    continue;
                }
                let n = session.number(&other);
                numbers.push(n);
                parts.push(format!("{} #{n} \"{}\"", other.0.name(), other_row.name));
            }
        }
        line.push_str(&render::links_inline(&parts));
        lines.push((numbers, line));
    }
    if rows.len() > cap {
        lines.push((
            Vec::new(),
            format!(
                "… {} more in @{handle} (narrow with kind or a fuller text)",
                rows.len() - cap
            ),
        ));
    }
    session.push_obs(true, Some(handle), summary, header, lines, &mut outcome);
    outcome
        .effect
        .insert("rows".to_owned(), session.keys_json(&keys));
    outcome
        .effect
        .insert("result".to_owned(), json!(format!("@{handle}")));
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// The pre-grounding block.
// ---------------------------------------------------------------------------

/// One row a message reaches.
struct Hit {
    key: Key,
    /// A name of the row (its own or a person's nickname) every word of which
    /// the message says.
    exact: bool,
    /// How many words that name has when it is exact: the more of the message
    /// a name accounts for, the more specific the hit.
    span: usize,
    /// Message tokens that are a word or a word's start in the row's names.
    hits: usize,
    /// Those hits scored (3 a word, 2 a prefix).
    score: u32,
    container: bool,
    /// The message tokens (indexes into the tokens) that hit as a word or a word's start.
    reached: Vec<usize>,
    /// Those of them that are a whole word of a name (a start of one is the others).
    whole: Vec<usize>,
    /// The tokens that reach the row only as a NEAR SPELLING (one edit from a name word, or a
    /// joined name, `weijie` for `Wei Jie`): a lower tier, nt15 R3c, e.
    near: Vec<usize>,
}

/// Whether the message says a word of the name (or nickname) of a live person other than the
/// user: the vault line would show them.
#[must_use]
pub(crate) fn message_names_a_person(session: &Session, message: &str) -> bool {
    !persons_named(session, message).is_empty()
}

/// The live people other than the user whose name, nickname or role the message says.
#[must_use]
pub(crate) fn persons_named(session: &Session, message: &str) -> Vec<Key> {
    let words = spoken_words(message);
    let me = session.world.me_key();
    session
        .world
        .rows
        .values()
        .filter(|row| {
            row.kind == Kind::Person && !row.trashed && row.key() != me && {
                let spelled: Vec<String> = aliases(row)
                    .iter()
                    .flat_map(|name| spellings_of(name))
                    .collect();
                words.iter().any(|token| {
                    can_name(token) && spelled.iter().any(|word| word_score(token, word) >= 2)
                })
            }
        })
        .map(Row::key)
        .collect()
}

/// Words of five letters or more that name nothing on their own (`after`, `every`, a month, a
/// weekday, a unit of time: the `dates:` line reads those): they never make a row worth a slot of
/// its own in the vault line (`preground`, nt15 R3d).
const FUNCTION_WORDS: &[&str] = &[
    "after",
    "again",
    "before",
    "being",
    "below",
    "above",
    "around",
    "between",
    "through",
    "during",
    "every",
    "first",
    "going",
    "other",
    "since",
    "still",
    "under",
    "until",
    "while",
    "would",
    "should",
    "could",
    "really",
    "anything",
    "something",
    "everything",
    "another",
    "minutes",
    "hours",
    "days",
    "weeks",
    "months",
    "years",
    "weekend",
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
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

/// Whether a message word can be read as a near spelling at all (nt15 R3c): six letters or more
/// (a shorter word is one edit from too many words: `right` and `night`), only letters, and no
/// kind of the vault (`logins`, `photos`, `documents` name a category, not a row).
fn near_candidate(token: &str) -> bool {
    token.chars().count() >= 6
        && token.chars().all(char::is_alphabetic)
        && Kind::parse(token).is_none()
}

/// Whether a message word reaches a row only as a NEAR SPELLING (nt15 R3c, R3e): one edit
/// (`crate::resolve::one_edit`) from a word of the row's names with the same first letter (a slip
/// is rarely the first letter: `brazil` for `Brasil`, not `right` for `night`), and not the plain
/// plural or singular of it (`logins` for `login` is a category, not a slip); or the one word the
/// words of a name make when said joined, or one edit from it (`weijie` for `Wei Jie`).
fn near_spelling(token: &str, names: &[&str], spelled: &[String]) -> bool {
    let first = token.chars().next();
    let plural = |word: &str| {
        [token, word].iter().any(|long| {
            ["s", "es"].iter().any(|ending| {
                let short = if *long == token { word } else { token };
                *long == format!("{short}{ending}")
            })
        })
    };
    if spelled.iter().any(|word| {
        word.chars().next() == first && !plural(word) && crate::resolve::one_edit(token, word)
    }) {
        return true;
    }
    names.iter().any(|name| {
        let words = spoken_words(name);
        (0..words.len()).any(|from| {
            (from + 1..words.len()).any(|to| {
                let joined = words[from..=to].concat();
                joined == token
                    || (joined.chars().next() == first && crate::resolve::one_edit(token, &joined))
            })
        })
    })
}

/// The pre-grounding block for one user message, or `None` when no token
/// reaches a row (SPEC §6.1).
///
/// A token reaches a live row when it is a word, or the start of a word, of
/// the row's name or of a person's nickname (a near spelling or a body match
/// is `search`'s to offer, not the prompt's). Tokens are the words of the
/// message that can name something: three letters or more, no filler and not
/// the request's verb. A two-letter word (`dj`, `ac`) is no token; it only lets
/// in a row whose whole name the message says. Rows rank by, in order:
///
/// 1. an EXACT NAME: every word of one of the row's names is a word of the
///    message, so the list `Christmas` outranks the photos `Christmas 1` and
///    `Christmas 10` when the message says "christmas"; of two exact names the
///    one with more words;
/// 2. how many tokens reach it, and how well;
/// 3. a container before a leaf.
///
/// At most `PREGROUND_CAP` rows, and no kind takes more than half of them
/// while another kind has a hit. The rows read best first. A container shows
/// how many rows it holds (`render::grounded`).
pub fn preground(session: &mut Session, message: &str) -> Option<String> {
    let words = spoken_words(message);
    let said: BTreeSet<String> = spellings_of(message).into_iter().collect();
    let mut tokens: Vec<&str> = Vec::new();
    for token in &words {
        if !can_name(token) || tokens.contains(&token.as_str()) {
            continue;
        }
        tokens.push(token);
    }
    let mut found: Vec<Hit> = Vec::new();
    for row in session.world.rows.values() {
        if row.trashed {
            continue;
        }
        let names: Vec<&str> = aliases(row);
        let spelled: Vec<String> = names.iter().flat_map(|name| spellings_of(name)).collect();
        let mut hits = 0;
        let mut score = 0;
        let mut reached: Vec<usize> = Vec::new();
        let mut whole: Vec<usize> = Vec::new();
        for (at, token) in tokens.iter().enumerate() {
            let best = spelled
                .iter()
                .map(|word| word_score(token, word))
                .max()
                .unwrap_or(0);
            // THE THRESHOLD: an exact or prefix hit on a NAME word.
            if best >= 2 {
                hits += 1;
                score += best;
                reached.push(at);
                if best == 3 {
                    whole.push(at);
                }
            }
        }
        // A NAME THE MESSAGE SAYS IN FULL: every word of it, spelled with its joiners or
        // without (`Yun-ho`, `yunho`); how many words it has is how specific it is.
        let span = names
            .iter()
            .filter(|name| {
                let said_in_full = spoken_tokens(name)
                    .iter()
                    .all(|token| token.is_among(true, |word| said.contains(word)));
                said_in_full && !spoken_words(name).is_empty()
            })
            .map(|name| spoken_words(name))
            .filter(|own| hits > 0 || own.iter().any(|word| can_be_whole_name(word)))
            .map(|own| own.len())
            .max();
        if hits == 0 && span.is_none() {
            continue;
        }
        found.push(Hit {
            key: row.key(),
            exact: span.is_some(),
            span: span.unwrap_or(0),
            hits,
            score,
            container: row.kind.spec().container,
            reached,
            whole,
            near: Vec::new(),
        });
    }
    // WHAT THE MESSAGE POINTS AT WITHOUT NAMING IT: the container of the focus
    // rows when the message says "that album" leads the line; the person's own
    // row, for "my balance", closes it and only when no other person is in play
    // (`crate::block`).
    let mut leading: Vec<Key> = Vec::new();
    leading.extend(crate::block::container_hit(session, message));
    let me = session.world.me_key();
    let other = found
        .iter()
        .any(|hit| hit.key.0 == Kind::Person && hit.key != me);
    // A GROUP IS NAMED when the message says a whole word of its name (`tahoe`, not `bill` for
    // `Flat Bills`) or all of it
    let group_named = found.iter().any(|hit| {
        hit.key.0 == Kind::Group
            && (hit.exact
                || (hit.hits > 0
                    && usize::try_from(hit.score).is_ok_and(|score| score >= 3 * hit.hits)))
    });
    let closing = crate::block::me_hit(session, message, other, group_named);
    let reach: Vec<usize> = (0..tokens.len())
        .map(|at| found.iter().filter(|hit| hit.reached.contains(&at)).count())
        .collect();
    found.retain(|hit| !leading.contains(&hit.key) && closing.as_ref() != Some(&hit.key));
    // NEAR SPELLINGS (nt15 R3c, R3e): a word of the message that no row reaches by a word or its
    // start may reach a row by one edit (`brazil` for `Brasil`) or as the joined words of a name
    // (`weijie` for `Wei Jie`): the row joins the line at a lower tier (it follows every row a
    // word reaches, and fills a slot only a word nothing else reaches asks for, or one left over)
    let unreached: Vec<usize> = (0..tokens.len())
        .filter(|at| reach[*at] == 0 && near_candidate(tokens[*at]))
        .collect();
    if !unreached.is_empty() {
        for row in session.world.rows.values() {
            if row.trashed || leading.contains(&row.key()) || closing.as_ref() == Some(&row.key()) {
                continue;
            }
            let names: Vec<&str> = aliases(row);
            let spelled: Vec<String> = names.iter().flat_map(|name| spellings_of(name)).collect();
            let near: Vec<usize> = unreached
                .iter()
                .copied()
                .filter(|at| near_spelling(tokens[*at], &names, &spelled))
                .collect();
            if near.is_empty() {
                continue;
            }
            match found.iter_mut().find(|hit| hit.key == row.key()) {
                Some(hit) => hit.near = near,
                None => found.push(Hit {
                    key: row.key(),
                    exact: false,
                    span: 0,
                    hits: 0,
                    score: 0,
                    container: row.kind.spec().container,
                    reached: Vec::new(),
                    whole: Vec::new(),
                    near,
                }),
            }
        }
    }
    if found.is_empty() && leading.is_empty() && closing.is_none() {
        return None;
    }
    // A NAME MANY ROWS SHARE is cut (`Dentist` ×19): the rows the conversation
    // touched and the nearest to today, then `+n more "Dentist"`.
    let copies = crate::block::same_name(
        session,
        &found.iter().map(|hit| hit.key.clone()).collect::<Vec<_>>(),
    );
    found.retain(|hit| !copies.hide.contains(&hit.key));
    let lower = |hit: &Hit| {
        session
            .world
            .rows
            .get(&hit.key)
            .map(|row| row.name.to_lowercase())
    };
    found.sort_by(|a, b| {
        // a row reached only as a near spelling comes after every row reached by a word or its start
        (a.hits == 0 && !a.exact)
            .cmp(&(b.hits == 0 && !b.exact))
            .then_with(|| b.exact.cmp(&a.exact))
            .then_with(|| b.span.cmp(&a.span))
            .then_with(|| b.hits.cmp(&a.hits))
            .then_with(|| b.score.cmp(&a.score))
            .then_with(|| b.container.cmp(&a.container))
            .then_with(|| a.key.0.cmp(&b.key.0))
            .then_with(|| lower(a).cmp(&lower(b)))
            .then_with(|| a.key.1.cmp(&b.key.1))
    });
    // DIVERSITY: no kind past half the slots while another kind has a hit. A row over its kind's
    // share waits; it fills a slot only when no other kind's hit is left to.
    let room = PREGROUND_CAP.saturating_sub(leading.len() + usize::from(closing.is_some()));
    let share = PREGROUND_CAP / 2;
    let mut per_kind: BTreeMap<Kind, usize> = BTreeMap::new();
    let mut chosen: Vec<usize> = Vec::new();
    let mut waiting: Vec<usize> = Vec::new();
    for (index, hit) in found.iter().enumerate() {
        if chosen.len() == room {
            break;
        }
        let taken = per_kind.entry(hit.key.0).or_default();
        if *taken < share {
            *taken += 1;
            chosen.push(index);
        } else {
            waiting.push(index);
        }
    }
    for index in waiting {
        if chosen.len() == room {
            break;
        }
        chosen.push(index);
    }
    // EVERY CONTENT WORD KEEPS A SLOT (nt15 R3d): a word of the message that reaches a row worth a
    // slot and has none among the rows chosen (eight exact hits on `work` filled the line, and
    // `reno`, a prefix of the list `Kitchen renovation`, reaches only that list) is served before
    // the cap closes: the word that reaches the fewest rows first, with the best row it reaches
    // (a container whose name starts with the word before any other hit), in the place of the
    // lowest-ranked row no other word depends on. A row is worth a slot when it is a container
    // whose name starts with a word of four letters or more, or has the word, of five letters or
    // more, whole in its name (`FUNCTION_WORDS` aside): the short or common word that only
    // brushes a name (`take` for `Takeaway`, `now` for `Nowy Sacz`, `after`) keeps no slot, and a
    // line that already holds a row for every word is as it was. A near spelling (R3c) has no slot
    // of its own: it takes one that is left over. A kind of the vault (`documents`, `notes`) names
    // a category and asks for no row.
    let wanted: Vec<usize> = (0..tokens.len())
        .filter(|at| Kind::parse(tokens[*at]).is_none())
        .collect();
    let covers = |index: usize, at: usize| found[index].reached.contains(&at);
    let worth = |index: usize, at: usize| {
        let hit = &found[index];
        let length = tokens[at].chars().count();
        hit.reached.contains(&at)
            && ((hit.container && length >= 4)
                || (hit.whole.contains(&at)
                    && length >= 5
                    && !FUNCTION_WORDS.contains(&tokens[at])))
    };
    let reaching = |at: usize| found.iter().filter(|hit| hit.reached.contains(&at)).count();
    let mut order = wanted.clone();
    order.sort_by_key(|at| (reaching(*at), *at));
    for at in order {
        if room == 0 || chosen.iter().any(|index| covers(*index, at)) {
            continue;
        }
        let candidates: Vec<usize> = (0..found.len()).filter(|index| worth(*index, at)).collect();
        let pick = candidates
            .iter()
            .find(|index| found[**index].container)
            .or_else(|| candidates.first())
            .copied();
        let Some(pick) = pick else {
            continue;
        };
        if chosen.len() >= room {
            let alone = |victim: usize, other: &[usize]| {
                wanted.iter().any(|token| {
                    covers(victim, *token) && !other.iter().any(|index| covers(*index, *token))
                })
            };
            let victim = chosen
                .iter()
                .copied()
                .filter(|victim| {
                    let rest: Vec<usize> = chosen.iter().copied().filter(|i| i != victim).collect();
                    !alone(*victim, &rest)
                })
                .max();
            let Some(victim) = victim else {
                continue;
            };
            chosen.retain(|index| *index != victim);
        }
        chosen.push(pick);
    }
    chosen.sort_unstable();
    let mut parts = Vec::new();
    let keys: Vec<Key> = leading
        .into_iter()
        .chain(chosen.iter().map(|index| found[*index].key.clone()))
        .chain(closing)
        .collect();
    for key in keys {
        let number = session.number(&key);
        session.preground.insert(number);
        let mut part = render::grounded(&session.world, number, &key);
        if key == me {
            part.push_str(" (you)");
        }
        parts.push(part);
        if let Some((hidden, name)) = copies.more.get(&key) {
            parts.push(format!("+{hidden} more \"{name}\""));
        }
    }
    Some(format!("vault: {}", parts.join(" · ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accents_and_case_fold() {
        for (text, folded) in [
            ("Lucía", "lucia"),
            ("LUCIA", "lucia"),
            ("Mãe", "mae"),
            ("Tromsø", "tromso"),
            ("Ngongotahā", "ngongotaha"),
            ("Göteborg", "goteborg"),
            ("Élodie", "elodie"),
            ("piñata", "pinata"),
            ("Åkesson", "akesson"),
            ("Straße", "strasse"),
            ("Pão de Açúcar", "pao de acucar"),
            ("Patrícia", "patricia"),
            ("Ṭhākur", "thakur"),
            ("Nguyễn", "nguyen"),
            ("Brasília", "brasilia"),
        ] {
            assert_eq!(fold(text), folded, "{text}");
        }
    }

    #[test]
    fn a_decomposed_accent_folds_like_the_composed_one() {
        // `u` + combining diaeresis, `e` + combining acute.
        assert_eq!(fold("Mu\u{308}ller"), "muller");
        assert_eq!(fold("Cafe\u{301}"), "cafe");
        assert_eq!(fold_words("Mu\u{308}ller Cafe\u{301}"), ["muller", "cafe"]);
    }

    #[test]
    fn only_accents_fold_a_near_spelling_stays_apart() {
        // nt11: `resolve` reads `Amma` for `Ama` as a typo (tier 4), never as the same name
        assert_eq!(fold("Amma"), "amma");
        assert_ne!(fold("Amma"), fold("Ama"));
        // `search` reaches the near spelling (one edit, four letters).
        assert_eq!(word_score("amma", "ama"), 1);
    }

    #[test]
    fn a_possessive_is_dropped_for_fuzzy_words_only() {
        assert_eq!(spoken_words("Chi's Hen Do"), ["chi", "hen", "do"]);
        assert_eq!(spoken_words("Chi\u{2019}s Hen Do"), ["chi", "hen", "do"]);
        assert_eq!(spoken_words("O'Brien's pub"), ["o", "brien", "pub"]);
        assert_eq!(fold_words("Chi's Hen Do"), ["chi", "s", "hen", "do"]);
    }

    #[test]
    fn the_fold_table_is_sorted_and_disjoint() {
        for pair in UNACCENT.windows(2) {
            assert!(pair[0].1 < pair[1].0, "{pair:?}");
        }
        for (first, last, _) in UNACCENT {
            assert!(first <= last);
        }
    }
}
