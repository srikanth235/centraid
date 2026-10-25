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
    PairPhone(wire::PairRequest),
    Restore(wire::RestoreRequest),
    RefreshDestination(wire::RefreshDestinationRequest),
    ForgetDestination(wire::ForgetDestinationRequest),
    Handoff(wire::HandoffRequest),
    Settle(wire::SettleRequest),
    Reconcile(wire::ReconcileRequest),
    Pins(wire::PinsRequest),
    FetchOriginal(wire::FetchOriginalRequest),
    Releasable(wire::ReleasableRequest),
    Released(wire::ReleasedRequest),
    LibraryAssets(wire::LibraryAssetsRequest),
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
            Self::PairPhone(r) => K::PairPhone(r),
            Self::Restore(r) => K::Restore(r),
            Self::RefreshDestination(r) => K::RefreshDestination(r),
            Self::ForgetDestination(r) => K::ForgetDestination(r),
            Self::Handoff(r) => K::Handoff(r),
            Self::Settle(r) => K::Settle(r),
            Self::Reconcile(r) => K::Reconcile(r),
            Self::Pins(r) => K::Pins(r),
            Self::FetchOriginal(r) => K::FetchOriginal(r),
            Self::Releasable(r) => K::Releasable(r),
            Self::Released(r) => K::Released(r),
            Self::LibraryAssets(r) => K::LibraryAssets(r),
        };
        wire::Request { kind: Some(kind) }
    }
}

/// What a screen runtime may ask of the core.
pub trait ScreenCtx {
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

    /// One step of the Locker session (unlock, relock, a reveal, a one-time
    /// code, an export, an import): the session `Request.locker` drives, on the
    /// same core. The plaintext of a reveal comes back to the screen that asked
    /// and nowhere else. A door with no session says so.
    ///
    /// # Errors
    /// The session's own refusals.
    fn locker(&self, request: &wire::LockerSessionRequest) -> Result<wire::LockerSessionResponse> {
        let _ = request;
        Err(crate::error::CoreError::Unavailable {
            reason: "this door holds no Locker session".to_owned(),
        })
    }

    /// A vault lifecycle door that is neither a read nor a write of an app's
    /// rows, and is quick: the 24 words (`phrase`), founding a vault. The type
    /// limits what a screen can send to `vault.proto` and `phone.proto`; there
    /// is no way through it to a `Command`.
    ///
    /// # Errors
    /// Whatever the door refuses with.
    fn vault(&self, request: VaultRequest) -> Result<wire::Response> {
        let _ = request;
        Err(crate::error::CoreError::Unavailable {
            reason: "this door carries no vault doors".to_owned(),
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
}

impl ScreenCtx for HandleState {
    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        HandleState::load(self, request)
    }

    fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse> {
        HandleState::act(self, request)
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

    fn locker(&self, request: &wire::LockerSessionRequest) -> Result<wire::LockerSessionResponse> {
        HandleState::locker_session(self, request)
    }

    fn vault(&self, request: VaultRequest) -> Result<wire::Response> {
        HandleState::call(self, &request.into_request())
    }

    fn vaults(&self) -> Option<std::sync::Arc<dyn crate::vaults::Vaults>> {
        HandleState::vaults(self).cloned()
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
