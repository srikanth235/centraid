import {
  attachVaultStorageConnection,
  confirmGatewayRecoveryKit,
  createStorageConnection as gwCreateStorageConnection,
  deleteStorageConnection as gwDeleteStorageConnection,
  detachVaultStorageConnection,
  getVaultBlobStore,
  listStorageConnections,
  RecoveryKitNotConfirmedError,
  testStorageConnection as gwTestStorageConnection,
  type StorageConnectionDTO,
} from '../../../gateway-client.js';
import type {
  StorageConnectionFormInput,
  StorageConnectionRowDTO,
  StorageMutationResult,
  StorageTestResult,
  VaultBlobStoreDTO,
} from '../../screens/SettingsStorageScreen.js';

// Settings → Storage data layer (issue #367 §D4): maps the gateway's
// storage-connection surface (`gateway-client-storage.ts`) onto the
// screen's own DTOs, and hosts the recovery-kit-aware result shape so the
// screen never needs to import the error class to distinguish "blocked by
// the gate" from "just failed" — see `StorageMutationResult`.

function toRowDTO(c: StorageConnectionDTO): StorageConnectionRowDTO {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    uses: c.uses,
    ...(c.endpoint ? { endpoint: c.endpoint } : {}),
    ...(c.region ? { region: c.region } : {}),
    ...(c.bucket ? { bucket: c.bucket } : {}),
    ...(c.prefix ? { prefix: c.prefix } : {}),
    ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
  };
}

export async function loadStorageConnectionsData(): Promise<StorageConnectionRowDTO[]> {
  const rows = await listStorageConnections();
  return rows.map(toRowDTO);
}

export async function createStorageConnection(
  input: StorageConnectionFormInput,
  opts?: { force?: boolean },
): Promise<StorageMutationResult<StorageConnectionRowDTO>> {
  try {
    const connection = await gwCreateStorageConnection(input, opts);
    return { ok: true, value: toRowDTO(connection) };
  } catch (err) {
    if (err instanceof RecoveryKitNotConfirmedError) {
      return { ok: false, code: 'recovery_kit_not_confirmed', message: err.message };
    }
    return { ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A real, irreversible delete — confirm-gated the same way Connections'
 * remove action is (`makeDetachConnection`, settingsConnectionsData.ts):
 * the promise-based dialog the Spaces page also uses before deleting a
 * space. Deleting a connection doesn't touch any vault's replicated
 * bytes — it only removes the gateway's pointer + sealed credential — but
 * it's still a "you'll need to re-enter credentials to undo this" action,
 * so it gets the same confirm step as any other delete in this app.
 */
export function makeDeleteStorageConnection(
  confirm: (opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>,
): (id: string, name: string) => Promise<void> {
  return async (id, name) => {
    const ok = await confirm({
      confirmLabel: 'Delete',
      danger: true,
      message: `Delete "${name}"? This removes the connection and its saved credential from this gateway. It doesn't touch any bytes already replicated — but you'll need to re-enter credentials to reattach it.`,
      title: 'Delete storage connection?',
    });
    if (!ok) return;
    await gwDeleteStorageConnection(id);
  };
}

export async function testStorageConnection(id: string): Promise<StorageTestResult> {
  return gwTestStorageConnection(id);
}

export async function confirmStorageRecoveryKit(): Promise<{ confirmedAt: number }> {
  return confirmGatewayRecoveryKit();
}

export async function loadVaultBlobStoreData(): Promise<VaultBlobStoreDTO> {
  const settings = await getVaultBlobStore();
  return settings.kind === 's3'
    ? { kind: 's3', ...(settings.connectionId ? { connectionId: settings.connectionId } : {}) }
    : { kind: 'fs' };
}

export async function attachVaultConnection(
  connectionId: string,
  opts?: { force?: boolean },
): Promise<StorageMutationResult<VaultBlobStoreDTO>> {
  try {
    const settings = await attachVaultStorageConnection(connectionId, opts);
    return {
      ok: true,
      value:
        settings.kind === 's3'
          ? {
              kind: 's3',
              ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
            }
          : { kind: 'fs' },
    };
  } catch (err) {
    if (err instanceof RecoveryKitNotConfirmedError) {
      return { ok: false, code: 'recovery_kit_not_confirmed', message: err.message };
    }
    return { ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Revert to local-only storage (`blob_store: {kind: 'fs'}`) — never gated
 *  by the recovery kit (going local-only is always safe). */
export async function detachVaultConnection(): Promise<VaultBlobStoreDTO> {
  const settings = await detachVaultStorageConnection();
  return settings.kind === 's3'
    ? { kind: 's3', ...(settings.connectionId ? { connectionId: settings.connectionId } : {}) }
    : { kind: 'fs' };
}
