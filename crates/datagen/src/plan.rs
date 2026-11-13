//! STAGE 3, THE PLANNER AND EXECUTE: deterministic reference calls for each intent, run through
//! the real `centraid-assist` runtime against the world's vault, with gold recorded as the
//! runtime's effect.
//!
//! "Solvable" means three things at once. The reference calls run without an unplanned error. The
//! rows (or the value) the runtime returns are exactly what the world's own index says the intent
//! selects ([`crate::facts`]), so a runtime misreading is not recorded as gold. And a by-name
//! write found one row. An intent that fails any of these is dropped and the reason counted.
//!
//! Calls use names, `@k` handles read back from each response, compact date expressions and the
//! decided shapes (`find` then `answer rows=@k`; `compute` then `answer value=@k`; `find` then
//! `do`/`edit rows=@k`). They never use a prompt's `#n`, `dates[i]` or a `$key`: the user's text
//! is a placeholder here, and M3 writes the real one.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use centraid_assist::native::Flags;
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::effect::{Effect, Ending, NetDiff, turn_effect};
use centraid_nativetools::{dates, vaultio};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::catalog::Catalog;
use crate::facts::Facts;
use crate::grid::{Cell, cell_of};
use crate::intent::{
    Change, Intent, Measure, Outcome, Scenario, Selector, Target, TurnIntent, VerbArg,
};
use crate::world::World;

/// The person a `decline not_found` turn asks about: nobody in any world has this name.
pub const NOT_FOUND_NAME: &str = "Zzyzx Quillfeather";

/// Rows an `answer` shows before the rest are counted.
const ROW_CAP: usize = 12;

/// Why an intent was dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Drop {
    /// The runtime returned rows the constraints do not select.
    Overmatch,
    /// The runtime left out rows the constraints select.
    Undermatch,
    /// The runtime and the world's index disagree on a value.
    Value,
    /// A name that should have found one row found several.
    Ambiguous,
    /// A name that should have found a row found none.
    NotFound,
    /// A write selected more or fewer rows than one.
    NotUnique,
    /// More rows than an answer shows.
    TooMany,
    /// A call the plan did not expect to fail failed.
    Error,
    /// The write changed nothing.
    Noop,
    /// The runtime ended the turn some other way than the plan.
    Ending,
    /// The world has no row to draw this intent from.
    NoTarget,
}

impl Drop {
    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::Overmatch => "overmatch",
            Self::Undermatch => "undermatch",
            Self::Value => "value",
            Self::Ambiguous => "ambiguous",
            Self::NotFound => "not_found",
            Self::NotUnique => "not_unique",
            Self::TooMany => "too_many",
            Self::Error => "error",
            Self::Noop => "noop",
            Self::Ending => "ending",
            Self::NoTarget => "no_target",
        }
    }
}

/// A dropped turn: the reason and a line saying what happened.
#[derive(Debug, Clone, Serialize)]
pub struct Dropped {
    pub turn: usize,
    pub cell: Cell,
    pub why: Drop,
    pub detail: String,
}

/// The tools block the phone sends the model: the one the model record names (`crates/assist/model.json`, read by
/// `centraid_assist::record`, the way the phone reads it). It is the one source: the prompts the records are rendered with
/// and the compiler that reads their think both take it from here, so what the model is trained on is what the phone shows.
#[must_use]
pub fn tools_mode() -> ToolsMode {
    ToolsMode::parse(&centraid_assist::record::record().current.tools_mode).unwrap_or_default()
}

/// The flags a session runs with: the phone's defaults and the model record's tools block.
fn flags() -> Flags {
    Flags {
        tools: tools_mode(),
        ..Flags::default()
    }
}

/// One reference call.
#[derive(Debug, Clone)]
struct Step {
    tool: &'static str,
    args: Vec<(&'static str, String)>,
    bad: bool,
    /// The family of the mistake, for a bad call ([`crate::mistakes`]).
    mistake: Option<&'static str>,
    /// The result of this step is what the turn's later turns lean on.
    primary: bool,
}

fn step(tool: &'static str, args: Vec<(&'static str, String)>) -> Step {
    Step {
        tool,
        args,
        bad: false,
        mistake: None,
        primary: false,
    }
}

/// What a turn must come to.
#[derive(Debug, Clone)]
enum Check {
    Rows {
        want: BTreeSet<String>,
        ordered: Option<Vec<String>>,
        /// Index of the `find` whose rows are compared.
        at: usize,
    },
    Count(usize),
    /// Two values set side by side: each side's figure by currency, and the step that computed it.
    Compare {
        sides: [(usize, BTreeMap<String, f64>); 2],
    },
    Value {
        /// Figure per currency (`""` for a figure with no unit).
        want: BTreeMap<String, f64>,
        grouped: bool,
    },
    Ask(BTreeSet<String>),
    Decline(String),
    /// An edit the runtime refuses because a health store states the row: the turn ends on the
    /// refusal, which names the store.
    Refused,
    Write(BTreeSet<String>),
    Created(String),
    Undo,
    /// The earlier turn's result, shown again.
    Same,
}

struct Plan {
    steps: Vec<Step>,
    check: Check,
    /// The keys of the rows this turn leaves for a later turn to lean on.
    keys: BTreeSet<String>,
    kind: String,
}

/// The steps that find a write's rows, the `rows` argument, their keys and their kind.
type Resolved = (Vec<Step>, String, BTreeSet<String>, String);

/// What a solved turn leaves behind for the turns after it.
#[derive(Debug, Clone, Default)]
struct Left {
    handle: Option<String>,
    keys: BTreeSet<String>,
    kind: String,
    /// `#n` of the row the turn created.
    made: Option<String>,
}

