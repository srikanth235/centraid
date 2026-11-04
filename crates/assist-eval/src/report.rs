//! THE REPORT: a JSON document for machines and a short text summary for people.
//!
//! The numbers `score.py` reports are kept under its names and rules: session strict pass, turn pass (all turns),
//! clean turn pass (a session's turns up to and including its first failure; later turns are downstream of it),
//! wrong-write rate, pass by gold type and by tag, loop and cap turns. New in this report are
//! tool accuracy, accuracy per argument class, fail rate by constraint count and the per-app slices. The README of
//! this crate lists every difference from the Python scorer.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::args::ArgClass;
use crate::run::{SessionResult, TurnResult};
use crate::source::Exclusion;

/// `k` of `n`, with its 95% Wilson interval.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Rate {
    pub k: usize,
    pub n: usize,
    /// `k / n`, 0 when `n` is 0.
    pub rate: f64,
    pub ci95: [f64; 2],
}

fn ratio(k: usize, n: usize) -> f64 {
    if n == 0 { 0.0 } else { k as f64 / n as f64 }
}

/// The Wilson score interval, as `score.py` `wilson`.
#[must_use]
pub fn wilson(k: usize, n: usize) -> [f64; 2] {
    if n == 0 {
        return [0.0, 0.0];
    }
    let (z, n_f) = (1.96_f64, n as f64);
    let p = k as f64 / n_f;
    let denom = 1.0 + z * z / n_f;
    let centre = (p + z * z / (2.0 * n_f)) / denom;
    let half = z * (p * (1.0 - p) / n_f + z * z / (4.0 * n_f * n_f)).sqrt() / denom;
    [(centre - half).max(0.0), (centre + half).min(1.0)]
}

impl Rate {
    #[must_use]
    pub fn of(k: usize, n: usize) -> Self {
        Self {
            k,
            n,
            rate: ratio(k, n),
            ci95: wilson(k, n),
        }
    }

    fn pct(&self) -> String {
        if self.n == 0 {
            "–".to_owned()
        } else {
            format!("{}/{} = {:.1}%", self.k, self.n, 100.0 * self.rate)
        }
    }
}

/// Accuracy of one argument class over the turns that state it.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct ArgRate {
    pub right: usize,
    /// Turns whose reference states the class and can be compared.
    pub scored: usize,
    /// Turns whose reference states it but names a row the runtime never showed.
    pub unscorable: usize,
    pub rate: f64,
    pub ci95: [f64; 2],
}

/// Fail rate at one constraint count.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Bucket {
    pub turns: usize,
    pub failed: usize,
    pub fail_rate: f64,
    /// Over the clean turns only (no earlier failure in the session), the steer-by number.
    pub clean_turns: usize,
    pub clean_failed: usize,
    pub clean_fail_rate: f64,
}

/// The measures of one slice of turns.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Slice {
    pub turns: usize,
    pub turn_pass: Rate,
    pub clean_turn_pass: Rate,
    pub tool_accuracy: Rate,
    /// The model's last call names the act a reference call names (reads collapse; a write is its tool and verb).
    pub tool_name_accuracy: Rate,
    pub arguments: BTreeMap<String, ArgRate>,
    /// `0`, `1`, `2`, `3`, `4+`, and `0-1` (the census's "k<=1").
    pub by_constraints: BTreeMap<&'static str, Bucket>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Overall {
    /// Sessions scored.
    pub sessions: usize,
    /// Sessions in the set, those left out included.
    pub set_sessions: usize,
    pub session_pass: Rate,
    /// Sessions not blocked by a logged runtime issue.
    pub session_pass_unblocked: Rate,
    pub wrong_write: Rate,
    pub loop_turns: usize,
    pub cap_turns: usize,
    pub think_cut_steps: usize,
    pub engine_errors: usize,
    pub not_run_turns: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    pub id: String,
    pub turn: usize,
    pub user: String,
    pub gold_type: String,
    pub got: String,
    pub constraints: usize,
    pub problems: Vec<String>,
    pub calls: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// What was scored: the model file and the set.
    pub model: String,
    pub set: String,
    pub overall: Overall,
    /// Sessions of the set that were not asked, and why: a subset result must not read as the whole set.
    pub excluded: Vec<Exclusion>,
    #[serde(flatten)]
    pub all: Slice,
    /// Turn pass by the type of the first accepted gold.
    pub by_gold_type: BTreeMap<String, Rate>,
    pub by_tag: BTreeMap<String, Rate>,
    pub by_app: BTreeMap<String, AppSlice>,
    pub failed: Vec<Failure>,
}

/// An app's slice of turns, and the sessions that never leave it.
#[derive(Debug, Clone, Serialize)]
pub struct AppSlice {
    #[serde(flatten)]
    pub slice: Slice,
    /// Sessions whose every turn is in this app alone.
    pub single_app_session_pass: Rate,
}

