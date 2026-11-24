//! **THE DRIVER: ONE PASS OVER EVERY GATEWAY** (`drain`, spec §6,
//! [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! The engine (`centraid_vault::backup::engine`) is the library's: it decides what a gateway is
//! owed, sends it, and is the only thing that confirms. This file is the I/O around it, and
//! nothing else:
//!
//! | Step | Who |
//! |---|---|
//! | the windows and the deadline | here: a pass stops between two engine steps, never inside one |
//! | the member's rule per class | here, as [`Conditions`], read by the engine as a `Policy` |
//! | a snapshot when one is due | the library's `snapshot::take`, under the vault, briefly |
//! | the gateways' answers | `link::reach_all`, every gateway at once under one cap |
//! | the work | `engine::GatewayPass`, one per reached gateway, stepped here in the order of §6.3 |
//! | read-back, retention, housekeeping | the library's, after a pass that ended whole |
//! | photo-library originals | `need_bytes`: the shell streams them in through the stage door, which seals into staging (`crate::stage`) |
//! | the OS's uploads | [`write_os_bundles`](centraid_vault::backup::engine::write_os_bundles), handed back as `os_bundles` |
//! | the status | `phone::status`, read once at the end |
//!
//! **Only the engine confirms (R7).** Nothing the OS reports of a bundle file reaches this file as
//! a fact: it wakes a pass, which re-reads each head and diffs.
//!
//! **A pass holds the vault only to take a snapshot.** The engine's source reads go through a
//! carrier vault that holds nothing but the content store, so a pass that runs for minutes never
//! stops the app's own commits.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{Class, Name, PlaintextHash};
use centraid_vault::Vault;
use centraid_vault::backup::PlaneError;
use centraid_vault::backup::directory::{Directory, Entry as DirectoryEntry};
use centraid_vault::backup::engine::{
    self, Env, GatewayPass, Link, OS_BUNDLES, PassStats, Policy, Step, Stop,
};
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::retention::{self, Collected};
use centraid_vault::backup::snapshot::{self, Options};
use centraid_vault::backup::state::{DeviceState, Gateway, LocalSource};
use centraid_vault::backup::store::{NAMES_PER_CALL, Store as _};
use centraid_vault::backup::tree;

use super::link::{self, Fleet};
use super::{Keyring, Plane, plane_error, status};
use crate::error::{CoreError, Result};
use crate::handle::{Cancellation, HandleState as Handle};
use crate::stage::Planned;

/// How long a changed vault settles before the next snapshot of it, unless something asks for
/// one at once: a burst of typing is one snapshot (the conductor's debounce keeps the passes
/// themselves apart).
pub const SNAPSHOT_SETTLE_MS: u64 = 30_000;

/// How long a gateway goes between two retention collections. Collecting lists every name the
/// gateway holds, so it is not worth doing on every pass.
pub const COLLECT_EVERY_MS: u64 = 6 * 60 * 60 * 1000;

/// The most library items one pass asks the shell to stream.
pub const NEED_BYTES_MAX: usize = 64;

/// The most originals a restore's third phase brings back in one pass.
pub const ORIGINALS_PER_PASS: usize = 32;

/// How many engine steps make one window: a chunk is read and sealed once per window and sent
/// to every gateway that owes it.
pub const WINDOW_STEPS: usize = 8;

/// The member's rule and the link, as the pass saw them (§6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conditions {
    pub rule: wire::TransferRule,
    pub metered: bool,
    pub charging: bool,
    /// The member tapped "Back up now" in this pass, and nothing else sets it.
    pub asked: bool,
    /// The member left videos out of the backup.
    pub exclude_videos: bool,
}

impl Conditions {
    /// The rule a request carries. An unspecified rule is Wi-Fi only.
    #[must_use]
    pub fn of(request: &wire::DrainRequest) -> Self {
        let rule = match wire::TransferRule::try_from(request.rule) {
            Ok(wire::TransferRule::Unspecified) | Err(_) => wire::TransferRule::WifiOnly,
            Ok(rule) => rule,
        };
        Self {
            rule,
            metered: request.metered,
            charging: request.charging,
            asked: request.asked,
            exclude_videos: request.exclude_videos,
        }
    }

