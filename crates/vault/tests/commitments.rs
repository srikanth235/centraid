//! The model's commitments, each read off the file the vault founded.
//!
//! Every test asks the database (`PRAGMA`, `sqlite_master`, the rows) and
//! compares the answer with the Rust enums in `model.rs`, so a table added
//! without a decision, a delete rule changed on one side only, or an index a
//! command forgot to keep is red here before it ships
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135),
//! `docs/vault-ontology.md`).

mod common;

use std::collections::{BTreeMap, BTreeSet};

use centraid_vault::commands::Registry;
use centraid_vault::index;
use centraid_vault::model::{Kind, Rel, fold_label};
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use rusqlite::Connection;
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00.000Z";

fn founded(seed: &str) -> common::Scratch {
    common::Scratch::founded(seed).expect("a founded vault")
}

fn read<T>(vault: &Vault, body: impl FnOnce(&Connection) -> centraid_vault::Result<T>) -> T {
    vault.read(body).expect("reads")
}

/// The words quoted inside the first `<column> IN (...)` of a statement.
fn in_list(sql: &str, column: &str) -> BTreeSet<String> {
    let sql = &sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let marker = format!("{column} IN (");
    let start = sql
        .find(&marker)
        .unwrap_or_else(|| panic!("no `{marker}` in {sql}"))
        + marker.len();
    let end = start + sql[start..].find(')').expect("a closing parenthesis");
    sql[start..end]
        .split(',')
        .map(|word| word.trim().trim_matches('\'').to_owned())
        .collect()
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

/// Every ordinary table of the file, without SQLite's own and the shadow
/// tables FTS5 keeps behind `search`.
fn tables(connection: &Connection) -> Vec<String> {
    connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("lists tables")
        .into_iter()
        .filter(|name| !name.starts_with("sqlite_") && !is_search_shadow(name))
        .collect()
}

fn is_search_shadow(name: &str) -> bool {
    [
        "search_data",
        "search_idx",
        "search_content",
        "search_docsize",
        "search_config",
    ]
    .contains(&name)
}

/// One foreign key, as `PRAGMA foreign_key_list` states it: `from` is the
/// comma-joined column list of a composite key.
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
                    row.get::<_, String>(3)?,
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
            for (joined, part) in [(&mut fk.from, from), (&mut fk.to, to)] {
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

// ---------------------------------------------------------------------------
// 1. One host per kind
// ---------------------------------------------------------------------------

#[test]
fn every_kind_has_exactly_one_host_and_the_hosts_are_exactly_the_composite_cascade_keys() {
    let scratch = founded("c1");
    read(&scratch.vault, |connection| {
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
            let sql = table_sql(connection, host);
            if host == "concept" || host == "container" {
                assert!(
                    sql.contains("kind      TEXT NOT NULL CHECK (kind IN ("),
                    "{host} carries its kind"
                );
            } else {
                assert!(
                    sql.contains(&format!(
                        "kind        TEXT GENERATED ALWAYS AS ('{host}') VIRTUAL"
                    )) || sql
                        .contains(&format!("kind TEXT GENERATED ALWAYS AS ('{host}') VIRTUAL"))
                        || sql
                            .replace("  ", " ")
                            .contains(&format!("GENERATED ALWAYS AS ('{host}') VIRTUAL")),
                    "{host} is its own kind, generated and never written"
                );
            }
        }
        // And no entity is born without a kind row's table to go to.
        let kinds: BTreeSet<String> = in_list(&table_sql(connection, "entity"), "kind");
        assert_eq!(
            kinds,
            Kind::ALL.iter().map(|k| k.as_str().to_owned()).collect()
        );
        Ok(())
    });
}

// ---------------------------------------------------------------------------
// 2. The trash pair
// ---------------------------------------------------------------------------

#[test]
fn the_trash_pair_lives_on_entity_and_on_the_lockers_own_item_only() {
    let scratch = founded("c2");
    read(&scratch.vault, |connection| {
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
        // R-1135-1-8: Locker's items are not entities and keep their own pair
        // (`locker_item`), because nothing outside Locker may name them.
        assert_eq!(holders, ["entity", "locker_item"].map(str::to_owned).into());
        Ok(())
    });
}

// ---------------------------------------------------------------------------
// 3. Every hash is a foreign key into blob
// ---------------------------------------------------------------------------

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[test]
fn every_column_holding_a_hash_is_a_foreign_key_into_blob_and_the_collector_sees_it() {
    let scratch = founded("c3");
    let vault = &scratch.vault;
    let hash = |label: &str| centraid_vault::blob::content_digest(label.as_bytes());
    vault
        .commit(|tx| {
            let c = tx.connection();
            for label in ["cover", "avatar", "doc", "photo", "rev", "orig", "d-out"] {
                centraid_vault::blob::stage(c, &hash(label), 1)?;
            }
            tx.insert_entity("book", Kind::Album, "Trip", AT)?;
            c.execute("INSERT INTO container (id, kind, cover) VALUES ('book', 'album', ?1)", [hash("cover")])?;
            tx.insert_entity("ada", Kind::Person, "Ada", AT)?;
            c.execute("INSERT INTO person (id, avatar) VALUES ('ada', ?1)", [hash("avatar")])?;
            tx.insert_entity("doc", Kind::Document, "Doc", AT)?;
            c.execute(
                "INSERT INTO document (id, blob, media_type) VALUES ('doc', ?1, 'text/plain')",
                [hash("doc")],
            )?;
            tx.insert_entity("ph", Kind::Photo, "Photo", AT)?;
            c.execute(
                "INSERT INTO photo (id, blob, media_type, form) VALUES ('ph', ?1, 'image/jpeg', 'photo')",
                [hash("photo")],
            )?;
            tx.insert_entity("n", Kind::Note, "Note", AT)?;
            c.execute("INSERT INTO note (id, body) VALUES ('n', 'x')", [])?;
            c.execute(
                "INSERT INTO revision (entity_id, seq, at, blob, media_type) VALUES ('n', 1, ?2, ?1, 'text/plain')",
                rusqlite::params![hash("rev"), AT],
            )?;
            centraid_vault::blob::write_derivative(
                c,
                AT,
                &hash("orig"),
                "thumb",
                Some((&hash("d-out"), 1, "image/jpeg")),
                None,
            )?;
            tx.insert_entity("th", Kind::Thread, "Chat", AT)?;
            c.execute(
                "INSERT INTO thread (id) VALUES ('th')",
                [],
            )?;
            Ok(())
        })
        .expect("populates");

    read(vault, |connection| {
        // What the schema says: foreign keys into blob(hash).
        let declared: BTreeSet<(String, String)> = foreign_keys(connection)
            .into_iter()
            .filter(|fk| fk.to_table == "blob")
            .inspect(|fk| assert_eq!(fk.to, "hash"))
            .map(|fk| (fk.table, fk.from))
            .collect();
        // What the rows say: every column of every table that holds a 64-hex
        // value, other than blob's own key.
        let mut populated = BTreeSet::new();
        for table in tables(connection) {
            if table == "blob" {
                continue;
            }
            let columns: Vec<String> = connection
                .prepare("SELECT name FROM pragma_table_info(?1) WHERE type = 'TEXT'")?
                .query_map([&table], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            for column in columns {
                let mut statement = connection.prepare(&format!(
                    "SELECT \"{column}\" FROM \"{table}\" WHERE \"{column}\" IS NOT NULL"
                ))?;
                let values = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if values.iter().any(|value| is_hash(value)) {
                    populated.insert((table.clone(), column));
                }
            }
        }
        assert!(
            populated.len() >= 7,
            "the fixture reaches every kind of hash column: {populated:?}"
        );
        assert!(
            populated.is_subset(&declared),
            "a column holds hashes and is not a foreign key into blob: {:?}",
            populated.difference(&declared).collect::<Vec<_>>()
        );
        // The collector walks the same list and no other.
        let seen: BTreeSet<(String, String)> = centraid_vault::blob::references(connection)?
            .into_iter()
            .map(|reference| (reference.table, reference.column))
            .collect();
        assert_eq!(
            seen, declared,
            "GC sees every reference the schema declares, from foreign_key_list alone"
        );
        Ok(())
    });
    // A blob nothing keeps alive goes, and so does what only it named: the
    // derivative cascades with `orig`, which frees `d-out` in the next pass.
    // Everything a plain reference names stays.
    vault
        .commit(|tx| {
            centraid_vault::blob::stage(tx.connection(), &hash("loose"), 1)?;
            Ok(())
        })
        .expect("stages");
    let gone: BTreeSet<String> = vault
        .collect_blobs()
        .expect("collects")
        .into_iter()
        .collect();
    assert_eq!(gone, ["loose", "orig", "d-out"].map(hash).into());
    let kept = read(vault, |c| {
        Ok(c.query_row("SELECT COUNT(*) FROM blob", [], |row| row.get::<_, i64>(0))?)
    });
    assert_eq!(kept, 5, "cover, avatar, doc, photo and rev");
}

// ---------------------------------------------------------------------------
// 4. Delete rules
// ---------------------------------------------------------------------------

#[test]
fn delete_rules_cascade_only_where_a_row_cannot_outlive_its_parent() {
    let scratch = founded("c4");
    read(&scratch.vault, |connection| {
        let hosts: BTreeSet<String> = Kind::ALL
            .iter()
            .map(|kind| kind.host().to_owned())
            .collect();
        // Child rows: they are a part of what they hang on.
        let child_rows: BTreeSet<(&str, &str)> = [
            ("checkpoint", "account"),
            ("contact_point", "person"),
            ("derivative", "blob"),
            ("locker_item_address", "locker_item"),
            ("locker_item_alias", "locker_item"),
            ("locker_item_field", "locker_item"),
            ("locker_item_passkey", "locker_item"),
            ("locker_tag", "locker_item"),
            ("measurement", "person"),
            ("message", "thread"),
            ("message_attachment", "message"),
            ("occurrence", "event"),
            ("workout", "activity"),
        ]
        .into();
        // An entity pointer that cascades: an edge dies with either end or its
        // label; a revision with its entity; a budget or a rule with its
        // category (a rule for a category that is gone has nothing to say).
        let entity_pointers: BTreeSet<(&str, &str)> = [
            ("edge", "from_id"),
            ("edge", "to_id"),
            ("edge", "label_id"),
            ("revision", "entity_id"),
            ("budget", "category_id,category_kind"),
            ("rule", "category_id,category_kind"),
        ]
        .into();
        let set_null: BTreeSet<(&str, &str)> = [
            ("message_attachment", "entity_id"),
            ("source", "entity_id,entity_kind"),
        ]
        .into();

        for fk in foreign_keys(connection) {
            let here = (fk.table.as_str(), fk.from.as_str());
            match fk.on_delete.as_str() {
                "CASCADE" if fk.to_table == "entity" && fk.from == "id,kind" => {
                    assert!(hosts.contains(&fk.table), "{fk:?}");
                }
                "CASCADE" if fk.to_table == "entity" => {
                    assert!(
                        entity_pointers.contains(&here),
                        "an entity pointer cascades and is not on the list: {fk:?}"
                    );
                }
                "CASCADE" => {
                    assert!(
                        child_rows.contains(&(fk.table.as_str(), fk.to_table.as_str())),
                        "a child row cascades and is not on the list: {fk:?}"
                    );
                }
                "SET NULL" => assert!(set_null.contains(&here), "{fk:?}"),
                // NO ACTION: the pointer keeps its target alive, and the
                // purge command says so in a sentence before SQLite would.
                "NO ACTION" => {}
                other => panic!("{fk:?}: `{other}` is not a delete rule this model uses"),
            }
        }
        // Every entry on the lists is real, so a list cannot rot.
        let actual = foreign_keys(connection);
        for (table, to_table) in &child_rows {
            assert!(actual.iter().any(|fk| fk.table == *table
                && fk.to_table == *to_table
                && fk.on_delete == "CASCADE"));
        }
        for (table, from) in entity_pointers.iter().chain(set_null.iter()) {
            assert!(
                actual
                    .iter()
                    .any(|fk| fk.table == *table && fk.from == *from)
            );
        }
        Ok(())
    });
}

// ---------------------------------------------------------------------------
// 5. Edges join only the kinds edge_shape names
// ---------------------------------------------------------------------------

/// The shapes `edge_shape` is seeded with, written out once more so the table,
/// the trigger and the spec are three witnesses of one list.
const SHAPES: [(&str, &str, &str); 13] = [
    ("contains", "album", "photo"),
    ("contains", "list", "person"),
    ("tagged", "*", "tag"),
    ("tagged", "*", "flag"),
    ("about", "note", "*"),
    ("about", "task", "*"),
    ("about", "event", "*"),
    ("links", "note", "*"),
    ("attached", "*", "document"),
    ("attached", "*", "photo"),
    ("attendee", "event", "person"),
    ("with", "activity", "person"),
    ("related", "person", "person"),
];

fn shape_allows(rel: &str, from: &str, to: &str) -> bool {
    SHAPES
        .iter()
        .any(|(r, f, t)| *r == rel && (*f == "*" || *f == from) && (*t == "*" || *t == to))
}

#[test]
fn an_edge_joins_exactly_the_kinds_edge_shape_names_for_every_relation_and_pair_of_kinds() {
    let scratch = founded("c5");
    // The enum and the CHECK agree.
    read(&scratch.vault, |connection| {
        let check = in_list(&table_sql(connection, "edge"), "rel");
        assert_eq!(
            check,
            Rel::ALL.iter().map(|rel| rel.as_str().to_owned()).collect()
        );
        let stored: BTreeSet<(String, String, String)> = connection
            .prepare("SELECT rel, from_kind, to_kind FROM edge_shape")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let spec: BTreeSet<(String, String, String)> = SHAPES
            .iter()
            .map(|(r, f, t)| ((*r).to_owned(), (*f).to_owned(), (*t).to_owned()))
            .collect();
        assert_eq!(stored, spec, "the seeded shapes are the spec's");
        Ok(())
    });

    // One entity per kind at each end, then every rel x kind x kind, attempted
    // inside a savepoint and compared with the oracle.
    scratch
        .vault
        .commit(|tx| {
            for kind in Kind::ALL {
                tx.insert_entity(&format!("from:{}", kind.as_str()), kind, "f", AT)?;
                tx.insert_entity(&format!("to:{}", kind.as_str()), kind, "t", AT)?;
            }
            let c = tx.connection();
            let mut tried = 0;
            for rel in Rel::ALL {
                for from in Kind::ALL {
                    for to in Kind::ALL {
                        c.execute_batch("SAVEPOINT shape")?;
                        let label = (rel == Rel::Related).then_some("to:relation");
                        let attempt = c.execute(
                            "INSERT INTO edge (from_id, rel, to_id, label_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                            rusqlite::params![
                                format!("from:{}", from.as_str()),
                                rel.as_str(),
                                format!("to:{}", to.as_str()),
                                label,
                                AT
                            ],
                        );
                        c.execute_batch("ROLLBACK TO shape; RELEASE shape")?;
                        assert_eq!(
                            attempt.is_ok(),
                            shape_allows(rel.as_str(), from.as_str(), to.as_str()),
                            "{} {} -> {}: {attempt:?}",
                            rel.as_str(),
                            from.as_str(),
                            to.as_str()
                        );
                        tried += 1;
                    }
                }
            }
            assert_eq!(tried, 8 * 25 * 25);
            // A label names a relation, and only `related` has one.
            let bad_label = c.execute(
                "INSERT INTO edge (from_id, rel, to_id, label_id, created_at) VALUES ('from:person', 'related', 'to:person', 'to:tag', ?1)",
                [AT],
            );
            assert!(bad_label.is_err(), "a label that is not a relation");
            Ok(())
        })
        .expect("runs");
}

// ---------------------------------------------------------------------------
// 6. The incremental index is the rebuilt one
// ---------------------------------------------------------------------------

/// Every `(term, entity.n, column, offset)` the index holds, through a
/// throwaway `fts5vocab` of type `instance`.
fn index_dump(vault: &Vault) -> BTreeSet<(String, i64, String, i64)> {
    vault
        .commit(|tx| {
            let c = tx.connection();
            c.execute_batch("CREATE VIRTUAL TABLE temp.search_instances USING fts5vocab(main, search, instance)")?;
            let rows = c
                .prepare("SELECT term, doc, col, \"offset\" FROM temp.search_instances")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()?;
            c.execute_batch("DROP TABLE temp.search_instances")?;
            Ok(rows)
        })
        .expect("dumps")
        .value
}

fn rebuilt(vault: &Vault) -> BTreeSet<(String, i64, String, i64)> {
    vault
        .commit(|tx| {
            index::rebuild(tx.connection())?;
            Ok(())
        })
        .expect("rebuilds");
    index_dump(vault)
}

fn run(
    vault: &Vault,
    registry: &Registry,
    name: &str,
    input: serde_json::Value,
) -> serde_json::Value {
    let outcome = vault
        .execute(
            registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
        .expect("runs");
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

fn script_every_search_relevant_command(scratch: &common::Scratch, registry: &Registry) {
    let vault = &scratch.vault;
    vault
        .commit(|tx| {
            common::add_person(tx, "ada", "Ada Lovelace", AT)?;
            common::add_person(tx, "bob", "Bob Barker", AT)?;
            tx.connection().execute(
                "INSERT INTO contact_point (id, person_id, kind, value, normalized, label, position) VALUES ('cp1', 'ada', 'email', 'ada@analytical.example', 'ada@analytical.example', 'work', 1)",
                [],
            )?;
            tx.touch("ada", AT)?;
            tx.insert_entity("n1", Kind::Note, "Engine", AT)?;
            tx.connection()
                .execute("INSERT INTO note (id, body) VALUES ('n1', 'a note on the analytical engine')", [])?;
            tx.insert_entity("n2", Kind::Note, "Lunch", AT)?;
            tx.connection()
                .execute("INSERT INTO note (id, body) VALUES ('n2', 'sandwiches')", [])?;
            Ok(())
        })
        .expect("seeds");
    run(
        vault,
        registry,
        "edge.add",
        json!({"from": "n1", "rel": "about", "to": "ada"}),
    );
    run(
        vault,
        registry,
        "edge.add",
        json!({"from": "n2", "rel": "about", "to": "bob"}),
    );
    run(
        vault,
        registry,
        "entity.retitle",
        json!({"id": "bob", "title": "Robert Barker"}),
    );
    // A body edit through a commit that touches, as an edit command will.
    vault
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE note SET body = 'a note on the difference engine' WHERE id = 'n1'",
                [],
            )?;
            tx.touch("n1", AT)
        })
        .expect("edits");
    // The note verbs: an edit that changes the words, a restore of the words it
    // replaced, and a note born with words that link.
    run(
        vault,
        registry,
        "note.edit",
        json!({"id": "n2", "body": "sandwiches and soup"}),
    );
    run(
        vault,
        registry,
        "note.restore_version",
        json!({"id": "n2", "seq": 1}),
    );
    run(
        vault,
        registry,
        "note.create",
        json!({"id": "n3", "title": "Ledger", "body": "[[Lunch]] on the ledger"}),
    );
    run(
        vault,
        registry,
        "edge.remove",
        json!({"from": "n2", "rel": "about", "to": "bob"}),
    );
    run(
        vault,
        registry,
        "tag.add",
        json!({"id": "n1", "label": "history"}),
    );
    run(vault, registry, "entity.trash", json!({"id": "n2"}));
    run(vault, registry, "entity.restore", json!({"id": "n2"}));
    run(vault, registry, "entity.trash", json!({"id": "n1"}));
    run(
        vault,
        registry,
        "person.merge",
        json!({"from": "bob", "into": "ada"}),
    );
    run(
        vault,
        registry,
        "follow.contacts",
        json!({"origin": {"ref": "i", "label": "i"}, "complete": true, "records": [
            {"external_id": "c1", "fields": {"title": "Grace Hopper", "role": "admiral"}}
        ]}),
    );
    run(vault, registry, "entity.purge", json!({"id": "n1"}));
    // People's verbs, each person's last word being the verb under test so
    // nothing after it re-indexes them and hides a missing touch.
    for (id, title) in [
        ("cy", "Cy Twombly"),
        ("di", "Di Arbus"),
        ("ed", "Ed Ruscha"),
    ] {
        run(
            vault,
            registry,
            "person.add",
            json!({"id": id, "title": title, "role": "painter"}),
        );
    }
    run(
        vault,
        registry,
        "person.add_note",
        json!({"id": "cy", "text": "likes large canvases"}),
    );
    run(
        vault,
        registry,
        "person.log_interaction",
        json!({"id": "cy", "kind": "call", "text": "talked about Rome"}),
    );
    run(
        vault,
        registry,
        "person.add_relationship",
        json!({"id": "cy", "name": "Mum", "kind": "mother"}),
    );
    run(
        vault,
        registry,
        "person.add_date",
        json!({"id": "cy", "label": "Anniversary", "month_day": "06-01"}),
    );
    run(
        vault,
        registry,
        "person.edit",
        json!({"id": "cy", "nickname": "Cy"}),
    );
    run(
        vault,
        registry,
        "person.save_contact_point",
        json!({"id": "di", "kind": "phone", "value": "+1 555 010 0199"}),
    );
    let point = run(
        vault,
        registry,
        "person.save_contact_point",
        json!({"id": "ed", "kind": "email", "value": "ed@ruscha.example"}),
    );
    run(
        vault,
        registry,
        "person.remove_contact_point",
        json!({"point_id": point["point_id"]}),
    );
    run(
        vault,
        registry,
        "person.save_contact_point",
        json!({"id": "di", "kind": "email", "value": "di@arbus.example", "label": "work"}),
    );
    for points in [
        json!([{"kind": "phone", "value": "+44 20 7946 0958"}]),
        json!([{"kind": "phone", "value": "+44 20 7946 0958"}, {"kind": "email", "value": "grace@navy.example"}]),
    ] {
        run(
            vault,
            registry,
            "follow.contacts",
            json!({"origin": {"ref": "i", "label": "i"}, "records": [
                {"external_id": "c1", "fields": {"points": points}}
            ]}),
        );
    }
    // Last, so no later command re-indexes it and hides a missing touch.
    run(
        vault,
        registry,
        "entity.retitle",
        json!({"id": "n2", "title": "Brunch"}),
    );
    // And the note verbs' own last word: nothing after it re-indexes n3.
    run(
        vault,
        registry,
        "note.edit",
        json!({"id": "n3", "body": "[[Brunch]] and the final words of the ledger"}),
    );
}

