//! RUNG FIVE, the chat scope's fold into Agenda (#1128, R-1128-F2, R-1128-F3): a thread saved
//! under the task domain's scope reads `agenda` after the climb, and nothing it holds is lost.
//!
//! 1. **The rung is a climb.** A vault founded at the head is wound back to `user_version = 4` by
//!    undoing the rung's own statement — `chat_thread` founded again in rung one's text — the
//!    rows the old shape let through are written (a thread scoped to the task domain, with its
//!    messages, a card and an attachment), and the file is opened. `Vault::open` climbs with
//!    `foreign_keys = ON`, which is the condition under which a careless rebuild cascades every
//!    message away; the thread reads `agenda` and every row it held is still there, under the
//!    rowid the search index keys it by.
//! 2. **The climbed file is the founded file.** Its schema is a head-founded vault's, object for
//!    object, so the rung founds every table, index and trigger in the ladder's text but the one
//!    CHECK, `chat_message` in rung four's with its version and touch (#1129, F-R-1).
//! 3. **A card keeps its domain; a new thread cannot take the old scope**, through the command
//!    plane or past it.

use centraid_ontology::golden::scratch_dir;
use centraid_vault::access::Principal;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::migrations::BASELINE_SQL;
use centraid_vault::{Command, CommandStatus, Vault, head_version};
use serde_json::json;

/// Rung one's text for one object, exactly as the baseline founds it.
fn rung_one(kind: &str, name: &str) -> &'static str {
    let head = format!("\n-- {kind} {name}\n");
    let start = BASELINE_SQL
        .find(&head)
        .unwrap_or_else(|| panic!("rung one founds no {kind} {name}"))
        + head.len();
    let end = BASELINE_SQL[start..]
        .find("\n\n-- ")
        .map_or(BASELINE_SQL.len(), |at| start + at);
    &BASELINE_SQL[start..end]
}

/// Every schema object a file holds, sorted: what "the same schema" means here.
fn schema(connection: &rusqlite::Connection) -> Vec<String> {
    connection
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .expect("the schema reads")
        .query_map([], |row| {
            Ok(format!(
                "{}|{}|{}|{:?}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?
            ))
        })
        .expect("the schema reads")
        .collect::<rusqlite::Result<_>>()
        .expect("the schema reads")
}

fn founded(path: &std::path::Path, seed: &str) {
    let vault = Vault::create_with(
        path,
        Box::new(FixedClock::frozen()),
        Box::new(SeededIds::new(seed)),
    )
    .expect("a vault is founded");
    vault.found("Test", "Test Owner").expect("an owner");
}

fn one<T: rusqlite::types::FromSql>(vault: &Vault, sql: &str) -> T {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .unwrap_or_else(|error| panic!("{sql}: {error}"))
}

