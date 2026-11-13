//! CHECK MY BACKUP (#1188, B6, ruling 18): prove each backup device's backup opens, without
//! waiting for the day it is needed.
//!
//! For each paired device the phone can reach:
//!
//! 1. **Restore the records into a scratch copy** and run every check a restore runs
//!    ([`fetch_and_assemble`]), then open the copy through the ladder once. The copy is beside the
//!    vault, never the vault: nothing here writes the vault file, its ledger's confirmations apart
//!    (below), or moves a writer epoch.
//! 2. **Confirm by name** that the device holds every file the copy's records refer to.
//! 3. **Read back and open a sample** of those files, whole: every part, the file's hash.
//!
//! A file the device no longer holds, or whose bytes no longer open, is **unconfirmed** for that
//! device, so the next pass sends it again. That is the only thing a check writes.
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
use centraid_media::sealed::Assembler;
use centraid_vault::Vault;
use centraid_vault::backup::PlaneError;
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::naming::{BackupKeys, Name, names_of};
use centraid_vault::backup::restore::{RestoreError, fetch_and_assemble};
use centraid_vault::backup::state::{DeviceState, Gateway as Destination};
use centraid_vault::backup::store::{self, Store, StoreError};

use super::drain::{Kind, allows_cellular};
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
        if request.metered && !allows_cellular(Kind::Original { video: false }, rule) {
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
            Ok(()) if at == 0 => {
                progress.step();
                return files_of(
                    destination,
                    keyring,
                    &store,
                    &scratch,
                    newest_ms,
                    request,
                    cancellation,
                    progress,
                    ledger,
                );
            }
            // THE NEWEST WOULD NOT OPEN and an older one does: the member is told both.
            Ok(()) => {
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

/// Fetch, rebuild, check and open one snapshot at `file`.
fn open_copy(
    store: &GatewayStore,
    keys: &BackupKeys,
    name: &Name,
    file: &Path,
) -> std::result::Result<(), CheckFailed> {
    match fetch_and_assemble(store, keys, name, file) {
        Ok(_) => {}
        Err(error) if heard_nothing(&error) => return Err(CheckFailed::Silent),
        Err(_) => return Err(CheckFailed::Wont),
    }
    // THE LADDER, ONCE: a copy this build would not open is a backup that will not open.
    Vault::open(file)
        .and_then(Vault::close)
        .map_err(|_| CheckFailed::Wont)
}

/// Names of every part of `file`.
fn parts_of(keys: &BackupKeys, file: &ContentFile) -> Vec<Name> {
    names_of(keys, &file.h, file.len)
}

/// Which files to open: evenly spread, never more than [`SAMPLE_FILES`], each under
/// [`SAMPLE_FILE_MAX_BYTES`], together under [`SAMPLE_TOTAL_MAX_BYTES`]. `offset` moves the
/// first pick, so two checks do not always open the same files.
#[must_use]
pub fn pick_sample(files: &[ContentFile], offset: usize) -> Vec<usize> {
    let eligible: Vec<usize> = files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.len > 0 && f.len <= SAMPLE_FILE_MAX_BYTES)
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
        let len = files[at].len;
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
    scratch: &Scratch,
    snapshot_ms: i64,
    request: &wire::CheckBackupRequest,
    cancellation: &Cancellation,
    progress: &Progress,
    ledger: &DeviceState,
) -> Result<wire::DeviceCheck> {
    let keys = &keyring.backup;
    let vault = Vault::open(scratch.file()).map_err(|error| CoreError::BackupUnreadable {
        detail: format!("the spare copy would not open: {error}"),
    })?;
    let mut files = content_files(&vault).map_err(plane_error)?;
    vault.close()?;
    // A video the member left out is not held, and the records are not wrong to name it.
    if request.exclude_videos {
        files.retain(|f| !(f.video && f.variant.is_none()));
    }
    // 2. BY NAME: which files have a part the device does not hold.
    let all: Vec<Name> = files.iter().flat_map(|f| parts_of(keys, f)).collect();
    progress.halt(cancellation)?;
    let absent: BTreeSet<Name> = match store::missing(store, &all) {
        Ok(absent) => absent,
        Err(error) if unreachable(&error) => {
            return Ok(not_run(destination, NotRun::DidNotAnswer));
        }
        Err(error) => return Err(super::store_error(error)),
    };
    let missing_files = files
        .iter()
        .filter(|f| parts_of(keys, f).iter().any(|n| absent.contains(n)))
        .count() as u64;
    // What it lacks is owed again at the next pass.
    let lacked: Vec<Name> = absent.iter().copied().collect();
    if !lacked.is_empty() {
        // The blob walk starts again, so `exists` finds what it lacks and owes it.
        ledger
            .set_cursor(&destination.gateway_id, 0)
            .map_err(plane_error)?;
    }

    // 3. A SAMPLE, READ BACK WHOLE.
    let picked = pick_sample(
        &files,
        usize::try_from(snapshot_ms.unsigned_abs()).unwrap_or(0),
    );
    let present: Vec<usize> = picked
        .into_iter()
        .filter(|at| {
            !parts_of(keys, &files[*at])
                .iter()
                .any(|n| absent.contains(n))
        })
        .collect();
    progress.plan(
        present
            .iter()
            .map(|at| parts_of(keys, &files[*at]).len() as u64)
            .sum(),
    );
    let (mut opened, mut damaged) = (0_u64, 0_u64);
    for at in present {
        progress.halt(cancellation)?;
        let file = &files[at];
        match open_file(store, keys, file, progress) {
            Ok(()) => opened += 1,
            Err(OpenFailed::Silent) => return Ok(not_run(destination, NotRun::DidNotAnswer)),
            Err(OpenFailed::Bad(part)) => {
                damaged += 1;
                // A DAMAGED COPY is deleted (a damaged name is freed at once, decision 30) and the
                // blob walk starts again, so the file is sealed and sent anew.
                if let Some(part) = part {
                    store::delete_all(store, &[part]).map_err(super::store_error)?;
                }
                ledger
                    .set_cursor(&destination.gateway_id, 0)
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
    /// A part is gone, damaged or not what its name says; the part when the gateway itself
    /// says it is damaged.
    Bad(Option<Name>),
}

/// Fetch every part of `file` and prove the whole is the file its hash names.
fn open_file(
    store: &GatewayStore,
    keys: &BackupKeys,
    file: &ContentFile,
    progress: &Progress,
) -> std::result::Result<(), OpenFailed> {
    let mut assembler = Assembler::new(file.h, file.len);
    let mut sink = std::io::sink();
    while let Some(name) = assembler.next_name(keys) {
        let mut sealed = Vec::new();
        match store.get(&name, &mut sealed) {
            Ok(_) => {}
            Err(error) if unreachable(&error) => return Err(OpenFailed::Silent),
            // A PART THE GATEWAY KNOWS IS DAMAGED is freed by a signed delete at once; one it
            // serves as sound and that will not open is the gateway's scrub to find (deleting it
            // would only hold it, decision 30).
            Err(StoreError::Damaged(_)) => return Err(OpenFailed::Bad(Some(name))),
            Err(_) => return Err(OpenFailed::Bad(None)),
        }
        assembler
            .part(keys, sealed.as_slice(), &mut sink)
            .map_err(|_| OpenFailed::Bad(None))?;
        progress.step();
    }
    assembler.finish().map_err(|_| OpenFailed::Bad(None))
}
