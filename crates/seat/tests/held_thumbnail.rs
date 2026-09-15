//! THE GRID'S STATEMENT FILLS `thumbnail_path` FROM WHAT THIS DEVICE HOLDS
//! (#1025, D-1025-S7-20).
//!
//! The defect this closes was three layers deep and this is the bottom one: a
//! page read could not ask "are these bytes here?" at all, because the answer
//! lived only in the byte store's actor. So a photo grid drew a hundred and
//! twenty placeholders over a device holding nineteen photographs, and the one
//! surface that showed anything was Home's four-cell mosaic, which made a
//! separate byte-door trip nobody else made.
//!
//! What is asserted here is the whole of the read half: the path arrives IN the
//! row, in one statement, in the page's own order, with the thumbnail tier
//! preferred and the original as the fallback — and **a path is never handed
//! out for bytes the door would refuse**, which is the security half and the
//! one that must not be able to regress quietly.

use centraid_vault::file::Vault;
use centraid_vault::page::KeysetPage;
use centraid_vault::value::Value;

/// A replica with three photographs, two of which this device holds bytes for.
fn a_replica_holding_two_of_three(dir: &std::path::Path) -> Vault {
    let vault = Vault::create(dir.join("replica.db")).expect("a vault");
    vault.found("Test", "Owner").expect("founded");
    vault
        .apply_replica(|connection| {
            connection.execute_batch(centraid_seat::held::SEAT_BLOB_HELD_DDL)?;
            connection.execute_batch(
                "INSERT OR IGNORE INTO core_entity_kind(kind) VALUES
                   ('media.asset'),
                   ('core.content_item'),
                   ('core.content_derivative'),
                   ('core.content_representation');

                 INSERT INTO core_entity(entity_id, entity_type, created_at) VALUES
                   ('c1','core.content_item','2026-01-01T00:00:00Z'),
                   ('c2','core.content_item','2026-01-01T00:00:00Z'),
                   ('c3','core.content_item','2026-01-01T00:00:00Z'),
                   ('a1','media.asset','2026-01-01T00:00:00Z'),
                   ('a2','media.asset','2026-01-01T00:00:00Z'),
                   ('a3','media.asset','2026-01-01T00:00:00Z'),
                   ('d1','core.content_derivative','2026-01-01T00:00:00Z'),
                   ('r1','core.content_representation','2026-01-01T00:00:00Z'),
                   ('r2','core.content_representation','2026-01-01T00:00:00Z'),
                   ('r3','core.content_representation','2026-01-01T00:00:00Z');

                 INSERT INTO core_content_item
                   (content_id, content_uri, content_hash, byte_size, created_at) VALUES
                   ('c1','blob:blake3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','9','2026-01-01T00:00:00Z'),
                   ('c2','blob:blake3-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','9','2026-01-01T00:00:00Z'),
                   ('c3','blob:blake3-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','9','2026-01-01T00:00:00Z');

                 INSERT INTO core_content_representation
                   (representation_id, content_id, owner_type, owner_id, media_type, created_at)
                   VALUES
                   ('r1','c1','media.asset','a1','image/jpeg','2026-01-01T00:00:00Z'),
                   ('r2','c2','media.asset','a2','image/jpeg','2026-01-01T00:00:00Z'),
                   ('r3','c3','media.asset','a3','video/mp4','2026-01-01T00:00:00Z');

                 -- A1 HAS A THUMBNAIL DERIVATIVE and its own original: the tier
                 -- is what must win, so the two hashes are different files.
                 INSERT INTO core_content_derivative
                   (derivative_id, content_id, variant, content_hash, media_type,
                    byte_size, created_at, updated_at) VALUES
                   ('d1','c1','thumb','1111111111111111111111111111111111111111111111111111111111111111','image/jpeg',9,
                    '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');

                 INSERT INTO media_asset
                   (asset_id, content_id, kind, captured_at, created_at, updated_at) VALUES
                   ('a1','c1','photo','2026-03-01T00:00:00Z',
                    '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
                   ('a2','c2','photo','2026-02-01T00:00:00Z',
                    '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
                   ('a3','c3','video','2026-01-01T00:00:00Z',
                    '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');",
            )?;
            Ok(())
        })
        .expect("the fixture builds");
    vault
}

/// One `(asset_id, thumbnail_path)` per row, in the page's order.
fn page(vault: &Vault) -> Vec<(String, Option<String>)> {
    let answer = vault
        .keyset_page(&KeysetPage {
            name: "photos.grid.live".to_owned(),
            select: vec!["asset_id".to_owned(), "captured_at".to_owned()],
            from: "media_asset".to_owned(),
            predicate: Some("deleted_at IS NULL AND archived_at IS NULL".to_owned()),
            binds: Vec::new(),
            sort_column: "captured_at".to_owned(),
            pk_column: "asset_id".to_owned(),
            descending: true,
            limit: 50,
            after: None,
            held_thumbnail: true,
            note_body: false,
        })
        .expect("the page serves");
    answer
        .rows
        .iter()
        .map(|row| {
            let id = match row.get("asset_id") {
                Some(Value::Text(text)) => text.clone(),
                other => panic!("an asset id is text, got {other:?}"),
            };
            let path = match row.get("thumbnail_path") {
                Some(Value::Text(text)) => Some(text.clone()),
                _ => None,
            };
            (id, path)
        })
        .collect()
}

fn hold(vault: &Vault, hash: &str, path: &str) {
    centraid_seat::held::record(
        &vault_connection(vault),
        &[centraid_seat::HeldBlob {
            hash: hash.to_owned(),
            path: path.to_owned(),
            byte_size: 9,
        }],
        "2026-03-02T00:00:00Z",
    )
    .expect("the row is recorded");
}

/// `apply_replica` is the one writable door and it hands out a `&Connection`
/// for the duration; the seat's writers take exactly that.
fn vault_connection(vault: &Vault) -> rusqlite::Connection {
    // A SECOND CONNECTION ON THE SAME FILE, for the test only: the seat's
    // writers take a `&Connection` and `apply_replica` will not lend one past
    // its closure. Nothing else is reading while this runs.
    let path = vault.path().to_owned();
    let connection = rusqlite::Connection::open(path).expect("the file reopens");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("keys on");
    connection
}

#[test]
fn a_cell_draws_the_thumbnail_tier_when_one_has_landed() {
    let dir = tempfile::tempdir().expect("a directory");
    let vault = a_replica_holding_two_of_three(dir.path());

    // NOTHING HELD: every cell is honest about having no file.
    assert_eq!(
        page(&vault),
        vec![
            ("a1".to_owned(), None),
            ("a2".to_owned(), None),
            ("a3".to_owned(), None),
        ]
    );

    // THE THUMB DERIVATIVE'S BYTES LAND. `11` and not `aa`: the tier is what a
    // grid wants, and the original is only the fallback.
    hold(
        &vault,
        "1111111111111111111111111111111111111111111111111111111111111111",
        "/store/data/1111111111111111111111111111111111111111111111111111111111111111.data",
    );
    // AND THE SECOND PHOTOGRAPH HAS NO DERIVATIVE AT ALL — which is every vault
    // seeded from originals, so the fallback is what makes this feature visible
    // on the only libraries that exist today.
    hold(
        &vault,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "/store/data/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.data",
    );

    assert_eq!(
        page(&vault),
        vec![
            ("a1".to_owned(), Some("/store/data/1111111111111111111111111111111111111111111111111111111111111111.data".to_owned())),
            ("a2".to_owned(), Some("/store/data/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.data".to_owned())),
            // A VIDEO'S ORIGINAL IS NOT A FRAME and no bytes of it are here
            // anyway. Two reasons, one cell, and the grid says so in its own
            // words rather than drawing a broken image.
            ("a3".to_owned(), None),
        ]
    );
}

/// THE SECURITY HALF. The byte door refuses to call a video original or an SVG
/// embeddable; the seat writes that refusal into the row where the path is
/// produced, and this proves the read cannot hand one out anyway.
#[test]
fn bytes_the_door_would_refuse_are_held_and_never_handed_out() {
    let dir = tempfile::tempdir().expect("a directory");
    let vault = a_replica_holding_two_of_three(dir.path());

    // The video's own bytes are on this device — the row is the truth about
    // the bytes — and the cell still gets nothing.
    hold(
        &vault,
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "/store/data/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.data",
    );
    let rows = page(&vault);
    assert_eq!(rows.last(), Some(&("a3".to_owned(), None)), "{rows:?}");

    // And the row IS there, so this is a refusal and not an absence.
    let held: i64 = vault
        .read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT drawable FROM seat_blob_held WHERE content_hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(-1))
        })
        .expect("the table answers");
    assert_eq!(held, 0);
}

