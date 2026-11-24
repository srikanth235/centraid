//! The tree (manifest v6): a snapshot as a set of small content-addressed
//! nodes ([#1212](https://github.com/srikanth235/centraid/issues/1212), spec §3).
//!
//! ```text
//! Root       writes, user_version, page_size, page_count, taken_at_ms, census,
//!            db_hash (or none), range_leaves: [Ref], blobs: Ref, directory: Ref
//! RangeLeaf  first_range_index, [Ref]   (at most 1024 ranges of 64 KiB, class records)
//! BlobsNode  depth, prefix, stats: BlobsStats,
//!            either children: [(byte, Ref)] (at most 256, by the next byte of h)
//!            or entries: [Entry] (at most 256, sorted by h)
//! Entry      h, kind: EntryKind, size, media_type, taken_at_ms (i64), original: [Ref], thumbnail: [Ref]
//! ```
//!
//! Every node is a pure function of its content, sealed as one chunk of class
//! `records`, so one changed range rewrites one leaf and the root, and one new
//! photo rewrites one path of blobs nodes plus its own chunks.
//!
//! ## ENCODING
//!
//! The signing scheme's canonical form: every field is `u32be(len) ‖ bytes`,
//! an unsigned integer is a field of eight `u64be` bytes, a signed timestamp
//! is a field of eight `i64be` bytes, a list is `u32be(count)` and
//! then its items, and the first two fields are the node-kind tag and
//! `u8(6)`. A decoder refuses anything the encoder would not have written:
//! trailing bytes, an unsorted or oversized list, a ref of the wrong class,
//! mismatched `EntryKind`/refs, or mismatched leaf `BlobsStats`.
//!
//! ## WHERE A BLOB GOES
//!
//! A blob that is a derivative (the `out` of a thumb, preview or poster row)
//! carries its own chunks in `thumbnail` (class thumbnails) and an empty
//! `original`; an original carries `original` (class originals) and an empty
//! `thumbnail`; an excluded original carries neither. A blob whose bytes the
//! phone could not read has empty refs and is unheld.

use std::collections::{BTreeMap, BTreeSet};

use centraid_media::sealed::{
    self, BackupKeys, CHUNK_BYTES, Class, Name, PlaintextHash, REF_BYTES, Ref, Sealed,
};

use super::{PlaneError, Result, invariant};

/// The tree format's version byte.
pub const TREE_VERSION: u8 = 6;

/// Ranges one leaf names.
pub const LEAF_RANGES: usize = 1024;

/// Entries one blobs leaf holds before it splits by the next byte of `h`.
pub const LEAF_ENTRIES: usize = 256;

/// The vault range: 64 KiB, a whole number of pages at any page size.
pub const RANGE_BYTES: usize = 64 * 1024;

const KIND_ROOT: u8 = 1;
const KIND_LEAF: u8 = 2;
const KIND_BLOBS: u8 = 3;

/// What kind of blob an [`Entry`] represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntryKind {
    Original = 1,
    Thumbnail = 2,
    ExcludedOriginal = 3,
}

impl EntryKind {
    #[must_use]
    pub const fn byte(self) -> u8 {
        self as u8
    }

    #[must_use]
    pub const fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Original),
            2 => Some(Self::Thumbnail),
            3 => Some(Self::ExcludedOriginal),
            _ => None,
        }
    }
}

/// One blob the vault claims, as the tree lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub h: PlaintextHash,
    pub kind: EntryKind,
    pub size: u64,
    pub media_type: String,
    pub taken_at_ms: i64,
    pub original: Vec<Ref>,
    pub thumbnail: Vec<Ref>,
}

/// Rolled-up counts and byte sizes across a [`BlobsNode`] subtree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BlobsStats {
    pub orig_files: u64,
    pub orig_bytes: u64,
    pub thumb_files: u64,
    pub thumb_bytes: u64,
    pub unheld_orig_files: u64,
    pub unheld_orig_bytes: u64,
    pub unheld_thumb_files: u64,
    pub unheld_thumb_bytes: u64,
    pub excluded_orig_files: u64,
    pub excluded_orig_bytes: u64,
}

impl BlobsStats {
    /// Accumulate `other` into `self` with saturating addition.
    pub fn add_assign(&mut self, other: Self) {
        self.orig_files = self.orig_files.saturating_add(other.orig_files);
        self.orig_bytes = self.orig_bytes.saturating_add(other.orig_bytes);
        self.thumb_files = self.thumb_files.saturating_add(other.thumb_files);
        self.thumb_bytes = self.thumb_bytes.saturating_add(other.thumb_bytes);
        self.unheld_orig_files = self
            .unheld_orig_files
            .saturating_add(other.unheld_orig_files);
        self.unheld_orig_bytes = self
            .unheld_orig_bytes
            .saturating_add(other.unheld_orig_bytes);
        self.unheld_thumb_files = self
            .unheld_thumb_files
            .saturating_add(other.unheld_thumb_files);
        self.unheld_thumb_bytes = self
            .unheld_thumb_bytes
            .saturating_add(other.unheld_thumb_bytes);
        self.excluded_orig_files = self
            .excluded_orig_files
            .saturating_add(other.excluded_orig_files);
        self.excluded_orig_bytes = self
            .excluded_orig_bytes
            .saturating_add(other.excluded_orig_bytes);
    }
}

