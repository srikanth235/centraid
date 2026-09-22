//! # `JoinedRules` — the first SHIPPING-SHAPED candidate
//!
//! [`crate::oracle::OracleCanonical`] is a ceiling: it is handed the gold
//! canonical out of `grammar/map.json`. This is the same executor with the
//! lookup replaced by the thing a shipped runtime would actually have — the
//! tier-D rules parser of [`crate::parse`]. Nothing else changes, which is
//! what makes the two numbers subtractable: *ceiling minus joined* is exactly
//! what the paraphrase step costs.
//!
//! One turn, end to end:
//!
//! 1. [`parse::Parser::parse`] over the member's words, with the session's
//!    [`parse::ParseState`] threaded (the previous canonical is how a
//!    follow-up resolves).
//! 2. An [`parse::Unparsed`] becomes `Plan::Declined { reason: "clarify" }` —
//!    an honest *I did not understand you*. **This is scored as a FAILURE
//!    everywhere except a genuine `clarify` turn, and that is what we want**:
//!    the harness must not pay a candidate for a polite shrug, and the handful
//!    of turns where a clarify is the right answer are the only place an
//!    abstention should earn anything.
//! 3. The canonical STRING is re-parsed by [`crate::canon`] into the executor's
//!    tree. The string is the join point between the two lanes, and a string
//!    the rules lane can render but `canon` cannot read is a defect of the
//!    JOIN rather than of either half — so it is declined with its own reason
//!    and counted separately.
//! 4. [`crate::exec::execute`] runs the tree against the session's
//!    [`exec::State`] and the harness's `Context`.
//!
//! **It never sees the session id or `map.json`.** The id reaches this module
//! in one place only — [`SessionLog`], which is write-only: nothing in the
//! decision path reads it, and removing the log would not change a single
//! plan. The stage attribution that `run-joined` prints does consult
//! `map.json`, but it does so AFTER the run, over the log, as a reader.

use std::io::Write;
use std::sync::{Arc, Mutex};

use centraid_evalsuite::{Candidate, CandidateRuntime, Context, Plan, Session};

use crate::exec::{State, execute};
use crate::parse::{ParseState, Parser};

/// One turn's raw record. **The canonical is saved BEFORE it is parsed** — the
/// brief's "save raw model output before parsing" rule applies to a rules
/// parser exactly as it applies to a model: the string is the output, and a
/// string that crashes the next stage is the most interesting one there is.
#[derive(Debug, Clone, serde::Serialize)]
pub struct JoinedRow {
    pub corpus: String,
    pub session: String,
    pub turn: usize,
    pub request: String,
    /// The canonical string the rules parser emitted, or `null` on abstention.
    pub canonical: Option<String>,
    /// Why it abstained, when it did.
    pub why: String,
    /// The plan, rendered.
    pub plan: String,
    /// Filled in after the run, by whoever holds the report.
    pub verdict: Option<String>,
}

/// Where the raw rows go: an in-memory tail AND a JSONL file written as the
/// run happens, so a panic three sessions later cannot lose what was emitted.
pub struct Sink {
    file: Option<std::fs::File>,
    rows: Vec<JoinedRow>,
}

impl Sink {
    /// # Errors
    ///
    /// The JSONL path cannot be created.
    pub fn to_file(path: &std::path::Path) -> Result<Self, String> {
        let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self {
            file: Some(file),
            rows: Vec::new(),
        })
    }

    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            file: None,
            rows: Vec::new(),
        }
    }

    fn push(&mut self, row: JoinedRow) {
        if let Some(file) = self.file.as_mut()
            && let Ok(line) = serde_json::to_string(&row)
        {
            let _ = writeln!(file, "{line}");
        }
        self.rows.push(row);
    }

    #[must_use]
    pub fn rows(&self) -> &[JoinedRow] {
        &self.rows
    }
}

/// The write-only end of the log for one session.
struct SessionLog {
    corpus: String,
    /// **WRITE-ONLY.** Nothing downstream of this field reads it.
    id: String,
    sink: Arc<Mutex<Sink>>,
}

/// The candidate runtime: the rules parser joined to the executor.
pub struct JoinedRules {
    corpus: String,
    sink: Arc<Mutex<Sink>>,
}

impl JoinedRules {
    #[must_use]
    pub fn new(corpus: &str, sink: Arc<Mutex<Sink>>) -> Self {
        Self {
            corpus: corpus.to_owned(),
            sink,
        }
    }
}

impl CandidateRuntime for JoinedRules {
    fn name(&self) -> &str {
        "joined-rules (tier-D parser + executor; a CANDIDATE, no gold anywhere)"
    }

    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(JoinedSession {
            parser: Parser::new(),
            parse_state: ParseState::default(),
            exec_state: State::default(),
            turn: 0,
            log: SessionLog {
                corpus: self.corpus.clone(),
                id: session.id.clone(),
                sink: Arc::clone(&self.sink),
            },
        })
    }
}

struct JoinedSession {
    parser: Parser,
    parse_state: ParseState,
    exec_state: State,
    turn: usize,
    log: SessionLog,
}

