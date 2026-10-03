//! One founded vault in a scratch directory, for every test in this crate.
//!
//! `dead_code` is allowed because each integration test is its own binary and
//! compiles this whole module: a helper used by `doors.rs` and not by
//! `baseline.rs` is dead in one binary and live in another, and there is no
//! per-binary way to say so. The alternative is six copies of the same setup.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::{Result, Vault};

/// A founded vault on a deterministic clock and id sequence, removed on drop.
pub struct Scratch {
    dir: PathBuf,
    pub vault: Vault,
    /// The clock the vault was given, so a test can move it. Retention's two
    /// windows are different lengths (30 days of rows, a 14-day cursor hold),
    /// so a live cursor and an aged-out row can only coexist if time moves.
    pub clock: Arc<FixedClock>,
}

impl Scratch {
    /// A vault with the schema and nothing else.
    pub fn empty(seed: &str) -> Result<Self> {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir)?;
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )?;
        Ok(Self { dir, vault, clock })
    }

    /// A vault with its own identity and owner written.
    pub fn founded(seed: &str) -> Result<Self> {
        let scratch = Self::empty(seed)?;
        scratch.vault.found("Test", "Test Owner")?;
        Ok(scratch)
    }

    /// The same, with THE BYTE PLANE'S CONTENT STORE beside it (#1025 S3).
    ///
    /// Separate from [`Self::founded`] and deliberately so: a vault with no
    /// store refuses every binary byte, and that is a real configuration with
    /// its own behaviour worth testing — a command that silently wrote a row
    /// pointing at bytes nothing kept would pass a test that always had a
    /// store.
    ///
    /// It is **the real store**, `<vault>.bytes` behind
    /// `centraid_blobs::ContentBytes`, and not a stand-in. A device holds one
    /// content store (D-1025-S3-1), so a test fixture that attached a second
    /// kind would be testing an arrangement no device has.
    pub fn founded_with_blobs(seed: &str) -> Result<Self> {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir)?;
        let clock = Arc::new(FixedClock::frozen());
        let file = dir.join("vault.db");
        let store = centraid_blobs::ByteStore::open(file.with_extension("bytes"))
            .expect("a content store opens");
        let blobs = centraid_blobs::ContentBytes::new(store);
        let vault = Vault::create_with(
            file,
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )?
        .with_blobs(Box::new(blobs));
        vault.found("Test", "Test Owner")?;
        Ok(Self { dir, vault, clock })
    }

    /// The same store, its door reading the backup ledger beside the vault —
    /// what a phone's core attaches (#1080 ruling 6). The ledger is handed
    /// back so a test can record what the operating system's library holds.
    pub fn founded_with_library(
        seed: &str,
    ) -> Result<(
        Self,
        Arc<std::sync::Mutex<centraid_vault::backup2::ledger::Ledger>>,
    )> {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir)?;
        let clock = Arc::new(FixedClock::frozen());
        let file = dir.join("vault.db");
        let store = centraid_blobs::ByteStore::open(file.with_extension("bytes"))
            .expect("a content store opens");
        let ledger = Arc::new(std::sync::Mutex::new(
            centraid_vault::backup2::ledger::Ledger::open(
                centraid_vault::backup2::ledger::Ledger::path_for(&file),
            )
            .expect("the ledger opens"),
        ));
        let blobs = centraid_blobs::ContentBytes::new(store).with_ledger(Arc::clone(&ledger));
        let vault = Vault::create_with(
            file,
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )?
        .with_blobs(Box::new(blobs));
        vault.found("Test", "Test Owner")?;
        Ok((Self { dir, vault, clock }, ledger))
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// A path inside the scratch directory.
    #[must_use]
    pub fn join(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // A failure to clean up must not mask the assertion the test was about.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Insert a taggable note, returning its id. The cheapest replicated row with
/// a `deleted_at` lifecycle, so it serves both the tag tests and the log ones.
pub fn insert_note(vault: &Vault, title: &str) -> Result<String> {
    let note_id = vault.ids().next();
    let author: String = vault.read(|connection| {
        Ok(
            connection.query_row("SELECT self_party_id FROM core_vault LIMIT 1", [], |row| {
                row.get(0)
            })?,
        )
    })?;
    let now = vault.clock().now_text();
    let id = note_id.clone();
    let content_id = vault.ids().next();
    let body = title.to_owned();
    vault.commit(|tx| {
        tx.set_producer("test.insert_note");
        // A note's identity is separate from its bytes (#352), so the pair the
        // product writes is the pair a fixture writes: a content item, then the
        // wrapper that addresses it.
        tx.connection().execute(
            "INSERT INTO core_content_item
               (content_id, content_uri, content_hash, byte_size, creator_party_id,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params![
                content_id,
                format!("inline:{body}"),
                centraid_vault::content::content_digest(body.as_bytes()),
                body.len() as i64,
                author,
                now
            ],
        )?;
        tx.connection().execute(
            "INSERT INTO knowledge_note
               (note_id, author_party_id, title, body_content_id, format, pinned,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'markdown', 0, ?5, ?5)",
            rusqlite::params![id, author, title, content_id, now],
        )?;
        Ok(())
    })?;
    Ok(note_id)
}

/// The vault's own owner party, for a test that needs a real party id.
pub fn owner_party(vault: &Vault) -> Result<String> {
    vault.read(|connection| {
        Ok(
            connection.query_row("SELECT self_party_id FROM core_vault LIMIT 1", [], |row| {
                row.get(0)
            })?,
        )
    })
}

/// Enrol a device owned by the vault's owner.
pub fn enrol(vault: &Vault, device_id: &str, public_key: &str) -> Result<()> {
    let owner = owner_party(vault)?;
    vault.enrol_device(device_id, &owner, "Test device", "ios", public_key)
}