impl Entry {
    /// Whether the bytes the entry names are all listed (it is not an entry
    /// the phone could not read or an excluded original).
    #[must_use]
    pub fn has_bytes(&self) -> bool {
        match self.kind {
            EntryKind::Original => !self.original.is_empty() || self.size == 0,
            EntryKind::Thumbnail => !self.thumbnail.is_empty() || self.size == 0,
            EntryKind::ExcludedOriginal => false,
        }
    }

    /// Whether this in-scope entry has non-zero size yet lacks sealed chunk refs.
    #[must_use]
    pub fn is_unheld(&self) -> bool {
        match self.kind {
            EntryKind::Original => self.size > 0 && self.original.is_empty(),
            EntryKind::Thumbnail => self.size > 0 && self.thumbnail.is_empty(),
            EntryKind::ExcludedOriginal => false,
        }
    }

    /// The single-entry contribution to [`BlobsStats`].
    #[must_use]
    pub fn stats(&self) -> BlobsStats {
        let mut stats = BlobsStats::default();
        match self.kind {
            EntryKind::Original => {
                stats.orig_files = 1;
                stats.orig_bytes = self.size;
                if self.size > 0 && self.original.is_empty() {
                    stats.unheld_orig_files = 1;
                    stats.unheld_orig_bytes = self.size;
                }
            }
            EntryKind::Thumbnail => {
                stats.thumb_files = 1;
                stats.thumb_bytes = self.size;
                if self.size > 0 && self.thumbnail.is_empty() {
                    stats.unheld_thumb_files = 1;
                    stats.unheld_thumb_bytes = self.size;
                }
            }
            EntryKind::ExcludedOriginal => {
                stats.excluded_orig_files = 1;
                stats.excluded_orig_bytes = self.size;
            }
        }
        stats
    }

    /// The refs of one media class.
    #[must_use]
    pub fn refs(&self, class: Class) -> &[Ref] {
        match class {
            Class::Originals => &self.original,
            Class::Thumbnails => &self.thumbnail,
            Class::Records => &[],
        }
    }
}

/// A snapshot's root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub writes: u64,
    pub user_version: u64,
    pub page_size: u64,
    pub page_count: u64,
    pub taken_at_ms: u64,
    pub census: BTreeMap<String, u64>,
    /// BLAKE3 over every page, set only by a full read (spec §5).
    pub db_hash: Option<[u8; 32]>,
    pub range_leaves: Vec<Ref>,
    pub blobs: Ref,
    pub directory: Ref,
}

impl Root {
    /// How many 64 KiB ranges the vault is.
    #[must_use]
    pub const fn range_count(&self) -> u64 {
        self.page_size
            .saturating_mul(self.page_count)
            .div_ceil(RANGE_BYTES as u64)
    }
}

/// A leaf of range refs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeLeaf {
    pub first: u64,
    pub ranges: Vec<Ref>,
}

/// A node of the blobs radix tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobsNode {
    pub depth: u8,
    pub prefix: Vec<u8>,
    pub stats: BlobsStats,
    pub body: BlobsBody,
}

/// What a blobs node holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobsBody {
    Children(Vec<(u8, Ref)>),
    Entries(Vec<Entry>),
}

/// Any node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Root(Box<Root>),
    Leaf(RangeLeaf),
    Blobs(BlobsNode),
}

// ─── canonical encoding ─────────────────────────────────────────────────────

#[derive(Default)]
struct Writer(Vec<u8>);

impl Writer {
    fn field(&mut self, bytes: &[u8]) {
        self.0
            .extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
        self.0.extend_from_slice(bytes);
    }

    fn int(&mut self, value: u64) {
        self.field(&value.to_be_bytes());
    }

    fn signed_int(&mut self, value: i64) {
        self.field(&value.to_be_bytes());
    }

    fn count(&mut self, count: usize) {
        self.0
            .extend_from_slice(&u32::try_from(count).unwrap_or(u32::MAX).to_be_bytes());
    }

    fn reference(&mut self, reference: &Ref) {
        self.field(&reference.encode());
    }

