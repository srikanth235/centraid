CREATE TABLE IF NOT EXISTS journal_recaps (
  week_ending TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  mood TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
