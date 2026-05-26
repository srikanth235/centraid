CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_todos_done_created ON todos(done, created_at DESC);

CREATE TABLE IF NOT EXISTS todo_digests (
  day TEXT PRIMARY KEY,
  open_count INTEGER NOT NULL,
  done_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
