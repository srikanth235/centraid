//! THE REFERENCE REPLAY: a scoring run is only meaningful if the set can be solved. Every session's reference calls
//! are said, turn by turn, through the same runner and the same judge a model is scored with
//! ([`crate::run::Runner`], [`crate::judge`]); the set must come out at 100% before any model is asked.
//!
//! This is the path `datagen`'s tests take for what it generates (`tests/intents.rs`, `tests/render.rs`); there is no
//! second judge. A set whose gold the runtime cannot reproduce (the frozen v7 val, whose references name `$key`s and
//! whose gold predates the vault rebuild) fails here with the sessions listed, and a scoring run does not start.

use std::collections::BTreeMap;
use std::sync::Mutex;

use centraid_assist::native::prompt::ToolsMode;
use serde_json::Value;

use crate::EvalError;
use crate::gold::{RefCall, Session};
use crate::run::{Runner, StepOut, Stepper};
use crate::source::EvalSource;

/// A reference call in the text form the runtime reads from a model.
fn call_text(call: &RefCall) -> String {
    let mut text = format!("<tool_call>\n<function={}>\n", call.tool);
    for (name, value) in &call.args {
        let value = match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        text += &format!("<parameter={name}>\n{value}\n</parameter>\n");
    }
    text + "</function>\n</tool_call>"
}

#[derive(Default)]
struct Cursor {
    session: String,
    /// Per user text: the occurrence being answered and the calls said of it so far.
    at: BTreeMap<String, (usize, usize)>,
}

/// Says each turn's reference calls in order. It finds the turn being answered by its user text, the last of the
/// session's texts in the prompt, so it needs no placeholder syntax; a text a session repeats is answered occurrence
/// by occurrence.
pub struct ReferenceReplay {
    /// Session id → per user text, one list of calls for each turn with that text.
    sessions: BTreeMap<String, BTreeMap<String, Vec<Vec<String>>>>,
    cursor: Mutex<Cursor>,
}

impl ReferenceReplay {
    #[must_use]
    pub fn new(sessions: &[Session]) -> Self {
        let mut by_session = BTreeMap::new();
        for session in sessions {
            let mut texts: BTreeMap<String, Vec<Vec<String>>> = BTreeMap::new();
            for turn in &session.turns {
                let calls: Vec<String> = turn
                    .reference
                    .iter()
                    .filter(|c| !c.bad)
                    .map(call_text)
                    .collect();
                // a turn with no call is not asked of the model (a retraction ends it in the runtime)
                if !calls.is_empty() {
                    texts.entry(turn.user.clone()).or_default().push(calls);
                }
            }
            by_session.insert(session.id.clone(), texts);
        }
        Self {
            sessions: by_session,
            cursor: Mutex::new(Cursor::default()),
        }
    }
}

impl Stepper for ReferenceReplay {
    fn begin_session(&self, id: &str) {
        if let Ok(mut cursor) = self.cursor.lock() {
            *cursor = Cursor {
                session: id.to_owned(),
                at: BTreeMap::new(),
            };
        }
    }

    fn step(
        &self,
        prompt: &str,
        _dates: Option<&str>,
        _tools: ToolsMode,
    ) -> Result<StepOut, String> {
        let mut cursor = self.cursor.lock().map_err(|e| e.to_string())?;
        let texts = self
            .sessions
            .get(&cursor.session)
            .ok_or_else(|| format!("no reference for session {}", cursor.session))?;
        // the turn being answered: the session text that ends last in the prompt (the longer one on a tie)
        let user = texts
            .keys()
            .filter_map(|text| {
                prompt
                    .rfind(text.as_str())
                    .map(|at| (at + text.len(), text))
            })
            .max_by_key(|(end, text)| (*end, text.len()))
            .map(|(_, text)| text.clone())
            .ok_or("the prompt holds none of the session's user messages")?;
        let occurrences = &texts[&user];
        let (occurrence, said) = cursor.at.entry(user).or_default();
        if *said >= occurrences[*occurrence].len() && *occurrence + 1 < occurrences.len() {
            *occurrence += 1;
            *said = 0;
        }
        let text = occurrences[*occurrence]
            .get(*said)
            .ok_or("more steps than reference calls")?
            .clone();
        *said += 1;
        Ok(StepOut {
            text,
            think_cut: false,
            tokens: 0,
        })
    }
}

