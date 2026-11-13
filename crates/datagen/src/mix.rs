//! STAGE 7, MIX: choose the sessions of a data version from a larger rendered input.
//!
//! The input is every rendered session (`render`): the splits were drawn by world seed before any session existed, so a
//! world is in one split by construction, and [`mix`] asserts it. What is chosen from each split:
//!
//! 1. **Duplicates out.** A session's key is the BLAKE3 of its normalised user texts and its gold. The held-out splits are
//!    read first (test, then val, then train), so a session of train that repeats one of them is the one dropped.
//! 2. **Reserved combinations.** A short list of combinations (a kind with a filter field, a kind with a verb and a number
//!    of constraints) appears only in test: a train or val session that carries one is out of the input, and the mix
//!    asserts none is left in what it chose.
//! 3. **Pairs together.** The two sessions tagged `pair:<id>` (a minimal pair, or an ask-or-act pair) are one unit: both or
//!    neither. A pair whose twin is gone is not kept alone.
//! 4. **Targets.** Balance is by what the model decides, not by app. A session's app is a tag and a line of the report
//!    and is never a target. Units are chosen greedily by how much of each still-open target they fill, which is exact
//!    lazily (a deficit only shrinks as sessions are added):
//!    * **cells**: the grid's live cells (tool, kind, verb) share the split's turns equally (water-filled: a cell the
//!      input cannot fill gives its share to the others), and **a floor**: every live cell has at least `floor` turns in
//!      train (as many as the input holds), chosen first, rarest cell first;
//!    * **fields**: the live (kind, field) pairs of `create` and `edit` ([`crate::fields`]) are balanced the same way, each
//!      with its own floor (`field_floor`) and its own line of the report;
//!    * **outcome** per turn: done, nothing found, ask, decline, repair;
//!    * **action** per turn: read/count/measure, create/edit/other write, recall/undo;
//!    * **row reference** per turn that points at a row: name, filters, pronoun or earlier answer, nickname or misspelling;
//!    * **impossible**: the share of turns that ask for what the vault cannot do (the runtime's decline outcome);
//!    * **turns**: one, two and three-or-more turns per session (40 / 30 / 30);
//!    * **kinds**: the share of sessions that touch two kinds (20%);
//!    * **reserved** (test only): the share of sessions that carry a reserved combination;
//!    * **caps**, which are ceilings and not targets: the pronoun-or-earlier-answer references are at most their share of
//!      the turns that point at a row, and the undo turns at most [`UNDO_CAP`] of the turns. A unit that would take a cap
//!      over is left out, so the realised share never exceeds it.
//!
//!    **A floor**, not a share: at least half the sessions have two turns or more, as many as the input holds.
//! 5. **Subsets.** Nested train subsets (1,000 within 2,500 within the chosen train) are chosen by the same procedure from
//!    the larger one, so each keeps the balance as far as its supply allows. They are lists of session ids.
//! 6. **Noise** is the heavy-typo copy of val: the noise sessions whose val session was chosen.
//!
//! Mixing downsamples. What the input cannot give is reported, per cell and per share, with the target, the realised
//! count and the supply: nothing is faked to hit a number.

use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

use anyhow::{Result, bail};
use serde::Serialize;

use crate::render::Features;
use crate::rng::Rng;

/// The most that undo turns may be of a split's turns. The target share of recall turns is 10% and undo is one kind of
/// recall; undo is a thin skill the model needs to see, not a tenth of what it reads. The owner may change it here.
pub const UNDO_CAP: f64 = 0.04;

/// The cell label of an undo turn.
const UNDO_CELL: &str = "do/-/undo";

pub const OUTCOMES: [&str; 5] = ["done", "empty", "ask", "decline", "repair"];
pub const ACTIONS: [&str; 3] = ["read", "write", "recall"];
pub const REFERENCES: [&str; 4] = ["name", "filters", "pronoun", "nickname"];

/// The shares a mixed split aims at.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Shares {
    pub one: f64,
    pub two: f64,
    pub three_plus: f64,
    /// Sessions that touch two kinds (or more).
    pub two_kinds: f64,
    /// Per turn: [`OUTCOMES`].
    pub outcome: [f64; 5],
    /// Per turn that is not a decline: [`ACTIONS`].
    pub action: [f64; 3],
    /// Per turn that points at a row: [`REFERENCES`].
    pub reference: [f64; 4],
    /// Per turn: a request the vault cannot do.
    pub impossible: f64,
    /// Test only: sessions that carry a reserved combination.
    pub reserved: f64,
}

impl Default for Shares {
    fn default() -> Self {
        Self {
            one: 0.40,
            two: 0.30,
            three_plus: 0.30,
            two_kinds: 0.20,
            outcome: [0.65, 0.08, 0.10, 0.07, 0.10],
            action: [0.45, 0.45, 0.10],
            reference: [0.40, 0.25, 0.20, 0.15],
            impossible: 0.05,
            reserved: 0.20,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    /// Sessions wanted per split: train, val, test.
    pub targets: [usize; 3],
    pub shares: Shares,
    pub seed: u64,
    /// The grid's live cells (`tool/kind/verb`): the denominator of the per-cell target.
    pub live: Vec<String>,
    /// Turns every live cell has at least, per split (train, val, test); `0` is no floor.
    pub floor: [usize; 3],
    /// The live (kind, field) pairs of `create` and `edit` (`create/task/priority`): balanced like the cells.
    pub live_fields: Vec<String>,
    /// Turns every live pair has at least, per split (train, val, test); `0` is no floor, as for the cells.
    pub field_floor: [usize; 3],
    /// The most that undo turns may be of the turns of a split.
    pub undo_cap: f64,
    /// Nested train subsets, in sessions (each within the next).
    pub subsets: Vec<usize>,
    /// The combinations only test may hold; when empty, [`Config::reserve`] of them are chosen from the input.
    pub reserved: Vec<String>,
    /// How many combinations to reserve when `reserved` is empty.
    pub reserve: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            targets: [5000, 500, 1000],
            shares: Shares::default(),
            seed: 1,
            live: Vec::new(),
            floor: [30, 0, 0],
            live_fields: Vec::new(),
            field_floor: [30, 0, 0],
            undo_cap: UNDO_CAP,
            subsets: vec![1000, 2500],
            reserved: Vec::new(),
            reserve: 8,
        }
    }
}

pub const SPLITS: [&str; 3] = ["train", "val", "test"];

