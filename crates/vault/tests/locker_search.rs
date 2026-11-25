//! SEARCH OVER LOCKER, END TO END (#1214, I1, K3): the module's commands feed the index reads, for
//! all fifteen types. Every field that is not sealed or a one-time-code seed is found (Wi-Fi
//! names, cardholders, custom plain fields, a passkey's site and every template type's fields were
//! skipped by the old reads), now and, as plain text only, in earlier versions; no `lk1:` token is
//! in `search_past` or the word list.

mod common;

use centraid_vault::commands::locker;
use common::index::{assert_equals_a_rebuild, drain, words_file};
use common::locker::{add, id_of, item_id, key_id, plain, seal, secret, world};
use serde_json::json;

fn hits(w: &common::world::World, table: &str, word: &str) -> i64 {
    w.vault()
        .read(|c| {
            Ok(c.query_row(
                &format!("SELECT count(*) FROM {table} WHERE {table} MATCH ?1"),
                [word],
                |row| row.get(0),
            )?)
        })
        .expect("counts")
}

fn token(n: usize, at: usize) -> String {
    format!("tok{n}x{at}")
}

#[test]
fn every_plain_field_of_every_type_is_found_and_no_secret_is() {
    let w = world("locker_search");
    let mut plain_tokens = Vec::new();
    let mut secret_tokens = Vec::new();
    let mut items = Vec::new();
    for (n, item_type) in locker::ITEM_TYPES.iter().enumerate() {
        let item = item_id(&w);
        let mut fields = Vec::new();
        for (at, field) in locker::built_ins(item_type).into_iter().enumerate() {
            match field.kind {
                "sealed" | "otp" => {
                    let t = format!("secret{n}x{at}");
                    fields.push(secret(&w, &item, field.key, &t));
                    secret_tokens.push(t);
                }
                "date" => fields.push(plain(field.key, "2031-05-04")),
                "url" => {
                    let t = token(n, at);
                    fields.push(plain(field.key, &format!("https://{t}.example")));
                    plain_tokens.push(t);
                }
                _ if field.claimed => {
                    let t = token(n, at);
                    fields.push(plain(field.key, &t));
                    plain_tokens.push(t);
                }
                _ => {
                    let t = token(n, at);
                    fields.push(plain(field.key, &format!("value {t}")));
                    plain_tokens.push(t);
                }
            }
        }
        // A custom plain field and a passkey's site, on every item.
        let custom = format!("custom{n}x");
        fields.push(json!({ "label": "Custom", "kind": "text", "value": format!("see {custom}") }));
        plain_tokens.push(custom);
        add(&w, &item, item_type, &format!("Item {item_type}"), fields);
        let passkey = w.mint();
        w.ok(
            "locker.set_passkey",
            json!({ "item_id": item, "passkey_id": passkey, "rp_id": format!("site{n}.passkeys.test"),
                    "private_key": seal(&w, &passkey, &format!("pkkey{n}x")), "key_id": key_id(&w) }),
        );
        plain_tokens.push(format!("site{n}"));
        secret_tokens.push(format!("pkkey{n}x"));
        items.push(item);
    }
    drain(w.vault());
    for token in &plain_tokens {
        assert_eq!(hits(&w, "search", token), 1, "`{token}` is not found");
    }
    for token in &secret_tokens {
        assert_eq!(hits(&w, "search", token), 0, "`{token}` was indexed");
        assert_eq!(hits(&w, "search_past", token), 0, "`{token}` was indexed");
    }
    // The verified misses, by name: a Wi-Fi name, a cardholder, a template type's field.
    assert_eq!(hits(&w, "search", &token(4, 0)), 1, "the Wi-Fi network");
    assert_eq!(hits(&w, "search", &token(1, 0)), 1, "the cardholder");
    assert_eq!(hits(&w, "search", "lk1"), 0);
    let words = words_file(&common::index::index_path(w.scratch.dir()));
    assert!(words.iter().all(|word| !word.contains("lk1")));
    assert_equals_a_rebuild(w.scratch.dir(), "with an item of every type");

    // The text of an item holds its plain fields in order and no sealed value.
    let text = w
        .vault()
        .read(|c| {
            centraid_vault::index::text_of(c, &items[0], centraid_vault::model::Kind::LockerItem)
        })
        .unwrap()
        .unwrap();
    assert!(
        text.contains("tok0x0") && !text.contains("secret0"),
        "{text}"
    );
}

#[test]
fn what_an_item_said_before_is_found_as_plain_text_and_a_changed_secret_leaves_no_token() {
    let w = world("locker_search_past");
    let item = item_id(&w);
    add(
        &w,
        &item,
        "login",
        "Bank",
        vec![
            plain("username", "firstname"),
            secret(&w, &item, "password", "oldsecretword"),
        ],
    );
    w.ok(
        "locker.edit_item",
        json!({ "item_id": item, "fields": [plain("username", "secondname")] }),
    );
    w.ok(
        "locker.edit_item",
        json!({ "item_id": item, "fields": [{
            "field_key": "password", "value": seal(&w, &id_of(&item, "password"), "newsecretword"),
            "key_id": key_id(&w), "changed": true }] }),
    );
    drain(w.vault());
    assert_eq!(hits(&w, "search", "firstname"), 0);
    assert_eq!(hits(&w, "search_past", "firstname"), 1, "what it said");
    assert_eq!(hits(&w, "search", "secondname"), 1);
    for secret in ["oldsecretword", "newsecretword", "lk1"] {
        assert_eq!(hits(&w, "search", secret), 0);
        assert_eq!(hits(&w, "search_past", secret), 0);
    }
    let dump = common::index::dump(w.scratch.dir())
        .into_iter()
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!dump.contains("lk1") && !dump.contains("secretword"));
    // A trashed item is not found, now or before.
    w.ok("entity.trash", json!({ "id": item }));
    drain(w.vault());
    assert_eq!(hits(&w, "search", "secondname"), 0);
    assert_equals_a_rebuild(w.scratch.dir(), "with a trashed item");
}
