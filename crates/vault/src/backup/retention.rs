//! Which snapshots to keep and which names are garbage (spec §6.2 step 7,
//! [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! **Retention** is 7 daily, 4 weekly and 6 monthly snapshots, plus the
//! newest. **Collection** lists a gateway's names, works out the union of what
//! the kept trees reach, and deletes the rest with one head-bound signed
//! delete: the keep set is computed at the head it names, so a gateway whose
//! head is any other (rolled back, or moved by another writer) refuses it.
//!
//! The union is the head, `conf`, `troot`, `oroot`, every kept snapshot, the
//! newest snapshot, and anything an Undo restored this week. **A kept root
//! whose nodes will not open stops collection: doubt never deletes.** The
//! gateway is listed before the union is worked out, so an object that lands
//! meanwhile is never judged.

use std::collections::{BTreeMap, BTreeSet};

use centraid_media::sealed::{self, Class, Name, Ref};

use super::engine::{Env, UNDO_KEEP_MS};
use super::store::{SnapshotEntry, Store, StoreError, delete_all, list_all};
use super::tree::{self, Node, NodeSource};
use super::{Result, invariant};

/// Daily snapshots kept.
pub const KEEP_DAILY: usize = 7;
/// Weekly snapshots kept.
pub const KEEP_WEEKLY: usize = 4;
/// Monthly snapshots kept.
pub const KEEP_MONTHLY: usize = 6;

const DAY_MS: u64 = 86_400_000;

fn month_of(ms: u64) -> i64 {
    let seconds = i64::try_from(ms / 1000).unwrap_or(0);
    let date = jiff::Timestamp::from_second(seconds)
        .map(|at| at.to_zoned(jiff::tz::TimeZone::UTC).date())
        .unwrap_or_default();
    i64::from(date.year()) * 12 + i64::from(date.month())
}

/// The snapshots to keep: the newest of each of the 7 most recent days that have one, of each of
/// the 4 most recent weeks, of each of the 6 most recent months, and the newest of all. A held
/// snapshot (its delete already in its week) is not a candidate. A snapshot dated after `now_ms`
/// is judged as taken at `now_ms`, and snapshots are ordered by signed `(epoch, generation)`
/// before any clock.
#[must_use]
pub fn keep_at(snapshots: &[SnapshotEntry], now_ms: u64) -> BTreeSet<Name> {
    let mut live: Vec<&SnapshotEntry> = snapshots
        .iter()
        .filter(|snapshot| snapshot.held_at_ms.is_none())
        .collect();
    live.sort_by_key(|snapshot| {
        std::cmp::Reverse((
            snapshot.epoch,
            snapshot.generation,
            snapshot.taken_at_ms.min(now_ms),
            snapshot.name,
        ))
    });
    let mut kept = BTreeSet::new();
    if let Some(newest) = live.first() {
        kept.insert(newest.name);
    }
    let mut buckets: [(BTreeSet<i64>, usize); 3] = [
        (BTreeSet::new(), KEEP_DAILY),
        (BTreeSet::new(), KEEP_WEEKLY),
        (BTreeSet::new(), KEEP_MONTHLY),
    ];
    for snapshot in live {
        let taken = snapshot.taken_at_ms.min(now_ms);
        let day = i64::try_from(taken / DAY_MS).unwrap_or(0);
        let keys = [day, day / 7, month_of(taken)];
        for ((seen, limit), key) in buckets.iter_mut().zip(keys) {
            if seen.len() < *limit && seen.insert(key) {
                kept.insert(snapshot.name);
            }
        }
    }
    kept
}

/// [`keep_at`] without a clock bound, for callers that do not pass `now_ms`.
#[must_use]
pub fn keep(snapshots: &[SnapshotEntry]) -> BTreeSet<Name> {
    keep_at(snapshots, u64::MAX)
}

/// What a collection did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Collected {
    /// Names listed, names kept, names deleted.
    Done {
        listed: usize,
        kept: usize,
        deleted: usize,
    },
    /// A kept root's nodes would not open, or the gateway moved: nothing was deleted.
    Doubt(String),
}

/// A node source that falls back to the gateway for nodes the cache does not hold, and caches
/// what it fetches, so a kept snapshot's tree can be walked.
struct Fetching<'a> {
    env: &'a Env<'a>,
    store: &'a dyn Store,
}

impl NodeSource for Fetching<'_> {
    fn plaintext(&self, name: &Name) -> Result<Option<Vec<u8>>> {
        if let Some(plaintext) = self.env.state.get_node(name)? {
            return Ok(Some(plaintext));
        }
        let mut object = Vec::new();
        match self.store.get(name, &mut object) {
            Ok(_) => {}
            Err(StoreError::Missing(_)) => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let Ok(plaintext) =
            sealed::open_checked(self.env.keys, name, Class::Records, None, None, &object)
        else {
            return Ok(None);
        };
        // A node is only worth keeping if it decodes.
        if Node::decode(&plaintext).is_err() && !looks_like_directory(&plaintext) {
            return Ok(None);
        }
        self.env.state.put_node(name, &plaintext)?;
        Ok(Some(plaintext))
    }
}

fn looks_like_directory(plaintext: &[u8]) -> bool {
    plaintext.first() == Some(&b'{')
}

