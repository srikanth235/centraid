//! WHICH bytes to move, and in what order (#1020, D-1020-B5).
//!
//! [`crate::lane`] answers "move these bytes, as far as this window gets".
//! This module answers the question in front of it: *given a window that may
//! last thirty seconds and may last ten minutes, which blobs should a seat ask
//! for, and in what order?*
//!
//! It is pure. It does no I/O, holds no store and opens no connection — it
//! takes a list of [`Want`] and a [`Budget`] and returns an ordered [`Plan`].
//! That is deliberate: scheduling is the part most likely to need changing as
//! real phones report back, and a pure function is the part that can be changed
//! without a device in the room.
//!
//! ## The order is tiers first, recency second
//!
//! ```text
//!   every thumbnail   →   every preview   →   originals
//! ```
//!
//! **Across the whole vault, not per asset.** A seat that fetched thumbnail,
//! preview and original of one photograph before touching the next would show a
//! member one perfect cell and a screen of empty ones. Fetching every thumbnail
//! first fills the grid — the thing a member actually looks at — for about a
//! thousandth of the bytes. v0's mobile replica learned the same thing the same
//! way; `docs/photos/` calls the grid the product.
//!
//! Within a tier, newest first. A grid opens at the top and the top is the most
//! recent thing that happened.
//!
//! ## A budget ORDERS work; it does not veto it
//!
//! The subtle rule, and the one a reviewer should check first. A naive budget
//! refuses anything larger than the window and a 900 MB video is then never
//! fetched on a phone, because no window is ever big enough.
//!
//! But transfers here are resumable per chunk group, so **a partial transfer is
//! progress**, and starting a blob too big to finish is exactly the right move
//! — it is how a large file crosses at all. So the budget stops the plan from
//! queueing *more* work once enough is queued, and never removes the item that
//! crossed the line. [`Plan::items`] can therefore total more than the budget,
//! and a caller that trimmed it back would reintroduce the bug.
//!
//! ## The numbers are REMAINING bytes
//!
//! [`Want::remaining`] is size minus what this device already holds. A resumed
//! original with 2 MB left costs 2 MB of budget, not 900. A planner that
//! budgeted by total size would refuse to finish the very transfers its own
//! earlier windows started.

use crate::hash::ContentHash;

/// Which rendition of a piece of content this is.
///
/// Ordering is the fetch order, so `Thumbnail < Preview < Original` and the
/// derive is the rule rather than a comparison written somewhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    /// A grid cell. Kilobytes. `core_content_derivative.variant = 'thumb'`,
    /// and `'poster'` for a video, which is a thumbnail that happens to be
    /// extracted rather than scaled.
    Thumbnail,
    /// A full-screen view without the original's weight. `'preview'`.
    Preview,
    /// The bytes the member actually took. `core_content_item` itself.
    Original,
}

impl Tier {
    /// The `core_content_derivative.variant` values that are this tier.
    ///
    /// `poster` is a THUMBNAIL. It is how a video gets a grid cell at all, and
    /// filing it anywhere else is what leaves the fourth cell of the demo grid
    /// blank.
    #[must_use]
    pub const fn variants(self) -> &'static [&'static str] {
        match self {
            Self::Thumbnail => &["thumb", "poster"],
            Self::Preview => &["preview"],
            Self::Original => &[],
        }
    }
}

/// One blob a seat would like to have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Want {
    pub hash: ContentHash,
    pub tier: Tier,
    /// The whole blob's size.
    pub size: u64,
    /// Verified bytes this device already holds — [`crate::Holding::held_bytes`].
    pub held: u64,
    /// Higher is newer. The vault's `created_at` as a sortable integer; the
    /// caller decides the unit, this only compares.
    pub recency: i64,
}

impl Want {
    /// What this window would actually have to move. Saturating, because a
    /// store that holds more than the row claims is a store to trust over a
    /// row, not a subtraction to panic on.
    #[must_use]
    pub const fn remaining(&self) -> u64 {
        self.size.saturating_sub(self.held)
    }

    #[must_use]
    pub const fn is_satisfied(&self) -> bool {
        self.held >= self.size
    }
}

