//! Phase 6, slice H1b of #1044: a malformed write is repaired before its first send
//! (`normalize.rs`). Each repair says so in a `note:` line under the reply and in the effect's
//! `normalized` list; the compile step repairs the call it returns and the step that runs that
//! call reports it.

mod common;

use common::{World, call, diff_rows, find_in_turn, ids, seeded};
use serde_json::{Value, json};

fn said(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

fn rules(response: &Value) -> Vec<String> {
    response["effect"]["normalized"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry["rule"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn create(world: &World, args: Value) -> Value {
    let mut session = world.session();
    session.user("add one");
    call(&mut session, "act", args)
}

fn answered(response: &Value) -> Vec<String> {
    let mut out = ids(&response["effect"]["answer"]["rows"]);
    out.sort();
    out
}

// ---------------------------------------------------------------------------------------------
// 1. create args the kind does not take

#[test]
fn a_create_arg_the_kind_does_not_take_is_dropped_and_the_row_is_created() {
    let world = seeded();
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "notebook", "args": "name: Family\narea: family"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).ends_with("note: ignored area: family (notebooks have no area)"),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["create_arg_dropped"]);
    assert_eq!(reply["effect"]["normalized"][0]["arg"], "area");
    assert_eq!(diff_rows(&reply)[0]["change"], "created");
    assert_eq!(
        diff_rows(&reply)[0]["fields"]["name"],
        json!([null, "Family"])
    );

    // a field the kind has but a create does not set
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "task", "args": "name: Call plumber\nstatus: open"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains("note: ignored status: open (tasks cannot be created with status)"),
        "{reply}"
    );
    // args written as an object are repaired too
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "folder", "args": {"name": "Receipts", "colour": "red"}}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(said(&reply).contains("note: ignored colour: red (folders have no colour)"));
}

#[test]
fn a_locker_secret_on_create_is_sealed_when_the_type_keeps_it() {
    let world = seeded();
    let mut session = world.session();
    session.user("save my gym login");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "locker item",
               "args": "name: Gym\ntype: login\nusername: sam\npassword: hunter2\ncode: 424242"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(!said(&reply).contains("hunter2") && !said(&reply).contains("424242"));
    assert!(
        reply["effect"].get("normalized").is_none(),
        "nothing to repair: {reply}"
    );
    assert!(
        !reply.to_string().contains("hunter2"),
        "the secret is in no effect: {reply}"
    );
    session.user("what is the gym password");
    let revealed = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "kind": "locker item", "name": "Gym", "args": "field: password"}),
    );
    assert!(said(&revealed).contains("hunter2"), "{revealed}");
    session.user("and the code");
    let code = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "kind": "locker item", "name": "Gym", "args": "field: code"}),
    );
    assert!(said(&code).contains("424242"), "{code}");
}

#[test]
fn a_locker_secret_a_type_cannot_keep_is_left_out_and_the_note_says_so() {
    let world = seeded();
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "locker item",
               "args": "name: Notes to self\ntype: note\npassword: hunter2"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains(
            "note: ignored password (a note item keeps no password; the secret was not stored)"
        ),
        "{reply}"
    );
    assert!(
        !reply.to_string().contains("hunter2"),
        "never the value: {reply}"
    );
    assert_eq!(rules(&reply), ["secret_not_stored"]);
}

// ---------------------------------------------------------------------------------------------
// 2. `when` on a create

#[test]
fn a_when_on_a_create_becomes_the_date_when_it_is_one_day() {
    let world = seeded();
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "task", "when": {"unit": "day", "rel": 1},
               "args": "name: Call plumber"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains("when: "),
        "the row has its date: {reply}"
    );
    assert!(
        said(&reply)
            .contains("note: create takes no when; used {\"rel\":1,\"unit\":\"day\"} as date:"),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["when_as_date"]);
    assert!(
        reply["effect"]["diff"]["rows"][0]["fields"]["date"].is_array(),
        "{reply}"
    );
}

