//! Locker as an ordinary app that seals (#1214, K): items of all fifteen types, sealed fields, the
//! secrets' age, aliases, passkeys, dated fields, the autofill reads and the stamps.
//!
//! The core's part is played by the test: it holds `K` (a constant written nowhere), seals every
//! secret against the row's id before the command, and the vault takes ciphertext only.

mod common;

use centraid_vault::alerts;
use centraid_vault::commands::locker::{self, reads};
use common::locker::{add, id_of, item_id, key_id, plain, seal, secret, world};
use serde_json::{Value, json};

fn rev_count(w: &common::world::World, id: &str) -> i64 {
    w.one("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[id])
}

/// A value for a built-in field of any type: a date a date, a secret sealed against its id.
fn fields_of_type(
    w: &common::world::World,
    item: &str,
    item_type: &str,
    alias: &str,
) -> Vec<Value> {
    locker::built_ins(item_type)
        .into_iter()
        .map(|field| match field.kind {
            "sealed" | "otp" => secret(
                w,
                item,
                field.key,
                &format!("SECRET-{}-{item_type}", field.key),
            ),
            "date" if field.key == "expiry" => plain(field.key, "08/27"),
            "date" => plain(field.key, "2031-05-04"),
            "url" => plain(field.key, "https://example.com/login"),
            _ if field.claimed => plain(field.key, alias),
            _ => plain(field.key, &format!("plain {} of a {item_type}", field.key)),
        })
        .collect()
}

#[test]
fn every_type_is_created_edited_trashed_and_restored_with_its_built_in_keys() {
    let w = world("locker_types");
    for (n, item_type) in locker::ITEM_TYPES.iter().enumerate() {
        let item = item_id(&w);
        let fields = fields_of_type(&w, &item, item_type, &format!("alias-{n}"));
        let count = fields.len();
        add(&w, &item, item_type, &format!("A {item_type}"), fields);
        // Raw rows: one per field, a secret as ciphertext with its generation and its age, a plain
        // value as text; nothing of a secret in a plain column.
        assert_eq!(
            w.one::<i64>(
                "SELECT COUNT(*) FROM locker_item_field WHERE item_id = ?1",
                &[&item]
            ),
            i64::try_from(count).unwrap(),
            "{item_type}"
        );
        for field in locker::built_ins(item_type) {
            let (kind, text, sealed, key, set_at): (
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ) = w
                .vault()
                .read(|c| {
                    Ok(c.query_row(
                        "SELECT kind, value_text, value_sealed, key_id, value_set_at
                           FROM locker_item_field WHERE item_id = ?1 AND field_key = ?2",
                        [&item, field.key],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        },
                    )?)
                })
                .unwrap_or_else(|e| panic!("{item_type}.{}: {e}", field.key));
            assert_eq!(kind, field.kind, "{item_type}.{}", field.key);
            if locker::is_sealed_kind(&kind) {
                assert!(
                    sealed.as_deref().is_some_and(|c| c.starts_with("lk1:")),
                    "{}",
                    field.key
                );
                assert_eq!(key.as_deref(), Some(key_id(&w).as_str()));
                assert!(set_at.is_some(), "{} has no age", field.key);
                assert!(text.is_none());
            } else {
                assert!(text.is_some() && sealed.is_none() && key.is_none() && set_at.is_none());
            }
        }

        // Edit: the title, a plain value and a secret that changed, in one save and one version.
        let secrets = locker::secret_keys_of(item_type);
        let before = rev_count(&w, &item);
        let mut edit = vec![json!({ "field_key": "notes", "value": "a changed memo" })];
        if let Some(key) = secrets.first() {
            let mut field = secret(&w, &item, key, "A NEW SECRET");
            field["changed"] = json!(true);
            edit.push(field);
        }
        w.ok(
            "locker.edit_item",
            json!({ "item_id": item, "title": "Renamed", "fields": edit }),
        );
        assert_eq!(
            w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&item]),
            "Renamed"
        );
        assert_eq!(
            w.one::<String>(
                "SELECT value_text FROM locker_item_field WHERE id = ?1",
                &[&id_of(&item, "notes")]
            ),
            "a changed memo"
        );
        assert_eq!(rev_count(&w, &item), before + 1, "one save is one version");

        // Trash and restore are the vault's shared verbs.
        w.ok("entity.trash", json!({ "id": item }));
        assert!(
            w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&item])
                .is_some()
        );
        w.ok("entity.restore", json!({ "id": item }));
        assert!(
            w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&item])
                .is_none()
        );
        assert_eq!(
            w.one::<i64>(
                "SELECT COUNT(*) FROM locker_item_field WHERE item_id = ?1",
                &[&item]
            ),
            i64::try_from(count).unwrap(),
            "{item_type}: the fields survive the trash"
        );
    }
}

