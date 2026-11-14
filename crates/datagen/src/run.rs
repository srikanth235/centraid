//! STAGES 2 AND 3 TOGETHER: draw intents world by world, solve them against the real runtime, keep
//! the sessions that solve, and count everything that does not.
//!
//! A run is a pure function of its master seed, the world counts and the sessions per world.
//! Each world visits every live grid cell once as the first turn of a session (so a cell that the
//! world can serve is served), then keeps drawing cells in turn until it has the sessions asked
//! for. Sessions are weighted toward several turns, and a follow-up always leans on a turn before it.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::facts::Facts;
use crate::grid::{Cell, Grid};
use crate::intent::{Scenario, Span};
use crate::labels;
use crate::mix::UNDO_CAP;
use crate::plan::WorldRun;
use crate::rng::Rng;
use crate::sample::{Aim, Room, Sampler, Search};
use crate::settings::Split;
use crate::world::{World, plan_sized};

/// One ask-or-act pair for this many sessions drawn.
const PAIR_EVERY: usize = 60;

/// How many times a cell is drawn against the others as the first turn of a session. A turn the model decides alone
/// (recalling an answer, undoing a write, declining, asking which row) is a few cells but a large share of what the
/// mix aims at, so those cells are drawn more often. An undo and a recall are capped at the mix ([`Room`] stops drawing
/// them once the run has its share), so their weight only sets how fast the share fills.
fn weight(cell: &Cell) -> usize {
    match (cell.tool.as_str(), cell.verb.as_str()) {
        ("answer", _) => 10,
        ("do", "undo") => 8,
        ("decline", "not_found") => 16,
        ("decline", _) => 32,
        ("ask", _) => 30,
        _ => 1,
    }
}

/// Draws of each live (kind, field) pair of `create` and `edit`, aimed at the pair, so every pair reaches the floor of
/// the mix target-first.
const FIELD_DRAWS: usize = 2;

/// The same for a figure of a workout the member logged: the only way to edit one is a session that logs it first, so
/// each is drawn more often.
const WORKOUT_DRAWS: usize = 6;

/// Draws of each ask cell as the last turn of a longer session, of each decline cell, and of each read or count that
/// finds nothing. Ask, nothing found and decline are 25% of the turns, and sessions of two turns or more are 60% of the
/// sessions, so most of them have to come after another turn.
const TAIL_ASK_DRAWS: usize = 36;
const TAIL_DECLINE_DRAWS: usize = 26;
const TAIL_EMPTY_DRAWS: usize = 6;

/// Draws of each restore cell as a delete followed by its restore, for the kinds whose worlds hold few rows in the trash.
const RESTORE_DRAWS: usize = 4;

/// Draws of each count and each total or average through an option of `compute` a plain draw never uses (the trash, the
/// rows the turn before left out, the top few).
const COMPUTE_DRAWS: usize = 2;

/// Draws of each read and count cell aimed at finding nothing: the nothing-found share is 8% of the turns and a
/// world seldom holds a request that finds nothing by chance.
const EMPTY_DRAWS: usize = 9;

/// Draws of each write and edit cell aimed at a row said by a nickname or a misspelling (15% of the turns that point at a
/// row; a person has a nickname or a long name only now and then).
const NICKNAME_DRAWS: usize = 8;

/// Draws of each read cell through each option of `find` a plain draw never uses.
const SEARCH_DRAWS: usize = 1;

/// One draw: a cell and what it is aimed at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draw {
    pub cell: Cell,
    pub aim: Aim,
}

/// Every live cell once, then each again as often as its weight says.
fn schedule(live: &[Cell]) -> Vec<Cell> {
    let mut out: Vec<Cell> = live.to_vec();
    let most = live.iter().map(weight).max().unwrap_or(1);
    for round in 1..most {
        out.extend(live.iter().filter(|c| weight(c) > round).cloned());
    }
    out
}

