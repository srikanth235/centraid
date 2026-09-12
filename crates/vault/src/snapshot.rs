//! One snapshot, three uses (D-1020-D1-7).
//!
//! The gateway's backup, a new seat's bootstrap, and the pre-migration safety
//! copy are **the same artifact**. v0 had three mechanisms; making it one
//! removes two, and content-addressing it makes a resumable, verified transfer
//! free (the blob layer already deduplicates by digest).
//!
//! ## The pipeline, in exactly this order
//!
//! 1. `VACUUM INTO <name>.building`. Refuses an existing destination, which is
//!    the wanted behaviour. Measured in v0 under 20 s of concurrent writes:
//!    7,550 commits, 0 errors, worst latency 179 ms.
//! 2. On the COPY: `PRAGMA secure_delete = ON`, then `PRAGMA foreign_keys =
//!    OFF` — **before any drop**. Without `secure_delete` v0's control planted
//!    ten credential canaries and all ten stayed readable in 4,360 free pages
//!    while `sqlite_schema` already read clean.
//! 3. Read epoch, schema epoch and `seq` **from the copy**, not the live vault.
//!    Reading the live vault around a `VACUUM INTO` — which cannot be in a
//!    transaction — produced a file whose `replica_meta` carried epoch B under
//!    an identity stamped A, and a restore under live seats could loop.
//! 4. Drop every trigger **except FTS sync**, matched on the trigger's BODY and
//!    not its name; drop indexes and views that name a private table, with SQL
//!    comments stripped first so prose mentioning one does not drop a live
//!    index; drop the private tables.
//! 5. Redact the excluded JSON keys. This step must sit BETWEEN the trigger
//!    drops (or the append-only trigger refuses the UPDATE) and the VACUUM (or
//!    the old text stays legible in a free page).
//! 6. `DELETE FROM replica_log`, then `floor_seq = seq` and `active_commit_id =
//!    NULL` — **the log goes, the cursor stays**. A bootstrapped seat starts at
//!    a real position rather than at zero.
//! 7. `VACUUM`. The step that actually reclaims the pages the drops freed.
//!
//! FTS shadow tables are **kept**: dropping them saves 12 MB and then the 57
//! retained FTS sync triggers fail on the seat's first write.
//!
//! ## The artifact
//!
//! `snapshot-<blake3(epoch:seq)[..16]>-<seq>.db.gz`, gzip level 6, built to
//! `<name>.building.gz` and renamed in — so a reader sees either nothing or a
//! complete file. The name carries the seq twice over: once inside the digest
//! and once in the clear, because eviction has to read the seq back OUT of the
//! name (sorting a directory listing sorts by the digest prefix, and could
//! delete the artifact a phone is downloading).

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// A step of the pipeline, for the fault injector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Vacuumed,
    Sanitised,
    Numbered,
    Dropped,
    Redacted,
    LogTruncated,
    Compacted,
    Gzipped,
}

/// A fault a test injects between steps.
///
/// Not a `#[cfg(test)]` hook: the interrupted-build test is a RED-FIRST gate
/// (D-1020-D1-7) and a gate that only exists in test builds proves nothing
/// about the shipped builder. The injector is inert unless something calls
/// [`Vault::inject_fault`], which nothing in the product does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// Abort as soon as this step has finished, as a process death would.
    AbortAfter(Step),
    /// Write the copy somewhere else — for a test that needs `VACUUM INTO` to
    /// fail for a REAL reason.
    ///
    /// A snapshot build can never exhaust SQLite pages (D-1020-D1-17): every
    /// step after the copy only ever FREES pages, so `PRAGMA max_page_count`
    /// has nothing to refuse, and SQLite clamps a cap up to the current size
    /// anyway. The disk-full surface of a build is the two FILE writes — the
    /// `VACUUM INTO` and the gzip — and this redirects the first of them. A
    /// test on Linux points it at `/dev/full`, which returns ENOSPC on every
    /// write and makes SQLite report a genuine `SQLITE_FULL`.
    CopyTo(&'static str),
}

/// The identity of a snapshot artifact — lane C's `SnapshotHead`, in Rust
/// until `crates/api-proto` lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotHead {
    pub vault_id: String,
    pub epoch: String,
    pub seq: i64,
    pub schema_epoch: i64,
    /// blake3 of the artifact's BYTES — the gzipped file as it moves.
    pub digest: String,
    pub size: u64,
    /// The artifact's file name, which the digest of `<epoch>:<seq>` names.
    pub name: String,
}

