//! Packs: many small objects in one, addressable by range (#1029 §4).
//!
//! Thumbnails and page segments are small and numerous. As separate objects,
//! request cost and restore time scale with their *count* — 100 000 thumbnails
//! would be 100 000 GETs. So they are written into one ~16 MiB container.
//!
//! ```text
//! ┌─ item 0 ─┬─ item 1 ─┬ … ┬─ item n ─┬─ item table ─┬─ trailer (9) ─┐
//! │ a whole  │ a whole  │   │          │  a whole     │ len ‖ CNOB ‖ 1│
//! │ sealed   │ sealed   │   │          │  sealed      │               │
//! │ object   │ object   │   │          │  object      │               │
//! └──────────┴──────────┴───┴──────────┴──────────────┴───────────────┘
//! ```
//!
//! **Each item is an ordinary `centraid-object/1`, sealed on its own.** That is
//! what makes a pack addressable by range: a reader holding
//! `(object, offset, length)` slices those bytes out and opens them with
//! [`open_range`], never reading the table and never downloading the rest. It is
//! also what makes repacking cheap — live items are **copied verbatim**, not
//! re-encrypted.
//!
//! **The vault is the index.** Blob custody and the manifests already record
//! `(object, offset, length)` for every item, so the trailing table exists for
//! one job: rebuilding those rows during a restore, when the vault is not yet
//! there to be asked. No index file grows with the backup, and nothing loads an
//! index of the whole backup into memory.
//!
//! ## REPACKING, AND THE SEAM THIS MODULE DOES NOT FILL
//!
//! A pack whose dead share passes [`REPACK_UNUSED_THRESHOLD`] has its live items
//! written into a new pack and the old one tombstoned. **A pack referenced by
//! any live share is never repacked (F8)**: repacking would invalidate the
//! share's registered byte ranges and every recipient's cached references.
//! [`LiveShareIndex`] is where that question is asked. W8 owns shares and will
//! answer it; [`NoLiveShares`] is the honest placeholder until then — it says
//! "this deployment has no shares", not "do not check".

use std::collections::BTreeSet;

use super::header::{FORMAT_VERSION, HEADER_MAGIC};
use super::{
    Custody, Dictionary, Kind, ObjectError, ObjectName, ObjectResult, Role, SealOptions, VaultId,
    seal,
};

/// A pack is one object and wears the object cap (F6).
pub const MAX_PACK_BYTES: usize = super::MAX_OBJECT_BYTES;

/// `u32` table length, the magic, the version.
pub const TRAILER_BYTES: usize = 9;

/// Repack a pack once 5% of its bytes are dead (#1029 §4).
pub const REPACK_UNUSED_THRESHOLD: f64 = 0.05;

/// One item on its way into a pack.
#[derive(Debug, Clone, Copy)]
pub struct PackItem<'a> {
    /// What the vault calls this item. It goes in the table, never in an AAD.
    pub id: &'a str,
    /// Where this item's key lives — a thumbnail brings its own file key.
    pub custody: Custody<'a>,
    /// What the item is.
    pub kind: Kind,
    /// What its key opens.
    pub role: Role,
    /// The item's plaintext.
    pub plaintext: &'a [u8],
}

/// One item's row: what the vault records, and what the table rebuilds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackEntry {
    /// What the vault calls this item.
    pub id: String,
    /// BLAKE3 of the item's own sealed bytes.
    pub name: ObjectName,
    /// Where the item starts inside the pack.
    pub offset: u64,
    /// How many bytes it occupies.
    pub length: u64,
}

/// A built pack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pack {
    /// The bytes to write and upload.
    pub bytes: Vec<u8>,
    /// BLAKE3 of [`Pack::bytes`] — the pack's own object name.
    pub name: ObjectName,
    /// The rows the vault records.
    pub entries: Vec<PackEntry>,
}

