//! The audit band: the invocation journal, the check rows, the receipt chain.
//!
//! **Append-only by trigger, not by convention.** The baseline carries
//! `access_receipt_append_only_u` and `_d`, which refuse UPDATE and DELETE
//! unless `audit_archive_pass` holds a row. So this module does not need to be
//! careful — the file is.
//!
//! Two shapes worth naming:
//!
//! - **`agent_command_invocation`'s pointers into the model half are VALUE
//!   COLUMNS, not foreign keys.** An audit row outlives its subject, and a key
//!   would either block a purge or rewrite the evidence. That is a deliberate
//!   asymmetry, not a missing constraint.
//! - **`access_receipt.seq` is the chain position itself.** The head used to be
//!   found by `ORDER BY receipt_id DESC`, correct only by the accident that ids
//!   are uuid v7. A hash chain whose order is an accident is not a chain.
//!
//! The invocation's input is passed through the sealed scrub before it lands:
//! the journal is append-only, so a secret written into it is permanent.

use rusqlite::Connection;
use sha2::{Digest as _, Sha256};

use crate::clock::{Clock, Ids};
use crate::error::Result;

/// Replace the values of declared-secret keys with keyed tokens.
///
/// A token, not a removal: a reviewer reading the journal needs to see that a
/// field was supplied, and the hash lets two invocations with the same secret
/// be recognised as the same without the secret being recoverable.
#[must_use]
pub fn redact_command_input(input: &serde_json::Value, sealed_keys: &[&str]) -> serde_json::Value {
    let Some(map) = input.as_object() else {
        return input.clone();
    };
    let mut out = map.clone();
    for key in sealed_keys {
        if let Some(value) = out.get_mut(*key) {
            let rendered = serde_json::to_string(value).unwrap_or_default();
            *value = serde_json::Value::String(format!(
                "sealed:sha256:{}",
                &hex::encode(Sha256::digest(rendered.as_bytes()))[..16]
            ));
        }
    }
    serde_json::Value::Object(out)
}

/// Scrub sealed values out of a message before it reaches a journal, a receipt
/// or a response.
///
/// Validation errors quote the value that failed, which for a sealed field is
/// the secret itself.
#[must_use]
pub fn scrub_sealed(message: &str, sealed_keys: &[&str], input: &serde_json::Value) -> String {
    let mut out = message.to_owned();
    let Some(map) = input.as_object() else {
        return out;
    };
    for key in sealed_keys {
        if let Some(serde_json::Value::String(secret)) = map.get(*key)
            && !secret.is_empty()
        {
            out = out.replace(secret.as_str(), "‹sealed›");
        }
    }
    out
}

/// What a `proposed` invocation row says.
///
/// A struct rather than eight positional arguments: five of the eight are
/// `&str`, and a caller that transposed `command_id` and `caller_id` would
/// write a journal row that reads fine and is wrong about who did it.
pub struct Invocation<'a> {
    pub invocation_id: &'a str,
    pub command_id: &'a str,
    pub caller_id: &'a str,
    pub authority_id: Option<&'a str>,
    pub input: &'a serde_json::Value,
    /// Input keys whose values are secrets: tokenised before the journal.
    pub sealed_keys: &'a [&'a str],
}

/// Write the `proposed` invocation row.
pub fn insert_invocation(
    connection: &Connection,
    clock: &dyn Clock,
    invocation: &Invocation<'_>,
) -> Result<()> {
    let Invocation {
        invocation_id,
        command_id,
        caller_id,
        authority_id,
        input,
        sealed_keys,
    } = *invocation;
    let redacted = redact_command_input(input, sealed_keys);
    connection.execute(
        "INSERT INTO agent_command_invocation
           (invocation_id, command_id, caller_id, authority_id, input_json, status, requested_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'proposed', ?6)",
        rusqlite::params![
            invocation_id,
            command_id,
            caller_id,
            authority_id,
            serde_json::to_string(&redacted).unwrap_or_else(|_| "{}".to_owned()),
            clock.now_text(),
        ],
    )?;
    Ok(())
}