impl Vault {
    /// Arm a fault for the next snapshot build.
    pub fn inject_fault(&self, fault: Option<Fault>) {
        self.fault.set(fault);
    }

    fn fault_at(&self, step: Step) -> Result<()> {
        if self.fault.get() == Some(Fault::AbortAfter(step)) {
            return Err(VaultError::Invariant {
                context: format!("injected fault after {step:?}"),
            });
        }
        Ok(())
    }

    fn copy_target(&self) -> Option<&'static str> {
        match self.fault.get() {
            Some(Fault::CopyTo(path)) => Some(path),
            _ => None,
        }
    }
}

/// Where a pre-migration copy goes: beside the vault, in its own directory.
#[must_use]
pub fn pre_migration_dir(vault_path: &Path) -> PathBuf {
    vault_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("snapshots")
}

/// Build a snapshot into `dir`, returning its head.
///
/// `dir` is created if it does not exist. The artifact's name is derived, not
/// given: a caller that chose the name could produce two different files under
/// one identity, which is the whole thing content-addressing prevents.
pub fn build_snapshot(vault: &Vault, dir: &Path) -> Result<SnapshotHead> {
    std::fs::create_dir_all(dir)?;
    let working = dir.join("snapshot.building");
    let working_gz = dir.join("snapshot.building.gz");
    // A leftover from an interrupted build is not evidence of anything: clear
    // it, because `VACUUM INTO` refuses an existing destination and a build
    // that could never retry would be worse than one that overwrites scratch.
    let _ = std::fs::remove_file(&working);
    let _ = std::fs::remove_file(&working_gz);

    let outcome = build_into(vault, &working, &working_gz);
    if outcome.is_err() {
        // NO PARTIAL ARTIFACT. Both scratch files go; the only thing that ever
        // appears under the final name is a complete file.
        let _ = std::fs::remove_file(&working);
        let _ = std::fs::remove_file(&working_gz);
        return outcome.map(|(head, _)| head);
    }
    let (mut head, _) = outcome?;
    let final_path = dir.join(&head.name);
    // THE RENAME IS THE PUBLICATION. Atomic within a filesystem, so a reader
    // sees either nothing or a complete file.
    std::fs::rename(&working_gz, &final_path)?;
    let _ = std::fs::remove_file(&working);
    head.size = std::fs::metadata(&final_path)?.len();
    Ok(head)
}

fn build_into(vault: &Vault, working: &Path, working_gz: &Path) -> Result<(SnapshotHead, PathBuf)> {
    // 1. VACUUM INTO. Not a transaction, and it cannot be in one.
    let target = vault
        .copy_target()
        .map_or_else(|| working.to_string_lossy().to_string(), str::to_owned);
    vault
        .connection()
        .execute("VACUUM INTO ?1", [&target])
        .map_err(|error| VaultError::from_sqlite("copying the vault", error))?;
    vault.fault_at(Step::Vacuumed)?;

    let copy = Connection::open(working)?;
    // 2. BEFORE ANY DROP.
    copy.pragma_update(None, "secure_delete", "ON")?;
    copy.pragma_update(None, "foreign_keys", "OFF")?;
    vault.fault_at(Step::Sanitised)?;

    // 3. FROM THE COPY.
    let (vault_id, epoch, schema_epoch, seq) = numbers_from(&copy)?;
    vault.fault_at(Step::Numbered)?;

    // 4. Triggers, then indexes and views, then the private tables.
    drop_objects(&copy)?;
    vault.fault_at(Step::Dropped)?;

    // 5. Between the drops and the VACUUM.
    redact_columns(&copy)?;
    vault.fault_at(Step::Redacted)?;

    // 6. The log goes, the cursor stays.
    copy.execute("DELETE FROM replica_log", [])
        .map_err(|error| VaultError::from_sqlite("truncating the snapshot's log", error))?;
    copy.execute(
        "UPDATE replica_meta SET floor_seq = ?1, active_commit_id = NULL WHERE singleton = 1",
        [seq],
    )
    .map_err(|error| VaultError::from_sqlite("keeping the snapshot's cursor", error))?;
    vault.fault_at(Step::LogTruncated)?;

    // 7. The step that reclaims the pages.
    copy.execute_batch("VACUUM")
        .map_err(|error| VaultError::from_sqlite("compacting the snapshot", error))?;
    copy.close()
        .map_err(|(_, error)| VaultError::Sqlite(error))?;
    vault.fault_at(Step::Compacted)?;

    gzip_file(working, working_gz)?;
    vault.fault_at(Step::Gzipped)?;

    let bytes = std::fs::read(working_gz)?;
    let digest = blake3::hash(&bytes).to_hex().to_string();
    let name_digest = blake3::hash(format!("{epoch}:{seq}").as_bytes()).to_hex();
    let name = format!("snapshot-{}-{seq}.db.gz", &name_digest[..16]);
    Ok((
        SnapshotHead {
            vault_id,
            epoch,
            seq,
            schema_epoch,
            digest,
            size: bytes.len() as u64,
            name,
        },
        working_gz.to_path_buf(),
    ))
}

