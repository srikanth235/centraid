//! The sealed gateway directory (#1191, E8): the member's gateways, written as an ordinary sealed
//! file the head's manifest names, so a restoring phone that reaches one gateway learns the rest.
//!
//! The plaintext is JSON `{"v":1,"gateways":[{gateway_id, addrs, pin, label}]}`, at most
//! [`MAX_GATEWAYS`] entries sorted by `gateway_id`; its name is the sealed-name function of the
//! plaintext's hash, so it is unique to the vault, unguessable, and **immutable**: a change to the
//! set writes a new directory under a new name. It holds addresses, certificate pins and labels,
//! never a token, and no other vault's id.

use serde::{Deserialize, Serialize};

use super::naming::{BackupKeys, Name, PlaintextHash, name};
use super::{Result, invariant};

/// The directory format this build writes and reads.
pub const DIRECTORY_VERSION: u32 = 1;

/// The most gateways one directory lists.
pub const MAX_GATEWAYS: usize = 16;

/// One gateway the vault is backed up to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// The gateway's id, hex.
    pub gateway_id: String,
    pub addrs: Vec<String>,
    /// The pin of its certificate (BLAKE3 of the DER), hex.
    pub pin: String,
    pub label: String,
}

/// The directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directory {
    pub v: u32,
    pub gateways: Vec<Entry>,
}

impl Directory {
    /// A directory of `entries`, sorted and deduplicated by gateway id.
    ///
    /// # Errors
    /// More than [`MAX_GATEWAYS`] gateways.
    pub fn new(mut entries: Vec<Entry>) -> Result<Self> {
        entries.sort_by(|left, right| left.gateway_id.cmp(&right.gateway_id));
        entries.dedup_by(|left, right| left.gateway_id == right.gateway_id);
        if entries.len() > MAX_GATEWAYS {
            return Err(invariant("a directory lists at most 16 gateways"));
        }
        Ok(Self {
            v: DIRECTORY_VERSION,
            gateways: entries,
        })
    }

    /// The plaintext that is sealed.
    ///
    /// # Errors
    /// Never in practice: plain fields always serialise.
    pub fn to_json(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|error| invariant(format!("the directory: {error}")))
    }

    /// The name the directory is stored under.
    ///
    /// # Errors
    /// As [`Directory::to_json`].
    pub fn name(&self, keys: &BackupKeys) -> Result<Name> {
        Ok(name(keys, &PlaintextHash::of(&self.to_json()?), 0))
    }

    /// Read a directory back, refusing a version this build does not read, more gateways than a
    /// directory holds, or entries out of order.
    ///
    /// # Errors
    /// Malformed JSON or one of the above.
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let directory: Self = serde_json::from_slice(bytes)
            .map_err(|error| invariant(format!("the directory is not readable: {error}")))?;
        if directory.v != DIRECTORY_VERSION {
            return Err(invariant(format!(
                "the directory is version {}; this build reads {DIRECTORY_VERSION}",
                directory.v
            )));
        }
        if directory.gateways.len() > MAX_GATEWAYS
            || directory
                .gateways
                .windows(2)
                .any(|pair| pair[0].gateway_id >= pair[1].gateway_id)
        {
            return Err(invariant(
                "the directory is not sorted, one entry a gateway",
            ));
        }
        Ok(directory)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> Entry {
        Entry {
            gateway_id: id.to_owned(),
            addrs: vec![format!("{id}.local:7000")],
            pin: "ab".repeat(32),
            label: id.to_owned(),
        }
    }

    #[test]
    fn a_directory_is_sorted_named_by_its_content_and_reads_back() {
        let keys = BackupKeys::from_root(&[4; 32]);
        let one = Directory::new(vec![entry("bb"), entry("aa")]).expect("builds");
        assert_eq!(one.gateways[0].gateway_id, "aa");
        let again = Directory::new(vec![entry("aa"), entry("bb"), entry("aa")]).expect("builds");
        assert_eq!(one, again, "order and repeats do not matter");
        assert_eq!(one.name(&keys).unwrap(), again.name(&keys).unwrap());
        let other = Directory::new(vec![entry("aa")]).expect("builds");
        assert_ne!(one.name(&keys).unwrap(), other.name(&keys).unwrap());
        assert_eq!(Directory::from_json(&one.to_json().unwrap()).unwrap(), one);
    }

    #[test]
    fn a_directory_this_build_would_not_write_is_refused() {
        let too_many: Vec<Entry> = (0..17).map(|n| entry(&format!("{n:02}"))).collect();
        assert!(Directory::new(too_many).is_err());
        let unsorted = br#"{"v":1,"gateways":[{"gateway_id":"b","addrs":[],"pin":"","label":""},{"gateway_id":"a","addrs":[],"pin":"","label":""}]}"#;
        assert!(Directory::from_json(unsorted).is_err());
        assert!(Directory::from_json(br#"{"v":2,"gateways":[]}"#).is_err());
    }
}
