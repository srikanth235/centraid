//! PRE-SELECTION: choose which planned sessions go to the writer and the reader at all.
//!
//! A world is drawn at a sweep that holds many times what a data version needs (the draws of every live cell, pair and rare
//! outcome), so what the intents stage keeps is a pool, and the mix chooses from it. Writing a message for every session
//! of the pool is writing for sessions that are then thrown away. This runs the mix on the planned sessions, before any
//! message, with every target and floor raised by a headroom factor (a session lost to the writer, the checks or the
//! read-back is replaced from the headroom), so the writer and the reader see only the sessions it chose. The mix after the
//! render then chooses from what survived, as it always did.
//!
//! What the mix does it does here, on the typed intents alone: duplicates out (by the gold, as there are no words yet),
//! a minimal pair or an ask-or-act pair whole or gone, the combinations reserved for test out of train and val, a world in
//! one split only (asserted). The reserved combinations are chosen here from the whole pool and handed on
//! ([`Preselected::reserved`]), so the mix after the render holds out the same ones.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::mix;
use crate::render::Features;

/// How many times the targets and floors the writer and the reader are given by default: a session lost after the
/// selection is replaced from the rest.
pub const HEADROOM: f64 = 1.5;

/// The file of the messages output that carries the reserved combinations to the render.
pub const FILE: &str = "preselect.json";

/// What pre-selection chose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preselected {
    pub headroom: f64,
    /// Indices into the features it was given, sorted: the sessions that go on.
    #[serde(skip)]
    pub keep: Vec<usize>,
    /// Sessions pre-selected per split (train, val, test), and the sessions the targets were scaled to.
    pub chosen: [usize; 3],
    pub wanted: [usize; 3],
    /// The combinations reserved for test: the mix after the render holds out the same ones.
    pub reserved: Vec<String>,
}

fn scaled(n: usize, headroom: f64) -> usize {
    (n as f64 * headroom).ceil() as usize
}

/// The mix's configuration with every target and floor raised by `headroom`. Nested subsets are the render's business.
#[must_use]
pub fn scaled_config(cfg: &mix::Config, headroom: f64) -> mix::Config {
    let up = |a: [usize; 3]| a.map(|n| scaled(n, headroom));
    mix::Config {
        targets: up(cfg.targets),
        floor: up(cfg.floor),
        field_floor: up(cfg.field_floor),
        subsets: Vec::new(),
        ..cfg.clone()
    }
}

/// Choose the sessions of `features` that go on to the writer. Pure: the same features and configuration give the same
/// sessions. `headroom` of 0 or less keeps everything.
///
/// # Errors
///
/// If the mix fails (a world in two splits).
pub fn choose(features: &[Features], cfg: &mix::Config, headroom: f64) -> Result<Preselected> {
    let wanted = cfg.targets.map(|n| scaled(n, headroom.max(0.0)));
    if headroom <= 0.0 {
        let mut chosen = [0_usize; 3];
        for f in features {
            if let Some(s) = mix::SPLITS.iter().position(|s| *s == f.split) {
                chosen[s] += 1;
            }
        }
        return Ok(Preselected {
            headroom,
            keep: (0..features.len()).collect(),
            chosen,
            wanted,
            reserved: cfg.reserved.clone(),
        });
    }
    let selection = mix::mix(features, &scaled_config(cfg, headroom))?;
    let mut keep: Vec<usize> = Vec::new();
    let mut chosen = [0_usize; 3];
    for (s, split) in mix::SPLITS.iter().enumerate() {
        let of = selection.chosen.get(*split).map_or(&[][..], Vec::as_slice);
        chosen[s] = of.len();
        keep.extend(of.iter().copied());
    }
    keep.sort_unstable();
    Ok(Preselected {
        headroom,
        keep,
        chosen,
        wanted,
        reserved: selection.reserved.keys().cloned().collect(),
    })
}

impl Preselected {
    /// The report line: sessions pre-selected per split against the sessions the headroom asked for.
    #[must_use]
    pub fn text(&self) -> String {
        format!(
            "pre-selected {}/{}/{} sessions (train/val/test) of {}/{}/{} wanted at headroom {}; the writer and the reader see only these",
            self.chosen[0],
            self.chosen[1],
            self.chosen[2],
            self.wanted[0],
            self.wanted[1],
            self.wanted[2],
            self.headroom
        )
    }
}

