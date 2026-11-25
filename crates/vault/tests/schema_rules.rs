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
// K9: following. What the engine says of a store, the database refuses of any writer
// ---------------------------------------------------------------------------------------------

#[test]
fn a_source_is_of_a_kind_its_system_yields_and_names_a_device_only_where_its_system_does() {
    let w = World::new("rules_sources");
    let person = w.entity(30, "person", "Ada");
    let event_home = w.entity(31, "calendar", "C");
    let reading = w.entity(32, "reading", "");
    w.takes(&format!(
        "INSERT INTO origin (id, system, ref, label, device_id, created_at)
         VALUES ('o-contacts', 'contacts', 'icloud', 'iCloud', 'phone-1', '{AT}'),
                ('o-health', 'health', 'Health', 'Health', 'phone-1', '{AT}')"
    ));
    w.takes(&format!(
        "INSERT INTO origin (id, system, ref, label, created_at, fills, fills_kind)
         VALUES ('o-bank', 'statement', 'bank', 'Bank', '{AT}', '{}', 'account')",
        w.entity(33, "account", "A")
    ));
    let source = |id: &str, origin: &str, system: &str, device: &str, entity: &str, kind: &str| {
        format!(
            "INSERT INTO source (id, origin_id, system, external_id, device_id, entity_id, entity_kind, stated, seen_at)
             VALUES ('{id}', '{origin}', '{system}', '{id}', {device}, '{entity}', '{kind}', '{{}}', '{AT}')"
        )
    };
    // `source_shape` says which kinds a system yields: contacts yield a person, not an event.
    w.refuses(&source(
        "s1",
        "o-contacts",
        "contacts",
        "'phone-1'",
        &event_home,
        "calendar",
    ));
    w.refuses(&source(
        "s2",
        "o-contacts",
        "contacts",
        "'phone-1'",
        &reading,
        "reading",
    ));
    w.takes(&source(
        "s3",
        "o-contacts",
        "contacts",
        "'phone-1'",
        &person,
        "person",
    ));
    // `health` yields a reading (and a workout): both rows are in the shape table.
    w.takes(&source(
        "s4",
        "o-health",
        "health",
        "'phone-1'",
        &reading,
        "reading",
    ));
    // A source's system is its origin's.
    w.refuses(&source(
        "s5",
        "o-health",
        "contacts",
        "'phone-1'",
        &person,
        "person",
    ));
    // Only a system that names a device may name one on a source.
    let txn = w.entity(34, "txn", "T");
    w.refuses(&source(
        "s6",
        "o-bank",
        "statement",
        "'phone-1'",
        &txn,
        "txn",
    ));
    w.takes(&source("s6", "o-bank", "statement", "NULL", &txn, "txn"));
    // A record is one source of an origin: the key is the record's id and the install.
    w.refuses(&source(
        "s3",
        "o-contacts",
        "contacts",
        "'phone-1'",
        &person,
        "person",
    ));
}

#[test]
fn a_cursor_is_one_installs_and_a_retired_origin_holds_none() {
    let w = World::new("rules_cursors");
    let origin = |id: &str, system: &str, extra_columns: &str, extra_values: &str| {
        format!(
            "INSERT INTO origin (id, system, ref, label, created_at {extra_columns})
             VALUES ('{id}', '{system}', '{id}', 'l', '{AT}' {extra_values})"
        )
    };
    // A cursor without the install that read it, or on a store that names no device.
    w.refuses(&origin("c1", "health", ", cursor", ", 'token'"));
    w.refuses(&origin("c2", "statement", ", cursor", ", 'token'"));
    w.takes(&origin(
        "c3",
        "health",
        ", cursor, device_id",
        ", 'token', 'phone-1'",
    ));
    // A retired origin keeps its row but not its position.
    w.refuses(&origin(
        "c4",
        "health",
        ", cursor, device_id, retired_at",
        &format!(", 'token', 'phone-1', '{AT}'"),
    ));
    w.takes(&origin(
        "c5",
        "health",
        ", device_id, retired_at",
        &format!(", 'phone-1', '{AT}'"),
    ));
    w.refuses("UPDATE origin SET cursor = 'token' WHERE id = 'c5'");
    w.takes(&format!(
        "UPDATE origin SET retired_at = '{AT}', cursor = NULL WHERE id = 'c3'"
    ));
    w.refuses("UPDATE origin SET cursor = 'token' WHERE id = 'c3'");
    w.takes("UPDATE origin SET retired_at = NULL, cursor = 'token' WHERE id = 'c3'");
}

