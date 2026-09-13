//! The core: one handle, one message loop, three roles.
//!
//! Everything a shell can ask for goes through [`Handle::call`] and everything
//! the core volunteers comes back through [`Handle::next_event`]
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 2, lane
//! D2). There is no third surface, and that is the point: a shell that could
//! reach the vault directly would be a second gateway.
//!
//! ## `open` never blocks on the network (D-1020-D2-2)
//!
//! [`Core::open`] opens the file, runs migrations, and returns. The endpoint —
//! when the configuration asks for one — is started *afterwards*, on a core
//! thread. A shell whose first screen waits for a relay handshake is a shell
//! that shows a spinner in an aeroplane, and every member has been on that
//! aeroplane.
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
//! [`events::EVENT_QUEUE_CAP`] is 1024. When it fills, **sync stalls** and a
//! [`api_proto::HealthEvent`] with `stalled: true` is emitted — the queue never
//! drops an event, because a dropped change event is a screen that is wrong
//! until something else happens to touch the same row. Change events are
//! coalesced per `(table, pk)` set while they wait, which is lossless: two
//! changes to one row are one redraw.
//!
//! ## The three roles
//!
//! | Role | What it is |
//! |---|---|
//! | [`Role::Gateway`] | the authority: D1's vault, the doors, and (later) the endpoint accepting seats |
//! | `Role::Seat { Replicated }` | a full mirror: D2's applier over a local file, its own outbox |
//! | `Role::Seat { Thin }` | no local rows: every call is forwarded to the gateway under the caller's principal, and `Unavailable` when it cannot be reached |
//!
//! All three expose the same [`Request`] surface. A shell written against a
//! thin seat works against a gateway with no change, which is what makes
//! "gateway anywhere" a deployment choice rather than a fork.

#![forbid(unsafe_code)]

pub mod api;
pub mod config;
pub mod convert;
pub mod error;
pub mod events;
pub mod handle;
pub mod identity;

/// Lane C's generated types, re-exported so a consumer needs one dependency.
pub use centraid_api_proto::core_v1 as api_proto;
pub use config::{CoreConfig, Role, SeatKind};
pub use error::{CoreError, Result, sentence_for_code};
pub use events::{EVENT_QUEUE_CAP, EventQueue};
pub use handle::{Core, Handle};
pub use identity::{ArtifactIdentity, require_digest};

/// The request and response envelopes, spelled once.
pub use centraid_api_proto::core_v1::{Event, Request, Response};
