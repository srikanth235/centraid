//! THE `media` SCHEMA, END TO END, against a real founded vault.
//!
//! `commands.rs` proves the gate order over `core.add_party`; this proves the
//! twenty `media.*` commands and the one `enrich.*` one do what Photos'
//! eighteen actions need them to do (#1020, wave 4 lane Photos).
//!
//! **One `Vault::open` per test, and the reason is lane X3's bug**: `Vault::open`
//! restarts `SeededIds`, so the first write after a reopen collides with the
//! first write of the previous session. Every test here founds its own vault
//! once and never reopens it, which sidesteps the collision without depending
//! on the fix; when X3 lands, nothing here has to change.
//!
//! The asset rows are inserted directly rather than through
//! `media.add_asset`, which is registered and refuses: moving bytes needs a
//! blob door on `CommandCtx` (see that module's header). Everything a member
//! does to a photograph AFTER it is in the library is exercised through the
//! real command path.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};

/// The registry this build serves.
fn registry() -> Registry {
    Registry::with_system_commands().expect("the system commands register")
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
    owner: String,
}

impl World {
    /// A founded vault with the registry installed and one photograph in it.
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = registry();
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

    /// Insert one photograph and its bytes. See the module note on why this is
    /// not `media.add_asset`.
    fn photograph(&self, asset_id: &str, captured_at: &str) {
        let content_id = format!("content-{asset_id}");
        // Sixty-four hex characters, because the column's CHECK says so
        // (#996, R21): a hash is a shape, not a string.
        let sha = format!(
            "{:0>64}",
            asset_id
                .bytes()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, sha256, byte_size, created_at)
                     VALUES (?1, ?2, ?3, 1024, ?4)",
                    rusqlite::params![
                        content_id,
                        format!("blob:{sha}"),
                        sha,
                        "2026-01-01T00:00:00.000Z"
                    ],
                )?;
                tx.connection().execute(
                    "INSERT INTO media_asset
                       (asset_id, content_id, kind, captured_at, created_at, updated_at)
                     VALUES (?1, ?2, 'photo', ?3, ?4, ?4)",
                    rusqlite::params![
                        asset_id,
                        content_id,
                        captured_at,
                        "2026-01-01T00:00:00.000Z"
                    ],
                )?;
                Ok(())
            })
            .expect("the photograph lands");
    }

    fn run(
        &self,
        command: &str,
        input: serde_json::Value,
    ) -> centraid_vault::commands::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("{command} did not run: {error}"))
    }

    fn executed(&self, command: &str, input: serde_json::Value) -> serde_json::Value {
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

    fn refused(&self, command: &str, input: serde_json::Value) -> String {
        let outcome = self.run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{command} was expected to refuse"
        );
        outcome.reason.unwrap_or_default()
    }

    fn count(&self, sql: &str, id: &str) -> i64 {
        self.scratch
            .vault
            .read(|connection| Ok(connection.query_row(sql, [id], |row| row.get(0))?))
            .expect("the count reads")
    }

    fn text(&self, sql: &str, id: &str) -> Option<String> {
        self.scratch
            .vault
            .read(|connection| Ok(connection.query_row(sql, [id], |row| row.get(0)).ok()))
            .expect("the read runs")
            .flatten()
    }
}

// ---------------------------------------------------------------------------
// Albums: the ordered curation, and its undo.
// ---------------------------------------------------------------------------

