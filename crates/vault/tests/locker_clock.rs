//! The file holds Locker's own rules (#1214, I2 to I7), each by a raw row the database itself
//! refuses (a good row of the same shape is taken first, so a refusal is the rule's and not a
//! typo's), and every Locker table stamps the vault's injected clock, never the host's.

mod common;

use common::locker::{add, id_of, item_id, key_id, plain, secret, world};
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00.000Z";

fn raw(w: &common::world::World, sql: &str) -> Result<(), String> {
    w.vault()
        .commit(|tx| {
            tx.connection().execute_batch(sql)?;
            Ok(())
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn takes(w: &common::world::World, sql: &str) {
    raw(w, sql).unwrap_or_else(|why| panic!("a good row was refused: {sql}\n{why}"));
}

fn refuses(w: &common::world::World, sql: &str, rule: &str) {
    match raw(w, sql) {
        Ok(()) => panic!("the database took what it should refuse ({rule}): {sql}"),
        Err(why) => {
            assert!(
                !["no such", "syntax error", "has no column"]
                    .iter()
                    .any(|bad| why.contains(bad)),
                "`{sql}` failed for a reason that is not a held rule: {why}"
            );
        }
    }
}

#[test]
fn the_file_refuses_what_the_commands_say_in_a_sentence() {
    let w = world("locker_rules");
    let item = item_id(&w);
    add(&w, &item, "login", "Bank", vec![]);
    let live = key_id(&w);
    let field = |id: &str, extra_cols: &str, extra_vals: &str, kind: &str| {
        format!(
            "INSERT INTO locker_item_field (id, item_id, label, kind, created_at, updated_at{extra_cols})
             VALUES ('{id}', '{item}', 'L', '{kind}', '{AT}', '{AT}'{extra_vals});"
        )
    };
    let sealed = ", value_sealed, key_id, value_set_at";
    let sealed_vals = format!(", 'lk1:x', '{live}', '{AT}'");
    // Good rows of every shape.
    takes(&w, &field("ok-text", ", value_text", ", 'x'", "text"));
    takes(
        &w,
        &field("ok-url", ", value_text", ", 'https://x.example'", "url"),
    );
    takes(
        &w,
        &field("ok-date", ", value_text", ", '2031-05-04'", "date"),
    );
    takes(&w, &field("ok-sealed", sealed, &sealed_vals, "sealed"));
    takes(&w, &field("ok-otp", sealed, &sealed_vals, "otp"));
    // A sealed kind holds a sealed value, a generation and an age; a plain kind holds none.
    refuses(
        &w,
        &field("b1", "", "", "sealed"),
        "a sealed field has a sealed value",
    );
    refuses(
        &w,
        &field("b2", ", value_sealed", ", 'lk1:x'", "text"),
        "a plain field holds no sealed value",
    );
    refuses(
        &w,
        &field(
            "b3",
            ", value_text, key_id",
            &format!(", 'x', '{live}'"),
            "text",
        ),
        "a plain field names no key",
    );
    refuses(
        &w,
        &field("b4", ", value_text", ", 'x'", "sealed"),
        "a sealed field holds no plain text",
    );
    refuses(
        &w,
        &field(
            "b5",
            ", value_sealed, key_id",
            &format!(", 'lk1:x', '{live}'"),
            "sealed",
        ),
        "a secret has an age",
    );
    refuses(
        &w,
        &field(
            "b6",
            ", value_sealed, key_id, value_set_at",
            &format!(", 'lk1:x', 'nokey', '{AT}'"),
            "sealed",
        ),
        "its generation is the vault's",
    );
    // A file holds bytes, a sealed name and a generation; nothing else has a blob.
    refuses(
        &w,
        &field("b7", sealed, &sealed_vals, "file"),
        "a file has bytes",
    );
    refuses(
        &w,
        &field("b8", ", value_text, value_blob", ", 'x', 'abc'", "text"),
        "only a file names bytes",
    );
    // A date is a date; a single key needs its key; a claimed value is text.
    refuses(
        &w,
        &field("b9", ", value_text", ", 'tomorrow'", "date"),
        "a date is a date",
    );
    refuses(
        &w,
        &field("b10", ", single", ", 1", "text"),
        "a single field has a key",
    );
    refuses(
        &w,
        &field("b11", ", claimed, value_text", ", 1, 'x'", "url"),
        "an alias is text",
    );
    // One single key per item; one holder per alias, whatever its case.
    takes(
        &w,
        &field(
            "s1",
            ", field_key, single, value_text",
            ", 'username', 1, 'a'",
            "text",
        ),
    );
    refuses(
        &w,
        &field(
            "s2",
            ", field_key, single, value_text",
            ", 'username', 1, 'b'",
            "text",
        ),
        "one single key per item",
    );
    takes(
        &w,
        &field(
            "a1",
            ", field_key, claimed, value_text",
            ", 'alias', 1, 'Nick'",
            "text",
        ),
    );
    refuses(
        &w,
        &field(
            "a2",
            ", field_key, claimed, value_text",
            ", 'alias', 1, 'nick'",
            "text",
        ),
        "an alias has one holder",
    );
    // A passkey is for a site and keeps key and generation together.
    let passkey = |id: &str, rp: &str, cols: &str, vals: &str| {
        format!(
            "INSERT INTO locker_item_passkey (id, item_id, rp_id, created_at, updated_at{cols})
             VALUES ('{id}', '{item}', '{rp}', '{AT}', '{AT}'{vals});"
        )
    };
    takes(
        &w,
        &passkey(
            "p1",
            "bank.example",
            ", private_key, key_id",
            &format!(", 'lk1:x', '{live}'"),
        ),
    );
    takes(&w, &passkey("p2", "bank.example", "", ""));
    refuses(&w, &passkey("p3", "  ", "", ""), "a passkey is for a site");
    refuses(
        &w,
        &passkey("p4", "x.example", ", private_key", ", 'lk1:x'"),
        "a key names its generation",
    );
    refuses(
        &w,
        &passkey("p5", "x.example", ", key_id", &format!(", '{live}'")),
        "a generation names its key",
    );
    // The type is a lookup row; there is one key row.
    refuses(
        &w,
        &format!("UPDATE locker_item SET type = 'quantum_key' WHERE id = '{item}'"),
        "a type is a lookup row",
    );
    refuses(
        &w,
        &format!("INSERT INTO locker_key (key_id, created_at) VALUES ('second', '{AT}')"),
        "one key row",
    );
}

#[test]
fn every_locker_table_stamps_the_injected_clock() {
    let w = world("locker_clock");
    let item = item_id(&w);
    add(
        &w,
        &item,
        "login",
        "Bank",
        vec![plain("username", "me"), secret(&w, &item, "password", "x")],
    );
    let passkey = w.mint();
    w.ok(
        "locker.set_passkey",
        json!({ "item_id": item, "passkey_id": passkey, "rp_id": "bank.example",
                "private_key": common::locker::seal(&w, &passkey, "k"), "key_id": key_id(&w) }),
    );
    w.ok("locker.mark_used", json!({ "item_id": item }));
    w.ok("locker.mark_unlock_failed", json!({}));
    let day = w.vault().clock().now_text()[..10].to_owned();
    let instants = w.strings(
        "SELECT created_at FROM locker_key
         UNION ALL SELECT created_at || '|' || updated_at || '|' || ifnull(value_set_at, '') FROM locker_item_field
         UNION ALL SELECT created_at || '|' || updated_at FROM locker_item_passkey
         UNION ALL SELECT last_used_at FROM locker_item
         UNION ALL SELECT failed_unlock_at FROM locker_key",
        &[],
    );
    assert!(instants.len() >= 5);
    for row in instants {
        for stamp in row.split('|').filter(|stamp| !stamp.is_empty()) {
            assert!(
                stamp.starts_with(&day),
                "`{stamp}` is not the injected clock's ({day})"
            );
        }
    }
    let _ = id_of(&item, "x");
}
