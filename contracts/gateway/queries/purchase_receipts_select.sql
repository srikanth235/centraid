-- Every receipt this account has presented, newest entitlement first. The plan
-- an account is on is decided from these by `centraid_gateway_core::plan`, not
-- here: this statement reads, it does not judge.
SELECT store, verified_at_ms, expires_at_ms, quota_bytes
FROM purchase_receipt
WHERE account_key = ?1
ORDER BY expires_at_ms DESC;