#[test]
fn a_when_that_is_not_one_day_or_that_the_args_already_date_is_dropped() {
    let world = seeded();
    // a week is a span: no date
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "task", "when": {"unit": "week", "rel": 1},
               "args": "name: Call plumber"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains("(create takes no when parameter)"),
        "{reply}"
    );
    assert!(!said(&reply).contains("when: "), "{reply}");
    assert_eq!(rules(&reply), ["when_dropped"]);
    // the args' own date wins
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "task", "when": {"unit": "day", "rel": 1},
               "args": "name: Call plumber\ndate: {\"unit\":\"day\",\"rel\":3}"}),
    );
    assert_eq!(rules(&reply), ["when_dropped"], "{reply}");
    assert!(
        said(&reply).contains("2026-09-30"),
        "the date of the args: {reply}"
    );
    // a kind with no date has none to take
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "note", "when": {"unit": "day", "rel": 1},
               "args": "name: Ideas"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert_eq!(rules(&reply), ["when_dropped"]);
}

// ---------------------------------------------------------------------------------------------
// 3. containers of the wrong kind

#[test]
fn list_of_a_task_is_parent_and_parent_of_a_list_is_list() {
    let world = seeded();
    let mut session = world.session();
    session.user("add a subtask to write report");
    let report = find_in_turn(&mut session, "task", "Book the cabin");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": format!("name: Outline part\nlist: {report}")}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains(&format!(
            "note: list: {report} is a task; used it as parent:"
        )),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["container_renamed"]);
    assert_eq!(reply["effect"]["normalized"][0]["to"], "parent");

    session.user("add a task to home");
    let home = find_in_turn(&mut session, "list", "Home");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": format!("name: Sweep\nparent: {home}")}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains(&format!("note: parent: {home} is a list; used it as list:")),
        "{reply}"
    );
    assert_eq!(reply["effect"]["normalized"][0]["to"], "list");
    // the task landed in the list
    let links = reply["effect"]["diff"]["links"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        links
            .iter()
            .any(|link| link["from"]["id"] == world.id("home")),
        "{reply}"
    );
}

#[test]
fn a_container_that_is_not_that_container_is_dropped_never_guessed() {
    let world = seeded();
    let mut session = world.session();
    session.user("add a note to the ray task");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "note", "args": format!("name: Ideas\nnotebook: {ray}")}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains(&format!(
            "note: ignored notebook: {ray} is a person (notebook takes a notebook; nothing guessed)"
        )),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["container_dropped"]);
    // the note sits in no notebook
    assert!(
        reply["effect"]["diff"]["links"]
            .as_array()
            .is_none_or(Vec::is_empty),
        "{reply}"
    );

    session.user("add a document");
    let cabin = find_in_turn(&mut session, "task", "cabin");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "document", "args": format!("name: Receipt\nfolder: {cabin}")}),
    );
    assert!(said(&reply).contains("note: ignored folder: "), "{reply}");
    assert!(
        said(&reply).contains("is a task (folder takes a folder"),
        "{reply}"
    );

    // an arg that already names the right container is left alone
    session.user("add a task to a list");
    let home = find_in_turn(&mut session, "list", "Home");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": format!("name: Dust\nlist: {home}")}),
    );
    assert!(reply["effect"].get("normalized").is_none(), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// 4. no pick, a target

fn no_pick_slots(verb: &str, row: &str) -> Value {
    json!({"intent": "write", "verb": verb, "target": ["the cabin"],
           "pick": [{"row": row, "verdict": "no"}]})
}

#[test]
fn a_write_with_no_pick_is_matched_by_the_target_name() {
    let world = seeded();
    let mut session = world.session();
    session.user("complete the cabin");
    let rent = find_in_turn(&mut session, "task", "Pay rent");
    let reply = session.compile(&no_pick_slots("complete", &rent));
    assert!(reply.get("refused").is_none(), "{reply}");
    let call_args = &reply["call"]["args"];
    assert_eq!(call_args["name"], "the cabin", "{reply}");
    assert_eq!(call_args["kind"], "task", "{reply}");
    assert!(call_args.get("rows").is_none(), "{reply}");
    assert!(
        reply["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note == "note: no pick: matched by name \"the cabin\" among tasks"),
        "{reply}"
    );
    assert_eq!(reply["normalized"][0]["rule"], "name_from_target");
    // what the pick slots stated is unchanged
    assert!(reply["stated"]["args"].get("name").is_none(), "{reply}");

    // the step that runs the compiled call reports the repair, and the runtime's own matching runs
    let ran = call(&mut session, "act", call_args.clone());
    assert!(said(&ran).starts_with("completed: "), "{ran}");
    assert!(
        said(&ran).contains("note: no pick: matched by name \"the cabin\" among tasks"),
        "{ran}"
    );
    assert_eq!(rules(&ran), ["name_from_target"], "{ran}");
    assert_eq!(diff_rows(&ran)[0]["id"], world.id("cabin"));
}

#[test]
fn a_write_with_no_pick_and_no_one_kind_is_left_to_the_error() {
    let world = seeded();
    let mut session = world.session();
    session.user("change the cabin");
    let rent = find_in_turn(&mut session, "task", "Pay rent");
    // an edit fits every kind: no kind to name, so nothing is guessed
    let reply = session.compile(&no_pick_slots("edit", &rent));
    assert!(reply["call"]["args"].get("name").is_none(), "{reply}");
    assert_eq!(reply["normalized"], json!([]));
    // a target does not override a pick that was kept
    let kept = session.compile(
        &json!({"intent": "write", "verb": "complete", "target": ["the cabin"],
                                       "pick": [{"row": rent, "verdict": "ok"}]}),
    );
    assert!(kept["call"]["args"].get("name").is_none(), "{kept}");
    assert_eq!(kept["normalized"], json!([]));
}

// ---------------------------------------------------------------------------------------------
// 5. `where` on name

#[test]
fn a_where_on_name_is_the_name_selector_in_reads_and_writes() {
    let world = seeded();
    let mut session = world.session();
    session.user("pay rent");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "name = \"Pay rent\""}),
    );
    assert_eq!(answered(&reply), vec![world.id("pay")], "{reply}");
    assert!(
        said(&reply).contains("note: used name: Pay rent for the where clause on name"),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["where_name_lifted"]);

    // a write: the by-name selector the runtime matches itself
    session.user("star ray");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "where": "name = Ray Ochoa"}),
    );
    assert_eq!(diff_rows(&reply)[0]["id"], world.id("ray"), "{reply}");
    assert_eq!(rules(&reply), ["where_name_lifted"]);
}

