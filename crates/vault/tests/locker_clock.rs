//! The Locker keeps the vault's time and the house rules (#1191, V1). A vault founded on a fixed
//! injected clock has each Locker table written, and every instant read back is the injected one:
//! no table reads a host clock (no `strftime('now')` default, no trigger that stamps one).
//! The file refuses what a type does not own, and a second Locker key.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::clock::Clock as _;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use serde_json::json;

fn ciphertext(seed: &str) -> String {
    use base64::Engine as _;
    let mut raw = vec![0_u8; 12 + 16 + 8];
    let span = raw.len();
    for (index, byte) in seed.bytes().enumerate() {
        raw[index % span] ^= byte;
    }
    format!(
        "lk1:{}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    )
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        let scratch = common::Scratch::founded("locker-clock").expect("a vault");
        scratch
            .vault
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO locker_key (key_id, created_at) VALUES ('key-1', ?1)",
                    [scratch.clock.now_text()],
                )?;
                Ok(())
            })
            .expect("the key row");
        Self {
            scratch,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("device-1"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
    }

    fn texts(&self, sql: &str) -> Vec<String> {
        self.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(sql)?;
                Ok(statement
                    .query_map([], |r| r.get::<_, Option<String>>(0))?
                    .map(|v| v.map(Option::unwrap_or_default))
                    .collect::<rusqlite::Result<_>>()?)
            })
            .expect("a read")
    }

    fn refuses(&self, sql: &str) -> String {
        match self.scratch.vault.commit(|tx| {
            tx.connection().execute(sql, [])?;
            Ok(())
        }) {
            Ok(_) => panic!("the database took what it should refuse: {sql}"),
            Err(error) => error.to_string(),
        }
    }
}

#[test]
fn every_locker_table_holds_the_instants_of_the_injected_clock() {
    let w = World::new();
    let founded = w.scratch.clock.now_text();
    // A later, different instant for the writes: any host clock would show.
    w.scratch.clock.advance_days(40);
    let at = w.scratch.clock.now_text();
    assert_ne!(at, founded);
    w.ok(
        "locker.add_item",
        json!({ "item_id": "item-1", "type": "login", "title": "The bank", "password": ciphertext("p"),
                 "password_rotated": true, "key_id": "key-1", "alias": "bank" }),
    );
    w.ok(
        "locker.set_field",
        json!({ "item_id": "item-1", "field_id": "field-1", "label": "Recovery code", "kind": "sealed",
                 "value": ciphertext("f"), "key_id": "key-1" }),
    );
    w.ok(
        "locker.set_addresses",
        json!({ "item_id": "item-1", "addresses": [{ "url": "https://m.bank.example" }] }),
    );
    w.ok(
        "locker.set_passkey",
        json!({ "item_id": "item-1", "rp_id": "bank.example", "private_key": ciphertext("k"), "key_id": "key-1" }),
    );
    w.ok("locker.mark_used", json!({ "item_id": "item-1" }));
    w.ok("locker.mark_unlock_failed", json!({}));

    for (table, column) in [
        ("locker_item_alias", "created_at"),
        ("locker_item_address", "created_at"),
        ("locker_item_field", "created_at"),
        ("locker_item_field", "updated_at"),
        ("locker_item_passkey", "created_at"),
        ("locker_item_passkey", "updated_at"),
        ("locker_item", "password_set_at"),
        ("locker_item", "last_used_at"),
        ("locker_key", "failed_unlock_at"),
    ] {
        assert_eq!(
            w.texts(&format!("SELECT {column} FROM {table}")),
            [at.as_str()],
            "{table}.{column} is the injected clock's instant"
        );
    }
    assert_eq!(w.texts("SELECT created_at FROM locker_key"), [founded]);
    // A later edit of the field moves its `updated_at` to the clock's new instant, from the
    // command, with no trigger.
    w.scratch.clock.advance_days(1);
    w.ok(
        "locker.set_field",
        json!({ "item_id": "item-1", "field_id": "field-1",
                 "label": "Recovery code", "kind": "sealed", "value": ciphertext("g"), "key_id": "key-1" }),
    );
    assert_eq!(
        w.texts("SELECT updated_at FROM locker_item_field"),
        [w.scratch.clock.now_text()]
    );
    assert_eq!(w.texts("SELECT created_at FROM locker_item_field"), [at]);
}

#[test]
fn the_file_refuses_a_second_key_a_foreign_type_column_and_a_host_stamp() {
    let w = World::new();
    assert!(w
        .refuses("INSERT INTO locker_key (key_id, created_at) VALUES ('key-2', '2026-01-01T00:00:00.000Z')")
        .contains("CHECK constraint failed: id = 1"));
    w.ok(
        "locker.add_item",
        json!({ "item_id": "item-1", "type": "login", "title": "T" }),
    );
    // A login does not own a card's columns; the command nulls them, the file refuses them.
    for column in [
        "card_number",
        "cvv",
        "brand",
        "cardholder",
        "content",
        "network",
        "fullname",
    ] {
        w.refuses(&format!(
            "UPDATE locker_item SET {column} = 'x' WHERE id = 'item-1'"
        ));
    }
    // An item can only name the key generation the vault has.
    w.refuses("UPDATE locker_item SET key_id = 'nobody' WHERE id = 'item-1'");
    // A stamp that is not the clock's one form.
    w.refuses("UPDATE locker_item SET last_used_at = '2026-03-01 09:00:00' WHERE id = 'item-1'");
    // No host-clock default or touch trigger remains in the Locker's tables.
    let schema = w
        .texts("SELECT sql FROM sqlite_schema WHERE name LIKE 'locker%' AND sql IS NOT NULL")
        .join("\n");
    assert!(
        !schema.contains("'now'") && !schema.contains("row_version"),
        "{schema}"
    );
    assert!(!schema.contains("TRIGGER"), "no Locker trigger remains");
}
