//! `storage` — the whole library's byte custody, as the gateway's sweep counted
//! it. **Three states, because there are three** (D-1020-P1).
//!
//! `queries/storage.ts` reads `blob_custody_rollup`: seven small rows out of a
//! standing sweep — per-bucket counts and bytes for the five custody states,
//! plus `freeable` (locally resident originals with a proved copy elsewhere)
//! and `local-unproven` (locally resident with no such proof, *which no surface
//! may offer to release*).
//!
//! ## Why the port is not v0's shape
//!
//! v0 returns `{computedAt: null, buckets: <all zeroes>}` when the sweep has
//! not run, and the manifest's own description says the answer "must be
//! rendered as *not counted yet* rather than as zeroes". That is a rule about
//! a renderer, enforced nowhere — and `blob_custody_rollup.computed_at` is `NOT
//! NULL` in the schema, so a `null` `computedAt` means **no rows at all**, not
//! a row with no timestamp. Two facts therefore travel together and are one
//! fact: either the sweep has run and there are buckets, or it has not and
//! there are none. [`StorageSummary`] makes that a type:
//!
//! ```text
//! StorageSummary { computed_at: Option<Instant>, buckets: Option<Buckets> }
//! ```
//!
//! with the invariant that the two are `Some` together, checked at
//! construction. A surface that wants a number has to open a `Some` first, so
//! "0 bytes" cannot be printed for a library nobody has counted.
//!
//! ## `local-unproven` is a type, not a flag
//!
//! `freeable` and `local-unproven` are the same physical rows seen two ways:
//! bytes on this disk. The difference is whether a copy elsewhere has been
//! *proved*. Releasing an unproven original destroys the only copy, so the
//! bucket is not merely "not offered by the current UI" — it is not reachable
//! from the type a free-up-space surface consumes. [`Freeable`] is the ONLY
//! thing [`StorageSummary::offerable_release`] hands back, and there is no
//! constructor for it from the unproven bucket.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, read_pages};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageOrder, PageQuery};

/// The seven buckets, in the order v0 declares them
/// (`queries/storage.ts:6-14`). The first five are `blob_custody_state`'s own
/// CHECK vocabulary; the last two are the sweep's derived views over the
/// locally resident rows.
pub const KNOWN_BUCKETS: [&str; 7] = [
    "pending-offsite",
    "local-only",
    "replicated",
    "remote-only",
    "missing",
    "freeable",
    "local-unproven",
];

/// The five buckets that partition the library. `freeable` and `local-unproven`
/// are **views over** them and double-count (`storage-model.ts:84-91`).
pub const CUSTODY_STATE_BUCKETS: [&str; 5] = [
    "pending-offsite",
    "local-only",
    "replicated",
    "remote-only",
    "missing",
];

/// One bucket's totals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Totals {
    pub count: i64,
    pub bytes: i64,
}

impl Totals {
    #[must_use]
    pub const fn new(count: i64, bytes: i64) -> Self {
        Self { count, bytes }
    }

    #[must_use]
    pub const fn plus(self, other: Self) -> Self {
        Self {
            count: self.count + other.count,
            bytes: self.bytes + other.bytes,
        }
    }
}

/// Every bucket the sweep counted, one field per bucket.
///
/// A map keyed by string would let a caller ask for a bucket nobody counts and
/// get a zero; the record cannot be asked a question the sweep does not answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Buckets {
    pub pending_offsite: Totals,
    pub local_only: Totals,
    pub replicated: Totals,
    pub remote_only: Totals,
    pub missing: Totals,
    pub freeable: Totals,
    pub local_unproven: Totals,
}

impl Buckets {
    /// The library, as the five partitioning buckets sum to it.
    #[must_use]
    pub const fn library(&self) -> Totals {
        self.pending_offsite
            .plus(self.local_only)
            .plus(self.replicated)
            .plus(self.remote_only)
            .plus(self.missing)
    }

    fn set(&mut self, bucket: &str, totals: Totals) {
        match bucket {
            "pending-offsite" => self.pending_offsite = totals,
            "local-only" => self.local_only = totals,
            "replicated" => self.replicated = totals,
            "remote-only" => self.remote_only = totals,
            "missing" => self.missing = totals,
            "freeable" => self.freeable = totals,
            "local-unproven" => self.local_unproven = totals,
            // An unknown bucket is skipped, exactly as v0 skips it
            // (`knownBucket` returning null): a sweep that learns a new bucket
            // must not make this screen unreadable in the meantime.
            _ => {}
        }
    }
}

/// BYTES A SURFACE MAY OFFER TO RELEASE. There is no way to build one from the
/// unproven bucket; see the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Freeable(Totals);

impl Freeable {
    #[must_use]
    pub const fn totals(self) -> Totals {
        self.0
    }
}

/// What `storage` answers.
///
/// `computed_at` and `buckets` are `Some` together or `None` together; see
/// [`StorageSummary::counted`] and [`StorageSummary::not_counted_yet`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageSummary {
    computed_at: Option<String>,
    buckets: Option<Buckets>,
}

