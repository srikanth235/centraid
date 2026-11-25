//! A conversation in the v0 tables (#1214): a chat is an ordinary trashable entity (L5); a turn is
//! saved in one commit with its cards and attachments; a reason and a notice are lookup rows (A1);
//! a proposal settles once; the routing record is the vault's object with `"v":1` (A3); the
//! assistant's changes are the assistant's in history (B4); an attachment keeps its label when the
//! item it named is purged and a thumbnail is released with its chat. The rules the database holds
//! for these tables are also written as raw SQL in `schema_rules.rs`.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal};
use common::world::{AT, World};
use serde_json::{Value, json};

const PIXEL_A: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const PIXEL_B: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEB";

fn world(seed: &str) -> World {
    World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: Registry::with_system_commands().expect("a registry"),
    }
}

fn answered(text: &str) -> Value {
    json!({ "outcome": "answered", "text": text })
}

fn card(app: &str, entity: &str, id: &str) -> Value {
    json!({ "app": app, "entity": entity, "id": id, "title": "Rent", "meta": "open" })
}

fn turn_input(thread: Option<&str>, question: &str, answer: Value) -> Value {
    let mut input = json!({ "turn": { "question": { "text": question }, "answer": answer } });
    if let Some(thread) = thread {
        input["thread_id"] = json!(thread);
    }
    input
}

fn turn(w: &World, thread: Option<&str>, question: &str, answer: Value) -> Value {
    w.ok("thread.save_turn", turn_input(thread, question, answer))
}

fn chat(w: &World, question: &str) -> String {
    turn(w, None, question, answered("ok"))["thread_id"]
        .as_str()
        .expect("a thread")
        .to_owned()
}

/// Whether a word finds the chat in the search index.
fn finds(w: &World, word: &str, thread: &str) -> bool {
    w.one::<i64>(
        "SELECT count(*) FROM search s JOIN entity e ON e.n = s.rowid
          WHERE search MATCH ?1 AND e.id = ?2",
        &[&format!("\"{word}\""), thread],
    ) > 0
}

fn count(w: &World, sql: &str, params: &[&str]) -> i64 {
    w.one(sql, params)
}

fn listed(w: &World) -> Vec<String> {
    w.vault()
        .chat_threads(50)
        .expect("a list")
        .into_iter()
        .map(|row| row.thread_id)
        .collect()
}

fn on_disk(w: &World, hash: &str) -> bool {
    w.vault()
        .blobs()
        .expect("a store")
        .has(hash)
        .expect("asks")
}

fn hashes(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("`released` is a list of hashes")
        .iter()
        .map(|hash| hash.as_str().expect("a hash").to_owned())
        .collect()
}

fn plan(w: &World, sql: &str) -> String {
    w.vault()
        .read(|c| {
            let mut statement = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join(" | "))
        })
        .expect("a plan")
}

// ---------------------------------------------------------------------------------------------
// 1. Threads: create, rename, trash, restore, Delete forever; newest first
// ---------------------------------------------------------------------------------------------

#[test]
fn a_turn_is_one_commit_with_its_cards_and_attachments() {
    let w = world("chat_turn");
    let saved = w.ok(
        "thread.save_turn",
        json!({
          "scope_app": "calendar",
          "turn": {
            "question": { "text": "what   is due\ntoday?", "attachments": [
              { "form": "image", "label": "receipt", "thumbnail_data_uri": PIXEL_A }] },
            "answer": { "outcome": "answered", "text": "Rent.", "record_json": "{\"read\":1}",
                        "cards": [card("reminders", "task", "t1")] }
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
    // The chat is an entity of its own kind, with its scope on its kind row, and no home.
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM entity WHERE id = ?1 AND kind = 'thread' AND parent_id IS NULL",
            &[thread]
        ),
        1
    );
    assert_eq!(
        w.one::<String>("SELECT scope FROM thread WHERE id = ?1", &[thread]),
        "calendar"
    );
    // The thumbnail is rented from the blob plane; the card is a snapshot in the answer's own row.
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM message_attachment WHERE thread_id = ?1 AND thumb IS NOT NULL",
            &[thread]
        ),
        1
    );
    let cards: Value = serde_json::from_str(&w.one::<String>(
        "SELECT cards FROM message WHERE thread_id = ?1 AND ordinal = 1",
        &[thread],
    ))
    .unwrap();
    assert_eq!(cards[0]["app"], "reminders");
    assert_eq!(cards[0]["id"], "t1");
    // The reader gives it back whole.
    let stored = w.vault().chat_thread(thread).unwrap().expect("a thread");
    assert_eq!(stored.messages.len(), 2);
    assert_eq!(stored.messages[1].cards[0].row_id, "t1");
    assert_eq!(stored.messages[0].attachments[0].form, "image");
    assert!(stored.messages[0].attachments[0].thumbnail_path.is_some());
    assert_eq!(stored.thread.scope_app.as_deref(), Some("calendar"));
}

