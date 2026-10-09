//! A PROPOSAL'S LIFE IS VAULT DATA (#1088): rung twelve, `chat.settle_proposal`,
//! and what `chat.save_turn` does to a card nobody answered.
//!
//! A write the assistant makes parks behind a confirm card; the turn that parked
//! is saved `proposed`, and how the card ended is recorded once. What each test
//! holds, and the claim a port would get wrong:
//!
//! 1. **A proposal settles into each of its four ends**, and the settled line
//!    replaces the proposal's words.
//! 2. **It settles once.** A repeat of the same tap is a no-op; a different end,
//!    or a tap on an answer that was never a proposal, is refused with a sentence.
//! 3. **A new turn dismisses the card nobody answered**, so a thread holds at
//!    most one proposal and it is its last.
//! 4. **The schema says so too.** The two triggers refuse what no command asks:
//!    a told answer changing, an end changing, a message born settled.
//! 5. **The journal does not keep the line.** `text` is sealed.
//! 6. **Rung twelve is a rebuild that keeps the children.** A file at rung eleven
//!    climbs with every message, card and attachment it had, and the foreign keys
//!    still cascade from the thread — dropping the parent runs the children's
//!    `ON DELETE CASCADE`, which `defer_foreign_keys` does not defer.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

struct Chats {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Chats {
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
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

    /// A turn that ended in a parked write, optionally into an existing thread.
    fn propose(&self, thread: Option<&str>, question: &str) -> Value {
        let mut input = json!({ "turn": {
            "question": { "text": question },
            "answer": {
                "outcome": "proposed",
                "text": "Proposed: complete \"Pick up the dry cleaning\".",
                "cards": [{
                    "app": "tasks", "entity": "task", "id": "t-dry", "title": "Pick up the dry cleaning"
                }]
            }
        }});
        if let Some(thread) = thread {
            input["thread_id"] = json!(thread);
        }
        self.run("chat.save_turn", input)
    }

    fn answer(&self, thread: &str, question: &str) -> Value {
        self.run(
            "chat.save_turn",
            json!({
                "thread_id": thread,
                "turn": {
                    "question": { "text": question },
                    "answer": { "outcome": "answered", "text": "Rent." }
                }
            }),
        )
    }

