import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { createKeyring } from "./crypto.js";
import { createSnapshot } from "./engine.js";
import type { SourceEntry } from "./engine.js";
import { openLocalBackupProvider } from "./local-provider.js";
import { materializeSnapshotBlobs } from "./materialize.js";

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

async function buildSource(
  sourceDir: string,
  blobs: Buffer[]
): Promise<SourceEntry[]> {
  const dbEntry = async (name: string, gen: string): Promise<SourceEntry> => {
    const p = path.join(sourceDir, name);
    const db = new DatabaseSync(p);
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE t (b BLOB)");
    db.prepare("INSERT INTO t (b) VALUES (?)").run(randomBytes(2048));
    db.close();
    return {
      path: name,
      kind: "db",
      absolutePath: p,
      sha256: sha256(await fs.readFile(p)),
      walGeneration: gen,
      baseTickMs: 1_752_480_000_000,
    };
  };
  const entries: SourceEntry[] = [await dbEntry("vault.db", "11".repeat(16))];
  const blobEntries = await Promise.all(
    blobs.map(async (bytes) => {
      const sha = sha256(bytes);
      const rel = `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
      const abs = path.join(sourceDir, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
      return { path: rel, kind: "blob" as const, absolutePath: abs };
    })
  );
  entries.push(...blobEntries);
  return entries;
}

describe("materialize", () => {
  test("materializes exactly the requested carried shas, byte-exact, and reports the rest absent", async () => {
    const provider = openLocalBackupProvider({
      rootDir: await tempDir("mz-provider"),
    });
    const { targetId } = await provider.createTarget({ label: "mz" });
    const keyring = await createKeyring(
      path.join(await tempDir("mz-keyring"), "keyring.json")
    );

    const wantBytes = randomBytes(9000);
    const otherBytes = randomBytes(4000); // in the snapshot, but NOT requested
    const wantSha = sha256(wantBytes);
    const otherSha = sha256(otherBytes);
    const absentSha = "f".repeat(64); // never in the snapshot

    const sourceDir = await tempDir("mz-source");
    const entries = await buildSource(sourceDir, [wantBytes, otherBytes]);
    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: { vaultUserVersion: "1", ontologyVersion: "1.0" },
    });
    expect(row?.seq).toBe(1);

    const destDir = await tempDir("mz-dest");
    const result = await materializeSnapshotBlobs({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      seq: row!.seq,
      shas: [wantSha, absentSha],
      destDir,
    });

    expect(result.materialized).toStrictEqual([wantSha]);
    expect(result.absent).toStrictEqual([absentSha]);

    const landed = await fs.readFile(
      path.join(destDir, "blobs", "sha256", wantSha.slice(0, 2), wantSha)
    );
    expect(landed.equals(wantBytes)).toBe(true);
    await expect(
      fs
        .readdir(path.join(destDir, "blobs", "sha256", otherSha.slice(0, 2)))
        .catch(() => [])
    ).resolves.not.toContain(otherSha);
    await expect(
      fs.access(
        path.join(destDir, "blobs", "sha256", absentSha.slice(0, 2), absentSha)
      )
    ).rejects.toThrow(/ENOENT/u);
  });
});