/// The draws of one sweep of a world: the weighted cells, then the draws aimed target-first at the live (kind, field)
/// pairs, at turns that find nothing, at rows said by a nickname or a misspelling, and at the options of `find` a plain
/// draw never uses. A world with nothing to draw from simply gives none of an aimed draw.
#[must_use]
pub fn draws(catalog: &Catalog, grid: &Grid) -> Vec<Draw> {
    let live: Vec<Cell> = grid.live().into_iter().cloned().collect();
    let mut out: Vec<Draw> = schedule(&live)
        .into_iter()
        .map(|cell| Draw {
            cell,
            aim: Aim::default(),
        })
        .collect();
    for label in crate::fields::live_labels(catalog, grid) {
        let Some((verb, kind, field)) = crate::fields::split(&label) else {
            continue;
        };
        let draws = if verb == "edit" && kind == "workout" {
            WORKOUT_DRAWS
        } else {
            FIELD_DRAWS
        };
        for _ in 0..draws {
            out.push(Draw {
                cell: Cell::new(verb, kind, verb),
                aim: Aim {
                    field: Some(field.to_owned()),
                    ..Aim::default()
                },
            });
        }
    }
    for cell in &live {
        let reads = (cell.tool == "find" && cell.verb == "read")
            || (cell.tool == "compute" && cell.verb == "count");
        if reads {
            for _ in 0..EMPTY_DRAWS {
                out.push(Draw {
                    cell: cell.clone(),
                    aim: Aim {
                        empty: true,
                        ..Aim::default()
                    },
                });
            }
            for _ in 0..TAIL_EMPTY_DRAWS {
                out.push(Draw {
                    cell: cell.clone(),
                    aim: Aim {
                        empty: true,
                        tail: true,
                        ..Aim::default()
                    },
                });
            }
        }
        let tails = match cell.tool.as_str() {
            "ask" => TAIL_ASK_DRAWS,
            "decline" => TAIL_DECLINE_DRAWS,
            _ => 0,
        };
        for _ in 0..tails {
            out.push(Draw {
                cell: cell.clone(),
                aim: Aim {
                    tail: true,
                    ..Aim::default()
                },
            });
        }
        if cell.tool == "do" && cell.verb == "restore" {
            for _ in 0..RESTORE_DRAWS {
                out.push(Draw {
                    cell: cell.clone(),
                    aim: Aim {
                        trash: true,
                        ..Aim::default()
                    },
                });
            }
        }
        if cell.tool == "compute" {
            let options: &[Search] = match cell.verb.as_str() {
                "count" => &[Search::Trashed, Search::Exclude],
                "sum" | "avg" | "min" | "max" => &[Search::Top],
                _ => &[],
            };
            for search in options.iter().filter(|s| s.serves(catalog, &cell.kind)) {
                for _ in 0..COMPUTE_DRAWS {
                    out.push(Draw {
                        cell: cell.clone(),
                        aim: Aim {
                            search: Some(*search),
                            ..Aim::default()
                        },
                    });
                }
            }
        }
        let writes = (cell.tool == "do" && !matches!(cell.verb.as_str(), "undo" | "restore"))
            || cell.tool == "edit";
        if writes {
            for _ in 0..NICKNAME_DRAWS {
                out.push(Draw {
                    cell: cell.clone(),
                    aim: Aim {
                        nickname: true,
                        ..Aim::default()
                    },
                });
            }
        }
        if cell.tool == "find" && cell.verb == "read" {
            for search in Search::ALL
                .into_iter()
                .filter(|search| search.serves(catalog, &cell.kind))
            {
                for _ in 0..SEARCH_DRAWS {
                    out.push(Draw {
                        cell: cell.clone(),
                        aim: Aim {
                            search: Some(search),
                            ..Aim::default()
                        },
                    });
                }
            }
        }
    }
    out
}

/// What a world's kept turns hold of the shares the sampler stops drawing once they are full.
#[derive(Debug, Clone, Copy, Default)]
struct Filled {
    turns: usize,
    /// Turns that point at a row, and those that do it by a pronoun or an earlier answer.
    refs: usize,
    pronoun: usize,
    /// Of the pronoun turns, the recalls of an earlier answer.
    recall: usize,
    undo: usize,
}

/// The part of the pronoun ceiling the turns that are not a recall may fill: the rest is kept for recalls, which are a
/// share of their own (10% of the turns, with the undo) under the same ceiling.
const OTHER_PRONOUN: f64 = 0.45;

impl Filled {
    fn add(&mut self, turns: &[crate::intent::TurnIntent]) {
        for turn in turns {
            self.turns += 1;
            let reference = labels::reference(turn);
            self.refs += usize::from(!reference.is_empty());
            self.pronoun += usize::from(reference == "pronoun");
            self.recall += usize::from(matches!(turn.intent, crate::intent::Intent::Recall { .. }));
            self.undo += usize::from(crate::grid::cell_of(turn).to_string() == "do/-/undo");
        }
    }

    /// Room for the shares that have a ceiling: pronoun references at their share of the references, undo at
    /// [`UNDO_CAP`] of the turns.
    fn room(&self) -> Room {
        let ceiling = crate::mix::Shares::default().reference[2] * self.refs as f64;
        let others = (self.pronoun - self.recall) as f64;
        Room {
            pronoun: self.pronoun as f64 <= ceiling && others <= OTHER_PRONOUN * ceiling,
            recall: self.pronoun as f64 <= ceiling,
            undo: self.undo as f64 <= UNDO_CAP * self.turns as f64,
        }
    }
}

/// One ask-or-act pair: the same words said in two worlds of a split, a name that fits several rows in one (the model
/// asks which) and exactly one row in the other (it acts).
#[derive(Debug, Clone)]
struct PairPlan {
    id: usize,
    kind: String,
    name: String,
    verb: String,
    ask_world: usize,
    act_world: usize,
}

/// The ask-or-act pairs to draw in one split: `want` of them over the split's worlds, each name a pair uses once.
fn plan_pairs(
    seed: u64,
    split: Split,
    members: &[usize],
    samplers: &[Sampler<'_>],
    catalog: &Catalog,
    want: usize,
    first_id: usize,
) -> Vec<PairPlan> {
    // a very large vault is slow to seed twice and an empty one has no row: pairs live in the ordinary worlds
    let usable: Vec<usize> = members
        .iter()
        .copied()
        .filter(|w| samplers[*w].world_scale() == 1.0)
        .collect();
    let mut shared: Vec<(usize, String, String)> = Vec::new();
    for w in &usable {
        for kind in &catalog.kinds {
            if Sampler::pair_verbs(&kind.name).is_empty() {
                continue;
            }
            for (said, n) in samplers[*w].spoken_names(&kind.name).into_values() {
                if n >= 2 {
                    shared.push((*w, kind.name.clone(), said));
                }
            }
        }
    }
    let mut rng = Rng::new(seed).fork(&format!("askact:{}", split.name()));
    for i in (1..shared.len()).rev() {
        shared.swap(i, rng.below(i + 1));
    }
    let mut out: Vec<PairPlan> = Vec::new();
    let mut used: std::collections::BTreeSet<(String, String)> = std::collections::BTreeSet::new();
    for (ask_world, kind, name) in shared {
        if out.len() >= want {
            break;
        }
        if !used.insert((kind.clone(), crate::facts::fold(&name))) {
            continue;
        }
        let mut verbs = Sampler::pair_verbs(&kind);
        for i in (1..verbs.len()).rev() {
            verbs.swap(i, rng.below(i + 1));
        }
        let start = rng.below(usable.len().max(1));
        'found: for verb in verbs {
            for k in 0..usable.len() {
                let act_world = usable[(start + k) % usable.len()];
                if act_world == ask_world {
                    continue;
                }
                if samplers[act_world].act_side(&kind, &name, verb).is_some()
                    && samplers[ask_world].ask_side(&kind, &name, verb).is_some()
                {
                    out.push(PairPlan {
                        id: first_id + out.len(),
                        kind: kind.clone(),
                        name: name.clone(),
                        verb: verb.to_owned(),
                        ask_world,
                        act_world,
                    });
                    break 'found;
                }
            }
        }
    }
    out
}

