//! The heavy read-back: one confirmed part above the everyday sample's cap, read from a
//! gateway and opened, so an original is verified too (#1188).
//!
//! The everyday sample reads three small parts whole into memory
//! ([`super::ledger::SAMPLE_MAX_BYTES`]), which can never reach a photograph's original: a
//! `NAME_TAKEN` answer counts as an acknowledgement, so without this a gateway that lost or
//! damaged an original would be believed forever. Each pass reads back ONE large part per
//! gateway: the one that gateway was **least recently read back for** (never read back first),
//! so over the passes every original comes up. The part is **streamed**: the gateway's bytes go
//! to a temporary file in the spool (a `.partial`, which [`Spool::open`] sweeps if a crash
//! leaves it) and are opened from there chunk by chunk, so no more than one 4 MiB chunk is ever
//! in memory, however large the part.
//!
//! A part that is no longer held, or no longer opens, is **unconfirmed**, so the next pass
//! seals and sends it again, and the outcome says so for the pass to count. The caller owns the
//! member's transfer rule: this reads a whole part over the link, so it is never asked of a
//! metered one.

use std::fs::File;
use std::io::{self, BufReader, Write};

use super::ledger::Ledger;
use centraid_media::sealed;

use super::Result;
use super::naming::{BackupKeys, Name};
use super::spool::{Spool, sealed_bound};
use super::store::{Store, StoreError};

/// What one heavy read-back found.
#[derive(Debug)]
pub enum ReadBack {
    /// The gateway holds no confirmed part above the cap.
    Nothing,
    /// The part was read back and opened.
    Held(Name),
    /// The part is gone or damaged at the gateway: it is unconfirmed, to be sent again.
    Wrong(Name),
    /// The gateway did not answer the read; nothing was recorded.
    Unanswered(StoreError),
}

/// A sink that stops taking bytes past what any part may seal to.
struct Bounded {
    file: File,
    left: u64,
    /// The gateway sent more than any part can seal to.
    overflowed: bool,
}

impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.left {
            self.overflowed = true;
            return Err(io::Error::other("a part larger than any part can seal to"));
        }
        self.left -= bytes.len() as u64;
        self.file.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// Removes the temporary file however the read ends.
