export const SEED_DDL = `
CREATE TABLE IF NOT EXISTS access_seed_row (
  seed_id     TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  seeded_at   TEXT NOT NULL,
  UNIQUE (target_type, target_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_seed_row_app ON access_seed_row(app_id);
`;

export const SEED_DEMO_ACTIVITY = "seed.demo";

export const SEED_PURGE_ACTIVITY = "seed.purge";