/// Extra turns after the first, weighted so that most sessions have two or more turns and a
/// good share three or more.
const EXTRA_TURNS: &[(usize, u32)] = &[(0, 26), (1, 32), (2, 22), (3, 20)];

#[derive(Debug, Clone)]
pub struct Config {
    pub seed: u64,
    /// Worlds in each split: train, val, test.
    pub counts: [usize; 3],
    /// Sessions to keep per world; never fewer than one per live cell.
    pub per_world: [usize; 3],
    /// Visit only this many cells per world (tests that need a quick run); `None` for all.
    pub cell_limit: Option<usize>,
    /// Refused read calls from a model's rollouts, for the repair turns that read ([`crate::mistakes`]).
    pub mistakes: Vec<crate::mistakes::Observed>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CellStat {
    /// Intents drawn and run from this cell.
    pub attempts: usize,
    pub kept: usize,
    /// Draws the sampler could not make (the world held nothing to draw it from).
    pub undrawn: usize,
    pub drops: BTreeMap<String, usize>,
}

/// One kept session and where it belongs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Kept {
    pub split: Split,
    pub world: String,
    pub record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldInfo {
    pub id: String,
    pub split: Split,
    pub seed: u64,
    pub sessions: usize,
}

#[derive(Debug, Default)]
pub struct Generated {
    /// Presence-only world documents by id.
    pub docs: BTreeMap<String, Value>,
    pub worlds: Vec<WorldInfo>,
    pub kept: Vec<Kept>,
    pub cells: BTreeMap<Cell, CellStat>,
    /// Names the sampler had to number ("Recipes 2") because a kind's pool was spent.
    pub name_fallbacks: usize,
}

/// Run stages 2 and 3 over the worlds of `config`.
///
/// # Errors
///
/// If a world cannot be seeded or a vault cannot be copied.
pub fn generate(config: &Config, catalog: &Catalog, scratch: &Path) -> Result<Generated> {
    generate_with(config, catalog, scratch, &World::generate)
}

/// What a run does besides drawing: how many worlds at once, whether to say what it drops, and where to keep the worlds it
/// has finished.
#[derive(Clone, Copy)]
pub struct Options<'a> {
    /// Worlds drawn and solved at once (at least one). The result is the same for any number: it is assembled in world order.
    pub workers: usize,
    /// Print every dropped turn and every world's empty reads to stderr.
    pub verbose: bool,
    /// Keep each finished world under this directory and skip the worlds already there ([`Checkpoints`]).
    pub checkpoints: Option<&'a Path>,
    /// Told after each world, in the order they finish.
    pub progress: Option<&'a (dyn Fn(&Progress) + Sync)>,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Self {
            workers: 1,
            verbose: std::env::var_os("DATAGEN_DEBUG").is_some(),
            checkpoints: None,
            progress: None,
        }
    }
}

/// One finished world, in counts.
#[derive(Debug, Clone)]
pub struct Progress {
    pub id: String,
    pub done: usize,
    pub of: usize,
    pub sessions: usize,
    /// Read from a checkpoint, not drawn again.
    pub resumed: bool,
}

/// Everything one world adds to a run. A world is a pure function of its spec, the config and the catalogue, so this is
/// the same whichever thread makes it and whenever; it is what a checkpoint holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorldOut {
    doc: Value,
    info: WorldInfo,
    kept: Vec<Kept>,
    #[serde(with = "cells_as_list")]
    cells: BTreeMap<Cell, CellStat>,
    name_fallbacks: usize,
}

/// A cell is a struct, which json cannot use as a key: a checkpoint holds the cells as a list of pairs.
mod cells_as_list {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use super::{Cell, CellStat};

