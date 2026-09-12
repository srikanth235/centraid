//! The WAL stream: sealed segments addressed by where they came from (#1020,
//! D-1020-R5).
//!
//! A backup generation is D1's snapshot artefact **plus** the WAL segments that
//! happened after it. The segment is the unit of an RPO: `rpoSeconds` is also
//! the vault's WAL capture tick, so "how much can I lose" and "how often do I
//! ship" are one number the owner sets once.
//!
//! ## The address is the identity
//!
//! ```text
//! {db, generation, group, startOffset, endOffset, tickMs}
//! ```
//!
//! Both the nonce info and the AAD carry **every** field, both offsets
//! included. That is the #408 rule and it is not decoration: a crash-retry that
//! ships a *longer* segment from the same start offset must re-nonce, and only
//! including `endOffset` makes that happen. A deterministic nonce over a
//! partial address is a nonce reuse under the same key, which for AES-GCM is
//! total loss of confidentiality for both segments.
//!
//! `db` is `vault` or `journal` and nothing else — a third database would need
//! its own retention window and its own restore ordering, so the refusal is at
//! the seal rather than at the restore.
//!
//! The seal and open themselves live in [`centraid_media::format`], moved from
//! v0 so the byte format is the one the cross-language golden pins. This module
//! is the vault-side ordering: which segments exist, in what order they replay,
//! and where a point-in-time `--at` stops.

pub use centraid_media::format::WalAddress;

use crate::backup::keyring::{KeyringError, derive_data_key};

#[derive(Debug, thiserror::Error)]
pub enum WalError {
    #[error("{0}")]
    Format(String),
    #[error(transparent)]
    Keyring(#[from] KeyringError),
}

type Result<T> = std::result::Result<T, WalError>;

fn format_error(error: anyhow::Error) -> WalError {
    WalError::Format(error.to_string())
}

/// One sealed segment, as a generation's manifest lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalSegment {
    pub db: String,
    pub generation: String,
    pub group: u64,
    pub start_offset: u64,
    pub end_offset: u64,
    /// The capture tick this segment closed at. `--at` compares against this.
    pub tick_ms: u64,
    /// Where the sealed bytes live in the blob store.
    pub blob_id: String,
}

impl WalSegment {
    #[must_use]
    pub fn address(&self) -> WalAddress<'_> {
        WalAddress {
            db: &self.db,
            generation: &self.generation,
            group: self.group,
            start_offset: self.start_offset,
            end_offset: self.end_offset,
            tick_ms: self.tick_ms,
        }
    }

    /// Replay order: by database, then by group, then by start offset.
    ///
    /// Not by `tick_ms`: two segments can close in the same tick, and the
    /// offsets are the only total order the WAL itself defines.
    #[must_use]
    pub fn replay_key(&self) -> (&str, u64, u64) {
        (&self.db, self.group, self.start_offset)
    }
}

/// Seal one WAL segment under the backup data key.
pub fn seal_segment(
    master: &[u8],
    vault_id: &str,
    address: &WalAddress<'_>,
    plain: &[u8],
) -> Result<Vec<u8>> {
    let data_key = derive_data_key(master, vault_id)?;
    centraid_media::format::seal_wal_segment(&data_key, vault_id, address, plain)
        .map_err(format_error)
}

/// Open one WAL segment. The address must be the one it was sealed under, to
/// the byte — a segment opened under a neighbouring address fails.
pub fn open_segment(
    master: &[u8],
    vault_id: &str,
    address: &WalAddress<'_>,
    sealed: &[u8],
) -> Result<Vec<u8>> {
    let data_key = derive_data_key(master, vault_id)?;
    centraid_media::format::open_wal_segment(&data_key, vault_id, address, sealed)
        .map_err(format_error)
}

/// The segments a replay to `at_ms` must apply, in replay order.
///
/// **Inclusive of the tick.** `--at` is the owner saying "the state as of this
/// moment", and a segment that closed *at* that millisecond is part of that
/// state. Segments above it are left on the floor, which is what makes a
/// point-in-time restore a restore rather than a full one.
#[must_use]
pub fn segments_to_replay(segments: &[WalSegment], at_ms: Option<u64>) -> Vec<&WalSegment> {
    let mut chosen: Vec<&WalSegment> = segments
        .iter()
        .filter(|segment| at_ms.is_none_or(|at| segment.tick_ms <= at))
        .collect();
    chosen.sort_by(|left, right| left.replay_key().cmp(&right.replay_key()));
    chosen
}

