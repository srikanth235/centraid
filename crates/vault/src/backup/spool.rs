//! The spool: sealed parts waiting to move, one file per name, in
//! `<stem>.spool/` beside the vault (#1080).
//!
//! A part is sealed once and the same bytes are sent on every retry, so a
//! retry is a re-upload and never a re-seal; on iOS the OS uploads a spool file
//! by path while the app is suspended. A part reaches its real name only by
//! rename after an fsync, so a crash leaves a whole part or a `.partial` that
//! [`Spool::open`] sweeps away — never a short file under a name the queue
//! trusts.
//!
//! ## THE BUDGET
//!
//! The spool holds at most [`Spool::budget`] bytes: 2 GiB, or a tenth of the
//! free space, whichever is smaller. Preparing stops when [`Spool::room`] says
//! no and resumes once moving has drained it, so a backlog never fills the
//! phone. Free space is the caller's to measure: the plane has no platform
//! call for it.
//!
//! **The budget bounds what waits, never what can back up.** A file larger
//! than it is sealed a window of parts at a time, each window moved before
//! the next is sealed: from the app's store part by part (R-1080-C12), and
//! from the library one read per window (R-1080-C39).

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::Result;
use super::naming::Name;

/// The spool's ceiling, whatever the free space.
pub const SPOOL_CEILING_BYTES: u64 = 2 * 1024 * 1024 * 1024;

const PARTIAL: &str = "partial";

/// The spool directory.
#[derive(Debug, Clone)]
pub struct Spool {
    dir: PathBuf,
}

impl Spool {
    /// `<stem>.spool/` beside the vault file.
    #[must_use]
    pub fn dir_for(vault_path: &Path) -> PathBuf {
        vault_path.with_extension("spool")
    }

    /// The most the spool may hold, given the free space on its volume.
    #[must_use]
    pub fn budget(free_bytes: u64) -> u64 {
        Self::budget_under(SPOOL_CEILING_BYTES, free_bytes)
    }

    /// The most the spool may hold under a `ceiling` other than 2 GiB.
    #[must_use]
    pub fn budget_under(ceiling: u64, free_bytes: u64) -> u64 {
        ceiling.min(free_bytes / 10)
    }

    /// Open (creating) the spool, sweeping away any part a crash left
    /// half-written.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path
                .extension()
                .is_some_and(|extension| extension == PARTIAL)
            {
                fs::remove_file(&path)?;
            }
        }
        Ok(Self { dir })
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where the part `name` is, whether or not it is there yet.
    #[must_use]
    pub fn path(&self, name: &Name) -> PathBuf {
        self.dir.join(name.to_hex())
    }

    /// Whether the part `name` is spooled.
    #[must_use]
    pub fn contains(&self, name: &Name) -> bool {
        self.path(name).is_file()
    }

    /// Write a whole sealed part.
    ///
    /// # Errors
    /// The filesystem's refusal; nothing is left under the real name then.
    pub fn write(&self, name: &Name, sealed: &[u8]) -> Result<PathBuf> {
        let mut writer = self.writer(name)?;
        writer.write_all(sealed)?;
        writer.finish()
    }

    /// Stream a sealed part in, for a part too large to hold.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn writer(&self, name: &Name) -> Result<SpoolWriter> {
        let partial = self.dir.join(format!("{}.{PARTIAL}", name.to_hex()));
        let file = File::create(&partial)?;
        Ok(SpoolWriter {
            file: Some(file),
            partial,
            target: self.path(name),
            dir: self.dir.clone(),
        })
    }

    /// A temp path inside the spool for part `index` of a file still being
    /// sealed, whose name is not known until its last byte
    /// (`centraid_media::sealed::FileSealer`). It is a `.partial`, so a crash
    /// leaves nothing [`Spool::open`] does not sweep.
    #[must_use]
    pub fn temp_path(&self, tag: &str, index: u32) -> PathBuf {
        self.dir.join(format!("stage-{tag}-{index}.{PARTIAL}"))
    }

    /// Give a sealed, fsynced temp file its name.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn adopt(&self, temp: &Path, name: &Name) -> Result<PathBuf> {
        let target = self.path(name);
        fs::rename(temp, &target)?;
        sync_dir(&self.dir)?;
        Ok(target)
    }

    /// Open a spooled part to send it.
    ///
    /// # Errors
    /// The filesystem's refusal, including a part that is not there.
    pub fn read(&self, name: &Name) -> Result<File> {
        Ok(File::open(self.path(name))?)
    }

    /// Remove a part. A part that is already gone is not an error: a confirmed
    /// part may be removed by a pass that crashed after removing it.
    ///
    /// # Errors
    /// The filesystem's refusal for any other reason.
    pub fn remove(&self, name: &Name) -> Result<()> {
        match fs::remove_file(self.path(name)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// Every spooled part's name.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn names(&self) -> Result<Vec<Name>> {
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|text| Name::from_hex(text).ok())
            {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    /// The bytes the spool holds in whole parts.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn bytes(&self) -> Result<u64> {
        let mut total = 0_u64;
        for name in self.names()? {
            total = total.saturating_add(fs::metadata(self.path(&name))?.len());
        }
        Ok(total)
    }

    /// Whether the spool is under `budget`, so another part may be prepared.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn room(&self, budget: u64) -> Result<bool> {
        Ok(self.bytes()? < budget)
    }
}

