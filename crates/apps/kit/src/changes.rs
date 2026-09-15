//! CHANGE EVENTS AND THE LIVE-QUERY MATCHING RULE (#1020, D-1020-D3-8).
//!
//! Two facts from v0, kept apart because they are two planes (#1020 apps §4.3):
//!
//! - The **canonical** notice is the applier's: the unit is the *entity*, and a
//!   `shapeId` is simply absent, because a seat has no shapes — what it has is
//!   the tables a batch wrote, which is both narrower and truer
//!   (`packages/client/src/replica/seat/invalidations.ts:1-17`).
//! - A **purge** is not a list of entities: the plane every read stands on is
//!   replaced, so it matches everything (`invalidations.ts:38-44`).
//!
//! The matching rule is ported verbatim from
//! `packages/client/src/replica/live-query.ts:99-111`: **skip only when
//! dependency and invalidation both name rows, and different ones; anything
//! wider reruns.** The order of the four tests is load-bearing and is kept.
//!
//! Keys are NUL-joined, because no id carries that byte, so parts cannot
//! collide (`live-query.ts:169`).

use std::collections::{BTreeMap, BTreeSet};

/// One commit's worth of change, as the core reports it over the ABI.
///
/// `pk_set` is the set of primary keys the commit touched in `table`, and the
/// core **coalesces per `(table, pk)` and drops nothing** (#1020, Execution
/// model): a consumer that stops reading stalls sync after the queue fills,
/// which is the correct backpressure. An **empty `pk_set` is meaningful**: it
/// says "this table changed; re-derive what you render", exactly as v0's empty
/// table list does (`packages/server/src/engine/changes/change-bus.ts:57-58`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeEvent {
    pub table: String,
    pub pk_set: BTreeSet<String>,
    /// The transaction the change belongs to. **Not a `seq`** — comparing one
    /// against the other is "the R6 mistake in miniature" (#1020 plane seam 5).
    pub commit_seq: i64,
}

impl ChangeEvent {
    pub fn of(table: &str, pks: impl IntoIterator<Item = &'static str>, commit_seq: i64) -> Self {
        Self {
            table: table.to_owned(),
            pk_set: pks.into_iter().map(str::to_owned).collect(),
            commit_seq,
        }
    }
}

/// Coalesce a stream of events per `(table, pk)`.
///
/// The **highest `commit_seq`** wins for a table, because a cursor advances
/// monotonically and an overlay clears against the latest commit it has seen.
/// A table that arrives once with a pk set and once **without** collapses to
/// *without*: the wider claim is the true one, and narrowing it would skip a
/// rerun the wide event asked for.
pub fn coalesce(events: impl IntoIterator<Item = ChangeEvent>) -> Vec<ChangeEvent> {
    let mut by_table: BTreeMap<String, (BTreeSet<String>, bool, i64)> = BTreeMap::new();
    for event in events {
        let entry = by_table
            .entry(event.table)
            .or_insert((BTreeSet::new(), false, i64::MIN));
        if event.pk_set.is_empty() {
            entry.1 = true;
            entry.0.clear();
        } else if !entry.1 {
            entry.0.extend(event.pk_set);
        }
        entry.2 = entry.2.max(event.commit_seq);
    }
    by_table
        .into_iter()
        .map(|(table, (pk_set, _, commit_seq))| ChangeEvent {
            table,
            pk_set,
            commit_seq,
        })
        .collect()
}

/// What one read depends on. `row_id: None` means THE WHOLE ENTITY
/// (`packages/client/src/replica/types.ts:220-230`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Dependency {
    /// Absent on a seat: a seat has no shapes.
    pub shape_id: Option<String>,
    pub entity: String,
    pub row_id: Option<String>,
}

impl Dependency {
    pub fn entity(entity: &str) -> Self {
        Self {
            shape_id: None,
            entity: entity.to_owned(),
            row_id: None,
        }
    }

    pub fn row(entity: &str, row_id: &str) -> Self {
        Self {
            shape_id: None,
            entity: entity.to_owned(),
            row_id: Some(row_id.to_owned()),
        }
    }
}

/// Where an invalidation came from. A purge replaces the plane itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidationSource {
    Canonical,
    Overlay,
    Purge,
}

/// One invalidation: a dependency shape plus where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalidation {
    pub dependency: Dependency,
    pub source: InvalidationSource,
}

