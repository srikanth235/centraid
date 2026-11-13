//! The phone's read-back: a keyed random sample of the sealed chunks a gateway says it holds,
//! read by `Range`, opened and compared with the digest the manifest recorded, so a gateway that
//! lost or damaged a chunk is found by the next pass and not by a restore (#1188, B4; #1191, E10,
//! B13).
//!
//! **THE DRAW IS KEYED AND COUNTED.** The population is the newest head snapshot's chunks in tree
//! order (the ranges, then the blob parts, skipping any part whose digests are not known). Sample
//! `k` of a pass is `blake3::keyed_hash(sample_key, counter ‖ k)` mod the population, where
//! `sample_key` is derived from `K_backup` and `counter` is the gateway row's
//! [`super::state::DeviceState::next_sample_counter`]: never a clock, and nothing the gateway can
//! see, so it cannot keep only the chunks that will be read. A pass reads [`SAMPLE_CHUNKS`]
//! chunks, or [`SAMPLE_CHUNKS_METERED`] of at most [`METERED_CHUNK_MAX`] on a metered link, and
//! stops early at [`SAMPLE_BYTES`] of ciphertext.
//!
//! A chunk that is gone, will not open or opens to other bytes than the manifest recorded is
//! [`Sampled::wrong`] (by its part); the caller deals with the part. The gateway's silence is
//! [`Sampled::unanswered`] and records nothing.

use std::collections::BTreeSet;

use centraid_media::sealed::{self, ChunkDigest};

use super::naming::{BackupKeys, Name};
use super::snapshot::Manifest;
use super::store::{Store, StoreError};

/// How many chunks a pass reads back from each gateway.
pub const SAMPLE_CHUNKS: usize = 64;

/// How many on a metered link.
pub const SAMPLE_CHUNKS_METERED: usize = 8;

/// The ciphertext a pass stops at.
pub const SAMPLE_BYTES: u64 = 64 << 20;

/// The most a chunk may weigh on a metered link.
pub const METERED_CHUNK_MAX: u64 = 1 << 20;

/// What the sample key derives under.
const SAMPLE_CONTEXT: &str = "centraid backup v2 sample";

/// One sealed chunk of one part, as the manifest records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece {
    pub name: Name,
    pub index: u32,
    /// How many chunks the part has.
    pub count: u32,
    pub digest: ChunkDigest,
    /// The most ciphertext the chunk can weigh.
    pub weight: u64,
}

/// Every chunk of the manifest's parts whose digests are known, in tree order.
#[must_use]
pub fn population(manifest: &Manifest) -> Vec<Piece> {
    let overhead = (sealed::CHUNK_FRAME_BYTES + sealed::TAG_BYTES) as u64;
    let mut out = Vec::new();
    let mut push = |name: Name, digests: &[ChunkDigest], plain: u64| {
        let count = u32::try_from(digests.len()).unwrap_or(u32::MAX);
        for (index, digest) in (0_u32..).zip(digests) {
            let payload = if index + 1 < count {
                sealed::CHUNK_BYTES as u64
            } else {
                // A compressed chunk can be a little longer than its plaintext.
                (plain - u64::from(index) * sealed::CHUNK_BYTES as u64) + 64
            };
            out.push(Piece {
                name,
                index,
                count,
                digest: *digest,
                weight: payload.min(sealed::CHUNK_BYTES as u64 + 64) + overhead,
            });
        }
    };
    for range in &manifest.ranges {
        if !range.d.is_empty() {
            push(range.name, &range.d, range.len);
        }
    }
    for blob in &manifest.blobs {
        for part in &blob.parts {
            if let (Some(digests), Ok(plain)) = (&part.d, sealed::part_len(blob.len, part.i))
                && !digests.is_empty()
            {
                push(part.name, digests, plain);
            }
        }
    }
    out
}

