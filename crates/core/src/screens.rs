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
use crate::handle::Handle;

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
    fn call(&self, ctx: &dyn ScreenCtx, request: &wire::ScreenRequest)
    -> Result<wire::ScreenResponse>;

    /// These tables changed: re-render the screens that read them.
    fn changed(&self, ctx: &dyn ScreenCtx, tables: &[String]);

    /// A [`ScreenCtx::wake_after`] elapsed: fire the timers that are due.
    fn wake(&self, ctx: &dyn ScreenCtx);
}

impl ScreenCtx for Handle {
    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        Handle::load(self, request)
    }

    fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse> {
        Handle::act(self, request)
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
