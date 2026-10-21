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
//! before it holds a vault to ask.

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

/// Every file the vault knows by hash, with its length: each `blob` row, which
/// is every original and every derivative that has bytes of its own (a
/// thumbnail, a preview, a poster). A trashed document's bytes are included
/// until its purge, because trash keeps its reference alive; a purged one's
/// blob row is collected, and so is its name.
///
/// # Errors
/// [`super::PlaneError`] when the vault will not read, or when a row holds a
/// hash that is not 64 lowercase hex characters: garbage collection must
/// account for every file, so a row it cannot name stops it.
pub fn content_hashes(vault: &Vault) -> Result<Vec<(PlaintextHash, u64)>> {
    // A blob row IS the vault's claim on bytes: the originals, and the bytes of
    // every derivative (`derivative.out` is a foreign key into `blob`), and
    // nothing else holds a hash.
    let rows: Vec<(String, i64)> = vault.read(|connection| {
        let mut statement = connection.prepare("SELECT hash, size FROM blob ORDER BY hash")?;
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

    /// The names come from the blob rows, hashed the one way
    /// (`blob::content_digest`), not from anything this plane recorded.
    #[test]
    fn a_blobs_bytes_imply_its_names_and_nothing_records_them() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        let body = "Milk, bread and the backup plane.";
        vault
            .stage_bytes(&[crate::blob::NeededBytes {
                hash: crate::blob::content_digest(body.as_bytes()),
                byte_size: body.len() as i64,
            }])
            .expect("stages");

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
