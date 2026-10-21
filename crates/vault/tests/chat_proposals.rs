//! A PROPOSAL'S LIFE IS VAULT DATA (#1088): `chat.settle_proposal`, and what
//! `chat.save_turn` does to a card nobody answered.
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
//! 6. **The founded chat carries the widened list, both guards and the cascades.**
//!    `chat_message` is the parent of two child tables, and a delete runs the
//!    children's `ON DELETE CASCADE` from the thread down.
//! 7. **A message that settles or lapses moves its version** (#1129, F-R-1):
//!    `chat_message` is registered mutable, and an edit bumps its `row_version`
//!    while a told answer stays at one.
//! 8. **Rung four is a climb.** A file wound back to rung three, holding a
//!    settled proposal, a card and an attachment, opens at the head with every
//!    row kept at `row_version = 1`, the chat index untouched and every trigger
//!    live.
//!
//! (How a vault written before a proposal had a life was migrated is not proved
//! here: the ladder was squashed into one baseline on 2026-10-15, Q-1029-1, and
//! no vault in the field predates it.)

mod common;

use centraid_vault::access::Principal;
use centraid_vault::clock::{FixedClock, SeededIds};
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
                "SELECT input_json FROM command_invocation
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
// 6. The schema a vault is founded with
// ---------------------------------------------------------------------------

/// Every chat object's DDL, keyed by name.
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
fn the_founded_chat_carries_the_widened_list_both_guards_and_the_cascades() {
    let chats = Chats::open("proposal-schema");
    let schema = chats
        .vault()
        .read(|connection| Ok(chat_schema(connection)))
        .unwrap();
    let sql_of = |name: &str| {
        schema
            .iter()
            .find(|(found, _)| found == name)
            .unwrap_or_else(|| panic!("`{name}` is not in a founded vault"))
            .1
            .as_str()
    };
    // THE LIST IS THE FIVE WORDS OF A PROPOSAL'S LIFE, beside the ones a told answer has.
    let message = sql_of("chat_message");
    for word in [
        "sent",
        "answered",
        "stopped",
        "refused",
        "proposed",
        "applied",
        "dismissed",
        "stale",
        "failed",
    ] {
        assert!(
            message.contains(&format!("'{word}'")),
            "`{word}` is not listed"
        );
    }
    // THE TWO GUARDS ARE THERE.
    for guard in [
        "chat_message_is_not_born_settled",
        "chat_message_outcome_settles_once",
    ] {
        assert!(sql_of(guard).contains("RAISE"), "{guard}");
    }
    // THE FOREIGN KEYS CASCADE FROM THE THREAD: a delete takes the messages, and the messages
    // take their cards and attachments.
    for table in [
        "chat_message",
        "chat_message_card",
        "chat_message_attachment",
    ] {
        assert!(
            sql_of(table).contains("ON DELETE CASCADE"),
            "`{table}` does not cascade"
        );
    }
    let thread = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.run("chat.delete_thread", json!({ "thread_id": thread }));
    for table in [
        "chat_message",
        "chat_message_card",
        "chat_message_attachment",
    ] {
        assert_eq!(
            chats.count(&format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table} outlived its thread"
        );
    }
}

// ---------------------------------------------------------------------------
// 7. A message that settles or lapses moves its version (#1129, F-R-1)
// ---------------------------------------------------------------------------

#[test]
fn a_message_that_settles_or_lapses_moves_its_version_and_a_told_answer_does_not() {
    let chats = Chats::open("proposal-version");
    let version = |thread: &str, outcome: &str| {
        chats.count(&format!(
            "SELECT row_version FROM chat_message WHERE thread_id = '{thread}' AND outcome = '{outcome}'"
        ))
    };
    let settled = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        version(&settled, "proposed"),
        1,
        "a proposal is born at one"
    );
    assert_eq!(
        chats.settle(&settled, "applied", Some("Done.")).status,
        CommandStatus::Executed
    );
    assert_eq!(version(&settled, "applied"), 2, "settling is an edit");
    assert_eq!(version(&settled, "sent"), 1, "the question did not move");

    let lapsed = chats.propose(None, "complete it")["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    chats.answer(&lapsed, "never mind, what is due?");
    assert_eq!(version(&lapsed, "dismissed"), 2, "a lapse is an edit");
    assert_eq!(
        version(&lapsed, "answered"),
        1,
        "a told answer stays at one"
    );
    assert_eq!(
        chats.count("SELECT COUNT(*) FROM chat_message WHERE updated_at < created_at"),
        0,
        "no message is stamped before it was made"
    );
}

// ---------------------------------------------------------------------------
// 8. Rung four is a climb
// ---------------------------------------------------------------------------

