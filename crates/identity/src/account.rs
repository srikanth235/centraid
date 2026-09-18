//! "VAULT V BELONGS TO ACCOUNT A", AND THE LISTING OVER THE SET (#1029 §0, F2).
//!
//! A restore has the seed, so it has every key. What it does not have is the
//! **set of indices that were ever minted**: derivation is a function, and a
//! function cannot be run backwards to enumerate its inputs. Something has to
//! remember "this account has vaults 0, 1 and 4".
//!
//! ## WHY NOT GAP-LIMIT DISCOVERY, AND WHY NOT THE OLD PHONE
//!
//! The wallet answer is a gap limit: derive vault 0, 1, 2… until N in a row
//! resolve to nothing. It is rejected here (#1029 F2). It depends on every
//! vault having a *published record still standing*, which means it depends on
//! the lost phone having republished recently — and the lost phone is the thing
//! that is lost. It also silently truncates: a person with vaults 0 and 9 loses
//! vault 9 to a gap limit of 5, with no error anywhere, and a vault that
//! quietly does not come back is worse than a restore that fails.
//!
//! The answer is this module. The account key signs one claim per vault, the
//! claims are gathered into a listing the account key signs as a document, and
//! the listing is held by the gateway the account's own pkarr record names. A
//! fresh phone needs the phrase and nothing else: derive the account key,
//! resolve or type the gateway, fetch the listing, re-derive every vault it
//! names.
//!
//! ## THE LISTING IS NOT IN DNS, AND THAT IS THE POINT (F9)
//!
//! The obvious shortcut is to put the vault list in the account's pkarr record.
//! It is refused: a pkarr record is world-readable by anyone holding the key it
//! is published under, so that record would publish the set of a person's vault
//! addresses *as one linked group* — precisely what hardened, sibling-blind
//! derivation exists to prevent (#1029 §0, F2). DNS learns where the account
//! is. The gateway, which already holds the mailboxes, learns which vaults are
//! under it. Nobody else learns either.
//!
//! ## THE CLAIM AND THE DOCUMENT ARE BOTH SIGNED, AND BOTH ARE NEEDED
//!
//! Each claim is signed on its own, so one vault's membership can be shown to a
//! gateway without handing over the rest of the list. The listing is signed
//! over the whole set, so a gateway cannot serve a restore a *subset* — drop
//! one claim from a set of signed claims and every remaining signature still
//! verifies, and the vault that was dropped is gone with no error. The
//! document's own signature is what makes that omission detectable.

use ed25519_dalek::{Signature, Signer as _, Verifier as _, VerifyingKey};

use crate::derive::{ACCOUNT_INDEX, AccountKey, DeriveError, VaultKeys, VaultMint};
use crate::phrase::Seed;

/// Domain separation for one claim.
pub const VAULT_CLAIM_CONTEXT: &[u8] = b"centraid-vault-claim-v1";

/// Domain separation for the listing document. Different from
/// [`VAULT_CLAIM_CONTEXT`] so a claim's signature can never be replayed as a
/// one-entry listing's, or the reverse.
pub const VAULT_LISTING_CONTEXT: &[u8] = b"centraid-vault-listing-v1";

/// `account(32) ‖ vault(32) ‖ index(4) ‖ signature(64)`.
pub const VAULT_CLAIM_BYTES: usize = 32 + 32 + 4 + 64;

