//! The protocol's identifiers: fixed byte strings spelled as lowercase hex
//! (#1080).
//!
//! # ONE SPELLING
//!
//! Every identifier parses from exactly its length in **lowercase** hex and
//! nothing else. `A` and `a` are the same nibble, and two spellings of one
//! name would be two keys in an index or two paths that a case-folding
//! filesystem lands on one file; refusing uppercase is cheaper than
//! normalising it everywhere it could arrive.
//!
//! # WHAT IS STORED IS NEVER A SECRET
//!
//! A [`Token`] and a [`Secret`] are bearer credentials: whoever holds the bytes
//! holds the authority. The gateway keeps only their BLAKE3 ([`TokenHash`],
//! [`SecretHash`]), so a stolen data directory grants nothing, and their
//! `Debug` prints no byte of them, so a log line cannot either.

use core::fmt;
use core::str::FromStr;

/// An identifier that is not its length in lowercase hex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("not {expected} lowercase hex characters")]
pub struct HexError {
    /// How many characters were expected.
    pub expected: usize,
}

fn decode<const N: usize>(text: &str) -> Result<[u8; N], HexError> {
    let error = HexError { expected: N * 2 };
    let lowercase_hex = text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if text.len() != N * 2 || !lowercase_hex {
        return Err(error);
    }
    let mut out = [0_u8; N];
    hex::decode_to_slice(text, &mut out).map_err(|_| error)?;
    Ok(out)
}

/// A fixed-width identifier, serialised as its lowercase hex.
macro_rules! hex_id {
    ($(#[$meta:meta])* $name:ident, $len:literal, public) => {
        hex_id!(@define $(#[$meta])* $name, $len);

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}({})", stringify!($name), self.hex())
            }
        }
    };
    ($(#[$meta:meta])* $name:ident, $len:literal, secret) => {
        hex_id!(@define $(#[$meta])* $name, $len);

        // A CREDENTIAL'S BYTES NEVER REACH A LOG. Only its kind is printed.
        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}(…)", stringify!($name))
            }
        }
    };
    (@define $(#[$meta:meta])* $name:ident, $len:literal) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; $len]);

        impl $name {
            /// The width in bytes; the hex spelling is twice this.
            pub const LEN: usize = $len;

            /// Wrap raw bytes.
            #[must_use]
            pub const fn from_bytes(bytes: [u8; $len]) -> Self {
                Self(bytes)
            }

            /// The raw bytes.
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }

            /// Wrap a slice of exactly the right width.
            #[must_use]
            pub fn from_slice(bytes: &[u8]) -> Option<Self> {
                <[u8; $len]>::try_from(bytes).ok().map(Self)
            }

            /// The one spelling: lowercase hex.
            #[must_use]
            pub fn hex(&self) -> String {
                hex::encode(self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.hex())
            }
        }

        impl FromStr for $name {
            type Err = HexError;

            fn from_str(text: &str) -> Result<Self, Self::Err> {
                decode::<$len>(text).map(Self)
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.hex())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
                text.parse().map_err(serde::de::Error::custom)
            }
        }
    };
}

hex_id!(
    /// AN OBJECT'S NAME: 32 bytes, 64 lowercase hex characters.
    ///
    /// The phone derives it as a keyed hash of the file's plaintext hash and a
    /// part index, so the gateway sees a name it cannot invert and cannot
    /// compute for a file it knows. The gateway treats it as opaque.
    Name,
    32,
    public
);

hex_id!(
    /// THE TRANSPORT DIGEST: BLAKE3 of the sealed bytes exactly as stored.
    ///
    /// Sent as `Content-Digest: blake3=<hex>`, verified on arrival, stored, and
    /// re-checked by the scrub. It is a hash of ciphertext, so it says nothing
    /// about the plaintext.
    Digest,
    32,
    public
);

hex_id!(
    /// A VAULT'S ID: its Ed25519 identity public key.
    ///
    /// The same key signs a claim, so the id a phone pairs under is the key a
    /// gateway checks a takeover against, with no third value agreed in
    /// advance.
    VaultId,
    32,
    public
);

hex_id!(
    /// THE GATEWAY'S ID: 16 random bytes minted with its certificate.
    ///
    /// Signed into every claim, so a claim made to one gateway cannot be
    /// replayed at another.
    GatewayId,
    16,
    public
);

hex_id!(
    /// THE CERTIFICATE PIN: BLAKE3 of the gateway's end-entity certificate DER.
    ///
    /// Carried by the pairing QR; the phone compares it on first contact and
    /// keeps the certificate's bytes from then on.
    Pin,
    32,
    public
);

hex_id!(
    /// A BEARER TOKEN: 32 random bytes the gateway mints at pairing and
    /// hands over exactly once. It keeps only [`TokenHash`].
    Token,
    32,
    secret
);

hex_id!(
    /// What the gateway keeps of a [`Token`]: its BLAKE3.
    TokenHash,
    32,
    public
);

hex_id!(
    /// A PAIRING SECRET: 16 random bytes `pair` prints into the QR, good for
    /// one vault, once, for 24 hours. The gateway keeps only [`SecretHash`].
    Secret,
    16,
    secret
);