/// A solved scenario, or the prefix of it that solved.
#[derive(Debug)]
pub struct Solution {
    /// The session in the shape `assist_eval::gold::Session` reads, with the typed scenario beside it.
    pub record: Option<Value>,
    pub kept: usize,
    pub asked: usize,
    pub dropped: Vec<Dropped>,
    /// The cell and constraint count of each kept turn.
    pub turns: Vec<(Cell, usize)>,
    /// What the runtime made of each kept turn's message before any call: the `block` that
    /// precedes it in the user turn (`vault:`, `dates:` ...) and whether it read as a retraction.
    pub heard: Vec<Heard>,
}

/// What the runtime's grounding made of a user message.
#[derive(Debug, Clone, Default)]
pub struct Heard {
    pub block: String,
    /// The message took the request back (`phrases::is_retraction`): the turn ends before any call.
    pub ended: bool,
}

/// One world, seeded once; each scenario runs on a private copy of its vault.
pub struct WorldRun<'a> {
    pub world: &'a World,
    pub facts: Facts,
    catalog: &'a Catalog,
    scratch: PathBuf,
    base: PathBuf,
    /// World key to vault id, and back.
    ids: BTreeMap<String, String>,
    keys: BTreeMap<String, String>,
    copies: usize,
    pub me: String,
    pub today_at: String,
    /// Whether the runtime gives an empty `find` a handle, so `answer rows=@k` can end a read that
    /// found nothing. The regroup adds it; the runtime this was built against may not have it.
    pub empty_reads: bool,
    /// Refused read calls from a model's rollouts (`--mistakes`); a repair turn of the same tool shows one of these
    /// in place of a constructed mistake.
    pub observed: Vec<crate::mistakes::Observed>,
}

/// A session on a private copy of a world's vault ([`WorldRun::open`]).
pub struct Live {
    pub session: centraid_assist::native::session::Session,
    vault: PathBuf,
}

impl std::ops::Drop for Live {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut file = self.vault.as_os_str().to_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(file);
        }
    }
}

/// The one time of day every session runs at.
pub const CLOCK: &str = "09:00";

impl<'a> WorldRun<'a> {
    /// Seed `world` into `scratch`.
    ///
    /// # Errors
    ///
    /// If the vault refuses a command.
    pub fn seed(world: &'a World, catalog: &'a Catalog, scratch: &Path) -> Result<Self> {
        std::fs::create_dir_all(scratch)?;
        let base = scratch.join(format!("{}.vault", world.id()));
        let report = world.seed_into(&base)?;
        let mut ids = BTreeMap::new();
        let mut keys = BTreeMap::new();
        for (key, row) in report.as_object().into_iter().flatten() {
            if let Some(id) = row["id"].as_str() {
                ids.insert(key.clone(), id.to_owned());
                keys.insert(id.to_owned(), key.clone());
            }
        }
        let today_at = format!("{}T{CLOCK}", world.today);
        let empty_reads = {
            let probe = scratch.join(format!("{}-probe.vault", world.id()));
            vaultio::copy_vault(&base, &probe).map_err(anyhow::Error::msg)?;
            let now = dates::parse_now(&today_at).map_err(anyhow::Error::msg)?;
            let mut live = vaultio::open_session(&probe, now, &world.persona.me, flags())
                .map_err(anyhow::Error::msg)?;
            live.user("");
            let found = live.call_text(&call_xml(
                "find",
                &Map::from_iter([
                    ("kind".to_owned(), json!("task")),
                    ("where".to_owned(), json!("priority >= 99")),
                ]),
            ));
            found["effect"]["result"].is_string()
        };
        Ok(Self {
            world,
            facts: Facts::of(world, catalog),
            catalog,
            scratch: scratch.to_path_buf(),
            base,
            ids,
            keys,
            copies: 0,
            me: world.persona.me.clone(),
            today_at,
            empty_reads,
            observed: Vec::new(),
        })
    }

    /// Run `scenario` turn by turn. A turn that cannot be solved ends the session there: the turns
    /// before it are kept as a shorter session and the drop is recorded.
    ///
    /// # Errors
    ///
    /// If the vault cannot be copied or opened; an unsolvable intent is a drop, not an error.
    pub fn solve(&mut self, scenario: &Scenario) -> Result<Solution> {
        self.solve_with(scenario, None)
    }

