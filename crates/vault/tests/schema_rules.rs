//! The rules of the kernel are also in the database (#1214, K1): each test writes the bad row with
//! raw SQL on a founded vault and the database itself refuses it, and a good row of the same shape
//! is taken, so a refusal is the rule's and not a typo's.
//!
//! The rules of the app tables (a task's due, a budget, a workout, an event's alerts...) are held by
//! the same file and are re-proved by the lane that owns each app (`tests/unplugged/schema_rules.rs`
//! is the earlier proof of them, written against the model before #1214).

mod common;

const AT: &str = "2026-03-01T09:00:00.000Z";

/// A canonical UUIDv7: the one id grammar besides a seeded slug (A17).
fn id(n: u64) -> String {
    format!("01900000-0000-7000-8000-{n:012x}")
}

struct World {
    scratch: common::Scratch,
}

impl World {
    fn new(seed: &str) -> Self {
        Self {
            scratch: common::Scratch::founded(seed).expect("a vault"),
        }
    }

    /// Raw SQL in a commit: `Ok` when the database took it.
    fn raw(&self, sql: &str) -> Result<(), String> {
        self.scratch
            .vault
            .commit(|tx| {
                tx.connection().execute_batch(sql)?;
                Ok(())
            })
            .map_err(|error| error.to_string())
            .map(|_| ())
    }

    fn takes(&self, sql: &str) {
        if let Err(why) = self.raw(sql) {
            panic!("the database refused a good row: {sql}\n{why}");
        }
    }

    /// The database refuses `sql` for a rule it holds. A statement that fails for another reason (a
    /// typo, a missing column) is a broken test, not a held rule, and fails here.
    fn refuses(&self, sql: &str) -> String {
        match self.raw(sql) {
            Ok(()) => panic!("the database took what it should refuse: {sql}"),
            Err(why) => {
                for not_a_rule in [
                    "no such",
                    "syntax error",
                    "has no column",
                    "datatype mismatch",
                ] {
                    assert!(
                        !why.contains(not_a_rule),
                        "`{sql}` failed for a reason that is not a held rule ({not_a_rule}): {why}"
                    );
                }
                why
            }
        }
    }

    fn refuses_with(&self, sql: &str, fragment: &str) {
        let why = self.refuses(sql);
        assert!(
            why.contains(fragment),
            "`{sql}` was refused, but not by the rule named `{fragment}`: {why}"
        );
    }

    /// An entity of `kind` in the first home its kind's `home_shape` allows, made first when it
    /// has to be (a kind with `may_be_top = 0`); an empty title for a kind that takes none.
    fn entity_in(&self, n: u64, kind: &str) -> String {
        let (needs_home, named): (bool, bool) = self
            .scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT may_be_top = 0, may_be_named FROM entity_kind WHERE code = ?1",
                    [kind],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .expect("a kind");
        let id = id(n);
        let title = if named { "x" } else { "" };
        if needs_home {
            let home_kind: String = self
                .scratch
                .vault
                .read(|c| {
                    Ok(c.query_row(
                        "SELECT home_kind FROM home_shape WHERE kind = ?1 ORDER BY home_kind LIMIT 1",
                        [kind],
                        |r| r.get(0),
                    )?)
                })
                .expect("a home kind");
            let home = self.entity_in(n + 5_000, &home_kind);
            self.takes(&format!(
                "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
                 VALUES ('{id}', '{kind}', '{title}', '{home}', '{home_kind}', '{AT}', '{AT}')"
            ));
        } else {
            self.takes(&format!(
                "INSERT INTO entity (id, kind, title, created_at, updated_at)
                 VALUES ('{id}', '{kind}', '{title}', '{AT}', '{AT}')"
            ));
        }
        id
    }

    fn entity(&self, n: u64, kind: &str, title: &str) -> String {
        let id = id(n);
        self.takes(&format!(
            "INSERT INTO entity (id, kind, title, created_at, updated_at)
             VALUES ('{id}', '{kind}', '{title}', '{AT}', '{AT}')"
        ));
        id
    }
}

// ---------------------------------------------------------------------------------------------
// A17: an entity id is a canonical UUIDv7 or a seeded slug of its own kind
// ---------------------------------------------------------------------------------------------

#[test]
fn an_entity_id_is_a_lowercase_uuidv7_or_a_slug_of_its_own_kind() {
    let w = World::new("rules_ids");
    w.entity(1, "note", "good");
    for bad in [
        "n1",
        "item-1",
        "01900000-0000-4000-8000-000000000002",
        "01900000-0000-7000-8000-00000000ABCD",
        "01900000-0000-7000-c000-000000000003",
        "task:x",
        "",
    ] {
        w.refuses(&format!(
            "INSERT INTO entity (id, kind, title, created_at, updated_at)
             VALUES ('{bad}', 'note', 'x', '{AT}', '{AT}')"
        ));
    }
    // A slug names its own kind.
    w.takes(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at)
         VALUES ('tag:holiday', 'tag', 'Holiday', '{AT}', '{AT}')"
    ));
}

// ---------------------------------------------------------------------------------------------
// A2: one exact format per time
// ---------------------------------------------------------------------------------------------

#[test]
fn a_floating_time_has_no_seconds_and_a_zoned_one_is_an_instant() {
    let w = World::new("rules_times");
    // An event is born in a calendar: the default one.
    let ev = id(2);
    w.takes(&format!(
        "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
         VALUES ('{ev}', 'event', 'Lunch', 'calendar:default', 'calendar', '{AT}', '{AT}')"
    ));
    w.refuses(&format!(
        "INSERT INTO event (id, starts, timing) VALUES ('{ev}', '2026-03-02T09:00:30', 'floating')"
    ));
    w.refuses(&format!(
        "INSERT INTO event (id, starts, timing, zone) VALUES ('{ev}', '2026-03-02T09:00', 'zoned', 'UTC')"
    ));
    w.refuses(&format!(
        "INSERT INTO event (id, starts, timing) VALUES ('{ev}', '2026-03-02 09:00', 'floating')"
    ));
    w.takes(&format!(
        "INSERT INTO event (id, starts, timing) VALUES ('{ev}', '2026-03-02T09:00', 'floating')"
    ));
}

