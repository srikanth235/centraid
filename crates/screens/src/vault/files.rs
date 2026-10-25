//! THE FILE LAYER OF THE SHELF: where each vault lives, what a directory is
//! called, and what may be deleted.
//!
//! ## THE DIRECTORY IS THE ROSTER, AND A FILE NAME IS NOT AN IDENTITY
//!
//! Every vault a phone holds is a DIRECTORY of its own under the shelf's
//! directory — `<dir>/<opaque>/vault.db`, beside its byte store and its backup
//! home — and that is the whole index (#1047, Q-1047-17). There is no manifest
//! beside them: a vault's name lives inside the vault, and an index would be a
//! second place it lives that nothing keeps true. The name is opaque; the shelf
//! asks each file which vault it is, and a file that will not say is not a
//! holding.
//!
//! **One directory per vault, founded or restored alike.** The core keeps a
//! vault's backup home at `<vault file's directory>/backup`, so two vault files
//! in one directory would share one ledger, one spool and one object store —
//! two vaults pairing, draining and restoring as one. A loose `.sqlite3` in the
//! shelf's directory is therefore not a holding. The directory is also the unit
//! forgetting deletes whole.

use std::io::Write;
use std::path::{Path, PathBuf};

use rand::RngCore;

/// What a founded vault's directory is called: a label, never an identity.
pub const PREFIX: &str = "centraid-vault-";

/// What every vault file is called, one per directory — founded here or laid
/// down by a restore. A shell that PLACES a vault (`mobile/scripts/demo-vault.sh`,
/// an asset copy) spells it the same way.
pub const VAULT_FILE: &str = "vault.db";

/// The file in a vault's directory that says a found is in flight, see
/// [`Marker`].
pub const MARKER_FILE: &str = "found.pending";

/// Which vault the member last had in front. Not a secret and does not claim
/// to be: it lives beside the vaults so it is cleared with them.
pub const FOREGROUND_FILE: &str = "shelf.foreground";

/// 128 bits of directory name. Enough that a collision is not a case.
const NAME_BYTES: usize = 16;

/// Every vault file under `dir`, sorted: `<dir>/<name>/vault.db`. Sorted so the
/// same phone picks the same foreground twice running rather than whichever
/// directory the filesystem enumerated first.
#[must_use]
pub fn vault_files(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = homes(dir)
        .into_iter()
        .map(|home| home.join(VAULT_FILE))
        .filter(|file| file.exists())
        .collect();
    found.sort();
    found
}

/// Every vault directory under `dir`, sorted, with or without a vault file in
/// it.
#[must_use]
pub fn homes(dir: &Path) -> Vec<PathBuf> {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut homes: Vec<PathBuf> = listing
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    homes.sort();
    homes
}

/// A vault directory no vault is using, made, and the file the core founds in
/// it. The middle is random from the operating system's generator rather than a
/// counter: a counter would have to be stored somewhere, and a second place to
/// keep it is a second thing that can be wrong.
///
/// # Errors
/// When the directory cannot be made.
pub fn fresh_vault_file(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    loop {
        let mut bytes = [0u8; NAME_BYTES];
        rand::rng().fill_bytes(&mut bytes);
        let home = dir.join(format!("{PREFIX}{}", hex(&bytes)));
        if home.exists() {
            continue;
        }
        std::fs::create_dir(&home)?;
        return Ok(home.join(VAULT_FILE));
    }
}

/// A vault's directory, whole: the file, SQLite's sidecars, its byte store and
/// its backup home. The directory is the vault's own, so nothing else is in it.
///
/// **A GUARD, NOT A SCRUB**: only a directory that is a direct child of the
/// shelf's own is deleted, so a vault file placed at the shelf's root or
/// somewhere else on disk loses its holding and not its parents. Answers
/// whether it deleted.
pub fn delete_vault(root: &Path, file: &Path) -> bool {
    let Some(home) = file.parent() else {
        return false;
    };
    if home == root || home.parent() != Some(root) {
        return false;
    }
    std::fs::remove_dir_all(home).is_ok()
}

/// A FOUND THAT HAS SPENT AN INDEX AND NOT YET HAD IT RECORDED.
///
/// The index a found derives its keys at is chosen BEFORE the core makes the
/// file (it does not depend on the vault id), and the id is only known after.
/// The secret store is the shell's and answers later, so the record that closes
/// the crash window is this file, written and synced into the new vault's own
/// directory before the core touches it: a process killed between the found and
/// the shell's write is finished by the next launch from here
/// ([`crate::vault::Shelf::survey`]), and a directory with this marker and no
/// vault file is a found that never got that far and is deleted whole. It is
/// removed only once the secret store is seen to hold the index
/// ([`crate::vault::Shelf::settle`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Marker {
    pub index: u32,
    /// The entry the vault is kept on when it is on its own words.
    pub own: Option<String>,
}

impl Marker {
    /// Write the marker into `home`, durably.
    ///
    /// # Errors
    /// When the file cannot be written and synced.
    pub fn write(&self, home: &Path) -> std::io::Result<()> {
        let mut text = self.index.to_string();
        if let Some(own) = &self.own {
            text.push('\n');
            text.push_str(own);
        }
        let mut file = std::fs::File::create(home.join(MARKER_FILE))?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        // The new entry itself must survive a power cut, not only its bytes.
        if let Ok(directory) = std::fs::File::open(home) {
            let _ = directory.sync_all();
        }
        Ok(())
    }

    /// The marker in `home`, if there is a well-formed one.
    #[must_use]
    pub fn read(home: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(home.join(MARKER_FILE)).ok()?;
        let mut lines = text.split('\n');
        let index = lines.next()?.trim().parse().ok()?;
        let own = lines
            .next()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned);
        Some(Self { index, own })
    }

    /// Remove the marker from `home`; one that is not there is fine.
    pub fn remove(home: &Path) {
        let _ = std::fs::remove_file(home.join(MARKER_FILE));
    }
}

/// The vault the member last had in front, if the shelf wrote one.
#[must_use]
pub fn read_foreground(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(FOREGROUND_FILE))
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|id| !id.is_empty())
}

/// Remember which vault is in front; `None` forgets it.
pub fn write_foreground(dir: &Path, vault_id: Option<&str>) {
    match vault_id {
        Some(id) => {
            let _ = std::fs::write(dir.join(FOREGROUND_FILE), id);
        }
        None => {
            let _ = std::fs::remove_file(dir.join(FOREGROUND_FILE));
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A lowercase hex string as bytes; `None` for anything else.
pub(crate) fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}
