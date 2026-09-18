//! Deletes are delayed, and retention is judged by the server's clock
//! (#1029 §3, F4, F10).
//!
//! # The base is the unit of retention (F10)
//!
//! A generation is an **open-ended append stream, not a point in time**, so
//! "keep one per day" was undefined over generations and repacking could purge
//! segments inside a retained one. The floor is therefore defined over **bases**:
//!
//! - one base per day for 7 days;
//! - one per week for 4 weeks;
//! - one per month for 6 months.
//!
//! A segment or pack is retained while it is newer than the oldest retained
//! base, plus the grace period. A daily base is cheap because unchanged 4 MiB
//! ranges reuse existing objects, and "restore as of a past date" becomes "pick
//! a base" — the only granularity a member can reason about.
//!
//! **These times are the gateway's own receipt times, which a client cannot
//! backdate.** A stolen phone cannot upload fake or empty bases to push real
//! ones out of retention.
//!
//! # The guard runs on what a blind store can see (F4)
//!
//! The shrink guard began as a comparison of *sealed row censuses*, which a
//! blind store cannot read — and putting the census in the clear would leak the
//! schema and the member's usage. So it moved to what is already visible:
//!
//! - **padded base size**: a base whose total padded size is under half its
//!   predecessor's cannot cause older bases to be tombstoned until the member
//!   confirms on the phone;
//! - **a server-side delete rate limit**: at most one client-directed base
//!   tombstone per vault per day. A stolen phone cannot outrun a rate limit.
//!
//! The row-census warning — "this backup is much smaller than yesterday's" —
//! lives on the phone, where the census is readable. It is not weaker there: it
//! is the only place it is possible at all.

use crate::ids::{Generation, ObjectKind, ObjectName};
use crate::time::{Duration, ServerTime};

/// One base as the gateway sees it: the `base`-kind objects one commit brought,
/// and their total padded size.
///
/// A base is several objects — 4 MiB page ranges — so the gateway groups them
/// by the commit that introduced them. `id` is that commit's manifest head,
/// which is already a unique name and needs no counter invented for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseRecord {
    pub id: ObjectName,
    pub generation: Generation,
    /// **The gateway's own receipt time.** Never a client-supplied timestamp,
    /// which is the whole of F10's defence.
    pub received_at: ServerTime,
    /// The sum of the padded sizes of this base's range objects. The only
    /// census a blind store can take.
    pub padded_size: u64,
    pub objects: Vec<ObjectName>,
    pub tombstoned: bool,
}

/// The floor, the grace period and the two guards. Defaults are open question
/// 19's; an operator may tighten them and the rules do not care which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// How long a tombstoned object is kept before it is purged. Until then a
    /// restored phone can undelete, or restore an older generation.
    pub grace: Duration,
    pub daily_for_days: i64,
    pub weekly_for_weeks: i64,
    pub monthly_for_months: i64,
    /// A new base under this percentage of its predecessor's padded size trips
    /// the guard. 50 is §3's number.
    pub shrink_percent: u64,
    /// The window in which at most one client-directed base tombstone is
    /// allowed.
    pub base_delete_window: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            grace: Duration::from_days(7),
            daily_for_days: 7,
            weekly_for_weeks: 4,
            monthly_for_months: 6,
            shrink_percent: 50,
            base_delete_window: Duration::from_days(1),
        }
    }
}

/// Why a tombstone was refused. Mirrors `DeleteRefusalReason` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteRefusal {
    /// The retention floor over bases holds it.
    RetentionFloor,
    /// A segment or pack newer than the oldest retained base is retained with
    /// it.
    CoveredByBase,
    /// The live history contains a base that came in under half the one before
    /// it, and the member has not confirmed on the phone.
    SizeGuard,
    /// One client-directed base tombstone per vault per day, and this is the
    /// second. Carries when the next one becomes available.
    RateLimited { retry_after: ServerTime },
    /// The server owner disabled device deletes entirely.
    AppendOnly,
    /// The plan lapsed: read-only, and nothing is deleted inside the stated
    /// retention period.
    PlanLapsed,
}

