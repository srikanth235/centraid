//! The journal: one row for every command the gate was asked to run.
//!
//! **Evidence, not a source of facts.** `journal_is_evidence` refuses an
//! UPDATE, and a retention pass may delete old rows; nothing reads the journal
//! to learn something about the model ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//! The row is written by the gate, in the command's own transaction, so a
//! command that rolled back leaves none (a `failed` row is written in a
//! transaction of its own, after the rollback).
//!
//! The input is passed through the sealed scrub before it lands: the journal
//! is evidence, so a secret written into it is permanent.

use rusqlite::Connection;

use crate::error::Result;

/// How a command ended, as the `journal.outcome` CHECK spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Executed,
    /// The gate said no (authority, schema or a precondition) and wrote nothing else.
    Refused,
    /// The handler or a postcondition errored and the command's writes rolled back.
    Failed,
}

impl Outcome {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Executed => "executed",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }
}

/// The token a secret becomes in the journal.
fn token(value: &serde_json::Value) -> serde_json::Value {
    let rendered = serde_json::to_string(value).unwrap_or_default();
    serde_json::Value::String(format!(
        "sealed:blake3:{}",
        &hex::encode(blake3::hash(rendered.as_bytes()).as_bytes())[..16]
    ))
}

/// A sealed key is a top-level name (`password`) or a name inside every element
/// of a top-level array (`fields[].value`), which is how `locker.duplicate_item`
/// carries the custom fields it re-sealed.
fn nested(key: &str) -> Option<(&str, &str)> {
    key.split_once("[].")
}

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
        if let Some((array, inner)) = nested(key) {
            if let Some(serde_json::Value::Array(items)) = out.get_mut(array) {
                for item in items {
                    if let Some(value) = item.as_object_mut().and_then(|item| item.get_mut(inner)) {
                        *value = token(value);
                    }
                }
            }
        } else if let Some(value) = out.get_mut(*key) {
            *value = token(value);
        }
    }
    serde_json::Value::Object(out)
}

/// Scrub sealed values out of a message before it reaches a journal or a
/// response. A validation error quotes the value that failed, which for a
/// sealed field is the secret itself.
#[must_use]
pub fn scrub_sealed(message: &str, sealed_keys: &[&str], input: &serde_json::Value) -> String {
    let mut out = message.to_owned();
    let Some(map) = input.as_object() else {
        return out;
    };
    let mut scrub = |value: Option<&serde_json::Value>| {
        if let Some(serde_json::Value::String(secret)) = value
            && !secret.is_empty()
        {
            out = out.replace(secret.as_str(), "‹sealed›");
        }
    };
    for key in sealed_keys {
        if let Some((array, inner)) = nested(key) {
            if let Some(serde_json::Value::Array(items)) = map.get(array) {
                for item in items {
                    scrub(item.get(inner));
                }
            }
        } else {
            scrub(map.get(*key));
        }
    }
    out
}

/// The `seq` the next row will take, which the gate reserves before the handler
/// runs so a receipt written by the handler can name the row that explains it.
///
/// `MAX(seq) + 1` is what SQLite would assign, and the commit guard is the
/// vault's only writer, so nothing can take the number in between.
pub fn next_seq(connection: &Connection) -> Result<i64> {
    Ok(
        connection.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM journal", [], |row| {
            row.get(0)
        })?,
    )
}

/// What a row says.
pub struct Entry<'a> {
    pub seq: i64,
    pub at: &'a str,
    pub command: &'a str,
    pub input: &'a serde_json::Value,
    /// Input keys whose values are secrets: tokenised before the row lands.
    pub sealed_keys: &'a [&'a str],
    pub outcome: Outcome,
    /// The sentence a refusal said, or the error a failure ended in.
    pub detail: Option<&'a str>,
}

/// Write one row.
pub fn write(connection: &Connection, entry: &Entry<'_>) -> Result<()> {
    let redacted = redact_command_input(entry.input, entry.sealed_keys);
    connection.execute(
        "INSERT INTO journal (seq, at, command, input, outcome, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            entry.seq,
            entry.at,
            entry.command,
            serde_json::to_string(&redacted).unwrap_or_else(|_| "{}".to_owned()),
            entry.outcome.as_str(),
            entry.detail,
        ],
    )?;
    Ok(())
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
        assert!(text.contains("sealed:blake3:"));
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