/// What the account layer refuses.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AccountError {
    /// The listing document's signature does not verify under the account key
    /// it names. This is the refusal that catches a listing signed by somebody
    /// else's account key.
    #[error("the listing naming account {account} is not signed by it")]
    ListingNotSigned {
        /// The account key the listing names, hex.
        account: String,
    },
    /// One claim's signature does not verify.
    #[error("the claim that vault {vault} belongs to account {account} is not signed by it")]
    ClaimNotSigned {
        /// The account key, hex.
        account: String,
        /// The vault identity key, hex.
        vault: String,
    },
    /// A claim in the listing names a different account than the listing does.
    #[error("a listing for account {account} carries a claim by account {claimed}")]
    ForeignClaim {
        /// The account the listing names, hex.
        account: String,
        /// The account the claim names, hex.
        claimed: String,
    },
    /// The claims are not in ascending index order, or an index repeats. A
    /// repeated index would mean two vaults on one derivation path (F2).
    #[error("the listing for account {account} is not in canonical order: {reason}")]
    NotCanonical {
        /// The account key, hex.
        account: String,
        /// What was wrong.
        reason: &'static str,
    },
    /// A claim names an index that is not a vault index.
    #[error("index {index} is reserved for the account key and is not a vault")]
    ReservedIndex {
        /// The index the claim named.
        index: u32,
    },
    /// Re-deriving the claimed index from this seed produced a different vault
    /// identity key: the listing belongs to another phrase.
    #[error(
        "vault index {index} of this seed derives {derived}, but the listing claims {claimed}: \
         this listing belongs to another recovery phrase"
    )]
    ClaimDoesNotDerive {
        /// The index that was re-derived.
        index: u32,
        /// What this seed produced, hex.
        derived: String,
        /// What the listing claimed, hex.
        claimed: String,
    },
    /// The bytes are not a claim or a listing.
    #[error("not a vault listing: {reason}")]
    Malformed {
        /// What was wrong with the bytes.
        reason: &'static str,
    },
}

/// "Vault `vault`, minted at index `index`, belongs to account `account`",
/// signed by `account`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultClaim {
    account: VerifyingKey,
    vault: VerifyingKey,
    index: u32,
    signature: Signature,
}

impl VaultClaim {
    /// Sign one. The index is in the claim because a restore needs the
    /// derivation path, not just the address.
    pub fn issue(account: &AccountKey, vault: &VerifyingKey, index: u32) -> Self {
        let signing = account.signing();
        let public = signing.verifying_key();
        Self {
            account: public,
            vault: *vault,
            index,
            signature: signing.sign(&claim_bytes(&public, vault, index)),
        }
    }

    /// The account this vault belongs to.
    pub const fn account(&self) -> &VerifyingKey {
        &self.account
    }

    /// The vault's identity key — its address and its `vault_id`.
    pub const fn vault(&self) -> &VerifyingKey {
        &self.vault
    }

    /// The level-1 hardened index the vault was minted at.
    pub const fn index(&self) -> u32 {
        self.index
    }

    /// Check the signature under the account key the claim names.
    pub fn verify(&self) -> Result<(), AccountError> {
        if self.index >= ACCOUNT_INDEX {
            return Err(AccountError::ReservedIndex { index: self.index });
        }
        self.account
            .verify(
                &claim_bytes(&self.account, &self.vault, self.index),
                &self.signature,
            )
            .map_err(|_| AccountError::ClaimNotSigned {
                account: hex::encode(self.account.to_bytes()),
                vault: hex::encode(self.vault.to_bytes()),
            })
    }

    /// The fixed-width wire form.
    pub fn to_bytes(&self) -> [u8; VAULT_CLAIM_BYTES] {
        let mut out = [0u8; VAULT_CLAIM_BYTES];
        out[..32].copy_from_slice(self.account.as_bytes());
        out[32..64].copy_from_slice(self.vault.as_bytes());
        out[64..68].copy_from_slice(&self.index.to_be_bytes());
        out[68..].copy_from_slice(&self.signature.to_bytes());
        out
    }

    /// Read one back. The signature is **not** checked here; [`Self::verify`]
    /// is.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, AccountError> {
        if bytes.len() != VAULT_CLAIM_BYTES {
            return Err(AccountError::Malformed {
                reason: "wrong length for a vault claim",
            });
        }
        let key = |range: core::ops::Range<usize>| {
            let mut raw = [0u8; 32];
            raw.copy_from_slice(&bytes[range]);
            VerifyingKey::from_bytes(&raw).map_err(|_| AccountError::Malformed {
                reason: "not a valid Ed25519 public key",
            })
        };
        let mut index = [0u8; 4];
        index.copy_from_slice(&bytes[64..68]);
        let mut signature = [0u8; 64];
        signature.copy_from_slice(&bytes[68..]);
        Ok(Self {
            account: key(0..32)?,
            vault: key(32..64)?,
            index: u32::from_be_bytes(index),
            signature: Signature::from_bytes(&signature),
        })
    }
}

