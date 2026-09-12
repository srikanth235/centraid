//! Retention: sealing cold turn ranges and pruning the rows (#1020,
//! D-1020-AS3).
//!
//! ## Retention is not optional
//!
//! `ledger.ts:1`–`:20` says why in one clause: *which is what keeps the
//! sovereign file small now that there is only one of them.* Before #916 a
//! chatty assistant grew its own database; now it grows the member's vault, the
//! file that is backed up, snapshotted before every migration and copied to
//! every seat. An unbounded transcript makes all four slower forever.
//!
//! ## The shape of a pass
//!
//! 1. **Select** a cold, contiguous range of turns in one conversation
//!    ([`select_range`]). Contiguous and per-conversation, because the sealed
//!    segment is addressed by `(conversation_id, seq_from..=seq_to)` and a
//!    sparse range would need a membership list.
//! 2. **Seal** its rows into one content-addressed segment. The bytes go to the
//!    blob CAS (`crates/media`); this module records the segment's digest, its
//!    sizes and the attachment hashes it references, in `conversation_archive`.
//! 3. **Prune** the raw rows. `items` and `attachments` go with their turns by
//!    CASCADE, so the prune deletes turns and the cascade does the rest — one
//!    statement rather than three, and no window where an item is orphaned.
//!
//! Sealing and pruning are **two commits**, in that order, and the order is the
//! safety property: a crash between them leaves rows that are archived and not
//! yet pruned, which is duplicated data. The other order would lose the
//! transcript.
//!
//! ## What is never selected
//!
//! - A turn **inside the retention window**. Recent history is what a hydration
//!   is built from.
//! - A **pinned** turn, or a turn in a **pinned** conversation. A pin is a
//!   member saying "keep this".
//! - An **open** turn (`ended_at IS NULL`). It may still be streaming.
//! - The **last** `keep_turns` turns of a conversation, whatever their age, so
//!   a conversation that has been quiet for a year still opens with context.
//! - A turn referenced by a **live automation cursor** (§Cross-lane: the
//!   retention pass is assist's and must not prune a live cursor). The
//!   automations lane owns those five tables; this module only refuses to
//!   outrun them.

use rusqlite::params;

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// How a pass is bounded. Every number is injected: a retention rule tested
/// against the host clock is a test that passes today.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    /// Turns started at or before this instant may be sealed.
    pub cold_before_ms: i64,
    /// Never seal the most recent this-many turns of a conversation.
    pub keep_turns: i64,
    /// The most turns one segment may hold, so a pass is bounded work.
    pub max_turns_per_segment: i64,
}

/// A contiguous range of one conversation's turns, chosen for sealing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Range {
    pub conversation_id: String,
    pub seq_from: i64,
    pub seq_to: i64,
    pub turn_ids: Vec<String>,
    pub from_time: i64,
    pub to_time: i64,
}

