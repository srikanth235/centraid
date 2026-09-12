//! THE APP'S OWN DOOR, against a real vault (#1020, D-1020-T3d).
//!
//! `cargo test -p centraid-apps-tally --features vault-door`. The feature is
//! off by default so the app crate's own build does not link the vault; this
//! suite is what proves the adapter when it is on.
//!
//! What it asserts is the MAPPING, because that is where a port loses a state:
//! an executed command answers its output, a refused one answers `Failed` with
//! the condition's sentence, a command the build does not carry answers
//! `Failed` with the plane it needs, and a command nobody registered is the one
//! case that is an `Err` — the door itself is not there.

#![cfg(feature = "vault-door")]

use std::collections::BTreeMap;

use centraid_apps_tally::commands::{Commands, Invocation, Outcome};
use centraid_apps_tally::door::VaultDoor;
use centraid_vault::access::Principal;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Vault, VaultError};
use serde_json::json;

struct Scratch {
    dir: std::path::PathBuf,
    vault: Vault,
}

impl Scratch {
    fn founded(seed: &str) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(std::sync::Arc::new(FixedClock::frozen())),
            Box::new(SeededIds::new(seed)),
        )
        .expect("a vault is created");
        vault.found("Test", "Priya").expect("it is founded");
        Self { dir, vault }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn invocation(command: &'static str, input: serde_json::Value) -> Invocation {
    Invocation {
        command,
        input: input
            .as_object()
            .expect("an object")
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>(),
        // MANDATORY, and the vault's replay ledger is keyed on it.
        invoke_key: format!("test:{command}"),
        optional: false,
    }
}

#[test]
fn the_door_maps_every_state_the_surface_renders() {
    let scratch = Scratch::founded("door");
    let registry = Registry::with_system_commands().expect("the registry builds");
    registry
        .install(&scratch.vault)
        .expect("the record installs");
    let door = VaultDoor::new(&scratch.vault, &registry, Principal::owner("phone"));

    // EXECUTED: the output is the command's own, and a later call can use it.
    let added = door
        .invoke(&invocation("tally.add_friend", json!({ "name": "Ana" })))
        .expect("the door is there");
    let Outcome::Executed { output } = &added else {
        panic!("a friend was not added: {added:?}");
    };
    let ana = output["party_id"].as_str().expect("a party id").to_owned();
    assert_eq!(output["reused_party"], json!(false));

    // ENROLLING THE SAME PARTY AGAIN IS NOT A SECOND FRIEND: the command is
    // idempotent on the party, and the door hands back the same id.
    let again = door
        .invoke(&invocation(
            "tally.add_friend",
            json!({ "name": "Ana", "party_id": ana.clone() }),
        ))
        .expect("the door is there");
    assert_eq!(
        again.output().map(|output| output["reused_party"].clone()),
        Some(json!(true))
    );

    // FAILED, with the condition's own sentence — not an error, and not a
    // denial: the vault answered, and what it said is a fact about the ledger.
    let refused = door
        .invoke(&invocation(
            "tally.rename_group",
            json!({ "group_id": "nope", "name": "Trip" }),
        ))
        .expect("the door is there");
    assert_eq!(
        refused,
        Outcome::Failed {
            reason: Some("there is no group with that id".to_owned())
        }
    );

    // A PLANE THIS BUILD DOES NOT CARRY is also `Failed`, and the sentence
    // names it, so a shell can say what is missing.
    let deferred = door
        .invoke(&invocation(
            "tally.add_receipt_expense",
            json!({
                "description": "Receipt",
                "amount_minor": 100,
                "paid_by": ana,
                "category": "groceries",
                "splits": [{ "party_id": ana, "share_minor": 100 }],
                "staged_sha": "0".repeat(64),
                "ocr_text": "total 1.00",
                "line_items": []
            }),
        ))
        .expect("the door is there");
    let Outcome::Failed { reason } = &deferred else {
        panic!("the byte plane is not in this build: {deferred:?}");
    };
    assert!(
        reason.as_deref().unwrap_or_default().contains("media lane"),
        "{reason:?}"
    );

    // AN UNREGISTERED COMMAND is the one `Err`: the door itself cannot serve
    // it, and a surface must fail closed rather than render a state.
    let mut empty = Registry::new();
    empty
        .register(
            centraid_vault::commands::core::definitions()
                .into_iter()
                .next()
                .expect("there is one"),
        )
        .expect("it registers");
    let narrow = VaultDoor::new(&scratch.vault, &empty, Principal::owner("phone"));
    let unavailable = narrow
        .invoke(&invocation("tally.add_friend", json!({ "name": "Bo" })))
        .expect_err("a door that cannot serve the command fails closed");
    assert_eq!(unavailable.command, "tally.add_friend");
}