    fn header(kind: u8) -> Self {
        let mut writer = Self::default();
        writer.field(&[kind]);
        writer.field(&[TREE_VERSION]);
        writer
    }
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.0.len() < n {
            return Err(invariant("a tree node is cut short"));
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn field(&mut self) -> Result<&'a [u8]> {
        let len = u32::from_be_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| invariant("a tree node is cut short"))?,
        );
        self.take(usize::try_from(len).unwrap_or(usize::MAX))
    }

    fn int(&mut self) -> Result<u64> {
        let bytes: [u8; 8] = self
            .field()?
            .try_into()
            .map_err(|_| invariant("a tree node's integer is not eight bytes"))?;
        Ok(u64::from_be_bytes(bytes))
    }

    fn signed_int(&mut self) -> Result<i64> {
        let bytes: [u8; 8] = self
            .field()?
            .try_into()
            .map_err(|_| invariant("a tree node's signed integer is not eight bytes"))?;
        Ok(i64::from_be_bytes(bytes))
    }

    fn count(&mut self, most: usize, min_item_bytes: usize) -> Result<usize> {
        let count = u32::from_be_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| invariant("a tree node is cut short"))?,
        );
        let count = usize::try_from(count).unwrap_or(usize::MAX);
        if count > most {
            return Err(invariant("a tree node lists more than it may"));
        }
        if count > self.0.len() / min_item_bytes.max(1) {
            return Err(invariant("a tree node is cut short"));
        }
        Ok(count)
    }

    fn reference(&mut self, class: Class) -> Result<Ref> {
        let reference = Ref::decode(self.field()?)?;
        if reference.class != class {
            return Err(invariant("a tree node names an object of the wrong class"));
        }
        Ok(reference)
    }

    fn byte(&mut self) -> Result<u8> {
        match self.field()? {
            [one] => Ok(*one),
            _ => Err(invariant("a tree node's byte field is not one byte")),
        }
    }

    fn finish(self) -> Result<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(invariant("bytes follow a tree node"))
        }
    }
}