struct Temp(std::path::PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Read back the confirmed part above the cap that `store` was least recently read back for.
///
/// # Errors
/// The ledger's or the filesystem's refusal; the gateway's silence is [`ReadBack::Unanswered`].
pub fn read_back_large(
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
    keys: &BackupKeys,
    now_ms: u64,
) -> Result<ReadBack> {
    let gateway = store.gateway_id();
    let Some((name, _size)) = ledger.oldest_verified_large(gateway)? else {
        return Ok(ReadBack::Nothing);
    };
    let temp = Temp(spool.temp_path("verify", 0));
    let mut sink = Bounded {
        file: File::create(&temp.0)?,
        left: sealed_bound(sealed::PART_BYTES),
        overflowed: false,
    };
    match store.get(&name, &mut sink) {
        Ok(_) => {}
        Err(StoreError::Missing(_) | StoreError::Damaged(_)) => {
            ledger.unconfirm(&name, gateway)?;
            return Ok(ReadBack::Wrong(name));
        }
        // MORE BYTES THAN ANY PART SEALS TO is a copy that is not ours, however it arrived.
        Err(_) if sink.overflowed => {
            ledger.unconfirm(&name, gateway)?;
            return Ok(ReadBack::Wrong(name));
        }
        Err(error) => return Ok(ReadBack::Unanswered(error)),
    }
    sink.file.sync_all()?;
    drop(sink);
    let opened = sealed::open_part_to(keys, BufReader::new(File::open(&temp.0)?), &mut io::sink());
    if opened.is_err() {
        ledger.unconfirm(&name, gateway)?;
        return Ok(ReadBack::Wrong(name));
    }
    ledger.mark_verified(&name, gateway, now_ms)?;
    Ok(ReadBack::Held(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::ledger::Destination;
    use crate::backup::naming::{Digest, PlaintextHash, name};
    use crate::backup::store::MemoryStore;

    struct Rig {
        _dir: tempfile::TempDir,
        ledger: Ledger,
        spool: Spool,
        store: MemoryStore,
        keys: BackupKeys,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("v.backup.db")).expect("a ledger");
        ledger
            .put_destination(&Destination {
                gateway_id: "gw".to_owned(),
                addrs: Vec::new(),
                cert_der: Vec::new(),
                token: "t".to_owned(),
                epoch: 1,
                label: "laptop".to_owned(),
                paired_at_ms: 0,
                last_seen_ms: None,
                last_ack_ms: None,
            })
            .expect("pairs");
        Rig {
            spool: Spool::open(dir.path().join("v.spool")).expect("a spool"),
            _dir: dir,
            ledger,
            store: MemoryStore::new("gw"),
            keys: BackupKeys::from_root(&[5; 32]),
        }
    }

    /// `len` bytes that do not compress, so the sealed part is above the sample's cap.
    fn noise(seed: u8, len: usize) -> Vec<u8> {
        let mut bytes = vec![0_u8; len];
        blake3::Hasher::new()
            .update(&[seed])
            .finalize_xof()
            .fill(&mut bytes);
        bytes
    }

    /// Seal part `index` of the file hashed `h` over `plaintext`, hold it at the gateway and
    /// confirm it in the ledger. Answers its name.
    fn hold(rig: &Rig, h: &PlaintextHash, index: u32, plaintext: &[u8]) -> Name {
        let sealed = sealed::seal_part(&rig.keys, index, plaintext, false).expect("seals");
        let part = name(&rig.keys, h, index);
        rig.store
            .put(
                &part,
                &Digest::of(&sealed),
                sealed.len() as u64,
                &mut &sealed[..],
            )
            .expect("held");
        rig.ledger
            .confirm(&part, "gw", 1, sealed.len() as u64)
            .expect("confirms");
        part
    }

    fn read(rig: &Rig, now_ms: u64) -> ReadBack {
        read_back_large(&rig.ledger, &rig.spool, &rig.store, &rig.keys, now_ms).expect("reads back")
    }

    #[test]
    fn nothing_above_the_cap_is_nothing_to_read_back() {
        let rig = rig();
        hold(&rig, &PlaintextHash::of(b"small"), 0, &noise(1, 4_096));
        assert!(matches!(read(&rig, 10), ReadBack::Nothing));
    }

    /// **A MULTI-PART ORIGINAL IS COVERED PART BY PART, LEAST RECENTLY VERIFIED FIRST:** three
    /// passes read three different parts, and the fourth comes back to the first.
    #[test]
    fn every_part_of_a_multi_part_original_comes_up_in_turn() {
        let rig = rig();
        let h = PlaintextHash::of(b"a long film");
        let parts: Vec<Name> = (0..3)
            .map(|index| hold(&rig, &h, index, &noise(index as u8, 1_500_000)))
            .collect();
        let mut seen = Vec::new();
        for pass in 0..3_u64 {
            match read(&rig, 100 + pass) {
                ReadBack::Held(name) => seen.push(name),
                other => panic!("pass {pass}: {other:?}"),
            }
        }
        let mut sorted = seen.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 3, "three passes, three different parts");
        assert!(parts.iter().all(|part| seen.contains(part)));
        match read(&rig, 200) {
            ReadBack::Held(name) => assert_eq!(name, seen[0], "back to the least recent"),
            other => panic!("{other:?}"),
        }
        assert!(
            rig.spool.dir().read_dir().expect("lists").next().is_none(),
            "no temp file left"
        );
    }

    /// A part the gateway lost, or whose bytes no longer open, is unconfirmed so it is sent
    /// again.
    #[test]
    fn a_lost_or_damaged_part_is_unconfirmed() {
        let rig = rig();
        let lost = hold(&rig, &PlaintextHash::of(b"lost"), 0, &noise(1, 1_200_000));
        rig.store.set_clock_ms(1_000);
        rig.store.delete(&[lost]).expect("the gateway deleted it");
        rig.store
            .set_clock_ms(1_000 + crate::backup::store::TOMBSTONE_GRACE_MS);
        rig.store.purge();
        match read(&rig, 10) {
            ReadBack::Wrong(name) => assert_eq!(name, lost),
            other => panic!("{other:?}"),
        }
        assert!(!rig.ledger.is_confirmed(&lost, "gw").expect("asks"));

        let h = PlaintextHash::of(b"damaged");
        let mut sealed =
            sealed::seal_part(&rig.keys, 0, &noise(2, 1_200_000), false).expect("seals");
        let middle = sealed.len() / 2;
        sealed[middle] ^= 0xff;
        let damaged = name(&rig.keys, &h, 0);
        rig.store
            .put(
                &damaged,
                &Digest::of(&sealed),
                sealed.len() as u64,
                &mut &sealed[..],
            )
            .expect("held");
        rig.ledger
            .confirm(&damaged, "gw", 1, sealed.len() as u64)
            .expect("confirms");
        match read(&rig, 11) {
            ReadBack::Wrong(name) => assert_eq!(name, damaged),
            other => panic!("{other:?}"),
        }
        assert!(!rig.ledger.is_confirmed(&damaged, "gw").expect("asks"));
        assert!(matches!(read(&rig, 12), ReadBack::Nothing));
    }
}
