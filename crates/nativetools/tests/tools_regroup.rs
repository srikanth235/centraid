//! The eight tools (#1166): `find` (selector, `text`, `rows`), `compute`, `create`, `edit`, `do`,
//! `answer`, `ask`, `decline`; and the names S2 was trained on, which still run.

mod common;

use centraid_nativetools::meta;
use centraid_nativetools::prompt::{self, ToolsMode};
use centraid_nativetools::think::{TraceMode, compile_think, compile_think_for};
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
    let mut session = world.strict_session();
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
    let mut session = world.strict_session();
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
    let mut session = world.strict_session();
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
    let mut session = world.strict_session();
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
    let mut session = world.strict_session();
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
    // even in a session that takes the eight tools as they are stated
    let world = seeded();
    let mut session = world.strict_session();
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
}

#[test]
fn compile_names_the_tool_of_the_verb() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("");
    let compiled = |session: &mut centraid_nativetools::Session, slots: serde_json::Value| {
        session.compile(&slots)["call"]["tool"].clone()
    };
    let create = json!({"intent": "write", "verb": "create", "kind": "task",
                        "set": [{"key": "name", "value": "Pay"}]});
    assert_eq!(compiled(&mut session, create), "create");
    let cabin = number(&mut session, "task", "cabin");
    let edit = json!({"intent": "write", "verb": "edit", "rows": cabin,
                      "set": [{"key": "effort", "value": "5"}]});
    assert_eq!(compiled(&mut session, edit), "edit");
    let other = json!({"intent": "write", "verb": "complete", "rows": cabin});
    assert_eq!(compiled(&mut session, other), "do");
    // a write by name is a `find` first: the compile step refuses the selector, naming it
    let by_name = session
        .compile(&json!({"intent": "write", "verb": "complete", "kind": "task", "name": "cabin"}));
    assert_eq!(by_name["refused"]["slot"], "kind", "{by_name}");
    let read = json!({"intent": "read", "kind": "task", "where": [{"field": "status", "op": "=", "value": "open"}]});
    assert_eq!(compiled(&mut session, read), "find");
    let count = json!({"intent": "count", "op": "count", "kind": "task"});
    assert_eq!(compiled(&mut session, count), "compute");
    let search = json!({"intent": "read", "via": "search", "text": "cabin"});
    assert_eq!(compiled(&mut session, search), "find");
    let verbless = session.compile(&json!({"intent": "write", "kind": "task"}));
    assert_eq!(verbless["refused"]["slot"], "verb");
}

#[test]
fn a_selector_or_an_op_on_answer_edit_and_do_is_a_step_missing() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("");
    let selector = text(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "status = open"}),
    );
    assert!(
        selector.starts_with(
            "error: answer has no parameter \"kind\". answer takes rows or value=@n; find first"
        ),
        "{selector}"
    );
    let op = text(
        &mut session,
        "answer",
        json!({"op": "count", "kind": "task"}),
    );
    assert!(
        op.contains("Compute first (compute op=…), then answer value=@n"),
        "{op}"
    );
    let edit = text(
        &mut session,
        "edit",
        json!({"name": "cabin", "args": "effort: 5"}),
    );
    assert!(edit.contains("edit takes rows; find them first"), "{edit}");
    let done = text(
        &mut session,
        "do",
        json!({"verb": "complete", "kind": "task", "name": "cabin"}),
    );
    assert!(done.contains("do takes rows; find them first"), "{done}");
    // S2 keeps its shapes: in its mode, and by any name only it writes
    let mut s2 = world.session();
    s2.user("");
    let counted = call(
        &mut s2,
        "answer",
        json!({"op": "count", "kind": "task", "where": "status = open"}),
    );
    assert_eq!(counted["ends_turn"], true, "{counted}");
    let mut named = world.strict_session();
    named.user("");
    let counted = call(
        &mut named,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "cabin"}),
    );
    assert_eq!(counted["effect"]["verb"], "complete", "{counted}");
}

#[test]
fn a_read_is_a_find_then_an_answer_on_its_rows() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("what is open");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = open"}),
    );
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    let answered = call(&mut session, "answer", json!({"rows": handle}));
    assert_eq!(answered["ends_turn"], true, "{answered}");
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]).len(),
        ids(&found["effect"]["rows"]).len()
    );
}

