//! THE EVAL SET: questions and the calls a correct model makes for them.
//!
//! `contracts/assist/eval-cases.json` is one fixture serving four readers:
//!
//! 1. **The plane's end-to-end test** (`crates/core/tests/assist_eval.rs`) runs
//!    every case through the real core against the sample vault with an
//!    [`crate::testing::OracleModel`] that says what the case expects — which
//!    proves the registry, the executors and the cards, and fails the day a
//!    scenario row a case depends on goes away.
//! 2. **The harness** (`assist-eval`) will run a real GGUF over the same cases
//!    and report accuracy. Routing needs no vault: the prompt the model sees is
//!    a function of the question, the scope and the history alone.
//! 3. **The fine-tune's eval set**, through [`export_jsonl`]: the prompt exactly
//!    as the phone sends it and the completion exactly as the grammar spells it.
//! 4. **The grammar test**, which holds every expected call to the grammar.
//!
//! # WHAT A CASE EXPECTS
//!
//! A route: a tool and its arguments, `none` (no tool fits), or a direct answer
//! (any text; the check is that the model chose to answer directly). Cases that
//! read also state what the cards must hold, so a run over the sample vault is
//! a statement about what a member would see, not just which function ran.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::call::{Route, ToolCall, parse_route};
use crate::grammar::route_gbnf;
use crate::model::{Cancel, Control, GenerateRequest, Model};
use crate::prompt::{Budget, END_OF_TURN, Recorded, Turn, question, route_prompt};
use crate::tool::App;
use crate::turn::ROUTE_MAX_TOKENS;

/// The fixture file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvalFile {
    pub version: u32,
    /// The scenario the cases were written against (`sample vault`'s Tahoe weekend).
    pub scenario: String,
    pub cases: Vec<EvalCase>,
}

/// One question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvalCase {
    pub id: String,
    /// The app the chat was opened from, when it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub question: String,
    /// Earlier turns, oldest first (the plane keeps the last two).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<HistoryEntry>,
    pub expect: Expect,
    /// What the cards must hold, for the run over a real vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cards: Option<CardsExpect>,
}

/// An earlier turn of a case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub user: String,
    /// The call it made; absent for a direct answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<ExpectedCall>,
    /// The read's headline (with a call) — what the next prompt remembers of it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub headline: String,
    /// The sentence it said.
    pub answer: String,
}

/// A tool and its arguments, as the fixture spells them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedCall {
    pub tool: String,
    #[serde(default)]
    pub args: BTreeMap<String, String>,
}

/// What a case expects the model to emit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Expect {
    /// A call, or `{"tool":"none"}`.
    Call(ExpectedCall),
    /// A direct answer. The text is an example, not a target.
    Answer { answer: String },
}

/// What a read case's cards must hold over the sample vault.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CardsExpect {
    /// The app every card belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<usize>,
    /// Each must appear, case-insensitively, inside some card's title.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub titles: Vec<String>,
}

/// Why a fixture is not usable.
#[derive(Debug, thiserror::Error)]
pub enum EvalError {
    #[error("the fixture is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("case {id}: {why}")]
    Case { id: String, why: String },
}

impl ExpectedCall {
    /// The call, validated against the registry; `None` for `none`.
    ///
    /// # Errors
    /// The registry's refusal, when the fixture names something it forbids.
    pub fn to_call(&self) -> Result<Option<ToolCall>, crate::call::ArgError> {
        if self.tool == "none" {
            return Ok(None);
        }
        ToolCall::new(
            &self.tool,
            self.args.iter().map(|(k, v)| (k.as_str(), v.as_str())),
        )
        .map(Some)
    }
}

impl EvalCase {
    fn bad(&self, why: impl Into<String>) -> EvalError {
        EvalError::Case {
            id: self.id.clone(),
            why: why.into(),
        }
    }

    /// The app scope, validated.
    ///
    /// # Errors
    /// [`EvalError::Case`] for an unknown app — which includes `locker`.
    pub fn scope(&self) -> Result<Option<App>, EvalError> {
        self.scope
            .as_deref()
            .map(|id| {
                App::from_id(id)
                    .ok_or_else(|| self.bad(format!("`{id}` is not an app the assistant reads")))
            })
            .transpose()
    }

