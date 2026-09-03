export interface SnapshotScope {
  mode: "snapshot";
  itemIds: string[];
}

export type EdgeScope = SnapshotScope;

export class ShareScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareScopeError";
  }
}

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
