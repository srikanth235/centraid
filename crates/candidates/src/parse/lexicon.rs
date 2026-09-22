//! The lexicon: ONE data file (`lexicon.json`), loaded once, plus the
//! normaliser that maps a member's sentence onto it.
//!
//! No rule in `rules.rs` matches a bare string that is not in here — the point
//! of a tier-D parser is that its vocabulary can be REGENERATED from
//! `grammar/GRAMMAR.md` rather than archaeologised out of the code.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
pub struct Lexicon {
    #[allow(dead_code)]
    pub note: String,
    pub contractions: HashMap<String, String>,
    pub fillers: Vec<String>,
    pub undo: Vec<String>,
    pub refuse: HashMap<String, Vec<Vec<String>>>,
    pub kinds: HashMap<String, Vec<String>>,
    pub kind_of_field: HashMap<String, String>,
    pub label_field: HashMap<String, String>,
    pub windows: HashMap<String, Vec<String>>,
    pub weekdays: HashMap<String, u32>,
    pub numbers: HashMap<String, i64>,
    pub ordinals: HashMap<String, i64>,
    pub verbs: Vec<VerbEntry>,
    /// THE write-verb table (see `write_verbs_note` in `lexicon.json`).
    pub write_verbs: Vec<WriteVerb>,
    #[allow(dead_code)]
    pub write_verbs_note: String,
    pub restore_by_kind: HashMap<String, String>,
    pub refs: HashMap<String, Vec<String>>,
    pub open_task_words: Vec<String>,
    pub safe_words: Vec<String>,
    pub stopwords: Vec<String>,
}

/// One row of the write-verb table: a typed command (or a GRAMMAR.md 2.7 verb
/// CLASS), the ACT it performs, and the English verbs that name that act.
#[derive(Debug, Deserialize)]
pub struct WriteVerb {
    pub verb: String,
    /// The meaning the surfaces were written from. Prose, read by humans.
    #[allow(dead_code)]
    pub sense: String,
    pub surfaces: Vec<String>,
    /// Any-of guard for a surface too generic to stand alone.
    #[serde(default)]
    pub needs: Vec<String>,
    /// Words that rule the row out even when a surface matched.
    #[serde(default)]
    pub bars: Vec<String>,
    /// May this row fire behind an interrogative opener? Only a disclosure
    /// request legitimately is one.
    #[serde(default)]
    pub question_ok: bool,
}

#[derive(Debug, Deserialize)]
pub struct VerbEntry {
    pub canonical: String,
    pub triggers: Vec<String>,
    #[serde(default)]
    pub requires: Option<String>,
}

static LEXICON: OnceLock<Lexicon> = OnceLock::new();

pub fn lexicon() -> &'static Lexicon {
    LEXICON.get_or_init(|| {
        serde_json::from_str(include_str!("lexicon.json")).expect("lexicon.json is malformed")
    })
}

impl Lexicon {
    /// Every single word the lexicon knows — the spelling target for the
    /// edit-distance pass.
    pub fn vocabulary(&self) -> &'static Vec<String> {
        static VOCAB: OnceLock<Vec<String>> = OnceLock::new();
        VOCAB.get_or_init(|| {
            let lex = lexicon();
            let mut words: Vec<String> = Vec::new();
            let mut push = |phrase: &str| {
                for word in phrase.split_whitespace() {
                    let word = word.trim_matches(|c: char| !c.is_alphanumeric());
                    if word.len() > 2 {
                        words.push(word.to_string());
                    }
                }
            };
            for list in lex.kinds.values() {
                for phrase in list {
                    push(phrase);
                }
            }
            for list in lex.windows.values() {
                for phrase in list {
                    push(phrase);
                }
            }
            for entry in &lex.verbs {
                for phrase in &entry.triggers {
                    push(phrase);
                }
            }
            for entry in &lex.write_verbs {
                for phrase in entry.surfaces.iter().chain(entry.needs.iter()) {
                    push(phrase);
                }
            }
            for word in lex
                .weekdays
                .keys()
                .chain(lex.numbers.keys())
                .chain(lex.ordinals.keys())
            {
                push(word);
            }
            for word in &lex.stopwords {
                push(word);
            }
            for word in &lex.open_task_words {
                push(word);
            }
            for word in &lex.safe_words {
                push(word);
            }
            // Every phrase the parser matches on is a spelling target, or the
            // corrector rewrites the words the rules are waiting for.
            for phrase in lex.undo.iter().chain(lex.fillers.iter()) {
                push(phrase);
            }
            for (surface, expansion) in &lex.contractions {
                push(surface);
                push(expansion);
            }
            for phrase in lex.refs.values().flatten() {
                push(phrase);
            }
            for phrase in lex.refuse.values().flatten().flatten() {
                for alternative in phrase.split('|') {
                    push(alternative);
                }
            }
            for phrase in lex.label_field.values().chain(lex.kind_of_field.values()) {
                push(phrase);
            }
            for word in [
                "password",
                "locker",
                "album",
                "group",
                "folder",
                "notebook",
                "birthday",
                "calendar",
                "photos",
                "tomorrow",
                "wednesday",
                "thursday",
                "money",
                "owe",
                "balance",
                "insurance",
                "agreement",
                "document",
                "documents",
                "overdue",
                "weekend",
                "dentist",
            ] {
                push(word);
            }
            words.sort();
            words.dedup();
            words
        })
    }
}

