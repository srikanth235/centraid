//! `<stem>.staging/`: the few sealed bytes that cannot be rebuilt
//! (spec §6.4, [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! Sealing is deterministic, so a sealed object is rebuilt from its source
//! whenever it is needed and nothing keeps it. Staging holds only:
//!
//! - sealed vault ranges between the pin and their confirmation (the vault
//!   moves on, so the page bytes of that moment cannot be read again);
//! - originals whose bytes only the OS photo library holds, until every
//!   gateway confirms them;
//! - bundle files handed to the OS background session.
//!
//! **The budget** is the smaller of 512 MiB and a tenth of the free space. A
//! file reaches its name by rename after fsync, so a name is either whole or
//! absent; opening the area sweeps the partials a crash left.

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use centraid_media::sealed::Name;

use super::{PlaneError, Result};

/// The largest the staging area is ever allowed to be.
pub const BUDGET_CEILING: u64 = 512 * 1024 * 1024;

/// The suffix a file has until it is whole.
pub const PARTIAL: &str = ".part";

/// The budget for a disk with `free_bytes` free: the smaller of 512 MiB and a tenth of it.
#[must_use]
pub fn budget_for(free_bytes: u64) -> u64 {
    BUDGET_CEILING.min(free_bytes / 10)
}

/// The staging directory.
#[derive(Debug)]
pub struct Staging {
    dir: PathBuf,
    budget: u64,
}

impl Staging {
    /// Open (creating) the area and sweep every partial file in it.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn open(dir: impl AsRef<Path>, budget: u64) -> Result<Self> {
        let dir = dir.as_ref().to_owned();
        fs::create_dir_all(&dir)?;
        let staging = Self { dir, budget };
        staging.sweep()?;
        Ok(staging)
    }

    /// Remove every file that never reached its name; how many went.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn sweep(&self) -> Result<usize> {
        let mut swept = 0;
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().ends_with(PARTIAL) {
                fs::remove_file(entry.path())?;
                swept += 1;
            }
        }
        Ok(swept)
    }

    /// The path a name has in the area.
    #[must_use]
    pub fn path_of(&self, name: &Name) -> PathBuf {
        self.dir.join(name.to_hex())
    }

    /// The bytes held under the budget: every whole file.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn used(&self) -> Result<u64> {
        let mut used = 0;
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if !entry.file_name().to_string_lossy().ends_with(PARTIAL) {
                used += entry.metadata()?.len();
            }
        }
        Ok(used)
    }

    /// The budget.
    #[must_use]
    pub const fn budget(&self) -> u64 {
        self.budget
    }

    /// Stage `bytes` under `name`: written to a partial, fsynced, renamed. A
    /// name already held is left as it is (the same name is the same bytes).
    ///
    /// # Errors
    /// [`PlaneError::StagingFull`] past the budget; the filesystem's refusal.
    pub fn put(&self, name: &Name, bytes: &[u8]) -> Result<PathBuf> {
        let path = self.path_of(name);
        if path.exists() {
            return Ok(path);
        }
        if self.used()?.saturating_add(bytes.len() as u64) > self.budget {
            return Err(PlaneError::StagingFull);
        }
        let partial = self.write_partial(name, bytes)?;
        fs::rename(&partial, &path)?;
        File::open(&self.dir)?.sync_all()?;
        Ok(path)
    }

    /// Write and fsync the partial file and stop, as a crash between the
    /// fsync and the rename leaves it. For tests.
    ///
    /// # Errors
    /// The filesystem's refusal.
    #[doc(hidden)]
    pub fn write_partial(&self, name: &Name, bytes: &[u8]) -> Result<PathBuf> {
        let partial = self.dir.join(format!("{}{PARTIAL}", name.to_hex()));
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(partial)
    }

    /// Whether `name` is whole in the area, without reading its bytes.
    #[must_use]
    pub fn contains(&self, name: &Name) -> bool {
        self.path_of(name).exists()
    }

    /// The bytes staged under `name`, when whole.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn get(&self, name: &Name) -> Result<Option<Vec<u8>>> {
        match fs::read(self.path_of(name)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Release a name. Absent is not an error.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn release(&self, name: &Name) -> Result<()> {
        match fs::remove_file(self.path_of(name)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Every whole file's name.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn names(&self) -> Result<Vec<Name>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if let Ok(name) = Name::from_hex(&entry.file_name().to_string_lossy()) {
                out.push(name);
            }
        }
        out.sort();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_tracks_whole_files_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let staging = Staging::open(dir.path(), 1024).expect("open");
        let whole = Name::from_bytes([1; 32]);
        let partial = Name::from_bytes([2; 32]);

        assert!(!staging.contains(&whole));
        assert!(!staging.contains(&partial));

        staging
            .write_partial(&partial, b"partial")
            .expect("partial");
        assert!(
            !staging.contains(&partial),
            "partial file must not count as present"
        );

        staging.put(&whole, b"hello").expect("put");
        assert!(staging.contains(&whole));

        staging.release(&whole).expect("release");
        assert!(!staging.contains(&whole));
    }
}
