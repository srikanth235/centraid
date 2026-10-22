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
fn the_trash_pair_lives_on_entity_only() {
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
        // A Locker item is an entity of its own kind (#1135, the Locker lane):
        // its trash pair is its entity's, like every kind's.
        assert_eq!(holders, ["entity"].map(str::to_owned).into());
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
            assert_eq!(tried, 8 * Kind::ALL.len() * Kind::ALL.len());
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
    // Agenda's verbs, each row's last word being the verb under test.
    run(
        vault,
        registry,
        "container.create",
        json!({"id": "pr", "kind": "project", "title": "Garden"}),
    );
    for (id, title) in [("t1", "Prune"), ("t2", "Sow"), ("t3", "Water")] {
        run(
            vault,
            registry,
            "task.add",
            json!({"id": id, "title": title, "project_id": "pr", "due": "2026-03-02"}),
        );
    }
    run(
        vault,
        registry,
        "task.edit",
        json!({"id": "t1", "description": "the roses"}),
    );
    run(
        vault,
        registry,
        "task.organize",
        json!({"id": "t2", "project_id": null}),
    );
    run(vault, registry, "task.cancel", json!({"id": "t3"}));
    run(vault, registry, "task.complete", json!({"id": "t3"}));
    for (id, title) in [("e1", "Dentist"), ("e2", "Standup"), ("e3", "Picnic")] {
        run(
            vault,
            registry,
            "event.propose",
            json!({"id": id, "title": title, "starts": "2026-03-0".to_owned() + &id[1..] + "T10:00", "busy": false}),
        );
    }
    run(
        vault,
        registry,
        "event.edit",
        json!({"id": "e1", "description": "bring the x-rays"}),
    );
    run(vault, registry, "event.cancel", json!({"id": "e2"}));
    run(
        vault,
        registry,
        "event.edit",
        json!({"id": "e3", "attendees": ["cy"]}),
    );
    run(
        vault,
        registry,
        "event.respond",
        json!({"id": "e3", "person_id": "cy", "state": "accepted"}),
    );
    // A project's rename reaches the tasks filed under it; last of its kind.
    run(
        vault,
        registry,
        "entity.retitle",
        json!({"id": "pr", "title": "Allotment"}),
    );
    // A LOCKER ITEM IS AN ENTITY AND IS INDEXED BY ITS PLAIN TEXT ONLY: scripting
    // its commands here is what holds "incremental equals rebuilt" over a kind
    // whose text is its title, plain cells, aliases, addresses, tags and notes.
    run(
        vault,
        registry,
        "locker.add_item",
        json!({"item_id": "lk1", "type": "login", "title": "Vaultbank", "username": "sealedname",
               "alias": "vb-main", "notes": "ask for Wilhelmina"}),
    );
    run(
        vault,
        registry,
        "tag.add",
        json!({"id": "lk1", "label": "Vaulttag"}),
    );
    run(
        vault,
        registry,
        "flag.set",
        json!({"id": "lk1", "flag": "starred"}),
    );
    run(
        vault,
        registry,
        "locker.set_addresses",
        json!({"item_id": "lk1", "addresses": [{"url": "https://vaultbank.example/login"}]}),
    );
    run(
        vault,
        registry,
        "locker.set_memo",
        json!({"item_id": "lk1", "note": "branch closes early on fridays"}),
    );
    run(
        vault,
        registry,
        "note.create",
        json!({"id": "lkn", "title": "Teller", "body": "the teller is called Ottoline"}),
    );
    run(
        vault,
        registry,
        "edge.add",
        json!({"from": "lkn", "rel": "about", "to": "lk1"}),
    );
    run(
        vault,
        registry,
        "edge.add",
        json!({"from": "n3", "rel": "links", "to": "lk1"}),
    );
    run(
        vault,
        registry,
        "entity.retitle",
        json!({"id": "lk1", "title": "Vaultbank Savings"}),
    );
    run(
        vault,
        registry,
        "locker.edit_item",
        json!({"item_id": "lk1", "username": "other", "notes": "ask for Wilhelmina"}),
    );
    // A purged item takes its words with it, and only its own realm's.
    run(
        vault,
        registry,
        "locker.add_item",
        json!({"item_id": "lk2", "type": "login", "title": "Doomedsafe", "username": "gonename"}),
    );
    run(vault, registry, "entity.trash", json!({"id": "lk2"}));
    run(vault, registry, "entity.purge", json!({"id": "lk2"}));
    run(vault, registry, "entity.trash", json!({"id": "lk1"}));
    run(vault, registry, "entity.restore", json!({"id": "lk1"}));
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
    // The positive control: a Locker item's plain text IS findable, so the
    // equality below compares an index that holds it.
    let held = vocabulary(&scratch.vault);
    for word in [
        "vaultbank",
        "savings",
        "vaulttag",
        "other",
        "wilhelmina",
        "vb",
        "ottoline",
        "fridays",
        "https",
    ] {
        assert!(
            held.contains(word),
            "`{word}` of a Locker item is not in the index: {held:?}"
        );
    }
    assert!(
        !held.contains("doomedsafe") && !held.contains("gonename"),
        "a purged Locker item's words are still in the index"
    );
    // The word list holds every word the index does, and may hold more: a word
    // an edit dropped stays until a purge of something that held it or a rebuild.
    let (terms, words) = (vocabulary(&scratch.vault), word_list(&scratch.vault));
    assert_eq!(
        terms.difference(&words).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "the index holds a word the word list does not"
    );
    let rebuilt = rebuilt(&scratch.vault);
    assert_eq!(
        incremental, rebuilt,
        "a command changed searchable text and did not touch"
    );
    // A rebuild rewrites the list from the rows: it is exactly the index's
    // vocabulary, and no word the incremental list did not have.
    let again = word_list(&scratch.vault);
    assert_eq!(again, vocabulary(&scratch.vault));
    assert_eq!(
        again.difference(&words).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "a rebuilt list is a subset of the incremental one"
    );
}