#[test]
fn an_album_is_created_filled_covered_deleted_and_restored_with_its_order() {
    let world = World::new("album-lifecycle");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    world.photograph("asset-2", "2026-03-01T11:00:00.000Z");

    let album = world.executed(
        "media.create_album",
        serde_json::json!({ "title": "Tahoe scouting" }),
    );
    let album_id = album["album_id"].as_str().expect("an id").to_owned();

    // The FIRST photograph into a coverless album becomes its cover.
    world.executed(
        "media.add_to_album",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-1" }),
    );
    assert_eq!(
        world.text(
            "SELECT cover_content_id FROM core_collection WHERE collection_id = ?1",
            &album_id
        ),
        Some("content-asset-1".to_owned())
    );
    let second = world.executed(
        "media.add_to_album",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-2" }),
    );
    assert_eq!(second["position"], serde_json::json!(1));

    // A second add of the same photograph is a RECEIPTED REFUSAL, not a
    // constraint name.
    let reason = world.refused(
        "media.add_to_album",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-1" }),
    );
    assert!(reason.contains("already in this album"), "{reason}");

    world.executed(
        "media.set_album_cover",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-2" }),
    );
    world.executed(
        "media.rename_album",
        serde_json::json!({ "album_id": album_id, "title": "Tahoe, September" }),
    );

    // DELETE RECORDS THE UNDO, and the undo carries the ORDER.
    let deleted = world.executed(
        "media.delete_album",
        serde_json::json!({ "album_id": album_id }),
    );
    let revision_id = deleted["revision_id"]
        .as_str()
        .expect("a revision")
        .to_owned();
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
            &album_id
        ),
        0
    );
    // The PHOTOGRAPHS are untouched: a curation went, not a library.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
            "asset-1"
        ),
        1
    );

    world.executed(
        "media.restore_album",
        serde_json::json!({ "album_id": album_id, "revision_id": revision_id }),
    );
    let entries: Vec<(String, i64)> = world
        .scratch
        .vault
        .read(|connection| {
            let mut statement = connection.prepare(
                "SELECT target_id, position FROM core_collection_entry
                  WHERE collection_id = ?1 ORDER BY position",
            )?;
            let rows = statement.query_map([&album_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .expect("the entries read");
    assert_eq!(
        entries,
        vec![("asset-1".to_owned(), 0), ("asset-2".to_owned(), 1)],
        "the order came back with the membership"
    );
    assert_eq!(
        world.text(
            "SELECT name FROM core_collection WHERE collection_id = ?1",
            &album_id
        ),
        Some("Tahoe, September".to_owned()),
        "the restore replays the title the delete captured"
    );

    // A used undo record cannot restore twice.
    let reason = world.refused(
        "media.restore_album",
        serde_json::json!({ "album_id": album_id, "revision_id": revision_id }),
    );
    assert!(reason.contains("already"), "{reason}");
}

#[test]
fn a_cover_that_leaves_the_album_hands_off_to_the_next_member() {
    let world = World::new("cover-handoff");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    world.photograph("asset-2", "2026-03-01T11:00:00.000Z");
    let album_id =
        world.executed("media.create_album", serde_json::json!({ "title": "Roll" }))["album_id"]
            .as_str()
            .expect("an id")
            .to_owned();
    for asset in ["asset-1", "asset-2"] {
        world.executed(
            "media.add_to_album",
            serde_json::json!({ "album_id": album_id, "asset_id": asset }),
        );
    }
    world.executed(
        "media.remove_from_album",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-1" }),
    );
    assert_eq!(
        world.text(
            "SELECT cover_content_id FROM core_collection WHERE collection_id = ?1",
            &album_id
        ),
        Some("content-asset-2".to_owned())
    );
    // Removing a NON-cover leaves the cover alone.
    world.executed(
        "media.add_to_album",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-1" }),
    );
    world.executed(
        "media.remove_from_album",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-1" }),
    );
    assert_eq!(
        world.text(
            "SELECT cover_content_id FROM core_collection WHERE collection_id = ?1",
            &album_id
        ),
        Some("content-asset-2".to_owned())
    );
}

#[test]
fn a_seat_minted_album_id_is_honoured_and_a_taken_one_is_refused() {
    let world = World::new("minted-album");
    let output = world.executed(
        "media.create_album",
        serde_json::json!({ "album_id": "album-from-the-phone", "title": "Trip" }),
    );
    assert_eq!(
        output["album_id"],
        serde_json::json!("album-from-the-phone")
    );
    let reason = world.refused(
        "media.create_album",
        serde_json::json!({ "album_id": "album-from-the-phone", "title": "Trip again" }),
    );
    assert!(reason.contains("already exists"), "{reason}");
}

// ---------------------------------------------------------------------------
// The star, the archive, and the trashed-asset door.
// ---------------------------------------------------------------------------

#[test]
fn the_star_is_a_tag_and_setting_it_twice_leaves_one_row() {
    let world = World::new("star");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    for _ in 0..2 {
        world.executed(
            "media.set_favorite",
            serde_json::json!({ "asset_id": "asset-1", "favorite": 1 }),
        );
    }
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_type = 'media.asset' AND target_id = ?1",
            "asset-1"
        ),
        1,
        "the star is one row in one place"
    );
    // And there is no `favorite` column to disagree with it.
    let columns: Vec<String> = world
        .scratch
        .vault
        .read(|connection| {
            let mut statement = connection.prepare("PRAGMA table_info(media_asset)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .expect("the columns read");
    assert!(!columns.contains(&"favorite".to_owned()));

    world.executed(
        "media.set_favorite",
        serde_json::json!({ "asset_id": "asset-1", "favorite": 0 }),
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_type = 'media.asset' AND target_id = ?1",
            "asset-1"
        ),
        0
    );
}

/// A TRASHED ASSET IS NOT EDITABLE (#916, adversarial BUG-7). Both flag
/// commands, because the bug was in both.
#[test]
fn a_trashed_photograph_can_be_neither_starred_nor_archived() {
    let world = World::new("trashed-flags");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    world.executed(
        "media.delete_asset",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    for (command, field) in [
        ("media.set_favorite", "favorite"),
        ("media.set_archived", "archived"),
    ] {
        let reason = world.refused(
            command,
            serde_json::json!({ "asset_id": "asset-1", field: 1 }),
        );
        assert!(reason.contains("in the trash"), "{command}: {reason}");
    }
}

#[test]
fn archiving_hides_a_photograph_without_trashing_it() {
    let world = World::new("archive");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    world.executed(
        "media.set_archived",
        serde_json::json!({ "asset_id": "asset-1", "archived": 1 }),
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_asset
              WHERE asset_id = ?1 AND archived_at IS NOT NULL AND deleted_at IS NULL",
            "asset-1"
        ),
        1
    );
    world.executed(
        "media.set_archived",
        serde_json::json!({ "asset_id": "asset-1", "archived": 0 }),
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1 AND archived_at IS NULL",
            "asset-1"
        ),
        1
    );
}

#[test]
fn one_edit_command_moves_the_title_the_time_the_star_and_the_archive_together() {
    let world = World::new("update-asset");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    world.executed(
        "media.update_asset",
        serde_json::json!({
            "asset_id": "asset-1",
            "title": "Dusk over the west shore",
            "captured_at": "2026-03-02T20:00:00.000Z",
            "favorite": 1
        }),
    );
    assert_eq!(
        world.text(
            "SELECT title FROM media_asset WHERE asset_id = ?1",
            "asset-1"
        ),
        Some("Dusk over the west shore".to_owned())
    );
    assert_eq!(
        world.text(
            "SELECT captured_at FROM media_asset WHERE asset_id = ?1",
            "asset-1"
        ),
        Some("2026-03-02T20:00:00.000Z".to_owned())
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_type = 'media.asset' AND target_id = ?1",
            "asset-1"
        ),
        1
    );
    // THE AUTHORED TITLE IS THE ASSET'S (#996, R20(b)): the shared byte row
    // has no title column to overwrite.
    let content_columns: Vec<String> = world
        .scratch
        .vault
        .read(|connection| {
            let mut statement = connection.prepare("PRAGMA table_info(core_content_item)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .expect("the columns read");
    assert!(!content_columns.contains(&"title".to_owned()));
}

// ---------------------------------------------------------------------------
// Trash, restore, purge.
// ---------------------------------------------------------------------------

#[test]
fn trashing_a_photograph_drops_its_album_entries_and_releases_unrented_bytes() {
    let world = World::new("trash");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    world.photograph("asset-2", "2026-03-01T11:00:00.000Z");
    let album_id =
        world.executed("media.create_album", serde_json::json!({ "title": "Roll" }))["album_id"]
            .as_str()
            .expect("an id")
            .to_owned();
    // `asset-1` becomes the cover, so `asset-2`'s bytes are rented by nothing
    // but `asset-2` itself — which is the case that can be released.
    for asset in ["asset-1", "asset-2"] {
        world.executed(
            "media.add_to_album",
            serde_json::json!({ "album_id": album_id, "asset_id": asset }),
        );
    }

    let output = world.executed(
        "media.delete_asset",
        serde_json::json!({ "asset_id": "asset-2" }),
    );
    assert_eq!(output["content_released"], serde_json::json!(1));
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection_entry WHERE target_id = ?1",
            "asset-2"
        ),
        0,
        "album membership does not survive the trash"
    );
    // The grace window is thirty days, on the asset's own row (#274).
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_asset
              WHERE asset_id = ?1 AND deleted_at IS NOT NULL AND purge_at IS NOT NULL",
            "asset-2"
        ),
        1
    );
    // A SECOND delete fails loudly rather than re-stamping the window.
    let reason = world.refused(
        "media.delete_asset",
        serde_json::json!({ "asset_id": "asset-2" }),
    );
    assert!(reason.contains("already in the trash"), "{reason}");

    // Restore brings the bytes back and NOT the album membership.
    world.executed(
        "media.restore_asset",
        serde_json::json!({ "asset_id": "asset-2" }),
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_asset a JOIN core_content_item c
                ON c.content_id = a.content_id
              WHERE a.asset_id = ?1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL",
            "asset-2"
        ),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_collection_entry WHERE target_id = ?1",
            "asset-2"
        ),
        0
    );
}

