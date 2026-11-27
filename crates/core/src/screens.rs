//! THE DOOR THE SCREEN RUNTIME STANDS ON (#1135, lane C2).
//!
//! `crates/screens` depends on this crate for `load` and `act`, so this crate
//! cannot depend on it: the runtime attaches itself through [`ScreenHost`], and
//! the core hands it [`ScreenCtx`] — the core's own `load`, `act`, a way to push
//! a finished update to the shell, and a way to be woken later. Nothing here
//! knows what a screen is.
//!
//! The runtime holds no reference to the handle between calls. It is driven
//! from three places, all with `&Handle` in hand: a `Request::Screen`
//! ([`ScreenHost::call`]), a change event ([`ScreenHost::changed`]) and a wake
//! ([`ScreenHost::wake`]) — the last two from [`crate::Handle::next_event`],
//! on the shell's event thread.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;

use crate::error::Result;
use crate::handle::{Handle, HandleState};

static ROOM_EXPORT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static ROOM_EXPORT_FILES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeSet<std::path::PathBuf>>,
> = std::sync::OnceLock::new();
static ROOM_EXPORT_BUDGET_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> =
    std::sync::OnceLock::new();

fn room_export_files() -> &'static std::sync::Mutex<std::collections::BTreeSet<std::path::PathBuf>>
{
    ROOM_EXPORT_FILES.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeSet::new()))
}

fn room_export_budget_lock() -> std::sync::MutexGuard<'static, ()> {
    ROOM_EXPORT_BUDGET_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn room_export_bytes(dir: &std::path::Path) -> std::io::Result<u64> {
    let mut bytes = 0_u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(0);
    };
    for entry in entries {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok(bytes)
}

fn room_export_over_budget(
    staging: &centraid_vault::backup::staging::Staging,
    blob_staging_dir: &std::path::Path,
    export_dir: &std::path::Path,
    additional: u64,
    ceiling: u64,
) -> bool {
    let Ok(staged) = staging.used() else {
        return true;
    };
    let Ok(exports) = room_export_bytes(export_dir) else {
        return true;
    };
    let Ok(blob_staging) = room_export_bytes(blob_staging_dir) else {
        return true;
    };
    staged
        .saturating_add(blob_staging)
        .saturating_add(exports)
        .saturating_add(additional)
        > ceiling
}

trait HeldContent {
    fn size(&self, hash: &str) -> Result<u64>;
    fn get(&self, hash: &str) -> Result<Vec<u8>>;
}

impl HeldContent for centraid_blobs::ContentBytes {
    fn size(&self, hash: &str) -> Result<u64> {
        centraid_vault::bytes::BlobStore::size(self, hash).map_err(|_| {
            crate::error::CoreError::Unavailable {
                reason: "held content is unavailable".to_owned(),
            }
        })
    }

    fn get(&self, hash: &str) -> Result<Vec<u8>> {
        centraid_vault::bytes::BlobStore::get(self, hash).map_err(|_| {
            crate::error::CoreError::Unavailable {
                reason: "held content is unavailable".to_owned(),
            }
        })
    }
}

fn read_held_bounded(store: &dyn HeldContent, hash: &str, max_bytes: u64) -> Result<Vec<u8>> {
    if store.size(hash)? > max_bytes {
        return Err(crate::error::CoreError::InvalidRequest {
            detail: "held content exceeds the import limit".to_owned(),
        });
    }
    let bytes = store.get(hash)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_bytes {
        return Err(crate::error::CoreError::InvalidRequest {
            detail: "held content exceeds the import limit".to_owned(),
        });
    }
    Ok(bytes)
}

