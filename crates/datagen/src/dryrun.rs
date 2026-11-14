//! `datagen plan`: the dry run of a build, before any message is written.
//!
//! It draws the intents of every world and solves them through the runtime (stages 2 and 3, the part of a build that
//! costs time), then runs the mix's selection and tally over what was planned, with no message, no render, no tokenizer and
//! no model call. What the build would then hold is read off the typed intents:
//!
//! * the sessions and turns each split would hold, every share as realised against its target, the cells and the
//!   (kind, field) pairs of train under their floor;
//! * what `datagen drift` would count as under the floor of coverage over the chosen reference calls of train and val
//!   (the drift code itself, as a library): its tools, arguments and kinds by name for train, counts only for val;
//! * the prompts the first round of writing would need, sessions over the batch size, rounded up;
//! * the tokens, as turns times a figure per turn, which is an estimate and says so.
//!
//! ALL OF IT IS BEFORE MESSAGE ATTRITION: no message has been written, checked or read back, so no session or turn is lost
//! to the writer, the checks or the read-back. Two things a render gives are estimated: a session's duplicate key (the
//! build hashes the words and the gold; here there are no words, so two sessions with the same gold are one) and its
//! tokens (turns times the figure per turn).
//!
//! Counts only for val and test, and never a word of a prompt: there is none.

use std::collections::BTreeMap;

use anyhow::Result;
use centraid_assist::native::meta::Kind;
use centraid_assist_eval::gold::Session;
use serde::Serialize;

use crate::catalog::Catalog;
use crate::drift::{self, Catalogue};
use crate::grid::Grid;
use crate::mix::{self, Selection};
use crate::preselect;
use crate::render::Features;

/// Tokens a turn comes to, as the first data version measured it: 10.8 million tokens over 8,585 turns.
pub const TOKENS_PER_TURN: usize = 1258;

/// What the plan is asked.
#[derive(Debug, Clone)]
pub struct Settings {
    pub seed: u64,
    /// Worlds per split.
    pub counts: [usize; 3],
    /// Sessions drawn per split: what messages would have to write.
    pub drawn: [usize; 3],
    pub mix: mix::Config,
    pub tokens_per_turn: usize,
    /// Sessions per writer or reader call.
    pub batch: usize,
    /// How many times the targets and floors the writer is given ([`crate::preselect`]); 0 or less writes every session.
    pub headroom: f64,
    /// Worlds drawn and solved at once; the plan is the same for any number.
    pub workers: usize,
    /// Say every dropped turn on stderr.
    pub verbose: bool,
    /// Where each finished world is kept, so a run stopped and started again with the same settings skips them.
    pub checkpoints: Option<std::path::PathBuf>,
}

/// What a split holds.
#[derive(Debug, Clone, Serialize)]
pub struct Held {
    pub split: String,
    pub sessions: usize,
    pub turns: usize,
}

/// An item of the catalogue the chosen sessions show fewer than the floor times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Gap {
    /// `tool`, `argument` or `kind`.
    pub of: String,
    pub name: String,
    pub examples: usize,
}

/// What drift's coverage would count as under the floor.
#[derive(Debug, Clone, Serialize)]
pub struct Coverage {
    pub floor: usize,
    /// Train, by name.
    pub train: Vec<Gap>,
    /// Val, as a count only: the names of a held-out split are not read out.
    pub val: usize,
}

/// The first round's prompts for a split: `sessions` over the batch, rounded up, for each role.
#[derive(Debug, Clone, Serialize)]
pub struct Prompts {
    pub split: String,
    pub sessions: usize,
    pub writer: usize,
    pub reader: usize,
}

/// The plan.
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub seed: u64,
    pub worlds: [usize; 3],
    pub tokens_per_turn: usize,
    pub batch: usize,
    pub headroom: f64,
    /// The draws one world sweeps (`run::draws`): a world keeps at least this many sessions whatever `--sessions` says, so
    /// the sessions drawn per split are the worlds times this, not the sessions asked for.
    pub sweep: usize,
    /// What was drawn and solved, before the mix chose.
    pub planned: Vec<Held>,
    /// What pre-selection chose to write, by split: the sessions the writer and the reader see.
    pub preselected: Vec<Held>,
    /// What the mix chose from those.
    pub chosen: Vec<Held>,
    pub selection: Selection,
    /// The live cells and pairs of train under their floor, by name.
    pub under: Vec<mix::Under>,
    pub coverage: Coverage,
    pub prompts: Vec<Prompts>,
    /// Projected tokens of what was chosen, per split and in all: turns times the figure per turn.
    pub tokens: BTreeMap<String, usize>,
}

