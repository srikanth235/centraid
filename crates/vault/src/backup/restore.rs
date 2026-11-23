//! Restore, check and the structural check (spec §7,
//! [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! **The order is R3**: records first (the pages are written, verified and
//! the vault opens), then thumbnails (the library is browsable), then
//! originals, newest first, in the background or on open. [`Restore`] yields
//! them in that order and no other: [`Restore::records`], then
//! [`Restore::thumbnails`], then [`Restore::originals`], or all three through
//! [`Restore::restore_all`], which says when the vault may open.
//!
//! Every object is fetched from the first gateway that has it and opened
//! strictly against the ref that named it, so a gateway can lose or damage an
//! object and the next one supplies it, and nothing a gateway says is believed
//! until it opens.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

use centraid_media::sealed::{self, BackupKeys, Class, Name, PlaintextHash, Ref};

use super::store::{Head, Store, StoreError};
use super::tree::{self, Entry, Node, NodeSource, RANGE_BYTES, Root};
use super::{PlaneError, Result, invariant};
use crate::migrations::{LADDER, Migration};

/// The greatest `(epoch, generation, writes)` of the heads the gateways answered: the one to
/// restore. A gateway that answered nothing is not in the list.
#[must_use]
pub fn pick_head(heads: &[(String, Head)]) -> Option<&(String, Head)> {
    heads
        .iter()
        .max_by_key(|(_, head)| (head.epoch, head.generation, head.writes))
}

/// Why a restore refused.
#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    /// The backup is of a newer build's schema: update, never guess down.
    #[error(
        "this backup was made by a newer version (schema rung {found}; this version reads up to {supported}): update to restore it"
    )]
    NewerBuild { found: i64, supported: i64 },
    /// The file's tables are not the ones its own rung makes.
    #[error("the restored file's tables are not rung {rung}'s: found {found}, expected {expected}")]
    SchemaMismatch {
        rung: i64,
        found: String,
        expected: String,
    },
    /// The file is a vault of the model before #1135.
    #[error("this backup is of an earlier model of the vault, which this version does not read")]
    EarlierModel,
    #[error(transparent)]
    Plane(#[from] PlaneError),
}

impl From<StoreError> for RestoreError {
    fn from(error: StoreError) -> Self {
        Self::Plane(error.into())
    }
}

impl From<rusqlite::Error> for RestoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Plane(error.into())
    }
}

impl From<std::io::Error> for RestoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Plane(error.into())
    }
}

/// The schema digest of a file that has run the ladder up to and including `version`: the rungs
/// are applied to an empty in-memory file, so the answer is whatever the ladder says that rung
/// makes, never a constant that could drift from it.
fn rung_digest(ladder: &[Migration], version: i64) -> std::result::Result<String, RestoreError> {
    let connection = rusqlite::Connection::open_in_memory()?;
    let mut reached = 0_i64;
    for rung in ladder.iter().filter(|rung| rung.version <= version) {
        connection.execute_batch(rung.sql)?;
        reached = rung.version;
    }
    if reached != version || version < 1 {
        return Err(RestoreError::SchemaMismatch {
            rung: version,
            found: format!("rung {version}"),
            expected: format!(
                "a rung from 1 to {}",
                ladder.last().map_or(0, |r| r.version)
            ),
        });
    }
    Ok(crate::format::schema_digest(&connection)?)
}

/// What one check of a restored vault found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: &'static str,
}

/// What the records phase did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordsReport {
    pub ranges: u64,
    pub bytes: u64,
    /// The checks that passed, in order. A failed one is the error.
    pub checks: Vec<Check>,
}

/// What a media phase did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaReport {
    /// Files written to the sink.
    pub restored: u64,
    /// Files with a chunk no gateway could supply.
    pub missing: u64,
    /// Files whose chunks opened but did not make the hash the tree names.
    pub damaged: u64,
}

/// A tree opened from the gateways.
pub struct Restore<'a> {
    keys: &'a BackupKeys,
    stores: Vec<&'a dyn Store>,
    nodes: BTreeMap<Name, Vec<u8>>,
    pub root_ref: Ref,
    pub root: Root,
}

fn failure(name: &'static str, detail: impl std::fmt::Display) -> PlaneError {
    invariant(format!("restore check `{name}` failed: {detail}"))
}

impl NodeSource for Restore<'_> {
    fn plaintext(&self, name: &Name) -> Result<Option<Vec<u8>>> {
        Ok(self.nodes.get(name).cloned())
    }
}

