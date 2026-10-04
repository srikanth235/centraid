//! A RESTORE AT ITS EDGES, THROUGH THE CORE'S DOORS, AGAINST A REAL GATEWAY
//! (#1080, the adversarial sweep).
//!
//! What a restore owes a member whatever goes wrong: words that are not
//! theirs are refused before anything is asked; damage on the gateway is
//! refused before any claim, so the old phone goes on backing up; a restore
//! cut short leaves nothing that stops the next one; and whoever claims last
//! is the one writer, with every phone it superseded frozen and saying so.

mod common;

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use serde_json::json;

use common::*;

fn note(handle: &centraid_core::Handle, title: &str, body: &str) {
    command(
        handle,
        "knowledge.create_note",
        &json!({ "title": title, "body_text": body, "format": "plain" }),
        &format!("note:{title}"),
    );
}

/// **A RESTORE KILLED BETWEEN ITS CHECK AND ITS CLAIM IS FINISHED BY THE
/// NEXT ONE** (#1080, R3). The first attempt fetched and checked the vault
/// and died before it claimed anything: no writer epoch moved, and the old
/// phone is still the writer. What it laid down must not read to the next
/// attempt as a vault this phone already holds, or that vault is never
/// claimed — the old phone goes on as the writer, and the new phone keeps a
/// copy nothing backs up.
#[test]
fn a_restore_killed_before_its_claim_is_finished_by_the_next_one() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the phone was lost");
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let runtime = runtime();
    let killed = std::panic::catch_unwind(AssertUnwindSafe(|| {
        centraid_core::phone::restore::run_observed(
            &new_dir.path().join("custody.db"),
            &wire::RestoreRequest {
                phrase: WORDS.to_owned(),
                payload: gateway.payload(),
                ..wire::RestoreRequest::default()
            },
            runtime.handle(),
            &mut |_| panic!("the phone dies between the check and the claim"),
        )
    }));
    assert!(killed.is_err(), "the first attempt died");
    assert_eq!(gateway.writer(&vault_id()).0, 1, "nothing was claimed");

    // THE MEMBER OPENS THE APP AGAIN AND RESTORES AGAIN.
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(
        restored.vaults.len(),
        1,
        "the vault comes back: {restored:?}"
    );
    assert_eq!(gateway.writer(&vault_id()).0, 2, "one claim, one epoch");
    let path = PathBuf::from(&restored.vaults[0].path);
    assert_eq!(rows(&path), rows(&old_path), "row for row");
    let refused = try_drain(&old, at_home()).expect_err("the old phone is superseded");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    let phone = reopen(&path);
    assert_eq!(
        status(&phone).destinations.len(),
        1,
        "the restored vault is paired"
    );
    let next = drain(&phone, at_home());
    assert!(
        next.acked_at_ms.is_some(),
        "the restored phone backs up: {next:?}"
    );
}
