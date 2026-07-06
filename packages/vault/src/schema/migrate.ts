// The schema ladder for vault.db and journal.db — collapsed to ONE rung.
//
// Centraid is pre-release (v0): there is no backward compatibility and no
// data migration story yet, so the ladder does not accumulate patch rungs.
// Every schema module carries its FINAL shape and the single migration
// composes them in dependency order; a shape change edits the module in
// place and an existing dev vault is recreated, not migrated. When v1 ships
// and vaults hold data that must survive upgrades, rungs return — forward-
// only, replay-safe, one per release (rule R07) — on top of this base.
//
// Tracked via PRAGMA user_version exactly as before; migrate() is unchanged.

import type { DatabaseSync } from 'node:sqlite';
import { AGENT_DDL } from './agent.js';
import { BLOB_DDL } from './blob.js';
import { ENRICH_DDL } from './enrich.js';
import { CONSENT_DDL, CONSENT_INSTALL_MEMORY_DDL } from './consent.js';
import { APP_EXT_DDL } from './ext.js';
import { CORE_DDL, LINK_ANCHOR_DDL } from './core.js';
import { FTS_DDL } from './fts.js';
import { HEALTH_DDL, FINANCE_DDL, SCHEDULE_DDL } from './domains-health-finance-schedule.js';
import { HOME_DDL, BUSINESS_DDL } from './domains-home-business.js';
import { PEOPLE_DDL } from './domains-people.js';
import { LOCKER_ALIAS_DDL, LOCKER_DDL } from './domains-locker.js';
import { TALLY_DDL } from './domains-tally.js';
import { SOCIAL_DDL, KNOWLEDGE_DDL, MEDIA_DDL } from './domains-social-knowledge-media.js';
import { JOURNAL_DDL } from './journal.js';
import { OUTBOX_DDL } from './outbox.js';
import { SEED_DDL } from './seed.js';
import { SYNC_CREDENTIAL_DDL, SYNC_DDL } from './sync.js';

/** Ontology contract version stamped on rows (rule R07). */
export const ONTOLOGY_VERSION = '1.1';

// Composition order is dependency order:
//   - CORE first (everything references the spine), anchors ride with it;
//   - the consent plane (apps, grants, install memory, the seed registry,
//     the ext-band registry) before anything that enrolls or scopes;
//   - the agent plane's model tables;
//   - the sync spine before the domains (locker's connection anchor FKs it),
//     with its credential/health sidecars;
//   - the domains (extensions hold FKs into core; locker's alias sidecar and
//     tally after the domains they decorate);
//   - the outbox after sync and social (items reference connections and
//     published messages);
//   - enrichment after media (the phash sidecar FKs the asset);
//   - FTS_DDL near-last: generated triggers read every base table's final
//     shape, and the backfill is a no-op on a fresh file;
//   - BLOB_DDL dead last: it re-creates the content item's FTS sync with the
//     derivative-aware body expression (extracted text feeds the parent row),
//     overriding the generated triggers by name.
export const VAULT_MIGRATIONS: readonly string[] = [
  [
    CORE_DDL,
    LINK_ANCHOR_DDL,
    CONSENT_DDL,
    CONSENT_INSTALL_MEMORY_DDL,
    SEED_DDL,
    APP_EXT_DDL,
    AGENT_DDL,
    SYNC_DDL,
    SYNC_CREDENTIAL_DDL,
    HEALTH_DDL,
    FINANCE_DDL,
    SCHEDULE_DDL,
    SOCIAL_DDL,
    KNOWLEDGE_DDL,
    MEDIA_DDL,
    HOME_DDL,
    BUSINESS_DDL,
    PEOPLE_DDL,
    LOCKER_DDL,
    LOCKER_ALIAS_DDL,
    TALLY_DDL,
    ENRICH_DDL,
    OUTBOX_DDL,
    FTS_DDL,
    BLOB_DDL,
  ].join('\n'),
];

export const JOURNAL_MIGRATIONS: readonly string[] = [JOURNAL_DDL];

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Apply every migration past user_version, each in its own transaction. */
export function migrate(db: DatabaseSync, migrations: readonly string[]): void {
  let version = currentVersion(db);
  while (version < migrations.length) {
    const ddl = migrations[version];
    if (ddl === undefined) break;
    db.exec('BEGIN');
    try {
      db.exec(ddl);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version += 1;
  }
}
