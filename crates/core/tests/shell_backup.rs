//! THE SHELL'S `backup-status` QUERY, AGAINST A REAL GATEWAY (#1135, lane H2).
//!
//! The Backup screen and Home's line read the backup through a named query, not
//! a door of their own, and re-read when the ledger moves. The ledger is not a
//! vault table, so the core announces a change to the `backup` pseudo-table
//! after every door that moves it; these cases hold both halves.

mod common;

use std::collections::BTreeSet;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::Handle;

use common::*;

fn query(handle: &Handle) -> (wire::ShellBackupStatus, Vec<String>) {
    let loaded = handle
        .load(&wire::LoadRequest {
            app: "shell".to_owned(),
            query: "backup-status".to_owned(),
            ..Default::default()
        })
        .expect("the shell answers its own query");
    let Some(wire::app_query_response::Answer::ShellBackupStatus(answer)) =
        loaded.answer.and_then(|answer| answer.answer)
    else {
        panic!("backup-status answers as the shell's backup status");
    };
    (answer, loaded.tables)
}

/// The tables the change events queued so far name.
fn changed(handle: &Handle) -> BTreeSet<String> {
    let mut tables = BTreeSet::new();
    while let Some(event) = handle
        .next_event(Duration::from_millis(50))
        .expect("the event door answers")
    {
        if let Some(wire::event::Kind::Change(change)) = event.kind {
            tables.insert(change.table);
        }
    }
    tables
}

#[test]
fn the_query_reads_the_ledger_the_door_reads_and_names_what_moves_it() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());

    // UNPAIRED: an answer, not a refusal, and the same reading the door gives.
    let (answer, tables) = query(&phone);
    let status = answer.status.expect("a reading");
    assert!(status.destinations.is_empty());
    assert_eq!(status, self::status(&phone));
    assert!(
        answer.now_ms > 1_700_000_000_000,
        "this phone's clock is stamped"
    );
    // THE LEDGER'S PSEUDO-TABLE AND THE CONTENT THE COUNTS ARE MADE OF, sorted.
    assert_eq!(tables, vec!["backup".to_owned(), "blob".to_owned()]);

    let paired = pair(&phone, &gateway);
    let destination = paired.destination.expect("the gateway this pairing added");
    let (answer, _) = query(&phone);
    let status = answer.status.expect("a reading");
    assert_eq!(status, self::status(&phone));
    assert_eq!(status.destinations.len(), 1);
    assert_eq!(status.destinations[0].gateway_id, destination.gateway_id);
}

#[test]
fn a_door_that_moves_the_ledger_announces_it_and_one_that_only_reads_does_not() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    changed(&phone);

    // READING IS NOT A CHANGE.
    self::status(&phone);
    query(&phone);
    assert!(!changed(&phone).contains("backup"));

    // A PAIRING, A PASS AND A FORGET each move it, and are announced.
    let paired = pair(&phone, &gateway);
    assert!(changed(&phone).contains("backup"), "a pairing");
    drain(&phone, at_home());
    assert!(changed(&phone).contains("backup"), "a pass");
    let wire::response::Kind::ForgetDestination(forgot) = ask(
        &phone,
        wire::request::Kind::ForgetDestination(wire::ForgetDestinationRequest {
            gateway_id: paired.destination.expect("a gateway").gateway_id,
        }),
    ) else {
        panic!("a forget answers");
    };
    assert!(forgot.forgotten);
    assert!(changed(&phone).contains("backup"), "a forget");
    assert!(
        query(&phone)
            .0
            .status
            .expect("a reading")
            .destinations
            .is_empty()
    );
}

#[test]
fn an_unknown_shell_query_is_refused_by_name() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let refused = phone
        .load(&wire::LoadRequest {
            app: "shell".to_owned(),
            query: "no-such-query".to_owned(),
            ..Default::default()
        })
        .expect_err("the shell declares no such query");
    assert!(refused.to_string().contains("no-such-query"));
}
