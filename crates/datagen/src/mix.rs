//! STAGE 7, MIX: choose the sessions of a data version from a larger rendered input.
//!
//! The input is every rendered session (`render`): the splits were drawn by world seed before any session existed, so a
//! world is in one split by construction, and [`mix`] asserts it. What is chosen from each split:
//!
//! 1. **Duplicates out.** A session's key is the BLAKE3 of its normalised user texts and its gold. The held-out splits are
//!    read first (test, then val, then train), so a session of train that repeats one of them is the one dropped.
//! 2. **Minimal pairs together.** The two sessions tagged `pair:<id>` are one unit: both or neither. A pair whose twin is
//!    gone (dropped upstream, or a duplicate) is not kept alone.
//! 3. **Targets.** Each split has a number of sessions and the shares below. Units are chosen greedily by how much of each
//!    still-open target they fill, which is exact lazily (a deficit only shrinks as sessions are added):
//!    * **cells**: the grid's live cells share the split's turns equally (water-filled: a cell the input cannot fill gives
//!      its share to the others), counted over every turn of every session;
//!    * **apps**: each app, by the first app a session names, gets an equal share of the sessions;
//!    * **turns**: one, two, and three-or-more turns ([`Shares`]: 40 / 30 / 30 by default, so 60% of sessions have two
//!      or more turns and 30% carry the 3+ block);
//!    * **span**: the share of sessions that join two apps ([`Shares::across`], 30%).
//! 4. **Noise** is the heavy-typo copy of val: the noise sessions whose val session was chosen, no more and no fewer.
//!
//! Mixing downsamples. What the input cannot give is reported, per cell and per share, with the target, the realised
//! count and the supply: nothing is faked to hit a number.

use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

use anyhow::{Result, bail};
use serde::Serialize;

use crate::render::Features;
use crate::rng::Rng;

/// The shares a mixed split aims at.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Shares {
    pub one: f64,
    pub two: f64,
    pub three_plus: f64,
    pub across: f64,
}