    /// [`Self::solve`] with the user's own words for each turn in place of the placeholders. The
    /// runtime grounds each message (names it finds, dates it reads), so what `#n` numbers a row
    /// gets can differ from the placeholder run: the reference calls are written afresh against
    /// the real message, and gold is whatever the runtime's effect is.
    ///
    /// # Errors
    ///
    /// As [`Self::solve`].
    pub fn solve_with(
        &mut self,
        scenario: &Scenario,
        messages: Option<&[String]>,
    ) -> Result<Solution> {
        self.copies += 1;
        let vault = self
            .scratch
            .join(format!("{}-run{}.vault", self.world.id(), self.copies));
        vaultio::copy_vault(&self.base, &vault).map_err(anyhow::Error::msg)?;
        let now = dates::parse_now(&self.today_at).map_err(anyhow::Error::msg)?;
        let mut live =
            vaultio::open_session(&vault, now, &self.me, flags()).map_err(anyhow::Error::msg)?;
        let mut created: Vec<String> = Vec::new();
        let mut left: Vec<Left> = Vec::new();
        let mut out_turns: Vec<Value> = Vec::new();
        let mut heard: Vec<Heard> = Vec::new();
        let mut cells = Vec::new();
        let mut dropped = Vec::new();
        for (index, turn) in scenario.turns.iter().enumerate() {
            let cell = cell_of(turn);
            let placeholder = messages
                .and_then(|m| m.get(index).cloned())
                .unwrap_or_else(|| placeholder(&scenario.id, index));
            let planned = self.plan(turn, &left);
            let outcome = planned.and_then(|plan| {
                self.execute(&mut live, &plan, &placeholder, &mut created, &left, turn)
            });
            match outcome {
                Ok((value, leftover, constraints, said)) => {
                    out_turns.push(value);
                    heard.push(said);
                    left.push(leftover);
                    cells.push((cell, constraints));
                }
                Err((why, detail)) => {
                    dropped.push(Dropped {
                        turn: index,
                        cell,
                        why,
                        detail,
                    });
                    break;
                }
            }
        }
        drop(live);
        for suffix in ["", "-wal", "-shm"] {
            let mut file = vault.as_os_str().to_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(file);
        }
        let kept = out_turns.len();
        let record = (kept > 0).then(|| {
            let mut tags: Vec<String> = scenario.tags.clone();
            if kept < scenario.turns.len() {
                tags.push("truncated".to_owned());
            }
            let mut scenario = scenario.clone();
            scenario.turns.truncate(kept);
            json!({
                "id": scenario.id,
                "world": scenario.world,
                "today": self.today_at,
                "me": self.me,
                "tags": tags,
                "turns": out_turns,
                "scenario": scenario,
            })
        });
        Ok(Solution {
            record,
            kept,
            asked: scenario.turns.len(),
            dropped,
            turns: cells,
            heard,
        })
    }

    /// A session on a private copy of the world's vault, as the eval and the phone open one: the clock at the world's
    /// `today`, no turn taken yet. The copy is removed when the [`Live`] is dropped.
    ///
    /// # Errors
    ///
    /// If the vault cannot be copied or opened.
    pub fn open(&mut self) -> Result<Live> {
        self.copies += 1;
        let vault = self
            .scratch
            .join(format!("{}-live{}.vault", self.world.id(), self.copies));
        vaultio::copy_vault(&self.base, &vault).map_err(anyhow::Error::msg)?;
        let now = dates::parse_now(&self.today_at).map_err(anyhow::Error::msg)?;
        let session =
            vaultio::open_session(&vault, now, &self.me, flags()).map_err(anyhow::Error::msg)?;
        Ok(Live { session, vault })
    }

    // ---------------------------------------------------------------- planning

    /// The `find` for a selector: any link or anchor lookups first, then the selection itself.
    /// Returns the index of the selection step.
    fn select_steps(
        &self,
        sel: &Selector,
        steps: &mut Vec<Step>,
        tool: &'static str,
        extra: Vec<(&'static str, String)>,
    ) -> usize {
        let mut linked = None;
        for (is_link, lookup) in [(true, &sel.link), (false, &sel.anchor)] {
            let Some(lookup) = lookup else { continue };
            let at = steps.len();
            steps.push(step(
                "find",
                vec![("kind", lookup.kind.clone()), ("name", lookup.name.clone())],
            ));
            if is_link {
                linked = Some(at);
            }
        }
        let mut args: Vec<(&'static str, String)> = vec![("kind", sel.kind.clone())];
        if let Some(name) = &sel.name {
            args.push(("name", name.clone()));
        }
        if !sel.filters.is_empty() {
            let clauses: Vec<String> = sel.filters.iter().map(|f| f.clause()).collect();
            args.push(("where", clauses.join(" and ")));
        }
        if let Some(period) = &sel.period {
            args.push(("when", period.when()));
        }
        if let Some(at) = linked {
            args.push(("linked_to", format!("§s{at}")));
        }
        if let Some(turn) = sel.within {
            args.push(("within", format!("§t{turn}")));
        }
        if let Some((field, desc)) = &sel.order {
            args.push((
                "order",
                format!("{field} {}", if *desc { "desc" } else { "asc" }),
            ));
        }
        if let Some(limit) = sel.limit {
            args.push(("limit", limit.to_string()));
        }
        args.extend(extra);
        let at = steps.len();
        steps.push(step(tool, args));
        at
    }

    fn within_keys<'l>(&self, sel: &Selector, left: &'l [Left]) -> Option<&'l BTreeSet<String>> {
        sel.within.and_then(|t| left.get(t)).map(|l| &l.keys)
    }

    fn expected(&self, sel: &Selector, left: &[Left]) -> Vec<String> {
        self.facts
            .select(sel, self.within_keys(sel, left))
            .iter()
            .map(|r| r.key.clone())
            .collect()
    }

    fn plan(&self, turn: &TurnIntent, left: &[Left]) -> Result<Plan, (Drop, String)> {
        let mut plan = self.plan_inner(turn, left)?;
        if turn.outcome == Outcome::Repair {
            self.apply_repair(&mut plan, turn);
        }
        Ok(plan)
    }