/// Whether a pack is referenced by a live share (F8).
///
/// **This is a seam, deliberately.** W8 owns shares; until it lands, the only
/// implementation is [`NoLiveShares`], and `crates/media` must not grow its own
/// idea of what a share is.
pub trait LiveShareIndex {
    /// Answer for one pack.
    fn is_referenced_by_live_share(&self, pack: &ObjectName) -> bool;
}

/// "There are no shares in this deployment yet."
///
/// Not "skip the check": [`repack`] still asks, and the day W8 lands a real
/// index the call site does not move.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoLiveShares;

impl LiveShareIndex for NoLiveShares {
    fn is_referenced_by_live_share(&self, _pack: &ObjectName) -> bool {
        false
    }
}

/// Seal every item, concatenate them, and close with a sealed item table.
///
/// # Errors
/// [`ObjectError::TooLarge`] if the items do not fit under [`MAX_PACK_BYTES`],
/// otherwise whatever sealing an item refused.
pub fn build(
    vault: VaultId<'_>,
    root: &[u8; super::KEY_BYTES],
    items: &[PackItem<'_>],
    dictionary: Option<&Dictionary>,
) -> ObjectResult<Pack> {
    let mut bytes = Vec::new();
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let options = SealOptions {
            kind: item.kind,
            role: item.role,
            dictionary,
        };
        let sealed = seal(vault, item.custody, &options, item.plaintext)?;
        entries.push(PackEntry {
            id: item.id.to_owned(),
            name: sealed.name,
            offset: bytes.len() as u64,
            length: sealed.bytes.len() as u64,
        });
        bytes.extend_from_slice(&sealed.bytes);
    }
    finish(vault, root, bytes, entries, dictionary)
}

/// Write the table and the trailer onto item bytes that are already laid out.
fn finish(
    vault: VaultId<'_>,
    root: &[u8; super::KEY_BYTES],
    mut bytes: Vec<u8>,
    entries: Vec<PackEntry>,
    dictionary: Option<&Dictionary>,
) -> ObjectResult<Pack> {
    let table = seal(
        vault,
        Custody::Wrapped(root),
        &SealOptions {
            kind: Kind::Pack,
            role: Role::ItemTable,
            dictionary,
        },
        &encode_table(&entries),
    )?;
    let table_len = u32::try_from(table.bytes.len()).map_err(|_| ObjectError::Seal)?;
    bytes.extend_from_slice(&table.bytes);
    bytes.extend_from_slice(&table_len.to_be_bytes());
    bytes.extend_from_slice(HEADER_MAGIC);
    bytes.push(FORMAT_VERSION);
    if bytes.len() > MAX_PACK_BYTES {
        return Err(ObjectError::TooLarge(bytes.len()));
    }
    Ok(Pack {
        name: ObjectName::of(&bytes),
        bytes,
        entries,
    })
}

/// Read the trailing item table back — the restore path, when there is no vault
/// to ask yet.
///
/// # Errors
/// [`ObjectError::PackTable`] for a trailer or table that does not describe
/// these bytes, otherwise whatever opening the table refused.
pub fn read_table(
    vault: VaultId<'_>,
    root: &[u8; super::KEY_BYTES],
    pack: &[u8],
    dictionary: Option<&Dictionary>,
) -> ObjectResult<Vec<PackEntry>> {
    if pack.len() < TRAILER_BYTES {
        return Err(ObjectError::PackTable {
            reason: "shorter than a trailer",
        });
    }
    let trailer = &pack[pack.len() - TRAILER_BYTES..];
    if &trailer[4..8] != HEADER_MAGIC || trailer[8] != FORMAT_VERSION {
        return Err(ObjectError::PackTable {
            reason: "the trailer is not this format's",
        });
    }
    let table_len = u32::from_be_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]) as usize;
    let table_start =
        pack.len()
            .checked_sub(TRAILER_BYTES + table_len)
            .ok_or(ObjectError::PackTable {
                reason: "the table runs past the front of the pack",
            })?;
    let plain = super::open(
        vault,
        Custody::Wrapped(root),
        &pack[table_start..pack.len() - TRAILER_BYTES],
        dictionary,
    )?;
    let entries = decode_table(&plain)?;
    // The table describes THESE bytes or it describes nothing: every row has to
    // land inside the item region, which ends where the table begins.
    for entry in &entries {
        let end = entry
            .offset
            .checked_add(entry.length)
            .ok_or(ObjectError::PackTable {
                reason: "a row overflows",
            })?;
        if end > table_start as u64 {
            return Err(ObjectError::PackTable {
                reason: "a row points past the pack's items",
            });
        }
    }
    Ok(entries)
}

