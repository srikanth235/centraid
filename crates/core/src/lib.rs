//! The core: one handle, one message loop, one vault.
//!
//! Everything a shell can ask for goes through [`Handle::call`] and everything
//! the core volunteers comes back through [`Handle::next_event`]
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 2, lane
//! D2). There is no third surface, and that is the point: a shell that could
//! reach the vault directly would be a second writer.
//!
//! ## `open` never blocks (D-1020-D2-2)
//!
//! [`Core::open`] opens the file, runs migrations, and returns. It never had a
//! network to wait on since #1029 §6 took the endpoint away, and it never did
//! before either — a shell whose first screen waits for a relay handshake is a
//! shell that shows a spinner in an aeroplane, and every member has been on
//! that aeroplane.
//!
//! ## `call` is synchronous from the caller's view, and never from a UI thread
//!
//! [`Handle::call`] blocks until there is an answer. That is the right shape
//! for a shell: a bounded read is milliseconds and an `async` surface would
//! push a runtime into Swift and Kotlin for no gain. The cost is that calling
//! it from a UI thread janks the frame, so a debug assertion catches it when
//! the shell has named its UI thread through [`CoreConfig::ui_thread_name`].
//! The shells assert too; this is the belt to their braces.
//!
//! ## The event queue is BOUNDED and nothing is dropped
//!
//! [`events::EVENT_QUEUE_CAP`] is 1024. When it fills, **the producer stalls**
//! and a [`api_proto::HealthEvent`] with `stalled: true` is emitted — the queue
//! never drops an event, because a dropped change event is a screen that is
//! wrong until something else happens to touch the same row. Change events are
//! coalesced per `(table, pk)` set while they wait, which is lossless: two
//! changes to one row are one redraw.
//!
//! ## THERE IS ONE ROLE, AND SO THERE IS NO ROLE (#1029 §1)
//!
//! `Role` is deleted. With no paired client (#1029 §6) the phone is the only
//! host that opens a vault, so `Gateway`, `Seat { Replicated }` and
//! `Seat { Thin }` collapsed to one thing and a one-variant enum is dead
//! weight. Everything that only existed on the other side of a pairing —
//! `queue_write`, `predict`, `seat.sync`, bootstrap, `Unpaired`,
//! `Request::Intent`, `submit_intent` and the `link` module that held the
//! network seam — went with it.

#![forbid(unsafe_code)]

pub mod api;
pub mod config;
pub mod convert;
pub mod error;
pub mod events;
pub mod handle;
pub mod identity;
pub mod locker;
/// THE PHONE'S TWO FLOWS (#1029 W15): drain, restore, and the pairing and
/// backup status the shell draws beside them. See `phone.proto`.
pub mod phone;
pub mod stage;

/// Lane C's generated types, re-exported so a consumer needs one dependency.
pub use centraid_api_proto::core_v1 as api_proto;
pub use config::CoreConfig;
pub use error::{CoreError, Result, sentence_for_code};
pub use events::{ChangeFeed, EVENT_QUEUE_CAP, EventQueue};
pub use handle::{Core, Handle};
pub use identity::{ArtifactIdentity, require_digest};

/// THE SEED A SHELL HANDS IN, re-exported so a consumer needs one dependency
/// (#1029 W15). `crates/core-ffi` parses it out of the open configuration and
/// has no reason to depend on `centraid-identity` for one type.
pub use centraid_identity::Seed;
pub use centraid_identity::phrase::SEED_BYTES;

/// The request and response envelopes, spelled once.
pub use centraid_api_proto::core_v1::{Event, Request, Response};