    /// Put a call the runtime refuses ahead of the right one: a mistake of one of the families of
    /// [`crate::mistakes`], chosen by the turn so a rebuild chooses the same one.
    fn apply_repair(&self, plan: &mut Plan, turn: &TurnIntent) {
        use crate::mistakes::{Mistake, for_read, for_write, pick};
        let seed = format!("{:?}|{}", turn.intent, plan.kind);
        let reads = plan.steps.last().is_some_and(|s| s.tool == "answer");
        if reads {
            let computes = plan.steps.iter().any(|s| s.tool == "compute");
            let tool = if computes { "compute" } else { "find" };
            let seen: Vec<Mistake> = self
                .observed
                .iter()
                .filter(|o| o.tool == tool)
                .cloned()
                .map(Mistake::from)
                .collect();
            let built = for_read(self.catalog, &plan.kind, computes);
            let chosen = pick(&seen, &seed).or_else(|| pick(&built, &seed));
            let Some(mistake) = chosen else { return };
            let mut bad = step(mistake.tool, mistake.args.clone());
            bad.bad = true;
            bad.mistake = Some(mistake.family);
            for s in &mut plan.steps {
                for (_, v) in &mut s.args {
                    *v = shift_markers(v, 1);
                }
            }
            if let Check::Rows { at, .. } = &mut plan.check {
                *at += 1;
            }
            plan.steps.insert(0, bad);
            return;
        }
        let last = plan.steps.len().saturating_sub(1);
        let Some(real) = plan.steps.get(last) else {
            return;
        };
        let built = for_write(self.catalog, &plan.kind, real.tool, &real.args);
        let Some(mistake) = pick(&built, &seed) else {
            return;
        };
        let mut bad = step(mistake.tool, mistake.args.clone());
        bad.bad = true;
        bad.mistake = Some(mistake.family);
        plan.steps.insert(last, bad);
    }

    fn plan_inner(&self, turn: &TurnIntent, left: &[Left]) -> Result<Plan, (Drop, String)> {
        let no = |why: Drop, detail: &str| Err((why, detail.to_owned()));
        match &turn.intent {
            Intent::Read { sel } => {
                let want = self.expected(sel, left);
                if want.len() > ROW_CAP {
                    return no(Drop::TooMany, &format!("{} rows", want.len()));
                }
                let mut steps = Vec::new();
                let at = self.select_steps(sel, &mut steps, "find", vec![]);
                steps[at].primary = true;
                let ordered = sel.order.is_some().then(|| want.clone());
                steps.push(step("answer", vec![("rows", format!("§s{at}"))]));
                let keys: BTreeSet<String> = want.iter().cloned().collect();
                Ok(Plan {
                    steps,
                    check: Check::Rows {
                        want: keys.clone(),
                        ordered,
                        at,
                    },
                    keys,
                    kind: sel.kind.clone(),
                })
            }
            Intent::Count { sel } => {
                let want = self.expected(sel, left);
                let mut steps = Vec::new();
                let at =
                    self.select_steps(sel, &mut steps, "compute", vec![("op", "count".to_owned())]);
                steps[at].primary = true;
                steps.push(step("answer", vec![("value", format!("§s{at}"))]));
                Ok(Plan {
                    steps,
                    check: Check::Count(want.len()),
                    keys: want.into_iter().collect(),
                    kind: sel.kind.clone(),
                })
            }
            Intent::Measure { measure } => {
                let (steps_in, at, want, keys) = self.measure(measure, left)?;
                let mut steps = steps_in;
                steps[at].primary = true;
                steps.push(step("answer", vec![("value", format!("§s{at}"))]));
                Ok(Plan {
                    steps,
                    check: Check::Value {
                        want,
                        grouped: measure.group.is_some(),
                    },
                    keys,
                    kind: measure.sel.kind.clone(),
                })
            }
            Intent::Compare { a, b } => {
                let (mut steps, at_a, want_a, keys_a) = self.measure(a, left)?;
                let (more, at_b, want_b, _) = self.measure(b, left)?;
                let shift = steps.len();
                for mut s in more {
                    for (_, v) in &mut s.args {
                        *v = shift_markers(v, shift);
                    }
                    steps.push(s);
                }
                let at_b = at_b + shift;
                steps.push(step(
                    "compute",
                    vec![
                        ("op", "compare".to_owned()),
                        ("rows", format!("§s{at_a},§s{at_b}")),
                    ],
                ));
                let at = steps.len() - 1;
                steps[at].primary = true;
                steps.push(step("answer", vec![("value", format!("§s{at}"))]));
                Ok(Plan {
                    steps,
                    check: Check::Compare {
                        sides: [(at_a, want_a), (at_b, want_b)],
                    },
                    keys: keys_a,
                    kind: a.sel.kind.clone(),
                })
            }
            Intent::Write { target, verb, arg } => {
                if verb == "undo" {
                    return Ok(Plan {
                        steps: vec![step("do", vec![("verb", "undo".to_owned())])],
                        check: Check::Undo,
                        keys: BTreeSet::new(),
                        kind: "-".to_owned(),
                    });
                }
                let (mut steps, rows, want, kind) = self.resolve(target, left)?;
                let mut args = vec![("verb", verb.clone()), ("rows", rows)];
                match arg {
                    VerbArg::None => {}
                    VerbArg::When(json) => args.push(("args", format!("to: {json}"))),
                    VerbArg::Choice(choice) => args.push(("args", format!("kind: {choice}"))),
                    VerbArg::Container(link) => {
                        let at = steps.len();
                        steps.push(step(
                            "find",
                            vec![("kind", link.kind.clone()), ("name", link.name.clone())],
                        ));
                        let field = if verb == "remove_from" { "from" } else { "to" };
                        args.push(("args", format!("{field}: §s{at}")));
                    }
                }
                steps.push(step("do", args));
                Ok(Plan {
                    steps,
                    check: Check::Write(want.clone()),
                    keys: want,
                    kind,
                })
            }
            Intent::Edit { target, changes } => {
                let (mut steps, rows, want, kind) = self.resolve(target, left)?;
                steps.push(step(
                    "edit",
                    vec![("rows", rows), ("args", change_lines(changes))],
                ));
                let check = if turn.outcome == Outcome::Decline {
                    Check::Refused
                } else {
                    Check::Write(want.clone())
                };
                Ok(Plan {
                    steps,
                    check,
                    keys: want,
                    kind,
                })
            }
            Intent::Create { kind, fields } => {
                let steps = vec![step(
                    "create",
                    vec![("kind", kind.clone()), ("args", change_lines(fields))],
                )];
                Ok(Plan {
                    steps,
                    check: Check::Created(kind.clone()),
                    keys: BTreeSet::new(),
                    kind: kind.clone(),
                })
            }
            Intent::Recall { turn: from, value } => {
                let Some(earlier) = left.get(*from) else {
                    return no(Drop::NoTarget, "no such earlier turn");
                };
                let arg = if *value { "value" } else { "rows" };
                let mut steps = vec![step("answer", vec![(arg, format!("§t{from}"))])];
                steps[0].primary = true;
                Ok(Plan {
                    steps,
                    check: Check::Same,
                    keys: earlier.keys.clone(),
                    kind: earlier.kind.clone(),
                })
            }
            Intent::Ask { kind, name, .. } => {
                let want: BTreeSet<String> = self
                    .facts
                    .matching(kind, name)
                    .iter()
                    .map(|r| r.key.clone())
                    .collect();
                if want.len() < 2 {
                    return no(Drop::NoTarget, "the name is not shared");
                }
                let steps = vec![
                    {
                        let mut s =
                            step("find", vec![("kind", kind.clone()), ("name", name.clone())]);
                        s.primary = true;
                        s
                    },
                    step(
                        "ask",
                        vec![
                            ("question", format!("Which {kind} do you mean?")),
                            ("options", "§s0".to_owned()),
                        ],
                    ),
                ];
                Ok(Plan {
                    steps,
                    check: Check::Ask(want.clone()),
                    keys: want,
                    kind: kind.clone(),
                })
            }
            Intent::Decline { reason } => {
                let mut steps = Vec::new();
                if reason == "not_found" {
                    steps.push(step(
                        "find",
                        vec![
                            ("kind", "person".to_owned()),
                            ("name", NOT_FOUND_NAME.to_owned()),
                        ],
                    ));
                }
                steps.push(step("decline", vec![("reason", reason.clone())]));
                Ok(Plan {
                    steps,
                    check: Check::Decline(reason.clone()),
                    keys: BTreeSet::new(),
                    kind: "-".to_owned(),
                })
            }
        }
    }

