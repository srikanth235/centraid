//! One owner-visible policy for every backup clock and byte budget (#1020,
//! D-1020-R5; v0 `packages/vault/src/backup-policy.ts`, #414).
//!
//! Two things about the defaults worth stating, because a "reasonable" tweak to
//! either is a product change:
//!
//! - `rpo_seconds` is **also** the vault's WAL capture tick. "How much can I
//!   lose" and "how often do we ship" are one number, set once, so they cannot
//!   drift apart into a promise the machinery does not keep. The floor is 30 s:
//!   below that the tick costs more than the data it protects.
//! - `reserved_headroom_bytes` is not a courtesy. A vault that fills its own
//!   disk cannot write the WAL that would let it recover, so the headroom is
//!   what makes `VaultError::DiskFull` a *refusal* rather than a corruption.
//!
//! v1 carries no provider back-ends (R-1020: local filesystem only), so the
//! provider-shaped fields v0 had — `storage_class`, `direct_to_cold_originals`
//! — are kept in the **shape** and ignored by the engine, with a note. Dropping
//! them would make a v0 policy row unreadable, and inventing new names for the
//! same settings later is worse than carrying two dormant fields now.

use serde::{Deserialize, Serialize};

/// Below this the capture tick costs more than the data it protects.
pub const MIN_RPO_SECONDS: u64 = 30;

/// Whether a receipt is enough, or provider custody must be confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CasAck {
    /// Durable locally. The v1 default, and with no provider back-ends the
    /// only reachable value.
    #[default]
    Receipt,
    /// Waits for provider custody. Dormant in v1.
    Replicated,
}

/// Direct-to-cold for large originals. Dormant in v1 (no providers), kept so a
/// v0 policy row still reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectToCold {
    pub enabled: bool,
    pub min_bytes: u64,
    pub mime_prefixes: Vec<String>,
}

