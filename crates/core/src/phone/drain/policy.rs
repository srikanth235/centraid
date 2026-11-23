//! Pure transfer rules, gateway reach/refusal classification, and snapshot timing.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::backup::files::ContentFile;
use centraid_vault::backup::mover::Stop;
use centraid_vault::backup::state::{DeviceState, Outbox, OutboxKind, Reach};
use centraid_vault::backup::store::Refusal;

use super::{SNAPSHOT_EVERY_MS, SNAPSHOT_SETTLE_MS};
use crate::error::{CoreError, Result};
use crate::phone::{Plane, now_ms, plane_error};

// ─── the rule ───────────────────────────────────────────────────────────────

/// What a file or a part is, for the member's rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The vault's own snapshot: a range or a manifest.
    Records,
    /// A thumbnail, a preview or a poster.
    Derivative,
    /// The bytes a member took, made or received.
    Original { video: bool },
}

impl Kind {
    /// The kind of an owed part.
    #[must_use]
    pub fn of_part(part: &Outbox) -> Self {
        match part.kind {
            OutboxKind::Range | OutboxKind::Leaf | OutboxKind::Manifest | OutboxKind::Directory => {
                Self::Records
            }
            OutboxKind::Blob if part.derivative => Self::Derivative,
            OutboxKind::Blob => Self::Original {
                video: part.is_video(),
            },
        }
    }

    /// The kind of a file the vault knows.
    #[must_use]
    pub const fn of_file(file: &ContentFile) -> Self {
        if file.variant.is_some() {
            Self::Derivative
        } else {
            Self::Original { video: file.video }
        }
    }
}

/// **Whether the operating system may move a part of this kind over a
/// metered link** (`HandoffPart.allows_cellular`, A10). See the module
/// header's table.
#[must_use]
pub fn allows_cellular(kind: Kind, rule: wire::TransferRule) -> bool {
    match kind {
        Kind::Derivative => true,
        Kind::Original { video: true } => false,
        Kind::Original { video: false } | Kind::Records => {
            rule == wire::TransferRule::WifiAndCellularPhotos
        }
    }
}

/// The member's rule and the link, as a pass was told them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conditions {
    pub rule: wire::TransferRule,
    pub metered: bool,
    pub charging: bool,
    pub exclude_videos: bool,
    /// The member tapped "Back up now" in this pass (`DrainRequest.asked`,
    /// the root's ruling A24): under `MANUAL` it lets originals be sealed, it
    /// lets a video's original be sealed off the charger, and on a metered
    /// link it lets the snapshot cross under any rule (R-1080-C38).
    pub asked: bool,
    /// The shell asked for a snapshot now (`wants_snapshot`): "Back up now",
    /// or the app leaving the screen. It decides the snapshot's timing and
    /// nothing else.
    pub snapshot: bool,
}

impl Conditions {
    /// What a drain request says. **The rule is the member's and the shell sends it with every
    /// request** (#1191): a request that names none is refused, and no rule is assumed.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] for a request with no transfer rule.
    pub fn of(request: &wire::DrainRequest) -> Result<Self> {
        let rule = match wire::TransferRule::try_from(request.rule) {
            Ok(wire::TransferRule::Unspecified) | Err(_) => {
                return Err(CoreError::InvalidRequest {
                    detail: "a drain request names the member's transfer rule; none is assumed"
                        .to_owned(),
                });
            }
            Ok(rule) => rule,
        };
        Ok(Self {
            rule,
            metered: request.metered,
            charging: request.charging,
            exclude_videos: request.exclude_videos,
            asked: request.asked,
            snapshot: request.wants_snapshot,
        })
    }

    /// What the last pass was told, or the expensive reading when no pass has run in this
    /// core's life: `WIFI_ONLY`, metered, not charging, videos included. Only the status and the
    /// doors that carry no request of their own read this.
    #[must_use]
    pub fn remembered(plane: &Plane) -> Self {
        plane.remembered().unwrap_or(Self {
            rule: wire::TransferRule::WifiOnly,
            metered: true,
            charging: false,
            exclude_videos: false,
            asked: false,
            snapshot: false,
        })
    }