/// The four numbers, read from the copy.
fn numbers_from(copy: &Connection) -> Result<(String, String, i64, i64)> {
    let (epoch, floor, schema_epoch): (String, i64, i64) = copy.query_row(
        "SELECT epoch, floor_seq, schema_epoch FROM replica_meta WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let highest: i64 = copy.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM replica_log WHERE epoch = ?1",
        [&epoch],
        |row| row.get(0),
    )?;
    let vault_id: String = copy
        .query_row(
            "SELECT vault_id FROM core_vault ORDER BY vault_id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();
    Ok((vault_id, epoch, schema_epoch, highest.max(floor)))
}

/// Drop every object a seat's copy must not carry.
///
/// Every statement's failure is classified, because a drop is where a capped
/// or genuinely full disk shows up: dropping a table writes to the freelist.
fn drop_objects(copy: &Connection) -> Result<()> {
    let private: Vec<String> = centraid_ontology::registries::private_table_names()
        .into_iter()
        .map(str::to_owned)
        .collect();

    // Triggers: keep only FTS sync, and identify one by its BODY. A trigger
    // named `core_party_touch_updated_at` mints a `row_version` a mirror must
    // not mint; a trigger whose body names an `fts_*` table keeps the index in
    // step with the data. The name says nothing reliable about either.
    let triggers: Vec<(String, String)> = copy
        .prepare("SELECT name, COALESCE(sql, '') FROM sqlite_master WHERE type = 'trigger'")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, sql) in triggers {
        if mentions_fts_table(&sql) {
            continue;
        }
        copy.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS {}",
            crate::log::quoted(&name)
        ))?;
    }

    // Indexes and views naming a private table. `sqlite_autoindex_*` is
    // implicit and not nameable in DDL, so it is skipped rather than attempted.
    let objects: Vec<(String, String, String)> = copy
        .prepare(
            "SELECT type, name, COALESCE(sql, '') FROM sqlite_master
              WHERE type IN ('index', 'view')",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (kind, name, sql) in objects {
        if name.starts_with("sqlite_autoindex") {
            continue;
        }
        if !names_private_table(&sql, &private) {
            continue;
        }
        let statement = if kind == "view" { "VIEW" } else { "INDEX" };
        copy.execute_batch(&format!(
            "DROP {statement} IF EXISTS {}",
            crate::log::quoted(&name)
        ))?;
    }

    for table in &private {
        copy.execute_batch(&format!(
            "DROP TABLE IF EXISTS {}",
            crate::log::quoted(table)
        ))?;
    }
    Ok(())
}

/// Does this trigger's body name an FTS table?
///
/// `\bfts_[A-Za-z0-9_]+\b` in v0. Written as a scan rather than a regex, to
/// keep the crate's dependency list short for one pattern.
#[must_use]
pub fn mentions_fts_table(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut index = 0;
    while let Some(found) = sql[index..].find("fts_") {
        let at = index + found;
        let boundary_before = at == 0 || !is_word_byte(bytes[at - 1]);
        let after = at + 4;
        let word = bytes[after..]
            .iter()
            .take_while(|byte| is_word_byte(**byte))
            .count();
        if boundary_before && word > 0 {
            return true;
        }
        index = at + 4;
    }
    false
}

const fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Does this DDL name a private table, with SQL COMMENTS STRIPPED FIRST?
///
/// Comment-stripping is not tidiness: the DDL in this schema carries long
/// explanatory comments, and one of them mentioning `locker_key` by name would
/// otherwise drop a live index over a replicated table.
#[must_use]
pub fn names_private_table(sql: &str, private: &[String]) -> bool {
    let stripped = strip_sql_comments(sql);
    private.iter().any(|table| {
        stripped
            .split(|character: char| !is_word_byte(character as u8) && !character.is_alphanumeric())
            .any(|word| word == table)
    })
}