pub(crate) fn clear_stale_room_exports(staging: &std::path::Path) {
    let export_dir = staging.parent().unwrap_or(staging).join("room-exports");
    let active = room_export_files()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Ok(entries) = std::fs::read_dir(export_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !active.contains(&path) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// The work of an off-thread job: it gets its own handle to the core and
/// answers bytes.
pub type OffThreadWork = Box<dyn FnOnce(&Handle) -> Vec<u8> + Send + 'static>;

/// The vault lifecycle doors a screen may call: `vault.proto` and `phone.proto`
/// request kinds, and nothing else.
#[derive(Clone, Debug)]
pub enum VaultRequest {
    Phrase(wire::PhraseRequest),
    Found(wire::FoundRequest),
    Drain(wire::DrainRequest),
    CheckBackup(wire::CheckBackupRequest),
    PairPhone(wire::PairRequest),
    Restore(wire::RestoreRequest),
    RefreshDestination(wire::RefreshDestinationRequest),
    ForgetDestination(wire::ForgetDestinationRequest),
    UndoHeld(wire::UndoHeldRequest),
    Handoff(wire::HandoffRequest),
    Settle(wire::SettleRequest),
    Reconcile(wire::ReconcileRequest),
    Pins(wire::PinsRequest),
    FetchOriginal(wire::FetchOriginalRequest),
    Releasable(wire::ReleasableRequest),
    /// Which gateways hold one original whole, read from the device state (#1209, R4): the
    /// delete warning asks it. Nothing is dialled, so it is a quick door.
    HeldWhole(wire::HeldWholeRequest),
    Released(wire::ReleasedRequest),
    LibraryAssets(wire::LibraryAssetsRequest),
    Export(wire::VaultExportRequest),
}

impl VaultRequest {
    /// The wire request this is.
    #[must_use]
    pub fn into_request(self) -> wire::Request {
        use wire::request::Kind as K;
        let kind = match self {
            Self::Phrase(r) => K::Phrase(r),
            Self::Found(r) => K::Found(r),
            Self::Drain(r) => K::Drain(r),
            Self::CheckBackup(r) => K::CheckBackup(r),
            Self::PairPhone(r) => K::PairPhone(r),
            Self::Restore(r) => K::Restore(r),
            Self::RefreshDestination(r) => K::RefreshDestination(r),
            Self::ForgetDestination(r) => K::ForgetDestination(r),
            Self::UndoHeld(r) => K::UndoHeld(r),
            Self::Handoff(r) => K::Handoff(r),
            Self::Settle(r) => K::Settle(r),
            Self::Reconcile(r) => K::Reconcile(r),
            Self::Pins(r) => K::Pins(r),
            Self::FetchOriginal(r) => K::FetchOriginal(r),
            Self::Releasable(r) => K::Releasable(r),
            Self::HeldWhole(r) => K::HeldWhole(r),
            Self::Released(r) => K::Released(r),
            Self::LibraryAssets(r) => K::LibraryAssets(r),
            Self::Export(r) => K::VaultExport(r),
        };
        wire::Request { kind: Some(kind) }
    }
}

/// What a screen runtime may ask of the core.
pub trait ScreenCtx {
    /// The mounted foreground vault's injected UTC clock, in milliseconds.
    /// A host without a mounted vault clock reports absence rather than inventing an instant.
    fn now_ms(&self) -> Option<i64> {
        None
    }

    /// Cancel a Rust-owned whole-vault export when its screen is destroyed,
    /// including forced foreground replacement where no `Left` event is sent.
    fn cancel_vault_export(&self, _job_id: &str) {}

    /// The one read.
    ///
    /// # Errors
    /// Whatever [`Handle::load`] refuses with.
    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse>;

    /// The one write.
    ///
    /// # Errors
    /// Whatever [`Handle::act`] refuses with.
    fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse>;

    /// One registered command by name, for the shell's own verbs that no app's
    /// manifest declares (`vault.export_all`): the write path `act` takes, without
    /// the manifest. An app's write is [`Self::act`]. A host without the door
    /// refuses.
    ///
    /// # Errors
    /// Whatever [`HandleState::command`] refuses with.
    fn command(
        &self,
        name: &str,
        input: &serde_json::Value,
        invoke_key: &str,
    ) -> Result<centraid_vault::commands::CommandOutcome> {
        let _ = (name, input, invoke_key);
        Err(crate::error::CoreError::Unavailable {
            reason: "this door runs no shell commands".to_owned(),
        })
    }

    fn stage_room_file(&self, bytes: &[u8]) -> Result<String> {
        let _ = bytes;
        Err(crate::error::CoreError::Unavailable {
            reason: "this door cannot stage a room export".to_owned(),
        })
    }

    fn stage_room_archive(&self) -> Result<String> {
        Err(crate::error::CoreError::Unavailable {
            reason: "this door cannot stage a room archive".to_owned(),
        })
    }

    fn held_bytes(&self, hash: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let _ = (hash, max_bytes);
        Err(crate::error::CoreError::Unavailable {
            reason: "held content is unavailable".to_owned(),
        })
    }

    fn remove_room_file(&self, path: &str) {
        let _ = path;
    }

    /// The keep list and the census of originals on this phone
    /// (`originals.proto`): a fact about this phone's disk, so it has no
    /// catalogue query. A host that does not carry the door refuses.
    ///
    /// # Errors
    /// Whatever [`Handle::call`] refuses with.
    fn originals(&self, _request: &wire::OriginalsRequest) -> Result<wire::OriginalsResponse> {
        Err(crate::error::CoreError::Unsupported {
            type_url: "originals".to_owned(),
        })
    }

    /// Where each content item's bytes are on this phone, one answer per ref in
    /// order (`content.proto`): the path a hand-off to the platform opens.
    ///
    /// # Errors
    /// Whatever [`Handle::call`] refuses with.
    fn content_urls(&self, _request: &wire::ContentUrlRequest) -> Result<wire::ContentUrls> {
        Err(crate::error::CoreError::Unsupported {
            type_url: "content_urls".to_owned(),
        })
    }

    /// A vault lifecycle door that is neither a read nor a write of an app's
    /// rows, and is quick: the 24 words (`phrase`), founding a vault. The type
    /// limits what a screen can send to `vault.proto` and `phone.proto`; there
    /// is no way through it to a write, which is `act`.
    ///
    /// # Errors
    /// Whatever the door refuses with.
    /// Whether this core holds the vault's keys.
    ///
    /// # Errors
    /// Refuses with no vault open.
    fn keyed(&self) -> Result<bool> {
        Err(crate::error::CoreError::Unavailable {
            reason: "this door holds no keys".to_owned(),
        })
    }

    fn vault(&self, request: VaultRequest) -> Result<wire::Response> {
        let _ = request;
        Err(crate::error::CoreError::Unavailable {
            reason: "this door carries no vault doors".to_owned(),
        })
    }

    /// One BOUNDED assistant call (status, start, suggest, cancel, clear, confirm, dismiss,
    /// documents), made inline. A load or a send blocks for seconds and runs from a job
    /// ([`ScreenCtx::off_thread`]) instead. A door with no assistant says so.
    ///
    /// # Errors
    /// Whatever the call refuses with.
    fn assist(&self, request: &wire::AssistRequest) -> Result<wire::AssistResponse> {
        let _ = request;
        Err(crate::error::CoreError::Unsupported {
            type_url: "assist".to_owned(),
        })
    }

    /// Run `work` on its own thread with a handle to this core, and when it is
    /// done tell the runtime ([`ScreenHost::job_done`], from `next_event`).
    /// `job` is the runtime's own number for it. For a door that waits on a
    /// gateway (a pass, a pairing, a restore): the runtime's lock is never held
    /// across the wait.
    fn off_thread(&self, job: u64, work: OffThreadWork) {
        let _ = (job, work);
    }

    /// The shelf, when this core is the door to a directory of vaults
    /// ([`crate::vaults`]): which vaults the phone holds, and a way to run a
    /// door on one that is not in front.
    fn vaults(&self) -> Option<std::sync::Arc<dyn crate::vaults::Vaults>> {
        None
    }

    /// Push a finished update to the shell's event stream.
    fn push(&self, update: wire::ScreenUpdate);

    /// Run [`ScreenHost::wake`] after `after`, on the core's tokio runtime.
    fn wake_after(&self, after: Duration);
}

/// A screen runtime, as the core sees it.
pub trait ScreenHost: Send + Sync {
    /// Answer one request from the shell.
    ///
    /// # Errors
    /// A refusal the shell should see as a typed error.
    fn call(
        &self,
        ctx: &dyn ScreenCtx,
        request: &wire::ScreenRequest,
    ) -> Result<wire::ScreenResponse>;

    /// These tables changed: re-render the screens that read them.
    fn changed(&self, ctx: &dyn ScreenCtx, tables: &[String]);

    /// A [`ScreenCtx::wake_after`] elapsed: fire the timers that are due.
    fn wake(&self, ctx: &dyn ScreenCtx);

    /// A [`ScreenCtx::off_thread`] job finished with `bytes`.
    fn job_done(&self, ctx: &dyn ScreenCtx, job: u64, bytes: Vec<u8>);

    /// The assistant's running turn said something: tell the screens that listen.
    fn assist(&self, ctx: &dyn ScreenCtx, event: &wire::AssistEvent) {
        let _ = (ctx, event);
    }
}

impl ScreenCtx for HandleState {
    fn now_ms(&self) -> Option<i64> {
        if let Some(front) = self.foreground_if_shelved() {
            return front.now_ms();
        }
        self.with_vault(|vault| Ok(vault.clock().now_ms())).ok()
    }

    fn cancel_vault_export(&self, job_id: &str) {
        HandleState::cancel_vault_export(self, job_id);
    }

    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        HandleState::load(self, request)
    }

    fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse> {
        HandleState::act(self, request)
    }

    fn command(
        &self,
        name: &str,
        input: &serde_json::Value,
        invoke_key: &str,
    ) -> Result<centraid_vault::commands::CommandOutcome> {
        HandleState::command(self, name, input, invoke_key)
    }

    fn stage_room_file(&self, bytes: &[u8]) -> Result<String> {
        self.with_vault(|vault| {
            let _budget_guard = room_export_budget_lock();
            let staging = vault
                .blobs()
                .and_then(centraid_vault::bytes::BlobStore::staging_dir)
                .ok_or_else(|| crate::error::CoreError::Unavailable {
                    reason: "this vault has no file staging area".to_owned(),
                })?;
            let export_dir = staging
                .parent()
                .unwrap_or(staging.as_path())
                .join("room-exports");
            let budget_staging =
                self.plane()
                    .staging()
                    .map_err(|_| crate::error::CoreError::Unavailable {
                        reason: "the vault staging area is unavailable".to_owned(),
                    })?;
            if room_export_over_budget(
                &budget_staging,
                &staging,
                &export_dir,
                u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                self.plane().budget(),
            ) {
                return Err(crate::error::CoreError::Unavailable {
                    reason: "the vault staging area is full".to_owned(),
                });
            }
            std::fs::create_dir_all(&export_dir).map_err(|error| {
                crate::error::CoreError::InvalidRequest {
                    detail: format!("could not prepare export staging: {error}"),
                }
            })?;
            let id = ROOM_EXPORT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = export_dir.join(format!("room-export-{}-{id}.tmp", std::process::id()));
            room_export_files()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(path.clone());
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| {
                    room_export_files()
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .remove(&path);
                    crate::error::CoreError::InvalidRequest {
                        detail: format!("could not stage export: {error}"),
                    }
                })?;
            use std::io::Write as _;
            if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                let _ = std::fs::remove_file(&path);
                room_export_files()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&path);
                return Err(crate::error::CoreError::InvalidRequest {
                    detail: format!("could not stage export: {error}"),
                });
            }
            Ok(path.to_string_lossy().into_owned())
        })
    }

    fn stage_room_archive(&self) -> Result<String> {
        self.with_vault(|vault| {
            let _budget_guard = room_export_budget_lock();
            let staging = vault
                .blobs()
                .and_then(centraid_vault::bytes::BlobStore::staging_dir)
                .ok_or_else(|| crate::error::CoreError::Unavailable {
                    reason: "this vault has no file staging area".to_owned(),
                })?;
            let source = staging.join("export.zip");
            let source_size = std::fs::metadata(&source)
                .map_err(|_| crate::error::CoreError::Unavailable {
                    reason: "the prepared archive is unavailable".to_owned(),
                })?
                .len();
            let export_dir = staging
                .parent()
                .unwrap_or(staging.as_path())
                .join("room-exports");
            let budget_staging =
                self.plane()
                    .staging()
                    .map_err(|_| crate::error::CoreError::Unavailable {
                        reason: "the vault staging area is unavailable".to_owned(),
                    })?;
            // The ordinary archive is already counted in `used`; this extra reservation accounts
            // for its private copy until the ordinary staging file is removed below.
            if room_export_over_budget(
                &budget_staging,
                &staging,
                &export_dir,
                source_size,
                self.plane().budget(),
            ) {
                return Err(crate::error::CoreError::Unavailable {
                    reason: "the vault staging area is full".to_owned(),
                });
            }
            std::fs::create_dir_all(&export_dir).map_err(|error| {
                crate::error::CoreError::InvalidRequest {
                    detail: format!("could not prepare export staging: {error}"),
                }
            })?;
            let id = ROOM_EXPORT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let target = export_dir.join(format!("room-export-{}-{id}.tmp", std::process::id()));
            room_export_files()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(target.clone());
            let result = (|| {
                let mut input = std::fs::File::open(&source).map_err(|error| {
                    crate::error::CoreError::InvalidRequest {
                        detail: format!("could not read prepared archive: {error}"),
                    }
                })?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(|error| crate::error::CoreError::InvalidRequest {
                        detail: format!("could not stage archive: {error}"),
                    })?;
                std::io::copy(&mut input, &mut output).map_err(|error| {
                    crate::error::CoreError::InvalidRequest {
                        detail: format!("could not stage archive: {error}"),
                    }
                })?;
                output
                    .sync_all()
                    .map_err(|error| crate::error::CoreError::InvalidRequest {
                        detail: format!("could not stage archive: {error}"),
                    })?;
                std::fs::remove_file(&source).map_err(|error| {
                    crate::error::CoreError::InvalidRequest {
                        detail: format!("could not finish staging archive: {error}"),
                    }
                })?;
                Ok(target.to_string_lossy().into_owned())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&target);
                room_export_files()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&target);
            }
            result
        })
    }

    fn held_bytes(&self, hash: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let bytes = self
            .bytes()
            .ok_or_else(|| crate::error::CoreError::Unavailable {
                reason: "held content is unavailable".to_owned(),
            })?;
        read_held_bounded(&bytes, hash, max_bytes)
    }

    fn remove_room_file(&self, path: &str) {
        let candidate = std::path::Path::new(path);
        let _ = self.with_vault(|vault| {
            let _budget_guard = room_export_budget_lock();
            let Some(staging) = vault
                .blobs()
                .and_then(centraid_vault::bytes::BlobStore::staging_dir)
            else {
                return Ok(());
            };
            let export_dir = staging
                .parent()
                .unwrap_or(staging.as_path())
                .join("room-exports");
            let file_name = candidate.file_name().and_then(std::ffi::OsStr::to_str);
            let generated_file = candidate.parent() == Some(export_dir.as_path())
                && file_name
                    .is_some_and(|name| name.starts_with("room-export-") && name.ends_with(".tmp"));
            let streamed_archive =
                candidate.parent() == Some(staging.as_path()) && file_name == Some("export.zip");
            let valid = generated_file || streamed_archive;
            if valid {
                let _ = std::fs::remove_file(candidate);
                room_export_files()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(candidate);
            }
            Ok(())
        });
    }

    fn originals(&self, request: &wire::OriginalsRequest) -> Result<wire::OriginalsResponse> {
        match HandleState::call(
            self,
            &wire::Request {
                kind: Some(wire::request::Kind::Originals(request.clone())),
            },
        )?
        .kind
        {
            Some(wire::response::Kind::Originals(answer)) => Ok(answer),
            _ => Err(crate::error::CoreError::Unsupported {
                type_url: "originals".to_owned(),
            }),
        }
    }

    fn content_urls(&self, request: &wire::ContentUrlRequest) -> Result<wire::ContentUrls> {
        match HandleState::call(
            self,
            &wire::Request {
                kind: Some(wire::request::Kind::ContentUrls(request.clone())),
            },
        )?
        .kind
        {
            Some(wire::response::Kind::ContentUrls(answer)) => Ok(answer),
            _ => Err(crate::error::CoreError::Unsupported {
                type_url: "content_urls".to_owned(),
            }),
        }
    }

    fn keyed(&self) -> Result<bool> {
        HandleState::keyed(self)
    }

    fn vault(&self, request: VaultRequest) -> Result<wire::Response> {
        HandleState::call(self, &request.into_request())
    }

    fn vaults(&self) -> Option<std::sync::Arc<dyn crate::vaults::Vaults>> {
        HandleState::vaults(self).cloned()
    }

    fn assist(&self, request: &wire::AssistRequest) -> Result<wire::AssistResponse> {
        match HandleState::call(
            self,
            &wire::Request {
                kind: Some(wire::request::Kind::Assist(request.clone())),
            },
        )?
        .kind
        {
            Some(wire::response::Kind::Assist(answer)) => Ok(answer),
            _ => Err(crate::error::CoreError::Unsupported {
                type_url: "assist".to_owned(),
            }),
        }
    }

    fn off_thread(&self, job: u64, work: OffThreadWork) {
        // THE JOB GETS THE FRONT: a call on it goes to the vault in front when
        // the call is MADE, except the words and a restore, which are the
        // front's own. A job that must finish on the vault it began on binds its
        // core when it is asked (`Ctx::vault_async`, `ScreenCtx::vaults`).
        let Some(handle) = Handle::of(self) else {
            return;
        };
        let events = self.events();
        std::thread::spawn(move || {
            let bytes = work(&handle);
            events.push(wire::Event {
                kind: Some(wire::event::Kind::JobDone(wire::ScreenJobDone {
                    job,
                    bytes,
                })),
            });
        });
    }

    fn push(&self, update: wire::ScreenUpdate) {
        // A full queue is a stall the producer waits out (`events.rs`); a view
        // state is a whole re-render, so a refused push is retried by the next
        // change rather than queued behind the stall.
        self.events().push(wire::Event {
            kind: Some(wire::event::Kind::Screen(Box::new(update))),
        });
    }

    fn wake_after(&self, after: Duration) {
        let Ok(runtime) = self.runtime_handle() else {
            return;
        };
        let events = self.events();
        runtime.spawn(async move {
            tokio::time::sleep(after).await;
            events.push(wire::Event {
                kind: Some(wire::event::Kind::Wake(wire::ScreenWake {})),
            });
        });
    }
}

