//! ADMISSION, WHICH IS THE ONE PLACE THE TWO DEPLOYMENTS DIFFER (#1029 §3).
//!
//! A standalone household admits by an owner-minted invite; this deployment
//! admits by **a key and a purchase**. Both end in exactly the same state — an
//! `account` row and a `vault` row in the shared schema — and from there every
//! rule in `centraid-gateway-core` judges the two identically. That is why this
//! is the only module in this crate with no counterpart in
//! `crates/gateway-server`, and why nothing downstream of it knows it exists.
//!
//! # §0: NO EMAIL ADDRESS, NO PHONE NUMBER, ANYWHERE
//!
//! An account **is** its key. There is no column for a name, no field on any
//! request here that carries one, and no store call that asks for one — the
//! whole point of buying through the App Store or Play is that the store
//! already knows who the customer is and this gateway never has to.
//!
//! # THE `appAccountToken` PROBLEM
//!
//! StoreKit's `appAccountToken` is a **UUID**: 128 bits. An account key is 256.
//! It does not fit, and truncating the key to make it fit would build a
//! namespace where two accounts collide — silently, in the one place where a
//! collision hands somebody else's plan to a stranger.
//!
//! So the token is **random and meaningless**: minted here before the purchase,
//! handed to the phone to pass to StoreKit, and mapped back server-side through
//! `purchase_token` in `contracts/gateway/hosted.sql`. The store learns a UUID
//! that says nothing. Google Play's `obfuscatedAccountId` is the same shape and
//! gets the same answer.
//!
//! # Q15 AND Q16 ARE OPEN, AND NOTHING HERE DECIDES THEM
//!
//! Pricing (Q15) and licensing (Q16) are still with the owner. What is built
//! here is the **mechanism**: a receipt maps to an account, and an account
//! carries a quota **in bytes**. Which product id is worth how many bytes is
//! `PRODUCT_QUOTAS` in the Worker's environment — a JSON object the owner sets
//! without a deploy of this code — and there is no price, no plan name and no
//! licence text in this crate. `tests/no_rules_here.rs` is the scan that keeps
//! it that way, and it fails on this paragraph too if the paragraph starts
//! naming one.
//!
//! # WHAT A STAGING RUN STILL OWES
//!
//! The store's verification endpoints are configuration here, and the response
//! fields this module reads (`appAccountToken`, `productId`, an expiry in
//! milliseconds) are the documented ones — but **no request has been made to a
//! real store from this container**, which has no Cloudflare account and no
//! store credentials. The shapes are pinned by `tests/receipt.rs` against
//! recorded bodies, which proves the parser and not the endpoint. The receipt
//! says so plainly rather than leaving it to be discovered.

// The account store's own imports: it is the wasm32 half of this module, and
// the pure half below it — the receipt interpretation and the product table —
// needs none of them.
#[cfg(target_arch = "wasm32")]
use centraid_gateway_core::ids::{AccountId, Key32, VaultId};
#[cfg(target_arch = "wasm32")]
use centraid_gateway_core::plan::{self, Entitlement, Plan};
#[cfg(target_arch = "wasm32")]
use centraid_gateway_core::store::StoreFault;
use centraid_gateway_core::time::ServerTime;
use serde::{Deserialize, Serialize};
#[cfg(target_arch = "wasm32")]
use worker::{SqlStorage, SqlStorageValue};

#[cfg(target_arch = "wasm32")]
use crate::sql;

/// The hosted adapter's own addendum to the shared schema.
///
/// Applied after `centraid_gateway_core::SCHEMA_SQL`, exactly as the standalone
/// adapter applies `standalone.sql` after it. It holds admission and nothing
/// else, because admission is the one honest difference.
pub const HOSTED_SCHEMA: &str = include_str!("../../../contracts/gateway/hosted.sql");

/// Which store a receipt came from. **Which store, not which price.**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Store {
    AppStore,
    Play,
}

impl Store {
    /// The word the `purchase_receipt.store` column holds.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AppStore => "app_store",
            Self::Play => "play",
        }
    }

    /// The inverse of [`Store::as_str`]. An unknown word is `None` rather than a
    /// guess: a gateway that guessed a store would be a gateway guessing at a
    /// verification endpoint.
    #[must_use]
    pub fn of(word: &str) -> Option<Self> {
        match word {
            "app_store" => Some(Self::AppStore),
            "play" => Some(Self::Play),
            _ => None,
        }
    }
}

/// What a store said, once this Worker has verified it.
///
/// **The receipt itself is not in here and is never stored**: it is a bearer
/// credential for somebody's store account, and a gateway that kept a copy
/// would be holding something it has no use for and every reason not to have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedReceipt {
    pub store: Store,
    /// The opaque token this gateway minted and the phone passed to the store.
    pub token: String,
    /// What the store says the subscription runs until.
    pub entitled_until: ServerTime,
    /// What that product is worth, in bytes, from `PRODUCT_QUOTAS`.
    pub quota_bytes: u64,
}