fn entity_key(dependency: &Dependency) -> String {
    format!(
        "{}\u{0}{}",
        dependency.shape_id.as_deref().unwrap_or("undefined"),
        dependency.entity
    )
}

fn row_key(dependency: &Dependency) -> String {
    match dependency.row_id.as_deref() {
        None => entity_key(dependency),
        Some(row_id) => format!("{}\u{0}{row_id}", entity_key(dependency)),
    }
}

/// The set of keys one read's dependencies make, as a live query holds them.
#[derive(Debug, Clone, Default)]
pub struct DependencySet {
    entities: BTreeSet<String>,
    rows: BTreeSet<String>,
    count: usize,
}

impl DependencySet {
    /// Dependencies are replaced **wholesale** from each execution, never
    /// merged (`live-query.ts:127`).
    pub fn of(dependencies: &[Dependency]) -> Self {
        Self {
            entities: dependencies.iter().map(entity_key).collect(),
            rows: dependencies.iter().map(row_key).collect(),
            count: dependencies.len(),
        }
    }

    /// Skip only when dependency and invalidation both name rows, and different
    /// ones; anything wider reruns (`live-query.ts:99-111`, in v0's order).
    pub fn matches(&self, invalidation: &Invalidation) -> bool {
        if invalidation.source == InvalidationSource::Purge {
            return true;
        }
        if self.count == 0 {
            return true;
        }
        let entity = entity_key(&invalidation.dependency);
        if !self.entities.contains(&entity) {
            return false;
        }
        if invalidation.dependency.row_id.is_none() {
            return true;
        }
        self.rows.contains(&entity) || self.rows.contains(&row_key(&invalidation.dependency))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(dependency: Dependency) -> Invalidation {
        Invalidation {
            dependency,
            source: InvalidationSource::Canonical,
        }
    }

    #[test]
    fn a_purge_always_matches_even_with_no_dependencies() {
        let set = DependencySet::of(&[Dependency::row("tally.expense", "e-1")]);
        assert!(set.matches(&Invalidation {
            dependency: Dependency::entity("*"),
            source: InvalidationSource::Purge,
        }));
    }

    #[test]
    fn a_read_with_no_dependencies_always_reruns() {
        let set = DependencySet::default();
        assert!(set.matches(&canonical(Dependency::row("tally.expense", "e-1"))));
    }

    #[test]
    fn an_entity_miss_never_matches() {
        let set = DependencySet::of(&[Dependency::entity("tally.expense")]);
        assert!(!set.matches(&canonical(Dependency::entity("tally.settlement"))));
    }

    #[test]
    fn a_whole_entity_invalidation_always_matches_that_entity() {
        let set = DependencySet::of(&[Dependency::row("tally.expense", "e-1")]);
        assert!(set.matches(&canonical(Dependency::entity("tally.expense"))));
    }

    #[test]
    fn two_rows_of_one_entity_are_the_only_skip() {
        let set = DependencySet::of(&[Dependency::row("tally.expense", "e-1")]);
        assert!(!set.matches(&canonical(Dependency::row("tally.expense", "e-2"))));
        assert!(set.matches(&canonical(Dependency::row("tally.expense", "e-1"))));
    }

    #[test]
    fn a_whole_entity_dependency_reruns_for_any_row_of_it() {
        let set = DependencySet::of(&[Dependency::entity("tally.expense")]);
        assert!(set.matches(&canonical(Dependency::row("tally.expense", "e-9"))));
    }

    #[test]
    fn coalescing_keeps_one_event_per_table_and_the_wider_claim() {
        let events = vec![
            ChangeEvent::of("tally_expense", ["e-1"], 10),
            ChangeEvent::of("tally_expense", ["e-2"], 11),
            ChangeEvent::of("tally_settlement", [], 12),
            ChangeEvent::of("tally_settlement", ["s-1"], 9),
        ];
        let out = coalesce(events);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].table, "tally_expense");
        assert_eq!(
            out[0].pk_set,
            ["e-1", "e-2"].into_iter().map(str::to_owned).collect()
        );
        assert_eq!(out[0].commit_seq, 11);
        // The empty set is the wide claim and survives the narrow one.
        assert!(out[1].pk_set.is_empty());
        assert_eq!(out[1].commit_seq, 12);
    }
}