impl Node {
    /// The canonical plaintext.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Root(root) => {
                let mut w = Writer::header(KIND_ROOT);
                w.int(root.writes);
                w.int(root.user_version);
                w.int(root.page_size);
                w.int(root.page_count);
                w.int(root.taken_at_ms);
                w.count(root.census.len());
                for (table, rows) in &root.census {
                    w.field(table.as_bytes());
                    w.int(*rows);
                }
                w.field(root.db_hash.as_ref().map_or(&[][..], |hash| &hash[..]));
                w.count(root.range_leaves.len());
                for leaf in &root.range_leaves {
                    w.reference(leaf);
                }
                w.reference(&root.blobs);
                w.reference(&root.directory);
                w.0
            }
            Self::Leaf(leaf) => {
                let mut w = Writer::header(KIND_LEAF);
                w.int(leaf.first);
                w.count(leaf.ranges.len());
                for range in &leaf.ranges {
                    w.reference(range);
                }
                w.0
            }
            Self::Blobs(node) => {
                let mut w = Writer::header(KIND_BLOBS);
                w.field(&[node.depth]);
                w.field(&node.prefix);
                w.int(node.stats.orig_files);
                w.int(node.stats.orig_bytes);
                w.int(node.stats.thumb_files);
                w.int(node.stats.thumb_bytes);
                w.int(node.stats.unheld_orig_files);
                w.int(node.stats.unheld_orig_bytes);
                w.int(node.stats.unheld_thumb_files);
                w.int(node.stats.unheld_thumb_bytes);
                w.int(node.stats.excluded_orig_files);
                w.int(node.stats.excluded_orig_bytes);
                match &node.body {
                    BlobsBody::Children(children) => {
                        w.field(&[0]);
                        w.count(children.len());
                        for (byte, child) in children {
                            w.field(&[*byte]);
                            w.reference(child);
                        }
                    }
                    BlobsBody::Entries(entries) => {
                        w.field(&[1]);
                        w.count(entries.len());
                        for entry in entries {
                            w.field(entry.h.as_bytes());
                            w.field(&[entry.kind.byte()]);
                            w.int(entry.size);
                            w.field(entry.media_type.as_bytes());
                            w.signed_int(entry.taken_at_ms);
                            w.count(entry.original.len());
                            for chunk in &entry.original {
                                w.reference(chunk);
                            }
                            w.count(entry.thumbnail.len());
                            for chunk in &entry.thumbnail {
                                w.reference(chunk);
                            }
                        }
                    }
                }
                w.0
            }
        }
    }

    /// Read a node back, refusing anything the encoder would not write.
    ///
    /// # Errors
    /// A malformed, cut-short or non-canonical node.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader(bytes);
        let kind = r.byte()?;
        if r.byte()? != TREE_VERSION {
            return Err(invariant("a tree node is not version 6"));
        }
        let node = match kind {
            KIND_ROOT => {
                let writes = r.int()?;
                let user_version = r.int()?;
                let page_size = r.int()?;
                let page_count = r.int()?;
                if page_size.checked_mul(page_count).is_none() {
                    return Err(invariant("a root's page_size * page_count overflows"));
                }
                let taken_at_ms = r.int()?;
                let tables = r.count(100_000, 4 + 12)?;
                let mut census = BTreeMap::new();
                for _ in 0..tables {
                    let table = std::str::from_utf8(r.field()?)
                        .map_err(|_| invariant("a census table is not text"))?
                        .to_owned();
                    let rows = r.int()?;
                    if census.insert(table, rows).is_some() {
                        return Err(invariant("a census names a table twice"));
                    }
                }
                let db_hash = match r.field()? {
                    [] => None,
                    other => Some(
                        <[u8; 32]>::try_from(other)
                            .map_err(|_| invariant("a db_hash is not 32 bytes"))?,
                    ),
                };
                let leaves = r.count(1 << 20, 4 + REF_BYTES)?;
                let mut range_leaves = Vec::with_capacity(leaves);
                for _ in 0..leaves {
                    range_leaves.push(r.reference(Class::Records)?);
                }
                let blobs = r.reference(Class::Records)?;
                let directory = r.reference(Class::Records)?;
                Self::Root(Box::new(Root {
                    writes,
                    user_version,
                    page_size,
                    page_count,
                    taken_at_ms,
                    census,
                    db_hash,
                    range_leaves,
                    blobs,
                    directory,
                }))
            }
            KIND_LEAF => {
                let first = r.int()?;
                let count = r.count(LEAF_RANGES, 4 + REF_BYTES)?;
                let mut ranges = Vec::with_capacity(count);
                for _ in 0..count {
                    ranges.push(r.reference(Class::Records)?);
                }
                Self::Leaf(RangeLeaf { first, ranges })
            }
            KIND_BLOBS => {
                let depth = r.byte()?;
                let prefix = r.field()?.to_vec();
                if prefix.len() != usize::from(depth) {
                    return Err(invariant("a blobs node's prefix is not its depth"));
                }
                let stats = BlobsStats {
                    orig_files: r.int()?,
                    orig_bytes: r.int()?,
                    thumb_files: r.int()?,
                    thumb_bytes: r.int()?,
                    unheld_orig_files: r.int()?,
                    unheld_orig_bytes: r.int()?,
                    unheld_thumb_files: r.int()?,
                    unheld_thumb_bytes: r.int()?,
                    excluded_orig_files: r.int()?,
                    excluded_orig_bytes: r.int()?,
                };
                let body = match r.byte()? {
                    0 => {
                        let count = r.count(256, 5 + 4 + REF_BYTES)?;
                        let mut children: Vec<(u8, Ref)> = Vec::with_capacity(count);
                        for _ in 0..count {
                            let byte = r.byte()?;
                            if children.last().is_some_and(|(last, _)| *last >= byte) {
                                return Err(invariant("a blobs node's children are not sorted"));
                            }
                            children.push((byte, r.reference(Class::Records)?));
                        }
                        BlobsBody::Children(children)
                    }
                    1 => {
                        let count = r.count(LEAF_ENTRIES, 77)?;
                        let mut entries: Vec<Entry> = Vec::with_capacity(count);
                        let mut computed_stats = BlobsStats::default();
                        for _ in 0..count {
                            let h = PlaintextHash::from_bytes(
                                <[u8; 32]>::try_from(r.field()?)
                                    .map_err(|_| invariant("an entry's hash is not 32 bytes"))?,
                            );
                            if entries.last().is_some_and(|last| last.h >= h) {
                                return Err(invariant("a blobs node's entries are not sorted"));
                            }
                            let kind_byte = r.byte()?;
                            let kind = EntryKind::from_byte(kind_byte)
                                .ok_or_else(|| invariant("an entry has an unknown kind"))?;
                            let size = r.int()?;
                            let media_type = std::str::from_utf8(r.field()?)
                                .map_err(|_| invariant("a media type is not text"))?
                                .to_owned();
                            let taken_at_ms = r.signed_int()?;
                            let originals = r.count(1 << 24, 4 + REF_BYTES)?;
                            let mut original = Vec::with_capacity(originals);
                            for _ in 0..originals {
                                original.push(r.reference(Class::Originals)?);
                            }
                            let thumbs = r.count(1 << 24, 4 + REF_BYTES)?;
                            let mut thumbnail = Vec::with_capacity(thumbs);
                            for _ in 0..thumbs {
                                thumbnail.push(r.reference(Class::Thumbnails)?);
                            }
                            match kind {
                                EntryKind::Original if !thumbnail.is_empty() => {
                                    return Err(invariant(
                                        "an original entry carries thumbnail refs",
                                    ));
                                }
                                EntryKind::Thumbnail if !original.is_empty() => {
                                    return Err(invariant(
                                        "a thumbnail entry carries original refs",
                                    ));
                                }
                                EntryKind::ExcludedOriginal
                                    if !original.is_empty() || !thumbnail.is_empty() =>
                                {
                                    return Err(invariant("an excluded entry carries refs"));
                                }
                                _ => {}
                            }
                            let entry = Entry {
                                h,
                                kind,
                                size,
                                media_type,
                                taken_at_ms,
                                original,
                                thumbnail,
                            };
                            computed_stats.add_assign(entry.stats());
                            entries.push(entry);
                        }
                        if computed_stats != stats {
                            return Err(invariant("a blobs leaf's stats do not match its entries"));
                        }
                        BlobsBody::Entries(entries)
                    }
                    _ => return Err(invariant("a blobs node is neither children nor entries")),
                };
                Self::Blobs(BlobsNode {
                    depth,
                    prefix,
                    stats,
                    body,
                })
            }
            _ => return Err(invariant("an unknown tree node kind")),
        };
        r.finish()?;
        Ok(node)
    }

    /// Seal as one chunk of class `records`.
    ///
    /// # Errors
    /// A node larger than a chunk (cannot happen within the node limits).
    pub fn seal(&self, keys: &BackupKeys) -> Result<Sealed> {
        Ok(sealed::seal(keys, Class::Records, &self.encode())?)
    }
}