/// The turns of one session that count as clean: up to and including the first failure.
fn clean_count(turns: &[TurnResult]) -> usize {
    let first = turns.iter().position(|t| !t.pass).unwrap_or(turns.len());
    (first + 1).min(turns.len())
}

struct Row<'a> {
    turn: &'a TurnResult,
    clean: bool,
}

fn slice(rows: &[Row<'_>]) -> Slice {
    let mut out = Slice {
        turns: rows.len(),
        turn_pass: Rate::of(rows.iter().filter(|r| r.turn.pass).count(), rows.len()),
        ..Slice::default()
    };
    let clean: Vec<&Row<'_>> = rows.iter().filter(|r| r.clean).collect();
    out.clean_turn_pass = Rate::of(clean.iter().filter(|r| r.turn.pass).count(), clean.len());
    out.tool_accuracy = Rate::of(rows.iter().filter(|r| r.turn.tool_ok).count(), rows.len());
    out.tool_name_accuracy = Rate::of(
        rows.iter().filter(|r| r.turn.tool_name_ok).count(),
        rows.len(),
    );
    for class in ArgClass::ALL {
        let word = class.word();
        let count = |label: &str| {
            rows.iter()
                .filter(|r| r.turn.args.get(word).is_some_and(|v| v == label))
                .count()
        };
        let (right, wrong, unscorable) = (count("right"), count("wrong"), count("unscorable"));
        out.arguments.insert(
            word.to_owned(),
            ArgRate {
                right,
                scored: right + wrong,
                unscorable,
                rate: ratio(right, right + wrong),
                ci95: wilson(right, right + wrong),
            },
        );
    }
    let mut add = |label: &'static str, keep: &dyn Fn(usize) -> bool| {
        let in_bucket: Vec<&Row<'_>> = rows.iter().filter(|r| keep(r.turn.constraints)).collect();
        let failed = in_bucket.iter().filter(|r| !r.turn.pass).count();
        let clean: Vec<&&Row<'_>> = in_bucket.iter().filter(|r| r.clean).collect();
        let clean_failed = clean.iter().filter(|r| !r.turn.pass).count();
        out.by_constraints.insert(
            label,
            Bucket {
                turns: in_bucket.len(),
                failed,
                fail_rate: ratio(failed, in_bucket.len()),
                clean_turns: clean.len(),
                clean_failed,
                clean_fail_rate: ratio(clean_failed, clean.len()),
            },
        );
    };
    add("0", &|k| k == 0);
    add("1", &|k| k == 1);
    add("2", &|k| k == 2);
    add("3", &|k| k == 3);
    add("4+", &|k| k >= 4);
    add("0-1", &|k| k <= 1);
    out
}

