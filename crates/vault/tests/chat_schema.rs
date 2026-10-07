//! THE CHAT'S HISTORY IS VAULT DATA (R-CHAT-1): rung eleven's schema, its four
//! commands and the reads that bring a thread back.
//!
//! What each test holds, and the claim a port would get wrong:
//!
//! 1. **The thread is an entity and its parts are projections.** Membership
//!    triggers, `row_version`, and a delete that cascades from the thread
//!    through its messages, cards and attachments.
//! 2. **A card is a snapshot with no foreign key.** The row it names can be
//!    purged and the card still reads; Locker cannot be named at all.
//! 3. **An attachment is a typed reference.** A purged photograph leaves the
//!    question and its label; a camera-roll thumbnail is a content item the
//!    attachment rents and a delete lets go of.
//! 4. **The journal does not keep what a delete removes.** `turn` is sealed.
//! 5. **A turn is one commit.** A refused write leaves nothing of it behind.
//! 6. **A regenerate replaces the last turn** and only that one.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

/// A one-pixel PNG, as base64.
const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

struct Chats {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Chats {
    fn open(seed: &str) -> Self {
        Self::from(common::Scratch::founded_with_blobs(seed).expect("a vault is founded"))
    }

    fn from(scratch: common::Scratch) -> Self {
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the count reads")
    }