/// Bytes a SECOND asset still rents do not soft-delete. The reference list is
/// the registry's, and this is the case it exists for.
#[test]
fn bytes_another_photograph_still_rents_are_not_released() {
    let world = World::new("shared-bytes");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    // A second asset over the SAME content item is refused by the UNIQUE
    // constraint, so the second renter is an album cover instead — which is
    // exactly the registry entry a port would forget.
    let album_id =
        world.executed("media.create_album", serde_json::json!({ "title": "Roll" }))["album_id"]
            .as_str()
            .expect("an id")
            .to_owned();
    world.executed(
        "media.add_to_album",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-1" }),
    );
    // The cover is set and the entry is removed, so the cover is the LAST
    // reference the asset does not hold.
    world.executed(
        "media.set_album_cover",
        serde_json::json!({ "album_id": album_id, "asset_id": "asset-1" }),
    );
    let output = world.executed(
        "media.delete_asset",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    assert_eq!(
        output["content_released"],
        serde_json::json!(0),
        "the album's cover still rents these bytes"
    );
}

#[test]
fn purging_refuses_a_live_photograph_and_one_an_edited_copy_still_names() {
    let world = World::new("purge-doors");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    let reason = world.refused(
        "media.purge_asset",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    assert!(reason.contains("already in the trash"), "{reason}");

    world.photograph("asset-2", "2026-03-02T10:00:00.000Z");
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "UPDATE media_asset SET source_asset_id = 'asset-1' WHERE asset_id = 'asset-2'",
                [],
            )?;
            Ok(())
        })
        .expect("the lineage lands");
    world.executed(
        "media.delete_asset",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    let reason = world.refused(
        "media.purge_asset",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    assert!(reason.contains("edited copy"), "{reason}");
}

#[test]
fn purging_destroys_the_row_its_faces_and_every_pointer_at_it() {
    let world = World::new("purge");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    world.executed(
        "core.tag_item",
        serde_json::json!({
            "subject_type": "media.asset", "subject_id": "asset-1", "label": "sunset"
        }),
    );
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "INSERT INTO media_asset_phash (asset_id, phash, computed_at)
                 VALUES ('asset-1', '3727170f8b494d6e', '2026-03-01T10:00:00.000Z')",
                [],
            )?;
            tx.connection().execute(
                "INSERT INTO media_face_region
                   (region_id, asset_id, bbox_json, review_state, created_at, updated_at)
                 VALUES ('region-1', 'asset-1', '{\"x\":0,\"y\":0,\"w\":1,\"h\":1}',
                         'proposed', '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("the derived rows land");

    world.executed(
        "media.delete_asset",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    let output = world.executed(
        "media.purge_asset",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    assert_eq!(output["content_released"], serde_json::json!(1));
    // THE WHOLE POSTCONDITION, restated as the test's own claim.
    for (table, column) in [
        ("media_asset", "asset_id"),
        ("media_face_region", "asset_id"),
        ("media_asset_phash", "asset_id"),
    ] {
        assert_eq!(
            world.count(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
                "asset-1"
            ),
            0,
            "{table} still names the purged photograph"
        );
    }
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_type = 'media.asset' AND target_id = ?1",
            "asset-1"
        ),
        0
    );
    // The bytes were handed to the sweep: the grace window collapsed to NOW,
    // not to thirty days out — a purge is not a second trip through the trash.
    let purge_at = world
        .text(
            "SELECT purge_at FROM core_content_item WHERE content_id = ?1",
            "content-asset-1",
        )
        .expect("the bytes carry a purge date");
    let deleted_at = world
        .text(
            "SELECT deleted_at FROM core_content_item WHERE content_id = ?1",
            "content-asset-1",
        )
        .expect("the bytes carry a delete date");
    assert_eq!(purge_at, deleted_at);
}

// ---------------------------------------------------------------------------
// Places.
// ---------------------------------------------------------------------------

fn insert_place(world: &World, place_id: &str, name: &str) {
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "INSERT INTO core_place
                   (place_id, name, geo_lat, geo_lng, address_json, created_at, updated_at)
                 VALUES (?1, ?2, 39.0021, -120.1131, ?3, ?4, ?4)",
                rusqlite::params![
                    place_id,
                    name,
                    r#"{"street":"the member's own address"}"#,
                    "2026-01-01T00:00:00.000Z"
                ],
            )?;
            Ok(())
        })
        .expect("the place lands");
}