/// The bases the floor keeps, newest first.
///
/// Buckets are counted **backwards from `now`** rather than by calendar date,
/// because a gateway has no timezone: the member's, the phone's and the
/// server's all differ, and a rule that depended on which one would be a
/// different rule in Auckland. "One per day for 7 days" is therefore "one per
/// 24-hour bucket for the last 7 of them", which is the promise a member can
/// actually check — and it does not move when they fly somewhere.
#[must_use]
pub fn retained(bases: &[BaseRecord], now: ServerTime, policy: Policy) -> Vec<ObjectName> {
    let mut live: Vec<&BaseRecord> = bases.iter().filter(|base| !base.tombstoned).collect();
    // Newest first, and by name where two landed in the same millisecond, so
    // the answer does not depend on the store's iteration order.
    live.sort_by(|left, right| {
        right
            .received_at
            .cmp(&left.received_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut kept: Vec<ObjectName> = Vec::new();
    let take = |span: Duration, buckets: i64, live: &[&BaseRecord], kept: &mut Vec<ObjectName>| {
        let mut filled: Vec<i64> = Vec::new();
        for base in live {
            let age = now.millis().saturating_sub(base.received_at.millis());
            if age < 0 {
                // Received "in the future" by the server's own clock: a clock
                // that stepped backwards. It is newer than everything and is
                // kept by the newest bucket below.
                continue;
            }
            let bucket = age / span.millis().max(1);
            if bucket >= buckets || filled.contains(&bucket) {
                continue;
            }
            filled.push(bucket);
            if !kept.contains(&base.id) {
                kept.push(base.id);
            }
        }
    };

    take(
        Duration::from_days(1),
        policy.daily_for_days,
        &live,
        &mut kept,
    );
    take(
        Duration::from_days(7),
        policy.weekly_for_weeks,
        &live,
        &mut kept,
    );
    take(
        Duration::from_days(30),
        policy.monthly_for_months,
        &live,
        &mut kept,
    );

    // A base the server's clock puts in the future is kept: it is the newest
    // thing there is and dropping it would lose the most recent backup.
    for base in &live {
        if base.received_at > now && !kept.contains(&base.id) {
            kept.push(base.id);
        }
    }
    kept
}

/// The oldest moment still covered: the receipt time of the oldest retained
/// base, minus nothing. A segment or pack older than this is no longer needed
/// by anything the floor keeps.
#[must_use]
pub fn coverage_floor(bases: &[BaseRecord], now: ServerTime, policy: Policy) -> Option<ServerTime> {
    let kept = retained(bases, now, policy);
    bases
        .iter()
        .filter(|base| kept.contains(&base.id))
        .map(|base| base.received_at)
        .min()
}

/// **THE SIZE GUARD.** Does the live history contain a base that came in under
/// `shrink_percent` of the one before it?
///
/// While it does, older bases cannot be tombstoned by a client — the member
/// confirms on the phone, where the row census is readable. A vault with fewer
/// than two bases cannot trip it: there is nothing to compare against, and
/// refusing everything on a brand-new vault would make a first backup
/// undeletable.
///
/// # Why it is EVERY consecutive pair and not just the newest one
///
/// The obvious reading of §3 — "a base whose total padded size is under half
/// its *predecessor's*" — checks the newest pair only, and **that version does
/// not hold.** Writing the abuse run found it: a stolen phone uploads one tiny
/// base, which trips the guard, and then a *second* tiny base, at which point
/// the newest pair is tiny-against-tiny, the ratio is 1.0, and the guard goes
/// quiet with fifty empty generations sitting in the history. Every subsequent
/// delete then sails through.
///
/// So the guard is a property of the live history, not of its last two entries:
/// once a shrink has happened it stays tripped until the shrunken bases are
/// gone or the member confirms. The cost is that a *legitimate* large deletion —
/// a member who threw away sixty per cent of their photographs — needs that
/// confirmation before the old bases can be pruned, which is exactly what §3
/// asks for and is a prompt rather than a loss.
#[must_use]
pub fn size_guard_tripped(bases: &[BaseRecord], policy: Policy) -> bool {
    let mut live: Vec<&BaseRecord> = bases.iter().filter(|base| !base.tombstoned).collect();
    live.sort_by(|left, right| {
        left.received_at
            .cmp(&right.received_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    live.windows(2).any(|pair| {
        // `newer < older * percent / 100`, in u128 so a large vault cannot
        // overflow the multiplication into a guard that never trips.
        let threshold = u128::from(pair[0].padded_size) * u128::from(policy.shrink_percent) / 100;
        u128::from(pair[1].padded_size) < threshold
    })
}

/// What the gateway is being asked to tombstone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteCandidate {
    pub name: ObjectName,
    pub kind: ObjectKind,
    pub received_at: ServerTime,
    /// For a `base` range object: the base it belongs to.
    pub base: Option<ObjectName>,
}

/// Everything a delete decision needs that is not the candidate itself.
#[derive(Debug, Clone)]
pub struct DeleteContext<'a> {
    pub bases: &'a [BaseRecord],
    pub now: ServerTime,
    pub policy: Policy,
    pub append_only: bool,
    pub plan_read_only: bool,
    /// The moment of the most recent client-directed **base** tombstone in this
    /// vault, if there is one.
    pub last_client_base_delete: Option<ServerTime>,
    /// THE MEMBER SAW THE WARNING AND SAID YES.
    ///
    /// The size guard's release, and it is a client-supplied flag on purpose:
    /// the warning it answers — "this backup is much smaller than yesterday's"
    /// — is computed on the phone from the row census, which is the only place
    /// the census is readable (F4). The gateway cannot second-guess it and does
    /// not try; what it contributes is that the flag has to be *sent*, and a
    /// phone that never showed the member anything has no reason to send it.
    pub member_confirmed_shrink: bool,
}

/// One object's verdict, and the moment it becomes purgeable if it is allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Tombstoned. The bytes stay until `purge_after`.
    Tombstone {
        purge_after: ServerTime,
    },
    Refused(DeleteRefusal),
}

/// Judge one client-directed delete.
///
/// The order is deliberate: the two flags that disable deletes wholesale come
/// first, then the rate limit, then the floor and the guard. An operator
/// reading a refusal wants the broadest true reason, not the narrowest.
#[must_use]
pub fn judge(candidate: &DeleteCandidate, context: &DeleteContext<'_>) -> Verdict {
    if context.append_only {
        return Verdict::Refused(DeleteRefusal::AppendOnly);
    }
    if context.plan_read_only {
        return Verdict::Refused(DeleteRefusal::PlanLapsed);
    }

    let purge_after = context.now + context.policy.grace;

    if candidate.kind == ObjectKind::Base {
        if let Some(last) = context.last_client_base_delete {
            let next = last + context.policy.base_delete_window;
            if context.now < next {
                return Verdict::Refused(DeleteRefusal::RateLimited { retry_after: next });
            }
        }
        if size_guard_tripped(context.bases, context.policy) && !context.member_confirmed_shrink {
            return Verdict::Refused(DeleteRefusal::SizeGuard);
        }
        let kept = retained(context.bases, context.now, context.policy);
        let belongs_to = candidate.base.unwrap_or(candidate.name);
        if kept.contains(&belongs_to) {
            return Verdict::Refused(DeleteRefusal::RetentionFloor);
        }
        return Verdict::Tombstone { purge_after };
    }

    // A segment or pack is retained while it is newer than the oldest retained
    // base. Anything else — a manifest, a blob, a share entry — the phone owns.
    if matches!(candidate.kind, ObjectKind::Segment | ObjectKind::Pack)
        && let Some(floor) = coverage_floor(context.bases, context.now, context.policy)
        && candidate.received_at >= floor
    {
        return Verdict::Refused(DeleteRefusal::CoveredByBase);
    }

    Verdict::Tombstone { purge_after }
}

/// Is this tombstoned object past its grace period?
#[must_use]
pub const fn purgeable(purge_after: ServerTime, now: ServerTime) -> bool {
    now.millis() >= purge_after.millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Key32;

    const DAY: i64 = 86_400_000;

    fn generation() -> Generation {
        Generation::parse("0123456789abcdef0123456789abcdef").expect("hex")
    }

    fn base(tag: u8, days_ago: i64, padded_size: u64) -> BaseRecord {
        BaseRecord {
            id: Key32::from_bytes([tag; 32]),
            generation: generation(),
            received_at: ServerTime::from_millis(200 * DAY - days_ago * DAY),
            padded_size,
            objects: vec![Key32::from_bytes([tag; 32])],
            tombstoned: false,
        }
    }

    fn now() -> ServerTime {
        ServerTime::from_millis(200 * DAY)
    }

    fn context<'a>(bases: &'a [BaseRecord]) -> DeleteContext<'a> {
        DeleteContext {
            bases,
            now: now(),
            policy: Policy::default(),
            append_only: false,
            plan_read_only: false,
            last_client_base_delete: None,
            member_confirmed_shrink: false,
        }
    }

    #[test]
    fn the_floor_keeps_one_base_per_day_week_and_month() {
        // One base a day for 200 days.
        let bases: Vec<BaseRecord> = (0..200)
            .map(|day| base(u8::try_from(day % 250).expect("fits"), day, 1_000_000))
            .collect();
        let kept = retained(&bases, now(), Policy::default());
        // 7 daily + 4 weekly + 6 monthly, minus the overlaps where one base
        // satisfies two buckets. The floor is a UNION, so the count is what
        // matters and not which rule claimed each.
        assert!(
            kept.len() >= 7 && kept.len() <= 17,
            "kept {} bases, which is neither the daily floor nor the whole history",
            kept.len()
        );
        assert!(kept.contains(&bases[0].id), "today's base is kept");
        assert!(
            !kept.contains(&bases[199].id),
            "a base 200 days old is past the six-month floor"
        );
    }

    /// F10's whole point, and the reason the times are the server's.
    #[test]
    fn a_retention_abuse_run_cannot_push_a_real_base_out_of_the_floor() {
        let real = base(1, 0, 4 * 1024 * 1024 * 20);
        let mut bases = vec![real.clone()];
        // 50 backdated empty generations. The client claims they are old; the
        // gateway files them at ITS OWN receipt time, which is now.
        for tag in 0..50_u8 {
            bases.push(BaseRecord {
                id: Key32::from_bytes([100 + tag; 32]),
                generation: generation(),
                // What the client SAID is irrelevant — this is the receipt time
                // and it is the only time the rules read.
                received_at: now(),
                padded_size: 4096,
                objects: Vec::new(),
                tombstoned: false,
            });
        }
        let kept = retained(&bases, now(), Policy::default());
        assert!(
            kept.contains(&real.id) || bases.iter().any(|candidate| kept.contains(&candidate.id)),
            "the floor keeps something from the newest bucket"
        );

        // And the real base cannot be tombstoned: the empty ones tripped the
        // size guard, which is the guard a blind store CAN run.
        assert!(size_guard_tripped(&bases, Policy::default()));
        let verdict = judge(
            &DeleteCandidate {
                name: real.id,
                kind: ObjectKind::Base,
                received_at: real.received_at,
                base: Some(real.id),
            },
            &context(&bases),
        );
        assert_eq!(verdict, Verdict::Refused(DeleteRefusal::SizeGuard));
    }

    #[test]
    fn the_size_guard_needs_two_bases_and_trips_at_half() {
        assert!(!size_guard_tripped(&[], Policy::default()));
        assert!(!size_guard_tripped(&[base(1, 0, 10)], Policy::default()));
        assert!(size_guard_tripped(
            &[base(1, 1, 1_000), base(2, 0, 499)],
            Policy::default()
        ));
        assert!(!size_guard_tripped(
            &[base(1, 1, 1_000), base(2, 0, 500)],
            Policy::default()
        ));
    }

    /// THE DEFECT THE ABUSE RUN FOUND, kept as its own red-first case.
    ///
    /// A guard that only compares the newest pair goes quiet as soon as a
    /// SECOND small base lands: tiny-against-tiny is a ratio of 1.0. The
    /// history that produced the shrink is still sitting there, and every
    /// delete after it would sail through.
    #[test]
    fn a_second_tiny_base_does_not_wash_the_guard_out() {
        let washed = [
            base(1, 3, 1_000_000),
            base(2, 2, 4_096),
            base(3, 1, 4_096),
            base(4, 0, 4_096),
        ];
        assert!(
            size_guard_tripped(&washed, Policy::default()),
            "a shrink stays visible while the shrunken bases are live"
        );
    }

    /// And the member's confirmation is what lifts it — not time, and not
    /// another upload.
    #[test]
    fn the_members_confirmation_is_what_releases_the_size_guard() {
        let bases = vec![base(1, 300, 1_000_000), base(2, 0, 4_096)];
        let candidate = DeleteCandidate {
            name: bases[0].id,
            kind: ObjectKind::Base,
            received_at: bases[0].received_at,
            base: Some(bases[0].id),
        };
        assert_eq!(
            judge(&candidate, &context(&bases)),
            Verdict::Refused(DeleteRefusal::SizeGuard)
        );
        let mut confirmed = context(&bases);
        confirmed.member_confirmed_shrink = true;
        assert!(matches!(
            judge(&candidate, &confirmed),
            Verdict::Tombstone { .. }
        ));
    }

    /// AT MOST ONE CLIENT-DIRECTED BASE TOMBSTONE PER VAULT PER DAY (F4).
    #[test]
    fn a_second_base_tombstone_inside_a_day_is_rate_limited() {
        let bases = vec![base(1, 100, 1_000), base(2, 0, 1_000)];
        let mut context = context(&bases);
        context.last_client_base_delete = Some(ServerTime::from_millis(now().millis() - 3_600_000));
        let verdict = judge(
            &DeleteCandidate {
                name: bases[0].id,
                kind: ObjectKind::Base,
                received_at: bases[0].received_at,
                base: Some(bases[0].id),
            },
            &context,
        );
        let Verdict::Refused(DeleteRefusal::RateLimited { retry_after }) = verdict else {
            panic!("rate limited, not {verdict:?}");
        };
        assert_eq!(retry_after.millis(), now().millis() - 3_600_000 + DAY);

        // A day later the same request is allowed by the rate limit, and then
        // judged on its merits.
        context.last_client_base_delete = Some(ServerTime::from_millis(now().millis() - DAY - 1));
        assert!(!matches!(
            judge(
                &DeleteCandidate {
                    name: bases[0].id,
                    kind: ObjectKind::Base,
                    received_at: bases[0].received_at,
                    base: Some(bases[0].id),
                },
                &context,
            ),
            Verdict::Refused(DeleteRefusal::RateLimited { .. })
        ));
    }

    #[test]
    fn a_base_inside_the_floor_is_refused_and_one_outside_it_is_tombstoned() {
        // Two bases far enough apart that the size guard sleeps.
        let bases = vec![base(1, 300, 1_000), base(2, 0, 1_000)];
        let old = judge(
            &DeleteCandidate {
                name: bases[0].id,
                kind: ObjectKind::Base,
                received_at: bases[0].received_at,
                base: Some(bases[0].id),
            },
            &context(&bases),
        );
        assert_eq!(
            old,
            Verdict::Tombstone {
                purge_after: now() + Policy::default().grace
            },
            "300 days old is past the six-month floor"
        );

        let fresh = judge(
            &DeleteCandidate {
                name: bases[1].id,
                kind: ObjectKind::Base,
                received_at: bases[1].received_at,
                base: Some(bases[1].id),
            },
            &context(&bases),
        );
        assert_eq!(fresh, Verdict::Refused(DeleteRefusal::RetentionFloor));
    }

    #[test]
    fn a_segment_newer_than_the_oldest_retained_base_is_retained_with_it() {
        let bases = vec![base(1, 3, 1_000), base(2, 0, 1_000)];
        let covered = judge(
            &DeleteCandidate {
                name: Key32::from_bytes([50; 32]),
                kind: ObjectKind::Segment,
                received_at: ServerTime::from_millis(now().millis() - DAY),
                base: None,
            },
            &context(&bases),
        );
        assert_eq!(covered, Verdict::Refused(DeleteRefusal::CoveredByBase));

        let older = judge(
            &DeleteCandidate {
                name: Key32::from_bytes([51; 32]),
                kind: ObjectKind::Segment,
                received_at: ServerTime::from_millis(now().millis() - 10 * DAY),
                base: None,
            },
            &context(&bases),
        );
        assert!(matches!(older, Verdict::Tombstone { .. }));
    }

    #[test]
    fn the_append_only_flag_disables_device_deletes_entirely() {
        let bases = vec![base(1, 300, 1_000), base(2, 0, 1_000)];
        let mut context = context(&bases);
        context.append_only = true;
        assert_eq!(
            judge(
                &DeleteCandidate {
                    name: Key32::from_bytes([50; 32]),
                    kind: ObjectKind::Blob,
                    received_at: now(),
                    base: None,
                },
                &context,
            ),
            Verdict::Refused(DeleteRefusal::AppendOnly)
        );
    }

    /// A LAPSED PLAN IS READ-ONLY AND NOTHING IS DELETED INSIDE THE STATED
    /// PERIOD (F13). A member who let a subscription lapse must find their
    /// backup where they left it.
    #[test]
    fn a_lapsed_plan_deletes_nothing() {
        let bases = vec![base(1, 300, 1_000), base(2, 0, 1_000)];
        let mut context = context(&bases);
        context.plan_read_only = true;
        assert_eq!(
            judge(
                &DeleteCandidate {
                    name: bases[0].id,
                    kind: ObjectKind::Base,
                    received_at: bases[0].received_at,
                    base: Some(bases[0].id),
                },
                &context,
            ),
            Verdict::Refused(DeleteRefusal::PlanLapsed)
        );
    }

    #[test]
    fn a_tombstone_is_purgeable_only_after_the_grace_period() {
        let purge_after = now() + Duration::from_days(7);
        assert!(!purgeable(purge_after, now()));
        assert!(!purgeable(purge_after, now() + Duration::from_days(6)));
        assert!(purgeable(purge_after, now() + Duration::from_days(7)));
    }
}
