// Parsed edge SCOPE, never inline casts (#750): scope_json backs durable
// access receipts, so malformed input must throw rather than degrade into
// an empty set. No live lending (#731) — snapshot only.

export class ShareScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareScopeError";
  }
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
