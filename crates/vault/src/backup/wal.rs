//! Which pages the vault's WAL says changed (spec §5).
//!
//! Every connection to the vault file sets `wal_autocheckpoint = 0`, so the
//! `-wal` grows until the core checkpoints it after a snapshot. The frames in
//! it are the pages written since: a frame's header names its page number.
//! The snapshot reads only the ranges those pages fall in.
//!
//! A frame counts when its salts are the header's: a reset WAL leaves old
//! frames behind with other salts. A torn tail is counted too: a page named
//! twice or needlessly is a wasted read, a page missed is a damaged backup.
//! What this cannot see is a checkpoint made behind the core's back; the
//! periodic full read catches that (`snapshot`).

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::Result;

const WAL_HEADER: u64 = 32;
const FRAME_HEADER: u64 = 24;
const MAGIC_LE: u32 = 0x377f_0682;
const MAGIC_BE: u32 = 0x377f_0683;

/// The `-wal` file beside a database.
#[must_use]
pub fn wal_path(db: &Path) -> PathBuf {
    let mut name = db.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

/// The WAL header salts and valid frame page numbers read together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalSnapshot {
    pub salts: Option<[u8; 8]>,
    pub pages: Vec<u32>,
}

/// Read the WAL header salts and valid frame page numbers in order.
///
/// # Errors
/// An unreadable `-wal`. A missing, empty, or invalid one yields `salts: None` and empty `pages`.
pub fn inspect(db: &Path) -> Result<WalSnapshot> {
    let mut file = match File::open(wal_path(db)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WalSnapshot {
                salts: None,
                pages: Vec::new(),
            });
        }
        Err(error) => return Err(error.into()),
    };
    let mut header = [0_u8; WAL_HEADER as usize];
    if file.read_exact(&mut header).is_err() {
        return Ok(WalSnapshot {
            salts: None,
            pages: Vec::new(),
        });
    }
    let magic = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    if magic != MAGIC_LE && magic != MAGIC_BE {
        return Ok(WalSnapshot {
            salts: None,
            pages: Vec::new(),
        });
    }
    let page_size = u64::from(u32::from_be_bytes([
        header[8], header[9], header[10], header[11],
    ]));
    if page_size == 0 {
        return Ok(WalSnapshot {
            salts: None,
            pages: Vec::new(),
        });
    }
    let salts: [u8; 8] = [
        header[16], header[17], header[18], header[19], header[20], header[21], header[22],
        header[23],
    ];
    let length = file.metadata()?.len();
    let stride = FRAME_HEADER + page_size;
    let mut pages = Vec::new();
    let mut at = WAL_HEADER;
    let mut frame = [0_u8; FRAME_HEADER as usize];
    while at + FRAME_HEADER <= length {
        file.seek(SeekFrom::Start(at))?;
        if file.read_exact(&mut frame).is_err() {
            break;
        }
        if frame[8..16] != salts[..] {
            break;
        }
        let page = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
        if page == 0 {
            break;
        }
        pages.push(page);
        at += stride;
    }
    Ok(WalSnapshot {
        salts: Some(salts),
        pages,
    })
}

/// The page numbers of every valid frame, in frame order.
///
/// # Errors
/// An unreadable `-wal`. A missing or empty one is no frames.
pub fn frame_pages(db: &Path) -> Result<Vec<u32>> {
    Ok(inspect(db)?.pages)
}

/// The 64 KiB ranges the pages fall in.
#[must_use]
pub fn ranges_of(pages: impl IntoIterator<Item = u32>, page_size: u64) -> BTreeSet<u64> {
    pages
        .into_iter()
        .map(|page| {
            (u64::from(page.saturating_sub(1)) * page_size) / super::tree::RANGE_BYTES as u64
        })
        .collect()
}
