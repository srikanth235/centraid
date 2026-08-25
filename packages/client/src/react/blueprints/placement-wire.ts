// The `/placements` → `/edges` wire translation `centraid-inline.ts`'s
// `place()` needs (#726). `place()`'s result shape is the `/placements`
// vocabulary, and callers read `result.status === "executed"` /
// `result.reason` — this module is the whole translation, and the only place
// the two vocabularies are allowed to meet.

/**
 * `/edges` answers queued|in-flight|established|parked|denied|revoked|
 * completed|failed; `/placements` callers check for `executed`. Translate the
 * one terminal-success value and pass every other value through unchanged.
 */
export function toPlacementStatus(status: unknown): string {
  return status === "completed" || status === "established"
    ? "executed"
    : typeof status === "string"
      ? status
      : "failed";
}

/** Fold one `/edges` response (always one item, from this facade) back into
 *  the `/placements` wire shape every existing `place()` caller still reads. */
export function placementWireFromEdge(
  edge: Record<string, unknown>,
  opts: {
    linkToken: string;
    kind: string;
    itemType: string;
    itemId: string;
    sourceVaultId: string;
    targetVaultId: string;
  }
): Record<string, unknown> {
  return {
    linkToken: opts.linkToken,
    kind: opts.kind,
    itemType: opts.itemType,
    itemId: opts.itemId,
    sourceVaultId: opts.sourceVaultId,
    targetVaultId: opts.targetVaultId,
    status: toPlacementStatus(edge.status),
    ...(typeof edge.reason === "string" ? { reason: edge.reason } : {}),
    ...(typeof edge.accessReceiptId === "string"
      ? { accessReceiptId: edge.accessReceiptId }
      : {}),
    createdAt: edge.createdAt,
    updatedAt: edge.updatedAt,
  };
}