#[test]
fn setting_and_clearing_a_place_are_the_same_command() {
    let world = World::new("set-place");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    insert_place(&world, "place-1", "39.0021, -120.1131");
    world.executed(
        "media.set_asset_place",
        serde_json::json!({ "asset_id": "asset-1", "place_id": "place-1" }),
    );
    assert_eq!(
        world.text(
            "SELECT place_id FROM media_asset WHERE asset_id = ?1",
            "asset-1"
        ),
        Some("place-1".to_owned())
    );
    // An OMITTED place_id CLEARS it.
    world.executed(
        "media.set_asset_place",
        serde_json::json!({ "asset_id": "asset-1" }),
    );
    assert_eq!(
        world.text(
            "SELECT place_id FROM media_asset WHERE asset_id = ?1",
            "asset-1"
        ),
        None
    );
    // There is no app-plane command that mints a place.
    let reason = world.refused(
        "media.set_asset_place",
        serde_json::json!({ "asset_id": "asset-1", "place_id": "place-nowhere" }),
    );
    assert!(reason.contains("knows no place"), "{reason}");
}

#[test]
fn naming_a_place_writes_the_name_and_leaves_the_derived_address_alone() {
    let world = World::new("name-place");
    insert_place(&world, "place-1", "39.0021, -120.1131");
    // The machine half runs first, as the automation would.
    world.executed(
        "media.set_place_gazetteer",
        serde_json::json!({
            "place_id": "place-1",
            "name": "Tahoe City, CA",
            "country": "US",
            "distance_km": 4.2,
            "source": "geonames-cities15000"
        }),
    );
    // Then the member names it.
    world.executed(
        "media.name_place",
        serde_json::json!({ "place_id": "place-1", "name": "  The cabin  ", "kind": "home" }),
    );
    assert_eq!(
        world.text("SELECT name FROM core_place WHERE place_id = ?1", "place-1"),
        Some("The cabin".to_owned()),
        "the name is trimmed"
    );
    assert_eq!(
        world.text("SELECT kind FROM core_place WHERE place_id = ?1", "place-1"),
        Some("home".to_owned())
    );
    // THE DERIVED ADDRESS SURVIVES A RENAME, and so does the member's own.
    let address = world
        .text(
            "SELECT address_json FROM core_place WHERE place_id = ?1",
            "place-1",
        )
        .expect("an address document");
    let parsed: serde_json::Value = serde_json::from_str(&address).expect("JSON");
    assert_eq!(
        parsed["gazetteer"]["name"],
        serde_json::json!("Tahoe City, CA")
    );
    assert_eq!(
        parsed["street"],
        serde_json::json!("the member's own address"),
        "every other key in the document survives"
    );

    // A rename with no `kind` does not clear the declared one.
    world.executed(
        "media.name_place",
        serde_json::json!({ "place_id": "place-1", "name": "Home" }),
    );
    assert_eq!(
        world.text("SELECT kind FROM core_place WHERE place_id = ?1", "place-1"),
        Some("home".to_owned())
    );

    let reason = world.refused(
        "media.name_place",
        serde_json::json!({ "place_id": "place-1", "name": "   " }),
    );
    assert!(reason.contains("whitespace"), "{reason}");
}