/// Every vault under one account, as a document the account key signed.
///
/// Canonical: claims ascend by index and no index repeats, so one account has
/// exactly one byte form of its listing and two gateways cannot serve two
/// equally valid orderings of the same set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultListing {
    account: VerifyingKey,
    claims: Vec<VaultClaim>,
    signature: Signature,
}

impl VaultListing {
    /// Sign the listing over a set of claims.
    ///
    /// The claims are sorted here, so a caller cannot produce a non-canonical
    /// listing by accident; a repeated index is still a refusal, because it is
    /// not an ordering mistake but two vaults on one derivation path (F2).
    pub fn sign(account: &AccountKey, claims: &[VaultClaim]) -> Result<Self, AccountError> {
        let public = account.public();
        let mut claims = claims.to_vec();
        claims.sort_by_key(VaultClaim::index);
        check_canonical(&public, &claims)?;
        for claim in &claims {
            if claim.account != public {
                return Err(AccountError::ForeignClaim {
                    account: hex::encode(public.to_bytes()),
                    claimed: hex::encode(claim.account.to_bytes()),
                });
            }
            claim.verify()?;
        }
        let signature = account.signing().sign(&listing_bytes(&public, &claims));
        Ok(Self {
            account: public,
            claims,
            signature,
        })
    }

    /// The account this listing belongs to.
    pub const fn account(&self) -> &VerifyingKey {
        &self.account
    }

    /// The claims, in ascending index order.
    pub fn vaults(&self) -> &[VaultClaim] {
        &self.claims
    }

    /// The highest index this account has minted, for
    /// [`VaultMint::resumed`] — `None` when the account has no vaults yet.
    pub fn high_water(&self) -> Option<u32> {
        self.claims.last().map(VaultClaim::index)
    }

    /// The mint a restored phone carries on, so the next vault it creates
    /// cannot land on an index this account has already used (F2).
    pub fn resume_mint(&self) -> VaultMint {
        self.high_water()
            .map_or_else(VaultMint::fresh, VaultMint::resumed)
    }

    /// Check the document signature, then every claim in it.
    ///
    /// The document first: a listing signed by another key is refused before
    /// any of its contents are believed.
    pub fn verify(&self) -> Result<(), AccountError> {
        self.account
            .verify(&listing_bytes(&self.account, &self.claims), &self.signature)
            .map_err(|_| AccountError::ListingNotSigned {
                account: hex::encode(self.account.to_bytes()),
            })?;
        check_canonical(&self.account, &self.claims)?;
        for claim in &self.claims {
            if claim.account != self.account {
                return Err(AccountError::ForeignClaim {
                    account: hex::encode(self.account.to_bytes()),
                    claimed: hex::encode(claim.account.to_bytes()),
                });
            }
            claim.verify()?;
        }
        Ok(())
    }

    /// **THE RESTORE (F2).** Re-derive every vault this listing names, from the
    /// phrase alone.
    ///
    /// Verifies first, then checks each re-derived identity key against the
    /// claim — so a listing fetched from a gateway that belongs to a different
    /// phrase fails loudly instead of returning keys for vaults that are not
    /// this person's.
    pub fn restore(&self, seed: &Seed) -> Result<Vec<VaultKeys>, AccountError> {
        self.verify()?;
        self.claims
            .iter()
            .map(|claim| {
                let keys =
                    crate::derive::restore_vault_keys(seed, claim.index).map_err(|error| {
                        match error {
                            DeriveError::VaultIndexReserved { requested }
                            | DeriveError::VaultIndexReused {
                                requested,
                                high_water: _,
                            } => AccountError::ReservedIndex { index: requested },
                        }
                    })?;
                let derived = keys.identity.public();
                if derived != claim.vault {
                    return Err(AccountError::ClaimDoesNotDerive {
                        index: claim.index,
                        derived: hex::encode(derived.to_bytes()),
                        claimed: hex::encode(claim.vault.to_bytes()),
                    });
                }
                Ok(keys)
            })
            .collect()
    }