/// Collect `store`: delete every name no kept root reaches.
///
/// # Errors
/// The state's refusal, or a store error that is not an answer about this delete.
pub fn collect(env: &Env<'_>, store: &dyn Store) -> Result<Collected> {
    let id = store.gateway_id().to_owned();
    let Some(gateway) = env.state.gateway(&id)? else {
        return Err(invariant("collecting an unpaired gateway"));
    };
    // The head the keep set is computed at, and the only head the delete is bound to.
    let Some(head) = store.head()? else {
        return Ok(Collected::Doubt("the gateway has no head".to_owned()));
    };
    let snapshots = store.snapshots()?;
    let kept = keep_at(&snapshots, env.now_ms);
    let listing = list_all(store)?;

    let source = Fetching { env, store };
    let mut roots: BTreeSet<Name> = kept;
    roots.insert(head.name);
    for pointer in [gateway.conf, gateway.troot, gateway.oroot]
        .into_iter()
        .flatten()
    {
        roots.insert(pointer.0);
    }
    if let Some((newest, _)) = env.state.device()?.newest {
        roots.insert(newest);
    }
    let mut keep_names: BTreeSet<Name> = env.state.undone_names(&id, env.now_ms)?;
    for name in &roots {
        // The root's own ref: from the cache, or resealed from what the gateway holds.
        let reference = match env.state.get_node(name)? {
            Some(plaintext) => sealed::seal(env.keys, Class::Records, &plaintext)?.reference(),
            None => match source.plaintext(name)? {
                Some(plaintext) => sealed::seal(env.keys, Class::Records, &plaintext)?.reference(),
                None => {
                    return Ok(Collected::Doubt(format!(
                        "the kept root {name} will not open"
                    )));
                }
            },
        };
        match tree::everything_of(&source, &reference) {
            Ok(names) => keep_names.extend(names),
            Err(error) => {
                return Ok(Collected::Doubt(format!(
                    "the kept root {name} will not open: {error}"
                )));
            }
        }
    }
    let garbage: Vec<Name> = listing
        .iter()
        .map(|entry| entry.name)
        .filter(|name| !keep_names.contains(name))
        .collect();
    let bound = if env.bugs.unbound_delete() {
        // THE PLANTED BUG: bound to whatever head stands when the delete is sent.
        store.head()?.map(|head| head.name)
    } else {
        Some(head.name)
    };
    let deleted = match delete_all(store, &garbage, bound.as_ref()) {
        Ok(deleted) => deleted,
        Err(StoreError::HeadConflict { .. }) => {
            return Ok(Collected::Doubt(
                "the head moved while the keep set was computed".to_owned(),
            ));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(Collected::Done {
        listed: listing.len(),
        kept: keep_names.len(),
        deleted: deleted.deleted.len() + deleted.freed.len(),
    })
}

/// Names an Undo lifted: kept from collection for a week.
///
/// # Errors
/// The state's refusal, or the gateway's.
pub fn undo(env: &Env<'_>, store: &dyn Store, names: &[Name]) -> Result<u64> {
    let lifted = store.undo(Some(names))?;
    env.state
        .undone_add(store.gateway_id(), names, env.now_ms + UNDO_KEEP_MS)?;
    Ok(lifted)
}

/// The refs of a kept set, for tests that look at what survives.
///
/// # Errors
/// A missing node.
pub fn reachable(source: &dyn NodeSource, roots: &[Ref]) -> Result<BTreeMap<Name, ()>> {
    let mut out = BTreeMap::new();
    for root in roots {
        for name in tree::everything_of(source, root)? {
            out.insert(name, ());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(id: u8, epoch: u64, generation: u64, taken_at_ms: u64) -> SnapshotEntry {
        SnapshotEntry {
            name: Name::from_bytes([id; 32]),
            taken_at_ms,
            registered_at_ms: taken_at_ms,
            epoch,
            generation,
            held_at_ms: None,
            purge_after_ms: None,
        }
    }

    #[test]
    fn future_dated_snapshots_are_clamped_to_now_and_signed_order_wins() {
        let now = 1_750_000_000_000_u64;
        // Ten distinct days in the past (days 0..9 before now).
        let mut entries: Vec<SnapshotEntry> = (1..=10_u8)
            .map(|d| snap(d, 1, u64::from(11 - d), now - u64::from(d) * DAY_MS))
            .collect();
        // A snapshot from an older generation with a clock set far into the future,
        // and a newer generation taken at `now`.
        let future_old = snap(200, 1, 11, now + 365 * DAY_MS);
        let current = snap(201, 1, 12, now);
        entries.push(future_old);
        entries.push(current);

        let kept = keep_at(&entries, now);
        assert!(
            kept.contains(&current.name),
            "highest (epoch, generation) is newest and kept"
        );
        // Both `future_old` (clamped to `now`) and `current` (at `now`) fall in the same day/week/month
        // bucket, and `current` wins the bucket because its signed (epoch, generation) is greater.
        assert!(
            !kept.contains(&future_old.name),
            "future-dated older generation is clamped to now and loses the bucket to current"
        );
    }

    #[test]
    fn higher_epoch_orders_ahead_of_higher_generation_and_later_clock() {
        let now = 1_750_000_000_000_u64;
        let old_epoch = snap(1, 1, 99, now);
        let new_epoch = snap(2, 2, 1, now - 10_000);
        let kept = keep_at(&[old_epoch, new_epoch], now);
        // Same UTC day/week/month, so only the first in signed order is kept.
        assert_eq!(kept, BTreeSet::from([new_epoch.name]));
    }
}