impl<'a> Restore<'a> {
    /// Fetch the root a head names and every node under it.
    ///
    /// # Errors
    /// A node no gateway holds or that will not open.
    pub fn open(keys: &'a BackupKeys, stores: &[&'a dyn Store], head: &Name) -> Result<Self> {
        let mut this = Self {
            keys,
            stores: stores.to_vec(),
            nodes: BTreeMap::new(),
            root_ref: Ref {
                name: *head,
                digest: sealed::Digest::of(&[]),
                len: 0,
                class: Class::Records,
            },
            root: Root {
                writes: 0,
                user_version: 0,
                page_size: 0,
                page_count: 0,
                taken_at_ms: 0,
                census: BTreeMap::new(),
                db_hash: None,
                range_leaves: Vec::new(),
                blobs: Ref {
                    name: *head,
                    digest: sealed::Digest::of(&[]),
                    len: 0,
                    class: Class::Records,
                },
                directory: Ref {
                    name: *head,
                    digest: sealed::Digest::of(&[]),
                    len: 0,
                    class: Class::Records,
                },
            },
        };
        let object = this.fetch(head)?;
        let plaintext = sealed::open_checked(keys, head, Class::Records, None, None, &object)?;
        this.root_ref = sealed::seal(keys, Class::Records, &plaintext)?.reference();
        let Node::Root(root) = Node::decode(&plaintext)? else {
            return Err(invariant("a head names something that is not a root"));
        };
        this.nodes.insert(*head, plaintext);
        let mut stack: Vec<Ref> = root.range_leaves.clone();
        stack.push(root.blobs);
        stack.push(root.directory);
        while let Some(reference) = stack.pop() {
            let plaintext = this.fetch_open(&reference)?;
            if reference.name != root.directory.name {
                match Node::decode(&plaintext)? {
                    Node::Blobs(tree::BlobsNode {
                        body: tree::BlobsBody::Children(children),
                        ..
                    }) => stack.extend(children.into_iter().map(|(_, child)| child)),
                    Node::Blobs(_) | Node::Leaf(_) => {}
                    Node::Root(_) => return Err(invariant("a root inside a tree")),
                }
            }
            this.nodes.insert(reference.name, plaintext);
        }
        this.root = *root;
        Ok(this)
    }

    fn fetch(&self, name: &Name) -> Result<Vec<u8>> {
        let mut last = StoreError::Missing(*name);
        for store in &self.stores {
            let mut object = Vec::new();
            match store.get(name, &mut object) {
                Ok(_) => return Ok(object),
                Err(error) => last = error,
            }
        }
        Err(last.into())
    }

    /// Fetch and open against the ref, trying each gateway until one supplies bytes that open.
    fn fetch_open(&self, reference: &Ref) -> Result<Vec<u8>> {
        let mut last: Option<PlaneError> = None;
        for store in &self.stores {
            let mut object = Vec::new();
            match store.get(&reference.name, &mut object) {
                Ok(_) => match sealed::open(self.keys, reference, &object) {
                    Ok(plaintext) => return Ok(plaintext),
                    Err(error) => last = Some(error.into()),
                },
                Err(error) => last = Some(error.into()),
            }
        }
        Err(last.unwrap_or_else(|| invariant("there is no gateway to restore from")))
    }

    // ── R3, phase 1: records ──

    /// Write the vault's pages to `path`, verify them against this build's ladder and say what
    /// held. After this the vault opens.
    ///
    /// # Errors
    /// A range no gateway supplies or that will not open; a failed check, named; a backup of a
    /// newer schema. A refused restore leaves no file.
    pub fn records(&self, path: &Path) -> std::result::Result<RecordsReport, RestoreError> {
        self.records_on(LADDER, path)
    }

    /// [`Self::records`] against a given ladder: the backup is accepted at any rung the ladder
    /// knows (the caller's `Vault::open` climbs it), and refused above it.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn records_on(
        &self,
        ladder: &[Migration],
        path: &Path,
    ) -> std::result::Result<RecordsReport, RestoreError> {
        // THE BACKUP'S OWN RUNG, NOT THE RUNNING BUILD'S: a rung above the ladder is a newer
        // build's, refused with a sentence that says to update, before anything is written.
        let supported = ladder.last().map_or(0, |rung| rung.version);
        let found = i64::try_from(self.root.user_version).unwrap_or(i64::MAX);
        if found > supported {
            return Err(RestoreError::NewerBuild { found, supported });
        }
        let outcome = self.write_records(ladder, path);
        if outcome.is_err() {
            let _ = std::fs::remove_file(path);
        }
        outcome
    }

    fn write_records(
        &self,
        ladder: &[Migration],
        path: &Path,
    ) -> std::result::Result<RecordsReport, RestoreError> {
        let ranges = tree::ranges_of(self, &self.root)?;
        let total = self.root.page_size * self.root.page_count;
        if ranges.len() as u64 != self.root.range_count() {
            return Err(failure("ranges", "the tree names a different number of ranges").into());
        }
        let mut file = File::create(path)?;
        let mut whole = blake3::Hasher::new();
        let mut written = 0_u64;
        for (index, reference) in ranges.iter().enumerate() {
            let bytes = self.fetch_open(reference)?;
            let expected = if (index as u64 + 1) * RANGE_BYTES as u64 <= total {
                RANGE_BYTES as u64
            } else {
                total - index as u64 * RANGE_BYTES as u64
            };
            if bytes.len() as u64 != expected {
                return Err(
                    failure("ranges", format!("range {index} is {} bytes", bytes.len())).into(),
                );
            }
            file.seek(SeekFrom::Start(index as u64 * RANGE_BYTES as u64))?;
            file.write_all(&bytes)?;
            whole.update(&bytes);
            written += bytes.len() as u64;
        }
        file.sync_all()?;
        drop(file);
        let mut checks = vec![Check { name: "ranges" }];
        if let Some(expected) = self.root.db_hash {
            if whole.finalize().as_bytes() != &expected {
                return Err(
                    failure("db_hash", "the pages are not the ones the root hashed").into(),
                );
            }
            checks.push(Check { name: "db_hash" });
        }
        let connection = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        connection.pragma_update(None, "wal_autocheckpoint", 0)?;
        crate::file::quick_check(&connection).map_err(|error| failure("integrity_check", error))?;
        checks.push(Check {
            name: "integrity_check",
        });
        // THE FORMAT, BEFORE ANYTHING ELSE IS ASKED OF THE FILE.
        let application_id: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        if application_id == crate::format::EARLIER_APPLICATION_ID {
            return Err(RestoreError::EarlierModel);
        }
        if application_id != crate::format::APPLICATION_ID {
            return Err(failure("application_id", "this file is not a vault").into());
        }
        let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let page_count: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        if u64::try_from(page_size).ok() != Some(self.root.page_size)
            || u64::try_from(page_count).ok() != Some(self.root.page_count)
        {
            return Err(failure("header", "the file's size is not the root's").into());
        }
        checks.push(Check { name: "header" });
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if u64::try_from(version).ok() != Some(self.root.user_version) {
            return Err(failure("schema", "the user_version is not the root's").into());
        }
        let expected = rung_digest(ladder, version)?;
        let found = crate::format::schema_digest(&connection)?;
        if found != expected {
            return Err(RestoreError::SchemaMismatch {
                rung: version,
                found,
                expected,
            });
        }
        checks.push(Check { name: "schema" });
        let census: BTreeMap<String, u64> = crate::pagesource::census_of(&connection)?
            .into_iter()
            .map(|(table, rows)| (table, u64::try_from(rows).unwrap_or(0)))
            .collect();
        if census != self.root.census {
            return Err(failure("census", "the rows are not the ones the root counted").into());
        }
        checks.push(Check { name: "census" });
        Ok(RecordsReport {
            ranges: ranges.len() as u64,
            bytes: written,
            checks,
        })
    }

    // ── R3, phases 2 and 3: media ──

    fn entries(&self) -> Result<Vec<Entry>> {
        let mut entries = tree::entries_of(self, &self.root.blobs)?;
        entries.sort_by_key(|entry| (std::cmp::Reverse(entry.taken_at_ms), entry.h));
        Ok(entries)
    }

    fn media(
        &self,
        class: Class,
        sink: &mut dyn FnMut(&Entry, &[u8]) -> Result<()>,
    ) -> Result<MediaReport> {
        let mut report = MediaReport::default();
        for entry in self.entries()? {
            let refs = entry.refs(class);
            let wanted = !refs.is_empty() || (class == Class::Originals && entry.size == 0);
            if !wanted {
                continue;
            }
            let mut content = Vec::with_capacity(usize::try_from(entry.size).unwrap_or(0));
            let mut missing = false;
            for reference in refs {
                match self.fetch_open(reference) {
                    Ok(bytes) => content.extend_from_slice(&bytes),
                    Err(_) => {
                        missing = true;
                        break;
                    }
                }
            }
            if missing {
                report.missing += 1;
            } else if PlaintextHash::of(&content) == entry.h {
                sink(&entry, &content)?;
                report.restored += 1;
            } else {
                report.damaged += 1;
            }
        }
        Ok(report)
    }

    /// Phase 2: every derivative, newest first, handed to `sink` as bytes whose hash is `entry.h`.
    ///
    /// # Errors
    /// The sink's refusal, or a node that is missing.
    pub fn thumbnails(
        &self,
        sink: &mut dyn FnMut(&Entry, &[u8]) -> Result<()>,
    ) -> Result<MediaReport> {
        self.media(Class::Thumbnails, sink)
    }

    /// Phase 3: every original, newest first.
    ///
    /// # Errors
    /// The sink's refusal, or a node that is missing.
    pub fn originals(
        &self,
        sink: &mut dyn FnMut(&Entry, &[u8]) -> Result<()>,
    ) -> Result<MediaReport> {
        self.media(Class::Originals, sink)
    }

    /// All three phases in the order R3: the pages first, then `opened` (the caller opens the
    /// vault), then thumbnails, then originals.
    ///
    /// # Errors
    /// Whatever a phase refuses; `opened`'s own error stops it before any media.
    pub fn restore_all(
        &self,
        path: &Path,
        opened: &mut dyn FnMut(&Path) -> Result<()>,
        sink: &mut dyn FnMut(&Entry, &[u8]) -> Result<()>,
    ) -> std::result::Result<(RecordsReport, MediaReport, MediaReport), RestoreError> {
        let records = self.records(path)?;
        opened(path)?;
        let thumbnails = self.thumbnails(sink)?;
        let originals = self.originals(sink)?;
        Ok((records, thumbnails, originals))
    }
}