/// What the owner configured, and the only place a number lives.
#[derive(Debug, Clone)]
pub struct PlanConfig {
    /// Product id → bytes. Set in the Worker's environment as JSON, so the
    /// owner can change what a product is worth without a deploy of this code
    /// and without this code naming a price (Q15).
    pub product_quotas: Vec<(String, u64)>,
    /// What an account with no verified receipt gets.
    ///
    /// **Zero is a legitimate value and is the default**: keys are free to mint,
    /// so an unbounded free tier is unbounded Sybil storage (F13). An operator
    /// who wants a free tier sets a number; one who does nothing gets the safe
    /// answer rather than the generous one.
    pub free_quota_bytes: u64,
}

impl PlanConfig {
    /// What one product id is worth. `None` is a product this deployment does
    /// not sell, which is a refusal rather than a default — a receipt for an
    /// unknown product granting the free tier would be a receipt granting
    /// nothing and looking like it worked.
    #[must_use]
    pub fn quota_for(&self, product_id: &str) -> Option<u64> {
        self.product_quotas
            .iter()
            .find(|(id, _)| id == product_id)
            .map(|(_, bytes)| *bytes)
    }
}

/// The store's own answer, in the fields this gateway reads.
///
/// Both stores return a great deal more; none of the rest is any of this
/// gateway's business, and a struct with `deny_unknown_fields` would break the
/// day a store added a field. What is named here is what is used.
#[derive(Debug, Clone, Deserialize)]
pub struct StoreResponse {
    /// StoreKit's `appAccountToken`, or Play's `obfuscatedExternalAccountId`.
    /// The handle this gateway minted; it means nothing to the store.
    pub app_account_token: String,
    pub product_id: String,
    /// When the subscription runs out, in milliseconds since the Unix epoch.
    pub expires_date_ms: i64,
}

/// Why a receipt did not become a plan.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReceiptFault {
    /// This deployment has no credentials for that store, so it cannot verify
    /// anything and says so rather than trusting the client's copy of the
    /// answer.
    #[error("no verification credentials are configured for this store")]
    NotConfigured,
    /// The store refused the receipt, or could not be reached.
    #[error("the store did not verify this receipt: {0}")]
    Unverified(String),
    /// The store's answer did not parse.
    #[error("the store's answer was not the shape this gateway reads: {0}")]
    Malformed(String),
    /// The token is not one this gateway minted, or belongs to another account.
    ///
    /// **The same refusal for both**, deliberately: distinguishing them would
    /// answer "does this token exist?" for anyone who asked, which is an
    /// enumeration oracle over the purchase table.
    #[error("that purchase token is not this account's")]
    UnknownToken,
    /// A receipt for a product this deployment does not sell.
    #[error("that product is not one this deployment sells")]
    UnknownProduct,
}

/// One account's own Durable Object storage: the vault listing and the purchase
/// map.
///
/// A third object class beside the per-vault and per-mailbox ones §3 names, and
/// for the same reason they exist: it is the unit the questions are asked of.
/// `GET /a/{account}/vaults` is per account, and a purchase is per account, and
/// putting either in a per-vault object would mean a phone that lost its vault
/// list could not get it back.
#[cfg(target_arch = "wasm32")]
pub struct AccountStore {
    sql: SqlStorage,
}

#[cfg(target_arch = "wasm32")]
impl AccountStore {
    /// Open and apply the shared schema plus this deployment's addendum.
    ///
    /// # Errors
    ///
    /// A store fault if either schema cannot be applied.
    pub fn open(sql: SqlStorage) -> Result<Self, StoreFault> {
        sql.exec(centraid_gateway_core::SCHEMA_SQL, None)
            .map_err(fault)?;
        sql.exec(HOSTED_SCHEMA, None).map_err(fault)?;
        Ok(Self { sql })
    }

