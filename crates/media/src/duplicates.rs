//! Near-duplicate clustering: **the projection the Photos app reads**
//! (#1020, D-1020-P3).
//!
//! `media_asset_phash.cluster_id` is a REBUILDABLE PROJECTION, not a fact
//! anybody authored. It is recomputed wholesale as union-find over phash
//! Hamming distance ≤ [`DUPLICATE_HAMMING_THRESHOLD`], with the group's
//! **lowest `asset_id`** as its id, and `queries/duplicates.ts` only reads it.
//!
//! ## Why this lives in `crates/media` and not in the app
//!
//! Two reasons, and the second is the one that matters. An app crate holds no
//! SQL and no loop over the whole library — but more than that, **there must be
//! exactly one clustering**: a second implementation inside the query would
//! agree with the sweep until the threshold moved, and then disagree silently
//! at exactly the boundary where a member is deciding what to delete.
//!
//! `crates/media` has no wave-4 owner of its own, so the Photos lane landed
//! this module and the models lock beside it; both are named in the lane's
//! receipt section as belonging to `crates/media`'s eventual owner.
//!
//! ## Cluster ids are order-independent, and there is a property test
//!
//! The id is the lowest member's `asset_id`, which means the answer cannot
//! depend on the order the rows arrived in. [`cluster`] sorts nothing and
//! relies on nothing being sorted; `cluster_ids_do_not_depend_on_input_order`
//! shuffles the input deterministically and asserts the same map comes back.
//!
//! ## What is here and what is not
//!
//! Here: the pure fold, over `(asset_id, phash)` pairs. **Not** here: reading
//! the table, writing the column, and deciding when to run — those are the
//! vault's and the automations lane's (`enrich.rebuild_face_clusters` and the
//! standing sweep). [`recompute_clusters`] is the seam: a caller hands it the
//! live rows and their current ids, and it answers the writes to make.

use std::collections::BTreeMap;

use crate::phash::hex_hamming;

/// Two phashes within this many bits cluster together (#352).
pub const DUPLICATE_HAMMING_THRESHOLD: u32 = 6;

/// Path-compressed union-find over opaque string ids.
///
/// String-keyed rather than index-keyed on purpose: the ids are what the answer
/// is phrased in, and an index table is one more mapping to get wrong.
#[derive(Debug, Default)]
pub struct UnionFind {
    parent: BTreeMap<String, String>,
}

impl UnionFind {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, id: &str) {
        self.parent
            .entry(id.to_owned())
            .or_insert_with(|| id.to_owned());
    }

    /// The root of `id`'s set, compressing the path on the way back.
    pub fn find(&mut self, id: &str) -> String {
        let mut root = id.to_owned();
        while let Some(next) = self.parent.get(&root) {
            if next == &root {
                break;
            }
            root = next.clone();
        }
        let mut cursor = id.to_owned();
        while cursor != root {
            let next = self
                .parent
                .insert(cursor, root.clone())
                .unwrap_or_else(|| root.clone());
            cursor = next;
        }
        root
    }

    pub fn union(&mut self, left: &str, right: &str) {
        let (left_root, right_root) = (self.find(left), self.find(right));
        if left_root != right_root {
            self.parent.insert(left_root, right_root);
        }
    }
}

/// One fingerprint, as the table holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub asset_id: String,
    pub phash: String,
    /// The id this row carries today, so a recompute can be compare-then-write.
    pub cluster_id: Option<String>,
}