/// A part being written. Dropped without [`SpoolWriter::finish`], it removes
/// its partial file.
pub struct SpoolWriter {
    file: Option<File>,
    partial: PathBuf,
    target: PathBuf,
    dir: PathBuf,
}

impl SpoolWriter {
    /// Make the part durable under its real name: fsync, rename, fsync the
    /// directory.
    ///
    /// # Errors
    /// The filesystem's refusal; the partial file is removed then.
    pub fn finish(mut self) -> Result<PathBuf> {
        let file = self
            .file
            .take()
            .ok_or_else(|| super::invariant("a spool writer finished twice"))?;
        file.sync_all()?;
        drop(file);
        fs::rename(&self.partial, &self.target)?;
        sync_dir(&self.dir)?;
        Ok(self.target.clone())
    }
}

impl Write for SpoolWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("the spool writer is finished"))?
            .write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map_or(Ok(()), File::flush)
    }
}

impl Drop for SpoolWriter {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            // An abandoned part: the partial file is all there is to undo, and
            // a failure to remove it is swept by the next `Spool::open`.
            let _ = fs::remove_file(&self.partial);
        }
    }
}

/// Make a rename durable: the directory entry is written by the directory's
/// own fsync.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

/// Windows has no directory fsync; NTFS journals the rename itself.
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::naming::PlaintextHash;

    fn name_of(label: &str) -> Name {
        Name::from_bytes(*PlaintextHash::of(label.as_bytes()).as_bytes())
    }

    #[test]
    fn a_part_is_written_counted_read_and_removed() {
        let dir = tempfile::tempdir().expect("a directory");
        let spool = Spool::open(Spool::dir_for(&dir.path().join("vault.db"))).expect("opens");
        assert_eq!(spool.dir(), dir.path().join("vault.spool"));
        let (one, two) = (name_of("one"), name_of("two"));
        let path = spool.write(&one, &[7; 100]).expect("writes");
        assert_eq!(path, spool.path(&one));
        let mut streamed = spool.writer(&two).expect("begins");
        streamed.write_all(&[8; 50]).expect("streams");
        streamed.finish().expect("finishes");
        assert!(spool.contains(&one) && spool.contains(&two));
        assert_eq!(spool.bytes().expect("sums"), 150);
        assert!(spool.room(151).expect("asks"));
        assert!(!spool.room(150).expect("asks"));
        let mut back = Vec::new();
        io::Read::read_to_end(&mut spool.read(&one).expect("opens"), &mut back).expect("reads");
        assert_eq!(back, vec![7; 100]);
        spool.remove(&one).expect("removes");
        spool.remove(&one).expect("removing twice is not an error");
        assert_eq!(spool.names().expect("lists"), vec![two]);
    }

    /// A crash mid-write leaves a `.partial`, never a short part under a real
    /// name, and the next open sweeps it.
    #[test]
    fn an_abandoned_part_never_reaches_its_name() {
        let dir = tempfile::tempdir().expect("a directory");
        let spool = Spool::open(dir.path().join("s.spool")).expect("opens");
        let name = name_of("half");
        {
            let mut writer = spool.writer(&name).expect("begins");
            writer.write_all(&[1; 10]).expect("streams");
        }
        assert!(!spool.contains(&name));
        let leftover = spool.dir().join(format!("{}.partial", name.to_hex()));
        fs::write(&leftover, b"what a crash left").expect("plants");
        assert_eq!(spool.bytes().expect("sums"), 0, "a partial is not a part");
        let reopened = Spool::open(spool.dir()).expect("reopens");
        assert!(!leftover.exists(), "the sweep removed it");
        assert!(reopened.names().expect("lists").is_empty());
    }

    /// A file sealed in one pass is written to temp paths and adopted under
    /// its names once they are known; an unadopted temp is swept.
    #[test]
    fn a_temp_part_is_adopted_under_its_name_or_swept() {
        let dir = tempfile::tempdir().expect("a directory");
        let spool = Spool::open(dir.path().join("s.spool")).expect("opens");
        let kept = spool.temp_path("photo", 0);
        let lost = spool.temp_path("photo", 1);
        fs::write(&kept, b"sealed part 0").expect("writes");
        fs::write(&lost, b"a crash left this").expect("writes");
        let name = name_of("photo part 0");
        assert_eq!(
            spool.adopt(&kept, &name).expect("adopts"),
            spool.path(&name)
        );
        assert_eq!(spool.names().expect("lists"), vec![name]);
        assert_eq!(spool.bytes().expect("sums"), 13, "a temp is not a part");
        Spool::open(spool.dir()).expect("reopens");
        assert!(!lost.exists(), "the sweep removed it");
        assert!(spool.contains(&name));
    }

    #[test]
    fn the_budget_is_two_gib_or_a_tenth_of_the_free_space() {
        assert_eq!(Spool::budget(1_000_000), 100_000);
        assert_eq!(
            Spool::budget(100 * SPOOL_CEILING_BYTES),
            SPOOL_CEILING_BYTES
        );
        assert_eq!(Spool::budget(0), 0);
    }
}
