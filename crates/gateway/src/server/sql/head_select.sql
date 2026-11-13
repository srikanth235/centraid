SELECT name, prev, taken_at_ms, epoch, generation, writes, set_at_ms, signature
FROM head WHERE vault = ?1
