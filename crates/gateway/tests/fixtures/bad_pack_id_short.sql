INSERT INTO vault (vault, writer_epoch, paired_at_ms, generation, writes)
VALUES (zeroblob(32), 1, 100, 0, 0);
INSERT INTO object (vault, name, digest, size, pack_id, pack_pos, stored_at_ms)
VALUES (zeroblob(32), zeroblob(32), zeroblob(32), 10, zeroblob(15), 0, 100);