#[test]
fn the_owner_is_nobodys_record_and_a_purged_rows_source_never_takes_a_row_again() {
    let w = World::new("rules_owner_tombstone");
    let owner = w
        .scratch
        .vault
        .self_id()
        .expect("a read")
        .expect("an owner");
    let ada = w.entity(40, "person", "Ada");
    let grace = w.entity(41, "person", "Grace");
    w.takes(&format!(
        "INSERT INTO origin (id, system, ref, label, device_id, created_at)
         VALUES ('o', 'contacts', 'icloud', 'iCloud', 'phone-1', '{AT}')"
    ));
    let source = |id: &str, entity: &str| {
        format!(
            "INSERT INTO source (id, origin_id, system, external_id, device_id, entity_id, entity_kind, stated, seen_at)
             VALUES ('{id}', 'o', 'contacts', '{id}', 'phone-1', {entity}, 'person', '{{}}', '{AT}')"
        )
    };
    w.refuses_with(
        &source("s0", &format!("'{owner}'")),
        "never names the vault's owner",
    );
    w.takes(&source("s1", &format!("'{ada}'")));
    w.refuses_with(
        &format!("UPDATE source SET entity_id = '{owner}' WHERE id = 's1'"),
        "never names the vault's owner",
    );
    // Purging the row leaves the source behind with no row: a tombstone. It never takes one again.
    w.takes(&format!("DELETE FROM entity WHERE id = '{ada}'"));
    w.takes("UPDATE source SET stated = '{\"title\":\"Ada\"}' WHERE id = 's1'");
    w.refuses_with(
        &format!("UPDATE source SET entity_id = '{grace}', entity_kind = 'person' WHERE id = 's1'"),
        "never takes a row again",
    );
    // A source that still has a row is another matter: a merge moves it to another row.
    w.takes(&source("s2", &format!("'{grace}'")));
    let alan = w.entity(42, "person", "Alan");
    w.takes(&format!(
        "UPDATE source SET entity_id = '{alan}' WHERE id = 's2'"
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
fn an_account_a_line_a_transfer_a_budget_and_a_rule_hold_the_rules_money_states() {
    let w = World::new("rules_money");
    let (a1, a2) = (w.entity(40, "account", "A"), w.entity(41, "account", "B"));
    let acct = |a: &str, extra: &str| {
        format!(
            "INSERT INTO account (id, type, currency{extra}) VALUES ('{a}', 'checking', 'USD'{})",
            if extra.is_empty() {
                ""
            } else {
                ", 5, '2026-01-01'"
            }
        )
    };
    // A type is a row of the lookup; an opening balance that is not nothing has its day; a currency is three capitals.
    w.refuses_with(
        &format!("INSERT INTO account (id, type, currency) VALUES ('{a1}', 'mortgage', 'USD')"),
        "FOREIGN KEY",
    );
    w.refuses(&format!("INSERT INTO account (id, type, currency, opening_minor) VALUES ('{a1}', 'checking', 'USD', 5)"));
    w.refuses(&format!(
        "INSERT INTO account (id, type, currency) VALUES ('{a1}', 'checking', 'usd')"
    ));
    for kind in ["loan", "investment", "asset"] {
        w.takes(&format!(
            "INSERT INTO account (id, type, currency) VALUES ('{}', '{kind}', 'USD')",
            w.entity(100 + kind.len() as u64, "account", kind)
        ));
    }
    w.takes(&acct(&a1, ", opening_minor, opening_on"));
    w.takes(&acct(&a2, ""));
    // A line: a day, the closed sets of status and origin, both halves of what was charged or neither.
    let line = |n: u64, a: &str, cols: &str, vals: &str| {
        let t = w.entity(n, "txn", "T");
        format!(
            "INSERT INTO txn (id, account_id, posted_on, amount_minor{cols}) VALUES ('{t}', '{a}', '2026-03-01', -300{vals})"
        )
    };
    w.refuses(&line(42, &a1, ", status", ", 'void'"));
    w.refuses(&line(43, &a1, ", entered", ", 'robot'"));
    w.refuses(&line(44, &a1, ", original_amount_minor", ", 5"));
    w.refuses(&line(
        45,
        &a1,
        ", original_amount_minor, original_currency",
        ", 5, 'eur'",
    ));
    w.takes(&line(
        46,
        &a1,
        ", original_amount_minor, original_currency, entered",
        ", 5, 'EUR', 'hand'",
    ));
    let (h1, h2, h3) = (id(46), w.entity(47, "txn", "T2"), w.entity(48, "txn", "T3"));
    w.takes(&format!("INSERT INTO txn (id, account_id, posted_on, amount_minor, entered) VALUES ('{h2}', '{a2}', '2026-03-01', 300, 'hand')"));
    w.takes(&format!("INSERT INTO txn (id, account_id, posted_on, amount_minor, entered) VALUES ('{h3}', '{a2}', '2026-03-01', -9, 'hand')"));
    // A hand line is edited and may become a statement line; nothing else ever changes `entered`, and
    // a statement line's day, amount, account and what was charged never change.
    w.takes(&format!("UPDATE txn SET amount_minor = -250, posted_on = '2026-03-02' WHERE id = '{h2}'; UPDATE txn SET amount_minor = 300 WHERE id = '{h2}'"));
    w.refuses_with(&format!("UPDATE txn SET entered = 'statement' WHERE id = '{h3}'; UPDATE txn SET entered = 'hand' WHERE id = '{h3}'"), "origin never changes");
    let stated = w.entity(49, "txn", "T4");
    w.takes(&format!("INSERT INTO txn (id, account_id, posted_on, amount_minor) VALUES ('{stated}', '{a2}', '2026-03-01', -4)"));
    w.refuses_with(
        &format!("UPDATE txn SET amount_minor = 1 WHERE id = '{stated}'"),
        "never edited",
    );
    // A transfer: two accounts, two directions, the lower id first, a line in one pair, and a paired
    // line keeps its account and direction; the pair goes with either line.
    let (lo, hi) = if h1 < h2 {
        (h1.clone(), h2.clone())
    } else {
        (h2.clone(), h1.clone())
    };
    w.refuses(&format!(
        "INSERT INTO transfer (a, b) VALUES ('{hi}', '{lo}')"
    ));
    w.refuses_with(
        &format!("INSERT INTO transfer (a, b) VALUES ('{h2}', '{h3}')"),
        "out of one account",
    );
    w.takes(&format!(
        "INSERT INTO transfer (a, b) VALUES ('{lo}', '{hi}')"
    ));
    w.refuses_with(
        &format!("UPDATE txn SET amount_minor = -5 WHERE id = '{h2}'"),
        "keeps its account",
    );
    w.refuses_with(
        &format!("UPDATE txn SET account_id = '{a1}' WHERE id = '{h2}'"),
        "keeps its account",
    );
    w.takes(&format!(
        "UPDATE txn SET amount_minor = 400 WHERE id = '{h2}'"
    ));
    // A budget has a real month and an amount that is not negative; no currency column.
    w.refuses("INSERT INTO budget (category_id, month, amount_minor) VALUES ('category:food', '2026-13', 5)");
    w.refuses("INSERT INTO budget (category_id, month, amount_minor) VALUES ('category:food', '2026-03', -5)");
    w.takes("INSERT INTO budget (category_id, month, amount_minor) VALUES ('category:food', '2026-03', 5)");
    // A rule's pattern is a JSON object with its version, a way to match, words, and a sane range.
    let rule = |n: u64, pattern: &str, name: &str| {
        format!(
            "INSERT INTO rule (id, pattern, display_name, category_id, position, created_at) VALUES ('{}', '{pattern}', {name}, 'category:food', 1, '{AT}')",
            id(n)
        )
    };
    w.refuses(&rule(60, r#"{"match":"is","text":"x"}"#, "NULL"));
    w.refuses(&rule(61, r#"{"v":1,"match":"fuzzy","text":"x"}"#, "NULL"));
    w.refuses(&rule(62, r#"{"v":1,"match":"is","text":"  "}"#, "NULL"));
    w.refuses(&rule(
        63,
        r#"{"v":1,"match":"is","text":"x","min":-1}"#,
        "NULL",
    ));
    w.refuses(&rule(
        64,
        r#"{"v":1,"match":"is","text":"x","min":9,"max":3}"#,
        "NULL",
    ));
    w.refuses(&rule(65, r#"{"v":1,"match":"is","text":"x"}"#, "' '"));
    w.takes(&rule(
        66,
        r#"{"v":1,"match":"contains","text":"x","min":3,"max":9}"#,
        "'Payee'",
    ));
    // A checkpoint is a real day.
    w.refuses(&format!(
        "INSERT INTO checkpoint (account_id, day, balance_minor) VALUES ('{a1}', '2026-02-30', 1)"
    ));
    w.takes(&format!(
        "INSERT INTO checkpoint (account_id, day, balance_minor) VALUES ('{a1}', '2026-02-28', 1)"
    ));
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
    // A note needs a title (`entity_kind.may_be_unnamed = 0`), a blank one is none; a kind that may
    // be unnamed (a photograph) takes an empty one. The words' size is the command's budget, not a rule.
    for blank in ["", "  "] {
        w.refuses_with(
            &format!(
                "INSERT INTO entity (id, kind, title, created_at, updated_at)
                 VALUES ('{}', 'note', '{blank}', '{AT}', '{AT}')",
                id(203)
            ),
            "FOREIGN KEY",
        );
    }
    w.entity(204, "photo", "");
    w.takes(&format!("INSERT INTO note (id) VALUES ('{note}')"));
    w.refuses_with(
        &format!("UPDATE entity SET title = ' ' WHERE id = '{note}'"),
        "FOREIGN KEY",
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

// ---------------------------------------------------------------------------------------------
// People (G1-G3, L1): the sentences of `person.*`, `touch.*` are the database's too
// ---------------------------------------------------------------------------------------------

#[test]
fn a_person_needs_a_name_and_a_form_the_lookup_holds() {
    let w = World::new("rules_person");
    let blank = id(80);
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{blank}', 'person', '  ', '{AT}', '{AT}')"
    ));
    let ada = w.entity(81, "person", "Ada");
    w.takes(&format!("INSERT INTO person (id, given, family, org, cadence_days) VALUES ('{ada}', 'Ada', 'L', 'Engines', 7)"));
    let bob = w.entity(82, "person", "Bob");
    w.refuses(&format!(
        "INSERT INTO person (id, form) VALUES ('{bob}', 'robot')"
    ));
    w.refuses(&format!(
        "INSERT INTO person (id, cadence_days) VALUES ('{bob}', 0)"
    ));
    w.takes(&format!(
        "INSERT INTO person (id, form) VALUES ('{bob}', 'pet')"
    ));
}

#[test]
fn a_person_date_is_a_day_of_a_kind_the_lookup_holds_and_a_single_kind_is_held_once() {
    let w = World::new("rules_person_date");
    let ada = w.entity(83, "person", "Ada");
    w.takes(&format!("INSERT INTO person (id) VALUES ('{ada}')"));
    let row = |rid: &str, kind: &str, single: u8, date: &str| {
        format!(
            "INSERT INTO person_date (id, person_id, kind, single, date) VALUES ('{rid}', '{ada}', '{kind}', {single}, '{date}')"
        )
    };
    w.takes(&row("a", "birthday", 1, "1990-03-14"));
    // A second birthday, whatever its day.
    w.refuses(&row("b", "birthday", 1, "--03-15"));
    // A kind the lookup does not hold, and a `single` that is not the kind's own.
    w.refuses(&row("c", "feast", 0, "--03-15"));
    w.refuses(&row("d", "anniversary", 1, "--03-15"));
    // A yearless day, a leap day with no year; and what is not a day.
    w.takes(&row("e", "anniversary", 0, "--02-29"));
    w.takes(&row("f", "other", 0, "2024-02-29"));
    for bad in [
        "soon",
        "--02-30",
        "2023-02-29",
        "03-14",
        "--13-01",
        "1990-3-14",
    ] {
        w.refuses(&row("g", "other", 0, bad));
    }
    w.refuses(&format!(
        "INSERT INTO person_date (id, person_id, kind, single, label, date) VALUES ('h', '{ada}', 'other', 0, '  ', '--01-01')"
    ));
}

#[test]
fn a_contact_point_is_one_per_spelling_and_one_is_preferred_per_kind() {
    let w = World::new("rules_contact_point");
    let ada = w.entity(84, "person", "Ada");
    w.takes(&format!("INSERT INTO person (id) VALUES ('{ada}')"));
    let row = |rid: &str, kind: &str, normalized: &str, preferred: u8| {
        format!(
            "INSERT INTO contact_point (id, person_id, kind, value, normalized, preferred, position)
             VALUES ('{rid}', '{ada}', '{kind}', '{normalized}', '{normalized}', {preferred}, 1)"
        )
    };
    w.takes(&row("a", "phone", "+15550100", 1));
    w.refuses(&row("b", "phone", "+15550100", 0));
    w.refuses(&row("c", "phone", "+15550101", 1));
    w.takes(&row("d", "phone", "+15550101", 0));
    w.takes(&row("e", "email", "a@b.c", 1));
    w.refuses(&row("f", "fax", "1", 0));
    w.refuses(&format!(
        "INSERT INTO contact_point (id, person_id, kind, value, normalized, position) VALUES ('g', '{ada}', 'url', '  ', 'x', 1)"
    ));
}

#[test]
fn a_touch_has_a_touch_kind_and_does_not_end_before_it_starts() {
    let w = World::new("rules_touch");
    let kind = w.entity(85, "touch_kind", "Call");
    w.takes(&format!(
        "INSERT INTO concept (id, kind, key) VALUES ('{kind}', 'touch_kind', 'postcard')"
    ));
    let tag = w.entity(86, "tag", "Tag");
    w.takes(&format!(
        "INSERT INTO concept (id, kind, key) VALUES ('{tag}', 'tag', 'tag')"
    ));
    let touch = |n: u64, type_id: &str, starts: &str, ends: &str| {
        let t = w.entity(n, "touch", "Call");
        format!(
            "INSERT INTO touch (id, type_id, starts, ends) VALUES ('{t}', '{type_id}', '{starts}', {ends})"
        )
    };
    w.takes(&touch(
        87,
        &kind,
        "2026-03-01T10:00:00.000Z",
        "'2026-03-01T11:00:00.000Z'",
    ));
    w.takes(&touch(88, &kind, "2026-03-01T10:00:00.000Z", "NULL"));
    w.refuses(&touch(
        89,
        &kind,
        "2026-03-01T10:00:00.000Z",
        "'2026-03-01T09:00:00.000Z'",
    ));
    // A tag is not a touch kind; a start that is not an instant is refused.
    w.refuses(&touch(90, &tag, "2026-03-01T10:00:00.000Z", "NULL"));
    w.refuses(&touch(91, &kind, "tomorrow", "NULL"));
}

// ---------------------------------------------------------------------------------------------
// Calendar lane (#1214): an event, its guests and the one-day overrides of a series
// ---------------------------------------------------------------------------------------------

fn event_in_default_calendar(w: &World, n: u64, title: &str) -> String {
    let ev = id(n);
    w.takes(&format!(
        "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
         VALUES ('{ev}', 'event', '{title}', 'calendar:default', 'calendar', '{AT}', '{AT}')"
    ));
    ev
}

#[test]
fn an_event_reads_its_times_in_the_form_its_timing_says_and_needs_a_calendar() {
    let w = World::new("rules_event");
    let ev = event_in_default_calendar(&w, 100, "E");
    let kind = |starts: &str, ends: &str, timing: &str, zone: &str| {
        format!(
            "INSERT INTO event (id, starts, ends, timing, zone) VALUES ('{ev}', '{starts}', {ends}, '{timing}', {zone})"
        )
    };
    // All-day is a date, floating a wall clock to the minute, zoned an instant with its zone.
    w.refuses(&kind("2026-03-02T09:00", "NULL", "all-day", "NULL"));
    w.refuses(&kind("2026-03-02", "NULL", "floating", "NULL"));
    w.refuses(&kind("2026-03-02T09:00:00Z", "NULL", "zoned", "'UTC'"));
    w.refuses(&kind("2026-03-02T09:00:00.000Z", "NULL", "zoned", "NULL"));
    w.refuses(&kind("2026-03-02T09:00", "NULL", "floating", "'UTC'"));
    w.refuses(&kind("2026-03-02T09:00:00.000Z", "NULL", "zoned", "' '"));
    // The end is in the same form and not before the start.
    w.refuses(&kind(
        "2026-03-02T09:00",
        "'2026-03-02T08:00'",
        "floating",
        "NULL",
    ));
    w.refuses(&kind(
        "2026-03-02T09:00",
        "'2026-03-02'",
        "floating",
        "NULL",
    ));
    w.refuses(&kind("2026-03-02", "'2026-03-01'", "all-day", "NULL"));
    w.takes(&kind("2026-03-02", "'2026-03-02'", "all-day", "NULL"));
    // The other columns say what they hold: a closed status, busy as 0 or 1, a travel allowance of
    // minutes, a location with something in it.
    for (column, value) in [
        ("status", "'maybe'"),
        ("busy", "2"),
        ("travel_min", "-5"),
        ("location", "'  '"),
        ("rule_supported", "3"),
    ] {
        w.refuses(&format!(
            "UPDATE event SET {column} = {value} WHERE id = '{ev}'"
        ));
    }
    w.takes(&format!(
        "UPDATE event SET status = 'tentative', busy = 0, travel_min = 20, location = 'Room 4' WHERE id = '{ev}'"
    ));
    // `long` is 1 exactly when the event runs past a week, whichever form its times are in.
    let long = |ev: &str| -> Option<i64> {
        w.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT long FROM event WHERE id = ?1", [ev], |r| r.get(0))?))
            .expect("a row")
    };
    assert_eq!(long(&ev), None);
    w.takes(&format!(
        "UPDATE event SET ends = '2026-03-10' WHERE id = '{ev}'"
    ));
    assert_eq!(long(&ev), Some(1));
    let floating = event_in_default_calendar(&w, 101, "F");
    w.takes(&format!(
        "INSERT INTO event (id, starts, ends, timing) VALUES ('{floating}', '2026-03-02T09:00', '2026-03-09T09:00', 'floating')"
    ));
    assert_eq!(
        long(&floating),
        None,
        "a week to the minute is not past a week"
    );
    let zoned = event_in_default_calendar(&w, 102, "Z");
    w.takes(&format!(
        "INSERT INTO event (id, starts, ends, timing, zone) VALUES ('{zoned}', '2026-03-02T09:00:00.000Z', '2026-03-12T09:00:00.000Z', 'zoned', 'UTC')"
    ));
    assert_eq!(long(&zoned), Some(1));
    // An event has a calendar for a home, and no other kind of holder will do.
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{}', 'event', 'Homeless', '{AT}', '{AT}')",
        id(103)
    ));
    let project = w.entity_in(104, "project");
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
         VALUES ('{}', 'event', 'In a project', '{project}', 'project', '{AT}', '{AT}')",
        id(105)
    ));
}

#[test]
fn a_guest_is_one_address_of_an_event_with_one_organizer_and_outlives_its_person() {
    let w = World::new("rules_guest");
    let ev = event_in_default_calendar(&w, 110, "E");
    w.takes(&format!(
        "INSERT INTO event (id, starts, timing) VALUES ('{ev}', '2026-03-02T09:00', 'floating')"
    ));
    let with = |address: &str, column: &str, value: &str| {
        format!(
            "INSERT INTO event_guest (event_id, address, {column}) VALUES ('{ev}', '{address}', {value})"
        )
    };
    w.refuses(&with(" ", "role", "'required'"));
    w.refuses(&with("a@example.com", "role", "'chair'"));
    w.refuses(&with("a@example.com", "status", "'maybe'"));
    w.refuses(&with("a@example.com", "name", "' '"));
    w.refuses(&with("a@example.com", "organizer", "2"));
    w.takes(&with("a@example.com", "organizer", "1"));
    // An address is one guest, and an event has one organizer.
    w.refuses(&with("a@example.com", "status", "'accepted'"));
    w.refuses(&with("b@example.com", "organizer", "1"));
    w.takes(&with("b@example.com", "status", "'declined'"));
    // The person an address resolves to is a person; purging them leaves the guest.
    let ada = w.entity(111, "person", "Ada");
    w.takes(&format!("INSERT INTO person (id) VALUES ('{ada}')"));
    w.refuses(&format!(
        "UPDATE event_guest SET person_id = '{ev}' WHERE address = 'b@example.com'"
    ));
    w.takes(&format!(
        "UPDATE event_guest SET person_id = '{ada}' WHERE address = 'b@example.com'"
    ));
    w.takes(&format!("DELETE FROM entity WHERE id = '{ada}'"));
    let held: (i64, Option<String>) = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*), max(person_id) FROM event_guest WHERE event_id = ?1 AND address = 'b@example.com'",
                [&ev],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("a row");
    assert_eq!(
        held,
        (1, None),
        "the guest is still there, with nobody behind the address"
    );
    // The guests go with their event.
    w.takes(&format!("DELETE FROM entity WHERE id = '{ev}'"));
    assert_eq!(
        w.scratch
            .vault
            .read(
                |c| Ok(c.query_row("SELECT COUNT(*) FROM event_guest", [], |r| r
                    .get::<_, i64>(0))?)
            )
            .expect("a count"),
        0
    );
}

#[test]
fn a_one_day_override_is_keyed_in_its_series_form_and_belongs_to_its_timing() {
    let w = World::new("rules_occurrence");
    let zoned = event_in_default_calendar(&w, 120, "Z");
    let floating = event_in_default_calendar(&w, 121, "F");
    let all_day = event_in_default_calendar(&w, 122, "A");
    w.takes(&format!(
        "INSERT INTO event (id, starts, timing, zone, rule) VALUES ('{zoned}', '2026-03-02T08:00:00.000Z', 'zoned', 'Europe/Paris', 'FREQ=WEEKLY');
         INSERT INTO event (id, starts, timing, rule) VALUES ('{floating}', '2026-03-02T09:00', 'floating', 'FREQ=WEEKLY');
         INSERT INTO event (id, starts, timing, rule) VALUES ('{all_day}', '2026-03-02', 'all-day', 'FREQ=WEEKLY');"
    ));
    let day = |series: &str, timing: &str, key: &str, _: &str| {
        format!(
            "INSERT INTO occurrence (series_id, series_timing, original_start) VALUES ('{series}', '{timing}', '{key}')"
        )
    };
    let day2 = |series: &str, timing: &str, key: &str, columns: &str, values: &str| {
        format!(
            "INSERT INTO occurrence (series_id, series_timing, original_start, {columns}) VALUES ('{series}', '{timing}', '{key}', {values})"
        )
    };
    // The key is in the form the series reads in.
    w.refuses(&day(&zoned, "zoned", "2026-03-09T09:00", ""));
    w.refuses(&day(&floating, "floating", "2026-03-09T09:00:00.000Z", ""));
    w.refuses(&day(&all_day, "all-day", "2026-03-09T09:00", ""));
    // It names the series' own timing: a key into the series says it.
    w.refuses(&day(&zoned, "floating", "2026-03-09T09:00", ""));
    w.takes(&day(&zoned, "zoned", "2026-03-09T08:00:00.000Z", ""));
    w.takes(&day(&floating, "floating", "2026-03-09T09:00", ""));
    w.takes(&day(&all_day, "all-day", "2026-03-09", ""));
    // One row a day.
    w.refuses(&day(&all_day, "all-day", "2026-03-09", ""));
    // A moved day reads in the series' timing unless it names its own, and only a zoned one has a zone.
    w.refuses(&day2(
        &all_day,
        "all-day",
        "2026-03-16",
        "starts",
        "'2026-03-16T10:00'",
    ));
    w.takes(&day2(
        &all_day,
        "all-day",
        "2026-03-16",
        "starts, timing",
        "'2026-03-16T10:00', 'floating'",
    ));
    w.refuses(&day2(
        &all_day,
        "all-day",
        "2026-03-23",
        "starts, timing, zone",
        "'2026-03-23T10:00', 'floating', 'UTC'",
    ));
    w.refuses(&day2(
        &all_day,
        "all-day",
        "2026-03-23",
        "starts, timing",
        "'2026-03-23T10:00:00.000Z', 'zoned'",
    ));
    w.takes(&day2(
        &all_day,
        "all-day",
        "2026-03-23",
        "starts, timing, zone",
        "'2026-03-23T10:00:00.000Z', 'zoned', 'UTC'",
    ));
    w.refuses(&day2(
        &floating,
        "floating",
        "2026-03-16T09:00",
        "location",
        "' '",
    ));
    // A series cannot change timing under its days; deleting it takes them.
    w.refuses(&format!("UPDATE event SET timing = 'floating', zone = NULL, starts = '2026-03-02T09:00' WHERE id = '{zoned}'"));
    w.takes(&format!("DELETE FROM entity WHERE id = '{zoned}'"));
    assert_eq!(
        w.scratch
            .vault
            .read(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM occurrence WHERE series_id = ?1",
                [&zoned],
                |r| r.get::<_, i64>(0)
            )?))
            .expect("a count"),
        0
    );
}

// ---------------------------------------------------------------------------------------------
// Tasks lane (#1214): a task's due, its day, its series and its alerts
// ---------------------------------------------------------------------------------------------

fn task_row(w: &World, n: u64, title: &str) -> String {
    let t = id(n);
    w.takes(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{t}', 'task', '{title}', '{AT}', '{AT}')"
    ));
    t
}

#[test]
fn a_task_has_a_title_a_due_in_the_form_its_timing_says_and_a_day_of_its_own() {
    let w = World::new("rules_task");
    // A task is named: a blank title is refused.
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{}', 'task', ' ', '{AT}', '{AT}')",
        id(130)
    ));
    let t = task_row(&w, 131, "Call");
    let ins = |columns: &str, values: &str| {
        format!("INSERT INTO task (id, {columns}) VALUES ('{t}', {values})")
    };
    // The due and its timing are set together, the zone exactly when zoned.
    w.refuses(&ins("due", "'2026-03-02'"));
    w.refuses(&ins("due_timing", "'all-day'"));
    w.refuses(&ins("due, due_timing", "'2026-03-02T09:00', 'all-day'"));
    w.refuses(&ins("due, due_timing", "'2026-03-02', 'floating'"));
    w.refuses(&ins("due, due_timing", "'2026-03-02T09:00:30', 'floating'"));
    w.refuses(&ins("due, due_timing", "'2026-03-02T09:00:00Z', 'zoned'"));
    w.refuses(&ins(
        "due, due_timing, zone",
        "'2026-03-02T09:00:00.000Z', 'zoned', NULL",
    ));
    w.refuses(&ins(
        "due, due_timing, zone",
        "'2026-03-02T09:00', 'floating', 'UTC'",
    ));
    w.refuses(&ins("due, due_timing", "'2026-03-02', 'noon'"));
    // The planned day is a date, and not the due.
    w.refuses(&ins("scheduled_on", "'2026-03-02T09:00'"));
    w.refuses(&ins("scheduled_on", "'2026-02-30'"));
    // The columns say what they hold: a priority of 0 to 9, an effort of minutes, a link with an
    // address, a closed status and anchor.
    for (column, value) in [
        ("priority", "10"),
        ("effort_min", "0"),
        ("url", "' '"),
        ("status", "'later'"),
        ("anchor", "'whenever'"),
    ] {
        w.refuses(&ins(column, value));
    }
    w.takes(&ins(
        "due, due_timing, zone, scheduled_on, priority, effort_min, url",
        "'2026-03-02T08:00:00.000Z', 'zoned', 'Europe/Paris', '2026-03-01', 9, 30, 'https://example.com'",
    ));
    // Done is exactly when it says when, in the clock's one form; a snooze belongs to an open task.
    w.refuses(&format!("UPDATE task SET status = 'done' WHERE id = '{t}'"));
    w.refuses(&format!(
        "UPDATE task SET done_at = '{AT}' WHERE id = '{t}'"
    ));
    w.refuses(&format!(
        "UPDATE task SET status = 'done', done_at = '2026-03-01' WHERE id = '{t}'"
    ));
    w.takes(&format!(
        "UPDATE task SET snoozed_until = '{AT}' WHERE id = '{t}'"
    ));
    w.refuses(&format!(
        "UPDATE task SET snoozed_until = '2026-03-01T09:00' WHERE id = '{t}'"
    ));
    w.refuses(&format!(
        "UPDATE task SET status = 'done', done_at = '{AT}' WHERE id = '{t}'"
    ));
    w.takes(&format!(
        "UPDATE task SET snoozed_until = NULL WHERE id = '{t}'"
    ));
    w.takes(&format!(
        "UPDATE task SET status = 'done', done_at = '{AT}' WHERE id = '{t}'"
    ));
    w.refuses(&format!(
        "UPDATE task SET snoozed_until = '{AT}' WHERE id = '{t}'"
    ));
}

#[test]
fn a_repeat_needs_a_due_and_its_series_is_a_minted_id_that_points_at_no_row() {
    let w = World::new("rules_task_series");
    let t = task_row(&w, 140, "Water");
    let ins = |columns: &str, values: &str| {
        format!("INSERT INTO task (id, {columns}) VALUES ('{t}', {values})")
    };
    w.refuses(&ins("rule", "'FREQ=DAILY'"));
    w.refuses(&ins("series_id", "'not-an-id'"));
    w.refuses(&ins("series_id", "'01900000-0000-4000-8000-000000000001'"));
    // A series id names no entity: purging whatever it was minted beside cuts nothing.
    w.takes(&ins(
        "due, due_timing, rule, series_id",
        "'2026-03-02', 'all-day', 'FREQ=DAILY', '01900000-0000-7000-8000-0000000000aa'",
    ));
    let next = task_row(&w, 141, "Water");
    w.takes(&format!(
        "INSERT INTO task (id, due, due_timing, rule, series_id)
         VALUES ('{next}', '2026-03-03', 'all-day', 'FREQ=DAILY', '01900000-0000-7000-8000-0000000000aa')"
    ));
    w.takes(&format!("DELETE FROM entity WHERE id = '{t}'"));
    let held: i64 = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM task WHERE series_id = '01900000-0000-7000-8000-0000000000aa'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("a count");
    assert_eq!(held, 1, "the series outlives its first task");
    // A task that repeats keeps a due: it cannot lose it and keep the rule.
    w.refuses(&format!(
        "UPDATE task SET due = NULL, due_timing = NULL WHERE id = '{next}'"
    ));
}

#[test]
fn a_reminder_counts_back_from_a_due_so_a_task_without_one_holds_none() {
    let w = World::new("rules_task_reminder");
    let t = task_row(&w, 150, "Call");
    w.takes(&format!("INSERT INTO task (id) VALUES ('{t}')"));
    let remind = |rid: &str| {
        format!(
            "INSERT INTO reminder (id, entity_id, entity_kind, offset_min) VALUES ('{rid}', '{t}', 'task', 10)"
        )
    };
    w.refuses_with(&remind("r1"), "counts back from a due date");
    w.takes(&format!(
        "UPDATE task SET due = '2026-03-02', due_timing = 'all-day' WHERE id = '{t}'"
    ));
    w.takes(&remind("r1"));
    // Clearing the due takes the task's reminders with it.
    w.takes(&format!(
        "UPDATE task SET due = NULL, due_timing = NULL WHERE id = '{t}'"
    ));
    let held: i64 = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM reminder WHERE entity_id = ?1",
                [&t],
                |r| r.get(0),
            )?)
        })
        .expect("a count");
    assert_eq!(held, 0);
}

