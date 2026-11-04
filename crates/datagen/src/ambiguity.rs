//! AMBIGUITY MEASUREMENT: how many ways a name in a world can be read, counted from the world
//! itself so a setting's effect shows before any session is written.
//!
//! Per kind, over live rows: names shared exactly (a group is two or more rows), pairs of near
//! duplicates (see [`crate::text::near_duplicates`]); over trashed rows: how many shadow a live
//! name, which is what makes `restore` and `find` ask. People also get the shared-first-name
//! count, the collision a spoken "Neha" runs into.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::text::{near_duplicates, normalize};
use crate::world::{NAMED_SECTIONS, World};

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct KindAmbiguity {
    pub rows: usize,
    pub trashed: usize,
    /// Groups of live rows with the same normalized name.
    pub exact_name_groups: usize,
    pub rows_in_exact_groups: usize,
    /// Unordered pairs of live rows whose names are near duplicates.
    pub near_duplicate_pairs: usize,
    /// Trashed rows whose name equals or nearly equals a live row's.
    pub trashed_shadows: usize,
    /// Live rows with at least one same-name or near-name live peer.
    pub confusable_rows: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Ambiguity {
    pub kinds: BTreeMap<String, KindAmbiguity>,
    /// People sharing a first name with another live person.
    pub people_sharing_first_name: usize,
    pub first_name_groups: usize,
    pub totals: KindAmbiguity,
}

fn is_trashed(row: &Value) -> bool {
    match row.get("trashed") {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(_)) => true,
        _ => false,
    }
}

/// Measure a world's document.
#[must_use]
pub fn measure(world: &World) -> Ambiguity {
    let mut out = Ambiguity::default();
    for (section, kind) in NAMED_SECTIONS {
        let rows = world
            .doc
            .get(*section)
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        let (live, dead): (Vec<&Value>, Vec<&Value>) =
            rows.iter().partition(|row| !is_trashed(row));
        let names = |rows: &[&Value]| -> Vec<String> {
            rows.iter()
                .filter_map(|row| row.get("name").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        };
        let (live_names, dead_names) = (names(&live), names(&dead));
        let mut result = KindAmbiguity {
            rows: rows.len(),
            trashed: dead.len(),
            ..KindAmbiguity::default()
        };
        let mut by_name: BTreeMap<String, usize> = BTreeMap::new();
        for name in &live_names {
            *by_name.entry(normalize(name)).or_default() += 1;
        }
        result.exact_name_groups = by_name.values().filter(|n| **n > 1).count();
        result.rows_in_exact_groups = by_name.values().filter(|n| **n > 1).sum();
        let mut confusable = vec![false; live_names.len()];
        for (i, a) in live_names.iter().enumerate() {
            for (j, b) in live_names.iter().enumerate().skip(i + 1) {
                if near_duplicates(a, b) {
                    result.near_duplicate_pairs += 1;
                    confusable[i] = true;
                    confusable[j] = true;
                } else if normalize(a) == normalize(b) {
                    confusable[i] = true;
                    confusable[j] = true;
                }
            }
        }
        result.confusable_rows = confusable.iter().filter(|c| **c).count();
        result.trashed_shadows = dead_names
            .iter()
            .filter(|dead| {
                live_names
                    .iter()
                    .any(|live| normalize(live) == normalize(dead) || near_duplicates(live, dead))
            })
            .count();
        if *kind == "person" {
            let mut firsts: BTreeMap<String, usize> = BTreeMap::new();
            for name in &live_names {
                let first = normalize(name)
                    .split(' ')
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                *firsts.entry(first).or_default() += 1;
            }
            out.first_name_groups = firsts.values().filter(|n| **n > 1).count();
            out.people_sharing_first_name = firsts.values().filter(|n| **n > 1).sum();
        }
        let totals = &mut out.totals;
        totals.rows += result.rows;
        totals.trashed += result.trashed;
        totals.exact_name_groups += result.exact_name_groups;
        totals.rows_in_exact_groups += result.rows_in_exact_groups;
        totals.near_duplicate_pairs += result.near_duplicate_pairs;
        totals.trashed_shadows += result.trashed_shadows;
        totals.confusable_rows += result.confusable_rows;
        out.kinds.insert((*kind).to_owned(), result);
    }
    out
}
