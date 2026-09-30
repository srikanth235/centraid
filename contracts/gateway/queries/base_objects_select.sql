-- Every base's membership for one vault, in one read: the delete path needs
-- which base an object belongs to for every candidate in a batch, and a query
-- per candidate would be a round trip per object.
SELECT base_id, object_name
FROM base_object
WHERE vault_key = ?1
ORDER BY base_id, ordinal;
