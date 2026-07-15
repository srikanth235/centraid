// The search stage of the gateway: `read`'s consent pipeline over the FTS5
// shadow tables from schema/fts.ts. A search never scans a base table and
// never returns more than its LIMIT — matching happens inside SQLite, so
// callers stop pulling whole entities to grep them in memory (the vault has
// no upper bound on rows).
//
// Consent is strictly at-least-read: the base entity needs read consent; so
// does every entity whose canonical text the index folds in (note/message
// bodies live on core.content_item); and a grant field mask that hides any
// indexed column fails the whole search closed — the index must not answer
// questions the mask says the caller may not ask.

import type { VaultDb } from '../db.js';
import { nowIso } from '../ids.js';
import { SEARCHABLE } from '../schema/fts.js';
import { resolveEntity } from '../schema/tables.js';
import { evaluateConsent } from './consent.js';
import { extSearchable } from './ext.js';
import { writeReceipt } from './evidence.js';
import { applyFieldMask, compileFilters } from './filters.js';
import type { Identity, SearchRequest, SearchResult } from './types.js';
import { GatewayError } from './types.js';

/**
 * Compile owner-typed words to an FTS5 MATCH expression: every word becomes
 * a quoted prefix phrase (`"budg"*`), joined by implicit AND. Quoting makes
 * FTS operators (AND, NEAR, `-`…) literals; words with no letter or digit
 * are dropped because an empty quoted phrase is an FTS syntax error.
 * Returns null when nothing searchable remains.
 */
export function ftsMatchExpression(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replaceAll('"', ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

/** Consent-checked FTS5 search. Throws GatewayError; denials are receipted. */
export function searchEntity(
  db: VaultDb,
  identity: Identity,
  request: SearchRequest,
): SearchResult {
  const deny = (failing: string, grantId: string | null = null): never => {
    const receiptId = writeReceipt(db.journal, {
      grantId,
      invocationId: null,
      action: 'search',
      objectType: request.entity,
      objectId: null,
      purpose: request.purpose,
      decision: 'deny',
      detail: { failing },
    });
    throw new GatewayError('consent', `deny (receipt ${receiptId}): ${failing}`);
  };
  const ref = resolveEntity(request.entity, db.vault);
  if (!ref) return deny(`unknown entity ${request.entity}`);
  const spec =
    ref.file === 'vault'
      ? (SEARCHABLE[request.entity] ?? extSearchable(db.vault, request.entity))
      : undefined;
  if (!spec) {
    throw new GatewayError('contract', `entity ${request.entity} is not text-searchable`);
  }
  const match = ftsMatchExpression(request.query);
  if (!match) {
    throw new GatewayError('contract', 'search query has no searchable words');
  }

  const consent = evaluateConsent(
    db.vault,
    identity,
    ref.schema,
    ref.table,
    'read',
    request.purpose,
  );
  if (consent.decision === 'deny') return deny(consent.failing, consent.grantId);
  // Folded-in canonical text needs its own read consent — matching a note
  // body IS reading core.content_item.
  for (const extra of spec.alsoConsent) {
    const extraRef = resolveEntity(extra, db.vault);
    if (!extraRef) return deny(`search index folds in unknown entity ${extra}`, consent.grantId);
    const extraConsent = evaluateConsent(
      db.vault,
      identity,
      extraRef.schema,
      extraRef.table,
      'read',
      request.purpose,
    );
    if (extraConsent.decision === 'deny') {
      return deny(`${extra}: ${extraConsent.failing}`, extraConsent.grantId);
    }
  }
  if (consent.fieldMask !== null) {
    const hidden = spec.maskColumns.filter((c) => !consent.fieldMask?.includes(c));
    if (hidden.length > 0) {
      return deny(
        `field mask hides indexed column(s) ${hidden.join(', ')} — search unavailable`,
        consent.grantId,
      );
    }
  }

  const now = nowIso();
  const grantFilter = compileFilters(db.vault, ref.physical, consent.rowFilter, now, 'b');
  const callerFilter = compileFilters(db.vault, ref.physical, request.where ?? [], now, 'b');
  const select = applyFieldMask(db.vault, ref.physical, consent.fieldMask, 'b');
  const limit = Math.min(Math.max(request.limit ?? 100, 1), 1000);
  const rows = db.vault
    .prepare(
      `SELECT ${select}, ${spec.fts}.rank AS _rank,
              snippet(${spec.fts}, -1, '⟦', '⟧', '…', 12) AS _snippet
         FROM ${spec.fts} JOIN "${ref.physical}" b ON b."${spec.idColumn}" = ${spec.fts}."${spec.idColumn}"
        WHERE ${spec.fts} MATCH ? AND ${grantFilter.where} AND ${callerFilter.where}
        ORDER BY ${spec.fts}.rank, b."${spec.idColumn}" LIMIT ${limit}`,
    )
    .all(match, ...grantFilter.params, ...callerFilter.params) as Record<string, unknown>[];
  const receiptId = writeReceipt(db.journal, {
    grantId: consent.grantId,
    invocationId: null,
    action: 'search',
    objectType: request.entity,
    objectId: null,
    purpose: request.purpose,
    decision: 'allow',
    detail: { query: request.query, filter: request.where ?? [], rowCount: rows.length },
  });
  return { rows, receiptId };
}