    /// The earlier turns as the prompt holds them.
    ///
    /// # Errors
    /// [`EvalError::Case`] when a history call is not a valid call.
    pub fn turns(&self) -> Result<Vec<Turn>, EvalError> {
        self.history
            .iter()
            .map(|entry| {
                let record = match &entry.call {
                    None => Recorded::Answer(entry.answer.clone()),
                    Some(expected) => {
                        match expected.to_call().map_err(|e| self.bad(e.to_string()))? {
                            None => Recorded::NoTool,
                            Some(call) => Recorded::Tool {
                                call_json: call.to_json(),
                                headline: entry.headline.clone(),
                                answer: entry.answer.clone(),
                            },
                        }
                    }
                };
                Ok(Turn {
                    user: question(&entry.user),
                    record,
                })
            })
            .collect()
    }

    /// The route JSON a correct model emits, in its one canonical spelling.
    ///
    /// # Errors
    /// [`EvalError::Case`] when the expectation is not a valid route.
    pub fn expected_json(&self) -> Result<String, EvalError> {
        match &self.expect {
            Expect::Answer { answer } => Ok(json!({ "answer": answer }).to_string()),
            Expect::Call(expected) => Ok(expected
                .to_call()
                .map_err(|e| self.bad(e.to_string()))?
                .map_or_else(|| r#"{"tool":"none"}"#.to_owned(), |call| call.to_json())),
        }
    }

    /// The prompt the model sees for this case.
    ///
    /// # Errors
    /// [`EvalError::Case`] for a bad scope or history.
    pub fn prompt(&self, budget: Budget) -> Result<crate::prompt::RoutePrompt, EvalError> {
        Ok(route_prompt(
            self.scope()?,
            &self.turns()?,
            &self.question,
            budget,
        ))
    }
}

impl EvalFile {
    /// Parse and validate a fixture: unique ids, valid scopes, valid calls.
    ///
    /// # Errors
    /// [`EvalError`] naming the first case that is not usable.
    pub fn parse(text: &str) -> Result<Self, EvalError> {
        let file: Self = serde_json::from_str(text)?;
        let mut ids = std::collections::BTreeSet::new();
        for case in &file.cases {
            if !ids.insert(case.id.as_str()) {
                return Err(case.bad("its id is used twice"));
            }
            case.scope()?;
            case.turns()?;
            case.expected_json()?;
        }
        Ok(file)
    }

    /// The oracle's routes: each question, as the prompt holds it, to its call.
    ///
    /// # Errors
    /// [`EvalError::Case`] for an invalid case.
    pub fn oracle_routes(&self) -> Result<Vec<(String, String)>, EvalError> {
        self.cases
            .iter()
            .map(|case| Ok((question(&case.question), case.expected_json()?)))
            .collect()
    }
}

/// One JSONL line per case: the prompt as the phone sends it, and the
/// completion as the grammar spells it.
///
/// # Errors
/// [`EvalError::Case`] for an invalid case.
pub fn export_jsonl(file: &EvalFile, budget: Budget) -> Result<String, EvalError> {
    let mut out = String::new();
    for case in &file.cases {
        let prompt = case.prompt(budget)?;
        let line = json!({
            "id": case.id,
            "scope": case.scope,
            "prompt": prompt.text,
            "completion": format!("{}{END_OF_TURN}", case.expected_json()?),
            "tools": prompt.tools.iter().map(|spec| spec.name).collect::<Vec<_>>(),
        });
        out.push_str(&line.to_string());
        out.push('\n');
    }
    Ok(out)
}

/// What a model did with one case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseResult {
    pub id: String,
    pub output: String,
    /// The route's kind matched: a call, `none` or an answer.
    pub kind_ok: bool,
    /// The tool named matched.
    pub tool_ok: bool,
    /// Tool and every argument matched exactly.
    pub exact: bool,
}

/// A run's totals.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Report {
    pub cases: Vec<CaseResult>,
}

impl Report {
    #[must_use]
    pub fn total(&self) -> usize {
        self.cases.len()
    }

    #[must_use]
    pub fn exact(&self) -> usize {
        self.cases.iter().filter(|case| case.exact).count()
    }

    #[must_use]
    pub fn tool(&self) -> usize {
        self.cases.iter().filter(|case| case.tool_ok).count()
    }

    #[must_use]
    pub fn kind(&self) -> usize {
        self.cases.iter().filter(|case| case.kind_ok).count()
    }