// ---------------------------------------------------------------------------------------------
// Docs, Photos and Places (#1214): C2, A11, H1, H3, D5
// ---------------------------------------------------------------------------------------------

#[test]
fn a_document_a_folder_an_album_and_a_place_need_a_name_and_a_photograph_does_not() {
    let w = World::new("rules_docs_names");
    for (n, kind) in [
        (402, "document"),
        (404, "folder"),
        (406, "album"),
        (408, "place"),
    ] {
        for blank in ["", "  "] {
            w.refuses_with(
                &format!(
                    "INSERT INTO entity (id, kind, title, created_at, updated_at)
                     VALUES ('{}', '{kind}', '{blank}', '{AT}', '{AT}')",
                    id(401)
                ),
                "FOREIGN KEY",
            );
        }
        w.entity(n, kind, "Named");
    }
    w.entity(403, "photo", "");
}

#[test]
fn a_document_sits_in_a_folder_and_a_folder_in_a_folder_and_nothing_else_is_a_home_for_one() {
    let w = World::new("rules_docs_home");
    let (outer, inner) = (
        w.entity(410, "folder", "Outer"),
        w.entity(411, "folder", "Inner"),
    );
    let book = w.entity(412, "notebook", "Book");
    let insert = |n: u64, kind: &str, parent: &str, parent_kind: &str| {
        format!(
            "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
             VALUES ('{}', '{kind}', 'x', '{parent}', '{parent_kind}', '{AT}', '{AT}')",
            id(n)
        )
    };
    w.takes(&insert(413, "document", &outer, "folder"));
    w.refuses_with(&insert(414, "document", &book, "notebook"), "FOREIGN KEY");
    w.takes(&format!(
        "UPDATE entity SET parent_id = '{outer}', parent_kind = 'folder' WHERE id = '{inner}'"
    ));
    // A folder never ends up inside itself, however deep.
    w.refuses_with(
        &format!(
            "UPDATE entity SET parent_id = '{inner}', parent_kind = 'folder' WHERE id = '{outer}'"
        ),
        "no loops",
    );
    // Two siblings may repeat a name.
    w.takes(&insert(415, "folder", &outer, "folder").replace("'x'", "'Inner'"));
    // A document is one column's home: it has no second one.
    w.takes(&format!(
        "UPDATE entity SET parent_id = NULL, parent_kind = NULL WHERE id = '{}'",
        id(413)
    ));
}

