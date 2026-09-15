//! A seat that has no copy yet, or has fallen under the floor (#1025 S1,
//! rewritten for S7 item 3).
//!
//! ## BOOTSTRAP IS A BLOB, AND THE BLOB IS THE REPLICA
//!
//! There used to be two ways a replica started, and the second one was a lie on
//! any vault with history: "from the floor" meant an empty file, `applied_seq =
//! 0`, and the whole log applied in pages — but the log HAS a floor, so seq 0
//! is a cursor the gateway refuses to serve from. #996 R4 superseded it and S1
//! deleted it.
//!
//! There is one way now, and since S7 it costs one file. The gateway keeps a
//! content-addressed snapshot built **replica-shaped**: uncompressed, and
//! already carrying the seat's own empty tables
//! (`centraid_vault::build_replica_snapshot` over `centraid_seat::seat_own_ddl`).
//! The seat fetches it as any other blob — resumable by verified chunk group,
//! immutable, so a window that ends mid-download costs nothing — and then
//! **adopts** it: the verified bytes are already a file in `<vault>.bytes`, so
//! it is hard-linked to the replica's name, given its cursor and its pairing
//! record in one small transaction, and the blob is forgotten.
//!
//! What that replaces is three full-size files on a phone at once — the blob,
//! a gzip and an expanded database — to produce one. See
//! [`centraid_seat::adopt`].
//!
//! **Falling under the floor is the same path again.** There is no repair
//! branch and no second mechanism to keep correct; a seat whose cursor is below
//! the floor adopts the current artifact exactly as a seat that has never
//! synced does, with one difference: the old file is beside it, so the seat's
//! own tables are copied across inside the adopting transaction. The outbox
//! survives because it never lived in the gateway's copy.
//!
//! ## THE ROOM CHECK IS BEFORE THE FIRST BYTE
//!
//! `PairOk` and `RebootstrapRequired` carry the artifact's size, so a device
//! knows what it is about to spend before it spends it. A first bootstrap needs
//! **one** copy of the artifact and a re-bootstrap **two**, because the old
//! file is still there until the new one is renamed over it. Checking
//! afterwards is checking after a phone has filled its own disk, and the
//! failure then arrives as whatever ran out of room first rather than as a
//! refusal naming what it needed.
//!
//! ## THE IDENTITY IS THE ARTIFACT'S OWN, AND IT IS CHECKED FIRST
//!
//! bao proves the bytes are the hash the gateway named. It cannot prove the
//! hash names THIS vault's snapshot, and it is not supposed to: that question
//! is answered by the adopted file's own `core_vault` row against the vault
//! this seat paired for, before the destination is touched
//! (`centraid_seat::adopt_replica`).
//!
//! ## THE RENAME IS THE PUBLICATION, AND IT IS LAST
//!
//! A kill anywhere before it leaves the old replica, whole, with its outbox —
//! and the redo is idempotent, because the blob is still in the store and every
//! carried row is an `INSERT OR IGNORE` against a primary key. A kill between
//! the link and the identity transaction leaves a file at a scratch name that
//! the next attempt clears. A file cannot be replaced underneath an open SQLite
//! connection, so the CORE closes its vault before calling this and opens the
//! new file after — which is why the lifecycle lives in
//! `centraid_core::Handle` and not in a sync pass.

use std::path::Path;

use centraid_blobs::{ByteStore, ContentHash};
use centraid_core::link::BootstrapRefusal;
use centraid_seat::sync::{BootstrapMoved, SnapshotOffer};

/// Whether this path already holds a replica with a position.
///
/// A missing file, a missing `seat_state` TABLE and a missing ROW are one
/// answer: none of them is a replica. Asking the question and treating every
/// failure as "no" is what makes this work on a path nothing has ever written.
#[must_use]
pub fn is_bootstrapped(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    rusqlite::Connection::open(path)
        .is_ok_and(|connection| centraid_seat::state::seat_state(&connection).is_ok())
}

