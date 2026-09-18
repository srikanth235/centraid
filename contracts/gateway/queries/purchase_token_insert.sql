-- A token minted before a purchase. Random and meaningless to the store.
INSERT INTO purchase_token (token, account_key, minted_at_ms, redeemed_at_ms)
VALUES (?1, ?2, ?3, NULL);