#[test]
fn a_secret_must_arrive_sealed_under_the_live_generation_and_a_refusal_never_quotes_it() {
    let w = world("locker_refusals");
    let live = key_id(&w);
    let item = item_id(&w);
    let plaintext = "hunter2-correct-horse";
    // Plaintext, and a bare `lk1:` prefix, are refused; the sentence does not carry the value.
    for value in [plaintext, "lk1:hunter2-correct-horse"] {
        let sentence = w.refused(
            "locker.add_item",
            json!({ "item_id": item, "type": "login", "title": "Bank", "fields": [
                { "field_key": "password", "value": value, "key_id": live }
            ] }),
        );
        assert!(sentence.contains("sealed"), "{sentence}");
        assert!(!sentence.contains("hunter2"), "{sentence}");
    }
    // A stale generation is refused with the repair.
    let sentence = w.refused(
        "locker.add_item",
        json!({ "item_id": item, "type": "login", "title": "Bank", "fields": [
            { "field_key": "password", "value": seal(&w, &id_of(&item, "password"), "x"), "key_id": "stale" }
        ] }),
    );
    assert!(sentence.contains("re-enter this secret"), "{sentence}");
    // No generation named at all.
    assert!(
        w.refused(
            "locker.add_item",
            json!({ "item_id": item, "type": "login", "title": "Bank", "fields": [
                { "field_key": "password", "value": seal(&w, &id_of(&item, "password"), "x") }
            ] }),
        )
        .contains("key generation")
    );
    // A plain field never holds a sealed value.
    let cipher = seal(&w, &id_of(&item, "username"), "x");
    assert!(
        w.refused(
            "locker.add_item",
            json!({ "item_id": item, "type": "login", "title": "Bank", "fields": [plain("username", &cipher)] }),
        )
        .contains("never holds a sealed value")
    );
    // A key that is not the type's, a date that is not one, a kind that cannot change.
    for (field, said) in [
        (plain("cvv", "123"), "not one of the fields of a login"),
        (
            json!({ "label": "Odd", "kind": "date", "value": "tomorrow" }),
            "not a date",
        ),
        (json!({ "label": "Odd" }), "needs a kind"),
        (
            json!({ "field_key": "password", "kind": "text", "value": "x" }),
            "kind cannot change",
        ),
    ] {
        let sentence = w.refused(
            "locker.add_item",
            json!({ "item_id": item, "type": "login", "title": "Bank", "fields": [field] }),
        );
        assert!(sentence.contains(said), "{sentence}");
    }
    // A new sealed custom field carries the id it was sealed against.
    let sentence = w.refused(
        "locker.add_item",
        json!({ "item_id": item, "type": "login", "title": "Bank", "fields": [
            { "label": "Recovery", "kind": "sealed", "value": seal(&w, "x", "x"), "key_id": live }
        ] }),
    );
    assert!(
        sentence.contains("the id it was sealed against"),
        "{sentence}"
    );
    // Nothing was written by any of it, and an item id must be a minted one.
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM locker_item", &[]), 0);
    assert!(
        w.refused(
            "locker.add_item",
            json!({ "item_id": "not-minted", "type": "login", "title": "x" })
        )
        .contains("UUIDv7")
    );
    // The same plaintext is nowhere in the file.
    let file = std::fs::read(w.scratch.dir().join("vault.db")).unwrap();
    assert!(
        !file
            .windows(plaintext.len())
            .any(|window| window == plaintext.as_bytes())
    );
}

