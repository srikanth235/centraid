//! Lands WITH the `SQLITE_DBCONFIG_DEFENSIVE` change in `crates/vault/src/file.rs` (#1191 B11).

mod common;

use centraid_vault::pagesource::PinnedPages;
use common::{Scratch, insert_note};

fn grow(vault: &centraid_vault::Vault, rounds: usize, tag: &str) {
    for round in 0..rounds {
        insert_note(vault, &format!("{tag} {round} {}", "x".repeat(900))).expect("commits");
    }
}

#[test]
fn the_page_table_cannot_be_written_through_the_vaults_own_connection() {
    let scratch = Scratch::founded("defensive").expect("a vault");
    grow(&scratch.vault, 5, "def");
    let path = scratch.join("vault.db");
    let before = {
        let mut pinned = PinnedPages::begin(&path).expect("pins");
        let first = pinned.range(0).expect("reads").to_vec();
        pinned.end().expect("ends");
        first
    };
    let refused = scratch.vault.commit(|tx| {
        tx.connection().execute(
            "UPDATE sqlite_dbpage SET data = zeroblob(4096) WHERE pgno = 2",
            [],
        )?;
        Ok(())
    });
    assert!(
        refused.is_err(),
        "a raw page write through the vault's writer is refused"
    );
    let mut pinned = PinnedPages::begin(&path).expect("pins");
    assert_eq!(
        pinned.range(0).expect("reads"),
        before.as_slice(),
        "the page is unchanged"
    );
    pinned.end().expect("ends");
}
