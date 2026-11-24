//! Full 228-action catalog coverage and runtime smoke tests for Wave 3.

mod common;

use centraid_nativetools::meta::{
    ACTIONS, ALL_MANIFEST_ACTIONS, ActionSurface, DECLARED_KINDS, DECLARED_VERBS, KINDS, Kind,
};
use common::{call, number, seeded, settled, trashed_number};
use serde_json::json;

#[test]
fn all_228_manifest_actions_and_28_kinds_are_live() {
    assert!(DECLARED_KINDS.is_empty(), "every kind is live");
    assert!(DECLARED_VERBS.is_empty(), "every verb is live");
    assert_eq!(Kind::ALL.len(), 28, "all 28 kinds are live");
    assert_eq!(KINDS.len(), 28, "all 28 KindSpecs are live");

    assert_eq!(
        ALL_MANIFEST_ACTIONS.len(),
        228,
        "all 228 manifest actions are represented"
    );
    let direct = ALL_MANIFEST_ACTIONS
        .iter()
        .filter(|action| action.surface == ActionSurface::Direct)
        .count();
    let handoff = ALL_MANIFEST_ACTIONS
        .iter()
        .filter(|action| action.surface == ActionSurface::Handoff)
        .count();
    assert_eq!(direct, 205, "205 direct actions");
    assert_eq!(handoff, 23, "23 handoff actions");
    assert!(!ACTIONS.is_empty());
}

#[test]
fn handoff_actions_emit_handoff_cards_without_writing_the_vault() {
    let world = seeded();
    let before = common::journal(&world);
    let mut session = world.session();
    session.user("export my notes");
    let response = call(&mut session, "act", json!({"verb": "export", "kind": "note"}));
    assert_eq!(response["ends_turn"], json!(true), "{response}");
    let actions = response["effect"]["member_actions"]
        .as_array()
        .expect("handoff emits effect.member_actions");
    assert!(
        actions.iter().any(|action| {
            action["action"] == json!("handoff")
                && action["field"] == json!("notes/note/export-notes")
        }),
        "expected MemberAction::Handoff in {response}"
    );
    assert_eq!(
        common::journal(&world),
        before,
        "handoff must not write to the vault"
    );
}

fn confirm_destructive(
    session: &mut centraid_nativetools::Session,
    args: serde_json::Value,
) -> serde_json::Value {
    session.user("");
    let ask = call(session, "act", args.clone());
    assert!(
        ask["effect"]["ask"].is_object() && ask["effect"]["confirm"]["confirmed"] == json!(false),
        "expected confirm_ask on turn 1: {ask}"
    );
    session.user("yes");
    let confirmed = call(session, "act", args);
    assert!(
        confirmed["effect"]["diff"].is_object()
            && !confirmed["text"]
                .as_str()
                .unwrap_or_default()
                .starts_with("error:"),
        "expected confirmed execution on turn 2: {confirmed}"
    );
    confirmed
}

#[test]
fn newly_closed_direct_actions_run_through_the_runtime() {
    let world = seeded();
    let mut session = world.session();

    // duplicate (locker_item)
    let bank = number(&mut session, "locker item", "Bank");
    let dup = settled(&mut session, "act", json!({"verb": "duplicate", "rows": bank}));
    assert!(
        !dup["text"].as_str().unwrap_or_default().starts_with("error:"),
        "duplicate failed: {dup}"
    );

    // apply (rule)
    let rule = number(&mut session, "rule", "BLUE BOTTLE");
    let applied = settled(&mut session, "act", json!({"verb": "apply", "rows": rule}));
    assert!(
        !applied["text"].as_str().unwrap_or_default().starts_with("error:"),
        "apply failed: {applied}"
    );

    // purge (trashed task) — confirmation: required (2-turn confirm_ask -> yes)
    let library = trashed_number(&mut session, "task", "Library");
    let _purged = confirm_destructive(&mut session, json!({"verb": "purge", "rows": library}));

    // empty_trash (task) — confirmation: required (2-turn confirm_ask -> yes)
    let reed = number(&mut session, "task", "reed");
    let _ = settled(&mut session, "act", json!({"verb": "delete", "rows": reed}));
    let _emptied = confirm_destructive(&mut session, json!({"verb": "empty_trash", "kind": "task"}));

    // categorize (transaction)
    let tx = number(&mut session, "transaction", "To savings");
    let cat = settled(
        &mut session,
        "act",
        json!({"verb": "categorize", "rows": tx, "args": "category: Pets fund"}),
    );
    assert!(
        !cat["text"].as_str().unwrap_or_default().starts_with("error:"),
        "categorize failed: {cat}"
    );

    // respond (event)
    let tabla = number(&mut session, "event", "Tabla");
    let rsvp = settled(
        &mut session,
        "act",
        json!({"verb": "respond", "rows": tabla, "args": "answer: accepted"}),
    );
    assert!(
        !rsvp["text"].as_str().unwrap_or_default().starts_with("error:"),
        "respond failed: {rsvp}"
    );

    // merge (category) — confirmation: required (2-turn confirm_ask -> yes)
    session.user("");
    let temp_cat = settled(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "category", "args": {"name": "Temp cat"}}),
    );
    assert!(
        temp_cat["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("created"),
        "create category failed: {temp_cat}"
    );
    let src = number(&mut session, "category", "Temp cat");
    let dst = number(&mut session, "category", "Pets fund");
    let _merged = confirm_destructive(
        &mut session,
        json!({"verb": "merge", "rows": src, "args": format!("into: {dst}")}),
    );

    // recolor (document)
    let w2 = number(&mut session, "document", "W2");
    let _ = settled(
        &mut session,
        "act",
        json!({"verb": "tag", "rows": w2, "args": "label: urgent"}),
    );
    session.user("");
    let recolored = settled(
        &mut session,
        "act",
        json!({"verb": "recolor", "rows": w2, "args": "label: urgent\ncolor: blue"}),
    );
    assert!(
        !recolored["text"].as_str().unwrap_or_default().starts_with("error:"),
        "recolor failed: {recolored}"
    );

    // style-container (edit:color on list)
    let home = number(&mut session, "list", "Home");
    let styled = settled(
        &mut session,
        "act",
        json!({"verb": "edit:color", "rows": home, "args": "color: blue"}),
    );
    assert!(
        !styled["text"].as_str().unwrap_or_default().starts_with("error:"),
        "style-container failed: {styled}"
    );
}