impl crate::rooms::RoomCtx for HandleState {
    fn now_ms(&self) -> i64 {
        ScreenCtx::now_ms(self).unwrap_or_default()
    }

    fn command(
        &self,
        name: &str,
        input: &serde_json::Value,
        invoke_key: &str,
    ) -> Result<centraid_vault::commands::CommandOutcome> {
        HandleState::command(self, name, input, invoke_key)
    }

    fn stage_room_file(&self, bytes: &[u8]) -> Result<String> {
        ScreenCtx::stage_room_file(self, bytes)
    }

    fn stage_room_archive(&self) -> Result<String> {
        ScreenCtx::stage_room_archive(self)
    }

    fn held_bytes(&self, hash: &str, max_bytes: u64) -> Result<Vec<u8>> {
        ScreenCtx::held_bytes(self, hash, max_bytes)
    }

    fn remove_room_file(&self, path: &str) {
        ScreenCtx::remove_room_file(self, path)
    }

    fn call(&self, request: &wire::Request) -> Result<wire::Response> {
        HandleState::call(self, request)
    }

    fn device(&self) -> Result<std::sync::Arc<crate::device::Checked<crate::device::DirStore>>> {
        HandleState::device(self)
    }

    fn vault_id(&self) -> String {
        self.device_vault_id()
    }

