//! THE PASS, AND THE OPERATING SYSTEM'S HALF OF IT (#1080, "The phone core").
//!
//! ```text
//! reach      the first paired gateway that answers, as itself       (the ledger's order)
//! snapshot   when one is due and the link may carry the records    (the vault, briefly)
//! records    move the snapshot's parts, then move the head          (manifest after ranges)
//! prepare    seal what no gateway holds: derivatives, then originals, newest first
//! move       PUT each part, bundles for the small ones; repeat until nothing is left
//! ```
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
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{self, PartSealer};
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::ledger::{Ledger, LedgerSnapshot, LocalSource, PartKind, Queued};
use centraid_vault::backup::mover::{self, Stop};
use centraid_vault::backup::naming::{BackupKeys, Name, name as part_name, names_of, part_count};
use centraid_vault::backup::retention;
use centraid_vault::backup::snapshot::{self, Manifest, Settled};
use centraid_vault::backup::spool::Spool;
use centraid_vault::backup::store::{self as plane_store, Store};
use centraid_vault::clock::SystemClock;

use super::link::{self, GatewayStore, Reached, Unreached};
use super::{Keyring, Plane, now_ms, plane_error, store_error};
use crate::error::{CoreError, Result};
use crate::handle::Handle;
use crate::stage::{Planned, bytes_of_parts, window_within};

/// A snapshot is taken at most this often unless the member asks: an hour,
/// the recovery point for records at home (#1080 ruling 5).
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

const RULE_KEY: &str = "pass.rule";
const EXCLUDE_VIDEOS_KEY: &str = "pass.exclude_videos";
const METERED_KEY: &str = "pass.metered";
const CHARGING_KEY: &str = "pass.charging";
const REACHABLE_KEY: &str = "pass.reachable";

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
    /// (`command.proto`).
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
/// whether at the start of the pass or part-way through it.
///
/// # Errors
/// The ledger's refusal.
pub fn last_reach(ledger: &Ledger) -> Result<Option<wire::WaitReason>> {
    Ok(
        match ledger.meta(REACHABLE_KEY).map_err(plane_error)?.as_deref() {
            Some(REACH_SILENT) => Some(wire::WaitReason::Gateway),
            Some(REACH_UNTRUSTED) => Some(wire::WaitReason::Untrusted),
            _ => None,
        },
    )
}

/// `REACHABLE_KEY`'s three values.
const REACH_ANSWERED: &str = "1";
const REACH_SILENT: &str = "0";
const REACH_UNTRUSTED: &str = "untrusted";

// ─── the pass ───────────────────────────────────────────────────────────────

/// What one pass did, as the answer carries it.
struct Pass {
    confirmed: u32,
    stopped: wire::DrainStop,
    acked_at_ms: Option<i64>,
    need: Vec<wire::NeedBytes>,
    asked_for: BTreeSet<Name>,
    waiting_bytes: BTreeSet<Name>,
    /// The spool's bytes promised to the library items asked for: the shell
    /// streams them after the pass answers, so no later round of this pass
    /// may spend them first.
    promised: u64,
    /// What each asked-for item's stream is to seal, by its identifier in
    /// the library (R-1080-C39).
    planned: BTreeMap<String, Planned>,
}

