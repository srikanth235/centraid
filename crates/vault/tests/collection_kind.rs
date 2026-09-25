//! A COLLECTION IS A NOTEBOOK OR AN ALBUM, AND SAYS WHICH (rung six).
//!
//! `knowledge.create_notebook` and `media.create_album` inserted the same shape
//! into `core_collection`, so Notes and Photos each read, wrote into and
//! deleted the other's rows. `contracts/migrations/006_collection_kind.sql`
//! gives the table a REQUIRED `kind`. This suite proves four things:
//!
//! 1. **The schema holds it.** A row without a kind, a kind that is neither,
//!    and a kind that changes are each refused by the file itself.
//! 2. **The commands write it and refuse the other app's id.** Filing a note
//!    into an album, adding a photograph to a notebook, and renaming or
//!    deleting the other app's collection are each a receipted refusal with
//!    its own sentence — and the refused delete leaves every row in place.
//! 3. **Names are unique per kind.** A notebook may share an album's name.
//! 4. **The rung classifies a vault written before it**, by the rule its file
//!    states, moves the other kind's entries out, and leaves a file whose
//!    `core_collection` objects are exactly what a new vault founds.

mod common;

use std::collections::BTreeMap;

use centraid_vault::Vault;
use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandOutcome, CommandStatus, Registry};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
    owner: String,
}

impl World {
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the system commands register");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        let owner: String = scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("the vault has an owner");
        Self {
            scratch,
            registry,
            owner,
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("{command} did not run: {error}"))
    }

    fn executed(&self, command: &str, input: Value) -> Value {
        let outcome = self.run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{command} answered {:?}: {:?}",
            outcome.status,
            outcome.reason
        );
        outcome.output
    }

    /// The refusal's `(predicate, sentence)`.
    fn refused(&self, command: &str, input: Value) -> (String, String) {
        let outcome = self.run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{command} was expected to refuse"
        );
        (
            outcome.predicate.unwrap_or_default(),
            outcome.reason.unwrap_or_default(),
        )
    }

    fn note(&self, title: &str) -> String {
        self.executed(
            "knowledge.create_note",
            json!({ "title": title, "body_text": "words", "format": "markdown" }),
        )["note_id"]
            .as_str()
            .expect("a note id")
            .to_owned()
    }

    fn notebook(&self, name: &str) -> String {
        self.executed("knowledge.create_notebook", json!({ "name": name }))["notebook_id"]
            .as_str()
            .expect("a notebook id")
            .to_owned()
    }

    fn album(&self, title: &str) -> String {
        self.executed("media.create_album", json!({ "title": title }))["album_id"]
            .as_str()
            .expect("an album id")
            .to_owned()
    }

    /// One photograph, inserted directly: `media.add_asset` needs a byte
    /// store, and nothing here is about bytes (`media_commands.rs` says why).
    fn photograph(&self, asset_id: &str) {
        let content_id = format!("content-{asset_id}");
        // The one hash, over stand-in bytes: no read here opens them.
        let hash = centraid_vault::content::content_digest(asset_id.as_bytes());
        self.vault()
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, content_hash, byte_size, created_at)
                     VALUES (?1, ?2, ?3, 1024, '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![content_id, format!("blob:{hash}"), hash],
                )?;
                tx.connection().execute(
                    "INSERT INTO media_asset
                       (asset_id, content_id, kind, captured_at, created_at, updated_at)
                     VALUES (?1, ?2, 'photo', '2026-01-01T00:00:00.000Z',
                             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![asset_id, content_id],
                )?;
                Ok(())
            })
            .expect("the photograph lands");
    }

    fn count(&self, sql: &str, binds: &[&str]) -> i64 {
        self.vault()
            .read(|connection| {
                let params: Vec<&dyn rusqlite::ToSql> = binds
                    .iter()
                    .map(|bind| bind as &dyn rusqlite::ToSql)
                    .collect();
                Ok(connection.query_row(sql, params.as_slice(), |row| row.get(0))?)
            })
            .expect("the count reads")
    }

    fn kind_of(&self, collection_id: &str) -> String {
        self.vault()
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT kind FROM core_collection WHERE collection_id = ?1",
                    [collection_id],
                    |row| row.get(0),
                )?)
            })
            .expect("the collection is there")
    }

    fn direct(&self, sql: &str) -> Result<(), String> {
        self.vault()
            .commit(|tx| {
                tx.set_producer("test.direct");
                tx.connection().execute_batch(sql)?;
                Ok(())
            })
            .map(drop)
            .map_err(|error| error.to_string())
    }
}

