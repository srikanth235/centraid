//! **RESTORE OVER A VAULT THAT FAILED TO OPEN AS DAMAGED** (#1191, decision 35), through the
//! core's doors against a real gateway.
//!
//! A vault with one page overwritten does not open (`VaultError::Damaged`, `-6` at the ABI). A
//! shell then asks for a handle that opens no vault over the same path (`restoreDamaged`), and
//! the existing restore replaces that vault, by an atomic rename, only after its snapshot
//! checked. Until then the damaged file is byte-for-byte untouched.

mod common;

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig};
use centraid_vault::pagesource::{self, PinnedPages};
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

/// A vault backed up to `gateway`, kept where a shelf keeps it (`<root>/<id>/vault.db`), then
/// damaged: one table's leaf page overwritten. Answers the root, the path and the rows it had.
fn backed_up_then_damaged(
    gateway: &Gateway,
) -> (
    tempfile::TempDir,
    PathBuf,
    std::collections::BTreeMap<String, Vec<String>>,
) {
    // THE OLD PHONE, then the restore that puts its vault where a shelf keeps one.
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, gateway);
    note(&old, "Backed up before the damage");
    drain(&old, at_home());
    let root = tempfile::tempdir().expect("a directory");
    let restored = restore(root.path(), gateway);
    let path = PathBuf::from(&restored.vaults[0].path);
    let rows_before = rows(&path);

    // Fold the WAL into the file, then damage a table leaf in it.
    pagesource::fold_wal(&path).expect("folds");
    let mut bytes = std::fs::read(&path).expect("reads");
    let (page_size, leaf) = {
        let pinned = PinnedPages::begin(&path).expect("a pin");
        let size = usize::try_from(pinned.page_size()).expect("a size");
        let root = pinned.root_page("person").expect("reads").expect("a table");
        pinned.end().expect("ends");
        (size, usize::try_from(root).expect("a page") - 1)
    };
    assert_eq!(bytes[leaf * page_size], 0x0d, "a table leaf");
    for offset in 3..11 {
        bytes[leaf * page_size + offset] = 0xff;
    }
    std::fs::write(&path, &bytes).expect("damages");
    (root, path, rows_before)
}

fn restore_request(payload: String) -> wire::RestoreRequest {
    wire::RestoreRequest {
        phrase: WORDS.to_owned(),
        payload,
        confirm_unproven: true,
        ..wire::RestoreRequest::default()
    }
}

fn hash_of(path: &Path) -> blake3::Hash {
    blake3::hash(&std::fs::read(path).expect("reads"))
}

/// A real vault backed up to a gateway, one page overwritten: it will not open; the handle for a
/// restore opens no vault and reads nothing; the restore replaces the file and the vault opens
/// and holds the backed-up rows.
#[test]
fn a_damaged_vault_is_restored_over_through_a_handle_that_holds_no_vault() {
    let gateway = gateway();
    let (root, path, rows_before) = backed_up_then_damaged(&gateway);
    let damaged_bytes = hash_of(&path);
    assert!(
        matches!(
            Core::open(CoreConfig::new(&path)),
            Err(centraid_core::CoreError::Vault(
                centraid_vault::VaultError::Damaged { .. }
            ))
        ),
        "the damaged vault does not open"
    );

    // THE HANDLE THAT HOLDS NO VAULT: it opened nothing and read nothing.
    let door = Core::open(CoreConfig::new(&path).without_vault()).expect("a handle with no vault");
    assert!(!door.holds_a_replica());
    assert_eq!(hash_of(&path), damaged_bytes, "the file was not touched");

    let wire::response::Kind::Restore(restored) = ask(
        &door,
        wire::request::Kind::Restore(restore_request(gateway.payload())),
    ) else {
        panic!("a restore answers as a restore");
    };
    keep_restored(&restored);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert_eq!(
        PathBuf::from(&restored.vaults[0].path),
        path,
        "the same vault, in the same place"
    );
    assert_ne!(hash_of(&path), damaged_bytes, "the file was replaced");
    drop(door);
    let vault = centraid_vault::Vault::open(&path).expect("the vault opens now");
    vault.close().expect("closes");
    assert_eq!(rows(&path), rows_before, "the backed-up rows");
    drop(root);
}

/// **CANCELLED OR FAILED, THE DAMAGED FILE IS UNCHANGED** and the next open is `Damaged` again.
#[test]
fn a_restore_that_dies_before_its_claim_leaves_the_damaged_file_as_it_was() {
    let gateway = gateway();
    let (root, path, _) = backed_up_then_damaged(&gateway);
    let damaged_bytes = hash_of(&path);
    let epoch = gateway.writer(&vault_id()).0;
    let runtime = runtime();
    let killed = std::panic::catch_unwind(AssertUnwindSafe(|| {
        centraid_core::phone::restore::run_over_damaged_observed(
            &path,
            &restore_request(gateway.payload()),
            runtime.handle(),
            &mut |_| panic!("the phone dies between the check and the claim"),
        )
    }));
    assert!(killed.is_err(), "the restore died");
    assert_eq!(hash_of(&path), damaged_bytes, "byte for byte as it was");
    assert_eq!(gateway.writer(&vault_id()).0, epoch, "no claim landed");
    assert!(
        matches!(
            Core::open(CoreConfig::new(&path)),
            Err(centraid_core::CoreError::Vault(
                centraid_vault::VaultError::Damaged { .. }
            ))
        ),
        "the next launch is damaged again"
    );
    drop(root);
}
