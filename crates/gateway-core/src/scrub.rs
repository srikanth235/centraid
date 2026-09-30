//! Blind scrubbing (#1029 §3).
//!
//! **Without any key**, the gateway re-hashes stored objects on a schedule,
//! reports bit rot, and repairs from a second replica where one exists. It can
//! do this at all only because an object's name is the hash of its own
//! ciphertext: there is nothing to decrypt and nothing to compare against
//! except bytes it already holds.
//!
//! This is the clearest case of the invariant paying for itself. A store that
//! held plaintext hashes could scrub too — and would be holding a confirmable
//! commitment to every member's content in order to do it.
//!
//! The schedule, the batch size and the second replica are the adapter's (R2
//! bucket-lock rules and a second-provider replica on the hosted side; a second
//! S3 bucket on the standalone side). What is here is the verdict.

use crate::ids::ObjectName;

/// What one stored object's bytes turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finding {
    /// The bytes hash to the name they are filed under.
    Intact,
    /// **Bit rot**, or a store that handed back the wrong object. Either way
    /// the object is not what its name says and is a candidate for repair from
    /// a replica.
    Corrupt,
    /// The store has no bytes at this name at all. Distinct from corruption
    /// because the repair differs: a missing object is re-fetched, a corrupt
    /// one is overwritten, and an operator reading a report needs to know which
    /// happened.
    Missing,
}

/// Judge one object's stored bytes against its name.
///
/// `stored` is `None` when the store has nothing at that name.
#[must_use]
pub fn examine(name: ObjectName, stored: Option<&[u8]>) -> Finding {
    match stored {
        None => Finding::Missing,
        Some(bytes) if ObjectName::of(bytes) == name => Finding::Intact,
        Some(_) => Finding::Corrupt,
    }
}

/// One pass's tally.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub read: u64,
    pub corrupt: Vec<ObjectName>,
    pub missing: Vec<ObjectName>,
}

impl Report {
    /// Fold one object's finding in.
    pub fn record(&mut self, name: ObjectName, finding: Finding) {
        self.read += 1;
        match finding {
            Finding::Intact => {}
            Finding::Corrupt => self.corrupt.push(name),
            Finding::Missing => self.missing.push(name),
        }
    }

    /// Did this pass find anything?
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.corrupt.is_empty() && self.missing.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Key32;

    #[test]
    fn a_scrub_needs_no_key_and_catches_a_flipped_bit() {
        let sealed = b"sealed ciphertext nobody here can open".to_vec();
        let name = ObjectName::of(&sealed);
        assert_eq!(examine(name, Some(&sealed)), Finding::Intact);

        let mut rotted = sealed.clone();
        rotted[3] ^= 0b0000_0001;
        assert_eq!(examine(name, Some(&rotted)), Finding::Corrupt);
    }

    /// Missing and corrupt are different findings because the repair differs.
    #[test]
    fn a_missing_object_is_not_reported_as_a_corrupt_one() {
        let name = Key32::from_bytes([9; 32]);
        assert_eq!(examine(name, None), Finding::Missing);

        let mut report = Report::default();
        report.record(name, examine(name, None));
        report.record(
            ObjectName::of(b"good"),
            examine(ObjectName::of(b"good"), Some(b"good")),
        );
        assert_eq!(report.read, 2);
        assert_eq!(report.missing, vec![name]);
        assert!(report.corrupt.is_empty());
        assert!(!report.is_clean());
    }

    #[test]
    fn a_clean_pass_reports_clean() {
        let mut report = Report::default();
        for body in [&b"one"[..], b"two", b"three"] {
            let name = ObjectName::of(body);
            report.record(name, examine(name, Some(body)));
        }
        assert!(report.is_clean());
        assert_eq!(report.read, 3);
    }
}
