//! WHAT THE INDEX HOLDS OF A LOCKER ITEM, NOW AND IN EARLIER VERSIONS (#1214, K3). Its plain fields
//! and a passkey's site are findable, in `search` and, for what it said before, in `search_past`;
//! a sealed value, a one-time-code seed and any `lk1:` ciphertext are never tokenised anywhere in
//! the index file, not in a posting and not in the word list. A trashed item has no past rows.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use common::index::{assert_equals_a_rebuild, drain, index_path, words_file};
use serde_json::json;

/// `lk1:` and a body of base64 that is a plausible ciphertext of 40 bytes.
const CIPHER: &str = "lk1:cXdlcnR5U0VDUkVUY2lwaGVydGV4dEJPRFlib2R5Ym9keWJvZHlib2R5Ym9keQ==";
/// What a tokenizer would make of the ciphertext's body.
const TOKEN: &str = "cxdlcnr5u0vdukvuy2lwaglcnrlehrcb0rzym9keu";

fn mint(vault: &Vault) -> String {
    vault.ids().next()
}

fn hits(vault: &Vault, table: &str, word: &str) -> i64 {
    vault
        .read(|c| {
            Ok(c.query_row(
                &format!("SELECT count(*) FROM {table} WHERE {table} MATCH ?1"),
                [word],
                |row| row.get(0),
            )?)
        })
        .expect("counts")
}

