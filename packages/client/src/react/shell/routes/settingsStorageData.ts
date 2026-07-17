import {
  attachVaultStorageConnection,
  confirmGatewayRecoveryKit,
  createStorageConnection as gwCreateStorageConnection,
  deleteStorageConnection as gwDeleteStorageConnection,
  detachVaultStorageConnection,
  getVaultBlobStore,
  listStorageConnections,
  ProviderNotHomeProfileError,
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

// Settings → Storage data layer (issue #436 §7): maps the gateway's storage
// surface onto the collapsed hosted-vs-local screen. There is exactly ONE
// connection model now — the managed provider "home" bundle (snapshots + cas +
// derived). This layer also hosts the recovery-kit-aware and home-profile-aware
// result shapes so the screen never imports the gateway error classes to tell
// "blocked by the gate" from "not a valid home" from "just failed".

function toRowDTO(c: StorageConnectionDTO): StorageConnectionRowDTO {
  return { id: c.id, name: c.name, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) };
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
    const connection = await gwCreateStorageConnection(
      { kind: 'provider', name: input.name, baseUrl: input.baseUrl, apiKey: input.apiKey },
      opts,
    );
    return { ok: true, value: toRowDTO(connection) };
  } catch (err) {
    if (err instanceof RecoveryKitNotConfirmedError) {
      return { ok: false, code: 'recovery_kit_not_confirmed', message: err.message };
    }
    if (err instanceof ProviderNotHomeProfileError) {
      const missing =
        err.missingCapabilities.length > 0
          ? ` It’s missing: ${err.missingCapabilities.join(', ')}.`
          : '';
      return {
        ok: false,
        code: 'error',
        message: `This provider can’t be a home for your data.${missing} A home needs to keep snapshots, store your sealed files, meter usage, and prove restores work.`,
      };
    }
    return { ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A real, irreversible delete — confirm-gated the same way Connections'
 * remove action is. Deleting the home connection doesn't touch any bytes
 * already replicated — it only removes the gateway's pointer + sealed
 * credential — but it's still a "you'll need to reconnect to undo this"
 * action, so it gets the same confirm step as any other delete in this app.
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
      confirmLabel: 'Disconnect',
      danger: true,
      message: `Disconnect "${name}"? This removes the provider and its saved credential from this gateway. It doesn't touch any bytes already stored — but you'll need to reconnect to use hosted storage again.`,
      title: 'Disconnect storage provider?',
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

/** Revert to on-device storage (`blob_store: {kind: 'fs'}`) — never gated by
 *  the recovery kit (going local-only is always safe). */
export async function detachVaultConnection(): Promise<VaultBlobStoreDTO> {
  const settings = await detachVaultStorageConnection();
  return settings.kind === 's3'
    ? { kind: 's3', ...(settings.connectionId ? { connectionId: settings.connectionId } : {}) }
    : { kind: 'fs' };
}
