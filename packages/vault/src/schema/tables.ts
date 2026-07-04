// Logical ↔ physical name registry. The ontology speaks schema-qualified
// logical names (`core.party`) — grants, receipts, links and polymorphic refs
// all store them. SQLite has no namespaces, so physical tables are
// underscore-joined (`core_party`). The gateway translates through this
// registry only, which doubles as an allow-list: unknown entity names never
// reach SQL.

export const VAULT_TABLES: Readonly<Record<string, readonly string[]>> = {
  core: [
    'vault',
    'party',
    'party_identifier',
    'place',
    'event',
    'account',
    'transaction',
    'content_item',
    'attachment',
    'activity',
    'observation',
    'observation_component',
    'link',
    'concept_scheme',
    'concept',
    'tag',
    'collection',
    'collection_entry',
  ],
  consent: [
    'app',
    'app_view',
    'access_grant',
    'grant_scope',
    'share',
    'policy',
    'device',
    'export_job',
  ],
  agent: ['agent', 'command', 'capability', 'correction', 'judgment'],
  health: ['vital', 'workout', 'sleep_session', 'medication_course', 'condition'],
  finance: ['txn_split', 'budget', 'holding', 'recurring_series', 'fx_rate'],
  schedule: ['calendar', 'event_ext', 'attendee', 'task', 'availability_rule'],
  social: ['contact_card', 'circle', 'circle_member', 'thread', 'thread_participant', 'message'],
  knowledge: ['note', 'annotation'],
  media: ['media_asset', 'face_region'],
  home: ['asset_item', 'warranty', 'maintenance_plan', 'utility_meter', 'meter_reading'],
  business: ['client', 'project', 'time_entry', 'invoice', 'invoice_line'],
};

/** journal.db tables — the append-only audit stream. */
export const JOURNAL_TABLES: Readonly<Record<string, readonly string[]>> = {
  consent: ['provenance', 'receipt'],
  agent: ['command_invocation', 'invocation_check', 'evidence', 'explanation'],
};

export interface EntityRef {
  schema: string;
  table: string;
  /** Physical SQLite table name, e.g. `core_party`. */
  physical: string;
  /** Which file holds it. */
  file: 'vault' | 'journal';
}

/**
 * Resolve a logical `schema.table` name. Returns undefined for anything not
 * in the registry — callers treat that as a denial, never as SQL.
 */
export function resolveEntity(logical: string): EntityRef | undefined {
  const dot = logical.indexOf('.');
  if (dot <= 0) return undefined;
  const schema = logical.slice(0, dot);
  const table = logical.slice(dot + 1);
  if (VAULT_TABLES[schema]?.includes(table)) {
    return { schema, table, physical: `${schema}_${table}`, file: 'vault' };
  }
  if (JOURNAL_TABLES[schema]?.includes(table)) {
    return { schema, table, physical: `${schema}_${table}`, file: 'journal' };
  }
  return undefined;
}

/** All logical vault-file entity names, `schema.table`. */
export function listVaultEntities(): string[] {
  return Object.entries(VAULT_TABLES).flatMap(([schema, tables]) =>
    tables.map((t) => `${schema}.${t}`),
  );
}
