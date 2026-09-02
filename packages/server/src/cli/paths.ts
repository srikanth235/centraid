/*
 * Canonical daemon layout (#555); desktop and headless hosts derive the same
 * tree. gateway.db is control state + process lock, keys/ custody, vault/
 * sovereign state, cache/ disposable, gateway-logs/ diagnostics.
 *
 * Callers name `gatewayDbFile` directly — no loose-JSON layout aliases
 * (`devicesFile`/`pairingTicketsFile`/`webSessionsFile`) (#555, #568).
 */

import path from "node:path";

import type { GatewayPaths } from "../paths.js";

export interface DaemonLayout extends GatewayPaths {
  dataDir: string;
  gatewayDbFile: string;
  keysDir: string;
  cacheDir: string;
  /** KeyStore envelope for the gateway's persistent iroh identity. */
  endpointKeyFile: string;
}

export function daemonLayoutFor(dataDir: string): DaemonLayout {
  const abs = path.resolve(dataDir);
  const cacheDir = path.join(abs, "cache");
  return {
    dataDir: abs,
    gatewayDbFile: path.join(abs, "gateway.db"),
    keysDir: path.join(abs, "keys"),
    cacheDir,
    modelCatalogFile: path.join(cacheDir, "model-catalog.json"),
    modelPricingFile: path.join(cacheDir, "model-pricing.json"),
    templatesCacheDir: path.join(cacheDir, "templates"),
    // Mounting the vault registry (duaility §12): the daemon hosts one gateway
    // holding N sovereign vaults, one subdirectory each, each vault's whole app world.
    vaultDir: path.join(abs, "vault"),
    logsDir: path.join(abs, "gateway-logs"),
    endpointKeyFile: path.join(abs, "keys", "endpoint-key.bin"),
  };
}