#[test]
fn another_operator_on_name_is_dropped_and_the_rest_of_the_where_stays() {
    let world = seeded();
    let mut session = world.session();
    session.user("open tasks");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "name != \"Pay rent\" and status = open"}),
    );
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert!(
        said(&reply).contains("note: ignored where name != \"Pay rent\" (where has no name field)"),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["where_name_dropped"]);
    let rows = answered(&reply);
    assert!(
        rows.contains(&world.id("cabin")),
        "the status clause still filters: {reply}"
    );
    assert!(!rows.contains(&world.id("library")), "{reply}");

    // other operators too; a where that held only that clause is gone
    session.user("tasks");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "name in (\"rent\")"}),
    );
    assert_eq!(rules(&reply), ["where_name_dropped"], "{reply}");
    assert!(
        said(&reply).starts_with("@"),
        "the find ran on the whole kind: {reply}"
    );
}

#[test]
fn a_typed_where_on_name_compiles_into_the_name_slot() {
    let world = seeded();
    let mut session = world.session();
    session.user("pay rent");
    let reply = session.compile(&json!({
        "intent": "read", "kind": "task",
        "where": [{"field": "name", "op": "=", "value": "Pay rent"},
                  {"field": "status", "op": "=", "value": "open"}],
    }));
    assert!(reply.get("refused").is_none(), "{reply}");
    assert_eq!(reply["call"]["args"]["name"], "Pay rent", "{reply}");
    assert_eq!(
        reply["call"]["args"]["where"], "status = \"open\"",
        "{reply}"
    );
    assert_eq!(reply["normalized"][0]["rule"], "where_name_lifted");
    // the step that runs it says what compile did
    let ran = call(&mut session, "answer", reply["call"]["args"].clone());
    assert!(
        said(&ran).contains("note: used name: Pay rent for the where clause on name"),
        "{ran}"
    );
    assert_eq!(rules(&ran), ["where_name_lifted"]);
    // the only condition on name, dropped: no where is left
    let dropped = session.compile(&json!({
        "intent": "read", "kind": "task",
        "where": [{"field": "name", "op": "!=", "value": "rent"}],
    }));
    assert!(dropped["call"]["args"].get("where").is_none(), "{dropped}");
    assert_eq!(dropped["normalized"][0]["rule"], "where_name_dropped");
    // `contains` is the name selector too
    let lifted = session.compile(&json!({
        "intent": "read", "kind": "task",
        "where": [{"field": "name", "op": "contains", "value": "rent"}],
    }));
    assert_eq!(lifted["call"]["args"]["name"], "rent", "{lifted}");
    assert!(lifted["call"]["args"].get("where").is_none(), "{lifted}");
    assert_eq!(lifted["normalized"][0]["rule"], "where_name_lifted");
}

