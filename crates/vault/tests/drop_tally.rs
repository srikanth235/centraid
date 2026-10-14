//! Rung fifteen: Tally leaves the vault (#1099, R-1099-19, R-1099-20, R-1099-22,
//! R-1099-35, R-1099-37).
//!
//! The climb is proved on a file built the way a field vault at rung fourteen
//! was: the ladder run to fourteen, holding everything Tally could write. The
//! claim is "loses exactly the Tally rows and nothing else", so every table's row
//! count is read before and after, and the tables that moved are named with the
//! number each lost.

mod common;

use std::collections::BTreeMap;

use centraid_vault::Vault;
use rusqlite::Connection;

/// Every table's row count, but for the objects the rung drops. Virtual tables
/// and their shadow tables are counted too, so an index that lost a row it
/// should have kept is a failure of this comparison.
fn counts(connection: &Connection) -> BTreeMap<String, i64> {
    let names: Vec<String> = connection
        .prepare(
            r"SELECT name FROM sqlite_master
               WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
                 AND name NOT LIKE 'tally\_%' ESCAPE '\'
                 AND name NOT LIKE 'fts\_tally\_expense%' ESCAPE '\'
                 AND name NOT LIKE 'fts\_social\_circle%' ESCAPE '\'
               ORDER BY name",
        )
        .expect("the schema reads")
        .query_map([], |row| row.get(0))
        .expect("the schema reads")
        .collect::<rusqlite::Result<_>>()
        .expect("the schema reads");
    names
        .into_iter()
        .map(|name| {
            let count = connection
                .query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |row| {
                    row.get(0)
                })
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            (name, count)
        })
        .collect()
}

fn count(connection: &Connection, sql: &str) -> i64 {
    connection
        .query_row(sql, [], |row| row.get(0))
        .unwrap_or_else(|error| panic!("{sql}: {error}"))
}

