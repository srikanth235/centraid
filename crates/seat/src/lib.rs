//! The seat replica: the applier, the state tables, the outbox, the intent
//! grammar.
//!
//! This is the other half of the plane whose authority half is
//! [`centraid_vault`] ([#1020](https://github.com/srikanth235/centraid/issues/1020)
//! wave 2, lane D2). A seat holds a *copy* of the vault — every replicated
//! table, none of the private ones — plus three tables the gateway never ships:
//! [`state::SEAT_STATE_DDL`], [`outbox::SEAT_OUTBOX_DDL`] and its settled
//! journal.
//!
//! ## Why this is the same crate family as the gateway (D-1020-D2-1)
//!
//! v0 had two appliers, one in `packages/vault/src/replica/apply.ts` and one in
//! `packages/client/src/replica/seat/applier.ts`, and their rules were
//! transcribed from each other by hand. The four rules are identical, and the
//! divergence — the seat's `applied_seq` drop, the overlay hook, the durable
//! callback — is *additive*. So [`applier::apply_page`] wraps
//! [`centraid_vault::log::apply::apply_row_sql`] and its siblings rather than
//! re-deriving the SQL: one statement renderer, two callers, and the
//! CONVERGENCE fixture runs through both (`tests/convergence.rs`).
//!
//! SQL string literals are allowed in this crate — it is one of the five the
//! `sql-confinement` rule names — because a seat's own three tables are its
//! own, and nothing else may reach them.
//!
//! ## Three vocabularies, kept distinct
//!
//! | Vocabulary | Values | Where |
//! |---|---|---|
//! | [`intent::IntentState`] | ten, the seat's own | `intent.rs` |
//! | [`intent::GatewayStatus`] | seven, what the gateway's ledger holds | `intent.rs` |
//! | [`intent::OutcomeStatus`] | five, what an answer may say | `intent.rs` |
//!
//! They are three types and not one because each set is closed by a different
//! party. `sending` is a seat's fact about its own socket; `queued` on the
//! gateway means something else entirely; and an *answer* can never say
//! `queued`. v0 kept them as three string unions and the compiler could not
//! tell them apart — here it can.
//!
//! ## Two numbers, and the other two
//!
//! `applied_seq` is a `replica_log.seq`; `applied_commit_seq` is the commit
//! that seq belonged to, and an overlay clears against the latter. Census seam
//! 5 names comparing them "the R6 mistake in miniature — 432 against 2".
//! `schema_epoch` is compatibility and `ddl_version` is additive progress
//! inside one epoch.

#![forbid(unsafe_code)]

pub mod applier;
pub mod chain;
pub mod error;
pub mod identity;
pub mod intent;
pub mod locker;
pub mod occ;
pub mod outbox;
pub mod payload;
pub mod settlement;
pub mod state;
pub mod sync;

pub use applier::{ApplyReport, apply_page};
pub use error::{Result, SeatError};
pub use identity::{SeatIdentity, replica_storage_key};
pub use intent::{
    GatewayStatus, IntentRecord, IntentState, OVERLAY_STATES, OutcomeStatus, intent_verdict,
};
pub use occ::{Conflict, occ_check};
pub use outbox::Outbox;
pub use payload::{PayloadHash, cmp_utf16};
pub use state::{SeatPosition, SeatState, Watermark, init_seat_state, seat_state, watermark};
pub use sync::{FetchOutcome, FetchedPage, IntentSink, LogSource, PassReport, SubmitOutcome};