    /// A measure's steps: `(steps, index of the compute, expected value, rows folded)`.
    #[allow(clippy::type_complexity)]
    fn measure(
        &self,
        m: &Measure,
        left: &[Left],
    ) -> Result<(Vec<Step>, usize, BTreeMap<String, f64>, BTreeSet<String>), (Drop, String)> {
        let rows = self.facts.select(&m.sel, self.within_keys(&m.sel, left));
        if rows.is_empty() && m.op != "sum" {
            return Err((Drop::NoTarget, "nothing to fold".to_owned()));
        }
        let want = Facts::fold_units(&m.op, &m.field, &rows);
        let keys: BTreeSet<String> = rows.iter().map(|r| r.key.clone()).collect();
        let mut extra = vec![("op", m.op.clone()), ("field", m.field.clone())];
        if let Some(group) = &m.group {
            extra.push(("group", group.clone()));
        }
        let mut steps = Vec::new();
        let at = self.select_steps(&m.sel, &mut steps, "compute", extra);
        Ok((steps, at, want, keys))
    }

    /// Steps that find the rows a write acts on: `(steps, the rows argument, the keys, the kind)`.
    fn resolve(&self, target: &Target, left: &[Left]) -> Result<Resolved, (Drop, String)> {
        match target {
            Target::Name {
                kind,
                name,
                key,
                trashed,
            } => {
                let mut args = vec![("kind", kind.clone()), ("name", name.clone())];
                if *trashed {
                    args.push(("trashed", "true".to_owned()));
                }
                let mut s = step("find", args);
                s.primary = true;
                Ok((
                    vec![s],
                    "§s0".to_owned(),
                    std::iter::once(key.clone()).collect(),
                    kind.clone(),
                ))
            }
            Target::Select { sel } => {
                let want = self.expected(sel, left);
                if want.len() != 1 {
                    return Err((Drop::NotUnique, format!("{} rows", want.len())));
                }
                let mut steps = Vec::new();
                let at = self.select_steps(sel, &mut steps, "find", vec![]);
                steps[at].primary = true;
                Ok((
                    steps,
                    format!("§s{at}"),
                    want.into_iter().collect(),
                    sel.kind.clone(),
                ))
            }
            Target::Turn { turn, kind } => {
                let Some(earlier) = left.get(*turn) else {
                    return Err((Drop::NoTarget, "no such earlier turn".to_owned()));
                };
                let rows = match &earlier.made {
                    Some(made) => made.clone(),
                    None => format!("§t{turn}"),
                };
                Ok((Vec::new(), rows, earlier.keys.clone(), kind.clone()))
            }
        }
    }

    // --------------------------------------------------------------- execution