/// Refuse an invocation id already bound to another command, caller or grant.
///
/// Run BEFORE any handler; repeated in commit repair only as a corruption
/// guard, where it should never fire.
pub fn assert_invocation_identity(
    connection: &Connection,
    invocation_id: &str,
    command_id: &str,
    caller_id: &str,
) -> Result<()> {
    let mut statement = connection.prepare_cached(
        "SELECT command_id, caller_id FROM agent_command_invocation WHERE invocation_id = ?1",
    )?;
    let mut rows = statement.query([invocation_id])?;
    if let Some(row) = rows.next()? {
        let bound_command: String = row.get(0)?;
        let bound_caller: String = row.get(1)?;
        if bound_command != command_id || bound_caller != caller_id {
            return Err(crate::error::VaultError::Invariant {
                context: format!(
                    "invocation `{invocation_id}` is already bound to `{bound_command}` for `{bound_caller}`"
                ),
            });
        }
    }
    Ok(())
}

/// Move an invocation's status.
pub fn set_invocation_status(
    connection: &Connection,
    clock: &dyn Clock,
    invocation_id: &str,
    status: &str,
) -> Result<()> {
    let executed_at = if status == "executed" {
        Some(clock.now_text())
    } else {
        None
    };
    connection.execute(
        "UPDATE agent_command_invocation
            SET status = ?1, executed_at = COALESCE(?2, executed_at)
          WHERE invocation_id = ?3",
        rusqlite::params![status, executed_at, invocation_id],
    )?;
    Ok(())
}

/// One check row.
pub struct Check<'a> {
    pub invocation_id: &'a str,
    /// `pre` or `post`.
    pub phase: &'a str,
    /// The raw predicate, for the audit trail.
    pub predicate: &'a str,
    pub passed: bool,
    pub observed: Option<&'a str>,
}

/// Write one check row. **Every** precondition's result is written, not only
/// the failing one — a journal that recorded only failures cannot show that the
/// others were evaluated at all.
pub fn write_check(
    connection: &Connection,
    clock: &dyn Clock,
    ids: &dyn Ids,
    check: &Check<'_>,
) -> Result<()> {
    let Check {
        invocation_id,
        phase,
        predicate,
        passed,
        observed,
    } = *check;
    connection.execute(
        "INSERT INTO agent_invocation_check
           (check_id, invocation_id, phase, predicate, passed, observed_json, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            ids.next(),
            invocation_id,
            phase,
            predicate,
            i64::from(passed),
            observed,
            clock.now_text(),
        ],
    )?;
    Ok(())
}

/// Write an owner-facing explanation of what happened.
pub fn write_explanation(
    connection: &Connection,
    clock: &dyn Clock,
    ids: &dyn Ids,
    invocation_id: &str,
    summary: &str,
) -> Result<()> {
    connection.execute(
        "INSERT INTO agent_explanation
           (explanation_id, invocation_id, audience, summary, generated_at)
         VALUES (?1, ?2, 'owner', ?3, ?4)",
        rusqlite::params![ids.next(), invocation_id, summary, clock.now_text()],
    )?;
    Ok(())
}

/// What a receipt records.
pub struct Receipt<'a> {
    pub authority_id: Option<&'a str>,
    pub invocation_id: &'a str,
    pub action: &'a str,
    pub object_type: &'a str,
    pub object_id: Option<&'a str>,
    /// `allow` or `deny`. A deny IS receipted — a refusal with no receipt is a
    /// refusal nobody can audit.
    pub decision: &'a str,
    pub detail: serde_json::Value,
}

