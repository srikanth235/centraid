// Scenario-seed registry (issue #290 phase 1). Demo data is real vault data
// written through the normal command pipeline, but it must stay separable
// forever: purgeable in one act, and invisible to the automation plane so a
// fake "rent due" row never fires a real trigger or notification. Provenance
// (activity 'seed.demo') is the journal-side truth; this vault-side registry
// exists because condition triggers evaluate consented READS over vault rows,
// which cannot join journal.db — exclusion needs a same-file marker.
//
// One row per seeded entity. `app_id` is the Centraid app id whose scenario
// generator minted the row, so "reset demo data" can be per-app or whole-vault.
// Ships as its own migration step — earlier DDL versions are already applied.
export const SEED_DDL = `
CREATE TABLE IF NOT EXISTS consent_seed_row (
  seed_id     TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  seeded_at   TEXT NOT NULL,
  UNIQUE (entity_type, entity_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_seed_row_app ON consent_seed_row(app_id);
`;

/** Provenance activity stamped on every demo-seeded write. */
export const SEED_DEMO_ACTIVITY = 'seed.demo';

/** Provenance activity stamped when a demo row is purged. */
export const SEED_PURGE_ACTIVITY = 'seed.purge';
