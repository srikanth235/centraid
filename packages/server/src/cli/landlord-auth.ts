import { createHmac } from "node:crypto";

import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";

const LANDLORD_BEARER_CONTEXT = "centraid/landlord-http/v1";

export function landlordBearerForEndpointSecret(secret: Uint8Array): string {
  return createHmac("sha256", Buffer.from(secret))
    .update(LANDLORD_BEARER_CONTEXT, "utf8")
    .digest("hex");
}

export function landlordBearerForDataDir(
  dataDir: string,
  options: { masterKey?: Buffer } = {}
): string | undefined {
  const keysDir = daemonLayoutFor(dataDir).keysDir;
  try {
    const store = options.masterKey
      ? new KeyStore(keysDir, {
          protector: aesGcmKeyProtector(options.masterKey),
        })
      : daemonKeyStore(keysDir);
    const secret = store.load("endpoint-key.bin");
    return secret ? landlordBearerForEndpointSecret(secret) : undefined;
  } catch {
    return undefined;
  }
}
