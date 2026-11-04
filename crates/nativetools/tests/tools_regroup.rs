//! The eight tools (#1166): `find` (selector, `text`, `rows`), `compute`, `create`, `edit`, `do`,
//! `answer`, `ask`, `decline`; and the names S2 was trained on, which still run.

mod common;

use centraid_nativetools::meta;
use centraid_nativetools::prompt::{self, ToolsMode};
use common::{call, ids, number, seeded, text};
use serde_json::json;

fn names(tools: &[serde_json::Value]) -> Vec<String> {
    tools
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_prompt_carries_the_eight_tools_and_s2_its_own() {
    let eight = [
        "find", "compute", "create", "edit", "do", "answer", "ask", "decline",
    ];
    assert_eq!(meta::TOOLS, eight);
    for mode in [ToolsMode::Sig, ToolsMode::Compact, ToolsMode::Full] {
        assert_eq!(names(&prompt::tools_for(mode)), eight, "{}", mode.name());
    }
    assert_eq!(
        names(&prompt::tools_for(ToolsMode::S2)),
        [
            "search", "find", "open", "compute", "act", "answer", "ask", "decline"
        ]
    );
    // `do` offers every verb but the two that are tools
    let do_tool = &prompt::tools()[4]["function"]["parameters"]["properties"]["verb"]["enum"];
    let verbs: Vec<&str> = do_tool
        .as_array()
        .unwrap()
        .iter()
        .map(|verb| verb.as_str().unwrap())
        .collect();
    assert!(!verbs.contains(&"create") && !verbs.contains(&"edit"));
    for verb in [
        "complete",
        "reschedule",
        "add_to",
        "tag",
        "log",
        "reveal",
        "undo",
    ] {
        assert!(verbs.contains(&verb), "{verb}");
    }
}

#[test]
fn find_searches_by_text_and_opens_a_row_by_rows() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let found = call(&mut session, "find", json!({"text": "Benedikt"}));
    assert!(
        found["text"].as_str().unwrap().contains("Benedikt"),
        "{found}"
    );
    let row = number(&mut session, "task", "cabin");
    let opened = call(&mut session, "find", json!({"rows": row}));
    assert!(
        opened["text"].as_str().unwrap().contains("cabin"),
        "{opened}"
    );
    // a list opens nothing, and text with rows is no search
    let many = text(
        &mut session,
        "find",
        json!({"rows": [row.clone(), row.clone()]}),
    );
    assert!(many.contains("exactly one row"), "{many}");
    let both = text(&mut session, "find", json!({"text": "cabin", "rows": row}));
    assert!(both.contains("text or rows, not both"), "{both}");
    let stray = text(&mut session, "find", json!({"text": "cabin", "name": "x"}));
    assert!(stray.contains("takes no name"), "{stray}");
}

#[test]
fn create_edit_and_do_are_the_verbs_of_their_name() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let created = call(
        &mut session,
        "create",
        json!({"kind": "task", "args": "name: Call plumber"}),
    );
    assert_eq!(created["effect"]["verb"], "create", "{created}");
    session.user("");
    let row = number(&mut session, "task", "Call plumber");
    let edited = call(
        &mut session,
        "edit",
        json!({"rows": row, "args": "effort: 20"}),
    );
    assert_eq!(edited["effect"]["verb"], "edit", "{edited}");
    session.user("");
    let row = number(&mut session, "task", "Call plumber");
    let done = call(&mut session, "do", json!({"verb": "complete", "rows": row}));
    assert_eq!(done["effect"]["verb"], "complete", "{done}");
}

#[test]
fn create_and_edit_take_no_verb_and_do_takes_neither() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let verb = text(
        &mut session,
        "create",
        json!({"verb": "create", "kind": "task", "args": "name: x"}),
    );
    assert!(verb.contains("create has no parameter \"verb\""), "{verb}");
    let row = number(&mut session, "task", "cabin");
    let wrong = text(&mut session, "do", json!({"verb": "edit", "rows": row}));
    assert!(wrong.contains("edit is a tool of its own"), "{wrong}");
    let wrong = text(&mut session, "do", json!({"verb": "create", "rows": row}));
    assert!(wrong.contains("create is a tool of its own"), "{wrong}");
}

#[test]
fn do_takes_at_most_one_argument() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let row = number(&mut session, "task", "cabin");
    let two = text(
        &mut session,
        "do",
        json!({"verb": "reschedule", "rows": row, "args": "to: {\"unit\":\"day\",\"rel\":1}\nname: x"}),
    );
    assert!(two.contains("do takes at most one argument"), "{two}");
}

#[test]
fn compute_averages_and_groups_by_period() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let avg = call(
        &mut session,
        "compute",
        json!({"op": "avg", "field": "effort", "kind": "task", "where": "status = open"}),
    );
    // open tasks sum to 50 effort over the fixture's open tasks with an effort
    assert!(
        avg["effect"]["value"]["values"][0]["amount"].is_number(),
        "{avg}"
    );
    session.user("");
    let by_month = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "group": "month"}),
    );
    let groups = by_month["effect"]["value"]["groups"].as_array().unwrap();
    assert!(!groups.is_empty(), "{by_month}");
    assert!(
        groups
            .iter()
            .all(|group| group["key"] == "none" || group["key"].as_str().unwrap().len() == 7),
        "{by_month}"
    );
    session.user("");
    let bad = text(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "folder", "group": "month"}),
    );
    assert!(bad.starts_with("error:"), "{bad}");
}

#[test]
fn the_names_s2_wrote_run_as_the_tools_they_became() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let searched = call(&mut session, "search", json!({"text": "Benedikt"}));
    assert!(
        searched["text"].as_str().unwrap().contains("Benedikt"),
        "{searched}"
    );
    let row = number(&mut session, "task", "cabin");
    let opened = call(&mut session, "open", json!({"row": row}));
    assert!(
        opened["text"].as_str().unwrap().contains("cabin"),
        "{opened}"
    );
    session.user("");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: Old way"}),
    );
    assert_eq!(created["effect"]["verb"], "create", "{created}");
    session.user("");
    let row = number(&mut session, "task", "Old way");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": row}),
    );
    assert_eq!(done["effect"]["verb"], "complete", "{done}");
    // the old `answer` of a count still ends the turn
    session.user("");
    let count = call(
        &mut session,
        "answer",
        json!({"op": "count", "kind": "task", "where": "status = open"}),
    );
    assert_eq!(count["ends_turn"], true, "{count}");
    let _ = ids(&count["effect"]["rows"]);
}

#[test]
fn compile_names_the_tool_of_the_verb() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let compiled = |session: &mut centraid_nativetools::Session, slots: serde_json::Value| {
        session.compile(&slots)["call"]["tool"].clone()
    };
    let create = json!({"intent": "write", "verb": "create", "kind": "task",
                        "set": [{"key": "name", "value": "Pay"}]});
    assert_eq!(compiled(&mut session, create), "create");
    let edit = json!({"intent": "write", "verb": "edit", "kind": "task", "name": "cabin",
                      "set": [{"key": "effort", "value": "5"}]});
    assert_eq!(compiled(&mut session, edit), "edit");
    let other = json!({"intent": "write", "verb": "complete", "kind": "task", "name": "cabin"});
    assert_eq!(compiled(&mut session, other), "do");
    let search = json!({"intent": "read", "via": "search", "text": "cabin"});
    assert_eq!(compiled(&mut session, search), "find");
    let verbless = session.compile(&json!({"intent": "write", "kind": "task"}));
    assert_eq!(verbless["refused"]["slot"], "verb");
}
