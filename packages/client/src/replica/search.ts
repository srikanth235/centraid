import { OnlineOnlyError, ReplicaProtocolError } from './errors.js';

/** A replica-local search surface composed only from eager scalar row metadata. */
export interface ReplicaLocalSearchSpec {
  columns: readonly string[];
  /** Non-null rows are absent from the canonical FTS index. */
  deletedColumn?: string;
}

/**
 * Direct-column subset of the canonical vault FTS contract. A folded document
 * BODY stays online-only (its bytes are not eager replica metadata), but the
 * document TITLE is an eager scalar on core.document, so the native Docs drive
 * can rank titles offline; a body match still needs the canonical FTS online.
 */
export const REPLICA_LOCAL_SEARCH: Readonly<Record<string, ReplicaLocalSearchSpec>> = {
  'core.content_item': { columns: ['title'], deletedColumn: 'deleted_at' },
  'core.document': { columns: ['title'], deletedColumn: 'deleted_at' },
  'social.thread': { columns: ['subject'] },
  'core.party': { columns: ['display_name', 'sort_name'] },
  'social.contact_card': { columns: ['nickname', 'org_title'] },
  'knowledge.annotation': { columns: ['body_text'] },
  'schedule.task': { columns: ['title', 'description'] },
  'core.event': { columns: ['summary', 'description'] },
  'core.transaction': { columns: ['description'] },
  'home.asset_item': { columns: ['name', 'serial_no'] },
  'people.profile': { columns: ['role'] },
  'locker.item': { columns: ['title', 'username', 'url'], deletedColumn: 'deleted_at' },
  'tally.expense': { columns: ['description'] },
};

export function replicaLocalSearchSpec(entity: string): ReplicaLocalSearchSpec {
  const spec = REPLICA_LOCAL_SEARCH[entity];
  if (!spec) {
    throw new OnlineOnlyError(
      `entity ${entity} has no complete eager-metadata search surface in the replica`,
    );
  }
  return spec;
}

/** Mirrors the canonical gateway's fixed FTS grammar and 16-token bound. */
export function replicaFtsMatchExpression(query: string): string {
  if (typeof query !== 'string') throw new ReplicaProtocolError('Search query must be a string');
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replaceAll('"', ''))
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .slice(0, 16);
  if (tokens.length === 0) {
    throw new ReplicaProtocolError('Search query has no searchable words');
  }
  return tokens.map((token) => `"${token}"*`).join(' ');
}

export function replicaSearchRequiredColumns(spec: ReplicaLocalSearchSpec): string[] {
  return [...spec.columns, ...(spec.deletedColumn ? [spec.deletedColumn] : [])];
}
