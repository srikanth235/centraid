CREATE TABLE IF NOT EXISTS hydrate_weekly_recaps (
  week_ending TEXT PRIMARY KEY,
  total_cups INTEGER NOT NULL,
  goal_hits INTEGER NOT NULL,
  encouragement TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