/// Aggregate a run.
#[must_use]
pub fn build(model: &str, set: &str, sessions: &[SessionResult], excluded: &[Exclusion]) -> Report {
    let mut rows: Vec<Row<'_>> = Vec::new();
    for session in sessions {
        let clean = clean_count(&session.turns);
        rows.extend(session.turns.iter().enumerate().map(|(i, turn)| Row {
            turn,
            clean: i < clean,
        }));
    }
    let turns: Vec<&TurnResult> = rows.iter().map(|r| r.turn).collect();
    let passed = sessions.iter().filter(|s| s.pass()).count();
    let unblocked: Vec<&SessionResult> = sessions.iter().filter(|s| !s.blocked).collect();
    let mut by_gold_type: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut by_tag: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for session in sessions {
        for turn in &session.turns {
            let held = by_gold_type.entry(turn.gold_type.clone()).or_default();
            held.0 += usize::from(turn.pass);
            held.1 += 1;
            for tag in turn
                .tags
                .iter()
                .chain(&session.tags)
                .collect::<std::collections::BTreeSet<_>>()
            {
                let held = by_tag.entry(tag.clone()).or_default();
                held.0 += usize::from(turn.pass);
                held.1 += 1;
            }
        }
    }
    let mut by_app: BTreeMap<String, AppSlice> = BTreeMap::new();
    let apps: std::collections::BTreeSet<&String> =
        turns.iter().flat_map(|t| t.apps.iter()).collect();
    for app in apps {
        let in_app: Vec<Row<'_>> = rows
            .iter()
            .filter(|r| r.turn.apps.contains(app))
            .map(|r| Row {
                turn: r.turn,
                clean: r.clean,
            })
            .collect();
        let single: Vec<&SessionResult> = sessions
            .iter()
            .filter(|s| {
                !s.turns.is_empty()
                    && s.turns
                        .iter()
                        .all(|t| t.apps.len() == 1 && &t.apps[0] == app)
            })
            .collect();
        by_app.insert(
            app.clone(),
            AppSlice {
                slice: slice(&in_app),
                single_app_session_pass: Rate::of(
                    single.iter().filter(|s| s.pass()).count(),
                    single.len(),
                ),
            },
        );
    }
    let failed = sessions
        .iter()
        .flat_map(|s| {
            s.turns
                .iter()
                .enumerate()
                .filter(|(_, t)| !t.pass)
                .map(move |(i, t)| Failure {
                    id: s.id.clone(),
                    turn: i + 1,
                    user: t.user.clone(),
                    gold_type: t.gold_type.clone(),
                    got: t.ending.clone(),
                    constraints: t.constraints,
                    problems: t.problems.clone(),
                    calls: t.calls.clone(),
                })
        })
        .collect();
    Report {
        model: model.to_owned(),
        set: set.to_owned(),
        excluded: excluded.to_vec(),
        overall: Overall {
            sessions: sessions.len(),
            set_sessions: sessions.len() + excluded.len(),
            session_pass: Rate::of(passed, sessions.len()),
            session_pass_unblocked: Rate::of(
                unblocked.iter().filter(|s| s.pass()).count(),
                unblocked.len(),
            ),
            wrong_write: Rate::of(turns.iter().filter(|t| t.wrong_write).count(), turns.len()),
            loop_turns: turns.iter().filter(|t| t.ending == "loop").count(),
            cap_turns: turns.iter().filter(|t| t.ending == "cap").count(),
            think_cut_steps: turns.iter().map(|t| t.think_cut).sum(),
            engine_errors: sessions.iter().filter(|s| s.error.is_some()).count(),
            not_run_turns: turns.iter().filter(|t| !t.run).count(),
        },
        all: slice(&rows),
        by_gold_type: by_gold_type
            .into_iter()
            .map(|(k, (a, b))| (k, Rate::of(a, b)))
            .collect(),
        by_tag: by_tag
            .into_iter()
            .map(|(k, (a, b))| (k, Rate::of(a, b)))
            .collect(),
        by_app,
        failed,
    }
}

fn args_line(slice: &Slice) -> String {
    ArgClass::ALL
        .iter()
        .map(|class| {
            let a = slice.arguments[class.word()];
            if a.scored == 0 {
                format!("{} –", class.word())
            } else {
                format!(
                    "{} {:.1}% ({}/{})",
                    class.word(),
                    100.0 * a.rate,
                    a.right,
                    a.scored
                )
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The short summary people read.
#[must_use]
pub fn text(report: &Report) -> String {
    let o = &report.overall;
    let a = &report.all;
    let mut out = format!("# {} on {}\n\n", report.model, report.set);
    out += &format!(
        "Scored:           {} of {} sessions{}\n",
        o.sessions,
        o.set_sessions,
        if report.excluded.is_empty() {
            String::new()
        } else {
            format!(
                " ({} left out, listed in the JSON report)",
                report.excluded.len()
            )
        }
    );
    out += &format!("Session pass:     {}\n", o.session_pass.pct());
    out += &format!("Turn pass:        {}\n", a.turn_pass.pct());
    out += &format!(
        "Clean turn pass:  {}  (turns up to each session's first failure)\n",
        a.clean_turn_pass.pct()
    );
    out += &format!(
        "Tool accuracy:    {}  (the turn ended in the act gold wants)\n",
        a.tool_accuracy.pct()
    );
    out += &format!(
        "Tool name:        {}  (last call names a reference act)\n",
        a.tool_name_accuracy.pct()
    );
    out += &format!("Arguments:        {}\n", args_line(a));
    out += &format!("Wrong writes:     {}\n", o.wrong_write.pct());
    out += "\nFail rate by constraints (all turns | clean turns)\n";
    for label in ["0", "1", "2", "3", "4+", "0-1"] {
        let b = a.by_constraints[label];
        out += &format!(
            "  {label:>3}  {:>5.1}% of {:<5} | {:>5.1}% of {}\n",
            100.0 * b.fail_rate,
            b.turns,
            100.0 * b.clean_fail_rate,
            b.clean_turns
        );
    }
    out += "\nBy app (turn pass | tool | arguments)\n";
    for (app, s) in &report.by_app {
        out += &format!(
            "  {app:<8} {} | {:.0}% | {}\n",
            s.slice.turn_pass.pct(),
            100.0 * s.slice.tool_accuracy.rate,
            args_line(&s.slice)
        );
    }
    out += &format!(
        "\nloop turns {}, cap turns {}, think_cut steps {}, engine errors {}, turns not run {}\n",
        o.loop_turns, o.cap_turns, o.think_cut_steps, o.engine_errors, o.not_run_turns
    );
    out += &format!(
        "{} failed turns (all in the JSON report)\n",
        report.failed.len()
    );
    out
}
