//! SLIP-0010 hardened derivation: one seed, every key (#1029 §0).
//!
//! ```text
//! seed / account'                 account key            Ed25519
//! seed / vault'(i) / identity'    vault identity key     Ed25519  == vault_id == the address
//! seed / vault'(i) / box'         box key                X25519
//! seed / vault'(i) / root'        vault root key         32 raw bytes
//! ```
//!
//! ## HARDENED ONLY, AND WHY THAT IS NOT A CHOICE
//!
//! SLIP-0010 defines no non-hardened derivation for Ed25519 — there is no
//! public parent to public child step on a twisted Edwards curve the way there
//! is on secp256k1. Every index here is therefore hardened, which is also what
//! the product wants: a contact who holds one vault's identity key must not be
//! able to walk sideways to a sibling vault, or two vaults of one person would
//! be linkable (#1029 §0, F2).
//!
//! ## THE BOX KEY IS ITS OWN LEAF, NEVER A CONVERTED SIGNING KEY
//!
//! The obvious shortcut is to birationally map the Ed25519 identity key to
//! X25519 and call that the box key. It is refused here (Reference B, "Keys and
//! crypto"): one key then both signs and decrypts, so a signing oracle and a
//! decryption oracle share a secret scalar, and rotating one rotates the other.
//! `box'` is a sibling of `identity'` under the same vault node, so the two are
//! independent secrets that a contact can still bind together because both are
//! published under one vault.
//!
//! ## PATH INDICES, AND THE ONE THAT IS RESERVED
//!
//! A vault index is the level-1 index **as written** — vault 3 is `m/3'` — so
//! the number in the account record and the number in the path are the same
//! number and there is no offset to get wrong. The account key takes the top of
//! the hardened space, [`ACCOUNT_INDEX`], which is therefore not a vault index
//! any allocator may hand out; [`VaultMint`] refuses it.

use ed25519_dalek::{SigningKey, VerifyingKey};
use hmac::{Hmac, KeyInit as _, Mac as _};
use sha2::Sha512;

/// SLIP-0010's domain tag for the Ed25519 master node. Changing this string
/// re-derives every key in the product.
const MASTER_KEY_TAG: &[u8] = b"ed25519 seed";

/// SLIP-0010 hardens by setting the top bit of the index.
const HARDENED: u32 = 0x8000_0000;

/// The account key's level-1 index: the last index in the hardened space.
///
/// It sits at the top rather than at 0 so that vault indices can be the plain
/// counting numbers starting at 0 and still never collide with it.
pub const ACCOUNT_INDEX: u32 = 0x7fff_ffff;

/// The largest vault index that is not [`ACCOUNT_INDEX`].
pub const MAX_VAULT_INDEX: u32 = ACCOUNT_INDEX - 1;

/// Level-2 index of a vault's identity key.
const IDENTITY_INDEX: u32 = 0;
/// Level-2 index of a vault's box key.
const BOX_INDEX: u32 = 1;
/// Level-2 index of a vault's root key.
const ROOT_INDEX: u32 = 2;

/// Every derived leaf is 32 bytes wide, whichever key it becomes.
pub const KEY_BYTES: usize = 32;

/// What derivation refuses.
///
/// Both variants are the same product rule seen from two sides: **a vault index
/// is never reused** (#1029 F2). A reused index re-derives the old vault's
/// address, so every contact who linked the old vault would silently address
/// the new one.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DeriveError {
    /// The caller asked for an index this account has already minted, or one
    /// below the mark. Indices need not be dense; they must only go up.
    #[error(
        "vault index {requested} is at or below the high-water mark {high_water}: \
         a reused index re-derives the old vault's address"
    )]
    VaultIndexReused {
        /// The index the caller asked for.
        requested: u32,
        /// The highest index this account has minted.
        high_water: u32,
    },
    /// The caller asked for [`ACCOUNT_INDEX`], which is the account key's own
    /// node and not a vault.
    #[error("vault index {requested} is reserved for the account key")]
    VaultIndexReserved {
        /// The index the caller asked for.
        requested: u32,
    },
}

/// One SLIP-0010 node: the key material and the chain code that derives its
/// children.
#[derive(Clone)]
struct Node {
    key: [u8; KEY_BYTES],
    chain_code: [u8; KEY_BYTES],
}

impl Node {
    /// `I = HMAC-SHA512(key = "ed25519 seed", data = seed)`, split in half.
    fn master(seed: &crate::phrase::Seed) -> Self {
        Self::split(hmac_sha512(MASTER_KEY_TAG, &[seed.as_bytes()]))
    }

