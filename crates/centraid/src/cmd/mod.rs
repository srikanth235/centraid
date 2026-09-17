//! The verbs this binary still has: `doctor`, `gateway install`, and the unit
//! writer behind it (#1020, D-1020-G1).
//!
//! ## `backup now`, `recover` and `export` ARE GONE (#1029 §5, Reference A)
//!
//! All three were **gateway** commands, and Reference A's deletion inventory
//! deletes them as such: "`crates/centraid/src/cmd`: delete […]
//! `backup.rs`/`capture.rs`/`recover.rs` as gateway commands". `capture.rs` went
//! with W2; these went with the two things they were built on.
//!
//! - `recover --kit` and `export --password-file` both turned on the
//!   **recovery-kit file**, and §5 deletes it: "`backup::kit` (the
//!   scrypt-wrapped kit file) is deleted. The written 24-word phrase replaces
//!   it." There is nothing left for a kit to carry that the member does not
//!   already hold, and a file that carries keys is a file that can be copied.
//! - `backup now` drove `Keyring`'s two master keys, which B11 collapses to the
//!   one root key §0 derives.
//!
//! What replaces them is not another CLI verb. §1 makes **the phone the vault**:
//! capture, the spool and the checkpoint run inside the core under the write
//! mutex (`centraid_vault::backup::capture`), and the restore a member performs
//! is onto a new phone from the 24 words, which is W5's. The drill that proves
//! the whole chain moved with the code, to
//! `crates/vault/tests/restore_drill.rs`.
//!
//! ## Facts to stderr, JSON to stdout
//!
//! An operator watching a command reads stderr; a script reads stdout and gets
//! one JSON document and nothing else. A progress line on stdout would make the
//! report unparseable exactly when it matters.

pub mod doctor;
pub mod gateway_install;
pub mod units;

use std::path::{Path, PathBuf};

/// Where a vault file lives inside a data directory.
///
/// One layout, stated once: `<data-dir>/vault/<vaultId>/vault.db`.
///
/// `keys_dir_in`, `blobs_dir_in` and `parse_iso_ms` stood here and are deleted
/// with their only consumers (#1029 §5): the first two were read by `backup
/// now` and `export`, and `parse_iso_ms` existed for `recover --at`. A
/// point-in-time restore is now "pick a base and a txid" (F10) rather than a
/// wall-clock instant, and nothing in this binary parses a date any more.
pub fn vault_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("vault")
}

/// The one vault file under a data directory, or a message saying why not.
///
/// A data directory with two vaults is refused rather than guessed at: picking
/// one would be picking which of the owner's vaults to restore over.
pub fn sole_vault_file(data_dir: &Path) -> Result<PathBuf, String> {
    let root = vault_dir_in(data_dir);
    let entries = std::fs::read_dir(&root)
        .map_err(|error| format!("no vault directory at {}: {error}", root.display()))?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let candidate = entry.path().join("vault.db");
        if candidate.is_file() {
            found.push(candidate);
        }
    }
    found.sort();
    match found.len() {
        0 => Err(format!("no vault under {}", root.display())),
        1 => Ok(found.remove(0)),
        _ => Err(format!(
            "{} holds {} vaults — name one with --vault",
            root.display(),
            found.len()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_directory_layout_is_stated_once() {
        let root = Path::new("/srv/centraid");
        assert_eq!(vault_dir_in(root), Path::new("/srv/centraid/vault"));
    }

    #[test]
    fn a_data_directory_with_two_vaults_is_refused_rather_than_guessed_at() {
        let dir = tempfile::tempdir().unwrap();
        assert!(sole_vault_file(dir.path()).is_err());
        for id in ["v1", "v2"] {
            let vault = vault_dir_in(dir.path()).join(id);
            std::fs::create_dir_all(&vault).unwrap();
            std::fs::write(vault.join("vault.db"), b"").unwrap();
        }
        let error = sole_vault_file(dir.path()).unwrap_err();
        assert!(error.contains("holds 2 vaults"), "{error}");
        std::fs::remove_dir_all(vault_dir_in(dir.path()).join("v2")).unwrap();
        assert!(
            sole_vault_file(dir.path())
                .unwrap()
                .ends_with("v1/vault.db")
        );
    }
}
