//! # `ModelCanonical` — a TRAINED MODEL's canonicals, through the same executor
//!
//! [`OracleCanonical`](crate::oracle::OracleCanonical) is handed the GOLD
//! canonical out of `grammar/map.json` and is therefore a ceiling. This is the
//! same executor handed a canonical STRING a fine-tuned seq2seq model emitted,
//! read out of a JSONL file written before anything parsed it:
//!
//! ```text
//! {"corpus": "suite", "session": "s01", "turn": 0, "canonical": "show (events during this week)"}
//! ```
//!
//! The rules of evidence this candidate enforces, and which must not be
//! relaxed to make a number look better:
//!
//! * A turn with **no row** in the file is a FAILURE (`Declined`), never a skip.
//! * A canonical that **does not parse** is a FAILURE, never repaired here.
//! * Nothing in this file edits, normalises or completes the model's string.
//!
//! Like the oracle it sees the session id only to look its own output up;
//! [`crate::exec`] is unchanged and cannot tell which corpus it is running.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use centraid_evalsuite::{Candidate, CandidateRuntime, Context, Plan, Session};
use serde::Deserialize;

use crate::exec::{State, execute};

#[derive(Debug, Clone, Deserialize)]
struct OutputRow {
    corpus: String,
    session: String,
    turn: usize,
    canonical: String,
}

/// Every model output in a JSONL file, keyed `(corpus, session, turn)`.
///
/// # Errors
///
/// The file is unreadable, or a line is not an output row.
pub fn read_outputs(path: &Path) -> Result<BTreeMap<(String, String, usize), String>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut out = BTreeMap::new();
    for (at, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: OutputRow = serde_json::from_str(line)
            .map_err(|error| format!("{}:{}: {error}", path.display(), at + 1))?;
        out.insert((row.corpus, row.session, row.turn), row.canonical);
    }
    Ok(out)
}

pub struct ModelCanonical {
    corpus: String,
    name: String,
    outputs: Arc<BTreeMap<(String, String, usize), String>>,
}

impl ModelCanonical {
    /// # Errors
    ///
    /// The output file is unreadable.
    pub fn new(corpus: &str, outputs: &Path) -> Result<Self, String> {
        Ok(Self {
            corpus: corpus.to_owned(),
            name: format!(
                "model-canonical ({}; a trained model's output + executor)",
                outputs.display()
            ),
            outputs: Arc::new(read_outputs(outputs)?),
        })
    }
}

impl CandidateRuntime for ModelCanonical {
    fn name(&self) -> &str {
        &self.name
    }

    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(ModelSession {
            corpus: self.corpus.clone(),
            id: session.id.clone(),
            turn: 0,
            state: State::default(),
            outputs: Arc::clone(&self.outputs),
        })
    }
}

struct ModelSession {
    corpus: String,
    id: String,
    turn: usize,
    state: State,
    outputs: Arc<BTreeMap<(String, String, usize), String>>,
}

impl Candidate for ModelSession {
    fn turn(&mut self, _request: &str, ctx: &mut Context<'_>) -> Plan {
        let at = self.turn;
        self.turn += 1;
        let key = (self.corpus.clone(), self.id.clone(), at);
        let Some(canonical) = self.outputs.get(&key) else {
            return Plan::Declined {
                reason: "unhandled: the model emitted nothing for this turn".to_owned(),
            };
        };
        match crate::canon::parse(canonical) {
            Ok(tree) => execute(&tree, &mut self.state, ctx),
            Err(complaint) => Plan::Declined {
                reason: format!("unhandled: the model's canonical does not parse: {complaint}"),
            },
        }
    }
}
