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

/// One claim on content, as numbered when the vault made it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    /// `blob.seq`: assigned at insert, ever rising, never given again to another claim.
    pub seq: i64,
    pub hash: PlaintextHash,
    pub len: u64,
}

/// **The claims made after sequence `after`, in order, at most `limit`**: the keyset read a
/// per-gateway cursor walks ("what did the vault claim since I last looked?"). `after` is the
/// `seq` of the last claim the reader saw (0 to start); the page's last `seq` is the next `after`.
/// It seeks `blob`'s integer key and reads `limit` rows, whatever the library's size.
///
/// A claim that was collected leaves a gap in the numbers, never a number taken again, so a
/// reader's cursor stays right across collections.
///
/// # Errors
/// [`super::PlaneError`] when the vault will not read, or a row holds a hash that cannot be named.
pub fn claims_after(vault: &Vault, after: i64, limit: usize) -> Result<Vec<Claim>> {
    let rows: Vec<(i64, String, i64)> = vault.read(|connection| {
        let mut statement = connection.prepare_cached(CLAIMS_AFTER)?;
        let rows = statement.query_map(
            rusqlite::params![after, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    rows.into_iter()
        .map(|(seq, hash, size)| {
            let h = PlaintextHash::from_hex(&hash)
                .map_err(|_| invariant(format!("a content row's hash `{hash}` cannot be named")))?;
            let len = u64::try_from(size)
                .map_err(|_| invariant(format!("content `{hash}` has a negative size")))?;
            Ok(Claim { seq, hash: h, len })
        })
        .collect()
}

/// The statement [`claims_after`] runs, public so a plan test reads the plan of the statement
/// that runs and not a copy of it.
pub const CLAIMS_AFTER: &str =
    "SELECT seq, hash, size FROM blob WHERE seq > ?1 ORDER BY seq LIMIT ?2";

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

    fn claim(vault: &Vault, byte: u8) -> String {
        let hash = format!("{byte:02x}").repeat(32);
        vault
            .commit(|tx| {
                tx.connection()
                    .execute("INSERT INTO blob (hash, size) VALUES (?1, 1)", [&hash])?;
                Ok(())
            })
            .expect("a claim");
        hash
    }

    fn new_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        (dir, vault)
    }

    /// The reader walks the claims in pages by the last number it saw, sees each once and in
    /// order, and a collected claim's number is never given to a later one.
    #[test]
    fn claims_are_walked_in_pages_and_a_number_is_never_reused() {
        let (_dir, vault) = new_vault();
        let hashes: Vec<String> = (1..=7).map(|byte| claim(&vault, byte)).collect();
        let mut seen = Vec::new();
        let mut after = 0;
        let mut pages = 0;
        loop {
            let page = claims_after(&vault, after, 3).expect("a page");
            if page.is_empty() {
                break;
            }
            assert!(page.len() <= 3, "a page is at most the limit");
            pages += 1;
            after = page.last().map_or(after, |claim| claim.seq);
            seen.extend(page);
        }
        assert_eq!(pages, 3, "seven claims in pages of three");
        assert_eq!(
            seen.iter()
                .map(|claim| claim.hash.to_hex())
                .collect::<Vec<_>>(),
            hashes
        );
        assert!(seen.windows(2).all(|pair| pair[0].seq < pair[1].seq));
        // The newest claim is collected; the next claim is numbered above it, not in its place.
        let last = seen.last().expect("a claim").seq;
        vault
            .commit(|tx| {
                tx.connection()
                    .execute("DELETE FROM blob WHERE hash = ?1", [&hashes[6]])?;
                Ok(())
            })
            .expect("collects");
        claim(&vault, 8);
        let later = claims_after(&vault, last, 10).expect("a page");
        assert_eq!(later.len(), 1);
        assert!(later[0].seq > last, "{} must follow {last}", later[0].seq);
    }

    /// The read seeks the integer key and needs no sort or scan, whatever the library's size.
    #[test]
    fn the_claims_read_seeks_the_sequence() {
        let (_dir, vault) = new_vault();
        for byte in 1..=4 {
            claim(&vault, byte);
        }
        let plan: Vec<String> = vault
            .read(|connection| {
                let mut statement =
                    connection.prepare(&format!("EXPLAIN QUERY PLAN {CLAIMS_AFTER}"))?;
                let rows =
                    statement.query_map(rusqlite::params![0, 10], |row| row.get::<_, String>(3))?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            })
            .expect("a plan");
        let plan = plan.join(" | ");
        assert!(
            plan.contains("SEARCH blob USING INTEGER PRIMARY KEY (rowid>?)"),
            "{plan}"
        );
        assert!(
            !plan.contains("TEMP B-TREE") && !plan.contains("SCAN"),
            "{plan}"
        );
    }

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