impl Default for Shares {
    fn default() -> Self {
        Self {
            one: 0.40,
            two: 0.30,
            three_plus: 0.30,
            across: 0.30,
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
    /// `hit` (realised reaches the target), `supply` (the input holds no more) or `short` (the mix left it under).
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct Line {
    pub name: String,
    pub target: f64,
    pub realised: f64,
    pub supply: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SplitReport {
    pub split: String,
    pub target_sessions: usize,
    pub input_sessions: usize,
    pub duplicates: usize,
    pub orphan_pairs: usize,
    pub supply_sessions: usize,
    pub sessions: usize,
    pub turns: usize,
    pub tokens: usize,
    pub pairs: usize,
    pub by_turns: Vec<Line>,
    pub across: Line,
    pub multi_turn_share: f64,
    pub three_plus_share: f64,
    pub apps: Vec<Line>,
    pub cells: Vec<CellLine>,
    /// What the input could not give, in words.
    pub missed: Vec<String>,
}

impl Default for Line {
    fn default() -> Self {
        Self {
            name: String::new(),
            target: 0.0,
            realised: 0.0,
            supply: 0.0,
        }
    }
}

/// The sessions chosen, by index into the features, and the report.
#[derive(Debug, Clone, Serialize)]
pub struct Selection {
    /// `train`, `val`, `test` and `noise`.
    pub chosen: BTreeMap<String, Vec<usize>>,
    pub reports: Vec<SplitReport>,
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

/// Mix `features`.
///
/// # Errors
///
/// If a world turns up in two splits.
#[allow(clippy::too_many_lines)]
pub fn mix(features: &[Features], cfg: &Config) -> Result<Selection> {
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
    // held-out splits first, so a duplicate is dropped from train
    for (name, target) in [
        ("test", cfg.targets[2]),
        ("val", cfg.targets[1]),
        ("train", cfg.targets[0]),
    ] {
        let mut report = SplitReport {
            split: name.to_owned(),
            target_sessions: target,
            ..SplitReport::default()
        };
        let mine: Vec<usize> = (0..features.len())
            .filter(|i| features[*i].split == name)
            .collect();
        report.input_sessions = mine.len();
        // duplicates
        let mut kept: Vec<usize> = Vec::new();
        for i in mine {
            if seen.insert(&features[i].key) {
                kept.push(i);
            } else {
                report.duplicates += 1;
            }
        }
        // pairs
        let mut by_pair: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        let mut units: Vec<Unit> = Vec::new();
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
                report.orphan_pairs += members.len();
            }
        }
        units.sort_by_key(|u| u.members[0]);
        let supply_sessions: usize = units.iter().map(|u| u.members.len()).sum();
        report.supply_sessions = supply_sessions;
        let want = target.min(supply_sessions);

        // supplies and targets
        let mut cell_supply: BTreeMap<String, usize> = BTreeMap::new();
        let mut app_supply: BTreeMap<String, usize> = BTreeMap::new();
        let mut bucket_supply = [0_usize; 3];
        let mut across_supply = 0_usize;
        let mut turns_supply = 0_usize;
        for u in &units {
            for m in &u.members {
                let f = &features[*m];
                for c in &f.cells {
                    *cell_supply.entry(c.clone()).or_default() += 1;
                }
                *app_supply.entry(f.app.clone()).or_default() += 1;
                bucket_supply[bucket(f.turns)] += 1;
                across_supply += usize::from(f.across);
                turns_supply += f.turns;
            }
        }
        let live: BTreeSet<&String> = cfg.live.iter().collect();
        let eligible: BTreeMap<String, usize> = cell_supply
            .iter()
            .filter(|(c, _)| live.contains(c))
            .map(|(c, n)| (c.clone(), *n))
            .collect();
        let avg_turns = turns_supply as f64 / supply_sessions.max(1) as f64;
        let cell_target = water_fill(&eligible, want as f64 * avg_turns);
        let app_target = water_fill(&app_supply, want as f64);
        let shares = [cfg.shares.one, cfg.shares.two, cfg.shares.three_plus];
        let bucket_target: Vec<f64> = {
            let supply: BTreeMap<String, usize> =
                (0..3).map(|b| (b.to_string(), bucket_supply[b])).collect();
            // water-fill weighted: scale by share, cap by supply, hand the rest on
            let mut out = vec![0.0; 3];
            let mut left = want as f64;
            let mut open: Vec<usize> = (0..3).collect();
            while !open.is_empty() && left > 1e-9 {
                let weight: f64 = open.iter().map(|b| shares[*b]).sum();
                let mut capped = Vec::new();
                for b in &open {
                    let ask = left * shares[*b] / weight.max(1e-9);
                    let room = supply[&b.to_string()] as f64 - out[*b];
                    if ask >= room - 1e-9 {
                        capped.push(*b);
                    }
                }
                if capped.is_empty() {
                    for b in &open {
                        out[*b] += left * shares[*b] / weight.max(1e-9);
                    }
                    break;
                }
                for b in &capped {
                    let room = supply[&b.to_string()] as f64 - out[*b];
                    out[*b] += room;
                    left -= room;
                }
                open.retain(|b| !capped.contains(b));
            }
            out
        };
        let across_target = (want as f64 * cfg.shares.across).min(across_supply as f64);

        // greedy, lazily
        let mut got_cell: BTreeMap<String, usize> = BTreeMap::new();
        let mut got_app: BTreeMap<String, usize> = BTreeMap::new();
        let mut got_bucket = [0_usize; 3];
        let mut got_across = 0_usize;
        let mut got_sessions = 0_usize;
        let deficit = |target: f64, got: usize| -> f64 {
            if target <= 0.0 {
                -0.5
            } else {
                ((target - got as f64) / target).clamp(-0.5, 1.0)
            }
        };
        let score = |unit: &Unit,
                     got_cell: &BTreeMap<String, usize>,
                     got_app: &BTreeMap<String, usize>,
                     got_bucket: &[usize; 3],
                     got_across: usize,
                     got_sessions: usize|
         -> f64 {
            let mut total = 0.0;
            for m in &unit.members {
                let f = &features[*m];
                let cells: f64 = f
                    .cells
                    .iter()
                    .map(|c| {
                        deficit(
                            cell_target.get(c).copied().unwrap_or(0.0),
                            got_cell.get(c).copied().unwrap_or(0),
                        )
                    })
                    .sum::<f64>()
                    / f.cells.len().max(1) as f64;
                let app = deficit(
                    app_target.get(&f.app).copied().unwrap_or(0.0),
                    got_app.get(&f.app).copied().unwrap_or(0),
                );
                let turns = deficit(bucket_target[bucket(f.turns)], got_bucket[bucket(f.turns)]);
                let across = if f.across {
                    deficit(across_target, got_across)
                } else {
                    deficit(want as f64 - across_target, got_sessions - got_across)
                };
                total += cells + app + 1.5 * turns + across;
            }
            total / unit.members.len() as f64
        };
        let mut heap: BinaryHeap<(i64, u64, usize)> = units
            .iter()
            .enumerate()
            .map(|(i, u)| {
                (
                    scaled(score(
                        u,
                        &got_cell,
                        &got_app,
                        &got_bucket,
                        got_across,
                        got_sessions,
                    )),
                    u.tie,
                    i,
                )
            })
            .collect();
        let mut picked: Vec<usize> = Vec::new();
        // the floor of the issue: at least half the sessions have two turns or more, whatever else the targets pull toward
        // (as many as the input holds)
        let multi_supply = bucket_supply[1] + bucket_supply[2];
        let multi_floor = want.div_ceil(2).min(multi_supply);
        while got_sessions < want {
            let Some((_, tie, i)) = heap.pop() else {
                break;
            };
            // once the sessions left to choose are all needed to reach the floor, a unit that does not help is out
            let still_needed = multi_floor.saturating_sub(got_bucket[1] + got_bucket[2]);
            let len = units[i].members.len();
            let multi_here = units[i]
                .members
                .iter()
                .filter(|m| features[**m].turns >= 2)
                .count();
            if still_needed > 0
                && want - got_sessions < len + still_needed.saturating_sub(multi_here)
            {
                continue;
            }
            let now = scaled(score(
                &units[i],
                &got_cell,
                &got_app,
                &got_bucket,
                got_across,
                got_sessions,
            ));
            if let Some((next, _, _)) = heap.peek()
                && now < *next
            {
                heap.push((now, tie, i));
                continue;
            }
            for m in &units[i].members {
                let f = &features[*m];
                for c in &f.cells {
                    *got_cell.entry(c.clone()).or_default() += 1;
                }
                *got_app.entry(f.app.clone()).or_default() += 1;
                got_bucket[bucket(f.turns)] += 1;
                got_across += usize::from(f.across);
                got_sessions += 1;
                picked.push(*m);
            }
        }
        picked.sort_unstable();

        // the report
        let turns: usize = picked.iter().map(|i| features[*i].turns).sum();
        report.sessions = picked.len();
        report.turns = turns;
        report.tokens = picked.iter().map(|i| features[*i].tokens).sum();
        report.pairs = picked
            .iter()
            .filter(|i| features[**i].pair.is_some())
            .count()
            / 2;
        let n = picked.len().max(1) as f64;
        report.by_turns = ["1", "2", "3+"]
            .iter()
            .enumerate()
            .map(|(b, name)| Line {
                name: (*name).to_owned(),
                target: want as f64 * shares[b],
                realised: got_bucket[b] as f64,
                supply: bucket_supply[b] as f64,
            })
            .collect();
        report.across = Line {
            name: "across".to_owned(),
            target: want as f64 * cfg.shares.across,
            realised: got_across as f64,
            supply: across_supply as f64,
        };
        report.multi_turn_share = (got_bucket[1] + got_bucket[2]) as f64 / n;
        report.three_plus_share = got_bucket[2] as f64 / n;
        report.apps = app_supply
            .iter()
            .map(|(app, supply)| Line {
                name: app.clone(),
                target: want as f64 / app_supply.len().max(1) as f64,
                realised: got_app.get(app).copied().unwrap_or(0) as f64,
                supply: *supply as f64,
            })
            .collect();
        let uniform = want as f64 * avg_turns / cfg.live.len().max(1) as f64;
        for cell in &cfg.live {
            let realised = got_cell.get(cell).copied().unwrap_or(0);
            let supply = cell_supply.get(cell).copied().unwrap_or(0);
            let status = if realised as f64 + 1e-9 >= uniform {
                "hit"
            } else if realised >= supply {
                "supply"
            } else {
                "short"
            };
            report.cells.push(CellLine {
                cell: cell.clone(),
                target: uniform,
                realised,
                supply,
                status,
            });
        }
        if want < target {
            report.missed.push(format!(
                "{} sessions wanted, the input holds {supply_sessions} after duplicates and broken pairs",
                target
            ));
        }
        for (b, name) in ["one-turn", "two-turn", "3+-turn"].iter().enumerate() {
            if (got_bucket[b] as f64) + 1.0 < bucket_target[b].floor() {
                report.missed.push(format!(
                    "{name} sessions: {} of {:.0} wanted",
                    got_bucket[b],
                    want as f64 * shares[b]
                ));
            }
        }
        if (got_across as f64) + 1.0 < across_target.floor() {
            report.missed.push(format!(
                "across-app sessions: {got_across} of {across_target:.0} wanted"
            ));
        }
        if report.multi_turn_share < 0.5 && want > 0 {
            report.missed.push(format!(
                "multi-turn share {:.1}% is under the 50% floor",
                report.multi_turn_share * 100.0
            ));
        }
        let unfilled = report.cells.iter().filter(|c| c.status != "hit").count();
        if unfilled > 0 {
            let supplied = report.cells.iter().filter(|c| c.status == "supply").count();
            report.missed.push(format!(
                "{unfilled} of {} live cells under the uniform target ({supplied} because the input holds no more)",
                report.cells.len()
            ));
        }
        chosen.insert(name.to_owned(), picked);
        reports.push(report);
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
    reports.reverse();
    Ok(Selection { chosen, reports })
}

/// The report as text.
#[must_use]
pub fn text(selection: &Selection) -> String {
    let mut out = String::new();
    for r in &selection.reports {
        out.push_str(&format!(
            "== {} — {} of {} wanted ({} in the input; {} duplicates, {} sessions of broken pairs); {} turns, {} tokens, {} minimal pairs\n",
            r.split, r.sessions, r.target_sessions, r.input_sessions, r.duplicates, r.orphan_pairs,
            r.turns, r.tokens, r.pairs
        ));
        out.push_str(&format!(
            "   multi-turn {:.1}% (3+ {:.1}%)\n",
            r.multi_turn_share * 100.0,
            r.three_plus_share * 100.0
        ));
        out.push_str("   shares          target  realised  supply\n");
        for l in r.by_turns.iter().chain(std::iter::once(&r.across)) {
            out.push_str(&format!(
                "   {:<12} {:>9.0} {:>9.0} {:>7.0}\n",
                l.name, l.target, l.realised, l.supply
            ));
        }
        out.push_str("   apps            target  realised  supply\n");
        for l in &r.apps {
            out.push_str(&format!(
                "   {:<12} {:>9.0} {:>9.0} {:>7.0}\n",
                l.name, l.target, l.realised, l.supply
            ));
        }
        out.push_str(
            "   cells (turns)                                     target realised supply status\n",
        );
        for c in &r.cells {
            out.push_str(&format!(
                "   {:<44} {:>8.1} {:>8} {:>6} {}\n",
                c.cell, c.target, c.realised, c.supply, c.status
            ));
        }
        for m in &r.missed {
            out.push_str(&format!("   could not hit: {m}\n"));
        }
        out.push('\n');
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

    fn session(
        id: &str,
        split: &str,
        world: &str,
        app: &str,
        cells: &[&str],
        key: &str,
    ) -> Features {
        Features {
            id: id.to_owned(),
            split: split.to_owned(),
            world: world.to_owned(),
            app: app.to_owned(),
            apps: vec![app.to_owned()],
            cells: cells.iter().map(|c| (*c).to_owned()).collect(),
            turns: cells.len(),
            across: false,
            pair: None,
            key: key.to_owned(),
            tokens: 100,
        }
    }

    fn input() -> (Vec<Features>, Config) {
        let mut all = Vec::new();
        let cells = ["find/task/read", "compute/task/count", "do/task/complete"];
        let apps = ["tasks", "people"];
        for w in 0..6 {
            for i in 0..100 {
                let split = match w {
                    0..=3 => "train",
                    4 => "val",
                    _ => "test",
                };
                let n = 1 + (i % 3);
                let cs: Vec<&str> = (0..n).map(|k| cells[(i + k) % 3]).collect();
                let mut f = session(
                    &format!("{split}-{w}-{i}"),
                    split,
                    &format!("{split}-{w}"),
                    apps[i % 2],
                    &cs,
                    &format!("k{w}-{i}"),
                );
                f.across = i % 5 == 0;
                all.push(f);
            }
        }
        // a duplicate of a test session inside train, a pair, an orphan, noise
        let mut dup = session(
            "train-dup",
            "train",
            "train-0",
            "tasks",
            &["find/task/read"],
            "k5-0",
        );
        dup.turns = 1;
        all.push(dup);
        for (id, twin) in [
            ("train-0-pairA", "train-0-pairB"),
            ("train-1-pairA", "train-1-pairB"),
        ] {
            let mut a = session(
                id,
                "train",
                "train-0",
                "tasks",
                &["find/task/read"],
                &format!("{id}x"),
            );
            let mut b = session(
                twin,
                "train",
                "train-0",
                "tasks",
                &["find/task/read"],
                &format!("{twin}x"),
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
                "tasks",
                &["find/task/read"],
                &format!("n{i}"),
            );
            n.turns = 1;
            all.push(n);
        }
        let cfg = Config {
            targets: [150, 40, 40],
            shares: Shares::default(),
            seed: 1,
            live: cells.iter().map(|c| (*c).to_owned()).collect(),
        };
        (all, cfg)
    }

    #[test]
    fn a_mix_hits_its_targets_keeps_pairs_whole_and_drops_duplicates() {
        let (all, cfg) = input();
        let selection = mix(&all, &cfg).unwrap();
        for (split, target) in [("train", 150), ("val", 40), ("test", 40)] {
            assert_eq!(selection.chosen[split].len(), target, "{split}");
        }
        // the duplicate of a test session is not in train
        assert!(
            !selection.chosen["train"]
                .iter()
                .any(|i| all[*i].id == "train-dup")
        );
        // a pair is whole or absent, and an orphan is never alone
        let ids: BTreeSet<&str> = selection.chosen["train"]
            .iter()
            .map(|i| all[*i].id.as_str())
            .collect();
        assert_eq!(ids.contains("train-0-pairA"), ids.contains("train-0-pairB"));
        assert!(!ids.contains("train-1-pairA"));
        // multi-turn floor
        for r in &selection.reports {
            assert!(
                r.multi_turn_share >= 0.5,
                "{}: {}",
                r.split,
                r.multi_turn_share
            );
            assert!(r.three_plus_share > 0.2, "{}", r.split);
        }
        // apps are balanced
        let train = selection
            .reports
            .iter()
            .find(|r| r.split == "train")
            .unwrap();
        for app in &train.apps {
            assert!((app.realised - app.target).abs() <= 2.0, "{app:?}");
        }
        // noise follows val
        let val_ids: BTreeSet<&str> = selection.chosen["val"]
            .iter()
            .map(|i| all[*i].id.as_str())
            .collect();
        for i in &selection.chosen["noise"] {
            assert!(val_ids.contains(all[*i].id.trim_end_matches("~noise")));
        }
        // no world in two splits
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
    }

    #[test]
    fn what_the_input_cannot_give_is_reported_not_faked() {
        let (all, mut cfg) = input();
        cfg.targets = [10_000, 40, 40];
        let selection = mix(&all, &cfg).unwrap();
        let train = selection
            .reports
            .iter()
            .find(|r| r.split == "train")
            .unwrap();
        assert!(train.sessions < 10_000);
        assert!(train.missed.iter().any(|m| m.contains("wanted")));
    }

    #[test]
    fn half_the_sessions_have_two_turns_or_more_whatever_the_shares_pull_toward() {
        let (all, mut cfg) = input();
        // the shares ask for 90% one-turn sessions; the floor of the issue wins
        cfg.shares = Shares {
            one: 0.9,
            two: 0.05,
            three_plus: 0.05,
            across: 0.3,
        };
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
    fn a_world_in_two_splits_is_refused() {
        let (mut all, cfg) = input();
        all[0].world = "val-4".to_owned();
        assert!(mix(&all, &cfg).is_err());
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
}