    fn reader(&self) -> Result<centraid_domain::read::Reader> {
        centraid_domain::read::Reader::open(self.path()).map_err(|error| {
            crate::error::CoreError::InvalidRequest {
                detail: error.to_string(),
            }
        })
    }

    fn search(
        &self,
        request: &centraid_search::EachRequest,
    ) -> Result<Vec<centraid_search::Target>> {
        use centraid_search::{Principal, Search as _};
        self.with_vault(|vault| {
            let result = vault
                .read(|connection| {
                    let result = (|| {
                        let door = centraid_search::SqliteDoor::open(connection, vault.words())
                            .map_err(|error| error.to_string())?;
                        match door.query_each(&Principal::Owner, request) {
                            Ok(rows) => Ok(rows),
                            Err(centraid_search::SearchError::NoSearchableWords { .. }) => {
                                Ok(Vec::new())
                            }
                            Err(error) => Err(error.to_string()),
                        }
                    })();
                    Ok(result)
                })
                .map_err(|_| crate::error::CoreError::InvalidRequest {
                    detail: "Search is unavailable right now. Try again.".to_owned(),
                })?;
            result.map_err(|_| crate::error::CoreError::InvalidRequest {
                detail: "Search is unavailable right now. Try again.".to_owned(),
            })
        })
    }

