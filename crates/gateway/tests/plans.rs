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

/// What is wrong with a plan, or nothing.
fn complaints(statement: &str, plan: &[String]) -> Vec<String> {
    let mut found = Vec::new();
    if statement.to_ascii_uppercase().contains("OFFSET") {
        found.push("pages by OFFSET".to_owned());
    }
    for step in plan {
        if step.starts_with("SCAN") {
            found.push(format!("scans: {step}"));
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
    for (name, statement) in LISTINGS {
        let plan = state.query_plan(statement).expect("plans");
        for complaint in complaints(statement, &plan) {
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
    for (what, statement) in [
        ("a scan", include_str!("fixtures/planted_scan.sql")),
        ("a sort", include_str!("fixtures/planted_sort.sql")),
        ("an offset", include_str!("fixtures/planted_offset.sql")),
    ] {
        let plan = state.query_plan(statement).expect("plans");
        assert!(
            !complaints(statement, &plan).is_empty(),
            "{what} passed the plan test: {plan:?}"
        );
    }
}