/// Append a receipt to the chain, returning its id.
///
/// The chain: `seq` is the position and `hash` is
/// `sha256(prev_hash ‖ seq ‖ canonical(receipt))`, unique by constraint. So a
/// removed row breaks every hash after it, and a rewritten one breaks its own.
pub fn write_receipt(
    connection: &Connection,
    clock: &dyn Clock,
    ids: &dyn Ids,
    receipt: &Receipt<'_>,
) -> Result<String> {
    let (previous_seq, previous_hash): (i64, String) = connection
        .query_row(
            "SELECT COALESCE(seq, 0), hash FROM access_receipt ORDER BY seq DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, String::new()));
    let seq = previous_seq + 1;
    let receipt_id = ids.next();
    let occurred_at = clock.now_text();
    // `detail_json` is written through the canonical form, so its key order is
    // deterministic — which is what makes the hash reproducible and what keeps
    // the log's own redaction of `output` byte-stable.
    let detail = crate::intents::canonical_json(&receipt.detail)?;
    let body = format!(
        "{previous_hash}\u{0}{seq}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{occurred_at}\u{0}{detail}",
        receipt.authority_id.unwrap_or(""),
        receipt.invocation_id,
        receipt.action,
        receipt.object_type,
        receipt.decision,
    );
    let hash = hex::encode(Sha256::digest(body.as_bytes()));
    connection.execute(
        "INSERT INTO access_receipt
           (receipt_id, authority_id, invocation_id, action, object_type, object_id,
            decision, occurred_at, hash, detail_json, seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            receipt_id,
            receipt.authority_id,
            receipt.invocation_id,
            receipt.action,
            receipt.object_type,
            receipt.object_id,
            receipt.decision,
            occurred_at,
            hash,
            detail,
            seq,
        ],
    )?;
    connection.execute(
        "UPDATE agent_command_invocation SET receipt_id = ?1 WHERE invocation_id = ?2",
        rusqlite::params![receipt_id, receipt.invocation_id],
    )?;
    Ok(receipt_id)
}

/// Verify the receipt chain from the bottom up.
///
/// Returns the findings, one line each, so a caller can put them in front of a
/// reviewer rather than reporting `false`.
pub fn verify_receipt_chain(connection: &Connection) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT seq, authority_id, invocation_id, action, object_type, decision,
                occurred_at, hash, detail_json
           FROM access_receipt ORDER BY seq",
    )?;
    struct Row {
        seq: i64,
        authority_id: Option<String>,
        invocation_id: String,
        action: String,
        object_type: String,
        decision: String,
        occurred_at: String,
        hash: String,
        detail: Option<String>,
    }
    let rows: Vec<Row> = statement
        .query_map([], |row| {
            Ok(Row {
                seq: row.get(0)?,
                authority_id: row.get(1)?,
                invocation_id: row.get(2)?,
                action: row.get(3)?,
                object_type: row.get(4)?,
                decision: row.get(5)?,
                occurred_at: row.get(6)?,
                hash: row.get(7)?,
                detail: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut findings = Vec::new();
    let mut previous_hash = String::new();
    let mut expected_seq = 1;
    for row in &rows {
        if row.seq != expected_seq {
            findings.push(format!(
                "the chain jumps from {} to {}",
                expected_seq - 1,
                row.seq
            ));
        }
        let body = format!(
            "{previous_hash}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
            row.seq,
            row.authority_id.as_deref().unwrap_or(""),
            row.invocation_id,
            row.action,
            row.object_type,
            row.decision,
            row.occurred_at,
            row.detail.as_deref().unwrap_or(""),
        );
        let hash = hex::encode(Sha256::digest(body.as_bytes()));
        if hash != row.hash {
            findings.push(format!("receipt {} does not hash to its own body", row.seq));
        }
        previous_hash = row.hash.clone();
        expected_seq = row.seq + 1;
    }
    Ok(findings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_input_lands_as_a_token_and_never_as_a_value() {
        let input = serde_json::json!({"label": "email", "access_token": "hunter2"});
        let redacted = redact_command_input(&input, &["access_token"]);
        let text = serde_json::to_string(&redacted).expect("serialises");
        assert!(!text.contains("hunter2"));
        assert!(text.contains("sealed:sha256:"));
        // The KEY survives: a reviewer has to see that a secret was supplied.
        assert!(text.contains("access_token"));
        assert!(text.contains("email"));
        // And the same secret tokenises the same way, so two invocations can
        // be recognised as carrying one credential.
        assert_eq!(redact_command_input(&input, &["access_token"]), redacted);
    }

    #[test]
    fn a_validation_message_quoting_a_secret_is_scrubbed() {
        let input = serde_json::json!({"access_token": "hunter2"});
        let message = "\"hunter2\" is not of type integer";
        let scrubbed = scrub_sealed(message, &["access_token"], &input);
        assert!(!scrubbed.contains("hunter2"));
        assert!(scrubbed.contains("‹sealed›"));
    }
}
