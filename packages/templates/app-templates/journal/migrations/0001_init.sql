CREATE TABLE IF NOT EXISTS journal_entries (
  date TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