/// THE FOLD: which cluster each asset belongs to.
///
/// Only assets in a group of two or more get an id; a singleton's answer is
/// **absence**, not a cluster of one — which is why the return is a map and not
/// a `Vec<Option<_>>`.
///
/// The comparison is pairwise. v0 adds multi-index banding over the hex digits
/// to avoid the quadratic scan (`enrich/clusters.ts:100-181`); that is a
/// **cost** optimisation whose answer is identical by construction, and porting
/// it without the scale rig that justified it would be porting a plan nobody
/// can check. The year-3 photos axis measures the pairwise cost and the receipt
/// reports it; the banding is named there as the next step.
#[must_use]
pub fn cluster(rows: &[Fingerprint], threshold: u32) -> BTreeMap<String, String> {
    let mut union = UnionFind::new();
    for row in rows {
        union.add(&row.asset_id);
    }

    // Collapse exact duplicates first: identical digests cost one comparison
    // between groups instead of one per pair.
    let mut by_phash: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for row in rows {
        by_phash
            .entry(row.phash.as_str())
            .or_default()
            .push(row.asset_id.as_str());
    }
    for ids in by_phash.values() {
        for id in &ids[1..] {
            union.union(ids[0], id);
        }
    }

    let digests: Vec<(&str, &str)> = by_phash
        .iter()
        .map(|(phash, ids)| (*phash, ids[0]))
        .collect();
    for (index, (left_phash, left_id)) in digests.iter().enumerate() {
        for (right_phash, right_id) in &digests[index + 1..] {
            // `None` — a pair that is not comparable — is never a match.
            if hex_hamming(left_phash, right_phash).is_some_and(|d| d <= threshold) {
                union.union(left_id, right_id);
            }
        }
    }

    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let root = union.find(&row.asset_id);
        groups.entry(root).or_default().push(row.asset_id.clone());
    }
    let mut cluster_of = BTreeMap::new();
    for members in groups.values() {
        // A group of one is a photograph.
        if members.len() < 2 {
            continue;
        }
        // THE DETERMINISTIC ID: the group's lowest asset id. Not the union-find
        // root, which depends on the union order.
        let cluster_id = members.iter().min().expect("non-empty").clone();
        for member in members {
            cluster_of.insert(member.clone(), cluster_id.clone());
        }
    }
    cluster_of
}

/// One write a recompute asks for: the row, and the id it should carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterWrite {
    pub asset_id: String,
    /// `None` clears the column — the row left its cluster.
    pub cluster_id: Option<String>,
}

/// What a recompute found.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Recompute {
    /// Distinct clusters with two or more members.
    pub clusters: usize,
    /// Rows that belong to one.
    pub clustered: usize,
    /// **Compare-then-write**: only the rows whose id actually changes. A
    /// blanket reset would bill the segment shipper on every sweep for a
    /// library nobody touched (#659).
    pub writes: Vec<ClusterWrite>,
}

