//! A record that leaves a read, and comes back (#1214, K9): the trash a follower makes for a record's
//! absence is undone by its return if the member never touched the row; what the member trashed
//! stays trashed; a purged row's source is a tombstone and never takes a row again; a read that lost
//! most of what the vault follows is doubted; the owner is nobody's record.

mod common;

use centraid_vault::model::Kind;
use common::follow::{CONTACTS, Follow, ROLL, contacts_origin, hash};
use serde_json::json;

fn people(names: &[&str]) -> Vec<(String, serde_json::Value)> {
    names
        .iter()
        .enumerate()
        .map(|(index, name)| (format!("c{index}"), json!({ "title": name, "given": name })))
        .collect()
}

fn read<'a>(
    records: &'a [(String, serde_json::Value)],
    skip: &[&str],
) -> Vec<(&'a str, serde_json::Value)> {
    records
        .iter()
        .filter(|(id, _)| !skip.contains(&id.as_str()))
        .map(|(id, fields)| (id.as_str(), fields.clone()))
        .collect()
}

#[test]
fn a_record_gone_from_a_complete_read_trashes_its_row_and_its_return_undoes_exactly_that() {
    let f = Follow::new("gaps_back");
    let origin = contacts_origin("icloud", "phone-1");
    let all = people(&["Ada", "Grace"]);
    f.pass(CONTACTS, origin.clone(), &read(&all, &[]), true);
    let ada = f.by_title("person", "Ada");

    let out = f.pass(CONTACTS, origin.clone(), &read(&all, &["c0"]), true);
    assert_eq!(out["trashed"].as_i64(), Some(1), "{out}");
    assert!(f.trashed(&ada));
    // The source remembers when its follower made the trash, and it is the row's own stamp.
    assert_eq!(
        f.count(
            "SELECT s.gone_at = e.deleted_at FROM source s JOIN entity e ON e.id = s.entity_id WHERE e.id = ?1",
            &[&ada]
        ),
        1
    );

    let out = f.pass(CONTACTS, origin, &read(&all, &[]), true);
    assert_eq!(out["restored"].as_i64(), Some(1), "{out}");
    assert_eq!(out["added"].as_i64(), Some(0), "{out}");
    assert!(
        !f.trashed(&ada),
        "the row it trashed comes back, the same row"
    );
    assert_eq!(
        f.maybe::<String>("SELECT gone_at FROM source WHERE entity_id = ?1", &[&ada]),
        None
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'person'", &[]),
        3
    );
}

#[test]
fn a_row_the_member_trashed_stays_trashed_and_one_they_edited_is_kept_when_its_record_goes() {
    let f = Follow::new("gaps_member");
    let origin = contacts_origin("icloud", "phone-1");
    let all = people(&["Ada", "Grace", "Alan"]);
    f.pass(CONTACTS, origin.clone(), &read(&all, &[]), true);
    let (ada, grace) = (f.by_title("person", "Ada"), f.by_title("person", "Grace"));

    // The member trashes one; the phone still has it: a rescan restores nothing.
    f.ok("entity.trash", json!({ "id": ada }));
    let out = f.pass(CONTACTS, origin.clone(), &read(&all, &[]), true);
    assert_eq!(out["restored"].as_i64(), Some(0), "{out}");
    assert!(f.trashed(&ada));

    // The member edits one; the phone deletes it: the row stays and only its link is forgotten.
    f.raw(&format!(
        "UPDATE person SET given = 'Rear Admiral' WHERE id = '{grace}'"
    ));
    let out = f.pass(CONTACTS, origin.clone(), &read(&all, &["c1"]), true);
    assert_eq!(out["forgotten"].as_i64(), Some(1), "{out}");
    assert!(!f.trashed(&grace));
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&grace]
        ),
        0
    );

    // A row the member trashed AFTER the follower did is the member's trash, not the follower's:
    // the record returning does not undo it.
    let alan = f.by_title("person", "Alan");
    f.pass(CONTACTS, origin.clone(), &read(&all, &["c2"]), true);
    assert!(f.trashed(&alan), "the follower trashed it");
    f.ok("entity.restore", json!({ "id": alan }));
    f.ok("entity.trash", json!({ "id": alan }));
    let out = f.pass(CONTACTS, origin, &read(&all, &[]), true);
    assert_eq!(out["restored"].as_i64(), Some(0), "{out}");
    assert!(f.trashed(&alan));
}