// ---------------------------------------------------------------------------------------------
// A19: one home column, a shape for it, one loop check
// ---------------------------------------------------------------------------------------------

#[test]
fn a_home_is_of_a_kind_the_shape_allows_and_never_a_loop() {
    let w = World::new("rules_homes");
    let book = w.entity(3, "notebook", "Book");
    let inner = w.entity(4, "notebook", "Inner");
    let folder = w.entity(5, "folder", "Folder");
    w.takes(&format!(
        "UPDATE entity SET parent_id = '{book}', parent_kind = 'notebook' WHERE id = '{inner}'"
    ));
    // A note sits in a notebook, not in a folder; a document in a folder, not a notebook.
    let note = w.entity(6, "note", "N");
    let doc = w.entity(7, "document", "D");
    w.refuses(&format!(
        "UPDATE entity SET parent_id = '{folder}', parent_kind = 'folder' WHERE id = '{note}'"
    ));
    w.refuses(&format!(
        "UPDATE entity SET parent_id = '{book}', parent_kind = 'notebook' WHERE id = '{doc}'"
    ));
    // The home's kind is the home's: a lie about it is refused.
    w.refuses(&format!(
        "UPDATE entity SET parent_id = '{book}', parent_kind = 'folder' WHERE id = '{note}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET parent_id = '{book}', parent_kind = 'notebook' WHERE id = '{note}'"
    ));
    // A home with a loop in it, and a thing in itself.
    w.refuses_with(
        &format!(
            "UPDATE entity SET parent_id = '{inner}', parent_kind = 'notebook' WHERE id = '{book}'"
        ),
        "no loops",
    );
    w.refuses(&format!(
        "UPDATE entity SET parent_id = '{book}', parent_kind = 'notebook' WHERE id = '{book}'"
    ));
    // An event needs a home (a calendar); a section needs a project.
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at)
         VALUES ('{}', 'event', 'orphan', '{AT}', '{AT}')",
        id(8)
    ));
}

// ---------------------------------------------------------------------------------------------
// A13, A14, A10: trash, shelves and arrival are columns with their own rules
// ---------------------------------------------------------------------------------------------

#[test]
fn a_trashed_by_names_a_trash_and_an_arrival_has_both_its_words() {
    let w = World::new("rules_trash");
    let note = w.entity(9, "note", "N");
    let book = w.entity(10, "notebook", "B");
    w.refuses(&format!(
        "UPDATE entity SET trashed_by = '{book}' WHERE id = '{note}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET deleted_at = '{AT}', purge_at = '{AT}', trashed_by = '{book}' WHERE id = '{note}'"
    ));
    w.refuses(&format!(
        "UPDATE entity SET deleted_at = '{AT}' WHERE id = '{book}'"
    ));
    w.refuses(&format!(
        "UPDATE entity SET arrived_via = 'vcard' WHERE id = '{book}'"
    ));
    w.refuses(&format!(
        "UPDATE entity SET arrived_via = 'telepathy', arrived_label = 'x' WHERE id = '{book}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET arrived_via = 'vcard', arrived_label = 'contacts.vcf' WHERE id = '{book}'"
    ));
    w.refuses(&format!(
        "UPDATE entity SET starred_at = '2026-03-01 09:00' WHERE id = '{book}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET starred_at = '{AT}' WHERE id = '{book}'"
    ));
}

// ---------------------------------------------------------------------------------------------
// A4: a link is a pair of linkable things in one order
// ---------------------------------------------------------------------------------------------

#[test]
fn a_link_has_its_lower_id_first_and_joins_only_linkable_kinds() {
    let w = World::new("rules_links");
    let a = w.entity(11, "note", "A");
    let b = w.entity(12, "person", "B");
    let reading = w.entity(13, "reading", "");
    w.takes(&format!("INSERT INTO person (id) VALUES ('{b}')"));
    w.refuses_with(
        &format!("INSERT INTO link (a, b, created_at) VALUES ('{b}', '{a}', '{AT}')"),
        "a < b",
    );
    w.refuses(&format!(
        "INSERT INTO link (a, b, created_at) VALUES ('{a}', '{a}', '{AT}')"
    ));
    w.refuses_with(
        &format!("INSERT INTO link (a, b, created_at) VALUES ('{a}', '{reading}', '{AT}')"),
        "cannot be linked",
    );
    w.takes(&format!(
        "INSERT INTO link (a, b, created_at) VALUES ('{a}', '{b}', '{AT}')"
    ));
}

#[test]
fn a_link_pair_is_one_row_and_its_ends_never_change() {
    let w = World::new("rules_k5_link");
    let a = w.entity(100, "note", "A");
    let b = w.entity(101, "person", "B");
    let c = w.entity(102, "task", "C");
    w.takes(&format!(
        "INSERT INTO link (a, b, created_at) VALUES ('{a}', '{b}', '{AT}')"
    ));
    // A pair is one row: the same pair again, in the only order the table keeps, is a duplicate.
    w.refuses_with(
        &format!("INSERT INTO link (a, b, created_at) VALUES ('{a}', '{b}', '{AT}')"),
        "UNIQUE",
    );
    w.refuses_with(
        &format!("UPDATE link SET b = '{c}' WHERE a = '{a}'"),
        "never change",
    );
    w.refuses_with(
        &format!("UPDATE link SET a = '{c}' WHERE a = '{a}'"),
        "never change",
    );
    // Purging an end takes the link (ON DELETE CASCADE): nothing else names it.
    w.takes(&format!("DELETE FROM entity WHERE id = '{b}'"));
    assert_eq!(
        w.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM link", [], |r| r.get::<_, i64>(0))?))
            .expect("reads"),
        0
    );
}

