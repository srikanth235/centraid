//! The tree (manifest v6, spec §3): canonical encoding, the blobs radix tree, rolled-up
//! `BlobsStats`, sublinear Merkle operations, and the counts the content addressing promises
//! (#1212). Counts, never durations.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use centraid_media::sealed::{self, BackupKeys, Class, Name, PlaintextHash, Ref};
use centraid_vault::backup::Result;
use centraid_vault::backup::directory::Directory;
use centraid_vault::backup::tree::{
    self, Assembled, BlobsBody, BlobsNode, BlobsStats, Entry, EntryKind, Header, LEAF_ENTRIES,
    LEAF_RANGES, Node, NodeSource, RangeLeaf, Root,
};

fn keys() -> BackupKeys {
    BackupKeys::from_root(&[3; 32])
}

fn range_ref(seed: u64) -> Ref {
    sealed::seal(&keys(), Class::Records, &seed.to_be_bytes().repeat(8192))
        .expect("seals")
        .reference()
}

fn chunk_ref(class: Class, seed: u64, index: u32) -> Ref {
    let mut bytes = seed.to_be_bytes().to_vec();
    bytes.extend_from_slice(&index.to_be_bytes());
    sealed::seal(&keys(), class, &bytes)
        .expect("seals")
        .reference()
}

fn entry(seed: u64, chunks: u32) -> Entry {
    let h = PlaintextHash::of(&seed.to_be_bytes());
    Entry {
        h,
        kind: EntryKind::Original,
        size: u64::from(chunks) * 10,
        media_type: "image/jpeg".to_owned(),
        taken_at_ms: i64::try_from(seed).unwrap_or(0),
        original: (0..chunks)
            .map(|index| chunk_ref(Class::Originals, seed, index))
            .collect(),
        thumbnail: Vec::new(),
    }
}

fn thumb_entry(seed: u64, chunks: u32) -> Entry {
    let h = PlaintextHash::of(&seed.to_be_bytes());
    Entry {
        h,
        kind: EntryKind::Thumbnail,
        size: u64::from(chunks) * 5,
        media_type: "image/jpeg".to_owned(),
        taken_at_ms: i64::try_from(seed).unwrap_or(0),
        original: Vec::new(),
        thumbnail: (0..chunks)
            .map(|index| chunk_ref(Class::Thumbnails, seed, index))
            .collect(),
    }
}

fn excluded_entry(seed: u64, size: u64) -> Entry {
    let h = PlaintextHash::of(&seed.to_be_bytes());
    Entry {
        h,
        kind: EntryKind::ExcludedOriginal,
        size,
        media_type: "video/mp4".to_owned(),
        taken_at_ms: i64::try_from(seed).unwrap_or(0),
        original: Vec::new(),
        thumbnail: Vec::new(),
    }
}

fn sorted(mut entries: Vec<Entry>) -> Vec<Entry> {
    entries.sort_by_key(|entry| entry.h);
    entries
}

fn header() -> Header {
    Header {
        writes: 7,
        user_version: 1,
        page_size: 4096,
        page_count: 16 * 3000,
        taken_at_ms: 1_000,
        census: BTreeMap::from([("core_party".to_owned(), 3_u64)]),
        db_hash: None,
    }
}

fn directory() -> Ref {
    Directory::new(Vec::new())
        .expect("a directory")
        .seal(&keys())
        .expect("seals")
        .reference()
}

fn build(ranges: &[Ref], entries: &[Entry]) -> Assembled {
    tree::assemble(&keys(), header(), ranges, entries, directory()).expect("assembles")
}

fn names(assembled: &Assembled) -> BTreeSet<Name> {
    assembled
        .nodes
        .iter()
        .map(|made| made.sealed.name)
        .collect()
}

struct CountingSource<'a> {
    inner: &'a BTreeMap<Name, Vec<u8>>,
    reads: Cell<usize>,
}

