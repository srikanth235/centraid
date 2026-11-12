//! THE PASS, AND THE OPERATING SYSTEM'S HALF OF IT (#1080, "The phone core").
//!
//! ```text
//! reach      every paired gateway that answers, as itself           (the ledger's order)
//! snapshot   when one is due and the link may carry the records    (the vault, briefly)
//! records    move the snapshot's parts, then move each head         (manifest after ranges)
//! prepare    seal what a gateway lacks: derivatives, then originals, newest first
//! move       PUT each part, bundles for the small ones; repeat until nothing is left
//! snapshot   again, when this pass confirmed files whose rows no snapshot covers
//! ```
//!
//! **EVERY PAIRED GATEWAY IS A FULL REPLICA** (#1188, B1). A pass feeds each gateway that
//! answers, on its own: one snapshot is planned against all of them, a part is sealed once and
//! sent to each that lacks it, and a gateway that is away or full does not hold up the others.
//! A part leaves the spool when no paired gateway still owes it (`mover::release`); the wait
//! for one that does not answer is bounded (`mover::SPOOL_WAIT_MS`) and ends early when the
//! spool needs the room. The status says which gateway is behind (`Destination.behind_files`).
//!
//! **Acknowledgement is the `PUT`'s success** (#1080 ruling 7): a part counts
//! in `confirmed_parts` only once a gateway answered that it holds it, and only
//! then does its spool file go. A gateway's own `exists` answer is the other
//! truth the ledger follows: a name a gateway already holds is confirmed from
//! it before anything is sealed, so a restored phone, or one that lost its
//! ledger, re-sends nothing.
//!
//! # THE RECORDS GO FIRST, AND THE HEAD NEVER WAITS BEHIND A LIBRARY
//!
//! The ledger orders a manifest after every other queued part, so a pass that
//! moved the whole queue at once would hold the vault's head until the last
//! film of a backlog had crossed. The records move on their own first, the
//! head is set, and only then do the media move — which is what makes the
//! recovery point for records about an hour while photographs stream.
//!
//! # THE MEMBER'S RULE, AS A TABLE (#1080 ruling 6; the root's ruling A10)
//!
//! | What | May be sealed | May cross a metered link |
//! |---|---|---|
//! | the vault's snapshot | always | under `WIFI_AND_CELLULAR_PHOTOS`, or under any rule when the member asked (R-1080-C38) |
//! | a thumbnail, a preview, a poster | always | always |
//! | a photograph's original | not under `MANUAL` unless the member asked | under `WIFI_AND_CELLULAR_PHOTOS` |
//! | a video's original | on a charger, or when the member asked; never when videos are left out | never |
//!
//! "The member asked" is `DrainRequest.asked`: the "Back up now" tap and
//! nothing else (the root's ruling A24). `wants_snapshot`, which the shell
//! also sends when the app leaves the screen, decides only when the snapshot
//! is taken. The rule and the link a pass was told are remembered in the
//! ledger, because `handoff` — which hands parts to an operating system that
//! moves them while this core is suspended — is not told them again, and
//! `allows_cellular` is how the rule survives the hand-off.
//!
//! # BYTES ONLY THE SHELL CAN READ
//!
//! An original the operating system's library holds was never copied into the
//! app (#1080 ruling 6). A pass cannot read it, so it names it in `need_bytes`
//! and the shell streams it through the stage door, which seals it in the same
//! stream (A8); the next round moves it.
//!
//! **What a pass asks for, it plans** (R-1080-C39). The item's hash is known
//! from its first read, so every part's name is too: the pass asks for each
//! item that fits the spool's room whole, then for as many parts of the first
//! larger one as the rest leave, and hands the stage door that plan. The room
//! is promised until the shell streams, so a later round cannot spend it. A
//! round that moved parts freed room, so the pass plans once more before it
//! answers: an original larger than the spool backs up a window at a time,
//! one read of it per window, instead of never.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{self, PartSealer};
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::ledger::{
    Destination, Ledger, LedgerSnapshot, LocalSource, PartKind, Queued,
};
use centraid_vault::backup::mover::{self, Stop};
use centraid_vault::backup::naming::{BackupKeys, Name, name as part_name, names_of, part_count};
use centraid_vault::backup::retention;
use centraid_vault::backup::snapshot::{self, Manifest, Settled};
use centraid_vault::backup::spool::Spool;
use centraid_vault::backup::store::{self as plane_store, Refusal, Store, StoreError};
use centraid_vault::clock::SystemClock;

use super::link::{self, GatewayStore, Reached};
use super::{Keyring, Plane, now_ms, plane_error, row_backed_up, store_error};
use crate::error::{CoreError, Result};
use crate::handle::HandleState as Handle;
use crate::stage::{Planned, bytes_of_parts, window_within};

/// A snapshot is taken at most this often unless the member asks or a pass
/// confirms files whose rows no snapshot covers (R-1080-C15): an hour, the
/// recovery point for records at home (#1080 ruling 5).
pub const SNAPSHOT_EVERY_MS: u64 = 60 * 60 * 1000;

/// The most items one answer asks the shell to stream (`NeedBytes`).
pub const MAX_NEED_BYTES: usize = 64;

/// How long a part handed to the operating system may go unsettled before it
/// goes back in the queue: a day and an hour. The iPhone's background session
/// gives an upload a day (`BackgroundUploader.resourceTimeoutSeconds`) and
/// reports it failed after; a part handed off longer ago than that, with no
/// settle and not held by the gateway, is one whose report was lost — an app
/// killed before its delegate ran.
pub const HANDOFF_GRACE_MS: u64 = 25 * 60 * 60 * 1000;

/// How much of a file is read for one piece of a part.
const READ_CHUNK: usize = 1024 * 1024;

/// What the snapshot's manifest says took it.
const APP: &str = concat!("centraid-core/", env!("CARGO_PKG_VERSION"));

