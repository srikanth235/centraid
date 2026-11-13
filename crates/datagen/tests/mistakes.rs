//! H6: every family of mistake is refused by the real runtime, on every kind it applies to, and the refusal says what
//! the family says it is. The planner demands this of each bad call it keeps; the test finds a family that stops being
//! refused before a build does.

use std::collections::BTreeMap;

use centraid_datagen::mistakes::{self, FAMILIES};
use centraid_datagen::plan::{WorldRun, call_xml};
use centraid_datagen::{Catalog, World, plan};
use serde_json::{Map, Value};

fn first_line(response: &Value) -> String {
    response["text"]
        .as_str()
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

fn call(live: &mut centraid_datagen::plan::Live, tool: &str, args: &[(&str, String)]) -> Value {
    let mut map = Map::new();
    for (k, v) in args {
        map.insert((*k).to_owned(), Value::String(v.clone()));
    }
    live.session.call_text(&call_xml(tool, &map))
}

fn refused(response: &Value) -> bool {
    response["effect"].get("error").is_some()
}

#[test]
fn every_family_is_refused_by_the_runtime_on_every_kind_it_applies_to() {
    let catalog = Catalog::build().expect("catalog");
    let world = World::generate(plan(1)[0]);
    let scratch = tempfile::tempdir().expect("scratch");
    let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    let mut bad: Vec<String> = Vec::new();
    for kind in &catalog.kinds {
        let mut live = run.open().expect("opens");
        live.session.user("show them");
        // a row of the kind the runtime has shown, so a write's rows argument is a real handle
        let found = call(&mut live, "find", &[("kind", kind.name.clone())]);
        let handle = first_line_handle(&found);
        let mut all = Vec::new();
        all.extend(mistakes::for_read(&catalog, &kind.name, false));
        all.extend(mistakes::for_read(&catalog, &kind.name, true));
        if let Some(h) = &handle {
            for (tool, args) in [
                (
                    "do",
                    vec![("verb", "complete".to_owned()), ("rows", h.clone())],
                ),
                (
                    "do",
                    vec![
                        ("verb", "reschedule".to_owned()),
                        ("rows", h.clone()),
                        ("args", "to: tomorrow".to_owned()),
                    ],
                ),
                (
                    "edit",
                    vec![("rows", h.clone()), ("args", "name: x".to_owned())],
                ),
                ("create", vec![("kind", kind.name.clone())]),
            ]
            .into_iter()
            // reschedule applies to tasks and events only; elsewhere it is a decline, which is no repair
            .filter(|(_, a)| {
                !a.iter().any(|(_, v)| v == "reschedule")
                    || ["task", "event"].contains(&kind.name.as_str())
            }) {
                let args: Vec<(&'static str, String)> =
                    args.into_iter().map(|(k, v)| (leak(k), v)).collect();
                all.extend(mistakes::for_write(&catalog, &kind.name, tool, &args));
            }
        } else {
            all.extend(mistakes::for_write(
                &catalog,
                &kind.name,
                "create",
                &[("kind", kind.name.clone())],
            ));
        }
        for m in all {
            let mut live = run.open().expect("opens");
            live.session.user("show them");
            let found = call(&mut live, "find", &[("kind", kind.name.clone())]);
            let _ = found;
            let response = call(&mut live, m.tool, &m.args);
            *seen.entry(m.family).or_default() += 1;
            if !refused(&response) {
                bad.push(format!(
                    "{} on {}: {} {:?} was accepted: {}",
                    m.family,
                    kind.name,
                    m.tool,
                    m.args,
                    response["effect"]["refusal"]["reason"].as_str().unwrap_or(
                        &response["effect"].to_string()
                            [..80.min(response["effect"].to_string().len())]
                    )
                ));
            } else if m.family != "row_not_shown" && first_line(&response).contains("never shown") {
                bad.push(format!(
                    "{} on {}: refused for the wrong reason: {}",
                    m.family,
                    kind.name,
                    first_line(&response)
                ));
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
    for family in FAMILIES {
        assert!(
            seen.contains_key(family),
            "no kind exercises {family}: {seen:?}"
        );
    }
}

fn leak(s: &str) -> &'static str {
    match s {
        "verb" => "verb",
        "rows" => "rows",
        "args" => "args",
        "kind" => "kind",
        other => panic!("{other}"),
    }
}

/// The first `#n` handle in a find's reply.
fn first_line_handle(response: &Value) -> Option<String> {
    response["effect"]["rows"]
        .as_array()?
        .iter()
        .find_map(|r| r["n"].as_u64())
        .map(|n| format!("#{n}"))
}
