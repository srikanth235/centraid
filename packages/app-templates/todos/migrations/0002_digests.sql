CREATE TABLE IF NOT EXISTS todo_digests (
  day TEXT PRIMARY KEY,
  open_count INTEGER NOT NULL,
  done_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