/// Every term of the index's vocabulary.
fn vocabulary(vault: &Vault) -> BTreeSet<String> {
    read(vault, |connection| {
        Ok(connection
            .prepare("SELECT term FROM search_vocab")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    })
}

/// Every word of the word list.
fn word_list(vault: &Vault) -> BTreeSet<String> {
    read(vault, |connection| {
        Ok(connection
            .prepare("SELECT word FROM search_word")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    })
}

#[test]
fn the_word_list_gains_a_word_on_index_and_loses_it_on_a_purge_or_a_rebuild() {
    let scratch = founded("c6-words");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let go = |name: &str, input: serde_json::Value| run(vault, &registry, name, input);
    let has = |word: &str| word_list(vault).contains(word);

    go(
        "note.create",
        json!({"id": "a", "title": "Zeppelin", "body": "Café au lait, o'brien 3.14"}),
    );
    go(
        "note.create",
        json!({"id": "b", "title": "Blimp", "body": "au lait only"}),
    );
    for word in [
        "zeppelin", "cafe", "au", "lait", "o", "brien", "3", "14", "blimp", "only",
    ] {
        assert!(has(word), "{word} is indexed and in the list");
    }
    assert_eq!(word_list(vault), vocabulary(vault));

    // An edit that drops a word leaves it in the list: it still costs nothing to
    // offer a word the index no longer holds, and finding out is not free.
    go("note.edit", json!({"id": "a", "body": "au lait"}));
    assert!(!vocabulary(vault).contains("cafe"));
    assert!(has("cafe"), "an edit leaves the dropped word in the list");

    // A purge takes the words the entity holds that no other row holds, and keeps
    // those another row does. It cannot name a word an edit dropped earlier.
    go("entity.trash", json!({"id": "a"}));
    go("entity.purge", json!({"id": "a"}));
    assert!(!has("zeppelin"), "its own title goes");
    assert!(has("au") && has("lait"), "a word another note holds stays");
    assert!(
        has("cafe"),
        "a word an edit dropped is not the purge's to name"
    );

    // Only a rebuild rewrites the list from the rows.
    go("note.edit", json!({"id": "b", "body": "au only"}));
    assert!(has("lait"));
    rebuilt(vault);
    assert!(!has("lait") && !has("cafe"));
    assert_eq!(word_list(vault), vocabulary(vault));
}

/// The words filed under one realm.
fn realm_words(vault: &Vault, realm: &str) -> BTreeSet<String> {
    read(vault, |connection| {
        Ok(connection
            .prepare("SELECT word FROM search_word WHERE realm = ?1")?
            .query_map([realm], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    })
}

#[test]
fn a_word_is_filed_under_the_realm_of_the_kind_that_holds_it_and_a_purge_keeps_the_other() {
    let scratch = founded("c6-realms");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let go = |name: &str, input: serde_json::Value| run(vault, &registry, name, input);
    let vault_has = |word: &str| realm_words(vault, "vault").contains(word);
    let locker_has = |word: &str| realm_words(vault, "locker").contains(word);

    go(
        "note.create",
        json!({"id": "rn", "title": "Hangar", "body": "sharedword vaultonlyword"}),
    );
    go(
        "locker.add_item",
        json!({"item_id": "rl", "type": "login", "title": "Lockeronlyword",
               "username": "sharedword"}),
    );
    assert!(vault_has("sharedword") && vault_has("vaultonlyword") && vault_has("hangar"));
    assert!(locker_has("sharedword") && locker_has("lockeronlyword"));
    assert!(
        !vault_has("lockeronlyword"),
        "a word only Locker holds is not a word of the vault realm"
    );
    assert!(
        !locker_has("vaultonlyword"),
        "a word only the vault holds is not a word of the locker realm"
    );

    // Purging the note takes the vault realm's words and leaves Locker's own.
    go("entity.trash", json!({"id": "rn"}));
    go("entity.purge", json!({"id": "rn"}));
    assert!(!vault_has("sharedword"), "no vault row holds it any more");
    assert!(!vault_has("vaultonlyword"));
    assert!(locker_has("sharedword"), "the Locker item still holds it");

    // And the other way: a vault note that holds a word keeps it in its realm
    // when the Locker item that held it goes.
    go(
        "note.create",
        json!({"id": "rn2", "title": "Again", "body": "sharedword"}),
    );
    assert!(vault_has("sharedword"));
    go("entity.trash", json!({"id": "rl"}));
    go("entity.purge", json!({"id": "rl"}));
    assert!(!locker_has("sharedword") && !locker_has("lockeronlyword"));
    assert!(vault_has("sharedword"), "the note still holds it");
    assert_eq!(
        word_list(vault),
        vocabulary(vault)
            .union(&word_list(vault))
            .cloned()
            .collect()
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
        "search_word",
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

// ---------------------------------------------------------------------------
// 5 (second half). Following is a per-field three-way merge
// ---------------------------------------------------------------------------

fn follow_contact(
    vault: &Vault,
    registry: &Registry,
    role: &str,
    nickname: &str,
) -> serde_json::Value {
    run(
        vault,
        registry,
        "follow.contacts",
        json!({
            "origin": {"ref": "icloud", "label": "iCloud"},
            "complete": true,
            "records": [{
                "external_id": "c1",
                "fields": {"title": "Ada", "role": role, "nickname": nickname}
            }]
        }),
    )
}

fn person_field(vault: &Vault, id: &str, column: &str) -> String {
    read(vault, |connection| {
        Ok(connection.query_row(
            &format!("SELECT {column} FROM person WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )?)
    })
}

fn member_sets_nickname(vault: &Vault, id: &str, nickname: &str) {
    vault
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE person SET nickname = ?2 WHERE id = ?1",
                [id, nickname],
            )?;
            tx.touch(id, AT)?;
            Ok(())
        })
        .expect("the member edits");
}

#[test]
fn a_followed_row_merges_per_field_the_source_s_new_word_against_the_member_s_edit() {
    let scratch = founded("c5b");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    follow_contact(vault, &registry, "Engineer", "Ada");
    let id: String = read(vault, |connection| {
        Ok(connection.query_row(
            "SELECT entity_id FROM source WHERE external_id = 'c1'",
            [],
            |row| row.get(0),
        )?)
    });
    let stated = |vault: &Vault| -> serde_json::Value {
        let text: String = read(vault, |connection| {
            Ok(connection.query_row(
                "SELECT stated FROM source WHERE external_id = 'c1'",
                [],
                |row| row.get(0),
            )?)
        });
        serde_json::from_str(&text).expect("json")
    };

    // The member edits one field; the source then restates both.
    member_sets_nickname(vault, &id, "Countess");
    follow_contact(vault, &registry, "Mathematician", "Ada L.");
    assert_eq!(
        person_field(vault, &id, "role"),
        "Mathematician",
        "a field the member never edited takes the source's new value"
    );
    assert_eq!(
        person_field(vault, &id, "nickname"),
        "Countess",
        "a field the member edited keeps the member's value"
    );
    assert_eq!(
        stated(vault),
        json!({"title": "Ada", "role": "Mathematician", "nickname": "Ada L."}),
        "`source.stated` becomes the new statement, whatever the member did"
    );

    // Reverting to the stated value hands the field back to the source.
    member_sets_nickname(vault, &id, "Ada L.");
    follow_contact(vault, &registry, "Mathematician", "Ada Byron");
    assert_eq!(
        person_field(vault, &id, "nickname"),
        "Ada Byron",
        "a field equal to the stated value follows the source again"
    );
}

// ---------------------------------------------------------------------------
// 7 (second half). Nothing computable is stored
// ---------------------------------------------------------------------------

/// A column whose name says it holds a rollup or a derived figure: a balance, a
/// total, a count, a sum, an average, a typical value, a streak, a
/// `last_*_at` (matched on whole `_`-separated words, so `account_id` is not a
/// count), a lookup computed from another column, or a bare `value` that is
/// a real number (a figure, not a word).
fn names_a_computable(column: &str, declared: &str) -> bool {
    const WORDS: [&str; 10] = [
        "balance", "total", "count", "sum", "average", "avg", "typical", "streak", "mean",
        "locality",
    ];
    let last_at = column.starts_with("last_") && column.ends_with("_at");
    last_at
        || column.split('_').any(|token| WORDS.contains(&token))
        || (column == "value" && declared.eq_ignore_ascii_case("REAL"))
}

/// The columns the spec allows to hold what looks computable, each with its
/// reason. A new computable column fails the test until it is argued for here.
/// (`derivative` is the spec's other exception: it holds caches of a blob's
/// content, and no column of it is named like a rollup, so it needs no line.)
const STATED_NOT_COMPUTED: [(&str, &str, &str); 3] = [
    (
        "checkpoint",
        "balance_minor",
        "the bank's stated balance on a date: a statement, never recomputed from txn",
    ),
    (
        "measurement",
        "value",
        "the store's stated total (steps in a day): the store counted, the vault did not",
    ),
    (
        "place",
        "locality",
        "a derived lookup from the coordinates that the spec names, kept so a place reads offline",
    ),
];

#[test]
fn no_column_stores_a_rollup_except_the_stated_figures_the_spec_names() {
    let scratch = founded("c7b");
    read(&scratch.vault, |connection| {
        let mut flagged = BTreeSet::new();
        for table in tables(connection) {
            let mut columns = connection.prepare(&format!("PRAGMA table_info({table})"))?;
            let rows = columns.query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?;
            for row in rows {
                let (column, declared) = row?;
                if names_a_computable(&column, &declared) {
                    flagged.insert((table.clone(), column));
                }
            }
        }
        let allowed: BTreeSet<(String, String)> = STATED_NOT_COMPUTED
            .iter()
            .map(|(table, column, _)| ((*table).to_owned(), (*column).to_owned()))
            .collect();
        assert_eq!(
            flagged.difference(&allowed).collect::<Vec<_>>(),
            Vec::<&(String, String)>::new(),
            "a column that looks computed is stored; compute it on read, or argue for it in STATED_NOT_COMPUTED"
        );
        assert_eq!(
            allowed.difference(&flagged).collect::<Vec<_>>(),
            Vec::<&(String, String)>::new(),
            "an exception no longer matches a column; remove it"
        );
        Ok(())
    });
}

// ---------------------------------------------------------------------------
// 9. Every text column is findable, folded into what it labels, or argued out
// ---------------------------------------------------------------------------

/// How a text column reaches the index.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Reach {
    /// In the text of its own entity (`text_of`: its row and its children), or
    /// its title. A title also folds into the text of what it labels, and a
    /// note's body into what it is about; section 10 asks those.
    Own,
    /// Not indexed, and why.
    Not(&'static str),
}

/// The text columns a member types or a title names a group by, each with its
/// reach. Every other `TEXT` column of the file is structural (an id, an enum, a
/// date, a hash, JSON, a Locker cell) and the test below recognises it by its
/// declaration, so adding a text column fails here until it is placed.
const CENSUS: &[(&str, &str, Reach)] = &[
    ("entity", "title", Reach::Own),
    (
        "search_word",
        "word",
        Reach::Not("the index's own vocabulary, kept as a list"),
    ),
    ("person", "nickname", Reach::Own),
    ("person", "role", Reach::Own),
    ("person", "met", Reach::Own),
    (
        "person",
        "sort_name",
        Reach::Not("derived from the title for ordering"),
    ),
    ("contact_point", "value", Reach::Own),
    ("contact_point", "label", Reach::Own),
    (
        "contact_point",
        "normalized",
        Reach::Not("the value, normalised for matching a duplicate"),
    ),
    ("place", "address", Reach::Own),
    ("place", "locality", Reach::Own),
    ("place", "zone", Reach::Not("a time zone name, not prose")),
    ("event", "description", Reach::Own),
    ("event", "zone", Reach::Not("a time zone name, not prose")),
    ("event", "rule", Reach::Not("an RFC 5545 rule")),
    ("event", "url", Reach::Not("a link, not prose")),
    ("occurrence", "title", Reach::Own),
    ("occurrence", "description", Reach::Own),
    ("task", "description", Reach::Own),
    ("task", "rule", Reach::Not("an RFC 5545 rule")),
    ("task", "zone", Reach::Not("a time zone name, not prose")),
    ("note", "body", Reach::Own),
    (
        "document",
        "media_type",
        Reach::Not("a MIME type, not prose"),
    ),
    ("photo", "media_type", Reach::Not("a MIME type, not prose")),
    (
        "photo",
        "burst",
        Reach::Not("a group key the camera minted"),
    ),
    (
        "derivative",
        "media_type",
        Reach::Not("a MIME type, not prose"),
    ),
    ("derivative", "text", Reach::Own),
    (
        "revision",
        "body",
        Reach::Not("history: the note's current body is indexed, not its past"),
    ),
    (
        "revision",
        "media_type",
        Reach::Not("a MIME type, not prose"),
    ),
    (
        "thread",
        "scope",
        Reach::Not("the key of the screen a chat belongs to"),
    ),
    ("message", "text", Reach::Own),
    (
        "message_attachment",
        "label",
        Reach::Not("a copy of the attached thing's title, or a pasted image's name"),
    ),
    (
        "workout",
        "recorded_by",
        Reach::Not("the name of the device that recorded it"),
    ),
    (
        "origin",
        "label",
        Reach::Not("the name of an import source, not something a member wrote about a thing"),
    ),
    ("origin", "ref", Reach::Not("the source's own key")),
    (
        "concept",
        "key",
        Reach::Not("the folded form of the title, which is indexed in what it labels"),
    ),
    ("container", "color", Reach::Not("a colour token")),
    (
        "vault",
        "name",
        Reach::Not("the vault's own name, one per file and not an entity"),
    ),
    ("vault", "zone", Reach::Not("a time zone name, not prose")),
    ("journal", "command", Reach::Not("a command name")),
    (
        "journal",
        "detail",
        Reach::Not("a refusal's sentence, evidence rather than content"),
    ),
    ("account", "currency", Reach::Not("an ISO code")),
    ("txn", "currency", Reach::Not("an ISO code")),
    ("budget", "currency", Reach::Not("an ISO code")),
    ("budget", "month", Reach::Not("a month")),
    ("vault", "currency", Reach::Not("an ISO code")),
    ("activity", "starts", Reach::Not("an instant")),
    ("activity", "ends", Reach::Not("an instant")),
    ("event", "starts", Reach::Not("an instant")),
    ("event", "ends", Reach::Not("an instant")),
    ("occurrence", "original_start", Reach::Not("an instant")),
    ("occurrence", "starts", Reach::Not("an instant")),
    ("occurrence", "ends", Reach::Not("an instant")),
    ("journal", "at", Reach::Not("an instant")),
    ("revision", "at", Reach::Not("an instant")),
    // Locker: the plain cells a member sees in the list are found by; every
    // sealed cell is `lk1:` ciphertext and is never text (`SEALED_ITEM_CELLS`).
    ("locker_item", "username", Reach::Own),
    ("locker_item", "url", Reach::Own),
    ("locker_item", "notes", Reach::Own),
    ("locker_item", "fullname", Reach::Own),
    ("locker_item", "email", Reach::Own),
    ("locker_item", "phone", Reach::Own),
    ("locker_item", "brand", Reach::Own),
    ("locker_item", "memo", Reach::Own),
    ("locker_item_address", "url", Reach::Own),
    ("locker_item_alias", "alias", Reach::Own),
    (
        "locker_item",
        "password",
        Reach::Not("a sealed cell: ciphertext"),
    ),
    (
        "locker_item",
        "otp_seed",
        Reach::Not("a sealed cell: ciphertext"),
    ),
    (
        "locker_item",
        "card_number",
        Reach::Not("a sealed cell: ciphertext"),
    ),
    (
        "locker_item",
        "cvv",
        Reach::Not("a sealed cell: ciphertext"),
    ),
    (
        "locker_item",
        "content",
        Reach::Not("a sealed cell: ciphertext"),
    ),
    (
        "locker_item_field",
        "value_sealed",
        Reach::Not("a sealed custom field's value: ciphertext"),
    ),
    (
        "locker_item_passkey",
        "private_key",
        Reach::Not("a passkey's private key: ciphertext"),
    ),
    (
        "locker_item",
        "cardholder",
        Reach::Not("argued out: a card's face is read in the item, not searched for"),
    ),
    (
        "locker_item",
        "expiry",
        Reach::Not("a date on a card, not prose"),
    ),
    (
        "locker_item",
        "address",
        Reach::Not("a postal address of an identity; an owner question whether it is searched"),
    ),
    ("locker_item", "network", Reach::Not("a wifi network type")),
    (
        "locker_item_field",
        "section",
        Reach::Not("a custom field's group name; an owner question whether it is searched"),
    ),
    (
        "locker_item_field",
        "label",
        Reach::Not("a custom field's name; an owner question whether it is searched"),
    ),
    (
        "locker_item_field",
        "value_text",
        Reach::Not("a custom field's plain value; an owner question whether it is searched"),
    ),
    (
        "locker_item_passkey",
        "user_handle",
        Reach::Not("a relying party's opaque handle"),
    ),
    (
        "locker_item_passkey",
        "display_name",
        Reach::Not("the relying party's account label, shown on the item"),
    ),
    (
        "locker_item_passkey",
        "algorithm",
        Reach::Not("a signature algorithm name"),
    ),
    ("edge_shape", "rel", Reach::Not("a closed vocabulary")),
    ("source", "system", Reach::Not("a closed vocabulary")),
];

/// The text of one column's own definition inside a `CREATE TABLE`: the piece
/// between two commas at the top level of the parentheses.
fn column_definition(sql: &str, column: &str) -> String {
    let body = &sql[sql.find('(').map_or(0, |at| at + 1)..];
    let mut depth = 0_i32;
    let mut start = 0;
    let mut pieces = Vec::new();
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

/// A `TEXT` column the declaration alone shows is not prose: an id or a hash
/// (named by a key), an enum, JSON, a date, a generated constant. Locker's
/// tables are NOT exempt: its plain cells are findable and its sealed ones are
/// argued out by name, in [`CENSUS`].
fn is_structural(connection: &Connection, table: &str, column: &str) -> bool {
    if table == "receipt" {
        return true;
    }
    if column == "id"
        || column == "kind"
        || column.ends_with("_id")
        || column.ends_with("_kind")
        || column.ends_with("_at")
    {
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
        || sql.contains(&format!("datetime({column})"))
        || sql.contains(&format!("length({column}) = 64"))
}

#[test]
fn every_text_column_is_findable_folded_into_what_it_labels_or_argued_out() {
    let scratch = founded("c9");
    read(&scratch.vault, |connection| {
        let mut unplaced = Vec::new();
        let mut redundant = Vec::new();
        let mut seen = BTreeSet::new();
        for table in tables(connection) {
            let mut columns = connection.prepare(&format!("PRAGMA table_xinfo({table})"))?;
            let rows = columns
                .query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (column, declared) in rows {
                if !declared.eq_ignore_ascii_case("TEXT") {
                    continue;
                }
                seen.insert((table.clone(), column.clone()));
                let placed = CENSUS.iter().any(|(t, c, _)| *t == table && *c == column);
                if !placed && !is_structural(connection, &table, &column) {
                    unplaced.push(format!("{table}.{column}"));
                }
            }
        }
        assert_eq!(
            unplaced,
            Vec::<String>::new(),
            "a text column is neither structural nor placed in CENSUS: index it, fold it into what it labels, or argue it out"
        );
        for (table, column, _) in CENSUS {
            assert!(
                seen.contains(&((*table).to_owned(), (*column).to_owned())),
                "{table}.{column} is in CENSUS and is not a TEXT column of the file"
            );
            if is_structural(connection, table, column) {
                redundant.push(format!("{table}.{column}"));
            }
        }
        assert_eq!(
            redundant,
            Vec::<String>::new(),
            "structural by their declarations: they need no line in CENSUS"
        );
        Ok(())
    });
}

// ---------------------------------------------------------------------------
// 10. A label reaches what it labels, and leaves it again
// ---------------------------------------------------------------------------

/// Whether the index finds this entity by this word, asked of the index itself.
fn finds(vault: &Vault, id: &str, word: &str) -> bool {
    read(vault, |connection| {
        Ok(connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM search
                             WHERE search MATCH ?2
                               AND rowid = (SELECT n FROM entity WHERE id = ?1))",
            [id, &format!("\"{word}\"")],
            |row| row.get(0),
        )?)
    })
}

/// The incremental index is the rebuilt one, asked after every step so that the
/// step that forgot to re-index is the one that fails.
fn in_step(vault: &Vault, step: &str) {
    let incremental = index_dump(vault);
    assert_eq!(incremental, rebuilt(vault), "{step}: the index is stale");
}

fn is_found(vault: &Vault, id: &str, word: &str, step: &str) {
    assert!(
        finds(vault, id, word),
        "{step}: `{id}` is not found by `{word}`"
    );
    in_step(vault, step);
}

fn is_not_found(vault: &Vault, id: &str, word: &str, step: &str) {
    assert!(
        !finds(vault, id, word),
        "{step}: `{id}` is still found by `{word}`"
    );
    in_step(vault, step);
}

#[test]
fn a_title_that_labels_is_part_of_the_text_of_what_it_labels() {
    let scratch = founded("c10");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let go = |name: &str, input: serde_json::Value| run(vault, &registry, name, input);

    // A transaction is found by its category and by its account.
    go(
        "account.add",
        json!({"id": "acct", "title": "Everyday Checking", "type": "checking"}),
    );
    vault
        .commit(|tx| {
            tx.insert_entity("tx1", Kind::Txn, "Corner shop", AT)?;
            tx.connection().execute(
                "INSERT INTO txn (id, account_id, currency, posted_on, amount_minor, category_id)
                 VALUES ('tx1', 'acct', (SELECT currency FROM account WHERE id = 'acct'),
                         '2026-03-01', -450, 'category:food.groceries')",
                [],
            )?;
            Ok(())
        })
        .expect("a line");
    is_found(vault, "tx1", "corner", "a line's own title");
    is_found(vault, "tx1", "groceries", "a line's category");
    is_found(vault, "tx1", "everyday", "a line's account");
    go(
        "entity.retitle",
        json!({"id": "acct", "title": "Joint Account"}),
    );
    is_found(vault, "tx1", "joint", "an account renamed");
    is_not_found(vault, "tx1", "everyday", "an account renamed");
    go(
        "txn.categorize",
        json!({"ids": ["tx1"], "category_id": "category:food.dining"}),
    );
    is_found(vault, "tx1", "dining", "a line re-categorised");
    is_not_found(vault, "tx1", "groceries", "a line re-categorised");
    go("category.add", json!({"title": "Treats"}));
    let treats: String = read(vault, |c| {
        Ok(
            c.query_row("SELECT id FROM entity WHERE title = 'Treats'", [], |r| {
                r.get(0)
            })?,
        )
    });
    go(
        "txn.categorize",
        json!({"ids": ["tx1"], "category_id": treats}),
    );
    go("entity.retitle", json!({"id": treats, "title": "Sweets"}));
    is_found(vault, "tx1", "sweets", "a category renamed");
    go("entity.purge", json!({"id": treats}));
    is_not_found(vault, "tx1", "sweets", "a category purged");

    // A tag or a flag is part of the text of what carries it.
    go(
        "note.create",
        json!({"id": "nt", "title": "Packing", "body": "socks"}),
    );
    let tag = go("tag.add", json!({"id": "nt", "label": "Road Trip"}))["tag"]
        .as_str()
        .expect("the tag's id")
        .to_owned();
    is_found(vault, "nt", "road", "a tag put on");
    go("tag.add", json!({"id": "tx1", "label": "Road Trip"}));
    is_found(vault, "tx1", "trip", "a tag on a line");
    go("entity.retitle", json!({"id": tag, "title": "Holiday"}));
    is_found(vault, "nt", "holiday", "a tag renamed");
    is_found(vault, "tx1", "holiday", "a tag renamed");
    is_not_found(vault, "nt", "road", "a tag renamed");
    go("tag.remove", json!({"id": "nt", "label": "Road Trip"}));
    is_not_found(vault, "nt", "holiday", "a tag taken off");
    go("flag.set", json!({"id": "nt", "flag": "starred"}));
    is_found(vault, "nt", "starred", "a flag set");
    go("flag.clear", json!({"id": "nt", "flag": "starred"}));
    is_not_found(vault, "nt", "starred", "a flag cleared");
    go("entity.purge", json!({"id": tag}));
    is_not_found(vault, "tx1", "holiday", "a tag purged");

    // A calendar is part of the text of its events; so is a day's own title.
    go(
        "container.create",
        json!({"id": "cal", "kind": "calendar", "title": "Work"}),
    );
    go(
        "event.propose",
        json!({"id": "ev", "title": "Standup", "starts": "2026-03-10T09:00",
        "rule": "FREQ=DAILY;COUNT=5", "calendar_id": "cal"}),
    );
    is_found(vault, "ev", "work", "an event on a calendar");
    go("entity.retitle", json!({"id": "cal", "title": "Office"}));
    is_found(vault, "ev", "office", "a calendar renamed");
    is_not_found(vault, "ev", "work", "a calendar renamed");
    go(
        "event.edit_occurrence",
        json!({"id": "ev", "original_start": "2026-03-11T09:00:00",
        "scope": "occurrence", "action": "override", "title": "Retro", "description": "bring snacks"}),
    );
    is_found(vault, "ev", "retro", "an occurrence's own title");
    is_found(vault, "ev", "snacks", "an occurrence's own description");
    go(
        "event.edit_occurrence",
        json!({"id": "ev", "original_start": "2026-03-11T09:00:00",
        "scope": "occurrence", "action": "restore"}),
    );
    is_not_found(vault, "ev", "retro", "an occurrence restored");

    // A list is part of the text of the people in it.
    go("person.add", json!({"id": "ada", "title": "Ada Lovelace"}));
    go(
        "container.create",
        json!({"id": "club", "kind": "list", "title": "Book Club"}),
    );
    go("person.move", json!({"id": "ada", "list_id": "club"}));
    is_found(vault, "ada", "club", "a person filed in a list");
    go(
        "entity.retitle",
        json!({"id": "club", "title": "Reading Circle"}),
    );
    is_found(vault, "ada", "circle", "a list renamed");
    go("person.move", json!({"id": "ada", "list_id": null}));
    is_not_found(vault, "ada", "circle", "a person taken out of a list");
    go(
        "edge.add",
        json!({"from": "club", "rel": "contains", "to": "ada"}),
    );
    is_found(vault, "ada", "circle", "a list that holds a person");
    go(
        "edge.remove",
        json!({"from": "club", "rel": "contains", "to": "ada"}),
    );
    is_not_found(vault, "ada", "circle", "a list that lets a person go");
    go(
        "edge.add",
        json!({"from": "club", "rel": "contains", "to": "ada"}),
    );
    go("entity.trash", json!({"id": "club"}));
    go("entity.purge", json!({"id": "club"}));
    is_not_found(vault, "ada", "circle", "a list purged");

    // A relation's word is part of the text of both people it joins.
    go(
        "person.add_relationship",
        json!({"id": "ada", "name": "Annabella", "kind": "mother"}),
    );
    is_found(vault, "ada", "mother", "a relation");
    go(
        "entity.retitle",
        json!({"id": "relation:mother", "title": "Parent"}),
    );
    is_found(vault, "ada", "parent", "a relation renamed");

    // An album is part of the text of its photographs.
    vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO blob (hash, size) VALUES (?1, 1)",
                [&"ab".repeat(32)],
            )?;
            tx.insert_entity("ph", Kind::Photo, "Shore", AT)?;
            tx.connection().execute(
                "INSERT INTO photo (id, blob, media_type, form) VALUES ('ph', ?1, 'image/jpeg', 'photo')",
                [&"ab".repeat(32)],
            )?;
            Ok(())
        })
        .expect("a photograph");
    go(
        "container.create",
        json!({"id": "alb", "kind": "album", "title": "Summer"}),
    );
    go(
        "edge.add",
        json!({"from": "alb", "rel": "contains", "to": "ph"}),
    );
    is_found(vault, "ph", "summer", "a photograph in an album");
    go("entity.retitle", json!({"id": "alb", "title": "Autumn"}));
    is_found(vault, "ph", "autumn", "an album renamed");
    go(
        "edge.remove",
        json!({"from": "alb", "rel": "contains", "to": "ph"}),
    );
    is_not_found(vault, "ph", "autumn", "a photograph taken out of an album");

    // A notebook, a folder and a project are part of the text of what is filed in them.
    go(
        "container.create",
        json!({"id": "book", "kind": "notebook", "title": "Recipes"}),
    );
    go("note.move", json!({"id": "nt", "notebook_id": "book"}));
    is_found(vault, "nt", "recipes", "a note in a notebook");
    go("entity.retitle", json!({"id": "book", "title": "Cooking"}));
    is_found(vault, "nt", "cooking", "a notebook renamed");
    go("note.move", json!({"id": "nt", "notebook_id": null}));
    is_not_found(vault, "nt", "cooking", "a note taken out of a notebook");
    vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO blob (hash, size) VALUES (?1, 1)",
                [&"cd".repeat(32)],
            )?;
            tx.insert_entity("doc", Kind::Document, "Return", AT)?;
            tx.connection().execute(
                "INSERT INTO document (id, blob, media_type) VALUES ('doc', ?1, 'application/pdf')",
                [&"cd".repeat(32)],
            )?;
            Ok(())
        })
        .expect("a document");
    go(
        "container.create",
        json!({"id": "fold", "kind": "folder", "title": "Taxes"}),
    );
    go("document.move", json!({"id": "doc", "folder_id": "fold"}));
    is_found(vault, "doc", "taxes", "a document in a folder");
    go("entity.retitle", json!({"id": "fold", "title": "Filing"}));
    is_found(vault, "doc", "filing", "a folder renamed");

    go(
        "container.create",
        json!({"id": "area", "kind": "area", "title": "Home"}),
    );
    go(
        "container.create",
        json!({"id": "proj", "kind": "project", "title": "Garden", "parent": "area"}),
    );
    go(
        "container.create",
        json!({"id": "sec", "kind": "section", "title": "Planning", "parent": "proj"}),
    );
    go(
        "task.add",
        json!({"id": "tk", "title": "Order seeds", "project_id": "proj", "section_id": "sec"}),
    );
    is_found(vault, "proj", "home", "a project in an area");
    is_found(vault, "tk", "planning", "a task in a section");
    go("entity.retitle", json!({"id": "sec", "title": "Buying"}));
    is_found(vault, "tk", "buying", "a section renamed");
    go("entity.retitle", json!({"id": "area", "title": "House"}));
    is_found(vault, "proj", "house", "an area renamed");
    go("entity.trash", json!({"id": "area"}));
    go("entity.purge", json!({"id": "area"}));
    is_not_found(vault, "proj", "house", "an area purged");

    // An activity is found by the kind of thing it was and by where.
    go(
        "person.log_interaction",
        json!({"id": "ada", "kind": "call", "text": "about the engine"}),
    );
    let call: String = read(vault, |c| {
        Ok(c.query_row("SELECT id FROM activity LIMIT 1", [], |r| r.get(0))?)
    });
    is_found(vault, &call, "call", "an activity's kind");
}

