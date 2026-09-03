import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { SEARCHABLE } from "../schema/fts.js";
import { resolveEntity } from "../schema/tables.js";
import { evaluateAccess } from "./access.js";
import { writeReceipt } from "./evidence.js";
import { extSearchable } from "./ext.js";
import { applyFieldMask, compileFilters } from "./filters.js";
import type { Identity, SearchRequest, SearchResult } from "./types.js";
import { GatewayError } from "./types.js";

export function ftsMatchExpression(query: string): string | null {
  const tokens = query
    .split(/\s+/u)
    .map((t) => t.replaceAll('"', ""))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

export function searchEntity(
  db: VaultDb,
  identity: Identity,
  request: SearchRequest
): SearchResult {
  const deny = (failing: string, grantId: string | null = null): never => {
    const receiptId = writeReceipt(db.audit, {
      grantId,
      invocationId: null,
      action: "search",
      objectType: request.entity,
      objectId: null,
      purpose: request.purpose,
      decision: "deny",
      detail: { failing },
    });
    throw new GatewayError("access", `deny (receipt ${receiptId}): ${failing}`);
  };
  const ref = resolveEntity(request.entity, db.vault);
  if (!ref) return deny(`unknown entity ${request.entity}`);
  const spec =
    SEARCHABLE[request.entity] ?? extSearchable(db.vault, request.entity);
  if (!spec) {
    throw new GatewayError(
      "contract",
      `entity ${request.entity} is not text-searchable`
    );
  }
  const match = ftsMatchExpression(request.query);
  if (!match) {
    throw new GatewayError("contract", "search query has no searchable words");
  }

  const access = evaluateAccess(
    db.vault,
    identity,
    ref.schema,
    ref.table,
    "read",
    request.purpose
  );
  if (access.decision === "deny") return deny(access.failing, access.grantId);
  for (const extra of spec.alsoConsent) {
    const extraRef = resolveEntity(extra, db.vault);
    if (!extraRef)
      return deny(
        `search index folds in unknown entity ${extra}`,
        access.grantId
      );
    const extraConsent = evaluateAccess(
      db.vault,
      identity,
      extraRef.schema,
      extraRef.table,
      "read",
      request.purpose
    );
    if (extraConsent.decision === "deny") {
      return deny(`${extra}: ${extraConsent.failing}`, extraConsent.grantId);
    }
  }
  if (access.fieldMask !== null) {
    const hidden = spec.maskColumns.filter(
      (c) => !access.fieldMask?.includes(c)
    );
    if (hidden.length > 0) {
      return deny(
        `field mask hides indexed column(s) ${hidden.join(", ")} — search unavailable`,
        access.grantId
      );
    }
  }

  const now = nowIso();
  const grantFilter = compileFilters(
    db.vault,
    ref.physical,
    access.rowFilter,
    now,
    "b"
  );
  const callerFilter = compileFilters(
    db.vault,
    ref.physical,
    request.where ?? [],
    now,
    "b"
  );
  const select = applyFieldMask(db.vault, ref.physical, access.fieldMask, "b");
  const limit = Math.min(Math.max(request.limit ?? 100, 1), 1000);
  const rows = db.vault
    .prepare(
      `SELECT ${select}, ${spec.fts}.rank AS _rank,
              snippet(${spec.fts}, -1, '⟦', '⟧', '…', 12) AS _snippet
         FROM ${spec.fts} JOIN "${ref.physical}" b ON b."${spec.idColumn}" = ${spec.fts}."${spec.idColumn}"
        WHERE ${spec.fts} MATCH ? AND ${grantFilter.where} AND ${callerFilter.where}
        ORDER BY ${spec.fts}.rank, b."${spec.idColumn}" LIMIT ${limit}`
    )
    .all(match, ...grantFilter.params, ...callerFilter.params) as Record<
    string,
    unknown
  >[];
  const receiptId = writeReceipt(db.audit, {
    grantId: access.grantId,
    invocationId: null,
    action: "search",
    objectType: request.entity,
    objectId: null,
    purpose: request.purpose,
    decision: "allow",
    detail: {
      query: request.query,
      filter: request.where ?? [],
      rowCount: rows.length,
    },
  });
  return { rows, receiptId };
}
