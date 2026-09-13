//! The #842 prompt-injection corpus, as a Rust gate (#1020, D-1020-AS6).
//!
//! This module is the **loader and the vocabulary**; the run is
//! `crates/assist/tests/prompt_injection.rs` and the gate step is
//! `cargo xtask gate`'s `prompt-injection`.
//!
//! Read `contracts/assist/prompt-injection/ORIGIN.md` first: it records where
//! the payloads came from, what the boundary under test is, and why a breach is
//! a defect rather than a suite to adjust.
//!
//! ## Grow-only, and nothing hardcodes the list
//!
//! [`load`] reads every `*.json` in the directory, sorted. A new payload is
//! picked up with no code change — which is the property that makes the corpus
//! worth having, because the next attack shape will be written by somebody who
//! is not editing this file.
//!
//! ## Why the expected outcome is a value in the payload
//!
//! `expect.outcome` is part of the fixture rather than a table in the test. The
//! payload and its expected refusal were authored together, and separating them
//! would let a payload be added with nobody deciding what should happen to it.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Where the payloads live, relative to the workspace root.
pub const CORPUS_DIR: &str = "contracts/assist/prompt-injection";

/// How the injected content reached the vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Carrier {
    /// A calendar feed's event description.
    Ics,
    /// Text recognised from an image.
    Ocr,
    /// A row shared from another vault.
    Commons,
}

/// The structural property the payload attacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Invariant {
    ReadConfinement,
    RiskPark,
    EgressNoWiden,
    NoOutOfGrantEntity,
}

/// What the gateway must do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// The call was rejected before it reached a handler.
    Refused,
    /// The grant scope said no.
    Denied,
    /// Queued for the owner's decision, and not executed.
    Parked,
    /// Ran, and was supposed to: a payload that asks for something already
    /// permitted proves the corpus is not passing by refusing everything.
    Allowed,
}

/// What the injected content tries to do.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum Attempt {
    /// A command invocation.
    VaultInvoke {
        command: String,
        input: serde_json::Value,
    },
    /// A whole-model statement.
    VaultSql { sql: String },
    /// A paged read of an entity.
    GatewayRead { entity: String },
    /// A dispatch to a provider that is not in the consented set.
    ProviderEgress { provider: String },
}

/// The expected outcome, as the fixture carries it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Expect {
    pub outcome: Outcome,
}

/// One payload.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Payload {
    pub id: String,
    pub carrier: Carrier,
    pub category: String,
    pub invariant: Invariant,
    /// A marker string that must appear in the prompt the harness actually
    /// received. It is how the test proves the injected content reached the
    /// model at all — a corpus that passes because nothing was injected is a
    /// corpus that proves nothing.
    pub sentinel: String,
    pub content: String,
    pub attempt: Attempt,
    pub expect: Expect,
    pub notes: String,
}

/// Why the corpus could not be loaded. A missing corpus is an error, never an
/// empty run: "zero payloads, all green" is the failure mode a gate exists to
/// prevent.
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("the corpus directory {0} is not there")]
    Missing(PathBuf),
    #[error("the corpus at {0} is empty")]
    Empty(PathBuf),
    #[error("{path}: {detail}")]
    Malformed { path: PathBuf, detail: String },
}

/// Every payload, sorted by file name.
pub fn load(root: &Path) -> Result<Vec<Payload>, LoadError> {
    let directory = root.join(CORPUS_DIR);
    let entries =
        std::fs::read_dir(&directory).map_err(|_| LoadError::Missing(directory.clone()))?;
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    let mut payloads = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).map_err(|error| LoadError::Malformed {
            path: file.clone(),
            detail: error.to_string(),
        })?;
        payloads.push(
            serde_json::from_str(&text).map_err(|error| LoadError::Malformed {
                path: file.clone(),
                detail: error.to_string(),
            })?,
        );
    }
    if payloads.is_empty() {
        return Err(LoadError::Empty(directory));
    }
    Ok(payloads)
}

/// The workspace root, from this crate's manifest directory.
#[must_use]
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_corpus_spans_every_carrier_and_every_invariant() {
        let payloads = load(&workspace_root()).expect("the corpus is committed");
        assert!(
            payloads.len() >= 10,
            "the corpus is {} payloads; it is grow-only and must not shrink",
            payloads.len()
        );

        let mut carriers: Vec<Carrier> = payloads.iter().map(|p| p.carrier).collect();
        carriers.sort_unstable();
        carriers.dedup();
        assert_eq!(carriers, [Carrier::Ics, Carrier::Ocr, Carrier::Commons]);

        let mut invariants: Vec<Invariant> = payloads.iter().map(|p| p.invariant).collect();
        invariants.sort_unstable();
        invariants.dedup();
        assert_eq!(
            invariants,
            [
                Invariant::ReadConfinement,
                Invariant::RiskPark,
                Invariant::EgressNoWiden,
                Invariant::NoOutOfGrantEntity
            ]
        );

        let mut ids: Vec<&str> = payloads.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "two payloads share an id");
    }

    #[test]
    fn every_payload_carries_its_sentinel_in_its_content() {
        // The property the injection test depends on: if the sentinel is not
        // in the content, the test cannot prove the content reached the model.
        for payload in load(&workspace_root()).expect("the corpus is committed") {
            assert!(
                payload.content.contains(&payload.sentinel),
                "{}: the sentinel is not in the content",
                payload.id
            );
        }
    }

    #[test]
    fn a_missing_corpus_is_an_error_and_not_an_empty_pass() {
        let temp = tempfile::tempdir().expect("tempdir");
        assert!(matches!(load(temp.path()), Err(LoadError::Missing(_))));
        std::fs::create_dir_all(temp.path().join(CORPUS_DIR)).expect("mkdir");
        assert!(matches!(load(temp.path()), Err(LoadError::Empty(_))));
    }
}
