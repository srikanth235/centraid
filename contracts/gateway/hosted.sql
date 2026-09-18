-- WHAT THE HOSTED DEPLOYMENT'S ACCOUNT OBJECT HOLDS, AND NOTHING THE PROTOCOL
-- OWNS (#1029 §3).
--
-- `schema.sql` is the contract both adapters apply, and nothing in it may be
-- one deployment's. This file is the Cloudflare adapter's own addendum, applied
-- by its per-account Durable Object after the shared schema, and it holds
-- exactly the two things **admission by purchase** needs that an invite does
-- not. Its counterpart is `standalone.sql`, the invite table.
--
-- Admission is named in `crates/gateway-core/src/lib.rs` as one of the two
-- honest differences between the deployments, and it **ends in the same state
-- either way**: an `account` row and a `vault` row in the shared schema, from
-- which every rule in `gateway-core` judges both deployments identically. If a
-- table here ever needs to be read by a rule, it is in the wrong file.
--
-- NO EMAIL ADDRESS, NO PHONE NUMBER, NO NAME (§0). There is no column for one
-- here and there is not going to be. The whole point of buying through the App
-- Store or Play is that the store already knows who the customer is and this
-- gateway never has to.
--
-- NO PRICE AND NO PLAN NAME EITHER. Pricing (Q15) and licensing (Q16) are open
-- with the owner; what is built here is the MECHANISM — a receipt maps to an
-- account and an account carries a quota in bytes — and a number that would
-- have to change when the owner decides is deliberately not written down.

-- ------------------------------------------------------------- purchases --
--
-- THE `appAccountToken` PROBLEM, AND ITS ANSWER.
--
-- StoreKit's `appAccountToken` is a **UUID**: 128 bits. An account key is a
-- 32-byte Ed25519 public key: 256 bits. It does not fit, and an adapter that
-- truncated the key to make it fit would have built a namespace where two
-- accounts can collide — silently, and in the one place where a collision hands
-- somebody else's plan to a stranger.
--
-- So the token is **random and meaningless**, minted by this gateway before the
-- purchase and handed to the phone to pass to StoreKit, and THIS TABLE is the
-- mapping. The store learns a UUID that says nothing; the gateway learns which
-- account paid. Google Play's `obfuscatedAccountId` is the same shape and the
-- same answer.
CREATE TABLE IF NOT EXISTS purchase_token (
  -- The UUID handed to the store, lowercase hex with dashes as StoreKit
  -- spells it. Random: it is an opaque handle and not a derivation, because a
  -- derivation from the account key would let the store's records be linked
  -- back to it by anyone who learned the rule.
  token          TEXT PRIMARY KEY NOT NULL,
  -- The account it stands for. A public key, like everything else here.
  account_key    BLOB NOT NULL,
  minted_at_ms   INTEGER NOT NULL,
  -- NULL until a receipt naming this token has been verified. A token that is
  -- never redeemed costs one row and expires by sweep.
  redeemed_at_ms INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS purchase_token_by_account
  ON purchase_token (account_key);

-- One verified receipt. **The receipt itself is not stored**: it is a bearer
-- credential for somebody's store account, and a gateway that kept a copy would
-- be holding something it has no use for and every reason not to have. What is
-- kept is its BLAKE3, so a replay of the same receipt is recognised, and the
-- dates the store asserted.
CREATE TABLE IF NOT EXISTS purchase_receipt (
  receipt_hash    BLOB PRIMARY KEY NOT NULL,
  account_key     BLOB NOT NULL,
  -- `app_store` or `play`. Which store, not which price.
  store           TEXT NOT NULL,
  verified_at_ms  INTEGER NOT NULL,
  -- What the store said the subscription is good until. The gateway's OWN
  -- clock decides whether that has passed (F13) — a client cannot backdate a
  -- lapse any more than it can backdate a base.
  expires_at_ms   INTEGER NOT NULL,
  -- The quota this receipt entitles the account to, in bytes. A NUMBER, and
  -- not a plan name or a price: Q15 is open and this file does not decide it.
  quota_bytes     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS purchase_receipt_by_account
  ON purchase_receipt (account_key);

-- ---------------------------------------------------------- vault listing --
--
-- `GET /a/{account}/vaults`, signed by the account key, is how a restored phone
-- finds its vaults with no operator involved (§0). The shared schema's `vault`
-- table is per-vault and lives in a per-vault Durable Object, so the listing
-- cannot be a join — it is this table, in the account's own object.
--
-- It holds a vault's identity key and when it was registered. Not its size, not
-- its head and not its lease: those are the vault object's, and copying them
-- here would be a second answer that can disagree with the first.
CREATE TABLE IF NOT EXISTS account_vault (
  account_key      BLOB NOT NULL,
  vault_key        BLOB NOT NULL,
  registered_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_key, vault_key)
) STRICT;