    /// SLIP-0010 hardened child:
    /// `I = HMAC-SHA512(key = c_par, data = 0x00 ‖ k_par ‖ ser32(i + 2^31))`.
    fn child(&self, index: u32) -> Self {
        let hardened = (index | HARDENED).to_be_bytes();
        Self::split(hmac_sha512(
            &self.chain_code,
            &[&[0u8], &self.key[..], &hardened[..]],
        ))
    }

    fn split(mac: [u8; 64]) -> Self {
        let mut key = [0u8; KEY_BYTES];
        let mut chain_code = [0u8; KEY_BYTES];
        key.copy_from_slice(&mac[..KEY_BYTES]);
        chain_code.copy_from_slice(&mac[KEY_BYTES..]);
        Self { key, chain_code }
    }
}

fn hmac_sha512(key: &[u8], parts: &[&[u8]]) -> [u8; 64] {
    let mut mac = Hmac::<Sha512>::new_from_slice(key).expect("HMAC accepts a key of any length");
    for part in parts {
        mac.update(part);
    }
    let out = mac.finalize().into_bytes();
    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&out);
    bytes
}

/// The person's account key: what a gateway account is keyed by, and what signs
/// "vault V belongs to account A".
///
/// Contacts never see it (#1029 F2) — it is the one key whose publication would
/// link a person's vaults to each other.
#[derive(Clone)]
pub struct AccountKey(SigningKey);

/// A vault's identity key. Its public half **is** `vault_id` and the address;
/// there is no second id to map (#1029 §0).
#[derive(Clone)]
pub struct VaultIdentityKey(SigningKey);

/// A vault's box key: encryption to this identity, signed by the identity key
/// and published alongside it.
#[derive(Clone)]
pub struct BoxKey(x25519_dalek::StaticSecret);

/// A vault's root key. Wraps the keys of backup objects and never leaves the
/// phone (#1029 §0, §4).
#[derive(Clone)]
pub struct VaultRootKey([u8; KEY_BYTES]);

macro_rules! redacted_debug {
    ($ty:ty, $name:literal) => {
        impl core::fmt::Debug for $ty {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str(concat!($name, "(<redacted>)"))
            }
        }
    };
}

redacted_debug!(AccountKey, "AccountKey");
redacted_debug!(VaultIdentityKey, "VaultIdentityKey");
redacted_debug!(BoxKey, "BoxKey");
redacted_debug!(VaultRootKey, "VaultRootKey");

impl AccountKey {
    /// The public half, which the account's own pkarr record is published
    /// under.
    pub fn public(&self) -> VerifyingKey {
        self.0.verifying_key()
    }

    /// The signing key, for "vault V belongs to account A".
    pub const fn signing(&self) -> &SigningKey {
        &self.0
    }

    /// `seed / account'`.
    pub fn derive(seed: &crate::phrase::Seed) -> Self {
        Self(SigningKey::from_bytes(
            &Node::master(seed).child(ACCOUNT_INDEX).key,
        ))
    }
}

impl VaultIdentityKey {
    /// The public half: the vault id, the address, and the pkarr record's name.
    pub fn public(&self) -> VerifyingKey {
        self.0.verifying_key()
    }

    /// The signing key, for device certificates and published records.
    pub const fn signing(&self) -> &SigningKey {
        &self.0
    }
}

impl BoxKey {
    /// The published half a contact seals to.
    pub fn public(&self) -> x25519_dalek::PublicKey {
        x25519_dalek::PublicKey::from(&self.0)
    }

    /// The secret half, for [`crate::sealed_box`].
    pub const fn secret(&self) -> &x25519_dalek::StaticSecret {
        &self.0
    }
}

impl VaultRootKey {
    /// The 32 bytes, for the backup keyring that wraps object keys under them.
    pub const fn as_bytes(&self) -> &[u8; KEY_BYTES] {
        &self.0
    }
}

/// Every key one vault has.
#[derive(Clone, Debug)]
pub struct VaultKeys {
    /// The level-1 hardened index this vault was minted at.
    pub index: u32,
    /// `seed / vault'(i) / identity'`.
    pub identity: VaultIdentityKey,
    /// `seed / vault'(i) / box'`.
    pub box_key: BoxKey,
    /// `seed / vault'(i) / root'`.
    pub root: VaultRootKey,
}