// ---------------------------------------------------------------------------
// 11. The index is tuned for the reads it serves
// ---------------------------------------------------------------------------

#[test]
fn the_prefix_index_is_not_in_the_vocabulary() {
    let scratch = founded("c11-prefix");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    run(
        vault,
        &registry,
        "note.create",
        json!({"id": "n", "title": "Zeppelin", "body": "alphabet soup"}),
    );
    let terms = vocabulary(vault);
    // `prefix = '2'` stores `al`, `so` and `ze` as index entries; the vocabulary
    // is the words, and a correction that scanned a prefix of it would otherwise
    // be offered `al`.
    for word in ["alphabet", "soup", "zeppelin"] {
        assert!(terms.contains(word), "{word}");
    }
    for prefix in ["al", "so", "ze", "a", "z"] {
        assert!(
            !terms.contains(prefix),
            "the vocabulary lists the prefix `{prefix}`"
        );
    }
    assert_eq!(terms, word_list(vault));
    // And the prefix is served: a two-letter start finds the note.
    assert!(finds_prefix(vault, "n", "al"));
    assert!(finds_prefix(vault, "n", "zep"));
    assert!(!finds_prefix(vault, "n", "qu"));
}

fn finds_prefix(vault: &Vault, id: &str, start: &str) -> bool {
    read(vault, |connection| {
        Ok(connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM search
                             WHERE search MATCH ?2
                               AND rowid = (SELECT n FROM entity WHERE id = ?1))",
            [id, &format!("\"{start}\" *")],
            |row| row.get(0),
        )?)
    })
}