/// THE COMMAND PATH, TIMED (#1020, wave 4 lane Tally-finish).
///
/// The journey row is about a SCREEN, and a screen is a read; this is the other
/// half — what one write costs through the whole gate order, including the
/// invocation row, every precondition, the handler's own statements, the
/// postconditions and the receipt. Two hundred expenses, so the number is a
/// mean rather than one sample, and printed as projected provenance on
/// `ci-linux-x64-4c` rather than as a budget.
#[test]
fn two_hundred_expenses_through_the_real_command_path() {
    let scratch = Scratch::founded("bulk");
    let registry = Registry::with_system_commands().expect("the registry builds");
    registry
        .install(&scratch.vault)
        .expect("the record installs");
    let door = VaultDoor::new(&scratch.vault, &registry, Principal::owner("phone"));
    let owner =
        scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT self_party_id FROM core_vault LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .expect("the vault has an owner");
    let friend = door
        .invoke(&invocation("tally.add_friend", json!({ "name": "Ana" })))
        .expect("the door is there")
        .output()
        .expect("a friend")["party_id"]
        .as_str()
        .expect("a party id")
        .to_owned();
    let group = door
        .invoke(&invocation(
            "tally.create_group",
            json!({
                "name": "Flat",
                "icon": "house",
                "currency": "GBP",
                "member_ids": [friend.clone()]
            }),
        ))
        .expect("the door is there")
        .output()
        .expect("a group")["group_id"]
        .as_str()
        .expect("a group id")
        .to_owned();

    const WRITES: usize = 200;
    let started = std::time::Instant::now();
    for index in 0..WRITES {
        let mut call = invocation(
            "tally.add_expense",
            json!({
                "group_id": group,
                "description": format!("Expense {index}"),
                "amount_minor": 1_001,
                "paid_by": owner,
                "category": "groceries",
                "spent_on": "2099-05-04",
                "splits": [
                    { "party_id": owner, "share_minor": 501 },
                    { "party_id": friend, "share_minor": 500 }
                ]
            }),
        );
        // A DISTINCT KEY PER WRITE: the same key twice is a replay, and a
        // measurement of two hundred replays would be a measurement of the
        // ledger lookup.
        call.invoke_key = format!("bulk:{index}");
        let outcome = door.invoke(&call).expect("the door is there");
        assert!(
            matches!(outcome, Outcome::Executed { .. }),
            "write {index} did not execute: {outcome:?}"
        );
    }
    let elapsed = started.elapsed();
    println!(
        "tally/add_expense/command-path/ci-linux-x64-4c: {} writes in {} ms ({:.2} ms each)",
        WRITES,
        elapsed.as_millis(),
        elapsed.as_secs_f64() * 1_000.0 / WRITES as f64
    );
    // THE WRITES LANDED, counted through the app's own read path.
    let expenses = scratch
        .vault
        .read(|connection| {
            let read_door = centraid_apps_kit::testdoor::TestDoor::new(connection);
            Ok(centraid_apps_kit::reads::read_window(
                &read_door,
                &centraid_apps_tally::queries::expenses_statement(),
                2_000,
            )
            .expect("the ledger reads")
            .rows
            .len())
        })
        .expect("the ledger reads");
    assert_eq!(expenses, WRITES);
}

/// A DEMONSTRATED RED for the mandatory key: the same intent delivered twice
/// executes ONCE, and the second delivery is answered from the ledger.
#[test]
fn a_replayed_intent_executes_once() {
    let scratch = Scratch::founded("replay");
    let registry = Registry::with_system_commands().expect("the registry builds");
    registry
        .install(&scratch.vault)
        .expect("the record installs");
    let door =
        VaultDoor::new(&scratch.vault, &registry, Principal::owner("phone")).for_device("phone-1");
    let call = invocation("tally.add_friend", json!({ "name": "Cleo" }));
    let first = door.invoke(&call).expect("the door is there");
    assert!(matches!(first, Outcome::Executed { .. }));
    let second = door.invoke(&call).expect("the door is there");
    // The replay answers Executed with no output — the handler did not run
    // again, which is the whole point of the ledger.
    assert!(matches!(second, Outcome::Executed { .. }));
    // Counted through the APP's own read path — a statement as data through
    // the kit's door — because an app crate holds no SQL, and its tests are
    // scanned by `sql-confinement` for exactly the same reason its handlers
    // are.
    let friends = scratch
        .vault
        .read(|connection| {
            let door = centraid_apps_kit::testdoor::TestDoor::new(connection);
            Ok(centraid_apps_kit::reads::read_window(
                &door,
                &centraid_apps_tally::queries::friends_statement(),
                10,
            )
            .expect("the roster reads")
            .rows
            .len())
        })
        .expect("the roster reads");
    assert_eq!(friends, 1, "a duplicate delivery enrolled a second friend");
    // And the vault's own error type is what an absent door is NOT: the two
    // are different failures and the test names both.
    let _ = VaultError::UnknownCommand {
        name: "tally.nothing".to_owned(),
    };
}
