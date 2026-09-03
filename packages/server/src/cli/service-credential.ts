import { promises as fs } from "node:fs";

import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

export type ServiceKeyCredential =
  | { kind: "systemd"; path: string; encoded: string; keysDir: string }
  | {
      kind: "keychain";
      service: string;
      account: string;
      encoded: string;
      keysDir: string;
    };

export async function adoptKeyStoreCredential(
  fail: (message: string, code?: number) => never,
  credential: ServiceKeyCredential
): Promise<void> {
  const wrappingKey = Buffer.from(credential.encoded, "base64");
  if (wrappingKey.length !== 32) {
    fail(
      "KeyStore wrapping credential must be one base64-encoded 32-byte key",
      2
    );
  }
  const protectedStore = new KeyStore(credential.keysDir, {
    protector: aesGcmKeyProtector(wrappingKey),
  });
  const entries = await fs
    .readdir(credential.keysDir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes(".tmp")) continue;
    protectedStore.export(entry.name);
  }
}