/// Open one item out of a pack by the range the vault recorded.
///
/// This is the read path that matters: the caller never touches the table and,
/// over HTTP, never fetches a byte outside `entry`.
///
/// # Errors
/// [`ObjectError::PackTable`] when the range is not inside the pack,
/// [`ObjectError::ReadBackMismatch`] when the bytes at that range are not the
/// item the row names, otherwise whatever opening refused.
pub fn open_range(
    vault: VaultId<'_>,
    custody: Custody<'_>,
    pack: &[u8],
    entry: &PackEntry,
    dictionary: Option<&Dictionary>,
) -> ObjectResult<Vec<u8>> {
    let start = usize::try_from(entry.offset).map_err(|_| ObjectError::PackTable {
        reason: "an offset does not fit this machine",
    })?;
    let length = usize::try_from(entry.length).map_err(|_| ObjectError::PackTable {
        reason: "a length does not fit this machine",
    })?;
    let end = start.checked_add(length).ok_or(ObjectError::PackTable {
        reason: "a row overflows",
    })?;
    if end > pack.len() {
        return Err(ObjectError::PackTable {
            reason: "a row points past the pack",
        });
    }
    let item = &pack[start..end];
    if ObjectName::of(item) != entry.name {
        return Err(ObjectError::ReadBackMismatch);
    }
    super::open(vault, custody, item, dictionary)
}

/// Whether this pack has enough dead bytes to be worth rewriting.
#[must_use]
pub fn should_repack(entries: &[PackEntry], live: &BTreeSet<String>) -> bool {
    let total: u64 = entries.iter().map(|entry| entry.length).sum();
    if total == 0 {
        return false;
    }
    let dead: u64 = entries
        .iter()
        .filter(|entry| !live.contains(&entry.id))
        .map(|entry| entry.length)
        .sum();
    #[allow(clippy::cast_precision_loss)]
    let share = dead as f64 / total as f64;
    share > REPACK_UNUSED_THRESHOLD
}

/// Write a pack's live items into a new pack, **without re-encrypting them**.
///
/// # Errors
/// [`ObjectError::PackIsShared`] when `shares` says a live share references this
/// pack (F8) — checked **first**, before any byte is copied, so the refusal
/// cannot be reached past a partially built replacement. Otherwise
/// [`ObjectError::PackTable`] for a row that does not describe these bytes.
pub fn repack(
    vault: VaultId<'_>,
    root: &[u8; super::KEY_BYTES],
    pack: &[u8],
    entries: &[PackEntry],
    live: &BTreeSet<String>,
    shares: &dyn LiveShareIndex,
    dictionary: Option<&Dictionary>,
) -> ObjectResult<Pack> {
    let name = ObjectName::of(pack);
    if shares.is_referenced_by_live_share(&name) {
        return Err(ObjectError::PackIsShared);
    }

    let mut bytes = Vec::new();
    let mut kept = Vec::new();
    for entry in entries.iter().filter(|entry| live.contains(&entry.id)) {
        let start = usize::try_from(entry.offset).map_err(|_| ObjectError::PackTable {
            reason: "an offset does not fit this machine",
        })?;
        let length = usize::try_from(entry.length).map_err(|_| ObjectError::PackTable {
            reason: "a length does not fit this machine",
        })?;
        let end = start.checked_add(length).ok_or(ObjectError::PackTable {
            reason: "a row overflows",
        })?;
        if end > pack.len() {
            return Err(ObjectError::PackTable {
                reason: "a row points past the pack",
            });
        }
        let item = &pack[start..end];
        if ObjectName::of(item) != entry.name {
            return Err(ObjectError::ReadBackMismatch);
        }
        kept.push(PackEntry {
            id: entry.id.clone(),
            name: entry.name,
            offset: bytes.len() as u64,
            length: entry.length,
        });
        bytes.extend_from_slice(item);
    }
    finish(vault, root, bytes, kept, dictionary)
}

