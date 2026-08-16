/*
 * An edge's SCOPE, parsed rather than asserted (issue #750 abstraction 5).
 *
 * `scope_json` used to reach the reconcilers and the receipt writer as
 * `JSON.parse(row.scope_json ?? "[]") as string[]` — a cast, in four places,
 * over a column that a receipt then records as durable audit. A row whose
 * scope was `null`, `{}`, `[1, 2]` or `[""]` produced an empty or nonsense
 * receipt SILENTLY, which is precisely the failure a durable access audit
 * exists to prevent.
 *
 * This module is the total parser that replaces the cast. Malformed input is
 * refused loudly (a thrown `ShareScopeError`, which the edge plane turns into
 * a parked edge with a reason) rather than degraded into an empty set.
 *
 * The payload is a DISCRIMINATED union on `mode` even though `mode` admits
 * exactly one value today: live lending was removed in #731 and the
 * `share_edges` CHECK constraint is what keeps it structurally absent, so the
 * absence is asserted at the boundary here too. Nothing in this file re-adds
 * a live scope — a snapshot scope is a fixed, non-empty set of item ids, and
 * that is the only shape an edge can carry.
 */

export interface SnapshotScope {
  mode: "snapshot";
  /** Non-empty, de-duplicated, first-occurrence order — a SET, not a log. */
  itemIds: string[];
}

export type EdgeScope = SnapshotScope;

export class ShareScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareScopeError";
  }
}

/**
 * Parse a `share_edges.scope_json` value for a given `mode`. Total: every
 * input either yields a validated scope or throws `ShareScopeError`.
 */
export function parseEdgeScope(
  mode: string,
  scopeJson: string | null
): EdgeScope {
  if (mode !== "snapshot") {
    throw new ShareScopeError(
      `unknown edge mode ${JSON.stringify(mode)}; live lending was removed in issue #731`
    );
  }
  if (scopeJson === null) {
    throw new ShareScopeError("a snapshot edge must carry a scope");
  }
  return { mode: "snapshot", itemIds: parseItemIds(scopeJson) };
}

/** The same validation over an already-decoded value — the wire-input door. */
export function validateItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ShareScopeError("itemIds must be a non-empty array");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ShareScopeError(`itemIds[${index}] must be a non-empty string`);
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function parseItemIds(scopeJson: string): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(scopeJson);
  } catch {
    throw new ShareScopeError("scope_json is not valid JSON");
  }
  return validateItemIds(decoded);
}

/** The audience-side item ids an executed edge recorded, same total posture. */
export function parseTargetItemIds(json: string | null): string[] {
  if (json === null) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new ShareScopeError("target_item_ids_json is not valid JSON");
  }
  if (!Array.isArray(decoded)) {
    throw new ShareScopeError("target_item_ids_json must be an array");
  }
  return decoded.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ShareScopeError(
        `target_item_ids_json[${index}] must be a non-empty string`
      );
    }
    return entry;
  });
}
