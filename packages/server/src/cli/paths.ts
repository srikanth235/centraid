import path from "node:path";

import type { GatewayPaths } from "../paths.js";

export interface DaemonLayout extends GatewayPaths {
  dataDir: string;
  gatewayDbFile: string;
  keysDir: string;
  cacheDir: string;
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
    vaultDir: path.join(abs, "vault"),
    logsDir: path.join(abs, "gateway-logs"),
    endpointKeyFile: path.join(abs, "keys", "endpoint-key.bin"),
  };
}