/// `count ‖ (id_len ‖ id ‖ offset ‖ length)*`, all big-endian.
fn encode_table(entries: &[PackEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(
        &u32::try_from(entries.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    for entry in entries {
        let id = entry.id.as_bytes();
        out.extend_from_slice(&u16::try_from(id.len()).unwrap_or(u16::MAX).to_be_bytes());
        out.extend_from_slice(id);
        out.extend_from_slice(entry.name.as_bytes());
        out.extend_from_slice(&entry.offset.to_be_bytes());
        out.extend_from_slice(&entry.length.to_be_bytes());
    }
    out
}

fn decode_table(bytes: &[u8]) -> ObjectResult<Vec<PackEntry>> {
    const fn malformed() -> ObjectError {
        ObjectError::PackTable {
            reason: "the table is truncated or misencoded",
        }
    }

    if bytes.len() < 4 {
        return Err(malformed());
    }
    let count = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let mut at = 4;
    let mut entries = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        if at + 2 > bytes.len() {
            return Err(malformed());
        }
        let id_len = usize::from(u16::from_be_bytes([bytes[at], bytes[at + 1]]));
        at += 2;
        let row_end = at + id_len + 32 + 16;
        if row_end > bytes.len() {
            return Err(malformed());
        }
        let id = std::str::from_utf8(&bytes[at..at + id_len])
            .map_err(|_| ObjectError::PackTable {
                reason: "an item id is not UTF-8",
            })?
            .to_owned();
        at += id_len;
        let mut name = [0_u8; 32];
        name.copy_from_slice(&bytes[at..at + 32]);
        at += 32;
        let offset = u64::from_be_bytes(bytes[at..at + 8].try_into().map_err(|_| malformed())?);
        at += 8;
        let length = u64::from_be_bytes(bytes[at..at + 8].try_into().map_err(|_| malformed())?);
        at += 8;
        entries.push(PackEntry {
            id,
            name: ObjectName::from_raw(name),
            offset,
            length,
        });
    }
    if at != bytes.len() {
        return Err(malformed());
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: [u8; 32] = [4_u8; 32];
    const FILE_KEY: [u8; 32] = [12_u8; 32];
    /// The vault every object in these tests is sealed for — §4's AAD binding.
    const VAULT_KEY: [u8; 32] = [33_u8; 32];

    fn vault() -> VaultId<'static> {
        VaultId::new(&VAULT_KEY)
    }

    fn items<'a>(bodies: &'a [(&'a str, &'a [u8])]) -> Vec<PackItem<'a>> {
        bodies
            .iter()
            .map(|&(id, plaintext)| PackItem {
                id,
                custody: Custody::FileKey(&FILE_KEY),
                kind: Kind::Thumbnail,
                role: Role::Thumbnail,
                plaintext,
            })
            .collect()
    }

    fn a_pack() -> Pack {
        let bodies: [(&str, &[u8]); 3] = [
            ("thumb-a", b"the first thumbnail"),
            ("thumb-b", b"the second thumbnail"),
            ("thumb-c", b"the third thumbnail"),
        ];
        build(vault(), &ROOT, &items(&bodies), None).expect("packs")
    }

    #[test]
    fn every_item_opens_by_the_range_the_vault_recorded() {
        let pack = a_pack();
        assert_eq!(pack.entries.len(), 3);
        let opened = open_range(
            vault(),
            Custody::FileKey(&FILE_KEY),
            &pack.bytes,
            &pack.entries[1],
            None,
        )
        .expect("opens by range");
        assert_eq!(opened, b"the second thumbnail");
    }

    #[test]
    fn the_trailing_table_rebuilds_the_rows_a_restore_has_not_got() {
        let pack = a_pack();
        assert_eq!(
            read_table(vault(), &ROOT, &pack.bytes, None).expect("reads"),
            pack.entries
        );
    }

    #[test]
    fn a_row_pointing_outside_the_pack_is_refused() {
        let pack = a_pack();
        let mut lying = pack.entries[0].clone();
        lying.length = pack.bytes.len() as u64 + 1;
        assert!(matches!(
            open_range(
                vault(),
                Custody::FileKey(&FILE_KEY),
                &pack.bytes,
                &lying,
                None
            ),
            Err(ObjectError::PackTable { .. })
        ));
    }

    /// An item's bytes are its own object, so a row that points at a different
    /// item is caught by the name before anything is decrypted.
    #[test]
    fn a_row_pointing_at_the_wrong_item_is_refused() {
        let pack = a_pack();
        let mut swapped = pack.entries[0].clone();
        swapped.offset = pack.entries[1].offset;
        swapped.length = pack.entries[1].length;
        assert_eq!(
            open_range(
                vault(),
                Custody::FileKey(&FILE_KEY),
                &pack.bytes,
                &swapped,
                None
            ),
            Err(ObjectError::ReadBackMismatch)
        );
    }

    #[test]
    fn repacking_drops_the_dead_items_and_keeps_the_live_bytes_verbatim() {
        let pack = a_pack();
        let live: BTreeSet<String> = ["thumb-a".to_owned(), "thumb-c".to_owned()].into();
        assert!(should_repack(&pack.entries, &live));

        let repacked = repack(
            vault(),
            &ROOT,
            &pack.bytes,
            &pack.entries,
            &live,
            &NoLiveShares,
            None,
        )
        .expect("repacks");
        assert_eq!(repacked.entries.len(), 2);
        assert_eq!(repacked.entries[0].name, pack.entries[0].name);
        assert_eq!(repacked.entries[1].name, pack.entries[2].name);
        assert_eq!(
            open_range(
                vault(),
                Custody::FileKey(&FILE_KEY),
                &repacked.bytes,
                &repacked.entries[1],
                None
            )
            .expect("opens"),
            b"the third thumbnail"
        );
    }

    /// F8: a pack a live share references is never repacked — and the refusal
    /// comes before a single byte is copied.
    #[test]
    fn a_pack_a_live_share_references_is_never_repacked() {
        struct EverythingIsShared;
        impl LiveShareIndex for EverythingIsShared {
            fn is_referenced_by_live_share(&self, _pack: &ObjectName) -> bool {
                true
            }
        }

        let pack = a_pack();
        let live: BTreeSet<String> = ["thumb-a".to_owned()].into();
        assert_eq!(
            repack(
                vault(),
                &ROOT,
                &pack.bytes,
                &pack.entries,
                &live,
                &EverythingIsShared,
                None
            ),
            Err(ObjectError::PackIsShared)
        );
    }

    #[test]
    fn the_threshold_is_what_decides_and_a_whole_live_pack_is_left_alone() {
        let pack = a_pack();
        let all: BTreeSet<String> = pack.entries.iter().map(|entry| entry.id.clone()).collect();
        assert!(!should_repack(&pack.entries, &all));
        assert!(!should_repack(&[], &all));
    }

    #[test]
    fn a_damaged_trailer_is_refused_before_the_table_is_opened() {
        let mut pack = a_pack();
        let last = pack.bytes.len() - 1;
        pack.bytes[last] ^= 0xff;
        assert!(matches!(
            read_table(vault(), &ROOT, &pack.bytes, None),
            Err(ObjectError::PackTable { .. })
        ));
    }
}
