-- The vault and the quota it is judged under, in one read.
--
-- The quota lives on `account` and the usage on `vault`, because a household
-- owner sets one bound and hands out per-person vaults under it (Q13). The
-- rules see one `VaultState`, so the join happens here rather than in a rule.
SELECT v.vault_key,
       v.account_key,
       v.lease_device,
       v.lease_epoch,
       v.lease_taken_at_ms,
       v.head_object,
       v.moved_at_ms,
       v.append_only,
       v.used_bytes,
       a.quota_bytes
FROM vault AS v
JOIN account AS a ON a.account_key = v.account_key
WHERE v.vault_key = ?1;