    #[allow(clippy::too_many_lines)]
    fn execute(
        &self,
        live: &mut centraid_assist::native::session::Session,
        plan: &Plan,
        placeholder: &str,
        created: &mut Vec<String>,
        left: &[Left],
        turn: &TurnIntent,
    ) -> Result<(Value, Left, usize, Heard), (Drop, String)> {
        let err = |detail: String| (Drop::Error, detail);
        let said = live.user(placeholder);
        let heard = Heard {
            block: said["block"].as_str().unwrap_or_default().to_owned(),
            ended: said.get("ended").is_some_and(Value::is_object),
        };
        let mut responses: Vec<Value> = Vec::new();
        let mut handles: Vec<Option<String>> = Vec::new();
        let mut calls: Vec<Value> = Vec::new();
        for s in &plan.steps {
            let mut args = Map::new();
            for (k, v) in &s.args {
                args.insert(
                    (*k).to_owned(),
                    Value::String(resolve_markers(v, &handles, left)),
                );
            }
            let text = call_xml(s.tool, &args);
            let response = live.call_text(&text);
            let handle = response["effect"]["answer"]["result"]
                .as_str()
                .or_else(|| response["effect"]["result"].as_str())
                .map(str::to_owned);
            handles.push(handle.clone());
            let failed = response["effect"].get("error").is_some();
            if failed
                && !s.bad
                && s.args.iter().any(|(_, v)| v.contains('§'))
                && args
                    .values()
                    .any(|v| v.as_str().is_some_and(|t| t.contains("@0")))
            {
                return Err((Drop::NotFound, "an earlier find matched nothing".to_owned()));
            }
            if failed != s.bad {
                return Err(if s.bad {
                    err(format!("the bad call {} was accepted", s.tool))
                } else {
                    err(format!(
                        "{} refused: {}",
                        s.tool,
                        response["text"]
                            .as_str()
                            .unwrap_or_default()
                            .lines()
                            .next()
                            .unwrap_or_default()
                    ))
                });
            }
            let mut call = json!({"tool": s.tool, "args": args});
            if s.bad {
                call["bad"] = json!(true);
            }
            calls.push(call);
            responses.push(response);
        }
        let effect = turn_effect(&responses);
        let ids_of = |effect_rows: &[String]| -> Vec<String> {
            effect_rows
                .iter()
                .map(|id| self.key_of(id, created))
                .collect()
        };
        let rows_of_step = |at: usize| -> Vec<String> {
            responses[at]["effect"]["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["id"].as_str().map(str::to_owned))
                .map(|id| self.key_of(&id, created))
                .collect()
        };
        // ---- verify against the plan
        let mut made = None;
        match &plan.check {
            Check::Rows { want, ordered, at } => {
                if effect.ending != Ending::Rows {
                    return Err((Drop::Ending, format!("ended in {}", effect.ending.word())));
                }
                let got: BTreeSet<String> = rows_of_step(*at).into_iter().collect();
                compare_sets(want, &got)?;
                let shown: Vec<String> = ids_of(&effect.rows);
                if let Some(order) = ordered
                    && &shown != order
                {
                    return Err((Drop::Value, format!("order {shown:?} want {order:?}")));
                }
            }
            Check::Count(want) => {
                let got = scalar(&effect).ok_or_else(|| (Drop::Ending, "no value".to_owned()))?;
                if (got - *want as f64).abs() > 0.5 {
                    return Err((Drop::Value, format!("count {got} want {want}")));
                }
            }
            Check::Value { want, grouped } => {
                if effect.ending != Ending::Value {
                    return Err((Drop::Ending, format!("ended in {}", effect.ending.word())));
                }
                if !grouped && !want.is_empty() {
                    let got = units(&effect);
                    // the runtime rounds whole-unit figures; money keeps cents
                    let slack: f64 = if is_money(&plan.steps) { 0.02 } else { 0.51 };
                    let same = got.len() == want.len()
                        && want.iter().all(|(u, w)| {
                            got.get(u)
                                .is_some_and(|g| (g - w).abs() <= slack.max(w.abs() * 0.001))
                        });
                    if !same {
                        return Err((Drop::Value, format!("value {got:?} want {want:?}")));
                    }
                }
            }
            Check::Compare { sides } => {
                if effect.ending != Ending::Value {
                    return Err((Drop::Ending, format!("ended in {}", effect.ending.word())));
                }
                // each side is a figure the world's index also computes; the difference between
                // them is the runtime's, and gold records it
                for (at, want) in sides {
                    let got = value_units(&responses[*at]["effect"]["value"]);
                    let slack: f64 = if is_money(&plan.steps) { 0.02 } else { 0.51 };
                    let same = got.len() == want.len()
                        && want.iter().all(|(u, w)| {
                            got.get(u)
                                .is_some_and(|g| (g - w).abs() <= slack.max(w.abs() * 0.001))
                        });
                    if !same {
                        return Err((Drop::Value, format!("side {got:?} want {want:?}")));
                    }
                }
            }
            Check::Ask(want) => {
                if effect.ending != Ending::Ask {
                    return Err((Drop::Ending, format!("ended in {}", effect.ending.word())));
                }
                let got: BTreeSet<String> = ids_of(&effect.options).into_iter().collect();
                if !want.is_subset(&got) && !got.is_subset(want) {
                    return Err((Drop::Value, "the ask lists other rows".to_owned()));
                }
            }
            Check::Decline(reason) => {
                if effect.ending != Ending::Decline || effect.reason.as_deref() != Some(reason) {
                    return Err((Drop::Ending, format!("ended in {}", effect.ending.word())));
                }
            }
            Check::Refused => {
                // the runtime ends the turn on the refusal (reason `out_of_scope`) and records the
                // vault's sentence, which names the store
                let said = responses
                    .last()
                    .and_then(|r| r["effect"]["refusal"]["reason"].as_str())
                    .unwrap_or_default();
                if effect.ending != Ending::Decline
                    || !said.contains(" from ")
                    || !effect.diff.rows.is_empty()
                {
                    return Err((
                        Drop::Ending,
                        format!("ended in {} {said:?}", effect.ending.word()),
                    ));
                }
            }
            Check::Write(want) => {
                if !effect.already.is_empty() {
                    return Err((Drop::Noop, "already so".to_owned()));
                }
                let changed: BTreeSet<String> = effect
                    .diff
                    .rows
                    .iter()
                    .map(|r| self.key_of(&r.id, created))
                    .chain(
                        link_rows(&effect.diff)
                            .iter()
                            .map(|id| self.key_of(id, created)),
                    )
                    .collect();
                if effect.diff.rows.is_empty() && effect.diff.links.is_empty() {
                    return Err((Drop::Noop, "nothing changed".to_owned()));
                }
                if !changed.is_subset(want) && !want.iter().any(|w| changed.contains(w)) {
                    return Err((Drop::Value, format!("changed {changed:?} want {want:?}")));
                }
                // a by-name write found exactly the row it meant
                if let Some(find) = plan
                    .steps
                    .iter()
                    .position(|s| s.primary && s.tool == "find")
                {
                    let found: BTreeSet<String> = rows_of_step(find).into_iter().collect();
                    if found.len() > 1 && plan.steps[find].args.iter().any(|(k, _)| *k == "name") {
                        return Err((
                            Drop::Ambiguous,
                            format!("{} rows answer to the name", found.len()),
                        ));
                    }
                    if !want.is_subset(&found) {
                        return Err((Drop::NotFound, "the name found another row".to_owned()));
                    }
                }
            }
            Check::Created(kind) => {
                let new: Vec<_> = effect
                    .diff
                    .rows
                    .iter()
                    .filter(|r| r.change == "created" && &r.kind == kind)
                    .collect();
                if new.len() != 1 {
                    return Err((Drop::Noop, format!("{} rows created", new.len())));
                }
                created.push(new[0].id.clone());
                let n = responses
                    .iter()
                    .rev()
                    .find_map(|r| {
                        r["effect"]["created"]
                            .as_array()
                            .and_then(|a| a.first())
                            .and_then(|c| c["n"].as_u64())
                    })
                    .map(|n| format!("#{n}"));
                made = n;
            }
            Check::Undo => {
                if effect.diff.rows.is_empty() && effect.diff.links.is_empty() {
                    return Err((Drop::Noop, "nothing undone".to_owned()));
                }
            }
            Check::Same => {}
        }
        // ---- what the next turn can lean on
        let primary = plan
            .steps
            .iter()
            .rposition(|s| s.primary)
            .and_then(|i| handles.get(i).cloned().flatten());
        let handle = if matches!(
            plan.check,
            Check::Rows { .. } | Check::Count(_) | Check::Value { .. }
        ) {
            handles.iter().rev().flatten().next().cloned().or(primary)
        } else {
            primary
        };
        let mut keys = plan.keys.clone();
        if let Check::Created(_) = plan.check {
            keys = std::iter::once(format!("+{}", created.len())).collect();
        }
        let leftover = Left {
            handle,
            keys,
            kind: plan.kind.clone(),
            made,
        };
        let gold = gold_of(&effect, &|id| self.key_of(id, created), turn)
            .map_err(|d| (Drop::Ending, d))?;
        let turn_json = json!({
            "user": placeholder,
            "gold": [gold],
            "ref": calls,
            "tags": tags_with_mistakes(turn, &plan.steps),
        });
        let constraints = {
            let t: centraid_assist_eval::gold::Turn =
                serde_json::from_value(turn_json.clone()).map_err(|e| err(e.to_string()))?;
            centraid_assist_eval::args::turn_constraints(&t)
        };
        let mut turn_json = turn_json;
        turn_json["constraints"] = json!(constraints);
        Ok((turn_json, leftover, constraints, heard))
    }

    /// The world key of a vault id, or `+N` for a row the session created.
    fn key_of(&self, id: &str, created: &[String]) -> String {
        if let Some(key) = self.keys.get(id) {
            return key.clone();
        }
        if let Some(at) = created.iter().position(|c| c == id) {
            return format!("+{}", at + 1);
        }
        id.to_owned()
    }

    #[must_use]
    pub fn catalog(&self) -> &Catalog {
        self.catalog
    }

    /// The vault id of a world key.
    #[must_use]
    pub fn id_of(&self, key: &str) -> Option<&String> {
        self.ids.get(key)
    }
}

/// The user's words are M3's job. Until then each turn's `user` is this marker, which matches no
/// name in any vault and reads as no retraction, so the runtime's grounding sees an empty message.
#[must_use]
pub fn placeholder(session: &str, turn: usize) -> String {
    format!("⟨m3:{session}:t{}⟩", turn + 1)
}

/// Is `user` still a placeholder M3 has not replaced?
#[must_use]
pub fn is_placeholder(user: &str) -> bool {
    user.starts_with("⟨m3:") && user.ends_with('⟩')
}

fn tags_with_mistakes(turn: &TurnIntent, steps: &[Step]) -> Vec<String> {
    let mut tags = tags_of(turn);
    tags.extend(
        steps
            .iter()
            .filter_map(|s| s.mistake)
            .map(|m| format!("mistake:{m}")),
    );
    tags
}

fn tags_of(turn: &TurnIntent) -> Vec<String> {
    vec![
        format!("outcome:{}", turn.outcome.word()),
        format!("reference:{}", turn.reference.word()),
    ]
}

fn is_money(steps: &[Step]) -> bool {
    steps
        .iter()
        .any(|s| s.args.iter().any(|(k, v)| *k == "field" && v == "amount"))
}

fn shift_markers(text: &str, by: usize) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("§s") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + "§s".len()..];
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        match digits.parse::<usize>() {
            Ok(n) => out.push_str(&format!("§s{}", n + by)),
            Err(_) => out.push_str("§s"),
        }
        rest = &tail[digits.len()..];
    }
    out.push_str(rest);
    out
}