/// A MISS IS A RESULT. Without the none-marker the automation re-examines every
/// mid-ocean coordinate forever.
#[test]
fn a_gazetteer_miss_is_recorded_as_a_result_and_never_touches_the_members_name() {
    let world = World::new("gazetteer-miss");
    insert_place(&world, "place-1", "The cabin");
    world.executed(
        "media.set_place_gazetteer",
        serde_json::json!({ "place_id": "place-1", "source": "geonames-cities15000" }),
    );
    let address = world
        .text(
            "SELECT address_json FROM core_place WHERE place_id = ?1",
            "place-1",
        )
        .expect("an address document");
    let parsed: serde_json::Value = serde_json::from_str(&address).expect("JSON");
    assert_eq!(parsed["gazetteer"]["none"], serde_json::json!(true));
    assert!(parsed["gazetteer"]["checked_at"].is_string());
    assert_eq!(
        world.text("SELECT name FROM core_place WHERE place_id = ?1", "place-1"),
        Some("The cabin".to_owned()),
        "the machine half never writes the member's name"
    );
}

// ---------------------------------------------------------------------------
// The face queue's one writer, and forgetting a person.
// ---------------------------------------------------------------------------

fn insert_region(world: &World, region_id: &str, asset_id: &str, party_id: Option<&str>) {
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "INSERT INTO media_face_region
                   (region_id, asset_id, bbox_json, party_id, confidence, review_state,
                    created_at, updated_at)
                 VALUES (?1, ?2, '{\"x\":0,\"y\":0,\"w\":1,\"h\":1}', ?3, 0.94, 'proposed', ?4, ?4)",
                rusqlite::params![region_id, asset_id, party_id, "2026-03-01T10:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the region lands");
}