/// The only way to derive a vault's keys, and the reason it is a type rather
/// than a function: **a vault index is never reused** (#1029 F2).
///
/// The account record keeps the high-water mark, and this carries it. A caller
/// cannot ask for the keys of vault 3 twice, nor drop back to vault 1 after
/// minting vault 4, because the refusal is the constructor's own — not a check
/// a caller has to remember to run. Indices need not be dense: skipping is
/// allowed, going back is not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultMint {
    high_water: Option<u32>,
}

impl VaultMint {
    /// An account that has never minted a vault.
    pub const fn fresh() -> Self {
        Self { high_water: None }
    }

    /// An account resumed from its record, at the mark that record carries.
    pub const fn resumed(high_water: u32) -> Self {
        Self {
            high_water: Some(high_water),
        }
    }

    /// The mark to write back to the account record.
    pub const fn high_water(&self) -> Option<u32> {
        self.high_water
    }

    /// The next index this mint would accept.
    ///
    /// Saturating, so a mark at the top of the space returns
    /// [`ACCOUNT_INDEX`] and [`Self::mint`] refuses it, rather than wrapping
    /// back to a vault index this account has already used.
    pub const fn next_index(&self) -> u32 {
        match self.high_water {
            None => 0,
            Some(mark) => mark.saturating_add(1),
        }
    }

    /// Mint the keys of a vault at a caller-chosen index, advancing the mark.
    pub fn mint(
        &mut self,
        seed: &crate::phrase::Seed,
        index: u32,
    ) -> Result<VaultKeys, DeriveError> {
        if index >= ACCOUNT_INDEX {
            return Err(DeriveError::VaultIndexReserved { requested: index });
        }
        if let Some(high_water) = self.high_water
            && index <= high_water
        {
            return Err(DeriveError::VaultIndexReused {
                requested: index,
                high_water,
            });
        }

        let vault = Node::master(seed).child(index);
        let keys = VaultKeys {
            index,
            identity: VaultIdentityKey(SigningKey::from_bytes(&vault.child(IDENTITY_INDEX).key)),
            box_key: BoxKey(x25519_dalek::StaticSecret::from(vault.child(BOX_INDEX).key)),
            root: VaultRootKey(vault.child(ROOT_INDEX).key),
        };
        self.high_water = Some(index);
        Ok(keys)
    }

    /// Mint the next vault, which is what the "new vault" button does.
    pub fn mint_next(&mut self, seed: &crate::phrase::Seed) -> Result<VaultKeys, DeriveError> {
        self.mint(seed, self.next_index())
    }
}

