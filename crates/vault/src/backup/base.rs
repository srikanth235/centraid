//! The backup base copy — a **complete** vault, not a sanitised one (#1020,
//! D-1020-R8).
//!
//! ## Why this exists, and why it contradicts "one snapshot, three uses"
//!
//! D-1020-D1-7 rules that there is exactly one snapshot pipeline and it serves
//! three purposes: a seat's bootstrap, pre-migration safety, and a backup
//! generation's base. Two of those three are right. The third is not, and the
//! restore drill is what found it.
//!
//! [`crate::snapshot::build_snapshot`] builds the **seat** snapshot, and a seat
//! snapshot is *deliberately incomplete*: it drops every private table, drops
//! the indexes and views that name one, redacts excluded JSON keys, deletes
//! `replica_log`, and vacuums the free pages so the dropped bytes are gone.
//! Every one of those steps is correct for a file a phone is about to hold —
//! and each one is data a backup must not lose. Concretely, a generation built
//! from that artefact restores a vault with:
//!
//! - no `locker_key` row, so the vault **cannot name its own live key**. The
//!   recovery kit carries the key *file*; nothing carries the row. That is
//!   unrecoverable custody loss from a backup that reported success.
//! - no `access_device_secret`, so every paired device loses its key half;
//! - no `blob_*` custody, no `outbox_item`, no `replica_invocation_commit` —
//!   so in-flight work, blob custody and the exactly-once ledger are gone;
//! - no `replica_log`, so a restore cannot serve any seat a delta and every
//!   seat must re-bootstrap even when it did not have to.
//!
//! The drill's `restored-census` check reported all of it, table by table,
//! which is the whole reason the census check exists.
//!
//! So the base copy is a **plain `VACUUM INTO`**: the same file, compacted, and
//! nothing removed. It is content-addressed and gzipped like the seat snapshot,
//! so the blob store and the manifest treat the two identically. The seat
//! snapshot keeps its three-in-one role minus this one; the ruling is narrowed,
//! not discarded.
//!
//! **A base copy is a vault with its secrets in it.** It is only ever sealed
//! into a generation under the backup data key, and it must never be served to
//! a seat. That is why it is a different function with a different name in a
//! different module, rather than a flag on the snapshot builder: a boolean
//! there would be one typo away from handing a phone the credential bands.

use std::path::Path;

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// The identity of a base copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseHead {
    pub vault_id: String,
    /// blake3 of the artefact's bytes, as the gzipped file moves.
    pub digest: String,
    pub size: u64,
    /// The file name, derived from the digest — never given by a caller.
    pub name: String,
    /// The uncompressed size, so a restore can size its own scratch space.
    pub plain_size: u64,
}