    pub fn serialize<S: Serializer>(
        cells: &BTreeMap<Cell, CellStat>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        cells.iter().collect::<Vec<_>>().serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<Cell, CellStat>, D::Error> {
        Ok(Vec::<(Cell, CellStat)>::deserialize(deserializer)?
            .into_iter()
            .collect())
    }
}

/// The settings a checkpoint was made with: a checkpoint is reused only under the same ones.
fn checkpoint_key(config: &Config, catalog: &Catalog) -> String {
    let text = format!(
        "{}|{:?}|{:?}|{:?}|{:?}|{}",
        config.seed,
        config.counts,
        config.per_world,
        config.cell_limit,
        config.mistakes,
        catalog.hash()
    );
    format!(
        "seed {}; worlds {:?}; sessions per world {:?}; settings {}",
        config.seed,
        config.counts,
        config.per_world,
        &blake3::hash(text.as_bytes()).to_hex()[..16]
    )
}

fn checkpoint_path(dir: &Path, spec: &crate::world::WorldSpec) -> std::path::PathBuf {
    dir.join(format!("{}-{}.json", spec.split.name(), spec.index))
}

fn load_checkpoint(path: &Path, key: &str) -> Result<Option<WorldOut>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading checkpoint {}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .with_context(|| format!("checkpoint {} is not json", path.display()))?;
    let made_with = value["key"].as_str().unwrap_or("unknown");
    if made_with != key {
        anyhow::bail!(
            "checkpoint {} was made with other settings ({made_with}), this run has ({key}); use another --out or remove the checkpoints",
            path.display()
        );
    }
    Ok(Some(
        serde_json::from_value(value["world"].clone())
            .with_context(|| format!("checkpoint {} cannot be read", path.display()))?,
    ))
}

fn save_checkpoint(path: &Path, key: &str, world: &WorldOut) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // written whole, then moved into place, so a restart never leaves half a checkpoint
    let part = path.with_extension("part");
    std::fs::write(
        &part,
        serde_json::to_string(&serde_json::json!({"key": key, "world": world}))?,
    )?;
    std::fs::rename(&part, path)?;
    Ok(())
}

/// [`generate`] over worlds made by `make` (a test that needs worlds with particular settings), one at a time.
///
/// # Errors
///
/// If a world cannot be seeded or a vault cannot be copied.
pub fn generate_with(
    config: &Config,
    catalog: &Catalog,
    scratch: &Path,
    make: &(dyn Fn(crate::world::WorldSpec) -> World + Sync),
) -> Result<Generated> {
    generate_opts(config, catalog, scratch, make, &Options::default())
}

/// [`generate_with`] with [`Options`]: worlds on `workers` threads, a progress line and checkpoints.
///
/// The worlds are independent: each draws from its own seed and keeps its own counts of what the sampler holds back
/// (pronoun references and undo, `Filled`), so no world sees another's turns and the result does not depend on which
/// thread runs which world or in what order they finish. The results are put together in world order.
///
/// # Errors
///
/// If a world cannot be seeded, a vault cannot be copied, or a checkpoint was made with other settings.
pub fn generate_opts(
    config: &Config,
    catalog: &Catalog,
    scratch: &Path,
    make: &(dyn Fn(crate::world::WorldSpec) -> World + Sync),
    options: &Options<'_>,
) -> Result<Generated> {
    let grid = Grid::build(catalog);
    let live: Vec<Cell> = grid.live().into_iter().cloned().collect();
    let order = draws(catalog, &grid);
    let specs = plan_sized(config.seed, |split| match split {
        Split::Train => config.counts[0],
        Split::Val => config.counts[1],
        Split::Test => config.counts[2],
    });
    // ask-or-act pairs are planned across the worlds of a split before any is run
    let pairs: Vec<PairPlan> = {
        let worlds: Vec<World> = specs.iter().map(|spec| make(*spec)).collect();
        let facts: Vec<Facts> = worlds.iter().map(|w| Facts::of(w, catalog)).collect();
        let samplers: Vec<Sampler<'_>> = worlds
            .iter()
            .zip(&facts)
            .map(|(w, f)| Sampler::new(w, f, catalog, &grid))
            .collect();
        let mut all: Vec<PairPlan> = Vec::new();
        for split in Split::ALL {
            let members: Vec<usize> = (0..specs.len())
                .filter(|i| specs[*i].split == split)
                .collect();
            let want = if config.cell_limit.is_some() {
                0
            } else {
                config.per_world[split_index(split)] * members.len() / PAIR_EVERY
            };
            let first = all.len();
            all.extend(plan_pairs(
                config.seed,
                split,
                &members,
                &samplers,
                catalog,
                want,
                first,
            ));
        }
        all
    };
    let key = checkpoint_key(config, catalog);
    let slots: Vec<std::sync::Mutex<Option<WorldOut>>> =
        specs.iter().map(|_| std::sync::Mutex::new(None)).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let finished = std::sync::atomic::AtomicUsize::new(0);
    let failure: std::sync::Mutex<Option<anyhow::Error>> = std::sync::Mutex::new(None);
    let work = || {
        loop {
            if failure.lock().is_ok_and(|f| f.is_some()) {
                return;
            }
            let number = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let Some(spec) = specs.get(number) else {
                return;
            };
            let path = options.checkpoints.map(|dir| checkpoint_path(dir, spec));
            let result = (|| -> Result<(WorldOut, bool)> {
                if let Some(path) = &path
                    && let Some(world) = load_checkpoint(path, &key)?
                {
                    return Ok((world, true));
                }
                let world = run_world(
                    number,
                    spec,
                    config,
                    catalog,
                    &grid,
                    &live,
                    &order,
                    &pairs,
                    make,
                    scratch,
                    options.verbose,
                )?;
                if let Some(path) = &path {
                    save_checkpoint(path, &key, &world)?;
                }
                Ok((world, false))
            })();
            match result {
                Ok((world, resumed)) => {
                    let done = finished.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    if let Some(progress) = options.progress {
                        progress(&Progress {
                            id: world.info.id.clone(),
                            done,
                            of: specs.len(),
                            sessions: world.info.sessions,
                            resumed,
                        });
                    }
                    if let Ok(mut slot) = slots[number].lock() {
                        *slot = Some(world);
                    }
                }
                Err(error) => {
                    if let Ok(mut f) = failure.lock()
                        && f.is_none()
                    {
                        *f = Some(error);
                    }
                    return;
                }
            }
        }
    };
    std::thread::scope(|scope| {
        for _ in 1..options.workers.clamp(1, specs.len().max(1)) {
            scope.spawn(work);
        }
        work();
    });
    if let Ok(mut f) = failure.lock()
        && let Some(error) = f.take()
    {
        return Err(error);
    }
    let mut out = Generated::default();
    for cell in &live {
        out.cells.insert(cell.clone(), CellStat::default());
    }
    for slot in slots {
        let world = slot
            .into_inner()
            .ok()
            .flatten()
            .context("a world was not finished")?;
        out.name_fallbacks += world.name_fallbacks;
        out.docs.insert(world.info.id.clone(), world.doc);
        out.worlds.push(world.info);
        out.kept.extend(world.kept);
        for (cell, stat) in world.cells {
            let total = out.cells.entry(cell).or_default();
            total.attempts += stat.attempts;
            total.kept += stat.kept;
            total.undrawn += stat.undrawn;
            for (why, n) in stat.drops {
                *total.drops.entry(why).or_default() += n;
            }
        }
    }
    Ok(out)
}

