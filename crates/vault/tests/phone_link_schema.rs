//! RUNG TWO, `phone_link` (#1127): the schema holds what the commands lean on.
//!
//! 1. **The rung is a climb.** A vault founded at the head is wound back to
//!    `user_version = 1` by undoing the rung's own statements, a row the old shape let through
//!    is written, and the file is opened: it reaches 2, the row is intact and the table is
//!    there (`migrations.rs`, "A rung two is proved the way a climb is").
//! 2. **The engine holds the three rules no command can be bypassed around**: a link points at
//!    the kind its source implies, a detached link is never re-attached, and a purged row takes
//!    its link with it.
//! 3. **An origin is a real pointer (R-1127-9)**: a link's origin exists and is of the link's own
//!    source, and an origin a link names cannot be deleted.
//! 4. **The tables are not entity kinds**, so the registry the schema derives is unchanged.

mod common;

use centraid_ontology::golden::scratch_dir;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::{Result, Vault, head_version};

const NOW: &str = "2026-10-19T09:00:00.000Z";

fn party(vault: &Vault, id: &str) {
    vault
        .commit(|tx| {
            tx.set_producer("test.phone_link");
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at)
                 VALUES (?1, 'person', 'Ada', ?2)",
                rusqlite::params![id, NOW],
            )?;
            Ok(())
        })
        .expect("a party is written");
}

fn event(vault: &Vault, id: &str) {
    vault
        .commit(|tx| {
            tx.set_producer("test.phone_link");
            tx.connection().execute(
                "INSERT INTO core_event
                   (event_id, summary, dtstart, start_tz, status, sequence, created_at)
                 VALUES (?1, 'Lunch', '2026-10-20T12:00:00Z', 'UTC', 'confirmed', 0, ?2)",
                rusqlite::params![id, NOW],
            )?;
            Ok(())
        })
        .expect("an event is written");
}

fn link(vault: &Vault, link_id: &str, source: &str, phone_id: &str, entity: &str) -> Result<()> {
    vault
        .commit(|tx| {
            tx.set_producer("test.phone_link");
            tx.connection().execute(
                "INSERT OR IGNORE INTO phone_origin
               (origin_id, source, phone_origin, label, created_at)
             VALUES ('o-' || ?1, ?1, 'acct', 'Main', ?2)",
                rusqlite::params![source, NOW],
            )?;
            tx.connection().execute(
                "INSERT INTO phone_link
               (link_id, source, phone_id, origin_id, entity_id, fingerprint, last_seen_at,
                created_at)
             VALUES (?1, ?2, ?3, 'o-' || ?2, ?4, 'f1', ?5, ?5)",
                rusqlite::params![link_id, source, phone_id, entity, NOW],
            )?;
            Ok(())
        })
        .map(|_| ())
}

fn count(vault: &Vault, sql: &str) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("the count reads")
}

#[test]
fn the_rung_is_a_climb_a_file_at_one_reaches_two_with_its_rows_intact() {
    let dir = scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    {
        let vault = Vault::create_with(
            &path,
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("climb")),
        )
        .expect("a vault is founded");
        vault.found("Test", "Test Owner").expect("an owner");
        party(&vault, "p-old");
    }
    // WIND IT BACK: undo the rung's own statements, then the version.
    {
        let connection = rusqlite::Connection::open(&path).expect("the file opens");
        connection
            .execute_batch(
                "DROP TRIGGER phone_link_touch_updated_at;
                 DROP TRIGGER phone_link_purge_is_one_way;
                 DROP TRIGGER phone_link_detach_is_one_way;
                 DROP TRIGGER phone_link_kind_matches_source_update;
                 DROP TRIGGER phone_link_kind_matches_source;
                 DROP TABLE phone_link;
                 DROP TRIGGER phone_origin_touch_updated_at;
                 DROP TABLE phone_origin;
                 PRAGMA user_version = 1;",
            )
            .expect("the rung is undone");
    }
    assert_eq!(head_version(), 2);

    let vault = Vault::open(&path).expect("a file at rung one opens and climbs");
    assert_eq!(
        count(&vault, "PRAGMA user_version"),
        2,
        "the file reached the head"
    );
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM core_party WHERE party_id = 'p-old'"
        ),
        1,
        "the row the old shape let through survived"
    );
    link(&vault, "l1", "contacts", "phone-1", "p-old").expect("a link is written after the climb");
    assert_eq!(count(&vault, "SELECT COUNT(*) FROM phone_link"), 1);
    drop(vault);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_link_points_at_the_kind_its_source_implies() {
    let scratch = common::Scratch::founded("kind").expect("a vault");
    party(&scratch.vault, "p1");
    event(&scratch.vault, "e1");
    link(&scratch.vault, "l1", "contacts", "c1", "p1").expect("contacts -> party");
    link(&scratch.vault, "l2", "calendar", "k1", "e1").expect("calendar -> event");

    for (source, entity) in [("calendar", "p1"), ("files", "p1"), ("contacts", "e1")] {
        let error = link(&scratch.vault, "lx", source, "phone-x", entity)
            .expect_err("a source pointing at the wrong kind is refused");
        assert!(
            error.to_string().contains("the kind its source implies"),
            "{source} -> {entity}: {error}"
        );
    }
    // An entity that does not exist is refused too: the foreign key and the kind rule agree.
    assert!(link(&scratch.vault, "ly", "contacts", "c9", "nobody").is_err());
    // And a link cannot be moved onto the wrong kind after the fact.
    let moved = scratch.vault.commit(|tx| {
        tx.set_producer("test.phone_link");
        tx.connection().execute(
            "UPDATE phone_link SET entity_id = 'e1' WHERE link_id = 'l1'",
            [],
        )?;
        Ok(())
    });
    assert!(moved.is_err(), "a re-point onto the wrong kind is refused");
}

