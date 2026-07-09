// The Import settings page (issue #290 phase 2) — the owner's file-drop
// surface over the staging spine. Drop a .ics / .vcf / .mbox / .csv / Takeout
// .zip; the gateway stages it into a draft batch with per-row dispositions
// (create / update / skip); the owner reviews the diff and publishes or
// discards. First contact with real data is always staged — publish is the
// deliberate second act. The React ImportScreen owns the view (drop zone, diff
// preview, publish/discard); this module threads the gateway I/O through its
// bridge callbacks.

import {
  vaultConnectionSetStatus,
  vaultConnections,
  vaultImportDiscard,
  vaultImportPublish,
  vaultImportRows,
  vaultImportStage,
  vaultImportsList,
  vaultStatus,
  type VaultConnection,
} from './gateway-client.js';
import { requireReactBridge } from './react/bridge.js';

export interface ImportPageInput {
  el: ElHelper;
  host: HTMLElement;
  showToast?: (message: string) => void;
}

// Tracks the React root mounted on a host so a re-render disposes the prior one.
const importReactDisposers = new WeakMap<HTMLElement, () => void>();

/** Populate the Import pane. Re-renders itself after every act. */
export async function renderImportPage(input: ImportPageInput): Promise<void> {
  const { host } = input;
  importReactDisposers.get(host)?.();
  const dispose = requireReactBridge().mountImport(host, {
    discard: (batchId) => vaultImportDiscard(batchId).then(() => undefined),
    loadData: async () => {
      const s = await vaultStatus().catch(() => undefined);
      if (!s) return null;
      const [batches, connections] = await Promise.all([
        vaultImportsList(),
        vaultConnections().catch(() => [] as VaultConnection[]),
      ]);
      return {
        batches: batches.map((b) => ({
          batchId: b.batchId,
          createdAt: b.createdAt,
          kind: b.kind,
          label: b.label,
          status: b.status,
          summary: b.summary,
        })),
        connections: connections.map((c) => ({
          connectionId: c.connectionId,
          kind: c.kind,
          label: c.label,
          lastRunAt: c.lastRunAt,
          lastRunError: c.lastRun?.error ?? null,
          principal: c.principal,
          status: c.status,
        })),
        vaultName: s.name,
      };
    },
    loadRows: async (batchId) => {
      const rows = await vaultImportRows(batchId);
      return rows.map((r) => ({
        disposition: r.disposition,
        entityType: r.entityType,
        externalId: r.externalId,
        note: r.note,
      }));
    },
    publish: (batchId) => vaultImportPublish(batchId).then(() => undefined),
    setConnectionStatus: (connectionId, next) =>
      vaultConnectionSetStatus(connectionId, next).then(() => undefined),
    showToast: input.showToast,
    stage: async (payload) => {
      const staged = await vaultImportStage(payload);
      return staged.total;
    },
  });
  importReactDisposers.set(host, dispose);
}