/// Recompute the projection over the LIVE fingerprints, and say what to write.
///
/// The caller reads the rows (`WHERE media_asset.deleted_at IS NULL`) and
/// applies the writes; **trashed rows are not in `rows` and their ids are the
/// caller's to clear**, because clearing them is a statement over a table this
/// crate does not open. `recompute_clusters` never touches a database.
#[must_use]
pub fn recompute_clusters(rows: &[Fingerprint], threshold: u32) -> Recompute {
    let cluster_of = cluster(rows, threshold);
    let mut distinct: Vec<&String> = cluster_of.values().collect();
    distinct.sort_unstable();
    distinct.dedup();
    let writes = rows
        .iter()
        .filter_map(|row| {
            let desired = cluster_of.get(&row.asset_id).cloned();
            (desired != row.cluster_id).then(|| ClusterWrite {
                asset_id: row.asset_id.clone(),
                cluster_id: desired,
            })
        })
        .collect();
    Recompute {
        clusters: distinct.len(),
        clustered: cluster_of.len(),
        writes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(asset_id: &str, phash: &str) -> Fingerprint {
        Fingerprint {
            asset_id: asset_id.to_owned(),
            phash: phash.to_owned(),
            cluster_id: None,
        }
    }

    /// A deterministic shuffle, so the order-independence property is a test
    /// and not a coin toss. Fisher-Yates over a xorshift, seeded per run.
    fn shuffled(rows: &[Fingerprint], seed: u64) -> Vec<Fingerprint> {
        let mut state = seed | 1;
        let mut out = rows.to_vec();
        for index in (1..out.len()).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            #[expect(
                clippy::cast_possible_truncation,
                reason = "the modulo bounds the index by construction"
            )]
            let pick = (state % (index as u64 + 1)) as usize;
            out.swap(index, pick);
        }
        out
    }

    #[test]
    fn identical_digests_cluster_and_the_id_is_the_lowest_asset_id() {
        let rows = vec![
            row("a-9", "3727170f8b494d6e"),
            row("a-2", "3727170f8b494d6e"),
        ];
        let clusters = cluster(&rows, DUPLICATE_HAMMING_THRESHOLD);
        assert_eq!(clusters["a-9"], "a-2");
        assert_eq!(clusters["a-2"], "a-2");
    }

    #[test]
    fn a_lone_photograph_gets_no_cluster_id() {
        let rows = vec![row("a-1", "3727170f8b494d6e")];
        assert!(cluster(&rows, DUPLICATE_HAMMING_THRESHOLD).is_empty());
    }

    #[test]
    fn the_threshold_is_inclusive_and_a_bit_past_it_is_a_different_photograph() {
        // `0000` vs `003f` is 6 bits: inside. Vs `007f` is 7: outside.
        let inside = vec![row("a-1", "0000"), row("a-2", "003f")];
        assert_eq!(cluster(&inside, 6).len(), 2);
        let outside = vec![row("a-1", "0000"), row("a-2", "007f")];
        assert!(cluster(&outside, 6).is_empty());
    }

    /// Clustering is TRANSITIVE, which is what union-find is for: A~B and B~C
    /// puts A and C in one group even when A and C are 12 bits apart.
    #[test]
    fn clustering_is_transitive_across_a_chain_no_single_pair_would_join() {
        let rows = vec![row("a-1", "0000"), row("a-2", "003f"), row("a-3", "0fff")];
        let clusters = cluster(&rows, 6);
        assert_eq!(clusters.len(), 3);
        assert!(clusters.values().all(|id| id == "a-1"));
        assert_eq!(
            crate::phash::hex_hamming("0000", "0fff"),
            Some(12),
            "no single pair would have joined the ends"
        );
    }

    /// THE PROPERTY D-1020-P3 NAMES: cluster ids are order-independent.
    #[test]
    fn cluster_ids_do_not_depend_on_input_order() {
        let rows: Vec<Fingerprint> = [
            ("a-11", "0000"),
            ("a-02", "0001"),
            ("a-07", "0003"),
            ("a-30", "ffff"),
            ("a-04", "fffe"),
            ("a-18", "8000"),
            ("a-21", "3727170f"),
            ("a-05", "3727170e"),
        ]
        .iter()
        .map(|(id, phash)| row(id, phash))
        .collect();
        let expected = cluster(&rows, DUPLICATE_HAMMING_THRESHOLD);
        assert!(!expected.is_empty(), "the case must actually cluster");
        for seed in 1..64_u64 {
            let permuted = shuffled(&rows, seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
            assert_eq!(
                cluster(&permuted, DUPLICATE_HAMMING_THRESHOLD),
                expected,
                "seed {seed} produced a different clustering"
            );
        }
    }

    /// Mixed digest widths are NOT COMPARABLE, so they never join — even when
    /// one is a prefix of the other.
    #[test]
    fn a_narrow_digest_never_joins_a_wide_one() {
        let rows = vec![row("a-1", "0000"), row("a-2", "00000000")];
        assert!(cluster(&rows, DUPLICATE_HAMMING_THRESHOLD).is_empty());
    }

    #[test]
    fn a_recompute_writes_only_what_changed() {
        let rows = vec![
            Fingerprint {
                cluster_id: Some("a-1".to_owned()),
                ..row("a-1", "0000")
            },
            Fingerprint {
                cluster_id: Some("a-1".to_owned()),
                ..row("a-2", "0001")
            },
            // Left its cluster: the column must be cleared.
            Fingerprint {
                cluster_id: Some("a-3".to_owned()),
                ..row("a-3", "ffff")
            },
        ];
        let recompute = recompute_clusters(&rows, DUPLICATE_HAMMING_THRESHOLD);
        assert_eq!(recompute.clusters, 1);
        assert_eq!(recompute.clustered, 2);
        assert_eq!(
            recompute.writes,
            vec![ClusterWrite {
                asset_id: "a-3".to_owned(),
                cluster_id: None
            }]
        );
    }

    #[test]
    fn a_steady_state_sweep_writes_nothing() {
        let rows = vec![
            Fingerprint {
                cluster_id: Some("a-1".to_owned()),
                ..row("a-1", "0000")
            },
            Fingerprint {
                cluster_id: Some("a-1".to_owned()),
                ..row("a-2", "0001")
            },
        ];
        assert!(
            recompute_clusters(&rows, DUPLICATE_HAMMING_THRESHOLD)
                .writes
                .is_empty()
        );
    }
}
