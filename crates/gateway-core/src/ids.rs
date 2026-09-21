//! The names a blind gateway is allowed to know (#1029 §0, §3, §4).
//!
//! Every one of them is a public key or a hash of ciphertext. There is no
//! plaintext hash here, and no identifier derived from one: deduplication
//! happens on the phone, which is the only party that knows a plaintext hash at
//! all, and the keyed-chunk-id scheme that once leaked within-vault equality is
//! gone with it.

use core::fmt;

use centraid_api_proto::core_v1;

/// A 32-byte value that is either an Ed25519 public key or a 256-bit digest.
///
/// One type for both because a gateway treats them identically: they are opaque
/// names it compares and never interprets. Declaring six newtypes over the same
/// array and six conversions between them would be ceremony without a rule
/// behind it; the distinctions that matter are enforced by which *field* a
/// value sits in.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Key32([u8; 32]);

impl Key32 {
    /// The raw bytes.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Read 32 bytes off the wire. A wrong length is `None` rather than a
    /// truncation: a 31-byte key that silently became a 32-byte one with a zero
    /// on the end would be a different vault.
    #[must_use]
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        <[u8; 32]>::try_from(bytes).ok().map(Self)
    }

    /// The bytes, for the wire.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Lowercase hex, for a path segment and for a log line.
    #[must_use]
    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl fmt::Debug for Key32 {
    /// The first four bytes, and never the whole value.
    ///
    /// A gateway's log is the one place where a vault's address and every
    /// object it holds would otherwise be written down together in the clear —
    /// which is not plaintext, but it is the whole of what the gateway *does*
    /// see, gathered in one file somebody can copy.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}…", hex::encode(&self.0[..4]))
    }
}

/// A vault's identity key: the address, and the `vault_id`. There is no second
/// id to map (§0).
pub type VaultId = Key32;

/// The account key, `seed / account'`. What a gateway account is keyed by.
pub type AccountId = Key32;

/// A phone's transport identity. Nothing dials it: the phone has no inbound
/// endpoint, so this key signs requests and nothing else.
pub type DeviceId = Key32;

/// An object's name: the **BLAKE3-256 of its ciphertext** (§4).
///
/// Encryption uses random nonces, so the name reveals nothing about the
/// content, and write-once follows from content addressing: different bytes
/// cannot land on an existing name.
pub type ObjectName = Key32;

impl ObjectName {
    /// The name the given sealed bytes have.
    ///
    /// This is the rule the `read-and-hash` checksum mode enforces, and the
    /// rule [`crate::scrub`] re-runs on a schedule. It needs no key, which is
    /// what makes blind scrubbing possible at all.
    #[must_use]
    pub fn of(sealed: &[u8]) -> Self {
        Self(*blake3::hash(sealed).as_bytes())
    }
}

/// A generation id: 128 random bits, hex, minted by the phone.
///
/// **Never a counter** (#116), and therefore with no order: that is why a
/// device certificate's epoch is its own monotonic counter and not a generation
/// (F3), and why retention is defined over bases and their receipt times rather
/// than over generations (F10).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Generation(String);

impl Generation {
    /// Accept a generation id off the wire. 32 lowercase hex characters, and a
    /// value that is not that is refused rather than stored: a generation is a
    /// primary-key component in both adapters, and a free-form string there is
    /// a place a client chooses the gateway's keyspace.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let valid = text.len() == 32
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        valid.then(|| Self(text.to_owned()))
    }

    /// The hex form.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What an object is for. A gateway branches on it for retention and the size
/// guard, and for nothing else: it cannot open one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObjectKind {
    /// A 4 MiB page range of a page-identical base snapshot. **The unit of
    /// retention** (F10).
    Base,
    /// A commit-bounded page segment.
    Segment,
    /// A generation's sealed, hash-chained manifest.
    Manifest,
    /// One part of a member's own file.
    Blob,
    /// ~16 MiB of small items with an encrypted item table at its end.
    Pack,
}

impl ObjectKind {
    /// The wire enum.
    #[must_use]
    pub const fn to_proto(self) -> core_v1::ObjectKind {
        match self {
            Self::Base => core_v1::ObjectKind::Base,
            Self::Segment => core_v1::ObjectKind::Segment,
            Self::Manifest => core_v1::ObjectKind::Manifest,
            Self::Blob => core_v1::ObjectKind::Blob,
            Self::Pack => core_v1::ObjectKind::Pack,
        }
    }

    /// From the wire. `UNSPECIFIED`, anything a newer phone invents, and the
    /// struck `SHARE_ENTRY` (6, reserved by the scope amendment of 2026-09-21)
    /// are all `None` — a gateway that guessed a kind would be a gateway
    /// guessing at retention.
    #[must_use]
    pub const fn from_proto(kind: core_v1::ObjectKind) -> Option<Self> {
        match kind {
            core_v1::ObjectKind::Unspecified => None,
            core_v1::ObjectKind::Base => Some(Self::Base),
            core_v1::ObjectKind::Segment => Some(Self::Segment),
            core_v1::ObjectKind::Manifest => Some(Self::Manifest),
            core_v1::ObjectKind::Blob => Some(Self::Blob),
            core_v1::ObjectKind::Pack => Some(Self::Pack),
        }
    }

    /// The column value in `contracts/gateway/schema.sql`. Named here so both
    /// adapters spell it the same way.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Segment => "segment",
            Self::Manifest => "manifest",
            Self::Blob => "blob",
            Self::Pack => "pack",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_the_blake3_of_the_ciphertext_and_needs_no_key() {
        let sealed = b"whatever the phone sealed";
        assert_eq!(ObjectName::of(sealed), ObjectName::of(sealed));
        assert_ne!(ObjectName::of(sealed), ObjectName::of(b"other bytes"));
    }

    /// A debug line must not gather a vault's whole object list in the clear.
    #[test]
    fn a_key_never_prints_itself_whole() {
        let key = Key32::from_bytes([0xAB; 32]);
        assert_eq!(format!("{key:?}"), "abababab…");
        assert_eq!(key.hex().len(), 64, "the full value is still available");
    }

    #[test]
    fn a_generation_that_is_not_32_hex_characters_is_refused() {
        assert!(Generation::parse("0123456789abcdef0123456789abcdef").is_some());
        assert!(Generation::parse("0123456789ABCDEF0123456789ABCDEF").is_none());
        assert!(Generation::parse("../../etc").is_none());
        assert!(Generation::parse("").is_none());
        assert!(Generation::parse("0123456789abcdef0123456789abcde").is_none());
    }

    #[test]
    fn every_kind_survives_the_wire_in_both_directions() {
        for kind in [
            ObjectKind::Base,
            ObjectKind::Segment,
            ObjectKind::Manifest,
            ObjectKind::Blob,
            ObjectKind::Pack,
        ] {
            assert_eq!(ObjectKind::from_proto(kind.to_proto()), Some(kind));
        }
        assert_eq!(
            ObjectKind::from_proto(core_v1::ObjectKind::Unspecified),
            None
        );
    }
}