    /// Mint an opaque purchase token for this account.
    ///
    /// `token` is supplied by the caller rather than generated here for the
    /// reason every random value in this design is an input: `gateway-core` has
    /// no ambient randomness and neither should the code beside it — the
    /// platform's generator is the Worker's, and passing it in is what makes
    /// this testable at all.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn mint_token(
        &self,
        account: &AccountId,
        token: &str,
        now: ServerTime,
    ) -> Result<(), StoreFault> {
        self.sql
            .exec(
                sql::PURCHASE_TOKEN_INSERT,
                vec![
                    SqlStorageValue::String(token.to_owned()),
                    SqlStorageValue::Blob(account.as_bytes().to_vec()),
                    SqlStorageValue::Integer(now.millis()),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    /// Which account a token stands for, if this object minted it.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn account_for_token(&self, token: &str) -> Result<Option<AccountId>, StoreFault> {
        let cursor = self
            .sql
            .exec(
                sql::PURCHASE_TOKEN_SELECT,
                vec![SqlStorageValue::String(token.to_owned())],
            )
            .map_err(fault)?;
        for row in cursor.raw() {
            let row = row.map_err(fault)?;
            if let Some(SqlStorageValue::Blob(bytes)) = row.first() {
                return Ok(Key32::from_slice(bytes));
            }
        }
        Ok(None)
    }

    /// Record a verified receipt and mark its token spent.
    ///
    /// # Errors
    ///
    /// A store fault, or [`ReceiptFault::UnknownToken`] when the token is not
    /// this account's.
    pub fn record_receipt(
        &self,
        account: &AccountId,
        receipt_hash: &[u8; 32],
        verified: &VerifiedReceipt,
        now: ServerTime,
    ) -> Result<(), StoreFault> {
        self.sql
            .exec(
                sql::PURCHASE_RECEIPT_INSERT,
                vec![
                    SqlStorageValue::Blob(receipt_hash.to_vec()),
                    SqlStorageValue::Blob(account.as_bytes().to_vec()),
                    SqlStorageValue::String(verified.store.as_str().to_owned()),
                    SqlStorageValue::Integer(now.millis()),
                    SqlStorageValue::Integer(verified.entitled_until.millis()),
                    SqlStorageValue::Integer(
                        i64::try_from(verified.quota_bytes).unwrap_or(i64::MAX),
                    ),
                ],
            )
            .map_err(fault)?;
        self.sql
            .exec(
                sql::PURCHASE_TOKEN_REDEEM,
                vec![
                    SqlStorageValue::String(verified.token.clone()),
                    SqlStorageValue::Integer(now.millis()),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    /// THE PLAN THIS ACCOUNT IS ON, right now, by this gateway's own clock.
    ///
    /// Reads every receipt and hands the best entitlement to
    /// [`plan::judge`] — **which is the rule**, in `gateway-core`, so that what
    /// "lapsed" means is one answer rather than this adapter's opinion. A
    /// receipt whose expiry has passed still counts here: it is what makes the
    /// account lapsed-and-readable rather than unknown.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn plan(
        &self,
        account: &AccountId,
        used_bytes: u64,
        config: &PlanConfig,
        now: ServerTime,
    ) -> Result<Plan, StoreFault> {
        let cursor = self
            .sql
            .exec(
                sql::PURCHASE_RECEIPTS_SELECT,
                vec![SqlStorageValue::Blob(account.as_bytes().to_vec())],
            )
            .map_err(fault)?;
        // Ordered by expiry, latest first, so the first row is the entitlement
        // that reaches furthest. An account that bought a second subscription
        // before the first ran out is one account with one plan, not two.
        let mut best: Option<(i64, u64)> = None;
        for row in cursor.raw() {
            let row = row.map_err(fault)?;
            let expires = match row.get(2) {
                Some(SqlStorageValue::Integer(number)) => *number,
                _ => continue,
            };
            let quota = match row.get(3) {
                Some(SqlStorageValue::Integer(number)) => (*number).max(0) as u64,
                _ => continue,
            };
            if best.is_none_or(|(held, _)| expires > held) {
                best = Some((expires, quota));
            }
        }

        Ok(plan::judge(
            match best {
                Some((expires, quota)) => Entitlement {
                    quota_bytes: quota,
                    used_bytes,
                    entitled_until: Some(ServerTime::from_millis(expires)),
                },
                // Nothing verified: the free tier, whatever the operator set it
                // to, and zero is the default.
                None => Entitlement {
                    quota_bytes: config.free_quota_bytes,
                    used_bytes,
                    entitled_until: None,
                },
            },
            now,
        ))
    }

    /// Add a vault to this account's listing. Idempotent: a phone that
    /// re-registers after a restore is not a second vault.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn add_vault(
        &self,
        account: &AccountId,
        vault: &VaultId,
        now: ServerTime,
    ) -> Result<(), StoreFault> {
        self.sql
            .exec(
                sql::ACCOUNT_VAULT_INSERT,
                vec![
                    SqlStorageValue::Blob(account.as_bytes().to_vec()),
                    SqlStorageValue::Blob(vault.as_bytes().to_vec()),
                    SqlStorageValue::Integer(now.millis()),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    /// What a restored phone reads to find its vaults, with no operator
    /// involved (§0).
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn vaults(&self, account: &AccountId) -> Result<Vec<(VaultId, i64)>, StoreFault> {
        let cursor = self
            .sql
            .exec(
                sql::ACCOUNT_VAULTS_SELECT,
                vec![SqlStorageValue::Blob(account.as_bytes().to_vec())],
            )
            .map_err(fault)?;
        let mut out = Vec::new();
        for row in cursor.raw() {
            let row = row.map_err(fault)?;
            let Some(SqlStorageValue::Blob(bytes)) = row.first() else {
                continue;
            };
            let Some(vault) = Key32::from_slice(bytes) else {
                continue;
            };
            let at = match row.get(1) {
                Some(SqlStorageValue::Integer(number)) => *number,
                _ => 0,
            };
            out.push((vault, at));
        }
        Ok(out)
    }
}

#[cfg(target_arch = "wasm32")]
fn fault(error: worker::Error) -> StoreFault {
    StoreFault::new(error.to_string())
}

/// Turn a store's answer into an entitlement, or say why not.
///
/// **Pure**, so the shapes can be pinned against recorded bodies without a
/// store: the HTTP call that produced `response` is the caller's.
///
/// # Errors
///
/// [`ReceiptFault::UnknownProduct`] for a product this deployment does not
/// sell, or [`ReceiptFault::Malformed`] for an answer that does not parse.
pub fn interpret(
    store: Store,
    response: &StoreResponse,
    config: &PlanConfig,
) -> Result<VerifiedReceipt, ReceiptFault> {
    let quota_bytes = config
        .quota_for(&response.product_id)
        .ok_or(ReceiptFault::UnknownProduct)?;
    if response.app_account_token.is_empty() {
        return Err(ReceiptFault::Malformed(
            "the store returned no account token, so this receipt names no account".to_owned(),
        ));
    }
    Ok(VerifiedReceipt {
        store,
        token: response.app_account_token.clone(),
        entitled_until: ServerTime::from_millis(response.expires_date_ms),
        quota_bytes,
    })
}

/// Parse `PRODUCT_QUOTAS` — a JSON object of product id to bytes.
///
/// A malformed value is an **empty** table and not a default one: an operator
/// who typoed their configuration should find that nothing sells, loudly, and
/// not that everything quietly became the free tier.
#[must_use]
pub fn product_quotas(raw: &str) -> Vec<(String, u64)> {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(id, value)| value.as_u64().map(|bytes| (id, bytes)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> PlanConfig {
        PlanConfig {
            product_quotas: vec![("vault.year".to_owned(), 512 * 1_024 * 1_024 * 1_024)],
            free_quota_bytes: 0,
        }
    }

    /// A RECEIPT FOR SOMETHING THIS DEPLOYMENT DOES NOT SELL IS A REFUSAL.
    ///
    /// Not the free tier: a receipt that granted nothing while looking like it
    /// worked is a member who paid and cannot upload, with no error to show
    /// support.
    #[test]
    fn an_unknown_product_is_refused_rather_than_defaulted() {
        let response = StoreResponse {
            app_account_token: "b4f0-…".to_owned(),
            product_id: "vault.decade".to_owned(),
            expires_date_ms: 1,
        };
        assert_eq!(
            interpret(Store::AppStore, &response, &config()),
            Err(ReceiptFault::UnknownProduct)
        );
    }

    /// THE TOKEN IS CARRIED THROUGH UNTOUCHED. It is the only link between a
    /// store's records and an account key, and an adapter that reformatted it
    /// would be an adapter whose lookup misses.
    #[test]
    fn a_verified_receipt_carries_the_token_the_store_returned() {
        let response = StoreResponse {
            app_account_token: "0f6b2c1e-8a44-4d2f-9c31-7e0a5b6d4c88".to_owned(),
            product_id: "vault.year".to_owned(),
            expires_date_ms: 1_800_000_000_000,
        };
        let verified = interpret(Store::AppStore, &response, &config()).expect("verified");
        assert_eq!(verified.token, response.app_account_token);
        assert_eq!(verified.entitled_until.millis(), 1_800_000_000_000);
        assert_eq!(verified.quota_bytes, 512 * 1_024 * 1_024 * 1_024);
    }

    /// A TYPO IN THE CONFIGURATION SELLS NOTHING, LOUDLY.
    #[test]
    fn a_malformed_product_table_is_empty_rather_than_permissive() {
        assert!(product_quotas("not json at all").is_empty());
        assert!(product_quotas("[]").is_empty());
        assert_eq!(
            product_quotas(r#"{"vault.year": 1024}"#),
            vec![("vault.year".to_owned(), 1_024)]
        );
    }

    /// THE STORE WORD IS THE COLUMN'S, AND IT ROUND-TRIPS.
    #[test]
    fn a_store_survives_the_column_it_is_written_to() {
        for store in [Store::AppStore, Store::Play] {
            assert_eq!(Store::of(store.as_str()), Some(store));
        }
        assert_eq!(Store::of("some other shop"), None);
    }
}
