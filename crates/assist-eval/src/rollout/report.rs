//! ROLLOUT REPORTS: pass rate per grid cell, per tag, per constraint count and per argument class, and the comparison
//! of two reports (before and after a second round).
//!
//! Counted over each rollout's turns up to and including its first failure ([`Rollout::clean`]): a later turn is
//! downstream of the failure and says nothing about its own cell. A rate is `passes / samples`; beside it a cell
//! says how many distinct turns it holds, how many some sample solved (`solved`, pass@k) and how many were solved by
//! one sample and failed by another (`mixed`): those are the turns a model is unsteady on.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::{Rollout, Sampling};
use crate::args::{ArgClass, bucket};
use crate::report::{ArgRate, Rate, wilson};

/// One slice of turns.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct CellRate {
    /// Passing samples over samples of the turns in the slice.
    pub rate: Rate,
    /// Distinct turns (a session's turn, however many samples reached it).
    pub turns: usize,
    /// Distinct turns at least one sample passed.
    pub solved: usize,
    /// Distinct turns one sample passed and another failed.
    pub mixed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolloutReport {
    pub model: String,
    pub set: String,
    #[serde(default)]
    pub sampling: Option<Sampling>,
    pub sessions: usize,
    pub rollouts: usize,
    /// Rollouts whose every turn passed.
    pub session_pass: Rate,
    /// Sessions at least one rollout passed whole (pass@k).
    pub session_pass_at_k: Rate,
    /// All turns of the slice together.
    pub turn_pass: CellRate,
    /// Rollouts the engine failed in: their later turns are not counted.
    pub engine_errors: usize,
    /// `tool/kind/verb` ([`crate::args::cell_of`]).
    pub by_cell: BTreeMap<String, CellRate>,
    /// The turn's and its session's tags (datagen's `outcome:…`, `reference:…`, `pair:…`).
    pub by_tag: BTreeMap<String, CellRate>,
    /// `0`, `1`, `2`, `3`, `4+`.
    pub by_constraints: BTreeMap<String, CellRate>,
    pub by_app: BTreeMap<String, CellRate>,
    /// Per argument class, over the turns that state it.
    pub arguments: BTreeMap<String, ArgRate>,
}

/// Samples of distinct turns, by turn.
#[derive(Default)]
struct Acc(BTreeMap<(String, usize), (usize, usize)>);

impl Acc {
    fn add(&mut self, session: &str, turn: usize, pass: bool) {
        let held = self.0.entry((session.to_owned(), turn)).or_default();
        held.0 += usize::from(pass);
        held.1 += 1;
    }

    fn finish(&self) -> CellRate {
        let passed: usize = self.0.values().map(|v| v.0).sum();
        let samples: usize = self.0.values().map(|v| v.1).sum();
        CellRate {
            rate: Rate::of(passed, samples),
            turns: self.0.len(),
            solved: self.0.values().filter(|v| v.0 > 0).count(),
            mixed: self.0.values().filter(|v| v.0 > 0 && v.0 < v.1).count(),
        }
    }
}

fn finish(groups: BTreeMap<String, Acc>) -> BTreeMap<String, CellRate> {
    groups.into_iter().map(|(k, v)| (k, v.finish())).collect()
}