impl StorageSummary {
    /// The sweep has not run. **Not** zeroes.
    #[must_use]
    pub const fn not_counted_yet() -> Self {
        Self {
            computed_at: None,
            buckets: None,
        }
    }

    /// The sweep ran at `computed_at` and counted `buckets`.
    #[must_use]
    pub fn counted(computed_at: impl Into<String>, buckets: Buckets) -> Self {
        Self {
            computed_at: Some(computed_at.into()),
            buckets: Some(buckets),
        }
    }

    /// When the sweep last ran, or `None` for "not counted yet".
    #[must_use]
    pub fn computed_at(&self) -> Option<&str> {
        self.computed_at.as_deref()
    }

    /// The buckets, or `None` for "not counted yet". A caller that wants a
    /// figure has to open this first.
    #[must_use]
    pub const fn buckets(&self) -> Option<&Buckets> {
        self.buckets.as_ref()
    }

    /// Whether the sweep has ever run for this vault.
    #[must_use]
    pub const fn counted_yet(&self) -> bool {
        self.buckets.is_some()
    }

    /// The bytes a free-up-space surface may offer, and nothing else.
    ///
    /// `None` when the sweep has not run — a surface that has not counted must
    /// not offer to delete. Never derived from `local_unproven`.
    #[must_use]
    pub fn offerable_release(&self) -> Option<Freeable> {
        let buckets = self.buckets.as_ref()?;
        (buckets.freeable.count > 0 && buckets.freeable.bytes > 0)
            .then_some(Freeable(buckets.freeable))
    }
}

/// The statement, verbatim from `queries/storage.ts:47-54`.
///
/// Seven rows keyed by name, read as a walk with a stated ceiling that is
/// nowhere near what the table holds. `ROLLUP_BOUND` is the ceiling, and it
/// reports the size it reaches (D-1020-D3-12).
#[must_use]
pub fn rollup_statement() -> PageQuery {
    PageQuery::new(
        "photos.storage.rollup",
        "bucket, item_count, byte_size, computed_at",
        "blob_custody_rollup",
        PageOrder::asc("bucket", "bucket"),
    )
}

/// One page of 500 is sixty times the seven rows this table holds; the second
/// page exists so a sweep that learns new buckets is read, not refused.
pub const ROLLUP_BOUND: FanOutBound = FanOutBound::new(500, 2);

/// Read the sweep.
pub fn storage_summary(door: &dyn PageDoor) -> KitResult<StorageSummary> {
    let rows = read_pages(door, &rollup_statement(), ROLLUP_BOUND)?;
    Ok(fold_rollup(&rows))
}

/// THE FOLD, pure and testable without a door.
///
/// v0 keeps the LAST `computed_at` it saw while walking in bucket order
/// (`storage.ts:64`); this keeps the EARLIEST, which is what
/// `storage-model.ts:79-80` then does across scopes — "checked at" is the age
/// of the oldest count in the answer, because a figure is only as fresh as its
/// stalest part. With one sweep writing every row in one pass the two agree;
/// they differ only for a half-written rollup, where v0's answer is the newer
/// and therefore the wrong one.
#[must_use]
pub fn fold_rollup(rows: &[Row]) -> StorageSummary {
    let mut buckets = Buckets::default();
    let mut computed_at: Option<String> = None;
    let mut any = false;
    for row in rows {
        let Some(bucket) = text_of(row, "bucket") else {
            continue;
        };
        if !KNOWN_BUCKETS.contains(&bucket.as_str()) {
            continue;
        }
        buckets.set(
            &bucket,
            Totals::new(
                integer_or_zero(row, "item_count"),
                integer_or_zero(row, "byte_size"),
            ),
        );
        any = true;
        if let Some(at) = text_of(row, "computed_at")
            && computed_at.as_ref().is_none_or(|held| at < *held)
        {
            computed_at = Some(at);
        }
    }
    match (any, computed_at) {
        (true, Some(at)) => StorageSummary::counted(at, buckets),
        // Rows with no readable `computed_at` cannot be dated, and an undated
        // count is not a count: `blob_custody_rollup.computed_at` is NOT NULL,
        // so this arm is a door answering something the schema forbids.
        _ => StorageSummary::not_counted_yet(),
    }
}

/// How healthy the library's custody is. Deliberately no `failing`: the rollup
/// carries no error data (`storage-model.ts:31-37`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    /// The sweep has not run. The FIRST arm, and it is not "held".
    Unknown,
    Missing,
    OnlyHere,
    Waiting,
    Held,
}

