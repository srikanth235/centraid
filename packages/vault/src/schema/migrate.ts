// Migration ladders for vault.db and journal.db. Same pattern as the rest of
// the repo: an ordered list of forward-only migrations applied once, tracked
// via PRAGMA user_version (rule R07: migrations are forward-only scripts
// registered per version).

import type { DatabaseSync } from 'node:sqlite';
import { AGENT_DDL } from './agent.js';
import { CONSENT_DDL } from './consent.js';
import { CORE_DDL } from './core.js';
import { HEALTH_DDL, FINANCE_DDL, SCHEDULE_DDL } from './domains-health-finance-schedule.js';
import { HOME_DDL, BUSINESS_DDL } from './domains-home-business.js';
import { SOCIAL_DDL, KNOWLEDGE_DDL, MEDIA_DDL } from './domains-social-knowledge-media.js';
import { JOURNAL_DDL } from './journal.js';

/** Ontology contract version stamped on rows (rule R07). */
export const ONTOLOGY_VERSION = '1.1';

export const VAULT_MIGRATIONS: readonly string[] = [
  [
    CORE_DDL,
    CONSENT_DDL,
    AGENT_DDL,
    HEALTH_DDL,
    FINANCE_DDL,
    SCHEDULE_DDL,
    SOCIAL_DDL,
    KNOWLEDGE_DDL,
    MEDIA_DDL,
    HOME_DDL,
    BUSINESS_DDL,
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
