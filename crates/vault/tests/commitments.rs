//! The v0 schema's commitments, each read off the founded file (#1214, K12).
//!
//! The issue lists what holds at every checkpoint. Each line is held by a test, here or in the
//! file named:
//!
//! | Commitment | Held by |
//! |---|---|
//! | every 64-hex value references `blob(hash)` | `every_hash_in_the_file_sits_in_a_foreign_key_into_blob` |
//! | an incremental index update equals a full rebuild | `index_owed.rs`, `index_past.rs`, `index_geo.rs` (`assert_equals_a_rebuild`, after every step of a scripted run) |
//! | no sealed value reaches any index, word list, derived blob, revision, notification or disk file | `locker_plaintext_gate.rs`, `locker_search.rs`, `index_past.rs` |
//! | no blob an earlier version names is collected while its entity lives | `blob_release.rs` (`earlier_bytes_are_kept_while_the_entity_lives_and_a_purge_frees_them`) |
//! | no CHECK or trigger names a value that lives in a lookup table | `no_check_or_trigger_names_a_value_a_lookup_table_holds` |
//! | the lookup seeds equal every Rust enum that mirrors them | `lookups.rs` and `the_lookup_seeds_equal_the_rust_lists_that_mirror_them` |
//! | every blob column is a `revision_blob` slot, `OMITTED`, or in `RENTERS` | `every_blob_column_is_a_slot_or_omitted_and_has_a_renter` (and `history.rs`, `blob_release.rs`) |
//!
//! The rest of the file is the structure every kind relies on: one host table per kind, the trash
//! pair on `entity` alone, and an index behind every foreign key.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use centraid_vault::backup::files::RENTERS;
use centraid_vault::commands::follow::SYSTEMS;
use centraid_vault::lookups::LOOKUP_TABLES;
use centraid_vault::model::Kind;
use common::world::World;
use rusqlite::Connection;

fn read<T>(w: &World, body: impl FnOnce(&Connection) -> centraid_vault::Result<T>) -> T {
    w.vault().read(body).expect("reads")
}

fn table_sql(connection: &Connection, table: &str) -> String {
    connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .unwrap_or_else(|error| panic!("{table}: {error}"))
}

/// Every ordinary table of the vault file (the index file's tables are in schema `ix`).
fn tables(connection: &Connection) -> Vec<String> {
    connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
              ORDER BY name",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("lists tables")
}

/// One foreign key, as `PRAGMA foreign_key_list` states it: `from` and `to` are the comma-joined
/// column lists of a composite key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Fk {
    table: String,
    from: String,
    to_table: String,
    to: String,
    on_delete: String,
}

