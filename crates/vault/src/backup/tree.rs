//! The tree (manifest v5): a snapshot as a set of small content-addressed
//! nodes ([#1209](https://github.com/srikanth235/centraid/issues/1209), spec §3).
//!
//! ```text
//! Root       writes, user_version, page_size, page_count, taken_at_ms, census,
//!            db_hash (or none), range_leaves: [Ref], blobs: Ref, directory: Ref
//! RangeLeaf  first_range_index, [Ref]   (at most 1024 ranges of 64 KiB, class records)
//! BlobsNode  depth, prefix, either children: [(byte, Ref)] (at most 256, by the next byte of h)
//!            or entries: [Entry] (at most 1024, sorted by h)
//! Entry      h, size, media_type, taken_at_ms, original: [Ref], thumbnail: [Ref]
//! ```
//!
//! Every node is a pure function of its content, sealed as one chunk of class
//! `records`, so one changed range rewrites one leaf and the root, and one new
//! photo rewrites one path of blobs nodes plus its own chunks.
//!
//! ## ENCODING
//!
//! The signing scheme's canonical form: every field is `u32be(len) ‖ bytes`,
//! an integer is a field of eight `u64be` bytes, a list is `u32be(count)` and
//! then its items, and the first two fields are the node-kind tag and
//! `u8(5)`. A decoder refuses anything the encoder would not have written:
//! trailing bytes, an unsorted or oversized list, a ref of the wrong class.
//!
//! ## WHERE A BLOB GOES
//!
//! A blob that is a derivative (the `out` of a thumb, preview or poster row)
//! carries its own chunks in `thumbnail` (class thumbnails) and an empty
//! `original`; every other blob carries `original` (class originals) and an
//! empty `thumbnail`. A blob whose bytes the phone could not read has both
//! empty and is not held.

use std::collections::{BTreeMap, BTreeSet};

use centraid_media::sealed::{
    self, BackupKeys, CHUNK_BYTES, Class, Name, PlaintextHash, REF_BYTES, Ref, Sealed,
};

use super::{PlaneError, Result, invariant};

/// The tree format's version byte.
pub const TREE_VERSION: u8 = 5;

/// Ranges one leaf names.
pub const LEAF_RANGES: usize = 1024;

/// Entries one blobs leaf holds before it splits by the next byte of `h`.
pub const LEAF_ENTRIES: usize = 1024;

/// The vault range: 64 KiB, a whole number of pages at any page size.
pub const RANGE_BYTES: usize = 64 * 1024;

const KIND_ROOT: u8 = 1;
const KIND_LEAF: u8 = 2;
const KIND_BLOBS: u8 = 3;

/// One blob the vault claims, as the tree lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub h: PlaintextHash,
    pub size: u64,
    pub media_type: String,
    pub taken_at_ms: u64,
    pub original: Vec<Ref>,
    pub thumbnail: Vec<Ref>,
}

