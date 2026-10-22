//! A conversation in the model's own tables (#1135, lane 7): a turn saved in one commit with its
//! cards and attachments, a proposal settled once, a rename that stays out of the journal, a delete
//! that leaves nothing, and the roster the cards and scopes are held to.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs("chat").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: Value) -> String {
        let outcome = self.run(name, input);
        assert_ne!(
            outcome.status,
            CommandStatus::Executed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn count(&self, sql: &str, params: &[&str]) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn text(&self, sql: &str, params: &[&str]) -> Option<String> {
        self.scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))
                        .optional()?
                        .flatten(),
                )
            })
            .expect("a row")
    }

    /// Whether a word finds the thread in the search index.
    fn finds(&self, word: &str, thread: &str) -> bool {
        self.count(
            "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[word, thread],
        ) > 0
    }

    fn turn(&self, thread: Option<&str>, question: &str, answer: Value) -> Value {
        let mut input = json!({ "turn": { "question": { "text": question }, "answer": answer } });
        if let Some(thread) = thread {
            input["thread_id"] = json!(thread);
        }
        self.ok("thread.save_turn", input)
    }
}

fn answered(text: &str) -> Value {
    json!({ "outcome": "answered", "text": text })
}

fn card(app: &str, entity: &str, id: &str) -> Value {
    json!({ "app": app, "entity": entity, "id": id, "title": "Rent", "meta": "open" })
}

const PIXEL: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

#[test]
fn a_turn_is_one_commit_with_its_cards_and_attachments() {
    let w = World::new();
    let saved = w.ok(
        "thread.save_turn",
        json!({
          "scope_app": "agenda",
          "turn": {
            "question": { "text": "what   is due\ntoday?", "attachments": [
              { "form": "image", "label": "receipt", "thumbnail_data_uri": PIXEL }] },
            "answer": { "outcome": "answered", "text": "Rent.", "record_json": "{\"read\":1}",
                        "cards": [card("tasks", "task", "t1")] }
          }
        }),
    );
    let thread = saved["thread_id"].as_str().unwrap();
    assert_eq!(saved["title"], "what is due today?");
    assert_eq!(
        (
            saved["user_ordinal"].as_i64(),
            saved["assistant_ordinal"].as_i64()
        ),
        (Some(0), Some(1))
    );
    // The thread is an entity of its own kind, with the scope on its kind row.
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM entity WHERE id = ?1 AND kind = 'thread'",
            &[thread]
        ),
        1
    );
    assert_eq!(
        w.text("SELECT scope FROM thread WHERE id = ?1", &[thread])
            .as_deref(),
        Some("agenda")
    );
    // The thumbnail is rented from the blob plane; the card is a snapshot in the answer's own row.
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM message_attachment WHERE thread_id = ?1 AND thumb IS NOT NULL",
            &[thread]
        ),
        1
    );
    let cards = w
        .text(
            "SELECT cards FROM message WHERE thread_id = ?1 AND ordinal = 1",
            &[thread],
        )
        .unwrap();
    let cards: Value = serde_json::from_str(&cards).unwrap();
    assert_eq!(cards[0]["app"], "tasks");
    assert_eq!(cards[0]["id"], "t1");
    // The reader gives it back whole.
    let stored = w
        .scratch
        .vault
        .chat_thread(thread)
        .unwrap()
        .expect("a thread");
    assert_eq!(stored.messages.len(), 2);
    assert_eq!(stored.messages[1].cards[0].row_id, "t1");
    assert_eq!(stored.messages[0].attachments[0].form, "image");
    assert!(stored.messages[0].attachments[0].thumbnail_path.is_some());
    assert_eq!(stored.thread.scope_app.as_deref(), Some("agenda"));
}