#[test]
fn a_secrets_age_moves_only_when_its_value_changes_and_a_seed_is_revealable() {
    let w = world("locker_age");
    let item = item_id(&w);
    add(
        &w,
        &item,
        "login",
        "Bank",
        vec![
            plain("username", "me"),
            secret(&w, &item, "password", "first"),
            secret(&w, &item, "otp_seed", "JBSWY3DPEHPK3PXP"),
        ],
    );
    let password = id_of(&item, "password");
    let age = |w: &common::world::World| {
        w.one::<String>(
            "SELECT value_set_at FROM locker_item_field WHERE id = ?1",
            &[&password],
        )
    };
    let first = age(&w);
    // A rename, and a plain edit, do not touch it.
    w.ok(
        "locker.edit_item",
        json!({ "item_id": item, "title": "Bank 2", "fields": [plain("username", "you")] }),
    );
    assert_eq!(age(&w), first);
    // A placeholder leaves the secret alone.
    w.ok(
        "locker.edit_item",
        json!({ "item_id": item, "fields": [{ "field_key": "password", "value": locker::SEALED_PLACEHOLDER }] }),
    );
    assert_eq!(age(&w), first);
    // A new ciphertext must say whether the value changed.
    let again = seal(&w, &password, "first");
    let field = |changed: Option<bool>| {
        let mut field = json!({ "field_key": "password", "value": again, "key_id": key_id(&w) });
        if let Some(changed) = changed {
            field["changed"] = json!(changed);
        }
        field
    };
    assert!(
        w.refused(
            "locker.edit_item",
            json!({ "item_id": item, "fields": [field(None)] })
        )
        .contains("say whether")
    );
    // The same secret sealed again: new ciphertext, the same age.
    w.ok(
        "locker.edit_item",
        json!({ "item_id": item, "fields": [field(Some(false))] }),
    );
    assert_eq!(age(&w), first);
    assert_eq!(
        w.one::<String>(
            "SELECT value_sealed FROM locker_item_field WHERE id = ?1",
            &[&password]
        ),
        again
    );
    // A changed value moves it.
    w.ok(
        "locker.edit_item",
        json!({ "item_id": item, "fields": [{
            "field_key": "password", "value": seal(&w, &password, "second"),
            "key_id": key_id(&w), "changed": true }] }),
    );
    assert_ne!(age(&w), first);

    // Both secrets, the seed too, come out of the doors as ciphertext only the core can open.
    for (key, plaintext) in [("password", "second"), ("otp_seed", "JBSWY3DPEHPK3PXP")] {
        let cell = w
            .vault()
            .locker_sealed_item_cell(&item, key)
            .unwrap()
            .expect("a cell");
        let opened = centraid_vault::custody::decrypt_under_locker_key(
            &common::locker::K,
            cell.key_id.as_deref().unwrap(),
            &id_of(&item, key),
            cell.ciphertext.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(opened, plaintext);
        let by_id = w
            .vault()
            .locker_sealed_field_cell(&item, &id_of(&item, key))
            .unwrap();
        assert_eq!(by_id, Some(cell));
    }
    // A trashed item reveals nothing.
    w.ok("entity.trash", json!({ "id": item }));
    assert!(
        w.vault()
            .locker_sealed_item_cell(&item, "password")
            .unwrap()
            .is_none()
    );
}

#[test]
fn several_urls_an_alias_held_by_one_item_and_one_of_each_single_key() {
    let w = world("locker_aliases");
    let (one, two) = (item_id(&w), item_id(&w));
    add(
        &w,
        &one,
        "login",
        "One",
        vec![
            plain("url", "https://one.example"),
            plain("url", "https://uno.example"),
            plain("alias", "Shared-Name"),
            plain("username", "a"),
        ],
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_field WHERE item_id = ?1 AND kind = 'url'",
            &[&one]
        ),
        2
    );
    // Another item may not take the alias, whatever its case; its own may be rewritten.
    let sentence = w.refused(
        "locker.add_item",
        json!({ "item_id": two, "type": "login", "title": "Two", "fields": [plain("alias", "shared-name")] }),
    );
    assert!(
        sentence.contains("already used by another item"),
        "{sentence}"
    );
    let alias_row = w.one::<String>(
        "SELECT id FROM locker_item_field WHERE item_id = ?1 AND claimed = 1",
        &[&one],
    );
    w.ok(
        "locker.edit_item",
        json!({ "item_id": one, "fields": [{ "field_id": alias_row, "value": "Renamed-Alias" }] }),
    );
    // A trashed holder keeps it until purged.
    add(&w, &two, "login", "Two", vec![]);
    w.ok("entity.trash", json!({ "id": one }));
    assert!(
        w.refused(
            "locker.edit_item",
            json!({ "item_id": two, "fields": [plain("alias", "renamed-alias")] }),
        )
        .contains("already used")
    );
    w.ok("entity.purge", json!({ "id": one }));
    w.ok(
        "locker.edit_item",
        json!({ "item_id": two, "fields": [plain("alias", "renamed-alias")] }),
    );
    // A malformed alias is a sentence.
    assert!(
        w.refused(
            "locker.edit_item",
            json!({ "item_id": two, "fields": [plain("alias", "has space")] })
        )
        .contains("an alias is")
    );
    // The file refuses a second single-instance key whatever the command says.
    let two_username = id_of(&two, "username");
    w.ok(
        "locker.edit_item",
        json!({ "item_id": two, "fields": [plain("username", "x")] }),
    );
    let why = w
        .vault()
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO locker_item_field (id, item_id, field_key, single, label, kind, value_text, created_at, updated_at)
                 VALUES ('another', ?1, 'username', 1, 'Username', 'text', 'y', ?2, ?2)",
                [&two, common::world::AT],
            )?;
            Ok(())
        })
        .unwrap_err()
        .to_string();
    assert!(why.contains("UNIQUE"), "{why}");
    assert!(
        w.refused(
            "locker.edit_item",
            json!({ "item_id": two, "fields": [{ "field_id": "other", "field_key": "username", "value": "z" }] }),
        )
        .contains(&two_username)
    );
}