// ---------------------------------------------------------------------------
// 1. THE SCHEMA
// ---------------------------------------------------------------------------

#[test]
fn a_collection_without_a_kind_or_with_another_kind_is_refused_by_the_file() {
    let world = World::new("kind-check");
    let owner = world.owner.clone();
    let missing = world.direct(&format!(
        "INSERT INTO core_collection
           (collection_id, owner_party_id, name, sort_order, created_at, updated_at)
         VALUES ('c-none', '{owner}', 'No kind', 1, '2026-01-01', '2026-01-01')"
    ));
    assert!(
        missing
            .as_ref()
            .is_err_and(|error| error.contains("NOT NULL")),
        "{missing:?}"
    );
    let folder = world.direct(&format!(
        "INSERT INTO core_collection
           (collection_id, owner_party_id, kind, name, sort_order, created_at, updated_at)
         VALUES ('c-folder', '{owner}', 'folder', 'Folder', 1, '2026-01-01', '2026-01-01')"
    ));
    assert!(
        folder.as_ref().is_err_and(|error| error.contains("CHECK")),
        "{folder:?}"
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM core_collection", &[]),
        0,
        "neither refused row landed"
    );
}

#[test]
fn a_kind_never_changes() {
    let world = World::new("kind-immutable");
    let notebook = world.notebook("Travel");
    let moved = world.direct(&format!(
        "UPDATE core_collection SET kind = 'album' WHERE collection_id = '{notebook}'"
    ));
    assert!(
        moved
            .as_ref()
            .is_err_and(|error| error.contains("kind never changes")),
        "{moved:?}"
    );
    assert_eq!(world.kind_of(&notebook), "notebook");
    // An update that does not touch the kind is untouched by the guard.
    world
        .direct(&format!(
            "UPDATE core_collection SET kind = 'notebook', name = 'Trips'
              WHERE collection_id = '{notebook}'"
        ))
        .expect("restating the same kind is not a change");
}

// ---------------------------------------------------------------------------
// 2. THE COMMANDS
// ---------------------------------------------------------------------------

#[test]
fn each_creating_command_writes_its_own_kind() {
    let world = World::new("kind-writers");
    let notebook = world.notebook("Travel");
    let album = world.album("Portugal");
    assert_eq!(world.kind_of(&notebook), "notebook");
    assert_eq!(world.kind_of(&album), "album");

    // And an album restored from its undo record comes back an album.
    let deleted = world.executed("media.delete_album", json!({ "album_id": album }));
    world.executed(
        "media.restore_album",
        json!({ "album_id": album, "revision_id": deleted["revision_id"] }),
    );
    assert_eq!(world.kind_of(&album), "album");

    // `sort_order` is sibling-scoped PER KIND: the second album is 2 whatever
    // the notebooks number.
    world.notebook("Recipes");
    let second = world.album("Lisbon");
    assert_eq!(
        world.count(
            "SELECT sort_order FROM core_collection WHERE collection_id = ?1",
            &[&second]
        ),
        2
    );
}