/// Draw and solve one world, from its spec alone.
#[allow(clippy::too_many_arguments)]
fn run_world(
    number: usize,
    spec: &crate::world::WorldSpec,
    config: &Config,
    catalog: &Catalog,
    grid: &Grid,
    live: &[Cell],
    order: &[Draw],
    pairs: &[PairPlan],
    make: &(dyn Fn(crate::world::WorldSpec) -> World + Sync),
    scratch: &Path,
    verbose: bool,
) -> Result<WorldOut> {
    // what the sampler holds back counts this world's own kept turns: the ceilings hold in every world, so in the split
    let mut filled = Filled::default();
    let mut out = WorldOut {
        doc: Value::Null,
        info: WorldInfo {
            id: String::new(),
            split: spec.split,
            seed: spec.seed,
            sessions: 0,
        },
        kept: Vec::new(),
        cells: live
            .iter()
            .map(|c| (c.clone(), CellStat::default()))
            .collect(),
        name_fallbacks: 0,
    };
    let world = make(*spec);
    let dir = scratch.join(world.id());
    let mut run =
        WorldRun::seed(&world, catalog, &dir).with_context(|| format!("world {}", world.id()))?;
    run.observed.clone_from(&config.mistakes);
    let facts = run.facts.clone();
    if verbose {
        eprintln!("world {} empty reads {}", world.id(), run.empty_reads);
    }
    let sampler = Sampler::new(&world, &facts, catalog, grid).with_empty_reads(run.empty_reads);
    let root = Rng::new(config.seed).fork(&format!("intents:{}", world.id()));
    let target = config
        .cell_limit
        .unwrap_or_else(|| config.per_world[split_index(spec.split)].max(order.len()));
    let mut kept = 0;
    let mut drawn = 0;
    let offset = number * 31;
    while kept < target && drawn < target * 3 {
        let draw = &order[(offset + drawn) % order.len()];
        let cell = &draw.cell;
        drawn += 1;
        let mut shape = root.fork(&format!("shape:{drawn}"));
        let extra = *shape.weighted(EXTRA_TURNS);
        for attempt in 0..4 {
            let id = format!("{}-{:04}", world.id(), kept + 1);
            let mut rng = root.fork(&format!("draw:{drawn}:{attempt}"));
            // later attempts fall back toward fewer turns, so a cell a follow-up cannot lean on is still served
            let extra = extra.saturating_sub(attempt / 2);
            let room = filled.room();
            let Some(scenario) = sampler.session_aim(&id, cell, &draw.aim, &room, extra, &mut rng)
            else {
                if let Some(stat) = out.cells.get_mut(cell) {
                    stat.undrawn += 1;
                }
                continue;
            };
            let solution = run
                .solve(&scenario)
                .with_context(|| format!("scenario {}", scenario.id))?;
            for (kept_cell, _) in &solution.turns {
                if let Some(stat) = out.cells.get_mut(kept_cell) {
                    stat.attempts += 1;
                    stat.kept += 1;
                }
            }
            for dropped in &solution.dropped {
                if verbose {
                    eprintln!(
                        "drop {} {} {}: {}\n   {}",
                        dropped.cell,
                        dropped.why.word(),
                        scenario.id,
                        dropped.detail,
                        serde_json::to_string(
                            &scenario.turns[..=dropped.turn]
                                .iter()
                                .map(|t| &t.intent)
                                .collect::<Vec<_>>()
                        )
                        .unwrap_or_default()
                    );
                }
                let stat = out.cells.entry(dropped.cell.clone()).or_default();
                stat.attempts += 1;
                *stat.drops.entry(dropped.why.word().to_owned()).or_default() += 1;
            }
            if let Some(record) = solution.record {
                filled.add(&scenario.turns[..solution.kept]);
                out.kept.push(Kept {
                    split: spec.split,
                    world: world.id(),
                    record,
                });
                kept += 1;
                // a minimal pair: the same question with one argument changed
                let mut twin_rng = root.fork(&format!("pair:{drawn}"));
                if scenario.turns.first().is_some_and(|t| t.dep.is_none())
                    && twin_rng.chance(0.4)
                    && let Some(twin) = sampler.pair(&scenario, &mut twin_rng)
                {
                    let solved = run.solve(&twin)?;
                    if let Some(record) = solved.record.filter(|r| {
                        solved.kept == 1
                            && Some(&r["turns"][0]["gold"])
                                != out.kept.last().map(|k| &k.record["turns"][0]["gold"])
                    }) {
                        for (kept_cell, _) in &solved.turns {
                            if let Some(stat) = out.cells.get_mut(kept_cell) {
                                stat.attempts += 1;
                                stat.kept += 1;
                            }
                        }
                        if let Some(base) = out.kept.last_mut()
                            && let Some(tags) = base.record["tags"].as_array_mut()
                        {
                            tags.push(Value::String(format!("pair:{}", scenario.id)));
                        }
                        out.kept.push(Kept {
                            split: spec.split,
                            world: world.id(),
                            record,
                        });
                        kept += 1;
                    }
                }
                break;
            }
        }
    }
    for pair in pairs
        .iter()
        .filter(|p| p.ask_world == number || p.act_world == number)
    {
        let asking = pair.ask_world == number;
        let (turn, side) = if asking {
            (sampler.ask_side(&pair.kind, &pair.name, &pair.verb), "ask")
        } else {
            (sampler.act_side(&pair.kind, &pair.name, &pair.verb), "act")
        };
        let Some(turn) = turn else { continue };
        let scenario = Scenario {
            id: format!("{}-{side}{:04}", world.id(), pair.id),
            world: world.id(),
            span: Span::Single,
            turns: vec![turn],
            tags: vec![format!("pair:askact:{}", pair.id), format!("askact:{side}")],
        };
        let solved = run.solve(&scenario)?;
        for (kept_cell, _) in &solved.turns {
            if let Some(stat) = out.cells.get_mut(kept_cell) {
                stat.attempts += 1;
                stat.kept += 1;
            }
        }
        if let Some(record) = solved.record.filter(|_| solved.kept == 1) {
            out.kept.push(Kept {
                split: spec.split,
                world: world.id(),
                record,
            });
            kept += 1;
        }
    }

    out.name_fallbacks = sampler.name_fallbacks();
    out.doc = world.doc.clone();
    out.info = WorldInfo {
        id: world.id(),
        split: spec.split,
        seed: spec.seed,
        sessions: kept,
    };
    // a seeded vault is the heaviest thing a run holds; free it as soon as the world is done
    drop(run);
    let _ = std::fs::remove_dir_all(&dir);
    Ok(out)
}