impl<'a> CountingSource<'a> {
    fn new(inner: &'a BTreeMap<Name, Vec<u8>>) -> Self {
        Self {
            inner,
            reads: Cell::new(0),
        }
    }

    fn count(&self) -> usize {
        self.reads.get()
    }
}

impl NodeSource for CountingSource<'_> {
    fn plaintext(&self, name: &Name) -> Result<Option<Vec<u8>>> {
        self.reads.set(self.reads.get() + 1);
        self.inner.plaintext(name)
    }
}

#[test]
fn every_node_decodes_to_what_was_encoded_and_encoding_is_canonical() {
    let ranges: Vec<Ref> = (0..2500).map(range_ref).collect();
    let entries = sorted((0..3000).map(|seed| entry(seed, 2)).collect());
    let assembled = build(&ranges, &entries);
    for made in &assembled.nodes {
        let node = Node::decode(&made.plaintext).expect("decodes");
        assert_eq!(node.encode(), made.plaintext, "the encoding is canonical");
    }
    let source = assembled.source();
    let root = tree::root_of(&source, &assembled.root).expect("a root");
    assert_eq!(
        root.range_leaves.len(),
        3,
        "2500 ranges are 3 leaves of at most {LEAF_RANGES}"
    );
    assert_eq!(tree::ranges_of(&source, &root).expect("ranges"), ranges);
    assert_eq!(
        tree::entries_of(&source, &root.blobs).expect("entries"),
        entries
    );
    assert_eq!(root.range_count(), 16 * 3000 * 4096 / 65_536);
}

#[test]
fn a_leaf_over_the_limit_splits_by_the_next_byte_of_the_hash() {
    let entries = sorted((0..3000).map(|seed| entry(seed, 1)).collect());
    let assembled = build(&[range_ref(0)], &entries);
    let source = assembled.source();
    let root = tree::root_of(&source, &assembled.root).expect("a root");
    let top = tree::Node::decode(&source[&root.blobs.name]).expect("decodes");
    let Node::Blobs(BlobsNode {
        depth,
        body: BlobsBody::Children(children),
        ..
    }) = top
    else {
        panic!("3000 entries do not fit one leaf");
    };
    assert_eq!(depth, 0);
    assert!(children.windows(2).all(|pair| pair[0].0 < pair[1].0));
    for (byte, child) in &children {
        let Node::Blobs(BlobsNode {
            depth,
            prefix,
            body: BlobsBody::Entries(entries),
            ..
        }) = Node::decode(&source[&child.name]).expect("decodes")
        else {
            panic!("a child of 3000 entries is a leaf");
        };
        assert_eq!((depth, prefix.as_slice()), (1, [*byte].as_slice()));
        assert!(entries.len() <= LEAF_ENTRIES);
        assert!(entries.iter().all(|entry| entry.h.as_bytes()[0] == *byte));
    }
}

#[test]
fn one_changed_range_makes_one_chunk_one_leaf_and_one_root() {
    let ranges: Vec<Ref> = (0..3000).map(range_ref).collect();
    let entries = sorted((0..3000).map(|seed| entry(seed, 1)).collect());
    let before = build(&ranges, &entries);
    let mut edited = ranges.clone();
    edited[1500] = range_ref(1_000_000);
    let after = build(&edited, &entries);

    let new_nodes: BTreeSet<Name> = names(&after).difference(&names(&before)).copied().collect();
    let new_chunks = usize::from(edited[1500].name != ranges[1500].name);
    assert_eq!(new_nodes.len(), 2, "one leaf and one root");
    assert_eq!(new_chunks, 1, "and the range's own chunk");
    let source = after.source();
    let all_after = tree::records_of(&source, &after.root).expect("records");
    let all_before = tree::records_of(&before.source(), &before.root).expect("records");
    let new_records: Vec<_> = all_after
        .keys()
        .filter(|name| !all_before.contains_key(name))
        .collect();
    assert_eq!(
        new_records.len(),
        3,
        "exactly 1 chunk, 1 leaf and 1 root are new"
    );
}