/// Re-derive one vault's keys from a mark the account record already carries.
///
/// Restore, not creation: the index is known to have been minted, so there is
/// no high-water mark to advance and nothing to refuse. Every new vault goes
/// through [`VaultMint`], which is the only thing that moves the mark.
pub fn restore_vault_keys(
    seed: &crate::phrase::Seed,
    index: u32,
) -> Result<VaultKeys, DeriveError> {
    let mut mint = VaultMint::fresh();
    mint.mint(seed, index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phrase::RecoveryPhrase;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    fn seed() -> crate::phrase::Seed {
        RecoveryPhrase::parse(PHRASE).expect("parses").seed()
    }

    /// SLIP-0010's OWN ed25519 vectors, test vector 1
    /// (<https://github.com/satoshilabs/slips/blob/master/slip-0010.md>).
    ///
    /// The vectors start from a raw seed rather than from a phrase, so they
    /// exercise [`Node`] directly. Without them, every derivation test in this
    /// file would only prove this crate agrees with itself — and the product
    /// promise is that a phrase written on paper re-derives the same addresses
    /// in a SLIP-0010 implementation that is not this one.
    #[test]
    fn the_slip_0010_vectors_are_what_this_build_computes() {
        // The vector's seed is 16 bytes, not the 64 a BIP39 phrase produces, so
        // it goes into the master HMAC directly rather than through
        // `phrase::Seed`.
        let vector_seed = hex::decode("000102030405060708090a0b0c0d0e0f").expect("hex");
        let master = Node::split(hmac_sha512(MASTER_KEY_TAG, &[&vector_seed]));
        assert_eq!(
            hex::encode(master.chain_code),
            "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb"
        );
        assert_eq!(
            hex::encode(master.key),
            "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7"
        );

        let zero = master.child(0);
        assert_eq!(
            hex::encode(zero.chain_code),
            "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69"
        );
        assert_eq!(
            hex::encode(zero.key),
            "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3"
        );

        let nested = zero.child(1).child(2).child(2).child(1_000_000_000);
        assert_eq!(
            hex::encode(nested.chain_code),
            "68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230"
        );
        assert_eq!(
            hex::encode(nested.key),
            "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793"
        );
    }

    #[test]
    fn the_four_keys_of_a_vault_are_four_different_secrets() {
        let seed = seed();
        let account = AccountKey::derive(&seed);
        let keys = VaultMint::fresh().mint(&seed, 0).expect("vault 0");

        let bytes: Vec<[u8; 32]> = vec![
            account.signing().to_bytes(),
            keys.identity.signing().to_bytes(),
            keys.box_key.secret().to_bytes(),
            *keys.root.as_bytes(),
        ];
        for (i, a) in bytes.iter().enumerate() {
            for b in bytes.iter().skip(i + 1) {
                assert_ne!(a, b, "two derivation paths produced one secret");
            }
        }
    }

    #[test]
    fn the_box_key_is_not_the_identity_key_reinterpreted() {
        let keys = VaultMint::fresh().mint(&seed(), 0).expect("vault 0");
        assert_ne!(
            keys.box_key.secret().to_bytes(),
            keys.identity.signing().to_bytes(),
            "the box key must be its own leaf, never a converted signing key"
        );
    }

    #[test]
    fn derivation_is_a_function_of_the_seed_alone() {
        let first = VaultMint::fresh().mint(&seed(), 7).expect("vault 7");
        let second = VaultMint::fresh().mint(&seed(), 7).expect("vault 7 again");
        assert_eq!(
            first.identity.public().to_bytes(),
            second.identity.public().to_bytes()
        );
    }

    #[test]
    fn sibling_vaults_share_no_key_material() {
        let seed = seed();
        let mut mint = VaultMint::fresh();
        let zero = mint.mint(&seed, 0).expect("vault 0");
        let one = mint.mint(&seed, 1).expect("vault 1");
        assert_ne!(
            zero.identity.public().to_bytes(),
            one.identity.public().to_bytes()
        );
        assert_ne!(zero.root.as_bytes(), one.root.as_bytes());
    }

    #[test]
    fn a_vault_index_is_never_reused() {
        let seed = seed();
        let mut mint = VaultMint::fresh();
        mint.mint(&seed, 0).expect("vault 0");
        mint.mint(&seed, 4).expect("indices need not be dense");

        assert_eq!(
            mint.mint(&seed, 4).unwrap_err(),
            DeriveError::VaultIndexReused {
                requested: 4,
                high_water: 4
            }
        );
        assert_eq!(
            mint.mint(&seed, 2).unwrap_err(),
            DeriveError::VaultIndexReused {
                requested: 2,
                high_water: 4
            }
        );
        assert_eq!(mint.high_water(), Some(4));
        assert_eq!(mint.next_index(), 5);
    }

    #[test]
    fn a_refused_index_does_not_move_the_mark() {
        let seed = seed();
        let mut mint = VaultMint::resumed(3);
        assert!(mint.mint(&seed, 3).is_err());
        assert_eq!(mint.high_water(), Some(3));
        assert!(mint.mint(&seed, 4).is_ok());
    }

    #[test]
    fn the_account_index_is_not_a_vault_index() {
        let seed = seed();
        assert_eq!(
            VaultMint::fresh().mint(&seed, ACCOUNT_INDEX).unwrap_err(),
            DeriveError::VaultIndexReserved {
                requested: ACCOUNT_INDEX
            }
        );
        assert!(VaultMint::fresh().mint(&seed, MAX_VAULT_INDEX).is_ok());
    }

    #[test]
    fn restore_re_derives_a_minted_vault_without_a_mark() {
        let seed = seed();
        let minted = VaultMint::resumed(11).mint_next(&seed).expect("vault 12");
        assert_eq!(minted.index, 12);
        let restored = restore_vault_keys(&seed, 12).expect("restore");
        assert_eq!(
            minted.identity.public().to_bytes(),
            restored.identity.public().to_bytes()
        );
        assert_eq!(minted.root.as_bytes(), restored.root.as_bytes());
    }

    #[test]
    fn no_key_prints_itself() {
        let seed = seed();
        let keys = VaultMint::fresh().mint(&seed, 0).expect("vault 0");
        assert_eq!(
            format!("{:?}", AccountKey::derive(&seed)),
            "AccountKey(<redacted>)"
        );
        assert_eq!(
            format!("{:?}", keys.identity),
            "VaultIdentityKey(<redacted>)"
        );
        assert_eq!(format!("{:?}", keys.box_key), "BoxKey(<redacted>)");
        assert_eq!(format!("{:?}", keys.root), "VaultRootKey(<redacted>)");
    }
}
