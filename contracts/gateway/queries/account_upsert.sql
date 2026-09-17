-- The account a vault is charged against. No email address, no phone number
-- and no name: there is no column for one.
INSERT INTO account (account_key, admitted_at_ms, plan_state, quota_bytes,
                     lapse_at_ms, retain_until_ms)
VALUES (?1, ?2, ?3, ?4, NULL, ?5)
ON CONFLICT (account_key) DO UPDATE SET
  plan_state      = excluded.plan_state,
  quota_bytes     = excluded.quota_bytes,
  retain_until_ms = excluded.retain_until_ms;
