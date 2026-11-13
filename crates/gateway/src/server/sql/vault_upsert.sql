INSERT INTO vault (vault, writer_epoch, paired_at_ms, moved_at_ms, generation, writes, frozen_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT (vault) DO UPDATE SET
  writer_epoch = excluded.writer_epoch,
  paired_at_ms = excluded.paired_at_ms,
  moved_at_ms = excluded.moved_at_ms,
  generation = excluded.generation,
  writes = excluded.writes,
  frozen_at_ms = excluded.frozen_at_ms