#[test]
fn a_new_photo_of_k_chunks_makes_at_most_k_plus_five_objects() {
    let ranges: Vec<Ref> = (0..3000).map(range_ref).collect();
    let entries = sorted((0..3000).map(|seed| entry(seed, 1)).collect());
    let before = build(&ranges, &entries);
    let k = 6;
    let photo = entry(9_999_999, k);
    let mut with_photo = entries.clone();
    with_photo.push(photo.clone());
    let with_photo = sorted(with_photo);
    // The photo is a vault change too: one range moved.
    let mut edited = ranges.clone();
    edited[10] = range_ref(77_777_777);
    let after = build(&edited, &with_photo);

    let mut new_objects: BTreeSet<Name> = BTreeSet::new();
    let (all_before, all_after) = (
        tree::records_of(&before.source(), &before.root).expect("records"),
        tree::records_of(&after.source(), &after.root).expect("records"),
    );
    new_objects.extend(
        all_after
            .keys()
            .filter(|name| !all_before.contains_key(name)),
    );
    let media_before =
        tree::media_of(&before.source(), &before.root, Class::Originals).expect("media");
    let media_after =
        tree::media_of(&after.source(), &after.root, Class::Originals).expect("media");
    new_objects.extend(
        media_after
            .keys()
            .filter(|name| !media_before.contains_key(name)),
    );
    assert!(
        new_objects.len() <= k as usize + 5,
        "{} new objects for a photo of {k} chunks",
        new_objects.len()
    );
    assert!(new_objects.len() > k as usize);
}

#[test]
fn a_node_the_encoder_would_not_write_is_refused() {
    let ranges: Vec<Ref> = (0..3).map(range_ref).collect();
    let leaf = Node::Leaf(RangeLeaf {
        first: 0,
        ranges: ranges.clone(),
    })
    .encode();
    // Trailing bytes.
    let mut trailing = leaf.clone();
    trailing.push(0);
    assert!(Node::decode(&trailing).is_err());
    // Cut short.
    assert!(Node::decode(&leaf[..leaf.len() - 1]).is_err());
    // A ref of the wrong class where a range belongs.
    let wrong = Node::Leaf(RangeLeaf {
        first: 0,
        ranges: vec![chunk_ref(Class::Originals, 1, 0)],
    })
    .encode();
    assert!(Node::decode(&wrong).is_err());
    // Unsorted entries.
    let mut pair = vec![entry(1, 1), entry(2, 1)];
    pair.sort_by_key(|entry| std::cmp::Reverse(entry.h));
    let mut pair_stats = BlobsStats::default();
    for item in &pair {
        pair_stats.add_assign(item.stats());
    }
    let unsorted = Node::Blobs(BlobsNode {
        depth: 0,
        prefix: Vec::new(),
        stats: pair_stats,
        body: BlobsBody::Entries(pair.clone()),
    })
    .encode();
    assert!(Node::decode(&unsorted).is_err());
    assert!(tree::build_blobs(&keys(), &pair, &mut Vec::new()).is_err());
    // Another version.
    let mut other = leaf;
    other[4 + 1 + 4 + 4 - 1] = 5;
    assert!(Node::decode(&other).is_err());
    // A root with a db_hash.
    let assembled = build(&ranges, &[]);
    let mut root = tree::root_of(&assembled.source(), &assembled.root).expect("a root");
    root.db_hash = Some([9; 32]);
    let encoded = Node::Root(Box::new(Root { ..root })).encode();
    assert!(Node::decode(&encoded).is_ok());

    // EntryKind / ref class mismatches must be refused.
    let mut bad_orig = entry(10, 1);
    bad_orig.thumbnail = vec![chunk_ref(Class::Thumbnails, 10, 0)];
    let bad_orig_node = Node::Blobs(BlobsNode {
        depth: 0,
        prefix: Vec::new(),
        stats: bad_orig.stats(),
        body: BlobsBody::Entries(vec![bad_orig]),
    })
    .encode();
    assert!(Node::decode(&bad_orig_node).is_err());

    let mut bad_thumb = thumb_entry(11, 1);
    bad_thumb.original = vec![chunk_ref(Class::Originals, 11, 0)];
    let bad_thumb_node = Node::Blobs(BlobsNode {
        depth: 0,
        prefix: Vec::new(),
        stats: bad_thumb.stats(),
        body: BlobsBody::Entries(vec![bad_thumb]),
    })
    .encode();
    assert!(Node::decode(&bad_thumb_node).is_err());

    let mut bad_excluded = excluded_entry(12, 100);
    bad_excluded.original = vec![chunk_ref(Class::Originals, 12, 0)];
    let bad_excluded_node = Node::Blobs(BlobsNode {
        depth: 0,
        prefix: Vec::new(),
        stats: bad_excluded.stats(),
        body: BlobsBody::Entries(vec![bad_excluded]),
    })
    .encode();
    assert!(Node::decode(&bad_excluded_node).is_err());
}