#[test]
fn an_item_holds_several_passkeys_found_by_their_site_and_a_rename_keeps_the_key() {
    let w = world("locker_passkeys");
    let (one, two) = (item_id(&w), item_id(&w));
    add(&w, &one, "login", "One", vec![]);
    add(&w, &two, "login", "Two", vec![]);
    let live = key_id(&w);
    let pk = |w: &common::world::World, item: &str, rp: &str, plaintext: &str| -> String {
        let id = w.mint();
        w.ok(
            "locker.set_passkey",
            json!({ "item_id": item, "passkey_id": id, "rp_id": rp, "display_name": "me",
                    "private_key": seal(w, &id, plaintext), "key_id": live }),
        );
        id
    };
    let a = pk(&w, &one, "bank.example", "KEY-A");
    let b = pk(&w, &one, "mail.example", "KEY-B");
    let c = pk(&w, &two, "bank.example", "KEY-C");
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_passkey WHERE item_id = ?1",
            &[&one]
        ),
        2
    );
    let found = w
        .vault()
        .read(|conn| reads::passkeys_for_rp(conn, "bank.example"))
        .unwrap();
    assert_eq!(
        found
            .iter()
            .map(|p| p.passkey_id.clone())
            .collect::<Vec<_>>(),
        {
            let mut ids = vec![a.clone(), c.clone()];
            ids.sort();
            ids
        }
    );
    // The lookup is the site's index.
    let detail = explain(
        &w,
        "SELECT p.id FROM locker_item_passkey p JOIN entity e ON e.id = p.item_id WHERE p.rp_id = ?1 AND e.deleted_at IS NULL",
        "bank.example",
    );
    assert!(detail.contains("locker_item_passkey_by_rp"), "{detail}");
    assert!(
        !detail.contains("SCAN") && !detail.contains("TEMP B-TREE"),
        "{detail}"
    );
    // A rename sends the placeholder and no generation: the key stays sealed under its own.
    let before: (String, String) = w
        .vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT private_key, key_id FROM locker_item_passkey WHERE id = ?1",
                [&a],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    w.ok(
        "locker.set_passkey",
        json!({ "item_id": one, "passkey_id": a, "rp_id": "bank.example", "display_name": "renamed",
                "private_key": locker::SEALED_PLACEHOLDER }),
    );
    let after: (String, String) = w
        .vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT private_key, key_id FROM locker_item_passkey WHERE id = ?1",
                [&a],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(before, after);
    // The core's door opens it; plaintext is refused on the way in.
    let cell = w
        .vault()
        .locker_sealed_passkey_cell(&one, &a)
        .unwrap()
        .unwrap();
    assert_eq!(
        centraid_vault::custody::decrypt_under_locker_key(
            &common::locker::K,
            cell.key_id.as_deref().unwrap(),
            &a,
            cell.ciphertext.as_deref().unwrap()
        )
        .unwrap(),
        "KEY-A"
    );
    assert!(
        w.vault()
            .locker_sealed_passkey_cell(&two, &a)
            .unwrap()
            .is_none()
    );
    assert!(
        w.refused(
            "locker.set_passkey",
            json!({ "item_id": one, "passkey_id": w.mint(), "rp_id": "x.example", "private_key": "plain", "key_id": live }),
        )
        .contains("sealed")
    );
    // A key with no id to be bound to is refused; so is a passkey of another item's id.
    assert!(
        w.refused(
            "locker.set_passkey",
            json!({ "item_id": one, "rp_id": "x.example", "private_key": seal(&w, "q", "q"), "key_id": live }),
        )
        .contains("id its key was sealed against")
    );
    w.ok(
        "locker.remove_passkey",
        json!({ "item_id": one, "passkey_id": b }),
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_passkey WHERE item_id = ?1",
            &[&one]
        ),
        1
    );
    assert!(
        w.refused(
            "locker.remove_passkey",
            json!({ "item_id": two, "passkey_id": a })
        )
        .contains("not one of")
    );
}