/// Build a complete base copy of `vault` into `dir`.
///
/// `VACUUM INTO` refuses an existing target, which is the wanted behaviour, so
/// the working file is removed first and the artefact is renamed into place —
/// a reader therefore sees either nothing or a whole file.
pub fn build_backup_base(vault: &Vault, dir: &Path) -> Result<BaseHead> {
    use std::io::Write as _;

    std::fs::create_dir_all(dir)?;
    let working = dir.join("base.building");
    let working_gz = dir.join("base.building.gz");
    for path in [&working, &working_gz] {
        let _ = std::fs::remove_file(path);
    }

    let vault_id = vault.vault_id()?.ok_or_else(|| VaultError::Invariant {
        context: "a vault that was never founded has no base copy to take".to_owned(),
    })?;

    // The copy. `VACUUM INTO` cannot run inside a transaction, which is also
    // why a pre-migration snapshot has to be taken before the ladder opens one.
    // It goes through the crate-internal connection rather than
    // [`Vault::read`] for a reason SQLite decides: `read` holds
    // `PRAGMA query_only = ON`, and `VACUUM INTO` is a write as far as SQLite
    // is concerned even though it writes only to a new file.
    let target = working.to_str().ok_or_else(|| VaultError::Invariant {
        context: "the backup scratch path is not UTF-8".to_owned(),
    })?;
    vault
        .connection()
        .execute("VACUUM INTO ?1", [target])
        .map_err(|error| VaultError::from_sqlite("copying the vault for backup", error))?;
    let plain = std::fs::read(&working)?;
    let plain_size = plain.len() as u64;

    // Gzipped on disk and moved as-is, so a byte range over the artefact is a
    // range over what a reader downloads.
    {
        let file = std::fs::File::create(&working_gz)?;
        let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::new(6));
        encoder.write_all(&plain)?;
        encoder.finish()?;
    }
    let artefact = std::fs::read(&working_gz)?;
    let digest = blake3::hash(&artefact).to_hex().to_string();
    let name = format!("base-{}.db.gz", &digest[..16]);
    let target = dir.join(&name);
    std::fs::rename(&working_gz, &target)?;
    let _ = std::fs::remove_file(&working);

    Ok(BaseHead {
        vault_id,
        digest,
        size: artefact.len() as u64,
        name,
        plain_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::keystore::KeyStore;
    use crate::custody::locker_key::{self, LockerCustody};

    /// The regression the restore drill found. A seat snapshot is sanitised and
    /// a backup base is not, and the difference is custody.
    #[test]
    fn a_base_copy_keeps_the_private_bands_the_seat_snapshot_drops() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("vault.db");
        let vault = Vault::create(&file).unwrap();
        let founded = vault.found("The Household", "Ada").unwrap();
        vault
            .enrol_device("d-1", &founded.owner_party_id, "a laptop", "linux", "pk-1")
            .unwrap();
        let custody = LockerCustody::new(
            KeyStore::new(dir.path().join("keys")),
            founded.vault_id.clone(),
        );
        vault
            .commit(|tx| {
                locker_key::found_locker_key(
                    tx.connection(),
                    &custody,
                    "k-1",
                    "2026-01-01T00:00:00.000Z",
                )
                .map_err(|error| VaultError::Invariant {
                    context: error.to_string(),
                })?;
                Ok(())
            })
            .unwrap();

        let base = build_backup_base(&vault, &dir.path().join("base")).unwrap();
        let seat = crate::snapshot::build_snapshot(&vault, &dir.path().join("seat")).unwrap();
        vault.close().unwrap();

        let opened = |artefact: &Path| -> std::collections::BTreeSet<String> {
            use std::io::Read as _;
            let bytes = std::fs::read(artefact).unwrap();
            let mut plain = Vec::new();
            flate2::read::GzDecoder::new(&bytes[..])
                .read_to_end(&mut plain)
                .unwrap();
            let out = artefact.with_extension("opened.db");
            std::fs::write(&out, plain).unwrap();
            let connection = rusqlite::Connection::open(&out).unwrap();
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };

        let in_base = opened(&dir.path().join("base").join(&base.name));
        let in_seat = opened(&dir.path().join("seat").join(&seat.name));

        // The three that make this a bug and not a preference.
        for private in ["locker_key", "access_device_secret", "blob_outbox"] {
            assert!(
                in_base.contains(private),
                "the base copy must keep {private}"
            );
            assert!(
                !in_seat.contains(private),
                "the seat snapshot is supposed to drop {private}"
            );
        }
        assert!(
            in_base.contains("replica_log"),
            "the log is part of a backup"
        );

        // And the base copy still names its live Locker key, which is the
        // sentence the whole module exists for.
        let out = dir
            .path()
            .join("base")
            .join(&base.name)
            .with_extension("opened.db");
        let connection = rusqlite::Connection::open(&out).unwrap();
        assert_eq!(
            locker_key::live_locker_key_id(&connection)
                .unwrap()
                .as_deref(),
            Some("k-1")
        );
    }

    #[test]
    fn a_base_copy_is_named_by_its_digest_and_a_rebuild_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("vault.db");
        let vault = Vault::create(&file).unwrap();
        vault.found("The Household", "Ada").unwrap();
        let first = build_backup_base(&vault, &dir.path().join("base")).unwrap();
        let second = build_backup_base(&vault, &dir.path().join("base")).unwrap();
        vault.close().unwrap();
        assert_eq!(first, second, "the same vault gives the same artefact");
        assert!(first.name.starts_with("base-") && first.name.ends_with(".db.gz"));
        assert!(first.name.contains(&first.digest[..16]));
        assert!(first.plain_size > first.size, "gzip earns its place");
        assert!(
            !dir.path().join("base").join("base.building").exists(),
            "no working file survives"
        );
    }

    #[test]
    fn a_vault_that_was_never_founded_has_no_base_copy() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::create(dir.path().join("vault.db")).unwrap();
        assert!(build_backup_base(&vault, &dir.path().join("base")).is_err());
    }
}