    /// Whether the member backs this kind up at all: a video's original is
    /// left out when the member left videos out.
    #[must_use]
    pub const fn counts(&self, kind: Kind) -> bool {
        !(matches!(kind, Kind::Original { video: true }) && self.exclude_videos)
    }

    /// Whether a part of this kind may cross the link this pass is on. The
    /// member's tap sends the records over a metered link under any rule
    /// (R-1080-C38): a snapshot is a few MB, and the tap is consent.
    #[must_use]
    pub fn may_move(&self, kind: Kind) -> bool {
        self.counts(kind)
            && (!self.metered
                || allows_cellular(kind, self.rule)
                || (self.asked && kind == Kind::Records))
    }

    /// Whether a file of this kind may be sealed into the spool now.
    #[must_use]
    pub fn may_prepare(&self, kind: Kind) -> bool {
        match kind {
            Kind::Records | Kind::Derivative => true,
            Kind::Original { video } => {
                self.counts(kind)
                    && (self.rule != wire::TransferRule::Manual || self.asked)
                    && (!video || self.charging || self.asked)
            }
        }
    }

    /// Why a file not yet backed up waits: `spooled` when its parts are
    /// sealed and queued, `library` when its bytes are the shell's to stream.
    #[must_use]
    pub fn waits_for(&self, kind: Kind, spooled: bool, library: bool) -> wire::WaitReason {
        if spooled {
            return if self.may_move(kind) {
                wire::WaitReason::Window
            } else {
                wire::WaitReason::Wifi
            };
        }
        if !self.may_prepare(kind) {
            // `MANUAL` first: the tap lets a video through off the charger
            // too, so it is the one act that moves either.
            return if matches!(kind, Kind::Original { .. })
                && self.rule == wire::TransferRule::Manual
                && !self.asked
            {
                wire::WaitReason::Ask
            } else if matches!(kind, Kind::Original { video: true }) && !self.charging {
                wire::WaitReason::Charger
            } else {
                wire::WaitReason::Window
            };
        }
        if library {
            wire::WaitReason::Bytes
        } else {
            wire::WaitReason::Window
        }
    }
}

/// What the last pass found across the paired gateways, as the reason everything waits: the
/// worst of them in the order a member can act on it. `None` when every one answered, or when
/// no pass has run yet; `GATEWAY` when one stopped answering; `UNTRUSTED` when the machine that
/// answered is not the pinned gateway; `REFUSED` when one answered and refused a write for its
/// own reason (a full disk, a part over its limit, or a code this build does not know);
/// `PAIR_AGAIN` when it no longer knows this phone's token.
///
/// # Errors
/// The device state's refusal.
pub fn last_reach(state: &DeviceState) -> Result<Option<wire::WaitReason>> {
    let rank = |reach: Reach| match reach {
        Reach::PairAgain => 4,
        Reach::RefusedDisk | Reach::RefusedLarge | Reach::RefusedOther => 3,
        Reach::Untrusted => 2,
        Reach::Unreachable | Reach::GatewayOld => 1,
        _ => 0,
    };
    let mut worst: Option<Reach> = None;
    for gateway in state.gateways().map_err(plane_error)? {
        if rank(gateway.reach) > worst.map_or(0, rank) {
            worst = Some(gateway.reach);
        }
    }
    Ok(worst.and_then(wait_of))
}

/// The reason a reach names, when it names one.
const fn wait_of(reach: Reach) -> Option<wire::WaitReason> {
    match reach {
        Reach::Unreachable | Reach::GatewayOld | Reach::Busy => Some(wire::WaitReason::Gateway),
        Reach::Untrusted => Some(wire::WaitReason::Untrusted),
        Reach::RefusedDisk => Some(wire::WaitReason::Refused),
        Reach::RefusedLarge => Some(wire::WaitReason::TooLarge),
        Reach::RefusedOther => Some(wire::WaitReason::RefusedOther),
        Reach::PairAgain => Some(wire::WaitReason::PairAgain),
        Reach::Frozen => Some(wire::WaitReason::RefusedOther),
        Reach::Ok | Reach::Moved => None,
    }
}

