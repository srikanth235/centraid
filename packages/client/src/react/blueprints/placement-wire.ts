export function toPlacementStatus(status: unknown): string {
  return status === "completed" || status === "established"
    ? "executed"
    : typeof status === "string"
      ? status
      : "failed";
}

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