/// A node whose plaintext is known, and the object it seals to.
#[derive(Debug, Clone)]
pub struct Made {
    pub sealed: Sealed,
    pub plaintext: Vec<u8>,
}

fn make(keys: &BackupKeys, node: &Node, out: &mut Vec<Made>) -> Result<Ref> {
    let plaintext = node.encode();
    if plaintext.len() > CHUNK_BYTES {
        return Err(invariant("a tree node is larger than a chunk"));
    }
    let sealed = sealed::seal(keys, Class::Records, &plaintext)?;
    let reference = sealed.reference();
    out.push(Made { sealed, plaintext });
    Ok(reference)
}

/// The range leaves for `ranges` (one ref per 64 KiB range, in order).
///
/// # Errors
/// A node that does not seal.
pub fn build_leaves(keys: &BackupKeys, ranges: &[Ref], out: &mut Vec<Made>) -> Result<Vec<Ref>> {
    ranges
        .chunks(LEAF_RANGES)
        .enumerate()
        .map(|(n, chunk)| {
            make(
                keys,
                &Node::Leaf(RangeLeaf {
                    first: (n * LEAF_RANGES) as u64,
                    ranges: chunk.to_vec(),
                }),
                out,
            )
        })
        .collect()
}

/// The blobs radix tree for `entries`, which must be sorted by `h` and
/// distinct. A leaf over [`LEAF_ENTRIES`] splits by the next byte of `h`.
///
/// # Errors
/// Unsorted entries, or a node that does not seal.
pub fn build_blobs(keys: &BackupKeys, entries: &[Entry], out: &mut Vec<Made>) -> Result<Ref> {
    if entries.windows(2).any(|pair| pair[0].h >= pair[1].h) {
        return Err(invariant("blobs entries are not sorted and distinct"));
    }
    let (root_ref, _) = blobs_node(keys, entries, 0, out)?;
    Ok(root_ref)
}

/// Split a blobs leaf before it approaches [`CHUNK_BYTES`] (4 MiB), even when
/// it holds fewer than [`LEAF_ENTRIES`] entries (e.g. large videos with many
/// chunk refs).
const LEAF_TARGET_BYTES: usize = 3 * 1024 * 1024;

/// Exact encoded byte length of a [`BlobsNode`] carrying `entries` at `depth`.
fn entries_encoded_bytes(depth: usize, entries: &[Entry]) -> usize {
    // 10 (header) + 5 (depth) + 4 (prefix len) + depth + 120 (10 stats u64 fields) + 5 (body tag) + 4 (count) = 148 + depth
    let mut total = 148_usize.saturating_add(depth);
    let ref_bytes = 4 + REF_BYTES;
    for entry in entries {
        let refs = entry
            .original
            .len()
            .saturating_add(entry.thumbnail.len())
            .saturating_mul(ref_bytes);
        // 36 (h) + 5 (kind) + 12 (size) + 4 (media_type len) + 12 (taken_at_ms) + 4 (orig count) + 4 (thumb count) = 77
        total = total
            .saturating_add(77)
            .saturating_add(entry.media_type.len())
            .saturating_add(refs);
    }
    total
}

fn blobs_node(
    keys: &BackupKeys,
    entries: &[Entry],
    depth: usize,
    out: &mut Vec<Made>,
) -> Result<(Ref, BlobsStats)> {
    let prefix = entries
        .first()
        .map(|entry| entry.h.as_bytes()[..depth].to_vec())
        .unwrap_or_default();
    let depth_byte = u8::try_from(depth).map_err(|_| invariant("a blobs tree is too deep"))?;
    let fits_leaf = entries.len() <= 1
        || depth >= 32
        || (entries.len() <= LEAF_ENTRIES
            && entries_encoded_bytes(depth, entries) <= LEAF_TARGET_BYTES);
    if fits_leaf {
        let mut stats = BlobsStats::default();
        for entry in entries {
            stats.add_assign(entry.stats());
        }
        let reference = make(
            keys,
            &Node::Blobs(BlobsNode {
                depth: depth_byte,
                prefix,
                stats,
                body: BlobsBody::Entries(entries.to_vec()),
            }),
            out,
        )?;
        return Ok((reference, stats));
    }
    let mut children = Vec::new();
    let mut stats = BlobsStats::default();
    let mut start = 0;
    while start < entries.len() {
        let byte = entries[start].h.as_bytes()[depth];
        let end = start
            + entries[start..]
                .iter()
                .take_while(|entry| entry.h.as_bytes()[depth] == byte)
                .count();
        let (child_ref, child_stats) = blobs_node(keys, &entries[start..end], depth + 1, out)?;
        stats.add_assign(child_stats);
        children.push((byte, child_ref));
        start = end;
    }
    let reference = make(
        keys,
        &Node::Blobs(BlobsNode {
            depth: depth_byte,
            prefix,
            stats,
            body: BlobsBody::Children(children),
        }),
        out,
    )?;
    Ok((reference, stats))
}