#[test]
fn a_missing_node_is_a_typed_refusal_not_a_guess() {
    let ranges: Vec<Ref> = (0..3).map(range_ref).collect();
    let assembled = build(&ranges, &[]);
    let mut source = assembled.source();
    let root = tree::root_of(&source, &assembled.root).expect("a root");
    source.remove(&root.range_leaves[0].name);
    assert!(matches!(
        tree::records_of(&source, &assembled.root),
        Err(centraid_vault::backup::PlaneError::NodeMissing(_))
    ));
}

#[test]
fn a_blobs_leaf_with_large_entries_splits_before_hitting_four_mib() {
    // Each entry carries 1200 chunk refs (~87 KiB encoded), so 50 entries (~4.3 MiB)
    // is well under LEAF_ENTRIES (256) but over 3 MiB and over CHUNK_BYTES (4 MiB).
    let shared_ref = chunk_ref(Class::Originals, 1, 0);
    let entries = sorted(
        (0..50_u64)
            .map(|seed| Entry {
                h: PlaintextHash::of(&seed.to_be_bytes()),
                kind: EntryKind::Original,
                size: 1200 * 4 * 1024 * 1024,
                media_type: "video/mp4".to_owned(),
                taken_at_ms: i64::try_from(seed).unwrap_or(0),
                original: vec![shared_ref; 1200],
                thumbnail: Vec::new(),
            })
            .collect(),
    );
    let mut made = Vec::new();
    let root = tree::build_blobs(&keys(), &entries, &mut made).expect("splits before 4 MiB");
    assert!(
        made.iter()
            .all(|node| node.plaintext.len() <= centraid_media::sealed::CHUNK_BYTES),
        "every built node fits inside CHUNK_BYTES"
    );
    let source: BTreeMap<Name, Vec<u8>> = made
        .iter()
        .map(|node| (node.sealed.name, node.plaintext.clone()))
        .collect();
    let top = Node::decode(&source[&root.name]).expect("decodes");
    assert!(
        matches!(
            top,
            Node::Blobs(BlobsNode {
                body: BlobsBody::Children(_),
                ..
            })
        ),
        "top blobs node split into children instead of exceeding 4 MiB"
    );
    assert_eq!(
        tree::entries_of(&source, &root).expect("walks"),
        entries,
        "all entries round-trip through the split tree"
    );
}