#[test]
fn a_mention_names_a_linkable_item_or_none_and_waits_again_when_its_target_goes() {
    let w = World::new("rules_k5_mention");
    let note = w.entity(103, "note", "N");
    let item = w.entity(104, "person", "P");
    let tag = w.entity(105, "tag", "T");
    let reading = w.entity(106, "reading", "");
    w.takes(&format!("INSERT INTO note (id) VALUES ('{note}')"));
    for bad in [&tag, &reading] {
        w.refuses_with(
            &format!("INSERT INTO mention (note_id, ordinal, wikilink, to_id) VALUES ('{note}', 0, 'x', '{bad}')"),
            "cannot mention",
        );
    }
    w.takes(&format!(
        "INSERT INTO mention (note_id, ordinal, wikilink) VALUES ('{note}', 0, 'waits')"
    ));
    w.refuses_with(
        &format!("UPDATE mention SET to_id = '{tag}' WHERE note_id = '{note}'"),
        "cannot mention",
    );
    w.takes(&format!(
        "UPDATE mention SET to_id = '{item}' WHERE note_id = '{note}'"
    ));
    // The note owns its mentions: only a note has any, and an empty title is no mention.
    w.refuses(&format!(
        "INSERT INTO mention (note_id, ordinal, wikilink) VALUES ('{item}', 1, 'x')"
    ));
    w.refuses(&format!(
        "INSERT INTO mention (note_id, ordinal, wikilink) VALUES ('{note}', 2, '  ')"
    ));
    w.takes(&format!("DELETE FROM entity WHERE id = '{item}'"));
    let unresolved: bool = w
        .scratch
        .vault
        .read(|c| Ok(c.query_row("SELECT to_id IS NULL FROM mention", [], |r| r.get(0))?))
        .expect("reads");
    assert!(
        unresolved,
        "a purged target turns its mention back into an unresolved one"
    );
}

#[test]
fn an_edge_joins_the_kinds_a_shape_names_and_wears_what_the_shape_allows() {
    let w = World::new("rules_k5_edge");
    let note = w.entity(107, "note", "N");
    let person = w.entity(108, "person", "P");
    let other = w.entity(109, "person", "Q");
    let album = w.entity(110, "album", "A");
    let photo = w.entity(111, "photo", "F");
    let task = w.entity(112, "task", "T");
    let relation = w.entity(113, "relation", "Friend");
    let tag = w.entity(114, "tag", "t");
    let insert = |from: &str, rel: &str, to: &str, extra_cols: &str, extra_vals: &str| {
        format!(
            "INSERT INTO edge (from_id, rel, to_id, created_at{extra_cols}) VALUES ('{from}', '{rel}', '{to}', '{AT}'{extra_vals})"
        )
    };
    // The rows a shape says, and one of each way to be refused.
    w.takes(&insert(&note, "about", &person, "", ""));
    w.refuses_with(
        &insert(&person, "about", &note, "", ""),
        "no edge of this relation",
    );
    w.refuses_with(
        &insert(&note, "about", &tag, "", ""),
        "no edge of this relation",
    );
    w.refuses_with(
        &insert(&note, "nonsense", &person, "", ""),
        "no edge of this relation",
    );
    w.refuses(&insert(&note, "about", &note, "", ""));
    // A duplicate is refused, with or without a label.
    w.refuses_with(&insert(&note, "about", &person, "", ""), "UNIQUE");
    // A label exactly where the shape names a label kind, and of that kind.
    w.refuses_with(
        &insert(&person, "related", &other, "", ""),
        "no edge of this relation",
    );
    w.refuses_with(
        &insert(
            &person,
            "related",
            &other,
            ", label_id",
            &format!(", '{tag}'"),
        ),
        "no edge of this relation",
    );
    w.takes(&insert(
        &person,
        "related",
        &other,
        ", label_id",
        &format!(", '{relation}'"),
    ));
    w.refuses_with(
        &insert(
            &note,
            "about",
            &other,
            ", label_id",
            &format!(", '{relation}'"),
        ),
        "no edge of this relation",
    );
    // A place only where the relation is ordered, on insert and on update.
    w.refuses_with(
        &insert(&task, "about", &person, ", position", ", 1.0"),
        "no edge of this relation",
    );
    w.takes(&insert(&album, "contains", &photo, ", position", ", 1.0"));
    w.takes(&format!(
        "UPDATE edge SET position = 0.5 WHERE from_id = '{album}'"
    ));
    w.refuses_with(
        &format!("UPDATE edge SET position = 3.0 WHERE from_id = '{note}'"),
        "keep a place",
    );
    // An anchor only where the shape is anchored, an object, with its version.
    w.refuses_with(
        &insert(&task, "about", &person, ", anchor", ", '{\"v\":1}'"),
        "no edge of this relation",
    );
    w.refuses(&insert(
        &note,
        "about",
        &other,
        ", anchor",
        ", '{\"from\":1}'",
    ));
    w.refuses(&insert(&note, "about", &other, ", anchor", ", '[1]'"));
    w.refuses(&insert(&note, "about", &other, ", anchor", ", 'nope'"));
    w.takes(&insert(
        &note,
        "about",
        &other,
        ", anchor",
        ", '{\"v\":1,\"from\":1}'",
    ));
    w.takes(&format!(
        "UPDATE edge SET anchor = '{{\"v\":1}}' WHERE from_id = '{note}' AND to_id = '{person}'"
    ));
    w.refuses(&format!(
        "UPDATE edge SET anchor = '{{\"from\":1}}' WHERE from_id = '{note}' AND to_id = '{person}'"
    ));
    w.takes(&insert(&task, "about", &person, "", ""));
    w.refuses_with(
        &format!("UPDATE edge SET anchor = '{{\"v\":1}}' WHERE from_id = '{task}'"),
        "cannot carry an anchor",
    );
    // An edge's ends never change.
    w.refuses_with(
        &format!(
            "UPDATE edge SET to_id = '{other}' WHERE from_id = '{note}' AND to_id = '{person}'"
        ),
        "never change",
    );
    w.refuses_with(
        &format!("UPDATE edge SET rel = 'with' WHERE from_id = '{note}' AND to_id = '{person}'"),
        "never change",
    );
}