/// Where a walk finds a node by name: the device's node cache, or a map.
pub trait NodeSource {
    /// The node's plaintext, when this source holds it.
    ///
    /// # Errors
    /// The source's own failure.
    fn plaintext(&self, name: &Name) -> Result<Option<Vec<u8>>>;
}

impl NodeSource for BTreeMap<Name, Vec<u8>> {
    fn plaintext(&self, name: &Name) -> Result<Option<Vec<u8>>> {
        Ok(self.get(name).cloned())
    }
}

/// A node that a walk needed and the source did not hold.
fn node_of(source: &dyn NodeSource, reference: &Ref) -> Result<Node> {
    let plaintext = source
        .plaintext(&reference.name)?
        .ok_or_else(|| PlaneError::NodeMissing(reference.name))?;
    Node::decode(&plaintext)
}

fn blobs_node_of(source: &dyn NodeSource, reference: &Ref) -> Result<BlobsNode> {
    match node_of(source, reference)? {
        Node::Blobs(node) => Ok(node),
        _ => Err(invariant("a blobs ref names something else")),
    }
}

/// The root a ref names.
///
/// # Errors
/// A missing node, or one that is not a root.
pub fn root_of(source: &dyn NodeSource, reference: &Ref) -> Result<Root> {
    match node_of(source, reference)? {
        Node::Root(root) => Ok(*root),
        _ => Err(invariant("a root's name is not a root")),
    }
}

/// The rolled-up [`BlobsStats`] of the blobs subtree at `blobs`, in `O(1)` (1 node read).
///
/// # Errors
/// A missing or malformed node.
pub fn stats_of(source: &dyn NodeSource, blobs: &Ref) -> Result<BlobsStats> {
    Ok(blobs_node_of(source, blobs)?.stats)
}

/// Look up a single blob entry by `h` in `O(depth)`.
///
/// # Errors
/// A missing or malformed node.
pub fn lookup_entry(
    source: &dyn NodeSource,
    blobs: &Ref,
    h: &PlaintextHash,
) -> Result<Option<Entry>> {
    let mut current = *blobs;
    loop {
        let node = blobs_node_of(source, &current)?;
        if !h.as_bytes().starts_with(&node.prefix) {
            return Ok(None);
        }
        match node.body {
            BlobsBody::Entries(entries) => {
                return Ok(entries
                    .binary_search_by(|entry| entry.h.cmp(h))
                    .ok()
                    .map(|idx| entries[idx].clone()));
            }
            BlobsBody::Children(children) => {
                let Some(&byte) = h.as_bytes().get(usize::from(node.depth)) else {
                    return Ok(None);
                };
                let Ok(idx) = children.binary_search_by_key(&byte, |(b, _)| *b) else {
                    return Ok(None);
                };
                current = children[idx].1;
            }
        }
    }
}

/// Entries in `new_blobs` that were added or changed relative to `old_blobs`,
/// skipping subtrees with identical [`Ref::name`].
///
/// # Errors
/// A missing or malformed node.
pub fn diff_entries(
    source: &dyn NodeSource,
    old_blobs: Option<&Ref>,
    new_blobs: &Ref,
) -> Result<Vec<Entry>> {
    let Some(old_blobs) = old_blobs else {
        return entries_of(source, new_blobs);
    };
    if old_blobs.name == new_blobs.name {
        return Ok(Vec::new());
    }
    let old_node = blobs_node_of(source, old_blobs)?;
    let new_node = blobs_node_of(source, new_blobs)?;
    match (old_node.body, new_node.body) {
        (BlobsBody::Entries(old_entries), BlobsBody::Entries(new_entries)) => {
            let mut out = Vec::new();
            let mut i = 0;
            let mut j = 0;
            while j < new_entries.len() {
                while i < old_entries.len() && old_entries[i].h < new_entries[j].h {
                    i += 1;
                }
                if i < old_entries.len() && old_entries[i].h == new_entries[j].h {
                    if old_entries[i] != new_entries[j] {
                        out.push(new_entries[j].clone());
                    }
                    i += 1;
                } else {
                    out.push(new_entries[j].clone());
                }
                j += 1;
            }
            Ok(out)
        }
        (BlobsBody::Children(old_children), BlobsBody::Children(new_children)) => {
            let mut out = Vec::new();
            let mut i = 0;
            let mut j = 0;
            while j < new_children.len() {
                let (new_byte, new_child) = new_children[j];
                while i < old_children.len() && old_children[i].0 < new_byte {
                    i += 1;
                }
                if i < old_children.len() && old_children[i].0 == new_byte {
                    let old_child = old_children[i].1;
                    if old_child.name != new_child.name {
                        out.extend(diff_entries(source, Some(&old_child), &new_child)?);
                    }
                    i += 1;
                } else {
                    out.extend(entries_of(source, &new_child)?);
                }
                j += 1;
            }
            Ok(out)
        }
        (BlobsBody::Entries(old_entries), BlobsBody::Children(new_children)) => {
            let new_entries = entries_from_children(source, new_children)?;
            let mut out = Vec::new();
            let mut i = 0;
            for entry in new_entries {
                while i < old_entries.len() && old_entries[i].h < entry.h {
                    i += 1;
                }
                if i < old_entries.len() && old_entries[i].h == entry.h {
                    if old_entries[i] != entry {
                        out.push(entry);
                    }
                    i += 1;
                } else {
                    out.push(entry);
                }
            }
            Ok(out)
        }
        (BlobsBody::Children(old_children), BlobsBody::Entries(new_entries)) => {
            let old_entries = entries_from_children(source, old_children)?;
            let mut out = Vec::new();
            let mut i = 0;
            for entry in new_entries {
                while i < old_entries.len() && old_entries[i].h < entry.h {
                    i += 1;
                }
                if i < old_entries.len() && old_entries[i].h == entry.h {
                    if old_entries[i] != entry {
                        out.push(entry);
                    }
                    i += 1;
                } else {
                    out.push(entry);
                }
            }
            Ok(out)
        }
    }
}

