//! The tree (manifest v5, spec §3): canonical encoding, the blobs radix tree, and the counts the
//! content addressing promises (#1209, L2). Counts, never durations.

use std::collections::{BTreeMap, BTreeSet};

use centraid_media::sealed::{self, BackupKeys, Class, Name, PlaintextHash, Ref};
use centraid_vault::backup::directory::Directory;
use centraid_vault::backup::tree::{
    self, Assembled, BlobsBody, BlobsNode, Entry, Header, LEAF_ENTRIES, LEAF_RANGES, Node,
    RangeLeaf, Root,
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
        size: u64::from(chunks) * 10,
        media_type: "image/jpeg".to_owned(),
        taken_at_ms: seed,
        original: (0..chunks)
            .map(|index| chunk_ref(Class::Originals, seed, index))
            .collect(),
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
    assert!(new_objects.len() >= k as usize + 1);
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
    let unsorted = Node::Blobs(BlobsNode {
        depth: 0,
        prefix: Vec::new(),
        body: BlobsBody::Entries(pair.clone()),
    })
    .encode();
    assert!(Node::decode(&unsorted).is_err());
    assert!(tree::build_blobs(&keys(), &pair, &mut Vec::new()).is_err());
    // Another version.
    let mut other = leaf;
    other[4 + 1 + 4 + 4 - 1] = 6;
    assert!(Node::decode(&other).is_err());
    // A root with a db_hash that is not 32 bytes.
    let assembled = build(&ranges, &[]);
    let mut root = tree::root_of(&assembled.source(), &assembled.root).expect("a root");
    root.db_hash = Some([9; 32]);
    let encoded = Node::Root(Root { ..root }).encode();
    assert!(Node::decode(&encoded).is_ok());
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
