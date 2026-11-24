//! CHECK MY BACKUP (#1188, B6, ruling 18): prove each backup device's backup opens, without
//! waiting for the day it is needed.
//!
//! For each paired device the phone can reach:
//!
//! 1. **Restore the records into a scratch copy** from the device's tree and run every check a
//!    restore runs (`centraid_vault::backup::restore`: the pages, `db_hash` when the root has
//!    one, the schema, the census), then open the copy through the ladder once. The copy is
//!    beside the vault, never the vault: nothing here writes the vault file or moves a writer
//!    epoch.
//! 2. **Confirm by name** that the device holds every thumbnail and original chunk the tree lists.
//! 3. **Read back and open a sample** of those files, whole: every chunk against its ref, the
//!    file's hash.
//!
//! A chunk the device no longer holds, or whose bytes no longer open, **withdraws every claim**
//! for that device (`DeviceState::withdraw`), so the next pass is a recovery pass that asks the
//! device what it holds and sends the rest. That is the only thing a check writes.
//!
//! **The member's rule applies**: the check reads over the link, so a metered link under a rule
//! that keeps files off cellular is "Waiting for Wi-Fi" and not a download. **The scratch copy has
//! a stated budget** ([`scratch_budget`]): a phone without that much free space is told so and the
//! check does not start. The scratch copy is removed on every path out.
//!
//! A device that does not answer, a rule that says wait, too little space and a stop are *not
//! run*: none of them is a pass, and none is a failure of the backup.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{self, BackupKeys, Class, Name, PlaintextHash, Ref};
use centraid_vault::Vault;
use centraid_vault::backup::PlaneError;
use centraid_vault::backup::restore::{Restore, RestoreError};
use centraid_vault::backup::state::{DeviceState, Gateway as Destination};
use centraid_vault::backup::store::{NAMES_PER_CALL, Store, StoreError};
use centraid_vault::backup::tree::{self, Entry};

use super::drive::Conditions;
use super::link::GatewayStore;
use super::{Keyring, Plane, plane_error};
use crate::error::{CoreError, Result};
use crate::handle::{Cancellation, HandleState as Handle};

/// How many files a check opens per device.
pub const SAMPLE_FILES: usize = 40;

/// The largest file a check opens, and the most bytes it opens per device: a sample is the point.
pub const SAMPLE_FILE_MAX_BYTES: u64 = 8 << 20;
pub const SAMPLE_TOTAL_MAX_BYTES: u64 = 128 << 20;

/// What the scratch copy may take beyond the vault's own size.
pub const SCRATCH_HEADROOM_BYTES: u64 = 64 << 20;

/// Free space a check needs for a vault file of `vault_len` bytes: the copy, a tenth for the
/// journal the ladder may write, and the headroom.
#[must_use]
pub const fn scratch_budget(vault_len: u64) -> u64 {
    vault_len
        .saturating_add(vault_len / 10)
        .saturating_add(SCRATCH_HEADROOM_BYTES)
}

/// How far the check in hand has got, readable while it runs.
#[derive(Debug, Default)]
pub struct Progress {
    running: std::sync::atomic::AtomicBool,
    done: AtomicU64,
    total: AtomicU64,
    device: Mutex<(String, String)>,
    /// The member asked for the check to stop (`CheckBackupRequest.stop`).
    stop: std::sync::atomic::AtomicBool,
}

