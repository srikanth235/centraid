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
fn a_typed_secret_is_sealed_by_the_door_under_the_key_and_bound_to_its_item() {
    let world = seeded();
    let door = handle(&world, "door:seal");
    let ran = door
        .run(
            "locker.add_item",
            serde_json::json!({
                "item_id": "item-sealed", "type": "login", "title": "Gym", "password": "hunter2"
            }),
        )
        .expect("the door answers");
    assert!(ran.ok, "{:?}", ran.reason);
    let rows = door
        .table_where(
            "locker_item",
            "id, key_id, password",
            "id",
            "id",
            "id = ?",
            &["item-sealed".to_owned()],
        )
        .expect("the owner reads");
    let [row] = rows.as_slice() else {
        panic!("the item: {rows:?}");
    };
    let text = |column: &str| match row.get(column) {
        Some(centraid_apps_kit::row::Cell::Text(text)) => text.clone(),
        other => panic!("{column}: {other:?}"),
    };
    let (key_id, sealed) = (text("key_id"), text("password"));
    assert_ne!(sealed, "hunter2");
    let open = |item: &str| {
        centraid_vault::custody::locker_key::decrypt_under_locker_key(
            centraid_nativetools::vaultio::HARNESS_LOCKER_KEY,
            &key_id,
            item,
            &sealed,
        )
    };
    assert_eq!(open("item-sealed").ok().as_deref(), Some("hunter2"));
    assert!(open("item-2").is_err(), "bound to its item");
}