hex_id!(
    /// What the gateway keeps of a [`Secret`]: its BLAKE3.
    SecretHash,
    32,
    public
);

hex_id!(
    /// An Ed25519 signature by a vault's identity key, 128 hex characters.
    Signature,
    64,
    public
);

impl Digest {
    /// The prefix of the `Content-Digest` header's value.
    pub const HEADER_PREFIX: &'static str = "blake3=";

    /// The digest of these bytes.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }

    /// The `Content-Digest` header's value: `blake3=<64 hex>`.
    #[must_use]
    pub fn header(&self) -> String {
        format!("{}{}", Self::HEADER_PREFIX, self.hex())
    }

    /// Read a `Content-Digest` header's value. Exactly `blake3=` and 64
    /// lowercase hex characters: there is one hash, so there is no list of
    /// algorithms to choose from and nothing else is accepted.
    ///
    /// # Errors
    ///
    /// [`HexError`] when the value is not that.
    pub fn from_header(value: &str) -> Result<Self, HexError> {
        value
            .trim()
            .strip_prefix(Self::HEADER_PREFIX)
            .ok_or(HexError { expected: 64 })?
            .parse()
    }

    /// Wrap a finished BLAKE3 hash.
    #[must_use]
    pub fn from_hash(hash: &blake3::Hash) -> Self {
        Self(*hash.as_bytes())
    }
}

impl Pin {
    /// The pin of one end-entity certificate's DER.
    #[must_use]
    pub fn of(certificate_der: &[u8]) -> Self {
        Self(*blake3::hash(certificate_der).as_bytes())
    }
}

impl Token {
    /// The form the gateway stores: BLAKE3 of the token's 32 raw bytes.
    #[must_use]
    pub fn hash(&self) -> TokenHash {
        TokenHash(*blake3::hash(&self.0).as_bytes())
    }
}

impl Secret {
    /// The form the gateway stores: BLAKE3 of the secret's 16 raw bytes.
    #[must_use]
    pub fn hash(&self) -> SecretHash {
        SecretHash(*blake3::hash(&self.0).as_bytes())
    }
}

impl VaultId {
    /// The identity key this id is, or `None` when the bytes are not a point
    /// on the curve. A vault whose id is not a key could never sign a claim,
    /// so it is refused at pairing rather than discovered at restore.
    #[must_use]
    pub fn verifying_key(&self) -> Option<ed25519_dalek::VerifyingKey> {
        ed25519_dalek::VerifyingKey::from_bytes(&self.0).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_round_trips_through_its_one_spelling() {
        let name = Name::from_bytes([0xab; 32]);
        let text = name.to_string();
        assert_eq!(text, "ab".repeat(32));
        assert_eq!(text.parse::<Name>(), Ok(name));
        let json = serde_json::to_string(&name).expect("serialises");
        assert_eq!(json, format!("\"{text}\""));
        assert_eq!(serde_json::from_str::<Name>(&json).expect("parses"), name);
    }

    /// Uppercase, short, long and non-hex are all refused: one spelling.
    #[test]
    fn every_other_spelling_is_refused() {
        for text in [
            "AB".repeat(32),
            "ab".repeat(31),
            "ab".repeat(33),
            format!("{}zz", "ab".repeat(31)),
            String::new(),
        ] {
            assert!(text.parse::<Name>().is_err(), "{text:?} parsed");
        }
        assert!(serde_json::from_str::<Name>("\"ABAB\"").is_err());
    }

    #[test]
    fn a_digest_header_is_blake3_and_nothing_else() {
        let digest = Digest::of(b"sealed bytes");
        let header = digest.header();
        assert!(header.starts_with("blake3="));
        assert_eq!(Digest::from_header(&header), Ok(digest));
        assert_eq!(Digest::from_header(&format!(" {header} ")), Ok(digest));
        assert!(Digest::from_header(&digest.hex()).is_err(), "no prefix");
        assert!(
            Digest::from_header(&format!("blake2b={}", digest.hex())).is_err(),
            "another algorithm under the same hex"
        );
    }

    /// A CREDENTIAL NEVER REACHES A LOG through `Debug`.
    #[test]
    fn a_token_and_a_secret_print_no_byte_of_themselves() {
        let token = Token::from_bytes([0x5a; 32]);
        let secret = Secret::from_bytes([0x5b; 16]);
        let printed = format!("{token:?} {secret:?}");
        assert!(!printed.contains("5a"), "{printed}");
        assert!(!printed.contains("5b"), "{printed}");
        assert_ne!(
            token.hash().hex(),
            token.hex(),
            "the stored form is not the token"
        );
    }

    #[test]
    fn a_vault_id_that_is_not_a_curve_point_has_no_key() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]).verifying_key();
        assert!(
            VaultId::from_bytes(key.to_bytes())
                .verifying_key()
                .is_some()
        );
        // About half of all y-coordinates decompress to no point at all.
        let refused = (0_u8..=255).any(|first| {
            let mut bytes = [0_u8; 32];
            bytes[0] = first;
            VaultId::from_bytes(bytes).verifying_key().is_none()
        });
        assert!(refused, "no 32-byte string was refused as a key");
    }
}
