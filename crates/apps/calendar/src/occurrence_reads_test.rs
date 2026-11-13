//! The days of a series that were skipped or moved, read for a series that holds more of them than
//! a page does. A day's key is the series, the day and its scope, and both scopes can name the same
//! day, so a read keyed on the series and the day alone loses the other scope's row where a page
//! ends between the two.

use std::cell::Cell as Counter;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

use super::*;

struct Counting<'a> {
    inner: TestDoor<'a>,
    pages: Counter<usize>,
}

impl PageDoor for Counting<'_> {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        if query.name == "calendar.events.occurrences" {
            self.pages.set(self.pages.get() + 1);
        }
        self.inner.page(query, request)
    }
}

#[test]
fn every_day_of_a_series_keeps_both_scopes_past_a_page() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = Vault::create(dir.join("vault.db")).expect("a vault");
    vault.found("Home", "Owner").expect("founded");
    let registry = Registry::with_system_commands().expect("a registry");
    let run = |name: &str, input: Value| -> Value {
        let outcome = vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    };
    let series = run(
        "event.propose",
        json!({ "title": "Daily", "starts": "2026-01-01T09:00", "ends": "2026-01-01T09:30", "zone": "Etc/UTC",
                "rule": "FREQ=DAILY" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // A page holds 500 rows: 251 days with a row for each scope is 502, so the first page ends
    // between the two rows of a day.
    let days: Vec<String> = (0..251)
        .map(|at| {
            let day = chrono_free_day(at);
            format!("{day}T09:00:00")
        })
        .collect();
    for day in &days {
        run(
            "event.edit_occurrence",
            json!({ "id": series, "original_start": day, "scope": "occurrence",
                    "action": "skip" }),
        );
        run(
            "event.edit_occurrence",
            json!({ "id": series, "original_start": day, "scope": "future",
                    "action": "override", "title": "Later" }),
        );
    }
    let (rows, pages) = vault
        .read(|connection| {
            let door = Counting {
                inner: TestDoor::new(connection),
                pages: Counter::new(0),
            };
            let event = EventRow {
                event_id: series.clone(),
                rrule: Some("FREQ=DAILY".to_owned()),
                ..EventRow::default()
            };
            let rows = read_exceptions(&door, &[event]).expect("reads");
            Ok((rows, door.pages.get()))
        })
        .expect("a read");
    assert_eq!(rows.len(), 502, "both scopes of every day");
    let distinct: BTreeSet<(Option<String>, Option<String>)> = rows
        .iter()
        .map(|row| (row.original_start_local.clone(), row.scope.clone()))
        .collect();
    assert_eq!(distinct.len(), 502, "none twice");
    // One read a scope: 251 rows each, one page apiece.
    assert_eq!(pages, 2);
    let _ = std::fs::remove_dir_all(dir);
}

/// `2026-01-01` plus `at` days, without a calendar crate.
fn chrono_free_day(at: u32) -> String {
    let lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let (mut month, mut day) = (0usize, at);
    while day >= lengths[month] {
        day -= lengths[month];
        month += 1;
    }
    format!("2026-{:02}-{:02}", month + 1, day + 1)
}
