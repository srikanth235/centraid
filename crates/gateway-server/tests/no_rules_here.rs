//! NO RULE IS REIMPLEMENTED IN THIS ADAPTER, AS A SCAN (#1029 §3).
//!
//! The architecture's whole point is that `crates/gateway-core` holds every
//! rule once and an adapter reaches them: an adapter that carries half a rule
//! is an adapter that drifts from the conformance suite, on a phone somebody is
//! restoring. That is stated in this crate's README and in its `lib.rs`, and a
//! statement is not a check.
//!
//! **A claim names its grep, and this file is the grep.** It scans this crate's
//! sources for the shapes a reimplemented rule takes:
//!
//! 1. **A second copy of a rule's numbers.** The 16 MiB object cap, the 50%
//!    shrink threshold, the retention floor's 7/4/6 and the one-per-day delete
//!    window are `gateway-core`'s. An adapter that restated one would drift from
//!    it silently, because both would still compile.
//! 2. **A hash function decision.** An object's name is BLAKE3 and the store's
//!    attested checksum is SHA-256, and the second of those is confined to one
//!    module with an allowlist entry that says why.
//!
//! What it cannot catch is a rule reimplemented in different words, and that is
//! the conformance suite's job — this catches the easy half loudly so the hard
//! half is the only thing review has to look for.

use std::path::{Path, PathBuf};

fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn sources() -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![source_root()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory)
            .expect("the source tree reads")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }
    found.sort();
    assert!(
        found.len() >= 10,
        "only {} source files were scanned, which is not this crate",
        found.len()
    );
    found
}

fn relative(path: &Path) -> String {
    path.strip_prefix(source_root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Scan every non-comment line, calling `judge` with the file, the line number
/// and the line.
fn scan(mut judge: impl FnMut(&str, usize, &str)) {
    for path in sources() {
        let text = std::fs::read_to_string(&path).expect("a source file reads");
        let file = relative(&path);
        for (number, line) in text.lines().enumerate() {
            // A comment that NAMES one of these is explaining why it is absent,
            // which is the opposite of a finding — and most of them do.
            if line.trim_start().starts_with("//") {
                continue;
            }
            judge(&file, number + 1, line);
        }
    }
}

/// A RULE'S NUMBER LIVES ONCE.
///
/// Each of these is a constant in `centraid-gateway-core`. An adapter that
/// restated one would compile, pass its own tests, and quietly keep a different
/// backup from the other adapter the day somebody tuned it there.
#[test]
fn no_rule_of_the_protocol_is_restated_with_a_literal_here() {
    // `(the literal, what it would be a second copy of)`.
    const RULES: [(&str, &str); 5] = [
        (
            "16 * 1024 * 1024",
            "the object cap — `centraid_gateway_core::upload::MAX_OBJECT_BYTES` (F6)",
        ),
        (
            "shrink_percent",
            "the size guard's threshold — `retention::Policy` (F4)",
        ),
        (
            "daily_for_days",
            "the retention floor — `retention::Policy` (F10)",
        ),
        (
            "base_delete_window",
            "the delete rate limit — `retention::Policy` (F4)",
        ),
        (
            "DEFAULT_REPLAY_WINDOW",
            "the replay window — `auth::DEFAULT_REPLAY_WINDOW`",
        ),
    ];
    let mut findings = Vec::new();
    scan(|file, number, line| {
        for (literal, rule) in RULES {
            // Naming the constant through its own module is reaching for the
            // rule, which is the point. Assigning to it here would be a second
            // copy of it.
            let restated = line.contains(literal)
                && !line.contains("centraid_gateway_core")
                && !line.contains("gateway_core::")
                && !line.contains("auth::");
            if restated {
                findings.push(format!("{file}:{number}: `{literal}` — {rule}"));
            }
        }
    });
    assert!(
        findings.is_empty(),
        "these lines restate a rule's own number. Reach for the constant in \
         `centraid-gateway-core` instead; a second copy is a rule that drifts \
         the first time somebody tunes one of them:\n{}",
        findings.join("\n")
    );
}

/// ONE HASH, AND ONE EXCEPTION THAT IS SOMEBODY ELSE'S PROTOCOL.
///
/// `crates/vault/tests/one_hash.rs` already enforces this over the whole
/// workspace with an allowlist. This is the same claim stated locally and in
/// the terms this crate's reader cares about: the boundary is **one file**, and
/// a second one appearing is the thing to notice.
#[test]
fn the_stores_own_checksum_is_named_in_exactly_one_module() {
    let mut naming = Vec::new();
    for path in sources() {
        let text = std::fs::read_to_string(&path)
            .expect("a source file reads")
            .to_ascii_lowercase()
            .replace('-', "");
        if text.contains("sha256") {
            naming.push(relative(&path));
        }
    }
    assert_eq!(
        naming,
        vec!["bytes/sigv4.rs".to_owned()],
        "an object's NAME is BLAKE3 everywhere and the store's attested \
         checksum is SHA-256 in one module with an allowlist entry that says \
         why (#1025 S4, D-1025-S4-5). A second module naming it is a boundary \
         that has started moving"
    );
}

/// THE RULES ARE REACHED, NOT REPLACED.
///
/// The positive half of the same claim: this adapter actually calls
/// `gateway-core`. A scan for what must be absent is satisfied by a crate that
/// does nothing at all, and without this the three tests above would pass
/// against an empty `src/`.
#[test]
fn the_adapter_reaches_the_rules_it_does_not_restate() {
    let mut reaches = std::collections::BTreeSet::new();
    scan(|_, _, line| {
        for reached in [
            // The compare-and-set rule, applied under BEGIN IMMEDIATE (F7).
            "commit::compare_and_set",
            // The blind scrub's verdict.
            "scrub::examine",
            // The request signature, assembled once for both adapters.
            "auth::verify_request",
            // The version window, in both directions.
            "version::admit",
        ] {
            if line.contains(reached) {
                reaches.insert(reached.to_owned());
            }
        }
    });
    assert_eq!(
        reaches.len(),
        4,
        "this adapter should reach every one of these rules rather than \
         reimplementing it; it reaches {reaches:?}"
    );
}