/// What one gateway's sample found.
#[derive(Debug, Default)]
pub struct Sampled {
    /// Chunks read and opened.
    pub checked: usize,
    /// Ciphertext bytes read.
    pub bytes: u64,
    /// How many sampled chunks of each wrong part were wrong (a part may be drawn more than once).
    pub wrong_chunks: std::collections::BTreeMap<Name, usize>,
    /// Parts with a chunk gone, damaged or not the bytes the manifest recorded.
    pub wrong: Vec<Name>,
    /// Of those, the ones the gateway itself says are damaged: a signed delete frees them at once
    /// (decision 30).
    pub freeable: Vec<Name>,
    /// The gateway stopped answering part-way; the chunks read before it are counted.
    pub unanswered: Option<StoreError>,
}

/// The key every draw is made under.
fn sample_key(keys: &BackupKeys) -> [u8; 32] {
    blake3::derive_key(SAMPLE_CONTEXT, keys.k_backup())
}

/// Draw `k` of the pass `counter`: a position in a population of `of`.
#[must_use]
pub fn draw_one(keys: &BackupKeys, counter: u64, k: u64, of: usize) -> usize {
    let mut input = [0_u8; 16];
    input[..8].copy_from_slice(&counter.to_be_bytes());
    input[8..].copy_from_slice(&k.to_be_bytes());
    let hash = blake3::keyed_hash(&sample_key(keys), &input);
    let mut word = [0_u8; 8];
    word.copy_from_slice(&hash.as_bytes()[..8]);
    usize::try_from(u64::from_be_bytes(word) % u64::try_from(of.max(1)).unwrap_or(1)).unwrap_or(0)
}

/// Read back up to `count` chunks of `pieces` from `store`, drawn by `counter`, and check each
/// against its digest. `metered` skips a chunk heavier than [`METERED_CHUNK_MAX`].
pub fn sample(
    store: &dyn Store,
    keys: &BackupKeys,
    pieces: &[Piece],
    counter: u64,
    count: usize,
    metered: bool,
) -> Sampled {
    let mut out = Sampled::default();
    if pieces.is_empty() {
        return out;
    }
    let mut drawn: BTreeSet<usize> = BTreeSet::new();
    let mut wrong: BTreeSet<Name> = BTreeSet::new();
    let count_wrong = |out: &mut Sampled, name: Name| {
        *out.wrong_chunks.entry(name).or_insert(0) += 1;
    };
    let attempts = (count as u64)
        .saturating_mul(16)
        .max(pieces.len() as u64)
        .min(count as u64 * 64);
    for k in 0..attempts {
        if out.checked >= count || out.bytes >= SAMPLE_BYTES || drawn.len() >= pieces.len() {
            break;
        }
        let at = draw_one(keys, counter, k, pieces.len());
        if !drawn.insert(at) {
            continue;
        }
        let piece = &pieces[at];
        if metered && piece.weight > METERED_CHUNK_MAX {
            continue;
        }
        match read_piece(store, keys, piece) {
            Ok((read, true)) => {
                out.checked += 1;
                out.bytes += read;
            }
            Ok((read, false)) => {
                out.checked += 1;
                out.bytes += read;
                wrong.insert(piece.name);
                count_wrong(&mut out, piece.name);
            }
            Err(StoreError::Missing(_)) => {
                out.checked += 1;
                wrong.insert(piece.name);
                count_wrong(&mut out, piece.name);
            }
            Err(StoreError::Damaged(_)) => {
                out.checked += 1;
                wrong.insert(piece.name);
                count_wrong(&mut out, piece.name);
                if !out.freeable.contains(&piece.name) {
                    out.freeable.push(piece.name);
                }
            }
            Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::InvalidData => {
                out.checked += 1;
                wrong.insert(piece.name);
                count_wrong(&mut out, piece.name);
            }
            Err(error) => {
                out.unanswered = Some(error);
                break;
            }
        }
    }
    out.wrong = wrong.into_iter().collect();
    out
}