#[test]
fn the_edge_trigger_joins_exactly_the_pairs_edge_shape_says_over_every_pair_of_kinds() {
    let w = World::new("rules_k5_matrix");
    let kinds: Vec<(String, bool)> = w
        .scratch
        .vault
        .read(|c| {
            let mut s = c.prepare("SELECT code, linkable FROM entity_kind ORDER BY code")?;
            Ok(s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<(String, bool)>>>()?)
        })
        .expect("kinds");
    let rels: Vec<String> = w
        .scratch
        .vault
        .read(|c| {
            let mut s = c.prepare("SELECT DISTINCT rel FROM edge_shape")?;
            Ok(s.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .expect("rels");
    let mut n = 200;
    let ends: Vec<(String, String, bool)> = kinds
        .iter()
        .map(|(kind, linkable)| {
            n += 1;
            (kind.clone(), w.entity_in(n, kind), *linkable)
        })
        .collect();
    let seconds: Vec<(String, String, bool)> = kinds
        .iter()
        .map(|(kind, linkable)| {
            n += 1;
            (kind.clone(), w.entity_in(n, kind), *linkable)
        })
        .collect();
    // (rel, from kind, to kind, label kind) as the table has them.
    let shapes: Vec<(String, String, String, Option<String>)> = w
        .scratch
        .vault
        .read(|c| {
            let mut s = c.prepare("SELECT rel, from_kind, to_kind, label_kind FROM edge_shape")?;
            Ok(
                s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            )
        })
        .expect("shapes");
    let label: String = w.entity_in(n + 1, "relation");
    let (mut took, mut refused) = (0, 0);
    w.scratch
        .vault
        .commit(|tx| {
            let c = tx.connection();
            for rel in &rels {
                for (fk, fid, flink) in &ends {
                    for (tk, tid, tlink) in &seconds {
                        let shape = shapes.iter().find(|(r, f, t, _)| {
                            r == rel
                                && (f == fk || (f == "*" && *flink))
                                && (t == tk || (t == "*" && *tlink))
                        });
                        let label_id = shape.and_then(|s| s.3.as_ref()).map(|_| label.clone());
                        c.execute_batch("SAVEPOINT pair")?;
                        // Prepared once: compiling the edge's triggers is the cost, not the rule.
                        let done = c
                            .prepare_cached(
                                "INSERT INTO edge (from_id, rel, to_id, label_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                            )?
                            .execute(rusqlite::params![fid, rel, tid, label_id, AT]);
                        c.execute_batch("ROLLBACK TO pair; RELEASE pair")?;
                        assert_eq!(done.is_ok(), shape.is_some(), "{rel}: {fk} -> {tk}: {done:?}");
                        if done.is_ok() { took += 1 } else { refused += 1 }
                    }
                }
            }
            Ok(())
        })
        .expect("the matrix commits");
    assert!(took > 40 && refused > 3_000, "{took} {refused}");
}

// ---------------------------------------------------------------------------------------------
// A1, J1: a column that depends on a lookup row's attribute is held by a key, not a list
// ---------------------------------------------------------------------------------------------

#[test]
fn a_colour_is_a_palette_key_and_only_a_tag_wears_one() {
    let w = World::new("rules_colours");
    let tag = w.entity(14, "tag", "t");
    let cat = w.entity(15, "category", "c");
    let list = w.entity(16, "list", "l");
    w.refuses(&format!(
        "INSERT INTO concept (id, kind, key, color) VALUES ('{tag}', 'tag', 't', 'var(--c-rose)')"
    ));
    w.refuses(&format!(
        "INSERT INTO concept (id, kind, key, color) VALUES ('{cat}', 'category', 'c', 'blue')"
    ));
    w.takes(&format!(
        "INSERT INTO concept (id, kind, key, color) VALUES ('{tag}', 'tag', 't', 'blue')"
    ));
    w.refuses(&format!(
        "INSERT INTO container (id, kind, color) VALUES ('{list}', 'list', 'chartreuse')"
    ));
    w.takes(&format!(
        "INSERT INTO container (id, kind, color) VALUES ('{list}', 'list', 'rose')"
    ));
}

#[test]
fn a_derivative_is_a_file_or_text_as_its_variant_says() {
    let w = World::new("rules_derivatives");
    let hash = "a".repeat(64);
    w.takes(&format!(
        "INSERT INTO blob (hash, size) VALUES ('{hash}', 1)"
    ));
    let row = |variant: &str, out: &str, media: &str, text: &str| {
        format!(
            "INSERT INTO derivative (blob, variant, out, media_type, text, created_at)
             VALUES ('{hash}', '{variant}', {out}, {media}, {text}, '{AT}')"
        )
    };
    w.refuses(&row("thumb", "NULL", "NULL", "'x'"));
    w.refuses(&row("text", &format!("'{hash}'"), "'image/png'", "NULL"));
    w.refuses(&row("hologram", "NULL", "NULL", "'x'"));
    w.takes(&row("thumb", &format!("'{hash}'"), "'image/png'", "NULL"));
    w.takes(&row("text", "NULL", "NULL", "'words'"));
}

#[test]
fn an_origin_fills_the_kind_its_system_says_and_only_a_phone_store_retires_or_names_a_device() {
    let w = World::new("rules_origins");
    let book = w.entity(17, "notebook", "B");
    let account = w.entity(18, "account", "A");
    let origin = |sys: &str, extra: &str| {
        format!(
            "INSERT INTO origin (id, system, ref, label, created_at {}) VALUES ('{}', '{sys}', '{sys}-r', 'l', '{AT}' {})",
            extra.split('|').next().unwrap_or(""),
            sys,
            extra.split('|').nth(1).unwrap_or("")
        )
    };
    w.refuses(&origin("telepathy", ""));
    w.refuses(&origin("statement", ", device_id|, 'phone-1'"));
    w.refuses(&origin(
        "statement",
        ", retired_at|, '2026-03-01T09:00:00.000Z'",
    ));
    w.refuses(&origin(
        "calendar",
        &format!(", fills, fills_kind|, '{book}', 'notebook'"),
    ));
    w.takes(&origin("calendar", ", device_id|, 'phone-1'"));
    w.takes(&format!(
        "INSERT INTO origin (id, system, ref, label, created_at, fills, fills_kind)
         VALUES ('stmt', 'statement', 's', 'l', '{AT}', '{account}', 'account')"
    ));
}

// ---------------------------------------------------------------------------------------------
// E3, F1, I2: money, readings and Locker fields are held by their own rules
// ---------------------------------------------------------------------------------------------

#[test]
fn a_split_goes_to_a_category_and_a_reading_is_one_of_its_metric() {
    let w = World::new("rules_money_health");
    let account = w.entity(19, "account", "A");
    let txn = w.entity(20, "txn", "T");
    let person = w.entity(21, "person", "P");
    let note = w.entity(22, "note", "N");
    w.takes(&format!(
        "INSERT INTO account (id, type, currency) VALUES ('{account}', 'checking', 'USD')"
    ));
    w.takes(&format!(
        "INSERT INTO txn (id, account_id, posted_on, amount_minor) VALUES ('{txn}', '{account}', '2026-03-01', -300)"
    ));
    w.takes(&format!("INSERT INTO person (id) VALUES ('{person}')"));
    w.refuses(&format!(
        "INSERT INTO txn_split (txn_id, position, category_id, amount_minor) VALUES ('{txn}', 1, '{note}', -300)"
    ));
    w.takes(&format!(
        "INSERT INTO txn_split (txn_id, position, category_id, amount_minor) VALUES ('{txn}', 1, 'category:food.dining', -300)"
    ));
    w.refuses(&format!(
        "INSERT INTO txn (id, account_id, posted_on, amount_minor, status) VALUES ('{}', '{account}', '2026-03-01', 1, 'void')",
        id(23)
    ));
    // A reading has no title, belongs to a reading metric and carries a second figure exactly when it says.
    let reading = |n: u64, title: &str, metric: &str, v2: &str| {
        let rid = id(n);
        format!(
            "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{rid}', 'reading', '{title}', '{AT}', '{AT}');
             INSERT INTO reading (id, person_id, metric, at, value, value2) VALUES ('{rid}', '{person}', '{metric}', '{AT}', 120, {v2});"
        )
    };
    w.refuses(&reading(24, "120/80", "blood_pressure", "80"));
    w.refuses(&reading(25, "", "blood_pressure", "NULL"));
    w.refuses(&reading(26, "", "steps", "NULL"));
    w.takes(&reading(27, "", "blood_pressure", "80"));
}

#[test]
fn a_locker_field_holds_the_columns_its_kind_says() {
    let w = World::new("rules_locker");
    let item = w.entity(28, "locker_item", "Bank");
    w.takes(&format!(
        "INSERT INTO locker_item (id, type) VALUES ('{item}', 'login')"
    ));
    w.takes("INSERT INTO locker_key (id, key_id, created_at) VALUES (1, 'k1', '2026-03-01T09:00:00.000Z')");
    let blob = "b".repeat(64);
    w.takes(&format!(
        "INSERT INTO blob (hash, size) VALUES ('{blob}', 1)"
    ));
    let field = |idn: &str, kind: &str, cols: &str, vals: &str| {
        format!(
            "INSERT INTO locker_item_field (id, item_id, label, kind, created_at, updated_at {cols})
             VALUES ('{idn}', '{item}', 'L', '{kind}', '{AT}', '{AT}' {vals})"
        )
    };
    let sealed = ", value_sealed, key_id, value_set_at";
    let sealed_vals = format!(", 'lk1:x', 'k1', '{AT}'");
    w.refuses(&field("f1", "file", sealed, &sealed_vals));
    w.refuses(&field("f2", "sealed", ", value_text", ", 'plain'"));
    w.refuses(&field("f3", "text", ", value_blob", &format!(", '{blob}'")));
    w.refuses(&field("f4", "date", ", value_text", ", 'next week'"));
    w.refuses(&field("f5", "sealed", "", ""));
    w.takes(&field(
        "f6",
        "file",
        ", value_sealed, key_id, value_set_at, value_blob",
        &format!(", 'lk1:x', 'k1', '{AT}', '{blob}'"),
    ));
    w.takes(&field("f7", "date", ", value_text", ", '2030-01-31'"));
    // A reminder goes where there is a time to fire at: a date field, not a sealed one.
    w.refuses(&format!(
        "INSERT INTO reminder (id, entity_id, entity_kind, field_id, offset_min) VALUES ('r1', '{item}', 'locker_item', 'f6', 0)"
    ));
    w.takes(&format!(
        "INSERT INTO reminder (id, entity_id, entity_kind, field_id, offset_min) VALUES ('r2', '{item}', 'locker_item', 'f7', 0)"
    ));
}

// ---------------------------------------------------------------------------------------------
// K4: the rules the shared verbs state in a sentence (`tests/shared_verbs.rs`) are the database's too
// ---------------------------------------------------------------------------------------------

#[test]
fn a_kind_that_needs_a_home_has_one_and_a_reading_has_no_name() {
    let w = World::new("rules_k4_homes");
    // A section needs a project, an event a calendar: `entity_kind.may_be_top = 0`.
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at)
         VALUES ('{}', 'section', 'S', '{AT}', '{AT}')",
        id(20)
    ));
    let project = w.entity(21, "project", "P");
    w.takes(&format!(
        "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
         VALUES ('{}', 'section', 'S', '{project}', 'project', '{AT}', '{AT}')",
        id(22)
    ));
    // Taking a section out of its project is a move to the top, which it may not make.
    w.refuses(&format!(
        "UPDATE entity SET parent_id = NULL, parent_kind = NULL WHERE id = '{}'",
        id(22)
    ));
    // A reading's title is empty (`may_be_named = 0`); a note may carry one.
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at)
         VALUES ('{}', 'reading', 'x', '{AT}', '{AT}')",
        id(23)
    ));
    w.takes(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at)
         VALUES ('{}', 'reading', '', '{AT}', '{AT}')",
        id(24)
    ));
}