/// What the gateway said when it refused, as the device state keeps it.
pub(super) const fn heard_of(refusal: &Refusal) -> Reach {
    match refusal {
        Refusal::DiskFull => Reach::RefusedDisk,
        Refusal::TooLarge => Reach::RefusedLarge,
        Refusal::Frozen => Reach::Frozen,
        Refusal::Busy => Reach::Busy,
        _ => Reach::RefusedOther,
    }
}

/// The largest object the protocol allows, which is what a `TOO_LARGE` refusal crossed: the
/// limit the Backup screen names.
#[must_use]
pub const fn refused_limit_bytes() -> u64 {
    centraid_gateway::rules::limits::MAX_OBJECT_BYTES
}
/// What a refusal the gateway sent outside a part's own `PUT` is to a pass,
/// told by its code — [`super::store_error`] spells a refusal as
/// [`CoreError::GatewayRefused`] with the code as its reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refused {
    /// `UNAUTHORIZED`: the gateway does not know this phone's token.
    Token,
    /// Any other refusal is that gateway's own answer: the reach the device state keeps for it
    /// (`DISK_FULL`, `TOO_LARGE`, or one this build does not know). It stops that gateway's
    /// pass and no other's.
    Limit(Reach),
}

/// The class a refusal's code belongs to, unified with [`heard_of`].
pub(super) fn refused_by(reason: &str) -> Refused {
    match Refusal::from_code(reason) {
        Refusal::Unauthorized => Refused::Token,
        other => Refused::Limit(heard_of(&other)),
    }
}

/// Why one paired gateway is behind, as its last answer says: `None` when it answered (or
/// has not been asked yet).
///
/// # Errors
/// The device state's refusal.
pub fn gateway_reach(state: &DeviceState, gateway_id: &str) -> Result<Option<wire::WaitReason>> {
    Ok(state
        .gateway(gateway_id)
        .map_err(plane_error)?
        .and_then(|gateway| wait_of(gateway.reach)))
}

/// A mover's stop as the pass answers it; `MOVED` is a refusal, never a stop.
pub(super) fn stop_of(stop: &Stop) -> Result<Option<wire::DrainStop>> {
    match stop {
        Stop::Empty => Ok(None),
        Stop::Deadline => Ok(Some(wire::DrainStop::Deadline)),
        Stop::Unreachable(reason) => {
            tracing::debug!(%reason, "the gateway stopped answering mid-pass");
            Ok(Some(wire::DrainStop::Unreachable))
        }
        Stop::Untrusted(reason) => {
            tracing::warn!(%reason, "the machine that answered is not the pinned gateway");
            Ok(Some(wire::DrainStop::Untrusted))
        }
        // A TOKEN THE GATEWAY NO LONGER KNOWS is the pass's error, as it was
        // before any part moved (`pass_over`'s first question): the gateway is
        // marked for pairing again. Every other refusal is the
        // gateway's own answer — a full disk, a part over its limit — and is its own stop,
        // not an absence (#1080, the sweep's F1): the status says so.
        Stop::Refused(Refusal::Unauthorized) => Err(CoreError::GatewayRefused {
            reason: Refusal::Unauthorized.code().to_owned(),
        }),
        Stop::Refused(refusal) => {
            tracing::warn!(code = %refusal.code(), "the gateway refused a part; the pass stops");
            Ok(Some(wire::DrainStop::Refused))
        }
        Stop::Moved { epoch } => Err(CoreError::VaultMoved {
            current_epoch: *epoch,
            moved_at_ms: 0,
        }),
    }
}

/// How far ahead of this phone's clock a snapshot's date may read before it is not believed.
const CLOCK_TOLERANCE_MS: u64 = 5 * 60 * 1000;

/// Whether `taken_at_ms` is within the snapshot interval of `now`. **A date in the future
/// is not recent** (#1188, B11): a clock set ahead and corrected dated a snapshot after now,
/// and trusting it would have held the next snapshot off until the real date caught up.
fn recent(now: u64, taken_at_ms: u64) -> bool {
    taken_at_ms <= now.saturating_add(CLOCK_TOLERANCE_MS)
        && now.saturating_sub(taken_at_ms) < SNAPSHOT_EVERY_MS
}

/// Whether `taken_at_ms` is still inside the settle window. A date in the future is not.
fn settling(now: u64, taken_at_ms: u64) -> bool {
    taken_at_ms <= now.saturating_add(CLOCK_TOLERANCE_MS)
        && now.saturating_sub(taken_at_ms) < SNAPSHOT_SETTLE_MS
}