/// A cell's line of the report.
#[derive(Debug, Clone, Serialize)]
pub struct CellLine {
    pub cell: String,
    pub target: f64,
    pub realised: usize,
    /// Turns of this cell among the split's duplicate-free, pair-complete input.
    pub supply: usize,
    /// `hit` (realised reaches the floor, or the uniform target where there is no floor), `supply` (the input holds no
    /// more) or `short` (the mix left it under).
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct Line {
    pub name: String,
    /// What was asked for: the nominal share of the realised total (the flags' share, before the supply caps it).
    pub requested: f64,
    /// The share's target once what the input holds is taken into account (water-filled, capped by supply).
    pub target: f64,
    pub realised: f64,
    pub supply: f64,
}

impl Default for Line {
    fn default() -> Self {
        Self {
            name: String::new(),
            requested: 0.0,
            target: 0.0,
            realised: 0.0,
            supply: 0.0,
        }
    }
}

/// One share's lines (outcome, action, reference ...): the labels with their target, realised and supply, in turns (or
/// sessions for a share of sessions).
#[derive(Debug, Clone, Serialize)]
pub struct ShareReport {
    pub share: String,
    pub unit: &'static str,
    pub lines: Vec<Line>,
}

/// A ceiling's line of the report: the share of its base the chosen turns reach.
#[derive(Debug, Clone, Serialize)]
pub struct CapLine {
    pub name: String,
    /// What the share may be of its base at most.
    pub cap: f64,
    pub realised: usize,
    pub base: usize,
    /// The share the input would have given with no cap: the base is every turn it holds.
    pub supply: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SplitReport {
    pub split: String,
    pub target_sessions: usize,
    pub input_sessions: usize,
    pub duplicates: usize,
    pub orphan_pairs: usize,
    /// Sessions left out because they carry a reserved combination (train and val only).
    pub reserved_out: usize,
    pub supply_sessions: usize,
    pub sessions: usize,
    pub turns: usize,
    pub tokens: usize,
    pub pairs: usize,
    pub ask_or_act_pairs: usize,
    pub by_turns: Vec<Line>,
    pub multi_turn_share: f64,
    pub three_plus_share: f64,
    /// The shares of the issue: outcome, action, reference, impossible, kinds, reserved.
    pub shares: Vec<ShareReport>,
    /// The app is a tag, not a target: sessions by first app, for reading.
    pub apps: Vec<Line>,
    pub cells: Vec<CellLine>,
    /// The (kind, field) pairs of `create` and `edit`, as the cells are: `hit`, `supply` or `short`.
    pub fields: Vec<CellLine>,
    /// The ceilings: pronoun references and undo turns.
    pub caps: Vec<CapLine>,
    /// What the input could not give, in words.
    pub missed: Vec<String>,
}

/// The sessions chosen, by index into the features, and the report.
#[derive(Debug, Clone, Serialize)]
pub struct Selection {
    /// `train`, `val`, `test` and `noise`.
    pub chosen: BTreeMap<String, Vec<usize>>,
    /// Nested train subsets, by name (`train-1000`).
    pub subsets: BTreeMap<String, Vec<usize>>,
    pub reports: Vec<SplitReport>,
    /// The report of each subset, built like a split's.
    pub subset_reports: Vec<SplitReport>,
    /// The reserved combinations and how many test sessions carry each.
    pub reserved: BTreeMap<String, usize>,
}

fn bucket(turns: usize) -> usize {
    turns.clamp(1, 3) - 1
}

struct Unit {
    members: Vec<usize>,
    tie: u64,
}

/// A score as an integer, so the heap has a total order.
fn scaled(score: f64) -> i64 {
    (score * 1e9).round() as i64
}

/// Water-fill: `total` shared equally among the cells, a cell never receiving more than its supply, the rest going to the
/// others.
fn water_fill(supply: &BTreeMap<String, usize>, total: f64) -> BTreeMap<String, f64> {
    let mut out: BTreeMap<String, f64> = BTreeMap::new();
    let mut open: Vec<(&String, usize)> = supply.iter().map(|(c, n)| (c, *n)).collect();
    let mut left = total;
    while !open.is_empty() && left > 1e-9 {
        let level = left / open.len() as f64;
        let (full, rest): (Vec<_>, Vec<_>) =
            open.iter().partition(|(_, n)| (*n as f64) <= level + 1e-9);
        if full.is_empty() {
            for (cell, _) in &rest {
                out.insert((*cell).clone(), level);
            }
            break;
        }
        for (cell, n) in &full {
            out.insert((*cell).clone(), *n as f64);
            left -= *n as f64;
        }
        open = rest;
    }
    out
}

/// `total` split by `shares`, a label never receiving more than its supply, what it cannot take going to the others in
/// proportion to their shares.
fn weighted_fill(
    shares: &[(String, f64)],
    supply: &BTreeMap<String, usize>,
    total: f64,
) -> BTreeMap<String, f64> {
    let mut out: BTreeMap<String, f64> = shares.iter().map(|(n, _)| (n.clone(), 0.0)).collect();
    let share = |name: &str| {
        shares
            .iter()
            .find(|(n, _)| n == name)
            .map_or(0.0, |(_, s)| *s)
    };
    let mut left = total;
    let mut open: Vec<String> = shares
        .iter()
        .filter(|(_, s)| *s > 0.0)
        .map(|(n, _)| n.clone())
        .collect();
    while !open.is_empty() && left > 1e-9 {
        let weight: f64 = open.iter().map(|n| share(n)).sum();
        let room = |n: &str, out: &BTreeMap<String, f64>| {
            supply.get(n).copied().unwrap_or(0) as f64 - out[n]
        };
        let capped: Vec<String> = open
            .iter()
            .filter(|n| left * share(n) / weight.max(1e-9) >= room(n, &out) - 1e-9)
            .cloned()
            .collect();
        if capped.is_empty() {
            for n in &open {
                *out.get_mut(n.as_str()).expect("label") += left * share(n) / weight.max(1e-9);
            }
            break;
        }
        for n in &capped {
            let r = room(n, &out).max(0.0);
            *out.get_mut(n.as_str()).expect("label") += r;
            left -= r;
        }
        open.retain(|n| !capped.contains(n));
    }
    out
}

/// The dimensions a session is judged on, as `(weight, labels)`. A label is `dim:name`; a turn-level dimension has a label
/// per turn that has one, a session-level dimension one.
fn labelled(f: &Features) -> Vec<(f64, Vec<String>)> {
    let per_turn = |dim: &str, labels: &[String]| -> (f64, Vec<String>) {
        (
            1.0,
            labels
                .iter()
                .filter(|l| !l.is_empty())
                .map(|l| format!("{dim}:{l}"))
                .collect(),
        )
    };
    vec![
        (1.0, f.cells.iter().map(|c| format!("cell:{c}")).collect()),
        (1.0, f.fields.iter().map(|x| format!("field:{x}")).collect()),
        per_turn("outcome", &f.outcomes),
        per_turn("action", &f.actions),
        per_turn("reference", &f.refs),
        (
            1.0,
            (0..f.turns)
                .map(|t| {
                    format!(
                        "impossible:{}",
                        if f.impossible.get(t).copied().unwrap_or(false) {
                            "impossible"
                        } else {
                            "possible"
                        }
                    )
                })
                .collect(),
        ),
        (1.5, vec![format!("turns:{}", bucket(f.turns))]),
        (
            1.0,
            vec![format!(
                "kinds:{}",
                if f.kinds.len() >= 2 {
                    "two_kinds"
                } else {
                    "one_kind"
                }
            )],
        ),
        (
            1.0,
            vec![format!(
                "reserved:{}",
                if f.reserved.is_empty() {
                    "plain"
                } else {
                    "reserved"
                }
            )],
        ),
    ]
}

/// The state of one selection: what each label has, against what it is aimed at.
struct Tally {
    target: BTreeMap<String, f64>,
    got: BTreeMap<String, usize>,
    sessions: usize,
    want: usize,
    /// Turns of the sessions taken, and those that point at a row: the bases of the ceilings.
    turns: usize,
    refs: usize,
}

/// The ceilings of a selection.
#[derive(Debug, Clone, Copy)]
struct Caps {
    /// Pronoun references, of the turns that point at a row.
    pronoun: f64,
    /// Undo turns, of the turns.
    undo: f64,
}

/// What a unit adds to the counts a ceiling reads: `(pronoun, referencing turns, undo, turns)`.
fn cap_counts(features: &[Features], unit: &Unit) -> (usize, usize, usize, usize) {
    let mut n = (0, 0, 0, 0);
    for m in &unit.members {
        let f = &features[*m];
        n.0 += f.refs.iter().filter(|r| *r == "pronoun").count();
        n.1 += f.refs.iter().filter(|r| !r.is_empty()).count();
        n.2 += f.cells.iter().filter(|c| *c == UNDO_CELL).count();
        n.3 += f.turns;
    }
    n
}

fn deficit(target: f64, got: usize) -> f64 {
    if target <= 0.0 {
        -0.5
    } else {
        ((target - got as f64) / target).clamp(-0.5, 1.0)
    }
}

impl Tally {
    fn score(&self, features: &[Features], unit: &Unit) -> f64 {
        let mut total = 0.0;
        for m in &unit.members {
            for (weight, labels) in labelled(&features[*m]) {
                if labels.is_empty() {
                    continue;
                }
                let sum: f64 = labels
                    .iter()
                    .map(|l| {
                        deficit(
                            self.target.get(l).copied().unwrap_or(0.0),
                            self.got.get(l).copied().unwrap_or(0),
                        )
                    })
                    .sum();
                total += weight * sum / labels.len() as f64;
            }
        }
        total / unit.members.len() as f64
    }

    /// May `unit` be taken without a ceiling going over? A ceiling is checked on the counts after the unit, so the share
    /// at the end of the selection is under it whatever the order the units were taken in.
    fn allows(&self, features: &[Features], unit: &Unit, caps: &Caps) -> bool {
        let (pronoun, refs, undo, turns) = cap_counts(features, unit);
        let got = |k: &str| self.got.get(k).copied().unwrap_or(0);
        let ok_pronoun = pronoun == 0
            || (got("reference:pronoun") + pronoun) as f64
                <= caps.pronoun * (self.refs + refs) as f64 + 1e-9;
        let ok_undo = undo == 0
            || (got(&format!("cell:{UNDO_CELL}")) + undo) as f64
                <= caps.undo * (self.turns + turns) as f64 + 1e-9;
        ok_pronoun && ok_undo
    }

    fn add(&mut self, features: &[Features], unit: &Unit) {
        let (_, refs, _, turns) = cap_counts(features, unit);
        self.refs += refs;
        self.turns += turns;
        for m in &unit.members {
            for (_, labels) in labelled(&features[*m]) {
                for l in labels {
                    *self.got.entry(l).or_default() += 1;
                }
            }
            self.sessions += 1;
        }
    }
}

/// What a selection from `units` came to, with the targets it aimed at.
struct Chosen {
    picked: Vec<usize>,
    tally: Tally,
    supply: BTreeMap<String, usize>,
    supply_sessions: usize,
    avg_turns: f64,
    /// The pairs of `create` and `edit` a session of the input sets, on average.
    avg_fields: f64,
    /// Turns of the input, those that point at a row, and the undo turns.
    supply_turns: (usize, usize, usize),
}

/// The labels of `dim` (`cells` or `fields`) a feature carries.
fn dim_labels<'f>(f: &'f Features, dim: &str) -> &'f [String] {
    if dim == "field" { &f.fields } else { &f.cells }
}

