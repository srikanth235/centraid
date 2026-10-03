SELECT name, taken_at_ms, registered_at_ms FROM snapshot WHERE vault = ?1
ORDER BY taken_at_ms, name
