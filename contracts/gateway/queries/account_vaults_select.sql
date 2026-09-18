-- What a restored phone reads to find its vaults, with no operator involved.
SELECT vault_key, registered_at_ms
FROM account_vault
WHERE account_key = ?1
ORDER BY registered_at_ms, vault_key;