fn resolve_markers(text: &str, handles: &[Option<String>], left: &[Left]) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('§') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + '§'.len_utf8()..];
        let kind = tail.chars().next().unwrap_or('s');
        let digits: String = tail[kind.len_utf8()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let n: usize = digits.parse().unwrap_or(0);
        let value = match kind {
            's' => handles.get(n).cloned().flatten(),
            _ => left.get(n).and_then(|l| l.handle.clone()),
        }
        .unwrap_or_else(|| "@0".to_owned());
        out.push_str(&value);
        rest = &tail[kind.len_utf8() + digits.len()..];
    }
    out.push_str(rest);
    out
}

/// A call as the model writes it.
pub fn call_xml(tool: &str, args: &Map<String, Value>) -> String {
    let mut text = format!("<tool_call>\n<function={tool}>\n");
    for (name, value) in args {
        let value = value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned);
        text += &format!("<parameter={name}>\n{value}\n</parameter>\n");
    }
    text + "</function>\n</tool_call>"
}

fn change_lines(changes: &[Change]) -> String {
    changes
        .iter()
        .map(|c| format!("{}: {}", c.field, c.value.render()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn compare_sets(want: &BTreeSet<String>, got: &BTreeSet<String>) -> Result<(), (Drop, String)> {
    if want == got {
        return Ok(());
    }
    let extra: Vec<_> = got.difference(want).take(4).collect();
    let missing: Vec<_> = want.difference(got).take(4).collect();
    let why = if !extra.is_empty() && missing.is_empty() {
        Drop::Overmatch
    } else if extra.is_empty() {
        Drop::Undermatch
    } else {
        Drop::Value
    };
    Err((why, format!("extra {extra:?} missing {missing:?}")))
}

/// The figures a turn ended on, by currency.
fn units(effect: &Effect) -> BTreeMap<String, f64> {
    value_units(&effect.value)
}

fn value_units(value: &Value) -> BTreeMap<String, f64> {
    value["values"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some((
                v["unit"].as_str().unwrap_or_default().to_owned(),
                v["amount"].as_f64()?,
            ))
        })
        .collect()
}

/// The one number a turn ended on.
fn scalar(effect: &Effect) -> Option<f64> {
    effect.value["values"]
        .as_array()?
        .first()?
        .get("amount")?
        .as_f64()
}

fn link_rows(diff: &NetDiff) -> Vec<String> {
    diff.links
        .iter()
        .flat_map(|l| [l.from.clone(), l.to.clone()])
        .collect()
}

/// Gold as the runtime did it.
fn gold_of(
    effect: &Effect,
    key: &dyn Fn(&str) -> String,
    turn: &TurnIntent,
) -> Result<Value, String> {
    let mut accept = Map::new();
    match effect.ending {
        Ending::Rows => {
            accept.insert("type".into(), json!("rows"));
            let rows: Vec<String> = effect.rows.iter().map(|id| key(id)).collect();
            accept.insert("rows".into(), json!(rows));
            let ordered = matches!(&turn.intent, Intent::Read { sel } if sel.order.is_some());
            if ordered {
                accept.insert("order".into(), json!(true));
            }
        }
        Ending::Value => {
            accept.insert("type".into(), json!("value"));
            if let Some(groups) = effect.value["groups"].as_array() {
                let mut map = Map::new();
                for g in groups {
                    let k = g["key"]
                        .as_str()
                        .map_or_else(|| g["key"].to_string(), str::to_owned);
                    map.insert(k, g["values"].clone());
                }
                accept.insert("groups".into(), Value::Object(map));
            } else {
                accept.insert("values".into(), effect.value["values"].clone());
            }
        }
        Ending::Ask => {
            accept.insert("type".into(), json!("ask"));
            let c: Vec<String> = effect.options.iter().map(|id| key(id)).collect();
            accept.insert("candidates".into(), json!(c));
        }
        Ending::Decline => {
            accept.insert("type".into(), json!("decline"));
            accept.insert(
                "reasons".into(),
                json!([effect.reason.clone().unwrap_or_default()]),
            );
        }
        Ending::Act => {
            accept.insert("type".into(), json!("diff"));
        }
        other => return Err(format!("a turn that ends in {}", other.word())),
    }
    if !effect.diff.rows.is_empty() || !effect.diff.links.is_empty() {
        let mut rows = Vec::new();
        for r in &effect.diff.rows {
            let mut fields = Map::new();
            for (name, (_, new)) in &r.fields {
                // a field cleared by the write is part of the change (an undone completion, an
                // unlinked transfer); a created row has no cleared fields
                if new.is_null() && r.change == "created" {
                    continue;
                }
                fields.insert(name.clone(), date_only_when_stamped(name, new));
            }
            let mut row = Map::new();
            if r.change == "created" {
                row.insert("new".into(), json!(r.kind));
            } else {
                row.insert("key".into(), json!(key(&r.id)));
                row.insert("change".into(), json!(r.change));
            }
            row.insert("fields".into(), Value::Object(fields));
            rows.push(Value::Object(row));
        }
        let links: Vec<Value> = effect
            .diff
            .links
            .iter()
            .map(|l| {
                let side = |id: &str| {
                    if effect
                        .diff
                        .rows
                        .iter()
                        .any(|r| r.change == "created" && r.id == id)
                    {
                        "new".to_owned()
                    } else {
                        key(id)
                    }
                };
                json!({"change": l.change, "from": side(&l.from), "to": side(&l.to)})
            })
            .collect();
        accept.insert("diff".into(), json!({"rows": rows, "links": links}));
    }
    Ok(Value::Object(accept))
}

/// The moment the runtime stamps on a completion or a log is the session clock, so gold names the
/// day, not a minute a model could not know.
fn date_only_when_stamped(field: &str, value: &Value) -> Value {
    // gold names a money field by its amount; the unit is the row's currency
    if let Some(amount) = value.get("amount") {
        return amount.clone();
    }
    if field == "completed"
        && let Some(text) = value.as_str()
    {
        return json!(text.get(..10).unwrap_or(text));
    }
    value.clone()
}