impl Candidate for JoinedSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let at = self.turn;
        self.turn += 1;

        // (1) TEXT -> CANONICAL. The state is threaded, not reset: a follow-up
        // that says "them" has no meaning without the turn before it.
        let (canonical, why) = match self.parser.parse(request, &self.parse_state) {
            Ok((turn, _move)) => {
                let text = turn.to_string();
                self.parse_state.record(turn);
                (Some(text), String::new())
            }
            Err(unparsed) => (None, unparsed.reason),
        };

        // (2) The raw string is recorded BEFORE anything downstream touches it.
        let plan = match &canonical {
            // An honest abstention. Scored as a failure everywhere but a
            // genuine clarify turn — see the module docs.
            None => Plan::Declined {
                reason: "clarify".to_owned(),
            },
            // (3) THE JOIN. The rules lane renders; `canon` reads. A string one
            // can write and the other cannot read is a defect of the seam.
            Some(text) => match crate::canon::parse(text) {
                // (4) The executor, unchanged from the oracle's.
                Ok(tree) => execute(&tree, &mut self.exec_state, ctx),
                Err(complaint) => Plan::Declined {
                    reason: format!("unhandled: the join does not re-parse: {complaint}"),
                },
            },
        };

        // The session's row count, fed back to the parser. GRAMMAR.md 3's
        // it/them convention is over the rows the member was SHOWN, so a
        // parser that never learns how many there were cannot follow it. This
        // is not gold: it is what the runtime itself just answered.
        if let Plan::Ids(rows) = &plan {
            self.parse_state.held_rows = Some(rows.len());
        }

        if let Ok(mut sink) = self.log.sink.lock() {
            sink.push(JoinedRow {
                corpus: self.log.corpus.clone(),
                session: self.log.id.clone(),
                turn: at,
                request: request.to_owned(),
                canonical,
                why,
                plan: format!("{plan:?}"),
                verdict: None,
            });
        }
        plan
    }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/// Run [`JoinedRules`] over one frozen corpus, returning the report and the
/// raw per-turn log beside it.
///
/// `holdout.json` is the SECOND scenario's world; the other two are the first
/// — the same rule [`crate::oracle_report`] follows, for the same reason.
///
/// # Errors
///
/// The corpus, the world or the handles do not resolve.
pub fn corpus_report(
    corpus: &str,
    sink: &Arc<Mutex<Sink>>,
) -> Result<centraid_evalsuite::Report, String> {
    let mut suite = centraid_evalsuite::Suite::read(&crate::corpus_path(corpus))?;
    let template = if corpus == "holdout" {
        centraid_evalsuite::WorldTemplate::build_scenario(centraid_evalworld::Scenario::Second)?
    } else {
        centraid_evalsuite::WorldTemplate::build()?
    };
    suite.resolve(&template.inventory)?;
    let runtime = JoinedRules::new(corpus, Arc::clone(sink));
    centraid_evalsuite::run(&suite, &template, &runtime)
}

/// Every `registers.json` variant as its OWN SINGLE-TURN SESSION.
///
/// `run-register` swaps a register's variants into the suite in place and runs
/// whole sessions; this does the opposite and it measures a different thing.
/// A variant of turn 3 is lifted out of its conversation and asked cold, so
/// the candidate has no state to resolve a pronoun against. **That makes the
/// elliptical register's score a floor rather than an estimate** — its whole
/// point is that the noun lives in the previous turn, and here there is no
/// previous turn. It is reported that way on purpose: 349 variants scored
/// against the vault is the first time any candidate has been put through
/// them, and the shape of the loss per register is the finding.
///
/// # Errors
///
/// `registers.json`, the suite or the world does not read.
pub fn registers_report(
    sink: &Arc<Mutex<Sink>>,
) -> Result<(centraid_evalsuite::Report, usize), String> {
    #[derive(serde::Deserialize)]
    struct Variant {
        session: String,
        /// 1-based, as the report keys turns.
        turn: usize,
        register: String,
        request: String,
    }
    #[derive(serde::Deserialize)]
    struct Registers {
        variants: Vec<Variant>,
    }

    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../evalsuite");
    let text = std::fs::read_to_string(root.join("registers.json"))
        .map_err(|error| format!("registers.json: {error}"))?;
    let registers: Registers =
        serde_json::from_str(&text).map_err(|error| format!("registers.json: {error}"))?;

    let base = centraid_evalsuite::Suite::read(&root.join("suite.json"))?;
    let mut suite = base.clone();
    let mut skipped = 0usize;
    suite.sessions = Vec::with_capacity(registers.variants.len());
    for variant in &registers.variants {
        let Some(session) = base.sessions.iter().find(|s| s.id == variant.session) else {
            skipped += 1;
            continue;
        };
        let Some(turn) = session.turns.get(variant.turn.saturating_sub(1)) else {
            skipped += 1;
            continue;
        };
        let mut lifted = turn.clone();
        lifted.request.clone_from(&variant.request);
        suite.sessions.push(centraid_evalsuite::Session {
            // The id carries the register so the report can group by it. The
            // candidate never reads it (see `SessionLog`).
            id: format!("{}.t{}/{}", variant.session, variant.turn, variant.register),
            category: variant.register.clone(),
            correlation_group: None,
            turns: vec![lifted],
        });
    }

    let template = centraid_evalsuite::WorldTemplate::build()?;
    suite.resolve(&template.inventory)?;
    let runtime = JoinedRules::new("registers", Arc::clone(sink));
    let report = centraid_evalsuite::run(&suite, &template, &runtime)?;
    Ok((report, skipped))
}