    fn search_page(
        &self,
        request: &centraid_search::SearchRequest,
    ) -> Result<centraid_search::Answer> {
        use centraid_search::{Principal, Search as _};
        self.with_vault(|vault| {
            let result = vault
                .read(|connection| {
                    let result = (|| {
                        let door = centraid_search::SqliteDoor::open(connection, vault.words())
                            .map_err(|error| error.to_string())?;
                        match door.query(&Principal::Owner, request) {
                            Ok(answer) => Ok(answer),
                            Err(centraid_search::SearchError::NoSearchableWords { .. }) => {
                                Ok(centraid_search::Answer::Data {
                                    page: centraid_domain::page::Page {
                                        rows: Vec::new(),
                                        next: None,
                                    },
                                    window: request.page.limit,
                                })
                            }
                            Err(error) => Err(error.to_string()),
                        }
                    })();
                    Ok(result)
                })
                .map_err(|_| crate::error::CoreError::InvalidRequest {
                    detail: "Search is unavailable right now. Try again.".to_owned(),
                })?;
            result.map_err(|_| crate::error::CoreError::InvalidRequest {
                detail: "Search is unavailable right now. Try again.".to_owned(),
            })
        })
    }

    fn search_correction(
        &self,
        kinds: &[String],
        query: &str,
        thin: bool,
    ) -> Result<Option<String>> {
        use centraid_search::{Principal, Search as _};
        let kinds: Vec<&str> = kinds.iter().map(String::as_str).collect();
        self.with_vault(|vault| {
            let result = vault
                .read(|connection| {
                    let result = (|| {
                        let door = centraid_search::SqliteDoor::open(connection, vault.words())
                            .map_err(|error| error.to_string())?;
                        let answer = if thin {
                            door.correct_thin(&Principal::Owner, &kinds, query)
                        } else {
                            door.correct(&Principal::Owner, &kinds, query)
                        };
                        match answer {
                            Ok(answer) => Ok(answer),
                            Err(centraid_search::SearchError::NoSearchableWords { .. }) => Ok(None),
                            Err(error) => Err(error.to_string()),
                        }
                    })();
                    Ok(result)
                })
                .map_err(|_| crate::error::CoreError::InvalidRequest {
                    detail: "Search is unavailable right now. Try again.".to_owned(),
                })?;
            result.map_err(|_| crate::error::CoreError::InvalidRequest {
                detail: "Search is unavailable right now. Try again.".to_owned(),
            })
        })
    }