#[test]
fn a_concept_sits_in_a_concept_of_its_own_kind_and_never_in_itself() {
    let w = World::new("rules_k4_concepts");
    let food = w.entity(25, "tag", "Food");
    let soup = w.entity(26, "tag", "Soup");
    let cat = w.entity(27, "category", "Cat");
    w.takes(&format!(
        "UPDATE entity SET parent_id = '{food}', parent_kind = 'tag' WHERE id = '{soup}'"
    ));
    w.refuses(&format!(
        "UPDATE entity SET parent_id = '{cat}', parent_kind = 'category' WHERE id = '{soup}'"
    ));
    w.refuses_with(
        &format!("UPDATE entity SET parent_id = '{soup}', parent_kind = 'tag' WHERE id = '{food}'"),
        "no loops",
    );
    w.refuses(&format!(
        "UPDATE entity SET parent_id = '{food}', parent_kind = 'tag' WHERE id = '{food}'"
    ));
    // A holder is not deleted from under what it holds.
    w.refuses(&format!("DELETE FROM entity WHERE id = '{food}'"));
}

#[test]
fn a_tag_goes_only_on_a_linkable_kind() {
    let w = World::new("rules_k4_tagged");
    let tag = w.entity(28, "tag", "t");
    let note = w.entity(29, "note", "n");
    let book = w.entity(30, "notebook", "b");
    let chat = w.entity(31, "thread", "c");
    let reading = w.entity(32, "reading", "");
    let cat = w.entity(33, "category", "k");
    let edge = |from: &str| {
        format!(
            "INSERT INTO edge (from_id, rel, to_id, created_at) VALUES ('{from}', 'tagged', '{tag}', '{AT}')"
        )
    };
    for bad in [&book, &chat, &reading, &cat, &tag] {
        w.refuses_with(&edge(bad), "no edge of this relation");
    }
    w.takes(&edge(&note));
}

