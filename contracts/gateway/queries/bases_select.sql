-- The bases retention is defined over (F10), oldest first and then by id, so
-- two adapters answering the same vault answer in the same order.
SELECT base_id, generation, received_at_ms, padded_size, tombstoned
FROM base
WHERE vault_key = ?1
ORDER BY received_at_ms, base_id;
