// The text-search plane: one FTS5 shadow table per text-bearing entity, kept
// in sync by AFTER INSERT/UPDATE/DELETE triggers on the base table. Search
// stays inside SQLite — the gateway's `search` walks the same consent
// pipeline as `read` but resolves matches through the index instead of
// shipping whole tables to callers (there is no upper bound on vault data).
//
// Canonical note/message bodies are not prose columns — they are data: URIs
// on the referenced core.content_item (rent the bytes, own the reference).
// Triggers therefore decode through `vault_content_text`, an app-defined
// function `openVaultDb` registers on every vault connection before
// migrations run. Only the gateway holds connections (§10), so the function
// is always present when a trigger fires.

import type { DatabaseSync } from 'node:sqlite';

/** Decoded text of a canonical body, or null for anything non-text. */
export function contentText(mediaType: unknown, contentUri: unknown): string | null {
  if (typeof mediaType !== 'string' || !mediaType.startsWith('text/')) return null;
  if (typeof contentUri !== 'string' || !contentUri.startsWith('data:')) return null;
  const comma = contentUri.indexOf(',');
  if (comma < 0) return null;
  const meta = contentUri.slice(0, comma);
  const payload = contentUri.slice(comma + 1);
  try {
    return meta.includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** Register `vault_content_text` on a vault connection (triggers call it). */
export function registerContentTextFn(db: DatabaseSync): void {
  db.function('vault_content_text', { deterministic: true }, contentText);
}

type FtsColumn =
  /** A text column of the base table itself. */
  | { name: string; kind: 'column' }
  /** Decoded body of the core.content_item the base row references via `fk`. */
  | { name: string; kind: 'content'; fk: string }
  /** core.content_item indexing its own uri (text media only). */
  | { name: string; kind: 'self-content' };

interface FtsEntitySpec {
  /** Logical entity, e.g. `knowledge.note`. */
  entity: string;
  /** Base-table PK, mirrored UNINDEXED into the fts table for joins. */
  idColumn: string;
  columns: FtsColumn[];
  /** Column that, when non-null, keeps the row out of the index (soft delete). */
  deletedColumn?: string;
}

const SPECS: readonly FtsEntitySpec[] = [
  {
    entity: 'knowledge.note',
    idColumn: 'note_id',
    columns: [
      { name: 'title', kind: 'column' },
      { name: 'body', kind: 'content', fk: 'body_content_id' },
    ],
  },
  {
    // Canonical bytes double as the documents surface: title + text bodies.
    entity: 'core.content_item',
    idColumn: 'content_id',
    columns: [
      { name: 'title', kind: 'column' },
      { name: 'body', kind: 'self-content' },
    ],
    deletedColumn: 'deleted_at',
  },
  {
    entity: 'social.thread',
    idColumn: 'thread_id',
    columns: [{ name: 'subject', kind: 'column' }],
  },
  {
    entity: 'social.message',
    idColumn: 'message_id',
    columns: [{ name: 'body', kind: 'content', fk: 'body_content_id' }],
  },
  {
    entity: 'core.party',
    idColumn: 'party_id',
    columns: [
      { name: 'display_name', kind: 'column' },
      { name: 'sort_name', kind: 'column' },
    ],
  },
  {
    entity: 'social.contact_card',
    idColumn: 'card_id',
    columns: [
      { name: 'nickname', kind: 'column' },
      { name: 'org_title', kind: 'column' },
      { name: 'note', kind: 'column' },
    ],
  },
  {
    entity: 'schedule.task',
    idColumn: 'task_id',
    columns: [
      { name: 'title', kind: 'column' },
      { name: 'description', kind: 'column' },
    ],
  },
  {
    entity: 'core.event',
    idColumn: 'event_id',
    columns: [
      { name: 'summary', kind: 'column' },
      { name: 'description', kind: 'column' },
    ],
  },
  {
    entity: 'core.transaction',
    idColumn: 'txn_id',
    columns: [{ name: 'description', kind: 'column' }],
  },
];

/** What the gateway needs to run (and consent-clamp) a search. */
export interface SearchableEntity {
  /** Physical FTS5 table. */
  fts: string;
  /** Base-table PK column (also the fts join column). */
  idColumn: string;
  /**
   * Base-table columns feeding the index. A grant field mask that hides any
   * of them fails a search closed — the index must never answer over text
   * the grant does not let the caller read.
   */
  maskColumns: readonly string[];
  /**
   * Entities whose content the index folds in beyond the base row (canonical
   * bodies). Each needs its own read consent before a search runs.
   */
  alsoConsent: readonly string[];
}

function physical(entity: string): string {
  return entity.replace('.', '_');
}

function maskColumnsOf(spec: FtsEntitySpec): string[] {
  return spec.columns.map((c) =>
    c.kind === 'column' ? c.name : c.kind === 'content' ? c.fk : 'content_uri',
  );
}

/** Logical entity → its search surface. Absence = not text-searchable. */
export const SEARCHABLE: Readonly<Record<string, SearchableEntity>> = Object.fromEntries(
  SPECS.map((spec) => [
    spec.entity,
    {
      fts: `fts_${physical(spec.entity)}`,
      idColumn: spec.idColumn,
      maskColumns: maskColumnsOf(spec),
      alsoConsent: spec.columns.some((c) => c.kind === 'content') ? ['core.content_item'] : [],
    },
  ]),
);

/** Value expression for one indexed column, `prefix` = `new` or a base alias. */
function valueExpr(column: FtsColumn, prefix: string): string {
  if (column.kind === 'column') return `${prefix}."${column.name}"`;
  if (column.kind === 'self-content') {
    return `vault_content_text(${prefix}."media_type", ${prefix}."content_uri")`;
  }
  return `(SELECT vault_content_text(media_type, content_uri) FROM core_content_item
            WHERE content_id = ${prefix}."${column.fk}")`;
}

function entityDdl(spec: FtsEntitySpec): string {
  const base = physical(spec.entity);
  const fts = `fts_${base}`;
  const ftsColumns = [`${spec.idColumn} UNINDEXED`, ...spec.columns.map((c) => c.name)];
  const insertColumns = ['rowid', spec.idColumn, ...spec.columns.map((c) => c.name)].join(', ');
  const values = (prefix: string) =>
    [`${prefix}.rowid`, `${prefix}."${spec.idColumn}"`, ...spec.columns.map((c) => valueExpr(c, prefix))].join(
      ', ',
    );
  // Soft-deleted rows leave the index; INSERT … SELECT … WHERE carries the
  // guard for both the insert and update triggers.
  const liveGuard = (prefix: string) =>
    spec.deletedColumn ? ` WHERE ${prefix}."${spec.deletedColumn}" IS NULL` : '';
  const insertRow = `INSERT INTO ${fts}(${insertColumns}) SELECT ${values('new')}${liveGuard('new')};`;
  return `
CREATE VIRTUAL TABLE ${fts} USING fts5(
  ${ftsColumns.join(', ')},
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER ${fts}_ai AFTER INSERT ON ${base} BEGIN
  ${insertRow}
END;
CREATE TRIGGER ${fts}_au AFTER UPDATE ON ${base} BEGIN
  DELETE FROM ${fts} WHERE rowid = old.rowid;
  ${insertRow}
END;
CREATE TRIGGER ${fts}_ad AFTER DELETE ON ${base} BEGIN
  DELETE FROM ${fts} WHERE rowid = old.rowid;
END;
INSERT INTO ${fts}(${insertColumns})
SELECT ${values('b')} FROM ${base} b${liveGuard('b')};
`;
}

/**
 * Migration rung: shadow tables, sync triggers, and a backfill of whatever
 * rows a pre-index vault already holds (a no-op on fresh files).
 */
export const FTS_DDL: string = SPECS.map(entityDdl).join('\n');
