//! The chat's search, through `Handle::call` — the door a shell uses (#1097,
//! R-1097-22, R-1097-24): Home carries chat threads as hits, and the drawer's
//! `chat.threads` takes a `term`.

use super::super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};

const NOW: &str = "2099-06-02T02:00:00.000Z";

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Scratch {
    fn founded() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
        let handle = Core::open(CoreConfig::new(dir.join("vault.db")).with_clock(
            std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                centraid_vault::clock::FixedClock::at(now),
            ))),
        ))
        .expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Chats", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn ask(&self, query: wire::app_query_request::Query) -> wire::app_query_response::Answer {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(query),
                })),
            })
            .expect("an app query answers")
        {
            wire::Response {
                kind: Some(wire::response::Kind::AppQuery(answer)),
            } => answer.answer.expect("an app query is answered"),
            other => panic!("an app query answered as {other:?}"),
        }
    }

    fn drawer(&self, term: &str, limit: u32) -> wire::ChatThreads {
        match self.ask(wire::app_query_request::Query::ChatThreads(
            wire::ChatThreadsRequest {
                limit,
                term: term.to_owned(),
            },
        )) {
            wire::app_query_response::Answer::ChatThreads(found) => found,
            other => panic!("chat.threads answered as {other:?}"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.writes.set(self.writes.get() + 1);
        let outcome = self
            .handle
            .command(
                name,
                &input,
                &format!("chat-search-test-{}", self.writes.get()),
            )
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        assert_eq!(
            outcome.status,
            centraid_vault::CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    /// One turn, with an answer and a card the index must not read.
    fn turn(&self, thread: Option<&str>, question: &str, answer: &str) -> String {
        let mut input = serde_json::json!({ "turn": {
            "question": { "text": question },
            "answer": {
                "outcome": "answered",
                "text": answer,
                "cards": [{ "entity_id": "note:n-1" }]
            }
        }});
        if let Some(thread) = thread {
            input["thread_id"] = serde_json::json!(thread);
        }
        self.run("thread.save_turn", input)["thread_id"]
            .as_str()
            .expect("a turn names its thread")
            .to_owned()
    }
}

fn ids(found: &wire::ChatThreads) -> Vec<&str> {
    found
        .threads
        .iter()
        .map(|thread| thread.thread_id.as_str())
        .collect()
}

/// THE DRAWER'S SEARCH (R-1097-24): `chat.threads` with a term answers the
/// threads it finds, best match first, as the rows the list has; a typo is
/// corrected only when the exact words found nothing and `corrected` says so; a
/// blank term is the plain list.
#[test]
fn the_drawer_searches_threads_and_says_what_it_corrected() {
    let scratch = Scratch::founded();
    // The thread that SAID the word is made first, so the vault's own order
    // (oldest first) and the door's rank (title first) disagree.
    let said = scratch.turn(None, "Plan the weekend", "Ok.");
    scratch.turn(Some(&said), "buy marmalade", "Ok.");
    let titled = scratch.turn(None, "marmalade for the weekend", "Ok.");
    let other = scratch.turn(None, "When is the dentist?", "Tuesday.");

    // A title outranks the same word said; both are found; the dentist is not.
    let found = scratch.drawer("marmalade", 0);
    assert_eq!(ids(&found), [titled.as_str(), said.as_str()]);
    assert!(found.corrected.is_empty());
    // The rows are the list's, with the dates the drawer draws "ago" from.
    assert!(found.threads.iter().all(|thread| thread.updated_ms > 0
        && !thread.title.is_empty()
        && !thread.updated_at.is_empty()));

    // A typo: the exact words found nothing; the correction found the thread.
    let slipped = scratch.drawer("dentsit", 0);
    assert_eq!(ids(&slipped), [other.as_str()]);
    assert_eq!(slipped.corrected, "dentist");

    // Nothing: no rows, no correction, and no error.
    let nothing = scratch.drawer("zeppelin", 0);
    assert!(nothing.threads.is_empty() && nothing.corrected.is_empty());
    // A term that is all punctuation is an answer with no rows.
    assert!(scratch.drawer("?!", 0).threads.is_empty());

    // What the assistant said and a card said are found by nothing.
    for planted in ["Tuesday", "cardzed"] {
        assert!(scratch.drawer(planted, 0).threads.is_empty(), "{planted}");
    }

    // The window: at most `limit` rows.
    assert_eq!(scratch.drawer("marmalade", 1).threads.len(), 1);

    // A BLANK TERM IS THE PLAIN LIST, every chat, with no correction. (The
    // vault clock is stopped, so the three chats tie on activity and their order
    // is the list's own business.)
    let all = scratch.drawer("   ", 0);
    let mut listed = ids(&all);
    listed.sort_unstable();
    let mut made = [titled.as_str(), said.as_str(), other.as_str()];
    made.sort_unstable();
    assert_eq!(listed, made);
    assert!(all.corrected.is_empty());

    // A RENAME MOVES THE HIT, and a DELETE drops it.
    scratch.run(
        "entity.retitle",
        serde_json::json!({ "id": other, "title": "Teeth appointment" }),
    );
    assert_eq!(ids(&scratch.drawer("teeth", 0)), [other.as_str()]);
    scratch.run("entity.trash", serde_json::json!({ "id": other }));
    scratch.run("entity.purge", serde_json::json!({ "id": other }));
    assert!(scratch.drawer("teeth", 0).threads.is_empty());
    assert!(scratch.drawer("dentist", 0).threads.is_empty());
}
