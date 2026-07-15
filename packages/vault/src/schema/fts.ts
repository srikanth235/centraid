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
import { sealedColumnsOf } from './sealed.js';

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

export interface FtsEntitySpec {
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
    deletedColumn: 'deleted_at',
  },
  {
    // Documents are searched under their OWN identity, not the raw content
    // item (issue #352): title lives on core_document, body decodes through
    // whichever content item is current. blob.ts overrides this spec's
    // triggers to be derivative-aware (extracted PDF/scan text wins over the
    // raw decode), same as it always did for the parent row.
    entity: 'core.document',
    idColumn: 'document_id',
    columns: [
      { name: 'title', kind: 'column' },
      { name: 'body', kind: 'content', fk: 'current_content_id' },
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
    ],
  },
  {
    // Owner memos (issue #274): the running note about a person, the remark
    // on a workout — annotations on canonical entities, searchable as text.
    entity: 'knowledge.annotation',
    idColumn: 'annotation_id',
    columns: [{ name: 'body_text', kind: 'column' }],
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
  {
    // Disposed items stay in the index — disposal keeps the row as history,
    // and "where did that old dehumidifier go" is exactly a search question.
    entity: 'home.asset_item',
    idColumn: 'item_id',
    columns: [
      { name: 'name', kind: 'column' },
      { name: 'serial_no', kind: 'column' },
    ],
  },
  {
    // The CRM person's role line ("Eng lead · Portland") — the third search
    // surface People folds in beyond the party's name (core.party) and the
    // owner's running notes (knowledge.annotation).
    entity: 'people.profile',
    idColumn: 'profile_id',
    columns: [{ name: 'role', kind: 'column' }],
  },
  {
    // The locker's non-secret face (issue #310 C6): title, username, url.
    // Sealed columns structurally cannot feed the index — the gate below
    // throws at DDL-build time (issue #293) — and `notes` stays out
    // deliberately: it routinely carries recovery codes.
    entity: 'locker.item',
    idColumn: 'item_id',
    columns: [
      { name: 'title', kind: 'column' },
      { name: 'username', kind: 'column' },
      { name: 'url', kind: 'column' },
    ],
    deletedColumn: 'deleted_at',
  },
  {
    // "That dinner at Olive we split" is a search question (issue #310 C6).
    entity: 'tally.expense',
    idColumn: 'expense_id',
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

/**
 * Per-document index budget (issue #367 §E3): a body can be arbitrarily
 * large (a pasted transcript, an imported email, an extracted PDF's text
 * layer), but the FTS shadow tables are a SEARCH index, not a second copy
 * of the canonical bytes — the canonical body/derivative stays complete and
 * untruncated; only what feeds the index is capped. Generous by design
 * (256KB covers the overwhelming majority of real bodies whole); anything
 * past it is still searchable up to the cut, just not beyond it.
 */
export const FTS_BODY_INDEX_BUDGET_CHARS = 256 * 1024;

const TRUNCATION_MARKER = ' ...(truncated for search index)';

/**
 * Wrap a body-text SQL expression so it never feeds more than `budgetChars`
 * into the index. `expr` is inlined twice (length check + substr) — fine
 * for a trigger that runs once per write, and keeps this a pure SQL
 * expression with no bound parameters (trigger bodies are static DDL).
 */
export function truncateForIndex(
  expr: string,
  budgetChars: number = FTS_BODY_INDEX_BUDGET_CHARS,
): string {
  return `(CASE WHEN ${expr} IS NULL THEN NULL
                 WHEN length(${expr}) > ${budgetChars}
                 THEN substr(${expr}, 1, ${budgetChars}) || '${TRUNCATION_MARKER}'
                 ELSE ${expr} END)`;
}

/** Value expression for one indexed column, `prefix` = `new` or a base alias. */
function valueExpr(column: FtsColumn, prefix: string): string {
  if (column.kind === 'column') return `${prefix}."${column.name}"`;
  if (column.kind === 'self-content') {
    return truncateForIndex(`vault_content_text(${prefix}."media_type", ${prefix}."content_uri")`);
  }
  return truncateForIndex(`(SELECT vault_content_text(media_type, content_uri) FROM core_content_item
            WHERE content_id = ${prefix}."${column.fk}")`);
}

/**
 * The structural FTS gate (issue #293): a sealed column can never feed a
 * text index, whatever a spec declares — the throw happens at DDL-build
 * time, so a bad declaration fails the migration, not the audit.
 */
export function assertNoSealedFtsColumns(spec: FtsEntitySpec): void {
  const sealed = sealedColumnsOf(spec.entity);
  if (sealed.length === 0) return;
  for (const col of spec.columns) {
    const name = col.kind === 'column' ? col.name : col.kind === 'content' ? col.fk : 'content_uri';
    if (sealed.includes(name)) {
      throw new Error(
        `fts spec for ${spec.entity} names sealed column "${name}" — sealed columns are never indexed (issue #293)`,
      );
    }
  }
}

function insertColumnsOf(spec: FtsEntitySpec): string {
  return ['rowid', spec.idColumn, ...spec.columns.map((c) => c.name)].join(', ');
}

function valuesOf(spec: FtsEntitySpec, prefix: string): string {
  return [
    `${prefix}.rowid`,
    `${prefix}."${spec.idColumn}"`,
    ...spec.columns.map((c) => valueExpr(c, prefix)),
  ].join(', ');
}

/** Soft-deleted rows leave the index — the WHERE guard shared by every path that (re)builds it. */
function liveGuardOf(spec: FtsEntitySpec, prefix: string): string {
  return spec.deletedColumn ? ` WHERE ${prefix}."${spec.deletedColumn}" IS NULL` : '';
}

/**
 * The full-table backfill: every live row's current value, re-derived.
 * Shared by the migration DDL (backfilling a pre-index vault) and
 * `rebuildFtsIndex` (re-deriving after e.g. `FTS_BODY_INDEX_BUDGET_CHARS`
 * changes) — same statement, same truncation policy, one definition.
 */
function backfillStatement(spec: FtsEntitySpec): string {
  const base = physical(spec.entity);
  const fts = `fts_${base}`;
  return `INSERT INTO ${fts}(${insertColumnsOf(spec)})
SELECT ${valuesOf(spec, 'b')} FROM ${base} b${liveGuardOf(spec, 'b')};`;
}

function entityDdl(spec: FtsEntitySpec): string {
  assertNoSealedFtsColumns(spec);
  const base = physical(spec.entity);
  const fts = `fts_${base}`;
  const ftsColumns = [`${spec.idColumn} UNINDEXED`, ...spec.columns.map((c) => c.name)];
  const insertColumns = insertColumnsOf(spec);
  const insertRow = `INSERT INTO ${fts}(${insertColumns}) SELECT ${valuesOf(spec, 'new')}${liveGuardOf(spec, 'new')};`;
  // detail= tuning (issue #367 §E3): left at the FTS5 default, detail=full.
  // detail=column/none shrink the index by dropping per-term POSITION data,
  // but snippet()/highlight() degrade to whole-column matches without it —
  // the owner-facing search surface (issue #274) uses snippet() for match
  // context, so that quality loss isn't free. The size problem detail=
  // would address is now handled at the source instead: the per-document
  // budget above bounds how much text ever reaches the index, and journal
  // archival (journal-archive.ts) keeps the OTHER fast-growing file small —
  // so detail=full's extra position data no longer has an unbounded body to
  // multiply against. Revisit only with evidence the index itself (not the
  // bodies feeding it) is the dominant cost.
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
${backfillStatement(spec)}
`;
}

/**
 * Migration rung: shadow tables, sync triggers, and a backfill of whatever
 * rows a pre-index vault already holds (a no-op on fresh files).
 */
export const FTS_DDL: string = SPECS.map(entityDdl).join('\n');

const SPEC_BY_ENTITY: ReadonlyMap<string, FtsEntitySpec> = new Map(SPECS.map((s) => [s.entity, s]));

/**
 * Rebuild path (issue #367 §E3): the index is derived and rebuildable — if
 * `FTS_BODY_INDEX_BUDGET_CHARS` (or a spec) changes, existing indexed rows
 * still carry the OLD truncation, since FTS5's own `('rebuild')` command
 * only re-derives the internal index structures from what fts5 itself
 * already stored, not from the base tables. This re-runs the real backfill
 * (delete + re-derive from the base table) so a budget change actually
 * reflows every live row.
 *
 * `core.document` is NOT covered here — schema/blob.ts overrides its
 * triggers with a derivative-aware body expression (extracted text wins
 * over the raw decode); use `rebuildDocumentFtsIndex` (blob.ts) for it.
 */
export function rebuildFtsIndex(vault: DatabaseSync, entity: string): void {
  if (entity === 'core.document') {
    throw new Error(
      'core.document has a derivative-aware FTS rebuild — use rebuildDocumentFtsIndex from schema/blob.js',
    );
  }
  const spec = SPEC_BY_ENTITY.get(entity);
  if (!spec) throw new Error(`not a searchable entity: ${entity}`);
  const fts = `fts_${physical(spec.entity)}`;
  vault.exec(`DELETE FROM ${fts};`);
  vault.exec(backfillStatement(spec));
}