#[test]
fn a_phone_record_and_a_vault_row_each_have_one_link() {
    let scratch = common::Scratch::founded("unique").expect("a vault");
    party(&scratch.vault, "p1");
    party(&scratch.vault, "p2");
    link(&scratch.vault, "l1", "contacts", "c1", "p1").expect("the first link");
    assert!(
        link(&scratch.vault, "l2", "contacts", "c1", "p2").is_err(),
        "one phone record, one link"
    );
    assert!(
        link(&scratch.vault, "l3", "contacts", "c3", "p1").is_err(),
        "one vault row, one link"
    );
    // The phone's id is only unique within its source.
    event(&scratch.vault, "e1");
    link(&scratch.vault, "l4", "calendar", "c1", "e1").expect("the same id in another source");
}

#[test]
fn a_detached_link_is_never_reattached() {
    let scratch = common::Scratch::founded("detach").expect("a vault");
    party(&scratch.vault, "p1");
    link(&scratch.vault, "l1", "contacts", "c1", "p1").expect("a link");
    let set = |sql: &'static str| {
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.phone_link");
                tx.connection().execute(sql, [])?;
                Ok(())
            })
            .map(|_| ())
    };
    set("UPDATE phone_link SET detached_at = '2026-10-19T10:00:00.000Z'").expect("detached once");
    // The same value again is not a change.
    set("UPDATE phone_link SET detached_at = '2026-10-19T10:00:00.000Z'").expect("idempotent");
    for sql in [
        "UPDATE phone_link SET detached_at = NULL",
        "UPDATE phone_link SET detached_at = '2026-10-19T11:00:00.000Z'",
    ] {
        let error = set(sql).expect_err("a detach is one way");
        assert!(error.to_string().contains("never re-attached"), "{error}");
    }
    // Everything else about a detached link may still move (the engine keeps `last_seen_at`).
    set("UPDATE phone_link SET last_seen_at = '2026-10-19T12:00:00.000Z'").expect("still seen");
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT row_version FROM phone_link WHERE link_id = 'l1'"
        ),
        4,
        "three accepted updates after the insert, each one a version"
    );
}