fn entries_from_children(source: &dyn NodeSource, children: Vec<(u8, Ref)>) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for (_, child) in children {
        out.extend(entries_of(source, &child)?);
    }
    Ok(out)
}

/// Every blobs entry of the tree whose blobs ref is `blobs`, sorted by `h`.
///
/// # Errors
/// A missing or malformed node.
pub fn entries_of(source: &dyn NodeSource, blobs: &Ref) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    let mut stack = vec![*blobs];
    // Depth-first in key order: children are pushed reversed.
    while let Some(reference) = stack.pop() {
        match blobs_node_of(source, &reference)? {
            BlobsNode {
                body: BlobsBody::Entries(entries),
                ..
            } => out.extend(entries),
            BlobsNode {
                body: BlobsBody::Children(children),
                ..
            } => stack.extend(children.into_iter().rev().map(|(_, child)| child)),
        }
    }
    Ok(out)
}

/// Every records-class ref reachable from a root: the root itself, its range
/// leaves, the range chunks, the blobs nodes and the directory.
///
/// # Errors
/// A missing or malformed node.
pub fn records_of(source: &dyn NodeSource, root_ref: &Ref) -> Result<BTreeMap<Name, Ref>> {
    let root = root_of(source, root_ref)?;
    let mut out = BTreeMap::new();
    out.insert(root_ref.name, *root_ref);
    out.insert(root.directory.name, root.directory);
    for leaf in &root.range_leaves {
        out.insert(leaf.name, *leaf);
        match node_of(source, leaf)? {
            Node::Leaf(leaf) => {
                for range in leaf.ranges {
                    out.insert(range.name, range);
                }
            }
            _ => return Err(invariant("a range leaf's ref names something else")),
        }
    }
    let mut stack = vec![root.blobs];
    while let Some(reference) = stack.pop() {
        out.insert(reference.name, reference);
        if let BlobsNode {
            body: BlobsBody::Children(children),
            ..
        } = blobs_node_of(source, &reference)?
        {
            stack.extend(children.into_iter().map(|(_, child)| child));
        }
    }
    Ok(out)
}

/// Memoized collection of every node name (root, range leaves, blobs nodes, directory)
/// reachable from `root`, skipping subtrees whose [`Name`] is already in `visited`.
///
/// # Errors
/// A missing or malformed node.
pub fn collect_nodes_into(
    source: &dyn NodeSource,
    root_ref: &Ref,
    visited: &mut BTreeSet<Name>,
) -> Result<()> {
    if !visited.insert(root_ref.name) {
        return Ok(());
    }
    let root = root_of(source, root_ref)?;
    visited.insert(root.directory.name);
    for leaf in &root.range_leaves {
        visited.insert(leaf.name);
    }
    let mut stack = Vec::new();
    if visited.insert(root.blobs.name) {
        stack.push(root.blobs);
    }
    while let Some(reference) = stack.pop() {
        if let BlobsNode {
            body: BlobsBody::Children(children),
            ..
        } = blobs_node_of(source, &reference)?
        {
            for (_, child) in children {
                if !visited.insert(child.name) {
                    continue;
                }
                stack.push(child);
            }
        }
    }
    Ok(())
}

/// Every node (root, range leaves, blobs nodes, directory) of the tree a root names: what the
/// node cache keeps for it.
///
/// # Errors
/// A missing or malformed node.
pub fn nodes_of(source: &dyn NodeSource, root_ref: &Ref) -> Result<BTreeSet<Name>> {
    let mut visited = BTreeSet::new();
    collect_nodes_into(source, root_ref, &mut visited)?;
    Ok(visited)
}