impl Entry {
    /// Whether the bytes the entry names are all listed (it is not an entry
    /// the phone could not read).
    #[must_use]
    pub fn has_bytes(&self) -> bool {
        !self.original.is_empty() || !self.thumbnail.is_empty() || self.size == 0
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
        (self.page_size * self.page_count).div_ceil(RANGE_BYTES as u64)
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

    fn count(&mut self, most: usize) -> Result<usize> {
        let count = u32::from_be_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| invariant("a tree node is cut short"))?,
        );
        let count = usize::try_from(count).unwrap_or(usize::MAX);
        if count > most {
            return Err(invariant("a tree node lists more than it may"));
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
                            w.int(entry.size);
                            w.field(entry.media_type.as_bytes());
                            w.int(entry.taken_at_ms);
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
            return Err(invariant("a tree node is not version 5"));
        }
        let node = match kind {
            KIND_ROOT => {
                let writes = r.int()?;
                let user_version = r.int()?;
                let page_size = r.int()?;
                let page_count = r.int()?;
                let taken_at_ms = r.int()?;
                let tables = r.count(100_000)?;
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
                let leaves = r.count(1 << 20)?;
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
                let count = r.count(LEAF_RANGES)?;
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
                let body = match r.byte()? {
                    0 => {
                        let count = r.count(256)?;
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
                        let count = r.count(LEAF_ENTRIES)?;
                        let mut entries: Vec<Entry> = Vec::with_capacity(count);
                        for _ in 0..count {
                            let h = PlaintextHash::from_bytes(
                                <[u8; 32]>::try_from(r.field()?)
                                    .map_err(|_| invariant("an entry's hash is not 32 bytes"))?,
                            );
                            if entries.last().is_some_and(|last| last.h >= h) {
                                return Err(invariant("a blobs node's entries are not sorted"));
                            }
                            let size = r.int()?;
                            let media_type = std::str::from_utf8(r.field()?)
                                .map_err(|_| invariant("a media type is not text"))?
                                .to_owned();
                            let taken_at_ms = r.int()?;
                            let originals = r.count(1 << 24)?;
                            let mut original = Vec::with_capacity(originals);
                            for _ in 0..originals {
                                original.push(r.reference(Class::Originals)?);
                            }
                            let thumbs = r.count(1 << 24)?;
                            let mut thumbnail = Vec::with_capacity(thumbs);
                            for _ in 0..thumbs {
                                thumbnail.push(r.reference(Class::Thumbnails)?);
                            }
                            entries.push(Entry {
                                h,
                                size,
                                media_type,
                                taken_at_ms,
                                original,
                                thumbnail,
                            });
                        }
                        BlobsBody::Entries(entries)
                    }
                    _ => return Err(invariant("a blobs node is neither children nor entries")),
                };
                Self::Blobs(BlobsNode {
                    depth,
                    prefix,
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
    blobs_node(keys, entries, 0, out)
}

fn blobs_node(
    keys: &BackupKeys,
    entries: &[Entry],
    depth: usize,
    out: &mut Vec<Made>,
) -> Result<Ref> {
    let prefix = entries
        .first()
        .map(|entry| entry.h.as_bytes()[..depth].to_vec())
        .unwrap_or_default();
    let depth_byte = u8::try_from(depth).map_err(|_| invariant("a blobs tree is too deep"))?;
    if entries.len() <= LEAF_ENTRIES || depth >= 32 {
        return make(
            keys,
            &Node::Blobs(BlobsNode {
                depth: depth_byte,
                prefix,
                body: BlobsBody::Entries(entries.to_vec()),
            }),
            out,
        );
    }
    let mut children = Vec::new();
    let mut start = 0;
    while start < entries.len() {
        let byte = entries[start].h.as_bytes()[depth];
        let end = start
            + entries[start..]
                .iter()
                .take_while(|entry| entry.h.as_bytes()[depth] == byte)
                .count();
        children.push((
            byte,
            blobs_node(keys, &entries[start..end], depth + 1, out)?,
        ));
        start = end;
    }
    make(
        keys,
        &Node::Blobs(BlobsNode {
            depth: depth_byte,
            prefix,
            body: BlobsBody::Children(children),
        }),
        out,
    )
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

/// Every blobs entry of the tree whose blobs ref is `blobs`, sorted by `h`.
///
/// # Errors
/// A missing or malformed node.
pub fn entries_of(source: &dyn NodeSource, blobs: &Ref) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    let mut stack = vec![*blobs];
    // Depth-first in key order: children are pushed reversed.
    while let Some(reference) = stack.pop() {
        match node_of(source, &reference)? {
            Node::Blobs(BlobsNode {
                body: BlobsBody::Entries(entries),
                ..
            }) => out.extend(entries),
            Node::Blobs(BlobsNode {
                body: BlobsBody::Children(children),
                ..
            }) => stack.extend(children.into_iter().rev().map(|(_, child)| child)),
            _ => return Err(invariant("a blobs ref names something else")),
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
        if let Node::Blobs(BlobsNode {
            body: BlobsBody::Children(children),
            ..
        }) = node_of(source, &reference)?
        {
            stack.extend(children.into_iter().map(|(_, child)| child));
        }
    }
    Ok(out)
}

/// Every node (root, range leaves, blobs nodes, directory) of the tree a root names: what the
/// node cache keeps for it.
///
/// # Errors
/// A missing or malformed node.
pub fn nodes_of(source: &dyn NodeSource, root_ref: &Ref) -> Result<BTreeSet<Name>> {
    let root = root_of(source, root_ref)?;
    let mut out = BTreeSet::from([root_ref.name, root.directory.name]);
    out.extend(root.range_leaves.iter().map(|leaf| leaf.name));
    let mut stack = vec![root.blobs];
    while let Some(reference) = stack.pop() {
        out.insert(reference.name);
        if let Node::Blobs(BlobsNode {
            body: BlobsBody::Children(children),
            ..
        }) = node_of(source, &reference)?
        {
            stack.extend(children.into_iter().map(|(_, child)| child));
        }
    }
    Ok(out)
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

/// Every name reachable from a root, of every class.
///
/// # Errors
/// A missing or malformed node.
pub fn everything_of(source: &dyn NodeSource, root_ref: &Ref) -> Result<BTreeSet<Name>> {
    let mut names: BTreeSet<Name> = records_of(source, root_ref)?.into_keys().collect();
    for class in [Class::Thumbnails, Class::Originals] {
        names.extend(media_of(source, root_ref, class)?.into_keys());
    }
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
