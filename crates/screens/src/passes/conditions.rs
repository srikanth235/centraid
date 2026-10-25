//! WHY A PASS RUNS, AND UNDER WHAT CONDITIONS (#1080; `DrainRequest`).
//!
//! Every trigger names a [`Reason`], so a pass is never anonymous and
//! `wants_snapshot` and `asked` are decided by the reason rather than by each
//! caller. [`Conditions::request`] is **the one place an unknown platform
//! reading becomes the expensive answer**.

use centraid_api_proto::core_v1 as wire;

use super::rule::Rules;

/// Why a pass runs.
///
/// | Trigger | Reason | Deadline | Snapshot | Asked |
/// |---|---|---|---|---|
/// | the session opened | `SessionOpened` | none | when due | no |
/// | the app became active | `BecameActive` | none | when due | no |
/// | a commit landed (debounced) | `AfterCommit` | none | when due | no |
/// | a camera-roll pass imported | `AfterImport` | none | when due | no |
/// | the link came back (debounced) | `Connectivity` | none | when due | no |
/// | a background window | `Scheduled` | the window's | when due | no |
/// | "Back up now" | `BackUpNow` | none | now | yes |
/// | the app left the screen | `EnteredBackground` | the grace | now | no |
/// | a restore finished | `Restored` | none | now | no |
///
/// A snapshot is forced only where the member or the platform is about to stop
/// looking. **Only "Back up now" is the member asking** (`DrainRequest.asked`,
/// #1080 A24): it alone lets an original be sealed under MANUAL and a video's
/// original be sealed off the charger. Leaving the screen and a finished
/// restore time a snapshot and decide nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Reason {
    SessionOpened,
    BecameActive,
    AfterCommit,
    AfterImport,
    Connectivity,
    Scheduled,
    BackUpNow,
    EnteredBackground,
    Restored,
}

impl Reason {
    pub const ALL: [Self; 9] = [
        Self::SessionOpened,
        Self::BecameActive,
        Self::AfterCommit,
        Self::AfterImport,
        Self::Connectivity,
        Self::Scheduled,
        Self::BackUpNow,
        Self::EnteredBackground,
        Self::Restored,
    ];

    /// Take a snapshot now, whether or not one is due. A pass owed a snapshot
    /// waits for the one running instead of being refused.
    #[must_use]
    pub fn wants_snapshot(self) -> bool {
        matches!(
            self,
            Self::BackUpNow | Self::EnteredBackground | Self::Restored
        )
    }

    /// The member tapped "Back up now" for this pass.
    #[must_use]
    pub fn asked(self) -> bool {
        self == Self::BackUpNow
    }

    /// The camera roll is walked to its end before the pass, so what the walk
    /// brings in is in it (R-1029-PH-4). Nothing else walks: an import's own
    /// pass would walk itself in a loop, and a window or the grace has no time
    /// for a camera roll.
    #[must_use]
    pub fn walks_first(self) -> bool {
        matches!(
            self,
            Self::SessionOpened | Self::BecameActive | Self::BackUpNow
        )
    }
}

/// What the platform last said about the radio and the charger. `None` is "the
/// platform would not say".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Link {
    pub online: bool,
    pub metered: Option<bool>,
    pub charging: Option<bool>,
}

impl Link {
    /// Before the shell has reported anything: nobody vouched for the link.
    pub const UNKNOWN: Self = Self {
        online: false,
        metered: None,
        charging: None,
    };

    #[must_use]
    pub fn of(fact: &wire::LinkChanged) -> Self {
        Self {
            online: fact.online,
            metered: fact.metered_known.then_some(fact.metered),
            charging: fact.charging_known.then_some(fact.charging),
        }
    }
}

/// The member's rule and the platform's reading, read before EVERY pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Conditions {
    pub rules: Rules,
    pub link: Link,
}

impl Conditions {
    /// The request this pass carries. **Null becomes the expensive answer**:
    /// metered, and not charging (`phone.proto`'s own defaults for an unknown
    /// link). A guess wrong towards cheap spends a member's data plan; a guess
    /// wrong towards expensive delays a photograph.
    #[must_use]
    pub fn request(&self, deadline_ms: u64, reason: Reason) -> wire::DrainRequest {
        wire::DrainRequest {
            deadline_ms,
            rule: self.rules.rule.wire() as i32,
            metered: self.link.metered.unwrap_or(true),
            charging: self.link.charging.unwrap_or(false),
            wants_snapshot: reason.wants_snapshot(),
            // THE WIRE CARRIES THE NEGATION (A3), so proto3's zero value is the
            // complete backup.
            exclude_videos: !self.rules.include_videos,
            // THE MEMBER'S TAP AND NOTHING ELSE (#1080 A24).
            asked: reason.asked(),
        }
    }
}
