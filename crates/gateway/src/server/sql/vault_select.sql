SELECT vault, writer_epoch, paired_at_ms, moved_at_ms, generation, writes, frozen_at_ms
FROM vault WHERE vault = ?1