#[test]
fn the_incremental_index_equals_a_rebuild_after_every_search_relevant_command() {
    let scratch = founded("c6");
    let registry = Registry::with_system_commands().expect("a registry");
    script_every_search_relevant_command(&scratch, &registry);
    let incremental = index_dump(&scratch.vault);
    assert!(!incremental.is_empty(), "the script left something to find");
    let rebuilt = rebuilt(&scratch.vault);
    assert_eq!(
        incremental, rebuilt,
        "a command changed searchable text and did not touch"
    );
}

#[test]
fn an_edit_that_forgets_to_touch_is_caught_by_the_same_comparison() {
    // The seeded red: write a body and never touch, and the comparison fails.
    let scratch = founded("c6-red");
    scratch
        .vault
        .commit(|tx| {
            tx.insert_entity("n", Kind::Note, "Note", AT)?;
            tx.connection()
                .execute("INSERT INTO note (id, body) VALUES ('n', 'before')", [])?;
            Ok(())
        })
        .expect("creates");
    scratch
        .vault
        .commit(|tx| {
            tx.connection()
                .execute("UPDATE note SET body = 'after' WHERE id = 'n'", [])?;
            Ok(())
        })
        .expect("edits without touching");
    let incremental = index_dump(&scratch.vault);
    assert_ne!(
        incremental,
        rebuilt(&scratch.vault),
        "an untouched edit leaves the index stale, and the comparison sees it"
    );
}