/// One token of the member's sentence: what it reads as, and what they typed.
#[derive(Clone, Debug)]
pub struct Token {
    pub lower: String,
    pub original: String,
    pub capitalised: bool,
    pub consumed: bool,
}

/// A normalised request: lower-cased, de-contracted, de-filled, spell-nudged,
/// with the member's own spans still recoverable.
#[derive(Clone, Debug)]
pub struct Norm {
    pub tokens: Vec<Token>,
    pub text: String,
    pub raw: String,
}

impl Norm {
    pub fn has(&self, phrase: &str) -> bool {
        find_phrase(&self.text, phrase).is_some()
    }

    /// Token indices covered by `phrase`, if the sentence contains it.
    pub fn locate(&self, phrase: &str) -> Option<(usize, usize)> {
        let words: Vec<&str> = phrase.split_whitespace().collect();
        if words.is_empty() {
            return None;
        }
        for start in 0..self.tokens.len() {
            if start + words.len() > self.tokens.len() {
                break;
            }
            if (0..words.len()).all(|k| self.tokens[start + k].lower == words[k]) {
                return Some((start, start + words.len()));
            }
        }
        None
    }

    pub fn consume(&mut self, span: (usize, usize)) {
        for token in &mut self.tokens[span.0..span.1] {
            token.consumed = true;
        }
    }

    /// Consume `phrase` wherever it occurs; report whether it was there.
    pub fn consume_phrase(&mut self, phrase: &str) -> bool {
        match self.locate(phrase) {
            Some(span) => {
                self.consume(span);
                true
            }
            None => false,
        }
    }

    pub fn word_at(&self, index: usize) -> Option<&str> {
        self.tokens.get(index).map(|token| token.lower.as_str())
    }
}

fn find_phrase(haystack: &str, needle: &str) -> Option<usize> {
    let padded = format!(" {haystack} ");
    padded.find(&format!(" {needle} "))
}

pub fn normalise(request: &str) -> Norm {
    let lex = lexicon();
    let mut tokens: Vec<Token> = Vec::new();
    for raw in request.split_whitespace() {
        let trimmed =
            raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-' && c != '"');
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        let expanded = lex.contractions.get(&lower).cloned().unwrap_or(lower);
        for piece in expanded.split_whitespace() {
            tokens.push(Token {
                lower: piece.to_string(),
                original: if piece == expanded {
                    trimmed.trim_matches('"').to_string()
                } else {
                    piece.to_string()
                },
                capitalised: trimmed
                    .chars()
                    .next()
                    .map(|c| c.is_uppercase())
                    .unwrap_or(false),
                consumed: false,
            });
        }
    }

    // Spelling: a single edit against the lexicon, never a rewrite.
    let vocab = lex.vocabulary();
    for token in &mut tokens {
        if token.lower.len() < 4 || vocab.contains(&token.lower) {
            continue;
        }
        let budget = 1usize;
        // A capitalised word is a NAME the vault may hold and this table
        // certainly does not; correcting it would destroy the one span the
        // executor has to resolve.
        if token.capitalised {
            continue;
        }
        let mut best: Option<(usize, &String)> = None;
        let mut ties = 0usize;
        for candidate in vocab {
            if candidate.len().abs_diff(token.lower.len()) > budget {
                continue;
            }
            let distance = edit_distance(&token.lower, candidate);
            if distance > budget {
                continue;
            }
            match best {
                Some((d, _)) if distance > d => {}
                Some((d, _)) if distance == d => ties += 1,
                _ => {
                    best = Some((distance, candidate));
                    ties = 0;
                }
            }
        }
        // An ambiguous correction is no correction: two equally close words
        // mean the table cannot tell what was meant, and a wrong terminal is
        // worse than an unknown one.
        if ties > 0 {
            continue;
        }
        if let Some((_, candidate)) = best {
            token.lower = candidate.clone();
        }
    }

    // Fillers are dropped from the READING, never from the spans.
    for filler in &lex.fillers {
        let words: Vec<&str> = filler.split_whitespace().collect();
        let mut start = 0usize;
        while start + words.len() <= tokens.len() {
            let hit = (0..words.len()).all(|k| tokens[start + k].lower == words[k]);
            if hit {
                tokens.drain(start..start + words.len());
            } else {
                start += 1;
            }
        }
    }

    let text = tokens
        .iter()
        .map(|t| t.lower.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    Norm {
        tokens,
        text,
        raw: request.to_string(),
    }
}

/// Damerau-Levenshtein (optimal string alignment): a TRANSPOSITION is one
/// edit, not two. The `typo` register is built of transpositions — "jsut",
/// "lgoin", "passowrd" — and plain Levenshtein reads every one of them as two
/// edits and leaves them uncorrected. This is the whole difference between a
/// 36% and a 50% typo register, and it costs one extra line of the table.
pub fn edit_distance(left: &str, right: &str) -> usize {
    let a: Vec<char> = left.chars().collect();
    let b: Vec<char> = right.chars().collect();
    let mut grid = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in grid.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in grid[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (grid[i - 1][j] + 1)
                .min(grid[i][j - 1] + 1)
                .min(grid[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(grid[i - 2][j - 2] + 1);
            }
            grid[i][j] = best;
        }
    }
    grid[a.len()][b.len()]
}
