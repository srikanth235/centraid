-- Which account a store's `appAccountToken` stands for. THE ONLY DIRECTION
-- THAT IS EVER ASKED: a receipt names a token, and the gateway needs the key.
SELECT account_key, redeemed_at_ms FROM purchase_token WHERE token = ?1;
