//! THE ORIGINALS CENSUS against a real founded vault and the real content store
//! (#1029, the photos port).
//!
//! `originals::census` joins two places — the rows that say which bytes are a
//! photograph's original and which album holds it, and the store that says
//! whether those bytes are whole on this device. Each assertion here is one way
//! the join could lie: counting bytes that are not here, counting a trashed
//! photograph twice over, counting a photograph in two kept albums twice, or
//! answering zero for a device that has no store to ask.

mod common;

use std::collections::BTreeSet;

use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::originals::{self, OriginalsCensus, Totals};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded_with_blobs(seed).expect("a vault with a store");
        let registry = Registry::with_system_commands().expect("the system commands register");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self { scratch, registry }
    }

    /// One photograph whose original is `bytes`, held on this device or not,
    /// live or in the trash. Rows are inserted directly for the reason
    /// `media_commands.rs` gives: `media.add_asset` names staged bytes.
    fn photograph(&self, asset_id: &str, bytes: &[u8], held: bool, trashed: bool) {
        let hash = if held {
            self.scratch
                .vault
                .blobs()
                .expect("a store is attached")
                .put(bytes)
                .expect("the bytes are kept")
        } else {
            centraid_vault::content::content_digest(bytes)
        };
        let content_id = format!("content-{asset_id}");
        let deleted_at: Option<&str> = trashed.then_some("2026-02-01T00:00:00.000Z");
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, content_hash, byte_size, created_at)
                     VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![
                        content_id,
                        format!("blob:{hash}"),
                        hash,
                        i64::try_from(bytes.len()).expect("small")
                    ],
                )?;
                tx.connection().execute(
                    "INSERT INTO media_asset
                       (asset_id, content_id, kind, captured_at, deleted_at, created_at, updated_at)
                     VALUES (?1, ?2, 'photo', '2026-01-01T00:00:00.000Z', ?3,
                             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![asset_id, content_id, deleted_at],
                )?;
                Ok(())
            })
            .expect("the photograph lands");
    }

    fn executed(&self, command: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("{command} did not run: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{command}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn album(&self, title: &str, assets: &[&str]) -> String {
        let album = self.executed("media.create_album", serde_json::json!({ "title": title }));
        let album_id = album["album_id"].as_str().expect("an album id").to_owned();
        for asset in assets {
            self.executed(
                "media.add_to_album",
                serde_json::json!({ "album_id": album_id, "asset_id": asset }),
            );
        }
        album_id
    }

    fn census(&self, kept: &[&str]) -> OriginalsCensus {
        let kept: BTreeSet<String> = kept.iter().map(|id| (*id).to_owned()).collect();
        originals::census(&self.scratch.vault, &kept)
            .expect("the census reads")
            .expect("a store is attached, so there is a census")
    }
}

/// **A DEVICE WITH NO STORE IS NOT COUNTED, AND IS NOT ZERO.** "0 originals on
/// this phone" over a vault that has no byte door would be a claim about a
/// disk nobody looked at.
#[test]
fn a_vault_with_no_content_store_answers_not_counted() {
    let scratch = common::Scratch::founded("originals-no-store").expect("a vault");
    assert_eq!(
        originals::census(&scratch.vault, &BTreeSet::new()).expect("it reads"),
        None
    );
}

/// **ONLY BYTES THAT ARE HERE ARE COUNTED**, and only a LIVE photograph's.
/// A row whose original never arrived is not an original on this phone, and a
/// trashed one belongs to the trash's own purge.
#[test]
fn only_whole_originals_of_live_photographs_are_counted() {
    let world = World::new("originals-held");
    world.photograph("here", b"four", true, false);
    world.photograph("elsewhere", b"not on this phone", false, false);
    world.photograph("trashed", b"in the trash", true, true);

    let census = world.census(&[]);
    assert_eq!(census.on_device, Totals { count: 1, bytes: 4 });
    assert_eq!(census.kept, Totals::default(), "nothing is kept");
}

/// **THE KEPT SHARE IS BY ALBUM, ONCE PER PHOTOGRAPH.** A photograph in two
/// kept albums is one original on the disk; an album that is not kept keeps
/// nothing; and a pin naming an album that no longer exists matches no entry.
#[test]
fn a_photograph_in_a_kept_album_is_kept_once_however_many_albums_hold_it() {
    let world = World::new("originals-kept");
    world.photograph("a", b"aaaa", true, false);
    world.photograph("b", b"bbbbbbbb", true, false);
    world.photograph("c", b"cc", true, false);
    world.photograph("far", b"not here", false, false);

    let first = world.album("Tahoe", &["a", "b", "far"]);
    let second = world.album("Also Tahoe", &["a"]);
    let _unkept = world.album("Receipts", &["c"]);

    let census = world.census(&[first.as_str(), second.as_str(), "an-album-since-deleted"]);
    assert_eq!(
        census.on_device,
        Totals {
            count: 3,
            bytes: 14
        }
    );
    // `far` is in a kept album and its bytes are not here, so it is kept by
    // nobody's disk; `a` is in two kept albums and counts once.
    assert_eq!(
        census.kept,
        Totals {
            count: 2,
            bytes: 12
        }
    );
}