#[test]
fn nothing_live_is_made_moved_or_restored_inside_a_trash() {
    let w = World::new("rules_k4_trash");
    let book = w.entity(34, "notebook", "b");
    let note = w.entity(35, "note", "n");
    let other = w.entity(36, "note", "o");
    w.takes(&format!(
        "UPDATE entity SET parent_id = '{book}', parent_kind = 'notebook' WHERE id = '{note}'"
    ));
    // The holder's trash takes its member: both deleted, the member naming the holder.
    w.takes(&format!(
        "UPDATE entity SET deleted_at = '{AT}', purge_at = '{AT}' WHERE id = '{book}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET deleted_at = '{AT}', purge_at = '{AT}', trashed_by = '{book}' WHERE id = '{note}'"
    ));
    // Not born in it, not moved into it, not restored out from under it.
    w.refuses_with(
        &format!(
            "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
             VALUES ('{}', 'note', 'x', '{book}', 'notebook', '{AT}', '{AT}')",
            id(37)
        ),
        "in the trash",
    );
    w.refuses_with(
        &format!(
            "UPDATE entity SET parent_id = '{book}', parent_kind = 'notebook' WHERE id = '{other}'"
        ),
        "in the trash",
    );
    w.refuses_with(
        &format!(
            "UPDATE entity SET deleted_at = NULL, purge_at = NULL, trashed_by = NULL WHERE id = '{note}'"
        ),
        "in the trash",
    );
    // A row trashed by a holder that is not its home has no home to be inside: it may come out.
    w.takes(&format!(
        "UPDATE entity SET deleted_at = '{AT}', purge_at = '{AT}', trashed_by = '{book}' WHERE id = '{other}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET deleted_at = NULL, purge_at = NULL, trashed_by = NULL WHERE id = '{other}'"
    ));
    // Out of a trashed home means leaving it first: to the top level.
    w.takes(&format!(
        "UPDATE entity SET parent_id = NULL, parent_kind = NULL WHERE id = '{note}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET deleted_at = NULL, purge_at = NULL, trashed_by = NULL WHERE id = '{note}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET deleted_at = '{AT}', purge_at = '{AT}', trashed_by = '{book}' WHERE id = '{note}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET parent_id = '{book}', parent_kind = 'notebook' WHERE id = '{note}'"
    ));
    // The holder first, then what it took.
    w.takes(&format!(
        "UPDATE entity SET deleted_at = NULL, purge_at = NULL WHERE id = '{book}'"
    ));
    w.takes(&format!(
        "UPDATE entity SET deleted_at = NULL, purge_at = NULL, trashed_by = NULL WHERE id IN ('{note}', '{other}')"
    ));
    // A row is not trashed by itself.
    w.refuses(&format!(
        "UPDATE entity SET deleted_at = '{AT}', purge_at = '{AT}', trashed_by = '{note}' WHERE id = '{note}'"
    ));
}

// ---------------------------------------------------------------------------------------------
// B2-B4: a version says who made it, which grammar it is in, and which blobs it names (K6)
// ---------------------------------------------------------------------------------------------

#[test]
fn a_revision_names_its_actor_and_only_a_store_names_an_origin() {
    let w = World::new("rules_k6_actor");
    let note = w.entity(40, "note", "n");
    w.takes(&format!(
        "INSERT INTO origin (id, system, ref, label, created_at)
         VALUES ('o1', 'contacts', 'r1', 'Phone', '{AT}')"
    ));
    let row = |seq: u32, actor: &str, origin: &str, shape: u32, state: &str| {
        format!(
            "INSERT INTO revision (entity_id, seq, at, actor, origin_id, shape, state)
             VALUES ('{note}', {seq}, '{AT}', '{actor}', {origin}, {shape}, '{state}')"
        )
    };
    w.takes(&row(1, "member", "NULL", 1, "{}"));
    w.takes(&row(2, "assistant", "NULL", 1, "{}"));
    w.takes(&row(3, "store", "'o1'", 1, "{}"));
    // The actor is one of three, and only a store has an origin; a store always does.
    w.refuses(&row(4, "robot", "NULL", 1, "{}"));
    w.refuses(&row(4, "member", "'o1'", 1, "{}"));
    w.refuses(&row(4, "assistant", "'o1'", 1, "{}"));
    w.refuses(&row(4, "store", "NULL", 1, "{}"));
    // The origin is a real one.
    w.refuses_with(&row(4, "store", "'nowhere'", 1, "{}"), "FOREIGN KEY");
    // The grammar is a version, the state is JSON, the number counts from one.
    w.refuses(&row(4, "member", "NULL", 0, "{}"));
    w.refuses(&row(4, "member", "NULL", 1, "not json"));
    w.refuses(&row(0, "member", "NULL", 1, "{}"));
    w.refuses(&row(2, "member", "NULL", 1, "{}"));
    // An origin that a version names is not dropped from under it.
    w.refuses_with("DELETE FROM origin WHERE id = 'o1'", "FOREIGN KEY");
}