impl Pass {
    fn new() -> Self {
        Self {
            confirmed: 0,
            stopped: wire::DrainStop::Empty,
            acked_at_ms: None,
            need: Vec::new(),
            asked_for: BTreeSet::new(),
            waiting_bytes: BTreeSet::new(),
            promised: 0,
            planned: BTreeMap::new(),
        }
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
        Stop::Refused(refusal) => {
            tracing::warn!(code = %refusal, "the gateway refused a part; the pass stops");
            Ok(Some(wire::DrainStop::Unreachable))
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
    // THE LAST PASS'S PLAN IS SPENT: a pass that answers early asks for
    // nothing, and a stream with no plan seals the way a first read does.
    handle.plan_library(BTreeMap::new());
    let started = Instant::now();
    let deadline = deadline_of(request.deadline_ms, started);
    let conditions = Conditions::of(request);
    let plane = handle.plane();
    let ledger = plane.ledger()?;
    conditions.remember(&ledger)?;
    let spool = plane.spool()?;
    if let Some((_, epoch)) = super::moved(&ledger)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    let mut pass = Pass::new();
    let destinations = ledger.destinations().map_err(plane_error)?;
    let reached = if destinations.is_empty() {
        Err(Unreached::Silent)
    } else {
        link::reach(&destinations, &ledger, keyring.vault_id(), runtime)?
    };
    ledger
        .set_meta(
            REACHABLE_KEY,
            match &reached {
                Ok(_) => REACH_ANSWERED,
                // Nothing paired is not a gateway to blame.
                Err(_) if destinations.is_empty() => REACH_ANSWERED,
                Err(Unreached::Silent) => REACH_SILENT,
                Err(Unreached::Untrusted) => REACH_UNTRUSTED,
            },
        )
        .map_err(plane_error)?;
    let reached = match reached {
        Ok(reached) => reached,
        Err(unreached) => {
            // NOTHING PAIRED, NOTHING ANSWERED, OR NOT THE PINNED GATEWAY:
            // nothing is sealed for nobody, and the spool is left exactly as
            // it was.
            pass.stopped = match unreached {
                Unreached::Silent => wire::DrainStop::Unreachable,
                Unreached::Untrusted => wire::DrainStop::Untrusted,
            };
            return answer(&spool, pass);
        }
    };
    let outcome = pass_over(
        handle,
        keyring,
        plane,
        &ledger,
        &spool,
        &reached,
        &conditions,
        deadline,
        &mut pass,
    );
    match outcome {
        Ok(()) => {
            handle.plan_library(std::mem::take(&mut pass.planned));
            if pass.stopped == wire::DrainStop::Untrusted {
                // PART-WAY THROUGH, ANOTHER MACHINE ANSWERED: status says so
                // until a pass reaches the pinned gateway again.
                ledger
                    .set_meta(REACHABLE_KEY, REACH_UNTRUSTED)
                    .map_err(plane_error)?;
            }
            answer(&spool, pass)
        }
        Err(CoreError::VaultMoved { current_epoch, .. }) => {
            // FROZEN, AND REMEMBERED: the ledger keeps the refusal, so status
            // draws the phone read-only and every pass refuses at once.
            ledger
                .set_moved(&reached.destination.gateway_id, current_epoch)
                .map_err(plane_error)?;
            Err(CoreError::VaultMoved {
                current_epoch,
                moved_at_ms: reached.gateway_ms,
            })
        }
        Err(other) => Err(other),
    }
}

#[allow(clippy::too_many_arguments)]
fn pass_over(
    handle: &Handle,
    keyring: &Keyring,
    plane: &Plane,
    ledger: &Ledger,
    spool: &Spool,
    reached: &Reached,
    conditions: &Conditions,
    deadline: Instant,
    pass: &mut Pass,
) -> Result<()> {
    let store = &reached.store;
    let budget = plane.budget();
    let files = handle.with_vault(|vault| content_files(vault).map_err(plane_error))?;

    // 1. THE RECORDS, when the link may carry them.
    if conditions.may_move(Kind::Records) {
        if snapshot_due(ledger, store.gateway_id(), conditions.snapshot)? {
            take_snapshot(handle, keyring, plane, ledger, spool, store, budget)?;
        }
        let moved =
            mover::move_queue_where(ledger, spool, store, deadline, &SystemClock, &|part| {
                part.handed_off_ms.is_none() && Kind::of_part(part) == Kind::Records
            })
            .map_err(plane_error)?;
        pass.count(moved.confirmed.len());
        if let Some(stop) = stop_of(&moved.stopped)? {
            pass.stopped = stop;
            return Ok(());
        }
        settle_newest(ledger, store, keyring, &files, pass)?;
    }

    // 2. THE MEDIA, in rounds: seal what fits the spool, move it, again.
    let bytes = handle.bytes();
    loop {
        let sealed = prepare(
            &files,
            ledger,
            spool,
            store,
            &keyring.backup,
            bytes.as_ref().map(centraid_blobs::ContentBytes::store),
            conditions,
            budget,
            deadline,
            pass,
        )?;
        if Instant::now() >= deadline {
            pass.stopped = wire::DrainStop::Deadline;
            return Ok(());
        }
        let moved =
            mover::move_queue_where(ledger, spool, store, deadline, &SystemClock, &|part| {
                let kind = Kind::of_part(part);
                part.handed_off_ms.is_none() && kind != Kind::Records && conditions.may_move(kind)
            })
            .map_err(plane_error)?;
        pass.count(moved.confirmed.len());
        if let Some(stop) = stop_of(&moved.stopped)? {
            pass.stopped = stop;
            return Ok(());
        }
        // A ROUND THAT MOVED PARTS FREED ROOM, so one more prepare asks for
        // the next window of a library item larger than the spool
        // (R-1080-C39) before the pass answers; a round that did neither is
        // the end.
        if sealed == 0 && moved.confirmed.is_empty() {
            return Ok(());
        }
    }
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

/// Whether a snapshot is due. One the shell asked for (`wants_snapshot`)
/// always is; otherwise
/// one is due an hour after the newest a head named, and not while a younger
/// one is still on its way whole — every part of it queued or held.
fn snapshot_due(ledger: &Ledger, gateway_id: &str, wanted: bool) -> Result<bool> {
    if wanted {
        return Ok(true);
    }
    let now = now_ms();
    let snapshots = ledger.snapshots().map_err(plane_error)?;
    if let Some(newest) = snapshots.last()
        && newest.acked_ms.is_none()
        && now.saturating_sub(newest.taken_at_ms) < SNAPSHOT_EVERY_MS
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
    let last_set = snapshots
        .iter()
        .filter(|snapshot| snapshot.acked_ms.is_some())
        .map(|snapshot| snapshot.taken_at_ms)
        .max();
    Ok(last_set.is_none_or(|at| now.saturating_sub(at) >= SNAPSHOT_EVERY_MS))
}

/// Copy the vault, describe it, ask the gateway what it holds of it, and spool
/// the rest. The vault is held for the copy alone. A snapshot taken before
/// this one that never reached the head is forgotten, and its parts this one
/// does not share leave the queue.
fn take_snapshot(
    handle: &Handle,
    keyring: &Keyring,
    plane: &Plane,
    ledger: &Ledger,
    spool: &Spool,
    store: &GatewayStore,
    budget: u64,
) -> Result<()> {
    let scratch = plane.scratch_dir();
    // A COPY A CRASH LEFT is the only thing that can be here: passes are one
    // at a time (`Handle`'s drain guard).
    let _ = std::fs::remove_dir_all(&scratch);
    let copied = handle.with_vault(|vault| snapshot::copy(vault, &scratch).map_err(plane_error))?;
    let outcome = (|| -> Result<()> {
        let taken = snapshot::describe(&copied, &keyring.backup, &keyring.vault_hex(), APP)
            .map_err(plane_error)?;
        let planned = snapshot::plan(&taken, store).map_err(plane_error)?;
        snapshot::confirm_held(&taken, &planned, ledger, store.gateway_id(), now_ms())
            .map_err(plane_error)?;
        let older: Vec<LedgerSnapshot> = ledger
            .snapshots()
            .map_err(plane_error)?
            .into_iter()
            .filter(|snapshot| snapshot.acked_ms.is_none() && snapshot.name != taken.manifest_name)
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
        let mut keep = taken.manifest.range_names();
        keep.insert(taken.manifest_name);
        for old in older {
            for name in names_of_snapshot(&old)?.difference(&keep) {
                ledger.dequeue(name).map_err(plane_error)?;
                spool.remove(name).map_err(plane_error)?;
            }
            ledger.forget_snapshot(&old.name).map_err(plane_error)?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    outcome
}

/// Move the head to the newest snapshot that is not the head yet, once every
/// part of it is confirmed at `store`; and when it moves, let retention drop
/// what it no longer keeps.
fn settle_newest(
    ledger: &Ledger,
    store: &GatewayStore,
    keyring: &Keyring,
    files: &[ContentFile],
    pass: &mut Pass,
) -> Result<()> {
    let Some(newest) = ledger
        .snapshots()
        .map_err(plane_error)?
        .into_iter()
        .rfind(|snapshot| snapshot.acked_ms.is_none())
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
            retain(ledger, store, &keyring.backup, files)?;
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

/// **Retention, then garbage** (#1080, "Retention"): keep 7 daily, 4 weekly
/// and 6 monthly snapshots; when that drops one, delete every name nothing
/// kept refers to — the kept manifests and their ranges, every name the
/// vault's content implies, and everything still on its way.
fn retain(
    ledger: &Ledger,
    store: &GatewayStore,
    keys: &BackupKeys,
    files: &[ContentFile],
) -> Result<()> {
    let registered = store.snapshots().map_err(store_error)?;
    let decided = retention::keep(&registered, now_ms());
    if decided.drop.is_empty() {
        return Ok(());
    }
    plane_store::delete_all(store, &decided.drop).map_err(store_error)?;
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
    for snapshot in ledger.snapshots().map_err(plane_error)? {
        if snapshot.acked_ms.is_none() {
            live.extend(names_of_snapshot(&snapshot)?);
        }
    }
    let live = retention::live_names(keys, live, files.iter().map(|file| (file.h, file.len)));
    let listed = plane_store::list_all(store).map_err(store_error)?;
    let garbage = retention::garbage(listed.iter().map(|entry| entry.name), &live);
    let deleted = plane_store::delete_all(store, &garbage).map_err(store_error)?;
    tracing::info!(
        dropped = decided.drop.len(),
        collected = deleted.deleted.len(),
        "retention dropped snapshots and collected what nothing kept"
    );
    Ok(())
}

// ─── the media ──────────────────────────────────────────────────────────────

/// Seal what no gateway holds of the vault's files into the spool, up to its
/// budget: derivatives first, the grid, then originals, newest first within
/// each. Answers how many parts were sealed.
#[allow(clippy::too_many_arguments)]
fn prepare(
    files: &[ContentFile],
    ledger: &Ledger,
    spool: &Spool,
    store: &GatewayStore,
    keys: &BackupKeys,
    bytes: Option<&centraid_blobs::ByteStore>,
    conditions: &Conditions,
    budget: u64,
    deadline: Instant,
    pass: &mut Pass,
) -> Result<usize> {
    let mut confirmed = ledger.confirmed_anywhere().map_err(plane_error)?;
    let queued: BTreeSet<Name> = ledger
        .queued()
        .map_err(plane_error)?
        .iter()
        .map(|part| part.name)
        .collect();
    let wanted = |file: &ContentFile, confirmed: &BTreeSet<Name>| -> Vec<(u32, Name)> {
        names_of(keys, &file.h, file.len)
            .into_iter()
            .zip(0_u32..)
            .filter(|(name, _)| !confirmed.contains(name) && !queued.contains(name))
            .map(|(name, index)| (index, name))
            .collect()
    };
    // ASK ABOUT EVERYTHING THE MEMBER BACKS UP, SEAL ONLY WHAT THE RULE
    // ALLOWS NOW. Asking moves no bytes, so it is not the rule's to withhold:
    // a restored phone whose first pass runs off the charger may not seal a
    // video, and must still learn the gateway holds it — or the line says
    // "waiting for a charger" for a film this phone does not even hold
    // (#1080, the simulator restore).
    let unconfirmed: Vec<&ContentFile> = files
        .iter()
        .filter(|file| {
            conditions.counts(Kind::of_file(file)) && !wanted(file, &confirmed).is_empty()
        })
        .collect();

    // ASK BEFORE SEALING (#1080 ruling 7): a name the gateway holds is
    // confirmed from its answer, never sealed again. Each name once a pass.
    let mut ask: Vec<Name> = Vec::new();
    let mut sizes: BTreeMap<Name, u64> = BTreeMap::new();
    for file in &unconfirmed {
        for (_, name) in wanted(file, &confirmed) {
            if pass.asked_for.insert(name) {
                ask.push(name);
                sizes.insert(name, file.len);
            }
        }
    }
    if !ask.is_empty() {
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
    }

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
        if Instant::now() >= deadline {
            break;
        }
        let parts = wanted(file, &confirmed);
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
                file,
                &indices,
                keys,
                spool,
                ledger,
                budget,
                deadline,
                &mut held_bytes,
            )?;
            continue;
        }
        let local = ledger.local(&file.h).map_err(plane_error)?;
        if let Some(local) = local.filter(|local| local.source == LocalSource::Os) {
            let first = names_of(keys, &file.h, file.len)
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
    plan_library(&library, budget.saturating_sub(held_bytes), pass);
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
fn plan_library(asks: &[LibraryAsk<'_>], mut room: u64, pass: &mut Pass) {
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
        let window = window_within(room, ask.file.len, &ask.parts);
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
    file: &ContentFile,
    indices: &BTreeSet<u32>,
    keys: &BackupKeys,
    spool: &Spool,
    ledger: &Ledger,
    budget: u64,
    deadline: Instant,
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
        let len = sealed::part_len(file.len, index).map_err(|error| invariant("cut", &error))?;
        if !indices.contains(&index) {
            reader
                .seek(SeekFrom::Current(i64::try_from(len).unwrap_or(i64::MAX)))
                .map_err(|error| invariant("seek", &error))?;
            continue;
        }
        if Instant::now() >= deadline || *held_bytes >= budget {
            break;
        }
        let name = part_name(keys, &file.h, index);
        let writer = spool.writer(&name).map_err(plane_error)?;
        let mut sealer = PartSealer::new(keys, index, len, false, writer)
            .map_err(|error| invariant("begin", &error))?;
        let mut left = len;
        while left > 0 {
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
    let confirmed = ledger.confirmed_anywhere().map_err(plane_error)?;
    let queued: BTreeSet<Name> = ledger
        .queued()
        .map_err(plane_error)?
        .iter()
        .map(|part| part.name)
        .collect();
    let mut count = 0;
    for part in &sealed.parts {
        if confirmed.contains(&part.name) || queued.contains(&part.name) {
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
    // THE GATEWAY REACHED LAST: the one `reconcile` just answered from.
    let Some(target) = ledger
        .destinations()
        .map_err(plane_error)?
        .into_iter()
        .enumerate()
        .max_by_key(|(order, destination)| {
            (
                destination.last_seen_ms.unwrap_or(0),
                std::cmp::Reverse(*order),
            )
        })
        .map(|(_, destination)| destination)
    else {
        return Ok(wire::HandoffResponse { parts: Vec::new() });
    };
    let conditions = Conditions::remembered(&ledger)?;
    let store = GatewayStore::for_destination(&target, keyring.vault_id(), runtime)?;
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
        let acknowledged = matches!(settled.http_status, 200 | 201)
            || (settled.http_status == 409 && settled.error == "NAME_TAKEN");
        match destination {
            Some(destination) if acknowledged => {
                ledger
                    .confirm(&name, &destination.gateway_id, now_ms(), part.size)
                    .map_err(plane_error)?;
                ledger.dequeue(&name).map_err(plane_error)?;
                spool.remove(&name).map_err(plane_error)?;
                answer.confirmed += 1;
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
    Ok(answer)
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
            return Ok(unreachable);
        }
        Err(other) => return Err(plane_error(other)),
    };
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
