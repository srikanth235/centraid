-- A vault joins an account's listing. Idempotent: a phone that re-registers
-- after a restore is not a second vault.
INSERT INTO account_vault (account_key, vault_key, registered_at_ms)
VALUES (?1, ?2, ?3)
ON CONFLICT (account_key, vault_key) DO NOTHING;