/// Aggregate rollouts.
#[must_use]
pub fn build(
    model: &str,
    set: &str,
    sampling: Option<Sampling>,
    rollouts: &[Rollout],
) -> RolloutReport {
    let mut all = Acc::default();
    let (mut cells, mut tags, mut constraints, mut apps) = (
        BTreeMap::<String, Acc>::new(),
        BTreeMap::<String, Acc>::new(),
        BTreeMap::<String, Acc>::new(),
        BTreeMap::<String, Acc>::new(),
    );
    let mut args: BTreeMap<&'static str, (usize, usize, usize)> = BTreeMap::new();
    let sessions: BTreeSet<&str> = rollouts.iter().map(|r| r.result.id.as_str()).collect();
    let mut passed_any: BTreeSet<&str> = BTreeSet::new();
    for rollout in rollouts {
        let id = rollout.result.id.as_str();
        if rollout.result.pass() {
            passed_any.insert(id);
        }
        for (i, turn) in rollout
            .result
            .turns
            .iter()
            .take(rollout.clean())
            .enumerate()
        {
            if !turn.run {
                continue;
            }
            all.add(id, i, turn.pass);
            cells
                .entry(turn.cell.clone())
                .or_default()
                .add(id, i, turn.pass);
            for tag in turn
                .tags
                .iter()
                .chain(&rollout.result.tags)
                .collect::<BTreeSet<_>>()
            {
                tags.entry(tag.clone()).or_default().add(id, i, turn.pass);
            }
            constraints
                .entry(bucket(turn.constraints).to_owned())
                .or_default()
                .add(id, i, turn.pass);
            for app in &turn.apps {
                apps.entry(app.clone()).or_default().add(id, i, turn.pass);
            }
            for class in ArgClass::ALL {
                let held = args.entry(class.word()).or_default();
                match turn.args.get(class.word()).map(String::as_str) {
                    Some("right") => held.0 += 1,
                    Some("wrong") => held.1 += 1,
                    Some("unscorable") => held.2 += 1,
                    _ => {}
                }
            }
        }
    }
    let whole = rollouts.iter().filter(|r| r.result.pass()).count();
    RolloutReport {
        model: model.to_owned(),
        set: set.to_owned(),
        sampling,
        sessions: sessions.len(),
        rollouts: rollouts.len(),
        session_pass: Rate::of(whole, rollouts.len()),
        session_pass_at_k: Rate::of(passed_any.len(), sessions.len()),
        turn_pass: all.finish(),
        engine_errors: rollouts.iter().filter(|r| r.result.error.is_some()).count(),
        by_cell: finish(cells),
        by_tag: finish(tags),
        by_constraints: finish(constraints),
        by_app: finish(apps),
        arguments: args
            .into_iter()
            .map(|(class, (right, wrong, unscorable))| {
                let scored = right + wrong;
                (
                    class.to_owned(),
                    ArgRate {
                        right,
                        scored,
                        unscorable,
                        rate: if scored == 0 {
                            0.0
                        } else {
                            right as f64 / scored as f64
                        },
                        ci95: wilson(right, scored),
                    },
                )
            })
            .collect(),
    }
}

fn pct(rate: &Rate) -> String {
    if rate.n == 0 {
        "–".to_owned()
    } else {
        format!("{:.1}% ({}/{})", 100.0 * rate.rate, rate.k, rate.n)
    }
}

fn section(out: &mut String, title: &str, rows: &BTreeMap<String, CellRate>) {
    out.push_str(&format!("\n{title}\n"));
    let mut sorted: Vec<_> = rows.iter().collect();
    sorted.sort_by(|a, b| a.1.rate.rate.total_cmp(&b.1.rate.rate).then(a.0.cmp(b.0)));
    for (name, cell) in sorted {
        out.push_str(&format!(
            "  {name:<34} {:<22} turns {} solved {} mixed {}\n",
            pct(&cell.rate),
            cell.turns,
            cell.solved,
            cell.mixed
        ));
    }
}

/// The summary people read: the worst cells first.
#[must_use]
pub fn text(report: &RolloutReport) -> String {
    let mut out = format!(
        "model {}\nset {}\n{} sessions, {} rollouts{}\nsession pass {}   pass@k {}   turn pass {}\n",
        report.model,
        report.set,
        report.sessions,
        report.rollouts,
        report
            .sampling
            .as_ref()
            .map_or_else(String::new, |s| format!(
                " (k={}, temperature {}, top-p {}, seed {}, grammar {}, tools {})",
                s.k, s.temperature, s.top_p, s.seed, s.grammar, s.tools
            )),
        pct(&report.session_pass),
        pct(&report.session_pass_at_k),
        pct(&report.turn_pass.rate),
    );
    section(&mut out, "by constraints", &report.by_constraints);
    section(&mut out, "by cell (worst first)", &report.by_cell);
    out.push_str("\narguments\n");
    for (class, a) in &report.arguments {
        out.push_str(&format!(
            "  {class:<10} {}/{} = {:.1}%\n",
            a.right,
            a.scored,
            100.0 * a.rate
        ));
    }
    out
}