    fn locker_unlocked(&self) -> bool {
        self.locker_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    fn locker_epoch(&self) -> u64 {
        self.locker_epoch.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn locker_cancel_check(&self) {
        self.locker_epoch.store(
            crate::handle::next_locker_epoch(),
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    fn locker_unlock(&self) -> Result<(u32, Option<String>)> {
        use std::sync::atomic::Ordering;
        let epoch = self.locker_epoch.load(Ordering::SeqCst);
        let keyring =
            self.keys
                .as_ref()
                .ok_or_else(|| crate::error::CoreError::InvalidRequest {
                    detail: "Locker cannot open without this vault's key".to_owned(),
                })?;
        let seed = keyring.locker_seed.as_ref().ok_or_else(|| {
            crate::error::CoreError::InvalidRequest {
                detail: "Locker cannot open without this vault's seed".to_owned(),
            }
        })?;
        let key = centraid_identity::derive::derive_locker_key(seed, keyring.vault.index).map_err(
            |error| crate::error::CoreError::InvalidRequest {
                detail: error.to_string(),
            },
        )?;
        let key_id = {
            let mut vault = self
                .vault
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            vault
                .as_mut()
                .ok_or_else(|| crate::error::CoreError::InvalidRequest {
                    detail: "there is no vault to open Locker".to_owned(),
                })?
                .locker_generation()
                .map_err(|error| crate::error::CoreError::InvalidRequest {
                    detail: error.to_string(),
                })?
        };
        let invoke_key = format!(
            "locker-unlock-{}-{}",
            self.locker_command_nonce,
            crate::handle::NEXT_LOCKER_COMMAND_ID.fetch_add(1, Ordering::Relaxed),
        );
        let outcome = HandleState::command(
            self,
            "locker.mark_unlocked",
            &serde_json::json!({}),
            &invoke_key,
        )?;
        if outcome.status != centraid_vault::CommandStatus::Executed {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: outcome
                    .reason
                    .unwrap_or_else(|| "Locker could not record the unlock".to_owned()),
            });
        }
        let cleared = outcome
            .output
            .get("failed_unlocks")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let at = outcome
            .output
            .get("failed_unlock_at")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let mut session = self
            .locker_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.locker_epoch.load(Ordering::SeqCst) != epoch {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: "Locker was locked while the phone check was completing".to_owned(),
            });
        }
        *session = Some(crate::handle::LockerSession { key, key_id, epoch });
        Ok((u32::try_from(cleared).unwrap_or(u32::MAX), at))
    }