/// What "Check my backup" found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckReport {
    pub records: RecordsReport,
    /// Chunks the tree lists that the gateway does not hold, by class.
    pub thumbnails_missing: u64,
    pub originals_missing: u64,
}

/// "Check my backup": restore the head's records into `scratch` from the tree, verify, and ask
/// the gateway whether it holds every media chunk the tree lists. The scratch directory is
/// removed whatever happens.
///
/// # Errors
/// The first failed check, or a gateway that cannot be asked.
pub fn check(
    keys: &BackupKeys,
    store: &dyn Store,
    scratch: &Path,
) -> std::result::Result<CheckReport, RestoreError> {
    let head = store
        .head()?
        .ok_or_else(|| invariant("the gateway holds no head to check"))?;
    let restore = Restore::open(keys, &[store], &head.name)?;
    std::fs::create_dir_all(scratch)?;
    let outcome = (|| -> std::result::Result<CheckReport, RestoreError> {
        let records = restore.records(&scratch.join("check.db"))?;
        let mut missing = [0_u64; 2];
        for (slot, class) in [Class::Thumbnails, Class::Originals]
            .into_iter()
            .enumerate()
        {
            let names: Vec<Name> = tree::media_of(&restore, &restore.root_ref, class)?
                .into_keys()
                .collect();
            for batch in names.chunks(super::store::NAMES_PER_CALL) {
                missing[slot] += store.exists(batch)?.len() as u64;
            }
        }
        Ok(CheckReport {
            records,
            thumbnails_missing: missing[0],
            originals_missing: missing[1],
        })
    })();
    let _ = std::fs::remove_dir_all(scratch);
    outcome
}

