// The `/placements` → `/edges` wire translation `centraid-inline.ts`'s
// `place()` needs (#726 P2), extracted to keep that file under the 500-line
// cap. `place()` keeps its pre-#726-P2 signature and result shape — every
// existing caller (photos' `copyToVault`, `AudiencePlacement`, the mobile
// outbox) still reads `result.status === "executed"` / `result.reason`, so
// none of them needed an edit; this module is the whole translation.

/**
 * `/edges`' wire status vocabulary (queued|in-flight|established|parked|
 * denied|revoked|completed|failed) succeeded `/placements`' narrower one
 * (…|executed|…). Every existing caller of `place()` checks for `executed`
 * — translate the one terminal-success value it renamed, and pass every
 * other value through unchanged.
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