    /// One answered turn with a card, optionally into an existing thread.
    fn ask(&self, thread: Option<&str>, question: &str, answer: &str) -> Value {
        let mut input = json!({
            "turn": {
                "question": { "text": question },
                "answer": {
                    "outcome": "answered",
                    "text": answer,
                    "cards": [{
                        "app": "tasks", "entity": "task", "id": "t-1",
                        "title": "Pay rent", "subtitle": "2026-10-01"
                    }],
                    "record_json": "{\"user\":\"q\",\"record\":{\"kind\":\"answer\",\"text\":\"a\"}}"
                }
            }
        });
        if let Some(thread) = thread {
            input["thread_id"] = json!(thread);
        }
        self.run("chat.save_turn", input)
    }
}

// ---------------------------------------------------------------------------
// 1. The schema
// ---------------------------------------------------------------------------

#[test]
fn a_thread_is_an_entity_and_deleting_it_takes_every_part_with_it() {
    let chats = Chats::open("chat-cascade");
    let saved = chats.ask(None, "  what is due   today? ", "Rent.");
    let thread = saved["thread_id"].as_str().expect("a thread id").to_owned();
    chats.ask(Some(&thread), "and tomorrow?", "Nothing.");

    // An ENTITY: one supertype row, of the kind the derivation found.
    assert_eq!(
        chats.count(&format!(
            "SELECT COUNT(*) FROM core_entity
              WHERE entity_id = '{thread}' AND entity_type = 'chat.thread'"
        )),
        1
    );
    // Its title is the first question, trimmed and collapsed.
    assert_eq!(saved["title"], "what is due today?");
    // Four messages (two turns), one card per answer.
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_message"), 4);
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_message_card"), 2);
    // `row_version` is there and moved with the second turn.
    assert!(
        chats.count(&format!(
            "SELECT row_version FROM chat_thread WHERE thread_id = '{thread}'"
        )) >= 2
    );

    let deleted = chats.run("chat.delete_thread", json!({ "thread_id": thread }));
    assert_eq!(deleted["deleted"], 1);
    for table in [
        "chat_thread",
        "chat_message",
        "chat_message_card",
        "chat_message_attachment",
    ] {
        assert_eq!(
            chats.count(&format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table} survived its thread"
        );
    }
    // And the supertype row went with it.
    assert_eq!(
        chats.count(&format!(
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = '{thread}'"
        )),
        0
    );
}

#[test]
fn a_message_is_a_projection_so_it_has_no_supertype_row_of_its_own() {
    let chats = Chats::open("chat-projection");
    chats.ask(None, "hello", "Hi.");
    assert_eq!(
        chats.count("SELECT COUNT(*) FROM core_entity WHERE entity_type LIKE 'chat.%'"),
        1,
        "only the thread is an entity"
    );
    assert_eq!(
        chats.count("SELECT COUNT(*) FROM core_entity_kind WHERE kind LIKE 'chat.%'"),
        1
    );
}

// ---------------------------------------------------------------------------
// 2. Cards
// ---------------------------------------------------------------------------

#[test]
fn a_card_has_no_foreign_key_and_survives_its_row() {
    let chats = Chats::open("chat-card-snapshot");
    // A real task, so the card names something that exists.
    let task = chats.run("schedule.add_task", json!({ "title": "Pay rent" }));
    let task_id = task["task_id"].as_str().expect("a task id").to_owned();
    let saved = chats.run(
        "chat.save_turn",
        json!({ "turn": {
            "question": { "text": "what is due?" },
            "answer": { "outcome": "answered", "text": "Rent.", "cards": [{
                "app": "tasks", "entity": "task", "id": task_id, "title": "Pay rent"
            }]}
        }}),
    );
    let thread = saved["thread_id"].as_str().unwrap().to_owned();

    // THE SCHEMA SAYS SO: no foreign key leaves the card table but the one to
    // its own message.
    let targets: Vec<String> = chats
        .vault()
        .read(|connection| {
            let mut statement = connection.prepare(
                "SELECT DISTINCT \"table\" FROM pragma_foreign_key_list('chat_message_card')",
            )?;
            Ok(statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(targets, vec!["chat_message".to_owned()]);

    assert!(
        chats
            .vault()
            .chat_card_row_exists("tasks", "task", &task_id)
            .unwrap()
    );

    // THE ROW GOES, the way a member's own deletion would take it.
    chats
        .vault()
        .commit(|tx| {
            tx.connection()
                .execute("DELETE FROM schedule_task WHERE task_id = ?1", [&task_id])?;
            Ok(())
        })
        .expect("the row is removed");

    let stored = chats
        .vault()
        .chat_thread(&thread)
        .unwrap()
        .expect("the thread");
    let card = &stored.messages[1].cards[0];
    assert_eq!(
        (card.app.as_str(), card.title.as_str()),
        ("tasks", "Pay rent")
    );
    // And the vault can say it is gone, which is what the tap asks.
    assert!(
        !chats
            .vault()
            .chat_card_row_exists("tasks", "task", &task_id)
            .unwrap()
    );
}

#[test]
fn locker_is_not_an_app_a_card_can_name() {
    let chats = Chats::open("chat-no-locker");
    let outcome = chats.try_run(
        "chat.save_turn",
        json!({ "turn": {
            "question": { "text": "show my passwords" },
            "answer": { "outcome": "answered", "text": "No.", "cards": [{
                "app": "locker", "entity": "item", "id": "l-1", "title": "Bank"
            }]}
        }}),
    );
    assert_eq!(
        outcome.status,
        CommandStatus::Failed,
        "the schema refuses it"
    );
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_thread"), 0);
    // And the table's own CHECK is the second wall, should a writer ever skip
    // the command.
    let direct = chats.vault().commit(|tx| {
        tx.connection().execute(
            "INSERT INTO chat_thread (thread_id, title, created_at) VALUES ('t', 'x', 'now')",
            [],
        )?;
        tx.connection().execute(
            "INSERT INTO chat_message (thread_id, ordinal, role, text, outcome, created_at)
             VALUES ('t', 1, 'assistant', 'a', 'answered', 'now')",
            [],
        )?;
        tx.connection().execute(
            "INSERT INTO chat_message_card (thread_id, message_ordinal, position, app, entity, row_id, title)
             VALUES ('t', 1, 0, 'locker', 'item', 'l-1', 'Bank')",
            [],
        )?;
        Ok(())
    });
    assert!(direct.is_err(), "the CHECK refuses a Locker card");
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_message_card"), 0);
}

#[test]
fn an_unknown_card_app_is_not_a_row_that_exists() {
    let chats = Chats::open("chat-card-exists");
    assert!(
        !chats
            .vault()
            .chat_card_row_exists("locker", "item", "x")
            .unwrap()
    );
    assert!(
        !chats
            .vault()
            .chat_card_row_exists("tasks", "task", "nope")
            .unwrap()
    );
    // An entity of a real app this does not know is not evidence of a gap.
    assert!(
        chats
            .vault()
            .chat_card_row_exists("tasks", "mystery", "x")
            .unwrap()
    );
}

// ---------------------------------------------------------------------------
// 3. Attachments
// ---------------------------------------------------------------------------

#[test]
fn an_attachment_is_a_reference_and_a_purged_photograph_leaves_the_question() {
    let chats = Chats::open("chat-attach-ref");
    let added = chats.run(
        "media.add_asset",
        json!({
            "data_uri": format!("data:image/png;base64,{ONE_PIXEL_PNG}"),
            "kind": "photo", "title": "A pixel", "width": 1, "height": 1
        }),
    );
    let asset_id = added["asset_id"].as_str().expect("an asset id").to_owned();
    let saved = chats.run(
        "chat.save_turn",
        json!({ "turn": {
            "question": {
                "text": "what is this?",
                "attachments": [
                    { "kind": "photo", "label": "A pixel", "asset_id": asset_id },
                    { "kind": "document", "label": "Gone doc", "document_id": "not-a-document" }
                ]
            },
            "answer": { "outcome": "answered", "text": "A pixel." }
        }}),
    );
    let thread = saved["thread_id"].as_str().unwrap().to_owned();

    let stored = chats.vault().chat_thread(&thread).unwrap().unwrap();
    let attachments = &stored.messages[0].attachments;
    assert_eq!(attachments.len(), 2);
    assert_eq!(attachments[0].asset_id.as_deref(), Some(asset_id.as_str()));
    // A document that is not in the vault is stored as its label alone, rather
    // than failing the whole turn on a dangling reference.
    assert_eq!(attachments[1].document_id, None);
    assert_eq!(attachments[1].label, "Gone doc");

    // THE PHOTOGRAPH IS PURGED: the engine nulls the reference.
    chats
        .vault()
        .commit(|tx| {
            tx.connection()
                .execute("DELETE FROM media_asset WHERE asset_id = ?1", [&asset_id])?;
            Ok(())
        })
        .expect("the asset is removed");
    let after = chats.vault().chat_thread(&thread).unwrap().unwrap();
    assert_eq!(after.messages[0].text, "what is this?");
    assert_eq!(after.messages[0].attachments[0].asset_id, None);
    assert_eq!(after.messages[0].attachments[0].label, "A pixel");
}

#[test]
fn a_camera_roll_thumbnail_is_stored_readable_rented_and_released_with_its_chat() {
    let chats = Chats::open("chat-thumb");
    let uri = format!("data:image/png;base64,{ONE_PIXEL_PNG}");
    let saved = chats.run(
        "chat.save_turn",
        json!({ "turn": {
            "question": {
                "text": "what is this?",
                "attachments": [{ "kind": "image", "label": "Photo", "thumbnail_data_uri": uri }]
            },
            "answer": { "outcome": "answered", "text": "A pixel." }
        }}),
    );
    let thread = saved["thread_id"].as_str().unwrap().to_owned();

    let stored = chats.vault().chat_thread(&thread).unwrap().unwrap();
    let attachment = &stored.messages[0].attachments[0];
    let content_id = attachment
        .thumb_content_id
        .clone()
        .expect("a thumbnail content item");
    let path = attachment
        .thumbnail_path
        .clone()
        .expect("the thumbnail is readable");
    assert_eq!(&std::fs::read(&path).expect("the file reads")[1..4], b"PNG");

    // RENTED: the registry's reference list sees it, so a sweep would not take it.
    let live: i64 = chats.count(&format!(
        "SELECT COUNT(*) FROM core_content_item WHERE content_id = '{content_id}' AND deleted_at IS NULL"
    ));
    assert_eq!(live, 1);

    // DELETING THE CHAT LETS GO: the bytes are released with no grace window.
    chats.run("chat.delete_thread", json!({ "thread_id": thread }));
    assert_eq!(
        chats.count(&format!(
            "SELECT COUNT(*) FROM core_content_item
              WHERE content_id = '{content_id}' AND deleted_at IS NOT NULL"
        )),
        1,
        "a thumbnail no chat rents is reclaimable"
    );
}

#[test]
fn a_thumbnail_another_chat_still_rents_is_not_released() {
    let chats = Chats::open("chat-thumb-shared");
    let uri = format!("data:image/png;base64,{ONE_PIXEL_PNG}");
    let turn = |text: &str| {
        chats.run(
            "chat.save_turn",
            json!({ "turn": {
                "question": {
                    "text": text,
                    "attachments": [{ "kind": "image", "label": "Photo", "thumbnail_data_uri": uri }]
                },
                "answer": { "outcome": "answered", "text": "A pixel." }
            }}),
        )["thread_id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let first = turn("first");
    let second = turn("second");
    chats.run("chat.delete_thread", json!({ "thread_id": first }));
    assert_eq!(
        chats.count("SELECT COUNT(*) FROM core_content_item WHERE deleted_at IS NOT NULL"),
        0,
        "the same bytes are one content item, and the second chat still holds it"
    );
    chats.run("chat.delete_thread", json!({ "thread_id": second }));
    assert_eq!(
        chats.count("SELECT COUNT(*) FROM core_content_item WHERE deleted_at IS NOT NULL"),
        1
    );
}

// ---------------------------------------------------------------------------
// 4. The journal
// ---------------------------------------------------------------------------

#[test]
fn the_audit_journal_keeps_a_token_and_never_what_was_said() {
    let chats = Chats::open("chat-journal");
    chats.ask(
        None,
        "a very private question about money",
        "A private answer.",
    );
    let journal: String = chats
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT input_json FROM agent_command_invocation WHERE command_id = 'chat.save_turn'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the journal reads");
    assert!(journal.contains("sealed:blake3:"), "{journal}");
    assert!(!journal.contains("private"), "{journal}");
    assert!(!journal.contains("Pay rent"), "{journal}");
}

// ---------------------------------------------------------------------------
// 5 & 6. A turn is one commit; a regenerate replaces the last one
// ---------------------------------------------------------------------------

#[test]
fn a_refused_save_leaves_nothing_of_the_turn() {
    let chats = Chats::open("chat-atomic");
    // Refused for naming a thread that is not there.
    let outcome = chats.try_run(
        "chat.save_turn",
        json!({ "thread_id": "nope", "turn": {
            "question": { "text": "hi" },
            "answer": { "outcome": "answered", "text": "x" }
        }}),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.reason.as_deref(), Some("This chat is gone."));
    // A refusal that names no reason is refused too.
    let outcome = chats.try_run(
        "chat.save_turn",
        json!({ "turn": {
            "question": { "text": "hi" },
            "answer": { "outcome": "refused" }
        }}),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_thread"), 0);
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_message"), 0);
}

#[test]
fn a_stopped_and_a_refused_turn_are_stored_as_what_the_member_saw() {
    let chats = Chats::open("chat-outcomes");
    let first = chats.run(
        "chat.save_turn",
        json!({ "turn": {
            "question": { "text": "list my tasks" },
            "answer": { "outcome": "stopped", "text": "You have thr" }
        }}),
    );
    let thread = first["thread_id"].as_str().unwrap().to_owned();
    chats.run(
        "chat.save_turn",
        json!({ "thread_id": thread, "turn": {
            "question": { "text": "what is the meaning of life?" },
            "answer": { "outcome": "refused", "refusal": "no_tool_fits" }
        }}),
    );
    let stored = chats.vault().chat_thread(&thread).unwrap().unwrap();
    let outcomes: Vec<(&str, &str, Option<&str>)> = stored
        .messages
        .iter()
        .map(|m| (m.role.as_str(), m.outcome.as_str(), m.refusal.as_deref()))
        .collect();
    assert_eq!(
        outcomes,
        vec![
            ("user", "sent", None),
            ("assistant", "stopped", None),
            ("user", "sent", None),
            ("assistant", "refused", Some("no_tool_fits")),
        ]
    );
    assert_eq!(stored.messages[1].text, "You have thr");
}

#[test]
fn a_regenerate_replaces_the_last_turn_and_only_that_one() {
    let chats = Chats::open("chat-regenerate");
    let saved = chats.ask(None, "first question", "First answer.");
    let thread = saved["thread_id"].as_str().unwrap().to_owned();
    chats.ask(Some(&thread), "second question", "Second answer.");

    chats.run(
        "chat.save_turn",
        json!({ "thread_id": thread, "replace_last": true, "turn": {
            "question": { "text": "second question" },
            "answer": { "outcome": "answered", "text": "A better second answer." }
        }}),
    );
    let stored = chats.vault().chat_thread(&thread).unwrap().unwrap();
    let texts: Vec<&str> = stored.messages.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(
        texts,
        vec![
            "first question",
            "First answer.",
            "second question",
            "A better second answer."
        ]
    );
    // The replaced turn's card went with it; the first turn's stayed.
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_message_card"), 1);

    // A replace with no earlier turn is refused, not guessed.
    let outcome = chats.try_run(
        "chat.save_turn",
        json!({ "replace_last": true, "turn": {
            "question": { "text": "x" },
            "answer": { "outcome": "answered", "text": "y" }
        }}),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
}

// ---------------------------------------------------------------------------
// Rename, delete, clear, and the reads
// ---------------------------------------------------------------------------

#[test]
fn the_list_is_newest_activity_first_and_a_rename_is_kept() {
    let chats = Chats::open("chat-list");
    let a = chats.ask(None, "alpha", "A.")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.scratch.clock.advance_ms(60_000);
    let b = chats.ask(None, "beta", "B.")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.scratch.clock.advance_ms(60_000);

    let order: Vec<String> = chats
        .vault()
        .chat_threads(50)
        .unwrap()
        .into_iter()
        .map(|row| row.title)
        .collect();
    assert_eq!(order, vec!["beta", "alpha"]);

    // A new turn in the older thread moves it to the top.
    chats.ask(Some(&a), "alpha again", "A2.");
    let order: Vec<String> = chats
        .vault()
        .chat_threads(50)
        .unwrap()
        .into_iter()
        .map(|row| row.title)
        .collect();
    assert_eq!(order, vec!["alpha", "beta"]);

    let renamed = chats.run(
        "chat.rename_thread",
        json!({ "thread_id": b, "title": "  Rent   questions " }),
    );
    assert_eq!(renamed["title"], "Rent questions");
    let titles: Vec<String> = chats
        .vault()
        .chat_threads(50)
        .unwrap()
        .into_iter()
        .map(|row| row.title)
        .collect();
    assert!(titles.contains(&"Rent questions".to_owned()));

    // An empty or blank name is refused; a missing chat is refused by name.
    assert_eq!(
        chats
            .try_run(
                "chat.rename_thread",
                json!({ "thread_id": b, "title": "   " })
            )
            .status,
        CommandStatus::Failed
    );
    assert_eq!(
        chats
            .try_run(
                "chat.rename_thread",
                json!({ "thread_id": "nope", "title": "x" })
            )
            .reason
            .as_deref(),
        Some("This chat is gone.")
    );
}

#[test]
fn clear_removes_every_chat_and_deleting_a_missing_one_is_not_an_error() {
    let chats = Chats::open("chat-clear");
    chats.ask(None, "one", "1");
    chats.ask(None, "two", "2");
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_thread"), 2);
    let cleared = chats.run("chat.clear", json!({}));
    assert_eq!(cleared["deleted"], 2);
    assert_eq!(chats.count("SELECT COUNT(*) FROM chat_message"), 0);
    assert_eq!(
        chats.count("SELECT COUNT(*) FROM core_entity WHERE entity_type = 'chat.thread'"),
        0
    );
    let again = chats.run("chat.delete_thread", json!({ "thread_id": "nope" }));
    assert_eq!(again["deleted"], 0);
}

#[test]
fn history_for_a_session_is_the_last_recorded_turns_oldest_first() {
    let chats = Chats::open("chat-history");
    let saved = chats.ask(None, "one", "1");
    let thread = saved["thread_id"].as_str().unwrap().to_owned();
    chats.ask(Some(&thread), "two", "2");
    // A stopped turn kept no record: it is not history.
    chats.run(
        "chat.save_turn",
        json!({ "thread_id": thread, "turn": {
            "question": { "text": "three" },
            "answer": { "outcome": "stopped", "text": "par" }
        }}),
    );
    let history = chats.vault().chat_history(&thread, 8).unwrap();
    let questions: Vec<&str> = history.iter().map(|turn| turn.question.as_str()).collect();
    assert_eq!(questions, vec!["one", "two"]);
    assert!(history.iter().all(|turn| turn.record_json.is_some()));
    assert_eq!(chats.vault().chat_history(&thread, 1).unwrap().len(), 1);
    assert_eq!(
        chats
            .vault()
            .chat_last_question(&thread)
            .unwrap()
            .as_deref(),
        Some("three")
    );
}

#[test]
fn chats_ride_the_one_file_so_a_second_vault_never_sees_them() {
    let first = Chats::open("chat-vault-a");
    let second = Chats::open("chat-vault-b");
    first.ask(None, "only here", "Yes.");
    assert_eq!(first.vault().chat_threads(50).unwrap().len(), 1);
    assert!(second.vault().chat_threads(50).unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// The commitments, held at the ladder head
//
// `crates/ontology/tests/commitments.rs` holds the frozen v0 corpus, which
// cannot contain a table a later rung founded; these are the same commitments
// over a vault the ladder founded (`ADDED_AFTER_THE_CORPUS` there names this
// file).
// ---------------------------------------------------------------------------

#[test]
fn the_thread_carries_the_membership_triggers_and_the_mutable_columns() {
    let chats = Chats::open("chat-commitments");
    let triggers: Vec<String> = chats
        .vault()
        .read(|connection| {
            let mut statement = connection.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'chat_thread'
                  ORDER BY name",
            )?;
            Ok(statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(
        triggers,
        vec![
            "chat_thread_entity_delete",
            "chat_thread_entity_insert",
            "chat_thread_touch_updated_at"
        ]
    );
    // `mutable` ⇒ `updated_at` + `row_version` (the half no corpus test holds).
    for column in ["updated_at", "row_version"] {
        assert_eq!(
            chats.count(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('chat_thread') WHERE name = '{column}'"
            )),
            1,
            "chat_thread has no {column}"
        );
    }
    // Every table of the pack is registered, and the projections say of what.
    let registered: Vec<&str> = centraid_ontology::registries::v0_registries()
        .entities
        .iter()
        .filter(|entity| entity.logical.starts_with("chat."))
        .map(|entity| entity.table.as_str())
        .collect();
    assert_eq!(
        registered,
        vec![
            "chat_message",
            "chat_message_attachment",
            "chat_message_card",
            "chat_thread"
        ]
    );
    let tables = chats
        .vault()
        .read(|connection| {
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat\\_%' ESCAPE '\\' ORDER BY name")?;
            Ok(statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(tables, registered, "the registry and the file agree");
}

#[test]
fn the_thumbnail_column_is_in_the_registrys_reference_list() {
    // The sweep that reclaims unreferenced bytes reads this list; a renting
    // column it did not know would have its thumbnails collected from under a
    // chat.
    assert!(
        centraid_ontology::registries::v0_registries()
            .content_references
            .iter()
            .any(|reference| reference.table == "chat_message_attachment"
                && reference.column == "thumb_content_id")
    );
}

#[test]
fn a_vault_below_rung_eleven_climbs_it_and_gains_an_empty_chat() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("vault.db");
    let vault = Vault::create(&path).expect("a vault");
    vault.found("Test", "Test Owner").unwrap();
    vault.close().expect("closes");
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute_batch(&format!(
            "BEGIN; {} PRAGMA user_version = 10; COMMIT;",
            common::UNDO_RUNG_ELEVEN
        ))
        .unwrap();
    }
    let migrated = Vault::open(&path).expect("the file climbs rung eleven");
    assert_eq!(migrated.schema_version(), centraid_vault::head_version());
    assert!(migrated.chat_threads(10).unwrap().is_empty());
    // And the registry the first insert depends on was seeded by the rung.
    let kinds: i64 = migrated
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_entity_kind WHERE kind = 'chat.thread'",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(kinds, 1);
    let registry = Registry::with_system_commands().unwrap();
    registry.install(&migrated).unwrap();
    let outcome = migrated
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "chat.save_turn",
                json!({ "turn": {
                    "question": { "text": "after the climb" },
                    "answer": { "outcome": "answered", "text": "Fine." }
                }}),
            ),
        )
        .unwrap();
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
}
