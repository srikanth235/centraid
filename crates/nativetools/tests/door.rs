//! The harness's `Door` (`vaultio::Handle`): what the runtime relies on it for.

mod common;

use centraid_nativetools::vaultio::{Door, Handle, SetClock};
use common::seeded;
use serde_json::json;

fn handle(world: &common::World, seed: &str) -> Handle {
    Handle::open(world.path(), SetClock::at(1_800_000_000_000), seed).expect("the vault opens")
}

#[test]
fn a_step_moves_the_clock_a_second_and_a_run_does_not() {
    let world = seeded();
    let door = handle(&world, "door:clock");
    let before = door.now_ms();
    door.run("not.a_command", json!({}))
        .expect_err("an unknown command is an error");
    assert_eq!(door.now_ms(), before, "a run leaves the clock");
    door.advance();
    assert_eq!(door.now_ms(), before + 1000);
    // `step` is `advance` then `run`: the refused command still moved the clock
    let _ = door.step("not.a_command", json!({}));
    assert_eq!(door.now_ms(), before + 2000);
}

#[test]
fn ids_come_from_the_seeded_sequence() {
    let world = seeded();
    let (a, b) = (handle(&world, "door:ids"), handle(&world, "door:ids"));
    let first: Vec<String> = (0..3).map(|_| a.mint_id()).collect();
    let second: Vec<String> = (0..3).map(|_| b.mint_id()).collect();
    assert_eq!(first, second, "the same seed mints the same ids");
    assert_eq!(
        first.len(),
        first
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    );
}

#[test]
fn a_sealed_cell_opens_under_the_key_it_was_sealed_with() {
    let world = seeded();
    let door = handle(&world, "door:seal");
    let (key_id, sealed) = door.seal("item-1", "hunter2").expect("it seals");
    assert_ne!(sealed, "hunter2");
    assert_eq!(
        door.unseal(&key_id, "item-1", &sealed).as_deref(),
        Ok("hunter2")
    );
    assert!(
        door.unseal(&key_id, "item-2", &sealed).is_err(),
        "bound to its item"
    );
}