#[test]
fn rung_four_is_a_climb_a_file_at_three_reaches_four_with_every_message_kept() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    let registry = Registry::with_system_commands().expect("the registry builds");
    let principal = Principal::owner("phone");
    let run = |vault: &Vault, command: &str, input: Value| -> Value {
        let outcome = vault
            .execute(&registry, &principal, &Command::new(command, input))
            .unwrap_or_else(|error| panic!("`{command}` errored: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?}",
            outcome.reason
        );
        outcome.output
    };
    let propose = |vault: &Vault, question: &str| -> String {
        run(
            vault,
            "chat.save_turn",
            json!({ "turn": {
                "question": { "text": question },
                "answer": {
                    "outcome": "proposed",
                    "text": PROPOSED_LINE,
                    "cards": [{ "app": "tasks", "entity": "task", "id": "t-dry", "title": "Dry cleaning" }]
                }
            }}),
        )["thread_id"]
            .as_str()
            .expect("a thread id")
            .to_owned()
    };
    let (settled, waiting);
    {
        let vault = Vault::create_with(
            &path,
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("chat-climb")),
        )
        .expect("a vault is founded");
        vault.found("Test", "Test Owner").expect("an owner");
        registry.install(&vault).expect("the record installs");
        settled = propose(&vault, "complete the quokka errand");
        run(
            &vault,
            "chat.settle_proposal",
            json!({ "thread_id": settled, "outcome": "applied", "text": "Done." }),
        );
        waiting = propose(&vault, "complete the wombat errand");
    }
    // WIND IT BACK to rung three, then write what the old shape let through: an attachment on the
    // settled thread's question, which the rebuild must carry across with the cards.
    {
        let connection = rusqlite::Connection::open(&path).expect("the file opens");
        common::undo_rung_four(&connection);
        connection
            .execute_batch(&format!(
                "PRAGMA user_version = 3;
                 INSERT INTO chat_message_attachment
                   (thread_id, message_ordinal, position, kind, label)
                 VALUES ('{settled}', 0, 0, 'photo', 'IMG_0001.HEIC');"
            ))
            .expect("the old shape takes a row");
        let columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chat_message')
                  WHERE name IN ('updated_at', 'row_version')",
                [],
                |row| row.get(0),
            )
            .expect("the columns read");
        assert_eq!(columns, 0, "the file really is at rung three's shape");
    }
    assert_eq!(centraid_vault::head_version(), 4);

    let vault = Vault::open(&path).expect("a file at rung three opens and climbs");
    registry.install(&vault).expect("the record installs");
    let count = |sql: &str| -> i64 {
        vault
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    };
    assert_eq!(count("PRAGMA user_version"), 4);
    // EVERY MESSAGE IS KEPT, stamped as of its making, at its first version; the settled one came
    // back settled, because the rows return before the trigger that refuses a born-settled row.
    assert_eq!(count("SELECT COUNT(*) FROM chat_message"), 4);
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM chat_message WHERE updated_at = created_at AND row_version = 1"
        ),
        4
    );
    assert_eq!(
        count(&format!(
            "SELECT COUNT(*) FROM chat_message
              WHERE thread_id = '{settled}' AND outcome = 'applied' AND text = 'Done.'"
        )),
        1
    );
    // THE CHILDREN CAME ACROSS, and the chat index was left as it was.
    assert_eq!(count("SELECT COUNT(*) FROM chat_message_card"), 2);
    assert_eq!(count("SELECT COUNT(*) FROM chat_message_attachment"), 1);
    assert_eq!(
        count("SELECT COUNT(*) FROM fts_chat_thread WHERE fts_chat_thread MATCH 'quokka'"),
        1
    );
    assert_eq!(count("SELECT COUNT(*) FROM pragma_foreign_key_check"), 0);
    // EVERY TRIGGER IS LIVE: the waiting proposal settles and moves its version, a settled one
    // does not settle again, and a thread's delete still cascades through the rebuilt family.
    run(
        &vault,
        "chat.settle_proposal",
        json!({ "thread_id": waiting, "outcome": "dismissed" }),
    );
    assert_eq!(
        count(&format!(
            "SELECT row_version FROM chat_message
              WHERE thread_id = '{waiting}' AND outcome = 'dismissed'"
        )),
        2
    );
    let again = vault.commit(|tx| {
        tx.connection().execute(
            &format!(
                "UPDATE chat_message SET outcome = 'failed'
                  WHERE thread_id = '{settled}' AND outcome = 'applied'"
            ),
            [],
        )?;
        Ok(())
    });
    assert!(again.is_err(), "a settled answer does not settle again");
    run(
        &vault,
        "chat.delete_thread",
        json!({ "thread_id": settled }),
    );
    assert_eq!(count("SELECT COUNT(*) FROM chat_message_attachment"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM chat_message_card"), 1);
    assert_eq!(
        count("SELECT COUNT(*) FROM fts_chat_thread WHERE fts_chat_thread MATCH 'quokka'"),
        0
    );
    drop(vault);
    let _ = std::fs::remove_dir_all(dir);
}