#[test]
fn the_journal_keeps_a_token_never_what_was_said() {
    let w = World::new();
    let saved = w.turn(None, "my secret question", answered("a secret answer"));
    let thread = saved["thread_id"].as_str().unwrap();
    w.ok(
        "thread.rename",
        json!({ "thread_id": thread, "title": "a secret name" }),
    );
    let journal: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.query_row("SELECT group_concat(input, ' ') FROM journal", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap();
    for said in ["secret question", "secret answer", "secret name"] {
        assert!(!journal.contains(said), "the journal holds {said:?}");
    }
    assert!(journal.contains("sealed"), "{journal}");
}

#[test]
fn search_finds_a_thread_by_its_title_and_the_members_words_never_the_assistants() {
    let w = World::new();
    let saved = w.turn(None, "invoices from the plumber", answered("zanzibar"));
    let thread = saved["thread_id"].as_str().unwrap();
    assert!(w.finds("plumber", thread));
    assert!(
        !w.finds("zanzibar", thread),
        "R-1097-22: the assistant's words are not indexed"
    );
    // A later turn is found, and a rename moves the hit.
    w.turn(Some(thread), "and the electrician", answered("ok"));
    assert!(w.finds("electrician", thread));
    w.ok(
        "thread.rename",
        json!({ "thread_id": thread, "title": "  Home   repairs " }),
    );
    assert!(w.finds("repairs", thread));
    assert_eq!(
        w.text("SELECT title FROM entity WHERE id = ?1", &[thread])
            .as_deref(),
        Some("Home repairs")
    );
}

#[test]
fn a_proposal_settles_once_and_a_new_turn_dismisses_the_one_waiting() {
    let w = World::new();
    let proposed = json!({ "outcome": "proposed", "text": "Mark it done?" });
    let saved = w.turn(None, "finish the rent", proposed.clone());
    let thread = saved["thread_id"].as_str().unwrap();
    assert!(w.scratch.vault.chat_proposal_waiting(thread).unwrap());
    let settled = w.ok(
        "thread.settle_proposal",
        json!({ "thread_id": thread, "outcome": "applied", "text": "Done." }),
    );
    assert_eq!(settled["settled"], true);
    assert!(!w.scratch.vault.chat_proposal_waiting(thread).unwrap());
    // A tap delivered twice settles once.
    assert_eq!(
        w.ok(
            "thread.settle_proposal",
            json!({ "thread_id": thread, "outcome": "applied" })
        )["settled"],
        false
    );
    // A settled proposal does not settle another way.
    assert!(
        w.refused(
            "thread.settle_proposal",
            json!({ "thread_id": thread, "outcome": "failed" })
        )
        .contains("Nothing is waiting")
    );
    // The next turn dismisses a proposal nobody answered, and only the last can wait.
    w.turn(Some(thread), "again", proposed);
    w.turn(Some(thread), "never mind", answered("ok"));
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM message WHERE thread_id = ?1 AND outcome = 'dismissed'",
            &[thread]
        ),
        1
    );
    // The engine holds the lifecycle even against a writer that bypasses the command.
    let bypass = w.scratch.vault.read(|c| {
        Ok(c.execute(
            "UPDATE message SET outcome = 'proposed' WHERE thread_id = ?1 AND outcome = 'applied'",
            [thread],
        )
        .is_err())
    });
    assert!(bypass.unwrap());
}

#[test]
fn a_retry_replaces_the_last_turn_and_only_that_one() {
    let w = World::new();
    let saved = w.turn(None, "first", answered("one"));
    let thread = saved["thread_id"].as_str().unwrap();
    w.turn(Some(thread), "second", answered("two"));
    let mut again = json!({ "thread_id": thread, "replace_last": true,
        "turn": { "question": { "text": "second" }, "answer": answered("two, again") } });
    again["turn"]["question"]["attachments"] =
        json!([{ "form": "image", "label": "x", "thumbnail_data_uri": PIXEL }]);
    w.ok("thread.save_turn", again);
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM message WHERE thread_id = ?1",
            &[thread]
        ),
        4
    );
    assert_eq!(
        w.text(
            "SELECT text FROM message WHERE thread_id = ?1 AND ordinal = 3",
            &[thread]
        )
        .as_deref(),
        Some("two, again")
    );
    assert!(
        w.refused(
            "thread.save_turn",
            json!({ "replace_last": true,
            "turn": { "question": { "text": "q" }, "answer": answered("a") } })
        )
        .contains("no earlier question")
    );
}

#[test]
fn the_roster_is_the_schemas_not_a_check() {
    let w = World::new();
    let attempt = |scope: Value, app: &str| {
        let mut input = json!({ "turn": { "question": { "text": "q" },
            "answer": { "outcome": "answered", "text": "a", "cards": [card(app, "task", "t")] } } });
        input["scope_app"] = scope;
        w.run("thread.save_turn", input).status
    };
    assert_eq!(attempt(json!(null), "tasks"), CommandStatus::Executed);
    // Health is never named; Locker is a card domain and a scope (the owner's ruling of
    // 2026-10-22); `tasks` is a domain that is no scope (R-1128-F2).
    assert_eq!(attempt(json!(null), "locker"), CommandStatus::Executed);
    assert_ne!(attempt(json!(null), "health"), CommandStatus::Executed);
    assert_ne!(attempt(json!("tasks"), "notes"), CommandStatus::Executed);
    assert_eq!(attempt(json!("locker"), "notes"), CommandStatus::Executed);
    assert_eq!(attempt(json!("photos"), "notes"), CommandStatus::Executed);
}

