import path from "node:path";
import { pathToFileURL } from "node:url";

import { onTestFinished } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";
import type { OpenVaultOptions, VaultDb } from "@centraid/vault";

const helpersDir = import.meta.dirname;

function workspaceSrc(packageName: string, entry = "index.ts"): string {
  return pathToFileURL(
    path.join(helpersDir, "..", "..", "packages", packageName, "src", entry)
  ).href;
}

export interface CreateTestVaultOptions extends OpenVaultOptions {
  inMemory?: boolean;
  bootstrap?: boolean;
  ownerName?: string;
}

export async function createTestVault(
  options: CreateTestVaultOptions = {}
): Promise<VaultDb> {
  const { bootstrapVault, openVaultDb } = await import(workspaceSrc("vault"));
  const {
    inMemory = false,
    bootstrap = true,
    ownerName = "Test owner",
    ...vaultOptions
  } = options;
  const dir = inMemory
    ? undefined
    : (vaultOptions.dir ?? (await tempDir("centraid-vault-test-")));
  if (!bootstrap) {
    const bare = openVaultDb({ ...vaultOptions, ...(dir ? { dir } : {}) });
    onTestFinished(() => {
      bare.close();
    });
    return bare;
  }
  return bootstrappedVault<VaultDb, unknown>(
    {
      openVaultDb: (open) => openVaultDb({ ...vaultOptions, ...open }),
      bootstrapVault,
    },
    { ...(dir ? { dir } : {}), ownerName }
  ).db;
}