#[test]
fn a_count_is_a_compute_then_an_answer_on_its_value() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("how many are open");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "where": "status = open"}),
    );
    assert_eq!(counted["ends_turn"], false, "{counted}");
    let handle = counted["effect"]["result"].as_str().unwrap().to_owned();
    let answered = call(&mut session, "answer", json!({"value": handle}));
    assert_eq!(answered["ends_turn"], true, "{answered}");
    assert_eq!(
        answered["effect"]["value"]["values"][0]["amount"], 4,
        "{answered}"
    );
}

#[test]
fn compare_sets_two_values_side_by_side() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("open against done");
    let open = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "where": "status = open"}),
    );
    let done = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "where": "status = completed"}),
    );
    let (a, b) = (
        open["effect"]["result"].as_str().unwrap().to_owned(),
        done["effect"]["result"].as_str().unwrap().to_owned(),
    );
    let compared = call(
        &mut session,
        "compute",
        json!({"op": "compare", "rows": format!("{a}, {b}")}),
    );
    assert_eq!(
        compared["effect"]["value"]["values"],
        json!([{"amount": 3, "unit": null}]),
        "{compared}"
    );
    assert!(
        compared["text"].as_str().unwrap().contains("+3"),
        "{compared}"
    );
    // the difference is a value like any other
    let handle = compared["effect"]["result"].as_str().unwrap().to_owned();
    let answered = call(&mut session, "answer", json!({"value": handle}));
    assert_eq!(answered["ends_turn"], true, "{answered}");
    // two values, plain ones, of one kind of figure
    session.user("again");
    let one = text(&mut session, "compute", json!({"op": "compare", "rows": a}));
    assert!(one.contains("exactly two values"), "{one}");
    let rows = number(&mut session, "task", "cabin");
    let not_values = text(
        &mut session,
        "compute",
        json!({"op": "compare", "rows": format!("{a}, {rows}")}),
    );
    assert!(not_values.starts_with("error:"), "{not_values}");
    let extra = text(
        &mut session,
        "compute",
        json!({"op": "compare", "rows": format!("{a}, {b}"), "kind": "task"}),
    );
    assert!(extra.contains("nothing else"), "{extra}");
}

#[test]
fn a_think_compiles_to_the_shape_of_the_tools_it_was_trained_on() {
    let tools = |think: &str, mode| {
        (
            compile_think_for(think, None, mode, ToolsMode::Sig).map(|call| call.tool),
            compile_think(think, None, mode).map(|call| call.tool),
        )
    };
    // a read that names no rows is the `find`; with rows, the `answer`
    let (new, s2) = tools(
        "intent: read\nkind: task\nwhere: status = open",
        TraceMode::V4,
    );
    assert_eq!(
        (new.unwrap().as_str(), s2.unwrap().as_str()),
        ("find", "answer")
    );
    let (new, s2) = tools("intent: read\nrows: @1", TraceMode::V4);
    assert_eq!(
        (new.unwrap().as_str(), s2.unwrap().as_str()),
        ("answer", "answer")
    );
    // a count is a `compute`, and the `answer` that ends on its value
    let (new, s2) = tools("intent: count\nkind: task\nop: count", TraceMode::V4);
    assert_eq!(
        (new.unwrap().as_str(), s2.unwrap().as_str()),
        ("compute", "answer")
    );
    let (new, _) = tools("intent: count\nvalue: @1", TraceMode::V4);
    assert_eq!(new.unwrap(), "answer");
    // a selector on `answer`, `edit` or `do` is refused naming what to do first
    let refused = compile_think_for(
        "intent: read\nvia: find\nkind: task\nname: Pay rent",
        None,
        TraceMode::V4,
        ToolsMode::Sig,
    );
    assert!(refused.is_ok(), "a find keeps its selector: {refused:?}");
    let by_name = compile_think_for(
        "intent: write\nverb: complete\nname: Pay rent",
        None,
        TraceMode::V4,
        ToolsMode::Sig,
    );
    assert!(
        by_name.unwrap_err().message.contains("do takes rows"),
        "a write names its rows"
    );
    assert!(
        compile_think(
            "intent: write\nverb: complete\nname: Pay rent",
            None,
            TraceMode::V4
        )
        .is_ok()
    );
}