/// The floor of one dimension: every eligible label has at least `floor` turns (as many as the input holds), the rarest
/// label first, a unit that would take a ceiling over left out.
#[allow(clippy::too_many_arguments)]
fn fill_floor(
    features: &[Features],
    units: &[Unit],
    dim: &str,
    eligible: &BTreeMap<String, usize>,
    floor: usize,
    caps: &Caps,
    tally: &mut Tally,
    taken: &mut [bool],
    picked: &mut Vec<usize>,
) {
    if floor == 0 {
        return;
    }
    let mut by_label: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, u) in units.iter().enumerate() {
        let labels: BTreeSet<&String> = u
            .members
            .iter()
            .flat_map(|m| dim_labels(&features[*m], dim).iter())
            .collect();
        for l in labels {
            if eligible.contains_key(l) {
                by_label.entry(l.clone()).or_default().push(i);
            }
        }
    }
    let mut order: Vec<(usize, String)> = eligible.iter().map(|(c, n)| (*n, c.clone())).collect();
    order.sort();
    for (n, label) in order {
        let need = floor.min(n);
        let key = format!("{dim}:{label}");
        while tally.got.get(&key).copied().unwrap_or(0) < need && tally.sessions < tally.want {
            let best = by_label[&label]
                .iter()
                .filter(|i| !taken[**i] && tally.allows(features, &units[**i], caps))
                .map(|i| (scaled(tally.score(features, &units[*i])), units[*i].tie, *i))
                .max();
            let Some((_, _, i)) = best else { break };
            tally.add(features, &units[i]);
            taken[i] = true;
            picked.extend(units[i].members.iter().copied());
        }
    }
}

/// Choose `want` sessions from `units`: the floor of every live cell first, then the greedy over every target.
fn select(
    features: &[Features],
    units: &[Unit],
    want: usize,
    cfg: &Config,
    (floor, field_floor): (usize, usize),
    test: bool,
) -> Chosen {
    let supply_sessions: usize = units.iter().map(|u| u.members.len()).sum();
    let want = want.min(supply_sessions);
    let mut supply: BTreeMap<String, usize> = BTreeMap::new();
    let mut turns_supply = 0_usize;
    let mut supply_counts = (0_usize, 0_usize, 0_usize);
    for u in units {
        let (_, refs, undo, _) = cap_counts(features, u);
        supply_counts.1 += refs;
        supply_counts.2 += undo;
        for m in &u.members {
            for (_, labels) in labelled(&features[*m]) {
                for l in labels {
                    *supply.entry(l).or_default() += 1;
                }
            }
            turns_supply += features[*m].turns;
        }
    }
    let per = |dim: &str| -> BTreeMap<String, usize> {
        supply
            .iter()
            .filter_map(|(k, n)| {
                k.strip_prefix(&format!("{dim}:"))
                    .map(|name| (name.to_owned(), *n))
            })
            .collect()
    };
    let scale = want as f64 / supply_sessions.max(1) as f64;
    let avg_turns = turns_supply as f64 / supply_sessions.max(1) as f64;
    supply_counts.0 = turns_supply;
    let mut target: BTreeMap<String, f64> = BTreeMap::new();
    // cells: equal shares of the turns, water-filled, and never under the floor (as far as the input holds it)
    let live: BTreeSet<&String> = cfg.live.iter().collect();
    let eligible: BTreeMap<String, usize> = per("cell")
        .into_iter()
        .filter(|(c, _)| live.contains(c))
        .collect();
    for (cell, t) in water_fill(&eligible, want as f64 * avg_turns) {
        let floored = t.max(floor.min(eligible[&cell]) as f64);
        target.insert(format!("cell:{cell}"), floored);
    }
    // fields: the live pairs of create and edit share the turns that set one equally, with a floor of their own
    let live_fields: BTreeSet<&String> = cfg.live_fields.iter().collect();
    let eligible_fields: BTreeMap<String, usize> = per("field")
        .into_iter()
        .filter(|(f, _)| live_fields.contains(f))
        .collect();
    let avg_fields = eligible_fields.values().sum::<usize>() as f64 / supply_sessions.max(1) as f64;
    for (field, t) in water_fill(&eligible_fields, want as f64 * avg_fields) {
        let floored = t.max(field_floor.min(eligible_fields[&field]) as f64);
        target.insert(format!("field:{field}"), floored);
    }
    let mut share_dim = |dim: &str, shares: &[(&str, f64)], total: f64| {
        let shares: Vec<(String, f64)> =
            shares.iter().map(|(n, s)| ((*n).to_owned(), *s)).collect();
        for (name, t) in weighted_fill(&shares, &per(dim), total) {
            target.insert(format!("{dim}:{name}"), t);
        }
    };
    let s = &cfg.shares;
    let labelled_total = |dim: &str| per(dim).values().sum::<usize>() as f64 * scale;
    share_dim(
        "outcome",
        &OUTCOMES.iter().copied().zip(s.outcome).collect::<Vec<_>>(),
        labelled_total("outcome"),
    );
    share_dim(
        "action",
        &ACTIONS.iter().copied().zip(s.action).collect::<Vec<_>>(),
        labelled_total("action"),
    );
    share_dim(
        "reference",
        &REFERENCES
            .iter()
            .copied()
            .zip(s.reference)
            .collect::<Vec<_>>(),
        labelled_total("reference"),
    );
    share_dim(
        "impossible",
        &[
            ("impossible", s.impossible),
            ("possible", 1.0 - s.impossible),
        ],
        labelled_total("impossible"),
    );
    share_dim(
        "turns",
        &[("0", s.one), ("1", s.two), ("2", s.three_plus)],
        want as f64,
    );
    share_dim(
        "kinds",
        &[("two_kinds", s.two_kinds), ("one_kind", 1.0 - s.two_kinds)],
        want as f64,
    );
    if test {
        share_dim(
            "reserved",
            &[("reserved", s.reserved), ("plain", 1.0 - s.reserved)],
            want as f64,
        );
    }
    let mut tally = Tally {
        target,
        got: BTreeMap::new(),
        sessions: 0,
        want,
        turns: 0,
        refs: 0,
    };
    let caps = Caps {
        pronoun: s.reference[2],
        undo: cfg.undo_cap,
    };
    let mut taken = vec![false; units.len()];
    let mut picked: Vec<usize> = Vec::new();
    let take = |i: usize, tally: &mut Tally, taken: &mut Vec<bool>, picked: &mut Vec<usize>| {
        tally.add(features, &units[i]);
        taken[i] = true;
        picked.extend(units[i].members.iter().copied());
    };

    // the floors: every live cell, then every live (kind, field) pair, has at least `floor` turns (as many as the input
    // holds), the rarest first
    fill_floor(
        features,
        units,
        "cell",
        &eligible,
        floor,
        &caps,
        &mut tally,
        &mut taken,
        &mut picked,
    );
    fill_floor(
        features,
        units,
        "field",
        &eligible_fields,
        field_floor,
        &caps,
        &mut tally,
        &mut taken,
        &mut picked,
    );

    // greedy, lazily
    let multi_supply =
        supply.get("turns:1").copied().unwrap_or(0) + supply.get("turns:2").copied().unwrap_or(0);
    let multi_floor = want.div_ceil(2).min(multi_supply);
    let mut heap: BinaryHeap<(i64, u64, usize)> = units
        .iter()
        .enumerate()
        .filter(|(i, _)| !taken[*i])
        .map(|(i, u)| (scaled(tally.score(features, u)), u.tie, i))
        .collect();
    // a unit that would take a ceiling over waits: the share it needs room in may have room once more is taken
    let mut deferred: Vec<usize> = Vec::new();
    while tally.sessions < want {
        let Some((_, tie, i)) = heap.pop() else {
            break;
        };
        if taken[i] {
            continue;
        }
        if !tally.allows(features, &units[i], &caps) {
            deferred.push(i);
            continue;
        }
        let got_multi = tally.got.get("turns:1").copied().unwrap_or(0)
            + tally.got.get("turns:2").copied().unwrap_or(0);
        // once the sessions left to choose are all needed to reach the floor, a unit that does not help is out
        let still_needed = multi_floor.saturating_sub(got_multi);
        let len = units[i].members.len();
        let multi_here = units[i]
            .members
            .iter()
            .filter(|m| features[**m].turns >= 2)
            .count();
        if still_needed > 0 && want - tally.sessions < len + still_needed.saturating_sub(multi_here)
        {
            continue;
        }
        let now = scaled(tally.score(features, &units[i]));
        if let Some((next, _, _)) = heap.peek()
            && now < *next
        {
            heap.push((now, tie, i));
            continue;
        }
        take(i, &mut tally, &mut taken, &mut picked);
    }
    loop {
        let mut progress = false;
        for i in std::mem::take(&mut deferred) {
            if tally.sessions >= want || taken[i] {
                continue;
            }
            if tally.allows(features, &units[i], &caps) {
                take(i, &mut tally, &mut taken, &mut picked);
                progress = true;
            } else {
                deferred.push(i);
            }
        }
        if !progress {
            break;
        }
    }
    picked.sort_unstable();
    Chosen {
        picked,
        tally,
        supply,
        supply_sessions,
        avg_turns,
        avg_fields,
        supply_turns: supply_counts,
    }
}