/// Fetch the artifact and, when `adopt`, make it this seat's replica.
///
/// `destination` is the replica path. It is read (for the seat's own tables to
/// be carried across) and then replaced; nothing may hold it open.
///
/// `adopt: false` is a BACKGROUND WINDOW. It fetches and stops: every verified
/// chunk group is durable and the next foreground window adopts what this one
/// paid for. What it answers is what it moved, which is the progress a
/// "Copying your vault" screen draws.
pub async fn install(
    blobs: &ByteStore,
    byte_connection: &iroh::endpoint::Connection,
    offer: &SnapshotOffer,
    expected_vault_id: &str,
    destination: &Path,
    gateway: Option<&centraid_seat::PairedGateway>,
    adopt: bool,
) -> Result<BootstrapMoved, BootstrapRefusal> {
    let hash = ContentHash::parse_hex(&offer.hash).map_err(|error| {
        tracing::warn!(%error, "the gateway named a blob this build cannot address");
        BootstrapRefusal::NothingOffered
    })?;

    // THE ROOM CHECK, BEFORE THE FIRST BYTE. One copy for a first bootstrap;
    // two for a re-bootstrap, because the old file is there until the rename.
    let rebootstrap = is_bootstrapped(destination);
    let needed = offer.bytes.saturating_mul(if rebootstrap { 2 } else { 1 });
    if let Some(free) = free_space(destination)
        && free < needed
    {
        tracing::warn!(
            needed,
            free,
            "there is not enough room on this device for a copy of the vault"
        );
        return Err(BootstrapRefusal::NoRoom { needed, free });
    }

    // ONE CALL, AND IT RESUMES. `fetch` asks the store what it already holds,
    // subtracts, and asks the peer for the difference — so a bootstrap cut by a
    // window that ended keeps every verified chunk group and the next attempt
    // costs only what is left (D-1020-B3).
    let report = centraid_blobs::fetch(blobs, byte_connection, hash)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "the bootstrap blob would not transfer");
            BootstrapRefusal::Unreachable
        })?;
    let moved = BootstrapMoved {
        seq: offer.seq,
        bytes_fetched: report.moved,
        bytes_total: offer.bytes,
    };
    if !report.complete {
        // NOT A FAILURE. What landed is durable and the next window resumes
        // from it, which is the whole point of a verified chunk transfer.
        return Err(BootstrapRefusal::Unreachable);
    }
    if !adopt {
        // A BACKGROUND WINDOW STOPS HERE. The bytes are whole and on this
        // device; adoption closes the vault, renames a file into place and
        // reopens it, and a member whose phone did that behind their back would
        // watch it go blank and come back.
        return Ok(moved);
    }

    let staged = with_suffix(destination, "incoming");
    // A leftover from an interrupted adoption is not evidence of anything. It
    // is cleared, because the alternative is an adoption that can never retry.
    let _ = std::fs::remove_file(&staged);

    let adopted = adopt_blob(
        blobs,
        hash,
        offer,
        expected_vault_id,
        destination,
        &staged,
        gateway,
        rebootstrap,
    )
    .await;
    let Ok(()) = adopted else {
        let _ = std::fs::remove_file(&staged);
        return Err(adopted.unwrap_err());
    };

    // THE RENAME IS THE PUBLICATION, and it is the last thing that happens:
    // every seat table is already on the staged file, with its cursor and its
    // pairing record. A file that reached this name without a `seat_state`
    // reads as "this seat has no copy" and costs the whole artifact again.
    if let Err(error) = std::fs::rename(&staged, destination) {
        tracing::warn!(%error, "the new replica would not move into place");
        let _ = std::fs::remove_file(&staged);
        return Err(BootstrapRefusal::Failed);
    }
    // The seat's sidecars belonged to the file that is gone. Leaving them would
    // let SQLite read a WAL written against a different database.
    for sidecar in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(with_suffix_raw(destination, sidecar));
    }
    // THE ARTIFACT IS NOT KEPT. It is the size of the vault, this device now
    // holds its contents as its replica, and a seat holding a second copy of
    // its own vault is a phone out of space. The hard link above is what makes
    // this free: the store's own name goes and the file stays.
    blobs.forget(hash).await.ok();
    Ok(moved)
}