/// The reserved combinations a pre-selection handed on, if the messages output holds one.
///
/// # Errors
///
/// If the file is there and cannot be read.
pub fn reserved_of(messages: &std::path::Path) -> Result<Option<Vec<String>>> {
    let path = messages.join(FILE);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)?;
    let p: Preselected = serde_json::from_str(&text)?;
    Ok(Some(p.reserved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn session(id: &str, split: &str, world: &str, i: usize, pair: Option<&str>) -> Features {
        let cells = ["find/task/read", "find/note/read", "do/task/complete"];
        let n = 1 + i % 3;
        let cell: Vec<String> = (0..n).map(|k| cells[(i + k) % 3].to_owned()).collect();
        Features {
            id: id.to_owned(),
            split: split.to_owned(),
            world: world.to_owned(),
            app: "tasks".to_owned(),
            apps: vec!["tasks".to_owned()],
            outcomes: vec!["done".to_owned(); n],
            actions: vec!["read".to_owned(); n],
            refs: vec!["name".to_owned(); n],
            impossible: vec![false; n],
            kinds: vec!["task".to_owned()],
            cells: cell,
            turns: n,
            key: format!("key-{id}"),
            tokens: 10,
            pair: pair.map(str::to_owned),
            ..Features::default()
        }
    }

    /// A pool far larger than the targets: six worlds of 700 sessions in train, two and two in val and test, with minimal
    /// pairs and a duplicate across splits.
    fn pool() -> Vec<Features> {
        let mut all = Vec::new();
        for (split, worlds, per) in [("train", 6, 700), ("val", 2, 700), ("test", 2, 700)] {
            for w in 0..worlds {
                for i in 0..per {
                    let id = format!("{split}-{w}-{i}");
                    let pair = (i % 50 == 0).then(|| format!("pair:{id}"));
                    all.push(session(
                        &id,
                        split,
                        &format!("{split}-{w}"),
                        i,
                        pair.as_deref(),
                    ));
                    if pair.is_some() {
                        all.push(session(
                            &format!("{id}-twin"),
                            split,
                            &format!("{split}-{w}"),
                            i + 1,
                            pair.as_deref(),
                        ));
                    }
                }
            }
        }
        // a train session with the gold of a test one
        let mut dup = session("train-dup", "train", "train-0", 5, None);
        dup.key = "key-test-0-5".to_owned();
        all.push(dup);
        all
    }

    fn config() -> mix::Config {
        mix::Config {
            targets: [400, 60, 80],
            live: vec![
                "find/task/read".to_owned(),
                "find/note/read".to_owned(),
                "do/task/complete".to_owned(),
            ],
            floor: [20, 0, 0],
            subsets: vec![100],
            reserve: 0,
            ..mix::Config::default()
        }
    }

    #[test]
    fn a_pool_is_cut_to_the_headroom_times_the_targets_with_pairs_whole_and_no_world_in_two_splits()
    {
        let all = pool();
        let cfg = config();
        let got = choose(&all, &cfg, HEADROOM).unwrap();
        // about headroom times the target per split, from a pool of several times that
        assert_eq!(got.wanted, [600, 90, 120]);
        for (s, split) in mix::SPLITS.iter().enumerate() {
            let pool_size = all.iter().filter(|f| f.split == *split).count();
            assert!(pool_size > 3 * got.wanted[s], "{split}: {pool_size}");
            assert!(
                got.chosen[s].abs_diff(got.wanted[s]) <= 1,
                "{split}: {} of {}",
                got.chosen[s],
                got.wanted[s]
            );
        }
        assert_eq!(got.keep.len(), got.chosen.iter().sum::<usize>());
        let kept: Vec<&Features> = got.keep.iter().map(|i| &all[*i]).collect();
        // a minimal pair is whole or gone
        let mut by_pair: BTreeMap<&str, usize> = BTreeMap::new();
        for f in &kept {
            if let Some(p) = &f.pair {
                *by_pair.entry(p).or_default() += 1;
            }
        }
        assert!(
            !by_pair.is_empty(),
            "the fixture's pairs are not all dropped"
        );
        assert!(by_pair.values().all(|n| *n == 2), "{by_pair:?}");
        // the duplicate of a test session is not in train, and a world is in one split
        assert!(kept.iter().all(|f| f.id != "train-dup"));
        let mut home: BTreeMap<&str, &str> = BTreeMap::new();
        for f in &kept {
            assert_eq!(*home.entry(&f.world).or_insert(&f.split), f.split);
        }
        // the floor, raised by the headroom, is met in train
        let in_train = |cell: &str| {
            kept.iter()
                .filter(|f| f.split == "train")
                .flat_map(|f| f.cells.iter())
                .filter(|c| *c == cell)
                .count()
        };
        for cell in &cfg.live {
            assert!(in_train(cell) >= 30, "{cell}: {}", in_train(cell));
        }
        // a pure function
        let again = choose(&all, &cfg, HEADROOM).unwrap();
        assert_eq!(again.keep, got.keep);
    }

    #[test]
    fn the_reserved_combinations_are_chosen_once_and_held_out_of_train_and_val() {
        let mut all = pool();
        for (n, f) in all.iter_mut().enumerate() {
            f.combos = vec![format!("kf:task:f{}", n % 60)];
        }
        let mut cfg = config();
        cfg.reserve = 2;
        let got = choose(&all, &cfg, HEADROOM).unwrap();
        assert_eq!(got.reserved.len(), 2, "{:?}", got.reserved);
        let reserved: BTreeSet<&String> = got.reserved.iter().collect();
        for i in &got.keep {
            let f = &all[*i];
            if f.split != "test" {
                assert!(f.combos.iter().all(|c| !reserved.contains(c)), "{}", f.id);
            }
        }
        // a headroom of zero keeps every session and chooses nothing
        let all_kept = choose(&all, &cfg, 0.0).unwrap();
        assert_eq!(all_kept.keep.len(), all.len());
    }
}
