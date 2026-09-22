//! # `canon` — the canonical tree, as Rust types
//!
//! A one-for-one mirror of [`GRAMMAR.md`](../../../evalsuite/grammar/GRAMMAR.md)
//! §1: the `Turn` / `Value` / `Cmd` / `Set` / `Pred` / `Window` / `Ref`
//! productions, a parser from the canonical STRING (the `canonical` field of
//! `grammar/map.json`) to the tree, and a serializer back.
//!
//! **The lexicons are the grammar's, not this crate's.** `KINDS`, `FIELDS`,
//! `REFS`, `WINDOW_PHRASES`, `DECLINE_REASONS` and the verb classes are
//! transcribed from `grammar/check.py`, which derives them from the ontology.
//! A terminal this module accepts and `check.py` does not is a drift, and the
//! round-trip test over every tree in `map.json` is what catches it.
//!
//! The parser is deliberately the same shape as `check.py`'s recursive-descent
//! parser — same precedence, same postfix loop, same lookahead — so the two can
//! be diffed by eye.

use std::collections::BTreeMap;
use std::fmt::Write as _;

// ---------------------------------------------------------------------------
// Lexicons — GENERATED, shared with grammar/check.py
// ---------------------------------------------------------------------------
//
// `crates/evalsuite/grammar/derive/emit.py` walks the ontology and writes both
// this file's tables and `check.py`'s from the one source, so the two parsers
// hold ONE lexicon rather than two transcriptions of one. `python3
// crates/evalsuite/grammar/check.py` fails when the committed file is stale.
// The PRODUCTIONS below are still hand-written in both, on purpose: a
// production is the shape of the meaning space and the ontology says nothing
// about it.

