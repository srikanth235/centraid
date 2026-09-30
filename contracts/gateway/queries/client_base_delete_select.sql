-- The delete rate limit's only memory (F4).
SELECT deleted_at_ms FROM client_base_delete WHERE vault_key = ?1;
