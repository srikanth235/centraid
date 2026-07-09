import {
  listVaults,
  vaultConnections,
  vaultConnectionSetStatus,
  vaultImportDiscard,
  vaultImportPublish,
  vaultImportRows,
  vaultImportsList,
  vaultImportStage,
  vaultStatus,
} from '../../../gateway-client.js';
import type { ConnectionRowDTO, ImportBridgeProps, PhoneBridgeProps, ProfileRowDTO } from '../../screen-contracts.js';

// Load the Spaces page data — the vault registry (spaces) + gateway endpoints
// (connections). Derives the DTOs straight from the vault list rather than the
// vanilla toProfileView (which coupled to the profiles global + gateway state);
// the appsCount nicety is dropped for the subLine here.
export async function loadProfilesData(): Promise<{
  profiles: ProfileRowDTO[];
  connections: ConnectionRowDTO[];
}> {
  const vaultList = await listVaults()
    .then((v) => v ?? [])
    .catch(() => []);
  const activeVaultId = await window.CentraidApi.getGatewayAuth()
    .then((a) => a.vaultId ?? vaultList[0]?.vaultId ?? '')
    .catch(() => vaultList[0]?.vaultId ?? '');
  const connectionList = await window.CentraidApi.listGateways().catch(() => []);
  const activeConnectionId = await window.CentraidApi.getSettings()
    .then((s) => s.activeGatewayId)
    .catch(() => 'local');

  const profiles: ProfileRowDTO[] = vaultList.map((v) => {
    const active = v.vaultId === activeVaultId;
    const lead = (v.blurb ?? '').trim() || 'Local';
    return {
      active,
      color: v.color ?? '#4E68DD',
      icon: v.icon ?? 'Folder',
      id: v.vaultId,
      name: v.name,
      primordial: active && vaultList.length <= 1,
      subLine: lead,
    };
  });
  const connections: ConnectionRowDTO[] = connectionList.map((g) => ({
    active: g.id === activeConnectionId,
    displayName: g.displayName,
    id: g.id,
    removable: g.id !== 'local',
    sub: g.kind === 'remote' ? (g.url ?? 'Remote gateway') : 'This computer',
  }));
  return { profiles, connections };
}

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