    /// What the last request said, with `asked` as the status read knows it: the pass running
    /// now is the tap's, a pass that ended is not. Before any pass the reading is the expensive
    /// one (metered, not charging), as a shell that cannot tell would send it.
    #[must_use]
    pub fn remembered(plane: &Plane, asking: bool) -> Self {
        let mut held = plane.remembered().unwrap_or(Self {
            rule: wire::TransferRule::WifiOnly,
            metered: true,
            charging: false,
            asked: false,
            exclude_videos: false,
        });
        held.asked = asking;
        held
    }

    /// The rule as the engine reads it. Excluded videos are left out of the snapshot's originals
    /// class rather than blocked here, so an unmetered pass stays [`Link::Unmetered`] (keeping
    /// full read-back sampling) and confirms `oroot` once all included originals are held.
    #[must_use]
    pub const fn policy(&self) -> Policy {
        let photos_on_cellular = matches!(self.rule, wire::TransferRule::WifiAndCellularPhotos);
        Policy {
            link: if self.metered {
                Link::Metered
            } else {
                Link::Unmetered
            },
            photos_on_cellular,
            asked: self.asked,
        }
    }

    /// Whether `class` of this kind of file may cross now. `Manual` keeps every original home
    /// until the member taps.
    #[must_use]
    pub fn admits(&self, class: Class, video: bool) -> bool {
        if class == Class::Originals {
            if self.rule == wire::TransferRule::Manual && !self.asked {
                return false;
            }
            if self.exclude_videos && video {
                return false;
            }
        }
        self.policy().allows(class, video)
    }

    /// Whether a video is part of the backup at all (the member's "Include videos").
    #[must_use]
    pub const fn counts(&self, video: bool) -> bool {
        !(video && self.exclude_videos)
    }
}

/// What the vault says about itself, for deciding whether a snapshot is owed.
struct History {
    writes: u64,
}

fn history(vault: &Vault) -> Result<History> {
    let (writes, _) = vault
        .read(centraid_vault::clock::writes_and_written_at)
        .map_err(|error| plane_error(error.into()))?;
    Ok(History {
        writes: u64::try_from(writes).unwrap_or(0),
    })
}

/// The directory of gateways a snapshot writes (E8): every paired gateway, never a token.
fn directory_of(state: &DeviceState) -> Result<Directory> {
    let entries = state
        .gateways()
        .map_err(plane_error)?
        .into_iter()
        .map(|gateway| DirectoryEntry {
            pin: centraid_gateway::rules::ids::Pin::of(&gateway.cert_der).to_string(),
            gateway_id: gateway.gateway_id,
            addrs: gateway.addrs,
            label: gateway.label,
        })
        .collect();
    Directory::new(entries).map_err(plane_error)
}

/// Whether a snapshot is due (§5): never while the vault is unchanged and nothing owes one; at
/// once when asked, when a gateway's directory is stale, or when something staged since the last
/// snapshot needs listing; otherwise once a change has settled.
fn snapshot_due(
    plane: &Plane,
    state: &DeviceState,
    vault: &Vault,
    keyring: &Keyring,
    request: &wire::DrainRequest,
    now_ms: u64,
) -> Result<bool> {
    let gateways = state.gateways().map_err(plane_error)?;
    if gateways.is_empty() {
        return Ok(false);
    }
    let device = state.device().map_err(plane_error)?;
    let Some((name, _)) = device.newest else {
        return Ok(true);
    };
    let dirty = gateways.iter().any(|gateway| gateway.directory_dirty);
    let video_setting_changed =
        state.exclude_videos().map_err(plane_error)? != request.exclude_videos;
    if plane.snapshot_owed() || dirty || video_setting_changed {
        return Ok(true);
    }
    let reference = status::node_ref(state, &keyring.backup, &name);
    let Some(root) = reference.and_then(|reference| tree::root_of(state, &reference).ok()) else {
        // The newest snapshot's node is gone from the cache: only a new one can be listed.
        return Ok(true);
    };
    let changed = history(vault)?.writes != root.writes;
    if !changed {
        return Ok(false);
    }
    Ok(request.wants_snapshot || now_ms.saturating_sub(root.taken_at_ms) >= SNAPSHOT_SETTLE_MS)
}

/// A vault that holds only the content store: what the engine reads chunks through, so the
/// app's own vault is never held by a pass. Its file lives in `<stem>.scratch/` and is gone when
/// the pass is.
struct Carrier {
    vault: Option<Vault>,
    dir: std::path::PathBuf,
}

