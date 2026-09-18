//! WHICH bytes to move, and in what order (#1020, D-1020-B5).
//!
//! [`crate::lane`] answers "move these bytes, as far as this window gets".
//! This module answers the question in front of it: *given a window that may
//! last thirty seconds and may last ten minutes, which blobs should a seat ask
//! for, and in what order?*
//!
//! It is pure. It does no I/O, holds no store and opens no connection — it
//! takes a list of [`Want`] and a [`Budget`] and returns an ordered [`Plan`].
//! [`wants_from_custody`] is where those wants come from now: the vault's own
//! blob-custody rows (#1029 §4, W6), which is what gave the member's transfer
//! rule something to govern again after `seat.sync` left with the seat plane.
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
    /// THESE BYTES ARE A MOVING IMAGE (#1025 S4).
    ///
    /// The one distinction the member's transfer rule draws inside a tier:
    /// `WIFI_AND_CELLULAR_PHOTOS` lets a photograph's original cross a link
    /// the member is paying for and never a video's, because the two differ by
    /// three orders of magnitude and a member who said "photos on cellular"
    /// did not say "a 900 MB video on cellular".
    ///
    /// It is a fact about the CONTENT and not about the tier, so it rides the
    /// want: a thumbnail of a video is a thumbnail, costs kilobytes, and
    /// crosses on any link — which is what puts the video's cell in the grid
    /// at all.
    pub moving: bool,
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
    /// THE MEMBER IS PAYING BY THE MEGABYTE.
    ///
    /// Half of the answer to "may this window fetch an original"; the other
    /// half is [`Self::originals`], the member's own rule. Kept apart because
    /// they are separately true — a night shift on a tethered phone is a night
    /// shift, metered — and because only one of them is a fact about the
    /// radio.
    pub metered: bool,
    /// THE MEMBER'S TRANSFER RULE (#1025 S4).
    ///
    /// **A selector and never a byte count.** A ceiling and a ban are
    /// different things and the difference is the member's bill. A small
    /// `bytes` still ADMITS one original — the plan deliberately never refuses
    /// an item for being larger than the whole budget, because that is the
    /// only way a 900 MB video ever crosses — so a metered link bounded only
    /// by bytes starts a video on a cellular plan and keeps resuming it every
    /// window until it is whole.
    ///
    /// The rule therefore removes the tier from the plan rather than shrinking
    /// it. Thumbnails and previews still cross on any link, because a grid a
    /// member can look at costs kilobytes and is the product; the originals
    /// wait for the link the member said they would wait for.
    ///
    /// It is a per-DEVICE setting, not a per-vault one: what it governs is a
    /// data plan, and a phone has one data plan however many vaults it holds.
    pub originals: OriginalsRule,
    /// THE ONE ITEM A MEMBER ASKED FOR BY NAME (#1025 S5).
    ///
    /// WhatsApp's download arrow. `Some(hash)` narrows this window to that
    /// blob and **suspends every tier rule for it**: the member overrode the
    /// rule for one item, which is exactly what the affordance means, and a
    /// window that then withheld it would be answering a tap with nothing.
    ///
    /// It is an override and not a bypass: the rule is untouched, the next
    /// ordinary window plans by it again, and nothing else crosses in this
    /// one.
    pub only: Option<ContentHash>,
}

