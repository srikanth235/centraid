//! ONE HASH: `sha256` appears in the Rust tree only where an allowlist says why
//! (#1025 S4, D-1025-S4-1/-5).
//!
//! The defect S4 closed was the native-host stage door computing SHA-256 over a
//! capture and handing it to a column the vault keeps UNIQUE on BLAKE3. Its
//! other half, *every writer of a hash column goes through `content_digest`*, is
//! now the schema's: every column that holds a hash is a foreign key into
//! `blob(hash)` (`tests/commitments.rs`), whose CHECK refuses anything but 64
//! lowercase hex, so a writer cannot file a second name for one photograph
//! without the engine refusing it.
//!
//! The allowlist is tiny and each entry carries its reason, because an
//! allowlist without reasons is a place to hide the next one. The scan is not
//! clever, and that is the point: a clever scan is one somebody silences.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root resolves")
}

fn crates_root() -> PathBuf {
    repository_root().join("crates")
}

/// Every root of Rust source this repository ships.
///
/// One root, `crates/`, since the hosted adapter left (#1029, scope amendment
/// 2026-09-21). A file under it is named in the allowlist by its path from the
/// repository root.
fn source_roots() -> Vec<PathBuf> {
    vec![crates_root()]
}

fn rust_files() -> Vec<PathBuf> {
    let mut found = Vec::new();
    for root in source_roots() {
        walk(&root, &mut found);
    }
    found.sort();
    assert!(found.len() > 200, "only {} files were scanned", found.len());
    found
}

fn walk(dir: &Path, into: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // `target/` is build output and is not source anybody wrote.
            if path.file_name().is_some_and(|name| name == "target") {
                continue;
            }
            walk(&path, into);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            into.push(path);
        }
    }
}

/// A file's name as the allowlist spells it.
///
/// Under `crates/` the prefix is stripped, which is what every existing entry
/// was written against; anywhere else — `gateway/`, today — the path is relative
/// to the repository root, so the two roots cannot collide on a name.
fn relative(path: &Path) -> String {
    path.strip_prefix(crates_root())
        .or_else(|_| path.strip_prefix(repository_root()))
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

// ------------------------------------------------------ THE WRITER SWEEP ----

/// Where `sha256` may still appear under `crates/`, and why.
///
/// Three crates and one reason wearing three coats — "somebody else's
/// protocol", in each case a protocol whose hash is fixed by its own
/// specification and cannot be restated in BLAKE3 without ceasing to be that
/// protocol:
const SHA256_ALLOWED: &[(&str, &str)] = &[
    (
        "identity/src/sealed_box.rs",
        "RFC 9180 `mode_base` with `kdf_id = 0x0001`, which IS HKDF-SHA256. The \
         ciphersuite is the interoperability contract a non-Centraid peer \
         implements, and `crates/identity` also carries BIP39's PBKDF2-HMAC-SHA512 \
         and SLIP-0010's HMAC-SHA512 for the same reason (W0.5-R1). \
         `crates/identity/src/lib.rs` carries the full reasoning and, critically, \
         the BOUNDARY: the carve-out is that crate's alone. Everything this \
         repository defines for itself — every object name, commitment and \
         dictionary id, `crates/media` included — stays BLAKE3",
    ),
    (
        "identity/tests/rfc9180.rs",
        "opens RFC 9180 Appendix A.1's own ciphertexts with A.1's own key, so it \
         must name A.1's ciphersuite. A vector we generated proves only that we \
         agree with ourselves; the RFC's bytes are the point of the file (W0.5-R1)",
    ),
    (
        "xtask/src/artifact.rs",
        "`cargo xtask artifact-key` hashes the tree into a GitHub Actions cache \
         key. It names nothing inside a vault and GitHub's cache is not ours",
    ),
    (
        "xtask/src/ci.rs",
        "reads Subresource Integrity markers (`sha512-`, `sha256-`) out of \
         `bun.lock`. SRI's spelling is the W3C's",
    ),
];

/// `sha256` survives in exactly the places that wrote down why.
///
/// The scan matches case-insensitively and takes `SHA-256` and `SHA256` too, so
/// prose cannot re-introduce the ambiguity the rename removed. A file that
/// EXPLAINS the supersession is allowed to name the old function — the marker is
/// `#1025 S4` or `D-1025-S4`, which is a citation a reader can follow, not a
/// silencer.
#[test]
fn sha256_appears_only_where_an_allowlist_says_why() {
    let allowed: BTreeSet<&str> = SHA256_ALLOWED.iter().map(|(file, _)| *file).collect();
    let mut findings: Vec<String> = Vec::new();

    for path in rust_files() {
        let file = relative(&path);
        if allowed.contains(file.as_str()) {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("a source file reads");
        for (number, line) in text.lines().enumerate() {
            let lowered = line.to_ascii_lowercase().replace('-', "");
            if !lowered.contains("sha256") {
                continue;
            }
            // A line that CITES the ruling is explaining the move, not making
            // it. So is a whole file that does: the explanations run to several
            // lines and a per-line marker would be noise.
            if line.contains("#1025 S4")
                || line.contains("D-1025-S4")
                || text.contains("#1025 S4")
                || text.contains("D-1025-S4")
            {
                continue;
            }
            findings.push(format!("{file}:{}: {}", number + 1, line.trim()));
        }
    }

    assert!(
        findings.is_empty(),
        "ONE HASH (#1025 S4, D-1025-S4-5). These lines name SHA-256 outside the \
         allowlist and without citing the ruling that superseded it. Move the \
         site to BLAKE3, or — if it is genuinely somebody else's protocol — add \
         the file to SHA256_ALLOWED with the reason:\n{}",
        findings.join("\n")
    );
}

/// The allowlist names files that exist and that still mention SHA-256.
///
/// An allowlist entry for a file that stopped needing one is an exemption
/// nobody is looking at.
#[test]
fn every_allowlisted_file_still_needs_its_exemption() {
    for (file, reason) in SHA256_ALLOWED {
        // A `gateway/…` entry is relative to the repository root; everything
        // else is relative to `crates/`. See `relative`.
        let path = if file.starts_with("gateway/") {
            repository_root().join(file)
        } else {
            crates_root().join(file)
        };
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{file} is allowlisted and unreadable: {error}"));
        assert!(
            text.to_ascii_lowercase()
                .replace('-', "")
                .contains("sha256"),
            "{file} no longer names SHA-256; drop its allowlist entry ({reason})"
        );
    }
}
