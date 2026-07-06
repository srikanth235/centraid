// Migration ladders for vault.db and journal.db. Same pattern as the rest of
// the repo: an ordered list of forward-only migrations applied once, tracked
// via PRAGMA user_version (rule R07: migrations are forward-only scripts
// registered per version).

import type { DatabaseSync } from 'node:sqlite';
import { AGENT_DDL } from './agent.js';
import { BLOB_DDL } from './blob.js';
import { ENRICH_DDL } from './enrich.js';
import {
  CONSENT_DDL,
  CONSENT_INSTALL_MEMORY_DDL,
  GRANT_SCOPE_REVEAL_DDL,
} from './consent.js';
import { APP_EXT_DDL } from './ext.js';
import { CORE_DDL, LINK_ANCHOR_DDL } from './core.js';
import { FTS_DDL } from './fts.js';
import { HEALTH_DDL, FINANCE_DDL, SCHEDULE_DDL } from './domains-health-finance-schedule.js';
import { HOME_DDL, BUSINESS_DDL } from './domains-home-business.js';
import { PEOPLE_DDL } from './domains-people.js';
import { LOCKER_ALIAS_DDL, LOCKER_DDL } from './domains-locker.js';
import { TALLY_DDL } from './domains-tally.js';
import {
  SOCIAL_DDL,
  KNOWLEDGE_DDL,
  KNOWLEDGE_TRASH_DDL,
  MEDIA_DDL,
} from './domains-social-knowledge-media.js';
import { JOURNAL_DDL } from './journal.js';
import { OUTBOX_DDL } from './outbox.js';
import { SEED_DDL } from './seed.js';
import { SYNC_CREDENTIAL_DDL, SYNC_DDL } from './sync.js';

/** Ontology contract version stamped on rows (rule R07). */
export const ONTOLOGY_VERSION = '1.1';

// v3: cross-referencing relations (issue #272). Fresh vaults get these from
// the bootstrap seed; this backfills vaults created before the notations
// existed. Ids are randomblob hex rather than uuidv7 — ids are immutable and
// meaningless, and migrations are static SQL. On a fresh file the scheme row
// does not exist yet (bootstrap runs after migrations), so this inserts
// nothing and the seed provides both.
const RELATION_BACKFILL_DDL = [
  ['references', 'References'],
  ['attachment-of', 'Attachment of'],
]
  .map(
    ([notation, label]) => `
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
SELECT lower(hex(randomblob(16))), s.scheme_id, '${notation}', '${label}', NULL, NULL, NULL
  FROM core_concept_scheme s
 WHERE s.uri = 'urn:duaility:relations'
   AND NOT EXISTS (
     SELECT 1 FROM core_concept c
      WHERE c.scheme_id = s.scheme_id AND c.notation = '${notation}'
   );`,
  )
  .join('\n');

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
    PEOPLE_DDL,
    LOCKER_DDL,
    TALLY_DDL,
  ].join('\n'),
  // v2: the text-search plane — FTS5 shadow tables + sync triggers, with a
  // backfill so a pre-index vault becomes searchable on first open.
  FTS_DDL,
  // v3: backfill the cross-referencing relation concepts (issue #272).
  RELATION_BACKFILL_DDL,
  // v4: standoff anchors for inline references (issue #282) — backfills empty.
  LINK_ANCHOR_DDL,
  // v5: the ext-band registry (issue #286 phase 2) — app-declared extension
  // tables live inside vault.db; this table tracks their declared specs.
  APP_EXT_DDL,
  // v6: the scenario-seed registry (issue #290 phase 1) — backfills empty.
  SEED_DDL,
  // v7: the sync domain (issue #290 phases 2-4) — connections, the
  // external-id map, the import staging band, cursors + run log.
  SYNC_DDL,
  // v8: the `reveal` scope verb (issue #293) — SQLite cannot ALTER a CHECK,
  // so grant scopes rebuild in place. Pure copy; fresh vaults get the
  // widened CHECK from v1 directly.
  GRANT_SCOPE_REVEAL_DDL,
  // v9: blob custody (issue #296) — the staging band, the derivative
  // registry, and the derivative-aware rebuild of the content item's FTS
  // sync triggers.
  BLOB_DDL,
  // v10: the enrichment spine (issue #299) — the perceptual-hash column,
  // the additive embedding index, the on-demand request queue, and the
  // machine-tag concept schemes.
  ENRICH_DDL,
  // v11: stable locker aliases (issue #298 item 4) — a sidecar mapping an
  // owner-assigned name a connector binds instead of the item UUID, so
  // delete+recreate re-heals the credential binding without republishing.
  LOCKER_ALIAS_DDL,
  // v12: broker-owned credentials (issue #304) — the credential + health
  // SIDECARS on the connection: oauth2/api_key kinds with sealed token
  // cells the gateway broker injects toward pinned hosts; no row keeps the
  // harness-ambient lane.
  SYNC_CREDENTIAL_DDL,
  // v13: the outbox (issue #306) — external writes as first-class artifacts
  // the owner decides on, plus the standing (actor, verb, target) grants
  // minted from them.
  OUTBOX_DDL,
  // v14: consent memory (issue #308 A3/A4) — scope tombstones make owner
  // revocations durable against the install-grant top-up; scope requests
  // park manifest widening as a blocking item instead of auto-granting.
  CONSENT_INSTALL_MEMORY_DDL,
  // v15: note trash (issue #308 A6) — delete becomes reversible: the
  // soft-delete pair on knowledge_note, restore via knowledge.restore_note,
  // real deletion deferred to the lifecycle sweep's purge window.
  KNOWLEDGE_TRASH_DDL,
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