#[test]
fn a_purged_rows_source_is_a_tombstone_and_a_record_that_returns_adds_no_row() {
    let f = Follow::new("gaps_tombstone");
    let origin = contacts_origin("icloud", "phone-1");
    let all = people(&["Ada", "Grace"]);
    f.pass(CONTACTS, origin.clone(), &read(&all, &[]), true);
    let ada = f.by_title("person", "Ada");
    f.ok("entity.trash", json!({ "id": ada }));
    f.ok("entity.purge", json!({ "id": ada }));
    // The source stays, with no row: a tombstone.
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE external_id = 'c0' AND entity_id IS NULL",
            &[]
        ),
        1
    );
    let out = f.pass(CONTACTS, origin.clone(), &read(&all, &[]), true);
    assert_eq!(out["added"].as_i64(), Some(0), "{out}");
    assert_eq!(out["matched"].as_i64(), Some(0), "{out}");
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE title = 'Ada'", &[]),
        0
    );
    // The database says the same of any writer: it never takes a row again.
    let grace = f.by_title("person", "Grace");
    let error = f
        .raw_result(&format!(
            "UPDATE source SET entity_id = '{grace}', entity_kind = 'person' WHERE external_id = 'c0'"
        ))
        .expect_err("refused");
    assert!(error.contains("never takes a row again"), "{error}");

    // A tombstone whose record is gone from a complete read goes with it.
    f.pass(CONTACTS, origin, &read(&all, &["c0"]), true);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM source WHERE external_id = 'c0'", &[]),
        0
    );
}

#[test]
fn another_phone_finds_a_purged_rows_tombstone_and_never_revives_the_row() {
    let f = Follow::new("gaps_second_phone");
    f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[("c1", json!({ "title": "Ada", "given": "Ada" }))],
        true,
    );
    let ada = f.by_title("person", "Ada");
    f.ok("entity.trash", json!({ "id": ada }));
    f.ok("entity.purge", json!({ "id": ada }));
    // A new phone states her again, under its own ids.
    let out = f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-2"),
        &[("n9", json!({ "title": "Ada", "given": "Ada" }))],
        true,
    );
    assert_eq!(out["added"].as_i64(), Some(0), "{out}");
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE title = 'Ada'", &[]),
        0
    );
    assert_eq!(
        f.one::<String>(
            "SELECT external_id || ':' || device_id FROM source WHERE entity_id IS NULL",
            &[]
        ),
        "n9:phone-2",
        "the tombstone now answers to the new phone's id"
    );
}

#[test]
fn a_read_that_lost_most_of_what_the_vault_follows_trashes_nothing() {
    let f = Follow::new("gaps_doubted");
    let origin = contacts_origin("icloud", "phone-1");
    let all = people(&["A", "B", "C", "D", "E", "F"]);
    f.pass(CONTACTS, origin.clone(), &read(&all, &[]), true);
    // Six followed, none read: that looks like a glitch, not a mass delete.
    let out = f.pass(CONTACTS, origin.clone(), &[], true);
    assert_eq!(out["doubted"].as_i64(), Some(6), "{out}");
    assert_eq!(out["trashed"].as_i64(), Some(0), "{out}");
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM entity WHERE deleted_at IS NOT NULL",
            &[]
        ),
        0
    );
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE entity_id IS NOT NULL",
            &[]
        ),
        6
    );
    // A read that is not complete judges nothing at all.
    let out = f.pass(CONTACTS, origin, &[], false);
    assert_eq!(out["trashed"].as_i64(), Some(0), "{out}");
    assert_eq!(out["doubted"].as_i64(), Some(0), "{out}");
}

#[test]
fn the_owner_is_nobodys_record() {
    let f = Follow::new("gaps_owner");
    let owner: String = f.one("SELECT self_id FROM vault", &[]);
    let name: String = f.one("SELECT title FROM entity WHERE id = ?1", &[&owner]);
    let origin = contacts_origin("icloud", "phone-1");
    // A contact named like the owner is added BESIDE the owner, never matched to them.
    let out = f.pass(
        CONTACTS,
        origin.clone(),
        &[("c1", json!({ "title": name, "given": "x" }))],
        true,
    );
    assert_eq!(out["added"].as_i64(), Some(1), "{out}");
    assert_eq!(out["matched"].as_i64(), Some(0), "{out}");
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&owner]
        ),
        0
    );
    // And the owner is never trashed by a read that no longer has a record like them.
    f.pass(CONTACTS, origin, &[], true);
    assert!(!f.trashed(&owner));
}