// ------------------------------------------------------------------------ the report

#[derive(Debug, Default, Serialize)]
pub struct Summary {
    pub sessions: usize,
    pub turns: usize,
    pub truncated: usize,
    /// Pairs of sessions that differ in one argument and in their answers.
    pub minimal_pairs: usize,
    /// Sessions with 1, 2 and 3 or more turns.
    pub by_turns: BTreeMap<String, usize>,
    pub multi_turn_share: f64,
    pub three_plus_share: f64,
    pub constraints: BTreeMap<String, usize>,
    /// The same, for the turns that select rows by constraints (not by a name or by an earlier
    /// turn): where the weighting toward three and more is meant to show.
    pub constraints_selecting: BTreeMap<String, usize>,
    pub three_plus_selecting_share: f64,
    pub reference: BTreeMap<String, usize>,
    pub outcome: BTreeMap<String, usize>,
    pub span: BTreeMap<String, usize>,
    pub across_share: f64,
    pub outcome_by_tool: BTreeMap<String, usize>,
    pub reference_by_tool: BTreeMap<String, usize>,
    pub constraints_by_app: BTreeMap<String, usize>,
    pub span_by_turns: BTreeMap<String, usize>,
    pub drops: BTreeMap<String, usize>,
}

fn split_index(split: Split) -> usize {
    match split {
        Split::Train => 0,
        Split::Val => 1,
        Split::Test => 2,
    }
}

fn bump(map: &mut BTreeMap<String, usize>, key: impl Into<String>) {
    *map.entry(key.into()).or_default() += 1;
}

fn share(part: usize, whole: usize) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64
    }
}