// ---------------------------------------------------------------------------
// 7. Concept and container lists, folded keys
// ---------------------------------------------------------------------------

#[test]
fn concept_and_container_check_lists_are_the_enums_and_seed_keys_are_folded() {
    let scratch = founded("c7");
    read(&scratch.vault, |connection| {
        assert_eq!(
            in_list(&table_sql(connection, "concept"), "kind"),
            Kind::CONCEPTS
                .iter()
                .map(|k| k.as_str().to_owned())
                .collect()
        );
        assert_eq!(
            in_list(&table_sql(connection, "container"), "kind"),
            Kind::CONTAINERS
                .iter()
                .map(|k| k.as_str().to_owned())
                .collect()
        );
        let seeds: Vec<(String, String)> = connection
            .prepare("SELECT id, kind FROM entity WHERE id LIKE kind || ':%'")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        assert!(
            seeds.len() > 20,
            "founding seeds the flags, categories and kinds"
        );
        for (id, kind) in seeds {
            let key = &id[kind.len() + 1..];
            assert!(
                Kind::parse(&kind).is_some_and(|k| k.is_concept() || k == Kind::Calendar),
                "{id}: a seed id belongs to a concept (or the default calendar)"
            );
            assert_eq!(fold_label(key), key, "{id}: a seeded key is already folded");
        }
        Ok(())
    });
}