    fn locker_unlock_failed(&self) -> Result<u32> {
        use std::sync::atomic::Ordering;
        {
            let mut vault = self
                .vault
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(vault) = vault.as_mut() {
                vault.locker_generation().map_err(|error| {
                    crate::error::CoreError::InvalidRequest {
                        detail: error.to_string(),
                    }
                })?;
            }
        }
        let invoke_key = format!(
            "locker-failed-{}-{}",
            self.locker_command_nonce,
            crate::handle::NEXT_LOCKER_COMMAND_ID.fetch_add(1, Ordering::Relaxed),
        );
        let outcome = HandleState::command(
            self,
            "locker.mark_unlock_failed",
            &serde_json::json!({}),
            &invoke_key,
        )?;
        if outcome.status != centraid_vault::CommandStatus::Executed {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: outcome
                    .reason
                    .unwrap_or_else(|| "Locker could not record the refusal".to_owned()),
            });
        }
        Ok(outcome
            .output
            .get("failed_unlocks")
            .and_then(serde_json::Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or_default())
    }

    fn locker_failed_unlocks(&self) -> Result<(u32, Option<String>)> {
        let vault = self
            .vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(vault) = vault.as_ref() else {
            return Ok((0, None));
        };
        vault
            .locker_failed_unlocks()
            .map_err(|error| crate::error::CoreError::InvalidRequest {
                detail: error.to_string(),
            })
    }

    fn locker_lock(&self) -> Result<()> {
        use std::sync::atomic::Ordering;
        self.locker_epoch
            .store(crate::handle::next_locker_epoch(), Ordering::SeqCst);
        self.locker_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        Ok(())
    }

    fn locker_reveal_field(
        &self,
        item_id: &str,
        field_id: &str,
    ) -> Result<zeroize::Zeroizing<String>> {
        use std::sync::atomic::Ordering;
        let (key, expected_key_id, epoch) = {
            let session = self
                .locker_session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let session =
                session
                    .as_ref()
                    .ok_or_else(|| crate::error::CoreError::InvalidRequest {
                        detail: "Locker is locked".to_owned(),
                    })?;
            (session.key.clone(), session.key_id.clone(), session.epoch)
        };
        let invoke_key = format!(
            "locker-used-{}-{}",
            self.locker_command_nonce,
            crate::handle::NEXT_LOCKER_COMMAND_ID.fetch_add(1, Ordering::Relaxed),
        );
        let outcome = HandleState::command(
            self,
            "locker.mark_used",
            &serde_json::json!({ "item_id": item_id }),
            &invoke_key,
        )?;
        if outcome.status != centraid_vault::CommandStatus::Executed {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: outcome
                    .reason
                    .unwrap_or_else(|| "Locker could not record this use".to_owned()),
            });
        }
        let cell = {
            let vault = self
                .vault
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            vault
                .as_ref()
                .ok_or_else(|| crate::error::CoreError::InvalidRequest {
                    detail: "there is no vault to open Locker".to_owned(),
                })?
                .locker_sealed_field_cell(item_id, field_id)
                .map_err(|error| crate::error::CoreError::InvalidRequest {
                    detail: error.to_string(),
                })?
        }
        .ok_or_else(|| crate::error::CoreError::InvalidRequest {
            detail: "that sealed field is unavailable".to_owned(),
        })?;
        let ciphertext =
            cell.ciphertext
                .ok_or_else(|| crate::error::CoreError::InvalidRequest {
                    detail: "that sealed field has no value".to_owned(),
                })?;
        let key_id = cell
            .key_id
            .ok_or_else(|| crate::error::CoreError::InvalidRequest {
                detail: "that sealed field has no key id".to_owned(),
            })?;
        if key_id != expected_key_id {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: "that sealed field belongs to a different Locker key".to_owned(),
            });
        }
        let plaintext = centraid_vault::custody::locker_key::decrypt_under_locker_key(
            key.as_bytes(),
            &key_id,
            field_id,
            &ciphertext,
        )
        .map_err(|error| crate::error::CoreError::InvalidRequest {
            detail: error.to_string(),
        })?;
        let plaintext = zeroize::Zeroizing::new(plaintext);
        if self.locker_epoch.load(Ordering::SeqCst) != epoch || !self.locker_unlocked() {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: "Locker locked before the value could be shown".to_owned(),
            });
        }
        Ok(plaintext)
    }

    fn locker_seal_field(&self, field_id: &str, plaintext: &str) -> Result<(String, String)> {
        use std::sync::atomic::Ordering;
        let (key, key_id, epoch) = {
            let session = self
                .locker_session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let session =
                session
                    .as_ref()
                    .ok_or_else(|| crate::error::CoreError::InvalidRequest {
                        detail: "Locker is locked".to_owned(),
                    })?;
            (session.key.clone(), session.key_id.clone(), session.epoch)
        };
        let ciphertext = centraid_vault::custody::locker_key::encrypt_under_locker_key(
            key.as_bytes(),
            &key_id,
            field_id,
            plaintext,
        )
        .map_err(|error| crate::error::CoreError::InvalidRequest {
            detail: error.to_string(),
        })?;
        if self.locker_epoch.load(Ordering::SeqCst) != epoch || !self.locker_unlocked() {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: "Locker locked before the field could be saved".to_owned(),
            });
        }
        Ok((ciphertext, key_id))
    }

    fn push(&self, shown: wire::RoomShown) {
        self.events().push(wire::Event {
            kind: Some(wire::event::Kind::Room(Box::new(shown))),
        });
    }
}

#[cfg(test)]
mod room_export_budget_tests {
    use super::{
        HeldContent, ScreenCtx, read_held_bounded, room_export_budget_lock, room_export_over_budget,
    };
    use centraid_vault::backup::staging::Staging;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    struct CountedContent {
        size: u64,
        gets: AtomicUsize,
    }

    impl HeldContent for CountedContent {
        fn size(&self, _: &str) -> crate::Result<u64> {
            Ok(self.size)
        }

