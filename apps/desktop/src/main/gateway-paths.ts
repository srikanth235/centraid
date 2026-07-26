/*
 * Desktop path ownership (issue #555).
 *
 * Device state lives under Electron userData:
 *
 *   connections.json        non-secret connection registry, one row per gateway
 *   connection-secrets.bin  safeStorage ciphertext containing per-connection
 *                           iroh device keys
 *   phone-link/             this device's legacy phone-link peer registry
 *
 * Gateway state does not live here. The one local gateway uses the same
 * platformDefaultDataDir() as the CLI and OS service:
 *
 *   gateway.db  keys/  vault/  cache/  gateway-logs/
 *
 * A remote-only desktop therefore creates no per-connection directory and no
 * gateway data directory at all.
 */

import { platformDefaultDataDir } from '@centraid/gateway';
import { app } from 'electron';
import path from 'node:path';

/** Device-local id for the one gateway hosted on this machine. */
export const LOCAL_GATEWAY_ID = 'local';

/** One main-process-owned connection registry. */
export function connectionsFile(): string {
  return path.join(app.getPath('userData'), 'connections.json');
}

/** One safeStorage ciphertext for device credentials. */
export function connectionSecretsFile(): string {
  return path.join(app.getPath('userData'), 'connection-secrets.bin');
}

/** Canonical local gateway root, deliberately outside Electron userData. */
export function localGatewayDataDir(): string {
  return platformDefaultDataDir();
}

export function gatewayPrefsFile(_id: string): string {
  return path.join(localGatewayDataDir(), 'gateway.db');
}

export function gatewayTemplatesCacheDir(_id: string): string {
  return path.join(localGatewayDataDir(), 'cache', 'templates');
}

export function gatewayVaultDir(_id: string): string {
  return path.join(localGatewayDataDir(), 'vault');
}

/** Code store for an explicitly addressed local vault. */
export function vaultCodeStoreDir(vaultId: string): string {
  return path.join(localGatewayDataDir(), 'vault', vaultId, 'code');
}

export function gatewayModelCatalogFile(_id: string): string {
  return path.join(localGatewayDataDir(), 'cache', 'model-catalog.json');
}