impl Progress {
    /// Ask the running check to stop at its next step.
    pub fn ask_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    /// Whether a stop was asked of the check in hand.
    #[must_use]
    pub fn stop_asked(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// A new check starts unstopped.
    pub fn reset(&self) {
        self.stop.store(false, Ordering::SeqCst);
    }

    /// Whether to go on: the core's own cancellation and the member's stop both end it.
    fn halt(&self, cancellation: &Cancellation) -> Result<()> {
        cancellation.check()?;
        if self.stop.load(Ordering::SeqCst) {
            return Err(CoreError::Cancelled { request_id: 0 });
        }
        Ok(())
    }

    fn begin(&self, destination: &Destination) {
        self.done.store(0, Ordering::SeqCst);
        self.total.store(1, Ordering::SeqCst);
        *self
            .device
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            (destination.gateway_id.clone(), destination.label.clone());
        self.running.store(true, Ordering::SeqCst);
    }

    fn step(&self) {
        self.done.fetch_add(1, Ordering::SeqCst);
    }

    fn plan(&self, parts: u64) {
        self.total.store(parts.saturating_add(1), Ordering::SeqCst);
    }

    fn end(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// The reading, as the wire carries it.
    #[must_use]
    pub fn read(&self) -> wire::CheckProgress {
        let (gateway_id, label) = self
            .device
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        wire::CheckProgress {
            running: self.running.load(Ordering::SeqCst),
            gateway_id,
            label,
            done: self.done.load(Ordering::SeqCst),
            total: self.total.load(Ordering::SeqCst),
        }
    }
}

type Verdict = wire::device_check::Verdict;
type NotRun = wire::device_check::NotRun;

fn not_run(destination: &Destination, why: NotRun) -> wire::DeviceCheck {
    wire::DeviceCheck {
        gateway_id: destination.gateway_id.clone(),
        label: destination.label.clone(),
        verdict: Verdict::NotRun as i32,
        not_run: why as i32,
        ..Default::default()
    }
}

/// Run the check for the devices `request` names.
///
/// # Errors
/// A core without keys or without a paired device; the ledger's refusal. A device that cannot be
/// checked is a [`wire::DeviceCheck`] that says so, not an error.
pub(crate) fn run(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::CheckBackupRequest,
    runtime: &tokio::runtime::Handle,
    cancellation: &Cancellation,
    progress: &Progress,
) -> Result<wire::CheckBackupResponse> {
    let plane = handle.plane();
    let ledger = plane.state()?;
    let mut destinations = ledger.gateways().map_err(plane_error)?;
    if !request.gateway_id.is_empty() {
        destinations.retain(|d| d.gateway_id == request.gateway_id);
    }
    let rule = match wire::TransferRule::try_from(request.rule) {
        Ok(wire::TransferRule::Unspecified) | Err(_) => wire::TransferRule::WifiOnly,
        Ok(rule) => rule,
    };
    let mut devices = Vec::new();
    let mut stopped = false;
    for destination in &destinations {
        if stopped || progress.halt(cancellation).is_err() {
            stopped = true;
            devices.push(not_run(destination, NotRun::Stopped));
            continue;
        }
        // THE LINK FIRST: nothing is read over a link the rule keeps files off.
        let conditions = Conditions {
            rule,
            metered: request.metered,
            charging: false,
            asked: false,
            exclude_videos: request.exclude_videos,
        };
        if request.metered && !conditions.policy().allows(Class::Originals, false) {
            devices.push(not_run(destination, NotRun::WaitingForWifi));
            continue;
        }
        progress.begin(destination);
        let checked = one(
            plane,
            keyring,
            destination,
            request,
            runtime,
            cancellation,
            progress,
            &ledger,
        );
        progress.end();
        match checked {
            Ok(device) => devices.push(device),
            Err(CoreError::Cancelled { .. }) => {
                stopped = true;
                devices.push(not_run(destination, NotRun::Stopped));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(wire::CheckBackupResponse {
        devices,
        progress: None,
    })
}

/// The scratch copy's directory, removed when it goes out of scope.
struct Scratch(PathBuf);

impl Scratch {
    fn make(plane: &Plane, gateway_id: &str) -> Result<Self> {
        let dir = plane.scratch_dir().join(format!("check-{gateway_id}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|error| CoreError::Invariant {
            context: format!("making {}: {error}", dir.display()),
        })?;
        Ok(Self(dir))
    }

    fn file(&self) -> PathBuf {
        self.0.join("check.db")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unreachable(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::Unreachable(_) | StoreError::Untrusted(_) | StoreError::Refused(_)
    )
}

fn heard_nothing(error: &RestoreError) -> bool {
    matches!(error, RestoreError::Plane(PlaneError::Store(store)) if unreachable(store))
}

#[allow(clippy::too_many_arguments)]
fn one(
    plane: &Plane,
    keyring: &Keyring,
    destination: &Destination,
    request: &wire::CheckBackupRequest,
    runtime: &tokio::runtime::Handle,
    cancellation: &Cancellation,
    progress: &Progress,
    ledger: &DeviceState,
) -> Result<wire::DeviceCheck> {
    // A GATEWAY THE SHELL HOLDS NO TOKEN FOR is one to pair again: it cannot be read.
    let Some(token) = plane.tokens().get(&destination.gateway_id).copied() else {
        return Ok(not_run(destination, NotRun::DidNotAnswer));
    };
    let mut store = GatewayStore::for_gateway(
        destination,
        token,
        keyring.vault.identity.signing(),
        runtime,
    )?;
    store.set_cancellation(Some(cancellation.clone()));
    let head = match store.head() {
        Ok(Some(head)) => head,
        Ok(None) => return Ok(not_run(destination, NotRun::NoBackupYet)),
        Err(error) if unreachable(&error) => {
            return Ok(not_run(destination, NotRun::DidNotAnswer));
        }
        Err(error) => return Err(super::store_error(error)),
    };
    // THE STATED BUDGET: the copy needs about the vault's own size.
    let vault_len = std::fs::metadata(&plane.vault_file).map_or(0, |m| m.len());
    if plane.free_bytes() < scratch_budget(vault_len) {
        return Ok(not_run(destination, NotRun::NeedsSpace));
    }
    let scratch = Scratch::make(plane, &destination.gateway_id)?;
    progress.halt(cancellation)?;

    // THE NEWEST BACKUP FIRST; when it will not open, the older ones, newest first, so the
    // member is told what is still good.
    let mut order = vec![(head.name, head.taken_at_ms)];
    let mut older = store.snapshots().unwrap_or_default();
    older.sort_by_key(|entry| std::cmp::Reverse(entry.taken_at_ms));
    order.extend(
        older
            .into_iter()
            .filter(|entry| entry.name != head.name)
            .map(|entry| (entry.name, entry.taken_at_ms)),
    );
    let newest_ms = i64::try_from(head.taken_at_ms).unwrap_or(0);
    for (at, (name, taken_ms)) in order.into_iter().enumerate() {
        progress.halt(cancellation)?;
        let _ = std::fs::remove_file(scratch.file());
        let copy = open_copy(&store, &keyring.backup, &name, &scratch.file());
        // A STOP IS NOT A FAILURE: whatever the copy said, the member's stop is the answer.
        progress.halt(cancellation)?;
        match copy {
            Ok(restore) if at == 0 => {
                progress.step();
                return files_of(
                    destination,
                    keyring,
                    &store,
                    &restore,
                    newest_ms,
                    request,
                    cancellation,
                    progress,
                    ledger,
                );
            }
            // THE NEWEST WOULD NOT OPEN and an older one does: the member is told both.
            Ok(_) => {
                return Ok(wire::DeviceCheck {
                    gateway_id: destination.gateway_id.clone(),
                    label: destination.label.clone(),
                    verdict: Verdict::WontOpen as i32,
                    snapshot_ms: newest_ms,
                    older_snapshot_ms: i64::try_from(taken_ms).unwrap_or(0),
                    ..Default::default()
                });
            }
            Err(CheckFailed::Silent) => return Ok(not_run(destination, NotRun::DidNotAnswer)),
            Err(CheckFailed::Wont) => {}
        }
    }
    // NOTHING THE DEVICE HOLDS OPENS.
    Ok(wire::DeviceCheck {
        gateway_id: destination.gateway_id.clone(),
        label: destination.label.clone(),
        verdict: Verdict::WontOpen as i32,
        snapshot_ms: newest_ms,
        ..Default::default()
    })
}

enum CheckFailed {
    /// The device stopped answering.
    Silent,
    /// The snapshot would not open.
    Wont,
}

/// Fetch the tree `name` names, rebuild its records at `file`, check them and open the copy.
fn open_copy<'a>(
    store: &'a GatewayStore,
    keys: &'a BackupKeys,
    name: &Name,
    file: &Path,
) -> std::result::Result<Restore<'a>, CheckFailed> {
    let stores: [&dyn Store; 1] = [store];
    let restore = match Restore::open(keys, &stores, name) {
        Ok(restore) => restore,
        Err(PlaneError::Store(error)) if unreachable(&error) => return Err(CheckFailed::Silent),
        Err(_) => return Err(CheckFailed::Wont),
    };
    match restore.records(file) {
        Ok(_) => {}
        Err(error) if heard_nothing(&error) => return Err(CheckFailed::Silent),
        Err(_) => return Err(CheckFailed::Wont),
    }
    // THE LADDER, ONCE: a copy this build would not open is a backup that will not open.
    Vault::open(file)
        .and_then(Vault::close)
        .map_err(|_| CheckFailed::Wont)?;
    Ok(restore)
}

/// One file the tree lists whole: what a sample opens.
struct Listed {
    entry: Entry,
    class: Class,
}

impl Listed {
    fn refs(&self) -> &[Ref] {
        self.entry.refs(self.class)
    }
}

/// Which files to open: evenly spread, never more than [`SAMPLE_FILES`], each under
/// [`SAMPLE_FILE_MAX_BYTES`], together under [`SAMPLE_TOTAL_MAX_BYTES`]. `offset` moves the
/// first pick, so two checks do not always open the same files. `lens` is each file's length.
#[must_use]
pub fn pick_sample(lens: &[u64], offset: usize) -> Vec<usize> {
    let eligible: Vec<usize> = lens
        .iter()
        .enumerate()
        .filter(|(_, len)| **len > 0 && **len <= SAMPLE_FILE_MAX_BYTES)
        .map(|(i, _)| i)
        .collect();
    if eligible.is_empty() {
        return Vec::new();
    }
    let want = SAMPLE_FILES.min(eligible.len());
    let stride = eligible.len() / want;
    let mut picked = Vec::with_capacity(want);
    let mut bytes = 0_u64;
    for n in 0..want {
        let at = eligible[(n * stride + offset % stride.max(1)).min(eligible.len() - 1)];
        let len = lens[at];
        if bytes.saturating_add(len) > SAMPLE_TOTAL_MAX_BYTES {
            break;
        }
        bytes += len;
        if !picked.contains(&at) {
            picked.push(at);
        }
    }
    picked
}

#[allow(clippy::too_many_arguments)]
fn files_of(
    destination: &Destination,
    keyring: &Keyring,
    store: &GatewayStore,
    restore: &Restore<'_>,
    snapshot_ms: i64,
    request: &wire::CheckBackupRequest,
    cancellation: &Cancellation,
    progress: &Progress,
    ledger: &DeviceState,
) -> Result<wire::DeviceCheck> {
    let keys = &keyring.backup;
    let entries = tree::entries_of(restore, &restore.root.blobs).map_err(plane_error)?;
    // A video the member left out is not held, and the records are not wrong to name it.
    let mut files: Vec<Listed> = Vec::new();
    for entry in entries {
        let video = entry
            .media_type
            .trim()
            .to_ascii_lowercase()
            .starts_with("video/");
        let skipped_video = request.exclude_videos && video;
        if !entry.original.is_empty() && !skipped_video {
            files.push(Listed {
                entry: entry.clone(),
                class: Class::Originals,
            });
        }
        if !entry.thumbnail.is_empty() {
            files.push(Listed {
                entry,
                class: Class::Thumbnails,
            });
        }
    }
    // 2. BY NAME: which files have a chunk the device does not hold.
    let all: Vec<Name> = files
        .iter()
        .flat_map(|file| file.refs().iter().map(|reference| reference.name))
        .collect();
    progress.halt(cancellation)?;
    let mut absent: BTreeSet<Name> = BTreeSet::new();
    for batch in all.chunks(NAMES_PER_CALL) {
        match store.exists(batch) {
            Ok(missing) => absent.extend(missing),
            Err(error) if unreachable(&error) => {
                return Ok(not_run(destination, NotRun::DidNotAnswer));
            }
            Err(error) => return Err(super::store_error(error)),
        }
    }
    let lacks = |file: &Listed| {
        file.refs()
            .iter()
            .any(|reference| absent.contains(&reference.name))
    };
    let missing_files = files.iter().filter(|file| lacks(file)).count() as u64;
    // WHAT IT LACKS WITHDRAWS EVERY CLAIM: the next pass asks the device what it holds and sends
    // the rest.
    if missing_files > 0 {
        ledger
            .withdraw(&destination.gateway_id)
            .map_err(plane_error)?;
    }

    // 3. A SAMPLE, READ BACK WHOLE.
    let lens: Vec<u64> = files.iter().map(|file| file.entry.size).collect();
    let picked = pick_sample(
        &lens,
        usize::try_from(snapshot_ms.unsigned_abs()).unwrap_or(0),
    );
    let present: Vec<usize> = picked
        .into_iter()
        .filter(|at| !lacks(&files[*at]))
        .collect();
    progress.plan(
        present
            .iter()
            .map(|at| files[*at].refs().len() as u64)
            .sum(),
    );
    let (mut opened, mut damaged) = (0_u64, 0_u64);
    for at in present {
        progress.halt(cancellation)?;
        match open_file(store, keys, &files[at], progress) {
            Ok(()) => opened += 1,
            Err(OpenFailed::Silent) => return Ok(not_run(destination, NotRun::DidNotAnswer)),
            Err(OpenFailed::Bad(name)) => {
                damaged += 1;
                // A DAMAGED COPY is deleted (a damaged name is freed at once, decision 30) and
                // every claim is withdrawn, so the file is sent anew.
                // The gateway is asked to hash the stored bytes against the digest it recorded (a
                // bit flipped on its disk is invisible to its index): only then does a signed
                // delete free the name at once instead of holding it (decisions 30 and 34).
                if let Some(name) = name {
                    let head = store.head().ok().flatten().map(|head| head.name);
                    let _ = store.check_name(&name);
                    let _ = store.delete(&[name], head.as_ref());
                }
                ledger
                    .withdraw(&destination.gateway_id)
                    .map_err(plane_error)?;
            }
        }
    }
    let verdict = if damaged > 0 {
        Verdict::DamagedFile
    } else if missing_files > 0 {
        Verdict::MissingFiles
    } else {
        Verdict::Opens
    };
    Ok(wire::DeviceCheck {
        gateway_id: destination.gateway_id.clone(),
        label: destination.label.clone(),
        verdict: verdict as i32,
        snapshot_ms,
        files_held: (files.len() as u64).saturating_sub(missing_files),
        files_opened: opened,
        files_missing: missing_files,
        files_damaged: damaged,
        ..Default::default()
    })
}

enum OpenFailed {
    Silent,
    /// A chunk is gone, damaged or not what its ref says; the name when the gateway itself says
    /// it is damaged.
    Bad(Option<Name>),
}

/// Fetch every chunk of `file` and prove the whole is the file its hash names.
fn open_file(
    store: &GatewayStore,
    keys: &BackupKeys,
    file: &Listed,
    progress: &Progress,
) -> std::result::Result<(), OpenFailed> {
    let mut hasher = blake3::Hasher::new();
    for reference in file.refs() {
        let mut object = Vec::new();
        match store.get(&reference.name, &mut object) {
            Ok(_) => {}
            Err(error) if unreachable(&error) => return Err(OpenFailed::Silent),
            // A CHUNK THE GATEWAY KNOWS IS DAMAGED is freed by a signed delete at once; one it
            // serves as sound and that will not open is the gateway's scrub to find (deleting it
            // would only hold it, decision 30).
            Err(StoreError::Damaged(_)) => return Err(OpenFailed::Bad(Some(reference.name))),
            Err(_) => return Err(OpenFailed::Bad(None)),
        }
        let plain = sealed::open(keys, reference, &object).map_err(|_| OpenFailed::Bad(None))?;
        hasher.update(&plain);
        progress.step();
    }
    if PlaintextHash::from_bytes(*hasher.finalize().as_bytes()) == file.entry.h {
        Ok(())
    } else {
        Err(OpenFailed::Bad(None))
    }
}