fn held(features: &[Features], split: &str, chosen: Option<&[usize]>) -> Held {
    let of: Vec<&Features> = match chosen {
        Some(indices) => indices.iter().map(|i| &features[*i]).collect(),
        None => features.iter().filter(|f| f.split == split).collect(),
    };
    Held {
        split: split.to_owned(),
        sessions: of.len(),
        turns: of.iter().map(|f| f.turns).sum(),
    }
}

/// The tally: the mix over `features`, drift's coverage over the chosen sessions' reference calls (`sessions` is the same
/// list as `features`, one for one), the prompts and the tokens. Pure: nothing is drawn or solved here.
///
/// # Errors
///
/// If the mix fails (a world in two splits).
pub fn tally(
    drawn: &[Features],
    sessions: &[Session],
    settings: &Settings,
    catalogue: &Catalogue,
    kinds: &[&str],
) -> Result<Plan> {
    // what a build writes: the sessions pre-selection keeps, and the mix after the render chooses from those
    let planned_of: Vec<Held> = mix::SPLITS
        .iter()
        .map(|split| held(drawn, split, None))
        .collect();
    let pre = preselect::choose(drawn, &settings.mix, settings.headroom)?;
    let (features, sessions): (Vec<Features>, Vec<Session>) = pre
        .keep
        .iter()
        .map(|i| (drawn[*i].clone(), sessions[*i].clone()))
        .unzip();
    let (features, sessions) = (features.as_slice(), sessions.as_slice());
    // the combinations pre-selection reserved for test are the ones the mix after the render holds out
    let mut after = settings.mix.clone();
    if after.reserved.is_empty() && settings.headroom > 0.0 {
        after.reserved.clone_from(&pre.reserved);
    }
    let selection = mix::mix(features, &after)?;
    let planned = planned_of;
    let mut preselected = Vec::new();
    let mut chosen = Vec::new();
    let mut tokens = BTreeMap::new();
    let mut prompts = Vec::new();
    for split in mix::SPLITS {
        preselected.push(held(features, split, None));
        let got = held(
            features,
            split,
            selection.chosen.get(split).map(Vec::as_slice),
        );
        tokens.insert(split.to_owned(), got.turns * settings.tokens_per_turn);
        // the first round: every session pre-selected is written, in batches
        let n = preselected.last().map_or(0, |p| p.sessions);
        prompts.push(Prompts {
            split: split.to_owned(),
            sessions: n,
            writer: n.div_ceil(settings.batch.max(1)),
            reader: n.div_ceil(settings.batch.max(1)),
        });
        chosen.push(got);
    }
    tokens.insert("all".to_owned(), tokens.values().sum());
    let floor = settings.mix.floor[0].max(1);
    let in_split = |split: &str| -> Vec<Session> {
        selection
            .chosen
            .get(split)
            .into_iter()
            .flatten()
            .map(|i| sessions[*i].clone())
            .collect()
    };
    let gaps = |split: &str| -> Vec<Gap> {
        drift::coverage(&in_split(split), catalogue, kinds, floor)
            .into_iter()
            .map(|g| Gap {
                of: g.of.to_owned(),
                name: g.name,
                examples: g.examples,
            })
            .collect()
    };
    let coverage = Coverage {
        floor,
        train: gaps("train"),
        val: gaps("val").len(),
    };
    Ok(Plan {
        seed: settings.seed,
        worlds: settings.counts,
        tokens_per_turn: settings.tokens_per_turn,
        batch: settings.batch,
        headroom: settings.headroom,
        sweep: 0,
        planned,
        preselected,
        chosen,
        under: mix::under_floor(&selection, &settings.mix),
        selection,
        coverage,
        prompts,
        tokens,
    })
}

