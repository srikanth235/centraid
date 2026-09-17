-- One object, scoped to its vault. THE VAULT KEY IS IN EVERY PREDICATE: a
-- query that looked an object up by name alone would serve one tenant's bytes
-- to another the moment two of them held the same object.
SELECT name, attested_checksum, kind, padded_size, state, received_at_ms,
       purge_after_ms, generation
FROM object
WHERE vault_key = ?1 AND name = ?2;
