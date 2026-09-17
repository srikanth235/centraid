//! ONE HASH, AND TWO MECHANICAL SWEEPS THAT KEEP IT ONE (#1025 S4,
//! D-1025-S4-1/-5).
//!
//! Reading found none of this. The defect S4 exists to close — the native-host
//! stage door computing SHA-256 over a capture and handing it to a column the
//! vault keeps UNIQUE on BLAKE3 — sat in the tree with a comment above it saying
//! the handle IS the bytes, and was true of a different hash. Both halves of
//! that failure are mechanical, so both tests here are scans:
//!
//! 1. **Every writer of a hash column goes through `content_digest`.** A site
//!    that mints its own value is how two names for one photograph get filed.
//! 2. **`sha256` appears in `crates/` only where an allowlist says why.** The
//!    allowlist is tiny and each entry carries its reason, because an allowlist
//!    without reasons is a place to hide the next one.
//!
//! Neither scan is clever, and that is the point: a clever scan is one somebody
//! silences.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn crates_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .expect("crates/ resolves")
}

fn rust_files() -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(&crates_root(), &mut found);
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

fn relative(path: &Path) -> String {
    path.strip_prefix(crates_root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

// ------------------------------------------------------ THE WRITER SWEEP ----

/// Files that write a hash column, and where each one's value comes from.
///
/// A file lands here for one of two reasons and the reason is the entry:
///
/// - it calls `content_digest` (or `centraid_media::format::content_hash_hex`,
///   which IS `content_digest` — see `crates/vault/src/backup/store.rs`); or
/// - it carries a value it did not compute, out of a row or a verified handle,
///   and the entry says which.
///
/// **Adding a file here is the reviewable act.** A new writer that hashes for
/// itself fails the scan until somebody writes down why it is allowed to, and
/// "it needed a value of the right shape" is not a why — fixtures that need one
/// use `demo_sha`, which says in its own comment that it is not a real digest.
const HASH_COLUMN_WRITERS: &[(&str, &str)] = &[
    (
        "apps/kit/src/fixtures.rs",
        "seeds a corpus: real bodies go through `text_content_hash` (blake3, the \
         vault's own) and synthetic rows through `demo_sha`, which says in its \
         own comment that it is a distinct value of the right SHAPE and not a digest",
    ),
    (
        "search/tests/door.rs",
        "a test fixture row; the value is a literal of the right shape and \
         nothing reads it as a digest",
    ),
    (
        "vault/src/backup/drill.rs",
        "the restore drill's own corpus: the ids come from `BlobStore::put`, \
         which returns `backup::store::digest`",
    ),
    (
        "vault/src/backup/restore.rs",
        "writes a row the drill then samples; the value is the store's own id",
    ),
    (
        "vault/src/commands/core.rs",
        "`mint_content_from_data_uri` and `promote_staged_blob` — `content_digest` \
         over the decoded bytes, or the staging row's own already-verified hash",
    ),
    (
        "vault/src/commands/knowledge.rs",
        "`content_digest` over the note body's text",
    ),
    (
        "vault/src/commands/media.rs",
        "`content_digest` over the derivative's bytes",
    ),
    (
        "vault/src/commands/people.rs",
        "`content_digest` over the body text",
    ),
    (
        "vault/src/commands/social.rs",
        "`content_digest` over the body text",
    ),
    (
        "vault/src/content.rs",
        "`Vault::stage_bytes`, which writes the hash bao already verified the \
         pulled bytes against — and this file DEFINES `content_digest`, so its \
         one `blake3::hash` call is the door itself",
    ),
    (
        "vault/src/page.rs",
        "its own `#[cfg(test)]` fixture, and nothing else in the file writes a \
         row: `note_body_reads_core_content_text_and_null_when_absent` seeds two \
         `core_content_item` rows so the note-body join has something to miss on. \
         Both `content_hash` values are 64-hex literals of the right SHAPE \
         (`aaaa…`, `bbbb…`) that no assertion reads as a digest — the test is \
         about `core_content_text.body_text` being NULL or not. Judged on its \
         merits rather than silenced: the scan is right that this is a writer, \
         and a fixture literal is a declared source exactly as `search/tests/door.rs` \
         is (#1029 W3-0)",
    ),
    (
        "vault/tests/common/mod.rs",
        "`content_digest` over the body the fixture wrote",
    ),
    (
        "vault/tests/docs_commands.rs",
        "`content_hash_hex` over the staged bytes, which is `content_digest`",
    ),
    (
        "vault/tests/media_commands.rs",
        "`content_digest` over the bytes the test minted",
    ),
];

/// Every file that writes a hash column is on the list, and the list has no
/// entries for files that do not.
///
/// The scan is deliberately syntactic: a string literal that is an `INSERT` or
/// an `UPDATE` and names a hash column. A writer that assembled its SQL from
/// fragments would slip past it — and `sql-confinement` already forbids that
/// shape, so the two rules cover each other.
#[test]
fn every_writer_of_a_hash_column_is_declared_with_where_its_value_comes_from() {
    let declared: BTreeSet<&str> = HASH_COLUMN_WRITERS.iter().map(|(file, _)| *file).collect();
    assert_eq!(
        declared.len(),
        HASH_COLUMN_WRITERS.len(),
        "a file is listed twice"
    );

    let mut found: BTreeSet<String> = BTreeSet::new();
    for path in rust_files() {
        let text = std::fs::read_to_string(&path).expect("a source file reads");
        if writes_a_hash_column(&text) {
            found.insert(relative(&path));
        }
    }

    let undeclared: Vec<&String> = found
        .iter()
        .filter(|file| !declared.contains(file.as_str()))
        .collect();
    assert!(
        undeclared.is_empty(),
        "these files write a hash column and are not in HASH_COLUMN_WRITERS — \
         add each with the SOURCE of its value, which must be `content_digest` \
         or a row that already went through it: {undeclared:?}"
    );

    let stale: Vec<&&str> = declared
        .iter()
        .filter(|file| !found.contains(**file))
        .collect();
    assert!(
        stale.is_empty(),
        "these files no longer write a hash column; drop them from \
         HASH_COLUMN_WRITERS rather than leaving a reason for nothing: {stale:?}"
    );
}

/// EVERY DECLARED WRITER THAT MINTS ITS OWN VALUE MINTS IT THE ONE WAY.
///
/// Two clauses, and the first is the one that would have caught the defect this
/// slice exists to close:
///
/// 1. **No declared writer names a hash that is not BLAKE3.** The native-host
///    stage door computed `Sha256` over a capture and handed it to a column the
///    vault keeps UNIQUE on BLAKE3; a scan for the FUNCTION is what makes that
///    loud instead of invisible.
/// 2. **A writer that calls `blake3` directly says so in its declaration.**
///    `content_digest` is the one door, and the two files that reach past it do
///    so because they cannot depend on `crates/vault` — `crates/apps/kit` is one
///    — which is a real constraint and therefore a written-down one.
#[test]
fn a_writer_computes_no_hash_but_the_one() {
    // Every hash primitive that is NOT this repository's. `blake3` is absent on
    // purpose: it is the answer, not a finding.
    const NOT_OURS: [&str; 5] = ["Sha256", "Sha512", "Sha1", "Md5", "Hmac<"];

    for (file, reason) in HASH_COLUMN_WRITERS {
        let text =
            std::fs::read_to_string(crates_root().join(file)).expect("a declared file reads");
        for other in NOT_OURS {
            assert!(
                !text.contains(other),
                "{file} writes a hash column and names `{other}`. One hash \
                 (#1025 S4, D-1025-S4-1). Its declared source is: {reason}"
            );
        }
        if text.contains("blake3::") {
            assert!(
                reason.contains("blake3"),
                "{file} hashes with `blake3` directly rather than through \
                 `content_digest`. That is allowed only where the crate cannot \
                 depend on `crates/vault`, and the declaration has to SAY so — \
                 this one says: {reason}"
            );
        }
    }
}

fn writes_a_hash_column(text: &str) -> bool {
    for literal in string_literals(text) {
        let upper = literal.to_ascii_uppercase();
        if !(upper.contains("INSERT INTO") || upper.contains("UPDATE ")) {
            continue;
        }
        if literal.contains("content_hash")
            || literal.contains("segment_hash")
            || literal.contains("expected_hash")
        {
            return true;
        }
    }
    false
}

/// Every double-quoted literal in a source file, escapes passed through.
///
/// Good enough on purpose: this is a sweep, and the only way to defeat it is to
/// build SQL out of fragments, which `sql-confinement` already refuses.
fn string_literals(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == '"' {
            let start = at + 1;
            let mut end = start;
            while end < bytes.len() {
                if bytes[end] == '\\' {
                    end += 2;
                    continue;
                }
                if bytes[end] == '"' {
                    break;
                }
                end += 1;
            }
            if end <= bytes.len() {
                out.push(bytes[start..end.min(bytes.len())].iter().collect());
            }
            at = end + 1;
            continue;
        }
        at += 1;
    }
    out
}

// --------------------------------------------------- THE sha256 ALLOWLIST ----

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
        let path = crates_root().join(file);
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
