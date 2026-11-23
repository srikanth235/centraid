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

/// The greatest `(epoch, generation, writes)` of the heads the gateways answered: the one to
/// restore. A gateway that answered nothing is not in the list.
#[must_use]
pub fn pick_head(heads: &[(String, Head)]) -> Option<&(String, Head)> {
    heads
        .iter()
        .max_by_key(|(_, head)| (head.epoch, head.generation, head.writes))
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
        this.root = root;
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

    /// Write the vault's pages to `path`, verify them and say what held. After this the vault
    /// opens.
    ///
    /// # Errors
    /// A range no gateway supplies or that will not open; a failed check, named.
    pub fn records(&self, path: &Path) -> Result<RecordsReport> {
        let ranges = tree::ranges_of(self, &self.root)?;
        let total = self.root.page_size * self.root.page_count;
        if ranges.len() as u64 != self.root.range_count() {
            return Err(failure(
                "ranges",
                "the tree names a different number of ranges",
            ));
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
                return Err(failure(
                    "ranges",
                    format!("range {index} is {} bytes", bytes.len()),
                ));
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
                return Err(failure(
                    "db_hash",
                    "the pages are not the ones the root hashed",
                ));
            }
            checks.push(Check { name: "db_hash" });
        }
        let connection = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        crate::file::quick_check(&connection).map_err(|error| failure("integrity_check", error))?;
        checks.push(Check {
            name: "integrity_check",
        });
        let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let page_count: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        if u64::try_from(page_size).ok() != Some(self.root.page_size)
            || u64::try_from(page_count).ok() != Some(self.root.page_count)
        {
            return Err(failure("header", "the file's size is not the root's"));
        }
        checks.push(Check { name: "header" });
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if u64::try_from(version).ok() != Some(self.root.user_version) {
            return Err(failure("schema", "the user_version is not the root's"));
        }
        checks.push(Check { name: "schema" });
        let census: BTreeMap<String, u64> = crate::pagesource::census_of(&connection)?
            .into_iter()
            .map(|(table, rows)| (table, u64::try_from(rows).unwrap_or(0)))
            .collect();
        if census != self.root.census {
            return Err(failure(
                "census",
                "the rows are not the ones the root counted",
            ));
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
    ) -> Result<(RecordsReport, MediaReport, MediaReport)> {
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
pub fn check(keys: &BackupKeys, store: &dyn Store, scratch: &Path) -> Result<CheckReport> {
    let head = store
        .head()?
        .ok_or_else(|| invariant("the gateway holds no head to check"))?;
    let restore = Restore::open(keys, &[store], &head.name)?;
    std::fs::create_dir_all(scratch)?;
    let outcome = (|| -> Result<CheckReport> {
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