// ---------------------------------------------------------------------------
// 8. Nothing outside the spec is founded
// ---------------------------------------------------------------------------

#[test]
fn the_founded_file_holds_the_spec_s_tables_and_nothing_else() {
    let scratch = founded("c8");
    let expected: BTreeSet<&str> = [
        // the kernel
        "vault",
        "entity",
        "edge",
        "edge_shape",
        "concept",
        "container",
        "blob",
        "derivative",
        "origin",
        "source",
        "revision",
        "journal",
        "search",
        "search_vocab",
        // the kinds' own rows and their children
        "person",
        "contact_point",
        "place",
        "event",
        "occurrence",
        "task",
        "activity",
        "workout",
        "measurement",
        "note",
        "document",
        "photo",
        "account",
        "txn",
        "budget",
        "checkpoint",
        "rule",
        "thread",
        "message",
        "message_attachment",
        // Locker, which is not an entity kind
        "locker_item",
        "locker_tag",
        "locker_item_address",
        "locker_item_alias",
        "locker_item_field",
        "locker_item_passkey",
        "locker_key",
        "receipt",
    ]
    .into();
    read(&scratch.vault, |connection| {
        let found: BTreeSet<String> = tables(connection).into_iter().collect();
        let found: BTreeSet<&str> = found.iter().map(String::as_str).collect();
        assert_eq!(
            found.difference(&expected).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "a table the spec does not name was founded"
        );
        assert_eq!(
            expected.difference(&found).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "a table the spec names was not founded"
        );
        Ok(())
    });
}