// ---------------------------------------------------------------------------------------------
// The camera roll: a followed store with tombstones, kept whatever the phone deletes
// ---------------------------------------------------------------------------------------------

/// A photo as the camera roll's pass would have made it, written by raw SQL: the bytes, the row
/// and its source.
fn photo(f: &Follow, external: &str, letter: char) -> String {
    let (id, source, now) = (
        f.vault().ids().next(),
        f.vault().ids().next(),
        f.vault().clock().now_text(),
    );
    let hash = hash(letter);
    let origin_id = f
        .maybe::<String>("SELECT id FROM origin WHERE system = 'camera_roll'", &[])
        .unwrap_or_else(|| {
            let origin = f.vault().ids().next();
            f.raw(&format!(
                "INSERT INTO origin (id, system, ref, label, device_id, created_at)
                 VALUES ('{origin}', 'camera_roll', 'Camera roll', 'Camera roll', 'phone-1', '{now}')"
            ));
            origin
        });
    f.vault()
        .commit(|tx| {
            tx.insert_entity(&id, Kind::Photo, "", &now)?;
            tx.connection().execute(
                "INSERT INTO blob (hash, size) VALUES (?1, 3) ON CONFLICT DO NOTHING",
                [&hash],
            )?;
            tx.connection().execute(
                "INSERT INTO photo (id, blob, media_type, form) VALUES (?1, ?2, 'image/jpeg', 'photo')",
                [&id, &hash],
            )?;
            tx.connection().execute(
                "INSERT INTO source (id, origin_id, system, external_id, device_id, entity_id,
                                     entity_kind, stated, seen_at)
                 VALUES (?1, ?2, 'camera_roll', ?3, 'phone-1', ?4, 'photo', ?5, ?6)",
                rusqlite::params![
                    source,
                    origin_id,
                    external,
                    id,
                    json!({ "blob": hash }).to_string(),
                    now
                ],
            )?;
            Ok(())
        })
        .expect("a photo");
    id
}

fn roll(f: &Follow, photos: &[(&str, char)], complete: bool) -> serde_json::Value {
    let records: Vec<(&str, serde_json::Value)> = photos
        .iter()
        .map(|(id, letter)| (*id, json!({ "blob": hash(*letter) })))
        .collect();
    f.pass(
        ROLL,
        json!({ "ref": "Camera roll", "label": "Camera roll", "device_id": "phone-1" }),
        &records,
        complete,
    )
}

#[test]
fn a_trashed_photo_stays_trashed_after_a_rescan_and_a_purged_one_is_never_added_again() {
    let f = Follow::new("gaps_roll");
    let (kept, trashed, purged) = (
        photo(&f, "p1", 'a'),
        photo(&f, "p2", 'b'),
        photo(&f, "p3", 'c'),
    );
    f.ok("entity.trash", json!({ "id": trashed }));
    f.ok("entity.trash", json!({ "id": purged }));
    f.ok("entity.purge", json!({ "id": purged }));
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE external_id = 'p3' AND entity_id IS NULL",
            &[]
        ),
        1,
        "the purged photo's source is a tombstone"
    );

    // A rescan that still holds all three: nothing is added, nothing restored.
    let out = roll(&f, &[("p1", 'a'), ("p2", 'b'), ("p3", 'c')], true);
    assert_eq!(out["added"].as_i64(), Some(0), "{out}");
    assert_eq!(out["restored"].as_i64(), Some(0), "{out}");
    assert!(f.trashed(&trashed), "a pass is not a restore");
    assert!(!f.trashed(&kept));
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'photo'", &[]),
        2
    );

    // A photograph the phone has not seen before is a new row; the vault keeps what the camera
    // roll deletes (its source is forgotten, the row stays) and drops a tombstone whose record
    // is gone.
    let out = roll(
        &f,
        &[("p1", 'a'), ("p2", 'b'), ("p3", 'c'), ("p4", 'd')],
        true,
    );
    assert_eq!(out["added"].as_i64(), Some(1), "{out}");
    let out = roll(&f, &[], true);
    assert_eq!(out["trashed"].as_i64(), Some(0), "{out}");
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'photo'", &[]),
        3
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM source", &[]),
        0,
        "every link and tombstone is gone"
    );
}