/// Whether a replay to `at_ms` leaves segments unapplied — the "truncated"
/// line the recover report prints, so an owner is never quietly handed less
/// than they have.
#[must_use]
pub fn replay_is_truncated(segments: &[WalSegment], at_ms: Option<u64>) -> bool {
    at_ms.is_some_and(|at| segments.iter().any(|segment| segment.tick_ms > at))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: [u8; 32] = [0xaa_u8; 32];
    const VAULT: &str = "00000000-0000-7000-8000-000000000456";

    fn address(start: u64, end: u64) -> WalAddress<'static> {
        WalAddress {
            db: "vault",
            generation: "0123456789abcdef0123456789abcdef",
            group: 7,
            start_offset: start,
            end_offset: end,
            tick_ms: 1_721_280_000_456,
        }
    }

    #[test]
    fn a_segment_round_trips_under_its_own_address() {
        let plain = b"authenticated WAL bytes";
        let address = address(32, 32 + plain.len() as u64);
        let sealed = seal_segment(&MASTER, VAULT, &address, plain).unwrap();
        assert_eq!(
            open_segment(&MASTER, VAULT, &address, &sealed).unwrap(),
            plain
        );
        assert_eq!(
            sealed,
            seal_segment(&MASTER, VAULT, &address, plain).unwrap(),
            "the nonce is derived, so sealing twice is byte-identical"
        );
    }

    /// The #408 rule. A crash-retry shipping a longer segment from the same
    /// start offset must **not** reuse the nonce.
    #[test]
    fn a_longer_retry_from_the_same_start_offset_re_nonces() {
        let short = b"twelve bytes";
        let long = b"twelve bytes and then some more";
        let short_sealed = seal_segment(&MASTER, VAULT, &address(32, 32 + 12), short).unwrap();
        let long_sealed =
            seal_segment(&MASTER, VAULT, &address(32, 32 + long.len() as u64), long).unwrap();
        assert_ne!(
            &short_sealed[..12],
            &long_sealed[..12],
            "the nonce must differ when only endOffset differs"
        );
    }

    #[test]
    fn a_segment_opened_under_a_neighbouring_address_or_vault_fails() {
        let plain = b"authenticated WAL bytes";
        let good = address(32, 32 + plain.len() as u64);
        let sealed = seal_segment(&MASTER, VAULT, &good, plain).unwrap();
        let mut wrong_group = address(32, 32 + plain.len() as u64);
        wrong_group.group = 8;
        assert!(open_segment(&MASTER, VAULT, &wrong_group, &sealed).is_err());
        assert!(open_segment(&MASTER, "another-vault", &good, &sealed).is_err());
        assert!(open_segment(&[0xbb_u8; 32], VAULT, &good, &sealed).is_err());
    }

    #[test]
    fn a_length_that_disagrees_with_the_address_is_refused_at_the_seal() {
        let error = seal_segment(&MASTER, VAULT, &address(32, 40), b"only three").unwrap_err();
        assert!(
            error.to_string().contains("disagrees with address"),
            "{error}"
        );
    }

    #[test]
    fn only_the_vault_and_journal_databases_can_be_sealed() {
        let mut third = address(0, 4);
        third.db = "notes";
        assert!(seal_segment(&MASTER, VAULT, &third, b"abcd").is_err());
    }

    fn segment(group: u64, start: u64, tick: u64) -> WalSegment {
        WalSegment {
            db: "vault".into(),
            generation: "g1".into(),
            group,
            start_offset: start,
            end_offset: start + 16,
            tick_ms: tick,
            blob_id: format!("blob-{group}-{start}"),
        }
    }

    #[test]
    fn replay_order_is_by_offset_not_by_tick_and_at_is_inclusive() {
        // Two segments closing in the same tick: the offsets are the only
        // total order the WAL defines.
        let segments = vec![
            segment(1, 32, 2_000),
            segment(1, 0, 2_000),
            segment(2, 0, 3_000),
        ];
        assert_eq!(
            segments_to_replay(&segments, None)
                .iter()
                .map(|s| s.blob_id.clone())
                .collect::<Vec<_>>(),
            vec!["blob-1-0", "blob-1-32", "blob-2-0"]
        );
        assert!(!replay_is_truncated(&segments, None));

        // `--at` at the tick includes the tick.
        assert_eq!(segments_to_replay(&segments, Some(2_000)).len(), 2);
        assert!(replay_is_truncated(&segments, Some(2_000)));
        assert_eq!(segments_to_replay(&segments, Some(3_000)).len(), 3);
        assert!(!replay_is_truncated(&segments, Some(3_000)));
        assert!(segments_to_replay(&segments, Some(1_999)).is_empty());
    }
}
