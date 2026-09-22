//! # `OracleCanonical` — the executor's CEILING TEST
//!
//! **This is not a shipping candidate and must never be quoted as one.** It is
//! handed the GOLD CANONICAL for the turn out of `grammar/map.json` and runs
//! [`crate::exec`] on it, so its score is the answer to one question and one
//! only: *if the paraphrase step were perfect, how much of the corpus could
//! this executor actually execute through the doors that exist?*
//!
//! It sees the session id for exactly one purpose — to look the canonical up.
//! There is no per-session or per-turn resolution in [`crate::exec`], and the
//! executor cannot tell which corpus it is running against. A real candidate
//! replaces the lookup with a parser and changes nothing else.

use std::collections::BTreeMap;
use std::sync::Arc;

use centraid_evalsuite::{Candidate, CandidateRuntime, Context, Plan, Session};

use crate::exec::{State, execute};
use crate::map::MapTurn;

pub struct OracleCanonical {
    corpus: String,
    canonicals: Arc<BTreeMap<(String, String, usize), MapTurn>>,
}

impl OracleCanonical {
    /// # Errors
    ///
    /// `map.json` is unreadable.
    pub fn new(corpus: &str, map: &std::path::Path) -> Result<Self, String> {
        Ok(Self {
            corpus: corpus.to_owned(),
            canonicals: Arc::new(crate::map::read(map)?),
        })
    }
}

impl CandidateRuntime for OracleCanonical {
    fn name(&self) -> &str {
        "oracle-canonical (gold canonical + executor; a CEILING, not a candidate)"
    }

    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(OracleSession {
            corpus: self.corpus.clone(),
            id: session.id.clone(),
            turn: 0,
            state: State::default(),
            canonicals: Arc::clone(&self.canonicals),
        })
    }
}

struct OracleSession {
    corpus: String,
    id: String,
    turn: usize,
    state: State,
    canonicals: Arc<BTreeMap<(String, String, usize), MapTurn>>,
}

impl Candidate for OracleSession {
    fn turn(&mut self, _request: &str, ctx: &mut Context<'_>) -> Plan {
        let at = self.turn;
        self.turn += 1;
        let key = (self.corpus.clone(), self.id.clone(), at);
        let Some(mapped) = self.canonicals.get(&key) else {
            return Plan::Declined {
                reason: "unhandled: no canonical is mapped for this turn".to_owned(),
            };
        };
        if !mapped.covered {
            return Plan::Declined {
                reason: "unhandled: the grammar does not cover this turn".to_owned(),
            };
        }
        match crate::canon::parse(&mapped.canonical) {
            Ok(tree) => execute(&tree, &mut self.state, ctx),
            Err(complaint) => Plan::Declined {
                reason: format!("unhandled: the canonical does not parse: {complaint}"),
            },
        }
    }
}