/// `custodyHealth`, ported (`storage-model.ts:96-102`).
#[must_use]
pub fn health(summary: &StorageSummary) -> Health {
    let Some(buckets) = summary.buckets() else {
        return Health::Unknown;
    };
    if buckets.missing.count > 0 {
        Health::Missing
    } else if buckets.local_only.count > 0 {
        Health::OnlyHere
    } else if buckets.pending_offsite.count > 0 {
        Health::Waiting
    } else {
        Health::Held
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;
    use std::collections::BTreeMap;

    fn row(bucket: &str, count: i64, bytes: i64, at: &str) -> Row {
        let mut row: BTreeMap<String, Cell> = BTreeMap::new();
        row.insert("bucket".to_owned(), Cell::Text(bucket.to_owned()));
        row.insert("item_count".to_owned(), Cell::Integer(count));
        row.insert("byte_size".to_owned(), Cell::Integer(bytes));
        row.insert("computed_at".to_owned(), Cell::Text(at.to_owned()));
        row
    }

    /// THE TEST D-1020-P1 NAMES. An un-swept vault must never yield zeroes.
    #[test]
    fn an_unswept_vault_never_yields_zeroes() {
        let summary = fold_rollup(&[]);
        assert!(!summary.counted_yet());
        assert_eq!(summary.computed_at(), None);
        assert_eq!(summary.buckets(), None);
        assert_eq!(health(&summary), Health::Unknown);
        // And the only way to get a figure out is to open the `Option`, which
        // a caller cannot do for an un-swept vault. There is no
        // `library().count` to read as 0.
        assert!(summary.offerable_release().is_none());
    }

    #[test]
    fn a_swept_vault_carries_its_instant_and_its_buckets_together() {
        let summary = fold_rollup(&[
            row("replicated", 10, 1_000, "2099-06-01T09:00:00.000Z"),
            row("local-only", 2, 200, "2099-06-01T09:00:00.000Z"),
        ]);
        assert!(summary.counted_yet());
        assert_eq!(summary.computed_at(), Some("2099-06-01T09:00:00.000Z"));
        let buckets = summary.buckets().expect("counted");
        assert_eq!(buckets.replicated, Totals::new(10, 1_000));
        assert_eq!(buckets.library(), Totals::new(12, 1_200));
        assert_eq!(health(&summary), Health::OnlyHere);
    }

    /// The library is the five custody states. Adding `freeable` and
    /// `local-unproven` would double-count the same bytes twice over.
    #[test]
    fn the_library_total_excludes_the_two_derived_buckets() {
        let summary = fold_rollup(&[
            row("replicated", 4, 400, "2099-06-01T09:00:00.000Z"),
            row("freeable", 4, 400, "2099-06-01T09:00:00.000Z"),
            row("local-unproven", 1, 100, "2099-06-01T09:00:00.000Z"),
        ]);
        let buckets = summary.buckets().expect("counted");
        assert_eq!(buckets.library(), Totals::new(4, 400));
        assert_eq!(CUSTODY_STATE_BUCKETS.len() + 2, KNOWN_BUCKETS.len());
    }

    /// `local-unproven` IS NEVER OFFERED FOR RELEASE. A type-level marker, not
    /// a flag a caller can unset.
    #[test]
    fn unproven_originals_are_not_reachable_from_the_release_offer() {
        let summary = fold_rollup(&[
            row("local-unproven", 900, 9_000_000, "2099-06-01T09:00:00.000Z"),
            row("freeable", 0, 0, "2099-06-01T09:00:00.000Z"),
        ]);
        assert!(
            summary.offerable_release().is_none(),
            "nine gigabytes of unproven originals must not read as freeable"
        );
        let with_proof = fold_rollup(&[
            row("local-unproven", 900, 9_000_000, "2099-06-01T09:00:00.000Z"),
            row("freeable", 3, 300, "2099-06-01T09:00:00.000Z"),
        ]);
        assert_eq!(
            with_proof.offerable_release().map(Freeable::totals),
            Some(Totals::new(3, 300))
        );
    }

    #[test]
    fn an_unknown_bucket_is_skipped_and_does_not_make_the_screen_unreadable() {
        let summary = fold_rollup(&[
            row("replicated", 1, 1, "2099-06-01T09:00:00.000Z"),
            row("on-tape", 99, 99, "2099-06-01T09:00:00.000Z"),
        ]);
        let buckets = summary.buckets().expect("counted");
        assert_eq!(buckets.library(), Totals::new(1, 1));
    }

    #[test]
    fn the_instant_reported_is_the_stalest_one_in_the_answer() {
        let summary = fold_rollup(&[
            row("replicated", 1, 1, "2099-06-02T09:00:00.000Z"),
            row("local-only", 1, 1, "2099-06-01T09:00:00.000Z"),
        ]);
        assert_eq!(summary.computed_at(), Some("2099-06-01T09:00:00.000Z"));
    }

    #[test]
    fn the_statement_holds_no_predicate_and_orders_by_the_key_it_selects() {
        let query = rollup_statement();
        assert_eq!(query.r#where, None);
        assert_eq!(query.order.sort_column, "bucket");
        assert_eq!(query.order.pk_column, "bucket");
        assert!(query.select.contains("computed_at"));
    }
}
