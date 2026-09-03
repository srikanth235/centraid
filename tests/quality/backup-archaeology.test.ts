import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  LocalBackupProvider,
  READABLE_SNAPSHOT_FORMATS,
  SNAPSHOT_FORMAT_V2,
  createKeyring,
  createSnapshot,
  restoreSnapshot,
} from "@centraid/backup";
import type { SourceEntry } from "@centraid/backup";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  verifyRestoredPair,
} from "@centraid/vault";

import manifest from "../../scripts/corpora/backup-format-census.json";
import {
  EXPECTED_CENSUS,
  buildCorpusVault,
  censusVault,
} from "./backup-corpus-fixture.js";

const FIXED_BASE_TICK_MS = 1_752_480_000_000;
const FIXED_WAL_GENERATION = "ab".repeat(16);
const VAULT_ID = "corpus-archaeology-vault";

const APP_META: Record<string, string> = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: String(VAULT_MIGRATIONS.length),
  ontologyVersion: ONTOLOGY_VERSION,
  sourceInstanceId: "corpus-archaeology",
};

const CURRENT = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: String(VAULT_MIGRATIONS.length),
  ontologyVersion: ONTOLOGY_VERSION,
};

async function fileSha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function sealCorpusVault(): Promise<{
  provider: LocalBackupProvider;
  targetId: string;
  keyring: Awaited<ReturnType<typeof createKeyring>>;
  format: string;
}> {
  const sourceDir = await tempDir("archaeology-source-");
  const paths = buildCorpusVault(sourceDir);

  const storeDir = await tempDir("archaeology-store-");
  const provider = new LocalBackupProvider({ rootDir: storeDir });
  const { targetId } = await provider.createTarget({ label: "archaeology" });
  const keyringDir = await tempDir("archaeology-keyring-");
  const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));

  const entries: SourceEntry[] = [
    {
      path: "vault.db",
      kind: "db",
      absolutePath: paths.vaultFile,
      sha256: await fileSha256(paths.vaultFile),
      walGeneration: FIXED_WAL_GENERATION,
      baseTickMs: FIXED_BASE_TICK_MS,
    },
  ];

  const row = await createSnapshot({
    provider,
    targetId,
    keyring,
    vaultId: VAULT_ID,
    entries,
    generation: 1,
    appMeta: APP_META,
  });
  if (!row) throw new Error("createSnapshot: expected a registered snapshot");
  return { provider, targetId, keyring, format: row.format };
}

describe("backup-format archaeology corpus", () => {
  test("growth-guard: every currently-readable format is a covered corpus member", () => {
    for (const format of READABLE_SNAPSHOT_FORMATS) {
      expect(manifest.formats).toContain(format);
    }
    expect(manifest.formats).toContain(SNAPSHOT_FORMAT_V2);
    expect(manifest.expectedCensus).toStrictEqual(EXPECTED_CENSUS);
  });

  test("a sealed member restores with today's code to the committed census", async () => {
    const { provider, targetId, keyring, format } = await sealCorpusVault();
    expect(format).toBe(SNAPSHOT_FORMAT_V2);
    expect(manifest.formats).toContain(format);

    const destDir = await tempDir("archaeology-restore-");
    await rm(destDir, { recursive: true, force: true });
    const result = await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: VAULT_ID,
      destDir,
      current: CURRENT,
    });
    expect(result.walReplay?.integrityCheck).toBe("ok");

    const report = verifyRestoredPair(destDir);
    expect(report.vault.integrity).toBe("ok");
    expect(report.vault.foreignKeyViolations).toBe(0);
    expect(report.danglingReceipts).toStrictEqual([]);

    expect(censusVault(destDir)).toStrictEqual(manifest.expectedCensus);
  });

  test("the sealed source vault is deterministic (byte-identical across builds)", async () => {
    const a = await tempDir("archaeology-det-a-");
    const b = await tempDir("archaeology-det-b-");
    const [ba, bb] = await Promise.all([
      readFile(buildCorpusVault(a).vaultFile),
      readFile(buildCorpusVault(b).vaultFile),
    ]);
    expect(ba.equals(bb)).toBe(true);
  });
});
