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
use std::path::Path;
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::ChunkDigest;
use centraid_media::sealed::{self, PartSealer};
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::mover::{self, Stop};
use centraid_vault::backup::naming::{BackupKeys, Name, name as part_name, names_of, part_count};
use centraid_vault::backup::retention;
use centraid_vault::backup::snapshot::{self, Manifest, RangeSealer, Settled};
use centraid_vault::backup::spool::Spool;
use centraid_vault::backup::state::{
    DeviceState, Gateway, LocalSource, Outbox, OutboxKind, Reach, Waiting,
};
use centraid_vault::backup::store::{self as plane_store, Refusal, Store, StoreError};
use centraid_vault::clock::SystemClock;
use centraid_vault::pagesource;

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
const fn heard_of(refusal: &Refusal) -> Reach {
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
enum Refused {
    /// `UNAUTHORIZED`: the gateway does not know this phone's token.
    Token,
    /// Any other refusal is that gateway's own answer: the reach the device state keeps for it
    /// (`DISK_FULL`, `TOO_LARGE`, or one this build does not know). It stops that gateway's
    /// pass and no other's.
    Limit(Reach),
}

/// The class a refusal's code belongs to.
fn refused_by(reason: &str) -> Refused {
    match reason {
        "UNAUTHORIZED" => Refused::Token,
        "DISK_FULL" => Refused::Limit(Reach::RefusedDisk),
        "TOO_LARGE" => Refused::Limit(Reach::RefusedLarge),
        _ => Refused::Limit(Reach::RefusedOther),
    }
}

// ─── the pass ───────────────────────────────────────────────────────────────

/// What one pass did, as the answer carries it.
struct Pass {
    confirmed: u32,
    stopped: wire::DrainStop,
    acked_at_ms: Option<i64>,
    need: Vec<wire::NeedBytes>,
    /// The part names of each file, worked out once a pass: a name is a keyed hash, and a
    /// library of ninety thousand files would otherwise have them hashed again every round.
    names: BTreeMap<[u8; 32], Vec<Name>>,
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
    heard: Option<Reach>,
    /// Gateways that were fed to the end of the pass's media rounds.
    fed: usize,
    /// A token a gateway refused, kept to be the pass's error when no other gateway was fed.
    refused_token: Option<CoreError>,
    /// Gateways whose head went backwards (a restored disk): their blob walk starts again and a
    /// snapshot is retaken at once.
    rolled: BTreeSet<String>,
    /// How many parts this pass read back, and the gateways it found damage at.
    sampled: usize,
    repairing: BTreeSet<String>,
    /// A snapshot spooled for a gateway that never became its head and that a newer one has
    /// superseded, by gateway: its manifest and the ranges only it named are garbage once the
    /// newer head is set.
    abandoned: BTreeMap<String, Name>,
}

impl Pass {
    fn new() -> Self {
        Self {
            confirmed: 0,
            stopped: wire::DrainStop::Empty,
            acked_at_ms: None,
            need: Vec::new(),
            names: BTreeMap::new(),
            asks: 0,
            waiting_bytes: BTreeSet::new(),
            free: 0,
            media_confirmed: 0,
            promised: 0,
            planned: BTreeMap::new(),
            heard: None,
            fed: 0,
            refused_token: None,
            rolled: BTreeSet::new(),
            sampled: 0,
            repairing: BTreeSet::new(),
            abandoned: BTreeMap::new(),
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
            Stop::Unreachable(_) => Some(Reach::Unreachable),
            Stop::Untrusted(_) => Some(Reach::Untrusted),
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

    /// The part names of `file`, in order.
    fn names_of(&mut self, keys: &BackupKeys, file: &ContentFile) -> &[Name] {
        self.names
            .entry(*file.h.as_bytes())
            .or_insert_with(|| names_of(keys, &file.h, file.len))
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
fn mark_token_refused(state: &DeviceState, gateway_id: &str) -> Result<()> {
    set_reach(state, gateway_id, Reach::PairAgain)
}

/// What the last pass found at one gateway (#1188, B1): every paired gateway has its own
/// answer, so the status can name the one that is behind.
fn set_reach(state: &DeviceState, gateway_id: &str, reach: Reach) -> Result<()> {
    state
        .set_reach(gateway_id, reach, now_ms())
        .map_err(plane_error)
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
/// [`CoreError::VaultMoved`] when every paired gateway proved that another phone holds this
/// vault's writer epoch (#1191, E4); [`CoreError::InvalidRequest`] for a request that names no
/// transfer rule; the device state's, the spool's or the vault's refusal.
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
    // THE MEMBER'S RULE IS SENT WITH EVERY REQUEST; none is assumed (#1191). Refused before anything
    // is read or written.
    let conditions = Conditions::of(request)?;
    // THE LAST PASS'S PLAN IS SPENT: a pass that answers early asks for
    // nothing, and a stream with no plan seals the way a first read does.
    handle.plan_library(BTreeMap::new());
    let started = Instant::now();
    let deadline = deadline_of(request.deadline_ms, started);
    let plane = handle.plane();
    let state = plane.state()?;
    plane.remember(conditions);
    if conditions.snapshot {
        plane.set_snapshot_owed(true);
    }
    let spool = plane.spool()?;
    // SUPERSEDED AT EVERY GATEWAY, there is nowhere left to write (E4). A
    // gateway that proved a takeover is left out of the pass by itself, and
    // the others are fed.
    if let Some(epoch) = super::superseded_everywhere(&state)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    let mut pass = Pass::new();
    let gateways = state.gateways().map_err(plane_error)?;
    // EVERY PAIRED GATEWAY IS FED (#1188, B1): the pass asks all of them, and each that
    // answers as itself is a replica this pass brings up to date.
    let fleet = if gateways.is_empty() {
        link::Fleet {
            reached: Vec::new(),
            silent: Vec::new(),
            untrusted: Vec::new(),
            pair_again: Vec::new(),
        }
    } else {
        link::reach_all(
            &gateways,
            &state,
            &plane.tokens(),
            keyring.vault.identity.signing(),
            runtime,
        )?
    };
    if let Some(stop) = &cancellation {
        stop.check()?;
    }
    for reached in &fleet.reached {
        // A GATEWAY THAT ANSWERED IS REACHED, whatever it said last time; a refusal a pass finds
        // later in this pass is recorded when it comes.
        if !matches!(reached.gateway.reach, Reach::PairAgain | Reach::Moved) {
            set_reach(&state, &reached.gateway.gateway_id, Reach::Ok)?;
        }
    }
    for id in &fleet.silent {
        set_reach(&state, id, Reach::Unreachable)?;
    }
    for id in &fleet.untrusted {
        set_reach(&state, id, Reach::Untrusted)?;
    }
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
    let everyone =
        fleet.silent.is_empty() && fleet.untrusted.is_empty() && fleet.pair_again.is_empty();
    let mut reached = fleet.reached;
    for gateway in &mut reached {
        gateway.store.set_cancellation(cancellation.clone());
    }
    reached[0].store.checkpoint()?;
    let outcome = pass_over(
        handle,
        keyring,
        plane,
        &state,
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
fn absorb(state: &DeviceState, pass: &mut Pass, gateway: &Reached, error: CoreError) -> Result<()> {
    let id = &gateway.gateway.gateway_id;
    match error {
        CoreError::Unavailable { reason } => {
            tracing::debug!(%reason, "the gateway stopped answering mid-pass");
            set_reach(state, id, Reach::Unreachable)?;
            pass.stopped = wire::DrainStop::Unreachable;
            Ok(())
        }
        // THE GATEWAY WAS FORGOTTEN UNDER THE PASS (`forget_destination` from the Backup
        // screen while Back up now runs): its token is revoked and its row gone. That is a
        // gateway the pass no longer feeds, not an error.
        _ if state.gateway(id).map_err(plane_error)?.is_none() => {
            tracing::info!("a gateway this pass reached was forgotten under it");
            pass.stopped = wire::DrainStop::Unreachable;
            Ok(())
        }
        CoreError::VaultMoved { current_epoch, .. } => {
            // THAT GATEWAY ONLY (#1191, E4): another phone proved, with a claim
            // the vault key signed above the epoch this phone holds there, that
            // it writes there now. The mark is on that gateway's row; the pass to
            // every other gateway goes on, and the status says another phone has
            // taken over. Only when every paired gateway is moved does a pass
            // refuse ([`super::superseded_everywhere`]).
            state
                .set_moved(id, current_epoch, now_ms())
                .map_err(plane_error)?;
            if super::superseded_everywhere(state)?.is_some() {
                return Err(CoreError::VaultMoved {
                    current_epoch,
                    moved_at_ms: gateway.gateway_ms,
                });
            }
            pass.stopped = wire::DrainStop::Refused;
            Ok(())
        }
        CoreError::GatewayRefused { reason } => match refused_by(&reason) {
            // THE GATEWAY ANSWERED, AND ITS ANSWER IS ITS OWN — a full disk, a part over its
            // limit, a code this build does not know — on a call that was not a part's `PUT`:
            // the same stop the mover gives a refused part (#1080, the sweep's F1), so the status
            // says that machine has to be looked at, not that time will pass. It stops this
            // gateway's pass and no other's.
            Refused::Limit(heard) => {
                tracing::warn!(code = %reason, "the gateway refused; it leaves the pass");
                set_reach(state, id, heard)?;
                pass.stopped = wire::DrainStop::Refused;
                Ok(())
            }
            // A TOKEN THE GATEWAY DOES NOT KNOW (#1080, the sweep's F2): marked, so the
            // status says to pair again.
            Refused::Token => {
                tracing::warn!("the gateway does not know this phone's token; pair again");
                mark_token_refused(state, id)?;
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
    state: &DeviceState,
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
                    set_reach(state, &gateway.gateway.gateway_id, heard)?;
                }
            }
            Err(error) => absorb(state, pass, gateway, error)?,
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
    state: &DeviceState,
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
        .map(|reached| reached.gateway.gateway_id.clone())
        .collect();
    let round = Round {
        handle,
        keyring,
        plane,
        state,
        spool,
        deadline,
    };
    // A GATEWAY FOUND TO HAVE LOST SOMETHING by an earlier pass (a head that went backwards, a
    // read-back that found damage) is retaken at once, until a current head is set there.
    for reached in fleet {
        if plane.rolled(&reached.gateway.gateway_id) {
            pass.rolled.insert(reached.gateway.gateway_id.clone());
        }
    }
    // A ROW KEPT FOR A GATEWAY THAT NEVER CAME BACK IS KEPT A DAY, not for ever.
    mover::release_expired(state, spool, now_ms()).map_err(plane_error)?;

    // THE WRITER EPOCH, AT CONTACT (#1080, the sweep's R6), and — once a core's life — every
    // owed name squared with each gateway (#1080 ruling 7: reconciled "on every launch").
    let owes_reconcile = handle.owes_full_reconcile();
    let mut squared_all = true;
    each(&mut live, state, pass, |reached, pass| {
        let store = &reached.store;
        let id = &reached.gateway.gateway_id;
        // Another phone that restored the vault claimed a later epoch; this phone's token is
        // refused `MOVED` only when it writes, and a pass with nothing to write would never
        // learn it. The head answers the writer epoch on every read, so the pass asks first.
        match store.head_and_epoch() {
            Ok((epoch, _)) if epoch > reached.gateway.epoch => {
                return Err(CoreError::VaultMoved {
                    current_epoch: epoch,
                    moved_at_ms: 0,
                });
            }
            // THE GATEWAY KNOWS THIS PHONE'S TOKEN, whatever it refused before: a mark that
            // said to pair again is spent (the sweep's F2).
            Ok((_, head)) => {
                if reached.gateway.reach == Reach::PairAgain {
                    set_reach(state, id, Reach::Ok)?;
                }
                // A HEAD THAT WENT BACKWARDS (#1188, B4): the gateway names an older generation
                // than this phone signed there, or none (a restored backup of the gateway's own
                // disk, a swapped store). It lost what it held since, so the blob walk starts
                // again (`exists` finds what is missing) and a snapshot is retaken at once.
                let rolled = match (reached.gateway.head, head) {
                    (Some(_), None) => true,
                    (Some(_), Some(head)) => head.generation < reached.gateway.generation,
                    (None, _) => false,
                };
                if rolled {
                    tracing::warn!(gateway = %id, "the gateway's head went backwards");
                    state.set_cursor(id, 0).map_err(plane_error)?;
                    pass.rolled.insert(id.clone());
                    plane.set_rolled(id, true);
                }
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
        // EVERY NAME OWED, ASKED ONCE A LIFE (or at once, after a rollback): the ones the gateway
        // already holds are let go. The library is NOT walked again from its start (B13): a
        // gateway that lost a file since is found by the read-back's sample of originals' chunks,
        // which resets the cursor for exactly that repair.
        if owes_reconcile || pass.rolled.contains(id) {
            let squared =
                mover::reconcile(state, spool, store, &SystemClock).map_err(plane_error)?;
            // NAMES THE GATEWAY HELD ARE FILES CONFIRMED, here as in a pass's own rounds:
            // their rows may be in no snapshot yet (R-1080-C15).
            pass.media_confirmed = pass.media_confirmed.saturating_add(squared.confirmed.len());
        }
        Ok(Flow::Continue)
    })?;
    if owes_reconcile && everyone && squared_all && live.len() == fleet.len() {
        handle.reconciled_fully();
    }

    // 0. THE PHONE VERIFIES, BEFORE IT WRITES (#1188, B4; #1191, E10): a keyed random sample of what each gateway
    // holds of the newest snapshot is read back and opened, so a gateway that lost or damaged a
    // part is found by this pass and not by a restore: a snapshot is retaken at once.
    each(&mut live, state, pass, |reached, pass| {
        verify_sample(
            plane,
            state,
            &reached.store,
            &keyring.backup,
            conditions.metered,
            pass,
        )?;
        Ok(Flow::Continue)
    })?;

    let budget = plane.budget();
    pass.free = plane.free_bytes();

    // 1. THE RECORDS, when the link may carry them: one snapshot, planned against every
    // gateway that is due or behind.
    if conditions.may_move(Kind::Records) && !live.is_empty() {
        let owed = plane.snapshot_owed();
        let mut take = false;
        // A VAULT THAT HAS NOT CHANGED SINCE A SNAPSHOT EVERY GATEWAY HOLDS WHOLE IS NOT COPIED
        // AGAIN, however long ago that was and whoever asked (#1188, design 6).
        if let Some(acked) = newest_stands(handle, state, &live, &pass.rolled)? {
            // ASKED FOR, IT IS ANSWERED with the gateway's own time for the head it holds.
            if owed {
                pass.acked_at_ms = i64::try_from(acked).ok();
            }
            plane.set_snapshot_owed(false);
        } else {
            for reached in &live {
                take |= snapshot_due(
                    state,
                    reached.store.gateway_id(),
                    owed,
                    pass.rolled.contains(reached.store.gateway_id()),
                )?;
            }
        }
        if round.records(take, &mut live, budget, pass)? {
            return Ok(());
        }
    }

    // 2. THE MEDIA, INTERLEAVED: one bounded round per gateway in turn (walk the vault's new
    // claims, seal what fits the spool, move it), again, until every gateway has finished or
    // left. A slow gateway takes its round and no more, so every reachable gateway makes progress
    // in every pass and in every background window (#1188, item 16).
    let bytes = handle.bytes();
    let mut all_finished = true;
    let mut feeds: Vec<Feed<'_>> = live.iter().map(|reached| Feed::new(reached)).collect();
    let mut left: BTreeSet<String> = BTreeSet::new();
    while feeds.iter().any(|feed| !feed.finished) {
        for feed in feeds.iter_mut().filter(|feed| !feed.finished) {
            pass.heard = None;
            let id = feed.reached.gateway.gateway_id.clone();
            let step = media_round(
                feed,
                handle,
                state,
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
                        set_reach(state, &id, heard)?;
                    }
                }
                Err(error) => {
                    feed.finished = true;
                    all_finished = false;
                    left.insert(id);
                    absorb(state, pass, feed.reached, error)?;
                }
            }
        }
    }
    live.retain(|reached| !left.contains(&reached.gateway.gateway_id));
    // A gateway that left the pass was not finished.
    all_finished &= live.len() == fleet.len();

    // 3. THE RECORDS AGAIN, WHEN THIS PASS CONFIRMED FILES THEIR ROWS ARE NOT IN A SNAPSHOT
    // FOR (R-1080-C15). A pass that was cut off owes it to the next, which takes it first.
    if pass.media_confirmed > 0 && conditions.may_move(Kind::Records) {
        let now_files = handle.with_vault(|vault| content_files(vault).map_err(plane_error))?;
        let mut uncovered = false;
        for reached in fleet {
            uncovered |= rows_uncovered(
                handle,
                state,
                &reached.gateway.gateway_id,
                conditions,
                &now_files,
            )?;
        }
        if uncovered {
            if all_finished {
                round.records(true, &mut live, budget, pass)?;
            } else {
                plane.set_snapshot_owed(true);
            }
        }
    }
    Ok(())
}

/// Read back a keyed random sample of what `store` holds of the newest snapshot this phone set
/// there and open each part (E10): a part it no longer holds, or bytes that no longer open, are
/// deleted at the gateway (a damaged name is freed at once, decision 30) so the retaken snapshot
/// seals and sends them again, and the pass owes that snapshot.
fn verify_sample(
    plane: &Plane,
    state: &DeviceState,
    store: &GatewayStore,
    keys: &BackupKeys,
    metered: bool,
    pass: &mut Pass,
) -> Result<()> {
    use centraid_vault::backup::verify::{SAMPLE_CHUNKS, SAMPLE_CHUNKS_METERED, sample};
    let id = store.gateway_id();
    note_held(plane, store)?;
    let Some(head) = state
        .gateway(id)
        .map_err(plane_error)?
        .and_then(|row| row.head)
    else {
        return Ok(());
    };
    // THE HEAD'S OWN MANIFEST NAMES THE RANGES: read and opened, a read of one small part.
    let manifest = match manifest_of(store, keys, &head) {
        Ok(manifest) => manifest,
        Err(error @ CoreError::Unavailable { .. }) => return Err(error),
        Err(error) => {
            tracing::warn!(%error, gateway = %id, "the head's manifest would not open");
            plane.set_snapshot_owed(true);
            plane.set_rolled(id, true);
            plane.note(id, |notes| notes.manifest_unreadable = true);
            pass.rolled.insert(id.to_owned());
            return Ok(());
        }
    };
    let pieces = centraid_vault::backup::verify::population(&manifest);
    let counter = state.next_sample_counter(id).map_err(plane_error)?;
    let found = sample(
        store,
        keys,
        &pieces,
        counter,
        if metered {
            SAMPLE_CHUNKS_METERED
        } else {
            SAMPLE_CHUNKS
        },
        metered,
    );
    pass.sampled = pass.sampled.saturating_add(found.checked);
    plane.note(id, |notes| {
        notes.sample_checked = u32::try_from(found.checked).unwrap_or(u32::MAX);
        notes.sample_of = u32::try_from(pieces.len()).unwrap_or(u32::MAX);
        notes.sample_unverified = 0;
        notes.manifest_unreadable = false;
    });
    if let Some(error) = found.unanswered {
        return Err(store_error(error));
    }
    if found.wrong.is_empty() {
        return Ok(());
    }
    // A CHUNK THAT WAS WRONG, THE GATEWAY NOT KNOWING IT (decision 34): ask it, by a signed
    // check, to hash that one object. At most the pass's sample size are asked. A name it finds
    // damaged is left for the mover (the one signed delete): its re-sent part meets `NAME_TAKEN`
    // (damaged) and the mover frees the name and sends it again; one it finds intact is
    // NOT deleted (the read-back and the gateway disagree: the part is counted unverified and
    // read again next pass); one it does not hold is found by the walk's `exists`.
    let mut confirmed_wrong = found.freeable.len();
    let mut unverified = 0_u32;
    // CHUNKS THE READ-BACK COULD NOT STAND BEHIND: wrong to it, intact to the gateway. They are
    // in `sample_of` and not in `sample_checked`, so the rate sentence never overstates.
    let mut unverified_chunks = 0_usize;
    for name in found
        .wrong
        .iter()
        .filter(|name| !found.freeable.contains(name))
        .take(SAMPLE_CHUNKS)
    {
        match store.check_name(name) {
            Ok(centraid_vault::backup::store::NameCheck::Damaged) => {
                confirmed_wrong += 1;
            }
            Ok(centraid_vault::backup::store::NameCheck::Intact) => {
                unverified += 1;
                unverified_chunks += found.wrong_chunks.get(name).copied().unwrap_or(1);
            }
            // GONE, OR A GATEWAY THAT CANNOT CHECK: the walk's `exists` finds a missing one.
            Ok(
                centraid_vault::backup::store::NameCheck::Missing
                | centraid_vault::backup::store::NameCheck::Unsupported,
            ) => confirmed_wrong += 1,
            // BUSY or a failed ask: the part is read again next pass.
            Err(error @ StoreError::Unreachable(_)) => return Err(store_error(error)),
            Err(_) => {
                unverified += 1;
                unverified_chunks += found.wrong_chunks.get(name).copied().unwrap_or(1);
            }
        }
    }
    pass.sampled = pass.sampled.saturating_sub(unverified_chunks);
    plane.note(id, |notes| {
        notes.sample_unverified = unverified;
        notes.sample_checked = notes
            .sample_checked
            .saturating_sub(u32::try_from(unverified_chunks).unwrap_or(u32::MAX));
    });
    if unverified > 0 {
        tracing::warn!(
            gateway = %id,
            unverified,
            "the read-back found chunks wrong that the gateway says are intact; nothing deleted"
        );
    }
    if confirmed_wrong == 0 {
        return Ok(());
    }
    tracing::warn!(
        gateway = %id,
        wrong = confirmed_wrong,
        "a gateway no longer holds what it acknowledged"
    );
    state.set_cursor(id, 0).map_err(plane_error)?;
    plane.set_snapshot_owed(true);
    // The head is retaken at once and, until a current one is set, the status says so.
    plane.set_rolled(id, true);
    pass.rolled.insert(id.to_owned());
    pass.repairing.insert(id.to_owned());
    Ok(())
}

/// Learn what deletes `store` is holding for this vault, for the status to show: how many, and
/// when the earliest goes for good. One listing of up to 200 names; a gateway that does not answer
/// leaves what was known.
fn note_held(plane: &Plane, store: &GatewayStore) -> Result<()> {
    match plane_store::Store::held(store, None, 200) {
        Ok(held) => {
            plane.note(store.gateway_id(), |notes| {
                notes.held_count = u32::try_from(held.len()).unwrap_or(u32::MAX);
                notes.held_purge_at_ms = held
                    .iter()
                    .map(|entry| entry.purge_after_ms)
                    .min()
                    .and_then(|at| i64::try_from(at).ok())
                    .unwrap_or(0);
            });
            Ok(())
        }
        // A GATEWAY THAT WILL NOT SAY leaves what was known: the status is not the pass.
        Err(error) => {
            tracing::debug!(%error, gateway = %store.gateway_id(), "the gateway did not list its holds");
            Ok(())
        }
    }
}

/// What the records' half of a pass needs, so the pass can run it twice: when
/// it begins, and when it has confirmed files whose rows nothing covers.
struct Round<'a> {
    handle: &'a Handle,
    keyring: &'a Keyring,
    plane: &'a Plane,
    state: &'a DeviceState,
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
        live: &mut Vec<&Reached>,
        budget: u64,
        pass: &mut Pass,
    ) -> Result<bool> {
        if take {
            let stores: Vec<&GatewayStore> = live.iter().map(|reached| &reached.store).collect();
            let failures = match take_snapshot(
                self.handle,
                self.keyring,
                self.state,
                self.spool,
                &stores,
                budget,
                &mut pass.abandoned,
            )? {
                // NOT ENOUGH ROOM TO SPOOL THE SNAPSHOT: it stays owed, the status says why
                // (`WAIT_REASON_NO_ROOM`), and the rest of the pass runs.
                Taken::NoRoom => {
                    self.plane.set_no_room(true);
                    self.plane.set_snapshot_owed(true);
                    Vec::new()
                }
                Taken::Done(failures) => {
                    self.plane.set_no_room(false);
                    if failures.len() < stores.len() {
                        self.plane.set_snapshot_owed(false);
                    }
                    failures
                }
            };
            for (id, error) in failures {
                if let Some(at) = live
                    .iter()
                    .position(|reached| reached.gateway.gateway_id == id)
                {
                    let gateway = live.remove(at);
                    absorb(self.state, pass, gateway, error)?;
                }
            }
        }
        let mut stopped = false;
        let now = self
            .handle
            .with_vault(|vault| Ok(u64::try_from(vault.clock().now_ms()).unwrap_or(0)))?;
        each(live, self.state, pass, |reached, pass| {
            let store = &reached.store;
            let moved = mover::move_queue_where(
                self.state,
                self.spool,
                store,
                self.deadline,
                &SystemClock,
                &|part| part.handed_ms.is_none() && Kind::of_part(part) == Kind::Records,
            )
            .map_err(plane_error)?;
            pass.count(moved.confirmed.len());
            if pass.stopped_by(&moved.stopped)? {
                stopped |= matches!(moved.stopped, Stop::Deadline);
                return Ok(Flow::Stop);
            }
            // RETENTION IS JUDGED ON THE VAULT'S OWN CLOCK, the one every snapshot's
            // `taken_at_ms` is dated by.
            settle_newest(
                self.handle,
                self.plane,
                self.state,
                store,
                self.keyring,
                now,
                pass,
            )?;
            Ok(Flow::Continue)
        })?;
        Ok(stopped)
    }
}

/// **A FILE THE MEMBER BACKS UP, WHOSE BYTES `gateway_id` HOLDS AND WHOSE ROW NO SNAPSHOT THIS
/// PHONE TOOK COVERS** (R-1080-C15): the file the status would read as waiting for the next
/// snapshot. "Covers" counts the snapshot spooled for the gateway — one still on its way
/// included, since it is already in flight — by the vault's own clock, as [`row_backed_up`] does.
fn rows_uncovered(
    handle: &Handle,
    state: &DeviceState,
    gateway_id: &str,
    conditions: &Conditions,
    files: &[ContentFile],
) -> Result<bool> {
    let Some(gateway) = state.gateway(gateway_id).map_err(plane_error)? else {
        return Ok(false);
    };
    let behind = handle.with_vault(|vault| super::behind_hashes(state, vault, &gateway))?;
    let covered_at = gateway.snapshot_ms;
    Ok(files.iter().any(|file| {
        conditions.counts(Kind::of_file(file))
            && !behind.contains(&file.h)
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

/// How far ahead of this phone's clock a snapshot's date may read before it is not believed.
const CLOCK_TOLERANCE_MS: u64 = 5 * 60 * 1000;

/// Whether `taken_at_ms` is within the snapshot interval of `now`. **A date in the future
/// is not recent** (#1188, B11): a clock set ahead and corrected dated a snapshot after now,
/// and trusting it would have held the hourly snapshot off until the real date caught up.
fn recent(now: u64, taken_at_ms: u64) -> bool {
    taken_at_ms <= now.saturating_add(CLOCK_TOLERANCE_MS)
        && now.saturating_sub(taken_at_ms) < SNAPSHOT_EVERY_MS
}

/// Whether a snapshot is due at `gateway_id`. One the shell asked for (`wanted`, kept in the
/// plane until taken) or a gateway whose head went backwards (`rolled`) always is; otherwise
/// one is due an hour after the newest the gateway's head names, and not while a younger
/// one is still on its way to it (its manifest is in the outbox); and one is due at once at a
/// gateway this phone has set no head at.
fn snapshot_due(state: &DeviceState, gateway_id: &str, wanted: bool, rolled: bool) -> Result<bool> {
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
    // THE HOUR RUNS FROM THE SNAPSHOT THIS GATEWAY'S OWN HEAD NAMES: another gateway being
    // current does not make this one so (#1188, B1).
    Ok(gateway.head_ms.is_none_or(|at| !recent(now, at)))
}

/// The names the newest snapshot gave each range, as far as every gateway of the pass still holds
/// them: what the walk may leave unsealed. Nothing known (no head, a manifest that will not open,
/// a gateway that will not answer) is an empty answer, and then every range is sealed.
fn known_ranges(
    state: &DeviceState,
    keyring: &Keyring,
    stores: &[&GatewayStore],
) -> Vec<Option<(Name, Vec<ChunkDigest>)>> {
    let mut newest: Option<(u64, &GatewayStore, Name)> = None;
    for store in stores {
        let Ok(Some(row)) = state.gateway(store.gateway_id()) else {
            continue;
        };
        let Some(head) = row.head else { continue };
        let at = row.head_ms.unwrap_or(0);
        if newest.is_none_or(|(held, ..)| at > held) {
            newest = Some((at, store, head));
        }
    }
    let Some((_, source, head)) = newest else {
        return Vec::new();
    };
    let Ok(manifest) = manifest_of(source, &keyring.backup, &head) else {
        return Vec::new();
    };
    let names: Vec<Name> = manifest.range_names().into_iter().collect();
    let mut gone = BTreeSet::new();
    for store in stores {
        match centraid_vault::backup::store::missing(*store, &names) {
            Ok(missing) => gone.extend(missing),
            Err(_) => return Vec::new(),
        }
    }
    manifest
        .ranges
        .iter()
        .map(|range| (!gone.contains(&range.name)).then(|| (range.name, range.d.clone())))
        .collect()
}

/// The directory of every gateway this phone is paired with: ids, addresses, certificate pins and
/// labels, never a token (E8).
fn directory_of(state: &DeviceState) -> Result<centraid_vault::backup::directory::Directory> {
    use centraid_vault::backup::directory::{Directory, Entry};
    let entries = state
        .gateways()
        .map_err(plane_error)?
        .into_iter()
        .take(centraid_vault::backup::directory::MAX_GATEWAYS)
        .map(|gateway| Entry {
            pin: centraid_gateway::rules::ids::Pin::of(&gateway.cert_der).to_string(),
            gateway_id: gateway.gateway_id,
            addrs: gateway.addrs,
            label: gateway.label,
        })
        .collect();
    Directory::new(entries).map_err(plane_error)
}

/// Read the vault under one pin, sealing the ranges the newest snapshot did not name into the
/// spool as they are read; ask every gateway what it holds of those; and owe each what it lacks:
/// a part is sealed once and owed to each gateway that lacks it. **No copy of the vault is
/// written** and the writer is not held: the pin lives inside [`snapshot::capture_at`] and ends
/// before a gateway is asked anything. What the new snapshot supersedes, and no other snapshot
/// needs, leaves the outbox.
///
/// Answers the gateways whose own questions failed (by id), which the caller takes out of the
/// pass; the snapshot is spooled for the rest.
fn take_snapshot(
    handle: &Handle,
    keyring: &Keyring,
    state: &DeviceState,
    spool: &Spool,
    stores: &[&GatewayStore],
    budget: u64,
    abandoned: &mut BTreeMap<String, Name>,
) -> Result<Taken> {
    // WHAT THE LAST SNAPSHOT NAMED comes from the gateways, before the pin: a pin never spans a
    // gateway call.
    let known = known_ranges(state, keyring, stores);
    let (path, taken_at_ms) = handle.with_vault(|vault| {
        Ok((
            vault.path().to_path_buf(),
            u64::try_from(vault.clock().now_ms()).unwrap_or(0),
        ))
    })?;
    let sealer = RangeSealer::new(spool, &keyring.backup, budget)
        .map_err(plane_error)?
        .with_part_digests(state.part_digests().map_err(plane_error)?);
    // THE SEALED DIRECTORY OF THE MEMBER'S GATEWAYS (E8) rides in every snapshot: its name is
    // a function of its content, so an unchanged set is one `exists` and nothing sent.
    let directory = directory_of(state)?;
    let mut sealer = sealer.with_directory(&directory).map_err(plane_error)?;
    debug_assert_eq!(pagesource::live_pins(), 0);
    let taken = snapshot::capture_at(
        &path,
        taken_at_ms,
        &keyring.backup,
        &keyring.vault_hex(),
        APP,
        &|i| {
            known
                .get(usize::try_from(i).unwrap_or(usize::MAX))
                .cloned()
                .flatten()
        },
        &mut sealer,
    )
    .map_err(plane_error)?;
    debug_assert_eq!(pagesource::live_pins(), 0, "no pin outlives the walk");
    handle.note_walk(taken.sealed.names.len() as u64);

    let mut plans: Vec<(String, snapshot::Plan)> = Vec::with_capacity(stores.len());
    let mut failures = Vec::new();
    for store in stores {
        match snapshot::plan(&taken, *store) {
            Ok(planned) => plans.push((store.gateway_id().to_owned(), planned)),
            Err(error) => failures.push((store.gateway_id().to_owned(), store_error_of(error))),
        }
    }
    if plans.is_empty() {
        // NOBODY TO OWE: what the walk sealed has no row and goes with the next sweep.
        return Ok(Taken::Done(failures));
    }
    // A SNAPSHOT SPOOLED FOR A GATEWAY AND NEVER ITS HEAD is superseded by this one.
    for (gateway, _) in &plans {
        if let Some(row) = state.gateway(gateway).map_err(plane_error)?
            && let Some(previous) = row.snapshot
            && row.head != Some(previous)
            && previous != taken.manifest_name
        {
            abandoned.insert(gateway.clone(), previous);
        }
    }
    let spooled = snapshot::spool(
        &taken,
        &plans,
        spool,
        state,
        &keyring.backup,
        budget,
        now_ms(),
    )
    .map_err(plane_error)?;
    // WHAT THE NEWER SNAPSHOT SUPERSEDES IS NOT SENT: a gateway still behind is brought to
    // the new snapshot, never walked through the old ones.
    let mut keep = taken.manifest.part_names();
    keep.insert(taken.manifest_name);
    for (gateway, _) in &plans {
        let stale: Vec<Name> = state
            .outbox(gateway)
            .map_err(plane_error)?
            .into_iter()
            .filter(|row| {
                matches!(
                    row.kind,
                    OutboxKind::Range | OutboxKind::Leaf | OutboxKind::Manifest
                ) && !keep.contains(&row.name)
            })
            .map(|row| row.name)
            .collect();
        mover::release_many(state, spool, gateway, &stale, false).map_err(plane_error)?;
    }
    // THE SPOOL COULD NOT TAKE THE WHOLE SNAPSHOT because the phone's free space, and not the
    // spool's own ceiling, set its budget: the snapshot stays owed and the status says why.
    if !spooled.deferred.is_empty() && handle.plane().room_limited() {
        return Ok(Taken::NoRoom);
    }
    Ok(Taken::Done(failures))
}

/// What a pass found when it came to take a snapshot.
enum Taken {
    /// Taken and spooled; the gateways whose own questions failed, by id.
    Done(Vec<(String, CoreError)>),
    /// This phone has too little free space to spool its snapshot.
    NoRoom,
}

/// Whether the vault shows what the newest snapshot was taken from and every gateway in the pass
/// holds that snapshot whole under its head: nothing a copy could add.
fn newest_stands(
    handle: &Handle,
    state: &DeviceState,
    live: &[&Reached],
    rolled: &BTreeSet<String>,
) -> Result<Option<u64>> {
    let mut oldest: Option<u64> = None;
    let mut writes: Option<u64> = None;
    for reached in live {
        let id = reached.store.gateway_id();
        let Some(gateway) = state.gateway(id).map_err(plane_error)? else {
            return Ok(None);
        };
        // A GATEWAY THIS PHONE HAS SET NO HEAD AT (a restored phone's first pass) is owed one,
        // and so is one whose head went backwards or whose parts are still owed.
        let whole = gateway.head.is_some()
            && gateway.head == gateway.snapshot
            && !rolled.contains(id)
            && state.outbox(id).map_err(plane_error)?.is_empty();
        if !whole || writes.is_some_and(|held| held != gateway.writes) {
            return Ok(None);
        }
        writes = Some(gateway.writes);
        // THE GATEWAY'S OWN TIME for the head it already holds: what a pass that copied nothing answers.
        oldest = match (oldest, gateway.ack_ms) {
            (Some(held), Some(at)) => Some(held.min(at)),
            (held, at) => held.or(at),
        };
    }
    let Some(writes) = writes else {
        return Ok(None);
    };
    let same =
        handle.with_vault(|vault| snapshot::unchanged_since(vault, writes).map_err(plane_error))?;
    Ok(if same { oldest } else { None })
}

/// A plane error from one gateway's question, as the pass's error for that gateway.
fn store_error_of(error: centraid_vault::backup::PlaneError) -> CoreError {
    match error {
        centraid_vault::backup::PlaneError::Store(error) => store_error(error),
        other => plane_error(other),
    }
}

/// Move the head to the newest snapshot spooled for `store` once nothing of it is owed there;
/// and when it moves, let retention drop what it no longer keeps.
fn settle_newest(
    handle: &Handle,
    plane: &Plane,
    state: &DeviceState,
    store: &GatewayStore,
    keyring: &Keyring,
    now: u64,
    pass: &mut Pass,
) -> Result<()> {
    match snapshot::settle(state, store, &SystemClock).map_err(plane_error)? {
        Settled::HeadSet(head) => {
            plane.set_rolled(store.gateway_id(), false);
            pass.acked_at_ms = i64::try_from(head.set_at_ms).ok();
            // AN ABANDONED SNAPSHOT'S PARTS ARE GARBAGE LIKE ANY OTHER: the union names no more.
            pass.abandoned.remove(store.gateway_id());
            retain(handle, state, store, &keyring.backup, now)?;
        }
        Settled::Nothing => {}
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

/// A kept snapshot's manifest, fetched from the gateway and opened.
fn manifest_of(store: &GatewayStore, keys: &BackupKeys, name: &Name) -> Result<Manifest> {
    snapshot::read_manifest(store, keys, name).map_err(|error| match error {
        centraid_vault::backup::PlaneError::Store(error) => store_error(error),
        other => CoreError::Invariant {
            context: format!("a kept snapshot's manifest would not open: {other}"),
        },
    })
}

/// **Retention and the exact collection** (#1080 "Retention", #1191 B10): keep 7 daily, 4 weekly
/// and 6 monthly snapshots, then delete from the gateway everything it holds that nothing needs.
///
/// **What something needs** is the union of: every kept snapshot's root, its leaves, its ranges
/// and the parts of every blob its rows name (its blobs tree); the parts of every blob the vault
/// claims now (`content_names`); what any outbox row owes; what a member's Undo lifted; and what
/// a snapshot spooled and not yet set names. The gateway is **listed first**, then the union is
/// worked out, so a part that lands after the listing is never judged. Anything listed and not
/// in the union is deleted by signed delete: the gateway holds a live name for its week (E6) and
/// frees a damaged one at once (decision 30).
///
/// **DOUBT NEVER DELETES.** A kept snapshot whose manifest will not open, or a snapshot in
/// flight that names a part this gateway holds and cannot be read, stops the collection for the
/// round: nothing is deleted on a guess.
fn retain(
    handle: &Handle,
    state: &DeviceState,
    store: &GatewayStore,
    keys: &BackupKeys,
    now: u64,
) -> Result<()> {
    let listed: Vec<Name> = plane_store::list_all(store)
        .map_err(store_error)?
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    let registered = store.snapshots().map_err(store_error)?;
    let mut decided = retention::keep(&registered, now);
    // WHAT A MEMBER'S UNDO LIFTED IS NOT DELETED AGAIN AT ONCE (E6): such a snapshot is kept
    // until its time is up, and so is every part of it.
    let undone = state
        .undone(store.gateway_id(), now_ms())
        .map_err(plane_error)?;
    let (restored, dropped): (Vec<Name>, Vec<Name>) = decided
        .drop
        .iter()
        .copied()
        .partition(|name| undone.contains(name));
    decided.drop = dropped;
    decided.keep.extend(restored);
    let mut live: BTreeSet<Name> = state.owed_names().map_err(plane_error)?;
    live.extend(undone.iter().copied());
    for name in &decided.keep {
        live.insert(*name);
        match manifest_of(store, keys, name) {
            Ok(manifest) => {
                live.extend(manifest.part_names());
            }
            Err(error @ CoreError::Unavailable { .. }) => return Err(error),
            Err(error) => {
                tracing::warn!(
                    %error,
                    "a kept snapshot's manifest would not open; nothing is collected"
                );
                return Ok(());
            }
        }
    }
    // A SNAPSHOT SPOOLED FOR ANY GATEWAY AND NOT YET SET IS ON ITS WAY: its names are not garbage.
    for gateway in state.gateways().map_err(plane_error)? {
        let Some(name) = gateway.snapshot else {
            continue;
        };
        if live.contains(&name) {
            continue;
        }
        live.insert(name);
        match manifest_of(store, keys, &name) {
            Ok(manifest) => live.extend(manifest.part_names()),
            Err(error @ CoreError::Unavailable { .. }) => return Err(error),
            // NOT HERE (never put on this gateway) or not a manifest: its parts that are here
            // are owed by an outbox row or are an abandoned attempt's.
            Err(_) => {}
        }
    }
    let claimed = handle.with_vault(|vault| {
        centraid_vault::backup::naming::content_names(keys, vault).map_err(plane_error)
    })?;
    live.extend(claimed);
    let doomed = retention::garbage(listed, &live);
    let deleted = plane_store::delete_all(store, &doomed).map_err(store_error)?;
    state.forget_digests_except(&live).map_err(plane_error)?;
    tracing::info!(
        dropped = decided.drop.len(),
        collected = deleted.deleted.len(),
        "retention dropped snapshots and collected what nothing needs"
    );
    Ok(())
}

// ─── the media ──────────────────────────────────────────────────────────────

/// One gateway's side of a pass's media rounds, and what a pass works out once for it.
struct Feed<'a> {
    reached: &'a Reached,
    /// Set when the gateway has had its last round: it finished, or left the pass.
    finished: bool,
    /// The walk of the vault's new claims reached the end for this gateway, this pass.
    walked: bool,
    /// The lapsed rows were looked at again, this pass.
    examined: bool,
    /// What the vault says of each blob this gateway is owed, read once and kept.
    files: BTreeMap<centraid_vault::backup::naming::PlaintextHash, ContentFile>,
}

impl<'a> Feed<'a> {
    fn new(reached: &'a Reached) -> Self {
        Self {
            reached,
            finished: false,
            walked: false,
            examined: false,
            files: BTreeMap::new(),
        }
    }
}

/// How many claims one step of the cursor walk reads (E11).
const WALK_PAGE: usize = 500;

/// **The cursor's walk** (#1191, E11, B12): the vault's claims made since the gateway's cursor,
/// in order, a page at a time. For each blob the part names are worked out and the gateway is
/// asked `exists`; each name it lacks becomes an outbox row, and the cursor moves past the page in
/// the same transaction. An unchanged library returns no claims: one statement, and no gateway
/// call. A blob only lapsed entities rent leaves a `lapsed` row and is not asked about. Answers
/// whether the walk reached the end.
#[allow(clippy::too_many_arguments)]
fn walk_claims(
    handle: &Handle,
    state: &DeviceState,
    spool: &Spool,
    store: &GatewayStore,
    keys: &BackupKeys,
    feed_files: &mut BTreeMap<centraid_vault::backup::naming::PlaintextHash, ContentFile>,
    deadline: Instant,
    pass: &mut Pass,
) -> Result<bool> {
    use centraid_vault::backup::files::{Found, content_files_for};
    use centraid_vault::backup::naming::claims_after;
    let gateway = store.gateway_id().to_owned();
    loop {
        if Instant::now() >= deadline {
            return Ok(false);
        }
        store.checkpoint()?;
        let Some(row) = state.gateway(&gateway).map_err(plane_error)? else {
            return Ok(true);
        };
        let after = i64::try_from(row.cursor).unwrap_or(i64::MAX);
        let claims = handle
            .with_vault(|vault| claims_after(vault, after, WALK_PAGE).map_err(plane_error))?;
        let Some(last) = claims.last().map(|claim| claim.seq) else {
            return Ok(true);
        };
        let hashes: Vec<_> = claims.iter().map(|claim| claim.hash).collect();
        let found =
            handle.with_vault(|vault| content_files_for(vault, &hashes).map_err(plane_error))?;
        let now = now_ms();
        let mut ask: Vec<Name> = Vec::new();
        let mut rows: Vec<Outbox> = Vec::new();
        let mut owed: Vec<(
            Name,
            centraid_vault::backup::naming::PlaintextHash,
            ContentFile,
        )> = Vec::new();
        for claim in &claims {
            let names = names_of(keys, &claim.hash, claim.len);
            match found.get(&claim.hash) {
                Some(Found::Live(file)) => {
                    for name in names {
                        ask.push(name);
                        owed.push((name, claim.hash, file.clone()));
                    }
                }
                Some(Found::Lapsed) => {
                    for name in names {
                        let mut row = blob_row(
                            &gateway,
                            name,
                            claim.hash,
                            "application/octet-stream",
                            false,
                            now,
                        );
                        row.waiting = Some(Waiting::Lapsed);
                        rows.push(row);
                    }
                }
                // COLLECTED SINCE THE WALK READ IT: nothing to back up.
                None => {}
            }
        }
        if !ask.is_empty() {
            pass.asks += ask.len();
            let missing = plane_store::missing(store, &ask).map_err(store_error)?;
            for (name, hash, file) in owed {
                if missing.contains(&name) {
                    rows.push(blob_row(
                        &gateway,
                        name,
                        hash,
                        &file.media_type,
                        file.variant.is_some(),
                        now,
                    ));
                    feed_files.insert(hash, file);
                } else {
                    pass.media_confirmed = pass.media_confirmed.saturating_add(1);
                    // THE GATEWAY HOLDS IT: a file the stage door sealed for nobody is not wanted.
                    if spool.contains(&name)
                        && state.owed_among(&[name]).map_err(plane_error)?.is_empty()
                    {
                        spool.remove(&name).map_err(plane_error)?;
                    }
                }
            }
        }
        state
            .advance(&gateway, &rows, u64::try_from(last).unwrap_or(0))
            .map_err(plane_error)?;
    }
}

/// The length and digest of a sealed file in the spool.
fn file_seal(path: &Path) -> std::io::Result<(u64, centraid_vault::backup::naming::Digest)> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; READ_CHUNK];
    let mut len = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        len += read as u64;
    }
    Ok((
        len,
        centraid_vault::backup::naming::Digest::from_bytes(*hasher.finalize().as_bytes()),
    ))
}

/// An owed blob part, not sealed yet.
fn blob_row(
    gateway: &str,
    name: Name,
    hash: centraid_vault::backup::naming::PlaintextHash,
    media_type: &str,
    derivative: bool,
    now: u64,
) -> Outbox {
    Outbox {
        gateway_id: gateway.to_owned(),
        name,
        kind: OutboxKind::Blob,
        hash: Some(hash),
        part_path: None,
        waiting: None,
        size: None,
        digest: None,
        media_type: Some(media_type.to_owned()),
        created_ms: now,
        handed_ms: None,
        attempts: 0,
        last_error: None,
        derivative,
    }
}

/// Look again at the rows that wait for the vault's own collection: a blob rented again is owed
/// (the walk will not meet it again, so it is asked about here), and a blob gone has its rows
/// deleted. The cost is the number of lapsed blobs, never the library.
fn reexamine_lapsed(
    handle: &Handle,
    state: &DeviceState,
    store: &GatewayStore,
    keys: &BackupKeys,
    feed_files: &mut BTreeMap<centraid_vault::backup::naming::PlaintextHash, ContentFile>,
    pass: &mut Pass,
) -> Result<()> {
    use centraid_vault::backup::files::{Found, content_files_for};
    let gateway = store.gateway_id();
    let lapsed = state.outbox_waiting(gateway).map_err(plane_error)?;
    let hashes: BTreeSet<_> = lapsed
        .iter()
        .filter(|row| row.waiting == Some(Waiting::Lapsed))
        .filter_map(|row| row.hash)
        .collect();
    if hashes.is_empty() {
        return Ok(());
    }
    let hashes: Vec<_> = hashes.into_iter().collect();
    let found =
        handle.with_vault(|vault| content_files_for(vault, &hashes).map_err(plane_error))?;
    let mut ask: Vec<(
        Name,
        centraid_vault::backup::naming::PlaintextHash,
        ContentFile,
    )> = Vec::new();
    let mut gone: Vec<Name> = Vec::new();
    for row in lapsed
        .iter()
        .filter(|row| row.waiting == Some(Waiting::Lapsed))
    {
        let Some(hash) = row.hash else { continue };
        match found.get(&hash) {
            Some(Found::Lapsed) => {}
            Some(Found::Live(file)) => {
                gone.push(row.name);
                ask.push((row.name, hash, file.clone()));
            }
            None => gone.push(row.name),
        }
    }
    state.done_many(gateway, &gone).map_err(plane_error)?;
    if ask.is_empty() {
        return Ok(());
    }
    let names: Vec<Name> = ask.iter().map(|(name, _, _)| *name).collect();
    pass.asks += names.len();
    let missing = plane_store::missing(store, &names).map_err(store_error)?;
    let now = now_ms();
    let mut rows = Vec::new();
    for (name, hash, file) in ask {
        if missing.contains(&name) {
            rows.push(blob_row(
                gateway,
                name,
                hash,
                &file.media_type,
                file.variant.is_some(),
                now,
            ));
            feed_files.insert(hash, file);
        }
    }
    state.put_outbox_many(&rows).map_err(plane_error)?;
    let _ = keys;
    Ok(())
}

/// Give every gateway that owes `name` the sealed file just written: the spool holds one file a
/// name, shared. A name nobody owes (it was let go while it was sealing) leaves the spool.
fn adopt_sealed(
    state: &DeviceState,
    name: &Name,
    path: &Path,
    size: u64,
    digest: &centraid_vault::backup::naming::Digest,
    chunks: &[ChunkDigest],
) -> Result<()> {
    state.record_digests(name, chunks).map_err(plane_error)?;
    let filled = state
        .seal_everywhere(name, path, size, digest)
        .map_err(plane_error)?;
    if filled == 0 {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// One bounded round for one gateway: walk the claims it has not met, seal what fits the spool,
/// move it. `Continue` when more remains (another round is owed), `Stop` when the gateway left
/// the pass; a gateway whose round sealed and moved nothing is finished.
#[allow(clippy::too_many_arguments)]
fn media_round<'a>(
    feed: &mut Feed<'a>,
    handle: &Handle,
    state: &DeviceState,
    spool: &Spool,
    keys: &BackupKeys,
    bytes: Option<&centraid_blobs::ByteStore>,
    conditions: &Conditions,
    budget: u64,
    deadline: Instant,
    reachable: &[String],
    pass: &mut Pass,
) -> Result<Flow> {
    let store = &feed.reached.store;
    if spool.bytes().map_err(plane_error)? >= budget {
        // THE SPOOL IS FULL OF PARTS A GATEWAY THAT DID NOT ANSWER STILL OWES: the room is
        // needed more than the wait; that gateway is fed again from the vault when it returns.
        mover::release_to_reachable(state, spool, reachable).map_err(plane_error)?;
    }
    if !feed.examined {
        reexamine_lapsed(handle, state, store, keys, &mut feed.files, pass)?;
        feed.examined = true;
    }
    if !feed.walked {
        feed.walked = walk_claims(
            handle,
            state,
            spool,
            store,
            keys,
            &mut feed.files,
            deadline,
            pass,
        )?;
    }
    let sealed = prepare(
        feed, handle, state, spool, keys, bytes, conditions, budget, deadline, pass,
    )?;
    if Instant::now() >= deadline {
        pass.stopped = wire::DrainStop::Deadline;
        return Ok(Flow::Stop);
    }
    let store = &feed.reached.store;
    let moved = mover::move_queue_where(state, spool, store, deadline, &SystemClock, &|part| {
        let kind = Kind::of_part(part);
        part.handed_ms.is_none() && kind != Kind::Records && conditions.may_move(kind)
    })
    .map_err(plane_error)?;
    pass.count(moved.confirmed.len());
    pass.media_confirmed = pass.media_confirmed.saturating_add(moved.confirmed.len());
    if pass.stopped_by(&moved.stopped)? {
        return Ok(Flow::Stop);
    }
    // A ROUND THAT MOVED PARTS FREED ROOM, so one more prepare asks for the next window of a
    // library item larger than the spool (R-1080-C39) before the pass answers; a round that
    // did neither, with the walk at its end, is the end.
    if sealed == 0 && moved.confirmed.is_empty() && feed.walked {
        feed.finished = true;
        pass.fed += 1;
    }
    Ok(Flow::Continue)
}

/// Seal what a gateway is owed of the vault's files into the spool, up to its budget:
/// derivatives first, the grid, then originals, newest first within each. Answers how many
/// parts were sealed.
#[allow(clippy::too_many_arguments)]
fn prepare<'a>(
    feed: &mut Feed<'a>,
    handle: &Handle,
    state: &DeviceState,
    spool: &Spool,
    keys: &BackupKeys,
    bytes: Option<&centraid_blobs::ByteStore>,
    conditions: &Conditions,
    budget: u64,
    deadline: Instant,
    pass: &mut Pass,
) -> Result<usize> {
    use centraid_vault::backup::files::{Found, content_files_for};
    let reached = feed.reached;
    let store = &reached.store;
    let gateway = store.gateway_id();
    // WHAT THIS GATEWAY IS OWED AND NOTHING SEALED YET, grouped by file: the part names it lacks
    // and each one's index. Every gateway is a full replica (#1188, B1).
    let unsealed = state.outbox_unsealed(gateway).map_err(plane_error)?;
    let missing_info: Vec<_> = unsealed
        .iter()
        .filter_map(|row| row.hash)
        .filter(|hash| !feed.files.contains_key(hash))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if !missing_info.is_empty() {
        let found = handle
            .with_vault(|vault| content_files_for(vault, &missing_info).map_err(plane_error))?;
        let mut gone: Vec<Name> = Vec::new();
        for row in &unsealed {
            let Some(hash) = row.hash else { continue };
            if feed.files.contains_key(&hash) {
                continue;
            }
            match found.get(&hash) {
                Some(Found::Live(file)) => {
                    feed.files.insert(hash, file.clone());
                }
                Some(Found::Lapsed) => {
                    state
                        .set_waiting(gateway, &row.name, Some(Waiting::Lapsed))
                        .map_err(plane_error)?;
                }
                // COLLECTED SINCE IT WAS OWED: nobody owes it now.
                None => gone.push(row.name),
            }
        }
        state.done_many(gateway, &gone).map_err(plane_error)?;
    }
    let mut by_file: BTreeMap<centraid_vault::backup::naming::PlaintextHash, Vec<(u32, Name)>> =
        BTreeMap::new();
    for row in &unsealed {
        let Some(hash) = row.hash else { continue };
        let Some(file) = feed.files.get(&hash) else {
            continue;
        };
        if let Some(index) = pass
            .names_of(keys, file)
            .iter()
            .position(|name| *name == row.name)
        {
            by_file
                .entry(hash)
                .or_default()
                .push((u32::try_from(index).unwrap_or(u32::MAX), row.name));
        }
    }
    let mut candidates: Vec<(&ContentFile, Vec<(u32, Name)>)> = by_file
        .into_iter()
        .filter_map(|(hash, parts)| Some((feed.files.get(&hash)?, parts)))
        .filter(|(file, _)| conditions.counts(Kind::of_file(file)))
        .filter(|(file, _)| conditions.may_prepare(Kind::of_file(file)))
        .collect();
    // NEWEST FIRST, DERIVATIVES BEFORE ORIGINALS: they are kilobytes and they are the grid.
    candidates.sort_by(|a, b| b.0.created_at.cmp(&a.0.created_at));
    candidates.sort_by_key(|(file, _)| file.variant.is_none());

    let mut held_bytes = spool
        .bytes()
        .map_err(plane_error)?
        .saturating_add(pass.promised);
    let mut sealed = 0_usize;
    let mut library: Vec<LibraryAsk<'_>> = Vec::new();
    for (file, parts) in candidates {
        store.checkpoint()?;
        if Instant::now() >= deadline {
            break;
        }
        // A PART SOME OTHER GATEWAY SEALED ALREADY IS NOT SEALED AGAIN: the spool's file is
        // shared, and this gateway's row takes its size and digest.
        let mut fresh: Vec<(u32, Name)> = Vec::new();
        for (index, name) in parts {
            match state.sealed_copy(&name).map_err(plane_error)? {
                Some(copy) if spool.contains(&name) => {
                    if let (Some(path), Some(size), Some(digest)) =
                        (copy.part_path.as_ref(), copy.size, copy.digest.as_ref())
                    {
                        state
                            .seal_outbox(gateway, &name, path, size, digest)
                            .map_err(plane_error)?;
                    }
                }
                // A FILE THE STAGE DOOR SEALED BEFORE ANY ROW OWED IT sits in the spool unowned:
                // this gateway's row takes it, sized and digested from the file itself.
                None if spool.contains(&name) => {
                    let path = spool.path(&name);
                    match file_seal(&path) {
                        Ok((size, digest)) => {
                            state
                                .seal_outbox(gateway, &name, &path, size, &digest)
                                .map_err(plane_error)?;
                        }
                        Err(error) => {
                            tracing::warn!(%error, "a spooled part cannot be read; it is sealed again");
                            spool.remove(&name).map_err(plane_error)?;
                            fresh.push((index, name));
                        }
                    }
                }
                _ => fresh.push((index, name)),
            }
        }
        if fresh.is_empty() {
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
            let indices: BTreeSet<u32> = fresh.iter().map(|(index, _)| *index).collect();
            sealed += seal_store_file(
                &path,
                store,
                file,
                &indices,
                keys,
                spool,
                state,
                budget,
                deadline,
                pass.free,
                &mut held_bytes,
            )?;
            continue;
        }
        let local = state.local(&file.h).map_err(plane_error)?;
        if let Some(local) = local.filter(|local| local.source == LocalSource::Os) {
            let first = pass
                .names_of(keys, file)
                .first()
                .copied()
                .unwrap_or_else(|| part_name(keys, &file.h, 0));
            pass.waiting_bytes.insert(first);
            if let Some(os_ref) = local.os_ref.filter(|os_ref| !os_ref.is_empty()) {
                library.push(LibraryAsk {
                    file,
                    os_ref,
                    parts: fresh.iter().map(|(index, _)| *index).collect(),
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
/// as the mover drains it. Each sealed part fills every gateway's row that owes it. Answers how
/// many parts were sealed.
#[allow(clippy::too_many_arguments)]
fn seal_store_file(
    path: &std::path::Path,
    store: &GatewayStore,
    file: &ContentFile,
    indices: &BTreeSet<u32>,
    keys: &BackupKeys,
    spool: &Spool,
    state: &DeviceState,
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
        adopt_sealed(
            state,
            &name,
            &part_path,
            seal.len,
            &seal.digest,
            &seal.chunk_digests,
        )?;
        *held_bytes = held_bytes.saturating_add(seal.len);
        sealed += 1;
    }
    Ok(sealed)
}

/// Keep the parts the stage door sealed beside a library item's stream (the root's ruling A8):
/// each is moved to its name in the spool and fills every gateway's row that owes it. A part no
/// row owes yet is kept all the same while any gateway is paired: the blob walk meets the new
/// claim a moment later and finds the file already sealed (`prepare`). With nothing paired they
/// are dropped. Answers how many were kept.
///
/// # Errors
/// The device state's or the spool's refusal.
pub fn queue_sealed(
    spool: &Spool,
    state: &DeviceState,
    sealed: &sealed::FileSeal,
    _media_type: &str,
) -> Result<usize> {
    let paired = !state.gateways().map_err(plane_error)?.is_empty();
    let mut count = 0;
    for part in &sealed.parts {
        // A PART IS SEALED ONCE: one already in the spool is not replaced.
        if !paired || spool.contains(&part.name) {
            let _ = std::fs::remove_file(&part.path);
            continue;
        }
        let part_path = spool.adopt(&part.path, &part.name).map_err(plane_error)?;
        state
            .record_digests(&part.name, &part.chunk_digests)
            .map_err(plane_error)?;
        state
            .seal_everywhere(&part.name, &part_path, part.len, &part.digest)
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
    let state = plane.state()?;
    if let Some(epoch) = super::superseded_everywhere(&state)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    // EACH PART GOES TO THE GATEWAY ITS ROW NAMES (#1188, B1), the one reached last first:
    // the one `reconcile` just answered from.
    let mut ordered: Vec<(usize, Gateway)> = state
        .gateways()
        .map_err(plane_error)?
        .into_iter()
        .enumerate()
        .collect();
    ordered
        .sort_by_key(|(order, gateway)| (std::cmp::Reverse(gateway.seen_ms.unwrap_or(0)), *order));
    if ordered.is_empty() {
        return Ok(wire::HandoffResponse { parts: Vec::new() });
    }
    let conditions = Conditions::remembered(plane);
    let tokens = plane.tokens();
    let mut stores: BTreeMap<String, GatewayStore> = BTreeMap::new();
    let vault_hex = keyring.vault_hex();
    let max_parts = usize::try_from(request.max_parts).unwrap_or(usize::MAX);
    let mut parts = Vec::new();
    let mut bytes = 0_u64;
    'gateways: for (_, target) in &ordered {
        // A GATEWAY THIS PHONE WAS SUPERSEDED AT, or holds no token for, is not fed.
        if target.moved_epoch.is_some() {
            continue;
        }
        let Some(token) = tokens.get(&target.gateway_id) else {
            continue;
        };
        for part in state.outbox(&target.gateway_id).map_err(plane_error)? {
            if parts.len() >= max_parts {
                break 'gateways;
            }
            let (Some(path), Some(size), Some(digest)) =
                (part.part_path.as_ref(), part.size, part.digest.as_ref())
            else {
                continue;
            };
            let kind = Kind::of_part(&part);
            if part.handed_ms.is_some() || !conditions.counts(kind) {
                continue;
            }
            if bytes.saturating_add(size) > request.max_bytes {
                break 'gateways;
            }
            if !stores.contains_key(&target.gateway_id) {
                stores.insert(
                    target.gateway_id.clone(),
                    GatewayStore::for_gateway(
                        target,
                        *token,
                        keyring.vault.identity.signing(),
                        runtime,
                    )?,
                );
            }
            let store = &stores[&target.gateway_id];
            let presigned = store
                .client()
                .presign_put(
                    store.vault(),
                    &link::wire_name(&part.name),
                    &centraid_gateway::rules::ids::Digest::from_bytes(*digest.as_bytes()),
                    size,
                )
                .map_err(|error| CoreError::Invariant {
                    context: format!("presigning a part: {error}"),
                })?;
            state
                .hand_off(&target.gateway_id, &part.name, now_ms())
                .map_err(plane_error)?;
            bytes = bytes.saturating_add(size);
            parts.push(wire::HandoffPart {
                name: part.name.to_hex(),
                path: path.to_string_lossy().into_owned(),
                url: presigned.url,
                method: presigned.method,
                headers: presigned
                    .headers
                    .into_iter()
                    .map(|(name, value)| wire::Header { name, value })
                    .collect(),
                size,
                gateway_id: target.gateway_id.clone(),
                vault_id: vault_hex.clone(),
                allows_cellular: allows_cellular(kind, conditions.rule),
            });
        }
    }
    Ok(wire::HandoffResponse { parts })
}

/// **Record what the operating system reported** (`settle`, #1080 ruling 7).
///
/// A `2xx` is the gateway's acknowledgement, and so is `NAME_TAKEN` (the same
/// bytes sealed again, R-1080-B4): the row goes and the file leaves the spool once no gateway
/// owes it. `DIGEST_MISMATCH` is a torn spool file: the row is unsealed to be sealed again.
/// Anything else, `MOVED` included (a report the operating system carried is not a claim the
/// vault key signed, E4), puts the part back to be moved. A name the outbox does not hold, or a
/// part for another vault, is ignored and not counted (the root's ruling A6).
///
/// # Errors
/// The device state's or the spool's refusal.
pub fn settle(
    plane: &Plane,
    keyring: &Keyring,
    request: &wire::SettleRequest,
) -> Result<wire::SettleResponse> {
    let state = plane.state()?;
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
        let Some(part) = state
            .outbox_row(&settled.gateway_id, &name)
            .map_err(plane_error)?
        else {
            continue;
        };
        // THE OPERATING SYSTEM WAS TOLD NO BY A GATEWAY THAT DOES NOT KNOW
        // THIS PHONE'S TOKEN (the sweep's F2): marked as a pass would mark it,
        // so the status says to pair again whichever half met the refusal.
        if settled.http_status == 401 || settled.error == "UNAUTHORIZED" {
            mark_token_refused(&state, &settled.gateway_id)?;
        }
        let acknowledged = matches!(settled.http_status, 200 | 201)
            || (settled.http_status == 409 && settled.error == "NAME_TAKEN");
        if acknowledged {
            mover::release_many(&state, &spool, &settled.gateway_id, &[name], true)
                .map_err(plane_error)?;
            state
                .touch_ack(&settled.gateway_id, now_ms())
                .map_err(plane_error)?;
            answer.confirmed += 1;
            files_confirmed |= Kind::of_part(&part) != Kind::Records;
        } else if settled.error == "DIGEST_MISMATCH" {
            state
                .unseal(&settled.gateway_id, &name, "DIGEST_MISMATCH")
                .map_err(plane_error)?;
            spool.remove(&name).map_err(plane_error)?;
            answer.requeued += 1;
        } else {
            // ANY OTHER OUTCOME: the part goes back to waiting.
            let reason = if settled.error.is_empty() {
                format!("HTTP_{}", settled.http_status)
            } else {
                settled.error.clone()
            };
            requeue(&state, &settled.gateway_id, &name, &reason)?;
            answer.requeued += 1;
        }
    }
    // FILES THE OPERATING SYSTEM CONFIRMED ARE FILES A PASS DID NOT (R-1080-C15):
    // their rows are in no snapshot yet, so the next pass that may carry the
    // records takes one first, as it does for a pass that was cut off.
    if files_confirmed {
        plane.set_snapshot_owed(true);
    }
    Ok(answer)
}

/// A part the operating system did not finish is the phone's to move again.
fn requeue(state: &DeviceState, gateway_id: &str, name: &Name, reason: &str) -> Result<()> {
    state
        .record_attempt(gateway_id, name, reason)
        .map_err(plane_error)?;
    state.unhand_many(gateway_id, &[*name]).map_err(plane_error)
}

/// **Square the outbox with what a gateway holds** (`reconcile`, #1080
/// ruling 7), at the first paired gateway that answers.
///
/// Every owed name the gateway already holds is let go and leaves the spool (an outbox is all
/// there is to ask about now, so `full` and not are the same question). A part handed to the
/// operating system longer ago than [`HANDOFF_GRACE_MS`] that the gateway does not hold goes
/// back to be moved.
///
/// # Errors
/// The device state's or the spool's refusal. A gateway that stops answering
/// mid-way is `reachable: false`, never an error.
pub fn reconcile(
    plane: &Plane,
    keyring: &Keyring,
    runtime: &tokio::runtime::Handle,
    _full: bool,
) -> Result<wire::ReconcileResponse> {
    let state = plane.state()?;
    let spool = plane.spool()?;
    let unreachable = wire::ReconcileResponse {
        confirmed: 0,
        requeued: 0,
        reachable: false,
    };
    if super::superseded_everywhere(&state)?.is_some() {
        return Ok(unreachable);
    }
    let gateways = state.gateways().map_err(plane_error)?;
    let Ok(reached) = link::reach(
        &gateways,
        &state,
        &plane.tokens(),
        keyring.vault.identity.signing(),
        runtime,
    )?
    else {
        return Ok(unreachable);
    };
    let reconciled = mover::reconcile(&state, &spool, &reached.store, &SystemClock);
    let reconciled = match reconciled {
        Ok(reconciled) => reconciled,
        Err(centraid_vault::backup::PlaneError::Store(error)) => {
            tracing::debug!(%error, "the gateway stopped answering mid-reconcile");
            if matches!(error, StoreError::Refused(Refusal::Unauthorized)) {
                mark_token_refused(&state, &reached.gateway.gateway_id)?;
            }
            return Ok(unreachable);
        }
        Err(other) => return Err(plane_error(other)),
    };
    // NAMES THE GATEWAY HELD ARE FILES CONFIRMED OUTSIDE A PASS (R-1080-C15).
    if !reconciled.confirmed.is_empty() {
        plane.set_snapshot_owed(true);
    }
    let now = now_ms();
    let mut requeued = 0_u32;
    for gateway in &gateways {
        for part in state.outbox(&gateway.gateway_id).map_err(plane_error)? {
            if part
                .handed_ms
                .is_some_and(|at| now.saturating_sub(at) > HANDOFF_GRACE_MS)
            {
                requeue(&state, &gateway.gateway_id, &part.name, "LOST")?;
                requeued += 1;
            }
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
        assert_eq!(refused_by("DISK_FULL"), Refused::Limit(Reach::RefusedDisk));
        assert_eq!(refused_by("TOO_LARGE"), Refused::Limit(Reach::RefusedLarge));
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