/// A rung-fourteen file holding every kind of row Tally wrote, and every kind of
/// row that sits beside them and must survive.
fn tally_vault(path: &std::path::Path) -> Connection {
    let raw = common::found_at_rung(path, 14);
    // A stand-in receipt: its hash is the digest of its bytes, as every writer's is.
    raw.execute(
        "INSERT INTO core_content_item (content_id, content_uri, content_hash, byte_size, created_at)
         VALUES ('ci-1', 'blob:1', ?1, 10, '2026-01-03T00:00:00Z')",
        [centraid_vault::content::content_digest(b"a receipt")],
    )
    .expect("a content item is written");
    raw.execute_batch(
        r"
-- people: the owner and a friend, plus a bystander who is nobody's friend
INSERT INTO core_party (party_id, kind, display_name, created_at) VALUES
  ('p-owner', 'person', 'Owner', '2026-01-01T00:00:00Z'),
  ('p-friend', 'person', 'Asha', '2026-01-01T00:00:00Z'),
  ('p-bystander', 'person', 'Ravi', '2026-01-01T00:00:00Z');

-- circles: one a Tally group stands on, one that is nobody's group
INSERT INTO social_circle (circle_id, owner_party_id, name, kind) VALUES
  ('c-group', 'p-owner', 'Goa trip', 'custom'),
  ('c-plain', 'p-owner', 'Family', 'family');
INSERT INTO social_circle_member (member_id, circle_id, party_id, added_at) VALUES
  ('m-group', 'c-group', 'p-friend', '2026-01-01T00:00:00Z'),
  ('m-plain', 'c-plain', 'p-bystander', '2026-01-01T00:00:00Z');

-- the Tally tables
INSERT INTO tally_group (group_id, circle_id, icon, color, currency, created_at)
  VALUES ('g-1', 'c-group', 'plane', 'indigo', 'INR', '2026-01-02T00:00:00Z');
INSERT INTO tally_friend (friend_id, party_id, created_at)
  VALUES ('f-1', 'p-friend', '2026-01-02T00:00:00Z');
INSERT INTO tally_recurring_expense
  (template_id, group_id, description, original_amount_minor, original_currency,
   settlement_currency, paid_by, category, rrule, anchor_start, tz, created_at)
  VALUES ('r-1', 'g-1', 'Rent', 50000, 'INR', 'INR', 'p-owner', 'rent',
          'FREQ=MONTHLY', '2026-01-01T09:00:00', 'Asia/Kolkata', '2026-01-02T00:00:00Z');
INSERT INTO tally_recurring_expense_split (template_id, party_id, share_minor)
  VALUES ('r-1', 'p-owner', 25000), ('r-1', 'p-friend', 25000);
INSERT INTO tally_expense
  (expense_id, group_id, description, amount_minor, currency, paid_by, spent_on,
   category, created_at, recurring_template_id)
  VALUES ('e-1', 'g-1', 'Dinner', 1200, 'INR', 'p-owner', '2026-01-03', 'food',
          '2026-01-03T00:00:00Z', 'r-1');
INSERT INTO tally_expense_payer (expense_id, party_id, paid_minor) VALUES ('e-1', 'p-owner', 1200);
INSERT INTO tally_expense_split (expense_id, party_id, share_minor)
  VALUES ('e-1', 'p-owner', 600), ('e-1', 'p-friend', 600);
INSERT INTO tally_expense_line_item
  (line_item_id, expense_id, kind, description, amount_minor, sort_order, created_at)
  VALUES ('li-1', 'e-1', 'item', 'Fish', 1200, 0, '2026-01-03T00:00:00Z');
INSERT INTO tally_expense_line_allocation (line_item_id, party_id, share_minor, created_at)
  VALUES ('li-1', 'p-owner', 1200, '2026-01-03T00:00:00Z');
INSERT INTO tally_nudge (nudge_id, party_id, group_id, as_of_minor, prepared_at, created_at)
  VALUES ('n-1', 'p-friend', 'g-1', 600, '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z');
INSERT INTO tally_obligation
  (obligation_id, from_party, to_party, amount_minor, currency, incurred_on, created_at)
  VALUES ('o-1', 'p-friend', 'p-owner', 300, 'INR', '2026-01-05', '2026-01-05T00:00:00Z');

-- the settlement pool, and a settlement that mirrors into it
INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
  VALUES ('acct-pool', 'p-owner', 'Tally settlements', 'cash', 'INR', 1);
INSERT INTO core_transaction
  (txn_id, account_id, posted_at, amount_minor, currency, direction, status,
   counterparty_party_id, description, external_id)
  VALUES ('t-settle', 'acct-pool', '2026-01-06T00:00:00Z', 600, 'INR', 'debit', 'posted',
          'p-friend', 'Tally settlement', 'tally:settlement:s-1');
INSERT INTO tally_settlement
  (settlement_id, group_id, from_party, to_party, amount_minor, currency, paid_on,
   txn_id, created_at)
  VALUES ('s-1', 'g-1', 'p-owner', 'p-friend', 600, 'INR', '2026-01-06', 't-settle',
          '2026-01-06T00:00:00Z');

-- a bank line a member bound to an expense: the bank's row, which must stay
INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
  VALUES ('acct-bank', 'p-owner', 'Savings', 'depository', 'INR', 1);
INSERT INTO core_transaction
  (txn_id, account_id, posted_at, amount_minor, currency, direction, status,
   description, external_id)
  VALUES ('t-bank', 'acct-bank', '2026-01-07T00:00:00Z', 900, 'INR', 'debit', 'posted',
          'CAFE', 'ofx:1');
INSERT INTO core_transaction
  (txn_id, account_id, posted_at, amount_minor, currency, direction, status,
   description, external_id)
  VALUES ('t-lookalike', 'acct-bank', '2026-01-07T00:00:00Z', 100, 'INR', 'debit', 'posted',
          'a lookalike', 'tally:settlement:lookalike');
INSERT INTO tally_expense
  (expense_id, group_id, description, amount_minor, currency, paid_by, spent_on,
   category, txn_id, created_at)
  VALUES ('e-2', NULL, 'Coffee', 900, 'INR', 'p-owner', '2026-01-07', 'food', 't-bank',
          '2026-01-07T00:00:00Z');

-- things that hang off a Tally entity through the spine
INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
  VALUES ('sch-1', 'urn:test:relations', 'Relations', '1');
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label)
  VALUES ('rel-1', 'sch-1', 'related', 'Related');
INSERT INTO core_link
  (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, asserted_by)
  VALUES ('l-tally', 'tally.expense', 'e-1', 'core.party', 'p-friend', 'rel-1',
          '2026-01-03T00:00:00Z', 'owner'),
         ('l-keep', 'core.party', 'p-owner', 'core.party', 'p-friend', 'rel-1',
          '2026-01-03T00:00:00Z', 'owner');
INSERT INTO core_attachment (attachment_id, target_type, target_id, content_id, role, is_primary,
                            created_at)
  VALUES ('att-1', 'tally.expense', 'e-1', 'ci-1', 'receipt', 1, '2026-01-03T00:00:00Z');
INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id,
                                  body_text, created_at)
  VALUES ('an-tally', 'p-owner', 'tally.expense', 'e-1', 'split with Asha', '2026-01-03T00:00:00Z'),
         ('an-keep', 'p-owner', 'core.party', 'p-friend', 'likes tea', '2026-01-03T00:00:00Z');