/// How much this window is willing to start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    /// Bytes. Once the plan has queued this much it stops queueing more.
    pub bytes: u64,
    /// The most blobs to ask for, however small. A window that queued forty
    /// thousand thumbnails would spend itself on round trips.
    pub items: usize,
}

impl Budget {
    /// A short refresh: iOS's `BGAppRefreshTask` is about thirty seconds and
    /// may be on a cellular link. Enough for a few hundred thumbnails, which is
    /// a visibly fuller grid, and not enough to cost a member money.
    #[must_use]
    pub const fn short_refresh() -> Self {
        Self {
            bytes: 8 * 1024 * 1024,
            items: 400,
        }
    }

    /// The night shift: charging, unmetered, and the gateway is usually one LAN
    /// hop away because that is where the charger is. Minutes, not seconds.
    #[must_use]
    pub const fn night_shift() -> Self {
        Self {
            bytes: 4 * 1024 * 1024 * 1024,
            items: 20_000,
        }
    }

    /// The member is looking at the screen. Nothing is held back; what bounds
    /// this window is the member closing the app.
    #[must_use]
    pub const fn foreground() -> Self {
        Self {
            bytes: u64::MAX,
            items: usize::MAX,
        }
    }
}

/// What this window will ask for, in the order it will ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub items: Vec<Want>,
    /// Wants that were left for a later window. The number a progress line
    /// shows as "and 812 more".
    pub deferred: usize,
    /// The sum of [`Want::remaining`] over [`Self::items`]. **May exceed the
    /// budget** — see the module header; the item that crossed the line is kept
    /// on purpose.
    pub bytes: u64,
}

