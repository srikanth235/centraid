//! Measuring the parser — no vault, no world, no model.
//!
//! The gold is `grammar/map.json`'s `canonical`; the verdict is computed by
//! `scorecheck.py`, which imports the grammar's own parser. Four outcomes
//! matter and they are NOT the same failure: `wrong` is a confident mistake,
//! `unparsed` is an honest abstention, `illegal` is output the grammar itself
//! refuses (the one that must always be zero), and `skeleton` is the shape
//! right with a literal the parser could not have known.

use super::rules::{ParseState, Parser};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Debug, Deserialize)]
pub struct MapTurn {
    pub corpus: String,
    pub session: String,
    pub turn: usize,
    pub category: String,
    pub expectation: String,
    pub request: String,
    pub canonical: String,
    pub context_move: String,
    pub covered: bool,
}

#[derive(Debug, Deserialize)]
struct MapFile {
    turns: Vec<MapTurn>,
}

#[derive(Debug, Deserialize)]
struct RegisterFile {
    variants: Vec<Variant>,
}

#[derive(Debug, Deserialize)]
struct Variant {
    session: String,
    turn: usize,
    register: String,
    request: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    pub id: String,
    pub corpus: String,
    pub category: String,
    pub register: String,
    pub context_move: String,
    pub request: String,
    pub gold: String,
    pub mine: Option<String>,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub why: String,
}

pub fn repo_grammar_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../evalsuite/grammar")
}

fn map_turns() -> Vec<MapTurn> {
    let path = repo_grammar_dir().join("map.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    let parsed: MapFile = serde_json::from_str(&text).expect("map.json is malformed");
    parsed.turns
}

/// Parse a whole corpus, threading session state the way a conversation runs.
pub fn parse_corpus(corpus: &str) -> Vec<Row> {
    let turns = map_turns();
    let parser = Parser::new();
    let mut rows = Vec::new();
    let mut state = ParseState::default();
    let mut current = String::new();
    for turn in turns.iter().filter(|t| t.corpus == corpus) {
        if turn.session != current {
            current = turn.session.clone();
            state = ParseState::default();
        }
        let (mine, why) = match parser.parse(&turn.request, &state) {
            Ok((parsed, _)) => {
                let text = parsed.to_string();
                state.record(parsed);
                (Some(text), String::new())
            }
            Err(unparsed) => (None, unparsed.reason),
        };
        rows.push(Row {
            id: format!("{}.{}", turn.session, turn.turn),
            corpus: turn.corpus.clone(),
            category: turn.category.clone(),
            register: "-".into(),
            context_move: turn.context_move.clone(),
            request: turn.request.clone(),
            gold: if turn.covered {
                turn.canonical.clone()
            } else {
                String::new()
            },
            mine,
            verdict: String::new(),
            why,
        });
    }
    rows
}

/// The registers: 349 paraphrases of the primary suite's requests. The gold is
/// the BASE turn's canonical, and the session state is the one the base turns
/// before it would have left — anything else would score the paraphrase on a
/// context no member ever had.
pub fn parse_registers() -> Vec<Row> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../evalsuite/registers.json");
    let text = std::fs::read_to_string(&path).expect("registers.json is unreadable");
    let file: RegisterFile = serde_json::from_str(&text).expect("registers.json is malformed");
    let turns = map_turns();
    let parser = Parser::new();

    let mut by_session: BTreeMap<&str, Vec<&MapTurn>> = BTreeMap::new();
    for turn in turns.iter().filter(|t| t.corpus == "suite") {
        by_session
            .entry(turn.session.as_str())
            .or_default()
            .push(turn);
    }

    let mut rows = Vec::new();
    for variant in &file.variants {
        let Some(session) = by_session.get(variant.session.as_str()) else {
            continue;
        };
        // registers.json numbers turns from 1; map.json from 0.
        let index = variant.turn.saturating_sub(1);
        let Some(base) = session.get(index) else {
            continue;
        };

        let mut state = ParseState::default();
        for earlier in session.iter().take(index) {
            if let Ok((turn, _)) = parser.parse(&earlier.request, &state) {
                state.record(turn);
            }
        }
        let (mine, why) = match parser.parse(&variant.request, &state) {
            Ok((turn, _)) => (Some(turn.to_string()), String::new()),
            Err(unparsed) => (None, unparsed.reason),
        };
        rows.push(Row {
            id: format!("{}.{}/{}", variant.session, index, variant.register),
            corpus: "registers".into(),
            category: base.category.clone(),
            register: variant.register.clone(),
            context_move: base.context_move.clone(),
            request: variant.request.clone(),
            gold: if base.covered {
                base.canonical.clone()
            } else {
                String::new()
            },
            mine,
            verdict: String::new(),
            why,
        });
    }
    rows
}

#[derive(Serialize)]
struct Payload<'rows> {
    rows: &'rows [Row],
}

#[derive(Deserialize)]
struct Verdicts {
    rows: Vec<Row>,
}

/// Ask the grammar's own parser for a verdict on every row.
pub fn score(rows: &[Row]) -> Vec<Row> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/parse/scorecheck.py");
    let mut child = Command::new("python3")
        .arg(&script)
        .arg(repo_grammar_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("python3 is needed to score against grammar/check.py");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        let payload = serde_json::to_vec(&Payload { rows }).expect("serialise");
        stdin.write_all(&payload).expect("write");
    }
    let output = child.wait_with_output().expect("scorecheck.py failed");
    assert!(
        output.status.success(),
        "scorecheck.py exited {:?}",
        output.status
    );
    let verdicts: Verdicts =
        serde_json::from_slice(&output.stdout).expect("scorecheck.py output is malformed");
    verdicts.rows
}

#[derive(Default, Debug, Clone, Copy)]
pub struct Tally {
    pub exact: usize,
    pub skeleton: usize,
    pub wrong: usize,
    pub illegal: usize,
    pub unparsed: usize,
    pub skipped: usize,
}

impl Tally {
    pub fn add(&mut self, verdict: &str) {
        match verdict {
            "exact" => self.exact += 1,
            "skeleton" => self.skeleton += 1,
            "wrong" => self.wrong += 1,
            "illegal" => self.illegal += 1,
            "unparsed" => self.unparsed += 1,
            _ => self.skipped += 1,
        }
    }

    pub fn scored(&self) -> usize {
        self.exact + self.skeleton + self.wrong + self.illegal + self.unparsed
    }

    /// Exact counts as a skeleton match: the shape was right too.
    pub fn skeleton_rate(&self) -> f64 {
        if self.scored() == 0 {
            return 0.0;
        }
        (self.exact + self.skeleton) as f64 / self.scored() as f64
    }

    pub fn exact_rate(&self) -> f64 {
        if self.scored() == 0 {
            return 0.0;
        }
        self.exact as f64 / self.scored() as f64
    }
}

pub fn tally_by<'rows>(
    rows: &'rows [Row],
    key: impl Fn(&'rows Row) -> String,
) -> BTreeMap<String, Tally> {
    let mut out: BTreeMap<String, Tally> = BTreeMap::new();
    for row in rows {
        out.entry(key(row)).or_default().add(&row.verdict);
    }
    out
}

pub fn overall(rows: &[Row]) -> Tally {
    let mut tally = Tally::default();
    for row in rows {
        tally.add(&row.verdict);
    }
    tally
}