// ─── the structural check of a vault file (centraid doctor) ─────────────────

/// What the structural check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuralReport {
    /// `PRAGMA integrity_check`.
    pub integrity: String,
    pub foreign_key_violations: Vec<String>,
}

impl StructuralReport {
    /// Clean means: pages sound and keys hold.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.integrity == "ok" && self.foreign_key_violations.is_empty()
    }
}

/// Why the structural check could not run.
#[derive(Debug, thiserror::Error)]
pub enum CheckError {
    #[error("there is no vault file at {0}")]
    Missing(std::path::PathBuf),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// `integrity_check` and `foreign_key_check` over a vault file that is not live. Read-only and
/// lock-free: it never changes the file it judges.
///
/// # Errors
/// A missing file, or SQLite's refusal.
pub fn restore_check(file: &Path) -> std::result::Result<StructuralReport, CheckError> {
    if !file.exists() {
        return Err(CheckError::Missing(file.to_path_buf()));
    }
    let connection = rusqlite::Connection::open_with_flags(
        file,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    let mut violations = Vec::new();
    {
        let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let child: String = row.get(0)?;
            let rowid: Option<i64> = row.get(1)?;
            let parent: String = row.get(2)?;
            violations.push(format!(
                "{child} rowid {} references {parent} and the parent row is missing",
                rowid.map_or_else(|| "(none)".to_owned(), |id| id.to_string())
            ));
        }
    }
    Ok(StructuralReport {
        integrity,
        foreign_key_violations: violations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::directory::Directory;
    use crate::backup::engine::{Env, GatewayPass, Policy, Scheduler};
    use crate::backup::snapshot::{self, Options};
    use crate::backup::staging::Staging;
    use crate::backup::state::{DeviceState, Gateway};
    use crate::backup::store::MemoryStore;

    /// A rung two the real ladder does not have yet: one more table.
    const RUNG_TWO: &str = "CREATE TABLE later_rung (id TEXT PRIMARY KEY, note TEXT) STRICT;";

    fn two_rungs() -> Vec<Migration> {
        vec![
            Migration {
                version: 1,
                name: "baseline",
                sql: LADDER[0].sql,
            },
            Migration {
                version: 2,
                name: "later",
                sql: RUNG_TWO,
            },
        ]
    }

    /// A founded vault backed up to a store whose head names it; the keys that restore it.
    fn published(dir: &Path) -> (MemoryStore, BackupKeys, Name) {
        let keys = BackupKeys::from_root(&[0x42; 32]);
        let vault = crate::file::Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("The Household", "Ada").expect("founds");
        let state = DeviceState::open_beside(vault.path()).expect("state");
        let staging = Staging::open(dir.join("vault.staging"), 512 * 1024 * 1024).expect("staging");
        let store = MemoryStore::new("gw");
        store.set_clock_ms(2_000_000_000_000);
        state
            .add_gateway(&Gateway::paired(
                "gw".to_owned(),
                Vec::new(),
                Vec::new(),
                "gw".to_owned(),
                1,
                1,
            ))
            .expect("pairs");
        let taken = snapshot::take(
            &vault,
            &keys,
            &state,
            &staging,
            &Directory::new(Vec::new()).expect("a directory"),
            Options::at(1_800_000_000_000),
        )
        .expect("takes");
        let env = Env::new(
            &vault,
            &keys,
            &state,
            &staging,
            Policy::WIFI,
            1_800_000_000_000,
        );
        let mut scheduler =
            Scheduler::new(vec![GatewayPass::new(&env, &store).expect("a pass")], 8);
        scheduler.run(10_000).expect("runs");
        (store, keys, taken.root.name)
    }

    /// **B2.** A backup taken at rung one restores under a build whose ladder has a rung two: the
    /// restore accepts any rung the ladder knows (the caller's `Vault::open` climbs it).
    #[test]
    fn a_backup_at_an_older_rung_restores_under_a_longer_ladder() {
        let dir = tempfile::tempdir().expect("a directory");
        let (store, keys, head) = published(dir.path());
        let restore = Restore::open(&keys, &[&store], &head).expect("opens");
        let out = dir.path().join("restored.db");
        let report = restore.records_on(&two_rungs(), &out).expect("restores");
        assert_eq!(restore.root.user_version, 1);
        assert!(report.checks.iter().any(|check| check.name == "schema"));
        assert!(out.exists());
    }

    /// A backup from a newer build is a sentence that says to update, never a guess down.
    #[test]
    fn a_backup_from_a_newer_build_asks_for_an_update() {
        let dir = tempfile::tempdir().expect("a directory");
        let (store, keys, head) = published(dir.path());
        let restore = Restore::open(&keys, &[&store], &head).expect("opens");
        let out = dir.path().join("restored.db");
        let error = restore.records_on(&[], &out).expect_err("refused");
        assert!(
            matches!(
                error,
                RestoreError::NewerBuild {
                    found: 1,
                    supported: 0
                }
            ),
            "{error:?}"
        );
        assert!(error.to_string().contains("update"), "{error}");
        assert!(!out.exists(), "a refused restore leaves nothing");
    }

    /// Accepting any rung is not accepting any file: a file whose tables are not its own rung's
    /// is still refused, and nothing is left behind.
    #[test]
    fn a_file_that_is_not_its_rungs_schema_is_refused() {
        let dir = tempfile::tempdir().expect("a directory");
        let (store, keys, head) = published(dir.path());
        let restore = Restore::open(&keys, &[&store], &head).expect("opens");
        let out = dir.path().join("restored.db");
        let mut altered = two_rungs();
        altered[0].sql = "CREATE TABLE not_the_baseline (id TEXT) STRICT;";
        let error = restore.records_on(&altered, &out).expect_err("refused");
        assert!(
            matches!(error, RestoreError::SchemaMismatch { .. }),
            "{error:?}"
        );
        assert!(!out.exists());
    }
}