#[test]
fn a_photograph_is_a_picture_with_a_kept_clip_whole_coordinates_and_a_lineage_without_loops() {
    let w = World::new("rules_photo");
    let hash = "d".repeat(64);
    let clip = "e".repeat(64);
    w.takes(&format!(
        "INSERT INTO blob (hash, size) VALUES ('{hash}', 3), ('{clip}', 4)"
    ));
    let one = w.entity(420, "photo", "");
    let row = |id: &str, extra_cols: &str, extra_vals: &str, media: &str| {
        format!(
            "INSERT INTO photo (id, blob, media_type, form{extra_cols})
             VALUES ('{id}', '{hash}', '{media}', 'photo'{extra_vals})"
        )
    };
    // Sound is kept in Docs.
    w.refuses_with(&row(&one, "", "", "audio/mpeg"), "CHECK");
    w.refuses_with(&row(&one, "", "", "AUDIO/ogg"), "CHECK");
    // `form` is a lookup row.
    w.refuses_with(
        &format!("INSERT INTO photo (id, blob, media_type, form) VALUES ('{one}', '{hash}', 'image/png', 'hologram')"),
        "FOREIGN KEY",
    );
    // A latitude and a longitude go together and stay on the globe.
    w.refuses_with(&row(&one, ", lat", ", 1.0", "image/png"), "CHECK");
    w.refuses_with(
        &row(&one, ", lat, lon", ", 91.0, 0.0", "image/png"),
        "CHECK",
    );
    w.refuses_with(
        &row(&one, ", lat, lon", ", 0.0, 181.0", "image/png"),
        "CHECK",
    );
    // A clip's length needs the clip.
    w.refuses_with(
        &row(&one, ", motion_duration_s", ", 1.5", "image/png"),
        "CHECK",
    );
    w.takes(&row(
        &one,
        ", lat, lon, motion_blob, motion_duration_s",
        &format!(", 48.0, 2.0, '{clip}', 1.5"),
        "image/png",
    ));
    // The same bytes may be a second photograph: the blob is not unique.
    let two = w.entity(421, "photo", "");
    w.takes(&row(&two, "", "", "image/png"));
    // A photograph is never an edit of itself or of its own edit.
    w.refuses_with(
        &format!("UPDATE photo SET edited_from = '{one}' WHERE id = '{one}'"),
        "no loops",
    );
    w.takes(&format!(
        "UPDATE photo SET edited_from = '{one}' WHERE id = '{two}'"
    ));
    w.refuses_with(
        &format!("UPDATE photo SET edited_from = '{two}' WHERE id = '{one}'"),
        "no loops",
    );
    // A place is a named place the member has; a photograph's `place_id` is a place's id.
    let note = w.entity(422, "note", "N");
    w.refuses_with(
        &format!("UPDATE photo SET place_id = '{note}' WHERE id = '{one}'"),
        "FOREIGN KEY",
    );
    let place = w.entity(423, "place", "Cabin");
    w.takes(&format!(
        "INSERT INTO place (id, lat, lon) VALUES ('{place}', 61.0, 7.0)"
    ));
    w.refuses_with(
        &format!("UPDATE place SET lat = NULL WHERE id = '{place}'"),
        "CHECK",
    );
    w.takes(&format!(
        "UPDATE photo SET place_id = '{place}' WHERE id = '{one}'"
    ));
}