// ---- what the selector's move from `answer` and `do` to `find` must not lose ----

#[test]
fn a_find_that_matches_nothing_is_a_result_the_turn_ends_on() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("what is due in 2031");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"date": "2031-01-04"}}),
    );
    let handle = found["effect"]["result"]
        .as_str()
        .expect("an empty result has a handle");
    assert_eq!(found["ends_turn"], false, "{found}");
    let answered = call(&mut session, "answer", json!({"rows": handle}));
    assert_eq!(answered["ends_turn"], true, "{answered}");
    assert_eq!(
        answered["effect"]["answer"]["rows"],
        json!([]),
        "{answered}"
    );
    assert!(
        answered["text"]
            .as_str()
            .unwrap()
            .starts_with("answered: 0 tasks match"),
        "{answered}"
    );
    // S2's empty find has no handle, as before
    let mut s2 = world.session();
    s2.user("what is due in 2031");
    let found = call(
        &mut s2,
        "find",
        json!({"kind": "task", "when": {"date": "2031-01-04"}}),
    );
    assert!(found["effect"].get("result").is_none(), "{found}");
}

#[test]
fn a_write_on_the_several_rows_of_a_find_by_name_asks_which_one() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("delete the benedikt thing");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task,event", "name": "Benedikt"}),
    );
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    assert!(ids(&found["effect"]["rows"]).len() > 1, "{found}");
    let cancelled = call(
        &mut session,
        "do",
        json!({"verb": "delete", "rows": handle}),
    );
    assert_eq!(cancelled["ends_turn"], true, "{cancelled}");
    assert_eq!(cancelled["effect"]["tool"], "ask", "{cancelled}");
    assert!(cancelled["effect"].get("diff").is_none(), "{cancelled}");
    // a message that says every row takes them all, as a selector's did
    let mut every = world.strict_session();
    every.user("delete all the benedikt things");
    let found = call(
        &mut every,
        "find",
        json!({"kind": "task,event", "name": "Benedikt"}),
    );
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    let cancelled = call(&mut every, "do", json!({"verb": "delete", "rows": handle}));
    assert!(cancelled["effect"].get("diff").is_some(), "{cancelled}");
}

#[test]
fn a_find_of_a_container_reads_the_active_rows() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("what's left on the home list");
    let home = number(&mut session, "list", "Home");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "linked_to": home}),
    );
    let text = found["text"].as_str().unwrap();
    assert!(text.contains("active rows"), "{text}");
    assert!(!text.contains("status completed"), "{text}");
}

#[test]
fn a_by_name_write_is_a_find_step_in_the_trace() {
    // the lookup step states the selector and the intent it prepares; the verb slot is not read
    let call = compile_think_for(
        "intent: write\nverb: complete\nvia: find\nkind: task\nname: Pay rent",
        None,
        TraceMode::V4,
        ToolsMode::Sig,
    );
    // `via` comes before `verb` in the slot order
    assert!(call.is_err(), "{call:?}");
    let call = compile_think_for(
        "intent: write\nvia: find\nkind: task\nname: Pay rent",
        None,
        TraceMode::V4,
        ToolsMode::Sig,
    )
    .unwrap();
    assert_eq!(call.tool, "find");
    assert_eq!(
        call.args,
        [
            ("kind".to_owned(), "task".to_owned()),
            ("name".to_owned(), "Pay rent".to_owned())
        ]
    );
}

// ---- the fields of a create and an edit are parameters of their own (#1166) ----

