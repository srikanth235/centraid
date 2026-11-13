//! EVERY PAGE SEEKS (#1191, B7, E14).
//!
//! A listing that scans or sorts is a listing whose cost grows with the table
//! behind it, and a gateway's `object` table is the library: millions of
//! rows. Every statement `sql::LISTINGS` names is a keyset page — the last
//! row's key and a limit, never an offset — and SQLite must plan it as a
//! search of an index, with no scan and no temporary sort. The test asks
//! SQLite for each plan, and the scan it would catch is planted below to show
//! the test can see one.

use centraid_gateway::server::sql::LISTINGS;
use centraid_gateway::server::state::SqliteState;

/// What is wrong with a plan, or nothing. `index` is the index the statement
/// must walk, when one is named for it.
fn complaints(statement: &str, plan: &[String], index: Option<&str>) -> Vec<String> {
    let mut found = Vec::new();
    if let Some(index) = index
        && !plan.iter().any(|step| {
            step.contains(&format!("USING INDEX {index}"))
                || step.contains(&format!("USING COVERING INDEX {index}"))
        })
    {
        found.push(format!("does not walk the index {index}"));
    }
    if statement.to_ascii_uppercase().contains("OFFSET") {
        found.push("pages by OFFSET".to_owned());
    }
    for step in plan {
        // A scan of the partial index named for the statement visits only
        // the rows the statement is about (every held snapshot, say), which
        // is not a scan of a table that grows with the library.
        let of_named_index =
            index.is_some_and(|index| step.contains(&format!("USING INDEX {index}")));
        if step.starts_with("SCAN") && !of_named_index {
            found.push(format!("scans: {step}"));
        }
        // A subquery the planner lists, and the bloom filter it builds, are
        // not a scan or a sort.
        if step.starts_with("LIST SUBQUERY") || step.starts_with("CREATE BLOOM FILTER") {
            continue;
        }
        if step.contains("TEMP B-TREE") {
            found.push(format!("sorts: {step}"));
        }
        if !step.starts_with("SEARCH") && !step.starts_with("SCAN") && !step.contains("TEMP B-TREE")
        {
            found.push(format!("an unexpected step: {step}"));
        }
    }
    if plan.is_empty() {
        found.push("no plan at all".to_owned());
    }
    found
}

#[test]
fn every_listing_seeks() {
    let state = SqliteState::in_memory().expect("opens");
    let mut failures = Vec::new();
    for (name, statement, index) in LISTINGS {
        let plan = state.query_plan(statement).expect("plans");
        for complaint in complaints(statement, &plan, *index) {
            failures.push(format!("{name}: {complaint}\n    plan: {plan:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "a listing that does not seek:\n{}",
        failures.join("\n")
    );
}

/// The test itself sees a scan, a sort and an offset when one is planted.
#[test]
fn the_plan_test_sees_a_scan_a_sort_and_an_offset() {
    let state = SqliteState::in_memory().expect("opens");
    for (what, statement, index) in [
        ("a scan", include_str!("fixtures/planted_scan.sql"), None),
        ("a sort", include_str!("fixtures/planted_sort.sql"), None),
        (
            "an offset",
            include_str!("fixtures/planted_offset.sql"),
            None,
        ),
        // A primary-key walk that filters held rows page by page: it seeks,
        // but not the partial index that makes it cost the held rows only.
        (
            "a primary-key walk over held rows",
            include_str!("fixtures/planted_held_walk.sql"),
            Some("object_held"),
        ),
    ] {
        let plan = state.query_plan(statement).expect("plans");
        assert!(
            !complaints(statement, &plan, index).is_empty(),
            "{what} passed the plan test: {plan:?}"
        );
    }
}