#[test]
fn an_album_holds_photographs_in_an_order_and_a_photograph_may_be_in_two() {
    let w = World::new("rules_album");
    let (a, b) = (w.entity(430, "album", "A"), w.entity(431, "album", "B"));
    let photo = w.entity(432, "photo", "");
    let note = w.entity(433, "note", "N");
    let edge = |from: &str, to: &str, position: &str| {
        format!(
            "INSERT INTO edge (from_id, rel, to_id, position, created_at)
             VALUES ('{from}', 'contains', '{to}', {position}, '{AT}')"
        )
    };
    w.takes(&edge(&a, &photo, "1.0"));
    w.takes(&edge(&b, &photo, "1.0"));
    w.refuses_with(&edge(&a, &note, "2.0"), "no edge of this relation");
    w.refuses_with(&edge(&photo, &a, "2.0"), "no edge of this relation");
}

// ---------------------------------------------------------------------------------------------
// Chat (L5, A1, A3): a chat is an ordinary entity; a message is a closed state machine
// ---------------------------------------------------------------------------------------------

#[test]
fn a_chat_needs_a_title_and_a_message_is_a_state_machine_with_lookup_reasons() {
    let w = World::new("rules_chat");
    // A chat's kind says it needs a title (the command says so in a sentence).
    w.refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{}', 'thread', '', '{AT}', '{AT}')",
        id(200)
    ));
    let chat = w.entity(201, "thread", "Chat");
    w.takes(&format!("INSERT INTO thread (id) VALUES ('{chat}')"));
    let message = |ordinal: i64, role: &str, outcome: &str, cols: &str, vals: &str| {
        format!(
            "INSERT INTO message (thread_id, ordinal, role, text, outcome, created_at, updated_at{cols})
             VALUES ('{chat}', {ordinal}, '{role}', 't', '{outcome}', '{AT}', '{AT}'{vals})"
        )
    };
    w.takes(&message(0, "user", "sent", "", ""));
    // The question is `sent` and only the question is; an answer is none of `sent`.
    w.refuses(&message(1, "user", "answered", "", ""));
    w.refuses(&message(1, "assistant", "sent", "", ""));
    w.refuses(&message(1, "assistant", "bogus", "", ""));
    // A refusal names a reason of the lookup and no other outcome does.
    w.refuses(&message(1, "assistant", "refused", "", ""));
    w.refuses(&message(
        1,
        "assistant",
        "answered",
        ", refusal",
        ", 'no_tool_fits'",
    ));
    w.refuses(&message(
        1,
        "assistant",
        "refused",
        ", refusal",
        ", 'no_such_reason'",
    ));
    w.takes(&message(
        1,
        "assistant",
        "refused",
        ", refusal",
        ", 'no_tool_fits'",
    ));
    // A notice is a row of its lookup and rides an assistant's message only.
    w.refuses(&message(
        2,
        "assistant",
        "answered",
        ", notice",
        ", 'no_such_notice'",
    ));
    w.refuses(&message(2, "user", "sent", ", notice", ", 'doc_truncated'"));
    w.takes(&message(
        2,
        "assistant",
        "answered",
        ", notice",
        ", 'doc_truncated'",
    ));
    // A lookup row a message uses is not taken away.
    w.refuses("DELETE FROM message_refusal WHERE code = 'no_tool_fits'");
    // The record is the vault's object and carries "v":1; the cards are an array and carry none.
    for bad in [
        "[1]",
        "'x'",
        "'{\"a\":1}'",
        "'{\"v\":2}'",
        "'{\"v\":\"1\"}'",
        "'{bad'",
    ] {
        let bad = bad.trim_matches('\'');
        w.refuses(&message(
            3,
            "assistant",
            "answered",
            ", record",
            &format!(", '{bad}'"),
        ));
    }
    w.refuses(&message(3, "user", "sent", ", record", ", '{\"v\":1}'"));
    w.takes(&message(
        3,
        "assistant",
        "answered",
        ", record",
        ", '{\"v\":1,\"read\":[]}'",
    ));
    w.refuses(&message(4, "assistant", "answered", ", cards", ", '{}'"));
    w.refuses(&message(4, "assistant", "answered", ", cards", ", 'nope'"));
    w.takes(&message(
        4,
        "assistant",
        "answered",
        ", cards",
        ", '[{\"app\":\"notes\"}]'",
    ));
    // A message is never born settled, and a thread holds one proposal waiting.
    for settled in ["applied", "dismissed", "stale", "failed"] {
        w.refuses_with(
            &message(5, "assistant", settled, "", ""),
            "proposed before it is settled",
        );
    }
    w.takes(&message(5, "assistant", "proposed", "", ""));
    w.refuses(&message(6, "assistant", "proposed", "", ""));
    // A proposal settles once; a told answer never changes.
    let set = |ordinal: i64, to: &str| {
        format!(
            "UPDATE message SET outcome = '{to}' WHERE thread_id = '{chat}' AND ordinal = {ordinal}"
        )
    };
    w.refuses_with(&set(2, "dismissed"), "only a proposal settles");
    w.refuses_with(&set(5, "answered"), "settles as applied");
    w.takes(&set(5, "stale"));
    w.refuses_with(&set(5, "applied"), "only a proposal settles");
    // With the first settled another may wait.
    w.takes(&message(6, "assistant", "proposed", "", ""));
    // The same ordinal is one message.
    w.refuses(&message(6, "assistant", "answered", "", ""));
    // Deleting the chat takes its messages.
    w.takes(&format!("DELETE FROM entity WHERE id = '{chat}'"));
    assert_eq!(
        w.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT count(*) FROM message", [], |r| r.get::<_, i64>(0))?))
            .unwrap(),
        0
    );
}