impl Plan {
    /// The plan in words: counts for every split, names only for train.
    #[must_use]
    pub fn text(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        let _ = writeln!(
            out,
            "plan: seed {}; {}/{}/{} worlds (train/val/test); intents drawn and solved through the runtime, no message written, no render, no model call",
            self.seed, self.worlds[0], self.worlds[1], self.worlds[2]
        );
        let _ = writeln!(
            out,
            "ALL OF THIS IS BEFORE MESSAGE ATTRITION: no session or turn is lost here to the writer, the checks or the read-back. The duplicate key (words and gold in a build) is the gold alone here, and tokens are an estimate."
        );
        if self.sweep > 0 {
            let _ = writeln!(
                out,
                "each world sweeps {} draws and keeps at least that many sessions whatever --sessions says, so the sessions drawn are the worlds times that, not the sessions asked for",
                self.sweep
            );
        }
        if self.headroom > 0.0 {
            let wanted: Vec<String> = self
                .selection
                .reports
                .iter()
                .map(|r| {
                    format!(
                        "{}",
                        (r.target_sessions as f64 * self.headroom).ceil() as usize
                    )
                })
                .collect();
            let _ = writeln!(
                out,
                "pre-selection at headroom {}: before any message the mix chooses {} sessions in train, {} in val and {} in test ({} wanted); only those go to the writer and the reader, and the mix after the render chooses from what survives",
                self.headroom,
                self.preselected.first().map_or(0, |p| p.sessions),
                self.preselected.get(1).map_or(0, |p| p.sessions),
                self.preselected.get(2).map_or(0, |p| p.sessions),
                wanted.join("/"),
            );
        } else {
            let _ = writeln!(
                out,
                "no pre-selection (headroom 0): every session drawn goes to the writer and the reader"
            );
        }
        for ((planned, pre), chosen) in self.planned.iter().zip(&self.preselected).zip(&self.chosen)
        {
            let report = self
                .selection
                .reports
                .iter()
                .find(|r| r.split == planned.split);
            let _ = writeln!(
                out,
                "\n== {}: {} sessions and {} turns planned, {} sessions pre-selected; the mix chooses {} sessions and {} turns{}",
                planned.split,
                planned.sessions,
                planned.turns,
                pre.sessions,
                chosen.sessions,
                chosen.turns,
                report.map_or(String::new(), |r| format!(
                    " (wanted {})",
                    r.target_sessions
                ))
            );
            let Some(report) = report else { continue };
            for share in &report.shares {
                let total: f64 = share.lines.iter().map(|l| l.realised).sum();
                let cells: Vec<String> = share
                    .lines
                    .iter()
                    .map(|l| {
                        format!(
                            "{} {:.1}% (target {:.1}%)",
                            l.name,
                            100.0 * l.realised / total.max(1.0),
                            100.0 * l.requested / total.max(1.0)
                        )
                    })
                    .collect();
                let _ = writeln!(
                    out,
                    "  {} per {}: {}",
                    share.share,
                    share.unit,
                    cells.join(", ")
                );
            }
            let by_turns: Vec<String> = report
                .by_turns
                .iter()
                .map(|l| {
                    format!(
                        "{} {:.1}% (target {:.1}%)",
                        l.name,
                        100.0 * l.realised / (chosen.sessions.max(1) as f64),
                        100.0 * l.requested / (chosen.sessions.max(1) as f64)
                    )
                })
                .collect();
            let _ = writeln!(out, "  session length: {}", by_turns.join(", "));
            for cap in &report.caps {
                let _ = writeln!(
                    out,
                    "  {}: {} of {} (at most {:.0}%)",
                    cap.name,
                    cap.realised,
                    cap.base,
                    100.0 * cap.cap
                );
            }
            let cells = report
                .cells
                .iter()
                .filter(|c| c.realised < c.target as usize)
                .count();
            let fields = report
                .fields
                .iter()
                .filter(|c| c.realised < c.target as usize)
                .count();
            let _ = writeln!(
                out,
                "  below the floor or the uniform target: {cells} of {} live cells, {fields} of {} live (kind, field) pairs",
                report.cells.len(),
                report.fields.len()
            );
        }
        let under_cells: Vec<String> = self
            .under
            .iter()
            .filter(|u| u.of == "cell")
            .map(ToString::to_string)
            .collect();
        let under_fields: Vec<String> = self
            .under
            .iter()
            .filter(|u| u.of == "field")
            .map(ToString::to_string)
            .collect();
        let _ = writeln!(
            out,
            "\ntrain cells under their floor: {}{}",
            under_cells.len(),
            if under_cells.is_empty() {
                String::new()
            } else {
                format!(": {}", under_cells.join("; "))
            }
        );
        let _ = writeln!(
            out,
            "train (kind, field) pairs under their floor: {}{}",
            under_fields.len(),
            if under_fields.is_empty() {
                String::new()
            } else {
                format!(": {}", under_fields.join("; "))
            }
        );
        let _ = writeln!(
            out,
            "\ndrift coverage over the chosen reference calls, at the floor of {}: train {} item(s), val {} item(s) (val by count only)",
            self.coverage.floor,
            self.coverage.train.len(),
            self.coverage.val
        );
        for gap in &self.coverage.train {
            let _ = writeln!(out, "  {} {}: {}", gap.of, gap.name, gap.examples);
        }
        let _ = writeln!(
            out,
            "\nfirst round of prompts (sessions pre-selected over the batch of {}, rounded up; the reader's come after the writer's answers):",
            self.batch
        );
        for p in &self.prompts {
            let _ = writeln!(
                out,
                "  {}: {} sessions: {} writer prompts, {} reader prompts",
                p.split, p.sessions, p.writer, p.reader
            );
        }
        let _ = writeln!(
            out,
            "\nprojected tokens (an estimate: chosen turns x {} per turn): train {}, val {}, test {}, all {}",
            self.tokens_per_turn,
            self.tokens["train"],
            self.tokens["val"],
            self.tokens["test"],
            self.tokens["all"]
        );
        out
    }
}

