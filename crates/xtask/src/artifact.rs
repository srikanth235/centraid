//! `cargo xtask artifact-key` — the prebuilt core's cache key (#1020, D-1020-G2).
//!
//! ## What problem a key solves
//!
//! #1020 ships a **prebuilt core**: every shell — mobile, desktop, extension —
//! links a binary artifact somebody else built, rather than compiling Rust. That
//! only works if two questions have crisp answers: *is the artifact in the cache
//! the one this tree would produce?* and *is the artifact a shell just loaded the
//! one this tree produced?* The first is this key. The second is the identity
//! stamp (`crates/centraid/src/identity.rs`), and they are deliberately
//! different mechanisms: a cache key is computed from SOURCES before a build, an
//! identity stamp is baked INTO the artifact during one.
//!
//! ## THE EXACT RULE, because a fuzzy cache key is a stale artifact
//!
//! The key is `sha256` over, in this order:
//!
//! 1. every file under `crates/` (path and bytes), excluding `target/`;
//! 2. every file under `contracts/`, **excluding `contracts/ledgers/`**;
//! 3. `rust-toolchain.toml`'s `channel`;
//! 4. the target triple, the feature list and the cargo profile;
//! 5. the **resolved dependency graph** — the `name`, `version` and `checksum`
//!    of every `[[package]]` in `Cargo.lock`, sorted, and nothing else from that
//!    file.
//!
//! Two consequences follow from (5), and both are the rule rather than an
//! accident:
//!
//! * A `Cargo.lock` edit that does not change any package's name, version or
//!   checksum — a reordering, a comment, a `dependencies` list rewritten by a
//!   different cargo version — **does not move the key**. The artifact it
//!   describes is byte-for-byte the same one.
//! * A `Cargo.lock` edit that bumps a version or a checksum **does** move it,
//!   because that is a different graph and therefore a different artifact.
//!
//! And from (2): a LEDGER is evidence *about* an artifact, not an input to it.
//! If `contracts/ledgers/library-size.json` were hashed, then writing down the
//! size of the artifact just built would invalidate that artifact — every
//! measurement would re-key the thing it measured, and the cache would never hit
//! twice in a row.
//!
//! What is NOT in the key is as load-bearing: nothing from the environment (no
//! `HOSTNAME`, no timestamp, no `CI` flag), and no path outside the repository.
//! A key that moved because a build ran on a different runner is a cache that
//! never hits.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Directories under `crates/` and `contracts/` that are build output or
/// tooling state, never inputs.
const SKIP_DIRS: [&str; 5] = ["target", "node_modules", ".git", "build", ".turbo"];

/// Everything that identifies one artifact.
pub struct KeyInputs {
    pub triple: String,
    pub features: Vec<String>,
    pub profile: String,
}

/// Compute the key. Returns the hex digest and a human-readable breakdown, so a
/// `--explain` run can show WHICH of the five inputs moved.
pub fn key(root: &Path, inputs: &KeyInputs) -> Result<(String, Vec<(String, String)>)> {
    let sources = tree_digest(&root.join("crates"), root, &[])?;
    let contracts = tree_digest(
        &root.join("contracts"),
        root,
        &[Path::new("contracts/ledgers")],
    )?;
    let toolchain = toolchain_channel(root)?;
    let graph = resolved_graph_digest(root)?;
    let build = format!(
        "triple={}\nfeatures={}\nprofile={}\n",
        inputs.triple,
        inputs.features.join(","),
        inputs.profile
    );

    let parts = vec![
        ("crates".to_owned(), sources),
        ("contracts".to_owned(), contracts),
        (
            "toolchain".to_owned(),
            hex(&Sha256::digest(toolchain.as_bytes())),
        ),
        ("graph".to_owned(), graph),
        ("build".to_owned(), hex(&Sha256::digest(build.as_bytes()))),
    ];

    let mut hasher = Sha256::new();
    for (name, digest) in &parts {
        hasher.update(name.as_bytes());
        hasher.update(b"\0");
        hasher.update(digest.as_bytes());
        hasher.update(b"\n");
    }
    Ok((hex(&hasher.finalize()), parts))
}

/// `cargo xtask artifact-key` printed for a human and for a workflow: the key on
/// the first line so `$(cargo xtask artifact-key --triple …)` is usable, the
/// breakdown on stderr.
pub fn run(root: &Path, inputs: &KeyInputs, explain: bool) -> Result<()> {
    let (digest, parts) = key(root, inputs)?;
    if explain {
        for (name, part) in &parts {
            eprintln!("  {name:<10} {}", &part[..16]);
        }
    }
    println!("{digest}");
    Ok(())
}