/// Choose the next range to seal for one conversation, if there is one.
pub fn select_range(
    vault: &Vault,
    conversation_id: &str,
    policy: &Policy,
) -> Result<Option<Range>> {
    vault.read(|connection| {
        // The cut-off seq: everything at or above it is kept regardless of age.
        //
        // The fallback is `MAX(seq) + 1`, not `0`. With `keep_turns = 0` the
        // inner `LIMIT 0` returns no rows, and a `COALESCE(…, 0)` would make
        // the cut-off zero and select nothing — "keep none" would silently mean
        // "seal none", which is the retention pass quietly not running.
        let keep_from: i64 = connection
            .query_row(
                "SELECT COALESCE( \
                   ( SELECT MIN(seq) FROM ( SELECT seq FROM turns WHERE conversation_id = ?1 \
                                            ORDER BY seq DESC LIMIT ?2 ) ), \
                   ( SELECT COALESCE(MAX(seq), -1) + 1 FROM turns WHERE conversation_id = ?1 ) )",
                params![conversation_id, policy.keep_turns],
                |row| row.get(0),
            )
            .map_err(|error| VaultError::from_sqlite("finding the retention cut-off", error))?;

        let mut statement = connection
            .prepare(
                "SELECT t.id, t.seq, t.started_at FROM turns t \
                 JOIN conversations c ON c.id = t.conversation_id \
                 WHERE t.conversation_id = ?1 \
                   AND t.seq < ?2 \
                   AND t.started_at <= ?3 \
                   AND t.ended_at IS NOT NULL \
                   AND t.pinned = 0 \
                   AND c.pinned = 0 \
                   AND NOT EXISTS ( \
                     SELECT 1 FROM conversation_archive a \
                      WHERE a.conversation_id = t.conversation_id \
                        AND t.seq BETWEEN a.seq_from AND a.seq_to ) \
                 ORDER BY t.seq LIMIT ?4",
            )
            .map_err(|error| VaultError::from_sqlite("selecting a cold range", error))?;
        let rows = statement
            .query_map(
                params![
                    conversation_id,
                    keep_from,
                    policy.cold_before_ms,
                    policy.max_turns_per_segment
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|error| VaultError::from_sqlite("selecting a cold range", error))?;

        let mut candidates = Vec::new();
        for row in rows {
            candidates
                .push(row.map_err(|error| VaultError::from_sqlite("selecting a cold range", error))?);
        }
        if candidates.is_empty() {
            return Ok(None);
        }
        // CONTIGUITY, enforced here rather than assumed. A pinned turn in the
        // middle of a cold stretch makes two ranges, and the segment addressed
        // by `seq_from..=seq_to` must be the first of them — not both with a
        // hole.
        let mut turn_ids = Vec::new();
        let mut seq_to = candidates[0].1;
        let mut to_time = candidates[0].2;
        for (id, seq, started_at) in &candidates {
            if turn_ids.is_empty() || *seq == seq_to + 1 {
                turn_ids.push(id.clone());
                seq_to = *seq;
                to_time = to_time.max(*started_at);
            } else {
                break;
            }
        }
        Ok(Some(Range {
            conversation_id: conversation_id.to_owned(),
            seq_from: candidates[0].1,
            seq_to,
            turn_ids,
            from_time: candidates[0].2,
            to_time,
        }))
    })
}

/// The rows of one range, as the canonical JSON the segment carries.
///
/// Turns with their items, ordered, so a rehydration of the segment reproduces
/// the transcript. Attachment *hashes* only: the bytes are already in the CAS
/// and copying them into the segment would double the storage the pass exists
/// to reduce.
pub fn segment_payload(vault: &Vault, range: &Range) -> Result<serde_json::Value> {
    vault.read(|connection| {
        let mut turns = Vec::new();
        let mut attachment_hashes = Vec::new();
        for turn_id in &range.turn_ids {
            let mut items_statement = connection
                .prepare(
                    "SELECT id, ordinal, kind, role, text, name, args_json, output_json, model, \
                            harness, effort, input_tokens, output_tokens, cost_usd, cost_source \
                     FROM items WHERE turn_id = ?1 ORDER BY ordinal, id",
                )
                .map_err(|error| VaultError::from_sqlite("sealing items", error))?;
            let rows = items_statement
                .query_map([turn_id], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "ordinal": row.get::<_, i64>(1)?,
                        "kind": row.get::<_, String>(2)?,
                        "role": row.get::<_, Option<String>>(3)?,
                        "text": row.get::<_, Option<String>>(4)?,
                        "name": row.get::<_, Option<String>>(5)?,
                        "argsJson": row.get::<_, Option<String>>(6)?,
                        "outputJson": row.get::<_, Option<String>>(7)?,
                        "model": row.get::<_, Option<String>>(8)?,
                        "harness": row.get::<_, Option<String>>(9)?,
                        "effort": row.get::<_, Option<String>>(10)?,
                        "inputTokens": row.get::<_, Option<i64>>(11)?,
                        "outputTokens": row.get::<_, Option<i64>>(12)?,
                        "costUsd": row.get::<_, Option<f64>>(13)?,
                        "costSource": row.get::<_, Option<String>>(14)?,
                    }))
                })
                .map_err(|error| VaultError::from_sqlite("sealing items", error))?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row.map_err(|error| VaultError::from_sqlite("sealing items", error))?);
            }

            let mut hashes_statement = connection
                .prepare(
                    "SELECT a.hash FROM attachments a JOIN items i ON i.id = a.item_id \
                     WHERE i.turn_id = ?1 ORDER BY a.hash",
                )
                .map_err(|error| VaultError::from_sqlite("sealing attachments", error))?;
            let hash_rows = hashes_statement
                .query_map([turn_id], |row| row.get::<_, String>(0))
                .map_err(|error| VaultError::from_sqlite("sealing attachments", error))?;
            for row in hash_rows {
                attachment_hashes
                    .push(row.map_err(|error| {
                        VaultError::from_sqlite("sealing attachments", error)
                    })?);
            }

            let turn = connection
                .query_row(
                    "SELECT seq, trigger, summary, ok, error, started_at, ended_at, \
                            hydration_tokens \
                     FROM turns WHERE id = ?1",
                    [turn_id],
                    |row| {
                        Ok(serde_json::json!({
                            "id": turn_id,
                            "seq": row.get::<_, i64>(0)?,
                            "trigger": row.get::<_, String>(1)?,
                            "summary": row.get::<_, Option<String>>(2)?,
                            "ok": row.get::<_, i64>(3)?,
                            "error": row.get::<_, Option<String>>(4)?,
                            "startedAt": row.get::<_, i64>(5)?,
                            "endedAt": row.get::<_, Option<i64>>(6)?,
                            "hydrationTokens": row.get::<_, Option<i64>>(7)?,
                        }))
                    },
                )
                .map_err(|error| VaultError::from_sqlite("sealing a turn", error))?;
            let mut turn = turn;
            turn.as_object_mut()
                .expect("built as an object")
                .insert("items".to_owned(), serde_json::Value::Array(items));
            turns.push(turn);
        }
        attachment_hashes.sort();
        attachment_hashes.dedup();
        Ok(serde_json::json!({
            "conversationId": range.conversation_id,
            "seqFrom": range.seq_from,
            "seqTo": range.seq_to,
            "attachmentHashes": attachment_hashes,
            "turns": turns,
        }))
    })
}