/// The sessions a plan holds, as features and as sessions, from the records `run::generate` kept.
///
/// # Errors
///
/// If a record is not a session or its scenario cannot be read.
pub fn features_of_kept(
    kept: &[crate::run::Kept],
    tokens_per_turn: usize,
) -> Result<(Vec<Features>, Vec<Session>)> {
    let mut features = Vec::new();
    let mut sessions = Vec::new();
    for k in kept {
        let scenario: crate::intent::Scenario =
            serde_json::from_value(k.record["scenario"].clone())?;
        let turns = k.record["turns"].as_array().map_or(0, Vec::len);
        features.push(crate::render::features_of(
            &k.record,
            &scenario,
            turns,
            k.split.name(),
            turns * tokens_per_turn,
        ));
        let mut record = k.record.clone();
        record["split"] = serde_json::json!(k.split.name());
        sessions.push(serde_json::from_value(record)?);
    }
    Ok((features, sessions))
}

/// Draw and solve the intents of every world, then tally. The slow part is the first: worlds on `workers` threads, each
/// kept as a checkpoint when `checkpoints` is set.
///
/// # Errors
///
/// If a world cannot be seeded or the mix fails.
pub fn plan(
    settings: &Settings,
    catalog: &Catalog,
    mistakes: Vec<crate::mistakes::Observed>,
) -> Result<Plan> {
    let per = |total: usize, worlds: usize| total.div_ceil(worlds.max(1));
    let config = crate::run::Config {
        seed: settings.seed,
        counts: settings.counts,
        per_world: [
            per(settings.drawn[0], settings.counts[0]),
            per(settings.drawn[1], settings.counts[1]),
            per(settings.drawn[2], settings.counts[2]),
        ],
        cell_limit: None,
        mistakes,
    };
    let scratch = tempfile::tempdir()?;
    let progress = |p: &crate::run::Progress| {
        eprintln!(
            "[{}/{}] {}: {} sessions{}",
            p.done,
            p.of,
            p.id,
            p.sessions,
            if p.resumed {
                " (from a checkpoint)"
            } else {
                ""
            }
        );
    };
    let generated = crate::run::generate_opts(
        &config,
        catalog,
        scratch.path(),
        &crate::world::World::generate,
        &crate::run::Options {
            workers: settings.workers,
            verbose: settings.verbose,
            checkpoints: settings.checkpoints.as_deref(),
            progress: Some(&progress),
        },
    )?;
    let (features, sessions) = features_of_kept(&generated.kept, settings.tokens_per_turn)?;
    let grid = Grid::build(catalog);
    let mut settings = settings.clone();
    settings.mix.live = grid.live().iter().map(ToString::to_string).collect();
    settings.mix.live_fields = crate::fields::live_labels(catalog, &grid);
    let catalogue = Catalogue::of_mode(crate::plan::tools_mode())?;
    let kinds: Vec<&str> = Kind::ALL.iter().map(|k| k.name()).collect();
    let mut plan = tally(&features, &sessions, &settings, &catalogue, &kinds)?;
    plan.sweep = crate::run::draws(catalog, &grid).len();
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalogue() -> Catalogue {
        let schema = vec![
            json!({"type": "function", "function": {"name": "find", "parameters": {"type": "object",
                "properties": {"kind": {"type": "string"}, "text": {"type": "string"}}, "required": []}}}),
            json!({"type": "function", "function": {"name": "answer", "parameters": {"type": "object",
                "properties": {"rows": {"type": "string"}}, "required": []}}}),
        ];
        Catalogue::from_schema(&["find".to_owned(), "answer".to_owned()], &schema)
    }

    /// A session of one turn in `cell`, of `world`, with the reference calls `calls`.
    fn session(
        id: &str,
        split: &str,
        world: &str,
        cell: &str,
        calls: &[(&str, serde_json::Value)],
    ) -> (Features, Session) {
        let f = Features {
            id: id.to_owned(),
            split: split.to_owned(),
            world: world.to_owned(),
            app: "tasks".to_owned(),
            apps: vec!["tasks".to_owned()],
            cells: vec![cell.to_owned()],
            turns: 1,
            key: id.to_owned(),
            tokens: 1,
            outcomes: vec!["done".to_owned()],
            actions: vec!["read".to_owned()],
            refs: vec!["filters".to_owned()],
            impossible: vec![false],
            kinds: vec!["task".to_owned()],
            ..Features::default()
        };
        let s: Session = serde_json::from_value(json!({
            "id": id, "world": world, "today": "2026-01-01", "me": "A", "split": split,
            "turns": [{"user": "u", "gold": [],
                "ref": calls.iter().map(|(tool, args)| json!({"tool": tool, "args": args})).collect::<Vec<_>>()}],
        }))
        .expect("session");
        (f, s)
    }

    #[test]
    fn the_tally_counts_what_the_mix_chooses_names_train_only_and_says_it_is_before_attrition() {
        let mut features = Vec::new();
        let mut sessions = Vec::new();
        // train: ten sessions of one cell, two of another that is under the floor of three; val and test: four each
        for i in 0..10 {
            let (f, s) = session(
                &format!("train-{i}"),
                "train",
                "train-0",
                "find/task/read",
                &[
                    ("find", json!({"kind": "task", "text": "x"})),
                    ("answer", json!({"rows": "@1"})),
                ],
            );
            features.push(f);
            sessions.push(s);
        }
        for i in 0..2 {
            let (f, s) = session(
                &format!("train-c{i}"),
                "train",
                "train-0",
                "compute/task/count",
                &[("find", json!({"kind": "task"}))],
            );
            features.push(f);
            sessions.push(s);
        }
        for (split, world) in [("val", "val-0"), ("test", "test-0")] {
            for i in 0..4 {
                let (f, s) = session(
                    &format!("{split}-{i}"),
                    split,
                    world,
                    "find/task/read",
                    &[("find", json!({"kind": "photo"}))],
                );
                features.push(f);
                sessions.push(s);
            }
        }
        let settings = Settings {
            seed: 1,
            counts: [1, 1, 1],
            drawn: [12, 4, 4],
            mix: mix::Config {
                targets: [12, 4, 4],
                live: vec!["find/task/read".to_owned(), "compute/task/count".to_owned()],
                floor: [3, 0, 0],
                field_floor: [0; 3],
                subsets: Vec::new(),
                reserve: 0,
                ..mix::Config::default()
            },
            tokens_per_turn: 100,
            batch: 5,
            headroom: 0.0,
            workers: 1,
            verbose: false,
            checkpoints: None,
        };
        let plan = tally(
            &features,
            &sessions,
            &settings,
            &catalogue(),
            &["task", "photo"],
        )
        .expect("tallies");
        // the planned and the chosen sessions and turns of every split
        let of = |list: &[Held], split: &str| {
            let h = list.iter().find(|h| h.split == split).expect("split");
            (h.sessions, h.turns)
        };
        assert_eq!(of(&plan.planned, "train"), (12, 12));
        assert_eq!(of(&plan.chosen, "train"), (12, 12));
        assert_eq!(of(&plan.chosen, "val"), (4, 4));
        // projected tokens are turns times the figure per turn
        assert_eq!(plan.tokens["train"], 1200);
        assert_eq!(plan.tokens["all"], 2000);
        // the first round: sessions over the batch, rounded up, for each role
        let prompts: Vec<(usize, usize)> =
            plan.prompts.iter().map(|p| (p.writer, p.reader)).collect();
        assert_eq!(prompts, [(3, 3), (1, 1), (1, 1)]);
        // the cell of two turns is under the floor of three, and is named with its count and the floor
        assert_eq!(
            plan.under,
            vec![mix::Under {
                of: "cell",
                name: "compute/task/count".to_owned(),
                realised: 2,
                floor: 3
            }]
        );
        // drift's coverage over the chosen reference calls at the floor of 3: train shows the kind task ten times and never
        // the kind photo; `find.text` is on the ten sessions of the first cell, `answer.rows` too
        let names: Vec<String> = plan
            .coverage
            .train
            .iter()
            .map(|g| format!("{} {}", g.of, g.name))
            .collect();
        assert!(names.contains(&"kind photo".to_owned()), "{names:?}");
        assert!(!names.contains(&"kind task".to_owned()), "{names:?}");
        assert!(
            !names.contains(&"argument find.text".to_owned()),
            "{names:?}"
        );
        assert_eq!(plan.coverage.floor, 3);
        // val is counted, never named: it shows only the kind photo, so the kind task and the tools it lacks are under
        assert!(plan.coverage.val > 0);
        let text = plan.text();
        assert!(text.contains("BEFORE MESSAGE ATTRITION"));
        assert!(text.contains("train cells under their floor: 1: cell compute/task/count: 2 of 3"));
        assert!(text.contains("train: 12 sessions: 3 writer prompts, 3 reader prompts"));
        assert!(text.contains("projected tokens (an estimate"));
        let named_lines = text
            .lines()
            .filter(|l| {
                l.starts_with("  kind ") || l.starts_with("  tool ") || l.starts_with("  argument ")
            })
            .count();
        assert_eq!(
            named_lines,
            plan.coverage.train.len(),
            "only train's gaps are named"
        );
        // the json holds the same and is what `plan.json` is
        let json = serde_json::to_value(&plan).expect("json");
        assert_eq!(json["tokens"]["all"], 2000);
    }

    #[test]
    fn the_prompts_are_counted_on_the_preselected_sessions_not_on_all_that_were_drawn() {
        let mut features = Vec::new();
        let mut sessions = Vec::new();
        for (split, world, n) in [
            ("train", "train-0", 60),
            ("val", "val-0", 20),
            ("test", "test-0", 20),
        ] {
            for i in 0..n {
                let (f, s) = session(
                    &format!("{split}-{i}"),
                    split,
                    world,
                    "find/task/read",
                    &[("find", json!({"kind": "task"}))],
                );
                features.push(f);
                sessions.push(s);
            }
        }
        let settings = Settings {
            seed: 1,
            counts: [1, 1, 1],
            drawn: [60, 20, 20],
            mix: mix::Config {
                targets: [10, 4, 4],
                live: vec!["find/task/read".to_owned()],
                floor: [0; 3],
                field_floor: [0; 3],
                subsets: Vec::new(),
                reserve: 0,
                ..mix::Config::default()
            },
            tokens_per_turn: 100,
            batch: 5,
            headroom: 1.5,
            workers: 1,
            verbose: false,
            checkpoints: None,
        };
        let plan =
            tally(&features, &sessions, &settings, &catalogue(), &["task"]).expect("tallies");
        let of = |list: &[Held]| list.iter().map(|h| h.sessions).collect::<Vec<_>>();
        // 60, 20 and 20 drawn; 1.5 times the targets pre-selected; the mix chooses its targets from those
        assert_eq!(of(&plan.planned), [60, 20, 20]);
        assert_eq!(of(&plan.preselected), [15, 6, 6]);
        assert_eq!(of(&plan.chosen), [10, 4, 4]);
        // the prompts are the pre-selected sessions over the batch, rounded up
        let writers: Vec<usize> = plan.prompts.iter().map(|p| p.writer).collect();
        assert_eq!(writers, [3, 2, 2]);
        let sessions: Vec<usize> = plan.prompts.iter().map(|p| p.sessions).collect();
        assert_eq!(sessions, [15, 6, 6]);
        let text = plan.text();
        assert!(text.contains("pre-selection at headroom 1.5"), "{text}");
        assert!(text.contains("train: 15 sessions: 3 writer prompts, 3 reader prompts"));
    }
}