fn status(realised: f64, target: f64, supply: f64) -> &'static str {
    if realised + 1.0 >= target {
        "hit"
    } else if realised >= supply {
        "supply"
    } else {
        "short"
    }
}

/// The report of a selection.
#[allow(clippy::too_many_lines)]
fn report_of(
    features: &[Features],
    chosen: &Chosen,
    cfg: &Config,
    (floor, field_floor): (usize, usize),
    name: &str,
    target_sessions: usize,
) -> SplitReport {
    let picked = &chosen.picked;
    let got = |k: &str| chosen.tally.got.get(k).copied().unwrap_or(0);
    let supply = |k: &str| chosen.supply.get(k).copied().unwrap_or(0);
    let target = |k: &str| chosen.tally.target.get(k).copied().unwrap_or(0.0);
    let want = chosen.tally.want;
    let n = picked.len().max(1) as f64;
    let mut report = SplitReport {
        split: name.to_owned(),
        target_sessions,
        supply_sessions: chosen.supply_sessions,
        sessions: picked.len(),
        turns: picked.iter().map(|i| features[*i].turns).sum(),
        tokens: picked.iter().map(|i| features[*i].tokens).sum(),
        ..SplitReport::default()
    };
    let pair_count = |prefix: &str| {
        picked
            .iter()
            .filter(|i| {
                features[**i]
                    .pair
                    .as_deref()
                    .is_some_and(|p| p.starts_with(prefix))
            })
            .count()
            / 2
    };
    report.pairs = pair_count("pair:");
    report.ask_or_act_pairs = pair_count("pair:askact");
    report.by_turns = ["1", "2", "3+"]
        .iter()
        .enumerate()
        .map(|(b, name)| Line {
            name: (*name).to_owned(),
            requested: [cfg.shares.one, cfg.shares.two, cfg.shares.three_plus][b] * n,
            target: target(&format!("turns:{b}")),
            realised: got(&format!("turns:{b}")) as f64,
            supply: supply(&format!("turns:{b}")) as f64,
        })
        .collect();
    report.multi_turn_share = (got("turns:1") + got("turns:2")) as f64 / n;
    report.three_plus_share = got("turns:2") as f64 / n;
    let mut dim = |label: &str, unit: &'static str, dim: &str, names: &[&str], asked: &[f64]| {
        let total: f64 = names
            .iter()
            .map(|n| got(&format!("{dim}:{n}")) as f64)
            .sum();
        let lines: Vec<Line> = names
            .iter()
            .zip(asked)
            .map(|(name, share)| {
                let k = format!("{dim}:{name}");
                Line {
                    name: (*name).to_owned(),
                    requested: share * total,
                    target: target(&k),
                    realised: got(&k) as f64,
                    supply: supply(&k) as f64,
                }
            })
            .collect();
        for l in &lines {
            // a share the input could not fill: say so against what was asked, not against the capped target
            if total > 0.0 && l.realised < 0.8 * l.requested && l.requested - l.realised >= 2.0 {
                report.missed.push(format!(
                    "{label} {}: {:.0} of {:.0} asked for (the input holds {:.0})",
                    l.name, l.realised, l.requested, l.supply
                ));
            }
        }
        report.shares.push(ShareReport {
            share: label.to_owned(),
            unit,
            lines,
        });
    };
    let sh = &cfg.shares;
    dim("outcome", "turns", "outcome", &OUTCOMES, &sh.outcome);
    dim("action", "turns", "action", &ACTIONS, &sh.action);
    dim(
        "reference",
        "turns",
        "reference",
        &REFERENCES,
        &sh.reference,
    );
    dim(
        "impossible",
        "turns",
        "impossible",
        &["impossible", "possible"],
        &[sh.impossible, 1.0 - sh.impossible],
    );
    dim(
        "kinds",
        "sessions",
        "kinds",
        &["two_kinds", "one_kind"],
        &[sh.two_kinds, 1.0 - sh.two_kinds],
    );
    if name.starts_with("test") {
        dim(
            "reserved",
            "sessions",
            "reserved",
            &["reserved", "plain"],
            &[sh.reserved, 1.0 - sh.reserved],
        );
    }
    // apps: a tag, read only
    let mut apps: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for i in picked {
        apps.entry(features[*i].app.clone()).or_default().0 += 1;
    }
    report.apps = apps
        .into_iter()
        .map(|(app, (count, _))| Line {
            name: app,
            requested: 0.0,
            target: 0.0,
            realised: count as f64,
            supply: 0.0,
        })
        .collect();
    let uniform = want as f64 * chosen.avg_turns / cfg.live.len().max(1) as f64;
    for cell in &cfg.live {
        let k = format!("cell:{cell}");
        let (realised, supply) = (got(&k), supply(&k));
        let need = if floor > 0 { floor as f64 } else { uniform };
        report.cells.push(CellLine {
            cell: cell.clone(),
            target: need,
            realised,
            supply,
            status: if realised as f64 + 1e-9 >= need {
                "hit"
            } else if realised >= supply {
                "supply"
            } else {
                "short"
            },
        });
    }
    let uniform_fields = want as f64 * chosen.avg_fields / cfg.live_fields.len().max(1) as f64;
    for field in &cfg.live_fields {
        let k = format!("field:{field}");
        let (realised, supply) = (got(&k), supply(&k));
        let need = if field_floor > 0 {
            field_floor as f64
        } else {
            uniform_fields
        };
        report.fields.push(CellLine {
            cell: field.clone(),
            target: need,
            realised,
            supply,
            status: if realised as f64 + 1e-9 >= need {
                "hit"
            } else if realised >= supply {
                "supply"
            } else {
                "short"
            },
        });
    }
    let (_, ref_supply, undo_supply) = chosen.supply_turns;
    let (_, in_refs, _, in_turns) = {
        let mut n = (0, 0, 0, 0);
        for i in picked {
            let (a, b, c, d) = cap_counts(
                features,
                &Unit {
                    members: vec![*i],
                    tie: 0,
                },
            );
            n = (n.0 + a, n.1 + b, n.2 + c, n.3 + d);
        }
        n
    };
    report.caps = vec![
        CapLine {
            name: "pronoun or earlier-answer references (of the turns that point at a row)"
                .to_owned(),
            cap: cfg.shares.reference[2],
            realised: got("reference:pronoun"),
            base: in_refs,
            supply: supply("reference:pronoun").min(ref_supply),
        },
        CapLine {
            name: "undo turns (of the turns)".to_owned(),
            cap: cfg.undo_cap,
            realised: got(&format!("cell:{UNDO_CELL}")),
            base: in_turns,
            supply: undo_supply,
        },
    ];
    if want < target_sessions {
        report.missed.push(format!(
            "{target_sessions} sessions wanted, the input holds {} after duplicates and broken pairs",
            chosen.supply_sessions
        ));
    }
    let mut check = |label: &str, k: &str| {
        let (g, t, s) = (got(k) as f64, target(k), supply(k) as f64);
        if status(g, t, s) == "short" {
            report.missed.push(format!(
                "{label}: {g:.0} of {t:.0} wanted (the input holds {s:.0})"
            ));
        }
    };
    for (b, label) in ["one-turn", "two-turn", "3+-turn"].iter().enumerate() {
        check(&format!("{label} sessions"), &format!("turns:{b}"));
    }
    check("sessions that touch two kinds", "kinds:two_kinds");
    for o in OUTCOMES {
        check(&format!("{o} turns"), &format!("outcome:{o}"));
    }
    for a in ACTIONS {
        check(&format!("{a} turns"), &format!("action:{a}"));
    }
    for r in REFERENCES {
        check(&format!("{r} references"), &format!("reference:{r}"));
    }
    check("impossible requests", "impossible:impossible");
    if report.multi_turn_share < 0.5 && want > 0 {
        report.missed.push(format!(
            "multi-turn share {:.1}% is under the 50% floor",
            report.multi_turn_share * 100.0
        ));
    }
    let unfilled_fields = report.fields.iter().filter(|c| c.status != "hit").count();
    if unfilled_fields > 0 {
        let supplied = report
            .fields
            .iter()
            .filter(|c| c.status == "supply")
            .count();
        let what = if field_floor > 0 {
            format!("the floor of {field_floor} turns")
        } else {
            "the uniform target".to_owned()
        };
        report.missed.push(format!(
            "{unfilled_fields} of {} live (kind, field) pairs under {what} ({supplied} because the input holds no more)",
            report.fields.len()
        ));
    }
    let unfilled = report.cells.iter().filter(|c| c.status != "hit").count();
    if unfilled > 0 {
        let supplied = report.cells.iter().filter(|c| c.status == "supply").count();
        let what = if floor > 0 {
            format!("the floor of {floor} turns")
        } else {
            "the uniform target".to_owned()
        };
        report.missed.push(format!(
            "{unfilled} of {} live cells under {what} ({supplied} because the input holds no more)",
            report.cells.len()
        ));
    }
    report
}