#[test]
fn the_three_answers_are_one_command_and_a_rejection_keeps_the_row() {
    let world = World::new("answer-face");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    for (index, answer) in ["confirm", "reject", "dismiss"].iter().enumerate() {
        let region_id = format!("region-{index}");
        insert_region(&world, &region_id, "asset-1", Some(&world.owner));
        let input = if *answer == "confirm" {
            serde_json::json!({
                "region_id": region_id, "answer": answer, "party_id": world.owner
            })
        } else {
            serde_json::json!({ "region_id": region_id, "answer": answer })
        };
        let output = world.executed("media.answer_face_proposal", input);
        let expected = match *answer {
            "confirm" => "confirmed",
            "reject" => "rejected",
            _ => "dismissed",
        };
        assert_eq!(output["review_state"], serde_json::json!(expected));
        // A REJECTION DOES NOT DELETE THE ROW: gone from the list is not gone
        // from the vault, and the enricher may not propose the face again.
        assert_eq!(
            world.count(
                "SELECT COUNT(*) FROM media_face_region WHERE region_id = ?1",
                &region_id
            ),
            1
        );
    }
    // A confirmed region names its confirmer; a refused one names nobody.
    assert_eq!(
        world.text(
            "SELECT confirmed_by_party_id FROM media_face_region WHERE region_id = ?1",
            "region-0"
        ),
        Some(world.owner.clone())
    );
    assert_eq!(
        world.text(
            "SELECT party_id FROM media_face_region WHERE region_id = ?1",
            "region-1"
        ),
        None
    );
}

