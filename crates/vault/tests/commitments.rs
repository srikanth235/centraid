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
//! | every text column is findable, sealed or argued out | `every_text_column_is_findable_sealed_or_argued_out` (`TEXT`) |
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
            let mut columns: Vec<&str> = fk.from.split(',').collect();
            let mut domain_codes = None;
            if fk.to_table == "vocab" {
                // A vocabulary column keys `(<col>, <col>_domain)`: its codes are its domain's.
                let (code_column, domain_column) = (columns[0], columns[1]);
                let sql = table_sql(connection, &fk.table);
                let at = sql
                    .find(&format!("\n  {domain_column} "))
                    .expect("a domain constant");
                let constant = &sql[at..];
                let constant = &constant[constant.find("AS ('").expect("a constant")..];
                let domain = literals(&constant[..constant.find(')').expect("a close")])
                    .into_iter()
                    .next()
                    .expect("a domain");
                let set = connection
                    .prepare("SELECT code FROM vocab WHERE domain = ?1")?
                    .query_map([&domain], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<BTreeSet<_>>>()?;
                assert!(!set.is_empty(), "the `{domain}` domain is seeded");
                domain_codes = Some(set);
                columns = vec![code_column];
            }
            let codes = domain_codes.as_ref().unwrap_or(codes);
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
    let colours = words(&w, "SELECT code FROM vocab WHERE domain = 'palette'");
    for colour in centraid_vault::commands::container::LIST_COLORS
        .iter()
        .chain(&centraid_vault::commands::container::PHONE_CALENDAR_COLORS)
        .chain(&centraid_vault::commands::tag::LABEL_COLORS)
    {
        assert!(colours.contains(*colour), "{colour} is not a palette key");
    }
    let locker_types = words(&w, "SELECT code FROM vocab WHERE domain = 'locker_type'");
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

// ---------------------------------------------------------------------------------------------
// Every text column is findable, sealed or argued out
// ---------------------------------------------------------------------------------------------

/// The text of one column's own definition inside a `CREATE TABLE`.
fn column_definition(sql: &str, column: &str) -> String {
    let body = &sql[sql.find('(').map_or(0, |at| at + 1)..];
    let (mut depth, mut start, mut pieces) = (0_i32, 0, Vec::new());
    for (at, letter) in body.char_indices() {
        match letter {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                pieces.push(&body[start..at]);
                start = at + 1;
            }
            _ => {}
        }
    }
    pieces.push(&body[start..]);
    pieces
        .into_iter()
        .map(|piece| piece.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|piece| piece.starts_with(&format!("{column} ")))
        .unwrap_or_default()
}

/// A `TEXT` column the declaration alone shows is not prose: a key into another table (an id, a
/// lookup's code, a hash), a generated constant, a closed list, JSON, a date or an instant.
fn is_structural(connection: &Connection, table: &str, column: &str) -> bool {
    // A lookup table is a fixed vocabulary written only by a migration; a column that is part of
    // any foreign key names a row of another table.
    let keyed: bool = connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_foreign_key_list(?1) WHERE \"from\" = ?2)",
            [table, column],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if keyed || LOOKUP_TABLES.contains(&table) {
        return true;
    }
    if column == "id" || column == "kind" || column.ends_with("_id") || column.ends_with("_kind") {
        return true;
    }
    let sql = table_sql(connection, table)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let own = column_definition(&sql, column);
    own.contains("REFERENCES")
        || own.contains("GENERATED")
        || own.contains(&format!("{column} IN ("))
        || sql.contains(&format!("{column} IN ("))
        || sql.contains(&format!("json_valid({column})"))
        || sql.contains(&format!("date({column})"))
        || sql.contains(&format!("length({column}) = 64"))
        || ["%Y-%m-%dT%H:%M:%fZ", "%Y-%m-%dT%H:%M"]
            .iter()
            .any(|shape| sql.contains(&format!("strftime('{shape}', {column}) IS {column}")))
}