/// Link the verified bytes to a name of our own and make them a replica.
#[allow(clippy::too_many_arguments)]
async fn adopt_blob(
    blobs: &ByteStore,
    hash: ContentHash,
    offer: &SnapshotOffer,
    expected_vault_id: &str,
    destination: &Path,
    staged: &Path,
    gateway: Option<&centraid_seat::PairedGateway>,
    rebootstrap: bool,
) -> Result<(), BootstrapRefusal> {
    // THE BYTES ARE ALREADY A FILE. `data_path` is iroh's own data file for a
    // complete blob, which is what D-1025-S3-1 made the one store on a device.
    let source = blobs.data_path(hash).await.ok().flatten();
    match source {
        // A HARD LINK, NOT A COPY. Two names for one inode: no second
        // full-size write, and `forget` below removes the store's name while
        // this one keeps the file.
        Some(source) if std::fs::hard_link(&source, staged).is_ok() => {}
        // THE FALLBACK IS A COPY, and it is not a failure. A store that keeps
        // a small blob inline has no data file, and a `<vault>.bytes` on a
        // different filesystem from the replica cannot be linked to. Both are
        // configurations this product allows, so both work — at the cost the
        // adoption exists to avoid, which is why the link is tried first.
        _ => {
            blobs.export(hash, staged).await.map_err(|error| {
                tracing::warn!(%error, "the bootstrap blob would not write out");
                BootstrapRefusal::Failed
            })?;
        }
    }

    let now = centraid_vault::clock::Clock::now_text(&centraid_vault::clock::SystemClock);
    let ddl_version = centraid_vault::log::constants().ddl_version;
    let live = rebootstrap.then_some(destination);
    centraid_seat::adopt_replica(
        staged,
        live,
        expected_vault_id,
        offer.seq,
        ddl_version,
        gateway,
        &now,
    )
    .map_err(|error| match error {
        centraid_seat::SeatError::WrongVault { .. } => {
            tracing::warn!(%error, "the gateway offered a copy of another vault");
            BootstrapRefusal::WrongVault
        }
        other => {
            tracing::warn!(error = %other, "the artifact would not become a replica");
            BootstrapRefusal::Failed
        }
    })?;
    Ok(())
}

/// Bytes free on the filesystem the replica lives on.
///
/// `None` when the platform will not say, and a `None` NEVER REFUSES: a device
/// whose free space cannot be measured is not a device that has none, and
/// refusing on an unanswered question would make the room check the reason a
/// phone never gets its vault.
fn free_space(destination: &Path) -> Option<u64> {
    let directory = destination.parent().unwrap_or_else(|| Path::new("."));
    fs4::available_space(directory).ok()
}

/// `replica.db` → `replica.db.incoming`. Appended, never substituted: a
/// `with_extension` would turn `replica.db` into `replica.incoming` and collide
/// with the byte store's own `<vault>.bytes` naming.
fn with_suffix(path: &Path, suffix: &str) -> std::path::PathBuf {
    with_suffix_raw(path, &format!(".{suffix}"))
}

fn with_suffix_raw(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    std::path::PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_with_no_file_is_not_a_replica() {
        let dir = tempfile::tempdir().expect("a temp dir");
        assert!(!is_bootstrapped(&dir.path().join("nothing.db")));
    }

    /// An empty file is not a replica either, and that is the state a seat is
    /// in between `Core::open` and its first bootstrap.
    #[test]
    fn an_empty_file_is_not_a_replica() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("empty.db");
        std::fs::write(&path, b"").expect("it writes");
        assert!(!is_bootstrapped(&path));
    }

    #[test]
    fn the_staging_name_is_appended_and_never_substituted() {
        let path = Path::new("/tmp/replica.db");
        assert_eq!(
            with_suffix(path, "incoming"),
            Path::new("/tmp/replica.db.incoming")
        );
    }

    /// THE ROOM CHECK NEVER REFUSES ON AN UNANSWERED QUESTION.
    ///
    /// A device whose free space cannot be measured is not a device that has
    /// none. The assertion is that the real call ANSWERS here — a `None` on
    /// every platform would make the check inert without anything going red.
    #[test]
    fn free_space_answers_for_a_path_that_exists() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let free = free_space(&dir.path().join("replica.db"));
        assert!(free.is_some_and(|bytes| bytes > 0), "{free:?}");
        // And a path on nothing answers `None` rather than zero, which is the
        // value that would refuse every bootstrap.
        assert_eq!(free_space(Path::new("/no/such/place/replica.db")), None);
    }
}