INSERT INTO schedule_recurrence_exception
  (exception_id, target_type, target_id, original_start_local, recurrence_semantics, scope,
   action, created_at)
  VALUES ('x-1', 'tally.recurring_expense', 'r-1', '2026-02-01T09:00:00', 'zoned', 'occurrence',
          'skip', '2026-01-08T00:00:00Z');
INSERT INTO schedule_recurrence_exception_attendee (exception_id, party_id)
  VALUES ('x-1', 'p-friend');
INSERT INTO access_seed_row (seed_id, app_id, target_type, target_id, seeded_at)
  VALUES ('seed-1', 'tally', 'tally.expense', 'e-1', '2026-01-03T00:00:00Z');

-- the chat: a thread scoped to Tally with a Tally card and a Notes card, and two
-- threads that are not (their search rows are what the rowid must keep)
INSERT INTO chat_thread (thread_id, title, scope_app, created_at, updated_at)
  VALUES ('th-aaa', 'Who owes whom', 'tally', '2026-02-01T00:00:00Z', '2026-02-01T00:10:00Z'),
         ('th-bbb', 'Notes about paneer', 'notes', '2026-02-02T00:00:00Z', '2026-02-02T00:10:00Z'),
         ('th-ccc', 'Unscoped chat', NULL, '2026-02-03T00:00:00Z', '2026-02-03T00:10:00Z');
INSERT INTO chat_message (thread_id, ordinal, role, text, outcome, created_at) VALUES
  ('th-aaa', 0, 'user', 'does Asha owe me anything', 'sent', '2026-02-01T00:00:00Z'),
  ('th-aaa', 1, 'assistant', 'Asha owes you 300', 'answered', '2026-02-01T00:00:01Z'),
  ('th-bbb', 0, 'user', 'find my paneer recipe', 'sent', '2026-02-02T00:00:00Z'),
  ('th-bbb', 1, 'assistant', 'Found one note', 'answered', '2026-02-02T00:00:01Z'),
  ('th-ccc', 0, 'user', 'hello there zebra', 'sent', '2026-02-03T00:00:00Z');
INSERT INTO chat_message_card (thread_id, message_ordinal, position, app, entity, row_id, title) VALUES
  ('th-aaa', 1, 0, 'tally', 'friend', 'p-friend', 'Asha'),
  ('th-aaa', 1, 1, 'notes', 'note', 'n-x', 'A note'),
  ('th-bbb', 1, 0, 'notes', 'note', 'n-y', 'Paneer');
",
    )
    .expect("a rung-fourteen vault holding Tally rows is built");
    raw
}