#[test]
fn crafted_huge_counts_and_page_size_overflow_are_refused() {
    // 1. Crafted huge range count in a tiny Leaf buffer must fail without OOM.
    let mut tiny_leaf = Vec::new();
    for field in [&[2_u8][..], &[6_u8][..], &0_u64.to_be_bytes()[..]] {
        tiny_leaf.extend_from_slice(&(field.len() as u32).to_be_bytes());
        tiny_leaf.extend_from_slice(field);
    }
    tiny_leaf.extend_from_slice(&1024_u32.to_be_bytes());
    assert!(Node::decode(&tiny_leaf).is_err());

    // 2. Crafted huge u32::MAX count in a tiny Root census must fail without OOM.
    let mut tiny_root = Vec::new();
    for field in [
        &[1_u8][..],
        &[6_u8][..],
        &1_u64.to_be_bytes()[..],    // writes
        &1_u64.to_be_bytes()[..],    // user_version
        &4096_u64.to_be_bytes()[..], // page_size
        &1_u64.to_be_bytes()[..],    // page_count
        &1_u64.to_be_bytes()[..],    // taken_at_ms
    ] {
        tiny_root.extend_from_slice(&(field.len() as u32).to_be_bytes());
        tiny_root.extend_from_slice(field);
    }
    tiny_root.extend_from_slice(&u32::MAX.to_be_bytes());
    assert!(Node::decode(&tiny_root).is_err());

    // 3. page_size * page_count overflow in a valid-looking Root must be refused.
    let assembled = build(&[range_ref(0)], &[]);
    let mut root = tree::root_of(&assembled.source(), &assembled.root).expect("a root");
    root.page_size = u64::MAX;
    root.page_count = 2;
    let encoded = Node::Root(Box::new(root)).encode();
    assert!(Node::decode(&encoded).is_err());
}

#[test]
fn blobs_stats_roll_up_across_splits_and_tampered_leaf_stats_fail_decode() {
    let mut entries = Vec::new();
    let mut expected = BlobsStats::default();
    for seed in 0..600_u64 {
        let e = match seed % 5 {
            0 => entry(seed, 2),
            1 => thumb_entry(seed, 1),
            2 => Entry {
                h: PlaintextHash::of(&seed.to_be_bytes()),
                kind: EntryKind::Original,
                size: 123,
                media_type: "image/jpeg".to_owned(),
                taken_at_ms: 0,
                original: Vec::new(),
                thumbnail: Vec::new(),
            },
            3 => Entry {
                h: PlaintextHash::of(&seed.to_be_bytes()),
                kind: EntryKind::Thumbnail,
                size: 45,
                media_type: "image/jpeg".to_owned(),
                taken_at_ms: 0,
                original: Vec::new(),
                thumbnail: Vec::new(),
            },
            _ => excluded_entry(seed, 777),
        };
        expected.add_assign(e.stats());
        entries.push(e);
    }
    let entries = sorted(entries);
    let assembled = build(&[range_ref(0)], &entries);
    let source = assembled.source();
    let root = tree::root_of(&source, &assembled.root).expect("a root");

    let counting = CountingSource::new(&source);
    let got = tree::stats_of(&counting, &root.blobs).expect("stats_of");
    assert_eq!(got, expected);
    assert_eq!(counting.count(), 1, "stats_of reads only 1 node");

    // Tampered leaf stats fail Node::decode.
    let mut leaf_entry = entry(42, 1);
    leaf_entry.size = 99;
    let mut bad_stats = leaf_entry.stats();
    bad_stats.orig_bytes += 1;
    let encoded = Node::Blobs(BlobsNode {
        depth: 0,
        prefix: Vec::new(),
        stats: bad_stats,
        body: BlobsBody::Entries(vec![leaf_entry]),
    })
    .encode();
    assert!(Node::decode(&encoded).is_err());
}