#[test]
fn a_thread_scoped_to_the_task_domain_climbs_to_agenda_with_everything_it_holds() {
    let dir = scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    founded(&path, "climb");

    // WIND IT BACK: undo the rung's own statement, then the version. The chat tables are empty
    // in a founded file and foreign keys are off on a bare connection, so dropping the thread
    // table drops nothing else; its index and its six triggers go with it and come back in rung
    // one's text.
    {
        let connection = rusqlite::Connection::open(&path).expect("the file opens");
        let mut undo = String::from("DROP TABLE chat_thread;\n");
        undo.push_str(rung_one("table", "chat_thread"));
        undo.push('\n');
        undo.push_str(rung_one("index", "chat_thread_recent_idx"));
        undo.push('\n');
        for trigger in [
            "chat_thread_entity_delete",
            "chat_thread_entity_insert",
            "chat_thread_touch_updated_at",
            "fts_chat_thread_ad",
            "fts_chat_thread_ai",
            "fts_chat_thread_au",
        ] {
            undo.push_str(rung_one("trigger", trigger));
            undo.push('\n');
        }
        undo.push_str("PRAGMA user_version = 4;");
        connection.execute_batch(&undo).expect("the rung is undone");
        let thread_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_thread'",
                [],
                |row| row.get(0),
            )
            .expect("the thread table is there");
        assert_eq!(
            format!("{thread_sql};"),
            rung_one("table", "chat_thread"),
            "the file is back in rung one's shape"
        );

        // THE ROWS THE OLD SHAPE LET THROUGH, written with enforcement on.
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 INSERT INTO chat_thread (thread_id, title, scope_app, created_at, updated_at)
                 VALUES ('th-unscoped', 'Hello', NULL,
                         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
                 INSERT INTO chat_thread (thread_id, title, scope_app, created_at, updated_at)
                 VALUES ('th-domain', 'What is due today?', 'tasks',
                         '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
                 INSERT INTO chat_thread (thread_id, title, scope_app, created_at, updated_at)
                 VALUES ('th-notes', 'Find my chili note', 'notes',
                         '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
                 INSERT INTO chat_message
                   (thread_id, ordinal, role, text, outcome, created_at)
                 VALUES ('th-domain', 0, 'user', 'What is due today, rhubarb?', 'sent',
                         '2026-01-02T00:00:00.000Z');
                 INSERT INTO chat_message
                   (thread_id, ordinal, role, text, outcome, created_at)
                 VALUES ('th-domain', 1, 'assistant', 'Found 1 task.', 'answered',
                         '2026-01-02T00:00:01.000Z');
                 INSERT INTO chat_message_card
                   (thread_id, message_ordinal, position, app, entity, row_id, title)
                 VALUES ('th-domain', 1, 0, 'tasks', 'task', 'task-1', 'Pay rent');
                 INSERT INTO chat_message_attachment
                   (thread_id, message_ordinal, position, kind, label)
                 VALUES ('th-domain', 0, 0, 'photo', 'the receipt');",
            )
            .expect("rung one admits the task domain as a scope");
    }
    assert_eq!(head_version(), 5);

    // What the file held before the climb, to hold the climb to.
    let before = {
        let connection = rusqlite::Connection::open(&path).expect("the file opens");
        connection
            .query_row(
                "SELECT rowid, updated_at, row_version FROM chat_thread
                  WHERE thread_id = 'th-domain'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .expect("the thread reads")
    };

    let vault = Vault::open(&path).expect("a file at rung four opens and climbs");
    assert_eq!(one::<i64>(&vault, "PRAGMA user_version"), 5);

    // THE THREAD READS AGENDA, under the same rowid, with the same activity stamp and version:
    // the scope moved in the carry, so no update trigger touched it.
    let after: (i64, String, i64, String) = vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT rowid, updated_at, row_version, scope_app FROM chat_thread
                  WHERE thread_id = 'th-domain'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("the thread reads");
    assert_eq!(after.3, "agenda");
    assert_eq!((after.0, after.1, after.2), before);
    // The other scopes are untouched.
    assert_eq!(
        one::<String>(
            &vault,
            "SELECT group_concat(thread_id || '=' || ifnull(scope_app, '-'), ' ')
               FROM (SELECT * FROM chat_thread ORDER BY thread_id)"
        ),
        "th-domain=agenda th-notes=notes th-unscoped=-"
    );
    let threads = vault.chat_threads(10).expect("the history reads");
    let listed = threads
        .iter()
        .find(|thread| thread.thread_id == "th-domain")
        .expect("the thread is listed");
    assert_eq!(listed.scope_app.as_deref(), Some("agenda"));

    // EVERY ROW IT HELD, and the card still names the task domain.
    assert_eq!(
        one::<i64>(
            &vault,
            "SELECT COUNT(*) FROM chat_message WHERE thread_id = 'th-domain'"
        ),
        2
    );
    assert_eq!(
        one::<String>(&vault, "SELECT app FROM chat_message_card"),
        "tasks"
    );
    assert_eq!(
        one::<i64>(&vault, "SELECT COUNT(*) FROM chat_message_attachment"),
        1
    );
    // RUNG FOUR'S VERSION SURVIVES THE REBUILD: the message keeps its version, and an edit in
    // place still bumps it (#1129, F-R-1).
    let version = |vault: &Vault| {
        one::<i64>(
            vault,
            "SELECT row_version FROM chat_message WHERE thread_id = 'th-domain' AND ordinal = 1",
        )
    };
    assert_eq!(version(&vault), 1);
    vault
        .commit(|tx| {
            tx.set_producer("test.chat_scope_agenda");
            tx.connection().execute(
                "UPDATE chat_message SET text = 'Found one task.'
                  WHERE thread_id = 'th-domain' AND ordinal = 1",
                [],
            )?;
            Ok(())
        })
        .expect("a message edits in place");
    assert_eq!(version(&vault), 2);
    // THE SEARCH INDEX STILL ANSWERS WITH THIS THREAD: it is keyed by the thread's rowid.
    assert_eq!(
        one::<String>(
            &vault,
            "SELECT t.thread_id FROM fts_chat_thread f JOIN chat_thread t ON t.rowid = f.rowid
              WHERE fts_chat_thread MATCH 'rhubarb'"
        ),
        "th-domain"
    );
    // The guards came back: a deleted thread takes its entity row and its index row with it.
    vault
        .commit(|tx| {
            tx.set_producer("test.chat_scope_agenda");
            tx.connection()
                .execute("DELETE FROM chat_thread WHERE thread_id = 'th-notes'", [])?;
            Ok(())
        })
        .expect("a thread deletes");
    assert_eq!(
        one::<i64>(
            &vault,
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'th-notes'"
        ),
        0
    );
    assert_eq!(one::<i64>(&vault, "SELECT COUNT(*) FROM fts_chat_thread"), 2);

    // THE CLIMBED FILE IS THE FOUNDED FILE: object for object, the same schema.
    let fresh = dir.join("fresh.db");
    founded(&fresh, "fresh");
    let climbed = vault
        .read(|connection| Ok(schema(connection)))
        .expect("the schema reads");
    let founded_schema =
        schema(&rusqlite::Connection::open(&fresh).expect("the founded file opens"));
    assert_eq!(climbed, founded_schema);
    drop(vault);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_card_keeps_its_domain_and_no_new_thread_takes_the_old_scope() {
    let dir = scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    founded(&path, "scope");
    let vault = Vault::open(&path).expect("the file opens");
    let registry = Registry::with_system_commands().expect("the registry builds");
    registry.install(&vault).expect("the record installs");
    let principal = Principal::owner("phone");
    let turn = |scope: &str| {
        vault
            .execute(
                &registry,
                &principal,
                &Command::new(
                    "chat.save_turn",
                    json!({
                        "scope_app": scope,
                        "turn": {
                            "question": { "text": "What is due today?" },
                            "answer": {
                                "outcome": "answered",
                                "text": "Rent.",
                                "cards": [{
                                    "app": "tasks", "entity": "task", "id": "t-1",
                                    "title": "Pay rent"
                                }]
                            }
                        }
                    }),
                ),
            )
            .expect("the command answers")
    };

    // THROUGH THE COMMAND PLANE: the task domain is no scope, Agenda is, and the card it carries
    // still names the domain.
    assert_ne!(turn("tasks").status, CommandStatus::Executed);
    assert_eq!(turn("agenda").status, CommandStatus::Executed);
    assert_eq!(
        one::<String>(
            &vault,
            "SELECT t.scope_app || '/' || c.app FROM chat_thread t
               JOIN chat_message_card c ON c.thread_id = t.thread_id"
        ),
        "agenda/tasks"
    );

    // PAST IT: the schema's own CHECK refuses the old scope.
    let refused = vault
        .commit(|tx| {
            tx.set_producer("test.chat_scope_agenda");
            tx.connection().execute(
                "INSERT INTO chat_thread (thread_id, title, scope_app, created_at)
                 VALUES ('th-old', 'Old', 'tasks', '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect_err("the old scope is refused");
    assert!(refused.to_string().contains("CHECK"), "{refused}");
    drop(vault);
    let _ = std::fs::remove_dir_all(dir);
}