fn chat_search(vault: &Vault, word: &str) -> Vec<(i64, String)> {
    vault
        .read(|connection| {
            let mut statement = connection.prepare(
                "SELECT f.rowid, f.thread_id FROM fts_chat_thread f
                  WHERE fts_chat_thread MATCH ?1 ORDER BY f.rowid",
            )?;
            let rows = statement
                .query_map([word], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("the chat index reads")
}

#[test]
fn a_rung_fourteen_vault_climbs_losing_exactly_the_tally_rows() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("vault.db");
    let raw = tally_vault(&path);

    let before = counts(&raw);
    let threads_before: Vec<(i64, String)> = raw
        .prepare("SELECT rowid, thread_id FROM chat_thread ORDER BY rowid")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    // The twelve tables hold what was put in them, and the circle index holds
    // the group's circle only.
    assert_eq!(count(&raw, "SELECT COUNT(*) FROM tally_expense"), 2);
    assert_eq!(count(&raw, "SELECT COUNT(*) FROM fts_social_circle"), 1);
    assert_eq!(count(&raw, "SELECT COUNT(*) FROM fts_tally_expense"), 2);
    raw.close().map_err(|(_, error)| error).unwrap();

    let vault = Vault::open(&path).expect("the file climbs rung fifteen");
    assert_eq!(vault.schema_version(), 15);

    let (after, tally_objects, threads_after, cards, scopes) = vault
        .read(|connection| {
            let tally_objects = count(
                connection,
                r"SELECT COUNT(*) FROM sqlite_master
                   WHERE name LIKE '%tally%' OR name LIKE 'fts\_social\_circle%' ESCAPE '\'
                      OR sql LIKE '%tally\_%' ESCAPE '\'",
            );
            let threads: Vec<(i64, String)> = connection
                .prepare("SELECT rowid, thread_id FROM chat_thread ORDER BY rowid")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let cards: Vec<(String, i64, String)> = connection
                .prepare(
                    "SELECT thread_id, position, app FROM chat_message_card
                      ORDER BY thread_id, message_ordinal, position",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let scopes: Vec<(String, Option<String>, String, i64)> = connection
                .prepare("SELECT thread_id, scope_app, updated_at, row_version FROM chat_thread ORDER BY thread_id")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok((counts(connection), tally_objects, threads, cards, scopes))
        })
        .unwrap();

    // 1. No Tally object is left in the schema: no table, index, trigger or
    //    index of the circles, and no remaining statement that names one.
    assert_eq!(tally_objects, 0, "an object still names Tally");

    // 2. The tables that moved, and what each lost. Everything else is equal.
    //    core_entity loses the nine Tally entities (2 expenses, a line item, a
    //    friend, a group, a nudge, an obligation, a template, a settlement) and
    //    the eight spine entities that hung off them: the Tally annotation, the
    //    receipt attachment, the Tally link, the skipped occurrence, the group's
    //    circle and its member, the settlement's transaction and the pool account.
    let lost: BTreeMap<&str, i64> = BTreeMap::from([
        ("core_entity", 17),
        ("core_entity_kind", 8),
        ("core_link", 1),
        ("core_attachment", 1),
        ("knowledge_annotation", 1),
        ("schedule_recurrence_exception", 1),
        ("schedule_recurrence_exception_attendee", 1),
        ("social_circle", 1),
        ("social_circle_member", 1),
        ("core_transaction", 1),
        ("core_account", 1),
        ("access_seed_row", 1),
        ("chat_message_card", 1),
    ]);
    for (table, was) in &before {
        let now = after.get(table).copied().unwrap_or(-1);
        let expected = was - lost.get(table.as_str()).copied().unwrap_or(0);
        assert_eq!(now, expected, "{table}: {was} before, {now} after");
    }
    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>()
    );

    // 3. What survived is the right row, not just the right number.
    vault
        .read(|connection| {
            for (sql, expected) in [
                (
                    "SELECT COUNT(*) FROM core_transaction WHERE txn_id = 't-bank'",
                    1,
                ),
                (
                    "SELECT COUNT(*) FROM core_transaction WHERE txn_id = 't-lookalike'",
                    1,
                ),
                (
                    "SELECT COUNT(*) FROM core_transaction WHERE txn_id = 't-settle'",
                    0,
                ),
                (
                    "SELECT COUNT(*) FROM core_account WHERE account_id = 'acct-bank'",
                    1,
                ),
                (
                    "SELECT COUNT(*) FROM core_account WHERE account_id = 'acct-pool'",
                    0,
                ),
                (
                    "SELECT COUNT(*) FROM social_circle WHERE circle_id = 'c-plain'",
                    1,
                ),
                (
                    "SELECT COUNT(*) FROM social_circle WHERE circle_id = 'c-group'",
                    0,
                ),
                ("SELECT COUNT(*) FROM core_party", 3),
                (
                    "SELECT COUNT(*) FROM core_content_item WHERE content_id = 'ci-1'",
                    1,
                ),
                (
                    "SELECT COUNT(*) FROM knowledge_annotation WHERE annotation_id = 'an-keep'",
                    1,
                ),
                ("SELECT COUNT(*) FROM core_link WHERE link_id = 'l-keep'", 1),
                (
                    "SELECT COUNT(*) FROM core_entity WHERE entity_type LIKE 'tally.%'",
                    0,
                ),
            ] {
                assert_eq!(count(connection, sql), expected, "{sql}");
            }
            Ok(())
        })
        .unwrap();

    // 4. The chat: the same threads under the same rowids, the Tally thread
    //    kept and unscoped without a touch of its clock, the Tally card gone and
    //    the other two cards kept, the search index still answering with the
    //    right thread for each word.
    assert_eq!(threads_before, threads_after);
    assert_eq!(
        cards,
        vec![
            ("th-aaa".to_owned(), 1, "notes".to_owned()),
            ("th-bbb".to_owned(), 0, "notes".to_owned()),
        ]
    );
    assert_eq!(
        scopes,
        vec![
            (
                "th-aaa".to_owned(),
                None,
                "2026-02-01T00:10:00Z".to_owned(),
                1
            ),
            (
                "th-bbb".to_owned(),
                Some("notes".to_owned()),
                "2026-02-02T00:10:00Z".to_owned(),
                1
            ),
            (
                "th-ccc".to_owned(),
                None,
                "2026-02-03T00:10:00Z".to_owned(),
                1
            ),
        ]
    );
    assert_eq!(chat_search(&vault, "paneer")[0].1, "th-bbb");
    assert_eq!(chat_search(&vault, "zebra")[0].1, "th-ccc");
    assert_eq!(chat_search(&vault, "owe")[0].1, "th-aaa");
}

#[test]
fn the_chat_guards_and_search_triggers_survive_the_rebuild() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("vault.db");
    tally_vault(&path).close().map_err(|(_, e)| e).unwrap();
    Vault::open(&path)
        .expect("the file climbs")
        .close()
        .unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    // Money is a scope now; Tally is not.
    connection
        .execute(
            "INSERT INTO chat_thread (thread_id, title, scope_app, created_at)
             VALUES ('th-new', 'About money', 'money', '2026-03-01T00:00:00Z')",
            [],
        )
        .expect("money is a scope");
    assert!(
        connection
            .execute(
                "INSERT INTO chat_thread (thread_id, title, scope_app, created_at)
                 VALUES ('th-old', 'About tally', 'tally', '2026-03-01T00:00:00Z')",
                [],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "INSERT INTO chat_message_card (thread_id, message_ordinal, position, app, entity,
                                               row_id, title)
                 VALUES ('th-aaa', 1, 5, 'tally', 'friend', 'x', 'x')",
                [],
            )
            .is_err()
    );
    // The new thread is an entity and is found by what was said in it: the
    // entity guard and the search writers are on the rebuilt tables.
    assert_eq!(
        count(
            &connection,
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'th-new' AND entity_type = 'chat.thread'"
        ),
        1
    );
    connection
        .execute(
            "INSERT INTO chat_message (thread_id, ordinal, role, text, outcome, created_at)
             VALUES ('th-new', 0, 'user', 'budget for quokkas', 'sent', '2026-03-01T00:00:00Z')",
            [],
        )
        .unwrap();
    assert_eq!(
        count(
            &connection,
            "SELECT COUNT(*) FROM fts_chat_thread WHERE fts_chat_thread MATCH 'quokkas'"
        ),
        1
    );
    // The settle-once guard.
    connection
        .execute(
            "INSERT INTO chat_message (thread_id, ordinal, role, text, outcome, created_at)
             VALUES ('th-new', 1, 'assistant', 'done', 'answered', '2026-03-01T00:00:01Z')",
            [],
        )
        .unwrap();
    assert!(
        connection
            .execute(
                "UPDATE chat_message SET outcome = 'applied' WHERE thread_id = 'th-new' AND ordinal = 1",
                []
            )
            .is_err()
    );
    // Deleting the thread takes its entity and its search row with it.
    connection
        .execute("DELETE FROM chat_thread WHERE thread_id = 'th-new'", [])
        .unwrap();
    assert_eq!(
        count(
            &connection,
            "SELECT COUNT(*) FROM fts_chat_thread WHERE fts_chat_thread MATCH 'quokkas'"
        ),
        0
    );
    assert_eq!(
        count(
            &connection,
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'th-new'"
        ),
        0
    );
}

#[test]
fn a_founded_vault_holds_no_tally_and_the_rung_runs_over_its_own_result() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("vault.db");
    let vault = Vault::create(&path).expect("a vault");
    vault.found("Test", "Test Owner").unwrap();
    let founded = vault.read(|c| Ok(counts(c))).unwrap();
    vault.close().unwrap();
    {
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch("PRAGMA user_version = 14;").unwrap();
    }
    let again = Vault::open(&path).expect("rung fifteen runs over its own result");
    assert_eq!(again.schema_version(), 15);
    assert_eq!(again.read(|c| Ok(counts(c))).unwrap(), founded);
    let leftovers = again
        .read(|c| {
            Ok(count(
                c,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'tally_group'",
            ))
        })
        .unwrap();
    assert_eq!(leftovers, 0, "the stub the sweep reads is dropped again");
}