/// Every ref of one media class reachable from a root's blobs tree.
///
/// # Errors
/// A missing or malformed node.
pub fn media_of(
    source: &dyn NodeSource,
    root_ref: &Ref,
    class: Class,
) -> Result<BTreeMap<Name, Ref>> {
    let root = root_of(source, root_ref)?;
    let mut out = BTreeMap::new();
    for entry in entries_of(source, &root.blobs)? {
        for chunk in entry.refs(class) {
            out.insert(chunk.name, *chunk);
        }
    }
    Ok(out)
}

/// Memoized collection of every reachable object name (records, thumbnails, originals)
/// from `root`, skipping decoding any node whose [`Name`] is already in `visited_nodes`.
///
/// # Errors
/// A missing or malformed node.
pub fn collect_everything_into(
    source: &dyn NodeSource,
    root_ref: &Ref,
    visited_nodes: &mut BTreeSet<Name>,
    keep_names: &mut BTreeSet<Name>,
) -> Result<()> {
    keep_names.insert(root_ref.name);
    if !visited_nodes.insert(root_ref.name) {
        return Ok(());
    }
    let root = root_of(source, root_ref)?;
    keep_names.insert(root.directory.name);
    for leaf_ref in &root.range_leaves {
        keep_names.insert(leaf_ref.name);
        if !visited_nodes.insert(leaf_ref.name) {
            continue;
        }
        match node_of(source, leaf_ref)? {
            Node::Leaf(leaf) => {
                for range in leaf.ranges {
                    keep_names.insert(range.name);
                }
            }
            _ => return Err(invariant("a range leaf's ref names something else")),
        }
    }
    keep_names.insert(root.blobs.name);
    let mut stack = Vec::new();
    if visited_nodes.insert(root.blobs.name) {
        stack.push(root.blobs);
    }
    while let Some(reference) = stack.pop() {
        match blobs_node_of(source, &reference)? {
            BlobsNode {
                body: BlobsBody::Children(children),
                ..
            } => {
                for (_, child) in children {
                    keep_names.insert(child.name);
                    if visited_nodes.insert(child.name) {
                        stack.push(child);
                    }
                }
            }
            BlobsNode {
                body: BlobsBody::Entries(entries),
                ..
            } => {
                for entry in entries {
                    for chunk in &entry.original {
                        keep_names.insert(chunk.name);
                    }
                    for chunk in &entry.thumbnail {
                        keep_names.insert(chunk.name);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Every name reachable from a root, of every class.
///
/// # Errors
/// A missing or malformed node.
pub fn everything_of(source: &dyn NodeSource, root_ref: &Ref) -> Result<BTreeSet<Name>> {
    let mut visited_nodes = BTreeSet::new();
    let mut names = BTreeSet::new();
    collect_everything_into(source, root_ref, &mut visited_nodes, &mut names)?;
    Ok(names)
}

/// The range refs of a root, in range order.
///
/// # Errors
/// A missing or malformed node.
pub fn ranges_of(source: &dyn NodeSource, root: &Root) -> Result<Vec<Ref>> {
    let mut out = Vec::new();
    for leaf in &root.range_leaves {
        match node_of(source, leaf)? {
            Node::Leaf(leaf) => out.extend(leaf.ranges),
            _ => return Err(invariant("a range leaf's ref names something else")),
        }
    }
    Ok(out)
}

/// A whole tree built in memory.
#[derive(Debug, Clone)]
pub struct Assembled {
    pub root: Ref,
    /// Every node, the root last.
    pub nodes: Vec<Made>,
}

impl Assembled {
    /// The nodes as a source for the walks above.
    #[must_use]
    pub fn source(&self) -> BTreeMap<Name, Vec<u8>> {
        self.nodes
            .iter()
            .map(|made| (made.sealed.name, made.plaintext.clone()))
            .collect()
    }
}

/// What a root records besides its children.
#[derive(Debug, Clone)]
pub struct Header {
    pub writes: u64,
    pub user_version: u64,
    pub page_size: u64,
    pub page_count: u64,
    pub taken_at_ms: u64,
    pub census: BTreeMap<String, u64>,
    pub db_hash: Option<[u8; 32]>,
}

/// Build a whole tree from the vault's range refs, its blobs entries (sorted
/// by `h`) and the directory's ref.
///
/// # Errors
/// What [`build_blobs`] refuses, or a node that does not seal.
pub fn assemble(
    keys: &BackupKeys,
    header: Header,
    ranges: &[Ref],
    entries: &[Entry],
    directory: Ref,
) -> Result<Assembled> {
    let mut nodes = Vec::new();
    let range_leaves = build_leaves(keys, ranges, &mut nodes)?;
    let blobs = build_blobs(keys, entries, &mut nodes)?;
    let root = Node::Root(Box::new(Root {
        writes: header.writes,
        user_version: header.user_version,
        page_size: header.page_size,
        page_count: header.page_count,
        taken_at_ms: header.taken_at_ms,
        census: header.census,
        db_hash: header.db_hash,
        range_leaves,
        blobs,
        directory,
    }));
    let root_ref = make(keys, &root, &mut nodes)?;
    Ok(Assembled {
        root: root_ref,
        nodes,
    })
}

/// `REF_BYTES`, re-exported for callers that size lists.
pub const REF: usize = REF_BYTES;