impl Default for DirectToCold {
    fn default() -> Self {
        Self {
            enabled: true,
            min_bytes: 25 * 1024 * 1024,
            mime_prefixes: vec!["video/".into(), "audio/".into()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPolicy {
    /// Offsite WAL lag; **also** the vault's WAL capture tick.
    pub rpo_seconds: u64,
    pub snapshot_interval_hours: u64,
    pub verify_every_days: u64,
    pub cas_ack: CasAck,
    pub outbox_budget_bytes: u64,
    /// The disk a vault refuses to spend, so it can always write its own WAL.
    pub reserved_headroom_bytes: u64,
    /// `None` means derive a cache budget from the real volume.
    pub cache_budget_bytes: Option<u64>,
    /// `None` or zero means unthrottled.
    pub throttle_bytes_per_sec: Option<u64>,
    /// Dormant in v1. When set it wins over `direct_to_cold_originals`.
    pub storage_class: Option<String>,
    /// Dormant in v1.
    pub direct_to_cold_originals: Option<DirectToCold>,
    pub wal_base_roll_bytes: u64,
    pub wal_base_roll_hours: u64,
}

impl Default for BackupPolicy {
    /// v0's defaults, unchanged: an owner who upgrades keeps the clocks they
    /// had.
    fn default() -> Self {
        Self {
            rpo_seconds: 60,
            snapshot_interval_hours: 24,
            verify_every_days: 7,
            cas_ack: CasAck::Receipt,
            outbox_budget_bytes: 512 * 1024 * 1024,
            reserved_headroom_bytes: 256 * 1024 * 1024,
            cache_budget_bytes: None,
            throttle_bytes_per_sec: None,
            storage_class: None,
            direct_to_cold_originals: None,
            wal_base_roll_bytes: 16 * 1024 * 1024,
            wal_base_roll_hours: 24,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("backup policy: {0}")]
pub struct BackupPolicyError(String);

impl BackupPolicy {
    /// Refuse a policy that cannot be kept, at the point it is set.
    ///
    /// Every one of these would otherwise show up as an operational mystery:
    /// an RPO nothing can meet, a snapshot interval of zero spinning the
    /// machine, a verify cadence that never verifies.
    pub fn validate(&self) -> Result<(), BackupPolicyError> {
        let refuse = |what: String| Err(BackupPolicyError(what));
        if self.rpo_seconds < MIN_RPO_SECONDS {
            return refuse(format!(
                "rpoSeconds {} is below the {MIN_RPO_SECONDS}s floor",
                self.rpo_seconds
            ));
        }
        if self.snapshot_interval_hours == 0 {
            return refuse("snapshotIntervalHours must be at least 1".into());
        }
        if self.verify_every_days == 0 {
            return refuse("verifyEveryDays must be at least 1".into());
        }
        if self.wal_base_roll_bytes == 0 {
            return refuse("walBaseRollBytes must be at least 1".into());
        }
        if self.wal_base_roll_hours == 0 {
            return refuse("walBaseRollHours must be at least 1".into());
        }
        if self.outbox_budget_bytes == 0 {
            return refuse("outboxBudgetBytes must be at least 1".into());
        }
        Ok(())
    }

    /// The capture tick, in milliseconds — the same number as the RPO, which is
    /// the whole point.
    #[must_use]
    pub const fn capture_tick_ms(&self) -> u64 {
        self.rpo_seconds * 1_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_v0s_defaults() {
        let policy = BackupPolicy::default();
        assert_eq!(policy.rpo_seconds, 60);
        assert_eq!(policy.snapshot_interval_hours, 24);
        assert_eq!(policy.verify_every_days, 7);
        assert_eq!(policy.cas_ack, CasAck::Receipt);
        assert_eq!(policy.outbox_budget_bytes, 512 * 1024 * 1024);
        assert_eq!(policy.reserved_headroom_bytes, 256 * 1024 * 1024);
        assert_eq!(policy.wal_base_roll_bytes, 16 * 1024 * 1024);
        assert_eq!(policy.wal_base_roll_hours, 24);
        assert_eq!(policy.cache_budget_bytes, None);
        policy.validate().unwrap();
    }

    #[test]
    fn the_capture_tick_is_the_rpo_and_not_a_second_number() {
        assert_eq!(BackupPolicy::default().capture_tick_ms(), 60_000);
    }

    /// One unkeepable value per field, each with the field name the refusal
    /// must carry — a message that does not name the field leaves an operator
    /// guessing which of eleven numbers they got wrong.
    type Mutate = fn(BackupPolicy) -> BackupPolicy;

    #[test]
    fn a_policy_that_cannot_be_kept_is_refused_where_it_is_set() {
        let cases: [(&str, Mutate); 6] = [
            ("rpoSeconds", |policy| BackupPolicy {
                rpo_seconds: 29,
                ..policy
            }),
            ("snapshotIntervalHours", |policy| BackupPolicy {
                snapshot_interval_hours: 0,
                ..policy
            }),
            ("verifyEveryDays", |policy| BackupPolicy {
                verify_every_days: 0,
                ..policy
            }),
            ("walBaseRollBytes", |policy| BackupPolicy {
                wal_base_roll_bytes: 0,
                ..policy
            }),
            ("walBaseRollHours", |policy| BackupPolicy {
                wal_base_roll_hours: 0,
                ..policy
            }),
            ("outboxBudgetBytes", |policy| BackupPolicy {
                outbox_budget_bytes: 0,
                ..policy
            }),
        ];
        for (field, mutate) in cases {
            let error = mutate(BackupPolicy::default()).validate().unwrap_err();
            assert!(error.to_string().contains(field), "{field}: {error}");
        }
        // Exactly at the floor is allowed — the floor is a floor, not a bound.
        BackupPolicy {
            rpo_seconds: MIN_RPO_SECONDS,
            ..BackupPolicy::default()
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn the_policy_serialises_camel_case_so_an_owner_reads_what_they_set() {
        let json = serde_json::to_value(BackupPolicy::default()).unwrap();
        assert_eq!(json["rpoSeconds"], 60);
        assert_eq!(json["casAck"], "receipt");
        assert!(json.get("rpo_seconds").is_none());
        let back: BackupPolicy = serde_json::from_value(json).unwrap();
        assert_eq!(back, BackupPolicy::default());
    }
}
