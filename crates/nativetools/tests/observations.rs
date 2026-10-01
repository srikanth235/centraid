//! GOLDEN OBSERVATIONS (SPEC §5): the exact text the model sees, and
//! compaction (§6.4) with its addressability rule (§3).

mod common;

use common::{call, seeded, text};
use serde_json::json;

const CARD: &str = "[task: date (due), status, effort, priority, completed, description]";

#[test]
fn the_observations_read_exactly_as_specified() {
    let world = seeded();
    let mut session = world.session();
    let prompt = session.prompt();
    // Eight containers are pre-numbered before anything else is shown.
    assert_eq!(prompt["directory"], json!([1, 2, 3, 4, 5, 6, 7, 8]));
    assert!(prompt["system"].as_str().unwrap().contains(
        "vault directory:\ngroups: Flat 4B (#1), Tahoe Trip (#2)\nalbums: Wedding (#3), Summer (#4)\nnotebooks: Ideas (#5), Recipes (#6)\nfolders: Taxes (#7)\nlists: Home (#8)"
    ));
    session.user("what's due next week?");
    assert_eq!(
        text(
            &mut session,
            "find",
            json!({"kind": "task", "when": {"unit": "week", "rel": 1}})
        ),
        format!(
            "@1 · 2 tasks (showing 2)   {CARD} · when: 2026-09-28..2026-10-04\n\
             #9 [1] task \"Pay rent\" · Thu 2026-10-01 (next Thursday) · status open · priority 2\n\
             #10 [2] task \"Book the cabin\" · Fri 2026-10-02 09:00 (next Friday) · status open · effort 30 min"
        )
    );
    assert_eq!(
        text(
            &mut session,
            "find",
            json!({"kind": "task", "name": "tabla"})
        ),
        "0 tasks called \"tabla\". Other kinds called \"tabla\": #11 event \"Tabla class with Benedikt\""
    );
    assert_eq!(
        text(
            &mut session,
            "find",
            json!({"kind": "task", "name": "library"})
        ),
        "no live task called \"library\"; trashed: #12 task \"Library books\" · trashed"
    );
    assert_eq!(
        text(
            &mut session,
            "find",
            json!({"kind": "event", "linked_to": "#4"})
        ),
        "events are not linked to albums. No event mentions \"Summer\". event links: person."
    );
    assert_eq!(
        text(
            &mut session,
            "act",
            json!({"verb": "star", "kind": "person", "name": "Neha"})
        ),
        "ambiguous: \"Neha\" fits #13 person \"Neha Rao\", #14 person \"Neha Kulkarni\"; nothing was done."
    );
    session.user("how much is owed on debts?");
    assert_eq!(
        text(
            &mut session,
            "compute",
            json!({"op": "sum", "field": "amount", "kind": "debt"})
        ),
        "@2 = 37.50 USD (sum of amount over 2 debts)"
    );
    assert_eq!(
        text(&mut session, "answer", json!({"value": "@2"})),
        "answered: @2"
    );
    session.user("");
    // A compacted row keeps its session-stable number and is still addressable.
    assert!(
        !text(&mut session, "open", json!({"row": "#10"})).starts_with("error")
    );
    assert_eq!(
        text(
            &mut session,
            "find",
            json!({"within": "@1", "name": "cabin"})
        ),
        format!(
            "@3 · 1 task (showing 1)   {CARD}\n\
             #10 [1] task \"Book the cabin\" · Fri 2026-10-02 09:00 (next Friday) · status open · effort 30 min"
        )
    );
    assert_eq!(
        text(
            &mut session,
            "act",
            json!({"verb": "complete", "rows": "#10"})
        ),
        "completed: #10 task \"Book the cabin\" · status open → completed · completed none → Sun 2026-09-27 09:00"
    );
    session.user("");
    assert_eq!(
        text(
            &mut session,
            "act",
            json!({"verb": "complete", "rows": "#10"})
        ),
        "already: #10 task \"Book the cabin\" is completed (Sun 2026-09-27 09:00)"
    );
    assert_eq!(
        text(&mut session, "open", json!({"row": "#10"})),
        "#10 task \"Book the cabin\" · Fri 2026-10-02 09:00 (next Friday) · status completed · effort 30 min · completed Sun 2026-09-27 09:00\n\
         created 2026-01-05\nsubtasks (0)\npeople (0)\nlist (1): #8 \"Home\""
    );
    assert_eq!(
        text(&mut session, "search", json!({"text": "beach"})),
        "@4 · search \"beach\": 1 photo (showing 1)\n\
         #15 [1] photo \"Beach day\" · Wed 2026-07-01 10:00 · starred · links: person #13 \"Neha Rao\", album #4 \"Summer\""
    );
}

#[test]
fn compaction_keeps_the_header_and_the_rows_later_calls_referenced() {
    let world = seeded();
    let mut session = world.session_with(
        common::TODAY,
        centraid_nativetools::Flags {
            directory: false,
            preground: false,
            ..Default::default()
        },
    );
    session.user("tasks");
    call(&mut session, "find", json!({"kind": "task"}));
    // `#2` is the second shown row; the later call references it.
    call(&mut session, "open", json!({"row": "#2"}));
    // The previous turn stays whole; only the turn before it compacts.
    let next = session.user("next");
    assert_eq!(next["compacted"], json!([]), "{next}");
    let next = session.user("and then");
    let compacted = next["compacted"].as_array().unwrap();
    let first = compacted[0]["text"].as_str().unwrap();
    assert!(
        first.starts_with("@1 · 5 tasks (compacted; #2 kept)\n#2 [2] task "),
        "{first}"
    );
    assert_eq!(first.lines().count(), 2);
    // A kept row is addressable, and so is a dropped one: numbers are session-stable.
    assert!(!text(&mut session, "open", json!({"row": "#2"})).starts_with("error"));
    assert!(!text(&mut session, "open", json!({"row": "#3"})).starts_with("error"));
    let reach = call(
        &mut session,
        "find",
        json!({"within": "@1", "where": "status = completed"}),
    );
    assert_eq!(reach["effect"]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        text(&mut session, "open", json!({"row": "#99"})),
        "error: #99 was never shown."
    );
    assert!(
        text(&mut session, "find", json!({"within": "@9"}))
            .starts_with("error: @9 was never issued")
    );
}