/// A live cell or a live (kind, field) pair of train that has fewer turns than its floor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Under {
    /// `cell` or `field`.
    pub of: &'static str,
    pub name: String,
    pub realised: usize,
    pub floor: usize,
}

impl std::fmt::Display for Under {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}: {} of {}",
            self.of, self.name, self.realised, self.floor
        )
    }
}

/// Every live cell and live (kind, field) pair of train that the mix left under its floor (a floor of 0 asks nothing),
/// whatever the reason: the input held no more, or the mix left it short.
#[must_use]
pub fn under_floor(selection: &Selection, cfg: &Config) -> Vec<Under> {
    let Some(train) = selection.reports.iter().find(|r| r.split == "train") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (of, lines, floor) in [
        ("cell", &train.cells, cfg.floor[0]),
        ("field", &train.fields, cfg.field_floor[0]),
    ] {
        out.extend(
            lines
                .iter()
                .filter(|line| line.realised < floor)
                .map(|line| Under {
                    of,
                    name: line.cell.clone(),
                    realised: line.realised,
                    floor,
                }),
        );
    }
    out
}

/// The guard of a build: the version is not made when a live cell or a live (kind, field) pair of train is under its floor.
///
/// # Errors
///
/// An error naming every cell and pair that is under its floor, with its count and the floor.
pub fn check_floors(selection: &Selection, cfg: &Config) -> Result<()> {
    let under = under_floor(selection, cfg);
    if under.is_empty() {
        return Ok(());
    }
    let cells = under.iter().filter(|u| u.of == "cell").count();
    bail!(
        "train is under its floor: {cells} live cell(s) and {} live (kind, field) pair(s) have fewer turns than the floor: {}",
        under.len() - cells,
        under
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ")
    )
}

/// The combinations to reserve for test: rare enough that train and val lose little, present in test so there is something
/// to hold out, alternating the two families (a kind with a filter field, a kind with a verb and a constraint count), in a
/// seeded order. At most 10% of the sessions of train and val may carry one.
#[must_use]
pub fn choose_reserved(features: &[Features], cfg: &Config) -> Vec<String> {
    if cfg.reserve == 0 {
        return Vec::new();
    }
    let mut total: BTreeMap<&str, usize> = BTreeMap::new();
    let mut in_test: BTreeMap<&str, usize> = BTreeMap::new();
    let mut sessions = 0_usize;
    for f in features.iter().filter(|f| f.split != "noise") {
        sessions += 1;
        for c in &f.combos {
            *total.entry(c).or_default() += 1;
            if f.split == "test" {
                *in_test.entry(c).or_default() += 1;
            }
        }
    }
    let rare = (sessions / 25).max(3);
    let mut families: [Vec<&str>; 2] = [Vec::new(), Vec::new()];
    for (combo, n) in &total {
        if *n <= rare && in_test.get(combo).copied().unwrap_or(0) >= 2 {
            families[usize::from(combo.starts_with("kvn:"))].push(combo);
        }
    }
    let mut rng = Rng::new(cfg.seed).fork("reserved");
    let mut out = Vec::new();
    let mut lost = 0_usize;
    let budget = (features
        .iter()
        .filter(|f| matches!(f.split.as_str(), "train" | "val"))
        .count()
        / 10)
        .max(1);
    for family in &mut families {
        for i in (1..family.len()).rev() {
            family.swap(i, rng.below(i + 1));
        }
    }
    let mut next = [0_usize; 2];
    while out.len() < cfg.reserve {
        let f = out.len() % 2;
        let Some(combo) = families[f]
            .get(next[f])
            .or_else(|| families[1 - f].get(next[1 - f]))
        else {
            break;
        };
        if families[f].get(next[f]).is_some() {
            next[f] += 1;
        } else {
            next[1 - f] += 1;
        }
        let here = total[combo] - in_test.get(combo).copied().unwrap_or(0);
        if lost + here <= budget {
            lost += here;
            out.push((*combo).to_owned());
        }
    }
    out.sort();
    out
}

/// The combinations a session carries that are reserved.
fn reserved_in<'a>(
    f: &'a Features,
    reserved: &'a BTreeSet<&'a str>,
) -> impl Iterator<Item = &'a String> {
    f.combos
        .iter()
        .filter(move |c| reserved.contains(c.as_str()))
}

/// Mix `features`.
///
/// # Errors
///
/// If a world turns up in two splits, or a reserved combination in train or val.
#[allow(clippy::too_many_lines)]
pub fn mix(input: &[Features], cfg: &Config) -> Result<Selection> {
    let mut cfg = cfg.clone();
    if cfg.reserved.is_empty() {
        cfg.reserved = choose_reserved(input, &cfg);
    }
    let cfg = &cfg;
    let reserved: BTreeSet<&str> = cfg.reserved.iter().map(String::as_str).collect();
    let mut owned = input.to_vec();
    for f in &mut owned {
        f.reserved = f
            .combos
            .iter()
            .filter(|c| reserved.contains(c.as_str()))
            .cloned()
            .collect();
    }
    let features: &[Features] = &owned;
    // a world is in one split
    let mut home: BTreeMap<&str, &str> = BTreeMap::new();
    for f in features.iter().filter(|f| f.split != "noise") {
        if let Some(other) = home.insert(&f.world, &f.split)
            && other != f.split
        {
            bail!("world {} is in both {other} and {}", f.world, f.split);
        }
    }
    let mut chosen: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut reports: Vec<SplitReport> = Vec::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut train_units: Vec<Unit> = Vec::new();
    // held-out splits first, so a duplicate is dropped from train
    for (name, target, floors) in [
        ("test", cfg.targets[2], (cfg.floor[2], cfg.field_floor[2])),
        ("val", cfg.targets[1], (cfg.floor[1], cfg.field_floor[1])),
        ("train", cfg.targets[0], (cfg.floor[0], cfg.field_floor[0])),
    ] {
        let mine: Vec<usize> = (0..features.len())
            .filter(|i| features[*i].split == name)
            .collect();
        let input_sessions = mine.len();
        // duplicates
        let mut kept: Vec<usize> = Vec::new();
        let mut duplicates = 0;
        for i in mine {
            if seen.insert(&features[i].key) {
                kept.push(i);
            } else {
                duplicates += 1;
            }
        }
        // reserved combinations belong to test
        let mut reserved_out = 0;
        if name != "test" {
            kept.retain(|i| {
                let hit = reserved_in(&features[*i], &reserved).next().is_some();
                reserved_out += usize::from(hit);
                !hit
            });
        }
        // pairs
        let mut by_pair: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        let mut units: Vec<Unit> = Vec::new();
        let mut orphans = 0;
        let mut rng = Rng::new(cfg.seed).fork(&format!("mix:{name}"));
        for i in &kept {
            match &features[*i].pair {
                Some(pair) => by_pair.entry(pair).or_default().push(*i),
                None => units.push(Unit {
                    members: vec![*i],
                    tie: rng.next_u64(),
                }),
            }
        }
        for (_, members) in by_pair {
            if members.len() == 2 {
                units.push(Unit {
                    members,
                    tie: rng.next_u64(),
                });
            } else {
                orphans += members.len();
            }
        }
        units.sort_by_key(|u| u.members[0]);
        let result = select(features, &units, target, cfg, floors, name == "test");
        let mut report = report_of(features, &result, cfg, floors, name, target);
        report.input_sessions = input_sessions;
        report.duplicates = duplicates;
        report.orphan_pairs = orphans;
        report.reserved_out = reserved_out;
        if name == "train" {
            train_units = units;
        }
        chosen.insert(name.to_owned(), result.picked);
        reports.push(report);
    }
    reports.reverse();

    // nested train subsets: the larger chosen set is the input of the smaller
    let mut subsets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut subset_reports = Vec::new();
    let mut sizes = cfg.subsets.clone();
    sizes.sort_unstable();
    sizes.dedup();
    let mut within: BTreeSet<usize> = chosen["train"].iter().copied().collect();
    for size in sizes.into_iter().rev() {
        if size >= within.len() {
            // the subset is the whole of the one above it
            subsets.insert(format!("train-{size}"), within.iter().copied().collect());
            let name = format!("train-{size}");
            subset_reports.push(SplitReport {
                split: name,
                target_sessions: size,
                sessions: within.len(),
                missed: vec![format!(
                    "{size} sessions wanted, the set it is cut from holds {}",
                    within.len()
                )],
                ..SplitReport::default()
            });
            continue;
        }
        let units: Vec<Unit> = train_units
            .iter()
            .filter(|u| u.members.iter().all(|m| within.contains(m)))
            .map(|u| Unit {
                members: u.members.clone(),
                tie: u.tie,
            })
            .collect();
        let scaled_floor = |floor: usize| (floor * size).div_ceil(cfg.targets[0].max(1));
        let floors = (scaled_floor(cfg.floor[0]), scaled_floor(cfg.field_floor[0]));
        let result = select(features, &units, size, cfg, floors, false);
        let name = format!("train-{size}");
        let mut report = report_of(features, &result, cfg, floors, &name, size);
        report.input_sessions = within.len();
        within = result.picked.iter().copied().collect();
        subsets.insert(name, result.picked);
        subset_reports.push(report);
    }
    subset_reports.reverse();

    // reserved combinations: in test only
    for split in ["train", "val"] {
        for i in &chosen[split] {
            if let Some(c) = reserved_in(&features[*i], &reserved).next() {
                bail!(
                    "the reserved combination {c} is in {split} (session {}): reserved combinations are test only",
                    features[*i].id
                );
            }
        }
    }
    let mut reserved_counts: BTreeMap<String, usize> =
        cfg.reserved.iter().map(|c| (c.clone(), 0)).collect();
    for i in &chosen["test"] {
        for c in reserved_in(&features[*i], &reserved) {
            *reserved_counts.entry(c.clone()).or_default() += 1;
        }
    }

    // noise follows val
    let val: BTreeSet<&str> = chosen["val"]
        .iter()
        .map(|i| features[*i].id.as_str())
        .collect();
    let noise: Vec<usize> = (0..features.len())
        .filter(|i| {
            features[*i].split == "noise"
                && features[*i]
                    .id
                    .strip_suffix("~noise")
                    .is_some_and(|base| val.contains(base))
        })
        .collect();
    chosen.insert("noise".to_owned(), noise);
    // in one split only
    let mut home: BTreeMap<&str, &str> = BTreeMap::new();
    for (split, indices) in &chosen {
        if split == "noise" {
            continue;
        }
        for i in indices {
            if let Some(other) = home.insert(&features[*i].world, split)
                && other != split
            {
                bail!(
                    "world {} is in both {other} and {split}",
                    features[*i].world
                );
            }
        }
    }
    Ok(Selection {
        chosen,
        subsets,
        reports,
        subset_reports,
        reserved: reserved_counts,
    })
}