/// A Locker item: a title, a plain username, a sealed password, a one-time-code seed, a plain field
/// a hostile writer filled with ciphertext, and a passkey. Raw rows, as a command's body writes them.
fn plant_item(vault: &Vault) -> (String, String, String) {
    let id = mint(vault);
    let (username, planted) = (mint(vault), mint(vault));
    let now = vault.clock().now_text();
    vault
        .commit(|tx| {
            tx.set_producer("test.locker");
            tx.insert_entity(&id, Kind::LockerItem, "Bank login", &now)?;
            let c = tx.connection();
            c.execute("INSERT INTO locker_item (id, type) VALUES (?1, 'login')", [&id])?;
            c.execute("INSERT INTO locker_key (key_id, created_at) VALUES ('k1', ?1)", [&now])?;
            let field = |fid: &str, key: Option<&str>, kind: &str, label: &str, text: Option<&str>, sealed: Option<&str>, pos: f64| {
                c.execute(
                    "INSERT INTO locker_item_field
                       (id, item_id, field_key, single, label, kind, value_text, value_sealed, key_id, value_set_at, position, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                    rusqlite::params![
                        fid, id, key, i64::from(key.is_some()), label, kind, text, sealed,
                        sealed.map(|_| "k1"), sealed.map(|_| now.clone()), pos, now
                    ],
                )
            };
            field(&username, Some("username"), "text", "Username", Some("lovelace@example.test"), None, 1.0)?;
            field(&mint(vault), Some("password"), "sealed", "Password", None, Some(CIPHER), 2.0)?;
            field(&mint(vault), Some("totp"), "otp", "Code", None, Some(CIPHER), 3.0)?;
            field(&planted, None, "text", "Notes", Some(CIPHER), None, 4.0)?;
            c.execute(
                "INSERT INTO locker_item_passkey (id, item_id, rp_id, private_key, key_id, created_at, updated_at)
                 VALUES (?1, ?2, 'accounts.passkeysite.test', ?3, 'k1', ?4, ?4)",
                rusqlite::params![mint(vault), id, CIPHER, now],
            )?;
            Ok(())
        })
        .expect("a locker item");
    (id, username, planted)
}

fn assert_no_ciphertext_anywhere(vault: &Vault, dir: &std::path::Path) {
    for table in ["search_vocab", "search_past_vocab"] {
        let terms: Vec<String> = vault
            .read(|c| {
                let mut s = c.prepare(&format!("SELECT term FROM {table}"))?;
                Ok(s.query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?)
            })
            .expect("terms");
        assert!(
            terms
                .iter()
                .all(|t| t != "lk1" && !t.contains("cxdlcnr5") && !t.contains("ciphertext")),
            "{table} holds ciphertext tokens: {terms:?}"
        );
    }
    for word in words_file(&index_path(dir)) {
        assert!(
            word != "lk1" && !word.contains("cxdlcnr5") && !word.contains("zxdlcnr5"),
            "the word list holds a ciphertext token: {word}"
        );
    }
    assert!(!TOKEN.is_empty());
}

#[test]
fn a_locker_items_plain_fields_and_a_passkeys_site_are_found_and_nothing_sealed_is() {
    let scratch = common::Scratch::founded("locker-now").expect("a vault");
    let vault = &scratch.vault;
    let (_id, _username, _planted) = plant_item(vault);
    drain(vault);
    assert_eq!(hits(vault, "search", "lovelace"), 1, "a plain field");
    assert_eq!(hits(vault, "search", "passkeysite"), 1, "a passkey's rp_id");
    assert_eq!(hits(vault, "search", "bank"), 1, "the title");
    assert_eq!(hits(vault, "search", "lk1"), 0, "no ciphertext");
    assert_no_ciphertext_anywhere(vault, scratch.dir());
    assert_equals_a_rebuild(scratch.dir(), "with a locker item");
}

#[test]
fn what_a_locker_item_said_before_is_found_in_the_past_and_a_trashed_item_has_none() {
    let scratch = common::Scratch::founded("locker-past").expect("a vault");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let (id, username, _planted) = plant_item(vault);
    // Every edit keeps the version it replaced.
    for (n, address) in ["second@example.test", "third@example.test"]
        .iter()
        .enumerate()
    {
        vault
            .commit(|tx| {
                tx.set_producer(format!("test.edit.{n}"));
                tx.connection().execute(
                    "UPDATE locker_item_field SET value_text = ?2 WHERE id = ?1",
                    rusqlite::params![username, address],
                )?;
                Ok(())
            })
            .expect("edits");
    }
    drain(vault);
    assert_eq!(hits(vault, "search", "lovelace"), 0, "not what it says now");
    assert_eq!(
        hits(vault, "search_past", "lovelace"),
        1,
        "but what it said"
    );
    assert_eq!(
        hits(vault, "search_past", "passkeysite"),
        1,
        "a passkey's site, in a version"
    );
    assert_eq!(
        hits(vault, "search_past", "third"),
        0,
        "the live value is not a past one"
    );
    assert_eq!(hits(vault, "search_past", "lk1"), 0);
    assert_no_ciphertext_anywhere(vault, scratch.dir());
    assert_equals_a_rebuild(scratch.dir(), "with a locker item's versions");

    // A trashed item has no past rows (and none of its own); a restore brings them back.
    let owner = Principal::owner("phone");
    let trash = vault
        .execute(
            &registry,
            &owner,
            &Command::new("entity.trash", json!({"id": id})),
        )
        .expect("runs");
    assert_eq!(trash.status, CommandStatus::Executed, "{:?}", trash.reason);
    drain(vault);
    assert_eq!(
        hits(vault, "search_past", "lovelace"),
        0,
        "a trashed item has no past rows"
    );
    assert_eq!(hits(vault, "search", "bank"), 0);
    assert_equals_a_rebuild(scratch.dir(), "with the item in the trash");
    let restore = vault
        .execute(
            &registry,
            &owner,
            &Command::new("entity.restore", json!({"id": id})),
        )
        .expect("runs");
    assert_eq!(
        restore.status,
        CommandStatus::Executed,
        "{:?}",
        restore.reason
    );
    drain(vault);
    assert_eq!(
        hits(vault, "search_past", "lovelace"),
        1,
        "restored, its past is back"
    );
    assert_no_ciphertext_anywhere(vault, scratch.dir());
    assert_equals_a_rebuild(scratch.dir(), "with the item restored");
}