fn why_of(table: &str, column: &str) -> Option<&'static Text> {
    TEXT.iter()
        .find(|(t, c, _)| *t == table && *c == column)
        .map(|(_, _, why)| why)
}

/// The two writers of what the index holds: the live text and the earlier versions' words.
const TEXT_OF: &str = concat!(
    include_str!("../src/index/text.rs"),
    include_str!("../src/index/past.rs")
);

/// What a text column is, when the declaration alone does not say.
enum Text {
    /// A member's words: `index::text_of` (or the earlier-versions writer) reads it.
    Found,
    /// Ciphertext or a sealed file's cell: never read by any index.
    Sealed,
    /// Not prose a member searches, and why.
    Not(&'static str),
}

/// Every `TEXT` column of the vault file and of the index file that is not structural by its
/// declaration. A column added to the schema fails the test until it is placed here.
const TEXT: &[(&str, &str, Text)] = &[
    ("entity", "title", Text::Found),
    (
        "entity",
        "arrived_label",
        Text::Not("a file or device name an item came in with, cut to a length, never content"),
    ),
    ("action_key", "key", Text::Not("an act's correlation token")),
    (
        "action_key",
        "asked",
        Text::Not("a digest of what an act asked"),
    ),
    (
        "vault",
        "name",
        Text::Not("the vault's own name, one per file and not an entity"),
    ),
    ("vault", "zone", Text::Not("a time zone name")),
    ("vault", "currency", Text::Not("an ISO code")),
    (
        "concept",
        "key",
        Text::Not("the folded form of the title, which is found in what it labels"),
    ),
    ("container", "icon", Text::Not("an icon key")),
    ("origin", "ref", Text::Not("the source's own key")),
    (
        "origin",
        "label",
        Text::Not("the name of a followed store, not something a member wrote about a thing"),
    ),
    (
        "origin",
        "cursor",
        Text::Not("a platform's change token, opaque to the vault"),
    ),
    (
        "source",
        "stated_title",
        Text::Not("a copy of what a store called the record; the live title is the entity's"),
    ),
    (
        "revision",
        "cause",
        Text::Not("the name of the command that made the change"),
    ),
    (
        "revision_blob",
        "slot",
        Text::Not("which column a kept blob was in"),
    ),
    ("revision_blob", "media_type", Text::Not("a MIME type")),
    ("derivative", "media_type", Text::Not("a MIME type")),
    ("derivative", "text", Text::Found),
    (
        "person",
        "sort_name",
        Text::Not("derived from the name for ordering"),
    ),
    ("person", "given", Text::Found),
    ("person", "family", Text::Found),
    ("person", "phonetic", Text::Found),
    ("person", "nickname", Text::Found),
    ("person", "role", Text::Found),
    ("person", "org", Text::Found),
    ("person", "met", Text::Found),
    ("person_date", "label", Text::Found),
    ("contact_point", "value", Text::Found),
    ("contact_point", "label", Text::Found),
    (
        "contact_point",
        "normalized",
        Text::Not("the value normalised for matching a duplicate"),
    ),
    ("place", "address", Text::Found),
    ("place", "locality", Text::Found),
    ("place", "zone", Text::Not("a time zone name")),
    ("event", "description", Text::Found),
    ("event", "location", Text::Found),
    ("event", "url", Text::Found),
    ("event", "rule", Text::Not("an RFC 5545 rule")),
    ("event", "zone", Text::Not("a time zone name")),
    ("event_guest", "address", Text::Found),
    ("event_guest", "name", Text::Found),
    ("occurrence", "title", Text::Found),
    ("occurrence", "description", Text::Found),
    ("occurrence", "location", Text::Found),
    ("occurrence", "url", Text::Found),
    ("occurrence", "zone", Text::Not("a time zone name")),
    ("task", "description", Text::Found),
    ("task", "url", Text::Found),
    ("task", "rule", Text::Not("an RFC 5545 rule")),
    ("task", "zone", Text::Not("a time zone name")),
    ("note", "body", Text::Found),
    (
        "note_asset",
        "name",
        Text::Not("a file name of a picture placed in a note"),
    ),
    ("note_asset", "media_type", Text::Not("a MIME type")),
    (
        "mention",
        "wikilink",
        Text::Not("the title in a note's `[[words]]`: a copy of `note.body`, which is found"),
    ),
    ("document", "media_type", Text::Not("a MIME type")),
    ("photo", "media_type", Text::Not("a MIME type")),
    ("photo", "burst", Text::Not("a group key the camera minted")),
    ("account", "currency", Text::Not("an ISO code")),
    ("txn", "original_currency", Text::Not("an ISO code")),
    ("budget", "month", Text::Not("a month")),
    (
        "rule",
        "display_name",
        Text::Not(
            "a rule is not an entity; the name it gives lands on the line's title, which is found",
        ),
    ),
    ("touch", "notes", Text::Found),
    ("workout", "notes", Text::Found),
    (
        "workout",
        "recorded_by",
        Text::Not("the name of the device that recorded it"),
    ),
    (
        "thread",
        "scope",
        Text::Not("the key of the screen a chat belongs to"),
    ),
    ("message", "text", Text::Found),
    (
        "message_attachment",
        "label",
        Text::Not("a pasted image's own name; a photo's or document's title is read live"),
    ),
    (
        "message_card",
        "qualifier",
        Text::Not("a closed code of at most 24 letters that names no word of the item"),
    ),
    ("locker_item_field", "value_text", Text::Found),
    ("locker_item_field", "value_sealed", Text::Sealed),
    (
        "locker_item_field",
        "field_key",
        Text::Not("a built-in field's key, a token"),
    ),
    (
        "locker_item_field",
        "section",
        Text::Not("a field's group name; out of search by owner decision D11"),
    ),
    (
        "locker_item_field",
        "label",
        Text::Not("a field's name; out of search by owner decision D11"),
    ),
    ("locker_item_passkey", "private_key", Text::Sealed),
    ("locker_item_passkey", "rp_id", Text::Found),
    (
        "locker_item_passkey",
        "user_handle",
        Text::Not("a relying party's opaque handle"),
    ),
    (
        "locker_item_passkey",
        "display_name",
        Text::Not("the relying party's account label"),
    ),
    (
        "locker_item_passkey",
        "algorithm",
        Text::Not("a signature algorithm name"),
    ),
    (
        "edge",
        "rel",
        Text::Not("a relation: the vocabulary is `edge_shape`, which a trigger holds the edge to"),
    ),
    ("txn", "memo", Text::Found),
    ("txn_split", "memo", Text::Found),
    ("revision", "body", Text::Found),
    (
        "reading",
        "context",
        Text::Not(
            "a reading is not an item a member searches: no title, never queued for the index",
        ),
    ),
    (
        "search_owed",
        "after",
        Text::Not("a cursor in id order over what a label feeds, not prose"),
    ),
    ("alert", "reminder_id", Text::Not("a reminder's id")),
    (
        "alert",
        "timing",
        Text::Not("how `fire_key` reads: fixed or floating"),
    ),
    (
        "alert",
        "fire_key",
        Text::Not("an instant or a wall clock the writer computed"),
    ),
    ("index_state", "built_at", Text::Not("an instant")),
    (
        "search_word",
        "word",
        Text::Not("the index's own vocabulary, kept as a list"),
    ),
    (
        "index_state",
        "self_id",
        Text::Not("the id of the vault this file belongs to"),
    ),
];

#[test]
fn every_text_column_is_findable_sealed_or_argued_out() {
    let w = World::new("commit_text");
    read(&w, |connection| {
        // The control: a prose column is not structural and a key is, so an empty answer below
        // means every column was looked at and placed.
        assert!(!is_structural(connection, "note", "body"));
        assert!(!is_structural(connection, "entity", "title"));
        assert!(
            is_structural(connection, "task", "parent_task_id")
                || is_structural(connection, "entity", "parent_id")
        );
        // The vault file and the attached index file, table by table.
        let mut seen = BTreeSet::new();
        let mut unplaced = Vec::new();
        let mut redundant = Vec::new();
        for schema in ["main", "ix"] {
            let names: Vec<String> = connection
                .prepare(&format!(
                    "SELECT name FROM {schema}.sqlite_master
                      WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                        AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name"
                ))?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for table in names {
                if schema == "ix"
                    && ["geo_node", "geo_parent", "geo_rowid"].contains(&table.as_str())
                    || table.starts_with("search_")
                        && table != "search_word"
                        && table != "search_owed"
                {
                    continue;
                }
                let sql: String = connection.query_row(
                    &format!("SELECT sql FROM {schema}.sqlite_master WHERE name = ?1"),
                    [&table],
                    |row| row.get(0),
                )?;
                let columns: Vec<(String, String)> = connection
                    .prepare(&format!(
                        "SELECT name, type FROM pragma_table_xinfo('{table}', '{schema}')"
                    ))?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                let _ = sql;
                for (column, declared) in columns {
                    if !declared.eq_ignore_ascii_case("TEXT") {
                        continue;
                    }
                    seen.insert((table.clone(), column.clone()));
                    let placed = TEXT.iter().any(|(t, c, _)| *t == table && *c == column);
                    let structural = schema == "main" && is_structural(connection, &table, &column);
                    if !placed && !structural {
                        unplaced.push(format!("{table}.{column}"));
                    }
                    if placed && structural && matches!(why_of(&table, &column), Some(Text::Not(_)))
                    {
                        redundant.push(format!("{table}.{column}"));
                    }
                }
            }
        }
        assert!(
            unplaced.is_empty(),
            "a text column is neither structural by its declaration nor placed in TEXT: index it, seal it or argue it out: {unplaced:?}"
        );
        assert!(
            redundant.is_empty(),
            "structural by their declarations, so they need no line in TEXT: {redundant:?}"
        );
        let stale: Vec<String> = TEXT
            .iter()
            .filter(|(t, c, _)| !seen.contains(&((*t).to_owned(), (*c).to_owned())))
            .map(|(t, c, _)| format!("{t}.{c}"))
            .collect();
        assert!(
            stale.is_empty(),
            "in TEXT and not a TEXT column of the files: {stale:?}"
        );
        for (table, column, why) in TEXT {
            // A column called findable is one the index's text or past-words writer reads.
            if matches!(why, Text::Found) {
                assert!(
                    TEXT_OF.contains(&format!("\"{column}\"")) || TEXT_OF.contains(column),
                    "{table}.{column} is called findable and no text writer names `{column}`"
                );
            }
            if let Text::Not(reason) = why {
                assert!(
                    !reason.is_empty(),
                    "{table}.{column} is argued out without a reason"
                );
            }
        }
        Ok(())
    });
}

/// The earlier versions' words and the live text are one list of what a member typed: every column
/// the past index reads is one the census calls findable.
#[test]
fn every_column_the_past_index_reads_is_findable() {
    for (table, columns) in centraid_vault::index::EARLIER_COLUMNS {
        for column in *columns {
            assert!(
                TEXT.iter()
                    .any(|(t, c, why)| t == table && c == column && matches!(why, Text::Found)),
                "{table}.{column} is read for earlier versions and is not findable in TEXT"
            );
        }
    }
}

/// The control: a sealed cell is never named by either writer as text, and a column of the census
/// that is sealed is one `text_of` is told to leave alone.
#[test]
fn a_sealed_column_is_named_by_neither_text_writer_as_text() {
    for (table, column, why) in TEXT {
        if matches!(why, Text::Sealed) {
            let reads = TEXT_OF
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .any(|line| {
                    line.contains(&format!("{column} FROM"))
                        || line.contains(&format!("SELECT {column}"))
                });
            assert!(
                !reads,
                "{table}.{column} is sealed and a text writer selects it"
            );
        }
    }
}