    /// The cases that did not match exactly.
    pub fn misses(&self) -> impl Iterator<Item = &CaseResult> {
        self.cases.iter().filter(|case| !case.exact)
    }
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let total = self.total().max(1);
        let pct = |n: usize| 100.0 * n as f64 / total as f64;
        writeln!(f, "cases           {}", self.total())?;
        writeln!(
            f,
            "route kind      {}/{} ({:.1}%)",
            self.kind(),
            self.total(),
            pct(self.kind())
        )?;
        writeln!(
            f,
            "tool            {}/{} ({:.1}%)",
            self.tool(),
            self.total(),
            pct(self.tool())
        )?;
        writeln!(
            f,
            "tool + args     {}/{} ({:.1}%)",
            self.exact(),
            self.total(),
            pct(self.exact())
        )?;
        for miss in self.misses() {
            writeln!(f, "  miss {:<28} {}", miss.id, miss.output)?;
        }
        Ok(())
    }
}

/// Run every case's routing step through `model` — the prompt, the grammar, the
/// parse — and compare with what the case expects. No vault is needed: routing
/// is a function of the question, the scope and the history.
///
/// # Errors
/// [`EvalError`] for an invalid case; a model failure on one case is a miss,
/// not an abort.
pub fn run_routing(
    model: &dyn Model,
    file: &EvalFile,
    budget: Budget,
) -> Result<Report, EvalError> {
    let cancel = Cancel::new();
    let mut report = Report::default();
    for case in &file.cases {
        let prompt = case.prompt(budget)?;
        let grammar = route_gbnf(&prompt.tools);
        let output = model
            .generate(
                &GenerateRequest {
                    prompt: &prompt.text,
                    grammar: Some(&grammar),
                    max_tokens: ROUTE_MAX_TOKENS,
                    stop: &[END_OF_TURN],
                    temperature: 0.0,
                    cancel: &cancel,
                    images: &[],
                },
                &mut |_| Control::Continue,
            )
            .map(|generation| generation.text)
            .unwrap_or_default();
        report.cases.push(judge(case, &output, &prompt.tools)?);
    }
    Ok(report)
}

