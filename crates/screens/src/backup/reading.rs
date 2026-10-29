//! WHAT THE CORE SAYS ABOUT ONE VAULT'S BACKUP (`backup-status`), as the screens
//! use it.
//!
//! The core's own ledger, read without dialling anyone: drawing a line must not
//! depend on somebody else's network. **Every time that is a gateway's is the
//! GATEWAY's clock** ([`Reading::last_ack_ms`], [`Destination::last_ack_ms`]),
//! because "backed up" is an acknowledgement and this phone's clock acknowledges
//! nothing (#1080 ruling 7). Only `now_ms` is this phone's, and it is for the
//! wording ("2 minutes ago") alone.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog;
use crate::kit::read::{Reading as Read, read};
use crate::screen::Ctx;

/// One paired gateway, as the ledger remembers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    pub gateway_id: String,
    pub label: String,
    pub addrs: Vec<String>,
    /// When it last answered, gateway clock; `None` when never (zero on the wire).
    pub last_seen_ms: Option<i64>,
    /// When it last acknowledged anything, gateway clock; `None` when never.
    pub last_ack_ms: Option<i64>,
    /// It answered `UNAUTHORIZED` to this phone's token: it lost its store, or
    /// its operator revoked the token, so every acknowledgement this phone still
    /// holds for it describes a gateway that is gone. Pair it again.
    pub pair_again: bool,
    /// The bytes it acknowledged, as this phone recorded them (#1144).
    pub held_bytes: u64,
}

/// The ledger's reading of one vault's backup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    pub destinations: Vec<Destination>,
    /// When the latest snapshot a gateway holds was taken, phone clock.
    pub last_snapshot_ms: Option<i64>,
    /// When a gateway last acknowledged the head, gateway clock; `None` when never.
    pub last_ack_ms: Option<i64>,
    /// Content hashes the vault knows, originals and derivatives.
    pub content_total: u64,
    pub content_confirmed: u64,
    /// Sealed bytes waiting to move.
    pub pending_bytes: u64,
    /// What the spool holds on this phone right now.
    pub spool_bytes: u64,
    /// Why the unconfirmed wait, by the core's `WaitReason` number; a reason
    /// with no items is absent.
    pub waiting: BTreeMap<i32, u64>,
    /// The vault moved to another phone; this one is read-only.
    pub frozen: bool,
    /// WHAT EACH APP'S BACKUP HOLDS (#1144), in the catalogue's order; empty
    /// when the core could not say (no vault, or no keys to name its files).
    pub apps: Vec<wire::AppHolding>,
    /// Every app's bytes, the videos left out not among them, and of those
    /// what a gateway acknowledged.
    pub total_bytes: u64,
    pub confirmed_bytes: u64,
    /// The videos the member left out, and their bytes.
    pub left_out_items: u64,
    pub left_out_bytes: u64,
}

impl Reading {
    /// Items no gateway has acknowledged yet.
    #[must_use]
    pub fn unconfirmed(&self) -> u64 {
        self.content_total.saturating_sub(self.content_confirmed)
    }

    /// Items waiting for `reason`.
    #[must_use]
    pub fn waiting_for(&self, reason: wire::WaitReason) -> u64 {
        self.waiting.get(&(reason as i32)).copied().unwrap_or(0)
    }

    /// The core's reading, turned into what the screens decide over.
    #[must_use]
    pub fn from_wire(status: &wire::BackupStatusResponse) -> Self {
        let mut waiting = BTreeMap::new();
        for row in &status.waiting {
            if row.reason != wire::WaitReason::Unspecified as i32 && row.count > 0 {
                *waiting.entry(row.reason).or_insert(0) += row.count;
            }
        }
        Self {
            destinations: status
                .destinations
                .iter()
                .map(|destination| Destination {
                    gateway_id: destination.gateway_id.clone(),
                    label: destination.label.clone(),
                    addrs: destination.addrs.clone(),
                    // ZERO IS "NEVER" on the wire, and never a time.
                    last_seen_ms: Some(destination.last_seen_ms).filter(|at| *at > 0),
                    last_ack_ms: Some(destination.last_ack_ms).filter(|at| *at > 0),
                    pair_again: destination.pair_again,
                    held_bytes: destination.held_bytes,
                })
                .collect(),
            last_snapshot_ms: status.last_snapshot_ms,
            // `acked_at_ms` IS THE HEAD'S ACKNOWLEDGEMENT, on the gateway's clock.
            last_ack_ms: status.acked_at_ms,
            content_total: status.content_total,
            content_confirmed: status.content_confirmed,
            pending_bytes: status.pending_bytes,
            spool_bytes: status.spool_bytes,
            waiting,
            frozen: status.frozen,
            apps: status.apps.clone(),
            total_bytes: status.total_bytes,
            confirmed_bytes: status.confirmed_bytes,
            left_out_items: status.left_out_items,
            left_out_bytes: status.left_out_bytes,
        }
    }
}

/// The reading and this phone's clock when it was taken.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Standing {
    pub reading: Reading,
    pub now_ms: i64,
}

/// Load the shell's `backup-status` query: the one read the Backup screen and
/// Home's line are made from. A failed read is `Reading::Failed`, never an empty
/// reading.
pub fn load(ctx: &Ctx) -> Read<Standing> {
    read(ctx, catalog::load::shell::BackupStatus {}, |answer| {
        let Answer::ShellBackupStatus(answer) = answer else {
            return None;
        };
        Some(Standing {
            reading: Reading::from_wire(&answer.status?),
            now_ms: answer.now_ms,
        })
    })
}