/// One gateway's last answer is kept at `reach:<gateway id>`, with [`REACHABLE_KEY`]'s values.
const REACH_PREFIX: &str = "reach:";
const RULE_KEY: &str = "pass.rule";
const EXCLUDE_VIDEOS_KEY: &str = "pass.exclude_videos";
const METERED_KEY: &str = "pass.metered";
const CHARGING_KEY: &str = "pass.charging";
const REACHABLE_KEY: &str = "pass.reachable";
/// A snapshot the shell asked for that no pass has taken yet: the app left
/// the screen while the gateway was out of reach. See [`snapshot_owed`].
const SNAPSHOT_OWED_KEY: &str = "pass.snapshot_owed";

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
    /// The kind of a queued part.
    #[must_use]
    pub fn of_part(part: &Queued) -> Self {
        match part.kind {
            PartKind::Range | PartKind::Manifest => Self::Records,
            PartKind::Derivative => Self::Derivative,
            PartKind::Original => Self::Original {
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

    const fn part_kind(self) -> PartKind {
        match self {
            Self::Records => PartKind::Range,
            Self::Derivative => PartKind::Derivative,
            Self::Original { .. } => PartKind::Original,
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

fn rule_of(value: i32) -> wire::TransferRule {
    match wire::TransferRule::try_from(value) {
        Ok(wire::TransferRule::Unspecified) | Err(_) => wire::TransferRule::WifiOnly,
        Ok(rule) => rule,
    }
}

impl Conditions {
    /// What a drain request says. An unspecified rule is `WIFI_ONLY`
    /// (`phone.proto`).
    #[must_use]
    pub fn of(request: &wire::DrainRequest) -> Self {
        Self {
            rule: rule_of(request.rule),
            metered: request.metered,
            charging: request.charging,
            exclude_videos: request.exclude_videos,
            asked: request.asked,
            snapshot: request.wants_snapshot,
        }
    }

    /// What the last pass was told, or the expensive reading when no pass has
    /// run: `WIFI_ONLY`, metered, not charging, videos included.
    ///
    /// # Errors
    /// The ledger's refusal.
    pub fn remembered(ledger: &Ledger) -> Result<Self> {
        let read = |key: &str| ledger.meta(key).map_err(plane_error);
        Ok(Self {
            rule: rule_of(
                read(RULE_KEY)?
                    .and_then(|text| text.parse().ok())
                    .unwrap_or(wire::TransferRule::WifiOnly as i32),
            ),
            metered: read(METERED_KEY)?.is_none_or(|text| text == "1"),
            charging: read(CHARGING_KEY)?.is_some_and(|text| text == "1"),
            exclude_videos: read(EXCLUDE_VIDEOS_KEY)?.is_some_and(|text| text == "1"),
            asked: false,
            snapshot: false,
        })
    }

    fn remember(&self, ledger: &Ledger) -> Result<()> {
        let flag = |value: bool| if value { "1" } else { "0" };
        for (key, value) in [
            (RULE_KEY, (self.rule as i32).to_string()),
            (METERED_KEY, flag(self.metered).to_owned()),
            (CHARGING_KEY, flag(self.charging).to_owned()),
            (EXCLUDE_VIDEOS_KEY, flag(self.exclude_videos).to_owned()),
        ] {
            ledger.set_meta(key, &value).map_err(plane_error)?;
        }
        Ok(())
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

/// What the last pass found at the gateway, as the reason everything waits:
/// `None` when it reached one, or when no pass has run yet — a phone that has
/// not tried is not blamed on its gateway; `GATEWAY` when none answered;
/// `UNTRUSTED` when the machine that answered is not the pinned gateway,
/// whether at the start of the pass or part-way through it; `REFUSED` when it
/// answered and refused a write for its own reason (a full disk, a part over its limit, or a
/// code this build does not know);
/// `PAIR_AGAIN` when it no longer knows this phone's token.
///
/// # Errors
/// The ledger's refusal.
pub fn last_reach(ledger: &Ledger) -> Result<Option<wire::WaitReason>> {
    Ok(
        match ledger.meta(REACHABLE_KEY).map_err(plane_error)?.as_deref() {
            Some(REACH_SILENT) => Some(wire::WaitReason::Gateway),
            Some(REACH_UNTRUSTED) => Some(wire::WaitReason::Untrusted),
            Some(REACH_REFUSED) => Some(wire::WaitReason::Refused),
            Some(REACH_TOO_LARGE) => Some(wire::WaitReason::TooLarge),
            Some(REACH_REFUSED_OTHER) => Some(wire::WaitReason::RefusedOther),
            Some(REACH_PAIR_AGAIN) => Some(wire::WaitReason::PairAgain),
            _ => None,
        },
    )
}

/// `REACHABLE_KEY`'s values.
const REACH_ANSWERED: &str = "1";
const REACH_SILENT: &str = "0";
const REACH_UNTRUSTED: &str = "untrusted";
/// The gateway answered and refused a write for want of room: its disk is full (the sweep's
/// F1). The spelling is the one earlier builds wrote, so a ledger that holds it reads the same.
const REACH_REFUSED: &str = "refused";
/// The gateway refused a part as over its limit ([`MAX_OBJECT_BYTES`]).
const REACH_TOO_LARGE: &str = "refused_large";
/// The gateway refused a write with a code that is neither of those (one this build does not
/// know, or a refusal that is not about room).
const REACH_REFUSED_OTHER: &str = "refused_other";

/// What the gateway said when it refused, as the ledger keeps it.
fn heard_of(refusal: &Refusal) -> &'static str {
    match refusal {
        Refusal::DiskFull => REACH_REFUSED,
        Refusal::TooLarge => REACH_TOO_LARGE,
        _ => REACH_REFUSED_OTHER,
    }
}

/// The largest object the protocol allows, which is what a `TOO_LARGE` refusal crossed: the
/// limit the Backup screen names.
#[must_use]
pub const fn refused_limit_bytes() -> u64 {
    centraid_gateway::rules::limits::MAX_OBJECT_BYTES
}
/// The gateway answered `UNAUTHORIZED` to this phone's token (the sweep's F2).
const REACH_PAIR_AGAIN: &str = "pair_again";

/// What a refusal the gateway sent outside a part's own `PUT` is to a pass,
/// told by its code — [`super::store_error`] spells a refusal as
/// [`CoreError::GatewayRefused`] with the code as its reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refused {
    /// `UNAUTHORIZED`: the gateway does not know this phone's token.
    Token,
    /// Any other refusal is that gateway's own answer: the value the ledger keeps for it
    /// (`DISK_FULL`, `TOO_LARGE`, or one this build does not know). It stops that gateway's
    /// pass and no other's.
    Limit(&'static str),
}

/// The class a refusal's code belongs to.
fn refused_by(reason: &str) -> Refused {
    match reason {
        "UNAUTHORIZED" => Refused::Token,
        "DISK_FULL" => Refused::Limit(REACH_REFUSED),
        "TOO_LARGE" => Refused::Limit(REACH_TOO_LARGE),
        _ => Refused::Limit(REACH_REFUSED_OTHER),
    }
}

// ─── the pass ───────────────────────────────────────────────────────────────

/// What one pass did, as the answer carries it.
struct Pass {
    confirmed: u32,
    stopped: wire::DrainStop,
    acked_at_ms: Option<i64>,
    need: Vec<wire::NeedBytes>,
    /// The part names of each file, worked out once a pass (see [`NameCache`]).
    names: NameCache,
    /// How many names this pass asked a gateway about: each name once a pass, per gateway.
    asks: usize,
    waiting_bytes: BTreeSet<Name>,
    /// The spool volume's free bytes, read when the pass began: the floor an
    /// oversize part keeps (the sweep's F6).
    free: u64,
    /// Parts a gateway acknowledged in this pass's media rounds (originals and
    /// derivatives, never the records), and the names the gateway already held
    /// that were confirmed from its answer: the files whose rows a snapshot
    /// may still owe the pass one for.
    media_confirmed: usize,
    /// The spool's bytes promised to the library items asked for: the shell
    /// streams them after the pass answers, so no later round of this pass
    /// may spend them first.
    promised: u64,
    /// What each asked-for item's stream is to seal, by its identifier in
    /// the library (R-1080-C39).
    planned: BTreeMap<String, Planned>,
    /// What the gateway did part-way through, for the status to say until a
    /// pass reaches it again: `REACH_SILENT` when it stopped answering,
    /// `REACH_UNTRUSTED` when another machine answered in its place,
    /// `REACH_REFUSED` when it answered and refused a write for its own
    /// reason (the sweep's F1). `None` when it answered to the end.
    heard: Option<&'static str>,
    /// Gateways that were fed to the end of the pass's media rounds.
    fed: usize,
    /// A token a gateway refused, kept to be the pass's error when no other gateway was fed.
    refused_token: Option<CoreError>,
}

impl Pass {
    fn new() -> Self {
        Self {
            confirmed: 0,
            stopped: wire::DrainStop::Empty,
            acked_at_ms: None,
            need: Vec::new(),
            names: NameCache::default(),
            asks: 0,
            waiting_bytes: BTreeSet::new(),
            free: 0,
            media_confirmed: 0,
            promised: 0,
            planned: BTreeMap::new(),
            heard: None,
            fed: 0,
            refused_token: None,
        }
    }

    /// The mover stopped this pass, or did not: answers whether it did, and
    /// keeps why — what the pass answers, and what the gateway did.
    fn stopped_by(&mut self, stop: &Stop) -> Result<bool> {
        let Some(answer) = stop_of(stop)? else {
            return Ok(false);
        };
        self.stopped = answer;
        self.heard = match stop {
            Stop::Unreachable(_) => Some(REACH_SILENT),
            Stop::Untrusted(_) => Some(REACH_UNTRUSTED),
            Stop::Refused(refusal) => Some(heard_of(refusal)),
            _ => None,
        };
        Ok(true)
    }

    /// Whether this pass already asked for the item, under its hash or its
    /// identifier.
    fn has_asked(&self, ask: &LibraryAsk<'_>) -> bool {
        self.planned.contains_key(&ask.os_ref)
            || self
                .need
                .iter()
                .any(|need| need.content_hash == ask.file.h.as_bytes())
    }

    /// Ask the shell to stream the item, planning `parts` from it and
    /// promising their room.
    fn ask_for(&mut self, ask: &LibraryAsk<'_>, parts: Vec<u32>) {
        self.promised = self
            .promised
            .saturating_add(bytes_of_parts(ask.file.len, &parts));
        self.need.push(wire::NeedBytes {
            content_hash: ask.file.h.as_bytes().to_vec(),
            os_ref: ask.os_ref.clone(),
            media_type: ask.file.media_type.clone(),
            size: ask.file.len,
        });
        self.planned.insert(
            ask.os_ref.clone(),
            Planned {
                h: ask.file.h,
                len: ask.file.len,
                parts,
            },
        );
    }

    fn count(&mut self, confirmed: usize) {
        self.confirmed = self
            .confirmed
            .saturating_add(u32::try_from(confirmed).unwrap_or(u32::MAX));
    }
}

fn deadline_of(deadline_ms: u64, started: Instant) -> Instant {
    let budget = if deadline_ms == 0 {
        // NO DEADLINE: the member is watching. A year stands for "none" so
        // the checks between parts stay one comparison.
        Duration::from_secs(365 * 24 * 60 * 60)
    } else {
        Duration::from_millis(deadline_ms)
    };
    started.checked_add(budget).unwrap_or(started)
}

/// `gateway_id` answered `UNAUTHORIZED` to this phone's token: mark it for
/// pairing again, and let the status wait on that rather than on time (the
/// sweep's F2). A pairing starts the gateway's record over, which spends it.
fn mark_token_refused(ledger: &Ledger, gateway_id: &str) -> Result<()> {
    ledger.set_unauthorized(gateway_id).map_err(plane_error)?;
    set_reach(ledger, gateway_id, REACH_PAIR_AGAIN)
}

/// What the last pass found at one gateway (#1188, B1): every paired gateway has its own
/// answer, so the status can name the one that is behind. The ledger's single
/// [`REACHABLE_KEY`] is the worst of them ([`summarise_reach`]).
/// A forgotten gateway's answer goes with it, so pairing it again starts from nothing and not from
/// the last thing it said.
pub(crate) fn forget_reach(ledger: &Ledger, gateway_id: &str) -> Result<()> {
    ledger
        .forget_meta(&reach_key(gateway_id))
        .map_err(plane_error)?;
    summarise_reach(ledger)
}

fn reach_key(gateway_id: &str) -> String {
    format!("{REACH_PREFIX}{gateway_id}")
}

fn set_reach(ledger: &Ledger, gateway_id: &str, value: &str) -> Result<()> {
    ledger
        .set_meta(&reach_key(gateway_id), value)
        .map_err(plane_error)?;
    summarise_reach(ledger)
}

/// `REACHABLE_KEY` is the worst answer among the paired gateways, in the order a member can
/// act on it: a token to pair again, a refusal to make room, another machine answering, a
/// silent gateway.
fn summarise_reach(ledger: &Ledger) -> Result<()> {
    let mut worst = REACH_ANSWERED;
    let rank = |value: &str| match value {
        REACH_PAIR_AGAIN => 4,
        REACH_REFUSED | REACH_TOO_LARGE | REACH_REFUSED_OTHER => 3,
        REACH_UNTRUSTED => 2,
        REACH_SILENT => 1,
        _ => 0,
    };
    for destination in ledger.destinations().map_err(plane_error)? {
        let held = ledger
            .meta(&reach_key(&destination.gateway_id))
            .map_err(plane_error)?;
        if let Some(value) = held.as_deref()
            && rank(value) > rank(worst)
        {
            worst = match value {
                REACH_PAIR_AGAIN => REACH_PAIR_AGAIN,
                REACH_REFUSED => REACH_REFUSED,
                REACH_TOO_LARGE => REACH_TOO_LARGE,
                REACH_REFUSED_OTHER => REACH_REFUSED_OTHER,
                REACH_UNTRUSTED => REACH_UNTRUSTED,
                _ => REACH_SILENT,
            };
        }
    }
    ledger.set_meta(REACHABLE_KEY, worst).map_err(plane_error)
}

/// Why one paired gateway is behind, as its last answer says: `None` when it answered (or
/// has not been asked yet).
///
/// # Errors
/// The ledger's refusal.
pub fn gateway_reach(ledger: &Ledger, gateway_id: &str) -> Result<Option<wire::WaitReason>> {
    Ok(
        match ledger
            .meta(&reach_key(gateway_id))
            .map_err(plane_error)?
            .as_deref()
        {
            Some(REACH_SILENT) => Some(wire::WaitReason::Gateway),
            Some(REACH_UNTRUSTED) => Some(wire::WaitReason::Untrusted),
            Some(REACH_REFUSED) => Some(wire::WaitReason::Refused),
            Some(REACH_TOO_LARGE) => Some(wire::WaitReason::TooLarge),
            Some(REACH_REFUSED_OTHER) => Some(wire::WaitReason::RefusedOther),
            Some(REACH_PAIR_AGAIN) => Some(wire::WaitReason::PairAgain),
            _ => None,
        },
    )
}

/// A mover's stop as the pass answers it; `MOVED` is a refusal, never a stop.
fn stop_of(stop: &Stop) -> Result<Option<wire::DrainStop>> {
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

/// **Run one pass.** See the module header.
///
/// # Errors
/// [`CoreError::VaultMoved`] when a gateway answered that another phone holds
/// this vault's writer epoch — recorded in the ledger, so every later pass
/// refuses the same way; the ledger's, the spool's or the vault's refusal.
pub fn run(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::DrainRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::DrainResponse> {
    run_cancellable(handle, keyring, request, runtime, None)
}

pub(crate) fn run_cancellable(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::DrainRequest,
    runtime: &tokio::runtime::Handle,
    cancellation: Option<crate::handle::Cancellation>,
) -> Result<wire::DrainResponse> {
    if let Some(stop) = &cancellation {
        stop.check()?;
    }
    // THE LAST PASS'S PLAN IS SPENT: a pass that answers early asks for
    // nothing, and a stream with no plan seals the way a first read does.
    handle.plan_library(BTreeMap::new());
    let started = Instant::now();
    let deadline = deadline_of(request.deadline_ms, started);
    let conditions = Conditions::of(request);
    let plane = handle.plane();
    let ledger = plane.ledger()?;
    conditions.remember(&ledger)?;
    if conditions.snapshot {
        ledger
            .set_meta(SNAPSHOT_OWED_KEY, "1")
            .map_err(plane_error)?;
    }
    let spool = plane.spool()?;
    if let Some((_, epoch)) = super::moved(&ledger)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    let mut pass = Pass::new();
    let destinations = ledger.destinations().map_err(plane_error)?;
    // EVERY PAIRED GATEWAY IS FED (#1188, B1): the pass asks all of them, and each that
    // answers as itself is a replica this pass brings up to date.
    let fleet = if destinations.is_empty() {
        link::Fleet {
            reached: Vec::new(),
            silent: Vec::new(),
            untrusted: Vec::new(),
        }
    } else {
        link::reach_all(&destinations, &ledger, keyring.vault_id(), runtime)?
    };
    if let Some(stop) = &cancellation {
        stop.check()?;
    }
    for reached in &fleet.reached {
        ledger
            .set_meta(&reach_key(&reached.destination.gateway_id), REACH_ANSWERED)
            .map_err(plane_error)?;
    }
    for id in &fleet.silent {
        ledger
            .set_meta(&reach_key(id), REACH_SILENT)
            .map_err(plane_error)?;
    }
    for id in &fleet.untrusted {
        ledger
            .set_meta(&reach_key(id), REACH_UNTRUSTED)
            .map_err(plane_error)?;
    }
    summarise_reach(&ledger)?;
    if fleet.reached.is_empty() {
        // NOTHING PAIRED, NOTHING ANSWERED, OR NOT THE PINNED GATEWAY: nothing is
        // sealed for nobody, and the spool is left exactly as it was.
        pass.stopped = if fleet.untrusted.is_empty() {
            wire::DrainStop::Unreachable
        } else {
            wire::DrainStop::Untrusted
        };
        return answer(&spool, pass);
    }
    let everyone = fleet.silent.is_empty() && fleet.untrusted.is_empty();
    let mut reached = fleet.reached;
    for gateway in &mut reached {
        gateway.store.set_cancellation(cancellation.clone());
    }
    reached[0].store.checkpoint()?;
    let outcome = pass_over(
        handle,
        keyring,
        plane,
        &ledger,
        &spool,
        &reached,
        &conditions,
        deadline,
        everyone,
        &mut pass,
    );
    reached[0].store.checkpoint()?;
    handle.plan_library(std::mem::take(&mut pass.planned));
    outcome?;
    // A TOKEN NO REACHED GATEWAY ACCEPTED is the pass's error, as it was when one gateway was
    // all there was; with another fed, the pass answers and the refused one is marked.
    if let Some(error) = pass.refused_token.take()
        && pass.fed == 0
    {
        return Err(error);
    }
    answer(&spool, pass)
}

/// What a gateway's failure inside a pass comes to: the gateway leaves the pass and the
/// others are still fed, or the failure is the pass's own.
///
/// # Errors
/// A superseded writer, and every failure that is not one gateway's.
fn absorb(ledger: &Ledger, pass: &mut Pass, gateway: &Reached, error: CoreError) -> Result<()> {
    let id = &gateway.destination.gateway_id;
    match error {
        CoreError::Unavailable { reason } => {
            tracing::debug!(%reason, "the gateway stopped answering mid-pass");
            set_reach(ledger, id, REACH_SILENT)?;
            pass.stopped = wire::DrainStop::Unreachable;
            Ok(())
        }
        // THE GATEWAY WAS FORGOTTEN UNDER THE PASS (`forget_destination` from the Backup
        // screen while Back up now runs): its token is revoked and its row gone. That is a
        // gateway the pass no longer feeds, not an error.
        _ if ledger.destination(id).map_err(plane_error)?.is_none() => {
            tracing::info!("a gateway this pass reached was forgotten under it");
            pass.stopped = wire::DrainStop::Unreachable;
            Ok(())
        }
        CoreError::VaultMoved { current_epoch, .. } => {
            // FROZEN, AND REMEMBERED: the ledger keeps the refusal, so status draws the phone
            // read-only and every pass refuses at once.
            ledger.set_moved(id, current_epoch).map_err(plane_error)?;
            Err(CoreError::VaultMoved {
                current_epoch,
                moved_at_ms: gateway.gateway_ms,
            })
        }
        CoreError::GatewayRefused { reason } => match refused_by(&reason) {
            // THE GATEWAY ANSWERED, AND ITS ANSWER IS ITS OWN — a full disk, a part over its
            // limit, a code this build does not know — on a call that was not a part's `PUT`:
            // the same stop the mover gives a refused part (#1080, the sweep's F1), so the status
            // says that machine has to be looked at, not that time will pass. It stops this
            // gateway's pass and no other's.
            Refused::Limit(heard) => {
                tracing::warn!(code = %reason, "the gateway refused; it leaves the pass");
                set_reach(ledger, id, heard)?;
                pass.stopped = wire::DrainStop::Refused;
                Ok(())
            }
            // A TOKEN THE GATEWAY DOES NOT KNOW (#1080, the sweep's F2): marked, so the
            // status says to pair again.
            Refused::Token => {
                tracing::warn!("the gateway does not know this phone's token; pair again");
                mark_token_refused(ledger, id)?;
                pass.refused_token
                    .get_or_insert(CoreError::GatewayRefused { reason });
                Ok(())
            }
        },
        other => Err(other),
    }
}

/// Run `step` over each gateway still in the pass. A step that stops a gateway softly
/// (`Flow::Stop`: it went away, or answered with its own limit) takes it out of the
/// remaining phases and records what it heard; a failure is [`absorb`]ed.
fn each<'a>(
    live: &mut Vec<&'a Reached>,
    ledger: &Ledger,
    pass: &mut Pass,
    mut step: impl FnMut(&'a Reached, &mut Pass) -> Result<Flow>,
) -> Result<()> {
    let mut staying: Vec<&'a Reached> = Vec::with_capacity(live.len());
    for gateway in live.drain(..) {
        pass.heard = None;
        match step(gateway, pass) {
            Ok(Flow::Continue) => staying.push(gateway),
            Ok(Flow::Stop) => {
                if let Some(heard) = pass.heard.take() {
                    set_reach(ledger, &gateway.destination.gateway_id, heard)?;
                }
            }
            Err(error) => absorb(ledger, pass, gateway, error)?,
        }
    }
    *live = staying;
    Ok(())
}

/// Whether a gateway stays in the pass's remaining phases.
enum Flow {
    Continue,
    Stop,
}

#[allow(clippy::too_many_arguments)]
fn pass_over(
    handle: &Handle,
    keyring: &Keyring,
    plane: &Plane,
    ledger: &Ledger,
    spool: &Spool,
    fleet: &[Reached],
    conditions: &Conditions,
    deadline: Instant,
    everyone: bool,
    pass: &mut Pass,
) -> Result<()> {
    let mut live: Vec<&Reached> = fleet.iter().collect();
    let reachable: Vec<String> = fleet
        .iter()
        .map(|reached| reached.destination.gateway_id.clone())
        .collect();
    let round = Round {
        handle,
        keyring,
        plane,
        ledger,
        spool,
        deadline,
    };
    // A PART KEPT FOR A GATEWAY THAT NEVER CAME BACK IS KEPT A DAY, not for ever.
    mover::release_expired(ledger, spool, now_ms()).map_err(plane_error)?;

    // THE WRITER EPOCH, AT CONTACT (#1080, the sweep's R6), and — once a core's life — the
    // ledger squared with each gateway (#1080 ruling 7: reconciled "on every launch").
    let owes_reconcile = handle.owes_full_reconcile();
    let mut squared_all = true;
    each(&mut live, ledger, pass, |reached, pass| {
        let store = &reached.store;
        // Another phone that restored the vault claimed a later epoch; this phone's token is
        // refused `MOVED` only when it writes, and a pass with nothing to write would never
        // learn it. The head answers the writer epoch on every read, so the pass asks first.
        match store.head_and_epoch() {
            Ok((epoch, _)) if epoch > reached.destination.epoch => {
                return Err(CoreError::VaultMoved {
                    current_epoch: epoch,
                    moved_at_ms: 0,
                });
            }
            // THE GATEWAY KNOWS THIS PHONE'S TOKEN, whatever it refused before: a mark that
            // said to pair again is spent (the sweep's F2).
            Ok((_, head)) => {
                let id = &reached.destination.gateway_id;
                ledger.clear_unauthorized(id).map_err(plane_error)?;
                // A HEAD THAT WENT BACKWARDS (#1188, B4): the gateway names an older snapshot
                // than this phone set there, or none (a restored backup of the gateway's own
                // disk, a swapped store). The phone remembers the newest it set, and flags
                // the gateway until it sets a current head again, which the pass does next.
                let rolled = match (ledger.highwater(id).map_err(plane_error)?, head) {
                    (Some(_), None) => true,
                    (Some(high), Some(head)) => head.taken_at_ms < high,
                    (None, _) => false,
                };
                if rolled {
                    tracing::warn!(gateway = %id, "the gateway's head went backwards");
                }
                ledger.set_rolled_back(id, rolled).map_err(plane_error)?;
            }
            Err(StoreError::Unreachable(reason)) => {
                pass.stopped_by(&Stop::Unreachable(reason))?;
                squared_all = false;
                return Ok(Flow::Stop);
            }
            Err(StoreError::Untrusted(reason)) => {
                pass.stopped_by(&Stop::Untrusted(reason))?;
                squared_all = false;
                return Ok(Flow::Stop);
            }
            Err(error) => return Err(store_error(error)),
        }
        // A GATEWAY THAT WENT BACKWARDS lost what it held since: ask it about every name now,
        // so the ledger stops confirming what it no longer has.
        let rolled = ledger
            .rolled_back(&reached.destination.gateway_id)
            .map_err(plane_error)?;
        if owes_reconcile || rolled {
            let squared =
                mover::reconcile(ledger, spool, store, &SystemClock).map_err(plane_error)?;
            // NAMES THE GATEWAY HELD ARE FILES CONFIRMED, here as in a pass's own rounds:
            // their rows may be in no snapshot yet (R-1080-C15).
            pass.media_confirmed = pass.media_confirmed.saturating_add(squared.confirmed.len());
            if !squared.unconfirmed.is_empty() {
                tracing::warn!(
                    lost = squared.unconfirmed.len(),
                    "the gateway no longer holds names this phone confirmed; they go again"
                );
            }
        }
        Ok(Flow::Continue)
    })?;
    if owes_reconcile && everyone && squared_all && live.len() == fleet.len() {
        handle.reconciled_fully();
    }

    let budget = plane.budget();
    pass.free = plane.free_bytes();
    let files = handle.with_vault(|vault| content_files(vault).map_err(plane_error))?;

    // 1. THE RECORDS, when the link may carry them: one snapshot, planned against every
    // gateway that is due or behind.
    if conditions.may_move(Kind::Records) && !live.is_empty() {
        let owed = snapshot_owed(ledger)?;
        let mut take = false;
        // A VAULT THAT HAS NOT CHANGED SINCE A SNAPSHOT EVERY GATEWAY HOLDS WHOLE IS NOT COPIED
        // AGAIN, however long ago that was and whoever asked (#1188, design 6).
        if let Some(acked) = newest_stands(handle, ledger, &live)? {
            // ASKED FOR, IT IS ANSWERED with the gateway's own time for the head it holds.
            if owed {
                pass.acked_at_ms = i64::try_from(acked).ok();
            }
            ledger
                .set_meta(SNAPSHOT_OWED_KEY, "0")
                .map_err(plane_error)?;
        } else {
            for reached in &live {
                take |= snapshot_due(ledger, reached.store.gateway_id(), owed)?;
            }
        }
        if round.records(take, &files, &mut live, budget, pass)? {
            return Ok(());
        }
    }

    // 2. THE MEDIA, INTERLEAVED: one bounded round per gateway in turn (seal what fits the
    // spool, move it), again, until every gateway has finished or left. A slow gateway takes
    // its round and no more, so every reachable gateway makes progress in every pass and in
    // every background window (#1188, item 16).
    let bytes = handle.bytes();
    let mut all_finished = true;
    let mut feeds: Vec<Feed<'_>> = live.iter().map(|reached| Feed::new(reached)).collect();
    let mut left: BTreeSet<String> = BTreeSet::new();
    while feeds.iter().any(|feed| !feed.finished) {
        for feed in feeds.iter_mut().filter(|feed| !feed.finished) {
            pass.heard = None;
            let id = feed.reached.destination.gateway_id.clone();
            let step = media_round(
                feed,
                &files,
                ledger,
                spool,
                &keyring.backup,
                bytes.as_ref().map(centraid_blobs::ContentBytes::store),
                conditions,
                budget,
                deadline,
                &reachable,
                pass,
            );
            match step {
                Ok(Flow::Continue) => {}
                Ok(Flow::Stop) => {
                    feed.finished = true;
                    all_finished = false;
                    left.insert(id.clone());
                    if let Some(heard) = pass.heard.take() {
                        set_reach(ledger, &id, heard)?;
                    }
                }
                Err(error) => {
                    feed.finished = true;
                    all_finished = false;
                    left.insert(id);
                    absorb(ledger, pass, feed.reached, error)?;
                }
            }
        }
    }
    live.retain(|reached| !left.contains(&reached.destination.gateway_id));
    // A gateway that left the pass was not finished.
    all_finished &= live.len() == fleet.len();

    // 2b. THE PHONE VERIFIES (#1188, B4): a small random sample of what each gateway said it
    // holds is read back and opened, so a gateway that lost or damaged a part is found by the
    // next pass and not by a restore.
    each(&mut live, ledger, pass, |reached, _| {
        verify_sample(ledger, &reached.store, &keyring.backup)?;
        // ONE LARGE PART PER GATEWAY, STREAMED (#1188): the sample's cap keeps every original out
        // of it, so the part least recently read back is opened here, over a link that is not
        // metered (it reads a whole part, which no rule lets cross one).
        if !conditions.metered {
            verify_large(ledger, spool, &reached.store, &keyring.backup)?;
        }
        Ok(Flow::Continue)
    })?;

    // 3. THE RECORDS AGAIN, WHEN THIS PASS CONFIRMED FILES THEIR ROWS ARE NOT IN A SNAPSHOT
    // FOR (R-1080-C15). A pass that was cut off owes it to the next, which takes it first.
    if pass.media_confirmed > 0 && conditions.may_move(Kind::Records) {
        let now_files = handle.with_vault(|vault| content_files(vault).map_err(plane_error))?;
        let mut uncovered = false;
        for reached in fleet {
            uncovered |= rows_uncovered(
                ledger,
                reached.store.gateway_id(),
                &keyring.backup,
                conditions,
                &now_files,
            )?;
        }
        if uncovered {
            if all_finished {
                round.records(true, &now_files, &mut live, budget, pass)?;
            } else {
                owe_a_snapshot(ledger)?;
            }
        }
    }
    Ok(())
}

/// How many acknowledged parts a pass reads back from each gateway, and the largest it reads
/// (plaintext bytes as recorded): a sample is the point, never a second upload.
const VERIFY_SAMPLE: usize = 3;
const VERIFY_MAX_BYTES: u64 = centraid_vault::backup::ledger::SAMPLE_MAX_BYTES;

/// Read back a random sample of what `store` acknowledged and open each part: a name it no
/// longer holds, or bytes that no longer open, are unconfirmed (so the next pass sends them
/// again, and the head is retaken). Answers how many it found wrong.
fn verify_sample(
    ledger: &Ledger,
    store: &GatewayStore,
    keys: &centraid_vault::backup::naming::BackupKeys,
) -> Result<usize> {
    let sample = ledger
        .confirmed_sample(store.gateway_id(), VERIFY_MAX_BYTES, VERIFY_SAMPLE)
        .map_err(plane_error)?;
    let mut wrong: Vec<Name> = Vec::new();
    for name in sample {
        let mut bytes = Vec::new();
        match plane_store::Store::get(store, &name, &mut bytes) {
            Ok(_) => {
                if sealed::open_part(keys, &bytes).is_err() {
                    wrong.push(name);
                }
            }
            Err(StoreError::Missing(_) | StoreError::Damaged(_)) => wrong.push(name),
            Err(error) => return Err(store_error(error)),
        }
    }
    if !wrong.is_empty() {
        tracing::warn!(
            gateway = %store.gateway_id(),
            wrong = wrong.len(),
            "a gateway no longer holds what it acknowledged"
        );
        ledger
            .unconfirm_many(&wrong, store.gateway_id())
            .map_err(plane_error)?;
    }
    Ok(wrong.len())
}

/// Read back the one confirmed part above the sample's cap that `store` was least recently read
/// back for, streamed, and open it: a part no longer held, or no longer opening, is unconfirmed
/// and sent again. Answers whether it found one wrong.
fn verify_large(
    ledger: &Ledger,
    spool: &Spool,
    store: &GatewayStore,
    keys: &centraid_vault::backup::naming::BackupKeys,
) -> Result<bool> {
    use centraid_vault::backup::verify::{ReadBack, read_back_large};
    match read_back_large(ledger, spool, store, keys, now_ms()).map_err(plane_error)? {
        ReadBack::Wrong(name) => {
            tracing::warn!(
                gateway = %store.gateway_id(),
                %name,
                "a gateway no longer holds an original it acknowledged"
            );
            Ok(true)
        }
        ReadBack::Unanswered(error) => Err(store_error(error)),
        ReadBack::Nothing | ReadBack::Held(_) => Ok(false),
    }
}

/// What the records' half of a pass needs, so the pass can run it twice: when
/// it begins, and when it has confirmed files whose rows nothing covers.
struct Round<'a> {
    handle: &'a Handle,
    keyring: &'a Keyring,
    plane: &'a Plane,
    ledger: &'a Ledger,
    spool: &'a Spool,
    deadline: Instant,
}

impl Round<'_> {
    /// Take a snapshot when `take` (planned against every gateway still in the pass), move the
    /// records' parts to each, and move each head once every part of the newest snapshot is
    /// confirmed there. Answers whether the pass stopped at its deadline.
    fn records(
        &self,
        take: bool,
        files: &[ContentFile],
        live: &mut Vec<&Reached>,
        budget: u64,
        pass: &mut Pass,
    ) -> Result<bool> {
        if take {
            let stores: Vec<&GatewayStore> = live.iter().map(|reached| &reached.store).collect();
            let failures = match take_snapshot(
                self.handle,
                self.keyring,
                self.plane,
                self.ledger,
                self.spool,
                &stores,
                budget,
            )? {
                // NOT ENOUGH ROOM TO COPY THE VAULT: the snapshot stays owed, the status says why
                // (`WAIT_REASON_NO_ROOM`), and the rest of the pass runs.
                Taken::NoRoom => {
                    self.ledger
                        .set_meta(NO_ROOM_KEY, "1")
                        .map_err(plane_error)?;
                    Vec::new()
                }
                Taken::Done(failures) => {
                    self.ledger
                        .set_meta(NO_ROOM_KEY, "0")
                        .map_err(plane_error)?;
                    if failures.len() < stores.len() {
                        self.ledger
                            .set_meta(SNAPSHOT_OWED_KEY, "0")
                            .map_err(plane_error)?;
                    }
                    failures
                }
            };
            for (id, error) in failures {
                if let Some(at) = live
                    .iter()
                    .position(|reached| reached.destination.gateway_id == id)
                {
                    let gateway = live.remove(at);
                    absorb(self.ledger, pass, gateway, error)?;
                }
            }
        }
        let mut stopped = false;
        let now = self
            .handle
            .with_vault(|vault| Ok(u64::try_from(vault.clock().now_ms()).unwrap_or(0)))?;
        each(live, self.ledger, pass, |reached, pass| {
            let store = &reached.store;
            let moved = mover::move_queue_where(
                self.ledger,
                self.spool,
                store,
                self.deadline,
                &SystemClock,
                &|part| part.handed_off_ms.is_none() && Kind::of_part(part) == Kind::Records,
            )
            .map_err(plane_error)?;
            pass.count(moved.confirmed.len());
            if pass.stopped_by(&moved.stopped)? {
                stopped |= matches!(moved.stopped, Stop::Deadline);
                return Ok(Flow::Stop);
            }
            // RETENTION IS JUDGED ON THE VAULT'S OWN CLOCK, the one every snapshot's
            // `taken_at_ms` is dated by.
            settle_newest(self.ledger, store, self.keyring, files, now, pass)?;
            Ok(Flow::Continue)
        })?;
        Ok(stopped)
    }
}

/// **A FILE THE MEMBER BACKS UP, WHOSE BYTES `gateway_id` HOLDS AND WHOSE ROW NO SNAPSHOT THIS
/// PHONE TOOK COVERS** (R-1080-C15): the file the status would read as waiting for the next
/// snapshot. "Covers" counts every snapshot in the ledger — one still on its way included,
/// since it is already in flight — by the vault's own clock, as [`row_backed_up`] does.
fn rows_uncovered(
    ledger: &Ledger,
    gateway_id: &str,
    keys: &BackupKeys,
    conditions: &Conditions,
    files: &[ContentFile],
) -> Result<bool> {
    let confirmed = ledger.confirmed_names(gateway_id).map_err(plane_error)?;
    let covered_at = ledger
        .snapshots()
        .map_err(plane_error)?
        .iter()
        .map(|snapshot| snapshot.taken_at_ms)
        .max();
    Ok(files.iter().any(|file| {
        conditions.counts(Kind::of_file(file))
            && names_of(keys, &file.h, file.len)
                .iter()
                .all(|name| confirmed.contains(name))
            && !row_backed_up(file, covered_at)
    }))
}

fn answer(spool: &Spool, pass: Pass) -> Result<wire::DrainResponse> {
    Ok(wire::DrainResponse {
        pending_bytes: spool.bytes().map_err(plane_error)?,
        stopped: pass.stopped as i32,
        acked_at_ms: pass.acked_at_ms,
        confirmed_parts: pass.confirmed,
        waiting_bytes_parts: u32::try_from(pass.waiting_bytes.len()).unwrap_or(u32::MAX),
        need_bytes: pass.need,
    })
}

// ─── the snapshot ───────────────────────────────────────────────────────────

/// Every name a snapshot this device took is made of: its ranges and its
/// manifest.
fn names_of_snapshot(snapshot: &LedgerSnapshot) -> Result<BTreeSet<Name>> {
    let manifest = Manifest::from_json(snapshot.manifest_json.as_bytes()).map_err(plane_error)?;
    let mut names = manifest.range_names();
    names.insert(snapshot.name);
    Ok(names)
}

/// **A SNAPSHOT THE SHELL ASKED FOR IS OWED UNTIL ONE IS TAKEN** (#1080, the
/// Android emulator smoke). `wants_snapshot` arrives on the pass the app
/// leaving the screen runs, and a pass that reaches no gateway takes nothing;
/// the next pass is a background window's, which asks for none. The request
/// is kept in the ledger by [`run`] and spent here, so the window that next
/// reaches the gateway takes it — not the hour after the last head.
fn snapshot_owed(ledger: &Ledger) -> Result<bool> {
    Ok(ledger
        .meta(SNAPSHOT_OWED_KEY)
        .map_err(plane_error)?
        .is_some_and(|text| text == "1"))
}

/// How far ahead of this phone's clock a snapshot's date may read before it is not believed.
const CLOCK_TOLERANCE_MS: u64 = 5 * 60 * 1000;

/// Whether `taken_at_ms` is within the snapshot interval of `now`. **A date in the future
/// is not recent** (#1188, B11): a clock set ahead and corrected dated a snapshot after now,
/// and trusting it would have held the hourly snapshot off until the real date caught up.
fn recent(now: u64, taken_at_ms: u64) -> bool {
    taken_at_ms <= now.saturating_add(CLOCK_TOLERANCE_MS)
        && now.saturating_sub(taken_at_ms) < SNAPSHOT_EVERY_MS
}

/// Whether a snapshot is due. One the shell asked for (`wants_snapshot`,
/// kept until taken: [`snapshot_owed`]) always is; otherwise
/// one is due an hour after the newest a head named, and not while a younger
/// one is still on its way whole — every part of it queued or held; and one
/// is due at once at a gateway this phone has set no head at.
fn snapshot_due(ledger: &Ledger, gateway_id: &str, wanted: bool) -> Result<bool> {
    if wanted || ledger.rolled_back(gateway_id).map_err(plane_error)? {
        return Ok(true);
    }
    let now = now_ms();
    let snapshots = ledger.snapshots().map_err(plane_error)?;
    let head = ledger.head(gateway_id).map_err(plane_error)?;
    if let Some(newest) = snapshots.last()
        && head != Some(newest.name)
        && recent(now, newest.taken_at_ms)
    {
        let queued: BTreeSet<Name> = ledger
            .queued()
            .map_err(plane_error)?
            .iter()
            .map(|part| part.name)
            .collect();
        let confirmed = ledger.confirmed_names(gateway_id).map_err(plane_error)?;
        if names_of_snapshot(newest)?
            .iter()
            .all(|name| queued.contains(name) || confirmed.contains(name))
        {
            return Ok(false);
        }
    }
    // A GATEWAY THIS PHONE HAS SET NO HEAD AT — paired just now, or paired
    // again after it lost the vault — is owed the records on this pass, not
    // an hour after a head that another gateway, or another life of this one,
    // acknowledged.
    if ledger
        .head_acked(gateway_id)
        .map_err(plane_error)?
        .is_none()
    {
        return Ok(true);
    }
    // A HEAD THE GATEWAY NO LONGER HOLDS WHOLE — a range or its manifest a
    // reconcile found gone — is retaken now: until it is, the records the
    // status says are backed up do not restore.
    if let Some(head) = ledger.head(gateway_id).map_err(plane_error)?
        && let Some(taken) = snapshots.iter().find(|snapshot| snapshot.name == head)
    {
        let confirmed = ledger.confirmed_names(gateway_id).map_err(plane_error)?;
        if !names_of_snapshot(taken)?
            .iter()
            .all(|name| confirmed.contains(name))
        {
            return Ok(true);
        }
    }
    // THE HOUR RUNS FROM THE SNAPSHOT THIS GATEWAY'S OWN HEAD NAMES: another gateway being
    // current does not make this one so (#1188, B1).
    let last_set = super::records_at_gateway(ledger, gateway_id)?;
    Ok(last_set.is_none_or(|at| !recent(now, at)))
}

/// Copy the vault, describe it, ask every gateway what it holds of it, and spool the union
/// of what they lack: a part is sealed once and sent to each gateway that lacks it. The vault
/// is held to read where the copy comes from and not for the copy, which a reader of its own
/// makes in steps; the copy is deleted the moment the last range is spooled. A snapshot taken before this one that never reached a head is
/// forgotten, and its parts this one does not share leave the queue.
///
/// Answers the gateways whose own questions failed (by id), which the caller takes out of the
/// pass; the snapshot is spooled for the rest.
fn take_snapshot(
    handle: &Handle,
    keyring: &Keyring,
    plane: &Plane,
    ledger: &Ledger,
    spool: &Spool,
    stores: &[&GatewayStore],
    budget: u64,
) -> Result<Taken> {
    // A COPY A CRASH LEFT is the only thing that can be here: passes are one at a time
    // (`Handle`'s drain guard). The guard removes the directory on every way out of this
    // function, the error and the panic included.
    let scratch = Scratch::begin(plane.scratch_dir());
    // THE VAULT IS HELD FOR THIS READ ALONE; the copy runs on a reader of its own, in steps.
    let source = handle.with_vault(|vault| snapshot::source(vault).map_err(plane_error))?;
    if plane.free_bytes() < super::check::scratch_budget(source.len) {
        return Ok(Taken::NoRoom);
    }
    let (copied, stats) =
        snapshot::copy_from(&source, scratch.path(), &mut |_| Ok(())).map_err(plane_error)?;
    handle.note_copy(stats.pages);
    let outcome = (|| -> Result<Vec<(String, CoreError)>> {
        let taken = snapshot::describe(&copied, &keyring.backup, &keyring.vault_hex(), APP)
            .map_err(plane_error)?;
        let mut plans = Vec::with_capacity(stores.len());
        let mut failures = Vec::new();
        for store in stores {
            match snapshot::plan(&taken, *store) {
                Ok(planned) => {
                    snapshot::confirm_held(&taken, &planned, ledger, store.gateway_id(), now_ms())
                        .map_err(plane_error)?;
                    plans.push(planned);
                }
                Err(error) => failures.push((store.gateway_id().to_owned(), store_error_of(error))),
            }
        }
        if plans.is_empty() {
            return Ok(failures);
        }
        let planned = snapshot::union(&taken, &plans);
        let older: Vec<LedgerSnapshot> = ledger
            .snapshots()
            .map_err(plane_error)?
            .into_iter()
            .filter(|snapshot| snapshot.name != taken.manifest_name)
            .collect();
        snapshot::spool(
            &taken,
            &planned,
            spool,
            ledger,
            &keyring.backup,
            budget,
            now_ms(),
        )
        .map_err(plane_error)?;
        // THE COPY HOLDS THE VAULT IN THE CLEAR: it goes the moment the last range is spooled.
        scratch.clear();
        let mut keep = taken.manifest.range_names();
        keep.insert(taken.manifest_name);
        let queued: BTreeSet<Name> = ledger
            .queued()
            .map_err(plane_error)?
            .iter()
            .map(|part| part.name)
            .collect();
        for old in older {
            // WHAT THE NEWER SNAPSHOT SUPERSEDES IS NOT SENT: a gateway still behind is brought
            // to the new snapshot, never walked through the old ones.
            for name in names_of_snapshot(&old)?.difference(&keep) {
                if queued.contains(name) {
                    ledger.dequeue(name).map_err(plane_error)?;
                    spool.remove(name).map_err(plane_error)?;
                }
                if old.acked_ms.is_none() {
                    // A PART OF A SNAPSHOT THAT NEVER BECAME A HEAD is named by no kept
                    // snapshot, so retention's hold on unlive names (the sweep's F5) must not
                    // keep the copy a gateway already has: its grave is dated before every
                    // snapshot (#1080, S5).
                    ledger
                        .set_meta(&format!("{GRAVE_PREFIX}{}", name.to_hex()), "0")
                        .map_err(plane_error)?;
                }
            }
            if old.acked_ms.is_none() {
                ledger.forget_snapshot(&old.name).map_err(plane_error)?;
            }
        }
        Ok(failures)
    })();
    scratch.clear();
    outcome.map(Taken::Done)
}

/// What a pass found when it came to take a snapshot.
enum Taken {
    /// Taken and spooled; the gateways whose own questions failed, by id.
    Done(Vec<(String, CoreError)>),
    /// This phone has too little free space to copy its vault.
    NoRoom,
}

/// The ledger's `meta` key that says the last snapshot could not be taken for want of room.
pub(super) const NO_ROOM_KEY: &str = "pass.no_room";

/// **THE SCRATCH COPY'S KEEPER.** The directory goes when this is dropped, so no way out of a pass —
/// an error, a panic, an early return — leaves the vault in the clear on disk; a crash is the one
/// way left, and the next core open removes what it left (`Plane::spool`).
pub(super) struct Scratch(PathBuf);

impl Scratch {
    /// Clear whatever is at `dir` and keep it.
    pub(super) fn begin(dir: PathBuf) -> Self {
        let _ = std::fs::remove_dir_all(&dir);
        Self(dir)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }

    /// Remove the directory now.
    pub(super) fn clear(&self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Whether the vault shows what the newest snapshot was taken from and every gateway in the pass
/// holds that snapshot whole under its head: nothing a copy could add.
fn newest_stands(handle: &Handle, ledger: &Ledger, live: &[&Reached]) -> Result<Option<u64>> {
    let all = ledger.snapshots().map_err(plane_error)?;
    let Some(newest) = all.last() else {
        return Ok(None);
    };
    // A SNAPSHOT THIS PHONE NEVER SAW ACKNOWLEDGED (a restore's) is not one it stands on.
    if newest.acked_ms.is_none() {
        return Ok(None);
    }
    let manifest = Manifest::from_json(newest.manifest_json.as_bytes()).map_err(plane_error)?;
    let names = names_of_snapshot(newest)?;
    let mut oldest: Option<u64> = None;
    for reached in live {
        let id = reached.store.gateway_id();
        let confirmed = ledger.confirmed_names(id).map_err(plane_error)?;
        // A GATEWAY THIS PHONE HAS SET NO HEAD AT (a restored phone's first pass) is owed one.
        if ledger.rolled_back(id).map_err(plane_error)?
            || super::records_at_gateway(ledger, id)?.is_none()
            || ledger.head(id).map_err(plane_error)? != Some(newest.name)
            || !names.iter().all(|name| confirmed.contains(name))
        {
            return Ok(None);
        }
        // THE GATEWAY'S OWN TIME for the head it already holds: what a pass that copied nothing answers.
        let acked = ledger.head_acked(id).map_err(plane_error)?;
        oldest = match (oldest, acked) {
            (Some(held), Some(at)) => Some(held.min(at)),
            (held, at) => held.or(at),
        };
    }
    let same =
        handle.with_vault(|vault| snapshot::unchanged(vault, &manifest).map_err(plane_error))?;
    Ok(if same { oldest } else { None })
}

/// A plane error from one gateway's question, as the pass's error for that gateway.
fn store_error_of(error: centraid_vault::backup::PlaneError) -> CoreError {
    match error {
        centraid_vault::backup::PlaneError::Store(error) => store_error(error),
        other => plane_error(other),
    }
}

/// Move the head to the newest snapshot that is not the head yet, once every
/// part of it is confirmed at `store`; and when it moves, let retention drop
/// what it no longer keeps.
fn settle_newest(
    ledger: &Ledger,
    store: &GatewayStore,
    keyring: &Keyring,
    files: &[ContentFile],
    now: u64,
    pass: &mut Pass,
) -> Result<()> {
    // THE NEWEST SNAPSHOT THIS GATEWAY'S HEAD DOES NOT NAME YET: each gateway is settled
    // on its own (#1188, B1), whatever another's head says.
    let head = ledger.head(store.gateway_id()).map_err(plane_error)?;
    let rolled = ledger
        .rolled_back(store.gateway_id())
        .map_err(plane_error)?;
    // THE ONE IN FLIGHT FIRST, then the newest: a snapshot no gateway has set is the one this
    // phone took last, whatever date its clock gave it (#1188, B11).
    let all = ledger.snapshots().map_err(plane_error)?;
    let Some(newest) = all
        .iter()
        .rfind(|snapshot| snapshot.acked_ms.is_none())
        .or_else(|| all.last())
        // A GATEWAY WHOSE HEAD WENT BACKWARDS is set again, whatever the ledger remembers (B4).
        .filter(|snapshot| rolled || head != Some(snapshot.name))
        .cloned()
    else {
        return Ok(());
    };
    let manifest = Manifest::from_json(newest.manifest_json.as_bytes()).map_err(plane_error)?;
    match snapshot::settle(ledger, store, &newest.name, &manifest, &SystemClock)
        .map_err(plane_error)?
    {
        Settled::HeadSet(head) => {
            ledger
                .set_head_acked(store.gateway_id(), head.set_at_ms)
                .map_err(plane_error)?;
            pass.acked_at_ms = i64::try_from(head.set_at_ms).ok();
            retain(ledger, store, &keyring.backup, files, now)?;
        }
        Settled::Waiting { unconfirmed } => {
            tracing::debug!(
                waiting = unconfirmed.len(),
                "the snapshot waits on parts not yet acknowledged"
            );
        }
        Settled::Conflict { current } => {
            tracing::warn!(
                ?current,
                "the gateway's head is not where this phone left it; the head did not move"
            );
        }
    }
    Ok(())
}

/// A kept snapshot's manifest: from the ledger when this device took it, else
/// fetched and opened — a snapshot an earlier phone took before a restore.
fn manifest_of(
    ledger: &Ledger,
    store: &GatewayStore,
    keys: &BackupKeys,
    name: &Name,
) -> Result<Manifest> {
    if let Some(taken) = ledger
        .snapshots()
        .map_err(plane_error)?
        .into_iter()
        .find(|snapshot| snapshot.name == *name)
    {
        return Manifest::from_json(taken.manifest_json.as_bytes()).map_err(plane_error);
    }
    let mut sealed_bytes = Vec::new();
    store.get(name, &mut sealed_bytes).map_err(store_error)?;
    let json =
        sealed::open_whole(keys, name, &sealed_bytes).map_err(|error| CoreError::Invariant {
            context: format!("a kept snapshot's manifest would not open: {error}"),
        })?;
    Manifest::from_json(&json).map_err(plane_error)
}

/// A name retention is holding back, in the ledger's `meta`: the moment this
/// phone first saw it unlive (the sweep's F5).
const GRAVE_PREFIX: &str = "grave:";

/// **Retention, then garbage** (#1080, "Retention"): keep 7 daily, 4 weekly
/// and 6 monthly snapshots; when that drops one, delete every name nothing
/// kept refers to — the kept manifests and their ranges, every name the
/// vault's content implies, and everything still on its way.
///
/// **A FILE THE VAULT DELETED STAYS WHILE A KEPT SNAPSHOT MAY NAME IT** (the
/// sweep's F5; F4's second half). The snapshot history protects records, and
/// a restore of an older snapshot needs the files its rows name — including,
/// after a stale phone took the vault over with an older copy, the files the
/// newer phone backed up, which the older copy does not name. A name that is
/// neither live nor a dropped snapshot's own range is held until every kept
/// snapshot was taken after this phone first saw it unlive
/// ([`retention::collectable`]); a dropped snapshot's manifest and ranges are
/// garbage at once, since they are the history, not what it names.
fn retain(
    ledger: &Ledger,
    store: &GatewayStore,
    keys: &BackupKeys,
    files: &[ContentFile],
    now: u64,
) -> Result<()> {
    let registered = store.snapshots().map_err(store_error)?;
    let decided = retention::keep(&registered, now);
    if decided.drop.is_empty() {
        return Ok(());
    }
    // WHAT A DROPPED SNAPSHOT IS MADE OF — its manifest and its ranges — is
    // garbage the moment it goes. Read before the manifest is deleted; one
    // that will not open leaves its ranges to wait with the other garbage.
    let mut promptly: BTreeSet<Name> = decided.drop.iter().copied().collect();
    for name in &decided.drop {
        match manifest_of(ledger, store, keys, name) {
            Ok(manifest) => promptly.extend(manifest.range_names()),
            Err(error @ CoreError::Unavailable { .. }) => return Err(error),
            Err(error) => tracing::warn!(
                %error,
                "a dropped snapshot's manifest would not open; its ranges wait with the rest"
            ),
        }
    }
    let dropped = plane_store::delete_all(store, &decided.drop).map_err(store_error)?;
    for name in &decided.drop {
        ledger.forget_snapshot(name).map_err(plane_error)?;
    }
    let mut live: BTreeSet<Name> = BTreeSet::new();
    for name in &decided.keep {
        live.insert(*name);
        live.extend(manifest_of(ledger, store, keys, name)?.range_names());
    }
    for part in ledger.queued().map_err(plane_error)? {
        live.insert(part.name);
    }
    // A SNAPSHOT NEWER THAN THIS GATEWAY'S HEAD IS ON ITS WAY TO IT (or to another gateway):
    // whatever of it the gateway already holds is not garbage yet.
    let head_taken = ledger.head_taken(store.gateway_id()).map_err(plane_error)?;
    for snapshot in ledger.snapshots().map_err(plane_error)? {
        if snapshot.acked_ms.is_none() || head_taken.is_none_or(|at| snapshot.taken_at_ms > at) {
            live.extend(names_of_snapshot(&snapshot)?);
        }
    }
    let live = retention::live_names(keys, live, files.iter().map(|file| (file.h, file.len)));
    let listed = plane_store::list_all(store).map_err(store_error)?;
    let garbage = retention::garbage(listed.iter().map(|entry| entry.name), &live);

    // THE OLDEST SNAPSHOT STILL KEPT, on the clock snapshots are dated by.
    let kept_taken: Vec<u64> = decided
        .keep
        .iter()
        .filter_map(|kept| registered.iter().find(|entry| entry.name == *kept))
        .map(|entry| entry.taken_at_ms)
        .collect();
    let graves: BTreeMap<String, u64> = ledger
        .meta_with_prefix(GRAVE_PREFIX)
        .map_err(plane_error)?
        .into_iter()
        .filter_map(|(key, value)| Some((key, value.parse().ok()?)))
        .collect();
    let grave_of = |name: &Name| format!("{GRAVE_PREFIX}{}", name.to_hex());
    let mut doomed: Vec<Name> = Vec::new();
    let mut held_back = 0_usize;
    let mut unlive: BTreeSet<String> = BTreeSet::new();
    for name in garbage {
        if promptly.contains(&name) {
            doomed.push(name);
            continue;
        }
        let key = grave_of(&name);
        let first = match graves.get(&key) {
            Some(first) => *first,
            None => {
                ledger
                    .set_meta(&key, &now.to_string())
                    .map_err(plane_error)?;
                now
            }
        };
        unlive.insert(key);
        if retention::collectable_among(first, &kept_taken, now) {
            doomed.push(name);
        } else {
            held_back += 1;
        }
    }
    // A NAME THAT IS LIVE AGAIN (the same bytes added back) or gone from the
    // listing is no longer being held back: its mark would otherwise date a
    // later leaving from the wrong day.
    for key in graves.keys().filter(|key| !unlive.contains(*key)) {
        ledger.forget_meta(key).map_err(plane_error)?;
    }
    let deleted = plane_store::delete_all(store, &doomed).map_err(store_error)?;
    for name in &deleted.deleted {
        ledger.forget_meta(&grave_of(name)).map_err(plane_error)?;
    }
    // WHAT THE GATEWAY DELETED IS NOT HELD THERE ANY MORE, so the ledger — a
    // cache of the gateway's truth (#1080 ruling 7) — stops confirming it now
    // rather than at the next launch's reconcile.
    let gone: Vec<Name> = dropped
        .deleted
        .iter()
        .chain(&deleted.deleted)
        .copied()
        .collect();
    ledger
        .unconfirm_many(&gone, store.gateway_id())
        .map_err(plane_error)?;
    tracing::info!(
        dropped = decided.drop.len(),
        collected = deleted.deleted.len(),
        held_back,
        "retention dropped snapshots and collected what nothing kept"
    );
    Ok(())
}

// ─── the media ──────────────────────────────────────────────────────────────

/// One gateway's side of a pass's media rounds, and what a pass works out once for it: the
/// names it holds, the files it still lacks something of, and the names already asked of it.
struct Feed<'a> {
    reached: &'a Reached,
    /// Set when the gateway has had its last round: it finished, or left the pass.
    finished: bool,
    /// The names this gateway holds, read once and kept current by what its rounds confirm.
    confirmed: Option<BTreeSet<Name>>,
    /// The files with a part this gateway does not hold. Only ever shrinks in a pass.
    todo: Option<Vec<&'a ContentFile>>,
    /// Each name once a pass: asked of this gateway already.
    asked: BTreeSet<Name>,
}

impl<'a> Feed<'a> {
    fn new(reached: &'a Reached) -> Self {
        Self {
            reached,
            finished: false,
            confirmed: None,
            todo: None,
            asked: BTreeSet::new(),
        }
    }
}

/// The part names of each file, worked out once a pass: a name is a keyed hash, and a library of
/// ninety thousand files would otherwise have them hashed again every round.
#[derive(Default)]
struct NameCache {
    names: BTreeMap<[u8; 32], Vec<Name>>,
}

impl NameCache {
    fn of(&mut self, keys: &BackupKeys, file: &ContentFile) -> &[Name] {
        self.names
            .entry(*file.h.as_bytes())
            .or_insert_with(|| names_of(keys, &file.h, file.len))
    }
}

/// One bounded round for one gateway: seal what fits the spool, move it. `Continue` when more
/// remains (another round is owed), `Stop` when the gateway left the pass; a gateway whose
/// round sealed and moved nothing is finished.
#[allow(clippy::too_many_arguments)]
fn media_round<'a>(
    feed: &mut Feed<'a>,
    files: &'a [ContentFile],
    ledger: &Ledger,
    spool: &Spool,
    keys: &BackupKeys,
    bytes: Option<&centraid_blobs::ByteStore>,
    conditions: &Conditions,
    budget: u64,
    deadline: Instant,
    reachable: &[String],
    pass: &mut Pass,
) -> Result<Flow> {
    if spool.bytes().map_err(plane_error)? >= budget {
        // THE SPOOL IS FULL OF PARTS A GATEWAY THAT DID NOT ANSWER STILL OWES: the
        // room is needed more than the wait.
        mover::release_to_reachable(ledger, spool, reachable).map_err(plane_error)?;
    }
    let sealed = prepare(
        files, feed, ledger, spool, keys, bytes, conditions, budget, deadline, pass,
    )?;
    if Instant::now() >= deadline {
        pass.stopped = wire::DrainStop::Deadline;
        return Ok(Flow::Stop);
    }
    let store = &feed.reached.store;
    let moved = mover::move_queue_where(ledger, spool, store, deadline, &SystemClock, &|part| {
        let kind = Kind::of_part(part);
        part.handed_off_ms.is_none() && kind != Kind::Records && conditions.may_move(kind)
    })
    .map_err(plane_error)?;
    pass.count(moved.confirmed.len());
    pass.media_confirmed = pass.media_confirmed.saturating_add(moved.confirmed.len());
    if let Some(held) = feed.confirmed.as_mut() {
        held.extend(moved.confirmed.iter().copied());
    }
    if pass.stopped_by(&moved.stopped)? {
        return Ok(Flow::Stop);
    }
    // A ROUND THAT MOVED PARTS FREED ROOM, so one more prepare asks for the next window of a
    // library item larger than the spool (R-1080-C39) before the pass answers; a round that
    // did neither is the end.
    if sealed == 0 && moved.confirmed.is_empty() {
        feed.finished = true;
        pass.fed += 1;
    }
    Ok(Flow::Continue)
}

/// Seal what no gateway holds of the vault's files into the spool, up to its
/// budget: derivatives first, the grid, then originals, newest first within
/// each. Answers how many parts were sealed.
#[allow(clippy::too_many_arguments)]
fn prepare<'a>(
    files: &'a [ContentFile],
    feed: &mut Feed<'a>,
    ledger: &Ledger,
    spool: &Spool,
    keys: &BackupKeys,
    bytes: Option<&centraid_blobs::ByteStore>,
    conditions: &Conditions,
    budget: u64,
    deadline: Instant,
    pass: &mut Pass,
) -> Result<usize> {
    let reached = feed.reached;
    let store = &reached.store;
    // WHAT THIS GATEWAY HOLDS, not what any does: every gateway is a full replica (#1188, B1).
    // Read once a pass; its rounds keep it current.
    if feed.confirmed.is_none() {
        feed.confirmed = Some(
            ledger
                .confirmed_names(store.gateway_id())
                .map_err(plane_error)?,
        );
    }
    let confirmed = feed.confirmed.get_or_insert_with(BTreeSet::new);
    let queued: BTreeSet<Name> = ledger
        .queued()
        .map_err(plane_error)?
        .iter()
        .map(|part| part.name)
        .collect();
    // ASK ABOUT EVERYTHING THE MEMBER BACKS UP, SEAL ONLY WHAT THE RULE
    // ALLOWS NOW. Asking moves no bytes, so it is not the rule's to withhold:
    // a restored phone whose first pass runs off the charger may not seal a
    // video, and must still learn the gateway holds it — or the line says
    // "waiting for a charger" for a film this phone does not even hold
    // (#1080, the simulator restore). The files lacking a part are worked out once and only
    // shrink, so a round looks at what is left and not at the whole library.
    let todo = feed.todo.get_or_insert_with(|| files.iter().collect());
    todo.retain(|file| {
        conditions.counts(Kind::of_file(file))
            && pass
                .names
                .of(keys, file)
                .iter()
                .any(|name| !confirmed.contains(name))
    });
    let wanted = |names: &mut NameCache, file: &ContentFile, confirmed: &BTreeSet<Name>| {
        names
            .of(keys, file)
            .iter()
            .copied()
            .zip(0_u32..)
            .filter(|(name, _)| !confirmed.contains(name) && !queued.contains(name))
            .map(|(name, index)| (index, name))
            .collect::<Vec<(u32, Name)>>()
    };
    let unconfirmed: Vec<&'a ContentFile> = todo
        .iter()
        .copied()
        .filter(|file| !wanted(&mut pass.names, file, confirmed).is_empty())
        .collect();

    // ASK BEFORE SEALING (#1080 ruling 7): a name the gateway holds is
    // confirmed from its answer, never sealed again. Each name once a pass,
    // per gateway.
    let mut ask: Vec<Name> = Vec::new();
    let mut sizes: BTreeMap<Name, u64> = BTreeMap::new();
    for file in &unconfirmed {
        for (_, name) in wanted(&mut pass.names, file, confirmed) {
            if feed.asked.insert(name) {
                ask.push(name);
                sizes.insert(name, file.len);
            }
        }
    }
    if !ask.is_empty() {
        pass.asks += ask.len();
        let missing = plane_store::missing(store, &ask).map_err(store_error)?;
        let held: Vec<(Name, u64)> = ask
            .iter()
            .filter(|name| !missing.contains(name))
            .map(|name| (*name, sizes.get(name).copied().unwrap_or(0)))
            .collect();
        ledger
            .confirm_many(&held, store.gateway_id(), now_ms())
            .map_err(plane_error)?;
        confirmed.extend(held.iter().map(|(name, _)| *name));
        pass.media_confirmed = pass.media_confirmed.saturating_add(held.len());
    }
    let unconfirmed: Vec<&ContentFile> = unconfirmed
        .into_iter()
        .filter(|file| !wanted(&mut pass.names, file, confirmed).is_empty())
        .collect();

    let mut candidates: Vec<&ContentFile> = unconfirmed
        .into_iter()
        .filter(|file| conditions.may_prepare(Kind::of_file(file)))
        .collect();
    // DERIVATIVES FIRST: they are kilobytes and they are the grid. The sort
    // is stable, so each half stays newest first.
    candidates.sort_by_key(|file| file.variant.is_none());

    let mut held_bytes = spool
        .bytes()
        .map_err(plane_error)?
        .saturating_add(pass.promised);
    let mut sealed = 0_usize;
    let mut library: Vec<LibraryAsk<'_>> = Vec::new();
    for file in candidates {
        store.checkpoint()?;
        if Instant::now() >= deadline {
            break;
        }
        let parts = wanted(&mut pass.names, file, confirmed);
        if parts.is_empty() {
            continue;
        }
        let content = centraid_blobs::ContentHash::from_bytes(*file.h.as_bytes());
        let path = bytes
            .map(|store| store.path_of(content))
            .transpose()
            .map_err(|error| CoreError::Invariant {
                context: format!("the content store: {error}"),
            })?
            .flatten();
        if let Some(path) = path {
            if held_bytes >= budget {
                continue;
            }
            let indices: BTreeSet<u32> = parts.iter().map(|(index, _)| *index).collect();
            sealed += seal_store_file(
                &path,
                store,
                file,
                &indices,
                keys,
                spool,
                ledger,
                budget,
                deadline,
                pass.free,
                &mut held_bytes,
            )?;
            continue;
        }
        let local = ledger.local(&file.h).map_err(plane_error)?;
        if let Some(local) = local.filter(|local| local.source == LocalSource::Os) {
            let first = pass
                .names
                .of(keys, file)
                .first()
                .copied()
                .unwrap_or_else(|| part_name(keys, &file.h, 0));
            pass.waiting_bytes.insert(first);
            if let Some(os_ref) = local.os_ref.filter(|os_ref| !os_ref.is_empty()) {
                library.push(LibraryAsk {
                    file,
                    os_ref,
                    parts: parts.iter().map(|(index, _)| *index).collect(),
                });
            }
        }
        // NOWHERE ON THIS PHONE: a restored phone that has not fetched an
        // original, or bytes a member released. Nothing here can send them.
    }
    plan_library(
        &library,
        budget.saturating_sub(held_bytes),
        (held_bytes == 0).then_some(pass.free),
        pass,
    );
    Ok(sealed)
}

/// One library item a pass could ask the shell to stream.
struct LibraryAsk<'a> {
    file: &'a ContentFile,
    os_ref: String,
    /// The parts no gateway holds and nothing queued, ascending.
    parts: Vec<u32>,
}

/// **Ask for the library items the spool has room for** (`NeedBytes`,
/// R-1080-C39): each that fits whole, in the order given; then the first that
/// did not, for as many of its parts as the room the others left will hold.
/// An item is asked for only when at least one of its parts fits, so a shell
/// never reads an item the stage door could only hash. What is asked for is
/// promised, so a later round of the same pass cannot spend it before the
/// shell streams.
fn plan_library(
    asks: &[LibraryAsk<'_>],
    mut room: u64,
    empty_spool_free: Option<u64>,
    pass: &mut Pass,
) {
    let mut larger: Option<&LibraryAsk<'_>> = None;
    for ask in asks {
        if pass.need.len() >= MAX_NEED_BYTES {
            return;
        }
        if pass.has_asked(ask) {
            continue;
        }
        let whole = bytes_of_parts(ask.file.len, &ask.parts);
        if whole <= room {
            room -= whole;
            pass.ask_for(ask, ask.parts.clone());
        } else if larger.is_none() {
            // THE FIRST ITEM LARGER THAN THE ROOM waits for what the rest
            // leave, so photographs keep moving past a film.
            larger = Some(ask);
        }
    }
    if let Some(ask) = larger {
        let window = window_within(room, ask.file.len, &ask.parts, empty_spool_free);
        if !window.is_empty() {
            pass.ask_for(ask, window);
        }
    }
}

/// Seal the parts `indices` of a file the app's own store holds, one part at
/// a time straight into the spool: the file's hash is known, so every part's
/// name is too, and a film larger than the spool is sealed a part at a time
/// as the mover drains it. Answers how many parts were sealed.
#[allow(clippy::too_many_arguments)]
fn seal_store_file(
    path: &std::path::Path,
    store: &GatewayStore,
    file: &ContentFile,
    indices: &BTreeSet<u32>,
    keys: &BackupKeys,
    spool: &Spool,
    ledger: &Ledger,
    budget: u64,
    deadline: Instant,
    free: u64,
    held_bytes: &mut u64,
) -> Result<usize> {
    let invariant = |what: &str, error: &dyn std::fmt::Display| CoreError::Invariant {
        context: format!("sealing {} ({what}): {error}", file.h),
    };
    let mut reader = File::open(path).map_err(|error| invariant("open", &error))?;
    let actual = reader
        .metadata()
        .map_err(|error| invariant("measure", &error))?
        .len();
    if actual != file.len {
        // THE STORE NAMES A FILE BY ITS BYTES, and the vault's row disagrees
        // about how many there are: the names would be wrong, so nothing is
        // sealed under them.
        tracing::warn!(
            content = %file.h,
            held = actual,
            row = file.len,
            "a stored file is not the length its row names; it is not sealed"
        );
        return Ok(0);
    }
    let kind = Kind::of_file(file).part_kind();
    let mut buffer = vec![0_u8; READ_CHUNK];
    let mut sealed = 0;
    for index in 0..part_count(file.len) {
        store.checkpoint()?;
        let len = sealed::part_len(file.len, index).map_err(|error| invariant("cut", &error))?;
        if !indices.contains(&index) {
            reader
                .seek(SeekFrom::Current(i64::try_from(len).unwrap_or(i64::MAX)))
                .map_err(|error| invariant("seek", &error))?;
            continue;
        }
        // THE SPOOL NEVER HOLDS MORE THAN ITS BUDGET: a part that would pass
        // it waits for the room the mover frees (`Spool`'s "admits").
        if Instant::now() >= deadline
            || !centraid_vault::backup::spool::admits_on(*held_bytes, len, budget, free)
        {
            break;
        }
        let name = part_name(keys, &file.h, index);
        let writer = spool.writer(&name).map_err(plane_error)?;
        let mut sealer = PartSealer::new(keys, index, len, false, writer)
            .map_err(|error| invariant("begin", &error))?;
        let mut left = len;
        while left > 0 {
            store.checkpoint()?;
            let take = usize::try_from(left.min(READ_CHUNK as u64)).unwrap_or(READ_CHUNK);
            reader
                .read_exact(&mut buffer[..take])
                .map_err(|error| invariant("read", &error))?;
            sealer
                .update(&buffer[..take])
                .map_err(|error| invariant("seal", &error))?;
            left -= take as u64;
        }
        let (writer, seal) = sealer
            .finish()
            .map_err(|error| invariant("finish", &error))?;
        let part_path = writer.finish().map_err(plane_error)?;
        ledger
            .enqueue(&Queued {
                name,
                part_path,
                size: seal.len,
                digest: seal.digest,
                kind,
                media_type: Some(file.media_type.clone()),
                created_ms: now_ms(),
                handed_off_ms: None,
                attempts: 0,
                last_error: None,
            })
            .map_err(plane_error)?;
        *held_bytes = held_bytes.saturating_add(seal.len);
        sealed += 1;
    }
    Ok(sealed)
}

/// Queue the parts the stage door sealed beside a library item's stream
/// (the root's ruling A8): each one no gateway holds and nothing queued yet is
/// moved to its name in the spool and queued as an original's; the rest are
/// dropped. Answers how many were queued.
///
/// # Errors
/// The ledger's or the spool's refusal.
pub fn queue_sealed(
    spool: &Spool,
    ledger: &Ledger,
    sealed: &sealed::FileSeal,
    media_type: &str,
) -> Result<usize> {
    let queued: BTreeSet<Name> = ledger
        .queued()
        .map_err(plane_error)?
        .iter()
        .map(|part| part.name)
        .collect();
    let mut count = 0;
    for part in &sealed.parts {
        // A PART IS KEPT WHILE ANY PAIRED GATEWAY LACKS IT (#1188, B1).
        let owed = !ledger.owing(&part.name).map_err(plane_error)?.is_empty();
        if !owed || queued.contains(&part.name) {
            let _ = std::fs::remove_file(&part.path);
            continue;
        }
        let part_path = spool.adopt(&part.path, &part.name).map_err(plane_error)?;
        ledger
            .enqueue(&Queued {
                name: part.name,
                part_path,
                size: part.len,
                digest: part.digest,
                kind: PartKind::Original,
                media_type: Some(media_type.to_owned()),
                created_ms: now_ms(),
                handed_off_ms: None,
                attempts: 0,
                last_error: None,
            })
            .map_err(plane_error)?;
        count += 1;
    }
    Ok(count)
}

// ─── the operating system's half ────────────────────────────────────────────

/// **Hand sealed parts to the operating system** (`handoff`, #1080 ruling 2).
///
/// A batch of queued parts nobody is moving, in queue order, each as a
/// presigned `PUT` to the gateway this phone reached last, and each marked
/// handed off. A video's original is left out when the member left videos
/// out; every other part goes, with `allows_cellular` saying whether the
/// operating system may move it over a metered link.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a zero limit; [`CoreError::VaultMoved`]
/// for a phone a gateway superseded; the ledger's refusal.
pub fn handoff(
    plane: &Plane,
    keyring: &Keyring,
    request: &wire::HandoffRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::HandoffResponse> {
    if request.max_bytes == 0 || request.max_parts == 0 {
        return Err(CoreError::InvalidRequest {
            detail: "a handoff names both limits; a zero is never read as \"no limit\"".to_owned(),
        });
    }
    let ledger = plane.ledger()?;
    if let Some((_, epoch)) = super::moved(&ledger)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    // EACH PART GOES TO A GATEWAY THAT STILL OWES IT (#1188, B1), the one reached last first:
    // the one `reconcile` just answered from.
    let mut ordered: Vec<(usize, Destination)> = ledger
        .destinations()
        .map_err(plane_error)?
        .into_iter()
        .enumerate()
        .collect();
    ordered.sort_by_key(|(order, destination)| {
        (
            std::cmp::Reverse(destination.last_seen_ms.unwrap_or(0)),
            *order,
        )
    });
    if ordered.is_empty() {
        return Ok(wire::HandoffResponse { parts: Vec::new() });
    }
    let conditions = Conditions::remembered(&ledger)?;
    let mut stores: BTreeMap<String, GatewayStore> = BTreeMap::new();
    let vault_hex = keyring.vault_hex();
    let max_parts = usize::try_from(request.max_parts).unwrap_or(usize::MAX);
    let mut parts = Vec::new();
    let mut bytes = 0_u64;
    for part in ledger.queued().map_err(plane_error)? {
        if parts.len() >= max_parts {
            break;
        }
        let kind = Kind::of_part(&part);
        if part.handed_off_ms.is_some() || !conditions.counts(kind) {
            continue;
        }
        if bytes.saturating_add(part.size) > request.max_bytes {
            break;
        }
        let owing = ledger.owing(&part.name).map_err(plane_error)?;
        let Some((_, target)) = ordered
            .iter()
            .find(|(_, destination)| owing.contains(&destination.gateway_id))
        else {
            continue;
        };
        if !stores.contains_key(&target.gateway_id) {
            stores.insert(
                target.gateway_id.clone(),
                GatewayStore::for_destination(target, keyring.vault_id(), runtime)?,
            );
        }
        let store = &stores[&target.gateway_id];
        let presigned = store
            .client()
            .presign_put(
                store.vault(),
                &link::wire_name(&part.name),
                &centraid_gateway::rules::ids::Digest::from_bytes(*part.digest.as_bytes()),
                part.size,
            )
            .map_err(|error| CoreError::Invariant {
                context: format!("presigning a part: {error}"),
            })?;
        ledger.hand_off(&part.name, now_ms()).map_err(plane_error)?;
        bytes = bytes.saturating_add(part.size);
        parts.push(wire::HandoffPart {
            name: part.name.to_hex(),
            path: part.part_path.to_string_lossy().into_owned(),
            url: presigned.url,
            method: presigned.method,
            headers: presigned
                .headers
                .into_iter()
                .map(|(name, value)| wire::Header { name, value })
                .collect(),
            size: part.size,
            gateway_id: target.gateway_id.clone(),
            vault_id: vault_hex.clone(),
            allows_cellular: allows_cellular(kind, conditions.rule),
        });
    }
    Ok(wire::HandoffResponse { parts })
}

/// **Record what the operating system reported** (`settle`, #1080 ruling 7).
///
/// A `2xx` is the gateway's acknowledgement, and so is `NAME_TAKEN` (the same
/// bytes sealed again, R-1080-B4): the part is confirmed and leaves the spool.
/// `DIGEST_MISMATCH` is a torn spool file: the part leaves the queue to be
/// sealed again. `MOVED` freezes this phone. Anything else puts the part back
/// in the queue. A name the queue does not hold, or a part for another vault,
/// is ignored and not counted (the root's ruling A6).
///
/// # Errors
/// The ledger's or the spool's refusal.
pub fn settle(
    plane: &Plane,
    keyring: &Keyring,
    request: &wire::SettleRequest,
) -> Result<wire::SettleResponse> {
    let ledger = plane.ledger()?;
    let spool = plane.spool()?;
    let mine = keyring.vault_hex();
    let mut answer = wire::SettleResponse::default();
    let mut files_confirmed = false;
    for settled in &request.settled {
        if !settled.vault_id.is_empty() && settled.vault_id != mine {
            continue;
        }
        let Ok(name) = Name::from_hex(&settled.name) else {
            continue;
        };
        let Some(part) = ledger.queued_part(&name).map_err(plane_error)? else {
            continue;
        };
        let destination = ledger
            .destination(&settled.gateway_id)
            .map_err(plane_error)?;
        // THE OPERATING SYSTEM WAS TOLD NO BY A GATEWAY THAT DOES NOT KNOW
        // THIS PHONE'S TOKEN (the sweep's F2): marked as a pass would mark it,
        // so the status says to pair again whichever half met the refusal.
        if let Some(refusing) = &destination
            && (settled.http_status == 401 || settled.error == "UNAUTHORIZED")
        {
            mark_token_refused(&ledger, &refusing.gateway_id)?;
        }
        let acknowledged = matches!(settled.http_status, 200 | 201)
            || (settled.http_status == 409 && settled.error == "NAME_TAKEN");
        match destination {
            Some(destination) if acknowledged => {
                ledger
                    .confirm(&name, &destination.gateway_id, now_ms(), part.size)
                    .map_err(plane_error)?;
                mover::release(&ledger, &spool, &part, now_ms(), true).map_err(plane_error)?;
                answer.confirmed += 1;
                files_confirmed |= Kind::of_part(&part) != Kind::Records;
            }
            Some(_) if settled.error == "DIGEST_MISMATCH" => {
                ledger.dequeue(&name).map_err(plane_error)?;
                spool.remove(&name).map_err(plane_error)?;
                answer.requeued += 1;
            }
            Some(destination) if settled.error == "MOVED" => {
                // THE EPOCH THAT SUPERSEDED THIS PHONE IS AT LEAST THE NEXT
                // ONE; the next write's refusal names it exactly.
                ledger
                    .set_moved(&destination.gateway_id, destination.epoch.saturating_add(1))
                    .map_err(plane_error)?;
                ledger.requeue(&name, "MOVED").map_err(plane_error)?;
                answer.requeued += 1;
            }
            // A GATEWAY THIS PHONE NO LONGER KNOWS, or any other outcome: the
            // part goes back to waiting, for a gateway that is paired.
            _ => {
                let reason = if settled.error.is_empty() {
                    format!("HTTP_{}", settled.http_status)
                } else {
                    settled.error.clone()
                };
                ledger.requeue(&name, &reason).map_err(plane_error)?;
                answer.requeued += 1;
            }
        }
    }
    // FILES THE OPERATING SYSTEM CONFIRMED ARE FILES A PASS DID NOT (R-1080-C15):
    // their rows are in no snapshot yet, so the next pass that may carry the
    // records takes one first, as it does for a pass that was cut off.
    if files_confirmed {
        owe_a_snapshot(&ledger)?;
    }
    Ok(answer)
}

/// The next pass that reaches a gateway takes a snapshot first
/// ([`snapshot_owed`]).
fn owe_a_snapshot(ledger: &Ledger) -> Result<()> {
    ledger.set_meta(SNAPSHOT_OWED_KEY, "1").map_err(plane_error)
}

/// **Square the ledger with what a gateway holds** (`reconcile`, #1080
/// ruling 7), at the first paired gateway that answers.
///
/// Every queued name the gateway already holds is confirmed and leaves the
/// spool; with `full` — the first reconcile of a core's life, "on every
/// launch" — every name confirmed there is asked about too, and one it no
/// longer holds is unconfirmed, to be prepared again. A part handed to the
/// operating system longer ago than [`HANDOFF_GRACE_MS`] that the gateway does
/// not hold goes back in the queue.
///
/// # Errors
/// The ledger's or the spool's refusal. A gateway that stops answering
/// mid-way is `reachable: false`, never an error.
pub fn reconcile(
    plane: &Plane,
    keyring: &Keyring,
    runtime: &tokio::runtime::Handle,
    full: bool,
) -> Result<wire::ReconcileResponse> {
    let ledger = plane.ledger()?;
    let spool = plane.spool()?;
    let unreachable = wire::ReconcileResponse {
        confirmed: 0,
        requeued: 0,
        reachable: false,
    };
    if super::moved(&ledger)?.is_some() {
        return Ok(unreachable);
    }
    let destinations = ledger.destinations().map_err(plane_error)?;
    let Ok(reached) = link::reach(&destinations, &ledger, keyring.vault_id(), runtime)? else {
        return Ok(unreachable);
    };
    let reconciled = if full {
        mover::reconcile(&ledger, &spool, &reached.store, &SystemClock)
    } else {
        mover::reconcile_queue(&ledger, &spool, &reached.store, &SystemClock)
    };
    let reconciled = match reconciled {
        Ok(reconciled) => reconciled,
        Err(centraid_vault::backup::PlaneError::Store(error)) => {
            tracing::debug!(%error, "the gateway stopped answering mid-reconcile");
            if matches!(error, StoreError::Refused(Refusal::Unauthorized)) {
                mark_token_refused(&ledger, &reached.destination.gateway_id)?;
            }
            return Ok(unreachable);
        }
        Err(other) => return Err(plane_error(other)),
    };
    // NAMES THE GATEWAY HELD ARE FILES CONFIRMED OUTSIDE A PASS (R-1080-C15).
    if !reconciled.confirmed.is_empty() {
        owe_a_snapshot(&ledger)?;
    }
    let now = now_ms();
    let mut requeued = 0_u32;
    for part in ledger.queued().map_err(plane_error)? {
        if part
            .handed_off_ms
            .is_some_and(|at| now.saturating_sub(at) > HANDOFF_GRACE_MS)
        {
            ledger.requeue(&part.name, "LOST").map_err(plane_error)?;
            requeued += 1;
        }
    }
    Ok(wire::ReconcileResponse {
        confirmed: u32::try_from(reconciled.confirmed.len()).unwrap_or(u32::MAX),
        requeued,
        reachable: true,
    })
}

#[cfg(test)]
mod tests {
    /// **A REFUSAL IS CLASSED BY ITS CODE, AND AN UNKNOWN ONE STOPS ONE GATEWAY** (#1188, item
    /// 21): the code a gateway never emits (`QUOTA`) is just an unknown code, not a room.
    #[test]
    fn a_refusal_is_classed_by_its_code_and_an_unknown_one_is_its_own_kind() {
        assert_eq!(refused_by("UNAUTHORIZED"), Refused::Token);
        assert_eq!(refused_by("DISK_FULL"), Refused::Limit(REACH_REFUSED));
        assert_eq!(refused_by("TOO_LARGE"), Refused::Limit(REACH_TOO_LARGE));
        assert_eq!(refused_by("QUOTA"), Refused::Limit(REACH_REFUSED_OTHER));
        assert_eq!(
            refused_by("SOMETHING_NEW"),
            Refused::Limit(REACH_REFUSED_OTHER)
        );
        assert_eq!(heard_of(&Refusal::DiskFull), REACH_REFUSED);
        assert_eq!(heard_of(&Refusal::TooLarge), REACH_TOO_LARGE);
        // A GATEWAY THAT KEEPS RETURNING A DAMAGED COPY stops its own pass with this refusal: it is
        // "refusing", never "no room left".
        assert_eq!(heard_of(&Refusal::DigestMismatch), REACH_REFUSED_OTHER);
        assert_eq!(
            heard_of(&Refusal::Other("X".to_owned())),
            REACH_REFUSED_OTHER
        );
    }

    use super::*;

    fn plant(dir: &Path) {
        std::fs::create_dir_all(dir).expect("makes");
        std::fs::write(dir.join("snapshot-1-a.db"), b"the vault in the clear").expect("writes");
    }

    /// **THE SCRATCH COPY HAS NO WAY OUT THAT KEEPS IT**: normal, early error and panic each
    /// leave the directory gone; a crash is the next open's (`backup_scratch.rs`).
    #[test]
    fn the_scratch_copy_goes_on_every_way_out_of_a_pass() {
        let root = tempfile::tempdir().expect("a directory");
        let dir = root.path().join("vault.scratch");

        {
            let _kept = Scratch::begin(dir.clone());
            plant(&dir);
            assert!(dir.exists());
        }
        assert!(!dir.exists(), "the end of the pass");

        let failing = || -> Result<()> {
            let _kept = Scratch::begin(dir.clone());
            plant(&dir);
            Err(CoreError::Invariant {
                context: "the spool refused".to_owned(),
            })
        };
        assert!(failing().is_err());
        assert!(!dir.exists(), "an error out of the pass");

        let panicked = std::panic::catch_unwind(|| {
            let _kept = Scratch::begin(dir.clone());
            plant(&dir);
            panic!("the pass died");
        });
        assert!(panicked.is_err());
        assert!(!dir.exists(), "a panic out of the pass");

        let kept = Scratch::begin(dir.clone());
        plant(&dir);
        kept.clear();
        assert!(!dir.exists(), "the moment the last range is spooled");

        plant(&dir);
        let swept = Scratch::begin(dir.clone());
        assert!(
            !dir.exists(),
            "what a crash left is cleared when a pass begins"
        );
        drop(swept);
    }

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
        });
        assert!(leaving.snapshot, "the snapshot is still taken now");
        assert!(!leaving.may_prepare(Kind::Original { video: false }));
        assert!(leaving.may_prepare(Kind::Derivative));
        let tapped = Conditions::of(&wire::DrainRequest {
            rule: wire::TransferRule::Manual as i32,
            wants_snapshot: true,
            asked: true,
            ..wire::DrainRequest::default()
        });
        assert!(tapped.may_prepare(Kind::Original { video: false }));
    }

    /// An unspecified rule is `WIFI_ONLY`, and what a pass was told is what
    /// a handoff reads back.
    #[test]
    fn the_rule_a_pass_was_told_is_remembered_for_the_handoff() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("v.backup.db")).expect("a ledger");
        let unknown = Conditions::remembered(&ledger).expect("reads");
        assert_eq!(unknown.rule, wire::TransferRule::WifiOnly);
        assert!(unknown.metered && !unknown.charging && !unknown.exclude_videos);
        let told = Conditions::of(&wire::DrainRequest {
            rule: wire::TransferRule::WifiAndCellularPhotos as i32,
            metered: false,
            charging: true,
            exclude_videos: true,
            ..wire::DrainRequest::default()
        });
        told.remember(&ledger).expect("remembers");
        let back = Conditions::remembered(&ledger).expect("reads");
        assert_eq!(
            back,
            Conditions {
                asked: false,
                snapshot: false,
                ..told
            }
        );
        assert_eq!(
            Conditions::of(&wire::DrainRequest::default()).rule,
            wire::TransferRule::WifiOnly
        );
    }
}