/// Compare one output with one case.
///
/// # Errors
/// [`EvalError`] for an invalid case.
pub fn judge(
    case: &EvalCase,
    output: &str,
    offered: &crate::tool::ToolSet,
) -> Result<CaseResult, EvalError> {
    let got = parse_route(output, offered);
    let (kind_ok, tool_ok, exact) = match (&case.expect, &got) {
        (Expect::Answer { .. }, Ok(Route::Answer(_))) => (true, true, true),
        (Expect::Call(expected), Ok(route)) => {
            match (
                expected.to_call().map_err(|e| case.bad(e.to_string()))?,
                route,
            ) {
                (None, Route::NoTool) => (true, true, true),
                (Some(want), Route::Tool(have)) => {
                    (true, want.name() == have.name(), want == *have)
                }
                _ => (false, false, false),
            }
        }
        _ => (false, false, false),
    };
    Ok(CaseResult {
        id: case.id.clone(),
        output: output.to_owned(),
        kind_ok,
        tool_ok,
        exact,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::OracleModel;
    use crate::tool::ToolSet;

    fn file() -> EvalFile {
        EvalFile::parse(
            r#"{"version":1,"scenario":"s","cases":[
              {"id":"a","question":"What is due today?","expect":{"tool":"tasks.list","args":{"view":"today"}}},
              {"id":"b","scope":"tally","question":"Who owes me?","expect":{"tool":"tally.balances"}},
              {"id":"c","question":"weather?","expect":{"tool":"none"}},
              {"id":"d","question":"hello","expect":{"answer":"Hello."}},
              {"id":"e","question":"and tomorrow?","history":[
                 {"user":"what is on today?","call":{"tool":"agenda.upcoming","args":{"range":"today"}},"headline":"1 event today","answer":"One."}],
               "expect":{"tool":"agenda.upcoming","args":{"range":"tomorrow"}}}
            ]}"#,
        )
        .expect("the sample fixture parses")
    }

    #[test]
    fn the_oracle_scores_a_hundred_percent_and_a_wrong_model_does_not() {
        let file = file();
        let oracle = OracleModel::new(file.oracle_routes().unwrap());
        let report = run_routing(&oracle, &file, Budget::DEFAULT).unwrap();
        assert_eq!((report.total(), report.exact()), (5, 5), "{report}");

        let wrong = OracleModel::new([]);
        let report = run_routing(&wrong, &file, Budget::DEFAULT).unwrap();
        assert_eq!(
            report.exact(),
            1,
            "only the `none` case is right by accident: {report}"
        );
    }

    #[test]
    fn a_right_tool_with_a_wrong_argument_counts_for_the_tool_and_not_the_args() {
        let file = file();
        let result = judge(
            &file.cases[0],
            r#"{"tool":"tasks.list","args":{"view":"upcoming"}}"#,
            &ToolSet::for_scope(None),
        )
        .unwrap();
        assert!(result.kind_ok && result.tool_ok && !result.exact);
    }

    #[test]
    fn an_unparsable_output_is_a_miss_on_every_axis() {
        let file = file();
        let result = judge(&file.cases[0], "nonsense", &ToolSet::for_scope(None)).unwrap();
        assert!(!result.kind_ok && !result.tool_ok && !result.exact);
    }

    #[test]
    fn a_direct_answer_case_only_asks_that_the_model_answered() {
        let file = file();
        let result = judge(
            &file.cases[3],
            r#"{"answer":"Hi there."}"#,
            &ToolSet::for_scope(None),
        )
        .unwrap();
        assert!(result.exact);
        let result = judge(
            &file.cases[3],
            r#"{"tool":"none"}"#,
            &ToolSet::for_scope(None),
        )
        .unwrap();
        assert!(!result.kind_ok);
    }

    #[test]
    fn history_rides_into_the_prompt_as_the_last_two_turns() {
        let file = file();
        let prompt = file.cases[4].prompt(Budget::DEFAULT).unwrap();
        assert!(prompt.text.contains("what is on today?"));
        assert!(
            prompt
                .text
                .contains(r#"{"tool":"agenda.upcoming","args":{"range":"today"}}"#)
        );
        assert!(
            prompt
                .text
                .contains("<tool_response>\n1 event today\n</tool_response>")
        );
    }

    #[test]
    fn the_export_pairs_the_prompt_with_the_canonical_completion() {
        let jsonl = export_jsonl(&file(), Budget::DEFAULT).unwrap();
        let lines: Vec<serde_json::Value> = jsonl
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 5);
        assert_eq!(
            lines[0]["completion"],
            r#"{"tool":"tasks.list","args":{"view":"today"}}<|im_end|>"#
        );
        assert_eq!(lines[1]["scope"], "tally");
        assert!(
            lines[1]["completion"]
                .as_str()
                .unwrap()
                .starts_with(r#"{"tool":"tally.balances","args":{}}"#)
        );
        assert!(
            lines[0]["prompt"]
                .as_str()
                .unwrap()
                .ends_with(crate::prompt::ASSISTANT_TURN)
        );
        assert_eq!(lines[3]["completion"], r#"{"answer":"Hello."}<|im_end|>"#);
    }

    #[test]
    fn the_export_is_exactly_what_the_phone_sends_in_either_style() {
        use crate::prompt::PromptStyle;
        let file = file();
        for style in [PromptStyle::Stock, PromptStyle::FineTuned] {
            let budget = Budget::DEFAULT.styled(style);
            let jsonl = export_jsonl(&file, budget).unwrap();
            for (line, case) in jsonl.lines().zip(&file.cases) {
                let line: serde_json::Value = serde_json::from_str(line).unwrap();
                // The phone's `Plane` builds this prompt, from the same call.
                let sent = route_prompt(
                    case.scope().unwrap(),
                    &case.turns().unwrap(),
                    &case.question,
                    budget,
                );
                assert_eq!(line["prompt"], sent.text, "{} ({style:?})", case.id);
            }
            let coached = jsonl.contains("Rules:") && jsonl.contains("Examples:");
            assert_eq!(coached, style == PromptStyle::Stock, "{style:?}");
        }
        // And the default is the phone's: the stock prompt, not the compact one.
        let default = export_jsonl(&file, Budget::DEFAULT).unwrap();
        assert_eq!(
            default,
            export_jsonl(&file, Budget::DEFAULT.styled(PromptStyle::Stock)).unwrap()
        );
    }

    #[test]
    fn a_refusal_in_a_cases_history_is_not_in_its_exported_prompt() {
        let file = EvalFile::parse(
            r#"{"version":1,"scenario":"s","cases":[
              {"id":"r","question":"then show my tasks","history":[
                 {"user":"add milk to my list","call":{"tool":"none"},"answer":""},
                 {"user":"what is on today?","call":{"tool":"agenda.upcoming","args":{"range":"today"}},"headline":"1 event today","answer":"One."}],
               "expect":{"tool":"tasks.list","args":{"view":"today"}}}]}"#,
        )
        .unwrap();
        let jsonl = export_jsonl(&file, Budget::DEFAULT).unwrap();
        assert!(jsonl.contains("what is on today?"));
        assert!(!jsonl.contains("add milk"));
    }

    /// The committed fixture, as a test reads it.
    fn committed() -> EvalFile {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/assist/eval-cases.json"
        );
        EvalFile::parse(&std::fs::read_to_string(path).expect("the fixture is committed"))
            .expect("the committed fixture is valid")
    }

    #[test]
    fn the_committed_fixture_covers_the_whole_registry_and_the_three_kinds_of_route() {
        let file = committed();
        assert!(file.cases.len() >= 50, "{} cases", file.cases.len());
        let mut tools = std::collections::BTreeSet::new();
        let (mut none, mut answers, mut follow_ups, mut scoped) = (0, 0, 0, 0);
        for case in &file.cases {
            match &case.expect {
                Expect::Answer { .. } => answers += 1,
                Expect::Call(call) if call.tool == "none" => none += 1,
                Expect::Call(call) => {
                    tools.insert(call.tool.clone());
                }
            }
            follow_ups += usize::from(!case.history.is_empty());
            scoped += usize::from(case.scope.is_some());
        }
        let registered: std::collections::BTreeSet<String> = crate::tool::TOOLS
            .iter()
            .map(|spec| spec.name.to_owned())
            .collect();
        assert_eq!(
            tools, registered,
            "every tool has a case, and no case names another"
        );
        assert!(none >= 4 && answers >= 2 && follow_ups >= 4 && scoped >= 5);
        // Writes are a later wave, and the model must say no tool fits today.
        assert!(
            file.cases
                .iter()
                .any(|case| case.question.starts_with("Add a task"))
        );
    }

    #[test]
    fn every_committed_case_is_sayable_under_the_grammar_its_own_prompt_offers() {
        let file = committed();
        for case in &file.cases {
            let prompt = case.prompt(Budget::DEFAULT).unwrap();
            let grammar = crate::grammar::check::Grammar::parse(&route_gbnf(&prompt.tools));
            let expected = case.expected_json().unwrap();
            assert!(grammar.accepts(&expected), "{}: {expected}", case.id);
        }
    }

    #[test]
    fn every_committed_prompt_fits_the_budget_and_never_mentions_locker() {
        let file = committed();
        for case in &file.cases {
            let prompt = case.prompt(Budget::DEFAULT).unwrap();
            assert!(
                prompt.tokens <= Budget::DEFAULT.route_limit(),
                "{}: {}",
                case.id,
                prompt.tokens
            );
            assert!(
                prompt.text.ends_with(crate::prompt::ASSISTANT_TURN),
                "{}",
                case.id
            );
            assert!(
                !prompt.text.to_lowercase().contains("locker"),
                "{}",
                case.id
            );
            assert_eq!(
                prompt.tools.len(),
                crate::tool::TOOLS.len(),
                "{}: the full list fits",
                case.id
            );
        }
    }

    #[test]
    fn the_oracle_scores_the_committed_fixture_perfectly() {
        let file = committed();
        let oracle = OracleModel::new(file.oracle_routes().unwrap());
        let report = run_routing(&oracle, &file, Budget::DEFAULT).unwrap();
        assert_eq!(report.exact(), report.total(), "{report}");
        // And the same cases fail a model that says `none` to everything, so
        // the harness can tell a router from a refuser.
        let refuser = OracleModel::new([]);
        let report = run_routing(&refuser, &file, Budget::DEFAULT).unwrap();
        assert!(report.exact() < report.total() / 4, "{report}");
    }

    #[test]
    fn the_committed_fixtures_questions_are_distinct_and_short() {
        let file = committed();
        let mut seen = std::collections::BTreeSet::new();
        for case in &file.cases {
            assert!(
                seen.insert(case.question.as_str()),
                "{}: a question is asked twice",
                case.id
            );
            assert!(
                case.question.chars().count() <= crate::prompt::USER_MAX,
                "{}",
                case.id
            );
        }
    }

    #[test]
    fn a_fixture_that_names_locker_or_an_unknown_tool_does_not_parse() {
        for bad in [
            r#"{"id":"x","question":"q","scope":"locker","expect":{"tool":"none"}}"#,
            r#"{"id":"x","question":"q","expect":{"tool":"locker.items"}}"#,
            r#"{"id":"x","question":"q","expect":{"tool":"tasks.list","args":{"view":"never"}}}"#,
        ] {
            let text = format!(r#"{{"version":1,"scenario":"s","cases":[{bad}]}}"#);
            assert!(EvalFile::parse(&text).is_err(), "{bad}");
        }
        let twice = r#"{"version":1,"scenario":"s","cases":[
            {"id":"x","question":"q","expect":{"tool":"none"}},
            {"id":"x","question":"r","expect":{"tool":"none"}}]}"#;
        assert!(EvalFile::parse(twice).is_err());
    }
}
