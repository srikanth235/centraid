//! MONEY'S SCHEMA (#1099, R-1099-6, -10, -11, -15, -16).
//!
//! What each test holds, and the claim a port would get wrong:
//!
//! 1. **The seeds are one statement of one list.** A vault founded today holds
//!    the categories scheme, its 23 concepts under their fixed ids, and the
//!    `transfer` relation `bootstrap` adds, each concept an entity of its own.
//! 2. **A statement line is in a vault once** (the unique index), per account, and
//!    only where an `external_id` is set.
//! 3. **One account, one currency**, for a Money account only; a plain
//!    `core_account` is not touched by it.
//! 4. **An imported row is never edited**: description and amount refuse, the
//!    category moves, `void` is one-way.
//! 5. **The pack states its commitments**: the rule is an entity with the
//!    membership triggers, every table is registered with what it is a projection
//!    of, every mutable table carries `updated_at`, `row_version` and its touch
//!    trigger, and every amount carries a currency.
//!
//! (How a vault written before Money was brought up to this schema is not
//! proved here: the ladder was squashed into one baseline on 2026-10-15,
//! Q-1029-1, and no vault in the field predates Money.)

mod common;

use centraid_vault::Vault;
use rusqlite::{Connection, params};

const CATEGORIES_URI: &str = "urn:centraid:money:categories";
const RELATIONS_URI: &str = "urn:duaility:relations";

fn count(vault: &Vault, sql: &str) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("the count reads")
}

fn texts(connection: &Connection, sql: &str) -> Vec<String> {
    let mut statement = connection.prepare(sql).expect("the query prepares");
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the rows read")
}

/// The vocabulary a new vault is seeded with, as comparable text: every concept
/// of the categories scheme with its id, notation, label, parent and stable id,
/// and the `transfer` relation with its id and label. Timestamps are left out:
/// they are the moment of the founding and not a fact.
fn seeds(connection: &Connection) -> Vec<String> {
    let mut rows = texts(
        connection,
        &format!(
            "SELECT c.concept_id || '|' || c.notation || '|' || c.pref_label || '|'
                    || COALESCE(c.broader_concept_id, '-') || '|' || COALESCE(c.stable_id, '-')
                    || '|' || s.title || '|' || s.scheme_id
               FROM core_concept c JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE s.uri = '{CATEGORIES_URI}'"
        ),
    );
    rows.extend(texts(
        connection,
        &format!(
            "SELECT c.concept_id || '|' || c.notation || '|' || c.pref_label
               FROM core_concept c JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE s.uri = '{RELATIONS_URI}' AND c.notation = 'transfer'"
        ),
    ));
    rows.sort();
    rows
}

// ---------------------------------------------------------------------------
// 1. The seeds
// ---------------------------------------------------------------------------