    /// `account(32) ‖ count(4) ‖ count × claim ‖ signature(64)`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(32 + 4 + self.claims.len() * VAULT_CLAIM_BYTES + 64);
        out.extend_from_slice(self.account.as_bytes());
        out.extend_from_slice(&(self.claims.len() as u32).to_be_bytes());
        for claim in &self.claims {
            out.extend_from_slice(&claim.to_bytes());
        }
        out.extend_from_slice(&self.signature.to_bytes());
        out
    }

    /// Read one back. Nothing is verified here; [`Self::verify`] is.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, AccountError> {
        if bytes.len() < 36 + 64 {
            return Err(AccountError::Malformed {
                reason: "too short for a vault listing",
            });
        }
        let mut account = [0u8; 32];
        account.copy_from_slice(&bytes[..32]);
        let account = VerifyingKey::from_bytes(&account).map_err(|_| AccountError::Malformed {
            reason: "not a valid Ed25519 public key",
        })?;

        let mut count = [0u8; 4];
        count.copy_from_slice(&bytes[32..36]);
        let count = u32::from_be_bytes(count) as usize;
        let expected =
            36usize
                .checked_add(count.checked_mul(VAULT_CLAIM_BYTES).ok_or(
                    AccountError::Malformed {
                        reason: "claim count overflows",
                    },
                )?)
                .and_then(|length| length.checked_add(64))
                .ok_or(AccountError::Malformed {
                    reason: "claim count overflows",
                })?;
        if bytes.len() != expected {
            return Err(AccountError::Malformed {
                reason: "the claim count does not match the length",
            });
        }

        let claims = (0..count)
            .map(|position| {
                let start = 36 + position * VAULT_CLAIM_BYTES;
                VaultClaim::from_bytes(&bytes[start..start + VAULT_CLAIM_BYTES])
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut signature = [0u8; 64];
        signature.copy_from_slice(&bytes[expected - 64..]);
        Ok(Self {
            account,
            claims,
            signature: Signature::from_bytes(&signature),
        })
    }
}

fn check_canonical(account: &VerifyingKey, claims: &[VaultClaim]) -> Result<(), AccountError> {
    for pair in claims.windows(2) {
        if pair[0].index == pair[1].index {
            return Err(AccountError::NotCanonical {
                account: hex::encode(account.to_bytes()),
                reason: "two claims share one vault index",
            });
        }
        if pair[0].index > pair[1].index {
            return Err(AccountError::NotCanonical {
                account: hex::encode(account.to_bytes()),
                reason: "claims are not in ascending index order",
            });
        }
    }
    Ok(())
}

/// The bytes one claim signs. The account key is inside them, so a genuine
/// claim cannot be re-attributed by swapping the key beside it.
fn claim_bytes(account: &VerifyingKey, vault: &VerifyingKey, index: u32) -> Vec<u8> {
    let mut message = Vec::with_capacity(VAULT_CLAIM_CONTEXT.len() + 1 + 32 + 32 + 4);
    message.extend_from_slice(VAULT_CLAIM_CONTEXT);
    message.push(0);
    message.extend_from_slice(account.as_bytes());
    message.extend_from_slice(vault.as_bytes());
    message.extend_from_slice(&index.to_be_bytes());
    message
}

