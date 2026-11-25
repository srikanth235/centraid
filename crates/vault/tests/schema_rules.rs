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
