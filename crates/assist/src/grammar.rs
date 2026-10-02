//! THE GRAMMAR: the registry, written so an engine can only say what runs.
//!
//! Grammar-constrained decoding is what makes a 0.8B model usable as a router.
//! The model cannot name a tool that is not offered, cannot spell an argument a
//! tool does not take, and cannot choose a word outside a closed set — so a
//! wrong answer is a wrong *choice*, never an unrunnable string.
//!
//! The grammar is generated from the [`ToolSet`] a prompt was built from, so a
//! tool the token budget dropped is unsayable as well as unlisted.
//!
//! # THE SHAPE IS COMPACT AND FIXED
//!
//! No optional whitespace, arguments in the spec's order, optional arguments
//! omitted rather than null. One spelling per call keeps tokens down and gives
//! the fine-tune a single target — the spelling [`crate::call::ToolCall::to_json`]
//! produces, which `tests::every_canonical_call_is_accepted` holds equal.
//!
//! # RULE NAMES
//!
//! GBNF names are lowercase letters, digits and dashes, so `tasks.list` is the
//! rule `tasks-list`.

use std::fmt::Write as _;

use crate::call::ANSWER_MAX;
use crate::tool::{ArgKind, ArgSpec, TEXT_MAX, ToolSet, ToolSpec};

/// The grammar for the phrasing step: one line of plain text.
///
/// `<` is excluded so the model cannot open a special token, and so a stray
/// `<tool_response>` cannot be echoed back into a card line.
pub const PHRASE_GBNF: &str = "root ::= phrase-first phrase-rest{0,199}\nphrase-first ::= [^<{\\\"\\[ \\t\\n\\r]\nphrase-rest ::= [^<\\n\\r]\n";

/// The longest phrased line, in characters; the grammar states the same cap.
pub const PHRASE_MAX: usize = 200;

/// The routing grammar for `tools`.
#[must_use]
pub fn route_gbnf(tools: &ToolSet) -> String {
    let mut out = String::new();
    out.push_str("root ::= call | none | answer\n");
    out.push_str("none ::= \"{\\\"tool\\\":\\\"none\\\"}\"\n");
    let _ = writeln!(
        out,
        "answer ::= \"{{\\\"answer\\\":\\\"\" answer-char{{1,{ANSWER_MAX}}} \"\\\"}}\""
    );
    out.push_str("answer-char ::= [^\"\\\\\\n\\r]\n");
    let _ = writeln!(out, "text ::= \"\\\"\" text-char{{1,{TEXT_MAX}}} \"\\\"\"");
    out.push_str("text-char ::= [^\"\\\\\\n\\r]\n");
    let calls: Vec<String> = tools.iter().map(|spec| rule_name(spec.name)).collect();
    let _ = writeln!(out, "call ::= {}", calls.join(" | "));
    for spec in tools.iter() {
        write_tool(&mut out, spec);
    }
    out
}

fn rule_name(tool: &str) -> String {
    tool.replace('.', "-")
}

