import {
  getStorageStatus,
  getStorageUsage,
  listStorageConnections,
} from '../../../gateway-client.js';
import type { StorageCardStatusDTO } from '../../screens/StorageCard.js';

// Storage card data layer (issue #367 §D3) — stitches three independent
// gateway reads (connections, per-connection usage, per-vault replication
// status) into the one DTO the card renders. Kept out of the screen itself
// so StorageCard.tsx stays prop-driven and testable with plain mocks, same
// split BackupCard/gatewayData.ts already established.

export async function loadStorageCardStatus(): Promise<StorageCardStatusDTO> {
  const [connections, usage, vaults] = await Promise.all([
    listStorageConnections(),
    getStorageUsage(),
    getStorageStatus(),
  ]);
  const usageByConnection = new Map(usage.map((u) => [u.connectionId, u]));

  return {
    connections: connections.map((c) => {
      const u = usageByConnection.get(c.id);
      return {
        id: c.id,
        kind: c.kind,
        name: c.name,
        uses: c.uses,
        providerReported: u?.providerReported ?? null,
        localReplicatedBytes: u?.localReplicatedBytes ?? 0,
        ...(u?.fetchedAt ? { fetchedAt: u.fetchedAt } : {}),
        ...(u?.error ? { error: u.error } : {}),
      };
    }),
    vaults: vaults.map((v) => ({
      vaultId: v.vaultId,
      name: v.name,
      configured: v.configured,
      ...(v.connectionId ? { connectionId: v.connectionId } : {}),
      replicated: v.replicated,
      backlog: v.backlog,
      lastSweep: {
        completedAt: v.lastSweep.completedAt,
        error: v.lastSweep.error,
        consecutiveFailures: v.lastSweep.consecutiveFailures,
      },
    })),
  };
}
