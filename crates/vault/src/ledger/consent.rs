//! `conversation_provider_consent`: which providers this conversation may send
//! to (#1020, D-1020-AS3/AS4).
//!
//! ## Two sources, and the CHECK that keeps them apart
//!
//! A consent row is either **direct** (the member said yes to this provider for
//! this conversation, and `subsystem` is the empty string) or **ladder** (the
//! member said yes to a provider for a whole subsystem —
//! `assistant | ask | builder | automations`). The table's CHECK enforces
//! exactly that pairing, so there is no row that is "ladder, no subsystem" or
//! "direct, for the builder": the two shapes cannot be confused by a writer.
//!
//! ## Membership is content-independent
//!
//! This is the property the #842 corpus's `egress-no-widen` payloads attack.
//! Content arriving *through* a turn — a calendar description, an OCR'd
//! receipt, a shared-commons row — can ask for a new provider as persuasively
//! as it likes; nothing in this module is reachable from it. The consent set is
//! written by an owner gesture and read by the posture, and [`has`] is a
//! question, never a request.
//!
//! A revoked row is kept with `revoked_at` set rather than deleted, because
//! "was this ever consented, and when was it withdrawn" is a question a member
//! asks after the fact.

use rusqlite::params;

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// Where a consent came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// This conversation, this provider. `subsystem` is `""`.
    Direct,
    /// A subsystem-wide grant.
    Ladder(Subsystem),
}

/// The four subsystems a ladder grant can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subsystem {
    Assistant,
    Ask,
    Builder,
    Automations,
}

impl Subsystem {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Assistant => "assistant",
            Self::Ask => "ask",
            Self::Builder => "builder",
            Self::Automations => "automations",
        }
    }
}

impl Source {
    const fn parts(self) -> (&'static str, &'static str) {
        match self {
            Self::Direct => ("direct", ""),
            Self::Ladder(subsystem) => ("ladder", subsystem.as_str()),
        }
    }
}

/// Grant a consent. Idempotent, and a re-grant clears an earlier revocation.
pub fn grant(
    vault: &Vault,
    conversation_id: &str,
    harness_kind: &str,
    source: Source,
) -> Result<()> {
    let (source_text, subsystem) = source.parts();
    let now = vault.clock().now_ms();
    vault.commit(|tx| {
        tx.set_producer("ledger.provider_consent.grant");
        tx.connection()
            .execute(
                "INSERT INTO conversation_provider_consent \
                 (conversation_id, harness_kind, source, subsystem, granted_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT (conversation_id, harness_kind, source, subsystem) DO UPDATE SET \
                   granted_at = ?5, revoked_at = NULL",
                params![conversation_id, harness_kind, source_text, subsystem, now],
            )
            .map_err(|error| VaultError::from_sqlite("granting provider egress", error))?;
        Ok(())
    })?;
    Ok(())
}

/// Withdraw a consent. The row survives, carrying when it was withdrawn.
pub fn revoke(
    vault: &Vault,
    conversation_id: &str,
    harness_kind: &str,
    source: Source,
) -> Result<()> {
    let (source_text, subsystem) = source.parts();
    let now = vault.clock().now_ms();
    vault.commit(|tx| {
        tx.set_producer("ledger.provider_consent.revoke");
        tx.connection()
            .execute(
                "UPDATE conversation_provider_consent SET revoked_at = ?5 \
                 WHERE conversation_id = ?1 AND harness_kind = ?2 AND source = ?3 \
                   AND subsystem = ?4 AND revoked_at IS NULL",
                params![conversation_id, harness_kind, source_text, subsystem, now],
            )
            .map_err(|error| VaultError::from_sqlite("revoking provider egress", error))?;
        Ok(())
    })?;
    Ok(())
}

/// Is this dispatch consented?
///
/// A live direct grant, or a live ladder grant for the subsystem. Nothing else,
/// and in particular no "the member consented to a similar provider" reasoning:
/// a provider is a distinct destination for the member's data.
pub fn has(
    vault: &Vault,
    conversation_id: &str,
    harness_kind: &str,
    subsystem: Subsystem,
) -> Result<bool> {
    vault.read(|connection| {
        connection
            .query_row(
                "SELECT EXISTS ( \
                   SELECT 1 FROM conversation_provider_consent \
                    WHERE conversation_id = ?1 AND harness_kind = ?2 AND revoked_at IS NULL \
                      AND ( (source = 'direct' AND subsystem = '') \
                            OR (source = 'ladder' AND subsystem = ?3) ) )",
                params![conversation_id, harness_kind, subsystem.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map(|found| found == 1)
            .map_err(|error| VaultError::from_sqlite("reading provider egress consent", error))
    })
}

/// Every live consent for a conversation, as `(harness_kind, source,
/// subsystem)`. What a settings screen renders.
pub fn live(vault: &Vault, conversation_id: &str) -> Result<Vec<(String, String, String)>> {
    vault.read(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT harness_kind, source, subsystem FROM conversation_provider_consent \
                 WHERE conversation_id = ?1 AND revoked_at IS NULL \
                 ORDER BY harness_kind, source, subsystem",
            )
            .map_err(|error| VaultError::from_sqlite("listing provider consent", error))?;
        let rows = statement
            .query_map([conversation_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|error| VaultError::from_sqlite("listing provider consent", error))?;
        let mut found = Vec::new();
        for row in rows {
            found.push(
                row.map_err(|error| VaultError::from_sqlite("listing provider consent", error))?,
            );
        }
        Ok(found)
    })
}