include!("canon_terminals.rs");

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Turn {
    Show(Set),
    /// The identity question (§1.1) — an id-set intersection.
    Same(Set, Set),
    Value(Value),
    Cmd(Cmd),
    /// `Cmd then Cmd` — an ORDERED SEQUENCE of typed writes in ONE turn.
    /// Two writes with different arguments, or of different verbs, are what
    /// one sentence asks for (s107.3, s113.3, h61.0) and a single [`Cmd`] has
    /// room for one. The order is the sentence's and the executor keeps it.
    Seq(Vec<Cmd>),
    Nothing,
    Refuse(String),
    Clarify(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// `count of S`, `sum F of S`, `min F of S`, `max F of S`.
    Agg {
        agg: String,
        field: Option<String>,
        set: Set,
    },
    /// `balance of S in S` — the Tally reader (§2.5).
    Balance { of: Set, within: Set },
    /// `F of S` — a projection of one column of one row.
    Project { field: String, set: Set },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cmd {
    pub verb: String,
    pub is_class: bool,
    /// Insertion order is the canonical's order and the serializer keeps it.
    pub args: Vec<(String, ArgVal)>,
    pub on: Option<Set>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgVal {
    /// `(Set)` — an id resolved from a set.
    SetArg(Set),
    Value(Box<Value>),
    Lit(Lit),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lit {
    /// `string`, `number`, `date`, `datetime`, `month`, `daterange`,
    /// `duration`, `keyword`.
    pub ty: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindNode {
    pub kind: String,
    pub entity: String,
    pub door: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Set {
    Kind(KindNode),
    /// `Kind of Set` — a link walk (§2.3).
    Walk {
        kind: KindNode,
        from: Box<Set>,
    },
    Called {
        set: Box<Set>,
        lit: String,
    },
    Filter {
        set: Box<Set>,
        pred: Box<Pred>,
    },
    During {
        set: Box<Set>,
        window: Window,
    },
    Order {
        set: Box<Set>,
        field: String,
        descending: bool,
    },
    Union(Box<Set>, Box<Set>),
    Except(Box<Set>, Box<Set>),
    First {
        n: u32,
        set: Box<Set>,
    },
    Ref(Ref),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ref {
    It,
    Them,
    ThatOne,
    TheOtherOne,
    TheEarlierOne,
    LastAdded,
    Ordinal(u32),
}

impl Ref {
    #[must_use]
    pub fn phrase(&self) -> String {
        match self {
            Self::It => "it".to_owned(),
            Self::Them => "them".to_owned(),
            Self::ThatOne => "that one".to_owned(),
            Self::TheOtherOne => "the other one".to_owned(),
            Self::TheEarlierOne => "the earlier one".to_owned(),
            Self::LastAdded => "the last thing I added".to_owned(),
            Self::Ordinal(n) => format!("the {n}{} one", ordinal_suffix(*n)),
        }
    }
}

fn ordinal_suffix(n: u32) -> &'static str {
    match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pred {
    And(Box<Pred>, Box<Pred>),
    /// `count of Kind Cmp Num` — a COUNT OVER THE WALK from the row being
    /// filtered (s112.1). The edge is the ontology's (§2.3) and the count is
    /// over the rows that walk reaches from THIS row, so the grammar needs no
    /// correlated-reference terminal.
    CountWalk {
        kind: KindNode,
        op: String,
        n: i64,
    },
    Or(Box<Pred>, Box<Pred>),
    Not(Box<Pred>),
    Member(Set),
    Is {
        field: String,
        what: String,
        negated: bool,
    },
    During {
        field: String,
        window: Window,
    },
    Band {
        field: String,
        centre: String,
    },
    Contains {
        field: String,
        lit: String,
    },
    OneOf {
        field: String,
        lits: Vec<String>,
    },
    Cmp {
        field: String,
        op: String,
        rhs: Operand,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operand {
    SetArg(Set),
    Lit(Lit),
    FieldRef(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Window {
    /// A bare `date`, `datetime`, `month` or `daterange` terminal.
    Stamp {
        how: String,
        value: String,
    },
    Phrase(String),
    Rolling {
        n: i64,
        unit: String,
    },
    /// `from (Value) to (Value)` — the anchored window (§2.6).
    Anchored {
        from: Box<Value>,
        to: Box<Value>,
    },
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    kind: &'static str,
    raw: String,
}

/// The tokenizer of `check.py`, in the same alternation order.
fn lex(text: &str) -> Result<Vec<Token>, String> {
    let bytes: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        let here = bytes[at];
        if here.is_whitespace() {
            at += 1;
            continue;
        }
        if here == '"' {
            let mut end = at + 1;
            let mut raw = String::new();
            loop {
                if end >= bytes.len() {
                    return Err(format!("unterminated string at {at}"));
                }
                if bytes[end] == '\\' && end + 1 < bytes.len() {
                    raw.push(bytes[end + 1]);
                    end += 2;
                    continue;
                }
                if bytes[end] == '"' {
                    end += 1;
                    break;
                }
                raw.push(bytes[end]);
                end += 1;
            }
            tokens.push(Token {
                kind: "string",
                raw,
            });
            at = end;
            continue;
        }
        if let Some(token) = numeric(&bytes, at) {
            at += token.1;
            tokens.push(token.0);
            continue;
        }
        if here == 's' && bytes[at..].starts_with(&['s', 'a', 'm', 'e', '?']) {
            tokens.push(Token {
                kind: "same",
                raw: "same?".to_owned(),
            });
            at += 5;
            continue;
        }
        if here.is_ascii_alphabetic() || here == '_' {
            let mut end = at;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == '_' || bytes[end] == '.')
            {
                end += 1;
            }
            tokens.push(Token {
                kind: "ident",
                raw: bytes[at..end].iter().collect(),
            });
            at = end;
            continue;
        }
        if matches!(here, '<' | '>' | '!' | '=') {
            let two: String = bytes[at..(at + 2).min(bytes.len())].iter().collect();
            if matches!(two.as_str(), "<=" | ">=" | "!=") {
                tokens.push(Token {
                    kind: "op",
                    raw: two,
                });
                at += 2;
            } else if matches!(here, '=' | '<' | '>') {
                tokens.push(Token {
                    kind: "op",
                    raw: here.to_string(),
                });
                at += 1;
            } else {
                return Err(format!("bad character at {at}"));
            }
            continue;
        }
        if matches!(here, '(' | ')' | '{' | '}' | ':' | ',') {
            tokens.push(Token {
                kind: "punct",
                raw: here.to_string(),
            });
            at += 1;
            continue;
        }
        return Err(format!("bad character at {at}: {here:?}"));
    }
    tokens.push(Token {
        kind: "eof",
        raw: String::new(),
    });
    Ok(tokens)
}

/// The numeric family: daterange, datetime, date, month, duration, ordinal,
/// number — tried in exactly `check.py`'s order.
#[expect(clippy::too_many_lines, reason = "one tokenizer family, read in order")]
fn numeric(bytes: &[char], at: usize) -> Option<(Token, usize)> {
    let digits = |from: usize, how_many: usize| {
        from + how_many <= bytes.len()
            && bytes[from..from + how_many]
                .iter()
                .all(char::is_ascii_digit)
    };
    let dash = |index: usize| index < bytes.len() && bytes[index] == '-';
    // daterange: YYYY-MM-DD..YYYY-MM-DD
    if digits(at, 4)
        && dash(at + 4)
        && digits(at + 5, 2)
        && dash(at + 7)
        && digits(at + 8, 2)
        && at + 10 < bytes.len()
    {
        if bytes.get(at + 10) == Some(&'.')
            && bytes.get(at + 11) == Some(&'.')
            && digits(at + 12, 4)
            && dash(at + 16)
            && digits(at + 17, 2)
            && dash(at + 19)
            && digits(at + 20, 2)
        {
            return Some((
                Token {
                    kind: "daterange",
                    raw: bytes[at..at + 22].iter().collect(),
                },
                22,
            ));
        }
        // datetime: YYYY-MM-DDTHH:MM[:SS[.fff]][Z]
        if bytes.get(at + 10) == Some(&'T')
            && digits(at + 11, 2)
            && bytes.get(at + 13) == Some(&':')
            && digits(at + 14, 2)
        {
            let mut end = at + 16;
            if bytes.get(end) == Some(&':') && digits(end + 1, 2) {
                end += 3;
                if bytes.get(end) == Some(&'.') {
                    let mut scan = end + 1;
                    while scan < bytes.len() && bytes[scan].is_ascii_digit() {
                        scan += 1;
                    }
                    if scan > end + 1 {
                        end = scan;
                    }
                }
            }
            if bytes.get(end) == Some(&'Z') {
                end += 1;
            }
            return Some((
                Token {
                    kind: "datetime",
                    raw: bytes[at..end].iter().collect(),
                },
                end - at,
            ));
        }
    }
    if digits(at, 4) && dash(at + 4) && digits(at + 5, 2) && dash(at + 7) && digits(at + 8, 2) {
        return Some((
            Token {
                kind: "date",
                raw: bytes[at..at + 10].iter().collect(),
            },
            10,
        ));
    }
    if digits(at, 4)
        && dash(at + 4)
        && digits(at + 5, 2)
        && !(at + 7 < bytes.len() && bytes[at + 7] == '-')
    {
        return Some((
            Token {
                kind: "month",
                raw: bytes[at..at + 7].iter().collect(),
            },
            7,
        ));
    }
    // duration: [+-]N[hdm]
    if matches!(bytes[at], '+' | '-') {
        let mut end = at + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > at + 1 && matches!(bytes.get(end), Some('h' | 'd' | 'm')) {
            return Some((
                Token {
                    kind: "duration",
                    raw: bytes[at..=end].iter().collect(),
                },
                end + 1 - at,
            ));
        }
    }
    let start = at;
    let mut end = at;
    if matches!(bytes.get(end), Some('-')) {
        end += 1;
    }
    let first = end;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == first {
        return None;
    }
    // ordinal: N(st|nd|rd|th) — only for an unsigned number
    if start == first {
        let suffix: String = bytes[end..(end + 2).min(bytes.len())].iter().collect();
        if matches!(suffix.as_str(), "st" | "nd" | "rd" | "th") {
            return Some((
                Token {
                    kind: "ordinal",
                    raw: bytes[start..end + 2].iter().collect(),
                },
                end + 2 - start,
            ));
        }
    }
    if bytes.get(end) == Some(&'.') && end + 1 < bytes.len() && bytes[end + 1].is_ascii_digit() {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    Some((
        Token {
            kind: "number",
            raw: bytes[start..end].iter().collect(),
        },
        end - start,
    ))
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

pub struct Parser {
    tokens: Vec<Token>,
    at: usize,
    kinds: BTreeMap<&'static str, (&'static str, &'static str)>,
    fields: Vec<&'static str>,
    classes: BTreeMap<&'static str, BTreeMap<&'static str, &'static str>>,
}

/// Parse one canonical utterance.
///
/// # Errors
///
/// The text is not in the grammar, or a terminal is outside the lexicon.
pub fn parse(text: &str) -> Result<Turn, String> {
    Parser::new(text)?.parse_turn()
}

impl Parser {
    /// # Errors
    ///
    /// The text does not tokenize.
    pub fn new(text: &str) -> Result<Self, String> {
        Ok(Self {
            tokens: lex(text)?,
            at: 0,
            kinds: kinds(),
            fields: fields(),
            classes: verb_classes(),
        })
    }

    fn peek(&self, ahead: usize) -> &Token {
        let index = (self.at + ahead).min(self.tokens.len() - 1);
        &self.tokens[index]
    }

    fn word(&self, ahead: usize) -> Option<&str> {
        let token = self.peek(ahead);
        if token.kind == "ident" {
            Some(token.raw.as_str())
        } else {
            None
        }
    }

    fn take(&mut self) -> Token {
        let token = self.tokens[self.at.min(self.tokens.len() - 1)].clone();
        self.at += 1;
        token
    }

    fn expect_word(&mut self, words: &[&str]) -> Result<String, String> {
        let found = self.word(0).map(str::to_owned);
        match found {
            Some(raw) if words.contains(&raw.as_str()) => {
                self.take();
                Ok(raw)
            }
            _ => Err(format!(
                "expected {}, found {:?}",
                words.join("/"),
                self.peek(0).raw
            )),
        }
    }

    fn expect_punct(&mut self, ch: char) -> Result<(), String> {
        if self.peek(0).raw == ch.to_string() {
            self.take();
            Ok(())
        } else {
            Err(format!("expected {ch:?}, found {:?}", self.peek(0).raw))
        }
    }

    fn eat_word(&mut self, words: &[&str]) -> bool {
        match self.word(0) {
            Some(raw) if words.contains(&raw) => {
                self.take();
                true
            }
            _ => false,
        }
    }

    fn eat_punct(&mut self, ch: char) -> bool {
        let token = self.peek(0);
        if token.raw == ch.to_string() && matches!(token.kind, "punct" | "op") {
            self.take();
            true
        } else {
            false
        }
    }

    /// # Errors
    ///
    /// The text is not a legal turn, or has trailing input.
    pub fn parse_turn(&mut self) -> Result<Turn, String> {
        let node = self.turn()?;
        if self.peek(0).kind != "eof" {
            return Err(format!("trailing input at {:?}", self.peek(0).raw));
        }
        Ok(node)
    }

    fn turn(&mut self) -> Result<Turn, String> {
        match self.word(0) {
            Some("nothing") => {
                self.take();
                return Ok(Turn::Nothing);
            }
            Some(raw @ ("refuse" | "clarify")) => {
                let which = raw.to_owned();
                self.take();
                self.expect_punct(':')?;
                let reason = self
                    .word(0)
                    .ok_or_else(|| "expected a decline reason".to_owned())?
                    .to_owned();
                if !DECLINE_REASONS.contains(&reason.as_str()) {
                    return Err(format!("unknown decline reason {reason:?}"));
                }
                self.take();
                return Ok(if which == "refuse" {
                    Turn::Refuse(reason)
                } else {
                    Turn::Clarify(reason)
                });
            }
            Some("show") => {
                self.take();
                return Ok(Turn::Show(self.set_expr()?));
            }
            _ => {}
        }
        if self.peek(0).kind == "same" {
            self.take();
            let left = self.set_primary_or_group()?;
            let right = self.set_primary_or_group()?;
            return Ok(Turn::Same(left, right));
        }
        if self.word(0).is_some() && self.peek(1).raw == "{" {
            let first = self.cmd()?;
            if self.word(0) != Some("then") {
                return Ok(Turn::Cmd(first));
            }
            let mut steps = vec![first];
            while self.eat_word(&["then"]) {
                steps.push(self.cmd()?);
            }
            return Ok(Turn::Seq(steps));
        }
        Ok(Turn::Value(self.value()?))
    }

    fn looks_like_value(&self) -> bool {
        match self.word(0) {
            Some("count" | "sum" | "min" | "max" | "balance") => true,
            Some(_) => self.word(1) == Some("of"),
            None => false,
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        match self.word(0) {
            Some("count") => {
                self.take();
                self.expect_word(&["of"])?;
                Ok(Value::Agg {
                    agg: "count".to_owned(),
                    field: None,
                    set: self.set_expr()?,
                })
            }
            Some(raw @ ("sum" | "min" | "max")) => {
                let agg = raw.to_owned();
                self.take();
                let field = self.field()?;
                self.expect_word(&["of"])?;
                Ok(Value::Agg {
                    agg,
                    field: Some(field),
                    set: self.set_expr()?,
                })
            }
            Some("balance") => {
                self.take();
                self.expect_word(&["of"])?;
                let who = self.set_expr()?;
                self.expect_word(&["in"])?;
                let where_ = self.set_expr()?;
                Ok(Value::Balance {
                    of: who,
                    within: where_,
                })
            }
            Some(_) if self.word(1) == Some("of") => {
                let field = self.field()?;
                self.expect_word(&["of"])?;
                Ok(Value::Project {
                    field,
                    set: self.set_expr()?,
                })
            }
            _ => Err(format!("expected a value, found {:?}", self.peek(0).raw)),
        }
    }

    fn cmd(&mut self) -> Result<Cmd, String> {
        let verb = self
            .word(0)
            .ok_or_else(|| "expected a verb".to_owned())?
            .to_owned();
        let is_class = self.classes.contains_key(verb.as_str());
        self.take();
        self.expect_punct('{')?;
        let mut args = Vec::new();
        if !self.eat_punct('}') {
            loop {
                let key = self
                    .word(0)
                    .ok_or_else(|| "expected an argument name".to_owned())?
                    .to_owned();
                self.take();
                self.expect_punct(':')?;
                args.push((key, self.argval()?));
                if self.eat_punct(',') {
                    continue;
                }
                self.expect_punct('}')?;
                break;
            }
        }
        let on = if self.eat_word(&["on"]) {
            Some(self.set_expr()?)
        } else {
            None
        };
        Ok(Cmd {
            verb,
            is_class,
            args,
            on,
        })
    }

    fn argval(&mut self) -> Result<ArgVal, String> {
        let token = self.peek(0).clone();
        if token.raw == "(" {
            self.take();
            let inner = self.set_expr()?;
            self.expect_punct(')')?;
            return Ok(ArgVal::SetArg(inner));
        }
        if token.kind == "ident" && self.looks_like_value() {
            return Ok(ArgVal::Value(Box::new(self.value()?)));
        }
        if matches!(
            token.kind,
            "string" | "number" | "date" | "datetime" | "month" | "daterange" | "duration"
        ) {
            self.take();
            return Ok(ArgVal::Lit(Lit {
                ty: token.kind.to_owned(),
                value: token.raw,
            }));
        }
        if token.kind == "ident" && matches!(token.raw.as_str(), "null" | "true" | "false" | "me") {
            self.take();
            return Ok(ArgVal::Lit(Lit {
                ty: "keyword".to_owned(),
                value: token.raw,
            }));
        }
        Err(format!("bad argument value {:?}", token.raw))
    }

    /// `and` / `except` bind LOOSER than the postfix operators (`called`,
    /// `that`, `during`, `ordered by`): `photos called "Ana" and photos called
    /// "Marco"` is a union of two NAMED sets, not a named union. A postfix over
    /// a union is written with the union parenthesised, which GRAMMAR.md §1
    /// already requires of a nested `Set` operand. Kept identical to
    /// `grammar/check.py`.
    fn set_expr(&mut self) -> Result<Set, String> {
        let mut node = self.set_postfix()?;
        loop {
            match self.word(0) {
                Some("and") => {
                    self.take();
                    node = Set::Union(Box::new(node), Box::new(self.set_postfix()?));
                }
                Some("except") => {
                    self.take();
                    node = Set::Except(Box::new(node), Box::new(self.set_postfix()?));
                }
                _ => return Ok(node),
            }
        }
    }

    fn set_postfix(&mut self) -> Result<Set, String> {
        let mut node = self.set_primary()?;
        loop {
            match self.word(0) {
                Some("called") => {
                    self.take();
                    let lit = self.string()?;
                    node = Set::Called {
                        set: Box::new(node),
                        lit,
                    };
                }
                Some("that") => {
                    self.take();
                    self.expect_punct('(')?;
                    let pred = self.pred()?;
                    self.expect_punct(')')?;
                    node = Set::Filter {
                        set: Box::new(node),
                        pred: Box::new(pred),
                    };
                }
                Some("during") => {
                    self.take();
                    let window = self.window()?;
                    node = Set::During {
                        set: Box::new(node),
                        window,
                    };
                }
                Some("ordered") => {
                    self.take();
                    self.expect_word(&["by"])?;
                    let field = self.field()?;
                    let direction = self.expect_word(&["asc", "desc"])?;
                    node = Set::Order {
                        set: Box::new(node),
                        field,
                        descending: direction == "desc",
                    };
                }
                _ => return Ok(node),
            }
        }
    }

    fn set_primary(&mut self) -> Result<Set, String> {
        if self.eat_punct('(') {
            let node = self.set_expr()?;
            self.expect_punct(')')?;
            return Ok(node);
        }
        if self.word(0) == Some("first") {
            self.take();
            let token = self.take();
            if token.kind != "number" {
                return Err("expected a count after `first`".to_owned());
            }
            let n: u32 = token.raw.parse().map_err(|_| "bad count".to_owned())?;
            self.expect_word(&["of"])?;
            return Ok(Set::First {
                n,
                set: Box::new(self.set_expr()?),
            });
        }
        if let Some(found) = self.reference() {
            return Ok(Set::Ref(found));
        }
        let kind = self.kind()?;
        let (entity, door) = self.kinds[kind.as_str()];
        let node = KindNode {
            kind,
            entity: entity.to_owned(),
            door: door.to_owned(),
        };
        if self.word(0) == Some("of") {
            self.take();
            return Ok(Set::Walk {
                kind: node,
                from: Box::new(self.set_primary_or_group()?),
            });
        }
        Ok(Set::Kind(node))
    }

    fn set_primary_or_group(&mut self) -> Result<Set, String> {
        if self.eat_punct('(') {
            let node = self.set_expr()?;
            self.expect_punct(')')?;
            return Ok(node);
        }
        self.set_primary()
    }

    fn reference(&mut self) -> Option<Ref> {
        if self.word(0) == Some("the")
            && self.peek(1).kind == "ordinal"
            && self.word(2) == Some("one")
        {
            let raw = &self.peek(1).raw;
            let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
            let n = digits.parse().ok()?;
            self.at += 3;
            return Some(Ref::Ordinal(n));
        }
        // 2 IS IN THIS LIST because `that one` is a two-word terminal: it was
        // in REFS and unreachable, so no canonical could say it. Kept
        // identical to `grammar/check.py`.
        for length in [5usize, 4, 3, 2, 1] {
            let mut words = Vec::new();
            let mut ok = true;
            for index in 0..length {
                match self.word(index) {
                    Some(raw) => words.push(raw.to_owned()),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            let phrase = words.join(" ");
            if REFS.contains(&phrase.as_str()) {
                self.at += length;
                return Some(match phrase.as_str() {
                    "it" => Ref::It,
                    "them" => Ref::Them,
                    "that one" => Ref::ThatOne,
                    "the other one" => Ref::TheOtherOne,
                    "the earlier one" => Ref::TheEarlierOne,
                    _ => Ref::LastAdded,
                });
            }
        }
        None
    }

    fn kind(&mut self) -> Result<String, String> {
        for length in [2usize, 1] {
            let mut words = Vec::new();
            let mut ok = true;
            for index in 0..length {
                match self.word(index) {
                    Some(raw) => words.push(raw.to_owned()),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            let phrase = words.join(" ");
            if self.kinds.contains_key(phrase.as_str()) {
                self.at += length;
                return Ok(phrase);
            }
        }
        Err(format!("unknown kind at {:?}", self.peek(0).raw))
    }

    fn pred(&mut self) -> Result<Pred, String> {
        let mut node = self.pred_atom()?;
        while matches!(self.word(0), Some("and" | "or")) {
            let how = self.take().raw;
            let right = self.pred_atom()?;
            node = if how == "and" {
                Pred::And(Box::new(node), Box::new(right))
            } else {
                Pred::Or(Box::new(node), Box::new(right))
            };
        }
        Ok(node)
    }

    fn pred_atom(&mut self) -> Result<Pred, String> {
        if self.eat_word(&["not"]) {
            return Ok(Pred::Not(Box::new(self.pred_atom()?)));
        }
        if self.eat_punct('(') {
            let node = self.pred()?;
            self.expect_punct(')')?;
            return Ok(node);
        }
        if self.word(0) == Some("count") && self.word(1) == Some("of") {
            self.take();
            self.take();
            let kind = self.kind()?;
            let (entity, door) = self.kinds[kind.as_str()];
            let operator = self.peek(0).clone();
            if operator.kind != "op" {
                return Err(format!("expected a comparison after `count of {kind}`"));
            }
            self.take();
            let number = self.take();
            if number.kind != "number" {
                return Err(format!("expected a number after `count of {kind}`"));
            }
            return Ok(Pred::CountWalk {
                kind: KindNode {
                    kind,
                    entity: entity.to_owned(),
                    door: door.to_owned(),
                },
                op: operator.raw,
                n: number.raw.parse().map_err(|_| "bad count".to_owned())?,
            });
        }
        if self.word(0) == Some("member") && self.word(1) == Some("of") {
            self.take();
            self.take();
            return Ok(Pred::Member(self.set_primary_or_group()?));
        }
        let field = self.field()?;
        match self.word(0) {
            Some("is") => {
                self.take();
                let negated = self.eat_word(&["not"]);
                let what = self.expect_word(&["null", "me"])?;
                return Ok(Pred::Is {
                    field,
                    what,
                    negated,
                });
            }
            Some("during") => {
                self.take();
                return Ok(Pred::During {
                    field,
                    window: self.window()?,
                });
            }
            Some("around") => {
                self.take();
                let token = self.take();
                if token.kind != "number" {
                    return Err("expected a number after `around`".to_owned());
                }
                return Ok(Pred::Band {
                    field,
                    centre: token.raw,
                });
            }
            Some("contains") => {
                self.take();
                return Ok(Pred::Contains {
                    field,
                    lit: self.string()?,
                });
            }
            Some("in") => {
                self.take();
                self.expect_punct('(')?;
                let mut lits = vec![self.string()?];
                while self.eat_punct(',') {
                    lits.push(self.string()?);
                }
                self.expect_punct(')')?;
                return Ok(Pred::OneOf { field, lits });
            }
            _ => {}
        }
        if self.peek(0).kind == "op" {
            let op = self.take().raw;
            return Ok(Pred::Cmp {
                field,
                op,
                rhs: self.operand()?,
            });
        }
        Err(format!(
            "expected a predicate operator, found {:?}",
            self.peek(0).raw
        ))
    }

    fn operand(&mut self) -> Result<Operand, String> {
        let token = self.peek(0).clone();
        if token.raw == "(" {
            self.take();
            let inner = self.set_expr()?;
            self.expect_punct(')')?;
            return Ok(Operand::SetArg(inner));
        }
        if matches!(
            token.kind,
            "string" | "number" | "date" | "datetime" | "month" | "daterange"
        ) {
            self.take();
            return Ok(Operand::Lit(Lit {
                ty: token.kind.to_owned(),
                value: token.raw,
            }));
        }
        if token.kind == "ident" && matches!(token.raw.as_str(), "true" | "false" | "null" | "me") {
            self.take();
            return Ok(Operand::Lit(Lit {
                ty: "keyword".to_owned(),
                value: token.raw,
            }));
        }
        if token.kind == "ident" {
            return Ok(Operand::FieldRef(self.field()?));
        }
        Err(format!("bad operand {:?}", token.raw))
    }

    fn field(&mut self) -> Result<String, String> {
        let raw = self
            .word(0)
            .ok_or_else(|| format!("expected a field, found {:?}", self.peek(0).raw))?
            .to_owned();
        if !self.fields.contains(&raw.as_str()) {
            return Err(format!("unknown field {raw:?}"));
        }
        self.take();
        Ok(raw)
    }

    fn string(&mut self) -> Result<String, String> {
        let token = self.peek(0).clone();
        if token.kind != "string" {
            return Err(format!("expected a quoted literal, found {:?}", token.raw));
        }
        self.take();
        Ok(token.raw)
    }

    fn window(&mut self) -> Result<Window, String> {
        let token = self.peek(0).clone();
        if matches!(token.kind, "date" | "datetime" | "month" | "daterange") {
            self.take();
            return Ok(Window::Stamp {
                how: token.kind.to_owned(),
                value: token.raw,
            });
        }
        if self.word(0) == Some("from") {
            self.take();
            self.expect_punct('(')?;
            let start = self.value()?;
            self.expect_punct(')')?;
            self.expect_word(&["to"])?;
            self.expect_punct('(')?;
            let end = self.value()?;
            self.expect_punct(')')?;
            return Ok(Window::Anchored {
                from: Box::new(start),
                to: Box::new(end),
            });
        }
        if self.word(0) == Some("next") && self.peek(1).kind == "number" {
            self.take();
            let count: i64 = self
                .take()
                .raw
                .parse()
                .map_err(|_| "bad count in a rolling window".to_owned())?;
            let unit = self.expect_word(&["months", "days", "weeks"])?;
            return Ok(Window::Rolling { n: count, unit });
        }
        for length in [2usize, 1] {
            let mut words = Vec::new();
            let mut ok = true;
            for index in 0..length {
                match self.word(index) {
                    Some(raw) => words.push(raw.to_owned()),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            let phrase = words.join(" ");
            if WINDOW_PHRASES.contains(&phrase.as_str()) {
                self.at += length;
                return Ok(Window::Phrase(phrase));
            }
        }
        Err(format!("unknown window at {:?}", self.peek(0).raw))
    }
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

fn quote(raw: &str) -> String {
    let mut out = String::from("\"");
    for ch in raw.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

impl Turn {
    /// The canonical string this tree denotes.
    ///
    /// Not byte-identical to the corpus's own spelling — it parenthesizes
    /// every nested `Set` — but it reparses to the same tree, which is the
    /// property the round-trip test asserts.
    #[must_use]
    pub fn to_canonical(&self) -> String {
        match self {
            Self::Show(set) => format!("show ({})", set.to_canonical()),
            Self::Same(left, right) => {
                format!("same? ({}) ({})", left.to_canonical(), right.to_canonical())
            }
            Self::Value(value) => value.to_canonical(),
            Self::Cmd(cmd) => cmd.to_canonical(),
            Self::Seq(steps) => steps
                .iter()
                .map(Cmd::to_canonical)
                .collect::<Vec<_>>()
                .join(" then "),
            Self::Nothing => "nothing".to_owned(),
            Self::Refuse(reason) => format!("refuse: {reason}"),
            Self::Clarify(reason) => format!("clarify: {reason}"),
        }
    }
}

impl Value {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        match self {
            Self::Agg { agg, field, set } => match field {
                Some(field) => format!("{agg} {field} of ({})", set.to_canonical()),
                None => format!("{agg} of ({})", set.to_canonical()),
            },
            Self::Balance { of, within } => format!(
                "balance of ({}) in ({})",
                of.to_canonical(),
                within.to_canonical()
            ),
            Self::Project { field, set } => format!("{field} of ({})", set.to_canonical()),
        }
    }
}

impl Cmd {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        let mut out = format!("{}{{", self.verb);
        for (index, (name, value)) in self.args.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            let _ = write!(out, "{name}: {}", value.to_canonical());
        }
        out.push('}');
        if let Some(on) = &self.on {
            let _ = write!(out, " on ({})", on.to_canonical());
        }
        out
    }
}

impl ArgVal {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        match self {
            Self::SetArg(set) => format!("({})", set.to_canonical()),
            Self::Value(value) => value.to_canonical(),
            Self::Lit(lit) => lit.to_canonical(),
        }
    }
}

impl Lit {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        if self.ty == "string" {
            quote(&self.value)
        } else {
            self.value.clone()
        }
    }
}

impl Set {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        match self {
            Self::Kind(kind) => kind.kind.clone(),
            Self::Walk { kind, from } => format!("{} of ({})", kind.kind, from.to_canonical()),
            Self::Called { set, lit } => format!("({}) called {}", set.to_canonical(), quote(lit)),
            Self::Filter { set, pred } => {
                format!("({}) that ({})", set.to_canonical(), pred.to_canonical())
            }
            Self::During { set, window } => {
                format!("({}) during {}", set.to_canonical(), window.to_canonical())
            }
            Self::Order {
                set,
                field,
                descending,
            } => format!(
                "({}) ordered by {field} {}",
                set.to_canonical(),
                if *descending { "desc" } else { "asc" }
            ),
            Self::Union(left, right) => {
                format!("({}) and ({})", left.to_canonical(), right.to_canonical())
            }
            Self::Except(left, right) => {
                format!(
                    "({}) except ({})",
                    left.to_canonical(),
                    right.to_canonical()
                )
            }
            Self::First { n, set } => format!("first {n} of ({})", set.to_canonical()),
            Self::Ref(found) => found.phrase(),
        }
    }
}

impl Pred {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        match self {
            Self::CountWalk { kind, op, n } => format!("count of {} {op} {n}", kind.kind),
            Self::And(left, right) => {
                format!("({}) and ({})", left.to_canonical(), right.to_canonical())
            }
            Self::Or(left, right) => {
                format!("({}) or ({})", left.to_canonical(), right.to_canonical())
            }
            Self::Not(inner) => format!("not ({})", inner.to_canonical()),
            Self::Member(set) => format!("member of ({})", set.to_canonical()),
            Self::Is {
                field,
                what,
                negated,
            } => format!("{field} is {}{what}", if *negated { "not " } else { "" }),
            Self::During { field, window } => format!("{field} during {}", window.to_canonical()),
            Self::Band { field, centre } => format!("{field} around {centre}"),
            Self::Contains { field, lit } => format!("{field} contains {}", quote(lit)),
            Self::OneOf { field, lits } => format!(
                "{field} in ({})",
                lits.iter()
                    .map(|lit| quote(lit))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Self::Cmp { field, op, rhs } => format!("{field} {op} {}", rhs.to_canonical()),
        }
    }
}

impl Operand {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        match self {
            Self::SetArg(set) => format!("({})", set.to_canonical()),
            Self::Lit(lit) => lit.to_canonical(),
            Self::FieldRef(field) => field.clone(),
        }
    }
}

impl Window {
    #[must_use]
    pub fn to_canonical(&self) -> String {
        match self {
            Self::Stamp { value, .. } => value.clone(),
            Self::Phrase(phrase) => phrase.clone(),
            Self::Rolling { n, unit } => format!("next {n} {unit}"),
            Self::Anchored { from, to } => {
                format!("from ({}) to ({})", from.to_canonical(), to.to_canonical())
            }
        }
    }
}