#[test]
fn a_purged_row_leaves_its_link_behind_as_a_tombstone_and_nothing_gives_it_a_row_again() {
    let scratch = common::Scratch::founded("purge").expect("a vault");
    party(&scratch.vault, "p1");
    party(&scratch.vault, "p2");
    event(&scratch.vault, "e1");
    link(&scratch.vault, "l1", "contacts", "c1", "p1").expect("a link");
    link(&scratch.vault, "l2", "calendar", "k1", "e1").expect("a link");
    // The kind trigger watches an update of `entity_id`; the foreign key's SET NULL is one, and
    // must pass it.
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.phone_link");
            tx.connection()
                .execute("DELETE FROM core_party WHERE party_id = 'p1'", [])?;
            Ok(())
        })
        .expect("the party is purged");
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT COUNT(*) FROM phone_link WHERE link_id = 'l1' AND entity_id IS NULL"
        ),
        1,
        "the link stayed, with no row: the tombstone"
    );
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT COUNT(*) FROM phone_link WHERE link_id = 'l2' AND entity_id = 'e1'"
        ),
        1,
        "the other link is untouched"
    );
    // A tombstone still holds its phone id: the record cannot be linked to a new row.
    assert!(
        link(&scratch.vault, "l3", "contacts", "c1", "p2").is_err(),
        "one phone record, one link, tombstone included"
    );
    // And it is never given a row again, even by a direct write.
    let revived = scratch.vault.commit(|tx| {
        tx.set_producer("test.phone_link");
        tx.connection().execute(
            "UPDATE phone_link SET entity_id = 'p2' WHERE link_id = 'l1'",
            [],
        )?;
        Ok(())
    });
    let error = revived.expect_err("a purge is one way");
    assert!(
        error.to_string().contains("never given a row again"),
        "{error}"
    );
    // Several tombstones coexist: NULL is not a value `UNIQUE (entity_id)` compares.
    party(&scratch.vault, "p3");
    link(&scratch.vault, "l4", "contacts", "c4", "p3").expect("a link");
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.phone_link");
            tx.connection()
                .execute("DELETE FROM core_party WHERE party_id = 'p3'", [])?;
            Ok(())
        })
        .expect("the party is purged");
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT COUNT(*) FROM phone_link WHERE entity_id IS NULL"
        ),
        2
    );
    // A link cannot be written with no row at all: a tombstone is only ever what a purge leaves.
    let bare = scratch.vault.commit(|tx| {
        tx.set_producer("test.phone_link");
        tx.connection().execute(
            "INSERT INTO phone_link
               (link_id, source, phone_id, origin_id, entity_id, fingerprint, last_seen_at, created_at)
             VALUES ('lz', 'contacts', 'cz', 'o-contacts', NULL, 'f', 'x', 'x')",
            [],
        )?;
        Ok(())
    });
    assert!(bare.is_err(), "a link with no row is not written");
}

#[test]
fn the_tables_are_not_entity_kinds() {
    let scratch = common::Scratch::founded("kinds").expect("a vault");
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT COUNT(*) FROM core_entity_kind WHERE kind LIKE 'phone.%'"
        ),
        0,
        "a link is machinery about a row, not a kind of row"
    );
}

#[test]
fn a_links_origin_exists_is_of_its_source_and_cannot_be_deleted_while_named() {
    let scratch = common::Scratch::founded("origin").expect("a vault");
    party(&scratch.vault, "p1");
    event(&scratch.vault, "e1");
    link(&scratch.vault, "l1", "contacts", "c1", "p1").expect("a link and its origin");
    link(&scratch.vault, "l2", "calendar", "k1", "e1").expect("a link and its origin");
    let run = |sql: &'static str| {
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.phone_link");
                tx.connection().execute(sql, [])?;
                Ok(())
            })
            .map(|_| ())
    };
    // The origin of another source is refused, on insert and on a move.
    assert!(
        run("UPDATE phone_link SET origin_id = 'o-calendar' WHERE link_id = 'l1'").is_err(),
        "a contact cannot come from a calendar"
    );
    assert!(
        run("UPDATE phone_link SET origin_id = 'nobody' WHERE link_id = 'l1'").is_err(),
        "an origin that does not exist is not a pointer"
    );
    // An origin a link names is not deleted out from under it.
    assert!(run("DELETE FROM phone_origin WHERE origin_id = 'o-contacts'").is_err());
    run("DELETE FROM phone_link WHERE link_id = 'l1'").expect("the link goes");
    run("DELETE FROM phone_origin WHERE origin_id = 'o-contacts'").expect("then the origin");
    // An origin's source and phone origin pair is unique, and its label is never blank.
    assert!(
        run(
            "INSERT INTO phone_origin (origin_id, source, phone_origin, label, created_at)
         VALUES ('dup', 'calendar', 'acct', 'Again', '2026-10-19T09:00:00.000Z')"
        )
        .is_err()
    );
    assert!(
        run(
            "INSERT INTO phone_origin (origin_id, source, phone_origin, label, created_at)
         VALUES ('blank', 'files', 'folder', '  ', '2026-10-19T09:00:00.000Z')"
        )
        .is_err()
    );
}