#[test]
fn threads_list_newest_activity_first_and_the_list_walks_an_index() {
    let w = world("chat_order");
    let a = chat(&w, "alpha");
    let b = chat(&w, "beta");
    assert_eq!(listed(&w), [b.clone(), a.clone()]);
    turn(&w, Some(&a), "more", answered("m"));
    assert_eq!(listed(&w), [a, b]);
    // The list reads live chats from the (kind, live, newest) index and sorts nothing.
    let sql = centraid_vault::chat::THREAD_LIST_SQL.replace("?1", "10");
    let plan = plan(&w, &sql);
    assert!(plan.contains("entity_by_updated"), "{plan}");
    assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    assert!(!plan.contains("SCAN"), "{plan}");
}

#[test]
fn a_chat_is_renamed_trashed_restored_and_deleted_forever_like_every_kind() {
    let w = world("chat_trash");
    let keep = chat(&w, "keep this");
    let thread = turn(
        &w,
        None,
        "invoices from the plumber",
        answered("zanzibar"),
    )["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Renamed by the one verb: no door of its own, and never to nothing.
    w.ok(
        "entity.retitle",
        json!({ "id": thread, "title": "  Home repairs " }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&thread]),
        "Home repairs"
    );
    assert!(
        w.refused("entity.retitle", json!({ "id": thread, "title": "  " }))
            .contains("needs a name")
    );
    assert!(finds(&w, "repairs", &thread));
    assert_eq!(listed(&w).len(), 2);

    // Trashed: out of every list, out of search, out of the reader, and nothing is saved into it.
    w.ok("entity.trash", json!({ "id": thread }));
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM entity WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_at IS NOT NULL",
            &[&thread]
        ),
        1,
        "the trash stamps a chat like every kind"
    );
    assert_eq!(listed(&w), [keep.clone()]);
    assert!(w.vault().chat_thread(&thread).unwrap().is_none());
    assert!(
        w.vault()
            .chat_thread_rows(&[thread.clone(), keep.clone()])
            .unwrap()
            .iter()
            .all(|row| row.thread_id == keep)
    );
    assert!(!finds(&w, "repairs", &thread), "a trashed chat is not found by its title");
    assert!(!finds(&w, "plumber", &thread), "nor by what was asked");
    assert!(
        w.refused("thread.save_turn", turn_input(Some(&thread), "more", answered("a")))
            .contains("in the trash")
    );
    assert!(
        w.refused(
            "thread.settle_proposal",
            json!({ "thread_id": thread, "outcome": "applied" })
        )
        .contains("in the trash")
    );

    // Restored: back in the list and in search, as it was.
    w.ok("entity.restore", json!({ "id": thread }));
    assert_eq!(listed(&w).len(), 2);
    assert!(finds(&w, "repairs", &thread) && finds(&w, "plumber", &thread));
    assert_eq!(
        w.vault().chat_thread(&thread).unwrap().unwrap().messages.len(),
        2
    );

    // Delete forever is the shared purge: a live chat goes to the trash first, then it is gone
    // with every message, attachment and word.
    assert!(
        w.refused("entity.purge", json!({ "id": thread }))
            .contains("not in the trash")
    );
    w.ok("entity.trash", json!({ "id": thread }));
    w.ok("entity.purge", json!({ "id": thread }));
    for (table, column) in [
        ("entity", "id"),
        ("thread", "id"),
        ("message", "thread_id"),
        ("message_attachment", "thread_id"),
    ] {
        assert_eq!(
            count(
                &w,
                &format!("SELECT count(*) FROM {table} WHERE {column} = ?1"),
                &[&thread]
            ),
            0,
            "{table}"
        );
    }
    assert!(!finds(&w, "plumber", &thread));
    assert_eq!(listed(&w), [keep]);
}

#[test]
fn clear_deletes_every_chat_live_or_trashed() {
    let w = world("chat_clear");
    let trashed = chat(&w, "one");
    chat(&w, "two");
    w.ok("entity.trash", json!({ "id": trashed }));
    assert_eq!(w.ok("thread.clear", json!({}))["deleted"], 2);
    assert_eq!(count(&w, "SELECT count(*) FROM thread", &[]), 0);
    assert_eq!(count(&w, "SELECT count(*) FROM message", &[]), 0);
    assert_eq!(count(&w, "SELECT count(*) FROM entity WHERE kind = 'thread'", &[]), 0);
}

