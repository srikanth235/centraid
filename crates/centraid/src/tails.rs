//! THE GATEWAY'S HALF OF THE TAIL (#1025 S2, D-1025-S7-40).
//!
//! A seat becomes current by ONE mechanism: it connects, asks for the log from
//! its durable cursor with `LogRequest.tail` set, and stays on that stream as
//! long as its OS allows. Polling and foreground timers are deleted concepts.
//!
//! Two small things live here, and they are the whole of what the gateway needs
//! that a one-shot page did not:
//!
//! * [`Commits`] — the wake. The core rings it after every request that may
//!   have written; a tailing stream parked on it reads the log from where it
//!   left off. **One page per commit batch and never one per row**: the wake
//!   carries no payload, so a batch of four hundred rows is one ring, one read
//!   and one page.
//! * [`Tails`] — who is holding one. A seat may hold at most one tail per
//!   vault, so a second tail from the same device REPLACES the first: the
//!   second is what that device believes, and a gateway writing pages into a
//!   stream nobody reads is a task held by a phone that has moved on.
//!
//! **Presence falls out of this and is deliberately not on the wire.** The
//! gateway can enumerate the devices with a tail open — that is what
//! [`Tails::present`] answers — and for now it goes to a log line and nothing
//! else. A presence PROTOCOL is a product decision about what members may learn
//! about each other's devices, and nothing in this slice needed one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// THE WAKE A TAILING STREAM PARKS ON.
///
/// A `watch` and not a `Notify`, for one reason: a `watch::Receiver` remembers
/// whether it has seen the current value, so a commit that lands between a
/// reader's page and its wait is not lost. With a `Notify` that instant is a
/// row that sits on the gateway until somebody else writes.
///
/// The value is a COUNT and means nothing. What a reader does with a wake is
/// ask the log door where the watermark is, because the log door is the thing
/// that knows; a seq handed across here would be a second opinion about the
/// same fact, and the two would differ exactly when it mattered.
#[derive(Clone)]
pub struct Commits {
    rings: Arc<tokio::sync::watch::Sender<u64>>,
}

impl Default for Commits {
    fn default() -> Self {
        Self::new()
    }
}

impl Commits {
    #[must_use]
    pub fn new() -> Self {
        let (rings, _) = tokio::sync::watch::channel(0);
        Self {
            rings: Arc::new(rings),
        }
    }

    /// Park here until something commits.
    ///
    /// Subscribed BEFORE the page it is about to serve, always: a subscription
    /// taken afterwards has not seen the versions in between and would wait for
    /// the commit after the one it missed.
    #[must_use]
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.rings.subscribe()
    }
}

impl centraid_core::link::CommitBell for Commits {
    fn rang(&self) {
        // `send_modify` rather than `send`: it wakes every receiver whether or
        // not one is listening, and a channel with no receivers is the ordinary
        // state of a gateway nobody has paired with.
        self.rings.send_modify(|count| *count = count.wrapping_add(1));
        tracing::debug!(receivers = self.rings.receiver_count(), "a commit rang the tail bell");
    }
}

/// WHO IS HOLDING A TAIL, BY DEVICE.
///
/// One per gateway process, which is one per vault. Cloneable because every
/// connection task needs it and none of them owns it.
#[derive(Clone, Default)]
pub struct Tails {
    open: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
}

/// A registered tail. Dropping it unregisters — and only its own entry, never a
/// later tail that replaced it.
pub struct Registered {
    tails: Tails,
    device: String,
    /// Signalled when THIS tail is asked to close, which is what a second tail
    /// from the same device does to it.
    closed: Arc<tokio::sync::Notify>,
}

impl Tails {
    /// Register a tail for `device`, closing whichever one it already had.
    ///
    /// The replacement is not a refusal and not an error: a phone that
    /// relaunched, or reconnected on a new path, opens a second tail while the
    /// first is still notionally alive on a connection nobody will read. The
    /// SECOND is what that device believes.
    pub fn register(&self, device: &str) -> Registered {
        let closed = Arc::new(tokio::sync::Notify::new());
        let replaced = self.open.lock().map_or(None, |mut open| {
            open.insert(device.to_owned(), Arc::clone(&closed))
        });
        if let Some(previous) = replaced {
            tracing::info!(%device, "a second tail replaced this device's first");
            previous.notify_waiters();
        }
        tracing::info!(
            %device,
            open = self.present().len(),
            "a seat opened a tail on this vault"
        );
        Registered {
            tails: self.clone(),
            device: device.to_owned(),
            closed,
        }
    }

    /// The devices holding a tail right now.
    ///
    /// PRESENCE, AND IT STOPS HERE. See the module header: what a member may
    /// learn about another member's devices is a product decision, and this is
    /// a log line until one is made.
    #[must_use]
    pub fn present(&self) -> Vec<String> {
        self.open
            .lock()
            .map(|open| open.keys().cloned().collect())
            .unwrap_or_default()
    }
}

impl Registered {
    /// Wait until this tail is asked to close by a later one from the same
    /// device.
    pub async fn superseded(&self) {
        self.closed.notified().await;
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut open) = self.tails.open.lock() {
            // ONLY ITS OWN. A tail that was replaced must not unregister the
            // tail that replaced it on its way out, which is the ordinary race:
            // the phone opens the second and the first notices moments later.
            if open
                .get(&self.device)
                .is_some_and(|held| Arc::ptr_eq(held, &self.closed))
            {
                open.remove(&self.device);
            }
        }
        tracing::info!(device = %self.device, "a seat's tail closed");
    }
}
