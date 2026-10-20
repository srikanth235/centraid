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
        Arc<std::sync::Mutex<centraid_vault::backup::ledger::Ledger>>,
    )> {
        let dir = centraid_ontology::golden::scratch_dir();
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

/// A photograph's byte row and its asset, with the title the asset carries.
///
/// The bytes are stand-ins — the one hash over the asset id, which nothing
/// opens — as `collection_kind.rs`'s photograph is. The index row for a byte
/// row is written with it, and the asset comes after, so the byte row is
/// touched once more and the index is written again with the asset's title.
pub fn insert_photograph(vault: &Vault, asset_id: &str, title: &str) -> Result<()> {
    let content_id = format!("content-{asset_id}");
    let hash = centraid_vault::content::content_digest(asset_id.as_bytes());
    vault.commit(|tx| {
        tx.set_producer("test.insert_photograph");
        tx.connection().execute(
            "INSERT INTO core_content_item
               (content_id, content_uri, content_hash, byte_size, created_at)
             VALUES (?1, ?2, ?3, 1024, '2026-01-01T00:00:00.000Z')",
            rusqlite::params![content_id, format!("blob:{hash}"), hash],
        )?;
        tx.connection().execute(
            "INSERT INTO media_asset
               (asset_id, content_id, kind, title, captured_at, created_at, updated_at)
             VALUES (?1, ?2, 'photo', ?3, '2026-01-01T00:00:00.000Z',
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            rusqlite::params![asset_id, content_id, title],
        )?;
        tx.connection().execute(
            "UPDATE core_content_item SET byte_size = byte_size WHERE content_id = ?1",
            [&content_id],
        )?;
        Ok(())
    })?;
    Ok(())
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

/// One object's statement as rung one wrote it: the block under `-- <kind> <name>` in
/// `001_baseline.sql`, up to the blank line that ends it.
pub fn baseline_statement(kind: &str, name: &str) -> String {
    let baseline = centraid_vault::migrations::BASELINE_SQL;
    let header = format!("\n-- {kind} {name}\n");
    let at = baseline
        .find(&header)
        .unwrap_or_else(|| panic!("the baseline holds no {kind} `{name}`"));
    let body = &baseline[at + header.len()..];
    let end = body.find("\n\n").unwrap_or(body.len());
    body[..end].to_owned()
}

/// WIND A FILE BACK FROM RUNG THREE TO RUNG TWO (#1129) by undoing the rung's own statements:
/// the health tables and their touch triggers go, the seeded workout kinds and their entity rows
/// go, and `core_activity` is rebuilt to the text rung one wrote (no `updated_at`, no
/// `row_version`), every row kept, with its indexes and entity triggers as rung one wrote them.
/// The caller sets `user_version`.
pub fn undo_rung_three(connection: &rusqlite::Connection) {
    connection
        .execute_batch(
            "DROP TRIGGER health_workout_touch_updated_at;
             DROP TABLE health_workout;
             DROP TRIGGER health_daily_touch_updated_at;
             DROP TABLE health_daily;
             DELETE FROM core_concept WHERE scheme_id = 'health:workout-kinds';
             DELETE FROM core_concept_scheme WHERE scheme_id = 'health:workout-kinds';
             DELETE FROM core_entity WHERE entity_id LIKE 'health:%';
             DROP TRIGGER core_activity_touch_updated_at;
             DROP TRIGGER core_activity_entity_delete;
             DROP TRIGGER core_activity_entity_insert;
             DROP INDEX core_activity_started_page_idx;
             DROP INDEX idx_activity_actor_party;
             DROP INDEX idx_activity_kind_concept;
             DROP INDEX idx_activity_location_place;
             DROP INDEX idx_activity_source_app;
             ALTER TABLE core_activity RENAME TO core_activity_at_three;",
        )
        .expect("rung three's objects are undone");
    let mut rung_one = vec![baseline_statement("table", "core_activity")];
    rung_one.push(
        "INSERT INTO core_activity
           (activity_id, actor_party_id, kind_concept_id, started_at, ended_at,
            location_place_id, source_app_id, created_at)
         SELECT activity_id, actor_party_id, kind_concept_id, started_at, ended_at,
                location_place_id, source_app_id, created_at
           FROM core_activity_at_three;
         DROP TABLE core_activity_at_three;"
            .to_owned(),
    );
    for index in [
        "idx_activity_actor_party",
        "idx_activity_kind_concept",
        "idx_activity_location_place",
        "idx_activity_source_app",
    ] {
        rung_one.push(baseline_statement("index", index));
    }
    for trigger in ["core_activity_entity_delete", "core_activity_entity_insert"] {
        rung_one.push(baseline_statement("trigger", trigger));
    }
    connection
        .execute_batch(&rung_one.join("\n"))
        .expect("core_activity is put back as rung one wrote it");
}