fn report_lines(out: &mut String, r: &SplitReport) {
    out.push_str(&format!(
        "== {} — {} of {} wanted ({} in the input; {} duplicates, {} sessions of broken pairs, {} with a reserved combination); {} turns, {} tokens, {} minimal or ask-or-act pairs ({} ask-or-act)\n",
        r.split, r.sessions, r.target_sessions, r.input_sessions, r.duplicates, r.orphan_pairs, r.reserved_out,
        r.turns, r.tokens, r.pairs, r.ask_or_act_pairs
    ));
    out.push_str(&format!(
        "   multi-turn {:.1}% (3+ {:.1}%)\n",
        r.multi_turn_share * 100.0,
        r.three_plus_share * 100.0
    ));
    out.push_str("   turns per session  target  realised  supply\n");
    for l in &r.by_turns {
        out.push_str(&format!(
            "   {:<16} {:>9.0} {:>9.0} {:>7.0}\n",
            l.name, l.target, l.realised, l.supply
        ));
    }
    for share in &r.shares {
        let total: f64 = share.lines.iter().map(|l| l.realised).sum();
        out.push_str(&format!(
            "   {} ({}): target% realised% | target realised supply\n",
            share.share, share.unit
        ));
        let target_total: f64 = share.lines.iter().map(|l| l.target).sum();
        for l in &share.lines {
            out.push_str(&format!(
                "   {:<16} {:>6.1}% {:>7.1}% | {:>8.0} {:>8.0} {:>7.0}\n",
                l.name,
                100.0 * l.target / target_total.max(1.0),
                100.0 * l.realised / total.max(1.0),
                l.target,
                l.realised,
                l.supply
            ));
        }
    }
    out.push_str("   apps (a tag, not a target)  sessions\n");
    for l in &r.apps {
        out.push_str(&format!("   {:<16} {:>9.0}\n", l.name, l.realised));
    }
    if !r.cells.is_empty() {
        out.push_str(
            "   cells (turns)                                     need realised supply status\n",
        );
        for c in &r.cells {
            out.push_str(&format!(
                "   {:<44} {:>8.1} {:>8} {:>6} {}\n",
                c.cell, c.target, c.realised, c.supply, c.status
            ));
        }
    }
    if !r.fields.is_empty() {
        out.push_str(
            "   fields (turns that set a (kind, field) pair)       need realised supply status\n",
        );
        for c in &r.fields {
            out.push_str(&format!(
                "   {:<44} {:>8.1} {:>8} {:>6} {}\n",
                c.cell, c.target, c.realised, c.supply, c.status
            ));
        }
    }
    if !r.caps.is_empty() {
        out.push_str(
            "   ceilings (never over)                              cap%  realised  of  supply\n",
        );
        for c in &r.caps {
            out.push_str(&format!(
                "   {:<50} {:>5.1} {:>9} {:>3} {:>7}\n",
                c.name,
                c.cap * 100.0,
                c.realised,
                c.base,
                c.supply
            ));
        }
    }
    for m in &r.missed {
        out.push_str(&format!("   could not hit: {m}\n"));
    }
    out.push('\n');
}