/// The guard is one rule of the engine (`merge.rs`), applied to a system whose map trashes what a
/// read no longer holds. Each such system proves it on its own records; a system that comes to
/// trash and has no proof is red here until it has one.
#[test]
fn every_system_that_trashes_what_a_read_loses_has_a_doubted_read_proved() {
    use centraid_vault::commands::follow::{Gone, SYSTEMS};
    const PROVED: [(&str, &str); 4] = [
        ("contacts", "lane_follow_people.rs"),
        ("calendar", "calendar_follow.rs"),
        ("files", "docs_photos_follow.rs"),
        ("phone_reminders", "follow_reminders.rs"),
    ];
    let trashing: std::collections::BTreeSet<&str> = SYSTEMS
        .iter()
        .filter(|map| map.gone == Gone::Trash)
        .map(|map| map.system)
        .collect();
    let proved: std::collections::BTreeSet<&str> =
        PROVED.iter().map(|(system, _)| *system).collect();
    assert_eq!(
        trashing, proved,
        "a followed system that trashes what a read loses, and the file that proves its doubted read"
    );
    for (system, file) in PROVED {
        let source = std::fs::read_to_string(std::path::Path::new("tests").join(file))
            .unwrap_or_else(|error| panic!("{file}: {error}"));
        assert!(
            source.contains("\"doubted\""),
            "{file} no longer asserts a doubted read for `{system}`"
        );
    }
}

/// Count every row written to `source` or `revision` from now on, on the writer's own connection
/// (a TEMP trigger lives and dies with it, so the file's schema is untouched).
fn count_writes(f: &Follow) {
    let mut sql = String::from("CREATE TEMP TABLE probe (what TEXT NOT NULL);");
    for table in ["source", "revision"] {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            sql.push_str(&format!(
                "CREATE TEMP TRIGGER probe_{table}_{event} AFTER {event} ON main.{table}
                 BEGIN INSERT INTO probe VALUES ('{table}'); END;"
            ));
        }
    }
    f.raw(&sql);
}

fn written(f: &Follow, table: &str) -> i64 {
    f.vault()
        .commit(|tx| {
            Ok(tx.connection().query_row(
                "SELECT count(*) FROM temp.probe WHERE what = ?1",
                [table],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("a count")
        .value
}

#[test]
fn a_second_identical_pass_writes_no_source_row_and_makes_no_revision() {
    let f = Follow::new("gaps_quiet");
    let origin = contacts_origin("icloud", "phone-1");
    let names: Vec<String> = (0..12).map(|i| format!("Person {i}")).collect();
    let all = people(&names.iter().map(String::as_str).collect::<Vec<_>>());
    f.pass(CONTACTS, origin.clone(), &read(&all, &[]), true);
    count_writes(&f);
    let again = f.pass(CONTACTS, origin, &read(&all, &[]), true);
    assert_eq!(again["unchanged"], 12, "{again}");
    assert_eq!(
        written(&f, "source"),
        0,
        "an unchanged record writes no source row"
    );
    assert_eq!(
        written(&f, "revision"),
        0,
        "an unchanged record makes no revision"
    );
}

#[test]
fn a_changed_record_still_writes_its_source_and_a_returned_one_clears_gone() {
    let f = Follow::new("gaps_changed");
    let origin = contacts_origin("icloud", "phone-1");
    let two = people(&["Ada", "Bo"]);
    f.pass(CONTACTS, origin.clone(), &read(&two, &[]), true);
    count_writes(&f);
    let changed = people(&["Ada L", "Bo"]);
    f.pass(CONTACTS, origin.clone(), &read(&changed, &[]), true);
    assert_eq!(written(&f, "source"), 1, "only the record that changed");
    // Bo leaves a complete read (trashed, marked gone), then returns: the link is written once.
    f.pass(CONTACTS, origin.clone(), &read(&changed, &["c1"]), true);
    let gone: Option<String> = f.one("SELECT gone_at FROM source WHERE external_id = 'c1'", &[]);
    assert!(gone.is_some());
    f.pass(CONTACTS, origin, &read(&changed, &[]), true);
    let gone: Option<String> = f.one("SELECT gone_at FROM source WHERE external_id = 'c1'", &[]);
    assert!(gone.is_none());
}