#[test]
fn the_union_rule_refuses_a_confirm_with_no_party_and_a_reject_with_one() {
    let world = World::new("answer-union");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    insert_region(&world, "region-1", "asset-1", None);
    let reason = world.refused(
        "media.answer_face_proposal",
        serde_json::json!({ "region_id": "region-1", "answer": "confirm" }),
    );
    assert!(reason.contains("must name the person"), "{reason}");
    let reason = world.refused(
        "media.answer_face_proposal",
        serde_json::json!({
            "region_id": "region-1", "answer": "reject", "party_id": world.owner
        }),
    );
    assert!(reason.contains("name nobody"), "{reason}");
    // And a confirm naming a party this vault does not hold.
    let reason = world.refused(
        "media.answer_face_proposal",
        serde_json::json!({
            "region_id": "region-1", "answer": "confirm", "party_id": "party-nobody"
        }),
    );
    assert!(reason.contains("exists in this vault"), "{reason}");
}

/// Answering the same region twice is how a member CORRECTS THEMSELF, so the
/// second answer must land rather than be refused as a replay.
#[test]
fn a_second_answer_to_one_region_lands() {
    let world = World::new("answer-twice");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    insert_region(&world, "region-1", "asset-1", Some(&world.owner));
    world.executed(
        "media.answer_face_proposal",
        serde_json::json!({
            "region_id": "region-1", "answer": "confirm", "party_id": world.owner
        }),
    );
    world.executed(
        "media.answer_face_proposal",
        serde_json::json!({ "region_id": "region-1", "answer": "reject" }),
    );
    assert_eq!(
        world.text(
            "SELECT review_state FROM media_face_region WHERE region_id = ?1",
            "region-1"
        ),
        Some("rejected".to_owned())
    );
}

#[test]
fn forgetting_a_person_takes_every_face_that_names_them_and_nothing_else() {
    let world = World::new("forget");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    insert_region(&world, "region-1", "asset-1", Some(&world.owner));
    insert_region(&world, "region-2", "asset-1", None);
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "INSERT INTO media_face_cluster (region_id, cluster_id, computed_at)
                 VALUES ('region-1', 'region-1', '2026-03-01T10:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("the grouping lands");

    let output = world.executed(
        "media.forget_person",
        serde_json::json!({ "party_id": world.owner }),
    );
    assert_eq!(output["regions_forgotten"], serde_json::json!(1));
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_face_region WHERE region_id = ?1",
            "region-1"
        ),
        0
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_face_cluster WHERE region_id = ?1",
            "region-1"
        ),
        0,
        "the grouping goes with the region"
    );
    // The face that named NOBODY is untouched, and the PARTY survives —
    // deleting a person is `people.trash_person`, not this.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM media_face_region WHERE region_id = ?1",
            "region-2"
        ),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
            &world.owner
        ),
        1
    );

    // RETRY-SAFE: a second call finds nothing and says so.
    let output = world.executed(
        "media.forget_person",
        serde_json::json!({ "party_id": world.owner }),
    );
    assert_eq!(output["regions_forgotten"], serde_json::json!(0));
}

