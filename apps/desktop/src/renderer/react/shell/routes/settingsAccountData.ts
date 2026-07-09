import {
  vaultConnections,
  vaultConnectionSetStatus,
  vaultImportDiscard,
  vaultImportPublish,
  vaultImportRows,
  vaultImportsList,
  vaultImportStage,
  vaultStatus,
} from '../../../gateway-client.js';
import type { ImportBridgeProps, PhoneBridgeProps } from '../../bridge.js';

// Account-page data — ports the Phone (app-phone.ts) + Import (app-import.ts)
// bridge callback wiring for the Settings Account pages. Phone talks to the
// main process (the tunnel endpoint outlives renderer reloads); Import goes
// through the vault plane. Returned prop objects drop straight into the
// existing PhoneScreen / ImportScreen.

export function phoneCallbacks(showToast: (m: string) => void): PhoneBridgeProps {
  return {
    showToast,
    beginPairing: async (onPaired) => {
      const pairing = await window.CentraidApi.beginPhonePairing().catch(() => undefined);
      if (!pairing) return null;
      const stop = window.CentraidApi.onPhonePaired(({ device }) => {
        stop();
        onPaired(device.name);
      });
      return {
        cancel: () => {
          stop();
          void window.CentraidApi.cancelPhonePairing();
        },
        info: { expiresAt: pairing.expiresAt, qrDataUrl: pairing.qrDataUrl },
      };
    },
    loadStatus: async () => {
      const s = await window.CentraidApi.getPhoneLinkStatus().catch(() => undefined);
      if (!s) return null;
      return {
        devices: s.devices.map((d) => ({
          addedAt: d.addedAt,
          deviceId: d.deviceId,
          endpointId: d.endpointId,
          name: d.name,
          platform: d.platform,
        })),
        error: s.error,
        running: s.running,
      };
    },
    revoke: async (deviceId) => {
      const result = await window.CentraidApi.revokePhoneDevice({ deviceId }).catch(() => undefined);
      return !!result?.removed;
    },
  };
}

export function importCallbacks(showToast: (m: string) => void): ImportBridgeProps {
  return {
    showToast,
    discard: (batchId) => vaultImportDiscard(batchId).then(() => undefined),
    loadData: async () => {
      const s = await vaultStatus().catch(() => undefined);
      if (!s) return null;
      const [batches, connections] = await Promise.all([
        vaultImportsList(),
        vaultConnections().catch(() => []),
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
    stage: async (payload) => {
      const staged = await vaultImportStage(payload);
      return staged.total;
    },
  };
}
