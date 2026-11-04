//! THE PER-STEP GRAMMAR (#1166): what the think of one step may say, built fresh from the catalog and the rendered prompt.
//!
//! The think is the only text the model writes (`step.rs`: the call is compiled from it), so the grammar constrains the
//! think. It is built in **stages**, each a layer of rules the next one refers to, and emitted as ONE GBNF grammar:
//! the engine makes a fresh context per generation, so a grammar per stage would prefill the prompt again for each.
//!
//! 1. **tool**: the `intent` line, then `via` and `verb`. The tool is the one these name (`compile.rs`: `create`, `edit`
//!    or `do` for a verb, `find`/`compute` for `via`, `answer` otherwise), so the verb list is the catalog's.
//! 2. **rows**: `pick`, `rows`, `row` take only handles the prompt shows ([`Visible`]): a `#n` of the directory, the
//!    `focus:` line or an observation, an `@k` of an observation. A verb that was chosen is followed by a `kind` that
//!    verb applies to (`Verb::kinds`), or by none (a picked row, or a verb that fixes it).
//! 3. **fields**: once the kind is chosen, only its tail: `field`, `group`, `where`, `order` and `set` name fields of
//!    that kind (a `where` also its links), and every other slot is the shared rule. The handle slots (`linked_to`,
//!    `within`, `exclude`, `value`, `options`) name visible handles; a `dates[i]` names an entry of the `dates:` line.
//!
//! Free text (`name`, `text`, a `where` literal, a `set` value, a phrase) is not constrained to the user's message: a
//! grammar cannot say "a span of that message" without enumerating its substrings, and the phrases of a trace are not
//! verbatim ([`crate::native::step`] checks the spans after decoding instead). What the grammar does for free text is
//! keep a `#` or `@` followed by a digit, and a `dates[`, to the handles that exist: a name that says `#5` when `#5`
//! is not shown cannot be decoded.
//!
//! [`GrammarMode::Handles`] is the grammar for a model whose think format the grammar does not know (S2 writes `search`
//! and `open` for `find`): any text, with the handle rule above and nothing else.
//!
//! The rule tree renders to GBNF ([`Grammar::to_gbnf`]) and has a matcher ([`Grammar::accepts`]) so a test can check a
//! grammar without an engine. The two read the same tree.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::native::compile::PICK_REASONS;
use crate::native::identity::MODEL;
use crate::native::meta::{self, Kind};
use crate::native::prompt::ToolsMode;

/// How much of the think the grammar holds to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GrammarMode {
    /// No grammar: the think is free, as S2 was trained and as the phone ships.
    #[default]
    Off,
    /// Free text, but a handle (`#n`, `@k`, `dates[i]`) must be one the prompt shows.
    Handles,
    /// The slot lines in order, the tool, kind, verb and fields of the catalog, and the handles.
    Full,
}

impl GrammarMode {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Handles => "handles",
            Self::Full => "full",
        }
    }

    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "off" => Some(Self::Off),
            "handles" => Some(Self::Handles),
            "full" => Some(Self::Full),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// the handles a prompt shows
// ---------------------------------------------------------------------------------------------

/// The handles a rendered prompt shows: every `#n` and `@k` in its text (the directory, the `focus:` line, the
/// pre-grounded block, the observations and the calls already made), and how many entries its `dates:` line has.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Visible {
    pub rows: BTreeSet<u32>,
    pub results: BTreeSet<u32>,
    pub dates: usize,
}

impl Visible {
    /// The handles of `prompt`; `dates` is the `dates:` line of the turn's message when the prompt has one.
    #[must_use]
    pub fn of(prompt: &str, dates: Option<&str>) -> Self {
        let mut seen = Self::default();
        let chars: Vec<char> = prompt.chars().collect();
        let mut at = 0;
        while at < chars.len() {
            let sigil = chars[at];
            at += 1;
            if sigil != '#' && sigil != '@' {
                continue;
            }
            let start = at;
            while at < chars.len() && chars[at].is_ascii_digit() {
                at += 1;
            }
            if at == start || at - start > 9 {
                continue;
            }
            let number: String = chars[start..at].iter().collect();
            let Ok(number) = number.parse::<u32>() else {
                continue;
            };
            if sigil == '#' {
                seen.rows.insert(number);
            } else {
                seen.results.insert(number);
            }
        }
        seen.dates = dates.map_or(0, |line| {
            line.strip_prefix("dates:")
                .unwrap_or(line)
                .split(" · ")
                .filter(|part| part.contains(" = "))
                .count()
        });
        seen
    }
}

// ---------------------------------------------------------------------------------------------
// the rule tree
// ---------------------------------------------------------------------------------------------

/// A set of characters: `[abc]`, or `[^abc]` when negated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Class {
    negated: bool,
    chars: Vec<char>,
}

impl Class {
    fn holds(&self, letter: char) -> bool {
        self.chars.contains(&letter) != self.negated
    }
}

/// One right-hand side of a rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rule {
    Lit(String),
    Class(Class),
    Seq(Vec<Rule>),
    Alt(Vec<Rule>),
    Opt(Box<Rule>),
    Ref(String),
}

fn lit(text: &str) -> Rule {
    Rule::Lit(text.to_owned())
}

