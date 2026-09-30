-- Every object this vault holds, in any state, in a stable order.
SELECT name, kind, padded_size, state, received_at_ms,
       purge_after_ms, generation
FROM object
WHERE vault_key = ?1
ORDER BY name;
