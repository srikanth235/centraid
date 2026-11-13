//! The phone's read-back: a keyed random sample of what a gateway says it holds, read and
//! opened, so a gateway that lost or damaged a part is found by the next pass and not by a
//! restore (#1188, B4; #1191, E10).
//!
//! **THE DRAW IS KEYED AND COUNTED.** Which parts a pass reads is a function of a key only the
//! phone has (`K_name`), the gateway's id and a per-gateway counter the phone keeps
//! ([`super::state::DeviceState::next_sample_counter`]), never of a clock and never of anything
//! the gateway can see: a gateway cannot tell in advance which parts will be read, so it
//! cannot keep only those. Passes draw [`SAMPLE_CHUNKS`] parts, or [`SAMPLE_CHUNKS_METERED`]
//! on a metered link. A part is a whole sealed range here (one chunk of 64 KiB plus framing);
//! it is opened under its own name, which proves its bytes are the plaintext that name was
//! computed from.
//!
//! A part that is gone, will not open, or opens to other bytes than its name says is
//! [`Sampled::wrong`]; the caller sends it again. The gateway's silence is
//! [`Sampled::unanswered`] and records nothing.

use centraid_media::sealed;

use super::naming::{BackupKeys, Name};
use super::store::{Store, StoreError};

/// How many parts a pass reads back from each gateway.
pub const SAMPLE_CHUNKS: usize = 64;

/// How many on a metered link.
pub const SAMPLE_CHUNKS_METERED: usize = 8;

/// What one gateway's sample found.
#[derive(Debug, Default)]
pub struct Sampled {
    /// Parts read and opened.
    pub checked: usize,
    /// Parts gone, damaged or not the bytes their name says.
    pub wrong: Vec<Name>,
    /// The gateway stopped answering part-way; the parts read before it are counted.
    pub unanswered: Option<StoreError>,
}

/// The `count` positions of `of` the draw `counter` picks for `gateway_id`, distinct and in
/// draw order: a partial Fisher-Yates shuffle driven by BLAKE3's keyed extendable output.
#[must_use]
pub fn draw(keys: &BackupKeys, gateway_id: &str, counter: u64, of: usize, count: usize) -> Vec<usize> {
    let mut hasher = blake3::Hasher::new_keyed(keys.k_name());
    hasher.update(b"centraid-sample-v1");
    hasher.update(gateway_id.as_bytes());
    hasher.update(&counter.to_be_bytes());
    let mut stream = hasher.finalize_xof();
    let mut positions: Vec<usize> = (0..of).collect();
    let take = count.min(of);
    for at in 0..take {
        let mut word = [0_u8; 8];
        stream.fill(&mut word);
        let span = u64::try_from(of - at).unwrap_or(u64::MAX);
        let pick = at + usize::try_from(u64::from_be_bytes(word) % span).unwrap_or(0);
        positions.swap(at, pick);
    }
    positions.truncate(take);
    positions
}

/// Read back `count` of `names` from `store`, drawn by `counter`, and open each under its name.
///
/// # Errors
/// None of its own; a store's silence is in the outcome.
pub fn sample(
    store: &dyn Store,
    keys: &BackupKeys,
    names: &[Name],
    counter: u64,
    count: usize,
) -> Sampled {
    let mut out = Sampled::default();
    for position in draw(keys, store.gateway_id(), counter, names.len(), count) {
        let Some(name) = names.get(position) else {
            continue;
        };
        let mut bytes = Vec::new();
        match store.get(name, &mut bytes) {
            Ok(_) => {
                out.checked += 1;
                if sealed::open_whole(keys, name, &bytes).is_err() {
                    out.wrong.push(*name);
                }
            }
            Err(StoreError::Missing(_) | StoreError::Damaged(_)) => {
                out.checked += 1;
                out.wrong.push(*name);
            }
            Err(error) => {
                out.unanswered = Some(error);
                return out;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::naming::{PlaintextHash, name};
    use crate::backup::store::MemoryStore;

    fn keys() -> BackupKeys {
        BackupKeys::from_root(&[5; 32])
    }

    /// Seal `plaintext` as a whole part and hold it at `store` under its name.
    fn hold(store: &MemoryStore, keys: &BackupKeys, plaintext: &[u8]) -> Name {
        let part = name(keys, &PlaintextHash::of(plaintext), 0);
        let sealed = sealed::seal_part(keys, 0, plaintext, true).expect("seals");
        let digest = crate::backup::naming::Digest::of(&sealed);
        store
            .put(&part, &digest, sealed.len() as u64, &mut sealed.as_slice())
            .expect("holds");
        part
    }

    /// The draw is a pure function of the key, the gateway, the counter and the sizes.
    #[test]
    fn the_draw_is_deterministic_distinct_and_moves_with_the_counter() {
        let keys = keys();
        let one = draw(&keys, "gw", 1, 100, 10);
        assert_eq!(one, draw(&keys, "gw", 1, 100, 10), "same inputs, same draw");
        let mut distinct = one.clone();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(distinct.len(), 10, "no position twice");
        assert_ne!(one, draw(&keys, "gw", 2, 100, 10), "the counter moves the draw");
        assert_ne!(one, draw(&keys, "other", 1, 100, 10), "the gateway moves the draw");
        assert_ne!(
            one,
            draw(&BackupKeys::from_root(&[6; 32]), "gw", 1, 100, 10),
            "the key moves the draw"
        );
        assert_eq!(draw(&keys, "gw", 1, 3, 10).len(), 3, "never more than there are");
    }

    #[test]
    fn a_gone_part_is_wrong_and_a_held_one_opens() {
        let keys = keys();
        let store = MemoryStore::new("gw");
        let held = hold(&store, &keys, b"held bytes");
        let gone = name(&keys, &PlaintextHash::of(b"gone bytes"), 0);
        let found = sample(&store, &keys, &[held, gone], 0, 2);
        assert_eq!(found.checked, 2);
        assert_eq!(found.wrong, vec![gone]);
        assert!(found.unanswered.is_none());
    }

    /// Bytes under a name that opens but is not the plaintext the name was computed from.
    #[test]
    fn bytes_that_open_to_something_else_are_wrong() {
        let keys = keys();
        let store = MemoryStore::new("gw");
        let lie = name(&keys, &PlaintextHash::of(b"what the name says"), 0);
        let sealed = sealed::seal_part(&keys, 0, b"something else", true).expect("seals");
        let digest = crate::backup::naming::Digest::of(&sealed);
        store
            .put(&lie, &digest, sealed.len() as u64, &mut sealed.as_slice())
            .expect("holds");
        assert_eq!(sample(&store, &keys, &[lie], 0, 1).wrong, vec![lie]);
    }
}