#[test]
fn a_month_across_accounts_reads_the_day_index() {
    let scratch = founded("c11-day");
    read(&scratch.vault, |connection| {
        // The statement `money.transactions.month` writes, without an account.
        let plan: Vec<String> = connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT id, account_id, posted_on, amount_minor, currency, status, category_id, transfer_id
                   FROM txn WHERE posted_on >= ?1 AND posted_on < ?2
                  ORDER BY posted_on DESC, id DESC LIMIT 51",
            )?
            .query_map(["2026-03-01", "2026-04-01"], |row| row.get::<_, String>(3))?
            .collect::<rusqlite::Result<_>>()?;
        let plan = plan.join("; ");
        assert!(plan.contains("txn_by_day"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        Ok(())
    });
}

#[test]
fn a_closed_vault_has_learned_its_statistics() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    {
        let vault = Vault::create(&path).expect("a vault");
        vault.found("Test", "Test Owner").expect("founded");
        let registry = Registry::with_system_commands().expect("a registry");
        for n in 0..200 {
            run(
                &vault,
                &registry,
                "note.create",
                json!({"id": format!("n{n}"), "title": format!("Note {n}"), "body": "words"}),
            );
        }
        // A read that the planner can plan better: it is queries that `PRAGMA
        // optimize` learns from.
        read(&vault, |connection| {
            let _: i64 = connection.query_row(
                "SELECT count(*) FROM entity WHERE kind = 'note' AND deleted_at IS NULL AND title = 'Note 7'",
                [],
                |row| row.get(0),
            )?;
            Ok(())
        });
        vault.close().expect("closes");
    }
    let vault = Vault::open(&path).expect("reopens");
    let analysed: i64 = read(&vault, |connection| {
        Ok(connection.query_row(
            "SELECT count(*) FROM sqlite_stat1 WHERE tbl = 'entity'",
            [],
            |row| row.get(0),
        )?)
    });
    assert!(analysed > 0, "closing a vault runs PRAGMA optimize");
    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_dropped_vault_has_learned_its_statistics_too() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    {
        let vault = Vault::create(&path).expect("a vault");
        vault.found("Test", "Test Owner").expect("founded");
        let registry = Registry::with_system_commands().expect("a registry");
        for n in 0..200 {
            run(
                &vault,
                &registry,
                "note.create",
                json!({"id": format!("n{n}"), "title": format!("Note {n}"), "body": "words"}),
            );
        }
        read(&vault, |connection| {
            let _: i64 = connection.query_row(
                "SELECT count(*) FROM entity WHERE kind = 'note' AND deleted_at IS NULL AND title = 'Note 7'",
                [],
                |row| row.get(0),
            )?;
            Ok(())
        });
    }
    let vault = Vault::open(&path).expect("reopens");
    let analysed: i64 = read(&vault, |connection| {
        Ok(connection.query_row(
            "SELECT count(*) FROM sqlite_stat1 WHERE tbl = 'entity'",
            [],
            |row| row.get(0),
        )?)
    });
    assert!(analysed > 0, "dropping a vault runs PRAGMA optimize");
    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}