fn seq(parts: Vec<Rule>) -> Rule {
    Rule::Seq(parts)
}

fn alt(parts: Vec<Rule>) -> Rule {
    Rule::Alt(parts)
}

fn opt(rule: Rule) -> Rule {
    Rule::Opt(Box::new(rule))
}

fn rf(name: &str) -> Rule {
    Rule::Ref(name.to_owned())
}

fn any_but(chars: &str) -> Rule {
    Rule::Class(Class {
        negated: true,
        chars: chars.chars().collect(),
    })
}

fn one_of(chars: &str) -> Rule {
    Rule::Class(Class {
        negated: false,
        chars: chars.chars().collect(),
    })
}

/// A set of rules, the first of which is the root.
#[derive(Debug, Clone, Default)]
pub struct Grammar {
    rules: Vec<(String, Rule)>,
    index: BTreeMap<String, usize>,
}

impl Grammar {
    fn add(&mut self, name: &str, rule: Rule) {
        if let Some(at) = self.index.get(name) {
            self.rules[*at].1 = rule;
            return;
        }
        self.index.insert(name.to_owned(), self.rules.len());
        self.rules.push((name.to_owned(), rule));
    }

    /// The number of rules, for a test that watches the grammar's size.
    #[must_use]
    pub fn len(&self) -> usize {
        self.rules.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// The grammar in llama.cpp's GBNF, root first.
    #[must_use]
    pub fn to_gbnf(&self) -> String {
        let mut out = String::new();
        for (name, rule) in &self.rules {
            out.push_str(name);
            out.push_str(" ::= ");
            out.push_str(&gbnf(rule, true));
            out.push('\n');
        }
        out
    }

    /// Whether the grammar derives all of `text`.
    #[must_use]
    pub fn accepts(&self, text: &str) -> bool {
        let chars: Vec<char> = text.chars().collect();
        let Some((_, root)) = self.rules.first() else {
            return false;
        };
        let mut memo = HashMap::new();
        self.ends(root, &chars, 0, &mut memo).contains(&chars.len())
    }

    fn ends(&self, rule: &Rule, text: &[char], at: usize, memo: &mut Memo) -> BTreeSet<usize> {
        match rule {
            Rule::Lit(word) => {
                let word: Vec<char> = word.chars().collect();
                if text.len() >= at + word.len() && text[at..at + word.len()] == word[..] {
                    BTreeSet::from([at + word.len()])
                } else {
                    BTreeSet::new()
                }
            }
            Rule::Class(class) => match text.get(at) {
                Some(letter) if class.holds(*letter) => BTreeSet::from([at + 1]),
                _ => BTreeSet::new(),
            },
            Rule::Seq(parts) => {
                let mut here = BTreeSet::from([at]);
                for part in parts {
                    let mut next = BTreeSet::new();
                    for start in &here {
                        next.extend(self.ends(part, text, *start, memo));
                    }
                    here = next;
                    if here.is_empty() {
                        break;
                    }
                }
                here
            }
            Rule::Alt(parts) => parts
                .iter()
                .flat_map(|part| self.ends(part, text, at, memo))
                .collect(),
            Rule::Opt(inner) => {
                let mut out = self.ends(inner, text, at, memo);
                out.insert(at);
                out
            }
            Rule::Ref(name) => {
                let Some(at_rule) = self.index.get(name) else {
                    return BTreeSet::new();
                };
                if let Some(done) = memo.get(&(*at_rule, at)) {
                    return done.clone();
                }
                let out = self.ends(&self.rules[*at_rule].1, text, at, memo);
                memo.insert((*at_rule, at), out.clone());
                out
            }
        }
    }
}

type Memo = HashMap<(usize, usize), BTreeSet<usize>>;

fn escape_lit(text: &str) -> String {
    let mut out = String::from("\"");
    for letter in text.chars() {
        match letter {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => out.push_str(&format!("\\x{:02X}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn escape_class_char(letter: char) -> String {
    if letter.is_ascii_alphanumeric() {
        letter.to_string()
    } else if (letter as u32) < 0x80 {
        format!("\\x{:02X}", letter as u32)
    } else {
        format!("\\U{:08X}", letter as u32)
    }
}

fn gbnf(rule: &Rule, top: bool) -> String {
    match rule {
        Rule::Lit(text) => escape_lit(text),
        Rule::Class(class) => {
            let body: String = class.chars.iter().map(|letter| escape_class_char(*letter)).collect();
            format!("[{}{body}]", if class.negated { "^" } else { "" })
        }
        Rule::Seq(parts) => {
            let text = parts
                .iter()
                .map(|part| match part {
                    Rule::Alt(_) => format!("({})", gbnf(part, true)),
                    other => gbnf(other, false),
                })
                .collect::<Vec<_>>()
                .join(" ");
            if top || parts.len() <= 1 {
                text
            } else {
                format!("({text})")
            }
        }
        Rule::Alt(parts) => parts
            .iter()
            .map(|part| gbnf(part, true))
            .collect::<Vec<_>>()
            .join(" | "),
        Rule::Opt(inner) => match &**inner {
            Rule::Lit(_) | Rule::Class(_) | Rule::Ref(_) => format!("{}?", gbnf(inner, false)),
            other => format!("({})?", gbnf(other, true)),
        },
        Rule::Ref(name) => name.clone(),
    }
}

// ---------------------------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------------------------

/// What `dates[` is: the characters of the chain a free text must not complete with a number that is no entry.
const CHAIN: [char; 6] = ['d', 'a', 't', 'e', 's', '['];

struct Builder<'a> {
    grammar: Grammar,
    seen: &'a Visible,
}

impl<'a> Builder<'a> {
    fn new(seen: &'a Visible) -> Self {
        Self {
            grammar: Grammar::default(),
            seen,
        }
    }

    // --- free text -------------------------------------------------------------------------

    /// The family `family` of rules for a text of any characters but `excluded`, in which a `#n`, `@k` and `dates[i]` can
    /// only name what the prompt shows. Every state may stop: whatever follows (a newline, ` · `, a quote) is a character the
    /// text excludes, or the end of the grammar. The states are a DFA over the text, so the grammar has no ambiguity.
    fn free(&mut self, family: &str, excluded: &str) {
        let state = |k: usize| format!("{family}-s{k}");
        let stop = || lit("");
        let plain_extra = format!("{excluded}#@d");
        // what may follow a sigil with no digit read, or a number that is complete: a character that is no digit, or a stop
        let rest = || {
            alt(vec![
                stop(),
                seq(vec![any_but(&format!("{excluded}0123456789#@d")), rf(&state(0))]),
                seq(vec![lit("d"), rf(&state(1))]),
            ])
        };
        // the numbers a sigil may name, as a trie of the digits read so far
        let trie = |this: &mut Self, sigil: char, numbers: &BTreeSet<u32>| {
            let words: Vec<String> = numbers.iter().map(u32::to_string).collect();
            let mut prefixes: BTreeSet<String> = BTreeSet::new();
            prefixes.insert(String::new());
            for word in &words {
                for cut in 1..=word.len() {
                    prefixes.insert(word[..cut].to_owned());
                }
            }
            let tag = if sigil == '#' { "h" } else { "a" };
            for prefix in &prefixes {
                let mut options = Vec::new();
                for digit in '0'..='9' {
                    let next = format!("{prefix}{digit}");
                    if prefixes.contains(&next) {
                        options.push(seq(vec![lit(&digit.to_string()), rf(&format!("{family}-{tag}{next}"))]));
                    }
                }
                if prefix.is_empty() || words.contains(prefix) {
                    options.push(rest());
                }
                this.grammar.add(&format!("{family}-{tag}{prefix}"), alt(options));
            }
        };
        let rows = self.seen.rows.clone();
        let results = self.seen.results.clone();
        trie(self, '#', &rows);
        trie(self, '@', &results);

        for k in 0..CHAIN.len() {
            let mut options = vec![stop()];
            if k == 0 {
                options.push(seq(vec![any_but(&plain_extra), rf(&state(0))]));
            } else {
                options.push(seq(vec![
                    any_but(&format!("{plain_extra}{}", CHAIN[k])),
                    rf(&state(0)),
                ]));
                options.push(seq(vec![lit("d"), rf(&state(1))]));
            }
            options.push(seq(vec![lit("#"), rf(&format!("{family}-h"))]));
            options.push(seq(vec![lit("@"), rf(&format!("{family}-a"))]));
            if k + 1 < CHAIN.len() {
                options.push(seq(vec![lit(&CHAIN[k].to_string()), rf(&state(k + 1))]));
            } else if self.seen.dates > 0 {
                // `dates[` was written: only an index that is an entry, and the bracket
                let indices = (0..self.seen.dates)
                    .map(|index| lit(&index.to_string()))
                    .collect();
                options.push(seq(vec![
                    lit("["),
                    alt(indices),
                    lit("]"),
                    rf(&state(0)),
                ]));
            }
            // at `d` itself the chain character is `d`, which the restart above already is
            if k == 0 {
                options.push(seq(vec![lit("d"), rf(&state(1))]));
            }
            self.grammar.add(&state(k), alt(options));
        }
    }

    // --- handles ---------------------------------------------------------------------------

    /// `#n` or `@k` for a handle that is shown, with nothing after it; the caller writes what follows (a comma, a newline,
    /// a space). `sigils` picks the kinds.
    fn handle(&mut self, name: &str, rows: bool, results: bool) {
        let mut options = Vec::new();
        for (sigil, on, numbers) in [
            ('#', rows, &self.seen.rows),
            ('@', results, &self.seen.results),
        ] {
            if on {
                for number in numbers {
                    options.push(lit(&format!("{sigil}{number}")));
                }
            }
        }
        if options.is_empty() {
            // nothing to name: the slot cannot be written
            options.push(lit("\u{0}"));
        }
        self.grammar.add(name, alt(options));
    }

    /// `h` or `h, h, …`, as a right recursion.
    fn list(&mut self, name: &str, handle: &str) {
        self.grammar.add(
            name,
            seq(vec![rf(handle), opt(seq(vec![lit(", "), rf(name)]))]),
        );
    }
}

fn line(label: &str, body: Rule) -> Rule {
    seq(vec![lit(&format!("{label}: ")), body, lit("\n")])
}

fn words(list: &[&str]) -> Rule {
    alt(list.iter().map(|word| lit(word)).collect())
}

/// The `Visible` handles as a grammar rule set for `mode`, or `None` for [`GrammarMode::Off`].
///
/// `prefix` is the think's given prefix (the lines the prompt already holds, `retry: where\n`): a prefix of more than a
/// `retry` line is outside what the grammar can place, and gets the handle rule alone.
#[must_use]
pub fn grammar_for(mode: GrammarMode, seen: &Visible, prefix: &str) -> Option<Grammar> {
    match mode {
        GrammarMode::Off => None,
        GrammarMode::Handles => Some(handles(seen)),
        GrammarMode::Full => {
            let extra = prefix.lines().any(|line| !line.starts_with("retry: "));
            Some(if extra { handles(seen) } else { full(seen, !prefix.is_empty()) })
        }
    }
}

fn handles(seen: &Visible) -> Grammar {
    let mut builder = Builder::new(seen);
    builder.grammar.add("root", rf("any-s0"));
    builder.free("any", "");
    builder.grammar
}

/// Whether S2's `via` words are admitted: a test of the legacy vocabulary.
fn full(seen: &Visible, retried: bool) -> Grammar {
    full_with(seen, retried, &["find", "compute"])
}

/// [`GrammarMode::Full`] with the `via` words given: S2's thinks say `search` and `open` too.
#[must_use]
pub fn full_with(seen: &Visible, retried: bool, via_words: &[&str]) -> Grammar {
    full_ending(seen, retried, via_words, "")
}

/// [`full_with`] where the think ends with the literal `end` (`</think>`), or with nothing when it is empty.
#[must_use]
pub fn full_ending(seen: &Visible, retried: bool, via_words: &[&str], end: &str) -> Grammar {
    let mut b = Builder::new(seen);
    b.grammar.add("root", rf("think"));
    b.free("ln", "\n");
    b.free("sg", "\n·");
    b.handle("hrow", true, false);
    b.handle("hres", false, true);
    b.handle("hany", true, true);
    b.list("lrows", "hany");
    b.list("lres", "hres");
    b.list("lhash", "hrow");

    // quoted phrase of a slot value: no quote, no newline
    b.grammar.add("phrase", seq(vec![lit("\""), any_but("\"\n"), opt(rf("phrase-rest")), lit("\"")]));
    b.grammar.add("phrase-rest", seq(vec![any_but("\"\n"), opt(rf("phrase-rest"))]));
    // the text of a line, free
    let text_line = |label: &str| line(label, rf("ln-s0"));
    b.grammar.add("l-name", text_line("name"));
    b.grammar.add("l-text", text_line("text"));
    b.grammar.add("l-options", line("options", rf("lany")));
    b.list("lany", "hany");
    b.grammar.add("l-question", text_line("question"));
    b.grammar.add("l-reason", text_line("reason"));
    b.grammar.add("l-value", line("value", rf("hany")));
    b.grammar.add("l-limit", line("limit", seq(vec![one_of("123456789"), opt(rf("digits"))])));
    b.grammar.add("digits", seq(vec![one_of("0123456789"), opt(rf("digits"))]));
    b.grammar.add("l-more", line("more", lit("true")));
    b.grammar.add("l-trashed", line("trashed", lit("true")));
    b.grammar.add("l-retry", line("retry", lit("rejected")));
    b.grammar.add("l-linked", line("linked_to", rf("lhash")));
    b.grammar.add("l-within", line("within", rf("lres")));
    b.grammar.add("l-exclude", line("exclude", rf("lrows")));
    b.grammar.add("l-rows", line("rows", rf("lrows")));
    b.grammar.add("l-row", line("row", rf("hany")));
    b.grammar.add(
        "l-pick",
        line(
            "pick",
            seq(vec![rf("hrow"), lit(" ("), words(&PICK_REASONS), lit(")")]),
        ),
    );
    b.grammar.add(
        "l-time",
        line("time", seq(vec![rf("hhmm"), opt(rf("hhmm-rest"))])),
    );
    b.grammar.add(
        "hhmm",
        seq(vec![one_of("012"), one_of("0123456789"), lit(":"), one_of("012345"), one_of("0123456789")]),
    );
    b.grammar.add("hhmm-rest", seq(vec![lit(" · "), rf("hhmm"), opt(rf("hhmm-rest"))]));
    b.grammar.add(
        "l-when",
        line(
            "when",
            seq(vec![
                alt(vec![
                    rf("phrase"),
                    lit("now"),
                    seq(vec![lit("earlier"), opt(seq(vec![lit(" "), rf("phrase")]))]),
                ]),
                opt(seq(vec![lit(" = "), rf("ln-s0")])),
            ]),
        ),
    );
    b.grammar.add(
        "l-intent",
        line(
            "intent",
            seq(vec![
                words(&["read", "count", "write", "ask", "decline"]),
                opt(seq(vec![lit(" "), rf("phrase")])),
            ]),
        ),
    );
    b.grammar.add("l-via", line("via", words(via_words)));
    b.grammar.add("l-op", line("op", words(meta::OPS)));
    let periods = ["day", "week", "month", "year"];

    // --- stage 3: the fields of one kind -------------------------------------------------------
    for spec in meta::KINDS {
        let tag = kind_tag(spec.kind);
        // `name` is every kind's, and not among its fields (it lives in the entity row)
        let mut fields: Vec<&str> = vec!["name"];
        fields.extend(spec.fields.iter().map(|field| field.name));
        let mut wheres: Vec<&str> = fields.clone();
        wheres.push("date");
        let links: Vec<&str> = spec.links.iter().map(|link| link.kind.name()).collect();
        let mut sets: Vec<&str> = meta::create_args(spec.kind);
        for action in meta::edit_actions(spec.kind) {
            sets.extend(action.chat_names());
        }
        sets.extend(fields.iter().copied());
        sets.extend(["kind", "to", "from", "label", "choice", "row", "field"]);
        sets.extend(spec.links.iter().flat_map(|link| [link.label, link.kind.name()]));
        sets.sort_unstable();
        sets.dedup();
        let mut order_fields = fields.clone();
        order_fields.push("date");
        let mut group = fields.clone();
        group.extend(periods);
        group.sort_unstable();
        group.dedup();
        wheres.extend(links.iter().copied());
        wheres.sort_unstable();
        wheres.dedup();
        b.grammar.add(
            &format!("cond-{tag}"),
            seq(vec![words(&wheres), lit(" "), rf("sg-s0")]),
        );
        b.grammar.add(
            &format!("l-where-{tag}"),
            line(
                "where",
                seq(vec![
                    rf(&format!("cond-{tag}")),
                    opt(rf(&format!("conds-{tag}"))),
                ]),
            ),
        );
        b.grammar.add(
            &format!("conds-{tag}"),
            seq(vec![
                lit(" · "),
                rf(&format!("cond-{tag}")),
                opt(rf(&format!("conds-{tag}"))),
            ]),
        );
        b.grammar.add(&format!("l-field-{tag}"), line("field", words(&fields)));
        b.grammar.add(&format!("l-group-{tag}"), line("group", words(&group)));
        b.grammar.add(
            &format!("l-order-{tag}"),
            line("order", seq(vec![words(&order_fields), alt(vec![lit(" asc"), lit(" desc")])])),
        );
        b.grammar.add(
            &format!("entry-{tag}"),
            seq(vec![
                words(&sets),
                lit(" = "),
                opt(lit("~")),
                rf("sg-s0"),
            ]),
        );
        b.grammar.add(
            &format!("l-set-{tag}"),
            line(
                "set",
                seq(vec![rf(&format!("entry-{tag}")), opt(rf(&format!("entries-{tag}")))]),
            ),
        );
        b.grammar.add(
            &format!("entries-{tag}"),
            seq(vec![
                lit(" · "),
                rf(&format!("entry-{tag}")),
                opt(rf(&format!("entries-{tag}"))),
            ]),
        );
        // the tail after the kind line
        b.grammar.add(
            &format!("tail-{tag}"),
            tail(&tag),
        );
        b.grammar.add(
            &format!("kind-{tag}"),
            seq(vec![
                line("kind", lit(spec.name)),
                rf(&format!("tail-{tag}")),
            ]),
        );
    }
    // a kind line of a comma list, or a kind the tail does not know: the shared tail, over any field
    b.grammar.add("tail-any", tail_any());
    b.grammar.add("l-where-any", line("where", rf("ln-s0")));
    b.grammar.add("l-set-any", line("set", rf("ln-s0")));
    b.grammar.add("l-field-any", line("field", rf("ln-s0")));
    b.grammar.add("l-group-any", line("group", rf("ln-s0")));
    b.grammar.add("l-order-any", line("order", rf("ln-s0")));
    let kind_names: Vec<&str> = meta::KINDS.iter().map(|spec| spec.name).collect();
    b.grammar.add(
        "kind-multi",
        seq(vec![
            lit("kind: "),
            words(&kind_names),
            rf("kind-more"),
            lit("\n"),
            rf("tail-any"),
        ]),
    );
    b.grammar.add(
        "kind-more",
        seq(vec![lit(","), opt(lit(" ")), words(&kind_names), opt(rf("kind-more"))]),
    );

    b.grammar.add(
        "closing",
        seq(vec![
            opt(rf("l-value")),
            opt(rf("l-options")),
            opt(rf("l-question")),
            opt(rf("l-reason")),
            lit(end),
        ]),
    );

    // --- stage 1 and 2: the tool, then the rows --------------------------------------------------
    let handles_opt = seq(vec![opt(rf("l-pick")), opt(rf("l-rows")), opt(rf("l-row"))]);
    b.grammar.add("handles", handles_opt);
    // the verbs: each followed by the kinds it applies to
    let mut verb_alts = Vec::new();
    for spec in meta::VERBS {
        let kinds = spec.verb.kinds();
        let mut after = vec![rf("tail-any")];
        for kind in kinds {
            after.push(rf(&format!("kind-{}", kind_tag(kind))));
        }
        verb_alts.push(seq(vec![
            line("verb", lit(spec.name)),
            rf("handles"),
            alt(after),
        ]));
    }
        b.grammar.add("write-verb", alt(verb_alts));
    // a step with no verb: a read, a count, a lookup, an ask, a decline
    let mut kinds_alts = vec![rf("tail-any"), rf("kind-multi")];
    for spec in meta::KINDS {
        kinds_alts.push(rf(&format!("kind-{}", kind_tag(spec.kind))));
    }
    b.grammar.add(
        "no-verb",
        seq(vec![rf("handles"), alt(kinds_alts)]),
    );
    b.grammar.add(
        "think",
        seq(vec![
            if retried { lit("") } else { opt(rf("l-retry")) },
            rf("l-intent"),
            opt(rf("l-via")),
            alt(vec![rf("write-verb"), rf("no-verb")]),
        ]),
    );
    b.grammar
}

fn kind_tag(kind: Kind) -> String {
    kind.name().replace(' ', "-")
}

/// The slots that follow `kind`, in order, for the kind `tag`.
fn tail(tag: &str) -> Rule {
    seq(vec![
        opt(rf("l-op")),
        opt(rf(&format!("l-field-{tag}"))),
        opt(rf(&format!("l-group-{tag}"))),
        opt(rf("l-trashed")),
        opt(rf("l-name")),
        opt(rf("l-text")),
        opt(rf(&format!("l-where-{tag}"))),
        opt(rf("l-when")),
        opt(rf("l-linked")),
        opt(rf("l-within")),
        opt(rf("l-exclude")),
        opt(rf(&format!("l-order-{tag}"))),
        opt(rf("l-limit")),
        opt(rf("l-more")),
        opt(rf(&format!("l-set-{tag}"))),
        opt(rf("l-time")),
        rf("closing"),
    ])
}

fn tail_any() -> Rule {
    seq(vec![
        opt(rf("l-op")),
        opt(rf("l-field-any")),
        opt(rf("l-group-any")),
        opt(rf("l-trashed")),
        opt(rf("l-name")),
        opt(rf("l-text")),
        opt(rf("l-where-any")),
        opt(rf("l-when")),
        opt(rf("l-linked")),
        opt(rf("l-within")),
        opt(rf("l-exclude")),
        opt(rf("l-order-any")),
        opt(rf("l-limit")),
        opt(rf("l-more")),
        opt(rf("l-set-any")),
        opt(rf("l-time")),
        rf("closing"),
    ])
}

// ---------------------------------------------------------------------------------------------
// the step's use of it
// ---------------------------------------------------------------------------------------------

/// The grammar of one step as GBNF, with the mode it is in effect: `Full` is the grammar of the regrouped tools, so a
/// model whose tools are S2's (`search`, `open`, a create's kind in `set`) gets `Handles`. `None` for `Off`.
#[must_use]
pub fn grammar_for_step(
    mode: GrammarMode,
    tools: ToolsMode,
    seen: &Visible,
    prefix: &str,
) -> Option<(GrammarMode, String)> {
    let mode = match (mode, tools) {
        (GrammarMode::Full, ToolsMode::S2) => GrammarMode::Handles,
        (other, _) => other,
    };
    let end = MODEL.think_close;
    let grammar = match mode {
        GrammarMode::Off => return None,
        GrammarMode::Handles => handles(seen),
        GrammarMode::Full => {
            let extra = prefix.lines().any(|line| !line.starts_with("retry: "));
            if extra {
                handles(seen)
            } else {
                full_ending(seen, !prefix.is_empty(), &["find", "compute"], end)
            }
        }
    };
    Some((mode, grammar.to_gbnf()))
}

/// The user's message of the last user turn that is no observation: the text after the runtime's block.
#[must_use]
pub fn user_message(prompt: &str) -> Option<&str> {
    let start = MODEL.im_start;
    let header = format!("{start}user\n");
    let mut at = prompt.len();
    while let Some(found) = prompt[..at].rfind(&header) {
        let body = &prompt[found + header.len()..];
        let body = body.split(MODEL.im_end).next().unwrap_or(body);
        if !body.starts_with("<tool_response>") {
            let block = ["vault:", "focus:", "answer:", "dates:"];
            if block.iter().any(|label| body.starts_with(label)) {
                return body.split_once("\n\n").map(|(_, message)| message);
            }
            return Some(body);
        }
        at = found;
    }
    None
}

/// The words of `text`, lower case, joined by a space, with a space at each end: `" what s on "`.
fn bare(text: &str) -> String {
    let mut out = String::from(" ");
    for word in text
        .split(|letter: char| !letter.is_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        out.push_str(&word.to_lowercase());
        out.push(' ');
    }
    out
}

/// The spans a think copies from the message that are not in it, as `slot: value`: the deciding phrase of `intent`, the
/// quote of `when`, `name` and `text`, a `set` value of a text field, and the literals of a `where`. A span is in the
/// message when its words are, in order, as whole words, in any case and whatever the punctuation.
#[must_use]
pub fn unspanned(think: &str, message: &str) -> Vec<String> {
    let said = bare(message);
    let mut missing = Vec::new();
    let mut check = |slot: &str, span: &str| {
        let words = bare(span);
        if words.trim().is_empty() || said.contains(&words) {
            return;
        }
        missing.push(format!("{slot}: {span}"));
    };
    for line in think.lines() {
        let Some((label, rest)) = line.split_once(": ") else {
            continue;
        };
        match label {
            "intent" => {
                if let Some(phrase) = quoted_phrase(rest) {
                    check("intent", phrase);
                }
            }
            "when" => {
                if let Some(phrase) = quoted_phrase(rest) {
                    check("when", phrase);
                }
            }
            "name" | "text" => check(label, rest),
            "set" => {
                for entry in rest.split(" · ") {
                    let Some((key, value)) = entry.split_once(" = ") else {
                        continue;
                    };
                    let text_field = key == "name"
                        || meta::KINDS.iter().any(|spec| {
                            spec.field(key)
                                .is_some_and(|field| field.ty == meta::FieldType::Text)
                        });
                    if text_field && !value.starts_with(['~', '#', '@']) {
                        check(&format!("set {key}"), value);
                    }
                }
            }
            "where" => {
                for cond in rest.split(" · ") {
                    let mut tail = cond;
                    while let Some(at) = tail.find('"') {
                        let inner = &tail[at + 1..];
                        let Some(close) = inner.find('"') else { break };
                        check("where", &inner[..close]);
                        tail = &inner[close + 1..];
                    }
                }
            }
            _ => {}
        }
    }
    missing
}

/// The text between the first pair of quotes of a slot value.
fn quoted_phrase(rest: &str) -> Option<&str> {
    let inner = rest.split_once('"')?.1;
    inner.split_once('"').map(|(phrase, _)| phrase)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::meta::Verb;

    fn golden() -> Vec<String> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../experiments/toolchat/native/authored/golden_v3.json"
        );
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(path).expect("the golden file"))
                .expect("json");
        rows.iter()
            .filter_map(|row| row["think4"].as_str().map(str::to_owned))
            .collect()
    }

    /// The handles a think names are shown: what a prompt that led to it would show.
    fn showing(think: &str) -> Visible {
        let mut seen = Visible::of(think, None);
        let mut index = 0;
        while let Some(at) = think[index..].find("dates[") {
            let digits: String = think[index + at + 6..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(number) = digits.parse::<usize>() {
                seen.dates = seen.dates.max(number + 1);
            }
            index += at + 6;
        }
        seen
    }

    /// The golden holds thinks of kinds and verbs the catalog has since dropped (Tally's `debt`, `group`, `settle_debt`).
    fn in_the_catalog(think: &str) -> bool {
        think.lines().all(|line| {
            if let Some(verb) = line.strip_prefix("verb: ") {
                Verb::parse(verb).is_some()
            } else if let Some(kind) = line.strip_prefix("kind: ") {
                kind.split(", ").all(|kind| Kind::parse(kind).is_some())
            } else {
                true
            }
        })
    }

    /// A golden think written for the vault before its rebuild: a verb its kind no longer has, a field the kind no longer
    /// has (`effort` on an event, `pinned` on a photo), an op the tools no longer take (`balance`).
    fn stale(think: &str) -> bool {
        let kind = think
            .lines()
            .find_map(|line| line.strip_prefix("kind: "))
            .and_then(Kind::parse);
        let verb = think
            .lines()
            .find_map(|line| line.strip_prefix("verb: "))
            .and_then(Verb::parse);
        if let (Some(kind), Some(verb)) = (kind, verb)
            && !verb.kinds().contains(&kind)
        {
            return true;
        }
        if think
            .lines()
            .find_map(|line| line.strip_prefix("op: "))
            .is_some_and(|op| !meta::OPS.contains(&op))
        {
            return true;
        }
        let Some(kind) = kind else {
            return false;
        };
        let spec = kind.spec();
        think
            .lines()
            .filter_map(|line| line.strip_prefix("where: ").or_else(|| line.strip_prefix("set: ")))
            .flat_map(|line| line.split(" · "))
            .filter_map(|part| part.split_whitespace().next())
            .any(|field| {
                field != "name"
                    && field != "date"
                    && spec.field(field).is_none()
                    && !["to", "from", "list", "kind"].contains(&field)
                    && !spec.links.iter().any(|link| link.kind.name() == field || link.label == field)
            })
    }

    fn think(text: &str) -> String {
        format!("{text}\n")
    }

    fn full(seen: &Visible) -> Grammar {
        full_ending(seen, false, &["find", "search", "open", "compute"], "")
    }

    #[test]
    fn every_golden_think_is_inside_the_handles_grammar() {
        for text in golden() {
            let grammar = handles(&showing(&text));
            assert!(grammar.accepts(&think(&text)), "{text}");
        }
    }

    #[test]
    fn every_golden_think_is_inside_the_full_grammar() {
        let mut refused = Vec::new();
        for text in golden().into_iter().filter(|text| in_the_catalog(text)) {
            let grammar = full(&showing(&text));
            if !grammar.accepts(&think(&text)) {
                refused.push(text);
            }
        }
        refused.retain(|text| !stale(text));
        assert!(refused.is_empty(), "{} refused: {:#?}", refused.len(), &refused[..refused.len().min(40)]);
    }

    #[test]
    fn a_handle_the_prompt_does_not_show_is_refused() {
        let seen = Visible::of("directory: Home (#6)\nobservation: @1 = 4", None);
        let ok = think("intent: write \"star it\"\nverb: star\npick: #6 (name)");
        assert!(full(&seen).accepts(&ok));
        let unseen = think("intent: write \"star it\"\nverb: star\npick: #7 (name)");
        assert!(!full(&seen).accepts(&unseen));
        let result = think("intent: write \"star it\"\nverb: star\nrows: @2");
        assert!(!full(&seen).accepts(&result));
        let shown = think("intent: write \"star it\"\nverb: star\nrows: @1");
        assert!(full(&seen).accepts(&shown));
        // a number that merely starts with a shown one
        let long = think("intent: write \"star it\"\nverb: star\nrows: #61");
        assert!(!full(&seen).accepts(&long));
    }

    #[test]
    fn a_date_entry_the_dates_line_lacks_is_refused() {
        let seen = Visible::of(
            "x",
            Some("dates: friday = 2026-03-20 · next week = 2026-03-16..2026-03-22"),
        );
        assert_eq!(seen.dates, 2);
        let base = "intent: read \"what is on\"\nkind: event\nwhen: \"friday\" = dates[";
        assert!(full(&seen).accepts(&think(&format!("{base}1]"))));
        assert!(!full(&seen).accepts(&think(&format!("{base}2]"))));
        assert!(!handles(&seen).accepts(&think(&format!("{base}2]"))));
        assert!(handles(&seen).accepts(&think(&format!("{base}0]"))));
        // no dates line: no `dates[`
        let none = Visible::of("x", None);
        assert!(!handles(&none).accepts(&think(&format!("{base}0]"))));
        // text that only looks like it
        assert!(handles(&none).accepts("dates are fine, so is dates and date[0] and ddates\n"));
    }

    #[test]
    fn after_the_kind_only_that_kinds_fields_are_decoded() {
        let seen = Visible::default();
        let ok = think("intent: read \"open tasks\"\nkind: task\nwhere: status = open · effort > 60\norder: date asc\nlimit: 3");
        assert!(full(&seen).accepts(&ok), "task fields");
        let wrong = think("intent: read \"open tasks\"\nkind: task\nwhere: amount > 60");
        assert!(!full(&seen).accepts(&wrong), "amount is a transaction's field");
        let wrong_order = think("intent: read \"open tasks\"\nkind: task\norder: amount desc");
        assert!(!full(&seen).accepts(&wrong_order));
        let money = think("intent: read \"big ones\"\nkind: transaction\nwhere: amount > 60");
        assert!(full(&seen).accepts(&money));
        let wrong_set = think("intent: write \"add\"\nverb: create\nkind: task\nset: amount = 5");
        assert!(!full(&seen).accepts(&wrong_set));
    }

    #[test]
    fn a_verb_is_followed_only_by_a_kind_it_applies_to() {
        let seen = Visible::of("(#4)", None);
        let ok = think("intent: write \"complete it\"\nverb: complete\nkind: task\nname: pay rent");
        assert!(full(&seen).accepts(&ok));
        let wrong = think("intent: write \"complete it\"\nverb: complete\nkind: person\nname: pay rent");
        assert!(!full(&seen).accepts(&wrong));
        let unknown = think("intent: write \"x\"\nverb: teleport\npick: #4 (name)");
        assert!(!full(&seen).accepts(&unknown));
        // the lines are in order, once each
        let swapped = think("intent: write \"x\"\nkind: task\nverb: complete");
        assert!(!full(&seen).accepts(&swapped));
        let twice = think("intent: read \"x\"\nintent: read \"x\"");
        assert!(!full(&seen).accepts(&twice));
    }

    #[test]
    fn free_text_cannot_name_a_handle_that_is_not_shown() {
        let seen = Visible::of("(#5)", None);
        let name = |text: &str| think(&format!("intent: write \"add\"\nverb: create\nkind: task\nname: {text}"));
        assert!(full(&seen).accepts(&name("Room #5 clean")));
        assert!(!full(&seen).accepts(&name("Room #9 clean")));
        assert!(full(&seen).accepts(&name("Room # clean and a@b.com")));
        assert!(full(&seen).accepts(&name("ends in #5")));
    }

    #[test]
    fn the_gbnf_names_are_legal_and_the_root_is_first() {
        let seen = Visible::of("(#1) (#12) @3", Some("dates: a = b"));
        let grammar = full(&seen);
        let text = grammar.to_gbnf();
        assert!(text.starts_with("root ::= think\n"), "{}", &text[..40]);
        for line in text.lines() {
            let (name, _) = line.split_once(" ::= ").expect("a rule per line");
            assert!(
                name.chars().all(|letter| letter.is_ascii_alphanumeric() || letter == '-'),
                "{name}"
            );
        }
        // a reference to a rule that is not there would be refused by the engine
        let defined: BTreeSet<&str> = text.lines().filter_map(|l| l.split_once(" ::= ").map(|p| p.0)).collect();
        for (_, rule) in &grammar.rules {
            check_refs(rule, &defined);
        }
    }

    fn check_refs(rule: &Rule, defined: &BTreeSet<&str>) {
        match rule {
            Rule::Ref(name) => assert!(defined.contains(name.as_str()), "undefined rule {name}"),
            Rule::Seq(parts) | Rule::Alt(parts) => parts.iter().for_each(|part| check_refs(part, defined)),
            Rule::Opt(inner) => check_refs(inner, defined),
            Rule::Lit(_) | Rule::Class(_) => {}
        }
    }
}
