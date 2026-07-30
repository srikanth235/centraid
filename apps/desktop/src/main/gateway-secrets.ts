/*
 * Device credential custody (issue #555).
 *
 * A desktop connection has one secret: this device's own iroh key. The
 * non-secret connection row lives in connections.json; all connection keys
 * are encoded inside one safeStorage ciphertext owned by Electron main. No
 * credential is ever written into the gateway data directory.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { safeStorage } from "electron";

import type { EndpointSecretPersistence } from "@centraid/tunnel";
import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

import { connectionSecretsFile } from "./gateway-paths.js";

interface DeviceSecrets {
  version: 1;
  irohKeys: Record<string, string>;
  loopbackTokens: Record<string, string>;
  gatewayWrappingKeys: Record<string, string>;
}

const FILE_FALLBACK_MAGIC = "CENTRAID-DEVICE-SECRETS-V1\n";
let warnedFileFallback = false;

function emptySecrets(): DeviceSecrets {
  return {
    version: 1,
    irohKeys: {},
    loopbackTokens: {},
    gatewayWrappingKeys: {},
  };
}

function shouldUseFileFallback(): boolean {
  if (safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") {
    throw new Error(
      "OS keychain is unavailable; unlock the platform keychain before pairing."
    );
  }
  if (!warnedFileFallback) {
    warnedFileFallback = true;
    console.warn(
      "OS keychain/libsecret is unavailable; device credentials are falling back to the 0600 device-local secrets file."
    );
  }
  return true;
}

function parseSecrets(raw: string, file: string): DeviceSecrets {
  const parsed = JSON.parse(raw) as Partial<DeviceSecrets>;
  if (
    parsed.version !== 1 ||
    !parsed.irohKeys ||
    typeof parsed.irohKeys !== "object"
  ) {
    throw new Error(
      `Device credential store at ${file} has an unsupported format.`
    );
  }
  return {
    version: 1,
    irohKeys: { ...parsed.irohKeys },
    loopbackTokens:
      parsed.loopbackTokens && typeof parsed.loopbackTokens === "object"
        ? { ...parsed.loopbackTokens }
        : {},
    gatewayWrappingKeys:
      parsed.gatewayWrappingKeys &&
      typeof parsed.gatewayWrappingKeys === "object"
        ? { ...parsed.gatewayWrappingKeys }
        : {},
  };
}

function readSecrets(): DeviceSecrets {
  const file = connectionSecretsFile();
  let ciphertext: Buffer;
  try {
    ciphertext = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptySecrets();
    throw error;
  }
  fs.chmodSync(file, 0o600);
  const text = ciphertext.toString("utf8");
  if (text.startsWith(FILE_FALLBACK_MAGIC)) {
    const secrets = parseSecrets(text.slice(FILE_FALLBACK_MAGIC.length), file);
    // Adopt the Linux fallback into OS custody as soon as libsecret becomes
    // available again; no operator migration step and no plaintext residue.
    if (safeStorage.isEncryptionAvailable()) writeSecrets(secrets);
    else shouldUseFileFallback();
    return secrets;
  }
  if (shouldUseFileFallback()) {
    throw new Error(
      `Device credential store at ${file} is encrypted but libsecret is unavailable; start the keyring service before pairing.`
    );
  }
  return parseSecrets(safeStorage.decryptString(ciphertext), file);
}

function writeSecrets(secrets: DeviceSecrets): void {
  const file = connectionSecretsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ciphertext = shouldUseFileFallback()
    ? Buffer.from(`${FILE_FALLBACK_MAGIC}${JSON.stringify(secrets)}\n`, "utf8")
    : safeStorage.encryptString(JSON.stringify(secrets));
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, ciphertext, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`failed to remove temporary device secrets file ${temp}`);
      }
    }
    throw error;
  }
}

/** safeStorage-backed persistence adapter for the shared endpoint loader. */
export function deviceIrohKeyPersistence(
  connectionId: string
): EndpointSecretPersistence {
  return {
    load: () => {
      const encoded = readSecrets().irohKeys[connectionId];
      return encoded === undefined
        ? null
        : Uint8Array.from(Buffer.from(encoded, "base64"));
    },
    store: (secret) => {
      const current = readSecrets();
      current.irohKeys[connectionId] = Buffer.from(secret).toString("base64");
      writeSecrets(current);
    },
  };
}

export function clearGatewayCredentials(connectionId: string): void {
  const current = readSecrets();
  if (!(connectionId in current.irohKeys)) return;
  delete current.irohKeys[connectionId];
  writeSecrets(current);
}

/** Device-local custody for a detached daemon's ephemeral loopback bearer. */
export function readLocalLoopbackToken(
  connectionId: string
): string | undefined {
  return readSecrets().loopbackTokens[connectionId];
}

export function storeLocalLoopbackToken(
  connectionId: string,
  token: string
): void {
  const current = readSecrets();
  current.loopbackTokens[connectionId] = token;
  writeSecrets(current);
}

/** Device-custodied wrapping key for a local gateway's KeyStore envelopes. */
export function getOrCreateGatewayWrappingKey(connectionId: string): Buffer {
  const current = readSecrets();
  const encoded = current.gatewayWrappingKeys[connectionId];
  if (encoded !== undefined) return Buffer.from(encoded, "base64");
  const key = randomBytes(32);
  current.gatewayWrappingKeys[connectionId] = key.toString("base64");
  writeSecrets(current);
  return key;
}

/**
 * Embedded-gateway custody backed by this desktop installation's OS keychain.
 * The wrapping key is device-local, so copying only the gateway data directory
 * to another machine cannot open its KeyStore envelopes.
 */
export function desktopGatewayKeyStore(
  dataDir: string,
  connectionId: string
): KeyStore {
  return new KeyStore(path.join(dataDir, "keys"), {
    protector: aesGcmKeyProtector(getOrCreateGatewayWrappingKey(connectionId)),
    warn: (message) => console.warn(message),
  });
}