#[test]
fn notes_refuses_an_album_everywhere_it_takes_a_notebook() {
    let world = World::new("notes-refuses-album");
    let album = world.album("Portugal");
    world.photograph("asset-1");
    world.executed(
        "media.add_to_album",
        json!({ "album_id": album, "asset_id": "asset-1" }),
    );
    let note = world.note("Packing list");
    let album_sentence = "That is a Photos album, not a notebook. Notes can only use notebooks.";

    let (predicate, sentence) = world.refused(
        "knowledge.create_note",
        json!({ "title": "Filed", "body_text": "words", "notebook_id": album }),
    );
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("notebook_exists_if_given", album_sentence)
    );
    let (predicate, sentence) = world.refused(
        "knowledge.move_note",
        json!({ "note_id": note, "notebook_id": album }),
    );
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("notebook_exists_if_given", album_sentence)
    );
    let (predicate, sentence) = world.refused(
        "knowledge.rename_notebook",
        json!({ "notebook_id": album, "name": "Mine now" }),
    );
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("notebook_exists", album_sentence)
    );
    let (predicate, sentence) = world.refused(
        "knowledge.create_notebook",
        json!({ "name": "Nested", "parent_notebook_id": album }),
    );
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("parent_exists_if_given", album_sentence)
    );

    // THE DELETE THAT USED TO UNFILE EVERY PHOTOGRAPH: refused, and the album,
    // its name and its photograph's placement are all still there.
    let (predicate, sentence) =
        world.refused("knowledge.delete_notebook", json!({ "notebook_id": album }));
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("notebook_exists", album_sentence)
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection
              WHERE collection_id = ?1 AND kind = 'album' AND name = 'Portugal'",
            &[&album]
        ),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection_entry
              WHERE collection_id = ?1 AND target_type = 'media.asset'",
            &[&album]
        ),
        1
    );
    // No note was filed anywhere by the refused writes.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection_entry WHERE target_type = 'knowledge.note'",
            &[]
        ),
        0
    );
}

#[test]
fn photos_refuses_a_notebook_everywhere_it_takes_an_album() {
    let world = World::new("photos-refuses-notebook");
    let notebook = world.notebook("Travel");
    let note = world.note("Packing list");
    world.executed(
        "knowledge.move_note",
        json!({ "note_id": note, "notebook_id": notebook }),
    );
    world.photograph("asset-1");
    let notebook_sentence =
        "that is a notebook in Notes, not an album; photographs can only go into albums";

    let (predicate, sentence) = world.refused(
        "media.add_to_album",
        json!({ "album_id": notebook, "asset_id": "asset-1" }),
    );
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("album_exists", notebook_sentence)
    );
    let (predicate, sentence) = world.refused(
        "media.rename_album",
        json!({ "album_id": notebook, "title": "Mine now" }),
    );
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("album_exists", notebook_sentence)
    );
    let (predicate, sentence) =
        world.refused("media.delete_album", json!({ "album_id": notebook }));
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("album_exists", notebook_sentence)
    );

    // The notebook, its name and its note's filing are untouched.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection
              WHERE collection_id = ?1 AND kind = 'notebook' AND name = 'Travel'",
            &[&notebook]
        ),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection_entry
              WHERE collection_id = ?1 AND target_type = 'knowledge.note'",
            &[&notebook]
        ),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection_entry WHERE target_type = 'media.asset'",
            &[]
        ),
        0
    );

    // And an id that is neither keeps its own sentence.
    let (_, sentence) = world.refused(
        "media.add_to_album",
        json!({ "album_id": "no-such", "asset_id": "asset-1" }),
    );
    assert_eq!(sentence, "there is no album with that id");
}

#[test]
fn deleting_a_notebook_touches_notebook_rows_only() {
    let world = World::new("delete-isolation");
    let notebook = world.notebook("Travel");
    let album = world.album("Portugal");
    let note = world.note("Packing list");
    world.executed(
        "knowledge.move_note",
        json!({ "note_id": note, "notebook_id": notebook }),
    );
    world.photograph("asset-1");
    world.executed(
        "media.add_to_album",
        json!({ "album_id": album, "asset_id": "asset-1" }),
    );

    let output = world.executed(
        "knowledge.delete_notebook",
        json!({ "notebook_id": notebook }),
    );
    assert_eq!(output["notes_unfiled"], 1);
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
            &[&notebook]
        ),
        0
    );
    // The album and its placement are exactly as they were.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1 AND kind = 'album'",
            &[&album]
        ),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection_entry WHERE collection_id = ?1",
            &[&album]
        ),
        1
    );
}

// ---------------------------------------------------------------------------
// 3. NAMES
// ---------------------------------------------------------------------------

#[test]
fn a_notebook_may_share_an_albums_name_but_not_another_notebooks() {
    let world = World::new("names-per-kind");
    world.album("Portugal");
    let notebook = world.notebook("Portugal");
    assert_eq!(world.kind_of(&notebook), "notebook");

    let (predicate, sentence) =
        world.refused("knowledge.create_notebook", json!({ "name": "Portugal" }));
    assert_eq!(
        (predicate.as_str(), sentence.as_str()),
        ("name_unused", "You already have a notebook with that name.")
    );

    let other = world.notebook("Recipes");
    world.album("Lisbon");
    world.executed(
        "knowledge.rename_notebook",
        json!({ "notebook_id": other, "name": "Lisbon" }),
    );
    let (predicate, _) = world.refused(
        "knowledge.rename_notebook",
        json!({ "notebook_id": other, "name": "Portugal" }),
    );
    assert_eq!(predicate, "name_unused_by_owner");
}