fn foreign_keys(connection: &Connection) -> Vec<Fk> {
    let mut all = Vec::new();
    for table in tables(connection) {
        let mut statement = connection
            .prepare("SELECT id, \"from\", \"table\", \"to\", on_delete FROM pragma_foreign_key_list(?1) ORDER BY id, seq")
            .expect("prepares");
        let rows = statement
            .query_map([&table], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .expect("queries")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("reads");
        let mut by_id: BTreeMap<i64, Fk> = BTreeMap::new();
        for (id, from, to_table, to, on_delete) in rows {
            let fk = by_id.entry(id).or_insert_with(|| Fk {
                table: table.clone(),
                from: String::new(),
                to_table,
                to: String::new(),
                on_delete,
            });
            for (joined, part) in [(&mut fk.from, Some(from)), (&mut fk.to, to)] {
                let Some(part) = part else { continue };
                if !joined.is_empty() {
                    joined.push(',');
                }
                joined.push_str(&part);
            }
        }
        all.extend(by_id.into_values());
    }
    all
}

/// The leading column of every index of `table`, the primary key included: a lookup of
/// `column = ?` on the child is served by an index only when the column leads it.
fn leading_columns(connection: &Connection, table: &str) -> BTreeSet<String> {
    let mut leads = BTreeSet::new();
    let indexes: Vec<String> = connection
        .prepare("SELECT name FROM pragma_index_list(?1)")
        .and_then(|mut statement| {
            statement
                .query_map([table], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("lists indexes");
    for index in indexes {
        let lead: Option<String> = connection
            .query_row(
                "SELECT name FROM pragma_index_info(?1) WHERE seqno = 0",
                [&index],
                |row| row.get(0),
            )
            .ok();
        leads.extend(lead);
    }
    // A rowid-alias primary key has no index of its own.
    let key: Option<String> = connection
        .query_row(
            "SELECT name FROM pragma_table_info(?1) WHERE pk = 1",
            [table],
            |row| row.get(0),
        )
        .ok();
    leads.extend(key);
    leads
}

// ---------------------------------------------------------------------------------------------
// Every hash is a foreign key into blob
// ---------------------------------------------------------------------------------------------

fn runs_of_hex(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut start = None;
    for (at, byte) in bytes.iter().enumerate().chain([(bytes.len(), &b' ')]) {
        let hex = matches!(byte, b'0'..=b'9' | b'a'..=b'f');
        match (hex, start) {
            (true, None) => start = Some(at),
            (false, Some(from)) => {
                if at - from >= 64 {
                    found.push(&text[from..at]);
                }
                start = None;
            }
            _ => {}
        }
    }
    found
}

/// One vault holding a row in every column that names a blob (the ten the schema declares), a
/// version that kept an earlier document, and a Locker field that is a sealed file.
fn populate_every_blob_column(w: &World) {
    let at = "2026-03-01T09:00:00.000Z";
    let hash = |label: &str| centraid_vault::blob::content_digest(label.as_bytes());
    let note = w.note("Trip");
    let person = w.person("Ada");
    let document = w.made(Kind::Document, "Doc");
    let photo = w.made(Kind::Photo, "Photo");
    let album = w.container("album", "Album");
    let thread = w.made(Kind::Thread, "Chat");
    let item = w.made(Kind::LockerItem, "Passport");
    let c = |sql: String| {
        w.vault()
            .commit(|tx| Ok(tx.connection().execute_batch(&sql)?))
            .unwrap_or_else(|error| panic!("{error}: {sql}"));
    };
    for label in [
        "cover", "avatar", "doc", "doc2", "photo", "motion", "asset", "orig", "d-out", "thumb",
        "sealed",
    ] {
        c(format!(
            "INSERT INTO blob (hash, size) VALUES ('{}', 1)",
            hash(label)
        ));
    }
    c(format!(
        "UPDATE container SET cover = '{}' WHERE id = '{album}'",
        hash("cover")
    ));
    c(format!(
        "UPDATE person SET avatar = '{}' WHERE id = '{person}'",
        hash("avatar")
    ));
    c(format!(
        "INSERT INTO document (id, blob, media_type) VALUES ('{document}', '{}', 'text/plain')",
        hash("doc")
    ));
    // Replacing the bytes makes a version that names the earlier ones: a `revision_blob` row.
    w.vault()
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE document SET blob = ?2 WHERE id = ?1",
                [&document, &hash("doc2")],
            )?;
            tx.touch(&document, at)
        })
        .expect("replaces");
    c(format!(
        "INSERT INTO photo (id, blob, media_type, form, motion_blob) VALUES ('{photo}', '{}', 'image/jpeg', 'photo', '{}')",
        hash("photo"),
        hash("motion")
    ));
    c(format!(
        "INSERT INTO note_asset (id, note_id, blob, name, media_type, position)
         VALUES ('as-1', '{note}', '{}', 'map.png', 'image/png', 1)",
        hash("asset")
    ));
    w.commit(|tx| {
        centraid_vault::blob::write_derivative(
            tx.connection(),
            at,
            &hash("orig"),
            "thumb",
            Some((&hash("d-out"), 1, "image/jpeg")),
            None,
        )
    });
    c(format!(
        "INSERT INTO thread (id) VALUES ('{thread}');
         INSERT INTO message (thread_id, ordinal, role, text, outcome, created_at, updated_at)
         VALUES ('{thread}', 0, 'user', 'look', 'sent', '{at}', '{at}');
         INSERT INTO message_attachment (thread_id, ordinal, position, form, label, thumb)
         VALUES ('{thread}', 0, 0, 'image', 'pasted.png', '{}')",
        hash("thumb")
    ));
    c(format!(
        "INSERT INTO locker_key (id, key_id, created_at) VALUES (1, 'k1', '{at}');
         INSERT INTO locker_item (id, type) VALUES ('{item}', 'document');
         INSERT INTO locker_item_field (id, item_id, label, kind, value_sealed, value_blob, key_id,
                                        value_set_at, created_at, updated_at)
         VALUES ('f-file', '{item}', 'Scan', 'file', 'lk1:AAAA', '{}', 'k1', '{at}', '{at}', '{at}')",
        hash("sealed")
    ));
}

#[test]
fn every_hash_in_the_file_sits_in_a_foreign_key_into_blob() {
    let w = World::new("commit_hash");
    populate_every_blob_column(&w);
    read(&w, |connection| {
        // What the schema says: the foreign keys into `blob(hash)`, and the one column that is a
        // hash by its own CHECK (`blob.hash`, the key itself): no other CHECK states a hash.
        let declared: BTreeSet<(String, String)> = foreign_keys(connection)
            .into_iter()
            .filter(|fk| fk.to_table == "blob")
            .inspect(|fk| assert_eq!(fk.to, "hash"))
            .map(|fk| (fk.table, fk.from))
            .collect();
        for table in tables(connection) {
            let sql = table_sql(connection, &table);
            assert_eq!(
                sql.contains("length(hash) = 64"),
                table == "blob",
                "{table}: only `blob` states what a hash is; every other table references it"
            );
        }
        // What the rows say: every cell of every table that holds a run of 64 lowercase hex
        // characters, in a column, in JSON (a version's state, a record, a card) or in a sealed
        // value alike, is in a declared column (and `blob.hash`).
        let mut populated = BTreeSet::new();
        for table in tables(connection) {
            let columns: Vec<String> = connection
                .prepare("SELECT name FROM pragma_table_xinfo(?1) WHERE hidden = 0 OR hidden = 2")?
                .query_map([&table], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            for column in columns {
                let mut statement = connection.prepare(&format!(
                    "SELECT CAST(\"{column}\" AS TEXT) FROM \"{table}\" WHERE \"{column}\" IS NOT NULL"
                ))?;
                let values = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if values.iter().any(|value| !runs_of_hex(value).is_empty()) {
                    populated.insert((table.clone(), column));
                }
            }
        }
        populated.remove(&("blob".to_owned(), "hash".to_owned()));
        assert!(
            populated.is_subset(&declared),
            "a column holds a hash and is not a foreign key into blob: {:?}",
            populated.difference(&declared).collect::<Vec<_>>()
        );
        // The fixture reaches every declared column, so the scan above looked at all of them.
        assert_eq!(
            populated, declared,
            "the fixture left a blob column empty, or a column holds a hash it does not declare"
        );
        // The collector walks the same list and no other.
        let seen: BTreeSet<(String, String)> = centraid_vault::blob::references(connection)?
            .into_iter()
            .map(|reference| (reference.table, reference.column))
            .collect();
        assert_eq!(
            seen, declared,
            "the collector sees every reference the schema declares, from foreign_key_list alone"
        );
        Ok(())
    });
}

#[test]
fn every_blob_column_is_a_slot_or_omitted_and_has_a_renter() {
    let w = World::new("commit_slots");
    read(&w, |connection| {
        let columns: BTreeSet<(String, String)> = foreign_keys(connection)
            .into_iter()
            .filter(|fk| fk.to_table == "blob")
            .map(|fk| (fk.table, fk.from))
            .collect();
        let renters: BTreeSet<(String, String)> = RENTERS
            .iter()
            .map(|(table, column, _)| ((*table).to_owned(), (*column).to_owned()))
            .collect();
        let history_tables: BTreeSet<&str> = centraid_vault::history::TABLES
            .iter()
            .filter(|(_, role)| {
                matches!(
                    role,
                    centraid_vault::history::Role::Host
                        | centraid_vault::history::Role::Child { .. }
                )
            })
            .map(|(name, _)| *name)
            .collect();
        for (table, column) in &columns {
            // A derivative's file is its original's, kept by the original (`RENTERS` leaves it
            // out), and a derivative cascades with its original: it rents nothing itself.
            let derived = table == "derivative";
            // A state-bearing table's blob column is a slot (kept in `revision_blob`) or omitted
            // from the version with a reason; any other table's column is no part of a version.
            let versioned = history_tables.contains(table.as_str());
            let classified = !versioned
                || centraid_vault::history::blob_slot(table, column).is_some()
                || centraid_vault::history::OMITTED
                    .iter()
                    .any(|(t, c, _)| t == table && c == column);
            assert!(
                classified,
                "{table}.{column} names bytes: it is a `BLOB_SLOTS` row or `OMITTED`"
            );
            assert!(
                derived || renters.contains(&(table.clone(), column.clone())),
                "{table}.{column} names bytes and no `RENTERS` row says whose they are"
            );
        }
        for (table, column) in &renters {
            assert!(
                columns.contains(&(table.clone(), column.clone())),
                "RENTERS names {table}.{column}, which references no blob"
            );
        }
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// No CHECK or trigger names a value a lookup table holds
// ---------------------------------------------------------------------------------------------

/// The `'quoted'` literals of a piece of SQL.
fn literals(sql: &str) -> BTreeSet<String> {
    sql.split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

/// The text of every `CHECK (...)` of a `CREATE TABLE`, column and table level.
fn checks(sql: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = sql;
    while let Some(at) = rest.find("CHECK") {
        rest = &rest[at + "CHECK".len()..];
        let Some(open) = rest.find('(') else { break };
        if !rest[..open].trim().is_empty() {
            continue;
        }
        let mut depth = 0;
        let mut quoted = false;
        for (index, letter) in rest[open..].char_indices() {
            match letter {
                '\'' => quoted = !quoted,
                '(' if !quoted => depth += 1,
                ')' if !quoted => {
                    depth -= 1;
                    if depth == 0 {
                        found.push(rest[open..open + index + 1].to_owned());
                        rest = &rest[open + index + 1..];
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    found
}

fn mentions(sql: &str, column: &str) -> bool {
    sql.split(|letter: char| !(letter.is_alphanumeric() || letter == '_'))
        .any(|word| word == column)
}

/// A rule the database holds does not say a lookup's value: a new value is a seed row, and a list
/// in a CHECK would be a rebuild of its table to widen. For every column that references a lookup
/// table, no CHECK or trigger of its table that reads the column names one of that lookup's keys.
#[test]
fn no_check_or_trigger_names_a_value_a_lookup_table_holds() {
    // The control: the reader finds a list planted in a CHECK, so an empty answer means none.
    let planted = checks("CREATE TABLE t (a TEXT CHECK (a IN ('x','y')), b INT, CHECK (b > 0))");
    assert_eq!(planted.len(), 2);
    assert_eq!(
        literals(&planted[0]),
        ["x", "y"].map(str::to_owned).into_iter().collect()
    );
    let w = World::new("commit_lookup_literals");
    read(&w, |connection| {
        let mut values: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for table in LOOKUP_TABLES {
            // The keys of a lookup row: its first column (`code`, `key`, or `kind` for
            // `reminder_target`) and, for the shape tables, the two kinds and the relation.
            let keys: Vec<String> = connection
                .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")?
                .query_map([table], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut set = BTreeSet::new();
            for key in keys {
                let mut statement =
                    connection.prepare(&format!("SELECT CAST(\"{key}\" AS TEXT) FROM {table}"))?;
                set.extend(
                    statement
                        .query_map([], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                );
            }
            values.insert((*table).to_owned(), set);
        }
        let mut offences = Vec::new();
        let mut looked_at = 0;
        for fk in foreign_keys(connection) {
            let Some(codes) = values.get(&fk.to_table) else {
                continue;
            };
            if LOOKUP_TABLES.contains(&fk.table.as_str()) {
                // A shape table's own keys are the lookup; its seed is not a rule.
                continue;
            }
            let columns: Vec<&str> = fk.from.split(',').collect();
            looked_at += 1;
            let mut rules: Vec<(String, String)> = checks(&table_sql(connection, &fk.table))
                .into_iter()
                .map(|check| (format!("a CHECK of {}", fk.table), check))
                .collect();
            let triggers: Vec<String> = connection
                .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1")?
                .query_map([&fk.table], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            rules.extend(
                triggers
                    .into_iter()
                    .map(|sql| (format!("a trigger on {}", fk.table), sql)),
            );
            for (what, sql) in rules {
                if !columns.iter().any(|column| mentions(&sql, column)) {
                    continue;
                }
                for word in literals(&sql).intersection(codes) {
                    offences.push(format!(
                        "{what} reads {} and names '{word}', a row of {}: {sql}",
                        fk.from, fk.to_table
                    ));
                }
            }
        }
        assert!(looked_at > 20, "the test looked at the lookups' referrers");
        assert!(offences.is_empty(), "{}", offences.join("\n"));
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// The lookup seeds equal every Rust list that mirrors them
// ---------------------------------------------------------------------------------------------

fn words(w: &World, sql: &str) -> BTreeSet<String> {
    w.strings(sql, &[]).into_iter().collect()
}

/// `lookups.rs` holds the kinds, concepts, containers, relations, photo forms and label colours.
/// What it does not: the alerts' target kinds, and the followed stores the engine has a map for.
#[test]
fn the_lookup_seeds_equal_the_rust_lists_that_mirror_them() {
    let w = World::new("commit_mirrors");
    assert_eq!(
        words(&w, "SELECT kind FROM reminder_target"),
        centraid_vault::alerts::TARGET_KINDS
            .iter()
            .map(|kind| (*kind).to_owned())
            .collect(),
        "`alerts::TARGET_KINDS` is the `reminder_target` lookup"
    );
    let systems = words(&w, "SELECT code FROM origin_system");
    let shapes = words(&w, "SELECT system || '/' || entity_kind FROM source_shape");
    for map in SYSTEMS {
        assert!(
            systems.contains(map.system),
            "the map of `{}` has no `origin_system` row",
            map.system
        );
        assert!(
            shapes.contains(&format!("{}/{}", map.system, map.kind.as_str())),
            "the map of `{}` yields `{}` and `source_shape` does not say so",
            map.system,
            map.kind.as_str()
        );
    }
    let colours = words(&w, "SELECT key FROM palette");
    for colour in centraid_vault::commands::container::LIST_COLORS
        .iter()
        .chain(&centraid_vault::commands::container::PHONE_CALENDAR_COLORS)
        .chain(&centraid_vault::commands::tag::LABEL_COLORS)
    {
        assert!(colours.contains(*colour), "{colour} is not a palette key");
    }
    let locker_types = words(&w, "SELECT code FROM locker_type");
    assert_eq!(
        locker_types,
        centraid_vault::commands::locker::schema::ITEM_TYPES
            .iter()
            .map(|code| (*code).to_owned())
            .collect(),
        "`ITEM_TYPES` is the `locker_type` lookup"
    );
}

// ---------------------------------------------------------------------------------------------
// The structure every kind relies on
// ---------------------------------------------------------------------------------------------

/// Tables of one row, where a child-side scan costs nothing.
const ONE_ROW_TABLES: [(&str, &str); 1] = [(
    "vault",
    "the one-row identity record: `self_id` is checked against a table of one row",
)];

#[test]
fn every_foreign_key_column_leads_an_index() {
    // Deleting a parent row (a blob's collection, a purge, emptying the trash) makes SQLite look
    // up the children that name it, once per deleted row; with no index leading on the child
    // column each lookup reads the whole child table. `EXPLAIN QUERY PLAN` never shows that
    // lookup, so the plan sweep in `crates/core/tests/query_plans.rs` cannot see its absence.
    let w = World::new("commit_fk_index");
    let unindexed: Vec<String> = read(&w, |connection| {
        Ok(foreign_keys(connection)
            .into_iter()
            .filter(|fk| !ONE_ROW_TABLES.iter().any(|(table, _)| *table == fk.table))
            .filter(|fk| {
                let lead = fk.from.split(',').next().unwrap_or_default().to_owned();
                !leading_columns(connection, &fk.table).contains(&lead)
            })
            .map(|fk| format!("{}({}) -> {}({})", fk.table, fk.from, fk.to_table, fk.to))
            .collect())
    });
    assert!(
        unindexed.is_empty(),
        "foreign keys whose child column leads no index (add one to the baseline, partial \
         `WHERE col IS NOT NULL` when it is mostly NULL): {unindexed:?}"
    );
    for (table, reason) in ONE_ROW_TABLES {
        assert!(!reason.is_empty(), "{table} is exempt without a reason");
    }
}

#[test]
fn every_kind_has_exactly_one_host_and_the_hosts_are_exactly_the_composite_cascade_keys() {
    let w = World::new("commit_hosts");
    read(&w, |connection| {
        let hosts: BTreeSet<String> = foreign_keys(connection)
            .into_iter()
            .filter(|fk| fk.to_table == "entity" && fk.from == "id,kind" && fk.to == "id,kind")
            .inspect(|fk| {
                assert_eq!(
                    fk.on_delete, "CASCADE",
                    "{} must cascade from its entity",
                    fk.table
                )
            })
            .map(|fk| fk.table)
            .collect();
        let expected: BTreeSet<String> = Kind::ALL
            .iter()
            .map(|kind| kind.host().to_owned())
            .collect();
        assert_eq!(
            hosts, expected,
            "the tables with an (id, kind) cascade are the kinds' hosts, and only them"
        );
        for host in &hosts {
            let sql = table_sql(connection, host)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if host == "concept" || host == "container" {
                assert!(
                    sql.contains("kind TEXT NOT NULL"),
                    "{host} carries its own kind, a lookup row"
                );
            } else {
                assert!(
                    sql.contains(&format!("kind TEXT GENERATED ALWAYS AS ('{host}') VIRTUAL")),
                    "{host} is its own kind, generated and never written"
                );
            }
        }
        // And every kind of the model is a row of the lookup, and the other way.
        let kinds: BTreeSet<String> = connection
            .prepare("SELECT code FROM entity_kind")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        assert_eq!(
            kinds,
            Kind::ALL.iter().map(|k| k.as_str().to_owned()).collect()
        );
        Ok(())
    });
}

#[test]
fn the_trash_pair_lives_on_entity_only() {
    let w = World::new("commit_trash_pair");
    read(&w, |connection| {
        let mut holders = BTreeSet::new();
        for table in tables(connection) {
            let columns: BTreeSet<String> = connection
                .prepare("SELECT name FROM pragma_table_info(?1)")?
                .query_map([&table], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            let has = |name: &str| columns.contains(name);
            assert_eq!(
                has("deleted_at"),
                has("purge_at"),
                "{table} has half a trash pair"
            );
            if has("deleted_at") {
                holders.insert(table);
            }
        }
        // A kind of every app is an entity: its trash pair is its entity's, like every kind's.
        assert_eq!(holders, ["entity"].map(str::to_owned).into());
        Ok(())
    });
}