#[test]
fn a_revision_is_history_and_a_version_names_only_blobs_the_vault_holds() {
    let w = World::new("rules_k6_blob");
    let note = w.entity(41, "note", "n");
    let hash = "a".repeat(64);
    w.takes(&format!(
        "INSERT INTO blob (hash, size) VALUES ('{hash}', 3)"
    ));
    w.takes(&format!(
        "INSERT INTO revision (entity_id, seq, at, actor, shape) VALUES ('{note}', 1, '{AT}', 'member', 1)"
    ));
    let claim = |seq: u32, slot: &str, blob: &str, media: &str| {
        format!(
            "INSERT INTO revision_blob (entity_id, seq, slot, blob, media_type)
             VALUES ('{note}', {seq}, '{slot}', '{blob}', {media})"
        )
    };
    w.takes(&claim(1, "blob", &hash, "'text/plain'"));
    // One claim per slot of a version, on a version that exists, of bytes that exist.
    w.refuses(&claim(1, "blob", &hash, "NULL"));
    w.refuses_with(&claim(2, "avatar", &hash, "NULL"), "FOREIGN KEY");
    w.refuses_with(&claim(1, "avatar", &"b".repeat(64), "NULL"), "FOREIGN KEY");
    w.refuses(&claim(1, " ", &hash, "NULL"));
    w.refuses(&claim(1, "cover", &hash, "' '"));
    // The bytes a version names are not dropped from under it.
    w.refuses_with(
        &format!("DELETE FROM blob WHERE hash = '{hash}'"),
        "FOREIGN KEY",
    );
    // A version never changes, but for the instant its session last folded another save in.
    w.refuses_with(
        &format!("UPDATE revision SET state = '{{\"x\":1}}' WHERE entity_id = '{note}'"),
        "a revision is history",
    );
    w.refuses_with(
        &format!("UPDATE revision SET actor = 'assistant' WHERE entity_id = '{note}'"),
        "a revision is history",
    );
    w.refuses_with(
        &format!("UPDATE revision_blob SET slot = 'cover' WHERE entity_id = '{note}'"),
        "a revision is history",
    );
    w.takes(&format!(
        "UPDATE revision SET touched_at = '{AT}' WHERE entity_id = '{note}'"
    ));
    // It goes with its entity, and its claims with it.
    w.takes(&format!("DELETE FROM entity WHERE id = '{note}'"));
    w.takes(&format!("DELETE FROM blob WHERE hash = '{hash}'"));
}

// ---------------------------------------------------------------------------------------------
// K11: a note's day, format, mentions and assets
// ---------------------------------------------------------------------------------------------

#[test]
fn a_note_has_a_real_day_a_known_format_and_assets_that_name_held_bytes_and_go_with_it() {
    let w = World::new("rules_k11_note");
    let note = w.entity(201, "note", "N");
    let hash = "c".repeat(64);
    // A journal day is a date, and only a date.
    for bad in ["yesterday", "2026-02-30", "2026-3-1", "2026-03-01T09:00"] {
        w.refuses_with(
            &format!("INSERT INTO note (id, journal_on) VALUES ('{note}', '{bad}')"),
            "CHECK",
        );
    }
    w.refuses_with(
        &format!("INSERT INTO note (id, format) VALUES ('{note}', 'rtf')"),
        "CHECK",
    );
    // The words weigh at most 64 KiB, counted in bytes (so `é` is two), and a note needs a title.
    let words = |letters: u32, accent: &str| {
        format!(
            "INSERT INTO note (id, body) VALUES ('{note}', replace(hex(zeroblob({letters})), '00', '{accent}'))"
        )
    };
    w.refuses_with(&words(65_537, "a"), "CHECK");
    w.refuses_with(&words(32_769, "é"), "CHECK");
    w.takes(&words(32_768, "é"));
    w.takes(&format!("DELETE FROM note WHERE id = '{note}'"));
    let untitled = w.entity(203, "note", "");
    w.refuses_with(
        &format!("INSERT INTO note (id) VALUES ('{untitled}')"),
        "a note needs a title",
    );
    w.takes(&format!("INSERT INTO note (id) VALUES ('{note}')"));
    w.refuses_with(
        &format!("UPDATE entity SET title = '' WHERE id = '{note}'"),
        "a note needs a title",
    );
    w.takes(&format!(
        "UPDATE note SET journal_on = '2026-03-01' WHERE id = '{note}'"
    ));
    w.takes(&format!(
        "UPDATE note SET journal_on = NULL WHERE id = '{note}'"
    ));
    w.refuses_with(
        &format!("UPDATE note SET journal_on = 'soon' WHERE id = '{note}'"),
        "CHECK",
    );
    // An asset names bytes the vault holds, has a name and a type, and belongs to a note.
    let asset = |id: u64, name: &str, media: &str, blob: &str, owner: &str| {
        format!(
            "INSERT INTO note_asset (id, note_id, blob, name, media_type)
             VALUES ('{}', '{owner}', '{blob}', '{name}', '{media}')",
            id
        )
    };
    w.refuses_with(&asset(1, "a.png", "image/png", &hash, &note), "FOREIGN KEY");
    w.takes(&format!(
        "INSERT INTO blob (hash, size) VALUES ('{hash}', 3)"
    ));
    w.refuses_with(&asset(2, "  ", "image/png", &hash, &note), "CHECK");
    w.refuses_with(&asset(3, "a.png", " ", &hash, &note), "CHECK");
    let person = w.entity(202, "person", "P");
    w.refuses_with(
        &asset(4, "a.png", "image/png", &hash, &person),
        "FOREIGN KEY",
    );
    w.takes(&asset(5, "a.png", "image/png", &hash, &note));
    // The bytes are not dropped from under the asset; the asset goes with its note.
    w.refuses_with(
        &format!("DELETE FROM blob WHERE hash = '{hash}'"),
        "FOREIGN KEY",
    );
    w.takes(&format!("DELETE FROM entity WHERE id = '{note}'"));
    w.takes(&format!("DELETE FROM blob WHERE hash = '{hash}'"));
}