/// Whether a snapshot is due at `gateway_id`. One the shell asked for (`wanted`, kept in the
/// plane until taken) or a gateway whose head went backwards (`rolled`) always is; otherwise
/// one is due once the settle window has passed since the newest the gateway's head names, and not while a younger
/// one is still on its way to it (its manifest is in the outbox); and one is due at once at a
/// gateway this phone has set no head at.
pub(super) fn snapshot_due(
    state: &DeviceState,
    gateway_id: &str,
    wanted: bool,
    rolled: bool,
) -> Result<bool> {
    if wanted || rolled {
        return Ok(true);
    }
    let now = now_ms();
    let Some(gateway) = state.gateway(gateway_id).map_err(plane_error)? else {
        return Ok(false);
    };
    if let Some(taken) = gateway.snapshot_ms
        && gateway.head != gateway.snapshot
        && recent(now, taken)
    {
        // A YOUNGER SNAPSHOT IS ON ITS WAY: its parts are still owed here.
        let in_flight = state
            .outbox(gateway_id)
            .map_err(plane_error)?
            .iter()
            .any(|row| row.kind == OutboxKind::Manifest);
        if in_flight {
            return Ok(false);
        }
    }
    // A GATEWAY THIS PHONE HAS SET NO HEAD AT — paired just now, or paired
    // again after it lost the vault — is owed the records on this pass, not
    // an hour after a head that another gateway, or another life of this one,
    // acknowledged.
    if gateway.head.is_none() {
        return Ok(true);
    }
    // THE SETTLE RUNS FROM THE SNAPSHOT THIS GATEWAY'S OWN HEAD NAMES: another gateway being
    // current does not make this one so (#1188, B1). A vault nothing changed is skipped before
    // this is asked (`newest_stands`), so the window costs a copy only after an edit.
    Ok(gateway.head_ms.is_none_or(|at| !settling(now, at)))
}

#[cfg(test)]
mod tests {
    /// **A REFUSAL IS CLASSED BY ITS CODE, AND AN UNKNOWN ONE STOPS ONE GATEWAY** (#1188, item
    /// 21): the code a gateway never emits (`QUOTA`) is just an unknown code, not a room.
    #[test]
    fn a_refusal_is_classed_by_its_code_and_an_unknown_one_is_its_own_kind() {
        assert_eq!(refused_by("UNAUTHORIZED"), Refused::Token);
        assert_eq!(refused_by("DISK_FULL"), Refused::Limit(Reach::RefusedDisk));
        assert_eq!(refused_by("TOO_LARGE"), Refused::Limit(Reach::RefusedLarge));
        assert_eq!(refused_by("FROZEN"), Refused::Limit(Reach::Frozen));
        assert_eq!(refused_by("BUSY"), Refused::Limit(Reach::Busy));
        assert_eq!(refused_by("QUOTA"), Refused::Limit(Reach::RefusedOther));
        assert_eq!(
            refused_by("SOMETHING_NEW"),
            Refused::Limit(Reach::RefusedOther)
        );
        assert_eq!(heard_of(&Refusal::DiskFull), Reach::RefusedDisk);
        assert_eq!(heard_of(&Refusal::TooLarge), Reach::RefusedLarge);
        // A GATEWAY THAT KEEPS RETURNING A DAMAGED COPY stops its own pass with this refusal: it is
        // "refusing", never "no room left".
        assert_eq!(heard_of(&Refusal::DigestMismatch), Reach::RefusedOther);
        assert_eq!(
            heard_of(&Refusal::Other("X".to_owned())),
            Reach::RefusedOther
        );
    }

    use super::*;

    const RULES: [wire::TransferRule; 3] = [
        wire::TransferRule::WifiOnly,
        wire::TransferRule::WifiAndCellularPhotos,
        wire::TransferRule::Manual,
    ];