        fn get(&self, _: &str) -> crate::Result<Vec<u8>> {
            self.gets.fetch_add(1, Ordering::SeqCst);
            Ok(vec![0; usize::try_from(self.size).unwrap_or(usize::MAX)])
        }
    }

    #[test]
    fn held_text_import_checks_size_before_allocating_blob_bytes() {
        let store = CountedContent {
            size: 1024,
            gets: AtomicUsize::new(0),
        };
        assert!(read_held_bounded(&store, "hash", 32).is_err());
        assert_eq!(store.gets.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn private_exports_share_the_plane_budget_and_release_it_on_cleanup() {
        let root = tempfile::tempdir().expect("tempdir");
        let staging_dir = root.path().join("vault.staging");
        let blob_staging_dir = root.path().join("vault.exports");
        let export_dir = root.path().join("room-exports");
        std::fs::create_dir_all(&export_dir).expect("export dir");
        std::fs::create_dir_all(&blob_staging_dir).expect("blob staging dir");
        let staging = Staging::open(&staging_dir, 10).expect("staging");

        std::fs::write(export_dir.join("one.tmp"), b"12345").expect("private export");
        assert!(room_export_over_budget(
            &staging,
            &blob_staging_dir,
            &export_dir,
            6,
            10
        ));
        std::fs::remove_file(export_dir.join("one.tmp")).expect("cleanup");
        assert!(!room_export_over_budget(
            &staging,
            &blob_staging_dir,
            &export_dir,
            10,
            10
        ));

        // `export.zip` remains in ordinary staging until its adopted copy is complete, so the
        // requested extra reservation must count both copies at once.
        std::fs::write(staging_dir.join("export.zip"), b"123456").expect("archive source");
        assert!(room_export_over_budget(
            &staging,
            &blob_staging_dir,
            &export_dir,
            6,
            10
        ));
    }

    #[test]
    fn concurrent_private_exports_cannot_both_spend_the_same_remaining_budget() {
        let root = tempfile::tempdir().expect("tempdir");
        let staging_dir = root.path().join("vault.staging");
        let blob_staging_dir = root.path().join("vault.exports");
        let export_dir = root.path().join("room-exports");
        std::fs::create_dir_all(&export_dir).expect("export dir");
        std::fs::create_dir_all(&blob_staging_dir).expect("blob staging dir");
        let staging = Arc::new(Staging::open(&staging_dir, 8).expect("staging"));
        let accepted = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for index in 0..2 {
            let staging = Arc::clone(&staging);
            let accepted = Arc::clone(&accepted);
            let dir = export_dir.clone();
            let blob_dir = blob_staging_dir.clone();
            workers.push(std::thread::spawn(move || {
                let _guard = room_export_budget_lock();
                if !room_export_over_budget(&staging, &blob_dir, &dir, 5, 8) {
                    std::fs::write(dir.join(format!("{index}.tmp")), b"12345")
                        .expect("private export");
                    accepted.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for worker in workers {
            worker.join().expect("worker");
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn actual_core_stage_file_refuses_over_budget_without_partial_and_cleanup_releases_budget() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("vault.db");
        let handle =
            crate::Core::open(crate::CoreConfig::new(&path).with_staging_ceiling(5)).expect("core");
        handle
            .open_own_bytes(root.path().join("vault.bytes"))
            .expect("byte store");

        assert!(ScreenCtx::stage_room_file(&*handle, b"123456").is_err());
        assert!(!root.path().join("room-exports").exists());

        let first = ScreenCtx::stage_room_file(&*handle, b"12345").expect("fits the ceiling");
        assert!(std::path::Path::new(&first).is_file());
        assert!(ScreenCtx::stage_room_file(&*handle, b"x").is_err());
        ScreenCtx::remove_room_file(&*handle, &first);
        let after_cleanup = ScreenCtx::stage_room_file(&*handle, b"12345")
            .expect("cleanup returns the reserved space");
        assert!(std::path::Path::new(&after_cleanup).is_file());
        ScreenCtx::remove_room_file(&*handle, &after_cleanup);
    }

    #[test]
    fn two_core_handles_cannot_overcommit_one_vaults_private_export_budget() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("vault.db");
        let bytes = root.path().join("vault.bytes");
        let open = || {
            let handle = crate::Core::open(crate::CoreConfig::new(&path).with_staging_ceiling(5))
                .expect("core");
            handle.open_own_bytes(&bytes).expect("byte store");
            handle
        };
        let left = open();
        let right = open();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for handle in [left, right] {
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                ScreenCtx::stage_room_file(&*handle, b"12345")
            }));
        }
        let paths: Vec<String> = workers
            .into_iter()
            .filter_map(|worker| worker.join().expect("worker").ok())
            .collect();
        assert_eq!(paths.len(), 1);
        let export_dir = root.path().join("room-exports");
        let entries: Vec<_> = std::fs::read_dir(&export_dir)
            .expect("room exports")
            .collect::<std::io::Result<Vec<_>>>()
            .expect("entries");
        assert_eq!(entries.len(), 1);
        ScreenCtx::remove_room_file(&*open(), &paths[0]);
        assert!(ScreenCtx::stage_room_file(&*open(), b"12345").is_ok());
    }
}