// ---------------------------------------------------------------------------------------------
// 6. rows beside a selector, on a write

#[test]
fn a_write_on_rows_and_a_selector_runs_on_the_rows_with_a_note() {
    let world = seeded();
    let mut session = world.session();
    session.user("star ray");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "rows": ray, "name": "Neha", "where": "role = x"}),
    );
    assert_eq!(diff_rows(&reply).len(), 1, "{reply}");
    assert_eq!(diff_rows(&reply)[0]["id"], world.id("ray"), "{reply}");
    assert!(
        said(&reply).contains("note: ignored name, where (the rows were named)"),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["selector_dropped"]);
    assert_eq!(
        reply["effect"]["normalized"][0]["params"],
        json!(["name", "where"])
    );
    // the kind beside rows stays the check it is: a wrong one is still the error
    session.user("star ray");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "unstar", "kind": "task", "rows": ray, "name": "Neha"}),
    );
    assert!(
        said(&reply).contains("is a person, and kind says task"),
        "{reply}"
    );
}

#[test]
fn compile_repairs_rows_beside_a_selector_and_the_run_reports_it() {
    let world = seeded();
    let mut session = world.session();
    session.user("star ray");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let reply = session.compile(&json!({
        "intent": "write", "verb": "star", "kind": "person", "name": "Neha", "rows": [ray],
    }));
    assert_eq!(reply["call"]["args"]["rows"], json!([ray]), "{reply}");
    assert!(reply["call"]["args"].get("name").is_none(), "{reply}");
    assert_eq!(reply["normalized"][0]["rule"], "selector_dropped");
    let ran = call(&mut session, "act", reply["call"]["args"].clone());
    assert_eq!(diff_rows(&ran)[0]["id"], world.id("ray"), "{ran}");
    assert!(
        said(&ran).contains("note: ignored name (the rows were named)"),
        "{ran}"
    );
}

#[test]
fn a_well_formed_call_is_left_exactly_as_it_is() {
    let world = seeded();
    let mut session = world.session();
    session.user("star ray");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": ray}));
    assert!(reply["effect"].get("normalized").is_none(), "{reply}");
    assert!(!said(&reply).contains("note:"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// A repaired create's `args` stay the line-style string the call language uses

#[test]
fn a_compiled_create_that_needed_a_repair_keeps_its_args_as_lines() {
    use centraid_nativetools::act::act_args;
    let world = seeded();
    let mut session = world.session();
    session.user("order the cake");
    let cabin = find_in_turn(&mut session, "task", "cabin");
    let reply = session.compile(&json!({
        "intent": "write", "verb": "create", "kind": "task",
        "when": {"date": "2027-01-14"},
        "set": [{"key": "name", "value": "Order the cake"}, {"key": "list", "value": cabin},
                {"key": "area", "value": "kitchen"}],
    }));
    assert!(reply.get("refused").is_none(), "{reply}");
    let lines = &reply["call"]["args"]["args"];
    assert_eq!(
        lines,
        &json!(format!(
            "name: Order the cake\nparent: {cabin}\ndate: {{\"date\":\"2027-01-14\"}}"
        )),
        "{reply}"
    );
    // it re-reads as the repaired fields
    let fields = act_args(Some(lines)).unwrap();
    assert_eq!(fields["name"], "Order the cake");
    assert_eq!(fields["parent"], cabin);
    assert_eq!(fields["date"], json!({"date": "2027-01-14"}));
    assert!(!fields.contains_key("area") && !fields.contains_key("list"));
    // no `when` left on the call, and the notes name the dropped field as the line it was
    assert!(reply["call"]["args"].get("when").is_none(), "{reply}");
    let notes = reply["notes"].to_string();
    assert!(
        notes.contains("note: ignored area: kitchen (tasks have no area)"),
        "{notes}"
    );
    assert!(!notes.contains("{'"), "{notes}");
}

#[test]
fn a_hand_written_object_args_is_repaired_and_the_row_is_created() {
    let world = seeded();
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "notebook", "args": {"name": "Garden", "area": "family"}}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).ends_with("note: ignored area: family (notebooks have no area)"),
        "{reply}"
    );
    assert_eq!(
        diff_rows(&reply)[0]["fields"]["name"],
        json!([null, "Garden"])
    );
    // the args text a compiled call would render comes back unchanged through the runtime
    let text = create(
        &world,
        json!({"verb": "create", "kind": "notebook", "args": "name: Orchard\narea: family"}),
    );
    assert!(said(&text).starts_with("created: "), "{text}");
}

