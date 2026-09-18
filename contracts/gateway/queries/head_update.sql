-- THE HEAD MOVES ONLY HERE, AND ONLY INSIDE BEGIN IMMEDIATE (F7).
--
-- `BEGIN IMMEDIATE` takes the write lock before the read, so the read above and
-- this write are one atomic step and a second writer waits rather than reading
-- a head that is about to move. An implementation that read, decided in Rust
-- and then wrote without that transaction is the bug the port exists to stop.
UPDATE vault SET head_object = ?2, head_set_at_ms = ?3 WHERE vault_key = ?1;
