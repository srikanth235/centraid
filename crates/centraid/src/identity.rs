//! `ArtifactIdentity` — what a shell checks before it trusts a core (#1020
//! Artifacts, D-1020-G2).
//!
//! ## The problem
//!
//! #1020 ships a **prebuilt core**: the mobile shell links an AAR or an
//! XCFramework, the desktop seat spawns a binary, the extension talks to a
//! native host. None of them compiles Rust, so none of them can tell by
//! construction that the core it loaded is the one its own build expects. A
//! stale core is the worst failure shape in the whole design: it starts, it
//! answers, and it answers from a schema or a protocol the shell stopped
//! speaking — which surfaces as a pairing bug, a missing row, or a silently
//! wrong answer, days later and in someone else's area.
//!
//! So every artifact carries three facts, baked in at build time by
//! `build.rs`:
//!
//! * `git_sha` — the commit. For a human reading a crash report.
//! * `digest` — `cargo xtask artifact-key`'s output for this triple. This is
//!   the field the machine compares: it is derived from `crates/`, `contracts/`,
//!   the toolchain, the triple, the features, the profile and the resolved
//!   dependency graph, so two artifacts with the same digest are the same
//!   artifact.
//! * `schema_version` — the vault `user_version` this build writes, read from
//!   `centraid_vault::head_version()` so there is no second copy of it.
//!
//! ## The refusal, and why it is a refusal
//!
//! [`require_digest`] is what a shell calls with the digest its OWN build
//! recorded. A mismatch returns `Err` and the caller must fail; it never warns
//! and continues. The message names both digests, because "the core is stale"
//! with no numbers is a message that gets ignored.
//!
//! ## Where this lives, and where it is going
//!
//! `crates/core` and `crates/core-ffi` are wave 2 lane D2's and were not on the
//! umbrella when this landed, so the stamp and the refusal are here, in the one
//! binary, with `centraid --version --json` as the surface. **The move is
//! named, not implied**: when `crates/core-ffi` is on the umbrella this module
//! moves to `crates/core` unchanged and `open`'s handshake response carries an
//! `ArtifactIdentity` with these three field names, which is the contract lane
//! E's KMP side asserts against. The field names are already `gitSha`,
//! `digest`, `schemaVersion` in the JSON for exactly that reason.

use std::fmt;

/// The three facts. Field names match the JSON `--version --json` prints and
/// the handshake field lane E reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactIdentity {
    pub git_sha: String,
    pub digest: String,
    pub schema_version: i64,
}

/// The marker a build with no release stamp carries. Not empty and not a
/// plausible hash: an empty field reads as "not checked" and a plausible hash
/// reads as a release.
pub const DEV: &str = "dev";

impl ArtifactIdentity {
    /// This build's identity.
    #[must_use]
    pub fn current() -> Self {
        Self {
            git_sha: env!("CENTRAID_STAMP_GIT_SHA").to_owned(),
            digest: env!("CENTRAID_STAMP_DIGEST").to_owned(),
            schema_version: centraid_vault::head_version(),
        }
    }

    /// Is this a development build rather than a published artifact?
    #[must_use]
    pub fn is_dev(&self) -> bool {
        self.digest == DEV || self.git_sha == DEV
    }

    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "gitSha": self.git_sha,
            "digest": self.digest,
            "schemaVersion": self.schema_version,
            "dev": self.is_dev(),
        })
        .to_string()
    }
}

impl fmt::Display for ArtifactIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({}, digest {}, schema {})",
            env!("CARGO_PKG_VERSION"),
            self.git_sha,
            self.digest,
            self.schema_version
        )
    }
}