/// WHEN THIS DEVICE MAY FETCH ORIGINALS — the member's setting, as one value
/// (#1025 S4).
///
/// WhatsApp's auto-download model, and the reason it is the right one: bytes
/// are never pushed, they are PLANNED, and the plan is a member's setting. The
/// gateway has no opinion on what a phone pays for and could not have one.
///
/// **Thumbnails and previews are not in this enum**, which is the shape of the
/// ruling rather than an omission. A thumbnail crosses on any link and ahead
/// of everything (`Tier`'s ordering, D-1025-S7-51) because it is kilobytes and
/// it is the grid, and the grid is the product; a preview crosses on any link
/// too and is bounded by the short-refresh budget instead. Only the originals
/// are worth a member's decision.
///
/// The fixed rule **a video's original never crosses a metered link** is
/// [`Self::WifiAndCellularPhotos`]'s own body and is not a fourth case: no
/// member setting turns it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OriginalsRule {
    /// THE DEFAULT. Originals wait for a link the member is not paying for.
    ///
    /// Default because it is the one whose failure mode is a photograph that
    /// arrives late, and the alternatives' failure mode is a bill.
    #[default]
    WifiOnly,
    /// A photograph's original may cross a metered link; a video's may not.
    WifiAndCellularPhotos,
    /// NO ORIGINAL CROSSES ON ANY LINK unless the member taps it
    /// ([`Budget::only`]).
    ///
    /// Not "Wi-Fi off": a member on unlimited fibre may still want a phone
    /// that holds thumbnails and fetches a full-size photograph only when they
    /// ask for one, because the constraint being spent is the device's disk
    /// rather than its data plan.
    Manual,
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
            metered: false,
            originals: OriginalsRule::WifiOnly,
            only: None,
        }
    }

    /// The night shift: charging, unmetered, and the gateway is usually one LAN
    /// hop away because that is where the charger is. Minutes, not seconds.
    #[must_use]
    pub const fn night_shift() -> Self {
        Self {
            bytes: 4 * 1024 * 1024 * 1024,
            items: 20_000,
            metered: false,
            originals: OriginalsRule::WifiOnly,
            only: None,
        }
    }

    /// The member is looking at the screen. Nothing is held back; what bounds
    /// this window is the member closing the app.
    #[must_use]
    pub const fn foreground() -> Self {
        Self {
            bytes: u64::MAX,
            items: usize::MAX,
            metered: false,
            originals: OriginalsRule::WifiOnly,
            only: None,
        }
    }

    /// The same ceiling, over a link the MEMBER IS PAYING FOR (#1025 S5).
    ///
    /// A modifier rather than a fourth constructor, because "which plan" and
    /// "who is paying for the bytes" are two facts a shell knows separately: a
    /// night shift on a tethered phone is a night shift, metered.
    ///
    /// It no longer decides the originals by itself — [`Self::originals`] is
    /// the member's rule and this is one of its two inputs (#1025 S4).
    #[must_use]
    pub const fn metered(self) -> Self {
        Self {
            metered: true,
            ..self
        }
    }

    /// The same window, under the member's transfer rule (#1025 S4).
    #[must_use]
    pub const fn under(self, rule: OriginalsRule) -> Self {
        Self {
            originals: rule,
            ..self
        }
    }

    /// THE MEMBER TAPPED THIS ONE (#1025 S5). See [`Self::only`].
    #[must_use]
    pub const fn just(self, hash: ContentHash) -> Self {
        Self {
            only: Some(hash),
            ..self
        }
    }

    /// May an original of these bytes cross in this window?
    ///
    /// THE WHOLE ARITHMETIC OF THE MEMBER'S RULE, in one place and in Rust.
    /// No shell computes any part of it: a Kotlin or Swift copy of this table
    /// would be a second rule to keep true, and the one that decides a
    /// member's bill is the worst candidate for a second copy.
    #[must_use]
    pub const fn admits_original(&self, moving: bool) -> bool {
        match self.originals {
            // The member asks for each one. Nothing arrives on its own, on any
            // link — `only` is the override and it is checked before this.
            OriginalsRule::Manual => false,
            OriginalsRule::WifiOnly => !self.metered,
            // A photograph crosses; a video waits. The fixed rule.
            OriginalsRule::WifiAndCellularPhotos => !self.metered || !moving,
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
    /// ORIGINALS THIS WINDOW REFUSED TO ASK FOR because the link is metered
    /// (#1025 S5). Counted in [`Self::deferred`] as well: they are still owed.
    ///
    /// Its own number because it is the one reason a plan can be EMPTY over a
    /// non-empty want list, and an empty plan with no explanation is
    /// indistinguishable from a caught-up device. That is precisely how a
    /// metered flag set from a wrong input looks from outside: a grid of
    /// placeholders, `blobsCompleted = 0`, and no stream ever opened.
    pub withheld: usize,
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
    // THE MEMBER TAPPED ONE (#1025 S5). Everything else leaves this window,
    // and it leaves BEFORE `total` is counted: a one-item fetch is not a
    // report that the rest of the vault was deferred, and a progress line
    // saying "and 812 more" over a member's single tap would be describing a
    // different window.
    //
    // The rule is not consulted for it at all. A member who taps the download
    // arrow has overridden the rule for that item, which is what the
    // affordance means; re-applying the rule here is how a tap answers with
    // nothing.
    if let Some(only) = budget.only {
        outstanding.retain(|want| want.hash == only);
        let bytes = outstanding.iter().map(Want::remaining).sum();
        return Plan {
            deferred: 0,
            items: outstanding,
            bytes,
            withheld: 0,
        };
    }
    // WHAT IS OWED, counted BEFORE the member's rule takes the originals out.
    // An original a rule withholds is still work a later window owes, so it
    // belongs in `deferred`; counting after the retain would report "and 0
    // more" to a member whose videos are all waiting.
    let total = outstanding.len();
    // NOT ASKED FOR UNDER THE MEMBER'S TRANSFER RULE, and removed rather than
    // squeezed out by the byte ceiling: see `Budget::originals`.
    let before = outstanding.len();
    outstanding.retain(|want| want.tier != Tier::Original || budget.admits_original(want.moving));
    let withheld = before - outstanding.len();

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
        withheld,
    }
}

