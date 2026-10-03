//! The vault's side of `centraid-sealed/2`'s naming (#1080 ruling 4).
//!
//! **The database plus the words is the whole index.** A part's name derives
//! from the vault's backup key and the plaintext hash of the file it belongs
//! to, its key from the backup key and the salt in its own header, and the
//! vault already stores that hash for every content item and every
//! derivative. So the names a vault's content implies are computed, never
//! recorded: [`content_names`] is the list a phone asks `exists` about and the
//! list garbage collection keeps.
//!
//! ## THE ROOT KEY ARRIVES AS BYTES
//!
//! [`keys_from_root`] takes the 32 bytes `seed / vault'(i) / root'` derives
//! (`centraid_identity`'s `VaultKeys::root`), not that crate's type: this
//! crate does not depend on `crates/identity`, and a restore holds the key
//! before it holds a vault to ask. It is the seam the old plane's
//! `ObjectKeys::new` used, kept.

use std::collections::BTreeSet;

pub use centraid_media::sealed::{
    BackupKeys, Digest, Name, PART_BYTES, PlaintextHash, name, names_of, part_count,
};

use super::{Result, invariant};
use crate::file::Vault;

/// The vault's backup keys, from its root key.
#[must_use]
pub fn keys_from_root(root_key: &[u8; 32]) -> BackupKeys {
    BackupKeys::from_root(root_key)
}

/// Every file the vault knows by hash, with its length: each content item, and
/// each derivative that has bytes of its own (a thumbnail, a preview, a
/// poster). Trashed rows are included — their bytes are restorable until the
/// row is purged.
///
/// # Errors
/// [`super::PlaneError`] when the vault will not read, or when a row holds a
/// hash that is not 64 lowercase hex characters: garbage collection must
/// account for every file, so a row it cannot name stops it.
pub fn content_hashes(vault: &Vault) -> Result<Vec<(PlaintextHash, u64)>> {
    let rows: Vec<(String, i64)> = vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT content_hash, byte_size FROM core_content_item
             UNION
             SELECT content_hash, byte_size FROM core_content_derivative
              WHERE content_hash IS NOT NULL
             ORDER BY 1",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    rows.into_iter()
        .map(|(hash, size)| {
            let h = PlaintextHash::from_hex(&hash)
                .map_err(|_| invariant(format!("a content row's hash `{hash}` cannot be named")))?;
            let len = u64::try_from(size)
                .map_err(|_| invariant(format!("content `{hash}` has a negative size")))?;
            Ok((h, len))
        })
        .collect()
}

/// Every name the vault's content implies: [`names_of`] for each of
/// [`content_hashes`].
///
/// # Errors
/// Whatever [`content_hashes`] refuses.
pub fn content_names(keys: &BackupKeys, vault: &Vault) -> Result<BTreeSet<Name>> {
    Ok(content_hashes(vault)?
        .iter()
        .flat_map(|(h, len)| names_of(keys, h, *len))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Principal;
    use crate::commands::{Command, CommandStatus, Registry};

    /// The names come from the rows the command plane wrote, hashed the one
    /// way (`content::content_digest`), not from anything this plane recorded.
    #[test]
    fn a_notes_body_implies_its_names_and_nothing_records_them() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        let registry = Registry::with_system_commands().expect("a registry");
        registry.install(&vault).expect("installs");
        let body = "Milk, bread and the backup plane.";
        let outcome = vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new(
                    "knowledge.create_note",
                    serde_json::json!({ "title": "List", "body_text": body, "format": "plain" }),
                ),
            )
            .expect("answers");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );

        let h = PlaintextHash::of(body.as_bytes());
        assert_eq!(
            content_hashes(&vault).expect("reads"),
            vec![(h, body.len() as u64)]
        );
        let keys = keys_from_root(&[9; 32]);
        assert_eq!(
            content_names(&keys, &vault).expect("names"),
            BTreeSet::from([name(&keys, &h, 0)])
        );
    }
}
