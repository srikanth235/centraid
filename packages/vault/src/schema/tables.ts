// Logical ↔ physical name registry. The ontology speaks schema-qualified
// logical names (`core.party`) — grants, receipts, links and polymorphic refs
// all store them. SQLite has no namespaces, so physical tables are
// underscore-joined (`core_party`). The gateway translates through this
// registry only, which doubles as an allow-list: unknown entity names never
// reach SQL.
//
// The registry has a static half (the canonical ontology below) and a
// dynamic half (issue #286 phase 2): app-declared ext-band tables recorded
// in `consent_app_ext`. Callers that pass their vault handle resolve both;
// without a handle only the canonical model resolves.

import type { DatabaseSync } from 'node:sqlite';
import { parseExtLogical } from './ext.js';

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
    'content_derivative',
    'document',
    'attachment',
    'activity',
    'observation',
    'observation_component',
    'link',
    'link_anchor',
    'concept_scheme',
    'concept',
    'tag',
    'collection',
    'collection_entry',
  ],
  consent: [
    'app',
    'app_ext',
    'app_view',
    'access_grant',
    'grant_scope',
    'scope_tombstone',
    'scope_request',
    'share',
    'policy',
    'device',
    'export_job',
    'seed_row',
  ],
  agent: ['agent', 'command', 'capability', 'correction', 'judgment'],
  health: ['vital', 'workout', 'sleep_session', 'medication_course', 'condition'],
  finance: ['txn_split', 'budget', 'holding', 'recurring_series', 'fx_rate'],
  schedule: ['calendar', 'event_ext', 'attendee', 'task', 'availability_rule'],
  social: ['contact_card', 'circle', 'circle_member', 'thread', 'thread_participant', 'message'],
  knowledge: ['note', 'annotation'],
  media: ['media_asset', 'face_region', 'asset_phash'],
  home: ['asset_item', 'warranty', 'maintenance_plan', 'utility_meter', 'meter_reading'],
  business: ['client', 'project', 'time_entry', 'invoice', 'invoice_line'],
  people: [
    'profile',
    'interaction',
    'task',
    'important_date',
    'relationship',
    'gift',
    'debt',
    'journal_entry',
  ],
  locker: ['item'],
  sync: [
    'connection',
    'external_entity',
    'import_batch',
    'import_row',
    'connection_cursor',
    'connection_run',
    'connection_credential',
    'connection_health',
  ],
  tally: ['friend', 'group', 'expense', 'expense_split', 'settlement'],
  enrich: ['embedding', 'request', 'policy'],
  outbox: ['item', 'grant'],
  // Read-only custody projection (issue #352): local-vs-replicated state per
  // content item, rebuilt on the standing sweep — see blob/custody.ts.
  blob: ['custody_state'],
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
 *
 * Ext-band names (`ext.<appId>.<table>`, draft twin `extdraft.…`) resolve
 * only when the caller passes its vault handle — the dynamic half lives in
 * `consent_app_ext`. Both bands report the consent schema `ext.<appId>`:
 * the draft copy is the same data class under the same grant.
 */
export function resolveEntity(logical: string, vault?: DatabaseSync): EntityRef | undefined {
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
  const ext = parseExtLogical(logical);
  if (ext && vault) {
    try {
      const row = vault
        .prepare(
          `SELECT physical FROM consent_app_ext WHERE app_id = ? AND band = ? AND table_name = ?`,
        )
        .get(ext.appId, ext.band, ext.table) as { physical: string } | undefined;
      if (row) {
        return {
          schema: `ext.${ext.appId}`,
          table: ext.table,
          physical: row.physical,
          file: 'vault',
        };
      }
    } catch {
      // Pre-v5 file or a non-vault handle: no dynamic half to consult.
    }
  }
  return undefined;
}

/**
 * All logical vault-file entity names, `schema.table`. With a handle, the
 * live ext band is enumerated too (retained tables included — export covers
 * everything); the draft band is scratch and never enumerated.
 */
export function listVaultEntities(vault?: DatabaseSync): string[] {
  const canonical = Object.entries(VAULT_TABLES).flatMap(([schema, tables]) =>
    tables.map((t) => `${schema}.${t}`),
  );
  if (!vault) return canonical;
  try {
    const rows = vault
      .prepare(
        `SELECT app_id, table_name FROM consent_app_ext WHERE band = 'live' ORDER BY app_id, table_name`,
      )
      .all() as { app_id: string; table_name: string }[];
    return [...canonical, ...rows.map((r) => `ext.${r.app_id}.${r.table_name}`)];
  } catch {
    return canonical;
  }
}