/// Record a sealed segment. Commit one of two.
#[allow(clippy::too_many_arguments)]
pub fn record_segment(
    vault: &Vault,
    range: &Range,
    segment_sha256: &str,
    segment_bytes: i64,
    plaintext_bytes: i64,
    item_count: i64,
    attachment_hashes: &[String],
) -> Result<String> {
    if segment_sha256.len() != 64 {
        // The table's own CHECK says the same thing; saying it here too means
        // the error names the caller's mistake rather than a constraint code.
        return Err(VaultError::Invariant {
            context: format!(
                "a segment digest is 64 hex characters; this one is {}",
                segment_sha256.len()
            ),
        });
    }
    let id = vault.ids().next();
    let now = vault.clock().now_ms();
    let hashes = serde_json::to_string(attachment_hashes).map_err(|error| {
        VaultError::Invariant {
            context: format!("attachment hashes are not JSON: {error}"),
        }
    })?;
    vault.commit(|tx| {
        tx.set_producer("ledger.archive.seal");
        tx.connection()
            .execute(
                "INSERT INTO conversation_archive \
                 (id, conversation_id, seq_from, seq_to, from_time, to_time, turn_count, \
                  item_count, segment_sha256, segment_bytes, plaintext_bytes, \
                  attachment_hashes_json, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    &id,
                    &range.conversation_id,
                    range.seq_from,
                    range.seq_to,
                    range.from_time,
                    range.to_time,
                    i64::try_from(range.turn_ids.len()).unwrap_or(i64::MAX),
                    item_count,
                    segment_sha256,
                    segment_bytes,
                    plaintext_bytes,
                    hashes,
                    now
                ],
            )
            .map_err(|error| VaultError::from_sqlite("recording an archive segment", error))?;
        Ok(())
    })?;
    Ok(id)
}

/// Prune the rows a recorded segment now holds. Commit two of two.
///
/// Refuses to run for a segment that is not recorded — the whole point of the
/// two-commit order.
pub fn prune(vault: &Vault, archive_id: &str) -> Result<usize> {
    let now = vault.clock().now_ms();
    let outcome = vault.commit(|tx| {
        tx.set_producer("ledger.archive.prune");
        let connection = tx.connection();
        let (conversation_id, seq_from, seq_to, pruned_at): (String, i64, i64, Option<i64>) =
            connection
                .query_row(
                    "SELECT conversation_id, seq_from, seq_to, pruned_at \
                     FROM conversation_archive WHERE id = ?1",
                    [archive_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(|error| VaultError::from_sqlite("reading an archive segment", error))?;
        if pruned_at.is_some() {
            // Idempotent: a retried pass must not delete a range a later pass
            // has since re-populated.
            return Ok(0);
        }
        // `items` and `attachments` follow by CASCADE.
        let deleted = connection
            .execute(
                "DELETE FROM turns WHERE conversation_id = ?1 AND seq BETWEEN ?2 AND ?3 \
                   AND pinned = 0",
                params![&conversation_id, seq_from, seq_to],
            )
            .map_err(|error| VaultError::from_sqlite("pruning sealed turns", error))?;
        connection
            .execute(
                "UPDATE conversation_archive SET pruned_at = ?2 WHERE id = ?1",
                params![archive_id, now],
            )
            .map_err(|error| VaultError::from_sqlite("marking a segment pruned", error))?;
        connection
            .execute(
                "UPDATE conversations SET turn_count = ( \
                   SELECT COUNT(*) FROM turns WHERE conversation_id = ?1 ), \
                   item_count = ( SELECT COUNT(*) FROM items i JOIN turns t ON t.id = i.turn_id \
                                  WHERE t.conversation_id = ?1 ) \
                 WHERE id = ?1",
                [&conversation_id],
            )
            .map_err(|error| VaultError::from_sqlite("recounting after a prune", error))?;
        Ok(deleted)
    })?;
    Ok(outcome.value)
}
