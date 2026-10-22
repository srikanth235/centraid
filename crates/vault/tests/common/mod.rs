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
        let dir = centraid_ontology::scratch::scratch_dir();
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
        let dir = centraid_ontology::scratch::scratch_dir();
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
        Arc<std::sync::Mutex<centraid_vault::backup::ledger::Ledger>>,
    )> {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir)?;
        let clock = Arc::new(FixedClock::frozen());
        let file = dir.join("vault.db");
        let store = centraid_blobs::ByteStore::open(file.with_extension("bytes"))
            .expect("a content store opens");
        let ledger = Arc::new(std::sync::Mutex::new(
            centraid_vault::backup::ledger::Ledger::open(
                centraid_vault::backup::ledger::Ledger::path_for(&file),
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

/// Insert a note, returning its id: an entity and its kind row, written as a
/// command would, through the commit guard.
pub fn insert_note(vault: &Vault, title: &str) -> Result<String> {
    let id = vault.ids().next();
    let now = vault.clock().now_text();
    vault.commit(|tx| {
        tx.set_producer("test.insert_note");
        tx.insert_entity(&id, centraid_vault::model::Kind::Note, title, &now)?;
        tx.connection().execute(
            "INSERT INTO note (id, body) VALUES (?1, ?2)",
            rusqlite::params![id, format!("the body of {title}")],
        )?;
        Ok(())
    })?;
    Ok(id)
}

/// Insert a person (an entity and its kind row) inside a commit, as a command
/// would.
pub fn add_person(tx: &centraid_vault::CommitTx<'_>, id: &str, name: &str, at: &str) -> Result<()> {
    tx.insert_entity(id, centraid_vault::model::Kind::Person, name, at)?;
    tx.connection()
        .execute("INSERT INTO person (id) VALUES (?1)", [id])?;
    Ok(())
}

/// The vault's own self person, for a test that needs a real person id.
pub fn self_person(vault: &Vault) -> Result<String> {
    Ok(vault.self_id()?.expect("a founded vault has a self person"))
}

/// A credential-shaped canary planted in a private table, the Locker's key row, which a
/// founded vault holds none of until the member unlocks. Written raw: the canary is bytes to
/// look for in a file and a copy, not a key anything opens. (It was an `access_device_secret`
/// row until the device tables left the baseline with the gateway's allowlist, #1080.)
pub fn plant_canary(vault: &Vault, canary: &str) -> Result<()> {
    let now = vault.clock().now_text();
    vault.commit(|tx| {
        tx.set_producer("test.plant_canary");
        tx.connection().execute(
            "INSERT INTO locker_key (key_id, created_at) VALUES (?1, ?2)",
            rusqlite::params![canary, now],
        )?;
        Ok(())
    })?;
    Ok(())
}