    /// **A10, ROW BY ROW.** Thumbnails and previews always; a video's
    /// original never; a photograph's original under the cellular rule; the
    /// records exactly when photographs may cross cellular.
    #[test]
    fn allows_cellular_follows_the_rule_row_by_row() {
        for rule in RULES {
            let cellular = rule == wire::TransferRule::WifiAndCellularPhotos;
            assert!(allows_cellular(Kind::Derivative, rule), "{rule:?}");
            assert!(
                !allows_cellular(Kind::Original { video: true }, rule),
                "{rule:?}"
            );
            assert_eq!(
                allows_cellular(Kind::Original { video: false }, rule),
                cellular,
                "{rule:?}"
            );
            assert_eq!(allows_cellular(Kind::Records, rule), cellular, "{rule:?}");
        }
    }

    fn conditions(rule: wire::TransferRule, metered: bool) -> Conditions {
        Conditions {
            rule,
            metered,
            charging: false,
            exclude_videos: false,
            asked: false,
            snapshot: false,
        }
    }

    /// On an unmetered link everything the member backs up moves; on a
    /// metered one only what `allows_cellular` admits, and a left-out video
    /// moves on neither.
    #[test]
    fn a_metered_link_moves_only_what_the_rule_admits() {
        for rule in RULES {
            let free = conditions(rule, false);
            let paid = conditions(rule, true);
            for kind in [
                Kind::Records,
                Kind::Derivative,
                Kind::Original { video: false },
                Kind::Original { video: true },
            ] {
                assert!(free.may_move(kind), "{rule:?} {kind:?}");
                assert_eq!(
                    paid.may_move(kind),
                    allows_cellular(kind, rule),
                    "{rule:?} {kind:?}"
                );
            }
            let without_videos = Conditions {
                exclude_videos: true,
                ..free
            };
            assert!(!without_videos.may_move(Kind::Original { video: true }));
            assert!(without_videos.may_move(Kind::Original { video: false }));
        }
    }

    /// **A TAP SENDS THE RECORDS OVER A METERED LINK, UNDER ANY RULE**
    /// (R-1080-C38, superseding C14): the snapshot is a few MB and the tap is
    /// consent. Originals still follow the rule, and without the tap the
    /// records do too.
    #[test]
    fn a_tap_sends_the_records_over_a_metered_link_under_any_rule() {
        for rule in RULES {
            let paid = conditions(rule, true);
            let tapped = Conditions {
                asked: true,
                ..paid
            };
            assert!(tapped.may_move(Kind::Records), "{rule:?}");
            assert_eq!(
                paid.may_move(Kind::Records),
                allows_cellular(Kind::Records, rule),
                "{rule:?}: no tap, the rule alone"
            );
            for original in [
                Kind::Original { video: false },
                Kind::Original { video: true },
            ] {
                assert_eq!(
                    tapped.may_move(original),
                    allows_cellular(original, rule),
                    "{rule:?} {original:?}: an original follows the rule"
                );
            }
        }
    }

    /// A video's original waits for a charger unless the member asked, and
    /// under `MANUAL` no original is sealed unless the member asked.
    #[test]
    fn a_video_waits_for_a_charger_and_manual_waits_for_the_member() {
        let wifi = conditions(wire::TransferRule::WifiOnly, false);
        assert!(!wifi.may_prepare(Kind::Original { video: true }));
        assert_eq!(
            wifi.waits_for(Kind::Original { video: true }, false, false),
            wire::WaitReason::Charger
        );
        assert!(
            Conditions {
                charging: true,
                ..wifi
            }
            .may_prepare(Kind::Original { video: true })
        );
        assert!(
            Conditions {
                asked: true,
                ..wifi
            }
            .may_prepare(Kind::Original { video: true })
        );
        let manual = conditions(wire::TransferRule::Manual, false);
        assert!(!manual.may_prepare(Kind::Original { video: false }));
        assert!(manual.may_prepare(Kind::Derivative));
        assert!(
            Conditions {
                asked: true,
                ..manual
            }
            .may_prepare(Kind::Original { video: false })
        );
        // Sealed and waiting for a link the rule allows: Wi-Fi.
        let paid = conditions(wire::TransferRule::WifiOnly, true);
        assert_eq!(
            paid.waits_for(Kind::Original { video: false }, true, false),
            wire::WaitReason::Wifi
        );
        // The shell's to stream.
        assert_eq!(
            wifi.waits_for(Kind::Original { video: false }, false, true),
            wire::WaitReason::Bytes
        );
    }