#[test]
fn a_mention_is_one_row_of_its_note_by_ordinal_and_goes_with_it() {
    let w = World::new("rules_k11_mention");
    let note = w.entity(211, "note", "N");
    w.takes(&format!("INSERT INTO note (id) VALUES ('{note}')"));
    let mention = |ordinal: i64, words: &str| {
        format!(
            "INSERT INTO mention (note_id, ordinal, wikilink) VALUES ('{note}', {ordinal}, '{words}')"
        )
    };
    // The same words twice are two rows; one ordinal is one row.
    w.takes(&mention(0, "Alex"));
    w.takes(&mention(1, "Alex"));
    w.refuses_with(&mention(1, "Other"), "UNIQUE");
    w.refuses_with(&mention(-1, "Alex"), "CHECK");
    w.takes(&format!("DELETE FROM entity WHERE id = '{note}'"));
    assert_eq!(
        w.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM mention", [], |r| r.get::<_, i64>(0))?))
            .expect("counts"),
        0,
        "a note's mentions go with it"
    );
}

// ---------------------------------------------------------------------------------------------
// K8: THE ONE NOTIFICATION RULE (D2): the sentences of `reminder.add` are the database's too
// ---------------------------------------------------------------------------------------------

#[test]
fn a_reminder_goes_only_where_there_is_a_time_to_fire_at() {
    let w = World::new("rules_reminder");
    let ev = id(60);
    w.takes(&format!(
        "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
         VALUES ('{ev}', 'event', 'E', 'calendar:default', 'calendar', '{AT}', '{AT}');
         INSERT INTO event (id, starts, timing) VALUES ('{ev}', '2030-03-02T09:00', 'floating');"
    ));
    let note = w.entity(61, "note", "N");
    let ada = w.entity(62, "person", "Ada");
    let bob = w.entity(63, "person", "Bob");
    w.takes(&format!(
        "INSERT INTO person (id) VALUES ('{ada}'); INSERT INTO person (id) VALUES ('{bob}');
         INSERT INTO person_date (id, person_id, kind, single, date) VALUES ('d1', '{ada}', 'birthday', 1, '1990-03-14');
         INSERT INTO person_date (id, person_id, kind, single, date) VALUES ('d2', '{ada}', 'anniversary', 0, '--06-01');"
    ));
    let rem = |rid: &str, entity: &str, kind: &str, date: &str, offset: &str| {
        format!(
            "INSERT INTO reminder (id, entity_id, entity_kind, date_id, offset_min)
             VALUES ('{rid}', '{entity}', '{kind}', {date}, {offset})"
        )
    };
    // An event takes one directly; a lead is never negative.
    w.takes(&rem("e1", &ev, "event", "NULL", "10"));
    w.refuses(&rem("e2", &ev, "event", "NULL", "-1"));
    // The same lead twice on one target is one reminder.
    w.refuses(&rem("e3", &ev, "event", "NULL", "10"));
    // A kind with no time to fire at has none.
    w.refuses(&rem("n1", &note, "note", "NULL", "10"));
    // An event names no child; a person must name a date, and one of their own.
    w.refuses(&rem("e4", &ev, "event", "'d1'", "10"));
    w.refuses(&rem("p1", &ada, "person", "NULL", "10"));
    w.refuses(&rem("p2", &bob, "person", "'d1'", "10"));
    w.takes(&rem("p3", &ada, "person", "'d1'", "1440"));
    // The same lead on two dates of one person is two reminders.
    w.takes(&rem("p4", &ada, "person", "'d2'", "1440"));
    // A reminder names a date or a field, never both, and carries its entity's real kind.
    w.refuses_with(
        &format!(
            "INSERT INTO reminder (id, entity_id, entity_kind, date_id, field_id, offset_min)
             VALUES ('b1', '{ada}', 'person', 'd1', 'f1', 5)"
        ),
        "CHECK",
    );
    w.refuses(&rem("k1", &ada, "task", "NULL", "10"));
    // A Locker reminder names a date field of its own item, not another's or a text one.
    let item = w.entity(64, "locker_item", "Bank");
    let other = w.entity(65, "locker_item", "Other");
    w.takes(&format!(
        "INSERT INTO locker_item (id, type) VALUES ('{item}', 'login'); INSERT INTO locker_item (id, type) VALUES ('{other}', 'login');
         INSERT INTO locker_item_field (id, item_id, label, kind, value_text, created_at, updated_at)
           VALUES ('fd', '{item}', 'Expiry', 'date', '2030-01-31', '{AT}', '{AT}');
         INSERT INTO locker_item_field (id, item_id, label, kind, value_text, created_at, updated_at)
           VALUES ('ft', '{item}', 'Note', 'text', 'x', '{AT}', '{AT}');"
    ));
    let field = |rid: &str, entity: &str, field: &str| {
        format!(
            "INSERT INTO reminder (id, entity_id, entity_kind, field_id, offset_min)
             VALUES ('{rid}', '{entity}', 'locker_item', {field}, 0)"
        )
    };
    w.refuses(&field("l1", &item, "NULL"));
    w.refuses(&field("l2", &item, "'ft'"));
    w.refuses(&field("l3", &other, "'fd'"));
    w.takes(&field("l4", &item, "'fd'"));
}

#[test]
fn an_alert_row_is_a_key_in_a_timing_it_says() {
    let w = World::new("rules_alert");
    let row = |timing: &str, key: &str| {
        format!(
            "INSERT INTO alert (reminder_id, n, timing, fire_key, repeats) VALUES ('{}', 1, '{timing}', '{key}', 0)",
            id(70)
        )
    };
    w.refuses(&row("fixed", "2026-03-01T09:00"));
    w.refuses(&row("floating", "2026-03-01T09:00:00.000Z"));
    w.refuses(&row("local", "2026-03-01T09:00"));
    w.takes(&row("fixed", "2026-03-01T09:00:00.000Z"));
    w.refuses(&row("floating", "2026-03-01T09:00"));
    w.takes(&format!(
        "DELETE FROM alert WHERE reminder_id = '{}'",
        id(70)
    ));
    w.takes(&row("floating", "2026-03-01T09:00"));
}