impl Carrier {
    fn open(plane: &Plane, handle: &Handle) -> Result<Self> {
        let dir = plane
            .scratch_dir()
            .join(format!("pass-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|error| plane_error(error.into()))?;
        let file = dir.join("carrier.db");
        let _ = std::fs::remove_file(&file);
        let vault = Vault::create(&file).map_err(CoreError::from)?;
        let vault = match handle.bytes() {
            Some(bytes) => vault.with_blobs(Box::new(bytes)),
            None => vault,
        };
        Ok(Self {
            vault: Some(vault),
            dir,
        })
    }

    fn vault(&self) -> &Vault {
        self.vault
            .as_ref()
            .expect("the carrier is open until it drops")
    }
}

impl Drop for Carrier {
    fn drop(&mut self) {
        drop(self.vault.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// What the stops of a pass add up to, as the shell is told.
fn stop_of(stops: &[Stop]) -> Option<wire::DrainStop> {
    let mut worst: Option<wire::DrainStop> = None;
    let rank = |stop: wire::DrainStop| match stop {
        wire::DrainStop::Refused => 4,
        wire::DrainStop::Untrusted => 3,
        wire::DrainStop::TooOld => 2,
        _ => 1,
    };
    for stop in stops {
        let this = match stop {
            Stop::Unreachable | Stop::Busy | Stop::Frozen => wire::DrainStop::Unreachable,
            Stop::Untrusted => wire::DrainStop::Untrusted,
            Stop::TooOld => wire::DrainStop::TooOld,
            Stop::PairAgain | Stop::Full | Stop::Restage | Stop::Refused(_) => {
                wire::DrainStop::Refused
            }
            // A gateway that proved a takeover stops its own pass and is told apart by the
            // status; it does not stop the others.
            Stop::Moved { .. } => continue,
        };
        if worst.is_none_or(|held| rank(this) > rank(held)) {
            worst = Some(this);
        }
    }
    worst
}

/// One pass: a snapshot when one is due, then every reached gateway's engine pass until nothing
/// the rule admits is left, the deadline, or a stop.
///
/// # Errors
/// [`CoreError::VaultMoved`] when every paired gateway superseded this phone;
/// [`CoreError::InvalidRequest`] for a request that names no rule the core reads; a cancelled
/// request; the device state's, staging's or vault's refusal.
#[allow(clippy::too_many_lines)]
pub(crate) fn run_cancellable(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::DrainRequest,
    runtime: &tokio::runtime::Handle,
    cancellation: Option<Cancellation>,
) -> Result<wire::DrainResponse> {
    let plane = handle.plane();
    let conditions = Conditions::of(request);
    plane.remember(conditions);
    let state = plane.state()?;
    let staging = plane.staging()?;
    if let Some(epoch) = super::superseded_everywhere(&state)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    let started = Instant::now();
    let deadline = (request.deadline_ms > 0).then(|| Duration::from_millis(request.deadline_ms));
    let check = || cancellation.as_ref().map_or(Ok(()), Cancellation::check);
    check()?;

    // THE TWO CLOCKS: a snapshot is dated on the phone's (the vault's own writes are, and the
    // gateway only checks it is not ahead of its own), and what a gateway confirms is dated on
    // the gateway's, the only moment a member may be shown as "backed up".
    // The vault's own clock: its writes are dated on it, and a head is compared with them.
    let phone_ms = handle.with_vault(|vault| {
        Ok(u64::try_from(vault.clock().now_ms())
            .unwrap_or(0)
            .saturating_add(super::skew_ms()))
    })?;

    // The gateways, all at once under one cap.
    let gateways = state.gateways().map_err(plane_error)?;
    let mut fleet: Fleet = link::reach_all(
        &gateways,
        &state,
        &plane.tokens(),
        keyring.vault.identity.signing(),
        runtime,
    )?;
    for reached in &mut fleet.reached {
        reached.store.set_cancellation(cancellation.clone());
    }
    let now_ms = fleet
        .reached
        .iter()
        .map(|reached| u64::try_from(reached.gateway_ms).unwrap_or(0))
        .filter(|ms| *ms > 0)
        .min()
        .unwrap_or_else(super::now_ms);

    let carrier = Carrier::open(plane, handle)?;
    let env = Env::new(
        carrier.vault(),
        &keyring.backup,
        &state,
        &staging,
        conditions.policy(),
        now_ms,
    );
    let mut room_stop = false;
    let mut restage = false;
    let mut attempts = 0_u8;
    let mut stats;
    let mut stops: Vec<Stop> = Vec::new();
    let mut stopped_gateways: BTreeSet<String> = BTreeSet::new();
    let mut deadline_hit;
    loop {
        let new_gateway = state
            .gateways()
            .map_err(plane_error)?
            .iter()
            .any(|gateway| gateway.moved_epoch.is_none() && gateway.conf.is_none());
        // A snapshot, when one is due: the vault is held for it and for nothing after.
        let due = handle
            .with_vault(|vault| snapshot_due(plane, &state, vault, keyring, request, phone_ms))?;
        if due || restage {
            let directory = directory_of(&state)?;
            let take_snapshot = || {
                handle.with_vault(|vault| {
                    Ok(snapshot::take(
                        vault,
                        &keyring.backup,
                        &state,
                        &staging,
                        &directory,
                        Options {
                            // A gateway that confirmed nothing yet is owed every range, and ranges a
                            // gateway confirmed were released: the snapshot stages them all again.
                            restage_all: restage || new_gateway,
                            // Every range is read to be staged: a clean one is not otherwise read.
                            force_full: restage || new_gateway,
                            exclude_videos: conditions.exclude_videos,
                            ..Options::at(phone_ms)
                        },
                    ))
                })
            };
            let mut outcome = take_snapshot()?;
            if matches!(outcome, Err(PlaneError::StagingFull)) {
                // Records take precedence over background media bundles: if old OS bundle files
                // (e.g. left over from before a restart) occupy staging, reclaim them and retry.
                let gone = state.rotate_os_bundles(&[]).map_err(plane_error)?;
                if !gone.is_empty() {
                    for path in gone {
                        let _ = std::fs::remove_file(path);
                    }
                    outcome = take_snapshot()?;
                }
            }
            match outcome {
                Ok(taken) => {
                    handle.note_walk(taken.ranges_read);
                    plane.set_snapshot_owed(false);
                    plane.set_no_room(false);
                    for gateway in state.gateways().map_err(plane_error)? {
                        // The directory in the new root is the one just written.
                        state
                            .set_directory_dirty(&gateway.gateway_id, false)
                            .map_err(plane_error)?;
                    }
                }
                Err(PlaneError::StagingFull) => {
                    plane.set_no_room(true);
                    room_stop = true;
                }
                Err(error) => return Err(plane_error(error)),
            }
        }

        stats = PassStats::default();
        stops.clear();
        stopped_gateways.clear();
        deadline_hit = false;
        if env.newest().map_err(plane_error)?.is_some() {
            engine::housekeeping(&env, &[]).map_err(plane_error)?;
            let mut passes: Vec<GatewayPass<'_, '_>> = Vec::new();
            for reached in &fleet.reached {
                passes.push(GatewayPass::new(&env, &reached.store).map_err(plane_error)?);
            }
            let recheck = engine::head_recheck_every(passes.len(), WINDOW_STEPS);
            let mut stepped = vec![false; passes.len()];
            let mut steps = 0_usize;
            let mut turn = 0_usize;
            'run: loop {
                check()?;
                if deadline.is_some_and(|limit| started.elapsed() >= limit) {
                    deadline_hit = passes.iter().any(|pass| !pass.is_over());
                    break;
                }
                if steps.is_multiple_of(WINDOW_STEPS) {
                    env.new_window();
                }
                if steps > 0 && steps.is_multiple_of(recheck * WINDOW_STEPS) {
                    for pass in &mut passes {
                        pass.recheck_head().map_err(plane_error)?;
                    }
                }
                // Records of every gateway before thumbnails of any, before originals of any; round
                // robin inside a class (§6.3). A class the member's rule keeps home is not owed now.
                let owed = |pass: &GatewayPass<'_, '_>| {
                    pass.next_class()
                        .filter(|class| conditions.admits(*class, false))
                };
                let Some(best) = passes.iter().filter_map(owed).min() else {
                    break;
                };
                let count = passes.len();
                for offset in 0..count {
                    let index = (turn + offset) % count;
                    if owed(&passes[index]) == Some(best) {
                        turn = index + 1;
                        steps += 1;
                        stepped[index] = true;
                        match passes[index].step().map_err(plane_error)? {
                            Step::Worked | Step::Done | Step::Restarted | Step::Stopped(_) => {}
                        }
                        continue 'run;
                    }
                }
                break;
            }
            for (pass, ran) in passes.iter().zip(stepped) {
                stats.stored += pass.stats.stored;
                stats.there += pass.stats.there;
                stats.held += pass.stats.held;
                stats.bundles += pass.stats.bundles;
                stats.waiting += pass.stats.waiting;
                if let Some(stop) = pass.stop_reason() {
                    stops.push(stop.clone());
                    stopped_gateways.insert(pass.gateway_id().to_owned());
                }
                if ran {
                    // A REFUSAL IS NAMED BY ITS REASON, at the gateway that gave it and no other.
                    // Only updated when this pass actually stepped the gateway: a zero-step pass
                    // (e.g. metered under Wi-Fi-only) must not clear an earlier refusal.
                    let refusal = match pass.stop_reason() {
                        Some(Stop::Full) => Some(wire::WaitReason::Refused),
                        Some(Stop::Refused(code)) if code == "TOO_LARGE" => {
                            Some(wire::WaitReason::TooLarge)
                        }
                        Some(Stop::Refused(_)) => Some(wire::WaitReason::RefusedOther),
                        _ => None,
                    };
                    plane.note(pass.gateway_id(), |notes| notes.refusal = refusal);
                }
            }
            drop(passes);
        }
        // A GATEWAY OWED A RANGE STAGING NO LONGER HOLDS (it was paired after the others
        // confirmed, and the ranges were released) is fed by a snapshot that stages them all
        // again: one more attempt, then the pass is what it was.
        if attempts == 0 && stops.iter().any(|stop| matches!(stop, Stop::Restage)) {
            attempts += 1;
            restage = true;
            continue;
        }
        break;
    }

    // Every gateway that is not whole at records stops the claim "backed up" on its own: the
    // engine wrote the reach; what a stop says of the member's gateway is the status's to draw.
    let moved: Vec<u64> = stops
        .iter()
        .filter_map(|stop| match stop {
            Stop::Moved { epoch } => Some(*epoch),
            _ => None,
        })
        .collect();
    if !moved.is_empty()
        && moved.len() == fleet.reached.len()
        && fleet.silent.is_empty()
        && fleet.untrusted.is_empty()
        && fleet.too_old.is_empty()
    {
        return Err(CoreError::VaultMoved {
            current_epoch: moved.into_iter().max().unwrap_or(0),
            moved_at_ms: 0,
        });
    }

    // R3, PHASE 3: the originals a restore left behind come back, newest first, a pass at a time,
    // inside the same window and under the member's rule for originals.
    if !deadline_hit && !room_stop {
        let admits = |video: bool| conditions.admits(Class::Originals, video);
        let out_of_time = || deadline.is_some_and(|limit| started.elapsed() >= limit);
        super::fetch::bring_originals(
            handle,
            keyring,
            runtime,
            cancellation.clone(),
            &admits,
            &out_of_time,
            ORIGINALS_PER_PASS,
        )?;
    }

    // Read-back and retention, only for a gateway whose pass ended whole, and retention only once
    // in a while: it lists everything the gateway holds. On a metered link, read-back only runs
    // when the member's rule allows cellular transfers (never under Wi-Fi-only or Manual).
    let read_back_allowed =
        !conditions.metered || conditions.rule == wire::TransferRule::WifiAndCellularPhotos;
    if !deadline_hit && !room_stop {
        for reached in &fleet.reached {
            check()?;
            let gateway_id = &reached.gateway.gateway_id;
            let Some(row) = state.gateway(gateway_id).map_err(plane_error)? else {
                continue;
            };
            if row.reach != centraid_vault::backup::state::Reach::Ok
                || stopped_gateways.contains(gateway_id)
            {
                continue;
            }
            if read_back_allowed && let Ok(report) = engine::read_back(&env, &reached.store) {
                plane.note(gateway_id, |notes| {
                    notes.sample_checked = u32::try_from(report.read).unwrap_or(u32::MAX);
                    notes.sample_of = u32::try_from(report.population).unwrap_or(u32::MAX);
                });
            }
            // Collecting lists everything the gateway holds: once in a while, never on a metered
            // link, and not on the first sight of a gateway.
            let last = plane.notes(gateway_id).collected_ms;
            if last == 0 {
                plane.note(gateway_id, |notes| notes.collected_ms = now_ms);
            }
            if conditions.metered || last == 0 || now_ms.saturating_sub(last) < COLLECT_EVERY_MS {
                continue;
            }
            plane.note(gateway_id, |notes| notes.collected_ms = now_ms);
            if let Ok(Collected::Doubt(why)) = retention::collect(&env, &reached.store) {
                tracing::debug!(gateway = %gateway_id, %why, "collection was left alone");
                plane.note(gateway_id, |notes| notes.manifest_unreadable = true);
            } else {
                plane.note(gateway_id, |notes| notes.manifest_unreadable = false);
            }
            if let Ok(held) = reached.store.held(None, 200) {
                plane.note(gateway_id, |notes| {
                    notes.held_count = u32::try_from(held.len()).unwrap_or(u32::MAX);
                    notes.held_purge_at_ms = held
                        .iter()
                        .map(|entry| entry.purge_after_ms)
                        .min()
                        .and_then(|ms| i64::try_from(ms).ok())
                        .unwrap_or(0);
                });
            }
        }
    }

    // WHAT THIS PASS CONFIRMED IS RELEASED NOW, not at the next pass: the sealed ranges of the
    // snapshot it took stood in staging only until a gateway held them, and the room is what a
    // library item's next window is staged into.
    if env.newest().map_err(plane_error)?.is_some() {
        engine::housekeeping(&env, &[]).map_err(plane_error)?;
    }

    // What the shell is asked to stream, and the files the OS is handed.
    let files = handle.with_vault(|vault| content_files(vault).map_err(plane_error))?;
    let (need, plan) = need_bytes(
        &state,
        &keyring.backup,
        &staging,
        &conditions,
        &files,
        &fleet,
    )?;
    handle.plan_library(plan);
    let os_bundles = if request.os_uploads {
        hand_to_the_os(
            plane,
            &env,
            &fleet,
            keyring,
            &conditions,
            &state,
            room_stop,
            &stopped_gateways,
        )?
    } else {
        for gone in state.rotate_os_bundles(&[]).map_err(plane_error)? {
            let _ = std::fs::remove_file(gone);
        }
        Vec::new()
    };

    let status =
        handle.with_vault(|vault| status::backup_status(plane, Some(vault), Some(keyring)))?;
    let stopped = if deadline_hit {
        wire::DrainStop::Deadline
    } else if room_stop {
        wire::DrainStop::Refused
    } else if fleet.reached.is_empty() {
        if !fleet.untrusted.is_empty() {
            wire::DrainStop::Untrusted
        } else if !fleet.too_old.is_empty() && fleet.silent.is_empty() {
            wire::DrainStop::TooOld
        } else if !fleet.pair_again.is_empty() && fleet.silent.is_empty() {
            wire::DrainStop::Refused
        } else {
            wire::DrainStop::Unreachable
        }
    } else if let Some(stop) = stop_of(&stops) {
        stop
    } else if !fleet.untrusted.is_empty() {
        wire::DrainStop::Untrusted
    } else {
        wire::DrainStop::Empty
    };
    let acked_at_ms = fleet
        .reached
        .iter()
        .filter_map(|reached| {
            state
                .gateway(&reached.gateway.gateway_id)
                .ok()
                .flatten()
                .and_then(|row| row.conf.map(|(_, at)| at))
        })
        .min()
        .and_then(|ms| i64::try_from(ms).ok());
    Ok(wire::DrainResponse {
        pending_bytes: status.pending_bytes,
        stopped: stopped as i32,
        acked_at_ms,
        confirmed_parts: u32::try_from(stats.stored + stats.there + stats.held).unwrap_or(u32::MAX),
        waiting_bytes_parts: u32::try_from(need.len()).unwrap_or(u32::MAX),
        need_bytes: need,
        os_bundles,
        classes: status.classes,
    })
}

/// Which library items the shell is asked to stream next, newest first, and what the stage door
/// seals from each stream.
///
/// An item is asked for when some gateway is owed a chunk of it that is not staged: its chunks
/// are not known yet (it never streamed since its import), or the tree lists them and a gateway
/// lacks some. **What a gateway lacks is asked of it** (`exists`, the engine's own question): a
/// gateway's confirmed root says nothing of the chunks of an item that is not whole yet, and a
/// film larger than staging would otherwise never move past its first window. A staged chunk
/// every paired gateway holds is released here, so the next window has room.
///
/// The plan names exactly the chunks owed, so a large video that does not fit staging streams a
/// window at a time and never restages a chunk a gateway holds.
fn need_bytes(
    state: &DeviceState,
    keys: &centraid_media::sealed::BackupKeys,
    staging: &centraid_vault::backup::staging::Staging,
    conditions: &Conditions,
    files: &[ContentFile],
    fleet: &Fleet,
) -> Result<(Vec<wire::NeedBytes>, BTreeMap<String, Planned>)> {
    let mut need = Vec::new();
    let mut plan = BTreeMap::new();
    let paired: Vec<Gateway> = state
        .gateways()
        .map_err(plane_error)?
        .into_iter()
        .filter(|gateway| gateway.moved_epoch.is_none())
        .collect();
    if paired.is_empty() {
        return Ok((need, plan));
    }
    let by_hash: BTreeMap<PlaintextHash, &ContentFile> = files
        .iter()
        .filter(|file| file.is_original())
        .map(|file| (file.h, file))
        .collect();
    // THE ITEMS EVERY PAIRED GATEWAY ALREADY LISTS WHOLE are done, and cost no question: an idle
    // pass asks nothing.
    let whole: Vec<BTreeSet<PlaintextHash>> = paired
        .iter()
        .map(|gateway| status::listed_hashes(state, keys, gateway.oroot, Class::Originals))
        .collect();
    // The library items the shell could be asked for, newest first, and the chunks each lists.
    let mut candidates: Vec<(String, &ContentFile, Vec<Name>)> = Vec::new();
    let mut locals = state.locals().map_err(plane_error)?;
    locals.reverse();
    for local in locals {
        let (LocalSource::Os, Some(os_ref)) = (local.source, local.os_ref.clone()) else {
            continue;
        };
        let Some(file) = by_hash.get(&local.hash) else {
            continue;
        };
        if whole.iter().all(|listed| listed.contains(&local.hash)) {
            // Whatever of it is still staged is released below, by name.
            let refs = state.os_chunks(&local.hash).map_err(plane_error)?;
            for reference in refs {
                staging.release(&reference.name).map_err(plane_error)?;
                state.unstage(&reference.name).map_err(plane_error)?;
            }
            continue;
        }
        let names = state
            .os_chunks(&local.hash)
            .map_err(plane_error)?
            .iter()
            .map(|reference| reference.name)
            .collect();
        candidates.push((os_ref, file, names));
    }
    // WHAT EVERY PAIRED GATEWAY HOLDS: a gateway not reached, or that did not answer, holds
    // nothing as far as this pass knows.
    let listed: BTreeSet<Name> = candidates
        .iter()
        .flat_map(|(_, _, names)| names.iter().copied())
        .collect();
    let mut held_everywhere = listed.clone();
    for gateway in &paired {
        let reached = fleet
            .reached
            .iter()
            .find(|reached| reached.gateway.gateway_id == gateway.gateway_id);
        let mut lacks: BTreeSet<Name> = BTreeSet::new();
        match reached {
            Some(reached) => {
                let names: Vec<Name> = listed.iter().copied().collect();
                for batch in names.chunks(NAMES_PER_CALL) {
                    match reached.store.exists(batch) {
                        Ok(missing) => lacks.extend(missing),
                        Err(_) => lacks.extend(batch.iter().copied()),
                    }
                }
            }
            None => lacks.clone_from(&listed),
        }
        held_everywhere.retain(|name| !lacks.contains(name));
    }
    for name in staging.names().map_err(plane_error)? {
        if held_everywhere.contains(&name) {
            staging.release(&name).map_err(plane_error)?;
            state.unstage(&name).map_err(plane_error)?;
        }
    }
    for (os_ref, file, names) in candidates {
        if need.len() >= NEED_BYTES_MAX {
            break;
        }
        if !conditions.admits(Class::Originals, file.video) {
            continue;
        }
        let owed: Option<BTreeSet<Name>> = if names.is_empty() {
            None
        } else {
            let owed: BTreeSet<Name> = names
                .iter()
                .copied()
                .filter(|name| !held_everywhere.contains(name))
                .filter(|name| !staging.contains(name))
                .collect();
            if owed.is_empty() {
                continue;
            }
            Some(owed)
        };
        plan.insert(
            os_ref.clone(),
            Planned {
                h: file.h,
                len: file.len,
                owed,
            },
        );
        need.push(wire::NeedBytes {
            content_hash: file.h.as_bytes().to_vec(),
            os_ref,
            media_type: file.media_type.clone(),
            size: file.len,
        });
    }
    Ok((need, plan))
}

/// Write the OS's bundle files for the classes still owed and describe each as one whole
/// `POST bundle`, at most [`OS_BUNDLES`] in all (§6.5). Previous pass files not referenced by
/// this pass go at the end: a task still reading one only fails and wakes a pass, while a file
/// still needed in this pass is kept intact.
#[allow(clippy::too_many_arguments)]
fn hand_to_the_os(
    plane: &Plane,
    env: &Env<'_>,
    fleet: &Fleet,
    keyring: &Keyring,
    conditions: &Conditions,
    state: &DeviceState,
    room_stop: bool,
    stopped_gateways: &BTreeSet<String>,
) -> Result<Vec<wire::HandoffPart>> {
    let mut parts = Vec::new();
    let mut written: Vec<(Name, std::path::PathBuf)> = Vec::new();
    let mut written_paths: BTreeSet<std::path::PathBuf> = BTreeSet::new();
    let mut staging_full = false;
    'gateways: for reached in &fleet.reached {
        if parts.len() >= OS_BUNDLES {
            break 'gateways;
        }
        let gateway_id = &reached.gateway.gateway_id;
        let Some(row) = state.gateway(gateway_id).map_err(plane_error)? else {
            continue;
        };
        if row.reach != centraid_vault::backup::state::Reach::Ok
            || stopped_gateways.contains(gateway_id)
        {
            continue;
        }
        let debt = engine::debt(env, gateway_id).map_err(plane_error)?;
        for (class, owed) in [
            (Class::Thumbnails, debt.thumbnails),
            (Class::Originals, debt.originals),
        ] {
            if parts.len() >= OS_BUNDLES {
                break 'gateways;
            }
            if owed == 0 || !conditions.admits(class, false) {
                continue;
            }
            let remaining = OS_BUNDLES - parts.len();
            let (bundles, full) =
                engine::write_os_bundles_capped(env, &reached.store, class, remaining)
                    .map_err(plane_error)?;
            for bundle in bundles {
                if parts.len() >= OS_BUNDLES {
                    break 'gateways;
                }
                let name = bundle
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let Ok(handoff) = reached
                    .store
                    .client()
                    .presign_bundle(&keyring.vault_id(), bundle.bytes)
                else {
                    // Do not unlink here: an earlier part may share this deterministic path,
                    // and `rotate_os_bundles` below unlinks every bundle not in `written`.
                    continue;
                };
                if let Ok(bundle_name) = Name::from_hex(&name)
                    && written_paths.insert(bundle.path.clone())
                {
                    written.push((bundle_name, bundle.path.clone()));
                }
                parts.push(wire::HandoffPart {
                    name,
                    path: bundle.path.to_string_lossy().into_owned(),
                    url: handoff.url,
                    method: handoff.method,
                    headers: handoff
                        .headers
                        .into_iter()
                        .map(|(name, value)| wire::Header { name, value })
                        .collect(),
                    size: bundle.bytes,
                    gateway_id: gateway_id.clone(),
                    vault_id: keyring.vault_hex(),
                    allows_cellular: conditions.rule == wire::TransferRule::WifiAndCellularPhotos
                        && !bundle.has_video,
                });
                if parts.len() >= OS_BUNDLES {
                    break 'gateways;
                }
            }
            if full {
                staging_full = true;
                break 'gateways;
            }
        }
    }
    if staging_full {
        plane.set_no_room(true);
    } else if !room_stop {
        plane.set_no_room(false);
    }
    for gone in state.rotate_os_bundles(&written).map_err(plane_error)? {
        let _ = std::fs::remove_file(gone);
    }
    Ok(parts)
}
