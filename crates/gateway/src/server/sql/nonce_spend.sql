INSERT INTO nonce_spent (nonce, issued_at_ms) VALUES (?1, ?2)
ON CONFLICT (nonce) DO NOTHING