#[test]
fn an_attachment_is_a_photo_a_document_or_an_image_and_a_purged_item_leaves_its_label() {
    let w = World::new("rules_attachment");
    let chat = w.entity(210, "thread", "Chat");
    let photo = w.entity(211, "photo", "");
    let doc = w.entity(212, "document", "d");
    let hash = "ab".repeat(32);
    w.takes(&format!(
        "INSERT INTO thread (id) VALUES ('{chat}');
         INSERT INTO blob (hash, size) VALUES ('{hash}', 4);
         INSERT INTO message (thread_id, ordinal, role, text, outcome, created_at, updated_at)
           VALUES ('{chat}', 0, 'user', 'q', 'sent', '{AT}', '{AT}');"
    ));
    let attach = |position: i64, form: &str, entity: &str, thumb: &str| {
        format!(
            "INSERT INTO message_attachment (thread_id, ordinal, position, form, label, entity_id, thumb)
             VALUES ('{chat}', 0, {position}, '{form}', 'l', {entity}, {thumb})"
        )
    };
    let quoted = |value: &str| format!("'{value}'");
    // An image is its thumbnail and no vault item; a photo or a document holds no thumbnail.
    w.refuses(&attach(0, "image", "NULL", "NULL"));
    w.refuses(&attach(0, "image", &quoted(&photo), &quoted(&hash)));
    w.refuses(&attach(0, "photo", "NULL", &quoted(&hash)));
    w.refuses(&attach(0, "document", &quoted(&doc), &quoted(&hash)));
    w.refuses(&attach(0, "video", &quoted(&doc), "NULL"));
    w.refuses(&attach(0, "image", "NULL", &quoted(&"cd".repeat(32))));
    w.refuses(&attach(-1, "photo", &quoted(&photo), "NULL"));
    w.takes(&attach(0, "image", "NULL", &quoted(&hash)));
    w.takes(&attach(1, "photo", &quoted(&photo), "NULL"));
    w.takes(&attach(2, "document", &quoted(&doc), "NULL"));
    w.refuses(&attach(2, "document", &quoted(&doc), "NULL"));
    // A thumbnail is rented: the blob is not deleted from under it.
    w.refuses(&format!("DELETE FROM blob WHERE hash = '{hash}'"));
    // The item is purged and the label stays, pointing at nothing.
    w.takes(&format!("DELETE FROM entity WHERE id = '{doc}'"));
    assert_eq!(
        w.scratch
            .vault
            .read(|c| Ok(c.query_row(
                "SELECT count(*) FROM message_attachment WHERE form = 'document' AND label = 'l' AND entity_id IS NULL",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        1
    );
}