impl Summary {
    /// Count the kept sessions and the drops.
    #[must_use]
    pub fn of(generated: &Generated) -> Self {
        let mut s = Self::default();
        for stat in generated.cells.values() {
            for (why, n) in &stat.drops {
                *s.drops.entry(why.clone()).or_default() += n;
            }
        }
        for kept in &generated.kept {
            let record = &kept.record;
            let Ok(scenario) =
                serde_json::from_value::<crate::intent::Scenario>(record["scenario"].clone())
            else {
                continue;
            };
            s.sessions += 1;
            s.turns += scenario.turns.len();
            let tags: Vec<&str> = record["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if tags.contains(&"truncated") {
                s.truncated += 1;
            }
            if tags.iter().any(|t| t.starts_with("pair:")) {
                s.minimal_pairs += 1;
            }
            let n = scenario.turns.len();
            bump(
                &mut s.by_turns,
                if n >= 3 {
                    "3+".to_owned()
                } else {
                    n.to_string()
                },
            );
            bump(&mut s.span, scenario.span.word());
            bump(
                &mut s.span_by_turns,
                format!(
                    "{} x {}",
                    scenario.span.word(),
                    if n >= 3 {
                        "3+".to_owned()
                    } else {
                        n.to_string()
                    }
                ),
            );
            for (t, jt) in scenario
                .turns
                .iter()
                .zip(record["turns"].as_array().into_iter().flatten())
            {
                let c = jt["constraints"].as_u64().unwrap_or(0) as usize;
                let bucket = centraid_assist_eval::args::bucket(c);
                let cell0 = crate::grid::cell_of(t);
                // constraints are a property of turns that select rows or fold them
                if matches!(cell0.tool.as_str(), "find" | "compute" | "do" | "edit")
                    && cell0.verb != "undo"
                {
                    bump(&mut s.constraints, bucket);
                    if t.reference == crate::intent::Reference::Select {
                        bump(&mut s.constraints_selecting, bucket);
                    }
                }
                bump(&mut s.reference, t.reference.word());
                bump(&mut s.outcome, t.outcome.word());
                let cell = crate::grid::cell_of(t);
                bump(
                    &mut s.outcome_by_tool,
                    format!("{} x {}", t.outcome.word(), cell.tool),
                );
                bump(
                    &mut s.reference_by_tool,
                    format!("{} x {}", t.reference.word(), cell.tool),
                );
                for app in &t.apps {
                    if app == "money" || app == "health" {
                        bump(&mut s.constraints_by_app, format!("{app} x {bucket}"));
                    }
                }
            }
        }
        let multi = s
            .by_turns
            .iter()
            .filter(|(k, _)| *k != "1")
            .map(|(_, v)| v)
            .sum::<usize>();
        s.minimal_pairs /= 2;
        let selecting: usize = s.constraints_selecting.values().sum();
        let rich = s.constraints_selecting.get("3").copied().unwrap_or(0)
            + s.constraints_selecting.get("4+").copied().unwrap_or(0);
        s.three_plus_selecting_share = share(rich, selecting);
        s.multi_turn_share = share(multi, s.sessions);
        s.three_plus_share = share(s.by_turns.get("3+").copied().unwrap_or(0), s.sessions);
        s.across_share = share(s.span.get("across").copied().unwrap_or(0), s.sessions);
        s
    }
}