/// A turn the reference did not reproduce.
#[derive(Debug, Clone)]
pub struct ReplayFailure {
    pub session: String,
    /// 1-based.
    pub turn: usize,
    pub user: String,
    pub ending: String,
    pub problems: Vec<String>,
}

/// What replaying a set came to.
#[derive(Debug, Clone, Default)]
pub struct ReplayReport {
    pub sessions: usize,
    pub turns: usize,
    pub failed: Vec<ReplayFailure>,
    /// Sessions the data could not run at all (a world that does not seed): `(id, why)`.
    pub unrunnable: Vec<(String, String)>,
}

impl ReplayReport {
    /// Whether every session replayed to its gold.
    #[must_use]
    pub fn replays(&self) -> bool {
        self.failed.is_empty() && self.unrunnable.is_empty()
    }

    /// The sessions that failed, one line each (at most `show`), for a refusal.
    #[must_use]
    pub fn describe(&self, show: usize) -> String {
        let mut ids: Vec<&str> = self
            .failed
            .iter()
            .map(|f| f.session.as_str())
            .chain(self.unrunnable.iter().map(|(id, _)| id.as_str()))
            .collect();
        ids.dedup();
        let mut out = format!(
            "{} of {} sessions do not replay ({} failed turns of {}, {} that could not run)\n",
            ids.len(),
            self.sessions,
            self.failed.len(),
            self.turns,
            self.unrunnable.len()
        );
        for failure in self.failed.iter().take(show) {
            out += &format!(
                "  {} turn {} ended {}: {}\n",
                failure.session,
                failure.turn,
                failure.ending,
                failure
                    .problems
                    .first()
                    .map_or("(no problem text)", String::as_str)
            );
        }
        for (id, why) in self.unrunnable.iter().take(show) {
            out += &format!("  {id} could not run: {why}\n");
        }
        let more = (self.failed.len() + self.unrunnable.len()).saturating_sub(show);
        if more > 0 {
            out += &format!("  … and {more} more\n");
        }
        out
    }
}

/// Replay `sessions` through the runner and the judge with their own reference calls.
///
/// # Errors
/// [`EvalError`] when the runner cannot be made or the runtime itself fails (not a session whose data is bad: that is
/// listed in the report).
pub fn replay(
    source: &dyn EvalSource,
    sessions: &[Session],
    tools: ToolsMode,
) -> Result<ReplayReport, EvalError> {
    let stepper = ReferenceReplay::new(sessions);
    let mut runner = Runner::new(source, &stepper)?.with_tools(tools);
    let mut report = ReplayReport {
        sessions: sessions.len(),
        ..ReplayReport::default()
    };
    for session in sessions {
        match runner.run_session(session) {
            Ok(result) => {
                report.turns += result.turns.len();
                for (i, turn) in result.turns.iter().enumerate().filter(|(_, t)| !t.pass) {
                    report.failed.push(ReplayFailure {
                        session: result.id.clone(),
                        turn: i + 1,
                        user: turn.user.clone(),
                        ending: turn.ending.clone(),
                        problems: turn.problems.clone(),
                    });
                }
            }
            Err(error @ (EvalError::Data(_) | EvalError::Json { .. } | EvalError::Read { .. })) => {
                report
                    .unrunnable
                    .push((session.id.clone(), error.to_string()))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(report)
}

/// The precondition of a scoring run: the set replays to 100%.
///
/// # Errors
/// [`EvalError::Data`] listing the sessions that do not replay.
pub fn require(
    source: &dyn EvalSource,
    sessions: &[Session],
    tools: ToolsMode,
) -> Result<ReplayReport, EvalError> {
    let report = replay(source, sessions, tools)?;
    if report.replays() {
        Ok(report)
    } else {
        Err(EvalError::Data(format!(
            "the reference calls do not replay to the gold, so the set cannot score a model.\n{}",
            report.describe(20)
        )))
    }
}