// ---------------------------------------------------------------------------------------------
// An arg under another spelling of a field is that field; a clause the parser reads is not touched

#[test]
fn a_kinds_own_word_for_its_date_is_the_date_not_an_unknown_arg() {
    let world = seeded();
    // a task's date is its due date
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "task", "args": "name: Pay tax\ndue: {\"date\":\"2026-11-30\"}"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(said(&reply).contains("note: used due as date:"), "{reply}");
    assert!(!said(&reply).contains("ignored"), "{reply}");
    assert!(
        said(&reply).contains("2026-11-30"),
        "the task has its date: {reply}"
    );
    assert_eq!(rules(&reply), ["create_arg_renamed"]);
    // an event's is its start
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "event", "args": "name: Lunch\nstart: {\"date\":\"2026-10-02\",\"time\":\"12:30\"}"}),
    );
    assert!(said(&reply).starts_with("created: "), "{reply}");
    assert!(
        said(&reply).contains("note: used start as date:"),
        "{reply}"
    );
    assert!(said(&reply).contains("2026-10-02"), "{reply}");
    // a `date` already there wins; the other spelling is then an arg the kind does not take
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "task",
               "args": "name: Pay water\ndate: {\"date\":\"2026-11-01\"}\ndue: {\"date\":\"2026-11-30\"}"}),
    );
    assert!(said(&reply).contains("2026-11-01"), "{reply}");
    assert!(said(&reply).contains("note: ignored due: "), "{reply}");
    // a kind with no date has no such word
    let reply = create(
        &world,
        json!({"verb": "create", "kind": "note", "args": "name: Ideas\ndue: friday"}),
    );
    assert!(
        said(&reply).contains("note: ignored due: friday (notes have no due)"),
        "{reply}"
    );
}

#[test]
fn a_where_name_contains_is_the_name_selector() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks with rent in the name");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "name contains \"rent\""}),
    );
    assert_eq!(answered(&reply), vec![world.id("pay")], "{reply}");
    assert!(
        said(&reply).contains("note: used name: rent for the where clause on name"),
        "{reply}"
    );
    assert_eq!(rules(&reply), ["where_name_lifted"]);
    assert_eq!(reply["effect"]["normalized"][0]["name"], "rent");
    // beside another clause, which stays
    session.user("open tasks with rent in the name");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "name contains \"rent\" and status = open"}),
    );
    assert_eq!(answered(&reply), vec![world.id("pay")], "{reply}");
    assert_eq!(rules(&reply), ["where_name_lifted"]);
    // a clause on another field is never read as a name clause
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "description contains \"rent\""}),
    );
    assert!(reply["effect"].get("normalized").is_none(), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// The reference runs turn the repairs off: what a reference states is what runs

#[test]
fn without_normalize_a_malformed_call_is_refused_as_it_was() {
    use centraid_nativetools::Flags;
    let world = seeded();
    let flags = Flags {
        normalize: false,
        ..Flags::default()
    };
    assert!(Flags::default().normalize, "on by default");
    let mut session = world.session_with(common::TODAY, flags);
    session.user("add one");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "notebook", "args": "name: Family\narea: family"}),
    );
    assert!(
        said(&reply).starts_with("error: create notebook args take name"),
        "{reply}"
    );
    assert!(reply["effect"].get("normalized").is_none(), "{reply}");
    // a where on name stays the parser's refusal, in the step and in compile
    session.user("tasks");
    let refused = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "name contains \"rent\""}),
    );
    assert!(
        said(&refused).contains("where has no name field"),
        "{refused}"
    );
    let compiled = session.compile(&json!({
        "intent": "read", "kind": "task",
        "where": [{"field": "name", "op": "contains", "value": "rent"}],
    }));
    assert_eq!(compiled["refused"]["slot"], "where[0]", "{compiled}");
    // rows beside a selector are the error again
    let ray = find_in_turn(&mut session, "person", "Ray");
    session.user("star ray");
    let both = call(
        &mut session,
        "act",
        json!({"verb": "star", "rows": ray, "name": "Neha"}),
    );
    assert!(
        said(&both).starts_with("error: act takes rows or a selector"),
        "{both}"
    );
}