/// Read one chunk and the part's header, open and compare: the ciphertext bytes read, and whether
/// the chunk is the one the manifest recorded.
fn read_piece(
    store: &dyn Store,
    keys: &BackupKeys,
    piece: &Piece,
) -> Result<(u64, bool), StoreError> {
    let mut header = Vec::new();
    store.get_range(
        &piece.name,
        0,
        Some(sealed::HEADER_BYTES as u64),
        &mut header,
    )?;
    let (offset, len) = sealed::chunk_read(piece.index, piece.count);
    let mut frame = Vec::new();
    store.get_range(&piece.name, offset, len, &mut frame)?;
    let read = (header.len() + frame.len()) as u64;
    let Ok(header) = <[u8; sealed::HEADER_BYTES]>::try_from(header.as_slice()) else {
        return Ok((read, false));
    };
    let last = piece.index + 1 == piece.count;
    let right =
        sealed::verify_chunk(keys, &header, piece.index, last, &frame, &piece.digest).is_ok();
    Ok((read, right))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::naming::{PlaintextHash, name};
    use crate::backup::store::MemoryStore;

    fn keys() -> BackupKeys {
        BackupKeys::from_root(&[5; 32])
    }

    /// Seal `plaintext` as a whole part, hold it at `store` under its name, and list its chunk.
    fn hold(store: &MemoryStore, keys: &BackupKeys, plaintext: &[u8]) -> Piece {
        let part = name(keys, &PlaintextHash::of(plaintext), 0);
        let (sealed, digests) = sealed::seal_part_digests(keys, 0, plaintext, true).expect("seals");
        let digest = crate::backup::naming::Digest::of(&sealed);
        store
            .put(&part, &digest, sealed.len() as u64, &mut sealed.as_slice())
            .expect("holds");
        Piece {
            name: part,
            index: 0,
            count: 1,
            digest: digests[0],
            weight: 1 << 16,
        }
    }

    /// The draw is a pure function of the key, the counter, `k` and the size.
    #[test]
    fn the_draw_is_deterministic_and_moves_with_the_counter_and_the_key() {
        let keys = keys();
        let one: Vec<usize> = (0..10).map(|k| draw_one(&keys, 1, k, 1000)).collect();
        assert_eq!(
            one,
            (0..10)
                .map(|k| draw_one(&keys, 1, k, 1000))
                .collect::<Vec<_>>()
        );
        assert_ne!(
            one,
            (0..10)
                .map(|k| draw_one(&keys, 2, k, 1000))
                .collect::<Vec<_>>()
        );
        let other = BackupKeys::from_root(&[6; 32]);
        assert_ne!(
            one,
            (0..10)
                .map(|k| draw_one(&other, 1, k, 1000))
                .collect::<Vec<_>>()
        );
        assert!(one.iter().all(|at| *at < 1000));
    }

    #[test]
    fn a_gone_chunk_is_wrong_and_a_held_one_opens() {
        let keys = keys();
        let store = MemoryStore::new("gw");
        let held = hold(&store, &keys, b"held bytes");
        let mut gone = hold(&MemoryStore::new("elsewhere"), &keys, b"gone bytes");
        gone.name = name(&keys, &PlaintextHash::of(b"gone bytes"), 0);
        let found = sample(&store, &keys, &[held, gone], 0, 2, false);
        assert_eq!(found.checked, 2);
        assert_eq!(found.wrong, vec![gone.name]);
        assert!(found.unanswered.is_none());
    }

    /// Bytes under a name that open but are not the chunk the manifest recorded.
    #[test]
    fn a_chunk_that_opens_to_something_else_is_wrong() {
        let keys = keys();
        let store = MemoryStore::new("gw");
        let mut piece = hold(&store, &keys, b"what the manifest recorded");
        piece.digest = ChunkDigest::of(b"something else");
        assert_eq!(
            sample(&store, &keys, &[piece], 0, 1, false).wrong,
            vec![piece.name]
        );
    }

    /// A metered link reads nothing heavier than a megabyte.
    #[test]
    fn a_metered_link_skips_a_heavy_chunk() {
        let keys = keys();
        let store = MemoryStore::new("gw");
        let mut piece = hold(&store, &keys, b"light");
        piece.weight = 5 << 20;
        let found = sample(&store, &keys, &[piece], 0, 1, true);
        assert_eq!(found.checked, 0);
        assert_eq!(sample(&store, &keys, &[piece], 0, 1, false).checked, 1);
    }
}