/// The bytes the document signs: the account, the count, and **each claim's own
/// signature**. Signing over the signatures is what makes a dropped claim
/// detectable — the remaining ones still verify individually, and this does
/// not.
fn listing_bytes(account: &VerifyingKey, claims: &[VaultClaim]) -> Vec<u8> {
    let mut message = Vec::with_capacity(
        VAULT_LISTING_CONTEXT.len() + 1 + 32 + 4 + claims.len() * VAULT_CLAIM_BYTES,
    );
    message.extend_from_slice(VAULT_LISTING_CONTEXT);
    message.push(0);
    message.extend_from_slice(account.as_bytes());
    message.extend_from_slice(&(claims.len() as u32).to_be_bytes());
    for claim in claims {
        message.extend_from_slice(&claim.to_bytes());
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phrase::RecoveryPhrase;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    const OTHER_PHRASE: &str = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo \
         zoo zoo zoo zoo zoo zoo zoo zoo vote";

    fn seed(phrase: &str) -> Seed {
        RecoveryPhrase::parse(phrase).expect("parses").seed()
    }

    /// An account with vaults at 0, 1 and 4 — sparse, because indices need not
    /// be dense and a gap limit is exactly what this listing replaces.
    fn account_with_vaults(phrase: &str) -> (Seed, AccountKey, VaultListing) {
        let seed = seed(phrase);
        let account = AccountKey::derive(&seed);
        let mut mint = VaultMint::fresh();
        let claims: Vec<VaultClaim> = [0u32, 1, 4]
            .iter()
            .map(|index| {
                let keys = mint.mint(&seed, *index).expect("a fresh index");
                VaultClaim::issue(&account, &keys.identity.public(), *index)
            })
            .collect();
        let listing = VaultListing::sign(&account, &claims).expect("signs");
        (seed, account, listing)
    }

    #[test]
    fn a_listing_signed_by_its_account_verifies() {
        let (_, account, listing) = account_with_vaults(PHRASE);
        listing.verify().expect("verifies");
        assert_eq!(listing.account(), &account.public());
        assert_eq!(
            listing
                .vaults()
                .iter()
                .map(VaultClaim::index)
                .collect::<Vec<_>>(),
            vec![0, 1, 4]
        );
    }

    #[test]
    fn a_listing_signed_by_another_account_is_refused() {
        let (_, _, mine) = account_with_vaults(PHRASE);
        let other = AccountKey::derive(&seed(OTHER_PHRASE));

        // The other account signs a document over MY claims: the claims still
        // verify on their own, and the listing names the wrong account.
        let forged = VaultListing::sign(&other, mine.vaults());
        assert_eq!(
            forged,
            Err(AccountError::ForeignClaim {
                account: hex::encode(other.public().to_bytes()),
                claimed: hex::encode(mine.account().to_bytes()),
            })
        );
    }

    /// The same refusal reached the other way: keep the claims, relabel the
    /// document. The document signature is what fails.
    #[test]
    fn a_relabelled_listing_does_not_verify() {
        let (_, _, mine) = account_with_vaults(PHRASE);
        let other = AccountKey::derive(&seed(OTHER_PHRASE));
        let mut forged = mine.clone();
        forged.account = other.public();

        assert_eq!(
            forged.verify(),
            Err(AccountError::ListingNotSigned {
                account: hex::encode(other.public().to_bytes()),
            })
        );
    }

    /// A GATEWAY THAT SERVES A SUBSET. Every remaining claim still verifies on
    /// its own — the document's signature is the only thing that notices.
    #[test]
    fn dropping_a_claim_breaks_the_document_signature() {
        let (_, _, listing) = account_with_vaults(PHRASE);
        let mut short = listing.clone();
        short.claims.pop().expect("three claims");

        for claim in short.vaults() {
            claim.verify().expect("each surviving claim is genuine");
        }
        assert_eq!(
            short.verify(),
            Err(AccountError::ListingNotSigned {
                account: hex::encode(short.account.to_bytes()),
            })
        );
    }

    #[test]
    fn two_claims_on_one_index_are_refused() {
        let seed = seed(PHRASE);
        let account = AccountKey::derive(&seed);
        let keys = VaultMint::fresh().mint(&seed, 2).expect("vault 2");
        let claim = VaultClaim::issue(&account, &keys.identity.public(), 2);

        assert_eq!(
            VaultListing::sign(&account, &[claim, claim]),
            Err(AccountError::NotCanonical {
                account: hex::encode(account.public().to_bytes()),
                reason: "two claims share one vault index",
            })
        );
    }

    /// F2's whole point: the phrase alone brings every vault back, with nothing
    /// republished by the phone that was lost.
    #[test]
    fn a_fresh_phone_re_derives_every_vault_from_the_listing_alone() {
        let (seed, _, listing) = account_with_vaults(PHRASE);
        let restored = listing.restore(&seed).expect("restores");

        assert_eq!(restored.len(), 3);
        for (keys, claim) in restored.iter().zip(listing.vaults()) {
            assert_eq!(keys.index, claim.index());
            assert_eq!(&keys.identity.public(), claim.vault());
        }
    }

    #[test]
    fn a_listing_from_another_phrase_does_not_restore() {
        let (_, _, listing) = account_with_vaults(PHRASE);
        let error = listing
            .restore(&seed(OTHER_PHRASE))
            .expect_err("another phrase");
        assert!(matches!(error, AccountError::ClaimDoesNotDerive { .. }));
    }

    /// The restored phone carries the mark forward, so the next vault it mints
    /// cannot re-derive a vault the account already has (F2).
    #[test]
    fn the_listing_resumes_the_mint_at_the_high_water_mark() {
        let (seed, _, listing) = account_with_vaults(PHRASE);
        assert_eq!(listing.high_water(), Some(4));

        let mut mint = listing.resume_mint();
        assert_eq!(mint.next_index(), 5);
        assert!(
            mint.mint(&seed, 4).is_err(),
            "index 4 is already this account's"
        );
        assert_eq!(mint.mint_next(&seed).expect("vault 5").index, 5);
    }

    #[test]
    fn an_account_with_no_vaults_resumes_a_fresh_mint() {
        let account = AccountKey::derive(&seed(PHRASE));
        let empty = VaultListing::sign(&account, &[]).expect("signs");
        empty
            .verify()
            .expect("an empty listing is still a document");
        assert_eq!(empty.high_water(), None);
        assert_eq!(empty.resume_mint(), VaultMint::fresh());
    }

    #[test]
    fn a_listing_round_trips_through_its_wire_form() {
        let (_, _, listing) = account_with_vaults(PHRASE);
        let bytes = listing.to_bytes();
        assert_eq!(bytes.len(), 32 + 4 + 3 * VAULT_CLAIM_BYTES + 64);

        let read = VaultListing::from_bytes(&bytes).expect("round trip");
        assert_eq!(read, listing);
        read.verify().expect("still signed");
    }

    #[test]
    fn a_truncated_listing_is_refused() {
        let (_, _, listing) = account_with_vaults(PHRASE);
        let bytes = listing.to_bytes();
        assert!(matches!(
            VaultListing::from_bytes(&bytes[..bytes.len() - 1]),
            Err(AccountError::Malformed { .. })
        ));
        assert!(matches!(
            VaultListing::from_bytes(&[0u8; 8]),
            Err(AccountError::Malformed { .. })
        ));
    }

    /// A claim at the account key's own index is not a vault (lane A's
    /// `ACCOUNT_INDEX`), so it is refused before its signature is believed.
    #[test]
    fn a_claim_at_the_reserved_index_is_refused() {
        let seed = seed(PHRASE);
        let account = AccountKey::derive(&seed);
        let keys = VaultMint::fresh().mint(&seed, 0).expect("vault 0");
        let claim = VaultClaim::issue(&account, &keys.identity.public(), ACCOUNT_INDEX);
        assert_eq!(
            claim.verify(),
            Err(AccountError::ReservedIndex {
                index: ACCOUNT_INDEX
            })
        );
    }
}