    fn answer_in_new_thread(&self, question: &str) -> String {
        self.run(
            "chat.save_turn",
            json!({ "turn": {
                "question": { "text": question },
                "answer": { "outcome": "answered", "text": "Rent." }
            }}),
        )["thread_id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn settle(&self, thread: &str, outcome: &str, text: Option<&str>) -> CommandOutcome {
        let mut input = json!({ "thread_id": thread, "outcome": outcome });
        if let Some(text) = text {
            input["text"] = json!(text);
        }
        self.try_run("chat.settle_proposal", input)
    }

    /// `(outcome, text)` of every assistant message of a thread, oldest first.
    fn answers(&self, thread: &str) -> Vec<(String, String)> {
        self.vault()
            .chat_thread(thread)
            .expect("the thread reads")
            .expect("the thread is there")
            .messages
            .into_iter()
            .filter(|message| message.role == "assistant")
            .map(|message| (message.outcome, message.text))
            .collect()
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the count reads")
    }
}

const PROPOSED_LINE: &str = "Proposed: complete \"Pick up the dry cleaning\".";

// ---------------------------------------------------------------------------
// 1 & 2. A proposal settles into each of its ends, once
// ---------------------------------------------------------------------------

#[test]
fn a_proposal_is_saved_proposed_and_settles_into_each_of_its_four_ends() {
    let chats = Chats::open("proposal-ends");
    for (end, line) in [
        ("applied", "Done."),
        ("dismissed", "Not done."),
        ("stale", "That changed since. Ask again."),
        ("failed", "Not done. That task is gone."),
    ] {
        let saved = chats.propose(None, &format!("complete it ({end})"));
        let thread = saved["thread_id"].as_str().expect("a thread id").to_owned();
        assert_eq!(
            chats.answers(&thread),
            vec![("proposed".to_owned(), PROPOSED_LINE.to_owned())],
            "the turn that parked is saved proposed, with the proposal's words"
        );

        let settled = chats.settle(&thread, end, Some(line));
        assert_eq!(settled.status, CommandStatus::Executed, "{settled:?}");
        assert_eq!(settled.output["settled"], true);
        assert_eq!(
            settled.output["assistant_ordinal"], saved["assistant_ordinal"],
            "it settled the message the turn saved"
        );
        assert_eq!(
            chats.answers(&thread),
            vec![(end.to_owned(), line.to_owned())],
            "the outcome moved and the settled line replaced the proposal's"
        );
        // THE CARDS STAY: what the answer showed is part of what was said.
        let stored = chats.vault().chat_thread(&thread).unwrap().unwrap();
        assert_eq!(stored.messages[1].cards.len(), 1, "{end}");
    }
}

#[test]
fn a_chat_says_whether_a_proposal_is_waiting_in_it() {
    let chats = Chats::open("proposal-waiting");
    assert!(
        !chats.vault().chat_proposal_waiting("no-such-chat").unwrap(),
        "a chat that is not there has nothing waiting"
    );
    let answered = chats.answer_in_new_thread("what is due?");
    assert!(!chats.vault().chat_proposal_waiting(&answered).unwrap());
    let thread = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(chats.vault().chat_proposal_waiting(&thread).unwrap());
    chats.run(
        "chat.settle_proposal",
        json!({ "thread_id": thread, "outcome": "applied", "text": "Done." }),
    );
    assert!(
        !chats.vault().chat_proposal_waiting(&thread).unwrap(),
        "a settled proposal is no longer waiting"
    );
}

#[test]
fn a_settle_with_no_line_moves_the_outcome_and_keeps_the_words() {
    let chats = Chats::open("proposal-no-line");
    let thread = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.run(
        "chat.settle_proposal",
        json!({ "thread_id": thread, "outcome": "dismissed" }),
    );
    assert_eq!(
        chats.answers(&thread),
        vec![("dismissed".to_owned(), PROPOSED_LINE.to_owned())]
    );
}

#[test]
fn a_tap_delivered_twice_settles_once_and_a_different_end_is_refused() {
    let chats = Chats::open("proposal-once");
    let thread = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.run(
        "chat.settle_proposal",
        json!({ "thread_id": thread, "outcome": "applied", "text": "Done." }),
    );
    // THE SAME TAP AGAIN is a no-op that says so: it answers, and changes nothing.
    let again = chats.settle(&thread, "applied", Some("Done."));
    assert_eq!(again.status, CommandStatus::Executed, "{again:?}");
    assert_eq!(again.output["settled"], false);
    // AN END IS FINAL: nothing is waiting any more, and the sentence says so.
    let other = chats.settle(&thread, "dismissed", Some("Not done."));
    assert_eq!(other.status, CommandStatus::Failed);
    assert_eq!(other.predicate.as_deref(), Some("a_proposal_is_waiting"));
    assert_eq!(other.reason.as_deref(), Some("Nothing is waiting on that."));
    assert_eq!(
        chats.answers(&thread),
        vec![("applied".to_owned(), "Done.".to_owned())]
    );
}

#[test]
fn an_answer_that_was_never_a_proposal_and_a_chat_that_is_gone_are_refused() {
    let chats = Chats::open("proposal-refused");
    let thread = chats.answer_in_new_thread("what is due?");
    let not_a_proposal = chats.settle(&thread, "applied", Some("Done."));
    assert_eq!(not_a_proposal.status, CommandStatus::Failed);
    assert_eq!(
        not_a_proposal.predicate.as_deref(),
        Some("a_proposal_is_waiting")
    );
    let gone = chats.settle("no-such-chat", "applied", None);
    assert_eq!(gone.status, CommandStatus::Failed);
    assert_eq!(gone.reason.as_deref(), Some("This chat is gone."));
    // and the schema's four ends are the only ones the command takes
    let bogus = chats.settle(&thread, "answered", None);
    assert_ne!(bogus.status, CommandStatus::Executed);
}

// ---------------------------------------------------------------------------
// 3. A new turn dismisses the card nobody answered
// ---------------------------------------------------------------------------

#[test]
fn the_next_turn_dismisses_the_proposal_nobody_answered_and_keeps_its_words() {
    let chats = Chats::open("proposal-lapse");
    let thread = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.answer(&thread, "never mind, what is due?");
    assert_eq!(
        chats.answers(&thread),
        vec![
            ("dismissed".to_owned(), PROPOSED_LINE.to_owned()),
            ("answered".to_owned(), "Rent.".to_owned()),
        ],
        "the member never saw anything but the proposal, so its words stay"
    );
    // and the dismissed card cannot be settled afterwards: nothing is waiting
    let late = chats.settle(&thread, "applied", Some("Done."));
    assert_eq!(late.status, CommandStatus::Failed);
}

#[test]
fn a_thread_holds_one_proposal_at_a_time_and_it_is_its_last_message() {
    let chats = Chats::open("proposal-one-at-a-time");
    let thread = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.propose(Some(&thread), "and the tires too");
    chats.propose(Some(&thread), "and the oil");
    let outcomes: Vec<String> = chats
        .answers(&thread)
        .into_iter()
        .map(|(outcome, _)| outcome)
        .collect();
    assert_eq!(outcomes, ["dismissed", "dismissed", "proposed"]);
    assert_eq!(
        chats.count("SELECT COUNT(*) FROM chat_message WHERE outcome = 'proposed'"),
        1
    );
}

#[test]
fn asking_again_replaces_a_proposal_whole_and_dismisses_nothing_else() {
    let chats = Chats::open("proposal-retry");
    let thread = chats.answer_in_new_thread("what is due?");
    chats.propose(Some(&thread), "complete it");
    // A retry replaces the last turn: the proposal goes with its question.
    chats.run(
        "chat.save_turn",
        json!({
            "thread_id": thread,
            "replace_last": true,
            "turn": {
                "question": { "text": "complete it" },
                "answer": { "outcome": "answered", "text": "Nothing to complete." }
            }
        }),
    );
    assert_eq!(
        chats.answers(&thread),
        vec![
            ("answered".to_owned(), "Rent.".to_owned()),
            ("answered".to_owned(), "Nothing to complete.".to_owned()),
        ]
    );
}

// ---------------------------------------------------------------------------
// 4. The schema's two triggers
// ---------------------------------------------------------------------------

fn raw(chats: &Chats, sql: &str) -> Result<(), String> {
    chats
        .vault()
        .commit(|tx| {
            tx.connection().execute(sql, [])?;
            Ok(())
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[test]
fn the_schema_refuses_what_no_command_asks() {
    let chats = Chats::open("proposal-triggers");
    let proposed = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let answered = chats.answer_in_new_thread("what is due?");

    // A TOLD ANSWER DOES NOT BECOME ANOTHER ONE.
    for to in ["applied", "proposed", "refused"] {
        let error = raw(
            &chats,
            &format!("UPDATE chat_message SET outcome = '{to}' WHERE thread_id = '{answered}' AND role = 'assistant'"),
        )
        .expect_err("an answer does not change");
        assert!(
            error.contains("a told answer does not change") || error.contains("CHECK"),
            "{to}: {error}"
        );
    }
    // A PROPOSAL SETTLES ONLY INTO ONE OF THE FOUR ENDS.
    for to in ["answered", "stopped", "sent"] {
        let error = raw(
            &chats,
            &format!("UPDATE chat_message SET outcome = '{to}' WHERE thread_id = '{proposed}' AND role = 'assistant'"),
        )
        .expect_err("a proposal settles only as one of its ends");
        assert!(
            error.contains("a proposal settles as") || error.contains("CHECK"),
            "{to}: {error}"
        );
    }
    // AN END IS FINAL.
    raw(
        &chats,
        &format!("UPDATE chat_message SET outcome = 'applied' WHERE thread_id = '{proposed}' AND role = 'assistant'"),
    )
    .expect("a proposal settles");
    let error = raw(
        &chats,
        &format!("UPDATE chat_message SET outcome = 'dismissed' WHERE thread_id = '{proposed}' AND role = 'assistant'"),
    )
    .expect_err("an end does not change");
    assert!(error.contains("a told answer does not change"), "{error}");
    // A MESSAGE IS NOT BORN SETTLED.
    for born in ["applied", "dismissed", "stale", "failed"] {
        let error = raw(
            &chats,
            &format!(
                "INSERT INTO chat_message (thread_id, ordinal, role, text, outcome, created_at)
                 VALUES ('{answered}', 40, 'assistant', 'x', '{born}', 'now')"
            ),
        )
        .expect_err("a message is not born settled");
        assert!(error.contains("not born"), "{born}: {error}");
    }
    // AND THE LIST IS CLOSED.
    let error = raw(
        &chats,
        &format!(
            "INSERT INTO chat_message (thread_id, ordinal, role, text, outcome, created_at)
             VALUES ('{answered}', 41, 'assistant', 'x', 'pending', 'now')"
        ),
    )
    .expect_err("an outcome the schema does not list");
    assert!(error.contains("CHECK"), "{error}");
    // A QUESTION IS STILL ONLY `sent`.
    let error = raw(
        &chats,
        &format!(
            "INSERT INTO chat_message (thread_id, ordinal, role, text, outcome, created_at)
             VALUES ('{answered}', 42, 'user', 'x', 'proposed', 'now')"
        ),
    )
    .expect_err("a member does not propose");
    assert!(error.contains("CHECK"), "{error}");
}

// ---------------------------------------------------------------------------
// 5. The journal
// ---------------------------------------------------------------------------

#[test]
fn the_audit_journal_keeps_a_token_and_never_the_settled_line() {
    let chats = Chats::open("proposal-journal");
    let thread = chats.propose(None, "I paid Neha for the taxi")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.run(
        "chat.settle_proposal",
        json!({ "thread_id": thread, "outcome": "failed", "text": "Not done. Neha is not in People." }),
    );
    let journal: String = chats
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT input_json FROM agent_command_invocation
                  WHERE command_id = 'chat.settle_proposal'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the journal reads");
    assert!(journal.contains("sealed:blake3:"), "{journal}");
    assert!(!journal.contains("Neha"), "{journal}");
    assert!(
        journal.contains("failed"),
        "the outcome is not a secret: {journal}"
    );
}

// ---------------------------------------------------------------------------
// 6. Rung twelve over a chat that already has rows
// ---------------------------------------------------------------------------

/// Everything the three tables hold, one line a row, in key order.
fn dump(connection: &rusqlite::Connection) -> Vec<String> {
    let mut out = Vec::new();
    for sql in [
        "SELECT 'm|' || thread_id || '|' || ordinal || '|' || role || '|' || text || '|' || outcome
                || '|' || COALESCE(refusal, '-') || '|' || COALESCE(notice, '-')
                || '|' || COALESCE(record_json, '-') || '|' || created_at
           FROM chat_message ORDER BY thread_id, ordinal",
        "SELECT 'c|' || thread_id || '|' || message_ordinal || '|' || position || '|' || app
                || '|' || entity || '|' || row_id || '|' || qualifier || '|' || title
                || '|' || subtitle || '|' || meta
           FROM chat_message_card ORDER BY thread_id, message_ordinal, position",
        "SELECT 'a|' || thread_id || '|' || message_ordinal || '|' || position || '|' || kind
                || '|' || label || '|' || COALESCE(asset_id, '-') || '|' || COALESCE(document_id, '-')
                || '|' || COALESCE(thumb_content_id, '-')
           FROM chat_message_attachment ORDER BY thread_id, message_ordinal, position",
    ] {
        let mut statement = connection.prepare(sql).expect("the dump prepares");
        out.extend(
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("the dump runs")
                .map(|row| row.expect("a dump row")),
        );
    }
    out
}

fn chat_schema(connection: &rusqlite::Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE sql IS NOT NULL
                AND (name LIKE 'chat\\_%' ESCAPE '\\' OR name LIKE 'idx\\_chat\\_%' ESCAPE '\\')
              ORDER BY name",
        )
        .expect("the schema prepares");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the schema reads")
        .map(|row| row.expect("a schema row"))
        .collect()
}

#[test]
fn a_vault_at_rung_eleven_climbs_rung_twelve_keeping_every_message_card_and_attachment() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("vault.db");
    let vault = Vault::create(&path).expect("a vault");
    vault.found("Test", "Test Owner").unwrap();
    vault.close().expect("closes");

    // WIND THE FILE BACK TO RUNG ELEVEN with a chat of its own: two threads, every kind of message
    // rung eleven could hold, cards, and attachments of the three kinds. Written with foreign keys
    // on, as the vault writes.
    let before = {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        common::undo_rung_twelve(&raw);
        raw.execute_batch(
            "BEGIN;
             INSERT INTO chat_thread (thread_id, title, scope_app, created_at)
               VALUES ('t-1', 'what is due?', NULL, '2026-10-01T09:00:00.000Z'),
                      ('t-2', 'show my photos', 'photos', '2026-10-02T09:00:00.000Z');
             INSERT INTO chat_message
               (thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at)
             VALUES
               ('t-1', 0, 'user', 'what is due?', 'sent', NULL, NULL, NULL, '2026-10-01T09:00:00.000Z'),
               ('t-1', 1, 'assistant', 'Rent.', 'answered', NULL, 'doc_truncated',
                '{\"user\":\"q\"}', '2026-10-01T09:00:01.000Z'),
               ('t-1', 2, 'user', 'and my lease?', 'sent', NULL, NULL, NULL, '2026-10-01T09:01:00.000Z'),
               ('t-1', 3, 'assistant', '', 'refused', 'attachment_unreadable', NULL, NULL,
                '2026-10-01T09:01:01.000Z'),
               ('t-2', 0, 'user', 'show my photos', 'sent', NULL, NULL, NULL, '2026-10-02T09:00:00.000Z'),
               ('t-2', 1, 'assistant', 'You have thr', 'stopped', NULL, NULL, NULL,
                '2026-10-02T09:00:01.000Z');
             INSERT INTO chat_message_card
               (thread_id, message_ordinal, position, app, entity, row_id, qualifier, title, subtitle, meta)
             VALUES
               ('t-1', 1, 0, 'tasks', 'task', 'task-1', '', 'Pay rent', '2026-10-01', 'due'),
               ('t-1', 1, 1, 'notes', 'note', 'note-9', 'q', 'Lease', '', ''),
               ('t-2', 1, 0, 'photos', 'photo', 'asset-3', '', 'Sunset', '', '');
             INSERT INTO chat_message_attachment
               (thread_id, message_ordinal, position, kind, label, asset_id, document_id, thumb_content_id)
             VALUES
               ('t-1', 2, 0, 'document', 'Lease.pdf', NULL, NULL, NULL),
               ('t-1', 2, 1, 'photo', 'IMG_0001', NULL, NULL, NULL),
               ('t-2', 0, 0, 'image', 'camera roll', NULL, NULL, NULL);
             PRAGMA user_version = 11;
             COMMIT;",
        )
        .expect("the rung-eleven chat is written");
        dump(&raw)
    };
    assert_eq!(before.len(), 6 + 3 + 3, "the fixture holds what it says");

    // THE REAL PATH: `Vault::open` sees rung eleven, snapshots, and climbs.
    let migrated = Vault::open(&path).expect("the file climbs rung twelve");
    assert_eq!(migrated.schema_version(), centraid_vault::head_version());
    assert_eq!(migrated.schema_version(), 12);
    let (after, orphans, schema) = migrated
        .read(|connection| {
            let orphans: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_check",
                [],
                |row| row.get(0),
            )?;
            Ok((dump(connection), orphans, chat_schema(connection)))
        })
        .unwrap();
    assert_eq!(
        after, before,
        "every message, card and attachment came through"
    );
    assert_eq!(orphans, 0, "and nothing points at a row that is not there");

    // THE REBUILT OBJECTS ARE THE LADDER HEAD'S OWN: the same text a vault founded today gets.
    let founded = common::Scratch::empty("rung-twelve-founded").unwrap();
    let head = founded
        .vault
        .read(|connection| Ok(chat_schema(connection)))
        .unwrap();
    assert_eq!(schema, head);
    assert!(
        head.iter()
            .any(|(name, sql)| name == "chat_message" && sql.contains("'proposed'")),
        "and it is the widened list"
    );
    for guard in [
        "chat_message_is_not_born_settled",
        "chat_message_outcome_settles_once",
    ] {
        assert!(head.iter().any(|(name, _)| name == guard), "{guard}");
    }

    // THE FOREIGN KEYS STILL CASCADE FROM THE THREAD: deleting t-1 takes its messages, cards and
    // attachments and leaves t-2's whole.
    migrated
        .commit(|tx| {
            tx.connection()
                .execute("DELETE FROM chat_thread WHERE thread_id = 't-1'", [])?;
            Ok(())
        })
        .unwrap();
    let left = migrated.read(|connection| Ok(dump(connection))).unwrap();
    assert!(left.iter().all(|line| line.contains("|t-2|")), "{left:?}");
    assert_eq!(
        left.len(),
        2 + 1 + 1,
        "t-2's two messages, card and attachment"
    );

    // AND THE NEW LIFE WORKS ON THE CLIMBED FILE: a proposal is saved and settled.
    let registry = Registry::with_system_commands().unwrap();
    registry.install(&migrated).unwrap();
    let saved = migrated
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "chat.save_turn",
                json!({ "thread_id": "t-2", "turn": {
                    "question": { "text": "star it" },
                    "answer": { "outcome": "proposed", "text": "Proposed: star it." }
                }}),
            ),
        )
        .unwrap();
    assert_eq!(saved.status, CommandStatus::Executed, "{:?}", saved.reason);
    let settled = migrated
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "chat.settle_proposal",
                json!({ "thread_id": "t-2", "outcome": "applied", "text": "Done." }),
            ),
        )
        .unwrap();
    assert_eq!(
        settled.status,
        CommandStatus::Executed,
        "{:?}",
        settled.reason
    );
}

#[test]
fn a_vault_below_rung_eleven_climbs_through_twelve_with_the_widened_list() {
    // The older climbs drop the chat and let rung eleven make it; rung twelve then rebuilds an
    // empty table. The result is the ladder head's chat, and a proposal can be saved into it.
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
    let migrated = Vault::open(&path).expect("the file climbs rungs eleven and twelve");
    assert_eq!(migrated.schema_version(), 12);
    let registry = Registry::with_system_commands().unwrap();
    registry.install(&migrated).unwrap();
    let saved = migrated
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "chat.save_turn",
                json!({ "turn": {
                    "question": { "text": "after the climb" },
                    "answer": { "outcome": "proposed", "text": "Proposed: x." }
                }}),
            ),
        )
        .unwrap();
    assert_eq!(saved.status, CommandStatus::Executed, "{:?}", saved.reason);
}