#[test]
fn a_chat_is_renamed_and_deleted_by_its_own_door_and_leaves_nothing() {
    let w = World::new();
    let saved = w.ok(
        "thread.save_turn",
        json!({ "turn": { "question": { "text": "keep this", "attachments": [
                  { "form": "image", "label": "pic", "thumbnail_data_uri": PIXEL }] },
                "answer": answered("kept") } }),
    );
    let thread = saved["thread_id"].as_str().unwrap();
    assert!(
        w.refused("entity.retitle", json!({ "id": thread, "title": "x" }))
            .contains("thread.rename")
    );
    assert!(
        w.refused("entity.trash", json!({ "id": thread }))
            .contains("deleted, not moved to the trash")
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM blob", &[]), 1);
    // Delete is the shared purge: no trash first, and the thumbnail goes with it.
    w.ok("entity.purge", json!({ "id": thread }));
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE id = ?1", &[thread]),
        0
    );
    for table in ["thread", "message", "message_attachment"] {
        let column = if table == "thread" { "id" } else { "thread_id" };
        assert_eq!(
            w.count(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
                &[thread]
            ),
            0,
            "{table}"
        );
    }
    assert_eq!(
        w.count("SELECT COUNT(*) FROM blob", &[]),
        0,
        "the thumbnail nothing rents is collected"
    );
    assert!(!w.finds("keep", thread));
}

#[test]
fn clear_deletes_every_chat() {
    let w = World::new();
    w.turn(None, "one", answered("a"));
    w.turn(None, "two", answered("b"));
    assert_eq!(w.ok("thread.clear", json!({}))["deleted"], 2);
    assert_eq!(w.count("SELECT COUNT(*) FROM thread", &[]), 0);
    assert_eq!(w.count("SELECT COUNT(*) FROM message", &[]), 0);
}

#[test]
fn an_attachment_is_a_vault_entity_the_engine_lets_go_of_and_the_chat_keeps_its_label() {
    let w = World::new();
    let photo = w.ok(
        "document.create_text",
        json!({ "title": "Notes", "body_text": "words", "media_type": "text/plain" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let saved = w.ok(
        "thread.save_turn",
        json!({ "turn": { "question": { "text": "read it", "attachments": [
                  { "form": "document", "label": "Notes", "entity_id": photo }] },
                "answer": answered("ok") } }),
    );
    let thread = saved["thread_id"].as_str().unwrap();
    // A document attachment names a document; a photograph's id is refused as one.
    assert!(
        w.refused(
            "thread.save_turn",
            json!({ "turn": { "question": { "text": "q", "attachments": [
            { "form": "photo", "label": "n", "entity_id": photo }] }, "answer": answered("a") } })
        )
        .contains("not a photo")
    );
    let stored = w.scratch.vault.chat_thread(thread).unwrap().unwrap();
    assert_eq!(
        stored.messages[0].attachments[0].entity_id.as_deref(),
        Some(photo.as_str())
    );
    // The chat may read the document it was handed.
    assert!(matches!(
        w.scratch.vault.attachment_document(&photo).unwrap(),
        centraid_vault::chat::DocumentSource::Text { .. }
    ));
    assert_eq!(w.scratch.vault.attachable_documents(10).unwrap().len(), 1);
    // Trashed, it reads as lost; purged, the engine sets the pointer to NULL and the label stays.
    w.ok("entity.trash", json!({ "id": photo }));
    let stored = w.scratch.vault.chat_thread(thread).unwrap().unwrap();
    assert_eq!(stored.messages[0].attachments[0].entity_id, None);
    assert!(
        !w.scratch
            .vault
            .chat_card_row_exists("docs", "document", &photo)
            .unwrap()
    );
    w.ok("entity.purge", json!({ "id": photo }));
    assert_eq!(
        w.text(
            "SELECT label FROM message_attachment WHERE thread_id = ?1",
            &[thread]
        )
        .as_deref(),
        Some("Notes")
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM message_attachment WHERE thread_id = ?1 AND entity_id IS NULL",
            &[thread]
        ),
        1
    );
}

#[test]
fn a_card_is_live_while_its_row_is_and_an_unknown_word_is_not_evidence_of_a_hole() {
    let w = World::new();
    let note = w.ok("note.create", json!({ "title": "N", "body": "b" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let vault = &w.scratch.vault;
    assert!(vault.chat_card_row_exists("notes", "note", &note).unwrap());
    assert!(
        !vault.chat_card_row_exists("notes", "task", &note).unwrap(),
        "a note is no task"
    );
    assert!(!vault.chat_card_row_exists("health", "note", &note).unwrap());
    assert!(
        !vault
            .chat_card_row_exists("locker", "locker_item", "no-such-item")
            .unwrap(),
        "a Locker card is live only while its item is"
    );
    assert!(
        vault
            .chat_card_row_exists("notes", "somethingnew", "x")
            .unwrap()
    );
    w.ok("entity.trash", json!({ "id": note }));
    assert!(!vault.chat_card_row_exists("notes", "note", &note).unwrap());
}

#[test]
fn threads_list_newest_activity_first() {
    let w = World::new();
    let a = w.turn(None, "alpha", answered("a"))["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let b = w.turn(None, "beta", answered("b"))["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let order = |vault: &centraid_vault::Vault| {
        vault
            .chat_threads(10)
            .unwrap()
            .into_iter()
            .map(|t| t.thread_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(order(&w.scratch.vault), [b.clone(), a.clone()]);
    w.turn(Some(&a), "more", answered("m"));
    assert_eq!(order(&w.scratch.vault), [a, b]);
}
