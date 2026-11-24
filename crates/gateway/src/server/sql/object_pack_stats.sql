SELECT COUNT(*), COALESCE(SUM(size), 0)
FROM object INDEXED BY object_by_pack
WHERE vault = ?1 AND pack_id = ?2
