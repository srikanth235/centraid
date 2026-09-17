-- WHAT IS THIS DEPLOYMENT'S AND NOT THE PROTOCOL'S (#1029 §3).
--
-- `schema.sql` is the contract both adapters apply, and nothing in it may be
-- one deployment's. This file is the standalone server's own addendum, applied
-- after it, and it holds exactly one thing: **how a member is admitted.**
--
-- Admission is named in `crates/gateway-core/src/lib.rs` as one of the two
-- honest differences between the deployments — the hosted adapter admits by
-- purchase, and a self-hosted household admits by invite from its owner (Q13).
-- Everything downstream of admission is the shared schema again: the invite
-- ends in an `account` row and a `vault` row, and from there every rule in
-- `gateway-core` judges the two deployments identically. If a table here ever
-- needs to be read by a rule, it is in the wrong file.
--
-- THE GATEWAY IS STILL BLIND. There is no member name, no email address and no
-- label here, and the invite code itself is not here either: what is stored is
-- its BLAKE3, so a stolen database is not a set of working invitations.

CREATE TABLE IF NOT EXISTS invite (
  -- BLAKE3-256 of the invite secret. Never the secret.
  code_hash      BLOB PRIMARY KEY NOT NULL,
  -- The quota the redeeming vault's account is created with. Keys are free to
  -- mint, so an invite without a bound would be an unbounded free tier on
  -- somebody's home box (F13).
  quota_bytes    INTEGER NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  expires_at_ms  INTEGER NOT NULL,
  -- NULL until redeemed. A redemption is a conditional UPDATE on this being
  -- NULL, which is what makes an invite single-use under a race.
  redeemed_at_ms INTEGER,
  -- The account key that redeemed it. A public key, like everything else here.
  redeemed_by    BLOB
) STRICT;