// ---------------------------------------------------------------------------
// The enrichment hint.
// ---------------------------------------------------------------------------

/// **A HINT IS A ROW AND NOTHING ELSE** (D-1020-P4). The recipe's walk is the
/// automations lane's, so what is asserted here is that the command moves
/// exactly one row and does not touch the policy, the cursor or the derivation
/// stamps.
#[test]
fn a_hint_is_a_row_and_nothing_else() {
    let world = World::new("enrich-hint");
    world.photograph("asset-1", "2026-03-01T10:00:00.000Z");
    let before = |table: &str| -> i64 {
        world
            .scratch
            .vault
            .read(|connection| {
                Ok(
                    connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("the count reads")
    };
    let policies = before("enrich_policy");
    let derivations = before("enrich_derivation");
    let failures = before("enrich_target_failure");

    let output = world.executed(
        "enrich.request_enrichment",
        serde_json::json!({
            "entity_type": "media.asset",
            "entity_id": "asset-1",
            "reason": "manual",
            "capability": "faces"
        }),
    );
    let request_id = output["request_id"].as_str().expect("an id").to_owned();
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM enrich_request
              WHERE request_id = ?1 AND capability = 'faces' AND drained_at IS NULL",
            &request_id
        ),
        1
    );
    assert_eq!(before("enrich_request"), 1, "one row, not a queue");
    assert_eq!(before("enrich_policy"), policies, "the policy is untouched");
    assert_eq!(before("enrich_derivation"), derivations);
    assert_eq!(before("enrich_target_failure"), failures);
}

/// THE CONSENT SCOPE. An untagged owner ask would read as consent for every
/// enricher, not the one the member chose.
#[test]
fn a_manual_ask_with_no_capability_is_refused_with_a_sentence() {
    let world = World::new("enrich-scope");
    let reason = world.refused(
        "enrich.request_enrichment",
        serde_json::json!({ "entity_type": "media.asset", "reason": "manual" }),
    );
    assert!(reason.contains("name the capability"), "{reason}");
    // A passive signal needs none: it is not an owner's answer to anything.
    world.executed(
        "enrich.request_enrichment",
        serde_json::json!({ "entity_type": "media.asset", "reason": "on-view" }),
    );
}

// ---------------------------------------------------------------------------
// The one command that is not real.
// ---------------------------------------------------------------------------

/// `media.add_asset` is REGISTERED with its real schema and refuses with a
/// TYPED error rather than panicking or writing a row with no bytes behind it.
#[test]
fn adding_an_asset_is_registered_and_refuses_rather_than_writing_a_hollow_row() {
    let world = World::new("add-asset");
    let error = world
        .scratch
        .vault
        .execute(
            &world.registry,
            &Principal::owner("phone"),
            &Command::new(
                "media.add_asset",
                serde_json::json!({ "data_uri": "data:image/png;base64,AA", "kind": "photo" }),
            ),
        )
        .expect_err("the body is not there yet");
    // A shell renders "not in this build yet" rather than losing the process.
    assert!(error.to_string().contains("no body yet"), "{error}");
    let assets: i64 = world
        .scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM media_asset", [], |row| row.get(0))?)
        })
        .expect("the count reads");
    assert_eq!(assets, 0);
    // The SCHEMA is already the contract: a malformed call is refused today
    // with the same message it will be refused with when the handler is real,
    // and it is refused BEFORE the missing body is reached.
    let outcome = world.run("media.add_asset", serde_json::json!({ "kind": "hologram" }));
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert!(
        outcome
            .reason
            .as_deref()
            .is_some_and(|reason| !reason.contains("no body yet")),
        "a malformed input must be refused by the schema, not by the missing body: {:?}",
        outcome.reason
    );
}