#[test]
fn a_founded_vault_holds_the_categories_and_the_transfer_relation() {
    let scratch = common::Scratch::founded("money-seeds").expect("a vault is founded");
    let found = scratch
        .vault
        .read(|connection| Ok(seeds(connection)))
        .expect("the seeds read");
    // 23 concepts and one relation.
    assert_eq!(found.len(), 24, "{found:#?}");
    // Two levels, and no more: a group has no parent, a category has a group.
    let (groups, children): (i64, i64) = scratch
        .vault
        .read(|connection| {
            Ok((
                connection.query_row(
                    "SELECT COUNT(*) FROM core_concept WHERE concept_id LIKE 'money:cat:%'
                        AND broader_concept_id IS NULL",
                    [],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    "SELECT COUNT(*) FROM core_concept c JOIN core_concept p
                        ON p.concept_id = c.broader_concept_id
                      WHERE c.concept_id LIKE 'money:cat:%' AND p.broader_concept_id IS NULL",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("the levels read");
    assert_eq!((groups, children), (9, 14));
    // Every notation is stable text a client can name, and a child's notation
    // begins with its group's.
    let orphans = count(
        &scratch.vault,
        "SELECT COUNT(*) FROM core_concept c JOIN core_concept p
            ON p.concept_id = c.broader_concept_id
          WHERE c.concept_id LIKE 'money:cat:%' AND c.notation NOT LIKE p.notation || '.%'",
    );
    assert_eq!(orphans, 0);
    // Each seeded concept is an entity, so an id names one thing.
    let entities = count(
        &scratch.vault,
        "SELECT COUNT(*) FROM core_entity WHERE entity_id LIKE 'money:cat:%'",
    );
    assert_eq!(entities, 23);
}

// ---------------------------------------------------------------------------
// 2-4. The invariants the schema holds
// ---------------------------------------------------------------------------

/// A founded vault with a Money account in USD, one in EUR, and a plain
/// `core_account` (Tally's shape) in USD, all owned by the vault's owner.
fn with_accounts(seed: &str) -> common::Scratch {
    let scratch = common::Scratch::founded(seed).expect("a vault is founded");
    let owner = common::owner_party(&scratch.vault).unwrap();
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.money-accounts");
            for (account, currency, money) in [
                ("usd", "USD", true),
                ("eur", "EUR", true),
                ("pool", "USD", false),
            ] {
                tx.connection().execute(
                    "INSERT INTO core_account (account_id, owner_party_id, name, kind, currency,
                                               is_asset)
                     VALUES (?1, ?2, ?1, 'depository', ?3, 1)",
                    params![account, owner, currency],
                )?;
                if money {
                    tx.connection().execute(
                        "INSERT INTO money_account (account_id, name, kind, created_at)
                         VALUES (?1, ?1, 'checking', '2026-01-01T00:00:00.000Z')",
                        [account],
                    )?;
                }
            }
            Ok(())
        })
        .expect("the accounts land");
    scratch
}

fn insert_txn(
    vault: &Vault,
    txn: &str,
    account: &str,
    currency: &str,
    external: Option<&str>,
) -> centraid_vault::Result<()> {
    vault
        .commit(|tx| {
            tx.set_producer("test.money-txn");
            tx.connection().execute(
                "INSERT INTO core_transaction
                   (txn_id, account_id, posted_at, amount_minor, currency, direction, status,
                    description, external_id)
                 VALUES (?1, ?2, '2026-02-03T00:00:00Z', 4_250, ?3, 'debit', 'posted', 'COSTCO #12',
                         ?4)",
                params![txn, account, currency, external],
            )?;
            Ok(())
        })
        .map(|_| ())
}

fn edit(vault: &Vault, sql: &str) -> centraid_vault::Result<()> {
    vault
        .commit(|tx| {
            tx.set_producer("test.money-edit");
            tx.connection().execute_batch(sql)?;
            Ok(())
        })
        .map(|_| ())
}

#[test]
fn a_statement_line_lands_once_per_account() {
    let scratch = with_accounts("money-unique");
    insert_txn(&scratch.vault, "t1", "usd", "USD", Some("ofx:1")).unwrap();
    assert!(
        insert_txn(&scratch.vault, "t2", "usd", "USD", Some("ofx:1")).is_err(),
        "the same line twice in one account"
    );
    // Another account may hold the same id (an id is scoped to its source), and
    // any number of rows may hold none.
    insert_txn(&scratch.vault, "t3", "pool", "USD", Some("ofx:1")).unwrap();
    insert_txn(&scratch.vault, "t4", "usd", "USD", None).unwrap();
    insert_txn(&scratch.vault, "t5", "usd", "USD", None).unwrap();
}

#[test]
fn a_money_account_holds_one_currency_and_tallys_pool_is_untouched() {
    let scratch = with_accounts("money-currency");
    assert!(insert_txn(&scratch.vault, "bad", "usd", "EUR", Some("ofx:x")).is_err());
    insert_txn(&scratch.vault, "ok", "eur", "EUR", Some("ofx:y")).unwrap();
    assert!(
        edit(
            &scratch.vault,
            "UPDATE core_transaction SET currency = 'USD' WHERE txn_id = 'ok'"
        )
        .is_err(),
        "an update cannot change a row's currency away from its account's"
    );
    assert!(
        edit(
            &scratch.vault,
            "UPDATE core_transaction SET account_id = 'usd' WHERE txn_id = 'ok'"
        )
        .is_err(),
        "nor move it into an account of another currency"
    );
    // Tally's settlement pool has always posted in the settlement's own currency.
    insert_txn(
        &scratch.vault,
        "pool-eur",
        "pool",
        "EUR",
        Some("tally:settlement:s"),
    )
    .unwrap();
    // A checkpoint is held to the same rule.
    assert!(
        edit(
            &scratch.vault,
            "INSERT INTO money_balance_checkpoint
               (account_id, as_of, source, balance_minor, currency, created_at)
             VALUES ('usd', '2026-02-01', 'ofx', 100, 'EUR', '2026-02-01T00:00:00.000Z')"
        )
        .is_err()
    );
    edit(
        &scratch.vault,
        "INSERT INTO money_balance_checkpoint
           (account_id, as_of, source, balance_minor, currency, created_at)
         VALUES ('usd', '2026-02-01', 'ofx', -100, 'USD', '2026-02-01T00:00:00.000Z')",
    )
    .unwrap();
}

#[test]
fn an_imported_row_is_never_edited_but_its_category_moves_and_void_is_one_way() {
    let scratch = with_accounts("money-fixed");
    insert_txn(&scratch.vault, "t1", "usd", "USD", Some("ofx:1")).unwrap();
    for column_edit in [
        "description = 'changed'",
        "amount_minor = 1",
        "direction = 'credit'",
        "posted_at = '2026-03-01T00:00:00Z'",
        "external_id = 'ofx:2'",
        "status = 'pending'",
    ] {
        assert!(
            edit(
                &scratch.vault,
                &format!("UPDATE core_transaction SET {column_edit} WHERE txn_id = 't1'")
            )
            .is_err(),
            "`{column_edit}` must be refused"
        );
    }
    edit(
        &scratch.vault,
        "UPDATE core_transaction SET category_concept_id = 'money:cat:food.groceries'
          WHERE txn_id = 't1'",
    )
    .expect("the category is the member's decision");
    edit(
        &scratch.vault,
        "UPDATE core_transaction SET status = 'void' WHERE txn_id = 't1'",
    )
    .expect("a member can void a line");
    assert!(
        edit(
            &scratch.vault,
            "UPDATE core_transaction SET status = 'posted' WHERE txn_id = 't1'"
        )
        .is_err(),
        "a void line never comes back"
    );
    // The same edits on a row outside Money are not this rung's business.
    insert_txn(
        &scratch.vault,
        "p1",
        "pool",
        "USD",
        Some("tally:settlement:p"),
    )
    .unwrap();
    edit(
        &scratch.vault,
        "UPDATE core_transaction SET description = 'changed' WHERE txn_id = 'p1'",
    )
    .unwrap();
    // And the touch trigger still stamps what moved.
    let version = count(
        &scratch.vault,
        "SELECT row_version FROM core_transaction WHERE txn_id = 't1'",
    );
    assert_eq!(version, 3, "category, then void");
}

// ---------------------------------------------------------------------------
// 5. The pack's commitments
// ---------------------------------------------------------------------------

#[test]
fn the_rule_is_an_entity_and_every_money_table_is_registered_and_stamped() {
    let scratch = common::Scratch::founded("money-commitments").expect("a vault is founded");
    let vault = &scratch.vault;
    let triggers = vault
        .read(|connection| {
            Ok(texts(
                connection,
                "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'money_rule'
                  ORDER BY name",
            ))
        })
        .unwrap();
    assert_eq!(
        triggers,
        vec![
            "money_rule_entity_delete",
            "money_rule_entity_insert",
            "money_rule_touch_updated_at"
        ]
    );
    assert_eq!(
        count(
            vault,
            "SELECT COUNT(*) FROM core_entity_kind WHERE kind = 'money.rule'"
        ),
        1
    );

    let registered: Vec<(String, String, Option<String>)> =
        centraid_ontology::registries::v0_registries()
            .entities
            .iter()
            .filter(|entity| entity.logical.starts_with("money."))
            .map(|entity| {
                assert_eq!(entity.lifecycle, "mutable", "{}", entity.table);
                (
                    entity.logical.clone(),
                    entity.table.clone(),
                    entity.projection_of.clone(),
                )
            })
            .collect();
    let expected = [
        ("money.account", "money_account", Some("core.account")),
        (
            "money.balance_checkpoint",
            "money_balance_checkpoint",
            Some("core.account"),
        ),
        (
            "money.import_profile",
            "money_import_profile",
            Some("core.account"),
        ),
        ("money.rule", "money_rule", None),
        ("money.target", "money_target", Some("core.concept")),
        (
            "money.transaction",
            "money_transaction",
            Some("core.transaction"),
        ),
    ];
    let expected: Vec<(String, String, Option<String>)> = expected
        .iter()
        .map(|(logical, table, parent)| {
            (
                (*logical).to_owned(),
                (*table).to_owned(),
                parent.map(str::to_owned),
            )
        })
        .collect();
    assert_eq!(registered, expected);
    assert!(
        centraid_ontology::registries::v0_registries()
            .ontology_packs
            .iter()
            .any(|pack| pack == "money")
    );

    // The physical tables are exactly the registered ones, each stamped.
    let tables = vault
        .read(|connection| {
            Ok(texts(
                connection,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'money\\_%' ESCAPE '\\'
                  ORDER BY name",
            ))
        })
        .unwrap();
    assert_eq!(
        tables,
        expected
            .iter()
            .map(|(_, table, _)| table.clone())
            .collect::<Vec<_>>()
    );
    for table in &tables {
        for column in ["updated_at", "row_version"] {
            assert_eq!(
                count(
                    vault,
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
                    )
                ),
                1,
                "{table} has no {column}"
            );
        }
        assert_eq!(
            count(
                vault,
                &format!(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
                        AND name = '{table}_touch_updated_at'"
                )
            ),
            1,
            "{table} has no touch trigger"
        );
    }
    // Money states its currency: every table that holds an amount in a unit
    // names the unit, NOT NULL.
    for table in ["money_target", "money_balance_checkpoint"] {
        assert_eq!(
            count(
                vault,
                &format!(
                    "SELECT COUNT(*) FROM pragma_table_info('{table}')
                      WHERE name = 'currency' AND \"notnull\" = 1"
                )
            ),
            1,
            "{table} must carry a NOT NULL currency"
        );
    }
}

#[test]
fn deleting_the_row_a_decoration_decorates_takes_the_decoration_with_it() {
    let scratch = with_accounts("money-cascade");
    insert_txn(&scratch.vault, "t1", "usd", "USD", Some("ofx:1")).unwrap();
    edit(
        &scratch.vault,
        "INSERT INTO money_transaction (txn_id, imported_from, imported_at)
         VALUES ('t1', 'ofx', '2026-02-03T00:00:00.000Z');
         INSERT INTO money_target (month, category_concept_id, amount_minor, currency, created_at)
         VALUES ('2026-02', 'money:cat:food.groceries', 50_000, 'USD', '2026-02-01T00:00:00.000Z');
         INSERT INTO money_rule (rule_id, match_kind, pattern, set_category_concept_id, created_at)
         VALUES ('r1', 'contains', 'COSTCO', 'money:cat:food.groceries', '2026-02-01T00:00:00.000Z');",
    )
    .unwrap();
    // A rule is an entity: its id is held in the supertype, and nothing else may take it.
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'r1' AND entity_type = 'money.rule'"
        ),
        1
    );
    // A category a rule files under cannot be deleted from under it.
    assert!(
        edit(
            &scratch.vault,
            "DELETE FROM core_concept WHERE concept_id = 'money:cat:food.groceries'"
        )
        .is_err(),
        "the engine refuses a delete the rule still names"
    );
    edit(
        &scratch.vault,
        "DELETE FROM core_transaction WHERE txn_id = 't1'",
    )
    .unwrap();
    assert_eq!(
        count(&scratch.vault, "SELECT COUNT(*) FROM money_transaction"),
        0
    );
    edit(
        &scratch.vault,
        "DELETE FROM money_rule WHERE rule_id = 'r1'",
    )
    .unwrap();
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'r1'"
        ),
        0,
        "the entity row leaves with the rule"
    );
    // The target cascades from the category it plans (no command deletes a
    // category with rows on it; the schema's answer is the cascade).
    edit(
        &scratch.vault,
        "DELETE FROM core_concept WHERE concept_id = 'money:cat:food.groceries'",
    )
    .unwrap();
    assert_eq!(
        count(&scratch.vault, "SELECT COUNT(*) FROM money_target"),
        0
    );
}