#[test]
fn negative_taken_at_ms_round_trips_byte_for_byte() {
    let moon = Entry {
        h: PlaintextHash::of(b"apollo-11"),
        kind: EntryKind::Original,
        size: 10,
        media_type: "image/jpeg".to_owned(),
        taken_at_ms: -14_182_940_000,
        original: vec![chunk_ref(Class::Originals, 1969, 0)],
        thumbnail: Vec::new(),
    };
    let node = Node::Blobs(BlobsNode {
        depth: 0,
        prefix: Vec::new(),
        stats: moon.stats(),
        body: BlobsBody::Entries(vec![moon.clone()]),
    });
    let bytes = node.encode();
    let decoded = Node::decode(&bytes).expect("decodes negative timestamp");
    assert_eq!(decoded, node);
    assert_eq!(decoded.encode(), bytes);
    let Node::Blobs(BlobsNode {
        body: BlobsBody::Entries(entries),
        ..
    }) = decoded
    else {
        panic!("expected leaf");
    };
    assert_eq!(entries[0].taken_at_ms, -14_182_940_000);
}

#[test]
fn lookup_entry_reads_at_most_depth_plus_one_nodes() {
    let entries = sorted((0..1000_u64).map(|seed| entry(seed, 1)).collect());
    let assembled = build(&[range_ref(0)], &entries);
    let source = assembled.source();
    let root = tree::root_of(&source, &assembled.root).expect("a root");

    let target = &entries[500];
    let counting = CountingSource::new(&source);
    let found = tree::lookup_entry(&counting, &root.blobs, &target.h).expect("lookup");
    assert_eq!(found.as_ref(), Some(target));
    assert!(
        counting.count() <= 3,
        "1000-entry radix tree lookup took {} node reads",
        counting.count()
    );

    let missing_hash = PlaintextHash::of(b"not-in-tree");
    let counting_miss = CountingSource::new(&source);
    let missed = tree::lookup_entry(&counting_miss, &root.blobs, &missing_hash).expect("miss");
    assert_eq!(missed, None);
    assert!(counting_miss.count() <= 3);
}

#[test]
fn diff_entries_walks_only_changed_path() {
    let before_entries = sorted((0..1000_u64).map(|seed| entry(seed, 1)).collect());
    let before = build(&[range_ref(0)], &before_entries);
    let mut after_entries = before_entries.clone();
    after_entries[500].taken_at_ms += 1;
    let after = build(&[range_ref(0)], &after_entries);

    let mut combined = before.source();
    combined.extend(after.source());
    let before_root = tree::root_of(&combined, &before.root).expect("before root");
    let after_root = tree::root_of(&combined, &after.root).expect("after root");

    let counting = CountingSource::new(&combined);
    let diff = tree::diff_entries(&counting, Some(&before_root.blobs), &after_root.blobs)
        .expect("diff_entries");
    assert_eq!(diff, vec![after_entries[500].clone()]);
    assert!(
        counting.count() <= 6,
        "1 changed entry read {} nodes",
        counting.count()
    );
}

#[test]
fn collect_everything_into_visits_shared_subtrees_once() {
    let before_entries = sorted((0..1000_u64).map(|seed| entry(seed, 1)).collect());
    let before = build(&[range_ref(0)], &before_entries);
    let mut after_entries = before_entries.clone();
    after_entries[500] = entry(999_999, 1);
    let after_entries = sorted(after_entries);
    let after = build(&[range_ref(0)], &after_entries);

    let mut combined = before.source();
    combined.extend(after.source());

    let counting = CountingSource::new(&combined);
    let mut visited = BTreeSet::new();
    let mut keep = BTreeSet::new();
    tree::collect_everything_into(&counting, &before.root, &mut visited, &mut keep).expect("first");
    let reads_first = counting.count();
    tree::collect_everything_into(&counting, &after.root, &mut visited, &mut keep).expect("second");
    let reads_second = counting.count() - reads_first;
    assert!(
        reads_second <= 6,
        "second snapshot read {reads_second} nodes instead of reusing shared subtrees (first={reads_first})"
    );
    assert_eq!(
        keep,
        tree::everything_of(&combined, &before.root)
            .expect("before")
            .union(&tree::everything_of(&combined, &after.root).expect("after"))
            .copied()
            .collect::<BTreeSet<_>>()
    );
}