#[test]
fn create_and_edit_carry_their_fields_as_parameters() {
    let world = seeded();
    let mut session = world.strict_session();
    session.user("");
    let created = call(
        &mut session,
        "create",
        json!({"kind": "task", "name": "Call plumber", "effort": "20"}),
    );
    assert_eq!(created["effect"]["verb"], "create", "{created}");
    session.user("");
    let row = number(&mut session, "task", "Call plumber");
    let edited = call(
        &mut session,
        "edit",
        json!({"rows": row, "name": "Call the plumber", "effort": 30}),
    );
    assert_eq!(edited["effect"]["verb"], "edit", "{edited}");
    // the selector parameters an edit does not take are still refused by name
    session.user("");
    let row = number(&mut session, "task", "Call the plumber");
    let refused = text(
        &mut session,
        "edit",
        json!({"rows": row, "kind": "task", "effort": 5}),
    );
    assert!(
        refused.contains("edit has no parameter \"kind\""),
        "{refused}"
    );
    // the args lines still work (S2's, and a model that writes them)
    session.user("");
    let row = number(&mut session, "task", "Call the plumber");
    let old = call(
        &mut session,
        "edit",
        json!({"rows": row, "args": "effort: 10"}),
    );
    assert_eq!(old["effect"]["verb"], "edit", "{old}");
}

#[test]
fn no_field_is_named_like_a_parameter_the_tool_takes_itself() {
    for field in meta::flat_field_names() {
        assert!(
            !["kind", "rows", "more", "args", "verb"].contains(&field),
            "{field} would collide with a parameter of create or edit"
        );
        if field != "name" {
            assert!(
                !meta::SELECTOR_PARAMS.contains(&field),
                "{field} is a selector parameter an edit refuses"
            );
        }
    }
}

#[test]
fn a_think_states_a_create_with_its_fields_flat_and_s2_with_args() {
    let think =
        "intent: write \"add\"\nverb: create\nkind: task\nset: name = Pay rent · effort = 30";
    let new = compile_think_for(think, None, TraceMode::V4, ToolsMode::Sig).unwrap();
    assert_eq!(new.tool, "create");
    let pairs: Vec<(&str, &str)> = new
        .args
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    assert_eq!(
        pairs,
        [("kind", "task"), ("name", "Pay rent"), ("effort", "30")]
    );
    let s2 = compile_think(think, None, TraceMode::V4).unwrap();
    assert_eq!(
        s2.args[1],
        ("args".to_owned(), "name: Pay rent\neffort: 30".to_owned())
    );
    // a field that is also a slot of the call is refused, not written twice
    let twice = compile_think_for(
        "intent: write\nverb: create\nkind: task\nset: kind = event",
        None,
        TraceMode::V4,
        ToolsMode::Sig,
    );
    assert!(twice.is_err());
}

#[test]
fn the_session_states_the_same_flat_fields_the_stateless_compiler_writes() {
    let world = seeded();
    let mut session = world.strict_session();
    let row = number(&mut session, "task", "cabin");
    session.user("add a task call plumber, thirty minutes");
    let compiled = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "create", "kind": "task",
        "set": [{"key": "name", "value": "Call plumber"}, {"key": "effort", "value": 30}]
    }));
    assert!(compiled.get("refused").is_none(), "{compiled}");
    let want = compile_think_for(
        "intent: write\nverb: create\nkind: task\nset: name = Call plumber · effort = 30",
        None,
        TraceMode::V4,
        ToolsMode::Sig,
    )
    .unwrap();
    let args = compiled["stated"]["args"].as_object().unwrap();
    let got: Vec<(String, String)> = args
        .iter()
        .map(|(key, value)| {
            let value = value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_owned);
            (key.clone(), value)
        })
        .collect();
    // a JSON object has no order the reply could keep, so the same arguments, compared as a set
    let mut want_args = want.args.clone();
    want_args.sort();
    assert_eq!(got, want_args, "{compiled}");
    // `call` (grounded) keeps the lines the runtime reads; `stated` is the training target
    assert!(compiled["call"]["args"].get("args").is_some(), "{compiled}");
    // an edit, and a set key that is also a slot
    session.user("make the cabin one hour");
    let edit = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "edit", "pick": [{"row": row, "verdict": "ok", "reason": "name"}],
        "set": [{"key": "effort", "value": 60}]
    }));
    assert_eq!(edit["stated"]["args"]["effort"], "60", "{edit}");
    assert!(edit["stated"]["args"].get("args").is_none(), "{edit}");
    let twice = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "create", "kind": "task",
        "set": [{"key": "kind", "value": "event"}]
    }));
    assert!(twice.get("refused").is_some(), "{twice}");
}