/// **TURN THE VAULT'S BLOB CUSTODY INTO WANTS** (#1029 §4, W6, hand-off 4).
///
/// ## What this closes
///
/// [`OriginalsRule`] — the member's transfer rule — and the two "Download
/// settings" sheets that set it had nothing to govern. `SyncWindow` carried it
/// to a `seat.sync` that left with the seat plane, and [`plan`] had no caller
/// at all: `grep -rn 'centraid_blobs::plan' crates/` outside this crate was
/// empty. A setting a member can change and nothing reads is worse than no
/// setting, because it says the phone is obeying something.
///
/// The rule was never wrong; what it governed went away. In the phone-is-the-
/// vault model the thing it governs is this: **which of the blobs the vault
/// already knows about does this window ask the gateway for.** The vault's
/// custody rows say what exists and how big it is
/// (`centraid_vault::backup::custody`), the byte store says how much of each is
/// already here, and this turns the pair into the [`Want`]s [`plan`] orders.
///
/// ## The tier is the ROLE, and that is the whole mapping
///
/// A `thumbnail` custody row is [`Tier::Thumbnail`] and an `original` row is
/// [`Tier::Original`]. There is no preview tier here: a preview is a
/// `core_content_derivative` and has no custody row of its own, so a caller
/// that wants previews planned hands them in beside these.
///
/// A blob with **no placement** is left out. It is a row the vault admitted and
/// has not sealed yet — the crash window between `custody::admit` and
/// `custody::record_placements` — and there is nowhere to fetch it from, so
/// asking for it would be a want no window can ever satisfy.
///
/// `recency` is the caller's, because the vault's own `created_at` is a string
/// and the comparison here is an integer; `moving` likewise, because whether a
/// blob is a video is a `core_content_item.media_type` question and this crate
/// holds no rows.
pub fn wants_from_custody<'a>(
    blobs: impl IntoIterator<Item = &'a centraid_vault::backup::custody::Custody>,
    held: &std::collections::HashMap<ContentHash, u64>,
    recency: impl Fn(&str) -> i64,
    moving: impl Fn(&str) -> bool,
) -> Vec<Want> {
    use centraid_vault::backup::custody::BlobRole;

    blobs
        .into_iter()
        .filter(|blob| !blob.placements.is_empty())
        .filter_map(|blob| {
            let hash = ContentHash::parse_hex(&blob.plaintext_hash).ok()?;
            Some(Want {
                hash,
                tier: match blob.role {
                    BlobRole::Thumbnail => Tier::Thumbnail,
                    BlobRole::Original => Tier::Original,
                },
                size: blob.plaintext_bytes,
                held: held.get(&hash).copied().unwrap_or(0),
                recency: recency(&blob.plaintext_hash),
                moving: moving(&blob.plaintext_hash),
            })
        })
        .collect()
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
            moving: false,
        }
    }

    /// The same, of a video: the one distinction the member's rule draws
    /// inside the originals tier.
    fn moving(tier: Tier, size: u64, recency: i64, seed: &[u8]) -> Want {
        Want {
            moving: true,
            ..want(tier, size, 0, recency, seed)
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
                ..Budget::foreground()
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
                ..Budget::foreground()
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

    /// THE THREE SELECTORS ARE THREE DIFFERENT PLANS over one set of wants.
    ///
    /// The point of the shell choosing: before #1025 S5 every pass core-ffi
    /// ever ran took `foreground()`, so a thirty-second cellular refresh and a
    /// night on the charger asked for exactly the same thing.
    #[test]
    fn each_selector_plans_a_different_window() {
        // Enough small blobs that the short refresh's item cap bites, and one
        // original large enough that only an unbounded window finishes it.
        let mut wants: Vec<Want> = (0..1_000_i64)
            .map(|n| want(Tier::Thumbnail, 8_000, 0, n, &n.to_le_bytes()))
            .collect();
        wants.push(want(Tier::Original, 900_000_000, 0, 0, b"a long video"));

        let short = plan(wants.clone(), Budget::short_refresh());
        let night = plan(wants.clone(), Budget::night_shift());
        let front = plan(wants.clone(), Budget::foreground());

        assert_eq!(short.items.len(), 400, "the short refresh's item cap");
        assert_eq!(
            night.items.len(),
            1_001,
            "the night shift has room for the whole roll and the video"
        );
        assert_eq!(front.items.len(), 1_001);
        // AND THEY ARE NOT THE SAME WINDOW. The short refresh never reaches the
        // original at all, because every thumbnail is ordered in front of it.
        assert!(
            short.items.iter().all(|item| item.tier == Tier::Thumbnail),
            "a thirty-second cellular window started an original"
        );
        assert!(night.items.iter().any(|item| item.tier == Tier::Original));
        assert_eq!(short.deferred, 601);
    }

    /// A METERED WINDOW FETCHES NO ORIGINALS AT ALL, and the ceiling could not
    /// have done it: the plan admits an item larger than the whole budget on
    /// purpose, so bytes alone would start the video and resume it every window
    /// until the member's bill arrived.
    #[test]
    fn a_metered_window_fetches_no_originals_and_still_fills_the_grid() {
        let wants = vec![
            want(Tier::Thumbnail, 40_000, 0, 3, b"cell"),
            want(Tier::Preview, 400_000, 0, 2, b"full screen"),
            want(Tier::Original, 900_000_000, 0, 1, b"a long video"),
        ];
        let metered = plan(wants.clone(), Budget::short_refresh().metered());
        assert!(
            metered.items.iter().all(|item| item.tier != Tier::Original),
            "a metered window planned an original"
        );
        assert_eq!(metered.items.len(), 2, "the grid and the full-screen view");
        // STILL OWED. A withheld original is work a later window on an
        // unmetered link does, and a member is told there is more.
        assert_eq!(metered.deferred, 1);
        // AND NAMED AS WITHHELD, which is what lets an empty plan be told
        // apart from a caught-up device.
        assert_eq!(metered.withheld, 1);
        // And the same budget unmetered does start it, so the difference is the
        // metered flag and nothing else.
        let unmetered = plan(wants, Budget::short_refresh());
        assert!(
            unmetered
                .items
                .iter()
                .any(|item| item.tier == Tier::Original)
        );
    }

    /// THE MEMBER'S RULE, EVERY CELL OF IT (#1025 S4).
    ///
    /// Three rules x metered/unmetered x photograph/video, asserted as a table
    /// rather than as six tests, because the thing a reviewer has to check is
    /// that the TABLE is right and a table split across six functions is a
    /// table nobody reads as one.
    ///
    /// The two properties that hold in every cell are asserted below it: the
    /// thumbnail and the preview always cross, and `withheld` counts exactly
    /// what the rule took out.
    #[test]
    fn the_transfer_rule_decides_the_originals_and_nothing_else() {
        // rule, metered, may a photograph cross, may a video cross
        let table = [
            (OriginalsRule::WifiOnly, false, true, true),
            (OriginalsRule::WifiOnly, true, false, false),
            (OriginalsRule::WifiAndCellularPhotos, false, true, true),
            // THE FIXED RULE: videos never on cellular, whatever the member set.
            (OriginalsRule::WifiAndCellularPhotos, true, true, false),
            // MANUAL WITHHOLDS ON AN UNMETERED LINK TOO. That is the case a
            // "metered" flag could never have expressed, and the reason the
            // rule is a third input rather than a spelling of the flag.
            (OriginalsRule::Manual, false, false, false),
            (OriginalsRule::Manual, true, false, false),
        ];
        for (rule, metered, photo_crosses, video_crosses) in table {
            let wants = vec![
                want(Tier::Thumbnail, 40_000, 0, 4, b"cell"),
                want(Tier::Preview, 400_000, 0, 3, b"full screen"),
                want(Tier::Original, 6_000_000, 0, 2, b"a photograph"),
                moving(Tier::Original, 900_000_000, 1, b"a long video"),
            ];
            let budget = if metered {
                Budget::foreground().under(rule).metered()
            } else {
                Budget::foreground().under(rule)
            };
            let planned = plan(wants, budget);
            let has = |seed: &[u8]| {
                planned
                    .items
                    .iter()
                    .any(|item| item.hash == ContentHash::of(seed))
            };
            assert_eq!(
                has(b"a photograph"),
                photo_crosses,
                "{rule:?} metered={metered}: the photograph's original"
            );
            assert_eq!(
                has(b"a long video"),
                video_crosses,
                "{rule:?} metered={metered}: the video's original"
            );
            // THE GRID IS THE PRODUCT, under every rule there is. A member who
            // set `Manual` on a metered link still gets a library they can
            // look at; what waits is the full-size file.
            assert!(
                has(b"cell") && has(b"full screen"),
                "{rule:?} metered={metered}: a rule reached past the originals"
            );
            // AND THE NUMBER IS THE REASON. `withheld` is what lets an empty
            // plan be told apart from a caught-up device, so it has to count
            // exactly what the rule removed and nothing the ceiling did.
            let expected = usize::from(!photo_crosses) + usize::from(!video_crosses);
            assert_eq!(
                planned.withheld, expected,
                "{rule:?} metered={metered}: withheld"
            );
            // Still owed, and a member is told there is more.
            assert_eq!(planned.deferred, expected);
        }
    }

    /// A WITHHELD ORIGINAL IS NOT A MISSING ONE. Its thumbnail and its preview
    /// are both there, so the cell a member taps is drawn and the affordance
    /// has something to sit on.
    #[test]
    fn a_manual_rule_still_fills_the_grid_on_an_unmetered_link() {
        let wants = vec![
            want(Tier::Thumbnail, 40_000, 0, 3, b"cell"),
            want(Tier::Preview, 400_000, 0, 2, b"full screen"),
            want(Tier::Original, 6_000_000, 0, 1, b"a photograph"),
        ];
        let planned = plan(wants, Budget::night_shift().under(OriginalsRule::Manual));
        assert_eq!(planned.items.len(), 2);
        assert_eq!(planned.withheld, 1);
        assert!(planned.items.iter().all(|item| item.tier != Tier::Original));
    }

    /// FETCH THIS ONE NOW (#1025 S5). WhatsApp's download arrow: a member
    /// action that overrides the rule for ONE item, on the link they are on.
    ///
    /// The strictest possible setting on the most expensive possible link —
    /// `Manual`, metered — which is the case where a window that re-applied
    /// the rule would answer a tap with nothing.
    #[test]
    fn a_named_fetch_lands_that_one_blob_and_nothing_else() {
        let tapped = moving(Tier::Original, 900_000_000, 1, b"a long video");
        let wants = vec![
            want(Tier::Thumbnail, 40_000, 0, 4, b"cell"),
            want(Tier::Original, 6_000_000, 0, 2, b"a photograph"),
            tapped,
        ];
        let planned = plan(
            wants,
            Budget::foreground()
                .under(OriginalsRule::Manual)
                .metered()
                .just(tapped.hash),
        );
        assert_eq!(planned.items, vec![tapped], "the tap was answered");
        // AND NOTHING ELSE CROSSED — not the other original, and not even the
        // thumbnail the ordinary window would have taken first. A one-item
        // window is one item.
        assert_eq!(planned.deferred, 0);
        assert_eq!(planned.withheld, 0, "a tap is not a withholding");
    }

    /// A SECOND TAP ON A BLOB THIS DEVICE ALREADY HOLDS IS NOTHING TO DO.
    ///
    /// The satisfied filter is what makes it a no-op, and it runs before the
    /// `only` narrowing for exactly this reason: a held blob is not work under
    /// any budget, an override included.
    #[test]
    fn a_named_fetch_of_a_held_blob_plans_nothing() {
        let done = want(Tier::Original, 6_000_000, 6_000_000, 1, b"a photograph");
        let planned = plan(vec![done], Budget::foreground().just(done.hash));
        assert!(planned.is_empty());
        assert_eq!(planned.bytes, 0);
    }

    /// A NAMED FETCH FOR A HASH NO WANT CARRIES PLANS NOTHING, rather than
    /// planning the whole vault. The refusal a member reads is the core's, and
    /// it is a code; what this asserts is that the planner does not quietly
    /// widen a window whose one item it could not find.
    #[test]
    fn a_named_fetch_for_an_unknown_hash_plans_nothing() {
        let planned = plan(
            vec![want(Tier::Original, 6_000_000, 0, 1, b"a photograph")],
            Budget::foreground().just(ContentHash::of(b"never heard of it")),
        );
        assert!(planned.is_empty());
    }

    /// A video's poster IS its thumbnail. Filing it anywhere else is what
    /// leaves a video's cell blank in a grid that is otherwise full.
    #[test]
    fn a_poster_is_a_thumbnail() {
        assert!(Tier::Thumbnail.variants().contains(&"poster"));
        assert!(Tier::Thumbnail.variants().contains(&"thumb"));
        assert!(!Tier::Preview.variants().contains(&"poster"));
    }

    // ------------------------------------------------- custody into wants ----

    fn custody_row(
        seed: u8,
        role: centraid_vault::backup::custody::BlobRole,
        bytes: u64,
        placed: bool,
    ) -> centraid_vault::backup::custody::Custody {
        use centraid_vault::backup::custody::{Custody, FileKey, Placement};
        Custody {
            plaintext_hash: hex::encode([seed; 32]),
            file_key: FileKey::fresh().expect("draws"),
            plaintext_bytes: bytes,
            role,
            placements: if placed {
                vec![Placement {
                    part_index: 0,
                    object_name: hex::encode([seed.wrapping_add(1); 32]),
                    byte_offset: 0,
                    byte_length: bytes,
                }]
            } else {
                Vec::new()
            },
        }
    }

    /// **HAND-OFF 4.** The member's transfer rule governs the vault's own
    /// custody rows: every thumbnail crosses, and a `MANUAL` rule withholds
    /// every original — which is the whole of what the two "Download settings"
    /// sheets set, connected to something that reads it.
    #[test]
    fn the_transfer_rule_governs_the_blobs_the_vault_holds_custody_of() {
        use centraid_vault::backup::custody::BlobRole;

        let rows = [
            custody_row(1, BlobRole::Thumbnail, 2048, true),
            custody_row(2, BlobRole::Thumbnail, 2048, true),
            custody_row(3, BlobRole::Original, 4_000_000, true),
            custody_row(4, BlobRole::Original, 900_000_000, true),
        ];
        let held = std::collections::HashMap::new();
        let wants = wants_from_custody(
            &rows,
            &held,
            |_| 0,
            // The 900 MB one is a video.
            |hash| hash.starts_with(&hex::encode([4_u8; 1])),
        );
        assert_eq!(wants.len(), 4);

        let manual = plan(
            wants.clone(),
            Budget {
                originals: OriginalsRule::Manual,
                ..Budget::foreground()
            },
        );
        assert_eq!(manual.items.len(), 2, "only the thumbnails crossed");
        assert!(manual.items.iter().all(|want| want.tier == Tier::Thumbnail));
        assert_eq!(manual.withheld, 2, "both originals are still owed");

        // And the download arrow overrides it for one item, which is what the
        // affordance means.
        let tapped = wants[2].hash;
        let one = plan(
            wants.clone(),
            Budget {
                originals: OriginalsRule::Manual,
                only: Some(tapped),
                ..Budget::foreground()
            },
        );
        assert_eq!(one.items.len(), 1);
        assert_eq!(one.items[0].hash, tapped);
    }

    /// A blob the vault admitted and has not sealed yet is left out: there is
    /// nowhere to fetch it from, so a want for it is one no window can satisfy.
    #[test]
    fn a_blob_with_no_placement_is_not_a_want() {
        use centraid_vault::backup::custody::BlobRole;

        let rows = [
            custody_row(5, BlobRole::Thumbnail, 100, false),
            custody_row(6, BlobRole::Thumbnail, 100, true),
        ];
        let wants = wants_from_custody(&rows, &std::collections::HashMap::new(), |_| 0, |_| false);
        assert_eq!(wants.len(), 1);
        assert_eq!(
            wants[0].hash,
            ContentHash::parse_hex(&hex::encode([6_u8; 32])).unwrap()
        );
    }

    /// The tier order still holds over custody rows: every thumbnail before any
    /// original, which is what fills a restored grid first.
    #[test]
    fn thumbnails_from_custody_are_planned_before_any_original() {
        use centraid_vault::backup::custody::BlobRole;

        let rows = [
            custody_row(7, BlobRole::Original, 4_000_000, true),
            custody_row(8, BlobRole::Thumbnail, 2048, true),
        ];
        let wants = wants_from_custody(&rows, &std::collections::HashMap::new(), |_| 0, |_| false);
        let ordered = plan(wants, Budget::foreground());
        assert_eq!(ordered.items[0].tier, Tier::Thumbnail);
        assert_eq!(ordered.items[1].tier, Tier::Original);
    }
}
