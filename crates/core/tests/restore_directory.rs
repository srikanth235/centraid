//! THE SEALED DIRECTORY AND THE NEWEST BACKUP (#1191, E8, B8), through the core's doors against
//! real gateways.
//!
//! Every snapshot names a sealed directory of the member's gateways. A restore that reaches one
//! gateway learns the rest from it, reads each head, restores the greatest, and, when it cannot
//! prove it holds the newest, claims nothing until the member says yes.

mod common;

use centraid_api_proto::core_v1 as wire;
use serde_json::json;

use common::*;

fn note(handle: &centraid_core::Handle, title: &str) {
    command(
        handle,
        "note.create",
        &json!({ "title": title, "body": "a note", "format": "plain" }),
        &format!("note:{title}"),
    );
}

fn restore_request(payload: String, confirm: bool) -> wire::RestoreRequest {
    wire::RestoreRequest {
        phrase: WORDS.to_owned(),
        payload,
        confirm_unproven: confirm,
        ..wire::RestoreRequest::default()
    }
}

fn restore_as_asked(dir: &std::path::Path, request: wire::RestoreRequest) -> wire::RestoreResponse {
    let wire::response::Kind::Restore(restored) =
        ask(&shelf(dir), wire::request::Kind::Restore(request))
    else {
        panic!("a restore answers as a restore");
    };
    keep_restored(&restored);
    restored
}

/// **A DIRECTORY THAT LISTS ONE GATEWAY PROVES NOTHING ABOUT A NEWER BACKUP**: the restore claims
/// nothing and says which backup it found; the member's yes takes it.
#[test]
fn a_restore_that_cannot_prove_the_newest_claims_nothing_until_the_member_says_yes() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    note(&phone, "Before");
    drain(&phone, at_home());
    let epoch = gateway.writer(&vault_id()).0;

    let new_dir = tempfile::tempdir().expect("a directory");
    let asked = restore_as_asked(new_dir.path(), restore_request(gateway.payload(), false));
    assert!(asked.vaults.is_empty(), "nothing restored: {asked:?}");
    assert_eq!(asked.unproven_newest.len(), 1, "{asked:?}");
    assert!(asked.unproven_newest[0].taken_at_ms > 0);
    assert!(!asked.unproven_newest[0].label.is_empty());
    assert_eq!(gateway.writer(&vault_id()).0, epoch, "no writer moved");
    assert!(
        !new_dir.path().join("vaults").exists()
            || std::fs::read_dir(new_dir.path().join("vaults"))
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true),
        "nothing was left on the phone"
    );

    let yes = restore_as_asked(new_dir.path(), restore_request(gateway.payload(), true));
    assert_eq!(yes.vaults.len(), 1, "the member said yes: {yes:?}");
    assert!(yes.unproven_newest.is_empty());
    assert_eq!(gateway.writer(&vault_id()).0, epoch + 1, "one claim");
}

/// **THE NEWEST BACKUP IS FOUND ACROSS THE MEMBER'S GATEWAYS**: the gateway scanned holds an older
/// head, the directory it names lists another that answers with a greater one, and that is the
/// backup restored, with no question asked.
#[test]
fn the_greatest_head_across_the_directory_is_the_backup_restored() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &first);
    pair(&phone, &second);
    note(&phone, "Old");
    drain(&phone, at_home());
    // THE FIRST GATEWAY GOES AWAY; the second takes the newer snapshot alone.
    first.cable().cut();
    note(&phone, "Newer, held only by the second");
    drain(&phone, at_home());
    first.cable().mend();
    assert_ne!(
        first.writer(&vault_id()).1,
        second.writer(&vault_id()).1,
        "the heads differ"
    );

    let new_dir = tempfile::tempdir().expect("a directory");
    // SCANNED AT THE OLDER GATEWAY, with no yes given: both listed gateways answer, so the newest
    // is proven.
    let restored = restore_as_asked(new_dir.path(), restore_request(first.payload(), false));
    assert!(restored.unproven_newest.is_empty(), "{restored:?}");
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    let restored_path = std::path::PathBuf::from(&restored.vaults[0].path);
    assert_eq!(
        rows(&restored_path),
        rows(&path),
        "the newer backup, row for row"
    );
    assert_eq!(
        second.writer(&vault_id()).0,
        2,
        "the claim landed at the gateway the newest was read from"
    );
    // AND AT THE OTHER LISTED GATEWAY THAT ANSWERED, naming the head it checked there.
    assert_eq!(first.writer(&vault_id()).0, 2, "claimed at both");
    assert!(
        restored.unclaimed.is_empty(),
        "nothing was left unclaimed: {restored:?}"
    );
    assert_eq!(restored.tokens.len(), 2, "a token for each gateway");
    // THE OLD PHONE IS REFUSED AT BOTH: its next pass is superseded.
    let refused = try_drain(&phone, at_home()).expect_err("the old phone is superseded");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    // THE RESTORED PHONE BACKS UP TO BOTH.
    let again = reopen(&restored_path);
    let next = drain(&again, at_home());
    assert!(next.acked_at_ms.is_some(), "{next:?}");
    assert_eq!(
        first.writer(&vault_id()).1,
        second.writer(&vault_id()).1,
        "both gateways hold the same head again"
    );
}

/// **A LISTED GATEWAY THAT DOES NOT ANSWER MAKES THE NEWEST UNPROVEN**: the restore says what it
/// found and claims nothing.
#[test]
fn a_listed_gateway_that_does_not_answer_leaves_the_newest_unproven() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &first);
    pair(&phone, &second);
    note(&phone, "Held at both");
    drain(&phone, at_home());
    second.cable().cut();

    let new_dir = tempfile::tempdir().expect("a directory");
    let asked = restore_as_asked(new_dir.path(), restore_request(first.payload(), false));
    assert!(asked.vaults.is_empty(), "{asked:?}");
    assert_eq!(asked.unproven_newest.len(), 1, "{asked:?}");
    assert_eq!(first.writer(&vault_id()).0, 1, "no writer moved");

    // THE MEMBER SAYS YES: claimed at the gateway that answered, the other reported.
    let yes = restore_as_asked(new_dir.path(), restore_request(first.payload(), true));
    assert_eq!(yes.vaults.len(), 1, "{yes:?}");
    assert_eq!(first.writer(&vault_id()).0, 2, "claimed where it answered");
    assert_eq!(second.writer(&vault_id()).0, 1, "not where it did not");
    assert!(
        yes.unclaimed.iter().any(|left| !left.claimed),
        "the gateway that did not answer is reported: {yes:?}"
    );
}