impl Plan {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// Order the wants and take as many as the budget starts.
///
/// Satisfied wants are dropped rather than ordered: a blob this device already
/// holds whole is not work, and leaving it in would make `deferred` a lie.
#[must_use]
pub fn plan(wants: impl IntoIterator<Item = Want>, budget: Budget) -> Plan {
    let mut outstanding: Vec<Want> = wants
        .into_iter()
        .filter(|want| !want.is_satisfied())
        .collect();

    // Tier first, then newest, then the hash — the last so that two blobs made
    // in the same millisecond have a stable order and a plan is reproducible.
    // A plan that reordered between windows would re-ask for what it had just
    // deferred and defer what it had just asked for.
    outstanding.sort_by(|left, right| {
        left.tier
            .cmp(&right.tier)
            .then(right.recency.cmp(&left.recency))
            .then(left.hash.cmp(&right.hash))
    });

    let total = outstanding.len();
    let mut items = Vec::new();
    let mut bytes = 0u64;
    for want in outstanding {
        // THE BUDGET IS CHECKED BEFORE THE ITEM IS ADDED, NEVER AGAINST IT.
        // That is what lets a blob larger than the whole budget be started: it
        // is admitted while the queue is under budget, and it is the queue that
        // then goes over. A check that refused an oversized item would mean a
        // 900 MB video is never fetched on a phone at all.
        if !items.is_empty() && (bytes >= budget.bytes || items.len() >= budget.items) {
            break;
        }
        bytes = bytes.saturating_add(want.remaining());
        items.push(want);
    }
    Plan {
        deferred: total - items.len(),
        items,
        bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn want(tier: Tier, size: u64, held: u64, recency: i64, seed: &[u8]) -> Want {
        Want {
            hash: ContentHash::of(seed),
            tier,
            size,
            held,
            recency,
        }
    }

    /// THE GRID IS THE PRODUCT. Every thumbnail in the vault comes before the
    /// first preview, and every preview before the first original — across
    /// assets, not within one.
    #[test]
    fn every_thumbnail_precedes_every_preview_and_every_original() {
        let wants = vec![
            want(Tier::Original, 8_000_000, 0, 3, b"o1"),
            want(Tier::Preview, 200_000, 0, 3, b"p1"),
            want(Tier::Thumbnail, 9_000, 0, 1, b"t-old"),
            want(Tier::Original, 8_000_000, 0, 1, b"o2"),
            want(Tier::Thumbnail, 9_000, 0, 3, b"t-new"),
        ];
        let planned = plan(wants, Budget::foreground());
        let tiers: Vec<Tier> = planned.items.iter().map(|want| want.tier).collect();
        assert_eq!(
            tiers,
            vec![
                Tier::Thumbnail,
                Tier::Thumbnail,
                Tier::Preview,
                Tier::Original,
                Tier::Original
            ]
        );
        // And newest first inside the tier.
        assert_eq!(planned.items[0].hash, ContentHash::of(b"t-new"));
    }

    /// THE RULE MOST LIKELY TO BE "FIXED" INTO A BUG. A single blob larger than
    /// the whole window is still started, because the transfer resumes and a
    /// partial transfer is progress. Refusing it means a large video never
    /// crosses on a phone at all.
    #[test]
    fn a_blob_larger_than_the_budget_is_still_started() {
        let video = want(Tier::Original, 900 * 1024 * 1024, 0, 1, b"video");
        let planned = plan(vec![video], Budget::short_refresh());
        assert_eq!(planned.items, vec![video], "the window started nothing");
        assert!(planned.bytes > Budget::short_refresh().bytes);
        assert_eq!(planned.deferred, 0);
    }

    /// The budget is spent on REMAINING bytes. A resumed original with little
    /// left is cheap, which is what lets earlier windows' work be finished
    /// rather than perpetually re-deferred behind fresh work.
    #[test]
    fn the_budget_counts_what_is_left_not_what_it_would_have_cost() {
        let nearly_done = want(Tier::Original, 900_000_000, 899_000_000, 5, b"resumed");
        let fresh = want(Tier::Original, 2_000_000, 0, 4, b"fresh");
        let planned = plan(
            vec![nearly_done, fresh],
            Budget {
                bytes: 4_000_000,
                items: 100,
            },
        );
        assert_eq!(
            planned.items.len(),
            2,
            "both fitted: {} bytes",
            planned.bytes
        );
        assert_eq!(planned.bytes, 1_000_000 + 2_000_000);
    }

    /// A blob already held whole is not work. It is dropped rather than
    /// ordered, so `deferred` counts only what a later window still owes.
    #[test]
    fn a_satisfied_want_is_not_work_and_is_not_deferred() {
        let done = want(Tier::Thumbnail, 9_000, 9_000, 1, b"done");
        let todo = want(Tier::Thumbnail, 9_000, 0, 2, b"todo");
        let planned = plan(vec![done, todo], Budget::foreground());
        assert_eq!(planned.items, vec![todo]);
        assert_eq!(planned.deferred, 0);
    }

    /// The item cap exists so a window is not spent on round trips. Forty
    /// thousand thumbnails is a real camera roll.
    #[test]
    fn the_item_cap_bounds_a_window_of_very_small_blobs() {
        let wants: Vec<Want> = (0..1_000_i64)
            .map(|n| want(Tier::Thumbnail, 900, 0, n, &n.to_le_bytes()))
            .collect();
        let planned = plan(
            wants,
            Budget {
                bytes: u64::MAX,
                items: 50,
            },
        );
        assert_eq!(planned.items.len(), 50);
        assert_eq!(planned.deferred, 950);
    }

    /// A PLAN IS REPRODUCIBLE. Two windows over the same unchanged vault
    /// produce the same order, so the second does not re-ask for what the first
    /// deferred and defer what the first asked for.
    #[test]
    fn the_order_is_stable_when_recency_ties() {
        let wants: Vec<Want> = (0..20_i64)
            .map(|n| want(Tier::Thumbnail, 900, 0, 7, &n.to_le_bytes()))
            .collect();
        let first = plan(wants.clone(), Budget::foreground());
        let mut shuffled = wants;
        shuffled.reverse();
        let second = plan(shuffled, Budget::foreground());
        assert_eq!(first.items, second.items);
    }

    /// A video's poster IS its thumbnail. Filing it anywhere else is what
    /// leaves a video's cell blank in a grid that is otherwise full.
    #[test]
    fn a_poster_is_a_thumbnail() {
        assert!(Tier::Thumbnail.variants().contains(&"poster"));
        assert!(Tier::Thumbnail.variants().contains(&"thumb"));
        assert!(!Tier::Preview.variants().contains(&"poster"));
    }
}
