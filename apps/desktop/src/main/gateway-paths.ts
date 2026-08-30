/* Device state under Electron userData (#555). */

import path from "node:path";

import { app } from "electron";

// SUBPATH, never the barrel (#883 C5): ~900 modules of cold boot.
import { platformDefaultDataDir } from "@centraid/server/data-dir";

export const LOCAL_GATEWAY_ID = "local";

export function connectionsFile(): string {
  return path.join(app.getPath("userData"), "connections.json");
}

export function connectionSecretsFile(): string {
  return path.join(app.getPath("userData"), "connection-secrets.bin");
}

export function localGatewayDataDir(): string {
  // Production launches never set this.
  return process.env.CENTRAID_DATA_DIR?.trim() || platformDefaultDataDir();
}

export function gatewayTemplatesCacheDir(_id: string): string {
  return path.join(localGatewayDataDir(), "cache", "templates");
}

export function gatewayVaultDir(_id: string): string {
  return path.join(localGatewayDataDir(), "vault");
}

export function vaultCodeStoreDir(vaultId: string): string {
  return path.join(localGatewayDataDir(), "vault", vaultId, "code");
}

export function gatewayModelCatalogFile(_id: string): string {
  return path.join(localGatewayDataDir(), "cache", "model-catalog.json");
}