#[test]
fn a_chat_is_titled_by_words_and_the_kind_says_it_needs_one() {
    let w = world("chat_title");
    assert_eq!(
        w.one::<i64>("SELECT may_be_unnamed FROM entity_kind WHERE code = 'thread'", &[]),
        0
    );
    assert!(
        w.refused("thread.save_turn", turn_input(None, "  \n ", answered("a")))
            .contains("titled by a question with words")
    );
    assert_eq!(count(&w, "SELECT count(*) FROM entity WHERE kind = 'thread'", &[]), 0);
}

// ---------------------------------------------------------------------------------------------
// A chat is not a link end, not a `[[title]]` target and takes no tag
// ---------------------------------------------------------------------------------------------

#[test]
fn a_chat_is_no_link_end_no_title_target_and_takes_no_tag() {
    let w = world("chat_linkable");
    let thread = chat(&w, "Weekend plans");
    assert_eq!(
        w.one::<i64>("SELECT linkable FROM entity_kind WHERE code = 'thread'", &[]),
        0
    );
    let note = w.ok("note.create", json!({ "title": "N", "body": "see [[Weekend plans]]" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.one::<i64>(
            "SELECT count(*) FROM mention WHERE note_id = ?1 AND to_id IS NOT NULL",
            &[&note]
        ),
        0,
        "a chat's title is no `[[title]]` target"
    );
    assert_eq!(
        w.refused("tag.add", json!({ "id": thread, "label": "x" })),
        "a thread does not take a tag"
    );
    // A hand-made link names a chat at neither end.
    for (from, to) in [(&note, &thread), (&thread, &note)] {
        let sentence = w.refused("link.add", json!({ "from": from, "to": to }));
        assert!(!sentence.is_empty(), "{sentence}");
    }
    assert_eq!(count(&w, "SELECT count(*) FROM link", &[]), 0);
}

// ---------------------------------------------------------------------------------------------
// 2. Messages: order, outcomes, seeded reasons and notices
// ---------------------------------------------------------------------------------------------

#[test]
fn messages_are_appended_in_order_and_each_outcome_is_kept() {
    let w = world("chat_messages");
    let thread = chat(&w, "first");
    turn(&w, Some(&thread), "second", json!({ "outcome": "stopped", "text": "par" }));
    turn(
        &w,
        Some(&thread),
        "third",
        json!({ "outcome": "refused", "refusal": "no_tool_fits", "text": "" }),
    );
    turn(&w, Some(&thread), "fourth", json!({ "outcome": "proposed", "text": "Mark it done?" }));
    let rows = w
        .vault()
        .read(|c| {
            Ok(c.prepare(
                "SELECT ordinal, role, outcome FROM message WHERE thread_id = ?1 ORDER BY ordinal",
            )?
            .query_map([&thread], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    let outcomes: Vec<&str> = rows.iter().map(|(_, _, outcome)| outcome.as_str()).collect();
    assert_eq!(
        outcomes,
        ["sent", "answered", "sent", "stopped", "sent", "refused", "sent", "proposed"]
    );
    assert!(rows.iter().enumerate().all(|(i, (ordinal, role, _))| {
        *ordinal == i64::try_from(i).unwrap() && role == if i % 2 == 0 { "user" } else { "assistant" }
    }));
    // The reader gives them in the same order.
    let stored = w.vault().chat_thread(&thread).unwrap().unwrap();
    assert_eq!(
        stored.messages.iter().map(|m| m.ordinal).collect::<Vec<_>>(),
        (0..8).collect::<Vec<_>>()
    );
    assert_eq!(stored.messages[5].refusal.as_deref(), Some("no_tool_fits"));
}

#[test]
fn a_refusal_names_a_seeded_reason_and_a_notice_a_seeded_notice() {
    let w = world("chat_lookups");
    let reasons = w.strings("SELECT code FROM message_refusal ORDER BY code", &[]);
    assert_eq!(reasons.len(), 9, "{reasons:?}");
    for reason in &reasons {
        turn(
            &w,
            None,
            "q",
            json!({ "outcome": "refused", "refusal": reason }),
        );
    }
    assert_eq!(
        count(&w, "SELECT count(DISTINCT refusal) FROM message WHERE outcome = 'refused'", &[]),
        9
    );
    // A reason no row of the lookup names is refused in a sentence that does not quote it, and so
    // is a refused turn with no reason and a reason on a turn that was not refused.
    let sentence = w.refused(
        "thread.save_turn",
        turn_input(None, "q", json!({ "outcome": "refused", "refusal": "zebra_secret" })),
    );
    assert!(sentence.contains("not a reason"), "{sentence}");
    assert!(!sentence.contains("zebra_secret"), "{sentence}");
    assert!(
        w.refused(
            "thread.save_turn",
            turn_input(None, "q", json!({ "outcome": "refused" }))
        )
        .contains("names its reason")
    );
    assert!(
        w.refused(
            "thread.save_turn",
            turn_input(None, "q", json!({ "outcome": "answered", "refusal": "no_tool_fits" }))
        )
        .contains("names its reason")
    );
    // A notice likewise.
    let notice = w.strings("SELECT code FROM message_notice", &[]);
    assert_eq!(notice, ["doc_truncated"]);
    let thread = turn(
        &w,
        None,
        "q",
        json!({ "outcome": "answered", "text": "a", "notice": "doc_truncated" }),
    )["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.vault().chat_thread(&thread).unwrap().unwrap().messages[1].notice.as_deref(),
        Some("doc_truncated")
    );
    let sentence = w.refused(
        "thread.save_turn",
        turn_input(None, "q", json!({ "outcome": "answered", "notice": "zebra_secret" })),
    );
    assert!(sentence.contains("not a notice"), "{sentence}");
    assert!(!sentence.contains("zebra_secret"), "{sentence}");
    // The reasons are rows a migration writes: nothing else adds one, so the command's list is the
    // table's and never a copy of it.
    assert!(
        w.vault()
            .commit(|tx| {
                tx.connection()
                    .execute("INSERT INTO message_refusal (code) VALUES ('brand_new')", [])?;
                Ok(())
            })
            .is_err()
    );
}

#[test]
fn a_refusal_never_quotes_what_was_said() {
    let w = world("chat_sealed");
    let thread = chat(&w, "my secret question");
    // A settled line past its bound fails the schema, whose message quotes the value that failed.
    let long = format!("a secret name {}", "x".repeat(20_100));
    let sentence = w.refused(
        "thread.settle_proposal",
        json!({ "thread_id": thread, "outcome": "applied", "text": long }),
    );
    assert!(!sentence.contains("secret name"), "{sentence}");
    assert!(sentence.contains("‹sealed›"), "{sentence}");
    assert_eq!(count(&w, "SELECT count(*) FROM action_key", &[]), 0);
}

#[test]
fn a_retry_replaces_the_last_turn_and_only_that_one() {
    let w = world("chat_retry");
    let thread = chat(&w, "first");
    turn(&w, Some(&thread), "second", answered("two"));
    let mut again = json!({ "thread_id": thread, "replace_last": true,
        "turn": { "question": { "text": "second" }, "answer": answered("two, again") } });
    again["turn"]["question"]["attachments"] =
        json!([{ "form": "image", "label": "x", "thumbnail_data_uri": PIXEL_A }]);
    w.ok("thread.save_turn", again);
    assert_eq!(
        count(&w, "SELECT count(*) FROM message WHERE thread_id = ?1", &[&thread]),
        4
    );
    assert_eq!(
        w.one::<String>(
            "SELECT text FROM message WHERE thread_id = ?1 AND ordinal = 3",
            &[&thread]
        ),
        "two, again"
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
    let w = world("chat_roster");
    let attempt = |scope: Value, app: &str| {
        let mut input = json!({ "turn": { "question": { "text": "q" },
            "answer": { "outcome": "answered", "text": "a", "cards": [card(app, "task", "t")] } } });
        input["scope_app"] = scope;
        w.run("thread.save_turn", input).status
    };
    assert_eq!(attempt(json!(null), "reminders"), CommandStatus::Executed);
    // There is no `tasks` app: the tasks are Reminders'.
    assert_ne!(attempt(json!(null), "tasks"), CommandStatus::Executed);
    assert_eq!(attempt(json!(null), "locker"), CommandStatus::Executed);
    assert_eq!(attempt(json!(null), "health"), CommandStatus::Executed);
    assert_eq!(attempt(json!("health"), "notes"), CommandStatus::Executed);
    assert_ne!(attempt(json!(null), "weather"), CommandStatus::Executed);
    assert_ne!(attempt(json!("tasks"), "notes"), CommandStatus::Executed);
    assert_eq!(attempt(json!("locker"), "notes"), CommandStatus::Executed);
    assert_eq!(attempt(json!("photos"), "notes"), CommandStatus::Executed);
}

/// ONE APP IS ONE WORD (#1128, principle 6 of the model): no app word is in the vault's DDL. A
/// thread's `scope` is a bare column the `thread.save_turn` command holds to the roster, never a
/// CHECK.
#[test]
fn the_ddl_holds_no_app_word_and_a_threads_scope_is_a_bare_column() {
    let ddl_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/schema/vault-ddl.sql");
    let ddl = std::fs::read_to_string(ddl_path).expect("the vault DDL");
    let thread = ddl
        .split("CREATE TABLE thread (")
        .nth(1)
        .and_then(|rest| rest.split(") STRICT;").next())
        .expect("the thread table");
    assert!(thread.contains("scope TEXT,") && !thread.contains("CHECK"));
    // `health` is also the word of a phone store a followed origin names; `calendar` of a
    // container kind and of a phone store. Neither is the app there.
    let outside_stores: String = ddl
        .lines()
        .filter(|line| {
            !line.contains("system IN (")
                && !line.contains("'area','calendar'")
                && !line.contains("AS ('calendar')")
                && !line.starts_with("INSERT INTO")
                && !line.trim_start().starts_with("('")
                && !line.trim_start().starts_with("--")
        })
        .collect::<Vec<_>>()
        .join("\n");
    for app in centraid_vault::roster::APPS {
        assert!(
            !outside_stores.contains(&format!("'{}'", app.id)),
            "{}",
            app.id
        );
    }
}

// ---------------------------------------------------------------------------------------------
// 3. Proposals
// ---------------------------------------------------------------------------------------------

#[test]
fn a_proposal_settles_once_as_each_of_its_four_outcomes() {
    let w = world("chat_settle");
    let proposed = json!({ "outcome": "proposed", "text": "Mark it done?" });
    for outcome in ["applied", "dismissed", "stale", "failed"] {
        let saved = turn(&w, None, "finish the rent", proposed.clone());
        let thread = saved["thread_id"].as_str().unwrap();
        assert!(w.vault().chat_proposal_waiting(thread).unwrap());
        let settled = w.ok(
            "thread.settle_proposal",
            json!({ "thread_id": thread, "outcome": outcome, "text": "The line it was told." }),
        );
        assert_eq!(settled["settled"], true, "{outcome}");
        assert!(!w.vault().chat_proposal_waiting(thread).unwrap());
        let last = w.vault().chat_thread(thread).unwrap().unwrap().messages.pop().unwrap();
        assert_eq!((last.outcome.as_str(), last.text.as_str()), (outcome, "The line it was told."));
        // A tap delivered twice settles once.
        assert_eq!(
            w.ok(
                "thread.settle_proposal",
                json!({ "thread_id": thread, "outcome": outcome })
            )["settled"],
            false
        );
        // A settled proposal does not settle another way.
        let other = if outcome == "applied" { "failed" } else { "applied" };
        assert!(
            w.refused(
                "thread.settle_proposal",
                json!({ "thread_id": thread, "outcome": other })
            )
            .contains("Nothing is waiting")
        );
    }
}

#[test]
fn a_new_turn_dismisses_the_proposal_waiting_and_only_the_last_can_wait() {
    let w = world("chat_dismiss");
    let proposed = json!({ "outcome": "proposed", "text": "Mark it done?" });
    let thread = turn(&w, None, "finish the rent", proposed.clone())["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    turn(&w, Some(&thread), "again", proposed);
    turn(&w, Some(&thread), "never mind", answered("ok"));
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM message WHERE thread_id = ?1 AND outcome = 'dismissed'",
            &[&thread]
        ),
        2
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM message WHERE thread_id = ?1 AND outcome = 'proposed'",
            &[&thread]
        ),
        0
    );
    // The database holds the lifecycle even against a writer that bypasses the command.
    let bypass = w.vault().commit(|tx| {
        tx.connection().execute(
            "UPDATE message SET outcome = 'proposed' WHERE thread_id = ?1 AND outcome = 'dismissed'",
            [&thread],
        )?;
        Ok(())
    });
    assert!(bypass.is_err());
}

#[test]
fn the_record_is_the_vaults_object_with_its_version_and_cards_are_a_plain_array() {
    let w = world("chat_record");
    let saved = w.ok(
        "thread.save_turn",
        turn_input(
            None,
            "q",
            json!({ "outcome": "answered", "text": "a", "record_json": "{\"read\":[\"tasks\"]}",
                    "cards": [card("reminders", "task", "t1")] }),
        ),
    );
    let thread = saved["thread_id"].as_str().unwrap();
    let record: Value = serde_json::from_str(&w.one::<String>(
        "SELECT record FROM message WHERE thread_id = ?1 AND ordinal = 1",
        &[thread],
    ))
    .unwrap();
    assert_eq!(record["v"], 1, "the vault stamps its version");
    assert_eq!(record["read"], json!(["tasks"]), "and keeps the assistant's words");
    // The user's own message has none; a card carries none and the list is an array.
    assert_eq!(
        count(&w, "SELECT count(*) FROM message WHERE thread_id = ?1 AND record IS NOT NULL", &[thread]),
        1
    );
    assert_eq!(
        w.one::<String>("SELECT json_type(cards) FROM message WHERE thread_id = ?1 AND ordinal = 1", &[thread]),
        "array"
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM message, json_each(message.cards) c
              WHERE thread_id = ?1 AND json_extract(c.value, '$.v') IS NOT NULL",
            &[thread]
        ),
        0
    );
    // The reader hands the record back, version and all.
    let history = w.vault().chat_history(thread, 5).unwrap();
    let handed: Value = serde_json::from_str(history[0].record_json.as_deref().unwrap()).unwrap();
    assert_eq!(handed["v"], 1);
    // A record that is not an object, or of another version, is refused without quoting it.
    for bad in ["[1]", "\"x\"", "not json", "{\"v\":2}", "{\"v\":\"1\"}"] {
        let sentence = w.refused(
            "thread.save_turn",
            turn_input(None, "q", json!({ "outcome": "answered", "record_json": bad })),
        );
        assert!(sentence.contains("JSON object of this vault's version"), "{bad}: {sentence}");
    }
    // A record already at the vault's version is taken.
    turn(&w, None, "q", json!({ "outcome": "answered", "record_json": "{\"v\":1,\"a\":2}" }));
}

// ---------------------------------------------------------------------------------------------
// 4. Attachments
// ---------------------------------------------------------------------------------------------

/// A document row the way its lane will write it: an entity, its bytes and the words read from them.
fn document(w: &World, title: &str, media_type: &str, text: &str) -> String {
    let id = w.bare(Kind::Document, title, None);
    let hash = format!("{:0>64}", format!("{:x}", id.len() + title.len() + text.len()));
    w.commit(|tx| {
        let c = tx.connection();
        c.execute("INSERT OR IGNORE INTO blob (hash, size) VALUES (?1, 10)", [&hash])?;
        c.execute(
            "INSERT INTO document (id, blob, media_type) VALUES (?1, ?2, ?3)",
            [&id, &hash, media_type],
        )?;
        c.execute(
            "INSERT OR IGNORE INTO derivative (blob, variant, text, created_at) VALUES (?1, 'text', ?2, ?3)",
            [&hash, text, AT],
        )?;
        Ok(())
    });
    id
}

#[test]
fn an_attachment_is_a_photo_a_document_or_an_image_and_names_only_its_own() {
    let w = world("chat_forms");
    let photo = w.bare(Kind::Photo, "", None);
    let doc = w.bare(Kind::Document, "Notes", None);
    let saved = w.ok(
        "thread.save_turn",
        json!({ "turn": { "question": { "text": "all three", "attachments": [
            { "form": "photo", "label": "Beach", "entity_id": photo },
            { "form": "document", "label": "Notes", "entity_id": doc }] },
            "answer": answered("ok") } }),
    );
    let thread = saved["thread_id"].as_str().unwrap();
    let saved = w.ok(
        "thread.save_turn",
        json!({ "thread_id": thread, "turn": { "question": { "text": "an image", "attachments": [
            { "form": "image", "label": "receipt", "thumbnail_data_uri": PIXEL_A }] },
            "answer": answered("ok") } }),
    );
    assert_eq!(saved["user_ordinal"], 2);
    let forms = w.strings(
        "SELECT form || ':' || (entity_id IS NOT NULL) || ':' || (thumb IS NOT NULL)
           FROM message_attachment WHERE thread_id = ?1 ORDER BY ordinal, position",
        &[thread],
    );
    assert_eq!(forms, ["photo:1:0", "document:1:0", "image:0:1"]);
    // The thumbnail is a rented blob: a row, a file, and a renter.
    let thumb: String = w.one("SELECT thumb FROM message_attachment WHERE form = 'image'", &[]);
    assert!(on_disk(&w, &thumb));
    assert_eq!(count(&w, "SELECT count(*) FROM blob WHERE hash = ?1", &[&thumb]), 1);

    let attach = |attachment: Value| {
        w.refused(
            "thread.save_turn",
            json!({ "turn": { "question": { "text": "q", "attachments": [attachment] },
                    "answer": answered("a") } }),
        )
    };
    // A photo's id is not a document and the reverse; each names only its own.
    assert!(attach(json!({ "form": "photo", "label": "n", "entity_id": doc })).contains("not a photo"));
    assert!(attach(json!({ "form": "document", "label": "n", "entity_id": photo })).contains("not a document"));
    for bad in [
        json!({ "form": "image", "label": "n" }),
        json!({ "form": "image", "label": "n", "entity_id": photo, "thumbnail_data_uri": PIXEL_A }),
        json!({ "form": "photo", "label": "n" }),
        json!({ "form": "photo", "label": "n", "entity_id": photo, "thumbnail_data_uri": PIXEL_A }),
        json!({ "form": "image", "label": "n", "thumbnail_data_uri": "data:text/plain;base64,AAAA" }),
    ] {
        assert!(attach(bad.clone()).contains("An attachment") || attach(bad.clone()).contains("data URI"), "{bad}");
    }
}

#[test]
fn an_attached_item_purged_leaves_the_label_and_a_trashed_one_reads_as_lost() {
    let w = world("chat_label");
    let doc = document(&w, "Notes", "text/plain", "some words");
    let saved = w.ok(
        "thread.save_turn",
        json!({ "turn": { "question": { "text": "read it", "attachments": [
            { "form": "document", "label": "Notes", "entity_id": doc }] },
            "answer": answered("ok") } }),
    );
    let thread = saved["thread_id"].as_str().unwrap();
    let stored = w.vault().chat_thread(thread).unwrap().unwrap();
    assert_eq!(stored.messages[0].attachments[0].entity_id.as_deref(), Some(doc.as_str()));
    // The chat may read the document it was handed.
    assert!(matches!(
        w.vault().attachment_document(&doc).unwrap(),
        centraid_vault::chat::DocumentSource::Text { .. }
    ));
    assert_eq!(w.vault().attachable_documents(10).unwrap().len(), 1);
    // Trashed, it reads as lost and the row still names it; purged, the engine sets the pointer to
    // NULL and the label stays.
    w.ok("entity.trash", json!({ "id": doc }));
    let stored = w.vault().chat_thread(thread).unwrap().unwrap();
    assert_eq!(stored.messages[0].attachments[0].entity_id, None);
    assert_eq!(
        count(&w, "SELECT count(*) FROM message_attachment WHERE entity_id = ?1", &[&doc]),
        1
    );
    assert!(matches!(
        w.vault().attachment_document(&doc).unwrap(),
        centraid_vault::chat::DocumentSource::Missing
    ));
    w.ok("entity.purge", json!({ "id": doc }));
    assert_eq!(
        w.one::<String>("SELECT label FROM message_attachment WHERE thread_id = ?1", &[thread]),
        "Notes"
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM message_attachment WHERE thread_id = ?1 AND entity_id IS NULL",
            &[thread]
        ),
        1
    );
    assert_eq!(count(&w, "SELECT count(*) FROM thread WHERE id = ?1", &[thread]), 1);
}

#[test]
fn a_thumbnail_is_kept_while_its_chat_lives_and_released_when_it_is_purged() {
    let w = world("chat_thumb");
    let saved = w.ok(
        "thread.save_turn",
        json!({ "turn": { "question": { "text": "keep this", "attachments": [
            { "form": "image", "label": "pic", "thumbnail_data_uri": PIXEL_A }] },
            "answer": answered("kept") } }),
    );
    let thread = saved["thread_id"].as_str().unwrap().to_owned();
    let thumb: String = w.one("SELECT thumb FROM message_attachment", &[]);
    assert!(on_disk(&w, &thumb));
    // Nothing collects what a chat rents, whether the chat is live or in the trash.
    assert!(hashes(&w.ok("blob.collect", json!({}))["released"]).is_empty());
    w.ok("entity.trash", json!({ "id": thread }));
    assert!(hashes(&w.ok("blob.collect", json!({}))["released"]).is_empty());
    assert!(on_disk(&w, &thumb), "a chat in the trash keeps its thumbnail");
    w.ok("entity.restore", json!({ "id": thread }));
    assert!(on_disk(&w, &thumb));
    assert_eq!(count(&w, "SELECT count(*) FROM blob", &[]), 1);
    // Purged, it goes: the row, the file, and the answer says which.
    w.ok("entity.trash", json!({ "id": thread }));
    let purged = w.ok("entity.purge", json!({ "id": thread }));
    assert_eq!(hashes(&purged["released"]), vec![thumb.clone()]);
    assert!(!on_disk(&w, &thumb));
    assert_eq!(count(&w, "SELECT count(*) FROM blob", &[]), 0);
}

#[test]
fn a_regenerated_turn_releases_the_thumbnail_it_replaced_as_hashes() {
    let w = world("chat_regenerate");
    let with = |thumb: &str| {
        json!({ "turn": { "question": { "text": "q", "attachments": [
            { "form": "image", "label": "pic", "thumbnail_data_uri": thumb }] },
            "answer": answered("a") } })
    };
    let saved = w.ok("thread.save_turn", with(PIXEL_A));
    let thread = saved["thread_id"].as_str().unwrap().to_owned();
    let old: String = w.one("SELECT thumb FROM message_attachment", &[]);
    let mut again = with(PIXEL_B);
    again["thread_id"] = json!(thread);
    again["replace_last"] = json!(true);
    let saved = w.ok("thread.save_turn", again);
    assert_eq!(hashes(&saved["released"]), vec![old.clone()]);
    assert!(!on_disk(&w, &old), "the replaced turn's thumbnail file went");
    let kept: String = w.one("SELECT thumb FROM message_attachment", &[]);
    assert!(on_disk(&w, &kept), "the new one is kept");
}

#[test]
fn thread_clear_releases_every_thumbnail_it_drops() {
    let w = world("chat_clear_thumbs");
    w.ok(
        "thread.save_turn",
        json!({ "turn": { "question": { "text": "q", "attachments": [
            { "form": "image", "label": "pic", "thumbnail_data_uri": PIXEL_A }] },
            "answer": answered("a") } }),
    );
    let thumb: String = w.one("SELECT thumb FROM message_attachment", &[]);
    let cleared = w.ok("thread.clear", json!({}));
    assert_eq!(hashes(&cleared["released"]), vec![thumb.clone()]);
    assert!(!on_disk(&w, &thumb));
}

// ---------------------------------------------------------------------------------------------
// 5. The assistant's changes are the assistant's in history
// ---------------------------------------------------------------------------------------------

#[test]
fn a_change_the_assistant_makes_is_the_assistants_in_history() {
    let w = world("chat_actor");
    let note = w.ok("note.create", json!({ "title": "One", "body": "b" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let retitle = |title: &str, by_assistant: bool| {
        w.scratch.clock.advance_ms(1_000);
        let mut command = Command::new("entity.retitle", json!({ "id": note, "title": title }));
        if by_assistant {
            // The chat's door says who acts; the command's name and input never do.
            command = command.by("assist");
        }
        let outcome = w
            .vault()
            .execute(&w.registry, &Principal::owner("phone"), &command)
            .expect("runs");
        assert_eq!(outcome.status, CommandStatus::Executed, "{:?}", outcome.reason);
    };
    retitle("Two", false);
    retitle("Three", true);
    retitle("Four", false);
    let actors = w.strings(
        "SELECT actor FROM revision WHERE entity_id = ?1 ORDER BY seq",
        &[&note],
    );
    assert_eq!(
        actors.iter().filter(|actor| *actor == "assistant").count(),
        1,
        "{actors:?}"
    );
    assert_eq!(actors.last().map(String::as_str), Some("member"), "{actors:?}");
    // `cause` is a diagnostic: nothing reads whose change it was from a prefix of it.
    assert_eq!(
        count(&w, "SELECT count(*) FROM revision WHERE cause LIKE 'assist%'", &[]),
        0
    );
}

// ---------------------------------------------------------------------------------------------
// 6. Search
// ---------------------------------------------------------------------------------------------

#[test]
fn search_finds_a_chat_by_its_title_and_the_members_words_never_the_assistants() {
    let w = world("chat_search");
    let thread = chat(&w, "invoices from the plumber");
    assert!(finds(&w, "plumber", &thread));
    let thread = turn(&w, None, "second chat", answered("zanzibar"))["thread_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        !finds(&w, "zanzibar", &thread),
        "the assistant's words are not indexed (R-1097-22)"
    );
    // A later turn is found, and a rename moves the hit.
    turn(&w, Some(&thread), "and the electrician", answered("ok"));
    assert!(finds(&w, "electrician", &thread));
    w.ok("entity.retitle", json!({ "id": thread, "title": "Home repairs" }));
    assert!(finds(&w, "repairs", &thread));
    // A chat in the trash is found by nothing; purged, by nothing either.
    w.ok("entity.trash", json!({ "id": thread }));
    for word in ["repairs", "electrician", "second"] {
        assert!(!finds(&w, word, &thread), "{word}");
    }
    w.ok("entity.purge", json!({ "id": thread }));
    assert_eq!(
        count(&w, "SELECT count(*) FROM search WHERE search MATCH '\"electrician\"'", &[]),
        0
    );
}

#[test]
fn a_card_is_live_while_its_row_is_and_an_unknown_word_is_not_evidence_of_a_hole() {
    let w = world("chat_cards");
    let note = w.ok("note.create", json!({ "title": "N", "body": "b" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let vault = w.vault();
    assert!(vault.chat_card_row_exists("notes", "note", &note).unwrap());
    assert!(!vault.chat_card_row_exists("notes", "task", &note).unwrap(), "a note is no task");
    assert!(!vault.chat_card_row_exists("weather", "note", &note).unwrap());
    // A card an older build stored as `agenda` is read as the app of its kind.
    let task = w.bare(Kind::Task, "T", None);
    assert!(vault.chat_card_row_exists("agenda", "task", &task).unwrap());
    assert!(vault.chat_card_row_exists("reminders", "task", &task).unwrap());
    assert!(
        !vault
            .chat_card_row_exists("locker", "locker_item", "no-such-item")
            .unwrap(),
        "a Locker card is live only while its item is"
    );
    assert!(vault.chat_card_row_exists("notes", "somethingnew", "x").unwrap());
    w.ok("entity.trash", json!({ "id": note }));
    assert!(!vault.chat_card_row_exists("notes", "note", &note).unwrap());
}