/// THE STALE-ARTIFACT REFUSAL.
///
/// `expected` is the digest the CALLER's build recorded for the core it intends
/// to use. Three outcomes and no fourth:
///
/// * the digests match — `Ok`;
/// * they differ — `Err`, naming both. A stale core is refused at load, before
///   it can answer one query from the wrong schema;
/// * the caller passes `dev`, or this is a `dev` build — `Ok`, and the returned
///   `Some(warning)` SAYS the check did not run. A development build must be
///   loadable by a development shell, and the one thing that must not happen is
///   for that allowance to be silent.
pub fn require_digest(
    identity: &ArtifactIdentity,
    expected: &str,
) -> Result<Option<String>, String> {
    if expected.trim().is_empty() {
        return Err(
            "the shell passed no expected digest. An empty expectation is not a match — it is a \
             build that forgot to record which core it was built against (#1020 Artifacts)."
                .to_owned(),
        );
    }
    if expected == DEV || identity.is_dev() {
        return Ok(Some(format!(
            "artifact identity NOT CHECKED: {} is a development build (expected {expected}, got \
             {}). A released shell never reaches this branch.",
            if identity.is_dev() {
                "this core"
            } else {
                "the shell"
            },
            identity.digest
        )));
    }
    if expected == identity.digest {
        return Ok(None);
    }
    Err(format!(
        "STALE CORE REFUSED: this shell was built against core digest {expected}, and the core it \
         loaded reports {} (git {}, schema {}). Refusing to answer a single call: a core from \
         another tree starts, answers, and answers from the wrong schema (#1020 Artifacts). \
         Rebuild or re-download the prebuilt core for this commit.",
        identity.digest, identity.git_sha, identity.schema_version
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn released(digest: &str) -> ArtifactIdentity {
        ArtifactIdentity {
            git_sha: "a1b2c3d4".to_owned(),
            digest: digest.to_owned(),
            schema_version: 11,
        }
    }

    /// THE DEMONSTRATED RED for the identity gate: a core whose digest is not
    /// the one the shell was built against is REFUSED, and the message carries
    /// both digests.
    #[test]
    fn a_mismatched_digest_is_refused_and_both_digests_are_named() {
        let error = require_digest(&released("aaaa1111"), "bbbb2222").expect_err("must refuse");
        assert!(error.starts_with("STALE CORE REFUSED"), "{error}");
        assert!(error.contains("aaaa1111"), "{error}");
        assert!(error.contains("bbbb2222"), "{error}");
    }

    #[test]
    fn a_matching_digest_passes_quietly() {
        assert_eq!(require_digest(&released("aaaa1111"), "aaaa1111"), Ok(None));
    }

    /// An absent expectation is not a pass. This is the failure mode that would
    /// otherwise make the whole scheme decorative: a shell that forgot to record
    /// its core's digest would load anything.
    #[test]
    fn an_empty_expectation_is_refused_rather_than_treated_as_a_match() {
        for empty in ["", "   "] {
            let error = require_digest(&released("aaaa1111"), empty).expect_err("must refuse");
            assert!(error.contains("no expected digest"), "{error}");
        }
    }

    /// A development build is loadable and SAYS the check did not run.
    #[test]
    fn a_dev_build_is_allowed_loudly() {
        let warning = require_digest(&released(DEV), "aaaa1111")
            .expect("a dev core loads")
            .expect("with a warning");
        assert!(warning.contains("NOT CHECKED"), "{warning}");
        let warning = require_digest(&released("aaaa1111"), DEV)
            .expect("a dev shell loads")
            .expect("with a warning");
        assert!(warning.contains("NOT CHECKED"), "{warning}");
    }

    /// This build's own stamp is well-formed, and on a developer machine it is
    /// the `dev` marker rather than an empty string.
    #[test]
    fn this_build_carries_a_stamp() {
        let identity = ArtifactIdentity::current();
        assert!(!identity.git_sha.is_empty());
        assert!(!identity.digest.is_empty());
        assert_eq!(identity.schema_version, centraid_vault::head_version());
        let json = identity.to_json();
        for field in ["gitSha", "digest", "schemaVersion", "dev"] {
            assert!(json.contains(field), "{json}");
        }
    }
}