/// One measure before and after.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Delta {
    pub before: Option<Rate>,
    pub after: Option<Rate>,
    /// `after - before` in percentage points; `None` when either side has no samples.
    pub points: Option<f64>,
    /// The two 95% intervals do not overlap: the change is not noise at this size.
    pub clear: bool,
}

fn delta(before: Option<Rate>, after: Option<Rate>) -> Delta {
    let live = |r: &Option<Rate>| r.filter(|r| r.n > 0);
    let (b, a) = (live(&before), live(&after));
    let points = b.zip(a).map(|(b, a)| 100.0 * (a.rate - b.rate));
    let clear = b
        .zip(a)
        .is_some_and(|(b, a)| a.ci95[0] > b.ci95[1] || b.ci95[0] > a.ci95[1]);
    Delta {
        before,
        after,
        points,
        clear,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Comparison {
    pub before: String,
    pub after: String,
    pub overall: BTreeMap<String, Delta>,
    pub by_cell: BTreeMap<String, Delta>,
    pub by_tag: BTreeMap<String, Delta>,
    pub by_constraints: BTreeMap<String, Delta>,
    pub by_app: BTreeMap<String, Delta>,
    pub arguments: BTreeMap<String, Delta>,
}

fn join<T>(
    before: &BTreeMap<String, T>,
    after: &BTreeMap<String, T>,
    rate: impl Fn(&T) -> Rate,
) -> BTreeMap<String, Delta> {
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|key| {
            (
                key.clone(),
                delta(before.get(key).map(&rate), after.get(key).map(&rate)),
            )
        })
        .collect()
}

fn arg_rate(a: &ArgRate) -> Rate {
    Rate {
        k: a.right,
        n: a.scored,
        rate: a.rate,
        ci95: a.ci95,
    }
}

/// Before and after a second round, measure by measure. A cell only one side has is there with the other `None`.
#[must_use]
pub fn compare(before: &RolloutReport, after: &RolloutReport) -> Comparison {
    let cell = |c: &CellRate| c.rate;
    Comparison {
        before: before.model.clone(),
        after: after.model.clone(),
        overall: [
            (
                "session_pass",
                delta(Some(before.session_pass), Some(after.session_pass)),
            ),
            (
                "session_pass_at_k",
                delta(
                    Some(before.session_pass_at_k),
                    Some(after.session_pass_at_k),
                ),
            ),
            (
                "turn_pass",
                delta(Some(before.turn_pass.rate), Some(after.turn_pass.rate)),
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect(),
        by_cell: join(&before.by_cell, &after.by_cell, cell),
        by_tag: join(&before.by_tag, &after.by_tag, cell),
        by_constraints: join(&before.by_constraints, &after.by_constraints, cell),
        by_app: join(&before.by_app, &after.by_app, cell),
        arguments: join(&before.arguments, &after.arguments, arg_rate),
    }
}

fn delta_rows(out: &mut String, title: &str, rows: &BTreeMap<String, Delta>) {
    out.push_str(&format!("\n{title}\n"));
    let mut sorted: Vec<_> = rows.iter().collect();
    // the biggest losses first, then the biggest gains: a regression must not hide at the bottom
    sorted.sort_by(|a, b| {
        a.1.points
            .unwrap_or(0.0)
            .total_cmp(&b.1.points.unwrap_or(0.0))
            .then(a.0.cmp(b.0))
    });
    for (name, d) in sorted {
        let side = |r: &Option<Rate>| r.as_ref().map_or_else(|| "–".to_owned(), pct);
        out.push_str(&format!(
            "  {name:<34} {:<22} → {:<22} {}{}\n",
            side(&d.before),
            side(&d.after),
            d.points
                .map_or_else(|| "n/a".to_owned(), |p| format!("{p:+.1} pts")),
            if d.clear { " *" } else { "" },
        ));
    }
}

/// The comparison people read (`*` marks a change whose intervals do not overlap).
#[must_use]
pub fn compare_text(c: &Comparison) -> String {
    let mut out = format!("before {}\nafter  {}\n", c.before, c.after);
    delta_rows(&mut out, "overall", &c.overall);
    delta_rows(&mut out, "by constraints", &c.by_constraints);
    delta_rows(&mut out, "arguments", &c.arguments);
    delta_rows(&mut out, "by cell", &c.by_cell);
    out
}
