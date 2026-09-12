//! The `ledger` band: conversation ⊃ turn ⊃ item, and the machinery beside it
//! (#1020, wave 4 lane assist, D-1020-AS3).
//!
//! ## Why this module is in `crates/vault` and not in `crates/assist`
//!
//! `sql-confinement` allows SQL under `crates/{ontology,vault,seat,search}` and
//! `crates/apps/kit` and nowhere else, and the rule is right: a crate that read
//! this band itself would be a second reader of a shape this crate owns. So the
//! band's **statements** live here, and `crates/assist` owns its **meaning** —
//! what a posture is, when a breaker opens, what a turn costs. The rule's file
//! list is not widened to accommodate the assistant plane; the assistant plane
//! is arranged to fit it.
//!
//! v0 split it the same way for a different reason (`ledger.ts:1`–`:20`): *the
//! vault package owns the tables, the engine owns the store code and receives
//! the connection.*
//!
//! ## Six facts a port must keep, and where each one is
//!
//! 1. **One file.** The band lives in `vault.db` like every other band (#916).
//!    There is no separate ledger database; [`store`] takes the same [`Vault`].
//! 2. **Machinery, registered names-only.** `ledger` is a machinery band and
//!    all fourteen tables are in `localTables`, so they are excluded from the
//!    portable export and from the replica **by band**, exactly as `audit` is.
//!    Both facts are already in `contracts/schema/v0-registries.json` and
//!    [`schema::assert_band_registration`] is what holds them there.
//! 3. **Mutable.** A turn is amended as it streams, so the band carries **no
//!    append-only triggers** — unlike `audit`, which does. A port that gave the
//!    ledger audit's triggers would make the first streamed item the last.
//! 4. **Retention is not optional.** [`archive`] seals cold turn ranges into a
//!    content-addressed segment and prunes the raw rows. It is what keeps the
//!    sovereign file small now that there is only one of them.
//! 5. **CASCADE on three edges, and deliberately not on the fourth.**
//!    `turns.conversation_id`, `items.turn_id` and `attachments.item_id`
//!    cascade; `turns.parent_turn_id` is a **plain column** with no foreign key,
//!    because a sub-run's parent may be recorded *after* this row inside one
//!    batch and a constraint would refuse the batch.
//! 6. **Unreachable from a handler.** No command handler's `db` and no
//!    `vault_sql` statement can reach the band — see [`sql_guard`].
//!
//! ## The DDL is already on the ladder
//!
//! This module adds **no migration**. All fourteen tables, the `run_summary`
//! view, the two count triggers, the six FTS triggers and both indexes were
//! exported into `contracts/migrations/001_baseline.sql` by wave 2, because the
//! baseline was taken from the whole v0 corpus rather than band by band. A
//! second `CREATE TABLE conversations` would simply fail. So what this slot
//! owes is not DDL but **proof**: `crates/vault/tests/ledger.rs` walks the
//! founded file and checks every one of those objects, every closed vocabulary
//! against the values its writers actually write, and every delete rule.

pub mod archive;
pub mod consent;
pub mod health;
pub mod schema;
pub mod sql_guard;
pub mod store;

pub use schema::{BAND, LEDGER_TABLES};
pub use store::{Conversation, ConversationKind, Item, ItemKind, Store, Turn, TurnTrigger};