    /// **WHILE THE MEMBER'S TAP RUNS, A VIDEO IS BEING PREPARED, NOT WAITING
    /// FOR A CHARGER** (#1080, the simulator smoke): the tap lets a video
    /// through off the charger, so the status read during it must say so. A
    /// library video's bytes are the shell's to stream; a sealed one waits for
    /// its window.
    #[test]
    fn during_the_members_tap_a_video_is_prepared_not_held_for_a_charger() {
        let tapped = Conditions {
            asked: true,
            ..conditions(wire::TransferRule::WifiOnly, false)
        };
        assert_eq!(
            tapped.waits_for(Kind::Original { video: true }, false, true),
            wire::WaitReason::Bytes
        );
        assert_eq!(
            tapped.waits_for(Kind::Original { video: true }, false, false),
            wire::WaitReason::Window
        );
    }

    /// **AN ORIGINAL `MANUAL` HOLDS WAITS FOR THE TAP, NOT FOR TIME** (the
    /// audit's finding 4): no pass moves it until the member taps Back up now,
    /// so its reason is `ASK` — a video off the charger included, since the
    /// tap lets that through too, and a library item whose bytes the shell
    /// would stream only once it may be sealed.
    #[test]
    fn an_original_manual_holds_waits_for_the_members_tap() {
        let manual = conditions(wire::TransferRule::Manual, false);
        for (kind, library) in [
            (Kind::Original { video: false }, false),
            (Kind::Original { video: false }, true),
            (Kind::Original { video: true }, false),
        ] {
            assert_eq!(
                manual.waits_for(kind, false, library),
                wire::WaitReason::Ask,
                "{kind:?} library {library}"
            );
        }
        assert_eq!(
            manual.waits_for(Kind::Derivative, false, false),
            wire::WaitReason::Window,
            "a derivative is not held by the rule"
        );
    }

    /// THE MEMBER'S TAP AND THE SNAPSHOT'S TIMING ARE TWO BITS (the root's
    /// ruling A24). The shell sends `wants_snapshot` when the app leaves the
    /// screen too, and under `MANUAL` that must not let an original through:
    /// only `asked`, the "Back up now" tap, does.
    #[test]
    fn under_manual_only_the_members_tap_lets_an_original_through() {
        let leaving = Conditions::of(&wire::DrainRequest {
            rule: wire::TransferRule::Manual as i32,
            wants_snapshot: true,
            asked: false,
            ..wire::DrainRequest::default()
        })
        .expect("a rule");
        assert!(leaving.snapshot, "the snapshot is still taken now");
        assert!(!leaving.may_prepare(Kind::Original { video: false }));
        assert!(leaving.may_prepare(Kind::Derivative));
        let tapped = Conditions::of(&wire::DrainRequest {
            rule: wire::TransferRule::Manual as i32,
            wants_snapshot: true,
            asked: true,
            ..wire::DrainRequest::default()
        })
        .expect("a rule");
        assert!(tapped.may_prepare(Kind::Original { video: false }));
    }

    /// **NO RULE IS ASSUMED** (#1191): a request that names none is refused with a typed error,
    /// and what a pass was told is what a hand-off reads back, in this core's life only.
    #[test]
    fn a_request_without_a_rule_is_refused_and_the_rule_a_pass_was_told_is_remembered() {
        let dir = tempfile::tempdir().expect("a directory");
        let plane = Plane::of(&dir.path().join("vault.db"));
        let unknown = Conditions::remembered(&plane);
        assert_eq!(unknown.rule, wire::TransferRule::WifiOnly);
        assert!(unknown.metered && !unknown.charging && !unknown.exclude_videos);
        let told = Conditions::of(&wire::DrainRequest {
            rule: wire::TransferRule::WifiAndCellularPhotos as i32,
            metered: false,
            charging: true,
            exclude_videos: true,
            ..wire::DrainRequest::default()
        })
        .expect("a rule");
        plane.remember(told);
        assert_eq!(
            Conditions::remembered(&plane),
            Conditions {
                asked: false,
                snapshot: false,
                ..told
            }
        );
        assert!(matches!(
            Conditions::of(&wire::DrainRequest::default()),
            Err(CoreError::InvalidRequest { .. })
        ));
    }
}