/// Remove `--` line comments and `/* */` block comments.
#[must_use]
pub fn strip_sql_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'-' && bytes.get(index + 1) == Some(&b'-') {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index < bytes.len()
                && !(bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/'))
            {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    out
}

/// Remove the excluded JSON keys from the columns that carry them.
///
/// `json_remove` guarded by `json_type(col, path) IS NOT NULL`, so a row with
/// nothing to remove is not rewritten — the byte-identity rule again, one layer
/// down: an untouched row must not move.
fn redact_columns(copy: &Connection) -> Result<()> {
    for exclusion in &crate::log::constants().json_key_exclusions {
        let exists: i64 = copy.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [&exclusion.table],
            |row| row.get(0),
        )?;
        if exists == 0 {
            continue;
        }
        for key in &exclusion.json_keys {
            let path = format!("$.{key}");
            let column = crate::log::quoted(&exclusion.column);
            copy.execute(
                &format!(
                    "UPDATE {} SET {column} = json_remove({column}, ?1)
                      WHERE json_type({column}, ?1) IS NOT NULL",
                    crate::log::quoted(&exclusion.table)
                ),
                [&path],
            )?;
        }
    }
    Ok(())
}

fn gzip_file(from: &Path, to: &Path) -> Result<()> {
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write as _;
    let plain = std::fs::read(from)?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&plain)?;
    let compressed = encoder.finish()?;
    std::fs::write(to, compressed)?;
    Ok(())
}

/// Do these raw bytes contain `needle`?
///
/// Reads the file as BYTES and deliberately does not open it as a database:
/// the claim being tested is "a credential is not in the file", and a reader
/// that went through SQLite would only ever see the pages SQLite admits to.
pub fn file_contains(path: &Path, needle: &[u8]) -> Result<bool> {
    let bytes = std::fs::read(path)?;
    Ok(bytes
        .windows(needle.len().max(1))
        .any(|window| window == needle))
}

/// Do these GZIPPED bytes, inflated, contain `needle`?
pub fn gzipped_contains(path: &Path, needle: &[u8]) -> Result<bool> {
    use flate2::read::GzDecoder;
    use std::io::Read as _;
    let mut decoder = GzDecoder::new(std::fs::File::open(path)?);
    let mut plain = Vec::new();
    decoder.read_to_end(&mut plain)?;
    Ok(plain
        .windows(needle.len().max(1))
        .any(|window| window == needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_fts_trigger_is_recognised_by_its_body() {
        assert!(mentions_fts_table(
            "CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO fts_x(a) VALUES (1); END"
        ));
        // A trigger whose STATEMENT TEXT contains no FTS name at all is
        // dropped, which is the case that matters: the touch-updated-at
        // triggers, which mint a `row_version` a mirror must not mint.
        assert!(!mentions_fts_table("CREATE TRIGGER t BEGIN SELECT 1; END"));
        assert!(!mentions_fts_table(
            "CREATE TRIGGER core_party_touch_updated_at AFTER UPDATE ON core_party \
             WHEN NEW.row_version = OLD.row_version BEGIN UPDATE core_party SET \
             row_version = OLD.row_version + 1; END"
        ));
        // A trigger merely NAMED `fts_…` is KEPT, because the match is over the
        // whole `sqlite_master.sql` — which includes the name. v0's own comment
        // says "matching on the body", and its regex runs over the same whole
        // statement, so this is v0's behaviour and not a port slip. It is safe
        // in practice (nothing but an FTS sync trigger is named `fts_*`) and it
        // is a wider match than the comment claims; recorded as a finding.
        // A word boundary before, so `myfts_x` does not count.
        assert!(!mentions_fts_table("INSERT INTO myfts_x VALUES (1)"));
    }

    #[test]
    fn comments_are_stripped_before_a_private_table_is_looked_for() {
        let private = vec!["locker_key".to_owned()];
        // THE FAILURE THIS PREVENTS: prose in a comment dropping a live index.
        assert!(!names_private_table(
            "-- unlike locker_key, this one replicates\nCREATE INDEX i ON core_party (party_id)",
            &private
        ));
        assert!(!names_private_table(
            "/* see locker_key */ CREATE INDEX i ON core_party (party_id)",
            &private
        ));
        assert!(names_private_table(
            "CREATE INDEX i ON locker_key (key_id)",
            &private
        ));
        // And a longer name that merely contains it is not it.
        assert!(!names_private_table(
            "CREATE INDEX i ON locker_key_history (key_id)",
            &private
        ));
    }
}