/// A digest over every file in a tree: the repository-relative path, a NUL, the
/// length, and the bytes. The path is in the hash because moving a file is a
/// change, and the length is in it because a concatenation of two files must not
/// collide with a concatenation of two different ones.
fn tree_digest(dir: &Path, root: &Path, excluded: &[&Path]) -> Result<String> {
    let mut files = Vec::new();
    collect(dir, root, excluded, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for path in files {
        let absolute = root.join(&path);
        let bytes = fs::read(&absolute).with_context(|| format!("read {}", path.display()))?;
        hasher.update(path.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update(b"\0");
        hasher.update(bytes.len().to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(hex(&hasher.finalize()))
}

fn collect(dir: &Path, root: &Path, excluded: &[&Path], out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let relative = dir.strip_prefix(root).unwrap_or(dir);
    if excluded.contains(&relative) {
        return Ok(());
    }
    for entry in fs::read_dir(dir)
        .with_context(|| format!("read {}", dir.display()))?
        .flatten()
    {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect(&path, root, excluded, out)?;
        } else if path.is_file() {
            out.push(path.strip_prefix(root).unwrap_or(&path).to_path_buf());
        }
    }
    Ok(())
}

fn toolchain_channel(root: &Path) -> Result<String> {
    let text = fs::read_to_string(root.join("rust-toolchain.toml"))
        .context("read rust-toolchain.toml — the one version file")?;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("channel") {
            let value = rest.trim_start_matches(['=', ' ', '\t']).trim();
            return Ok(value.trim_matches('"').to_owned());
        }
    }
    anyhow::bail!("rust-toolchain.toml states no [toolchain] channel")
}

/// The resolved graph, and nothing else, out of `Cargo.lock`.
///
/// Parsed by hand rather than with a TOML crate because the shape needed is
/// three scalar fields of a repeated table, and `crates/xtask` is on the
/// edit-run loop (see the dependency note in its `Cargo.toml`). A path
/// dependency inside this workspace carries no `checksum`; its bytes are already
/// in the `crates` digest, so the absence is correct rather than tolerated.
fn resolved_graph_digest(root: &Path) -> Result<String> {
    let text = fs::read_to_string(root.join("Cargo.lock")).context("read Cargo.lock")?;
    let mut packages: BTreeMap<String, String> = BTreeMap::new();
    let mut name = String::new();
    let mut version = String::new();
    let mut checksum = String::new();
    let mut in_package = false;
    let flush =
        |packages: &mut BTreeMap<String, String>, name: &str, version: &str, checksum: &str| {
            if !name.is_empty() {
                packages.insert(format!("{name} {version}"), checksum.to_owned());
            }
        };
    for line in text.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            flush(&mut packages, &name, &version, &checksum);
            name.clear();
            version.clear();
            checksum.clear();
            in_package = true;
            continue;
        }
        if line.starts_with('[') {
            flush(&mut packages, &name, &version, &checksum);
            name.clear();
            version.clear();
            checksum.clear();
            in_package = false;
            continue;
        }
        if !in_package {
            continue;
        }
        for (field, slot) in [
            ("name", &mut name),
            ("version", &mut version),
            ("checksum", &mut checksum),
        ] {
            if let Some(rest) = line.strip_prefix(field)
                && rest.trim_start().starts_with('=')
            {
                *slot = rest
                    .trim_start()
                    .trim_start_matches('=')
                    .trim()
                    .trim_matches('"')
                    .to_owned();
            }
        }
    }
    flush(&mut packages, &name, &version, &checksum);

    let mut hasher = Sha256::new();
    for (id, sum) in &packages {
        hasher.update(id.as_bytes());
        hasher.update(b" ");
        hasher.update(sum.as_bytes());
        hasher.update(b"\n");
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> KeyInputs {
        KeyInputs {
            triple: "x86_64-unknown-linux-gnu".to_owned(),
            features: Vec::new(),
            profile: "release".to_owned(),
        }
    }

    /// A throwaway tree, so the assertions below are about the rule and not
    /// about whatever this repository happens to contain today.
    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("a scratch tree");
        let root = dir.path();
        fs::create_dir_all(root.join("crates/core/src")).unwrap();
        fs::create_dir_all(root.join("contracts/schema")).unwrap();
        fs::create_dir_all(root.join("contracts/ledgers")).unwrap();
        fs::write(root.join("crates/core/src/lib.rs"), "pub fn a() {}\n").unwrap();
        fs::write(
            root.join("contracts/schema/vault-ddl.sql"),
            "CREATE TABLE a(b);\n",
        )
        .unwrap();
        fs::write(
            root.join("contracts/ledgers/library-size.json"),
            "{\"abis\":{}}\n",
        )
        .unwrap();
        fs::write(
            root.join("rust-toolchain.toml"),
            "[toolchain]\nchannel = \"1.94.1\"\n",
        )
        .unwrap();
        fs::write(
            root.join("Cargo.lock"),
            "version = 4\n\n[[package]]\nname = \"anyhow\"\nversion = \"1.0.100\"\nchecksum = \"aaaa\"\n\n[[package]]\nname = \"centraid\"\nversion = \"1.0.0\"\ndependencies = [\n \"anyhow\",\n]\n",
        )
        .unwrap();
        dir
    }

    fn key_of(root: &Path) -> String {
        key(root, &inputs()).expect("a key").0
    }

    #[test]
    fn the_key_is_stable_for_an_unchanged_tree() {
        let dir = tree();
        assert_eq!(key_of(dir.path()), key_of(dir.path()));
    }

    /// ONE BYTE in `contracts/` moves the key. This is the case the whole
    /// mechanism exists for: a shell links an artifact built against a contract,
    /// so a changed contract must never hit the cache.
    #[test]
    fn one_byte_in_contracts_moves_the_key() {
        let dir = tree();
        let before = key_of(dir.path());
        fs::write(
            dir.path().join("contracts/schema/vault-ddl.sql"),
            "CREATE TABLE a(c);\n",
        )
        .unwrap();
        assert_ne!(before, key_of(dir.path()));
    }

    #[test]
    fn one_byte_in_crates_moves_the_key() {
        let dir = tree();
        let before = key_of(dir.path());
        fs::write(dir.path().join("crates/core/src/lib.rs"), "pub fn b() {}\n").unwrap();
        assert_ne!(before, key_of(dir.path()));
    }

    /// A LEDGER IS NOT AN INPUT. Writing a measurement about the artifact must
    /// not invalidate the artifact it measured.
    #[test]
    fn a_ledger_write_does_not_move_the_key() {
        let dir = tree();
        let before = key_of(dir.path());
        fs::write(
            dir.path().join("contracts/ledgers/library-size.json"),
            "{\"abis\":{\"x86_64-unknown-linux-gnu\":{\"strippedBytes\":1234}}}\n",
        )
        .unwrap();
        assert_eq!(before, key_of(dir.path()));
    }

    /// THE `Cargo.lock` RULE, both halves.
    #[test]
    fn a_cargo_lock_change_moves_the_key_only_when_the_resolved_graph_changes() {
        let dir = tree();
        let lock = dir.path().join("Cargo.lock");
        let before = key_of(dir.path());

        // Cosmetic: a reordered `dependencies` list and a comment. Same graph.
        fs::write(
            &lock,
            "# regenerated by a different cargo\nversion = 4\n\n[[package]]\nname = \"centraid\"\nversion = \"1.0.0\"\ndependencies = [\n \"anyhow\",\n]\n\n[[package]]\nname = \"anyhow\"\nversion = \"1.0.100\"\nchecksum = \"aaaa\"\n",
        )
        .unwrap();
        assert_eq!(
            before,
            key_of(dir.path()),
            "a Cargo.lock edit that changes no name, version or checksum must not re-key"
        );

        // A version bump. Different graph, different artifact.
        fs::write(
            &lock,
            "version = 4\n\n[[package]]\nname = \"anyhow\"\nversion = \"1.0.101\"\nchecksum = \"aaaa\"\n\n[[package]]\nname = \"centraid\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
        assert_ne!(before, key_of(dir.path()));

        // A checksum change at the same version — a yanked-and-republished
        // crate, the case a version-only rule would miss entirely.
        fs::write(
            &lock,
            "version = 4\n\n[[package]]\nname = \"anyhow\"\nversion = \"1.0.100\"\nchecksum = \"bbbb\"\n\n[[package]]\nname = \"centraid\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
        assert_ne!(before, key_of(dir.path()));
    }

    #[test]
    fn the_triple_the_features_the_profile_and_the_toolchain_are_all_in_the_key() {
        let dir = tree();
        let base = key_of(dir.path());
        for other in [
            KeyInputs {
                triple: "aarch64-apple-darwin".to_owned(),
                ..inputs()
            },
            KeyInputs {
                features: vec!["blob-door".to_owned()],
                ..inputs()
            },
            KeyInputs {
                profile: "dev".to_owned(),
                ..inputs()
            },
        ] {
            assert_ne!(base, key(dir.path(), &other).expect("a key").0);
        }
        fs::write(
            dir.path().join("rust-toolchain.toml"),
            "[toolchain]\nchannel = \"1.95.0\"\n",
        )
        .unwrap();
        assert_ne!(base, key_of(dir.path()));
    }

    /// NOTHING OUTSIDE THE REPOSITORY. Two identical trees at two different
    /// absolute paths key the same, which is the property that makes the cache
    /// hit between a developer's checkout and a CI runner's — and a key that
    /// hashed absolute paths, a hostname or a timestamp would be a cache that
    /// never hits.
    #[test]
    fn two_identical_trees_at_different_paths_key_the_same() {
        let one = tree();
        let two = tree();
        assert_ne!(one.path(), two.path());
        assert_eq!(key_of(one.path()), key_of(two.path()));
    }
}
