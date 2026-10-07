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
            "effort > 1 sprint",
            "error: effort is a number of minutes (60, not 1 hour); \"1 sprint\" is not.",
        ),
        (
            "person",
            "cadence > 2 fortnights",
            "error: cadence is a number of days (14, not 2 weeks); \"2 fortnights\" is not.",
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
fn a_where_on_name_is_refused_by_the_parser_and_repaired_by_the_call() {
    // the grammar has no name field; a call that writes one never meets the refusal
    // (`normalize.rs`: it becomes the name selector, or the clause is dropped)
    assert_eq!(
        whr::parse(Kind::Task, "name = \"x\"").unwrap_err(),
        "error: where has no name field; filter names with name=\"…\" (whole words), or search."
    );
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let said = text(
        &mut session,
        "find",
        json!({"kind": "task", "where": "name = \"Pay rent\""}),
    );
    assert!(said.starts_with("@1 · 1 task"), "{said}");
    assert!(said.ends_with("note: used name: Pay rent for the where clause on name"));
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

/// The fixture plus three debts whose amounts a person writes with a suffix.
fn big_debts_world() -> common::World {
    let mut world: serde_json::Value = serde_json::from_str(common::FIXTURE).unwrap();
    let debts = world["debts"].as_array_mut().unwrap();
    for (key, amount) in [("k500", 500_000), ("k25", 2_500), ("m1", 1_000_000)] {
        debts.push(json!({
            "key": key, "person": "neha_r", "direction": "owes_me",
            "amount": amount, "name": key, "date": "2026-06-02"
        }));
    }
    common::seeded_with(&world)
}

#[test]
fn k_and_m_suffixes_are_amounts_in_a_where() {
    // (clause, the debts it selects): the model may write what the person said.
    let world = big_debts_world();
    let cases: [(&str, &[&str]); 7] = [
        ("amount = 500k", &["k500"]),
        ("amount = 500K", &["k500"]),
        ("amount = 2.5k", &["k25"]),
        ("amount >= 1m", &["m1"]),
        ("amount = 1M", &["m1"]),
        ("amount > 1k and amount < 1m", &["k25", "k500"]),
        ("amount = 500000", &["k500"]),
    ];
    for (clause, want) in cases {
        assert_eq!(rows(&world, "debt", clause), keys(&world, want), "{clause}");
    }
    // `!=` reads the suffix too, so "everything that isn't 500k" drops that one debt.
    let not = rows(&world, "debt", "amount != 500k");
    assert_eq!(not.len(), 4, "{not:?}");
    assert!(!not.contains(&world.id("k500")));
}

#[test]
fn a_suffix_is_not_a_unit_on_the_other_numbers() {
    // Minutes and days keep their own unit words: "30m" is not thirty million.
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let refused = text(
        &mut session,
        "find",
        json!({"kind": "task", "where": "effort > 30m"}),
    );
    assert!(
        refused.starts_with("error: effort is a number"),
        "{refused}"
    );
}

#[test]
fn amount_suffixes_parse_to_plain_numbers() {
    let table: [(&str, Option<f64>); 14] = [
        ("500k", Some(500_000.0)),
        ("2.5k", Some(2_500.0)),
        ("1m", Some(1_000_000.0)),
        ("1.5M", Some(1_500_000.0)),
        ("60K", Some(60_000.0)),
        ("$2k", Some(2_000.0)),
        ("€1.2m", Some(1_200_000.0)),
        ("1,500", Some(1_500.0)),
        ("12", Some(12.0)),
        ("12.50", Some(12.5)),
        ("k", None),
        ("500kk", None),
        ("2.5.1k", None),
        ("fifty", None),
    ];
    let passed = table
        .iter()
        .filter(|(text, want)| whr::parse_amount(text) == *want)
        .count();
    assert_eq!(
        passed,
        table.len(),
        "amount phrases resolved: {passed}/{}",
        table.len()
    );
}
