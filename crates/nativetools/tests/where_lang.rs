//! The `where` mini-language (SPEC §4.1) against the fixture world.

mod common;

use centraid_nativetools::meta::Kind;
use centraid_nativetools::whr;
use common::{call, ids, seeded, text};
use proptest::prelude::*;
use serde_json::json;

fn rows(world: &common::World, kind: &str, clause: &str) -> Vec<String> {
    let mut session = world.session();
    session.user("");
    let response = call(&mut session, "find", json!({"kind": kind, "where": clause}));
    let mut out = ids(&response["effect"]["rows"]);
    out.sort();
    out
}

fn keys(world: &common::World, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = keys.iter().map(|key| world.id(key)).collect();
    out.sort();
    out
}

#[test]
fn every_operator_on_every_field_type() {
    let world = seeded();
    assert_eq!(
        rows(&world, "task", "effort > 20"),
        keys(&world, &["cabin"])
    );
    assert_eq!(
        rows(&world, "task", "effort <= 20"),
        keys(&world, &["reed"])
    );
    // the field's own unit may be spelled out
    assert_eq!(
        rows(&world, "task", "effort > 20 minutes"),
        keys(&world, &["cabin"])
    );
    assert_eq!(
        rows(&world, "task", "status != open"),
        keys(&world, &["report"])
    );
    assert_eq!(
        rows(&world, "task", "status in (\"completed\", \"cancelled\")"),
        keys(&world, &["report"])
    );
    assert_eq!(
        rows(&world, "task", "effort is empty and status = open"),
        keys(&world, &["outline", "pay"])
    );
    assert_eq!(
        rows(&world, "task", "completed is set"),
        keys(&world, &["report"])
    );
    assert_eq!(
        rows(&world, "note", "body contains \"CUMIN\""),
        keys(&world, &["dal"])
    );
    assert_eq!(
        rows(&world, "note", "pinned = yes"),
        keys(&world, &["journal"])
    );
    assert_eq!(
        rows(&world, "debt", "amount > 20"),
        keys(&world, &["tickets"])
    );
    assert_eq!(
        rows(&world, "debt", "amount > 20 EUR"),
        Vec::<String>::new(),
        "per currency"
    );
    assert_eq!(
        rows(&world, "debt", "direction = i_owe and status = settled"),
        keys(&world, &["lunch"])
    );
    assert_eq!(
        rows(&world, "person", "role = \"Designer\""),
        keys(&world, &["neha_r"])
    );
    assert_eq!(
        rows(&world, "album", "photo count = 0"),
        keys(&world, &["empty_album"])
    );
    assert_eq!(
        rows(&world, "locker item", "type = wifi"),
        keys(&world, &["wifi"])
    );
}

#[test]
fn errors_name_every_valid_option() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let cases = [
        (
            "task",
            "status = done",
            "error: status has no value \"done\". task status values: open, in_progress, completed, cancelled.",
        ),
        (
            "task",
            "name = \"x\"",
            "error: where has no name field; filter names with name=\"…\" (whole words), or search.",
        ),
        (
            "task",
            "date > 3",
            "error: where has no date field; filter the task date with when=<date expression>.",
        ),
        (
            "task",
            "completed > 3",
            "error: completed is a date; where takes only \"completed is set\" or \"completed is empty\". Filter by the task date with when.",
        ),
        (
            "task",
            "status = open or effort > 3",
            "error: where has no \"or\"; use field in (\"a\", \"b\"). Conditions join with \" and \".",
        ),
        (
            "task",
            "album count > 1",
            "error: tasks are not linked to albums. task links: task, person, list.",
        ),
        (
            "task",
            "effort > 1 hour",
            "error: effort is a number of minutes (60, not 1 hour); \"1 hour\" is not.",
        ),
        (
            "person",
            "cadence > 2 weeks",
            "error: cadence is a number of days (14, not 2 weeks); \"2 weeks\" is not.",
        ),
        (
            "task",
            "effort ~ 3",
            "error: could not read \"effort ~ 3\". Operators: = != < <= > >=, contains \"…\", in (\"a\", \"b\"), is empty, is set.",
        ),
        (
            "person",
            "role > \"a\"",
            "error: role is text; compare it with = or != or contains \"…\".",
        ),
        (
            "task",
            "effort contains \"3\"",
            "error: contains works on text fields; effort is not text.",
        ),
    ];
    for (kind, clause, want) in cases {
        session.user("");
        assert_eq!(
            text(&mut session, "find", json!({"kind": kind, "where": clause})),
            want,
            "{clause}"
        );
    }
}

#[test]
fn the_grammar_export_has_a_rule_per_kind() {
    let lark = whr::lark();
    for kind in Kind::ALL {
        assert!(
            lark.contains(&format!("where_{}:", kind.name().replace(' ', "_"))),
            "{kind:?}"
        );
    }
    assert!(lark.contains(
        "\"status\" \" \" EQ \" \" (\"open\" | \"in_progress\" | \"completed\" | \"cancelled\")"
    ));
}

proptest! {
    /// `in (a, b)` is exactly `= a` or `= b` — the only `or` the language has.
    #[test]
    fn in_is_the_union_of_equalities(pick in proptest::sample::subsequence(vec!["open", "in_progress", "completed", "cancelled"], 1..4)) {
        let clause = format!("status in ({})", pick.iter().map(|value| format!("\"{value}\"")).collect::<Vec<_>>().join(", "));
        let parsed = whr::parse(Kind::Task, &clause).unwrap();
        prop_assert_eq!(parsed.len(), 1);
        for value in &pick {
            let single = whr::parse(Kind::Task, &format!("status = {value}")).unwrap();
            prop_assert_eq!(single.len(), 1);
        }
    }

    /// Any conjunction of valid conditions parses into that many conditions.
    #[test]
    fn conjunctions_parse_condition_by_condition(n in 1_usize..6, bound in 0_i64..500) {
        let clause = vec![format!("effort > {bound}"); n].join(" and ");
        prop_assert_eq!(whr::parse(Kind::Task, &clause).unwrap().len(), n);
    }
}