/// The report as text.
#[must_use]
pub fn text(selection: &Selection) -> String {
    let mut out = String::new();
    for r in selection.reports.iter().chain(&selection.subset_reports) {
        report_lines(&mut out, r);
    }
    if !selection.reserved.is_empty() {
        out.push_str("reserved combinations (test only): test sessions carrying each\n");
        for (combo, n) in &selection.reserved {
            out.push_str(&format!("   {combo:<48} {n}\n"));
        }
    }
    out.push_str(&format!(
        "noise: {} sessions (the heavy-typo copy of the chosen val)\n",
        selection.chosen.get("noise").map_or(0, Vec::len)
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CELLS: [&str; 6] = [
        "find/task/read",
        "compute/task/count",
        "do/task/complete",
        "create/note/-",
        "ask/person/ask",
        "decline/-/out_of_scope",
    ];

    /// A session of `n` turns whose cells, outcomes, actions and references follow from its position `i`.
    fn session(id: &str, split: &str, world: &str, i: usize, n: usize, key: &str) -> Features {
        let cells: Vec<&str> = (0..n).map(|k| CELLS[(i + k) % CELLS.len()]).collect();
        let by = |f: fn(&str) -> &'static str| -> Vec<String> {
            cells.iter().map(|c| f(c).to_owned()).collect()
        };
        Features {
            id: id.to_owned(),
            split: split.to_owned(),
            world: world.to_owned(),
            app: ["tasks", "people"][i % 2].to_owned(),
            apps: vec![["tasks", "people"][i % 2].to_owned()],
            cells: cells.iter().map(|c| (*c).to_owned()).collect(),
            turns: n,
            key: key.to_owned(),
            tokens: 100,
            outcomes: by(|c| match c {
                "ask/person/ask" => "ask",
                "decline/-/out_of_scope" => "decline",
                _ => "done",
            }),
            actions: by(|c| match c {
                "find/task/read" | "compute/task/count" => "read",
                "do/task/complete" | "create/note/-" => "write",
                _ => "",
            }),
            refs: by(|c| match c {
                "find/task/read" => "filters",
                "do/task/complete" => "name",
                "ask/person/ask" => "nickname",
                _ => "",
            }),
            impossible: cells.iter().map(|c| c.starts_with("decline")).collect(),
            kinds: if i.is_multiple_of(5) {
                vec!["note".into(), "task".into()]
            } else {
                vec!["task".into()]
            },
            combos: vec![format!("kf:task:f{}", i % 7)],
            ..Features::default()
        }
    }

    fn input() -> (Vec<Features>, Config) {
        let mut all = Vec::new();
        for w in 0..6 {
            for i in 0..400 {
                let split = match w {
                    0..=3 => "train",
                    4 => "val",
                    _ => "test",
                };
                all.push(session(
                    &format!("{split}-{w}-{i}"),
                    split,
                    &format!("{split}-{w}"),
                    i,
                    1 + (i % 3),
                    &format!("k{w}-{i}"),
                ));
            }
        }
        // a duplicate of a test session inside train, a pair, an orphan, noise
        let mut dup = session("train-dup", "train", "train-0", 0, 1, "k5-0");
        dup.turns = 1;
        all.push(dup);
        for id in ["train-0-pairA", "train-1-pairA"] {
            let mut a = session(id, "train", "train-0", 0, 1, &format!("{id}x"));
            let mut b = session(
                &id.replace('A', "B"),
                "train",
                "train-0",
                0,
                1,
                &format!("{id}y"),
            );
            a.pair = Some(format!("pair:{id}"));
            b.pair = Some(format!("pair:{id}"));
            all.push(a);
            if id == "train-0-pairA" {
                all.push(b); // the other pair keeps only one member: an orphan
            }
        }
        for i in 0..100 {
            let mut n = session(
                &format!("val-4-{i}~noise"),
                "noise",
                "val-4",
                i,
                1,
                &format!("n{i}"),
            );
            n.turns = 1;
            all.push(n);
        }
        let cfg = Config {
            targets: [600, 80, 80],
            live: CELLS.iter().map(|c| (*c).to_owned()).collect(),
            floor: [30, 0, 0],
            subsets: vec![150, 300],
            ..Config::default()
        };
        (all, cfg)
    }

    fn report<'a>(selection: &'a Selection, split: &str) -> &'a SplitReport {
        selection
            .reports
            .iter()
            .chain(&selection.subset_reports)
            .find(|r| r.split == split)
            .unwrap()
    }

    #[test]
    fn a_mix_hits_its_targets_keeps_pairs_whole_and_drops_duplicates() {
        let (all, cfg) = input();
        let selection = mix(&all, &cfg).unwrap();
        for (split, target) in [("train", 600), ("val", 80), ("test", 80)] {
            assert_eq!(selection.chosen[split].len(), target, "{split}");
        }
        assert!(
            !selection.chosen["train"]
                .iter()
                .any(|i| all[*i].id == "train-dup")
        );
        let ids: BTreeSet<&str> = selection.chosen["train"]
            .iter()
            .map(|i| all[*i].id.as_str())
            .collect();
        assert_eq!(ids.contains("train-0-pairA"), ids.contains("train-0-pairB"));
        assert!(!ids.contains("train-1-pairA"));
        for r in &selection.reports {
            assert!(
                r.multi_turn_share >= 0.5,
                "{}: {}",
                r.split,
                r.multi_turn_share
            );
            assert!(r.three_plus_share > 0.2, "{}", r.split);
        }
        let val_ids: BTreeSet<&str> = selection.chosen["val"]
            .iter()
            .map(|i| all[*i].id.as_str())
            .collect();
        for i in &selection.chosen["noise"] {
            assert!(val_ids.contains(all[*i].id.trim_end_matches("~noise")));
        }
        let mut home = BTreeMap::new();
        for split in SPLITS {
            for i in &selection.chosen[split] {
                assert_eq!(*home.entry(&all[*i].world).or_insert(split), split);
            }
        }
    }

    #[test]
    fn a_mix_is_a_pure_function_of_its_input_and_seed() {
        let (all, cfg) = input();
        let a = mix(&all, &cfg).unwrap();
        let b = mix(&all, &cfg).unwrap();
        assert_eq!(a.chosen, b.chosen);
        assert_eq!(a.subsets, b.subsets);
    }

    #[test]
    fn every_live_cell_reaches_the_floor_in_train_and_the_app_is_no_target() {
        let (all, cfg) = input();
        let selection = mix(&all, &cfg).unwrap();
        let train = report(&selection, "train");
        for c in &train.cells {
            assert!(c.realised >= 30, "{c:?}");
            assert_eq!(c.status, "hit");
        }
        // the app is a line of the report with no target
        assert!(train.apps.iter().all(|a| a.target == 0.0));
        // a floor the input cannot meet is reported as supply-limited, not faked
        let mut thin = all.clone();
        thin.retain(|f| {
            f.split != "train"
                || f.cells.iter().all(|c| c != "create/note/-")
                || f.id.ends_with('0')
        });
        let selection = mix(&thin, &cfg).unwrap();
        let cell = report(&selection, "train")
            .cells
            .iter()
            .find(|c| c.cell == "create/note/-")
            .unwrap();
        assert!(cell.realised <= cell.supply);
        if cell.realised < 30 {
            assert_eq!(cell.status, "supply");
        }
    }

    #[test]
    fn shares_are_met_when_the_input_holds_them() {
        let (all, mut cfg) = input();
        // the synthetic input has no repair or empty turn, nor a recall, so those targets are supply-limited
        cfg.shares.outcome = [0.70, 0.0, 0.15, 0.15, 0.0];
        cfg.shares.action = [0.5, 0.5, 0.0];
        cfg.shares.reference = [0.4, 0.4, 0.0, 0.2];
        cfg.shares.impossible = 0.15;
        let selection = mix(&all, &cfg).unwrap();
        let train = report(&selection, "train");
        let share = |name: &str, label: &str| {
            let s = train.shares.iter().find(|s| s.share == name).unwrap();
            let total: f64 = s.lines.iter().map(|l| l.realised).sum();
            s.lines.iter().find(|l| l.name == label).unwrap().realised / total
        };
        assert!(
            (share("outcome", "done") - 0.70).abs() < 0.06,
            "{}",
            share("outcome", "done")
        );
        assert!((share("outcome", "decline") - 0.15).abs() < 0.06);
        assert!((share("impossible", "impossible") - 0.15).abs() < 0.06);
        assert!((share("kinds", "two_kinds") - 0.20).abs() < 0.06);
        assert!((share("action", "read") - 0.5).abs() < 0.08);
    }

    #[test]
    fn what_the_input_cannot_give_is_reported_not_faked() {
        let (mut all, mut cfg) = input();
        all.retain(|f| !f.outcomes.iter().any(|o| o == "repair"));
        cfg.targets = [10_000, 40, 40];
        let selection = mix(&all, &cfg).unwrap();
        let train = report(&selection, "train");
        assert!(train.sessions < 10_000);
        assert!(train.missed.iter().any(|m| m.contains("wanted")));
        // the input holds no repair turn: the report shows a repair share with no supply
        let outcome = train
            .shares
            .iter()
            .find(|s| s.share == "outcome")
            .expect("the outcome share is reported");
        let repair = outcome
            .lines
            .iter()
            .find(|l| l.name == "repair")
            .expect("repair is a line");
        assert!(repair.supply == 0.0 && repair.realised == 0.0);
    }

    #[test]
    fn half_the_sessions_have_two_turns_or_more_whatever_the_shares_pull_toward() {
        let (all, mut cfg) = input();
        cfg.shares.one = 0.9;
        cfg.shares.two = 0.05;
        cfg.shares.three_plus = 0.05;
        let selection = mix(&all, &cfg).unwrap();
        for r in &selection.reports {
            assert!(
                r.multi_turn_share >= 0.5,
                "{}: {}",
                r.split,
                r.multi_turn_share
            );
        }
    }

    #[test]
    fn nested_train_subsets_are_inside_each_other_and_keep_the_floor_in_proportion() {
        let (all, cfg) = input();
        let selection = mix(&all, &cfg).unwrap();
        let (small, mid, train) = (
            &selection.subsets["train-150"],
            &selection.subsets["train-300"],
            &selection.chosen["train"],
        );
        assert_eq!((small.len(), mid.len()), (150, 300));
        let mid_set: BTreeSet<_> = mid.iter().collect();
        let train_set: BTreeSet<_> = train.iter().collect();
        assert!(small.iter().all(|i| mid_set.contains(i)));
        assert!(mid.iter().all(|i| train_set.contains(i)));
        // a subset is balanced by the same procedure: its cells are all present
        assert!(
            report(&selection, "train-150")
                .cells
                .iter()
                .all(|c| c.realised > 0)
        );
    }

    #[test]
    fn a_reserved_combination_is_only_in_test() {
        let (all, mut cfg) = input();
        cfg.reserved = vec!["kf:task:f3".to_owned(), "kf:task:f5".to_owned()];
        let selection = mix(&all, &cfg).unwrap();
        for split in ["train", "val"] {
            for i in &selection.chosen[split] {
                assert!(
                    all[*i].combos.iter().all(|c| !cfg.reserved.contains(c)),
                    "{split} holds {:?}",
                    all[*i].combos
                );
            }
        }
        assert!(
            selection.chosen["test"]
                .iter()
                .any(|i| all[*i].combos.iter().any(|c| cfg.reserved.contains(c)))
        );
        assert!(
            selection.reserved.values().all(|n| *n > 0),
            "{:?}",
            selection.reserved
        );
        assert!(report(&selection, "train").reserved_out > 0);
    }

    #[test]
    fn a_world_in_two_splits_is_refused() {
        let (mut all, cfg) = input();
        all[0].world = "val-4".to_owned();
        assert!(mix(&all, &cfg).is_err());
    }

    /// The input with a pair of `create` or `edit` on some sessions: one everywhere, one on a few, one on fewer than the
    /// floor, and one (never drawn) the config names live.
    fn with_fields(all: &mut [Features]) -> Vec<String> {
        for (n, f) in all.iter_mut().enumerate() {
            if f.split == "noise" {
                continue;
            }
            f.fields = vec!["create/task/name".to_owned()];
            if n % 50 == 0 {
                f.fields.push("create/task/priority".to_owned());
            }
            if n % 133 == 0 {
                f.fields.push("edit/task/effort".to_owned());
            }
        }
        vec![
            "create/task/name".to_owned(),
            "create/task/priority".to_owned(),
            "edit/task/effort".to_owned(),
            "edit/person/role".to_owned(),
        ]
    }

    #[test]
    fn fields_are_a_balanced_dimension_with_a_floor_and_a_line_of_the_report_per_pair() {
        let (mut all, mut cfg) = input();
        cfg.live_fields = with_fields(&mut all);
        let selection = mix(&all, &cfg).unwrap();
        let train = report(&selection, "train");
        // the report lists every live pair, like the cells
        let listed: Vec<&str> = train.fields.iter().map(|c| c.cell.as_str()).collect();
        assert_eq!(
            listed,
            cfg.live_fields
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        let line = |name: &str| train.fields.iter().find(|c| c.cell == name).unwrap();
        // a pair the input holds enough of reaches the floor of 30 turns, though it is on 2% of the sessions
        let rare = line("create/task/priority");
        assert!(rare.supply >= 30, "{rare:?}");
        assert!(rare.realised >= 30 && rare.status == "hit", "{rare:?}");
        assert_eq!(line("create/task/name").status, "hit");
        // a pair the input holds less than the floor of is reported as the supply's, with all of it taken
        let thin = line("edit/task/effort");
        assert!(thin.supply < 30 || thin.status == "hit", "{thin:?}");
        if thin.supply < 30 {
            assert_eq!(
                (thin.status, thin.realised),
                ("supply", thin.supply),
                "{thin:?}"
            );
        }
        // a pair no session sets is reported with no supply, never faked
        let never = line("edit/person/role");
        assert_eq!(
            (never.supply, never.realised, never.status),
            (0, 0, "supply")
        );
        assert!(
            train
                .missed
                .iter()
                .any(|m| m.contains("(kind, field) pairs"))
        );
        // the report text has the pairs
        let text = text(&selection);
        assert!(text.contains("create/task/priority") && text.contains("fields (turns"));
        // val and test have no floor, as the cells have none: the pairs are reported against the uniform target
        assert_eq!(report(&selection, "val").fields.len(), 4);
    }

    #[test]
    fn a_train_cell_or_pair_under_its_floor_fails_the_build_naming_it_and_all_at_the_floor_passes()
    {
        let (mut all, mut cfg) = input();
        cfg.live_fields = with_fields(&mut all);
        cfg.field_floor = [30, 0, 0];
        // the input holds enough of every cell and of the pair that has fewer sessions: all at the floor, nothing is named
        let selection = mix(&all, &cfg).unwrap();
        let under = under_floor(&selection, &cfg);
        // the pairs `with_fields` leaves thin or never sets are under; take them away to have a config at its floor
        let mut at_floor = cfg.clone();
        at_floor
            .live_fields
            .retain(|f| !under.iter().any(|u| u.of == "field" && &u.name == f));
        let selection = mix(&all, &at_floor).unwrap();
        assert!(under_floor(&selection, &at_floor).is_empty());
        check_floors(&selection, &at_floor).unwrap();
        // one cell with too little in the input: the error names it with its count and the floor, and only it (the one pair
        // left is on every session, so thinning the input leaves it at its floor)
        at_floor.live_fields = vec!["create/task/name".to_owned()];
        let mut thin = all.clone();
        let mut left = 5;
        thin.retain(|f| {
            f.split != "train" || f.cells.iter().all(|c| c != "create/note/-") || {
                left -= 1;
                left >= 0
            }
        });
        let selection = mix(&thin, &at_floor).unwrap();
        let cell = report(&selection, "train")
            .cells
            .iter()
            .find(|c| c.cell == "create/note/-")
            .unwrap()
            .clone();
        assert!(
            cell.realised < 30,
            "the fixture is under the floor: {cell:?}"
        );
        let under = under_floor(&selection, &at_floor);
        assert_eq!(
            under,
            vec![Under {
                of: "cell",
                name: "create/note/-".to_owned(),
                realised: cell.realised,
                floor: 30
            }]
        );
        let error = check_floors(&selection, &at_floor).unwrap_err().to_string();
        assert!(
            error.contains(&format!("cell create/note/-: {} of 30", cell.realised)),
            "{error}"
        );
        assert!(error.contains("1 live cell(s) and 0 live (kind, field) pair(s)"));
        // a pair under its floor is named the same way, beside the cell
        let mut with_pair = at_floor.clone();
        with_pair.live_fields.push("edit/person/role".to_owned());
        let selection = mix(&thin, &with_pair).unwrap();
        let error = check_floors(&selection, &with_pair)
            .unwrap_err()
            .to_string();
        assert!(error.contains("field edit/person/role: 0 of 30"), "{error}");
        assert!(error.contains("cell create/note/-"), "{error}");
        // no floor asks nothing
        let mut none = with_pair.clone();
        none.floor = [0; 3];
        none.field_floor = [0; 3];
        check_floors(&mix(&thin, &none).unwrap(), &none).unwrap();
    }

    #[test]
    fn a_pair_the_floor_does_not_reach_in_a_thin_input_is_still_chosen_whole() {
        let (mut all, mut cfg) = input();
        cfg.live_fields = with_fields(&mut all);
        // only 12 sessions of train carry the pair: all 12 are chosen
        let mut carried = 0;
        for f in all.iter_mut().filter(|f| f.split == "train") {
            f.fields.retain(|x| x != "create/task/priority");
            if carried < 12 {
                f.fields.push("create/task/priority".to_owned());
                carried += 1;
            }
        }
        let selection = mix(&all, &cfg).unwrap();
        let line = report(&selection, "train")
            .fields
            .iter()
            .find(|c| c.cell == "create/task/priority")
            .unwrap()
            .clone();
        assert_eq!(
            (line.supply, line.realised, line.status),
            (12, 12, "supply")
        );
    }

    /// The input with an over-supply of pronoun references and of undo turns.
    fn heavy(all: &mut [Features]) {
        for (n, f) in all.iter_mut().enumerate() {
            if n % 5 == 0 {
                f.cells[0] = "do/-/undo".to_owned();
                f.actions[0] = "recall".to_owned();
                f.refs[0] = String::new();
            }
            for r in f.refs.iter_mut().filter(|r| !r.is_empty()) {
                if n % 4 != 0 {
                    *r = "pronoun".to_owned();
                }
            }
        }
    }

    #[test]
    fn pronoun_references_and_undo_turns_are_capped_so_the_share_never_goes_over() {
        let (mut all, mut cfg) = input();
        cfg.live.push("do/-/undo".to_owned());
        heavy(&mut all);
        // the input holds far more of both than the ceilings allow
        let (mut pronoun, mut refs, mut undo, mut turns) = (0, 0, 0, 0);
        for f in all.iter().filter(|f| f.split == "train") {
            pronoun += f.refs.iter().filter(|r| *r == "pronoun").count();
            refs += f.refs.iter().filter(|r| !r.is_empty()).count();
            undo += f.cells.iter().filter(|c| *c == "do/-/undo").count();
            turns += f.turns;
        }
        assert!(pronoun as f64 > 0.3 * refs as f64, "{pronoun} of {refs}");
        assert!(undo as f64 > 0.1 * turns as f64, "{undo} of {turns}");
        let selection = mix(&all, &cfg).unwrap();
        for r in selection.reports.iter().chain(&selection.subset_reports) {
            let (chosen, counts) = match r.split.as_str() {
                "train" | "val" | "test" => (&selection.chosen[&r.split], true),
                name => (&selection.subsets[name], true),
            };
            assert!(counts && !chosen.is_empty(), "{}", r.split);
            let (mut p, mut n, mut u, mut t) = (0, 0, 0, 0);
            for i in chosen {
                let f = &all[*i];
                p += f.refs.iter().filter(|r| *r == "pronoun").count();
                n += f.refs.iter().filter(|r| !r.is_empty()).count();
                u += f.cells.iter().filter(|c| *c == "do/-/undo").count();
                t += f.turns;
            }
            assert!(
                p as f64 <= cfg.shares.reference[2] * n as f64 + 1e-9,
                "{}: {p} pronoun of {n} references",
                r.split
            );
            assert!(
                u as f64 <= cfg.undo_cap * t as f64 + 1e-9,
                "{}: {u} undo of {t} turns",
                r.split
            );
            // the report says the same
            for cap in &r.caps {
                assert!(
                    cap.realised as f64 <= cap.cap * cap.base as f64 + 1e-9,
                    "{}: {cap:?}",
                    r.split
                );
            }
        }
        // and the selection still has what it can: some of each is chosen, not none
        let train = report(&selection, "train");
        assert!(
            train.caps.iter().all(|c| c.realised > 0),
            "{:?}",
            train.caps
        );
        assert_eq!(selection.chosen["train"].len(), 600);
    }

    #[test]
    fn water_fill_gives_what_a_short_cell_cannot_use_to_the_others() {
        let supply: BTreeMap<String, usize> = [("a", 2), ("b", 100), ("c", 100)]
            .map(|(k, v)| (k.to_owned(), v))
            .into();
        let t = water_fill(&supply, 90.0);
        assert!((t["a"] - 2.0).abs() < 1e-9);
        assert!((t["b"] - 44.0).abs() < 1e-9 && (t["c"] - 44.0).abs() < 1e-9);
    }

    #[test]
    fn weighted_fill_caps_a_label_at_its_supply_and_hands_the_rest_on() {
        let shares = vec![("x".to_owned(), 0.5), ("y".to_owned(), 0.5)];
        let supply: BTreeMap<String, usize> = [("x".to_owned(), 10), ("y".to_owned(), 1000)].into();
        let t = weighted_fill(&shares, &supply, 100.0);
        assert!(
            (t["x"] - 10.0).abs() < 1e-9 && (t["y"] - 90.0).abs() < 1e-9,
            "{t:?}"
        );
    }
}