fn explain(w: &common::world::World, sql: &str, bind: &str) -> String {
    explain_rows(w, sql, &[bind.to_owned()])
}

fn explain_rows(w: &common::world::World, sql: &str, binds: &[String]) -> String {
    w.vault()
        .read(|c| {
            let mut statement = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(binds.iter()), |row| {
                    row.get::<_, String>(3)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join("\n"))
        })
        .unwrap()
}

#[test]
fn a_cards_expiry_is_the_last_day_of_its_month_takes_a_reminder_and_notifies_without_a_value() {
    let w = world("locker_expiry");
    let card = item_id(&w);
    add(
        &w,
        &card,
        "card",
        "Visa",
        vec![
            plain("cardholder", "A Holder"),
            secret(&w, &card, "card_number", "4111111111111111"),
            plain("expiry", "08/27"),
        ],
    );
    let expiry = id_of(&card, "expiry");
    assert_eq!(
        w.one::<String>(
            "SELECT value_text FROM locker_item_field WHERE id = ?1",
            &[&expiry]
        ),
        "2027-08-31"
    );
    // It reads back as MM/YY.
    let shown = w.vault().read(|c| reads::fields_of(c, &card)).unwrap();
    let view = shown
        .iter()
        .find(|f| f.field_key.as_deref() == Some("expiry"))
        .unwrap();
    assert_eq!(view.display.as_deref(), Some("08/27"));
    assert_eq!(view.value.as_deref(), Some("2027-08-31"));
    assert!(
        shown.iter().any(|f| f.sealed && f.value.is_none()),
        "a secret is a bit, not a value"
    );
    // The month, the year and a whole date all land on the same day.
    for given in ["8/2027", "2027-08", "2027-08-05"] {
        w.ok(
            "locker.edit_item",
            json!({ "item_id": card, "fields": [plain("expiry", given)] }),
        );
        assert_eq!(
            w.one::<String>(
                "SELECT value_text FROM locker_item_field WHERE id = ?1",
                &[&expiry]
            ),
            "2027-08-31",
            "{given}"
        );
    }
    // February of a leap and of a common year.
    for (given, last) in [
        ("02/28", "2028-02-29"),
        ("02/27", "2027-02-28"),
        ("02/2100", "2100-02-28"),
    ] {
        w.ok(
            "locker.edit_item",
            json!({ "item_id": card, "fields": [plain("expiry", given)] }),
        );
        assert_eq!(
            w.one::<String>(
                "SELECT value_text FROM locker_item_field WHERE id = ?1",
                &[&expiry]
            ),
            last,
            "{given}"
        );
    }
    assert!(
        w.refused(
            "locker.edit_item",
            json!({ "item_id": card, "fields": [plain("expiry", "13/27")] })
        )
        .contains("not a date")
    );
    w.ok(
        "locker.edit_item",
        json!({ "item_id": card, "fields": [plain("expiry", "08/27")] }),
    );

    // It takes a reminder; a text field and a sealed one do not.
    let reminder = w.ok(
        "reminder.add",
        json!({ "entity_id": card, "field_id": expiry, "offset_min": 60 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        w.refused(
            "reminder.add",
            json!({ "entity_id": card, "field_id": id_of(&card, "cardholder"), "offset_min": 0 }),
        )
        .contains("not a date field")
    );
    assert!(
        w.refused(
            "reminder.add",
            json!({ "entity_id": card, "field_id": id_of(&card, "card_number"), "offset_min": 0 }),
        )
        .contains("not a date field")
    );
    // The notification names the item and the field's label, and nothing else.
    let notice = w
        .vault()
        .read(|c| alerts::notice(c, &reminder))
        .unwrap()
        .expect("an alert was written");
    assert_eq!(notice.title, "Visa");
    assert_eq!(notice.what.as_deref(), Some("Expiry"));
    assert_eq!(notice.kind, "locker_item");
    assert_eq!(notice.at.as_deref(), Some("2027-08-31"));
    let said = format!("{notice:?}");
    for value in ["A Holder", "4111", "lk1:", "cardholder"] {
        assert!(
            !said.contains(value),
            "the notice carried `{value}`: {said}"
        );
    }
    // A date field of any other type notifies the same way: a passport's expiry.
    let passport = item_id(&w);
    add(
        &w,
        &passport,
        "passport",
        "Passport",
        vec![plain("expires", "2031-05-04")],
    );
    let r = w.ok(
        "reminder.add",
        json!({ "entity_id": passport, "field_id": id_of(&passport, "expires"), "offset_min": 0 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let notice = w.vault().read(|c| alerts::notice(c, &r)).unwrap().unwrap();
    assert_eq!(
        (notice.title.as_str(), notice.what.as_deref()),
        ("Passport", Some("Expires"))
    );
    // Changing the date moves the alert; taking the field away takes the reminder.
    w.ok(
        "locker.remove_field",
        json!({ "item_id": card, "field_id": expiry }),
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM reminder WHERE entity_id = ?1",
            &[&card]
        ),
        0
    );
}

#[test]
fn autofill_finds_the_items_for_a_site_by_the_url_index_and_a_use_is_not_an_edit() {
    let w = world("locker_autofill");
    let (one, two, three) = (item_id(&w), item_id(&w), item_id(&w));
    add(
        &w,
        &one,
        "login",
        "One",
        vec![
            plain("url", "https://Example.com/"),
            plain("url", "https://other.example"),
        ],
    );
    add(&w, &two, "login", "Two", vec![plain("url", "example.com")]);
    add(
        &w,
        &three,
        "membership",
        "Three",
        vec![
            plain("url", "https://example.com"),
            plain("member_number", "x"),
        ],
    );
    let found = |w: &common::world::World, ident: &str| {
        w.vault()
            .read(|c| reads::items_for_identifier(c, ident))
            .unwrap()
    };
    let mut want = vec![one.clone(), two.clone(), three.clone()];
    want.sort();
    assert_eq!(
        found(&w, "https://example.com/login-page-is-not-a-site"),
        Vec::<String>::new()
    );
    assert_eq!(found(&w, "https://example.com"), want);
    assert_eq!(found(&w, "example.com"), want);
    assert_eq!(found(&w, "HTTPS://EXAMPLE.COM/"), want);
    assert_eq!(found(&w, "https://other.example"), vec![one.clone()]);
    // An app identifier is an address like any other.
    w.ok(
        "locker.edit_item",
        json!({ "item_id": two, "fields": [plain("url", "androidapp://com.example.app")] }),
    );
    assert_eq!(found(&w, "androidapp://com.example.app"), vec![two.clone()]);
    // A trashed item is not offered.
    w.ok("entity.trash", json!({ "id": three }));
    assert!(!found(&w, "example.com").contains(&three));
    // The plan: the url index, no scan, no sort.
    let candidates = reads::url_candidates("https://example.com");
    let detail = explain_rows(
        &w,
        &reads::items_for_urls_sql(candidates.len()),
        &candidates,
    );
    assert!(detail.contains("locker_item_field_by_url"), "{detail}");
    assert!(
        !detail.contains("SCAN") && !detail.contains("TEMP B-TREE"),
        "{detail}"
    );

    // A use stamps the item and nothing else: no version, no `updated_at`.
    let (versions, updated) = (rev_count(&w, &one), w.stamp(&one));
    w.ok("locker.mark_used", json!({ "item_id": one }));
    assert_eq!(rev_count(&w, &one), versions);
    assert_eq!(w.stamp(&one), updated);
    assert!(
        w.one::<Option<String>>(
            "SELECT last_used_at FROM locker_item WHERE id = ?1",
            &[&one]
        )
        .is_some()
    );
    // A code stamps too; an item with no seed has no code.
    assert!(
        w.refused("locker.totp_code", json!({ "item_id": one }))
            .contains("no one-time-code")
    );
    // The unlock stamps live on the key row.
    key_id(&w);
    w.ok("locker.mark_unlock_failed", json!({}));
    w.ok("locker.mark_unlock_failed", json!({}));
    assert_eq!(w.vault().locker_failed_unlocks().unwrap().0, 2);
    assert_eq!(w.ok("locker.mark_unlocked", json!({}))["failed_unlocks"], 2);
    assert_eq!(w.vault().locker_failed_unlocks().unwrap().0, 0);
}

#[test]
fn a_duplicate_takes_plain_fields_and_tags_and_the_cores_re_sealed_secrets_but_not_the_alias() {
    let w = world("locker_duplicate");
    let (source, copy) = (item_id(&w), item_id(&w));
    add(
        &w,
        &source,
        "login",
        "Bank",
        vec![
            plain("username", "me"),
            plain("alias", "bank-alias"),
            secret(&w, &source, "password", "old-secret"),
        ],
    );
    w.ok("tag.add", json!({ "id": source, "label": "money" }));
    w.ok("flag.set", json!({ "id": source, "flag": "starred" }));
    let out = w.ok(
        "locker.duplicate_item",
        json!({ "item_id": source, "new_item_id": copy, "fields": [secret(&w, &copy, "password", "old-secret")] }),
    );
    assert_eq!(out["title"], "Bank copy");
    assert_eq!(
        w.one::<String>(
            "SELECT value_text FROM locker_item_field WHERE id = ?1",
            &[&id_of(&copy, "username")]
        ),
        "me"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_field WHERE item_id = ?1 AND claimed = 1",
            &[&copy]
        ),
        0
    );
    let cell = w
        .vault()
        .locker_sealed_item_cell(&copy, "password")
        .unwrap()
        .unwrap();
    assert!(
        centraid_vault::custody::decrypt_under_locker_key(
            &common::locker::K,
            cell.key_id.as_deref().unwrap(),
            &id_of(&copy, "password"),
            cell.ciphertext.as_deref().unwrap()
        )
        .is_ok()
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged'",
            &[&copy]
        ),
        1
    );
    assert!(
        w.one::<Option<String>>("SELECT starred_at FROM entity WHERE id = ?1", &[&copy])
            .is_none()
    );
    // The source's cipher is bound to the source's row, so the copy cannot be handed it.
    let moved = w
        .vault()
        .locker_sealed_item_cell(&source, "password")
        .unwrap()
        .unwrap();
    let other = item_id(&w);
    add(&w, &other, "login", "Other", vec![]);
    w.ok(
        "locker.edit_item",
        json!({ "item_id": other, "fields": [{ "field_key": "password", "value": moved.ciphertext, "key_id": moved.key_id }] }),
    );
    let stolen = w
        .vault()
        .locker_sealed_item_cell(&other, "password")
        .unwrap()
        .unwrap();
    assert!(
        centraid_vault::custody::decrypt_under_locker_key(
            &common::locker::K,
            stolen.key_id.as_deref().unwrap(),
            &id_of(&other, "password"),
            stolen.ciphertext.as_deref().unwrap()
        )
        .is_err(),
        "a ciphertext moved to another row does not open there"
    );
    // The counts partition the items.
    let counts = w.ok("locker.counts", json!({}));
    assert_eq!(counts["live"], 3);
    assert_eq!(counts["trashed"], 0);
}