/// The report as text: the grid's size and not-live cells, solvable intents per cell, the shares,
/// the drop reasons.
#[must_use]
pub fn report(catalog: &Catalog, grid: &Grid, generated: &Generated) -> String {
    use std::fmt::Write;
    let summary = Summary::of(generated);
    let (live, not_live, invalid) = grid.counts();
    let mut out = String::new();
    let _ = writeln!(out, "catalog {}", catalog.hash());
    let _ = writeln!(
        out,
        "grid: {} primary cells = {live} live + {not_live} not live + {invalid} invalid (invalid cells are left out of every denominator)",
        live + not_live + invalid
    );
    let _ = writeln!(out, "\nnot live:");
    for (cell, why) in grid.not_live() {
        let _ = writeln!(out, "  {cell}: {why}");
    }
    let _ = writeln!(
        out,
        "\nsessions {} ({} truncated at an unsolvable turn, {} minimal pairs), turns {}, worlds {}",
        summary.sessions,
        summary.truncated,
        summary.minimal_pairs,
        summary.turns,
        generated.worlds.len()
    );
    let _ = writeln!(
        out,
        "multi-turn share {:.1}%, 3+ turns {:.1}%, across-app {:.1}%",
        summary.multi_turn_share * 100.0,
        summary.three_plus_share * 100.0,
        summary.across_share * 100.0
    );
    let line = |out: &mut String, name: &str, map: &BTreeMap<String, usize>| {
        let total: usize = map.values().sum();
        let parts: Vec<String> = map
            .iter()
            .map(|(k, v)| format!("{k} {v} ({:.0}%)", share(*v, total) * 100.0))
            .collect();
        let _ = writeln!(out, "{name}: {}", parts.join(", "));
    };
    line(&mut out, "constraints", &summary.constraints);
    line(
        &mut out,
        "constraints (selecting by constraints)",
        &summary.constraints_selecting,
    );
    line(&mut out, "reference", &summary.reference);
    line(&mut out, "outcome", &summary.outcome);
    line(&mut out, "span", &summary.span);
    line(&mut out, "turns", &summary.by_turns);
    line(&mut out, "drop reasons", &summary.drops);
    let _ = writeln!(
        out,
        "\nsolvable intents per live cell (kept / drawn; undrawn = the world held nothing to draw it from):"
    );
    for (cell, stat) in &generated.cells {
        let drops: Vec<String> = stat.drops.iter().map(|(k, v)| format!("{k} {v}")).collect();
        let _ = writeln!(
            out,
            "  {cell}: {} / {} ({:.0}%){}{}",
            stat.kept,
            stat.attempts,
            share(stat.kept, stat.attempts) * 100.0,
            if stat.undrawn > 0 {
                format!(", undrawn {}", stat.undrawn)
            } else {
                String::new()
            },
            if drops.is_empty() {
                String::new()
            } else {
                format!("  drops: {}", drops.join(", "))
            },
        );
    }
    let empty: Vec<&Cell> = generated
        .cells
        .iter()
        .filter(|(_, s)| s.kept == 0)
        .map(|(c, _)| c)
        .collect();
    let _ = writeln!(
        out,
        "\nnames numbered because a kind's name pool was spent: {}",
        generated.name_fallbacks
    );
    let _ = writeln!(
        out,
        "\nlive cells with no solvable intent: {}",
        if empty.is_empty() {
            "none".to_owned()
        } else {
            empty
                .iter()
                .map(|c| c.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        }
    );
    out
}

/// Write a run: `<out>/<split>/sessions.jsonl`, the worlds as presence-only documents under
/// `<out>/worlds/`, `report.txt` and `manifest.json` (the catalog hash, the seeds and counts a
/// reader needs to regenerate the worlds, the grid and the per-cell numbers).
///
/// # Errors
///
/// If a file cannot be written.
pub fn write(
    out: &Path,
    config: &Config,
    catalog: &Catalog,
    generated: &Generated,
) -> Result<String> {
    use crate::source::SESSIONS;
    std::fs::create_dir_all(out)?;
    for split in Split::ALL {
        let dir = out.join(split.name());
        std::fs::create_dir_all(&dir)?;
        let mut text = String::new();
        for kept in generated.kept.iter().filter(|k| k.split == split) {
            text += &serde_json::to_string(&kept.record)?;
            text.push('\n');
        }
        std::fs::write(dir.join(SESSIONS), text)?;
    }
    let worlds_dir = out.join(crate::source::WORLDS);
    std::fs::create_dir_all(&worlds_dir)?;
    for (id, doc) in &generated.docs {
        std::fs::write(
            worlds_dir.join(format!("{id}.json")),
            serde_json::to_string_pretty(doc)?,
        )?;
    }
    let grid = Grid::build(catalog);
    let report = report(catalog, &grid, generated);
    std::fs::write(out.join("report.txt"), &report)?;
    let summary = Summary::of(generated);
    let manifest = serde_json::json!({
        "catalog_hash": catalog.hash(),
        "master_seed": config.seed,
        "counts": config.counts,
        "per_world": config.per_world,
        "worlds": generated.worlds,
        "grid": grid.cells.iter().map(|(c, s)| (c.to_string(), s)).collect::<BTreeMap<_, _>>(),
        "cells": generated.cells.iter().map(|(c, s)| (c.to_string(), s)).collect::<BTreeMap<_, _>>(),
        "summary": summary,
    });
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A run of three worlds that visits only a few cells of each, so it is quick.
    fn tiny(seed: u64) -> Config {
        Config {
            seed,
            counts: [1, 1, 1],
            per_world: [0; 3],
            cell_limit: Some(6),
            mistakes: Vec::new(),
        }
    }

    /// Everything a run holds, as text, to compare two runs for equality.
    fn shown(g: &Generated) -> String {
        let cells: Vec<(String, &CellStat)> =
            g.cells.iter().map(|(c, s)| (c.to_string(), s)).collect();
        serde_json::to_string(&serde_json::json!({
            "docs": g.docs, "worlds": g.worlds, "kept": g.kept,
            "cells": cells, "fallbacks": g.name_fallbacks,
        }))
        .expect("json")
    }

    fn run_with(config: &Config, options: &Options<'_>) -> Result<Generated> {
        let catalog = Catalog::build()?;
        let scratch = tempfile::tempdir()?;
        generate_opts(config, &catalog, scratch.path(), &World::generate, options)
    }

    #[test]
    fn the_worlds_come_out_the_same_on_one_thread_and_on_three() {
        let config = tiny(5);
        let one = run_with(
            &config,
            &Options {
                workers: 1,
                ..Options::default()
            },
        )
        .expect("one thread");
        let three = run_with(
            &config,
            &Options {
                workers: 3,
                ..Options::default()
            },
        )
        .expect("three threads");
        assert_eq!(one.worlds.len(), 3);
        assert!(!one.kept.is_empty(), "the tiny run keeps sessions");
        let ids: Vec<&str> = one.worlds.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["train-00", "val-00", "test-00"]);
        assert_eq!(shown(&one), shown(&three));
    }

    #[test]
    fn a_resumed_run_equals_a_fresh_one_and_a_checkpoint_of_another_seed_is_refused() {
        let config = tiny(5);
        let fresh = run_with(&config, &Options::default()).expect("fresh");
        let dir = tempfile::tempdir().expect("dir");
        let seen: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());
        let progress = |p: &Progress| {
            seen.lock().expect("lock").push((p.id.clone(), p.resumed));
        };
        let options = Options {
            workers: 2,
            checkpoints: Some(dir.path()),
            progress: Some(&progress),
            ..Options::default()
        };
        // the first run draws every world and keeps each
        let first = run_with(&config, &options).expect("first");
        assert_eq!(shown(&first), shown(&fresh));
        assert!(seen.lock().expect("lock").iter().all(|(_, r)| !r));
        assert_eq!(seen.lock().expect("lock").len(), 3);
        for name in ["train-0", "val-0", "test-0"] {
            assert!(dir.path().join(format!("{name}.json")).exists(), "{name}");
        }
        // run again: nothing is drawn, everything comes from a checkpoint, the result is the same
        seen.lock().expect("lock").clear();
        let again = run_with(&config, &options).expect("again");
        assert!(seen.lock().expect("lock").iter().all(|(_, r)| *r));
        assert_eq!(seen.lock().expect("lock").len(), 3);
        assert_eq!(shown(&again), shown(&fresh));
        // a run stopped part way: one world is missing and is the only one drawn
        std::fs::remove_file(dir.path().join("val-0.json")).expect("remove");
        seen.lock().expect("lock").clear();
        let partial = run_with(&config, &options).expect("partial");
        let drawn: Vec<String> = seen
            .lock()
            .expect("lock")
            .iter()
            .filter(|(_, resumed)| !resumed)
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(drawn, ["val-00"]);
        assert_eq!(shown(&partial), shown(&fresh));
        // the same checkpoints under another seed, or other counts, are refused and not reused
        for other in [
            tiny(6),
            Config {
                counts: [1, 1, 2],
                ..tiny(5)
            },
        ] {
            let why = run_with(&other, &options).expect_err("refused");
            assert!(
                format!("{why:#}").contains("made with other settings"),
                "{why:#}"
            );
        }
    }
}