/// A GBNF string literal for `text`.
fn literal(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn write_tool(out: &mut String, spec: &ToolSpec) {
    let name = rule_name(spec.name);
    let head = format!("{{\"tool\":\"{}\",\"args\":{{", spec.name);
    if spec.args.is_empty() {
        let _ = writeln!(out, "{name} ::= {}", literal(&format!("{head}}}}}")));
        return;
    }
    let _ = writeln!(
        out,
        "{name} ::= {} {name}-args {}",
        literal(&head),
        literal("}}")
    );
    let required: Vec<&ArgSpec> = spec.args.iter().filter(|arg| arg.required).collect();
    let optional: Vec<&ArgSpec> = spec.args.iter().filter(|arg| !arg.required).collect();
    let member = |arg: &ArgSpec| {
        format!(
            "{} {}",
            literal(&format!("\"{}\":", arg.name)),
            value_rule(spec, arg)
        )
    };
    let mut body = required
        .iter()
        .map(|arg| member(arg))
        .collect::<Vec<_>>()
        .join(&format!(" {} ", literal(",")));
    if required.is_empty() {
        // The first optional member carries no comma, so "which one comes first"
        // is an alternation; every later member is an independent `( "," m )?`.
        let alternatives: Vec<String> = (0..optional.len())
            .map(|first| {
                let mut parts = vec![member(optional[first])];
                parts.extend(
                    optional[first + 1..]
                        .iter()
                        .map(|arg| format!("( {} {} )?", literal(","), member(arg))),
                );
                parts.join(" ")
            })
            .collect();
        body = format!("( {} )?", alternatives.join(" | "));
    } else {
        for arg in &optional {
            let _ = write!(body, " ( {} {} )?", literal(","), member(arg));
        }
    }
    let _ = writeln!(out, "{name}-args ::= {body}");
    for arg in spec.args {
        if let ArgKind::Choice(words) = arg.kind {
            let alternatives: Vec<String> = words
                .iter()
                .map(|word| literal(&format!("\"{word}\"")))
                .collect();
            let _ = writeln!(out, "{name}-{} ::= {}", arg.name, alternatives.join(" | "));
        }
    }
}

fn value_rule(spec: &ToolSpec, arg: &ArgSpec) -> String {
    match arg.kind {
        ArgKind::Text => "text".to_owned(),
        ArgKind::Choice(_) => format!("{}-{}", rule_name(spec.name), arg.name),
    }
}

#[cfg(test)]
pub(crate) mod check {
    //! A small GBNF matcher for the subset this module emits — literals,
    //! classes, rule references, groups, alternation, `?` and `{m,n}` — so the
    //! grammar's meaning is tested here and not discovered the first time an
    //! engine rejects its syntax.

    use std::collections::{BTreeMap, BTreeSet};

    #[derive(Debug, Clone)]
    enum Node {
        Literal(Vec<char>),
        Class {
            negated: bool,
            items: Vec<(char, char)>,
        },
        Rule(String),
        Alt(Vec<Node>),
        Seq(Vec<Node>),
        Repeat(Box<Node>, usize, usize),
    }

    pub struct Grammar {
        rules: BTreeMap<String, Node>,
    }

    struct Parser<'a> {
        chars: Vec<char>,
        at: usize,
        _source: &'a str,
    }

    impl Parser<'_> {
        fn peek(&self) -> Option<char> {
            self.chars.get(self.at).copied()
        }

        fn skip_space(&mut self) {
            while self.peek() == Some(' ') {
                self.at += 1;
            }
        }

        fn alt(&mut self) -> Node {
            let mut options = vec![self.seq()];
            loop {
                self.skip_space();
                if self.peek() == Some('|') {
                    self.at += 1;
                    options.push(self.seq());
                } else {
                    break;
                }
            }
            if options.len() == 1 {
                options.remove(0)
            } else {
                Node::Alt(options)
            }
        }

        fn seq(&mut self) -> Node {
            let mut items = Vec::new();
            loop {
                self.skip_space();
                match self.peek() {
                    None | Some('|' | ')') => break,
                    _ => items.push(self.postfix()),
                }
            }
            Node::Seq(items)
        }

        fn postfix(&mut self) -> Node {
            let atom = self.atom();
            match self.peek() {
                Some('?') => {
                    self.at += 1;
                    Node::Repeat(Box::new(atom), 0, 1)
                }
                Some('{') => {
                    self.at += 1;
                    let mut text = String::new();
                    while self.peek() != Some('}') {
                        text.push(self.peek().expect("a closing brace"));
                        self.at += 1;
                    }
                    self.at += 1;
                    let (low, high) = text.split_once(',').map_or_else(
                        || {
                            let n = text.parse().expect("a count");
                            (n, n)
                        },
                        |(low, high)| (low.parse().expect("a low"), high.parse().expect("a high")),
                    );
                    Node::Repeat(Box::new(atom), low, high)
                }
                _ => atom,
            }
        }

        fn atom(&mut self) -> Node {
            match self.peek().expect("an atom") {
                '"' => {
                    self.at += 1;
                    let mut text = Vec::new();
                    while self.peek() != Some('"') {
                        let character = self.peek().expect("a closing quote");
                        self.at += 1;
                        text.push(if character == '\\' {
                            self.escape()
                        } else {
                            character
                        });
                    }
                    self.at += 1;
                    Node::Literal(text)
                }
                '[' => {
                    self.at += 1;
                    let negated = self.peek() == Some('^');
                    if negated {
                        self.at += 1;
                    }
                    let mut items = Vec::new();
                    while self.peek() != Some(']') {
                        let low = self.class_char();
                        if self.peek() == Some('-') && self.chars.get(self.at + 1) != Some(&']') {
                            self.at += 1;
                            items.push((low, self.class_char()));
                        } else {
                            items.push((low, low));
                        }
                    }
                    self.at += 1;
                    Node::Class { negated, items }
                }
                '(' => {
                    self.at += 1;
                    let inner = self.alt();
                    self.skip_space();
                    assert_eq!(self.peek(), Some(')'));
                    self.at += 1;
                    inner
                }
                _ => {
                    let mut name = String::new();
                    while self
                        .peek()
                        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
                    {
                        name.push(self.peek().unwrap());
                        self.at += 1;
                    }
                    assert!(!name.is_empty(), "unexpected {:?} in grammar", self.peek());
                    Node::Rule(name)
                }
            }
        }

        fn class_char(&mut self) -> char {
            let character = self.peek().expect("a class character");
            self.at += 1;
            if character == '\\' {
                self.escape()
            } else {
                character
            }
        }

        fn escape(&mut self) -> char {
            let character = self.peek().expect("an escape");
            self.at += 1;
            match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            }
        }
    }

    impl Grammar {
        pub fn parse(source: &str) -> Self {
            let mut rules = BTreeMap::new();
            for line in source.lines().filter(|line| !line.trim().is_empty()) {
                let (name, body) = line.split_once(" ::= ").expect("`name ::= body`");
                let mut parser = Parser {
                    chars: body.chars().collect(),
                    at: 0,
                    _source: source,
                };
                let node = parser.alt();
                assert_eq!(
                    parser.at,
                    parser.chars.len(),
                    "trailing text in rule {name}"
                );
                assert!(
                    rules.insert(name.trim().to_owned(), node).is_none(),
                    "rule {name} defined twice"
                );
            }
            Self { rules }
        }

        /// Whether `root` accepts exactly `text`.
        pub fn accepts(&self, text: &str) -> bool {
            let chars: Vec<char> = text.chars().collect();
            let start = BTreeSet::from([0usize]);
            self.run(&Node::Rule("root".to_owned()), &chars, &start)
                .contains(&chars.len())
        }

        /// Every rule name referenced is defined, and every rule is reachable.
        pub fn assert_closed(&self) {
            let mut referenced = BTreeSet::from(["root".to_owned()]);
            let mut stack: Vec<&Node> = self.rules.values().collect();
            while let Some(node) = stack.pop() {
                match node {
                    Node::Rule(name) => {
                        referenced.insert(name.clone());
                        assert!(self.rules.contains_key(name), "undefined rule {name}");
                    }
                    Node::Alt(items) | Node::Seq(items) => stack.extend(items),
                    Node::Repeat(inner, ..) => stack.push(inner),
                    Node::Literal(_) | Node::Class { .. } => {}
                }
            }
            for name in self.rules.keys() {
                assert!(referenced.contains(name), "unreachable rule {name}");
            }
        }

        fn run(&self, node: &Node, text: &[char], from: &BTreeSet<usize>) -> BTreeSet<usize> {
            match node {
                Node::Literal(expected) => from
                    .iter()
                    .filter(|&&at| text[at..].starts_with(expected))
                    .map(|&at| at + expected.len())
                    .collect(),
                Node::Class { negated, items } => from
                    .iter()
                    .filter(|&&at| {
                        text.get(at).is_some_and(|character| {
                            let hit = items
                                .iter()
                                .any(|(low, high)| (*low..=*high).contains(character));
                            hit != *negated
                        })
                    })
                    .map(|&at| at + 1)
                    .collect(),
                Node::Rule(name) => self.run(&self.rules[name], text, from),
                Node::Alt(options) => options
                    .iter()
                    .flat_map(|option| self.run(option, text, from))
                    .collect(),
                Node::Seq(items) => items
                    .iter()
                    .fold(from.clone(), |current, item| self.run(item, text, &current)),
                Node::Repeat(inner, low, high) => {
                    let mut current = from.clone();
                    let mut accepted = BTreeSet::new();
                    for count in 0..=*high {
                        if count >= *low {
                            accepted.extend(current.iter().copied());
                        }
                        if count == *high {
                            break;
                        }
                        current = self.run(inner, text, &current);
                        if current.is_empty() {
                            break;
                        }
                    }
                    accepted
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::check::Grammar;
    use super::*;
    use crate::call::ToolCall;
    use crate::tool::{App, TOOLS, tool};

    fn grammar(scope: Option<App>) -> Grammar {
        let parsed = Grammar::parse(&route_gbnf(&ToolSet::for_scope(scope)));
        parsed.assert_closed();
        parsed
    }

    /// One example call per tool, using the first choice and a short term.
    fn examples() -> Vec<ToolCall> {
        TOOLS
            .iter()
            .map(|spec| {
                let given: Vec<(&str, &str)> = spec
                    .args
                    .iter()
                    .map(|arg| {
                        (
                            arg.name,
                            match arg.kind {
                                ArgKind::Text => "Tahoe trip",
                                ArgKind::Choice(words) => words[words.len() - 1],
                            },
                        )
                    })
                    .collect();
                ToolCall::new(spec.name, given).unwrap()
            })
            .collect()
    }

    #[test]
    fn every_canonical_call_is_accepted() {
        let grammar = grammar(None);
        for call in examples() {
            assert!(grammar.accepts(&call.to_json()), "{}", call.to_json());
        }
    }

    #[test]
    fn optional_arguments_may_be_omitted_or_given_in_order() {
        let grammar = grammar(None);
        for json in [
            r#"{"tool":"tasks.list","args":{}}"#,
            r#"{"tool":"tasks.list","args":{"view":"today"}}"#,
            r#"{"tool":"tasks.list","args":{"project":"Tahoe trip"}}"#,
            r#"{"tool":"tasks.list","args":{"view":"overdue","project":"Tahoe trip"}}"#,
            r#"{"tool":"docs.list","args":{"type":"pdf"}}"#,
            r#"{"tool":"docs.list","args":{"shelf":"starred","type":"pdf"}}"#,
            r#"{"tool":"notes.list","args":{}}"#,
            r#"{"tool":"agenda.upcoming","args":{}}"#,
        ] {
            assert!(grammar.accepts(json), "{json}");
        }
    }

    #[test]
    fn a_tool_with_no_arguments_is_spelled_with_an_empty_object() {
        let grammar = grammar(None);
        assert!(grammar.accepts(r#"{"tool":"people.reconnect","args":{}}"#));
        assert!(!grammar.accepts(r#"{"tool":"people.reconnect"}"#));
        assert!(!grammar.accepts(r#"{"tool":"people.reconnect","args":{"term":"x"}}"#));
    }

    #[test]
    fn none_and_a_direct_answer_are_accepted() {
        let grammar = grammar(None);
        assert!(grammar.accepts(r#"{"tool":"none"}"#));
        assert!(grammar.accepts(r#"{"answer":"I read your tasks, notes and calendar."}"#));
        assert!(!grammar.accepts(r#"{"answer":""}"#));
    }

    #[test]
    fn what_the_registry_forbids_the_grammar_cannot_say() {
        let grammar = grammar(None);
        for json in [
            r#"{"tool":"locker.items","args":{}}"#,
            r#"{"tool":"tasks.delete","args":{}}"#,
            r#"{"tool":"tasks.list","args":{"view":"someday"}}"#,
            r#"{"tool":"tasks.list","args":{"limit":"5"}}"#,
            r#"{"tool":"tasks.list","args":{"project":"a","view":"today"}}"#,
            r#"{"tool":"tasks.search","args":{}}"#,
            r#"{"tool":"tasks.search","args":{"term":""}}"#,
            r#"{ "tool":"none" }"#,
            r#"{"tool":"none"} trailing"#,
            "{\"tool\":\"tasks.search\",\"args\":{\"term\":\"a\nb\"}}",
        ] {
            assert!(!grammar.accepts(json), "{json}");
        }
    }

    #[test]
    fn a_text_argument_is_capped_at_the_registrys_length() {
        let grammar = grammar(None);
        let ok = "x".repeat(TEXT_MAX);
        let long = "x".repeat(TEXT_MAX + 1);
        assert!(grammar.accepts(&format!(
            r#"{{"tool":"tasks.search","args":{{"term":"{ok}"}}}}"#
        )));
        assert!(!grammar.accepts(&format!(
            r#"{{"tool":"tasks.search","args":{{"term":"{long}"}}}}"#
        )));
    }

    #[test]
    fn a_tool_the_set_does_not_offer_is_unsayable() {
        let mut set = ToolSet::for_scope(Some(App::Tally));
        while set.drop_last(4) {}
        let grammar = Grammar::parse(&route_gbnf(&set));
        grammar.assert_closed();
        assert!(grammar.accepts(r#"{"tool":"tally.balances","args":{}}"#));
        assert!(!grammar.accepts(r#"{"tool":"tasks.projects","args":{}}"#));
    }

    #[test]
    fn the_grammar_is_the_same_for_every_scope_up_to_order() {
        let first = route_gbnf(&ToolSet::for_scope(None));
        let scoped = route_gbnf(&ToolSet::for_scope(Some(App::Photos)));
        // `call ::=` lists the tools in prompt order, so that one line differs.
        let rules = |text: &str| {
            let mut lines: Vec<String> = text
                .lines()
                .filter(|line| !line.starts_with("call ::="))
                .map(str::to_owned)
                .collect();
            lines.sort_unstable();
            lines
        };
        assert_eq!(rules(&first), rules(&scoped));
        assert_ne!(first, scoped);
    }

    #[test]
    fn the_phrase_grammar_is_one_bounded_line_that_cannot_open_like_a_route() {
        let grammar = Grammar::parse(PHRASE_GBNF);
        grammar.assert_closed();
        assert!(grammar.accepts("Three tasks are due today."));
        assert!(grammar.accepts("2 tasks are due today."));
        // The stock model re-emits the route it just made; the first character
        // is where that is stopped.
        for opening in [
            r#"{"tool":"tasks.list","args":{}}"#,
            r#"{"answer":"hi"}"#,
            r#""Three tasks.""#,
            "[1]",
            " leading space",
            "\tleading tab",
        ] {
            assert!(!grammar.accepts(opening), "{opening:?}");
        }
        assert!(
            grammar.accepts(r#"You asked for "three" things."#),
            "quotes inside are fine"
        );
        assert!(!grammar.accepts(""));
        assert!(!grammar.accepts("two\nlines"));
        assert!(!grammar.accepts("<|im_end|>"));
        assert!(!grammar.accepts(&"x".repeat(PHRASE_MAX + 1)));
        assert!(grammar.accepts(&"x".repeat(PHRASE_MAX)));
    }

    #[test]
    fn an_optional_only_tool_spells_every_subset_exactly_once() {
        // `tasks.list` has two optional members and no required one: the
        // alternation must not accept a leading comma.
        let grammar = grammar(None);
        assert!(!grammar.accepts(r#"{"tool":"tasks.list","args":{,"project":"a"}}"#));
        assert!(tool("tasks.list").is_some());
    }

    #[test]
    fn a_sample_is_printed_for_the_report() {
        let sample = route_gbnf(&ToolSet::for_scope(Some(App::Tasks)));
        assert!(sample.starts_with("root ::= call | none | answer\n"));
        assert!(sample.contains("tasks-list-args ::= ( \"\\\"view\\\":\" tasks-list-view"));
    }
}