// ---------------------------------------------------------------------------
// 4. THE RUNG, OVER A VAULT WRITTEN BEFORE IT
// ---------------------------------------------------------------------------

/// Every `core_collection` object's DDL, keyed by name.
fn collection_objects(connection: &rusqlite::Connection) -> BTreeMap<String, String> {
    let mut statement = connection
        .prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE tbl_name = 'core_collection' AND sql IS NOT NULL",
        )
        .expect("the schema reads");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the schema reads")
        .collect::<rusqlite::Result<_>>()
        .expect("the schema reads")
}

#[test]
fn the_rung_classifies_a_vault_written_before_it() {
    let world = World::new("rung-six");
    let owner = world.owner.clone();
    let fresh = world
        .vault()
        .read(|connection| Ok(collection_objects(connection)))
        .expect("the schema reads");
    let filed_note = world.note("Filed");
    let mixed_note = world.note("Mixed");
    for asset in ["asset-album", "asset-mixed", "asset-nested"] {
        world.photograph(asset);
    }
    let path = world.vault().path().to_path_buf();

    // WIND THE FILE BACK TO RUNG FIVE: the column and its guard come off, and
    // the rows below are written in the shape rung five allowed — including
    // the cross-app placements this rung ends.
    {
        let raw = rusqlite::Connection::open(&path).expect("the file opens");
        raw.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys");
        let rows = format!(
            "BEGIN;
             PRAGMA defer_foreign_keys = ON;
             DROP TRIGGER core_collection_kind_is_immutable;
             ALTER TABLE core_collection DROP COLUMN kind;
             INSERT INTO core_collection
               (collection_id, owner_party_id, name, cover_content_id,
                parent_collection_id, sort_order, created_at, updated_at)
             VALUES
               ('c-notes',  '{owner}', 'Travel',     NULL, NULL, 1, '2026-01-01', '2026-01-01'),
               ('c-photos', '{owner}', 'Portugal',   'content-asset-album', NULL, 2,
                '2026-01-01', '2026-01-01'),
               ('c-mixed',  '{owner}', 'Weekend',    NULL, NULL, 3, '2026-01-01', '2026-01-01'),
               ('c-nested', '{owner}', 'Cabins',     'content-asset-nested', 'c-notes', 1,
                '2026-01-01', '2026-01-01'),
               ('c-by-id',  '{owner}', 'Empty trip', NULL, NULL, 4, '2026-01-01', '2026-01-01'),
               ('c-by-title', '{owner}', 'Beach',    NULL, NULL, 5, '2026-01-01', '2026-01-01'),
               ('c-bare',   '{owner}', 'Someday',    NULL, NULL, 6, '2026-01-01', '2026-01-01'),
               ('c-both',   '{owner}', 'Ideas',      NULL, NULL, 7, '2026-01-01', '2026-01-01');
             INSERT INTO core_collection_entry
               (entry_id, collection_id, target_type, target_id, position, added_at)
             VALUES
               ('e-1', 'c-notes',  'knowledge.note', '{filed_note}', 1, '2026-01-01'),
               ('e-2', 'c-photos', 'media.asset',    'asset-album',  1, '2026-01-01'),
               ('e-3', 'c-mixed',  'media.asset',    'asset-mixed',  1, '2026-01-01'),
               ('e-4', 'c-mixed',  'knowledge.note', '{mixed_note}', 2, '2026-01-01'),
               ('e-5', 'c-nested', 'media.asset',    'asset-nested', 1, '2026-01-01');
             INSERT INTO agent_command_invocation
               (invocation_id, command_id, caller_id, input_json, status, requested_at)
             VALUES
               ('i-1', 'media.create_album', 'phone',
                '{{\"album_id\":\"c-by-id\",\"title\":\"Renamed since\"}}', 'executed', '2026-01-01'),
               ('i-2', 'media.create_album', 'phone',
                '{{\"title\":\"Beach\"}}', 'executed', '2026-01-01'),
               ('i-3', 'media.create_album', 'phone',
                '{{\"title\":\"Ideas\"}}', 'executed', '2026-01-01'),
               ('i-4', 'knowledge.create_notebook', 'phone',
                '{{\"name\":\"Ideas\"}}', 'executed', '2026-01-01'),
               ('i-5', 'media.create_album', 'phone',
                '{{\"title\":\"Someday\"}}', 'failed', '2026-01-01');
             PRAGMA user_version = 5;
             COMMIT;"
        );
        raw.execute_batch(&rows)
            .expect("the rung-five file is written");
    }

    // THE REAL PATH: `Vault::open` sees rung five, snapshots, and climbs.
    let migrated = Vault::open(&path).expect("the file migrates");
    assert_eq!(migrated.schema_version(), 6);
    let (kinds, entries, covers, fts, entities, orphans, objects) = migrated
        .read(|connection| {
            let kinds: BTreeMap<String, String> = connection
                .prepare("SELECT collection_id, kind FROM core_collection")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let entries: Vec<String> = connection
                .prepare("SELECT entry_id FROM core_collection_entry ORDER BY entry_id")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let covers: BTreeMap<String, Option<String>> = connection
                .prepare(
                    "SELECT collection_id, cover_content_id FROM core_collection
                      WHERE collection_id IN ('c-photos', 'c-nested')",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let fts: Vec<String> = connection
                .prepare(
                    "SELECT collection_id FROM fts_core_collection
                      WHERE fts_core_collection MATCH 'Portugal'",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let entities: i64 = connection.query_row(
                "SELECT COUNT(*) FROM core_entity
                  WHERE entity_type = 'core.collection' AND entity_id LIKE 'c-%'",
                [],
                |row| row.get(0),
            )?;
            let orphans: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_check",
                [],
                |row| row.get(0),
            )?;
            Ok((
                kinds,
                entries,
                covers,
                fts,
                entities,
                orphans,
                collection_objects(connection),
            ))
        })
        .expect("the migrated file reads");

    let expected: BTreeMap<String, String> = [
        // 3. only notes → notebook
        ("c-notes", "notebook"),
        // 2. only photographs → album
        ("c-photos", "album"),
        // 2. a photograph AND a note → album, the note leaves
        ("c-mixed", "album"),
        // 1. nested → notebook, the photograph leaves
        ("c-nested", "notebook"),
        // 4. empty, and `media.create_album` minted this id
        ("c-by-id", "album"),
        // 4. empty, and `media.create_album`'s title is this name
        ("c-by-title", "album"),
        // 5. empty with only a FAILED create_album behind it
        ("c-bare", "notebook"),
        // 4. empty, and create_notebook used this name too: notebook evidence
        //    wins over a title match
        ("c-both", "notebook"),
    ]
    .into_iter()
    .map(|(id, kind)| (id.to_owned(), kind.to_owned()))
    .collect();
    assert_eq!(kinds, expected);
    // e-4 (a note in an album) and e-5 (a photograph in a notebook) are gone;
    // the note and the photograph themselves are not.
    assert_eq!(entries, ["e-1", "e-2", "e-3"]);
    assert_eq!(
        migrated
            .read(|connection| Ok(connection.query_row(
                "SELECT (SELECT COUNT(*) FROM knowledge_note WHERE note_id = ?1)
                      + (SELECT COUNT(*) FROM media_asset WHERE asset_id = 'asset-nested')",
                [&mixed_note],
                |row| row.get::<_, i64>(0),
            )?))
            .expect("the count reads"),
        2
    );
    // An album keeps its cover; a notebook's cover that named a photograph
    // no longer filed in it is cleared.
    assert_eq!(covers["c-photos"].as_deref(), Some("content-asset-album"));
    assert_eq!(covers["c-nested"], None);
    // The rows came back WITH THEIR ROWIDS, so the name index still names the
    // right row.
    assert_eq!(fts, ["c-photos"]);
    assert_eq!(
        entities, 8,
        "every collection's entity row survived the rebuild"
    );
    assert_eq!(orphans, 0, "no foreign key dangles");
    // And the file's `core_collection` objects are exactly a new vault's.
    assert_eq!(objects, fresh);
}