/// ONE ROW PER ASSET, whatever its derivatives. A `LEFT JOIN` through
/// `core_content_derivative` would multiply the page — and a keyset cursor read
/// off a duplicated row is a grid that pages over itself.
#[test]
fn a_second_derivative_does_not_duplicate_a_cell() {
    let dir = tempfile::tempdir().expect("a directory");
    let vault = a_replica_holding_two_of_three(dir.path());
    vault
        .apply_replica(|connection| {
            connection.execute_batch(
                "INSERT INTO core_entity(entity_id, entity_type, created_at)
                   VALUES ('d2','core.content_derivative','2026-01-01T00:00:00Z');
                 INSERT INTO core_content_derivative
                   (derivative_id, content_id, variant, content_hash, media_type,
                    byte_size, created_at, updated_at)
                   VALUES ('d2','c1','preview','2222222222222222222222222222222222222222222222222222222222222222','image/jpeg',9,
                           '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');",
            )?;
            Ok(())
        })
        .expect("a second derivative lands");
    hold(
        &vault,
        "1111111111111111111111111111111111111111111111111111111111111111",
        "/store/data/1111111111111111111111111111111111111111111111111111111111111111.data",
    );

    let rows = page(&vault);
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!(
        rows[0],
        (
            "a1".to_owned(),
            Some(
                "/store/data/1111111111111111111111111111111111111111111111111111111111111111.data"
                    .to_owned()
            )
        )
    );
}
